//! Public invitation/status/admission surfaces, never presenter authority.

use super::{
    db,
    handlers::{JoinResponse, admit},
    response::{no_store_json, no_store_redirect, unavailable_invitation},
};
use crate::api::{AppState, internal_error_response, json_message, studio_v2};
use axum::{
    Json,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::net::SocketAddr;

/// Public room capability state, not private provider binding data.
#[derive(serde::Serialize)]
struct PublicStatus {
    /// Whether entitlement and owner enablement permit admission.
    enabled: bool,
}

/// Exchange the current public slug for a fresh participant URL and redirect without caching.
pub async fn guest_invite(
    State(state): State<AppState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Response {
    guest_session(state, remote, headers, slug, true).await
}

/// Issue a participant-only JSON session for an enabled room.
pub async fn public_join(
    State(state): State<AppState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Response {
    guest_session(state, remote, headers, slug, false).await
}

/// Share identical atomic throttle and role policy across public session surfaces.
async fn guest_session(
    state: AppState,
    remote: SocketAddr,
    headers: HeaderMap,
    slug: String,
    redirect: bool,
) -> Response {
    if !admit(&state, &headers, remote).await {
        return json_message(StatusCode::TOO_MANY_REQUESTS, "too many attempts").into_response();
    }
    if state.conference_provider.is_none() {
        return json_message(StatusCode::SERVICE_UNAVAILABLE, "conference unavailable")
            .into_response();
    }
    let conference = match lookup(&state, slug).await {
        Ok(Some(conference)) => conference,
        Ok(None) => return unavailable(&headers, redirect),
        Err(error) => return internal_error_response("conference.guest.lookup", error),
    };
    let Some(join_url) = state.conference_provider.as_deref().and_then(|provider| {
        super::policy::joinable(&conference, provider.key())
            .then(|| provider.invitation_url(&conference.room_slug))
    }) else {
        return unavailable(&headers, redirect);
    };
    if redirect {
        no_store_redirect(&join_url)
    } else {
        no_store_json(JoinResponse { join_url })
    }
}

/// Preserve browser-unavailable redirects versus explicit API JSON failures.
fn unavailable(headers: &HeaderMap, redirect: bool) -> Response {
    if redirect {
        unavailable_invitation(headers)
    } else {
        json_message(StatusCode::NOT_FOUND, "conference not found").into_response()
    }
}

/// Report persisted public capability using a current-slug lookup, never historical aliases.
pub async fn public_status(State(state): State<AppState>, Path(slug): Path<String>) -> Response {
    match lookup(&state, slug).await {
        Ok(Some(conference)) => Json(PublicStatus {
            enabled: state
                .conference_provider
                .as_deref()
                .is_some_and(|provider| super::policy::joinable(&conference, provider.key())),
        })
        .into_response(),
        Ok(None) => json_message(StatusCode::NOT_FOUND, "room not found").into_response(),
        Err(error) => internal_error_response("conference.public_status", error),
    }
}

/// Load public room state without blocking async workers.
///
/// # Errors
/// Returns worker/SQL errors; missing slugs remain `None`.
async fn lookup(state: &AppState, slug: String) -> Result<Option<db::Conference>, String> {
    let state = state.clone();
    studio_v2::db_task(move || db::by_slug(&state, &slug)).await
}
