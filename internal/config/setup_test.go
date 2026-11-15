package config

import (
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"
)

func passwordFixture(t *testing.T, target, password string) string {
	t.Helper()
	const original = "postgres://service:database-sentinel@db:5432/muse"
	if !strings.Contains(fixture, original) {
		t.Fatal("shared database fixture changed")
	}
	source := strings.Replace(fixture, original, target, 1)
	if password != "" {
		source = strings.Replace(source, "database:\n", "database:\n  password: "+password+"\n", 1)
	}
	return source
}

func TestDatabasePasswordIsEscapedAndRedacted(t *testing.T) {
	for _, password := range []string{"normal-password", "a b@:/?#%$'\"\\\n秘密", "p${literal}", "p${"} {
		source := passwordFixture(t, "postgres://service@db:5432/muse", "${DB_PASSWORD}")
		c, err := Parse([]byte(source), func(string) (string, bool) { return password, true })
		if err != nil {
			t.Fatal(err)
		}
		target, err := url.Parse(string(c.Database.URL))
		if err != nil {
			t.Fatal(err)
		}
		actual, _ := target.User.Password()
		if actual != password || target.Host != "db:5432" || target.Path != "/muse" || c.Validate() != nil {
			t.Fatal("password changed connection target or did not round trip")
		}
		encoded, _ := json.Marshal(c)
		if strings.Contains(string(encoded), password) || !strings.Contains(string(encoded), "[REDACTED]") {
			t.Fatal("database credential exposed")
		}
		if !containsSecret(c.Secrets(), password) || !containsSecret(c.Secrets(), strings.TrimPrefix(url.UserPassword("", password).String(), ":")) {
			t.Fatal("raw or encoded password omitted from redaction")
		}
	}
}

func containsSecret(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func TestDatabaseConflictsAndRemovedWorkerConfiguration(t *testing.T) {
	for _, test := range []struct{ url, reason string }{
		{"postgres://service:existing@db:5432/muse", "conflicting_password_sources"},
		{"postgres://db:5432/muse", "database_user_required"},
		{"postgres://service@db:5432/muse?password=other", "conflicting_password_sources"},
		{"postgres://service@db:5432/muse?pass%77ord=other", "conflicting_password_sources"},
		{"postgres://service@db:5432/muse?invalid%query=x", "invalid_query"},
	} {
		_, err := Parse([]byte(passwordFixture(t, test.url, "separate")), absent)
		var problem *Error
		if !errors.As(err, &problem) || problem.Reason != test.reason {
			t.Fatalf("expected %s, got %v", test.reason, err)
		}
	}
	if _, err := Parse([]byte(fixture+"worker-package:\n  version: 0.1.0-rc.6\n  sha256: "+strings.Repeat("a", 64)+"\n"), absent); err == nil {
		t.Fatal("removed package configuration accepted")
	}
	if _, err := Parse([]byte(fixture), absent); err != nil {
		t.Fatal("existing complete URL rejected", err)
	}
	if _, err := Parse([]byte(passwordFixture(t, "postgres://service@db:5432/muse?password=complete-url-password", "")), absent); err != nil {
		t.Fatal("existing query password rejected", err)
	}
}
