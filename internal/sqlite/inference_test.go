package sqlite

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func seedRequest(t *testing.T, repo *Repository, suffix, worker string, native bool) inference.Ref {
	t.Helper()
	ref := inference.Ref{WorkerID: worker, Full: true, Routing: worker == ""}
	err := repo.WithinInference(t.Context(), ref, func(s *inference.State) error {
		e := &inference.Experiment{ID: "req" + suffix, ConversationID: "conv" + suffix, WorkerID: worker, State: "queued",
			CreatedAt: s.Now, DeadlineAt: s.Now.Add(time.Minute), Messages: []inference.Item{{Type: "message", Role: "user", Text: "message\x00 literal\\u0000"}}}
		s.Experiments[e.ID] = e
		if worker != "" {
			e.CurrentJobID = "job" + suffix
			s.Connection = inference.Connection{ID: "conn" + worker, Generation: 2, Connected: true, OpenedAt: s.Now}
			s.Jobs[e.CurrentJobID] = &inference.Job{ID: e.CurrentJobID, WorkerID: worker, ExperimentID: e.ID, ConversationID: e.ConversationID,
				State: "queued", CreatedAt: s.Now, DeadlineAt: e.DeadlineAt, Context: inference.Delivery{ReceiptID: "receipt" + suffix, Messages: e.Messages}}
		}
		if native {
			item := inference.HistoryItem{ID: "item" + suffix, RequestID: e.ID, Time: s.Now, Item: e.Messages[0]}
			s.Conversations[e.ConversationID] = &inference.Conversation{ID: e.ConversationID, WorkerID: worker, ClientID: "alice", SessionID: "session" + suffix,
				CurrentRequestID: e.ID, CreatedAt: s.Now, ItemCount: 1, Items: []inference.HistoryItem{item},
				Events: []inference.TimelineEvent{{Kind: "history.item", Time: &s.Now, Details: json.RawMessage(`{"item_id":"` + item.ID + `","number":9007199254740993,"large":1e200000}`)}}}
			s.Requests[e.ID] = &inference.Request{ID: e.ID, ConversationID: e.ConversationID, WorkerID: worker, ClientID: "alice",
				SessionID: "session" + suffix, ResponseID: "response" + suffix, ReplayHash: "hash" + suffix, CreatedAt: s.Now, State: "queued",
				Input: inference.RequestInput{Messages: e.Messages}, InputCount: 1, CanonicalEnd: 1}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err, Classify(err).Detail())
	}
	ref.ExperimentID = "req" + suffix
	ref.JobID = "job" + suffix
	return ref
}

func rejectInference(t *testing.T, err error, reason string) {
	t.Helper()
	var reject *inference.Rejection
	if !errors.As(err, &reject) || reject.Reason != reason || reject.Fields["transaction_outcome"] != "rolled_back" {
		t.Fatal(reason, err)
	}
}

func TestSQLiteInferenceFencingAndReceipt(t *testing.T) {
	repo := newRepo(t)
	enroll(t, repo, "worker")
	ref := seedRequest(t, repo, "1", "worker", false)
	ctx := t.Context()
	ref.WorkerAuth, ref.Principal, ref.SubmissionID = "worker", "worker:worker", "submission"
	err := repo.WithinInference(ctx, ref, func(s *inference.State) error {
		w := s.Experiments[ref.ExperimentID]
		j := s.Jobs[ref.JobID]
		if len(w.Messages) != 1 || len(j.Context.Messages) != 1 || s.Connection.Generation != 2 || s.Revoked || s.Receipt != nil {
			t.Fatal(w, j, s)
		}
		clock, err := s.DatabaseTime()
		if err != nil || clock.Before(s.Now) {
			t.Fatal(clock, err)
		}
		j.State, j.Reason = "cancelled", "fenced"
		next := *j
		next.ID, next.State, next.Reason = "first-lexically", "claimed", ""
		next.Held = true
		w.CurrentJobID, w.State = next.ID, "inference"
		w.Messages = append(w.Messages, inference.Item{Type: "message", Role: "assistant", Text: "stored"})
		s.Jobs[next.ID] = &next
		s.Receipt = &inference.Receipt{Principal: ref.Principal, SubmissionID: ref.SubmissionID, Result: json.RawMessage(`{"committed":true}`)}
		return nil
	})
	if err != nil {
		t.Fatal(err, Classify(err).Detail())
	}
	ref.JobID = "first-lexically"
	err = repo.WithinInference(ctx, ref, func(s *inference.State) error {
		if s.Receipt == nil || s.Jobs[ref.JobID].WorkerID != "worker" || !s.Jobs[ref.JobID].Held || len(s.Experiments[ref.ExperimentID].Messages) != 2 {
			t.Fatal(s)
		}
		replacement := *s.Jobs[ref.JobID]
		replacement.ID = "illegal-overlap"
		s.Jobs[replacement.ID] = &replacement
		return nil
	})
	f := failReason(t, err, "sqlite_error")
	if f.Outcome != "rolled_back" {
		t.Fatal(f)
	}
	ref.WorkerAuth = "foreign"
	err = repo.WithinInference(ctx, ref, func(*inference.State) error { t.Fatal("foreign worker ran"); return nil })
	rejectInference(t, err, "worker_scope_denied")
	ref.JobID = "unknown"
	err = repo.WithinInference(ctx, ref, func(*inference.State) error { return nil })
	rejectInference(t, err, "inference_not_found")
	ref.JobID, ref.WorkerAuth = "first-lexically", "worker"
	if _, _, err = repo.RevokeWorker(ctx, "worker"); err != nil {
		t.Fatal(err)
	}
	err = repo.WithinInference(ctx, ref, func(*inference.State) error { return nil })
	rejectInference(t, err, "worker_revoked")
	ids, err := repo.InferenceWorkers(ctx)
	if err != nil || len(ids) != 1 || ids[0] != "worker" {
		t.Fatal(ids, err)
	}
}

func TestSQLiteNativeOwnershipAndRecoverableRecords(t *testing.T) {
	repo := newRepo(t)
	enroll(t, repo, "worker")
	ref := seedRequest(t, repo, "one", "", true)
	ctx := t.Context()
	ref.ClientID, ref.SessionID, ref.ReplayHash = "alice", "sessionone", "hashone"
	ref.JobID = ""
	err := repo.WithinInference(ctx, ref, func(s *inference.State) error {
		e, c, r := s.Experiments["reqone"], s.Conversations["convone"], s.Requests["reqone"]
		if r == nil || c == nil || len(c.Items) != 1 || e == nil {
			t.Fatal(s)
		}
		s.Pool["worker"].Connection = inference.Connection{ID: "sibling", Connected: true}
		c.WorkerID, e.WorkerID, r.WorkerID = "worker", "worker", "worker"
		c.PendingCallID = "call"
		e.State, r.State = "completed", "completed"
		r.Output = &inference.Item{Type: "message", Role: "assistant", Text: "accepted"}
		return nil
	})
	if err != nil {
		t.Fatal(err, Classify(err).Detail())
	}
	ref.ResponseID, ref.SessionID = "responseone", "other"
	err = repo.WithinInference(ctx, ref, func(*inference.State) error { return nil })
	rejectInference(t, err, "session_reference_conflict")
	ref.SessionID, ref.WorkerID = "sessionone", "other"
	err = repo.WithinInference(ctx, ref, func(*inference.State) error { return nil })
	rejectInference(t, err, "session_worker_conflict")
	ref.ClientID = "bob"
	err = repo.WithinInference(ctx, ref, func(*inference.State) error { return nil })
	rejectInference(t, err, "history_owner_denied")
	ref = inference.Ref{Routing: true, Recovery: true, Full: true}
	err = repo.WithinInference(ctx, ref, func(s *inference.State) error {
		if s.Conversations["convone"].PendingCallID != "call" || s.Requests["reqone"].Output.Text != "accepted" ||
			s.Recovery.Conversations != 1 || !s.Pool["worker"].Connection.Connected {
			t.Fatal(s)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err, Classify(err).Detail())
	}
	ref = inference.Ref{ClientID: "alice", ResponseID: "responseone", Routing: true, Full: true}
	if err = repo.WithinInference(ctx, ref, func(s *inference.State) error {
		if s.HistoryConversationID != "convone" {
			t.Fatal(s)
		}
		return nil
	}); err != nil {
		t.Fatal(err, Classify(err).Detail())
	}
}

func TestSQLiteStoredHistoryAndKeysetPagination(t *testing.T) {
	repo := newRepo(t)
	enroll(t, repo, "worker")
	stamp := time.Now()
	repo.now = func() time.Time { return stamp }
	seedRequest(t, repo, "a", "worker", true)
	seedRequest(t, repo, "b", "worker", false)
	q := inference.HistoryQuery{Kind: "requests", Limit: 1}
	raw, err := repo.QueryHistory(t.Context(), q)
	var page inference.HistoryPage
	if err != nil || json.Unmarshal(raw, &page) != nil || len(page.Items) != 1 || page.NextCursor == "" || !strings.Contains(string(page.Items[0]), "reqb") {
		t.Fatal(string(raw), err)
	}
	q.After, err = inference.DecodeCursor(page.NextCursor, q)
	if err != nil {
		t.Fatal(err)
	}
	raw, err = repo.QueryHistory(t.Context(), q)
	if err != nil || !strings.Contains(string(raw), "reqa") || strings.Contains(string(raw), "reqb") {
		t.Fatal(string(raw), err)
	}
	for _, fixture := range []struct{ kind, id, want string }{
		{"conversation", "conva", "recorded"}, {"conversation", "convb", "unavailable"},
		{"request", "reqa", `"kind":"native"`}, {"request", "reqb", `"kind":"legacy"`},
		{"conversations", "", "convb"}, {"timeline", "conva", "1e200000"}, {"timeline", "convb", "legacy_job_snapshot"},
	} {
		raw, err = repo.QueryHistory(t.Context(), inference.HistoryQuery{Kind: fixture.kind, ID: fixture.id, Limit: 20})
		if err != nil || !strings.Contains(string(raw), fixture.want) {
			t.Fatal(fixture, string(raw), err, Classify(err).Detail())
		}
		if fixture.kind == "timeline" && (!strings.Contains(string(raw), `\u0000`) || !strings.Contains(string(raw), `\\u0000`)) {
			t.Fatal("raw timeline changed", string(raw))
		}
	}
	for _, kind := range []string{"request", "conversation", "timeline", "unknown"} {
		_, err = repo.QueryHistory(t.Context(), inference.HistoryQuery{Kind: kind, ID: "unknown", Limit: 20})
		reason := "history_not_found"
		if kind == "unknown" {
			reason = "unsupported_history_query"
		}
		rejectInference(t, err, reason)
	}
	execute(t, repo, "UPDATE aaa_conversation_events SET data=?1 WHERE conversation_id='conva'", []byte(`{"sequence":7,"kind":"history.item"}`))
	_, err = repo.QueryHistory(t.Context(), inference.HistoryQuery{Kind: "timeline", ID: "conva", Limit: 20})
	failReason(t, err, "history_projection_invalid")
	execute(t, repo, "UPDATE aaa_conversation_events SET data=?1 WHERE conversation_id='conva'", []byte(`{"sequence":0,"kind":7}`))
	_, err = repo.QueryHistory(t.Context(), inference.HistoryQuery{Kind: "timeline", ID: "conva", Limit: 20})
	failReason(t, err, "history_projection_invalid")
	execute(t, repo, "UPDATE aaa_conversation_events SET data=?1 WHERE conversation_id='conva'", []byte(`{"sequence":0,"kind":"event","details":{"text":"`+strings.Repeat("x", inference.MaxTimelineBytes)+`"}}`))
	_, err = repo.QueryHistory(t.Context(), inference.HistoryQuery{Kind: "timeline", ID: "conva", Limit: 20})
	rejectInference(t, err, "timeline_entry_too_large")
}

func TestSQLiteRepositoryMediaExpiryAndReadFailures(t *testing.T) {
	repo := newRepo(t)
	enroll(t, repo, "worker")
	ref := seedRequest(t, repo, "media", "worker", false)
	ctx := t.Context()
	err := repo.WithinInference(ctx, ref, func(s *inference.State) error {
		j := s.Jobs["jobmedia"]
		past := s.Now.Add(-time.Second)
		j.State, j.Media = "accepted", &inference.Media{ExpiresAt: &past}
		return nil
	})
	if err != nil {
		t.Fatal(err, Classify(err).Detail())
	}
	states, err := repo.MediaCleanupStates(ctx, []string{"jobmedia", "absent"})
	if err != nil || states["jobmedia"] != "expired" || len(states) != 1 {
		t.Fatal(states, err)
	}
	execute(t, repo, "ALTER TABLE aaa_inference_jobs RENAME TO hidden_jobs")
	_, err = repo.MediaCleanupStates(ctx, []string{"jobmedia"})
	failReason(t, err, "sqlite_error")
	_, err = repo.InferenceWorkers(ctx)
	failReason(t, err, "sqlite_error")
	_, err = repo.QueryHistory(ctx, inference.HistoryQuery{Kind: "request", ID: "reqmedia"})
	failReason(t, err, "sqlite_error")
	err = repo.WithinInference(ctx, ref, func(*inference.State) error { return sql.ErrNoRows })
	failReason(t, err, "sqlite_error")
}
