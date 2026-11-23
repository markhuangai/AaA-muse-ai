CREATE TABLE aaa_worker_updates (
    worker_id TEXT PRIMARY KEY REFERENCES aaa_workers(id),
    data BLOB NOT NULL
) STRICT;

CREATE TABLE aaa_update_brokers (
    instance_id TEXT PRIMARY KEY,
    release BLOB NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX aaa_update_brokers_expiry ON aaa_update_brokers(expires_at);
