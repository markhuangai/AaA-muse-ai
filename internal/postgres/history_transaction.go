package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func ownedHistory(ctx context.Context, tx pgx.Tx, ref *inference.Ref) error {
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
		err := tx.QueryRow(ctx, "SELECT data FROM aaa_model_requests WHERE "+column+"=$1 AND client_id=$2", id, ref.ClientID).Scan(&data)
		if errors.Is(err, pgx.ErrNoRows) {
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
		if err := tx.QueryRow(ctx, "SELECT data FROM aaa_conversations WHERE id=$1 AND client_id=$2", ref.ConversationID, ref.ClientID).Scan(&data); err != nil {
			return err
		}
		if err := decodeInference(data, &c); err != nil {
			return err
		}
		if ref.SessionID != "" && ref.SessionID != c.SessionID {
			return inference.Reject("session_reference_conflict", 409, "expected_session_id", c.SessionID, "observed_session_id", ref.SessionID)
		}
	} else if ref.SessionID != "" {
		err := tx.QueryRow(ctx, "SELECT data FROM aaa_conversations WHERE client_id=$1 AND session_id=$2", ref.ClientID, ref.SessionID).Scan(&data)
		if err == nil {
			if err = decodeInference(data, &c); err != nil {
				return err
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	if c.ID == "" {
		return nil
	}
	if c.WorkerID != "" && ref.WorkerID != "" && ref.WorkerID != c.WorkerID {
		return inference.Reject("session_worker_conflict", 409, "expected_worker_id", c.WorkerID, "observed_worker_id", ref.WorkerID)
	}
	ref.WorkerID, ref.ConversationID = c.WorkerID, c.ID
	if ref.ReplayHash != "" {
		err := tx.QueryRow(ctx, "SELECT id FROM aaa_model_requests WHERE conversation_id=$1 AND replay_hash=$2", c.ID, ref.ReplayHash).Scan(&ref.ExperimentID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	return nil
}

func loadHistory(ctx context.Context, tx pgx.Tx, ref inference.Ref, s *inference.State) error {
	s.HistoryConversationID = ref.ConversationID
	s.Conversations, s.Requests = map[string]*inference.Conversation{}, map[string]*inference.Request{}
	ids := []string{}
	for id := range s.Experiments {
		ids = append(ids, id)
	}
	if ref.ReferenceRequestID != "" {
		ids = append(ids, ref.ReferenceRequestID)
	}
	rows, err := tx.Query(ctx, `SELECT data FROM aaa_model_requests WHERE id=ANY($1::text[])
		OR (conversation_id=$2 AND (replay_hash=$3 OR id=(SELECT data->>'current_request_id' FROM aaa_conversations WHERE id=$2)))`, ids, ref.ConversationID, ref.ReplayHash)
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
	// The worker row is the common lock for admission, results, cancellation, and sweeps.
	rows, err = tx.Query(ctx, "SELECT data FROM aaa_conversations WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE", conversations)
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
			rows, err = tx.Query(ctx, "SELECT data FROM aaa_conversation_items WHERE conversation_id=$1 ORDER BY sequence", c.ID)
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
		return tx.QueryRow(ctx, "SELECT count(*) FROM aaa_conversations WHERE worker_id=$1 AND pending_call_id<>''", s.WorkerID).Scan(&s.PendingTools)
	}
	return nil
}

func readHistoryRows(rows pgx.Rows, read func([]byte) error) error {
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

func saveHistory(ctx context.Context, tx pgx.Tx, s *inference.State, before historyBefore) error {
	for id, c := range s.Conversations {
		data, err := conversationHeader(c)
		if err != nil {
			return err
		}
		if !bytes.Equal(data, before.conversations[id]) {
			if _, err = tx.Exec(ctx, `INSERT INTO aaa_conversations(id,client_id,session_id,worker_id,created_at,pending_call_id,data) VALUES($1,$2,$3,$4,$5,$6,$7)
				ON CONFLICT(id) DO UPDATE SET worker_id=EXCLUDED.worker_id,pending_call_id=EXCLUDED.pending_call_id,data=EXCLUDED.data`, id, c.ClientID, c.SessionID, nullableWorker(c.WorkerID), c.CreatedAt, c.PendingCallID, data); err != nil {
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
			if _, err = tx.Exec(ctx, `INSERT INTO aaa_model_requests(id,conversation_id,client_id,response_id,created_at,replay_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7)
				ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`, id, r.ConversationID, r.ClientID, r.ResponseID, r.CreatedAt, r.ReplayHash, data); err != nil {
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
			if _, err = tx.Exec(ctx, "INSERT INTO aaa_conversation_items(conversation_id,sequence,id,request_id,data) VALUES($1,$2,$3,$4,$5)", id, item.Sequence, item.ID, item.RequestID, data); err != nil {
				return err
			}
		}
		for _, event := range c.Events {
			data, err := json.Marshal(event)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO aaa_conversation_events(conversation_id,sequence,data) VALUES($1,$2,$3)", id, event.Sequence, data); err != nil {
				return err
			}
		}
	}
	return nil
}
