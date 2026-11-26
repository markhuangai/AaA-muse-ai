package sqlite

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const updateBrokerWindow = 30 * time.Second

func recordUpdateBroker(ctx context.Context, tx *sql.Tx, now time.Time, broker worker.UpdateBroker) error {
	raw, err := json.Marshal(broker.Target)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO aaa_update_brokers(instance_id,release,expires_at) VALUES(?1,?2,?3)
		ON CONFLICT(instance_id) DO UPDATE SET release=excluded.release,expires_at=excluded.expires_at`,
		broker.ID, raw, now.Add(updateBrokerWindow).UnixMicro())
	return err
}

func (r *Repository) RenewUpdateBroker(ctx context.Context, broker worker.UpdateBroker) error {
	return r.write(ctx, func(tx *sql.Tx) error {
		now := r.databaseTime()
		if _, err := tx.ExecContext(ctx, "DELETE FROM aaa_update_brokers WHERE expires_at<=?1", now.UnixMicro()); err != nil {
			return err
		}
		return recordUpdateBroker(ctx, tx, now, broker)
	})
}

func agreedTarget(ctx context.Context, tx *sql.Tx, now time.Time, broker worker.UpdateBroker) (*worker.UpdateTarget, string, error) {
	if broker.ID == "" {
		return nil, "", nil
	}
	expected, err := json.Marshal(broker.Target)
	if err != nil {
		return nil, "", err
	}
	rows, err := tx.QueryContext(ctx, "SELECT instance_id,release,expires_at FROM aaa_update_brokers WHERE expires_at>?1 ORDER BY instance_id", now.UnixMicro())
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	reason := ""
	seen, refresh := false, broker.ForceRecord
	for rows.Next() {
		var sibling string
		var raw []byte
		var expires int64
		if err := rows.Scan(&sibling, &raw, &expires); err != nil {
			return nil, "", err
		}
		if sibling == broker.ID {
			seen = true
			refresh = refresh || !bytes.Equal(raw, expected) || expires <= now.Add(updateBrokerWindow/2).UnixMicro()
			continue
		}
		if !bytes.Equal(raw, expected) {
			if reason == "" {
				reason = "mixed_broker_releases"
			}
			var peer *worker.UpdateTarget
			if err := json.Unmarshal(raw, &peer); err != nil {
				return nil, "", err
			}
			if peer != nil && broker.Target != nil && peer.Version == broker.Target.Version && peer.SHA256 != broker.Target.SHA256 {
				reason = "release_digest_conflict"
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if refresh || !seen {
		if err := recordUpdateBroker(ctx, tx, now, broker); err != nil {
			return nil, "", err
		}
	}
	if reason != "" {
		return nil, reason, nil
	}
	return broker.Target, "", nil
}

func readWorkerUpdate(ctx context.Context, tx *sql.Tx, id string) (state worker.UpdateStatus, err error) {
	var data, poll []byte
	err = tx.QueryRowContext(ctx, `SELECT u.data,p.result FROM aaa_worker_updates u
		LEFT JOIN aaa_worker_polls p ON p.worker_id=u.worker_id WHERE u.worker_id=?1`, id).Scan(&data, &poll)
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	if err == nil {
		var observations pollObservations
		if observations, err = readPollObservations(poll); err == nil {
			state, err = decodeWorkerUpdate(data, observations.Update)
		}
	}
	return
}

func decodeWorkerUpdate(data []byte, poll updateObservation) (state worker.UpdateStatus, err error) {
	if err = json.Unmarshal(data, &state); err != nil {
		return
	}
	state.Observe(state.Contact, poll.Scheduled, poll.Observed)
	return
}

func saveWorkerUpdate(ctx context.Context, tx *sql.Tx, id string, state worker.UpdateStatus) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO aaa_worker_updates(worker_id,data) VALUES(?1,?2)
		ON CONFLICT(worker_id) DO UPDATE SET data=excluded.data`, id, data)
	return err
}

func observeLegacyWorker(ctx context.Context, tx *sql.Tx, now time.Time, id string, pull inference.Pull, contact worker.Contact) (worker.UpdateStatus, error) {
	state, err := readWorkerUpdate(ctx, tx, id)
	if err != nil || state.Contract == worker.UpdateContract || contact.Contract == worker.UpdateContract {
		return worker.UpdateStatus{}, err
	}
	alreadyMarked := state.State == "migration_required"
	previous := state
	state.Observe(contact, pull.ScheduledAt, now)
	if alreadyMarked && state.Contact == previous.Contact && !state.ScheduledAt.After(previous.ScheduledAt) {
		return worker.UpdateStatus{}, nil
	}
	state.State, state.Reason = "migration_required", "unsupported_worker_migration"
	if err = saveWorkerUpdate(ctx, tx, id, state); err != nil {
		return worker.UpdateStatus{}, err
	}
	if alreadyMarked {
		return worker.UpdateStatus{}, nil
	}
	return state, nil
}

func sameUpdateTime(first, second *time.Time) bool {
	if first == nil || second == nil {
		return first == second
	}
	return first.Equal(*second)
}

func updateMateriallyEqual(first, second worker.UpdateStatus) bool {
	if first.Contact != second.Contact || first.From != second.From || first.ID != second.ID || first.State != second.State ||
		first.Reason != second.Reason || first.Attempt != second.Attempt || !sameUpdateTime(first.RetryAt, second.RetryAt) ||
		!sameUpdateTime(first.StartedAt, second.StartedAt) {
		return false
	}
	if first.Target == nil || second.Target == nil {
		return first.Target == second.Target
	}
	return *first.Target == *second.Target
}

func decideUpdate(ctx context.Context, tx *sql.Tx, now time.Time, id string, pull inference.Pull, contact worker.Contact, broker worker.UpdateBroker, held bool, timing *inference.PullTiming) (*worker.UpdateOffer, worker.UpdateStatus, bool, error) {
	state, err := readWorkerUpdate(ctx, tx, id)
	if err != nil {
		return nil, state, false, err
	}
	previous := state
	fresh := pull.ScheduledAt.After(state.ScheduledAt)
	state.Observe(contact, pull.ScheduledAt, now)
	var offer *worker.UpdateOffer
	work := !contact.Incompatible && !held
	switch {
	case state.Active():
		work = false
		if !contact.Incompatible && !held && state.State == "awaiting_confirmation" && state.Target != nil && contact.Version == state.Target.Version &&
			contact.Digest == state.Target.SHA256 && contact.Contract == state.Target.Contract && fresh {
			state.State, state.Reason = "confirmed", ""
			work = true
		}
	case !held && contact.Version != "":
		target, reason, err := agreedTarget(ctx, tx, now, broker)
		if err != nil {
			return nil, state, false, err
		}
		timing.UpdateBrokerRecorded = timing.UpdateBrokerRecorded || (broker.ForceRecord && broker.ID != "")
		switch {
		case reason != "":
			state.Target, state.State, state.Reason = broker.Target, "deferred", reason
			state.ID, state.Attempt, state.RetryAt = "", 0, nil
		case target == nil:
			if state.State != "" && !state.Active() {
				state.Target, state.State, state.Reason, state.ID, state.RetryAt = nil, "", "", "", nil
			}
		case contact.Version == target.Version && contact.Digest != "" && contact.Digest != target.SHA256:
			state.Target, state.State, state.Reason = target, "deferred", "release_digest_conflict"
			state.ID, state.Attempt, state.RetryAt = "", 0, nil
		case contact.Version == target.Version:
			state.Target = target
			if state.State != "confirmed" {
				state.State, state.Reason, state.ID, state.Attempt, state.RetryAt = "", "", "", 0, nil
			}
		case contact.Contract != target.Contract:
			state.Target, state.State, state.Reason = target, "migration_required", "unsupported_worker_migration"
			state.ID, state.Attempt, state.RetryAt = "", 0, nil
		case !target.Advances(contact):
			state.Target, state.State, state.Reason = target, "deferred", "update_requires_newer_pair"
			state.ID, state.Attempt, state.RetryAt = "", 0, nil
		case state.State == "failed" && state.Target != nil && *state.Target == *target &&
			(state.RetryAt == nil || now.Before(*state.RetryAt)):
		default:
			if state.Target == nil || *state.Target != *target || state.From != state.Contact {
				state.Attempt, state.StartedAt = 0, nil
			}
			state.Target, state.ID, state.State, state.Reason, state.RetryAt = target, pull.Occurrence, "offered", "", nil
			state.From = state.Contact
			offer = &worker.UpdateOffer{ID: state.ID, Target: *target}
			work = false
		}
	}
	timing.UpdateStateChanged = state.State != previous.State
	if (previous.ObservedAt == nil && state.ObservedAt != nil) || !updateMateriallyEqual(state, previous) || state.State == "awaiting_confirmation" {
		err = saveWorkerUpdate(ctx, tx, id, state)
	}
	return offer, state, work, err
}

func (r *Repository) ApplyWorkerUpdate(ctx context.Context, credential [32]byte, contact worker.Contact, broker worker.UpdateBroker, input worker.UpdateRequest) (state worker.UpdateStatus, id string, replayed bool, err error) {
	err = r.write(ctx, func(tx *sql.Tx) error {
		now := r.databaseTime()
		id, err = nativeWorker(ctx, tx, credential)
		if err != nil {
			return err
		}
		state, err = readWorkerUpdate(ctx, tx, id)
		if err != nil {
			return err
		}
		matches := state.ID == input.ID && state.Target != nil && *state.Target == input.Target
		reportingPrevious := contact.Version == state.From.Version && contact.Contract == state.From.Contract &&
			state.From.Digest == contact.Digest
		reportingTarget := contact.Version == input.Target.Version && contact.Digest == input.Target.SHA256 &&
			contact.Contract == input.Target.Contract
		switch input.Action {
		case "begin", "activate":
			target, reason, err := agreedTarget(ctx, tx, now, broker)
			if err != nil {
				return err
			}
			if target == nil || *target != input.Target {
				if reason == "" {
					reason = "update_target_changed"
				}
				return inference.Reject(reason, 409)
			}
			if !target.Advances(contact) {
				return inference.Reject("update_requires_newer_pair", 409)
			}
			var held bool
			if err := tx.QueryRowContext(ctx, heldPullJob, id).Scan(&held); err != nil {
				return err
			}
			if held {
				return inference.Reject("worker_has_held_work", 409)
			}
			if matches && reportingPrevious && (state.State == "confirmed" || state.State == "awaiting_confirmation" ||
				((state.State == "downloading" || state.State == "switching") && input.Action != "activate")) {
				replayed = true
				return nil
			}
			switch input.Action {
			case "begin":
				if !matches || state.State != "offered" || !reportingPrevious || contact.Contract != target.Contract {
					return inference.Reject("update_offer_stale", 409)
				}
			case "activate":
				if !matches || (state.State != "downloading" && state.State != "switching") || !reportingPrevious {
					return inference.Reject("update_attempt_stale", 409)
				}
				if state.State == "switching" {
					replayed = true
					return nil
				}
				state.State = "switching"
				return saveWorkerUpdate(ctx, tx, id, state)
			}
			state.State, state.Reason, state.StartedAt = "downloading", "", &now
			state.Attempt++
		case "applied":
			if broker.Target == nil || *broker.Target != input.Target {
				return inference.Reject("update_target_changed", 409)
			}
			if !matches || !reportingTarget || (state.State != "switching" && state.State != "awaiting_confirmation" && state.State != "confirmed") {
				return inference.Reject("update_attempt_stale", 409)
			}
			if state.State != "switching" {
				replayed = true
				return nil
			}
			state.State = "awaiting_confirmation"
		case "failed":
			if !matches || !reportingPrevious || (!state.Active() && (state.State != "failed" || input.Reason != state.Reason)) {
				return inference.Reject("update_attempt_stale", 409)
			}
			if state.State == "failed" {
				replayed = true
				return nil
			}
			state.Fail(input.Reason, now)
			retry, err := retryUpdateOp(ctx, tx, id, "running", input.ID, now)
			if err != nil {
				return err
			}
			if retry != nil {
				if err := finishRetryUpdate(ctx, tx, retry, "failed", input.Reason, nil, now); err != nil {
					return err
				}
				state.ControlOp = &retry.ControlItem
			}
		default:
			return inference.Reject("invalid_worker_update", 400)
		}
		if (input.Action == "applied" || input.Action == "failed") && broker.ForceRecord && broker.ID != "" {
			if err := recordUpdateBroker(ctx, tx, now, broker); err != nil {
				return err
			}
		}
		return saveWorkerUpdate(ctx, tx, id, state)
	})
	return
}

func decideControlUpdate(ctx context.Context, tx *sql.Tx, now time.Time, owner string, pull inference.Pull, contact worker.Contact,
	broker worker.UpdateBroker, held bool, timing *inference.PullTiming,
) (*worker.UpdateOffer, bool, error) {
	retry, err := retryUpdateOp(ctx, tx, owner, "queued", "", now)
	if err != nil {
		return nil, false, err
	}
	if retry != nil && contact.Incompatible && !held {
		offer, err := forceRetryUpdate(ctx, tx, now, owner, pull, contact, broker, retry, timing)
		if err != nil || offer != nil {
			return offer, false, err
		}
		if timing.UpdateBrokerRecorded {
			broker.ForceRecord = false
		}
	}
	offer, status, work, err := decideUpdate(ctx, tx, now, owner, pull, contact, broker, held, timing)
	timing.Update = status
	if err != nil || contact.Incompatible {
		return offer, work, err
	}
	if status.State == "confirmed" && status.ID != "" {
		running, err := retryUpdateOp(ctx, tx, owner, "running", status.ID, now)
		if err != nil {
			return nil, false, err
		}
		if running != nil {
			if err := finishRetryUpdate(ctx, tx, running, "succeeded", "", nil, now); err != nil {
				return nil, false, err
			}
			timing.ConfirmedUpdateOp = &running.ControlItem
		}
	}
	if retry != nil {
		if err := finishRetryUpdate(ctx, tx, retry, "succeeded", "", json.RawMessage(`{"already_current":true}`), now); err != nil {
			return nil, false, err
		}
		timing.UpdateOp = &retry.ControlItem
	}
	return offer, work, nil
}

func forceRetryUpdate(ctx context.Context, tx *sql.Tx, now time.Time, owner string, pull inference.Pull, contact worker.Contact,
	broker worker.UpdateBroker, retry *worker.ControlRecord, timing *inference.PullTiming,
) (*worker.UpdateOffer, error) {
	target, _, err := agreedTarget(ctx, tx, now, broker)
	if err == nil && broker.ForceRecord && broker.ID != "" {
		timing.UpdateBrokerRecorded = true
	}
	if err != nil || target == nil {
		return nil, err
	}
	if !target.Advances(contact) {
		reason := "update_requires_newer_pair"
		if contact.Contract != target.Contract {
			reason = "unsupported_worker_migration"
		}
		if err := finishRetryUpdate(ctx, tx, retry, "failed", reason, nil, now); err != nil {
			return nil, err
		}
		timing.UpdateOp = &retry.ControlItem
		return nil, nil
	}
	state, err := readWorkerUpdate(ctx, tx, owner)
	if err != nil {
		return nil, err
	}
	timing.PreviousUpdateState = state.State
	state.Observe(contact, pull.ScheduledAt, now)
	if state.Target == nil || *state.Target != *target || state.From != state.Contact {
		state.Attempt = 0
	}
	state.Target, state.ID, state.State, state.Reason = target, pull.Occurrence, "offered", ""
	state.RetryAt, state.StartedAt, state.From = nil, nil, state.Contact
	retry.State, retry.StartedAt, retry.UpdateID, retry.RemoteOutcome = "running", &now, state.ID, "unknown"
	if err := saveControl(ctx, tx, worker.WorkerOp, *retry); err != nil {
		return nil, err
	}
	if err := saveWorkerUpdate(ctx, tx, owner, state); err != nil {
		return nil, err
	}
	timing.UpdateOp, timing.Update = &retry.ControlItem, state
	timing.UpdateStateChanged = true
	return &worker.UpdateOffer{ID: state.ID, Target: *target}, nil
}
