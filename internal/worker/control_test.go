package worker

import (
	"strings"
	"testing"
	"time"
)

func TestControlRequestValueBounds(t *testing.T) {
	for _, valid := range []string{Doctor, DiagnosticsExport, RetryUpdate} {
		if !ValidOpKind(valid) {
			t.Fatalf("typed operation %q was rejected", valid)
		}
	}
	if ValidOpKind("invalid-operation") {
		t.Fatal("unrecognized operation was admitted")
	}
	fullPrompt, fullTitle := strings.Repeat("各", 10922)+"xy", strings.Repeat("界", 120)
	for _, check := range []struct {
		prompt, title string
		valid         bool
	}{
		{"ok", "", true}, {fullPrompt, fullTitle, true}, {fullPrompt + "x", "", false}, {"", "", false},
		{"embedded\x00", "", false}, {"ok", fullTitle + "x", false}, {"ok", "line\nbreak", false},
		{string([]byte{0xff}), "", false}, {"ok", string([]byte{0xff}), false},
	} {
		if TaskPromptValid(check.prompt, check.title) != check.valid {
			t.Fatalf("unexpected validation for %d prompt bytes and %d title bytes", len(check.prompt), len(check.title))
		}
	}
	for _, check := range []struct {
		result TaskResult
		valid  bool
	}{
		{TaskResult{Outcome: "completed", Text: strings.Repeat("a", MaxTaskResult)}, true},
		{TaskResult{Outcome: "completed"}, false},
		{TaskResult{Outcome: "completed", Text: "complete", Reason: "execution_failed"}, false},
		{TaskResult{Outcome: "completed", Text: strings.Repeat("a", MaxTaskResult+1)}, false},
		{TaskResult{Outcome: "failed", Reason: "execution_failed", Summary: strings.Repeat("界", 1000)}, true},
		{TaskResult{Outcome: "failed", Reason: "execution_refused"}, false},
		{TaskResult{Outcome: "refused", Reason: "execution_refused"}, true},
		{TaskResult{Outcome: "refused", Reason: "other"}, false},
		{TaskResult{Outcome: "refused", Summary: strings.Repeat("界", 1001)}, false},
		{TaskResult{Outcome: "queued"}, false},
	} {
		if TaskResultValid(check.result) != check.valid {
			t.Fatalf("unexpected validation for %s result", check.result.Outcome)
		}
	}
}

func TestControlInterruptionKeepsUncertainHolds(t *testing.T) {
	now := time.Now()
	for _, job := range []struct {
		record         ControlRecord
		stage, outcome string
	}{
		{ControlRecord{ControlItem: ControlItem{State: "queued"}}, "dispatch_queue", "not_started"},
		{ControlRecord{ControlItem: ControlItem{State: "claimed", Held: true}}, "awaiting_native_start", "unknown"},
		{ControlRecord{ControlItem: ControlItem{State: "running", Held: true, StartedAt: &now}}, "native_execution", "unknown"},
		{ControlRecord{ControlItem: ControlItem{State: "running", Kind: RetryUpdate, UpdateID: "update"}}, "native_execution", "unknown"},
	} {
		record := job.record
		if !record.Active() {
			t.Fatal("active item was already terminal")
		}
		record.Interrupt("interrupted", "deadline_exceeded", now)
		if record.Active() || record.Interruption["stage"] != job.stage || record.RemoteOutcome != job.outcome ||
			record.Held != job.record.Held || record.FinishedAt == nil || !record.FinishedAt.Equal(now) {
			t.Fatal("interruption invalidated the slot or its evidence")
		}
	}
}
