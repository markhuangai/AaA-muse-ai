package inference

import "time"

type QualificationInput struct {
	Version               int    `json:"protocol_version"`
	SubmissionID          string `json:"submission_id"`
	Action                string `json:"action"`
	EvidenceKind          string `json:"evidence_kind,omitempty"`
	EvidenceReference     string `json:"evidence_reference"`
	ReadinessExperimentID string `json:"readiness_experiment_id,omitempty"`
	ToolExperimentID      string `json:"tool_experiment_id,omitempty"`
}

type Qualification struct {
	ID                   string             `json:"id"`
	WorkerID             string             `json:"worker_id"`
	CreatedAt            time.Time          `json:"created_at"`
	ConnectionID         string             `json:"connection_id"`
	ConnectionGeneration int64              `json:"connection_generation"`
	Capabilities         []string           `json:"capabilities"`
	Input                QualificationInput `json:"evidence"`
}

type WorkerRouting struct {
	LastDispatchedAt *time.Time          `json:"last_dispatched_at,omitempty"`
	Qualifications   []Qualification     `json:"qualifications"`
	Upgrade          *UpgradeReservation `json:"upgrade_reservation,omitempty"`
}

type UpgradeReservation struct {
	OperationID string     `json:"operation_id"`
	Generation  int64      `json:"generation"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
}

func (u *UpgradeReservation) Active(now time.Time) bool {
	return u != nil && u.ExpiresAt != nil && now.Before(*u.ExpiresAt)
}

func (r WorkerRouting) UpgradeGeneration() int64 {
	if r.Upgrade == nil {
		return 0
	}
	return r.Upgrade.Generation
}

func (r WorkerRouting) Latest() *Qualification {
	if len(r.Qualifications) == 0 {
		return nil
	}
	return &r.Qualifications[len(r.Qualifications)-1]
}

func RequiredCapabilities(messages []Item, tools []Tool) []string {
	result := []string{"text"}
	needsTools := len(tools) > 0
	for _, item := range messages {
		needsTools = needsTools || item.Type == "tool_call" || item.Type == "tool_result"
	}
	if needsTools {
		result = append(result, "function_tools")
	}
	return result
}
