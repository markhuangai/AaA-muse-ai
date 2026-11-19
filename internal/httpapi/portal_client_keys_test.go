package httpapi

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
)

func TestPortalClientKeyCreationAndDiagnosticBoundaries(t *testing.T) {
	h, _, out, capture := portalHTTPFixture(t)
	route := "/api/v1/portal/client-keys"
	post := func(credential, name, key string) (int, string) {
		body, _ := json.Marshal(map[string]string{"name": name, "key": key})
		w := portalHTTP(h, "POST", route, credential, string(body), map[string]string{"X-Portal-Operation-Id": "save-client-fixture"})
		return w.Code, w.Body.String()
	}
	path := filepath.Join(t.TempDir(), "config.yaml")
	raw := []byte("database:\n  url: postgres://db/muse\nmanagement:\n  key: admin-private-sentinel\ncontrol-portal:\n  password: portal-private-sentinel\nclient-keys:\n  client: client-private-sentinel\n")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	c, err := config.Parse(raw, os.LookupEnv)
	if err != nil {
		t.Fatal(err)
	}
	h.ClientKeys = config.NewClientKeyFile(path, os.LookupEnv, c)
	h.Service.UseConfiguration(h.ClientKeys.Current)
	h.Authority = auth.NewWithConfiguration(h.ClientKeys.Current)
	h.Redactor = diagnostics.NewLiveRedactor(h.ClientKeys.Current)
	h.Logger = diagnostics.NewLogger(out, capture, slog.LevelInfo, h.Redactor, h.Now, func(error) { t.Error("capture failed") }).With("instance_id", "instance")
	session := portalLogin(t, h).Token
	const secret = "new-client-with-quoted-\"-value"
	for _, credential := range []string{"", "admin-private-sentinel", "client-private-sentinel", "portal-private-sentinel"} {
		if code, _ := post(credential, "Named client", secret); code != 401 {
			t.Fatal("non-portal credential gained client key creation authority")
		}
	}
	if code, body := post(session, "Named client", secret); code != 201 || strings.TrimSpace(body) != `{"name":"Named client"}` {
		t.Fatal("creation must return only the approved name")
	}
	for _, c := range []struct{ name, key string }{
		{"Named client", "replacement"}, {"different name", secret}, {"portal role", "portal-private-sentinel"},
		{"management role", "admin-private-sentinel"}, {"worker role", "muse_worker_" + strings.Repeat("A", 43)},
	} {
		if code, _ := post(session, c.name, c.key); code != 409 {
			t.Fatal("duplicate or reserved credential was accepted", c.name, code)
		}
	}
	if code, _ := post(session, "invalid key", "has spaces"); code != 400 {
		t.Fatal("invalid bearer accepted")
	}
	if w := portalHTTP(h, "POST", route, session, `{"name":"untyped","key":null}`, nil); w.Code != 400 {
		t.Fatal("invalid key body was accepted")
	}
	if code, _ := post(session, "invalid literal", "${CLIENT}"); code != 400 {
		t.Fatal("ambiguous literal accepted")
	}
	if w := portalHTTP(h, "GET", "/v1/models", secret, "", nil); w.Code != 200 {
		t.Fatal("confirmed client key did not gain model scope", w.Code)
	}
	if w := portalHTTP(h, "GET", "/api/v1/portal/settings", session, "", nil); w.Code != 200 ||
		!strings.Contains(w.Body.String(), `"client_key_names":["Named client","client"]`) || strings.Contains(w.Body.String(), "new-client-with-quoted") {
		t.Fatal("settings omitted the name or exposed a key")
	}
	h.Logger.Info("test.key_echo", "text", "value "+secret)
	events, _ := json.Marshal(capturedHTTP(t, capture))
	for _, log := range []string{out.String(), string(events)} {
		if strings.Contains(log, "new-client-with-quoted") || strings.Contains(log, session) ||
			!strings.Contains(log, "client_key.created") || !strings.Contains(log, "save-client-fixture") ||
			!strings.Contains(log, "credential_in_use") {
			t.Fatal("diagnostics omitted the operation or exposed authority")
		}
	}
}
