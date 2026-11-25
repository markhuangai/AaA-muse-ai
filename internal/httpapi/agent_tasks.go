package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func (h *Handler) workerControlRequest(w *response, r *http.Request, logger *slog.Logger, route, id string, body []byte) {
	if h.Broker == nil {
		inferenceError(w, errors.New("broker_unavailable"))
		return
	}
	ctx := r.Context()
	w.controlOperation = id
	credential := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	var result any
	var err error
	switch route {
	case workerOpResult:
		h.workerOpResult(w, r, logger, id, body)
		return
	case taskBindRoute:
		var input inference.WakeBinding
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "claim_id", "generation",
			"checker_job_id", "previous_invocation_id", "invocation_id")
		if err == nil {
			result, w.workerID, err = h.Broker.BindAgentTask(ctx, logger, credential, id, input)
		}
	case taskStartRoute:
		var input inference.WorkStart
		err = decodeInferenceInput(body, &input, "protocol_version", "claim_id", "generation", "launch_id", "native_job_id", "verification")
		if err == nil {
			result, w.workerID, err = h.Broker.StartAgentTask(ctx, logger, credential, id, input)
		}
	case taskPresenceRoute:
		var input inference.BusyCheck
		err = decodeInferenceInput(body, &input, "protocol_version", "claim_id", "generation", "checker_job_id", "checker_run_id", "scheduled_at")
		if err == nil {
			supportsTasks, capabilityErr := workerTaskCapability(r)
			contact, contactErr := readWorkerContact(r)
			if err = errors.Join(capabilityErr, contactErr); err == nil {
				input.WeeklyUsage = readWeeklyUsage(r.Header, logger)
				result, w.workerID, err = h.Broker.AgentTaskPresence(ctx, logger, credential, id, input, contact, supportsTasks)
			}
		}
	case taskResultRoute:
		var input worker.TaskResult
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "claim_id", "generation", "launch_id", "outcome")
		if err == nil {
			redact := diagnostics.RedactWorkerSecrets
			if h.Redactor != nil {
				redact = h.Redactor.Text
			}
			result, w.workerID, err = h.Broker.CompleteAgentTask(ctx, logger, credential, id, input, redact)
		}
	case taskInterruptRoute:
		var input inference.Interruption
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "claim_id", "generation", "launch_id", "reason")
		if err == nil {
			var evidence *inference.InterruptionEvidence
			evidence, err = readNativeInterruption(r.Header)
			if err == nil {
				result, w.workerID, err = h.Broker.SettleAgentTask(ctx, logger, credential, id, input, evidence)
			}
		}
	}
	if err != nil {
		workerControlError(w, logger, worker.AgentTask, err)
		return
	}
	writeJSON(w, 200, result)
}
