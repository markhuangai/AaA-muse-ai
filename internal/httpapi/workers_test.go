package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/postgres"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

type httpWorkerStore struct {
	codes   map[[32]byte]worker.Enrollment
	keys    map[[32]byte]string
	records map[string]worker.Record
	fail    error
}

func (m *httpWorkerStore) IssueEnrollment(_ context.Context, id string, hash [32]byte, ttl time.Duration) (worker.Enrollment, error) {
	e := worker.Enrollment{ID: id, CreatedAt: time.Now().UTC()}
	e.ExpiresAt = e.CreatedAt.Add(ttl)
	if m.fail != nil {
		return worker.Enrollment{}, m.fail
	}
	m.codes[hash] = e
	return e, nil
}
func (m *httpWorkerStore) ConsumeEnrollment(_ context.Context, hash [32]byte, id string, key [32]byte, name string) (worker.Record, worker.Enrollment, error) {
	if m.fail != nil {
		return worker.Record{}, worker.Enrollment{}, m.fail
	}
	e, ok := m.codes[hash]
	if !ok {
		return worker.Record{}, e, &worker.Rejection{Reason: "enrollment_invalid"}
	}
	if e.ConsumedAt != nil {
		return worker.Record{}, e, &worker.Rejection{Reason: "enrollment_used", Enrollment: e, WorkerID: e.WorkerID}
	}
	now := time.Now().UTC()
	e.ConsumedAt, e.WorkerID = &now, id
	m.codes[hash] = e
	w := worker.Record{ID: id, Name: name, RegisteredAt: now, LastContactAt: &now}
	m.records[id] = w
	m.keys[key] = id
	return w, e, nil
}
func (m *httpWorkerStore) AuthenticateWorker(_ context.Context, hash [32]byte) (worker.Record, error) {
	if m.fail != nil {
		return worker.Record{}, m.fail
	}
	w, ok := m.records[m.keys[hash]]
	if !ok {
		return w, &worker.Rejection{Reason: "invalid_worker_credential"}
	}
	if w.RevokedAt != nil {
		return w, &worker.Rejection{Reason: "worker_revoked", WorkerID: w.ID}
	}
	return w, nil
}
func (m *httpWorkerStore) Workers(context.Context) ([]worker.Record, error) {
	if m.fail != nil {
		return nil, m.fail
	}
	all := []worker.Record{}
	for _, w := range m.records {
		all = append(all, w)
	}
	return all, nil
}
func (m *httpWorkerStore) RenameWorker(_ context.Context, id, name string) (worker.Record, worker.Record, error) {
	if m.fail != nil {
		return worker.Record{}, worker.Record{}, m.fail
	}
	w, ok := m.records[id]
	if !ok {
		return w, w, &worker.Rejection{Reason: "worker_not_found"}
	}
	after := w
	after.Name = name
	m.records[id] = after
	return w, after, nil
}
func (m *httpWorkerStore) RevokeWorker(_ context.Context, id string) (worker.Record, worker.Record, error) {
	if m.fail != nil {
		return worker.Record{}, worker.Record{}, m.fail
	}
	w, ok := m.records[id]
	if !ok {
		return w, w, &worker.Rejection{Reason: "worker_not_found"}
	}
	before := w
	if w.RevokedAt == nil {
		now := time.Now().UTC()
		w.RevokedAt = &now
		m.records[id] = w
	}
	return before, w, nil
}

func workerHTTPFixture(t *testing.T) (*Handler, *httpWorkerStore, *bytes.Buffer, *diagnostics.Store) {
	h, _, out, capture := fixture(t)
	m := &httpWorkerStore{codes: map[[32]byte]worker.Enrollment{}, keys: map[[32]byte]string{}, records: map[string]worker.Record{}}
	h.Workers = service.NewWorkers(m, h.Authority, rand.Reader, time.Now)
	return h, m, out, capture
}
func issueHTTP(t *testing.T, h *Handler) string {
	t.Helper()
	w := call(h, "POST", "/api/v1/admin/enrollments", "Bearer admin-private-sentinel", nil)
	var value struct {
		Code string `json:"enrollment_code"`
	}
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &value) != nil || !auth.ValidToken(value.Code, auth.EnrollmentPrefix) {
		t.Fatal("issue route failed")
	}
	return value.Code
}
func enrollHTTP(t *testing.T, h *Handler, code string) (workerView, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"enrollment_code": code})
	w := call(h, "POST", "/api/v1/worker/enroll", "", bytes.NewReader(body))
	var value struct {
		Worker     workerView `json:"worker"`
		Credential string     `json:"credential"`
	}
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &value) != nil || !auth.ValidToken(value.Credential, auth.WorkerPrefix) {
		t.Fatal("enrollment route failed")
	}
	return value.Worker, value.Credential
}
func capturedHTTP(t *testing.T, store *diagnostics.Store) []map[string]any {
	t.Helper()
	snapshot, err := store.Snapshot(diagnostics.Filter{})
	if err != nil || !snapshot.Metadata.Complete {
		t.Fatal("capture unavailable")
	}
	events := []map[string]any{}
	for _, file := range snapshot.Records {
		var payload bytes.Buffer
		for _, line := range bytes.Split(bytes.TrimSpace(file), []byte("\n")) {
			var record diagnostics.Record
			if json.Unmarshal(line, &record) != nil {
				t.Fatal("bad record")
			}
			payload.Write(mustDecode(t, record.Data))
		}
		var value map[string]any
		if json.Unmarshal(payload.Bytes(), &value) != nil {
			t.Fatal("bad event")
		}
		events = append(events, value)
	}
	return events
}

func TestWorkerHTTPIdentityAndManagement(t *testing.T) {
	h, _, out, capture := workerHTTPFixture(t)
	code := issueHTTP(t, h)
	a, keyA := enrollHTTP(t, h, code)
	b, keyB := enrollHTTP(t, h, issueHTTP(t, h))
	if a.ConnectionStatus != "not_observed" || a.InferenceReadiness != "unverified" || a.LastContactAt == nil {
		t.Fatal("registration claimed inference/connection facts")
	}
	status := call(h, "GET", "/api/v1/worker/status", "Bearer "+keyA, nil)
	var got workerView
	if status.Code != 200 || json.Unmarshal(status.Body.Bytes(), &got) != nil || got.ID != a.ID {
		t.Fatal("worker status not scoped")
	}
	r := httptest.NewRequest("GET", "/api/v1/worker/status", nil)
	r.Header.Set("Authorization", "Bearer "+keyA)
	r.Header.Set("X-Worker-Id", b.ID)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if json.Unmarshal(w.Body.Bytes(), &got) != nil || got.ID != a.ID {
		t.Fatal("caller ID overrode authority")
	}
	if call(h, "GET", "/api/v1/worker/status", keyA, nil).Code != 401 {
		t.Fatal("worker key accepted without Bearer scheme")
	}
	for _, route := range []struct{ method, path string }{{"POST", "/api/v1/admin/enrollments"}, {"GET", "/api/v1/admin/workers"}, {"PATCH", "/api/v1/admin/workers/" + b.ID}, {"POST", "/api/v1/admin/workers/" + b.ID + "/revoke"}} {
		for _, key := range []string{"", "client-private-sentinel", "portal-private-sentinel", keyA} {
			if call(h, route.method, route.path, "Bearer "+key, strings.NewReader(`{"name":"unauthorized"}`)).Code != 401 {
				t.Fatal("non-management role authorized")
			}
		}
	}
	for _, key := range []string{"", "admin-private-sentinel", "client-private-sentinel", "portal-private-sentinel"} {
		if call(h, "GET", "/api/v1/worker/status", "Bearer "+key, nil).Code != 401 {
			t.Fatal("non-worker role authenticated")
		}
	}
	rename := call(h, "PATCH", "/api/v1/admin/workers/"+a.ID, "Bearer admin-private-sentinel", strings.NewReader(`{"name":"  名称  "}`))
	if rename.Code != 200 || json.Unmarshal(rename.Body.Bytes(), &got) != nil || got.Name != "名称" || got.ID != a.ID {
		t.Fatal("rename failed")
	}
	if call(h, "GET", "/api/v1/worker/status", "Bearer "+keyA, nil).Code != 200 {
		t.Fatal("rename altered credential")
	}
	list := call(h, "GET", "/api/v1/admin/workers", "Bearer admin-private-sentinel", nil)
	if list.Code != 200 || !strings.Contains(list.Body.String(), a.ID) || !strings.Contains(list.Body.String(), b.ID) || strings.Contains(list.Body.String(), keyA) {
		t.Fatal("list lost identity or exposed credential")
	}
	for i := 0; i < 2; i++ {
		if call(h, "POST", "/api/v1/admin/workers/"+a.ID+"/revoke", "Bearer admin-private-sentinel", nil).Code != 200 {
			t.Fatal("revocation not idempotent")
		}
	}
	if call(h, "GET", "/api/v1/worker/status", "Bearer "+keyA, nil).Code != 401 || call(h, "GET", "/api/v1/worker/status", "Bearer "+keyB, nil).Code != 200 {
		t.Fatal("revocation not isolated")
	}
	encoded, _ := json.Marshal(capturedHTTP(t, capture))
	for _, secret := range []string{code, keyA, keyB, "private-sentinel"} {
		if bytes.Contains(encoded, []byte(secret)) || strings.Contains(out.String(), secret) {
			t.Fatal("diagnostics leaked authority")
		}
	}
	if !bytes.Contains(encoded, []byte("worker.scope_denied")) {
		t.Fatal("cross-worker denial lacks evidence")
	}
}

func TestWorkerHTTPInputsAndFailures(t *testing.T) {
	h, repo, _, _ := workerHTTPFixture(t)
	w, key := enrollHTTP(t, h, issueHTTP(t, h))
	path := "/api/v1/admin/workers/" + w.ID
	for _, body := range []string{"", `null`, `[]`, `{`, `{"name":null}`, `{"name":1}`, `{}`, `{"other":"x"}`, `{"name":"a","name":"b"}`, `{"name":"a"} {}`, `{"name":"a"} trailing`, `{"name":""}`, `{"name":"bad\nname"}`, "{\"name\":\"\xff\"}"} {
		if call(h, "PATCH", path, "Bearer admin-private-sentinel", strings.NewReader(body)).Code != 400 {
			t.Fatalf("invalid JSON/name accepted: %q", body)
		}
	}
	for _, test := range []struct {
		method, path, body string
		want               int
	}{{"GET", "/api/v1/worker/status?worker_id=other", "", 400}, {"GET", "/api/v1/worker/status", "body", 400}, {"GET", "/api/v1/admin/enrollments", "", 405}, {"PATCH", "/api/v1/admin/workers/" + strings.Repeat("0", 32), `{"name":"valid"}`, 404}, {"POST", "/api/v1/admin/workers/" + strings.Repeat("0", 32) + "/revoke", "", 404}, {"PATCH", path + "/unsupported", `{}`, 404}, {"POST", "/api/v1/admin/enrollments", `{"unexpected":true}`, 400}, {"PATCH", path, strings.Repeat("x", MaxBodyBytes+1), 413}} {
		authority := "Bearer admin-private-sentinel"
		if strings.Contains(test.path, "/worker/status") {
			authority = "Bearer " + key
		}
		if got := call(h, test.method, test.path, authority, strings.NewReader(test.body)); got.Code != test.want {
			t.Fatalf("boundary %s %s: %d", test.method, test.path, got.Code)
		}
	}
	if call(h, "POST", "/api/v1/worker/enroll", "", strings.NewReader(`{"enrollment_code":"invalid"}`)).Code != 400 {
		t.Fatal("invalid enrollment accepted")
	}
	code := issueHTTP(t, h)
	enrollHTTP(t, h, code)
	body, _ := json.Marshal(map[string]string{"enrollment_code": code})
	if call(h, "POST", "/api/v1/worker/enroll", "", bytes.NewReader(body)).Code != 409 {
		t.Fatal("reused enrollment accepted")
	}
	repo.fail = &postgres.Failure{Reason: "database_unavailable", Outcome: "not_started"}
	for _, test := range []struct{ method, path, body string }{{"POST", "/api/v1/admin/enrollments", ""}, {"POST", "/api/v1/worker/enroll", string(body)}, {"GET", "/api/v1/admin/workers", ""}, {"PATCH", path, `{"name":"valid"}`}, {"POST", path + "/revoke", ""}} {
		if call(h, test.method, test.path, "Bearer admin-private-sentinel", strings.NewReader(test.body)).Code != 503 {
			t.Fatal("storage failure hidden")
		}
	}
	if call(h, "GET", "/api/v1/worker/status", "Bearer "+key, nil).Code != 503 {
		t.Fatal("worker auth storage outage misclassified")
	}
	for _, reason := range []string{"enrollment_expired", "worker_not_found", "invalid_worker_name", "worker_revoked", "invalid_worker_credential"} {
		recorder := httptest.NewRecorder()
		workerError(recorder, &worker.Rejection{Reason: reason})
		if recorder.Code == 503 {
			t.Fatal("domain error became storage failure")
		}
	}
	h.Workers = nil
	if call(h, "POST", "/api/v1/worker/enroll", "", strings.NewReader(`{}`)).Code != 503 {
		t.Fatal("missing service ignored")
	}
}

func TestIssuedCredentialWriteFailureIsDiagnosable(t *testing.T) {
	h, repo, _, capture := workerHTTPFixture(t)
	code := issueHTTP(t, h)
	body, _ := json.Marshal(map[string]string{"enrollment_code": code})
	r := httptest.NewRequest("POST", "/api/v1/worker/enroll", bytes.NewReader(body))
	writer := &failWriter{header: http.Header{}, after: 0}
	h.ServeHTTP(writer, r)
	if len(repo.records) != 1 {
		t.Fatal("failed response lost durable issuance")
	}
	found := false
	for _, event := range capturedHTTP(t, capture) {
		if event["msg"] == "request.write_failed" {
			found = true
			if event["worker_id"] == "" || event["enrollment_id"] == "" || event["written_bytes"] != float64(0) {
				t.Fatal("interrupted issuance identity/outcome missing")
			}
		}
	}
	if !found {
		t.Fatal("write failure missing")
	}
	if call(h, "POST", "/api/v1/worker/enroll", "", bytes.NewReader(body)).Code != 409 {
		t.Fatal("lost response reissued authority")
	}
	h.Workers = service.NewWorkers(repo, h.Authority, bytes.NewReader(nil), time.Now)
	if call(h, "POST", "/api/v1/admin/enrollments", "Bearer admin-private-sentinel", nil).Code != 503 {
		t.Fatal("entropy failure hidden")
	}
	workerError(httptest.NewRecorder(), errors.New("failed dependency"))
}

func TestIssuedSecretsCannotEscapeThroughWorkerNames(t *testing.T) {
	h, repo, _, capture := workerHTTPFixture(t)
	code := issueHTTP(t, h)
	w, credential := enrollHTTP(t, h, code)
	for _, secret := range []string{credential, code, issueHTTP(t, h)} {
		body, _ := json.Marshal(map[string]string{"name": "echo " + secret})
		response := call(h, "PATCH", "/api/v1/admin/workers/"+w.ID, "Bearer admin-private-sentinel", bytes.NewReader(body))
		if response.Code != 200 || strings.Contains(response.Body.String(), secret) {
			t.Fatal("rename response disclosed issued authority")
		}
		h.Workers = service.NewWorkers(repo, h.Authority, rand.Reader, time.Now)
		for _, route := range []struct{ path, key string }{{"/api/v1/admin/workers", "admin-private-sentinel"}, {"/api/v1/worker/status", credential}} {
			response := call(h, "GET", route.path, "Bearer "+route.key, nil)
			if response.Code != 200 || strings.Contains(response.Body.String(), secret) || !strings.Contains(response.Body.String(), "echo [REDACTED]") {
				t.Fatal("worker view disclosed secret after service replacement")
			}
		}
	}
	encoded, _ := json.Marshal(capturedHTTP(t, capture))
	if bytes.Contains(encoded, []byte(credential)) || bytes.Contains(encoded, []byte(code)) {
		t.Fatal("worker name bypassed protected capture")
	}
}
