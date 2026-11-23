package sqlite

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"database/sql"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/media"
)

const recoveryRequests = `SELECT m.id FROM aaa_model_requests m
 JOIN aaa_conversations c ON c.id=m.conversation_id
 WHERE (c.pending_call_id<>'' AND m.id=c.current_request_id) OR m.incomplete_delivery`

func idList(ids []string) string {
	value, _ := json.Marshal(ids)
	return string(value)
}

func decodeInference(data []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	return d.Decode(out)
}

func (r *Repository) InferenceWorkers(ctx context.Context) (ids []string, err error) {
	err = r.read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT DISTINCT worker_id FROM (
			SELECT worker_id FROM aaa_worker_connections WHERE connected
			UNION SELECT worker_id FROM aaa_experiments WHERE state NOT IN ('completed','cancelled','interrupted')
			UNION SELECT worker_id FROM aaa_inference_jobs WHERE held) AS active WHERE worker_id IS NOT NULL ORDER BY worker_id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
		}
		return rows.Err()
	})
	return
}

func resolveInference(ctx context.Context, tx *sql.Tx, ref *inference.Ref) error {
	wid, exp := ref.WorkerID, ref.ExperimentID
	var err error
	if ref.JobID != "" {
		var data []byte
		err = tx.QueryRowContext(ctx, "SELECT COALESCE(worker_id,''), experiment_id, data FROM aaa_inference_jobs WHERE id=?1", ref.JobID).Scan(&wid, &exp, &data)
		if err == nil {
			var job inference.Job
			if err = decodeInference(data, &job); err != nil {
				return err
			}
			ref.Correlation = map[string]any{"operation_id": exp, "experiment_id": exp, "conversation_id": job.ConversationID, "job_id": ref.JobID, "worker_id": wid, "generation": job.Generation, "connection_id": job.ConnectionID, "connection_generation": job.ConnectionGeneration, "expected_state": job.State, "lease_expires_at": job.LeaseExpiresAt, "deadline_at": job.DeadlineAt}
		}
	} else if exp != "" {
		err = tx.QueryRowContext(ctx, "SELECT COALESCE(worker_id, '') FROM aaa_experiments WHERE id=?1", exp).Scan(&wid)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return inference.Reject("inference_not_found", 404)
	}
	if err != nil {
		return err
	}
	if ref.WorkerAuth != "" && ref.WorkerAuth != wid {
		return inference.Reject("worker_scope_denied", 404, "correlation", ref.Correlation, "expected_worker_id", wid, "observed_worker_id", ref.WorkerAuth)
	}
	ref.WorkerID, ref.ExperimentID = wid, exp
	return nil
}

func (r *Repository) WithinInference(ctx context.Context, ref inference.Ref, apply func(*inference.State) error) error {
	if ref.Routing {
		return r.withinRouting(ctx, ref, apply)
	}
	return r.write(ctx, func(tx *sql.Tx) error {
		if err := ownedHistory(ctx, tx, &ref); err != nil {
			return err
		}
		if err := resolveInference(ctx, tx, &ref); err != nil {
			return err
		}
		s := &inference.State{WorkerID: ref.WorkerID, Experiments: map[string]*inference.Experiment{}, Jobs: map[string]*inference.Job{}}
		var err error
		if ref.WorkerID != "" || ref.ExperimentID == "" {
			var revoked, lastContact *int64
			err = tx.QueryRowContext(ctx, "SELECT revoked_at,last_contact_at FROM aaa_workers WHERE id=?1", ref.WorkerID).Scan(&revoked, &lastContact)
			if errors.Is(err, sql.ErrNoRows) {
				return inference.Reject("worker_not_found", 404)
			}
			if err != nil {
				return err
			}
			s.Revoked, s.LastContactAt = revoked != nil, instant(lastContact)
		}
		if s.Revoked && ref.WorkerAuth != "" {
			return inference.Reject("worker_revoked", 401, "correlation", ref.Correlation, "expected_worker_id", ref.WorkerID, "observed_worker_id", ref.WorkerAuth)
		}
		s.DatabaseTime = func() (time.Time, error) { return r.databaseTime(), nil }
		s.Now = r.databaseTime()
		var data []byte
		err = tx.QueryRowContext(ctx, "SELECT data FROM aaa_worker_connections WHERE worker_id=?1", ref.WorkerID).Scan(&data)
		if err == nil {
			if err = decodeInference(data, &s.Connection); err != nil {
				return err
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if ref.PollProjection {
			var polled *int64
			err = tx.QueryRowContext(ctx, "SELECT last_poll_at FROM aaa_worker_polls WHERE worker_id=?1", ref.WorkerID).Scan(&polled)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			s.LastPollAt = instant(polled)
			update, err := readWorkerUpdate(ctx, tx, s.WorkerID)
			if err != nil {
				return err
			}
			if update.ObservedAt != nil || update.State != "" {
				s.WorkerUpdate = &update
			}
			if ref.Principal == "management" {
				s.WeeklyUsage, err = readWeeklyUsage(ctx, tx, s.WorkerID)
				if err != nil {
					return err
				}
			}
		}
		if err = loadInference(ctx, tx, ref, s); err != nil {
			return err
		}
		if err = loadRouting(ctx, tx, s); err != nil {
			return err
		}
		if err = loadHistory(ctx, tx, ref, s); err != nil {
			return err
		}
		if ref.SubmissionID != "" {
			err = tx.QueryRowContext(ctx, "SELECT data FROM aaa_inference_receipts WHERE principal=?1 AND submission_id=?2", ref.Principal, ref.SubmissionID).Scan(&data)
			if err == nil {
				s.Receipt = &inference.Receipt{}
				if err = decodeInference(data, s.Receipt); err != nil {
					return err
				}
			} else if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
		}
		before, err := inferenceSnapshot(s)
		if err != nil {
			return err
		}
		history, err := historySnapshot(s)
		if err != nil {
			return err
		}
		if err = apply(s); err != nil {
			return err
		}
		if ref.UpdateRouting {
			data, err = json.Marshal(s.Routing)
			if err != nil {
				return err
			}
			if err = saveRouting(ctx, tx, s.WorkerID, data); err != nil {
				return err
			}
		}
		if err = saveInference(ctx, tx, ref, s, before); err != nil {
			return err
		}
		return saveHistory(ctx, tx, s, history)
	})
}

func loadInference(ctx context.Context, tx *sql.Tx, ref inference.Ref, s *inference.State) error {
	var rows *sql.Rows
	var err error
	if ref.Single {
		rows, err = tx.QueryContext(ctx, "SELECT data FROM aaa_experiments WHERE id=?1", ref.ExperimentID)
	} else {
		rows, err = tx.QueryContext(ctx, `SELECT data FROM aaa_experiments WHERE (worker_id=?1 OR (worker_id IS NULL AND ?1='')) AND
		(state NOT IN ('completed','cancelled','interrupted') OR id=?2 OR id IN
		(SELECT experiment_id FROM aaa_inference_jobs WHERE id=?3 OR held)
		OR (?4 AND id IN (`+recoveryRequests+`))) ORDER BY id`, s.WorkerID, ref.ExperimentID, ref.BaseJobID, ref.Recovery)
	}
	if err != nil {
		return err
	}
	for rows.Next() {
		var data []byte
		if err = rows.Scan(&data); err != nil {
			rows.Close()
			return err
		}
		e := &inference.Experiment{}
		if err = decodeInference(data, e); err != nil {
			rows.Close()
			return err
		}
		s.Experiments[e.ID] = e
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if ref.Full {
		for id, e := range s.Experiments {
			rows, err = tx.QueryContext(ctx, "SELECT data FROM aaa_inference_history WHERE experiment_id=?1 ORDER BY sequence", id)
			if err != nil {
				return err
			}
			for rows.Next() {
				var data []byte
				if err = rows.Scan(&data); err != nil {
					rows.Close()
					return err
				}
				var m inference.Item
				if err = decodeInference(data, &m); err != nil {
					rows.Close()
					return err
				}
				e.Messages = append(e.Messages, m)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
		}
	}
	ids := make([]string, 0, len(s.Experiments))
	if ref.Recovery {
		for id := range s.Experiments {
			ids = append(ids, id)
		}
	}
	if ref.Single {
		rows, err = tx.QueryContext(ctx, `SELECT data, CASE WHEN ?2 THEN context ELSE NULL END FROM aaa_inference_jobs
			WHERE id=COALESCE(NULLIF(?3,''),(SELECT current_job_id FROM aaa_experiments WHERE id=?1))`, ref.ExperimentID, ref.Full, ref.JobID)
	} else {
		rows, err = tx.QueryContext(ctx, `SELECT data, CASE WHEN ?4 THEN context ELSE NULL END FROM aaa_inference_jobs
		WHERE worker_id IS NULLIF(?1,'') AND (state IN ('queued','claimed') OR held OR id=?2 OR id=?3 OR
		id=(SELECT current_job_id FROM aaa_experiments WHERE id=?5)
		OR experiment_id IN (SELECT value FROM json_each(?6))) ORDER BY id`, s.WorkerID, ref.JobID, ref.BaseJobID, ref.Full, ref.ExperimentID, idList(ids))
	}
	if err != nil {
		return err
	}
	for rows.Next() {
		var data, delivery []byte
		if err = rows.Scan(&data, &delivery); err != nil {
			rows.Close()
			return err
		}
		j := &inference.Job{}
		if err = decodeInference(data, j); err != nil {
			rows.Close()
			return err
		}
		if delivery != nil {
			if err = decodeInference(delivery, &j.Context); err != nil {
				rows.Close()
				return err
			}
		}
		s.Jobs[j.ID] = j
	}
	err = rows.Err()
	rows.Close()
	return err
}

type inferenceBefore struct {
	connection        []byte
	experiments, jobs map[string][]byte
	history           map[string]int
	receipt           bool
}

func experimentHeader(e *inference.Experiment) ([]byte, error) {
	header := *e
	header.Messages = nil
	return json.Marshal(header)
}
func jobHeader(j *inference.Job) ([]byte, error) {
	header := *j
	header.Context.Messages = nil
	header.Context.Tools = nil
	return json.Marshal(header)
}

func inferenceSnapshot(s *inference.State) (b inferenceBefore, err error) {
	b = inferenceBefore{experiments: map[string][]byte{}, jobs: map[string][]byte{}, history: map[string]int{}, receipt: s.Receipt != nil}
	b.connection, err = json.Marshal(s.Connection)
	if err != nil {
		return
	}
	for id, e := range s.Experiments {
		b.experiments[id], err = experimentHeader(e)
		if err != nil {
			return
		}
		b.history[id] = len(e.Messages)
	}
	for id, j := range s.Jobs {
		b.jobs[id], err = jobHeader(j)
		if err != nil {
			return
		}
	}
	return
}

func saveInference(ctx context.Context, tx *sql.Tx, ref inference.Ref, s *inference.State, b inferenceBefore) error {
	data, err := json.Marshal(s.Connection)
	if err != nil {
		return err
	}
	if s.Pool == nil && !bytes.Equal(data, b.connection) {
		if _, err = tx.ExecContext(ctx, "INSERT INTO aaa_worker_connections(worker_id,connected,data) VALUES(?1,?2,?3) ON CONFLICT(worker_id) DO UPDATE SET connected=excluded.connected,data=excluded.data", s.WorkerID, s.Connection.Connected, data); err != nil {
			return err
		}
	}
	for id, e := range s.Experiments {
		data, err = experimentHeader(e)
		if err != nil {
			return err
		}
		if !bytes.Equal(data, b.experiments[id]) {
			if _, err = tx.ExecContext(ctx, `INSERT INTO aaa_experiments(id,worker_id,state,deadline_at,created_at,conversation_id,current_job_id,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
				ON CONFLICT(id) DO UPDATE SET worker_id=excluded.worker_id,state=excluded.state,current_job_id=excluded.current_job_id,data=excluded.data`,
				id, nullableWorker(e.WorkerID), e.State, e.DeadlineAt.UnixMicro(), e.CreatedAt.UnixMicro(), e.ConversationID, e.CurrentJobID, data); err != nil {
				return err
			}
		}
		if s.Requests[id] == nil && (ref.Full || b.experiments[id] == nil) {
			for i := b.history[id]; i < len(e.Messages); i++ {
				data, err = json.Marshal(e.Messages[i])
				if err != nil {
					return err
				}
				if _, err = tx.ExecContext(ctx, "INSERT INTO aaa_inference_history(experiment_id,sequence,data) VALUES(?1,?2,?3)", id, i, data); err != nil {
					return err
				}
			}
		}
	}
	// Existing fences must be saved before replacements hit immediate unique indexes.
	jobIDs := make([]string, 0, len(s.Jobs))
	for id := range s.Jobs {
		jobIDs = append(jobIDs, id)
	}
	sort.Slice(jobIDs, func(i, j int) bool {
		existingI, existingJ := b.jobs[jobIDs[i]] != nil, b.jobs[jobIDs[j]] != nil
		if existingI != existingJ {
			return existingI
		}
		return jobIDs[i] < jobIDs[j]
	})
	for _, id := range jobIDs {
		j := s.Jobs[id]
		data, err = jobHeader(j)
		if err != nil {
			return err
		}
		if bytes.Equal(data, b.jobs[id]) {
			continue
		}
		delivery, err := json.Marshal(j.Context)
		if err != nil {
			return err
		}
		var expires any
		if j.Media != nil && j.Media.ExpiresAt != nil {
			expires = j.Media.ExpiresAt.UnixMicro()
		}
		capability := 0
		if j.Media != nil {
			capability = 1
			if j.Media.Profile == media.PromptWAVProfile {
				capability = 2
			}
		}
		var pinCheck any
		if j.PinCheckAt != nil {
			pinCheck = j.PinCheckAt.UnixMicro()
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO aaa_inference_jobs(id,worker_id,experiment_id,state,held,created_at,has_media,media_expires_at,data,context,deadline_at,capability,pin_check_at)
			VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
			ON CONFLICT(id) DO UPDATE SET worker_id=excluded.worker_id,state=excluded.state,held=excluded.held,has_media=excluded.has_media,media_expires_at=excluded.media_expires_at,data=excluded.data,pin_check_at=excluded.pin_check_at`,
			id, nullableWorker(j.WorkerID), j.ExperimentID, j.State, j.Held, j.CreatedAt.UnixMicro(), j.Media != nil, expires, data, delivery, j.DeadlineAt.UnixMicro(), capability, pinCheck); err != nil {
			return err
		}
	}
	if s.Receipt != nil && !b.receipt {
		data, err = json.Marshal(s.Receipt)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO aaa_inference_receipts(principal,submission_id,data) VALUES(?1,?2,?3)", s.Receipt.Principal, s.Receipt.SubmissionID, data)
	}
	return err
}
