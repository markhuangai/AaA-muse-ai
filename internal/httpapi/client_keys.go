package httpapi

import (
	"log/slog"
	"mime"
	"net/http"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
)

func (h *Handler) createClientKey(w *response, r *http.Request, logger *slog.Logger, body []byte) {
	started := h.Now()
	logger = logger.With("input_capture", "credentials_omitted", "body_bytes", len(body))
	failed := func(status int, level slog.Level, event, reason, stage, cause, outcome string) {
		logger.Log(r.Context(), level, event, "status", status, "stage", stage, "cause", cause, "outcome", outcome, "duration_ms", h.Now().Sub(started).Milliseconds())
		writeJSON(w, status, map[string]string{"error": reason})
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		failed(415, slog.LevelWarn, "client_key.rejected", "json_content_type_required", "decode", "json_content_type_required", "rejected")
		return
	}
	var input struct {
		Name string `json:"name"`
		Key  string `json:"key"`
	}
	if err := decodeInferenceInput(body, &input, "name", "key"); err != nil {
		failed(400, slog.LevelWarn, "client_key.rejected", "invalid_client_key", "decode", "invalid_request", "rejected")
		return
	}
	if auth.ValidToken(input.Key, auth.WorkerPrefix) || auth.ValidToken(input.Key, auth.EnrollmentPrefix) || auth.ValidToken(input.Key, auth.PortalPrefix) {
		failed(409, slog.LevelWarn, "client_key.rejected", "client_key_conflict", "validate_input", "reserved_credential", "rejected")
		return
	}
	if h.ClientKeys == nil {
		failed(503, slog.LevelError, "client_key.persist_failed", "client_key_save_failed", "configuration", "key_file_unavailable", "failed")
		return
	}
	if err := h.ClientKeys.Create(r.Context(), input.Name, config.Secret(input.Key)); err != nil {
		failure := err.(*config.ClientKeyError)
		switch failure.Code {
		case "invalid_client_key":
			failed(400, slog.LevelWarn, "client_key.rejected", failure.Code, failure.Stage, failure.Cause, "rejected")
		case "client_key_conflict":
			failed(409, slog.LevelWarn, "client_key.rejected", failure.Code, failure.Stage, failure.Cause, "rejected")
		case "client_key_save_uncertain":
			failed(503, slog.LevelError, "client_key.persist_failed", failure.Code, failure.Stage, failure.Cause, "uncertain")
		default:
			failed(503, slog.LevelError, "client_key.persist_failed", failure.Code, failure.Stage, failure.Cause, "failed")
		}
		return
	}
	name := diagnostics.NewRedactor(h.ClientKeys.Current().Secrets()).Text(input.Name)
	logger.Info("client_key.created", "client_name", name, "status", 201, "outcome", "stored", "duration_ms", h.Now().Sub(started).Milliseconds())
	writeJSON(w, 201, map[string]string{"name": name})
}
