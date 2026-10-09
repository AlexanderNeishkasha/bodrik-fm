DELETE FROM prepared_defaults
WHERE asset_id IN (
  SELECT id
  FROM assets
  WHERE kind = 'prepared'
    AND (
      original_name IN ('Бой - Сабаттон.mp4', 'Главная тема.mp3')
      OR lower(trim(original_name)) IN (
        lower('Бой - Сабаттон.mp4'),
        lower('Главная тема.mp3')
      )
    )
);
