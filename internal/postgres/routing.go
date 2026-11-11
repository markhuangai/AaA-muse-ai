package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func nullableWorker(id string) any {
	if id == "" {
		return nil
	}
	return id
}

func loadRouting(ctx context.Context, tx pgx.Tx, s *inference.State) error {
	var data []byte
	err := tx.QueryRow(ctx, "SELECT data FROM aaa_worker_routing WHERE worker_id=$1", s.WorkerID).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return decodeInference(data, &s.Routing)
}

func loadConnection(ctx context.Context, tx pgx.Tx, s *inference.State) error {
	var data []byte
	err := tx.QueryRow(ctx, "SELECT data FROM aaa_worker_connections WHERE worker_id=$1", s.WorkerID).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return decodeInference(data, &s.Connection)
}

func routingStates(ctx context.Context, tx pgx.Tx, ref inference.Ref) (*inference.State, error) {
	s := &inference.State{Experiments: map[string]*inference.Experiment{}, Jobs: map[string]*inference.Job{}, Pool: map[string]*inference.State{}}
	rows, err := tx.Query(ctx, "SELECT id,revoked_at FROM aaa_workers ORDER BY id FOR UPDATE")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		var revoked *time.Time
		if err = rows.Scan(&id, &revoked); err != nil {
			rows.Close()
			return nil, err
		}
		s.Pool[id] = &inference.State{WorkerID: id, Revoked: revoked != nil, Now: s.Now, Experiments: map[string]*inference.Experiment{}, Jobs: map[string]*inference.Job{}}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&s.Now); err != nil {
		return nil, err
	}
	for _, w := range s.Pool {
		w.Now = s.Now
	}
	ids := make([]string, 0, len(s.Pool))
	for id := range s.Pool {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if err = loadInference(ctx, tx, ref, s); err != nil {
		return nil, err
	}
	for _, id := range ids {
		w := s.Pool[id]
		if err = loadConnection(ctx, tx, w); err != nil {
			return nil, err
		}
		if err = loadRouting(ctx, tx, w); err != nil {
			return nil, err
		}
		if err = loadInference(ctx, tx, ref, w); err != nil {
			return nil, err
		}
		for key, e := range w.Experiments {
			s.Experiments[key] = e
		}
		for key, j := range w.Jobs {
			s.Jobs[key] = j
		}
	}
	if err = loadHistory(ctx, tx, ref, s); err != nil {
		return nil, err
	}
	for _, w := range s.Pool {
		w.Requests, w.Conversations = s.Requests, s.Conversations
	}
	return s, nil
}

func (r *Repository) withinRouting(ctx context.Context, ref inference.Ref, apply func(*inference.State) error) error {
	return r.workerTransaction(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", inferenceAdmissionLock); err != nil {
			return err
		}
		if ref.SubmissionID != "" {
			if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ref.Principal+":"+ref.SubmissionID); err != nil {
				return err
			}
		}
		if err := ownedHistory(ctx, tx, &ref); err != nil {
			return err
		}
		s, err := routingStates(ctx, tx, ref)
		if err != nil {
			return err
		}
		if ref.WorkerID != "" {
			w := s.Pool[ref.WorkerID]
			if w == nil {
				return inference.Reject("worker_not_found", 404)
			}
			s.WorkerID, s.Connection, s.Revoked, s.Routing = w.WorkerID, w.Connection, w.Revoked, w.Routing
		}
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM aaa_experiments WHERE state NOT IN ('completed','cancelled','interrupted')").Scan(&s.ActiveCount); err != nil {
			return err
		}
		if ref.SubmissionID != "" {
			var data []byte
			err = tx.QueryRow(ctx, "SELECT data FROM aaa_inference_receipts WHERE principal=$1 AND submission_id=$2", ref.Principal, ref.SubmissionID).Scan(&data)
			if err == nil {
				s.Receipt = &inference.Receipt{}
				err = decodeInference(data, s.Receipt)
			}
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		before, err := inferenceSnapshot(s)
		if err != nil {
			return err
		}
		history, err := historySnapshot(s)
		if err != nil {
			return err
		}
		connections, routing := map[string][]byte{}, map[string][]byte{}
		for id, w := range s.Pool {
			connections[id], err = json.Marshal(w.Connection)
			if err != nil {
				return err
			}
			routing[id], err = json.Marshal(w.Routing)
			if err != nil {
				return err
			}
		}
		if err = apply(s); err != nil {
			return err
		}
		for id, w := range s.Pool {
			data, err := json.Marshal(w.Connection)
			if err != nil {
				return err
			}
			if !bytes.Equal(data, connections[id]) {
				if _, err = tx.Exec(ctx, "INSERT INTO aaa_worker_connections(worker_id,data) VALUES($1,$2) ON CONFLICT(worker_id) DO UPDATE SET data=EXCLUDED.data", id, data); err != nil {
					return err
				}
			}
			data, err = json.Marshal(w.Routing)
			if err != nil {
				return err
			}
			if !bytes.Equal(data, routing[id]) {
				if _, err = tx.Exec(ctx, "INSERT INTO aaa_worker_routing(worker_id,data) VALUES($1,$2) ON CONFLICT(worker_id) DO UPDATE SET data=EXCLUDED.data", id, data); err != nil {
					return err
				}
			}
		}
		if err = saveInference(ctx, tx, ref, s, before); err != nil {
			return err
		}
		return saveHistory(ctx, tx, s, history)
	})
}
