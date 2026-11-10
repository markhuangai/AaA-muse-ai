package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

const MaxBodyBytes = 1024 * 1024

type Exporter interface {
	Snapshot(diagnostics.Filter) (diagnostics.Snapshot, error)
}
type Handler struct {
	Service   *service.Service
	Workers   *service.Workers
	Setup     *service.Setup
	Broker    *service.Broker
	Authority *auth.Authority
	Exporter  Exporter
	Logger    *slog.Logger
	Random    io.Reader
	Now       func() time.Time
	Failed    <-chan struct{}
}

type response struct {
	http.ResponseWriter
	code                   int
	body                   bytes.Buffer
	capture                bool
	stream                 bool
	attempted, written     int
	writeErr               error
	workerID, enrollmentID string
}

func (w *response) WriteHeader(code int) {
	if w.code != 0 {
		return
	}
	w.code = code
	w.ResponseWriter.WriteHeader(code)
}
func (w *response) Write(b []byte) (int, error) {
	if w.code == 0 {
		w.WriteHeader(200)
	}
	n, err := w.ResponseWriter.Write(b)
	w.attempted += len(b)
	w.written += n
	if err != nil {
		w.writeErr = err
	}
	if w.capture {
		w.body.Write(b)
	}
	return n, err
}

func (h *Handler) ServeHTTP(out http.ResponseWriter, r *http.Request) {
	started := h.Now()
	id, err := auth.ID(h.Random)
	if err != nil {
		h.Logger.Error("request.rejected", "cause", "identifier_generation_failed")
		writeJSON(out, 503, map[string]any{"error": "service_unavailable"})
		return
	}
	out.Header().Set("X-Request-Id", id)
	out.Header().Set("Cache-Control", "no-store")
	route, requestedWorker := routeFor(r.URL.Path)
	logger := h.Logger.With("request_id", id, "route", route)
	w := &response{ResponseWriter: out, capture: route != "/api/v1/admin/diagnostics/export"}
	role := h.Authority.Role(r.Header.Get("Authorization"))
	defer func() {
		logger = logger.With("worker_id", w.workerID, "enrollment_id", w.enrollmentID)
		outcome, detail := "completed", ""
		if w.writeErr != nil {
			outcome, detail = "interrupted", w.writeErr.Error()
			logger.Warn("request.write_failed", "cause", "client_write_failed", "attempted_bytes", w.attempted, "written_bytes", w.written)
		}
		captureKind := "full_attempted"
		if !w.capture {
			captureKind = "retained_snapshot_reference"
		}
		if w.stream {
			captureKind = "per_event"
		}
		logger.Debug("request.exchange", "method", r.Method, "role", role, "status", w.code, "response", w.body.String(), "response_capture", captureKind, "outcome", outcome, "write_error", detail, "attempted_bytes", w.attempted, "written_bytes", w.written)
		logger.Info("request.completed", "method", r.Method, "role", role, "status", w.code, "outcome", outcome, "duration_ms", h.Now().Sub(started).Milliseconds())
	}()
	if route == "unmatched" {
		writeJSON(w, 404, map[string]any{"error": "not_found"})
		return
	}
	expectedRole := ""
	if strings.HasPrefix(route, "/api/v1/admin/") {
		expectedRole = "management"
	} else if strings.HasPrefix(route, "/api/v1/worker/") && route != "/api/v1/worker/enroll" {
		expectedRole = "worker"
	}
	var identity workerView
	if expectedRole != "" {
		credential := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if role == "unauthenticated" && strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") && strings.HasPrefix(credential, auth.WorkerPrefix) && h.Workers != nil {
			record, err := h.Workers.Authenticate(r.Context(), logger, credential)
			w.workerID = record.ID
			if err != nil {
				workerError(w, err)
				return
			}
			role, identity = "worker", viewWorker(record)
		}
		if role != expectedRole {
			event := "auth.denied"
			if strings.HasPrefix(route, "/api/v1/worker/") || route == "/api/v1/admin/enrollments" || strings.HasPrefix(route, "/api/v1/admin/workers") {
				event = "worker.auth_denied"
			}
			if role == "worker" && strings.HasPrefix(route, "/api/v1/admin/workers/") && requestedWorker != "" && requestedWorker != identity.ID {
				event = "worker.scope_denied"
			}
			logger.Warn(event, "expected_role", expectedRole, "observed_role", role, "authenticated_worker_id", identity.ID, "requested_worker_id", requestedWorker, "reason", "role_not_permitted")
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeJSON(w, 401, map[string]any{"error": "unauthorized"})
			return
		}
	}
	method := routeMethod(route)
	if r.Method != method {
		w.Header().Set("Allow", method)
		writeJSON(w, 405, map[string]any{"error": "method_not_allowed"})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			logger.Warn("request.rejected", "reason", "body_too_large", "max_bytes", MaxBodyBytes)
			writeJSON(w, 413, map[string]any{"error": "body_too_large"})
		} else {
			writeJSON(w, 400, map[string]any{"error": "invalid_body"})
		}
		return
	}
	if r.Method == http.MethodGet && len(body) > 0 {
		logger.Warn("request.rejected", "reason", "get_body_unsupported", "omitted_body_bytes", len(body))
		writeJSON(w, 400, map[string]any{"error": "get_body_unsupported"})
		return
	}
	if route != "/api/v1/admin/diagnostics/export" && len(r.URL.Query()) != 0 {
		writeJSON(w, 400, map[string]any{"error": "unsupported_query"})
		return
	}
	logger.Debug("request.admitted", "method", r.Method, "role", role, "body_bytes", len(body))
	select {
	case <-h.Failed:
		writeJSON(w, 503, map[string]any{"error": "diagnostics_unavailable"})
		return
	default:
	}
	switch route {
	case "/healthz":
		writeJSON(w, 200, map[string]any{"status": "alive"})
	case "/readyz":
		status := h.Service.Status(r.Context(), logger)
		code := 200
		if !status.Ready {
			code = 503
		}
		writeJSON(w, code, map[string]any{"ready": status.Ready, "database": status.Database, "schema_version": status.SchemaVersion})
	case "/api/v1/admin/status":
		writeJSON(w, 200, h.Service.Status(r.Context(), logger))
	case "/api/v1/admin/diagnostics/export":
		h.export(w, r, logger)
	case "/api/v1/admin/setup-prompts":
		h.setupRequest(w, r, logger, body)
	default:
		if strings.Contains(route, "/experiments") || route == "/api/v1/worker/events" || route == "/api/v1/worker/heartbeat" || strings.HasPrefix(route, "/api/v1/worker/jobs/") {
			h.inferenceRequest(w, r, logger, route, requestedWorker, identity, body)
		} else {
			h.workerRequest(w, r, logger, route, requestedWorker, identity, body)
		}
	}
}

func writeJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

var opaqueID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func parseFilter(r *http.Request) (diagnostics.Filter, error) {
	var f diagnostics.Filter
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return f, errors.New("invalid_query")
	}
	for key, v := range values {
		if len(v) != 1 {
			return f, errors.New("duplicate_filter")
		}
		switch key {
		case "since":
			f.Since, err = time.Parse(time.RFC3339Nano, v[0])
		case "until":
			f.Until, err = time.Parse(time.RFC3339Nano, v[0])
		case "request_id":
			if !opaqueID.MatchString(v[0]) {
				return f, errors.New("invalid_identifier")
			}
			f.RequestID = v[0]
		case "operation_id":
			if !opaqueID.MatchString(v[0]) {
				return f, errors.New("invalid_identifier")
			}
			f.OperationID = v[0]
		default:
			return f, errors.New("unsupported_filter")
		}
		if err != nil {
			return f, errors.New("invalid_timestamp")
		}
	}
	if !f.Since.IsZero() && !f.Until.IsZero() && f.Since.After(f.Until) {
		return f, errors.New("invalid_interval")
	}
	return f, nil
}

func (h *Handler) export(w http.ResponseWriter, r *http.Request, logger *slog.Logger) {
	filter, err := parseFilter(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	logger.Debug("diagnostics.export_requested", "since", filter.Since, "until", filter.Until, "request_filter", filter.RequestID, "operation_filter", filter.OperationID)
	snapshot, err := h.Exporter.Snapshot(filter)
	if err != nil {
		logger.Error("diagnostics.export_failed", "cause", "capture_read_failed")
		writeJSON(w, 503, map[string]any{"error": "diagnostics_unavailable"})
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	if err = json.NewEncoder(w).Encode(snapshot.Metadata); err != nil {
		return
	}
	for _, b := range snapshot.Records {
		if _, err = w.Write(b); err != nil {
			return
		}
	}
	logger.Info("diagnostics.export_completed", "snapshot_at", snapshot.Metadata.SnapshotAt, "captures", snapshot.Metadata.Captures, "complete", snapshot.Metadata.Complete, "omissions", snapshot.Metadata.Omissions)
}
