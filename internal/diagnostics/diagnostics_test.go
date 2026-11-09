package diagnostics

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func openFixture(t *testing.T, maxBytes int64) (*Store, *time.Time) {
	t.Helper()
	now := time.Date(2026, 11, 8, 1, 2, 3, 0, time.UTC)
	s, err := Open(OSFiles{}, t.TempDir(), "instance", func() time.Time { return now }, 7*24*time.Hour, maxBytes)
	if err != nil {
		t.Fatal(err)
	}
	return s, &now
}
func fixtureLogger(s *Store, now *time.Time, out *bytes.Buffer) *slog.Logger {
	return NewLogger(out, s, slog.LevelInfo, NewRedactor([]string{"credential-sentinel"}), func() time.Time { return *now }, func(error) { panic("unexpected capture failure") }).With("instance_id", "instance", "operation_id", "operation", "request_id", "request")
}
func payloads(t *testing.T, snapshot Snapshot) []map[string]any {
	t.Helper()
	var result []map[string]any
	for _, capture := range snapshot.Records {
		records, err := validateCapture(capture)
		if err != nil {
			t.Fatal(err)
		}
		var b bytes.Buffer
		for _, r := range records {
			decoded, _ := base64.StdEncoding.DecodeString(r.Data)
			b.Write(decoded)
		}
		var event map[string]any
		if json.Unmarshal(b.Bytes(), &event) != nil {
			t.Fatal("invalid reconstructed event")
		}
		result = append(result, event)
	}
	return result
}

func TestProtectedCaptureAndExport(t *testing.T) {
	s, now := openFixture(t, 128*1024*1024)
	var out bytes.Buffer
	logger := fixtureLogger(s, now, &out)
	text := strings.Repeat("😀\n\"nonsecret\"", 80000)
	logger.Debug("exchange.fixture", "payload", text, "authorization", "Bearer credential-sentinel", "nested", map[string]any{"password": "other-private", "items": []any{"credential-sentinel", 3}})
	logger.Info("operation.completed", "detail", "credential-sentinel")
	if strings.Contains(out.String(), "exchange.fixture") || strings.Contains(out.String(), "credential-sentinel") {
		t.Fatal("level filtering or redaction failed")
	}
	snapshot, err := s.Snapshot(Filter{RequestID: "request", OperationID: "operation"})
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.Metadata.Complete || snapshot.Metadata.Captures != 2 {
		t.Fatal("capture incomplete")
	}
	events := payloads(t, snapshot)
	if events[0]["payload"] != text || events[0]["authorization"] != "[REDACTED]" {
		t.Fatal("payload was not retained losslessly with redaction")
	}
	for _, b := range snapshot.Records {
		for _, line := range bytes.Split(bytes.TrimSpace(b), []byte("\n")) {
			if len(line)+1 > MaxRecordBytes {
				t.Fatal("oversized chunk")
			}
			if bytes.Contains(line, []byte("credential-sentinel")) {
				t.Fatal("raw credential in encoded record")
			}
		}
	}
	if events[0]["request_id"] != "request" || events[0]["operation_id"] != "operation" || events[0]["instance_id"] != "instance" {
		t.Fatal("correlation missing")
	}
	for _, filter := range []Filter{{RequestID: "missing"}, {OperationID: "missing"}, {Since: now.Add(time.Second)}, {Until: now.Add(-time.Second)}} {
		filtered, err := s.Snapshot(filter)
		if err != nil || filtered.Metadata.Captures != 0 {
			t.Fatal("filter admitted unrelated events")
		}
		if filtered.Metadata.Complete || len(filtered.Metadata.Omissions) == 0 {
			t.Fatal("missing or uncovered evidence reported complete")
		}
	}
	filtered, err := s.Snapshot(Filter{Since: now.Add(-time.Hour)})
	if err != nil || filtered.Metadata.Complete || filtered.Metadata.Omissions[0] != "requested_interval_precedes_capture" {
		t.Fatal("uncovered past interval hidden")
	}
	info, err := os.Stat(s.dir)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("directory not protected")
	}
	entries, _ := os.ReadDir(s.dir)
	for _, entry := range entries {
		info, _ := entry.Info()
		if info.Mode().Perm() != 0600 {
			t.Fatal("capture file not protected")
		}
	}
}

func TestRetentionRestartAndMissingEvidence(t *testing.T) {
	s, now := openFixture(t, 6144)
	var out bytes.Buffer
	logger := fixtureLogger(s, now, &out)
	if err := os.WriteFile(filepath.Join(s.dir, "operator-owned.txt"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	logger.Debug("large.fixture", "payload", strings.Repeat("x", 12000))
	snapshot, err := s.Snapshot(Filter{})
	if err != nil || snapshot.Metadata.Complete || snapshot.Metadata.Captures != 0 || len(snapshot.Metadata.Omissions) == 0 {
		t.Fatal("capacity loss hidden")
	}
	*now = now.Add(time.Second)
	logger.Info("small.fixture")
	*now = now.Add(8 * 24 * time.Hour)
	snapshot, err = s.Snapshot(Filter{})
	if err != nil || snapshot.Metadata.Complete || snapshot.Metadata.Captures != 0 {
		t.Fatal("expiry loss hidden")
	}
	reopened, err := Open(OSFiles{}, s.dir, "replacement", func() time.Time { return *now }, 7*24*time.Hour, 6144)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.state.PrunedThrough.IsZero() || !reopened.state.CreatedAt.Equal(s.state.CreatedAt) {
		t.Fatal("retention state not durable")
	}
	snapshot, err = reopened.Snapshot(Filter{Since: now.Add(-time.Hour)})
	if err != nil || !snapshot.Metadata.Complete {
		t.Fatal("unrelated old pruning affected later interval")
	}
	if _, err = os.Stat(filepath.Join(s.dir, "operator-owned.txt")); err != nil {
		t.Fatal("removed operator file")
	}
}

func TestCorruptChunksAreExplicit(t *testing.T) {
	s, now := openFixture(t, 1024*1024)
	var out bytes.Buffer
	fixtureLogger(s, now, &out).Info("fixture", "value", strings.Repeat("x", 5000))
	entries, _ := s.captures()
	path := filepath.Join(s.dir, entries[0].Name())
	good, _ := os.ReadFile(path)
	records, err := validateCapture(good)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string][]byte{"invalid-json": []byte("{"), "oversized": bytes.Repeat([]byte("x"), MaxRecordBytes+1)}
	encode := func(rs []Record) []byte {
		var b bytes.Buffer
		for _, r := range rs {
			_ = json.NewEncoder(&b).Encode(r)
		}
		return b.Bytes()
	}
	cases["missing"] = encode(records[:1])
	for name, change := range map[string]func([]Record){"order": func(r []Record) { r[1].Chunk = 0 }, "identity": func(r []Record) { r[1].CaptureID = "other" }, "count": func(r []Record) { r[1].Chunks = 100 }, "hash": func(r []Record) {
		for i := range r {
			r[i].SHA256 = "wrong"
		}
	}, "base64": func(r []Record) { r[1].Data = "!" }, "type": func(r []Record) { r[1].Type = "wrong" }} {
		copyRecords := append([]Record{}, records...)
		change(copyRecords)
		cases[name] = encode(copyRecords)
	}
	for name, b := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := validateCapture(b); err == nil {
				t.Fatal("accepted corrupt capture")
			}
		})
	}
	if err = os.WriteFile(path, cases["missing"], 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.Snapshot(Filter{})
	if err != nil || snapshot.Metadata.Complete || len(snapshot.Metadata.Omissions) != 1 {
		t.Fatal("missing chunks not reported")
	}
	if err = os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Snapshot(Filter{}); err == nil {
		t.Fatal("invalid metadata not rejected")
	}
	if _, err = Open(OSFiles{}, s.dir, "replacement", func() time.Time { return *now }, time.Hour, 1024*1024); err == nil {
		t.Fatal("invalid retained metadata accepted on restart")
	}
}

type countingFiles struct {
	OSFiles
	reads, scans int
}

func (f *countingFiles) ReadFile(p string) ([]byte, error) {
	f.reads++
	return f.OSFiles.ReadFile(p)
}
func (f *countingFiles) ReadDir(p string) ([]fs.DirEntry, error) {
	f.scans++
	return f.OSFiles.ReadDir(p)
}

func TestCaptureWritesDoNotRescanHistory(t *testing.T) {
	s, now := openFixture(t, 128*1024*1024)
	files := &countingFiles{}
	s.files = files
	var out bytes.Buffer
	logger := fixtureLogger(s, now, &out)
	for i := 0; i < 64; i++ {
		logger.Info("fixture")
	}
	if files.reads != 0 || files.scans != 0 {
		t.Fatal("log writes reread retained history")
	}
	capacity := s.retainedBytes
	reopened, err := Open(files, s.dir, "replacement", func() time.Time { return *now }, 7*24*time.Hour, capacity)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.retained) != 64 || reopened.retainedBytes != capacity || files.reads != 65 || files.scans != 1 {
		t.Fatal("restart did not rebuild retained size/time metadata once")
	}
	files.reads, files.scans = 0, 0
	fixtureLogger(reopened, now, &out).Info("fixture")
	if files.reads != 0 || files.scans != 0 || reopened.retainedBytes > capacity || len(reopened.retained) >= 65 {
		t.Fatal("capacity pruning rescanned history or exceeded its bound")
	}
	snapshot, err := reopened.Snapshot(Filter{})
	if err != nil || snapshot.Metadata.Complete || snapshot.Metadata.Captures != len(reopened.retained) {
		t.Fatal("indexed pruning lost completeness metadata")
	}
	var actualBytes int64
	for _, b := range snapshot.Records {
		actualBytes += int64(len(b))
	}
	if actualBytes != reopened.retainedBytes {
		t.Fatal("retained byte accounting differs from the stored captures")
	}
}

func TestRetentionIndexOrdersEventTimes(t *testing.T) {
	s, now := openFixture(t, 128*1024*1024)
	base := *now
	var out bytes.Buffer
	logger := fixtureLogger(s, now, &out)
	*now = base.Add(time.Hour)
	logger.Info("newer")
	*now = base.Add(-time.Hour)
	logger.Info("older")
	*now = base.Add(7 * 24 * time.Hour)
	snapshot, err := s.Snapshot(Filter{})
	if err != nil || snapshot.Metadata.Captures != 1 || snapshot.Metadata.Complete {
		t.Fatal("out-of-order event timestamps broke expiry pruning")
	}
	if payloads(t, snapshot)[0]["msg"] != "newer" || !s.state.PrunedThrough.Equal(base.Add(-time.Hour)) {
		t.Fatal("expiry removed the wrong capture")
	}
	if _, err = Open(&failingFiles{fail: "read", after: 1}, s.dir, "replacement", func() time.Time { return *now }, 7*24*time.Hour, s.maxBytes); err == nil {
		t.Fatal("ignored retained-capture read failure on restart")
	}
}

type failingFiles struct {
	OSFiles
	fail         string
	after, calls int
}

func (f *failingFiles) hit(name string) bool {
	if f.fail != name {
		return false
	}
	f.calls++
	return f.calls > f.after
}
func (f *failingFiles) MkdirAll(p string, m fs.FileMode) error {
	if f.hit("mkdir") {
		return fs.ErrPermission
	}
	return f.OSFiles.MkdirAll(p, m)
}
func (f *failingFiles) Chmod(p string, m fs.FileMode) error {
	if f.hit("chmod") {
		return fs.ErrPermission
	}
	return f.OSFiles.Chmod(p, m)
}
func (f *failingFiles) Lstat(p string) (fs.FileInfo, error) {
	if f.hit("stat") {
		return nil, fs.ErrPermission
	}
	return f.OSFiles.Lstat(p)
}
func (f *failingFiles) ReadDir(p string) ([]fs.DirEntry, error) {
	if f.hit("readdir") {
		return nil, fs.ErrPermission
	}
	return f.OSFiles.ReadDir(p)
}
func (f *failingFiles) ReadFile(p string) ([]byte, error) {
	if f.hit("read") {
		return nil, fs.ErrPermission
	}
	return f.OSFiles.ReadFile(p)
}
func (f *failingFiles) WriteFile(p string, b []byte, m fs.FileMode) error {
	if f.hit("write") {
		return fs.ErrPermission
	}
	return f.OSFiles.WriteFile(p, b, m)
}
func (f *failingFiles) Rename(a, b string) error {
	if f.hit("rename") {
		return fs.ErrPermission
	}
	return f.OSFiles.Rename(a, b)
}
func (f *failingFiles) Remove(p string) error {
	if f.hit("remove") {
		return fs.ErrPermission
	}
	return f.OSFiles.Remove(p)
}

func TestCaptureIOFailures(t *testing.T) {
	for _, method := range []string{"mkdir", "stat", "chmod", "read", "write", "rename", "readdir"} {
		t.Run("open-"+method, func(t *testing.T) {
			_, err := Open(&failingFiles{fail: method}, t.TempDir(), "instance", time.Now, time.Hour, 1024*1024)
			if err == nil {
				t.Fatal("ignored required filesystem failure")
			}
		})
	}
	for _, method := range []string{"write", "chmod", "rename", "remove"} {
		t.Run("capture-"+method, func(t *testing.T) {
			s, now := openFixture(t, 6144)
			files := &failingFiles{}
			s.files = files
			var out bytes.Buffer
			logger := fixtureLogger(s, now, &out)
			logger.Info("existing")
			files.fail = method
			payload := []byte(`{"time":"2026-11-08T01:02:03Z","msg":"large","level":"DEBUG","data":"` + strings.Repeat("x", 12000) + `"}`)
			if _, err := s.Write(payload); err == nil {
				t.Fatal("ignored write/retention failure")
			}
		})
	}
	for _, method := range []string{"readdir", "read"} {
		t.Run("snapshot-"+method, func(t *testing.T) {
			s, now := openFixture(t, 6144)
			files := &failingFiles{}
			s.files = files
			var out bytes.Buffer
			fixtureLogger(s, now, &out).Info("existing")
			files.fail = method
			if _, err := s.Snapshot(Filter{}); err == nil {
				t.Fatal("ignored export read failure")
			}
		})
	}
	t.Run("prune-state-write", func(t *testing.T) {
		s, now := openFixture(t, 6144)
		var out bytes.Buffer
		fixtureLogger(s, now, &out).Info("existing")
		s.files = &failingFiles{fail: "write", after: 1}
		payload := []byte(`{"time":"2026-11-08T01:02:03Z","msg":"large","level":"DEBUG","data":"` + strings.Repeat("x", 12000) + `"}`)
		if _, err := s.Write(payload); err == nil {
			t.Fatal("ignored retention-state write failure")
		}
	})
	s, now := openFixture(t, 1024*1024)
	if _, err := s.Write([]byte("bad")); err == nil {
		t.Fatal("accepted invalid event")
	}
	if _, err := s.Write([]byte(`{"msg":"` + strings.Repeat("x", 7000) + `"}`)); err == nil {
		t.Fatal("accepted oversized metadata")
	}
	if err := os.WriteFile(filepath.Join(s.dir, "retention.json"), []byte("bad"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(OSFiles{}, s.dir, "instance", func() time.Time { return *now }, time.Hour, 1024*1024); err == nil {
		t.Fatal("accepted damaged retention state")
	}
	if err := os.Mkdir(filepath.Join(s.dir, "capture-not-regular.ndjson"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := s.captures(); err == nil {
		t.Fatal("accepted non-regular capture")
	}
	if err := (OSFiles{}).WriteFile(filepath.Join(s.dir, "missing", "file"), nil, 0600); err == nil {
		t.Fatal("accepted invalid write path")
	}
}

type errorWriter struct{}

func (errorWriter) Write([]byte) (int, error) { return 0, fs.ErrPermission }

func TestLoggerLevelsGroupsAndFailure(t *testing.T) {
	for _, level := range []slog.Level{slog.LevelDebug, slog.LevelInfo, slog.LevelWarn, slog.LevelError} {
		var out, capture bytes.Buffer
		failed := 0
		logger := NewLogger(&out, &capture, level, NewRedactor([]string{"known-secret"}), time.Now, func(error) { failed++ })
		logger.Log(context.Background(), slog.Level(-8), "below_debug")
		logger.Debug("detail")
		logger.Info("boundary")
		logger.Warn("degradation")
		logger.Error("failure")
		logger.With("credential", "known-secret").WithGroup("group").Info("grouped", "value", "known-secret", "unsupported", make(chan int))
		if failed != 0 || strings.Contains(capture.String(), "known-secret") || strings.Contains(capture.String(), "below_debug") {
			t.Fatal("unsafe logger output")
		}
		if !strings.Contains(capture.String(), "detail") {
			t.Fatal("debug not always captured")
		}
		if level > slog.LevelDebug && strings.Contains(out.String(), "detail") {
			t.Fatal("stdout severity filter ignored")
		}
	}
	for _, captureFails := range []bool{false, true} {
		calls := 0
		var buf bytes.Buffer
		var stdout, capture interface{ Write([]byte) (int, error) } = &buf, errorWriter{}
		if !captureFails {
			stdout, capture = errorWriter{}, &buf
		}
		logger := NewLogger(stdout, capture, slog.LevelInfo, NewRedactor(nil), time.Now, func(err error) {
			calls++
			if !errors.Is(err, fs.ErrPermission) {
				t.Fatal("lost write cause")
			}
		})
		logger.Info("one")
		logger.Error("two")
		if calls != 1 {
			t.Fatal("failure was not signaled exactly once")
		}
	}
	for err, want := range map[error]string{fs.ErrPermission: "filesystem_permission_denied", syscall.ENOSPC: "filesystem_capacity_exhausted", fs.ErrNotExist: "filesystem_path_missing", errors.New("other"): "capture_io_failed"} {
		if Cause(err) != want {
			t.Fatal("wrong I/O cause")
		}
	}
}
