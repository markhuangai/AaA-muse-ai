package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

type httpInferenceStore struct {
	workers  *httpWorkerStore
	states   map[string]*inference.State
	receipts map[string]*inference.Receipt
	fail     error
}

func (m *httpInferenceStore) InferenceWorkers(context.Context) ([]string, error) { return nil, m.fail }
func (m *httpInferenceStore) WithinInference(_ context.Context, ref inference.Ref, fn func(*inference.State) error) error {
	if m.fail != nil {
		return m.fail
	}
	wid := ref.WorkerID
	if ref.ExperimentID != "" || ref.JobID != "" {
		wid = ""
		for id, s := range m.states {
			if s.Experiments[ref.ExperimentID] != nil || s.Jobs[ref.JobID] != nil {
				wid = id
			}
		}
	}
	if _, ok := m.workers.records[wid]; !ok {
		return inference.Reject("inference_not_found", 404)
	}
	if ref.WorkerAuth != "" && ref.WorkerAuth != wid {
		return inference.Reject("worker_scope_denied", 404)
	}
	if m.states[wid] == nil {
		m.states[wid] = &inference.State{WorkerID: wid, Experiments: map[string]*inference.Experiment{}, Jobs: map[string]*inference.Job{}}
	}
	data, err := json.Marshal(m.states[wid])
	if err != nil {
		return err
	}
	var s inference.State
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err = d.Decode(&s); err != nil {
		return err
	}
	s.Now = time.Now()
	s.Revoked = m.workers.records[wid].RevokedAt != nil
	s.Receipt = m.receipts[ref.Principal+":"+ref.SubmissionID]
	for _, state := range m.states {
		for _, e := range state.Experiments {
			if !e.Terminal() {
				s.ActiveCount++
			}
		}
	}
	if err = fn(&s); err != nil {
		return err
	}
	if s.Receipt != nil {
		m.receipts[ref.Principal+":"+ref.SubmissionID] = s.Receipt
	}
	s.Receipt = nil
	m.states[wid] = &s
	return nil
}

func inferenceHTTPFixture(t *testing.T) (*Handler, *httpInferenceStore, workerView, string) {
	h, workers, _, _ := workerHTTPFixture(t)
	w, key := enrollHTTP(t, h, issueHTTP(t, h))
	m := &httpInferenceStore{workers: workers, states: map[string]*inference.State{}, receipts: map[string]*inference.Receipt{}}
	h.Broker = service.NewBroker(m, rand.Reader, time.Now, func(context.Context, time.Duration) error { return context.Canceled }, 2)
	return h, m, w, key
}

func onlineHTTP(t *testing.T, h *Handler, wid string) inference.Connection {
	t.Helper()
	data, err := h.Broker.Open(context.Background(), h.Logger, wid)
	if err != nil {
		t.Fatal(err)
	}
	var c inference.Connection
	if err = json.Unmarshal(data, &c); err != nil {
		t.Fatal(err)
	}
	if _, err = h.Broker.Heartbeat(context.Background(), h.Logger, wid, inference.Heartbeat{Version: 1, ConnectionID: c.ID, Generation: c.Generation, ChallengeID: c.Challenges[0].ID}); err != nil {
		t.Fatal(err)
	}
	return c
}

func apiJSON(t *testing.T, h *Handler, method, path, key string, input any, want int) map[string]any {
	t.Helper()
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(data)
	}
	w := call(h, method, path, "Bearer "+key, body)
	if w.Code != want {
		t.Fatalf("%s %s: expected %d, got %d: %s", method, path, want, w.Code, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestInferenceHTTPProductionLogicAndCapture(t *testing.T) {
	h, _, w, key := inferenceHTTPFixture(t)
	c := onlineHTTP(t, h, w.ID)
	input := map[string]any{"protocol_version": 1, "submission_id": "create", "worker_id": w.ID, "messages": []any{map[string]any{"type": "message", "role": "user", "text": "private client fixture"}}, "tools": []any{map[string]any{"name": "read_file", "parameters": map[string]any{"type": "object"}}}}
	e := apiJSON(t, h, "POST", "/api/v1/admin/experiments", "admin-private-sentinel", input, 201)
	id, job := e["id"].(string), e["current_job_id"].(string)
	apiJSON(t, h, "GET", "/api/v1/admin/experiments/"+id, "admin-private-sentinel", nil, 200)
	apiJSON(t, h, "GET", "/api/v1/worker/jobs/"+job, key, nil, 200)
	claim := map[string]any{"protocol_version": 1, "submission_id": "claim", "connection_id": c.ID, "connection_generation": c.Generation}
	j := apiJSON(t, h, "POST", "/api/v1/worker/jobs/"+job+"/claim", key, claim, 200)
	decision := map[string]any{"protocol_version": 1, "submission_id": "decision", "connection_id": c.ID, "connection_generation": c.Generation, "conversation_id": j["conversation_id"], "generation": j["generation"], "lease_id": j["lease_id"], "context_receipt_id": j["context"].(map[string]any)["receipt_id"], "decision": map[string]any{"type": "tool_call", "call_id": "client-call", "name": "read_file", "arguments": map[string]any{}}}
	got := apiJSON(t, h, "POST", "/api/v1/worker/jobs/"+job+"/decisions", key, decision, 200)
	if got["state"] != "waiting_for_tool" {
		t.Fatal("tool call not exposed")
	}
	apiJSON(t, h, "POST", "/api/v1/admin/experiments/"+id+"/tool-results", "admin-private-sentinel", map[string]any{"protocol_version": 1, "submission_id": "result", "call_id": "client-call", "output": "exact"}, 202)
	got = apiJSON(t, h, "POST", "/api/v1/admin/experiments/"+id+"/cancel", "admin-private-sentinel", map[string]any{"protocol_version": 1, "submission_id": "cancel"}, 200)
	if got["state"] != "cancelled" {
		t.Fatal("cancellation delayed")
	}
	apiJSON(t, h, "POST", "/api/v1/worker/heartbeat", key, map[string]any{"protocol_version": 1, "connection_id": c.ID, "connection_generation": c.Generation, "challenge_id": c.Challenges[0].ID}, 200)
	status := apiJSON(t, h, "GET", "/api/v1/worker/status", key, nil, 200)
	if status["connection_status"] != "online" || status["inference_readiness"] != "unverified" {
		t.Fatal("connection/readiness conflated")
	}
	apiJSON(t, h, "GET", "/api/v1/admin/workers", "admin-private-sentinel", nil, 200)
	apiJSON(t, h, "PATCH", "/api/v1/admin/workers/"+w.ID, "admin-private-sentinel", map[string]any{"name": "live renamed"}, 200)
	apiJSON(t, h, "POST", "/api/v1/admin/workers/"+w.ID+"/revoke", "admin-private-sentinel", nil, 200)
	export := call(h, "GET", "/api/v1/admin/diagnostics/export?operation_id="+id, "Bearer admin-private-sentinel", nil)
	if export.Code != 200 || !strings.Contains(export.Body.String(), "event") {
		t.Fatal("correlated protected capture unavailable")
	}
}

func TestInferenceHTTPBoundaries(t *testing.T) {
	h, m, w, key := inferenceHTTPFixture(t)
	for _, route := range []struct{ method, path string }{
		{"POST", "/api/v1/admin/experiments"}, {"GET", "/api/v1/admin/experiments/" + w.ID}, {"POST", "/api/v1/admin/experiments/" + w.ID + "/cancel"}, {"POST", "/api/v1/admin/experiments/" + w.ID + "/tool-results"},
	} {
		for _, k := range []string{key, "client-private-sentinel", "portal-private-sentinel", ""} {
			apiJSON(t, h, route.method, route.path, k, nil, 401)
		}
	}
	for _, route := range []string{"/api/v1/worker/events", "/api/v1/worker/jobs/" + w.ID} {
		apiJSON(t, h, "GET", route, "admin-private-sentinel", nil, 401)
	}
	for _, route := range []string{"/api/v1/worker/heartbeat", "/api/v1/worker/jobs/" + w.ID + "/claim", "/api/v1/worker/jobs/" + w.ID + "/decisions"} {
		apiJSON(t, h, "POST", route, "admin-private-sentinel", nil, 401)
	}
	for _, body := range []string{`{}`, `null`, `{"protocol_version":1,"submission_id":"x","worker_id":"x","messages":[],"tools":[],"extra":true}`, `{"protocol_version":1,"protocol_version":1}`, `{} {}`, `{"protocol_version":null}`, `{"messages":[{"type":"media"}]}`} {
		if got := call(h, "POST", "/api/v1/admin/experiments", "Bearer admin-private-sentinel", strings.NewReader(body)); got.Code != 400 {
			t.Fatal("invalid input accepted", body, got.Code)
		}
	}
	base := map[string]any{"protocol_version": 1, "submission_id": "alias", "worker_id": w.ID, "messages": []any{map[string]any{"type": "message", "role": "user", "text": "x"}}, "tools": []any{}}
	for _, extra := range []map[string]any{
		{"TIMEOUT_SECONDS": 1},
		{"timeout_seconds": 300, "TIMEOUT_SECONDS": 1},
		{"tools": []any{map[string]any{"name": "read_file", "Name": "other", "parameters": map[string]any{}}}},
		{"context_probe": map[string]any{"kind": "full", "Kind": "delta"}},
	} {
		input := map[string]any{}
		for k, v := range base {
			input[k] = v
		}
		for k, v := range extra {
			input[k] = v
		}
		apiJSON(t, h, "POST", "/api/v1/admin/experiments", "admin-private-sentinel", input, 400)
		if len(m.states) != 0 || len(m.receipts) != 0 {
			t.Fatal("rejected structural alias reached business mutation")
		}
	}
	for _, route := range []string{"/api/v1/admin/experiments/invalid", "/api/v1/worker/jobs/" + w.ID + "/unknown", "/api/v1/admin/experiments/" + w.ID + "/unknown"} {
		apiJSON(t, h, "GET", route, "admin-private-sentinel", nil, 404)
	}
	m.fail = errors.New("storage unavailable")
	apiJSON(t, h, "GET", "/api/v1/admin/workers", "admin-private-sentinel", nil, 503)
	apiJSON(t, h, "GET", "/api/v1/worker/status", key, nil, 503)
	apiJSON(t, h, "PATCH", "/api/v1/admin/workers/"+w.ID, "admin-private-sentinel", map[string]any{"name": "renamed"}, 503)
	apiJSON(t, h, "POST", "/api/v1/admin/workers/"+w.ID+"/revoke", "admin-private-sentinel", nil, 503)
	h.Broker = nil
	apiJSON(t, h, "POST", "/api/v1/admin/experiments", "admin-private-sentinel", nil, 503)
	recorder := httptest.NewRecorder()
	inferenceError(recorder, inference.Reject("revoked", 401))
	if recorder.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatal("missing auth challenge")
	}
	var value any
	if decodeInferenceInput([]byte(`{"required":null}`), &value, "required") == nil {
		t.Fatal("null required field accepted")
	}
}

func TestSSEUsesRealWritesAndBoundedCapture(t *testing.T) {
	h, _, w, key := inferenceHTTPFixture(t)
	server := httptest.NewServer(h)
	defer server.Close()
	r, err := http.NewRequest("GET", server.URL+"/api/v1/worker/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !bytes.Contains(body, []byte("event: health.challenge")) || !bytes.Contains(body, []byte("event: connection.opened")) {
		t.Fatal("SSE events unavailable")
	}
	p, err := h.Broker.Projection(context.Background(), h.Logger, w.ID, true)
	if err != nil || p.ConnectionStatus != "offline" {
		t.Fatal("closed stream remained online")
	}
	if call(h, "GET", "/api/v1/worker/events", "Bearer "+key, nil).Code != 503 {
		t.Fatal("unsupported stream writer accepted")
	}
	wrapped := &responseWriterProbe{header: http.Header{}}
	h.ServeHTTP(wrapped, httptest.NewRequest("GET", "/healthz", nil))
}

type responseWriterProbe struct{ header http.Header }

func (w *responseWriterProbe) Header() http.Header       { return w.header }
func (*responseWriterProbe) WriteHeader(int)             {}
func (*responseWriterProbe) Write(p []byte) (int, error) { return len(p), nil }
