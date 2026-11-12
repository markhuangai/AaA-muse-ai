ALTER TABLE aaa_experiments ALTER COLUMN worker_id DROP NOT NULL;
ALTER TABLE aaa_conversations ALTER COLUMN worker_id DROP NOT NULL;
CREATE TABLE aaa_worker_routing (
    worker_id TEXT PRIMARY KEY REFERENCES aaa_workers(id),
    data JSON NOT NULL
);
CREATE INDEX aaa_unassigned_requests ON aaa_experiments(deadline_at, id)
    WHERE worker_id IS NULL AND state = 'queued';
