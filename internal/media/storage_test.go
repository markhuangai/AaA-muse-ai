package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func hash(data []byte) string { v := sha256.Sum256(data); return hex.EncodeToString(v[:]) }

func TestPrepareNamespaceRefusesOldFilesAndSharesFreshRoot(t *testing.T) {
	old := t.TempDir()
	artifact := filepath.Join(old, "legacy-artifact")
	if err := os.WriteFile(artifact, []byte("legacy bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := New(old).PrepareNamespace(); !errors.Is(err, ErrFreshNamespace) {
		t.Fatalf("legacy volume was not refused: %v", err)
	}
	if data, err := os.ReadFile(artifact); err != nil || string(data) != "legacy bytes" {
		t.Fatal("guard did not preserve legacy media")
	}
	fresh := t.TempDir()
	ready := make(chan error, 2)
	for range 2 {
		go func() { ready <- New(fresh).PrepareNamespace() }()
	}
	for range 2 {
		if err := <-ready; err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(fresh, "new-artifact"), []byte("new bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := New(fresh).PrepareNamespace(); err != nil {
		t.Fatalf("a sibling could not reopen the initialized namespace: %v", err)
	}
}

func TestOpenJobFiles(t *testing.T) {
	root := t.TempDir()
	store := New(root)
	id := strings.Repeat("a", 32)
	alias := strings.Repeat("b", 32)
	dir := filepath.Join(root, id)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"prompt", "image", "artifact"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
		f, err := store.Open(id, name)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(f)
		f.Close()
		if err != nil || string(data) != name {
			t.Fatalf("read %s: %q, %v", name, data, err)
		}
	}
	if err := os.Symlink(id, filepath.Join(root, alias)); err != nil {
		t.Fatal(err)
	}
	for _, input := range [][2]string{{alias, "prompt"}, {".", "prompt"}, {id, "./prompt"}} {
		if f, err := store.Open(input[0], input[1]); !errors.Is(err, os.ErrInvalid) {
			if f != nil {
				f.Close()
			}
			t.Fatalf("open %q: got %v, want invalid", input, err)
		}
	}
	if err := os.Rename(filepath.Join(dir, "image"), filepath.Join(root, "saved-image")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../saved-image", filepath.Join(dir, "image")); err != nil {
		t.Fatal(err)
	}
	if f, err := store.Open(id, "image"); err == nil {
		f.Close()
		t.Fatal("read a file outside the job directory")
	}
}

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
	data := []byte("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isommp41damaged-coding")
	u, err := store.Receive(ctx, id, "image_video", hash(data), int64(len(data)), bytes.NewReader(data))
	if err != nil || u.Properties.MediaType != "video/mp4" || u.Properties.Size != int64(len(data)) || u.Properties.SHA256 != hash(data) {
		t.Fatal("header-only upload did not retain its identity", u, err)
	}
	if props, err := json.Marshal(u.Properties); err != nil || bytes.Contains(props, []byte("duration")) || bytes.Contains(props, []byte("streams")) {
		t.Fatal("header-only receipt contains measurements", string(props), err)
	}
	if err = u.Commit(); err != nil {
		t.Fatal(err)
	}
	if stored, err := os.ReadFile(filepath.Join(root, id, "artifact")); err != nil || !bytes.Equal(stored, data) {
		t.Fatal("upload bytes modified", err)
	}
	for _, bad := range []struct {
		n    int64
		hash string
	}{{int64(len(data)), strings.Repeat("0", 64)}, {0, ""}, {ArtifactLimit + 1, ""}, {1, hash(data)}} {
		if _, err = store.Receive(ctx, id, "image_video", bad.hash, bad.n, bytes.NewReader(data)); err == nil {
			t.Fatal("accepted mismatched upload")
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
		if err := s.checkHeader(ctx, name, kind); err == nil {
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
	now := time.Now()
	get := func(context.Context, []string) (map[string]string, error) { return nil, nil }
	l := slog.Default()
	if err = s.Cleanup(ctx, l, now, get); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(p.Path); err != nil {
		t.Fatal("deleted in-flight stage")
	}
	if err = s.Cleanup(ctx, l, now.Add(2*OrphanGrace), get); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(p.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("orphan persisted")
	}
}

func TestReferenceHeaderBudgets(t *testing.T) {
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, image.NewGray(image.Rect(0, 0, 32, 24)), nil); err != nil {
		t.Fatal(err)
	}
	if err := checkReferenceHeader(bytes.NewReader(encoded.Bytes()), "image/jpeg"); err != nil {
		t.Fatal("valid JPEG header rejected", err)
	}
	encoded.Reset()
	if err := png.Encode(&encoded, image.NewGray(image.Rect(0, 0, 4001, 4000))); err != nil {
		t.Fatal(err)
	}
	if err := checkReferenceHeader(bytes.NewReader(encoded.Bytes()), "image/png"); err == nil || err.Error() != "invalid_media_dimensions" {
		t.Fatal("oversized PNG header accepted", err)
	}
	encoded.Reset()
	if err := png.Encode(&encoded, image.NewGray(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}
	control := []byte("\x00\x00\x00\x08acTL\x00\x00\x00\x02\x00\x00\x00\x00")
	control = binary.BigEndian.AppendUint32(control, crc32.ChecksumIEEE(control[4:]))
	apng := append(append(bytes.Clone(encoded.Bytes()[:33]), control...), encoded.Bytes()[33:]...)
	webp := []byte("RIFF\x16\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x02\x00\x00\x00\x07\x00\x00\x07\x00\x00")
	for kind, body := range map[string][]byte{"image/png": apng, "image/webp": webp} {
		if err := checkReferenceHeader(bytes.NewReader(body), kind); err == nil || err.Error() != "animated_reference" {
			t.Fatal("animated reference was admitted", kind, err)
		}
	}
	webp[20] = 0
	if err := checkReferenceHeader(bytes.NewReader(webp), "image/webp"); err != nil {
		t.Fatal("valid WebP canvas header rejected", err)
	}
}

func TestArtifactSignatures(t *testing.T) {
	frames := make([]byte, 834)
	for _, offset := range []int{0, 417} {
		copy(frames[offset:], []byte{0xff, 0xfb, 0x90, 0x64})
	}
	tagged := append([]byte("ID3\x04\x00\x00\x00\x00\x00\x01\x00"), frames...)
	for _, sample := range []struct {
		kind string
		body []byte
	}{
		{"audio/mpeg", frames},
		{"audio/mpeg", tagged},
		{"audio/wav", []byte("RIFF\x20\x00\x00\x00WAVE")},
	} {
		if err := checkArtifactHeader(bytes.NewReader(sample.body), sample.kind); err != nil {
			t.Fatal(sample.kind, err)
		}
		if err := checkArtifactHeader(bytes.NewReader(sample.body[:11]), sample.kind); err == nil {
			t.Fatal("truncated header matched", sample.kind)
		}
	}
	if err := checkArtifactHeader(bytes.NewReader([]byte("RIFF\x20\x00\x00\x00WAVE")), "audio/mpeg"); err == nil {
		t.Fatal("WAV header passed as MP3")
	}
}

func TestHeaderReadFailuresAreRejected(t *testing.T) {
	if err := checkReferenceHeader(bytes.NewReader([]byte("RIFF")), "image/webp"); err == nil || err.Error() != "invalid_media_format" {
		t.Fatal("truncated WebP header matched", err)
	}
	if err := checkPNGAnimation(bytes.NewReader([]byte("\x89PNG\r\n\x1a\n"))); err == nil || err.Error() != "invalid_media_format" {
		t.Fatal("missing PNG chunk data passed", err)
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err := w.Write(make([]byte, 24)); err != nil {
		w.Close()
		t.Fatal(err)
	}
	w.Close()
	if err := checkReferenceHeader(r, "image/webp"); err == nil {
		t.Fatal("unseekable header parsed successfully")
	}
	if err := checkPNGAnimation(r); err == nil {
		t.Fatal("PNG scan accepted an unseekable header")
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if err := checkArtifactHeader(r, "video/mp4"); !errors.Is(err, os.ErrClosed) {
		t.Fatal("read failure was treated as a format check", err)
	}
}
