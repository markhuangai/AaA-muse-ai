package config

import (
	"strings"
	"testing"
)

func TestWorkerPackagePins(t *testing.T) {
	for _, version := range []string{"0.1.0-rc.0", "0.1.0-dev.0", "1.2.3"} {
		c, err := Parse([]byte(fixture+"worker-package:\n  version: "+version+"\n  sha256: \""+strings.Repeat("a", 64)+"\"\n"), absent)
		if err != nil || c.WorkerPackage.Version != version {
			t.Fatal("valid pin rejected", err)
		}
	}
	for _, pin := range []WorkerPackage{{Version: "0.1.0-rc.0"}, {SHA256: strings.Repeat("a", 64)}, {Version: "01.0.0", SHA256: strings.Repeat("a", 64)}, {Version: "0.1.0-rc.01", SHA256: strings.Repeat("a", 64)}, {Version: "0.1.0-rc.0", SHA256: strings.Repeat("A", 64)}, {Version: "0.1.0; command", SHA256: strings.Repeat("a", 64)}} {
		c, _ := Parse([]byte(fixture), absent)
		c.WorkerPackage = pin
		if c.Validate() == nil {
			t.Fatal("invalid pin admitted")
		}
	}
	source := fixture + "worker-package:\n  version: ${WORKER_VERSION}\n  sha256: ${WORKER_SHA}\n"
	c, err := Parse([]byte(source), func(name string) (string, bool) {
		if name == "WORKER_VERSION" {
			return "0.1.0-rc.0", true
		}
		return strings.Repeat("b", 64), true
	})
	if err != nil || c.WorkerPackage.SHA256 != strings.Repeat("b", 64) {
		t.Fatal("pin environment references failed", err)
	}
}
