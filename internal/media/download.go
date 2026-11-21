package media

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"strings"
)

const downloadTokenFile = "download-token"

func (s *Store) ReadDownloadToken(id string) (string, error) {
	f, err := s.Open(id, downloadTokenFile)
	if err != nil {
		return "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 128))
	return string(data), err
}

// The caller holds the shared SQLite writer transaction while publishing the token.
func (s *Store) WriteDownloadToken(id, token string) error {
	if !jobDir.MatchString(id) {
		return fs.ErrInvalid
	}
	job, err := openJobRoot(s.Dir, id)
	if err != nil {
		return err
	}
	defer job.Close()

	const pending = downloadTokenFile + ".pending"
	if err = job.Remove(pending); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	f, err := job.OpenFile(pending, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, _, err = writeBounded(f, strings.NewReader(token), 128); err != nil {
		return err
	}
	if err = job.Rename(pending, downloadTokenFile); err != nil {
		return err
	}
	dir, err := job.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
