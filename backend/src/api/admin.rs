//! Administrator commands with off-thread authorization and persistence.

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

use crate::api::{
    AppState, auth, blocking, db, internal_error_response, json_message, media, op_error::OpError,
    runtime, util,
};

/// Browser-facing account/room summary; excludes password hashes and credentials.
#[derive(serde::Serialize)]
struct UserRow {
    /// Account identifier.
    id: i64,
    /// Account login.
    login: String,
    /// Current authorization role.
    role: String,
    /// Public room slug.
    room_slug: String,
    /// Public directory visibility.
    room_listed: bool,
    /// Administrator-granted conference entitlement.
    conference_allowed: bool,
    /// Account creation timestamp.
    created_at: String,
}

/// Administrator-selected replacement password.
#[derive(serde::Deserialize)]
pub struct ResetPasswordPayload {
    /// Plaintext password to validate and hash off-thread.
    password: String,
}

/// Administrator-selected public room preferences.
#[derive(serde::Deserialize)]
pub struct UpdateRoomPayload {
    /// Requested public slug, normalized before persistence.
    room: String,
    /// Whether to list the room publicly.
    listed: bool,
}

/// Administrator-controlled conference entitlement, independent of owner enablement.
#[derive(serde::Deserialize)]
pub struct SetConferenceAccessPayload {
    /// Desired entitlement.
    allowed: bool,
}

/// Authoritative room preferences after an administrator mutation.
#[derive(serde::Serialize)]
struct UpdateRoomResponse {
    /// Persisted public slug.
    room_slug: String,
    /// Persisted directory visibility.
    room_listed: bool,
}

/// List account/room summaries for an authenticated administrator.
pub async fn users(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if require_admin(&state, &headers).await.is_none() {
        return json_message(StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let load = move || {
        db::list_admin_users(&state)?
            .into_iter()
            .map(|row| {
                let conference_allowed =
                    crate::api::conference::allowed_by_user_id(&state, row.id)?
                        .ok_or_else(|| "room missing".to_owned())?;
                Ok(UserRow {
                    id: row.id,
                    login: row.login,
                    role: row.role,
                    room_slug: row.room_slug,
                    room_listed: row.room_listed,
                    conference_allowed,
                    created_at: row.created_at,
                })
            })
            .collect::<Result<Vec<_>, String>>()
    };
    match blocking::db_task(load).await {
        Ok(rows) => Json(rows).into_response(),
        Err(err) => internal_error_response("admin.users", err),
    }
}

/// Grant/revoke conference capability through the provider-neutral service.
pub async fn set_conference_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(user_id): Path<i64>,
    Json(payload): Json<SetConferenceAccessPayload>,
) -> Response {
    if require_admin(&state, &headers).await.is_none() {
        return json_message(StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    match crate::api::conference::set_access(&state, user_id, payload.allowed).await {
        Ok(true) => Json(serde_json::json!({ "allowed": payload.allowed })).into_response(),
        Ok(false) => json_message(StatusCode::NOT_FOUND, "missing").into_response(),
        Err(err) => internal_error_response("admin.set_conference_access", err),
    }
}

/// Validate/hash/persist a replacement password without blocking async workers.
pub async fn reset_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(user_id): Path<i64>,
    Json(payload): Json<ResetPasswordPayload>,
) -> Response {
    if require_admin(&state, &headers).await.is_none() {
        return json_message(StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    if let Err(message) = auth::validate_password(&payload.password, None) {
        return json_message(StatusCode::BAD_REQUEST, message).into_response();
    }
    let reset = move || {
        let hash = auth::hash_password(&payload.password)?;
        db::reset_user_password(&state, user_id, &hash)
    };
    match blocking::db_task(reset).await {
        Ok(true) => json_message(StatusCode::OK, "ok").into_response(),
        Ok(false) => json_message(StatusCode::NOT_FOUND, "missing").into_response(),
        Err(err) => internal_error_response("admin.reset_password", err),
    }
}

/// Delete another account off-thread, then release its runtime and stored uploads.
pub async fn delete_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(user_id): Path<i64>,
) -> Response {
    let Some(admin) = require_admin(&state, &headers).await else {
        return json_message(StatusCode::FORBIDDEN, "forbidden").into_response();
    };
    if admin.user_id == user_id {
        return json_message(StatusCode::BAD_REQUEST, "cannot delete yourself").into_response();
    }
    match tokio::spawn(delete_user_command(state, user_id)).await {
        Ok(response) => response,
        Err(err) => internal_error_response("admin.delete_user.command", err),
    }
}

/// Own a permitted deletion and all dependent cleanup through request cancellation.
async fn delete_user_command(state: AppState, user_id: i64) -> Response {
    let command_state = state.clone();
    let delete = move || {
        let room = db::get_user_by_id(&command_state, user_id)?.map(|user| user.room_id);
        let keys = db::delete_user_and_collect_assets(&command_state, user_id)?;
        Ok((room, keys))
    };
    let (room, assets) = match blocking::db_task(delete).await {
        Ok(result) => result,
        Err(err) => return internal_error_response("admin.delete_user", err),
    };
    if let Some(room) = room {
        runtime::evict_room(&state, room).await;
        if let Err(error) = crate::api::conference::cleanup_room(&state, room).await {
            tracing::warn!(%error, "deleted user conference cleanup remains queued");
        }
    }
    for key in assets {
        media::cleanup_media_artifacts(&state, &key).await;
    }
    json_message(StatusCode::OK, "ok").into_response()
}

/// Change room preferences and update an existing runtime without holding its map lock.
pub async fn update_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(user_id): Path<i64>,
    Json(payload): Json<UpdateRoomPayload>,
) -> Response {
    if require_admin(&state, &headers).await.is_none() {
        return json_message(StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let Some(slug) = util::normalize_slug(&payload.room) else {
        return json_message(StatusCode::BAD_REQUEST, "invalid slug").into_response();
    };
    let command_state = state.clone();
    let update = move || -> Result<Option<db::UserRecord>, OpError> {
        let Some(target) = db::get_user_by_id(&command_state, user_id)? else {
            return Ok(None);
        };
        let runtime = {
            command_state
                .runtimes
                .blocking_lock()
                .get(&target.room_id)
                .cloned()
        };
        let mut current_slug = runtime
            .as_ref()
            .map(|runtime| runtime.room_slug.blocking_lock());
        if !db::update_user_room(&command_state, user_id, &slug, payload.listed)? {
            return Ok(None);
        }
        let user = db::get_user_by_id(&command_state, user_id)?;
        if let (Some(current), Some(user)) = (&mut current_slug, &user) {
            **current = user.room_slug.clone();
        }
        if let Some(runtime) = &runtime {
            runtime::notify(runtime);
        }
        Ok(user)
    };
    let user = match blocking::op_task(update).await {
        Ok(Some(user)) => user,
        Ok(None) => return json_message(StatusCode::NOT_FOUND, "missing").into_response(),
        Err(err) => return err.respond("admin.update_room"),
    };
    Json(UpdateRoomResponse {
        room_slug: user.room_slug,
        room_listed: user.room_listed,
    })
    .into_response()
}

/// Resolve the live administrator on a blocking worker; lookup/task errors fail closed.
async fn require_admin(state: &AppState, headers: &HeaderMap) -> Option<auth::AuthUser> {
    let state = state.clone();
    let headers = headers.clone();
    match tokio::task::spawn_blocking(move || auth::auth_user_from_headers(&state, &headers)).await
    {
        Ok(user) => user.filter(|user| user.role == "admin"),
        Err(error) => {
            tracing::error!(%error, "admin authorization task failed");
            None
        }
    }
}
