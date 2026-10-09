//! Public room directory and queue-free state delivery with cancellation-safe accounting.

use crate::api::{AppState, db_v2, internal_error_response, runtime_v2, state_socket};
use axum::{
    Json,
    extract::{
        Path, State,
        ws::{WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::IntoResponse,
};
use tokio::time::{self, Duration};

/// Public directory entry; unlisted rooms remain accessible by direct link.
#[derive(serde::Serialize)]
struct RoomListItem {
    /// Current public slug.
    slug: String,
}

/// Public playback contract, deliberately excluding the room queue and private settings.
#[derive(serde::Serialize)]
struct PublicStatePayload {
    /// Whether current playback is advancing.
    is_playing: bool,
    /// Current position in seconds.
    position: f64,
    /// Current room-owned track only.
    current: Option<crate::stream::TrackEntry>,
    /// Change token captured with the playback state.
    sync_token: usize,
    /// Authoritative room theme.
    theme: String,
    /// Current public slug.
    room_slug: String,
}

/// Load the public directory without synchronous SQLite work on the async executor.
pub async fn rooms_list(State(state): State<AppState>) -> impl IntoResponse {
    match tokio::task::spawn_blocking(move || db_v2::list_rooms(&state)).await {
        Ok(Ok(rows)) => Json(
            rows.into_iter()
                .map(|row| RoomListItem { slug: row.slug })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Ok(Err(err)) => internal_error_response("public.rooms_list", err),
        Err(err) => internal_error_response("public.rooms_list.task", err),
    }
}

/// Return an authoritative public snapshot for the current slug, including unlisted rooms.
pub async fn state_public(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> impl IntoResponse {
    let room = match lookup_room(&state, slug).await {
        Ok(Some(room)) => room,
        Ok(None) => {
            return crate::api::json_message(StatusCode::NOT_FOUND, "room not found")
                .into_response();
        }
        Err(err) => return internal_error_response("public.state_public.lookup", err),
    };
    match runtime_v2::ensure_room_runtime(&state, room.id).await {
        Ok(runtime) => Json(build_public_payload(&runtime).await).into_response(),
        Err(err) => internal_error_response("public.state_public.runtime", err),
    }
}

/// Upgrade public state delivery after an off-thread current-slug lookup.
pub async fn state_public_ws(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let room = match lookup_room(&state, slug).await {
        Ok(Some(room)) => room,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(err) => return internal_error_response("public.state_public_ws.lookup", err),
    };
    let runtime = match runtime_v2::ensure_room_runtime(&state, room.id).await {
        Ok(runtime) => runtime,
        Err(err) => return internal_error_response("public.state_public_ws.runtime", err),
    };
    ws.max_message_size(state_socket::INPUT_LIMIT)
        .max_frame_size(state_socket::INPUT_LIMIT)
        .on_upgrade(move |socket| public_state_socket(socket, runtime))
}

/// Resolve room identity without holding a DB guard across an await.
///
/// # Errors
/// Returns worker or SQL lookup errors; absent slugs return `None`.
async fn lookup_room(state: &AppState, slug: String) -> Result<Option<db_v2::RoomRecord>, String> {
    let state = state.clone();
    tokio::task::spawn_blocking(move || db_v2::room_by_slug(&state, &slug))
        .await
        .map_err(|err| format!("public room lookup task failed: {err}"))?
}

/// Send snapshots on timer/events; lag repairs immediately, and deletion terminates delivery.
async fn public_state_socket(
    mut socket: WebSocket,
    runtime: std::sync::Arc<runtime_v2::RoomRuntime>,
) {
    let _listener = state_socket::listen(runtime.clone());
    let mut receiver = runtime.state_broadcast.subscribe();
    let mut ticker = time::interval(Duration::from_secs(5));
    ticker.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = ticker.tick() => {},
            event = receiver.recv() => {
                if matches!(event, Err(tokio::sync::broadcast::error::RecvError::Closed)) { break; }
            },
            message = socket.recv() => {
                if state_socket::terminal(&message) { break; }
                continue;
            }
        }
        if runtime_v2::is_closed(&runtime) {
            break;
        }
        let payload = build_public_payload(&runtime).await;
        let text = match serde_json::to_string(&payload) {
            Ok(text) => text,
            Err(error) => {
                tracing::error!(%error, "public state serialization failed");
                break;
            }
        };
        if !state_socket::send(&mut socket, text).await {
            break;
        }
    }
}

/// Select public fields from a repair snapshot, retaining existing browser payload names.
async fn build_public_payload(runtime: &runtime_v2::RoomRuntime) -> PublicStatePayload {
    let snapshot = runtime_v2::snapshot(runtime).await;
    PublicStatePayload {
        is_playing: snapshot.player.is_playing,
        position: snapshot.player.position,
        current: snapshot.player.current,
        sync_token: snapshot.sync_token,
        theme: snapshot.theme,
        room_slug: snapshot.room_slug,
    }
}
