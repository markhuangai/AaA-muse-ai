package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func canonicalSQLFixture(t *testing.T) (*Repository, *inferenceTx, inference.Ref) {
	t.Helper()
	repo, tx, ref := inferenceSQLFixture(t)
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	c := inference.Conversation{ID: "conversation", ClientID: "alice", SessionID: "session", WorkerID: "worker", CreatedAt: now, CurrentRequestID: "exp", ItemCount: 1}
	r := inference.Request{ID: "exp", ConversationID: c.ID, ClientID: c.ClientID, SessionID: c.SessionID, WorkerID: c.WorkerID, ResponseID: "response", CreatedAt: now, State: "queued", ReplayHash: "hash", InputCount: 1, CanonicalEnd: 1, Input: inference.RequestInput{Version: 1, SubmissionID: "source", WorkerID: "worker", Messages: []inference.Item{{Type: "message", Role: "user", Text: "fixture"}}, Tools: []inference.Tool{}}}
	h := inference.HistoryItem{ID: "item-original", Sequence: 0, RequestID: r.ID, Source: "client_provided", Time: now, Item: r.Input.Messages[0]}
	tx.rowsets = append(tx.rowsets, &workerRows{records: []workerRow{{values: []any{encoded(t, r)}}}}, &workerRows{records: []workerRow{{values: []any{encoded(t, c)}}}}, &workerRows{records: []workerRow{{values: []any{encoded(t, h)}}}})
	return repo, tx, ref
}

func canonicalChange(s *inference.State) error {
	c := s.Conversations["conversation"]
	r := s.Requests["exp"]
	c.Items = append(c.Items, inference.HistoryItem{ID: "item-observed", Sequence: 1, RequestID: r.ID, Source: "server_observed", Time: s.Now, Item: inference.Item{Type: "message", Role: "assistant", Text: "observed\n"}})
	c.ItemCount = 2
	c.Events = append(c.Events, inference.TimelineEvent{Sequence: 0, Time: &s.Now, Kind: "decision.accepted", Level: "INFO", RequestID: r.ID, Details: json.RawMessage(`{"generation":1}`)})
	c.EventCount = 1
	r.State = "completed"
	r.CanonicalEnd = 2
	r.Output = &inference.Item{Type: "final", Text: "observed\n"}
	s.Experiments["exp"].State = "completed"
	s.Jobs["job"].State = "accepted"
	return nil
}

func TestCanonicalRepositoryAtomicAppendAndImmutableSnapshots(t *testing.T) {
	repo, tx, ref := canonicalSQLFixture(t)
	if err := repo.WithinInference(context.Background(), ref, canonicalChange); err != nil {
		t.Fatal(err)
	}
	if !tx.committed || tx.rolledBack {
		t.Fatal("canonical transaction not committed")
	}
	count := 0
	for i, query := range tx.queries {
		if strings.Contains(query, "INSERT INTO aaa_inference_history") {
			t.Fatal("native item duplicated into legacy history")
		}
		if strings.Contains(query, "INSERT INTO aaa_conversation_items") {
			count++
			if tx.arguments[i][1] != 1 {
				t.Fatal("existing canonical prefix rewritten")
			}
			var h inference.HistoryItem
			if json.Unmarshal(tx.arguments[i][4].([]byte), &h) != nil || h.Source != "server_observed" || h.Item.Text != "observed\n" {
				t.Fatal("observed item provenance/text lost")
			}
		}
	}
	if count != 1 {
		t.Fatal("new item not stored exactly once")
	}
	joined := strings.Join(tx.queries, "\n")
	for _, table := range []string{"aaa_conversations", "aaa_model_requests", "aaa_conversation_events"} {
		if !strings.Contains(joined, "INSERT INTO "+table) {
			t.Fatal("canonical record not saved", table)
		}
	}
	for step := 1; step <= tx.step; step++ {
		repo, failing, ref := canonicalSQLFixture(t)
		failing.failStep = step
		if err := repo.WithinInference(context.Background(), ref, canonicalChange); err == nil || !failing.rolledBack {
			t.Fatal("I/O fault did not roll back atomic history", step, err)
		}
	}
	for _, kind := range []string{"read", "request-json", "conversation-json", "item-json", "rows", "callback", "commit"} {
		t.Run(kind, func(t *testing.T) {
			repo, tx, ref := canonicalSQLFixture(t)
			fn := canonicalChange
			switch kind {
			case "read":
				fn = func(*inference.State) error { return nil }
			case "request-json":
				tx.rowsets[3].records[0].values[0] = []byte("{")
			case "conversation-json":
				tx.rowsets[4].records[0].values[0] = []byte("{")
			case "item-json":
				tx.rowsets[5].records[0].values[0] = []byte("{")
			case "rows":
				tx.rowsets[4].endErr = errors.New("row stream failed")
			case "callback":
				fn = func(*inference.State) error { return inference.Reject("conflict", 409) }
			case "commit":
				tx.commitErr = errors.New("commit failed")
			}
			err := repo.WithinInference(context.Background(), ref, fn)
			if kind == "read" {
				if err != nil || len(tx.queries) != 0 {
					t.Fatal("read rewrote history", err)
				}
			} else if err == nil {
				t.Fatal("fault suppressed")
			}
		})
	}
}

func TestCanonicalOwnedLookupAndReferenceConsistency(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	c := inference.Conversation{ID: "conversation", ClientID: "alice", SessionID: "session", WorkerID: "worker", CreatedAt: now}
	r := inference.Request{ID: "request", ClientID: "alice", ConversationID: c.ID, Output: &inference.Item{Type: "final", Text: "observed"}}
	for _, kind := range []string{"none", "unknown", "query-error", "request-json", "unfinished", "reference", "header-conflict", "worker-conflict", "session", "missing-session", "session-json", "session-error", "replay", "replay-error", "conversation-error", "unassigned"} {
		t.Run(kind, func(t *testing.T) {
			ref := inference.Ref{ClientID: "alice", ResponseID: "response", SessionID: "session", WorkerID: "worker"}
			tx := &inferenceTx{workerTransaction: workerTransaction{rows: []workerRow{{values: []any{encoded(t, r)}}, {values: []any{encoded(t, c)}}}}}
			wantError := false
			switch kind {
			case "none":
				ref.ClientID = ""
			case "unknown":
				tx.rows[0].err = pgx.ErrNoRows
				wantError = true
			case "query-error":
				tx.rows[0].err = errors.New("database lost")
				wantError = true
			case "request-json":
				tx.rows[0].values[0] = []byte("{")
				wantError = true
			case "unfinished":
				copy := r
				copy.Output = nil
				tx.rows[0].values[0] = encoded(t, copy)
				wantError = true
			case "reference":
				ref.SessionID = ""
			case "header-conflict":
				ref.SessionID = "foreign"
				wantError = true
			case "unassigned":
				unassigned := c
				unassigned.WorkerID = ""
				tx.rows[1].values = []any{encoded(t, unassigned)}
			case "worker-conflict":
				ref.WorkerID = "other"
				wantError = true
			case "session", "missing-session", "session-json", "session-error":
				ref.ResponseID = ""
				tx.rows = tx.rows[1:]
				if kind == "missing-session" {
					tx.rows[0].err = pgx.ErrNoRows
				}
				if kind == "session-json" {
					tx.rows[0].values[0] = []byte("{")
					wantError = true
				}
				if kind == "session-error" {
					tx.rows[0].err = errors.New("lost")
					wantError = true
				}
			case "replay", "replay-error":
				ref.ReplayHash = "hash"
				tx.rows = append(tx.rows, workerRow{values: []any{"request"}})
				if kind == "replay-error" {
					tx.rows[2].err = errors.New("lost")
					wantError = true
				}
			case "conversation-error":
				tx.rows[1].err = errors.New("lost")
				wantError = true
			}
			err := ownedHistory(ctx, tx, &ref)
			if (err != nil) != wantError {
				t.Fatal("wrong lookup outcome", err)
			}
			if kind == "unknown" {
				var rejection *inference.Rejection
				if !errors.As(err, &rejection) || rejection.Code != 404 || len(rejection.Fields) != 1 {
					t.Fatal("foreign lookup leaked metadata")
				}
			}
			if !wantError && kind != "none" && kind != "missing-session" && ref.ConversationID != c.ID {
				t.Fatal("owned conversation not resolved")
			}
			if kind == "replay" && ref.ExperimentID != "request" {
				t.Fatal("admitted replay not selected")
			}
			if kind != "none" && !strings.Contains(tx.queriesSeen[0], "client_id=$2") && !strings.Contains(tx.queriesSeen[0], "client_id=$1") {
				t.Fatal("lookup lacks authenticated-owner predicate")
			}
		})
	}
}

func TestCanonicalCaptureSerializationAndRowFailures(t *testing.T) {
	for _, kind := range []string{"conversation-header", "request", "item", "event"} {
		t.Run(kind, func(t *testing.T) {
			c := &inference.Conversation{ID: "c", CreatedAt: time.Now().UTC()}
			r := &inference.Request{ID: "r", CreatedAt: c.CreatedAt}
			s := &inference.State{Conversations: map[string]*inference.Conversation{"c": c}, Requests: map[string]*inference.Request{"r": r}}
			before, err := historySnapshot(s)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "conversation-header":
				c.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
			case "request":
				r.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
			case "item":
				c.Items = []inference.HistoryItem{{ID: "bad", Item: inference.Item{Type: "tool_call", Arguments: map[string]any{"bad": make(chan int)}}}}
			case "event":
				c.Events = []inference.TimelineEvent{{Details: json.RawMessage("{")}}
			}
			if err = saveHistory(context.Background(), &inferenceTx{}, s, before); err == nil {
				t.Fatal("serialization error suppressed")
			}
			if kind == "conversation-header" || kind == "request" {
				if _, err = historySnapshot(s); err == nil {
					t.Fatal("snapshot serialization ignored")
				}
			}
		})
	}
	for _, kind := range []string{"scan", "callback", "rows"} {
		rows := &workerRows{records: []workerRow{{values: []any{[]byte(`{}`)}}}}
		callback := func([]byte) error { return nil }
		switch kind {
		case "scan":
			rows.records[0].err = errors.New("scan")
		case "callback":
			callback = func([]byte) error { return errors.New("callback") }
		case "rows":
			rows.endErr = errors.New("rows")
		}
		if err := readHistoryRows(rows, callback); err == nil || !rows.closed {
			t.Fatal("row failure or cleanup lost")
		}
	}
}

func TestHistoryQueryPaginationAndLegacyProjection(t *testing.T) {
	now := time.Now().UTC()
	for _, kind := range []string{"conversations", "requests", "timeline-native", "timeline-legacy", "conversation", "request", "unsupported"} {
		t.Run(kind, func(t *testing.T) {
			tx := &inferenceTx{workerTransaction: workerTransaction{rows: []workerRow{{values: []any{json.RawMessage(`{"kind":"native"}`)}}}}}
			q := inference.HistoryQuery{Kind: kind, ID: "conversation", Limit: 1}
			if strings.HasPrefix(kind, "timeline") {
				q.Kind = "timeline"
				if kind == "timeline-legacy" {
					tx.rows[0].values[0] = json.RawMessage(`{"kind":"legacy"}`)
				}
			}
			tx.rowsets = []*workerRows{{records: []workerRow{{values: []any{"second", &now, 0, json.RawMessage(`{"id":"second"}`)}}, {values: []any{"first", &now, 1, json.RawMessage(`{"id":"first"}`)}}}}}
			repo := New(inferencePool{tx: tx})
			data, err := repo.QueryHistory(context.Background(), q)
			if kind == "unsupported" {
				if err == nil {
					t.Fatal("unknown query accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if kind == "conversation" || kind == "request" {
				if !strings.Contains(string(data), "native") {
					t.Fatal("single result lost")
				}
				return
			}
			var page inference.HistoryPage
			if json.Unmarshal(data, &page) != nil || len(page.Items) != 1 || page.NextCursor == "" {
				t.Fatal("missing page boundary")
			}
			if kind == "requests" {
				if _, err = inference.DecodeCursor(page.NextCursor, q); err != nil {
					t.Fatal(err)
				}
			}
			query := strings.Join(tx.queriesSeen, "\n")
			if !strings.Contains(query, "LIMIT") {
				t.Fatal("unbounded history query")
			}
			if kind == "timeline-legacy" && !strings.Contains(query, "legacy_job_snapshot") {
				t.Fatal("legacy evidence not marked")
			}
		})
	}
	for _, kind := range []string{"query", "scan", "rows", "missing", "malformed", "oversized", "byte-page"} {
		t.Run(kind, func(t *testing.T) {
			tx := &inferenceTx{workerTransaction: workerTransaction{rows: []workerRow{{values: []any{json.RawMessage(`{"kind":"native"}`)}}}}}
			large := json.RawMessage(`{"text":"` + strings.Repeat("x", 1048000) + `"}`)
			tx.rowsets = []*workerRows{{records: []workerRow{{values: []any{"conversation", &now, 0, large}}, {values: []any{"conversation", &now, 1, large}}}}}
			q := inference.HistoryQuery{Kind: "timeline", ID: "conversation", Limit: 100}
			switch kind {
			case "query":
				tx.failStep = 2
			case "scan":
				tx.rowsets[0].records[0].err = errors.New("scan")
			case "rows":
				tx.rowsets[0].endErr = errors.New("rows")
			case "missing":
				tx.rows[0].err = pgx.ErrNoRows
			case "malformed":
				tx.rows[0].values[0] = json.RawMessage("{")
			case "oversized":
				tx.rowsets[0].records[0].values[3] = json.RawMessage(`{"text":"` + strings.Repeat("x", inference.MaxTimelineBytes) + `"}`)
			}
			data, err := New(inferencePool{tx: tx}).QueryHistory(context.Background(), q)
			if kind == "byte-page" {
				var page inference.HistoryPage
				if err != nil || json.Unmarshal(data, &page) != nil || len(page.Items) != 1 || page.NextCursor == "" || len(data) > inference.MaxTimelineBytes {
					t.Fatal("timeline byte limit failed", err)
				}
			} else if err == nil {
				t.Fatal("query failure suppressed", kind)
			}
		})
	}
}
