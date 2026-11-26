package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func TestWorkerProjectionAndIdleSweepDoNotAcquireWriter(t *testing.T) {
	repo := newRepo(t)
	enroll(t, repo, "active")
	enroll(t, repo, "revoked")
	stamp := repo.databaseTime()
	execute(t, repo, "UPDATE aaa_workers SET revoked_at=?1 WHERE id='revoked'", stamp.UnixMicro())
	for _, fixture := range []struct {
		id, worker string
		deadline   time.Time
	}{{"old", "active", stamp.Add(-time.Minute)}, {"fresh", "active", stamp.Add(time.Hour)}, {"revoked", "revoked", stamp.Add(time.Hour)}} {
		execute(t, repo, `INSERT INTO aaa_experiments(id,worker_id,state,deadline_at,created_at,conversation_id,current_job_id,data)
			VALUES(?1,?2,'waiting_for_tool',?3,?4,'','',x'7b7d')`, fixture.id, fixture.worker, fixture.deadline.UnixMicro(), stamp.UnixMicro())
	}
	execute(t, repo, `INSERT INTO aaa_conversations(id,client_id,session_id,worker_id,created_at,pending_call_id,current_request_id,data)
		VALUES('conversation','client','session','active',?1,'pending','',x'7b7d')`, stamp.UnixMicro())
	writer, err := repo.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	ctx, cancel := context.WithTimeout(t.Context(), 500*time.Millisecond)
	defer cancel()
	states, err := repo.ListWorkerProjections(ctx, []string{"revoked", "active"})
	if err != nil || len(states) != 2 || !states[0].Revoked || states[0].PendingTools != 0 || states[1].PendingTools != 2 {
		t.Fatalf("bad batch status while writer held: %v %v", states, err)
	}
	if state, err := repo.WorkerProjection(ctx, "active", true); err != nil || state.PendingTools != 2 {
		t.Fatalf("bad single projection while writer held: %v %v", state, err)
	}
	_, err = repo.WorkerProjection(ctx, "revoked", true)
	var rejection *inference.Rejection
	if !errors.As(err, &rejection) || rejection.Code != 401 || rejection.Reason != "worker_revoked" {
		t.Fatal("revoked projection did not reject worker authority", err)
	}
	if found, err := repo.SweepWorkerControl(ctx); err != nil || len(found) != 0 {
		t.Fatalf("idle control sweep attempted a write: %v %v", found, err)
	}
	if err := writer.Rollback(); err != nil {
		t.Fatal(err)
	}
	execute(t, repo, "ALTER TABLE aaa_worker_connections RENAME TO missing_connections")
	_, err = repo.ListWorkerProjections(t.Context(), []string{"active"})
	if failure := failReason(t, err, "sqlite_error"); failure.Code != "1" || failure.Phase != "statement" || failure.Outcome != "rolled_back" {
		t.Fatal(failure)
	}
}

func TestSteadyPollWritesOnlyPollAndWorker(t *testing.T) {
	repo := newRepo(t)
	now := repo.databaseTime()
	repo.now = func() time.Time { return now }
	credential := enroll(t, repo, "worker")
	target := worker.UpdateTarget{PackagePin: worker.PackagePin{Version: "1.2.3", SHA256: strings.Repeat("b", 64)}, Contract: worker.UpdateContract}
	broker := worker.UpdateBroker{ID: "broker", Target: &target}
	contact := worker.Contact{Version: target.Version, Digest: target.SHA256, Contract: target.Contract}
	ctx := inference.WithHookPair(t.Context(), inference.HookPair{Version: target.Version, Digest: target.SHA256})
	tables := []string{"aaa_update_brokers", "aaa_worker_updates", "aaa_worker_capabilities", "aaa_worker_polls", "aaa_workers"}
	execute(t, repo, "CREATE TABLE fixture_writes (name TEXT)")
	for _, table := range tables {
		for _, action := range []string{"INSERT", "UPDATE"} {
			execute(t, repo, fmt.Sprintf(`CREATE TRIGGER count_%s_%s AFTER %s ON %s BEGIN INSERT INTO fixture_writes VALUES('%s'); END`, table, action, action, table, table))
		}
	}
	poll := func(sequence int64, wantChanged bool) {
		t.Helper()
		scheduled := now.Add(900 * time.Nanosecond)
		input := inference.Pull{Version: 1, Sequence: sequence, Checker: "checker", Occurrence: fmt.Sprint("occurrence-", sequence), ScheduledAt: scheduled, EnteredAt: scheduled, AgentTasks: true}
		_, _, _, timing, err := repo.WithinPull(ctx, credential, input, input.Occurrence, 0, contact, broker, func(*inference.State) (*inference.Grant, error) {
			t.Fatal("idle pull claimed work")
			return nil, nil
		})
		if err != nil || timing.Capability == nil || timing.CapabilityChanged != wantChanged {
			t.Fatalf("capability evidence dropped on poll %d: %+v %v", sequence, timing, err)
		}
	}
	counts := func(want ...string) {
		t.Helper()
		var got string
		if err := repo.readDB.QueryRowContext(ctx, "SELECT group_concat(name, ',' ORDER BY name) FROM fixture_writes").Scan(&got); err != nil || got != strings.Join(want, ",") {
			t.Fatalf("poll wrote %q, want %v: %v", got, want, err)
		}
		execute(t, repo, "DELETE FROM fixture_writes")
	}
	poll(1, true)
	counts("aaa_update_brokers", "aaa_worker_capabilities", "aaa_worker_polls", "aaa_worker_updates", "aaa_workers")
	now = now.Add(time.Second)
	poll(2, false)
	counts("aaa_worker_polls", "aaa_workers")
	execute(t, repo, `CREATE TRIGGER blocked_refresh BEFORE INSERT ON aaa_update_brokers BEGIN SELECT RAISE(ABORT, 'registration unavailable'); END`)
	scheduled := now.Add(900 * time.Nanosecond)
	replay := inference.Pull{Version: 1, Sequence: 2, Checker: "checker", Occurrence: "occurrence-2", ScheduledAt: scheduled, EnteredAt: scheduled, AgentTasks: true}
	forced := broker
	forced.ForceRecord = true
	_, _, replayed, timing, err := repo.WithinPull(ctx, credential, replay, replay.Occurrence, 0, contact, forced, nil)
	if err != nil || !replayed || timing.UpdateBrokerRecorded {
		t.Fatalf("committed replay depended on repairing broker registration: %v %+v %v", replayed, timing, err)
	}
	execute(t, repo, "DROP TRIGGER blocked_refresh; DELETE FROM fixture_writes")
	now = now.Add(14 * time.Second)
	poll(3, false)
	counts("aaa_update_brokers", "aaa_worker_polls", "aaa_workers")
	now = now.Add(time.Second)
	broker.ForceRecord = true
	poll(4, false)
	counts("aaa_update_brokers", "aaa_worker_polls", "aaa_workers")
	claim := worker.ControlRecord{ControlItem: worker.ControlItem{ID: "task", WorkerID: "worker", State: "claimed", Held: true,
		CreatedAt: now, DeadlineAt: now.Add(time.Hour), Claim: &worker.ControlGrant{ClaimID: "claim", Generation: 1}}, Pair: contact, Checker: "checker"}
	if err := repo.write(ctx, func(tx *sql.Tx) error { return saveControl(ctx, tx, worker.AgentTask, claim) }); err != nil {
		t.Fatal(err)
	}
	lastObserved, lastScheduled := now, now.Add(900*time.Nanosecond)
	now = now.Add(time.Second)
	stale := worker.Contact{Version: "1.2.2", Digest: strings.Repeat("a", 64), Contract: worker.UpdateContract}
	input := inference.BusyCheck{ClaimID: "claim", Generation: 1, Checker: "checker", Occurrence: "delayed-presence", ScheduledAt: lastScheduled.Add(-400 * time.Nanosecond)}
	receipt, _, capability, change, err := repo.RecordAgentTaskPresence(ctx, credential, claim.ID, input, stale, false)
	if err != nil || !receipt.Recorded || capability != nil || change {
		t.Fatalf("delayed presence incorrectly superseded poll capability: %+v %v %v %v", receipt, capability, change, err)
	}
	projection, err := repo.WorkerProjection(ctx, "worker", false)
	if err != nil || projection.WorkerUpdate == nil || projection.WorkerCapability == nil || projection.WorkerUpdate.Contact != contact ||
		!projection.WorkerUpdate.ScheduledAt.Equal(lastScheduled) || !projection.WorkerCapability.AgentTasks || !projection.WorkerCapability.ObservedAt.Equal(lastObserved) {
		t.Fatalf("delayed presence overwrote latest paired observation: %+v %v", projection, err)
	}
}

func TestUnchangedLegacyContactPreservesObservationOrder(t *testing.T) {
	ctx, path := t.Context(), privatePath(t)
	repo, sibling := openRepo(t, path), openRepo(t, path)
	if err := repo.Bootstrap(ctx); err != nil {
		t.Fatal(err)
	}
	credential := enroll(t, repo, "legacy")
	base := repo.databaseTime()
	contact := worker.Contact{Version: "0.9.2", Digest: strings.Repeat("a", 64)}
	observe := func(target *Repository, reported worker.Contact, offset time.Duration) {
		t.Helper()
		input := inference.Pull{ObserveLegacy: true, ScheduledAt: base.Add(offset)}
		if _, _, _, _, err := target.WithinPull(ctx, credential, input, "", 0, reported, worker.UpdateBroker{}, nil); err != nil {
			t.Fatal(err)
		}
	}
	observe(repo, contact, 0)
	execute(t, repo, `CREATE TRIGGER forbid_legacy_update BEFORE UPDATE ON aaa_worker_updates
		BEGIN SELECT RAISE(ABORT, 'rewrote unchanged legacy contact'); END`)
	latest := time.Second + 900*time.Nanosecond
	observe(repo, contact, latest)
	observe(sibling, worker.Contact{Version: "0.9.1", Digest: strings.Repeat("b", 64)}, latest-400*time.Nanosecond)
	state, err := sibling.WorkerProjection(ctx, "legacy", false)
	if err != nil || state.WorkerUpdate == nil || state.WorkerUpdate.State != "migration_required" ||
		state.WorkerUpdate.Contact != contact || !state.WorkerUpdate.ScheduledAt.Equal(base.Add(latest)) || state.LastPollAt != nil {
		t.Fatalf("projection lost legacy observation or fabricated a native poll: %+v %v", state, err)
	}
}
