package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

const workerPresenceRoute = "/api/v1/worker/jobs/{id}/presence"

func inferenceRoute(path string) (string, string) {
	switch path {
	case "/api/v1/admin/experiments", "/api/v1/worker/pull":
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
		if len(parts) == 1 && strings.Contains(prefix, "admin") {
			return base, parts[0]
		}
		if len(parts) == 2 && ((strings.Contains(prefix, "admin") && (parts[1] == "cancel" || parts[1] == "tool-results")) || (strings.Contains(prefix, "worker") && (parts[1] == "decisions" || parts[1] == "start" || parts[1] == "interrupt" || parts[1] == "presence"))) {
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
	case "/api/v1/worker/pull":
		var input inference.Pull
		err = decodeInferenceInput(body, &input, "protocol_version", "sequence", "checker_job_id", "checker_run_id", "scheduled_at", "entered_at", "media_jobs", "prompt_wav")
		if err == nil {
			var pulled inference.PullResult
			var contactErr error
			contact, contactErr := readWorkerContact(r)
			if contactErr != nil {
				err = contactErr
				break
			}
			contact.Incompatible = !h.Service.Build().Compatible(contact.Version)
			pulled, w.workerID, err = h.Broker.PullWork(r.Context(), logger, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), input, contact)
			if err == nil {
				writeJSON(w, code, pulled)
				return
			}
		}
	case "/api/v1/worker/jobs/{id}/start":
		var input inference.WorkStart
		err = decodeInferenceInput(body, &input, "protocol_version", "claim_id", "generation", "launch_id", "native_job_id")
		if err == nil {
			result, err = h.Broker.StartWork(r.Context(), logger, identity.ID, id, input)
		}
	case workerPresenceRoute:
		var input inference.BusyCheck
		err = decodeInferenceInput(body, &input, "protocol_version", "claim_id", "generation", "checker_job_id", "checker_run_id", "scheduled_at")
		if err == nil {
			var receipt inference.PresenceReceipt
			contact, contactErr := readWorkerContact(r)
			if contactErr != nil {
				err = contactErr
				break
			}
			receipt, w.workerID, err = h.Broker.BusyCheck(r.Context(), logger, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), id, input, contact)
			if err == nil {
				writeJSON(w, code, receipt)
				return
			}
		}
	case "/api/v1/worker/jobs/{id}/interrupt":
		var input inference.Interruption
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "claim_id", "generation", "launch_id", "native_job_id", "native_run_id", "reason")
		if err == nil {
			var evidence []inference.InterruptionEvidence
			if values := r.Header.Values("X-Muse-Interruption"); len(values) != 0 {
				status, failure, _ := strings.Cut(values[0], "/")
				observation := inference.InterruptionEvidence{NativeStatus: status, ResultFailure: failure}
				if len(values) != 1 || !observation.ValidNative() {
					err = inference.Reject("invalid_interruption_evidence", 400)
					break
				}
				logger.Debug("worker.interruption_evidence", "job_id", id, "claim_id", input.ClaimID,
					"native_job_id", input.NativeJob, "native_run_id", input.NativeRun, "submission_id", input.SubmissionID, "evidence", observation)
				evidence = append(evidence, observation)
			}
			result, err = h.Broker.InterruptWork(r.Context(), logger, identity.ID, id, input, evidence...)
		}
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
	case "/api/v1/worker/jobs/{id}/decisions":
		var input inference.Submit
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "connection_id", "connection_generation", "conversation_id", "generation", "lease_id", "context_receipt_id", "decision")
		if err == nil {
			result, err = h.Broker.Decide(r.Context(), logger, identity.ID, id, input)
		}
	}
	if err != nil {
		if route == "/api/v1/admin/experiments/{id}/cancel" {
			cause, state := "service_unavailable", "unknown"
			outcome, remote := "unknown", "unknown"
			var busy any = "unknown"
			fields := []any{"operation_id", id}
			var rejected *inference.Rejection
			if errors.As(err, &rejected) {
				cause = rejected.Reason
				if observed, ok := rejected.Fields["observed_state"].(string); ok {
					state = observed
				}
				if value, ok := rejected.Fields["transaction_outcome"].(string); ok {
					outcome = value
				}
				if value, ok := rejected.Fields["remote_outcome"].(string); ok {
					remote = value
				}
				if value, ok := rejected.Fields["busy_hold"].(bool); ok {
					busy = value
				}
				for _, key := range []string{"conversation_id", "worker_id", "job_id"} {
					if value, ok := rejected.Fields[key].(string); ok {
						fields = append(fields, key, value)
					}
				}
			}
			fields = append(fields, "request_record_id", id, "requested_state", "cancelled", "observed_state", state, "cause", cause,
				"transaction_outcome", outcome, "remote_outcome", remote, "busy_hold", busy, "outcome", "not_confirmed")
			logger.Warn("portal.cancel_result", fields...)
		}
		logger.Warn("request.rejected", "reason", err.Error(), "admitted_body_bytes", len(body))
		inferenceError(w, err)
		return
	}
	writeJSON(w, code, result)
	if route == "/api/v1/worker/jobs/{id}/start" {
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
