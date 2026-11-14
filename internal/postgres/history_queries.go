package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

const conversationRecords = `SELECT c.id,c.created_at,json_build_object(
 'kind','native','id',c.id,'client_id',c.client_id,'session_id',c.session_id,'worker_id',c.worker_id,
 'created_at',c.created_at,'item_count',c.data->'item_count','pending_call_id',c.pending_call_id,
 'current_request_id',c.data->'current_request_id','current_request_state',
 (SELECT m.data->'state' FROM aaa_model_requests m WHERE m.id=c.data->>'current_request_id'),
 'provenance','recorded') AS data FROM aaa_conversations c
 UNION ALL SELECT e.data->>'conversation_id',(e.data->>'created_at')::timestamptz,json_build_object(
 'kind','legacy','id',e.data->>'conversation_id','client_id',NULL,'session_id',NULL,'worker_id',e.worker_id,
 'created_at',e.data->'created_at','current_request_id',e.id,'current_request_state',e.state,
 'provenance','unavailable') FROM aaa_experiments e WHERE NOT EXISTS(SELECT 1 FROM aaa_model_requests m WHERE m.id=e.id)`

const requestRecords = `SELECT e.id,(e.data->>'created_at')::timestamptz AS created_at,e.data->>'conversation_id' AS conversation_id,
 json_build_object('kind',CASE WHEN m.id IS NULL THEN 'legacy' ELSE 'native' END,'id',e.id,
 'conversation_id',e.data->>'conversation_id','client_id',m.client_id,'session_id',m.data->'session_id',
 'response_id',m.response_id,'worker_id',e.worker_id,'state',e.state,'reason',e.data->'reason',
 'created_at',e.data->'created_at','provenance',CASE WHEN m.id IS NULL THEN 'unavailable' ELSE 'recorded' END) AS data
 FROM aaa_experiments e LEFT JOIN aaa_model_requests m ON m.id=e.id`

func (r *Repository) QueryHistory(ctx context.Context, q inference.HistoryQuery) (json.RawMessage, error) {
	var result json.RawMessage
	err := r.workerTransaction(ctx, func(tx pgx.Tx) error {
		var err error
		switch q.Kind {
		case "conversation":
			result, err = historyOne(ctx, tx, "SELECT data FROM ("+conversationRecords+") records WHERE id=$1", q.ID)
		case "request":
			result, err = historyRequest(ctx, tx, q.ID)
		case "conversations", "requests", "timeline":
			result, err = historyPage(ctx, tx, q)
		default:
			err = inference.Reject("unsupported_history_query", 400)
		}
		return err
	})
	return result, err
}

func historyOne(ctx context.Context, tx pgx.Tx, query string, id string) (json.RawMessage, error) {
	var data json.RawMessage
	err := tx.QueryRow(ctx, query, id).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, inference.Reject("history_not_found", 404)
	}
	return data, err
}

func historyRequest(ctx context.Context, tx pgx.Tx, id string) (json.RawMessage, error) {
	return historyOne(ctx, tx, `SELECT CASE WHEN m.id IS NOT NULL THEN
	 json_build_object('kind','native','request',m.data,'assignment',j.data,'delivery',j.context,'execution',execution.data)
	 ELSE json_build_object('kind','legacy','request',e.data,'provenance','unavailable',
	 'history',(SELECT json_agg(h.data ORDER BY h.sequence) FROM aaa_inference_history h WHERE h.experiment_id=e.id),
	 'assignment',j.data,'delivery',j.context,'execution',execution.data) END FROM aaa_experiments e
	 CROSS JOIN LATERAL (SELECT json_build_object(
	 'id',e.id,'worker_id',e.worker_id,'state',e.state,'reason',e.data->'reason',
	 'remote_outcome',e.data->'remote_outcome','created_at',e.data->'created_at',
	 'deadline_at',e.data->'deadline_at','current_job_id',e.data->'current_job_id') AS data) execution
	 LEFT JOIN aaa_model_requests m ON m.id=e.id LEFT JOIN aaa_inference_jobs j ON j.id=e.data->>'current_job_id' WHERE e.id=$1`, id)
}

func historyRows(ctx context.Context, tx pgx.Tx, q inference.HistoryQuery) (pgx.Rows, error) {
	if q.Kind == "timeline" {
		return timelineRows(ctx, tx, q)
	}
	var after any
	if !q.After.Time.IsZero() {
		after = q.After.Time
	}
	if q.Kind == "conversations" {
		return tx.Query(ctx, "SELECT id,created_at,0,data FROM ("+conversationRecords+") records WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1,$2)) ORDER BY created_at DESC,id DESC LIMIT $3", after, q.After.ID, q.Limit+1)
	}
	return tx.Query(ctx, "SELECT id,created_at,0,data FROM ("+requestRecords+") records WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1,$2)) AND ($3='' OR conversation_id=$3) ORDER BY created_at DESC,id DESC LIMIT $4", after, q.After.ID, q.ConversationID, q.Limit+1)
}

func timelineRows(ctx context.Context, tx pgx.Tx, q inference.HistoryQuery) (pgx.Rows, error) {
	data, err := historyOne(ctx, tx, "SELECT data FROM ("+conversationRecords+") records WHERE id=$1", q.ID)
	if err != nil {
		return nil, err
	}
	var metadata struct {
		Kind string `json:"kind"`
	}
	if err = json.Unmarshal(data, &metadata); err != nil {
		return nil, err
	}
	after := -1
	if q.After.Kind != "" {
		after = q.After.Sequence
	}
	if metadata.Kind == "native" {
		return tx.Query(ctx, `SELECT ev.conversation_id,(ev.data->>'time')::timestamptz,ev.sequence,
		 json_build_object('sequence',ev.sequence,'time',ev.data->'time','kind',ev.data->'kind','level',ev.data->'level',
		 'request_id',ev.data->'request_id','details',ev.data->'details','item',i.data)
		 FROM aaa_conversation_events ev LEFT JOIN aaa_conversation_items i ON i.id=ev.data->'details'->>'item_id'
		 WHERE ev.conversation_id=$1 AND ev.sequence>$2 ORDER BY ev.sequence LIMIT $3`, q.ID, after, q.Limit+1)
	}
	return tx.Query(ctx, `SELECT $1::text,NULL::timestamptz,sequence,
	 json_build_object('sequence',sequence,'kind',data->'kind','time',NULL,'request_id',data->'request_id',
	 'provenance','unavailable','item',data->'item','details',data->'details') FROM (
	 SELECT h.sequence::bigint,json_build_object('kind','legacy_item','sequence',h.sequence,'time',NULL,
	 'request_id',h.experiment_id,'provenance','unavailable','item',h.data) AS data FROM aaa_inference_history h
	 JOIN aaa_experiments e ON e.id=h.experiment_id WHERE e.data->>'conversation_id'=$1
	 UNION ALL SELECT (SELECT count(*) FROM aaa_inference_history h WHERE h.experiment_id=j.experiment_id)+
	 row_number() OVER(ORDER BY (j.data->>'created_at')::timestamptz,j.id)-1,
	 json_build_object('kind','legacy_job_snapshot','time',NULL,'request_id',j.experiment_id,'provenance','unavailable',
	 'details',json_build_object('assignment',j.data,'delivery',j.context)) FROM aaa_inference_jobs j
	 JOIN aaa_experiments e ON e.id=j.experiment_id WHERE e.data->>'conversation_id'=$1
	 ) records WHERE sequence>$2 ORDER BY sequence LIMIT $3`, q.ID, after, q.Limit+1)
}

func historyPage(ctx context.Context, tx pgx.Tx, q inference.HistoryQuery) (json.RawMessage, error) {
	rows, err := historyRows(ctx, tx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := inference.HistoryPage{Items: []json.RawMessage{}}
	cursor := inference.PageCursor{Kind: q.Kind, ConversationID: q.ConversationID}
	bytes := 0
	for rows.Next() {
		var id string
		var created *time.Time
		var sequence int
		var data json.RawMessage
		if err = rows.Scan(&id, &created, &sequence, &data); err != nil {
			return nil, err
		}
		if len(page.Items) == q.Limit || (q.Kind == "timeline" && bytes+len(data)+1 > inference.MaxTimelineBytes-4096) {
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
		bytes += len(data) + 1
		cursor.ID, cursor.Sequence = id, sequence
		if created != nil {
			cursor.Time = *created
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return json.Marshal(page)
}
