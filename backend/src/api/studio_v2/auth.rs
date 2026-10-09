//! Shared Studio HTTP/WebSocket identity and administrator impersonation policy.

use crate::api::{AppState, auth_v2, db_v2, internal_error_response, json_message};
use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

/// Administrator-selected effective Studio account header.
const STUDIO_AS_USER_HEADER: &str = "x-studio-as-user-id";

/// Optional effective account selected by the Studio state socket URL.
#[derive(serde::Deserialize, Default)]
pub struct StudioAsQuery {
    /// Positive target account ID; absent means the authenticated actor.
    #[serde(rename = "as")]
    pub(crate) as_user_id: Option<i64>,
}

/// Shared Studio authorization failures, independent of HTTP serialization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StudioUserError {
    /// No current authenticated account.
    Unauthorized,
    /// Non-admin attempted to select another effective identity.
    Forbidden,
    /// Target account is missing/inactive.
    Missing,
    /// Target identifier is malformed/nonpositive.
    Invalid,
    /// Operational lookup failure.
    Internal,
}

/// Preserve existing HTTP/WS status mapping for authorization decisions.
pub(crate) fn studio_user_error_status(error: StudioUserError) -> StatusCode {
    match error {
        StudioUserError::Unauthorized => StatusCode::UNAUTHORIZED,
        StudioUserError::Forbidden => StatusCode::FORBIDDEN,
        StudioUserError::Missing => StatusCode::NOT_FOUND,
        StudioUserError::Invalid => StatusCode::BAD_REQUEST,
        StudioUserError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// Preserve browser-facing error wording without leaking operational details.
fn error_message(error: StudioUserError) -> &'static str {
    match error {
        StudioUserError::Unauthorized => "no",
        StudioUserError::Forbidden => "forbidden",
        StudioUserError::Missing => "missing",
        StudioUserError::Invalid => "invalid room",
        StudioUserError::Internal => "auth failed",
    }
}

/// Resolve HTTP identity synchronously for existing off-thread/legacy consumers.
///
/// # Errors
/// Returns a boxed browser response for malformed, denied, missing or failed authorization.
pub(crate) fn studio_user_from_http(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<auth_v2::AuthUser, Box<Response>> {
    let resolve = || resolve_studio_user(state, headers, requested_id(headers)?);
    resolve().map_err(|error| {
        Box::new(
            json_message(studio_user_error_status(error), error_message(error)).into_response(),
        )
    })
}

/// Offload all cookie/JWT/account lookup work for asynchronous Studio handlers.
///
/// # Errors
/// Returns authorization responses or a generic 500 for worker failure.
pub(crate) async fn studio_user_from_http_async(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<auth_v2::AuthUser, Box<Response>> {
    let state = state.clone();
    let headers = headers.clone();
    tokio::task::spawn_blocking(move || studio_user_from_http(&state, &headers))
        .await
        .map_err(|err| Box::new(internal_error_response("studio.authorization.task", err)))?
}

/// Parse the optional positive header without treating malformed text as absence.
///
/// # Errors
/// Returns Invalid for empty, non-text, overflowing or nonpositive IDs.
fn requested_id(headers: &HeaderMap) -> Result<Option<i64>, StudioUserError> {
    let Some(raw) = headers.get(STUDIO_AS_USER_HEADER) else {
        return Ok(None);
    };
    raw.to_str()
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|id| *id > 0)
        .map(Some)
        .ok_or(StudioUserError::Invalid)
}

/// Resolve live owner/admin identity and a validated effective account for either transport.
///
/// # Errors
/// Returns the shared authorization failure; DB failures are logged before failing closed.
pub(crate) fn resolve_studio_user(
    state: &AppState,
    headers: &HeaderMap,
    requested: Option<i64>,
) -> Result<auth_v2::AuthUser, StudioUserError> {
    if requested.is_some_and(|id| id <= 0) {
        return Err(StudioUserError::Invalid);
    }
    let requester =
        auth_v2::auth_user_from_headers(state, headers).ok_or(StudioUserError::Unauthorized)?;
    let Some(target_id) = impersonation_target(requester.user_id, &requester.role, requested)?
    else {
        return Ok(requester);
    };
    let target = db_v2::get_user_by_id(state, target_id)
        .map_err(|error| {
            tracing::error!(%error, "studio effective account lookup failed");
            StudioUserError::Internal
        })?
        .filter(|target| target.is_active)
        .ok_or(StudioUserError::Missing)?;
    Ok(auth_v2::AuthUser {
        user_id: target.id,
        login: target.login,
        role: target.role,
        room_id: target.room_id,
        room_slug: target.room_slug,
        room_listed: target.room_listed,
    })
}

/// Decide whether an administrator needs a target lookup; non-admin overrides stay forbidden.
///
/// # Errors
/// Rejects nonpositive targets and any non-admin override, including a self override.
fn impersonation_target(
    actor: i64,
    role: &str,
    requested: Option<i64>,
) -> Result<Option<i64>, StudioUserError> {
    let Some(id) = requested else {
        return Ok(None);
    };
    if id <= 0 {
        return Err(StudioUserError::Invalid);
    }
    if role != "admin" {
        return Err(StudioUserError::Forbidden);
    }
    Ok((id != actor).then_some(id))
}

/// Pure authorization/header/status branch tables; no account/database fixtures.
#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    /// HTTP and query override policies cover absent, self, other, role and invalid cases.
    #[test]
    fn override_cases() {
        for (role, requested, expected) in [
            ("user", None, Ok(None)),
            ("admin", None, Ok(None)),
            ("admin", Some(1), Ok(None)),
            ("admin", Some(2), Ok(Some(2))),
            ("user", Some(1), Err(StudioUserError::Forbidden)),
            ("user", Some(2), Err(StudioUserError::Forbidden)),
            ("admin", Some(0), Err(StudioUserError::Invalid)),
            ("admin", Some(-1), Err(StudioUserError::Invalid)),
        ] {
            assert_eq!(impersonation_target(1, role, requested), expected);
        }
        for (raw, expected) in [
            (None, Ok(None)),
            (Some("2"), Ok(Some(2))),
            (Some(" 2 "), Ok(Some(2))),
            (Some(""), Err(StudioUserError::Invalid)),
            (Some("0"), Err(StudioUserError::Invalid)),
            (Some("-1"), Err(StudioUserError::Invalid)),
            (Some("invalid"), Err(StudioUserError::Invalid)),
            (
                Some("999999999999999999999999"),
                Err(StudioUserError::Invalid),
            ),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(raw) = raw {
                headers.insert(STUDIO_AS_USER_HEADER, HeaderValue::from_str(raw).unwrap());
            }
            assert_eq!(requested_id(&headers), expected);
        }
    }

    /// Every shared failure variant retains its explicit status contract.
    #[test]
    fn error_status_cases() {
        for (error, status) in [
            (StudioUserError::Unauthorized, StatusCode::UNAUTHORIZED),
            (StudioUserError::Forbidden, StatusCode::FORBIDDEN),
            (StudioUserError::Missing, StatusCode::NOT_FOUND),
            (StudioUserError::Invalid, StatusCode::BAD_REQUEST),
            (StudioUserError::Internal, StatusCode::INTERNAL_SERVER_ERROR),
        ] {
            assert_eq!(studio_user_error_status(error), status);
            assert!(!error_message(error).is_empty());
        }
    }
}
