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
	s := NewSetup(w, PackagePin{Version: "1.0.0-rc.0", SHA256: strings.Repeat("a", 64)})
	result, err := s.Create(context.Background(), logger, "https://example.test:8443")
	if err != nil || result.EnrollmentID == "" || result.ExpiresAt.Sub(result.CreatedAt) != EnrollmentLifetime {
		t.Fatal("setup issuance failed", err)
	}
	code := regexp.MustCompile(`muse_enroll_[A-Za-z0-9_-]{43}`).FindString(result.Prompt)
	if code == "" {
		t.Fatal("complete prompt lacks bootstrap authority")
	}
	for _, fragment := range []string{result.WorkerPackage.URL, result.WorkerPackage.SHA256, "actual permissions", "including disabled jobs", "separate major-1 paths", "End this installation turn", "single-use", "sha256sum", "actual_version", "setup.digest_mismatch"} {
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

func TestSetupPromptRequiresVerifiedNativeCheckerAndFiniteWork(t *testing.T) {
	w, _, logger, _ := workerFixture()
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
	if !strings.Contains(before, "register or reuse one visible one-minute checker and verify the saved job") ||
		!strings.Contains(before, "If Muse requires another approval, show me the specific request.") {
		t.Fatal("missing scoped checker authorization and Muse approval instructions")
	}
	if !strings.Contains(before, "visible one-minute native agent cron and finite native agent runonce jobs owned by this goal") {
		t.Fatal("missing pre-enrollment scheduler and permission check")
	}
	_, after, ok := strings.Cut(bootstrap, "```\n")
	if !ok {
		t.Fatal("missing post-bootstrap instructions")
	}
	for _, phrase := range []string{
		"cron_registration: pending", "Continue with the enrolled worker in this turn",
		`Reuse one exact enabled match by goal, name, every: "1m", execution.kind=agent and exact prompt`,
		"cron-authorize-registration", "After a write or uncertain reply, reread the native jobs", "cron-confirm",
		"Setup is incomplete until this read-back succeeds", "When cron-confirm returns registered, report the checker job ID",
		"Leave the first work check to the scheduler", "Do not process model work in this turn", "one finite native agent runonce",
		"earliest supported absolute UTC due time inside the existing deadline", "VM-loss recovery without exact live observations",
	} {
		if !strings.Contains(after, phrase) {
			t.Fatal("missing native cron contract", phrase)
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
