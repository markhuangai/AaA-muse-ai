package media

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func TestHeaderFailuresRemoveUnverifiedUploads(t *testing.T) {
	for _, tc := range []struct{ failure, block, reason string }{
		{"bad_header", "media that has no MP4 signature", "invalid_media_format"},
		{"wrong_format", "RIFF\x00\x00\x00\x00WAVEtrailing", "invalid_media_format"},
		{"interrupted", "\x00\x00\x00\x18ftypisom000000000000", "artifact_transfer_interrupted"},
		{"read", "\x00\x00\x00\x18ftypisom000000000000", "artifact_io_failed"},
	} {
		t.Run(tc.failure, func(t *testing.T) {
			s := New(t.TempDir())
			id := strings.Repeat("1", 32)
			if err := os.Mkdir(filepath.Join(s.Dir, id), 0700); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if tc.failure == "interrupted" {
				cancel()
			}
			if tc.failure == "read" {
				s.files.open = func(string) (io.ReadSeekCloser, error) { return nil, syscall.EIO }
			}
			data := []byte(tc.block)
			u, err := s.Receive(ctx, id, "prompt_video", hash(data), int64(len(data)), bytes.NewReader(data))
			var reject *inference.Rejection
			if u != nil || !errors.As(err, &reject) || reject.Reason != tc.reason {
				t.Fatalf("received %v, %v", u, err)
			}
			if reject.Fields["stage"] != "inspect" || reject.Fields["partial_cleanup"] != "removed" || reject.Fields["observed_sha256"] != hash(data) {
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
