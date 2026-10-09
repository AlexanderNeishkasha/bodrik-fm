CREATE TABLE room_telemost_settings (
    room_id INTEGER PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    meeting_url TEXT NOT NULL DEFAULT ''
);
