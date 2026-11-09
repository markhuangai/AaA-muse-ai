package diagnostics

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
)

func TestIssuedSecretsRemainRedactedAcrossRestartAndEscaping(t *testing.T) {
	s, now := openFixture(t, 128*1024*1024)
	code, err := auth.Token(auth.EnrollmentPrefix, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := auth.Token(auth.WorkerPrefix, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	configured := "private\n\"<password>"
	response, _ := json.Marshal(map[string]string{"name": "echo " + key, "other": configured, "enrollment_code": code})
	var out bytes.Buffer
	log := NewLogger(&out, s, slog.LevelInfo, NewRedactor([]string{configured}), func() time.Time { return *now }, func(error) { t.Error("capture failed") }).With("instance_id", "instance", "request_id", "secret-echo")
	log.Debug("request.exchange", "response", string(response), "input", map[string]any{"name": key, "enrollment_code": code})
	log.Info("worker.renamed", "name", key)
	reopened, err := Open(OSFiles{}, s.dir, "replacement", func() time.Time { return *now }, 7*24*time.Hour, 128*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	log = NewLogger(&out, reopened, slog.LevelInfo, NewRedactor([]string{configured}), func() time.Time { return *now }, func(error) { t.Error("capture failed") }).With("instance_id", "replacement", "request_id", "secret-echo")
	log.Debug("request.worker_input", "name", key, "unclassified", code)
	snapshot, err := reopened.Snapshot(Filter{RequestID: "secret-echo"})
	if err != nil || !snapshot.Metadata.Complete || snapshot.Metadata.Captures != 3 {
		t.Fatal("restart lost protected captures")
	}
	encoded, _ := json.Marshal(payloads(t, snapshot))
	for _, secret := range []string{key, code, configured, "<password>"} {
		if bytes.Contains(encoded, []byte(secret)) || strings.Contains(out.String(), secret) {
			t.Fatal("secret echo bypassed redaction")
		}
	}
	if !bytes.Contains(encoded, []byte("[REDACTED]")) || strings.Contains(out.String(), "request.exchange") {
		t.Fatal("redaction or runtime filtering absent")
	}
}
