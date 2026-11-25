package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const (
	adminWorkerPrefix  = "/api/v1/admin/workers/"
	adminWorkerBase    = adminWorkerPrefix + "{id}/"
	opsRoute           = adminWorkerBase + "ops"
	opDetailRoute      = opsRoute + "/{item_id}"
	opCancelRoute      = opDetailRoute + "/cancel"
	tasksRoute         = adminWorkerBase + "agent-tasks"
	taskDetailRoute    = tasksRoute + "/{item_id}"
	taskCancelRoute    = taskDetailRoute + "/cancel"
	hookPromptRoute    = adminWorkerBase + "hook-prompt"
	workerOpResult     = workerPrefix + "ops/{id}/result"
	taskWorkerBase     = workerPrefix + "agent-tasks/{id}/"
	taskBindRoute      = taskWorkerBase + "bind"
	taskStartRoute     = taskWorkerBase + "start"
	taskPresenceRoute  = taskWorkerBase + "presence"
	taskResultRoute    = taskWorkerBase + "result"
	taskInterruptRoute = taskWorkerBase + "interrupt"
)

func adminWorkerControlRoute(parts []string) string {
	if len(parts) == 2 {
		switch parts[1] {
		case "ops":
			return opsRoute
		case "agent-tasks":
			return tasksRoute
		case "hook-prompt":
			return hookPromptRoute
		}
	}
	if len(parts) < 3 || len(parts) > 4 || !workerIDPattern.MatchString(parts[2]) {
		return ""
	}
	var route string
	switch parts[1] {
	case "ops":
		route = opDetailRoute
	case "agent-tasks":
		route = taskDetailRoute
	default:
		return ""
	}
	if len(parts) == 3 {
		return route
	}
	if parts[3] == "cancel" {
		return route + "/cancel"
	}
	return ""
}

func workerControlRoute(path string) (string, string) {
	tail, ok := strings.CutPrefix(path, workerPrefix)
	if !ok {
		return "", ""
	}
	parts := strings.Split(tail, "/")
	if len(parts) != 3 || !workerIDPattern.MatchString(parts[1]) {
		return "", ""
	}
	if parts[0] == "ops" && parts[2] == "result" {
		return workerOpResult, parts[1]
	}
	if parts[0] == "agent-tasks" {
		switch parts[2] {
		case "bind", "start", "presence", "result", "interrupt":
			return taskWorkerBase + parts[2], parts[1]
		}
	}
	return "", ""
}

func adminControlLane(route string) string {
	switch route {
	case opsRoute, opDetailRoute, opCancelRoute:
		return worker.WorkerOp
	case tasksRoute, taskDetailRoute, taskCancelRoute:
		return worker.AgentTask
	default:
		return ""
	}
}

func requireControlJSON(route, method string) bool {
	return method == http.MethodPost && (adminControlLane(route) != "" ||
		route == "/api/v1/portal/login" || route == "/api/v1/portal/events" || route == "/api/v1/portal/client-keys")
}

func hasJSONContentType(r *http.Request) bool {
	values := r.Header.Values("Content-Type")
	if len(values) != 1 {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(values[0])
	return err == nil && mediaType == "application/json"
}

func controlBodyLimit(route string) int64 {
	switch route {
	case opsRoute, opCancelRoute, taskCancelRoute:
		return 64 * 1024
	case tasksRoute:
		return 128 * 1024
	case workerOpResult:
		return worker.MaxWorkerOpEnvelope
	default:
		return MaxBodyBytes
	}
}

func controlListOptions(query string, lane string) (limit int, cursor, kind string, err error) {
	limit = 25
	values, err := url.ParseQuery(query)
	if err != nil {
		return 0, "", "", inference.Reject("invalid_query", 400)
	}
	for key, value := range values {
		if len(value) != 1 {
			return 0, "", "", inference.Reject("duplicate_filter", 400)
		}
		switch key {
		case "limit":
			limit, err = strconv.Atoi(value[0])
			if err != nil || limit < 1 || limit > 100 {
				return 0, "", "", inference.Reject("invalid_limit", 400)
			}
		case "cursor":
			cursor = value[0]
		case "kind":
			kind = value[0]
			if lane != worker.WorkerOp || !worker.ValidOpKind(kind) {
				return 0, "", "", inference.Reject("invalid_worker_op", 400)
			}
		default:
			return 0, "", "", inference.Reject("unsupported_query", 400)
		}
	}
	return limit, cursor, kind, nil
}

func (h *Handler) adminWorkerControl(w *response, r *http.Request, logger *slog.Logger, route, owner string, body []byte) {
	if h.Broker == nil || h.Service == nil {
		inferenceError(w, errors.New("broker_unavailable"))
		return
	}
	w.workerID = owner
	ctx := r.Context()
	lane := adminControlLane(route)
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, adminWorkerPrefix), "/")
	if len(parts) >= 3 {
		w.controlOperation = parts[2]
		logger = logger.With("operation_id", parts[2])
	}
	var err error
	var output any
	status := http.StatusOK
	switch {
	case route == hookPromptRoute:
		output, err = h.Broker.HookUpgradePrompt(ctx, owner)
	case r.Method == http.MethodGet && (route == opsRoute || route == tasksRoute):
		var limit int
		var cursor, kind string
		limit, cursor, kind, err = controlListOptions(r.URL.RawQuery, lane)
		if err == nil {
			output, err = h.Broker.ListWorkerControl(ctx, lane, owner, kind, cursor, limit)
		}
	case r.Method == http.MethodGet:
		var item worker.ControlItem
		item, err = h.Broker.WorkerControlDetail(ctx, lane, owner, parts[2])
		if item.Kind == worker.DiagnosticsExport && err == nil {
			w.capture, w.captureReason = false, "worker_op_result_omitted"
		}
		output = item
	case route == opCancelRoute || route == taskCancelRoute:
		var input inference.Cancel
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id")
		if err == nil {
			output, err = h.Broker.CancelWorkerControl(ctx, logger, lane, owner, parts[2], input)
		}
	case route == opsRoute:
		var input worker.OpRequest
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "kind")
		if err == nil {
			output, err = h.Broker.SubmitWorkerOp(ctx, logger, h.Service.Build(), owner, input)
		}
		status = http.StatusAccepted
	case route == tasksRoute:
		var input worker.TaskRequest
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "prompt")
		if err == nil {
			output, err = h.Broker.SubmitAgentTask(ctx, logger, h.Service.Build(), owner, input)
		}
		status = http.StatusAccepted
	}
	if err != nil {
		if lane == "" {
			lane = worker.AgentTask
		}
		workerControlError(w, logger, lane, err)
		return
	}
	if raw, ok := output.(json.RawMessage); ok && w.controlOperation == "" {
		var identity struct{ ID string }
		if json.Unmarshal(raw, &identity) == nil {
			w.controlOperation = identity.ID
		}
	}
	writeJSON(w, status, output)
}

func workerTaskCapability(r *http.Request) (bool, error) {
	values := r.Header.Values(worker.AgentTasksHeader)
	switch {
	case len(values) == 0:
		return false, nil
	case len(values) == 1 && values[0] == "1":
		return true, nil
	default:
		return false, inference.Reject("invalid_worker_capabilities", 400)
	}
}

func (h *Handler) workerOpResult(w *response, r *http.Request, logger *slog.Logger, id string, body []byte) {
	var input worker.ControlResult
	err := decodeInferenceInput(body, &input, "protocol_version", "submission_id", "claim_id", "generation", "outcome")
	if err != nil {
		workerControlError(w, logger, worker.WorkerOp, err)
		return
	}
	redactor := h.Redactor
	if redactor == nil {
		redactor = diagnostics.NewRedactor(nil)
	}
	var output json.RawMessage
	output, w.workerID, err = h.Broker.CompleteWorkerOp(r.Context(), logger, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), id, input,
		func(kind string, raw json.RawMessage) (json.RawMessage, error) {
			if kind != worker.DiagnosticsExport {
				return redactor.JSON(raw)
			}
			var report worker.DiagnosticsResult
			if err := inference.Decode(raw, &report); err != nil || report.Captures != len(report.Output) || report.Captures > 500 || len(report.NextCursor) > 1024 {
				return nil, inference.Reject("invalid_diagnostics_result", 400)
			}
			for i, capture := range report.Output {
				safe, err := redactor.WorkerCapture(capture, report.Decoded)
				if err != nil {
					return nil, inference.Reject("invalid_diagnostics_result", 400)
				}
				report.Output[i] = safe
			}
			raw, err := json.Marshal(report)
			if err != nil {
				return nil, err
			}
			return redactor.JSON(raw)
		})
	if err != nil {
		workerControlError(w, logger, worker.WorkerOp, err)
		return
	}
	writeJSON(w, 200, output)
}

func workerControlError(w *response, logger *slog.Logger, lane string, err error) {
	var rejection *inference.Rejection
	if errors.As(err, &rejection) && rejection.Fields["control_diagnostic_recorded"] != true {
		name := lane + ".rejected"
		if rejection.Code == 401 {
			name = "worker.auth_denied"
		} else if rejection.Reason == "worker_scope_denied" {
			name = "worker.scope_denied"
		}
		if w.controlOperation != "" {
			logger = logger.With("operation_id", w.controlOperation)
		}
		logger.Warn(name, "worker_id", w.workerID, "reason", rejection.Reason, "expected_state", "authorized_valid_request",
			"observed_state", "rejected", "details", rejection.Fields)
	}
	inferenceError(w, err)
}
