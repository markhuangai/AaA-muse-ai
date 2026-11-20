package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func privatePath(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "broker.sqlite3")
}

func newRepo(t *testing.T) *Repository {
	t.Helper()
	repo := openRepo(t, privatePath(t))
	if err := repo.Bootstrap(t.Context()); err != nil {
		t.Fatal(err, Classify(err).Detail())
	}
	return repo
}

func openRepo(t *testing.T, path string) *Repository {
	t.Helper()
	repo, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err, Classify(err).Detail())
	}
	t.Cleanup(repo.Close)
	return repo
}

func execute(t *testing.T, repo *Repository, statement string, args ...any) {
	t.Helper()
	if _, err := repo.db.ExecContext(t.Context(), statement, args...); err != nil {
		t.Fatal(err)
	}
}

func failReason(t *testing.T, err error, reason string) *Failure {
	t.Helper()
	if err == nil || Classify(err).Reason != reason {
		t.Fatalf("wanted %s, got %v", reason, err)
	}
	return Classify(err)
}

func TestSQLiteBootstrapConnectionSettingsAndRestart(t *testing.T) {
	path := privatePath(t)
	first, second := openRepo(t, path), openRepo(t, path)
	done := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for _, repo := range []*Repository{first, second} {
		go func() {
			ready.Done()
			ready.Wait()
			done <- repo.Bootstrap(t.Context())
		}()
	}
	for range 2 {
		if err := <-done; err != nil {
			t.Fatal(err, Classify(err).Detail())
		}
	}
	for _, repo := range []*Repository{first, second} {
		if err := repo.Ping(t.Context()); err != nil {
			t.Fatal(err)
		}
		for pragma, expected := range map[string]string{"journal_mode": "wal", "foreign_keys": "1", "busy_timeout": "2000", "synchronous": "2"} {
			var value string
			if err := repo.db.QueryRowContext(t.Context(), "PRAGMA "+pragma).Scan(&value); err != nil || value != expected {
				t.Fatal(pragma, value, err)
			}
		}
		var version string
		if err := repo.db.QueryRowContext(t.Context(), "SELECT sqlite_version()").Scan(&version); err != nil || version != EngineVersion {
			t.Fatal("packaged engine drift", version, err)
		}
	}
	for _, file := range []string{path, path + "-wal", path + "-shm"} {
		info, err := os.Stat(file)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatal("SQLite file is not private", err)
		}
	}
	key := enroll(t, first, "retained")
	first.Close()
	second.Close()
	next := openRepo(t, path)
	if err := next.Bootstrap(t.Context()); err != nil {
		t.Fatal(err)
	}
	if worker, err := next.AuthenticateWorker(t.Context(), key); err != nil || worker.ID != "retained" {
		t.Fatal("restart lost identity", worker, err)
	}
}

func TestSQLiteUnsafeFileAndSchemaRejections(t *testing.T) {
	t.Run("relative", func(t *testing.T) {
		_, err := Open(t.Context(), "relative")
		failReason(t, err, "database_file_unavailable")
	})
	t.Run("missing", func(t *testing.T) {
		_, err := Open(t.Context(), filepath.Join(privatePath(t), "missing", "db"))
		failReason(t, err, "database_file_unavailable")
	})
	t.Run("open directory", func(t *testing.T) {
		path := privatePath(t)
		if err := os.Chmod(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		_, err := Open(t.Context(), path)
		failReason(t, err, "database_file_unavailable")
	})
	t.Run("open permissions", func(t *testing.T) {
		path := privatePath(t)
		if err := os.WriteFile(path+"-wal", []byte("unsafe"), 0o644); err != nil {
			t.Fatal(err)
		}
		_, err := Open(t.Context(), path)
		failReason(t, err, "database_file_unavailable")
	})
	t.Run("unrecognized schema", func(t *testing.T) {
		repo := openRepo(t, privatePath(t))
		execute(t, repo, "CREATE TABLE existing(data TEXT); INSERT INTO existing VALUES ('keep')")
		failReason(t, repo.Bootstrap(t.Context()), "database_schema_unrecognized")
		var value string
		if err := repo.db.QueryRowContext(t.Context(), "SELECT data FROM existing").Scan(&value); err != nil || value != "keep" {
			t.Fatal(value, err)
		}
	})
	t.Run("corrupt", func(t *testing.T) {
		path := privatePath(t)
		if err := os.WriteFile(path, []byte(strings.Repeat("unrecognized", 80)), 0o600); err != nil {
			t.Fatal(err)
		}
		repo := openRepo(t, path)
		failReason(t, repo.Bootstrap(t.Context()), "database_corrupt")
	})
	t.Run("ledger", func(t *testing.T) {
		repo := newRepo(t)
		execute(t, repo, "UPDATE aaa_schema_migrations SET version=2")
		if f := failReason(t, repo.Bootstrap(t.Context()), "schema_version_incompatible"); f.Observed != "2" || f.Expected != "1" {
			t.Fatal(f)
		}
		execute(t, repo, "UPDATE aaa_schema_migrations SET version=1,checksum='changed'")
		failReason(t, repo.Bootstrap(t.Context()), "migration_checksum_mismatch")
		failReason(t, repo.Ping(t.Context()), "migration_checksum_mismatch")
		execute(t, repo, "DROP TABLE aaa_schema_migrations")
		if f := failReason(t, repo.Ping(t.Context()), "sqlite_error"); f.Phase != "probe" || f.Code != "1" {
			t.Fatal(f)
		}
	})
}

func TestSQLiteWriterAndSnapshotCanOverlap(t *testing.T) {
	repo := newRepo(t)
	key := enroll(t, repo, "original")
	writer, err := repo.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	if _, err := writer.ExecContext(t.Context(), "UPDATE aaa_workers SET name='uncommitted'"); err != nil {
		t.Fatal(err)
	}
	snapshot, err := repo.Workers(t.Context())
	if err != nil || len(snapshot) != 1 || snapshot[0].Name != "original" {
		t.Fatal(snapshot, err)
	}
	_, err = repo.AuthenticateWorker(t.Context(), key)
	f := failReason(t, err, "database_busy")
	if f.Phase != "begin" || f.Outcome != "not_started" || f.Code != "5" {
		t.Fatal(f)
	}
	if err = writer.Rollback(); err != nil {
		t.Fatal(err)
	}
}

func TestSQLiteTransactionFailureOutcomes(t *testing.T) {
	repo := newRepo(t)
	execute(t, repo, "CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)")
	calls := 0
	err := repo.write(t.Context(), func(tx *sql.Tx) error {
		calls++
		_, err := tx.ExecContext(t.Context(), "INSERT INTO child VALUES (42)")
		return err
	})
	f := failReason(t, err, "sqlite_error")
	if calls != 1 || f.Phase != "commit" || f.Outcome != "uncertain" || f.Code != "787" {
		t.Fatal(calls, f)
	}
	var count int
	if err := repo.db.QueryRowContext(t.Context(), "SELECT count(*) FROM child").Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
	err = repo.write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(t.Context(), "INSERT INTO parent VALUES (42)"); err != nil {
			return err
		}
		return errors.New("deliberate statement failure")
	})
	f = failReason(t, err, "database_operation_failed")
	if f.Outcome != "rolled_back" || f.Phase != "statement" || !strings.Contains(f.Detail(), "deliberate") {
		t.Fatal(f.Detail())
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err = repo.write(ctx, func(*sql.Tx) error { t.Fatal("cancelled write ran"); return nil })
	f = failReason(t, err, "database_operation_failed")
	if f.Outcome != "not_started" {
		t.Fatal(f)
	}
}

func enroll(t *testing.T, repo *Repository, id string) [32]byte {
	t.Helper()
	code := sha256.Sum256([]byte("enrollment " + id))
	key := sha256.Sum256([]byte("key " + id))
	if _, err := repo.IssueEnrollment(t.Context(), "setup-"+id, code, 15*time.Minute); err != nil {
		t.Fatal(err, Classify(err).Detail())
	}
	record, entry, err := repo.ConsumeEnrollment(t.Context(), code, id, key, id)
	if err != nil || record.ID != id || entry.WorkerID != id || entry.ConsumedAt == nil {
		t.Fatal(record, entry, err, Classify(err).Detail())
	}
	return key
}
