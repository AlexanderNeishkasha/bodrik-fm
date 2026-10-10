//! Existing SQLite integration coverage; excluded from unit-only review execution.

use std::{collections::HashMap, sync::Arc};

use rusqlite::Connection;

use crate::api::{AppState, auth};

use super::db;

/// Build isolated legacy room fixtures with durable cleanup storage.
fn state() -> AppState {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE rooms (
            id INTEGER PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            owner_user_id INTEGER UNIQUE
        );
        CREATE TABLE room_conferences (
            room_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            allowed INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 0,
            external_id TEXT,
            provider_room_id TEXT,
            generation INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT,
            PRIMARY KEY(room_id)
        );
        INSERT INTO rooms(id, slug, owner_user_id)
        VALUES(1, 'alpha', 10), (2, 'beta', 20);",
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
        conference_provider: None,
        music_bridge_secret: None,
        playback_observer: Arc::new(crate::api::playback_observer::PlaybackObserver::new(16)),
        youtube_download_limiter: Arc::new(tokio::sync::Semaphore::new(1)),
        runtimes: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
    }
}

/// Preserve applied migration copying/retirement contracts.
#[test]
fn migration_preserves_existing_conference_settings() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE rooms (
            id INTEGER PRIMARY KEY,
            mirotalk_allowed INTEGER NOT NULL DEFAULT 0,
            mirotalk_enabled INTEGER NOT NULL DEFAULT 0,
            mirotalk_conference_id TEXT
        );
        INSERT INTO rooms VALUES(7, 1, 1, 'existing-opaque-id');",
    )
    .unwrap();
    conn.execute_batch(include_str!(
        "../../../migrations/0013_room_conferences.sql"
    ))
    .unwrap();
    conn.execute_batch(include_str!(
        "../../../migrations/0014_conference_provider_room_generation.sql"
    ))
    .unwrap();
    let migrated = conn
        .query_row(
            "SELECT provider, allowed, enabled, external_id, provider_room_id
             FROM room_conferences WHERE room_id = 7",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        migrated,
        (
            "mirotalk".to_string(),
            1,
            1,
            "existing-opaque-id".to_string(),
            "existing-opaque-id".to_string()
        )
    );

    conn.execute_batch(include_str!(
        "../../../migrations/0017_retire_opaque_conference_invitations.sql"
    ))
    .unwrap();
    let retired = conn
        .query_row(
            "SELECT external_id, provider_room_id FROM room_conferences WHERE room_id = 7",
            [],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(retired, (None, "existing-opaque-id".to_string()));
}

/// Preserve unique private IDs and disable/reenable/slug-rename behavior.
#[test]
fn private_provider_rooms_are_unique_and_rotate_on_disable() {
    let state = state();
    assert!(db::set_enabled(&state, 1, true).is_err());
    assert!(db::set_allowed_by_user_id(&state, 10, Some("fake"), true).unwrap());
    assert!(db::set_allowed_by_user_id(&state, 20, Some("fake"), true).unwrap());
    let alpha = db::set_enabled(&state, 1, true).unwrap();
    let beta = db::set_enabled(&state, 2, true).unwrap();
    let alpha_provider_room = alpha.provider_room_id.clone().unwrap();
    assert_ne!(alpha.provider_room_id, beta.provider_room_id);

    let disabled = db::set_enabled(&state, 1, false).unwrap();
    assert_ne!(
        disabled.provider_room_id.as_deref(),
        Some(alpha_provider_room.as_str())
    );
    let enabled_again = db::set_enabled(&state, 1, true).unwrap();

    state
        .db
        .lock()
        .unwrap()
        .execute("UPDATE rooms SET slug = 'renamed' WHERE id = 1", [])
        .unwrap();
    assert!(db::by_slug(&state, "alpha").unwrap().is_none());
    let renamed = db::by_slug(&state, "renamed").unwrap().unwrap();
    assert_eq!(renamed.provider_room_id, enabled_again.provider_room_id);
}

/// Missing integration rows default disabled, not entitled.
#[test]
fn unconfigured_rooms_have_default_disabled_state() {
    let state = state();
    let conference = db::by_slug(&state, "alpha").unwrap().unwrap();
    assert!(!conference.enabled);
    assert!(!conference.allowed);
    assert_eq!(db::allowed_by_user_id(&state, 10).unwrap(), Some(false));
    assert_eq!(db::allowed_by_user_id(&state, 99).unwrap(), None);
    assert!(db::by_slug(&state, "missing").unwrap().is_none());
}

/// Revocation persists both entitlement and enablement denial.
#[test]
fn revoking_access_disables_the_conference() {
    let state = state();
    db::set_allowed_by_user_id(&state, 10, Some("fake"), true).unwrap();
    db::set_enabled(&state, 1, true).unwrap();
    db::set_allowed_by_user_id(&state, 10, Some("fake"), false).unwrap();

    let conference = db::by_room_id(&state, 1).unwrap().unwrap();
    assert!(!conference.allowed);
    assert!(!conference.enabled);
}
