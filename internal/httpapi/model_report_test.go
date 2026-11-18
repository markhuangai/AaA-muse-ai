package httpapi

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkerModelReportIsFencedAndOptional(t *testing.T) {
	h, store, worker, key := inferenceHTTPFixture(t)
	server := httptest.NewServer(h)
	defer server.Close()
	const reported = "2026-11-18T01:02:03Z"
	const fixtureName = "Controlled Muse"
	encoded := func(fragment string) string {
		return base64.RawURLEncoding.EncodeToString([]byte("{\"reported_at\":\"" + reported + "\"," + fragment + "}"))
	}
	valid := encoded("\"model_name\":\"" + fixtureName + "\",\"context_window_tokens\":350000")
	knownCredential := "client-private-sentinel"
	for i, tc := range []struct {
		values []string
		cause  string
		ok     bool
	}{
		{values: []string{valid}, ok: true},
		{values: []string{valid}, ok: true},
		{},
		{values: []string{valid, valid}, cause: "invalid_model_report_header"},
		{values: []string{strings.Repeat("a", 700)}, cause: "invalid_model_report_header"},
		{values: []string{"!invalid"}, cause: "invalid_model_report_encoding"},
		{values: []string{encoded("\"model_name\":\"x\",\"extra\":true")}, cause: "unsupported_field_spelling"},
		{values: []string{encoded("\"model_name\":null")}, cause: "incomplete_model_report"},
		{values: []string{encoded("\"model_name\":\"\\n\"")}, cause: "invalid_model_name"},
		{values: []string{encoded("\"model_name\":\"x\",\"context_window_tokens\":0")}, cause: "invalid_context_window"},
		{values: []string{encoded("\"model_name\":\"name " + knownCredential + "\"")}, cause: "model_name_contains_credential"},
	} {
		store.output.Reset()
		req, err := http.NewRequest("GET", server.URL+"/api/v1/worker/events", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+key)
		for _, value := range tc.values {
			req.Header.Add(modelReportHeader, value)
		}
		resp, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != 200 || !strings.Contains(string(body), "event: connection.opened") {
			t.Fatalf("generation %d could not connect: %d %v", i+1, resp.StatusCode, err)
		}
		connection := store.states[worker.ID].Connection
		if connection.Generation != int64(i+1) {
			t.Fatal("unexpected connection generation", connection.Generation)
		}
		own := apiJSON(t, h, "GET", "/api/v1/worker/status", key, nil, 200)
		report, available := own["model_report"].(map[string]any)
		if available != tc.ok || own["inference_readiness"] != "unverified" {
			t.Fatal("model report changed qualification or optional availability", own)
		}
		if available && (report["reported_at"] != reported || report["model_name"] != fixtureName || report["context_window_tokens"] != float64(350000)) {
			t.Fatal("model report snapshot changed", report)
		}
		log := store.output.String()
		if tc.cause != "" && (!strings.Contains(log, "\"msg\":\"worker.model_report_rejected\"") || !strings.Contains(log, "\"cause\":\""+tc.cause+"\"")) {
			t.Fatalf("missing rejection evidence for %s", tc.cause)
		}
		if strings.Contains(log, knownCredential) || strings.Contains(string(body), knownCredential) {
			t.Fatal("credential escaped the reporting boundary")
		}
	}
}
