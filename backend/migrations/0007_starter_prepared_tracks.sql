UPDATE assets
SET kind = 'prepared',
    owner_room_id = NULL,
    original_name = CASE storage_key
      WHEN '58ca4614-3656-4d96-a113-f2f3ef0b904c.wav' THEN 'Silent Land Waltz.wav'
      WHEN 'cc40c724-e537-4a71-b12a-9aa6128d9b1a.wav' THEN 'Silent Land Waltz.wav'
      WHEN 'afdb12fb-83d7-46a7-a07c-fe6a3f6ccb66.wav' THEN 'The Forest Whispers.wav'
      WHEN 'a5e64412-aab5-4aa0-b4ff-f9eb471ded2f.wav' THEN 'The Forest Whispers.wav'
      WHEN 'bf414e88-a71a-4e86-baba-f2b2caa2e6a9.wav' THEN 'Winter Caprice.wav'
      WHEN 'f72f7a13-7b08-4773-a286-9e5bbedd7d11.wav' THEN 'Winter Caprice.wav'
      ELSE original_name
    END
WHERE lower(trim(original_name)) IN (
    lower('Silent Land Waltz.wav'),
    lower('The Forest Whispers.wav'),
    lower('Winter Caprice.wav')
  )
  OR lower(trim(original_name)) IN (
    lower('Silent Land Waltz'),
    lower('The Forest Whispers'),
    lower('Winter Caprice')
  );

DELETE FROM prepared_defaults;

INSERT OR IGNORE INTO prepared_defaults(asset_id)
SELECT id
FROM assets
WHERE kind = 'prepared'
  AND lower(trim(original_name)) IN (
    lower('Silent Land Waltz.wav'),
    lower('The Forest Whispers.wav'),
    lower('Winter Caprice.wav')
  );
