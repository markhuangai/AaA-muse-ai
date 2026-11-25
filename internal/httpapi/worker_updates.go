package httpapi

import (
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const workerUpdateRoute = "/api/v1/worker/update"

var updaterContract = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)

func readWorkerContact(r *http.Request) (worker.Contact, error) {
	version := r.Header.Get(service.WorkerVersionHeader)
	contract := r.Header.Get(service.WorkerUpdaterHeader)
	digest := r.Header.Get(service.WorkerDigestHeader)
	_, valid := service.ReleaseMajor(version)
	if versions := r.Header.Values(service.WorkerVersionHeader); len(versions) != 0 && (len(versions) != 1 || !valid || len(version) > 100) {
		return worker.Contact{}, inference.Reject("invalid_worker_version", 400)
	}
	if len(r.Header.Values(service.WorkerUpdaterHeader)) > 1 || len(r.Header.Values(service.WorkerDigestHeader)) > 1 ||
		((contract != "" || digest != "") && (!valid || !updaterContract.MatchString(contract) || !service.ValidWorkerDigest(digest))) {
		return worker.Contact{}, inference.Reject("invalid_worker_update_headers", 400)
	}
	return worker.Contact{Version: version, Contract: contract, Digest: digest}, nil
}

func (h *Handler) workerUpdateRequest(w *response, r *http.Request, logger *slog.Logger, body []byte) {
	if h.Broker == nil {
		inferenceError(w, nil)
		return
	}
	contact, err := readWorkerContact(r)
	var input worker.UpdateRequest
	if err == nil {
		err = decodeInferenceInput(body, &input, "id", "action", "target")
	}
	if err != nil {
		logger.Warn("worker.update_rejected", "cause", err.Error())
		inferenceError(w, err)
		return
	}
	status, id, err := h.Broker.ApplyWorkerUpdate(r.Context(), logger, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), contact, input)
	w.workerID = id
	if err != nil {
		inferenceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}
