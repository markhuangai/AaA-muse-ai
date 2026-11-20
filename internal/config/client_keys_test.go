package config

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func keyFixture(t *testing.T, raw string, lookup func(string) (string, bool)) (string, *ClientKeyFile) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(os.ReadFile, lookup, path)
	if err != nil {
		t.Fatal(err)
	}
	return path, NewClientKeyFile(path, lookup, c)
}

func TestClientKeyFileConcurrentCreatePreservesDocumentAndReloads(t *testing.T) {
	raw := "# operator settings\n" + strings.Replace(fixture, "  local: client-sentinel", "  local: ${CLIENT} # existing entry", 1)
	lookup := func(name string) (string, bool) { return "client-sentinel", name == "CLIENT" }
	path, first := keyFixture(t, raw, lookup)
	second := NewClientKeyFile(path, lookup, *first.Current())
	if err := second.Refresh(); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	go func() { results <- first.Create(context.Background(), "alice", "first-custom-value") }()
	go func() { results <- second.Create(context.Background(), "bob", "second-custom-value") }()
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	for _, broker := range []*ClientKeyFile{first, second} {
		if err := broker.Refresh(); err != nil {
			t.Fatal(err)
		}
		if keys := broker.Current().ClientKeys; len(keys) != 3 || keys["alice"] != "first-custom-value" ||
			keys["bob"] != "second-custom-value" || keys["local"] != "client-sentinel" {
			t.Fatal("reload lost existing or concurrently added keys")
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"# operator settings", "${CLIENT} # existing entry", "client-keys:"} {
		if !strings.Contains(string(data), value) {
			t.Fatal("operator YAML lost comments or environment references")
		}
	}
	if strings.Index(string(data), "management:") > strings.Index(string(data), "client-keys:") {
		t.Fatal("operator YAML order changed")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("replacement permissions are unsafe", err)
	}
	restarted, err := Load(os.ReadFile, lookup, path)
	if err != nil || restarted.ClientKeys["alice"] != "first-custom-value" {
		t.Fatal("key did not survive a new load", err)
	}
}

func TestClientKeyFileReportsPrecommitAndUncertainWrites(t *testing.T) {
	path, f := keyFixture(t, fixture, absent)
	f.rename = func(string, string) error { return syscall.EROFS }
	before := f.Current()
	err := f.Create(context.Background(), "alice", "first-custom-value")
	if failure, ok := err.(*ClientKeyError); !ok || failure.Code != "client_key_save_failed" || failure.Stage != "replace" ||
		failure.Cause != syscall.EROFS.Error() {
		t.Fatal("read-only replacement failure was not diagnosed", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != fixture || f.Current() != before {
		t.Fatal("failed replacement mutated file or active keys", err)
	}
	f.rename = os.Rename
	f.sync = func(*os.File) error { return syscall.EIO }
	err = f.Create(context.Background(), "alice", "first-custom-value")
	if failure, ok := err.(*ClientKeyError); !ok || failure.Code != "client_key_save_uncertain" || failure.Stage != "sync_directory" {
		t.Fatal("an uncertain replacement was reported as definite", err)
	}
	c, err := Load(os.ReadFile, absent, path)
	if err != nil || c.ClientKeys["alice"] != "first-custom-value" || f.Current().ClientKeys["alice"] != c.ClientKeys["alice"] {
		t.Fatal("visible file and active keys disagree after replacement", err)
	}
	files, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(files) != 1 || files[0].Name() != "config.yaml" {
		t.Fatal("temporary file survived write", err)
	}
}

func TestClientKeyFileHandlesEmptyConfigAndInvalidReload(t *testing.T) {
	base := strings.Split(fixture, "client-keys:")[0]
	for _, suffix := range []string{"", "client-keys: {}\n", "client-keys: null # empty\n"} {
		path, f := keyFixture(t, base+suffix, absent)
		if err := f.Create(context.Background(), "new named client", "external-key"); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("client-keys: ["), 0600); err != nil {
			t.Fatal(err)
		}
		if err := f.Refresh(); err == nil || f.Current().ClientKeys["new named client"] != "external-key" {
			t.Fatal("invalid reload replaced the last valid snapshot")
		}
	}
}
