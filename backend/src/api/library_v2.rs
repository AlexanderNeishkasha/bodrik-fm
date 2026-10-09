//! Studio library HTTP commands with off-thread persistence and owned notifications.

use crate::api::{
    AppState, internal_error_response, json_message, library_db_v2, runtime_v2, studio_v2, util_v2,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

/// Create a named room-owned section.
#[derive(serde::Deserialize)]
pub struct SectionNamePayload {
    /// Display name to normalize.
    name: String,
}

/// Rename one room-owned section.
#[derive(serde::Deserialize)]
pub struct SectionRenamePayload {
    /// Existing section ID.
    id: i64,
    /// Display name to normalize.
    name: String,
}

/// Select an existing room-owned section.
#[derive(serde::Deserialize)]
pub struct SectionIdPayload {
    /// Section ID.
    id: i64,
}

/// Exact permutation of all room section identities.
#[derive(serde::Deserialize)]
pub struct SectionReorderPayload {
    /// Unique section IDs in requested order.
    ids: Vec<i64>,
}

/// Move a room-owned track between section groups.
#[derive(serde::Deserialize)]
pub struct TrackMovePayload {
    /// Existing track ID.
    track_id: i64,
    /// Target section; None is the unsectioned group.
    section_id: Option<i64>,
    /// Insertion index, clamped at the target group's end.
    index: usize,
}

/// Exact permutation of one section's room-owned tracks.
#[derive(serde::Deserialize)]
pub struct TrackReorderPayload {
    /// Existing section or the unsectioned group.
    section_id: Option<i64>,
    /// Unique track IDs in requested order.
    ids: Vec<i64>,
}

/// Read a coherent section/track snapshot without blocking async workers.
pub async fn library(State(state): State<AppState>, headers: HeaderMap) -> Response {
    execute(state, headers, false, |state, room| {
        library_db_v2::list_library(state, room).map(Some)
    })
    .await
}

/// Create a normalized section and notify all Studio consumers after commit.
pub async fn create_section(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectionNamePayload>,
) -> Response {
    execute(state, headers, true, move |state, room| {
        let name = util_v2::normalize_section_name(&payload.name).ok_or("invalid name")?;
        library_db_v2::create_section(state, room, &name).map(Some)
    })
    .await
}

/// Rename only a section owned by the effective room.
pub async fn rename_section(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectionRenamePayload>,
) -> Response {
    execute(state, headers, true, move |state, room| {
        let name = util_v2::normalize_section_name(&payload.name).ok_or("invalid name")?;
        Ok(library_db_v2::rename_section(state, room, payload.id, &name)?.then(ok))
    })
    .await
}

/// Remove a section while preserving its tracks in the unsectioned group.
pub async fn delete_section(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectionIdPayload>,
) -> Response {
    execute(state, headers, true, move |state, room| {
        Ok(library_db_v2::delete_section(state, room, payload.id)?.then(ok))
    })
    .await
}

/// Persist an exact section-ID permutation.
pub async fn reorder_sections(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectionReorderPayload>,
) -> Response {
    execute(state, headers, true, move |state, room| {
        library_db_v2::reorder_sections(state, room, &payload.ids)?;
        Ok(Some(ok()))
    })
    .await
}

/// Move a track between validated room-owned groups and return the current library.
pub async fn move_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TrackMovePayload>,
) -> Response {
    execute(state, headers, true, move |state, room| {
        if !library_db_v2::move_track(
            state,
            room,
            payload.track_id,
            payload.section_id,
            payload.index,
        )? {
            return Ok(None);
        }
        library_db_v2::list_library(state, room).map(Some)
    })
    .await
}

/// Persist an exact track-ID permutation in a validated section group.
pub async fn reorder_tracks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TrackReorderPayload>,
) -> Response {
    execute(state, headers, true, move |state, room| {
        library_db_v2::reorder_tracks(state, room, payload.section_id, &payload.ids)?;
        Ok(Some(ok()))
    })
    .await
}

/// Authenticate once, then own persistence and notification through request cancellation.
async fn execute<T: serde::Serialize + Send + 'static>(
    state: AppState,
    headers: HeaderMap,
    notify: bool,
    operation: impl FnOnce(&AppState, i64) -> Result<Option<T>, String> + Send + 'static,
) -> Response {
    let user = match studio_v2::studio_user_from_http_async(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return *response,
    };
    let command = tokio::spawn(async move {
        let query_state = state.clone();
        match studio_v2::db_task(move || operation(&query_state, user.room_id)).await {
            Ok(Some(value)) => {
                if notify {
                    match runtime_v2::ensure_room_runtime(&state, user.room_id).await {
                        Ok(runtime) => {
                            runtime_v2::bump_library(&runtime);
                            runtime_v2::notify(&runtime);
                        }
                        Err(error) => {
                            tracing::error!(%error, "library committed but runtime notification failed")
                        }
                    }
                }
                Json(value).into_response()
            }
            Ok(None) => json_message(StatusCode::NOT_FOUND, "missing").into_response(),
            Err(err) => match classify_error(&err) {
                Some((status, message)) => json_message(status, message).into_response(),
                None => internal_error_response("studio.library.command", err),
            },
        }
    });
    match command.await {
        Ok(response) => response,
        Err(err) => internal_error_response("studio.library.task", err),
    }
}

/// Preserve the standard successful mutation message body.
fn ok() -> serde_json::Value {
    serde_json::json!({ "message": "ok" })
}

/// Map known validation/uniqueness failures, leaving operational errors for generic 500s.
fn classify_error(error: &str) -> Option<(StatusCode, &'static str)> {
    match error {
        "invalid name" => Some((StatusCode::BAD_REQUEST, "invalid name")),
        "invalid section" => Some((StatusCode::BAD_REQUEST, "invalid section")),
        "invalid order" => Some((StatusCode::BAD_REQUEST, "invalid order")),
        _ if error.contains("idx_library_sections_name_unique") => {
            Some((StatusCode::CONFLICT, "name exists"))
        }
        _ => None,
    }
}

/// Pure response policy tests; no HTTP/SQL fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Known user failures are distinguished from database/worker failures.
    #[test]
    fn error_cases() {
        for (error, expected) in [
            (
                "invalid name",
                Some((StatusCode::BAD_REQUEST, "invalid name")),
            ),
            (
                "invalid section",
                Some((StatusCode::BAD_REQUEST, "invalid section")),
            ),
            (
                "invalid order",
                Some((StatusCode::BAD_REQUEST, "invalid order")),
            ),
            (
                "UNIQUE constraint failed: index 'idx_library_sections_name_unique'",
                Some((StatusCode::CONFLICT, "name exists")),
            ),
            ("database locked", None),
            ("", None),
        ] {
            assert_eq!(classify_error(error), expected);
        }
    }
}
