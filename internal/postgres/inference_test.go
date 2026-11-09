package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

type inferenceTx struct {
	workerTransaction
	rowsets        []*workerRows
	queriesSeen    []string
	step, failStep int
}

func (tx *inferenceTx) fault() error {
	tx.step++
	if tx.step == tx.failStep {
		return errors.New("storage fault")
	}
	return nil
}
func (tx *inferenceTx) QueryRow(_ context.Context, q string, args ...any) pgx.Row {
	tx.queriesSeen = append(tx.queriesSeen, q)
	if err := tx.fault(); err != nil {
		return workerRow{err: err}
	}
	if len(tx.rows) == 0 {
		return workerRow{err: pgx.ErrNoRows}
	}
	r := tx.rows[0]
	tx.rows = tx.rows[1:]
	return r
}
func (tx *inferenceTx) Query(_ context.Context, q string, args ...any) (pgx.Rows, error) {
	tx.queriesSeen = append(tx.queriesSeen, q)
	if err := tx.fault(); err != nil {
		return nil, err
	}
	if len(tx.rowsets) == 0 {
		return &workerRows{}, nil
	}
	r := tx.rowsets[0]
	tx.rowsets = tx.rowsets[1:]
	return r, nil
}
func (tx *inferenceTx) Exec(ctx context.Context, q string, args ...any) (pgconn.CommandTag, error) {
	if err := tx.fault(); err != nil {
		return pgconn.CommandTag{}, err
	}
	return tx.workerTransaction.Exec(ctx, q, args...)
}

type inferencePool struct {
	tx  pgx.Tx
	err error
}

func (p inferencePool) Ping(context.Context) error            { return nil }
func (p inferencePool) Close()                                {}
func (p inferencePool) Begin(context.Context) (pgx.Tx, error) { return p.tx, p.err }

func encoded(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func inferenceSQLFixture(t *testing.T) (*Repository, *inferenceTx, inference.Ref) {
	t.Helper()
	now := time.Now().UTC()
	e := inference.Experiment{ID: "exp", ConversationID: "conversation", WorkerID: "worker", State: "queued", DeadlineAt: now.Add(time.Hour), Tools: []inference.Tool{}}
	j := inference.Job{ID: "job", ExperimentID: "exp", WorkerID: "worker", State: "queued", Context: inference.Delivery{ReceiptID: "job", Kind: "full", Messages: []inference.Item{{Type: "message", Role: "user", Text: "fixture"}}, Tools: []inference.Tool{}}}
	c := inference.Connection{ID: "conn", Connected: true, OpenedAt: now}
	data, err := jobHeader(&j)
	if err != nil {
		t.Fatal(err)
	}
	tx := &inferenceTx{workerTransaction: workerTransaction{rows: []workerRow{{values: []any{(*time.Time)(nil)}}, {values: []any{now}}, {values: []any{encoded(t, c)}}}}, rowsets: []*workerRows{
		{records: []workerRow{{values: []any{encoded(t, e)}}}},
		{records: []workerRow{{values: []any{encoded(t, inference.Item{Type: "message", Role: "user", Text: "fixture"})}}}},
		{records: []workerRow{{values: []any{data, encoded(t, j.Context)}}}},
	}}
	return New(inferencePool{tx: tx}), tx, inference.Ref{WorkerID: "worker", Full: true}
}

func TestInferenceRepositoryWritesActualState(t *testing.T) {
	repo, tx, ref := inferenceSQLFixture(t)
	err := repo.WithinInference(context.Background(), ref, func(s *inference.State) error {
		if s.WorkerID != "worker" || s.Now.IsZero() || len(s.Experiments["exp"].Messages) != 1 || len(s.Jobs["job"].Context.Messages) != 1 {
			t.Fatal("scope/history/context lost")
		}
		s.Connection.Generation++
		s.Experiments["exp"].State = "inference"
		s.Experiments["exp"].Messages = append(s.Experiments["exp"].Messages, inference.Item{Type: "message", Role: "assistant", Text: "observed"})
		s.Jobs["job"].State = "claimed"
		s.Jobs["job"].Held = true
		s.Receipt = &inference.Receipt{Principal: "worker:worker", SubmissionID: "submission", InputHash: "hash", Result: json.RawMessage(`{"accepted":true}`)}
		return nil
	})
	if err != nil || !tx.committed || tx.rolledBack {
		t.Fatal("state did not commit", err)
	}
	joined := strings.Join(tx.queries, "\n")
	for _, table := range []string{"aaa_worker_connections", "aaa_experiments", "aaa_inference_history", "aaa_inference_jobs", "aaa_inference_receipts"} {
		if !strings.Contains(joined, "INSERT INTO "+table) {
			t.Fatal("missing persistence", table)
		}
	}
	for i, q := range tx.queries {
		if strings.Contains(q, "aaa_inference_history") && tx.arguments[i][1] != 1 {
			t.Fatal("rewrote previously observed history")
		}
		if strings.Contains(q, "aaa_inference_jobs") && strings.Contains(strings.Split(q, "ON CONFLICT")[1], "context=") {
			t.Fatal("immutable delivered context overwritten")
		}
	}
}

func TestInferenceReadOnlyAndStorageFailures(t *testing.T) {
	repo, tx, ref := inferenceSQLFixture(t)
	if err := repo.WithinInference(context.Background(), ref, func(*inference.State) error { return nil }); err != nil || len(tx.queries) != 0 {
		t.Fatal("read rewrote records", err)
	}
	for step := 1; step <= 11; step++ {
		t.Run(string(rune('a'+step)), func(t *testing.T) {
			repo, tx, ref := inferenceSQLFixture(t)
			tx.failStep = step
			err := repo.WithinInference(context.Background(), ref, func(s *inference.State) error {
				s.Connection.Generation++
				s.Experiments["exp"].State = "inference"
				s.Experiments["exp"].Messages = append(s.Experiments["exp"].Messages, inference.Item{Type: "message", Role: "assistant", Text: "x"})
				s.Jobs["job"].Held = true
				s.Receipt = &inference.Receipt{Principal: "p", SubmissionID: "s", Result: json.RawMessage(`{}`)}
				return nil
			})
			if err == nil || !tx.rolledBack {
				t.Fatal("fault did not roll back", step, err)
			}
		})
	}
	for _, kind := range []string{"worker-missing", "worker-query", "clock", "connection-query", "connection-json", "experiment-json", "history-json", "job-json", "delivery-json", "row-scan", "rows-end", "callback", "commit", "admission", "receipt", "revoked"} {
		t.Run(kind, func(t *testing.T) {
			repo, tx, ref := inferenceSQLFixture(t)
			switch kind {
			case "worker-missing":
				tx.rows[0].err = pgx.ErrNoRows
			case "worker-query":
				tx.rows[0].err = errors.New("query failed")
			case "clock":
				tx.rows[1].err = errors.New("clock failed")
			case "connection-query":
				tx.rows[2].err = errors.New("connection failed")
			case "connection-json":
				tx.rows[2].values = []any{[]byte("invalid")}
			case "experiment-json":
				tx.rowsets[0].records[0].values = []any{[]byte("invalid")}
			case "history-json":
				tx.rowsets[1].records[0].values = []any{[]byte("invalid")}
			case "job-json":
				tx.rowsets[2].records[0].values[0] = []byte("invalid")
			case "delivery-json":
				tx.rowsets[2].records[0].values[1] = []byte("invalid")
			case "row-scan":
				tx.rowsets[0].records[0].err = errors.New("scan failed")
			case "rows-end":
				tx.rowsets[1].endErr = errors.New("rows failed")
			case "commit":
				tx.commitErr = errors.New("commit uncertain")
			case "admission":
				ref.Admission = true
				tx.rows = append(tx.rows, workerRow{err: errors.New("count failed")})
			case "receipt":
				ref.Principal = "p"
				ref.SubmissionID = "s"
				tx.rows = append(tx.rows, workerRow{values: []any{[]byte("invalid")}})
			case "revoked":
				now := time.Now()
				tx.rows[0].values = []any{&now}
				ref.WorkerAuth = "worker"
			}
			err := repo.WithinInference(context.Background(), ref, func(*inference.State) error {
				if kind == "callback" {
					return inference.Reject("rejected", 409)
				}
				return nil
			})
			if err == nil {
				t.Fatal("storage/authorization fault ignored")
			}
		})
	}
}

func TestInferenceScopeReceiptsAndWorkerDiscovery(t *testing.T) {
	for _, kind := range []string{"job", "experiment", "foreign", "missing", "query"} {
		repo, tx, ref := inferenceSQLFixture(t)
		row := workerRow{values: []any{"worker", "exp", encoded(t, inference.Job{ID: "job", ExperimentID: "exp", ConversationID: "conversation", WorkerID: "worker", Generation: 3, State: "claimed"})}}
		if kind == "experiment" {
			ref.ExperimentID = "exp"
			row.values = []any{"worker"}
		} else {
			ref.JobID = "job"
		}
		if kind == "foreign" {
			ref.WorkerAuth = "other"
		}
		if kind == "missing" {
			row.err = pgx.ErrNoRows
		}
		if kind == "query" {
			row.err = errors.New("lookup failed")
		}
		tx.rows = append([]workerRow{row}, tx.rows...)
		err := repo.WithinInference(context.Background(), ref, func(*inference.State) error { return nil })
		if (kind == "job" || kind == "experiment") != (err == nil) {
			t.Fatal("scope resolution incorrect", kind, err)
		}
		if kind == "foreign" {
			var rejected *inference.Rejection
			if !errors.As(err, &rejected) {
				t.Fatal("scope rejection missing")
			}
			correlation := rejected.Fields["correlation"].(map[string]any)
			if correlation["operation_id"] != "exp" || correlation["conversation_id"] != "conversation" || correlation["generation"] != int64(3) {
				t.Fatal("foreign rejection lost assignment correlation")
			}
		}
	}
	repo, tx, ref := inferenceSQLFixture(t)
	ref.Admission = true
	ref.SubmissionID = "s"
	ref.Principal = "management"
	tx.rows = append(tx.rows, workerRow{values: []any{1}}, workerRow{values: []any{encoded(t, inference.Receipt{Principal: "management", SubmissionID: "s", Result: json.RawMessage(`{}`)})}})
	if err := repo.WithinInference(context.Background(), ref, func(s *inference.State) error {
		if s.ActiveCount != 1 || s.Receipt == nil {
			t.Fatal("admission/receipt omitted")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(tx.queries, "\n"), "pg_advisory_xact_lock") {
		t.Fatal("admission/receipt race lacks lock")
	}
	for _, kind := range []string{"success", "query", "scan", "rows"} {
		tx := &inferenceTx{rowsets: []*workerRows{{records: []workerRow{{values: []any{"worker"}}}}}}
		if kind == "query" {
			tx.failStep = 1
		}
		if kind == "scan" {
			tx.rowsets[0].records[0].err = errors.New("scan")
		}
		if kind == "rows" {
			tx.rowsets[0].endErr = errors.New("rows")
		}
		ids, err := New(inferencePool{tx: tx}).InferenceWorkers(context.Background())
		if (kind == "success") != (err == nil) {
			t.Fatal("worker discovery fault hidden", kind)
		}
		if kind == "success" && (len(ids) != 1 || ids[0] != "worker") {
			t.Fatal("wrong worker discovery")
		}
	}
}
