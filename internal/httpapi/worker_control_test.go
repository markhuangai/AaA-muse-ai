package httpapi

import (
	"bytes"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func controlExchange(t *testing.T, h *Handler, method, path, key string, body any, headers map[string]string, status int, output any) *httptest.ResponseRecorder {
	t.Helper()
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := pairedRequest(h, method, path, bytes.NewReader(payload))
	if key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	nativeResponse(t, response, status, output)
	return response
}

func controlWorker(t *testing.T, h *Handler) (string, string) {
	t.Helper()
	key := enrollNative(t, h)
	var record workerView
	controlExchange(t, h, "GET", workerStatusRoute, key, nil, nil, 200, &record)
	return key, record.ID
}

func controlPull(t *testing.T, h *Handler, key string, now time.Time, seq int64, capabilities bool) inference.PullResult {
	t.Helper()
	headers := map[string]string{}
	if capabilities {
		headers[worker.AgentTasksHeader] = "1"
	}
	var result inference.PullResult
	controlExchange(t, h, "POST", workerPullRoute, key, inference.Pull{Version: 1, Sequence: seq, Checker: "controlled-hook",
		Occurrence: fmt.Sprint("tick-", seq), ScheduledAt: now, EnteredAt: now}, headers, 200, &result)
	return result
}

func controlOp(kind, id string) worker.OpRequest {
	return worker.OpRequest{ControlRequest: worker.ControlRequest{Version: 1, SubmissionID: id}, Kind: kind}
}

func controlReason(t *testing.T, response *httptest.ResponseRecorder, reason string) {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Error != reason {
		t.Fatalf("wanted reason %s, got %q (%v)", reason, body.Error, err)
	}
}

func TestPairedWorkerControlPreservesSlotsReceiptsAndOwner(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	clock := func() time.Time { return now }
	path := filepath.Join(mediaSQLiteDirectory(t), "broker.sqlite3")
	h, sibling := pullHTTPClock(t, path, clock), pullHTTPClock(t, path, clock)
	key, id := controlWorker(t, h)
	other, otherID := controlWorker(t, h)
	root := adminWorkerPrefix + id
	var item worker.ControlItem
	admin := testManagementKey
	prompt := worker.TaskRequest{ControlRequest: worker.ControlRequest{Version: 1, SubmissionID: "task-one"}, Prompt: "Read the controlled fixture", Title: "Check"}
	controlExchange(t, h, "POST", root+"/agent-tasks", admin, prompt, nil, 409, nil)
	controlExchange(t, h, "GET", root+"/hook-prompt", admin, nil, nil, 200, nil)
	op := controlOp(worker.Doctor, "doctor-one")
	opReceipt := controlExchange(t, h, "POST", root+"/ops", admin, op, nil, 202, &item)
	opID := item.ID
	replay := controlExchange(t, sibling, "POST", root+"/ops", admin, op, nil, 202, nil)
	if !bytes.Equal(replay.Body.Bytes(), opReceipt.Body.Bytes()) {
		t.Fatal("admin submission replay changed the worker operation")
	}
	grant := controlPull(t, h, key, now, 1, true)
	if grant.WorkerOp == nil || grant.WorkerOp.ID != opID || grant.AgentTask != nil || grant.Job != nil {
		t.Fatal("worker operation did not get the first slot")
	}
	if retry := controlPull(t, sibling, key, now, 1, true); retry.WorkerOp == nil || *retry.WorkerOp != *grant.WorkerOp {
		t.Fatal("pull replay changed the held worker operation")
	}
	var task worker.ControlItem
	controlExchange(t, sibling, "POST", root+"/agent-tasks", admin, prompt, nil, 202, &task)
	if task.Prompt != "" || task.State != "queued" {
		t.Fatal("agent task submission exposed its prompt in the summary")
	}
	controlExchange(t, sibling, "GET", adminWorkerPrefix+otherID+"/agent-tasks/"+task.ID, admin, nil, nil, 404, nil)
	now = now.Add(15 * time.Second)
	if held := controlPull(t, sibling, key, now, 2, true); held.AgentTask != nil || held.WorkerOp != nil || held.Job != nil {
		t.Fatal("sibling overbooked the held worker")
	}
	resultRoute := workerPrefix + "ops/" + opID + "/result"
	opResult := worker.ControlResult{Version: 1, SubmissionID: "op-answer", ClaimID: grant.WorkerOp.ClaimID, Generation: 1, Outcome: "succeeded",
		Result: json.RawMessage(`{"marker":"admin-private-sentinel","authorization":"Bearer abcdefghijklmnopqrstuvwxyz"}`)}
	controlExchange(t, h, "POST", resultRoute, other, opResult, nil, 404, nil)
	if result := controlExchange(t, h, "POST", resultRoute, key, opResult, map[string]string{service.WorkerDigestHeader: strings.Repeat("b", 64)}, 426, nil); result.Code != 426 {
		t.Fatal("skewed worker could submit authority")
	}
	controlExchange(t, h, "POST", resultRoute, key, opResult, nil, 200, nil)
	controlExchange(t, sibling, "POST", resultRoute, key, opResult, nil, 200, nil)
	opResult.Outcome = "failed"
	controlExchange(t, h, "POST", resultRoute, key, opResult, nil, 409, nil)
	controlExchange(t, h, "GET", root+"/ops/"+opID, admin, nil, nil, 200, &item)
	if item.Held || bytes.Contains(item.Result, []byte("private-sentinel")) || !bytes.Contains(item.Result, []byte("[REDACTED]")) {
		t.Fatal("the operation did not store a redacted result and release the slot")
	}

	now = now.Add(15 * time.Second)
	pull := controlPull(t, sibling, key, now, 3, true)
	if pull.AgentTask == nil || pull.AgentTask.ID != task.ID {
		t.Fatal("agent pickup did not follow completion of the worker operation")
	}
	var active workerView
	controlExchange(t, h, "GET", workerStatusRoute, key, nil, nil, 200, &active)
	if active.WorkStatus != "busy" || active.ActiveSlotLane != worker.AgentTask || active.CurrentAgentTask == nil ||
		active.CurrentAgentTask.ID != task.ID || active.CurrentAgentTask.Prompt != "" {
		t.Fatal("worker projection lost the held task or exposed its prompt")
	}
	p := workerPrefix + "agent-tasks/" + task.ID
	claim := pull.AgentTask.ClaimID
	binding := inference.WakeBinding{Version: 1, SubmissionID: "bind-task", ClaimID: claim, Generation: 1,
		Checker: "controlled-hook", Previous: "tick-3", Invocation: "tick-4"}
	wrongBinding := binding
	wrongBinding.Version = 2
	controlExchange(t, h, "POST", p+"/bind", key, wrongBinding, nil, 400, nil)
	wrongBinding = binding
	wrongBinding.Invocation = binding.Previous
	controlReason(t, controlExchange(t, h, "POST", p+"/bind", key, wrongBinding, nil, 400, nil), "invalid_hook_binding")
	wrongBinding = binding
	wrongBinding.Generation = 2
	controlReason(t, controlExchange(t, h, "POST", p+"/bind", key, wrongBinding, nil, 409, nil), "stale_assignment")
	wrongBinding = binding
	wrongBinding.Checker = "unrelated-checker"
	controlReason(t, controlExchange(t, h, "POST", p+"/bind", key, wrongBinding, nil, 409, nil), "hook_binding_conflict")
	controlExchange(t, h, "POST", p+"/bind", key, binding, nil, 200, nil)
	controlExchange(t, sibling, "POST", p+"/bind", key, binding, nil, 200, nil)
	binding.Invocation = "other-wake"
	controlExchange(t, h, "POST", p+"/bind", key, binding, nil, 409, nil)
	start := inference.WorkStart{Version: 1, ClaimID: claim, Generation: 1, LaunchID: "task-launch",
		NativeJob: "controlled-hook", Verification: &inference.NativeStartProof{Reference: claim, NativeJob: "controlled-hook", NativeRun: "event-hook-tick-3", Status: "running"}}
	wrongStart := start
	wrongStart.Version = 2
	controlReason(t, controlExchange(t, h, "POST", p+"/start", key, wrongStart, nil, 400, nil), "invalid_work_start")
	wrongStart = start
	wrongStart.Generation = 2
	controlReason(t, controlExchange(t, h, "POST", p+"/start", key, wrongStart, nil, 409, nil), "stale_assignment")
	controlExchange(t, h, "POST", p+"/start", key, start, nil, 409, nil)
	start.Verification.NativeRun = "event-hook-tick-4"
	var started worker.ControlItem
	controlExchange(t, sibling, "POST", p+"/start", key, start, nil, 200, &started)
	if started.Prompt != prompt.Prompt || !started.Held || started.DeliveryFinished == nil {
		t.Fatal("verified wake did not receive the authorized prompt")
	}
	now = now.Add(15 * time.Second)
	presence := inference.BusyCheck{Version: 1, ClaimID: claim, Generation: 1, Checker: "controlled-hook", Occurrence: "tick-5",
		ScheduledAt: now, Reason: "native_observation_pending"}
	controlExchange(t, h, "POST", p+"/presence", other, presence, nil, 404, nil)
	controlExchange(t, h, "POST", p+"/presence", "invalid-credential", presence, nil, 401, nil)
	controlExchange(t, h, "POST", p+"/presence", "muse_worker_"+strings.Repeat("B", 42)+"A", presence, nil, 401, nil)
	controlReason(t, controlExchange(t, h, "POST", p+"/presence", key, presence, map[string]string{worker.AgentTasksHeader: "0"}, 400, nil), "invalid_worker_capabilities")
	wrongPresence := presence
	wrongPresence.Version = 2
	controlReason(t, controlExchange(t, h, "POST", p+"/presence", key, wrongPresence, nil, 400, nil), "invalid_busy_check")
	wrongPresence = presence
	wrongPresence.Generation = 2
	controlReason(t, controlExchange(t, h, "POST", p+"/presence", key, wrongPresence, nil, 409, nil), "stale_assignment")
	var signal inference.PresenceReceipt
	controlExchange(t, h, "POST", p+"/presence", key, presence, map[string]string{worker.AgentTasksHeader: "1"}, 200, &signal)
	if !signal.Recorded || !signal.ReceivedAt.Equal(now) {
		t.Fatal("presence write did not use the task identity and database clock")
	}
	controlExchange(t, h, "POST", p+"/presence", key, presence, nil, 200, &signal)
	if signal.Recorded {
		t.Fatal("presence replay created a new observation")
	}

	taskResult := worker.TaskResult{Version: 1, SubmissionID: "failed-task", ClaimID: claim, Generation: 1, LaunchID: "task-launch",
		Outcome: "refused", Reason: "execution_refused", Summary: "A permission is required"}
	wrongResult := taskResult
	wrongResult.Version = 2
	controlExchange(t, h, "POST", p+"/result", key, wrongResult, nil, 400, nil)
	wrongResult = taskResult
	wrongResult.Outcome, wrongResult.Reason = "completed", ""
	controlReason(t, controlExchange(t, h, "POST", p+"/result", key, wrongResult, nil, 400, nil), "invalid_agent_task_result")
	wrongResult = taskResult
	wrongResult.LaunchID = "unrelated-launch"
	controlReason(t, controlExchange(t, h, "POST", p+"/result", key, wrongResult, nil, 409, nil), "stale_assignment")
	controlExchange(t, h, "POST", p+"/result", key, taskResult, nil, 200, &task)
	controlExchange(t, sibling, "POST", p+"/result", key, taskResult, nil, 200, nil)
	if task.State != "refused" || !task.Held {
		t.Fatal("accepting a result lost its hold")
	}
	stop := inference.Interruption{Version: 1, SubmissionID: "stop-task", ClaimID: claim, Generation: 1, LaunchID: "task-launch",
		NativeJob: "controlled-hook", NativeRun: "event-hook-tick-4", Reason: "execution_confirmed_stopped", VerifiedStart: true}
	wrongStop := stop
	wrongStop.Version = 2
	controlExchange(t, h, "POST", p+"/interrupt", key, wrongStop, nil, 400, nil)
	wrongStop = stop
	wrongStop.Reason = "other"
	controlReason(t, controlExchange(t, h, "POST", p+"/interrupt", key, wrongStop, nil, 400, nil), "invalid_interruption")
	wrongStop = stop
	wrongStop.Generation = 2
	controlReason(t, controlExchange(t, h, "POST", p+"/interrupt", key, wrongStop, nil, 409, nil), "stale_assignment")
	wrongStop = stop
	wrongStop.NativeRun = "event-hook-unrelated"
	controlReason(t, controlExchange(t, h, "POST", p+"/interrupt", key, wrongStop, nil, 409, nil), "native_settlement_proof_mismatch")
	controlExchange(t, h, "POST", p+"/interrupt", key, stop, nil, 200, &task)
	controlExchange(t, sibling, "POST", p+"/interrupt", key, stop, nil, 200, nil)
	if task.Held || task.State != "refused" {
		t.Fatal("settlement changed an accepted outcome")
	}
	events := capturedHTTP(t, h.Exporter.(*diagnostics.Store))
	for _, event := range events {
		if strings.Contains(fmt.Sprint(event), "A permission is required") && event["level"] != "DEBUG" {
			t.Fatal("task result appeared at normal runtime level")
		}
	}
}

func TestWorkerControlContentTypeMethodsAndRevocation(t *testing.T) {
	now := time.Now().UTC()
	h, repo := openPullHTTP(t, filepath.Join(mediaSQLiteDirectory(t), "broker.sqlite3"), func() time.Time { return now })
	key, id := controlWorker(t, h)
	root := adminWorkerPrefix + id
	admin := testManagementKey
	op := controlOp(worker.Doctor, "doctor-pending")
	method := controlExchange(t, h, "PUT", root+"/ops", admin, op, nil, 405, nil)
	if method.Header().Get("Allow") != "GET, POST" {
		t.Fatal("multi-method route advertised the wrong allowed methods")
	}
	controlExchange(t, h, "POST", root+"/ops", admin, op, map[string]string{"Content-Type": "text/plain"}, 415, nil)
	controlExchange(t, h, "POST", root+"/ops", key, op, nil, 401, nil)
	controlExchange(t, h, "POST", root+"/ops", "client-private-sentinel", op, nil, 401, nil)

	h.Portal = service.NewPortal(h.Authority, rand.Reader, h.Now)
	if err := h.Portal.ConfigureBrowser(t.Context(), h.Logger, repo, "portal-private-sentinel"); err != nil {
		t.Fatal(err)
	}
	cookie := controlExchange(t, h, "POST", "/api/v1/portal/login", "", map[string]any{"password": "portal-private-sentinel", "remember_me": false},
		map[string]string{portalOperationHeader: "login", "Sec-Fetch-Site": "same-origin"}, 200, nil).Result().Cookies()[0]
	headers := map[string]string{"Cookie": cookie.String(), portalOperationHeader: "remote-op", "Sec-Fetch-Site": "cross-site"}
	controlExchange(t, h, "POST", root+"/ops", "", op, headers, 403, nil)
	headers["Sec-Fetch-Site"] = "same-origin"
	delete(headers, portalOperationHeader)
	controlExchange(t, h, "POST", root+"/ops", "", op, headers, 403, nil)
	headers[portalOperationHeader] = "remote-op"
	var item worker.ControlItem
	controlExchange(t, h, "POST", root+"/ops", "", op, headers, 202, &item)
	controlExchange(t, h, "GET", root+"/ops?limit=1&kind=doctor", "", nil, headers, 200, nil)
	controlExchange(t, h, "GET", root+"/ops?kind=doctor&kind=retry_update", "", nil, headers, 400, nil)
	controlExchange(t, h, "GET", root+"/ops?limit=101", "", nil, headers, 400, nil)
	controlExchange(t, h, "GET", root+"/ops?unknown=1", "", nil, headers, 400, nil)
	controlExchange(t, h, "GET", root+"/ops?cursor=bad", "", nil, headers, 400, nil)
	if grant := controlPull(t, h, key, now, 1, false); grant.WorkerOp == nil || grant.WorkerOp.ID != item.ID {
		t.Fatal("doctor was not claimed")
	}
	controlExchange(t, h, "POST", root+"/revoke", admin, nil, nil, 200, nil)
	controlExchange(t, h, "GET", root+"/ops/"+item.ID, admin, nil, nil, 200, &item)
	if !item.Held || item.State != "interrupted" || item.Reason != "worker_revoked" {
		t.Fatal("revocation did not interrupt the operation while preserving its uncertain hold")
	}
	controlExchange(t, h, "POST", root+"/ops", admin, op, nil, 409, nil)
	events := capturedHTTP(t, h.Exporter.(*diagnostics.Store))
	writes := 0
	for _, event := range events {
		if event["msg"] == "portal.worker_action" {
			writes++
		}
	}
	if writes != 1 {
		t.Fatalf("expected one cookie-authenticated worker action, got %d", writes)
	}
}

func TestRetryUpdateReclaimsOrphanWithoutWeakeningPairFence(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	h, repo := openPullHTTP(t, filepath.Join(mediaSQLiteDirectory(t), "broker.sqlite3"), func() time.Time { return now })
	build := service.Build{Version: "1.3.0", Revision: strings.Repeat("a", 40), WorkerPackage: service.PairedWorker("1.3.0", strings.Repeat("c", 64))}
	h.Service = service.New(repo, config.Defaults(), build, "instance", h.Now, h.Logger)
	if err := h.Broker.EnableUpdates(t.Context(), h.Logger, "controlled-instance", build.UpdateTarget()); err != nil {
		t.Fatal(err)
	}
	key, id := controlWorker(t, h)
	oldHeaders := map[string]string{service.WorkerVersionHeader: "1.2.0", service.WorkerDigestHeader: strings.Repeat("a", 64)}
	skewPull := func(sequence int64) *worker.UpdateOffer {
		now = now.Add(time.Second)
		var result inference.PullResult
		controlExchange(t, h, "POST", workerPullRoute, key, inference.Pull{Version: 1, Sequence: sequence, Checker: "controlled-hook",
			Occurrence: fmt.Sprint("update-", sequence), ScheduledAt: now, EnteredAt: now}, oldHeaders, 200, &result)
		if result.Job != nil || result.WorkerOp != nil || result.AgentTask != nil {
			t.Fatal("skewed pull received work authority")
		}
		return result.Update
	}
	original := skewPull(1)
	if original == nil {
		t.Fatal("test did not get the initial update")
	}
	update := worker.UpdateRequest{ID: original.ID, Action: "begin", Target: original.Target}
	controlExchange(t, h, "POST", workerUpdateRoute, key, update, oldHeaders, 200, nil)
	if skewPull(2) != nil {
		t.Fatal("ordinary pull reset an active update")
	}
	root := adminWorkerPrefix + id
	controlExchange(t, h, "POST", root+"/ops", testManagementKey, controlOp(worker.Doctor, "skewed-doctor"), nil, 409, nil)
	var attempt worker.ControlItem
	controlExchange(t, h, "POST", root+"/ops", testManagementKey, controlOp(worker.RetryUpdate, "retry-orphan"), nil, 202, &attempt)
	controlExchange(t, h, "POST", root+"/ops", testManagementKey, controlOp(worker.RetryUpdate, "duplicate-retry"), nil, 409, nil)
	forced := skewPull(3)
	if forced == nil || forced.ID == original.ID {
		t.Fatal("retry did not create a new update attempt")
	}
	update.ID = forced.ID
	controlExchange(t, h, "POST", workerUpdateRoute, key, update, oldHeaders, 200, nil)
	update.Action = "activate"
	controlExchange(t, h, "POST", workerUpdateRoute, key, update, oldHeaders, 200, nil)
	update.Action = "applied"
	controlExchange(t, h, "POST", workerUpdateRoute, key, update, nil, 200, nil)
	controlExchange(t, h, "GET", root+"/ops/"+attempt.ID, testManagementKey, nil, nil, 200, &attempt)
	if attempt.State != "running" {
		t.Fatal("update retry settled before paired pull confirmation")
	}
	now = now.Add(time.Second)
	controlPull(t, h, key, now, 4, true)
	controlExchange(t, h, "GET", root+"/ops/"+attempt.ID, testManagementKey, nil, nil, 200, &attempt)
	if attempt.State != "succeeded" || attempt.Held {
		t.Fatal("retry did not settle at confirmation")
	}
	controlExchange(t, h, "POST", root+"/ops", testManagementKey, controlOp(worker.RetryUpdate, "already-paired"), nil, 409, nil)

	skewPull(5)
	controlExchange(t, h, "POST", root+"/ops", testManagementKey, controlOp(worker.RetryUpdate, "paired-before-retry"), nil, 202, &attempt)
	now = now.Add(time.Second)
	controlPull(t, h, key, now, 6, true)
	controlExchange(t, h, "GET", root+"/ops/"+attempt.ID, testManagementKey, nil, nil, 200, &attempt)
	if attempt.State != "succeeded" || !bytes.Equal(attempt.Result, []byte(`{"already_current":true}`)) {
		t.Fatal("a queued retry changed an already paired installation")
	}

	skewPull(7)
	controlExchange(t, h, "POST", root+"/ops", testManagementKey, controlOp(worker.RetryUpdate, "failed-retry"), nil, 202, &attempt)
	peer := service.NewBroker(repo, rand.Reader, func() time.Time { return now }, nil)
	target := *build.UpdateTarget()
	target.PackagePin = service.PairedWorker(build.Version, strings.Repeat("d", 64))
	if err := peer.EnableUpdates(t.Context(), h.Logger, "conflicting-peer", &target); err != nil {
		t.Fatal(err)
	}
	if offer := skewPull(8); offer != nil {
		t.Fatal("retry overrode a sibling release conflict")
	}
	controlExchange(t, h, "GET", root+"/ops/"+attempt.ID, testManagementKey, nil, nil, 200, &attempt)
	if attempt.State != "queued" {
		t.Fatal("release disagreement consumed the deferred retry")
	}
	now = now.Add(31 * time.Second)
	offer := skewPull(9)
	if offer == nil {
		t.Fatal("retry did not resume after release consensus")
	}
	update = worker.UpdateRequest{ID: offer.ID, Action: "begin", Target: offer.Target}
	controlExchange(t, h, "POST", workerUpdateRoute, key, update, oldHeaders, 200, nil)
	update.Action, update.Reason = "failed", "archive_digest_mismatch"
	controlExchange(t, h, "POST", workerUpdateRoute, key, update, oldHeaders, 200, nil)
	controlExchange(t, h, "GET", root+"/ops/"+attempt.ID, testManagementKey, nil, nil, 200, &attempt)
	if attempt.State != "failed" || attempt.Held || attempt.Reason != update.Reason {
		t.Fatal("a failed update did not settle its bound retry operation")
	}
	controlExchange(t, h, "POST", root+"/ops", testManagementKey, controlOp(worker.RetryUpdate, "pair-moved"), nil, 202, &attempt)
	oldHeaders[service.WorkerVersionHeader] = "1.4.0"
	if offer := skewPull(10); offer != nil {
		t.Fatal("retry authorized a downgrade after the worker moved")
	}
	controlExchange(t, h, "GET", root+"/ops/"+attempt.ID, testManagementKey, nil, nil, 200, &attempt)
	if attempt.State != "failed" || attempt.Reason != "update_requires_newer_pair" {
		t.Fatal("non-advancing retry did not report its terminal reason")
	}
}

func TestWorkerControlDiagnosticsAndCursorKeepLogsBounded(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	h := pullHTTPClock(t, filepath.Join(mediaSQLiteDirectory(t), "broker.sqlite3"), func() time.Time { return now })
	key, id := controlWorker(t, h)
	_, foreign := controlWorker(t, h)
	root := adminWorkerPrefix + id
	admin := testManagementKey
	var queued [2]worker.ControlItem
	for i := range queued {
		input := controlOp(worker.DiagnosticsExport, fmt.Sprint("export-", i))
		controlExchange(t, h, "POST", root+"/ops", admin, input, nil, 202, &queued[i])
		now = now.Add(time.Second)
	}
	var list worker.ControlPage
	controlExchange(t, h, "GET", root+"/ops?limit=1&kind=diagnostics_export", admin, nil, nil, 200, &list)
	if len(list.Items) != 1 || list.Items[0].ID != queued[1].ID || list.NextCursor == "" || list.Items[0].Result != nil {
		t.Fatal("first page lost ordering, its cursor, or payload omission")
	}
	cursor := list.NextCursor
	controlExchange(t, h, "GET", adminWorkerPrefix+foreign+"/ops?limit=1&kind=diagnostics_export&cursor="+cursor, admin, nil, nil, 400, nil)
	controlExchange(t, h, "GET", root+"/ops?limit=1&kind=diagnostics_export&cursor="+cursor, admin, nil, nil, 200, &list)
	if len(list.Items) != 1 || list.Items[0].ID != queued[0].ID {
		t.Fatal("second page did not resume the scoped result order")
	}

	// This capture deliberately crosses the broker boundary with an unredacted protected event.
	captureStore, err := diagnostics.Open(diagnostics.OSFiles{}, t.TempDir(), "worker-fixture", func() time.Time { return now }, time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	event := fmt.Sprintf(`{"msg":"fixture.capture","time":%q,"level":"DEBUG","instance_id":"test","data":"Bearer abcdefghijklmnopqr %s"}`, now.Format(time.RFC3339), admin)
	if _, err := captureStore.Write([]byte(event)); err != nil {
		t.Fatal(err)
	}
	snapshot, err := captureStore.Snapshot(diagnostics.Filter{})
	if err != nil || len(snapshot.Records) != 1 {
		t.Fatal("capture fixture lost its protected record", err)
	}
	for i, output := range []string{string(snapshot.Records[0]), event} {
		pull := controlPull(t, h, key, now, int64(i+1), false)
		if pull.WorkerOp == nil || pull.WorkerOp.ID != queued[i].ID {
			t.Fatal("worker did not claim the next export")
		}
		report := worker.DiagnosticsResult{Decoded: i == 1, Complete: true, Captures: 1, Omissions: []string{}, Output: []string{output}}
		encoded, err := json.Marshal(report)
		if err != nil {
			t.Fatal(err)
		}
		result := worker.ControlResult{Version: 1, SubmissionID: fmt.Sprint("export-result-", i),
			ClaimID: pull.WorkerOp.ClaimID, Generation: 1, Outcome: "succeeded", Result: encoded}
		workerAddress := workerPrefix + "ops/" + queued[i].ID + "/result"
		invalid := result
		invalid.Result = json.RawMessage(`{"captures":1,"output":[]}`)
		controlExchange(t, h, "POST", workerAddress, key, invalid, nil, 400, nil)
		corrupt := report
		corrupt.Output = []string{"invalid capture"}
		invalid.Result, err = json.Marshal(corrupt)
		if err != nil {
			t.Fatal(err)
		}
		controlReason(t, controlExchange(t, h, "POST", workerAddress, key, invalid, nil, 400, nil), "invalid_diagnostics_result")
		controlExchange(t, h, "POST", workerAddress, key, result, nil, 200, nil)
		var detail worker.ControlItem
		controlExchange(t, h, "GET", root+"/ops/"+queued[i].ID, admin, nil, nil, 200, &detail)
		var delivered worker.DiagnosticsResult
		if err := json.Unmarshal(detail.Result, &delivered); err != nil || len(delivered.Output) != 1 || detail.ResultSHA256 == "" {
			t.Fatal("bounded diagnostics result lost its actual capture", err)
		}
		text := delivered.Output[0]
		if !delivered.Decoded {
			var chunk diagnostics.Record
			if err := json.Unmarshal([]byte(text), &chunk); err != nil {
				t.Fatal(err)
			}
			decoded, err := base64.StdEncoding.DecodeString(chunk.Data)
			if err != nil {
				t.Fatal(err)
			}
			text = string(decoded)
		}
		if strings.Contains(text, admin) || strings.Contains(text, "abcdefghijklmnopqr") || !strings.Contains(text, "[REDACTED]") {
			t.Fatal("broker stored unredacted worker capture")
		}
		now = now.Add(time.Second)
	}
	events := capturedHTTP(t, h.Exporter.(*diagnostics.Store))
	var omittedRead, omittedWrite, rejected int
	for _, record := range events {
		if record["response_capture"] == "worker_op_result_omitted" && record["response"] == "" {
			omittedRead++
		}
		if record["msg"] == "worker_op.exchange" && record["input_omitted"] == true && record["input"] == nil {
			omittedWrite++
		}
		if record["msg"] == "worker_op.rejected" && record["reason"] == "invalid_diagnostics_result" && record["level"] == "WARN" {
			rejected++
		}
	}
	if omittedRead != 2 || omittedWrite != 2 || rejected != 4 {
		t.Fatal("protected logs duplicated the payload or lost the rejected result evidence")
	}
}

func TestWorkerOpRedactionOverflowSettlesTheAcceptedGrant(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	h := pullHTTPClock(t, filepath.Join(mediaSQLiteDirectory(t), "broker.sqlite3"), func() time.Time { return now })
	h.Redactor = diagnostics.NewRedactor([]string{"abc"})
	key, id := controlWorker(t, h)
	export := worker.DiagnosticsResult{Decoded: true, Complete: true, Captures: 1, Omissions: []string{},
		Output: []string{`{"text":"` + strings.Repeat("abc ", 100) + `"}`}}
	encoded, err := json.Marshal(export)
	if err != nil {
		t.Fatal(err)
	}
	op := controlOp(worker.DiagnosticsExport, "limited-export")
	limit := len(encoded)
	op.Params = &worker.DiagnosticsQuery{MaxBytes: &limit}
	var item worker.ControlItem
	controlExchange(t, h, "POST", adminWorkerPrefix+id+"/ops", testManagementKey, op, nil, 202, &item)
	grant := controlPull(t, h, key, now, 1, false).WorkerOp
	input := worker.ControlResult{Version: 1, SubmissionID: "bounded-result", ClaimID: grant.ClaimID, Generation: 1,
		Outcome: "succeeded", Result: encoded}
	path := workerPrefix + "ops/" + item.ID + "/result"
	accepted := controlExchange(t, h, "POST", path, key, input, nil, 200, &item)
	if item.Held || item.State != "failed" || item.Reason != "worker_op_redacted_result_too_large" ||
		item.RemoteOutcome != "succeeded" || item.ResultBytes != 0 || item.ReasonMessage == "" {
		t.Fatal("redaction overflow did not settle as a bounded and diagnosable failure")
	}
	replayed := controlExchange(t, h, "POST", path, key, input, nil, 200, nil)
	if !bytes.Equal(accepted.Body.Bytes(), replayed.Body.Bytes()) {
		t.Fatal("redaction overflow changed its replayed receipt")
	}
}

func TestWorkerControlCancelAndRecoveryDoNotReleaseUnknownWork(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	path := filepath.Join(mediaSQLiteDirectory(t), "broker.sqlite3")
	h := pullHTTPClock(t, path, func() time.Time { return now })
	key, id := controlWorker(t, h)
	root := adminWorkerPrefix + id
	admin := testManagementKey
	var task worker.ControlItem
	controlPull(t, h, key, now, 1, true)
	request := map[string]any{"protocol_version": 1, "submission_id": "overdue", "prompt": "Fixture", "timeout_seconds": 30}
	controlExchange(t, h, "POST", root+"/agent-tasks", admin, request, nil, 202, &task)
	var op worker.ControlItem
	controlExchange(t, h, "POST", root+"/ops", admin, controlOp(worker.Doctor, "cancelled-queued"), nil, 202, &op)
	cancel := inference.Cancel{Version: 1, SubmissionID: "cancel-queued"}
	controlExchange(t, h, "POST", root+"/ops/"+op.ID+"/cancel", admin, cancel, nil, 200, &op)
	if op.State != "cancelled" || op.Held {
		t.Fatal("queued cancelled operation invented a hold")
	}
	cancel.SubmissionID = "cancel-again"
	controlExchange(t, h, "POST", root+"/ops/"+op.ID+"/cancel", admin, cancel, nil, 409, nil)
	now = now.Add(time.Second)
	pull := controlPull(t, h, key, now, 2, true)
	if pull.AgentTask == nil {
		t.Fatal("task fixture did not hold a slot")
	}
	controlExchange(t, h, "POST", root+"/ops", admin, controlOp(worker.Doctor, "blocked-follow-up"), nil, 202, &op)
	now = now.Add(31 * time.Second)
	restarted := pullHTTPClock(t, path, func() time.Time { return now })
	if err := restarted.Broker.Recover(t.Context(), restarted.Logger); err != nil {
		t.Fatal(err)
	}
	controlExchange(t, restarted, "GET", root+"/agent-tasks/"+task.ID, admin, nil, nil, 200, &task)
	if !task.Held || task.State != "interrupted" || task.Reason != "deadline_exceeded" || task.RemoteOutcome != "unknown" {
		t.Fatal("startup recovery discarded the unresolved task fence")
	}
	if next := controlPull(t, restarted, key, now, 3, true); next.WorkerOp != nil || next.AgentTask != nil {
		t.Fatal("restart made an uncertain claim available")
	}
	stop := inference.Interruption{Version: 1, SubmissionID: "stop-before-start", ClaimID: pull.AgentTask.ClaimID, Generation: 1, LaunchID: "never-started",
		Reason: "launch_not_authorized", VerifiedStart: true}
	controlExchange(t, restarted, "POST", workerPrefix+"agent-tasks/"+task.ID+"/interrupt", key, stop, nil, 200, &task)
	now = now.Add(time.Second)
	if next := controlPull(t, restarted, key, now, 4, true); next.WorkerOp == nil || next.WorkerOp.ID != op.ID {
		t.Fatal("correlated settlement did not restore eligibility")
	}
}

func TestWorkerControlAdmissionPrecedesQueueAndPayloadBounds(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	path := filepath.Join(mediaSQLiteDirectory(t), "broker.sqlite3")
	h, repo := openPullHTTP(t, path, func() time.Time { return now })
	key, id := controlWorker(t, h)
	root := adminWorkerPrefix + id
	admin := testManagementKey
	op := controlOp(worker.Doctor, "operation")
	task := worker.TaskRequest{ControlRequest: worker.ControlRequest{Version: 1, SubmissionID: "task"}, Prompt: "Review the fixture"}

	missing := adminWorkerPrefix + strings.Repeat("f", 32)
	controlReason(t, controlExchange(t, h, "GET", missing+"/hook-prompt", admin, nil, nil, 404, nil), "worker_not_found")
	controlReason(t, controlExchange(t, h, "GET", missing+"/ops", admin, nil, nil, 404, nil), "worker_not_found")
	controlReason(t, controlExchange(t, h, "GET", root+"/ops/"+strings.Repeat("f", 32), admin, nil, nil, 404, nil), "worker_op_not_found")
	controlReason(t, controlExchange(t, h, "GET", root+"/ops?limit=%GG", admin, nil, nil, 400, nil), "invalid_query")
	controlReason(t, controlExchange(t, h, "GET", root+"/agent-tasks?kind=doctor", admin, nil, nil, 400, nil), "invalid_worker_op")
	controlReason(t, controlExchange(t, h, "POST", root+"/ops", admin, controlOp(worker.RetryUpdate, "no-target"), nil, 409, nil), "update_target_unavailable")
	controlReason(t, controlExchange(t, h, "POST", root+"/ops", admin, controlOp("shell", "unknown-kind"), nil, 400, nil), "invalid_worker_op")
	invalid := op
	invalid.Version = 2
	controlExchange(t, h, "POST", root+"/ops", admin, invalid, nil, 400, nil)
	invalid = op
	invalid.TimeoutSeconds = 14
	controlReason(t, controlExchange(t, h, "POST", root+"/ops", admin, invalid, nil, 400, nil), "invalid_timeout")
	invalid = controlOp(worker.DiagnosticsExport, "invalid-export")
	maxBytes := 0
	invalid.Params = &worker.DiagnosticsQuery{MaxBytes: &maxBytes}
	controlReason(t, controlExchange(t, h, "POST", root+"/ops", admin, invalid, nil, 400, nil), "invalid_worker_op")
	badTask := task
	badTask.Version = 2
	controlExchange(t, h, "POST", root+"/agent-tasks", admin, badTask, nil, 400, nil)
	badTask = task
	badTask.Prompt = strings.Repeat("a", worker.MaxTaskPrompt+1)
	controlReason(t, controlExchange(t, h, "POST", root+"/agent-tasks", admin, badTask, nil, 400, nil), "invalid_agent_task")
	badTask.Prompt = strings.Repeat("a", 128*1024)
	controlReason(t, controlExchange(t, h, "POST", root+"/agent-tasks", admin, badTask, nil, 413, nil), "body_too_large")
	badTask = task
	badTask.TimeoutSeconds = 29
	controlReason(t, controlExchange(t, h, "POST", root+"/agent-tasks", admin, badTask, nil, 400, nil), "invalid_timeout")

	controlPull(t, h, key, now, 1, true)
	for index := range 8 {
		op.SubmissionID = fmt.Sprint("limit-op-", index)
		controlExchange(t, h, "POST", root+"/ops", admin, op, nil, 202, nil)
	}
	for index := range 16 {
		task.SubmissionID = fmt.Sprint("limit-task-", index)
		controlExchange(t, h, "POST", root+"/agent-tasks", admin, task, nil, 202, nil)
	}
	op.SubmissionID, task.SubmissionID = "additional-op", "additional-task"
	controlReason(t, controlExchange(t, h, "POST", root+"/ops", admin, op, nil, 429, nil), "worker_op_queue_full")
	controlReason(t, controlExchange(t, h, "POST", root+"/agent-tasks", admin, task, nil, 429, nil), "agent_task_queue_full")
	build := service.Build{Version: "1.3.0", Revision: strings.Repeat("b", 40), WorkerPackage: service.PairedWorker("1.3.0", strings.Repeat("b", 64))}
	h.Service = service.New(repo, config.Defaults(), build, "instance", h.Now, h.Logger)
	now = now.Add(time.Second)
	skew := map[string]string{service.WorkerVersionHeader: "1.4.0", service.WorkerDigestHeader: strings.Repeat("c", 64)}
	controlExchange(t, h, "POST", workerPullRoute, key, inference.Pull{Version: 1, Sequence: 2, Checker: "controlled-hook",
		Occurrence: "skewed-2", ScheduledAt: now, EnteredAt: now}, skew, 200, nil)
	controlReason(t, controlExchange(t, h, "POST", root+"/ops", admin, op, nil, 409, nil), "worker_update_required")
	controlReason(t, controlExchange(t, h, "POST", root+"/agent-tasks", admin, task, nil, 409, nil), "worker_update_required")
	controlReason(t, controlExchange(t, h, "POST", root+"/ops", admin, controlOp(worker.RetryUpdate, "backward"), nil, 409, nil), "update_requires_newer_pair")

	legacyKey, legacyID := controlWorker(t, h)
	now = now.Add(time.Second)
	tick, err := json.Marshal(inference.Pull{Version: 1, Sequence: 1, Checker: "old-cron", Occurrence: "legacy-1", ScheduledAt: now, EnteredAt: now})
	if err != nil {
		t.Fatal(err)
	}
	legacy := httptest.NewRequest("POST", workerPullRoute, bytes.NewReader(tick))
	legacy.Header.Set("Authorization", "Bearer "+legacyKey)
	legacy.Header.Set(service.WorkerVersionHeader, "1.0.0")
	legacy.Header.Set(service.WorkerUpdaterHeader, "native-cron-v1")
	legacy.Header.Set(service.WorkerDigestHeader, strings.Repeat("d", 64))
	reply := httptest.NewRecorder()
	h.ServeHTTP(reply, legacy)
	nativeResponse(t, reply, 200, nil)
	legacyRoot := adminWorkerPrefix + legacyID
	controlReason(t, controlExchange(t, h, "GET", legacyRoot+"/hook-prompt", admin, nil, nil, 409, nil), "unsupported_worker_migration")
	controlReason(t, controlExchange(t, h, "POST", legacyRoot+"/agent-tasks", admin, task, nil, 409, nil), "unsupported_worker_migration")
}

func TestWorkerControlWriteFailuresLeaveReceiptsAndSlotsRetryable(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	path := filepath.Join(mediaSQLiteDirectory(t), "broker.sqlite3")
	h := pullHTTPClock(t, path, func() time.Time { return now })
	key, id := controlWorker(t, h)
	root := adminWorkerPrefix + id
	admin := testManagementKey
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	write := func(query string) {
		t.Helper()
		if _, err := database.ExecContext(t.Context(), query); err != nil {
			t.Fatal(err)
		}
	}
	failWrite := func(event, table string, exchange func()) {
		t.Helper()
		write("CREATE TRIGGER reject_control_write BEFORE " + event + " ON " + table + " BEGIN SELECT RAISE(ABORT, 'controlled write failure'); END;")
		exchange()
		write("DROP TRIGGER reject_control_write")
	}
	limit := 512
	input := controlOp(worker.DiagnosticsExport, "export")
	input.Params = &worker.DiagnosticsQuery{MaxBytes: &limit}
	var op worker.ControlItem
	controlExchange(t, h, "POST", root+"/ops", admin, input, nil, 202, &op)
	pull := controlPull(t, h, key, now, 1, true)
	if pull.WorkerOp == nil {
		t.Fatal("fixture operation was not held")
	}
	opResult := worker.ControlResult{Version: 1, SubmissionID: "export-result", ClaimID: pull.WorkerOp.ClaimID, Generation: 1,
		Outcome: "succeeded", Result: json.RawMessage(`{"complete":true,"decoded":true,"omissions":[],"captures":0,"output":[]}`)}
	opPath := workerPrefix + "ops/" + op.ID + "/result"
	tooLarge := opResult
	tooLarge.Result = json.RawMessage(fmt.Sprintf(`{"output":[%q]}`, strings.Repeat("x", limit)))
	controlReason(t, controlExchange(t, h, "POST", opPath, key, tooLarge, nil, 413, nil), "worker_op_result_too_large")
	tooLarge.Result = json.RawMessage(fmt.Sprintf(`{"output":[%q]}`, strings.Repeat("x", worker.MaxWorkerOpEnvelope)))
	controlReason(t, controlExchange(t, h, "POST", opPath, key, tooLarge, nil, 413, nil), "body_too_large")
	noResult := opResult
	noResult.Result = nil
	controlReason(t, controlExchange(t, h, "POST", opPath, key, noResult, nil, 400, nil), "invalid_worker_op_result")
	wrong := opResult
	wrong.Version = 2
	controlExchange(t, h, "POST", opPath, key, wrong, nil, 400, nil)
	wrong = opResult
	wrong.Generation = 2
	controlReason(t, controlExchange(t, h, "POST", opPath, key, wrong, nil, 409, nil), "stale_assignment")
	controlExchange(t, h, "POST", opPath, key, map[string]int{"protocol_version": 1}, nil, 400, nil)
	for _, fault := range []struct{ event, table string }{
		{"UPDATE", "aaa_worker_ops"}, {"UPDATE", "aaa_workers"}, {"INSERT", "aaa_inference_receipts"},
	} {
		failWrite(fault.event, fault.table, func() {
			controlExchange(t, h, "POST", opPath, key, opResult, nil, 503, nil)
		})
		controlExchange(t, h, "GET", root+"/ops/"+op.ID, admin, nil, nil, 200, &op)
		if op.State != "claimed" || !op.Held || len(op.Result) != 0 {
			t.Fatalf("a failed %s write published part of the operation result", fault.table)
		}
	}
	now = now.Add(121 * time.Second)
	controlExchange(t, h, "POST", opPath, key, opResult, nil, 200, &op)
	if op.Held || op.State != "interrupted" || op.Reason != "deadline_exceeded" || op.RemoteOutcome != "succeeded" {
		t.Fatal("a late exact result lost the deadline outcome or retained an unnecessary hold")
	}
	controlExchange(t, h, "POST", opPath, key, opResult, nil, 200, nil)

	task := worker.TaskRequest{ControlRequest: worker.ControlRequest{Version: 1, SubmissionID: "task"}, Prompt: "Check the fixture"}
	var item worker.ControlItem
	controlExchange(t, h, "POST", root+"/agent-tasks", admin, task, nil, 202, &item)
	now = now.Add(time.Second)
	grant := controlPull(t, h, key, now, 2, true).AgentTask
	if grant == nil || grant.ID != item.ID {
		t.Fatal("a settled operation still occupied the task slot")
	}
	projection := func() workerView {
		t.Helper()
		var view struct{ Workers []workerView }
		controlExchange(t, h, "GET", adminWorkerPrefix[:len(adminWorkerPrefix)-1], admin, nil, nil, 200, &view)
		if len(view.Workers) != 1 || view.Workers[0].ID != id {
			t.Fatal("management projection lost the worker")
		}
		return view.Workers[0]
	}
	view := projection()
	taskPath := workerPrefix + "agent-tasks/" + item.ID
	now = now.Add(time.Second)
	presence := inference.BusyCheck{Version: 1, ClaimID: grant.ClaimID, Generation: 1, Checker: "controlled-hook", Occurrence: "new-contact", ScheduledAt: now}
	usage := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"used_percent":42,"observed_at":%q}`, now.Format(time.RFC3339))))
	headers := map[string]string{worker.AgentTasksHeader: "1", weeklyUsageHeader: usage}
	for _, fault := range []struct{ event, table string }{
		{"INSERT", "aaa_worker_weekly_usage"}, {"INSERT", "aaa_worker_capabilities"}, {"INSERT", "aaa_worker_updates"},
		{"UPDATE", "aaa_agent_tasks"}, {"UPDATE", "aaa_workers"},
	} {
		failWrite(fault.event, fault.table, func() {
			controlExchange(t, h, "POST", taskPath+"/presence", key, presence, headers, 503, nil)
		})
		unchanged := projection()
		if view.LastContactAt == nil || unchanged.LastContactAt == nil || !view.LastContactAt.Equal(*unchanged.LastContactAt) ||
			unchanged.ActiveSlotLane != worker.AgentTask {
			t.Fatalf("a failed %s write changed contact or released the task", fault.table)
		}
	}
	var observed inference.PresenceReceipt
	controlExchange(t, h, "POST", taskPath+"/presence", key, presence, headers, 200, &observed)
	if !observed.Recorded || !observed.ReceivedAt.Equal(now) {
		t.Fatal("failed presence transactions consumed the observation")
	}
	start := inference.WorkStart{Version: 1, ClaimID: grant.ClaimID, Generation: 1, LaunchID: "task-launch", NativeJob: "controlled-hook",
		Verification: &inference.NativeStartProof{Reference: grant.ClaimID, NativeJob: "controlled-hook", NativeRun: "event-hook-tick-2", Status: "running"}}
	controlExchange(t, h, "POST", taskPath+"/start", key, start, nil, 200, nil)
	stop := inference.Interruption{Version: 1, SubmissionID: "settlement", ClaimID: grant.ClaimID, Generation: 1, LaunchID: "task-launch",
		NativeJob: "controlled-hook", NativeRun: "event-hook-tick-2", Reason: "execution_confirmed_stopped", VerifiedStart: true}
	controlExchange(t, h, "POST", taskPath+"/interrupt", key, stop, map[string]string{"X-Muse-Interruption": "failed"}, 200, &item)
	if item.State != "interrupted" || item.Held || item.RemoteOutcome != "stopped" || item.Interruption["native_status"] != "failed" {
		t.Fatal("correlated stopped execution did not release the slot and retain its evidence")
	}
}
