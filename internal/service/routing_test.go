package service

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func autoInput(id string) inference.RequestInput {
	return inference.RequestInput{Version: 1, SubmissionID: id, Messages: []inference.Item{{Type: "message", Role: "user", Text: id}}, Tools: []inference.Tool{}}
}

func qualificationTrials(t *testing.T, b *Broker, m *inferenceMemory, logger *slog.Logger, id string, c inference.Connection) (inference.Experiment, inference.Experiment) {
	t.Helper()
	data, err := b.Create(context.Background(), logger, inference.Create{Version: 1, SubmissionID: "ready-" + id, WorkerID: id, Messages: []inference.Item{{Type: "message", Role: "user", Text: "unpredictable-ready-" + id}}, Tools: []inference.Tool{}})
	ready := decodeResult[inference.Experiment](t, data, err)
	j := claimInference(t, b, logger, c, ready, "ready-claim-"+id)
	_, err = b.Decide(context.Background(), logger, id, j.ID, submission(j, c, "ready-reply-"+id, inference.Item{Type: "final", Text: "unpredictable-ready-" + id}))
	if err != nil {
		t.Fatal(err)
	}
	tool := createInference(t, b, logger, id, "tool-"+id, 300)
	j = claimInference(t, b, logger, c, tool, "tool-claim-"+id)
	_, err = b.Decide(context.Background(), logger, id, j.ID, submission(j, c, "tool-call-"+id, inference.Item{Type: "tool_call", CallID: "client-call", Name: "read_file", Arguments: map[string]any{"path": "client-only"}}))
	if err != nil {
		t.Fatal(err)
	}
	data, err = b.ToolResult(context.Background(), logger, tool.ID, inference.ToolResult{Version: 1, SubmissionID: "result-" + id, CallID: "client-call", Output: "exact client-only\r\nvalue\n"})
	tool = decodeResult[inference.Experiment](t, data, err)
	j = claimInference(t, b, logger, c, tool, "tool-final-claim-"+id)
	_, err = b.Decide(context.Background(), logger, id, j.ID, submission(j, c, "tool-final-"+id, inference.Item{Type: "final", Text: "exact client-only\r\nvalue\n"}))
	if err != nil {
		t.Fatal(err)
	}
	return ready, tool
}

func approvalInput(id string, ready, tool inference.Experiment) inference.QualificationInput {
	return inference.QualificationInput{Version: 1, SubmissionID: "approve-" + id, Action: "approve", EvidenceKind: "controlled", EvidenceReference: "controlled software trial; no live qualification", ReadinessExperimentID: ready.ID, ToolExperimentID: tool.ID}
}

func TestQualificationUsesAuthenticatedTrialsAndPreservesProvenance(t *testing.T) {
	b, m, logger, logs := inferenceFixture()
	c := connectInference(t, b, m, logger, "worker-a")
	ready, tool := qualificationTrials(t, b, m, logger, "worker-a", c)
	input := approvalInput("a", ready, tool)
	data, err := b.Qualify(context.Background(), logger, "worker-a", input)
	q := decodeResult[inference.Qualification](t, data, err)
	_, err = b.Qualify(context.Background(), logger, "worker-b", input)
	requireInferenceReason(t, err, "submission_conflict")
	if len(q.Capabilities) != 2 || q.ConnectionGeneration != c.Generation || q.Input.EvidenceKind != "controlled" || readiness(m.states["worker-a"]) != "verified" {
		t.Fatal("qualification evidence lost", q)
	}
	data, err = b.Qualify(context.Background(), logger, "worker-a", input)
	if decodeResult[inference.Qualification](t, data, err).ID != q.ID || len(m.states["worker-a"].Routing.Qualifications) != 1 {
		t.Fatal("approval replay changed authority")
	}
	input.EvidenceReference = "changed"
	_, err = b.Qualify(context.Background(), logger, "worker-a", input)
	requireInferenceReason(t, err, "submission_conflict")
	request := admitted(t, b, "alice", "eligible", autoInput("eligible"))
	j := m.states[request.WorkerID].Jobs[m.states[request.WorkerID].Experiments[request.ID].CurrentJobID]
	if j.Qualification == nil || j.Qualification.ID != q.ID {
		t.Fatal("assignment omitted immutable qualification")
	}
	_, err = b.Qualify(context.Background(), logger, "worker-a", inference.QualificationInput{Version: 1, SubmissionID: "withdraw", Action: "withdraw", EvidenceReference: "operator withdrawal"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = b.Qualify(context.Background(), logger, "worker-b", inference.QualificationInput{Version: 1, SubmissionID: "withdraw", Action: "withdraw", EvidenceReference: "operator withdrawal"})
	requireInferenceReason(t, err, "submission_conflict")
	if len(m.states["worker-b"].Routing.Qualifications) != 0 {
		t.Fatal("cross-worker retry changed authority")
	}
	if readiness(m.states["worker-a"]) != "withdrawn" || len(m.states["worker-a"].Routing.Qualifications) != 2 {
		t.Fatal("withdrawal erased history")
	}
	_, err = b.Claim(context.Background(), logger, "worker-a", j.ID, inference.Claim{Version: 1, SubmissionID: "withdrawn-claim", ConnectionID: c.ID, ConnectionGeneration: c.Generation})
	requireInferenceReason(t, err, "no_ready_worker")
	events, err := b.Poll(context.Background(), logger, "worker-a", c.ID, c.Generation)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Type == "job.available" {
			t.Fatal("withdrawn job offered")
		}
	}
	if j.Qualification.ID != q.ID || !strings.Contains(logs.String(), "worker.qualification_changed") {
		t.Fatal("qualification snapshot or diagnostics lost")
	}
}

func TestQualificationRejectsUnsupportedIncompleteForeignAndStaleEvidence(t *testing.T) {
	for _, kind := range []string{"version", "id", "action", "reference", "long-reference", "kind", "ready-id", "tool-id", "missing", "foreign", "not-completed", "native", "no-jobs", "queued-job", "wrong-generation", "wrong-echo", "tool-linkage", "offline", "revoked", "random"} {
		t.Run(kind, func(t *testing.T) {
			b, m, logger, _ := inferenceFixture()
			c := connectInference(t, b, m, logger, "worker-a")
			ready, tool := qualificationTrials(t, b, m, logger, "worker-a", c)
			in := approvalInput("a", ready, tool)
			s := m.states["worker-a"]
			switch kind {
			case "version":
				in.Version = 2
			case "id":
				in.SubmissionID = "bad id"
			case "action":
				in.Action = "enable"
			case "reference":
				in.EvidenceReference = " "
			case "long-reference":
				in.EvidenceReference = strings.Repeat("x", 1025)
			case "kind":
				in.EvidenceKind = "self-reported"
			case "ready-id":
				in.ReadinessExperimentID = "!"
			case "tool-id":
				in.ToolExperimentID = "!"
			case "missing":
				in.ReadinessExperimentID = "missing"
			case "foreign":
				s.Experiments[ready.ID].WorkerID = "worker-b"
			case "not-completed":
				s.Experiments[ready.ID].State = "cancelled"
			case "native":
				s.Requests = map[string]*inference.Request{ready.ID: {ID: ready.ID, ConversationID: "not-native", WorkerID: "worker-a"}}
				s.Conversations = map[string]*inference.Conversation{"not-native": {ID: "not-native", WorkerID: "worker-a"}}
			case "no-jobs":
				delete(s.Jobs, s.Experiments[ready.ID].CurrentJobID)
			case "queued-job":
				s.Jobs[s.Experiments[ready.ID].CurrentJobID].State = "queued"
			case "wrong-generation":
				s.Jobs[s.Experiments[ready.ID].CurrentJobID].ConnectionGeneration++
			case "wrong-echo":
				s.Experiments[ready.ID].Messages[0].Text = "changed"
			case "tool-linkage":
				s.Experiments[tool.ID].Messages[3].CallID = "wrong"
			case "offline":
				s.Connection.Connected = false
			case "revoked":
				s.Revoked = true
			case "random":
				b.random = iotest.ErrReader(errors.New("random unavailable"))
			}
			if _, err := b.Qualify(context.Background(), logger, "worker-a", in); err == nil {
				t.Fatal("invalid evidence approved", kind)
			}
		})
	}
}

func TestRoutingFairnessQueueIsolationAndAdmissionLimits(t *testing.T) {
	b, m, logger, logs := inferenceFixture()
	b.maxJobs = 8
	a := connectNative(t, b, m, logger, "worker-a")
	z := connectNative(t, b, m, logger, "worker-b")
	first := admitted(t, b, "alice", "a", autoInput("first"))
	second := admitted(t, b, "alice", "b", autoInput("second"))
	if first.WorkerID == second.WorkerID {
		t.Fatal("idle workers not distributed")
	}
	ja := nativeJob(t, b, m, a, first)
	jz := nativeJob(t, b, m, z, second)
	third := admitted(t, b, "alice", "c", autoInput("third"))
	m.now = m.now.Add(time.Nanosecond)
	fourth := admitted(t, b, "alice", "d", autoInput("fourth"))
	if third.WorkerID != "" || fourth.WorkerID != "" || m.states[""].Experiments[third.ID].CurrentJobID != "" {
		t.Fatal("busy workers received premature assignment")
	}
	_, err := b.SubmitRequest(context.Background(), logger, "alice", "a", autoInput("overlap"))
	requireInferenceReason(t, err, "session_busy")
	_, err = b.ReadRequest(context.Background(), logger, "bob", third.ID, "")
	requireInferenceReason(t, err, "history_owner_denied")
	data, err := b.Decide(context.Background(), logger, first.WorkerID, ja.ID, submission(ja, a, "done-a", inference.Item{Type: "final", Text: "A only"}))
	decodeResult[inference.Experiment](t, data, err)
	if err = b.Dispatch(context.Background(), logger); err != nil {
		t.Fatal(err)
	}
	r, err := b.ReadRequest(context.Background(), logger, "alice", third.ID, "")
	if err != nil || r.WorkerID != first.WorkerID {
		t.Fatal("oldest queue entry not assigned", r, err)
	}
	queued, err := b.ReadRequest(context.Background(), logger, "alice", fourth.ID, "")
	if err != nil || queued.WorkerID != "" {
		t.Fatal("worker double-reserved")
	}
	data, err = b.Decide(context.Background(), logger, second.WorkerID, jz.ID, submission(jz, z, "done-b", inference.Item{Type: "final", Text: "B only"}))
	decodeResult[inference.Experiment](t, data, err)
	if err = b.Dispatch(context.Background(), logger); err != nil {
		t.Fatal(err)
	}
	r, err = b.ReadRequest(context.Background(), logger, "alice", fourth.ID, "")
	if err != nil || r.WorkerID != second.WorkerID {
		t.Fatal("other worker did not progress")
	}
	b.maxJobs = 2
	_, err = b.SubmitRequest(context.Background(), logger, "alice", "full", autoInput("full"))
	requireInferenceReason(t, err, "queue_full")
	if !strings.Contains(logs.String(), "dispatch.rejected") || !strings.Contains(logs.String(), "dispatch.assigned") {
		t.Fatal("routing events absent")
	}
}

func TestRoutingSafeOfflineReassignmentAndExposureFence(t *testing.T) {
	for _, boundary := range []string{"safe", "context", "claimed", "tool-wait", "uncertain"} {
		t.Run(boundary, func(t *testing.T) {
			b, m, logger, logs := inferenceFixture()
			b.maxJobs = 10
			ca := connectNative(t, b, m, logger, "worker-a")
			connectNative(t, b, m, logger, "worker-b")
			in := autoInput("start")
			if boundary == "tool-wait" {
				in.Tools = requestInput("tools").Tools
			}
			v := admitted(t, b, "alice", "pin", in)
			decision := inference.Item{Type: "final", Text: "first final"}
			if boundary == "tool-wait" {
				decision = inference.Item{Type: "tool_call", CallID: "call", Name: "read_file", Arguments: map[string]any{"path": "client"}}
			}
			connection := ca
			if v.WorkerID != "worker-a" {
				connection = m.states[v.WorkerID].Connection
			}
			nativeDecide(t, b, m, connection, v, decision)
			worker := v.WorkerID
			canonical := inference.Messages(m.states[worker].Conversations[v.ConversationID], m.states[worker].Conversations[v.ConversationID].ItemCount)
			next := autoInput("next")
			next.Messages = append(canonical, inference.Item{Type: "message", Role: "user", Text: "next"})
			if boundary == "tool-wait" {
				next.Messages = append(canonical, inference.Item{Type: "tool_result", CallID: "call", Output: "client result"})
			}
			pending := admitted(t, b, "alice", v.SessionID, next)
			e := m.states[worker].Experiments[pending.ID]
			oldID := e.CurrentJobID
			if boundary == "context" {
				_, err := b.Job(context.Background(), logger, worker, oldID)
				if err != nil {
					t.Fatal(err)
				}
			}
			if boundary == "claimed" || boundary == "uncertain" {
				nativeJob(t, b, m, connection, pending)
			}
			m.states[worker].Connection.Connected = false
			if err := b.Dispatch(context.Background(), logger); err != nil {
				t.Fatal(err)
			}
			r, err := b.ReadRequest(context.Background(), logger, "alice", pending.ID, "")
			if err != nil {
				t.Fatal(err)
			}
			if boundary == "safe" {
				if r.WorkerID == worker {
					t.Fatal("safe offline pin not moved")
				}
				_, err = b.Job(context.Background(), logger, worker, oldID)
				requireInferenceReason(t, err, "stale_assignment")
				newJob := m.states[r.WorkerID].Jobs[m.states[r.WorkerID].Experiments[r.ID].CurrentJobID]
				if len(newJob.Context.Messages) != len(next.Messages) || !strings.Contains(logs.String(), "dispatch.reassigned") {
					t.Fatal("full-history reassignment evidence missing")
				}
			} else if r.WorkerID != worker {
				t.Fatal("unsafe turn reassigned", boundary)
			}
		})
	}
}

func TestRoutingHeartbeatIsNotReadinessAndReconnectInvalidatesApproval(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	c := connectInference(t, b, m, logger, "worker-a")
	_, err := b.SubmitRequest(context.Background(), logger, "alice", "", autoInput("unready"))
	requireInferenceReason(t, err, "no_ready_worker")
	c = connectNativeAfterDisconnect(t, b, m, logger, c)
	m.states["worker-a"].Routing.Qualifications[0].Capabilities = []string{"text"}
	_, err = b.SubmitRequest(context.Background(), logger, "alice", "", requestInput("tool-cap"))
	requireInferenceReason(t, err, "no_ready_worker")
	if err = b.Disconnect(context.Background(), logger, "worker-a", c.ID, c.Generation); err != nil {
		t.Fatal(err)
	}
	connectInference(t, b, m, logger, "worker-a")
	if readiness(m.states["worker-a"]) != "stale" {
		t.Fatal("reconnection retained readiness")
	}
	_, err = b.SubmitRequest(context.Background(), logger, "alice", "", autoInput("stale"))
	requireInferenceReason(t, err, "no_ready_worker")
}

func connectNativeAfterDisconnect(t *testing.T, b *Broker, m *inferenceMemory, logger *slog.Logger, c inference.Connection) inference.Connection {
	t.Helper()
	if err := b.Disconnect(context.Background(), logger, "worker-a", c.ID, c.Generation); err != nil {
		t.Fatal(err)
	}
	return connectNative(t, b, m, logger, "worker-a")
}

func TestRoutingQueueDeadlineCancellationAndConcurrentSession(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	b.maxJobs = 20
	connectNative(t, b, m, logger, "worker-a")
	v := admitted(t, b, "alice", "busy", autoInput("reserved"))
	_ = v
	input := autoInput("deadline")
	input.TimeoutSeconds = 1
	queued := admitted(t, b, "alice", "deadline", input)
	cancelled := admitted(t, b, "alice", "cancel", autoInput("cancel"))
	_, err := b.CancelRequest(context.Background(), logger, "alice", cancelled.ID, "", inference.Cancel{Version: 1, SubmissionID: "cancel-q"})
	if err != nil {
		t.Fatal(err)
	}
	m.now = m.now.Add(2 * time.Second)
	if err = b.Dispatch(context.Background(), logger); err != nil {
		t.Fatal(err)
	}
	r, err := b.ReadRequest(context.Background(), logger, "alice", queued.ID, "")
	if err != nil || r.State != "interrupted" || r.Reason != "deadline_exceeded" {
		t.Fatal("unassigned deadline lost", r, err)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	successes := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			in := autoInput("race-" + time.Unix(int64(i), 0).Format("150405"))
			_, err := b.SubmitRequest(context.Background(), testHistoryLogger(), "alice", "race", in)
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				successes++
			} else {
				var rejection *inference.Rejection
				if !errors.As(err, &rejection) || rejection.Reason != "session_busy" {
					t.Error(err)
				}
			}
		}(i)
	}
	wg.Wait()
	if successes != 1 {
		t.Fatal("session race not serialized", successes)
	}
	data, _ := json.Marshal(m.states)
	if strings.Contains(string(data), "\"qualification\":null") {
		t.Fatal("unexpected null qualification snapshot")
	}
}

func TestRoutingLeastRecentSelectionAndBlockedPinDoesNotStarveAnotherSession(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	b.maxJobs = 10
	ca := connectNative(t, b, m, logger, "worker-a")
	cz := connectNative(t, b, m, logger, "worker-b")
	a := admitted(t, b, "alice", "a", autoInput("a"))
	nativeDecide(t, b, m, ca, a, inference.Item{Type: "final", Text: "A"})
	z := admitted(t, b, "alice", "z", autoInput("z"))
	if z.WorkerID == a.WorkerID {
		t.Fatal("least recent idle worker not chosen")
	}
	nativeDecide(t, b, m, cz, z, inference.Item{Type: "final", Text: "Z"})
	busyInput := autoInput("busy-a")
	busyInput.WorkerID = a.WorkerID
	busy := admitted(t, b, "alice", "busy-a", busyInput)
	held := nativeJob(t, b, m, ca, busy)
	next := autoInput("a-next")
	next.Messages = append(inference.Messages(m.states[a.WorkerID].Conversations[a.ConversationID], 2), inference.Item{Type: "message", Role: "user", Text: "next"})
	pinned := admitted(t, b, "alice", "a", next)
	if m.states[a.WorkerID].Experiments[pinned.ID].CurrentJobID != "" {
		t.Fatal("busy pin assigned inference")
	}
	independent := admitted(t, b, "alice", "independent", autoInput("independent"))
	if independent.WorkerID != z.WorkerID {
		t.Fatal("blocked pin starved independent session")
	}
	_, err := b.Decide(context.Background(), logger, a.WorkerID, held.ID, submission(held, ca, "busy-complete", inference.Item{Type: "final", Text: "done"}))
	if err != nil {
		t.Fatal(err)
	}
	if err = b.Dispatch(context.Background(), logger); err != nil {
		t.Fatal(err)
	}
	if m.states[a.WorkerID].Experiments[pinned.ID].CurrentJobID == "" {
		t.Fatal("pin did not resume")
	}
}

func TestRoutingFirstAssignmentAndConstrainedWaitDoNotEstablishMovementAuthority(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	b.maxJobs = 8
	connectNative(t, b, m, logger, "worker-a")
	connectNative(t, b, m, logger, "worker-b")
	first := admitted(t, b, "alice", "first", autoInput("first"))
	constraint := autoInput("constrained")
	constraint.WorkerID = first.WorkerID
	waiting := admitted(t, b, "alice", "constrained", constraint)
	if waiting.WorkerID != "" || m.states[""].Conversations[waiting.ConversationID].WorkerID != "" || m.states[""].Experiments[waiting.ID].CurrentJobID != "" {
		t.Fatal("selection constraint became an early pin")
	}
	b.maxJobs = 2
	replay := admitted(t, b, "alice", "constrained", constraint)
	if replay.ID != waiting.ID {
		t.Fatal("full queue blocked constrained retry")
	}
	m.states[first.WorkerID].Connection.Connected = false
	if err := b.Dispatch(context.Background(), logger); err != nil {
		t.Fatal(err)
	}
	read, err := b.ReadRequest(context.Background(), logger, "alice", first.ID, "")
	if err != nil || read.WorkerID != first.WorkerID {
		t.Fatal("first turn moved without a prior final", read, err)
	}
}

func requireCandidateReason(t *testing.T, err error, id, reason string) {
	t.Helper()
	var rejected *inference.Rejection
	if !errors.As(err, &rejected) {
		t.Fatal("missing rejection", err)
	}
	for _, candidate := range rejected.Fields["candidates"].([]map[string]any) {
		if candidate["worker_id"] == id && candidate["eligibility_reason"] == reason {
			return
		}
	}
	t.Fatal("missing causal worker exclusion", reason)
}
