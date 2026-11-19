package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func TestSetupHTTPBoundaryAndProtectedEvidence(t *testing.T) {
	h, m, out, store := workerHTTPFixture(t)
	const route = "/api/v1/admin/setup-prompts"
	originBody := func() *strings.Reader { return strings.NewReader(`{"origin":"https://example.test:8443"}`) }
	for _, key := range []string{"", "Bearer client-private-sentinel", "Bearer portal-private-sentinel"} {
		if call(h, "POST", route, key, nil).Code != 401 {
			t.Fatal("non-management setup access")
		}
	}
	if call(h, "POST", route, "Bearer admin-private-sentinel", originBody()).Code != 503 {
		t.Fatal("missing setup service accepted")
	}
	h.Setup = service.NewSetup(h.Workers, service.PackagePin{})
	w := call(h, "POST", route, "Bearer admin-private-sentinel", originBody())
	if w.Code != 503 || !strings.Contains(w.Body.String(), "worker_package_unconfigured") || len(m.codes) != 0 {
		t.Fatal("missing pins issued authority")
	}
	h.Setup = service.NewSetup(h.Workers, service.PackagePin{Version: "0.1.0-rc.0", SHA256: strings.Repeat("a", 64)})
	for _, body := range []string{"", `{}`, `{"extra":true}`, `null`, `{} {}`, `{"origin":"https://private-origin-secret@host.test"}`, `{"origin":"http://host.test"}`, `{"origin":"https://host.test/path"}`, `{"origin":"https://host.test?"}`, `{"origin":"https://host.test#"}`, `{"origin":"https://host.test:65536"}`} {
		if call(h, "POST", route, "Bearer admin-private-sentinel", strings.NewReader(body)).Code != 400 {
			t.Fatal("invalid setup body accepted")
		}
	}
	if len(m.codes) != 0 {
		t.Fatal("rejected origin issued enrollment")
	}
	if call(h, "GET", route, "Bearer admin-private-sentinel", nil).Code != 405 || call(h, "POST", route+"?unknown=1", "Bearer admin-private-sentinel", nil).Code != 400 {
		t.Fatal("setup transport constraints bypassed")
	}
	var codes []string
	for _, origin := range []string{"https://example.test:8443", "https://other.example.test"} {
		body, _ := json.Marshal(map[string]string{"origin": origin})
		request := httptest.NewRequest("POST", "http://internal.test"+route, bytes.NewReader(body))
		request.Header.Set("Authorization", "Bearer admin-private-sentinel")
		request.Header.Set("X-Forwarded-Host", "forwarded.test")
		request.Header.Set("X-Forwarded-Proto", "http")
		w = httptest.NewRecorder()
		h.ServeHTTP(w, request)
		var result service.SetupPrompt
		if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.EnrollmentID == "" {
			t.Fatal("setup request failed")
		}
		code := regexp.MustCompile(`muse_enroll_[A-Za-z0-9_-]{43}`).FindString(result.Prompt)
		if code == "" || !strings.Contains(result.Prompt, "origin='"+origin+"'") || strings.Contains(result.Prompt, "forwarded.test") {
			t.Fatal("prompt authority or browser origin missing")
		}
		codes = append(codes, code)
	}
	events := capturedHTTP(t, store)
	encoded, _ := json.Marshal(events)
	for _, code := range codes {
		if bytes.Contains(encoded, []byte(code)) || strings.Contains(out.String(), code) {
			t.Fatal("prompt code exposed in diagnostics")
		}
	}
	var promptDetail, missingPins, rejectedOrigin bool
	created := map[string]bool{}
	for _, event := range events {
		if event["msg"] == "setup.prompt_detail" {
			promptDetail = event["level"] == "DEBUG" && event["setup_id"] != "" && strings.Contains(event["setup_prompt"].(string), "[REDACTED]")
		}
		if event["msg"] == "setup.package_unconfigured" {
			missingPins = event["cause"] == "worker_package_unconfigured" && event["outcome"] == "not_started"
		}
		if event["msg"] == "setup.prompt_created" && event["level"] == "INFO" {
			created[event["origin"].(string)] = true
		}
		if event["msg"] == "setup.origin_rejected" && event["level"] == "WARN" {
			rejectedOrigin = true
		}
	}
	if !promptDetail || !missingPins || !rejectedOrigin || len(created) != 2 ||
		strings.Contains(out.String(), `"level":"DEBUG"`) || bytes.Contains(encoded, []byte("private-origin-secret")) {
		t.Fatal("log-only setup diagnosis or filtering incomplete")
	}
	m.fail = errors.New("fixture dependency failure")
	if call(h, "POST", route, "Bearer admin-private-sentinel", originBody()).Code != 503 {
		t.Fatal("setup dependency failure hidden")
	}
}
