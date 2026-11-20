package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const workerColumns = "id, name, registered_at, revoked_at, last_contact_at"

type scanner interface{ Scan(...any) error }

func instant(micros *int64) *time.Time {
	if micros == nil {
		return nil
	}
	t := time.UnixMicro(*micros).UTC()
	return &t
}

func scanWorker(row scanner) (w worker.Record, err error) {
	var registered int64
	var revoked, last *int64
	err = row.Scan(&w.ID, &w.Name, &registered, &revoked, &last)
	if errors.Is(err, sql.ErrNoRows) {
		return w, &worker.Rejection{Reason: "worker_not_found"}
	}
	if err == nil {
		w.RegisteredAt, w.RevokedAt, w.LastContactAt = time.UnixMicro(registered).UTC(), instant(revoked), instant(last)
	}
	return
}

func (r *Repository) write(ctx context.Context, action func(*sql.Tx) error) error {
	return r.transaction(ctx, nil, action)
}

func (r *Repository) read(ctx context.Context, action func(*sql.Tx) error) error {
	return r.transaction(ctx, &sql.TxOptions{ReadOnly: true}, action)
}

func (r *Repository) transaction(ctx context.Context, options *sql.TxOptions, action func(*sql.Tx) error) (err error) {
	tx, err := r.db.BeginTx(ctx, options)
	if err != nil {
		failure := Classify(err)
		failure.Phase, failure.Outcome = "begin", "not_started"
		return failure
	}
	defer tx.Rollback()
	if err = action(tx); err != nil {
		outcome := "rolled_back"
		if rollback := tx.Rollback(); rollback != nil {
			outcome = "uncertain"
			err = errors.Join(err, rollback)
		}
		var workerRejected *worker.Rejection
		var inferenceRejected *inference.Rejection
		switch {
		case outcome == "rolled_back" && errors.As(err, &workerRejected):
			workerRejected.Outcome = outcome
			return workerRejected
		case outcome == "rolled_back" && errors.As(err, &inferenceRejected):
			inferenceRejected.Fields["transaction_outcome"] = outcome
			return inferenceRejected
		default:
			failure := Classify(err)
			failure.Phase, failure.Outcome = "statement", outcome
			return failure
		}
	}
	if err = tx.Commit(); err != nil {
		failure := Classify(err)
		failure.Phase, failure.Outcome = "commit", "uncertain"
		return failure
	}
	return nil
}

func (r *Repository) IssueEnrollment(ctx context.Context, id string, hash [32]byte, lifetime time.Duration) (e worker.Enrollment, err error) {
	err = r.write(ctx, func(tx *sql.Tx) error {
		now := r.databaseTime()
		e.ID, e.CreatedAt, e.ExpiresAt = id, now, now.Add(lifetime)
		_, err := tx.ExecContext(ctx, "INSERT INTO aaa_worker_enrollments(id,code_hash,created_at,expires_at) VALUES(?1,?2,?3,?4)", id, hash[:], now.UnixMicro(), e.ExpiresAt.UnixMicro())
		return err
	})
	return
}

func (r *Repository) ConsumeEnrollment(ctx context.Context, hash [32]byte, id string, credential [32]byte, name string) (w worker.Record, e worker.Enrollment, err error) {
	err = r.write(ctx, func(tx *sql.Tx) error {
		var created, expires int64
		var consumed *int64
		err := tx.QueryRowContext(ctx, `SELECT id, created_at, expires_at, consumed_at, COALESCE(worker_id, '')
			FROM aaa_worker_enrollments WHERE code_hash=?1`, hash[:]).Scan(&e.ID, &created, &expires, &consumed, &e.WorkerID)
		if errors.Is(err, sql.ErrNoRows) {
			return &worker.Rejection{Reason: "enrollment_invalid"}
		}
		if err != nil {
			return err
		}
		e.CreatedAt, e.ExpiresAt, e.ConsumedAt = time.UnixMicro(created).UTC(), time.UnixMicro(expires).UTC(), instant(consumed)
		now := r.databaseTime()
		if e.ConsumedAt != nil {
			return &worker.Rejection{Reason: "enrollment_used", Enrollment: e, WorkerID: e.WorkerID}
		}
		if !now.Before(e.ExpiresAt) {
			return &worker.Rejection{Reason: "enrollment_expired", Enrollment: e}
		}
		w, err = scanWorker(tx.QueryRowContext(ctx, `INSERT INTO aaa_workers (id, name, credential_hash, registered_at, last_contact_at)
			VALUES (?1, ?2, ?3, ?4, ?4) RETURNING `+workerColumns, id, name, credential[:], now.UnixMicro()))
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE aaa_worker_enrollments SET consumed_at=?2, worker_id=?3 WHERE id=?1", e.ID, now.UnixMicro(), id); err != nil {
			return err
		}
		e.ConsumedAt, e.WorkerID = &now, id
		return nil
	})
	return
}

func (r *Repository) AuthenticateWorker(ctx context.Context, hash [32]byte) (w worker.Record, err error) {
	err = r.write(ctx, func(tx *sql.Tx) error {
		var err error
		w, err = scanWorker(tx.QueryRowContext(ctx, "SELECT "+workerColumns+" FROM aaa_workers WHERE credential_hash=?1", hash[:]))
		var rejected *worker.Rejection
		if errors.As(err, &rejected) {
			return &worker.Rejection{Reason: "invalid_worker_credential"}
		}
		if err != nil {
			return err
		}
		if w.RevokedAt != nil {
			return &worker.Rejection{Reason: "worker_revoked", WorkerID: w.ID}
		}
		now := r.databaseTime()
		if _, err = tx.ExecContext(ctx, "UPDATE aaa_workers SET last_contact_at=?2 WHERE id=?1", w.ID, now.UnixMicro()); err != nil {
			return err
		}
		w.LastContactAt = &now
		return nil
	})
	return
}

func (r *Repository) Workers(ctx context.Context) (result []worker.Record, err error) {
	result = []worker.Record{}
	err = r.read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, "SELECT "+workerColumns+" FROM aaa_workers ORDER BY registered_at, id")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			w, err := scanWorker(rows)
			if err != nil {
				return err
			}
			result = append(result, w)
		}
		return rows.Err()
	})
	return
}

func (r *Repository) RenameWorker(ctx context.Context, id, name string) (before, after worker.Record, err error) {
	err = r.write(ctx, func(tx *sql.Tx) error {
		var err error
		before, err = scanWorker(tx.QueryRowContext(ctx, "SELECT "+workerColumns+" FROM aaa_workers WHERE id=?1", id))
		if err != nil {
			return err
		}
		after, err = scanWorker(tx.QueryRowContext(ctx, "UPDATE aaa_workers SET name=?2 WHERE id=?1 RETURNING "+workerColumns, id, name))
		return err
	})
	return
}

func (r *Repository) RevokeWorker(ctx context.Context, id string) (before, after worker.Record, err error) {
	err = r.write(ctx, func(tx *sql.Tx) error {
		var err error
		before, err = scanWorker(tx.QueryRowContext(ctx, "SELECT "+workerColumns+" FROM aaa_workers WHERE id=?1", id))
		if err != nil {
			return err
		}
		after, err = scanWorker(tx.QueryRowContext(ctx, "UPDATE aaa_workers SET revoked_at=COALESCE(revoked_at, ?2) WHERE id=?1 RETURNING "+workerColumns, id, r.databaseTime().UnixMicro()))
		return err
	})
	return
}
