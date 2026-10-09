//! Room allocation, public lookup and atomic room preference mutations.

use super::RoomRecord;
use crate::api::{AppState, util_v2};
use rusqlite::{OptionalExtension, Transaction, params};

/// Ensure a user's room/settings inside the caller's account transaction.
///
/// # Errors
/// Returns SQL or exhausted slug-allocation errors.
pub(super) fn ensure_room_for_user_tx(
    tx: &Transaction<'_>,
    user_id: i64,
    login: &str,
) -> Result<i64, String> {
    if let Some(id) = room_id_tx(tx, user_id)? {
        return Ok(id);
    }
    let base = util_v2::normalize_slug(login).unwrap_or_else(|| "room".into());
    let slug = unique_slug_tx(tx, &base)?;
    tx.execute(
        "INSERT INTO rooms(owner_user_id, slug) VALUES(?1, ?2)",
        params![user_id, slug],
    )
    .map_err(|err| err.to_string())?;
    let room_id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO room_settings(room_id, theme, repeat_one) VALUES(?1, 'mono', 0)",
        params![room_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(room_id)
}

/// Find an available slug without exceeding the public slug length limit.
///
/// # Errors
/// Returns SQL errors or exhaustion after 10,000 candidates.
fn unique_slug_tx(tx: &Transaction<'_>, base: &str) -> Result<String, String> {
    for index in 0..10000 {
        let candidate = slug_candidate(base, index);
        let exists: Option<i64> = tx
            .query_row(
                "SELECT id FROM rooms WHERE slug = ?1",
                params![candidate],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        if exists.is_none() {
            return Ok(candidate);
        }
    }
    Err("failed to allocate slug".into())
}

/// Allocate space for a collision suffix in an already-normalized ASCII slug base.
fn slug_candidate(base: &str, index: usize) -> String {
    let suffix = if index == 0 {
        String::new()
    } else {
        format!("-{index}")
    };
    let prefix = base.chars().take(48 - suffix.len()).collect::<String>();
    format!("{prefix}{suffix}")
}

/// List rooms visible in the public directory, ordered by slug.
///
/// # Errors
/// Returns lock, SQL or row-conversion errors.
pub fn list_rooms(state: &AppState) -> Result<Vec<RoomRecord>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let mut stmt = conn
        .prepare("SELECT id, slug FROM rooms WHERE is_listed = 1 ORDER BY slug ASC")
        .map_err(|err| err.to_string())?;
    stmt.query_map([], room_from_row)
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

/// Resolve a current public slug; listing does not control direct-link access.
///
/// # Errors
/// Returns lock, SQL or conversion errors; missing rooms return `None`.
pub fn room_by_slug(state: &AppState, slug: &str) -> Result<Option<RoomRecord>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.query_row(
        "SELECT id, slug FROM rooms WHERE slug = ?1",
        params![slug],
        room_from_row,
    )
    .optional()
    .map_err(|err| err.to_string())
}

/// Resolve a room by its authoritative database identifier.
///
/// # Errors
/// Returns lock, SQL or conversion errors; missing rooms return `None`.
pub fn room_by_id(state: &AppState, room_id: i64) -> Result<Option<RoomRecord>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.query_row(
        "SELECT id, slug FROM rooms WHERE id = ?1",
        params![room_id],
        room_from_row,
    )
    .optional()
    .map_err(|err| err.to_string())
}

/// Decode the shared minimal room projection.
///
/// # Errors
/// Returns SQLite column/type conversion errors.
fn room_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoomRecord> {
    Ok(RoomRecord {
        id: row.get(0)?,
        slug: row.get(1)?,
    })
}

/// Persist a normalized slug for the user's room, checking uniqueness transactionally.
///
/// # Errors
/// Returns missing-room, conflicting-slug, lock, SQL or commit errors.
pub fn update_user_room_slug(state: &AppState, user_id: i64, slug: &str) -> Result<String, String> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let room_id = room_id_tx(&tx, user_id)?.ok_or("room missing")?;
    assert_slug_available(&tx, room_id, slug)?;
    tx.execute(
        "UPDATE rooms SET slug = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        params![slug, room_id],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(slug.to_owned())
}

/// Atomically update an administrator-selected room slug and directory visibility.
///
/// # Errors
/// Returns conflicting-slug, lock, SQL or commit errors; missing owners return `false`.
pub fn update_user_room(
    state: &AppState,
    user_id: i64,
    slug: &str,
    listed: bool,
) -> Result<bool, String> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let Some(room_id) = room_id_tx(&tx, user_id)? else {
        return Ok(false);
    };
    assert_slug_available(&tx, room_id, slug)?;
    tx.execute(
        "UPDATE rooms SET slug = ?1, is_listed = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3",
        params![slug, i64::from(listed), room_id],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(true)
}

/// Look up the owned room while the caller holds its transaction.
///
/// # Errors
/// Returns SQL/conversion errors; an absent room returns `None`.
fn room_id_tx(tx: &Transaction<'_>, user_id: i64) -> Result<Option<i64>, String> {
    tx.query_row(
        "SELECT id FROM rooms WHERE owner_user_id = ?1",
        params![user_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

/// Reject another room's slug before writing either slug or visibility.
///
/// # Errors
/// Returns `slug exists` or SQL/conversion errors.
fn assert_slug_available(tx: &Transaction<'_>, room_id: i64, slug: &str) -> Result<(), String> {
    let exists: Option<i64> = tx
        .query_row(
            "SELECT id FROM rooms WHERE slug = ?1 AND id != ?2",
            params![slug, room_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if exists.is_some() {
        return Err("slug exists".into());
    }
    Ok(())
}

/// Change visibility without modifying the room's public slug.
///
/// # Errors
/// Returns lock or SQL errors; missing owners return `false`.
pub fn set_user_room_listed(state: &AppState, user_id: i64, listed: bool) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.execute(
        "UPDATE rooms SET is_listed = ?1, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ?2",
        params![i64::from(listed), user_id],
    )
    .map(|changed| changed > 0)
    .map_err(|err| err.to_string())
}

/// Pure collision/length coverage, without allocating database rooms.
#[cfg(test)]
mod tests {
    use super::*;

    /// Collision suffixes remain normalized and fit the 48-byte public limit.
    #[test]
    fn slug_candidate_cases() {
        for (base, attempt, expected) in [
            ("room".into(), 0, "room".into()),
            ("room".into(), 1, "room-1".into()),
            ("x".repeat(48), 0, "x".repeat(48)),
            ("x".repeat(48), 1, format!("{}-1", "x".repeat(46))),
            ("x".repeat(48), 9999, format!("{}-9999", "x".repeat(43))),
        ] {
            let candidate = slug_candidate(&base, attempt);
            assert_eq!(candidate, expected);
            assert_eq!(
                util_v2::normalize_slug(&candidate).as_deref(),
                Some(candidate.as_str())
            );
        }
    }
}
