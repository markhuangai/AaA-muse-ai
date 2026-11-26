package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

var workerIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

const workerUpgradeRoute = "/api/v1/worker/upgrade-reservation"

func routeFor(path string) (string, string) {
	if route, id := mediaRoute(path); route != "" {
		return route, id
	}
	switch path {
	case "/api/v1/portal/login", "/api/v1/portal/logout", "/api/v1/portal/session", "/api/v1/portal/settings", "/api/v1/portal/events", "/api/v1/portal/client-keys":
		return path, ""
	case mcpRoute, "/v1/models", "/v1/chat/completions", "/v1/responses", "/healthz", "/readyz", "/api/v1/admin/status", "/api/v1/admin/diagnostics/export", "/api/v1/admin/enrollments", "/api/v1/admin/setup-prompts", "/api/v1/worker/enroll", "/api/v1/admin/workers", "/api/v1/worker/status", workerUpdateRoute:
		return path, ""
	}
	if strings.HasPrefix(path, adminWorkerPrefix) {
		parts := strings.Split(strings.TrimPrefix(path, adminWorkerPrefix), "/")
		if workerIDPattern.MatchString(parts[0]) {
			if route := adminWorkerControlRoute(parts); route != "" {
				return route, parts[0]
			}
			if len(parts) == 1 {
				return "/api/v1/admin/workers/{id}", parts[0]
			}
			if len(parts) == 2 && parts[1] == "qualifications" {
				return "/api/v1/admin/workers/{id}/qualifications", parts[0]
			}
			if len(parts) == 2 && parts[1] == "revoke" {
				return "/api/v1/admin/workers/{id}/revoke", parts[0]
			}
		}
	}
	if route, id := historyRoute(path); route != "unmatched" {
		return route, id
	}
	if route, id := workerControlRoute(path); route != "" {
		return route, id
	}
	return inferenceRoute(path)
}

func routeAllows(route, method string) bool {
	for _, allowed := range strings.Split(routeAllowHeader(route), ", ") {
		if method == allowed {
			return true
		}
	}
	return false
}

func routeAllowHeader(route string) string {
	switch route {
	case opsRoute, tasksRoute:
		return "GET, POST"
	case opCancelRoute, taskCancelRoute, workerOpResult, taskBindRoute, taskStartRoute, taskPresenceRoute, taskResultRoute, taskInterruptRoute:
		return http.MethodPost
	case mediaJobs, mediaTrials, mcpRoute:
		return http.MethodPost
	case workerMediaArtifact:
		return http.MethodPut
	case "/api/v1/portal/login", "/api/v1/portal/logout", "/api/v1/portal/events", "/api/v1/portal/client-keys":
		return http.MethodPost
	case "/v1/chat/completions", "/v1/responses", "/api/v1/admin/workers/{id}/qualifications", "/api/v1/admin/enrollments", "/api/v1/admin/setup-prompts", "/api/v1/worker/enroll", "/api/v1/admin/workers/{id}/revoke":
		return http.MethodPost
	case "/api/v1/admin/workers/{id}":
		return http.MethodPatch
	case "/api/v1/requests", "/api/v1/requests/{id}/cancel", "/api/v1/admin/experiments", "/api/v1/admin/experiments/{id}/cancel", "/api/v1/admin/experiments/{id}/tool-results", "/api/v1/worker/jobs/{id}/decisions", workerPullRoute, "/api/v1/worker/jobs/{id}/start", "/api/v1/worker/jobs/{id}/interrupt", workerPresenceRoute, workerUpdateRoute, workerBindRoute:
		return http.MethodPost
	default:
		return http.MethodGet
	}
}

func (h *Handler) setupRequest(w *response, r *http.Request, logger *slog.Logger, body []byte) {
	input, err := decodeWorkerInput(body, "origin")
	if err != nil {
		logger.Warn("setup.origin_rejected", "cause", "origin_body_required", "omitted_body_bytes", len(body), "outcome", "not_started")
		writeJSON(w, 400, map[string]any{"error": service.ErrSetupOrigin.Error()})
		return
	}
	if h.Setup == nil {
		writeJSON(w, 503, map[string]any{"error": "service_unavailable"})
		return
	}
	result, err := h.Setup.Create(r.Context(), logger, input["origin"].(string))
	w.enrollmentID = result.EnrollmentID
	if errors.Is(err, service.ErrSetupOrigin) {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if errors.Is(err, service.ErrWorkerPackageUnconfigured) {
		writeJSON(w, 503, map[string]any{"error": err.Error()})
		return
	}
	if err != nil {
		workerError(w, err)
		return
	}
	writeJSON(w, 201, result)
}

type workerView struct {
	worker.Record
	inference.Projection
}

func viewWorker(w worker.Record) workerView {
	w.Name = diagnostics.RedactWorkerSecrets(w.Name)
	return workerView{Record: w, Projection: inference.Projection{ConnectionStatus: "not_observed", WorkStatus: "unknown", InferenceReadiness: "unverified", QualificationHistory: []inference.Qualification{}}}
}

func (h *Handler) projectedWorker(r *http.Request, logger *slog.Logger, record worker.Record, own bool) (workerView, error) {
	if h.Broker == nil {
		return viewWorker(record), nil
	}
	p, err := h.Broker.Projection(r.Context(), logger, record.ID, own, h.projectionBuilds()...)
	return applyWorkerProjection(record, p, own), err
}

func (h *Handler) projectionBuilds() []service.Build {
	if h.Service != nil {
		return []service.Build{h.Service.Build()}
	}
	return nil
}

func applyWorkerProjection(record worker.Record, p inference.Projection, own bool) workerView {
	v := viewWorker(record)
	v.Projection = p
	if !own && p.LastPollAt != nil && (p.Update == nil || p.Update.Contract != worker.UpdateContract) {
		if v.Update == nil {
			v.Update = &worker.UpdateStatus{}
		}
		v.Update.State, v.Update.Reason = "migration_required", "unsupported_worker_migration"
	}
	if p.NativeContactAt != nil {
		v.LastContactAt = p.NativeContactAt
	}
	return v
}

func workerError(w http.ResponseWriter, err error) {
	code, reason := 503, "service_unavailable"
	var rejected *worker.Rejection
	if errors.As(err, &rejected) {
		reason = rejected.Reason
		switch reason {
		case "worker_not_found":
			code = 404
		case "enrollment_used", "enrollment_not_prepared", "enrollment_superseded":
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

func decodeWorkerInput(body []byte, field string, optional ...string) (map[string]any, error) {
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
		token, err := d.Token()
		if err != nil {
			return nil, errors.New("invalid_json")
		}
		key, _ := token.(string)
		if key == "" || (key != field && !slices.Contains(optional, key)) {
			return nil, errors.New("unsupported_field")
		}
		if _, exists := result[key]; exists {
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
		result[key] = text
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

func (h *Handler) enrollRequest(w *response, r *http.Request, logger *slog.Logger, input map[string]any) {
	code := input["enrollment_code"].(string)
	switch input["phase"] {
	case nil:
		logger.Warn("request.rejected", "reason", "enrollment_phase_required")
		writeJSON(w, 400, map[string]any{"error": "enrollment_phase_required"})
	case "prepare":
		e, credential, err := h.Workers.PrepareEnrollment(r.Context(), logger.With("enrollment_phase", "prepare"), code)
		w.enrollmentID = e.ID
		if err != nil {
			workerError(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{"enrollment_id": e.ID, "credential": credential})
	case "activate":
		credential := ""
		if values := r.Header.Values("Authorization"); len(values) == 1 {
			credential, _ = strings.CutPrefix(values[0], "Bearer ")
		}
		record, e, err := h.Workers.ActivateEnrollment(r.Context(), logger.With("enrollment_phase", "activate"), code, credential)
		w.workerID, w.enrollmentID = record.ID, e.ID
		if err != nil {
			workerError(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{"worker": viewWorker(record)})
	default:
		logger.Warn("request.rejected", "reason", "invalid_enrollment_phase")
		writeJSON(w, 400, map[string]any{"error": "invalid_enrollment_phase"})
	}
}

func (h *Handler) workerRequest(w *response, r *http.Request, logger *slog.Logger, route, id string, identity workerView, body []byte) {
	if h.Workers == nil {
		writeJSON(w, 503, map[string]any{"error": "service_unavailable"})
		return
	}
	if route == "/api/v1/admin/workers/{id}/qualifications" {
		w.workerID = id
		logger.Info("worker.qualification_retired", "worker_id", id, "outcome", "rejected")
		inferenceError(w, inference.Reject("qualification_retired", 410))
		return
	}
	field := ""
	var optional []string
	if route == "/api/v1/worker/enroll" {
		field, optional = "enrollment_code", []string{"phase"}
	} else if route == "/api/v1/admin/workers/{id}" {
		field = "name"
	}
	input, err := decodeWorkerInput(body, field, optional...)
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
		h.enrollRequest(w, r, logger, input)
	case "/api/v1/admin/workers":
		records, err := h.Workers.List(r.Context(), logger)
		if err != nil {
			workerError(w, err)
			return
		}
		workers := make([]workerView, 0, len(records))
		if h.Broker == nil {
			for _, record := range records {
				workers = append(workers, viewWorker(record))
			}
		} else {
			projections, err := h.Broker.Projections(r.Context(), logger, records, h.projectionBuilds()...)
			if err != nil {
				inferenceError(w, err)
				return
			}
			for index, record := range records {
				workers = append(workers, applyWorkerProjection(record, projections[index], false))
			}
		}
		writeJSON(w, 200, map[string]any{"workers": workers})
	case "/api/v1/worker/status":
		v, err := h.projectedWorker(r, logger, identity.Record, true)
		if err != nil {
			inferenceError(w, err)
			return
		}
		writeJSON(w, 200, struct {
			workerView
			WorkerPackage service.PackagePin   `json:"worker_package"`
			UpdateTarget  *worker.UpdateTarget `json:"update_target,omitempty"`
		}{v, h.Service.Build().WorkerPackage, h.Service.Build().UpdateTarget()})
	case "/api/v1/admin/workers/{id}":
		record, err := h.Workers.Rename(r.Context(), logger, id, input[field].(string))
		w.workerID = id
		if err != nil {
			workerError(w, err)
			return
		}
		v, err := h.projectedWorker(r, logger, record, false)
		if err != nil {
			inferenceError(w, err)
			return
		}
		writeJSON(w, 200, v)
	case "/api/v1/admin/workers/{id}/revoke":
		record, err := h.Workers.Revoke(r.Context(), logger, id)
		w.workerID = id
		if err != nil {
			workerError(w, err)
			return
		}
		v, err := h.projectedWorker(r, logger, record, false)
		if err != nil {
			inferenceError(w, err)
			return
		}
		writeJSON(w, 200, v)
	}
}
