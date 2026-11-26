package diagnostics

import (
	"errors"
	"io"
	"io/fs"
	"os"

	"golang.org/x/sys/unix"
)

type AppendFile interface {
	io.WriteCloser
	Sync() error
}

type Files interface {
	MkdirAll(string, fs.FileMode) error
	Chmod(string, fs.FileMode) error
	ReadDir(string) ([]fs.DirEntry, error)
	ReadFile(string) ([]byte, error)
	WriteFile(string, []byte, fs.FileMode) error
	Rename(string, string) error
	Remove(string) error
	Lstat(string) (fs.FileInfo, error)
	CreateAppend(string) (AppendFile, error)
	OpenRead(string) (*os.File, error)
	CheckDirWritable(string) error
}

type OSFiles struct{}

func (OSFiles) MkdirAll(p string, m fs.FileMode) error  { return os.MkdirAll(p, m) }
func (OSFiles) Chmod(p string, m fs.FileMode) error     { return os.Chmod(p, m) }
func (OSFiles) ReadDir(p string) ([]fs.DirEntry, error) { return os.ReadDir(p) }
func (OSFiles) ReadFile(p string) ([]byte, error)       { return os.ReadFile(p) }
func (OSFiles) Rename(a, b string) error                { return os.Rename(a, b) }
func (OSFiles) Remove(p string) error                   { return os.Remove(p) }
func (OSFiles) Lstat(p string) (fs.FileInfo, error)     { return os.Lstat(p) }
func (OSFiles) CreateAppend(p string) (AppendFile, error) {
	return os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_APPEND|os.O_WRONLY, 0600)
}
func (OSFiles) OpenRead(p string) (*os.File, error) {
	return os.OpenFile(p, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
}
func (files OSFiles) CheckDirWritable(p string) error {
	info, err := files.Lstat(p)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
		return errors.New("capture_directory_invalid")
	}
	if info.Mode().Perm()&0200 == 0 {
		err = fs.ErrPermission
	} else {
		err = unix.Faccessat(unix.AT_FDCWD, p, unix.W_OK|unix.X_OK, unix.AT_EACCESS)
	}
	if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
		err = fs.ErrPermission
	}
	if err != nil {
		return &fs.PathError{Op: "check_diagnostics_directory", Path: p, Err: err}
	}
	return nil
}
func (OSFiles) WriteFile(p string, b []byte, m fs.FileMode) error {
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, m)
	if err != nil {
		return err
	}
	if _, err = f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
