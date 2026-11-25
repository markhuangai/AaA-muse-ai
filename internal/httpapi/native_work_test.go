package httpapi

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/media"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func TestVerifiedHookWorkAcrossBrokers(t *testing.T) {
	root := mediaSQLiteDirectory(t)
	now := time.Now().UTC().Truncate(time.Second)
	database := filepath.Join(root, "shared.sqlite3")
	clock := func() time.Time { return now }
	first := pullHTTPClock(t, database, clock)
	second, store := openPullHTTP(t, database, clock)
	fixture, err := sql.Open("sqlite", database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fixture.Close() })
	write := func(statement string) {
		t.Helper()
		if _, err := fixture.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	first.Broker.Media, second.Broker.Media = media.New(root), media.New(root)
	key := enrollNative(t, first)
	stranger := enrollNative(t, first)
	const client = "client-private-sentinel"
	var created service.MediaStatus
	nativeResponse(t, submitVideo(first, client, "verified-video", 1800), 202, &created)

	pull := func(h *Handler, sequence int64, occurrence string, version ...string) *httptest.ResponseRecorder {
		t.Helper()
		raw, err := json.Marshal(inference.Pull{Version: 1, Sequence: sequence, Checker: "checker-job", Occurrence: occurrence,
			ScheduledAt: now, EnteredAt: now, MediaJobs: true})
		if err != nil {
			t.Fatal(err)
		}
		request := pairedRequest(h, http.MethodPost, workerPullRoute, bytes.NewReader(raw))
		request.Header.Set("Authorization", "Bearer "+key)
		request.Header.Del("X-Muse-Worker-Hook-Proof")
		for _, value := range version {
			request.Header.Add("X-Muse-Worker-Hook-Proof", value)
		}
		reply := httptest.NewRecorder()
		h.ServeHTTP(reply, request)
		return reply
	}
	nativeResponse(t, pull(first, 1, "checker-tick", "wrong"), 400, nil)
	nativeResponse(t, pull(first, 1, "checker-tick", "1", "1"), 400, nil)
	write(`CREATE TRIGGER fail_grant_write BEFORE INSERT ON aaa_inference_receipts
		WHEN NEW.principal LIKE 'native-work:%' BEGIN SELECT RAISE(ABORT, 'test grant write failure'); END`)
	nativeResponse(t, pull(first, 1, "checker-tick", "1"), 503, nil)
	write("DROP TRIGGER fail_grant_write")
	var picked inference.PullResult
	grantReply := pull(first, 1, "checker-tick", "1")
	nativeResponse(t, grantReply, 200, &picked)
	grant := picked.Job
	if grant == nil || grant.JobID != created.ID || !strings.HasPrefix(grant.ClaimID, inference.HookClaimPrefix) || len(grant.ClaimID) != len(inference.HookClaimPrefix)+32 {
		t.Fatalf("incorrect verified grant: %+v", grant)
	}
	if replay := pull(second, 1, "checker-tick", "1"); !bytes.Equal(replay.Body.Bytes(), grantReply.Body.Bytes()) {
		t.Fatal("an exact replay changed the granted contract")
	}

	route := "/api/v1/worker/jobs/" + grant.JobID
	proof := inference.NativeStartProof{Reference: grant.ClaimID, NativeJob: "checker-job", NativeRun: "event-hook-rebound", Status: "running"}
	start := inference.WorkStart{Version: 1, ClaimID: grant.ClaimID, Generation: grant.Generation, LaunchID: "launch-attempt", NativeJob: proof.NativeJob}
	var missing map[string]string
	nativeResponse(t, versionedHTTP(second, "POST", route+"/start", key, testBuildContact(second), start), 409, &missing)
	if missing["error"] != "native_start_proof_required" || len(missing) != 1 {
		t.Fatalf("unverified start disclosed work: %v", missing)
	}
	for _, invalid := range []inference.NativeStartProof{
		{Reference: "other-claim", NativeJob: proof.NativeJob, NativeRun: proof.NativeRun, Status: "running"},
		{Reference: proof.Reference, NativeJob: "wrong-parent", NativeRun: proof.NativeRun, Status: "running"},
		{Reference: proof.Reference, NativeJob: proof.NativeJob, NativeRun: proof.NativeJob, Status: "running"},
		{Reference: proof.Reference, NativeJob: proof.NativeJob, NativeRun: "checker-tick", Status: "running"},
		{Reference: proof.Reference, NativeJob: proof.NativeJob, NativeRun: proof.NativeRun, Status: "queued"},
	} {
		start.Verification = &invalid
		nativeResponse(t, nativePost(second, route+"/start", key, start), 409, nil)
	}
	start.NativeJob = "wrong-job"
	wrongJob := proof
	wrongJob.NativeJob = start.NativeJob
	start.Verification = &wrongJob
	nativeResponse(t, nativePost(second, route+"/start", key, start), 409, nil)
	start.NativeJob, start.Verification = proof.NativeJob, &proof
	bind := inference.WakeBinding{Version: 1, SubmissionID: "binding", ClaimID: grant.ClaimID, Generation: grant.Generation,
		Checker: "checker-job", Previous: "checker-tick", Invocation: "rebound"}
	nativeResponse(t, nativePost(second, route+"/bind", stranger, bind), 404, nil)
	refuse := func(path string, input inference.WakeBinding, status int, cause string) {
		t.Helper()
		var failure map[string]string
		nativeResponse(t, nativePost(second, path+"/bind", key, input), status, &failure)
		if failure["error"] != cause || len(failure) != 1 {
			t.Fatalf("binding refusal returned %v, want %s", failure, cause)
		}
	}
	invalid := bind
	invalid.SubmissionID = ""
	refuse(route, invalid, 400, "invalid_submission_id")
	invalid = bind
	invalid.Invocation = invalid.Previous
	refuse(route, invalid, 400, "invalid_hook_binding")
	invalid = bind
	invalid.Generation++
	refuse(route, invalid, 409, "stale_assignment")
	invalid = bind
	invalid.Previous = "other-tick"
	refuse(route, invalid, 409, "hook_binding_conflict")

	var principal string
	var stored []byte
	if err := fixture.QueryRowContext(t.Context(), "SELECT principal,data FROM aaa_inference_receipts WHERE submission_id=?1", grant.ClaimID).Scan(&principal, &stored); err != nil {
		t.Fatal(err)
	}
	write("UPDATE aaa_inference_receipts SET data=CAST('unreadable' AS BLOB) WHERE submission_id LIKE 'hook-%'")
	presence := inference.BusyCheck{Version: 1, ClaimID: grant.ClaimID, Generation: grant.Generation, Checker: bind.Checker, Occurrence: "busy-tick", ScheduledAt: now}
	nativeResponse(t, pull(second, 1, "checker-tick", "1"), 503, nil)
	refuse(route, bind, 503, "service_unavailable")
	nativeResponse(t, nativePost(second, route+"/presence", key, presence), 503, nil)
	write("DELETE FROM aaa_inference_receipts WHERE submission_id LIKE 'hook-%'")
	refuse(route, bind, 409, "hook_claim_required")
	if _, err := fixture.ExecContext(t.Context(), "INSERT INTO aaa_inference_receipts(principal,submission_id,data) VALUES(?1,?2,?3)",
		principal, grant.ClaimID, stored); err != nil {
		t.Fatal(err)
	}
	bound := nativePost(second, route+"/bind", key, bind)
	nativeResponse(t, bound, 200, nil)
	if replay := nativePost(first, route+"/bind", key, bind); !bytes.Equal(replay.Body.Bytes(), bound.Body.Bytes()) {
		t.Fatal("binding reply changed on replay")
	}
	prior := proof
	prior.NativeRun = "event-hook-checker-tick"
	start.Verification = &prior
	nativeResponse(t, nativePost(first, route+"/start", key, start), 409, nil)
	start.Verification = &proof
	nativeResponse(t, nativePost(second, route+"/start", stranger, start), 404, nil)
	write(`CREATE TRIGGER fail_start_write BEFORE UPDATE ON aaa_inference_receipts
		WHEN NEW.principal LIKE 'native-work:%' BEGIN SELECT RAISE(ABORT, 'test start write failure'); END`)
	nativeResponse(t, nativePost(second, route+"/start", key, start), 503, nil)
	write("DROP TRIGGER fail_start_write")
	var status workerView
	nativeResponse(t, call(first, http.MethodGet, "/api/v1/worker/status", "Bearer "+key, nil), 200, &status)
	if status.ClaimStage != "pending_native_start" {
		t.Fatalf("a refused start consumed the grant: %+v", status)
	}
	var brief inference.Job
	nativeResponse(t, nativePost(second, route+"/start", key, start), 200, &brief)
	nativeResponse(t, nativePost(first, route+"/start", key, start), 409, nil)
	if brief.NativeJob != proof.NativeJob || brief.Media == nil || brief.LeaseID != grant.ClaimID {
		t.Fatal("verified start did not return the assigned brief")
	}
	invalid = bind
	invalid.SubmissionID, invalid.Previous, invalid.Invocation = "late-bind", bind.Invocation, "new-wake"
	refuse(route, invalid, 409, "hook_binding_conflict")
	video := mediaVideoFixture(t)
	nativeResponse(t, uploadVideo(first, key, grant, video), 200, nil)
	store.Close()
	second = pullHTTPClock(t, database, clock)
	second.Broker.Media = media.New(root)
	now = grant.DeadlineAt.Add(time.Second)
	stop := inference.Interruption{Version: 1, SubmissionID: "verified-stop", ClaimID: grant.ClaimID, Generation: grant.Generation,
		LaunchID: start.LaunchID, NativeJob: proof.NativeJob, NativeRun: "foreign-run", Reason: "execution_confirmed_stopped"}
	nativeResponse(t, versionedHTTP(second, "POST", route+"/interrupt", key, testBuildContact(second), stop), 409, nil)
	stop.VerifiedStart = true
	nativeResponse(t, nativePost(second, route+"/interrupt", key, stop), 409, nil)
	nativeResponse(t, call(first, http.MethodGet, "/api/v1/worker/status", "Bearer "+key, nil), 200, &status)
	if status.ClaimStage != "terminal_receipt" {
		t.Fatal("wrong run cleared the worker's accepted result hold")
	}
	stop.NativeRun = proof.NativeRun
	var outcome inference.WorkOutcome
	settled := nativePost(second, route+"/interrupt", key, stop)
	nativeResponse(t, settled, 200, &outcome)
	if replay := nativePost(first, route+"/interrupt", key, stop); !bytes.Equal(replay.Body.Bytes(), settled.Body.Bytes()) || outcome.State != "accepted" || len(outcome.Accepted) == 0 {
		t.Fatal("settlement replay changed the accepted result")
	}
	stop.NativeRun = "different-replay"
	nativeResponse(t, nativePost(first, route+"/interrupt", key, stop), 409, nil)
	stop.SubmissionID, stop.NativeRun = "distinct-duplicate", proof.NativeRun
	nativeResponse(t, nativePost(first, route+"/interrupt", key, stop), 409, nil)
	nativeResponse(t, submitVideo(first, client, "next-video", 1800), 202, &created)
	nativeResponse(t, pull(second, 2, "later-tick", "1"), 200, &picked)
	if picked.Job == nil || picked.Job.JobID != created.ID {
		t.Fatal("settled slot failed to pick up the next job")
	}
	var cancelled inference.Experiment
	nativeResponse(t, nativePost(first, "/api/v1/admin/experiments/"+picked.Job.OperationID+"/cancel", testManagementKey,
		inference.Cancel{Version: 1, SubmissionID: "before-wake-cancel"}), 200, &cancelled)
	if cancelled.State != "cancelled" {
		t.Fatal("cancelled fixture did not reach its terminal state")
	}
	nextWork := workerPrefix + "jobs/" + picked.Job.JobID
	refuse(nextWork, inference.WakeBinding{Version: 1, SubmissionID: "terminal-bind", ClaimID: picked.Job.ClaimID, Generation: picked.Job.Generation,
		Checker: bind.Checker, Previous: "later-tick", Invocation: "terminal-wake"}, 409, "hook_claim_terminal")
	nativeResponse(t, nativePost(first, nextWork+"/start", key, inference.WorkStart{Version: 1, ClaimID: picked.Job.ClaimID,
		Generation: picked.Job.Generation, LaunchID: "next-launch", NativeJob: bind.Checker}), 409, nil)
	unstarted := inference.Interruption{Version: 1, SubmissionID: "unstarted-stop", ClaimID: picked.Job.ClaimID,
		Generation: picked.Job.Generation, LaunchID: "next-launch", NativeJob: "later-tick",
		NativeRun: "event-hook-wrong", Reason: "execution_confirmed_stopped", VerifiedStart: true}
	route = nextWork + "/interrupt"
	nativeResponse(t, nativePost(first, route, key, unstarted), 409, nil)
	unstarted.NativeJob, unstarted.NativeRun = "checker-job", "event-hook-later-tick"
	nativeResponse(t, nativePost(first, route, key, unstarted), 200, &outcome)
	nativeResponse(t, call(first, http.MethodGet, workerStatusRoute, "Bearer "+key, nil), 200, &status)
	if outcome.JobID != picked.Job.JobID || outcome.ClaimID != picked.Job.ClaimID || outcome.State != "cancelled" ||
		outcome.Reason != "operator_cancelled" || status.WorkStatus != "idle" {
		t.Fatal("settlement did not preserve the cancelled result and release its hold")
	}
}
