package httpapi

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/sqlite"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func versionedHTTP(handler *Handler, method, path, key string, contact worker.Contact, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	if contact.Contract == worker.UpdateContract && path != workerStatusRoute {
		path = hookPath(path)
	}
	request := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
	if method == http.MethodGet {
		request = httptest.NewRequest(method, path, nil)
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", "application/json")
	if contact.Version != "" {
		request.Header.Set(service.WorkerVersionHeader, contact.Version)
	}
	if contact.Contract != "" {
		request.Header.Set(service.WorkerUpdaterHeader, contact.Contract)
	}
	if contact.Digest != "" {
		request.Header.Set(service.WorkerDigestHeader, contact.Digest)
	}
	if path == hookPath(workerPullRoute) {
		request.Header.Set("X-Muse-Worker-Hook-Proof", "1")
	}
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)
	rememberTestPull(result, body)
	return result
}

func setUpdateBuild(t *testing.T, h *Handler, r *sqlite.Repository, now func() time.Time, id, version, checksum, from string) worker.UpdateTarget {
	t.Helper()
	build := service.Build{Version: version, Revision: strings.Repeat("a", 40), WorkerPackage: service.PairedWorker(version, strings.Repeat(checksum, 64)), WorkerUpdateFrom: from}
	h.Service = service.New(r, config.Defaults(), build, id, now, h.Logger)
	target := build.UpdateTarget()
	if target == nil {
		t.Fatal("paired build was not eligible")
	}
	if err := h.Broker.EnableUpdates(t.Context(), h.Logger, id, target); err != nil {
		t.Fatal(err)
	}
	return *target
}

func TestConfirmedUpdateLogsOnlyTheTransition(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	clock := func() time.Time { return now }
	h, repo := openPullHTTP(t, filepath.Join(mediaSQLiteDirectory(t), "state.sqlite3"), clock)
	var output bytes.Buffer
	h.Logger = slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug}))
	target := setUpdateBuild(t, h, repo, clock, "broker", "1.0.1", "a", "")
	key, workerID := controlWorker(t, h)
	old := worker.Contact{Version: "1.0.0", Digest: strings.Repeat("b", 64), Contract: worker.UpdateContract}
	current := worker.Contact{Version: target.Version, Digest: target.SHA256, Contract: target.Contract}
	poll := func(sequence int64, contact worker.Contact) inference.PullResult {
		t.Helper()
		now = now.Add(time.Second)
		input := inference.Pull{Version: 1, Sequence: sequence, Checker: "checker", Occurrence: fmt.Sprint("poll-", sequence), ScheduledAt: now, EnteredAt: now}
		var result inference.PullResult
		nativeResponse(t, versionedHTTP(h, "POST", workerPullRoute, key, contact, input), 200, &result)
		return result
	}
	offer := poll(1, old).Update
	if offer == nil {
		t.Fatal("worker did not receive an offer")
	}
	nativeResponse(t, versionedHTTP(h, "POST", workerUpdateRoute, key, old,
		worker.UpdateRequest{ID: offer.ID, Target: target, Action: "begin"}), 200, nil)
	nativeResponse(t, versionedHTTP(h, "POST", workerUpdateRoute, key, old,
		worker.UpdateRequest{ID: offer.ID, Target: target, Action: "failed", Reason: "archive_unavailable"}), 200, nil)
	controlExchange(t, h, "POST", "/api/v1/admin/workers/"+workerID+"/ops", testManagementKey,
		worker.OpRequest{ControlRequest: worker.ControlRequest{Version: inference.Version, SubmissionID: "retry-fixture"}, Kind: worker.RetryUpdate}, nil, 202, nil)
	retryOffer := poll(2, old).Update
	if retryOffer == nil || retryOffer.ID == offer.ID {
		t.Fatal("pending retry did not produce a distinct offer")
	}
	for _, action := range []string{"begin", "activate", "applied"} {
		contact := old
		if action == "applied" {
			contact = current
		}
		nativeResponse(t, versionedHTTP(h, "POST", workerUpdateRoute, key, contact, worker.UpdateRequest{ID: retryOffer.ID, Target: target, Action: action}), 200, nil)
	}
	for _, sequence := range []int64{3, 4, 5} {
		poll(sequence, current)
	}
	offered, confirmed, timing := 0, 0, 0
	retryLogged := false
	decoder := json.NewDecoder(&output)
	for decoder.More() {
		var line map[string]any
		if err := decoder.Decode(&line); err != nil {
			t.Fatal(err)
		}
		if line["msg"] == "worker.pull_timing" && line["level"] == "DEBUG" {
			timing++
		}
		if line["msg"] != "worker.update_pickup" || line["level"] != "INFO" || line["transaction_outcome"] != "committed" {
			continue
		}
		switch line["state"] {
		case "offered":
			offered++
			retryLogged = retryLogged || line["operation_id"] == retryOffer.ID
		case "confirmed":
			if line["sequence"] != float64(3) {
				t.Fatalf("confirmed INFO belongs only to the transition poll, got sequence %v", line["sequence"])
			}
			confirmed++
		}
	}
	if offered != 2 || !retryLogged || confirmed != 1 || timing != 5 {
		t.Fatalf("offered=%d confirmed=%d protected poll timing=%d", offered, confirmed, timing)
	}
}

func TestManagedWorkerUpdateFencesAndConfirms(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	clock := func() time.Time { return now }
	path := filepath.Join(mediaSQLiteDirectory(t), "state.sqlite3")
	h, repo := openPullHTTP(t, path, clock)
	sibling, siblingRepo := openPullHTTP(t, path, clock)
	target := setUpdateBuild(t, h, repo, clock, "first", "1.0.1", "a", "")
	setUpdateBuild(t, sibling, siblingRepo, clock, "second", "1.0.1", "a", "")
	key := enrollNative(t, h)
	foreign := enrollNative(t, h)
	old := worker.Contact{Version: "1.0.1-rc.9", Digest: strings.Repeat("b", 64), Contract: worker.UpdateContract}
	pulled := func(handler *Handler, sequence int64, contact worker.Contact) inference.PullResult {
		var result inference.PullResult
		input := inference.Pull{Version: 1, Sequence: sequence, Checker: "checker", Occurrence: fmt.Sprint("tick-", sequence), ScheduledAt: now, EnteredAt: now}
		nativeResponse(t, versionedHTTP(handler, http.MethodPost, "/api/v1/worker/pull", key, contact, input), 200, &result)
		return result
	}
	offer := pulled(h, 1, old).Update
	if offer == nil || offer.Target != target || *pulled(sibling, 1, old).Update != *offer {
		t.Fatal("lost paired offer or exact replay")
	}

	operation := func(handler *Handler, key string, contact worker.Contact, offer *worker.UpdateOffer, action, reason string, code int) worker.UpdateStatus {
		var result worker.UpdateStatus
		input := worker.UpdateRequest{ID: offer.ID, Target: offer.Target, Action: action, Reason: reason}
		response := versionedHTTP(handler, http.MethodPost, workerUpdateRoute, key, contact, input)
		if code != 200 {
			nativeResponse(t, response, code, nil)
			return result
		}
		nativeResponse(t, response, code, &result)
		return result
	}
	operation(h, foreign, old, offer, "begin", "", 409)
	first := operation(h, key, old, offer, "begin", "", 200)
	if first.State != "downloading" || operation(sibling, key, old, offer, "begin", "", 200).Attempt != first.Attempt {
		t.Fatal("begin did not replay")
	}
	now = now.Add(time.Minute)
	workerStatus := func() worker.UpdateStatus {
		var got struct {
			Update worker.UpdateStatus `json:"worker_update"`
		}
		nativeResponse(t, versionedHTTP(sibling, http.MethodGet, "/api/v1/worker/status", key, old, nil), 200, &got)
		return got.Update
	}
	if other := pulled(sibling, 2, old); other.Job != nil || other.Update != nil || workerStatus().State != "downloading" {
		t.Fatal("an active attempt did not fence pickup")
	}
	failed := operation(sibling, key, old, offer, "failed", "archive_unavailable", 200)
	if failed.State != "failed" || failed.RetryAt == nil || !failed.RetryAt.Equal(now.Add(5*time.Minute)) {
		t.Fatal(failed)
	}
	now = now.Add(time.Minute)
	if pulled(h, 3, old).Update != nil {
		t.Fatal("offered inside backoff")
	}
	now = now.Add(5 * time.Minute)
	offer = pulled(h, 4, old).Update
	if offer == nil || operation(h, key, old, offer, "begin", "", 200).Attempt != 2 {
		t.Fatal("retry was not eligible")
	}
	operation(h, key, old, offer, "activate", "", 200)
	if operation(sibling, key, old, offer, "activate", "", 200).Attempt != 2 {
		t.Fatal("replayed activation changed the attempt")
	}
	current := worker.Contact{Version: target.Version, Digest: target.SHA256, Contract: target.Contract}
	operation(h, key, old, offer, "applied", "", 409)
	if operation(sibling, key, current, offer, "applied", "", 200).State != "awaiting_confirmation" {
		t.Fatal("premature confirmation")
	}
	if operation(h, key, current, offer, "applied", "", 200).State != "awaiting_confirmation" {
		t.Fatal("replayed application skipped confirmation")
	}
	now = now.Add(time.Minute)
	if pulled(sibling, 5, current).Update != nil || workerStatus().State != "confirmed" {
		t.Fatal("fresh target pickup did not confirm")
	}

	setUpdateBuild(t, h, repo, clock, "first", "1.0.1-rc.9", "b", "")
	setUpdateBuild(t, sibling, siblingRepo, clock, "second", "1.0.1", "a", "")
	now = now.Add(time.Second)
	if pulled(h, 6, current).Update != nil || workerStatus().Reason != "mixed_broker_releases" {
		t.Fatal("mixed releases offered a rollback")
	}
	now = now.Add(31 * time.Second)
	if result := pulled(h, 7, current); result.Update != nil || result.Job != nil {
		t.Fatal("older paired prerelease received update or work authority")
	}
}

func TestManagedWorkerMajorRequiresDeclaredMigration(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	clock := func() time.Time { return now }
	h, repo := openPullHTTP(t, filepath.Join(mediaSQLiteDirectory(t), "state.sqlite3"), clock)
	setUpdateBuild(t, h, repo, clock, "broker", "1.0.1", "b", "")
	key := enrollNative(t, h)
	old := worker.Contact{Version: "1.0.1", Digest: strings.Repeat("b", 64), Contract: worker.UpdateContract}
	setUpdateBuild(t, h, repo, clock, "broker", "2.0.0", "a", "")
	pull := func(seq int64) inference.PullResult {
		var result inference.PullResult
		input := inference.Pull{Version: 1, Sequence: seq, Checker: "checker", Occurrence: fmt.Sprint("tick-", seq), ScheduledAt: now, EnteredAt: now}
		nativeResponse(t, versionedHTTP(h, http.MethodPost, "/api/v1/worker/pull", key, old, input), 200, &result)
		return result
	}
	if result := pull(1); result.Job != nil || result.Update != nil {
		t.Fatal("unlisted migration received authority")
	}
	setUpdateBuild(t, h, repo, clock, "broker", "2.0.0", "a", "1")
	now = now.Add(time.Minute)
	result := pull(2)
	if result.Job != nil || result.Update != nil {
		t.Fatal("the old major declaration granted update authority")
	}
	nativeResponse(t, versionedHTTP(h, http.MethodPost, workerUpdateRoute, "invalid", old,
		worker.UpdateRequest{}), 401, nil)
}

func TestLegacyContactsAreObservationOnly(t *testing.T) {
	now := time.Now().UTC()
	clock := func() time.Time { return now }
	h, repo := openPullHTTP(t, filepath.Join(mediaSQLiteDirectory(t), "state.sqlite3"), clock)
	target := setUpdateBuild(t, h, repo, clock, "broker", "1.2.0", "a", "")
	registered, key := enrollHTTP(t, h, issueHTTP(t, h))
	poll := inference.Pull{Version: 1, Sequence: 1, Checker: "legacy-checker", Occurrence: "legacy-poll", ScheduledAt: now, EnteredAt: now}
	created, err := h.Broker.Create(t.Context(), h.Logger, inference.Create{Version: 1, WorkerID: registered.ID,
		SubmissionID: "queued", Messages: []inference.Item{{Type: "message", Role: "user", Text: "queued"}}, Tools: []inference.Tool{}})
	if err != nil || len(created) == 0 {
		t.Fatal("legacy fixture could not queue work", err)
	}
	for _, legacy := range []worker.Contact{{Version: "1.0.0"}, {Version: "1.1.0", Contract: "native-cron-v1", Digest: strings.Repeat("b", 64)}} {
		var idle inference.PullResult
		nativeResponse(t, versionedHTTP(h, "POST", workerPullRoute, key, legacy, poll), 200, &idle)
		if idle.Job != nil || idle.Update != nil {
			t.Fatal("legacy update or work authority")
		}
	}
	var status workerView
	nativeResponse(t, call(h, "GET", workerStatusRoute, "Bearer "+key, nil), 200, &status)
	if status.Update == nil || status.Update.State != "migration_required" || status.Claim != nil {
		t.Fatal("legacy migration status missing")
	}
	nativeResponse(t, call(h, "POST", "/api/v1/admin/workers/"+registered.ID+"/update-prompt", "Bearer "+testManagementKey, nil), 404, nil)
	nativeResponse(t, versionedHTTP(h, "POST", workerUpdateRoute, key, testBuildContact(h), worker.UpdateRequest{
		ID: "adopt", Action: "adopt", Target: target}), 400, nil)
	var granted inference.PullResult
	nativeResponse(t, versionedHTTP(h, "POST", workerPullRoute, key, testBuildContact(h), poll), 200, &granted)
	if granted.Job == nil {
		t.Fatal("legacy observations consumed queued work or sequence")
	}
}

func TestPairedUpdateInvalidatesConflictingPinsAndHeldClaims(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	clock := func() time.Time { return now }
	path := filepath.Join(mediaSQLiteDirectory(t), "state.sqlite3")
	h, repo := openPullHTTP(t, path, clock)
	sibling, siblingRepo := openPullHTTP(t, path, clock)
	target := setUpdateBuild(t, h, repo, clock, "first", "1.0.1", "a", "")
	setUpdateBuild(t, sibling, siblingRepo, clock, "second", "1.0.1", "b", "")
	key := enrollNative(t, h)
	var registered workerView
	nativeResponse(t, versionedHTTP(h, http.MethodGet, "/api/v1/worker/status", key, worker.Contact{}, nil), 200, &registered)
	old := worker.Contact{Version: "1.0.0", Digest: strings.Repeat("c", 64), Contract: worker.UpdateContract}
	offer := func(seq int64) inference.PullResult {
		now = now.Add(time.Second)
		var got inference.PullResult
		input := inference.Pull{Version: 1, Sequence: seq, Checker: "checker", Occurrence: fmt.Sprint("tick-", seq), ScheduledAt: now, EnteredAt: now}
		nativeResponse(t, versionedHTTP(h, http.MethodPost, "/api/v1/worker/pull", key, old, input), 200, &got)
		return got
	}
	if offer(1).Update != nil {
		t.Fatal("same-version split digest permitted a rollout")
	}
	setUpdateBuild(t, sibling, siblingRepo, clock, "second", "1.0.1", "a", "")
	proposal := offer(2).Update
	if proposal == nil {
		t.Fatal("missing agreed offer")
	}
	setUpdateBuild(t, sibling, siblingRepo, clock, "second", "1.0.2", "b", "")
	begin := worker.UpdateRequest{ID: proposal.ID, Action: "begin", Target: target}
	nativeResponse(t, versionedHTTP(h, http.MethodPost, workerUpdateRoute, key, old, begin), 409, nil)
	_, err := h.Broker.Create(t.Context(), h.Logger, inference.Create{Version: 1, WorkerID: registered.ID, SubmissionID: "queued",
		TimeoutSeconds: 300, Messages: []inference.Item{{Type: "message", Role: "user", Text: "finish this first"}}, Tools: []inference.Tool{}})
	if err != nil {
		t.Fatal(err)
	}
	if result := offer(3); result.Job != nil || result.Update != nil {
		t.Fatal("mixed brokers granted work to an unpaired worker")
	}
	now = now.Add(time.Second)
	var claimed inference.PullResult
	nativeResponse(t, versionedHTTP(h, "POST", workerPullRoute, key, testBuildContact(h),
		inference.Pull{Version: 1, Sequence: 4, Checker: "checker", Occurrence: "tick-4", ScheduledAt: now, EnteredAt: now}), 200, &claimed)
	if claimed.Job == nil {
		t.Fatal("exact pair did not grant the queued work")
	}
	check := inference.BusyCheck{Version: 1, ClaimID: claimed.Job.ClaimID, Generation: claimed.Job.Generation,
		Checker: "checker", Occurrence: "busy-check", ScheduledAt: now.Add(time.Second)}
	now = check.ScheduledAt
	presenceRoute := "/api/v1/worker/jobs/" + claimed.Job.JobID + "/presence"
	invalid := old
	invalid.Digest = "invalid-digest"
	nativeResponse(t, versionedHTTP(sibling, http.MethodPost, presenceRoute, key, invalid, check), 400, nil)
	nativeResponse(t, versionedHTTP(sibling, http.MethodPost, presenceRoute, key, testBuildContact(h), check), 426, nil)
	nativeResponse(t, versionedHTTP(h, http.MethodPost, presenceRoute, key, testBuildContact(h), check), 200, nil)
	var status workerView
	nativeResponse(t, versionedHTTP(h, http.MethodGet, "/api/v1/worker/status", key, old, nil), 200, &status)
	if status.Update == nil || status.Update.ObservedAt == nil || !status.Update.ObservedAt.Equal(now) ||
		status.LastPollAt == nil || !status.LastPollAt.Equal(claimed.Job.ClaimedAt) {
		t.Fatal("busy check did not record the version independently of the work poll")
	}
	setUpdateBuild(t, sibling, siblingRepo, clock, "second", "1.0.1", "a", "")
	nativeResponse(t, versionedHTTP(h, http.MethodPost, workerUpdateRoute, key, old, begin), 409, nil)
	if result := offer(5); result.Update != nil || result.Job != nil {
		t.Fatal("busy worker received an offer")
	}
}

func TestPairedUpdateRollsBackOnStorageFailure(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	clock := func() time.Time { return now }
	path := filepath.Join(mediaSQLiteDirectory(t), "state.sqlite3")
	h, repo := openPullHTTP(t, path, clock)
	target := setUpdateBuild(t, h, repo, clock, "broker", "1.0.1", "a", "")
	key := enrollNative(t, h)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	write := func(statement string) {
		t.Helper()
		if _, err := db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}

	old := worker.Contact{Version: "1.0.0", Digest: strings.Repeat("b", 64), Contract: worker.UpdateContract}
	tick := inference.Pull{Version: 1, Sequence: 1, Checker: "checker", Occurrence: "update-poll", ScheduledAt: now, EnteredAt: now}
	poll := func() *httptest.ResponseRecorder {
		return versionedHTTP(h, http.MethodPost, "/api/v1/worker/pull", key, old, tick)
	}
	invalid := old
	invalid.Digest = ""
	nativeResponse(t, versionedHTTP(h, http.MethodPost, "/api/v1/worker/pull", key, invalid, tick), 400, nil)
	write("CREATE TRIGGER reject_pin BEFORE INSERT ON aaa_update_brokers BEGIN SELECT RAISE(ABORT, 'fixture pin write failure'); END")
	if err := h.Broker.EnableUpdates(t.Context(), h.Logger, "broker", &target); err == nil {
		t.Fatal("broker accepted an unregistered image pin")
	}
	nativeResponse(t, poll(), 503, nil)
	write("DROP TRIGGER reject_pin")
	var pulled inference.PullResult
	nativeResponse(t, poll(), 200, &pulled)
	if pulled.Update == nil || pulled.Update.Target != target || pulled.Job != nil {
		t.Fatal("retry did not obtain an offer for the original occurrence")
	}
	changed := target
	changed.PackagePin = service.PairedWorker("1.0.2", strings.Repeat("c", 64))
	nativeResponse(t, versionedHTTP(h, http.MethodPost, workerUpdateRoute, key, testBuildContact(h), worker.UpdateRequest{
		ID: pulled.Update.ID, Action: "applied", Target: changed,
	}), 409, nil)
	input := worker.UpdateRequest{ID: pulled.Update.ID, Action: "begin", Target: target}
	send := func(code int) worker.UpdateStatus {
		t.Helper()
		var result worker.UpdateStatus
		response := versionedHTTP(h, http.MethodPost, workerUpdateRoute, key, old, input)
		if code == 200 {
			nativeResponse(t, response, code, &result)
		} else {
			nativeResponse(t, response, code, nil)
		}
		return result
	}
	if _, err := db.ExecContext(t.Context(), "INSERT INTO aaa_update_brokers(instance_id,release,expires_at) VALUES('unreadable',?1,?2)",
		[]byte("unreadable"), now.Add(time.Minute).UnixMicro()); err != nil {
		t.Fatal(err)
	}
	send(503)
	write("DELETE FROM aaa_update_brokers WHERE instance_id='unreadable'")
	write("CREATE TRIGGER reject_attempt BEFORE UPDATE ON aaa_worker_updates BEGIN SELECT RAISE(ABORT, 'fixture attempt write failure'); END")
	send(503)
	write("DROP TRIGGER reject_attempt")
	if got := send(200); got.Attempt != 1 || got.State != "downloading" {
		t.Fatal("a failed write consumed an update attempt")
	}
	input.Action, input.Reason = "failed", "unclassified"
	send(400)
	input.Reason = "archive_digest_mismatch"
	if got := send(200); got.State != "failed" || got.RetryAt != nil || got.Attempt != 1 {
		t.Fatal("verification failure should require inspection before another attempt")
	}
	now = now.Add(time.Minute)
	if got := send(200); got.State != "failed" || got.Attempt != 1 {
		t.Fatal("exact failure replay created an attempt")
	}
	input.Action, input.Reason = "activate", ""
	send(409)

	tick.Sequence, tick.Occurrence, tick.ScheduledAt, tick.EnteredAt = 2, "other-digest-poll", now, now
	sameVersion := worker.Contact{Version: target.Version, Digest: old.Digest, Contract: old.Contract}
	nativeResponse(t, versionedHTTP(h, http.MethodPost, "/api/v1/worker/pull", key, sameVersion, tick), 200, &pulled)
	var status workerView
	nativeResponse(t, versionedHTTP(h, http.MethodGet, "/api/v1/worker/status", key, old, nil), 200, &status)
	if status.Update == nil || status.Update.State != "deferred" || status.Update.Reason != "release_digest_conflict" {
		t.Fatal("the same version with a different digest did not require investigation")
	}
	if _, err := h.Workers.Revoke(t.Context(), h.Logger, status.ID); err != nil {
		t.Fatal(err)
	}
	send(401)
}
