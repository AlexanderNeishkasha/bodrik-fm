-- Browsers remembered as meeting hosts per room, keyed by the guest device actor
-- (an HMAC of the browser's device cookie, never the cookie itself).
CREATE TABLE conference_hosts (
    room_id INTEGER NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(room_id, actor),
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

-- Single-use host passes minted by the Studio "join" button; only the token's
-- SHA-256 is stored, and each expires within minutes.
CREATE TABLE conference_host_grants (
    token_hash TEXT PRIMARY KEY,
    room_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX idx_conference_host_grants_expiry ON conference_host_grants(expires_at);
