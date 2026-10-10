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

/// Verify complete VOD markers and existing, nonempty local segment files.
pub(super) async fn ready(directory: &Path) -> bool {
    let text = match tokio::fs::read_to_string(directory.join("index.m3u8")).await {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return false,
        Err(error) => {
            tracing::warn!(%error, "HLS cache inspection failed");
            return false;
        }
    };
    let Some(segments) = playlist_segments(&text) else {
        return false;
    };
    for segment in segments {
        match tokio::fs::metadata(directory.join(segment)).await {
            Ok(metadata) if metadata.is_file() && metadata.len() > 0 => {}
            Ok(_) => return false,
            Err(error) if error.kind() == ErrorKind::NotFound => return false,
            Err(error) => {
                tracing::warn!(%error, "HLS segment inspection failed");
                return false;
            }
        }
    }
    true
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
