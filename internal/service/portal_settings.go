package service

import (
	"context"
	"log/slog"
	"regexp"
	"strconv"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"go.yaml.in/yaml/v3"
)

type PortalConfiguration struct {
	Build         Build    `json:"build"`
	InstanceID    string   `json:"instance_id"`
	PublicOrigin  string   `json:"public_origin"`
	Ready         bool     `json:"ready"`
	Database      string   `json:"database"`
	SchemaVersion int      `json:"schema_version"`
	EffectiveYAML string   `json:"effective_yaml"`
	Capabilities  []string `json:"capabilities"`
}

func (s *Service) PortalConfiguration(ctx context.Context, logger *slog.Logger) (PortalConfiguration, error) {
	started := s.now()
	status := s.Status(ctx, logger)
	redactor := diagnostics.NewRedactor(s.config.Secrets())
	var document yaml.Node
	var data []byte
	err := document.Encode(status.Configuration)
	if err == nil {
		redactPortalYAML(&document, redactor)
		data, err = yaml.Marshal(&document)
	}
	if err != nil {
		logger.Error("portal.settings_failed", "component", "settings", "cause", "yaml_encoding_failed", "outcome", "failed")
		return PortalConfiguration{}, err
	}
	result := PortalConfiguration{Build: status.Build, InstanceID: status.InstanceID, PublicOrigin: redactor.Text(s.config.Server.PublicURL),
		Ready: status.Ready, Database: status.Database, SchemaVersion: status.SchemaVersion, EffectiveYAML: string(data),
		Capabilities: []string{"Native requests", "OpenAI Chat Completions — text and client function tools", "OpenAI Responses — typed items and linear continuation", "Buffered SSE lifecycle events"}}
	if !status.Ready {
		logger.Warn("portal.state_stale", "component", "settings", "cause", status.Database, "expected_state", "ready", "observed_state", "unavailable", "outcome", "degraded")
	}
	logger.Debug("portal.settings_detail", "component", "settings", "settings", result, "duration_ms", s.now().Sub(started).Milliseconds(), "outcome", "returned")
	return result, nil
}

func redactPortalYAML(node *yaml.Node, redactor *diagnostics.Redactor) {
	if node.Kind == yaml.ScalarNode && node.Tag == "!!str" {
		node.Value = redactor.Text(node.Value)
	}
	for _, child := range node.Content {
		redactPortalYAML(child, redactor)
	}
	if node.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i < len(node.Content); i += 2 {
			key := node.Content[i]
			base := key.Value
			for suffix := 2; seen[key.Value]; suffix++ {
				key.Value = base + "#" + strconv.Itoa(suffix)
			}
			seen[key.Value] = true
		}
	}
}

type PortalReport struct {
	Event          string     `json:"event"`
	Build          string     `json:"build"`
	Component      string     `json:"component"`
	Cause          string     `json:"cause"`
	RequestID      string     `json:"request_id"`
	OperationID    string     `json:"operation_id"`
	Expected       string     `json:"expected_state"`
	Observed       string     `json:"observed_state"`
	LastGoodAt     *time.Time `json:"last_good_at"`
	DurationMS     int64      `json:"duration_ms"`
	Attempt        int        `json:"attempt"`
	OmittedReports int        `json:"omitted_reports"`
}

var portalIdentifier = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)
var portalBuild = regexp.MustCompile(`^([a-f0-9]{40}|development)$`)

func oneOf(value string, choices ...string) bool {
	for _, choice := range choices {
		if value == choice {
			return true
		}
	}
	return false
}

func (r PortalReport) valid() bool {
	return oneOf(r.Event, "portal.state_stale", "portal.render_failed") && portalBuild.MatchString(r.Build) &&
		oneOf(r.Component, "settings", "shell", "login") &&
		oneOf(r.Cause, "request_failed", "request_timeout", "service_unavailable", "session_expired", "build_mismatch", "render_exception", "stale_data") &&
		(r.RequestID == "" || portalIdentifier.MatchString(r.RequestID)) && portalIdentifier.MatchString(r.OperationID) &&
		oneOf(r.Expected, "fresh", "rendered", "authenticated") && oneOf(r.Observed, "stale", "failed", "unauthenticated") &&
		r.DurationMS >= 0 && r.DurationMS <= 86400000 && r.Attempt >= 1 && r.Attempt <= 1000000 && r.OmittedReports >= 0 && r.OmittedReports <= 1000000
}

func (p *Portal) Report(logger *slog.Logger, credential string, input PortalReport) error {
	if !input.valid() {
		return &PortalError{Reason: "invalid_browser_report", Status: 400}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	record, err := p.session(logger, credential)
	if err != nil {
		return err
	}
	now := p.now()
	p.reports.reset(now)
	record.Reports.reset(now)
	if p.reports.Count >= 120 || record.Reports.Count >= 20 {
		logger.Warn("portal.report_throttled", "portal_session_id", record.ID, "cause", "browser_report_limit", "outcome", "rejected")
		return &PortalError{Reason: "browser_report_limit", Status: 429, RetryAfter: 60}
	}
	p.reports.Count++
	record.Reports.Count++
	p.sessions[auth.Digest(credential)] = record
	fields := []any{"client_report", true, "portal_session_id", record.ID, "client_build", input.Build, "component", input.Component,
		"cause", input.Cause, "related_request_id", input.RequestID, "operation_id", input.OperationID, "expected_state", input.Expected,
		"observed_state", input.Observed, "last_good_at", input.LastGoodAt, "duration_ms", input.DurationMS, "attempt", input.Attempt,
		"omitted_reports", input.OmittedReports, "outcome", "reported"}
	logger.Debug("portal.browser_report", "client_report", true, "report", input, "portal_session_id", record.ID)
	if input.Event == "portal.render_failed" {
		logger.Error(input.Event, fields...)
	} else {
		logger.Warn(input.Event, fields...)
	}
	return nil
}
