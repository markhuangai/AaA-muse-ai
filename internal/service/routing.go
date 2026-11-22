package service

import "github.com/markhuangai/AaA-muse-ai/internal/inference"

func poolWorker(s *inference.State, id string) *inference.State {
	if s.Pool != nil {
		return s.Pool[id]
	}
	if s.WorkerID == id {
		return s
	}
	return nil
}

func validQueueTarget(s *inference.State, target string) error {
	if target == "" {
		return nil
	}
	worker := poolWorker(s, target)
	if worker == nil {
		return inference.Reject("worker_not_found", 404)
	}
	if worker.Revoked {
		return inference.Reject("worker_revoked", 409)
	}
	return nil
}

func historicalReadiness(s *inference.State) string {
	q := s.Routing.Latest()
	if q == nil {
		return "unverified"
	}
	if q.Input.Action != "approve" {
		return "withdrawn"
	}
	return "verified"
}

func connectionEligibility(w *inference.State) string {
	switch {
	case w == nil:
		return "worker_not_found"
	case w.Revoked:
		return "worker_revoked"
	case w.Connection.Status(w.Now) != "online":
		return "worker_offline"
	}
	return ""
}

func jobEligibility(s *inference.State, j *inference.Job) error {
	w := poolWorker(s, j.WorkerID)
	if j.Media != nil || s.Requests[j.ExperimentID] != nil {
		if reason := connectionEligibility(w); reason != "" {
			return inference.Reject("no_ready_worker", 503, "worker_id", j.WorkerID, "eligibility_reason", reason)
		}
	}
	if j.Media != nil && !supportsMedia(w.Connection, j.Media.Profile) {
		return inference.Reject("media_worker_unsupported", 409, "required_capability", mediaCapability(j.Media.Profile))
	}
	return nil
}

func movableConversation(s *inference.State, c *inference.Conversation) bool {
	if c == nil || c.WorkerID == "" {
		return false
	}
	previous := s.Requests[c.CurrentRequestID]
	return c.PendingCallID == "" && previous != nil && previous.State == "completed" && previous.Output != nil && previous.Output.Type == "final"
}
