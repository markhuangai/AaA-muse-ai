package httpapi

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"io"
	"io/fs"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func portalHTTPFixture(t *testing.T) (*Handler, *testDB, *bytes.Buffer, *diagnostics.Store) {
	t.Helper()
	h, db, out, store := fixture(t)
	h.Logger = h.Logger.With("revision", "development")
	h.Portal = service.NewPortal(h.Authority, rand.Reader, h.Now)
	h.Assets = fstest.MapFS{"index.html": {Data: []byte("<!doctype html><html><body>compiled shell</body></html>")}, "assets/main.js": {Data: []byte("public code")}, "assets/main.css": {Data: []byte("body{}")}, "assets/font.woff2": {Data: []byte("public font")}, "assets/mark.svg": {Data: []byte("<svg/>")}}
	h.Assets.(fstest.MapFS)["assets/font.woff"] = &fstest.MapFile{Data: []byte("public fallback font")}
	return h, db, out, store
}

func portalHTTP(h *Handler, method, path, credential, body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "198.51.100.1:2000"
	r.Header.Set("Content-Type", "application/json")
	if credential != "" {
		r.Header.Set("Authorization", "Bearer "+credential)
	}
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func portalLogin(t *testing.T, h *Handler) service.PortalSession {
	t.Helper()
	w := portalHTTP(h, "POST", "/api/v1/portal/login", "", `{"password":"portal-private-sentinel"}`, nil)
	var session service.PortalSession
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &session) != nil || session.Token == "" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("portal login failed")
	}
	return session
}

func TestPortalLoginManagementScopeAndLogout(t *testing.T) {
	h, _, _, _ := portalHTTPFixture(t)
	session := portalLogin(t, h)
	for _, tc := range []struct {
		path, credential string
		status           int
	}{
		{"/api/v1/portal/settings", session.Token, 200}, {"/api/v1/admin/status", session.Token, 200},
		{"/api/v1/requests", session.Token, 401}, {"/api/v1/worker/status", session.Token, 401},
		{"/api/v1/portal/settings", "admin-private-sentinel", 401}, {"/api/v1/portal/settings", "client-private-sentinel", 401},
		{"/api/v1/portal/settings", "portal-private-sentinel", 401}, {"/api/v1/portal/settings", "muse_worker_" + strings.Repeat("a", 43), 401},
		{"/api/v1/admin/status", "portal-private-sentinel", 401}, {"/api/v1/admin/status", "admin-private-sentinel", 200},
	} {
		w := portalHTTP(h, "GET", tc.path, tc.credential, "", nil)
		if w.Code != tc.status {
			t.Fatalf("wrong credential-role status on %s: %d", tc.path, w.Code)
		}
	}
	bad := portalHTTP(h, "POST", "/api/v1/portal/logout", session.Token, `{"unsupported":true}`, nil)
	if bad.Code != 400 {
		t.Fatal("logout accepted unsupported body")
	}
	logout := portalHTTP(h, "POST", "/api/v1/portal/logout", session.Token, "", nil)
	if logout.Code != 204 || portalHTTP(h, "GET", "/api/v1/admin/status", session.Token, "", nil).Code != 401 {
		t.Fatal("logout retained management authority")
	}
	h.Portal = service.NewPortal(h.Authority, rand.Reader, h.Now)
	if portalHTTP(h, "GET", "/api/v1/portal/settings", session.Token, "", nil).Code != 401 {
		t.Fatal("new process restored session")
	}
}

func TestPortalExpiryThroughProductionHTTP(t *testing.T) {
	h, _, _, _ := portalHTTPFixture(t)
	now := time.Now().UTC()
	h.Now = func() time.Time { return now }
	h.Portal = service.NewPortal(h.Authority, rand.Reader, h.Now)
	session := portalLogin(t, h)
	if session.ExpiresAt.Sub(now) != 30*time.Minute {
		t.Fatal("production lifetime changed")
	}
	now = now.Add(30*time.Minute - time.Nanosecond)
	if portalHTTP(h, "GET", "/api/v1/portal/settings", session.Token, "", nil).Code != 200 {
		t.Fatal("session expired before the boundary")
	}
	now = now.Add(time.Nanosecond)
	w := portalHTTP(h, "GET", "/api/v1/portal/settings", session.Token, "", nil)
	if w.Code != 401 || w.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatal("expired server session remained authorized")
	}
	t.Log(`{"case":"portal.server_expiry","outcome":"passed","lifetime_seconds":1800,"validation":"production_handler_injected_clock"}`)
}

func TestPortalBoundaryRejectionsAndThrottling(t *testing.T) {
	h, _, _, _ := portalHTTPFixture(t)
	for _, tc := range []struct {
		method, path, body string
		headers            map[string]string
		status             int
	}{
		{"GET", "/api/v1/portal/login", "", nil, 405},
		{"POST", "/api/v1/portal/login", `{}`, nil, 400},
		{"POST", "/api/v1/portal/login", `{"password":null}`, nil, 400},
		{"POST", "/api/v1/portal/login", `{"password":"a","password":"b"}`, nil, 400},
		{"POST", "/api/v1/portal/login", `{"password":"a","extra":true}`, nil, 400},
		{"POST", "/api/v1/portal/login", `{"password":"a"}`, map[string]string{"Content-Type": "text/plain"}, 415},
		{"POST", "/api/v1/portal/login", strings.Repeat("x", MaxBodyBytes+1), nil, 413},
		{"POST", "/api/v1/portal/login", `{"password":"a"}`, map[string]string{"X-Portal-Operation-Id": "invalid id"}, 400},
		{"POST", "/api/v1/portal/login?secret=ignored", `{"password":"a"}`, nil, 400},
	} {
		if w := portalHTTP(h, tc.method, tc.path, "", tc.body, tc.headers); w.Code != tc.status {
			t.Fatalf("wrong portal boundary rejection: %d", w.Code)
		}
	}
	for i := 0; i < 5; i++ {
		w := portalHTTP(h, "POST", "/api/v1/portal/login", "", `{"password":"wrong-private-canary"}`, map[string]string{"X-Forwarded-For": strings.Repeat("a", i+1)})
		if w.Code != 401 {
			t.Fatal("failed login threshold changed")
		}
	}
	w := portalHTTP(h, "POST", "/api/v1/portal/login", "", `{"password":"portal-private-sentinel"}`, map[string]string{"X-Forwarded-For": "different-forwarded-peer"})
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatal("forwarded headers bypassed throttling")
	}
	h, _, _, _ = portalHTTPFixture(t)
	h.Portal = service.NewPortal(h.Authority, bytes.NewReader(nil), h.Now)
	if portalHTTP(h, "POST", "/api/v1/portal/login", "", `{"password":"portal-private-sentinel"}`, nil).Code != 503 {
		t.Fatal("entropy failure created session")
	}
	h.Portal = nil
	if portalHTTP(h, "POST", "/api/v1/portal/login", "", `{"password":"portal-private-sentinel"}`, nil).Code != 503 {
		t.Fatal("missing portal service concealed")
	}
}

func TestPortalProtectedCaptureAndBrowserReports(t *testing.T) {
	h, db, out, store := portalHTTPFixture(t)
	operation := map[string]string{"X-Portal-Operation-Id": "portal-operation"}
	wrong := portalHTTP(h, "POST", "/api/v1/portal/login", "", `{"password":"wrong-private-canary"}`, operation)
	if wrong.Code != 401 {
		t.Fatal("wrong password accepted")
	}
	session := portalLogin(t, h)
	db.err = io.ErrUnexpectedEOF
	settings := portalHTTP(h, "GET", "/api/v1/portal/settings", session.Token, "", operation)
	var view service.PortalConfiguration
	if settings.Code != 200 || json.Unmarshal(settings.Body.Bytes(), &view) != nil || view.Ready || !strings.Contains(view.EffectiveYAML, "[REDACTED]") {
		t.Fatal("settings concealed degraded health or redaction")
	}
	report := service.PortalReport{Event: "portal.render_failed", Build: "development", Component: "shell", Cause: "render_exception", RequestID: settings.Header().Get("X-Request-Id"), OperationID: "portal-operation", Expected: "rendered", Observed: "failed", Attempt: 1}
	body, _ := json.Marshal(report)
	if portalHTTP(h, "POST", "/api/v1/portal/events", session.Token, string(body), operation).Code != 204 {
		t.Fatal("browser report rejected")
	}
	if portalHTTP(h, "POST", "/api/v1/portal/events", session.Token, string(body[:len(body)-1])+`,"stack":"forbidden"}`, operation).Code != 400 {
		t.Fatal("free-form browser payload admitted")
	}
	if portalHTTP(h, "POST", "/api/v1/portal/events", session.Token, strings.Repeat(" ", 4096)+string(body), operation).Code != 413 {
		t.Fatal("oversized report admitted")
	}
	if portalHTTP(h, "POST", "/api/v1/portal/events", session.Token, `{"event":"unknown"}`, operation).Code != 400 {
		t.Fatal("malformed report admitted")
	}
	for i := 1; i < 20; i++ {
		if portalHTTP(h, "POST", "/api/v1/portal/events", session.Token, string(body), operation).Code != 204 {
			t.Fatal("report budget exhausted early")
		}
	}
	if portalHTTP(h, "POST", "/api/v1/portal/events", session.Token, string(body), operation).Code != 429 {
		t.Fatal("report rate limit missing")
	}
	export := portalHTTP(h, "GET", "/api/v1/admin/diagnostics/export?operation_id=portal-operation", "admin-private-sentinel", "", nil)
	if export.Code != 200 {
		t.Fatal("diagnostic export failed")
	}
	var metadata diagnostics.Metadata
	decoder := json.NewDecoder(export.Body)
	if decoder.Decode(&metadata) != nil || !metadata.Complete {
		t.Fatal("diagnostic export incomplete")
	}
	var reconstructed strings.Builder
	for decoder.More() {
		var row diagnostics.Record
		if decoder.Decode(&row) != nil {
			t.Fatal("invalid capture")
		}
		reconstructed.Write(mustDecode(t, row.Data))
	}
	text := reconstructed.String()
	for _, secret := range []string{"admin-private-sentinel", "portal-private-sentinel", "client-private-sentinel", "wrong-private-canary", session.Token} {
		if strings.Contains(text, secret) || strings.Contains(out.String(), secret) {
			t.Fatal("credential reached diagnostic evidence")
		}
	}
	for _, expected := range []string{"portal.auth_failed", "wrong_password", "portal.state_stale", "portal.render_failed", `"client_report":true`, `"client_build":"development"`, `"operation_id":"portal-operation"`, `"level":"DEBUG"`} {
		if !strings.Contains(text, expected) {
			t.Fatal("log-only diagnostic detail missing")
		}
	}
	if strings.Contains(out.String(), "effective_yaml") || strings.Contains(out.String(), "portal.browser_report") {
		t.Fatal("DEBUG values reached INFO output")
	}
	all, err := store.Snapshot(diagnostics.Filter{})
	if err != nil {
		t.Fatal("capture snapshot failed")
	}
	var captures strings.Builder
	for _, raw := range all.Records {
		var row diagnostics.Record
		if json.Unmarshal(raw, &row) != nil {
			t.Fatal("capture invalid")
		}
		captures.Write(mustDecode(t, row.Data))
	}
	if !strings.Contains(captures.String(), `"response_capture":"credentials_omitted"`) || strings.Contains(captures.String(), session.Token) {
		t.Fatal("login response was not omitted safely")
	}
}

type portalBrokenFS struct{}

func (portalBrokenFS) Open(string) (fs.File, error) { return nil, fs.ErrPermission }

func TestPortalPublicAssetsAndReservedAPIs(t *testing.T) {
	h, _, _, _ := portalHTTPFixture(t)
	for _, route := range []string{"/", "/settings", "/assets/main.js", "/assets/main.css", "/assets/font.woff2", "/assets/font.woff", "/assets/mark.svg"} {
		w := portalHTTP(h, "GET", route, "", "", nil)
		if w.Code != 200 || w.Header().Get("Content-Security-Policy") != portalCSP || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatal("public asset boundary failed")
		}
	}
	if w := portalHTTP(h, "HEAD", "/settings", "", "", nil); w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") == "" {
		t.Fatal("HEAD did not preserve asset metadata")
	}
	if portalHTTP(h, "POST", "/", "", "", nil).Code != 405 {
		t.Fatal("frontend accepted mutation method")
	}
	for _, route := range []string{"/api/v1/missing", "/api/v1/portal/missing", "/v1/missing", "/assets/missing.js", "/assets/../config.yaml", "/assets/source.js.map", "/assets/main.js?key=ignored", "/.env", "/other-page"} {
		w := portalHTTP(h, "GET", route, "", "", nil)
		if w.Code != 404 || strings.Contains(w.Body.String(), "compiled shell") {
			t.Fatalf("SPA fallback concealed error on %s", route)
		}
	}
	h.Assets = nil
	missing := portalHTTP(h, "GET", "/", "", "", nil)
	if missing.Code != 503 {
		t.Fatal("missing compiled shell concealed")
	}
	assertPortalAssetEvidence(t, h, missing, "index.html", "filesystem_path_missing")
	h.Assets = portalBrokenFS{}
	unreadable := portalHTTP(h, "GET", "/assets/main.js", "", "", nil)
	if unreadable.Code != 503 {
		t.Fatal("asset permission failure concealed")
	}
	assertPortalAssetEvidence(t, h, unreadable, "assets/main.js", "filesystem_permission_denied")
}

func assertPortalAssetEvidence(t *testing.T, h *Handler, failed *httptest.ResponseRecorder, asset, cause string) {
	t.Helper()
	requestID := failed.Header().Get("X-Request-Id")
	exported := portalHTTP(h, "GET", "/api/v1/admin/diagnostics/export?request_id="+requestID, "admin-private-sentinel", "", nil)
	if exported.Code != 200 {
		t.Fatal("asset failure export unavailable")
	}
	decoder := json.NewDecoder(exported.Body)
	var metadata diagnostics.Metadata
	if decoder.Decode(&metadata) != nil || !metadata.Complete || len(metadata.Omissions) != 0 {
		t.Fatal("asset failure export incomplete")
	}
	var payload strings.Builder
	for decoder.More() {
		var row diagnostics.Record
		if decoder.Decode(&row) != nil {
			t.Fatal("invalid exported asset record")
		}
		payload.Write(mustDecode(t, row.Data))
	}
	events := json.NewDecoder(strings.NewReader(payload.String()))
	for events.More() {
		var event map[string]any
		if events.Decode(&event) != nil {
			t.Fatal("invalid exported asset event")
		}
		if event["msg"] != "portal.assets_unavailable" {
			continue
		}
		for key, expected := range map[string]string{"level": "ERROR", "request_id": requestID, "revision": "development", "component": "shell", "asset_path": asset, "cause": cause, "expected_state": "available", "observed_state": "unavailable", "outcome": "failed"} {
			if event[key] != expected {
				t.Fatalf("asset diagnosis missing %s", key)
			}
		}
		t.Log("Asset failure is diagnosable from exported build, path, severity and filesystem cause; correct the image contents or permissions.")
		return
	}
	t.Fatal("asset failure event absent from collected logs")
}

func TestPortalLargeYAMLReconstruction(t *testing.T) {
	h, db, _, store := portalHTTPFixture(t)
	c := config.Defaults()
	c.Server.PublicURL = "https://example.test"
	c.Database.URL = "postgres://db/muse"
	c.Portal.Password = "portal-private-sentinel"
	c.Management.Key = "admin-private-sentinel"
	for i := 0; i < 300; i++ {
		c.ClientKeys[strings.Repeat("public-name", 3)+time.Unix(int64(i), 0).Format(time.RFC3339)] = "private-client-value"
	}
	h.Service = service.New(db, c, service.Build{Revision: "development"}, "instance", h.Now, h.Logger)
	session := portalLogin(t, h)
	w := portalHTTP(h, "GET", "/api/v1/portal/settings", session.Token, "", nil)
	if w.Code != 200 || w.Body.Len() < 6144 {
		t.Fatal("large settings case was not exercised")
	}
	snapshot, err := store.Snapshot(diagnostics.Filter{RequestID: w.Header().Get("X-Request-Id")})
	if err != nil || !snapshot.Metadata.Complete {
		t.Fatal("large capture incomplete")
	}
	var raw strings.Builder
	for _, capture := range snapshot.Records {
		for _, line := range bytes.Split(bytes.TrimSpace(capture), []byte("\n")) {
			if len(line)+1 > diagnostics.MaxRecordBytes {
				t.Fatal("oversized chunk")
			}
			var row diagnostics.Record
			if json.Unmarshal(line, &row) != nil {
				t.Fatal("invalid record")
			}
			raw.Write(mustDecode(t, row.Data))
		}
	}
	if !strings.Contains(raw.String(), "portal.settings_detail") || !strings.Contains(raw.String(), "request.exchange") || strings.Contains(raw.String(), "private-client-value") {
		t.Fatal("large settings reconstruction or redaction failed")
	}
	events := json.NewDecoder(strings.NewReader(raw.String()))
	matched := false
	for events.More() {
		var event map[string]any
		if events.Decode(&event) != nil {
			t.Fatal("reconstructed event is invalid")
		}
		if event["msg"] == "request.exchange" {
			matched = event["response"] == w.Body.String()
		}
	}
	if !matched {
		t.Fatal("large HTTP output was not reconstructed exactly")
	}
}
