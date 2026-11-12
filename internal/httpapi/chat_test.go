package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

type chatWriter struct {
	*httptest.ResponseRecorder
	deadlines, flushes      int
	failDeadline, failFlush int
	failWrite               bool
	onFlush                 func()
	deadlineValues          []time.Time
}

func (w *chatWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadlines++
	w.deadlineValues = append(w.deadlineValues, deadline)
	if w.deadlines == w.failDeadline {
		return errors.New("write deadline failed")
	}
	return nil
}
func (w *chatWriter) FlushError() error {
	w.flushes++
	if w.flushes == w.failFlush {
		return errors.New("flush failed")
	}
	w.ResponseRecorder.Flush()
	if w.onFlush != nil {
		w.onFlush()
	}
	return nil
}
func (w *chatWriter) Write(b []byte) (int, error) {
	if w.failWrite {
		return 0, errors.New("write failed")
	}
	return w.ResponseRecorder.Write(b)
}

func chatRequestBody(stream bool) map[string]any {
	return map[string]any{"model": "muse-pool-text", "messages": []any{map[string]any{"role": "user", "content": "question"}}, "stream": stream}
}

func runChatHTTP(t *testing.T, h *Handler, w *chatWriter, body any, session string) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(b))
	r.Header.Set("Authorization", "Bearer client-private-sentinel")
	if session != "" {
		r.Header.Set("X-Muse-Session-Id", session)
	}
	h.ServeHTTP(w, r)
}

func chatEvents(t *testing.T, store *diagnostics.Store, id string) []map[string]any {
	t.Helper()
	snapshot, err := store.Snapshot(diagnostics.Filter{RequestID: id})
	if err != nil || !snapshot.Metadata.Complete {
		t.Fatal("capture incomplete", err)
	}
	payloads := map[string][]byte{}
	for _, capture := range snapshot.Records {
		for _, line := range bytes.Split(bytes.TrimSpace(capture), []byte("\n")) {
			var record diagnostics.Record
			if err = json.Unmarshal(line, &record); err != nil {
				t.Fatal(err)
			}
			part, err := base64.StdEncoding.DecodeString(record.Data)
			if err != nil {
				t.Fatal(err)
			}
			payloads[record.CaptureID] = append(payloads[record.CaptureID], part...)
		}
	}
	events := []map[string]any{}
	for _, payload := range payloads {
		var e map[string]any
		if err = json.Unmarshal(payload, &e); err != nil {
			t.Fatal(err)
		}
		events = append(events, e)
	}
	return events
}

func completeChatOnWait(t *testing.T, h *Handler, m *httpInferenceStore, c inference.Connection, key string, decision inference.Item) {
	t.Helper()
	h.Broker.Wait = func(context.Context, time.Duration) error {
		for _, s := range m.states {
			for _, r := range s.Requests {
				if r.State != "queued" {
					continue
				}
				e := s.Experiments[r.ID]
				claim := map[string]any{"protocol_version": 1, "submission_id": "claim-" + r.ID, "connection_id": c.ID, "connection_generation": c.Generation}
				job := apiJSON(t, h, "POST", "/api/v1/worker/jobs/"+e.CurrentJobID+"/claim", key, claim, 200)
				submit := map[string]any{"protocol_version": 1, "submission_id": "decision-" + r.ID, "connection_id": c.ID, "connection_generation": c.Generation, "conversation_id": r.ConversationID, "generation": job["generation"], "lease_id": job["lease_id"], "context_receipt_id": job["context"].(map[string]any)["receipt_id"], "decision": decision}
				apiJSON(t, h, "POST", "/api/v1/worker/jobs/"+e.CurrentJobID+"/decisions", key, submit, 200)
				return nil
			}
		}
		return errors.New("no queued request")
	}
}

func TestChatHTTPNativeFlowAndProtectedEvidence(t *testing.T) {
	for _, stream := range []bool{false, true} {
		h, m, worker, key := inferenceHTTPFixture(t)
		c := onlineNativeHTTP(t, h, m, worker.ID)
		completeChatOnWait(t, h, m, c, key, inference.Item{Type: "final", Text: "exact\r\n😀"})
		body := chatRequestBody(stream)
		body["messages"] = []any{map[string]any{"role": "user", "content": "question client-private-sentinel"}}
		w := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
		runChatHTTP(t, h, w, body, "chat-session")
		if w.Code != 200 || w.Header().Get("X-Muse-Session-Id") != "chat-session" {
			t.Fatal("Chat response/correlation failed", w.Code, w.Body.String())
		}
		if stream && !strings.HasSuffix(w.Body.String(), "data: [DONE]\n\n") {
			t.Fatal("SSE completion missing")
		}
		if !stream && !strings.Contains(w.Body.String(), `"finish_reason":"stop"`) {
			t.Fatal("JSON completion missing")
		}
		for _, r := range m.states[worker.ID].Requests {
			if r.OutputStartedAt == nil || r.OutputCompletedAt == nil {
				t.Fatal("durable output boundaries absent")
			}
		}
		events := chatEvents(t, m.capture, w.Header().Get("X-Request-Id"))
		seen := map[string]bool{}
		for _, e := range events {
			seen[e["msg"].(string)] = true
			b, _ := json.Marshal(e)
			if bytes.Contains(b, []byte("client-private-sentinel")) {
				t.Fatal("credential reached protected capture")
			}
		}
		for _, name := range []string{"chat.input", "chat.normalized_input", "chat.accepted_decision", "chat.encoded_output", "request.completed"} {
			if !seen[name] {
				t.Fatal("required captured evidence missing", name)
			}
		}
		if strings.Contains(m.output.String(), "question client-private-sentinel") || strings.Contains(m.output.String(), `"msg":"chat.normalized_input"`) {
			t.Fatal("private DEBUG content reached INFO output")
		}
	}
}

func TestChatHTTPWriteAndFlushFailuresPreserveAcceptedOutput(t *testing.T) {
	for _, mode := range []string{"write", "flush", "delivery-deadline", "start-deadline"} {
		t.Run(mode, func(t *testing.T) {
			h, m, worker, key := inferenceHTTPFixture(t)
			c := onlineNativeHTTP(t, h, m, worker.ID)
			completeChatOnWait(t, h, m, c, key, inference.Item{Type: "final", Text: "accepted once"})
			w := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
			switch mode {
			case "write":
				w.failWrite = true
			case "flush":
				w.failFlush = 2
			case "delivery-deadline":
				w.failDeadline = 2
			case "start-deadline":
				w.failDeadline = 1
			}
			runChatHTTP(t, h, w, chatRequestBody(true), "fault")
			if mode == "start-deadline" {
				if w.Code != 503 || len(m.states[worker.ID].Requests) != 0 {
					t.Fatal("unbounded response admitted")
				}
				return
			}
			for _, r := range m.states[worker.ID].Requests {
				if r.Output == nil || r.State != "completed" || r.OutputCompletedAt != nil || r.OutputStartedAt == nil {
					t.Fatal("write failure lost accepted output or claimed success")
				}
			}
			found := false
			for _, e := range chatEvents(t, m.capture, w.Header().Get("X-Request-Id")) {
				if e["msg"] == "chat.stream_terminated" && e["level"] == "ERROR" && e["cause"] == "response_write_failed" && e["outcome"] == "uncertain" && e["output_accepted"] == true {
					found = true
				}
			}
			if !found {
				t.Fatal("logs alone cannot diagnose interrupted response")
			}
		})
	}
}

func TestChatHTTPAbortPreservesOwnedAndAcceptedState(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		h, m, worker, key := inferenceHTTPFixture(t)
		c := onlineNativeHTTP(t, h, m, worker.ID)
		ctx, cancel := context.WithCancel(context.Background())
		w := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
		if accepted {
			completeChatOnWait(t, h, m, c, key, inference.Item{Type: "final", Text: "accepted once"})
			w.onFlush = cancel
		} else {
			h.Broker.Wait = func(context.Context, time.Duration) error { cancel(); return context.Canceled }
		}
		body, _ := json.Marshal(chatRequestBody(true))
		r := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(body)).WithContext(ctx)
		r.Header.Set("Authorization", "Bearer client-private-sentinel")
		h.ServeHTTP(w, r)
		cancel()
		for _, request := range m.states[worker.ID].Requests {
			if accepted && (request.Output == nil || request.State != "completed" || request.OutputCompletedAt != nil) {
				t.Fatal("abort changed accepted authority or claimed delivery")
			}
			if !accepted && request.State != "cancelled" {
				t.Fatal("abort did not cancel owned waiting request")
			}
		}
		if strings.Contains(w.Body.String(), "[DONE]") {
			t.Fatal("aborted stream emitted successful termination")
		}
		found := false
		for _, e := range chatEvents(t, m.capture, w.Header().Get("X-Request-Id")) {
			if e["msg"] == "chat.stream_terminated" && e["level"] == "INFO" && e["cause"] == "request_context_cancelled" && e["output_accepted"] == accepted {
				found = true
			}
		}
		if !found {
			t.Fatal("abort lacks correct protected diagnostic evidence")
		}
	}
}

func TestChatHTTPToolRoundTripAndEarlyErrors(t *testing.T) {
	h, m, worker, key := inferenceHTTPFixture(t)
	c := onlineNativeHTTP(t, h, m, worker.ID)
	tool := inference.Item{Type: "tool_call", CallID: "call-a", Name: "read_file", Arguments: map[string]any{"path": "client-only"}}
	completeChatOnWait(t, h, m, c, key, tool)
	body := chatRequestBody(false)
	body["tools"] = []any{map[string]any{"type": "function", "function": map[string]any{"name": "read_file", "parameters": map[string]any{"type": "object"}}}}
	w := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
	runChatHTTP(t, h, w, body, "tool-session")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var completion struct {
		Choices []struct{ Message map[string]any }
	}
	if err := json.Unmarshal(w.Body.Bytes(), &completion); err != nil {
		t.Fatal(err)
	}
	body["messages"] = []any{map[string]any{"role": "user", "content": "question"}, completion.Choices[0].Message, map[string]any{"role": "tool", "tool_call_id": "call-a", "content": "exact client result"}}
	completeChatOnWait(t, h, m, c, key, inference.Item{Type: "final", Text: "exact client result"})
	w = &chatWriter{ResponseRecorder: httptest.NewRecorder()}
	runChatHTTP(t, h, w, body, "tool-session")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "exact client result") {
		t.Fatal("real native tool round-trip failed", w.Body.String())
	}
	for _, tc := range []struct {
		method, path, auth, body string
		status                   int
	}{
		{"GET", "/v1/models", "Bearer client-private-sentinel", "", 200},
		{"GET", "/v1/models", "", "", 401},
		{"GET", "/v1/models", "Bearer management-private-sentinel", "", 401},
		{"POST", "/v1/models", "Bearer client-private-sentinel", "{}", 405},
		{"GET", "/v1/models?unsupported=1", "Bearer client-private-sentinel", "", 400},
		{"POST", "/v1/chat/completions", "Bearer client-private-sentinel", `{"model":"other","messages":[]}`, 404},
		{"POST", "/v1/chat/completions", "Bearer client-private-sentinel", `{"model":"muse-pool-text","messages":[],"temperature":1}`, 400},
		{"POST", "/v1/chat/completions", "Bearer client-private-sentinel", strings.Repeat("x", MaxBodyBytes+1), 413},
	} {
		request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		request.Header.Set("Authorization", tc.auth)
		probe := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
		h.ServeHTTP(probe, request)
		r := probe.ResponseRecorder
		if r.Code != tc.status {
			t.Fatalf("%s expected %d got %d", tc.path, tc.status, r.Code)
		}
		if tc.status >= 400 {
			var v map[string]any
			if json.Unmarshal(r.Body.Bytes(), &v) != nil {
				t.Fatal("invalid error JSON")
			}
			if _, ok := v["error"].(map[string]any); !ok {
				t.Fatal("native error envelope leaked to Chat route")
			}
		}
	}
	if status, _, _ := chatFailure(inference.Reject("deadline_exceeded", 503)); status != 504 {
		t.Fatal("deadline status")
	}
	if status, _, _ := chatFailure(inference.Reject("queue_full", 429)); status != 429 {
		t.Fatal("capacity status")
	}
	if status, _, _ := chatFailure(inference.Reject("invalid_tool_arguments", 400)); status != 400 {
		t.Fatal("validation status")
	}
	if chatErrorValue(429, "queue_full", "") == nil {
		t.Fatal("missing capacity envelope")
	}
}

type chatBoundaryStore struct{ *httpInferenceStore }

func (s chatBoundaryStore) WithinInference(ctx context.Context, ref inference.Ref, apply func(*inference.State) error) error {
	if ref.ClientID != "" && ref.ExperimentID != "" && !ref.Full {
		return errors.New("output boundary storage unavailable")
	}
	return s.httpInferenceStore.WithinInference(ctx, ref, apply)
}

func TestChatHTTPAllResponsePathsRenewShortDeadline(t *testing.T) {
	for _, mode := range []string{"models", "authentication", "method", "body", "normalization", "admission", "output-boundary"} {
		t.Run(mode, func(t *testing.T) {
			h, m, worker, key := inferenceHTTPFixture(t)
			now := time.Now()
			h.Now = func() time.Time { return now }
			method, path, authorization := "POST", "/v1/chat/completions", "Bearer client-private-sentinel"
			body, _ := json.Marshal(chatRequestBody(false))
			if mode == "models" {
				method, path, body = "GET", "/v1/models", nil
			}
			if mode == "authentication" {
				authorization = ""
			}
			if mode == "method" {
				method = "GET"
			}
			if mode == "body" {
				body = bytes.Repeat([]byte("x"), MaxBodyBytes+1)
			}
			if mode == "normalization" {
				body = []byte(`{"model":"other","messages":[]}`)
			}
			if mode == "output-boundary" {
				c := onlineNativeHTTP(t, h, m, worker.ID)
				h.Broker = service.NewBroker(chatBoundaryStore{m}, h.Random, time.Now, nil, 2)
				completeChatOnWait(t, h, m, c, key, inference.Item{Type: "final", Text: "accepted"})
			}
			r := httptest.NewRequest(method, path, bytes.NewReader(body))
			r.Header.Set("Authorization", authorization)
			w := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
			h.ServeHTTP(w, r)
			if len(w.deadlineValues) == 0 || !w.deadlineValues[len(w.deadlineValues)-1].Equal(now.Add(5*time.Second)) {
				t.Fatal("response did not receive short write deadline", w.deadlineValues)
			}
			for _, value := range w.deadlineValues {
				if !value.Equal(now.Add(5*time.Second)) && !value.Equal(now.Add(305*time.Second)) {
					t.Fatal("unexpected deadline", value)
				}
			}
			if mode == "admission" || mode == "output-boundary" {
				if w.Code != 503 {
					t.Fatal("failure did not reach error response", w.Code, w.Body.String())
				}
			}
		})
	}
}

func TestChatHTTPRedactsUnicodeEscapedAdmittedCredentials(t *testing.T) {
	h, m, worker, key := inferenceHTTPFixture(t)
	c := onlineNativeHTTP(t, h, m, worker.ID)
	completeChatOnWait(t, h, m, c, key, inference.Item{Type: "final", Text: "safe answer"})
	r := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"muse-pool-text","messages":[{"role":"user","content":"question \u0063lient-private-sentinel"}]}`))
	r.Header.Set("Authorization", "Bearer client-private-sentinel")
	w := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	seen := false
	for _, e := range chatEvents(t, m.capture, w.Header().Get("X-Request-Id")) {
		if e["msg"] != "chat.input" {
			continue
		}
		seen = true
		if _, ok := e["input"].(map[string]any); !ok {
			t.Fatal("raw encoded input bypassed structured redaction")
		}
		b, _ := json.Marshal(e["input"])
		if bytes.Contains(b, []byte("client-private-sentinel")) || !bytes.Contains(b, []byte("[REDACTED]")) {
			t.Fatal("escaped credential survived admitted capture")
		}
	}
	if !seen {
		t.Fatal("admitted input not retained")
	}
}
