package httpapi

import (
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
)

const portalCSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"

func (h *Handler) portalAsset(w *response, r *http.Request, logger *slog.Logger) bool {
	shell := r.URL.Path == "/" || r.URL.Path == "/settings" || r.URL.Path == "/workers" || r.URL.Path == "/requests"
	if !shell && !strings.HasPrefix(r.URL.Path, "/assets/") {
		return false
	}
	w.capture = false
	w.captureReason = "public_asset_reference"
	w.Header().Set("Content-Security-Policy", portalCSP)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeJSON(w, 405, map[string]any{"error": "method_not_allowed"})
		return true
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	kind := path.Ext(name)
	types := map[string]string{".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml"}
	contentType, allowed := types[kind]
	if shell {
		name, contentType, allowed = "index.html", "text/html; charset=utf-8", true
	}
	if !allowed || !fs.ValidPath(name) || len(name) > 200 || r.URL.RawQuery != "" {
		writeJSON(w, 404, map[string]any{"error": "not_found"})
		return true
	}
	var data []byte
	var err error
	if h.Assets == nil {
		err = fs.ErrNotExist
	} else {
		data, err = fs.ReadFile(h.Assets, name)
	}
	if err != nil {
		logger.Error("portal.assets_unavailable", "component", "shell", "asset_path", name, "cause", diagnostics.Cause(err), "expected_state", "available", "observed_state", "unavailable", "outcome", "failed")
		code := 503
		if !shell && errors.Is(err, fs.ErrNotExist) {
			code = 404
		}
		writeJSON(w, code, map[string]any{"error": "portal_assets_unavailable"})
		return true
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	logger.Debug("portal.asset_served", "component", "shell", "asset_path", name, "bytes", len(data), "response_capture", "public_asset_reference", "outcome", "served")
	w.WriteHeader(200)
	if r.Method == http.MethodGet {
		_, _ = w.Write(data)
	}
	return true
}
