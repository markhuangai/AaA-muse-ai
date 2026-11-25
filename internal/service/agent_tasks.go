package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func (b *Broker) SubmitAgentTask(ctx context.Context, logger *slog.Logger, build Build, workerID string, input worker.TaskRequest) (json.RawMessage, error) {
	if err := inference.VersionAndID(input.Version, input.SubmissionID); err != nil {
		return nil, err
	}
	if !worker.TaskPromptValid(input.Prompt, input.Title) {
		return nil, inference.Reject("invalid_agent_task", 400)
	}
	duration, err := timeout(input.TimeoutSeconds, 30, 3600, 300)
	if err != nil {
		return nil, err
	}
	ref := worker.ControlRef{Lane: worker.AgentTask, WorkerID: workerID, SubmissionID: input.SubmissionID}
	result, _, err := b.changeWorkerControl(ctx, logger, ref, "queued", input, func(record *worker.ControlRecord, state worker.ControlAdmission) (any, error) {
		if state.Capability == nil || !state.Capability.AgentTasks {
			return nil, inference.Reject("worker_agent_tasks_unsupported", 409, "agent_tasks_supported", false)
		}
		if state.Contact.Version != "" && !build.Paired(state.Contact.Contact) {
			return nil, inference.Reject("worker_update_required", 409, "agent_tasks_supported", true,
				"prompt_contract", state.Capability.PromptContract, "expected_version", build.Version, "observed_version", state.Contact.Version)
		}
		if state.Queued >= 16 {
			return nil, inference.Reject("agent_task_queue_full", 429, "queue_limit", 16)
		}
		item, err := b.makeControl(workerID, state.Now, duration)
		item.Title, item.Prompt = input.Title, input.Prompt
		record.ControlItem = item
		return record.Summary(), err
	})
	return result, err
}

func (b *Broker) BindAgentTask(ctx context.Context, logger *slog.Logger, credential, id string, input inference.WakeBinding) (json.RawMessage, string, error) {
	if err := inference.VersionAndID(input.Version, input.SubmissionID); err != nil {
		return nil, "", err
	}
	if !inference.Identifier.MatchString(input.Previous) || !inference.Identifier.MatchString("event-hook-"+input.Invocation) ||
		input.Invocation == "" || input.Previous == input.Invocation {
		return nil, "", inference.Reject("invalid_hook_binding", 400)
	}
	ref, err := workerControlRef(worker.AgentTask, credential, id, input.SubmissionID)
	if err != nil {
		return nil, "", err
	}
	logger = logger.With("previous_invocation", input.Previous, "wake_invocation", input.Invocation)
	return b.changeWorkerControl(ctx, logger, ref, "hook_bound", input, func(record *worker.ControlRecord, state worker.ControlAdmission) (any, error) {
		if !record.ClaimMatches(input.ClaimID, input.Generation) {
			return nil, inference.Reject("stale_assignment", 409)
		}
		if !record.Active() || !state.Now.Before(record.DeadlineAt) {
			return nil, inference.Reject("hook_claim_terminal", 409)
		}
		if record.State != "claimed" || record.Checker != input.Checker || record.WakeInvocation() != input.Previous ||
			record.PullOccurrence == input.Invocation || record.PresenceRun == input.Invocation {
			return nil, inference.Reject("hook_binding_conflict", 409, "expected_checker", record.Checker,
				"expected_invocation", record.WakeInvocation(), "observed_checker", input.Checker)
		}
		record.BoundInvocation = input.Invocation
		return map[string]string{"task_id": id, "claim_id": record.Claim.ClaimID, "invocation_id": record.WakeInvocation()}, nil
	})
}

func (b *Broker) StartAgentTask(ctx context.Context, logger *slog.Logger, credential, id string, input inference.WorkStart) (json.RawMessage, string, error) {
	if input.Version != inference.Version || !inference.Identifier.MatchString(input.LaunchID) || !inference.Identifier.MatchString(input.NativeJob) {
		return nil, "", inference.Reject("invalid_work_start", 400)
	}
	ref, err := workerControlRef(worker.AgentTask, credential, id, "")
	if err != nil {
		return nil, "", err
	}
	return b.changeWorkerControl(ctx, logger, ref, "started", input, func(record *worker.ControlRecord, state worker.ControlAdmission) (any, error) {
		if !record.ClaimMatches(input.ClaimID, input.Generation) {
			return nil, inference.Reject("stale_assignment", 409)
		}
		if !record.Active() || !state.Now.Before(record.DeadlineAt) {
			return nil, inference.Reject("hook_claim_terminal", 409)
		}
		proof := input.Verification
		if proof == nil {
			return nil, inference.Reject("native_start_proof_required", 409)
		}
		run := "event-hook-" + record.WakeInvocation()
		if proof.Reference != record.Claim.ClaimID || input.NativeJob != record.Checker || proof.NativeJob != record.Checker ||
			proof.NativeRun != run || proof.NativeRun == record.Checker || record.PresenceRun == record.WakeInvocation() || proof.Status != "running" ||
			(record.LaunchID != "" && record.LaunchID != input.LaunchID) {
			return nil, inference.Reject("native_start_proof_mismatch", 409, "expected_native_job_id", record.Checker,
				"expected_native_run_id", run, "observed_native_job_id", proof.NativeJob, "observed_native_run_id", proof.NativeRun)
		}
		if record.StartedAt == nil {
			record.State, record.RemoteOutcome, record.LaunchID = "running", "unknown", input.LaunchID
			record.StartedAt, record.DeliveryFinished = &state.Now, &state.Now
		}
		return record.ControlItem, nil
	})
}

type agentTaskPresenceRepository interface {
	RecordAgentTaskPresence(context.Context, [32]byte, string, inference.BusyCheck, worker.Contact, bool) (inference.PresenceReceipt, string, *worker.Capability, bool, error)
}

func (b *Broker) AgentTaskPresence(ctx context.Context, logger *slog.Logger, credential, id string, input inference.BusyCheck, contact worker.Contact,
	supportsTasks bool,
) (inference.PresenceReceipt, string, error) {
	if !auth.ValidToken(credential, auth.WorkerPrefix) {
		return inference.PresenceReceipt{}, "", inference.Reject("invalid_worker_credential", 401)
	}
	if input.Version != inference.Version || input.Generation < 1 || !inference.Identifier.MatchString(input.ClaimID) ||
		!inference.Identifier.MatchString(input.Checker) || !inference.Identifier.MatchString(input.Occurrence) ||
		input.ScheduledAt.IsZero() || !validBusyReason(input.Reason) {
		return inference.PresenceReceipt{}, "", inference.Reject("invalid_busy_check", 400)
	}
	repo, ok := b.repo.(agentTaskPresenceRepository)
	if !ok {
		return inference.PresenceReceipt{}, "", errors.New("agent_task_presence_unavailable")
	}
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	started := b.now()
	receipt, owner, cap, changed, err := repo.RecordAgentTaskPresence(bounded, auth.Digest(credential), id, input, contact, supportsTasks)
	logger = logger.With("worker_id", owner, "operation_id", id, "agent_task_id", id, "claim_id", input.ClaimID,
		"generation", input.Generation, "checker_job_id", input.Checker, "checker_run_id", input.Occurrence,
		"duration_ms", b.now().Sub(started).Milliseconds(), "attempt", 1)
	if err != nil {
		var rejected *inference.Rejection
		if errors.As(err, &rejected) {
			name := "agent_task.rejected"
			if rejected.Reason == "worker_scope_denied" {
				name = "worker.scope_denied"
			} else if rejected.Code == 401 {
				name = "worker.auth_denied"
			}
			logger.Warn(name, "stage", "presence", "reason", rejected.Reason,
				"expected_state", "authorized_current_assignment", "observed_state", "rejected")
			rejected.Fields["control_diagnostic_recorded"] = true
		}
		return receipt, owner, err
	}
	logger.Debug("agent_task.presence_observed", "input", input, "result", receipt)
	logWorkerCapability(logger, cap, changed)
	if input.WeeklyUsage != nil {
		logWeeklyUsage(logger, input.WeeklyUsage, receipt.ReceivedAt, receipt.UsageResult)
	}
	return receipt, owner, nil
}

func logWorkerCapability(logger *slog.Logger, cap *worker.Capability, changed bool) {
	if cap == nil {
		return
	}
	fields := []any{"agent_tasks_supported", cap.AgentTasks, "prompt_contract", cap.PromptContract, "observed_at", cap.ObservedAt}
	logger.Debug("worker.capabilities_observed", fields...)
	if changed {
		logger.Info("worker.capabilities_changed", fields...)
	}
}

func (b *Broker) CompleteAgentTask(ctx context.Context, logger *slog.Logger, credential, id string, input worker.TaskResult,
	redact func(string) string,
) (json.RawMessage, string, error) {
	if err := inference.VersionAndID(input.Version, input.SubmissionID); err != nil {
		return nil, "", err
	}
	if !worker.TaskResultValid(input) || !inference.Identifier.MatchString(input.LaunchID) {
		return nil, "", inference.Reject("invalid_agent_task_result", 400)
	}
	ref, err := workerControlRef(worker.AgentTask, credential, id, input.SubmissionID)
	if err != nil {
		return nil, "", err
	}
	return b.changeWorkerControl(ctx, logger, ref, "result_accepted", input, func(record *worker.ControlRecord, state worker.ControlAdmission) (any, error) {
		if !record.ClaimMatches(input.ClaimID, input.Generation) || record.StartedAt == nil || record.LaunchID != input.LaunchID ||
			record.State != "running" || !state.Now.Before(record.DeadlineAt) {
			return nil, inference.Reject("stale_assignment", 409)
		}
		payload, err := json.Marshal(map[string]string{"result_text": redact(input.Text), "summary": redact(input.Summary)})
		if err != nil {
			return nil, err
		}
		record.ResultSHA256, err = inference.Hash(json.RawMessage(payload))
		if err != nil {
			return nil, err
		}
		record.Result, record.ResultBytes = payload, len(payload)
		record.State, record.RemoteOutcome, record.Reason, record.FinishedAt = input.Outcome, input.Outcome, input.Reason, &state.Now
		return record.Summary(), nil
	})
}

func (b *Broker) SettleAgentTask(ctx context.Context, logger *slog.Logger, credential, id string, input inference.Interruption,
	evidence *inference.InterruptionEvidence,
) (json.RawMessage, string, error) {
	if err := inference.VersionAndID(input.Version, input.SubmissionID); err != nil {
		return nil, "", err
	}
	if !inference.Identifier.MatchString(input.LaunchID) || (input.Reason != "execution_confirmed_stopped" && input.Reason != "launch_not_authorized") {
		return nil, "", inference.Reject("invalid_interruption", 400)
	}
	ref, err := workerControlRef(worker.AgentTask, credential, id, input.SubmissionID)
	if err != nil {
		return nil, "", err
	}
	return b.changeWorkerControl(ctx, logger, ref, "settled", []any{input, evidence}, func(record *worker.ControlRecord, state worker.ControlAdmission) (any, error) {
		if !record.ClaimMatches(input.ClaimID, input.Generation) {
			return nil, inference.Reject("stale_assignment", 409)
		}
		run := "event-hook-" + record.WakeInvocation()
		matches := input.NativeJob == record.Checker && input.NativeRun == run && record.PresenceRun != record.WakeInvocation()
		switch {
		case record.StartedAt != nil:
			matches = matches && input.Reason == "execution_confirmed_stopped" && record.LaunchID == input.LaunchID
		case input.Reason == "launch_not_authorized":
			matches = !record.Active() || !state.Now.Before(record.DeadlineAt)
		}
		if !matches {
			return nil, inference.Reject("native_settlement_proof_mismatch", 409, "expected_native_job_id", record.Checker,
				"expected_native_run_id", run, "observed_native_job_id", input.NativeJob, "observed_native_run_id", input.NativeRun)
		}
		if record.Active() {
			record.Interrupt("interrupted", input.Reason, state.Now)
		}
		if record.Interruption != nil {
			if evidence != nil {
				record.Interruption["native_status"] = evidence.NativeStatus
			}
			record.ReasonMessage = inference.ExplainInterruption(record.State, record.Reason,
				&inference.InterruptionEvidence{Stage: record.Interruption["stage"], NativeStatus: record.Interruption["native_status"]})
			if record.StartedAt == nil {
				record.RemoteOutcome = "not_started"
			} else {
				record.RemoteOutcome = "stopped"
			}
		}
		record.Held = false
		return record.Summary(), nil
	})
}

type HookPrompt struct {
	WorkerID       string `json:"worker_id"`
	HookID         string `json:"hook_id"`
	PromptContract string `json:"prompt_contract"`
	UpgradePrompt  string `json:"upgrade_prompt"`
}

func (b *Broker) HookUpgradePrompt(ctx context.Context, id string) (HookPrompt, error) {
	repo, ok := b.repo.(interface {
		WorkerHookPromptEligibility(context.Context, string) error
	})
	if !ok {
		return HookPrompt{}, errors.New("worker_hook_prompt_repository_unavailable")
	}
	if err := repo.WorkerHookPromptEligibility(ctx, id); err != nil {
		return HookPrompt{}, err
	}
	hookID := "aaa-muse-worker-" + id
	prompt := fmt.Sprintf(`Update the existing worker %s in this main Muse chat. Keep its credentials, state directory, launcher, and watchdog.
Locate the installed worker launcher and the owning goal ID. Run its hook-upgrade-describe --worker-id %s --goal-id <actual-goal-id> command. Stop if it fails.
Read the actual hook and hourly watchdog for this goal. Require one matching hook with ID %s and one unchanged watchdog. Use the returned definition to update the existing hook prompt with hooks.update if offered. If Muse offers only remove and add, first record the exact original definition, then replace only this hook using the same ID. Stop on ambiguous readback and show the owner the exact status.
Read back the actual definition, dry run the hook and require silent, then submit the actual unique hook and watchdog, goal_id, complete=true and dry_run="silent" to the installed launcher's hook-confirm --input -. Report registration only if the command confirms it. Keep setup credentials out of chat.`, id, id, hookID)
	return HookPrompt{WorkerID: id, HookID: hookID, PromptContract: worker.HookPromptContract, UpgradePrompt: prompt}, nil
}
