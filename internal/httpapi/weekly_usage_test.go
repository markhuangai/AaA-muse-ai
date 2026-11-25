package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/media"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

type usageFleet struct {
	first, second *Handler
	now           time.Time
	path          string
	keys, ids     [2]string
	sequence      [2]int64
}

func newUsageFleet(t *testing.T) *usageFleet {
	t.Helper()
	f := &usageFleet{now: time.Now().UTC().Truncate(time.Second), path: filepath.Join(mediaSQLiteDirectory(t), "quota.sqlite3")}
	clock := func() time.Time { return f.now }
	f.first, f.second = pullHTTPClock(t, f.path, clock), pullHTTPClock(t, f.path, clock)
	for i, h := range []*Handler{f.first, f.second} {
		f.keys[i] = enrollNative(t, h)
		var view workerView
		nativeResponse(t, call(h, "GET", "/api/v1/worker/status", "Bearer "+f.keys[i], nil), 200, &view)
		f.ids[i] = view.ID
	}
	return f
}

func usageHeaderValue(percent float64, stamp time.Time) string {
	raw, err := json.Marshal(worker.WeeklyUsage{UsedPercent: percent, ObservedAt: stamp, ResetLabel: "Nov 29 at 7:49 AM EST"})
	if err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func usageRequest(h *Handler, path, key string, input any, headers ...string) *httptest.ResponseRecorder {
	raw, err := json.Marshal(input)
	if err != nil {
		panic(err)
	}
	request := pairedRequest(h, "POST", path, bytes.NewReader(raw))
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("X-Muse-Worker-Version", h.Service.Build().Version)
	for _, header := range headers {
		request.Header.Add(weeklyUsageHeader, header)
	}
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	rememberTestPull(response, input)
	return response
}

const usagePullPath = "/api/v1/worker/pull"

func (f *usageFleet) tick(index int, capability int) inference.Pull {
	f.sequence[index]++
	return inference.Pull{Version: 1, Sequence: f.sequence[index], Checker: fmt.Sprintf("checker-%d", index),
		Occurrence: fmt.Sprintf("quota-tick-%d-%d", index, f.sequence[index]), ScheduledAt: f.now, EnteredAt: f.now,
		MediaJobs: capability >= 1, PromptWAV: capability >= 2}
}

func (f *usageFleet) poll(t *testing.T, index int, capability int, headers ...string) *inference.Grant {
	t.Helper()
	h := []*Handler{f.first, f.second}[index]
	var result inference.PullResult
	nativeResponse(t, usageRequest(h, usagePullPath, f.keys[index], f.tick(index, capability), headers...), 200, &result)
	return result.Job
}

func (f *usageFleet) status(t *testing.T, index int) workerView {
	t.Helper()
	var list struct{ Workers []workerView }
	nativeResponse(t, call(f.second, "GET", "/api/v1/admin/workers", "Bearer "+testManagementKey, nil), 200, &list)
	for _, view := range list.Workers {
		if view.ID == f.ids[index] {
			return view
		}
	}
	t.Fatal("worker projection missing")
	return workerView{}
}

func (f *usageFleet) queue(t *testing.T, session string, timeout int) inference.RequestView {
	t.Helper()
	input := nativeHTTPInput("")
	input.SubmissionID, input.TimeoutSeconds = session, timeout
	view, _ := nativeHTTP(t, f.first, "POST", "/api/v1/requests", session, input, 202)
	return view
}

func (f *usageFleet) start(t *testing.T, index int, grant *inference.Grant) inference.Job {
	t.Helper()
	var brief inference.Job
	nativeResponse(t, nativePost(f.second, "/api/v1/worker/jobs/"+grant.JobID+"/start", f.keys[index], inference.WorkStart{
		Version: 1, ClaimID: grant.ClaimID, Generation: grant.Generation, LaunchID: "launch", NativeJob: "once",
	}), 200, &brief)
	return brief
}

func requireUsageClaim(t *testing.T, grant *inference.Grant, operation string) *inference.Grant {
	t.Helper()
	if grant == nil || grant.OperationID != operation {
		t.Fatalf("wanted claim for %s, got %+v", operation, grant)
	}
	return grant
}

func TestWeeklyUsageRanksAcrossBrokersAndReversesAfterSettlement(t *testing.T) {
	f := newUsageFleet(t)
	f.poll(t, 0, 0, usageHeaderValue(80, f.now))
	f.poll(t, 1, 0, usageHeaderValue(33, f.now))
	f.now = f.now.Add(time.Second)
	first := f.queue(t, "first-ranking", 300)
	if f.poll(t, 0, 0, usageHeaderValue(80, f.now)) != nil {
		t.Fatal("the earlier lower-allowance worker stole the only job")
	}
	grant := requireUsageClaim(t, f.poll(t, 1, 0, usageHeaderValue(33, f.now)), first.ID)
	submitAndSettleHTTP(t, f.first, f.keys[1], f.start(t, 1, grant), inference.Item{Type: "final", Text: "done"})

	f.now = f.now.Add(time.Second)
	f.poll(t, 0, 0, usageHeaderValue(25, f.now))
	f.poll(t, 1, 0, usageHeaderValue(91, f.now))
	f.second = pullHTTPClock(t, f.path, func() time.Time { return f.now })
	f.now = f.now.Add(time.Second)
	second := f.queue(t, "reversed-ranking", 300)
	if f.poll(t, 1, 0, usageHeaderValue(91, f.now)) != nil {
		t.Fatal("restart lost the reversed ranking")
	}
	requireUsageClaim(t, f.poll(t, 0, 0, usageHeaderValue(25, f.now)), second.ID)
}

func TestWeeklyUsagePrefersOnlyTheExactPair(t *testing.T) {
	for _, peer := range []struct{ version, digest string }{{"1.1.0", "a"}, {"1.2.0", "b"}} {
		t.Run(peer.version+"-"+peer.digest, func(t *testing.T) {
			f := newUsageFleet(t)
			clock := func() time.Time { return f.now }
			first, firstRepo := openPullHTTP(t, f.path, clock)
			second, secondRepo := openPullHTTP(t, f.path, clock)
			setUpdateBuild(t, first, firstRepo, clock, "current", "1.2.0", "a", "")
			setUpdateBuild(t, second, secondRepo, clock, "other", peer.version, peer.digest, "")
			f.first, f.second = first, second
			f.poll(t, 1, 0, usageHeaderValue(10, f.now))
			f.now = f.now.Add(time.Second)
			request := f.queue(t, "matching-pair", 300)
			requireUsageClaim(t, f.poll(t, 0, 0, usageHeaderValue(80, f.now)), request.ID)
		})
	}
}

func TestWeeklyUsageWaitIsBoundedAndAllowsUnknownFallback(t *testing.T) {
	for _, tc := range []struct {
		name    string
		timeout int
		wait    bool
		unknown bool
	}{
		{"one check for a better reporter", 300, true, false},
		{"unknown waits for a positive reading", 300, true, true},
		{"just over one minute can wait", 62, true, false},
		{"exactly one minute left picks up immediately", 61, false, false},
		{"short deadline picks up immediately", 30, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newUsageFleet(t)
			f.poll(t, 1, 0, usageHeaderValue(33, f.now))
			f.now = f.now.Add(time.Second)
			job := f.queue(t, "missed-check", tc.timeout)
			f.now = f.now.Add(time.Second)
			poll := func() *inference.Grant {
				if tc.unknown {
					return f.poll(t, 0, 0)
				}
				return f.poll(t, 0, 0, usageHeaderValue(80, f.now))
			}
			if !tc.wait {
				requireUsageClaim(t, poll(), job.ID)
				return
			}
			if poll() != nil {
				t.Fatal("the better worker did not get a chance")
			}
			f.now = job.CreatedAt.Add(60 * time.Second)
			requireUsageClaim(t, poll(), job.ID)
		})
	}
}

func TestWeeklyUsageLeavesWorkForOtherCompatibleSlots(t *testing.T) {
	for _, alternative := range []string{"second text", "video"} {
		t.Run(alternative, func(t *testing.T) {
			f := newUsageFleet(t)
			f.first.Broker.Media = media.New(filepath.Dir(f.path))
			f.poll(t, 1, 0, usageHeaderValue(33, f.now))
			f.now = f.now.Add(time.Second)
			text := f.queue(t, "oldest-text", 300)
			f.now = f.now.Add(time.Second)
			var second string
			if alternative == "video" {
				var queued service.MediaStatus
				nativeResponse(t, submitVideo(f.first, "client-private-sentinel", "quota-video", 300), 202, &queued)
				second = queued.ID
			} else {
				second = f.queue(t, "second-text", 300).ID
			}
			requireUsageClaim(t, f.poll(t, 0, 1, usageHeaderValue(75, f.now)), second)
			requireUsageClaim(t, f.poll(t, 1, 0, usageHeaderValue(33, f.now)), text.ID)
		})
	}
}

func TestWeeklyUsageExhaustionRespectsClaimsAndManagementTrial(t *testing.T) {
	f := newUsageFleet(t)
	// The management probe is older. Its target does not obscure a transferable request.
	nativeResponse(t, nativePost(f.first, "/api/v1/admin/experiments", testManagementKey, inference.Create{Version: 1,
		WorkerID: f.ids[0], SubmissionID: "worker-specific-probe",
		Messages: []inference.Item{{Type: "message", Role: "user", Text: "management probe"}}, Tools: []inference.Tool{},
	}), 201, nil)
	f.now = f.now.Add(time.Second)
	input := nativeHTTPInput(f.ids[0])
	request, _ := nativeHTTP(t, f.first, "POST", "/api/v1/requests", "targeted", input, 202)
	if f.poll(t, 0, 0, usageHeaderValue(100, f.now)) != nil || f.poll(t, 1, 0, usageHeaderValue(100, f.now)) != nil {
		t.Fatal("exhausted workers took queued work")
	}
	f.now = f.now.Add(time.Second)
	tick := f.tick(1, 0)
	var got inference.PullResult
	nativeResponse(t, usageRequest(f.second, usagePullPath, f.keys[1], tick), 200, &got)
	if got.Job != nil {
		t.Fatal("a missing header refreshed or replaced a current exhausted reading")
	}
	f.now = f.now.Add(2 * time.Minute)
	tick = f.tick(1, 0)
	// Restore a current 100% report on the original target, even after a long quiet spell.
	f.poll(t, 0, 0, usageHeaderValue(100, f.now))
	nativeResponse(t, usageRequest(f.second, usagePullPath, f.keys[1], tick), 200, &got)
	grant := requireUsageClaim(t, got.Job, request.ID)
	f.now = f.now.Add(time.Second)
	var replay inference.PullResult
	nativeResponse(t, usageRequest(f.first, usagePullPath, f.keys[1], tick, usageHeaderValue(100, f.now)), 200, &replay)
	if replay.Job == nil || *replay.Job != *grant || !replay.Job.DeadlineAt.Equal(request.CreatedAt.Add(5*time.Minute)) {
		t.Fatalf("quota transfer did not preserve claim and deadline: %+v, want %+v", replay.Job, grant)
	}
	if usage := f.status(t, 1).WeeklyUsage; usage == nil || !usage.Stale {
		t.Fatal("a changed report on exact replay changed the stored reading")
	}
	input.SubmissionID = "same-original-input-new-submission"
	reconciled, _ := nativeHTTP(t, f.second, "POST", "/api/v1/requests", "targeted", input, 202)
	if reconciled.ID != request.ID || reconciled.WorkerID != f.ids[1] {
		t.Fatal("an exact retry naming the displaced target conflicted with the new pin")
	}
	input.SubmissionID = "genuinely-new"
	input.Messages = append(input.Messages, inference.Item{Type: "message", Role: "user", Text: "new client input"})
	nativeHTTP(t, f.second, "POST", "/api/v1/requests", "targeted", input, 409)
	if f.poll(t, 0, 0, usageHeaderValue(100, f.now)) != nil {
		t.Fatal("the old target got another grant during committed pickup")
	}
	brief := f.start(t, 1, grant)
	if len(brief.Context.Messages) != 2 || brief.Context.Messages[0].Text != "Exact text\n" {
		t.Fatal("transfer changed canonical context")
	}
}

func TestWeeklyUsageMovesQueuedToolResultWithOriginalLinkage(t *testing.T) {
	f := newUsageFleet(t)
	input := nativeHTTPInput("")
	input.Tools = []inference.Tool{{Name: "read_file", Parameters: map[string]any{"type": "object"}}}
	request, _ := nativeHTTP(t, f.first, "POST", "/api/v1/requests", "tool-round-trip", input, 202)
	first := requireUsageClaim(t, f.poll(t, 0, 0, usageHeaderValue(20, f.now)), request.ID)
	call := inference.Item{Type: "tool_call", CallID: "original-tool-id", Name: "read_file", Arguments: map[string]any{"path": "fixture"}}
	submitAndSettleHTTP(t, f.first, f.keys[0], f.start(t, 0, first), call)
	f.now = f.now.Add(time.Second)
	input.SubmissionID = "tool-result"
	input.Messages = append(input.Messages, call, inference.Item{Type: "tool_result", CallID: call.CallID, Output: "only-on-client"})
	continuation, _ := nativeHTTP(t, f.first, "POST", "/api/v1/requests", request.SessionID, input, 202)
	if continuation.WorkerID != f.ids[0] || f.poll(t, 0, 0, usageHeaderValue(100, f.now)) != nil {
		t.Fatal("unclaimed continuation did not wait after its pinned worker exhausted quota")
	}
	grant := requireUsageClaim(t, f.poll(t, 1, 0, usageHeaderValue(50, f.now)), continuation.ID)
	brief := f.start(t, 1, grant)
	messages := brief.Context.Messages
	if len(messages) != 4 || messages[2].CallID != call.CallID || messages[3].CallID != call.CallID || messages[3].Output != "only-on-client" {
		t.Fatalf("reassigned context lost original tool linkage: %+v", messages)
	}
}

func TestWeeklyUsageConcurrentPullsKeepOneClaimWhenAllowanceUnknown(t *testing.T) {
	f := newUsageFleet(t)
	request := f.queue(t, "concurrent-unknown", 300)
	var replies [2]*httptest.ResponseRecorder
	var group sync.WaitGroup
	for i, h := range []*Handler{f.first, f.second} {
		tick := f.tick(i, 0)
		group.Go(func() {
			replies[i] = usageRequest(h, usagePullPath, f.keys[i], tick)
		})
	}
	group.Wait()
	winners := 0
	for _, reply := range replies {
		var result inference.PullResult
		nativeResponse(t, reply, 200, &result)
		if result.Job != nil {
			winners++
			requireUsageClaim(t, result.Job, request.ID)
		}
	}
	if winners != 1 {
		t.Fatalf("expected one committed pickup, got %d", winners)
	}
}

func TestWeeklyUsageBusyReportAndReplayPreserveCommittedHandoff(t *testing.T) {
	f := newUsageFleet(t)
	request := f.queue(t, "busy-quota", 300)
	grant := requireUsageClaim(t, f.poll(t, 0, 0, usageHeaderValue(33, f.now)), request.ID)
	first := f.status(t, 0)
	f.now = f.now.Add(time.Minute)
	busy := inference.BusyCheck{Version: 1, ClaimID: grant.ClaimID, Generation: grant.Generation,
		Checker: "checker-0", Occurrence: "busy-usage", ScheduledAt: f.now, Reason: "native_observation_pending"}
	route := "/api/v1/worker/jobs/" + grant.JobID + "/presence"
	weekly := usageHeaderValue(100, f.now)
	nativeResponse(t, usageRequest(f.second, route, f.keys[1], busy, weekly), 409, nil)
	nativeResponse(t, usageRequest(f.second, route, f.keys[0], busy, weekly), 200, nil)
	present := f.status(t, 0)
	if present.WeeklyUsage == nil || present.WeeklyUsage.UsedPercent != 100 ||
		!present.LastPollAt.Equal(*first.LastPollAt) || !present.Claim.DeadlineAt.Equal(grant.DeadlineAt) {
		t.Fatal("busy reading changed the claim or idle poll")
	}
	f.now = f.now.Add(time.Second)
	nativeResponse(t, usageRequest(f.first, route, f.keys[0], busy, usageHeaderValue(0, f.now)), 200, nil)
	older := f.tick(0, 0)
	older.ScheduledAt = busy.ScheduledAt.Add(-time.Second)
	nativeResponse(t, usageRequest(f.first, usagePullPath, f.keys[0], older, usageHeaderValue(0, f.now)), 200, nil)
	if view := f.status(t, 0); view.WeeklyUsage == nil || !view.WeeklyUsage.ObservedAt.Equal(present.WeeklyUsage.ObservedAt) || view.WeeklyUsage.UsedPercent != 100 {
		t.Fatal("a replay or reordered contact overrode a newer reading")
	}
	if f.poll(t, 1, 0, usageHeaderValue(1, f.now)) != nil {
		t.Fatal("pickup transferred an existing claim before native start")
	}
	f.start(t, 0, grant)
}

func TestWeeklyUsageRejectsUnusableReadingsWithoutBlockingPull(t *testing.T) {
	f := newUsageFleet(t)
	raw := func(body string) string { return base64.RawURLEncoding.EncodeToString([]byte(body)) }
	for _, headers := range [][]string{
		{"%"},
		{raw(`{"used_percent":101,"observed_at":"2026-11-23T00:00:00Z"}`)},
		{raw(`{"used_percent":0,"observed_at":"2026-11-23T00:00:00Z","reset_label":"private account metadata"}`)},
		{raw(`{"used_percent":null,"observed_at":"2026-11-23T00:00:00Z"}`)},
		{usageHeaderValue(0, f.now), usageHeaderValue(0, f.now)},
		{usageHeaderValue(20, f.now.Add(10*time.Minute))},
		{usageHeaderValue(20, f.now.Add(-2*time.Minute))},
		{usageHeaderValue(20, f.now.Add(-time.Second))},
	} {
		f.poll(t, 0, 0, headers...)
		if f.status(t, 0).WeeklyUsage != nil {
			t.Fatal("an invalid reading became available")
		}
		f.now = f.now.Add(time.Second)
	}
	job := f.queue(t, "available-without-report", 300)
	requireUsageClaim(t, f.poll(t, 0, 0, "invalid"), job.ID)
}

func TestWeeklyUsageKeepsHealthySessionPinWithFreerPeer(t *testing.T) {
	f := newUsageFleet(t)
	input := nativeHTTPInput("")
	request, _ := nativeHTTP(t, f.first, "POST", "/api/v1/requests", "affinity", input, 202)
	result := inference.Item{Type: "final", Text: "first answer"}
	grant := requireUsageClaim(t, f.poll(t, 0, 0, usageHeaderValue(70, f.now)), request.ID)
	submitAndSettleHTTP(t, f.first, f.keys[0], f.start(t, 0, grant), result)
	f.now = f.now.Add(time.Second)
	input.SubmissionID = "affinity-next"
	input.Messages = append(input.Messages, inference.Item{Type: "message", Role: "assistant", Text: result.Text},
		inference.Item{Type: "message", Role: "user", Text: "continue"})
	next, _ := nativeHTTP(t, f.first, "POST", "/api/v1/requests", request.SessionID, input, 202)
	if f.poll(t, 1, 0, usageHeaderValue(20, f.now)) != nil {
		t.Fatal("more weekly allowance displaced a healthy pin")
	}
	requireUsageClaim(t, f.poll(t, 0, 0, usageHeaderValue(70, f.now)), next.ID)
}
