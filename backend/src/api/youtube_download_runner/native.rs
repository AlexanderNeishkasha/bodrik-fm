//! Restricted downloader invocation and bounded, owned native output supervision.

use crate::api::{
    AppState, blocking,
    youtube::{
        self,
        policy::{self, Metadata},
    },
    youtube_jobs,
};
use std::{env, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time,
};

/// Maximum metadata JSON capture; native stderr is never retained or logged.
const METADATA_LIMIT: u32 = 4 * 1024 * 1024;
/// Maximum buffered stdout line, regardless of missing newline delimiters.
const LINE_LIMIT: usize = 16 * 1024;

/// Build a noninteractive YouTube-only command, ignoring external downloader configuration.
fn command() -> Command {
    let program = env::var("YTDLP_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "yt-dlp".into());
    let mut command = Command::new(program);
    command
        .args([
            "--ignore-config",
            "--use-extractors",
            "youtube.*",
            "--js-runtimes",
            "quickjs",
            "--no-playlist",
        ])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(path) = env::var("YTDLP_COOKIES_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        command.arg("--cookies").arg(path);
    }
    command
}

/// Capture capped metadata under a 45-second deadline and explicitly reap failed children.
///
/// # Errors
/// Returns sanitized spawn/read/limit/exit/timeout/JSON errors; no raw stderr or URLs.
pub(crate) async fn fetch_metadata(url: &str) -> Result<Metadata, String> {
    let mut child = command()
        .args([
            "--dump-single-json",
            "--skip-download",
            "--no-progress",
            "--",
        ])
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "metadata downloader could not start")?;
    let stdout = child.stdout.take().ok_or("metadata stdout missing")?;
    let mut bytes = Vec::new();
    let outcome = time::timeout(Duration::from_secs(45), async {
        stdout
            .take(u64::from(METADATA_LIMIT) + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "metadata read failed")?;
        if bytes.len() > usize::try_from(METADATA_LIMIT).map_err(|_| "metadata limit invalid")? {
            return Err("metadata output exceeded limit");
        }
        let status = child.wait().await.map_err(|_| "metadata wait failed")?;
        if !status.success() {
            return Err("metadata downloader exited unsuccessfully");
        }
        Ok(())
    })
    .await;
    let error = match outcome {
        Ok(Ok(())) => {
            return serde_json::from_slice(&bytes).map_err(|_| "metadata JSON invalid".into());
        }
        Ok(Err(error)) => error,
        Err(_) => "metadata timed out",
    };
    if child.kill().await.is_err() {
        tracing::warn!("metadata downloader reap failed");
    }
    Err(error.into())
}

/// Download one source without asking yt-dlp to spawn an unsupervised ffmpeg conversion.
///
/// # Errors
/// Returns bounded-stream/progress persistence/spawn/exit/timeout errors.
pub(super) async fn download(
    state: &AppState,
    id: &str,
    room: i64,
    url: &str,
    work: &std::path::Path,
) -> Result<(), String> {
    let mut child = command()
        .args([
            "--newline",
            "--progress",
            "--progress-template",
            "download:[download] %(progress._percent_str)s",
            "-f",
            "bestaudio/best",
            "-o",
        ])
        .arg(work.join("source.%(ext)s"))
        .arg("--")
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "download process could not start")?;
    let stdout = child.stdout.take().ok_or("download stdout missing")?;
    let stderr = child.stderr.take().ok_or("download stderr missing")?;
    let result = time::timeout(Duration::from_secs(30 * 60), async {
        tokio::try_join!(progress(stdout, state, id, room), discard(stderr), async {
            let status = child
                .wait()
                .await
                .map_err(|_| "download wait failed".to_owned())?;
            if !status.success() {
                return Err("download process exited unsuccessfully".into());
            }
            Ok(())
        })?;
        Ok::<_, String>(())
    })
    .await;
    let error = match result {
        Ok(Ok(())) => return Ok(()),
        Ok(Err(error)) => error,
        Err(_) => "download timed out".into(),
    };
    if child.kill().await.is_err() {
        tracing::warn!("download process reap failed");
    }
    Err(error)
}

/// Drain diagnostics in bounded memory without retaining potentially sensitive native text.
///
/// # Errors
/// Returns a sanitized stream-read error.
async fn discard(mut reader: impl AsyncRead + Unpin) -> Result<(), String> {
    let mut buffer = [0; 8192];
    while reader
        .read(&mut buffer)
        .await
        .map_err(|_| "downloader diagnostic read failed")?
        != 0
    {}
    Ok(())
}

/// Parse bounded stdout lines without detached readers or uncapped read-until allocations.
///
/// # Errors
/// Returns line-limit, read or job-progress persistence errors.
async fn progress(
    mut reader: impl AsyncRead + Unpin,
    state: &AppState,
    id: &str,
    room: i64,
) -> Result<(), String> {
    let mut buffer = [0; 8192];
    let mut line = Vec::new();
    let mut last = 0.0;
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| "download progress read failed")?;
        if count == 0 {
            break;
        }
        for byte in &buffer[..count] {
            if *byte == b'\n' || *byte == b'\r' {
                apply_line(&line, state, id, room, &mut last).await?;
                line.clear();
            } else {
                if !line_fits(line.len()) {
                    return Err("download progress line exceeded limit".into());
                }
                line.push(*byte);
            }
        }
    }
    apply_line(&line, state, id, room, &mut last).await
}

/// Persist meaningful progress increments before notifying clients; invalid text is ignored.
///
/// # Errors
/// Returns SQL/worker failures rather than silently claiming successful progress.
async fn apply_line(
    line: &[u8],
    state: &AppState,
    id: &str,
    room: i64,
    last: &mut f64,
) -> Result<(), String> {
    let Some(percent) = std::str::from_utf8(line).ok().and_then(policy::percent) else {
        return Ok(());
    };
    let next = 0.08 + percent * 0.62;
    if next - *last < 0.02 && next < 0.7 {
        return Ok(());
    }
    let state_for_db = state.clone();
    let job = id.to_owned();
    blocking::db_task(move || {
        youtube_jobs::update_progress(&state_for_db, &job, "downloading", "downloading", next)
    })
    .await?;
    *last = next;
    youtube::notify_room(state, room, false).await;
    Ok(())
}

/// Enforce the byte bound before appending to a line buffer.
fn line_fits(size: usize) -> bool {
    size < LINE_LIMIT
}

/// Pure stream-budget decisions, without native execution.
#[cfg(test)]
mod tests {
    use super::*;

    /// Both sides of the cap prevent unbounded unterminated native lines.
    #[test]
    fn line_limit_cases() {
        for (size, valid) in [
            (0, true),
            (LINE_LIMIT - 1, true),
            (LINE_LIMIT, false),
            (usize::MAX, false),
        ] {
            assert_eq!(line_fits(size), valid);
        }
    }
}
