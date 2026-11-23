package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func (h *Handler) workerCompatibility(w *response, r *http.Request, logger *slog.Logger, route string) bool {
	if route != "/api/v1/worker/enroll" && route != "/api/v1/worker/pull" && route != "/api/v1/worker/jobs/{id}/start" && route != workerPresenceRoute {
		return true
	}
	build := h.Service.Build()
	values := r.Header.Values(service.WorkerVersionHeader)
	version := r.Header.Get(service.WorkerVersionHeader)
	_, valid := service.ReleaseMajor(version)
	if len(values) > 1 || (len(values) == 1 && (!valid || len(version) > 100)) {
		logger.Warn("worker.compatibility_rejected", "cause", "invalid_worker_version", "declared_version_count", len(values), "declared_version_bytes", len(version))
		writeJSON(w, 400, map[string]any{"error": "invalid_worker_version"})
		return false
	}
	if !build.Compatible(version) {
		if route == "/api/v1/worker/pull" && r.Header.Get(service.WorkerUpdaterHeader) != "" {
			return true
		}
		logger.Warn("worker.update_required", "service_version", build.Version, "worker_version", version, "legacy_handshake", len(values) == 0, "recommended_worker", build.WorkerPackage, "outcome", "new_authority_rejected", "automatic_update", false)
		writeJSON(w, http.StatusUpgradeRequired, map[string]any{"error": "update_required", "service_version": build.Version, "worker_version": version, "worker_package": build.WorkerPackage, "automatic_update": false})
		return false
	}
	level := slog.LevelInfo
	if route == "/api/v1/worker/pull" || route == workerPresenceRoute {
		level = slog.LevelDebug
	}
	logger.Log(r.Context(), level, "worker.compatibility_accepted", "service_version", build.Version, "worker_version", version, "legacy_handshake", len(values) == 0)
	return true
}
