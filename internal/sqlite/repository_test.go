package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
	"golang.org/x/sys/unix"
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
		{nextPullJob, "aaa_pull_queue_head", []any{"worker", 2, time.Now().UnixMicro(), 0, ""}},
		{nextPullJob, "aaa_pull_queue_head", []any{"", 0, time.Now().UnixMicro(), 0, ""}},
		{nextModelPullJob, "aaa_pull_queue_model_head", []any{"worker", 0, time.Now().UnixMicro(), 0, "after"}},
		{betterPullWorkers, "aaa_weekly_usage_rank", []any{80, time.Now().Add(-2 * time.Minute).UnixMicro(), time.Now().UnixMicro(), "1", "", "", worker.UpdateContract}},
		{exhaustedPullWorkers, "aaa_weekly_usage_rank", []any{time.Now().Add(-2 * time.Minute).UnixMicro(), time.Now().UnixMicro()}},
		{heldPullJob, "sqlite_autoindex_aaa_worker_slots_1", []any{"worker"}},
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
				head := check.query == nextPullJob || check.query == nextModelPullJob
				if strings.HasPrefix(detail, "SEARCH ") && strings.Contains(detail, check.index) {
					seek = !head || strings.Contains(detail, "(target=? AND capability=? AND shift=? AND bucket=?")
				} else if strings.HasPrefix(detail, "SCAN aaa_") || strings.HasPrefix(detail, "SCAN job") ||
					(strings.Contains(detail, "TEMP B-TREE") && ((!head && check.query != betterPullWorkers) || parent != 0)) {
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
			winner, _, err := pickPullJob(t.Context(), tx, check.worker, "1", check.kind, now, &inference.PullTiming{})
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
		winner, _, err := pickPullJob(t.Context(), tx, "worker", "1", 0, now, &inference.PullTiming{})
		if err == nil && winner.job != "backlog-1" {
			t.Errorf("winner after target changes = %s, want backlog-1", winner.job)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestWeeklyUsageMigrationKeepsVersionFourQueueAndReceipt(t *testing.T) {
	repo := openRepo(t, privatePath(t))
	for i := 0; i < 4; i++ {
		execute(t, repo, migrations[i])
		execute(t, repo, "INSERT INTO aaa_schema_migrations(version,checksum) VALUES(?1,?2)", i+1, migrationChecksums[i])
	}
	now := time.Now().UTC().Truncate(time.Second)
	stamp := now.UnixMicro()
	execute(t, repo, "INSERT INTO aaa_workers(id,name,credential_hash,registered_at) VALUES('old-worker','old-worker',zeroblob(32),?1)", stamp)
	execute(t, repo, `INSERT INTO aaa_worker_polls(worker_id,sequence,scheduled_at,last_poll_at,input_hash,result,previous_pin)
		VALUES('old-worker',7,?1,?1,'old-hash',X'7B226A6F62223A6E756C6C7D','')`, stamp)
	execute(t, repo, `INSERT INTO aaa_conversations(id,client_id,session_id,created_at,pending_call_id,current_request_id,data)
		VALUES('conversation','client','session',?1,'','candidate',X'7B7D')`, stamp)
	for _, id := range []string{"older-trial", "candidate", "held"} {
		execute(t, repo, `INSERT INTO aaa_experiments(id,worker_id,state,deadline_at,created_at,conversation_id,current_job_id,data)
			VALUES(?1,'old-worker','queued',?2,?3,'conversation',?1,X'7B7D')`, id, now.Add(5*time.Minute).UnixMicro(), stamp)
		execute(t, repo, `INSERT INTO aaa_inference_jobs(id,worker_id,experiment_id,state,held,created_at,has_media,data,context,deadline_at,capability)
			VALUES(?1,'old-worker',?1,CASE WHEN ?1='held' THEN 'claimed' ELSE 'queued' END,?1='held',?2,0,X'7B7D',X'7B7D',?3,0)`,
			id, stamp, now.Add(5*time.Minute).UnixMicro())
	}
	execute(t, repo, `INSERT INTO aaa_model_requests(id,conversation_id,client_id,response_id,created_at,replay_hash,incomplete_delivery,data)
		VALUES('candidate','conversation','client','response',?1,'old-replay',0,X'7B7D')`, stamp)
	if err := repo.Bootstrap(t.Context()); err != nil {
		t.Fatal(err, Classify(err).Detail())
	}
	if err := repo.write(t.Context(), func(tx *sql.Tx) error {
		sample, err := readWeeklyUsage(t.Context(), tx, "old-worker")
		if err != nil || sample != nil {
			t.Fatalf("migration invented a quota reading: %v %v", sample, err)
		}
		var sequence int
		var hash, receipt string
		if err := tx.QueryRowContext(t.Context(), "SELECT sequence,input_hash,result FROM aaa_worker_polls WHERE worker_id='old-worker'").
			Scan(&sequence, &hash, &receipt); err != nil || sequence != 7 || hash != "old-hash" || receipt != `{"job":null}` {
			t.Fatalf("migration changed a pull receipt: %d %s %s %v", sequence, hash, receipt, err)
		}
		var held bool
		if err := tx.QueryRowContext(t.Context(), heldPullJob, "old-worker").Scan(&held); err != nil || !held {
			t.Fatalf("migration lost a held job: %v", err)
		}
		if _, err := recordWeeklyUsage(t.Context(), tx, "old-worker", &worker.WeeklyUsage{UsedPercent: 100, ObservedAt: now}, now, now); err != nil {
			return err
		}
		pick, previous, err := pickPullJob(t.Context(), tx, "other", "1", 0, now, &inference.PullTiming{})
		if pick.job != "candidate" || previous != "old-worker" {
			t.Fatalf("pre-upgrade client job not selectable or probe transferred: %v %s", pick, previous)
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
		execute(t, repo, "UPDATE aaa_schema_migrations SET version=?1 WHERE version=?2", SchemaVersion+1, SchemaVersion)
		if f := failReason(t, repo.Bootstrap(t.Context()), "schema_version_incompatible"); f.Observed != strconv.Itoa(SchemaVersion+1) || f.Expected != strconv.Itoa(SchemaVersion) {
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

func TestDatabaseOpenHonorsDirectoryOwnershipHandoff(t *testing.T) {
	path := privatePath(t)
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	fd := int(dir.Fd())
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	if repo, err := Open(t.Context(), path); repo != nil || err == nil || Classify(err).Phase != "mount_lock" {
		t.Fatalf("direct broker disturbed a directory ownership handoff: %v, %v", repo, err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("blocked broker initialized the database", err)
	}
	if err = unix.Flock(fd, unix.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	repo, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); !errors.Is(err, unix.EWOULDBLOCK) {
		repo.Close()
		t.Fatal("open direct broker failed to retain the shared lock", err)
	}
	repo.Close()
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal("closed broker retained its shared lock", err)
	}
}

func TestMigrationSixCarriesExistingHoldAndFencesEveryLane(t *testing.T) {
	repo := openRepo(t, privatePath(t))
	for i := range 5 {
		execute(t, repo, migrations[i])
		execute(t, repo, "INSERT INTO aaa_schema_migrations(version,checksum) VALUES(?1,?2)", i+1, migrationChecksums[i])
	}
	enroll(t, repo, "worker")
	ref := seedRequest(t, repo, "pre-migration", "worker", false)
	execute(t, repo, "UPDATE aaa_inference_jobs SET held=1,state='claimed' WHERE id=?1", ref.JobID)
	if err := repo.Bootstrap(t.Context()); err != nil {
		t.Fatal(Classify(err).Detail())
	}
	slot := func(lane, id string) {
		t.Helper()
		var gotLane, gotID string
		if err := repo.db.QueryRowContext(t.Context(), "SELECT lane,item_id FROM aaa_worker_slots WHERE worker_id='worker'").Scan(&gotLane, &gotID); err != nil || gotLane != lane || gotID != id {
			t.Fatalf("slot = %s/%s, want %s/%s, error %v", gotLane, gotID, lane, id, err)
		}
	}
	slot("inference", ref.JobID)
	now := time.Now().UTC().Truncate(time.Microsecond)
	record := worker.ControlRecord{ControlItem: worker.ControlItem{ID: "op", WorkerID: "worker", Kind: worker.Doctor, State: "claimed",
		Held: true, Claim: &worker.ControlGrant{ClaimID: "op-claim", Generation: 1}, CreatedAt: now, ClaimedAt: &now, DeadlineAt: now.Add(time.Minute)}}
	save := func(lane string, record worker.ControlRecord) error {
		return repo.write(t.Context(), func(tx *sql.Tx) error { return saveControl(t.Context(), tx, lane, record) })
	}
	if err := save(worker.WorkerOp, record); err == nil {
		t.Fatal("worker operation acquired a slot occupied by migrated inference")
	}
	slot("inference", ref.JobID)
	execute(t, repo, "UPDATE aaa_inference_jobs SET state='interrupted',held=0 WHERE id=?1", ref.JobID)
	if err := save(worker.WorkerOp, record); err != nil {
		t.Fatal(err)
	}
	slot(worker.WorkerOp, record.ID)
	record.ID, record.Kind, record.Prompt = "agent-task", "", "fixture"
	if err := save(worker.AgentTask, record); err == nil {
		t.Fatal("agent task acquired a slot occupied by a worker operation")
	}
	execute(t, repo, "DELETE FROM aaa_worker_ops WHERE id='op'")
	if err := save(worker.AgentTask, record); err != nil {
		t.Fatal(err)
	}
	slot(worker.AgentTask, record.ID)
	if _, err := repo.db.ExecContext(t.Context(), "UPDATE aaa_inference_jobs SET held=1 WHERE id=?1", ref.JobID); err == nil {
		t.Fatal("inference acquired a slot occupied by a task")
	}
	record.Held, record.State = false, "completed"
	if err := save(worker.AgentTask, record); err != nil {
		t.Fatal(err)
	}
	execute(t, repo, "UPDATE aaa_inference_jobs SET state='claimed',held=1 WHERE id=?1", ref.JobID)
	slot("inference", ref.JobID)
}
