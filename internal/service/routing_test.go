package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func autoInput(id string) inference.RequestInput {
	return inference.RequestInput{Version: 1, SubmissionID: id, Messages: []inference.Item{{Type: "message", Role: "user", Text: id}}, Tools: []inference.Tool{}}
}

func TestRoutingQueueAndClaimOwnership(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	ctx := context.Background()
	for _, workers := range []struct{ target, session string }{{"worker-a", "a"}, {"worker-b", "b"}} {
		input := autoInput(workers.session)
		input.WorkerID = workers.target
		queued := admitted(t, b, "alice", workers.session, input)
		pending := m.states[workers.target].Experiments[queued.ID]
		if queued.WorkerID != "" || pending == nil || pending.CurrentJobID == "" || m.states[""].Conversations[queued.ConversationID].WorkerID != "" {
			t.Fatal("targeted admission did not create a durable unclaimed job")
		}
		job := startFixtureJob(t, b, m, workers.target, queued.ID)
		view, err := b.ReadRequest(ctx, logger, "alice", queued.ID, workers.session)
		if err != nil || job.WorkerID != workers.target || view.WorkerID != workers.target || job.ClaimedAt == nil || job.StartedAt == nil {
			t.Fatal("native claim did not set stable ownership", err)
		}
		_, err = b.ReadRequest(ctx, logger, "bob", queued.ID, "")
		requireInferenceReason(t, err, "history_owner_denied")
	}
	queued := admitted(t, b, "alice", "busy", autoInput("busy"))
	if queued.WorkerID != "" || queued.State != "queued" || m.states[""].Experiments[queued.ID].CurrentJobID == "" {
		t.Fatal("busy pool prevented durable admission or preassigned the request")
	}
}

func TestRoutingReleasesOnlyAnUntouchedOfflinePin(t *testing.T) {
	for _, boundary := range []string{"unclaimed", "started", "explicit"} {
		t.Run(boundary, func(t *testing.T) {
			b, m, logger, logs := inferenceFixture()
			ctx := context.Background()
			worker := connectInference(t, b, m, logger, "worker-a")
			first := admitted(t, b, "alice", "pin", autoInput("first"))
			nativeDecide(t, b, m, worker, first, inference.Item{Type: "final", Text: "first result"})
			contact := m.now
			m.now = contact.Add(9 * time.Minute)
			input := autoInput("next")
			input.Messages = append(inference.Messages(m.states["worker-a"].Conversations[first.ConversationID], 2), input.Messages...)
			if boundary == "explicit" {
				input.WorkerID = "worker-a"
			}
			queued := admitted(t, b, "alice", "pin", input)
			oldID := m.states["worker-a"].Experiments[queued.ID].CurrentJobID
			if boundary == "started" {
				startFixtureJob(t, b, m, "worker-a", queued.ID)
			}
			m.now = contact.Add(10*time.Minute - time.Microsecond)
			if err := b.checkQueuedPin(ctx, logger, oldID); err != nil {
				t.Fatal(err)
			}
			if m.states["worker-a"].Experiments[queued.ID] == nil {
				t.Fatal("pin moved before its offline cutoff")
			}
			m.now = contact.Add(10 * time.Minute)
			if err := b.checkQueuedPin(ctx, logger, oldID); err != nil {
				t.Fatal(err)
			}
			if boundary != "unclaimed" {
				if m.states["worker-a"].Experiments[queued.ID] == nil {
					t.Fatal("a constrained or started job lost its pin")
				}
				return
			}
			if m.states[""].Experiments[queued.ID] == nil || !strings.Contains(logs.String(), "dispatch.pin_released") {
				t.Fatal("unclaimed offline continuation was not released")
			}
			replacement := startFixtureJob(t, b, m, "worker-b", queued.ID)
			if replacement.ID == oldID || len(replacement.Context.Messages) != len(input.Messages) || replacement.Context.Kind != "full" {
				t.Fatal("replacement omitted canonical history or reused the old assignment")
			}
		})
	}
}

func TestRoutingDeadlineCancellationAndConcurrentSession(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	ctx := context.Background()
	input := autoInput("deadline")
	input.TimeoutSeconds = 1
	queued := admitted(t, b, "alice", "deadline", input)
	cancelled := admitted(t, b, "alice", "cancel", autoInput("cancel"))
	if _, err := b.CancelRequest(ctx, logger, "alice", cancelled.ID, "", inference.Cancel{Version: 1, SubmissionID: "cancel-q"}); err != nil {
		t.Fatal(err)
	}
	m.now = m.now.Add(2 * time.Second)
	view, err := b.ReadRequest(ctx, logger, "alice", queued.ID, "")
	if err != nil || view.State != "interrupted" || view.Reason != "deadline_exceeded" || view.WorkerID != "" {
		t.Fatal("unclaimed queue deadline lost", view, err)
	}
	var group sync.WaitGroup
	results := make(chan error, 8)
	for index := range 8 {
		group.Go(func() {
			input := autoInput("race-" + time.Unix(int64(index), 0).Format("150405"))
			_, err := b.SubmitRequest(ctx, testHistoryLogger(), "alice", "race", input)
			results <- err
		})
	}
	group.Wait()
	close(results)
	accepted := 0
	for err := range results {
		if err == nil {
			accepted++
			continue
		}
		var rejected *inference.Rejection
		if !errors.As(err, &rejected) || rejected.Reason != "session_busy" {
			t.Error(err)
		}
	}
	if accepted != 1 {
		t.Fatal("session admission was not serialized", accepted)
	}
}
