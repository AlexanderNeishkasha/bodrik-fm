//! Persisted room preferences, kept separate from playback queue commands.

use super::{
    context::action_runtime,
    types::{RoomListedPayload, RoomListedResponse, SlugPayload, SlugResponse, ThemePayload},
};
use crate::api::blocking::{db_task, op_task};
use crate::api::{AppState, db, internal_error_response, json_message, runtime, util};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

/// Theme identifiers offered by the static frontend's allowlist.
const THEMES: &[&str] = &[
    "crimson",
    "mono",
    "midnight",
    "ivory",
    "lucifer",
    "aurora",
    "saffron",
    "prism",
    "mythic",
    "grove",
    "spectrum",
    "pirate",
    "emberveil",
];

/// Persist an allowlisted room theme, serializing persistence and its runtime mirror.
pub async fn set_theme(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ThemePayload>,
) -> Response {
    let (user, runtime) = match action_runtime(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let theme = payload.theme.trim().to_owned();
    if theme.is_empty() {
        return json_message(StatusCode::BAD_REQUEST, "theme is required").into_response();
    }
    if !supported_theme(&theme) {
        return json_message(StatusCode::BAD_REQUEST, "invalid theme").into_response();
    }
    match db_task(move || {
        let mut current = runtime.theme.blocking_lock();
        db::set_room_theme(&state, user.room_id, &theme)?;
        *current = theme;
        runtime::notify(&runtime);
        Ok(())
    })
    .await
    {
        Ok(()) => json_message(StatusCode::OK, "ok").into_response(),
        Err(err) => internal_error_response("studio.set_theme", err),
    }
}

/// Normalize and persist the owner's public slug, then broadcast the committed identity.
pub async fn set_room_slug(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SlugPayload>,
) -> Response {
    let (user, runtime) = match action_runtime(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(slug) = util::normalize_slug(&payload.slug) else {
        return json_message(StatusCode::BAD_REQUEST, "invalid slug").into_response();
    };
    match op_task(move || {
        let mut current = runtime.room_slug.blocking_lock();
        let slug = db::update_user_room_slug(&state, user.user_id, &slug)?;
        *current = slug.clone();
        runtime::notify(&runtime);
        Ok(slug)
    })
    .await
    {
        Ok(slug) => Json(SlugResponse { slug }).into_response(),
        Err(err) => err.respond("studio.set_room_slug"),
    }
}

/// Change directory visibility without changing direct-link accessibility.
pub async fn set_room_listed(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RoomListedPayload>,
) -> Response {
    let (user, _) = match action_runtime(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match db_task(move || db::set_user_room_listed(&state, user.user_id, payload.listed)).await {
        Ok(true) => Json(RoomListedResponse {
            listed: payload.listed,
        })
        .into_response(),
        Ok(false) => json_message(StatusCode::NOT_FOUND, "missing").into_response(),
        Err(err) => internal_error_response("studio.set_room_listed", err),
    }
}

/// Validate the canonical frontend theme vocabulary; callers normalize surrounding whitespace.
fn supported_theme(theme: &str) -> bool {
    THEMES.contains(&theme)
}

/// Pure supported-theme policy coverage, with no process environment or browser fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Every current frontend identifier is accepted; unknown/raw CSS is not a theme.
    #[test]
    fn theme_cases() {
        for theme in THEMES {
            assert!(supported_theme(theme));
        }
        for theme in ["", "Mono", "unknown", "url(https://invalid.test)"] {
            assert!(!supported_theme(theme));
        }
    }
}
