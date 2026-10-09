//! Authenticated Studio conference commands and provider-neutral response shapes.

use super::{db, service};
use crate::api::{
    AppState, auth_v2, internal_error_response, json_message, room_settings, runtime_v2, studio_v2,
};
use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::net::SocketAddr;

/// Studio conference settings, excluding private provider IDs/tokens.
#[derive(serde::Serialize)]
struct StudioStatus {
    /// Administrator entitlement.
    allowed: bool,
    /// Owner enablement, constrained by entitlement.
    enabled: bool,
    /// Readable current slug invitation, not a token-bearing URL.
    invite_url: Option<String>,
}

/// Session response returned only after grant revalidation.
#[derive(serde::Serialize)]
pub(super) struct JoinResponse {
    /// Fresh room-bound provider URL, deliberately not logged/cached.
    pub(super) join_url: String,
}

/// Owner enablement input.
#[derive(serde::Deserialize)]
pub struct SetEnabledRequest {
    /// Desired state, independent of administrator entitlement.
    enabled: bool,
}

/// Audible surface input, not a local client mute/volume change.
#[derive(serde::Deserialize)]
pub struct SetMusicOutputRequest {
    /// Studio or conference.
    output: String,
}

/// Meeting-wide master gain input.
#[derive(serde::Deserialize)]
pub struct SetMusicVolumeRequest {
    /// Finite unit-interval gain.
    volume: f64,
}

/// Load current Studio state after off-thread live identity/ownership resolution.
pub async fn studio_status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user = match studio_v2::studio_user_from_http_async(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return *response,
    };
    match room_state(&state, user.room_id).await {
        Ok(Some(conference)) => Json(status_payload(&state, conference)).into_response(),
        Ok(None) => json_message(StatusCode::NOT_FOUND, "room not found").into_response(),
        Err(error) => internal_error_response("conference.studio_status", error),
    }
}

/// Persist enablement/revocation as an owned command and expose no private bindings.
pub async fn set_enabled(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SetEnabledRequest>,
) -> Response {
    let user = match studio_v2::studio_user_from_http_async(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return *response,
    };
    match room_state(&state, user.room_id).await {
        Ok(Some(conference)) if conference.allowed => {}
        Ok(Some(_)) => {
            return json_message(StatusCode::FORBIDDEN, "conference not allowed").into_response();
        }
        Ok(None) => return json_message(StatusCode::NOT_FOUND, "room not found").into_response(),
        Err(error) => return internal_error_response("conference.set_enabled.access", error),
    }
    match service::set_enabled(&state, user.room_id, payload.enabled).await {
        Ok(conference) => Json(status_payload(&state, conference)).into_response(),
        Err(error) => internal_error_response("conference.set_enabled", error),
    }
}

/// Serialize entitlement checks, output persistence and mirroring with conference commands.
pub async fn set_music_output(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SetMusicOutputRequest>,
) -> Response {
    let user = match studio_v2::studio_user_from_http_async(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return *response,
    };
    if !matches!(payload.output.as_str(), "studio" | "conference") {
        return json_message(StatusCode::BAD_REQUEST, "invalid music output").into_response();
    }
    let runtime = match runtime_v2::ensure_room_runtime(&state, user.room_id).await {
        Ok(runtime) => runtime,
        Err(error) => return internal_error_response("conference.output.runtime", error),
    };
    let output = payload.output.clone();
    match studio_v2::db_task(move || {
        let mut current = runtime.music_output.blocking_lock();
        let conference = db::by_room_id(&state, user.room_id)?.ok_or("conference disabled")?;
        if !conference.allowed || !conference.enabled {
            return Err("conference disabled".into());
        }
        room_settings::set_music_output(&state, user.room_id, &output)?;
        *current = output;
        runtime_v2::notify_music(&runtime);
        Ok(())
    })
    .await
    {
        Ok(()) => Json(serde_json::json!({"music_output": payload.output})).into_response(),
        Err(error) if error == "conference disabled" => {
            json_message(StatusCode::CONFLICT, error).into_response()
        }
        Err(error) => internal_error_response("conference.output", error),
    }
}

/// Serialize finite master-gain persistence/mirroring without async lock guards.
pub async fn set_music_volume(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SetMusicVolumeRequest>,
) -> Response {
    let user = match studio_v2::studio_user_from_http_async(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return *response,
    };
    if !payload.volume.is_finite() || !(0.0..=1.0).contains(&payload.volume) {
        return json_message(StatusCode::BAD_REQUEST, "invalid music volume").into_response();
    }
    let runtime = match runtime_v2::ensure_room_runtime(&state, user.room_id).await {
        Ok(runtime) => runtime,
        Err(error) => return internal_error_response("conference.volume.runtime", error),
    };
    match studio_v2::db_task(move || {
        let mut current = runtime.conference_music_volume.blocking_lock();
        room_settings::set_conference_music_volume(&state, user.room_id, payload.volume)?;
        *current = payload.volume;
        runtime_v2::notify_music(&runtime);
        Ok(())
    })
    .await
    {
        Ok(()) => {
            Json(serde_json::json!({"conference_music_volume": payload.volume})).into_response()
        }
        Err(error) => internal_error_response("conference.volume", error),
    }
}

/// Issue an owner/admin presenter URL with atomic request throttling and post-provider revalidation.
pub async fn studio_join(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    let user = match studio_v2::studio_user_from_http_async(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return *response,
    };
    if !admit(&state, &headers, remote).await {
        return json_message(StatusCode::TOO_MANY_REQUESTS, "too many attempts").into_response();
    }
    if state.conference_provider.is_none() {
        return json_message(StatusCode::SERVICE_UNAVAILABLE, "conference unavailable")
            .into_response();
    }
    let conference = match room_state(&state, user.room_id).await {
        Ok(Some(conference)) => conference,
        Ok(None) => {
            return json_message(StatusCode::NOT_FOUND, "conference disabled").into_response();
        }
        Err(error) => return internal_error_response("conference.join.load", error),
    };
    let Some(join_url) = state.conference_provider.as_deref().and_then(|provider| {
        super::policy::joinable(&conference, provider.key())
            .then(|| provider.invitation_url(&conference.room_slug))
    }) else {
        return json_message(StatusCode::NOT_FOUND, "conference disabled").into_response();
    };
    // The owner's link carries a single-use host pass in the fragment (never sent to
    // servers or logs); the meeting page redeems it so this browser becomes host.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let app = state.clone();
    let room_id = conference.room_id;
    let token =
        match tokio::task::spawn_blocking(move || super::hosts::mint_grant(&app, room_id, now))
            .await
        {
            Ok(Ok(token)) => token,
            Ok(Err(error)) => return internal_error_response("conference.join.host", error),
            Err(error) => return internal_error_response("conference.join.host", error),
        };
    super::response::no_store_json(JoinResponse {
        join_url: format!("{join_url}#host={token}"),
    })
}

/// Build public-invitation settings without exposing provider mapping or credentials.
fn status_payload(state: &AppState, conference: db::Conference) -> StudioStatus {
    let invite_url = if conference.allowed {
        state
            .conference_provider
            .as_deref()
            .map(|provider| provider.invitation_url(&conference.room_slug))
    } else {
        None
    };
    let enabled = state
        .conference_provider
        .as_deref()
        .is_some_and(|provider| super::policy::joinable(&conference, provider.key()));
    StudioStatus {
        allowed: conference.allowed,
        enabled,
        invite_url,
    }
}

/// Load room state off-thread.
///
/// # Errors
/// Returns worker/SQL errors; missing rooms remain absent.
async fn room_state(state: &AppState, room: i64) -> Result<Option<db::Conference>, String> {
    let state = state.clone();
    studio_v2::db_task(move || db::by_room_id(&state, room)).await
}

/// Atomically count admission before any expensive provider work, shared across join surfaces.
pub(super) async fn admit(state: &AppState, headers: &HeaderMap, remote: SocketAddr) -> bool {
    let key = auth_v2::client_key(headers, Some(remote.ip()), state.trust_proxy_headers);
    state
        .conference_join_rate_limiter
        .try_record_attempt(&key)
        .await
}
