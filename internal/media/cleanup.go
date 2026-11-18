package media

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var jobDir = regexp.MustCompile("^[a-f0-9]{32}$")

func (s *Store) Cleanup(ctx context.Context, logger *slog.Logger, now time.Time, states func(context.Context, []string) (map[string]string, error)) error {
	files, err := s.files.readDir(s.Dir)
	if err != nil {
		return err
	}
	var ids []string
	for _, f := range files {
		if f.IsDir() && jobDir.MatchString(f.Name()) {
			ids = append(ids, f.Name())
		}
	}
	known := map[string]string{}
	if len(ids) > 0 {
		known, err = states(ctx, ids)
		if err != nil {
			return err
		}
	}
	for _, f := range files {
		id := f.Name()
		jobDirectory := f.IsDir() && (jobDir.MatchString(id) || strings.HasPrefix(id, ".incoming-"))
		uploadFile := f.Type().IsRegular() && strings.HasPrefix(id, ".upload-")
		if !jobDirectory && !uploadFile {
			continue
		}
		state := known[id]
		switch state {
		case "active":
			continue
		case "completed":
			if err = s.ClearInputs(id); err != nil {
				return err
			}
			continue
		case "":
			info, statErr := f.Info()
			if errors.Is(statErr, os.ErrNotExist) {
				continue
			}
			if statErr != nil {
				return statErr
			}
			if now.Sub(info.ModTime()) <= JobTimeout {
				continue
			}
			state = "orphan"
		}
		if err = s.files.removeAll(filepath.Join(s.Dir, id)); err != nil {
			return err
		}
		logger.Info("media.files_deleted", "operation_id", id, "job_id", id, "reason", state, "outcome", "removed")
	}
	return nil
}
