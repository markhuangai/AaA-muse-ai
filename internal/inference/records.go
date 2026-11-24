package inference

import (
	"encoding/json"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const Version = 1
const MaxContextBytes = 1024 * 1024
const HealthInterval = 10 * time.Second
const HealthWindow = 30 * time.Second

type Item struct {
	Type      string         `json:"type"`
	Role      string         `json:"role,omitempty"`
	Text      string         `json:"text,omitempty"`
	CallID    string         `json:"call_id,omitempty"`
	Name      string         `json:"name,omitempty"`
	Arguments map[string]any `json:"arguments,omitempty"`
	Output    string         `json:"output,omitempty"`
}

type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters"`
}

type Probe struct {
	Kind          string `json:"kind"`
	BaseReceiptID string `json:"base_receipt_id,omitempty"`
}

type Create struct {
	Version        int    `json:"protocol_version"`
	SubmissionID   string `json:"submission_id"`
	WorkerID       string `json:"worker_id"`
	Messages       []Item `json:"messages"`
	Tools          []Tool `json:"tools"`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty"`
	ContextProbe   *Probe `json:"context_probe,omitempty"`
}

type Assignment struct {
	JobID      string `json:"job_id"`
	Generation int64  `json:"generation"`
	LeaseID    string `json:"lease_id"`
}

type Pull struct {
	Version     int                 `json:"protocol_version"`
	Sequence    int64               `json:"sequence"`
	Checker     string              `json:"checker_job_id"`
	Occurrence  string              `json:"checker_run_id"`
	ScheduledAt time.Time           `json:"scheduled_at"`
	EnteredAt   time.Time           `json:"entered_at"`
	MediaJobs   bool                `json:"media_jobs"`
	PromptWAV   bool                `json:"prompt_wav"`
	WeeklyUsage *worker.WeeklyUsage `json:"-"`
	VerifyStart bool                `json:"-"`
}

type Grant struct {
	JobID       string    `json:"job_id"`
	OperationID string    `json:"operation_id"`
	ClaimID     string    `json:"claim_id"`
	Generation  int64     `json:"generation"`
	ClaimedAt   time.Time `json:"claimed_at"`
	DeadlineAt  time.Time `json:"deadline_at"`
}

type PullResult struct {
	Job    *Grant              `json:"job"`
	Update *worker.UpdateOffer `json:"update,omitempty"`
}

type PullTiming struct {
	Acquire           time.Duration
	Select            time.Duration
	PreviousPin       string
	PreviousPinReason string
	Update            worker.UpdateStatus
	UsageResult       string
	UsageDecision     string
	EffectiveUsage    *worker.WeeklyUsage
	UsageDeferrals    []UsageDeferral
}

type UsageDeferral struct {
	JobID           string    `json:"job_id"`
	OperationID     string    `json:"operation_id"`
	PreferredWorker string    `json:"preferred_worker_id"`
	PercentUsed     float64   `json:"used_percent"`
	ObservedAt      time.Time `json:"observed_at"`
	Until           time.Time `json:"until"`
}

const OfflinePinReason = "offline_before_claim_and_context"
const ExhaustedPinReason = "weekly_allowance_exhausted_before_claim"

type BusyCheck struct {
	Version     int                 `json:"protocol_version"`
	ClaimID     string              `json:"claim_id"`
	Generation  int64               `json:"generation"`
	Checker     string              `json:"checker_job_id"`
	Occurrence  string              `json:"checker_run_id"`
	ScheduledAt time.Time           `json:"scheduled_at"`
	Reason      string              `json:"hold_reason,omitempty"`
	WeeklyUsage *worker.WeeklyUsage `json:"-"`
}

type BusyPresence struct {
	Occurrence  string    `json:"checker_run_id"`
	ScheduledAt time.Time `json:"scheduled_at"`
	ReceivedAt  time.Time `json:"received_at"`
	Reason      string    `json:"hold_reason,omitempty"`
}

type PresenceReceipt struct {
	Recorded    bool      `json:"recorded"`
	ReceivedAt  time.Time `json:"received_at"`
	UsageResult string    `json:"-"`
}

type WorkStart struct {
	Version      int               `json:"protocol_version"`
	ClaimID      string            `json:"claim_id"`
	Generation   int64             `json:"generation"`
	LaunchID     string            `json:"launch_id"`
	NativeJob    string            `json:"native_job_id"`
	Verification *NativeStartProof `json:"verification,omitempty"`
}

type Interruption struct {
	Version       int    `json:"protocol_version"`
	SubmissionID  string `json:"submission_id"`
	ClaimID       string `json:"claim_id"`
	Generation    int64  `json:"generation"`
	LaunchID      string `json:"launch_id"`
	NativeJob     string `json:"native_job_id"`
	NativeRun     string `json:"native_run_id"`
	Reason        string `json:"reason"`
	VerifiedStart bool   `json:"verified_start,omitempty"`
}

type WorkOutcome struct {
	JobID    string          `json:"job_id"`
	ClaimID  string          `json:"claim_id"`
	State    string          `json:"state"`
	Reason   string          `json:"reason,omitempty"`
	Accepted json.RawMessage `json:"accepted,omitempty"`
}

type Heartbeat struct {
	Version      int         `json:"protocol_version"`
	ConnectionID string      `json:"connection_id"`
	Generation   int64       `json:"connection_generation"`
	ChallengeID  string      `json:"challenge_id"`
	IdleAck      *Assignment `json:"idle_ack,omitempty"`
}

type Claim struct {
	Version              int    `json:"protocol_version"`
	SubmissionID         string `json:"submission_id"`
	ConnectionID         string `json:"connection_id"`
	ConnectionGeneration int64  `json:"connection_generation"`
}

type Submit struct {
	Claim
	ConversationID   string `json:"conversation_id"`
	Generation       int64  `json:"generation"`
	LeaseID          string `json:"lease_id"`
	ContextReceiptID string `json:"context_receipt_id"`
	Decision         Item   `json:"decision"`
}

type ToolResult struct {
	Version      int    `json:"protocol_version"`
	SubmissionID string `json:"submission_id"`
	CallID       string `json:"call_id"`
	Output       string `json:"output"`
	ContextProbe *Probe `json:"context_probe,omitempty"`
}

type Cancel struct {
	Version      int    `json:"protocol_version"`
	SubmissionID string `json:"submission_id"`
}

type Experiment struct {
	ID             string                `json:"id"`
	ConversationID string                `json:"conversation_id"`
	WorkerID       string                `json:"worker_id"`
	State          string                `json:"state"`
	CurrentJobID   string                `json:"current_job_id"`
	CreatedAt      time.Time             `json:"created_at"`
	DeadlineAt     time.Time             `json:"deadline_at"`
	Tools          []Tool                `json:"tools"`
	Messages       []Item                `json:"messages"`
	FinalText      string                `json:"final_text,omitempty"`
	Reason         string                `json:"reason,omitempty"`
	RemoteOutcome  string                `json:"remote_outcome"`
	Interruption   *InterruptionEvidence `json:"interruption,omitempty"`
}

func (e Experiment) Terminal() bool {
	return e.State == "completed" || e.State == "cancelled" || e.State == "interrupted"
}

type Delivery struct {
	ReceiptID       string `json:"receipt_id"`
	Kind            string `json:"kind"`
	BaseReceiptID   string `json:"base_receipt_id,omitempty"`
	BasePrefix      int    `json:"base_prefix"`
	BaseSHA256      string `json:"base_sha256,omitempty"`
	HistoryCount    int    `json:"history_count"`
	CanonicalSHA256 string `json:"canonical_sha256"`
	Messages        []Item `json:"messages"`
	Tools           []Tool `json:"tools"`
}

type MediaStream struct {
	Type  string `json:"type"`
	Codec string `json:"codec"`
}

type MediaProperties struct {
	MediaType   string        `json:"media_type"`
	Size        int64         `json:"size"`
	SHA256      string        `json:"sha256"`
	Duration    float64       `json:"duration"`
	Width       int           `json:"width,omitempty"`
	Height      int           `json:"height,omitempty"`
	FPS         float64       `json:"fps,omitempty"`
	VideoFrames int           `json:"video_frames,omitempty"`
	Streams     []MediaStream `json:"streams"`
}

// Media contains the durable receipt. Customer prompts and file bytes live only in the private spool.
type Media struct {
	Owner       string           `json:"owner"`
	Profile     string           `json:"profile"`
	PromptHash  string           `json:"prompt_sha256,omitempty"`
	InputHash   string           `json:"input_sha256,omitempty"`
	InputType   string           `json:"input_type,omitempty"`
	InputSize   int64            `json:"input_size,omitempty"`
	Artifact    *MediaProperties `json:"artifact,omitempty"`
	CommittedAt *time.Time       `json:"committed_at,omitempty"`
	ExpiresAt   *time.Time       `json:"expires_at,omitempty"`
}

type Job struct {
	Media                *Media         `json:"media,omitempty"`
	Version              int            `json:"protocol_version"`
	ID                   string         `json:"id"`
	ExperimentID         string         `json:"experiment_id"`
	ConversationID       string         `json:"conversation_id"`
	WorkerID             string         `json:"worker_id"`
	State                string         `json:"state"`
	CreatedAt            time.Time      `json:"created_at"`
	DeadlineAt           time.Time      `json:"deadline_at"`
	ClaimedAt            *time.Time     `json:"claimed_at"`
	StartedAt            *time.Time     `json:"started_at,omitempty"`
	LaunchID             string         `json:"launch_id,omitempty"`
	NativeJob            string         `json:"native_job_id,omitempty"`
	BusyPresence         *BusyPresence  `json:"busy_presence,omitempty"`
	PinCheckAt           *time.Time     `json:"pin_check_at,omitempty"`
	ReroutedFrom         string         `json:"rerouted_from,omitempty"`
	Outcome              *WorkOutcome   `json:"work_outcome,omitempty"`
	LeaseExpiresAt       *time.Time     `json:"lease_expires_at"`
	Generation           int64          `json:"generation"`
	LeaseID              string         `json:"lease_id"`
	Held                 bool           `json:"held"`
	ConnectionID         string         `json:"connection_id"`
	ConnectionGeneration int64          `json:"connection_generation"`
	Context              Delivery       `json:"context"`
	Reason               string         `json:"reason,omitempty"`
	Qualification        *Qualification `json:"qualification,omitempty"`
}

type Challenge struct {
	ID        string    `json:"challenge_id"`
	IssuedAt  time.Time `json:"issued_at"`
	ReplyHash string    `json:"reply_hash,omitempty"`
}

type ModelReport struct {
	ModelName           *string   `json:"model_name,omitempty"`
	ContextWindowTokens *int64    `json:"context_window_tokens,omitempty"`
	ReportedAt          time.Time `json:"reported_at"`
}

type Connection struct {
	MediaJobs            bool         `json:"media_jobs,omitempty"`
	PromptWAV            bool         `json:"prompt_wav,omitempty"`
	ID                   string       `json:"connection_id"`
	Generation           int64        `json:"connection_generation"`
	AssignmentGeneration int64        `json:"assignment_generation"`
	Connected            bool         `json:"connected"`
	OpenedAt             time.Time    `json:"opened_at"`
	LastAckAt            *time.Time   `json:"last_ack_at"`
	OfflineSince         *time.Time   `json:"offline_since,omitempty"`
	Challenges           []Challenge  `json:"challenges"`
	ModelReport          *ModelReport `json:"model_report,omitempty"`
}

func (c Connection) HealthDeadline() time.Time {
	if c.LastAckAt != nil {
		return c.LastAckAt.Add(HealthWindow)
	}
	return c.OpenedAt.Add(HealthWindow)
}

func (c Connection) Status(now time.Time) string {
	if c.ID == "" {
		return "not_observed"
	}
	if !c.Connected || !now.Before(c.HealthDeadline()) {
		return "offline"
	}
	if c.LastAckAt == nil {
		return "connecting"
	}
	return "online"
}

type Projection struct {
	ConnectionStatus     string                  `json:"connection_status"`
	OfflineForMS         *int64                  `json:"offline_for_ms,omitempty"`
	WorkStatus           string                  `json:"work_status"`
	CurrentJob           *Assignment             `json:"current_job"`
	WaitingForTool       int                     `json:"waiting_for_client_tool"`
	LastHeartbeatAt      *time.Time              `json:"last_heartbeat_at"`
	InferenceReadiness   string                  `json:"inference_readiness"`
	Qualification        *Qualification          `json:"qualification,omitempty"`
	QualificationHistory []Qualification         `json:"qualification_history"`
	ModelReport          *ModelReport            `json:"model_report,omitempty"`
	LastPollAt           *time.Time              `json:"last_poll_at"`
	NativeContactAt      *time.Time              `json:"-"`
	Update               *worker.UpdateStatus    `json:"worker_update,omitempty"`
	WeeklyUsage          *worker.WeeklyUsageView `json:"weekly_usage,omitempty"`
	BusyReason           string                  `json:"busy_reason,omitempty"`
	Claim                *Grant                  `json:"current_claim"`
	ClaimAgeMS           *int64                  `json:"claim_age_ms,omitempty"`
	ClaimStage           string                  `json:"claim_stage,omitempty"`
	ClaimStartedAt       *time.Time              `json:"claim_started_at,omitempty"`
}

type Receipt struct {
	Principal    string          `json:"principal"`
	SubmissionID string          `json:"submission_id"`
	InputHash    string          `json:"input_hash"`
	Result       json.RawMessage `json:"result"`
}

type Ref struct {
	WorkerID, ExperimentID, JobID, BaseJobID string
	Principal, SubmissionID                  string
	WorkerAuth                               string
	Admission, Full                          bool
	Routing                                  bool
	Recovery                                 bool
	UpdateRouting                            bool
	Correlation                              map[string]any
	ClientID, SessionID, ResponseID          string
	ReferenceRequestID                       string
	ConversationID, ReplayHash               string
	CountPendingTools                        bool
	HistoryInputCount                        int
	Responses                                bool
	Single                                   bool
	PollProjection                           bool
	NativeWork                               bool
}

type State struct {
	DatabaseTime          func() (time.Time, error) `json:"-"`
	WorkerID              string
	Revoked               bool
	Now                   time.Time
	Connection            Connection
	LastPollAt            *time.Time
	LastContactAt         *time.Time
	WorkerUpdate          *worker.UpdateStatus
	WeeklyUsage           *worker.WeeklyUsage
	QuotaTransferFrom     string
	Experiments           map[string]*Experiment
	Jobs                  map[string]*Job
	Receipt               *Receipt
	NativeWork            *NativeWorkReceipt
	Conversations         map[string]*Conversation
	Requests              map[string]*Request
	PendingTools          int
	HistoryConversationID string
	Routing               WorkerRouting
	Pool                  map[string]*State
	Recovery              RecoverySummary
}

type RecoverySummary struct {
	Receipts      int `json:"durable_receipts"`
	Conversations int `json:"durable_conversations"`
}

type Rejection struct {
	Reason string
	Code   int
	Fields map[string]any
}

func (r *Rejection) Error() string { return r.Reason }
func Reject(reason string, code int, fields ...any) error {
	r := &Rejection{Reason: reason, Code: code, Fields: map[string]any{}}
	for i := 0; i+1 < len(fields); i += 2 {
		r.Fields[fields[i].(string)] = fields[i+1]
	}
	return r
}
