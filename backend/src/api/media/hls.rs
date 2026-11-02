//! Complete VOD cache generation/publication; optional failures preserve original playback.

use super::{
    Artifacts, process,
    storage::{hls_dir, valid_storage_key},
};
use crate::api::{AppState, util};
use std::{io::ErrorKind, path::Path};
use tokio::process::Command;

/// Generate an optional cache in an owned staging directory, then publish only complete VOD.
pub(super) async fn generate(state: &AppState, path: &Path, key: &str) {
    if !valid_storage_key(key) {
        tracing::warn!("invalid HLS storage key rejected");
        return;
    }
    let Some((_, ext)) = util::split_name(key) else {
        return;
    };
    if !util::is_allowed_ext(ext) {
        return;
    }
    let destination = hls_dir(state, key);
    if ready(&destination).await {
        return;
    }
    let input = match tokio::fs::canonicalize(path).await {
        Ok(input) => input,
        Err(error) => {
            tracing::warn!(%error, "HLS input unavailable; using original");
            return;
        }
    };
    let parent = std::path::Path::new(&state.media_dir).join("hls");
    let staging = parent.join(format!(".{}.processing", uuid::Uuid::new_v4()));
    let create_path = staging.clone();
    let artifacts = match tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(parent)?;
        std::fs::create_dir(&create_path)?;
        let mut guard = Artifacts::new();
        guard.directory(create_path);
        Ok::<_, std::io::Error>(guard)
    })
    .await
    {
        Ok(Ok(guard)) => guard,
        Ok(Err(error)) => {
            tracing::warn!(%error, "HLS staging failed; using original");
            return;
        }
        Err(error) => {
            tracing::warn!(%error, "HLS staging task failed; using original");
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
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-f",
            "hls",
            "-hls_time",
            "6",
            "-hls_playlist_type",
            "vod",
            "-hls_segment_filename",
        ])
        .arg(staging.join("%05d.ts"));
    if direct_copy(ext) {
        command.args(["-c:a", "copy"]);
    } else {
        command.args(["-c:a", "aac", "-b:a", "256000"]);
    }
    command.arg(staging.join("index.m3u8"));
    if let Err(error) = process::ffmpeg(&mut command, process::HLS_TIMEOUT).await {
        tracing::warn!(%error, "HLS generation failed; using original media");
        remove_invalid(&destination).await;
        return;
    }
    if !ready(&staging).await {
        tracing::warn!("HLS generation produced an incomplete cache; using original media");
        remove_invalid(&destination).await;
        return;
    }
    // The publication worker owns staging cleanup even if the waiting future is cancelled.
    match tokio::task::spawn_blocking(move || {
        let _artifacts = artifacts;
        match std::fs::remove_dir_all(&destination) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        std::fs::rename(staging, destination)
    })
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::warn!(%error, "HLS publication failed; using original media"),
        Err(error) => tracing::warn!(%error, "HLS publication task failed; using original media"),
    }
}

/// Remove only a known invalid cache so clients encounter 404 and fall back to originals.
async fn remove_invalid(directory: &Path) {
    if let Err(error) = tokio::fs::remove_dir_all(directory).await
        && error.kind() != ErrorKind::NotFound
    {
        tracing::warn!(%error, "invalid HLS cache cleanup failed");
    }
}

/// Verify complete VOD markers/durations and existing, nonempty local segment files.
pub(super) async fn ready(directory: &Path) -> bool {
    duration(directory).await.is_some()
}

/// Measure only a complete, locally available VOD cache, never a partial manifest.
pub(super) async fn duration(directory: &Path) -> Option<f64> {
    let text = inspected_playlist(directory).await?;
    let duration = playlist_duration(&text);
    if duration.is_none() {
        tracing::warn!("complete HLS cache has invalid segment durations; decoding original");
    }
    duration
}

/// Read one playlist revision and validate every referenced segment before returning it.
async fn inspected_playlist(directory: &Path) -> Option<String> {
    let text = match tokio::fs::read_to_string(directory.join("index.m3u8")).await {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(%error, "HLS cache inspection failed");
            return None;
        }
    };
    let segments = playlist_segments(&text)?;
    for segment in segments {
        match tokio::fs::metadata(directory.join(segment)).await {
            Ok(metadata) if metadata.is_file() && metadata.len() > 0 => {}
            Ok(_) => return None,
            Err(error) if error.kind() == ErrorKind::NotFound => return None,
            Err(error) => {
                tracing::warn!(%error, "HLS segment inspection failed");
                return None;
            }
        }
    }
    Some(text)
}

/// Select the existing copy/transcode policy without adding container assumptions.
fn direct_copy(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp3" | "aac" | "m4a" | "mp4"
    )
}

/// Parse complete generated VOD playlists, rejecting remote/traversal segment paths.
fn playlist_segments(text: &str) -> Option<Vec<&str>> {
    let lines = text.lines().map(str::trim).collect::<Vec<_>>();
    if lines.first().copied()? != "#EXTM3U" || !lines.contains(&"#EXT-X-ENDLIST") {
        return None;
    }
    let mut segments = Vec::new();
    for line in lines {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let segment = line.split_once('?').map_or(line, |(segment, _)| segment);
        if !valid_storage_key(segment) {
            return None;
        }
        segments.push(segment);
    }
    (!segments.is_empty()).then_some(segments)
}

/// Sum one positive finite EXTINF per segment in a complete, safe generated playlist.
fn playlist_duration(text: &str) -> Option<f64> {
    playlist_segments(text)?;
    let mut total = 0.0_f64;
    let mut pending = None;
    let mut ended = false;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if ended {
            return None;
        }
        if line == "#EXT-X-ENDLIST" {
            if pending.is_some() {
                return None;
            }
            ended = true;
        } else if let Some(value) = line.strip_prefix("#EXTINF:") {
            if pending.is_some() {
                return None;
            }
            let duration = value.split_once(',')?.0.trim().parse::<f64>().ok()?;
            if !duration.is_finite() || duration <= 0.0 {
                return None;
            }
            pending = Some(duration);
        } else if !line.starts_with('#') {
            total += pending.take()?;
            if !total.is_finite() {
                return None;
            }
        }
    }
    (ended && total > 0.0).then_some(total)
}

/// Pure playlist/format tables, without native processes or filesystem fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Header/end-list/segments and unsafe URI conditions all have explicit cases.
    #[test]
    fn playlist_cases() {
        for (text, expected) in [
            ("#EXTM3U\n00000.ts\n#EXT-X-ENDLIST", Some(vec!["00000.ts"])),
            (
                "#EXTM3U\n#EXTINF:6\n00000.ts?q=1\n00001.ts\n#EXT-X-ENDLIST",
                Some(vec!["00000.ts", "00001.ts"]),
            ),
            ("", None),
            ("00000.ts\n#EXT-X-ENDLIST", None),
            ("#EXTM3U\n00000.ts", None),
            ("#EXTM3U\n#EXT-X-ENDLIST", None),
            ("#EXTM3U\n../outside.ts\n#EXT-X-ENDLIST", None),
            (
                "#EXTM3U\nhttps://invalid.test/segment.ts\n#EXT-X-ENDLIST",
                None,
            ),
        ] {
            assert_eq!(playlist_segments(text), expected);
        }
    }

    /// Segment durations must match a complete safe manifest and remain finite on summation.
    #[test]
    fn playlist_duration_cases() {
        for (name, body, expected) in [
            ("integer", "#EXTINF:6,\n00000.ts\n#EXT-X-ENDLIST", Some(6.0)),
            (
                "fractional segments",
                "#EXTINF:6.008167,\n00000.ts\n#EXTINF:1.828556,title\n00001.ts\n#EXT-X-ENDLIST",
                Some(7.836723),
            ),
            ("missing duration", "00000.ts\n#EXT-X-ENDLIST", None),
            ("partial VOD", "#EXTINF:6,\n00000.ts", None),
            ("empty VOD", "#EXT-X-ENDLIST", None),
            ("missing comma", "#EXTINF:6\n00000.ts\n#EXT-X-ENDLIST", None),
            (
                "malformed",
                "#EXTINF:invalid,\n00000.ts\n#EXT-X-ENDLIST",
                None,
            ),
            ("zero", "#EXTINF:0,\n00000.ts\n#EXT-X-ENDLIST", None),
            ("negative", "#EXTINF:-1,\n00000.ts\n#EXT-X-ENDLIST", None),
            ("NaN", "#EXTINF:NaN,\n00000.ts\n#EXT-X-ENDLIST", None),
            ("infinite", "#EXTINF:inf,\n00000.ts\n#EXT-X-ENDLIST", None),
            (
                "overflowing number",
                "#EXTINF:1e309,\n00000.ts\n#EXT-X-ENDLIST",
                None,
            ),
            (
                "overflowing total",
                "#EXTINF:1e308,\n00000.ts\n#EXTINF:1e308,\n00001.ts\n#EXT-X-ENDLIST",
                None,
            ),
            ("dangling duration", "#EXTINF:6,\n#EXT-X-ENDLIST", None),
            (
                "duplicate duration",
                "#EXTINF:6,\n#EXTINF:6,\n00000.ts\n#EXT-X-ENDLIST",
                None,
            ),
            (
                "second segment missing duration",
                "#EXTINF:6,\n00000.ts\n00001.ts\n#EXT-X-ENDLIST",
                None,
            ),
            (
                "unsafe path",
                "#EXTINF:6,\n../outside.ts\n#EXT-X-ENDLIST",
                None,
            ),
            (
                "remote segment",
                "#EXTINF:6,\nhttps://invalid.test/a.ts\n#EXT-X-ENDLIST",
                None,
            ),
            (
                "data after ENDLIST",
                "#EXTINF:6,\n00000.ts\n#EXT-X-ENDLIST\n#EXTINF:6,\n00001.ts",
                None,
            ),
        ] {
            let text = format!("#EXTM3U\n{body}\n");
            let actual = playlist_duration(&text);
            match (actual, expected) {
                (Some(actual), Some(expected)) => {
                    assert!((actual - expected).abs() < 1e-9, "{name}")
                }
                (None, None) => {}
                _ => panic!("{name}: expected {expected:?}, got {actual:?}"),
            }
        }
        assert!(playlist_duration("#EXTINF:6,\n00000.ts\n#EXT-X-ENDLIST").is_none());
    }

    /// Every supported copy/transcode extension follows the original codec policy.
    #[test]
    fn profile_cases() {
        for (ext, copy) in [
            ("mp3", true),
            ("AAC", true),
            ("m4a", true),
            ("mp4", true),
            ("flac", false),
            ("wav", false),
            ("ogg", false),
            ("opus", false),
            ("webm", false),
        ] {
            assert_eq!(direct_copy(ext), copy);
        }
    }
}
