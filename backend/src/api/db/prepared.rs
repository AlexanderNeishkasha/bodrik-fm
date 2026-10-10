//! Prepared-media registration and off-thread duration persistence.

use super::types::valid_duration;
use crate::api::{AppState, media, util};
use rusqlite::{OptionalExtension, params};
use std::fs;

/// Scan/register prepared files on a blocking worker before serving requests.
///
/// # Errors
/// Returns worker, directory-entry/metadata, lock or SQL errors.
pub async fn seed_prepared_assets(state: &AppState) -> Result<(), String> {
    let state = state.clone();
    tokio::task::spawn_blocking(move || seed(&state))
        .await
        .map_err(|err| format!("prepared assets task failed: {err}"))?
}

/// Register supported regular files; operational scan errors must not silently skip assets.
///
/// # Errors
/// Returns filesystem or prepared-asset transaction errors.
fn seed(state: &AppState) -> Result<(), String> {
    let entries =
        fs::read_dir(&state.media_dir).map_err(|err| format!("media scan failed: {err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("media entry read failed: {err}"))?;
        if !entry
            .file_type()
            .map_err(|err| format!("media entry type failed: {err}"))?
            .is_file()
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !util::is_allowed_file(&name) {
            continue;
        }
        if create_prepared_asset_if_missing(state, &name, prepared_asset_title(&name))? {
            tracing::info!("registered prepared track: {name}");
        }
    }
    Ok(())
}

/// Probe unknown durations asynchronously while all SQLite reads/writes run off-thread.
/// Missing files/unknown probes remain absent rather than inventing a duration.
///
/// # Errors
/// Returns worker, lock or SQL errors, preserving failed-probe absence.
pub async fn backfill_missing_durations(state: &AppState) -> Result<usize, String> {
    let db_state = state.clone();
    let targets = tokio::task::spawn_blocking(move || {
        let conn = db_state.db.lock().map_err(|_| "db lock poisoned")?;
        let mut stmt = conn
            .prepare("SELECT id, storage_key FROM assets WHERE duration_sec IS NULL")
            .map_err(|err| err.to_string())?;
        stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| format!("duration lookup task failed: {err}"))??;
    let mut updated = 0;
    for (id, storage_key) in targets {
        if !media::valid_storage_key(&storage_key) {
            tracing::warn!(asset_id = id, "invalid media probe key skipped");
            continue;
        }
        let path = media::media_path(state, &storage_key);
        if tokio::fs::metadata(&path).await.is_err() {
            continue;
        }
        let Some(duration) = media::probe_duration(&path).await else {
            continue;
        };
        if !valid_duration(Some(duration)) {
            tracing::warn!(asset_id = id, "invalid probed duration ignored");
            continue;
        }
        let db_state = state.clone();
        let changed = tokio::task::spawn_blocking(move || {
            let conn = db_state.db.lock().map_err(|_| "db lock poisoned")?;
            conn.execute(
                "UPDATE assets SET duration_sec = ?1 WHERE id = ?2 AND duration_sec IS NULL",
                params![duration, id],
            )
            .map_err(|err| err.to_string())
        })
        .await
        .map_err(|err| format!("duration update task failed: {err}"))??;
        if changed > 0 {
            updated += 1;
        }
    }
    Ok(updated)
}

/// Atomically insert a prepared asset and its optional starter-default association.
///
/// # Errors
/// Returns lock, SQL or commit errors; existing keys return `false`.
fn create_prepared_asset_if_missing(
    state: &AppState,
    storage_key: &str,
    title: &str,
) -> Result<bool, String> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let exists: Option<i64> = tx
        .query_row(
            "SELECT id FROM assets WHERE storage_key = ?1",
            params![storage_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if exists.is_some() {
        return Ok(false);
    }
    tx.execute("INSERT INTO assets(kind, owner_room_id, storage_key, original_name) VALUES('prepared', NULL, ?1, ?2)",
        params![storage_key, title]).map_err(|err| err.to_string())?;
    if is_prepared_default(title) {
        tx.execute(
            "INSERT OR IGNORE INTO prepared_defaults(asset_id) VALUES(?1)",
            params![tx.last_insert_rowid()],
        )
        .map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(true)
}

/// Match supported starter-track filenames by title base, independent of audio extension.
fn is_prepared_default(name: &str) -> bool {
    let Some((base, ext)) = util::split_name(name) else {
        return false;
    };
    util::is_allowed_ext(ext)
        && STARTER_PREPARED_TRACKS.iter().any(|(_, title)| {
            util::split_name(title).is_some_and(|(starter, _)| starter.trim() == base.trim())
        })
}

/// Map shipped storage UUIDs to readable starter titles; keep other filenames unchanged.
fn prepared_asset_title(storage_key: &str) -> &str {
    STARTER_PREPARED_TRACKS
        .iter()
        .find_map(|(key, title)| (*key == storage_key).then_some(*title))
        .unwrap_or(storage_key)
}

/// Original shipped asset keys, including both historical copies of each starter.
const STARTER_PREPARED_TRACKS: &[(&str, &str)] = &[
    (
        "58ca4614-3656-4d96-a113-f2f3ef0b904c.wav",
        "Silent Land Waltz.wav",
    ),
    (
        "cc40c724-e537-4a71-b12a-9aa6128d9b1a.wav",
        "Silent Land Waltz.wav",
    ),
    (
        "afdb12fb-83d7-46a7-a07c-fe6a3f6ccb66.wav",
        "The Forest Whispers.wav",
    ),
    (
        "a5e64412-aab5-4aa0-b4ff-f9eb471ded2f.wav",
        "The Forest Whispers.wav",
    ),
    (
        "bf414e88-a71a-4e86-baba-f2b2caa2e6a9.wav",
        "Winter Caprice.wav",
    ),
    (
        "f72f7a13-7b08-4773-a286-9e5bbedd7d11.wav",
        "Winter Caprice.wav",
    ),
];

/// Pure starter-selection coverage without directory/database fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Extension and base-name conditions distinguish starters from other media.
    #[test]
    fn starter_cases() {
        for (name, expected) in [
            ("Silent Land Waltz.wav", true),
            ("Winter Caprice.MP3", true),
            ("The Forest Whispers.flac", true),
            ("Silent Land Waltz.txt", false),
            ("Other.wav", false),
            ("Silent Land Waltz", false),
            (".wav", false),
            ("", false),
        ] {
            assert_eq!(is_prepared_default(name), expected, "{name}");
        }
        for (key, title) in STARTER_PREPARED_TRACKS {
            assert_eq!(prepared_asset_title(key), *title);
        }
        assert_eq!(prepared_asset_title("Other.wav"), "Other.wav");
    }
}
