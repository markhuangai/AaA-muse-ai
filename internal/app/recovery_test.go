package app

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func TestRecoveryBeforeListenAndFailureStopsStartup(t *testing.T) {
	for _, fail := range []bool{false, true} {
		d, out, _, repo := fixtureDependencies(t, false)
		if fail {
			repo.recoveryErr = errors.New("recovery storage unavailable")
		}
		listened := false
		d.Listen = func(string, string) (net.Listener, error) {
			listened = true
			if !repo.recovered.Load() {
				t.Fatal("listener opened before recovery")
			}
			return nil, errors.New("bounded test stop")
		}
		if Run(context.Background(), nil, service.Build{Revision: "recovery-test"}, d) != 1 || !repo.closed.Load() {
			t.Fatal("startup failure did not stop and close repository")
		}
		if listened == fail || strings.Contains(out.String(), "server.started") {
			t.Fatal("startup recovery gate bypassed")
		}
		if fail && (!strings.Contains(out.String(), "recovery.failed") || strings.Contains(out.String(), "recovery.restored")) {
			t.Fatal("recovery failure was reported as restored")
		}
	}
}
