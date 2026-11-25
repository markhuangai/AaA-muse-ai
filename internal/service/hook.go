package service

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func (b *Broker) BindWake(ctx context.Context, logger *slog.Logger, workerID, id string, input inference.WakeBinding) (json.RawMessage, error) {
	ref := workerRef(workerID, id, input.SubmissionID, false)
	ref.Single, ref.NativeWork = true, true
	return b.run(ctx, logger, ref, "hook_bind", input, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if err := inference.VersionAndID(input.Version, input.SubmissionID); err != nil {
			return nil, err
		}
		if !inference.Identifier.MatchString(input.Previous) || !inference.Identifier.MatchString("event-hook-"+input.Invocation) ||
			input.Invocation == "" || input.Invocation == input.Previous {
			return nil, inference.Reject("invalid_hook_binding", 400)
		}
		job, receipt := s.Jobs[id], s.NativeWork
		if !claimMatches(job, input.ClaimID, input.Generation) || !job.Held || receipt == nil || receipt.Mode != "hook" {
			return nil, inference.Reject("stale_assignment", 409)
		}
		if job.StartedAt == nil && s.Experiments[job.ExperimentID].Terminal() {
			return nil, inference.Reject("hook_claim_terminal", 409, "claim_id", job.LeaseID, "busy_hold", true)
		}
		if job.State != "claimed" || job.StartedAt != nil || receipt.Start != nil || !s.Now.Before(job.DeadlineAt) ||
			receipt.Checker != input.Checker || receipt.WakeInvocation() != input.Previous || input.Invocation == receipt.Occurrence ||
			matchesPresence(job, "event-hook-"+input.Invocation) {
			return nil, inference.Reject("hook_binding_conflict", 409, "claim_id", job.LeaseID, "expected_checker", receipt.Checker,
				"expected_invocation", receipt.WakeInvocation(), "observed_checker", input.Checker, "observed_invocation", input.Previous,
				"requested_invocation", input.Invocation, "busy_hold", job.Held, "started_at", job.StartedAt)
		}
		receipt.Invocation = input.Invocation
		event(events, slog.LevelInfo, "job.hook_bound", s, job, "claim_id", job.LeaseID, "checker_job_id", receipt.Checker,
			"original_invocation", receipt.Occurrence, "previous_invocation", input.Previous, "wake_invocation", input.Invocation, "submission_id", input.SubmissionID)
		return map[string]string{"job_id": job.ID, "claim_id": job.LeaseID, "invocation_id": receipt.WakeInvocation()}, nil
	})
}
