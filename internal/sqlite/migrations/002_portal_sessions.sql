CREATE TABLE aaa_portal_password (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL CHECK (generation > 0),
    salt BLOB NOT NULL CHECK (length(salt) = 16),
    verifier BLOB NOT NULL CHECK (length(verifier) = 32)
) STRICT;

CREATE TABLE aaa_portal_grants (
    digest BLOB NOT NULL PRIMARY KEY CHECK (length(digest) = 32),
    generation INTEGER NOT NULL CHECK (generation > 0),
    expires_at INTEGER
) STRICT;
