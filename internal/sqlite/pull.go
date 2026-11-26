package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const heldPullJob = `SELECT EXISTS (SELECT 1 FROM aaa_worker_slots WHERE worker_id=?1)`

const duePullExperiments = `SELECT id FROM aaa_experiments
	WHERE state NOT IN ('completed','cancelled','interrupted') AND deadline_at<=?1 ORDER BY deadline_at,id LIMIT 32`

const duePullPins = `SELECT id FROM aaa_inference_jobs
	WHERE state='queued' AND pin_check_at IS NOT NULL AND pin_check_at<=?1 ORDER BY pin_check_at,id LIMIT 32`

type observationStamp struct {
	Scheduled int64 `json:"scheduled"`
	Observed  int64 `json:"observed"`
}

type pollObservations struct {
	Update     observationStamp `json:"update,omitzero"`
	Capability observationStamp `json:"capability,omitzero"`
}

type storedPullResult struct {
	inference.PullResult
	Observations pollObservations `json:"_observations,omitzero"`
}

func readPollObservations(data []byte) (pollObservations, error) {
	var saved struct {
		Observations pollObservations `json:"_observations"`
	}
	if data != nil {
		if err := decodeInference(data, &saved); err != nil {
			return pollObservations{}, err
		}
	}
	return saved.Observations, nil
}

func (stamp observationStamp) recoverUpdate(state *worker.UpdateStatus) {
	if stamp != (observationStamp{}) {
		state.Observe(state.Contact, time.UnixMicro(stamp.Scheduled).UTC(), time.UnixMicro(stamp.Observed).UTC())
	}
}

func loadPullCandidate(ctx context.Context, tx *sql.Tx, candidate pullCandidate, state *inference.State) error {
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

func nativeWorker(ctx context.Context, tx *sql.Tx, credential [32]byte) (id string, err error) {
	var revoked *int64
	err = tx.QueryRowContext(ctx, "SELECT id,revoked_at FROM aaa_workers WHERE credential_hash=?1", credential[:]).Scan(&id, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return "", inference.Reject("invalid_worker_credential", 401)
	}
	if err == nil && revoked != nil {
		err = inference.Reject("worker_revoked", 401)
	}
	return
}

func (r *Repository) RecordBusyPresence(ctx context.Context, credential [32]byte, jobID string, input inference.BusyCheck, contact worker.Contact, record func(*inference.Job, time.Time) (inference.PresenceReceipt, error)) (receipt inference.PresenceReceipt, workerID, operationID string, err error) {
	err = r.write(ctx, func(tx *sql.Tx) error {
		var err error
		workerID, err = nativeWorker(ctx, tx, credential)
		if err != nil {
			return err
		}
		var raw []byte
		err = tx.QueryRowContext(ctx, "SELECT data FROM aaa_inference_jobs WHERE id=?1 AND worker_id=?2 AND held", jobID, workerID).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return inference.Reject("stale_assignment", 409)
		}
		if err != nil {
			return err
		}
		var job inference.Job
		if err = decodeInference(raw, &job); err != nil {
			return err
		}
		operationID = job.ExperimentID
		if pair, hook := inference.PairedHook(ctx); hook {
			work, err := readNativeWork(ctx, tx, &job)
			if err != nil {
				return err
			}
			if err = inference.RequireHookPair(work, pair); err != nil {
				return err
			}
		}
		receipt, err = record(&job, r.databaseTime())
		if err != nil || !receipt.Recorded {
			return err
		}
		receipt.UsageResult, err = recordWeeklyUsage(ctx, tx, workerID, input.WeeklyUsage, input.ScheduledAt, receipt.ReceivedAt)
		if err != nil {
			return err
		}
		raw, err = json.Marshal(&job)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE aaa_inference_jobs SET data=?2 WHERE id=?1", jobID, raw); err != nil {
			return err
		}
		if contact.Version == "" {
			return nil
		}
		state, err := readWorkerUpdate(ctx, tx, workerID)
		if err != nil {
			return err
		}
		state.Observe(contact, input.ScheduledAt, receipt.ReceivedAt)
		return saveWorkerUpdate(ctx, tx, workerID, state)
	})
	return
}

func (r *Repository) WithinPull(ctx context.Context, credential [32]byte, input inference.Pull, hash string, capability int, contact worker.Contact, broker worker.UpdateBroker, claim func(*inference.State) (*inference.Grant, error)) (result inference.PullResult, workerID string, replayed bool, timing inference.PullTiming, err error) {
	started, acquired := time.Now(), false
	err = r.write(ctx, func(tx *sql.Tx) error {
		timing.Acquire, acquired = time.Since(started), true
		now := r.databaseTime()
		var err error
		workerID, err = nativeWorker(ctx, tx, credential)
		if err != nil {
			return err
		}
		if input.ObserveLegacy {
			timing.Update, err = observeLegacyWorker(ctx, tx, now, workerID, input, contact)
			return err
		}
		pair, pairedHook := inference.PairedHook(ctx)
		var sequence, scheduled int64
		var priorHash string
		var saved []byte
		var previousPin, previousPinReason string
		err = tx.QueryRowContext(ctx, "SELECT sequence,scheduled_at,input_hash,result,previous_pin,previous_pin_reason FROM aaa_worker_polls WHERE worker_id=?1", workerID).
			Scan(&sequence, &scheduled, &priorHash, &saved, &previousPin, &previousPinReason)
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
			if input.VerifyHookStart {
				if result.Job != nil {
					job := &inference.Job{WorkerID: workerID, LeaseID: result.Job.ClaimID}
					work, err := readNativeWork(ctx, tx, job)
					if err != nil {
						return err
					}
					if !pairedHook {
						return inference.Reject("update_required", 426, "claim_id", job.LeaseID)
					}
					if err = inference.RequireHookPair(work, pair); err != nil {
						return err
					}
				}
				for lane, grant := range map[string]*worker.ControlGrant{worker.WorkerOp: result.WorkerOp, worker.AgentTask: result.AgentTask} {
					if grant == nil {
						continue
					}
					record, err := scopedControl(ctx, tx, lane, grant.ID, workerID, false)
					if err != nil {
						return err
					}
					if err := checkControlPair(ctx, record); err != nil {
						return err
					}
				}
				if result.Update != nil && (broker.Target == nil || result.Update.Target != *broker.Target) {
					result.Update = nil
				}
			}
			replayed = true
			timing.PreviousPin = previousPin
			timing.PreviousPinReason = previousPinReason
			timing.UsageResult = "poll_replayed"
		case input.ScheduledAt.UnixMicro() <= scheduled:
			return inference.Reject("obsolete_occurrence", 409)
		default:
			observations, err := readPollObservations(saved)
			if err != nil {
				return err
			}
			timing.UsageResult, err = recordWeeklyUsage(ctx, tx, workerID, input.WeeklyUsage, input.ScheduledAt, now)
			if err != nil {
				return err
			}
			var held bool
			if err = tx.QueryRowContext(ctx, heldPullJob, workerID).Scan(&held); err != nil {
				return err
			}
			var work bool
			result.Update, work, err = decideControlUpdate(ctx, tx, now, workerID, input, contact, broker, held, &timing)
			if err != nil {
				return err
			}
			if broker.ForceRecord && broker.ID != "" && !timing.UpdateBrokerRecorded {
				if err := recordUpdateBroker(ctx, tx, now, broker); err != nil {
					return err
				}
				timing.UpdateBrokerRecorded = true
			}
			if timing.Update.ObservedAt != nil {
				observations.Update = observationStamp{timing.Update.ScheduledAt.UnixMicro(), timing.Update.ObservedAt.UnixMicro()}
			}
			if pairedHook && !contact.Incompatible {
				timing.Capability, timing.CapabilityChanged, err = recordWorkerCapability(ctx, tx, workerID, input.AgentTasks, input.ScheduledAt, now, true)
				if err != nil {
					return err
				}
				if timing.Capability != nil {
					observations.Capability = observationStamp{input.ScheduledAt.UnixMicro(), now.UnixMicro()}
				}
				if work && result.Update == nil {
					result.WorkerOp, err = grantControl(ctx, tx, worker.WorkerOp, workerID, input, pair, now)
					if err != nil {
						return err
					}
					if result.WorkerOp == nil && input.AgentTasks {
						result.AgentTask, err = grantControl(ctx, tx, worker.AgentTask, workerID, input, pair, now)
						if err != nil {
							return err
						}
					}
					work = result.WorkerOp == nil && result.AgentTask == nil
				}
			}
			var availableCapability *int
			major, _, _ := strings.Cut(contact.Version, ".")
			timing.UsageDecision = "worker_unavailable"
			if work {
				availableCapability = &capability
				lookupStarted := time.Now()
				timing.EffectiveUsage, err = readWeeklyUsage(ctx, tx, workerID)
				if err != nil {
					return err
				}
				candidate, transferFrom, err := pickPullJob(ctx, tx, workerID, major, capability, now, &timing, pair)
				timing.Select = time.Since(lookupStarted)
				if err != nil {
					return err
				}
				if candidate.job != "" {
					state := &inference.State{Now: now, WorkerID: workerID, Jobs: map[string]*inference.Job{},
						Experiments: map[string]*inference.Experiment{}, QuotaTransferFrom: transferFrom}
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
					if inference.VerifiedClaim(result.Job.ClaimID) || inference.HookClaim(result.Job.ClaimID) {
						if err = recordNativeGrant(ctx, tx, workerID, result.Job.ClaimID, input); err != nil {
							return err
						}
					}
					timing.PreviousPin = state.Jobs[candidate.job].ReroutedFrom
					timing.PreviousPinReason = inference.OfflinePinReason
					if transferFrom != "" {
						timing.PreviousPinReason = inference.ExhaustedPinReason
					}
					if err = saveInference(ctx, tx, inference.Ref{}, state, before); err != nil {
						return err
					}
					if err = saveHistory(ctx, tx, state, history); err != nil {
						return err
					}
				}
			}
			encoded, err := json.Marshal(storedPullResult{result, observations})
			if err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO aaa_worker_polls(worker_id,sequence,scheduled_at,last_poll_at,input_hash,result,previous_pin,previous_pin_reason,available_capability,available_major)
				VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(worker_id) DO UPDATE SET sequence=excluded.sequence,scheduled_at=excluded.scheduled_at,
				last_poll_at=excluded.last_poll_at,input_hash=excluded.input_hash,result=excluded.result,previous_pin=excluded.previous_pin,
				previous_pin_reason=excluded.previous_pin_reason,available_capability=excluded.available_capability,available_major=excluded.available_major`, workerID, input.Sequence,
				input.ScheduledAt.UnixMicro(), now.UnixMicro(), hash, encoded, timing.PreviousPin, timing.PreviousPinReason, availableCapability, major); err != nil {
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
