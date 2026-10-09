ALTER TABLE room_conferences
ADD COLUMN provider_room_id TEXT;

UPDATE room_conferences
SET provider_room_id = external_id
WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX idx_room_conferences_provider_room_id
ON room_conferences(provider, provider_room_id)
WHERE provider_room_id IS NOT NULL;
