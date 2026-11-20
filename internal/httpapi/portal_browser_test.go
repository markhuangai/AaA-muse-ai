package httpapi

import (
	"crypto/rand"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/sqlite"
)

func TestPortalBrowserAuthorityAndPasswordGeneration(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "broker.sqlite3")
	h, _, capture, _ := portalHTTPFixture(t)
	now := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	h.Now = func() time.Time { return now }
	original := "portal-private-sentinel"
	start := func(password string) *Handler {
		t.Helper()
		repo, err := sqlite.Open(t.Context(), path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(repo.Close)
		if err := repo.Bootstrap(t.Context()); err != nil {
			t.Fatal(err)
		}
		broker := *h
		if password != original {
			var configuration config.Config
			configuration.Portal.Password = config.Secret(password)
			broker.Authority = auth.New(configuration)
		}
		broker.Portal = service.NewPortal(broker.Authority, rand.Reader, h.Now)
		if err := broker.Portal.ConfigureBrowser(t.Context(), broker.Logger, repo, password); err != nil {
			t.Fatal(err)
		}
		return &broker
	}
	first, sibling := start(original), start(original)
	headers := func(cookie *http.Cookie) map[string]string {
		result := map[string]string{portalOperationHeader: "browser-boundary", "Origin": "http://example.com", "Sec-Fetch-Site": "same-origin"}
		if cookie != nil {
			result["Cookie"] = cookie.Name + "=" + cookie.Value
		}
		return result
	}
	login := func(broker *Handler, password string, persistent bool) *http.Cookie {
		t.Helper()
		body := fmt.Sprintf(`{"password":%q,"remember_me":%t}`, password, persistent)
		w := portalHTTP(broker, "POST", "/api/v1/portal/login", "", body, headers(nil))
		cookies := w.Result().Cookies()
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"authenticated":true}` || len(cookies) != 1 {
			t.Fatalf("browser login status %d", w.Code)
		}
		cookie := cookies[0]
		if cookie.Name != portalCookieName || cookie.Path != "/" || cookie.Domain != "" || !cookie.HttpOnly || !cookie.Secure ||
			cookie.SameSite != http.SameSiteStrictMode || (cookie.MaxAge == int(service.PortalRememberLifetime.Seconds())) != persistent {
			t.Fatal("incorrect browser cookie attributes")
		}
		return cookie
	}
	remembered := login(first, original, true)
	ordinary := login(first, original, false)
	if ordinary.MaxAge != 0 || !ordinary.Expires.IsZero() {
		t.Fatal("ordinary browser cookie was persistent")
	}
	session := "/api/v1/portal/session"
	logout := "/api/v1/portal/logout"
	if w := portalHTTP(first, "GET", session, "", "", nil); w.Code != 401 {
		t.Fatal("anonymous restore was not denied")
	}
	now = now.Add(31 * time.Minute)
	for _, cookie := range []*http.Cookie{ordinary, remembered} {
		for _, route := range []string{session, "/api/v1/admin/status"} {
			if w := portalHTTP(sibling, "GET", route, "", "", headers(cookie)); w.Code != 200 || w.Header().Get("Set-Cookie") != "" || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("sibling/browser restore failed for %s (%d)", route, w.Code)
			}
		}
	}
	if w := portalHTTP(first, "GET", "/v1/models", "", "", headers(remembered)); w.Code != 401 {
		t.Fatal("portal cookie authorized client API")
	}
	if w := portalHTTP(first, "GET", "/api/v1/worker/status", "", "", headers(remembered)); w.Code != 401 {
		t.Fatal("portal cookie authorized worker API")
	}
	if w := portalHTTP(first, "GET", session, "invalid-explicit-authority", "", headers(remembered)); w.Code != 401 {
		t.Fatal("explicit Authorization fell back to cookie")
	}
	if w := portalHTTP(first, "GET", session, remembered.Value, "", nil); w.Code != 401 {
		t.Fatal("browser cookie value authorized legacy bearer API")
	}
	crossOrigin := headers(remembered)
	crossOrigin["Origin"] = "https://other.invalid"
	crossOrigin["Sec-Fetch-Site"] = "same-site"
	for _, route := range []string{"/api/v1/portal/login", logout, "/api/v1/admin/enrollments"} {
		body := ""
		if route == "/api/v1/portal/login" {
			body = `{"password":"portal-private-sentinel","remember_me":false}`
		}
		if w := portalHTTP(first, "POST", route, "", body, crossOrigin); w.Code != 403 || w.Header().Get("Set-Cookie") != "" {
			t.Fatalf("cross-origin control was accepted on %s: %d", route, w.Code)
		}
	}
	noOperation := headers(remembered)
	delete(noOperation, portalOperationHeader)
	if w := portalHTTP(first, "POST", logout, "", "", noOperation); w.Code != 403 {
		t.Fatal("browser write accepted without an operation ID")
	}
	if w := portalHTTP(first, "POST", "/api/v1/portal/login", "", `{"password":"portal-private-sentinel","remember_me":null}`, headers(nil)); w.Code != 400 {
		t.Fatal("null persistence mode was accepted")
	}
	now = now.Add(24 * time.Hour)
	if w := portalHTTP(first, "GET", session, "", "", headers(remembered)); w.Code != 200 || len(w.Result().Cookies()) != 1 {
		t.Fatal("remembered cookie did not renew")
	}
	if w := portalHTTP(sibling, "GET", session, "", "", headers(remembered)); w.Code != 200 || len(w.Result().Cookies()) != 0 {
		t.Fatal("remembered cookie renewed twice in one day")
	}
	for _, cookie := range []*http.Cookie{remembered, remembered, nil} {
		w := portalHTTP(sibling, "POST", logout, "", "", headers(cookie))
		removed := w.Result().Cookies()
		if w.Code != 204 || len(removed) != 1 || removed[0].MaxAge != -1 || removed[0].Path != "/" {
			t.Fatal("cookie logout is not confirmed and idempotent")
		}
	}
	if w := portalHTTP(first, "GET", session, "", "", headers(remembered)); w.Code != 401 {
		t.Fatal("logout left browser authority on the other broker")
	}
	secondPassword := strings.Repeat("different password ", 6) + " "
	second := start(secondPassword)
	if w := portalHTTP(first, "GET", session, "", "", headers(ordinary)); w.Code != 503 {
		t.Fatal("old broker generation was not fenced")
	}
	if w := portalHTTP(second, "GET", session, "", "", headers(ordinary)); w.Code != 401 {
		t.Fatal("password change retained a browser grant")
	}
	secondGrant := login(second, secondPassword, true)
	reused := start(original)
	for _, cookie := range []*http.Cookie{ordinary, secondGrant} {
		if w := portalHTTP(reused, "GET", session, "", "", headers(cookie)); w.Code != 401 {
			t.Fatal("reusing the earlier password revived a browser grant")
		}
	}
	for _, credential := range []string{original, secondPassword, ordinary.Value, remembered.Value, secondGrant.Value} {
		if strings.Contains(capture.String(), credential) {
			t.Fatal("sign-in credential leaked into runtime logs")
		}
	}
}
