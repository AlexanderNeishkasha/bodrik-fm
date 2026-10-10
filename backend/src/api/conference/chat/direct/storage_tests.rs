//! Direct host storage integration with synthetic SQLite and streamed attachment bytes.
use super::*;
use crate::api::{AppState, auth, playback_observer::PlaybackObserver};
use axum::body::Body;
use meeting_backend::integration::services::Submission;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

/// Construct an isolated host state without application data or a network listener.
fn fixture() -> ChatState {
    let conn = rusqlite::Connection::open_in_memory().expect("database");
    conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE rooms(id INTEGER PRIMARY KEY); CREATE TABLE room_conferences(room_id INTEGER PRIMARY KEY REFERENCES rooms(id),provider_room_id TEXT,generation INTEGER,allowed INTEGER,enabled INTEGER); INSERT INTO rooms VALUES(1); INSERT INTO room_conferences VALUES(1,'meeting',0,1,1);").expect("authority");
    conn.execute_batch(include_str!(
        "../../../../../migrations/0020_conference_chat.sql"
    ))
    .expect("chat migration");
    ChatState {
        app: AppState {
            temp_upload_dir: String::new(),
            media_dir: String::new(),
            db: Arc::new(Mutex::new(conn)),
            jwt_secret: String::new(),
            trust_proxy_headers: false,
            csrf_allowed_origins: Arc::new(Vec::new()),
            login_rate_limiter: Arc::new(auth::LoginRateLimiter::new(5, 60)),
            conference_join_rate_limiter: Arc::new(auth::LoginRateLimiter::new(5, 60)),
            conference_provider: None,
            music_bridge_secret: None,
            playback_observer: Arc::new(PlaybackObserver::new(16)),
            youtube_download_limiter: Arc::new(tokio::sync::Semaphore::new(1)),
            runtimes: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        },
        secret: None,
        directory: std::env::temp_dir().join(format!("direct-chat-{}", uuid::Uuid::new_v4())),
        uploads: Arc::new(tokio::sync::Semaphore::new(2)),
    }
}

/// Trusted session identity with independently selectable actor and generation.
fn who(actor: &str, generation: u64) -> ChatIdentity {
    ChatIdentity {
        conference: "meeting".into(),
        generation,
        actor: actor.into(),
        presenter: false,
    }
}

/// Publish streamed bytes, preserve filenames, commit once and reject foreign/stale deletion.
#[tokio::test]
async fn direct_upload_message_authority_and_retry() {
    let state = fixture();
    let bytes = b"synthetic document";
    let attachment = upload(
        &state,
        who("guest:one", 0),
        Upload {
            encoded_name: "Rules.txt".into(),
            media_type: "text/plain".into(),
            size: bytes.len() as u64,
            body: Body::from(bytes.as_slice()),
        },
    )
    .await
    .expect("streamed upload");
    assert_eq!(attachment["name"], "Rules.txt");
    assert_eq!(attachment["size"], bytes.len());
    let attachment_id = attachment["id"].as_str().expect("attachment ID");
    let submission = || {
        ChatOperation::Append(Submission {
            client_id: "retry-one".into(),
            name: "Alice".into(),
            avatar: String::new(),
            text: "rules".into(),
            attachment_id: Some(attachment_id.into()),
        })
    };
    let first = execute(&state, who("guest:one", 0), submission())
        .await
        .expect("commit");
    let again = execute(&state, who("guest:one", 0), submission())
        .await
        .expect("retry");
    assert_eq!(first["message"]["id"], again["message"]["id"]);
    let history = execute(&state, who("guest:two", 0), ChatOperation::History(None))
        .await
        .expect("history");
    assert_eq!(history["messages"].as_array().expect("messages").len(), 1);
    let id = first["message"]["id"]
        .as_str()
        .expect("wire message ID")
        .parse::<i64>()
        .expect("storage message ID");
    let stored = execute(
        &state,
        who("guest:two", 0),
        ChatOperation::Attachment(attachment_id.into()),
    )
    .await
    .expect("authorized attachment metadata");
    let key = stored["storageKey"]
        .as_str()
        .expect("immutable storage key");
    assert_eq!(
        tokio::fs::read(state.directory.join(key))
            .await
            .expect("published bytes"),
        bytes
    );
    for (name, actor, generation) in [
        ("foreign sender", "guest:two", 0),
        ("stale generation", "guest:one", 1),
    ] {
        assert!(
            execute(&state, who(actor, generation), ChatOperation::Delete(id))
                .await
                .is_err(),
            "{name}"
        );
    }
    execute(&state, who("guest:one", 0), ChatOperation::Delete(id))
        .await
        .expect("owner delete");
    tokio::fs::remove_dir_all(&state.directory)
        .await
        .expect("synthetic directory cleanup");
}
