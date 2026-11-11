package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

type inferenceMemory struct {
	mu          sync.Mutex
	now         time.Time
	states      map[string]*inference.State
	receipts    map[string]*inference.Receipt
	fail        error
	persistFail error
	timeline    map[string][]inference.TimelineEvent
}

func (m *inferenceMemory) InferenceWorkers(context.Context) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := []string{}
	for id := range m.states {
		ids = append(ids, id)
	}
	return ids, m.fail
}

func (m *inferenceMemory) WithinInference(_ context.Context, ref inference.Ref, fn func(*inference.State) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail != nil {
		return m.fail
	}
	if err := memoryHistoryScope(m.states, &ref); err != nil {
		return err
	}
	wid := ref.WorkerID
	if ref.ExperimentID != "" || ref.JobID != "" {
		wid = ""
		for id, s := range m.states {
			if s.Experiments[ref.ExperimentID] != nil || s.Jobs[ref.JobID] != nil {
				wid = id
			}
		}
	}
	if ref.WorkerAuth != "" && wid != "" && ref.WorkerAuth != wid {
		return inference.Reject("worker_scope_denied", 404)
	}
	old := m.states[wid]
	if old == nil {
		return inference.Reject("inference_not_found", 404)
	}
	if old.Revoked && ref.WorkerAuth != "" {
		return inference.Reject("worker_revoked", 401)
	}
	data, err := json.Marshal(old)
	if err != nil {
		return err
	}
	var s inference.State
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err = d.Decode(&s); err != nil {
		return err
	}
	s.Now = m.now
	s.HistoryConversationID = ref.ConversationID
	s.PendingTools = 0
	for _, c := range s.Conversations {
		c.Events = nil
		if c.PendingCallID != "" {
			s.PendingTools++
		}
	}
	for id, r := range s.Requests {
		if e := s.Experiments[id]; e != nil {
			e.Messages = inference.Messages(s.Conversations[r.ConversationID], r.CanonicalEnd)
		}
	}
	s.Receipt = m.receipts[ref.Principal+":"+ref.SubmissionID]
	s.ActiveCount = 0
	for _, state := range m.states {
		for _, e := range state.Experiments {
			if !e.Terminal() {
				s.ActiveCount++
			}
		}
	}
	if err = fn(&s); err != nil {
		return err
	}
	if m.persistFail != nil {
		return m.persistFail
	}
	if s.Receipt != nil {
		m.receipts[ref.Principal+":"+ref.SubmissionID] = s.Receipt
	}
	s.Receipt = nil
	if m.timeline == nil {
		m.timeline = map[string][]inference.TimelineEvent{}
	}
	for _, c := range s.Conversations {
		m.timeline[c.ID] = append(m.timeline[c.ID], c.Events...)
		c.Events = nil
	}
	m.states[wid] = &s
	return nil
}

func inferenceFixture() (*Broker, *inferenceMemory, *slog.Logger, *bytes.Buffer) {
	m := &inferenceMemory{now: time.Date(2026, 11, 9, 14, 0, 0, 0, time.UTC), states: map[string]*inference.State{}, receipts: map[string]*inference.Receipt{}}
	for _, id := range []string{"worker-a", "worker-b"} {
		m.states[id] = &inference.State{WorkerID: id, Experiments: map[string]*inference.Experiment{}, Jobs: map[string]*inference.Job{}}
	}
	var out bytes.Buffer
	return NewBroker(m, rand.Reader, func() time.Time { return m.now }, func(ctx context.Context, _ time.Duration) error { return ctx.Err() }, 2), m, slog.New(slog.NewJSONHandler(&out, &slog.HandlerOptions{Level: slog.LevelDebug})), &out
}

func decodeResult[T any](t *testing.T, data json.RawMessage, err error) T {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	var out T
	if err = json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func connectInference(t *testing.T, b *Broker, m *inferenceMemory, log *slog.Logger, wid string) inference.Connection {
	t.Helper()
	data, err := b.Open(context.Background(), log, wid)
	c := decodeResult[inference.Connection](t, data, err)
	data, err = b.Heartbeat(context.Background(), log, wid, inference.Heartbeat{Version: 1, ConnectionID: c.ID, Generation: c.Generation, ChallengeID: c.Challenges[0].ID})
	decodeResult[inference.Projection](t, data, err)
	return c
}

func createInference(t *testing.T, b *Broker, log *slog.Logger, wid, id string, timeout int) inference.Experiment {
	t.Helper()
	data, err := b.Create(context.Background(), log, inference.Create{Version: 1, SubmissionID: id, WorkerID: wid, TimeoutSeconds: timeout, Messages: []inference.Item{{Type: "message", Role: "system", Text: "Keep exact client results"}, {Type: "message", Role: "user", Text: "Read a client-only fixture"}}, Tools: []inference.Tool{{Name: "read_file", Parameters: map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}, "required": []any{"path"}, "additionalProperties": false}}}})
	return decodeResult[inference.Experiment](t, data, err)
}

func claimInference(t *testing.T, b *Broker, log *slog.Logger, c inference.Connection, e inference.Experiment, id string) inference.Job {
	t.Helper()
	data, err := b.Claim(context.Background(), log, e.WorkerID, e.CurrentJobID, inference.Claim{Version: 1, SubmissionID: id, ConnectionID: c.ID, ConnectionGeneration: c.Generation})
	return decodeResult[inference.Job](t, data, err)
}

func submission(j inference.Job, c inference.Connection, id string, d inference.Item) inference.Submit {
	return inference.Submit{Claim: inference.Claim{Version: 1, SubmissionID: id, ConnectionID: c.ID, ConnectionGeneration: c.Generation}, ConversationID: j.ConversationID, Generation: j.Generation, LeaseID: j.LeaseID, ContextReceiptID: j.Context.ReceiptID, Decision: d}
}

func heartbeatInference(t *testing.T, b *Broker, log *slog.Logger, c inference.Connection, wid string, ack *inference.Assignment) inference.Projection {
	t.Helper()
	events, err := b.Poll(context.Background(), log, wid, c.ID, c.Generation)
	if err != nil {
		t.Fatal(err)
	}
	challenge := events[0].Data.(map[string]any)["challenge_id"].(string)
	data, err := b.Heartbeat(context.Background(), log, wid, inference.Heartbeat{Version: 1, ConnectionID: c.ID, Generation: c.Generation, ChallengeID: challenge, IdleAck: ack})
	return decodeResult[inference.Projection](t, data, err)
}

func requireInferenceReason(t *testing.T, err error, reason string) {
	t.Helper()
	var r *inference.Rejection
	if !errors.As(err, &r) || r.Reason != reason {
		t.Fatalf("expected %s; got %v", reason, err)
	}
}

func TestInterleavedToolLoopDeltaAndReceipts(t *testing.T) {
	b, m, log, out := inferenceFixture()
	ctx := context.Background()
	c := connectInference(t, b, m, log, "worker-a")
	a := createInference(t, b, log, "worker-a", "create-a", 0)
	other := createInference(t, b, log, "worker-a", "create-b", 0)
	if a.ConversationID == other.ConversationID {
		t.Fatal("logical sessions merged")
	}
	j := claimInference(t, b, log, c, a, "claim-a")
	_, err := b.Claim(ctx, log, "worker-a", other.CurrentJobID, inference.Claim{Version: 1, SubmissionID: "busy", ConnectionID: c.ID, ConnectionGeneration: c.Generation})
	requireInferenceReason(t, err, "worker_busy")
	intent := inference.Item{Type: "tool_call", CallID: "client-call", Name: "read_file", Arguments: map[string]any{"path": "client-only"}}
	d := submission(j, c, "decision-a", intent)
	data, err := b.Decide(ctx, log, "worker-a", j.ID, d)
	waiting := decodeResult[inference.Experiment](t, data, err)
	if waiting.State != "waiting_for_tool" || len(waiting.Messages) != 3 {
		t.Fatal("tool intent not retained once")
	}
	p, err := b.Projection(ctx, log, "worker-a", true)
	if err != nil || p.WorkStatus != "idle" || p.WaitingForTool != 1 {
		t.Fatal("tool wait confused with active inference")
	}
	second := claimInference(t, b, log, c, other, "claim-b")
	data, err = b.Decide(ctx, log, "worker-a", second.ID, submission(second, c, "decision-b", inference.Item{Type: "final", Text: "session B"}))
	decodeResult[inference.Experiment](t, data, err)
	result := inference.ToolResult{Version: 1, SubmissionID: "tool-a", CallID: intent.CallID, Output: "client fixture exact 42\n", ContextProbe: &inference.Probe{Kind: "delta", BaseReceiptID: j.ID}}
	data, err = b.ToolResult(ctx, log, a.ID, result)
	continued := decodeResult[inference.Experiment](t, data, err)
	data, err = b.Job(ctx, log, "worker-a", continued.CurrentJobID)
	next := decodeResult[inference.Job](t, data, err)
	if next.Context.Kind != "delta" || next.Context.BasePrefix != 2 || len(next.Context.Messages) != 2 || next.Context.Messages[1].Output != result.Output || next.Context.BaseSHA256 != j.Context.CanonicalSHA256 {
		t.Fatal("delta lost exact base or tool context")
	}
	next = claimInference(t, b, log, c, continued, "claim-next")
	final := submission(next, c, "final-a", inference.Item{Type: "final", Text: next.Context.Messages[1].Output})
	data, err = b.Decide(ctx, log, "worker-a", next.ID, final)
	done := decodeResult[inference.Experiment](t, data, err)
	if done.State != "completed" || done.FinalText != result.Output || len(done.Messages) != 5 {
		t.Fatal("final result/history changed")
	}
	m.now = m.now.Add(time.Hour)
	for _, repeat := range []func() (json.RawMessage, error){func() (json.RawMessage, error) { return b.Decide(ctx, log, "worker-a", next.ID, final) }, func() (json.RawMessage, error) { return b.ToolResult(ctx, log, a.ID, result) }} {
		data, err = repeat()
		decodeResult[inference.Experiment](t, data, err)
	}
	data, err = b.Read(ctx, log, a.ID)
	read := decodeResult[inference.Experiment](t, data, err)
	if len(read.Messages) != 5 {
		t.Fatal("accepted retries duplicated canonical history")
	}
	final.Decision.Text = "different"
	_, err = b.Decide(ctx, log, "worker-a", next.ID, final)
	requireInferenceReason(t, err, "submission_conflict")
	_, err = b.Cancel(ctx, log, a.ID, inference.Cancel{Version: 1, SubmissionID: "cancel-done"})
	requireInferenceReason(t, err, "experiment_already_completed")
	if !bytes.Contains(out.Bytes(), []byte("inference.context")) || !bytes.Contains(out.Bytes(), []byte("decision.accepted")) {
		t.Fatal("context or acceptance diagnosis absent")
	}
}

func TestCancellationBusyHoldAndConnectionFencing(t *testing.T) {
	b, m, log, _ := inferenceFixture()
	ctx := context.Background()
	c := connectInference(t, b, m, log, "worker-a")
	a := createInference(t, b, log, "worker-a", "a", 0)
	j := claimInference(t, b, log, c, a, "claim")
	data, err := b.Cancel(ctx, log, a.ID, inference.Cancel{Version: 1, SubmissionID: "cancel"})
	cancelled := decodeResult[inference.Experiment](t, data, err)
	if cancelled.State != "cancelled" || cancelled.RemoteOutcome != "unknown" {
		t.Fatal("cancellation hid remote uncertainty")
	}
	other := createInference(t, b, log, "worker-a", "b", 0)
	m.now = m.now.Add(10 * time.Second)
	p := heartbeatInference(t, b, log, c, "worker-a", nil)
	if p.WorkStatus != "busy" {
		t.Fatal("health reply released cancelled inference")
	}
	_, err = b.Claim(ctx, log, "worker-a", other.CurrentJobID, inference.Claim{Version: 1, SubmissionID: "blocked", ConnectionID: c.ID, ConnectionGeneration: c.Generation})
	requireInferenceReason(t, err, "worker_busy")
	_, err = b.Decide(ctx, log, "worker-a", j.ID, submission(j, c, "late", inference.Item{Type: "final", Text: "late"}))
	requireInferenceReason(t, err, "stale_assignment")
	m.now = m.now.Add(10 * time.Second)
	p = heartbeatInference(t, b, log, c, "worker-a", &inference.Assignment{JobID: j.ID, Generation: j.Generation, LeaseID: j.LeaseID})
	if p.WorkStatus != "idle" {
		t.Fatal("matching idle acknowledgement did not release hold")
	}
	claimInference(t, b, log, c, other, "claim-b")
	if err = b.Disconnect(ctx, log, "worker-a", c.ID, c.Generation); err != nil {
		t.Fatal(err)
	}
	data, err = b.Read(ctx, log, other.ID)
	interrupted := decodeResult[inference.Experiment](t, data, err)
	if interrupted.State != "interrupted" {
		t.Fatal("disconnection did not fence claimed work")
	}
	c2 := connectInference(t, b, m, log, "worker-a")
	if c2.Generation <= c.Generation {
		t.Fatal("connection generation reused")
	}
	_, err = b.Heartbeat(ctx, log, "worker-a", inference.Heartbeat{Version: 1, ConnectionID: c.ID, Generation: c.Generation, ChallengeID: c.Challenges[0].ID})
	requireInferenceReason(t, err, "stale_connection")
	if err = b.Disconnect(ctx, log, "worker-a", c.ID, c.Generation); err != nil {
		t.Fatal(err)
	}
	if p, err = b.Projection(ctx, log, "worker-a", true); err != nil || p.ConnectionStatus != "online" || p.WorkStatus != "busy" {
		t.Fatal("old stream cleanup affected replacement connection or erased busy hold")
	}
}

func TestQueuedContextDeliveryAcrossReconnect(t *testing.T) {
	for _, kind := range []string{"delta", "full"} {
		t.Run(kind, func(t *testing.T) {
			b, m, log, _ := inferenceFixture()
			ctx := context.Background()
			c := connectInference(t, b, m, log, "worker-a")
			e := createInference(t, b, log, "worker-a", "create", 0)
			j := claimInference(t, b, log, c, e, "initial-claim")
			_, err := b.Decide(ctx, log, "worker-a", j.ID, submission(j, c, "tool-call", inference.Item{Type: "tool_call", CallID: "call", Name: "read_file", Arguments: map[string]any{"path": "client-only"}}))
			if err != nil {
				t.Fatal(err)
			}
			probe := &inference.Probe{Kind: kind}
			if kind == "delta" {
				probe.BaseReceiptID = j.ID
			}
			data, err := b.ToolResult(ctx, log, e.ID, inference.ToolResult{Version: 1, SubmissionID: "tool-result", CallID: "call", Output: "exact client result", ContextProbe: probe})
			e = decodeResult[inference.Experiment](t, data, err)
			data, err = b.Job(ctx, log, "worker-a", e.CurrentJobID)
			queued := decodeResult[inference.Job](t, data, err)
			if err = b.Disconnect(ctx, log, "worker-a", c.ID, c.Generation); err != nil {
				t.Fatal(err)
			}
			replacement := connectInference(t, b, m, log, "worker-a")
			data, err = b.Claim(ctx, log, "worker-a", queued.ID, inference.Claim{Version: 1, SubmissionID: "reconnected-claim", ConnectionID: replacement.ID, ConnectionGeneration: replacement.Generation})
			if kind == "delta" {
				requireInferenceReason(t, err, "context_base_connection_changed")
				stored := m.states["worker-a"].Jobs[queued.ID]
				before, _ := json.Marshal(queued)
				after, _ := json.Marshal(stored)
				if !bytes.Equal(before, after) || stored.Held || len(m.states["worker-a"].Experiments[e.ID].Messages) != 4 || m.receipts["worker:worker-a:reconnected-claim"] != nil {
					t.Fatal("rejected delta claim mutated delivery, history, slot or receipts")
				}
			} else {
				claimed := decodeResult[inference.Job](t, data, err)
				if claimed.Context.Kind != "full" || len(claimed.Context.Messages) != 4 || claimed.ConnectionID != replacement.ID || claimed.Context.Messages[3].Output != "exact client result" {
					t.Fatal("full context did not remain claimable after reconnect")
				}
			}
		})
	}
}
