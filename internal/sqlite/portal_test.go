package sqlite

import (
	"errors"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
)

func TestSQLitePortalGrantCapacityExpiryAndRevocation(t *testing.T) {
	path := privatePath(t)
	repo := openRepo(t, path)
	ctx := t.Context()
	if err := repo.Bootstrap(ctx); err != nil {
		t.Fatal(err)
	}
	other := openRepo(t, path)
	state := auth.PortalPasswordState{Generation: 1, Salt: make([]byte, 16), Verifier: make([]byte, 32)}
	if applied, err := repo.ReplacePortalPassword(ctx, state); err != nil || !applied {
		t.Fatal("could not write password generation", err)
	}
	if applied, err := other.ReplacePortalPassword(ctx, state); err != nil || applied {
		t.Fatal("stale startup replaced the password generation", err)
	}
	old := auth.Digest("first grant")
	live := auth.Digest("second grant")
	next := auth.Digest("third grant")
	now := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	expiry := now.Add(time.Hour)
	issue := func(digest [32]byte, at, expires time.Time) error {
		return repo.IssuePortalGrant(ctx, 1, digest, [32]byte{}, at, expires, 2)
	}
	if err := issue(old, now, expiry); err != nil {
		t.Fatal(err)
	}
	if err := issue(old, now, expiry); !errors.Is(err, auth.ErrPortalCollision) {
		t.Fatal("duplicate grant was accepted", err)
	}
	if err := issue(live, now, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if err := issue(next, now, time.Time{}); !errors.Is(err, auth.ErrPortalCapacity) {
		t.Fatal("grant capacity was exceeded", err)
	}
	if _, err := other.PortalGrant(ctx, 1, old, expiry); !errors.Is(err, auth.ErrPortalGrant) {
		t.Fatal("elapsed remembered grant still authenticated", err)
	}
	if err := issue(next, expiry, expiry.Add(time.Hour)); err != nil {
		t.Fatal("expired grant was not reclaimed", err)
	}
	if removed, err := other.RevokePortalGrant(ctx, 1, next); err != nil || !removed {
		t.Fatal("sign-out did not delete grant", err)
	}
	if renewed, err := repo.RenewPortalGrant(ctx, 1, next, expiry.Add(time.Hour), expiry.Add(2*time.Hour)); err != nil || renewed {
		t.Fatal("in-flight renewal recreated a revoked grant", err)
	}
	if expires, err := other.PortalGrant(ctx, 1, live, expiry.Add(500*24*time.Hour)); err != nil || !expires.IsZero() {
		t.Fatal("nonpersistent browser session has a server timeout", err)
	}
}
