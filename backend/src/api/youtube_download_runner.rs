//! Owned download lifecycle, room/account cancellation and atomic media/job completion.

mod native;
pub(crate) use native::fetch_metadata;

use crate::api::{
    AppState, blocking,
    media::{self, Artifacts},
    op_error::OpError,
    util,
    youtube::{self, policy},
    youtube_jobs,
};
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{process::Command, time};

/// Own a queued download permit, native work and terminal error persistence.
/// Room/job/account removal interrupts the pipeline; resources remain guarded until commit.
pub async fn run_download_job(state: AppState, id: String, room: i64, url: String, title: String) {
    youtube::notify_room(&state, room, false).await;
    let permit = tokio::select! {
        permit = state.youtube_download_limiter.clone().acquire_owned() => match permit {
            Ok(permit) => permit,
            Err(_) => {
                persist_error(&state, &id, room, &OpError::from("download queue stopped")).await;
                return;
            }
        },
        error = watch(&state, &id, room) => {
            persist_error(&state, &id, room, &OpError::Internal(error)).await;
            return;
        }
    };
    let outcome = tokio::select! {
        result = run_inner(&state, &id, room, &url, &title) => result,
        error = watch(&state, &id, room) => Err(OpError::Internal(error)),
    };
    if let Err(error) = outcome {
        tracing::warn!(job_id = %id, room_id = room, %error, "youtube job failed");
        persist_error(&state, &id, room, &error).await;
    }
    drop(permit);
}

/// Record only sanitized public failure classifications, reporting write failures too.
async fn persist_error(state: &AppState, id: &str, room: i64, error: &OpError) {
    let db_state = state.clone();
    let id = id.to_owned();
    let public = policy::public_error(error);
    if let Err(error) =
        blocking::db_task(move || youtube_jobs::mark_error(&db_state, &id, public)).await
    {
        tracing::warn!(%error, "youtube terminal error persistence failed (job may have been deleted)");
    }
    youtube::notify_room(state, room, false).await;
}

/// Poll durable ownership without holding locks over awaits or coupling to lossy room events.
async fn watch(state: &AppState, id: &str, room: i64) -> String {
    loop {
        time::sleep(Duration::from_secs(2)).await;
        let state = state.clone();
        let id = id.to_owned();
        match blocking::db_task(move || youtube_jobs::job_alive(&state, &id, room)).await {
            Ok(true) => {}
            Ok(false) => return "download job ownership ended".into(),
            Err(error) => return error,
        }
    }
}

/// Persist one forward progress stage before notifying subscribers.
///
/// # Errors
/// Returns missing/changed-job, worker or SQL errors.
async fn progress(
    state: &AppState,
    id: &str,
    room: i64,
    status: &'static str,
    stage: &'static str,
    value: f64,
) -> Result<(), String> {
    let db_state = state.clone();
    let job = id.to_owned();
    blocking::db_task(move || youtube_jobs::update_progress(&db_state, &job, status, stage, value))
        .await?;
    youtube::notify_room(state, room, false).await;
    Ok(())
}

/// Run all stages with artifact ownership transferred through native publication and SQL workers.
///
/// # Errors
/// Returns progress, staging, downloader/conversion, publication or atomic-completion errors.
async fn run_inner(
    state: &AppState,
    id: &str,
    room: i64,
    url: &str,
    title: &str,
) -> Result<(), OpError> {
    progress(state, id, room, "downloading", "downloading", 0.08).await?;
    let work = Path::new(&state.temp_upload_dir).join("youtube").join(id);
    let create = work.clone();
    let mut artifacts = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(
            create
                .parent()
                .ok_or_else(|| std::io::Error::other("work parent missing"))?,
        )?;
        std::fs::create_dir(&create)?;
        let mut guard = Artifacts::new();
        guard.directory(create);
        Ok::<_, std::io::Error>(guard)
    })
    .await
    .map_err(|_| "download staging task failed")?
    .map_err(|err| format!("download staging failed: {err}"))?;
    native::download(state, id, room, url, &work).await?;
    progress(state, id, room, "processing", "processing", 0.75).await?;
    let scan = work.clone();
    let source = blocking::db_task(move || find_source(&scan)).await?;
    let downloaded = if source.extension().and_then(|ext| ext.to_str()) == Some("m4a") {
        source
    } else {
        let converted = work.join("converted.m4a");
        let mut command = Command::new("ffmpeg");
        command
            .args([
                "-hide_banner",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
            ])
            .arg(source)
            .args(["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "256000"])
            .arg(&converted);
        media::ffmpeg(&mut command, Duration::from_secs(600)).await?;
        converted
    };
    let key = format!("{}.m4a", uuid::Uuid::new_v4());
    let destination = media::media_path(state, &key);
    let hls = media::hls_dir(state, &key);
    artifacts.file(destination.clone());
    artifacts.directory(hls.clone());
    let publish = destination.clone();
    let staging = publish.with_extension("download");
    artifacts.file(staging.clone());
    artifacts = tokio::task::spawn_blocking(move || {
        if let Err(error) = std::fs::rename(&downloaded, &publish) {
            if error.kind() != ErrorKind::CrossesDevices {
                return Err(error);
            }
            std::fs::copy(&downloaded, &staging)?;
            std::fs::rename(&staging, &publish)?;
        }
        Ok::<_, std::io::Error>(artifacts)
    })
    .await
    .map_err(|_| "download publication task failed")?
    .map_err(|err| format!("download publication failed: {err}"))?;
    progress(state, id, room, "processing", "hls", 0.86).await?;
    let duration = media::process_uploaded_file(state, &destination, &key).await;
    let db_state = state.clone();
    let id = id.to_owned();
    let title = title.to_owned();
    blocking::op_task(move || {
        youtube_jobs::complete_job(&db_state, &id, room, &key, &title, duration)?;
        artifacts.keep(&destination);
        artifacts.keep(&hls);
        Ok(())
    })
    .await?;
    youtube::notify_room(state, room, true).await;
    Ok(())
}

/// Select one regular supported downloader output, never arbitrary directories or symlinks.
///
/// # Errors
/// Returns scan, missing or ambiguous source errors.
fn find_source(work: &Path) -> Result<PathBuf, String> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(work).map_err(|err| format!("download scan failed: {err}"))? {
        let entry = entry.map_err(|err| format!("download entry failed: {err}"))?;
        let name = entry.file_name();
        let name = name.to_str().ok_or("download filename invalid")?;
        if source_name(name) && entry.file_type().map_err(|err| err.to_string())?.is_file() {
            files.push(entry.path());
        }
    }
    if files.len() != 1 {
        return Err("download source missing or ambiguous".into());
    }
    files.pop().ok_or_else(|| "download source missing".into())
}

/// Recognize source output only, excluding partial/download diagnostics and conversion outputs.
fn source_name(name: &str) -> bool {
    util::split_name(name).is_some_and(|(base, ext)| {
        base == "source" && (util::is_allowed_ext(ext) || matches!(ext, "3gp" | "ts"))
    })
}

/// Pure filename recognition, with no files or subprocesses.
#[cfg(test)]
mod tests {
    use super::*;

    /// Supported source formats and unfinished/unrelated names have distinct decisions.
    #[test]
    fn source_cases() {
        for (name, valid) in [
            ("source.m4a", true),
            ("source.webm", true),
            ("source.opus", true),
            ("source.3gp", true),
            ("source.ts", true),
            ("source.m4a.part", false),
            ("source.info.json", false),
            ("converted.m4a", false),
            ("source.", false),
        ] {
            assert_eq!(source_name(name), valid);
        }
    }
}
