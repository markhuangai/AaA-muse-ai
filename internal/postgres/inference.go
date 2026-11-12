package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

const inferenceAdmissionLock int64 = 0x414141494e46

func decodeInference(data []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	return d.Decode(out)
}

func (r *Repository) InferenceWorkers(ctx context.Context) (ids []string, err error) {
	err = r.workerTransaction(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT DISTINCT worker_id FROM (
			SELECT worker_id FROM aaa_worker_connections WHERE (data->>'connected')::boolean
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

func resolveInference(ctx context.Context, tx pgx.Tx, ref *inference.Ref) error {
	wid, exp := ref.WorkerID, ref.ExperimentID
	var err error
	if ref.JobID != "" {
		var data []byte
		err = tx.QueryRow(ctx, "SELECT worker_id, experiment_id, data FROM aaa_inference_jobs WHERE id=$1", ref.JobID).Scan(&wid, &exp, &data)
		if err == nil {
			var job inference.Job
			if err = decodeInference(data, &job); err != nil {
				return err
			}
			ref.Correlation = map[string]any{"operation_id": exp, "experiment_id": exp, "conversation_id": job.ConversationID, "job_id": ref.JobID, "worker_id": wid, "generation": job.Generation, "connection_id": job.ConnectionID, "connection_generation": job.ConnectionGeneration, "expected_state": job.State, "lease_expires_at": job.LeaseExpiresAt, "deadline_at": job.DeadlineAt}
		}
	} else if exp != "" {
		err = tx.QueryRow(ctx, "SELECT worker_id FROM aaa_experiments WHERE id=$1", exp).Scan(&wid)
	}
	if errors.Is(err, pgx.ErrNoRows) {
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
	return r.workerTransaction(ctx, func(tx pgx.Tx) error {
		if ref.Admission {
			if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", inferenceAdmissionLock); err != nil {
				return err
			}
		}
		if ref.SubmissionID != "" {
			if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ref.Principal+":"+ref.SubmissionID); err != nil {
				return err
			}
		}
		if err := ownedHistory(ctx, tx, &ref); err != nil {
			return err
		}
		if err := resolveInference(ctx, tx, &ref); err != nil {
			return err
		}
		s := &inference.State{WorkerID: ref.WorkerID, Experiments: map[string]*inference.Experiment{}, Jobs: map[string]*inference.Job{}}
		var revoked *time.Time
		err := tx.QueryRow(ctx, "SELECT revoked_at FROM aaa_workers WHERE id=$1 FOR UPDATE", ref.WorkerID).Scan(&revoked)
		if errors.Is(err, pgx.ErrNoRows) {
			return inference.Reject("worker_not_found", 404)
		}
		if err != nil {
			return err
		}
		s.Revoked = revoked != nil
		if s.Revoked && ref.WorkerAuth != "" {
			return inference.Reject("worker_revoked", 401, "correlation", ref.Correlation, "expected_worker_id", ref.WorkerID, "observed_worker_id", ref.WorkerAuth)
		}
		if err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&s.Now); err != nil {
			return err
		}
		var data []byte
		err = tx.QueryRow(ctx, "SELECT data FROM aaa_worker_connections WHERE worker_id=$1", ref.WorkerID).Scan(&data)
		if err == nil {
			if err = decodeInference(data, &s.Connection); err != nil {
				return err
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
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
		if ref.Admission {
			if err = tx.QueryRow(ctx, "SELECT count(*) FROM aaa_experiments WHERE state NOT IN ('completed','cancelled','interrupted')").Scan(&s.ActiveCount); err != nil {
				return err
			}
		}
		if ref.SubmissionID != "" {
			err = tx.QueryRow(ctx, "SELECT data FROM aaa_inference_receipts WHERE principal=$1 AND submission_id=$2", ref.Principal, ref.SubmissionID).Scan(&data)
			if err == nil {
				s.Receipt = &inference.Receipt{}
				if err = decodeInference(data, s.Receipt); err != nil {
					return err
				}
			} else if !errors.Is(err, pgx.ErrNoRows) {
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
		if err = saveInference(ctx, tx, ref, s, before); err != nil {
			return err
		}
		return saveHistory(ctx, tx, s, history)
	})
}

func loadInference(ctx context.Context, tx pgx.Tx, ref inference.Ref, s *inference.State) error {
	rows, err := tx.Query(ctx, `SELECT data FROM aaa_experiments WHERE (worker_id=$1 OR (worker_id IS NULL AND $1='')) AND
		(state NOT IN ('completed','cancelled','interrupted') OR id=$2 OR id IN
		(SELECT experiment_id FROM aaa_inference_jobs WHERE id=$3 OR held) OR id=ANY($4::text[])) ORDER BY id`, s.WorkerID, ref.ExperimentID, ref.BaseJobID, ref.EvidenceIDs)
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
			rows, err = tx.Query(ctx, "SELECT data FROM aaa_inference_history WHERE experiment_id=$1 ORDER BY sequence", id)
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
	rows, err = tx.Query(ctx, `SELECT data, CASE WHEN $4 THEN context ELSE NULL END FROM aaa_inference_jobs
		WHERE worker_id=$1 AND (state IN ('queued','claimed') OR held OR id=$2 OR id=$3 OR
		id=(SELECT data->>'current_job_id' FROM aaa_experiments WHERE id=$5) OR experiment_id=ANY($6::text[])) ORDER BY id`, s.WorkerID, ref.JobID, ref.BaseJobID, ref.Full, ref.ExperimentID, ref.EvidenceIDs)
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

func saveInference(ctx context.Context, tx pgx.Tx, ref inference.Ref, s *inference.State, b inferenceBefore) error {
	data, err := json.Marshal(s.Connection)
	if err != nil {
		return err
	}
	if s.Pool == nil && !bytes.Equal(data, b.connection) {
		if _, err = tx.Exec(ctx, "INSERT INTO aaa_worker_connections(worker_id,data) VALUES($1,$2) ON CONFLICT(worker_id) DO UPDATE SET data=EXCLUDED.data", s.WorkerID, data); err != nil {
			return err
		}
	}
	for id, e := range s.Experiments {
		data, err = experimentHeader(e)
		if err != nil {
			return err
		}
		if !bytes.Equal(data, b.experiments[id]) {
			if _, err = tx.Exec(ctx, `INSERT INTO aaa_experiments(id,worker_id,state,deadline_at,data) VALUES($1,$2,$3,$4,$5)
				ON CONFLICT(id) DO UPDATE SET worker_id=EXCLUDED.worker_id,state=EXCLUDED.state,data=EXCLUDED.data`, id, nullableWorker(e.WorkerID), e.State, e.DeadlineAt, data); err != nil {
				return err
			}
		}
		if s.Requests[id] == nil && (ref.Full || b.experiments[id] == nil) {
			for i := b.history[id]; i < len(e.Messages); i++ {
				data, err = json.Marshal(e.Messages[i])
				if err != nil {
					return err
				}
				if _, err = tx.Exec(ctx, "INSERT INTO aaa_inference_history(experiment_id,sequence,data) VALUES($1,$2,$3)", id, i, data); err != nil {
					return err
				}
			}
		}
	}
	// Existing fences must reach PostgreSQL before replacements hit immediate unique indexes.
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
		if _, err = tx.Exec(ctx, `INSERT INTO aaa_inference_jobs(id,worker_id,experiment_id,state,held,data,context) VALUES($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,held=EXCLUDED.held,data=EXCLUDED.data`, id, j.WorkerID, j.ExperimentID, j.State, j.Held, data, delivery); err != nil {
			return err
		}
	}
	if s.Receipt != nil && !b.receipt {
		data, err = json.Marshal(s.Receipt)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, "INSERT INTO aaa_inference_receipts(principal,submission_id,data) VALUES($1,$2,$3)", s.Receipt.Principal, s.Receipt.SubmissionID, data)
	}
	return err
}
