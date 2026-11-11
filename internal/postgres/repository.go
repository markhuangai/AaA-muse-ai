package postgres

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"net"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

const SchemaVersion = 5
const migrationLock int64 = 0x4141414d555345

type Pool interface {
	Ping(context.Context) error
	Begin(context.Context) (pgx.Tx, error)
	Close()
}
type Repository struct{ pool Pool }

type Failure struct {
	Reason, SQLState, Expected, Observed string
	Outcome                              string
	cause                                error
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
	var f *Failure
	if errors.As(err, &f) {
		return f
	}
	f = &Failure{Reason: "database_operation_failed", cause: err}
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		f.SQLState = pe.Code
		switch pe.Code {
		case "57P01", "57P03":
			f.Reason = "database_unavailable"
		case "28P01", "28000":
			f.Reason = "database_authentication_failed"
		case "3D000":
			f.Reason = "database_missing"
		default:
			f.Reason = "postgres_error"
		}
		return f
	}
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &ne) {
		f.Reason = "database_unavailable"
	}
	return f
}

func Open(ctx context.Context, url string) (*Repository, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, &Failure{Reason: "database_configuration_invalid", cause: err}
	}
	return New(pool), nil
}
func New(pool Pool) *Repository                      { return &Repository{pool: pool} }
func (r *Repository) Close()                         { r.pool.Close() }
func (r *Repository) Ping(ctx context.Context) error { return r.pool.Ping(ctx) }

func (r *Repository) Bootstrap(ctx context.Context) error {
	if err := r.pool.Ping(ctx); err != nil {
		return Classify(err)
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Classify(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", migrationLock); err != nil {
		return Classify(err)
	}
	var scripts [SchemaVersion][]byte
	var checksums [SchemaVersion]string
	for i, path := range []string{"migrations/001_initial.sql", "migrations/002_worker_identities.sql", "migrations/003_inference.sql", "migrations/004_canonical_history.sql", "migrations/005_routing.sql"} {
		scripts[i], err = migrations.ReadFile(path)
		if err != nil {
			return err
		}
		hash := sha256.Sum256(scripts[i])
		checksums[i] = hex.EncodeToString(hash[:])
	}
	if _, err = tx.Exec(ctx, string(scripts[0])); err != nil {
		return Classify(err)
	}
	rows, err := tx.Query(ctx, "SELECT version, checksum FROM aaa_schema_migrations ORDER BY version")
	if err != nil {
		return Classify(err)
	}
	applied := 0
	for rows.Next() {
		var version int
		var actual string
		if err = rows.Scan(&version, &actual); err != nil {
			rows.Close()
			return Classify(err)
		}
		if version < 1 || version > SchemaVersion {
			rows.Close()
			return &Failure{Reason: "schema_version_incompatible", Expected: fmt.Sprint(SchemaVersion), Observed: fmt.Sprint(version)}
		}
		if version != applied+1 {
			rows.Close()
			return &Failure{Reason: "schema_version_incompatible", Expected: fmt.Sprint(applied + 1), Observed: fmt.Sprint(version)}
		}
		if actual != checksums[version-1] {
			rows.Close()
			return &Failure{Reason: "migration_checksum_mismatch", Expected: checksums[version-1], Observed: actual}
		}
		applied++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Classify(err)
	}
	for i := applied; i < SchemaVersion; i++ {
		if i > 0 {
			if _, err = tx.Exec(ctx, string(scripts[i])); err != nil {
				return Classify(err)
			}
		}
		if _, err = tx.Exec(ctx, "INSERT INTO aaa_schema_migrations (version, checksum) VALUES ($1, $2)", i+1, checksums[i]); err != nil {
			return Classify(err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Classify(err)
	}
	return nil
}
