package service

import (
	"context"
	"log/slog"
	"sort"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func candidates(s *inference.State, c *inference.Conversation, input inference.RequestInput, movable bool, ownJob string) ([]*inference.State, []map[string]any) {
	required := inference.RequiredCapabilities(input.Messages, input.Tools)
	allowed, observed := []*inference.State{}, []map[string]any{}
	for id, w := range s.Pool {
		reason := eligible(w, required)
		if input.WorkerID != "" && input.WorkerID != id {
			reason = "selection_constraint"
		}
		if c != nil && c.WorkerID != "" && id != c.WorkerID {
			pin := s.Pool[c.WorkerID]
			if pin == nil || pin.Connection.Status(s.Now) != "offline" || !movable {
				reason = "session_pin"
			}
		}
		capacity := available(s, id, ownJob)
		exclusion := reason
		if exclusion == "" && !capacity {
			exclusion = "worker_capacity"
		}
		reservations := []map[string]any{}
		for _, job := range s.Jobs {
			if job.WorkerID == id && job.ID != ownJob && (job.Held || job.State == "queued") {
				reservations = append(reservations, map[string]any{"job_id": job.ID, "request_record_id": job.ExperimentID, "state": job.State, "held": job.Held, "generation": job.Generation, "connection_generation": job.ConnectionGeneration})
			}
		}
		sort.Slice(reservations, func(i, j int) bool { return reservations[i]["job_id"].(string) < reservations[j]["job_id"].(string) })
		observed = append(observed, map[string]any{"capacity_available": capacity, "reservations": reservations, "last_dispatched_at": w.Routing.LastDispatchedAt, "eligibility_reason": reason, "worker_id": id, "connection_status": w.Connection.Status(s.Now), "connection_generation": w.Connection.Generation, "last_heartbeat_at": w.Connection.LastAckAt, "readiness": readiness(w), "qualification": w.Routing.Latest(), "exclusion_reason": exclusion})
		if reason == "" {
			allowed = append(allowed, w)
		}
	}
	sort.Slice(observed, func(i, j int) bool { return observed[i]["worker_id"].(string) < observed[j]["worker_id"].(string) })
	sort.Slice(allowed, func(i, j int) bool {
		a, z := allowed[i].Routing.LastDispatchedAt, allowed[j].Routing.LastDispatchedAt
		if a == nil && z != nil {
			return true
		}
		if a != nil && z == nil {
			return false
		}
		if a != nil && z != nil && !a.Equal(*z) {
			return a.Before(*z)
		}
		return allowed[i].WorkerID < allowed[j].WorkerID
	})
	return allowed, observed
}

func available(s *inference.State, worker, ownJob string) bool {
	for _, j := range s.Jobs {
		if j.WorkerID == worker && j.ID != ownJob && (j.Held || j.State == "queued") {
			return false
		}
	}
	return true
}

func movableConversation(s *inference.State, c *inference.Conversation) bool {
	if c == nil || c.WorkerID == "" {
		return false
	}
	previous := s.Requests[c.CurrentRequestID]
	return c.PendingCallID == "" && previous != nil && previous.State == "completed" && previous.Output != nil && previous.Output.Type == "final"
}

func requestJob(s *inference.State, r *inference.Request) *inference.Job {
	if e := s.Experiments[r.ID]; e != nil {
		return s.Jobs[e.CurrentJobID]
	}
	return nil
}

func (b *Broker) dispatch(s *inference.State, events *[]inferenceEvent) error {
	queue := []*inference.Request{}
	for _, r := range s.Requests {
		if e := s.Experiments[r.ID]; e != nil && e.State == "queued" {
			queue = append(queue, r)
		}
	}
	sort.Slice(queue, func(i, j int) bool {
		if queue[i].CreatedAt.Equal(queue[j].CreatedAt) {
			return queue[i].ID < queue[j].ID
		}
		return queue[i].CreatedAt.Before(queue[j].CreatedAt)
	})
	for _, r := range queue {
		e, c, old := s.Experiments[r.ID], s.Conversations[r.ConversationID], requestJob(s, r)
		movable := r.ReassignAllowed && r.ContextDeliveryStarted == nil && (old == nil || (old.ClaimedAt == nil && !old.Held))
		allowed, evidence := candidates(s, c, r.Input, movable, e.CurrentJobID)
		if old != nil {
			w := s.Pool[old.WorkerID]
			if w == nil || w.Connection.Status(s.Now) != "offline" || !movable {
				continue
			}
		}
		var selected *inference.State
		for _, w := range allowed {
			if available(s, w.WorkerID, e.CurrentJobID) {
				selected = w
				break
			}
		}
		if selected == nil {
			continue
		}
		previous := c.WorkerID
		priorJob := e.CurrentJobID
		if old != nil {
			old.State, old.Reason = "cancelled", "rerouted_before_delivery"
		}
		c.WorkerID, r.WorkerID, e.WorkerID = selected.WorkerID, selected.WorkerID, selected.WorkerID
		j, err := b.newJob(s, e, nil)
		if err != nil {
			return err
		}
		q := *selected.Routing.Latest()
		j.Qualification = &q
		stamp := s.Now
		selected.Routing.LastDispatchedAt = &stamp
		reason := "least_recent_dispatch"
		if previous == selected.WorkerID {
			reason = "session_pin"
		}
		if previous != "" && previous != selected.WorkerID {
			event(events, slog.LevelInfo, "dispatch.reassigned", s, j, "expected_worker_id", previous, "observed_worker_id", selected.WorkerID, "reason", "offline_before_claim_and_context", "context_delivery_started", false, "prior_job_id", priorJob)
		}
		event(events, slog.LevelInfo, "dispatch.assigned", s, j, "candidates", evidence, "selected_worker_id", selected.WorkerID, "reason", reason, "queue_wait_ms", s.Now.Sub(r.CreatedAt).Milliseconds(), "qualification", q, "required_capabilities", inference.RequiredCapabilities(r.Input.Messages, r.Input.Tools))
		event(events, slog.LevelInfo, "job.queued", s, j, "context_kind", "full", "context_receipt_id", j.Context.ReceiptID)
		event(events, slog.LevelDebug, "inference.context", s, j, "context", j.Context, "canonical_messages", e.Messages)
	}
	return nil
}

func (b *Broker) Dispatch(ctx context.Context, logger *slog.Logger) error {
	_, err := b.run(ctx, logger, inference.Ref{Routing: true, Full: true}, "dispatch", nil, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		return nil, b.dispatch(s, events)
	})
	return err
}
