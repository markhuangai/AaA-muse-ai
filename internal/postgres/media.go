package postgres

import (
	"context"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) MediaCleanupStates(ctx context.Context, ids []string) (map[string]string, error) {
	states := map[string]string{}
	err := r.workerTransaction(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id, CASE
		 WHEN state IN ('interrupted','cancelled') THEN state
		 WHEN state='accepted' AND (data->'media'->>'expires_at')::timestamptz <= clock_timestamp() THEN 'expired'
		 WHEN state='accepted' THEN 'completed' ELSE 'active' END
		 FROM aaa_inference_jobs WHERE id=ANY($1::text[]) AND data->'media' IS NOT NULL`, ids)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id, state string
			if err := rows.Scan(&id, &state); err != nil {
				return err
			}
			states[id] = state
		}
		return rows.Err()
	})
	return states, err
}
