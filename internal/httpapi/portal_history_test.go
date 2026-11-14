package httpapi

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func TestPortalHistoryManagementScopeCancellationAndCapture(t *testing.T) {
	h, m, worker, key := inferenceHTTPFixture(t)
	h.Portal = service.NewPortal(h.Authority, rand.Reader, h.Now)
	h.Assets = fstest.MapFS{"index.html": {Data: []byte("compiled shell")}}
	session := portalLogin(t, h)
	connection := onlineNativeHTTP(t, h, m, worker.ID)
	input := nativeHTTPInput(worker.ID)
	request, _ := nativeHTTP(t, h, "POST", "/api/v1/requests", "portal-session", input, 202)
	operation := map[string]string{"X-Portal-Operation-Id": "history-portal-operation"}
	for _, path := range []string{"/api/v1/admin/requests", "/api/v1/admin/requests/" + request.ID, "/api/v1/admin/conversations/" + request.ConversationID + "/timeline"} {
		if portalHTTP(h, "GET", path, session.Token, "", operation).Code != 200 {
			t.Fatal("portal cannot consume management history")
		}
		for _, credential := range []string{"", key, "client-private-sentinel", "portal-private-sentinel"} {
			if portalHTTP(h, "GET", path, credential, "", nil).Code != 401 {
				t.Fatal("wrong role reached history")
			}
		}
	}
	path := "/api/v1/admin/experiments/" + request.ID + "/cancel"
	for _, credential := range []string{key, "client-private-sentinel", "portal-private-sentinel"} {
		if portalHTTP(h, "POST", path, credential, `{"protocol_version":1,"submission_id":"denied"}`, nil).Code != 401 {
			t.Fatal("wrong role reached cancellation")
		}
	}
	if portalHTTP(h, "POST", path, session.Token, `{"protocol_version":1,"submission_id":"portal-cancel"}`, operation).Code != 200 {
		t.Fatal("portal cancellation failed")
	}
	input.SubmissionID = "completed-request"
	completed, _ := nativeHTTP(t, h, "POST", "/api/v1/requests", "another-session", input, 202)
	nativeHTTPDecision(t, h, m, connection, key, completed)
	if portalHTTP(h, "POST", "/api/v1/admin/experiments/"+completed.ID+"/cancel", session.Token, `{"protocol_version":1,"submission_id":"too-late"}`, operation).Code != 409 {
		t.Fatal("completed output was cancelled")
	}
	for _, body := range []string{`{}`, `{"protocol_version":2,"submission_id":"invalid"}`} {
		if portalHTTP(h, "POST", path, session.Token, body, operation).Code != 400 {
			t.Fatal("malformed cancellation admitted")
		}
	}
	if portalHTTP(h, "GET", "/api/v1/admin/requests?cursor=invalid", session.Token, "", operation).Code != 400 {
		t.Fatal("invalid cursor admitted")
	}
	m.fail = errors.New("controlled database failure")
	if portalHTTP(h, "GET", "/api/v1/admin/requests", session.Token, "", operation).Code != 503 || portalHTTP(h, "POST", path, session.Token, `{"protocol_version":1,"submission_id":"database-failed"}`, operation).Code != 503 {
		t.Fatal("history dependency failure concealed")
	}
	counts := map[string]int{}
	for _, event := range capturedHTTP(t, m.capture) {
		name, _ := event["msg"].(string)
		if name == "portal.history_load_failed" || name == "portal.cancel_result" {
			counts[name]++
			if event["request_id"] == "" || event["portal_operation_id"] != "history-portal-operation" || event["portal_session_id"] == "" {
				t.Fatal("history diagnostics lost authenticated operation correlation")
			}
			if event["cause"] == "experiment_already_completed" && (event["transaction_outcome"] != "rolled_back" || event["remote_outcome"] != "decision_observed" || event["busy_hold"] != false || event["operation_id"] != completed.ID) {
				t.Fatal("rejected cancellation lost its observed outcome", event)
			}
		}
	}
	if counts["portal.history_load_failed"] != 2 || counts["portal.cancel_result"] < 5 {
		t.Fatal("history/cancel outcomes are not captured", counts)
	}
	if portalHTTP(h, "GET", "/requests", "", "", nil).Code != 200 || portalHTTP(h, "GET", "/requests/missing", "", "", nil).Code != 404 || strings.Contains(m.output.String(), session.Token) {
		t.Fatal("shell or credential protection changed")
	}
}

func TestPortalHistoryBrowserReportsRetainOrderingAndSourceWithoutPayloads(t *testing.T) {
	h, _, _, store := portalHTTPFixture(t)
	session := portalLogin(t, h)
	for _, event := range []string{"portal.history_load_failed", "portal.cancel_result", "portal.render_failed"} {
		report := service.PortalReport{Event: event, Build: "development", Component: "history", Cause: "request_failed", QueryKind: "request", OperationID: "history-report", RequestID: "source-http", RequestRecordID: "recorded-request", ConversationID: "conversation", Expected: "fresh", Observed: "stale", Attempt: 1, RequestSequence: 1, LatestSequence: 2, AcceptedSequence: 2, SessionGeneration: 1}
		if event == "portal.cancel_result" {
			report.QueryKind = "cancel"
		}
		if event == "portal.render_failed" {
			report.Cause, report.Expected, report.Observed = "render_exception", "rendered", "failed"
		}
		body, _ := json.Marshal(report)
		if portalHTTP(h, "POST", "/api/v1/portal/events", session.Token, string(body), nil).Code != 204 {
			t.Fatal("history browser report rejected")
		}
	}
	counts := map[string]int{}
	for _, event := range capturedHTTP(t, store) {
		if event["client_report"] == true && event["component"] == "history" && event["msg"] != "portal.browser_report" {
			counts[event["msg"].(string)]++
			if event["related_request_id"] != "source-http" || event["request_record_id"] != "recorded-request" || event["request_sequence"] == nil || event["portal_session_id"] == "" {
				t.Fatal("history browser evidence is not reconstructable")
			}
		}
	}
	if len(counts) != 3 {
		t.Fatal("history browser outcomes omitted", counts)
	}
}

func TestPortalHistoryExpiredServerSessionCannotReadOrCancel(t *testing.T) {
	h, m, worker, _ := inferenceHTTPFixture(t)
	now := h.Now()
	h.Portal = service.NewPortal(h.Authority, rand.Reader, func() time.Time { return now })
	onlineNativeHTTP(t, h, m, worker.ID)
	request, _ := nativeHTTP(t, h, "POST", "/api/v1/requests", "expiry-session", nativeHTTPInput(worker.ID), 202)
	session := portalLogin(t, h)
	now = now.Add(service.PortalSessionLifetime + time.Second)
	for _, path := range []string{"/api/v1/admin/requests", "/api/v1/admin/requests/" + request.ID, "/api/v1/admin/experiments/" + request.ID + "/cancel"} {
		method, body := "GET", ""
		if strings.HasSuffix(path, "/cancel") {
			method, body = "POST", `{"protocol_version":1,"submission_id":"expired-cancel"}`
		}
		if portalHTTP(h, method, path, session.Token, body, nil).Code != 401 {
			t.Fatal("expired server authority reached history", path)
		}
	}
	if m.states[worker.ID].Experiments[request.ID].State != "queued" {
		t.Fatal("expired portal authority mutated the request")
	}
}
