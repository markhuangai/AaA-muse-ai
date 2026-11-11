package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func inferenceRoute(path string) (string, string) {
	switch path {
	case "/api/v1/admin/experiments", "/api/v1/worker/events", "/api/v1/worker/heartbeat":
		return path, ""
	}
	for _, prefix := range []string{"/api/v1/admin/experiments/", "/api/v1/worker/jobs/"} {
		if !strings.HasPrefix(path, prefix) {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
		if !workerIDPattern.MatchString(parts[0]) {
			break
		}
		base := strings.TrimSuffix(prefix, "/") + "/{id}"
		if len(parts) == 1 {
			return base, parts[0]
		}
		if len(parts) == 2 && ((strings.Contains(prefix, "admin") && (parts[1] == "cancel" || parts[1] == "tool-results")) || (strings.Contains(prefix, "worker") && (parts[1] == "claim" || parts[1] == "decisions"))) {
			return base + "/" + parts[1], parts[0]
		}
	}
	return "unmatched", ""
}

func inferenceError(w http.ResponseWriter, err error) {
	code, reason := 503, "service_unavailable"
	var rejected *inference.Rejection
	if errors.As(err, &rejected) {
		code, reason = rejected.Code, rejected.Reason
	}
	if code == 401 {
		w.Header().Set("WWW-Authenticate", "Bearer")
	}
	writeJSON(w, code, map[string]any{"error": reason})
}

func decodeInferenceInput(body []byte, out any, required ...string) error {
	if err := inference.Decode(body, out); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return err
	}
	for _, key := range required {
		if v, ok := fields[key]; !ok || string(v) == "null" {
			return inference.Reject("required_field_missing", 400)
		}
	}
	return nil
}

func (h *Handler) inferenceRequest(w *response, r *http.Request, logger *slog.Logger, route, id string, identity workerView, body []byte) {
	if h.Broker == nil {
		inferenceError(w, errors.New("broker_unavailable"))
		return
	}
	if route == "/api/v1/worker/events" {
		h.subscribe(w, r, logger, identity.ID)
		return
	}
	var result json.RawMessage
	var err error
	code := 200
	if len(body) > 0 {
		var admitted any
		if decodeErr := inference.Decode(body, &admitted); decodeErr == nil {
			logger.Debug("request.inference_input", "input", admitted)
		}
	}
	switch route {
	case "/api/v1/admin/experiments":
		var input inference.Create
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "worker_id", "messages", "tools")
		if err == nil {
			result, err = h.Broker.Create(r.Context(), logger, input)
			code = 201
		}
	case "/api/v1/admin/experiments/{id}":
		result, err = h.Broker.Read(r.Context(), logger, id)
	case "/api/v1/admin/experiments/{id}/cancel":
		var input inference.Cancel
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id")
		if err == nil {
			result, err = h.Broker.Cancel(r.Context(), logger, id, input)
		}
	case "/api/v1/admin/experiments/{id}/tool-results":
		var input inference.ToolResult
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "call_id", "output")
		if err == nil {
			result, err = h.Broker.ToolResult(r.Context(), logger, id, input)
			code = 202
		}
	case "/api/v1/worker/heartbeat":
		var input inference.Heartbeat
		err = decodeInferenceInput(body, &input, "protocol_version", "connection_id", "connection_generation", "challenge_id")
		if err == nil {
			result, err = h.Broker.Heartbeat(r.Context(), logger, identity.ID, input)
		}
	case "/api/v1/worker/jobs/{id}":
		result, err = h.Broker.Job(r.Context(), logger, identity.ID, id)
	case "/api/v1/worker/jobs/{id}/claim":
		var input inference.Claim
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "connection_id", "connection_generation")
		if err == nil {
			result, err = h.Broker.Claim(r.Context(), logger, identity.ID, id, input)
		}
	case "/api/v1/worker/jobs/{id}/decisions":
		var input inference.Submit
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "connection_id", "connection_generation", "conversation_id", "generation", "lease_id", "context_receipt_id", "decision")
		if err == nil {
			result, err = h.Broker.Decide(r.Context(), logger, identity.ID, id, input)
		}
	}
	if err != nil {
		logger.Warn("request.rejected", "reason", err.Error(), "admitted_body_bytes", len(body))
		inferenceError(w, err)
		return
	}
	writeJSON(w, code, result)
	if route == "/api/v1/worker/jobs/{id}" || route == "/api/v1/worker/jobs/{id}/claim" {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		defer cancel()
		cause := ""
		if w.writeErr != nil {
			cause = w.writeErr.Error()
		}
		if err := h.Broker.DeliveryFinished(cleanup, logger, identity.ID, id, w.attempted, w.written, cause); err != nil {
			w.boundaryFailed = true
		}
	}
}

func (w *response) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (h *Handler) subscribe(w *response, r *http.Request, logger *slog.Logger, workerID string) {
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(h.Now().Add(5 * time.Second)); err != nil {
		inferenceError(w, err)
		return
	}
	data, err := h.Broker.Open(r.Context(), logger, workerID)
	if err != nil {
		inferenceError(w, err)
		return
	}
	var connection inference.Connection
	if err = json.Unmarshal(data, &connection); err != nil {
		inferenceError(w, err)
		return
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		defer cancel()
		if err := h.Broker.Disconnect(cleanup, logger, workerID, connection.ID, connection.Generation); err != nil {
			logger.Error("worker.disconnect_failed", "cause", err.Error(), "connection_id", connection.ID)
		}
	}()
	w.capture = false
	w.stream = true
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	send := func(e service.StreamEvent) error {
		payload, err := json.Marshal(e.Data)
		if err != nil {
			return err
		}
		frame := fmt.Sprintf("id: %s\nevent: %s\ndata: %s\n\n", e.ID, e.Type, payload)
		logger.Debug("request.sse_event", "worker_id", workerID, "operation_id", connection.ID, "event_id", e.ID, "event_type", e.Type, "payload", e.Data, "attempted_bytes", len(frame))
		if err = controller.SetWriteDeadline(h.Now().Add(5 * time.Second)); err != nil {
			return err
		}
		if _, err = w.Write([]byte(frame)); err != nil {
			return err
		}
		return controller.Flush()
	}
	if err = send(service.StreamEvent{ID: connection.ID, Type: "connection.opened", Data: map[string]any{"protocol_version": 1, "connection_id": connection.ID, "connection_generation": connection.Generation, "health_interval_seconds": 10, "health_window_seconds": 30}}); err != nil {
		w.writeErr = err
		return
	}
	seen := map[string]bool{}
	for {
		events, err := h.Broker.Poll(r.Context(), logger, workerID, connection.ID, connection.Generation)
		if err != nil {
			logger.Warn("worker.stream_closed", "worker_id", workerID, "connection_id", connection.ID, "reason", err.Error())
			return
		}
		current := map[string]bool{}
		for _, e := range events {
			current[e.ID] = true
			if !seen[e.ID] {
				if err = send(e); err != nil {
					w.writeErr = err
					return
				}
			}
		}
		seen = current
		if h.Broker.Wait(r.Context(), time.Second) != nil {
			return
		}
	}
}
