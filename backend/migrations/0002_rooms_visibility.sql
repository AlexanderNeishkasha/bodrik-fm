ALTER TABLE rooms
ADD COLUMN is_listed INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_rooms_is_listed ON rooms(is_listed);
