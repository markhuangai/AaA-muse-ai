package service

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
)

func TestSetupPromptUsesIssuedAuthorityAndPinnedMechanics(t *testing.T) {
	w, m, logger, _ := workerFixture()
	s := NewSetup(w, "https://example.test/", config.WorkerPackage{Version: "0.1.0-rc.0", SHA256: strings.Repeat("a", 64)})
	result, err := s.Create(context.Background(), logger)
	if err != nil || result.EnrollmentID == "" || result.ExpiresAt.Sub(result.CreatedAt) != EnrollmentLifetime {
		t.Fatal("setup issuance failed", err)
	}
	code := regexp.MustCompile(`muse_enroll_[A-Za-z0-9_-]{43}`).FindString(result.Prompt)
	if code == "" {
		t.Fatal("complete prompt lacks bootstrap authority")
	}
	for _, fragment := range []string{result.WorkerPackage.URL, result.WorkerPackage.SHA256, "hooks.list", "include_disabled:true", "hooks.add", "five-second", "no script arguments", "HATCH_HOOK_RUNTIME", "muse.skill_search", "End this installation turn", "single-use", "sha256sum", "actual_version", "setup.digest_mismatch"} {
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

func TestSetupFailsBeforeIssuanceWithoutPinsAndPreservesDependencyErrors(t *testing.T) {
	w, m, logger, _ := workerFixture()
	for _, pin := range []config.WorkerPackage{{}, {Version: "0.1.0-rc.0"}, {SHA256: strings.Repeat("a", 64)}} {
		_, err := NewSetup(w, "https://example.test", pin).Create(context.Background(), logger)
		if !errors.Is(err, ErrWorkerPackageUnconfigured) || len(m.enrollments) != 0 {
			t.Fatal("unconfigured setup issued authority")
		}
	}
	m.fail = errors.New("storage fixture failure")
	_, err := NewSetup(w, "https://example.test", config.WorkerPackage{Version: "0.1.0-rc.0", SHA256: strings.Repeat("a", 64)}).Create(context.Background(), logger)
	if !errors.Is(err, m.fail) || len(m.enrollments) != 0 {
		t.Fatal("dependency failure hidden")
	}
}
