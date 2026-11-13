package service

import (
	"encoding/hex"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
)

const PortalSessionLifetime = 30 * time.Minute
const PortalCapacity = 1024

type PortalError struct {
	Reason     string
	Status     int
	RetryAfter int
}

func (e *PortalError) Error() string { return e.Reason }

type PortalSession struct {
	Token     string    `json:"session_token"`
	ExpiresAt time.Time `json:"expires_at"`
}

type PortalIdentity struct {
	ID        string
	ExpiresAt time.Time
}

type portalWindow struct {
	Started time.Time
	Count   int
}

func (w *portalWindow) reset(now time.Time) {
	if w.Started.IsZero() || !now.Before(w.Started.Add(time.Minute)) {
		*w = portalWindow{Started: now}
	}
}

type portalRecord struct {
	PortalIdentity
	Reports portalWindow
}

type Portal struct {
	mu                sync.Mutex
	authority         *auth.Authority
	random            io.Reader
	now               func() time.Time
	sessions          map[[32]byte]portalRecord
	peers             map[string]portalWindow
	failures, reports portalWindow
}

func NewPortal(authority *auth.Authority, random io.Reader, now func() time.Time) *Portal {
	return &Portal{authority: authority, random: random, now: now, sessions: map[[32]byte]portalRecord{}, peers: map[string]portalWindow{}}
}

func PortalSettings() map[string]any {
	return map[string]any{"session_lifetime_seconds": 1800, "session_capacity": PortalCapacity, "peer_capacity": PortalCapacity,
		"failed_logins_per_peer_minute": 5, "failed_logins_per_minute": 60, "browser_event_max_bytes": 4096,
		"browser_events_per_session_minute": 20, "browser_events_per_minute": 120,
		"request_timeout_ms": 10000, "refresh_interval_ms": 30000, "stale_after_ms": 60000}
}

func (p *Portal) prune(now time.Time, logger *slog.Logger) {
	for digest, record := range p.sessions {
		if !now.Before(record.ExpiresAt) {
			delete(p.sessions, digest)
			logger.Info("portal.session_ended", "portal_session_id", record.ID, "cause", "session_expired", "outcome", "invalidated")
		}
	}
	for peer, window := range p.peers {
		if !now.Before(window.Started.Add(time.Minute)) {
			delete(p.peers, peer)
		}
	}
}

func (p *Portal) Login(logger *slog.Logger, peer, password string) (PortalSession, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now().UTC()
	p.prune(now, logger)
	p.failures.reset(now)
	window, exists := p.peers[peer]
	window.reset(now)
	loginAttempt := window.Count + 1
	denied := func(reason string, status int, retry int) (PortalSession, error) {
		logger.Warn("portal.auth_failed", "component", "login", "cause", reason, "peer", peer, "peer_failures", window.Count,
			"global_failures", p.failures.Count, "retry_after_seconds", retry, "attempt", loginAttempt, "expected_state", "authenticated", "observed_state", "unauthenticated", "outcome", "rejected")
		return PortalSession{}, &PortalError{Reason: reason, Status: status, RetryAfter: retry}
	}
	if p.failures.Count >= 60 || window.Count >= 5 || (!exists && len(p.peers) >= PortalCapacity) {
		until := window.Started.Add(time.Minute)
		if p.failures.Count >= 60 {
			until = p.failures.Started.Add(time.Minute)
		}
		return denied("login_throttled", 429, max(1, int(until.Sub(now).Seconds()+0.999)))
	}
	if !p.authority.PortalPassword(password) {
		window.Count++
		p.peers[peer] = window
		p.failures.Count++
		return denied("wrong_password", 401, 0)
	}
	if len(p.sessions) >= PortalCapacity {
		return denied("session_capacity_exhausted", 503, 0)
	}
	for attempt := 1; attempt <= 3; attempt++ {
		token, err := auth.Token(auth.PortalPrefix, p.random)
		if err != nil {
			logger.Error("portal.login_failed", "component", "login", "cause", "session_entropy_failed", "attempt", attempt, "outcome", "not_created")
			return PortalSession{}, &PortalError{Reason: "session_entropy_failed", Status: 503}
		}
		digest := auth.Digest(token)
		if _, duplicate := p.sessions[digest]; duplicate || p.authority.Reserved(token) {
			continue
		}
		identity := PortalIdentity{ID: hex.EncodeToString(digest[:16]), ExpiresAt: now.Add(PortalSessionLifetime)}
		p.sessions[digest] = portalRecord{PortalIdentity: identity}
		logger.Info("portal.session_created", "component", "login", "portal_session_id", identity.ID, "expires_at", identity.ExpiresAt, "attempt", attempt, "outcome", "authenticated")
		return PortalSession{Token: token, ExpiresAt: identity.ExpiresAt}, nil
	}
	logger.Error("portal.login_failed", "component", "login", "cause", "session_collision", "attempt", 3, "outcome", "not_created")
	return PortalSession{}, &PortalError{Reason: "session_collision", Status: 503}
}

func (p *Portal) session(logger *slog.Logger, credential string) (portalRecord, error) {
	if !auth.ValidToken(credential, auth.PortalPrefix) {
		return portalRecord{}, &PortalError{Reason: "invalid_session", Status: 401}
	}
	digest := auth.Digest(credential)
	record, ok := p.sessions[digest]
	if !ok {
		return portalRecord{}, &PortalError{Reason: "invalid_session", Status: 401}
	}
	if !p.now().Before(record.ExpiresAt) {
		delete(p.sessions, digest)
		logger.Info("portal.session_ended", "portal_session_id", record.ID, "cause", "session_expired", "outcome", "invalidated")
		return portalRecord{}, &PortalError{Reason: "session_expired", Status: 401}
	}
	return record, nil
}

func (p *Portal) Authenticate(logger *slog.Logger, credential string) (PortalIdentity, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	record, err := p.session(logger, credential)
	return record.PortalIdentity, err
}

func (p *Portal) Logout(logger *slog.Logger, credential string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	record, err := p.session(logger, credential)
	if err != nil {
		return err
	}
	delete(p.sessions, auth.Digest(credential))
	logger.Info("portal.session_ended", "component", "logout", "portal_session_id", record.ID, "cause", "logout", "outcome", "invalidated")
	return nil
}
