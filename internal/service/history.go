package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func safeHistoryConflict(fields map[string]any) map[string]any {
	safe := map[string]any{}
	for _, key := range []string{"position", "expected_count", "observed_count", "expected_call_id", "observed_call_id", "expected_session_id", "observed_session_id", "expected_worker_id", "observed_worker_id", "conversation_id", "current_request_id", "expected_state", "observed_state", "expected_generation", "observed_generation", "expected_connection_id", "observed_connection_id", "expected_connection_generation", "observed_connection_generation", "expected_context_receipt", "observed_context_receipt", "transaction_outcome", "active_experiments", "max_jobs", "context_bytes", "max_context_bytes", "observed_response_id", "requested_item_id", "item_id"} {
		if value, ok := fields[key]; ok {
			safe[key] = value
		}
	}
	return safe
}

func (b *Broker) SubmitRequest(ctx context.Context, logger *slog.Logger, client, session string, input inference.RequestInput) (inference.RequestView, error) {
	return b.submitRequest(ctx, logger, client, session, input, nil)
}

func (b *Broker) submitRequest(ctx context.Context, logger *slog.Logger, client, session string, input inference.RequestInput, response *inference.ResponseMetadata) (inference.RequestView, error) {
	var view inference.RequestView
	if client == "" {
		return view, inference.Reject("model_client_required", 401)
	}
	validationWorker := input.WorkerID
	if validationWorker == "" {
		validationWorker = "automatic"
	}
	settings := inference.Create{Version: input.Version, SubmissionID: input.SubmissionID, WorkerID: validationWorker, Messages: []inference.Item{{Type: "message", Role: "user"}}, Tools: input.Tools, TimeoutSeconds: input.TimeoutSeconds}
	if err := inference.ValidateCreate(&settings); err != nil {
		logger.Warn("history.conflict", "client_id", client, "reason", err.Error())
		return view, err
	}
	input.TimeoutSeconds = settings.TimeoutSeconds
	if len(input.Messages) == 0 || (session != "" && !inference.Identifier.MatchString(session)) || (input.PreviousResponseID != "" && !inference.Identifier.MatchString(input.PreviousResponseID)) {
		return view, inference.Reject("invalid_history_identifiers_or_messages", 400)
	}
	if err := inference.CheckContext(input.Messages, input.Tools); err != nil {
		return view, err
	}
	replayInput := input
	replayInput.SubmissionID, replayInput.PreviousResponseID = "", ""
	var replayValue any = replayInput
	if response != nil {
		replayValue = struct {
			Input    inference.RequestInput
			Response *inference.ResponseMetadata
		}{replayInput, response}
	}
	replay, err := inference.Hash(replayValue)
	if err != nil {
		return view, err
	}
	ref := inference.Ref{WorkerID: input.WorkerID, ClientID: client, SessionID: session, ResponseID: input.PreviousResponseID, ReplayHash: replay, HistoryInputCount: len(input.Messages), Principal: "client:" + client, SubmissionID: input.SubmissionID, Admission: true, Full: true, Routing: true}
	ref.Responses = response != nil
	data, err := b.run(ctx, logger, ref, "request_create", struct {
		Session  string                      `json:"session_id"`
		Input    inference.RequestInput      `json:"input"`
		Response *inference.ResponseMetadata `json:"response_metadata,omitempty"`
	}{session, input, response}, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		c := s.Conversations[s.HistoryConversationID]
		if c != nil {
			for _, r := range s.Requests {
				if r.ConversationID == c.ID && r.ReplayHash == replay {
					e := s.Experiments[r.ID]
					j := &inference.Job{ExperimentID: r.ID, ConversationID: c.ID}
					if e != nil {
						j.ID = e.CurrentJobID
					}
					event(events, slog.LevelInfo, "history.reconciled", s, j, "client_id", client, "session_id", c.SessionID, "request_record_id", r.ID, "matched_from", 0, "matched_to", r.InputCount, "appended_from", c.ItemCount, "appended_to", c.ItemCount, "reason", "admitted_request_replay")
					return r.View(false), nil
				}
			}
			if r := s.Requests[c.CurrentRequestID]; r != nil && (r.State == "queued" || r.State == "inference") {
				return nil, inference.Reject("session_busy", 409, "conversation_id", c.ID, "current_request_id", r.ID, "observed_state", r.State)
			}
		}
		if response != nil {
			var err error
			input.Messages, err = responseHistory(c, s.Requests, input.Messages, response)
			if err != nil {
				return nil, err
			}
		}
		matched := 0
		if c != nil {
			matched = c.ItemCount
		}
		if err := reconcileHistory(c, input); err != nil {
			return nil, err
		}
		priorDecision := "none"
		if c != nil {
			if previous := s.Requests[c.CurrentRequestID]; previous != nil && previous.Output != nil {
				priorDecision = previous.Output.Type
			}
		}
		movable := movableConversation(s, c)
		allowed, evidence := candidates(s, c, input, movable, "")
		if len(allowed) == 0 {
			return nil, inference.Reject("no_ready_worker", 503, "candidates", evidence, "required_capabilities", inference.RequiredCapabilities(input.Messages, input.Tools), "max_jobs", b.maxJobs)
		}
		if s.ActiveCount >= b.maxJobs {
			return nil, inference.Reject("queue_full", 429, "active_experiments", s.ActiveCount, "max_jobs", b.maxJobs, "candidates", evidence)
		}

		id, err := auth.ID(b.random)
		if err != nil {
			return nil, err
		}
		responseID, err := auth.ID(b.random)
		if err != nil {
			return nil, err
		}
		if c == nil {
			cid, err := auth.ID(b.random)
			if err != nil {
				return nil, err
			}
			if session == "" {
				session, err = auth.ID(b.random)
				if err != nil {
					return nil, err
				}
			}
			c = &inference.Conversation{ID: cid, ClientID: client, SessionID: session, CreatedAt: s.Now}
			if s.Conversations == nil {
				s.Conversations = map[string]*inference.Conversation{}
			}
			s.Conversations[c.ID] = c
		}
		if s.Requests == nil {
			s.Requests = map[string]*inference.Request{}
		}
		r := &inference.Request{ID: id, ConversationID: c.ID, ClientID: client, SessionID: c.SessionID, WorkerID: c.WorkerID, ResponseID: "resp_" + responseID, CreatedAt: s.Now, State: "queued", ReassignAllowed: movable, ReplayHash: replay, Input: input, RequestedSession: ref.SessionID, InputCount: len(input.Messages), CanonicalEnd: len(input.Messages), Response: response}
		s.Requests[id] = r
		for _, item := range input.Messages[matched:] {
			if err = b.appendHistory(s, c, r.ID, "client_provided", item); err != nil {
				return nil, err
			}
		}
		c.CurrentRequestID, c.PendingCallID = id, ""
		e := &inference.Experiment{ID: id, ConversationID: c.ID, WorkerID: c.WorkerID, State: "queued", CreatedAt: s.Now, DeadlineAt: s.Now.Add(time.Duration(input.TimeoutSeconds) * time.Second), Messages: inference.RequestMessages(c, r), Tools: input.Tools, RemoteOutcome: "not_started"}
		if err = inference.CheckContext(e.Messages, e.Tools); err != nil {
			return nil, err
		}
		s.Experiments[id] = e

		if err = addTimeline(c, s.Now, id, "history.tools", "INFO", map[string]any{"tools": input.Tools}); err != nil {
			return nil, err
		}
		event(events, slog.LevelInfo, "history.reconciled", s, &inference.Job{ExperimentID: id, ConversationID: c.ID}, "client_id", client, "session_id", c.SessionID, "request_record_id", id, "matched_from", 0, "matched_to", matched, "appended_from", matched, "appended_to", c.ItemCount, "reason", "new_suffix", "tool_count", len(input.Tools))
		event(events, slog.LevelInfo, "dispatch.queued", s, &inference.Job{ExperimentID: id, ConversationID: c.ID, DeadlineAt: e.DeadlineAt}, "candidates", evidence, "active_experiments", s.ActiveCount+1, "max_jobs", b.maxJobs, "timeout_seconds", input.TimeoutSeconds, "worker_selection_constraint", input.WorkerID, "reassign_allowed", movable, "prior_decision_type", priorDecision, "required_capabilities", inference.RequiredCapabilities(input.Messages, input.Tools))
		if err = b.dispatch(s, events); err != nil {
			return nil, err
		}

		return r.View(false), nil
	})
	if err == nil {
		err = json.Unmarshal(data, &view)
	}
	return view, err
}

func reconcileHistory(c *inference.Conversation, input inference.RequestInput) error {
	matched := 0
	pending := ""
	calls := map[string]bool{}
	if c != nil {
		matched, pending = c.ItemCount, c.PendingCallID
		if len(input.Messages) <= matched {
			return inference.Reject("history_shortened_or_no_new_input", 409, "conversation_id", c.ID, "expected_count", matched, "observed_count", len(input.Messages), "expected_history", inference.Messages(c, matched), "observed_history", input.Messages)
		}
		for i, item := range c.Items {
			want, err := inference.Hash(item.Item)
			if err != nil {
				return err
			}
			got, err := inference.Hash(input.Messages[i])
			if err != nil {
				return err
			}
			if want != got {
				return inference.Reject("history_prefix_conflict", 409, "conversation_id", c.ID, "position", i, "expected_item", item, "observed_item", input.Messages[i])
			}
			if item.Item.Type == "tool_call" {
				calls[item.Item.CallID] = true
			}
		}
	}
	for _, item := range input.Messages[matched:] {
		switch item.Type {
		case "message":
			if pending != "" {
				return inference.Reject("tool_result_linkage_conflict", 409, "expected_call_id", pending, "observed_item", item)
			}
			if (item.Role != "system" && item.Role != "developer" && item.Role != "user" && item.Role != "assistant") || item.CallID != "" || item.Name != "" || item.Arguments != nil || item.Output != "" {
				return inference.Reject("invalid_message", 400)
			}
		case "tool_call":
			if pending != "" || calls[item.CallID] {
				return inference.Reject("invalid_tool_linkage", 409, "expected_call_id", pending, "observed_call_id", item.CallID)
			}
			if err := inference.ValidateDecision(item, input.Tools); err != nil {
				return err
			}
			pending, calls[item.CallID] = item.CallID, true
		case "tool_result":
			if pending == "" || item.CallID != pending {
				return inference.Reject("tool_result_linkage_conflict", 409, "expected_call_id", pending, "observed_call_id", item.CallID, "observed_result", item)
			}
			if item.Role != "" || item.Text != "" || item.Name != "" || item.Arguments != nil {
				return inference.Reject("invalid_tool_linkage", 400)
			}
			pending = ""
		default:
			return inference.Reject("unsupported_history_item", 400)
		}
	}
	if pending != "" {
		return inference.Reject("unresolved_initial_tool_call", 400, "expected_call_id", pending)
	}
	return nil
}

func addTimeline(c *inference.Conversation, now time.Time, requestID, kind, level string, details any) error {
	data, err := json.Marshal(details)
	if err != nil {
		return err
	}
	c.Events = append(c.Events, inference.TimelineEvent{Sequence: c.EventCount, Time: &now, Kind: kind, Level: level, RequestID: requestID, Details: data})
	c.EventCount++
	return nil
}

func (b *Broker) appendHistory(s *inference.State, c *inference.Conversation, requestID, source string, item inference.Item) error {
	id, err := auth.ID(b.random)
	if err != nil {
		return err
	}
	h := inference.HistoryItem{ID: id, Sequence: c.ItemCount, RequestID: requestID, Source: source, Time: s.Now, Item: item}
	c.Items = append(c.Items, h)
	c.ItemCount++
	return addTimeline(c, s.Now, requestID, "history.item", "INFO", map[string]any{"item_id": id, "source": source, "item_sequence": h.Sequence})
}

func (b *Broker) acceptHistory(s *inference.State, e *inference.Experiment, decision inference.Item) error {
	r := s.Requests[e.ID]
	if r == nil {
		return nil
	}
	c := s.Conversations[r.ConversationID]
	if decision.Type == "tool_call" {
		c.PendingCallID = decision.CallID
	}
	if err := b.appendHistory(s, c, e.ID, "server_observed", e.Messages[len(e.Messages)-1]); err != nil {
		return err
	}
	r.Output, r.DecisionAcceptedAt, r.CanonicalEnd = &decision, &s.Now, c.ItemCount
	e.State = "completed"
	return nil
}

func syncHistory(s *inference.State, events []inferenceEvent) error {
	for id, r := range s.Requests {
		if e := s.Experiments[id]; e != nil {
			r.State, r.Reason = e.State, e.Reason
		}
	}
	for _, e := range events {
		if e.level < slog.LevelInfo {
			continue
		}
		fields := map[string]any{}
		for i := 0; i+1 < len(e.fields); i += 2 {
			fields[e.fields[i].(string)] = e.fields[i+1]
		}
		id, _ := fields["experiment_id"].(string)
		if r := s.Requests[id]; r != nil {
			fields["client_id"], fields["session_id"], fields["request_record_id"] = r.ClientID, r.SessionID, id
			if err := addTimeline(s.Conversations[r.ConversationID], s.Now, id, e.name, e.level.String(), fields); err != nil {
				return err
			}
		}
	}
	return nil
}
