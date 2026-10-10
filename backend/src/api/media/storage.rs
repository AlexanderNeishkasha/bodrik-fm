//! Media path construction and safe, observable artifact removal.

use crate::api::AppState;
use std::{
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

/// Build an original-file path for an already validated/server-generated storage key.
pub fn media_path(state: &AppState, key: &str) -> PathBuf {
    Path::new(&state.media_dir).join(key)
}

/// Build a per-asset HLS directory for a validated/server-generated storage key.
pub fn hls_dir(state: &AppState, key: &str) -> PathBuf {
    Path::new(&state.media_dir).join("hls").join(key)
}

/// Accept one portable filename component, never an absolute/drive/parent/remote path.
pub(crate) fn valid_storage_key(key: &str) -> bool {
    if key.is_empty() || key.contains(['/', '\\', ':']) || key.chars().any(char::is_control) {
        return false;
    }
    let mut components = Path::new(key).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

/// Remove a deleted upload's original/HLS artifacts; missing files are expected.
/// Invalid persisted keys are rejected before any destructive I/O, and failures are logged.
pub async fn cleanup_media_artifacts(state: &AppState, key: &str) {
    if !valid_storage_key(key) {
        tracing::error!("invalid media cleanup key rejected");
        return;
    }
    if let Err(error) = tokio::fs::remove_file(media_path(state, key)).await
        && error.kind() != ErrorKind::NotFound
    {
        tracing::error!(%error, "original media cleanup failed");
    }
    if let Err(error) = tokio::fs::remove_dir_all(hls_dir(state, key)).await
        && error.kind() != ErrorKind::NotFound
    {
        tracing::error!(%error, "HLS media cleanup failed");
    }
}

/// Pure path-component policy; no filesystem fixtures or removals.
#[cfg(test)]
mod tests {
    use super::*;

    /// Portable UUID/human filenames are valid; path traversal and protocol prefixes aren't.
    #[test]
    fn storage_key_cases() {
        for (key, valid) in [
            ("track.mp3", true),
            ("uuid.M4A", true),
            ("Русская музыка.wav", true),
            (".track.wav", true),
            ("", false),
            (".", false),
            ("..", false),
            ("../track.mp3", false),
            ("sub/track.mp3", false),
            ("sub\\track.mp3", false),
            ("/track.mp3", false),
            ("C:track.mp3", false),
            ("https://invalid.test/track", false),
            ("track\0.mp3", false),
            ("track\n.mp3", false),
        ] {
            assert_eq!(valid_storage_key(key), valid, "{key:?}");
        }
    }
}
