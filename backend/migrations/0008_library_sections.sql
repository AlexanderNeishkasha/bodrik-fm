CREATE TABLE IF NOT EXISTS library_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_library_sections_name_unique
ON library_sections(room_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_library_sections_room_order
ON library_sections(room_id, sort_order, id);

ALTER TABLE room_tracks
ADD COLUMN section_id INTEGER REFERENCES library_sections(id) ON DELETE SET NULL;

ALTER TABLE room_tracks
ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

WITH ordered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY room_id
      ORDER BY lower(title), id
    ) - 1 AS next_order
  FROM room_tracks
)
UPDATE room_tracks
SET sort_order = (
  SELECT next_order
  FROM ordered
  WHERE ordered.id = room_tracks.id
);

CREATE INDEX IF NOT EXISTS idx_room_tracks_section_order
ON room_tracks(room_id, section_id, sort_order, id);
