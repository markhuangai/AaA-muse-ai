package httpapi

import (
	"bytes"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

type legacyProjectionRepository struct{ service.InferenceRepository }

func TestProjectionExpiryParityAndStorageDiagnosis(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	clock := func() time.Time { return now }
	path := filepath.Join(mediaSQLiteDirectory(t), "state.sqlite3")
	h, repo := openPullHTTP(t, path, clock)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(t.Context(), query, args...); err != nil {
			t.Fatal(err)
		}
	}
	encode := func(value any) []byte {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	ids := map[string]string{}
	for _, kind := range []string{"sse_expired", "sse_revoked", "tool_waits", "native_expired"} {
		record, _ := enrollHTTP(t, h, issueHTTP(t, h))
		ids[kind] = record.ID
	}
	lastAck := now.Add(-45 * time.Second)
	for _, kind := range []string{"sse_expired", "sse_revoked"} {
		connection := inference.Connection{ID: kind, Connected: true, OpenedAt: lastAck, LastAckAt: &lastAck}
		if kind == "sse_revoked" {
			connection.LastAckAt = &now
			exec("UPDATE aaa_workers SET revoked_at=?2 WHERE id=?1", ids[kind], now.UnixMicro())
		}
		exec("INSERT INTO aaa_worker_connections(worker_id,connected,data) VALUES(?1,1,?2)", ids[kind], encode(connection))
	}
	addExperiment := func(id, owner, state, jobID string, deadline time.Time) {
		t.Helper()
		experiment := inference.Experiment{ID: id, WorkerID: owner, State: state, CurrentJobID: jobID, CreatedAt: lastAck, DeadlineAt: deadline}
		exec(`INSERT INTO aaa_experiments(id,worker_id,state,deadline_at,created_at,conversation_id,current_job_id,data)
			VALUES(?1,?2,?3,?4,?5,'',?6,?7)`, id, owner, state, deadline.UnixMicro(), lastAck.UnixMicro(), jobID, encode(experiment))
	}
	addExperiment("tool_old", ids["tool_waits"], "waiting_for_tool", "", now)
	addExperiment("tool_current", ids["tool_waits"], "waiting_for_tool", "", now.Add(time.Minute))
	job := inference.Job{ID: "native_job", ExperimentID: "native_experiment", WorkerID: ids["native_expired"], State: "claimed",
		ClaimedAt: &lastAck, CreatedAt: lastAck, DeadlineAt: now, Generation: 1, LeaseID: "claim", Held: true}
	addExperiment(job.ExperimentID, job.WorkerID, "running", job.ID, job.DeadlineAt)
	exec(`INSERT INTO aaa_inference_jobs(id,worker_id,experiment_id,state,held,created_at,has_media,data,context,deadline_at,capability)
		VALUES(?1,?2,?3,'claimed',1,?4,0,?5,x'7b7d',?6,0)`, job.ID, job.WorkerID, job.ExperimentID, lastAck.UnixMicro(), encode(job), now.UnixMicro())
	var list struct{ Workers []workerView }
	nativeResponse(t, call(h, "GET", "/api/v1/admin/workers", "Bearer "+testManagementKey, nil), 200, &list)
	if len(list.Workers) != len(ids) {
		t.Fatal("batch omitted registered workers")
	}
	observed := make(map[string]workerView, len(list.Workers))
	for _, record := range list.Workers {
		observed[record.ID] = record
	}
	expired, revoked, tools, native := observed[ids["sse_expired"]], observed[ids["sse_revoked"]], observed[ids["tool_waits"]], observed[ids["native_expired"]]
	if expired.ConnectionStatus != "offline" || expired.OfflineForMS == nil || *expired.OfflineForMS != 15000 || revoked.ConnectionStatus != "offline" ||
		revoked.RevokedAt == nil || revoked.OfflineForMS != nil || tools.WaitingForTool != 1 || native.ClaimStage != "recovery_pending" || native.WorkStatus != "busy" {
		t.Fatal("effective expiry, revoked visibility, or uncertain hold differed")
	}
	var state string
	if err := db.QueryRowContext(t.Context(), "SELECT state FROM aaa_inference_jobs WHERE id=?1", job.ID).Scan(&state); err != nil || state != "claimed" {
		t.Fatal("management read changed a durable claim", err)
	}
	legacy := service.NewBroker(legacyProjectionRepository{repo}, rand.Reader, clock, nil)
	for _, record := range list.Workers {
		prior, err := legacy.Projection(t.Context(), h.Logger, record.ID, false, h.Service.Build())
		if err != nil || !bytes.Equal(encode(record.Projection), encode(prior)) {
			t.Fatalf("batch/snapshot projection differed from expire(s): %s != %s: %v", encode(record.Projection), encode(prior), err)
		}
	}
	_, err = h.Broker.Projection(t.Context(), h.Logger, ids["sse_revoked"], true)
	var rejection *inference.Rejection
	if !errors.As(err, &rejection) || rejection.Code != 401 || rejection.Reason != "worker_revoked" {
		t.Fatal("read-only projection admitted revoked worker credentials", err)
	}
	exec("ALTER TABLE aaa_worker_connections RENAME TO missing_worker_connections")
	failed := call(h, "GET", "/api/v1/admin/workers", "Bearer "+testManagementKey, nil)
	nativeResponse(t, failed, 503, nil)
	requestID := failed.Header().Get("X-Request-Id")
	store := h.Exporter.(*diagnostics.Store)
	var diagnosed, observedRejection bool
	for _, event := range capturedHTTP(t, store) {
		if event["msg"] == "inference.storage_exchange" && event["request_id"] == requestID {
			diagnosed = event["sqlite_code"] == "1" && event["phase"] == "statement" && event["transaction_outcome"] == "rolled_back" && event["level"] == "DEBUG"
		}
		if event["msg"] == "lease.rejected" && event["reason"] == "worker_revoked" && event["level"] == "WARN" {
			observedRejection = true
		}
	}
	if !diagnosed || !observedRejection {
		t.Fatal("missing read-only projection failure evidence")
	}
}

func TestWorkerPoolConcurrentPortalReads(t *testing.T) {
	const active = 20
	const revoked = 5
	const budget = 1500 * time.Millisecond
	path := filepath.Join(mediaSQLiteDirectory(t), "state.sqlite3")
	handlers := make([]*Handler, 0, 2)
	stores := make([]*diagnostics.Store, 0, 2)
	for index := range 2 {
		h, repo := openPullHTTP(t, path, time.Now)
		name := fmt.Sprintf("sibling-%d", index)
		store, err := diagnostics.Open(diagnostics.OSFiles{}, t.TempDir(), name, time.Now, time.Hour, 64<<10)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = store.Close() })
		h.Exporter = store
		h.Logger = diagnostics.NewLogger(io.Discard, store, slog.LevelInfo, h.Redactor, time.Now, func(err error) { t.Error(err) }).With("instance_id", name)
		setUpdateBuild(t, h, repo, time.Now, name, "1.0.1", "a", "")
		for range 90 {
			h.Logger.Debug("capacity.fixture", "detail", strings.Repeat("x", 900))
		}
		if snapshot, err := store.Snapshot(diagnostics.Filter{}); err != nil || snapshot.Metadata.Complete || snapshot.Metadata.PrunedThrough.IsZero() {
			t.Fatalf("fixture did not drive capacity eviction: %+v %v", snapshot.Metadata, err)
		}
		store.StartMaintenance(250*time.Millisecond, func(err error) { t.Error(err) })
		handlers = append(handlers, h)
		stores = append(stores, store)
	}
	keys := make([]string, active)
	for index := range active + revoked {
		worker, key := enrollHTTP(t, handlers[0], issueHTTP(t, handlers[0]))
		if index < active {
			keys[index] = key
		} else if _, err := handlers[0].Workers.Revoke(t.Context(), handlers[0].Logger, worker.ID); err != nil {
			t.Fatal(err)
		}
	}
	var running sync.WaitGroup
	var slowest atomic.Int64
	var sweeps atomic.Int64
	var pollers, readers atomic.Int64
	started := make(chan struct{})
	check := func(response int, elapsed time.Duration) {
		t.Helper()
		for prior := slowest.Load(); int64(elapsed) > prior && !slowest.CompareAndSwap(prior, int64(elapsed)); prior = slowest.Load() {
		}
		if response != 200 || elapsed > budget {
			t.Errorf("concurrent HTTP response %d in %s (limit %s)", response, elapsed, budget)
		}
	}
	for index, key := range keys {
		running.Go(func() {
			<-started
			pollers.Add(1)
			defer pollers.Add(-1)
			for poll := range 16 {
				now := time.Now().UTC()
				input := inference.Pull{Version: 1, Sequence: int64(poll + 1), Checker: "checker", Occurrence: fmt.Sprintf("poll-%d", poll), ScheduledAt: now, EnteredAt: now}
				data, err := json.Marshal(input)
				if err != nil {
					t.Error(err)
					return
				}
				handler := handlers[(index+poll)%2]
				request := pairedRequest(handler, http.MethodPost, workerPullRoute, bytes.NewReader(data))
				request.Header.Set("Authorization", "Bearer "+key)
				request.Header.Set(worker.AgentTasksHeader, "1")
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				check(response.Code, time.Since(now))
				time.Sleep(160 * time.Millisecond)
			}
		})
	}
	for _, handler := range handlers {
		running.Go(func() {
			<-started
			readers.Add(1)
			defer readers.Add(-1)
			for range 26 {
				begin := time.Now()
				result := call(handler, http.MethodGet, "/api/v1/admin/workers", "Bearer "+testManagementKey, nil)
				check(result.Code, time.Since(begin))
				var list struct{ Workers []workerView }
				if err := json.Unmarshal(result.Body.Bytes(), &list); err != nil || len(list.Workers) != active+revoked {
					t.Error("portal refresh did not include the complete pool", err)
					return
				}
				time.Sleep(100 * time.Millisecond)
			}
		})
		running.Go(func() {
			<-started
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for range 2 {
				<-ticker.C
				if pollers.Load() != active || readers.Load() != 2 {
					t.Error("periodic sweep did not overlap both full request workloads")
				}
				if err := handler.Broker.Sweep(t.Context(), handler.Logger); err != nil {
					t.Error(err)
				}
				sweeps.Add(1)
			}
		})
	}
	close(started)
	running.Wait()
	if sweeps.Load() != 4 {
		t.Fatal("periodic sweeps did not run under concurrent polling")
	}
	for index, handler := range handlers {
		var workerStatus workerView
		nativeResponse(t, call(handler, "GET", workerStatusRoute, "Bearer "+keys[index], nil), 200, &workerStatus)
		var result struct{ Workers []workerView }
		nativeResponse(t, call(handler, http.MethodGet, "/api/v1/admin/workers", "Bearer "+testManagementKey, nil), 200, &result)
		ready := 0
		for _, record := range result.Workers {
			if record.AgentTasksReady && record.CapabilitiesObservedAt != nil {
				ready++
			}
		}
		if ready != active || workerStatus.CapabilitiesObservedAt == nil {
			t.Fatalf("scale polls recorded task capability for %d/%d active workers", ready, active)
		}
		snapshot, err := stores[index].Snapshot(diagnostics.Filter{})
		if err != nil || snapshot.Metadata.Captures == 0 {
			t.Fatal("scale capture unavailable", err)
		}
		var timing, completed bool
		for _, capture := range snapshot.Records {
			var first diagnostics.Record
			line, _, _ := bytes.Cut(capture, []byte("\n"))
			if err := json.Unmarshal(line, &first); err != nil {
				t.Fatal(err)
			}
			timing = timing || first.Event == "worker.pull_timing"
			completed = completed || first.Event == "request.completed"
			if first.Event == "worker.pull_failed" || first.Event == "inference.operation_failed" {
				t.Errorf("unexpected storage failure in diagnostics: %s", first.Event)
			}
		}
		if !timing || !completed {
			t.Fatal("scale diagnostics lost pull timing or request completion")
		}
	}
	t.Logf("25 workers, 320 idle polls, 52 list reads, four sibling sweeps; slowest HTTP response %s", time.Duration(slowest.Load()))
}

func TestWorkerPullExternalBusyIsDiagnosed(t *testing.T) {
	path := filepath.Join(mediaSQLiteDirectory(t), "state.sqlite3")
	h, _ := openPullHTTP(t, path, time.Now)
	key := enrollNative(t, h)
	external, err := sql.Open("sqlite", "file:"+path+"?_txlock=immediate")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = external.Close() })
	lock, err := external.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback()
	now := time.Now().UTC()
	failed := nativePost(h, workerPullRoute, key, inference.Pull{Version: 1, Sequence: 1, Checker: "checker", Occurrence: "busy", ScheduledAt: now, EnteredAt: now})
	nativeResponse(t, failed, 503, nil)
	requestID := failed.Header().Get("X-Request-Id")
	var busy, timing, completed bool
	for _, event := range capturedHTTP(t, h.Exporter.(*diagnostics.Store)) {
		if event["request_id"] != requestID {
			continue
		}
		switch event["msg"] {
		case "worker.pull_failed":
			busy = event["level"] == "ERROR" && event["cause"] == "database_busy" && event["reason"] == "database_busy" &&
				event["sqlite_code"] == "5" && event["phase"] == "begin" && event["transaction_outcome"] == "not_started"
		case "worker.pull_timing":
			acquired, valid := event["transaction_acquire_us"].(float64)
			timing = event["level"] == "DEBUG" && valid && acquired >= 1000000 && event["queue_lookup_us"] == float64(0) && event["duration_ms"] != nil
		case "request.completed":
			completed = event["duration_ms"] != nil
		}
	}
	if !busy || !timing || !completed {
		t.Fatalf("busy evidence incomplete: error=%v timing=%v completed=%v", busy, timing, completed)
	}
}
