package media

import (
	"io"
	"io/fs"
	"os"
)

type stagedFile interface {
	io.WriteCloser
	Name() string
	Sync() error
}

type fileOps struct {
	mkdirTemp  func(string, string) (string, error)
	createTemp func(string, string) (stagedFile, error)
	openFile   func(string, int, os.FileMode) (stagedFile, error)
	open       func(string) (io.ReadSeekCloser, error)
	openJob    func(string, string, string) (fs.File, error)
	stat       func(string) (os.FileInfo, error)
	readDir    func(string) ([]os.DirEntry, error)
	rename     func(string, string) error
	remove     func(string) error
	removeAll  func(string) error
	syncDir    func(string) error
}

func localFiles() fileOps {
	return fileOps{
		mkdirTemp: os.MkdirTemp, stat: os.Stat, readDir: os.ReadDir, openJob: openJob,
		createTemp: func(dir, pattern string) (stagedFile, error) { return os.CreateTemp(dir, pattern) },
		openFile: func(name string, flag int, mode os.FileMode) (stagedFile, error) {
			return os.OpenFile(name, flag, mode)
		},
		open:   func(name string) (io.ReadSeekCloser, error) { return os.Open(name) },
		rename: os.Rename, remove: os.Remove, removeAll: os.RemoveAll, syncDir: syncDir,
	}
}

func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
