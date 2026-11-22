package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/media"
)

func mcpRequest(body string) *http.Request {
	r := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	r.Header.Set("MCP-Protocol-Version", "2025-11-25")
	r.Header.Set("Authorization", "Bearer client-private-sentinel")
	return r
}

const askMCP = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_muse","arguments":{"prompt":"question","submission_id":"one-text"}}}`

func TestMCPTextOutputBoundaries(t *testing.T) {
	h, db, worker, key := inferenceHTTPFixture(t)
	answer := "exact answer muse_download_" + strings.Repeat("A", 43)
	completeChatOnWait(t, h, db, key, inference.Item{Type: "final", Text: answer})
	failed := &chatWriter{ResponseRecorder: httptest.NewRecorder(), failWrite: true}
	h.ServeHTTP(failed, mcpRequest(askMCP))
	var id string
	for _, r := range db.states[worker.ID].Requests {
		id = r.ID
		if r.OutputStartedAt == nil || r.OutputCompletedAt != nil || r.Output.Text != answer {
			t.Fatal("failed MCP write lost accepted output or recorded delivery")
		}
	}
	if id == "" {
		t.Fatal("MCP text was never admitted")
	}
	interrupted := &chatWriter{ResponseRecorder: httptest.NewRecorder(), failFlush: 1}
	h.ServeHTTP(interrupted, mcpRequest(askMCP))
	if db.states[worker.ID].Requests[id].OutputCompletedAt != nil {
		t.Fatal("failed MCP flush recorded an output receipt")
	}
	success := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
	h.ServeHTTP(success, mcpRequest(askMCP))
	if success.Code != 200 || !strings.Contains(success.Body.String(), answer) ||
		success.Header().Get("Cache-Control") != "no-store" || success.flushes != 1 {
		t.Fatal("MCP replay did not deliver the accepted answer")
	}
	if saved := db.states[worker.ID].Requests[id]; saved.OutputCompletedAt == nil || len(db.states[worker.ID].Requests) != 1 {
		t.Fatal("MCP retry did not record the original output as written")
	}
	for _, e := range chatEvents(t, db.capture, success.Header().Get("X-Request-Id")) {
		out, _ := json.Marshal(e)
		if strings.Contains(string(out), "muse_download_") {
			t.Fatal("echoed share credential reached diagnostics")
		}
	}
}

func TestMCPTransportAndMediaAdmission(t *testing.T) {
	h, db, _, _ := inferenceHTTPFixture(t)
	h.Broker.Media = media.New(t.TempDir())
	const generate = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_wav","arguments":{"prompt":"rain","submission_id":"shared-input"}}}`
	for _, tc := range []struct {
		want      int
		key, host string
		origins   []string
	}{
		{401, "admin-private-sentinel", "", nil},
		{400, "client-private-sentinel", "example.com/path", nil},
		{403, "client-private-sentinel", "", []string{"null"}},
		{403, "client-private-sentinel", "", []string{"https://example.com", "https://example.com"}},
		{200, "client-private-sentinel", "", []string{"https://example.com"}},
	} {
		r := mcpRequest(generate)
		r.Header.Set("Authorization", "Bearer "+tc.key)
		if tc.host != "" {
			r.Host = tc.host
		}
		for _, origin := range tc.origins {
			r.Header.Add("Origin", origin)
		}
		out := httptest.NewRecorder()
		h.ServeHTTP(out, r)
		if out.Code != tc.want {
			t.Fatalf("MCP HTTP status %d, want %d", out.Code, tc.want)
		}
	}
	if len(db.states[""].Jobs) != 1 {
		t.Fatal("MCP admission did not create exactly one job")
	}
	var id string
	for _, j := range db.states[""].Jobs {
		id = j.ID
		if j.Media.Profile != media.PromptWAVProfile {
			t.Fatal("generate_wav selected wrong profile")
		}
	}
	const poll = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"download_wav","arguments":{"job_id":"JOB"}}}`
	out := httptest.NewRecorder()
	h.ServeHTTP(out, mcpRequest(strings.ReplaceAll(poll, "JOB", id)))
	if !strings.Contains(out.Body.String(), `"retry_after_seconds":60`) || strings.Contains(out.Body.String(), "download_url") {
		t.Fatal("pending MCP poll had incorrect readiness")
	}
}

func TestMCPLegacyDisconnectCancelsText(t *testing.T) {
	h, db, _, _ := inferenceHTTPFixture(t)
	r := mcpRequest(askMCP)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	h.Broker.Wait = func(ctx context.Context, _ time.Duration) error {
		cancel()
		<-ctx.Done()
		return ctx.Err()
	}
	h.ServeHTTP(httptest.NewRecorder(), r.WithContext(ctx))
	for _, item := range db.states[""].Requests {
		if item.State != "cancelled" || item.Output != nil {
			t.Fatal("legacy HTTP disconnect left unfinished MCP work")
		}
		return
	}
	t.Fatal("disconnected MCP request was not admitted")
}

func TestMCPAdmissionFailures(t *testing.T) {
	h, _, _, _ := inferenceHTTPFixture(t)
	absent := h.Broker
	h.Broker = nil
	out := httptest.NewRecorder()
	h.ServeHTTP(out, mcpRequest(askMCP))
	if out.Code != 503 {
		t.Fatal("MCP with no broker returned", out.Code)
	}
	h.Broker = absent
	failed := &chatWriter{ResponseRecorder: httptest.NewRecorder(), failDeadline: 1}
	h.ServeHTTP(failed, mcpRequest(askMCP))
	if failed.Code != 503 {
		t.Fatal("MCP continued after it could not set the wait deadline")
	}
	for _, tc := range []struct{ body, reason string }{
		{strings.ReplaceAll(askMCP, "question", " "), "invalid_prompt"},
		{strings.ReplaceAll(askMCP, "one-text", "!"), "invalid_submission_id"},
		{`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_video","arguments":{"prompt":"rain","submission_id":"media"}}}`, "service_unavailable"},
		{`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"download_video","arguments":{"job_id":"invalid"}}}`, "invalid_job_id"},
	} {
		out := httptest.NewRecorder()
		h.ServeHTTP(out, mcpRequest(tc.body))
		if out.Code != 200 || !strings.Contains(out.Body.String(), `"isError":true`) ||
			!strings.Contains(out.Body.String(), tc.reason) {
			t.Fatalf("tool failure omitted %s, status %d", tc.reason, out.Code)
		}
	}
	closed := make(chan struct{})
	close(closed)
	h.Failed = closed
	out = httptest.NewRecorder()
	h.ServeHTTP(out, mcpRequest(askMCP))
	if out.Code != 503 || strings.Contains(out.Body.String(), "request_id") {
		t.Fatal("MCP admitted work with a failed diagnostics sink")
	}
}
