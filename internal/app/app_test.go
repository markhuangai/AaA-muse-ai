package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/postgres"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

type fakeRepository struct {
	bootErr error
	closed  atomic.Bool
}

func (r *fakeRepository) Bootstrap(context.Context) error { return r.bootErr }
func (r *fakeRepository) Ping(context.Context) error      { return nil }
func (r *fakeRepository) Close()                          { r.closed.Store(true) }

func fixtureDependencies(t *testing.T, generated bool) (Dependencies, *bytes.Buffer, *bytes.Buffer, *fakeRepository) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	repo := &fakeRepository{}
	data := map[string]any{"server": map[string]any{"public-url": "https://muse.example.test"}, "database": map[string]any{"url": "postgres://db-private-sentinel@db/muse"}, "control-portal": map[string]any{"password": "portal-private-sentinel"}, "diagnostics": map[string]any{"directory": t.TempDir()}}
	if !generated {
		data["management"] = map[string]any{"key": "management-private-sentinel"}
	}
	b, _ := json.Marshal(data)
	d := Production(&stdout, &stderr)
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
			case <-time.After(3 * time.Second):
				t.Fatal("startup stalled")
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
	for _, name := range []string{"eventual", "exhausted", "migration", "checksum", "sleep-cancelled", "already-cancelled", "open-failed"} {
		t.Run(name, func(t *testing.T) {
			d, _, _, _ := fixtureDependencies(t, false)
			var output bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug})).With("operation_id", "startup-fixture")
			c := config.Defaults()
			c.Database.URL = "postgres://db/muse"
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
					return &fakeRepository{bootErr: &postgres.Failure{Reason: "schema_version_incompatible", Expected: "1", Observed: "2"}}, nil
				case "checksum":
					return &fakeRepository{bootErr: &postgres.Failure{Reason: "migration_checksum_mismatch"}}, nil
				case "open-failed":
					return nil, &postgres.Failure{Reason: "database_configuration_invalid"}
				}
				if name == "eventual" && attempts == 3 {
					return &fakeRepository{}, nil
				}
				return &fakeRepository{bootErr: context.DeadlineExceeded}, nil
			}
			ctx := context.Background()
			if name == "already-cancelled" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			repo, err := connect(ctx, c, d, logger)
			if name == "eventual" {
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
			if !strings.Contains(output.String(), "startup-fixture") || !strings.Contains(output.String(), "database_host") {
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
	go func() { result <- Run(context.Background(), nil, service.Build{}, d) }()
	var origin string
	select {
	case origin = <-address:
	case <-time.After(3 * time.Second):
		t.Fatal("startup stalled")
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
	if _, err := d.OpenDB(context.Background(), "postgres://%"); err == nil {
		t.Fatal("production connector ignored invalid input")
	}
}
