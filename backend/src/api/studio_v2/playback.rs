//! Authenticated synchronous playback transitions and persisted repeat policy.

use super::{
    context::{action_runtime, apply_player, db_task, with_track},
    types::{RepeatPayload, SeekRequest, TrackRequest},
};
use crate::api::{AppState, db_v2, internal_error_response, json_message, runtime_v2};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

/// Resolve and start a room-owned track without changing the waiting queue.
pub async fn play_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TrackRequest>,
) -> Response {
    with_track(state, headers, payload.id, true, |player, entry| {
        player.play_track(entry, 0.0)
    })
    .await
}

/// Freeze playback and commit a paired change token.
pub async fn pause(State(state): State<AppState>, headers: HeaderMap) -> Response {
    apply_player(state, headers, true, |player| {
        player.pause();
        Ok(())
    })
    .await
}

/// Resume the current track or start the queue head; empty rooms remain silent.
pub async fn resume(State(state): State<AppState>, headers: HeaderMap) -> Response {
    apply_player(state, headers, true, |player| {
        player.resume();
        Ok(())
    })
    .await
}

/// Seek while preserving play/pause state; invalid numeric input is rejected before mutation.
pub async fn seek(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SeekRequest>,
) -> Response {
    apply_player(state, headers, true, |player| {
        player
            .seek(payload.position)
            .map_err(|_| (StatusCode::BAD_REQUEST, "invalid position"))
    })
    .await
}

/// Skip the current entry while preserving a paused room's paused state.
pub async fn skip(State(state): State<AppState>, headers: HeaderMap) -> Response {
    apply_player(state, headers, true, |player| {
        player.skip();
        Ok(())
    })
    .await
}

/// Persist repeat off-thread, then publish the live setting with a paired revision.
pub async fn set_repeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RepeatPayload>,
) -> Response {
    let (user, runtime) = match action_runtime(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Err(err) = db_task(move || {
        let mut player = runtime.streamer.blocking_lock();
        db_v2::set_room_repeat(&state, user.room_id, payload.repeat_one)?;
        player.set_repeat_one(payload.repeat_one);
        runtime_v2::notify_playback(&runtime);
        Ok(())
    })
    .await
    {
        return internal_error_response("studio.set_repeat", err);
    }
    json_message(StatusCode::OK, "ok").into_response()
}
