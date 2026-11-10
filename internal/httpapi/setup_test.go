package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func TestSetupHTTPBoundaryAndProtectedEvidence(t *testing.T) {
	h, m, out, store := workerHTTPFixture(t)
	const route = "/api/v1/admin/setup-prompts"
	for _, key := range []string{"", "Bearer client-private-sentinel", "Bearer portal-private-sentinel"} {
		if call(h, "POST", route, key, nil).Code != 401 {
			t.Fatal("non-management setup access")
		}
	}
	if call(h, "POST", route, "Bearer admin-private-sentinel", nil).Code != 503 {
		t.Fatal("missing setup service accepted")
	}
	h.Setup = service.NewSetup(h.Workers, "https://example.test", config.WorkerPackage{})
	w := call(h, "POST", route, "Bearer admin-private-sentinel", nil)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "worker_package_unconfigured") || len(m.codes) != 0 {
		t.Fatal("missing pins issued authority")
	}
	h.Setup = service.NewSetup(h.Workers, "https://example.test", config.WorkerPackage{Version: "0.1.0-rc.0", SHA256: strings.Repeat("a", 64)})
	for _, body := range []string{`{"extra":true}`, `null`, `{} {}`, `{"enrollment_code":"private"}`} {
		if call(h, "POST", route, "Bearer admin-private-sentinel", strings.NewReader(body)).Code != 400 {
			t.Fatal("invalid setup body accepted")
		}
	}
	if call(h, "GET", route, "Bearer admin-private-sentinel", nil).Code != 405 || call(h, "POST", route+"?unknown=1", "Bearer admin-private-sentinel", nil).Code != 400 {
		t.Fatal("setup transport constraints bypassed")
	}
	var codes []string
	for _, body := range []string{"", `{}`} {
		w = call(h, "POST", route, "Bearer admin-private-sentinel", strings.NewReader(body))
		var result service.SetupPrompt
		if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.EnrollmentID == "" {
			t.Fatal("setup request failed")
		}
		code := regexp.MustCompile(`muse_enroll_[A-Za-z0-9_-]{43}`).FindString(result.Prompt)
		if code == "" {
			t.Fatal("prompt authority missing")
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
	var promptDetail, missingPins bool
	for _, event := range events {
		if event["msg"] == "setup.prompt_detail" {
			promptDetail = event["level"] == "DEBUG" && event["setup_id"] != "" && strings.Contains(event["setup_prompt"].(string), "[REDACTED]")
		}
		if event["msg"] == "setup.package_unconfigured" {
			missingPins = event["cause"] == "worker_package_unconfigured" && event["outcome"] == "not_started"
		}
	}
	if !promptDetail || !missingPins || strings.Contains(out.String(), `"level":"DEBUG"`) {
		t.Fatal("log-only setup diagnosis or filtering incomplete")
	}
	m.fail = errors.New("fixture dependency failure")
	if call(h, "POST", route, "Bearer admin-private-sentinel", nil).Code != 503 {
		t.Fatal("setup dependency failure hidden")
	}
}
