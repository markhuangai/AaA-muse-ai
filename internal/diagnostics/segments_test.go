package diagnostics

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func writeSegmentEvent(t *testing.T, store *Store, now time.Time, value string) {
	t.Helper()
	data, err := json.Marshal(map[string]any{"time": now, "msg": "segment_fixture", "level": "DEBUG", "value": value})
	if err != nil {
		t.Fatal(err)
	}
	if count, err := store.Write(data); err != nil || count != len(data) {
		t.Fatalf("capture append: %d/%d: %v", count, len(data), err)
	}
}

func TestSegmentRotationAndBounds(t *testing.T) {
	for capacity, want := range map[int64]int64{1: 1, 6144: 768, 65536: 8192, 65537: 4096, 128 << 20: 2 << 20, 256 << 20: 2 << 20} {
		if got := segmentCap(capacity); got != want {
			t.Fatalf("capacity %d: segment size %d, want %d", capacity, got, want)
		}
	}
	store, now := openFixture(t, 6144)
	for index := range 32 {
		writeSegmentEvent(t, store, now.Add(time.Duration(index)*time.Second), "small")
	}
	snapshot, err := store.Snapshot(Filter{})
	if err != nil || snapshot.Metadata.Complete || snapshot.Metadata.Captures == 0 || store.retainedBytes > 6144 {
		t.Fatalf("small-capacity rotation: %+v %d %v", snapshot.Metadata, store.retainedBytes, err)
	}
	for _, entry := range store.retained {
		if entry.size > 768 || entry.maxTime.Before(entry.minTime) {
			t.Fatalf("invalid segment bounds: %+v", entry)
		}
	}
	writeSegmentEvent(t, store, now.Add(time.Minute), strings.Repeat("x", 12000))
	if store.active != nil {
		t.Fatal("capture larger than the entire allowance was not sealed")
	}
	snapshot, err = store.Snapshot(Filter{})
	if err != nil || snapshot.Metadata.Captures != 0 || store.retainedBytes != 0 {
		t.Fatalf("oversize segment survived pruning: %+v %d %v", snapshot.Metadata, store.retainedBytes, err)
	}
}

func TestSegmentCrashRecovery(t *testing.T) {
	if dir := os.Getenv("AAA_TEST_CRASH_CAPTURE_DIR"); dir != "" {
		store, err := Open(OSFiles{}, dir, "crashed", time.Now, time.Hour, 128<<20)
		if err != nil {
			t.Fatal(err)
		}
		writeSegmentEvent(t, store, time.Now().UTC(), "first")
		writeSegmentEvent(t, store, time.Now().UTC(), strings.Repeat("x", 9000))
		fmt.Println("appended")
		time.Sleep(time.Hour)
		return
	}
	dir := t.TempDir()
	child := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestSegmentCrashRecovery$")
	child.Env = append(os.Environ(), "AAA_TEST_CRASH_CAPTURE_DIR="+dir)
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	ready := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		ready <- line
	}()
	select {
	case line := <-ready:
		if line != "appended\n" {
			_ = child.Process.Kill()
			_ = child.Wait()
			t.Fatalf("fixture did not complete the appends: %q", line)
		}
	case <-time.After(10 * time.Second):
		_ = child.Process.Kill()
		_ = child.Wait()
		t.Fatal("capture child did not start")
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := child.Wait(); err == nil {
		t.Fatal("fixture was not killed")
	}
	store, err := Open(OSFiles{}, dir, "replacement", time.Now, time.Hour, 128<<20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if store.active != nil || len(store.retained) != 1 {
		t.Fatal("restart did not index the old file as sealed")
	}
	old := store.retained[0]
	writeSegmentEvent(t, store, time.Now().UTC(), "new process")
	info, err := os.Stat(filepath.Join(dir, old.name))
	if err != nil || info.Size() != old.size {
		t.Fatal("reopened a previous process's segment for append", err)
	}
	snapshot, err := store.Snapshot(Filter{})
	if err != nil || !snapshot.Metadata.Complete || snapshot.Metadata.Captures != 3 {
		t.Fatalf("completed process-only crash writes not recovered: %+v %v", snapshot.Metadata, err)
	}
	if events := payloads(t, snapshot); events[0]["value"] != "first" || events[1]["value"] != strings.Repeat("x", 9000) || events[2]["value"] != "new process" {
		t.Fatal("recovered capture contents differ")
	}
}

func TestSegmentTornTailAndEmptyStub(t *testing.T) {
	store, now := openFixture(t, 128<<20)
	writeSegmentEvent(t, store, *now, "first")
	writeSegmentEvent(t, store, *now, strings.Repeat("tail", 17000))
	name := store.active.name
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.dir, name)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(path, info.Size()-5); err != nil {
		t.Fatal(err)
	}
	stub := filepath.Join(store.dir, "segment-00000000000000000002-crash-00000000000000000001.ndjson")
	if err := os.WriteFile(stub, nil, 0600); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(OSFiles{}, store.dir, "replacement", func() time.Time { return *now }, time.Hour, 128<<20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if _, err := os.Stat(stub); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("crash stub not removed: %v", err)
	}
	snapshot, err := reopened.Snapshot(Filter{})
	if err != nil || snapshot.Metadata.Complete || snapshot.Metadata.Captures != 1 || !snapshot.Metadata.PrunedThrough.IsZero() ||
		len(snapshot.Metadata.Omissions) != 1 || snapshot.Metadata.Omissions[0] != "incomplete_capture:"+name {
		t.Fatalf("crash tail not explicit: %+v %v", snapshot.Metadata, err)
	}
	if payloads(t, snapshot)[0]["value"] != "first" {
		t.Fatal("torn tail obscured the valid prefix")
	}
}

func TestSegmentMaintenanceFailureAndCloseJoin(t *testing.T) {
	store, err := Open(OSFiles{}, t.TempDir(), "instance", time.Now, time.Hour, 128<<20)
	if err != nil {
		t.Fatal(err)
	}
	writeSegmentEvent(t, store, time.Now(), "open descriptor")
	failed, release := make(chan error, 1), make(chan struct{})
	var released sync.Once
	allowReturn := func() { released.Do(func() { close(release) }) }
	t.Cleanup(func() { allowReturn(); _ = store.Close() })
	store.StartMaintenance(10*time.Millisecond, func(err error) { failed <- err; <-release })
	if err := os.Chmod(store.dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(store.dir, 0700) })
	select {
	case err := <-failed:
		if Cause(err) != "filesystem_permission_denied" {
			t.Fatalf("wrong failure cause: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("maintenance did not detect chmod on the open directory")
	}
	closed := make(chan error, 1)
	go func() { closed <- store.Close() }()
	select {
	case <-closed:
		t.Fatal("close returned before the failure callback")
	case <-time.After(10 * time.Millisecond):
	}
	allowReturn()
	if err := <-closed; !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("close hid the maintenance failure: %v", err)
	}
	if _, err := store.Write([]byte(`{"msg":"after close"}`)); !errors.Is(err, fs.ErrClosed) {
		t.Fatalf("post-close write: %v", err)
	}
}

func TestLegacyCapturesDrainInBoundedBatches(t *testing.T) {
	seed, now := openFixture(t, 128<<20)
	writeSegmentEvent(t, seed, *now, "legacy format")
	snapshot, err := seed.Snapshot(Filter{})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for index := range pruneBatchSize + 2 {
		path := filepath.Join(dir, fmt.Sprintf("capture-%020d.ndjson", index))
		if err := os.WriteFile(path, snapshot.Records[0], 0600); err != nil {
			t.Fatal(err)
		}
	}
	files := &countingFiles{}
	store, err := Open(files, dir, "upgrade", func() time.Time { return now.Add(2 * time.Hour) }, time.Hour, 128<<20)
	if err != nil || files.removes != pruneBatchSize || len(store.retained) != 2 {
		t.Fatalf("startup drain not bounded: %d %v", files.removes, err)
	}
	if err := store.Close(); err != nil || files.removes != pruneBatchSize+2 || store.retainedBytes != 0 || !store.state.PrunedThrough.Equal(*now) {
		t.Fatalf("shutdown did not safely drain remaining legacy evidence: %d %v", files.removes, err)
	}
}

func TestSegmentMaintenanceWithConcurrentSnapshot(t *testing.T) {
	store, err := Open(OSFiles{}, t.TempDir(), "instance", time.Now, time.Hour, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	store.StartMaintenance(time.Millisecond, func(err error) { t.Errorf("maintenance failed: %v", err) })
	t.Cleanup(func() { _ = store.Close() })
	var running sync.WaitGroup
	running.Go(func() {
		for range 120 {
			data := []byte(fmt.Sprintf(`{"time":%q,"msg":"concurrent writer","value":%q}`, time.Now().UTC().Format(time.RFC3339Nano), strings.Repeat("x", 900)))
			if _, err := store.Write(data); err != nil {
				t.Error(err)
				return
			}
		}
	})
	for range 12 {
		snapshot, err := store.Snapshot(Filter{})
		if err != nil {
			t.Fatal(err)
		}
		for _, capture := range snapshot.Records {
			records, err := validateCapture(capture)
			if err != nil || records[0].Time.After(snapshot.Metadata.SnapshotAt) {
				t.Fatalf("invalid capture or write beyond snapshot: %v", err)
			}
		}
	}
	running.Wait()
	if err := store.Close(); err != nil || store.retainedBytes > store.maxBytes {
		t.Fatalf("maintenance left bytes out of bounds: %d %v", store.retainedBytes, err)
	}
}
