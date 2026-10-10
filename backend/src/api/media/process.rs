//! Bounded native media processes with explicit timeout/exit and cancellation ownership.

use super::Artifacts;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, time};

/// Offline preparation may not launch unbounded encoders beside real-time meeting playback.
static PREPARATION: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// Maximum optional HLS generation duration before original-file fallback.
pub(super) const HLS_TIMEOUT: Duration = Duration::from_secs(600);
/// Short-lived metadata probe budget.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Probe output is one duration, never an unbounded native stdout stream.
const PROBE_OUTPUT_LIMIT: u16 = 4096;

/// Run ffmpeg without inherited stdin/output buffers and reap it on timeout.
/// Cancellation drops the child with kill-on-drop enabled.
///
/// # Errors
/// Returns contextual spawn/wait, unsuccessful-exit or timeout errors.
pub(crate) async fn ffmpeg(command: &mut Command, timeout: Duration) -> Result<(), String> {
    let _permit = PREPARATION
        .acquire()
        .await
        .map_err(|_| "media preparation unavailable")?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|err| format!("ffmpeg spawn failed: {err}"))?;
    match time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!("ffmpeg exited with {status}")),
        Ok(Err(error)) => {
            if let Err(kill) = child.kill().await {
                tracing::warn!(%kill, "ffmpeg reap after wait failure failed");
            }
            Err(format!("ffmpeg wait failed: {error}"))
        }
        Err(_) => {
            if let Err(error) = child.kill().await {
                tracing::warn!(%error, "ffmpeg reap after timeout failed");
            }
            Err("ffmpeg timed out".into())
        }
    }
}

/// Relocate MP4-family metadata using a guarded temporary file; failures retain the original.
pub(super) async fn faststart(path: &Path, filename: &str) {
    let Some((_, ext)) = crate::api::util::split_name(filename) else {
        return;
    };
    let ext = ext.to_ascii_lowercase();
    if !matches!(ext.as_str(), "m4a" | "mp4" | "mov") {
        return;
    }
    let input = match tokio::fs::canonicalize(path).await {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!(%error, "faststart input unavailable");
            return;
        }
    };
    // A directory cannot be mistaken for a prepared asset if the process is interrupted.
    let staging = input.with_file_name(format!(".{}.faststart", uuid::Uuid::new_v4()));
    let temporary = staging.join(format!("media.{ext}"));
    let artifacts = match tokio::task::spawn_blocking(move || {
        std::fs::create_dir(&staging)?;
        let mut guard = Artifacts::new();
        guard.directory(staging);
        Ok::<_, std::io::Error>(guard)
    })
    .await
    {
        Ok(Ok(guard)) => guard,
        Ok(Err(error)) => {
            tracing::warn!(%error, "faststart staging failed");
            return;
        }
        Err(error) => {
            tracing::warn!(%error, "faststart staging task failed");
            return;
        }
    };
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
        .arg(&input)
        .args(["-c", "copy", "-movflags", "+faststart"])
        .arg(&temporary);
    if let Err(error) = ffmpeg(&mut command, Duration::from_secs(120)).await {
        tracing::warn!(%error, "faststart failed; retaining original media");
        return;
    }
    // Keep staging owned until the native publication itself has completed.
    match tokio::task::spawn_blocking(move || {
        let _artifacts = artifacts;
        std::fs::rename(temporary, input)
    })
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::warn!(%error, "faststart publication failed; retaining original media")
        }
        Err(error) => {
            tracing::warn!(%error, "faststart publication task failed; retaining original media")
        }
    }
}

/// Probe a local canonical file, returning absence for unknown/invalid finite duration.
/// Native output is capped, network protocols are disabled, and failures are observable.
pub async fn probe_duration(path: &Path) -> Option<f64> {
    match probe(path).await {
        Ok(duration) => duration,
        Err(error) => {
            tracing::warn!(%error, "media duration probe failed");
            None
        }
    }
}

/// Supervise one ffprobe process without retaining unbounded stdout/stderr.
///
/// # Errors
/// Returns canonicalization/spawn/read/wait, output-limit, timeout or unsuccessful-exit errors.
async fn probe(path: &Path) -> Result<Option<f64>, String> {
    let input = tokio::fs::canonicalize(path)
        .await
        .map_err(|err| format!("probe input unavailable: {err}"))?;
    let mut child = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(input)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("ffprobe spawn failed: {err}"))?;
    let stdout = child.stdout.take().ok_or("ffprobe stdout pipe missing")?;
    let mut output = Vec::new();
    let result = time::timeout(PROBE_TIMEOUT, async {
        stdout
            .take(u64::from(PROBE_OUTPUT_LIMIT) + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|err| err.to_string())?;
        if output.len() > usize::from(PROBE_OUTPUT_LIMIT) {
            return Err("ffprobe output limit exceeded".into());
        }
        let status = child.wait().await.map_err(|err| err.to_string())?;
        if !status.success() {
            return Err(format!("ffprobe exited with {status}"));
        }
        Ok(())
    })
    .await;
    let error = match result {
        Ok(Ok(())) => return Ok(parse_duration(&String::from_utf8_lossy(&output))),
        Ok(Err(error)) => error,
        Err(_) => "ffprobe timed out".into(),
    };
    if let Err(error) = child.kill().await {
        tracing::warn!(%error, "ffprobe reap after failure failed");
    }
    Err(error)
}

/// Accept only finite nonnegative duration text; unknown metadata remains `None`.
fn parse_duration(text: &str) -> Option<f64> {
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

/// Pure probe-output validation, without launching native processes.
#[cfg(test)]
mod tests {
    use super::*;

    /// Unknown/malformed/non-finite/negative and finite boundaries have separate cases.
    #[test]
    fn duration_text_cases() {
        for (text, expected) in [
            ("0", Some(0.0)),
            (" 12.5\n", Some(12.5)),
            ("-1", None),
            ("NaN", None),
            ("inf", None),
            ("-inf", None),
            ("N/A", None),
            ("", None),
            ("invalid", None),
            ("1e309", None),
        ] {
            assert_eq!(parse_duration(text), expected);
        }
    }
}
