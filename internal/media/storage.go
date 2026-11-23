package media

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

const (
	PromptVideoProfile = "prompt_video"
	ImageVideoProfile  = "image_video"
	PromptWAVProfile   = "prompt_wav"

	ImageLimit      = 8 << 20
	PromptLimit     = 4 << 10
	ArtifactLimit   = 32 << 20
	PixelLimit      = 16_000_000
	Lifetime        = 10 * time.Minute
	OrphanGrace     = 15 * time.Minute
	TransferTimeout = 120 * time.Second
)

type Store struct {
	Dir     string
	Inspect func(context.Context, string, string) (inference.MediaProperties, error)
	files   fileOps
	run     func(context.Context, string, []string, io.Writer) error
}

func New(dir string) *Store {
	s := &Store{Dir: dir, files: localFiles(), run: runProcess}
	s.Inspect = s.inspect
	return s
}

const namespaceMarker = ".aaa-muse-media-v1"

var ErrFreshNamespace = errors.New("fresh_media_namespace_required")

func (s *Store) PrepareNamespace() error {
	return s.prepareNamespace(true)
}

func (s *Store) prepareNamespace(create bool) error {
	entries, err := s.files.readDir(s.Dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != namespaceMarker {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode() != 0600 || info.Size() != 0 {
			return ErrFreshNamespace
		}
		return nil
	}
	if len(entries) != 0 || !create {
		return ErrFreshNamespace
	}
	marker, err := s.files.openFile(filepath.Join(s.Dir, namespaceMarker), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return s.prepareNamespace(false)
	}
	if err != nil {
		return err
	}
	if err = errors.Join(marker.Sync(), marker.Close()); err != nil {
		return err
	}
	return s.files.syncDir(s.Dir)
}

type Stage struct {
	Path   string
	Record inference.Media
	files  *fileOps
}

func (s *Store) Begin() (*Stage, error) {
	dir, err := s.files.mkdirTemp(s.Dir, ".incoming-")
	if err != nil {
		return nil, err
	}
	return &Stage{Path: dir, files: &s.files}, nil
}

func (p *Stage) Close() error {
	if p.Path == "" {
		return nil
	}
	return p.files.removeAll(p.Path)
}

func (p *Stage) Install(root, id string) error {
	if err := p.files.syncDir(p.Path); err != nil {
		return err
	}
	if err := p.files.rename(p.Path, filepath.Join(root, id)); err != nil {
		return err
	}
	p.Path = ""
	return p.files.syncDir(root)
}

func writeBounded(dst stagedFile, input io.Reader, limit int64) (int64, string, error) {
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(dst, h), io.LimitReader(input, limit+1))
	if err == nil && n > limit {
		err = inference.Reject("media_too_large", 413)
	}
	if err == nil && n == 0 {
		err = inference.Reject("empty_media", 400)
	}
	if err == nil {
		err = dst.Sync()
	}
	closeErr := dst.Close()
	if err == nil {
		err = closeErr
	}
	return n, hex.EncodeToString(h.Sum(nil)), err
}

func (p *Stage) GeneratedPrompt(format, value string) error {
	switch format {
	case "mp4":
		p.Record.Profile = PromptVideoProfile
	case "wav":
		p.Record.Profile = PromptWAVProfile
	default:
		return inference.Reject("unsupported_media_format", 400)
	}
	return p.Prompt(value)
}

func (p *Stage) Prompt(value string) error {
	if len(value) > PromptLimit {
		return inference.Reject("prompt_too_large", 413)
	}
	if !utf8.ValidString(value) || strings.TrimSpace(value) == "" {
		return inference.Reject("invalid_media_prompt", 400)
	}
	f, err := p.files.openFile(filepath.Join(p.Path, "prompt"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, p.Record.PromptHash, err = writeBounded(f, strings.NewReader(value), PromptLimit)
	return err
}

func (s *Store) Image(ctx context.Context, p *Stage, input io.Reader, kind string) error {
	switch kind {
	case "image/webp", "image/jpeg", "image/png":
	default:
		return inference.Reject("unsupported_reference_type", 415)
	}
	name := filepath.Join(p.Path, "image")
	f, err := s.files.openFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	p.Record.InputSize, p.Record.InputHash, err = writeBounded(f, input, ImageLimit)
	if err != nil {
		return err
	}
	if _, err = s.Inspect(ctx, name, kind); err != nil {
		return err
	}
	p.Record.InputType = kind
	return nil
}

var audioFixtures = map[string]struct {
	kind, hash string
	size       int64
}{
	"native_mp3":  {"audio/mpeg", "e8e0df8438be8853b87e09835342c35e7acfda0d8d1c0b554dd76fef63eaba13", 19813},
	"offline_wav": {"audio/wav", "3bc8eb4d324ea225d2bb0d18f1faa09676e39d63e1d04404505eff12c8b6917d", 89998},
}

func TrialFixture(profile string, size int64, hash string) (int64, string, error) {
	f, ok := audioFixtures[profile]
	if !ok {
		return 0, "", inference.Reject("invalid_audio_trial", 400)
	}
	if size == 0 && hash == "" {
		return f.size, f.hash, nil
	}
	raw, err := hex.DecodeString(hash)
	if err != nil || len(raw) != sha256.Size || strings.ToLower(hash) != hash || size < 1 || size > ArtifactLimit {
		return 0, "", inference.Reject("invalid_trial_fixture", 400)
	}
	return size, hash, nil
}
func AudioTrial(profile string) bool { _, ok := audioFixtures[profile]; return ok }
func OutputType(profile string) string {
	if profile == PromptWAVProfile {
		return "audio/wav"
	}
	if fixture, ok := audioFixtures[profile]; ok {
		return fixture.kind
	}
	return "video/mp4"
}

type Upload struct {
	Path       string
	directory  string
	Properties inference.MediaProperties
	files      *fileOps
}

func (s *Store) Receive(ctx context.Context, id, profile, hash string, size int64, r io.Reader) (u *Upload, err error) {
	if size > ArtifactLimit {
		return nil, inference.Reject("media_too_large", 413)
	}
	if size <= 0 {
		return nil, inference.Reject("invalid_artifact_size", 400)
	}

	directory := filepath.Join(s.Dir, id)
	if _, err = s.files.stat(directory); err != nil {
		return nil, err
	}
	// A cancellation may clear the job directory while an authorized stream is still arriving.
	f, err := s.files.createTemp(s.Dir, ".upload-"+id+"-")
	if err != nil {
		return nil, err
	}
	n, actual, err := writeBounded(f, r, size)
	stage := "receive"
	defer func() {
		if err == nil {
			return
		}
		var rejected *inference.Rejection
		if !errors.As(err, &rejected) {
			code, reason := 503, "artifact_io_failed"
			if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				code, reason = 400, "artifact_transfer_interrupted"
			}
			rejected = &inference.Rejection{Reason: reason, Code: code, Fields: map[string]any{"io_cause": err.Error()}}
		}
		rejected.Fields["stage"] = stage
		rejected.Fields["expected_bytes"], rejected.Fields["observed_bytes"] = size, n
		rejected.Fields["expected_sha256"], rejected.Fields["observed_sha256"] = hash, actual
		rejected.Fields["partial_cleanup"] = "removed"
		if cleanupErr := s.files.remove(f.Name()); cleanupErr != nil && !errors.Is(cleanupErr, os.ErrNotExist) {
			rejected.Fields["partial_cleanup"] = "failed"
			rejected.Fields["cleanup_cause"] = cleanupErr.Error()
		}
		err = rejected
	}()
	if err != nil {
		return nil, err
	}
	if n != size || actual != hash {
		return nil, inference.Reject("artifact_digest_mismatch", 422)
	}
	stage = "inspect"
	props, err := s.Inspect(ctx, f.Name(), OutputType(profile))
	if err != nil {
		return nil, err
	}
	props.Size, props.SHA256, props.MediaType = n, actual, OutputType(profile)
	return &Upload{Path: f.Name(), directory: directory, Properties: props, files: &s.files}, nil
}

func (u *Upload) Close() error {
	err := u.files.remove(u.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (u *Upload) Commit() error {
	dir := u.directory
	if err := u.files.rename(u.Path, filepath.Join(dir, "artifact")); err != nil {
		return err
	}
	return u.files.syncDir(dir)
}

func (s *Store) Open(id, name string) (fs.File, error) {
	if !jobDir.MatchString(id) || (name != "artifact" && name != "image" && name != "prompt" && name != downloadTokenFile) {
		return nil, os.ErrInvalid
	}
	return s.files.openJob(s.Dir, id, name)
}

func openJob(dir, id, name string) (fs.File, error) {
	job, err := openJobRoot(dir, id)
	if err != nil {
		return nil, err
	}
	defer job.Close()
	return job.Open(name)
}

func openJobRoot(dir, id string) (*os.Root, error) {
	volume, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer volume.Close()
	job, err := volume.OpenRoot(id)
	if err != nil {
		return nil, err
	}

	// A directory alias inside the shared volume must not select a different owner's job.
	entry, err := volume.Lstat(id)
	if err != nil {
		job.Close()
		return nil, err
	}
	opened, err := job.Stat(".")
	if err != nil {
		job.Close()
		return nil, err
	}
	if !os.SameFile(entry, opened) {
		job.Close()
		return nil, os.ErrInvalid
	}
	return job, nil
}
func (s *Store) ClearInputs(id string) error {
	for _, name := range []string{"image", "prompt"} {
		err := s.files.remove(filepath.Join(s.Dir, id, name))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
