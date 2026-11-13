package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sort"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/postgres"
)

type InferenceRepository interface {
	WithinInference(context.Context, inference.Ref, func(*inference.State) error) error
	InferenceWorkers(context.Context) ([]string, error)
}

type Broker struct {
	repo    InferenceRepository
	random  io.Reader
	now     func() time.Time
	Wait    func(context.Context, time.Duration) error
	maxJobs int
}

func NewBroker(repo InferenceRepository, random io.Reader, now func() time.Time, wait func(context.Context, time.Duration) error, maxJobs int) *Broker {
	return &Broker{repo: repo, random: random, now: now, Wait: wait, maxJobs: maxJobs}
}

type inferenceEvent struct {
	name   string
	level  slog.Level
	fields []any
}

func event(events *[]inferenceEvent, level slog.Level, name string, s *inference.State, j *inference.Job, extra ...any) {
	w := s
	workerID := s.WorkerID
	connection := s.Connection
	if j != nil {
		if j.WorkerID != "" {
			workerID = j.WorkerID
		} else if r := s.Requests[j.ExperimentID]; r != nil {
			workerID = r.WorkerID
		}
		if found := poolWorker(s, workerID); found != nil {
			w = found
			connection = w.Connection
		} else if workerID == "" {
			connection = inference.Connection{}
		}
	}
	attrs := []any{"worker_id", workerID, "connection_id", connection.ID, "connection_generation", connection.Generation}
	if j != nil {
		attrs = append(attrs, "operation_id", j.ExperimentID, "experiment_id", j.ExperimentID, "conversation_id", j.ConversationID, "job_id", j.ID, "generation", j.Generation, "state", j.State, "lease_expires_at", j.LeaseExpiresAt, "deadline_at", j.DeadlineAt, "claimed_at", j.ClaimedAt)
		if r := s.Requests[j.ExperimentID]; r != nil {
			attrs = append(attrs, "client_id", r.ClientID, "session_id", r.SessionID, "request_record_id", r.ID)
		}
	} else {
		attrs = append(attrs, "operation_id", s.Connection.ID)
	}
	*events = append(*events, inferenceEvent{name, level, append(attrs, extra...)})
}

func heldJob(s *inference.State) *inference.Job {
	for _, j := range s.Jobs {
		if j.Held && j.WorkerID == s.WorkerID {
			return j
		}
	}
	return nil
}

func project(s *inference.State) inference.Projection {
	p := inference.Projection{InferenceReadiness: readiness(s), Qualification: s.Routing.Latest(), QualificationHistory: append([]inference.Qualification{}, s.Routing.Qualifications...), ConnectionStatus: s.Connection.Status(s.Now), WorkStatus: "unknown", LastHeartbeatAt: s.Connection.LastAckAt, WaitingForTool: s.PendingTools}
	if p.ConnectionStatus == "online" {
		p.WorkStatus = "idle"
	}
	if j := heldJob(s); j != nil {
		p.WorkStatus = "busy"
		p.CurrentJob = &inference.Assignment{JobID: j.ID, Generation: j.Generation, LeaseID: j.LeaseID}
	}
	for _, e := range s.Experiments {
		if e.State == "waiting_for_tool" {
			p.WaitingForTool++
		}
	}
	return p
}

func finish(s *inference.State, e *inference.Experiment, state, reason string, events *[]inferenceEvent) {
	if e.Terminal() {
		return
	}
	previousBoundary := "client_tool_wait"
	if e.State == "queued" && e.CurrentJobID == "" {
		previousBoundary = "dispatch_queue"
	}
	e.State, e.Reason, e.RemoteOutcome = state, reason, "not_started"
	emitted := false
	for _, j := range s.Jobs {
		if j.ExperimentID != e.ID || (j.State != "queued" && j.State != "claimed") {
			continue
		}
		if j.Held {
			e.RemoteOutcome = "unknown"
		}
		j.State, j.Reason = state, reason
		emitted = true
		level, name := slog.LevelError, "job.interrupted"
		if reason == "deadline_exceeded" {
			name = "job.deadline_exceeded"
		}
		if reason == "operator_cancelled" {
			level, name = slog.LevelInfo, "experiment.cancelled"
		}
		event(events, level, name, s, j, "reason", reason, "remote_outcome", e.RemoteOutcome, "busy_hold", j.Held, "last_heartbeat_at", s.Connection.LastAckAt, "created_at", j.CreatedAt)
		if j.Held {
			uncertain(events, s, j, "claimed_inference", reason)
		}
	}
	if !emitted {
		level, name := slog.LevelError, "job.interrupted"
		if reason == "deadline_exceeded" {
			name = "job.deadline_exceeded"
		}
		if reason == "operator_cancelled" {
			level, name = slog.LevelInfo, "experiment.cancelled"
		}
		event(events, level, name, s, &inference.Job{ID: e.CurrentJobID, ExperimentID: e.ID, ConversationID: e.ConversationID, State: state, DeadlineAt: e.DeadlineAt}, "reason", reason, "remote_outcome", e.RemoteOutcome, "previous_boundary", previousBoundary, "queue_wait_ms", s.Now.Sub(e.CreatedAt).Milliseconds(), "created_at", e.CreatedAt)
	}
	*events = append(*events, inferenceEvent{"experiment.outcome", slog.LevelInfo, []any{"operation_id", e.ID, "experiment_id", e.ID, "conversation_id", e.ConversationID, "worker_id", e.WorkerID, "state", e.State, "reason", reason, "remote_outcome", e.RemoteOutcome}})
}

func expire(s *inference.State, events *[]inferenceEvent) {
	if s.Pool != nil {
		for _, w := range s.Pool {
			expire(w, events)
		}
		s.ActiveCount = 0
		for _, e := range s.Experiments {
			if e.WorkerID == "" && !e.Terminal() && !s.Now.Before(e.DeadlineAt) {
				finish(s, e, "interrupted", "deadline_exceeded", events)
			}
			if !e.Terminal() {
				s.ActiveCount++
			}
		}
		return
	}
	if s.Connection.Connected && (s.Revoked || s.Connection.Status(s.Now) == "offline") {
		s.Connection.Connected = false
		reason := "health_reply_expired"
		if s.Revoked {
			reason = "worker_revoked"
		}
		event(events, slog.LevelInfo, "worker.connection_changed", s, nil, "connection_status", "offline", "reason", reason, "last_heartbeat_at", s.Connection.LastAckAt)
	}
	for _, e := range s.Experiments {
		if !e.Terminal() && !s.Now.Before(e.DeadlineAt) {
			finish(s, e, "interrupted", "deadline_exceeded", events)
		}
		if !e.Terminal() && s.Revoked {
			finish(s, e, "interrupted", "worker_revoked", events)
		}
	}
	for _, j := range s.Jobs {
		if j.State != "claimed" {
			continue
		}
		reason := ""
		if s.Connection.Status(s.Now) != "online" || j.ConnectionID != s.Connection.ID || j.ConnectionGeneration != s.Connection.Generation {
			reason = "worker_disconnected"
		} else if j.LeaseExpiresAt == nil || !s.Now.Before(*j.LeaseExpiresAt) {
			reason = "lease_expired"
		}
		if reason != "" {
			if e := s.Experiments[j.ExperimentID]; e != nil {
				finish(s, e, "interrupted", reason, events)
			}
		}
	}
}

func (b *Broker) run(ctx context.Context, logger *slog.Logger, ref inference.Ref, operation string, input any, action func(*inference.State, *[]inferenceEvent) (any, error)) (json.RawMessage, error) {
	started := b.now()
	if ref.Principal == "" {
		ref.Principal = "system"
		if ref.WorkerAuth != "" {
			ref.Principal = "worker:" + ref.WorkerAuth
		}
	}
	logger = logger.With("operation", operation, "protocol_version", inference.Version, "schema_version", postgres.SchemaVersion, "health_interval_seconds", 10, "health_window_seconds", 30, "max_context_bytes", inference.MaxContextBytes, "max_jobs", b.maxJobs)
	if ref.ClientID != "" {
		logger = logger.With("client_id", ref.ClientID, "requested_session_id", ref.SessionID)
	}
	if ref.Responses {
		logger = logger.With("requested_response_id", ref.ResponseID)
	}
	hash, err := inference.Hash(struct {
		Operation, Experiment, Job string
		Input                      any
	}{operation, ref.ExperimentID, ref.JobID, input})
	if err != nil {
		return nil, err
	}
	var result json.RawMessage
	var events []inferenceEvent
	var observed map[string]any
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	err = b.repo.WithinInference(bounded, ref, func(s *inference.State) error {
		expID := ref.ExperimentID
		if j := s.Jobs[ref.JobID]; j != nil {
			expID = j.ExperimentID
		}
		opID := expID
		if opID == "" {
			opID = s.Connection.ID
		}
		observed = map[string]any{"operation_id": opID, "experiment_id": expID, "worker_id": s.WorkerID, "connection_id": s.Connection.ID, "connection_generation": s.Connection.Generation, "connection_status": s.Connection.Status(s.Now), "authenticated_principal": ref.Principal}
		if e := s.Experiments[expID]; e != nil {
			observed["conversation_id"] = e.ConversationID
		}
		if r := s.Requests[expID]; r != nil {
			observed["client_id"], observed["session_id"], observed["request_record_id"] = r.ClientID, r.SessionID, r.ID
		}
		if j := s.Jobs[ref.JobID]; j != nil {
			observed["job_id"] = j.ID
			observed["generation"] = j.Generation
		}
		if s.Receipt != nil {
			if s.Receipt.InputHash != hash {
				return inference.Reject("submission_conflict", 409)
			}
			if operation == "claim" {
				if err := validateClaimReplay(s, s.Receipt.Result); err != nil {
					return err
				}
			}
			result = append(json.RawMessage{}, s.Receipt.Result...)
			events = append(events, inferenceEvent{"receipt.replayed", slog.LevelInfo, []any{"submission_id", ref.SubmissionID, "receipt_principal", ref.Principal, "reason", "identical_committed_submission", "job_id", ref.JobID}})
			if operation == "create" {
				var identity struct {
					ID             string `json:"id"`
					ConversationID string `json:"conversation_id"`
					JobID          string `json:"current_job_id"`
				}
				if err := json.Unmarshal(result, &identity); err != nil {
					return err
				}
				observed["operation_id"] = identity.ID
				observed["experiment_id"] = identity.ID
				observed["conversation_id"] = identity.ConversationID
				observed["job_id"] = identity.JobID
			}
			if operation == "request_create" {
				var view inference.RequestView
				if err := json.Unmarshal(result, &view); err != nil {
					return err
				}
				observed["operation_id"], observed["experiment_id"], observed["request_record_id"] = view.ID, view.ID, view.ID
				observed["conversation_id"], observed["session_id"] = view.ConversationID, view.SessionID
				events = append(events, inferenceEvent{"history.reconciled", slog.LevelInfo, []any{"operation_id", view.ID, "request_record_id", view.ID, "conversation_id", view.ConversationID, "client_id", ref.ClientID, "session_id", view.SessionID, "matched_from", 0, "matched_to", ref.HistoryInputCount, "appended_from", ref.HistoryInputCount, "appended_to", ref.HistoryInputCount, "reason", "submission_replay"}})
			}
			return nil
		}
		if !ref.Recovery {
			expire(s, &events)
		}
		value, err := action(s, &events)
		if err != nil {
			return err
		}
		switch v := value.(type) {
		case *inference.Experiment:
			expID = v.ID
			observed["conversation_id"] = v.ConversationID
		case *inference.Job:
			expID = v.ExperimentID
			observed["conversation_id"] = v.ConversationID
			observed["job_id"] = v.ID
		case inference.RequestView:
			expID = v.ID
			observed["conversation_id"], observed["session_id"], observed["request_record_id"], observed["worker_id"] = v.ConversationID, v.SessionID, v.ID, v.WorkerID
		}
		if r := s.Requests[expID]; r != nil {
			observed["client_id"], observed["session_id"], observed["request_record_id"] = r.ClientID, r.SessionID, r.ID
		}
		if err := syncHistory(s, events); err != nil {
			return err
		}
		observed["connection_id"] = s.Connection.ID
		if expID != "" {
			observed["operation_id"] = expID
			observed["experiment_id"] = expID
		} else {
			observed["operation_id"] = s.Connection.ID
		}
		result, err = json.Marshal(value)
		if err != nil {
			return err
		}
		if ref.SubmissionID != "" {
			s.Receipt = &inference.Receipt{Principal: ref.Principal, SubmissionID: ref.SubmissionID, InputHash: hash, Result: result}
		}
		return nil
	})
	var repositoryRejection *inference.Rejection
	if observed == nil && errors.As(err, &repositoryRejection) {
		if correlation, ok := repositoryRejection.Fields["correlation"].(map[string]any); ok {
			observed = map[string]any{"authenticated_principal": ref.Principal}
			for key, value := range correlation {
				observed[key] = value
			}
		}
	}
	if observed != nil {
		attrs := []any{}
		for key, value := range observed {
			if key == "operation_id" && value == "" {
				continue
			}
			attrs = append(attrs, key, value)
		}
		logger = logger.With(attrs...)
	} else {
		logger = logger.With("experiment_id", ref.ExperimentID, "job_id", ref.JobID, "worker_id", ref.WorkerID, "authenticated_principal", ref.Principal)
		if ref.ExperimentID != "" {
			logger = logger.With("operation_id", ref.ExperimentID)
		}
	}
	if operation != "poll" && operation != "sweep" && operation != "projection" && operation != "dispatch" {
		logger.Debug("inference.exchange", "correlation", observed, "input", input, "output", result, "requested_experiment_id", ref.ExperimentID, "requested_job_id", ref.JobID)
	}
	if err != nil {
		var rejection *inference.Rejection
		if errors.As(err, &rejection) {
			name := "lease.rejected"
			if ref.ClientID != "" {
				name = "history.conflict"
			}
			if rejection.Reason == "no_ready_worker" || rejection.Reason == "queue_full" {
				name = "dispatch.rejected"
			}
			if rejection.Reason == "session_worker_conflict" {
				name = "dispatch.pin_conflict"
			}
			if rejection.Reason == "history_owner_denied" {
				name = "history.owner_denied"
			}
			if ref.Responses {
				switch rejection.Reason {
				case "history_owner_denied", "session_reference_conflict", "response_not_completed", "stale_response_reference", "response_item_not_owned":
					name = "responses.reference_rejected"
				case "response_item_conflict", "history_prefix_conflict", "history_shortened_or_no_new_input", "tool_result_linkage_conflict", "invalid_tool_linkage", "session_busy":
					name = "responses.item_conflict"
				}
			}
			if operation == "decision" && rejection.Code == 400 {
				name = "decision.rejected"
			}
			if rejection.Reason == "stale_connection" || rejection.Reason == "stale_assignment" {
				name = "lease.fenced"
			}
			evidence := rejection.Fields
			if ref.Responses || name == "history.conflict" || (observed != nil && observed["client_id"] != nil && name != "history.owner_denied") {
				logger.Debug("history.conflict_detail", "reason", rejection.Reason, "evidence", evidence, "observed", observed)
				evidence = safeHistoryConflict(evidence)
			}
			logger.Warn(name, "requested_experiment_id", ref.ExperimentID, "requested_job_id", ref.JobID, "reason", rejection.Reason, "evidence", evidence, "observed", observed, "outcome", "rejected", "duration_ms", b.now().Sub(started).Milliseconds())
		} else {
			failure := postgres.Classify(err)
			logger.Debug("inference.storage_exchange", "cause", failure.Reason, "detail", failure.Detail(), "sqlstate", failure.SQLState, "transaction_outcome", failure.Outcome, "attempt", 1)
			name := "inference.operation_failed"
			if ref.Recovery {
				name = "recovery.failed"
			}
			logger.Error(name, "cause", failure.Reason, "sqlstate", failure.SQLState, "transaction_outcome", failure.Outcome, "attempt", 1, "duration_ms", b.now().Sub(started).Milliseconds(), "outcome", "operation_stopped")
		}
		return nil, err
	}
	for _, e := range events {
		logger.Log(ctx, e.level, e.name, append(e.fields, "transaction_outcome", "committed", "attempt", 1, "duration_ms", b.now().Sub(started).Milliseconds())...)
	}
	return result, nil
}

func (b *Broker) Projection(ctx context.Context, logger *slog.Logger, id string, workerAuth bool) (inference.Projection, error) {
	ref := inference.Ref{WorkerID: id, Principal: "management", CountPendingTools: true}
	if workerAuth {
		ref.WorkerAuth = id
		ref.Principal = "worker:" + id
	}
	var p inference.Projection
	_, err := b.run(ctx, logger, ref, "projection", nil, func(s *inference.State, _ *[]inferenceEvent) (any, error) { p = project(s); return p, nil })
	return p, err
}

func (b *Broker) Sweep(ctx context.Context, logger *slog.Logger) error {
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ids, err := b.repo.InferenceWorkers(bounded)
	if err != nil {
		failure := postgres.Classify(err)
		logger.Debug("inference.storage_exchange", "operation", "sweep", "cause", failure.Reason, "detail", failure.Detail(), "sqlstate", failure.SQLState, "transaction_outcome", failure.Outcome)
		logger.Error("inference.sweep_failed", "cause", failure.Reason, "sqlstate", failure.SQLState, "retry_delay_seconds", 1)
		return err
	}
	for _, id := range ids {
		_, err = b.run(ctx, logger, inference.Ref{WorkerID: id}, "sweep", nil, func(s *inference.State, _ *[]inferenceEvent) (any, error) { return project(s), nil })
		if err != nil {
			return err
		}
	}
	return b.Dispatch(ctx, logger)
}

func (b *Broker) Run(ctx context.Context, logger *slog.Logger) {
	for b.Wait(ctx, time.Second) == nil {
		if ctx.Err() != nil {
			return
		}
		_ = b.Sweep(ctx, logger)
	}
}

func (b *Broker) challenge(s *inference.State, events *[]inferenceEvent) error {
	if len(s.Connection.Challenges) > 0 && s.Now.Before(s.Connection.Challenges[len(s.Connection.Challenges)-1].IssuedAt.Add(inference.HealthInterval)) {
		return nil
	}
	id, err := auth.ID(b.random)
	if err != nil {
		return err
	}
	kept := []inference.Challenge{}
	for _, c := range s.Connection.Challenges {
		if s.Now.Before(c.IssuedAt.Add(inference.HealthWindow)) {
			kept = append(kept, c)
		}
	}
	s.Connection.Challenges = append(kept, inference.Challenge{ID: id, IssuedAt: s.Now})
	event(events, slog.LevelDebug, "worker.health_challenge", s, nil, "challenge", s.Connection.Challenges[len(kept)], "reply_window_seconds", 30)
	return nil
}

func connectionMatches(s *inference.State, id string, generation int64) error {
	if !s.Connection.Connected || s.Connection.ID != id || s.Connection.Generation != generation || s.Connection.Status(s.Now) == "offline" {
		return inference.Reject("stale_connection", 409, "expected_connection_id", s.Connection.ID, "expected_connection_generation", s.Connection.Generation, "observed_connection_id", id, "observed_connection_generation", generation)
	}
	return nil
}

func (b *Broker) Open(ctx context.Context, logger *slog.Logger, workerID string) (json.RawMessage, error) {
	return b.run(ctx, logger, inference.Ref{WorkerID: workerID, WorkerAuth: workerID}, "connect", nil, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if s.Connection.Connected {
			return nil, inference.Reject("subscriber_already_connected", 409)
		}
		id, err := auth.ID(b.random)
		if err != nil {
			return nil, err
		}
		s.Connection = inference.Connection{ID: id, Generation: s.Connection.Generation + 1, AssignmentGeneration: s.Connection.AssignmentGeneration, Connected: true, OpenedAt: s.Now}
		if err = b.challenge(s, events); err != nil {
			return nil, err
		}
		event(events, slog.LevelInfo, "worker.connection_changed", s, nil, "connection_status", "connecting")
		return s.Connection, nil
	})
}

func (b *Broker) Disconnect(ctx context.Context, logger *slog.Logger, workerID, id string, generation int64) error {
	_, err := b.run(ctx, logger, inference.Ref{WorkerID: workerID}, "disconnect", nil, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if s.Connection.ID == id && s.Connection.Generation == generation && s.Connection.Connected {
			s.Connection.Connected = false
			event(events, slog.LevelInfo, "worker.connection_changed", s, nil, "connection_status", "offline", "reason", "stream_closed")
			expire(s, events)
		}
		return project(s), nil
	})
	return err
}

type StreamEvent struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Data any    `json:"data"`
}

func (b *Broker) Poll(ctx context.Context, logger *slog.Logger, workerID, id string, generation int64) ([]StreamEvent, error) {
	var out []StreamEvent
	_, err := b.run(ctx, logger, inference.Ref{WorkerID: workerID, WorkerAuth: workerID}, "poll", nil, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if err := connectionMatches(s, id, generation); err != nil {
			return nil, err
		}
		if err := b.challenge(s, events); err != nil {
			return nil, err
		}
		c := s.Connection.Challenges[len(s.Connection.Challenges)-1]
		out = append(out, StreamEvent{ID: c.ID, Type: "health.challenge", Data: map[string]any{"protocol_version": 1, "connection_id": id, "connection_generation": generation, "challenge_id": c.ID, "issued_at": c.IssuedAt, "reply_deadline_at": c.IssuedAt.Add(inference.HealthWindow)}})
		if j := heldJob(s); j != nil && j.State != "claimed" {
			out = append(out, StreamEvent{ID: j.ID + ":" + j.State, Type: "job.cancelled", Data: map[string]any{"job_id": j.ID, "generation": j.Generation, "reason": j.Reason, "idle_ack_required": true}})
		}
		if project(s).WorkStatus == "idle" {
			jobs := []*inference.Job{}
			for _, j := range s.Jobs {
				if j.State == "queued" && nativeEligibility(s, j) == nil {
					jobs = append(jobs, j)
				}
			}
			sort.Slice(jobs, func(i, j int) bool {
				if jobs[i].CreatedAt.Equal(jobs[j].CreatedAt) {
					return jobs[i].ID < jobs[j].ID
				}
				return jobs[i].CreatedAt.Before(jobs[j].CreatedAt)
			})
			if len(jobs) > 0 {
				j := jobs[0]
				out = append(out, StreamEvent{ID: j.ID, Type: "job.available", Data: map[string]any{"job_id": j.ID, "experiment_id": j.ExperimentID, "conversation_id": j.ConversationID, "worker_id": workerID, "deadline_at": j.DeadlineAt}})
			}
		}
		return nil, nil
	})
	return out, err
}

func (b *Broker) Heartbeat(ctx context.Context, logger *slog.Logger, workerID string, h inference.Heartbeat) (json.RawMessage, error) {
	return b.run(ctx, logger, inference.Ref{WorkerID: workerID, WorkerAuth: workerID, CountPendingTools: true}, "heartbeat", h, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if h.Version != 1 {
			return nil, inference.Reject("unsupported_protocol_version", 400)
		}
		if err := connectionMatches(s, h.ConnectionID, h.Generation); err != nil {
			return nil, err
		}
		hash, err := inference.Hash(h)
		if err != nil {
			return nil, err
		}
		for i, c := range s.Connection.Challenges {
			if c.ID != h.ChallengeID || !s.Now.Before(c.IssuedAt.Add(inference.HealthWindow)) {
				continue
			}
			if c.ReplyHash != "" {
				if c.ReplyHash != hash {
					return nil, inference.Reject("challenge_reply_conflict", 409)
				}
				return project(s), nil
			}
			if h.IdleAck != nil {
				j := heldJob(s)
				if j == nil || j.State == "claimed" || h.IdleAck.JobID != j.ID || h.IdleAck.Generation != j.Generation || h.IdleAck.LeaseID != j.LeaseID {
					return nil, inference.Reject("idle_ack_mismatch", 409)
				}
				j.Held = false
				event(events, slog.LevelInfo, "worker.idle_confirmed", s, j, "idle_ack", h.IdleAck, "remote_outcome", "worker_reported_finished_or_stopped")
			}
			previous := s.Connection.Status(s.Now)
			s.Connection.Challenges[i].ReplyHash = hash
			s.Connection.LastAckAt = &s.Now
			if j := heldJob(s); j != nil && j.State == "claimed" {
				until := minTime(s.Now.Add(inference.HealthWindow), j.DeadlineAt)
				j.LeaseExpiresAt = &until
			}
			event(events, slog.LevelDebug, "worker.health_reply", s, nil, "challenge_id", h.ChallengeID, "round_trip_ms", s.Now.Sub(c.IssuedAt).Milliseconds(), "projection", project(s))
			if previous != "online" {
				event(events, slog.LevelInfo, "worker.connection_changed", s, nil, "connection_status", "online", "previous_status", previous)
			}
			return project(s), nil
		}
		return nil, inference.Reject("unknown_or_expired_challenge", 409)
	})
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
