package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const workerColumns = "id, name, registered_at, revoked_at, last_contact_at"

type scanner interface{ Scan(...any) error }

func scanWorker(row scanner) (w worker.Record, err error) {
	err = row.Scan(&w.ID, &w.Name, &w.RegisteredAt, &w.RevokedAt, &w.LastContactAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = &worker.Rejection{Reason: "worker_not_found"}
	}
	return w, err
}

func (r *Repository) workerTransaction(ctx context.Context, action func(pgx.Tx) error) (err error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		failure := Classify(err)
		failure.Outcome = "not_started"
		return failure
	}
	committed, commitAttempted := false, false
	defer func() {
		if committed {
			return
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer cancel()
		rollback := tx.Rollback(cleanup)
		outcome := "rolled_back"
		if commitAttempted || (rollback != nil && !errors.Is(rollback, pgx.ErrTxClosed)) {
			outcome = "uncertain"
		}
		var rejected *worker.Rejection
		if errors.As(err, &rejected) && outcome == "rolled_back" {
			rejected.Outcome = outcome
			return
		}
		var inferenceRejected *inference.Rejection
		if errors.As(err, &inferenceRejected) && outcome == "rolled_back" {
			inferenceRejected.Fields["transaction_outcome"] = outcome
			return
		}
		if rollback != nil && !errors.Is(rollback, pgx.ErrTxClosed) {
			err = errors.Join(err, rollback)
		}
		failure := Classify(err)
		failure.Outcome = outcome
		err = failure
	}()
	if err = action(tx); err != nil {
		return err
	}
	commitAttempted = true
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}

func (r *Repository) IssueEnrollment(ctx context.Context, id string, hash [32]byte, lifetime time.Duration) (e worker.Enrollment, err error) {
	err = r.workerTransaction(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `WITH issued AS (SELECT clock_timestamp() AS at)
			INSERT INTO aaa_worker_enrollments (id, code_hash, created_at, expires_at)
			SELECT $1, $2, at, at + ($3 * interval '1 second') FROM issued
			RETURNING id, created_at, expires_at`, id, hash[:], lifetime.Seconds()).Scan(&e.ID, &e.CreatedAt, &e.ExpiresAt)
	})
	return
}

func (r *Repository) ConsumeEnrollment(ctx context.Context, hash [32]byte, id string, credential [32]byte, name string) (w worker.Record, e worker.Enrollment, err error) {
	err = r.workerTransaction(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT id, created_at, expires_at, consumed_at, COALESCE(worker_id, '')
			FROM aaa_worker_enrollments WHERE code_hash=$1 FOR UPDATE`, hash[:]).Scan(&e.ID, &e.CreatedAt, &e.ExpiresAt, &e.ConsumedAt, &e.WorkerID)
		if errors.Is(err, pgx.ErrNoRows) {
			return &worker.Rejection{Reason: "enrollment_invalid"}
		}
		if err != nil {
			return err
		}
		var now time.Time
		if err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
			return err
		}
		if e.ConsumedAt != nil {
			return &worker.Rejection{Reason: "enrollment_used", Enrollment: e, WorkerID: e.WorkerID}
		}
		if !now.Before(e.ExpiresAt) {
			return &worker.Rejection{Reason: "enrollment_expired", Enrollment: e}
		}
		w, err = scanWorker(tx.QueryRow(ctx, `INSERT INTO aaa_workers (id, name, credential_hash, registered_at, last_contact_at)
			VALUES ($1, $2, $3, $4, $4) RETURNING `+workerColumns, id, name, credential[:], now))
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE aaa_worker_enrollments SET consumed_at=$2, worker_id=$3 WHERE id=$1", e.ID, now, id); err != nil {
			return err
		}
		e.ConsumedAt, e.WorkerID = &now, id
		return nil
	})
	return
}

func (r *Repository) AuthenticateWorker(ctx context.Context, hash [32]byte) (w worker.Record, err error) {
	err = r.workerTransaction(ctx, func(tx pgx.Tx) error {
		var err error
		w, err = scanWorker(tx.QueryRow(ctx, "SELECT "+workerColumns+" FROM aaa_workers WHERE credential_hash=$1 FOR UPDATE", hash[:]))
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
		return tx.QueryRow(ctx, "UPDATE aaa_workers SET last_contact_at=clock_timestamp() WHERE id=$1 RETURNING last_contact_at", w.ID).Scan(&w.LastContactAt)
	})
	return
}

func (r *Repository) Workers(ctx context.Context) (result []worker.Record, err error) {
	result = []worker.Record{}
	err = r.workerTransaction(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, "SELECT "+workerColumns+" FROM aaa_workers ORDER BY registered_at, id")
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
	err = r.workerTransaction(ctx, func(tx pgx.Tx) error {
		var err error
		before, err = scanWorker(tx.QueryRow(ctx, "SELECT "+workerColumns+" FROM aaa_workers WHERE id=$1 FOR UPDATE", id))
		if err != nil {
			return err
		}
		after, err = scanWorker(tx.QueryRow(ctx, "UPDATE aaa_workers SET name=$2 WHERE id=$1 RETURNING "+workerColumns, id, name))
		return err
	})
	return
}

func (r *Repository) RevokeWorker(ctx context.Context, id string) (before, w worker.Record, err error) {
	err = r.workerTransaction(ctx, func(tx pgx.Tx) error {
		var err error
		before, err = scanWorker(tx.QueryRow(ctx, "SELECT "+workerColumns+" FROM aaa_workers WHERE id=$1 FOR UPDATE", id))
		if err != nil {
			return err
		}
		w, err = scanWorker(tx.QueryRow(ctx, "UPDATE aaa_workers SET revoked_at=COALESCE(revoked_at, clock_timestamp()) WHERE id=$1 RETURNING "+workerColumns, id))
		return err
	})
	return
}
