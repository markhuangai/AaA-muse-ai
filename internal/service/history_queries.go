package service

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/postgres"
)

type HistoryRepository interface {
	QueryHistory(context.Context, inference.HistoryQuery) (json.RawMessage, error)
}

func (b *Broker) QueryHistory(ctx context.Context, logger *slog.Logger, q inference.HistoryQuery) (json.RawMessage, error) {
	started := b.now()
	logger = logger.With("operation", "history_query", "schema_version", postgres.SchemaVersion, "max_timeline_bytes", inference.MaxTimelineBytes)
	reader, ok := b.repo.(HistoryRepository)
	if !ok {
		return nil, errors.New("history_repository_unavailable")
	}
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	data, err := reader.QueryHistory(bounded, q)
	logger.Debug("history.query_exchange", "query", q, "output", data)
	if err != nil {
		var rejected *inference.Rejection
		if errors.As(err, &rejected) {
			logger.Warn("history.query_rejected", "reason", rejected.Reason, "query", q)
		} else {
			failure := postgres.Classify(err)
			logger.Debug("history.storage_exchange", "cause", failure.Reason, "detail", failure.Detail(), "sqlstate", failure.SQLState, "transaction_outcome", failure.Outcome)
			logger.Error("history.operation_failed", "cause", failure.Reason, "sqlstate", failure.SQLState, "transaction_outcome", failure.Outcome, "duration_ms", b.now().Sub(started).Milliseconds(), "attempt", 1)
		}
		return nil, err
	}
	logger.Info("history.query_completed", "kind", q.Kind, "requested_id", q.ID, "limit", q.Limit, "duration_ms", b.now().Sub(started).Milliseconds(), "outcome", "completed")
	return data, nil
}
