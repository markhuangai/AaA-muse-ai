package inference

type InterruptionEvidence struct {
	Stage         string `json:"stage,omitempty"`
	NativeStatus  string `json:"native_status,omitempty"`
	ResultFailure string `json:"result_failure,omitempty"`
}

func ParseNativeInterruptionEvidence(status, failure string) (InterruptionEvidence, bool) {
	var evidence InterruptionEvidence
	// Use fixed values so diagnostics never retain request header text.
	switch status {
	case "completed":
		evidence.NativeStatus = "completed"
	case "failed":
		evidence.NativeStatus = "failed"
	case "cancelled":
		evidence.NativeStatus = "cancelled"
	default:
		return InterruptionEvidence{}, false
	}
	switch failure {
	case "":
	case "media_output_missing":
		evidence.ResultFailure = "media_output_missing"
	case "media_output_invalid":
		evidence.ResultFailure = "media_output_invalid"
	case "decision_rejected":
		evidence.ResultFailure = "decision_rejected"
	default:
		return InterruptionEvidence{}, false
	}
	return evidence, true
}

func (d InterruptionEvidence) ValidNative() bool {
	_, valid := ParseNativeInterruptionEvidence(d.NativeStatus, d.ResultFailure)
	return valid
}

func (e Experiment) ReasonMessage() string {
	return ExplainInterruption(e.State, e.Reason, e.Interruption)
}

func ExplainInterruption(state, reason string, evidence *InterruptionEvidence) string {
	if state != "interrupted" {
		return ""
	}
	if evidence == nil {
		evidence = &InterruptionEvidence{}
	}
	switch reason {
	case "":
		return "No interruption reason was recorded."
	case "deadline_exceeded":
		switch evidence.Stage {
		case "dispatch_queue":
			return "The deadline passed before a worker claimed this task."
		case "awaiting_native_start":
			return "The deadline passed before the broker authorized the native run."
		case "native_execution":
			return "The deadline passed after the native run started and before the broker accepted a result."
		case "client_tool_wait":
			return "The deadline passed while waiting for a client tool result."
		case "claimed":
			return "The deadline passed while the task was assigned to a worker."
		default:
			return "The task reached its deadline."
		}
	case "worker_revoked":
		return "The worker’s access was revoked before the task finished."
	case "worker_disconnected":
		return "The worker lost its broker connection before the task finished."
	case "lease_expired":
		return "The worker’s assignment expired before the task finished."
	case "launch_not_authorized":
		return "The broker never authorized the native run to start."
	case "native_cancelled_before_start":
		return "Muse cancelled the native run before it started."
	case "execution_confirmed_stopped":
		switch evidence.ResultFailure {
		case "media_output_missing":
			return "The native run stopped and the worker could not find the generated media file."
		case "media_output_invalid":
			return "The native run stopped and the broker could not accept the generated media file."
		case "decision_rejected":
			return "The native run stopped after the broker rejected its result."
		}
		switch evidence.NativeStatus {
		case "completed":
			return "Muse reported that the native run completed before the broker accepted a result."
		case "failed":
			return "Muse reported that the native run failed before the broker accepted a result."
		case "cancelled":
			return "Muse reported that the native run was cancelled before the broker accepted a result."
		default:
			return "The worker confirmed that the native run stopped before the broker accepted a result."
		}
	}
	return ""
}
