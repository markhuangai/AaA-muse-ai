package httpapi

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/media"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/sqlite"
)

const testManagementKey = "admin-private-sentinel"

func pullHTTP(t *testing.T, path string) *Handler {
	t.Helper()
	return pullHTTPClock(t, path, time.Now)
}

func pullHTTPClock(t *testing.T, path string, now func() time.Time) *Handler {
	t.Helper()
	repository, err := sqlite.OpenWithClock(t.Context(), path, now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	if err = repository.Bootstrap(t.Context()); err != nil {
		t.Fatal(err)
	}
	handler, _, _, _ := fixture(t)
	handler.Now = now
	handler.Workers = service.NewWorkers(repository, handler.Authority, rand.Reader, now)
	handler.Broker = service.NewBroker(repository, rand.Reader, now, nil)
	return handler
}

func TestNativePullOfflineVideoKeepsOriginalDeadlineAndReceipt(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	clock := func() time.Time { return now }
	first, second := pullHTTPClock(t, filepath.Join(root, "shared.sqlite3"), clock), pullHTTPClock(t, filepath.Join(root, "shared.sqlite3"), clock)
	first.Broker.Media = media.New(root)
	second.Broker.Media = media.New(root)
	key := enrollNative(t, first)
	const client = "client-private-sentinel"
	var created struct {
		JobID string `json:"job_id"`
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/media/jobs", bytes.NewBufferString(`{"submission_id":"offline-video","prompt":"fixture"}`))
	request.Header.Set("Authorization", "Bearer "+client)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	first.ServeHTTP(response, request)
	nativeResponse(t, response, 202, &created)
	var result inference.PullResult
	nativeResponse(t, nativePost(first, "/api/v1/worker/pull", key, inference.Pull{Version: 1, Sequence: 1,
		Checker: "checker", Occurrence: "tick-one", ScheduledAt: now, EnteredAt: now, MediaJobs: true}), 200, &result)
	grant := result.Job
	if grant == nil || grant.JobID != created.JobID || !grant.DeadlineAt.Equal(now.Add(15*time.Minute)) {
		t.Fatal("media claim lost its submission-based deadline")
	}
	path := "/api/v1/worker/jobs/" + grant.JobID
	nativeResponse(t, nativePost(first, path+"/start", key, inference.WorkStart{Version: 1, ClaimID: grant.ClaimID,
		Generation: grant.Generation, LaunchID: "video-launch", NativeJob: "video-once"}), 200, nil)
	for _, boundary := range []struct {
		elapsed time.Duration
		status  string
	}{{time.Minute - time.Second, "recent"}, {time.Minute, "quiet"}, {10*time.Minute - time.Second, "quiet"}, {10 * time.Minute, "offline"}, {12 * time.Minute, "offline"}} {
		now = grant.ClaimedAt.Add(boundary.elapsed)
		var list struct {
			Workers []workerView `json:"workers"`
		}
		nativeResponse(t, call(second, http.MethodGet, "/api/v1/admin/workers", "Bearer "+testManagementKey, nil), 200, &list)
		if len(list.Workers) != 1 || list.Workers[0].Claim == nil {
			t.Fatal("presence changed the held media claim")
		}
		view := list.Workers[0]
		if view.ConnectionStatus != boundary.status || view.ClaimAgeMS == nil || *view.ClaimAgeMS != boundary.elapsed.Milliseconds() ||
			view.Claim.ClaimID != grant.ClaimID || !view.Claim.DeadlineAt.Equal(grant.DeadlineAt) {
			t.Fatalf("incorrect claim age or presence at %s: %s", boundary.elapsed, view.ConnectionStatus)
		}
	}
	videoPath := filepath.Join(t.TempDir(), "fixture.mp4")
	if output, err := exec.CommandContext(t.Context(), "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=black:s=64x48:r=8",
		"-t", "1", "-c:v", "mpeg4", videoPath).CombinedOutput(); err != nil {
		t.Fatalf("generate valid MP4 fixture: %v: %s", err, output)
	}
	video, err := os.ReadFile(videoPath)
	if err != nil {
		t.Fatal(err)
	}
	upload := func(handler *Handler) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPut, path+"/artifact", bytes.NewReader(video))
		request.Header.Set("Authorization", "Bearer "+key)
		request.Header.Set("Content-Type", "video/mp4")
		request.Header.Set("X-Muse-Lease-Id", grant.ClaimID)
		request.Header.Set("X-Muse-Generation", fmt.Sprint(grant.Generation))
		request.Header.Set("X-Muse-Artifact-Sha256", fmt.Sprintf("%x", sha256.Sum256(video)))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	probe := func(credential, hash, size string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, path+"/media/receipt", nil)
		request.Header.Set("Authorization", "Bearer "+credential)
		request.Header.Set("X-Muse-Lease-Id", grant.ClaimID)
		request.Header.Set("X-Muse-Generation", fmt.Sprint(grant.Generation))
		request.Header.Set("X-Muse-Artifact-Sha256", hash)
		request.Header.Set("X-Muse-Artifact-Size", size)
		response := httptest.NewRecorder()
		first.ServeHTTP(response, request)
		return response
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(video))
	size := fmt.Sprint(len(video))
	var pending service.ArtifactReceipt
	nativeResponse(t, probe(key, hash, size), 200, &pending)
	if pending.Accepted || pending.ExpiresAt != nil {
		t.Fatal("a read-only receipt probe recorded an artifact before upload")
	}
	nativeResponse(t, probe(key, hash, "0"), 411, nil)
	nativeResponse(t, probe(key, hash, fmt.Sprint(media.ArtifactLimit+1)), 413, nil)
	nativeResponse(t, probe(key, "not-a-hash", size), 400, nil)
	accepted := upload(second)
	var receipt service.ArtifactReceipt
	nativeResponse(t, accepted, 200, &receipt)
	if !receipt.Accepted || receipt.ExpiresAt == nil || !receipt.ExpiresAt.Equal(now.Add(10*time.Minute)) {
		t.Fatal("download lifetime did not begin at verified storage")
	}
	now = grant.DeadlineAt.Add(time.Second)
	replay := upload(first)
	nativeResponse(t, replay, 200, nil)
	if !bytes.Equal(accepted.Body.Bytes(), replay.Body.Bytes()) {
		t.Fatal("deadline changed the accepted upload receipt")
	}
	probeReceipt := probe(key, hash, size)
	nativeResponse(t, probeReceipt, 200, nil)
	if !bytes.Equal(probeReceipt.Body.Bytes(), accepted.Body.Bytes()) {
		t.Fatal("read-only recovery did not return the exact upload receipt")
	}
	nativeResponse(t, probe(key, fmt.Sprintf("%064x", 0), size), 409, nil)
	nativeResponse(t, probe(enrollNative(t, first), hash, size), 404, nil)
	download := call(first, http.MethodGet, "/api/v1/media/jobs/"+grant.JobID+"/artifact", "Bearer "+client, nil)
	if download.Code != 200 || !bytes.Equal(download.Body.Bytes(), video) {
		t.Fatal("downloaded bytes differ from the original verified MP4")
	}
}

func TestNativePullRejectsOldOccurrencesAndRevokedAuthority(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "broker.sqlite3")
	first, second := pullHTTP(t, path), pullHTTP(t, path)
	key := enrollNative(t, first)
	stamp := time.Now().UTC()
	const pullPath = "/api/v1/worker/pull"
	tick := inference.Pull{Version: 1, Sequence: 2, Checker: "checker", Occurrence: "accepted-tick", ScheduledAt: stamp, EnteredAt: stamp}
	nativeResponse(t, nativePost(first, pullPath, "muse_worker_bad", tick), 401, nil)
	nativeResponse(t, nativePost(first, pullPath, "muse_worker_"+strings.Repeat("A", 43), tick), 401, nil)
	badCapability := tick
	badCapability.PromptWAV = true
	nativeResponse(t, nativePost(first, pullPath, key, badCapability), 400, nil)
	accepted := nativePost(first, pullPath, key, tick)
	nativeResponse(t, accepted, 200, nil)
	for _, rejected := range []struct {
		sequence   int64
		occurrence string
		reason     string
	}{{1, "older-sequence", "stale_poll_sequence"}, {2, "different-tick", "poll_sequence_conflict"}, {3, "same-timestamp", "obsolete_occurrence"}} {
		candidate := tick
		candidate.Sequence, candidate.Occurrence = rejected.sequence, rejected.occurrence
		var failure struct {
			Error string `json:"error"`
		}
		nativeResponse(t, nativePost(second, pullPath, key, candidate), 409, &failure)
		if failure.Error != rejected.reason {
			t.Fatalf("poll reason %s, want %s", failure.Error, rejected.reason)
		}
	}
	var worker struct{ ID string }
	nativeResponse(t, call(first, http.MethodGet, "/api/v1/worker/status", "Bearer "+key, nil), 200, &worker)
	if _, err := first.Workers.Revoke(t.Context(), first.Logger, worker.ID); err != nil {
		t.Fatal(err)
	}
	nativeResponse(t, nativePost(second, pullPath, key, tick), 401, nil)
}

func nativePost(handler *Handler, path, key string, input any) *httptest.ResponseRecorder {
	return nativePostVersion(handler, path, key, service.DevelopmentVersion, input)
}

func nativePostVersion(handler *Handler, path, key, version string, input any) *httptest.ResponseRecorder {
	body, err := json.Marshal(input)
	if err != nil {
		panic(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+key)
	if version != "" {
		request.Header.Set(service.WorkerVersionHeader, version)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func nativeResponse(t *testing.T, response *httptest.ResponseRecorder, status int, output any) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status %d, want %d", response.Code, status)
	}
	if output != nil {
		if err := json.Unmarshal(response.Body.Bytes(), output); err != nil {
			t.Fatal(err)
		}
	}
}

func enrollNative(t *testing.T, handler *Handler) string {
	t.Helper()
	var enrolled struct {
		Credential string `json:"credential"`
	}
	nativeResponse(t, nativePost(handler, "/api/v1/worker/enroll", "", map[string]string{"enrollment_code": issueHTTP(t, handler)}), 201, &enrolled)
	return enrolled.Credential
}

func TestNativeBusyCheckProjectsContactWithoutChangingPollOrClaim(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	clock := func() time.Time { return now }
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "broker.sqlite3")
	first, second := pullHTTPClock(t, path, clock), pullHTTPClock(t, path, clock)
	key, foreign := enrollNative(t, first), enrollNative(t, first)
	var enrolled workerView
	nativeResponse(t, call(first, http.MethodGet, "/api/v1/worker/status", "Bearer "+key, nil), 200, &enrolled)
	_, err := first.Broker.SubmitRequest(t.Context(), first.Logger, "client-a", "busy", inference.RequestInput{
		Version: 1, SubmissionID: "busy-request", WorkerID: enrolled.ID, TimeoutSeconds: 1800,
		Messages: []inference.Item{{Type: "message", Role: "user", Text: "long running fixture"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var pulled inference.PullResult
	pollAt := now
	nativeResponse(t, nativePost(first, "/api/v1/worker/pull", key, inference.Pull{Version: 1, Sequence: 1, Checker: "checker",
		Occurrence: "poll", ScheduledAt: now, EnteredAt: now}), 200, &pulled)
	if pulled.Job == nil {
		t.Fatal("fixture claim not acquired")
	}
	grant := *pulled.Job
	route := "/api/v1/worker/jobs/" + grant.JobID + "/presence"
	read := func(connection string, expectedContact time.Time, reason string) {
		t.Helper()
		var list struct{ Workers []workerView }
		nativeResponse(t, call(second, http.MethodGet, "/api/v1/admin/workers", "Bearer "+testManagementKey, nil), 200, &list)
		for _, view := range list.Workers {
			if view.ID != enrolled.ID {
				continue
			}
			if view.ConnectionStatus != connection || view.WorkStatus != "busy" || view.Claim == nil || view.Claim.ClaimID != grant.ClaimID ||
				!view.Claim.DeadlineAt.Equal(grant.DeadlineAt) || view.LastPollAt == nil || !view.LastPollAt.Equal(pollAt) ||
				view.LastContactAt == nil || !view.LastContactAt.Equal(expectedContact) || view.BusyReason != reason {
				t.Fatalf("incorrect busy projection: %+v", view)
			}
			return
		}
		t.Fatal("worker omitted from projection")
	}
	now = pollAt.Add(10 * time.Minute)
	read("offline", pollAt, "")
	check := inference.BusyCheck{Version: 1, ClaimID: grant.ClaimID, Generation: grant.Generation, Checker: "checker",
		Occurrence: "busy-one", ScheduledAt: now, Reason: "producer_launch_unobservable"}
	var receipt inference.PresenceReceipt
	nativeResponse(t, nativePostVersion(first, route, key, "1.0.0-rc.1", check), 200, &receipt)
	checkedAt := now
	if !receipt.Recorded || !receipt.ReceivedAt.Equal(checkedAt) {
		t.Fatal("busy check was not recorded")
	}
	read("recent", checkedAt, check.Reason)
	now = now.Add(time.Minute)
	nativeResponse(t, nativePost(second, route, key, check), 200, &receipt)
	if receipt.Recorded || !receipt.ReceivedAt.Equal(checkedAt) {
		t.Fatal("duplicate busy check moved contact")
	}
	old := check
	old.Occurrence, old.ScheduledAt = "older", checkedAt.Add(-time.Minute)
	nativeResponse(t, nativePost(second, route, key, old), 200, &receipt)
	if receipt.Recorded || !receipt.ReceivedAt.Equal(checkedAt) {
		t.Fatal("older busy check moved contact")
	}
	next := check
	next.Occurrence, next.ScheduledAt, next.Generation = "busy-two", now, grant.Generation+1
	nativeResponse(t, nativePost(first, route, key, next), 409, nil)
	next.Generation = grant.Generation
	nativeResponse(t, nativePost(first, route, foreign, next), 409, nil)
	nativeResponse(t, nativePost(first, route, testManagementKey, next), 401, nil)
	nativeResponse(t, nativePost(first, route, "muse_worker_"+strings.Repeat("A", 43), next), 401, nil)
	next.Reason = "unbounded worker text"
	nativeResponse(t, nativePost(first, route, key, next), 400, nil)
	read("quiet", checkedAt, check.Reason)
	next.Reason = ""
	nativeResponse(t, nativePost(second, route, key, next), 200, &receipt)
	checkedAt = now
	read("recent", checkedAt, "")
	now = checkedAt.Add(10 * time.Minute)
	read("offline", checkedAt, "")
	if _, err := first.Workers.Revoke(t.Context(), first.Logger, enrolled.ID); err != nil {
		t.Fatal(err)
	}
	nativeResponse(t, nativePost(second, route, key, next), 401, nil)
}

func TestNativePullAcrossSameHostBrokers(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "broker.sqlite3")
	now := time.Now().UTC().Truncate(time.Second)
	clock := func() time.Time { return now }
	first, second := pullHTTPClock(t, path, clock), pullHTTPClock(t, path, clock)
	firstKey, secondKey := enrollNative(t, first), enrollNative(t, second)
	stamp := now.Add(-time.Minute)
	poll := inference.Pull{Version: 1, Sequence: 1, Checker: "checker-one", Occurrence: "tick-one", ScheduledAt: stamp, EnteredAt: stamp}
	var empty inference.PullResult
	nativeResponse(t, nativePost(first, "/api/v1/worker/pull", firstKey, poll), 200, &empty)
	if empty.Job != nil {
		t.Fatal("empty poll granted work")
	}
	queued, err := first.Broker.SubmitRequest(t.Context(), first.Logger, "client-a", "session-one", inference.RequestInput{
		Version: 1, SubmissionID: "native-pull", Messages: []inference.Item{{Type: "message", Role: "user", Text: "client-only fixture"}}, Tools: []inference.Tool{},
	})
	if err != nil || queued.State != "queued" {
		t.Fatalf("queue admission failed: %v", err)
	}
	nativeResponse(t, nativePost(second, "/api/v1/worker/pull", firstKey, poll), 200, &empty)
	if empty.Job != nil {
		t.Fatal("replayed empty poll granted newly queued work")
	}
	firstTick := inference.Pull{Version: 1, Sequence: 2, Checker: poll.Checker, Occurrence: "tick-two", ScheduledAt: stamp.Add(time.Minute), EnteredAt: stamp.Add(time.Minute)}
	secondTick := firstTick
	secondTick.Sequence, secondTick.Checker, secondTick.Occurrence = 1, "checker-two", "tick-first"
	var results [2]*httptest.ResponseRecorder
	var running sync.WaitGroup
	running.Go(func() { results[0] = nativePost(first, "/api/v1/worker/pull", firstKey, firstTick) })
	running.Go(func() { results[1] = nativePost(second, "/api/v1/worker/pull", secondKey, secondTick) })
	running.Wait()
	var grantOne, grantTwo inference.PullResult
	nativeResponse(t, results[0], 200, &grantOne)
	nativeResponse(t, results[1], 200, &grantTwo)
	if (grantOne.Job == nil) == (grantTwo.Job == nil) {
		t.Fatal("the same queued request must have exactly one claimant")
	}
	grant, winning, foreign, winningTick := grantOne.Job, firstKey, secondKey, firstTick
	if grant == nil {
		grant, winning, foreign, winningTick = grantTwo.Job, secondKey, firstKey, secondTick
	}
	if grant.OperationID != queued.ID || grant.Generation != 1 {
		t.Fatal("grant did not identify the queued request")
	}
	var replay inference.PullResult
	nativeResponse(t, nativePost(second, "/api/v1/worker/pull", winning, winningTick), 200, &replay)
	if replay.Job == nil || replay.Job.ClaimID != grant.ClaimID {
		t.Fatal("lost pull reply did not reconcile the same claim")
	}
	workerJob := "/api/v1/worker/jobs/" + grant.JobID
	start := inference.WorkStart{Version: 1, ClaimID: grant.ClaimID, Generation: grant.Generation, LaunchID: "launch-one", NativeJob: "native-work-one"}
	nativeResponse(t, nativePost(second, workerJob+"/start", foreign, start), 404, nil)
	var brief inference.Job
	nativeResponse(t, nativePost(second, workerJob+"/start", winning, start), 200, &brief)
	if brief.StartedAt == nil || len(brief.Context.Messages) != 1 || brief.Context.Messages[0].Text != "client-only fixture" {
		t.Fatal("authorized work did not receive exact canonical history")
	}
	nativeResponse(t, nativePost(first, workerJob+"/start", winning, start), 409, nil)
	cancelledBeforeStart := inference.Interruption{Version: 1, SubmissionID: "no-start", ClaimID: grant.ClaimID, Generation: grant.Generation,
		LaunchID: start.LaunchID, NativeJob: start.NativeJob, Reason: "native_cancelled_before_start"}
	nativeResponse(t, nativePost(second, workerJob+"/interrupt", winning, cancelledBeforeStart), 409, nil)
	foreignLaunch := cancelledBeforeStart
	foreignLaunch.LaunchID = "other-launch"
	nativeResponse(t, nativePost(second, workerJob+"/interrupt", winning, foreignLaunch), 409, nil)
	invalidInterruption := cancelledBeforeStart
	invalidInterruption.Version = 2
	nativeResponse(t, nativePost(second, workerJob+"/interrupt", winning, invalidInterruption), 400, nil)
	decision := inference.Submit{Claim: inference.Claim{Version: 1, SubmissionID: "answer-one"}, ConversationID: brief.ConversationID, Generation: brief.Generation, LeaseID: brief.LeaseID, ContextReceiptID: brief.Context.ReceiptID, Decision: inference.Item{Type: "final", Text: "verified answer"}}
	accepted := nativePost(first, workerJob+"/decisions", winning, decision)
	nativeResponse(t, accepted, 200, nil)
	replayed := nativePost(second, workerJob+"/decisions", winning, decision)
	nativeResponse(t, replayed, 200, nil)
	if !bytes.Equal(accepted.Body.Bytes(), replayed.Body.Bytes()) {
		t.Fatal("decision replay did not return the accepted receipt")
	}
	nativeResponse(t, nativePost(second, workerJob+"/interrupt", winning, cancelledBeforeStart), 409, nil)
	nextQueued, err := first.Broker.SubmitRequest(t.Context(), first.Logger, "client-a", "second-session", inference.RequestInput{
		Version: 1, SubmissionID: "next-pull", Messages: []inference.Item{{Type: "message", Role: "user", Text: "second fixture"}}, Tools: []inference.Tool{},
	})
	if err != nil || nextQueued.State != "queued" {
		t.Fatalf("second queue admission failed: %v", err)
	}
	nextTick := winningTick
	nextTick.Sequence++
	nextTick.Occurrence = "tick-after-result"
	nextTick.ScheduledAt, nextTick.EnteredAt = nextTick.ScheduledAt.Add(time.Minute), nextTick.EnteredAt.Add(time.Minute)
	now = grant.ClaimedAt.Add(time.Minute)
	nativeResponse(t, nativePost(first, "/api/v1/worker/pull", winning, nextTick), 200, &empty)
	if empty.Job != nil {
		t.Fatal("accepted result released a slot before native settlement")
	}
	var competing inference.WorkOutcome
	interrupted := inference.Interruption{Version: 1, SubmissionID: "stop-one", ClaimID: grant.ClaimID, Generation: grant.Generation, LaunchID: start.LaunchID, NativeJob: start.NativeJob, NativeRun: "execution-one", Reason: "execution_confirmed_stopped"}
	wrongExecution := interrupted
	wrongExecution.NativeRun = wrongExecution.NativeJob
	nativeResponse(t, nativePost(second, workerJob+"/interrupt", winning, wrongExecution), 400, nil)
	nativeResponse(t, nativePost(second, workerJob+"/interrupt", winning, interrupted), 200, &competing)
	if competing.State != "accepted" || !bytes.Equal(bytes.TrimSpace(accepted.Body.Bytes()), competing.Accepted) {
		t.Fatal("worker interruption replaced an accepted result")
	}
	nativeResponse(t, nativePost(second, "/api/v1/worker/pull", winning, nextTick), 200, &empty)
	if empty.Job != nil {
		t.Fatal("settlement changed an exact empty pull replay")
	}
	nextTick.Sequence++
	nextTick.Occurrence = "tick-after-settlement"
	nextTick.ScheduledAt, nextTick.EnteredAt = nextTick.ScheduledAt.Add(time.Minute), nextTick.EnteredAt.Add(time.Minute)
	now = grant.ClaimedAt.Add(2 * time.Minute)
	nativeResponse(t, nativePost(first, "/api/v1/worker/pull", winning, nextTick), 200, &empty)
	if empty.Job == nil || empty.Job.OperationID != nextQueued.ID || !empty.Job.ClaimedAt.Equal(now) {
		t.Fatal("settled slot did not recover on the minute-two tick")
	}
}

func TestNativePullTargetPriorityAndCancellationFence(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "broker.sqlite3")
	first, second := pullHTTP(t, path), pullHTTP(t, path)
	workerKey, otherKey := enrollNative(t, first), enrollNative(t, second)
	status := call(first, http.MethodGet, "/api/v1/worker/status", "Bearer "+workerKey, nil)
	var worker struct {
		ID         string     `json:"id"`
		Connection string     `json:"connection_status"`
		LastPoll   *time.Time `json:"last_poll_at"`
	}
	nativeResponse(t, status, 200, &worker)
	if worker.Connection != "not_observed" || worker.LastPoll != nil {
		t.Fatal("authentication or enrollment was shown as a scheduled poll")
	}
	create := func(session, target string) inference.RequestView {
		t.Helper()
		queued, err := first.Broker.SubmitRequest(t.Context(), first.Logger, "client-a", session, inference.RequestInput{
			Version: 1, WorkerID: target, SubmissionID: session, Messages: []inference.Item{{Type: "message", Role: "user", Text: session}}, Tools: []inference.Tool{},
		})
		if err != nil || queued.State != "queued" {
			t.Fatalf("queue admission failed: %v", err)
		}
		return queued
	}
	open := create("older-open-request", "")
	targeted := create("newer-targeted-request", worker.ID)
	stamp := time.Now().UTC().Truncate(time.Second)
	tick := inference.Pull{Version: 1, Sequence: 1, Checker: "checker-one", Occurrence: "tick-one", ScheduledAt: stamp, EnteredAt: stamp}
	var selected, untargeted inference.PullResult
	nativeResponse(t, nativePost(first, "/api/v1/worker/pull", workerKey, tick), 200, &selected)
	if selected.Job == nil || selected.Job.OperationID != targeted.ID {
		t.Fatal("an older open request outranked a targeted request")
	}
	nativeResponse(t, nativePost(second, "/api/v1/worker/pull", otherKey, tick), 200, &untargeted)
	if untargeted.Job == nil || untargeted.Job.OperationID != open.ID {
		t.Fatal("a sibling worker did not get the oldest open request")
	}
	grant := selected.Job
	_, err := second.Broker.CancelRequest(t.Context(), second.Logger, "client-a", targeted.ID, targeted.SessionID, inference.Cancel{Version: 1, SubmissionID: "cancel-issued-claim"})
	if err != nil {
		t.Fatal(err)
	}
	jobPath := "/api/v1/worker/jobs/" + grant.JobID
	start := inference.WorkStart{Version: 1, ClaimID: grant.ClaimID, Generation: grant.Generation, LaunchID: "cancelled-launch", NativeJob: "cancelled-native"}
	nativeResponse(t, nativePost(first, jobPath+"/start", workerKey, start), 409, nil)
	var outcome inference.WorkOutcome
	settlement := inference.Interruption{Version: 1, SubmissionID: "confirmed-no-start", ClaimID: grant.ClaimID, Generation: grant.Generation,
		LaunchID: start.LaunchID, NativeJob: start.NativeJob, Reason: "native_cancelled_before_start"}
	nativeResponse(t, nativePost(second, jobPath+"/interrupt", workerKey, settlement), 200, &outcome)
	if outcome.State != "cancelled" || outcome.ClaimID != grant.ClaimID {
		t.Fatal("unstarted native cancellation replaced the client cancellation")
	}
	nativeResponse(t, nativePost(first, jobPath+"/start", workerKey, start), 409, nil)
}

func TestNativePullExpiredBeforeHandoffRemainsHeldUntilSettlement(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	path := filepath.Join(root, "broker.sqlite3")
	handler := pullHTTPClock(t, path, func() time.Time { return now })
	key := enrollNative(t, handler)
	queued, err := handler.Broker.SubmitRequest(t.Context(), handler.Logger, "client-a", "expiry", inference.RequestInput{
		Version: 1, SubmissionID: "expiry", TimeoutSeconds: 1, Messages: []inference.Item{{Type: "message", Role: "user", Text: "should not run"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var result inference.PullResult
	const pullPath = "/api/v1/worker/pull"
	tick := inference.Pull{Version: 1, Sequence: 1, Checker: "checker", Occurrence: "first-tick", ScheduledAt: now, EnteredAt: now}
	nativeResponse(t, nativePost(handler, pullPath, key, tick), 200, &result)
	if result.Job == nil || result.Job.OperationID != queued.ID {
		t.Fatal("short request was not claimed before expiry")
	}
	grant := result.Job
	job := "/api/v1/worker/jobs/" + grant.JobID
	start := inference.WorkStart{Version: 1, ClaimID: grant.ClaimID, Generation: grant.Generation, LaunchID: "expired-launch", NativeJob: "native-work"}
	invalid := start
	invalid.Version = 2
	nativeResponse(t, nativePost(handler, job+"/start", key, invalid), 400, nil)
	settlement := inference.Interruption{Version: 1, SubmissionID: "never-launched", ClaimID: grant.ClaimID, Generation: grant.Generation, LaunchID: start.LaunchID, Reason: "launch_not_authorized"}
	nativeResponse(t, nativePost(handler, job+"/interrupt", key, settlement), 409, nil)
	now = grant.DeadlineAt
	if err = handler.Broker.Sweep(t.Context(), handler.Logger); err != nil {
		t.Fatal(err)
	}
	nativeResponse(t, nativePost(handler, job+"/start", key, start), 409, nil)
	var status workerView
	nativeResponse(t, call(handler, http.MethodGet, "/api/v1/worker/status", "Bearer "+key, nil), 200, &status)
	if status.Claim == nil || status.ClaimStage != "recovery_pending" || status.Claim.ClaimID != grant.ClaimID {
		t.Fatal("deadline cleared the pending local hold before reconciliation")
	}
	var outcome inference.WorkOutcome
	nativeResponse(t, nativePost(handler, job+"/interrupt", key, settlement), 200, &outcome)
	if outcome.State != "interrupted" || outcome.Reason != "deadline_exceeded" {
		t.Fatal("settlement overwrote the authoritative expiry")
	}
	nativeResponse(t, call(handler, http.MethodGet, "/api/v1/worker/status", "Bearer "+key, nil), 200, &status)
	if status.Claim != nil || status.WorkStatus != "idle" {
		t.Fatal("confirmed unlaunched claim did not release its hold")
	}
}

func TestNativeSweepExpiresQueueAndReleasesUntouchedPinAcrossBrokers(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	clock := func() time.Time { return now }
	path := filepath.Join(root, "broker.sqlite3")
	first, second := pullHTTPClock(t, path, clock), pullHTTPClock(t, path, clock)
	pinnedKey, nextKey := enrollNative(t, first), enrollNative(t, second)
	client := "client-a"
	firstMessage := inference.Item{Type: "message", Role: "user", Text: "previous question"}
	previousAnswer := inference.Item{Type: "final", Text: "previous answer"}
	previous, err := first.Broker.SubmitRequest(t.Context(), first.Logger, client, "pin", inference.RequestInput{
		Version: 1, SubmissionID: "first-turn", Messages: []inference.Item{firstMessage}, Tools: []inference.Tool{},
	})
	if err != nil {
		t.Fatal(err)
	}
	tick := inference.Pull{Version: 1, Sequence: 1, Checker: "checker-a", Occurrence: "tick-a", ScheduledAt: now, EnteredAt: now}
	var pull inference.PullResult
	nativeResponse(t, nativePost(first, "/api/v1/worker/pull", pinnedKey, tick), 200, &pull)
	if pull.Job == nil || pull.Job.OperationID != previous.ID {
		t.Fatal("worker did not claim the initial turn")
	}
	claimed := *pull.Job
	jobPath := "/api/v1/worker/jobs/" + claimed.JobID
	start := inference.WorkStart{Version: 1, ClaimID: claimed.ClaimID, Generation: claimed.Generation, LaunchID: "launch-old", NativeJob: "native-old"}
	var brief inference.Job
	nativeResponse(t, nativePost(second, jobPath+"/start", pinnedKey, start), 200, &brief)
	nativeResponse(t, nativePost(first, jobPath+"/decisions", pinnedKey, inference.Submit{Claim: inference.Claim{Version: 1, SubmissionID: "answer-old"},
		Generation: claimed.Generation, LeaseID: claimed.ClaimID, ConversationID: brief.ConversationID, ContextReceiptID: brief.Context.ReceiptID,
		Decision: previousAnswer}), 200, nil)
	nativeResponse(t, nativePost(second, jobPath+"/interrupt", pinnedKey, inference.Interruption{Version: 1, SubmissionID: "settle-old",
		ClaimID: claimed.ClaimID, Generation: claimed.Generation, LaunchID: start.LaunchID, NativeJob: start.NativeJob, NativeRun: "execution-old",
		Reason: "execution_confirmed_stopped"}), 200, nil)

	active, err := first.Broker.SubmitRequest(t.Context(), first.Logger, client, "unrelated", inference.RequestInput{
		Version: 1, SubmissionID: "unrelated-turn", Messages: []inference.Item{firstMessage}, TimeoutSeconds: 1800,
	})
	if err != nil {
		t.Fatal(err)
	}
	tick.Sequence, tick.Occurrence = 2, "unrelated-pull"
	now = now.Add(time.Second)
	tick.ScheduledAt, tick.EnteredAt = now, now
	nativeResponse(t, nativePost(first, "/api/v1/worker/pull", pinnedKey, tick), 200, &pull)
	if pull.Job == nil || pull.Job.OperationID != active.ID {
		t.Fatal("worker did not retain a separate, long-running claim")
	}
	busy := *pull.Job
	now = now.Add(9 * time.Minute)
	queued, err := first.Broker.SubmitRequest(t.Context(), first.Logger, client, "pin", inference.RequestInput{
		Version: 1, SubmissionID: "next-turn", Messages: []inference.Item{firstMessage, {Type: "message", Role: "assistant", Text: previousAnswer.Text},
			{Type: "message", Role: "user", Text: "continue this session"}}, Tools: []inference.Tool{},
	})
	if err != nil || queued.State != "queued" {
		t.Fatal("pinned turn was not durably admitted", err)
	}
	expiring, err := first.Broker.SubmitRequest(t.Context(), first.Logger, client, "expires", inference.RequestInput{
		Version: 1, SubmissionID: "expires", Messages: []inference.Item{firstMessage}, TimeoutSeconds: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	nativeResponse(t, nativePost(first, "/api/v1/worker/jobs/"+busy.JobID+"/presence", pinnedKey, inference.BusyCheck{
		Version: 1, ClaimID: busy.ClaimID, Generation: busy.Generation, Checker: tick.Checker, Occurrence: "fresh-busy-check", ScheduledAt: now,
	}), 200, nil)
	now = now.Add(time.Minute)
	var evidence bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&evidence, nil))
	if err = second.Broker.Sweep(t.Context(), logger); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(evidence.Bytes(), []byte(`"msg":"job.deadline_exceeded"`)) || !bytes.Contains(evidence.Bytes(), []byte(expiring.ID)) ||
		!bytes.Contains(evidence.Bytes(), []byte(`"msg":"dispatch.pin_released"`)) || !bytes.Contains(evidence.Bytes(), []byte(queued.ID)) {
		t.Fatal("sweep did not commit expiry and untouched pin release without a pull")
	}
	tick.Sequence, tick.Checker, tick.Occurrence, tick.ScheduledAt, tick.EnteredAt = 1, "checker-b", "tick-b", now, now
	nativeResponse(t, nativePost(second, "/api/v1/worker/pull", nextKey, tick), 200, &pull)
	if pull.Job == nil || pull.Job.OperationID != queued.ID {
		t.Fatal("another worker could not claim the released continuation")
	}
	start.ClaimID, start.Generation, start.LaunchID, start.NativeJob = pull.Job.ClaimID, pull.Job.Generation, "launch-next", "native-next"
	nativeResponse(t, nativePost(first, "/api/v1/worker/jobs/"+pull.Job.JobID+"/start", nextKey, start), 200, &brief)
	if len(brief.Context.Messages) != 3 || brief.Context.Messages[1].Text != previousAnswer.Text {
		t.Fatal("pin replacement did not retain the canonical prior decision")
	}
}

func TestNativePullRollsBackWhenClaimOrReceiptCannotCommit(t *testing.T) {
	for _, write := range []string{
		"UPDATE ON aaa_inference_jobs",
		"INSERT ON aaa_conversation_events",
		"INSERT ON aaa_worker_polls",
		"UPDATE OF last_contact_at ON aaa_workers",
	} {
		t.Run(write, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Chmod(root, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, "broker.sqlite3")
			handler := pullHTTP(t, path)
			key := enrollNative(t, handler)
			queued, err := handler.Broker.SubmitRequest(t.Context(), handler.Logger, "client-a", "rollback", inference.RequestInput{
				Version: 1, SubmissionID: "rollback", Messages: []inference.Item{{Type: "message", Role: "user", Text: "fixture"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err = db.ExecContext(t.Context(), "CREATE TRIGGER pull_write_failure BEFORE "+write+" BEGIN SELECT RAISE(ABORT, 'controlled storage failure'); END"); err != nil {
				t.Fatal(err)
			}
			stamp := time.Now().UTC()
			tick := inference.Pull{Version: 1, Sequence: 1, Checker: "checker", Occurrence: "controlled-rollback", ScheduledAt: stamp, EnteredAt: stamp}
			failed := nativePost(handler, "/api/v1/worker/pull", key, tick)
			nativeResponse(t, failed, 503, nil)
			var jobs, receipts int
			if err = db.QueryRowContext(t.Context(), "SELECT count(*) FROM aaa_inference_jobs WHERE held=1").Scan(&jobs); err != nil {
				t.Fatal(err)
			}
			if err = db.QueryRowContext(t.Context(), "SELECT count(*) FROM aaa_worker_polls").Scan(&receipts); err != nil || jobs != 0 || receipts != 0 {
				t.Fatal("a failed pull write leaked a durable claim or receipt", jobs, receipts, err)
			}
			if _, err = db.ExecContext(t.Context(), "DROP TRIGGER pull_write_failure"); err != nil {
				t.Fatal(err)
			}
			var result inference.PullResult
			accepted := nativePost(handler, "/api/v1/worker/pull", key, tick)
			nativeResponse(t, accepted, 200, &result)
			if result.Job == nil || result.Job.OperationID != queued.ID || result.Job.Generation != 1 {
				t.Fatal("exact retry did not reserve the original queued job once")
			}
			replay := nativePost(handler, "/api/v1/worker/pull", key, tick)
			if replay.Code != 200 || !bytes.Equal(replay.Body.Bytes(), accepted.Body.Bytes()) {
				t.Fatal("a committed pull retry did not replay its original grant")
			}
		})
	}
}

func TestNativePullAndSweepFailClosedOnUnavailableStorage(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "broker.sqlite3")
	stamp := time.Now().UTC()
	repo, err := sqlite.Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repo.Close)
	if err = repo.Bootstrap(t.Context()); err != nil {
		t.Fatal(err)
	}
	first := pullHTTP(t, path)
	key := enrollNative(t, first)
	queued, err := first.Broker.SubmitRequest(t.Context(), first.Logger, "client-a", "unavailable", inference.RequestInput{
		Version: 1, SubmissionID: "unavailable", Messages: []inference.Item{{Type: "message", Role: "user", Text: "keep queued"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var view string
	if err = db.QueryRowContext(t.Context(), "SELECT sql FROM sqlite_schema WHERE name='aaa_pull_levels'").Scan(&view); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(t.Context(), "DROP VIEW aaa_pull_levels"); err != nil {
		t.Fatal(err)
	}
	tick := inference.Pull{Version: 1, Sequence: 1, Checker: "checker", Occurrence: "exact-retry", ScheduledAt: stamp, EnteredAt: stamp}
	nativeResponse(t, nativePost(first, "/api/v1/worker/pull", key, tick), 503, nil)
	if _, err = db.ExecContext(t.Context(), view); err != nil {
		t.Fatal(err)
	}
	repo.Close()
	broker := service.NewBroker(repo, rand.Reader, time.Now, nil)
	var evidence bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&evidence, nil))
	if err = broker.Sweep(t.Context(), logger); err == nil || !bytes.Contains(evidence.Bytes(), []byte("inference.sweep_failed")) {
		t.Fatal("sweep ignored unavailable storage", err)
	}
	if result, _, err := broker.PullWork(t.Context(), logger, key, tick); err == nil || result.Job != nil {
		t.Fatal("storage failure granted work", result, err)
	}
	var result inference.PullResult
	nativeResponse(t, nativePost(first, "/api/v1/worker/pull", key, tick), 200, &result)
	if result.Job == nil || result.Job.OperationID != queued.ID {
		t.Fatal("lookup failure consumed the poll or queued request")
	}
}
