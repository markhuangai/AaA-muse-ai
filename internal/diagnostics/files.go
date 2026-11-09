package diagnostics

import (
	"io/fs"
	"os"
)

type Files interface {
	MkdirAll(string, fs.FileMode) error
	Chmod(string, fs.FileMode) error
	ReadDir(string) ([]fs.DirEntry, error)
	ReadFile(string) ([]byte, error)
	WriteFile(string, []byte, fs.FileMode) error
	Rename(string, string) error
	Remove(string) error
	Lstat(string) (fs.FileInfo, error)
}

type OSFiles struct{}

func (OSFiles) MkdirAll(p string, m fs.FileMode) error  { return os.MkdirAll(p, m) }
func (OSFiles) Chmod(p string, m fs.FileMode) error     { return os.Chmod(p, m) }
func (OSFiles) ReadDir(p string) ([]fs.DirEntry, error) { return os.ReadDir(p) }
func (OSFiles) ReadFile(p string) ([]byte, error)       { return os.ReadFile(p) }
func (OSFiles) Rename(a, b string) error                { return os.Rename(a, b) }
func (OSFiles) Remove(p string) error                   { return os.Remove(p) }
func (OSFiles) Lstat(p string) (fs.FileInfo, error)     { return os.Lstat(p) }
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
