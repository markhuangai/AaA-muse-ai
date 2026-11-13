package service

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/postgres"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const EnrollmentLifetime = 15 * time.Minute

type WorkerRepository interface {
	IssueEnrollment(context.Context, string, [32]byte, time.Duration) (worker.Enrollment, error)
	ConsumeEnrollment(context.Context, [32]byte, string, [32]byte, string) (worker.Record, worker.Enrollment, error)
	AuthenticateWorker(context.Context, [32]byte) (worker.Record, error)
	Workers(context.Context) ([]worker.Record, error)
	RenameWorker(context.Context, string, string) (worker.Record, worker.Record, error)
	RevokeWorker(context.Context, string) (worker.Record, worker.Record, error)
}

type Workers struct {
	repo      WorkerRepository
	authority *auth.Authority
	random    io.Reader
	now       func() time.Time
}

func NewWorkers(repo WorkerRepository, authority *auth.Authority, random io.Reader, now func() time.Time) *Workers {
	return &Workers{repo: repo, authority: authority, random: random, now: now}
}

func workerLogger(logger *slog.Logger, operation string) *slog.Logger {
	return logger.With("operation", operation, "schema_version", postgres.SchemaVersion, "enrollment_lifetime_seconds", EnrollmentLifetime.Seconds(), "worker_authority_lifetime", "until_revoked")
}

func (s *Workers) failed(logger *slog.Logger, err error, started time.Time, attrs ...any) error {
	attrs = append(attrs, "duration_ms", s.now().Sub(started).Milliseconds(), "attempt", 1)
	var rejected *worker.Rejection
	if errors.As(err, &rejected) {
		outcome := rejected.Outcome
		if outcome == "" {
			outcome = "not_started"
		}
		event := "worker.rejected"
		if strings.HasPrefix(rejected.Reason, "enrollment_") {
			event = "enrollment.rejected"
		} else if rejected.Reason == "worker_revoked" || rejected.Reason == "invalid_worker_credential" {
			event = "worker.auth_denied"
		}
		logger.Warn(event, append(attrs, "reason", rejected.Reason, "worker_id", rejected.WorkerID, "enrollment", rejected.Enrollment, "transaction_outcome", outcome)...)
		return err
	}
	cause, detail, state, outcome := "worker_dependency_failed", err.Error(), "", "not_started"
	var failure *postgres.Failure
	if errors.As(err, &failure) {
		cause, detail, state, outcome = failure.Reason, failure.Detail(), failure.SQLState, failure.Outcome
	}
	logger.Debug("worker.storage_exchange", append(attrs, "cause", cause, "detail", detail, "sqlstate", state, "transaction_outcome", outcome)...)
	logger.Error("worker.operation_failed", append(attrs, "cause", cause, "sqlstate", state, "transaction_outcome", outcome)...)
	return err
}

func (s *Workers) identity(prefix string) (id, token string, err error) {
	id, err = auth.ID(s.random)
	if err == nil {
		token, err = auth.Token(prefix, s.random)
	}
	if err == nil && s.authority.Reserved(token) {
		err = errors.New("generated_worker_authority_collision")
	}
	return
}

func (s *Workers) Issue(ctx context.Context, logger *slog.Logger) (worker.Enrollment, string, error) {
	logger, started := workerLogger(logger, "enrollment.issue"), s.now()
	id, code, err := s.identity(auth.EnrollmentPrefix)
	if err != nil {
		return worker.Enrollment{}, "", s.failed(logger, err, started)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	e, err := s.repo.IssueEnrollment(ctx, id, auth.Digest(code), EnrollmentLifetime)
	if err != nil {
		return e, "", s.failed(logger, err, started, "enrollment_id", id)
	}
	logger.Info("enrollment.issued", "enrollment", e, "transaction_outcome", "committed", "duration_ms", s.now().Sub(started).Milliseconds())
	return e, code, nil
}

func (s *Workers) Enroll(ctx context.Context, logger *slog.Logger, code string) (worker.Record, worker.Enrollment, string, error) {
	logger, started := workerLogger(logger, "enrollment.consume"), s.now()
	if !auth.ValidToken(code, auth.EnrollmentPrefix) {
		return worker.Record{}, worker.Enrollment{}, "", s.failed(logger, &worker.Rejection{Reason: "enrollment_invalid"}, started)
	}
	id, credential, err := s.identity(auth.WorkerPrefix)
	if err != nil {
		return worker.Record{}, worker.Enrollment{}, "", s.failed(logger, err, started)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	w, e, err := s.repo.ConsumeEnrollment(ctx, auth.Digest(code), id, auth.Digest(credential), "Worker "+id[:8])
	if err != nil {
		return w, e, "", s.failed(logger, err, started, "attempted_worker_id", id)
	}
	logger.Info("worker.enrolled", "worker_id", w.ID, "enrollment", e, "worker", w, "transaction_outcome", "committed", "duration_ms", s.now().Sub(started).Milliseconds())
	return w, e, credential, nil
}

func (s *Workers) Authenticate(ctx context.Context, logger *slog.Logger, credential string) (worker.Record, error) {
	logger, started := workerLogger(logger, "worker.authenticate").With("expected_role", "worker", "observed_role", "worker_candidate"), s.now()
	if !auth.ValidToken(credential, auth.WorkerPrefix) {
		return worker.Record{}, s.failed(logger, &worker.Rejection{Reason: "invalid_worker_credential"}, started)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	w, err := s.repo.AuthenticateWorker(ctx, auth.Digest(credential))
	if err != nil {
		return w, s.failed(logger, err, started)
	}
	logger.Debug("worker.authenticated", "worker_id", w.ID, "worker", w, "transaction_outcome", "committed", "duration_ms", s.now().Sub(started).Milliseconds())
	return w, nil
}

func (s *Workers) List(ctx context.Context, logger *slog.Logger) ([]worker.Record, error) {
	logger, started := workerLogger(logger, "worker.list"), s.now()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	workers, err := s.repo.Workers(ctx)
	if err != nil {
		return nil, s.failed(logger, err, started)
	}
	logger.Debug("worker.listed", "workers", workers, "duration_ms", s.now().Sub(started).Milliseconds())
	return workers, nil
}

func (s *Workers) Rename(ctx context.Context, logger *slog.Logger, id, name string) (worker.Record, error) {
	logger, started := workerLogger(logger, "worker.rename").With("worker_id", id), s.now()
	valid := utf8.ValidString(name)
	for _, r := range name {
		if unicode.IsControl(r) {
			valid = false
		}
	}
	name = strings.TrimSpace(name)
	if !valid || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 100 {
		return worker.Record{}, s.failed(logger, &worker.Rejection{Reason: "invalid_worker_name", WorkerID: id}, started)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	before, after, err := s.repo.RenameWorker(ctx, id, name)
	if err != nil {
		return after, s.failed(logger, err, started)
	}
	logger.Debug("worker.rename_exchange", "before", before, "after", after)
	logger.Info("worker.renamed", "transaction_outcome", "committed", "duration_ms", s.now().Sub(started).Milliseconds())
	return after, nil
}

func (s *Workers) Revoke(ctx context.Context, logger *slog.Logger, id string) (worker.Record, error) {
	logger, started := workerLogger(logger, "worker.revoke").With("worker_id", id), s.now()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	before, w, err := s.repo.RevokeWorker(ctx, id)
	if err != nil {
		return w, s.failed(logger, err, started)
	}
	logger.Debug("worker.revoke_exchange", "before", before, "after", w)
	logger.Info("worker.revoked", "worker", w, "transaction_outcome", "committed", "duration_ms", s.now().Sub(started).Milliseconds())
	return w, nil
}
