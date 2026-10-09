CREATE TABLE conference_chat_attachments (
    id TEXT PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    filename TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('image', 'document')),
    size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 104857600),
    created_at INTEGER NOT NULL
);
CREATE TABLE conference_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    body TEXT NOT NULL,
    attachment_id TEXT UNIQUE REFERENCES conference_chat_attachments(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(room_id, actor, client_id)
);
CREATE INDEX idx_conference_chat_history ON conference_chat_messages(room_id, id DESC);
CREATE TABLE conference_chat_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    client_id TEXT NOT NULL,
    message_id INTEGER REFERENCES conference_chat_messages(id) ON DELETE SET NULL,
    UNIQUE(room_id, actor, client_id)
);
CREATE TABLE conference_chat_revisions (
    room_id INTEGER PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE conference_chat_file_cleanup (
    storage_key TEXT PRIMARY KEY
);
CREATE TRIGGER conference_chat_attachment_cleanup BEFORE DELETE ON conference_chat_attachments
BEGIN
    INSERT OR IGNORE INTO conference_chat_file_cleanup(storage_key) VALUES(OLD.storage_key);
END;
CREATE TRIGGER conference_chat_message_cleanup AFTER DELETE ON conference_chat_messages
BEGIN
    DELETE FROM conference_chat_attachments WHERE id = OLD.attachment_id;
END;
