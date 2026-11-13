package httpapi

import (
	"errors"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func portalError(w http.ResponseWriter, err error) {
	code, reason := 503, "service_unavailable"
	var rejected *service.PortalError
	if errors.As(err, &rejected) {
		code, reason = rejected.Status, rejected.Reason
		if code == 401 {
			reason = "unauthorized"
			w.Header().Set("WWW-Authenticate", "Bearer")
		}
		if rejected.RetryAfter > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(rejected.RetryAfter))
		}
	}
	writeJSON(w, code, map[string]any{"error": reason})
}

func (h *Handler) portalRequest(w *response, r *http.Request, logger *slog.Logger, route string, body []byte) {
	if h.Portal == nil {
		portalError(w, errors.New("portal_unavailable"))
		return
	}
	credential := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if route == "/api/v1/portal/login" || route == "/api/v1/portal/events" {
		media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || media != "application/json" {
			writeJSON(w, 415, map[string]any{"error": "json_content_type_required"})
			return
		}
	}
	switch route {
	case "/api/v1/portal/login":
		input, err := decodeWorkerInput(body, "password")
		if err != nil {
			logger.Warn("portal.auth_failed", "component", "login", "cause", "invalid_request", "credential_content_omitted", true, "outcome", "rejected")
			writeJSON(w, 400, map[string]any{"error": "invalid_login_request"})
			return
		}
		peer, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			peer = "unknown"
		}
		logger.Debug("portal.login_admitted", "component", "login", "credential_content_omitted", true, "body_bytes", len(body))
		result, err := h.Portal.Login(logger, peer, input["password"].(string))
		if err != nil {
			portalError(w, err)
			return
		}
		writeJSON(w, 200, result)
	case "/api/v1/portal/logout":
		if _, err := decodeWorkerInput(body, ""); err != nil {
			writeJSON(w, 400, map[string]any{"error": "invalid_logout_request"})
			return
		}
		if err := h.Portal.Logout(logger, credential); err != nil {
			portalError(w, err)
			return
		}
		w.WriteHeader(204)
	case "/api/v1/portal/settings":
		result, err := h.Service.PortalConfiguration(r.Context(), logger.With("component", "settings"))
		if err != nil {
			portalError(w, err)
			return
		}
		writeJSON(w, 200, result)
	case "/api/v1/portal/events":
		if len(body) > 4096 {
			writeJSON(w, 413, map[string]any{"error": "browser_report_too_large"})
			return
		}
		var input service.PortalReport
		if err := decodeInferenceInput(body, &input, "event", "build", "component", "cause", "request_id", "operation_id", "expected_state", "observed_state", "duration_ms", "attempt", "omitted_reports"); err != nil {
			writeJSON(w, 400, map[string]any{"error": "invalid_browser_report"})
			return
		}
		if err := h.Portal.Report(logger, credential, input); err != nil {
			portalError(w, err)
			return
		}
		w.WriteHeader(204)
	}
}
