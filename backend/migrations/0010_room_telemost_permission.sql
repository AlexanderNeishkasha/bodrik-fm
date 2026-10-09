ALTER TABLE rooms ADD COLUMN telemost_enabled INTEGER NOT NULL DEFAULT 0 CHECK (telemost_enabled IN (0, 1));
