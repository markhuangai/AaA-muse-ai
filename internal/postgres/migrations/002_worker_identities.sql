CREATE TABLE aaa_workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    credential_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(credential_hash) = 32),
    registered_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_contact_at TIMESTAMPTZ
);

CREATE TABLE aaa_worker_enrollments (
    id TEXT PRIMARY KEY,
    code_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    worker_id TEXT UNIQUE REFERENCES aaa_workers(id),
    CHECK (expires_at > created_at),
    CHECK ((consumed_at IS NULL) = (worker_id IS NULL))
);
