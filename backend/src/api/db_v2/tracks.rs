//! Room-owned track projections and transactional upload/deletion persistence.

use super::{DeleteTrackOutcome, types::valid_duration};
use crate::{api::AppState, stream::TrackEntry};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

/// List a room's tracks in section/display order, including authoritative media keys.
///
/// # Errors
/// Returns lock, SQL or row-conversion errors.
pub fn list_room_tracks(state: &AppState, room_id: i64) -> Result<Vec<TrackEntry>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    list_room_tracks_on(&conn, room_id)
}

/// Read tracks on a caller-owned connection/transaction for a coherent library snapshot.
///
/// # Errors
/// Returns SQL or row-conversion errors.
pub(crate) fn list_room_tracks_on(
    conn: &Connection,
    room_id: i64,
) -> Result<Vec<TrackEntry>, String> {
    let mut stmt = conn.prepare("SELECT rt.id, rt.title, a.duration_sec, a.storage_key, rt.section_id, rt.sort_order
        FROM room_tracks rt JOIN assets a ON a.id = rt.asset_id
        LEFT JOIN library_sections ls ON ls.id = rt.section_id AND ls.room_id = rt.room_id
        WHERE rt.room_id = ?1 ORDER BY rt.section_id IS NOT NULL ASC,
        COALESCE(ls.sort_order, rt.section_id) ASC, rt.sort_order ASC, lower(rt.title) ASC, rt.id ASC")
        .map_err(|err| err.to_string())?;
    stmt.query_map(params![room_id], track_from_row)
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

/// Resolve a track only within its owning room; malformed/missing IDs return `None`.
///
/// # Errors
/// Returns lock, SQL or row-conversion errors.
pub fn resolve_track(
    state: &AppState,
    room_id: i64,
    track_id: &str,
) -> Result<Option<TrackEntry>, String> {
    let Ok(track_id) = track_id.parse::<i64>() else {
        return Ok(None);
    };
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.query_row("SELECT rt.id, rt.title, a.duration_sec, a.storage_key, rt.section_id, rt.sort_order
        FROM room_tracks rt JOIN assets a ON a.id = rt.asset_id WHERE rt.room_id = ?1 AND rt.id = ?2",
        params![room_id, track_id], track_from_row).optional().map_err(|err| err.to_string())
}

/// Decode the common public/runtime track projection without exposing absolute paths.
///
/// # Errors
/// Returns SQLite column/type conversion errors.
fn track_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrackEntry> {
    Ok(TrackEntry {
        id: row.get::<_, i64>(0)?.to_string(),
        filename: row.get(1)?,
        duration: row.get(2)?,
        media_path: row.get(3)?,
        section_id: row.get(4)?,
        sort_order: row.get(5)?,
    })
}

/// Insert an upload asset and append its room track as one transaction.
///
/// # Errors
/// Returns invalid-duration, lock, uniqueness, SQL or commit errors.
pub fn create_room_upload_track(
    state: &AppState,
    room_id: i64,
    storage_key: &str,
    title: &str,
    duration: Option<f64>,
) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    insert_upload_track_tx(&tx, room_id, storage_key, title, duration)?;
    tx.commit().map_err(|err| err.to_string())
}

/// Insert an owned upload inside the caller's transaction without committing it.
///
/// # Errors
/// Returns invalid-duration, uniqueness or SQL errors; caller controls atomic completion.
pub(crate) fn insert_upload_track_tx(
    tx: &Transaction<'_>,
    room_id: i64,
    storage_key: &str,
    title: &str,
    duration: Option<f64>,
) -> Result<(), String> {
    if !valid_duration(duration) {
        return Err("invalid track duration".into());
    }
    tx.execute(
        "INSERT INTO assets(kind, owner_room_id, storage_key, original_name, duration_sec)
        VALUES('room_upload', ?1, ?2, ?3, ?4)",
        params![room_id, storage_key, title, duration],
    )
    .map_err(|err| err.to_string())?;
    let asset_id = tx.last_insert_rowid();
    let sort_order: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1
        FROM room_tracks WHERE room_id = ?1 AND section_id IS NULL",
            params![room_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    tx.execute(
        "INSERT INTO room_tracks(room_id, asset_id, title, sort_order) VALUES(?1, ?2, ?3, ?4)",
        params![room_id, asset_id, title, sort_order],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Check room-local case-insensitive title uniqueness before an upload.
///
/// # Errors
/// Returns lock, SQL or conversion errors.
pub fn room_track_title_exists(
    state: &AppState,
    room_id: i64,
    title: &str,
) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.query_row(
        "SELECT id FROM room_tracks WHERE room_id = ?1 AND lower(title) = lower(?2)",
        params![room_id, title],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|err| err.to_string())
}

/// Rename only a room-owned track, rejecting another track's case-insensitive title.
///
/// # Errors
/// Returns name-conflict, lock or SQL errors; missing tracks return `false`.
pub fn rename_room_track(
    state: &AppState,
    room_id: i64,
    track_id: i64,
    title: &str,
) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let exists: Option<i64> = conn.query_row(
        "SELECT id FROM room_tracks WHERE room_id = ?1 AND lower(title) = lower(?2) AND id != ?3",
        params![room_id, title, track_id], |row| row.get(0)).optional().map_err(|err| err.to_string())?;
    if exists.is_some() {
        return Err("name exists".into());
    }
    conn.execute(
        "UPDATE room_tracks SET title = ?1 WHERE room_id = ?2 AND id = ?3",
        params![title, room_id, track_id],
    )
    .map(|changed| changed > 0)
    .map_err(|err| err.to_string())
}

/// Detach a room track; delete its upload asset only when no references remain.
///
/// # Errors
/// Returns lock, SQL or commit errors; missing tracks have `deleted = false`.
pub fn delete_room_track(
    state: &AppState,
    room_id: i64,
    track_id: i64,
) -> Result<DeleteTrackOutcome, String> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let target: Option<(i64, String, String)> = tx.query_row(
        "SELECT a.id, a.kind, a.storage_key FROM room_tracks rt JOIN assets a ON a.id = rt.asset_id
        WHERE rt.room_id = ?1 AND rt.id = ?2", params![room_id, track_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(|err| err.to_string())?;
    let Some((asset_id, asset_kind, storage_key)) = target else {
        return Ok(DeleteTrackOutcome {
            deleted: false,
            cleanup_storage_key: None,
        });
    };
    tx.execute(
        "DELETE FROM room_tracks WHERE room_id = ?1 AND id = ?2",
        params![room_id, track_id],
    )
    .map_err(|err| err.to_string())?;
    let ref_count: i64 = tx
        .query_row(
            "SELECT COUNT(1) FROM room_tracks WHERE asset_id = ?1",
            params![asset_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let cleanup_storage_key = if ref_count == 0 && asset_kind == "room_upload" {
        tx.execute("DELETE FROM assets WHERE id = ?1", params![asset_id])
            .map_err(|err| err.to_string())?;
        Some(storage_key)
    } else {
        None
    };
    tx.commit().map_err(|err| err.to_string())?;
    Ok(DeleteTrackOutcome {
        deleted: true,
        cleanup_storage_key,
    })
}

/// List all asset storage keys for startup HLS cache inspection.
///
/// # Errors
/// Returns lock, SQL or row-conversion errors.
pub fn list_all_storage_keys(state: &AppState) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let mut stmt = conn
        .prepare("SELECT storage_key FROM assets ORDER BY id ASC")
        .map_err(|err| err.to_string())?;
    stmt.query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}
