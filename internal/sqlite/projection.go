package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const projectionRows = `SELECT w.id, w.revoked_at, w.last_contact_at, c.data, p.last_poll_at, p.result, u.data, rt.data,
	cap.agent_tasks, cap.prompt_contract, cap.observed_at, cap.scheduled_at, slot.lane, op.data, task.data,
	usage.used_percent, usage.observed_at, usage.reset_label, held.data, e.id, e.state, e.deadline_at
	FROM aaa_workers w
	LEFT JOIN aaa_worker_connections c ON c.worker_id=w.id
	LEFT JOIN aaa_worker_polls p ON p.worker_id=w.id
	LEFT JOIN aaa_worker_updates u ON u.worker_id=w.id
	LEFT JOIN aaa_worker_routing rt ON rt.worker_id=w.id
	LEFT JOIN aaa_worker_capabilities cap ON cap.worker_id=w.id
	LEFT JOIN aaa_worker_slots slot ON slot.worker_id=w.id
	LEFT JOIN aaa_worker_ops op ON slot.lane='worker_op' AND op.id=slot.item_id
	LEFT JOIN aaa_agent_tasks task ON slot.lane='agent_task' AND task.id=slot.item_id
	LEFT JOIN aaa_worker_weekly_usage usage ON usage.worker_id=w.id AND NOT ?2
	LEFT JOIN aaa_inference_jobs held ON held.worker_id=w.id AND held.held
	LEFT JOIN aaa_experiments e ON e.id=held.experiment_id AND e.worker_id=w.id
	WHERE w.id IN (SELECT value FROM json_each(?1))`

const pendingToolCounts = `SELECT worker_id, count(*) FROM aaa_conversations
	WHERE pending_call_id<>'' AND worker_id IN (SELECT value FROM json_each(?1)) GROUP BY worker_id`

const waitingExperimentCounts = `SELECT worker_id, count(*) FROM aaa_experiments
	WHERE state NOT IN ('completed','cancelled','interrupted') AND state='waiting_for_tool'
	AND worker_id IN (SELECT value FROM json_each(?1)) AND deadline_at>?2 GROUP BY worker_id`

func (r *Repository) WorkerProjection(ctx context.Context, id string, own bool) (*inference.State, error) {
	states, err := r.workerProjections(ctx, []string{id}, own)
	if err != nil {
		return nil, err
	}
	return states[0], nil
}

func (r *Repository) ListWorkerProjections(ctx context.Context, ids []string) ([]*inference.State, error) {
	return r.workerProjections(ctx, ids, false)
}

func (r *Repository) workerProjections(ctx context.Context, ids []string, own bool) ([]*inference.State, error) {
	ordered := make([]*inference.State, 0, len(ids))
	if len(ids) == 0 {
		return ordered, nil
	}
	err := r.read(ctx, func(tx *sql.Tx) error {
		now, selected := r.databaseTime(), idList(ids)
		states := make(map[string]*inference.State, len(ids))
		rows, err := tx.QueryContext(ctx, projectionRows, selected, own)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			state, err := scanProjection(rows, now, own)
			if err != nil {
				return err
			}
			states[state.WorkerID] = state
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range ids {
			state := states[id]
			if state == nil {
				return inference.Reject("worker_not_found", 404)
			}
			ordered = append(ordered, state)
		}
		if err := addProjectionCounts(ctx, tx, states, pendingToolCounts, false, selected); err != nil {
			return err
		}
		return addProjectionCounts(ctx, tx, states, waitingExperimentCounts, true, selected, now.UnixMicro())
	})
	return ordered, err
}

func scanProjection(row scanner, now time.Time, own bool) (*inference.State, error) {
	state := &inference.State{Now: now}
	var revoked, contact, polled, capabilityAt, capabilitySchedule, usageAt, deadline *int64
	var connection, poll, update, routing, op, task, held []byte
	var tasks *bool
	var contract, lane, reset, experimentID, experimentState *string
	var used *float64
	if err := row.Scan(&state.WorkerID, &revoked, &contact, &connection, &polled, &poll, &update, &routing,
		&tasks, &contract, &capabilityAt, &capabilitySchedule, &lane, &op, &task, &used, &usageAt, &reset, &held,
		&experimentID, &experimentState, &deadline); err != nil {
		return nil, err
	}
	if revoked != nil && own {
		return nil, inference.Reject("worker_revoked", 401, "correlation", nil, "expected_worker_id", state.WorkerID, "observed_worker_id", state.WorkerID)
	}
	state.Revoked, state.LastContactAt, state.LastPollAt = revoked != nil, instant(contact), instant(polled)
	observations, err := readPollObservations(poll)
	if err != nil {
		return nil, err
	}
	for _, field := range []struct {
		data []byte
		dest any
	}{{connection, &state.Connection}, {routing, &state.Routing}} {
		if field.data != nil {
			if err := decodeInference(field.data, field.dest); err != nil {
				return nil, err
			}
		}
	}
	if update != nil {
		value, err := decodeWorkerUpdate(update, observations.Update)
		if err != nil {
			return nil, err
		}
		if value.ObservedAt != nil || value.State != "" {
			state.WorkerUpdate = &value
		}
	}
	if tasks != nil {
		if stamp := observations.Capability; stamp != (observationStamp{}) && stamp.Scheduled > *capabilitySchedule {
			capabilityAt = &stamp.Observed
		}
		observed := instant(capabilityAt)
		state.WorkerCapability = &worker.Capability{AgentTasks: *tasks, PromptContract: *contract, ObservedAt: *observed}
		state.ControlProjection.PromptContract, state.ControlProjection.CapabilitiesObservedAt = *contract, observed
	}
	if used != nil {
		state.WeeklyUsage = &worker.WeeklyUsage{UsedPercent: *used, ObservedAt: *instant(usageAt), ResetLabel: *reset}
	}
	if lane != nil {
		state.ControlProjection.ActiveSlotLane = *lane
		if err := scanProjectionControl(&state.ControlProjection, op, task); err != nil {
			return nil, err
		}
	}
	if held != nil {
		var job inference.Job
		if err := decodeInference(held, &job); err != nil {
			return nil, err
		}
		state.Jobs = map[string]*inference.Job{job.ID: &job}
		if experimentID != nil {
			state.Experiments = map[string]*inference.Experiment{*experimentID: {
				ID: *experimentID, State: *experimentState, DeadlineAt: *instant(deadline), CurrentJobID: job.ID, WorkerID: state.WorkerID,
			}}
		}
	}
	return state, nil
}

func scanProjectionControl(projection *worker.ControlProjection, op, task []byte) error {
	if projection.ActiveSlotLane == "inference" {
		return nil
	}
	var raw []byte
	var dest **worker.ControlItem
	switch projection.ActiveSlotLane {
	case worker.WorkerOp:
		raw, dest = op, &projection.CurrentWorkerOp
	case worker.AgentTask:
		raw, dest = task, &projection.CurrentAgentTask
	default:
		_, err := controlTable(projection.ActiveSlotLane)
		return err
	}
	if raw == nil {
		return sql.ErrNoRows
	}
	var record worker.ControlRecord
	if err := decodeInference(raw, &record); err != nil {
		return err
	}
	item := record.Summary()
	*dest = &item
	return nil
}

func addProjectionCounts(ctx context.Context, tx *sql.Tx, states map[string]*inference.State, query string, activeOnly bool, args ...any) error {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var count int
		if err := rows.Scan(&id, &count); err != nil {
			return err
		}
		if state := states[id]; !activeOnly || !state.Revoked {
			state.PendingTools += count
		}
	}
	return rows.Err()
}
