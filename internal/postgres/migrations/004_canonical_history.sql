CREATE TABLE aaa_conversations (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    worker_id TEXT NOT NULL REFERENCES aaa_workers(id),
    created_at TIMESTAMPTZ NOT NULL,
    pending_call_id TEXT NOT NULL,
    data JSON NOT NULL,
    UNIQUE (client_id, session_id)
);
CREATE INDEX aaa_conversations_created ON aaa_conversations(created_at, id);
CREATE INDEX aaa_conversations_tool_wait ON aaa_conversations(worker_id) WHERE pending_call_id <> '';

CREATE TABLE aaa_model_requests (
    id TEXT PRIMARY KEY REFERENCES aaa_experiments(id),
    conversation_id TEXT NOT NULL REFERENCES aaa_conversations(id),
    client_id TEXT NOT NULL,
    response_id TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL,
    replay_hash TEXT NOT NULL,
    data JSON NOT NULL,
    UNIQUE (conversation_id, replay_hash)
);
CREATE INDEX aaa_model_requests_created ON aaa_model_requests(created_at, id);

CREATE TABLE aaa_conversation_items (
    conversation_id TEXT NOT NULL REFERENCES aaa_conversations(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL REFERENCES aaa_model_requests(id),
    data JSON NOT NULL,
    PRIMARY KEY (conversation_id, sequence)
);

CREATE TABLE aaa_conversation_events (
    conversation_id TEXT NOT NULL REFERENCES aaa_conversations(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    data JSON NOT NULL,
    PRIMARY KEY (conversation_id, sequence)
);
