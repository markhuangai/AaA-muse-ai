package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

const portalCookieName = "__Host-muse_portal"
const portalOperationHeader = "X-Portal-Operation-Id"

var portalCrossOrigin http.CrossOriginProtection

func portalCookieValue(r *http.Request) string {
	cookie, err := r.Cookie(portalCookieName)
	if err != nil {
		return ""
	}
	return cookie.Value
}

func setPortalCookie(w http.ResponseWriter, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: portalCookieName, Value: token, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}

func allowPortalWrite(w http.ResponseWriter, r *http.Request, logger *slog.Logger) bool {
	cause := ""
	if portalCrossOrigin.Check(r) != nil {
		cause = "cross_origin_request"
	} else if r.Header.Get(portalOperationHeader) == "" {
		cause = "portal_operation_required"
	}
	if cause == "" {
		return true
	}
	logger.Warn("portal.auth_failed", "component", "session", "cause", cause, "expected_state", "same_origin", "observed_state", "unverified", "outcome", "rejected")
	writeJSON(w, 403, map[string]any{"error": cause})
	return false
}

func decodePortalLogin(body []byte) (password string, remember *bool, err error) {
	var fields map[string]json.RawMessage
	if err := inference.Decode(body, &fields); err != nil {
		return "", nil, err
	}
	passwordField := fields["password"]
	if string(passwordField) == "null" || json.Unmarshal(passwordField, &password) != nil {
		return "", nil, errors.New("invalid_password")
	}
	if value, present := fields["remember_me"]; present {
		var selected bool
		if string(value) == "null" || json.Unmarshal(value, &selected) != nil {
			return "", nil, errors.New("invalid_remember_me")
		}
		remember = &selected
		delete(fields, "remember_me")
	}
	if len(fields) != 1 {
		return "", nil, errors.New("unsupported_field")
	}
	return password, remember, nil
}

func portalWorkerAction(route string) (string, string) {
	switch route {
	case "/api/v1/admin/enrollments":
		return "enrollment.issue", "enrollment"
	case "/api/v1/admin/setup-prompts":
		return "setup.create", "enrollment"
	case "/api/v1/admin/workers/{id}":
		return "worker.rename", "worker"
	case "/api/v1/admin/workers/{id}/revoke":
		return "worker.revoke", "worker"
	default:
		return "", ""
	}
}

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

func (h *Handler) portalRequest(w *response, r *http.Request, logger *slog.Logger, route, browserSession string, body []byte) {
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
		password, remember, err := decodePortalLogin(body)
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
		if remember != nil {
			if !allowPortalWrite(w, r, logger) {
				return
			}
			token, err := h.Portal.LoginBrowser(r.Context(), logger, peer, password, portalCookieValue(r), *remember)
			if err != nil {
				portalError(w, err)
				return
			}
			maxAge := 0
			if *remember {
				maxAge = int(service.PortalRememberLifetime.Seconds())
			}
			setPortalCookie(w, token, maxAge)
			writeJSON(w, 200, map[string]bool{"authenticated": true})
			return
		}
		result, err := h.Portal.Login(logger, peer, password)
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
		if len(r.Header.Values("Authorization")) == 0 {
			if !allowPortalWrite(w, r, logger) {
				return
			}
			if err := h.Portal.LogoutBrowser(r.Context(), logger, portalCookieValue(r)); err != nil {
				portalError(w, err)
				return
			}
			setPortalCookie(w, "", -1)
		} else {
			if err := h.Portal.Logout(logger, credential); err != nil {
				portalError(w, err)
				return
			}
		}
		w.WriteHeader(204)
	case "/api/v1/portal/session":
		writeJSON(w, 200, map[string]bool{"authenticated": true})
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
		var err error
		if browserSession != "" {
			err = h.Portal.ReportBrowser(logger, browserSession, input)
		} else {
			err = h.Portal.Report(logger, credential, input)
		}
		if err != nil {
			portalError(w, err)
			return
		}
		w.WriteHeader(204)
	}
}
