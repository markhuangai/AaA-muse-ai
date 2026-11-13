package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func (b *Broker) AwaitRequest(ctx context.Context, logger *slog.Logger, client string, admitted inference.RequestView) (inference.RequestView, error) {
	deadline := admitted.CreatedAt.Add(300 * time.Second)
	for {
		if err := ctx.Err(); err != nil {
			return admitted, err
		}
		view, err := b.ReadRequest(ctx, logger, client, admitted.ID, admitted.SessionID)
		if err != nil {
			return admitted, err
		}
		admitted = view
		if view.Output != nil {
			return view, nil
		}
		if view.State == "interrupted" || view.State == "cancelled" {
			status := 503
			if view.Reason == "deadline_exceeded" {
				status = 504
			}
			return view, inference.Reject(view.Reason, status)
		}
		if !b.now().Before(deadline) {
			return view, inference.Reject("deadline_exceeded", 504)
		}
		if err = b.Wait(ctx, 250*time.Millisecond); err != nil {
			return view, err
		}
	}
}

func (b *Broker) CancelChat(ctx context.Context, logger *slog.Logger, client string, admitted inference.RequestView) (inference.RequestView, error) {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	view, err := b.CancelRequest(cleanup, logger, client, admitted.ID, admitted.SessionID, inference.Cancel{Version: 1, SubmissionID: "chat-cancel-" + admitted.ID})
	var rejected *inference.Rejection
	if errors.As(err, &rejected) && rejected.Reason == "request_already_completed" {
		return b.ReadRequest(cleanup, logger, client, admitted.ID, admitted.SessionID)
	}
	if err != nil {
		return admitted, err
	}
	return view, nil
}
