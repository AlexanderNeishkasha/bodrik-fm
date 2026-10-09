//! Room-scoped job persistence, atomic admission and track/job completion.

use crate::api::{AppState, db_v2, youtube_v2::policy};
use rusqlite::{Connection, OptionalExtension, params};

/// Non-secret Studio job summary; ready jobs are omitted from the visible list.
#[derive(Debug, Clone, serde::Serialize)]
pub struct YoutubeDownloadJob {
    /// Server-generated UUID.
    pub id: String,
    /// Human display title.
    pub title: String,
    /// Persisted state vocabulary.
    pub status: String,
    /// Current processing stage.
    pub stage: String,
    /// Finite progress in the unit interval.
    pub progress: f64,
    /// Sanitized browser-facing failure, never native stderr.
    pub error: Option<String>,
}

/// Validated admission data used only on a blocking worker.
pub struct CreateYoutubeJob<'a> {
    /// Generated job UUID.
    pub id: &'a str,
    /// Authorized effective room.
    pub room_id: i64,
    /// Authorized effective account.
    pub user_id: i64,
    /// Validated provider URL.
    pub url: &'a str,
    /// Optional provider identity from metadata.
    pub video_id: Option<&'a str>,
    /// Byte-bounded sanitized title.
    pub title: &'a str,
}

/// Mark interrupted nonterminal jobs as errors before accepting new work.
///
/// # Errors
/// Returns lock or SQL errors; startup must not ignore recovery failure.
pub fn reset_active_jobs(state: &AppState) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.execute(
        "UPDATE youtube_download_jobs SET status = 'error', stage = 'error', progress = 1,
        error = 'download interrupted', updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('queued', 'downloading', 'processing')",
        [],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Count queued/downloading/processing work, not completed or dismissed errors.
///
/// # Errors
/// Returns lock or SQL errors.
pub fn active_room_job_count(state: &AppState, room: i64) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    active_count(&conn, room)
}

/// Count active room work while the caller owns its admission transaction.
///
/// # Errors
/// Returns SQL/conversion errors.
fn active_count(conn: &Connection, room: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(1) FROM youtube_download_jobs WHERE room_id = ?1
        AND status IN ('queued', 'downloading', 'processing')",
        params![room],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

/// Atomically check room quota/title ownership and create the queued job.
///
/// # Errors
/// Returns download-busy/name-conflict, lock, SQL or commit errors.
pub fn create_job(state: &AppState, job: CreateYoutubeJob<'_>) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    if !policy::can_admit(active_count(&tx, job.room_id)?) {
        return Err("download busy".into());
    }
    let exists: Option<i64> = tx
        .query_row(
            "SELECT id FROM room_tracks WHERE room_id = ?1 AND lower(title) = lower(?2)",
            params![job.room_id, job.title],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if exists.is_some() {
        return Err("name exists".into());
    }
    tx.execute("INSERT INTO youtube_download_jobs(id, room_id, user_id, url, video_id, title, status, stage, progress)
        VALUES(?1, ?2, ?3, ?4, ?5, ?6, 'queued', 'queued', 0.05)",
        params![job.id, job.room_id, job.user_id, job.url, job.video_id, job.title]).map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())
}

/// List visible room jobs, rejecting corrupt progress rather than serializing NaN/null.
///
/// # Errors
/// Returns lock, SQL/conversion or invalid-progress errors.
pub fn list_room_jobs(state: &AppState, room: i64) -> Result<Vec<YoutubeDownloadJob>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, status, stage, progress, error FROM youtube_download_jobs
        WHERE room_id = ?1 AND status != 'ready' ORDER BY created_at ASC, id ASC",
        )
        .map_err(|err| err.to_string())?;
    let jobs = stmt
        .query_map(params![room], |row| {
            Ok(YoutubeDownloadJob {
                id: row.get(0)?,
                title: row.get(1)?,
                status: row.get(2)?,
                stage: row.get(3)?,
                progress: row.get(4)?,
                error: row.get(5)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    if jobs
        .iter()
        .any(|job| !job.progress.is_finite() || !(0.0..=1.0).contains(&job.progress))
    {
        return Err("invalid stored job progress".into());
    }
    Ok(jobs)
}

/// Update only a supported forward/repeated nonterminal state/stage with finite progress.
///
/// # Errors
/// Returns invalid-progress/transition, missing-job, lock or SQL errors.
pub fn update_progress(
    state: &AppState,
    id: &str,
    status: &str,
    stage: &str,
    progress: f64,
) -> Result<(), String> {
    if !policy::valid_progress(status, stage, progress) {
        return Err("invalid job progress".into());
    }
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let previous = status_of(&conn, id)?;
    if !policy::transition(&previous, status) {
        return Err("invalid job transition".into());
    }
    require_changed(
        conn.execute(
            "UPDATE youtube_download_jobs SET status = ?1, stage = ?2, progress = ?3,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?4 AND status = ?5",
            params![status, stage, progress, id, previous],
        )
        .map_err(|err| err.to_string())?,
    )
}

/// Mark a nonterminal job failed without overwriting ready/error work.
///
/// # Errors
/// Returns missing/terminal-job, lock or SQL errors.
pub fn mark_error(state: &AppState, id: &str, error: &str) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let previous = status_of(&conn, id)?;
    if !policy::transition(&previous, "error") {
        return Err("invalid job transition".into());
    }
    require_changed(
        conn.execute(
            "UPDATE youtube_download_jobs SET status = 'error', stage = 'error', progress = 1,
        error = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND status = ?3",
            params![policy::public_error(error), id, previous],
        )
        .map_err(|err| err.to_string())?,
    )
}

/// Insert the downloaded track and commit its job's ready state as one transaction.
///
/// # Errors
/// Returns missing/incorrect job state/ownership, lock, track insert or commit errors.
pub fn complete_job(
    state: &AppState,
    id: &str,
    room: i64,
    key: &str,
    title: &str,
    duration: Option<f64>,
) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let owner: Option<i64> = tx
        .query_row(
            "SELECT room_id FROM youtube_download_jobs WHERE id = ?1 AND status = 'processing'",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if owner != Some(room) {
        return Err("job missing or not processing".into());
    }
    db_v2::insert_upload_track_tx(&tx, room, key, title, duration)?;
    require_changed(tx.execute("UPDATE youtube_download_jobs SET status = 'ready', stage = 'ready', progress = 1,
        error = NULL, storage_key = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND room_id = ?3 AND status = 'processing'",
        params![key, id, room]).map_err(|err| err.to_string())?)?;
    tx.commit().map_err(|err| err.to_string())
}

/// Dismiss only an error belonging to the authorized room.
///
/// # Errors
/// Returns lock or SQL errors; missing/active/other-room jobs return false.
pub fn delete_error_job(state: &AppState, room: i64, id: &str) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.execute(
        "DELETE FROM youtube_download_jobs WHERE room_id = ?1 AND id = ?2 AND status = 'error'",
        params![room, id],
    )
    .map(|changed| changed > 0)
    .map_err(|err| err.to_string())
}

/// Check durable job/room/account liveness, including the brief ready-notification window.
///
/// # Errors
/// Returns lock or SQL errors; deleted/failed/inactive ownership returns false.
pub fn job_alive(state: &AppState, id: &str, room: i64) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM youtube_download_jobs j JOIN users u ON u.id = j.user_id
        JOIN rooms r ON r.id = j.room_id AND r.owner_user_id = u.id
        WHERE j.id = ?1 AND j.room_id = ?2 AND j.status != 'error' AND u.is_active = 1)",
        params![id, room],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

/// Load a job state while the caller owns the connection lock.
///
/// # Errors
/// Returns missing-job, SQL or row-conversion errors.
fn status_of(conn: &Connection, id: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT status FROM youtube_download_jobs WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| err.to_string())?
    .ok_or_else(|| "job missing".into())
}

/// Detect concurrent terminal/deletion changes instead of default-success updates.
///
/// # Errors
/// Returns an error when no expected job matched the mutation.
fn require_changed(rows: usize) -> Result<(), String> {
    if rows == 0 {
        return Err("job state changed or missing".into());
    }
    Ok(())
}
