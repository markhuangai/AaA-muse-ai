package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func TestChatAwaitUsesNativeDecisionAndCancellation(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	c := connectNative(t, b, m, logger, "worker-a")
	v := admitted(t, b, "alice", "chat-session", requestInput("chat"))
	waits := 0
	b.Wait = func(ctx context.Context, d time.Duration) error {
		waits++
		if d != 250*time.Millisecond {
			t.Fatal("unexpected poll budget")
		}
		nativeDecide(t, b, m, c, v, inference.Item{Type: "final", Text: "real native result"})
		return nil
	}
	result, err := b.AwaitRequest(context.Background(), logger, "alice", v)
	if err != nil || result.Output == nil || result.Output.Text != "real native result" || waits != 1 {
		t.Fatal("native decision not awaited", result, err)
	}
	retained, err := b.CancelChat(context.Background(), logger, "alice", v)
	if err != nil || retained.Output == nil || retained.State != "completed" {
		t.Fatal("cancellation discarded an accepted decision", err)
	}
	v = admitted(t, b, "alice", "chat-cancel", requestInput("cancel"))
	cancelled, err := b.CancelChat(context.Background(), logger, "alice", v)
	if err != nil || cancelled.State != "cancelled" {
		t.Fatal("owned cancellation failed", err)
	}
	_, err = b.AwaitRequest(context.Background(), logger, "alice", v)
	requireInferenceReason(t, err, "operator_cancelled")
	_, err = b.AwaitRequest(context.Background(), logger, "other", v)
	requireInferenceReason(t, err, "history_owner_denied")
	if _, err = b.CancelChat(context.Background(), logger, "other", v); err == nil {
		t.Fatal("foreign cancellation accepted")
	}
}

func TestChatAwaitStopsOnContextAndNativeDeadline(t *testing.T) {
	for _, kind := range []string{"context", "wait", "deadline", "hard-bound"} {
		t.Run(kind, func(t *testing.T) {
			b, m, logger, _ := inferenceFixture()
			connectNative(t, b, m, logger, "worker-a")
			v := admitted(t, b, "alice", "chat", requestInput("chat"))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if kind == "context" {
				cancel()
			}
			b.Wait = func(context.Context, time.Duration) error {
				if kind == "wait" {
					return errors.New("wait interrupted")
				}
				m.now = m.now.Add(301 * time.Second)
				if kind == "hard-bound" {
					m.states["worker-a"].Experiments[v.ID].DeadlineAt = m.now.Add(time.Hour)
				}
				return nil
			}
			_, err := b.AwaitRequest(ctx, logger, "alice", v)
			if err == nil {
				t.Fatal("unbounded wait")
			}
			if kind == "deadline" || kind == "hard-bound" {
				requireInferenceReason(t, err, "deadline_exceeded")
			}
		})
	}
}
