package inference

import (
	"strings"
	"testing"
)

func TestPublicInterruptionExplanations(t *testing.T) {
	for _, tc := range []struct{ reason, stage, native, failure, message string }{
		{"", "", "", "", "No interruption reason was recorded"},
		{"deadline_exceeded", "", "", "", "reached its deadline"},
		{"deadline_exceeded", "dispatch_queue", "", "", "before a worker claimed"},
		{"deadline_exceeded", "awaiting_native_start", "", "", "before the broker authorized"},
		{"deadline_exceeded", "native_execution", "", "", "after the native run started"},
		{"deadline_exceeded", "client_tool_wait", "", "", "waiting for a client tool result"},
		{"deadline_exceeded", "claimed", "", "", "assigned to a worker"},
		{"worker_revoked", "", "", "", "access was revoked"},
		{"worker_disconnected", "", "", "", "lost its broker connection"},
		{"lease_expired", "", "", "", "assignment expired"},
		{"launch_not_authorized", "", "", "", "never authorized"},
		{"native_cancelled_before_start", "", "", "", "cancelled the native run before it started"},
		{"execution_confirmed_stopped", "", "completed", "", "native run completed"},
		{"execution_confirmed_stopped", "", "failed", "", "native run failed"},
		{"execution_confirmed_stopped", "", "cancelled", "", "native run was cancelled"},
		{"execution_confirmed_stopped", "", "", "", "worker confirmed that the native run stopped"},
		{"execution_confirmed_stopped", "", "failed", "media_output_missing", "could not find the generated media"},
		{"execution_confirmed_stopped", "", "failed", "media_output_invalid", "could not accept the generated media"},
		{"execution_confirmed_stopped", "", "failed", "decision_rejected", "broker rejected its result"},
	} {
		evidence := InterruptionEvidence{Stage: tc.stage, NativeStatus: tc.native, ResultFailure: tc.failure}
		if got := ExplainInterruption("interrupted", tc.reason, &evidence); !strings.Contains(got, tc.message) {
			t.Errorf("%+v: %q", tc, got)
		}
	}
	if ExplainInterruption("interrupted", "historical_unknown_code", nil) != "" || ExplainInterruption("completed", "", nil) != "" {
		t.Fatal("explanation supplied without a supported interruption")
	}
	for _, tc := range []struct {
		status, failure string
		valid           bool
	}{
		{"completed", "", true}, {"failed", "media_output_invalid", true}, {"cancelled", "decision_rejected", true},
		{"running", "", false}, {"failed", "provider-private-data", false},
	} {
		if got := (InterruptionEvidence{NativeStatus: tc.status, ResultFailure: tc.failure}).ValidNative(); got != tc.valid {
			t.Errorf("%+v: valid=%t", tc, got)
		}
	}
}
