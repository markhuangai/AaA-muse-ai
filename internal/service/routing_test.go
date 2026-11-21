package service

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func autoInput(id string) inference.RequestInput {
	return inference.RequestInput{Version: 1, SubmissionID: id, Messages: []inference.Item{{Type: "message", Role: "user", Text: id}}, Tools: []inference.Tool{}}
}

func TestRoutingFairnessQueueIsolationAndAdmissionLimits(t *testing.T) {
	b, m, logger, logs := inferenceFixture()

	a := connectInference(t, b, m, logger, "worker-a")
	z := connectInference(t, b, m, logger, "worker-b")
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

	queued = admitted(t, b, "alice", "over-former-cap", autoInput("over-former-cap"))
	if queued.WorkerID != "" {
		t.Fatal("busy workers admitted a second assignment")
	}
	if !strings.Contains(logs.String(), "dispatch.assigned") {
		t.Fatal("routing events absent")
	}
}

func TestRoutingSafeOfflineReassignmentAndExposureFence(t *testing.T) {
	for _, boundary := range []string{"safe", "context", "claimed", "tool-wait", "uncertain"} {
		t.Run(boundary, func(t *testing.T) {
			b, m, logger, logs := inferenceFixture()

			ca := connectInference(t, b, m, logger, "worker-a")
			connectInference(t, b, m, logger, "worker-b")
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

func TestRoutingReconnectWithArchivedWithdrawal(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	ctx := context.Background()
	c := connectInference(t, b, m, logger, "worker-a")
	evidence := []inference.Qualification{{ID: "withdrawn", WorkerID: "worker-a", ConnectionID: c.ID,
		ConnectionGeneration: c.Generation, Input: inference.QualificationInput{Action: "withdraw", EvidenceReference: "historical"}}}
	m.states["worker-a"].Routing.Qualifications = evidence
	if err := b.Disconnect(ctx, logger, "worker-a", c.ID, c.Generation); err != nil {
		t.Fatal(err)
	}
	_, err := b.SubmitRequest(ctx, logger, "alice", "", autoInput("offline"))
	requireInferenceReason(t, err, "no_ready_worker")
	reconnected := connectInference(t, b, m, logger, "worker-a")
	v := admitted(t, b, "alice", "recovered-session", requestInput("recovered"))
	j := nativeJob(t, b, m, reconnected, v)
	if j.Qualification != nil || j.ConnectionGeneration != reconnected.Generation || reconnected.Generation <= c.Generation {
		t.Fatal("recovered assignment lost fencing or included a qualification")
	}
	_, err = b.Decide(ctx, logger, "worker-a", j.ID, submission(j, c, "old-connection", inference.Item{Type: "final", Text: "old"}))
	requireInferenceReason(t, err, "stale_connection")
	_, err = b.Decide(ctx, logger, "worker-a", j.ID, submission(j, reconnected, "recovered-final", inference.Item{Type: "final", Text: "recovered answer"}))
	if err != nil {
		t.Fatal(err)
	}
	result, err := b.ReadRequest(ctx, logger, "alice", v.ID, "")
	projection := project(m.states["worker-a"])
	if err != nil || result.Output == nil || result.Output.Text != "recovered answer" ||
		projection.InferenceReadiness != "withdrawn" || !reflect.DeepEqual(projection.QualificationHistory, evidence) {
		t.Fatal("client work or archived evidence was lost", result, err)
	}
	m.states["worker-a"].Revoked = true
	_, err = b.SubmitRequest(ctx, logger, "alice", "", autoInput("revoked"))
	requireInferenceReason(t, err, "no_ready_worker")
}

func TestRoutingReconnectKeepsUncertainWorkHeld(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	ctx := context.Background()
	c := connectInference(t, b, m, logger, "worker-a")
	first := admitted(t, b, "alice", "uncertain", autoInput("claimed"))
	j := nativeJob(t, b, m, c, first)
	if err := b.Disconnect(ctx, logger, "worker-a", c.ID, c.Generation); err != nil {
		t.Fatal(err)
	}
	connectInference(t, b, m, logger, "worker-a")
	next := admitted(t, b, "alice", "new-session", autoInput("queued-after-reconnect"))
	if err := b.Dispatch(ctx, logger); err != nil {
		t.Fatal(err)
	}
	state := m.states["worker-a"]
	if !state.Jobs[j.ID].Held || state.Experiments[first.ID].RemoteOutcome != "unknown" || next.WorkerID != "" || next.State != "queued" || state.Requests[next.ID] != nil || state.Connection.AssignmentGeneration != j.Generation {
		t.Fatal("reconnect released uncertain work or assigned new work over its hold")
	}
	_, err := b.Decide(ctx, logger, "worker-a", j.ID, submission(j, c, "late-uncertain", inference.Item{Type: "final", Text: "late"}))
	requireInferenceReason(t, err, "stale_connection")
}

func TestRoutingQueueDeadlineCancellationAndConcurrentSession(t *testing.T) {
	b, m, logger, _ := inferenceFixture()

	connectInference(t, b, m, logger, "worker-a")
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

	ca := connectInference(t, b, m, logger, "worker-a")
	cz := connectInference(t, b, m, logger, "worker-b")
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

	connectInference(t, b, m, logger, "worker-a")
	connectInference(t, b, m, logger, "worker-b")
	first := admitted(t, b, "alice", "first", autoInput("first"))
	constraint := autoInput("constrained")
	constraint.WorkerID = first.WorkerID
	waiting := admitted(t, b, "alice", "constrained", constraint)
	if waiting.WorkerID != "" || m.states[""].Conversations[waiting.ConversationID].WorkerID != "" || m.states[""].Experiments[waiting.ID].CurrentJobID != "" {
		t.Fatal("selection constraint became an early pin")
	}

	replay := admitted(t, b, "alice", "constrained", constraint)
	if replay.ID != waiting.ID {
		t.Fatal("queued request retry changed identity")
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
