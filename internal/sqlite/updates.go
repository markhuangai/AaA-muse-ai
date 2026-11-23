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
	// Rejoin in the deciding transaction if this instance missed a renewal.
	if err := recordUpdateBroker(ctx, tx, now, broker); err != nil {
		return nil, "", err
	}
	rows, err := tx.QueryContext(ctx, "SELECT instance_id,release FROM aaa_update_brokers WHERE expires_at>?1 ORDER BY instance_id", now.UnixMicro())
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	expected, err := json.Marshal(broker.Target)
	if err != nil {
		return nil, "", err
	}
	reason := ""
	for rows.Next() {
		var sibling string
		var raw []byte
		if err := rows.Scan(&sibling, &raw); err != nil {
			return nil, "", err
		}
		if !bytes.Equal(raw, expected) {
			reason = "mixed_broker_releases"
			var peer *worker.UpdateTarget
			if err := json.Unmarshal(raw, &peer); err != nil {
				return nil, "", err
			}
			if peer != nil && broker.Target != nil && peer.Version == broker.Target.Version && peer.SHA256 != broker.Target.SHA256 {
				return nil, "release_digest_conflict", nil
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if reason != "" {
		return nil, reason, nil
	}
	return broker.Target, "", nil
}

func readWorkerUpdate(ctx context.Context, tx *sql.Tx, id string) (state worker.UpdateStatus, err error) {
	var data []byte
	err = tx.QueryRowContext(ctx, "SELECT data FROM aaa_worker_updates WHERE worker_id=?1", id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	if err == nil {
		err = json.Unmarshal(data, &state)
	}
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

func decideUpdate(ctx context.Context, tx *sql.Tx, now time.Time, id string, pull inference.Pull, contact worker.Contact, broker worker.UpdateBroker, held bool) (*worker.UpdateOffer, worker.UpdateStatus, bool, error) {
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
		if state.State == "awaiting_confirmation" && contact.Version == state.Target.Version &&
			contact.Digest == state.Target.SHA256 && contact.Contract == state.Target.Contract && fresh {
			state.State, state.Reason = "confirmed", ""
			work = !contact.Incompatible && !held
		}
	case !held && contact.Version != "":
		target, reason, err := agreedTarget(ctx, tx, now, broker)
		if err != nil {
			return nil, state, false, err
		}
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
		case contact.Contract == "" && !contact.Incompatible:
			state.Target, state.State, state.Reason = target, "adoption_required", ""
			state.ID, state.Attempt, state.RetryAt = "", 0, nil
		case !target.Supports(contact.Version, contact.Contract):
			state.Target, state.State, state.Reason = target, "migration_required", "unsupported_worker_migration"
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
	if state != previous {
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
		if input.Action == "adopt" && input.WorkerID != id {
			return inference.Reject("worker_scope_denied", 404)
		}
		matches := state.ID == input.ID && state.Target != nil && *state.Target == input.Target
		reportingPrevious := contact.Version == state.From.Version &&
			(state.From.Digest == "" || state.From.Digest == contact.Digest)
		reportingTarget := contact.Version == input.Target.Version && contact.Digest == input.Target.SHA256 &&
			contact.Contract == input.Target.Contract
		switch input.Action {
		case "adopt", "begin", "activate":
			if matches && (state.State == "confirmed" || state.State == "awaiting_confirmation" ||
				((state.State == "downloading" || state.State == "switching") && input.Action != "activate")) {
				replayed = true
				return nil
			}
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
			var held bool
			if err := tx.QueryRowContext(ctx, heldPullJob, id).Scan(&held); err != nil {
				return err
			}
			if held {
				return inference.Reject("worker_has_held_work", 409)
			}
			switch input.Action {
			case "adopt":
				if !reportingTarget || state.Active() || state.Contract != "" ||
					(state.Version != "" && state.Version != input.PreviousVersion) ||
					!target.Supports(input.PreviousVersion, contact.Contract) {
					return inference.Reject("update_adoption_conflict", 409)
				}
				state.Target, state.ID = target, input.ID
				state.From = worker.Contact{Version: input.PreviousVersion}
			case "begin":
				if !matches || state.State != "offered" || !reportingPrevious || contact.Contract != target.Contract {
					return inference.Reject("update_offer_stale", 409)
				}
			case "activate":
				if !matches || (state.State != "downloading" && state.State != "switching") ||
					(!reportingPrevious && !(state.From.Contract == "" && reportingTarget)) {
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
			if !matches || !reportingTarget || (state.State != "switching" && state.State != "awaiting_confirmation" && state.State != "confirmed") {
				return inference.Reject("update_attempt_stale", 409)
			}
			if state.State != "switching" {
				replayed = true
				return nil
			}
			state.State = "awaiting_confirmation"
		case "failed":
			if !matches || (!reportingPrevious && !(state.From.Contract == "" && reportingTarget)) || (!state.Active() && (state.State != "failed" || input.Reason != state.Reason)) {
				return inference.Reject("update_attempt_stale", 409)
			}
			if state.State == "failed" {
				replayed = true
				return nil
			}
			state.Fail(input.Reason, now)
		}
		return saveWorkerUpdate(ctx, tx, id, state)
	})
	return
}
