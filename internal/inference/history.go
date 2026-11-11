package inference

import (
	"encoding/base64"
	"encoding/json"
	"time"
)

const MaxTimelineBytes = 2 * 1024 * 1024

type RequestInput struct {
	Version            int    `json:"protocol_version"`
	SubmissionID       string `json:"submission_id"`
	WorkerID           string `json:"worker_id"`
	Messages           []Item `json:"messages"`
	Tools              []Tool `json:"tools"`
	TimeoutSeconds     int    `json:"timeout_seconds,omitempty"`
	PreviousResponseID string `json:"previous_response_id,omitempty"`
}

type HistoryItem struct {
	ID        string    `json:"id"`
	Sequence  int       `json:"sequence"`
	RequestID string    `json:"request_id"`
	Source    string    `json:"source"`
	Time      time.Time `json:"time"`
	Item      Item      `json:"item"`
}

type TimelineEvent struct {
	Sequence  int             `json:"sequence"`
	Time      *time.Time      `json:"time"`
	Kind      string          `json:"kind"`
	Level     string          `json:"level"`
	RequestID string          `json:"request_id"`
	Details   json.RawMessage `json:"details"`
}

type Conversation struct {
	ID               string          `json:"id"`
	ClientID         string          `json:"client_id"`
	SessionID        string          `json:"session_id"`
	WorkerID         string          `json:"worker_id"`
	CreatedAt        time.Time       `json:"created_at"`
	CurrentRequestID string          `json:"current_request_id"`
	PendingCallID    string          `json:"pending_call_id"`
	ItemCount        int             `json:"item_count"`
	EventCount       int             `json:"event_count"`
	Items            []HistoryItem   `json:"items,omitempty"`
	Events           []TimelineEvent `json:"events,omitempty"`
}

type Request struct {
	ID                     string       `json:"id"`
	ConversationID         string       `json:"conversation_id"`
	ClientID               string       `json:"client_id"`
	SessionID              string       `json:"session_id"`
	WorkerID               string       `json:"worker_id"`
	ResponseID             string       `json:"response_id"`
	CreatedAt              time.Time    `json:"created_at"`
	State                  string       `json:"state"`
	Reason                 string       `json:"reason,omitempty"`
	ReplayHash             string       `json:"replay_hash"`
	Input                  RequestInput `json:"input"`
	RequestedSession       string       `json:"requested_session"`
	InputCount             int          `json:"input_count"`
	CanonicalEnd           int          `json:"canonical_end"`
	Output                 *Item        `json:"output,omitempty"`
	ContextDeliveryStarted *time.Time   `json:"context_delivery_started_at,omitempty"`
	ContextDeliveryWritten *time.Time   `json:"context_delivery_written_at,omitempty"`
	DecisionAcceptedAt     *time.Time   `json:"decision_accepted_at,omitempty"`
	OutputStartedAt        *time.Time   `json:"output_started_at,omitempty"`
	OutputCompletedAt      *time.Time   `json:"output_completed_at,omitempty"`
}

type RequestView struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	SessionID      string    `json:"session_id"`
	WorkerID       string    `json:"worker_id"`
	ResponseID     string    `json:"response_id"`
	State          string    `json:"state"`
	Reason         string    `json:"reason,omitempty"`
	Output         *Item     `json:"output,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

func (r *Request) View(output bool) RequestView {
	v := RequestView{ID: r.ID, ConversationID: r.ConversationID, SessionID: r.SessionID, WorkerID: r.WorkerID, ResponseID: r.ResponseID, State: r.State, Reason: r.Reason, CreatedAt: r.CreatedAt}
	if output {
		v.Output = r.Output
	}
	return v
}

type HistoryQuery struct {
	Kind           string
	ID             string
	ConversationID string
	Limit          int
	After          PageCursor
}

type PageCursor struct {
	Kind           string    `json:"kind"`
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	Time           time.Time `json:"time"`
	Sequence       int       `json:"sequence"`
}

type HistoryPage struct {
	Items      []json.RawMessage `json:"items"`
	NextCursor string            `json:"next_cursor,omitempty"`
}

func EncodeCursor(c PageCursor) (string, error) {
	b, err := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b), err
}

func DecodeCursor(value string, q HistoryQuery) (PageCursor, error) {
	var c PageCursor
	b, err := base64.RawURLEncoding.DecodeString(value)
	if len(value) > 1024 || err != nil || Decode(b, &c) != nil || c.Kind != q.Kind || c.ConversationID != q.ConversationID || !Identifier.MatchString(c.ID) || c.Sequence < 0 || (q.Kind == "timeline" && c.ID != q.ID) || (q.Kind != "timeline" && c.Time.IsZero()) {
		return c, Reject("invalid_cursor", 400)
	}
	return c, nil
}

func Messages(c *Conversation, count int) []Item {
	messages := make([]Item, 0, count)
	for _, item := range c.Items {
		if item.Sequence >= count {
			break
		}
		messages = append(messages, item.Item)
	}
	return messages
}
