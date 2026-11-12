package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

type routingTx struct {
	inferenceTx
	t    *testing.T
	now  time.Time
	mode string
}

func (tx *routingTx) QueryRow(_ context.Context, q string, args ...any) pgx.Row {
	tx.queriesSeen = append(tx.queriesSeen, q)
	if err := tx.fault(); err != nil {
		return workerRow{err: err}
	}
	switch {
	case strings.Contains(q, "SELECT (SELECT count(*) FROM aaa_inference_receipts)"):
		if tx.mode == "recovery-summary-error" {
			return workerRow{err: errors.New("recovery summary unavailable")}
		}
		return workerRow{values: []any{7, 4}}
	case strings.Contains(q, "clock_timestamp"):
		return workerRow{values: []any{tx.now}}
	case strings.Contains(q, "count(*)"):
		return workerRow{values: []any{1}}
	case strings.Contains(q, "aaa_worker_connections"):
		if tx.mode == "connection-error" {
			return workerRow{err: errors.New("connection read")}
		}
		if tx.mode == "connection-missing" {
			return workerRow{err: pgx.ErrNoRows}
		}
		if tx.mode == "connection-json" {
			return workerRow{values: []any{[]byte("{")}}
		}
		return workerRow{values: []any{encoded(tx.t, inference.Connection{ID: "connection", Generation: 1, Connected: true, LastAckAt: &tx.now})}}
	case strings.Contains(q, "aaa_worker_routing"):
		if tx.mode == "routing-error" {
			return workerRow{err: errors.New("routing read")}
		}
		if tx.mode == "routing-missing" {
			return workerRow{err: pgx.ErrNoRows}
		}
		if tx.mode == "routing-json" {
			return workerRow{values: []any{[]byte("{")}}
		}
		return workerRow{values: []any{encoded(tx.t, inference.WorkerRouting{})}}
	case strings.Contains(q, "aaa_inference_receipts"):
		if tx.mode == "receipt-error" {
			return workerRow{err: errors.New("receipt read")}
		}
		if tx.mode == "receipt-json" {
			return workerRow{values: []any{[]byte("{")}}
		}
		if tx.mode == "receipt-present" {
			return workerRow{values: []any{encoded(tx.t, inference.Receipt{Principal: "management", SubmissionID: "submission"})}}
		}
	}
	return workerRow{err: pgx.ErrNoRows}
}

func (tx *routingTx) Query(_ context.Context, q string, args ...any) (pgx.Rows, error) {
	tx.queriesSeen = append(tx.queriesSeen, q)
	if err := tx.fault(); err != nil {
		return nil, err
	}
	result := &workerRows{}
	if strings.Contains(q, "SELECT id,revoked_at") {
		result.records = []workerRow{{values: []any{"worker", (*time.Time)(nil)}}}
		if tx.mode == "worker-scan" {
			result.records[0].err = errors.New("worker scan")
		}
		if tx.mode == "worker-rows" {
			result.endErr = errors.New("worker rows")
		}
	} else if strings.HasPrefix(q, "SELECT data FROM aaa_experiments") && args[0] == "" {
		result.records = []workerRow{{values: []any{encoded(tx.t, inference.Experiment{ID: "request", ConversationID: "conversation", State: "queued", DeadlineAt: tx.now.Add(time.Minute)})}}}
	} else if strings.HasPrefix(q, "SELECT data FROM aaa_model_requests") {
		result.records = []workerRow{{values: []any{encoded(tx.t, inference.Request{ID: "request", ConversationID: "conversation", ClientID: "alice", SessionID: "session", State: "queued", ResponseID: "response", CanonicalEnd: 1})}}}
	} else if strings.HasPrefix(q, "SELECT data FROM aaa_conversations") {
		result.records = []workerRow{{values: []any{encoded(tx.t, inference.Conversation{ID: "conversation", ClientID: "alice", SessionID: "session", ItemCount: 1})}}}
	} else if strings.HasPrefix(q, "SELECT data FROM aaa_conversation_items") {
		result.records = []workerRow{{values: []any{encoded(tx.t, inference.HistoryItem{ID: "item", RequestID: "request", Item: inference.Item{Type: "message", Role: "user", Text: "exact\r\n"}})}}}
	}
	return result, nil
}

func routingRepository(t *testing.T, mode string) (*Repository, *routingTx, inference.Ref) {
	t.Helper()
	tx := &routingTx{t: t, now: time.Date(2026, 11, 11, 1, 0, 0, 0, time.UTC), mode: mode}
	return New(inferencePool{tx: tx}), tx, inference.Ref{Routing: true, Full: true, WorkerID: "worker", Principal: "management", SubmissionID: "submission"}
}

func applyRouting(s *inference.State) error {
	w := s.Pool["worker"]
	w.Connection.Generation++
	w.Routing.LastDispatchedAt = &s.Now
	w.Routing.Qualifications = append(w.Routing.Qualifications, inference.Qualification{ID: "qualification", WorkerID: "worker"})
	s.Experiments["request"].WorkerID = "worker"
	s.Conversations["conversation"].WorkerID = "worker"
	s.Requests["request"].WorkerID = "worker"
	s.Jobs["job"] = &inference.Job{ID: "job", WorkerID: "worker", ExperimentID: "request", State: "queued", Context: inference.Delivery{Kind: "full", Messages: s.Experiments["request"].Messages}}
	s.Receipt = &inference.Receipt{Principal: "management", SubmissionID: "submission"}
	return nil
}

func TestRoutingRepositoryAtomicAssignmentAndAllIOFailures(t *testing.T) {
	repo, tx, ref := routingRepository(t, "")
	if err := repo.WithinInference(context.Background(), ref, applyRouting); err != nil {
		t.Fatal(err)
	}
	if !tx.committed {
		t.Fatal("routing not committed")
	}
	queries := strings.Join(tx.queries, "\n")
	for _, table := range []string{"aaa_worker_routing", "aaa_worker_connections", "aaa_conversations", "aaa_model_requests", "aaa_inference_jobs", "aaa_inference_receipts"} {
		if !strings.Contains(queries, "INSERT INTO "+table) {
			t.Fatal("routing mutation omitted", table)
		}
	}
	if !strings.Contains(queries, "worker_id=EXCLUDED.worker_id") {
		t.Fatal("relational worker identity not updated")
	}
	for step := 1; step <= tx.step; step++ {
		repo, failing, ref := routingRepository(t, "")
		failing.failStep = step
		if err := repo.WithinInference(context.Background(), ref, applyRouting); err == nil || !failing.rolledBack {
			t.Fatal("routing fault did not roll back", step, err)
		}
	}
}

func TestRoutingRepositoryReadEvidenceAndFailures(t *testing.T) {
	for _, mode := range []string{"connection-error", "connection-json", "connection-missing", "routing-error", "routing-json", "routing-missing", "receipt-error", "receipt-json", "receipt-present", "worker-scan", "worker-rows", "callback", "commit", "unknown-worker", "no-submission", "unassigned"} {
		t.Run(mode, func(t *testing.T) {
			repo, tx, ref := routingRepository(t, mode)
			fn := func(s *inference.State) error {
				if len(s.Experiments["request"].Messages) != 1 {
					t.Fatal("canonical unassigned context lost")
				}
				return nil
			}
			wantFailure := true
			switch mode {
			case "connection-missing", "routing-missing", "receipt-present":
				wantFailure = false
			case "callback":
				fn = func(*inference.State) error { return inference.Reject("deliberate", 409) }
			case "commit":
				tx.commitErr = errors.New("commit failed")
			case "unknown-worker":
				ref.WorkerID = "missing"
			case "no-submission":
				ref.SubmissionID = ""
				wantFailure = false
			case "unassigned":
				ref.WorkerID = ""
				wantFailure = false
			}
			err := repo.WithinInference(context.Background(), ref, fn)
			if (err != nil) != wantFailure {
				t.Fatal("wrong transaction result", mode, err)
			}
		})
	}
	if nullableWorker("") != nil || nullableWorker("worker") != "worker" {
		t.Fatal("nullable worker changed")
	}
}

func TestInferencePersistenceFencesExistingJobBeforeReplacementInsert(t *testing.T) {
	repo, tx, ref := inferenceSQLFixture(t)
	err := repo.WithinInference(context.Background(), ref, func(s *inference.State) error {
		old := s.Jobs["job"]
		old.State, old.Reason = "cancelled", "rerouted_before_delivery"
		replacement := *old
		replacement.ID, replacement.State, replacement.Reason = "aaa-replacement", "queued", ""
		s.Jobs[replacement.ID] = &replacement
		s.Experiments["exp"].CurrentJobID = replacement.ID
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for index, query := range tx.queries {
		if strings.Contains(query, "INSERT INTO aaa_inference_jobs") {
			ids = append(ids, tx.arguments[index][0].(string))
		}
	}
	if len(ids) != 2 || ids[0] != "job" || ids[1] != "aaa-replacement" {
		t.Fatal("replacement persisted before existing fence", ids)
	}
	if !tx.committed {
		t.Fatal("fence and replacement were not atomic")
	}
}
