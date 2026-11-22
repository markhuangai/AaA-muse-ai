package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

type pollCandidate struct {
	job, experiment string
	created         int64
}

const nextPullJob = `SELECT job.id, job.experiment_id, job.created_at
 FROM aaa_pull_levels AS level CROSS JOIN aaa_inference_jobs AS job
 WHERE ((level.shift<63 AND ((?3 >> level.shift) & 1)=0) OR (level.shift=63 AND ?3<0))
 AND job.id=(SELECT job_id FROM aaa_pull_queue INDEXED BY aaa_pull_queue_head
   WHERE target=?1 AND capability=?2 AND shift=level.shift AND bucket=(?3 >> level.shift)+1
   ORDER BY created_at,job_id LIMIT 1)
 ORDER BY job.created_at,job.id LIMIT 1`

const heldPullJob = `SELECT EXISTS (SELECT 1 FROM aaa_inference_jobs WHERE worker_id=?1 AND held)`

const duePullExperiments = `SELECT id FROM aaa_experiments
	WHERE state NOT IN ('completed','cancelled','interrupted') AND deadline_at<=?1 ORDER BY deadline_at,id LIMIT 32`

const duePullPins = `SELECT id FROM aaa_inference_jobs
	WHERE state='queued' AND pin_check_at IS NOT NULL AND pin_check_at<=?1 ORDER BY pin_check_at,id LIMIT 32`

func pickPullJob(ctx context.Context, tx *sql.Tx, workerID string, maxCapability int, now time.Time) (pollCandidate, error) {
	for _, target := range []string{workerID, ""} {
		var oldest pollCandidate
		for capability := 0; capability <= maxCapability; capability++ {
			var candidate pollCandidate
			err := tx.QueryRowContext(ctx, nextPullJob, target, capability, now.UnixMicro()).Scan(&candidate.job, &candidate.experiment, &candidate.created)
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			if err != nil {
				return oldest, err
			}
			if oldest.job == "" || candidate.created < oldest.created || (candidate.created == oldest.created && candidate.job < oldest.job) {
				oldest = candidate
			}
		}
		if oldest.job != "" {
			return oldest, nil
		}
	}
	return pollCandidate{}, nil
}

func loadPullCandidate(ctx context.Context, tx *sql.Tx, candidate pollCandidate, state *inference.State) error {
	var raw []byte
	if err := tx.QueryRowContext(ctx, "SELECT data FROM aaa_inference_jobs WHERE id=?1", candidate.job).Scan(&raw); err != nil {
		return err
	}
	var job inference.Job
	if err := decodeInference(raw, &job); err != nil {
		return err
	}
	state.Jobs[job.ID] = &job
	if err := tx.QueryRowContext(ctx, "SELECT data FROM aaa_experiments WHERE id=?1", candidate.experiment).Scan(&raw); err != nil {
		return err
	}
	var experiment inference.Experiment
	if err := decodeInference(raw, &experiment); err != nil {
		return err
	}
	state.Experiments[experiment.ID] = &experiment
	return loadHistory(ctx, tx, inference.Ref{}, state)
}

func (r *Repository) WithinPull(ctx context.Context, credential [32]byte, input inference.Pull, hash string, capability int, claim func(*inference.State) (*inference.Grant, error)) (result inference.PullResult, workerID string, replayed bool, timing inference.PullTiming, err error) {
	started, acquired := time.Now(), false
	err = r.write(ctx, func(tx *sql.Tx) error {
		timing.Acquire, acquired = time.Since(started), true
		now := r.databaseTime()
		var revoked *int64
		err := tx.QueryRowContext(ctx, "SELECT id,revoked_at FROM aaa_workers WHERE credential_hash=?1", credential[:]).Scan(&workerID, &revoked)
		if errors.Is(err, sql.ErrNoRows) {
			return inference.Reject("invalid_worker_credential", 401)
		}
		if err != nil {
			return err
		}
		if revoked != nil {
			return inference.Reject("worker_revoked", 401)
		}
		var sequence, scheduled int64
		var priorHash string
		var saved []byte
		var previousPin string
		err = tx.QueryRowContext(ctx, "SELECT sequence,scheduled_at,input_hash,result,previous_pin FROM aaa_worker_polls WHERE worker_id=?1", workerID).Scan(&sequence, &scheduled, &priorHash, &saved, &previousPin)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		switch {
		case input.Sequence < sequence:
			return inference.Reject("stale_poll_sequence", 409)
		case input.Sequence == sequence:
			if hash != priorHash {
				return inference.Reject("poll_sequence_conflict", 409)
			}
			if err = decodeInference(saved, &result); err != nil {
				return err
			}
			replayed = true
			timing.PreviousPin = previousPin
		case input.ScheduledAt.UnixMicro() <= scheduled:
			return inference.Reject("obsolete_occurrence", 409)
		default:
			var held bool
			if err = tx.QueryRowContext(ctx, heldPullJob, workerID).Scan(&held); err != nil {
				return err
			}
			if !held {
				lookupStarted := time.Now()
				candidate, err := pickPullJob(ctx, tx, workerID, capability, now)
				timing.Select = time.Since(lookupStarted)
				if err != nil {
					return err
				}
				if candidate.job != "" {
					state := &inference.State{Now: now, WorkerID: workerID, Jobs: map[string]*inference.Job{}, Experiments: map[string]*inference.Experiment{}}
					if err = loadPullCandidate(ctx, tx, candidate, state); err != nil {
						return err
					}
					before, err := inferenceSnapshot(state)
					if err != nil {
						return err
					}
					history, err := historySnapshot(state)
					if err != nil {
						return err
					}
					result.Job, err = claim(state)
					if err != nil {
						return err
					}
					timing.PreviousPin = state.Jobs[candidate.job].ReroutedFrom
					if err = saveInference(ctx, tx, inference.Ref{}, state, before); err != nil {
						return err
					}
					if err = saveHistory(ctx, tx, state, history); err != nil {
						return err
					}
				}
			}
			encoded, err := json.Marshal(result)
			if err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO aaa_worker_polls(worker_id,sequence,scheduled_at,last_poll_at,input_hash,result,previous_pin)
				VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(worker_id) DO UPDATE SET sequence=excluded.sequence,scheduled_at=excluded.scheduled_at,
				last_poll_at=excluded.last_poll_at,input_hash=excluded.input_hash,result=excluded.result,previous_pin=excluded.previous_pin`, workerID, input.Sequence, input.ScheduledAt.UnixMicro(), now.UnixMicro(), hash, encoded, timing.PreviousPin); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, "UPDATE aaa_workers SET last_contact_at=?2 WHERE id=?1", workerID, now.UnixMicro())
		return err
	})
	if !acquired {
		timing.Acquire = time.Since(started)
	}
	return
}

func (r *Repository) DueExperiments(ctx context.Context) ([]string, error) {
	return r.dueKeys(ctx, duePullExperiments)
}

func (r *Repository) DuePinChecks(ctx context.Context) ([]string, error) {
	return r.dueKeys(ctx, duePullPins)
}

func (r *Repository) dueKeys(ctx context.Context, query string) (ids []string, err error) {
	err = r.read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, query, r.databaseTime().UnixMicro())
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
