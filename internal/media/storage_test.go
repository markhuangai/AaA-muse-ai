package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/png"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func hash(data []byte) string { v := sha256.Sum256(data); return hex.EncodeToString(v[:]) }

func TestVerifiedStorageAndLifecycle(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	store := New(root)
	p, err := store.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err = p.Prompt("private prompt"); err != nil || p.Record.PromptHash != hash([]byte("private prompt")) {
		t.Fatal(err)
	}
	var original bytes.Buffer
	if err = png.Encode(&original, image.NewRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}
	if err = store.Image(ctx, p, &original, "image/png"); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	if err = p.Install(root, id); err != nil {
		t.Fatal(err)
	}
	if err = p.Close(); err != nil {
		t.Fatal(err)
	}
	f, err := store.Open(id, "image")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(f)
	f.Close()
	if err != nil || hash(body) != p.Record.InputHash {
		t.Fatal("source identity changed")
	}
	for _, entry := range []struct{ name, kind, codec string }{{"clip.mp4", "video/mp4", "libx264"}, {"voice.mp3", "audio/mpeg", "libmp3lame"}, {"voice.wav", "audio/wav", "pcm_s16le"}, {"still.webp", "image/webp", "libwebp"}, {"still.jpg", "image/jpeg", "mjpeg"}} {
		name := filepath.Join(t.TempDir(), entry.name)
		source := "color=c=blue:s=64x48:r=8"
		if strings.HasPrefix(entry.kind, "audio/") {
			source = "sine=frequency=200:duration=1"
		}
		args := []string{"-nostdin", "-v", "error", "-f", "lavfi", "-i", source, "-t", "1", "-c", entry.codec, "-threads", "1"}
		if strings.HasPrefix(entry.kind, "image/") {
			args = append(args, "-frames:v", "1")
		}
		if out, err := exec.Command("ffmpeg", append(args, name)...).CombinedOutput(); err != nil {
			t.Fatalf("prepare %s: %v %s", entry.kind, err, out)
		}
		properties, err := Inspect(ctx, name, entry.kind)
		if err != nil || len(properties.Streams) != 1 {
			t.Fatal(entry.kind, err, properties)
		}
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if entry.kind == "video/mp4" {
			if properties.Width != 64 || properties.Height != 48 || properties.VideoFrames != 8 || properties.Duration != 1 || properties.FPS != 8 {
				t.Fatal(properties)
			}
			u, err := store.Receive(ctx, id, "image_video", hash(data), int64(len(data)), bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			if err = u.Commit(); err != nil {
				t.Fatal(err)
			}
			stored, _ := os.ReadFile(filepath.Join(root, id, "artifact"))
			if !bytes.Equal(stored, data) {
				t.Fatal("bytes modified")
			}
			for _, bad := range []struct {
				n    int64
				hash string
			}{{int64(len(data)), strings.Repeat("0", 64)}, {0, ""}, {ArtifactLimit + 1, ""}, {1, hash(data)}} {
				if _, err = store.Receive(ctx, id, "image_video", bad.hash, bad.n, bytes.NewReader(data)); err == nil {
					t.Fatal("accepted mismatched upload")
				}
			}
		}
	}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	now := time.Now()
	state := "completed"
	get := func(_ context.Context, _ []string) (map[string]string, error) {
		return map[string]string{id: state}, nil
	}
	if err = store.Cleanup(ctx, logger, now, get); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"prompt", "image"} {
		if _, err = store.Open(id, name); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("input retained")
		}
	}
	state = "expired"
	if err = store.Cleanup(ctx, logger, now, get); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, id)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("expired media persisted")
	}
}

func TestRejectedInputsAndOrphans(t *testing.T) {
	ctx := context.Background()
	s := New(t.TempDir())
	p, err := s.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"  ", string([]byte{0xff}), strings.Repeat("x", PromptLimit+1)} {
		if p.Prompt(v) == nil {
			t.Fatal("invalid prompt")
		}
	}
	if err = s.Image(ctx, p, strings.NewReader("bad"), "image/svg+xml"); err == nil {
		t.Fatal("accepted unsupported image")
	}
	for _, kind := range []string{"image/jpeg", "image/png", "image/webp", "video/mp4", "audio/wav", "unknown"} {
		name := filepath.Join(t.TempDir(), "bad")
		os.WriteFile(name, bytes.Repeat([]byte{3}, 56), 0600)
		if _, err := Inspect(ctx, name, kind); err == nil {
			t.Fatal(kind)
		}
	}
	if n, h, err := TrialFixture("native_mp3", 0, ""); err != nil || n != 19813 || len(h) != 64 {
		t.Fatal(n, h, err)
	}
	if _, _, err := TrialFixture("offline_wav", 3, hash([]byte("abc"))); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"x", "native_mp3"} {
		if _, _, err = TrialFixture(kind, 0, "oops"); err == nil {
			t.Fatal(kind)
		}
	}
	if _, err := s.Receive(ctx, "absent", "prompt_video", "", 1, strings.NewReader("x")); err == nil {
		t.Fatal("unknown stage")
	}
	if _, err := command(ctx, "a-command-that-does-not-exist"); err == nil {
		t.Fatal("missing executable accepted")
	}
	buf := &cappedOutput{}
	if _, err = buf.Write(make([]byte, 1<<17)); err == nil {
		t.Fatal("unbounded output")
	}
	if rate("5") != 5 || rate("a") != 0 || rate("3/0") != 0 {
		t.Fatal("invalid rate")
	}
	now := time.Now()
	get := func(context.Context, []string) (map[string]string, error) { return nil, nil }
	l := slog.Default()
	if err = s.Cleanup(ctx, l, now, get); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(p.Path); err != nil {
		t.Fatal("deleted in-flight stage")
	}
	if err = s.Cleanup(ctx, l, now.Add(2*JobTimeout), get); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(p.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("orphan persisted")
	}
}
