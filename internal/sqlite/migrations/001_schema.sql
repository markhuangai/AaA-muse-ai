CREATE TABLE aaa_schema_migrations (
    version INTEGER PRIMARY KEY,
    checksum TEXT NOT NULL
) STRICT;
CREATE TABLE aaa_workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    credential_hash BLOB NOT NULL UNIQUE CHECK (length(credential_hash) = 32),
    registered_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_contact_at INTEGER
) STRICT;
CREATE TABLE aaa_worker_enrollments (
    id TEXT PRIMARY KEY,
    code_hash BLOB NOT NULL UNIQUE CHECK (length(code_hash) = 32),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    worker_id TEXT UNIQUE REFERENCES aaa_workers(id),
    CHECK (expires_at > created_at),
    CHECK ((consumed_at IS NULL) = (worker_id IS NULL))
) STRICT;
CREATE TABLE aaa_worker_connections (
    worker_id TEXT PRIMARY KEY REFERENCES aaa_workers(id),
    connected INTEGER NOT NULL CHECK (connected IN (0, 1)),
    data BLOB NOT NULL
) STRICT;
CREATE TABLE aaa_worker_routing (
    worker_id TEXT PRIMARY KEY REFERENCES aaa_workers(id),
    data BLOB NOT NULL
) STRICT;
CREATE TABLE aaa_experiments (
    id TEXT PRIMARY KEY,
    worker_id TEXT REFERENCES aaa_workers(id),
    state TEXT NOT NULL,
    deadline_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    current_job_id TEXT NOT NULL,
    data BLOB NOT NULL
) STRICT;
CREATE INDEX aaa_experiments_active ON aaa_experiments(worker_id, deadline_at)
    WHERE state NOT IN ('completed', 'cancelled', 'interrupted');
CREATE INDEX aaa_unassigned_requests ON aaa_experiments(deadline_at, id)
    WHERE worker_id IS NULL AND state = 'queued';
CREATE INDEX aaa_experiments_created ON aaa_experiments(created_at, id);
CREATE INDEX aaa_experiments_conversation ON aaa_experiments(conversation_id, created_at, id);
CREATE TABLE aaa_inference_history (
    experiment_id TEXT NOT NULL REFERENCES aaa_experiments(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    data BLOB NOT NULL,
    PRIMARY KEY (experiment_id, sequence)
) STRICT;
CREATE TABLE aaa_inference_jobs (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES aaa_workers(id),
    experiment_id TEXT NOT NULL REFERENCES aaa_experiments(id),
    state TEXT NOT NULL,
    held INTEGER NOT NULL CHECK (held IN (0, 1)),
    created_at INTEGER NOT NULL,
    has_media INTEGER NOT NULL CHECK (has_media IN (0, 1)),
    media_expires_at INTEGER,
    data BLOB NOT NULL,
    context BLOB NOT NULL
) STRICT;
CREATE UNIQUE INDEX aaa_worker_single_held_turn ON aaa_inference_jobs(worker_id) WHERE held;
CREATE UNIQUE INDEX aaa_experiment_single_pending_turn ON aaa_inference_jobs(experiment_id)
    WHERE state IN ('queued', 'claimed');
CREATE INDEX aaa_worker_pending_jobs ON aaa_inference_jobs(worker_id)
    WHERE state IN ('queued', 'claimed') OR held;
CREATE INDEX aaa_experiment_jobs ON aaa_inference_jobs(experiment_id, created_at, id);
CREATE TABLE aaa_inference_receipts (
    principal TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (principal, submission_id)
) STRICT;
CREATE TABLE aaa_conversations (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    worker_id TEXT REFERENCES aaa_workers(id),
    created_at INTEGER NOT NULL,
    pending_call_id TEXT NOT NULL,
    current_request_id TEXT NOT NULL,
    data BLOB NOT NULL,
    UNIQUE (client_id, session_id)
) STRICT;
CREATE INDEX aaa_conversations_created ON aaa_conversations(created_at, id);
CREATE INDEX aaa_conversations_tool_wait ON aaa_conversations(worker_id) WHERE pending_call_id <> '';
CREATE TABLE aaa_model_requests (
    id TEXT PRIMARY KEY REFERENCES aaa_experiments(id),
    conversation_id TEXT NOT NULL REFERENCES aaa_conversations(id),
    client_id TEXT NOT NULL,
    response_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    replay_hash TEXT NOT NULL,
    incomplete_delivery INTEGER NOT NULL CHECK (incomplete_delivery IN (0, 1)),
    data BLOB NOT NULL,
    UNIQUE (conversation_id, replay_hash)
) STRICT;
CREATE INDEX aaa_model_requests_delivery ON aaa_model_requests(id) WHERE incomplete_delivery;
CREATE TABLE aaa_conversation_items (
    conversation_id TEXT NOT NULL REFERENCES aaa_conversations(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL REFERENCES aaa_model_requests(id),
    data BLOB NOT NULL,
    PRIMARY KEY (conversation_id, sequence)
) STRICT;
CREATE TABLE aaa_conversation_events (
    conversation_id TEXT NOT NULL REFERENCES aaa_conversations(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    item_id TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (conversation_id, sequence)
) STRICT;
