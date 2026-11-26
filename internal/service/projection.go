package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/sqlite"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

type projectionRepository interface {
	WorkerProjection(context.Context, string, bool) (*inference.State, error)
	ListWorkerProjections(context.Context, []string) ([]*inference.State, error)
}

func (b *Broker) Projections(ctx context.Context, logger *slog.Logger, workers []worker.Record, builds ...Build) ([]inference.Projection, error) {
	projections := make([]inference.Projection, 0, len(workers))
	if repo, ok := b.repo.(projectionRepository); ok {
		ids := make([]string, 0, len(workers))
		for _, record := range workers {
			ids = append(ids, record.ID)
		}
		started := b.now()
		bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		states, err := repo.ListWorkerProjections(bounded, ids)
		if err != nil {
			logProjectionFailure(logger, "", false, b.now().Sub(started), err)
			return nil, err
		}
		for _, state := range states {
			projections = append(projections, readProjection(state, false, builds))
		}
		return projections, nil
	}
	for _, record := range workers {
		projection, err := b.Projection(ctx, logger, record.ID, false, builds...)
		if err != nil {
			return nil, err
		}
		projections = append(projections, projection)
	}
	return projections, nil
}

func readProjection(state *inference.State, own bool, builds []Build) inference.Projection {
	var ignored []inferenceEvent
	expire(state, &ignored)
	state.Experiments = nil
	return buildProjection(state, own, builds)
}

func buildProjection(state *inference.State, own bool, builds []Build) inference.Projection {
	projection := project(state)
	if since := state.Connection.OfflineSince; !own && !state.Revoked && since != nil {
		elapsed := max(0, state.Now.Sub(*since).Milliseconds())
		projection.OfflineForMS = &elapsed
	}
	applyPullProjection(&projection, state)
	projection.Update = state.WorkerUpdate
	projection.ControlProjection = state.ControlProjection
	if projection.ActiveSlotLane != "" {
		projection.WorkStatus = "busy"
	}
	if !own && !state.Revoked {
		paired := len(builds) > 0 && projection.Update != nil && builds[0].Paired(projection.Update.Contact)
		projection.WorkerOpsReady = projection.Update == nil || (projection.Update.Version == "" && projection.Update.Contract == "") || paired
		projection.AgentTasksReady = paired && state.WorkerCapability != nil && state.WorkerCapability.AgentTasks
	}
	return projection
}

func logProjectionFailure(logger *slog.Logger, id string, own bool, elapsed time.Duration, err error) {
	principal := "management"
	if own {
		principal = "worker:" + id
	}
	logger = logger.With("operation", "projection", "authenticated_principal", principal, "worker_id", id,
		"protocol_version", inference.Version, "schema_version", sqlite.SchemaVersion, "duration_ms", elapsed.Milliseconds())
	var rejection *inference.Rejection
	if errors.As(err, &rejection) {
		logger.Warn("lease.rejected", "reason", rejection.Reason, "evidence", rejection.Fields, "outcome", "rejected")
		return
	}
	failure := sqlite.Classify(err)
	logger = logger.With("cause", failure.Reason, "sqlite_code", failure.Code, "phase", failure.Phase,
		"transaction_outcome", failure.Outcome, "attempt", 1)
	logger.Debug("inference.storage_exchange", "detail", failure.Detail())
	logger.Error("inference.operation_failed", "outcome", "operation_stopped")
}
