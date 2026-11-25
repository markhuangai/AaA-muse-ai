package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func controlTable(lane string) (string, error) {
	switch lane {
	case worker.WorkerOp:
		return "aaa_worker_ops", nil
	case worker.AgentTask:
		return "aaa_agent_tasks", nil
	default:
		return "", fmt.Errorf("invalid worker control lane %q", lane)
	}
}

func readControl(ctx context.Context, tx *sql.Tx, lane, id string, full bool) (record worker.ControlRecord, err error) {
	table, err := controlTable(lane)
	if err != nil {
		return record, err
	}
	payload := "NULL, NULL"
	if full {
		payload = "NULL, result"
		if lane == worker.AgentTask {
			payload = "prompt, result"
		}
	}
	var raw, prompt, result []byte
	err = tx.QueryRowContext(ctx, "SELECT data, "+payload+" FROM "+table+" WHERE id=?1", id).Scan(&raw, &prompt, &result)
	if err == nil {
		err = decodeInference(raw, &record)
		record.Prompt, record.Result = string(prompt), json.RawMessage(result)
	}
	return record, err
}

func saveControl(ctx context.Context, tx *sql.Tx, lane string, record worker.ControlRecord) error {
	metadata := record
	metadata.ControlItem = record.Summary()
	raw, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	claim, generation := "", int64(0)
	if record.Claim != nil {
		claim, generation = record.Claim.ClaimID, record.Claim.Generation
	}
	args := []any{record.ID, record.WorkerID, record.State, record.Held, claim, generation, record.CreatedAt.UnixMicro(),
		record.DeadlineAt.UnixMicro(), timeMicros(record.ClaimedAt), timeMicros(record.FinishedAt), record.Reason,
		record.RemoteOutcome, record.ResultBytes, record.ResultSHA256, raw, []byte(record.Result)}
	var query string
	switch lane {
	case worker.WorkerOp:
		query = `INSERT INTO aaa_worker_ops(id,worker_id,state,held,claim_id,generation,created_at,deadline_at,claimed_at,finished_at,reason,remote_outcome,result_bytes,result_sha256,data,result,kind,update_id)
			VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
			ON CONFLICT(id) DO UPDATE SET state=excluded.state,held=excluded.held,claim_id=excluded.claim_id,generation=excluded.generation,
			claimed_at=excluded.claimed_at,finished_at=excluded.finished_at,reason=excluded.reason,remote_outcome=excluded.remote_outcome,
			result_bytes=excluded.result_bytes,result_sha256=excluded.result_sha256,data=excluded.data,result=excluded.result,update_id=excluded.update_id`
		args = append(args, record.Kind, record.UpdateID)
	case worker.AgentTask:
		query = `INSERT INTO aaa_agent_tasks(id,worker_id,state,held,claim_id,generation,created_at,deadline_at,claimed_at,finished_at,reason,remote_outcome,result_bytes,result_sha256,data,result,started_at,prompt)
			VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
			ON CONFLICT(id) DO UPDATE SET state=excluded.state,held=excluded.held,claim_id=excluded.claim_id,generation=excluded.generation,
			claimed_at=excluded.claimed_at,finished_at=excluded.finished_at,reason=excluded.reason,remote_outcome=excluded.remote_outcome,
			result_bytes=excluded.result_bytes,result_sha256=excluded.result_sha256,data=excluded.data,result=excluded.result,started_at=excluded.started_at`
		args = append(args, timeMicros(record.StartedAt), []byte(record.Prompt))
	default:
		return errors.New("invalid worker control lane")
	}
	_, err = tx.ExecContext(ctx, query, args...)
	return err
}

func timeMicros(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UnixMicro()
}

func controlOwner(ctx context.Context, tx *sql.Tx, id string, writes bool) error {
	var revoked *int64
	err := tx.QueryRowContext(ctx, "SELECT revoked_at FROM aaa_workers WHERE id=?1", id).Scan(&revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return inference.Reject("worker_not_found", 404)
	}
	if err == nil && writes && revoked != nil {
		return inference.Reject("worker_revoked", 409)
	}
	return err
}

func scopedControl(ctx context.Context, tx *sql.Tx, lane, id, owner string, full bool) (worker.ControlRecord, error) {
	item, err := readControl(ctx, tx, lane, id, full)
	if errors.Is(err, sql.ErrNoRows) {
		return item, inference.Reject(lane+"_not_found", 404)
	}
	if err == nil && item.WorkerID != owner {
		return worker.ControlRecord{}, inference.Reject("worker_scope_denied", 404)
	}
	return item, err
}

func readControlAdmission(ctx context.Context, tx *sql.Tx, lane, owner string, now time.Time) (worker.ControlAdmission, error) {
	admission := worker.ControlAdmission{Now: now}
	observed, err := readWorkerUpdate(ctx, tx, owner)
	if err != nil {
		return admission, err
	}
	if observed.Contract != "" && observed.Contract != worker.UpdateContract {
		return admission, inference.Reject("unsupported_worker_migration", 409)
	}
	admission.Contact = observed
	if lane == worker.AgentTask {
		admission.Capability, err = workerCapability(ctx, tx, owner)
		if err != nil {
			return admission, err
		}
	}
	table, err := controlTable(lane)
	if err != nil {
		return admission, err
	}
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM "+table+" WHERE worker_id=?1 AND state='queued'", owner).Scan(&admission.Queued); err != nil {
		return admission, err
	}
	if lane == worker.WorkerOp {
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM aaa_worker_ops
			WHERE worker_id=?1 AND kind='retry_update' AND state IN ('queued','running'))`, owner).Scan(&admission.RetryPending)
	}
	return admission, err
}

func checkControlPair(ctx context.Context, record worker.ControlRecord) error {
	pair, paired := inference.PairedHook(ctx)
	if !paired {
		return inference.Reject("update_required", 426)
	}
	return inference.RequireHookPair(&inference.NativeWorkReceipt{Mode: "hook",
		Pair: inference.HookPair{Version: record.Pair.Version, Digest: record.Pair.Digest}}, pair)
}

func (r *Repository) WithinWorkerControl(ctx context.Context, ref worker.ControlRef,
	change func(*worker.ControlRecord, worker.ControlAdmission) (json.RawMessage, error),
) (result json.RawMessage, record worker.ControlRecord, workerID string, replayed bool, err error) {
	err = r.write(ctx, func(tx *sql.Tx) error {
		now := r.databaseTime()
		workerID = ref.WorkerID
		principal := "admin-" + ref.Lane
		if ref.Credential != nil {
			var err error
			workerID, err = nativeWorker(ctx, tx, *ref.Credential)
			if err != nil {
				return err
			}
			principal = ref.Lane
		} else if err := controlOwner(ctx, tx, workerID, ref.ItemID == ""); err != nil {
			return err
		}
		principal = stringsForPrincipal(principal) + ":" + workerID
		if ref.ItemID != "" {
			var err error
			record, err = scopedControl(ctx, tx, ref.Lane, ref.ItemID, workerID, true)
			if err != nil {
				return err
			}
			if ref.Credential != nil {
				if err := checkControlPair(ctx, record); err != nil {
					return err
				}
			}
		}
		if ref.SubmissionID != "" {
			var raw []byte
			err := tx.QueryRowContext(ctx, "SELECT data FROM aaa_inference_receipts WHERE principal=?1 AND submission_id=?2", principal, ref.SubmissionID).Scan(&raw)
			if err == nil {
				var receipt inference.Receipt
				if err := decodeInference(raw, &receipt); err != nil {
					return err
				}
				if receipt.InputHash != ref.InputHash {
					return inference.Reject("submission_conflict", 409)
				}
				result, replayed = receipt.Result, true
				return nil
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
		}
		admission := worker.ControlAdmission{Now: now}
		if ref.ItemID == "" {
			var err error
			admission, err = readControlAdmission(ctx, tx, ref.Lane, workerID, now)
			if err != nil {
				return err
			}
		}
		var err error
		result, err = change(&record, admission)
		if err != nil {
			return err
		}
		if err = saveControl(ctx, tx, ref.Lane, record); err != nil {
			return err
		}
		if ref.Credential != nil {
			if _, err := tx.ExecContext(ctx, "UPDATE aaa_workers SET last_contact_at=?2 WHERE id=?1", workerID, now.UnixMicro()); err != nil {
				return err
			}
		}
		if ref.SubmissionID != "" {
			raw, err := json.Marshal(inference.Receipt{Principal: principal, SubmissionID: ref.SubmissionID, InputHash: ref.InputHash, Result: result})
			if err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, "INSERT INTO aaa_inference_receipts(principal,submission_id,data) VALUES(?1,?2,?3)", principal, ref.SubmissionID, raw)
			return err
		}
		return nil
	})
	return
}

func stringsForPrincipal(value string) string {
	// Lane identifiers and receipt principal names have distinct wire spellings.
	if value == "admin-"+worker.WorkerOp {
		return "admin-worker-op"
	}
	if value == "admin-"+worker.AgentTask {
		return "admin-agent-task"
	}
	if value == worker.WorkerOp {
		return "worker-op"
	}
	return "worker-agent-task"
}

func (r *Repository) WorkerControlDetail(ctx context.Context, lane, workerID, id string) (item worker.ControlItem, err error) {
	err = r.read(ctx, func(tx *sql.Tx) error {
		record, err := scopedControl(ctx, tx, lane, id, workerID, true)
		item = record.ControlItem
		return err
	})
	return
}

func (r *Repository) ListWorkerControl(ctx context.Context, lane, workerID, kind, beforeID string, before time.Time, limit int) (items []worker.ControlItem, err error) {
	items = []worker.ControlItem{}
	table, err := controlTable(lane)
	if err != nil {
		return nil, err
	}
	err = r.read(ctx, func(tx *sql.Tx) error {
		if err := controlOwner(ctx, tx, workerID, false); err != nil {
			return err
		}
		kindFilter := ""
		args := []any{workerID, beforeID, before.UnixMicro(), limit}
		if kind != "" {
			kindFilter = "AND kind=?5 "
			args = append(args, kind)
		}
		rows, err := tx.QueryContext(ctx, "SELECT data FROM "+table+" WHERE worker_id=?1 AND (?2='' OR (created_at,id)<(?3,?2)) "+kindFilter+
			"ORDER BY created_at DESC,id DESC LIMIT ?4", args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var raw []byte
			var record worker.ControlRecord
			if err := rows.Scan(&raw); err != nil {
				return err
			}
			if err := decodeInference(raw, &record); err != nil {
				return err
			}
			items = append(items, record.Summary())
		}
		return rows.Err()
	})
	return
}
