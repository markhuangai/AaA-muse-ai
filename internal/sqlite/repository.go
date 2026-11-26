package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"golang.org/x/sys/unix"
	driver "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

//go:embed migrations/001_schema.sql
var schema string

//go:embed migrations/002_portal_sessions.sql
var portalSchema string

//go:embed migrations/003_native_pull.sql
var pullSchema string

//go:embed migrations/004_worker_updates.sql
var workerUpdateSchema string

//go:embed migrations/005_weekly_usage.sql
var weeklyUsageSchema string

//go:embed migrations/006_worker_control_lanes.sql
var workerControlSchema string

const (
	SchemaVersion = 6
	Path          = "/var/lib/aaa-muse-ai/state/broker.sqlite3"
	BusyTimeoutMS = 2000
	EngineVersion = "3.54.1"
)

var migrations = [SchemaVersion]string{schema, portalSchema, pullSchema, workerUpdateSchema, weeklyUsageSchema, workerControlSchema}
var migrationChecksums = func() (result [SchemaVersion]string) {
	for index, migration := range migrations {
		result[index] = fmt.Sprintf("%x", sha256.Sum256([]byte(migration)))
	}
	return
}()

type Repository struct {
	db, readDB *sql.DB
	writeSem   chan struct{}
	now        func() time.Time
	state      *os.File
}

type Failure struct {
	Reason, Code, Expected, Observed string
	Phase, Outcome                   string
	cause                            error
}

func (f *Failure) Error() string { return f.Reason }
func (f *Failure) Unwrap() error { return f.cause }
func (f *Failure) Detail() string {
	if f.cause == nil {
		return f.Reason
	}
	return f.cause.Error()
}

func Classify(err error) *Failure {
	var existing *Failure
	if errors.As(err, &existing) {
		return existing
	}
	f := &Failure{Reason: "database_operation_failed", cause: err}
	var failure *driver.Error
	if errors.As(err, &failure) {
		f.Code = strconv.Itoa(failure.Code())
		switch failure.Code() & 0xff {
		case sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED:
			f.Reason = "database_busy"
		case sqlite3.SQLITE_CANTOPEN, sqlite3.SQLITE_READONLY, sqlite3.SQLITE_IOERR, sqlite3.SQLITE_FULL, sqlite3.SQLITE_PERM:
			f.Reason = "database_unavailable"
		case sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB:
			f.Reason = "database_corrupt"
		default:
			f.Reason = "sqlite_error"
		}
	} else if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrPermission) || errors.Is(err, os.ErrNotExist) {
		f.Reason = "database_unavailable"
	}
	return f
}

func Open(ctx context.Context, path string) (*Repository, error) {
	return OpenWithClock(ctx, path, time.Now)
}

func OpenWithClock(_ context.Context, path string, now func() time.Time) (*Repository, error) {
	if !filepath.IsAbs(path) {
		return nil, &Failure{Reason: "database_file_unavailable", Phase: "open", cause: errors.New("absolute database file path required")}
	}
	state, err := os.OpenFile(filepath.Dir(path), os.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, &Failure{Reason: "database_file_unavailable", Phase: "open", cause: err}
	}
	if err = unix.Flock(int(state.Fd()), unix.LOCK_SH|unix.LOCK_NB); err != nil {
		_ = state.Close()
		return nil, &Failure{Reason: "database_busy", Phase: "mount_lock", cause: err}
	}
	if err = secureFile(path); err != nil {
		_ = state.Close()
		return nil, &Failure{Reason: "database_file_unavailable", Phase: "open", cause: err}
	}
	query := url.Values{
		"_txlock": {"immediate"},
		"_pragma": {"busy_timeout(" + strconv.Itoa(BusyTimeoutMS) + ")", "foreign_keys(1)", "synchronous(FULL)"},
	}
	uri := url.URL{Scheme: "file", Path: path, RawQuery: query.Encode()}
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		_ = state.Close()
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	query.Set("_txlock", "deferred")
	query.Add("_pragma", "query_only(1)")
	uri.RawQuery = query.Encode()
	readDB, err := sql.Open("sqlite", uri.String())
	if err != nil {
		_ = db.Close()
		_ = state.Close()
		return nil, err
	}
	readDB.SetMaxOpenConns(min(max(4, runtime.NumCPU()), 8))
	readDB.SetMaxIdleConns(4)
	return &Repository{db: db, readDB: readDB, writeSem: make(chan struct{}, 1), now: now, state: state}, nil
}

func secureFile(path string) error {
	dir, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return err
	}
	if !dir.IsDir() || dir.Mode().Perm() != 0o700 {
		return errors.New("database directory must be private with mode 0700")
	}
	for _, name := range []string{path, path + "-wal", path + "-shm"} {
		info, err := os.Lstat(name)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
			return errors.New("database and sidecar files must be regular with mode 0600")
		}
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	return file.Close()
}

func (r *Repository) Close() {
	_ = r.readDB.Close()
	_ = r.db.Close()
	_ = r.state.Close()
}

func (r *Repository) databaseTime() time.Time { return r.now().UTC().Truncate(time.Microsecond) }

func (r *Repository) Ping(ctx context.Context) error {
	version, err := verifySchema(r.readDB.QueryContext(ctx, "SELECT version, checksum FROM aaa_schema_migrations ORDER BY version"))
	if err == nil && version != SchemaVersion {
		err = incompatibleSchema(version)
	}
	if err == nil {
		return nil
	}
	failure := Classify(err)
	failure.Phase = "probe"
	return failure
}

func incompatibleSchema(version int) *Failure {
	return &Failure{Reason: "schema_version_incompatible", Expected: strconv.Itoa(SchemaVersion), Observed: strconv.Itoa(version)}
}

func verifySchema(rows *sql.Rows, err error) (int, error) {
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	current := 0
	for rows.Next() {
		var version int
		var checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			return 0, err
		}
		if version != current+1 || version > SchemaVersion {
			return 0, incompatibleSchema(version)
		}
		if expected := migrationChecksums[version-1]; checksum != expected {
			return 0, &Failure{Reason: "migration_checksum_mismatch", Expected: expected, Observed: checksum}
		}
		current = version
	}
	return current, rows.Err()
}

func (r *Repository) Bootstrap(ctx context.Context) error {
	err := r.write(ctx, func(tx *sql.Tx) error {
		var objects, ledger int
		if err := tx.QueryRowContext(ctx, `SELECT count(*), count(CASE WHEN name='aaa_schema_migrations' AND type='table' THEN 1 END)
			FROM sqlite_schema WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\'`).Scan(&objects, &ledger); err != nil {
			return err
		}
		if objects != 0 && ledger == 0 {
			return &Failure{Reason: "database_schema_unrecognized", Expected: "SQLite schema ledger", Observed: "missing"}
		}
		current := 0
		if ledger != 0 {
			var latest int
			if err := tx.QueryRowContext(ctx, "SELECT COALESCE(max(version),0) FROM aaa_schema_migrations").Scan(&latest); err != nil {
				return err
			}
			if latest == 1 || latest == 2 {
				return &Failure{Reason: "fresh_store_required", Expected: "empty major-1 store", Observed: "legacy schema " + strconv.Itoa(latest)}
			}
			var err error
			current, err = verifySchema(tx.QueryContext(ctx, "SELECT version, checksum FROM aaa_schema_migrations ORDER BY version"))
			if err != nil {
				return err
			}
			if current == 0 {
				return incompatibleSchema(current)
			}
		}
		for index := current; index < SchemaVersion; index++ {
			if _, err := tx.ExecContext(ctx, migrations[index]); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "INSERT INTO aaa_schema_migrations(version,checksum) VALUES(?1,?2)", index+1, migrationChecksums[index]); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	var mode string
	if err = r.db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err == nil && mode != "wal" {
		err = r.db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&mode)
	}
	if err != nil {
		failure := Classify(err)
		failure.Phase = "journal_mode"
		return failure
	}
	if mode != "wal" {
		return &Failure{Reason: "database_journal_mode_invalid", Phase: "journal_mode", Expected: "wal", Observed: mode}
	}
	return nil
}
