//! Remembered meeting hosts: a browser becomes host of a room by opening the meeting
//! from Studio once; afterwards any entry from that browser is a host entry.
//!
//! Studio mints a single-use host pass (only its SHA-256 is stored). The meeting page
//! redeems it with its guest ticket request, which records the browser's device actor
//! as a host of that room.

use crate::api::AppState;
use rand_core::{OsRng, RngCore};
use ring::digest;
use rusqlite::{OptionalExtension, params};

/// Host pass lifetime; long enough for the new tab to load and ask for a ticket.
const GRANT_TTL_SECONDS: u64 = 300;

/// SHA-256 of a host pass, hex-encoded, as stored in the database.
fn hash(token: &str) -> String {
    digest::digest(&digest::SHA256, token.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A host pass has the exact minted shape: 64 lowercase hex characters.
pub(super) fn valid_grant(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Mint a single-use host pass for one room and purge expired passes.
///
/// # Errors
/// Returns lock or SQL errors.
pub fn mint_grant(state: &AppState, room_id: i64, now: u64) -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let expires =
        i64::try_from(now.saturating_add(GRANT_TTL_SECONDS)).map_err(|err| err.to_string())?;
    let now = i64::try_from(now).map_err(|err| err.to_string())?;
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.execute(
        "DELETE FROM conference_host_grants WHERE expires_at < ?1",
        params![now],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT INTO conference_host_grants(token_hash, room_id, expires_at) VALUES(?1, ?2, ?3)",
        params![hash(&token), room_id, expires],
    )
    .map_err(|err| err.to_string())?;
    Ok(token)
}

/// Consume a host pass for this room and remember the actor as its host.
/// Returns false for an unknown, expired, already used or foreign-room pass.
///
/// # Errors
/// Returns lock, SQL or transaction errors.
pub fn redeem_grant(
    state: &AppState,
    token: &str,
    room_id: i64,
    actor: &str,
    now: u64,
) -> Result<bool, String> {
    if !valid_grant(token) {
        return Ok(false);
    }
    let now = i64::try_from(now).map_err(|err| err.to_string())?;
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let used = tx
        .execute(
            "DELETE FROM conference_host_grants
             WHERE token_hash = ?1 AND room_id = ?2 AND expires_at >= ?3",
            params![hash(token), room_id, now],
        )
        .map_err(|err| err.to_string())?;
    if used == 1 {
        tx.execute(
            "INSERT OR IGNORE INTO conference_hosts(room_id, actor) VALUES(?1, ?2)",
            params![room_id, actor],
        )
        .map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(used == 1)
}

/// Whether this actor is a remembered host of the room.
///
/// # Errors
/// Returns lock or SQL errors.
pub fn is_host(state: &AppState, room_id: i64, actor: &str) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.query_row(
        "SELECT 1 FROM conference_hosts WHERE room_id = ?1 AND actor = ?2",
        params![room_id, actor],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    //! Host pass lifecycle tables against the real migration.

    use super::*;
    use crate::api::{auth, playback_observer::PlaybackObserver};
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    /// Two rooms plus the host tables from the actual migration.
    fn state() -> AppState {
        let conn = rusqlite::Connection::open_in_memory().expect("db");
        conn.execute_batch("PRAGMA foreign_keys = ON; CREATE TABLE rooms(id INTEGER PRIMARY KEY); INSERT INTO rooms VALUES(1),(2);")
            .expect("rooms");
        conn.execute_batch(include_str!(
            "../../../migrations/0019_conference_hosts.sql"
        ))
        .expect("migration");
        AppState {
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
        }
    }

    /// A pass makes its redeemer a host of its own room only, exactly once, before expiry.
    #[test]
    fn host_pass_cases() {
        for (name, room, at, second_use, expected) in [
            ("fresh pass on its room", 1, 100, false, true),
            ("pass for another room", 2, 100, false, false),
            ("expired pass", 1, 100 + GRANT_TTL_SECONDS + 1, false, false),
            ("pass is single use", 1, 100, true, false),
        ] {
            let state = state();
            let token = mint_grant(&state, 1, 100).expect("mint");
            if second_use {
                assert!(
                    redeem_grant(&state, &token, 1, "guest-a", 100).expect("first"),
                    "{name}"
                );
            }
            let redeemed = redeem_grant(&state, &token, room, "guest-b", at).expect("redeem");
            assert_eq!(redeemed, expected, "{name}");
            assert_eq!(
                is_host(&state, room, "guest-b").expect("lookup"),
                expected,
                "{name}"
            );
        }
    }

    /// Malformed passes are rejected without touching the database.
    #[test]
    fn malformed_pass_is_rejected() {
        let state = state();
        for token in ["", "abc", &"G".repeat(64), &"a".repeat(65)] {
            assert!(
                !redeem_grant(&state, token, 1, "guest", 100).expect("redeem"),
                "{token}"
            );
        }
        assert!(!is_host(&state, 1, "guest").expect("lookup"));
    }

    /// Only the token's hash is stored.
    #[test]
    fn only_the_hash_is_stored() {
        let state = state();
        let token = mint_grant(&state, 1, 100).expect("mint");
        let stored: String = state
            .db
            .lock()
            .expect("db")
            .query_row("SELECT token_hash FROM conference_host_grants", [], |row| {
                row.get(0)
            })
            .expect("row");
        assert_ne!(stored, token);
        assert_eq!(stored, hash(&token));
    }
}
