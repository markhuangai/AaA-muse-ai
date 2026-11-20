package sqlite

import (
	"context"
	"database/sql"
)

func (r *Repository) MediaCleanupStates(ctx context.Context, ids []string) (map[string]string, error) {
	states := map[string]string{}
	err := r.read(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT id, CASE
		 WHEN state IN ('interrupted','cancelled') THEN state
		 WHEN state='accepted' AND media_expires_at <= ?2 THEN 'expired'
		 WHEN state='accepted' THEN 'completed' ELSE 'active' END
		 FROM aaa_inference_jobs WHERE id IN (SELECT value FROM json_each(?1)) AND has_media`, idList(ids), r.databaseTime().UnixMicro())
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
