package service

import (
	"context"
	"crypto/subtle"
	"errors"
	"io/fs"
	"log/slog"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/media"
)

type MediaPoll struct {
	MediaStatus
	RetryAfterSeconds int  `json:"retry_after_seconds,omitempty"`
	Expired           bool `json:"-"`
}

func shareableMedia(profile string) bool {
	switch profile {
	case media.PromptVideoProfile, media.ImageVideoProfile, media.PromptWAVProfile:
		return true
	}
	return false
}

func (b *Broker) PollMedia(ctx context.Context, l *slog.Logger, owner, id, kind string) (MediaPoll, string, error) {
	if owner == "" {
		return MediaPoll{}, "", inference.Reject("model_client_required", 401)
	}
	var token string
	var expired bool
	status, err := b.inspectMedia(ctx, l, owner, id, "media_poll", func(s *inference.State, j *inference.Job, events *[]inferenceEvent) error {
		m := j.Media
		if kind != "" && (!shareableMedia(m.Profile) || media.OutputType(m.Profile) != kind) {
			return inference.Reject("media_not_found", 404, "observed_profile", m.Profile, "expected_type", kind)
		}
		if m.Artifact == nil || m.ExpiresAt == nil {
			return nil
		}
		expired = !s.Now.Before(*m.ExpiresAt)
		if expired || !shareableMedia(m.Profile) {
			return nil
		}
		file, err := b.Media.Open(id, "artifact")
		if err != nil {
			return missingArtifact(err)
		}
		if err = file.Close(); err != nil {
			return err
		}
		token, err = b.downloadToken(id)
		if err != nil {
			return missingArtifact(err)
		}
		expired = !b.now().Before(*m.ExpiresAt)
		if expired {
			token = ""
			return nil
		}
		event(events, slog.LevelInfo, "media.link_ready", s, j, "client_id", owner, "profile", m.Profile,
			"expires_at", m.ExpiresAt, "outcome", "available")
		return nil
	})
	poll := MediaPoll{MediaStatus: status, Expired: expired}
	if status.State == "queued" || status.State == "inference" {
		poll.RetryAfterSeconds = 60
	}
	return poll, token, err
}

func (b *Broker) downloadToken(id string) (string, error) {
	token, err := b.Media.ReadDownloadToken(id)
	if errors.Is(err, fs.ErrNotExist) {
		token, err = auth.Token(auth.DownloadPrefix, b.random)
		if err != nil {
			return "", errors.New("media_download_token_generation_failed")
		}
		err = b.Media.WriteDownloadToken(id, token)
	}
	if err == nil && !auth.ValidToken(token, auth.DownloadPrefix) {
		return "", errors.New("media_download_token_corrupt")
	}
	return token, err
}

func missingArtifact(err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return inference.Reject("artifact_missing", 404)
	}
	return err
}

func (b *Broker) ReadSharedMedia(ctx context.Context, l *slog.Logger, id, token string) (MediaStatus, fs.File, error) {
	if !auth.ValidToken(token, auth.DownloadPrefix) {
		return MediaStatus{}, nil, inference.Reject("download_link_invalid", 404)
	}
	issued, err := b.Media.ReadDownloadToken(id)
	if errors.Is(err, fs.ErrNotExist) {
		return MediaStatus{}, nil, inference.Reject("download_link_missing", 404)
	}
	if err != nil {
		return MediaStatus{}, nil, err
	}
	if !auth.ValidToken(issued, auth.DownloadPrefix) {
		return MediaStatus{}, nil, errors.New("media_download_token_corrupt")
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(issued)) != 1 {
		return MediaStatus{}, nil, inference.Reject("download_link_invalid", 404)
	}

	var file fs.File
	result, err := b.inspectMedia(ctx, l, "", id, "media_link_read", func(s *inference.State, j *inference.Job, events *[]inferenceEvent) error {
		m := j.Media
		if !shareableMedia(m.Profile) || m.Artifact == nil || m.ExpiresAt == nil {
			return inference.Reject("download_link_missing", 404)
		}
		if !b.now().Before(*m.ExpiresAt) {
			return inference.Reject("artifact_expired", 404)
		}
		var err error
		file, err = b.Media.Open(id, "artifact")
		if err != nil {
			return missingArtifact(err)
		}
		event(events, slog.LevelInfo, "media.link_opened", s, j, "client_id", m.Owner, "profile", m.Profile, "expires_at", m.ExpiresAt)
		return nil
	})
	return result, closeOnMediaError(file, err), err
}
