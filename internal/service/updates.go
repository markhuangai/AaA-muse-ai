package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/sqlite"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const updateBrokerInterval = 10 * time.Second

type updateRepository interface {
	RenewUpdateBroker(context.Context, worker.UpdateBroker) error
	ApplyWorkerUpdate(context.Context, [32]byte, worker.Contact, worker.UpdateBroker, worker.UpdateRequest) (worker.UpdateStatus, string, bool, error)
}

func workerContact(reports []worker.Contact) worker.Contact {
	if len(reports) == 0 {
		return worker.Contact{}
	}
	return reports[0]
}

func (b *Broker) EnableUpdates(ctx context.Context, logger *slog.Logger, id string, target *worker.UpdateTarget) error {
	if _, ok := b.repo.(updateRepository); !ok {
		if target == nil {
			return nil
		}
		return errors.New("worker_update_repository_unavailable")
	}
	b.updateBroker = worker.UpdateBroker{ID: id, Target: target}
	if err := b.renewUpdateBroker(ctx, logger); err != nil {
		return err
	}
	logger.Info("worker.update_broker_registered", "target", target, "renew_seconds", updateBrokerInterval.Seconds(), "expiry_seconds", 30)
	return nil
}

func (b *Broker) renewUpdateBroker(ctx context.Context, logger *slog.Logger) error {
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	err := b.repo.(updateRepository).RenewUpdateBroker(bounded, b.updateBroker)
	if err != nil {
		failure := sqlite.Classify(err)
		logger.Warn("worker.update_broker_renewal_failed", "cause", failure.Reason, "phase", failure.Phase, "sqlite_code", failure.Code,
			"target", b.updateBroker.Target, "retry_seconds", updateBrokerInterval.Seconds())
	}
	return err
}

func (b *Broker) ApplyWorkerUpdate(ctx context.Context, logger *slog.Logger, credential string, contact worker.Contact, input worker.UpdateRequest) (worker.UpdateStatus, string, error) {
	err := validateWorkerUpdate(input, contact)
	if err != nil {
		return worker.UpdateStatus{}, "", err
	}
	if !auth.ValidToken(credential, auth.WorkerPrefix) {
		return worker.UpdateStatus{}, "", inference.Reject("invalid_worker_credential", 401)
	}
	repo, ok := b.repo.(updateRepository)
	if !ok {
		return worker.UpdateStatus{}, "", errors.New("worker_update_repository_unavailable")
	}
	started := b.now()
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	state, id, replayed, err := repo.ApplyWorkerUpdate(bounded, auth.Digest(credential), contact, b.updateBroker, input)
	logger = logger.With("worker_id", id, "operation_id", input.ID, "stage", input.Action,
		"attempt", state.Attempt, "duration_ms", b.now().Sub(started).Milliseconds(),
		"reported_version", contact.Version, "observed_digest", contact.Digest, "expected_digest", input.Target.SHA256, "target_version", input.Target.Version)
	logger.Debug("worker.update_exchange", "input", input, "observed", contact, "result", state, "replayed", replayed)
	if err != nil {
		var rejected *inference.Rejection
		if errors.As(err, &rejected) {
			logger.Warn("worker.update_rejected", "cause", rejected.Reason, "state", state.State,
				"corrective_action", updateCorrection(rejected.Reason), "transaction_outcome", rejected.Fields["transaction_outcome"])
		} else {
			failure := sqlite.Classify(err)
			logger.Error("worker.update_failed", "cause", failure.Reason, "phase", failure.Phase, "sqlite_code", failure.Code, "transaction_outcome", failure.Outcome)
		}
	} else if !replayed {
		level, name := slog.LevelInfo, "worker.update_state_changed"
		if state.State == "failed" {
			level, name = slog.LevelWarn, "worker.update_fallback"
		}
		logger.Log(ctx, level, name, "state", state.State, "cause", state.Reason, "retry_at", state.RetryAt,
			"corrective_action", updateCorrection(state.Reason), "transaction_outcome", "committed")
	}
	return state, id, err
}

func validateWorkerUpdate(input worker.UpdateRequest, contact worker.Contact) error {
	if !inference.Identifier.MatchString(input.ID) || contact.Version == "" || contact.Contract == "" ||
		!ValidWorkerDigest(contact.Digest) || input.Target.PackagePin != PairedWorker(input.Target.Version, input.Target.SHA256) ||
		!sourceRevision.MatchString(input.Target.Source) || !ValidWorkerDigest(input.Target.SHA256) ||
		len(input.Target.Version) > 100 || input.Target.Contract != worker.UpdateContract || len(input.Target.FromMajors) > 128 ||
		(input.Target.FromMajors != "" && !supportedMajors.MatchString(input.Target.FromMajors)) {
		return inference.Reject("invalid_worker_update", 400)
	}
	if _, ok := ReleaseMajor(input.Target.Version); !ok {
		return inference.Reject("invalid_worker_update", 400)
	}
	switch input.Action {
	case "begin", "activate", "applied", "failed":
		if input.PreviousVersion != "" || input.WorkerID != "" ||
			(input.Action == "failed" && !worker.ValidUpdateFailure(input.Reason)) ||
			(input.Action != "failed" && input.Reason != "") {
			return inference.Reject("invalid_worker_update", 400)
		}
	default:
		return inference.Reject("invalid_worker_update", 400)
	}
	return nil
}

func logUpdateDecision(ctx context.Context, logger *slog.Logger, state worker.UpdateStatus, elapsed time.Duration) {
	if state.State == "" {
		return
	}
	logger = logger.With("operation_id", state.ID, "reported_version", state.Version, "observed_digest", state.Digest,
		"target", state.Target, "attempt", state.Attempt, "state", state.State, "stage", "pickup", "retry_at", state.RetryAt, "duration_ms", elapsed.Milliseconds())
	switch state.State {
	case "offered", "confirmed":
		logger.Info("worker.update_pickup", "transaction_outcome", "committed")
	case "deferred", "migration_required":
		logger.Warn("worker.update_deferred", "cause", state.Reason, "corrective_action", updateCorrection(state.Reason))
	default:
		logger.Log(ctx, slog.LevelDebug, "worker.update_pickup", "cause", state.Reason, "transaction_outcome", "committed")
	}
}

func updateCorrection(reason string) string {
	switch reason {
	case "":
		return ""
	case "archive_unavailable", "download_failed":
		return "Check that the pinned public archive is available over HTTPS and wait for the next retry."
	case "archive_digest_mismatch", "archive_invalid", "candidate_incompatible", "release_digest_conflict":
		return "Compare the deployed image pin against the verified release archive before changing versions."
	case "staging_failed", "activation_failed":
		return "Check the worker’s private installation directory, permissions and available disk space."
	case "mixed_broker_releases", "target_changed", "update_target_changed", "update_requires_newer_pair":
		return "Bring the running brokers to the intended paired release and allow the next idle check."
	case "unsupported_worker_migration":
		return "Follow the target release’s operator-managed migration instructions."
	case "worker_has_held_work":
		return "Allow the existing native work and its result to settle."
	default:
		return "Inspect the worker’s saved update operation and reconcile it before retrying."
	}
}
