CREATE TABLE aaa_worker_connections (
    worker_id TEXT PRIMARY KEY REFERENCES aaa_workers(id),
    data JSONB NOT NULL
);

CREATE TABLE aaa_experiments (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES aaa_workers(id),
    state TEXT NOT NULL,
    deadline_at TIMESTAMPTZ NOT NULL,
    data JSON NOT NULL
);
CREATE INDEX aaa_experiments_active ON aaa_experiments(worker_id, deadline_at)
    WHERE state NOT IN ('completed', 'cancelled', 'interrupted');

CREATE TABLE aaa_inference_history (
    experiment_id TEXT NOT NULL REFERENCES aaa_experiments(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    data JSON NOT NULL,
    PRIMARY KEY (experiment_id, sequence)
);

CREATE TABLE aaa_inference_jobs (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES aaa_workers(id),
    experiment_id TEXT NOT NULL REFERENCES aaa_experiments(id),
    state TEXT NOT NULL,
    held BOOLEAN NOT NULL,
    data JSON NOT NULL,
    context JSON NOT NULL
);
CREATE UNIQUE INDEX aaa_worker_single_held_turn ON aaa_inference_jobs(worker_id) WHERE held;
CREATE UNIQUE INDEX aaa_experiment_single_pending_turn ON aaa_inference_jobs(experiment_id)
    WHERE state IN ('queued', 'claimed');
CREATE INDEX aaa_worker_pending_jobs ON aaa_inference_jobs(worker_id)
    WHERE state IN ('queued', 'claimed') OR held;

CREATE TABLE aaa_inference_receipts (
    principal TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    data JSON NOT NULL,
    PRIMARY KEY (principal, submission_id)
);
