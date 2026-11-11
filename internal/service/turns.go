package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func (b *Broker) newJob(s *inference.State, e *inference.Experiment, probe *inference.Probe) (*inference.Job, error) {
	if err := inference.CheckContext(e.Messages, e.Tools); err != nil {
		return nil, err
	}
	id, err := auth.ID(b.random)
	if err != nil {
		return nil, err
	}
	hash, err := contextHash(e.Messages, e.Tools)
	if err != nil {
		return nil, err
	}
	d := inference.Delivery{ReceiptID: id, Kind: "full", HistoryCount: len(e.Messages), CanonicalSHA256: hash, Messages: append([]inference.Item{}, e.Messages...), Tools: e.Tools}
	if probe != nil {
		if probe.Kind != "full" && probe.Kind != "delta" {
			return nil, inference.Reject("invalid_context_probe", 400)
		}
		if probe.Kind == "full" && probe.BaseReceiptID != "" {
			return nil, inference.Reject("unexpected_context_base", 400)
		}
		if probe.Kind == "delta" {
			base := s.Jobs[probe.BaseReceiptID]
			if base == nil || base.ExperimentID != e.ID || base.State != "accepted" || base.ConnectionID != s.Connection.ID || base.ConnectionGeneration != s.Connection.Generation || base.Context.HistoryCount > len(e.Messages) {
				return nil, inference.Reject("invalid_context_base", 409)
			}
			prefix, err := contextHash(e.Messages[:base.Context.HistoryCount], e.Tools)
			if err != nil {
				return nil, err
			}
			if prefix != base.Context.CanonicalSHA256 {
				return nil, inference.Reject("context_prefix_conflict", 409)
			}
			d.Kind, d.BaseReceiptID, d.BasePrefix, d.BaseSHA256 = "delta", base.ID, base.Context.HistoryCount, prefix
			d.Messages = append([]inference.Item{}, e.Messages[d.BasePrefix:]...)
		}
	}
	j := &inference.Job{Version: 1, ID: id, ExperimentID: e.ID, ConversationID: e.ConversationID, WorkerID: e.WorkerID, State: "queued", CreatedAt: s.Now, DeadlineAt: e.DeadlineAt, Context: d}
	if d.Kind == "delta" {
		j.ConnectionID, j.ConnectionGeneration = s.Connection.ID, s.Connection.Generation
	}
	s.Jobs[id] = j
	e.State = "queued"
	e.CurrentJobID = id
	return j, nil
}

func contextHash(messages []inference.Item, tools []inference.Tool) (string, error) {
	return inference.Hash(struct {
		Messages []inference.Item `json:"messages"`
		Tools    []inference.Tool `json:"tools"`
	}{messages, tools})
}

func (b *Broker) Create(ctx context.Context, logger *slog.Logger, c inference.Create) (json.RawMessage, error) {
	return b.run(ctx, logger, inference.Ref{WorkerID: c.WorkerID, Principal: "management", SubmissionID: c.SubmissionID, Admission: true, Full: true}, "create", c, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if err := inference.ValidateCreate(&c); err != nil {
			return nil, err
		}
		if s.Revoked {
			return nil, inference.Reject("worker_revoked", 409)
		}
		if s.Connection.Status(s.Now) != "online" {
			return nil, inference.Reject("worker_offline", 409)
		}
		if s.ActiveCount >= b.maxJobs {
			return nil, inference.Reject("queue_full", 429, "active_experiments", s.ActiveCount, "max_jobs", b.maxJobs)
		}
		id, err := auth.ID(b.random)
		if err != nil {
			return nil, err
		}
		conversation, err := auth.ID(b.random)
		if err != nil {
			return nil, err
		}
		e := &inference.Experiment{ID: id, ConversationID: conversation, WorkerID: c.WorkerID, State: "queued", CreatedAt: s.Now, DeadlineAt: s.Now.Add(time.Duration(c.TimeoutSeconds) * time.Second), Messages: append([]inference.Item{}, c.Messages...), Tools: c.Tools, RemoteOutcome: "not_started"}
		s.Experiments[id] = e
		j, err := b.newJob(s, e, c.ContextProbe)
		if err != nil {
			return nil, err
		}
		event(events, slog.LevelInfo, "job.queued", s, j, "context_kind", j.Context.Kind, "context_receipt_id", j.Context.ReceiptID)
		event(events, slog.LevelDebug, "inference.context", s, j, "context", j.Context, "canonical_messages", e.Messages)
		return e, nil
	})
}

func (b *Broker) Read(ctx context.Context, logger *slog.Logger, id string) (json.RawMessage, error) {
	return b.run(ctx, logger, inference.Ref{ExperimentID: id, Principal: "management", Full: true}, "read", nil, func(s *inference.State, _ *[]inferenceEvent) (any, error) {
		e := s.Experiments[id]
		if e == nil {
			return nil, inference.Reject("inference_not_found", 404)
		}
		return e, nil
	})
}

func (b *Broker) Cancel(ctx context.Context, logger *slog.Logger, id string, c inference.Cancel) (json.RawMessage, error) {
	return b.run(ctx, logger, inference.Ref{ExperimentID: id, Principal: "management", SubmissionID: c.SubmissionID, Full: true}, "cancel", c, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if err := inference.VersionAndID(c.Version, c.SubmissionID); err != nil {
			return nil, err
		}
		e := s.Experiments[id]
		if e == nil {
			return nil, inference.Reject("inference_not_found", 404)
		}
		if e.State == "completed" {
			return nil, inference.Reject("experiment_already_completed", 409)
		}
		finish(s, e, "cancelled", "operator_cancelled", events)
		return e, nil
	})
}

func (b *Broker) ToolResult(ctx context.Context, logger *slog.Logger, id string, t inference.ToolResult) (json.RawMessage, error) {
	base := ""
	if t.ContextProbe != nil {
		base = t.ContextProbe.BaseReceiptID
	}
	return b.run(ctx, logger, inference.Ref{ExperimentID: id, BaseJobID: base, Principal: "management", SubmissionID: t.SubmissionID, Full: true}, "tool_result", t, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if err := inference.VersionAndID(t.Version, t.SubmissionID); err != nil {
			return nil, err
		}
		e := s.Experiments[id]
		if e == nil {
			return nil, inference.Reject("inference_not_found", 404)
		}
		if e.State != "waiting_for_tool" || len(e.Messages) == 0 || e.Messages[len(e.Messages)-1].Type != "tool_call" || t.CallID != e.Messages[len(e.Messages)-1].CallID {
			return nil, inference.Reject("tool_result_linkage_conflict", 409)
		}
		e.Messages = append(e.Messages, inference.Item{Type: "tool_result", CallID: t.CallID, Output: t.Output})
		j, err := b.newJob(s, e, t.ContextProbe)
		if err != nil {
			return nil, err
		}
		event(events, slog.LevelInfo, "tool_result.accepted", s, j, "call_id", t.CallID)
		event(events, slog.LevelInfo, "job.queued", s, j, "context_kind", j.Context.Kind, "context_receipt_id", j.Context.ReceiptID)
		event(events, slog.LevelDebug, "inference.context", s, j, "context", j.Context, "canonical_messages", e.Messages)
		return e, nil
	})
}

func workerRef(workerID, jobID, submission string, full bool) inference.Ref {
	return inference.Ref{WorkerID: workerID, WorkerAuth: workerID, JobID: jobID, Principal: "worker:" + workerID, SubmissionID: submission, Full: full}
}

func (b *Broker) Job(ctx context.Context, logger *slog.Logger, workerID, id string) (json.RawMessage, error) {
	return b.run(ctx, logger, workerRef(workerID, id, "", true), "job_read", nil, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		j := s.Jobs[id]
		if j == nil {
			return nil, inference.Reject("inference_not_found", 404)
		}
		if j.Reason == "rerouted_before_delivery" {
			return nil, inference.Reject("stale_assignment", 409)
		}
		if j.State == "queued" {
			if err := nativeEligibility(s, j); err != nil {
				return nil, err
			}
		}
		startContextDelivery(s, j, events)
		return j, nil
	})
}

func (b *Broker) Claim(ctx context.Context, logger *slog.Logger, workerID, id string, c inference.Claim) (json.RawMessage, error) {
	return b.run(ctx, logger, workerRef(workerID, id, c.SubmissionID, true), "claim", c, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if err := inference.VersionAndID(c.Version, c.SubmissionID); err != nil {
			return nil, err
		}
		if err := connectionMatches(s, c.ConnectionID, c.ConnectionGeneration); err != nil {
			return nil, err
		}
		if s.Connection.Status(s.Now) != "online" {
			return nil, inference.Reject("worker_offline", 409)
		}
		j := s.Jobs[id]
		if j == nil {
			return nil, inference.Reject("inference_not_found", 404)
		}
		if err := nativeEligibility(s, j); err != nil {
			return nil, err
		}
		if held := heldJob(s); held != nil {
			return nil, inference.Reject("worker_busy", 409, "held_job_id", held.ID, "held_generation", held.Generation)
		}
		if j.State != "queued" {
			return nil, inference.Reject("job_not_queued", 409, "expected_state", "queued", "observed_state", j.State)
		}
		if j.Context.Kind == "delta" && (j.ConnectionID != s.Connection.ID || j.ConnectionGeneration != s.Connection.Generation) {
			return nil, inference.Reject("context_base_connection_changed", 409, "base_receipt_id", j.Context.BaseReceiptID, "expected_connection_id", j.ConnectionID, "expected_connection_generation", j.ConnectionGeneration, "observed_connection_id", s.Connection.ID, "observed_connection_generation", s.Connection.Generation)
		}
		lease, err := auth.ID(b.random)
		if err != nil {
			return nil, err
		}
		s.Connection.AssignmentGeneration++
		until := minTime(s.Now.Add(inference.HealthWindow), j.DeadlineAt)
		j.State, j.Held, j.Generation, j.LeaseID = "claimed", true, s.Connection.AssignmentGeneration, lease
		j.ConnectionID, j.ConnectionGeneration = s.Connection.ID, s.Connection.Generation
		j.ClaimedAt, j.LeaseExpiresAt = &s.Now, &until
		s.Experiments[j.ExperimentID].State = "inference"
		startContextDelivery(s, j, events)
		event(events, slog.LevelInfo, "job.claimed", s, j, "context_receipt_id", j.Context.ReceiptID)
		return j, nil
	})
}

func (b *Broker) Decide(ctx context.Context, logger *slog.Logger, workerID, id string, d inference.Submit) (json.RawMessage, error) {
	return b.run(ctx, logger, workerRef(workerID, id, d.SubmissionID, true), "decision", d, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if err := inference.VersionAndID(d.Version, d.SubmissionID); err != nil {
			return nil, err
		}
		if err := connectionMatches(s, d.ConnectionID, d.ConnectionGeneration); err != nil {
			return nil, err
		}
		j := s.Jobs[id]
		if j == nil {
			return nil, inference.Reject("inference_not_found", 404)
		}
		if j.State != "claimed" || !j.Held || j.Generation != d.Generation || j.LeaseID != d.LeaseID || j.ConnectionID != d.ConnectionID || j.ConnectionGeneration != d.ConnectionGeneration || j.ConversationID != d.ConversationID || j.Context.ReceiptID != d.ContextReceiptID {
			return nil, inference.Reject("stale_assignment", 409, "expected_generation", j.Generation, "observed_generation", d.Generation, "expected_state", j.State, "observed_context_receipt", d.ContextReceiptID, "expected_context_receipt", j.Context.ReceiptID)
		}
		e := s.Experiments[j.ExperimentID]
		if err := inference.ValidateDecision(d.Decision, e.Tools); err != nil {
			return nil, err
		}
		if d.Decision.Type == "tool_call" {
			for _, m := range e.Messages {
				if m.Type == "tool_call" && m.CallID == d.Decision.CallID {
					return nil, inference.Reject("duplicate_tool_call_id", 409)
				}
			}
			e.Messages = append(e.Messages, d.Decision)
			e.State = "waiting_for_tool"
		} else {
			e.Messages = append(e.Messages, inference.Item{Type: "message", Role: "assistant", Text: d.Decision.Text})
			e.State = "completed"
			e.FinalText = d.Decision.Text
		}
		if err := inference.CheckContext(e.Messages, e.Tools); err != nil {
			return nil, err
		}
		if err := b.acceptHistory(s, e, d.Decision); err != nil {
			return nil, err
		}
		j.State, j.Held = "accepted", false
		e.RemoteOutcome = "decision_observed"
		event(events, slog.LevelInfo, "decision.accepted", s, j, "decision_type", d.Decision.Type, "call_id", d.Decision.CallID, "experiment_state", e.State)
		event(events, slog.LevelDebug, "inference.decision", s, j, "decision", d.Decision, "tools", e.Tools, "canonical_messages", e.Messages)
		return e, nil
	})
}
