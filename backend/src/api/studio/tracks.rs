//! Room-owned track listing/mutations, serialized against playback without async lock guards.

use super::{
    auth::studio_user_from_http_async,
    context::action_runtime,
    types::{DeletePayload, RenamePayload},
};
use crate::api::blocking::{db_task, op_task};
use crate::api::{
    AppState, db, internal_error_response, json_message, media, op_error::OpError, runtime, util,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

/// List authoritative room-owned tracks on a blocking worker.
pub async fn tracks(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user = match studio_user_from_http_async(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return *response,
    };
    match db_task(move || db::list_room_tracks(&state, user.room_id)).await {
        Ok(tracks) => Json(tracks).into_response(),
        Err(err) => internal_error_response("studio.tracks", err),
    }
}

/// Rename a non-current track; identity, SQL and queued-title updates share one worker lock.
pub async fn rename_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RenamePayload>,
) -> Response {
    let (user, runtime) = match action_runtime(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(id) = canonical_id(&payload.id) else {
        return json_message(StatusCode::BAD_REQUEST, "invalid id").into_response();
    };
    let Some(title) = util::normalize_room_track_title(&payload.to) else {
        return json_message(StatusCode::BAD_REQUEST, "invalid name").into_response();
    };
    match op_task(move || {
        let mut player = runtime.streamer.blocking_lock();
        if runtime::is_closed(&runtime) {
            return Err(OpError::Missing);
        }
        if player.is_current_id(&id.to_string()) {
            return Err(OpError::Conflict("playing"));
        }
        let changed = db::rename_room_track(&state, user.room_id, id, &title)?;
        if changed {
            player.rename_track_by_id(&id.to_string(), &title);
            runtime::bump_library(&runtime);
            runtime::notify(&runtime);
        }
        Ok(changed)
    })
    .await
    {
        Ok(true) => json_message(StatusCode::OK, "ok").into_response(),
        Ok(false) => json_message(StatusCode::NOT_FOUND, "missing").into_response(),
        Err(err) => err.respond("studio.rename_track"),
    }
}

/// Own deletion/cleanup to completion even if the initiating HTTP request disconnects.
pub async fn delete_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<DeletePayload>,
) -> Response {
    let (user, runtime) = match action_runtime(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(id) = canonical_id(&payload.id) else {
        return json_message(StatusCode::BAD_REQUEST, "invalid id").into_response();
    };
    let command = tokio::spawn(async move {
        let db_state = state.clone();
        let outcome = match op_task(move || {
            let mut player = runtime.streamer.blocking_lock();
            if runtime::is_closed(&runtime) {
                return Err(OpError::Missing);
            }
            if player.is_current_id(&id.to_string()) {
                return Err(OpError::Conflict("playing"));
            }
            let outcome = db::delete_room_track(&db_state, user.room_id, id)?;
            if outcome.deleted {
                player.remove_queued_by_id(&id.to_string());
                runtime::bump_library(&runtime);
                runtime::notify(&runtime);
            }
            Ok(outcome)
        })
        .await
        {
            Ok(outcome) => outcome,
            Err(err) => return err.respond("studio.delete_track"),
        };
        if !outcome.deleted {
            return json_message(StatusCode::NOT_FOUND, "missing").into_response();
        }
        if let Some(key) = outcome.cleanup_storage_key {
            media::cleanup_media_artifacts(&state, &key).await;
        }
        json_message(StatusCode::OK, "ok").into_response()
    });
    match command.await {
        Ok(response) => response,
        Err(err) => internal_error_response("studio.delete_track.command", err),
    }
}

/// Canonicalize positive database IDs so aliases such as `01` cannot bypass current-track guards.
fn canonical_id(raw: &str) -> Option<i64> {
    raw.parse().ok().filter(|id| *id > 0)
}

/// Pure identity/guard coverage without database or HTTP fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Alternate numeric spellings resolve to the same protected identity.
    #[test]
    fn id_cases() {
        for (raw, expected) in [
            ("1", Some(1)),
            ("01", Some(1)),
            ("+1", Some(1)),
            ("0", None),
            ("-1", None),
            ("", None),
            (" 1 ", None),
            ("invalid", None),
            ("999999999999999999999999", None),
        ] {
            assert_eq!(canonical_id(raw), expected, "{raw:?}");
        }
    }
}
