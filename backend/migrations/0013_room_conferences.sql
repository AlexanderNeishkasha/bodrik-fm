CREATE TABLE room_conferences (
    room_id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    allowed INTEGER NOT NULL DEFAULT 0 CHECK (allowed IN (0, 1)),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    external_id TEXT UNIQUE,
    generation INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

INSERT INTO room_conferences(room_id, provider, allowed, enabled, external_id)
SELECT id, 'mirotalk', mirotalk_allowed, mirotalk_enabled, mirotalk_conference_id
FROM rooms;
