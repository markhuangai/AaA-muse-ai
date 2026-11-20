package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func mountFixture(t *testing.T) (string, string, mountOwner) {
	t.Helper()
	root := t.TempDir()
	cfg := filepath.Join(root, "config")
	data := filepath.Join(root, "data")
	for _, path := range []string{cfg, data} {
		if err := os.Mkdir(path, 0755); err != nil {
			t.Fatal(err)
		}
	}
	return filepath.Join(cfg, "config.yaml"), data, mountOwner{os.Getuid(), os.Getgid()}
}

func TestPrepareMountsPreservesConfigAndModes(t *testing.T) {
	configPath, data, owner := mountFixture(t)
	if owner.UID == 0 || owner.GID == 0 {
		t.Skip("requires an ordinary numeric user")
	}
	contents := []byte("# operator configuration\n")
	if err := os.WriteFile(configPath, contents, 0644); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	d := Production(&stdout, &stderr)
	for i := 0; i < 2; i++ {
		if code := runMountPreparation([]string{fmt.Sprintf("%d:%d", owner.UID, owner.GID)}, "fixture", configPath, []string{data}, d); code != 0 {
			t.Fatalf("setup failed: %s", stderr.String())
		}
	}
	decoder := json.NewDecoder(&stdout)
	for i := 0; i < 6; i++ {
		var event struct {
			Level     string        `json:"level"`
			Message   string        `json:"msg"`
			Operation string        `json:"operation_id"`
			Expected  mountMetadata `json:"expected"`
		}
		if err := decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		expectedMode := "0700"
		if i%3 == 2 {
			expectedMode = "0600"
		}
		if event.Message != "mounts.prepared" || event.Level != "INFO" || event.Operation == "" ||
			event.Expected.mountOwner != owner || event.Expected.Mode != expectedMode {
			t.Fatalf("incomplete receipt: %#v", event)
		}
	}
	got, err := os.ReadFile(configPath)
	if err != nil || !bytes.Equal(got, contents) {
		t.Fatalf("config changed or became unreadable: %v", err)
	}
	for path, mode := range map[string]os.FileMode{configPath: 0600, filepath.Dir(configPath): 0700, data: 0700} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != mode {
			t.Errorf("%s has mode %v, want %v", path, info.Mode().Perm(), mode)
		}
	}
}

func TestPrepareMountsValidatesBeforeChangingAnything(t *testing.T) {
	for _, kind := range []string{"missing", "directory", "symlink", "hardlink", "owner"} {
		t.Run(kind, func(t *testing.T) {
			configPath, data, owner := mountFixture(t)
			original := filepath.Join(filepath.Dir(data), "original")
			if err := os.WriteFile(original, []byte("original"), 0644); err != nil {
				t.Fatal(err)
			}
			var err error
			var want string
			switch kind {
			case "missing":
				want = "not_found"
			case "directory":
				err, want = os.Mkdir(configPath, 0755), "is_directory"
			case "symlink":
				err, want = os.Symlink(original, configPath), "symlink"
			case "hardlink":
				err, want = os.Link(original, configPath), "multiple_links"
			case "owner":
				if owner.UID == 0 {
					t.Skip("requires an ordinary numeric user")
				}
				err, want = os.WriteFile(configPath, []byte("original"), 0644), "config_owner_mismatch"
				owner.UID++
			}
			if err != nil {
				t.Fatal(err)
			}
			_, failure := prepareMountedPaths(configPath, []string{data}, owner)
			if failure == nil || failure.reason != want || failure.target.path != configPath {
				t.Fatalf("want %s for the config entry, got %#v", want, failure)
			}
			info, err := os.Stat(data)
			if err != nil || info.Mode().Perm() != 0755 {
				t.Fatalf("validation changed data directory: %v, %v", info, err)
			}
			info, err = os.Stat(original)
			if err != nil || info.Mode().Perm() != 0644 {
				t.Fatalf("validation changed the linked file: %v, %v", info, err)
			}
		})
	}
}

func TestPrepareMountsRejectsUnsafeServiceUser(t *testing.T) {
	for _, value := range []string{"root", "0:10001", "10001:0", "10001:", "2147483648:10001", "12:34:56", "-2:123"} {
		t.Run(value, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			d := Production(&stdout, &stderr)
			code := runMountPreparation([]string{value}, "fixture", "", nil, d)
			var event map[string]any
			if err := json.Unmarshal(stderr.Bytes(), &event); err != nil {
				t.Fatal(err)
			}
			if code != 1 || event["reason"] != "invalid_service_user" || event["target"] != "MUSE_SERVICE_USER" || bytes.Contains(stderr.Bytes(), []byte(value)) {
				t.Fatalf("invalid identity was not safely rejected: %v", event)
			}
		})
	}
}

func TestPrepareMountsRejectsLinksInsideOwnedDirectories(t *testing.T) {
	for _, kind := range []string{"config sibling", "nested data"} {
		t.Run(kind, func(t *testing.T) {
			configPath, data, owner := mountFixture(t)
			if err := os.WriteFile(configPath, []byte("# original"), 0644); err != nil {
				t.Fatal(err)
			}
			target := filepath.Dir(configPath)
			linkDir := target
			if kind == "nested data" {
				target = data
				linkDir = filepath.Join(data, "nested")
				if err := os.Mkdir(linkDir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(configPath, filepath.Join(linkDir, "link")); err != nil {
				t.Fatal(err)
			}
			_, failure := prepareMountedPaths(configPath, []string{data}, owner)
			if failure == nil || failure.reason != "symlink" || failure.target.path != target {
				t.Fatalf("checked the wrong mount or accepted a symlink: %#v", failure)
			}
			info, err := os.Stat(data)
			if err != nil || info.Mode().Perm() != 0755 {
				t.Fatalf("rejection changed directory permissions: %v, %v", info, err)
			}
		})
	}
}
