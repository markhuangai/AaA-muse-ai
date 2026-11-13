package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"go.yaml.in/yaml/v3"
)

func portalFixture(random io.Reader) (*Portal, *time.Time, *slog.Logger, *bytes.Buffer) {
	c := config.Defaults()
	c.Management.Key, c.Portal.Password = "management-sentinel", "portal-sentinel"
	c.ClientKeys = map[string]config.Secret{"client": "client-sentinel"}
	now := time.Date(2026, 11, 13, 0, 0, 0, 0, time.UTC)
	var out bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&out, &slog.HandlerOptions{Level: slog.LevelDebug})).With("request_id", "request", "revision", "development", "instance_id", "instance")
	return NewPortal(auth.New(c), random, func() time.Time { return now }), &now, logger, &out
}

func portalRejection(t *testing.T, err error, status int, reason string) *PortalError {
	t.Helper()
	var rejected *PortalError
	if !errors.As(err, &rejected) || rejected.Status != status || rejected.Reason != reason {
		t.Fatal("incorrect portal rejection")
	}
	return rejected
}

func TestPortalSessionLifetimeLogoutAndRestart(t *testing.T) {
	p, now, logger, out := portalFixture(rand.Reader)
	session, err := p.Login(logger, "peer", "portal-sentinel")
	if err != nil || !auth.ValidToken(session.Token, auth.PortalPrefix) || session.ExpiresAt.Sub(*now) != PortalSessionLifetime {
		t.Fatal("session issuance failed")
	}
	identity, err := p.Authenticate(logger, session.Token)
	if err != nil || identity.ID == "" || identity.ExpiresAt != session.ExpiresAt {
		t.Fatal("session identity missing")
	}
	*now = now.Add(PortalSessionLifetime - time.Nanosecond)
	if _, err = p.Authenticate(logger, session.Token); err != nil {
		t.Fatal("session expired early")
	}
	*now = now.Add(time.Nanosecond)
	_, err = p.Authenticate(logger, session.Token)
	portalRejection(t, err, 401, "session_expired")
	_, err = p.Authenticate(logger, session.Token)
	portalRejection(t, err, 401, "invalid_session")
	_, err = p.Authenticate(logger, "malformed")
	portalRejection(t, err, 401, "invalid_session")
	if err = p.Logout(logger, session.Token); err == nil {
		t.Fatal("expired authority was restored")
	}
	session, err = p.Login(logger, "peer", "portal-sentinel")
	if err != nil {
		t.Fatal("fresh login failed")
	}
	restarted := NewPortal(p.authority, rand.Reader, p.now)
	_, err = restarted.Authenticate(logger, session.Token)
	portalRejection(t, err, 401, "invalid_session")
	if err = p.Logout(logger, session.Token); err != nil {
		t.Fatal("logout failed")
	}
	if _, err = p.Authenticate(logger, session.Token); err == nil {
		t.Fatal("logout did not invalidate token")
	}
	if strings.Contains(out.String(), session.Token) || !strings.Contains(out.String(), "portal.session_ended") {
		t.Fatal("unsafe or missing session lifecycle evidence")
	}
}

func TestPortalFailedLoginWindowsAndCapacity(t *testing.T) {
	p, now, logger, _ := portalFixture(rand.Reader)
	for i := 0; i < 5; i++ {
		_, err := p.Login(logger, "same-peer", "incorrect")
		portalRejection(t, err, 401, "wrong_password")
	}
	_, err := p.Login(logger, "same-peer", "portal-sentinel")
	if portalRejection(t, err, 429, "login_throttled").RetryAfter != 60 {
		t.Fatal("wrong retry window")
	}
	*now = now.Add(time.Minute)
	if _, err = p.Login(logger, "same-peer", "portal-sentinel"); err != nil {
		t.Fatal("expired login window remained locked")
	}
	for i := 0; i < 60; i++ {
		_, err = p.Login(logger, strconv.Itoa(i), "incorrect")
		portalRejection(t, err, 401, "wrong_password")
	}
	_, err = p.Login(logger, "new-peer", "portal-sentinel")
	portalRejection(t, err, 429, "login_throttled")
	*now = now.Add(time.Minute)
	if _, err = p.Login(logger, "new-peer", "portal-sentinel"); err != nil {
		t.Fatal("global login window did not reset")
	}
	p.peers = map[string]portalWindow{}
	for i := 0; i < PortalCapacity; i++ {
		p.peers[strconv.Itoa(i)] = portalWindow{Started: *now, Count: 1}
	}
	_, err = p.Login(logger, "overflow-peer", "portal-sentinel")
	portalRejection(t, err, 429, "login_throttled")
	*now = now.Add(time.Minute)
	if _, err = p.Login(logger, "overflow-peer", "portal-sentinel"); err != nil {
		t.Fatal("peer pruning failed")
	}
	for i := 0; i < PortalCapacity; i++ {
		p.sessions[auth.Digest(strconv.Itoa(i))] = portalRecord{PortalIdentity: PortalIdentity{ExpiresAt: now.Add(time.Minute)}}
	}
	_, err = p.Login(logger, "peer", "portal-sentinel")
	portalRejection(t, err, 503, "session_capacity_exhausted")
	*now = now.Add(PortalSessionLifetime)
	if _, err = p.Login(logger, "peer", "portal-sentinel"); err != nil || len(p.sessions) != 1 {
		t.Fatal("expired sessions were not pruned")
	}
}

func TestPortalEntropyAndCollisionFailures(t *testing.T) {
	p, _, logger, _ := portalFixture(bytes.NewReader(nil))
	_, err := p.Login(logger, "peer", "portal-sentinel")
	portalRejection(t, err, 503, "session_entropy_failed")
	if len(p.sessions) != 0 {
		t.Fatal("failed entropy created authority")
	}
	p, _, logger, _ = portalFixture(bytes.NewReader(bytes.Repeat([]byte{7}, 32*4)))
	first, err := p.Login(logger, "peer", "portal-sentinel")
	if err != nil {
		t.Fatal("initial issuance failed")
	}
	_, err = p.Login(logger, "peer", "portal-sentinel")
	portalRejection(t, err, 503, "session_collision")
	if len(p.sessions) != 1 {
		t.Fatal("collision replaced session state")
	}
	if _, err = p.Authenticate(logger, first.Token); err != nil {
		t.Fatal("collision invalidated existing authority")
	}
	p, _, logger, _ = portalFixture(bytes.NewReader(bytes.Repeat([]byte{8}, 32*3)))
	reserved, _ := auth.Token(auth.PortalPrefix, bytes.NewReader(bytes.Repeat([]byte{8}, 32)))
	c := config.Defaults()
	c.Management.Key = config.Secret(reserved)
	c.Portal.Password = "portal-sentinel"
	p.authority = auth.New(c)
	_, err = p.Login(logger, "peer", "portal-sentinel")
	portalRejection(t, err, 503, "session_collision")
}

func validPortalReport() PortalReport {
	return PortalReport{Event: "portal.state_stale", Build: "development", Component: "settings", Cause: "request_failed", OperationID: "operation", Expected: "fresh", Observed: "stale", Attempt: 1}
}

func TestPortalBrowserReportValidationAndLimits(t *testing.T) {
	p, now, logger, out := portalFixture(rand.Reader)
	session, err := p.Login(logger, "peer", "portal-sentinel")
	if err != nil {
		t.Fatal("login failed")
	}
	mutations := []func(*PortalReport){
		func(r *PortalReport) { r.Event = "arbitrary" }, func(r *PortalReport) { r.Build = "unsafe build" },
		func(r *PortalReport) { r.Component = "unknown" }, func(r *PortalReport) { r.Cause = "free-form details" },
		func(r *PortalReport) { r.RequestID = "bad identifier" }, func(r *PortalReport) { r.OperationID = "" },
		func(r *PortalReport) { r.Expected = "invalid" }, func(r *PortalReport) { r.Observed = "invalid" },
		func(r *PortalReport) { r.DurationMS = -1 }, func(r *PortalReport) { r.DurationMS = 86400001 },
		func(r *PortalReport) { r.Attempt = 0 }, func(r *PortalReport) { r.Attempt = 1000001 },
		func(r *PortalReport) { r.OmittedReports = -1 }, func(r *PortalReport) { r.OmittedReports = 1000001 },
	}
	for _, mutate := range mutations {
		input := validPortalReport()
		mutate(&input)
		portalRejection(t, p.Report(logger, session.Token, input), 400, "invalid_browser_report")
	}
	portalRejection(t, p.Report(logger, "invalid", validPortalReport()), 401, "invalid_session")
	input := validPortalReport()
	input.Event = "portal.render_failed"
	input.Component = "shell"
	input.Cause = "render_exception"
	input.Expected = "rendered"
	input.Observed = "failed"
	input.LastGoodAt = now
	if err = p.Report(logger, session.Token, input); err != nil {
		t.Fatal("render report rejected")
	}
	for i := 1; i < 20; i++ {
		if err = p.Report(logger, session.Token, validPortalReport()); err != nil {
			t.Fatal("valid report rejected")
		}
	}
	portalRejection(t, p.Report(logger, session.Token, validPortalReport()), 429, "browser_report_limit")
	*now = now.Add(time.Minute)
	if err = p.Report(logger, session.Token, validPortalReport()); err != nil {
		t.Fatal("report window did not reset")
	}
	for i := 0; i < 6; i++ {
		next, err := p.Login(logger, "peer", "portal-sentinel")
		if err != nil {
			t.Fatal("login failed")
		}
		for j := 0; j < 20 && p.reports.Count < 120; j++ {
			if err = p.Report(logger, next.Token, validPortalReport()); err != nil {
				t.Fatal("global report budget failed early")
			}
		}
	}
	portalRejection(t, p.Report(logger, session.Token, validPortalReport()), 429, "browser_report_limit")
	if strings.Contains(out.String(), session.Token) || !strings.Contains(out.String(), `"client_report":true`) || !strings.Contains(out.String(), `"level":"ERROR","msg":"portal.render_failed"`) || !strings.Contains(out.String(), `"level":"WARN","msg":"portal.state_stale"`) {
		t.Fatal("browser report evidence is unsafe or incomplete")
	}
	if PortalSettings()["session_lifetime_seconds"] != 1800 {
		t.Fatal("effective settings missing lifetime")
	}
}

func TestPortalEffectiveYAMLAndDegradedSettings(t *testing.T) {
	c := config.Defaults()
	c.Server.PublicURL = "https://service.example.test"
	c.Database.URL = "postgres://owner:database-sentinel@db/muse"
	c.Management.Key, c.Portal.Password = "management-sentinel", "portal-sentinel"
	c.ClientKeys = map[string]config.Secret{"<script>alert('unsafe')</script>": "client-sentinel", "alias-portal-sentinel": "other-client-sentinel"}
	db := &database{}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	svc := New(db, c, Build{Revision: "development"}, "instance", time.Now, logger)
	result, err := svc.PortalConfiguration(context.Background(), logger)
	if err != nil || !result.Ready || result.Build.Revision != "development" || len(result.Capabilities) != 4 || !strings.Contains(result.EffectiveYAML, "control-portal:") || !strings.Contains(result.EffectiveYAML, "[REDACTED]") {
		t.Fatal("effective settings missing")
	}
	for _, secret := range c.Secrets() {
		if strings.Contains(result.EffectiveYAML, secret) {
			t.Fatal("secret exposed in effective YAML")
		}
	}
	var parsed map[string]any
	if yaml.Unmarshal([]byte(result.EffectiveYAML), &parsed) != nil || parsed["control-portal"].(map[string]any)["password"] != "[REDACTED]" {
		t.Fatal("redacted YAML is not parseable")
	}
	db.err = errors.New("database stopped")
	result, err = svc.PortalConfiguration(context.Background(), logger)
	if err != nil || result.Ready || result.Database != "database_operation_failed" {
		t.Fatal("degraded service health was concealed")
	}
}

func TestPortalYAMLRedactsScalarValuesBeforeEncoding(t *testing.T) {
	for _, password := range []string{"portal-sentinel", "portal\nsentinel", "portal\"sentinel"} {
		c := config.Defaults()
		c.Portal.Password = config.Secret(password)
		c.ClientKeys = map[string]config.Secret{password: "client-one", "[REDACTED]": "client-two", "alias-" + password: "client-three"}
		logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
		svc := New(&database{}, c, Build{}, "instance", time.Now, logger)
		result, err := svc.PortalConfiguration(context.Background(), logger)
		if err != nil {
			t.Fatal(err)
		}
		var parsed map[string]any
		if err := yaml.Unmarshal([]byte(result.EffectiveYAML), &parsed); err != nil {
			t.Fatal("redacted effective YAML must remain parseable")
		}
		keys := parsed["client-keys"].(map[string]any)
		if len(keys) != len(c.ClientKeys) {
			t.Fatal("redaction lost a configured entry")
		}
		for key, value := range keys {
			if strings.Contains(key, password) || value != "[REDACTED]" {
				t.Fatal("decoded effective YAML exposed credential content")
			}
		}
	}
}
