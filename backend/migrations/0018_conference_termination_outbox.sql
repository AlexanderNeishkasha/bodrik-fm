-- Retain retired provider IDs across failed termination, process exit and account deletion.
CREATE TABLE conference_termination_outbox (
    provider TEXT NOT NULL,
    provider_room_id TEXT NOT NULL,
    room_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(provider, provider_room_id)
);
CREATE INDEX idx_conference_termination_room ON conference_termination_outbox(room_id);
