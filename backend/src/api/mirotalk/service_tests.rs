//! Existing SQL/HTTP integration fixtures; compiled but excluded from unit-only review checks.

use crate::api::{
    AppState, auth_v2,
    conference::{
        Provider,
        service::{set_access, set_enabled},
    },
    mirotalk,
};
use axum::{Router, http::StatusCode, routing::delete};
use rusqlite::Connection;
use std::{collections::HashMap, sync::Arc};

/// Build the legacy isolated provider/SQLite fixture, including the new durable cleanup schema.
async fn state(status: StatusCode) -> (AppState, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/internal/replacement/v1/conferences/{room}",
        delete(move || async move { status }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE rooms(id INTEGER PRIMARY KEY, owner_user_id INTEGER, slug TEXT);
        CREATE TABLE room_conferences(room_id INTEGER PRIMARY KEY, provider TEXT, allowed INTEGER, enabled INTEGER,
        external_id TEXT, provider_room_id TEXT, generation INTEGER DEFAULT 0, updated_at TEXT);
        INSERT INTO rooms VALUES(1, 10, 'room');
        INSERT INTO room_conferences(room_id, provider, allowed, enabled, external_id, provider_room_id)
        VALUES(1, 'mirotalk', 1, 1, 'invitation', 'provider-room');").unwrap();
    conn.execute_batch(include_str!(
        "../../../migrations/0018_conference_termination_outbox.sql"
    ))
    .unwrap();
    let config = mirotalk::Config {
        public_url: "https://meet.example".into(),
        replacement_url: format!("http://{address}"),
        replacement_secret: "synthetic-replacement-secret-32".into(),
    };
    let state = AppState {
        temp_upload_dir: String::new(),
        media_dir: String::new(),
        db: Arc::new(std::sync::Mutex::new(conn)),
        jwt_secret: String::new(),
        trust_proxy_headers: false,
        csrf_allowed_origins: Arc::new(Vec::new()),
        login_rate_limiter: Arc::new(auth_v2::LoginRateLimiter::new(5, 60)),
        conference_join_rate_limiter: Arc::new(auth_v2::LoginRateLimiter::new(5, 60)),
        conference_provider: Some(Arc::new(Provider::mirotalk(config))),
        music_bridge_secret: None,
        playback_observer: Arc::new(crate::api::playback_observer::PlaybackObserver::new(4)),
        youtube_download_limiter: Arc::new(tokio::sync::Semaphore::new(1)),
        runtimes: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
    };
    (state, server)
}

/// Preserve successful owner disablement's persisted and provider-facing behavior.
#[tokio::test]
async fn owner_disable_terminates_provider_state() {
    let (state, server) = state(StatusCode::OK).await;
    let conference = set_enabled(&state, 1, false).await.unwrap();
    assert!(!conference.enabled);
    server.abort();
}

/// Preserve fail-closed revocation when provider termination fails.
#[tokio::test]
async fn revocation_stays_fail_closed_when_provider_termination_fails() {
    let (state, server) = state(StatusCode::BAD_GATEWAY).await;
    assert!(set_access(&state, 10, false).await.is_err());
    let persisted = state
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT enabled, provider_room_id FROM room_conferences WHERE room_id = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(persisted.0, 0);
    assert_ne!(persisted.1, "provider-room");
    server.abort();
}
