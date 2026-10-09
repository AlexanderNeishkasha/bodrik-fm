ALTER TABLE room_settings
ADD COLUMN conference_music_volume REAL NOT NULL DEFAULT 1.0
CHECK (conference_music_volume >= 0.0 AND conference_music_volume <= 1.0);
