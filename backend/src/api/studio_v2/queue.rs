//! Queue mutations, kept distinct from playback-position transitions.

use super::{
    context::{apply_player, with_track},
    types::{QueueInsertRequest, QueueRemoveRequest, QueueReorderRequest, TrackRequest},
};
use crate::api::AppState;
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
};

/// Append a resolved room-owned track without forcing playback.
pub async fn queue_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TrackRequest>,
) -> Response {
    with_track(state, headers, payload.id, false, |player, entry| {
        player.enqueue(entry);
        Ok(())
    })
    .await
}

/// Insert a resolved track, appending for out-of-range insertion positions.
pub async fn insert_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<QueueInsertRequest>,
) -> Response {
    with_track(state, headers, payload.id, false, move |player, entry| {
        player.enqueue_at(payload.index, entry);
        Ok(())
    })
    .await
}

/// Reorder valid distinct queue positions; reject invalid indices without modifying the queue.
pub async fn reorder_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<QueueReorderRequest>,
) -> Response {
    apply_player(state, headers, false, |player| {
        if player.reorder_queue(payload.from, payload.to) {
            Ok(())
        } else {
            Err((StatusCode::BAD_REQUEST, "invalid index"))
        }
    })
    .await
}

/// Remove a queued entry, preserving the current playing/paused track.
pub async fn remove_from_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<QueueRemoveRequest>,
) -> Response {
    apply_player(state, headers, false, |player| {
        player
            .remove_at(payload.index)
            .map(|_| ())
            .ok_or((StatusCode::NOT_FOUND, "missing"))
    })
    .await
}

/// Start one queued entry and commit playback/revision atomically.
pub async fn force_play(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<QueueRemoveRequest>,
) -> Response {
    apply_player(state, headers, true, |player| {
        let entry = player
            .remove_at(payload.index)
            .ok_or((StatusCode::NOT_FOUND, "missing"))?;
        player
            .play_track(entry, 0.0)
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "play failed"))
    })
    .await
}
