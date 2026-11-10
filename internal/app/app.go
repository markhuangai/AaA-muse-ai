package app

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/httpapi"
	"github.com/markhuangai/AaA-muse-ai/internal/postgres"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

type Repository interface {
	service.WorkerRepository
	service.InferenceRepository
	Bootstrap(context.Context) error
	Ping(context.Context) error
	Close()
}
type Dependencies struct {
	ReadFile       func(string) ([]byte, error)
	LookupEnv      func(string) (string, bool)
	Random         io.Reader
	Now            func() time.Time
	Sleep          func(context.Context, time.Duration) error
	Wait           func(context.Context, time.Duration) error
	Files          diagnostics.Files
	OpenDB         func(context.Context, string) (Repository, error)
	Listen         func(string, string) (net.Listener, error)
	Stdout, Stderr io.Writer
}

func Production(stdout, stderr io.Writer) Dependencies {
	return Dependencies{ReadFile: os.ReadFile, LookupEnv: os.LookupEnv, Random: rand.Reader, Now: time.Now, Sleep: sleep, Wait: sleep, Files: diagnostics.OSFiles{}, OpenDB: func(ctx context.Context, u string) (Repository, error) {
		repo, err := postgres.Open(ctx, u)
		if err != nil {
			return nil, err
		}
		return repo, nil
	}, Listen: net.Listen, Stdout: stdout, Stderr: stderr}
}
func sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func Run(ctx context.Context, args []string, build service.Build, d Dependencies) int {
	operation := fmt.Sprintf("startup-%d", d.Now().UnixNano())
	fatal := func(event, cause string, attrs []any) {
		emergency(d.Stderr, event, cause, append([]any{"operation_id", operation, "revision", build.Revision}, attrs...))
	}
	flags := flag.NewFlagSet("aaa-muse-ai", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	path := flags.String("config", config.DefaultPath, "Configuration path")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		fatal("config.rejected", "invalid_arguments", nil)
		return 1
	}
	c, err := config.Load(d.ReadFile, d.LookupEnv, *path)
	if err != nil {
		var ce *config.Error
		_ = errors.As(err, &ce)
		attrs := []any{}
		if ce != nil {
			attrs = []any{"field", ce.Field, "reason", ce.Reason, "line", ce.Line, "column", ce.Column}
		}
		fatal("config.rejected", "startup_stopped", attrs)
		return 1
	}
	generated, err := auth.ManagementKey(&c, d.Random)
	if err != nil {
		fatal("config.rejected", "key_generation_failed", nil)
		return 1
	}
	instance, err := auth.ID(d.Random)
	if err != nil {
		fatal("startup.failed", "identifier_generation_failed", nil)
		return 1
	}
	store, err := diagnostics.Open(d.Files, c.Diagnostics.Directory, instance, d.Now, time.Duration(c.Diagnostics.RetentionDays)*24*time.Hour, c.Diagnostics.MaxBytes)
	if err != nil {
		fatal("diagnostics.capture_failed", diagnostics.Cause(err), []any{"instance_id", instance})
		return 1
	}
	failed := make(chan struct{})
	var failOnce sync.Once
	logger := diagnostics.NewLogger(d.Stdout, store, level(c.Diagnostics.Level), diagnostics.NewRedactor(c.Secrets()), d.Now, func(err error) {
		failOnce.Do(func() {
			fatal("diagnostics.capture_failed", diagnostics.Cause(err), []any{"instance_id", instance})
			close(failed)
		})
	}).With("instance_id", instance, "revision", build.Revision, "dirty", build.Dirty)
	startup := logger.With("operation_id", operation)
	startup.Info("config.loaded", "configuration", c, "management_key_source", map[bool]string{true: "generated", false: "configured"}[generated])
	select {
	case <-failed:
		return 1
	default:
	}
	repo, err := connect(ctx, c, d, startup)
	if err != nil {
		return 1
	}
	defer repo.Close()
	listener, err := d.Listen("tcp", c.Server.Listen)
	if err != nil {
		startup.Error("server.listen_failed", "cause", "listen_failed", "listen", c.Server.Listen)
		return 1
	}
	defer listener.Close()
	select {
	case <-failed:
		return 1
	default:
	}
	if generated {
		if _, err = fmt.Fprintln(d.Stdout, "MANAGEMENT_KEY="+string(c.Management.Key)); err != nil {
			fatal("startup.failed", "key_output_failed", []any{"instance_id", instance})
			return 1
		}
	}
	svc := service.New(repo, c, build, instance, d.Now, logger)
	authority := auth.New(c)
	broker := service.NewBroker(repo, d.Random, d.Now, d.Wait, c.Limits.MaxJobs)
	serveCtx, cancelServe := context.WithCancel(ctx)
	defer cancelServe()
	handler := &httpapi.Handler{Service: svc, Workers: service.NewWorkers(repo, authority, d.Random, d.Now), Broker: broker, Authority: authority, Exporter: store, Logger: logger, Random: d.Random, Now: d.Now, Failed: failed}
	handler.Setup = service.NewSetup(handler.Workers, c.Server.PublicURL, c.WorkerPackage)
	server := &http.Server{Handler: handler, BaseContext: func(net.Listener) context.Context { return serveCtx }, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024, ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelError)}
	brokerDone := make(chan struct{})
	go func() { defer close(brokerDone); broker.Run(serveCtx, logger) }()
	result := make(chan error, 1)
	go func() { result <- server.Serve(listener) }()
	startup.Info("server.started", "listen", c.Server.Listen, "schema_version", postgres.SchemaVersion)
	code := 0
	select {
	case <-ctx.Done():
	case <-failed:
		code = 1
	case err = <-result:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server.failed", "cause", "serve_failed")
			code = 1
		}
	}
	cancelServe()
	stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = server.Shutdown(stop); err != nil {
		_ = server.Close()
		logger.Error("server.shutdown_failed", "cause", "shutdown_timeout")
		code = 1
	}
	select {
	case <-brokerDone:
	case <-stop.Done():
		logger.Error("inference.shutdown_failed", "cause", "shutdown_timeout")
		code = 1
	}
	logger.Info("server.stopped", "exit_code", code)
	select {
	case <-failed:
		return 1
	default:
	}
	return code
}

func connect(ctx context.Context, c config.Config, d Dependencies, logger *slog.Logger) (Repository, error) {
	target, _ := url.Parse(string(c.Database.URL))
	logger = logger.With("database_host", target.Host, "database_name", target.Path)
	for attempt := 1; attempt <= 3; attempt++ {
		started := d.Now()
		bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
		repo, err := d.OpenDB(bounded, string(c.Database.URL))
		if err == nil {
			err = repo.Bootstrap(bounded)
		}
		cancel()
		if err == nil {
			logger.Info("db.connected", "attempt", attempt, "schema_version", postgres.SchemaVersion, "duration_ms", d.Now().Sub(started).Milliseconds())
			return repo, nil
		}
		if repo != nil {
			repo.Close()
		}
		failure := postgres.Classify(err)
		logger.Debug("db.exchange_failed", "attempt", attempt, "cause", failure.Reason, "sqlstate", failure.SQLState, "detail", failure.Detail(), "expected", failure.Expected, "observed", failure.Observed, "duration_ms", d.Now().Sub(started).Milliseconds())
		retry := failure.Reason == "database_unavailable" || failure.Reason == "database_operation_failed"
		if !retry || attempt == 3 || ctx.Err() != nil {
			event := "db.connect_failed"
			if failure.Reason == "schema_version_incompatible" || failure.Reason == "migration_checksum_mismatch" {
				event = "db.migration_failed"
			}
			logger.Error(event, "cause", failure.Reason, "attempt", attempt, "sqlstate", failure.SQLState, "expected", failure.Expected, "observed", failure.Observed, "duration_ms", d.Now().Sub(started).Milliseconds(), "outcome", "startup_stopped")
			return nil, err
		}
		delay := time.Duration(attempt) * time.Second
		logger.Warn("db.retry_scheduled", "cause", failure.Reason, "attempt", attempt, "delay_ms", delay.Milliseconds(), "duration_ms", d.Now().Sub(started).Milliseconds())
		if err = d.Sleep(ctx, delay); err != nil {
			logger.Error("db.connect_failed", "cause", "startup_cancelled", "attempt", attempt, "outcome", "startup_stopped")
			return nil, err
		}
	}
	return nil, errors.New("database_startup_failed")
}

func level(value string) slog.Level {
	switch value {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
func emergency(out io.Writer, event, cause string, attrs []any) {
	slog.New(slog.NewJSONHandler(out, nil)).Error(event, append([]any{"cause", cause, "outcome", "stopped"}, attrs...)...)
}
