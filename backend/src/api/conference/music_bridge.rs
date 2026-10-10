//! Queue-free music bridge authorization and no-store authoritative playback snapshots.

use crate::api::{AppState, blocking, internal_error_response, json_message, media, runtime};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use subtle::ConstantTimeEq;

/// Authoritative bridge contract, deliberately excluding queue and provider credentials.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicSnapshot {
    /// Playback change token paired with the player state.
    pub revision: usize,
    /// Audible output surface.
    pub output: String,
    /// Validated meeting-wide gain.
    pub volume: f64,
    /// Whether playback advances.
    pub is_playing: bool,
    /// Current monotonic position.
    pub position: f64,
    /// Current room-owned media only.
    pub track: Option<MusicTrack>,
}

/// Current track descriptor using a local original-file URL only.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicTrack {
    /// Room track ID.
    pub id: String,
    /// Display title.
    pub title: String,
    /// Optional duration.
    pub duration: Option<f64>,
    /// Encoded original-file media path.
    pub media_url: String,
}

/// Return a no-store snapshot only for a valid token and still-current enabled mapping.
pub async fn snapshot(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(secret) = state.music_bridge_secret.as_deref() else {
        return json_message(StatusCode::SERVICE_UNAVAILABLE, "music bridge disabled")
            .into_response();
    };
    if !authorize(&headers, secret) {
        return json_message(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let value = match current(&state, id).await {
        Ok(Some(value)) => value,
        Ok(None) => {
            return json_message(StatusCode::NOT_FOUND, "conference unavailable").into_response();
        }
        Err(error) => return internal_error_response("bridge.snapshot", error),
    };
    let mut response = Json(value).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Read a freshly authorized snapshot without any transport dependency.
///
/// # Errors
/// Returns database, runtime, invalid gain or unsafe media reference errors.
pub(crate) async fn current(state: &AppState, id: String) -> Result<Option<MusicSnapshot>, String> {
    let Some(room) = lookup(state, &id).await? else {
        return Ok(None);
    };
    let runtime = runtime::ensure_room_runtime(state, room).await?;
    let playback = runtime::playback_snapshot(&runtime).await;
    let output = runtime.music_output.lock().await.clone();
    let volume = *runtime.conference_music_volume.lock().await;
    if !valid_gain(volume) {
        return Err("invalid runtime gain".into());
    }
    let track = match playback.player.current {
        Some(track) if media::valid_storage_key(&track.media_path) => Some(MusicTrack {
            id: track.id,
            title: track.filename,
            duration: track.duration,
            media_url: format!(
                "/media/{}",
                utf8_percent_encode(&track.media_path, NON_ALPHANUMERIC)
            ),
        }),
        Some(_) => return Err("invalid media key".into()),
        None => None,
    };
    match lookup(state, &id).await {
        Ok(Some(current)) if current == room && !runtime::is_closed(&runtime) => {}
        Ok(_) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    }
    Ok(Some(MusicSnapshot {
        revision: playback.revision,
        output,
        volume,
        is_playing: playback.player.is_playing,
        position: playback.player.position,
        track,
    }))
}

/// Resolve only current, entitled/enabled provider room mappings off-thread.
///
/// # Errors
/// Returns SQL/worker errors instead of silently turning failures into missing rooms.
async fn lookup(state: &AppState, id: &str) -> Result<Option<i64>, String> {
    let state = state.clone();
    let id = id.to_owned();
    blocking::db_task(move || super::db::room_id_by_provider_id(&state, &id)).await
}

/// Check the independent private-player bearer without exposing or timing-comparing its value.
fn authorize(headers: &HeaderMap, secret: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| bool::from(value.as_bytes().ct_eq(secret.as_bytes())))
}

/// Reject non-finite or out-of-range gain before emitting bridge JSON.
fn valid_gain(volume: f64) -> bool {
    volume.is_finite() && (0.0..=1.0).contains(&volume)
}

/// Pure signed-token/gain tables; no clocks, provider or HTTP fixtures.
#[cfg(test)]
mod tests {
    use super::*;
    /// The private player response matches the meeting client's strict camelCase contract.
    #[test]
    fn bridge_wire_shape_is_camel_case() {
        let value = serde_json::to_value(MusicSnapshot {
            revision: 7,
            output: "conference".into(),
            volume: 0.5,
            is_playing: true,
            position: 12.0,
            track: Some(MusicTrack {
                id: "track".into(),
                title: "Title".into(),
                duration: Some(30.0),
                media_url: "/media/song.mp3".into(),
            }),
        })
        .expect("snapshot serialization");
        assert_eq!(value["isPlaying"], true);
        assert_eq!(value["track"]["mediaUrl"], "/media/song.mp3");
        assert!(value.get("is_playing").is_none());
        assert!(value["track"].get("media_url").is_none());
    }

    /// Exact bearer matching and malformed authorization branches fail closed.
    #[test]
    fn bridge_authorization_cases() {
        for (raw, accepted) in [
            (Some("Bearer secret"), true),
            (Some("Bearer invalid"), false),
            (Some("Basic secret"), false),
            (Some("Bearer "), false),
            (None, false),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(raw) = raw {
                headers.insert(header::AUTHORIZATION, HeaderValue::from_str(raw).unwrap());
            }
            assert_eq!(authorize(&headers, "secret"), accepted);
        }
        for (gain, valid) in [
            (0.0, true),
            (1.0, true),
            (0.5, true),
            (-1.0, false),
            (2.0, false),
            (f64::NAN, false),
            (f64::INFINITY, false),
        ] {
            assert_eq!(valid_gain(gain), valid);
        }
    }
}
