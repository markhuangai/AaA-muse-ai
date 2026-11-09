package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

var workerIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func routeFor(path string) (string, string) {
	switch path {
	case "/healthz", "/readyz", "/api/v1/admin/status", "/api/v1/admin/diagnostics/export", "/api/v1/admin/enrollments", "/api/v1/worker/enroll", "/api/v1/admin/workers", "/api/v1/worker/status":
		return path, ""
	}
	if strings.HasPrefix(path, "/api/v1/admin/workers/") {
		parts := strings.Split(strings.TrimPrefix(path, "/api/v1/admin/workers/"), "/")
		if workerIDPattern.MatchString(parts[0]) {
			if len(parts) == 1 {
				return "/api/v1/admin/workers/{id}", parts[0]
			}
			if len(parts) == 2 && parts[1] == "revoke" {
				return "/api/v1/admin/workers/{id}/revoke", parts[0]
			}
		}
	}
	return "unmatched", ""
}

func routeMethod(route string) string {
	switch route {
	case "/api/v1/admin/enrollments", "/api/v1/worker/enroll", "/api/v1/admin/workers/{id}/revoke":
		return http.MethodPost
	case "/api/v1/admin/workers/{id}":
		return http.MethodPatch
	default:
		return http.MethodGet
	}
}

type workerView struct {
	worker.Record
	ConnectionStatus   string `json:"connection_status"`
	InferenceReadiness string `json:"inference_readiness"`
}

func viewWorker(w worker.Record) workerView {
	w.Name = diagnostics.RedactWorkerSecrets(w.Name)
	return workerView{Record: w, ConnectionStatus: "not_observed", InferenceReadiness: "unverified"}
}

func workerError(w http.ResponseWriter, err error) {
	code, reason := 503, "service_unavailable"
	var rejected *worker.Rejection
	if errors.As(err, &rejected) {
		reason = rejected.Reason
		switch reason {
		case "worker_not_found":
			code = 404
		case "enrollment_used":
			code = 409
		case "enrollment_expired":
			code = 410
		case "worker_revoked", "invalid_worker_credential":
			code, reason = 401, "unauthorized"
			w.Header().Set("WWW-Authenticate", "Bearer")
		default:
			code = 400
		}
	}
	writeJSON(w, code, map[string]any{"error": reason})
}

func decodeWorkerInput(body []byte, field string) (map[string]any, error) {
	result := map[string]any{}
	if len(body) == 0 && field == "" {
		return result, nil
	}
	if !utf8.Valid(body) {
		return nil, errors.New("invalid_json")
	}
	d := json.NewDecoder(bytes.NewReader(body))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return nil, errors.New("json_object_required")
	}
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return nil, errors.New("invalid_json")
		}
		if key != field || field == "" {
			return nil, errors.New("unsupported_field")
		}
		if _, exists := result[field]; exists {
			return nil, errors.New("duplicate_field")
		}
		var value any
		if err := d.Decode(&value); err != nil {
			return nil, errors.New("invalid_json")
		}
		text, ok := value.(string)
		if !ok {
			return nil, errors.New("string_required")
		}
		result[field] = text
	}
	if _, err = d.Token(); err != nil {
		return nil, errors.New("invalid_json")
	}
	var extra any
	if !errors.Is(d.Decode(&extra), io.EOF) {
		return nil, errors.New("single_object_required")
	}
	if field != "" && result[field] == nil {
		return nil, errors.New("required_field_missing")
	}
	return result, nil
}

func (h *Handler) workerRequest(w *response, r *http.Request, logger *slog.Logger, route, id string, identity workerView, body []byte) {
	if h.Workers == nil {
		writeJSON(w, 503, map[string]any{"error": "service_unavailable"})
		return
	}
	field := ""
	if route == "/api/v1/worker/enroll" {
		field = "enrollment_code"
	} else if route == "/api/v1/admin/workers/{id}" {
		field = "name"
	}
	input, err := decodeWorkerInput(body, field)
	if err != nil {
		logger.Warn("request.rejected", "reason", err.Error(), "omitted_body_bytes", len(body))
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	logger.Debug("request.worker_input", "input", input, "requested_worker_id", id)
	switch route {
	case "/api/v1/admin/enrollments":
		e, code, err := h.Workers.Issue(r.Context(), logger)
		w.enrollmentID = e.ID
		if err != nil {
			workerError(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{"enrollment_id": e.ID, "enrollment_code": code, "created_at": e.CreatedAt, "expires_at": e.ExpiresAt})
	case "/api/v1/worker/enroll":
		record, e, credential, err := h.Workers.Enroll(r.Context(), logger, input[field].(string))
		w.workerID, w.enrollmentID = record.ID, e.ID
		if err != nil {
			workerError(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{"worker": viewWorker(record), "credential": credential})
	case "/api/v1/admin/workers":
		records, err := h.Workers.List(r.Context(), logger)
		if err != nil {
			workerError(w, err)
			return
		}
		workers := make([]workerView, 0, len(records))
		for _, record := range records {
			workers = append(workers, viewWorker(record))
		}
		writeJSON(w, 200, map[string]any{"workers": workers})
	case "/api/v1/worker/status":
		writeJSON(w, 200, identity)
	case "/api/v1/admin/workers/{id}":
		record, err := h.Workers.Rename(r.Context(), logger, id, input[field].(string))
		w.workerID = id
		if err != nil {
			workerError(w, err)
			return
		}
		writeJSON(w, 200, viewWorker(record))
	case "/api/v1/admin/workers/{id}/revoke":
		record, err := h.Workers.Revoke(r.Context(), logger, id)
		w.workerID = id
		if err != nil {
			workerError(w, err)
			return
		}
		writeJSON(w, 200, viewWorker(record))
	}
}
