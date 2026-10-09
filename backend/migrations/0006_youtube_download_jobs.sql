CREATE TABLE IF NOT EXISTS youtube_download_jobs (
  id TEXT PRIMARY KEY,
  room_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  video_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'downloading', 'processing', 'ready', 'error')),
  stage TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  storage_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_youtube_download_jobs_room_status
ON youtube_download_jobs(room_id, status, created_at);
