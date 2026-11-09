package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/postgres"
)

func TestPersistenceFailureRetainsResolvedExperimentInExport(t *testing.T) {
	for _, operation := range []string{"claim", "decision"} {
		t.Run(operation, func(t *testing.T) {
			b, m, log, _ := inferenceFixture()
			c := connectInference(t, b, m, log, "worker-a")
			e := createInference(t, b, log, "worker-a", "storage-correlation", 0)
			var job inference.Job
			if operation == "decision" {
				job = claimInference(t, b, log, c, e, "claim-before-failure")
			}
			store, err := diagnostics.Open(diagnostics.OSFiles{}, t.TempDir(), "storage-test", func() time.Time { return m.now }, 7*24*time.Hour, 128*1024*1024)
			if err != nil {
				t.Fatal(err)
			}
			var stdout bytes.Buffer
			log = diagnostics.NewLogger(&stdout, store, slog.LevelInfo, diagnostics.NewRedactor(nil), func() time.Time { return m.now }, func(error) { t.Fatal("capture failed") }).With("request_id", "failed-persistence")
			m.persistFail = &postgres.Failure{Reason: "postgres_error", SQLState: "23514", Outcome: "rolled_back"}
			if operation == "claim" {
				_, err = b.Claim(context.Background(), log, "worker-a", e.CurrentJobID, inference.Claim{Version: 1, SubmissionID: "failed-claim", ConnectionID: c.ID, ConnectionGeneration: c.Generation})
			} else {
				_, err = b.Decide(context.Background(), log, "worker-a", job.ID, submission(job, c, "failed-decision", inference.Item{Type: "final", Text: "uncommitted"}))
			}
			if !errors.Is(err, m.persistFail) {
				t.Fatal("persistence failure hidden")
			}
			snapshot, err := store.Snapshot(diagnostics.Filter{OperationID: e.ID})
			if err != nil || !snapshot.Metadata.Complete || snapshot.Metadata.Captures != 3 {
				t.Fatal("experiment-filtered export omitted failure evidence")
			}
			seen := map[string]bool{}
			for _, capture := range snapshot.Records {
				var payload bytes.Buffer
				for _, line := range bytes.Split(bytes.TrimSpace(capture), []byte("\n")) {
					var record diagnostics.Record
					if json.Unmarshal(line, &record) != nil || record.OperationID != e.ID {
						t.Fatal("capture lost experiment indexing")
					}
					decoded, err := base64.StdEncoding.DecodeString(record.Data)
					if err != nil {
						t.Fatal(err)
					}
					payload.Write(decoded)
				}
				var event map[string]any
				if json.Unmarshal(payload.Bytes(), &event) != nil || event["operation_id"] != e.ID || event["conversation_id"] != e.ConversationID || event["job_id"] != e.CurrentJobID {
					t.Fatal("failure lost resolved operation context")
				}
				name := event["msg"].(string)
				seen[name] = true
				if name != "inference.exchange" && (event["cause"] != "postgres_error" || event["sqlstate"] != "23514" || event["transaction_outcome"] != "rolled_back" || event["attempt"] != float64(1)) {
					t.Fatal("storage cause or transaction evidence missing")
				}
				if name == "inference.storage_exchange" && (event["level"] != "DEBUG" || event["detail"] == nil) || name == "inference.operation_failed" && event["level"] != "ERROR" {
					t.Fatal("failure diagnostic level/detail incorrect")
				}
			}
			if !seen["inference.storage_exchange"] || !seen["inference.operation_failed"] || bytes.Contains(stdout.Bytes(), []byte("inference.storage_exchange")) || m.states["worker-a"].Experiments[e.ID].State != "queued" && operation == "claim" || m.states["worker-a"].Experiments[e.ID].State == "completed" {
				t.Fatal("failure diagnosis or rollback violated")
			}
		})
	}
}

func TestHealthDeadlinesRevocationAndFailures(t *testing.T) {
	ctx := context.Background()
	for _, kind := range []string{"deadline", "health", "lease", "revoke"} {
		t.Run(kind, func(t *testing.T) {
			b, m, log, out := inferenceFixture()
			c := connectInference(t, b, m, log, "worker-a")
			e := createInference(t, b, log, "worker-a", "exp", 1)
			j := claimInference(t, b, log, c, e, "claim")
			switch kind {
			case "deadline":
				m.now = m.now.Add(2 * time.Second)
			case "health":
				m.states["worker-a"].Experiments[e.ID].DeadlineAt = m.now.Add(time.Hour)
				m.now = m.now.Add(inference.HealthWindow)
			case "lease":
				m.states["worker-a"].Jobs[j.ID].LeaseExpiresAt = nil
			case "revoke":
				m.states["worker-a"].Revoked = true
			}
			if err := b.Sweep(ctx, log); err != nil {
				t.Fatal(err)
			}
			data, err := b.Read(ctx, log, e.ID)
			got := decodeResult[inference.Experiment](t, data, err)
			if got.State != "interrupted" || !m.states["worker-a"].Jobs[j.ID].Held {
				t.Fatal("failed work replayed or lost hold")
			}
			if kind == "revoke" {
				_, err = b.Job(ctx, log, "worker-a", j.ID)
				requireInferenceReason(t, err, "worker_revoked")
			}
			if !bytes.Contains(out.Bytes(), []byte(`"level":"ERROR"`)) {
				t.Fatal("failed required inference lacked ERROR")
			}
		})
	}
	b, m, log, _ := inferenceFixture()
	c := connectInference(t, b, m, log, "worker-a")
	_, err := b.Open(ctx, log, "worker-a")
	requireInferenceReason(t, err, "subscriber_already_connected")
	h := inference.Heartbeat{Version: 1, ConnectionID: c.ID, Generation: c.Generation, ChallengeID: c.Challenges[0].ID}
	if _, err = b.Heartbeat(ctx, log, "worker-a", h); err != nil {
		t.Fatal(err)
	}
	h.IdleAck = &inference.Assignment{JobID: "wrong"}
	_, err = b.Heartbeat(ctx, log, "worker-a", h)
	requireInferenceReason(t, err, "challenge_reply_conflict")
	h.Version = 2
	_, err = b.Heartbeat(ctx, log, "worker-a", h)
	requireInferenceReason(t, err, "unsupported_protocol_version")
	h.Version = 1
	h.ChallengeID = "missing"
	_, err = b.Heartbeat(ctx, log, "worker-a", h)
	requireInferenceReason(t, err, "unknown_or_expired_challenge")
	m.now = m.now.Add(10 * time.Second)
	events, err := b.Poll(ctx, log, "worker-a", c.ID, c.Generation)
	if err != nil {
		t.Fatal(err)
	}
	h.ChallengeID = events[0].ID
	_, err = b.Heartbeat(ctx, log, "worker-a", h)
	requireInferenceReason(t, err, "idle_ack_mismatch")
	m.fail = errors.New("repository unavailable")
	if b.Sweep(ctx, log) == nil {
		t.Fatal("sweep dependency failure hidden")
	}
	if _, err = b.Read(ctx, log, "missing"); err == nil {
		t.Fatal("read dependency failure hidden")
	}
	m.fail = nil
	if _, err = b.Read(ctx, log, "missing"); err == nil {
		t.Fatal("missing experiment accepted")
	}
	if _, err = b.run(ctx, log, inference.Ref{}, "bad_hash", make(chan int), nil); err == nil {
		t.Fatal("hash failure ignored")
	}
	if _, err = b.run(ctx, log, inference.Ref{WorkerID: "worker-a"}, "bad_output", nil, func(*inference.State, *[]inferenceEvent) (any, error) { return make(chan int), nil }); err == nil {
		t.Fatal("output encoding failure ignored")
	}
	b.Wait = func(context.Context, time.Duration) error { return context.Canceled }
	b.Run(ctx, log)
}

func TestAdmissionInvalidDecisionsAndContextBases(t *testing.T) {
	b, m, log, _ := inferenceFixture()
	ctx := context.Background()
	_, err := b.Create(ctx, log, inference.Create{Version: 1, SubmissionID: "offline", WorkerID: "worker-a", Messages: []inference.Item{{Type: "message", Role: "user", Text: "x"}}, Tools: []inference.Tool{}})
	requireInferenceReason(t, err, "worker_offline")
	c := connectInference(t, b, m, log, "worker-a")
	connectInference(t, b, m, log, "worker-b")
	a := createInference(t, b, log, "worker-a", "a", 0)
	createInference(t, b, log, "worker-b", "b", 0)
	_, err = b.Create(ctx, log, inference.Create{Version: 1, SubmissionID: "full", WorkerID: "worker-a", Messages: []inference.Item{{Type: "message", Role: "user", Text: "x"}}, Tools: []inference.Tool{}})
	requireInferenceReason(t, err, "queue_full")
	j := claimInference(t, b, log, c, a, "claim")
	_, err = b.Job(ctx, log, "worker-b", j.ID)
	requireInferenceReason(t, err, "worker_scope_denied")
	for _, d := range []inference.Item{{Type: "tool_call", CallID: "x", Name: "unknown", Arguments: map[string]any{}}, {Type: "tool_call", CallID: "x", Name: "read_file", Arguments: map[string]any{"path": 12}}} {
		_, err = b.Decide(ctx, log, "worker-a", j.ID, submission(j, c, "invalid", d))
		if err == nil {
			t.Fatal("invalid decision accepted")
		}
	}
	bad := submission(j, c, "bad-generation", inference.Item{Type: "final", Text: "x"})
	bad.Generation++
	_, err = b.Decide(ctx, log, "worker-a", j.ID, bad)
	requireInferenceReason(t, err, "stale_assignment")
	d := submission(j, c, "tool", inference.Item{Type: "tool_call", CallID: "call", Name: "read_file", Arguments: map[string]any{"path": "fixture"}})
	data, err := b.Decide(ctx, log, "worker-a", j.ID, d)
	decodeResult[inference.Experiment](t, data, err)
	_, err = b.ToolResult(ctx, log, a.ID, inference.ToolResult{Version: 1, SubmissionID: "wrong-call", CallID: "foreign"})
	requireInferenceReason(t, err, "tool_result_linkage_conflict")
	for _, probe := range []*inference.Probe{{Kind: "unknown"}, {Kind: "full", BaseReceiptID: j.ID}, {Kind: "delta", BaseReceiptID: "missing"}} {
		_, err = b.ToolResult(ctx, log, a.ID, inference.ToolResult{Version: 1, SubmissionID: "probe", CallID: "call", ContextProbe: probe})
		if err == nil {
			t.Fatal("invalid probe accepted")
		}
	}
	data, err = b.ToolResult(ctx, log, a.ID, inference.ToolResult{Version: 1, SubmissionID: "continue", CallID: "call", Output: "exact", ContextProbe: &inference.Probe{Kind: "full"}})
	e := decodeResult[inference.Experiment](t, data, err)
	next := claimInference(t, b, log, c, e, "claim-next")
	_, err = b.Decide(ctx, log, "worker-a", next.ID, submission(next, c, "duplicate-call", d.Decision))
	requireInferenceReason(t, err, "duplicate_tool_call_id")
	data, err = b.Cancel(ctx, log, e.ID, inference.Cancel{Version: 1, SubmissionID: "cancel"})
	decodeResult[inference.Experiment](t, data, err)
	_, err = b.Claim(ctx, log, "worker-a", j.ID, inference.Claim{Version: 2, SubmissionID: "bad-version"})
	requireInferenceReason(t, err, "unsupported_protocol_version")
	_, err = b.Cancel(ctx, log, e.ID, inference.Cancel{})
	requireInferenceReason(t, err, "unsupported_protocol_version")
	_, err = b.ToolResult(ctx, log, e.ID, inference.ToolResult{})
	requireInferenceReason(t, err, "unsupported_protocol_version")
	_, err = b.Decide(ctx, log, "worker-a", next.ID, inference.Submit{})
	requireInferenceReason(t, err, "unsupported_protocol_version")
}

func TestEntropyExpiryAndStoredPrefixFailure(t *testing.T) {
	b, m, log, _ := inferenceFixture()
	ctx := context.Background()
	b.random = bytes.NewReader(nil)
	if _, err := b.Open(ctx, log, "worker-a"); err == nil {
		t.Fatal("connection entropy failure ignored")
	}
	b, m, log, _ = inferenceFixture()
	c := connectInference(t, b, m, log, "worker-a")
	a := createInference(t, b, log, "worker-a", "a", 0)
	j := claimInference(t, b, log, c, a, "claim")
	d := submission(j, c, "decision", inference.Item{Type: "tool_call", CallID: "call", Name: "read_file", Arguments: map[string]any{"path": "p"}})
	if _, err := b.Decide(ctx, log, "worker-a", j.ID, d); err != nil {
		t.Fatal(err)
	}
	m.states["worker-a"].Jobs[j.ID].Context.CanonicalSHA256 = "wrong"
	_, err := b.ToolResult(ctx, log, a.ID, inference.ToolResult{Version: 1, SubmissionID: "bad-prefix", CallID: "call", ContextProbe: &inference.Probe{Kind: "delta", BaseReceiptID: j.ID}})
	requireInferenceReason(t, err, "context_prefix_conflict")
	b.random = bytes.NewReader(nil)
	m.now = m.now.Add(10 * time.Second)
	if _, err = b.Poll(ctx, log, "worker-a", c.ID, c.Generation); err == nil {
		t.Fatal("challenge entropy failure ignored")
	}
	m.now = m.now.Add(21 * time.Second)
	if err = b.Sweep(ctx, log); err != nil {
		t.Fatal(err)
	}
	p, err := b.Projection(ctx, log, "worker-a", false)
	if err != nil || p.ConnectionStatus != "offline" {
		t.Fatal("missed replies did not mark offline")
	}
	if _, err = b.Create(ctx, log, inference.Create{}); err == nil {
		t.Fatal("invalid create accepted")
	}
	var empty any
	if err = json.Unmarshal([]byte(`{}`), &empty); err != nil {
		t.Fatal(err)
	}
}
