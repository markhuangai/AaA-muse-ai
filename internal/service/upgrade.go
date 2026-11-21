package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

const upgradeDuration = 120 * time.Second

type UpgradeInput struct {
	Version     int    `json:"protocol_version"`
	Action      string `json:"action"`
	OperationID string `json:"operation_id"`
	Generation  int64  `json:"generation"`
}

func pendingUpgradeWork(s *inference.State) error {
	for _, j := range s.Jobs {
		if j.Held || j.State == "queued" || j.State == "claimed" {
			return inference.Reject("worker_busy", 409, "job_id", j.ID, "job_state", j.State, "busy_hold", j.Held)
		}
	}
	for _, e := range s.Experiments {
		if e.State == "waiting_for_tool" {
			return inference.Reject("worker_busy", 409, "experiment_id", e.ID, "reason", "pending_tool_result")
		}
	}
	if s.PendingTools != 0 {
		return inference.Reject("worker_busy", 409, "waiting_for_client_tool", s.PendingTools)
	}
	return nil
}

func (b *Broker) UpgradeReservation(ctx context.Context, logger *slog.Logger, worker string, input UpgradeInput) (json.RawMessage, error) {
	ref := inference.Ref{WorkerID: worker, WorkerAuth: worker, UpdateRouting: true, CountPendingTools: true}
	logger = logger.With("upgrade_operation_id", input.OperationID, "upgrade_action", input.Action, "upgrade_lease_seconds", int(upgradeDuration/time.Second))
	// Check the current lease even on exact retries. A saved response could refer to an expired lease.
	return b.run(ctx, logger, ref, "worker_upgrade_reservation", input, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		if input.Version != inference.Version || !inference.Identifier.MatchString(input.OperationID) || input.Generation < 0 {
			return nil, inference.Reject("invalid_upgrade_reservation", 400)
		}
		lease := s.Routing.Upgrade
		active := lease.Active(s.Now)
		previous := s.Routing.UpgradeGeneration()
		same := lease != nil && lease.OperationID == input.OperationID
		switch input.Action {
		case "acquire":
			if active && same && input.Generation == previous-1 {
				break
			}
			if active || same || input.Generation != previous || previous == math.MaxInt64 {
				return nil, inference.Reject("upgrade_reservation_conflict", 409, "generation", previous, "active", active)
			}
			if err := pendingUpgradeWork(s); err != nil {
				return nil, err
			}
			expires := s.Now.Add(upgradeDuration)
			lease = &inference.UpgradeReservation{OperationID: input.OperationID, Generation: previous + 1, ExpiresAt: &expires}
			s.Routing.Upgrade = lease
		case "renew", "release":
			if !same || input.Generation != previous || (input.Action == "renew" && !active) {
				return nil, inference.Reject("upgrade_reservation_fenced", 409, "generation", previous, "active", active)
			}
			if input.Action == "renew" {
				expires := s.Now.Add(upgradeDuration)
				lease.ExpiresAt = &expires
			} else {
				lease.ExpiresAt = nil
			}
		default:
			return nil, inference.Reject("invalid_upgrade_action", 400)
		}
		*events = append(*events, inferenceEvent{"worker.upgrade_reservation", slog.LevelInfo, []any{
			"operation_id", input.OperationID, "worker_id", worker, "connection_generation", s.Connection.Generation,
			"generation", lease.Generation, "expires_at", lease.ExpiresAt, "outcome", input.Action,
		}})
		return lease, nil
	})
}
