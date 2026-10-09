DELETE FROM prepared_defaults
WHERE asset_id NOT IN (
  SELECT id
  FROM assets
  WHERE kind = 'prepared'
    AND lower(trim(original_name)) IN (
      'Ночная тема.mp3',
      'Ночная тема.flac',
      'Ночная тема.m4a',
      'Ночная тема.wav',
      'Ночная тема.ogg',
      'Ночная тема.opus',
      'Ночная тема.aac',
      'Ночная тема.mp4',
      'Ночная тема.webm'
    )
);

INSERT OR IGNORE INTO prepared_defaults(asset_id)
SELECT id
FROM assets
WHERE kind = 'prepared'
  AND lower(trim(original_name)) IN (
    'Ночная тема.mp3',
    'Ночная тема.flac',
    'Ночная тема.m4a',
    'Ночная тема.wav',
    'Ночная тема.ogg',
    'Ночная тема.opus',
    'Ночная тема.aac',
    'Ночная тема.mp4',
    'Ночная тема.webm'
  );
