-- Readable room slugs are now the only public conference invitation identity.
-- Keep the applied legacy column for migration history, but destroy old mappings.
UPDATE room_conferences SET external_id = NULL WHERE external_id IS NOT NULL;
