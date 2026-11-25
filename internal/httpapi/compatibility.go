package httpapi

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const hookWorkerPrefix = "/api/v1/worker/hook/"
const workerPrefix = "/api/v1/worker/"
const workerEnrollRoute = workerPrefix + "enroll"
const workerStatusRoute = workerPrefix + "status"
const workerPullRoute = workerPrefix + "pull"
const workerBindRoute = workerPrefix + "jobs/{id}/bind"

func hookRequest(r *http.Request) bool { return strings.HasPrefix(r.URL.Path, hookWorkerPrefix) }

func (h *Handler) workerCompatibility(w *response, r *http.Request, logger *slog.Logger, route string) (*http.Request, bool) {
	if !strings.HasPrefix(route, workerPrefix) || (!hookRequest(r) && route == workerStatusRoute) {
		return r, true
	}
	build := h.Service.Build()
	contact, err := readWorkerContact(r)
	if err != nil {
		logger.Warn("worker.compatibility_rejected", "cause", err.Error())
		inferenceError(w, err)
		return r, false
	}
	if !hookRequest(r) && route == workerPullRoute {
		return r, true
	}
	if hookRequest(r) {
		if build.Paired(contact) {
			logger.Debug("worker.compatibility_accepted", "service_version", build.Version, "worker_version", contact.Version,
				"worker_contract", contact.Contract, "worker_digest", contact.Digest)
			pair := inference.HookPair{Version: build.Version, Digest: build.WorkerPackage.SHA256}
			return r.WithContext(inference.WithHookPair(r.Context(), pair)), true
		}
		if contact.Contract == worker.UpdateContract && (route == workerPullRoute || route == workerUpdateRoute) {
			logger.Debug("worker.compatibility_update_only", "service_version", build.Version, "worker_version", contact.Version,
				"expected_digest", build.WorkerPackage.SHA256, "observed_digest", contact.Digest)
			return r, true
		}
	}
	logger.Warn("worker.update_required", "service_version", build.Version, "worker_version", contact.Version,
		"expected_contract", worker.UpdateContract, "observed_contract", contact.Contract, "expected_digest", build.WorkerPackage.SHA256,
		"observed_digest", contact.Digest, "corrective_action", "Use the exact paired and verified worker; drain existing work on its original pair.",
		"outcome", "work_rejected")
	writeJSON(w, http.StatusUpgradeRequired, map[string]any{"error": "update_required", "service_version": build.Version,
		"worker_version": contact.Version, "worker_package": build.WorkerPackage, "automatic_update": contact.Contract == worker.UpdateContract})
	return r, false
}
