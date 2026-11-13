package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/openai"
)

func writeResponseError(w *response, err error) {
	status, reason, param := chatFailure(err)
	if param == "messages" {
		param = "input"
	}
	var native *inference.Rejection
	if errors.As(err, &native) {
		switch native.Reason {
		case "history_owner_denied", "response_not_completed", "stale_response_reference", "session_reference_conflict":
			param = "previous_response_id"
		case "response_item_not_owned", "response_item_conflict":
			param = "input"
		}
	}
	writeJSON(w, status, chatErrorValue(status, reason, param))
}

func (h *Handler) responsesRequest(w *response, r *http.Request, logger *slog.Logger, client string, body []byte) {
	value, err := openai.NormalizeResponse(body)
	logger.Debug("responses.input", "input", value.Admitted)
	if err != nil {
		_, reason, param := chatFailure(err)
		logger.Warn("responses.request_rejected", "reason", reason, "parameter", param, "outcome", "rejected")
		logger.Debug("responses.rejected_detail", "error", err)
		writeResponseError(w, err)
		return
	}
	value.Input.Input.SubmissionID = w.Header().Get("X-Request-Id")
	logger.Debug("responses.normalized_input", "input", value.Input, "stream", value.Stream)
	session, err := readSessionHeader(r)
	if err != nil {
		logger.Warn("responses.reference_rejected", "reason", err.Error(), "parameter", "X-Muse-Session-Id")
		writeResponseError(w, err)
		return
	}
	if h.Broker == nil {
		writeResponseError(w, errors.New("broker_unavailable"))
		return
	}
	controller := http.NewResponseController(w.ResponseWriter)
	if err = controller.SetWriteDeadline(h.Now().Add(305 * time.Second)); err != nil {
		logger.Error("responses.response_failed", "cause", "write_deadline_unavailable")
		writeResponseError(w, err)
		return
	}
	started := h.Now()
	last, cause, outcome := "admission", "", "failed"
	attemptedSequence, completedSequence := -1, -1
	var admitted inference.RequestView
	defer func() {
		level, name := slog.LevelInfo, "responses.request_terminated"
		if value.Stream {
			name = "responses.stream_terminated"
		}
		if outcome == "failed" || outcome == "uncertain" {
			level = slog.LevelError
		}
		logger.Log(r.Context(), level, name, "stream", value.Stream, "model", openai.Model, "last_event", last, "attempted_sequence", attemptedSequence, "completed_sequence", completedSequence, "cause", cause, "state", admitted.State, "disposition_scope", "last_observed", "output_accepted", admitted.Output != nil, "outcome", outcome, "attempted_bytes", w.attempted, "written_bytes", w.written, "attempt", 1, "duration_ms", h.Now().Sub(started).Milliseconds())
	}()
	admitted, err = h.Broker.SubmitResponse(r.Context(), logger, client, session, value.Input)
	if err != nil {
		status, reason, _ := chatFailure(err)
		cause = reason
		if status < 500 {
			outcome = "rejected"
		}
		writeResponseError(w, err)
		return
	}
	w.Header().Set("X-Muse-Session-Id", admitted.SessionID)
	w.workerID, w.conversationID, w.sessionID, w.requestRecordID = admitted.WorkerID, admitted.ConversationID, admitted.SessionID, admitted.ID
	logger = logger.With("operation_id", admitted.ID, "request_record_id", admitted.ID, "conversation_id", admitted.ConversationID, "session_id", admitted.SessionID, "response_id", admitted.ResponseID)
	logger.Info("responses.request_admitted", "model", openai.Model, "stream", value.Stream, "timeout_seconds", 300, "poll_interval_ms", 250, "write_timeout_seconds", 5, "state", admitted.State)
	last = "waiting"
	admitted, err = h.Broker.AwaitRequest(r.Context(), logger, client, admitted)
	w.workerID = admitted.WorkerID
	logger = logger.With("worker_id", admitted.WorkerID)
	failure := ""
	if err != nil {
		_, cause, _ = chatFailure(err)
		if r.Context().Err() != nil {
			outcome, cause = "client_aborted", "request_context_cancelled"
			var cleanupErr error
			admitted, cleanupErr = h.Broker.CancelChat(r.Context(), logger, client, admitted)
			if cleanupErr != nil {
				outcome, cause, w.boundaryFailed = "uncertain", "cancellation_failed", true
			}
			return
		}
		if !value.Stream || (admitted.State != "interrupted" && admitted.State != "cancelled") {
			writeResponseError(w, err)
			return
		}
		failure = cause
	}
	logger.Debug("responses.accepted_decision", "decision", admitted.Output, "metadata", admitted.Response)
	var frames []openai.Frame
	if value.Stream {
		frames, err = openai.ResponseFrames(admitted, failure)
	} else {
		var object map[string]any
		object, err = openai.ResponseObject(admitted, "completed", "")
		if err == nil {
			var encoded []byte
			encoded, err = json.Marshal(object)
			frames = []openai.Frame{{Kind: "response", Bytes: append(encoded, '\n')}}
		}
	}
	if err != nil {
		cause = "encoding_failed"
		writeResponseError(w, err)
		return
	}
	if err = h.Broker.OutputBoundary(r.Context(), logger, client, admitted.ID, false, 0, 0, ""); err != nil {
		cause = "output_boundary_failed"
		if r.Context().Err() != nil {
			outcome, cause = "client_aborted", "request_context_cancelled"
			return
		}
		writeResponseError(w, err)
		return
	}
	if value.Stream {
		w.capture, w.stream = false, true
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Accel-Buffering", "no")
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	for i, frame := range frames {
		attemptedSequence = i
		logger.Debug("responses.encoded_output", "sequence", i, "event", frame.Kind, "frame", string(frame.Bytes))
		err = r.Context().Err()
		if err == nil {
			_, err = w.Write(frame.Bytes)
			if err == nil {
				err = controller.Flush()
			}
		}
		if err != nil {
			w.writeErr = err
			cause, outcome = "response_write_failed", "uncertain"
			if r.Context().Err() != nil {
				outcome, cause = "client_aborted", "request_context_cancelled"
			}
			break
		}
		last, completedSequence = frame.Kind, i
	}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	writeCause := ""
	if w.writeErr != nil {
		writeCause = w.writeErr.Error()
	}
	if err = h.Broker.OutputBoundary(cleanup, logger, client, admitted.ID, true, w.attempted, w.written, writeCause); err != nil {
		w.boundaryFailed, cause, outcome = true, "output_completion_uncertain", "uncertain"
		return
	}
	if w.writeErr == nil {
		if failure == "" {
			outcome = "completed"
		} else {
			outcome = "failed"
		}
	}
}
