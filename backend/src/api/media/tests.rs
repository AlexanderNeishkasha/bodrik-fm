//! Native/media-file acceptance for prepared duration precedence and original fallback.

use super::*;
use std::{path::Path, path::PathBuf, time::Duration};
use tokio::process::Command;

/// Create an exclusively owned temporary directory whose guard cleans up on every exit.
async fn fixture() -> (PathBuf, Artifacts) {
    let directory = std::env::temp_dir().join(format!("bodrik-duration-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir(&directory)
        .await
        .expect("fixture directory");
    let mut artifacts = Artifacts::new();
    artifacts.directory(directory.clone());
    (directory, artifacts)
}

/// Encode synthetic VBR audio without a Xing header, reproducing an inaccurate bitrate estimate.
/// The fixture contains one second of sine and one second of silence, not copyrighted media.
async fn synthetic_mp3(path: &Path) {
    let mut command = Command::new("ffmpeg");
    command
        .args([
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=mono:d=1",
            "-filter_complex",
            "[0:a][1:a]concat=n=2:v=0:a=1[out]",
            "-map",
            "[out]",
            "-c:a",
            "libmp3lame",
            "-q:a",
            "2",
            "-write_xing",
            "0",
            "-f",
            "mp3",
        ])
        .arg(path);
    process::ffmpeg(&mut command, Duration::from_secs(10))
        .await
        .expect("synthetic MP3 encoding");
}

/// A complete cache is authoritative without launching a decoder on the original.
#[tokio::test]
async fn prepared_duration_prefers_complete_hls() {
    let (cache, _artifacts) = fixture().await;
    tokio::fs::write(
        cache.join("index.m3u8"),
        "#EXTM3U\n#EXTINF:3.25,\n00000.ts\n#EXTINF:1.75,\n00001.ts\n#EXT-X-ENDLIST\n",
    )
    .await
    .expect("playlist");
    for segment in ["00000.ts", "00001.ts"] {
        tokio::fs::write(cache.join(segment), b"nonempty fixture segment")
            .await
            .expect("segment");
    }
    let duration = prepared_duration(&cache.join("missing-original.mp3"), &cache).await;
    assert!((duration.expect("prepared duration") - 5.0).abs() < 1e-9);
}

/// Only complete manifests with valid durations and available segments count as ready.
#[tokio::test]
async fn hls_duration_availability_cases() {
    let (root, _artifacts) = fixture().await;
    for (name, playlist, segment, expected) in [
        (
            "complete",
            Some("#EXTM3U\n#EXTINF:5,\n00000.ts\n#EXT-X-ENDLIST\n"),
            Some("segment"),
            Some(5.0),
        ),
        ("missing playlist", None, Some("segment"), None),
        (
            "partial playlist",
            Some("#EXTM3U\n#EXTINF:5,\n00000.ts\n"),
            Some("segment"),
            None,
        ),
        (
            "missing duration",
            Some("#EXTM3U\n00000.ts\n#EXT-X-ENDLIST\n"),
            Some("segment"),
            None,
        ),
        (
            "invalid duration",
            Some("#EXTM3U\n#EXTINF:NaN,\n00000.ts\n#EXT-X-ENDLIST\n"),
            Some("segment"),
            None,
        ),
        (
            "missing segment",
            Some("#EXTM3U\n#EXTINF:5,\n00000.ts\n#EXT-X-ENDLIST\n"),
            None,
            None,
        ),
        (
            "empty segment",
            Some("#EXTM3U\n#EXTINF:5,\n00000.ts\n#EXT-X-ENDLIST\n"),
            Some(""),
            None,
        ),
        (
            "unsafe segment",
            Some("#EXTM3U\n#EXTINF:5,\n../outside.ts\n#EXT-X-ENDLIST\n"),
            Some("segment"),
            None,
        ),
    ] {
        let cache = root.join(name);
        tokio::fs::create_dir(&cache).await.expect(name);
        if let Some(playlist) = playlist {
            tokio::fs::write(cache.join("index.m3u8"), playlist)
                .await
                .expect(name);
        }
        if let Some(segment) = segment {
            tokio::fs::write(cache.join("00000.ts"), segment)
                .await
                .expect(name);
        }
        assert_eq!(hls::ready(&cache).await, expected.is_some(), "{name}");
        assert_eq!(hls::duration(&cache).await, expected, "{name}");
    }
}

/// Missing/partial/invalid HLS must measure VBR samples instead of accepting format metadata.
#[tokio::test]
async fn prepared_duration_decodes_vbr_fallback() {
    let (root, _artifacts) = fixture().await;
    let original = root.join("synthetic.mp3");
    synthetic_mp3(&original).await;
    let bytes = tokio::fs::read(&original).await.expect("original bytes");
    let metadata = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(&original)
        .output()
        .await
        .expect("metadata estimate");
    assert!(metadata.status.success(), "metadata probe failed");
    let estimate = String::from_utf8(metadata.stdout)
        .expect("metadata text")
        .trim()
        .parse::<f64>()
        .expect("metadata duration");

    for (name, playlist) in [
        ("missing HLS", None),
        ("partial HLS", Some("#EXTM3U\n#EXTINF:2,\n00000.ts\n")),
        (
            "invalid HLS",
            Some("#EXTM3U\n#EXTINF:NaN,\n00000.ts\n#EXT-X-ENDLIST\n"),
        ),
    ] {
        let cache = root.join(name);
        tokio::fs::create_dir(&cache).await.expect(name);
        if let Some(playlist) = playlist {
            tokio::fs::write(cache.join("index.m3u8"), playlist)
                .await
                .expect(name);
            tokio::fs::write(cache.join("00000.ts"), b"fixture segment")
                .await
                .expect(name);
        }
        let duration = prepared_duration(&original, &cache).await.expect(name);
        assert!((duration - 2.037551).abs() < 0.002, "{name}: {duration}");
        assert!(
            (duration - estimate).abs() > 0.05,
            "{name}: reused inaccurate estimate {estimate}"
        );
    }
    assert_eq!(
        tokio::fs::read(&original)
            .await
            .expect("unchanged original"),
        bytes
    );
}

/// Missing, empty and undecodable originals stay unknown, never a successful duration.
#[tokio::test]
async fn original_duration_failure_cases() {
    let (root, _artifacts) = fixture().await;
    for (name, contents) in [
        ("missing.mp3", None),
        ("empty.mp3", Some("")),
        ("invalid.mp3", Some("not an audio file")),
    ] {
        let path = root.join(name);
        if let Some(contents) = contents {
            tokio::fs::write(&path, contents).await.expect(name);
        }
        assert!(
            prepared_duration(&path, &root.join("missing-hls"))
                .await
                .is_none(),
            "{name}"
        );
    }
}
