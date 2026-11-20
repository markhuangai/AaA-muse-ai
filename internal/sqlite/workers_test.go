package sqlite

import (
	"crypto/sha256"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func workerReason(t *testing.T, err error, reason string) {
	t.Helper()
	var rejected *worker.Rejection
	if !errors.As(err, &rejected) || rejected.Reason != reason || rejected.Outcome != "rolled_back" {
		t.Fatal("worker rejection", reason, err)
	}
}

func TestWorkerEnrollmentAndRevocation(t *testing.T) {
	repo := newRepo(t)
	start := time.Date(2026, 11, 20, 1, 2, 3, 456789123, time.UTC)
	repo.now = func() time.Time { return start }
	code := sha256.Sum256([]byte("single use"))
	key := sha256.Sum256([]byte("credential"))
	ctx := t.Context()
	e, err := repo.IssueEnrollment(ctx, "setup", code, time.Minute)
	if err != nil || e.CreatedAt.Nanosecond() != 456789000 || e.ExpiresAt.Sub(e.CreatedAt) != time.Minute {
		t.Fatal(e, err)
	}
	_, err = repo.IssueEnrollment(ctx, "duplicate", code, time.Minute)
	failReason(t, err, "sqlite_error")
	w, e, err := repo.ConsumeEnrollment(ctx, code, "worker", key, "First")
	if err != nil || w.RegisteredAt != e.CreatedAt || w.RevokedAt != nil {
		t.Fatal(w, e, err)
	}
	_, _, err = repo.ConsumeEnrollment(ctx, code, "duplicate", key, "Second")
	workerReason(t, err, "enrollment_used")
	_, _, err = repo.ConsumeEnrollment(ctx, key, "invalid", key, "Third")
	workerReason(t, err, "enrollment_invalid")
	if _, err = repo.IssueEnrollment(ctx, "expired", key, time.Second); err != nil {
		t.Fatal(err)
	}
	start = start.Add(time.Second)
	_, _, err = repo.ConsumeEnrollment(ctx, key, "late", key, "Late")
	workerReason(t, err, "enrollment_expired")
	_, err = repo.AuthenticateWorker(ctx, code)
	workerReason(t, err, "invalid_worker_credential")
	w, err = repo.AuthenticateWorker(ctx, key)
	if err != nil || w.LastContactAt == nil || !w.LastContactAt.Equal(start.Truncate(time.Microsecond)) {
		t.Fatal(w, err)
	}
	before, after, err := repo.RenameWorker(ctx, w.ID, "Renamed")
	if err != nil || before.Name != "First" || after.Name != "Renamed" {
		t.Fatal(before, after, err)
	}
	_, _, err = repo.RenameWorker(ctx, "missing", "Renamed")
	workerReason(t, err, "worker_not_found")
	_, after, err = repo.RevokeWorker(ctx, w.ID)
	if err != nil || after.RevokedAt == nil {
		t.Fatal(after, err)
	}
	_, err = repo.AuthenticateWorker(ctx, key)
	workerReason(t, err, "worker_revoked")
	start = start.Add(time.Second)
	_, revoked, err := repo.RevokeWorker(ctx, w.ID)
	if err != nil || !after.RevokedAt.Equal(*revoked.RevokedAt) {
		t.Fatal(revoked, err)
	}
	_, _, err = repo.RevokeWorker(ctx, "missing")
	workerReason(t, err, "worker_not_found")
	list, err := repo.Workers(ctx)
	if err != nil || len(list) != 1 || list[0].Name != "Renamed" {
		t.Fatal(list, err)
	}
	fresh := openRepo(t, filepath.Join(filepath.Dir(privatePath(t)), "fresh"))
	if err = fresh.Bootstrap(ctx); err != nil {
		t.Fatal(err)
	}
	_, err = fresh.AuthenticateWorker(ctx, key)
	workerReason(t, err, "invalid_worker_credential")
}

func TestWorkerEnrollmentAndRenameRollBackWithRealTriggers(t *testing.T) {
	repo := newRepo(t)
	key := enroll(t, repo, "one")
	ctx := t.Context()
	code := [32]byte{1}
	if _, err := repo.IssueEnrollment(ctx, "setup", code, time.Minute); err != nil {
		t.Fatal(err)
	}
	execute(t, repo, "CREATE TRIGGER reject_consumption BEFORE UPDATE ON aaa_worker_enrollments BEGIN SELECT RAISE(ABORT,'reject enrollment'); END")
	_, _, err := repo.ConsumeEnrollment(ctx, code, "new", [32]byte{2}, "new")
	f := failReason(t, err, "sqlite_error")
	if f.Outcome != "rolled_back" || f.Code != "1811" {
		t.Fatal(f)
	}
	execute(t, repo, "DROP TRIGGER reject_consumption")
	execute(t, repo, "CREATE TRIGGER reject_changes BEFORE UPDATE ON aaa_workers BEGIN SELECT RAISE(ABORT,'reject worker change'); END")
	_, err = repo.AuthenticateWorker(ctx, key)
	failReason(t, err, "sqlite_error")
	_, _, err = repo.RenameWorker(ctx, "one", "changed")
	failReason(t, err, "sqlite_error")
	_, _, err = repo.RevokeWorker(ctx, "one")
	failReason(t, err, "sqlite_error")
	rows, err := repo.Workers(ctx)
	if err != nil || len(rows) != 1 || rows[0].Name != "one" || rows[0].RevokedAt != nil {
		t.Fatal(rows, err)
	}
	execute(t, repo, "ALTER TABLE aaa_worker_enrollments RENAME TO hidden_enrollments")
	_, _, err = repo.ConsumeEnrollment(ctx, code, "new", [32]byte{2}, "new")
	failReason(t, err, "sqlite_error")
	execute(t, repo, "ALTER TABLE aaa_workers RENAME TO hidden_workers")
	_, err = repo.Workers(ctx)
	failReason(t, err, "sqlite_error")
	_, err = repo.AuthenticateWorker(ctx, key)
	failReason(t, err, "sqlite_error")
}
