package sqlite

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"

	"database/sql"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func nullableWorker(id string) any {
	if id == "" {
		return nil
	}
	return id
}

func loadRouting(ctx context.Context, tx *sql.Tx, s *inference.State) error {
	var data []byte
	err := tx.QueryRowContext(ctx, "SELECT data FROM aaa_worker_routing WHERE worker_id=?1", s.WorkerID).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return decodeInference(data, &s.Routing)
}

func saveRouting(ctx context.Context, tx *sql.Tx, worker string, data []byte) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO aaa_worker_routing(worker_id,data) VALUES(?1,?2) ON CONFLICT(worker_id) DO UPDATE SET data=EXCLUDED.data", worker, data)
	return err
}

func loadConnection(ctx context.Context, tx *sql.Tx, s *inference.State) error {
	var data []byte
	err := tx.QueryRowContext(ctx, "SELECT data FROM aaa_worker_connections WHERE worker_id=?1", s.WorkerID).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return decodeInference(data, &s.Connection)
}

func (r *Repository) routingStates(ctx context.Context, tx *sql.Tx, ref inference.Ref) (*inference.State, error) {
	s := &inference.State{Experiments: map[string]*inference.Experiment{}, Jobs: map[string]*inference.Job{}, Pool: map[string]*inference.State{}}
	rows, err := tx.QueryContext(ctx, "SELECT id,revoked_at,last_contact_at FROM aaa_workers ORDER BY id")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		var revoked, lastContact *int64
		if err = rows.Scan(&id, &revoked, &lastContact); err != nil {
			rows.Close()
			return nil, err
		}
		s.Pool[id] = &inference.State{WorkerID: id, Revoked: revoked != nil, Now: s.Now, LastContactAt: instant(lastContact), Experiments: map[string]*inference.Experiment{}, Jobs: map[string]*inference.Job{}}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	s.Now = r.databaseTime()
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
	return r.write(ctx, func(tx *sql.Tx) error {
		if err := ownedHistory(ctx, tx, &ref); err != nil {
			return err
		}
		s, err := r.routingStates(ctx, tx, ref)
		if err != nil {
			return err
		}
		if ref.Recovery {
			if err = tx.QueryRowContext(ctx, "SELECT (SELECT count(*) FROM aaa_inference_receipts), (SELECT count(*) FROM aaa_conversations)").Scan(&s.Recovery.Receipts, &s.Recovery.Conversations); err != nil {
				return err
			}
		}
		if ref.WorkerID != "" {
			w := s.Pool[ref.WorkerID]
			if w == nil {
				return inference.Reject("worker_not_found", 404)
			}
			s.WorkerID, s.Connection, s.Revoked, s.Routing = w.WorkerID, w.Connection, w.Revoked, w.Routing
		}
		if ref.SubmissionID != "" {
			var data []byte
			err = tx.QueryRowContext(ctx, "SELECT data FROM aaa_inference_receipts WHERE principal=?1 AND submission_id=?2", ref.Principal, ref.SubmissionID).Scan(&data)
			if err == nil {
				s.Receipt = &inference.Receipt{}
				err = decodeInference(data, s.Receipt)
			}
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
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
				if _, err = tx.ExecContext(ctx, "INSERT INTO aaa_worker_connections(worker_id,connected,data) VALUES(?1,?2,?3) ON CONFLICT(worker_id) DO UPDATE SET connected=excluded.connected,data=excluded.data", id, w.Connection.Connected, data); err != nil {
					return err
				}
			}
			data, err = json.Marshal(w.Routing)
			if err != nil {
				return err
			}
			if !bytes.Equal(data, routing[id]) {
				if err = saveRouting(ctx, tx, id, data); err != nil {
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
