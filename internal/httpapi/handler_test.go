package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

type testDB struct{ err error }

func (d *testDB) Ping(context.Context) error { return d.err }

func fixture(t *testing.T) (*Handler, *testDB, *bytes.Buffer, *diagnostics.Store) {
	t.Helper()
	c := config.Defaults()
	c.Server.PublicURL = "https://example.test"
	c.Database.URL = "postgres://db/muse"
	c.Management.Key = "admin-private-sentinel"
	c.Portal.Password = "portal-private-sentinel"
	c.ClientKeys = map[string]config.Secret{"client": "client-private-sentinel"}
	store, err := diagnostics.Open(diagnostics.OSFiles{}, t.TempDir(), "instance", time.Now, 7*24*time.Hour, 128*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	logger := diagnostics.NewLogger(&out, store, slog.LevelInfo, diagnostics.NewRedactor(c.Secrets()), time.Now, func(error) { t.Error("capture failed") }).With("instance_id", "instance")
	db := &testDB{}
	svc := service.New(db, c, service.Build{Revision: "revision"}, "instance", time.Now, logger)
	return &Handler{Service: svc, Authority: auth.New(c), Exporter: store, Logger: logger, Random: rand.Reader, Now: time.Now, Failed: make(chan struct{})}, db, &out, store
}
func call(h *Handler, method, path, authorization string, body io.Reader) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, body)
	r.Header.Set("Authorization", authorization)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestHTTPContractsAndLogOnlyDiagnosis(t *testing.T) {
	h, db, out, store := fixture(t)
	for _, tc := range []struct {
		path, auth string
		status     int
	}{{"/healthz", "", 200}, {"/readyz", "", 200}, {"/api/v1/admin/status", "", 401}, {"/api/v1/admin/status", "Bearer wrong", 401}, {"/api/v1/admin/status", "Bearer client-private-sentinel", 401}, {"/api/v1/admin/status", "Bearer portal-private-sentinel", 401}, {"/api/v1/admin/status", "Bearer admin-private-sentinel", 200}, {"/missing", "", 404}} {
		w := call(h, "GET", tc.path, tc.auth, nil)
		if w.Code != tc.status || w.Header().Get("X-Request-Id") == "" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("wrong HTTP contract on %s: %d", tc.path, w.Code)
		}
		if strings.Contains(w.Body.String(), "private-sentinel") {
			t.Fatal("response exposed credentials")
		}
	}
	db.err = errors.New("database unavailable")
	down := call(h, "GET", "/readyz", "", nil)
	if down.Code != 503 {
		t.Fatal("database loss did not fail readiness")
	}
	if call(h, "GET", "/healthz", "", nil).Code != 200 {
		t.Fatal("liveness incorrectly depends on database")
	}
	denied := call(h, "GET", "/api/v1/admin/status", "Bearer client-private-sentinel", nil)
	export := call(h, "GET", "/api/v1/admin/diagnostics/export?request_id="+denied.Header().Get("X-Request-Id"), "Bearer admin-private-sentinel", nil)
	if export.Code != 200 || export.Header().Get("Content-Type") != "application/x-ndjson" {
		t.Fatal("export unavailable during database loss")
	}
	decoder := json.NewDecoder(export.Body)
	events := []diagnostics.Record{}
	var metadata diagnostics.Metadata
	if decoder.Decode(&metadata) != nil || !metadata.Complete {
		t.Fatal("missing completeness receipt")
	}
	var reconstructed bytes.Buffer
	for decoder.More() {
		var r diagnostics.Record
		if decoder.Decode(&r) != nil {
			t.Fatal("bad export")
		}
		events = append(events, r)
		decoded, err := io.ReadAll(bytes.NewReader(mustDecode(t, r.Data)))
		if err != nil {
			t.Fatal(err)
		}
		reconstructed.Write(decoded)
	}
	if len(events) == 0 || !strings.Contains(reconstructed.String(), "auth.denied") || !strings.Contains(reconstructed.String(), `"observed_role":"client"`) {
		t.Fatal("logs do not identify wrong-role cause")
	}
	if strings.Contains(reconstructed.String(), "private-sentinel") || strings.Contains(out.String(), "private-sentinel") {
		t.Fatal("logs exposed credentials")
	}
	for _, query := range []string{"request_id=unknown-request", "operation_id=unknown-operation", "since=2000-01-01T00:00:00Z", "until=2099-01-01T00:00:00Z"} {
		missing := call(h, "GET", "/api/v1/admin/diagnostics/export?"+query, "Bearer admin-private-sentinel", nil)
		var metadata diagnostics.Metadata
		if json.NewDecoder(missing.Body).Decode(&metadata) != nil || metadata.Complete || len(metadata.Omissions) == 0 {
			t.Fatal("HTTP export hid missing evidence")
		}
	}
	snapshot, err := store.Snapshot(diagnostics.Filter{RequestID: denied.Header().Get("X-Request-Id")})
	if err != nil || snapshot.Metadata.Captures != metadata.Captures {
		t.Fatal("export recaptured its response")
	}
	db.err = nil
	if call(h, "GET", "/readyz", "", nil).Code != 200 {
		t.Fatal("readiness failed to recover")
	}
}

func mustDecode(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestInputRejections(t *testing.T) {
	h, _, _, _ := fixture(t)
	for _, tc := range []struct {
		method, path, body string
		code               int
	}{{"POST", "/healthz", "", 405}, {"GET", "/healthz", "body", 400}, {"GET", "/healthz?unknown=value", "", 400}, {"GET", "/healthz", strings.Repeat("x", MaxBodyBytes+1), 413}} {
		if got := call(h, tc.method, tc.path, "", strings.NewReader(tc.body)); got.Code != tc.code {
			t.Fatalf("wrong rejection code: %d", got.Code)
		}
	}
	for _, query := range []string{"unknown=x", "request_id=a&request_id=b", "request_id=bad%20value", "operation_id=", "since=bad", "until=bad", "since=2026-11-09T00:00:00Z&until=2026-11-08T00:00:00Z", "since=%"} {
		if got := call(h, "GET", "/api/v1/admin/diagnostics/export?"+query, "Bearer admin-private-sentinel", nil); got.Code != 400 {
			t.Fatalf("accepted invalid filter %s", query)
		}
	}
	filter, err := parseFilter(httptest.NewRequest("GET", "/export?operation_id=startup-1&request_id=request-1&since=2026-11-08T00:00:00Z&until=2026-11-09T00:00:00Z", nil))
	if err != nil || filter.OperationID != "startup-1" || filter.RequestID != "request-1" {
		t.Fatal("valid filters rejected")
	}
	h.Random = bytes.NewReader(nil)
	if got := call(h, "GET", "/healthz", "", nil); got.Code != 503 {
		t.Fatal("identifier failure ignored")
	}
	h.Random = rand.Reader
	failed := make(chan struct{})
	close(failed)
	h.Failed = failed
	if got := call(h, "GET", "/healthz", "", nil); got.Code != 503 {
		t.Fatal("capture failure ignored")
	}
}

type failReader struct{}

func (failReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }
func (failReader) Close() error             { return nil }

type failExporter struct{}

func (failExporter) Snapshot(diagnostics.Filter) (diagnostics.Snapshot, error) {
	return diagnostics.Snapshot{}, errors.New("capture failed")
}

type failWriter struct {
	header http.Header
	writes int
	after  int
}

func (w *failWriter) Header() http.Header { return w.header }
func (w *failWriter) WriteHeader(int)     {}
func (w *failWriter) Write(b []byte) (int, error) {
	w.writes++
	if w.writes > w.after {
		return 0, errors.New("connection closed")
	}
	return len(b), nil
}

func TestBoundaryIOFailures(t *testing.T) {
	h, _, _, _ := fixture(t)
	r := httptest.NewRequest("GET", "/healthz", nil)
	r.Body = failReader{}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("body read failure ignored")
	}
	h.Exporter = failExporter{}
	if got := call(h, "GET", "/api/v1/admin/diagnostics/export", "Bearer admin-private-sentinel", nil); got.Code != 503 {
		t.Fatal("export failure ignored")
	}
	h, _, _, _ = fixture(t)
	call(h, "GET", "/healthz", "", nil)
	for _, after := range []int{0, 1} {
		r := httptest.NewRequest("GET", "/api/v1/admin/diagnostics/export", nil)
		r.Header.Set("Authorization", "Bearer admin-private-sentinel")
		writer := &failWriter{header: http.Header{}, after: after}
		h.ServeHTTP(writer, r)
		if writer.writes <= after {
			t.Fatal("did not reach failed response write")
		}
	}
	wrapped := &response{ResponseWriter: httptest.NewRecorder(), capture: true}
	wrapped.WriteHeader(201)
	wrapped.WriteHeader(500)
	_, _ = wrapped.Write([]byte("body"))
	if wrapped.code != 201 || wrapped.body.String() != "body" {
		t.Fatal("response bookkeeping failed")
	}
}

func TestResponseWriteFailureHasInterruptedOutcome(t *testing.T) {
	h, _, out, store := fixture(t)
	writer := &failWriter{header: http.Header{}, after: 0}
	h.ServeHTTP(writer, httptest.NewRequest("GET", "/healthz", nil))
	if !strings.Contains(out.String(), "request.write_failed") || !strings.Contains(out.String(), `"outcome":"interrupted"`) {
		t.Fatal("observable write failure reported successful completion")
	}
	snapshot, err := store.Snapshot(diagnostics.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, b := range snapshot.Records {
		var payload bytes.Buffer
		for _, line := range bytes.Split(bytes.TrimSpace(b), []byte("\n")) {
			var r diagnostics.Record
			if json.Unmarshal(line, &r) != nil {
				t.Fatal("bad chunk")
			}
			payload.Write(mustDecode(t, r.Data))
		}
		var event map[string]any
		if json.Unmarshal(payload.Bytes(), &event) != nil {
			t.Fatal("bad capture")
		}
		if event["msg"] == "request.exchange" {
			found = true
			if event["outcome"] != "interrupted" || event["written_bytes"] != float64(0) || event["attempted_bytes"].(float64) <= 0 || !strings.Contains(event["response"].(string), "alive") || event["write_error"] == "" {
				t.Fatal("missing attempted output or causal write evidence")
			}
		}
	}
	if !found {
		t.Fatal("missing exchange evidence")
	}
}
