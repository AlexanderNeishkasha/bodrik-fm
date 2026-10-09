//! Section playback selection and queue transitions serialized with track mutations.

use crate::{
    api::{
        AppState, internal_error_response, json_message,
        library_db_v2::{self, LibraryPayload},
        runtime_v2, studio_v2,
    },
    stream::{Streamer, TrackEntry},
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

/// Request a section owned by the effective Studio room.
#[derive(serde::Deserialize)]
pub struct SectionPlaybackPayload {
    /// Existing section identity.
    id: i64,
}

/// Observable effect of a pure section transition.
#[derive(Debug, PartialEq, Eq)]
enum Effect {
    /// Empty section leaves playback/queue unchanged.
    None,
    /// Tracks appended without restarting playback.
    Queue,
    /// First track started and remainders prepended.
    Playback,
}

/// Append the section's authoritative order to the existing queue.
pub async fn queue_section(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectionPlaybackPayload>,
) -> Response {
    section_command(state, headers, payload.id, false).await
}

/// Start a section's first track and prepend its remainder ahead of the old queue.
pub async fn play_section(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectionPlaybackPayload>,
) -> Response {
    section_command(state, headers, payload.id, true).await
}

/// Resolve a live section and commit state/revision on one off-thread playback boundary.
async fn section_command(
    state: AppState,
    headers: HeaderMap,
    section: i64,
    play: bool,
) -> Response {
    let user = match studio_v2::studio_user_from_http_async(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return *response,
    };
    let runtime = match runtime_v2::ensure_room_runtime(&state, user.room_id).await {
        Ok(runtime) => runtime,
        Err(err) => return internal_error_response("studio.section.runtime", err),
    };
    match studio_v2::db_task(move || {
        let mut player = runtime.streamer.blocking_lock();
        if runtime_v2::is_closed(&runtime) {
            return Err("missing".into());
        }
        let tracks = select_tracks(library_db_v2::list_library(&state, user.room_id)?, section)
            .ok_or("missing")?;
        match apply_section(&mut player, tracks, play)? {
            Effect::None => {}
            Effect::Queue => runtime_v2::notify(&runtime),
            Effect::Playback => runtime_v2::notify_playback(&runtime),
        }
        Ok(())
    })
    .await
    {
        Ok(()) => json_message(StatusCode::OK, "ok").into_response(),
        Err(err) if err == "missing" => {
            json_message(StatusCode::NOT_FOUND, "missing").into_response()
        }
        Err(err) => internal_error_response("studio.section.command", err),
    }
}

/// Select one existing section without treating an empty section as a missing section.
fn select_tracks(payload: LibraryPayload, id: i64) -> Option<Vec<TrackEntry>> {
    if !payload.sections.iter().any(|section| section.id == id) {
        return None;
    }
    Some(
        payload
            .tracks
            .into_iter()
            .filter(|track| track.section_id == Some(id))
            .collect(),
    )
}

/// Apply section semantics without database, clock sleeps or HTTP dependencies.
///
/// # Errors
/// Returns a playback transition error without starting a different section.
fn apply_section(
    player: &mut Streamer,
    tracks: Vec<TrackEntry>,
    play: bool,
) -> Result<Effect, String> {
    if tracks.is_empty() {
        return Ok(Effect::None);
    }
    if !play {
        player.enqueue_many(tracks);
        return Ok(Effect::Queue);
    }
    let mut entries = tracks.into_iter();
    let first = entries.next().ok_or("section empty")?;
    player
        .play_track(first, 0.0)
        .map_err(|err| err.to_string())?;
    player.prepend_many(entries.collect());
    Ok(Effect::Playback)
}

/// Pure section-selection/transition cases, without SQLite fixtures.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::library_db_v2::LibrarySection;

    /// Build a serialized-domain track, not a media file or database record.
    fn track(id: &str, section: Option<i64>) -> TrackEntry {
        TrackEntry {
            id: id.into(),
            filename: id.into(),
            duration: None,
            media_path: "track.mp3".into(),
            section_id: section,
            sort_order: 0,
        }
    }

    /// Missing, empty and populated section identities are distinct.
    #[test]
    fn selection_cases() {
        for (requested, expected) in [(1, Some(vec!["a", "b"])), (2, Some(Vec::new())), (3, None)] {
            let payload = LibraryPayload {
                sections: vec![
                    LibrarySection {
                        id: 1,
                        name: "one".into(),
                        sort_order: 0,
                    },
                    LibrarySection {
                        id: 2,
                        name: "empty".into(),
                        sort_order: 1,
                    },
                ],
                tracks: vec![
                    track("a", Some(1)),
                    track("unsectioned", None),
                    track("b", Some(1)),
                ],
            };
            assert_eq!(
                select_tracks(payload, requested)
                    .map(|tracks| tracks.into_iter().map(|track| track.id).collect::<Vec<_>>()),
                expected.map(|ids| ids.into_iter().map(str::to_owned).collect::<Vec<_>>())
            );
        }
    }

    /// Queue/play/empty sections preserve the old queue and requested authoritative order.
    #[test]
    fn transition_cases() {
        for (play, empty, effect, current, queue) in [
            (false, true, Effect::None, None, vec!["old"]),
            (true, true, Effect::None, None, vec!["old"]),
            (false, false, Effect::Queue, None, vec!["old", "a", "b"]),
            (true, false, Effect::Playback, Some("a"), vec!["b", "old"]),
        ] {
            let mut player = Streamer::new(false);
            player.enqueue(track("old", None));
            let tracks = if empty {
                Vec::new()
            } else {
                vec![track("a", Some(1)), track("b", Some(1))]
            };
            assert_eq!(apply_section(&mut player, tracks, play).unwrap(), effect);
            let snapshot = player.snapshot();
            assert_eq!(
                snapshot.current.map(|track| track.id),
                current.map(str::to_owned)
            );
            assert_eq!(
                snapshot
                    .queue
                    .into_iter()
                    .map(|track| track.id)
                    .collect::<Vec<_>>(),
                queue.into_iter().map(str::to_owned).collect::<Vec<_>>()
            );
        }
    }
}
