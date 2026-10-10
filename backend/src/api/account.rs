//! Account commands; synchronous authorization/password/SQLite work runs off-thread.

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

use crate::api::{AppState, auth, db, internal_error_response, json_message, media};

/// Owner-confirmed password replacement.
#[derive(serde::Deserialize)]
pub struct ChangePasswordPayload {
    /// Existing plaintext password used only for verification.
    current_password: String,
    /// New plaintext password to validate and hash.
    new_password: String,
    /// Optional exact confirmation of the new password.
    confirm_password: Option<String>,
}

/// Credentials required before deleting a non-admin account.
#[derive(serde::Deserialize)]
pub struct DeleteAccountPayload {
    /// Existing password used only for verification.
    current_password: String,
}

/// Verify and replace the owner's password on a blocking worker.
pub async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ChangePasswordPayload>,
) -> Response {
    match tokio::task::spawn_blocking(move || change_password_sync(&state, &headers, payload)).await
    {
        Ok(response) => response,
        Err(err) => internal_error_response("account.change_password.task", err),
    }
}

/// Apply password policy, authenticate the owner, and persist a salted hash.
fn change_password_sync(
    state: &AppState,
    headers: &HeaderMap,
    payload: ChangePasswordPayload,
) -> Response {
    let Some(user) = auth::auth_user_from_headers(state, headers) else {
        return json_message(StatusCode::UNAUTHORIZED, "no").into_response();
    };
    if let Err(message) =
        auth::validate_password(&payload.new_password, payload.confirm_password.as_deref())
    {
        return json_message(StatusCode::BAD_REQUEST, message).into_response();
    }
    let record = match load_active_user(state, user.user_id) {
        Ok(Some(record)) => record,
        Ok(None) => return json_message(StatusCode::UNAUTHORIZED, "no").into_response(),
        Err(err) => return internal_error_response("account.change_password.lookup", err),
    };
    if !auth::verify_password(&record.password_hash, &payload.current_password) {
        return json_message(StatusCode::UNAUTHORIZED, "invalid credentials").into_response();
    }
    let hash = match auth::hash_password(&payload.new_password) {
        Ok(hash) => hash,
        Err(err) => return internal_error_response("account.change_password.hash", err),
    };
    match db::reset_user_password(state, user.user_id, &hash) {
        Ok(true) => json_message(StatusCode::OK, "ok").into_response(),
        Ok(false) => json_message(StatusCode::NOT_FOUND, "missing").into_response(),
        Err(err) => internal_error_response("account.change_password.save", err),
    }
}

/// Delete a verified account off-thread, then evict its runtime and clean media.
pub async fn delete_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<DeleteAccountPayload>,
) -> Response {
    match tokio::spawn(delete_account_command(state, headers, payload)).await {
        Ok(response) => response,
        Err(err) => internal_error_response("account.delete.command", err),
    }
}

/// Own deletion, runtime eviction and media cleanup even after HTTP cancellation.
async fn delete_account_command(
    state: AppState,
    headers: HeaderMap,
    payload: DeleteAccountPayload,
) -> Response {
    let command_state = state.clone();
    let (room_id, assets) = match tokio::task::spawn_blocking(move || {
        delete_account_sync(&command_state, &headers, payload)
    })
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(response)) => return *response,
        Err(err) => return internal_error_response("account.delete.task", err),
    };
    crate::api::runtime::evict_room(&state, room_id).await;
    if let Err(error) = crate::api::conference::cleanup_room(&state, room_id).await {
        tracing::warn!(%error, "deleted account conference cleanup remains queued");
    }
    for key in assets {
        media::cleanup_media_artifacts(&state, &key).await;
    }
    let mut response = json_message(StatusCode::OK, "ok").into_response();
    auth::append_clear_auth_cookies(response.headers_mut());
    response
}

/// Verify deletion credentials and atomically collect the deleted room's uploads.
///
/// # Errors
/// Returns an HTTP error for unauthorized/admin accounts, credentials or DB failures.
fn delete_account_sync(
    state: &AppState,
    headers: &HeaderMap,
    payload: DeleteAccountPayload,
) -> Result<(i64, Vec<String>), Box<Response>> {
    let user = auth::auth_user_from_headers(state, headers)
        .ok_or_else(|| Box::new(json_message(StatusCode::UNAUTHORIZED, "no").into_response()))?;
    let record = load_active_user(state, user.user_id)
        .map_err(|err| Box::new(internal_error_response("account.delete.lookup", err)))?
        .ok_or_else(|| Box::new(json_message(StatusCode::UNAUTHORIZED, "no").into_response()))?;
    if record.role == "admin" {
        return Err(Box::new(
            json_message(StatusCode::BAD_REQUEST, "cannot delete admin account").into_response(),
        ));
    }
    if !auth::verify_password(&record.password_hash, &payload.current_password) {
        return Err(Box::new(
            json_message(StatusCode::UNAUTHORIZED, "invalid credentials").into_response(),
        ));
    }
    let assets = db::delete_user_and_collect_assets(state, user.user_id)
        .map_err(|err| Box::new(internal_error_response("account.delete.delete_user", err)))?;
    Ok((record.room_id, assets))
}

/// Load an active account without converting operational failures into absence.
///
/// # Errors
/// Returns the database lookup error.
fn load_active_user(state: &AppState, user_id: i64) -> Result<Option<db::UserRecord>, String> {
    Ok(db::get_user_by_id(state, user_id)?.filter(|user| user.is_active))
}
