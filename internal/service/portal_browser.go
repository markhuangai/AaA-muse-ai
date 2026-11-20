package service

import (
	"context"
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/sqlite"
)

const PortalRememberLifetime = 400 * 24 * time.Hour
const portalRenewInterval = 24 * time.Hour

type PortalBrowserRepository interface {
	PortalPassword(context.Context) (auth.PortalPasswordState, error)
	ReplacePortalPassword(context.Context, auth.PortalPasswordState) (bool, error)
	IssuePortalGrant(context.Context, int64, [32]byte, [32]byte, time.Time, time.Time, int) error
	PortalGrant(context.Context, int64, [32]byte, time.Time) (time.Time, error)
	RenewPortalGrant(context.Context, int64, [32]byte, time.Time, time.Time) (bool, error)
	RevokePortalGrant(context.Context, int64, [32]byte) (bool, error)
}

func portalPasswordVerifier(password string, salt []byte) ([]byte, error) {
	return pbkdf2.Key(sha256.New, password, salt, 600_000, 32)
}

func matchesPortalPassword(password string, state auth.PortalPasswordState) (bool, error) {
	if state.Generation == 0 {
		return false, nil
	}
	verifier, err := portalPasswordVerifier(password, state.Salt)
	return subtle.ConstantTimeCompare(verifier, state.Verifier) == 1, err
}

func (p *Portal) ConfigureBrowser(ctx context.Context, logger *slog.Logger, repository PortalBrowserRepository, password string) error {
	state, err := repository.PortalPassword(ctx)
	if err != nil {
		return browserStoreFailure(logger, "read_password_generation", err)
	}
	matches, err := matchesPortalPassword(password, state)
	if err != nil {
		return browserStoreFailure(logger, "verify_password_generation", err)
	}
	if !matches {
		next := auth.PortalPasswordState{Generation: state.Generation + 1, Salt: make([]byte, 16)}
		if _, err := io.ReadFull(p.random, next.Salt); err != nil {
			return browserStoreFailure(logger, "generate_password_salt", err)
		}
		next.Verifier, err = portalPasswordVerifier(password, next.Salt)
		if err != nil {
			return browserStoreFailure(logger, "derive_password_verifier", err)
		}
		replaced, err := repository.ReplacePortalPassword(ctx, next)
		if err != nil {
			return browserStoreFailure(logger, "replace_password_generation", err)
		}
		if replaced {
			state = next
			logger.Info("portal.password_generation_changed", "generation", state.Generation, "outcome", "prior_browser_grants_invalidated")
		} else {
			state, err = repository.PortalPassword(ctx)
			if err != nil {
				return browserStoreFailure(logger, "read_concurrent_password_generation", err)
			}
			matches, err = matchesPortalPassword(password, state)
			if err != nil {
				return browserStoreFailure(logger, "verify_concurrent_password_generation", err)
			}
			if !matches {
				return browserStoreFailure(logger, "verify_concurrent_password_generation", auth.ErrPortalGeneration)
			}
		}
	}
	p.browser = repository
	p.browserGeneration = state.Generation
	return nil
}

func browserStoreFailure(logger *slog.Logger, stage string, err error) error {
	rejected := &PortalError{Reason: "portal_session_unavailable", Status: 503}
	if errors.Is(err, auth.ErrPortalGeneration) {
		logger.Warn("portal.session_generation_stale", "component", "session", "stage", stage, "cause", auth.ErrPortalGeneration.Error(),
			"expected_state", "current_generation", "observed_state", "stale_generation", "outcome", "rejected")
		return rejected
	}
	failure := sqlite.Classify(err)
	logger.Error("portal.session_store_failed", "component", "session", "stage", stage, "cause", failure.Reason,
		"sqlite_code", failure.Code, "failure_phase", failure.Phase, "transaction_outcome", failure.Outcome,
		"expected_state", "available", "observed_state", "unavailable", "outcome", "failed")
	if failure.Code != "" {
		logger.Debug("portal.session_store_detail", "stage", stage, "sqlite_code", failure.Code, "detail", failure.Detail())
	}
	return rejected
}

func (p *Portal) LoginBrowser(ctx context.Context, logger *slog.Logger, peer, password, previous string, remember bool) (string, error) {
	now := p.now().UTC()
	mode := "browser_session"
	var expires time.Time
	if remember {
		expires = now.Add(PortalRememberLifetime)
		mode = "remembered"
	}
	logger = logger.With("session_mode", mode)
	p.mu.Lock()
	err := p.checkPassword(logger, peer, password, now)
	p.mu.Unlock()
	if err != nil {
		return "", err
	}
	if p.browser == nil {
		return "", browserStoreFailure(logger, "issue", errors.New("portal_store_not_configured"))
	}
	var old [32]byte
	if auth.ValidToken(previous, auth.PortalPrefix) {
		old = auth.Digest(previous)
	}
	for attempt := 1; attempt <= 3; attempt++ {
		token, err := auth.Token(auth.PortalPrefix, p.random)
		if err != nil {
			logger.Error("portal.login_failed", "component", "login", "cause", "session_entropy_failed", "attempt", attempt, "outcome", "not_created")
			return "", &PortalError{Reason: "session_entropy_failed", Status: 503}
		}
		digest := auth.Digest(token)
		if digest == old || p.authority.Reserved(token) {
			continue
		}
		id := hex.EncodeToString(digest[:16])
		err = p.browser.IssuePortalGrant(ctx, p.browserGeneration, digest, old, now, expires, PortalCapacity)
		if errors.Is(err, auth.ErrPortalCollision) {
			continue
		}
		if errors.Is(err, auth.ErrPortalCapacity) {
			logger.Warn("portal.auth_failed", "component", "login", "cause", auth.ErrPortalCapacity.Error(),
				"capacity", PortalCapacity, "attempt", attempt, "outcome", "rejected")
			return "", &PortalError{Reason: auth.ErrPortalCapacity.Error(), Status: 503}
		}
		if err != nil {
			return "", browserStoreFailure(logger.With("attempt", attempt), "issue", err)
		}
		issued := logger.With("component", "login", "portal_session_id", id, "attempt", attempt)
		if !expires.IsZero() {
			issued = issued.With("expires_at", expires)
		}
		issued.Info("portal.session_created", "outcome", "authenticated")
		return token, nil
	}
	logger.Error("portal.login_failed", "component", "login", "cause", "session_collision", "attempt", 3, "outcome", "not_created")
	return "", &PortalError{Reason: "session_collision", Status: 503}
}

func (p *Portal) AuthenticateBrowser(ctx context.Context, logger *slog.Logger, credential string) (PortalIdentity, bool, error) {
	if !auth.ValidToken(credential, auth.PortalPrefix) {
		return PortalIdentity{}, false, &PortalError{Reason: "invalid_session", Status: 401}
	}
	digest := auth.Digest(credential)
	id := hex.EncodeToString(digest[:16])
	logger = logger.With("portal_session_id", id)
	if p.browser == nil {
		return PortalIdentity{}, false, browserStoreFailure(logger, "authenticate", errors.New("portal_store_not_configured"))
	}
	now := p.now().UTC()
	expires, err := p.browser.PortalGrant(ctx, p.browserGeneration, digest, now)
	if errors.Is(err, auth.ErrPortalGrant) {
		return PortalIdentity{ID: id}, false, &PortalError{Reason: "invalid_session", Status: 401}
	}
	if err != nil {
		return PortalIdentity{}, false, browserStoreFailure(logger, "authenticate", err)
	}
	identity := PortalIdentity{ID: id, ExpiresAt: expires}
	if expires.IsZero() || expires.After(now.Add(PortalRememberLifetime-portalRenewInterval)) {
		return identity, false, nil
	}
	next := now.Add(PortalRememberLifetime)
	renewed, err := p.browser.RenewPortalGrant(ctx, p.browserGeneration, digest, expires, next)
	if err != nil {
		return PortalIdentity{}, false, browserStoreFailure(logger, "renew", err)
	}
	if renewed {
		identity.ExpiresAt = next
		logger.Info("portal.session_renewed", "component", "session", "session_mode", "remembered", "expires_at", next, "outcome", "renewed")
	}
	return identity, renewed, nil
}

func (p *Portal) LogoutBrowser(ctx context.Context, logger *slog.Logger, credential string) error {
	if !auth.ValidToken(credential, auth.PortalPrefix) {
		return nil
	}
	digest := auth.Digest(credential)
	id := hex.EncodeToString(digest[:16])
	logger = logger.With("portal_session_id", id)
	if p.browser == nil {
		return browserStoreFailure(logger, "logout", errors.New("portal_store_not_configured"))
	}
	removed, err := p.browser.RevokePortalGrant(ctx, p.browserGeneration, digest)
	if err != nil {
		return browserStoreFailure(logger, "logout", err)
	}
	outcome := "already_inactive"
	if removed {
		outcome = "invalidated"
	}
	logger.Info("portal.session_ended", "component", "logout", "session_mode", "browser", "cause", "logout", "outcome", outcome)
	return nil
}
