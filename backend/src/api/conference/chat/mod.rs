//! Private persistent public-chat API; SQLite and disk work have explicit blocking ownership.
mod cleanup;
pub(crate) mod direct;
mod files;
mod store;
#[cfg(test)]
mod tests;
mod types;

use super::admission;
use crate::api::{AppState, studio_v2};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use std::{path::PathBuf, sync::Arc};
use types::*;

/// Shared private-service dependencies; no secrets enter browser state.
#[derive(Clone)]
pub(crate) struct ChatState {
    /// Existing serialized application database and authority.
    pub app: AppState,
    /// Independent meeting/player service bearer.
    secret: Option<Arc<str>>,
    /// Persistent attachment directory shared read-only with nginx.
    pub directory: PathBuf,
    /// Bound concurrent streaming uploads across all rooms.
    pub uploads: Arc<tokio::sync::Semaphore>,
}

/// Compose private routes and an explicitly owned cleanup worker.
pub(crate) fn setup(
    app: AppState,
    secret: Option<Arc<str>>,
    directory: PathBuf,
) -> (Router, cleanup::Worker, ChatState) {
    let state = ChatState {
        app,
        secret,
        directory,
        uploads: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    let worker = cleanup::start(state.clone());
    let routes = Router::new()
        .route(
            "/api/internal/conferences/{id}/chat",
            get(history).post(append),
        )
        .route(
            "/api/internal/conferences/{id}/chat/messages/{message}",
            axum::routing::delete(delete),
        )
        .route(
            "/api/internal/conferences/{id}/chat/attachments",
            post(files::upload).layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route(
            "/api/internal/conferences/{id}/chat/attachments/{attachment}",
            get(files::metadata),
        )
        .with_state(state.clone());
    (routes, worker, state)
}

/// Decode service-authenticated actor/generation assertions; public headers cannot select them.
///
/// # Errors
/// Rejects missing/wrong service secrets, malformed identities and generations.
fn identity(
    state: &ChatState,
    conference: String,
    headers: &HeaderMap,
) -> Result<Identity, StatusCode> {
    let secret = state
        .secret
        .as_deref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    if !admission::authorized(headers, secret) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let actor = headers
        .get("x-chat-actor")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::BAD_REQUEST)?;
    if conference.is_empty()
        || conference.len() > 160
        || actor.is_empty()
        || actor.len() > 160
        || !conference
            .bytes()
            .chain(actor.bytes())
            .all(|v| v.is_ascii_alphanumeric() || b"_.:-".contains(&v))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let generation = headers
        .get("x-meeting-generation")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 0)
        .ok_or(StatusCode::BAD_REQUEST)?;
    let presenter = match headers
        .get("x-chat-presenter")
        .and_then(|v| v.to_str().ok())
    {
        Some("true") => true,
        Some("false") | None => false,
        _ => return Err(StatusCode::BAD_REQUEST),
    };
    Ok(Identity {
        conference,
        generation,
        actor: actor.into(),
        presenter,
    })
}

/// Run one synchronous storage operation off-thread with sole connection ownership.
///
/// # Errors
/// Returns worker, lock and domain/database failures.
pub(super) async fn database<T: Send + 'static>(
    state: &ChatState,
    operation: impl FnOnce(&mut rusqlite::Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let app = state.app.clone();
    studio_v2::db_task(move || {
        let mut conn = app.db.lock().map_err(|_| "chat database lock poisoned")?;
        operation(&mut conn)
    })
    .await
}

/// Convert domain errors to stable HTTP statuses without exposing SQL or filesystem context.
pub(super) fn failure(error: String) -> Response {
    let status = match error.as_str() {
        "invalid" => StatusCode::BAD_REQUEST,
        "denied" => StatusCode::FORBIDDEN,
        "gone" => StatusCode::GONE,
        "unavailable" => StatusCode::NOT_FOUND,
        "capacity" => StatusCode::TOO_MANY_REQUESTS,
        _ => {
            tracing::error!(%error,"persistent chat operation failed");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    status.into_response()
}

/// Return no-store JSON for history and mutations.
pub(super) fn response(value: impl serde::Serialize) -> Response {
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

/// Strict history cursor, encoded as text rather than an unsafe browser integer.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    /// Exclusive older SQLite message sequence.
    before: Option<i64>,
}

/// Read a bounded history page for an admitted service actor.
async fn history(
    State(state): State<ChatState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(cursor): Query<Cursor>,
) -> Response {
    let who = match identity(&state, id, &headers) {
        Ok(who) => who,
        Err(status) => return status.into_response(),
    };
    if cursor.before.is_some_and(|v| v < 1) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match database(&state, move |conn| {
        store::history(conn, &who, cursor.before)
    })
    .await
    {
        Ok(value) => response(value),
        Err(error) => failure(error),
    }
}

/// Commit a public message before the meeting service broadcasts it.
async fn append(
    State(state): State<ChatState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Submission>,
) -> Response {
    let who = match identity(&state, id, &headers) {
        Ok(who) => who,
        Err(status) => return status.into_response(),
    };
    match database(&state, move |conn| {
        store::append(conn, &who, input, chrono::Utc::now().timestamp_millis())
    })
    .await
    {
        Ok(value) => response(value),
        Err(error) => failure(error),
    }
}

/// Delete globally after trusted sender/presenter assertions and fresh room mapping checks.
async fn delete(
    State(state): State<ChatState>,
    Path((conference, id)): Path<(String, i64)>,
    headers: HeaderMap,
) -> Response {
    let who = match identity(&state, conference, &headers) {
        Ok(who) => who,
        Err(status) => return status.into_response(),
    };
    if id < 1 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match database(&state, move |conn| store::delete(conn, &who, id)).await {
        Ok(value) => response(value),
        Err(error) => failure(error),
    }
}
