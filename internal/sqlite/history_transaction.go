package sqlite

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	"database/sql"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func ownedHistory(ctx context.Context, tx *sql.Tx, ref *inference.Ref) error {
	if ref.ClientID == "" {
		return nil
	}
	var c inference.Conversation
	var data []byte
	if ref.ExperimentID != "" || ref.ResponseID != "" {
		column, id := "id", ref.ExperimentID
		if ref.ResponseID != "" {
			column, id = "response_id", ref.ResponseID
		}
		err := tx.QueryRowContext(ctx, "SELECT data FROM aaa_model_requests WHERE "+column+"=?1 AND client_id=?2", id, ref.ClientID).Scan(&data)
		if errors.Is(err, sql.ErrNoRows) {
			return inference.Reject("history_owner_denied", 404, "requested_id", id)
		}
		if err != nil {
			return err
		}
		var request inference.Request
		if err = decodeInference(data, &request); err != nil {
			return err
		}
		if ref.ResponseID != "" && request.Output == nil {
			return inference.Reject("response_not_completed", 409)
		}
		ref.ConversationID = request.ConversationID
		if ref.ResponseID != "" {
			ref.ReferenceRequestID = request.ID
		}
	}
	if ref.ConversationID != "" {
		if err := tx.QueryRowContext(ctx, "SELECT data FROM aaa_conversations WHERE id=?1 AND client_id=?2", ref.ConversationID, ref.ClientID).Scan(&data); err != nil {
			return err
		}
		if err := decodeInference(data, &c); err != nil {
			return err
		}
		if ref.SessionID != "" && ref.SessionID != c.SessionID {
			return inference.Reject("session_reference_conflict", 409, "expected_session_id", c.SessionID, "observed_session_id", ref.SessionID)
		}
	} else if ref.SessionID != "" {
		err := tx.QueryRowContext(ctx, "SELECT data FROM aaa_conversations WHERE client_id=?1 AND session_id=?2", ref.ClientID, ref.SessionID).Scan(&data)
		if err == nil {
			if err = decodeInference(data, &c); err != nil {
				return err
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	if c.ID == "" {
		return nil
	}
	targetChanged := c.WorkerID != "" && ref.WorkerID != "" && ref.WorkerID != c.WorkerID
	var replayID string
	var priorInput []byte
	if ref.ReplayHash != "" {
		err := tx.QueryRowContext(ctx, `SELECT id,CASE WHEN ?3 THEN data END FROM aaa_model_requests
			WHERE conversation_id=?1 AND replay_hash=?2`, c.ID, ref.ReplayHash, targetChanged).Scan(&replayID, &priorInput)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if replayID != "" {
			ref.ExperimentID = replayID
		}
	}
	if targetChanged {
		var admitted inference.Request
		if replayID != "" {
			if err := decodeInference(priorInput, &admitted); err != nil {
				return err
			}
		}
		if admitted.Input.WorkerID != ref.WorkerID {
			return inference.Reject("session_worker_conflict", 409, "expected_worker_id", c.WorkerID, "observed_worker_id", ref.WorkerID)
		}
	}
	ref.WorkerID, ref.ConversationID = c.WorkerID, c.ID
	return nil
}

func loadHistory(ctx context.Context, tx *sql.Tx, ref inference.Ref, s *inference.State) error {
	s.HistoryConversationID = ref.ConversationID
	s.Conversations, s.Requests = map[string]*inference.Conversation{}, map[string]*inference.Request{}
	ids := []string{}
	for id := range s.Experiments {
		ids = append(ids, id)
	}
	if ref.ReferenceRequestID != "" {
		ids = append(ids, ref.ReferenceRequestID)
	}
	rows, err := tx.QueryContext(ctx, `SELECT data FROM aaa_model_requests WHERE id IN (SELECT value FROM json_each(?1))
		OR (conversation_id=?2 AND (replay_hash=?3 OR id=(SELECT current_request_id FROM aaa_conversations WHERE id=?2)))`, idList(ids), ref.ConversationID, ref.ReplayHash)
	if err != nil {
		return err
	}
	if err = readHistoryRows(rows, func(data []byte) error {
		r := &inference.Request{}
		if err := decodeInference(data, r); err != nil {
			return err
		}
		s.Requests[r.ID] = r
		return nil
	}); err != nil {
		return err
	}
	conversations := []string{ref.ConversationID}
	for _, r := range s.Requests {
		conversations = append(conversations, r.ConversationID)
	}
	rows, err = tx.QueryContext(ctx, "SELECT data FROM aaa_conversations WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id", idList(conversations))
	if err != nil {
		return err
	}
	if err = readHistoryRows(rows, func(data []byte) error {
		c := &inference.Conversation{}
		if err := decodeInference(data, c); err != nil {
			return err
		}
		s.Conversations[c.ID] = c
		return nil
	}); err != nil {
		return err
	}
	if ref.Full {
		for _, c := range s.Conversations {
			rows, err = tx.QueryContext(ctx, "SELECT data FROM aaa_conversation_items WHERE conversation_id=?1 ORDER BY sequence", c.ID)
			if err != nil {
				return err
			}
			if err = readHistoryRows(rows, func(data []byte) error {
				var item inference.HistoryItem
				if err := decodeInference(data, &item); err != nil {
					return err
				}
				c.Items = append(c.Items, item)
				return nil
			}); err != nil {
				return err
			}
		}
		for id, request := range s.Requests {
			if e := s.Experiments[id]; e != nil {
				e.Messages = inference.RequestMessages(s.Conversations[request.ConversationID], request)
			}
		}
	}
	if ref.CountPendingTools {
		return tx.QueryRowContext(ctx, "SELECT count(*) FROM aaa_conversations WHERE worker_id=?1 AND pending_call_id<>''", s.WorkerID).Scan(&s.PendingTools)
	}
	return nil
}

func readHistoryRows(rows *sql.Rows, read func([]byte) error) error {
	defer rows.Close()
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return err
		}
		if err := read(data); err != nil {
			return err
		}
	}
	return rows.Err()
}

type historyBefore struct {
	conversations, requests map[string][]byte
	items                   map[string]int
}

func conversationHeader(c *inference.Conversation) ([]byte, error) {
	header := *c
	header.Items, header.Events = nil, nil
	return json.Marshal(header)
}

func historySnapshot(s *inference.State) (historyBefore, error) {
	b := historyBefore{conversations: map[string][]byte{}, requests: map[string][]byte{}, items: map[string]int{}}
	for id, c := range s.Conversations {
		data, err := conversationHeader(c)
		if err != nil {
			return b, err
		}
		b.conversations[id], b.items[id] = data, c.ItemCount
	}
	for id, r := range s.Requests {
		data, err := json.Marshal(r)
		if err != nil {
			return b, err
		}
		b.requests[id] = data
	}
	return b, nil
}

func saveHistory(ctx context.Context, tx *sql.Tx, s *inference.State, before historyBefore) error {
	for id, c := range s.Conversations {
		data, err := conversationHeader(c)
		if err != nil {
			return err
		}
		if !bytes.Equal(data, before.conversations[id]) {
			if _, err = tx.ExecContext(ctx, `INSERT INTO aaa_conversations(id,client_id,session_id,worker_id,created_at,pending_call_id,current_request_id,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
				ON CONFLICT(id) DO UPDATE SET worker_id=excluded.worker_id,pending_call_id=excluded.pending_call_id,current_request_id=excluded.current_request_id,data=excluded.data`,
				id, c.ClientID, c.SessionID, nullableWorker(c.WorkerID), c.CreatedAt.UnixMicro(), c.PendingCallID, c.CurrentRequestID, data); err != nil {
				return err
			}
		}
	}
	for id, r := range s.Requests {
		data, err := json.Marshal(r)
		if err != nil {
			return err
		}
		if !bytes.Equal(data, before.requests[id]) {
			incomplete := (r.Output != nil && r.OutputCompletedAt == nil) || (r.ContextDeliveryStarted != nil && r.ContextDeliveryWritten == nil)
			if _, err = tx.ExecContext(ctx, `INSERT INTO aaa_model_requests(id,conversation_id,client_id,response_id,created_at,replay_hash,incomplete_delivery,data)
				VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
				ON CONFLICT(id) DO UPDATE SET incomplete_delivery=excluded.incomplete_delivery,data=excluded.data`,
				id, r.ConversationID, r.ClientID, r.ResponseID, r.CreatedAt.UnixMicro(), r.ReplayHash, incomplete, data); err != nil {
				return err
			}
		}
	}
	for id, c := range s.Conversations {
		for _, item := range c.Items {
			if item.Sequence < before.items[id] {
				continue
			}
			data, err := json.Marshal(item)
			if err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, "INSERT INTO aaa_conversation_items(conversation_id,sequence,id,request_id,data) VALUES(?1,?2,?3,?4,?5)", id, item.Sequence, item.ID, item.RequestID, data); err != nil {
				return err
			}
		}
		for _, event := range c.Events {
			data, err := json.Marshal(event)
			if err != nil {
				return err
			}
			var detail struct {
				ItemID string `json:"item_id"`
			}
			if err = json.Unmarshal(event.Details, &detail); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, "INSERT INTO aaa_conversation_events(conversation_id,sequence,item_id,data) VALUES(?1,?2,?3,?4)", id, event.Sequence, detail.ItemID, data); err != nil {
				return err
			}
		}
	}
	return nil
}
