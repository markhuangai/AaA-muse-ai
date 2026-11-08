package service

import (
	"context"
	"log/slog"
	"net/url"
	"sync"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/postgres"
)

type Database interface{ Ping(context.Context) error }
type Build struct {
	Revision string `json:"revision"`
	Dirty    bool   `json:"dirty"`
}
type Status struct {
	Build         Build         `json:"build"`
	InstanceID    string        `json:"instance_id"`
	UptimeSeconds float64       `json:"uptime_seconds"`
	SchemaVersion int           `json:"schema_version"`
	Ready         bool          `json:"ready"`
	Database      string        `json:"database"`
	Configuration config.Config `json:"configuration"`
}

type Service struct {
	db        Database
	config    config.Config
	build     Build
	instance  string
	started   time.Time
	now       func() time.Time
	logger    *slog.Logger
	mu        sync.Mutex
	lastReady bool
}

func New(db Database, c config.Config, b Build, instance string, now func() time.Time, logger *slog.Logger) *Service {
	return &Service{db: db, config: c, build: b, instance: instance, started: now(), now: now, logger: logger, lastReady: true}
}

func (s *Service) Status(ctx context.Context, logger *slog.Logger) Status {
	started := s.now()
	probe, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	err := s.db.Ping(probe)
	target, _ := url.Parse(string(s.config.Database.URL))
	logger = logger.With("database_host", target.Host, "database_name", target.Path)
	state := Status{Build: s.build, InstanceID: s.instance, UptimeSeconds: s.now().Sub(s.started).Seconds(), SchemaVersion: postgres.SchemaVersion, Ready: err == nil, Database: "available", Configuration: s.config}
	if err != nil {
		failure := postgres.Classify(err)
		state.Database = failure.Reason
		logger.Debug("db.probe_failed", "cause", failure.Reason, "sqlstate", failure.SQLState, "detail", failure.Detail())
	}
	s.mu.Lock()
	changed := s.lastReady != state.Ready
	s.lastReady = state.Ready
	s.mu.Unlock()
	logger.Debug("db.probe", "ready", state.Ready, "cause", state.Database, "duration_ms", s.now().Sub(started).Milliseconds())
	if changed {
		logger.Info("readiness.changed", "ready", state.Ready, "previous_ready", !state.Ready, "cause", state.Database, "schema_version", state.SchemaVersion)
	}
	return state
}
