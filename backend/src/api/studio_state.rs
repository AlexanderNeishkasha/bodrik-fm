//! Private Studio state delivery, live authorization and cancellation-safe listener leases.

use super::{AppState, blocking, request_security, runtime, state_socket, studio, youtube_jobs};
use axum::{
    extract::{
        Query, State,
        ws::{WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use std::sync::Arc;
use tokio::time::{self, Duration};

/// Require a trusted browser Origin and live owner/admin identity before upgrading.
pub(crate) async fn state_ws(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<studio::StudioAsQuery>,
    ws: WebSocketUpgrade,
) -> axum::response::Response {
    if !request_security::websocket_origin_allowed(&headers, &state.csrf_allowed_origins) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let auth_state = state.clone();
    let auth_headers = headers.clone();
    let as_user_id = query.as_user_id;
    let user = match tokio::task::spawn_blocking(move || {
        studio::resolve_studio_user(&auth_state, &auth_headers, as_user_id)
    })
    .await
    {
        Ok(Ok(user)) => user,
        Ok(Err(error)) => return studio::studio_user_error_status(error).into_response(),
        Err(error) => {
            tracing::error!(%error, "Studio socket authorization task failed");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let runtime = match runtime::ensure_room_runtime(&state, user.room_id).await {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(%error, "Studio socket runtime failed");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    ws.max_message_size(state_socket::INPUT_LIMIT)
        .max_frame_size(state_socket::INPUT_LIMIT)
        .on_upgrade(move |socket| run(socket, state, runtime, user.room_id, headers, as_user_id))
}

/// Publish snapshots every 500ms and revalidate admission every five seconds.
/// Deletion, revocation, input/send errors and task cancellation all release the lease.
async fn run(
    mut socket: WebSocket,
    state: AppState,
    runtime: Arc<runtime::RoomRuntime>,
    room: i64,
    headers: HeaderMap,
    as_user_id: Option<i64>,
) {
    let _listener = state_socket::listen(runtime.clone());
    let mut changes = runtime.state_broadcast.subscribe();
    let mut ticker = time::interval(Duration::from_millis(500));
    let mut authorization = time::interval(Duration::from_secs(5));
    ticker.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    authorization.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = ticker.tick() => {},
            update = changes.recv() => {
                if matches!(update, Err(tokio::sync::broadcast::error::RecvError::Closed)) { break; }
            },
            _ = authorization.tick() => {
                let auth_state = state.clone();
                let auth_headers = headers.clone();
                match tokio::task::spawn_blocking(move || studio::resolve_studio_user(&auth_state, &auth_headers, as_user_id)).await {
                    Ok(Ok(user)) if user.room_id == room => {},
                    Ok(_) => break,
                    Err(error) => { tracing::error!(%error, "Studio socket revalidation task failed"); break; }
                }
                continue;
            },
            message = socket.recv() => {
                if state_socket::terminal(&message) { break; }
                continue;
            }
        }
        if runtime::is_closed(&runtime) {
            break;
        }
        let Some(payload) = payload(&state, &runtime, room).await else {
            break;
        };
        if !state_socket::send(&mut socket, payload).await {
            break;
        }
    }
}

/// Serialize current playback/preferences and jobs without inventing empty data on DB errors.
async fn payload(state: &AppState, runtime: &runtime::RoomRuntime, room: i64) -> Option<String> {
    let snapshot = runtime::snapshot(runtime).await;
    let db_state = state.clone();
    let jobs = match blocking::db_task(move || youtube_jobs::list_room_jobs(&db_state, room)).await
    {
        Ok(jobs) => jobs,
        Err(error) => {
            tracing::error!(%error, "Studio state job lookup failed");
            return None;
        }
    };
    Some(serde_json::json!({
        "is_playing": snapshot.player.is_playing, "position": snapshot.player.position,
        "current": snapshot.player.current, "queue": snapshot.player.queue,
        "repeat_one": snapshot.player.repeat_one, "listeners": snapshot.listeners,
        "library_version": snapshot.library_version, "sync_token": snapshot.sync_token,
        "theme": snapshot.theme, "music_output": snapshot.music_output,
        "conference_music_volume": snapshot.conference_music_volume,
        "conference_allowed": snapshot.conference_allowed, "conference_enabled": snapshot.conference_enabled,
        "room_slug": snapshot.room_slug, "youtube_downloads": jobs,
    }).to_string())
}
