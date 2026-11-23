package worker

import (
	"slices"
	"strings"
	"time"
)

const UpdateContract = "native-cron-v1"

type PackagePin struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
	URL     string `json:"url"`
}

type UpdateTarget struct {
	PackagePin
	Source     string `json:"source_sha"`
	Contract   string `json:"contract"`
	FromMajors string `json:"from_majors"`
}

func (t UpdateTarget) Supports(version, contract string) bool {
	from, _, valid := strings.Cut(version, ".")
	to, _, _ := strings.Cut(t.Version, ".")
	return valid && from != "0" && contract == t.Contract &&
		(from == to || slices.Contains(strings.Split(t.FromMajors, ","), from))
}

type UpdateBroker struct {
	ID     string
	Target *UpdateTarget
}

type Contact struct {
	Version  string `json:"version,omitempty"`
	Digest   string `json:"sha256,omitempty"`
	Contract string `json:"contract,omitempty"`
	// Incompatible is only set after the HTTP major-version check admits an update-only pull.
	Incompatible bool `json:"-"`
}

type UpdateOffer struct {
	ID     string       `json:"id"`
	Target UpdateTarget `json:"target"`
}

type UpdateRequest struct {
	ID              string       `json:"id"`
	Action          string       `json:"action"`
	Target          UpdateTarget `json:"target"`
	WorkerID        string       `json:"worker_id,omitempty"`
	PreviousVersion string       `json:"previous_version,omitempty"`
	Reason          string       `json:"reason,omitempty"`
}

type UpdateStatus struct {
	Contact
	ObservedAt  *time.Time    `json:"observed_at,omitempty"`
	ScheduledAt time.Time     `json:"scheduled_at,omitzero"`
	Target      *UpdateTarget `json:"target,omitempty"`
	ID          string        `json:"id,omitempty"`
	State       string        `json:"state,omitempty"`
	Reason      string        `json:"reason,omitempty"`
	RetryAt     *time.Time    `json:"retry_at,omitempty"`
	Attempt     int           `json:"attempt,omitempty"`
	StartedAt   *time.Time    `json:"started_at,omitempty"`
	From        Contact       `json:"from,omitzero"`
}

func (s UpdateStatus) Active() bool {
	return s.State == "downloading" || s.State == "switching" || s.State == "awaiting_confirmation"
}

func (s *UpdateStatus) Observe(c Contact, scheduled, received time.Time) {
	if c.Version != "" && scheduled.After(s.ScheduledAt) {
		c.Incompatible = false
		s.Contact, s.ScheduledAt, s.ObservedAt = c, scheduled, &received
	}
}

func (s *UpdateStatus) Fail(reason string, now time.Time) {
	s.State, s.Reason, s.RetryAt = "failed", reason, nil
	switch reason {
	case "archive_unavailable", "download_failed", "staging_failed", "target_changed":
		backoff := min(60*time.Minute, 5*time.Minute<<min(max(0, s.Attempt-1), 4))
		retry := now.Add(backoff)
		s.RetryAt = &retry
	}
}

func ValidUpdateFailure(reason string) bool {
	switch reason {
	case "archive_unavailable", "download_failed", "archive_digest_mismatch", "archive_invalid", "staging_failed",
		"candidate_incompatible", "activation_failed", "target_changed":
		return true
	}
	return false
}
