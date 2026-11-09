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

func TestOverlappingSecretsAreFullyRedacted(t *testing.T) {
	for _, prefix := range []string{auth.EnrollmentPrefix, auth.WorkerPrefix} {
		token, err := auth.Token(prefix, rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		cases := []struct {
			name    string
			secrets []string
			input   string
			want    string
		}{
			{"prefix", []string{"muse"}, token, "[REDACTED]"},
			{"inside", []string{token[len(prefix)+5 : len(prefix)+12]}, token, "[REDACTED]"},
			{"starts_before", []string{"prefix_" + prefix}, "before prefix_" + token + " after", "before [REDACTED] after"},
			{"contains_token", []string{token + " suffix"}, "before " + token + " suffix after", "before [REDACTED] after"},
			{"literal_overlap", []string{"abc", "cde"}, "before abcde after", "before [REDACTED] after"},
			{"self_overlap", []string{"aba"}, "before ababa after", "before [REDACTED] after"},
			{"separate", []string{"private", ""}, "private before " + token + " after", "[REDACTED] before [REDACTED] after"},
		}
		for _, tc := range cases {
			t.Run(prefix+tc.name, func(t *testing.T) {
				s, now := openFixture(t, 128*1024*1024)
				response, err := json.Marshal(map[string]string{"credential": tc.input})
				if err != nil {
					t.Fatal(err)
				}
				var out bytes.Buffer
				log := NewLogger(&out, s, slog.LevelInfo, NewRedactor(tc.secrets), func() time.Time { return *now }, func(error) { t.Error("capture failed") }).With("request_id", "overlap")
				log.Debug("request.exchange", "response", string(response))
				log.Info("worker.renamed", "name", tc.input)
				snapshot, err := s.Snapshot(Filter{RequestID: "overlap"})
				if err != nil || !snapshot.Metadata.Complete || snapshot.Metadata.Captures != 2 {
					t.Fatal("overlapping-secret capture incomplete")
				}
				events := payloads(t, snapshot)
				var exchange map[string]string
				if err := json.Unmarshal([]byte(events[0]["response"].(string)), &exchange); err != nil {
					t.Fatal(err)
				}
				if exchange["credential"] != tc.want || events[1]["name"] != tc.want {
					t.Fatal("overlapping secret was partially retained or nonsecret text changed")
				}
				var stdout map[string]any
				if err := json.Unmarshal(out.Bytes(), &stdout); err != nil {
					t.Fatal("DEBUG reached INFO stdout or INFO output is invalid")
				}
				if stdout["name"] != tc.want || stdout["msg"] != "worker.renamed" {
					t.Fatal("stdout did not preserve the redacted INFO outcome")
				}
			})
		}
	}
}
