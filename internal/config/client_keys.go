package config

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode"

	"go.yaml.in/yaml/v3"
)

type ClientKeyError struct {
	Code, Stage, Cause string
}

func (e *ClientKeyError) Error() string { return e.Code }

type clientKeySnapshot struct {
	source fs.FileInfo
	config Config
}

type ClientKeyFile struct {
	path   string
	lookup func(string) (string, bool)
	mu     sync.Mutex
	active atomic.Pointer[clientKeySnapshot]
	rename func(string, string) error
	sync   func(*os.File) error
}

func NewClientKeyFile(path string, lookup func(string) (string, bool), initial Config) *ClientKeyFile {
	file := &ClientKeyFile{path: path, lookup: lookup, rename: os.Rename, sync: (*os.File).Sync}
	file.active.Store(&clientKeySnapshot{config: initial})
	return file
}

// Current returns an immutable snapshot of startup settings and active client keys.
func (f *ClientKeyFile) Current() *Config { return &f.active.Load().config }

func sameSource(a, b fs.FileInfo) bool {
	return a != nil && b != nil && os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
}

func (f *ClientKeyFile) Refresh() error {
	source, err := os.Stat(f.path)
	if err != nil {
		return keyFileFailure("stat", err)
	}
	if !source.Mode().IsRegular() {
		return &ClientKeyError{"client_key_save_failed", "stat", "regular_config_file_required"}
	}
	if sameSource(source, f.active.Load().source) {
		return nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	raw, source, err := readKeyFile(f.path)
	if err != nil {
		return keyFileFailure("read", err)
	}
	if sameSource(source, f.active.Load().source) {
		return nil
	}
	disk, err := Parse(raw, f.lookup)
	if err != nil {
		return keyFileFailure("validate", err)
	}
	next, err := f.withKeys(disk.ClientKeys)
	if err != nil {
		return keyFileFailure("validate_active_roles", err)
	}
	f.active.Store(&clientKeySnapshot{source: source, config: next})
	return nil
}

func (f *ClientKeyFile) withKeys(keys map[string]Secret) (Config, error) {
	next := *f.Current()
	next.ClientKeys = keys
	return next, next.Validate()
}

func (f *ClientKeyFile) Create(ctx context.Context, name string, key Secret) error {
	if name == "" || len(name) > 100 || strings.TrimSpace(name) != name || strings.ContainsFunc(name, unicode.IsControl) ||
		!usableBearerKey(key) || strings.Contains(name, "${") || strings.Contains(string(key), "${") || strings.Contains(name, string(key)) {
		return &ClientKeyError{"invalid_client_key", "validate_input", "invalid_name_or_bearer_key"}
	}
	dir, err := os.Open(filepath.Dir(f.path))
	if err != nil {
		return keyFileFailure("open_directory", err)
	}
	defer dir.Close()
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err = lockDirectory(bounded, dir); err != nil {
		return keyFileFailure("lock_directory", err)
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	source, err := os.Lstat(f.path)
	if err != nil {
		return keyFileFailure("stat", err)
	}
	if !source.Mode().IsRegular() {
		return &ClientKeyError{"client_key_save_failed", "stat", "regular_config_file_required"}
	}
	raw, observed, err := readKeyFile(f.path)
	if err != nil {
		return keyFileFailure("read", err)
	}
	if !sameSource(source, observed) {
		return changedKeyFile()
	}
	disk, err := Parse(raw, f.lookup)
	if err != nil {
		return keyFileFailure("validate", err)
	}
	if _, exists := disk.ClientKeys[name]; exists {
		return &ClientKeyError{"client_key_conflict", "validate_input", "name_in_use"}
	}
	for _, credential := range append(disk.Secrets(), f.Current().Secrets()...) {
		if credential != "" && string(key) == credential {
			return &ClientKeyError{"client_key_conflict", "validate_input", "credential_in_use"}
		}
	}
	updated, err := appendClientKey(raw, name, key)
	if err != nil {
		return keyFileFailure("edit", err)
	}
	disk, err = Parse(updated, f.lookup)
	if err != nil {
		return keyFileFailure("validate_update", err)
	}
	next, err := f.withKeys(disk.ClientKeys)
	if err != nil {
		return keyFileFailure("validate_active_roles", err)
	}
	return f.replace(ctx, dir, source, updated, next)
}

func (f *ClientKeyFile) replace(ctx context.Context, dir *os.File, source fs.FileInfo, raw []byte, next Config) error {
	tmp, err := os.CreateTemp(dir.Name(), ".config-*.tmp")
	if err != nil {
		return keyFileFailure("create_temporary", err)
	}
	defer os.Remove(tmp.Name())
	info, err := writeKeyFile(tmp, raw)
	if err != nil {
		return err
	}
	observed, err := os.Lstat(f.path)
	if err != nil {
		return keyFileFailure("check_source", err)
	}
	if !sameSource(source, observed) {
		return changedKeyFile()
	}
	if err = ctx.Err(); err != nil {
		return keyFileFailure("check_request", err)
	}
	if err = f.rename(tmp.Name(), f.path); err != nil {
		return keyFileFailure("replace", err)
	}
	err = f.sync(dir)
	// A failed directory sync leaves durability uncertain, but the new file is already visible.
	f.active.Store(&clientKeySnapshot{source: info, config: next})
	if err != nil {
		failure := keyFileFailure("sync_directory", err)
		failure.Code = "client_key_save_uncertain"
		return failure
	}
	return nil
}

func writeKeyFile(f *os.File, raw []byte) (fs.FileInfo, error) {
	defer f.Close()
	if _, err := f.Write(raw); err != nil {
		return nil, keyFileFailure("write_temporary", err)
	}
	if err := f.Sync(); err != nil {
		return nil, keyFileFailure("sync_temporary", err)
	}
	info, err := f.Stat()
	if err != nil {
		return nil, keyFileFailure("stat_temporary", err)
	}
	if err = f.Close(); err != nil {
		return nil, keyFileFailure("close_temporary", err)
	}
	return info, nil
}

func readKeyFile(path string) ([]byte, fs.FileInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, &Error{Field: "configuration", Reason: "regular_config_file_required"}
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxConfigBytes+1))
	return raw, info, err
}

func lockDirectory(ctx context.Context, dir *os.File) error {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := syscall.Flock(int(dir.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err != syscall.EWOULDBLOCK && err != syscall.EINTR {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func appendClientKey(raw []byte, name string, key Secret) ([]byte, error) {
	doc, err := parseDocument(raw)
	if err != nil {
		return nil, err
	}
	root := doc.Content[0]
	var keys *yaml.Node
	for i := 0; i < len(root.Content); i += 2 {
		if root.Content[i].Value == "client-keys" {
			keys = root.Content[i+1]
			break
		}
	}
	if keys == nil {
		keys = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "client-keys"}, keys)
	} else if keys.Tag == "!!null" {
		keys.Kind, keys.Tag, keys.Value, keys.Style = yaml.MappingNode, "!!map", "", 0
	}
	keys.Content = append(keys.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name, Style: yaml.DoubleQuotedStyle},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: string(key), Style: yaml.DoubleQuotedStyle})
	var encoded strings.Builder
	encoder := yaml.NewEncoder(&encoded)
	encoder.SetIndent(2)
	if err := encoder.Encode(doc); err != nil {
		return nil, err
	}
	return []byte(encoded.String()), encoder.Close()
}

func changedKeyFile() *ClientKeyError {
	return &ClientKeyError{"client_key_conflict", "check_source", "configuration_changed"}
}

func keyFileFailure(stage string, err error) *ClientKeyError {
	cause := "filesystem_io_failed"
	var invalid *Error
	var errno syscall.Errno
	switch {
	case errors.As(err, &invalid):
		cause = invalid.Reason
	case errors.As(err, &errno):
		cause = errno.Error()
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		cause = err.Error()
	}
	return &ClientKeyError{"client_key_save_failed", stage, cause}
}
