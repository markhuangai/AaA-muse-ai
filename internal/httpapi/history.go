package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func adminHistoryRoute(route string) bool {
	return strings.HasPrefix(route, "/api/v1/admin/conversations") || strings.HasPrefix(route, "/api/v1/admin/requests")
}

func historyRoute(path string) (string, string) {
	for _, prefix := range []string{"/api/v1/requests", "/api/v1/admin/requests", "/api/v1/admin/conversations"} {
		if path == prefix {
			return path, ""
		}
		if !strings.HasPrefix(path, prefix+"/") {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(path, prefix+"/"), "/")
		if !inference.Identifier.MatchString(parts[0]) {
			break
		}
		if len(parts) == 1 {
			return prefix + "/{id}", parts[0]
		}
		if len(parts) == 2 && ((prefix == "/api/v1/requests" && parts[1] == "cancel") || (prefix == "/api/v1/admin/conversations" && parts[1] == "timeline")) {
			return prefix + "/{id}/" + parts[1], parts[0]
		}
	}
	return "unmatched", ""
}

func readSessionHeader(r *http.Request) (string, error) {
	values := r.Header["X-Muse-Session-Id"]
	if len(values) > 1 || (len(values) == 1 && !inference.Identifier.MatchString(values[0])) {
		return "", inference.Reject("invalid_session_header", 400)
	}
	if len(values) == 0 {
		return "", nil
	}
	return values[0], nil
}

func parseHistoryQuery(r *http.Request, route, id string) (inference.HistoryQuery, error) {
	kinds := map[string]string{"/api/v1/admin/conversations": "conversations", "/api/v1/admin/conversations/{id}": "conversation", "/api/v1/admin/conversations/{id}/timeline": "timeline", "/api/v1/admin/requests": "requests", "/api/v1/admin/requests/{id}": "request"}
	q := inference.HistoryQuery{Kind: kinds[route], ID: id, Limit: 50}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return q, inference.Reject("invalid_query", 400)
	}
	for key, value := range values {
		if len(value) != 1 || value[0] == "" || q.Kind == "conversation" || q.Kind == "request" {
			return q, inference.Reject("invalid_history_query", 400)
		}
		switch key {
		case "limit":
			q.Limit, err = strconv.Atoi(value[0])
			if err != nil || q.Limit < 1 || q.Limit > 100 {
				return q, inference.Reject("invalid_page_limit", 400)
			}
		case "cursor":
		case "conversation_id":
			if q.Kind != "requests" || !inference.Identifier.MatchString(value[0]) {
				return q, inference.Reject("invalid_conversation_filter", 400)
			}
			q.ConversationID = value[0]
		default:
			return q, inference.Reject("unsupported_history_query", 400)
		}
	}
	if values.Get("cursor") != "" {
		q.After, err = inference.DecodeCursor(values.Get("cursor"), q)
	}
	return q, err
}

func (h *Handler) historyRequest(w *response, r *http.Request, logger *slog.Logger, route, id, client string, body []byte) {
	if h.Broker == nil {
		inferenceError(w, errors.New("broker_unavailable"))
		return
	}
	if adminHistoryRoute(route) {
		logger.Debug("history.query_input", "raw_query", r.URL.RawQuery, "requested_id", id)
		query, err := parseHistoryQuery(r, route, id)
		if err != nil {
			logger.Warn("portal.history_load_failed", "cause", err.Error(), "query_kind", query.Kind, "requested_id", id, "outcome", "rejected")
			inferenceError(w, err)
			return
		}
		result, err := h.Broker.QueryHistory(r.Context(), logger, query)
		if err != nil {
			cause := "service_unavailable"
			var rejected *inference.Rejection
			if errors.As(err, &rejected) {
				cause = rejected.Reason
			}
			logger.Warn("portal.history_load_failed", "cause", cause, "query_kind", query.Kind, "requested_id", id, "outcome", "failed")
			inferenceError(w, err)
			return
		}
		writeJSON(w, 200, result)
		return
	}
	session, err := readSessionHeader(r)
	if err != nil {
		logger.Warn("history.conflict", "reason", err.Error())
		inferenceError(w, err)
		return
	}
	if len(body) > 0 {
		var admitted any
		if inference.Decode(body, &admitted) == nil {
			logger.Debug("history.input", "input", admitted, "requested_session_id", session)
		}
	}
	var result inference.RequestView
	code := 200
	switch route {
	case "/api/v1/requests":
		var input inference.RequestInput
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id", "messages", "tools")
		if err == nil {
			result, err = h.Broker.SubmitRequest(r.Context(), logger, client, session, input)
		}
		code = 202
	case "/api/v1/requests/{id}":
		result, err = h.Broker.ReadRequest(r.Context(), logger, client, id, session)
	case "/api/v1/requests/{id}/cancel":
		var input inference.Cancel
		err = decodeInferenceInput(body, &input, "protocol_version", "submission_id")
		if err == nil {
			result, err = h.Broker.CancelRequest(r.Context(), logger, client, id, session, input)
		}
	}
	if err != nil {
		logger.Warn("request.rejected", "reason", err.Error())
		inferenceError(w, err)
		return
	}
	w.Header().Set("X-Muse-Session-Id", result.SessionID)
	w.workerID, w.conversationID, w.sessionID, w.requestRecordID = result.WorkerID, result.ConversationID, result.SessionID, result.ID
	if result.Output != nil {
		if err = h.Broker.OutputBoundary(r.Context(), logger, client, id, false, 0, 0, ""); err != nil {
			inferenceError(w, err)
			return
		}
	}
	clientView := result
	clientView.Response = nil
	writeJSON(w, code, clientView)
	if result.Output != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		defer cancel()
		cause := ""
		if w.writeErr != nil {
			cause = w.writeErr.Error()
		}
		if err = h.Broker.OutputBoundary(cleanup, logger, client, id, true, w.attempted, w.written, cause); err != nil {
			w.boundaryFailed = true
		}
	}
}
