package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
)

type database struct {
	err      error
	deadline bool
}

func (d *database) Ping(ctx context.Context) error { _, d.deadline = ctx.Deadline(); return d.err }

func TestReadinessTransitions(t *testing.T) {
	var out bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&out, &slog.HandlerOptions{Level: slog.LevelDebug})).With("request_id", "request-fixture")
	db := &database{}
	now := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	svc := New(db, config.Defaults(), Build{Revision: "revision"}, "instance", clock, logger)
	now = now.Add(time.Second)
	first := svc.Status(context.Background(), logger)
	if !first.Ready || first.SchemaVersion != 5 || first.UptimeSeconds != 1 || !db.deadline {
		t.Fatal("wrong initial status")
	}
	db.err = errors.New("unavailable")
	down := svc.Status(context.Background(), logger)
	svc.Status(context.Background(), logger)
	if down.Ready || down.Database != "database_operation_failed" {
		t.Fatal("database loss not represented")
	}
	db.err = nil
	if !svc.Status(context.Background(), logger).Ready {
		t.Fatal("database did not recover")
	}
	changes := 0
	for _, line := range bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n")) {
		var event map[string]any
		if json.Unmarshal(line, &event) != nil {
			t.Fatal("invalid log JSON")
		}
		if event["msg"] == "readiness.changed" {
			changes++
			if event["request_id"] != "request-fixture" {
				t.Fatal("correlation lost")
			}
		}
	}
	if changes != 2 {
		t.Fatalf("expected two transitions, got %d", changes)
	}
}
