package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func httpHistoryScope(states map[string]*inference.State, ref *inference.Ref) error {
	if ref.ClientID == "" {
		return nil
	}
	var c *inference.Conversation
	if ref.ExperimentID != "" || ref.ResponseID != "" {
		for _, s := range states {
			for _, r := range s.Requests {
				if r.ClientID == ref.ClientID && ((ref.ExperimentID != "" && r.ID == ref.ExperimentID) || (ref.ResponseID != "" && r.ResponseID == ref.ResponseID)) {
					if ref.ResponseID != "" && r.Output == nil {
						return inference.Reject("response_not_completed", 409)
					}
					c = s.Conversations[r.ConversationID]
				}
			}
		}
		if c == nil {
			return inference.Reject("history_owner_denied", 404)
		}
		if ref.SessionID != "" && ref.SessionID != c.SessionID {
			return inference.Reject("session_reference_conflict", 409)
		}
	} else if ref.SessionID != "" {
		for _, s := range states {
			for _, candidate := range s.Conversations {
				if candidate.ClientID == ref.ClientID && candidate.SessionID == ref.SessionID {
					c = candidate
				}
			}
		}
	}
	if c == nil {
		return nil
	}
	if ref.WorkerID != "" && ref.WorkerID != c.WorkerID {
		return inference.Reject("session_worker_conflict", 409)
	}
	ref.WorkerID, ref.ConversationID = c.WorkerID, c.ID
	for _, s := range states {
		for _, r := range s.Requests {
			if r.ConversationID == c.ID && r.ReplayHash == ref.ReplayHash {
				ref.ExperimentID = r.ID
			}
		}
	}
	return nil
}

func (m *httpInferenceStore) QueryHistory(_ context.Context, _ inference.HistoryQuery) (json.RawMessage, error) {
	return json.RawMessage(`{"items":[]}`), m.fail
}

func nativeHTTP(t *testing.T, h *Handler, method, path, session string, input any, want int) (inference.RequestView, *httptest.ResponseRecorder) {
	t.Helper()
	var body bytes.Buffer
	if input != nil {
		if err := json.NewEncoder(&body).Encode(input); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, &body)
	r.Header.Set("Authorization", "Bearer client-private-sentinel")
	if session != "" {
		r.Header.Set("X-Muse-Session-Id", session)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != want {
		t.Fatalf("%s %s expected %d got %d: %s", method, path, want, w.Code, w.Body.String())
	}
	var result inference.RequestView
	if want < 300 {
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
	}
	return result, w
}

func nativeHTTPInput(worker string) inference.RequestInput {
	return inference.RequestInput{Version: 1, SubmissionID: "native-first", WorkerID: worker, Messages: []inference.Item{{Type: "message", Role: "system", Text: "Exact text\n"}, {Type: "message", Role: "user", Text: "hello"}}, Tools: []inference.Tool{}}
}

func nativeHTTPDecision(t *testing.T, h *Handler, m *httpInferenceStore, c inference.Connection, key string, v inference.RequestView) inference.Job {
	t.Helper()
	e := m.states[v.WorkerID].Experiments[v.ID]
	claim := map[string]any{"protocol_version": 1, "submission_id": "claim-" + v.ID, "connection_id": c.ID, "connection_generation": c.Generation}
	j := apiJSON(t, h, "POST", "/api/v1/worker/jobs/"+e.CurrentJobID+"/claim", key, claim, 200)
	decision := map[string]any{"protocol_version": 1, "submission_id": "decision-" + v.ID, "connection_id": c.ID, "connection_generation": c.Generation, "conversation_id": v.ConversationID, "generation": j["generation"], "lease_id": j["lease_id"], "context_receipt_id": j["context"].(map[string]any)["receipt_id"], "decision": map[string]any{"type": "final", "text": "exact answer\n"}}
	apiJSON(t, h, "POST", "/api/v1/worker/jobs/"+e.CurrentJobID+"/decisions", key, decision, 200)
	return *m.states[v.WorkerID].Jobs[e.CurrentJobID]
}

func TestNativeHTTPProductionFlowAndDisclosure(t *testing.T) {
	h, m, w, key := inferenceHTTPFixture(t)
	c := onlineHTTP(t, h, w.ID)
	input := nativeHTTPInput(w.ID)
	v, response := nativeHTTP(t, h, "POST", "/api/v1/requests", "session-http", input, 202)
	if response.Header().Get("X-Muse-Session-Id") != "session-http" || v.Output != nil {
		t.Fatal("admission disclosure/correlation wrong")
	}
	job := nativeHTTPDecision(t, h, m, c, key, v)
	if m.states[w.ID].Requests[v.ID].ContextDeliveryWritten == nil {
		t.Fatal("context write boundary missing")
	}
	read, response := nativeHTTP(t, h, "GET", "/api/v1/requests/"+v.ID, "", nil, 200)
	if read.Output == nil || read.Output.Text != "exact answer\n" || response.Header().Get("X-Muse-Session-Id") != "session-http" {
		t.Fatal("read disclosure/correlation wrong")
	}
	if strings.Contains(response.Body.String(), "input") || strings.Contains(response.Body.String(), "lease_id") {
		t.Fatal("client response exposed administration details")
	}
	r := m.states[w.ID].Requests[v.ID]
	if r.OutputStartedAt == nil || r.OutputCompletedAt == nil {
		t.Fatal("model output boundaries missing")
	}
	nativeHTTP(t, h, "GET", "/api/v1/requests/"+v.ID, "wrong", nil, 409)
	nativeHTTP(t, h, "GET", "/api/v1/requests/missing", "", nil, 404)
	next := input
	next.SubmissionID = "next"
	next.Messages = append(inference.Messages(m.states[w.ID].Conversations[v.ConversationID], 3), inference.Item{Type: "message", Role: "user", Text: "next"})
	v2, _ := nativeHTTP(t, h, "POST", "/api/v1/requests", "session-http", next, 202)
	nativeHTTP(t, h, "POST", "/api/v1/requests/"+v2.ID+"/cancel", "wrong", inference.Cancel{Version: 1, SubmissionID: "wrong"}, 409)
	if m.states[w.ID].Requests[v2.ID].State != "queued" {
		t.Fatal("wrong header changed state")
	}
	cancelled, _ := nativeHTTP(t, h, "POST", "/api/v1/requests/"+v2.ID+"/cancel", "session-http", inference.Cancel{Version: 1, SubmissionID: "cancel"}, 200)
	if cancelled.State != "cancelled" {
		t.Fatal("owned cancellation failed")
	}
	apiJSON(t, h, "GET", "/api/v1/worker/jobs/"+job.ID, key, nil, 200)
}

func TestHistoryConflictContentStaysInProtectedCapture(t *testing.T) {
	h, m, w, key := inferenceHTTPFixture(t)
	c := onlineHTTP(t, h, w.ID)
	input := nativeHTTPInput(w.ID)
	input.Messages[0].Text = "distinctive-private-history-marker\n"
	v, _ := nativeHTTP(t, h, "POST", "/api/v1/requests", "protected-session", input, 202)
	nativeHTTPDecision(t, h, m, c, key, v)
	conflict := input
	conflict.SubmissionID = "conflict"
	conflict.Messages = append(append([]inference.Item{}, input.Messages...), inference.Item{Type: "message", Role: "assistant", Text: "exact answer\n"}, inference.Item{Type: "message", Role: "user", Text: "next"})
	conflict.Messages[0].Text = "changed prefix"
	_, response := nativeHTTP(t, h, "POST", "/api/v1/requests", "protected-session", conflict, 409)
	if strings.Contains(m.output.String(), "distinctive-private-history-marker") {
		t.Fatal("conversation content reached INFO/WARN output")
	}
	protected, warn := false, false
	for _, event := range capturedHTTP(t, m.capture) {
		if event["request_id"] != response.Header().Get("X-Request-Id") {
			continue
		}
		if event["msg"] == "history.conflict_detail" {
			data, _ := json.Marshal(event)
			protected = event["level"] == "DEBUG" && strings.Contains(string(data), "distinctive-private-history-marker")
		}
		if event["msg"] == "history.conflict" {
			warn = event["level"] == "WARN"
		}
	}
	if !protected || !warn {
		t.Fatal("safe warning or protected conflict cause missing")
	}
}

type nativeWriteFailure struct {
	header http.Header
	fail   func()
	code   int
}

func (w *nativeWriteFailure) Header() http.Header {
	if w.header == nil {
		w.header = http.Header{}
	}
	return w.header
}
func (w *nativeWriteFailure) WriteHeader(code int) { w.code = code }
func (w *nativeWriteFailure) Write(data []byte) (int, error) {
	if w.fail != nil {
		w.fail()
	}
	return len(data) / 2, errors.New("connection interrupted")
}

func TestNativeOutputPartialWriteAndBoundaryFailure(t *testing.T) {
	for _, storageFailure := range []bool{false, true} {
		t.Run(fmt.Sprint(storageFailure), func(t *testing.T) {
			h, m, w, key := inferenceHTTPFixture(t)
			c := onlineHTTP(t, h, w.ID)
			v, _ := nativeHTTP(t, h, "POST", "/api/v1/requests", "session", nativeHTTPInput(w.ID), 202)
			nativeHTTPDecision(t, h, m, c, key, v)
			r := httptest.NewRequest("GET", "/api/v1/requests/"+v.ID, nil)
			r.Header.Set("Authorization", "Bearer client-private-sentinel")
			out := &nativeWriteFailure{}
			if storageFailure {
				out.fail = func() { m.fail = errors.New("database unavailable after model write") }
			}
			h.ServeHTTP(out, r)
			stored := m.states[w.ID].Requests[v.ID]
			if out.code != 200 || stored.OutputStartedAt == nil || stored.OutputCompletedAt != nil {
				t.Fatal("failed write not conservatively fenced")
			}
		})
	}
}

func TestNativeHTTPStrictBoundariesAndHistoryQueries(t *testing.T) {
	h, m, w, key := inferenceHTTPFixture(t)
	onlineHTTP(t, h, w.ID)
	for _, path := range []string{"/api/v1/requests", "/api/v1/requests/abc", "/api/v1/requests/abc/cancel"} {
		method := "GET"
		if path == "/api/v1/requests" || strings.HasSuffix(path, "cancel") {
			method = "POST"
		}
		for _, credential := range []string{"", key, "admin-private-sentinel", "portal-private-sentinel"} {
			if got := call(h, method, path, "Bearer "+credential, nil); got.Code != 401 {
				t.Fatal("wrong role accepted", path, got.Code)
			}
		}
	}
	for _, headers := range [][]string{{""}, {"has spaces"}, {strings.Repeat("x", 101)}, {"one", "two"}} {
		r := httptest.NewRequest("POST", "/api/v1/requests", strings.NewReader(`{}`))
		r.Header.Set("Authorization", "Bearer client-private-sentinel")
		for _, value := range headers {
			r.Header.Add("X-Muse-Session-Id", value)
		}
		out := httptest.NewRecorder()
		h.ServeHTTP(out, r)
		if out.Code != 400 {
			t.Fatal("invalid session header accepted")
		}
	}
	for _, body := range []string{`{}`, `null`, `{"protocol_version":1,"protocol_version":1}`, `{"protocol_version":1,"submission_id":"x","worker_id":"` + w.ID + `","messages":[],"tools":[],"context_probe":{"kind":"delta"}}`, `{"protocol_version":1,"submission_id":"x","worker_id":"` + w.ID + `","messages":[{"type":"message","role":"user","text":"x","extra":true}],"tools":[]}`} {
		if got := call(h, "POST", "/api/v1/requests", "Bearer client-private-sentinel", strings.NewReader(body)); got.Code != 400 {
			t.Fatal("invalid body accepted", got.Code)
		}
	}
	for _, path := range []string{"/api/v1/admin/conversations", "/api/v1/admin/conversations/id", "/api/v1/admin/conversations/id/timeline", "/api/v1/admin/requests", "/api/v1/admin/requests/id"} {
		if got := call(h, "GET", path, "Bearer client-private-sentinel", nil); got.Code != 401 {
			t.Fatal("client authorized admin history")
		}
		if got := call(h, "GET", path, "Bearer admin-private-sentinel", nil); got.Code != 200 {
			t.Fatal("admin history route unavailable", path, got.Code)
		}
	}
	for _, path := range []string{"/api/v1/admin/conversations?limit=0", "/api/v1/admin/conversations?limit=101", "/api/v1/admin/conversations?limit=no", "/api/v1/admin/conversations?limit=1&limit=2", "/api/v1/admin/conversations?limit=", "/api/v1/admin/conversations?x=1", "/api/v1/admin/conversations?conversation_id=x", "/api/v1/admin/requests?conversation_id=bad%20id", "/api/v1/admin/requests/id?limit=1", "/api/v1/admin/conversations?cursor=bad", "/api/v1/admin/conversations?bad=%", "/api/v1/requests?x=1"} {
		credential := "admin-private-sentinel"
		if strings.HasPrefix(path, "/api/v1/requests") {
			credential = "client-private-sentinel"
		}
		if got := call(h, "GET", path, "Bearer "+credential, nil); got.Code != 400 && got.Code != 405 {
			t.Fatal("bad query accepted", path, got.Code)
		}
	}
	q, err := parseHistoryQuery(httptest.NewRequest("GET", "/api/v1/admin/requests?limit=2&conversation_id=conversation", nil), "/api/v1/admin/requests", "")
	if err != nil || q.Limit != 2 || q.ConversationID != "conversation" {
		t.Fatal("valid query rejected")
	}
	cursor, _ := inference.EncodeCursor(inference.PageCursor{Kind: "timeline", ID: "conversation", Sequence: 2})
	if _, err = parseHistoryQuery(httptest.NewRequest("GET", "/api/v1/admin/conversations/conversation/timeline?cursor="+cursor, nil), "/api/v1/admin/conversations/{id}/timeline", "conversation"); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/requests/bad%20id", "/api/v1/requests/id/unknown", "/api/v1/admin/conversations/id/unknown"} {
		if got := call(h, "GET", path, "Bearer admin-private-sentinel", nil); got.Code != 404 {
			t.Fatal("unsupported route accepted")
		}
	}
	m.fail = errors.New("history storage unavailable")
	apiJSON(t, h, "GET", "/api/v1/admin/requests", "admin-private-sentinel", nil, 503)
	h.Broker = nil
	nativeHTTP(t, h, "POST", "/api/v1/requests", "", nativeHTTPInput(w.ID), 503)
}
