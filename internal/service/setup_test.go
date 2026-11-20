package service

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"
)

func TestSetupPromptUsesIssuedAuthorityAndPinnedMechanics(t *testing.T) {
	w, m, logger, _ := workerFixture()
	s := NewSetup(w, PackagePin{Version: "0.1.0-rc.0", SHA256: strings.Repeat("a", 64)})
	result, err := s.Create(context.Background(), logger, "https://example.test:8443")
	if err != nil || result.EnrollmentID == "" || result.ExpiresAt.Sub(result.CreatedAt) != EnrollmentLifetime {
		t.Fatal("setup issuance failed", err)
	}
	code := regexp.MustCompile(`muse_enroll_[A-Za-z0-9_-]{43}`).FindString(result.Prompt)
	if code == "" {
		t.Fatal("complete prompt lacks bootstrap authority")
	}
	for _, fragment := range []string{result.WorkerPackage.URL, result.WorkerPackage.SHA256, "hooks.list", "include_disabled:true", "hooks.add", "five-second", "no script arguments", "HATCH_HOOK_RUNTIME", "muse.skill_search", "End this installation turn", "single-use", "sha256sum", "actual_version", "setup.digest_mismatch", "empty 2700 worker directory", "confirming the saved worker identity"} {
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

func TestSetupPromptRequiresVerifiedNativeWatchdogAndScopedUpgrade(t *testing.T) {
	w, _, logger, _ := workerFixture()
	s := NewSetup(w, PackagePin{Version: "0.1.0-rc.0", SHA256: strings.Repeat("a", 64)})
	result, err := s.Create(context.Background(), logger, "https://example.test")
	if err != nil {
		t.Fatal(err)
	}
	before, after, ok := strings.Cut(result.Prompt, "```bash")
	if !ok || !strings.Contains(before, "request permission for a no-argument five-second hook and a native five-minute job owned by this installation goal with a 300-second timeout") {
		t.Fatal("missing pre-enrollment scheduler and permission check")
	}
	for _, phrase := range []string{
		"Reuse an exact enabled match; create only an absent job", "in-place update of this same installation's identifiable legacy job that calls hook-check",
		"Read back the saved job ID, owner goal, action and state path, cadence, timeout and enabled status", "Re-list after any uncertain write",
		"Setup remains incomplete if either registration cannot be verified", "On every run, use hooks.list with include_disabled:true",
		"verify its single enabled five-second hook by ID, path and interval", "invoke the exact installed watchdog-check command once",
		"stay silent", "first unattended execution, native message delivery and VM replacement or supported-refresh survival",
	} {
		if !strings.Contains(after, phrase) {
			t.Fatal("missing watchdog contract", phrase)
		}
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
