package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"testing"
)

func TestSetupPromptUsesIssuedAuthorityAndPinnedMechanics(t *testing.T) {
	w, m, logger, _ := workerFixture()
	s := NewSetup(w, PackagePin{Version: "1.0.0-rc.0", SHA256: strings.Repeat("a", 64)})
	result, err := s.Create(context.Background(), logger, "https://example.test:8443")
	if err != nil || result.EnrollmentID == "" || result.ExpiresAt.Sub(result.CreatedAt) != EnrollmentLifetime {
		t.Fatal("setup issuance failed", err)
	}
	code := regexp.MustCompile(`muse_enroll_[A-Za-z0-9_-]{43}`).FindString(result.Prompt)
	if code == "" {
		t.Fatal("complete prompt lacks bootstrap authority")
	}
	for _, fragment := range []string{result.WorkerPackage.URL, result.WorkerPackage.SHA256, "actual permissions", "including disabled registrations", "separate major-1 paths", "End this installation turn", "single-use", "sha256sum", "actual_version", "setup.digest_mismatch"} {
		if !strings.Contains(result.Prompt, fragment) {
			t.Fatal("missing setup mechanism", fragment)
		}
	}
	if strings.Contains(result.Prompt, "@CODE@") || strings.Contains(result.Prompt, "@ORIGIN@") || len(m.enrollments) != 1 {
		t.Fatal("incomplete or duplicate issuance")
	}
	if _, _, _, err := w.Enroll(context.Background(), logger, code); err != nil {
		t.Fatal("prompt code does not enroll", err)
	}
	if _, _, _, err := w.Enroll(context.Background(), logger, code); err == nil {
		t.Fatal("prompt code reused")
	}
}

func TestSetupPromptRequiresVerifiedHookAndWatchdog(t *testing.T) {
	w, _, _, _ := workerFixture()
	var logs bytes.Buffer
	const requestID = "watchdog-setup-request"
	logger := slog.New(slog.NewJSONHandler(&logs, nil)).With("request_id", requestID)
	s := NewSetup(w, PackagePin{Version: "1.0.0-rc.0", SHA256: strings.Repeat("a", 64)})
	result, err := s.Create(context.Background(), logger, "https://example.test")
	if err != nil {
		t.Fatal(err)
	}
	before, bootstrap, ok := strings.Cut(result.Prompt, "```bash\n")
	if !ok {
		t.Fatal("missing setup bootstrap")
	}
	if !strings.HasPrefix(before, "I authorize you to run the verified AaA worker launcher and finish setup in this goal during this turn.") {
		t.Fatal("setup must start with the owner's same-turn authorization")
	}
	if !strings.Contains(before, "Verify one managed shell hook and one five-minute native agent watchdog") ||
		!strings.Contains(before, "If Muse requires another approval, show me the specific request.") {
		t.Fatal("missing scoped checker authorization and Muse approval instructions")
	}
	if !strings.Contains(before, "inspect hooks.list and cron.list, including disabled registrations") {
		t.Fatal("missing pre-enrollment scheduler and permission check")
	}
	_, after, ok := strings.Cut(bootstrap, "```\n")
	if !ok {
		t.Fatal("missing post-bootstrap instructions")
	}
	for _, phrase := range []string{
		"hook-describe", "hook-authorize-registration", "hooks.add", "hooks.enable", "hooks.dry_run", "hook-confirm",
		"poll_interval_secs: 15", "script_timeout_secs: 120", `every: "5m"`, "Report their IDs only after the helper returns registered",
		"Leave the first work check to the scheduler", "VM-loss recovery without exact live observations",
	} {
		if !strings.Contains(after, phrase) {
			t.Fatal("missing managed hook contract", phrase)
		}
	}
	if strings.Contains(result.Prompt, `every: "1h"`) || strings.Contains(result.Prompt, "hourly") {
		t.Fatal("setup prompt contains the retired watchdog cadence")
	}
	var created int
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatal("invalid setup log event", err)
		}
		if event["msg"] != "setup.prompt_created" {
			continue
		}
		created++
		if event["level"] != "INFO" || event["hook_poll_seconds"] != float64(15) || event["watchdog_every"] != "5m" ||
			event["setup_id"] != result.EnrollmentID || event["operation_id"] != result.EnrollmentID || event["request_id"] != requestID {
			t.Fatal("setup log did not identify the issued cadence and operation")
		}
	}
	if created != 1 || strings.Contains(logs.String(), "setup.prompt_detail") || strings.Contains(logs.String(), "muse_enroll_") {
		t.Fatal("setup runtime logs omitted issuance or exposed protected prompt details")
	}
}

func TestSetupFailsBeforeIssuanceWithoutPinsAndPreservesDependencyErrors(t *testing.T) {
	w, m, logger, _ := workerFixture()
	for _, pin := range []PackagePin{{}, {Version: "0.1.0-rc.0"}, {SHA256: strings.Repeat("a", 64)}} {
		_, err := NewSetup(w, pin).Create(context.Background(), logger, "https://example.test:8443")
		if !errors.Is(err, ErrWorkerPackageUnconfigured) || len(m.enrollments) != 0 {
			t.Fatal("unconfigured setup issued authority")
		}
	}
	m.fail = errors.New("storage fixture failure")
	_, err := NewSetup(w, PackagePin{Version: "0.1.0-rc.0", SHA256: strings.Repeat("a", 64)}).Create(context.Background(), logger, "https://example.test:8443")
	if !errors.Is(err, m.fail) || len(m.enrollments) != 0 {
		t.Fatal("dependency failure hidden")
	}
}

func TestSetupOriginAcceptsBracketedIPv6(t *testing.T) {
	w, repo, logger, _ := workerFixture()
	setup := NewSetup(w, PackagePin{Version: "1.2.0", SHA256: strings.Repeat("a", 64)})
	for _, origin := range []string{"https://[invalid]", "https://[127.0.0.1]", "https://[fe80::1%25eth0]", "https://2001:db8::1"} {
		if _, err := setup.Create(t.Context(), logger, origin); !errors.Is(err, ErrSetupOrigin) || len(repo.enrollments) != 0 {
			t.Fatalf("invalid IPv6 origin was admitted: %s, %v", origin, err)
		}
	}
	const origin = "https://[2001:db8::1]:8443"
	prompt, err := setup.Create(t.Context(), logger, origin)
	if err != nil || len(repo.enrollments) != 1 || !strings.Contains(prompt.Prompt, "origin='"+origin+"'") {
		t.Fatal("valid IPv6 origin did not reach the pinned setup prompt", err)
	}
}
