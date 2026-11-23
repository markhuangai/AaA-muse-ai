package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func readWeeklyUsage(ctx context.Context, tx *sql.Tx, id string) (*worker.WeeklyUsage, error) {
	var sample worker.WeeklyUsage
	var observed int64
	err := tx.QueryRowContext(ctx, `SELECT used_percent,observed_at,reset_label FROM aaa_worker_weekly_usage
		WHERE worker_id=?1`, id).Scan(&sample.UsedPercent, &observed, &sample.ResetLabel)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	sample.ObservedAt = time.UnixMicro(observed).UTC()
	return &sample, err
}

func recordWeeklyUsage(ctx context.Context, tx *sql.Tx, id string, sample *worker.WeeklyUsage, scheduled, now time.Time) (string, error) {
	switch {
	case sample == nil:
		return "not_reported", nil
	case sample.ObservedAt.After(now):
		return "observation_in_future", nil
	case !sample.Fresh(now):
		return "observation_stale", nil
	case sample.ObservedAt.Before(scheduled):
		return "observation_before_occurrence", nil
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO aaa_worker_weekly_usage(worker_id,used_percent,observed_at,scheduled_at,reset_label)
		VALUES(?1,?2,?3,?4,?5) ON CONFLICT(worker_id) DO UPDATE SET used_percent=excluded.used_percent,
		observed_at=excluded.observed_at,scheduled_at=excluded.scheduled_at,reset_label=excluded.reset_label
		WHERE excluded.observed_at>observed_at AND excluded.scheduled_at>scheduled_at`,
		id, sample.UsedPercent, sample.ObservedAt.UnixMicro(), scheduled.UnixMicro(), sample.ResetLabel)
	if err != nil {
		return "", err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return "", err
	}
	if changed == 0 {
		return "older_or_duplicate_observation", nil
	}
	return "recorded", nil
}
