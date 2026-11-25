package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func testBuildContact(h *Handler) worker.Contact {
	build := h.Service.Build()
	return worker.Contact{Version: build.Version, Digest: build.WorkerPackage.SHA256, Contract: worker.UpdateContract}
}

func TestExactPairBeforeEnrollment(t *testing.T) {
	h, store, out, _ := workerHTTPFixture(t)
	code := issueHTTP(t, h)
	body := map[string]string{"enrollment_code": code, "phase": "prepare"}
	matching := testBuildContact(h)
	for _, contact := range []worker.Contact{{Version: "1.0.0"}, {Version: "1.0.0", Contract: matching.Contract, Digest: matching.Digest},
		{Version: matching.Version, Contract: matching.Contract, Digest: strings.Repeat("b", 64)}} {
		nativeResponse(t, versionedHTTP(h, "POST", workerEnrollRoute, "", contact, body), 426, nil)
	}
	for _, versions := range [][]string{{""}, {"bad"}, {matching.Version, matching.Version}} {
		raw, _ := json.Marshal(body)
		r := pairedRequest(h, "POST", workerEnrollRoute, bytes.NewReader(raw))
		r.Header[service.WorkerVersionHeader] = versions
		response := httptest.NewRecorder()
		h.ServeHTTP(response, r)
		nativeResponse(t, response, 400, nil)
	}
	if len(store.records) != 0 || len(store.staged) != 0 {
		t.Fatal("version refusal changed enrollment authority")
	}
	enrollHTTP(t, h, code)
	if !strings.Contains(out.String(), "worker.update_required") || strings.Contains(out.String(), code) {
		t.Fatal("compatibility diagnosis missing or secret exposed")
	}
}

func TestExactPairProtectsWorkAndReceipts(t *testing.T) {
	now := time.Now().UTC()
	clock := func() time.Time { return now }
	path := filepath.Join(mediaSQLiteDirectory(t), "broker.sqlite3")
	old, oldRepo := openPullHTTP(t, path, clock)
	newer, newerRepo := openPullHTTP(t, path, clock)
	setUpdateBuild(t, old, oldRepo, clock, "old", "1.1.1", "a", "")
	setUpdateBuild(t, newer, newerRepo, clock, "newer", "1.1.2", "b", "")
	previous, current := testBuildContact(old), testBuildContact(newer)
	key := enrollNative(t, old)
	request, err := old.Broker.SubmitRequest(t.Context(), old.Logger, "client", "pair", inference.RequestInput{
		Version: 1, SubmissionID: "pair-job", Messages: []inference.Item{{Type: "message", Role: "user", Text: "private brief"}}, Tools: []inference.Tool{},
	})
	if err != nil {
		t.Fatal(err)
	}
	poll := inference.Pull{Version: 1, Sequence: 1, Checker: "hook-id", Occurrence: "invocation", ScheduledAt: now, EnteredAt: now}
	var granted inference.PullResult
	nativeResponse(t, versionedHTTP(old, "POST", workerPullRoute, key, previous, poll), 200, &granted)
	if granted.Job == nil || granted.Job.OperationID != request.ID {
		t.Fatal("exact pair did not grant work")
	}
	nativeResponse(t, versionedHTTP(newer, "POST", workerPullRoute, key, previous, poll), 426, nil)
	nativeResponse(t, versionedHTTP(newer, "POST", workerPullRoute, key, current, poll), 409, nil)
	grant := granted.Job
	jobPath := workerPrefix + "jobs/" + grant.JobID
	start := pairedTestStart(inference.WorkStart{Version: 1, ClaimID: grant.ClaimID, Generation: grant.Generation, LaunchID: "pair-launch"})
	for _, request := range []struct{ method, suffix string }{
		{"POST", "/bind"}, {"POST", "/start"}, {"POST", "/presence"}, {"POST", "/interrupt"}, {"POST", "/decisions"},
		{"GET", "/media/prompt"}, {"GET", "/media/image"}, {"GET", "/media/receipt"}, {"PUT", "/artifact"},
	} {
		nativeResponse(t, versionedHTTP(newer, request.method, jobPath+request.suffix, key, previous, start), 426, nil)
	}
	nativeResponse(t, versionedHTTP(newer, "POST", jobPath+"/start", key, current, start), 409, nil)
	nativeResponse(t, versionedHTTP(newer, "POST", jobPath+"/presence", key, current, inference.BusyCheck{
		Version: 1, ClaimID: grant.ClaimID, Generation: grant.Generation, Checker: poll.Checker, Occurrence: "different-pair", ScheduledAt: now,
	}), 409, nil)
	var brief inference.Job
	nativeResponse(t, versionedHTTP(old, "POST", jobPath+"/start", key, previous, start), 200, &brief)
	decision := inference.Submit{Claim: inference.Claim{Version: 1, SubmissionID: "pair-decision"}, ConversationID: brief.ConversationID,
		Generation: brief.Generation, LeaseID: brief.LeaseID, ContextReceiptID: brief.Context.ReceiptID,
		Decision: inference.Item{Type: "final", Text: "preserved result"}}
	accepted := versionedHTTP(old, http.MethodPost, jobPath+"/decisions", key, previous, decision)
	nativeResponse(t, accepted, 200, nil)
	nativeResponse(t, versionedHTTP(newer, http.MethodPost, jobPath+"/decisions", key, current, decision), 409, nil)
	replayed := versionedHTTP(old, http.MethodPost, jobPath+"/decisions", key, previous, decision)
	if replayed.Code != 200 || !bytes.Equal(accepted.Body.Bytes(), replayed.Body.Bytes()) {
		t.Fatal("matching pair could not reconcile accepted receipt")
	}
}
