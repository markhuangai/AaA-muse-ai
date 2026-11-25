package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

type httpInferenceStore struct {
	workers  *httpWorkerStore
	states   map[string]*inference.State
	receipts map[string]*inference.Receipt
	native   map[string]inference.NativeWorkReceipt
	fail     error
	output   *bytes.Buffer
	capture  *diagnostics.Store
	sequence int64
}

func (m *httpInferenceStore) WithinPull(ctx context.Context, digest [32]byte, input inference.Pull, _ string, capability int, _ worker.Contact, _ worker.UpdateBroker, claim func(*inference.State) (*inference.Grant, error)) (inference.PullResult, string, bool, inference.PullTiming, error) {
	identity, err := m.workers.AuthenticateWorker(ctx, digest)
	if err != nil {
		return inference.PullResult{}, "", false, inference.PullTiming{}, err
	}
	var result inference.PullResult
	err = m.withinRouting(inference.Ref{WorkerID: identity.ID}, func(pool *inference.State) error {
		worker := pool.Pool[identity.ID]
		worker.LastPollAt, worker.LastContactAt = &pool.Now, &pool.Now
		var candidate *inference.Job
		for _, job := range pool.Jobs {
			if job.WorkerID == identity.ID && job.Held {
				return nil
			}
			if job.State != "queued" || (job.WorkerID != "" && job.WorkerID != identity.ID) || (job.Media != nil && capability == 0) {
				continue
			}
			if candidate == nil || job.CreatedAt.Before(candidate.CreatedAt) {
				candidate = job
			}
		}
		if candidate == nil {
			return nil
		}
		selected := *pool
		selected.Jobs = map[string]*inference.Job{candidate.ID: candidate}
		result.Job, err = claim(&selected)
		if err == nil && result.Job != nil && inference.HookClaim(result.Job.ClaimID) {
			pair, _ := inference.PairedHook(ctx)
			if m.native == nil {
				m.native = make(map[string]inference.NativeWorkReceipt)
			}
			m.native[result.Job.ClaimID] = inference.NativeWorkReceipt{Mode: "hook", Pair: pair, Checker: input.Checker, Occurrence: input.Occurrence}
		}
		return err
	})
	return result, identity.ID, false, inference.PullTiming{}, err
}

func (m *httpInferenceStore) InferenceWorkers(context.Context) ([]string, error) { return nil, m.fail }
func (m *httpInferenceStore) WithinInference(_ context.Context, ref inference.Ref, fn func(*inference.State) error) error {
	if m.fail != nil {
		return m.fail
	}
	if ref.Routing {
		return m.withinRouting(ref, fn)
	}
	if err := httpHistoryScope(m.states, &ref); err != nil {
		return err
	}
	wid := ref.WorkerID
	if ref.ExperimentID != "" || ref.JobID != "" {
		found := false
		for id, s := range m.states {
			if s.Experiments[ref.ExperimentID] != nil || s.Jobs[ref.JobID] != nil {
				wid, found = id, true
				break
			}
		}
		if !found {
			return inference.Reject("inference_not_found", 404)
		}
	}
	if _, ok := m.workers.records[wid]; !ok && (wid != "" || m.states[wid] == nil) {
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
	s.HistoryConversationID = ref.ConversationID
	s.PendingTools = 0
	for _, c := range s.Conversations {
		c.Events = nil
		if c.PendingCallID != "" {
			s.PendingTools++
		}
	}
	for _, request := range s.Requests {
		if s.Conversations == nil {
			s.Conversations = map[string]*inference.Conversation{}
		}
		if s.Conversations[request.ConversationID] != nil {
			continue
		}
		for _, other := range m.states {
			if c := other.Conversations[request.ConversationID]; c != nil {
				data, err := json.Marshal(c)
				if err != nil {
					return err
				}
				var copied inference.Conversation
				decoder := json.NewDecoder(bytes.NewReader(data))
				decoder.UseNumber()
				if err = decoder.Decode(&copied); err != nil {
					return err
				}
				s.Conversations[c.ID] = &copied
				break
			}
		}
	}
	for id, request := range s.Requests {
		if e := s.Experiments[id]; e != nil {
			e.Messages = inference.Messages(s.Conversations[request.ConversationID], request.CanonicalEnd)
		}
	}
	s.Revoked = m.workers.records[wid].RevokedAt != nil
	s.Receipt = m.receipts[ref.Principal+":"+ref.SubmissionID]
	job := s.Jobs[ref.JobID]
	if ref.NativeWork && job != nil {
		if prior, ok := m.native[job.LeaseID]; ok {
			s.NativeWork = &prior
		}
	}
	if err = fn(&s); err != nil {
		return err
	}
	if s.NativeWork != nil {
		m.native[job.LeaseID] = *s.NativeWork
		s.NativeWork = nil
	}
	if s.Receipt != nil {
		m.receipts[ref.Principal+":"+ref.SubmissionID] = s.Receipt
	}
	s.Receipt = nil
	for _, c := range s.Conversations {
		c.Events = nil
	}
	for id, c := range s.Conversations {
		if c.WorkerID != wid && m.states[c.WorkerID] != nil {
			if m.states[c.WorkerID].Conversations == nil {
				m.states[c.WorkerID].Conversations = map[string]*inference.Conversation{}
			}
			m.states[c.WorkerID].Conversations[id] = c
			delete(s.Conversations, id)
		}
	}
	m.states[wid] = &s
	return nil
}

func inferenceHTTPFixture(t *testing.T) (*Handler, *httpInferenceStore, workerView, string) {
	h, workers, output, capture := workerHTTPFixture(t)
	w, key := enrollHTTP(t, h, issueHTTP(t, h))
	m := &httpInferenceStore{workers: workers, states: map[string]*inference.State{}, receipts: map[string]*inference.Receipt{}, output: output, capture: capture}
	m.states[w.ID] = &inference.State{WorkerID: w.ID}
	h.Broker = service.NewBroker(m, rand.Reader, time.Now, func(context.Context, time.Duration) error { return context.Canceled })
	return h, m, w, key
}

func pullAndStartHTTP(t *testing.T, h *Handler, m *httpInferenceStore, key string, media bool) inference.Job {
	t.Helper()
	m.sequence++
	stamp := time.Now().UTC()
	var pulled inference.PullResult
	poll := inference.Pull{Version: 1, Sequence: m.sequence, Checker: "checker", Occurrence: fmt.Sprintf("tick-%d", m.sequence), ScheduledAt: stamp, EnteredAt: stamp, MediaJobs: media}
	nativeResponse(t, nativePost(h, "/api/v1/worker/pull", key, poll), 200, &pulled)
	if pulled.Job == nil {
		t.Fatal("no queued fixture job")
	}
	var started inference.Job
	nativeResponse(t, nativePost(h, "/api/v1/worker/jobs/"+pulled.Job.JobID+"/start", key, inference.WorkStart{
		Version: 1, ClaimID: pulled.Job.ClaimID, Generation: pulled.Job.Generation, LaunchID: "launch", NativeJob: "once",
	}), 200, &started)
	return started
}

func submitAndSettleHTTP(t *testing.T, h *Handler, key string, job inference.Job, decision inference.Item) {
	t.Helper()
	path := "/api/v1/worker/jobs/" + job.ID
	apiJSON(t, h, "POST", path+"/decisions", key, inference.Submit{
		Claim: inference.Claim{Version: 1, SubmissionID: "decision-" + job.ID}, ConversationID: job.ConversationID,
		Generation: job.Generation, LeaseID: job.LeaseID, ContextReceiptID: job.Context.ReceiptID, Decision: decision,
	}, 200)
	apiJSON(t, h, "POST", path+"/interrupt", key, inference.Interruption{
		Version: 1, SubmissionID: "settlement-" + job.ID, ClaimID: job.LeaseID, Generation: job.Generation,
		LaunchID: "launch", NativeJob: "once", NativeRun: "execution", Reason: "execution_confirmed_stopped",
	}, 200)
}

func apiJSON(t *testing.T, h *Handler, method, path, key string, input any, want int) map[string]any {
	t.Helper()
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(pairedWorkInput(input))
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
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	h := pullHTTP(t, filepath.Join(root, "broker.sqlite3"))
	key := enrollNative(t, h)
	workerID := apiJSON(t, h, "GET", "/api/v1/worker/status", key, nil, 200)["id"].(string)
	input := map[string]any{"protocol_version": 1, "submission_id": "create", "worker_id": workerID, "messages": []any{map[string]any{"type": "message", "role": "user", "text": "private client fixture"}}, "tools": []any{map[string]any{"name": "read_file", "parameters": map[string]any{"type": "object"}}}}
	e := apiJSON(t, h, "POST", "/api/v1/admin/experiments", "admin-private-sentinel", input, 201)
	id, job := e["id"].(string), e["current_job_id"].(string)
	apiJSON(t, h, "GET", "/api/v1/admin/experiments/"+id, "admin-private-sentinel", nil, 200)
	stamp := time.Now().UTC()
	var pulled inference.PullResult
	nativeResponse(t, nativePost(h, "/api/v1/worker/pull", key, inference.Pull{Version: 1, Sequence: 1, Checker: "checker", Occurrence: "tick", ScheduledAt: stamp, EnteredAt: stamp}), 200, &pulled)
	if pulled.Job == nil || pulled.Job.JobID != job {
		t.Fatal("targeted experiment was not pulled")
	}
	var started inference.Job
	nativeResponse(t, nativePost(h, "/api/v1/worker/jobs/"+job+"/start", key, inference.WorkStart{Version: 1, ClaimID: pulled.Job.ClaimID, Generation: pulled.Job.Generation, LaunchID: "launch", NativeJob: "once"}), 200, &started)
	decision := inference.Submit{Claim: inference.Claim{Version: 1, SubmissionID: "decision"}, ConversationID: started.ConversationID, Generation: started.Generation, LeaseID: started.LeaseID, ContextReceiptID: started.Context.ReceiptID, Decision: inference.Item{Type: "tool_call", CallID: "client-call", Name: "read_file", Arguments: map[string]any{"path": "client-only"}}}
	got := apiJSON(t, h, "POST", "/api/v1/worker/jobs/"+job+"/decisions", key, decision, 200)
	if got["state"] != "waiting_for_tool" {
		t.Fatal("tool call not exposed")
	}
	apiJSON(t, h, "POST", "/api/v1/admin/experiments/"+id+"/tool-results", "admin-private-sentinel", map[string]any{"protocol_version": 1, "submission_id": "result", "call_id": "client-call", "output": "exact"}, 202)
	got = apiJSON(t, h, "POST", "/api/v1/admin/experiments/"+id+"/cancel", "admin-private-sentinel", map[string]any{"protocol_version": 1, "submission_id": "cancel"}, 200)
	if got["state"] != "cancelled" {
		t.Fatal("cancellation delayed")
	}
	status := apiJSON(t, h, "GET", "/api/v1/worker/status", key, nil, 200)
	if status["connection_status"] != "recent" || status["inference_readiness"] != "unverified" {
		t.Fatal("connection/readiness conflated")
	}
	apiJSON(t, h, "GET", "/api/v1/admin/workers", "admin-private-sentinel", nil, 200)
	apiJSON(t, h, "PATCH", "/api/v1/admin/workers/"+workerID, "admin-private-sentinel", map[string]any{"name": "live renamed"}, 200)
	apiJSON(t, h, "POST", "/api/v1/admin/workers/"+workerID+"/revoke", "admin-private-sentinel", nil, 200)
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
	apiJSON(t, h, "GET", "/api/v1/worker/status", "admin-private-sentinel", nil, 401)
	for _, route := range []string{"/api/v1/worker/pull", "/api/v1/worker/jobs/" + w.ID + "/start", "/api/v1/worker/jobs/" + w.ID + "/interrupt", "/api/v1/worker/jobs/" + w.ID + "/decisions"} {
		apiJSON(t, h, "POST", route, "admin-private-sentinel", nil, 401)
	}
	for _, body := range []string{`{}`, `null`, `{"protocol_version":1,"submission_id":"x","worker_id":"x","messages":[],"tools":[],"extra":true}`, `{"protocol_version":1,"protocol_version":1}`, `{} {}`, `{"protocol_version":null}`, `{"messages":[{"type":"media"}]}`} {
		if got := call(h, "POST", "/api/v1/admin/experiments", "Bearer admin-private-sentinel", strings.NewReader(body)); got.Code != 400 {
			t.Fatal("invalid input accepted", body, got.Code)
		}
	}
	base := map[string]any{"protocol_version": 1, "submission_id": "alias", "worker_id": w.ID, "messages": []any{map[string]any{"type": "message", "role": "user", "text": "x"}}, "tools": []any{}}
	statesBefore, err := json.Marshal(m.states)
	if err != nil {
		t.Fatal(err)
	}
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
		statesAfter, err := json.Marshal(m.states)
		if err != nil || !bytes.Equal(statesBefore, statesAfter) || len(m.receipts) != 0 {
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

func TestRetiredWorkerRoutesDoNotProvideAuthority(t *testing.T) {
	h, _, w, key := inferenceHTTPFixture(t)
	apiJSON(t, h, "GET", "/api/v1/worker/events", key, nil, 404)
	apiJSON(t, h, "GET", "/api/v1/worker/jobs/"+w.ID, key, nil, 404)
	for _, path := range []string{"/api/v1/worker/heartbeat", "/api/v1/worker/jobs/" + w.ID + "/claim", "/api/v1/worker/upgrade-reservation"} {
		apiJSON(t, h, "POST", path, key, nil, 404)
	}
	wrapped := &responseWriterProbe{header: http.Header{}}
	h.ServeHTTP(wrapped, httptest.NewRequest("GET", "/healthz", nil))
}

func TestNativeInterruptionEvidencePersistsAcrossReceiptReplay(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	h := pullHTTPClock(t, filepath.Join(mediaSQLiteDirectory(t), "state.sqlite3"), func() time.Time { return now })
	key := enrollNative(t, h)
	var enrolled workerView
	nativeResponse(t, call(h, http.MethodGet, "/api/v1/worker/status", "Bearer "+key, nil), 200, &enrolled)
	var task inference.Experiment
	nativeResponse(t, versionedHTTP(h, http.MethodPost, "/api/v1/admin/experiments", testManagementKey, worker.Contact{}, inference.Create{
		Version: 1, SubmissionID: "evidence", WorkerID: enrolled.ID, TimeoutSeconds: 300,
		Messages: []inference.Item{{Type: "message", Role: "user", Text: "fixture"}}, Tools: []inference.Tool{},
	}), 201, &task)
	var pulled inference.PullResult
	nativeResponse(t, nativePost(h, "/api/v1/worker/pull", key, inference.Pull{Version: 1, Sequence: 1,
		Checker: "checker", Occurrence: "pickup", ScheduledAt: now, EnteredAt: now}), 200, &pulled)
	if pulled.Job == nil || pulled.Job.JobID != task.CurrentJobID {
		t.Fatal("worker did not claim the task")
	}
	job := pulled.Job
	route := "/api/v1/worker/jobs/" + job.JobID
	nativeResponse(t, nativePost(h, route+"/start", key, inference.WorkStart{Version: 1, ClaimID: job.ClaimID,
		Generation: job.Generation, LaunchID: "launch", NativeJob: "once"}), 200, nil)
	input := inference.Interruption{Version: 1, SubmissionID: "stopped", ClaimID: job.ClaimID, Generation: job.Generation,
		LaunchID: "launch", NativeJob: "once", NativeRun: "execution", Reason: "execution_confirmed_stopped"}
	settle := func(metadata ...string) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(pairedTestStop(input))
		if err != nil {
			t.Fatal(err)
		}
		request := pairedRequest(h, http.MethodPost, route+"/interrupt", bytes.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+key)
		request.Header.Set(service.WorkerVersionHeader, service.DevelopmentVersion)
		for _, value := range metadata {
			request.Header.Add("X-Muse-Interruption", value)
		}
		result := httptest.NewRecorder()
		h.ServeHTTP(result, request)
		return result
	}
	nativeResponse(t, settle("running"), 400, nil)
	nativeResponse(t, settle("failed", "completed"), 400, nil)
	input.Reason, input.NativeRun = "native_cancelled_before_start", ""
	nativeResponse(t, settle("cancelled"), 400, nil)
	input.Reason, input.NativeRun = "execution_confirmed_stopped", "execution"
	first := settle("failed")
	nativeResponse(t, first, 200, nil)
	again := settle("completed")
	nativeResponse(t, again, 200, nil)
	if !bytes.Equal(first.Body.Bytes(), again.Body.Bytes()) {
		t.Fatal("optional interruption evidence changed the settlement receipt")
	}
	var recorded struct {
		inference.Experiment
		Message string `json:"reason_message"`
	}
	nativeResponse(t, call(h, http.MethodGet, "/api/v1/admin/experiments/"+task.ID, "Bearer "+testManagementKey, nil), 200, &recorded)
	if recorded.Interruption == nil || recorded.Interruption.NativeStatus != "failed" ||
		recorded.Interruption.Stage != "native_execution" || !strings.Contains(recorded.Message, "native run failed") {
		t.Fatal("the first native outcome and execution stage were not preserved")
	}
}

type responseWriterProbe struct{ header http.Header }

func (w *responseWriterProbe) Header() http.Header       { return w.header }
func (*responseWriterProbe) WriteHeader(int)             {}
func (*responseWriterProbe) Write(p []byte) (int, error) { return len(p), nil }
