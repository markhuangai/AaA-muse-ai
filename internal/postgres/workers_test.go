package postgres

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

type workerRow struct {
	values []any
	err    error
}

func (r workerRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, value := range r.values {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(value))
	}
	return nil
}

type workerRows struct {
	pgx.Rows
	records []workerRow
	index   int
	endErr  error
	closed  bool
}

func (r *workerRows) Next() bool { return r.index < len(r.records) }
func (r *workerRows) Scan(dest ...any) error {
	row := r.records[r.index]
	r.index++
	return row.Scan(dest...)
}
func (r *workerRows) Err() error { return r.endErr }
func (r *workerRows) Close()     { r.closed = true }

type workerTransaction struct {
	pgx.Tx
	rows                                      []workerRow
	queries                                   []string
	arguments                                 [][]any
	listing                                   *workerRows
	queryErr, execErr, commitErr, rollbackErr error
	committed, rolledBack                     bool
}

func (tx *workerTransaction) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	tx.queries = append(tx.queries, query)
	tx.arguments = append(tx.arguments, args)
	row := tx.rows[0]
	tx.rows = tx.rows[1:]
	return row
}
func (tx *workerTransaction) Query(_ context.Context, query string, args ...any) (pgx.Rows, error) {
	tx.queries = append(tx.queries, query)
	tx.arguments = append(tx.arguments, args)
	return tx.listing, tx.queryErr
}
func (tx *workerTransaction) Exec(_ context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	tx.queries = append(tx.queries, query)
	tx.arguments = append(tx.arguments, args)
	return pgconn.NewCommandTag("UPDATE 1"), tx.execErr
}
func (tx *workerTransaction) Commit(context.Context) error { tx.committed = true; return tx.commitErr }
func (tx *workerTransaction) Rollback(context.Context) error {
	tx.rolledBack = true
	return tx.rollbackErr
}

type workerPool struct {
	tx  *workerTransaction
	err error
}

func (p *workerPool) Ping(context.Context) error            { return nil }
func (p *workerPool) Begin(context.Context) (pgx.Tx, error) { return p.tx, p.err }
func (p *workerPool) Close()                                {}

func workerValues(now time.Time, revoked *time.Time) workerRow {
	return workerRow{values: []any{"worker-id", "Worker name", now, revoked, &now}}
}
func requireReason(t *testing.T, err error, want string) {
	t.Helper()
	var rejection *worker.Rejection
	if !errors.As(err, &rejection) || rejection.Reason != want || rejection.Outcome != "rolled_back" {
		t.Fatalf("expected %s rollback, got %v", want, err)
	}
}

func TestIssueEnrollmentSQLAndFailures(t *testing.T) {
	now := time.Now().UTC()
	hash := auth.Digest("code")
	tx := &workerTransaction{rows: []workerRow{{values: []any{"enrollment-id", now, now.Add(15 * time.Minute)}}}}
	e, err := New(&workerPool{tx: tx}).IssueEnrollment(context.Background(), "enrollment-id", hash, 15*time.Minute)
	if err != nil || e.ID != "enrollment-id" || !tx.committed || tx.rolledBack || tx.arguments[0][2] != float64(900) || !reflect.DeepEqual(tx.arguments[0][1], hash[:]) || !strings.Contains(tx.queries[0], "clock_timestamp") {
		t.Fatal("issue did not persist hash/window atomically")
	}
	for _, phase := range []string{"begin", "query", "commit", "rollback"} {
		tx := &workerTransaction{rows: []workerRow{{err: errors.New("storage rejected")}}}
		p := &workerPool{tx: tx}
		if phase == "begin" {
			p.err = context.DeadlineExceeded
		}
		if phase == "commit" {
			tx.rows = []workerRow{{values: []any{"id", now, now.Add(time.Minute)}}}
			tx.commitErr = errors.New("lost commit result")
		}
		if phase == "rollback" {
			tx.rollbackErr = errors.New("rollback unavailable")
		}
		_, err := New(p).IssueEnrollment(context.Background(), "id", hash, time.Minute)
		var failure *Failure
		if !errors.As(err, &failure) || failure.Outcome == "" || failure.Detail() == "" {
			t.Fatal("missing transaction failure evidence")
		}
		if (phase == "commit" || phase == "rollback") && failure.Outcome != "uncertain" {
			t.Fatal("uncertain transaction reported rolled back")
		}
	}
}

func TestConsumeEnrollmentAtomicSQL(t *testing.T) {
	now := time.Now().UTC()
	code, key := auth.Digest("registration"), auth.Digest("credential")
	for _, scenario := range []string{"success", "missing", "read", "clock", "used", "expired", "insert", "update", "commit"} {
		t.Run(scenario, func(t *testing.T) {
			e := workerRow{values: []any{"enrollment-id", now.Add(-time.Minute), now.Add(time.Minute), (*time.Time)(nil), ""}}
			tx := &workerTransaction{rows: []workerRow{e, {values: []any{now}}, workerValues(now, nil)}}
			switch scenario {
			case "missing":
				tx.rows[0].err = pgx.ErrNoRows
			case "read":
				tx.rows[0].err = errors.New("read failed")
			case "clock":
				tx.rows[1].err = errors.New("clock failed")
			case "used":
				tx.rows[0].values[3], tx.rows[0].values[4] = &now, "already-issued"
			case "expired":
				tx.rows[0].values[2] = now
			case "insert":
				tx.rows[2].err = errors.New("insert failed")
			case "update":
				tx.execErr = errors.New("consume failed")
			case "commit":
				tx.commitErr = errors.New("commit result lost")
			}
			w, evidence, err := New(&workerPool{tx: tx}).ConsumeEnrollment(context.Background(), code, "worker-id", key, "Worker name")
			if !strings.Contains(tx.queries[0], "FOR UPDATE") || !reflect.DeepEqual(tx.arguments[0][0], code[:]) {
				t.Fatal("code lookup lacks hash/row lock")
			}
			if scenario == "success" {
				if err != nil || w.ID != "worker-id" || evidence.WorkerID != "worker-id" || evidence.ConsumedAt == nil || !tx.committed || tx.rolledBack || len(tx.queries) != 4 || !reflect.DeepEqual(tx.arguments[2][2], key[:]) {
					t.Fatal("atomic consume/issue did not complete")
				}
			} else {
				if err == nil || !tx.rolledBack {
					t.Fatal("failed consume committed or lacked rollback")
				}
				if scenario != "commit" && tx.committed {
					t.Fatal("committed a rejected operation")
				}
				if scenario == "used" || scenario == "expired" || scenario == "missing" {
					reason := map[string]string{"used": "enrollment_used", "expired": "enrollment_expired", "missing": "enrollment_invalid"}[scenario]
					requireReason(t, err, reason)
				}
			}
			if scenario != "missing" && scenario != "read" && tx.queries[1] != "SELECT clock_timestamp()" {
				t.Fatal("expiry was not checked after lock acquisition")
			}
		})
	}
}

func TestWorkerAuthenticationSQL(t *testing.T) {
	now := time.Now().UTC()
	key := auth.Digest("worker-only")
	for _, scenario := range []string{"success", "missing", "read", "revoked", "contact"} {
		tx := &workerTransaction{rows: []workerRow{workerValues(now, nil), {values: []any{&now}}}}
		if scenario == "missing" {
			tx.rows[0].err = pgx.ErrNoRows
		}
		if scenario == "read" {
			tx.rows[0].err = errors.New("read failed")
		}
		if scenario == "revoked" {
			tx.rows[0] = workerValues(now, &now)
		}
		if scenario == "contact" {
			tx.rows[1].err = errors.New("contact failed")
		}
		w, err := New(&workerPool{tx: tx}).AuthenticateWorker(context.Background(), key)
		if !strings.Contains(tx.queries[0], "credential_hash=$1 FOR UPDATE") || !reflect.DeepEqual(tx.arguments[0][0], key[:]) {
			t.Fatal("auth did not read durable authority")
		}
		if scenario == "success" {
			if err != nil || !tx.committed || w.ID != "worker-id" || w.LastContactAt == nil || !strings.Contains(tx.queries[1], "last_contact_at=clock_timestamp()") {
				t.Fatal("scoped contact failed")
			}
		} else if err == nil || !tx.rolledBack {
			t.Fatal("failed auth accepted")
		}
		if scenario == "missing" {
			requireReason(t, err, "invalid_worker_credential")
		}
		if scenario == "revoked" {
			requireReason(t, err, "worker_revoked")
		}
	}
}

func TestWorkerListSQL(t *testing.T) {
	now := time.Now().UTC()
	for _, scenario := range []string{"success", "query", "scan", "rows"} {
		rows := &workerRows{records: []workerRow{workerValues(now, nil), workerValues(now, &now)}}
		tx := &workerTransaction{listing: rows}
		if scenario == "query" {
			tx.queryErr = errors.New("query failed")
		}
		if scenario == "scan" {
			rows.records[0].err = errors.New("scan failed")
		}
		if scenario == "rows" {
			rows.endErr = errors.New("rows interrupted")
		}
		all, err := New(&workerPool{tx: tx}).Workers(context.Background())
		if scenario == "success" {
			if err != nil || len(all) != 2 || all[1].RevokedAt == nil || !tx.committed {
				t.Fatal("list omitted revoked identity")
			}
		} else if err == nil || !tx.rolledBack {
			t.Fatal("incomplete list accepted")
		}
		if scenario != "query" && !rows.closed {
			t.Fatal("rows not closed")
		}
	}
}

func TestWorkerMetadataSQL(t *testing.T) {
	now := time.Now().UTC()
	for _, scenario := range []string{"rename", "rename-missing", "rename-update", "revoke", "revoke-missing", "revoke-update", "revoke-repeat"} {
		tx := &workerTransaction{rows: []workerRow{workerValues(now, nil), {values: []any{"worker-id", "Renamed", now, (*time.Time)(nil), &now}}}}
		r := New(&workerPool{tx: tx})
		var err error
		if strings.HasSuffix(scenario, "missing") {
			tx.rows[0].err = pgx.ErrNoRows
		}
		if strings.HasPrefix(scenario, "revoke") {
			tx.rows[1] = workerValues(now, &now)
		}
		if scenario == "revoke-repeat" {
			tx.rows[0] = workerValues(now, &now)
		}
		if scenario == "rename-update" || scenario == "revoke-update" {
			tx.rows[1].err = errors.New("update failed")
		}
		if strings.HasPrefix(scenario, "rename") {
			before, after, e := r.RenameWorker(context.Background(), "worker-id", "Renamed")
			err = e
			if scenario == "rename" && (before.Name == after.Name || before.ID != after.ID || after.Name != "Renamed") {
				t.Fatal("rename changed identity or lost name")
			}
		} else {
			before, after, e := r.RevokeWorker(context.Background(), "worker-id")
			err = e
			if !strings.Contains(tx.queries[0], "FOR UPDATE") {
				t.Fatal("revocation did not lock prior state")
			}
			if scenario == "revoke" || scenario == "revoke-repeat" {
				if after.RevokedAt == nil || before.ID != after.ID || !strings.Contains(tx.queries[1], "COALESCE(revoked_at, clock_timestamp())") {
					t.Fatal("revocation lost before/after state or idempotency")
				}
				if (scenario == "revoke-repeat") != (before.RevokedAt != nil) {
					t.Fatal("prior revocation state incorrect")
				}
			}
		}
		if scenario == "rename" || scenario == "revoke" || scenario == "revoke-repeat" {
			if err != nil || !tx.committed {
				t.Fatal("metadata mutation failed")
			}
		} else if err == nil || !tx.rolledBack {
			t.Fatal("failed mutation accepted")
		}
	}
}
