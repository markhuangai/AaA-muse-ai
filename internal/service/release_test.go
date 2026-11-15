package service

import (
	"strings"
	"testing"
)

func TestReleaseMajorCompatibilityAndBundledIdentity(t *testing.T) {
	for _, test := range []struct {
		service, worker string
		compatible      bool
	}{
		{"1.2.0", "1.0.0", true}, {"1.0.0", "1.9.3", true}, {"2.1.0", "2.0.0", true},
		{"2.1.0", "1.9.0", false}, {"1.0.0", "2.0.0", false}, {"1.0.0", "", false},
		{"0.1.0-rc.7", "", true}, {"0.1.0-rc.7", "0.1.0-rc.0", true},
		{"invalid", "0.1.0", false}, {"1.0.0", "01.0.0", false},
	} {
		if (Build{Version: test.service}).Compatible(test.worker) != test.compatible {
			t.Fatalf("%q / %q", test.service, test.worker)
		}
	}
	for _, version := range []string{"v1.0.0", "1.0", "01.0.0", "18446744073709551616.0.0"} {
		if _, valid := ReleaseMajor(version); valid {
			t.Fatal("invalid release major accepted", version)
		}
	}
	b := (Build{Version: "1.2.0", Revision: strings.Repeat("a", 40), WorkerPackage: PackagePin{Version: "wrong", SHA256: strings.Repeat("b", 64)}}).Normalized()
	if !b.Valid() || b.WorkerPackage.Version != b.Version || !strings.Contains(b.WorkerPackage.URL, "/v1.2.0/") || (Build{Version: "1.2.0"}).Valid() || (Build{Version: "bad"}).Valid() || (Build{WorkerPackage: PackagePin{SHA256: "bad"}}).Valid() {
		t.Fatal("paired release metadata not enforced")
	}
	if !(Build{}).Valid() {
		t.Fatal("development build rejected")
	}
}
