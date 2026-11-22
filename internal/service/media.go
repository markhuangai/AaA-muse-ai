package service

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/media"
)

type MediaStatus struct {
	ID          string                     `json:"job_id"`
	State       string                     `json:"status"`
	Profile     string                     `json:"profile"`
	CreatedAt   time.Time                  `json:"created_at"`
	DeadlineAt  time.Time                  `json:"deadline_at"`
	CommittedAt *time.Time                 `json:"committed_at,omitempty"`
	ExpiresAt   *time.Time                 `json:"expires_at,omitempty"`
	Artifact    *inference.MediaProperties `json:"artifact,omitempty"`
	Reason      string                     `json:"reason,omitempty"`
}

func mediaStatus(e *inference.Experiment, j *inference.Job) MediaStatus {
	return MediaStatus{ID: j.ID, State: e.State, Profile: j.Media.Profile, CreatedAt: e.CreatedAt, DeadlineAt: e.DeadlineAt, CommittedAt: j.Media.CommittedAt, ExpiresAt: j.Media.ExpiresAt, Artifact: j.Media.Artifact, Reason: e.Reason}
}

func mediaCapability(profile string) string {
	if profile == media.PromptWAVProfile {
		return "prompt_wav"
	}
	return "media_jobs"
}

func supportsMedia(connection inference.Connection, profile string) bool {
	return connection.MediaJobs && (profile != media.PromptWAVProfile || connection.PromptWAV)
}

func (b *Broker) SubmitPromptMedia(ctx context.Context, l *slog.Logger, owner, submission, format, prompt string) (json.RawMessage, error) {
	stage, err := b.Media.Begin()
	if err != nil {
		return nil, err
	}
	defer CloseMediaStage(l, stage)
	if err = stage.GeneratedPrompt(format, prompt); err != nil {
		return nil, err
	}
	return b.SubmitMedia(ctx, l, stage, owner, submission, "")
}

func CloseMediaStage(l *slog.Logger, stage *media.Stage) {
	if err := stage.Close(); err != nil {
		l.Error("media.cleanup_failed", "stage", "admission", "cause", err.Error())
	}
}

func (b *Broker) SubmitMedia(ctx context.Context, l *slog.Logger, p *media.Stage, owner, submission, target string) (json.RawMessage, error) {
	if err := inference.VersionAndID(1, submission); err != nil {
		return nil, err
	}
	p.Record.Owner = owner
	input := struct {
		Record inference.Media
		Target string
	}{p.Record, target}
	ref := inference.Ref{Routing: true, Full: true, Principal: "media:" + owner, SubmissionID: submission}
	if media.AudioTrial(p.Record.Profile) {
		ref.Principal = "media-trial:" + owner
	}
	return b.run(ctx, l, ref, "media_create", input, func(s *inference.State, ev *[]inferenceEvent) (any, error) {
		if err := validQueueTarget(s, target); err != nil {
			return nil, err
		}
		id, err := auth.ID(b.random)
		if err != nil {
			return nil, err
		}
		hash, err := contextHash([]inference.Item{}, []inference.Tool{})
		if err != nil {
			return nil, err
		}
		e := &inference.Experiment{ID: id, ConversationID: id, WorkerID: target, State: "queued", CurrentJobID: id, CreatedAt: s.Now, DeadlineAt: s.Now.Add(media.JobTimeout), RemoteOutcome: "not_started"}
		j := &inference.Job{ID: id, Version: 1, WorkerID: e.WorkerID, ExperimentID: id, ConversationID: id, State: "queued", CreatedAt: s.Now, DeadlineAt: e.DeadlineAt, Media: &p.Record, Context: inference.Delivery{Kind: "full", ReceiptID: id, CanonicalSHA256: hash, Messages: []inference.Item{}, Tools: []inference.Tool{}}}
		if err = p.Install(b.Media.Dir, id); err != nil {
			return nil, err
		}
		s.Experiments[id], s.Jobs[id] = e, j
		event(ev, slog.LevelInfo, "media.submitted", s, j, "client_id", owner, "profile", j.Media.Profile, "input_bytes", j.Media.InputSize, "input_sha256", j.Media.InputHash, "prompt_sha256", j.Media.PromptHash)
		return mediaStatus(e, j), nil
	})
}

type MediaFence struct {
	Connection           string `json:"connection_id"`
	ConnectionGeneration int64  `json:"connection_generation"`
	Generation           int64  `json:"generation"`
	Lease                string `json:"lease_id"`
}

func mediaAssignment(s *inference.State, id string, f MediaFence, allowReceipt bool) (*inference.Job, error) {
	j := s.Jobs[id]
	if j == nil || j.Media == nil {
		return nil, inference.Reject("media_not_found", 404)
	}
	if j.ConnectionID != f.Connection || j.ConnectionGeneration != f.ConnectionGeneration || j.Generation != f.Generation || j.LeaseID != f.Lease || f.Lease == "" {
		return nil, inference.Reject("stale_assignment", 409, "expected_state", "claimed", "observed_state", j.State, "busy_hold", j.Held, "expected_generation", j.Generation, "observed_generation", f.Generation)
	}
	if allowReceipt && j.Media.Artifact != nil {
		return j, nil
	}
	if nativeClaim(j) {
		if j.StartedAt == nil || j.State != "claimed" || !j.Held || !s.Now.Before(j.DeadlineAt) {
			return nil, inference.Reject("stale_assignment", 409, "expected_state", "claimed", "observed_state", j.State,
				"busy_hold", j.Held, "claim_id", j.LeaseID, "deadline_at", j.DeadlineAt, "started_at", j.StartedAt)
		}
		return j, nil
	}
	if err := assignmentConnection(s, j, f.Connection, f.ConnectionGeneration, f.Generation); err != nil {
		return nil, err
	}
	if j.State != "claimed" || !j.Held || j.LeaseExpiresAt == nil || !s.Now.Before(*j.LeaseExpiresAt) || !s.Now.Before(j.DeadlineAt) {
		return nil, inference.Reject("stale_assignment", 409, "expected_state", "claimed", "observed_state", j.State, "busy_hold", j.Held, "expected_generation", j.Generation, "observed_generation", f.Generation)
	}
	if s.Connection.Status(s.Now) != "online" {
		return nil, inference.Reject("stale_assignment", 409)
	}
	if err := jobEligibility(s, j); err != nil {
		return nil, err
	}
	return j, nil
}

func (b *Broker) inspectMedia(ctx context.Context, l *slog.Logger, owner, id, operation string, inspect func(*inference.State, *inference.Job, *[]inferenceEvent) error) (MediaStatus, error) {
	var result MediaStatus
	principal := "media:" + owner
	if owner == "" {
		principal = "media:link"
	}
	_, err := b.run(ctx, l, inference.Ref{JobID: id, Principal: principal}, operation, nil, func(s *inference.State, events *[]inferenceEvent) (any, error) {
		j := s.Jobs[id]
		if j == nil || j.Media == nil || (owner != "" && j.Media.Owner != owner) {
			return nil, inference.Reject("media_not_found", 404)
		}
		result = mediaStatus(s.Experiments[j.ExperimentID], j)
		return result, inspect(s, j, events)
	})
	return result, err
}

// Open the authorized file inside the transaction so cleanup cannot change which file a successful request reads.
func (b *Broker) ReadMedia(ctx context.Context, l *slog.Logger, owner, id string, download bool) (MediaStatus, fs.File, error) {
	if owner == "" {
		return MediaStatus{}, nil, inference.Reject("model_client_required", 401)
	}
	var file fs.File
	result, err := b.inspectMedia(ctx, l, owner, id, "media_read", func(s *inference.State, j *inference.Job, _ *[]inferenceEvent) error {
		if !download {
			return nil
		}
		if j.Media.ExpiresAt == nil {
			return inference.Reject("artifact_not_ready", 409)
		}
		if !s.Now.Before(*j.Media.ExpiresAt) {
			return inference.Reject("artifact_expired", 410)
		}
		var err error
		file, err = b.Media.Open(id, "artifact")
		return err
	})
	return result, closeOnMediaError(file, err), err
}

func closeOnMediaError(file fs.File, err error) fs.File {
	if err != nil && file != nil {
		file.Close()
		return nil
	}
	return file
}

func (b *Broker) MediaInput(ctx context.Context, l *slog.Logger, worker, id, name string, f MediaFence) (fs.File, string, error) {
	var file fs.File
	kind := "text/plain; charset=utf-8"
	_, err := b.run(ctx, l, workerRef(worker, id, "", false), "media_input", f, func(s *inference.State, _ *[]inferenceEvent) (any, error) {
		j, err := mediaAssignment(s, id, f, false)
		if err != nil {
			return nil, err
		}
		if name == "image" {
			kind = j.Media.InputType
		}
		if kind == "" || media.AudioTrial(j.Media.Profile) {
			return nil, inference.Reject("media_input_not_found", 404)
		}
		file, err = b.Media.Open(id, name)
		return nil, err
	})
	if err != nil && file != nil {
		file.Close()
		file = nil
	}
	return file, kind, err
}

type ArtifactReceipt struct {
	JobID     string     `json:"job_id"`
	SHA256    string     `json:"sha256"`
	Size      int64      `json:"size"`
	Accepted  bool       `json:"accepted"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

func (b *Broker) MediaUpload(ctx context.Context, l *slog.Logger, worker, id string, f MediaFence, hash string, size int64, u *media.Upload) (string, ArtifactReceipt, error) {
	var profile string
	var receipt ArtifactReceipt
	_, err := b.run(ctx, l, workerRef(worker, id, "", false), "media_upload", map[string]any{"assignment": f, "sha256": hash, "bytes": size}, func(s *inference.State, ev *[]inferenceEvent) (any, error) {
		j, err := mediaAssignment(s, id, f, true)
		if err != nil {
			return nil, err
		}
		m := j.Media
		profile = m.Profile
		if media.AudioTrial(profile) && (hash != m.InputHash || size != m.InputSize) {
			return nil, inference.Reject("trial_fixture_mismatch", 422)
		}
		if m.Artifact != nil {
			if m.Artifact.SHA256 != hash || m.Artifact.Size != size {
				return nil, inference.Reject("artifact_conflict", 409)
			}
		} else if u != nil {
			if err = u.Commit(); err != nil {
				return nil, err
			}
			if s.DatabaseTime != nil {
				if s.Now, err = s.DatabaseTime(); err != nil {
					return nil, err
				}
				if _, err = mediaAssignment(s, id, f, false); err != nil {
					return nil, err
				}
			}
			expires := s.Now.Add(media.Lifetime)
			m.Artifact, m.CommittedAt, m.ExpiresAt = &u.Properties, &s.Now, &expires
			j.State, j.Held = "accepted", nativeClaim(j)
			e := s.Experiments[j.ExperimentID]
			e.State, e.RemoteOutcome = "completed", "artifact_observed"
			event(ev, slog.LevelInfo, "media.committed", s, j, "client_id", m.Owner, "artifact", u.Properties, "expires_at", expires)
		}
		receipt = ArtifactReceipt{id, hash, size, m.Artifact != nil, m.ExpiresAt}
		if nativeClaim(j) && receipt.Accepted && j.Outcome == nil {
			accepted, err := json.Marshal(receipt)
			if err != nil {
				return nil, err
			}
			j.Outcome = &inference.WorkOutcome{JobID: j.ID, ClaimID: j.LeaseID, State: j.State, Accepted: accepted}
		}
		return receipt, nil
	})
	if err == nil && receipt.Accepted {
		if cleanupErr := b.Media.ClearInputs(id); cleanupErr != nil {
			l.Error("media.cleanup_failed", "job_id", id, "stage", "inputs", "cause", cleanupErr.Error())
		}
	}
	return profile, receipt, err
}

func (b *Broker) CleanupMedia(ctx context.Context, l *slog.Logger) error {
	if b.Media == nil {
		return nil
	}
	repo, ok := b.repo.(interface {
		MediaCleanupStates(context.Context, []string) (map[string]string, error)
	})
	if !ok {
		return errors.New("media_cleanup_repository_unavailable")
	}
	return b.Media.Cleanup(ctx, l, b.now(), repo.MediaCleanupStates)
}
