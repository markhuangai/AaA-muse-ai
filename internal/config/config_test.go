package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

const fixture = `server:
  public-url: https://muse.example.test
database:
  url: postgres://service:database-sentinel@db:5432/muse
management:
  key: management-sentinel
control-portal:
  password: portal-sentinel
client-keys:
  local: client-sentinel
`

func absent(string) (string, bool) { return "", false }

func TestConfiguration(t *testing.T) {
	c, err := Parse([]byte(fixture), absent)
	if err != nil {
		t.Fatal(err)
	}
	if c.Server.Listen != "0.0.0.0:8080" || c.Limits.MaxJobs != 1 || c.Diagnostics.MaxBytes != 128*1024*1024 {
		t.Fatal("defaults missing")
	}
	lookup := func(name string) (string, bool) {
		return map[string]string{"PORTAL": "a:#quoted\nsecret", "DB": "postgres://a:b@db/muse"}[name], true
	}
	resolved, err := Parse([]byte(strings.ReplaceAll(strings.ReplaceAll(fixture, "portal-sentinel", "${PORTAL}"), "postgres://service:database-sentinel@db:5432/muse", "${DB}")), lookup)
	if err != nil || string(resolved.Portal.Password) != "a:#quoted\nsecret" {
		t.Fatal("environment scalar was not preserved")
	}
	loaded, err := Load(func(path string) ([]byte, error) {
		if path != "chosen.yaml" {
			t.Fatal(path)
		}
		return []byte(fixture), nil
	}, absent, "chosen.yaml")
	if err != nil || loaded.Server.PublicURL != c.Server.PublicURL {
		t.Fatal("load failed")
	}
	if _, err = Load(func(string) ([]byte, error) { return nil, errors.New("private-file-value") }, absent, "private-file"); err == nil || strings.Contains(err.Error(), "private-file") {
		t.Fatal("read error missing or exposed")
	}
	encoded, _ := json.Marshal(c)
	for _, secret := range []string{"management-sentinel", "portal-sentinel", "client-sentinel", "database-sentinel"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatal("configuration JSON leaked a credential")
		}
	}
	if fmt.Sprint(c.Management.Key) != "[REDACTED]" || !c.Management.Key.LogValue().Equal(slog.StringValue("[REDACTED]")) {
		t.Fatal("secret wrappers failed")
	}
	if len(c.Secrets()) != 5 {
		t.Fatal("redaction registry missing credentials")
	}
}

func TestRejectedConfiguration(t *testing.T) {
	cases := map[string]string{
		"syntax":         "control-portal: [portal-sentinel",
		"empty":          "",
		"sequence":       "- hello",
		"documents":      fixture + "---\nhello: world\n",
		"second-invalid": fixture + "---\n[",
		"unknown":        fixture + "unknown: portal-sentinel\n",
		"duplicate":      fixture + "management:\n  key: replacement\n",
		"type":           fixture + "limits:\n  max-jobs: invalid\n",
		"missing-env":    strings.ReplaceAll(fixture, "portal-sentinel", "${ABSENT}"),
		"bad-env":        strings.ReplaceAll(fixture, "portal-sentinel", "${BAD-NAME}"),
		"alias":          fixture + "limits: &base\n  max-jobs: 1\nother: *base\n",
		"oversize":       strings.Repeat("#", 1024*1024+1),
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Parse([]byte(input), absent)
			if err == nil {
				t.Fatal("accepted invalid configuration")
			}
			var ce *Error
			if !errors.As(err, &ce) || ce.Reason == "" {
				t.Fatal("missing safe cause")
			}
			if strings.Contains(err.Error(), "portal-sentinel") {
				t.Fatal("error leaked input")
			}
		})
	}
	_, err := Parse([]byte(strings.ReplaceAll(fixture, "portal-sentinel", "${EMPTY}")), func(string) (string, bool) { return "", true })
	if err == nil {
		t.Fatal("accepted empty reference")
	}
}

func TestConfigurationValidation(t *testing.T) {
	cases := map[string]func(*Config){
		"listen":             func(c *Config) { c.Server.Listen = "bad" },
		"port-zero":          func(c *Config) { c.Server.Listen = ":0" },
		"port-large":         func(c *Config) { c.Server.Listen = ":65536" },
		"public-http":        func(c *Config) { c.Server.PublicURL = "http://muse.example.test" },
		"public-credentials": func(c *Config) { c.Server.PublicURL = "https://u:p@example.test" },
		"public-path":        func(c *Config) { c.Server.PublicURL = "https://example.test/path" },
		"public-query":       func(c *Config) { c.Server.PublicURL = "https://example.test/?credential=x" },
		"public-invalid":     func(c *Config) { c.Server.PublicURL = "https://%" },
		"db-invalid":         func(c *Config) { c.Database.URL = "postgres://%" },
		"db-scheme":          func(c *Config) { c.Database.URL = "sqlite://db/muse" },
		"db-name":            func(c *Config) { c.Database.URL = "postgres://db/" },
		"portal":             func(c *Config) { c.Portal.Password = " " },
		"management-reuse":   func(c *Config) { c.Management.Key = c.Portal.Password },
		"management-empty":   func(c *Config) { c.Management.Key = " " },
		"management-space":   func(c *Config) { c.Management.Key = "admin secret" },
		"management-tab":     func(c *Config) { c.Management.Key = "admin\tsecret" },
		"management-newline": func(c *Config) { c.Management.Key = "admin\nsecret" },
		"management-cr":      func(c *Config) { c.Management.Key = "admin\rsecret" },
		"client-name":        func(c *Config) { c.ClientKeys = map[string]Secret{"": "key"} },
		"client-long":        func(c *Config) { c.ClientKeys = map[string]Secret{strings.Repeat("x", 101): "key"} },
		"client-empty":       func(c *Config) { c.ClientKeys = map[string]Secret{"client": " "} },
		"client-reuse":       func(c *Config) { c.ClientKeys = map[string]Secret{"client": c.Management.Key} },
		"limits":             func(c *Config) { c.Limits.MaxWorkers = 0 },
		"jobs":               func(c *Config) { c.Limits.MaxJobs = 0 },
		"flight":             func(c *Config) { c.Limits.InFlight = 2 },
		"level":              func(c *Config) { c.Diagnostics.Level = "trace" },
		"directory":          func(c *Config) { c.Diagnostics.Directory = "relative" },
		"root-directory":     func(c *Config) { c.Diagnostics.Directory = "/" },
		"retention":          func(c *Config) { c.Diagnostics.RetentionDays = 8 },
		"capacity":           func(c *Config) { c.Diagnostics.MaxBytes = 1 },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			c, err := Parse([]byte(fixture), absent)
			if err != nil {
				t.Fatal(err)
			}
			change(&c)
			if c.Validate() == nil {
				t.Fatal("accepted invalid setting")
			}
		})
	}
	c, _ := Parse([]byte(fixture), absent)
	c.Database.URL = "postgres://db/muse"
	if len(c.Secrets()) != 4 {
		t.Fatal("unexpected password registration")
	}
}

func TestSafeOriginalLocations(t *testing.T) {
	for _, tc := range []struct {
		source, field, reason string
		line                  int
	}{
		{fixture + "unsupported-private-name: private-value\n", "<unknown>", "unknown_field", 11},
		{fixture + "management:\n  key: other\n", "management", "duplicate_field", 11},
		{strings.ReplaceAll(fixture, "portal-sentinel", "${MISSING}"), "control-portal.password", "unresolved_environment_reference", 8},
		{"control-portal:\n  password: credential-sentinel\nbroken: [", "configuration", "invalid_yaml", 0},
	} {
		_, err := Parse([]byte(tc.source), absent)
		var ce *Error
		if !errors.As(err, &ce) || ce.Field != tc.field || ce.Reason != tc.reason || ce.Line < 1 || ce.Column < 1 {
			t.Fatalf("safe location missing for %s", tc.reason)
		}
		if tc.line > 0 && ce.Line != tc.line {
			t.Fatalf("original line changed for %s: %d", tc.reason, ce.Line)
		}
		if strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "credential-sentinel") {
			t.Fatal("diagnostic exposed input")
		}
	}
}

func TestEscapedHTTPControlBytesRejected(t *testing.T) {
	for _, b := range append([]byte{127}, []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31}...) {
		encoded := fmt.Sprintf(`"admin\u%04xkey"`, b)
		source := strings.ReplaceAll(fixture, "management-sentinel", encoded)
		_, err := Parse([]byte(source), absent)
		var ce *Error
		if !errors.As(err, &ce) || ce.Field != "management.key" || ce.Line != 6 || ce.Column < 1 {
			t.Fatalf("HTTP control byte %d was not rejected at its safe source location", b)
		}
		if strings.Contains(err.Error(), "admin") || strings.Contains(err.Error(), "key\x00") {
			t.Fatal("rejection exposed credential contents")
		}
	}
	if usableBearerKey("") || !usableBearerKey("ordinary-token_+/=~.") {
		t.Fatal("Bearer character validation rejected a usable key")
	}
}
