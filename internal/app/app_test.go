package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/sqlite"
)

type fakeRepository struct {
	service.WorkerRepository
	service.InferenceRepository
	service.PortalBrowserRepository
	bootErr     error
	recoveryErr error
	recovered   atomic.Bool
	closed      atomic.Bool
}

func (r *fakeRepository) Bootstrap(context.Context) error                    { return r.bootErr }
func (r *fakeRepository) Ping(context.Context) error                         { return nil }
func (r *fakeRepository) Close()                                             { r.closed.Store(true) }
func (r *fakeRepository) InferenceWorkers(context.Context) ([]string, error) { return nil, nil }
func (r *fakeRepository) PortalPassword(context.Context) (auth.PortalPasswordState, error) {
	return auth.PortalPasswordState{}, nil
}
func (r *fakeRepository) ReplacePortalPassword(context.Context, auth.PortalPasswordState) (bool, error) {
	return true, nil
}
func (r *fakeRepository) WithinInference(_ context.Context, ref inference.Ref, apply func(*inference.State) error) error {
	if ref.Recovery {
		if r.recoveryErr != nil {
			return r.recoveryErr
		}
		r.recovered.Store(true)
	}
	return apply(&inference.State{Now: time.Now(), Pool: map[string]*inference.State{}, Experiments: map[string]*inference.Experiment{}, Jobs: map[string]*inference.Job{}, Requests: map[string]*inference.Request{}, Conversations: map[string]*inference.Conversation{}})
}

func fixtureDependencies(t *testing.T, generated bool) (Dependencies, *bytes.Buffer, *bytes.Buffer, *fakeRepository) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	repo := &fakeRepository{}
	data := map[string]any{"control-portal": map[string]any{"password": "portal-private-sentinel"}, "diagnostics": map[string]any{"directory": t.TempDir()}}
	if !generated {
		data["management"] = map[string]any{"key": "management-private-sentinel"}
	}
	b, _ := json.Marshal(data)
	d := Production(&stdout, &stderr)
	d.MediaDir = ""
	d.ClientKeyFile = nil
	d.ReadFile = func(string) ([]byte, error) { return b, nil }
	d.LookupEnv = func(string) (string, bool) { return "", false }
	d.Random = bytes.NewReader(bytes.Repeat([]byte{19}, 1024))
	d.OpenDB = func(context.Context, string) (Repository, error) { return repo, nil }
	d.Sleep = func(context.Context, time.Duration) error { return nil }
	return d, &stdout, &stderr, repo
}

func TestRunRealHTTPAndGeneratedKey(t *testing.T) {
	for _, generated := range []bool{false, true} {
		t.Run(map[bool]string{false: "configured", true: "generated"}[generated], func(t *testing.T) {
			d, out, errout, repo := fixtureDependencies(t, generated)
			address := make(chan string, 1)
			d.Listen = func(network, _ string) (net.Listener, error) {
				listener, err := net.Listen(network, "127.0.0.1:0")
				if err == nil {
					address <- listener.Addr().String()
				}
				return listener, err
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan int, 1)
			go func() { result <- Run(ctx, nil, service.Build{Revision: "source", Dirty: true}, d) }()
			var origin string
			select {
			case origin = <-address:
			case code := <-result:
				t.Fatalf("startup exited before listening (status %d)", code)
			case <-time.After(10 * time.Second):
				t.Fatal("startup did not listen within 10 seconds")
			}
			client := &http.Client{Timeout: time.Second}
			response, err := client.Get("http://" + origin + "/healthz")
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if response.StatusCode != 200 || !bytes.Contains(body, []byte("alive")) {
				t.Fatal("real liveness path failed")
			}
			cancel()
			var code int
			select {
			case code = <-result:
			case <-time.After(3 * time.Second):
				t.Fatal("shutdown stalled")
			}
			if code != 0 || !repo.closed.Load() || errout.Len() != 0 {
				t.Fatal("clean shutdown failed")
			}
			keyLines := 0
			for _, line := range strings.Split(out.String(), "\n") {
				if strings.HasPrefix(line, "MANAGEMENT_KEY=") {
					keyLines++
					key := strings.TrimPrefix(line, "MANAGEMENT_KEY=")
					if len(key) != 43 || strings.Count(out.String(), key) != 1 {
						t.Fatal("generated key appeared outside one-time line")
					}
				}
			}
			if generated && keyLines != 1 || !generated && keyLines != 0 || strings.Contains(out.String(), "private-sentinel") {
				t.Fatal("key output contract violated")
			}
			if !strings.Contains(out.String(), "server.started") || !strings.Contains(out.String(), "server.stopped") {
				t.Fatal("missing lifecycle outcomes")
			}
		})
	}
}

type deniedFiles struct{ diagnostics.OSFiles }

func (deniedFiles) MkdirAll(string, fs.FileMode) error { return fs.ErrPermission }

type brokenWriter struct{}

func (brokenWriter) Write([]byte) (int, error) { return 0, errors.New("write failed") }

type brokenListener struct{}

func (brokenListener) Accept() (net.Conn, error) { return nil, errors.New("accept failed") }
func (brokenListener) Close() error              { return nil }
func (brokenListener) Addr() net.Addr            { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1234} }

func TestStartupFailuresAreSafeAndTerminal(t *testing.T) {
	for _, name := range []string{"arguments", "positional", "read", "yaml", "key-entropy", "id-entropy", "capture-open", "capture-write", "database", "listen", "key-output", "serve"} {
		t.Run(name, func(t *testing.T) {
			d, out, errout, _ := fixtureDependencies(t, name == "key-entropy" || name == "key-output")
			var args []string
			switch name {
			case "arguments":
				args = []string{"--unknown"}
			case "positional":
				args = []string{"unwanted"}
			case "read":
				d.ReadFile = func(string) ([]byte, error) { return nil, fs.ErrPermission }
			case "yaml":
				d.ReadFile = func(string) ([]byte, error) { return []byte("control-portal: [private-sentinel"), nil }
			case "key-entropy", "id-entropy":
				d.Random = bytes.NewReader(nil)
			case "capture-open":
				d.Files = deniedFiles{}
			case "capture-write":
				d.Stdout = brokenWriter{}
			case "database":
				d.OpenDB = func(context.Context, string) (Repository, error) { return nil, errors.New("private-sentinel") }
			case "listen":
				d.Listen = func(string, string) (net.Listener, error) { return nil, errors.New("private-sentinel") }
			case "key-output":
				d.Stdout = &failAfterWriter{remaining: 2}
				d.Listen = func(string, string) (net.Listener, error) { return &brokenListener{}, nil }
			case "serve":
				d.Listen = func(string, string) (net.Listener, error) { return &brokenListener{}, nil }
			}
			if Run(context.Background(), args, service.Build{}, d) != 1 {
				t.Fatal("failed startup reported success")
			}
			if strings.Contains(out.String(), "private-sentinel") || strings.Contains(errout.String(), "private-sentinel") {
				t.Fatal("failure exposed secret input")
			}
			if !strings.Contains(out.String(), "failed") && !strings.Contains(errout.String(), "failed") && !strings.Contains(errout.String(), "rejected") {
				t.Fatal("missing terminal evidence")
			}
		})
	}
}

type failAfterWriter struct{ remaining int }

func (w *failAfterWriter) Write(b []byte) (int, error) {
	w.remaining--
	if w.remaining < 0 {
		return 0, errors.New("output failed")
	}
	return len(b), nil
}

func TestConnectRetriesAndDiagnosis(t *testing.T) {
	for _, name := range []string{"eventual", "exhausted", "starting", "starting-exhausted", "migration", "checksum", "sleep-cancelled", "already-cancelled", "open-failed"} {
		t.Run(name, func(t *testing.T) {
			d, _, _, _ := fixtureDependencies(t, false)
			var output bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug})).With("operation_id", "startup-fixture")

			attempts, sleeps := 0, 0
			d.Sleep = func(_ context.Context, delay time.Duration) error {
				sleeps++
				if delay != time.Duration(sleeps)*time.Second {
					t.Fatal("wrong backoff")
				}
				if name == "sleep-cancelled" {
					return context.Canceled
				}
				return nil
			}
			d.OpenDB = func(context.Context, string) (Repository, error) {
				attempts++
				switch name {
				case "migration":
					return &fakeRepository{bootErr: &sqlite.Failure{Reason: "schema_version_incompatible", Expected: "4", Observed: "5"}}, nil
				case "checksum":
					return &fakeRepository{bootErr: &sqlite.Failure{Reason: "migration_checksum_mismatch"}}, nil
				case "open-failed":
					return nil, &sqlite.Failure{Reason: "database_configuration_invalid"}
				}
				if (name == "eventual" || name == "starting") && attempts == 3 {
					return &fakeRepository{}, nil
				}
				if name == "starting" || name == "starting-exhausted" {
					return &fakeRepository{bootErr: &sqlite.Failure{Reason: "database_busy", Code: "5", Phase: "begin"}}, nil
				}
				return &fakeRepository{bootErr: context.DeadlineExceeded}, nil
			}
			ctx := context.Background()
			if name == "already-cancelled" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			repo, err := connect(ctx, d, logger)
			if name == "eventual" || name == "starting" {
				if err != nil || repo == nil || attempts != 3 || sleeps != 2 {
					t.Fatal("retry recovery failed")
				}
				repo.Close()
			} else {
				if err == nil || repo != nil {
					t.Fatal("required dependency failure hidden")
				}
				if !strings.Contains(output.String(), "startup_stopped") {
					t.Fatal("missing final outcome")
				}
			}
			if (name == "migration" || name == "checksum" || name == "open-failed") && attempts != 1 {
				t.Fatal("retried deterministic failure")
			}
			if (name == "exhausted" || name == "starting-exhausted") && (attempts != 3 || sleeps != 2) {
				t.Fatal("unavailable database exceeded the retry bound")
			}
			if strings.HasPrefix(name, "starting") && !strings.Contains(output.String(), `"sqlite_code":"5"`) {
				t.Fatal("transient SQLite diagnosis lost its result code")
			}
			if !strings.Contains(output.String(), "startup-fixture") || !strings.Contains(output.String(), "database_file") {
				t.Fatal("diagnostic correlation or dependency target missing")
			}
		})
	}
}

func TestRuntimeCaptureFailureStopsService(t *testing.T) {
	d, _, errout, _ := fixtureDependencies(t, false)
	files := &toggleFiles{}
	d.Files = files
	address := make(chan string, 1)
	d.Listen = func(network, _ string) (net.Listener, error) {
		l, err := net.Listen(network, "127.0.0.1:0")
		if err == nil {
			address <- l.Addr().String()
		}
		return l, err
	}
	result := make(chan int, 1)
	go func() { result <- Run(t.Context(), nil, service.Build{}, d) }()
	var origin string
	select {
	case origin = <-address:
	case code := <-result:
		t.Fatalf("startup exited before listening (status %d)", code)
	case <-time.After(10 * time.Second):
		t.Fatal("startup did not listen within 10 seconds")
	}
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get("http://" + origin + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	files.fail.Store(true)
	response, err = client.Get("http://" + origin + "/healthz")
	if err == nil {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}
	select {
	case code := <-result:
		if code != 1 {
			t.Fatal("capture failure did not fail process")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("service continued without capture")
	}
	if !strings.Contains(errout.String(), "diagnostics.capture_failed") || !strings.Contains(errout.String(), "filesystem_permission_denied") {
		t.Fatal("missing corrective cause")
	}
}

func TestRunRefusesLegacyMediaWithoutDeletingFiles(t *testing.T) {
	d, output, _, _ := fixtureDependencies(t, false)
	d.MediaDir = t.TempDir()
	if err := os.Chmod(d.MediaDir, 0700); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(d.MediaDir, "legacy-artifact.mp4")
	if err := os.WriteFile(legacy, []byte("original installation"), 0600); err != nil {
		t.Fatal(err)
	}
	d.Listen = func(string, string) (net.Listener, error) {
		t.Fatal("started serving against a legacy media namespace")
		return nil, errors.New("unexpected listener")
	}
	if result := Run(t.Context(), nil, service.Build{}, d); result != 1 {
		t.Fatalf("legacy media namespace startup status %d", result)
	}
	if saved, err := os.ReadFile(legacy); err != nil || string(saved) != "original installation" {
		t.Fatal("legacy asset was changed by the startup check", err)
	}
	if !strings.Contains(output.String(), "media.namespace_rejected") || !strings.Contains(output.String(), d.MediaDir) {
		t.Fatal("startup failed without identifying the specific media namespace")
	}
}

func TestRunRefusesLegacySQLiteWithoutChangingItsLedger(t *testing.T) {
	d, output, _, _ := fixtureDependencies(t, false)
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	d.DatabasePath = filepath.Join(directory, "legacy.sqlite3")
	legacy, err := sql.Open("sqlite", d.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Close()
	if _, err = legacy.ExecContext(t.Context(), `CREATE TABLE aaa_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL);
		INSERT INTO aaa_schema_migrations VALUES (1,'original-schema'), (2,'original-portal');`); err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(d.DatabasePath, 0600); err != nil {
		t.Fatal(err)
	}
	d.OpenDB = func(ctx context.Context, path string) (Repository, error) { return sqlite.Open(ctx, path) }
	d.Listen = func(string, string) (net.Listener, error) {
		t.Fatal("started serving against a legacy SQLite store")
		return nil, errors.New("unexpected listener")
	}
	if result := Run(t.Context(), nil, service.Build{}, d); result != 1 {
		t.Fatalf("legacy SQLite startup status %d", result)
	}
	var version int
	var checksum string
	if err = legacy.QueryRowContext(t.Context(), "SELECT version,checksum FROM aaa_schema_migrations ORDER BY version DESC LIMIT 1").Scan(&version, &checksum); err != nil || version != 2 || checksum != "original-portal" {
		t.Fatal("startup changed the legacy schema ledger", version, checksum, err)
	}
	if !strings.Contains(output.String(), "db.fresh_store_required") || !strings.Contains(output.String(), d.DatabasePath) {
		t.Fatal("startup did not identify the legacy store or its corrective action")
	}
}

type toggleFiles struct {
	diagnostics.OSFiles
	fail atomic.Bool
}

func (f *toggleFiles) WriteFile(p string, b []byte, m fs.FileMode) error {
	if f.fail.Load() {
		return fs.ErrPermission
	}
	return f.OSFiles.WriteFile(p, b, m)
}

func TestRuntimeHelpers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if sleep(ctx, time.Hour) == nil {
		t.Fatal("sleep ignored cancellation")
	}
	if sleep(context.Background(), time.Nanosecond) != nil {
		t.Fatal("timer failed")
	}
	for name, want := range map[string]slog.Level{"debug": slog.LevelDebug, "info": slog.LevelInfo, "warn": slog.LevelWarn, "error": slog.LevelError} {
		if level(name) != want {
			t.Fatal("level mapping wrong")
		}
	}
	d := Production(io.Discard, io.Discard)
	if d.ReadFile == nil || d.LookupEnv == nil || d.Random == nil || d.Now == nil || d.Sleep == nil || d.Files == nil || d.Listen == nil {
		t.Fatal("production boundary missing")
	}
	if _, err := d.OpenDB(context.Background(), "relative.sqlite3"); err == nil {
		t.Fatal("production connector ignored invalid input")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	repo, err := d.OpenDB(context.Background(), filepath.Join(dir, "broker.sqlite3"))
	if err != nil || repo == nil {
		t.Fatal("production connector lost a valid repository")
	}
	repo.Close()
}

func TestProductionDatabaseConfigurationFailure(t *testing.T) {
	d, out, errout, _ := fixtureDependencies(t, false)
	d.OpenDB = Production(out, errout).OpenDB
	d.DatabasePath = filepath.Join(t.TempDir(), "missing-directory", "broker.sqlite3")
	if Run(context.Background(), nil, service.Build{}, d) != 1 {
		t.Fatal("unavailable database file did not stop startup")
	}
	for _, expected := range []string{`"msg":"db.connect_failed"`, `"cause":"database_file_unavailable"`, `"attempt":1`, `"outcome":"startup_stopped"`, `"phase":"open"`} {
		if !strings.Contains(out.String(), expected) {
			t.Fatal("database open failure lost diagnosis", expected, out.String())
		}
	}
	b, err := d.ReadFile("fixture")
	if err != nil {
		t.Fatal(err)
	}
	c, err := config.Parse(b, d.LookupEnv)
	if err != nil {
		t.Fatal(err)
	}
	store, err := diagnostics.Open(d.Files, c.Diagnostics.Directory, "validation", d.Now, 7*24*time.Hour, c.Diagnostics.MaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.Snapshot(diagnostics.Filter{})
	if err != nil || !snapshot.Metadata.Complete || snapshot.Metadata.Captures != 3 {
		t.Fatal("database startup failure capture is incomplete")
	}
	var captured bytes.Buffer
	for _, file := range snapshot.Records {
		for _, line := range bytes.Split(bytes.TrimSpace(file), []byte("\n")) {
			var record diagnostics.Record
			if err := json.Unmarshal(line, &record); err != nil {
				t.Fatal(err)
			}
			payload, err := base64.StdEncoding.DecodeString(record.Data)
			if err != nil {
				t.Fatal(err)
			}
			captured.Write(payload)
		}
	}
	if strings.Contains(captured.String(), "portal-private-sentinel") || !strings.Contains(captured.String(), "db.exchange_failed") {
		t.Fatal("database failure detail is missing or exposes credentials")
	}
}
