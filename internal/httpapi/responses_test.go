package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func runResponseHTTP(t *testing.T, h *Handler, w *chatWriter, body any, session string) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/v1/responses", bytes.NewReader(encoded))
	r.Header.Set("Authorization", "Bearer client-private-sentinel")
	if session != "" {
		r.Header.Set("X-Muse-Session-Id", session)
	}
	h.ServeHTTP(w, r)
}

func responseRequestBody(stream bool) map[string]any {
	return map[string]any{"model": "muse-pool-text", "input": "question client-private-sentinel", "stream": stream, "instructions": "current client-private-sentinel"}
}

func TestResponsesHTTPProductionLogicAndProtectedEvidence(t *testing.T) {
	for _, stream := range []bool{false, true} {
		h, m, worker, key := inferenceHTTPFixture(t)
		c := onlineNativeHTTP(t, h, m, worker.ID)
		completeChatOnWait(t, h, m, c, key, inference.Item{Type: "final", Text: "exact\r\n😀"})
		w := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
		runResponseHTTP(t, h, w, responseRequestBody(stream), "response-session")
		if w.Code != 200 || w.Header().Get("X-Muse-Session-Id") != "response-session" {
			t.Fatal(w.Code, w.Body.String())
		}
		if stream {
			if !strings.Contains(w.Body.String(), "event: response.completed") || strings.Contains(w.Body.String(), "[DONE]") {
				t.Fatal(w.Body.String())
			}
		} else {
			var value map[string]any
			if json.Unmarshal(w.Body.Bytes(), &value) != nil || value["object"] != "response" || value["usage"] != nil {
				t.Fatal(value)
			}
		}
		for _, request := range m.states[worker.ID].Requests {
			if request.OutputStartedAt == nil || request.OutputCompletedAt == nil || request.Response == nil || *request.Response.Instructions != "current client-private-sentinel" {
				t.Fatal(request)
			}
		}
		seen := map[string]bool{}
		for _, event := range chatEvents(t, m.capture, w.Header().Get("X-Request-Id")) {
			seen[event["msg"].(string)] = true
			value, _ := json.Marshal(event)
			if bytes.Contains(value, []byte("client-private-sentinel")) {
				t.Fatal("credential reached capture")
			}
		}
		for _, name := range []string{"responses.input", "responses.normalized_input", "responses.accepted_decision", "responses.encoded_output", "responses.request_admitted", "request.completed"} {
			if !seen[name] {
				t.Fatal("evidence missing", name)
			}
		}
		if strings.Contains(m.output.String(), "question client-private-sentinel") || strings.Contains(m.output.String(), `"msg":"responses.encoded_output"`) {
			t.Fatal("private payload reached INFO")
		}
	}
}

func TestResponsesHTTPFailedWritesNeverCompleteOrRegenerate(t *testing.T) {
	for _, mode := range []string{"write", "flush", "start-deadline", "frame-deadline"} {
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
			case "start-deadline":
				w.failDeadline = 1
			case "frame-deadline":
				w.failDeadline = 4
			}
			body := responseRequestBody(true)
			runResponseHTTP(t, h, w, body, "failed-response")
			if strings.Contains(w.Body.String(), "event: response.completed") {
				t.Fatal("failed stream claimed completion")
			}
			if mode == "start-deadline" {
				if len(m.states[worker.ID].Requests) != 0 {
					t.Fatal("unbounded response admitted")
				}
				return
			}
			var id string
			for _, request := range m.states[worker.ID].Requests {
				id = request.ID
				if request.Output == nil || request.OutputStartedAt == nil || request.OutputCompletedAt != nil {
					t.Fatal("accepted decision/boundary lost", request)
				}
			}
			events := chatEvents(t, m.capture, w.Header().Get("X-Request-Id"))
			found := false
			for _, e := range events {
				if e["msg"] == "responses.stream_terminated" && e["outcome"] == "uncertain" && e["level"] == "ERROR" && e["output_accepted"] == true {
					found = true
				}
			}
			if !found {
				t.Fatal("partial delivery not diagnosable")
			}
			w = &chatWriter{ResponseRecorder: httptest.NewRecorder()}
			runResponseHTTP(t, h, w, body, "failed-response")
			if w.Code != 200 || !strings.Contains(w.Body.String(), "event: response.completed") || len(m.states[worker.ID].Requests) != 1 || !strings.Contains(w.Body.String(), id) {
				t.Fatal("retry regenerated accepted work", w.Body.String())
			}
		})
	}
}

type cancelResponseBoundary struct {
	*httpInferenceStore
	cancel context.CancelFunc
}

func (s cancelResponseBoundary) WithinInference(ctx context.Context, ref inference.Ref, fn func(*inference.State) error) error {
	if ref.ClientID != "" && ref.ExperimentID != "" && !ref.Full {
		s.cancel()
		return ctx.Err()
	}
	return s.httpInferenceStore.WithinInference(ctx, ref, fn)
}

func TestResponsesCancellationAfterAcceptanceRetainsOutputWithoutFallback(t *testing.T) {
	for _, boundary := range []string{"before-exposure", "after-created"} {
		t.Run(boundary, func(t *testing.T) {
			h, m, worker, key := inferenceHTTPFixture(t)
			c := onlineNativeHTTP(t, h, m, worker.ID)
			completeChatOnWait(t, h, m, c, key, inference.Item{Type: "final", Text: "accepted exactly once"})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			w := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
			if boundary == "before-exposure" {
				h.Broker = service.NewBroker(cancelResponseBoundary{m, cancel}, rand.Reader, time.Now, h.Broker.Wait, 16)
			} else {
				w.onFlush = cancel
			}
			encoded, _ := json.Marshal(responseRequestBody(true))
			r := httptest.NewRequest("POST", "/v1/responses", bytes.NewReader(encoded)).WithContext(ctx)
			r.Header.Set("Authorization", "Bearer client-private-sentinel")
			h.ServeHTTP(w, r)
			if boundary == "before-exposure" && w.Body.Len() != 0 {
				t.Fatal("cancelled exposure wrote fallback", w.Body.String())
			}
			if strings.Contains(w.Body.String(), "response.completed") {
				t.Fatal("cancelled stream completed")
			}
			for _, request := range m.states[worker.ID].Requests {
				if request.Output == nil || request.Output.Text != "accepted exactly once" || request.OutputCompletedAt != nil {
					t.Fatal("cancellation discarded accepted output", request)
				}
			}
			found := false
			for _, event := range chatEvents(t, m.capture, w.Header().Get("X-Request-Id")) {
				if event["msg"] == "responses.stream_terminated" && event["level"] == "INFO" && event["cause"] == "request_context_cancelled" && event["output_accepted"] == true && event["outcome"] == "client_aborted" {
					found = true
				}
			}
			if !found {
				t.Fatal("accepted cancellation lacks INFO disposition")
			}
		})
	}
}

func TestResponsesHTTPAdmittedFailureAndAbort(t *testing.T) {
	for _, abort := range []bool{false, true} {
		h, m, worker, _ := inferenceHTTPFixture(t)
		onlineNativeHTTP(t, h, m, worker.ID)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		h.Broker.Wait = func(context.Context, time.Duration) error {
			if abort {
				cancel()
				return context.Canceled
			}
			for _, state := range m.states {
				for _, request := range state.Requests {
					state.Experiments[request.ID].State = "interrupted"
					state.Experiments[request.ID].Reason = "worker_disconnected"
				}
			}
			return nil
		}
		encoded, _ := json.Marshal(responseRequestBody(true))
		r := httptest.NewRequest("POST", "/v1/responses", bytes.NewReader(encoded)).WithContext(ctx)
		r.Header.Set("Authorization", "Bearer client-private-sentinel")
		w := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
		h.ServeHTTP(w, r)
		if abort {
			if w.Body.Len() != 0 {
				t.Fatal("abort wrote lifecycle")
			}
		} else if !strings.Contains(w.Body.String(), "event: response.failed") || strings.Contains(w.Body.String(), "event: response.completed") {
			t.Fatal(w.Body.String())
		}
	}
}

func TestResponsesHTTPEarlyRejectionsAndDependencyFailures(t *testing.T) {
	for _, mode := range []string{"schema", "session", "broker", "storage", "wait", "encoding"} {
		t.Run(mode, func(t *testing.T) {
			h, m, worker, key := inferenceHTTPFixture(t)
			c := onlineNativeHTTP(t, h, m, worker.ID)
			body := responseRequestBody(false)
			session := "errors"
			switch mode {
			case "schema":
				body["store"] = false
			case "session":
				session = "invalid space"
			case "broker":
				h.Broker = nil
			case "storage":
				m.fail = errors.New("offline")
			case "wait":
				h.Broker.Wait = func(context.Context, time.Duration) error { return errors.New("wait failed") }
			case "encoding":
				completeChatOnWait(t, h, m, c, key, inference.Item{Type: "final", Text: "accepted"})
			}
			w := &chatWriter{ResponseRecorder: httptest.NewRecorder()}
			runResponseHTTP(t, h, w, body, session)
			if mode == "encoding" {
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
				return
			}
			if w.Code < 400 || !strings.Contains(w.Body.String(), `"type":`) {
				t.Fatal("invalid OpenAI error", w.Code, w.Body.String())
			}
		})
	}
	for _, reason := range []string{"history_owner_denied", "response_not_completed", "stale_response_reference", "session_reference_conflict", "response_item_not_owned", "response_item_conflict"} {
		w := &response{ResponseWriter: httptest.NewRecorder()}
		writeResponseError(w, inference.Reject(reason, 409))
	}
}
