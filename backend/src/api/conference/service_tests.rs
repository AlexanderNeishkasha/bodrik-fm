//! SQL-backed fail-closed revocation checks against an unavailable embedded meeting.

use crate::api::{
    AppState, auth,
    conference::{
        Provider,
        service::{set_access, set_enabled},
    },
};
use rusqlite::{Connection, params};
use std::{collections::HashMap, sync::Arc};

/// Build an isolated room with an enabled conference whose meeting runtime never became ready.
fn state() -> AppState {
    let provider = Provider::embedded("https://meet.example".into(), crate::meeting::Shared::new());
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE rooms(id INTEGER PRIMARY KEY, owner_user_id INTEGER, slug TEXT);
        CREATE TABLE room_conferences(room_id INTEGER PRIMARY KEY, provider TEXT, allowed INTEGER, enabled INTEGER,
        external_id TEXT, provider_room_id TEXT, generation INTEGER DEFAULT 0, updated_at TEXT);
        INSERT INTO rooms VALUES(1, 10, 'room');").unwrap();
    conn.execute(
        "INSERT INTO room_conferences(room_id, provider, allowed, enabled, external_id, provider_room_id)
        VALUES(1, ?1, 1, 1, 'invitation', 'provider-room')",
        params![provider.key()],
    )
    .unwrap();
    conn.execute_batch(include_str!(
        "../../../migrations/0018_conference_termination_outbox.sql"
    ))
    .unwrap();
    AppState {
        temp_upload_dir: String::new(),
        media_dir: String::new(),
        db: Arc::new(std::sync::Mutex::new(conn)),
        jwt_secret: String::new(),
        trust_proxy_headers: false,
        csrf_allowed_origins: Arc::new(Vec::new()),
        login_rate_limiter: Arc::new(auth::LoginRateLimiter::new(5, 60)),
        conference_join_rate_limiter: Arc::new(auth::LoginRateLimiter::new(5, 60)),
        conference_provider: Some(Arc::new(provider)),
        music_bridge_secret: None,
        playback_observer: Arc::new(crate::api::playback_observer::PlaybackObserver::new(4)),
        youtube_download_limiter: Arc::new(tokio::sync::Semaphore::new(1)),
        runtimes: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
    }
}

/// Revocation persists disabled state, rotates the mapping and keeps the old target queued
/// for retry when meeting termination fails.
#[tokio::test]
async fn revocation_stays_fail_closed_when_termination_fails() {
    for name in ["owner disable", "entitlement revoke"] {
        let state = state();
        let failed = match name {
            "owner disable" => set_enabled(&state, 1, false).await.is_err(),
            _ => set_access(&state, 10, false).await.is_err(),
        };
        assert!(
            failed,
            "{name}: unavailable meeting must surface termination failure"
        );
        let conn = state.db.lock().unwrap();
        let (enabled, mapping): (i64, Option<String>) = conn
            .query_row(
                "SELECT enabled, provider_room_id FROM room_conferences WHERE room_id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(enabled, 0, "{name}");
        assert_ne!(mapping.as_deref(), Some("provider-room"), "{name}");
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conference_termination_outbox WHERE provider_room_id = 'provider-room'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued, 1, "{name}: failed target stays durable");
    }
}
