ALTER TABLE rooms
ADD COLUMN mirotalk_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mirotalk_enabled IN (0, 1));

ALTER TABLE rooms
ADD COLUMN mirotalk_conference_id TEXT;

CREATE UNIQUE INDEX idx_rooms_mirotalk_conference_id
ON rooms(mirotalk_conference_id)
WHERE mirotalk_conference_id IS NOT NULL;
