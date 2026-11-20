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
	"strconv"
	"time"

	driver "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

//go:embed migrations/001_schema.sql
var schema string

const (
	SchemaVersion = 1
	Path          = "/var/lib/aaa-muse-ai/state/broker.sqlite3"
	BusyTimeoutMS = 2000
	EngineVersion = "3.54.1"
)

var checksum = fmt.Sprintf("%x", sha256.Sum256([]byte(schema)))

type Repository struct {
	db  *sql.DB
	now func() time.Time
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
	if err := secureFile(path); err != nil {
		return nil, &Failure{Reason: "database_file_unavailable", Phase: "open", cause: err}
	}
	query := url.Values{
		"_txlock": {"immediate"},
		"_pragma": {"busy_timeout(" + strconv.Itoa(BusyTimeoutMS) + ")", "foreign_keys(1)", "synchronous(FULL)"},
	}
	uri := url.URL{Scheme: "file", Path: path, RawQuery: query.Encode()}
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil, err
	}
	return &Repository{db: db, now: time.Now}, nil
}

func secureFile(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("absolute database file path required")
	}
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

func (r *Repository) Close() { _ = r.db.Close() }

func (r *Repository) databaseTime() time.Time { return r.now().UTC().Truncate(time.Microsecond) }

func (r *Repository) Ping(ctx context.Context) error {
	err := verifySchema(r.db.QueryRowContext(ctx, "SELECT count(*), max(version), max(checksum) FROM aaa_schema_migrations"))
	if err == nil {
		return nil
	}
	failure := Classify(err)
	failure.Phase = "probe"
	return failure
}

func verifySchema(row scanner) error {
	var count int
	var version sql.NullInt64
	var hash sql.NullString
	if err := row.Scan(&count, &version, &hash); err != nil {
		return err
	}
	if count != 1 || version.Int64 != SchemaVersion {
		return &Failure{Reason: "schema_version_incompatible", Expected: strconv.Itoa(SchemaVersion), Observed: strconv.FormatInt(version.Int64, 10)}
	}
	if hash.String != checksum {
		return &Failure{Reason: "migration_checksum_mismatch", Expected: checksum, Observed: hash.String}
	}
	return nil
}

func (r *Repository) Bootstrap(ctx context.Context) error {
	err := r.write(ctx, func(tx *sql.Tx) error {
		var objects, ledger int
		if err := tx.QueryRowContext(ctx, `SELECT count(*), count(CASE WHEN name='aaa_schema_migrations' AND type='table' THEN 1 END)
			FROM sqlite_schema WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\'`).Scan(&objects, &ledger); err != nil {
			return err
		}
		if objects == 0 {
			if _, err := tx.ExecContext(ctx, schema); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, "INSERT INTO aaa_schema_migrations(version,checksum) VALUES(?1,?2)", SchemaVersion, checksum)
			return err
		}
		if ledger == 0 {
			return &Failure{Reason: "database_schema_unrecognized", Expected: "SQLite schema ledger", Observed: "missing"}
		}
		return verifySchema(tx.QueryRowContext(ctx, "SELECT count(*), max(version), max(checksum) FROM aaa_schema_migrations"))
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
