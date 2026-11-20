package service

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/sqlite"
)

type Database interface{ Ping(context.Context) error }
type Build struct {
	Version       string     `json:"version"`
	Revision      string     `json:"revision"`
	Dirty         bool       `json:"dirty"`
	WorkerPackage PackagePin `json:"worker_package"`
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
	config    func() *config.Config
	build     Build
	instance  string
	started   time.Time
	now       func() time.Time
	logger    *slog.Logger
	mu        sync.Mutex
	lastReady bool
}

func New(db Database, c config.Config, b Build, instance string, now func() time.Time, logger *slog.Logger) *Service {
	return &Service{db: db, config: func() *config.Config { return &c }, build: b.Normalized(), instance: instance, started: now(), now: now, logger: logger, lastReady: true}
}

func (s *Service) UseConfiguration(current func() *config.Config) { s.config = current }

func (s *Service) Status(ctx context.Context, logger *slog.Logger) Status {
	started := s.now()
	probe, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	err := s.db.Ping(probe)
	c := s.config()
	logger = logger.With("database_engine", "sqlite", "database_file", "broker.sqlite3")
	state := Status{Build: s.build, InstanceID: s.instance, UptimeSeconds: s.now().Sub(s.started).Seconds(), SchemaVersion: sqlite.SchemaVersion, Ready: err == nil, Database: "available", Configuration: *c}
	if err != nil {
		failure := sqlite.Classify(err)
		state.Database = failure.Reason
		logger.Debug("db.probe_failed", "cause", failure.Reason, "sqlite_code", failure.Code, "phase", failure.Phase, "detail", failure.Detail())
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
