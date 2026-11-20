package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

const conversationRecords = `SELECT c.id,c.created_at,'native' AS kind,c.data,e.state
 FROM aaa_conversations c LEFT JOIN aaa_experiments e ON e.id=c.current_request_id
 UNION ALL SELECT e.conversation_id,e.created_at,'legacy',e.data,e.state FROM aaa_experiments e
 WHERE NOT EXISTS(SELECT 1 FROM aaa_model_requests m WHERE m.id=e.id)`

const requestRecords = `SELECT e.id,e.created_at,e.conversation_id,e.worker_id,e.state,e.data,m.client_id,m.response_id,c.session_id
 FROM aaa_experiments e LEFT JOIN aaa_model_requests m ON m.id=e.id
 LEFT JOIN aaa_conversations c ON c.id=m.conversation_id`

type executionMetadata struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	WorkerID       *string   `json:"worker_id"`
	State          string    `json:"state"`
	Reason         *string   `json:"reason"`
	RemoteOutcome  *string   `json:"remote_outcome"`
	CreatedAt      time.Time `json:"created_at"`
	DeadlineAt     time.Time `json:"deadline_at"`
	CurrentJobID   string    `json:"current_job_id"`
}

func (r *Repository) QueryHistory(ctx context.Context, q inference.HistoryQuery) (json.RawMessage, error) {
	var result json.RawMessage
	err := r.read(ctx, func(tx *sql.Tx) error {
		var err error
		switch q.Kind {
		case "conversation":
			_, _, result, err = scanConversation(tx.QueryRowContext(ctx, "SELECT * FROM ("+conversationRecords+") WHERE id=?1", q.ID))
		case "request":
			result, err = historyRequest(ctx, tx, q.ID)
		case "conversations", "requests", "timeline":
			result, err = historyPage(ctx, tx, q)
		default:
			err = inference.Reject("unsupported_history_query", 400)
		}
		if errors.Is(err, sql.ErrNoRows) {
			return inference.Reject("history_not_found", 404)
		}
		return err
	})
	return result, err
}

func scanConversation(row scanner) (string, int64, json.RawMessage, error) {
	var id, kind string
	var created int64
	var state *string
	var raw []byte
	if err := row.Scan(&id, &created, &kind, &raw, &state); err != nil {
		return "", 0, nil, err
	}
	result := map[string]any{"kind": kind, "id": id, "created_at": time.UnixMicro(created).UTC(), "current_request_state": state}
	switch kind {
	case "native":
		var c inference.Conversation
		if err := json.Unmarshal(raw, &c); err != nil {
			return "", 0, nil, err
		}
		result["client_id"], result["session_id"], result["worker_id"] = c.ClientID, c.SessionID, nullableWorker(c.WorkerID)
		result["item_count"], result["pending_call_id"], result["current_request_id"] = c.ItemCount, c.PendingCallID, c.CurrentRequestID
		result["provenance"] = "recorded"
	default:
		var e executionMetadata
		if err := json.Unmarshal(raw, &e); err != nil {
			return "", 0, nil, err
		}
		result["client_id"], result["session_id"], result["worker_id"] = nil, nil, e.WorkerID
		result["created_at"], result["current_request_id"], result["provenance"] = e.CreatedAt, e.ID, "unavailable"
	}
	data, err := json.Marshal(result)
	return id, created, data, err
}

func scanRequest(row scanner) (string, int64, json.RawMessage, error) {
	var id, conversation, state string
	var worker, client, response, session *string
	var created int64
	var raw []byte
	if err := row.Scan(&id, &created, &conversation, &worker, &state, &raw, &client, &response, &session); err != nil {
		return "", 0, nil, err
	}
	var e executionMetadata
	if err := json.Unmarshal(raw, &e); err != nil {
		return "", 0, nil, err
	}
	kind, provenance := "legacy", "unavailable"
	if client != nil {
		kind, provenance = "native", "recorded"
	}
	data, err := json.Marshal(map[string]any{"kind": kind, "id": id, "conversation_id": conversation, "client_id": client,
		"session_id": session, "response_id": response, "worker_id": worker, "state": state, "reason": e.Reason,
		"created_at": e.CreatedAt, "provenance": provenance})
	return id, created, data, err
}

func historyRequest(ctx context.Context, tx *sql.Tx, id string) (json.RawMessage, error) {
	var legacy, native, job, delivery []byte
	var worker *string
	if err := tx.QueryRowContext(ctx, `SELECT e.data,m.data,j.data,j.context,e.worker_id FROM aaa_experiments e
		LEFT JOIN aaa_model_requests m ON m.id=e.id LEFT JOIN aaa_inference_jobs j ON j.id=e.current_job_id WHERE e.id=?1`,
		id).Scan(&legacy, &native, &job, &delivery, &worker); err != nil {
		return nil, err
	}
	var execution executionMetadata
	if err := json.Unmarshal(legacy, &execution); err != nil {
		return nil, err
	}
	result := map[string]any{"kind": "native", "request": json.RawMessage(native), "assignment": json.RawMessage(job), "delivery": json.RawMessage(delivery),
		"execution": map[string]any{"id": execution.ID, "worker_id": worker, "state": execution.State, "reason": execution.Reason,
			"remote_outcome": execution.RemoteOutcome, "created_at": execution.CreatedAt, "deadline_at": execution.DeadlineAt, "current_job_id": execution.CurrentJobID}}
	if native == nil {
		result["kind"], result["request"], result["provenance"] = "legacy", json.RawMessage(legacy), "unavailable"
		rows, err := tx.QueryContext(ctx, "SELECT data FROM aaa_inference_history WHERE experiment_id=?1 ORDER BY sequence", id)
		if err != nil {
			return nil, err
		}
		var history []json.RawMessage
		if err = readHistoryRows(rows, func(raw []byte) error {
			history = append(history, raw)
			return nil
		}); err != nil {
			return nil, err
		}
		result["history"] = history
	}
	return json.Marshal(result)
}

func historyRows(ctx context.Context, tx *sql.Tx, q inference.HistoryQuery) (*sql.Rows, error) {
	if q.Kind == "timeline" {
		return timelineRows(ctx, tx, q)
	}
	var after any
	if !q.After.Time.IsZero() {
		after = q.After.Time.UnixMicro()
	}
	if q.Kind == "conversations" {
		return tx.QueryContext(ctx, "SELECT * FROM ("+conversationRecords+") WHERE (?1 IS NULL OR (created_at,id)<(?1,?2)) ORDER BY created_at DESC,id DESC LIMIT ?3",
			after, q.After.ID, q.Limit+1)
	}
	return tx.QueryContext(ctx, "SELECT * FROM ("+requestRecords+") WHERE (?1 IS NULL OR (created_at,id)<(?1,?2)) AND (?3='' OR conversation_id=?3) ORDER BY created_at DESC,id DESC LIMIT ?4",
		after, q.After.ID, q.ConversationID, q.Limit+1)
}

func timelineRows(ctx context.Context, tx *sql.Tx, q inference.HistoryQuery) (*sql.Rows, error) {
	var kind string
	if err := tx.QueryRowContext(ctx, "SELECT kind FROM ("+conversationRecords+") WHERE id=?1", q.ID).Scan(&kind); err != nil {
		return nil, err
	}
	after := -1
	if q.After.Kind != "" {
		after = q.After.Sequence
	}
	if kind == "native" {
		return tx.QueryContext(ctx, `SELECT 'native',ev.sequence,'',ev.data,i.data FROM aaa_conversation_events ev
			LEFT JOIN aaa_conversation_items i ON i.id=ev.item_id WHERE ev.conversation_id=?1 AND ev.sequence>?2 ORDER BY ev.sequence LIMIT ?3`,
			q.ID, after, q.Limit+1)
	}
	return tx.QueryContext(ctx, `SELECT kind,sequence,request_id,data,delivery FROM (
		SELECT 'legacy_item' AS kind,h.sequence,h.experiment_id AS request_id,h.data,NULL AS delivery
		FROM aaa_inference_history h JOIN aaa_experiments e ON e.id=h.experiment_id WHERE e.conversation_id=?1
		UNION ALL SELECT 'legacy_job_snapshot',
			(SELECT count(*) FROM aaa_inference_history h WHERE h.experiment_id=j.experiment_id)+
			row_number() OVER(ORDER BY j.created_at,j.id)-1,j.experiment_id,j.data,j.context
		FROM aaa_inference_jobs j JOIN aaa_experiments e ON e.id=j.experiment_id WHERE e.conversation_id=?1
	) WHERE sequence>?2 ORDER BY sequence LIMIT ?3`, q.ID, after, q.Limit+1)
}

func projectTimeline(raw, item json.RawMessage, sequence int) (json.RawMessage, error) {
	var event struct {
		inference.TimelineEvent
		Item json.RawMessage `json:"item"`
	}
	if err := json.Unmarshal(raw, &event.TimelineEvent); err != nil {
		return nil, &Failure{Reason: "history_projection_invalid", cause: err}
	}
	if event.Sequence != sequence || event.Kind == "" {
		return nil, &Failure{Reason: "history_projection_invalid", cause: fmt.Errorf("timeline sequence or kind invalid at sequence %d", sequence)}
	}
	event.Item = item
	return json.Marshal(event)
}

func scanTimeline(row scanner) (int, json.RawMessage, error) {
	var kind, request string
	var sequence int
	var raw, extra []byte
	if err := row.Scan(&kind, &sequence, &request, &raw, &extra); err != nil {
		return 0, nil, err
	}
	if kind == "native" {
		data, err := projectTimeline(raw, extra, sequence)
		return sequence, data, err
	}
	var item, details any
	if kind == "legacy_item" {
		item = json.RawMessage(raw)
	} else {
		details = map[string]json.RawMessage{"assignment": raw, "delivery": extra}
	}
	data, err := json.Marshal(map[string]any{"kind": kind, "sequence": sequence, "time": nil, "request_id": request, "provenance": "unavailable", "item": item, "details": details})
	return sequence, data, err
}

func historyPage(ctx context.Context, tx *sql.Tx, q inference.HistoryQuery) (json.RawMessage, error) {
	rows, err := historyRows(ctx, tx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := inference.HistoryPage{Items: []json.RawMessage{}}
	cursor := inference.PageCursor{Kind: q.Kind, ConversationID: q.ConversationID}
	size := 0
	for rows.Next() {
		var id string
		var created int64
		var sequence int
		var data json.RawMessage
		switch q.Kind {
		case "timeline":
			id = q.ID
			sequence, data, err = scanTimeline(rows)
		case "conversations":
			id, created, data, err = scanConversation(rows)
		case "requests":
			id, created, data, err = scanRequest(rows)
		}
		if err != nil {
			return nil, err
		}
		if len(page.Items) == q.Limit || (q.Kind == "timeline" && size+len(data)+1 > inference.MaxTimelineBytes-4096) {
			if len(page.Items) == 0 {
				return nil, inference.Reject("timeline_entry_too_large", 503)
			}
			page.NextCursor, err = inference.EncodeCursor(cursor)
			if err != nil {
				return nil, err
			}
			break
		}
		page.Items = append(page.Items, data)
		size += len(data) + 1
		cursor.ID, cursor.Sequence = id, sequence
		if q.Kind != "timeline" {
			cursor.Time = time.UnixMicro(created).UTC()
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return json.Marshal(page)
}
