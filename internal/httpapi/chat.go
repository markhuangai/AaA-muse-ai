package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/openai"
)

func chatRoute(path string) bool {
	return path == "/v1/models" || path == "/v1/chat/completions" || path == "/v1/responses"
}

func chatErrorValue(status int, reason, param string) any {
	kind := "invalid_request_error"
	if status == 401 {
		kind = "authentication_error"
	} else if status == 429 {
		kind = "rate_limit_error"
	} else if status >= 500 {
		kind = "server_error"
	}
	var parameter any
	if param != "" {
		parameter = param
	}
	return map[string]any{"error": map[string]any{"message": strings.ReplaceAll(reason, "_", " "), "type": kind, "param": parameter, "code": reason}}
}

func chatFailure(err error) (int, string, string) {
	var boundary *openai.Error
	if errors.As(err, &boundary) {
		return boundary.Status, boundary.Code, boundary.Param
	}
	var native *inference.Rejection
	if errors.As(err, &native) {
		if native.Reason == "deadline_exceeded" {
			return 504, native.Reason, ""
		}
		if native.Code == 400 {
			return native.Code, native.Reason, "messages"
		}
		return native.Code, native.Reason, ""
	}
	return 503, "service_unavailable", ""
}

func writeChatError(w *response, err error) {
	status, reason, param := chatFailure(err)
	writeJSON(w, status, chatErrorValue(status, reason, param))
}

func (h *Handler) chatRequest(w *response, r *http.Request, logger *slog.Logger, client string, body []byte) {
	if r.URL.Path == "/v1/models" {
		writeJSON(w, 200, openai.Models())
		return
	}
	chat, err := openai.Normalize(body)
	if err != nil {
		_, reason, param := chatFailure(err)
		logger.Warn("chat.request_rejected", "reason", reason, "parameter", param, "capability", "text_and_single_function_call", "outcome", "rejected")
		logger.Debug("chat.rejected_detail", "error", err)
		writeChatError(w, err)
		return
	}
	chat.Input.SubmissionID = w.Header().Get("X-Request-Id")
	logger.Debug("chat.input", "input", chat.Admitted)
	logger.Debug("chat.normalized_input", "input", chat.Input, "stream", chat.Stream)
	session, err := readSessionHeader(r)
	if err != nil {
		logger.Warn("chat.history_conflict", "reason", err.Error(), "parameter", "X-Muse-Session-Id")
		writeChatError(w, err)
		return
	}
	if h.Broker == nil {
		writeChatError(w, errors.New("broker_unavailable"))
		return
	}
	controller := http.NewResponseController(w.ResponseWriter)
	if err = controller.SetWriteDeadline(h.Now().Add(305 * time.Second)); err != nil {
		logger.Error("chat.response_failed", "cause", "write_deadline_unavailable")
		writeChatError(w, err)
		return
	}
	started := h.Now()
	last, outcome, cause := "admission", "failed", ""
	var admitted inference.RequestView
	defer func() {
		level, event := slog.LevelInfo, "chat.request_terminated"
		if chat.Stream {
			event = "chat.stream_terminated"
		}
		if outcome == "failed" || outcome == "uncertain" {
			level = slog.LevelError
		}
		logger.Log(r.Context(), level, event, "stream", chat.Stream, "model", openai.Model, "last_event", last, "cause", cause, "job_disposition", admitted.State, "disposition_scope", "last_observed", "output_accepted", admitted.Output != nil, "outcome", outcome, "attempted_bytes", w.attempted, "written_bytes", w.written, "duration_ms", h.Now().Sub(started).Milliseconds())
	}()
	admitted, err = h.Broker.SubmitRequest(r.Context(), logger, client, session, chat.Input)
	if err != nil {
		status, reason, param := chatFailure(err)
		cause = reason
		if status < 500 {
			outcome = "rejected"
		}
		if status == 409 {
			logger.Warn("chat.history_conflict", "reason", reason, "parameter", param, "requested_session_id", session)
		}
		if status == 400 {
			logger.Warn("chat.request_rejected", "reason", reason, "parameter", param, "capability", "text_and_single_function_call", "outcome", "rejected")
		}
		writeChatError(w, err)
		return
	}
	w.Header().Set("X-Muse-Session-Id", admitted.SessionID)
	w.workerID, w.conversationID, w.sessionID, w.requestRecordID = admitted.WorkerID, admitted.ConversationID, admitted.SessionID, admitted.ID
	logger = logger.With("operation_id", admitted.ID, "request_record_id", admitted.ID, "conversation_id", admitted.ConversationID, "session_id", admitted.SessionID)
	logger.Info("chat.request_admitted", "model", openai.Model, "stream", chat.Stream, "timeout_seconds", 300, "poll_interval_ms", 250, "write_timeout_seconds", 5, "state", admitted.State)
	last = "waiting"
	admitted, err = h.Broker.AwaitRequest(r.Context(), logger, client, admitted)
	w.workerID = admitted.WorkerID
	logger = logger.With("worker_id", admitted.WorkerID)
	if err != nil {
		_, cause, _ = chatFailure(err)
		if r.Context().Err() != nil {
			outcome, cause = "client_aborted", "request_context_cancelled"
			var cleanupErr error
			admitted, cleanupErr = h.Broker.CancelChat(r.Context(), logger, client, admitted)
			if cleanupErr != nil {
				outcome, cause = "uncertain", "cancellation_failed"
				w.boundaryFailed = true
			}
			return
		}
		writeChatError(w, err)
		return
	}
	logger.Debug("chat.accepted_decision", "decision", admitted.Output)
	frames := []openai.Frame{}
	if chat.Stream {
		frames, err = openai.Frames(admitted)
	} else {
		var encoded []byte
		encoded, err = openai.Completion(admitted)
		frames = []openai.Frame{{Kind: "completion", Bytes: append(encoded, '\n')}}
	}
	if err != nil {
		cause = "encoding_failed"
		writeChatError(w, err)
		return
	}
	if err = h.Broker.OutputBoundary(r.Context(), logger, client, admitted.ID, false, 0, 0, ""); err != nil {
		cause = "output_boundary_failed"
		if r.Context().Err() != nil {
			outcome, cause = "client_aborted", "request_context_cancelled"
			return
		}
		writeChatError(w, err)
		return
	}
	if chat.Stream {
		w.capture, w.stream = false, true
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Accel-Buffering", "no")
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	for i, frame := range frames {
		logger.Debug("chat.encoded_output", "sequence", i, "event", frame.Kind, "frame", string(frame.Bytes))
		err = r.Context().Err()
		if err == nil {
			_, err = w.Write(frame.Bytes)
			if err == nil {
				err = controller.Flush()
			}
		}
		if err != nil {
			w.writeErr = err
			cause = "response_write_failed"
			outcome = "uncertain"
			if r.Context().Err() != nil {
				outcome, cause = "client_aborted", "request_context_cancelled"
			}
			if w.code == 0 && r.Context().Err() == nil {
				writeChatError(w, err)
			}
			break
		}
		last = frame.Kind
	}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	writeCause := ""
	if w.writeErr != nil {
		writeCause = w.writeErr.Error()
	}
	if err = h.Broker.OutputBoundary(cleanup, logger, client, admitted.ID, true, w.attempted, w.written, writeCause); err != nil {
		w.boundaryFailed = true
		cause = "output_completion_uncertain"
		outcome = "uncertain"
		return
	}
	if w.writeErr == nil {
		outcome = "completed"
	}
}
