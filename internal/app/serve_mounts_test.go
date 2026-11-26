package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"golang.org/x/sys/unix"
)

func composeFixture(t *testing.T) *composeMounts {
	t.Helper()
	dir := t.TempDir()
	m := &composeMounts{configFile: "config.yaml", database: "broker.sqlite3"}
	for i, name := range []string{"config", "state", "media", "diagnostics"} {
		m.roots[i] = mountTarget{path: filepath.Join(dir, name), mode: 0700}
		if err := os.Mkdir(m.roots[i].path, 0755); err != nil {
			t.Fatal(err)
		}
	}
	return m
}

func writeMountFixture(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestComposeMountsRepairDedicatedFilesAndHoldStateLock(t *testing.T) {
	m := composeFixture(t)
	yaml := filepath.Join(m.roots[configMount].path, m.configFile)
	db := filepath.Join(m.roots[stateMount].path, m.database)
	job := filepath.Join(m.roots[mediaMount].path, strings.Repeat("a", 32))
	if err := os.Mkdir(job, 0755); err != nil {
		t.Fatal(err)
	}
	artifact := filepath.Join(job, "artifact")
	capture := filepath.Join(m.roots[diagnosticsMount].path, "capture-sample.ndjson")
	files := []string{yaml, db, db + "-wal", db + "-shm", db + "-journal", artifact, capture,
		filepath.Join(m.roots[diagnosticsMount].path, "retention.json"),
		filepath.Join(m.roots[diagnosticsMount].path, "segment-sample.ndjson"),
		filepath.Join(m.roots[diagnosticsMount].path, "segment-sample.ndjson.tmp"),
		filepath.Join(m.roots[mediaMount].path, ".aaa-muse-media-v1")}
	for _, path := range files {
		writeMountFixture(t, path, "retained bytes")
	}
	if err := os.Chmod(yaml, 0600); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(m.roots[stateMount].path, "backup")
	writeMountFixture(t, backup, "untouched")
	for i := range 2 {
		var output strings.Builder
		lock, ok := m.prepare(t.Context(), slog.New(slog.NewJSONHandler(&output, nil)),
			func(event, cause string, attrs []any) { t.Log(event, cause, attrs) },
			func(owner mountOwner) error {
				for _, path := range append(append([]string{}, files...), job) {
					info, err := os.Stat(path)
					if err != nil {
						t.Fatal(err)
					}
					mode := os.FileMode(0600)
					if path == job {
						mode = 0700
					}
					got := info.Sys().(*syscall.Stat_t)
					if info.Mode().Perm() != mode || int(got.Uid) != owner.UID || int(got.Gid) != owner.GID {
						t.Fatal("incorrect mount metadata", path, info.Mode(), got.Uid, got.Gid)
					}
				}
				return nil
			})
		if !ok {
			t.Fatal("mounts could not be prepared")
		}
		defer lock.Close()
		var event struct {
			Repairs int    `json:"metadata_repairs"`
			Outcome string `json:"outcome"`
		}
		if err := json.Unmarshal([]byte(output.String()), &event); err != nil || event.Outcome != "prepared" || (event.Repairs == 0) != (i == 1) {
			t.Fatal("preparation summary is not idempotent", event, err)
		}
	}
	if info, err := os.Stat(backup); err != nil || info.Mode().Perm() != 0644 {
		t.Fatal("changed an operator-owned backup", err)
	}
	for _, path := range files {
		if body, err := os.ReadFile(path); err != nil || string(body) != "retained bytes" {
			t.Fatal("metadata repair changed bytes", err)
		}
	}
	other, err := os.Open(m.roots[stateMount].path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if locked, err := tryMountLock(int(other.Fd()), unix.LOCK_EX); err != nil || locked {
		t.Fatal("active shared holders permitted an ownership handoff", err)
	}
}

func TestComposeMissingYAMLSecuresOnlyEmptyDataMounts(t *testing.T) {
	m := composeFixture(t)
	marker := filepath.Join(m.roots[stateMount].path, "keep")
	writeMountFixture(t, marker, "preserved")
	var output strings.Builder
	lock, ok := m.prepare(t.Context(), slog.New(slog.NewJSONHandler(&output, nil)),
		func(event, cause string, attrs []any) {
			if event != "mounts.prepare_failed" || cause != "not_found" || !strings.Contains(fmtAttrs(attrs), "config.yaml") {
				t.Fatalf("wrong startup diagnosis %v, %v, %v", event, cause, attrs)
			}
		}, func(mountOwner) error { t.Fatal("missing YAML reached privilege drop"); return nil })
	if ok || lock != nil || !strings.Contains(output.String(), "awaiting_configuration") {
		t.Fatal("missing YAML was not diagnosed")
	}
	for i, target := range m.roots {
		info, err := os.Stat(target.path)
		want := os.FileMode(0700)
		if i == stateMount {
			want = 0755
		}
		if err != nil || info.Mode().Perm() != want {
			t.Fatal("wrong handling of empty or populated directory", i, info, err)
		}
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "preserved" {
		t.Fatal("populated state changed", err)
	}
}

func fmtAttrs(attrs []any) string {
	var b strings.Builder
	for _, attr := range attrs {
		if value, ok := attr.(string); ok {
			b.WriteString(value)
		}
	}
	return b.String()
}

func TestComposeOwnerPriority(t *testing.T) {
	yaml := &mountMetadata{mountOwner: mountOwner{500, 0}}
	db := &mountMetadata{mountOwner: mountOwner{600, 601}}
	dir := &mountMetadata{mountOwner: mountOwner{700, 701}}
	for _, c := range []struct {
		yaml, db, dir *mountMetadata
		owner         mountOwner
		source        string
	}{
		{yaml, db, dir, mountOwner{500, 500}, "config_file"},
		{&mountMetadata{}, db, dir, db.mountOwner, "sqlite_file"},
		{nil, nil, dir, dir.mountOwner, "config_directory"},
		{nil, nil, nil, mountOwner{1000, 1000}, "default"},
	} {
		owner, source := composeOwner(c.yaml, c.db, c.dir)
		if owner != c.owner || source != c.source {
			t.Fatalf("selected %v from %s, want %v from %s", owner, source, c.owner, c.source)
		}
	}
}

func TestComposeMountsRejectUnsafeEntriesBeforeRepair(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "fifo", "wrong_type", "missing_directory", "nested_link"} {
		t.Run(kind, func(t *testing.T) {
			m := composeFixture(t)
			yaml := filepath.Join(m.roots[configMount].path, m.configFile)
			writeMountFixture(t, yaml, "private config")
			state := m.roots[stateMount].path
			path := filepath.Join(state, m.database)
			var err error
			var reason string
			switch kind {
			case "symlink":
				err, reason = os.Symlink(yaml, path), "symlink"
			case "hardlink":
				err, reason = os.Link(yaml, path), "multiple_links"
			case "fifo":
				err, reason = unix.Mkfifo(path, 0600), "unexpected_file_type"
			case "wrong_type":
				err, reason = os.Mkdir(path, 0700), "is_directory"
			case "missing_directory":
				err, reason = os.Remove(state), "not_found"
			case "nested_link":
				job := filepath.Join(m.roots[mediaMount].path, ".incoming-fixture")
				nested := filepath.Join(job, "sub")
				if err = os.MkdirAll(nested, 0755); err != nil {
					t.Fatal(err)
				}
				path = filepath.Join(nested, "alias")
				err, reason = os.Symlink(yaml, path), "symlink"
			}
			if err != nil {
				t.Fatal(err)
			}
			lock, ok := m.prepare(t.Context(), slog.Default(), func(event, cause string, _ []any) {
				if event != "mounts.prepare_failed" || cause != reason {
					t.Fatalf("expected %s, got %s %s", reason, event, cause)
				}
			}, func(mountOwner) error { t.Fatal("unsafe mount reached privilege drop"); return nil })
			if ok || lock != nil {
				t.Fatal("accepted unsafe target")
			}
			if info, err := os.Stat(yaml); err != nil || info.Mode().Perm() != 0644 {
				t.Fatal("unsafe target led to metadata changes", err)
			}
		})
	}
}

func TestComposeMountsBlockedRepairAndDropFailure(t *testing.T) {
	m := composeFixture(t)
	writeMountFixture(t, filepath.Join(m.roots[configMount].path, m.configFile), "test config")
	state, err := os.Open(m.roots[stateMount].path)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	if err = unix.Flock(int(state.Fd()), unix.LOCK_SH); err != nil {
		t.Fatal(err)
	}
	check := func(want string) func(string, string, []any) {
		return func(_, cause string, _ []any) {
			if cause != want {
				t.Fatalf("error %s, want %s", cause, want)
			}
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 80*time.Millisecond)
	defer cancel()
	if _, ok := m.prepare(ctx, slog.Default(), check("mounts_in_use"), func(mountOwner) error {
		t.Fatal("performed a repair while the sibling was serving")
		return nil
	}); ok {
		t.Fatal("blocked repair did not stop startup")
	}
	if err = unix.Flock(int(state.Fd()), unix.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.prepare(t.Context(), slog.Default(), check("permission_denied"), func(mountOwner) error { return os.ErrPermission }); ok {
		t.Fatal("started after a failed privilege drop")
	}
	if locked, err := tryMountLock(int(state.Fd()), unix.LOCK_EX); err != nil || !locked {
		t.Fatal("failed startup retained the state lock", err)
	}
	if mountOpenReason(unix.EXDEV) != "nested_mount" || mountOpenReason(unix.ENOSYS) != "kernel_openat2_required" ||
		!errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatal("incorrect startup classification")
	}
}

func TestServeRejectsCustomPathsAndUnprivilegedStartup(t *testing.T) {
	check := func(args []string, event, cause string) {
		t.Helper()
		var stderr strings.Builder
		d := Production(os.Stdout, &stderr)
		d.ReadFile = func(string) ([]byte, error) {
			t.Fatal("startup read a configuration after rejecting its invocation")
			return nil, nil
		}
		if Run(t.Context(), args, service.Build{}, d) != 1 {
			t.Fatal("invalid serve invocation passed")
		}
		var result map[string]any
		if err := json.Unmarshal([]byte(stderr.String()), &result); err != nil ||
			result["msg"] != event || result["cause"] != cause || result["operation_id"] == "" {
			t.Fatal("invalid serve invocation lacks diagnosis", result, err)
		}
	}
	check([]string{"serve", "-config", "/outside/config"}, "config.rejected", "invalid_arguments")
	if os.Geteuid() != 0 {
		check([]string{"serve"}, "mounts.prepare_failed", "root_bootstrap_required")
		owner := mountOwner{os.Getuid(), os.Getgid()}
		if err := dropComposeRoot(owner); !errors.Is(err, unix.EPERM) {
			t.Fatal("credential change unexpectedly succeeded without setgroups authority", err)
		}
	}
}

func TestRepairMetadataRechecksPinnedFilesAndRecoversAfterFailure(t *testing.T) {
	m := composeFixture(t)
	yaml := filepath.Join(m.roots[configMount].path, m.configFile)
	writeMountFixture(t, yaml, "retain these bytes")
	if failure := m.open(); failure != nil {
		t.Fatal(failure.reason)
	}
	defer m.close(false)
	root := m.roots[configMount]
	target, failure := inspectComposeEntry(root.file, m.configFile, yaml, 0600)
	if failure != nil {
		t.Fatal(failure.reason)
	}
	defer target.file.Close()
	link := filepath.Join(root.path, "other")
	if err := os.Link(yaml, link); err != nil {
		t.Fatal(err)
	}
	owner := target.observed.mountOwner
	if failure := repairMountMetadata(target, owner); failure == nil || failure.reason != "multiple_links" {
		t.Fatal("metadata repair accepted an additional link after survey")
	}
	if info, err := os.Stat(link); err != nil || info.Mode().Perm() != 0644 {
		t.Fatal("metadata repair changed linked inode", err)
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() != 0 {
		other := mountOwner{owner.UID + 1, owner.GID}
		_, failure := m.repair(mountSurvey{owner: other}, false)
		if failure == nil || failure.stage != "set_owner" || failure.reason != "permission_denied" {
			t.Fatal("partial metadata repair did not report its owner error", failure)
		}
		if info, err := os.Stat(m.roots[stateMount].path); err != nil || info.Mode().Perm() != 0755 {
			t.Fatal("a failed config repair continued changing other mounts", err)
		}
	}
	if failure := repairMountMetadata(target, owner); failure != nil {
		t.Fatal("retry did not converge", failure.reason)
	}
	if info, err := os.Stat(yaml); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("retry did not leave the required mode", err)
	}
	if body, err := os.ReadFile(yaml); err != nil || string(body) != "retain these bytes" {
		t.Fatal("metadata repair modified content", err)
	}
}

func TestComposeRejectsReadOnlyRootBeforeRepair(t *testing.T) {
	var details unix.Statfs_t
	if err := unix.Statfs("/proc/sys", &details); err != nil || details.Flags&unix.ST_RDONLY == 0 {
		t.Skip("this test needs a read-only proc sys mount")
	}
	m := composeFixture(t)
	m.roots[diagnosticsMount].path = "/proc/sys"
	var failed bool
	_, ok := m.prepare(t.Context(), slog.Default(), func(event, reason string, attrs []any) {
		failed = event == "mounts.prepare_failed" && reason == "read_only" &&
			strings.Contains(fmtAttrs(attrs), "mount a writable dedicated directory")
	}, func(mountOwner) error { t.Fatal("read-only mount reached privilege drop"); return nil })
	if ok || !failed {
		t.Fatal("read-only root did not fail with a corrective action")
	}
	info, err := os.Stat(m.roots[stateMount].path)
	if err != nil || info.Mode().Perm() != 0755 {
		t.Fatal("another mount was modified before read-only rejection", err)
	}
}

func TestComposeRepairsDedicatedDiagnosticsWhileSiblingIsServing(t *testing.T) {
	m := composeFixture(t)
	yaml := filepath.Join(m.roots[configMount].path, m.configFile)
	writeMountFixture(t, yaml, "same owner")
	start := func(m *composeMounts) mountFile {
		t.Helper()
		lock, ok := m.prepare(t.Context(), slog.Default(),
			func(event, cause string, attrs []any) { t.Log(event, cause, attrs) },
			func(mountOwner) error { return nil })
		if !ok {
			t.Fatal("startup did not complete")
		}
		return lock
	}
	first := start(m)
	defer first.Close()
	sibling := *m
	dedicated := t.TempDir()
	if err := os.Chmod(dedicated, 0755); err != nil {
		t.Fatal(err)
	}
	sibling.roots[diagnosticsMount] = mountTarget{path: dedicated, mode: 0700}
	second := start(&sibling)
	defer second.Close()
	if info, err := os.Stat(dedicated); err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("sibling did not repair its own diagnostics directory", err)
	}
}
