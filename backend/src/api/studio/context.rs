//! Reused off-thread I/O and serialized playback command boundaries.

use super::auth::studio_user_from_http_async;
use crate::api::blocking::op_task;
use crate::{
    api::{
        AppState, auth::AuthUser, db, internal_error_response, json_message, op_error::OpError,
        runtime,
    },
    stream::{Streamer, TrackEntry},
};
use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::sync::Arc;

/// Resolve the actor/effective identity and authoritative live room for a command.
///
/// # Errors
/// Returns authorization responses or generic runtime failures; terminal rooms are missing.
pub(super) async fn action_runtime(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(AuthUser, Arc<runtime::RoomRuntime>), Box<Response>> {
    let user = studio_user_from_http_async(state, headers).await?;
    let runtime = runtime::ensure_room_runtime(state, user.room_id)
        .await
        .map_err(|err| Box::new(internal_error_response("studio.runtime", err)))?;
    if runtime::is_closed(&runtime) {
        return Err(Box::new(
            json_message(StatusCode::NOT_FOUND, "missing").into_response(),
        ));
    }
    Ok((user, runtime))
}

/// Apply an in-memory command and its change token under one playback lock.
/// Playback commands increment the token; queue-only commands merely wake Studio.
pub(super) async fn apply_player(
    state: AppState,
    headers: HeaderMap,
    playback: bool,
    action: impl FnOnce(&mut Streamer) -> Result<(), (StatusCode, &'static str)>,
) -> Response {
    let (_, runtime) = match action_runtime(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut player = runtime.streamer.lock().await;
    if runtime::is_closed(&runtime) {
        return json_message(StatusCode::NOT_FOUND, "missing").into_response();
    }
    if let Err((status, message)) = action(&mut player) {
        return json_message(status, message).into_response();
    }
    if playback {
        runtime::notify_playback(&runtime);
    } else {
        runtime::notify(&runtime);
    }
    json_message(StatusCode::OK, "ok").into_response()
}

/// Resolve a room-owned track off-thread, preserving SQL failures instead of inventing absence.
/// Apply the resolved track synchronously under the same lock as revision publication.
pub(super) async fn with_track(
    state: AppState,
    headers: HeaderMap,
    id: String,
    playback: bool,
    action: impl FnOnce(&mut Streamer, TrackEntry) -> anyhow::Result<()> + Send + 'static,
) -> Response {
    let (user, runtime) = match action_runtime(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match op_task(move || {
        // Resolve and apply under one off-thread lock so deletion cannot invalidate a cached entry.
        let mut player = runtime.streamer.blocking_lock();
        if runtime::is_closed(&runtime) {
            return Err(OpError::Missing);
        }
        let entry = db::resolve_track(&state, user.room_id, &id)?.ok_or(OpError::Missing)?;
        action(&mut player, entry).map_err(|err| err.to_string())?;
        if playback {
            runtime::notify_playback(&runtime);
        } else {
            runtime::notify(&runtime);
        }
        Ok(())
    })
    .await
    {
        Ok(()) => json_message(StatusCode::OK, "ok").into_response(),
        Err(err) => err.respond("studio.track_action"),
    }
}
