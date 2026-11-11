package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func poolWorker(s *inference.State, id string) *inference.State {
	if s.Pool != nil {
		return s.Pool[id]
	}
	if s.WorkerID == id {
		return s
	}
	return nil
}

func readiness(s *inference.State) string {
	q := s.Routing.Latest()
	if q == nil {
		return "unverified"
	}
	if q.Input.Action != "approve" {
		return "withdrawn"
	}
	if q.ConnectionID != s.Connection.ID || q.ConnectionGeneration != s.Connection.Generation {
		return "stale"
	}
	return "verified"
}

func eligible(s *inference.State, required []string) string {
	if s == nil {
		return "worker_not_found"
	}
	if s.Revoked {
		return "worker_revoked"
	}
	if s.Connection.Status(s.Now) != "online" {
		return "worker_offline"
	}
	if readiness(s) != "verified" {
		return "readiness_" + readiness(s)
	}
	for _, capability := range required {
		if !slices.Contains(s.Routing.Latest().Capabilities, capability) {
			return "capability_missing"
		}
	}
	return ""
}

func nativeEligibility(s *inference.State, j *inference.Job) error {
	if r := s.Requests[j.ExperimentID]; r != nil {
		w := poolWorker(s, j.WorkerID)
		if reason := eligible(w, inference.RequiredCapabilities(r.Input.Messages, r.Input.Tools)); reason != "" {
			return inference.Reject("no_ready_worker", 503, "worker_id", j.WorkerID, "eligibility_reason", reason)
		}
	}
	return nil
}

func evidenceExperiment(s *inference.State, worker, id string) (*inference.Experiment, int, error) {
	e, w := s.Experiments[id], poolWorker(s, worker)
	if e == nil || w == nil || e.WorkerID != worker || e.State != "completed" || e.RemoteOutcome != "decision_observed" || s.Requests[id] != nil {
		return nil, 0, inference.Reject("qualification_evidence_invalid", 409)
	}
	count := 0
	for _, j := range s.Jobs {
		if j.ExperimentID != id {
			continue
		}
		if j.State != "accepted" || j.Held || j.WorkerID != worker || j.ConnectionID != w.Connection.ID || j.ConnectionGeneration != w.Connection.Generation || j.Generation < 1 || j.LeaseID == "" {
			return nil, 0, inference.Reject("qualification_evidence_stale", 409)
		}
		count++
	}
	if count == 0 {
		return nil, 0, inference.Reject("qualification_evidence_missing", 409)
	}
	return e, count, nil
}

func verifyReadiness(e *inference.Experiment, count int) bool {
	if count != 1 || len(e.Messages) < 2 {
		return false
	}
	last := e.Messages[len(e.Messages)-1]
	challenge := e.Messages[len(e.Messages)-2]
	if challenge.Type != "message" || challenge.Role != "user" || challenge.Text == "" || last.Type != "message" || last.Role != "assistant" || last.Text != challenge.Text || e.FinalText != challenge.Text {
		return false
	}
	for _, item := range e.Messages {
		if item.Type != "message" {
			return false
		}
	}
	return true
}

func verifyToolTrial(e *inference.Experiment, count int) bool {
	if count < 2 || len(e.Messages) == 0 {
		return false
	}
	last := e.Messages[len(e.Messages)-1]
	if last.Type != "message" || last.Role != "assistant" || last.Text != e.FinalText {
		return false
	}
	pending, calls := "", 0
	for _, item := range e.Messages {
		if item.Type == "tool_call" {
			if pending != "" {
				return false
			}
			pending, calls = item.CallID, calls+1
		} else if item.Type == "tool_result" {
			if pending == "" || pending != item.CallID {
				return false
			}
			pending = ""
		}
	}
	return calls > 0 && pending == ""
}

func (b *Broker) Qualify(ctx context.Context, logger *slog.Logger, worker string, input inference.QualificationInput) (json.RawMessage, error) {
	if err := inference.VersionAndID(input.Version, input.SubmissionID); err != nil {
		return nil, err
	}
	if (input.Action != "approve" && input.Action != "withdraw") || strings.TrimSpace(input.EvidenceReference) == "" || len(input.EvidenceReference) > 1024 {
		return nil, inference.Reject("invalid_qualification", 400)
	}
	if input.Action == "approve" && ((input.EvidenceKind != "live" && input.EvidenceKind != "controlled") || !inference.Identifier.MatchString(input.ReadinessExperimentID) || (input.ToolExperimentID != "" && !inference.Identifier.MatchString(input.ToolExperimentID))) {
		return nil, inference.Reject("invalid_qualification", 400)
	}
	ref := inference.Ref{WorkerID: worker, Principal: "management", SubmissionID: input.SubmissionID, Routing: true, Full: true, EvidenceIDs: []string{input.ReadinessExperimentID, input.ToolExperimentID}}
	return b.run(ctx, logger, ref, "qualification", struct {
		WorkerID string                       `json:"worker_id"`
		Input    inference.QualificationInput `json:"input"`
	}{worker, input}, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		w := poolWorker(s, worker)
		if w == nil {
			return nil, inference.Reject("worker_not_found", 404)
		}
		capabilities := []string{}
		if input.Action == "approve" {
			if w.Revoked || w.Connection.Status(s.Now) != "online" {
				return nil, inference.Reject("qualification_worker_unavailable", 409)
			}
			e, count, err := evidenceExperiment(s, worker, input.ReadinessExperimentID)
			if err != nil {
				return nil, err
			}
			if !verifyReadiness(e, count) {
				return nil, inference.Reject("qualification_readiness_mismatch", 409)
			}
			capabilities = append(capabilities, "text")
			if input.ToolExperimentID != "" {
				e, count, err = evidenceExperiment(s, worker, input.ToolExperimentID)
				if err != nil {
					return nil, err
				}
				if !verifyToolTrial(e, count) {
					return nil, inference.Reject("qualification_tool_linkage_invalid", 409)
				}
				capabilities = append(capabilities, "function_tools")
			}
		}
		id, err := auth.ID(b.random)
		if err != nil {
			return nil, err
		}
		q := inference.Qualification{ID: id, WorkerID: worker, CreatedAt: s.Now, ConnectionID: w.Connection.ID, ConnectionGeneration: w.Connection.Generation, Capabilities: capabilities, Input: input}
		w.Routing.Qualifications = append(w.Routing.Qualifications, q)
		event(events, slog.LevelInfo, "worker.qualification_changed", w, nil, "qualification", q, "operator_attests", "unattended_conditions_and_semantic_tool_correctness", "release_qualification", "not_established")
		return q, nil
	})
}
