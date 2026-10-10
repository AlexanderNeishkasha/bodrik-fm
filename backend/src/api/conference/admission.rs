//! Read-only admission authority shared by embedded meetings and standalone compatibility HTTP.

use super::{db, policy};
use crate::api::{AppState, blocking, internal_error_response, json_message};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use std::sync::Arc;
use subtle::ConstantTimeEq;

/// Maximum lifetime of a positive room grant; immediate revocation remains independent.
const GRANT_LEASE_SECONDS: u32 = 60;

/// Authoritative private-service dependencies, never exposed through browser state.
#[derive(Clone)]
struct Authority {
    /// Existing player-owned persistence/provider state.
    app: AppState,
    /// Independent service credential; absence explicitly disables this endpoint.
    secret: Option<Arc<str>>,
}

/// Current admission lease; no account, queue, host password or provider secret data.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Grant {
    /// Private interservice contract version.
    pub version: u8,
    /// Exact current provider mapping requested by the service.
    pub conference_id: String,
    /// Persisted revocation generation, not a process-local event sequence.
    pub generation: i64,
    /// Canonical current invitation slug for safe browser routing.
    pub room_slug: String,
    /// Upper bound for an already-admitted session's positive cache.
    pub lease_seconds: u32,
}

/// Compose a separately authenticated read-only route without changing AppState/session cookies.
pub(crate) fn routes(app: AppState, secret: Option<Arc<str>>) -> Router {
    Router::new()
        .route("/api/internal/conferences/{id}/admission", get(admission))
        .with_state(Authority { app, secret })
}

/// Reject missing/malformed bearer credentials in constant time for equal-length values.
pub(super) fn authorized(headers: &HeaderMap, secret: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| bool::from(value.as_bytes().ct_eq(secret.as_bytes())))
}

/// Authorize only a still-current enabled/entitled provider mapping, including after account deletion.
async fn admission(
    State(state): State<Authority>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(secret) = state.secret.as_deref() else {
        return json_message(
            StatusCode::SERVICE_UNAVAILABLE,
            "meeting authority disabled",
        )
        .into_response();
    };
    if !authorized(&headers, secret) {
        return json_message(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    if !valid_id(&id) {
        return json_message(StatusCode::BAD_REQUEST, "invalid conference binding").into_response();
    }
    let grant = match grant(&state.app, id).await {
        Ok(Some(value)) => value,
        Ok(None) => {
            return json_message(StatusCode::NOT_FOUND, "conference unavailable").into_response();
        }
        Err(error) => return internal_error_response("conference.admission.lookup", error),
    };
    let mut response = Json(grant).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

/// Fresh domain admission used by HTTP and direct meeting integration.
///
/// # Errors
/// Rejects malformed IDs, database failures and unsafe generation ranges.
pub(crate) async fn grant(app: &AppState, id: String) -> Result<Option<Grant>, String> {
    if !valid_id(&id) {
        return Err("invalid conference binding".into());
    }
    let lookup = app.clone();
    let lookup_id = id.clone();
    let Some(conference) =
        blocking::db_task(move || db::by_provider_id(&lookup, &lookup_id)).await?
    else {
        return Ok(None);
    };
    if !app
        .conference_provider
        .as_deref()
        .is_some_and(|provider| policy::joinable(&conference, provider.key()))
    {
        return Ok(None);
    }
    if !(0..=9_007_199_254_740_991_i64).contains(&conference.generation) {
        return Err("generation outside wire range".into());
    }
    Ok(Some(Grant {
        version: 1,
        conference_id: id,
        generation: conference.generation,
        room_slug: conference.room_slug,
        lease_seconds: GRANT_LEASE_SECONDS,
    }))
}

/// Accept only bounded provider identifiers shared by both integration transports.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"_.:-".contains(&v))
}

/// Authentication tables use synthetic credentials without opening a database or HTTP listener.
#[cfg(test)]
mod tests {
    use super::*;

    /// Missing, wrong scheme, wrong length and wrong value never authorize the read-only service API.
    #[test]
    fn service_bearer_cases() {
        let secret = "synthetic-service-secret-32-characters";
        for (name, value, accepted) in [
            ("missing", None, false),
            ("empty", Some("Bearer "), false),
            (
                "wrong scheme",
                Some("Basic synthetic-service-secret-32-characters"),
                false,
            ),
            (
                "wrong value",
                Some("Bearer another-service-secret-32-characters"),
                false,
            ),
            (
                "valid",
                Some("Bearer synthetic-service-secret-32-characters"),
                true,
            ),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(value) = value {
                headers.insert(header::AUTHORIZATION, value.parse().expect("test header"));
            }
            assert_eq!(authorized(&headers, secret), accepted, "{name}");
        }
    }
}
