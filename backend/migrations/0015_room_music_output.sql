ALTER TABLE room_settings
ADD COLUMN music_output TEXT NOT NULL DEFAULT 'studio'
CHECK (music_output IN ('studio', 'conference'));
