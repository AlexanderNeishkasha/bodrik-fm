//! Room-owned library sections and atomic track/section ordering mutations.

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::{
    api::{AppState, library_db_util, op_error::OpError},
    stream::TrackEntry,
};

/// A room-owned named section in authoritative library order.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LibrarySection {
    /// Database section identifier.
    pub id: i64,
    /// Validated display name.
    pub name: String,
    /// Persisted signed ordering key.
    pub sort_order: i64,
}

/// Ordered library data consumed by Studio.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LibraryPayload {
    /// Ordered room-owned sections.
    pub sections: Vec<LibrarySection>,
    /// Ordered tracks, including unsectioned entries.
    pub tracks: Vec<TrackEntry>,
}

/// Load sections and tracks from one read transaction for a coherent library snapshot.
///
/// # Errors
/// Returns lock, SQL or row-conversion errors.
pub fn list_library(state: &AppState, room_id: i64) -> Result<LibraryPayload, String> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    Ok(LibraryPayload {
        sections: list_sections(&tx, room_id)?,
        tracks: crate::api::db::list_room_tracks_on(&tx, room_id)?,
    })
}

/// Prepend a section and shift existing orders within one transaction.
///
/// # Errors
/// Returns duplicate-name, order overflow, lock, SQL or commit errors.
pub fn create_section(
    state: &AppState,
    room_id: i64,
    name: &str,
) -> Result<LibrarySection, OpError> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let max_order: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM library_sections WHERE room_id = ?1",
            params![room_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    library_db_util::checked_order(max_order, 1)?;
    tx.execute(
        "UPDATE library_sections
         SET sort_order = sort_order + 1, updated_at = CURRENT_TIMESTAMP
         WHERE room_id = ?1",
        params![room_id],
    )
    .map_err(|err| err.to_string())?;
    let sort_order = 0;
    tx.execute(
        "INSERT INTO library_sections(room_id, name, sort_order)
         VALUES(?1, ?2, ?3)",
        params![room_id, name, sort_order],
    )
    .map_err(OpError::on_unique(
        "idx_library_sections_name_unique",
        "name exists",
    ))?;
    let id = tx.last_insert_rowid();
    tx.commit().map_err(|err| err.to_string())?;
    Ok(LibrarySection {
        id,
        name: name.to_string(),
        sort_order,
    })
}

/// Rename only a section belonging to the room; missing sections return false.
///
/// # Errors
/// Returns duplicate-name, lock or SQL errors.
pub fn rename_section(
    state: &AppState,
    room_id: i64,
    section_id: i64,
    name: &str,
) -> Result<bool, OpError> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let changed = conn
        .execute(
            "UPDATE library_sections
             SET name = ?1, updated_at = CURRENT_TIMESTAMP
             WHERE room_id = ?2 AND id = ?3",
            params![name, room_id, section_id],
        )
        .map_err(OpError::on_unique(
            "idx_library_sections_name_unique",
            "name exists",
        ))?;
    Ok(changed > 0)
}

/// Append section tracks to the unsectioned group and remove the section atomically.
///
/// # Errors
/// Returns order overflow, lock, SQL or commit errors.
pub fn delete_section(state: &AppState, room_id: i64, section_id: i64) -> Result<bool, OpError> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    if !section_exists_tx(&tx, room_id, section_id)? {
        return Ok(false);
    }
    let base_order = library_db_util::checked_order(max_track_order_tx(&tx, room_id, None)?, 1)?;
    let track_ids = section_track_ids_tx(&tx, room_id, Some(section_id))?;
    for (offset, track_id) in track_ids.iter().enumerate() {
        tx.execute(
            "UPDATE room_tracks
             SET section_id = NULL, sort_order = ?1
             WHERE room_id = ?2 AND id = ?3",
            params![
                library_db_util::checked_order(base_order, offset)?,
                room_id,
                track_id
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    tx.execute(
        "DELETE FROM library_sections WHERE room_id = ?1 AND id = ?2",
        params![room_id, section_id],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(true)
}

/// Persist an exact permutation of room-owned section IDs transactionally.
///
/// # Errors
/// Returns invalid-order, conversion, lock, SQL or commit errors.
pub fn reorder_sections(state: &AppState, room_id: i64, ids: &[i64]) -> Result<(), OpError> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let current = section_ids_tx(&tx, room_id)?;
    if !library_db_util::same_id_set(&current, ids) {
        return Err(OpError::Rejected("invalid order"));
    }
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE library_sections
             SET sort_order = ?1, updated_at = CURRENT_TIMESTAMP
             WHERE room_id = ?2 AND id = ?3",
            params![library_db_util::checked_order(0, index)?, room_id, id],
        )
        .map_err(|err| err.to_string())?;
    }
    tx.commit()
        .map_err(|err| OpError::Internal(err.to_string()))
}

/// Move a room-owned track and renumber source/target groups atomically.
///
/// # Errors
/// Returns invalid-section/order, lock, SQL or commit errors; missing tracks return false.
pub fn move_track(
    state: &AppState,
    room_id: i64,
    track_id: i64,
    section_id: Option<i64>,
    index: usize,
) -> Result<bool, OpError> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    if !valid_section_tx(&tx, room_id, section_id)? {
        return Err(OpError::Rejected("invalid section"));
    }
    let Some(current_section) = track_section_tx(&tx, room_id, track_id)? else {
        return Ok(false);
    };
    let mut target_ids = section_track_ids_tx(&tx, room_id, section_id)?
        .into_iter()
        .filter(|id| *id != track_id)
        .collect::<Vec<_>>();
    let insert_at = index.min(target_ids.len());
    target_ids.insert(insert_at, track_id);
    if current_section != section_id {
        let source_ids = section_track_ids_tx(&tx, room_id, current_section)?
            .into_iter()
            .filter(|id| *id != track_id)
            .collect::<Vec<_>>();
        write_track_order_tx(&tx, room_id, current_section, &source_ids)?;
    }
    write_track_order_tx(&tx, room_id, section_id, &target_ids)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(true)
}

/// Persist an exact permutation of tracks in one validated room section.
///
/// # Errors
/// Returns invalid-section/order, lock, SQL or commit errors.
pub fn reorder_tracks(
    state: &AppState,
    room_id: i64,
    section_id: Option<i64>,
    ids: &[i64],
) -> Result<(), OpError> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    if !valid_section_tx(&tx, room_id, section_id)? {
        return Err(OpError::Rejected("invalid section"));
    }
    let current = section_track_ids_tx(&tx, room_id, section_id)?;
    if !library_db_util::same_id_set(&current, ids) {
        return Err(OpError::Rejected("invalid order"));
    }
    write_track_order_tx(&tx, room_id, section_id, ids)?;
    tx.commit()
        .map_err(|err| OpError::Internal(err.to_string()))
}

/// Load sections in stable display order on the caller's connection/transaction.
///
/// # Errors
/// Returns SQL or row-conversion errors.
fn list_sections(conn: &Connection, room_id: i64) -> Result<Vec<LibrarySection>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, sort_order
             FROM library_sections
             WHERE room_id = ?1
             ORDER BY sort_order ASC, lower(name) ASC, id ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![room_id], |row| {
            Ok(LibrarySection {
                id: row.get(0)?,
                name: row.get(1)?,
                sort_order: row.get(2)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

/// Check section ownership inside the caller's transaction.
///
/// # Errors
/// Returns SQL or conversion errors.
fn section_exists_tx(tx: &Transaction<'_>, room_id: i64, id: i64) -> Result<bool, String> {
    tx.query_row(
        "SELECT id FROM library_sections WHERE room_id = ?1 AND id = ?2",
        params![room_id, id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(|err| err.to_string())
}

/// Accept the unsectioned group or an existing section owned by the room.
///
/// # Errors
/// Returns SQL or conversion errors.
fn valid_section_tx(
    tx: &Transaction<'_>,
    room_id: i64,
    section_id: Option<i64>,
) -> Result<bool, String> {
    match section_id {
        Some(id) => section_exists_tx(tx, room_id, id),
        None => Ok(true),
    }
}

/// Collect all room section IDs for exact-permutation validation.
///
/// # Errors
/// Returns SQL or row-conversion errors.
fn section_ids_tx(tx: &Transaction<'_>, room_id: i64) -> Result<Vec<i64>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT id FROM library_sections
             WHERE room_id = ?1
             ORDER BY sort_order ASC, id ASC",
        )
        .map_err(|err| err.to_string())?;
    library_db_util::collect_i64(stmt.query_map(params![room_id], |row| row.get(0)))
}

/// Distinguish a missing track from an existing unsectioned track.
///
/// # Errors
/// Returns SQL or conversion errors.
fn track_section_tx(
    tx: &Transaction<'_>,
    room_id: i64,
    track_id: i64,
) -> Result<Option<Option<i64>>, String> {
    tx.query_row(
        "SELECT section_id FROM room_tracks WHERE room_id = ?1 AND id = ?2",
        params![room_id, track_id],
        |row| row.get::<_, Option<i64>>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

/// Collect stable track order for a validated section or unsectioned group.
///
/// # Errors
/// Returns SQL or row-conversion errors.
fn section_track_ids_tx(
    tx: &Transaction<'_>,
    room_id: i64,
    section_id: Option<i64>,
) -> Result<Vec<i64>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT id FROM room_tracks
             WHERE room_id = ?1
               AND (section_id = ?2 OR (section_id IS NULL AND ?2 IS NULL))
             ORDER BY sort_order ASC, lower(title) ASC, id ASC",
        )
        .map_err(|err| err.to_string())?;
    library_db_util::collect_i64(stmt.query_map(params![room_id, section_id], |row| row.get(0)))
}

/// Read the last track order, or -1 for an empty group.
///
/// # Errors
/// Returns SQL or signed-integer conversion errors.
fn max_track_order_tx(
    tx: &Transaction<'_>,
    room_id: i64,
    section_id: Option<i64>,
) -> Result<i64, String> {
    tx.query_row(
        "SELECT COALESCE(MAX(sort_order), -1)
         FROM room_tracks
         WHERE room_id = ?1
           AND (section_id = ?2 OR (section_id IS NULL AND ?2 IS NULL))",
        params![room_id, section_id],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

/// Write dense signed positions inside the caller's transaction.
///
/// # Errors
/// Returns order conversion, SQL or update errors.
fn write_track_order_tx(
    tx: &Transaction<'_>,
    room_id: i64,
    section_id: Option<i64>,
    ids: &[i64],
) -> Result<(), OpError> {
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE room_tracks
             SET section_id = ?1, sort_order = ?2
             WHERE room_id = ?3 AND id = ?4",
            params![
                section_id,
                library_db_util::checked_order(0, index)?,
                room_id,
                id
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}
