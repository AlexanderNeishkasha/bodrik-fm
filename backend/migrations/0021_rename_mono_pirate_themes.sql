-- Align theme ids with their Studio labels: the grey theme "mono" becomes "pirate"
-- and the black theme "pirate" becomes "noir". One statement swaps both values.
-- The column default from 0001 stays 'mono'; room creation always writes the theme
-- explicitly, so the default is never used.
UPDATE room_settings
SET theme = CASE theme WHEN 'pirate' THEN 'noir' WHEN 'mono' THEN 'pirate' END
WHERE theme IN ('mono', 'pirate');
