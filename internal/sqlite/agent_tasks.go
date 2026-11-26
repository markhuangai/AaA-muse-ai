package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func workerCapability(ctx context.Context, tx *sql.Tx, workerID string) (*worker.Capability, error) {
	var cap worker.Capability
	var observed int64
	err := tx.QueryRowContext(ctx, "SELECT agent_tasks,prompt_contract,observed_at FROM aaa_worker_capabilities WHERE worker_id=?1", workerID).
		Scan(&cap.AgentTasks, &cap.PromptContract, &observed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	cap.ObservedAt = time.UnixMicro(observed).UTC()
	return &cap, nil
}

func recordWorkerCapability(ctx context.Context, tx *sql.Tx, workerID string, supportsTasks bool, scheduled, now time.Time, skipUnchanged bool) (*worker.Capability, bool, error) {
	prior, err := workerCapability(ctx, tx, workerID)
	if err != nil {
		return nil, false, err
	}
	cap := worker.Capability{AgentTasks: supportsTasks, ObservedAt: now}
	if supportsTasks {
		cap.PromptContract = worker.HookPromptContract
	}
	if skipUnchanged && prior != nil && prior.AgentTasks == cap.AgentTasks && prior.PromptContract == cap.PromptContract {
		return prior, false, nil
	}
	change, err := tx.ExecContext(ctx, `INSERT INTO aaa_worker_capabilities(worker_id,agent_tasks,prompt_contract,observed_at,scheduled_at)
		VALUES(?1,?2,?3,?4,?5) ON CONFLICT(worker_id) DO UPDATE SET agent_tasks=excluded.agent_tasks,
		prompt_contract=excluded.prompt_contract,observed_at=excluded.observed_at,scheduled_at=excluded.scheduled_at
		WHERE excluded.scheduled_at > aaa_worker_capabilities.scheduled_at`, workerID, supportsTasks, cap.PromptContract, now.UnixMicro(), scheduled.UnixMicro())
	if err != nil {
		return nil, false, err
	}
	count, err := change.RowsAffected()
	if err != nil || count == 0 {
		return nil, false, err
	}
	return &cap, prior == nil || prior.AgentTasks != supportsTasks, nil
}

func controlProjection(ctx context.Context, tx *sql.Tx, workerID string) (p worker.ControlProjection, cap *worker.Capability, err error) {
	cap, err = workerCapability(ctx, tx, workerID)
	if err != nil {
		return
	}
	if cap != nil {
		p.PromptContract = cap.PromptContract
		p.CapabilitiesObservedAt = &cap.ObservedAt
	}
	var id string
	err = tx.QueryRowContext(ctx, "SELECT lane,item_id FROM aaa_worker_slots WHERE worker_id=?1", workerID).Scan(&p.ActiveSlotLane, &id)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
		return
	}
	if err != nil || p.ActiveSlotLane == "inference" {
		return
	}
	var record worker.ControlRecord
	record, err = readControl(ctx, tx, p.ActiveSlotLane, id, false)
	if err == nil {
		item := record.Summary()
		if p.ActiveSlotLane == worker.WorkerOp {
			p.CurrentWorkerOp = &item
		} else {
			p.CurrentAgentTask = &item
		}
	}
	return
}

func grantControl(ctx context.Context, tx *sql.Tx, lane, workerID string, input inference.Pull, pair inference.HookPair, now time.Time) (*worker.ControlGrant, error) {
	table, err := controlTable(lane)
	if err != nil {
		return nil, err
	}
	filter := ""
	if lane == worker.WorkerOp {
		filter = " AND kind<>'retry_update'"
	}
	var id string
	err = tx.QueryRowContext(ctx, "SELECT id FROM "+table+" WHERE worker_id=?1 AND state='queued' AND deadline_at>?2"+filter+" ORDER BY created_at,id LIMIT 1",
		workerID, now.UnixMicro()).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record, err := readControl(ctx, tx, lane, id, true)
	if err != nil {
		return nil, err
	}
	grant := &worker.ControlGrant{ID: id, OperationID: id, ClaimID: lane + "-" + id, Generation: 1,
		ClaimedAt: now, DeadlineAt: record.DeadlineAt, Kind: record.Kind, Params: record.Params}
	record.Claim, record.ClaimedAt, record.Held, record.State = grant, &now, true, "claimed"
	record.Pair = worker.Contact{Version: pair.Version, Digest: pair.Digest, Contract: worker.UpdateContract}
	record.Checker, record.PullOccurrence = input.Checker, input.Occurrence
	return grant, saveControl(ctx, tx, lane, record)
}

func (r *Repository) RecordAgentTaskPresence(ctx context.Context, credential [32]byte, id string, input inference.BusyCheck,
	contact worker.Contact, supportsTasks bool,
) (receipt inference.PresenceReceipt, workerID string, cap *worker.Capability, capChanged bool, err error) {
	err = r.write(ctx, func(tx *sql.Tx) error {
		var err error
		workerID, err = nativeWorker(ctx, tx, credential)
		if err != nil {
			return err
		}
		record, err := scopedControl(ctx, tx, worker.AgentTask, id, workerID, true)
		if err != nil {
			return err
		}
		if err = checkControlPair(ctx, record); err != nil {
			return err
		}
		if !record.ClaimMatches(input.ClaimID, input.Generation) || input.Checker != record.Checker {
			return inference.Reject("stale_assignment", 409)
		}
		if input.Occurrence == record.PresenceRun || !input.ScheduledAt.After(record.PresenceSchedule) {
			receipt.ReceivedAt = record.PresenceAt
			return nil
		}
		now := r.databaseTime()
		record.PresenceRun, record.PresenceSchedule, record.PresenceAt = input.Occurrence, input.ScheduledAt, now
		receipt = inference.PresenceReceipt{Recorded: true, ReceivedAt: now}
		receipt.UsageResult, err = recordWeeklyUsage(ctx, tx, workerID, input.WeeklyUsage, input.ScheduledAt, now)
		if err != nil {
			return err
		}
		cap, capChanged, err = recordWorkerCapability(ctx, tx, workerID, supportsTasks, input.ScheduledAt, now, false)
		if err != nil {
			return err
		}
		update, err := readWorkerUpdate(ctx, tx, workerID)
		if err != nil {
			return err
		}
		update.Observe(contact, input.ScheduledAt, now)
		if err := saveWorkerUpdate(ctx, tx, workerID, update); err != nil {
			return err
		}
		if err := saveControl(ctx, tx, worker.AgentTask, record); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE aaa_workers SET last_contact_at=?2 WHERE id=?1", workerID, now.UnixMicro())
		return err
	})
	return
}

type controlKeys struct {
	lane string
	ids  []string
}

func controlWork(ctx context.Context, tx *sql.Tx, owner string, now time.Time) ([]controlKeys, error) {
	var work []controlKeys
	for _, lane := range []string{worker.WorkerOp, worker.AgentTask} {
		table, err := controlTable(lane)
		if err != nil {
			return nil, err
		}
		query := "SELECT id FROM " + table + " WHERE state IN ('queued','claimed','running') "
		args := []any{owner}
		if owner != "" {
			query += "AND worker_id=?1 ORDER BY created_at,id"
		} else {
			query += "AND (deadline_at<=?1 OR worker_id IN (SELECT id FROM aaa_workers WHERE revoked_at IS NOT NULL)) ORDER BY deadline_at,id LIMIT 32"
			args[0] = now.UnixMicro()
		}
		ids, err := queryIDs(ctx, tx, query, args...)
		if err != nil {
			return nil, err
		}
		work = append(work, controlKeys{lane, ids})
	}
	return work, nil
}

func queryIDs(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]string, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func interruptControlWork(ctx context.Context, tx *sql.Tx, owner string, now time.Time) (items []worker.ControlItem, err error) {
	work, err := controlWork(ctx, tx, owner, now)
	if err != nil {
		return nil, err
	}
	for _, lane := range work {
		for _, id := range lane.ids {
			record, err := readControl(ctx, tx, lane.lane, id, true)
			if err != nil {
				return nil, err
			}
			reason := "worker_revoked"
			if owner == "" {
				var revoked bool
				if err := tx.QueryRowContext(ctx, "SELECT revoked_at IS NOT NULL FROM aaa_workers WHERE id=?1", record.WorkerID).Scan(&revoked); err != nil {
					return nil, err
				}
				if !revoked {
					reason = "deadline_exceeded"
				}
			}
			record.Interrupt("interrupted", reason, now)
			record.ReasonMessage = inference.ExplainInterruption(record.State, reason, &inference.InterruptionEvidence{Stage: record.Interruption["stage"]})
			if err := saveControl(ctx, tx, lane.lane, record); err != nil {
				return nil, err
			}
			items = append(items, record.Summary())
		}
	}
	return items, nil
}

const workerControlDue = `SELECT
		EXISTS(SELECT 1 FROM aaa_worker_ops WHERE state IN ('queued','claimed','running') AND deadline_at<=?1)
		OR EXISTS(SELECT 1 FROM aaa_agent_tasks WHERE state IN ('queued','claimed','running') AND deadline_at<=?1)
		OR EXISTS(SELECT 1 FROM aaa_worker_ops item JOIN aaa_workers w ON w.id=item.worker_id
			WHERE item.state IN ('queued','claimed','running') AND w.revoked_at IS NOT NULL)
		OR EXISTS(SELECT 1 FROM aaa_agent_tasks item JOIN aaa_workers w ON w.id=item.worker_id
			WHERE item.state IN ('queued','claimed','running') AND w.revoked_at IS NOT NULL)`

func (r *Repository) SweepWorkerControl(ctx context.Context) (items []worker.ControlItem, err error) {
	var pending bool
	err = r.read(ctx, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, workerControlDue, r.databaseTime().UnixMicro()).Scan(&pending)
	})
	if err != nil || !pending {
		return nil, err
	}
	err = r.write(ctx, func(tx *sql.Tx) error {
		items, err = interruptControlWork(ctx, tx, "", r.databaseTime())
		return err
	})
	return
}

func retryUpdateOp(ctx context.Context, tx *sql.Tx, workerID, state, updateID string, now time.Time) (*worker.ControlRecord, error) {
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM aaa_worker_ops WHERE worker_id=?1 AND kind='retry_update' AND state=?2
		AND update_id=?3 AND deadline_at>?4`, workerID, state, updateID, now.UnixMicro()).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record, err := readControl(ctx, tx, worker.WorkerOp, id, true)
	return &record, err
}

func finishRetryUpdate(ctx context.Context, tx *sql.Tx, op *worker.ControlRecord, state, reason string, payload json.RawMessage, now time.Time) error {
	op.State, op.Reason, op.FinishedAt, op.RemoteOutcome = state, reason, &now, state
	op.Result = payload
	op.ResultBytes = len(payload)
	if len(payload) > 0 {
		var err error
		op.ResultSHA256, err = inference.Hash(payload)
		if err != nil {
			return err
		}
	}
	return saveControl(ctx, tx, worker.WorkerOp, *op)
}

func (r *Repository) WorkerHookPromptEligibility(ctx context.Context, owner string) error {
	return r.read(ctx, func(tx *sql.Tx) error {
		if err := controlOwner(ctx, tx, owner, true); err != nil {
			return err
		}
		contact, err := readWorkerUpdate(ctx, tx, owner)
		if err == nil && contact.Contract != "" && contact.Contract != worker.UpdateContract {
			err = inference.Reject("unsupported_worker_migration", 409)
		}
		return err
	})
}
