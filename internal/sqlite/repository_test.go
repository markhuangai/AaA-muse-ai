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

func TestNativePullWinnerAndDueWorkUseSeekIndexes(t *testing.T) {
	repo := newRepo(t)
	for _, check := range []struct {
		query, index string
		parameters   []any
	}{
		{nextPullJob, "aaa_pull_queue_head", []any{"worker", 2, time.Now().UnixMicro()}},
		{nextPullJob, "aaa_pull_queue_head", []any{"", 0, time.Now().UnixMicro()}},
		{heldPullJob, "aaa_worker_single_held_turn", []any{"worker"}},
		{duePullExperiments, "aaa_experiments_due", []any{time.Now().UnixMicro()}},
		{duePullPins, "aaa_queued_pins_due", []any{time.Now().UnixMicro()}},
	} {
		t.Run(check.index, func(t *testing.T) {
			rows, err := repo.db.QueryContext(t.Context(), "EXPLAIN QUERY PLAN "+check.query, check.parameters...)
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			var seek bool
			for rows.Next() {
				var node, parent, unused int
				var detail string
				if err := rows.Scan(&node, &parent, &unused, &detail); err != nil {
					t.Fatal(err)
				}
				if strings.HasPrefix(detail, "SEARCH ") && strings.Contains(detail, check.index) {
					seek = check.query != nextPullJob || strings.Contains(detail, "(target=? AND capability=? AND shift=? AND bucket=?)")
				} else if strings.HasPrefix(detail, "SCAN aaa_") || strings.HasPrefix(detail, "SCAN job") ||
					(strings.Contains(detail, "TEMP B-TREE") && (check.query != nextPullJob || parent != 0)) {
					t.Fatalf("native lookup used unbounded work: %s", detail)
				}
			}
			if err := rows.Err(); err != nil || !seek {
				t.Fatalf("expected indexed seek on %s: %v", check.index, err)
			}
		})
	}
}

func TestNativePullWinnerSkipsExpiredQueueAndPreservesOrder(t *testing.T) {
	repo := newRepo(t)
	now := time.Unix(100, 0)
	stamp := now.UnixMicro()
	execute(t, repo, "INSERT INTO aaa_workers(id,name,credential_hash,registered_at) VALUES('worker','worker',zeroblob(32),?1)", stamp)
	execute(t, repo, `WITH RECURSIVE rows(number) AS (VALUES(1) UNION ALL SELECT number+1 FROM rows WHERE number<4096)
		INSERT INTO aaa_experiments(id,state,deadline_at,created_at,conversation_id,current_job_id,data)
		SELECT 'backlog-'||number,'queued',CASE WHEN number%2=0 THEN ?1-number ELSE ?1+number END,
		CASE WHEN number%2=0 THEN number ELSE ?1+number END,'backlog','backlog-'||number,X'7B7D' FROM rows`, stamp)
	execute(t, repo, `INSERT INTO aaa_inference_jobs(id,worker_id,experiment_id,state,held,created_at,has_media,data,context,deadline_at,capability)
		SELECT id,'worker',id,'queued',0,created_at,0,X'7B7D',X'7B7D',deadline_at,0 FROM aaa_experiments`)
	for _, entry := range []struct {
		id       string
		target   any
		created  int64
		deadline int64
		kind     int
	}{
		{"open-first", nil, stamp - 90, stamp + 1, 0},
		{"target-late", "worker", stamp - 40, stamp + 1, 0},
		{"target-first-b", "worker", stamp - 50, stamp + 2, 0},
		{"target-first-a", "worker", stamp - 50, stamp + 3, 0},
		{"target-needs-media", "worker", stamp - 60, stamp + 3, 1},
	} {
		execute(t, repo, `INSERT INTO aaa_experiments(id,worker_id,state,deadline_at,created_at,conversation_id,current_job_id,data)
			VALUES(?1,?2,'queued',?3,?4,?1,?1,X'7B7D')`, entry.id, entry.target, entry.deadline, entry.created)
		execute(t, repo, `INSERT INTO aaa_inference_jobs(id,worker_id,experiment_id,state,held,created_at,has_media,data,context,deadline_at,capability)
			VALUES(?1,?2,?1,'queued',0,?3,?4!=0,X'7B7D',X'7B7D',?5,?4)`, entry.id, entry.target, entry.created, entry.kind, entry.deadline)
	}
	for _, check := range []struct {
		worker string
		kind   int
		want   string
	}{
		{"worker", 0, "target-first-a"},
		{"worker", 1, "target-needs-media"},
		{"other-worker", 1, "open-first"},
	} {
		if err := repo.read(t.Context(), func(tx *sql.Tx) error {
			winner, err := pickPullJob(t.Context(), tx, check.worker, check.kind, now)
			if err == nil && winner.job != check.want {
				t.Errorf("winner for %s/%d = %s, want %s", check.worker, check.kind, winner.job, check.want)
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	execute(t, repo, "UPDATE aaa_inference_jobs SET worker_id=NULL WHERE id='target-first-a'")
	execute(t, repo, "UPDATE aaa_inference_jobs SET state='claimed',held=1 WHERE id='target-first-b'")
	execute(t, repo, "DELETE FROM aaa_inference_jobs WHERE id='target-late'")
	if err := repo.read(t.Context(), func(tx *sql.Tx) error {
		winner, err := pickPullJob(t.Context(), tx, "worker", 0, now)
		if err == nil && winner.job != "backlog-1" {
			t.Errorf("winner after target changes = %s, want backlog-1", winner.job)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSQLiteBootstrapConnectionSettingsAndRestart(t *testing.T) {
	path := privatePath(t)
	first, second := openRepo(t, path), openRepo(t, path)
	type bootstrapResult struct {
		repo *Repository
		err  error
	}
	done := make(chan bootstrapResult, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for _, repo := range []*Repository{first, second} {
		go func() {
			ready.Done()
			ready.Wait()
			done <- bootstrapResult{repo, repo.Bootstrap(t.Context())}
		}()
	}
	// Concurrent WAL activation can report SQLITE_BUSY before either attempt observes WAL mode.
	for _, result := range [2]bootstrapResult{<-done, <-done} {
		if result.err == nil {
			continue
		}
		if Classify(result.err).Reason != "database_busy" {
			t.Fatal(result.err, Classify(result.err).Detail())
		}
		if err := result.repo.Bootstrap(t.Context()); err != nil {
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

func TestSQLiteNativeCutoverRejectsPopulatedLegacyStore(t *testing.T) {
	path := privatePath(t)
	original := openRepo(t, path)
	execute(t, original, schema)
	execute(t, original, "INSERT INTO aaa_schema_migrations(version,checksum) VALUES(1,?1)", migrationChecksums[0])
	execute(t, original, "PRAGMA journal_mode=WAL")
	credential := enroll(t, original, "version-one-worker")
	original.Close()

	first, second := openRepo(t, path), openRepo(t, path)
	start := make(chan struct{})
	done := make(chan error, 2)
	for _, repo := range []*Repository{first, second} {
		go func() { <-start; done <- repo.Bootstrap(t.Context()) }()
	}
	close(start)
	for range 2 {
		failReason(t, <-done, "fresh_store_required")
	}
	for _, repo := range []*Repository{first, second} {
		failReason(t, repo.Ping(t.Context()), "schema_version_incompatible")
		record, err := repo.AuthenticateWorker(t.Context(), credential)
		if err != nil || record.ID != "version-one-worker" {
			t.Fatal("refused migration modified existing worker identity", err)
		}
	}
	var migrations int
	if err := first.db.QueryRowContext(t.Context(), "SELECT count(*) FROM aaa_schema_migrations").Scan(&migrations); err != nil || migrations != 1 {
		t.Fatal("refused migration modified legacy ledger", migrations, err)
	}
}

func TestSQLiteNativeMigrationChecksums(t *testing.T) {
	first := newRepo(t)
	for version := 1; version <= SchemaVersion; version++ {
		execute(t, first, "UPDATE aaa_schema_migrations SET checksum='changed' WHERE version=?1", version)
		failReason(t, first.Ping(t.Context()), "migration_checksum_mismatch")
		failReason(t, first.Bootstrap(t.Context()), "migration_checksum_mismatch")
		execute(t, first, "UPDATE aaa_schema_migrations SET checksum=?2 WHERE version=?1", version, migrationChecksums[version-1])
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
		execute(t, repo, "UPDATE aaa_schema_migrations SET version=5 WHERE version=4")
		if f := failReason(t, repo.Bootstrap(t.Context()), "schema_version_incompatible"); f.Observed != "5" || f.Expected != "4" {
			t.Fatal(f)
		}
		execute(t, repo, "UPDATE aaa_schema_migrations SET checksum='changed' WHERE version=1")
		failReason(t, repo.Bootstrap(t.Context()), "migration_checksum_mismatch")
		failReason(t, repo.Ping(t.Context()), "migration_checksum_mismatch")
		execute(t, repo, "DELETE FROM aaa_schema_migrations")
		failReason(t, repo.Ping(t.Context()), "schema_version_incompatible")
		failReason(t, repo.Bootstrap(t.Context()), "schema_version_incompatible")
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
