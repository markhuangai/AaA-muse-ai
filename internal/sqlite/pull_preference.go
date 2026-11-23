package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const pullPreference = time.Minute

type pullCandidate struct {
	job, experiment   string
	created, deadline int64
}

type pullLane struct {
	target, query string
	capability    int
	head          pullCandidate
}

const pullHead = `SELECT job.id,job.experiment_id,job.created_at,job.deadline_at
 FROM aaa_pull_levels AS level CROSS JOIN aaa_inference_jobs AS job
 WHERE ((level.shift<63 AND ((?3 >> level.shift) & 1)=0) OR (level.shift=63 AND ?3<0))
 AND job.id=(SELECT job_id FROM aaa_pull_queue INDEXED BY `

const pullHeadSeek = ` AND target=?1 AND capability=?2 AND shift=level.shift AND bucket=(?3 >> level.shift)+1
   AND (created_at,job_id)>(?4,?5) ORDER BY created_at,job_id LIMIT 1)
 ORDER BY job.created_at,job.id LIMIT 1`

const nextPullJob = pullHead + `aaa_pull_queue_head WHERE 1` + pullHeadSeek
const nextModelPullJob = pullHead + `aaa_pull_queue_model_head WHERE model_request=1` + pullHeadSeek

func (lane *pullLane) advance(ctx context.Context, tx *sql.Tx, now int64) error {
	var candidate pullCandidate
	err := tx.QueryRowContext(ctx, lane.query, lane.target, lane.capability, now, lane.head.created, lane.head.job).
		Scan(&candidate.job, &candidate.experiment, &candidate.created, &candidate.deadline)
	lane.head = candidate
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	return err
}

func pullLanes(ctx context.Context, tx *sql.Tx, target, query string, minCapability, maxCapability int, now int64) ([]pullLane, error) {
	lanes := make([]pullLane, 0, maxCapability-minCapability+1)
	for capability := minCapability; capability <= maxCapability; capability++ {
		lane := pullLane{target: target, query: query, capability: capability, head: pullCandidate{created: math.MinInt64}}
		if err := lane.advance(ctx, tx, now); err != nil {
			return nil, err
		}
		if lane.head.job != "" {
			lanes = append(lanes, lane)
		}
	}
	return lanes, nil
}

func oldestLane(lanes []pullLane) *pullLane {
	var oldest *pullLane
	for i := range lanes {
		lane := &lanes[i]
		if lane.head.job != "" && (oldest == nil || lane.head.created < oldest.head.created ||
			(lane.head.created == oldest.head.created && lane.head.job < oldest.head.job)) {
			oldest = lane
		}
	}
	return oldest
}

type preferredWorker struct {
	id         string
	percent    float64
	observed   time.Time
	capability int
}

const betterPullWorkers = `SELECT usage.worker_id,usage.used_percent,usage.observed_at,poll.available_capability
 FROM aaa_worker_weekly_usage AS usage INDEXED BY aaa_weekly_usage_rank
 CROSS JOIN aaa_worker_polls AS poll CROSS JOIN aaa_workers AS worker
 LEFT JOIN aaa_worker_updates AS update_state ON update_state.worker_id=usage.worker_id
 WHERE usage.used_percent<?1 AND usage.observed_at>?2 AND usage.observed_at<=?3
 AND poll.worker_id=usage.worker_id AND worker.id=usage.worker_id AND worker.revoked_at IS NULL
 AND poll.available_capability IS NOT NULL AND poll.available_major=?4
 AND poll.last_poll_at>?2 AND poll.scheduled_at>?2 AND poll.scheduled_at<=?3
 AND coalesce(json_extract(update_state.data,'$.state'),'') NOT IN ('offered','downloading','switching','awaiting_confirmation')
 AND NOT EXISTS (SELECT 1 FROM aaa_inference_jobs WHERE worker_id=usage.worker_id AND held)
 ORDER BY usage.used_percent,poll.available_capability,usage.worker_id`

func preferredPullWorkers(ctx context.Context, tx *sql.Tx, major string, percent float64, now, cutoff int64) ([]preferredWorker, error) {
	rows, err := tx.QueryContext(ctx, betterPullWorkers, percent, cutoff, now, major)
	if err != nil {
		return nil, err
	}
	var peers []preferredWorker
	for rows.Next() {
		var peer preferredWorker
		var observed int64
		if err = rows.Scan(&peer.id, &peer.percent, &observed, &peer.capability); err != nil {
			rows.Close()
			return nil, err
		}
		peer.observed = time.UnixMicro(observed).UTC()
		peers = append(peers, peer)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	available := peers[:0]
	for _, peer := range peers {
		lanes, err := pullLanes(ctx, tx, peer.id, nextPullJob, 0, peer.capability, now)
		if err != nil {
			return nil, err
		}
		if len(lanes) == 0 {
			available = append(available, peer)
		}
	}
	return available, nil
}

const exhaustedPullWorkers = `SELECT usage.worker_id FROM aaa_worker_weekly_usage AS usage INDEXED BY aaa_weekly_usage_rank
 CROSS JOIN aaa_workers AS worker WHERE usage.used_percent=100 AND usage.observed_at>?1 AND usage.observed_at<=?2
 AND worker.id=usage.worker_id AND worker.revoked_at IS NULL`

func exhaustedPullTargets(ctx context.Context, tx *sql.Tx, now, cutoff int64) ([]string, error) {
	rows, err := tx.QueryContext(ctx, exhaustedPullWorkers, cutoff, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func pickPullJob(ctx context.Context, tx *sql.Tx, workerID, major string, capability int, now time.Time, timing *inference.PullTiming) (pullCandidate, string, error) {
	percent := 100.0 // Unknown ranks below all workers with reported headroom.
	if timing.EffectiveUsage.Fresh(now) {
		percent = timing.EffectiveUsage.UsedPercent
		if percent == 100 {
			timing.UsageDecision = "worker_allowance_exhausted"
			return pullCandidate{}, "", nil
		}
	}
	stamp, cutoff := now.UnixMicro(), now.Add(-worker.WeeklyUsageFreshness).UnixMicro()
	targeted, err := pullLanes(ctx, tx, workerID, nextPullJob, 0, capability, stamp)
	if err != nil {
		return pullCandidate{}, "", err
	}
	if lane := oldestLane(targeted); lane != nil {
		timing.UsageDecision = "targeted_job"
		return lane.head, "", nil
	}
	exhausted, err := exhaustedPullTargets(ctx, tx, stamp, cutoff)
	if err != nil {
		return pullCandidate{}, "", err
	}
	shared, err := sharedPullLanes(ctx, tx, exhausted, 0, capability, stamp)
	if err != nil {
		return pullCandidate{}, "", err
	}
	if len(shared) == 0 {
		timing.UsageDecision = "no_compatible_queued_job"
		return pullCandidate{}, "", nil
	}
	peers, err := preferredPullWorkers(ctx, tx, major, percent, stamp, cutoff)
	if err != nil {
		return pullCandidate{}, "", err
	}
	maxCapability := capability
	for _, peer := range peers {
		maxCapability = max(maxCapability, peer.capability)
	}
	if capability < maxCapability {
		additional, err := sharedPullLanes(ctx, tx, exhausted, capability+1, maxCapability, stamp)
		if err != nil {
			return pullCandidate{}, "", err
		}
		shared = append(shared, additional...)
	}
	return chooseSharedPullJob(ctx, tx, shared, peers, capability, now, timing)
}

func sharedPullLanes(ctx context.Context, tx *sql.Tx, exhausted []string, minCapability, maxCapability int, stamp int64) ([]pullLane, error) {
	lanes, err := pullLanes(ctx, tx, "", nextPullJob, minCapability, maxCapability, stamp)
	if err != nil {
		return nil, err
	}
	for _, id := range exhausted {
		targeted, err := pullLanes(ctx, tx, id, nextModelPullJob, minCapability, maxCapability, stamp)
		if err != nil {
			return nil, err
		}
		lanes = append(lanes, targeted...)
	}
	return lanes, nil
}

func chooseSharedPullJob(ctx context.Context, tx *sql.Tx, lanes []pullLane, peers []preferredWorker, capability int, now time.Time, timing *inference.PullTiming) (pullCandidate, string, error) {
	for lane := oldestLane(lanes); lane != nil; lane = oldestLane(lanes) {
		job := lane.head
		until := time.UnixMicro(job.created).UTC().Add(pullPreference)
		supported := lane.capability <= capability
		if supported && (!now.Before(until) || job.deadline <= now.Add(pullPreference).UnixMicro()) {
			timing.UsageDecision = "pickup_window_or_deadline"
			return job, lane.target, nil
		}
		var preferred *preferredWorker
		for i := range peers {
			if peers[i].id != "" && peers[i].capability >= lane.capability {
				preferred = &peers[i]
				break
			}
		}
		if preferred == nil {
			if !supported {
				lane.head = pullCandidate{}
				continue
			}
			timing.UsageDecision = "no_better_compatible_slot"
			return job, lane.target, nil
		}
		if supported {
			timing.UsageDeferrals = append(timing.UsageDeferrals, inference.UsageDeferral{JobID: job.job, OperationID: job.experiment,
				PreferredWorker: preferred.id, PercentUsed: preferred.percent, ObservedAt: preferred.observed, Until: until})
		}
		// One better worker can defer one job. The next seek starts beyond that job.
		preferred.id = ""
		if err := lane.advance(ctx, tx, now.UnixMicro()); err != nil {
			return pullCandidate{}, "", err
		}
	}
	timing.UsageDecision = "waiting_for_higher_allowance"
	return pullCandidate{}, "", nil
}
