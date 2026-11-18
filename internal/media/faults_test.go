package media

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func measuredProcess(_ context.Context, program string, args []string, out io.Writer) error {
	if program == "ffmpeg" {
		return nil
	}
	if program != "ffprobe" {
		return errors.New("unexpected program")
	}
	var report string
	switch {
	case slices.Contains(args, "mov"):
		report = `{"streams":[{"codec_type":"video","codec_name":"h264","width":64,"height":48,"avg_frame_rate":"8/1","nb_read_frames":"8"}],"format":{"duration":"1"}}`
	case slices.Contains(args, "mp3"), slices.Contains(args, "wav"):
		report = `{"streams":[{"codec_type":"audio","codec_name":"pcm_s16le"}],"format":{"duration":"1"}}`
	default:
		report = `{"streams":[{"codec_type":"video","codec_name":"png","width":8,"height":8,"nb_read_frames":"1"}]}`
	}
	_, err := io.WriteString(out, report)
	return err
}

func TestDecoderFailuresRemoveUnverifiedUploads(t *testing.T) {
	for _, tc := range []struct{ failure, reason, ioCause string }{
		{"missing", "artifact_io_failed", "media_decoder_unavailable"},
		{"deadline", "media_inspection_timeout", ""},
		{"interrupted", "media_decode_failed", ""},
	} {
		t.Run(tc.failure, func(t *testing.T) {
			s := New(t.TempDir())
			id := strings.Repeat("1", 32)
			if err := os.Mkdir(filepath.Join(s.Dir, id), 0700); err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			if tc.failure == "deadline" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithDeadline(ctx, time.Time{})
				defer cancel()
			}
			s.run = func(ctx context.Context, program string, args []string, out io.Writer) error {
				if tc.failure == "missing" {
					return &exec.Error{Name: program, Err: exec.ErrNotFound}
				}
				if ctx.Err() != nil {
					return ctx.Err()
				}
				if program == "ffmpeg" {
					return syscall.EINTR
				}
				return measuredProcess(ctx, program, args, out)
			}
			data := []byte("\x00\x00\x00\x18ftypisom000000000000")
			u, err := s.Receive(ctx, id, "prompt_video", hash(data), int64(len(data)), bytes.NewReader(data))
			var reject *inference.Rejection
			if u != nil || !errors.As(err, &reject) || reject.Reason != tc.reason {
				t.Fatalf("received %v, %v", u, err)
			}
			if reject.Fields["stage"] != "inspect" || reject.Fields["partial_cleanup"] != "removed" || reject.Fields["observed_sha256"] != hash(data) {
				t.Fatal(reject.Fields)
			}
			if tc.ioCause != "" && reject.Fields["io_cause"] != tc.ioCause {
				t.Fatal(reject.Fields)
			}
			entries, err := os.ReadDir(s.Dir)
			if err != nil || len(entries) != 1 || entries[0].Name() != id {
				t.Fatalf("unverified upload persisted: %v, %v", entries, err)
			}
			if _, err := s.Open(id, "artifact"); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("failed inspection published an artifact", err)
			}
		})
	}
}

func TestUploadCommitFailuresCanBeRetried(t *testing.T) {
	s := New(t.TempDir())
	s.run = measuredProcess
	id := strings.Repeat("2", 32)
	if err := os.Mkdir(filepath.Join(s.Dir, id), 0700); err != nil {
		t.Fatal(err)
	}
	data := []byte("\x00\x00\x00\x18ftypisom000000000000")
	receive := func() *Upload {
		t.Helper()
		u, err := s.Receive(context.Background(), id, "prompt_video", hash(data), int64(len(data)), bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	u := receive()
	ops := s.files
	s.files.rename = func(string, string) error { return syscall.ENOSPC }
	if err := u.Commit(); !errors.Is(err, syscall.ENOSPC) {
		t.Fatal(err)
	}
	if _, err := s.Open(id, "artifact"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed rename published an artifact", err)
	}
	if content, err := os.ReadFile(u.Path); err != nil || !bytes.Equal(content, data) {
		t.Fatal("failed rename lost staged bytes", err)
	}
	s.files.rename = ops.rename
	s.files.syncDir = func(string) error { return syscall.EIO }
	if err := u.Commit(); !errors.Is(err, syscall.EIO) {
		t.Fatal("unsynced rename reported durable acceptance", err)
	}
	if err := u.Close(); err != nil {
		t.Fatal(err)
	}
	s.files.syncDir = ops.syncDir
	retry := receive()
	if err := retry.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := retry.Close(); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(s.Dir, id, "artifact"))
	if err != nil || !bytes.Equal(content, data) {
		t.Fatal("retry changed the committed bytes", err)
	}
}
