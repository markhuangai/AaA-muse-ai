package service

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/media"
)

func TestMediaReceiptAndOwnership(t *testing.T) {
	b, m, logger, log := inferenceFixture()
	ctx := context.Background()
	b.Media = media.New(t.TempDir())
	wid := "worker-a"
	c := connectInference(t, b, m, logger, wid)
	ready, tool := qualificationTrials(t, b, m, logger, wid, c)
	if _, err := b.Qualify(ctx, logger, wid, approvalInput("qualify-media", ready, tool)); err != nil {
		t.Fatal(err)
	}
	makeStage := func(message string) *media.Stage {
		p, err := b.Media.Begin()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { p.Close() })
		if err = p.Prompt(message); err != nil {
			t.Fatal(err)
		}
		p.Record.Profile = "prompt_video"
		return p
	}
	message := "private request text with distinctive sentinel"
	_, err := b.SubmitMedia(ctx, logger, makeStage(message), "alice", "create-media", "")
	requireInferenceReason(t, err, "no_ready_worker")
	m.states[wid].Connection.MediaJobs = true
	data, err := b.SubmitMedia(ctx, logger, makeStage(message), "alice", "create-media", "")
	status := decodeResult[MediaStatus](t, data, err)
	if status.DeadlineAt.Sub(status.CreatedAt) != 15*time.Minute {
		t.Fatal(status)
	}
	data, err = b.SubmitMedia(ctx, logger, makeStage(message), "alice", "create-media", "")
	if decodeResult[MediaStatus](t, data, err).ID != status.ID {
		t.Fatal("retry duplicated job")
	}
	_, err = b.SubmitMedia(ctx, logger, makeStage("changed"), "alice", "create-media", "")
	requireInferenceReason(t, err, "submission_conflict")
	_, _, err = b.ReadMedia(ctx, logger, "bob", status.ID, false)
	requireInferenceReason(t, err, "media_not_found")
	_, _, err = b.ReadMedia(ctx, logger, "alice", status.ID, true)
	requireInferenceReason(t, err, "artifact_not_ready")
	data, err = b.Claim(ctx, logger, wid, status.ID, inference.Claim{Version: 1, ConnectionID: c.ID, ConnectionGeneration: c.Generation, SubmissionID: "media-claim"})
	j := decodeResult[inference.Job](t, data, err)
	f := MediaFence{j.ConnectionID, j.ConnectionGeneration, j.Generation, j.LeaseID}
	file, kind, err := b.MediaInput(ctx, logger, wid, j.ID, "prompt", f)
	if err != nil || !strings.HasPrefix(kind, "text/plain") {
		t.Fatal(err)
	}
	content, _ := io.ReadAll(file)
	file.Close()
	if string(content) != message {
		t.Fatal("prompt changed")
	}
	_, _, err = b.MediaInput(ctx, logger, wid, j.ID, "image", f)
	requireInferenceReason(t, err, "media_input_not_found")
	_, _, err = b.MediaInput(ctx, logger, "worker-b", j.ID, "prompt", f)
	requireInferenceReason(t, err, "worker_scope_denied")
	stale := f
	stale.Generation++
	_, _, err = b.MediaUpload(ctx, logger, wid, j.ID, stale, "x", 5, nil)
	requireInferenceReason(t, err, "stale_assignment")
	_, err = b.Decide(ctx, logger, wid, j.ID, inference.Submit{Claim: inference.Claim{Version: 1, SubmissionID: "text-on-media"}})
	requireInferenceReason(t, err, "media_upload_required")
	b.Media.Inspect = func(_ context.Context, path, kind string) (inference.MediaProperties, error) {
		if v, err := os.ReadFile(path); err != nil || string(v) != "bytes" {
			t.Fatal(path, err)
		}
		return inference.MediaProperties{MediaType: kind, Duration: 1, VideoFrames: 1}, nil
	}
	const hash = "277089d91c0bdf4f2e6862ba7e4a07605119431f5d13f726dd352b06f1b206a9"
	_, check, err := b.MediaUpload(ctx, logger, wid, j.ID, f, hash, 5, nil)
	if err != nil || check.Accepted {
		t.Fatal(check, err)
	}
	u, err := b.Media.Receive(ctx, j.ID, "prompt_video", hash, 5, bytes.NewReader([]byte("bytes")))
	if err != nil {
		t.Fatal(err)
	}
	_, a, err := b.MediaUpload(ctx, logger, wid, j.ID, f, hash, 5, u)
	if err != nil || !a.Accepted {
		t.Fatal(a, err)
	}
	before := *a.ExpiresAt
	_, _, err = b.PollMedia(ctx, logger, "bob", j.ID, "video/mp4")
	requireInferenceReason(t, err, "media_not_found")
	_, _, err = b.PollMedia(ctx, logger, "alice", j.ID, "audio/wav")
	requireInferenceReason(t, err, "media_not_found")
	_, token, err := b.PollMedia(ctx, logger, "alice", j.ID, "video/mp4")
	if err != nil || token == "" {
		t.Fatal("owning poll did not issue a link", err)
	}
	if info, err := os.Stat(filepath.Join(b.Media.Dir, j.ID, "download-token")); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("shared grant permissions changed", err)
	}
	_, tokenAgain, err := b.PollMedia(ctx, logger, "alice", j.ID, "video/mp4")
	if err != nil || token != tokenAgain {
		t.Fatal("repeated owning poll rotated a live link", err)
	}
	_, file, err = b.ReadSharedMedia(ctx, logger, j.ID, token)
	if err != nil {
		t.Fatal(err)
	}
	original, err := io.ReadAll(file)
	file.Close()
	if err != nil || string(original) != "bytes" {
		t.Fatal("anonymous read did not return the original", err)
	}
	_, _, err = b.ReadSharedMedia(ctx, logger, j.ID, "wrong")
	requireInferenceReason(t, err, "download_link_invalid")
	m.now = m.now.Add(time.Minute)
	_, a, err = b.MediaUpload(ctx, logger, wid, j.ID, f, hash, 5, nil)
	if err != nil || !a.ExpiresAt.Equal(before) {
		t.Fatal("receipt replay", err)
	}
	_, _, err = b.MediaUpload(ctx, logger, wid, j.ID, f, "other", 5, nil)
	requireInferenceReason(t, err, "artifact_conflict")
	_, file, err = b.ReadMedia(ctx, logger, "alice", j.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(file)
	file.Close()
	if string(body) != "bytes" {
		t.Fatal("incorrect artifact")
	}
	m.now = before
	_, _, err = b.ReadSharedMedia(ctx, logger, j.ID, token)
	requireInferenceReason(t, err, "artifact_expired")
	if _, err = os.Stat(filepath.Join(b.Media.Dir, j.ID, "artifact")); err != nil {
		t.Fatal("expiry test no longer has the original on disk", err)
	}
	_, _, err = b.ReadMedia(ctx, logger, "alice", j.ID, true)
	requireInferenceReason(t, err, "artifact_expired")
	if _, err = os.Stat(filepath.Join(b.Media.Dir, j.ID, "prompt")); !os.IsNotExist(err) {
		t.Fatal("retained motion text")
	}
	if strings.Contains(log.String(), message) || strings.Contains(log.String(), token) || !strings.Contains(log.String(), "media.committed") {
		t.Fatal("incorrect diagnostic capture")
	}
}
