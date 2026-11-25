package worker

import (
	"encoding/json"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	WorkerOp             = "worker_op"
	AgentTask            = "agent_task"
	Doctor               = "doctor"
	DiagnosticsExport    = "diagnostics_export"
	RetryUpdate          = "retry_update"
	HookPromptContract   = "managed-hook-prompt-v2"
	AgentTasksHeader     = "X-Muse-Worker-Agent-Tasks"
	MaxWorkerOpResult    = 64 * 1024
	MaxDiagnosticsResult = 512 * 1024
	MaxWorkerOpEnvelope  = 768 * 1024
	MaxTaskPrompt        = 32 * 1024
	MaxTaskResult        = 128 * 1024
)

type ControlRequest struct {
	Version        int    `json:"protocol_version"`
	SubmissionID   string `json:"submission_id"`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty"`
}

type OpRequest struct {
	ControlRequest
	Kind   string            `json:"kind"`
	Params *DiagnosticsQuery `json:"params,omitempty"`
}

type TaskRequest struct {
	ControlRequest
	Prompt string `json:"prompt"`
	Title  string `json:"title,omitempty"`
}

type DiagnosticsQuery struct {
	OperationID string     `json:"operation_id,omitempty"`
	RequestID   string     `json:"request_id,omitempty"`
	Since       *time.Time `json:"since,omitempty"`
	Until       *time.Time `json:"until,omitempty"`
	Decode      *bool      `json:"decode,omitempty"`
	MaxBytes    *int       `json:"max_bytes,omitempty"`
	Cursor      string     `json:"cursor,omitempty"`
}

type ControlResult struct {
	Version      int             `json:"protocol_version"`
	SubmissionID string          `json:"submission_id"`
	ClaimID      string          `json:"claim_id"`
	Generation   int64           `json:"generation"`
	Outcome      string          `json:"outcome"`
	Reason       string          `json:"reason,omitempty"`
	Result       json.RawMessage `json:"result,omitempty"`
}

type TaskResult struct {
	Version      int    `json:"protocol_version"`
	SubmissionID string `json:"submission_id"`
	ClaimID      string `json:"claim_id"`
	Generation   int64  `json:"generation"`
	LaunchID     string `json:"launch_id"`
	Outcome      string `json:"outcome"`
	Reason       string `json:"reason,omitempty"`
	Text         string `json:"result_text,omitempty"`
	Summary      string `json:"summary,omitempty"`
}

type Capability struct {
	AgentTasks     bool      `json:"agent_tasks"`
	PromptContract string    `json:"prompt_contract,omitempty"`
	ObservedAt     time.Time `json:"observed_at"`
}

type ControlGrant struct {
	ID          string            `json:"id"`
	OperationID string            `json:"operation_id"`
	ClaimID     string            `json:"claim_id"`
	Generation  int64             `json:"generation"`
	ClaimedAt   time.Time         `json:"claimed_at"`
	DeadlineAt  time.Time         `json:"deadline_at"`
	Kind        string            `json:"kind,omitempty"`
	Params      *DiagnosticsQuery `json:"params,omitempty"`
}

type ControlItem struct {
	ID               string            `json:"id"`
	WorkerID         string            `json:"worker_id"`
	Kind             string            `json:"kind,omitempty"`
	State            string            `json:"state"`
	Title            string            `json:"title,omitempty"`
	Claim            *ControlGrant     `json:"claim,omitempty"`
	Held             bool              `json:"held"`
	UpdateID         string            `json:"update_id,omitempty"`
	CreatedAt        time.Time         `json:"created_at"`
	DeadlineAt       time.Time         `json:"deadline_at"`
	ClaimedAt        *time.Time        `json:"claimed_at,omitempty"`
	StartedAt        *time.Time        `json:"started_at,omitempty"`
	DeliveryFinished *time.Time        `json:"delivery_finished_at,omitempty"`
	FinishedAt       *time.Time        `json:"finished_at,omitempty"`
	Reason           string            `json:"reason,omitempty"`
	ReasonMessage    string            `json:"reason_message,omitempty"`
	RemoteOutcome    string            `json:"remote_outcome"`
	Interruption     map[string]string `json:"interruption,omitempty"`
	ResultBytes      int               `json:"result_bytes"`
	ResultSHA256     string            `json:"result_sha256,omitempty"`
	Prompt           string            `json:"prompt,omitempty"`
	Result           json.RawMessage   `json:"result,omitempty"`
}

type ControlPage struct {
	Items      []ControlItem `json:"items"`
	NextCursor string        `json:"next_cursor,omitempty"`
}

type ControlProjection struct {
	WorkerOpsReady         bool         `json:"worker_ops_ready"`
	AgentTasksReady        bool         `json:"agent_tasks_ready"`
	PromptContract         string       `json:"prompt_contract,omitempty"`
	CapabilitiesObservedAt *time.Time   `json:"capabilities_observed_at,omitempty"`
	ActiveSlotLane         string       `json:"active_slot_lane,omitempty"`
	CurrentWorkerOp        *ControlItem `json:"current_worker_op,omitempty"`
	CurrentAgentTask       *ControlItem `json:"current_agent_task,omitempty"`
}

func (i ControlItem) Active() bool {
	switch i.State {
	case "queued", "claimed", "running":
		return true
	default:
		return false
	}
}

func (i ControlItem) ClaimMatches(claimID string, generation int64) bool {
	return i.Held && i.Claim != nil && i.Claim.ClaimID == claimID && i.Claim.Generation == generation
}

func ValidOpKind(kind string) bool {
	return kind == Doctor || kind == DiagnosticsExport || kind == RetryUpdate
}

func TaskPromptValid(prompt, title string) bool {
	return utf8.ValidString(prompt) && len(prompt) > 0 && len(prompt) <= MaxTaskPrompt && !strings.ContainsRune(prompt, 0) &&
		utf8.ValidString(title) && utf8.RuneCountInString(title) <= 120 && strings.IndexFunc(title, unicode.IsControl) < 0
}

func TaskResultValid(result TaskResult) bool {
	switch result.Outcome {
	case "completed":
		if len(result.Text) == 0 || result.Reason != "" {
			return false
		}
	case "failed":
		if result.Reason != "" && result.Reason != "execution_failed" {
			return false
		}
	case "refused":
		if result.Reason != "" && result.Reason != "execution_refused" {
			return false
		}
	default:
		return false
	}
	return utf8.ValidString(result.Text) && len(result.Text) <= MaxTaskResult &&
		utf8.ValidString(result.Summary) && utf8.RuneCountInString(result.Summary) <= 1000
}

type ControlRef struct {
	Lane         string
	WorkerID     string
	ItemID       string
	SubmissionID string
	InputHash    string
	Credential   *[32]byte
}

type ControlRecord struct {
	ControlItem
	Params           *DiagnosticsQuery
	Pair             Contact
	Checker          string
	PullOccurrence   string
	BoundInvocation  string
	LaunchID         string
	PresenceRun      string
	PresenceSchedule time.Time
	PresenceAt       time.Time
}

type ControlAdmission struct {
	Now          time.Time
	Contact      UpdateStatus
	Capability   *Capability
	Queued       int
	RetryPending bool
}

func (r ControlRecord) Summary() ControlItem {
	item := r.ControlItem
	item.Prompt, item.Result = "", nil
	return item
}

func (r ControlRecord) WakeInvocation() string {
	if r.BoundInvocation != "" {
		return r.BoundInvocation
	}
	return r.PullOccurrence
}

func (r *ControlRecord) Interrupt(state, reason string, now time.Time) {
	r.State, r.Reason, r.FinishedAt = state, reason, &now
	stage := "dispatch_queue"
	r.RemoteOutcome = "not_started"
	if r.Held || r.UpdateID != "" {
		r.RemoteOutcome = "unknown"
		stage = "awaiting_native_start"
		if r.StartedAt != nil || r.UpdateID != "" || r.Kind != "" {
			stage = "native_execution"
		}
	}
	r.Interruption = map[string]string{"stage": stage}
}

type DiagnosticsResult struct {
	Decoded    bool     `json:"decoded"`
	Complete   bool     `json:"complete"`
	Truncated  bool     `json:"truncated"`
	Omissions  []string `json:"omissions"`
	Captures   int      `json:"captures"`
	NextCursor string   `json:"next_cursor,omitempty"`
	Output     []string `json:"output"`
}
