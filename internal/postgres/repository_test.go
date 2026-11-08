package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type rows struct {
	pgx.Rows
	versions        []int
	checksums       []string
	index           int
	scanErr, endErr error
	closed          bool
}

func (r *rows) Next() bool { return r.index < len(r.versions) }
func (r *rows) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	*dest[0].(*int) = r.versions[r.index]
	*dest[1].(*string) = r.checksums[r.index]
	r.index++
	return nil
}
func (r *rows) Close()     { r.closed = true }
func (r *rows) Err() error { return r.endErr }

type transaction struct {
	pgx.Tx
	commands              []string
	arguments             [][]any
	rows                  *rows
	failExec              int
	queryErr, commitErr   error
	committed, rolledBack bool
}

func (tx *transaction) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.commands = append(tx.commands, sql)
	tx.arguments = append(tx.arguments, args)
	if tx.failExec == len(tx.commands) {
		return pgconn.CommandTag{}, errors.New("execution failed")
	}
	return pgconn.NewCommandTag("OK"), nil
}
func (tx *transaction) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return tx.rows, tx.queryErr
}
func (tx *transaction) Commit(context.Context) error   { tx.committed = true; return tx.commitErr }
func (tx *transaction) Rollback(context.Context) error { tx.rolledBack = true; return nil }

type pool struct {
	tx                *transaction
	pingErr, beginErr error
	closed            bool
}

func (p *pool) Ping(context.Context) error            { return p.pingErr }
func (p *pool) Begin(context.Context) (pgx.Tx, error) { return p.tx, p.beginErr }
func (p *pool) Close()                                { p.closed = true }
func baselineChecksum() string {
	b, _ := migrations.ReadFile("migrations/001_initial.sql")
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestBootstrapTransaction(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "fresh", true: "existing"}[existing], func(t *testing.T) {
			r := &rows{}
			if existing {
				r.versions = []int{1}
				r.checksums = []string{baselineChecksum()}
			}
			tx := &transaction{rows: r}
			p := &pool{tx: tx}
			repo := New(p)
			if err := repo.Bootstrap(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !tx.committed || !tx.rolledBack || !r.closed || !strings.Contains(tx.commands[0], "pg_advisory_xact_lock") {
				t.Fatal("transaction or lock missing")
			}
			if tx.arguments[0][0] != migrationLock {
				t.Fatal("wrong lock ownership")
			}
			want := 3
			if existing {
				want = 2
			}
			if len(tx.commands) != want {
				t.Fatal("unexpected migration execution")
			}
			if !existing && (tx.arguments[2][0] != 1 || tx.arguments[2][1] != baselineChecksum()) {
				t.Fatal("wrong durable version/checksum")
			}
			if repo.Ping(context.Background()) != nil {
				t.Fatal("ping failed")
			}
			repo.Close()
			if !p.closed {
				t.Fatal("pool not closed")
			}
		})
	}
}

func TestBootstrapFailures(t *testing.T) {
	for _, name := range []string{"ping", "begin", "lock", "ddl", "query", "scan", "rows", "newer", "older", "checksum", "insert", "commit"} {
		t.Run(name, func(t *testing.T) {
			tx := &transaction{rows: &rows{}}
			p := &pool{tx: tx}
			failure := errors.New("dependency failed")
			switch name {
			case "ping":
				p.pingErr = failure
			case "begin":
				p.beginErr = failure
			case "lock":
				tx.failExec = 1
			case "ddl":
				tx.failExec = 2
			case "query":
				tx.queryErr = failure
			case "scan":
				tx.rows.versions = []int{1}
				tx.rows.scanErr = failure
			case "rows":
				tx.rows.endErr = failure
			case "newer":
				tx.rows.versions = []int{2}
				tx.rows.checksums = []string{"x"}
			case "older":
				tx.rows.versions = []int{0}
				tx.rows.checksums = []string{"x"}
			case "checksum":
				tx.rows.versions = []int{1}
				tx.rows.checksums = []string{"x"}
			case "insert":
				tx.failExec = 3
			case "commit":
				tx.commitErr = failure
			}
			if err := New(p).Bootstrap(context.Background()); err == nil {
				t.Fatal("accepted migration failure")
			}
			if name != "commit" && tx.committed {
				t.Fatal("committed failed migration")
			}
		})
	}
}

func TestFailureClassificationAndConnection(t *testing.T) {
	for _, tc := range []struct {
		err           error
		reason, state string
	}{{&pgconn.PgError{Code: "28P01"}, "database_authentication_failed", "28P01"}, {&pgconn.PgError{Code: "28000"}, "database_authentication_failed", "28000"}, {&pgconn.PgError{Code: "3D000"}, "database_missing", "3D000"}, {&pgconn.PgError{Code: "53300"}, "postgres_error", "53300"}, {context.DeadlineExceeded, "database_unavailable", ""}, {&net.OpError{Op: "dial", Err: errors.New("refused")}, "database_unavailable", ""}, {errors.New("ordinary"), "database_operation_failed", ""}} {
		f := Classify(tc.err)
		if f.Reason != tc.reason || f.SQLState != tc.state || f.Detail() == "" || f.Unwrap() != tc.err {
			t.Fatal("wrong cause mapping")
		}
	}
	known := &Failure{Reason: "known"}
	if Classify(known) != known || known.Detail() != "known" || known.Error() != "known" {
		t.Fatal("failure identity lost")
	}
	if _, err := Open(context.Background(), "postgres://%"); err == nil {
		t.Fatal("accepted invalid connection URL")
	}
	repo, err := Open(context.Background(), "postgres://db/muse?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	repo.Close()
}
