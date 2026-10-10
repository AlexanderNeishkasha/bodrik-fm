//! Media I/O composition; original files remain authoritative when optional processing fails.

mod artifacts;
mod hls;
mod process;
mod storage;

pub(crate) use artifacts::Artifacts;
pub(crate) use process::ffmpeg;
pub use process::probe_duration;
pub(crate) use storage::valid_storage_key;
pub use storage::{cleanup_media_artifacts, hls_dir, media_path};

use crate::api::{AppState, blocking, db};

/// Warm missing/incomplete HLS caches after off-thread asset discovery.
/// Invalid keys, missing originals and database/processing failures are logged, not invented data.
pub async fn init_hls_cache(state: &AppState) {
    let db_state = state.clone();
    let keys = match blocking::db_task(move || db::list_all_storage_keys(&db_state)).await {
        Ok(keys) => keys,
        Err(error) => {
            tracing::error!(%error, "HLS asset discovery failed");
            return;
        }
    };
    for key in keys {
        if !valid_storage_key(&key) {
            tracing::warn!("invalid stored media key skipped");
            continue;
        }
        let path = media_path(state, &key);
        match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) if metadata.is_file() && metadata.len() > 0 => {}
            Ok(_) => {
                tracing::warn!("non-file/empty media skipped during HLS warmup");
                continue;
            }
            Err(error) => {
                tracing::warn!(%error, "media unavailable during HLS warmup");
                continue;
            }
        }
        if !hls::ready(&hls_dir(state, &key)).await {
            hls::generate(state, &path, &key).await;
        }
    }
}

/// Optionally optimize/package an owned original and probe its finite duration.
/// Unknown duration and failed HLS/faststart preserve original-file fallback.
pub async fn process_uploaded_file(
    state: &AppState,
    path: &std::path::Path,
    key: &str,
) -> Option<f64> {
    if !valid_storage_key(key) {
        tracing::error!("invalid processing storage key rejected");
        return None;
    }
    process::faststart(path, key).await;
    hls::generate(state, path, key).await;
    probe_duration(path).await
}
