package app

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	configMount = iota
	stateMount
	mediaMount
	diagnosticsMount
)

type composeMounts struct {
	roots      [4]mountTarget
	configFile string
	database   string
}

type mountSurvey struct {
	owner        mountOwner
	source       string
	missing      bool
	empty        [4]bool
	repair       bool
	sharedRepair bool
}

func (m *composeMounts) open() *mountFailure {
	for i := range m.roots {
		target := &m.roots[i]
		fd, err := unix.Openat2(unix.AT_FDCWD, target.path, &unix.OpenHow{
			Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS,
		})
		if err != nil {
			return &mountFailure{*target, "open_directory", mountOpenReason(err)}
		}
		target.file = os.NewFile(uintptr(fd), target.path)
		if err = target.stat(); err != nil {
			return &mountFailure{*target, "inspect_directory", fileErrorReason(err)}
		}
		var info unix.Statfs_t
		if err = unix.Fstatfs(fd, &info); err != nil {
			return &mountFailure{*target, "inspect_filesystem", fileErrorReason(err)}
		}
		if info.Flags&unix.ST_RDONLY != 0 {
			return &mountFailure{*target, "inspect_filesystem", "read_only"}
		}
	}
	return nil
}

func (m *composeMounts) close(keepState bool) {
	for i, target := range m.roots {
		if target.file != nil && !(i == stateMount && keepState) {
			_ = target.file.Close()
		}
	}
}

func (m *composeMounts) survey() (mountSurvey, *mountFailure) {
	var result mountSurvey
	config, failure := inspectComposeEntry(m.roots[configMount].file, m.configFile, filepath.Join(m.roots[configMount].path, m.configFile), 0600)
	if failure != nil && failure.reason != "not_found" {
		return result, failure
	}
	result.missing = failure != nil
	if config.file != nil {
		_ = config.file.Close()
	}
	db, failure := inspectComposeEntry(m.roots[stateMount].file, m.database, filepath.Join(m.roots[stateMount].path, m.database), 0600)
	if failure != nil && failure.reason != "not_found" {
		return result, failure
	}
	if db.file != nil {
		_ = db.file.Close()
	}
	if err := m.roots[configMount].stat(); err != nil {
		return result, &mountFailure{m.roots[configMount], "inspect_directory", fileErrorReason(err)}
	}
	result.owner, result.source = composeOwner(config.observed, db.observed, m.roots[configMount].observed)
	for i := range m.roots {
		root := &m.roots[i]
		if err := root.stat(); err != nil {
			return result, &mountFailure{*root, "inspect_directory", fileErrorReason(err)}
		}
		dirty := needsMountRepair(*root, result.owner)
		empty, failure := walkComposeMount(*root, func(path string) fs.FileMode {
			return m.entryMode(i, path)
		}, func(entry mountTarget) *mountFailure {
			dirty = dirty || needsMountRepair(entry, result.owner)
			return nil
		})
		if failure != nil {
			return result, failure
		}
		result.empty[i] = empty
		if !result.missing || i == configMount || empty {
			result.repair = result.repair || dirty
			result.sharedRepair = result.sharedRepair || (dirty && i != diagnosticsMount)
		}
	}
	return result, nil
}

func composeOwner(yaml, db, dir *mountMetadata) (mountOwner, string) {
	candidates := []struct {
		metadata *mountMetadata
		source   string
	}{{yaml, "config_file"}, {db, "sqlite_file"}, {dir, "config_directory"}}
	for _, candidate := range candidates {
		if candidate.metadata != nil && candidate.metadata.UID > 0 {
			owner := candidate.metadata.mountOwner
			if owner.GID == 0 {
				owner.GID = owner.UID
			}
			return owner, candidate.source
		}
	}
	return mountOwner{1000, 1000}, "default"
}

func (m *composeMounts) repair(s mountSurvey, diagnosticsOnly bool) (int, *mountFailure) {
	changed := 0
	for i, root := range m.roots {
		if (diagnosticsOnly && i != diagnosticsMount) || (s.missing && i != configMount && !s.empty[i]) {
			continue
		}
		repair := func(entry mountTarget) *mountFailure {
			if !needsMountRepair(entry, s.owner) {
				return nil
			}
			if failure := repairMountMetadata(entry, s.owner); failure != nil {
				return failure
			}
			changed++
			return nil
		}
		_, failure := walkComposeMount(root, func(path string) fs.FileMode { return m.entryMode(i, path) }, repair)
		if failure != nil {
			return changed, failure
		}
		if failure = repair(root); failure != nil {
			return changed, failure
		}
	}
	return changed, nil
}

func needsMountRepair(target mountTarget, owner mountOwner) bool {
	return target.mode != 0 && (target.observed.mountOwner != owner || target.observed.Mode != modeString(uint32(target.mode)))
}

func repairMountMetadata(target mountTarget, owner mountOwner) *mountFailure {
	opened, err := (osMountFilesystem{}).openPinnedFile(target.file)
	if err != nil {
		return &mountFailure{target, "open_metadata", fileErrorReason(err)}
	}
	defer opened.Close()
	target.file = opened
	if err = target.stat(); err != nil {
		return &mountFailure{target, "inspect_entry", fileErrorReason(err)}
	}
	if target.info.Mode().IsRegular() && target.info.Sys().(*syscall.Stat_t).Nlink != 1 {
		return &mountFailure{target, "validate_entry", "multiple_links"}
	}
	if target.observed.Mode != modeString(uint32(target.mode)) {
		if err = target.file.Chmod(target.mode); err != nil {
			return &mountFailure{target, "set_mode", fileErrorReason(err)}
		}
	}
	if target.observed.mountOwner != owner {
		if err = target.file.Chown(owner.UID, owner.GID); err != nil {
			return &mountFailure{target, "set_owner", fileErrorReason(err)}
		}
	}
	return nil
}

var managedMediaJob = regexp.MustCompile("^[a-f0-9]{32}$")

func (m *composeMounts) entryMode(i int, relative string) fs.FileMode {
	name, child, nested := strings.Cut(relative, "/")
	switch i {
	case configMount:
		if !nested && (name == m.configFile || strings.HasPrefix(name, ".config-") && strings.HasSuffix(name, ".tmp")) {
			return 0600
		}
	case stateMount:
		if !nested {
			switch name {
			case m.database, m.database + "-wal", m.database + "-shm", m.database + "-journal":
				return 0600
			}
		}
	case diagnosticsMount:
		if !nested && (name == "retention.json" || name == "retention.json.tmp" ||
			(strings.HasPrefix(name, "capture-") || strings.HasPrefix(name, "segment-")) && (strings.HasSuffix(name, ".ndjson") || strings.HasSuffix(name, ".ndjson.tmp"))) {
			return 0600
		}
	case mediaMount:
		if managedMediaJob.MatchString(name) || strings.HasPrefix(name, ".incoming-") {
			if !nested {
				return 0700
			}
			switch child {
			case "prompt", "image", "artifact", "download-token", "download-token.pending":
				return 0600
			}
		}
		if !nested && (name == ".aaa-muse-media-v1" || strings.HasPrefix(name, ".upload-")) {
			return 0600
		}
	}
	return 0
}

func inspectComposeEntry(dir mountFile, name, logPath string, mode fs.FileMode) (mountTarget, *mountFailure) {
	target := mountTarget{path: logPath, mode: mode}
	fd, err := unix.Openat2(int(dir.Fd()), name, &unix.OpenHow{
		Flags: unix.O_PATH | unix.O_CLOEXEC | unix.O_NOFOLLOW, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV,
	})
	if err != nil {
		return target, &mountFailure{target, "open_entry", mountOpenReason(err)}
	}
	target.file = os.NewFile(uintptr(fd), name)
	if err = target.stat(); err != nil {
		_ = target.file.Close()
		return mountTarget{}, &mountFailure{target, "inspect_entry", fileErrorReason(err)}
	}
	var reason string
	switch {
	case target.info.Mode()&fs.ModeSymlink != 0:
		reason = "symlink"
	case target.info.IsDir():
		if mode == 0600 {
			reason = "is_directory"
		}
	case !target.info.Mode().IsRegular() || mode == 0700:
		reason = "unexpected_file_type"
	case target.info.Sys().(*syscall.Stat_t).Nlink != 1:
		reason = "multiple_links"
	}
	if reason != "" {
		_ = target.file.Close()
		return mountTarget{}, &mountFailure{target, "validate_entry", reason}
	}
	return target, nil
}

func walkComposeMount(root mountTarget, mode func(string) fs.FileMode, visit func(mountTarget) *mountFailure) (bool, *mountFailure) {
	var walk func(mountTarget, string) (bool, *mountFailure)
	walk = func(target mountTarget, prefix string) (bool, *mountFailure) {
		dir, err := (osMountFilesystem{}).openPinnedFile(target.file)
		if err != nil {
			return false, &mountFailure{target, "open_directory", fileErrorReason(err)}
		}
		defer dir.Close()
		empty := true
		for {
			names, readErr := dir.Readdirnames(128)
			for _, name := range names {
				relative := prefix + name
				entry, failure := inspectComposeEntry(dir, name, filepath.Join(root.path, relative), mode(relative))
				if failure != nil {
					if failure.reason == "not_found" {
						continue
					}
					return false, failure
				}
				empty = false
				if entry.info.IsDir() {
					_, failure = walk(entry, relative+"/")
				}
				if failure == nil && entry.mode != 0 {
					failure = visit(entry)
				}
				_ = entry.file.Close()
				if failure != nil {
					return false, failure
				}
			}
			if errors.Is(readErr, io.EOF) {
				return empty, nil
			}
			if readErr != nil {
				return false, &mountFailure{target, "list_directory", fileErrorReason(readErr)}
			}
		}
	}
	return walk(root, "")
}

func mountOpenReason(err error) string {
	switch {
	case errors.Is(err, unix.EXDEV):
		return "nested_mount"
	case errors.Is(err, unix.ENOSYS):
		return "kernel_openat2_required"
	default:
		return fileErrorReason(err)
	}
}

func (m *composeMounts) prepare(ctx context.Context, logger *slog.Logger, fatal func(string, string, []any), drop func(mountOwner) error) (mountFile, bool) {
	var keepState bool
	defer func() { m.close(keepState) }()
	owner := mountOwner{}
	fail := func(f *mountFailure) (mountFile, bool) {
		fatal("mounts.prepare_failed", f.reason, []any{"stage", f.stage, "target", f.target.path,
			"reason", f.reason, "expected", mountMetadata{owner, modeString(uint32(f.target.mode))},
			"observed", f.target.observed, "corrective_action", mountCorrection(f.reason)})
		return nil, false
	}
	if failure := m.open(); failure != nil {
		return fail(failure)
	}
	state := m.roots[stateMount].file
	fd := int(state.Fd())
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	started := time.Now()
	changed := 0
	lockTarget, lockStage := m.roots[stateMount], "lock_state"
	for bounded.Err() == nil {
		locked, err := tryMountLock(fd, unix.LOCK_SH)
		if err != nil {
			return fail(&mountFailure{m.roots[stateMount], "lock_state", fileErrorReason(err)})
		}
		if locked {
			survey, failure := m.survey()
			owner = survey.owner
			if failure != nil {
				return fail(failure)
			}
			if !survey.repair {
				details := []any{"owner_source", survey.source, "selected_identity", owner,
					"expected_directory_mode", "0700", "expected_file_mode", "0600", "metadata_repairs", changed,
					"duration_ms", time.Since(started).Milliseconds()}
				if survey.missing {
					logger.Info("mounts.prepared", append(details, "outcome", "awaiting_configuration")...)
					target := mountTarget{path: filepath.Join(m.roots[configMount].path, m.configFile), mode: 0600}
					return fail(&mountFailure{target, "open_config", "not_found"})
				}
				if err = drop(owner); err != nil {
					return fail(&mountFailure{m.roots[stateMount], "drop_privileges", fileErrorReason(err)})
				}
				logger.Info("mounts.prepared", append(details, "outcome", "prepared", "serving_identity", owner)...)
				keepState = true
				return state, true
			}
			lockTarget, lockStage = m.roots[stateMount], "lock_state"
			if survey.sharedRepair {
				if err = unix.Flock(fd, unix.LOCK_UN); err != nil {
					return fail(&mountFailure{lockTarget, lockStage, fileErrorReason(err)})
				}
			} else {
				// A private diagnostics mount can be repaired while another broker serves the same state.
				lockTarget, lockStage = m.roots[diagnosticsMount], "lock_diagnostics"
			}
			repairFD := int(lockTarget.file.Fd())
			locked, err = tryMountLock(repairFD, unix.LOCK_EX)
			if err != nil {
				return fail(&mountFailure{lockTarget, lockStage, fileErrorReason(err)})
			}
			if locked {
				survey, failure = m.survey()
				owner = survey.owner
				if failure != nil {
					return fail(failure)
				}
				repaired, failure := m.repair(survey, repairFD != fd)
				changed += repaired
				if failure != nil {
					return fail(failure)
				}
				if err = unix.Flock(repairFD, unix.LOCK_UN); err != nil {
					return fail(&mountFailure{lockTarget, lockStage, fileErrorReason(err)})
				}
				continue
			}
		}
		if err := sleep(bounded, 20*time.Millisecond); err != nil {
			break
		}
	}
	return fail(&mountFailure{lockTarget, lockStage, "mounts_in_use"})
}

func tryMountLock(fd, kind int) (bool, error) {
	err := unix.Flock(fd, kind|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EINTR) {
		return false, nil
	}
	return err == nil, err
}

func dropComposeRoot(owner mountOwner) error {
	// The Go syscall wrappers change credentials on all threads in the static broker.
	if err := syscall.Setgroups(nil); err != nil {
		return err
	}
	if err := syscall.Setresgid(owner.GID, owner.GID, owner.GID); err != nil {
		return err
	}
	return syscall.Setresuid(owner.UID, owner.UID, owner.UID)
}

func mountCorrection(reason string) string {
	switch reason {
	case "not_found":
		return "supply config/config.yaml in the Compose directory and check the mounted paths"
	case "read_only":
		return "mount a writable dedicated directory at this target"
	case "symlink", "multiple_links", "unexpected_file_type", "nested_mount", "is_directory":
		return "use dedicated directories with regular singly linked broker files and no nested mounts"
	case "root_bootstrap_required":
		return "start the Compose service with the shipped root user and capability settings"
	case "mounts_in_use":
		return "check the reported mount for another broker and stop its writers before changing ownership"
	case "kernel_openat2_required":
		return "use Docker on a Linux kernel that supports openat2"
	default:
		return "check the bind source or volume and use the shipped Compose capability settings"
	}
}
