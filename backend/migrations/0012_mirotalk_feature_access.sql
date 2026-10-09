ALTER TABLE rooms
ADD COLUMN mirotalk_allowed INTEGER NOT NULL DEFAULT 0 CHECK (mirotalk_allowed IN (0, 1));
