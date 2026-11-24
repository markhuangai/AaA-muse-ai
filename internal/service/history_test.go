package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func TestNativeContactStatusUsesBrokerBoundariesWithoutReleasingClaim(t *testing.T) {
	contact := time.Date(2026, 11, 21, 17, 0, 0, 0, time.UTC)
	deadline := contact.Add(15 * time.Minute)
	job := &inference.Job{ID: "job", WorkerID: "worker", State: "claimed", ClaimedAt: &contact, DeadlineAt: deadline, Held: true, LeaseID: "claim", Generation: 1}
	for _, sample := range []struct {
		elapsed time.Duration
		status  string
	}{
		{0, "recent"},
		{time.Minute - time.Microsecond, "recent"},
		{time.Minute, "quiet"},
		{10*time.Minute - time.Microsecond, "quiet"},
		{10 * time.Minute, "offline"},
		{12 * time.Minute, "offline"},
	} {
		t.Run(sample.elapsed.String(), func(t *testing.T) {
			s := &inference.State{WorkerID: "worker", Now: contact.Add(sample.elapsed), LastContactAt: &contact, LastPollAt: &contact, Jobs: map[string]*inference.Job{job.ID: job}}
			projection := project(s)
			applyPullProjection(&projection, s)
			if projection.ConnectionStatus != sample.status || projection.WorkStatus != "busy" || projection.Claim == nil ||
				projection.Claim.ClaimID != job.LeaseID || !projection.Claim.DeadlineAt.Equal(deadline) ||
				projection.ClaimAgeMS == nil || *projection.ClaimAgeMS != sample.elapsed.Milliseconds() || !job.Held {
				t.Fatalf("incorrect claim/contact projection: %+v", projection)
			}
		})
	}
}

func memoryHistoryScope(states map[string]*inference.State, ref *inference.Ref) error {
	if ref.ClientID == "" {
		return nil
	}
	var c *inference.Conversation
	if ref.ExperimentID != "" || ref.ResponseID != "" {
		for _, s := range states {
			for _, r := range s.Requests {
				if r.ClientID == ref.ClientID && ((ref.ExperimentID != "" && r.ID == ref.ExperimentID) || (ref.ResponseID != "" && r.ResponseID == ref.ResponseID)) {
					if ref.ResponseID != "" && r.Output == nil {
						return inference.Reject("response_not_completed", 409)
					}
					c = s.Conversations[r.ConversationID]
				}
			}
		}
		if c == nil {
			return inference.Reject("history_owner_denied", 404)
		}
		if ref.SessionID != "" && ref.SessionID != c.SessionID {
			return inference.Reject("session_reference_conflict", 409)
		}
	} else if ref.SessionID != "" {
		for _, s := range states {
			for _, candidate := range s.Conversations {
				if candidate.ClientID == ref.ClientID && candidate.SessionID == ref.SessionID {
					c = candidate
				}
			}
		}
	}
	if c == nil {
		return nil
	}
	if c.WorkerID != "" && ref.WorkerID != "" && ref.WorkerID != c.WorkerID {
		return inference.Reject("session_worker_conflict", 409)
	}
	ref.WorkerID, ref.ConversationID = c.WorkerID, c.ID
	for _, s := range states {
		for _, r := range s.Requests {
			if r.ConversationID == c.ID && r.ReplayHash == ref.ReplayHash {
				ref.ExperimentID = r.ID
			}
		}
	}
	return nil
}

func requestInput(id string) inference.RequestInput {
	return inference.RequestInput{Version: 1, SubmissionID: id, WorkerID: "worker-a", Messages: []inference.Item{{Type: "message", Role: "system", Text: "Keep exact values\r\n"}, {Type: "message", Role: "user", Text: "First question"}}, Tools: []inference.Tool{{Name: "read_file", Parameters: map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}, "number": map[string]any{"type": "number"}}, "required": []any{"path"}, "additionalProperties": false}}}}
}

func admitted(t *testing.T, b *Broker, client, session string, input inference.RequestInput) inference.RequestView {
	t.Helper()
	v, err := b.SubmitRequest(context.Background(), testHistoryLogger(), client, session, input)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func testHistoryLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func nativeJob(t *testing.T, b *Broker, m *inferenceMemory, c inference.Connection, v inference.RequestView) inference.Job {
	t.Helper()
	for worker, state := range m.states {
		if worker != "" && state.Connection.ID == c.ID {
			return startFixtureJob(t, b, m, worker, v.ID)
		}
	}
	t.Fatal("controlled worker not found")
	return inference.Job{}
}

func startFixtureJob(t *testing.T, b *Broker, m *inferenceMemory, worker, operation string) inference.Job {
	t.Helper()
	ctx, logger := context.Background(), testHistoryLogger()
	var grant *inference.Grant
	err := m.WithinInference(ctx, inference.Ref{WorkerID: worker, Routing: true}, func(pool *inference.State) error {
		experiment := pool.Experiments[operation]
		job := pool.Jobs[experiment.CurrentJobID]
		if job.WorkerID != "" && job.WorkerID != worker {
			return fmt.Errorf("fixture work targets %s, not %s", job.WorkerID, worker)
		}
		for _, active := range pool.Jobs {
			if active.Held && active.WorkerID == worker {
				return fmt.Errorf("fixture worker %s still holds %s", worker, active.ID)
			}
		}
		pool.Pool[worker].LastPollAt, pool.Pool[worker].LastContactAt = &pool.Now, &pool.Now
		candidate := *pool
		candidate.Jobs = map[string]*inference.Job{job.ID: job}
		var err error
		grant, err = b.claimPulledJob(&candidate, false)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := b.StartWork(ctx, logger, worker, grant.JobID, inference.WorkStart{Version: 1, ClaimID: grant.ClaimID,
		Generation: grant.Generation, LaunchID: "launch-" + grant.JobID, NativeJob: "once-" + grant.JobID})
	return decodeResult[inference.Job](t, data, err)
}

func settleFixtureJob(t *testing.T, b *Broker, j inference.Job) inference.WorkOutcome {
	t.Helper()
	data, err := b.InterruptWork(context.Background(), testHistoryLogger(), j.WorkerID, j.ID, inference.Interruption{Version: 1,
		SubmissionID: "settle-" + j.ID, ClaimID: j.LeaseID, Generation: j.Generation, LaunchID: j.LaunchID,
		NativeJob: j.NativeJob, NativeRun: "execution-" + j.ID, Reason: "execution_confirmed_stopped"})
	return decodeResult[inference.WorkOutcome](t, data, err)
}

func nativeDecide(t *testing.T, b *Broker, m *inferenceMemory, c inference.Connection, v inference.RequestView, item inference.Item) inference.Job {
	t.Helper()
	j := nativeJob(t, b, m, c, v)
	if _, err := b.Decide(context.Background(), testHistoryLogger(), j.WorkerID, j.ID, submission(j, inference.Connection{}, "decision-"+j.ID, item)); err != nil {
		t.Fatal(err)
	}
	if receipt := settleFixtureJob(t, b, j); receipt.State != "accepted" {
		t.Fatal("result not accepted", receipt.State)
	}
	return j
}

func TestNativeCanonicalToolLoopReplayAndSnapshots(t *testing.T) {
	b, m, logger, logs := inferenceFixture()
	ctx := context.Background()
	c := connectInference(t, b, m, logger, "worker-a")
	input := requestInput("first")
	v := admitted(t, b, "alice", "session-a", input)
	if v.SessionID != "session-a" || v.Output != nil {
		t.Fatal("admission exposed model output or changed session")
	}
	busy := input
	busy.SubmissionID = "overlap"
	busy.Messages = append(append([]inference.Item{}, input.Messages...), inference.Item{Type: "message", Role: "user", Text: "overlap"})
	_, err := b.SubmitRequest(ctx, logger, "alice", "session-a", busy)
	requireInferenceReason(t, err, "session_busy")
	tool := inference.Item{Type: "tool_call", CallID: "call-once", Name: "read_file", Arguments: map[string]any{"path": "client-only", "number": json.Number("9007199254740993")}}
	job := nativeDecide(t, b, m, c, v, tool)
	if m.states["worker-a"].Experiments[v.ID].State != "completed" {
		t.Fatal("tool proposal did not complete one native decision")
	}
	if m.states["worker-a"].Conversations[v.ConversationID].PendingCallID != tool.CallID {
		t.Fatal("pending client tool not retained")
	}
	_, err = b.SubmitRequest(ctx, logger, "alice", "session-a", input)
	if err != nil {
		t.Fatal("exact submission replay failed", err)
	}
	replay := input
	replay.SubmissionID = "different-submission"
	again := admitted(t, b, "alice", "session-a", replay)
	if again.ID != v.ID || len(m.states["worker-a"].Jobs) != 1 {
		t.Fatal("repeated input created work")
	}
	otherInput := requestInput("interleaved-b")
	otherInput.Messages = []inference.Item{{Type: "message", Role: "user", Text: "session-B-only"}}
	other := admitted(t, b, "alice", "session-b", otherInput)
	bJob := nativeDecide(t, b, m, c, other, inference.Item{Type: "final", Text: "B-only-answer"})
	if len(bJob.Context.Messages) != 1 || bJob.Context.Messages[0].Text != "session-B-only" {
		t.Fatal("session A crossed into B context")
	}
	canonical := inference.Messages(m.states["worker-a"].Conversations[v.ConversationID], 3)
	next := requestInput("tool-result")
	next.Tools = []inference.Tool{}
	next.PreviousResponseID = v.ResponseID
	next.Messages = append(canonical, inference.Item{Type: "tool_result", CallID: tool.CallID, Output: "exact\r\nvalue\n"})
	w := admitted(t, b, "alice", "", next)
	if w.ConversationID != v.ConversationID || w.SessionID != "session-a" {
		t.Fatal("owned response did not preserve identity")
	}
	nextJob := nativeDecide(t, b, m, c, w, inference.Item{Type: "final", Text: "exact\r\nvalue\n"})
	if len(nextJob.Context.Messages) != 4 || len(nextJob.Context.Tools) != 0 || nextJob.Context.Kind != "full" {
		t.Fatal("current tool snapshot or full history incorrect")
	}
	if number, ok := nextJob.Context.Messages[2].Arguments["number"].(json.Number); !ok || number.String() != "9007199254740993" {
		t.Fatal("canonical decision argument rounded")
	}
	if strings.Contains(fmt.Sprint(nextJob.Context.Messages), "session-B-only") {
		t.Fatal("session B crossed into A continuation")
	}
	old, err := b.Job(ctx, logger, "worker-a", job.ID)
	if err != nil {
		t.Fatal(err)
	}
	var original inference.Job
	if inference.Decode(old, &original) != nil || len(original.Context.Messages) != 2 || len(original.Context.Tools) != 1 {
		t.Fatal("old delivery snapshot changed")
	}
	view, err := b.ReadRequest(ctx, logger, "alice", w.ID, "session-a")
	if err != nil || view.Output.Text != "exact\r\nvalue\n" {
		t.Fatal("final changed", err)
	}
	last := requestInput("next-question")
	last.Messages = append(inference.Messages(m.states["worker-a"].Conversations[v.ConversationID], 5), inference.Item{Type: "message", Role: "user", Text: "Next turn"})
	third := admitted(t, b, "alice", "session-a", last)
	if third.ConversationID != v.ConversationID || third.ID == v.ID || len(m.states["worker-a"].Conversations[v.ConversationID].Items) != 6 {
		t.Fatal("completed-turn continuation duplicated history")
	}
	_, err = b.CancelRequest(ctx, logger, "alice", third.ID, "session-a", inference.Cancel{Version: 1, SubmissionID: "cancel"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(logs.String(), "submission_replay") {
		t.Fatal("replay diagnosis missing")
	}
	if len(m.timeline[v.ConversationID]) < 8 {
		t.Fatal("durable timeline missing")
	}
	for _, item := range m.states["worker-a"].Conversations[other.ConversationID].Items {
		if item.Item.CallID != "" || strings.Contains(item.Item.Text, "client fixture") {
			t.Fatal("interleaved timeline crossed tool linkage")
		}
	}
}

func TestNativeOwnershipIdentityAndBoundaryPersistence(t *testing.T) {
	b, m, logger, logs := inferenceFixture()
	ctx := context.Background()
	c := connectInference(t, b, m, logger, "worker-a")
	input := requestInput("owned")
	v := admitted(t, b, "alice", "shared-name", input)
	other := admitted(t, b, "bob", "shared-name", requestInput("other"))
	if other.ConversationID == v.ConversationID {
		t.Fatal("client namespaces joined")
	}
	for _, id := range []string{v.ID, "missing"} {
		_, err := b.ReadRequest(ctx, logger, "bob", id, "")
		requireInferenceReason(t, err, "history_owner_denied")
	}
	foreign := requestInput("foreign")
	foreign.PreviousResponseID = v.ResponseID
	_, err := b.SubmitRequest(ctx, logger, "bob", "", foreign)
	requireInferenceReason(t, err, "history_owner_denied")
	_, err = b.SubmitRequest(ctx, logger, "alice", "other-session", foreign)
	requireInferenceReason(t, err, "response_not_completed")
	job := nativeDecide(t, b, m, c, v, inference.Item{Type: "final", Text: "answer"})
	_, err = b.SubmitRequest(ctx, logger, "alice", "other-session", foreign)
	requireInferenceReason(t, err, "session_reference_conflict")
	changed := requestInput("pin")
	changed.WorkerID = "worker-b"
	_, err = b.SubmitRequest(ctx, logger, "alice", "shared-name", changed)
	requireInferenceReason(t, err, "session_worker_conflict")
	_, err = b.CancelRequest(ctx, logger, "alice", v.ID, "shared-name", inference.Cancel{Version: 1, SubmissionID: "done"})
	requireInferenceReason(t, err, "request_already_completed")
	if err = b.DeliveryFinished(ctx, logger, "worker-a", job.ID, 100, 50, "client disconnected"); err != nil {
		t.Fatal(err)
	}
	if m.states["worker-a"].Requests[v.ID].ContextDeliveryWritten != nil {
		t.Fatal("partial context marked complete")
	}
	if err = b.DeliveryFinished(ctx, logger, "worker-a", job.ID, 100, 100, ""); err != nil {
		t.Fatal(err)
	}
	if err = b.DeliveryFinished(ctx, logger, "worker-a", job.ID, 100, 100, ""); err != nil {
		t.Fatal(err)
	}
	if err = b.OutputBoundary(ctx, logger, "alice", v.ID, false, 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	if err = b.OutputBoundary(ctx, logger, "alice", v.ID, false, 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	if err = b.OutputBoundary(ctx, logger, "alice", v.ID, true, 100, 50, "socket closed"); err != nil {
		t.Fatal(err)
	}
	if m.states["worker-a"].Requests[v.ID].OutputCompletedAt != nil {
		t.Fatal("partial output marked complete")
	}
	if err = b.OutputBoundary(ctx, logger, "alice", v.ID, true, 100, 100, ""); err != nil {
		t.Fatal(err)
	}
	r := m.states["worker-a"].Requests[v.ID]
	if r.OutputStartedAt == nil || r.OutputCompletedAt == nil || r.ContextDeliveryStarted == nil || r.ContextDeliveryWritten == nil {
		t.Fatal("required boundaries missing")
	}
	if !strings.Contains(logs.String(), "history.owner_denied") || !strings.Contains(logs.String(), "request.output_interrupted") {
		t.Fatal("causal evidence missing")
	}
	a := admitted(t, b, "alice", "", requestInput("independent-a"))
	d := admitted(t, b, "alice", "", requestInput("independent-b"))
	if a.ConversationID == d.ConversationID || a.SessionID == d.SessionID {
		t.Fatal("uncorrelated histories joined")
	}
	_, err = b.CancelRequest(ctx, logger, "alice", a.ID, "wrong-session", inference.Cancel{Version: 1, SubmissionID: "wrong-cancel"})
	requireInferenceReason(t, err, "session_reference_conflict")
	current, readErr := b.ReadRequest(ctx, logger, "alice", a.ID, "")
	if readErr != nil || current.State != "queued" {
		t.Fatal("wrong-header cancellation mutated request")
	}
	cancelInput := inference.Cancel{Version: 1, SubmissionID: "same-cancel"}
	if _, err = b.CancelRequest(ctx, logger, "alice", a.ID, "", cancelInput); err != nil {
		t.Fatal(err)
	}
	_, err = b.CancelRequest(ctx, logger, "alice", a.ID, a.SessionID, cancelInput)
	requireInferenceReason(t, err, "submission_conflict")
}

func TestNativeConflictsAtomicFailureAndConcurrency(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	ctx := context.Background()
	c := connectInference(t, b, m, logger, "worker-a")
	v := admitted(t, b, "alice", "race", requestInput("initial"))
	nativeDecide(t, b, m, c, v, inference.Item{Type: "final", Text: "answer\n"})
	base := inference.Messages(m.states["worker-a"].Conversations[v.ConversationID], 3)
	for _, kind := range []string{"prefix", "short", "wrong-result", "duplicate-call"} {
		input := requestInput(kind)
		input.Messages = append(append([]inference.Item{}, base...), inference.Item{Type: "message", Role: "user", Text: "next"})
		switch kind {
		case "prefix":
			input.Messages[0].Text = "changed"
		case "short":
			input.Messages = input.Messages[:1]
		case "wrong-result":
			input.Messages[3] = inference.Item{Type: "tool_result", CallID: "unknown", Output: "unlinked"}
		case "duplicate-call":
			input.Messages = append(input.Messages, inference.Item{Type: "tool_call", CallID: "unresolved", Name: "read_file", Arguments: map[string]any{"path": "x"}})
		}
		_, err := b.SubmitRequest(ctx, logger, "alice", "race", input)
		if err == nil {
			t.Fatal("accepted", kind)
		}
		if len(m.states["worker-a"].Conversations[v.ConversationID].Items) != 3 {
			t.Fatal("rejection partially appended")
		}
	}
	input := requestInput("next")
	input.Messages = append(base, inference.Item{Type: "message", Role: "user", Text: "next"})
	m.persistFail = errors.New("disk full")
	_, err := b.SubmitRequest(ctx, logger, "alice", "race", input)
	if err == nil || len(m.states["worker-a"].Conversations[v.ConversationID].Items) != 3 {
		t.Fatal("storage failure partially committed")
	}
	m.persistFail = nil
	var wait sync.WaitGroup
	results := make(chan inference.RequestView, 8)
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			r, err := b.SubmitRequest(ctx, testHistoryLogger(), "alice", "race", input)
			if err != nil {
				failures <- err
			} else {
				results <- r
			}
		}()
	}
	wait.Wait()
	close(results)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	id := ""
	for r := range results {
		if id != "" && id != r.ID {
			t.Fatal("concurrent retry made duplicate requests")
		}
		id = r.ID
	}
	if len(m.states["worker-a"].Jobs) != 2 || len(m.states["worker-a"].Conversations[v.ConversationID].Items) != 4 {
		t.Fatal("race duplicated work/history")
	}
}

func TestNativeValidationAndDependencyErrors(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	ctx := context.Background()
	for _, kind := range []string{"client", "version", "session", "reference", "messages", "tools", "context"} {
		input := requestInput(kind)
		client, session := "alice", "valid"
		switch kind {
		case "client":
			client = ""
		case "version":
			input.Version = 2
		case "session":
			session = "bad session"
		case "reference":
			input.PreviousResponseID = "bad ref"
		case "messages":
			input.Messages = nil
		case "tools":
			input.Tools[0].Parameters = nil
		case "context":
			input.Messages[0].Text = strings.Repeat("x", inference.MaxContextBytes)
		}
		if _, err := b.SubmitRequest(ctx, logger, client, session, input); err == nil {
			t.Fatal("accepted", kind)
		}
	}
	offline, err := b.SubmitRequest(ctx, logger, "alice", "offline", requestInput("offline"))
	if err != nil || offline.State != "queued" || offline.WorkerID != "" {
		t.Fatal("an offline targeted worker must not prevent queue admission", err)
	}
	connectInference(t, b, m, logger, "worker-a")
	m.states["worker-a"].Revoked = true
	_, err = b.SubmitRequest(ctx, logger, "alice", "revoked", requestInput("revoked"))
	requireInferenceReason(t, err, "worker_revoked")
	m.states["worker-a"].Revoked = false
	for n := 0; n < 6; n++ {
		b.random = bytes.NewReader(make([]byte, n*16))
		_, err = b.SubmitRequest(ctx, logger, "alice", "", requestInput("random"))
		if err == nil {
			t.Fatal("random failure ignored", n)
		}
	}
	b.random = rand.Reader
	v := admitted(t, b, "alice", "deadline", requestInput("deadline"))
	admitted(t, b, "alice", "capacity", requestInput("capacity"))
	queued := admitted(t, b, "alice", "additional", requestInput("additional"))
	if queued.WorkerID != "" {
		t.Fatal("busy worker accepted another assignment")
	}
	if err = b.OutputBoundary(ctx, logger, "alice", v.ID, false, 0, 0, ""); err == nil {
		t.Fatal("unavailable output exposed")
	}
	_, err = b.CancelRequest(ctx, logger, "alice", v.ID, "deadline", inference.Cancel{Version: 2, SubmissionID: "bad"})
	requireInferenceReason(t, err, "unsupported_protocol_version")
	m.now = m.now.Add(301 * time.Second)
	read, err := b.ReadRequest(ctx, logger, "alice", v.ID, "deadline")
	if err != nil || read.State != "interrupted" {
		t.Fatal("deadline not reflected", err)
	}
}

func TestNativeDecisionIdentifierFailureRemainsRetryable(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	c := connectInference(t, b, m, logger, "worker-a")
	v := admitted(t, b, "alice", "session", requestInput("first"))
	job := nativeJob(t, b, m, c, v)
	body := submission(job, inference.Connection{}, "decision", inference.Item{Type: "final", Text: "result"})
	b.random = bytes.NewReader(nil)
	if _, err := b.Decide(context.Background(), logger, "worker-a", job.ID, body); err == nil {
		t.Fatal("failed item identity accepted")
	}
	if m.states["worker-a"].Requests[v.ID].Output != nil || len(m.states["worker-a"].Conversations[v.ConversationID].Items) != 2 {
		t.Fatal("failed decision partially appended")
	}
	b.random = rand.Reader
	if _, err := b.Decide(context.Background(), logger, "worker-a", job.ID, body); err != nil {
		t.Fatal(err)
	}
	if len(m.states["worker-a"].Conversations[v.ConversationID].Items) != 3 {
		t.Fatal("corrected decision duplicated output")
	}
}

func TestReconciliationRejectsUnsupportedAndConflictingItems(t *testing.T) {
	for _, item := range []inference.Item{
		{Type: "message", Role: "unknown"}, {Type: "message", Role: "user", CallID: "extraneous"},
		{Type: "media"}, {Type: "tool_call", CallID: "call", Name: "unknown", Arguments: map[string]any{}},
		{Type: "tool_result", CallID: "absent", Output: "unlinked"},
	} {
		input := requestInput("invalid")
		input.Messages = []inference.Item{item}
		if err := reconcileHistory(nil, input); err == nil {
			t.Fatal("unsupported or unlinked item accepted")
		}
	}
	c := &inference.Conversation{ID: "conversation", ItemCount: 1, PendingCallID: "pending", Items: []inference.HistoryItem{{Sequence: 0, Item: inference.Item{Type: "tool_call", CallID: "pending", Name: "read_file", Arguments: map[string]any{"path": "old"}}}}}
	input := requestInput("continuation")
	input.Tools = []inference.Tool{}
	input.Messages = []inference.Item{c.Items[0].Item, {Type: "tool_result", CallID: "pending", Output: "exact\n"}}
	if err := reconcileHistory(c, input); err != nil {
		t.Fatal("old schema incorrectly revalidated", err)
	}
	input.Messages[1] = inference.Item{Type: "message", Role: "user", Text: "skip tool"}
	if err := reconcileHistory(c, input); err == nil {
		t.Fatal("tool result skipped")
	}
	input.Messages[1] = inference.Item{Type: "tool_call", CallID: "pending", Name: "read_file", Arguments: map[string]any{"path": "new"}}
	if err := reconcileHistory(c, input); err == nil {
		t.Fatal("call repeated")
	}
	input.Messages[1] = inference.Item{Type: "tool_result", CallID: "pending", Output: "x", Role: "user"}
	if err := reconcileHistory(c, input); err == nil {
		t.Fatal("invalid result fields accepted")
	}
}
