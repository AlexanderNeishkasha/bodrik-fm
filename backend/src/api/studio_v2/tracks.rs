//! Room-owned track listing/mutations, serialized against playback without async lock guards.

use super::{
    auth::studio_user_from_http_async,
    context::{action_runtime, db_task},
    types::{DeletePayload, RenamePayload},
};
use crate::api::{
    AppState, db_v2, internal_error_response, json_message, media_v2, runtime_v2, util_v2,
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
    match db_task(move || db_v2::list_room_tracks(&state, user.room_id)).await {
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
    let Some(title) = util_v2::normalize_room_track_title(&payload.to) else {
        return json_message(StatusCode::BAD_REQUEST, "invalid name").into_response();
    };
    match db_task(move || {
        let mut player = runtime.streamer.blocking_lock();
        if runtime_v2::is_closed(&runtime) {
            return Err("missing".into());
        }
        if player.is_current_id(&id.to_string()) {
            return Err("playing".into());
        }
        let changed = db_v2::rename_room_track(&state, user.room_id, id, &title)?;
        if changed {
            player.rename_track_by_id(&id.to_string(), &title);
            runtime_v2::bump_library(&runtime);
            runtime_v2::notify(&runtime);
        }
        Ok(changed)
    })
    .await
    {
        Ok(true) => json_message(StatusCode::OK, "ok").into_response(),
        Ok(false) => json_message(StatusCode::NOT_FOUND, "missing").into_response(),
        Err(err) if err == "missing" => {
            json_message(StatusCode::NOT_FOUND, "missing").into_response()
        }
        Err(err) if err == "playing" || err == "name exists" => {
            json_message(StatusCode::CONFLICT, err).into_response()
        }
        Err(err) => internal_error_response("studio.rename_track", err),
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
        let outcome = match db_task(move || {
            let mut player = runtime.streamer.blocking_lock();
            if runtime_v2::is_closed(&runtime) {
                return Err("missing".into());
            }
            if player.is_current_id(&id.to_string()) {
                return Err("playing".into());
            }
            let outcome = db_v2::delete_room_track(&db_state, user.room_id, id)?;
            if outcome.deleted {
                player.remove_queued_by_id(&id.to_string());
                runtime_v2::bump_library(&runtime);
                runtime_v2::notify(&runtime);
            }
            Ok(outcome)
        })
        .await
        {
            Ok(outcome) => outcome,
            Err(err) if err == "playing" => {
                return json_message(StatusCode::CONFLICT, "playing").into_response();
            }
            Err(err) if err == "missing" => {
                return json_message(StatusCode::NOT_FOUND, "missing").into_response();
            }
            Err(err) => return internal_error_response("studio.delete_track", err),
        };
        if !outcome.deleted {
            return json_message(StatusCode::NOT_FOUND, "missing").into_response();
        }
        if let Some(key) = outcome.cleanup_storage_key {
            media_v2::cleanup_media_artifacts(&state, &key).await;
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
