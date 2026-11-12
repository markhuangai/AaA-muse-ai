package inference

import (
	"encoding/json"
	"time"
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
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	WorkerID       string    `json:"worker_id"`
	State          string    `json:"state"`
	CurrentJobID   string    `json:"current_job_id"`
	CreatedAt      time.Time `json:"created_at"`
	DeadlineAt     time.Time `json:"deadline_at"`
	Tools          []Tool    `json:"tools"`
	Messages       []Item    `json:"messages"`
	FinalText      string    `json:"final_text,omitempty"`
	Reason         string    `json:"reason,omitempty"`
	RemoteOutcome  string    `json:"remote_outcome"`
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

type Job struct {
	Version              int            `json:"protocol_version"`
	ID                   string         `json:"id"`
	ExperimentID         string         `json:"experiment_id"`
	ConversationID       string         `json:"conversation_id"`
	WorkerID             string         `json:"worker_id"`
	State                string         `json:"state"`
	CreatedAt            time.Time      `json:"created_at"`
	DeadlineAt           time.Time      `json:"deadline_at"`
	ClaimedAt            *time.Time     `json:"claimed_at"`
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

type Connection struct {
	ID                   string      `json:"connection_id"`
	Generation           int64       `json:"connection_generation"`
	AssignmentGeneration int64       `json:"assignment_generation"`
	Connected            bool        `json:"connected"`
	OpenedAt             time.Time   `json:"opened_at"`
	LastAckAt            *time.Time  `json:"last_ack_at"`
	Challenges           []Challenge `json:"challenges"`
}

func (c Connection) Status(now time.Time) string {
	if c.ID == "" {
		return "not_observed"
	}
	if !c.Connected {
		return "offline"
	}
	if c.LastAckAt != nil && now.Before(c.LastAckAt.Add(HealthWindow)) {
		return "online"
	}
	if c.LastAckAt == nil && now.Before(c.OpenedAt.Add(HealthWindow)) {
		return "connecting"
	}
	return "offline"
}

type Projection struct {
	ConnectionStatus     string          `json:"connection_status"`
	WorkStatus           string          `json:"work_status"`
	CurrentJob           *Assignment     `json:"current_job"`
	WaitingForTool       int             `json:"waiting_for_client_tool"`
	LastHeartbeatAt      *time.Time      `json:"last_heartbeat_at"`
	InferenceReadiness   string          `json:"inference_readiness"`
	Qualification        *Qualification  `json:"qualification,omitempty"`
	QualificationHistory []Qualification `json:"qualification_history"`
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
	EvidenceIDs                              []string
	Correlation                              map[string]any
	ClientID, SessionID, ResponseID          string
	ConversationID, ReplayHash               string
	CountPendingTools                        bool
	HistoryInputCount                        int
}

type State struct {
	WorkerID              string
	Revoked               bool
	Now                   time.Time
	Connection            Connection
	Experiments           map[string]*Experiment
	Jobs                  map[string]*Job
	Receipt               *Receipt
	ActiveCount           int
	Conversations         map[string]*Conversation
	Requests              map[string]*Request
	PendingTools          int
	HistoryConversationID string
	Routing               WorkerRouting
	Pool                  map[string]*State
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
