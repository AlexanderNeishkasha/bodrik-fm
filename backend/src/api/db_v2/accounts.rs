//! Account persistence and user/room creation/deletion transactions.

use super::{AdminUserRow, UserRecord, rooms::ensure_room_for_user_tx};
use crate::api::{AppState, auth_v2, util_v2};
use rusqlite::{OptionalExtension, params};

/// Provision/reactivate the configured administrator and ensure its room exists.
///
/// # Errors
/// Returns invalid-login, hashing, lock, SQL or transaction errors.
pub fn upsert_admin_user(state: &AppState, login: &str, password: &str) -> Result<(), String> {
    let normalized = util_v2::normalize_login(login).ok_or("invalid ADMIN_LOGIN")?;
    let hash = auth_v2::hash_password(password)?;
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let user_id: Option<i64> = tx
        .query_row(
            "SELECT id FROM users WHERE login = ?1",
            params![normalized],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let user_id = if let Some(id) = user_id {
        tx.execute(
            "UPDATE users SET password_hash = ?1, role = 'admin', is_active = 1 WHERE id = ?2",
            params![hash, id],
        )
        .map_err(|err| err.to_string())?;
        id
    } else {
        tx.execute(
            "INSERT INTO users(login, password_hash, role, is_active) VALUES(?1, ?2, 'admin', 1)",
            params![normalized, hash],
        )
        .map_err(|err| err.to_string())?;
        tx.last_insert_rowid()
    };
    ensure_room_for_user_tx(&tx, user_id, &normalized)?;
    tx.commit().map_err(|err| err.to_string())
}

/// Create a user, room, settings and starter library as one transaction.
///
/// # Errors
/// Returns uniqueness, lock, SQL, room-allocation or post-commit lookup errors.
pub fn create_user_with_room(
    state: &AppState,
    login: &str,
    password_hash: &str,
) -> Result<UserRecord, String> {
    {
        let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        tx.execute(
            "INSERT INTO users(login, password_hash, role, is_active) VALUES(?1, ?2, 'user', 1)",
            params![login, password_hash],
        )
        .map_err(|err| err.to_string())?;
        let user_id = tx.last_insert_rowid();
        let room_id = ensure_room_for_user_tx(&tx, user_id, login)?;
        tx.execute(
            "INSERT OR IGNORE INTO room_tracks(room_id, asset_id, title)
            SELECT ?1, a.id, a.original_name FROM assets a
            JOIN prepared_defaults d ON d.asset_id = a.id WHERE a.kind = 'prepared'",
            params![room_id],
        )
        .map_err(|err| err.to_string())?;
        tx.commit().map_err(|err| err.to_string())?;
    }
    get_user_by_login(state, login)?.ok_or_else(|| "user missing".to_owned())
}

/// Look up an account and its room using the normalized, case-insensitive login.
///
/// # Errors
/// Returns lock, SQL or row-conversion errors; missing users return `None`.
pub fn get_user_by_login(state: &AppState, login: &str) -> Result<Option<UserRecord>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.query_row(
        "SELECT u.id, u.login, u.role, u.password_hash, u.is_active,
        r.id, r.slug, r.is_listed FROM users u JOIN rooms r ON r.owner_user_id = u.id
        WHERE u.login = ?1",
        params![login],
        user_from_row,
    )
    .optional()
    .map_err(|err| err.to_string())
}

/// Look up current account/role/room state by token or administrator-selected ID.
///
/// # Errors
/// Returns lock, SQL or row-conversion errors; missing users return `None`.
pub fn get_user_by_id(state: &AppState, user_id: i64) -> Result<Option<UserRecord>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.query_row(
        "SELECT u.id, u.login, u.role, u.password_hash, u.is_active,
        r.id, r.slug, r.is_listed FROM users u JOIN rooms r ON r.owner_user_id = u.id
        WHERE u.id = ?1",
        params![user_id],
        user_from_row,
    )
    .optional()
    .map_err(|err| err.to_string())
}

/// Decode the shared account/room projection used by authentication lookups.
///
/// # Errors
/// Returns SQLite type/column conversion errors.
fn user_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserRecord> {
    Ok(UserRecord {
        id: row.get(0)?,
        login: row.get(1)?,
        role: row.get(2)?,
        password_hash: row.get(3)?,
        is_active: row.get::<_, i64>(4)? != 0,
        room_id: row.get(5)?,
        room_slug: row.get(6)?,
        room_listed: row.get::<_, i64>(7)? != 0,
    })
}

/// List non-secret account/room summaries, newest first.
///
/// # Errors
/// Returns lock, SQL or row-conversion errors.
pub fn list_admin_users(state: &AppState) -> Result<Vec<AdminUserRow>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let mut stmt = conn
        .prepare(
            "SELECT u.id, u.login, u.role, r.slug, r.is_listed, u.created_at
        FROM users u JOIN rooms r ON r.owner_user_id = u.id ORDER BY u.created_at DESC",
        )
        .map_err(|err| err.to_string())?;
    stmt.query_map([], |row| {
        Ok(AdminUserRow {
            id: row.get(0)?,
            login: row.get(1)?,
            role: row.get(2)?,
            room_slug: row.get(3)?,
            room_listed: row.get::<_, i64>(4)? != 0,
            created_at: row.get(5)?,
        })
    })
    .map_err(|err| err.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|err| err.to_string())
}

/// Replace a password hash and reactivate the account, preserving existing admin behavior.
///
/// # Errors
/// Returns lock or SQL errors; `false` means no account matched.
pub fn reset_user_password(
    state: &AppState,
    user_id: i64,
    password_hash: &str,
) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.execute(
        "UPDATE users SET password_hash = ?1, is_active = 1 WHERE id = ?2",
        params![password_hash, user_id],
    )
    .map(|changed| changed > 0)
    .map_err(|err| err.to_string())
}

/// Delete an account and collect only its owned upload keys for post-commit cleanup.
/// Foreign-key cascades remove room data; prepared assets remain shared.
///
/// # Errors
/// Returns lock, SQL or commit errors. Missing users return an empty key list.
pub fn delete_user_and_collect_assets(
    state: &AppState,
    user_id: i64,
) -> Result<Vec<String>, String> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let room_id: Option<i64> = tx
        .query_row(
            "SELECT id FROM rooms WHERE owner_user_id = ?1",
            params![user_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let keys = if let Some(room_id) = room_id {
        crate::api::conference::queue_room_cleanup(&tx, room_id)?;
        let mut stmt = tx
            .prepare(
                "SELECT storage_key FROM assets WHERE owner_room_id = ?1 AND kind = 'room_upload'",
            )
            .map_err(|err| err.to_string())?;
        stmt.query_map(params![room_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    } else {
        Vec::new()
    };
    tx.execute("DELETE FROM users WHERE id = ?1", params![user_id])
        .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(keys)
}
