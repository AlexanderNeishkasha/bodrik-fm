CREATE TABLE IF NOT EXISTS prepared_defaults (
  asset_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO prepared_defaults(asset_id)
SELECT id
FROM assets
WHERE kind = 'prepared';
