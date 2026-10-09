//! Authoritative conference lookup and transactional revocation/cleanup mapping.

use super::cleanup;
use crate::api::AppState;
use rusqlite::{Connection, OptionalExtension, params};

/// Current provider-neutral conference state, including its private binding and generation.
#[derive(Debug, Clone)]
pub struct Conference {
    /// Administrator entitlement.
    pub allowed: bool,
    /// Owner enablement, not sufficient without entitlement.
    pub enabled: bool,
    /// Current private provider target.
    pub provider_room_id: Option<String>,
    /// Current public invitation slug.
    pub room_slug: String,
    /// Persisted adapter key; absent for unconfigured rooms.
    pub provider: Option<String>,
    /// Authoritative application room identity.
    pub room_id: i64,
    /// Revocation generation, checked before incrementing.
    pub generation: i64,
}

/// Shared projection; callers supply only fixed predicates with bound parameters.
const PROJECTION: &str = "SELECT COALESCE(c.allowed, 0), COALESCE(c.enabled, 0), c.provider_room_id,
    r.slug, c.provider, r.id, COALESCE(c.generation, 0) FROM rooms r LEFT JOIN room_conferences c ON c.room_id = r.id";

/// Decode authoritative values from a shared lookup projection.
///
/// # Errors
/// Returns SQLite column/type conversion errors.
fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Conference> {
    Ok(Conference {
        allowed: row.get::<_, i64>(0)? != 0,
        enabled: row.get::<_, i64>(1)? != 0,
        provider_room_id: row.get(2)?,
        room_slug: row.get(3)?,
        provider: row.get(4)?,
        room_id: row.get(5)?,
        generation: row.get(6)?,
    })
}

/// Query a fixed internal predicate without interpolating request values.
///
/// # Errors
/// Returns lock, SQL or row conversion errors; absence remains `None`.
fn query(
    state: &AppState,
    predicate: &str,
    value: &dyn rusqlite::ToSql,
) -> Result<Option<Conference>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.query_row(
        &format!("{PROJECTION} WHERE {predicate}"),
        [value],
        from_row,
    )
    .optional()
    .map_err(|err| err.to_string())
}

/// Load current slug state, including default-disabled rooms.
///
/// # Errors
/// Returns lock, SQL or conversion errors.
pub fn by_slug(state: &AppState, slug: &str) -> Result<Option<Conference>, String> {
    query(state, "r.slug = ?1", &slug)
}

/// Load the current private provider mapping without manufacturing an identity.
///
/// # Errors
/// Returns lock, SQL or conversion failures; retired mappings remain absent.
pub fn by_provider_id(state: &AppState, id: &str) -> Result<Option<Conference>, String> {
    query(state, "c.provider_room_id = ?1", &id)
}

/// Load authoritative state by room identity.
///
/// # Errors
/// Returns lock, SQL or conversion errors.
pub fn by_room_id(state: &AppState, room: i64) -> Result<Option<Conference>, String> {
    query(state, "r.id = ?1", &room)
}

/// Load state for the effective account's owned room.
///
/// # Errors
/// Returns lock, SQL or conversion errors.
pub fn by_user_id(state: &AppState, user: i64) -> Result<Option<Conference>, String> {
    query(state, "r.owner_user_id = ?1", &user)
}

/// Resolve the owned room without manufacturing a default identity.
///
/// # Errors
/// Returns lookup errors; missing accounts/rooms return `None`.
pub fn room_id_by_user_id(state: &AppState, user: i64) -> Result<Option<i64>, String> {
    Ok(by_user_id(state, user)?.map(|value| value.room_id))
}

/// Read entitlement independently of provider availability.
///
/// # Errors
/// Returns lookup errors; missing accounts/rooms return `None`.
pub fn allowed_by_user_id(state: &AppState, user: i64) -> Result<Option<bool>, String> {
    Ok(by_user_id(state, user)?.map(|value| value.allowed))
}

/// Resolve only an enabled mapping belonging to the configured provider.
///
/// # Errors
/// Returns lock, SQL or conversion errors; unavailable/wrong providers don't resolve.
pub fn room_id_by_provider_id(state: &AppState, id: &str) -> Result<Option<i64>, String> {
    let Some(provider) = state.conference_provider.as_deref() else {
        return Ok(None);
    };
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.query_row(
        "SELECT room_id FROM room_conferences WHERE provider_room_id = ?1 AND provider = ?2
        AND allowed = 1 AND enabled = 1",
        params![id, provider.key()],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

/// Load state inside the caller's mutation transaction.
///
/// # Errors
/// Returns SQL/conversion errors; missing rooms return `None`.
fn current(conn: &Connection, room: i64) -> Result<Option<Conference>, String> {
    conn.query_row(
        &format!("{PROJECTION} WHERE r.id = ?1"),
        params![room],
        from_row,
    )
    .optional()
    .map_err(|err| err.to_string())
}

/// Grant/revoke entitlement and retain the old active target before any rotation.
///
/// # Errors
/// Returns generation overflow, lock, SQL or commit errors; absent owners return false.
pub fn set_allowed_by_user_id(
    state: &AppState,
    user: i64,
    provider: Option<&str>,
    allowed: bool,
) -> Result<bool, String> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let room: Option<i64> = tx
        .query_row(
            "SELECT id FROM rooms WHERE owner_user_id = ?1",
            params![user],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some(room) = room else {
        return Ok(false);
    };
    let old = current(&tx, room)?.ok_or("room missing")?;
    if !allowed && old.provider.is_none() {
        return Ok(true);
    }
    if !allowed {
        cleanup::queue_current_tx(&tx, room)?;
    }
    let revoke = old.allowed && !allowed;
    let generation = next_generation(old.generation, revoke)?;
    let mapping = if revoke && old.provider_room_id.is_some() {
        Some(uuid::Uuid::new_v4().simple().to_string())
    } else {
        old.provider_room_id
    };
    let provider = old
        .provider
        .as_deref()
        .or(provider)
        .ok_or("conference provider unavailable")?;
    tx.execute("INSERT INTO room_conferences(room_id, provider, allowed, enabled, provider_room_id, generation)
        VALUES(?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(room_id) DO UPDATE SET allowed = excluded.allowed,
        enabled = excluded.enabled, provider_room_id = excluded.provider_room_id, generation = excluded.generation,
        updated_at = CURRENT_TIMESTAMP", params![room, provider, i64::from(allowed), i64::from(allowed && old.enabled), mapping, generation])
        .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(true)
}

/// Change owner enablement atomically; repeated disable retains queued old cleanup targets.
///
/// # Errors
/// Returns denied/missing-room, generation overflow, lock, SQL or commit errors.
pub fn set_enabled(state: &AppState, room: i64, enabled: bool) -> Result<Conference, String> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let mut old = current(&tx, room)?.ok_or("room missing")?;
    if !old.allowed || old.provider.is_none() {
        return Err("conference not allowed or room missing".into());
    }
    if !enabled {
        cleanup::queue_current_tx(&tx, room)?;
    }
    let revoke = old.enabled && !enabled;
    let generation = next_generation(old.generation, revoke)?;
    let mapping = if revoke || (enabled && old.provider_room_id.is_none()) {
        Some(uuid::Uuid::new_v4().simple().to_string())
    } else {
        old.provider_room_id
    };
    tx.execute(
        "UPDATE room_conferences SET enabled = ?1, provider_room_id = ?2, generation = ?3,
        updated_at = CURRENT_TIMESTAMP WHERE room_id = ?4",
        params![i64::from(enabled), mapping, generation, room],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    old.enabled = enabled;
    old.provider_room_id = mapping;
    old.generation = generation;
    Ok(old)
}

/// Increment only real revocations without SQLite's implicit integer-to-real overflow.
///
/// # Errors
/// Rejects corrupt negative or exhausted generation values.
fn next_generation(current: i64, revoke: bool) -> Result<i64, String> {
    if current < 0 {
        return Err("invalid conference generation".into());
    }
    if revoke {
        current
            .checked_add(1)
            .ok_or_else(|| "conference generation exhausted".into())
    } else {
        Ok(current)
    }
}

/// Pure generation decisions, not migration/SQL fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Unchanged/revoked/corrupt/exhausted values have explicit cases.
    #[test]
    fn generation_cases() {
        for (current, revoke, expected) in [
            (0, false, Some(0)),
            (0, true, Some(1)),
            (2, true, Some(3)),
            (i64::MAX, false, Some(i64::MAX)),
            (i64::MAX, true, None),
            (-1, false, None),
        ] {
            assert_eq!(next_generation(current, revoke).ok(), expected);
        }
    }
}
