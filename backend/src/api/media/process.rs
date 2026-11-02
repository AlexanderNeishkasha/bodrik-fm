//! Bounded native media processes with explicit timeout/exit and cancellation ownership.

use super::Artifacts;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, time};

/// Offline preparation may not launch unbounded encoders beside real-time meeting playback.
static PREPARATION: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// Maximum optional HLS generation duration before original-file fallback.
pub(super) const HLS_TIMEOUT: Duration = Duration::from_secs(600);
/// Full-audio fallback scans share the bounded offline HLS preparation budget.
const PROBE_TIMEOUT: Duration = HLS_TIMEOUT;
/// Sparse initial/final progress reports must never retain unbounded native output.
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

/// Decode the first audio stream to measure playback length, never a bitrate estimate.
/// The scan shares preparation permits, caps output/time, disables network protocols,
/// writes no media file, and returns absence on failure or cancellation.
pub async fn probe_duration(path: &Path) -> Option<f64> {
    match probe(path).await {
        Ok(duration) => Some(duration),
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "media audio duration scan failed");
            None
        }
    }
}

/// Build a local audio-only null decode with sparse progress and bounded decoder threads.
///
/// # Errors
/// Returns canonicalization or supervised duration-scan errors.
async fn probe(path: &Path) -> Result<f64, String> {
    let input = tokio::fs::canonicalize(path)
        .await
        .map_err(|err| format!("duration input unavailable: {err}"))?;
    let mut command = Command::new("ffmpeg");
    command
        .args([
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-nostats",
            "-stats_period",
        ])
        .arg(PROBE_TIMEOUT.as_secs().to_string())
        .args([
            "-progress",
            "pipe:1",
            "-protocol_whitelist",
            "file,pipe",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-i",
        ])
        .arg(input)
        .args([
            "-map", "0:a:0", "-vn", "-sn", "-dn", "-threads", "1", "-f", "null", "-",
        ]);
    supervise_duration(&mut command, PROBE_TIMEOUT).await
}

/// Own one sparse progress child, retaining only bounded output and reaping every failure.
/// Waiting for a preparation permit does not consume the native execution timeout.
///
/// # Errors
/// Returns permit/spawn/read/wait, invalid-progress, output-limit, timeout or exit errors.
async fn supervise_duration(command: &mut Command, timeout: Duration) -> Result<f64, String> {
    let _permit = PREPARATION
        .acquire()
        .await
        .map_err(|_| "media preparation unavailable")?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("audio duration scan spawn failed: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("audio duration stdout pipe missing")?;
    let mut output = Vec::new();
    let result = time::timeout(timeout, async {
        stdout
            .take(u64::from(PROBE_OUTPUT_LIMIT) + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|err| err.to_string())?;
        if output.len() > usize::from(PROBE_OUTPUT_LIMIT) {
            return Err("audio duration output limit exceeded".into());
        }
        let status = child.wait().await.map_err(|err| err.to_string())?;
        if !status.success() {
            return Err(format!("audio duration scan exited with {status}"));
        }
        Ok(())
    })
    .await;
    let error = match result {
        Ok(Ok(())) => {
            return parse_progress(&String::from_utf8_lossy(&output))
                .ok_or_else(|| "audio duration scan lacks a positive completed duration".into());
        }
        Ok(Err(error)) => error,
        Err(_) => "audio duration scan timed out".into(),
    };
    if let Err(error) = child.kill().await {
        tracing::warn!(%error, "audio duration scan reap after failure failed");
    }
    Err(error)
}

/// Read positive microseconds only from the final completed FFmpeg progress block.
/// Partial reports, unknown/negative/overflowing clocks and empty audio remain absent.
fn parse_progress(text: &str) -> Option<f64> {
    let mut lines = text.trim_end().lines().rev();
    if lines.next()? != "progress=end" {
        return None;
    }
    for line in lines {
        if line.starts_with("progress=") {
            break;
        }
        if let Some(value) = line.strip_prefix("out_time_us=") {
            let microseconds = value.parse::<u64>().ok().filter(|value| *value > 0)?;
            return Some(Duration::from_micros(microseconds).as_secs_f64());
        }
    }
    None
}

/// Progress parsing plus bounded local-child supervision; no media fixtures or network.
#[cfg(test)]
mod tests {
    use super::*;

    /// Only a completed final block supplies a positive, valid microsecond clock.
    #[test]
    fn progress_cases() {
        for (name, text, expected) in [
            (
                "fractional",
                "out_time_us=247849796\nprogress=end\n",
                Some(247.849796),
            ),
            (
                "CRLF",
                "out_time_us=12500000\r\nprogress=end\r\n",
                Some(12.5),
            ),
            (
                "last block",
                "out_time_us=1\nprogress=continue\nout_time_us=5000000\nprogress=end\n",
                Some(5.0),
            ),
            ("empty", "", None),
            ("zero", "out_time_us=0\nprogress=end\n", None),
            ("negative", "out_time_us=-1\nprogress=end\n", None),
            ("NaN", "out_time_us=NaN\nprogress=end\n", None),
            ("infinite", "out_time_us=inf\nprogress=end\n", None),
            ("unknown", "out_time_us=N/A\nprogress=end\n", None),
            (
                "overflow",
                "out_time_us=18446744073709551616\nprogress=end\n",
                None,
            ),
            ("partial", "out_time_us=5000000\nprogress=continue\n", None),
            ("missing completion", "out_time_us=5000000\n", None),
            ("missing clock", "progress=end\n", None),
            (
                "previous clock only",
                "out_time_us=5000000\nprogress=continue\nprogress=end\n",
                None,
            ),
        ] {
            assert_eq!(parse_progress(text), expected, "{name}");
        }
    }

    /// Cancelling a running scan kills its only child and releases preparation ownership.
    #[tokio::test]
    async fn duration_child_cancellation() {
        let directory =
            std::env::temp_dir().join(format!("duration-cancel-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&directory)
            .await
            .expect("cancellation fixture");
        let mut artifacts = Artifacts::new();
        artifacts.directory(directory.clone());
        let pid_file = directory.join("child.pid");
        let child_pid_file = pid_file.clone();
        let task = tokio::spawn(async move {
            let mut command = Command::new("sh");
            command
                .args([
                    "-c",
                    "printf '%s' \"$$\" > \"$1\"; while :; do :; done",
                    "duration-fixture",
                ])
                .arg(child_pid_file);
            supervise_duration(&mut command, PROBE_TIMEOUT).await
        });
        let pid = time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(text) = tokio::fs::read_to_string(&pid_file).await
                    && let Ok(pid) = text.parse::<u32>()
                {
                    break pid;
                }
                time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        task.abort();
        assert!(
            task.await
                .expect_err("cancelled duration scan")
                .is_cancelled()
        );
        let pid = pid.expect("child started before cancellation").to_string();
        time::timeout(Duration::from_secs(5), async {
            loop {
                let status = Command::new("kill")
                    .args(["-0", &pid])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await
                    .expect("child liveness probe");
                if !status.success() {
                    break;
                }
                time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled child exited");
    }

    /// Spawn/exit/output/deadline failures must not turn partial progress into a duration.
    #[tokio::test]
    async fn duration_child_cases() {
        for (name, script, timeout, error) in [
            (
                "successful",
                "printf 'out_time_us=5000000\\nprogress=end\\n'",
                Duration::from_secs(5),
                None,
            ),
            (
                "failed exit",
                "printf 'out_time_us=5000000\\nprogress=end\\n'; exit 1",
                Duration::from_secs(5),
                Some("exited"),
            ),
            (
                "partial output",
                "printf 'out_time_us=5000000\\nprogress=continue\\n'",
                Duration::from_secs(5),
                Some("completed duration"),
            ),
            (
                "empty audio",
                "printf 'out_time_us=0\\nprogress=end\\n'",
                Duration::from_secs(5),
                Some("completed duration"),
            ),
            (
                "output cap",
                "printf '%5000s' x",
                Duration::from_secs(5),
                Some("output limit"),
            ),
            (
                "timeout",
                "while :; do :; done",
                Duration::from_millis(50),
                Some("timed out"),
            ),
        ] {
            let mut command = Command::new("sh");
            command.args(["-c", script]);
            let result = supervise_duration(&mut command, timeout).await;
            match error {
                Some(error) => assert!(result.expect_err(name).contains(error), "{name}"),
                None => assert!((result.expect(name) - 5.0).abs() < 1e-9, "{name}"),
            }
        }
        let mut unavailable = Command::new("/missing/bodrik-duration-test-program");
        assert!(
            supervise_duration(&mut unavailable, Duration::from_secs(5))
                .await
                .expect_err("missing executable")
                .contains("spawn failed")
        );
    }
}
