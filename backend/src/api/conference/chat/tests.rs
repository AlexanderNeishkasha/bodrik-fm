//! Isolated SQLite fixtures for durable chat identity, limits and cleanup.
use super::{store, types::*};
use rusqlite::{Connection, params};

/// Build a migrated synthetic room without touching application/user data.
fn fixture() -> (Connection, Identity) {
    let conn = Connection::open_in_memory().expect("memory database");
    conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE rooms(id INTEGER PRIMARY KEY); CREATE TABLE room_conferences(room_id INTEGER PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,provider_room_id TEXT,generation INTEGER,allowed INTEGER,enabled INTEGER); INSERT INTO rooms VALUES(1),(2); INSERT INTO room_conferences VALUES(1,'meeting',0,1,1),(2,'other',0,1,1);").expect("fixture");
    conn.execute_batch(include_str!(
        "../../../../migrations/0020_conference_chat.sql"
    ))
    .expect("migration");
    (
        conn,
        Identity {
            conference: "meeting".into(),
            generation: 0,
            actor: "guest:one".into(),
            presenter: false,
        },
    )
}

/// One valid text submission with independently selectable idempotency nonce.
fn input(id: &str) -> Submission {
    Submission {
        client_id: id.into(),
        name: "Alice".into(),
        avatar: String::new(),
        text: "hello".into(),
        attachment_id: None,
    }
}

/// Register synthetic attachment metadata; retention tests allocate no large files.
fn file(conn: &Connection, who: &Identity, size: u64) -> Attachment {
    let id = uuid::Uuid::new_v4().to_string();
    let file = Attachment {
        id: id.clone(),
        name: "Правила.pdf".into(),
        media_type: "application/octet-stream".into(),
        kind: "document".into(),
        size,
    };
    store::register(conn, who, &file, &format!("upload-1-{id}.bin"), 1).expect("register");
    file
}

/// Exact public history survives a new request actor; idempotent retries retain one row.
#[test]
fn durable_identity_and_retry() {
    let (mut conn, who) = fixture();
    let first = store::append(&mut conn, &who, input("nonce"), 123).expect("append");
    let again = store::append(&mut conn, &who, input("nonce"), 456).expect("retry");
    assert_eq!(
        first.message.as_ref().expect("message").id,
        again.message.expect("message").id
    );
    let other = Identity {
        actor: "guest:two".into(),
        ..who.clone()
    };
    let history = store::history(&conn, &other, None).expect("history");
    assert_eq!(history.messages.len(), 1);
    assert_eq!(history.messages[0].created_at, 123);
    assert!(!history.messages[0].own);
    assert!(!history.messages[0].can_delete);
    assert!(store::history(&conn, &who, None).expect("history").messages[0].own);
}

/// Wrong generations, foreign rooms and sender impersonation never authorize writes/deletion.
#[test]
fn authority_and_deletion_cases() {
    let (mut conn, who) = fixture();
    let record = store::append(&mut conn, &who, input("one"), 1)
        .expect("append")
        .message
        .expect("record");
    let id = record.id.parse().expect("id");
    for (name, patch) in [
        (
            "new actor",
            Identity {
                actor: "guest:two".into(),
                ..who.clone()
            },
        ),
        (
            "retired generation",
            Identity {
                generation: 1,
                ..who.clone()
            },
        ),
    ] {
        assert!(store::delete(&mut conn, &patch, id).is_err(), "{name}");
    }
    let foreign = Identity {
        conference: "other".into(),
        ..who.clone()
    };
    assert!(
        store::history(&conn, &foreign, None)
            .expect("other history")
            .messages
            .is_empty()
    );
    store::delete(
        &mut conn,
        &Identity {
            actor: "guest:two".into(),
            presenter: true,
            ..who.clone()
        },
        id,
    )
    .expect("presenter delete");
    assert!(
        store::history(&conn, &who, None)
            .expect("empty")
            .messages
            .is_empty()
    );
    assert_eq!(
        store::append(&mut conn, &who, input("one"), 2)
            .err()
            .as_deref(),
        Some("gone")
    );
}

/// Both rolling retention limits preserve newest messages and queue exact files for removal.
#[test]
fn retention_and_attachment_cases() {
    let (mut conn, who) = fixture();
    for index in 0..1001 {
        store::append(&mut conn, &who, input(&index.to_string()), index).expect("append");
    }
    let page = store::history(&conn, &who, None).expect("page");
    assert_eq!(page.messages.len(), 100);
    assert!(page.has_more);
    let before = page.messages[0].id.parse().expect("cursor");
    assert_eq!(
        store::history(&conn, &who, Some(before))
            .expect("older")
            .messages
            .len(),
        100
    );
    let count: i64 = conn
        .query_row("SELECT count(*) FROM conference_chat_messages", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert_eq!(count, 1000);
    conn.execute("DELETE FROM conference_chat_messages", [])
        .expect("clear fixture");
    for index in 0..11 {
        let attachment = file(&conn, &who, FILE_LIMIT);
        let mut draft = input(&format!("file-{index}"));
        draft.attachment_id = Some(attachment.id);
        store::append(&mut conn, &who, draft, index).expect("attachment append");
    }
    let count: i64 = conn
        .query_row("SELECT count(*) FROM conference_chat_messages", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert_eq!(count, 10);
    let jobs: i64 = conn
        .query_row(
            "SELECT count(*) FROM conference_chat_file_cleanup",
            [],
            |row| row.get(0),
        )
        .expect("jobs");
    assert_eq!(jobs, 1);
    conn.execute("DELETE FROM rooms WHERE id=1", [])
        .expect("room cascade");
    let jobs: i64 = conn
        .query_row(
            "SELECT count(*) FROM conference_chat_file_cleanup",
            [],
            |row| row.get(0),
        )
        .expect("jobs");
    assert_eq!(jobs, 11);
}

/// Attachments keep their display names but cannot be claimed by a different room or actor.
#[test]
fn attachment_claim_cases() {
    let (mut conn, who) = fixture();
    let attachment = file(&conn, &who, 12);
    let mut draft = input("file");
    draft.attachment_id = Some(attachment.id.clone());
    assert!(
        store::append(
            &mut conn,
            &Identity {
                actor: "guest:two".into(),
                ..who.clone()
            },
            draft,
            1
        )
        .is_err()
    );
    let mut draft = input("file");
    draft.attachment_id = Some(attachment.id.clone());
    store::append(&mut conn, &who, draft, 1).expect("owner claim");
    let (stored, key) = store::attachment(&conn, &who, &attachment.id).expect("download");
    assert_eq!(stored.name, "Правила.pdf");
    assert!(super::files::storage_key(&key));
    assert!(
        store::attachment(
            &conn,
            &Identity {
                conference: "other".into(),
                ..who
            },
            &attachment.id
        )
        .is_err()
    );
}

/// Invalid storage paths and mutable display data never gain filesystem authority.
#[test]
fn validation_cases() {
    for name in [
        "../secret",
        "upload-1-../x.bin",
        "upload-x-deadbeef.bin",
        "upload-1-00000000-0000-0000-0000-000000000000.html",
    ] {
        assert!(!super::files::storage_key(name), "{name}");
    }
    for (name, body, avatar) in [
        ("empty", "", ""),
        ("long", &"x".repeat(4001), ""),
        (
            "remote avatar",
            "hello",
            "https://example.invalid/avatar.png",
        ),
    ] {
        let mut draft = input("x");
        draft.text = body.into();
        draft.avatar = avatar.into();
        assert!(draft.validate().is_err(), "{name}");
    }
    let (mut conn, who) = fixture();
    conn.execute(
        "UPDATE room_conferences SET provider_room_id='rotated',generation=1 WHERE room_id=1",
        params![],
    )
    .expect("rotate");
    assert!(store::append(&mut conn, &who, input("denied"), 1).is_err());
}

/// Rotating the provider generation retains history under the stable application room.
#[test]
fn provider_rotation_preserves_history() {
    let (mut conn, mut who) = fixture();
    store::append(&mut conn, &who, input("before-rotation"), 1).expect("append");
    conn.execute(
        "UPDATE room_conferences SET provider_room_id='new-provider',generation=1 WHERE room_id=1",
        [],
    )
    .expect("rotate");
    assert!(store::history(&conn, &who, None).is_err());
    who.conference = "new-provider".into();
    who.generation = 1;
    let page = store::history(&conn, &who, None).expect("retained history");
    assert_eq!(page.messages.len(), 1);
    assert!(page.messages[0].own);
}
