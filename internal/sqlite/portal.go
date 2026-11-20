package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
)

func (r *Repository) PortalPassword(ctx context.Context) (auth.PortalPasswordState, error) {
	var state auth.PortalPasswordState
	err := r.db.QueryRowContext(ctx, "SELECT generation,salt,verifier FROM aaa_portal_password WHERE id=1").
		Scan(&state.Generation, &state.Salt, &state.Verifier)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return state, err
}

func (r *Repository) ReplacePortalPassword(ctx context.Context, state auth.PortalPasswordState) (bool, error) {
	replaced := false
	err := r.write(ctx, func(tx *sql.Tx) error {
		const query = `INSERT INTO aaa_portal_password(id,generation,salt,verifier) VALUES(1,?1,?2,?3)
			ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,salt=excluded.salt,verifier=excluded.verifier
			WHERE aaa_portal_password.generation=excluded.generation-1`
		result, err := tx.ExecContext(ctx, query, state.Generation, state.Salt, state.Verifier)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil || count == 0 {
			return err
		}
		replaced = true
		_, err = tx.ExecContext(ctx, "DELETE FROM aaa_portal_grants")
		return err
	})
	return replaced, err
}

func currentPortalGeneration(ctx context.Context, tx *sql.Tx, generation int64) error {
	var current int64
	if err := tx.QueryRowContext(ctx, "SELECT generation FROM aaa_portal_password WHERE id=1").Scan(&current); err != nil {
		return err
	}
	if current != generation {
		return auth.ErrPortalGeneration
	}
	return nil
}

func (r *Repository) IssuePortalGrant(ctx context.Context, generation int64, digest, previous [32]byte, now, expires time.Time, capacity int) error {
	return r.write(ctx, func(tx *sql.Tx) error {
		if err := currentPortalGeneration(ctx, tx, generation); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM aaa_portal_grants WHERE expires_at<=?1 OR digest=?2", now.UnixMicro(), previous[:]); err != nil {
			return err
		}
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM aaa_portal_grants").Scan(&count); err != nil {
			return err
		}
		if count >= capacity {
			return auth.ErrPortalCapacity
		}
		var storedExpiry any
		if !expires.IsZero() {
			storedExpiry = expires.UnixMicro()
		}
		result, err := tx.ExecContext(ctx, "INSERT INTO aaa_portal_grants(digest,generation,expires_at) VALUES(?1,?2,?3) ON CONFLICT DO NOTHING", digest[:], generation, storedExpiry)
		if err != nil {
			return err
		}
		countInserted, err := result.RowsAffected()
		if err == nil && countInserted == 0 {
			return auth.ErrPortalCollision
		}
		return err
	})
}

func (r *Repository) PortalGrant(ctx context.Context, generation int64, digest [32]byte, now time.Time) (time.Time, error) {
	var current int64
	var found bool
	var expires *int64
	const query = `SELECT p.generation,g.digest IS NOT NULL,g.expires_at FROM aaa_portal_password p
		LEFT JOIN aaa_portal_grants g ON g.generation=p.generation AND g.digest=?1 WHERE p.id=1`
	if err := r.db.QueryRowContext(ctx, query, digest[:]).Scan(&current, &found, &expires); err != nil {
		return time.Time{}, err
	}
	if current != generation {
		return time.Time{}, auth.ErrPortalGeneration
	}
	if !found || (expires != nil && *expires <= now.UnixMicro()) {
		return time.Time{}, auth.ErrPortalGrant
	}
	if expires == nil {
		return time.Time{}, nil
	}
	return time.UnixMicro(*expires).UTC(), nil
}

func (r *Repository) RenewPortalGrant(ctx context.Context, generation int64, digest [32]byte, previous, expires time.Time) (bool, error) {
	const query = `UPDATE aaa_portal_grants SET expires_at=?1 WHERE digest=?2 AND generation=?3 AND expires_at=?4
		AND generation=(SELECT generation FROM aaa_portal_password WHERE id=1)`
	result, err := r.db.ExecContext(ctx, query, expires.UnixMicro(), digest[:], generation, previous.UnixMicro())
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count == 1, err
}

func (r *Repository) RevokePortalGrant(ctx context.Context, generation int64, digest [32]byte) (bool, error) {
	removed := false
	err := r.write(ctx, func(tx *sql.Tx) error {
		if err := currentPortalGeneration(ctx, tx, generation); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, "DELETE FROM aaa_portal_grants WHERE digest=?1 AND generation=?2", digest[:], generation)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		removed = count == 1
		return err
	})
	return removed, err
}
