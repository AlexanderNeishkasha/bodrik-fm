//! Authentication endpoints, cookie issuance, and effective Studio identity.

use std::{
    net::SocketAddr,
    time::{SystemTime, UNIX_EPOCH},
};

use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation};

use crate::api::{AppState, blocking, db, internal_error_response, json_message};

mod client;
mod cookies;
mod password_policy;
mod rate_limiter;
pub(crate) use password_policy::validate as validate_password;
#[cfg(test)]
mod tests;
pub(crate) use client::client_key;
pub(crate) use cookies::append_clear_auth_cookies;
use cookies::{append_auth_cookies, token_from_headers};
pub use rate_limiter::LoginRateLimiter;

/// Active database identity resolved from a signed authentication cookie.
#[derive(Debug, Clone)]
pub struct AuthUser {
    /// Database user identifier.
    pub user_id: i64,
    /// Current account login.
    pub login: String,
    /// Current authorization role, not the possibly stale token role.
    pub role: String,
    /// Room owned by this account.
    pub room_id: i64,
    /// Public room URL segment.
    pub room_slug: String,
    /// Whether the room appears in the public directory.
    pub room_listed: bool,
}

/// Account registration input; validation precedes hashing and persistence.
#[derive(Debug, serde::Deserialize)]
pub struct RegisterRequest {
    /// Requested login, normalized before use.
    login: String,
    /// Plaintext password, accepted only at 4–128 UTF-8 bytes.
    password: String,
    /// Optional confirmation that must match the password.
    confirm_password: Option<String>,
}

/// Credentials submitted to the login endpoint.
#[derive(Debug, serde::Deserialize)]
pub struct LoginRequest {
    /// Account login, normalized before lookup.
    login: String,
    /// Plaintext password used only for verification.
    password: String,
}

/// Browser identity response, distinguishing impersonation from actor privileges.
#[derive(Debug, serde::Serialize)]
struct MePayload {
    /// Effective account login.
    login: String,
    /// Effective account role.
    role: String,
    /// Role of the authenticated actor before impersonation.
    actor_role: String,
    /// Effective account's public room URL segment.
    room_slug: String,
    /// Whether that room is publicly listed.
    room_listed: bool,
}

/// Signed session claims; authorization reloads the current database record.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct Claims {
    /// Account identifier used for database lookup.
    sub: i64,
    /// Login at token issuance.
    login: String,
    /// Role at token issuance, not authoritative for subsequent requests.
    role: String,
    /// Expiration as Unix seconds.
    exp: u64,
}

/// Optional admin-selected effective Studio account identifier.
const STUDIO_AS_USER_HEADER: &str = "x-studio-as-user-id";

/// Validate registration and create an account/room on blocking workers.
/// Returns an auth cookie on success, or validation, conflict, throttle, or server errors.
pub async fn register(
    State(state): State<AppState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<RegisterRequest>,
) -> impl IntoResponse {
    let client_key = client_key(&headers, Some(remote.ip()), state.trust_proxy_headers);
    if !state
        .login_rate_limiter
        .try_record_attempt(&client_key)
        .await
    {
        return json_message(StatusCode::TOO_MANY_REQUESTS, "too many attempts").into_response();
    }
    let Some(login) = crate::api::util::normalize_login(&payload.login) else {
        return json_message(StatusCode::BAD_REQUEST, "invalid login").into_response();
    };

    if let Err(message) = validate_password(&payload.password, payload.confirm_password.as_deref())
    {
        return json_message(StatusCode::BAD_REQUEST, message).into_response();
    }

    let password_hash = match blocking::db_task(move || hash_password(&payload.password)).await {
        Ok(value) => value,
        Err(err) => {
            return internal_error_response("auth.register.hash_password", err);
        }
    };

    let db_state = state.clone();
    let user = match blocking::op_task(move || {
        db::create_user_with_room(&db_state, &login, &password_hash)
    })
    .await
    {
        Ok(user) => user,
        Err(err) => return err.respond("auth.register.create_user"),
    };

    state.login_rate_limiter.reset(&client_key).await;
    issue_auth_cookie(&state, &user)
}

/// Look up and verify credentials on a blocking worker, then issue an auth cookie.
/// Invalid/inactive accounts share a 401 response; throttling returns 429.
pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> impl IntoResponse {
    let client_key = client_key(&headers, Some(remote.ip()), state.trust_proxy_headers);
    if !state
        .login_rate_limiter
        .try_record_attempt(&client_key)
        .await
    {
        return json_message(StatusCode::TOO_MANY_REQUESTS, "too many attempts").into_response();
    }
    let Some(login) = crate::api::util::normalize_login(&payload.login) else {
        return json_message(StatusCode::UNAUTHORIZED, "invalid credentials").into_response();
    };

    let db_state = state.clone();
    let Some(user) = (match blocking::db_task(move || {
        let user = db::get_user_by_login(&db_state, &login)?;
        Ok(user.filter(|user| {
            user.is_active && verify_password(&user.password_hash, &payload.password)
        }))
    })
    .await
    {
        Ok(user) => user,
        Err(err) => {
            return internal_error_response("auth.login.lookup_user", err);
        }
    }) else {
        return json_message(axum::http::StatusCode::UNAUTHORIZED, "invalid credentials")
            .into_response();
    };

    state.login_rate_limiter.reset(&client_key).await;
    issue_auth_cookie(&state, &user)
}

/// Return current identity, including an admin's optional effective Studio account.
pub async fn me(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    match tokio::task::spawn_blocking(move || me_response(state, headers)).await {
        Ok(response) => response,
        Err(err) => internal_error_response("auth.me.task", err),
    }
}

/// Load authenticated/effective identities and serialize them on a blocking worker.
fn me_response(state: AppState, headers: HeaderMap) -> axum::response::Response {
    let Some(requester) = auth_user_from_headers(&state, &headers) else {
        return json_message(axum::http::StatusCode::UNAUTHORIZED, "no").into_response();
    };
    let requester_role = requester.role.clone();
    let user = match resolve_effective_me_user(&state, &headers, requester) {
        Ok(user) => user,
        Err((status, message)) => return json_message(status, message).into_response(),
    };
    let payload = MePayload {
        login: user.login,
        role: user.role,
        actor_role: requester_role,
        room_slug: user.room_slug,
        room_listed: user.room_listed,
    };
    (axum::http::StatusCode::OK, Json(payload)).into_response()
}

/// Resolve admin impersonation while leaving non-admin identities unchanged.
///
/// # Errors
/// Returns HTTP error details for invalid headers, unavailable accounts, or DB failures.
fn resolve_effective_me_user(
    state: &AppState,
    headers: &HeaderMap,
    requester: AuthUser,
) -> Result<AuthUser, (StatusCode, &'static str)> {
    let as_user_id = requested_as_user_id_from_headers(headers)?;
    let Some(as_user_id) = as_user_id else {
        return Ok(requester);
    };
    if requester.role != "admin" || as_user_id == requester.user_id {
        return Ok(requester);
    }
    let target = db::get_user_by_id(state, as_user_id)
        .map_err(|err| {
            tracing::error!("auth.me.as_user_lookup: {err}");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?
        .ok_or((StatusCode::NOT_FOUND, "missing"))?;
    if !target.is_active {
        return Err((StatusCode::NOT_FOUND, "missing"));
    }
    Ok(AuthUser {
        user_id: target.id,
        login: target.login,
        role: target.role,
        room_id: target.room_id,
        room_slug: target.room_slug,
        room_listed: target.room_listed,
    })
}

/// Read the optional positive account identifier from the Studio override header.
///
/// # Errors
/// Returns a 400 error for non-text, empty, nonnumeric, or nonpositive identifiers.
fn requested_as_user_id_from_headers(
    headers: &HeaderMap,
) -> Result<Option<i64>, (StatusCode, &'static str)> {
    let Some(raw) = headers.get(STUDIO_AS_USER_HEADER) else {
        return Ok(None);
    };
    let value = raw
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or((StatusCode::BAD_REQUEST, "invalid user"))?;
    let parsed = value
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or((StatusCode::BAD_REQUEST, "invalid user"))?;
    Ok(Some(parsed))
}

/// Clear all supported authentication cookies in the browser response.
pub async fn logout() -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    append_clear_auth_cookies(&mut headers);
    (
        headers,
        Json(crate::api::ApiMessage {
            message: "ok".to_string(),
        }),
    )
}

/// Verify a cookie and load its active account, failing closed on invalid credentials.
/// Performs synchronous database I/O; async callers should offload blocking work.
pub fn auth_user_from_headers(state: &AppState, headers: &HeaderMap) -> Option<AuthUser> {
    let token = token_from_headers(headers)?;
    let claims = verify_token(&state.jwt_secret, &token)?;
    let user = match db::get_user_by_id(state, claims.sub) {
        Ok(user) => user?,
        Err(err) => {
            tracing::error!(error = %err, "auth cookie account lookup failed");
            return None;
        }
    };
    if !user.is_active {
        return None;
    }
    Some(AuthUser {
        user_id: user.id,
        login: user.login,
        role: user.role,
        room_id: user.room_id,
        room_slug: user.room_slug,
        room_listed: user.room_listed,
    })
}

/// Produce a salted Argon2 password hash; this CPU-heavy operation is synchronous.
///
/// # Errors
/// Returns the Argon2 error if hashing fails.
pub(crate) fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| err.to_string())
}

/// Verify an Argon2 hash, rejecting malformed hashes and mismatched passwords.
/// This CPU-heavy operation must run off the async executor.
pub(crate) fn verify_password(hash: &str, password: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// Sign the session and append cookies, returning a generic 500 if signing fails.
fn issue_auth_cookie(state: &AppState, user: &db::UserRecord) -> axum::response::Response {
    let token = match create_token(&state.jwt_secret, user) {
        Ok(value) => value,
        Err(err) => {
            return internal_error_response("auth.issue_auth_cookie.create_token", err);
        }
    };
    let mut headers = HeaderMap::new();
    if let Err(err) = append_auth_cookies(&mut headers, &token) {
        return internal_error_response("auth.issue_auth_cookie.header", err);
    }
    (headers, Json(me_payload_from_record(user))).into_response()
}

/// Build a non-impersonated browser identity from the authoritative user record.
fn me_payload_from_record(user: &db::UserRecord) -> MePayload {
    MePayload {
        login: user.login.clone(),
        role: user.role.clone(),
        actor_role: user.role.clone(),
        room_slug: user.room_slug.clone(),
        room_listed: user.room_listed,
    }
}

/// Sign an HS256 session for the account using the application secret.
///
/// # Errors
/// Returns the JWT encoding error if the claims cannot be signed.
fn create_token(
    secret: &str,
    user: &db::UserRecord,
) -> Result<String, jsonwebtoken::errors::Error> {
    let claims = Claims {
        sub: user.id,
        login: user.login.clone(),
        role: user.role.clone(),
        exp: token_expiry(),
    };
    jsonwebtoken::encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

/// Validate the token signature and expiry, returning no claims on failure.
fn verify_token(secret: &str, token: &str) -> Option<Claims> {
    let mut validation = Validation::default();
    validation.validate_exp = true;
    jsonwebtoken::decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()
    .map(|value| value.claims)
}

/// Calculate the existing ten-year session lifetime as Unix seconds.
fn token_expiry() -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    now.saturating_add(315_360_000)
}
