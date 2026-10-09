//! Authoritative room settings persistence and pure validation policies.

use crate::api::AppState;
use rusqlite::{OptionalExtension, params};

/// Settings loaded from the room's persisted row, not client-local playback state.
#[derive(Debug, Clone)]
pub struct RoomSettings {
    /// Stored Studio theme identifier.
    pub theme: String,
    /// Whether automatic playback repeats the current track.
    pub repeat_one: bool,
    /// Audible surface: Studio or conference.
    pub music_output: String,
    /// Meeting-wide gain before per-listener volume, in the finite unit interval.
    pub conference_music_volume: f64,
}

/// Load one room's settings and reject invalid persisted output/gain values.
///
/// # Errors
/// Returns lock, SQL, missing-row, conversion or validation errors.
pub fn load(state: &AppState, room_id: i64) -> Result<RoomSettings, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let settings = conn
        .query_row(
            "SELECT theme, repeat_one, music_output, conference_music_volume
             FROM room_settings WHERE room_id = ?1",
            params![room_id],
            |row| {
                Ok(RoomSettings {
                    theme: row.get(0)?,
                    repeat_one: row.get::<_, i64>(1)? != 0,
                    music_output: row.get(2)?,
                    conference_music_volume: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or("room settings missing")?;
    validate_output(&settings.music_output)?;
    validate_volume(settings.conference_music_volume)?;
    Ok(settings)
}

/// Persist finite meeting-wide gain before per-listener volume.
///
/// # Errors
/// Returns invalid-gain, lock, SQL or missing-row errors.
pub fn set_conference_music_volume(
    state: &AppState,
    room_id: i64,
    volume: f64,
) -> Result<(), String> {
    validate_volume(volume)?;
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    ensure_updated(conn.execute(
        "UPDATE room_settings SET conference_music_volume = ?1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?2",
        params![volume, room_id]).map_err(|err| err.to_string())?)
}

/// Persist the supported client surface that owns audible room music.
///
/// # Errors
/// Returns invalid-output, lock, SQL or missing-row errors.
pub fn set_music_output(state: &AppState, room_id: i64, output: &str) -> Result<(), String> {
    validate_output(output)?;
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    ensure_updated(conn.execute(
        "UPDATE room_settings SET music_output = ?1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?2",
        params![output, room_id]).map_err(|err| err.to_string())?)
}

/// Persist the caller-validated theme, rejecting a missing room instead of succeeding.
///
/// # Errors
/// Returns lock, SQL or missing-row errors.
pub fn set_room_theme(state: &AppState, room_id: i64, theme: &str) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    ensure_updated(conn.execute("UPDATE room_settings SET theme = ?1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?2",
        params![theme, room_id]).map_err(|err| err.to_string())?)
}

/// Persist the repeat flag, rejecting a missing room instead of succeeding.
///
/// # Errors
/// Returns lock, SQL or missing-row errors.
pub fn set_room_repeat(state: &AppState, room_id: i64, repeat_one: bool) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    ensure_updated(conn.execute("UPDATE room_settings SET repeat_one = ?1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?2",
        params![i64::from(repeat_one), room_id]).map_err(|err| err.to_string())?)
}

/// Validate a finite meeting gain in the inclusive unit interval.
///
/// # Errors
/// Returns the existing invalid-gain message for out-of-range/non-finite values.
fn validate_volume(volume: f64) -> Result<(), String> {
    if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
        return Err("invalid conference music volume".into());
    }
    Ok(())
}

/// Validate the fixed room output vocabulary.
///
/// # Errors
/// Returns the existing invalid-output message for unknown surfaces.
fn validate_output(output: &str) -> Result<(), String> {
    if !matches!(output, "studio" | "conference") {
        return Err("invalid music output".into());
    }
    Ok(())
}

/// Require a persisted row to have matched the mutation.
///
/// # Errors
/// Returns `room settings missing` for zero affected rows.
fn ensure_updated(changed: usize) -> Result<(), String> {
    if changed == 0 {
        return Err("room settings missing".into());
    }
    Ok(())
}

/// Pure settings decisions, independent of SQLite fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Finite boundaries and both non-finite/out-of-range branches are covered.
    #[test]
    fn volume_cases() {
        for (value, expected) in [
            (0.0, true),
            (1.0, true),
            (0.5, true),
            (-0.1, false),
            (1.1, false),
            (f64::NAN, false),
            (f64::INFINITY, false),
            (f64::NEG_INFINITY, false),
        ] {
            assert_eq!(validate_volume(value).is_ok(), expected, "{value}");
        }
    }

    /// Output vocabulary and missing-row errors have explicit table coverage.
    #[test]
    fn output_and_update_cases() {
        for (output, expected) in [
            ("studio", true),
            ("conference", true),
            ("", false),
            ("Studio", false),
            ("other", false),
        ] {
            assert_eq!(validate_output(output).is_ok(), expected, "{output:?}");
        }
        for (count, expected) in [(0, false), (1, true), (usize::MAX, true)] {
            assert_eq!(ensure_updated(count).is_ok(), expected, "{count}");
        }
    }
}
