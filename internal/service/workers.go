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
	"github.com/markhuangai/AaA-muse-ai/internal/sqlite"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const EnrollmentLifetime = 15 * time.Minute

type WorkerRepository interface {
	IssueEnrollment(context.Context, string, [32]byte, time.Duration) (worker.Enrollment, error)
	ConsumeEnrollment(context.Context, [32]byte, string, [32]byte, string) (worker.Record, worker.Enrollment, error)
	PrepareEnrollment(context.Context, [32]byte, [32]byte, [32]byte) (worker.Enrollment, error)
	ActivateEnrollment(context.Context, [32]byte, string, [32]byte, string, [32]byte) (worker.Record, worker.Enrollment, bool, error)
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
	return logger.With("operation", operation, "schema_version", sqlite.SchemaVersion, "enrollment_lifetime_seconds", EnrollmentLifetime.Seconds(), "worker_authority_lifetime", "until_revoked")
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
	cause, detail, code, phase, outcome := "worker_dependency_failed", err.Error(), "", "", "not_started"
	var failure *sqlite.Failure
	if errors.As(err, &failure) {
		cause, detail, code, phase, outcome = failure.Reason, failure.Detail(), failure.Code, failure.Phase, failure.Outcome
	}
	logger.Debug("worker.storage_exchange", append(attrs, "cause", cause, "detail", detail, "sqlite_code", code, "phase", phase, "transaction_outcome", outcome)...)
	logger.Error("worker.operation_failed", append(attrs, "cause", cause, "sqlite_code", code, "phase", phase, "transaction_outcome", outcome)...)
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

func stagedCredentialDigest(credential string) [32]byte {
	return auth.Digest("worker-enrollment-prepare/v1:" + credential)
}

func (s *Workers) PrepareEnrollment(ctx context.Context, logger *slog.Logger, code string) (worker.Enrollment, string, error) {
	logger, started := workerLogger(logger, "enrollment.prepare"), s.now()
	if !auth.ValidToken(code, auth.EnrollmentPrefix) {
		return worker.Enrollment{}, "", s.failed(logger, &worker.Rejection{Reason: "enrollment_invalid"}, started)
	}
	credential, err := auth.Token(auth.WorkerPrefix, s.random)
	if err == nil && s.authority.Reserved(credential) {
		err = errors.New("generated_worker_authority_collision")
	}
	if err != nil {
		return worker.Enrollment{}, "", s.failed(logger, err, started)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	e, err := s.repo.PrepareEnrollment(ctx, auth.Digest(code), stagedCredentialDigest(credential), auth.Digest(credential))
	if err != nil {
		return e, "", s.failed(logger, err, started)
	}
	logger.Info("enrollment.prepared", "enrollment_id", e.ID, "enrollment", e, "transaction_outcome", "committed", "duration_ms", s.now().Sub(started).Milliseconds())
	return e, credential, nil
}

func (s *Workers) ActivateEnrollment(ctx context.Context, logger *slog.Logger, code, credential string) (worker.Record, worker.Enrollment, error) {
	logger, started := workerLogger(logger, "enrollment.activate"), s.now()
	if !auth.ValidToken(code, auth.EnrollmentPrefix) {
		return worker.Record{}, worker.Enrollment{}, s.failed(logger, &worker.Rejection{Reason: "enrollment_invalid"}, started)
	}
	if !auth.ValidToken(credential, auth.WorkerPrefix) || s.authority.Reserved(credential) {
		return worker.Record{}, worker.Enrollment{}, s.failed(logger, &worker.Rejection{Reason: "invalid_worker_credential"}, started)
	}
	id, err := auth.ID(s.random)
	if err != nil {
		return worker.Record{}, worker.Enrollment{}, s.failed(logger, err, started)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	w, e, replay, err := s.repo.ActivateEnrollment(ctx, auth.Digest(code), id, auth.Digest(credential), "Worker "+id[:8], stagedCredentialDigest(credential))
	if err != nil {
		return w, e, s.failed(logger, err, started)
	}
	event := "worker.enrolled"
	if replay {
		event = "enrollment.activation_replayed"
	}
	logger.Info(event, "worker_id", w.ID, "enrollment_id", e.ID, "enrollment", e, "worker", w, "transaction_outcome", "committed", "duration_ms", s.now().Sub(started).Milliseconds())
	return w, e, nil
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

func (s *Workers) Registered(ctx context.Context, logger *slog.Logger, id string) (worker.Record, error) {
	workers, err := s.List(ctx, logger)
	if err != nil {
		return worker.Record{}, err
	}
	for _, record := range workers {
		if record.ID == id && record.RevokedAt == nil {
			return record, nil
		}
	}
	return worker.Record{}, &worker.Rejection{Reason: "worker_not_found"}
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
