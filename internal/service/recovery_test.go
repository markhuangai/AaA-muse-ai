package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func TestRecoveryPreservesLiveLeaseQueueAndAcceptedDecision(t *testing.T) {
	b, m, log, logs := inferenceFixture()
	ctx := context.Background()
	c := connectInference(t, b, m, log, "worker-a")
	e := createInference(t, b, log, "worker-a", "live", 0)
	queued := createInference(t, b, log, "worker-a", "queued", 0)
	claim := inference.Claim{Version: 1, SubmissionID: "lost-claim-ack", ConnectionID: c.ID, ConnectionGeneration: c.Generation}
	data, err := b.Claim(ctx, log, "worker-a", e.CurrentJobID, claim)
	j := decodeResult[inference.Job](t, data, err)
	before, _ := json.Marshal(m.states["worker-a"].Connection)
	for i := 0; i < 2; i++ {
		if err = b.Recover(ctx, log); err != nil {
			t.Fatal(err)
		}
	}
	after, _ := json.Marshal(m.states["worker-a"].Connection)
	if !bytes.Equal(before, after) || !m.states["worker-a"].Jobs[j.ID].Held || m.states["worker-a"].Experiments[e.ID].State != "inference" || m.states["worker-a"].Experiments[queued.ID].CurrentJobID != queued.CurrentJobID {
		t.Fatal("recovery replaced active work or healthy connection")
	}
	replayed, err := b.Claim(ctx, log, "worker-a", j.ID, claim)
	if err != nil || !bytes.Equal(data, replayed) {
		t.Fatal("valid claim receipt changed", err)
	}
	d := submission(j, c, "lost-decision-ack", inference.Item{Type: "final", Text: "exact\r\nanswer\n"})
	accepted, err := b.Decide(ctx, log, "worker-a", j.ID, d)
	if err != nil {
		t.Fatal(err)
	}
	m.now = m.now.Add(time.Minute)
	if err = b.Recover(ctx, log); err != nil {
		t.Fatal(err)
	}
	replayed, err = b.Decide(ctx, log, "worker-a", j.ID, d)
	if err != nil || !bytes.Equal(accepted, replayed) || len(m.states["worker-a"].Experiments[e.ID].Messages) != 3 {
		t.Fatal("committed decision replay changed or duplicated history", err)
	}
	d.Decision.Text = "conflicting"
	_, err = b.Decide(ctx, log, "worker-a", j.ID, d)
	requireInferenceReason(t, err, "submission_conflict")
	if !bytes.Contains(logs.Bytes(), []byte("receipt.replayed")) || !bytes.Contains(logs.Bytes(), []byte("recovery.uncertain")) {
		t.Fatal("recovery/replay evidence absent")
	}
}

func TestRecoveryExpiredAndCancelledHoldsSurviveReconnect(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		b, m, log, _ := inferenceFixture()
		ctx := context.Background()
		c := connectInference(t, b, m, log, "worker-a")
		e := createInference(t, b, log, "worker-a", "uncertain", 0)
		j := claimInference(t, b, log, c, e, "claim")
		if cancelled {
			if _, err := b.Cancel(ctx, log, e.ID, inference.Cancel{Version: 1, SubmissionID: "cancel"}); err != nil {
				t.Fatal(err)
			}
		}
		m.now = m.now.Add(inference.HealthWindow + time.Second)
		if err := b.Recover(ctx, log); err != nil {
			t.Fatal(err)
		}
		state := m.states["worker-a"]
		if !state.Jobs[j.ID].Held || state.Experiments[e.ID].RemoteOutcome != "unknown" || (!cancelled && state.Experiments[e.ID].State != "interrupted") {
			t.Fatal("uncertain work lost its hold/outcome")
		}
		c2 := connectInference(t, b, m, log, "worker-a")
		_, err := b.Decide(ctx, log, "worker-a", j.ID, submission(j, c, "late", inference.Item{Type: "final", Text: "late"}))
		requireInferenceReason(t, err, "stale_connection")
		if !m.states["worker-a"].Jobs[j.ID].Held || c2.Generation <= c.Generation || m.states["worker-a"].Connection.AssignmentGeneration != j.Generation {
			t.Fatal("reconnect reset hold or generations")
		}
		m.now = m.now.Add(inference.HealthInterval)
		p := heartbeatInference(t, b, log, c2, "worker-a", &inference.Assignment{JobID: j.ID, Generation: j.Generation, LeaseID: j.LeaseID})
		if p.WorkStatus != "idle" || m.states["worker-a"].Experiments[e.ID].RemoteOutcome != "unknown" {
			t.Fatal("idle acknowledgement replayed inference or hid uncertainty")
		}
	}
}

func TestClaimReceiptNeverRestoresExpiredAuthority(t *testing.T) {
	for _, mode := range []string{"state", "held", "generation", "lease", "job-connection", "job-connection-generation", "context", "expiry", "missing-expiry", "deadline", "terminal", "missing-experiment", "missing-job", "connection", "malformed-receipt"} {
		t.Run(mode, func(t *testing.T) {
			b, m, log, logs := inferenceFixture()
			ctx := context.Background()
			c := connectInference(t, b, m, log, "worker-a")
			e := createInference(t, b, log, "worker-a", "claim-replay", 0)
			input := inference.Claim{Version: 1, SubmissionID: "claim", ConnectionID: c.ID, ConnectionGeneration: c.Generation}
			if _, err := b.Claim(ctx, log, "worker-a", e.CurrentJobID, input); err != nil {
				t.Fatal(err)
			}
			s, reason := m.states["worker-a"], "stale_assignment"
			j := s.Jobs[e.CurrentJobID]
			switch mode {
			case "state":
				j.State = "cancelled"
			case "held":
				j.Held = false
			case "generation":
				j.Generation++
			case "lease":
				j.LeaseID = "another"
			case "job-connection":
				j.ConnectionID = "another"
			case "job-connection-generation":
				j.ConnectionGeneration++
			case "context":
				j.Context.ReceiptID = "another"
			case "expiry":
				j.LeaseExpiresAt = &m.now
			case "missing-expiry":
				j.LeaseExpiresAt = nil
			case "deadline":
				j.DeadlineAt = m.now
			case "terminal":
				s.Experiments[e.ID].State = "interrupted"
			case "missing-experiment":
				delete(s.Experiments, e.ID)
			case "missing-job":
				delete(s.Jobs, j.ID)
			case "connection":
				s.Connection.Connected = false
				reason = "stale_connection"
			case "malformed-receipt":
				m.receipts["worker:worker-a:claim"].Result = json.RawMessage(`{`)
			}
			logs.Reset()
			_, err := b.Claim(ctx, log, "worker-a", e.CurrentJobID, input)
			if mode == "malformed-receipt" {
				if err == nil {
					t.Fatal("invalid receipt accepted")
				}
				return
			}
			if mode == "missing-job" && err != nil && err.Error() == "inference_not_found" {
				return
			}
			requireInferenceReason(t, err, reason)
			if bytes.Contains(logs.Bytes(), []byte("receipt.replayed")) || !bytes.Contains(logs.Bytes(), []byte("lease.fenced")) {
				t.Fatal("rejected claim replay misreported")
			}
		})
	}
}

func TestRecoveryNativeToolWaitAndDeliveryBoundary(t *testing.T) {
	b, m, log, logs := inferenceFixture()
	ctx := context.Background()
	c := connectNative(t, b, m, log, "worker-a")
	input := requestInput("native-recovery")
	v := admitted(t, b, "alice", "recovery-session", input)
	tool := inference.Item{Type: "tool_call", CallID: "preserved-call", Name: "read_file", Arguments: map[string]any{"path": "client-only"}}
	nativeDecide(t, b, m, c, v, tool)
	if err := b.OutputBoundary(ctx, log, "alice", v.ID, false, 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(m.states["worker-a"].Conversations[v.ConversationID].Items)
	if err := b.Recover(ctx, log); err != nil {
		t.Fatal(err)
	}
	s := m.states["worker-a"]
	after, _ := json.Marshal(s.Conversations[v.ConversationID].Items)
	if !bytes.Equal(before, after) || s.Conversations[v.ConversationID].PendingCallID != tool.CallID || s.Conversations[v.ConversationID].WorkerID != "worker-a" || s.Requests[v.ID].OutputStartedAt == nil || s.Requests[v.ID].OutputCompletedAt != nil || s.Requests[v.ID].Output.CallID != tool.CallID {
		t.Fatal("recovery changed tool wait, pin or delivery boundary")
	}
	continued := input
	continued.SubmissionID = "continued"
	continued.PreviousResponseID = v.ResponseID
	continued.Messages = append(append([]inference.Item{}, input.Messages...), tool, inference.Item{Type: "tool_result", CallID: tool.CallID, Output: "exact\r\nclient value\n"})
	next := admitted(t, b, "alice", "recovery-session", continued)
	j := nativeDecide(t, b, m, c, next, inference.Item{Type: "final", Text: "exact\r\nclient value\n"})
	if j.Context.Kind != "full" || j.Context.Messages[len(j.Context.Messages)-1].CallID != tool.CallID || !bytes.Contains(logs.Bytes(), []byte("output_delivery")) {
		t.Fatal("continuation lost full context or diagnostic boundary")
	}
}

func TestRecoveryFailureDoesNotLogRestoration(t *testing.T) {
	for _, failure := range []string{"load", "commit"} {
		b, m, log, logs := inferenceFixture()
		if failure == "load" {
			m.fail = errors.New("load rejected")
		} else {
			m.persistFail = errors.New("commit rejected")
		}
		if err := b.Recover(context.Background(), log); err == nil {
			t.Fatal("recovery failed open")
		}
		if bytes.Contains(logs.Bytes(), []byte("recovery.restored")) || !bytes.Contains(logs.Bytes(), []byte("recovery.failed")) {
			t.Fatal("uncommitted restoration reported")
		}
	}
}

func TestRecoveryContextOnlyHasApplicableCorrectiveAction(t *testing.T) {
	b, m, log, logs := inferenceFixture()
	ctx := context.Background()
	connectNative(t, b, m, log, "worker-a")
	v := admitted(t, b, "alice", "context-only", requestInput("context-only"))
	e := m.states["worker-a"].Experiments[v.ID]
	if _, err := b.Job(ctx, log, "worker-a", e.CurrentJobID); err != nil {
		t.Fatal(err)
	}
	logs.Reset()
	if err := b.Recover(ctx, log); err != nil {
		t.Fatal(err)
	}
	r := m.states["worker-a"].Requests[v.ID]
	if r.Output != nil || r.ContextDeliveryStarted == nil || r.ContextDeliveryWritten != nil || r.State != "queued" {
		t.Fatal("context-only recovery invented inference or output")
	}
	found := false
	for _, line := range bytes.Split(logs.Bytes(), []byte("\n")) {
		var event map[string]any
		if json.Unmarshal(line, &event) != nil || event["msg"] != "recovery.uncertain" {
			continue
		}
		if event["last_boundary"] == "context_delivery" {
			found = true
			if event["reason"] != "delivery_completion_receipt_missing" || event["decision_available"] != false || !bytes.Contains([]byte(event["corrective_action"].(string)), []byte("same unclaimed job")) {
				t.Fatal("context diagnosis assumes a nonexistent decision")
			}
		}
	}
	if !found {
		t.Fatal("context-only uncertainty not recorded")
	}
}

func TestFenceWarningsIncludeBothGenerationBoundaries(t *testing.T) {
	for _, operation := range []string{"claim", "decision"} {
		for _, reconnected := range []bool{false, true} {
			b, m, log, logs := inferenceFixture()
			ctx := context.Background()
			c := connectInference(t, b, m, log, "worker-a")
			e := createInference(t, b, log, "worker-a", "fence-evidence", 0)
			claim := inference.Claim{Version: 1, SubmissionID: "claim", ConnectionID: c.ID, ConnectionGeneration: c.Generation}
			data, err := b.Claim(ctx, log, "worker-a", e.CurrentJobID, claim)
			j := decodeResult[inference.Job](t, data, err)
			if reconnected {
				m.states["worker-a"].Connection.Generation++
			} else {
				m.states["worker-a"].Jobs[j.ID].State = "cancelled"
			}
			logs.Reset()
			if operation == "claim" {
				_, err = b.Claim(ctx, log, "worker-a", j.ID, claim)
			} else {
				_, err = b.Decide(ctx, log, "worker-a", j.ID, submission(j, c, "late", inference.Item{Type: "final", Text: "late"}))
			}
			if err == nil {
				t.Fatal("stale operation accepted")
			}
			found := false
			for _, line := range bytes.Split(logs.Bytes(), []byte("\n")) {
				var event map[string]any
				if json.Unmarshal(line, &event) != nil || event["msg"] != "lease.fenced" {
					continue
				}
				found = true
				evidence := event["evidence"].(map[string]any)
				if event["outcome"] != "rejected" || evidence["expected_generation"] != float64(j.Generation) || evidence["observed_generation"] != float64(j.Generation) || evidence["expected_connection_generation"] != float64(m.states["worker-a"].Connection.Generation) || evidence["observed_connection_generation"] != float64(c.Generation) {
					t.Fatal("fence omitted current or submitted generation", event)
				}
			}
			if !found {
				t.Fatal("fence evidence absent")
			}
		}
	}
}
