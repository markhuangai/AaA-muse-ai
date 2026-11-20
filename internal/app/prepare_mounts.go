package app

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

type mountOwner struct {
	UID int `json:"uid"`
	GID int `json:"gid"`
}

type mountMetadata struct {
	mountOwner
	Mode string `json:"mode"`
}

type mountTarget struct {
	path     string
	file     *os.File
	mode     fs.FileMode
	info     fs.FileInfo
	observed *mountMetadata
}

type mountFailure struct {
	target mountTarget
	stage  string
	reason string
}

func runMountPreparation(args []string, revision, configPath string, dataDirs []string, d Dependencies) int {
	attrs := []any{"operation_id", fmt.Sprintf("prepare-mounts-%d", d.Now().UnixNano()), "revision", revision}
	var owner mountOwner
	if len(args) == 1 {
		owner = parseMountOwner(args[0])
	}
	if owner == (mountOwner{}) {
		emergency(d.Stderr, "mounts.prepare_failed", "invalid_service_user",
			append(attrs, "target", "MUSE_SERVICE_USER", "reason", "invalid_service_user", "expected", "positive numeric UID:GID"))
		return 1
	}
	targets, failure := prepareMountedPaths(configPath, dataDirs, owner)
	if failure != nil {
		emergency(d.Stderr, "mounts.prepare_failed", failure.reason,
			append(attrs, "stage", failure.stage, "reason", failure.reason, "target", failure.target.path,
				"expected", mountMetadata{owner, modeString(uint32(failure.target.mode))}, "observed", failure.target.observed))
		return 1
	}
	logger := slog.New(slog.NewJSONHandler(d.Stdout, nil)).With(attrs...)
	for _, target := range targets {
		logger.Info("mounts.prepared", "target", target.path, "reason", "ready", "outcome", "prepared",
			"expected", mountMetadata{owner, modeString(uint32(target.mode))}, "observed", target.observed)
	}
	return 0
}

func parseMountOwner(value string) mountOwner {
	uidText, gidText, ok := strings.Cut(value, ":")
	if !ok {
		return mountOwner{}
	}
	uid, uidErr := strconv.ParseUint(uidText, 10, 31)
	gid, gidErr := strconv.ParseUint(gidText, 10, 31)
	if uidErr != nil || gidErr != nil || uid == 0 || gid == 0 {
		return mountOwner{}
	}
	return mountOwner{int(uid), int(gid)}
}

func prepareMountedPaths(configPath string, dataDirs []string, owner mountOwner) ([]mountTarget, *mountFailure) {
	targets := make([]mountTarget, 0, len(dataDirs)+2)
	defer func() {
		for _, target := range targets {
			_ = target.file.Close()
		}
	}()
	for _, path := range append([]string{filepath.Dir(configPath)}, dataDirs...) {
		target := mountTarget{path: path, mode: 0700}
		file, err := os.OpenFile(path, os.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
		if err != nil {
			return nil, &mountFailure{target, "open_directory", fileErrorReason(err)}
		}
		target.file = file
		targets = append(targets, target)
		if err = targets[len(targets)-1].stat(); err != nil {
			return nil, &mountFailure{target, "inspect_directory", fileErrorReason(err)}
		}
	}

	yaml, failure := openMountYAML(targets[0].file, configPath)
	if failure != nil {
		return nil, failure
	}
	targets = append(targets, yaml)
	if yaml.observed.UID != 0 && yaml.observed.mountOwner != owner {
		return nil, &mountFailure{yaml, "validate_owner", "config_owner_mismatch"}
	}

	for i, target := range targets[:len(targets)-1] {
		populated, err := inspectMountEntries(target.file)
		if err != nil {
			return nil, &mountFailure{target, "validate_entries", fileErrorReason(err)}
		}
		if i != 0 && target.observed.mountOwner != owner && populated {
			return nil, &mountFailure{target, "validate_owner", "populated_directory_owner_mismatch"}
		}
	}

	for _, target := range targets {
		if target.observed.Mode != modeString(uint32(target.mode)) {
			if err := target.file.Chmod(target.mode); err != nil {
				return nil, &mountFailure{target, "set_mode", fileErrorReason(err)}
			}
		}
		if target.observed.mountOwner != owner {
			if err := target.file.Chown(owner.UID, owner.GID); err != nil {
				return nil, &mountFailure{target, "set_owner", fileErrorReason(err)}
			}
		}
	}
	return targets, nil
}

func inspectMountEntries(dir *os.File) (bool, error) {
	populated := false
	for {
		names, readErr := dir.Readdirnames(128)
		if len(names) != 0 {
			populated = true
		}
		for _, name := range names {
			var info unix.Stat_t
			err := unix.Fstatat(int(dir.Fd()), name, &info, unix.AT_SYMLINK_NOFOLLOW)
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return populated, err
			}
			switch info.Mode & unix.S_IFMT {
			case unix.S_IFLNK:
				return populated, unix.ELOOP
			case unix.S_IFDIR:
				fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
				if errors.Is(err, fs.ErrNotExist) {
					continue
				}
				if err != nil {
					return populated, err
				}
				child := os.NewFile(uintptr(fd), name)
				_, err = inspectMountEntries(child)
				_ = child.Close()
				if err != nil {
					return populated, err
				}
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return populated, nil
			}
			return populated, readErr
		}
	}
}

func openMountYAML(dir *os.File, path string) (mountTarget, *mountFailure) {
	target := mountTarget{path: path, mode: 0600}
	// O_PATH pins the inode before opening it for metadata changes, even if the entry is a FIFO or device.
	fd, err := unix.Openat(int(dir.Fd()), filepath.Base(path), unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return target, &mountFailure{target, "open_config", fileErrorReason(err)}
	}
	pinned := os.NewFile(uintptr(fd), path)
	defer pinned.Close()
	target.file = pinned
	if err = target.stat(); err != nil {
		return target, &mountFailure{target, "inspect_config", fileErrorReason(err)}
	}
	switch {
	case target.info.IsDir():
		return target, &mountFailure{target, "validate_config", "is_directory"}
	case target.info.Mode()&fs.ModeSymlink != 0:
		return target, &mountFailure{target, "validate_config", "symlink"}
	case !target.info.Mode().IsRegular():
		return target, &mountFailure{target, "validate_config", "not_regular_file"}
	case target.info.Sys().(*syscall.Stat_t).Nlink != 1:
		return target, &mountFailure{target, "validate_config", "multiple_links"}
	}
	target.file, err = os.Open("/proc/self/fd/" + strconv.Itoa(fd))
	if err != nil {
		return target, &mountFailure{target, "open_config", fileErrorReason(err)}
	}
	return target, nil
}

func (target *mountTarget) stat() error {
	info, err := target.file.Stat()
	if err != nil {
		return err
	}
	stat := info.Sys().(*syscall.Stat_t)
	target.info = info
	target.observed = &mountMetadata{mountOwner{int(stat.Uid), int(stat.Gid)}, modeString(uint32(stat.Mode))}
	return nil
}

func modeString(mode uint32) string { return fmt.Sprintf("%04o", mode&07777) }

func fileErrorReason(err error) string {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "not_found"
	case errors.Is(err, fs.ErrPermission):
		return "permission_denied"
	case errors.Is(err, unix.EISDIR):
		return "is_directory"
	case errors.Is(err, unix.ELOOP):
		return "symlink"
	case errors.Is(err, unix.ENOTDIR):
		return "not_directory"
	case errors.Is(err, unix.EROFS):
		return "read_only"
	default:
		return "io_error"
	}
}
