package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"sort"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func validateClaimReplay(s *inference.State, result json.RawMessage) error {
	var saved inference.Job
	if err := inference.Decode(result, &saved); err != nil {
		return err
	}
	j := s.Jobs[saved.ID]
	if j == nil {
		return inference.Reject("stale_assignment", 409, "expected_generation", int64(0), "observed_generation", saved.Generation, "expected_state", "missing", "expected_connection_generation", s.Connection.Generation, "observed_connection_generation", saved.ConnectionGeneration)
	}
	if err := assignmentConnection(s, j, saved.ConnectionID, saved.ConnectionGeneration, saved.Generation); err != nil {
		return err
	}
	e := s.Experiments[j.ExperimentID]
	if j.State != "claimed" || !j.Held || j.Generation != saved.Generation || j.LeaseID != saved.LeaseID || j.ConnectionID != saved.ConnectionID || j.ConnectionGeneration != saved.ConnectionGeneration || j.Context.ReceiptID != saved.Context.ReceiptID || j.LeaseExpiresAt == nil || !s.Now.Before(*j.LeaseExpiresAt) || !s.Now.Before(j.DeadlineAt) || s.Connection.Status(s.Now) != "online" || e == nil || e.Terminal() {
		return inference.Reject("stale_assignment", 409, "expected_generation", j.Generation, "observed_generation", saved.Generation, "expected_state", j.State, "expected_connection_generation", s.Connection.Generation, "observed_connection_generation", saved.ConnectionGeneration, "lease_expires_at", j.LeaseExpiresAt, "deadline_at", j.DeadlineAt, "busy_hold", j.Held)
	}
	return nil
}

func assignmentConnection(s *inference.State, j *inference.Job, id string, connectionGeneration, assignmentGeneration int64) error {
	err := connectionMatches(s, id, connectionGeneration)
	if rejected, ok := err.(*inference.Rejection); ok {
		rejected.Fields["expected_generation"] = j.Generation
		rejected.Fields["observed_generation"] = assignmentGeneration
		rejected.Fields["expected_state"] = j.State
	}
	return err
}

func uncertain(events *[]inferenceEvent, s *inference.State, j *inference.Job, boundary, reason string) {
	event(events, slog.LevelWarn, "recovery.uncertain", s, j, "last_boundary", boundary, "reason", reason, "busy_hold", j.Held, "remote_outcome", "unknown", "automatic_replay", false, "corrective_action", "preserve the assignment; accept only a current unexpired matching decision, otherwise await the exact idle acknowledgement without retrying inference")
}

func (b *Broker) Recover(ctx context.Context, logger *slog.Logger) error {
	logger.Info("recovery.started", "protocol_version", inference.Version, "health_window_seconds", 30)
	_, err := b.run(ctx, logger, inference.Ref{Routing: true, Full: true, Recovery: true}, "recovery", nil, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		previous := map[string]string{}
		ids := make([]string, 0, len(s.Experiments))
		for id, e := range s.Experiments {
			previous[id] = e.State
			ids = append(ids, id)
		}
		expire(s, events)
		sort.Strings(ids)
		for _, id := range ids {
			e := s.Experiments[id]
			j := s.Jobs[e.CurrentJobID]
			if j == nil {
				j = &inference.Job{ID: e.CurrentJobID, ExperimentID: id, ConversationID: e.ConversationID, WorkerID: e.WorkerID, State: e.State, DeadlineAt: e.DeadlineAt}
			}
			r := s.Requests[id]
			fields := []any{"previous_state", previous[id], "restored_state", e.State, "busy_hold", j.Held, "remote_outcome", e.RemoteOutcome, "reason", e.Reason, "context_receipt_id", j.Context.ReceiptID, "assignment_connection_id", j.ConnectionID, "assignment_connection_generation", j.ConnectionGeneration}
			if r != nil {
				c := s.Conversations[r.ConversationID]
				fields = append(fields, "pinned_worker_id", c.WorkerID, "pending_call_id", c.PendingCallID, "context_delivery_started_at", r.ContextDeliveryStarted, "context_delivery_written_at", r.ContextDeliveryWritten, "decision_accepted_at", r.DecisionAcceptedAt, "output_started_at", r.OutputStartedAt, "output_completed_at", r.OutputCompletedAt)
			}
			event(events, slog.LevelInfo, "recovery.restored", s, j, fields...)
			event(events, slog.LevelDebug, "recovery.detail", s, j, "experiment", e, "assignment", j, "request", r)
			if j.Held && previous[id] == e.State {
				uncertain(events, s, j, "claimed_inference", "awaiting_correlated_outcome")
			}
			if r != nil {
				recoverDelivery(events, s, j, e, r)
			}
		}
		*events = append(*events, inferenceEvent{"recovery.restored", slog.LevelInfo, []any{"summary", s.Recovery, "restored_operations", len(ids), "workers", len(s.Pool), "receipt_policy", "durable_authenticated_lookup", "automatic_replacement", false}})
		return nil, nil
	})
	return err
}

func recoverDelivery(events *[]inferenceEvent, s *inference.State, j *inference.Job, e *inference.Experiment, r *inference.Request) {
	for _, boundary := range []struct {
		name       string
		incomplete bool
	}{
		{"context_delivery", r.ContextDeliveryStarted != nil && r.ContextDeliveryWritten == nil},
		{"output_delivery", r.OutputStartedAt != nil && r.OutputCompletedAt == nil},
	} {
		if !boundary.incomplete {
			continue
		}
		action := "retrieve the durable decision and reconcile the recorded delivery; do not regenerate inference"
		if r.Output == nil {
			action = "verify worker health and readiness, then retrieve the same unclaimed job; do not create replacement work or assume a decision exists"
			if j.Held || j.ClaimedAt != nil {
				action = "preserve the claimed assignment and await its correlated outcome or exact idle acknowledgement after fencing; do not retry inference"
			}
		}
		event(events, slog.LevelWarn, "recovery.uncertain", s, j, "last_boundary", boundary.name, "reason", "delivery_completion_receipt_missing", "decision_available", r.Output != nil, "busy_hold", j.Held, "remote_outcome", e.RemoteOutcome, "automatic_replay", false, "corrective_action", action)
	}
}
