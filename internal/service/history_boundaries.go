package service

import (
	"context"
	"log/slog"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func nativeRef(client, id string) inference.Ref {
	return inference.Ref{ExperimentID: id, ClientID: client, Principal: "client:" + client, Full: true}
}

func (b *Broker) ReadRequest(ctx context.Context, logger *slog.Logger, client, id, session string) (inference.RequestView, error) {
	var view inference.RequestView
	ref := nativeRef(client, id)
	ref.SessionID = session
	_, err := b.run(ctx, logger, ref, "request_read", nil, func(s *inference.State, _ *[]inferenceEvent) (any, error) {
		r := s.Requests[id]
		if r == nil || r.ClientID != client {
			return nil, inference.Reject("history_owner_denied", 404, "requested_id", id)
		}
		r.State, r.Reason = s.Experiments[id].State, s.Experiments[id].Reason
		view = r.View(true)
		return view, nil
	})
	return view, err
}

func (b *Broker) CancelRequest(ctx context.Context, logger *slog.Logger, client, id, session string, input inference.Cancel) (inference.RequestView, error) {
	var view inference.RequestView
	ref := nativeRef(client, id)
	ref.SessionID = session
	ref.SubmissionID = input.SubmissionID
	data, err := b.run(ctx, logger, ref, "request_cancel", struct {
		Session string           `json:"session_id"`
		Input   inference.Cancel `json:"input"`
	}{session, input}, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if err := inference.VersionAndID(input.Version, input.SubmissionID); err != nil {
			return nil, err
		}
		r := s.Requests[id]
		if r == nil || r.ClientID != client {
			return nil, inference.Reject("history_owner_denied", 404, "requested_id", id)
		}
		e := s.Experiments[id]
		if e.State == "completed" {
			return nil, inference.Reject("request_already_completed", 409)
		}
		finish(s, e, "cancelled", "operator_cancelled", events)
		r.State, r.Reason = e.State, e.Reason
		return r.View(false), nil
	})
	if err == nil {
		err = inference.Decode(data, &view)
	}
	return view, err
}

func startContextDelivery(s *inference.State, job *inference.Job, events *[]inferenceEvent) {
	if r := s.Requests[job.ExperimentID]; r != nil && r.ContextDeliveryStarted == nil {
		r.ContextDeliveryStarted = &s.Now
		event(events, slog.LevelInfo, "request.context_delivery_started", s, job, "boundary", "before_context_write")
	}
}

func (b *Broker) DeliveryFinished(ctx context.Context, logger *slog.Logger, worker, job string, attempted, written int, cause string) error {
	_, err := b.run(ctx, logger, workerRef(worker, job, "", false), "context_written", map[string]any{"attempted_bytes": attempted, "written_bytes": written, "cause": cause}, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		j := s.Jobs[job]
		r := s.Requests[j.ExperimentID]
		if r == nil {
			return nil, nil
		}
		if cause != "" || attempted != written {
			event(events, slog.LevelWarn, "request.context_delivery_interrupted", s, j, "attempted_bytes", attempted, "written_bytes", written, "cause", cause, "outcome", "uncertain")
		} else if r.ContextDeliveryWritten == nil {
			r.ContextDeliveryWritten = &s.Now
			event(events, slog.LevelInfo, "request.context_delivery_written", s, j, "attempted_bytes", attempted, "written_bytes", written, "receipt_scope", "server_write")
		}
		return nil, nil
	})
	return err
}

func (b *Broker) OutputBoundary(ctx context.Context, logger *slog.Logger, client, id string, completed bool, attempted, written int, cause string) error {
	ref := nativeRef(client, id)
	ref.Full = false
	_, err := b.run(ctx, logger, ref, "output_boundary", map[string]any{"completed": completed, "attempted_bytes": attempted, "written_bytes": written, "cause": cause}, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		r := s.Requests[id]
		if r == nil || r.ClientID != client {
			return nil, inference.Reject("history_owner_denied", 404, "requested_id", id)
		}
		if r.Output == nil {
			return nil, inference.Reject("output_not_available", 409)
		}
		e := s.Experiments[id]
		j := s.Jobs[e.CurrentJobID]
		if j == nil {
			j = &inference.Job{ID: e.CurrentJobID, ExperimentID: id, ConversationID: r.ConversationID}
		}
		if !completed {
			if r.OutputStartedAt == nil {
				r.OutputStartedAt = &s.Now
				event(events, slog.LevelInfo, "request.output_started", s, j, "boundary", "before_model_output_write", "decision_type", r.Output.Type)
			}
		} else if cause != "" || attempted != written {
			event(events, slog.LevelWarn, "request.output_interrupted", s, j, "attempted_bytes", attempted, "written_bytes", written, "cause", cause, "outcome", "uncertain")
		} else if r.OutputCompletedAt == nil {
			r.OutputCompletedAt = &s.Now
			event(events, slog.LevelInfo, "request.output_completed", s, j, "attempted_bytes", attempted, "written_bytes", written, "receipt_scope", "server_write")
		}
		return nil, nil
	})
	return err
}
