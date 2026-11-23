package httpapi

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/media"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

const (
	mediaJobs           = "/api/v1/media/jobs"
	mediaTrials         = "/api/v1/admin/media/trials"
	mediaJob            = mediaJobs + "/{id}"
	mediaArtifact       = mediaJob + "/artifact"
	sharedMedia         = "/downloads/{id}/{token}"
	sharedMediaPrefix   = "/downloads/"
	workerMedia         = "/api/v1/worker/jobs/{id}/media/"
	workerMediaArtifact = "/api/v1/worker/jobs/{id}/artifact"
)

func mediaRoute(path string) (string, string) {
	if tail, ok := strings.CutPrefix(path, sharedMediaPrefix); ok {
		id, _, _ := strings.Cut(tail, "/")
		if !workerIDPattern.MatchString(id) {
			return sharedMedia, ""
		}
		return sharedMedia, id
	}
	if path == mediaJobs || path == mediaTrials {
		return path, ""
	}
	for _, prefix := range []string{mediaJobs + "/", "/api/v1/worker/jobs/"} {
		tail, ok := strings.CutPrefix(path, prefix)
		if !ok {
			continue
		}
		id, action, _ := strings.Cut(tail, "/")
		if !workerIDPattern.MatchString(id) {
			break
		}
		if prefix == mediaJobs+"/" {
			if tail == id {
				return mediaJob, id
			}
			if action == "artifact" {
				return mediaArtifact, id
			}
		} else {
			switch action {
			case "artifact":
				return workerMediaArtifact, id
			case "media/prompt", "media/image", "media/receipt":
				return workerMedia + strings.TrimPrefix(action, "media/"), id
			}
		}
	}
	return "", ""
}
func isMediaRoute(route string) bool {
	return strings.HasPrefix(route, mediaJobs) || route == mediaTrials || route == sharedMedia || route == workerMediaArtifact || strings.HasPrefix(route, workerMedia)
}

type mediaRequest struct {
	Prompt         string          `json:"prompt"`
	Submission     string          `json:"submission_id"`
	Format         json.RawMessage `json:"format,omitempty"`
	TimeoutSeconds json.RawMessage `json:"timeout_seconds,omitempty"`
}
type trialRequest struct {
	FixtureHash string `json:"fixture_sha256,omitempty"`
	FixtureSize int64  `json:"fixture_bytes,omitempty"`
	Owner       string `json:"owner"`
	Worker      string `json:"worker_id"`
	Profile     string `json:"profile"`
	Submission  string `json:"submission_id"`
}

func boundedText(r io.Reader, n int64) (string, error) {
	b, err := io.ReadAll(io.LimitReader(r, n+1))
	if err != nil {
		return "", err
	}
	if int64(len(b)) > n {
		return "", inference.Reject("media_too_large", 413)
	}
	if !utf8.Valid(b) {
		return "", inference.Reject("invalid_utf8", 400)
	}
	return string(b), nil
}

func readMediaRequest(ctx context.Context, r *http.Request, store *media.Store, stage *media.Stage) (mediaRequest, error) {
	var input mediaRequest
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return input, inference.Reject("unsupported_media_type", 415)
	}
	switch kind {
	case "application/json":
		data, err := boundedText(r.Body, 6*media.PromptLimit+1024)
		if err != nil {
			return input, err
		}
		if err = decodeInferenceInput([]byte(data), &input, "submission_id", "prompt"); err != nil {
			return input, inference.Reject("invalid_media_request", 400)
		}
		format := "mp4"
		if input.Format != nil && json.Unmarshal(input.Format, &format) != nil {
			return input, inference.Reject("unsupported_media_format", 400)
		}
		if string(input.Format) == "null" {
			return input, inference.Reject("unsupported_media_format", 400)
		}
		return input, stage.GeneratedPrompt(format, input.Prompt)
	case "multipart/form-data":
		reader, err := r.MultipartReader()
		if err != nil {
			return input, inference.Reject("invalid_multipart", 400)
		}
		seen := map[string]bool{}
		for {
			part, err := reader.NextPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return input, inference.Reject("invalid_multipart", 400)
			}
			name := part.FormName()
			if seen[name] {
				return input, inference.Reject("duplicate_media_field", 400)
			}
			seen[name] = true
			switch name {
			case "prompt":
				input.Prompt, err = boundedText(part, media.PromptLimit)
			case "submission_id":
				input.Submission, err = boundedText(part, 128)
			case "timeout_seconds":
				var timeout string
				timeout, err = boundedText(part, 32)
				input.TimeoutSeconds = json.RawMessage(timeout)
			case "image":
				buf := bufio.NewReader(part)
				head, readErr := buf.Peek(512)
				if readErr != nil && !errors.Is(readErr, io.EOF) {
					return input, readErr
				}
				actual := http.DetectContentType(head)
				declared := part.Header.Get("Content-Type")
				if declared != "" && declared != "application/octet-stream" && declared != actual {
					return input, inference.Reject("image_type_mismatch", 415)
				}
				err = store.Image(ctx, stage, buf, actual)
			default:
				return input, inference.Reject("unexpected_media_field", 400)
			}
			if err != nil {
				return input, err
			}
		}
		if !seen["image"] {
			return input, inference.Reject("reference_image_required", 400)
		}
		stage.Record.Profile = media.ImageVideoProfile
	default:
		return input, inference.Reject("unsupported_media_type", 415)
	}
	return input, stage.Prompt(input.Prompt)
}

func (h *Handler) serveMedia(w *response, r *http.Request, l *slog.Logger, route, id, owner, worker string) {
	if h.Broker == nil || h.Broker.Media == nil {
		inferenceError(w, errors.New("media_store_unavailable"))
		return
	}
	select {
	case <-h.Failed:
		inferenceError(w, errors.New("diagnostics_unavailable"))
		return
	default:
	}
	if route != sharedMedia && (r.URL.RawQuery != "" || r.Method == "GET" && (r.ContentLength != 0 || len(r.TransferEncoding) > 0)) {
		inferenceError(w, inference.Reject("unexpected_media_input", 400))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), media.TransferTimeout)
	defer cancel()
	deadline := time.Now().Add(media.TransferTimeout)
	controller := http.NewResponseController(w)
	for _, set := range []func(time.Time) error{controller.SetReadDeadline, controller.SetWriteDeadline} {
		if err := set(deadline); err != nil && !errors.Is(err, http.ErrNotSupported) {
			inferenceError(w, err)
			return
		}
	}
	l = l.With("client_id", owner, "worker_id", worker)
	if id != "" {
		l = l.With("job_id", id, "operation_id", id)
	}
	var err error
	switch route {
	case mediaJobs, mediaTrials:
		err = h.submitMedia(w, r, ctx, l, route, owner)
	case mediaJob:
		var status mediaPollResult
		status, err = h.pollMedia(ctx, l, owner, id, r.Host, "")
		if err == nil {
			writeJSON(w, 200, status)
		}
	case mediaArtifact:
		var status service.MediaStatus
		var f fs.File
		status, f, err = h.Broker.ReadMedia(ctx, l, owner, id, true)
		if err == nil {
			err = sendFile(w, f, status.Artifact.MediaType, status.Artifact.Size)
		}
	case sharedMedia:
		err = h.serveSharedMedia(ctx, l, w, r, id)
	case workerMediaArtifact, workerMedia + "image", workerMedia + "prompt", workerMedia + "receipt":
		var f service.MediaFence
		f.Connection = r.Header.Get("X-Muse-Connection-Id")
		f.Lease = r.Header.Get("X-Muse-Lease-Id")
		f.Generation, _ = strconv.ParseInt(r.Header.Get("X-Muse-Generation"), 10, 64)
		f.ConnectionGeneration, _ = strconv.ParseInt(r.Header.Get("X-Muse-Connection-Generation"), 10, 64)
		if route == workerMediaArtifact {
			err = h.uploadMedia(w, r, ctx, l, worker, id, f)
		} else if route == workerMedia+"receipt" {
			size, _ := strconv.ParseInt(r.Header.Get("X-Muse-Artifact-Size"), 10, 64)
			var hash string
			hash, err = artifactIdentity(r, size)
			if err == nil {
				var receipt service.ArtifactReceipt
				_, receipt, err = h.Broker.MediaUpload(ctx, l, worker, id, f, hash, size, nil)
				if err == nil {
					writeJSON(w, 200, receipt)
				}
			}
		} else {
			var file fs.File
			var kind string
			file, kind, err = h.Broker.MediaInput(ctx, l, worker, id, strings.TrimPrefix(route, workerMedia), f)
			if err == nil {
				err = sendFile(w, file, kind, -1)
			}
		}
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			err = inference.Reject("media_too_large", 413)
		}
		var rejected *inference.Rejection
		if errors.As(err, &rejected) {
			level := slog.LevelWarn
			if rejected.Code >= 500 || rejected.Reason == "artifact_transfer_interrupted" {
				level = slog.LevelError
			}
			l.Log(ctx, level, "media.rejected", "cause", rejected.Reason, "evidence", rejected.Fields, "outcome", "rejected")
		} else {
			l.Error("media.operation_failed", "cause", err.Error(), "route", route)
		}
		if w.code == 0 {
			inferenceError(w, err)
		}
	}
}

func sendFile(w *response, file fs.File, kind string, size int64) error {
	defer file.Close()
	if size < 0 {
		stat, err := file.Stat()
		if err != nil {
			return err
		}
		size = stat.Size()
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, err := io.CopyN(w, file, size)
	return err
}

func (h *Handler) submitMedia(w *response, r *http.Request, ctx context.Context, l *slog.Logger, route, owner string) error {
	stage, err := h.Broker.Media.Begin()
	if err != nil {
		return err
	}
	defer service.CloseMediaStage(l, stage)
	var submission, target string
	var timeout json.RawMessage
	if route == mediaTrials {
		data, err := boundedText(r.Body, 2048)
		if err != nil {
			return err
		}
		var trial trialRequest
		if decodeInferenceInput([]byte(data), &trial, "owner", "worker_id", "profile", "submission_id") != nil || !h.Authority.HasClient(trial.Owner) || !workerIDPattern.MatchString(trial.Worker) || !media.AudioTrial(trial.Profile) {
			return inference.Reject("invalid_audio_trial", 400)
		}
		stage.Record.InputSize, stage.Record.InputHash, err = media.TrialFixture(trial.Profile, trial.FixtureSize, trial.FixtureHash)
		if err != nil {
			return err
		}
		owner, target, submission, stage.Record.Profile = trial.Owner, trial.Worker, trial.Submission, trial.Profile
	} else {
		r.Body = http.MaxBytesReader(w, r.Body, media.ImageLimit+(64<<10))
		input, err := readMediaRequest(ctx, r, h.Broker.Media, stage)
		if err != nil {
			return err
		}
		submission, timeout = input.Submission, input.TimeoutSeconds
	}
	reply, err := h.Broker.SubmitMedia(ctx, l, stage, owner, submission, target, timeout)
	if err == nil {
		writeJSON(w, 202, reply)
	}
	return err
}

func artifactIdentity(r *http.Request, size int64) (string, error) {
	hash := r.Header.Get("X-Muse-Artifact-Sha256")
	value, err := hex.DecodeString(hash)
	if err != nil || len(value) != 32 || strings.ToLower(hash) != hash {
		return "", inference.Reject("invalid_artifact_digest", 400)
	}
	if size <= 0 {
		return "", inference.Reject("content_length_required", 411)
	}
	if size > media.ArtifactLimit {
		return "", inference.Reject("media_too_large", 413)
	}
	return hash, nil
}

func (h *Handler) uploadMedia(w *response, r *http.Request, ctx context.Context, l *slog.Logger, worker, id string, f service.MediaFence) error {
	size := r.ContentLength
	hash, err := artifactIdentity(r, size)
	if err != nil {
		return err
	}
	profile, receipt, err := h.Broker.MediaUpload(ctx, l, worker, id, f, hash, size, nil)
	if err != nil {
		return err
	}
	if r.Header.Get("Content-Type") != media.OutputType(profile) {
		return inference.Reject("invalid_artifact_type", 415)
	}
	if !receipt.Accepted {
		u, err := h.Broker.Media.Receive(ctx, id, profile, hash, size, r.Body)
		if err != nil {
			return err
		}
		defer func() {
			if e := u.Close(); e != nil {
				l.Error("media.cleanup_failed", "stage", "upload", "cause", e.Error())
			}
		}()
		_, receipt, err = h.Broker.MediaUpload(ctx, l, worker, id, f, hash, size, u)
		if err != nil {
			return err
		}
	}
	writeJSON(w, 200, receipt)
	return nil
}
