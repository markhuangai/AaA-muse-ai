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

func TestVerifiedNativeWorkAcrossBrokers(t *testing.T) {
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
		request := httptest.NewRequest(http.MethodPost, "/api/v1/worker/pull", bytes.NewReader(raw))
		request.Header.Set("Authorization", "Bearer "+key)
		request.Header.Set(service.WorkerVersionHeader, service.DevelopmentVersion)
		for _, value := range version {
			request.Header.Add("X-Muse-Worker-Start-Proof", value)
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
	if grant == nil || grant.JobID != created.ID || !strings.HasPrefix(grant.ClaimID, "verified-") || len(grant.ClaimID) != len("verified-")+32 {
		t.Fatalf("incorrect verified grant: %+v", grant)
	}
	if replay := pull(second, 1, "checker-tick"); !bytes.Equal(replay.Body.Bytes(), grantReply.Body.Bytes()) {
		t.Fatal("an exact replay changed the granted contract")
	}

	route := "/api/v1/worker/jobs/" + grant.JobID
	proof := inference.NativeStartProof{Reference: grant.ClaimID, NativeJob: "work-once", NativeRun: "work-run", Status: "running"}
	start := inference.WorkStart{Version: 1, ClaimID: grant.ClaimID, Generation: grant.Generation, LaunchID: "launch-attempt", NativeJob: "work-once"}
	var missing map[string]string
	nativeResponse(t, nativePost(second, route+"/start", key, start), 409, &missing)
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
	start.NativeJob = "checker-job"
	wrongJob := proof
	wrongJob.NativeJob = start.NativeJob
	start.Verification = &wrongJob
	nativeResponse(t, nativePost(second, route+"/start", key, start), 409, nil)
	start.NativeJob, start.Verification = proof.NativeJob, &proof
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
	video := mediaVideoFixture(t)
	nativeResponse(t, uploadVideo(first, key, grant, video), 200, nil)
	store.Close()
	second = pullHTTPClock(t, database, clock)
	second.Broker.Media = media.New(root)
	now = grant.DeadlineAt.Add(time.Second)
	stop := inference.Interruption{Version: 1, SubmissionID: "verified-stop", ClaimID: grant.ClaimID, Generation: grant.Generation,
		LaunchID: start.LaunchID, NativeJob: proof.NativeJob, NativeRun: "foreign-run", Reason: "execution_confirmed_stopped"}
	nativeResponse(t, nativePost(second, route+"/interrupt", key, stop), 409, nil)
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
	unstarted := inference.Interruption{Version: 1, SubmissionID: "unstarted-stop", ClaimID: picked.Job.ClaimID,
		Generation: picked.Job.Generation, LaunchID: "next-launch", NativeJob: "later-tick",
		Reason: "native_cancelled_before_start", VerifiedStart: true}
	route = "/api/v1/worker/jobs/" + picked.Job.JobID + "/interrupt"
	nativeResponse(t, nativePost(first, route, key, unstarted), 409, nil)
	unstarted.NativeJob = "cancelled-native-job"
	nativeResponse(t, nativePost(first, route, key, unstarted), 200, &outcome)
	if outcome.State != "interrupted" || outcome.Reason != "native_cancelled_before_start" {
		t.Fatal("verified cancellation before start did not settle the next claim")
	}
}
