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
)

type pullRepository interface {
	WithinPull(context.Context, [32]byte, inference.Pull, string, int, func(*inference.State) (*inference.Grant, error)) (inference.PullResult, string, bool, inference.PullTiming, error)
}

const nativeOfflineAfter = 10 * time.Minute

func (b *Broker) PullWork(ctx context.Context, logger *slog.Logger, credential string, input inference.Pull) (inference.PullResult, string, error) {
	if !auth.ValidToken(credential, auth.WorkerPrefix) {
		return inference.PullResult{}, "", inference.Reject("invalid_worker_credential", 401)
	}
	if input.Version != inference.Version || input.Sequence < 1 || input.Sequence > (1<<53)-1 || !inference.Identifier.MatchString(input.Checker) || !inference.Identifier.MatchString(input.Occurrence) || input.ScheduledAt.IsZero() || input.EnteredAt.Before(input.ScheduledAt) || (input.PromptWAV && !input.MediaJobs) {
		return inference.PullResult{}, "", inference.Reject("invalid_work_pull", 400)
	}
	repo, ok := b.repo.(pullRepository)
	if !ok {
		return inference.PullResult{}, "", errors.New("pull_repository_unavailable")
	}
	hash, err := inference.Hash(input)
	if err != nil {
		return inference.PullResult{}, "", err
	}
	capability := 0
	if input.MediaJobs {
		capability = 1
	}
	if input.PromptWAV {
		capability = 2
	}
	started := b.now()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	result, workerID, replayed, timing, err := repo.WithinPull(ctx, auth.Digest(credential), input, hash, capability, b.claimPulledJob)
	logger = logger.With("worker_id", workerID, "sequence", input.Sequence, "checker_job_id", input.Checker, "checker_run_id", input.Occurrence)
	logger.Debug("worker.pull_timing", "scheduled_at", input.ScheduledAt, "entered_at", input.EnteredAt, "duration_ms", b.now().Sub(started).Milliseconds(),
		"transaction_acquire_us", timing.Acquire.Microseconds(), "queue_lookup_us", timing.Select.Microseconds(), "replayed", replayed)
	if err != nil {
		var rejected *inference.Rejection
		if errors.As(err, &rejected) {
			logger.Warn("worker.pull_rejected", "reason", rejected.Reason)
		} else {
			failure := sqlite.Classify(err)
			if grant := result.Job; grant != nil {
				logger = logger.With("operation_id", grant.OperationID, "job_id", grant.JobID, "claim_id", grant.ClaimID, "generation", grant.Generation)
			}
			logger.Error("worker.pull_failed", "reason", failure.Reason, "phase", failure.Phase, "sqlite_code", failure.Code, "transaction_outcome", failure.Outcome)
		}
		return inference.PullResult{}, workerID, err
	}
	if grant := result.Job; grant != nil {
		logger = logger.With("operation_id", grant.OperationID, "job_id", grant.JobID, "claim_id", grant.ClaimID, "generation", grant.Generation)
		logger.Info("job.claimed", "claimed_at", grant.ClaimedAt, "deadline_at", grant.DeadlineAt, "replayed", replayed)
		if timing.PreviousPin != "" && timing.PreviousPin != workerID {
			logger.Info("dispatch.reassigned", "expected_worker_id", timing.PreviousPin, "observed_worker_id", workerID,
				"reason", "offline_before_claim_and_context", "context_delivery_started", false, "replayed", replayed)
		}
	} else {
		logger.Debug("worker.pull_empty", "replayed", replayed)
	}
	return result, workerID, nil
}

func (b *Broker) claimPulledJob(s *inference.State) (*inference.Grant, error) {
	for _, job := range s.Jobs {
		experiment := s.Experiments[job.ExperimentID]
		if experiment == nil || experiment.State != "queued" || experiment.CurrentJobID != job.ID {
			return nil, errors.New("inconsistent_queued_job")
		}
		claim, err := auth.ID(b.random)
		if err != nil {
			return nil, err
		}
		job.WorkerID, job.State, job.Held = s.WorkerID, "claimed", true
		job.Generation++
		job.LeaseID, job.ClaimedAt, job.PinCheckAt = claim, &s.Now, nil
		experiment.WorkerID, experiment.State = s.WorkerID, "inference"
		if request := s.Requests[experiment.ID]; request != nil {
			conversation := s.Conversations[request.ConversationID]
			if conversation == nil || (conversation.WorkerID != "" && conversation.WorkerID != s.WorkerID &&
				(conversation.WorkerID != job.ReroutedFrom || !request.ReassignAllowed || request.Input.WorkerID != "" || request.ContextDeliveryStarted != nil)) {
				return nil, errors.New("inconsistent_queued_pin")
			}
			conversation.WorkerID, request.WorkerID, request.State = s.WorkerID, s.WorkerID, experiment.State
			details := map[string]any{"job_id": job.ID, "claim_id": claim, "worker_id": s.WorkerID, "generation": job.Generation, "deadline_at": job.DeadlineAt}
			if err := addTimeline(conversation, s.Now, request.ID, "job.claimed", "INFO", details); err != nil {
				return nil, err
			}
			if job.ReroutedFrom != "" && job.ReroutedFrom != s.WorkerID {
				details["expected_worker_id"], details["observed_worker_id"], details["reason"] = job.ReroutedFrom, s.WorkerID, "offline_before_claim_and_context"
				if err := addTimeline(conversation, s.Now, request.ID, "dispatch.reassigned", "INFO", details); err != nil {
					return nil, err
				}
			}
		}
		return &inference.Grant{JobID: job.ID, OperationID: experiment.ID, ClaimID: claim, Generation: job.Generation, ClaimedAt: s.Now, DeadlineAt: job.DeadlineAt}, nil
	}
	return nil, errors.New("missing_pull_candidate")
}

func nativeClaim(job *inference.Job) bool {
	return job != nil && job.ClaimedAt != nil && job.ConnectionID == "" && job.LeaseID != ""
}

func claimMatches(job *inference.Job, claim string, generation int64) bool {
	return nativeClaim(job) && job.LeaseID == claim && job.Generation == generation
}

func (b *Broker) checkQueuedPin(ctx context.Context, logger *slog.Logger, id string) error {
	ref := inference.Ref{JobID: id, Single: true, Full: true, PollProjection: true}
	_, err := b.run(ctx, logger, ref, "queued_pin_check", nil, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		old := s.Jobs[id]
		if old == nil || old.State != "queued" || old.ClaimedAt != nil || old.Held || old.PinCheckAt == nil || s.Now.Before(*old.PinCheckAt) {
			return nil, nil
		}
		experiment, request := s.Experiments[old.ExperimentID], s.Requests[old.ExperimentID]
		if experiment == nil || request == nil || experiment.CurrentJobID != id || experiment.State != "queued" ||
			!request.ReassignAllowed || request.Input.WorkerID != "" || request.ContextDeliveryStarted != nil {
			return nil, errors.New("inconsistent_reassignable_pin")
		}
		conversation := s.Conversations[request.ConversationID]
		if conversation == nil || conversation.PendingCallID != "" || conversation.WorkerID != old.WorkerID || s.LastContactAt == nil || s.LastPollAt == nil {
			return nil, errors.New("inconsistent_reassignable_pin")
		}
		if due := s.LastContactAt.Add(nativeOfflineAfter); s.Now.Before(due) {
			old.PinCheckAt = &due
			return nil, nil
		}
		old.State, old.Reason, old.PinCheckAt = "cancelled", "rerouted_before_delivery", nil
		experiment.WorkerID, request.WorkerID = "", ""
		replacement, err := b.newJob(s, experiment, nil)
		if err != nil {
			return nil, err
		}
		replacement.ReroutedFrom = old.WorkerID
		event(events, slog.LevelInfo, "dispatch.pin_released", s, replacement, "previous_worker_id", old.WorkerID,
			"prior_job_id", id, "reason", "offline_before_claim_and_context", "last_contact_at", s.LastContactAt)
		return nil, nil
	})
	return err
}

func applyPullProjection(projection *inference.Projection, state *inference.State) {
	projection.LastPollAt = state.LastPollAt
	if state.LastPollAt != nil && state.LastContactAt != nil && !state.Revoked {
		elapsed := state.Now.Sub(*state.LastContactAt)
		switch {
		case elapsed >= nativeOfflineAfter:
			projection.ConnectionStatus = "offline"
			offline := (elapsed - nativeOfflineAfter).Milliseconds()
			projection.OfflineForMS = &offline
		case elapsed >= time.Minute:
			projection.ConnectionStatus = "quiet"
		default:
			projection.ConnectionStatus = "recent"
		}
		projection.WorkStatus = "idle"
	}
	if job := heldJob(state); nativeClaim(job) {
		projection.WorkStatus = "busy"
		projection.Claim = &inference.Grant{JobID: job.ID, OperationID: job.ExperimentID, ClaimID: job.LeaseID, Generation: job.Generation, ClaimedAt: *job.ClaimedAt, DeadlineAt: job.DeadlineAt}
		age := max(0, state.Now.Sub(*job.ClaimedAt).Milliseconds())
		projection.ClaimAgeMS = &age
		projection.ClaimStage = "pending_native_start"
		if job.StartedAt != nil {
			projection.ClaimStage = "started"
			projection.ClaimStartedAt = job.StartedAt
		}
		if job.State == "accepted" {
			projection.ClaimStage = "terminal_receipt"
		} else if job.State != "claimed" {
			projection.ClaimStage = "recovery_pending"
		}
	}
}

func (b *Broker) StartWork(ctx context.Context, logger *slog.Logger, workerID, id string, input inference.WorkStart) (json.RawMessage, error) {
	ref := workerRef(workerID, id, "", true)
	ref.Single = true
	return b.run(ctx, logger, ref, "work_start", input, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if input.Version != inference.Version || !inference.Identifier.MatchString(input.LaunchID) || !inference.Identifier.MatchString(input.NativeJob) {
			return nil, inference.Reject("invalid_work_start", 400)
		}
		job := s.Jobs[id]
		if !claimMatches(job, input.ClaimID, input.Generation) || job.State != "claimed" || !job.Held || !s.Now.Before(job.DeadlineAt) {
			return nil, inference.Reject("stale_assignment", 409)
		}
		if job.StartedAt != nil {
			return nil, inference.Reject("work_already_started", 409)
		}
		job.StartedAt, job.LaunchID, job.NativeJob = &s.Now, input.LaunchID, input.NativeJob
		startContextDelivery(s, job, events)
		event(events, slog.LevelInfo, "job.work_started", s, job, "claim_id", job.LeaseID, "launch_id", job.LaunchID, "native_job_id", job.NativeJob, "started_at", job.StartedAt)
		event(events, slog.LevelDebug, "inference.context", s, job, "claim_id", job.LeaseID, "context", job.Context)
		return job, nil
	})
}

func (b *Broker) InterruptWork(ctx context.Context, logger *slog.Logger, workerID, id string, input inference.Interruption) (json.RawMessage, error) {
	ref := workerRef(workerID, id, input.SubmissionID, false)
	ref.Single = true
	return b.run(ctx, logger, ref, "work_interrupted", input, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if err := inference.VersionAndID(input.Version, input.SubmissionID); err != nil {
			return nil, err
		}
		unlaunched := input.Reason == "launch_not_authorized" && input.NativeJob == "" && input.NativeRun == ""
		cancelledBeforeStart := input.Reason == "native_cancelled_before_start" && inference.Identifier.MatchString(input.NativeJob) && input.NativeRun == ""
		stopped := input.Reason == "execution_confirmed_stopped" && input.NativeJob != input.NativeRun &&
			inference.Identifier.MatchString(input.NativeJob) && inference.Identifier.MatchString(input.NativeRun)
		if !inference.Identifier.MatchString(input.LaunchID) || (!unlaunched && !cancelledBeforeStart && !stopped) {
			return nil, inference.Reject("invalid_work_interruption", 400)
		}
		job := s.Jobs[id]
		if !claimMatches(job, input.ClaimID, input.Generation) || (job.StartedAt != nil && (job.LaunchID != input.LaunchID || job.NativeJob != input.NativeJob)) {
			return nil, inference.Reject("stale_assignment", 409)
		}
		if job.State == "accepted" {
			if !stopped || job.Outcome == nil {
				return nil, inference.Reject("invalid_work_interruption", 409)
			}
			job.Held = false
			event(events, slog.LevelInfo, "job.work_settled", s, job, "claim_id", job.LeaseID, "launch_id", input.LaunchID, "native_job_id", input.NativeJob, "native_run_id", input.NativeRun, "reason", "accepted_result_reconciled", "busy_hold", false)
			return job.Outcome, nil
		}
		experiment := s.Experiments[job.ExperimentID]
		if unlaunched && (job.StartedAt != nil || !experiment.Terminal()) {
			return nil, inference.Reject("unlaunched_claim_not_terminal", 409)
		}
		if cancelledBeforeStart && job.StartedAt != nil {
			return nil, inference.Reject("work_already_started", 409)
		}
		finish(s, experiment, "interrupted", input.Reason, events)
		job.Held = false
		experiment.RemoteOutcome = input.Reason
		event(events, slog.LevelInfo, "job.work_settled", s, job, "claim_id", job.LeaseID, "launch_id", input.LaunchID, "native_job_id", input.NativeJob, "native_run_id", input.NativeRun, "reason", input.Reason, "busy_hold", false)
		return inference.WorkOutcome{JobID: id, ClaimID: job.LeaseID, State: job.State, Reason: job.Reason}, nil
	})
}
