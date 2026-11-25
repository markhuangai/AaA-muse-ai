package service

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/sqlite"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

type workerControlRepository interface {
	WithinWorkerControl(context.Context, worker.ControlRef, func(*worker.ControlRecord, worker.ControlAdmission) (json.RawMessage, error)) (json.RawMessage, worker.ControlRecord, string, bool, error)
	WorkerControlDetail(context.Context, string, string, string) (worker.ControlItem, error)
	ListWorkerControl(context.Context, string, string, string, string, time.Time, int) ([]worker.ControlItem, error)
}

type controlChange func(*worker.ControlRecord, worker.ControlAdmission) (any, error)

func (b *Broker) changeWorkerControl(ctx context.Context, logger *slog.Logger, ref worker.ControlRef, event string, input any,
	change controlChange,
) (json.RawMessage, string, error) {
	repo, ok := b.repo.(workerControlRepository)
	if !ok {
		return nil, "", errors.New("worker_control_repository_unavailable")
	}
	started := b.now()
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var err error
	ref.InputHash, err = inference.Hash([]any{event, ref.ItemID, input})
	if err != nil {
		return nil, "", err
	}
	result, record, owner, replayed, err := repo.WithinWorkerControl(bounded, ref, func(record *worker.ControlRecord, admission worker.ControlAdmission) (json.RawMessage, error) {
		output, err := change(record, admission)
		if err != nil {
			return nil, err
		}
		return json.Marshal(output)
	})
	operationID := ref.ItemID
	if record.ID != "" {
		operationID = record.ID
	}
	if replayed && operationID == "" {
		var saved worker.ControlItem
		if json.Unmarshal(result, &saved) == nil {
			operationID = saved.ID
		}
	}
	if operationID != "" {
		logger = logger.With("operation_id", operationID)
	}
	logger = logger.With("worker_id", owner, "item_id", operationID,
		"submission_id", ref.SubmissionID, "stage", event, "duration_ms", b.now().Sub(started).Milliseconds(), "attempt", 1)
	if err != nil {
		var rejected *inference.Rejection
		if errors.As(err, &rejected) {
			name := ref.Lane + ".rejected"
			if rejected.Reason == "worker_scope_denied" {
				name = "worker.scope_denied"
			} else if rejected.Code == 401 {
				name = "worker.auth_denied"
			}
			logger.Warn(name, "reason", rejected.Reason, "scoped_item_id", ref.ItemID, "expected_state", "authorized_current_assignment",
				"observed_state", record.State, "details", rejected.Fields)
			rejected.Fields["control_diagnostic_recorded"] = true
		} else {
			failure := sqlite.Classify(err)
			logger.Error(ref.Lane+".failed", "reason", failure.Reason, "phase", failure.Phase, "sqlite_code", failure.Code, "transaction_outcome", failure.Outcome)
		}
		return nil, owner, err
	}
	if replayed {
		logger.Info("receipt.replayed", "replayed", true)
		return result, owner, nil
	}
	attrs := controlLogFields(record.ControlItem)
	logger.Info(ref.Lane+"."+event, append(attrs, "transaction_outcome", "committed", "wake_invocation_id", record.WakeInvocation())...)
	if event == "completed" && record.Reason == "deadline_exceeded" {
		logInterruptedControl(logger, record.ControlItem)
	}
	switch {
	case event == "completed" && record.Kind == worker.DiagnosticsExport:
		var meta worker.DiagnosticsResult
		_ = json.Unmarshal(record.Result, &meta)
		logger.Debug("worker_op.exchange", "input_omitted", true, "result_bytes", record.ResultBytes, "result_sha256", record.ResultSHA256,
			"captures", meta.Captures, "complete", meta.Complete, "truncated", meta.Truncated, "omissions", meta.Omissions, "next_cursor", meta.NextCursor)
	default:
		logger.Debug(ref.Lane+".exchange", "input", input, "result", json.RawMessage(result), "stored_result", record.Result)
	}
	return result, owner, nil
}

func controlLogFields(item worker.ControlItem) []any {
	fields := []any{"worker_id", item.WorkerID, "operation_id", item.ID, "item_id", item.ID,
		"kind", item.Kind, "state", item.State, "reason", item.Reason, "busy_hold", item.Held, "remote_outcome", item.RemoteOutcome,
		"deadline_at", item.DeadlineAt, "result_bytes", item.ResultBytes, "result_sha256", item.ResultSHA256}
	if item.Claim != nil {
		fields = append(fields, "claim_id", item.Claim.ClaimID, "generation", item.Claim.Generation, "claimed_at", item.Claim.ClaimedAt)
	}
	if item.Kind != "" {
		return append(fields, "worker_op_id", item.ID)
	}
	return append(fields, "agent_task_id", item.ID)
}

func timeout(seconds, minimum, maximum, fallback int) (time.Duration, error) {
	if seconds == 0 {
		seconds = fallback
	}
	if seconds < minimum || seconds > maximum {
		return 0, inference.Reject("invalid_timeout", 400)
	}
	return time.Duration(seconds) * time.Second, nil
}

func validDiagnosticsQuery(q *worker.DiagnosticsQuery) bool {
	return q == nil ||
		((q.OperationID == "" || inference.Identifier.MatchString(q.OperationID)) &&
			(q.RequestID == "" || inference.Identifier.MatchString(q.RequestID)) &&
			(q.Since == nil || q.Until == nil || !q.Since.After(*q.Until)) &&
			(q.MaxBytes == nil || (*q.MaxBytes > 0 && *q.MaxBytes <= worker.MaxDiagnosticsResult)) &&
			len(q.Cursor) <= 1024)
}

func (b *Broker) makeControl(workerID string, now time.Time, duration time.Duration) (worker.ControlItem, error) {
	id, err := auth.ID(b.random)
	return worker.ControlItem{ID: id, WorkerID: workerID, State: "queued", CreatedAt: now, DeadlineAt: now.Add(duration),
		RemoteOutcome: "not_started"}, err
}

func (b *Broker) SubmitWorkerOp(ctx context.Context, logger *slog.Logger, build Build, workerID string, input worker.OpRequest) (json.RawMessage, error) {
	if err := inference.VersionAndID(input.Version, input.SubmissionID); err != nil {
		return nil, err
	}
	if !worker.ValidOpKind(input.Kind) || (input.Params != nil && input.Kind != worker.DiagnosticsExport) || !validDiagnosticsQuery(input.Params) {
		return nil, inference.Reject("invalid_worker_op", 400)
	}
	low, high, fallback := 15, 600, 120
	if input.Kind == worker.RetryUpdate {
		low, high, fallback = 60, 900, 300
	}
	duration, err := timeout(input.TimeoutSeconds, low, high, fallback)
	if err != nil {
		return nil, err
	}
	ref := worker.ControlRef{Lane: worker.WorkerOp, WorkerID: workerID, SubmissionID: input.SubmissionID}
	result, _, err := b.changeWorkerControl(ctx, logger, ref, "queued", input, func(record *worker.ControlRecord, state worker.ControlAdmission) (any, error) {
		if input.Kind == worker.RetryUpdate {
			if err := admitUpdateRetry(build, state); err != nil {
				return nil, err
			}
		} else if state.Contact.Version != "" && !build.Paired(state.Contact.Contact) {
			return nil, inference.Reject("worker_update_required", 409, "expected_version", build.Version, "observed_version", state.Contact.Version)
		}
		if state.Queued >= 8 {
			return nil, inference.Reject("worker_op_queue_full", 429, "queue_limit", 8)
		}
		item, err := b.makeControl(workerID, state.Now, duration)
		item.Kind = input.Kind
		record.ControlItem, record.Params = item, input.Params
		return record.Summary(), err
	})
	return result, err
}

func admitUpdateRetry(build Build, state worker.ControlAdmission) error {
	switch {
	case state.RetryPending:
		return inference.Reject("worker_op_already_pending", 409)
	case build.Paired(state.Contact.Contact):
		return inference.Reject("worker_already_paired", 409)
	}
	target := build.UpdateTarget()
	if target == nil {
		return inference.Reject("update_target_unavailable", 409)
	}
	if !target.Advances(state.Contact.Contact) {
		return inference.Reject("update_requires_newer_pair", 409, "expected_version", target.Version, "observed_version", state.Contact.Version)
	}
	return nil
}

func (b *Broker) CancelWorkerControl(ctx context.Context, logger *slog.Logger, lane, owner, id string, input inference.Cancel) (json.RawMessage, error) {
	if err := inference.VersionAndID(input.Version, input.SubmissionID); err != nil {
		return nil, err
	}
	ref := worker.ControlRef{Lane: lane, WorkerID: owner, ItemID: id, SubmissionID: input.SubmissionID}
	result, _, err := b.changeWorkerControl(ctx, logger, ref, "cancelled", input, func(record *worker.ControlRecord, state worker.ControlAdmission) (any, error) {
		if !record.Active() {
			return nil, inference.Reject(lane+"_already_terminal", 409, "observed_state", record.State)
		}
		record.Interrupt("cancelled", "cancelled_by_operator", state.Now)
		return record.Summary(), nil
	})
	return result, err
}

func (b *Broker) ListWorkerControl(ctx context.Context, lane, owner, kind, cursor string, limit int) (worker.ControlPage, error) {
	repo, ok := b.repo.(workerControlRepository)
	if !ok {
		return worker.ControlPage{}, errors.New("worker_control_repository_unavailable")
	}
	q := inference.HistoryQuery{Kind: lane + "-" + kind, ConversationID: owner}
	var before inference.PageCursor
	var err error
	if cursor != "" {
		before, err = inference.DecodeCursor(cursor, q)
		if err != nil {
			return worker.ControlPage{}, err
		}
	}
	items, err := repo.ListWorkerControl(ctx, lane, owner, kind, before.ID, before.Time, limit+1)
	page := worker.ControlPage{Items: items}
	if err == nil && len(items) > limit {
		last := items[limit-1]
		page.Items = items[:limit]
		page.NextCursor, err = inference.EncodeCursor(inference.PageCursor{Kind: q.Kind, ConversationID: owner, ID: last.ID, Time: last.CreatedAt})
	}
	return page, err
}

func (b *Broker) WorkerControlDetail(ctx context.Context, lane, owner, id string) (worker.ControlItem, error) {
	repo, ok := b.repo.(workerControlRepository)
	if !ok {
		return worker.ControlItem{}, errors.New("worker_control_repository_unavailable")
	}
	return repo.WorkerControlDetail(ctx, lane, owner, id)
}

type sanitizeOpResult func(kind string, raw json.RawMessage) (json.RawMessage, error)

func workerControlRef(lane, credential, id, submissionID string) (worker.ControlRef, error) {
	if !auth.ValidToken(credential, auth.WorkerPrefix) {
		return worker.ControlRef{}, inference.Reject("invalid_worker_credential", 401)
	}
	hash := auth.Digest(credential)
	return worker.ControlRef{Lane: lane, ItemID: id, Credential: &hash, SubmissionID: submissionID}, nil
}

func (b *Broker) CompleteWorkerOp(ctx context.Context, logger *slog.Logger, credential, id string, input worker.ControlResult,
	sanitize sanitizeOpResult,
) (json.RawMessage, string, error) {
	if err := inference.VersionAndID(input.Version, input.SubmissionID); err != nil {
		return nil, "", err
	}
	if (input.Outcome != "succeeded" && input.Outcome != "failed") || len(input.Reason) > 100 ||
		(input.Reason != "" && !inference.Identifier.MatchString(input.Reason)) ||
		(input.Outcome == "succeeded" && len(input.Result) == 0) {
		return nil, "", inference.Reject("invalid_worker_op_result", 400)
	}
	ref, err := workerControlRef(worker.WorkerOp, credential, id, input.SubmissionID)
	if err != nil {
		return nil, "", err
	}
	return b.changeWorkerControl(ctx, logger, ref, "completed", input, func(record *worker.ControlRecord, state worker.ControlAdmission) (any, error) {
		if !record.ClaimMatches(input.ClaimID, input.Generation) {
			return nil, inference.Reject("stale_assignment", 409)
		}
		limit := worker.MaxWorkerOpResult
		if record.Kind == worker.DiagnosticsExport {
			limit = worker.MaxDiagnosticsResult
			if record.Params != nil && record.Params.MaxBytes != nil {
				limit = *record.Params.MaxBytes
			}
		}
		if len(input.Result) > limit {
			return nil, inference.Reject("worker_op_result_too_large", 413, "limit_bytes", limit, "observed_bytes", len(input.Result))
		}
		if len(input.Result) != 0 {
			safe, err := sanitize(record.Kind, input.Result)
			if err != nil {
				return nil, err
			}
			if len(safe) > limit {
				return nil, inference.Reject("worker_op_result_too_large", 413, "limit_bytes", limit, "observed_bytes", len(safe))
			}
			record.ResultSHA256, err = inference.Hash(safe)
			if err != nil {
				return nil, err
			}
			record.Result, record.ResultBytes = safe, len(safe)
		}
		if record.Active() {
			if state.Now.Before(record.DeadlineAt) {
				record.State, record.Reason, record.FinishedAt = input.Outcome, input.Reason, &state.Now
			} else {
				record.Interrupt("interrupted", "deadline_exceeded", state.Now)
			}
		}
		record.RemoteOutcome, record.Held = input.Outcome, false
		return record.Summary(), nil
	})
}

func logInterruptedControl(logger *slog.Logger, item worker.ControlItem) {
	lane, severity, event := worker.WorkerOp, slog.LevelError, "deadline_exceeded"
	if item.Kind == "" {
		lane = worker.AgentTask
	}
	if item.Reason != "deadline_exceeded" {
		event = "interrupted"
	}
	fields := controlLogFields(item)
	logger.Log(context.Background(), severity, lane+"."+event, fields...)
	if item.Held {
		logger.Warn("recovery.uncertain", append(fields, "corrective_action", "Preserve the hold until the worker provides correlated settlement evidence.")...)
	}
}

func (b *Broker) sweepWorkerControl(ctx context.Context, logger *slog.Logger, startup bool) error {
	repo, ok := b.repo.(interface {
		SweepWorkerControl(context.Context) ([]worker.ControlItem, error)
	})
	if !ok {
		return nil
	}
	for {
		items, err := repo.SweepWorkerControl(ctx)
		if err != nil {
			failure := sqlite.Classify(err)
			logger.Error("worker_control.sweep_failed", "reason", failure.Reason, "phase", failure.Phase, "sqlite_code", failure.Code)
			return err
		}
		for _, item := range items {
			logInterruptedControl(logger, item)
		}
		if !startup || len(items) == 0 {
			return nil
		}
	}
}
