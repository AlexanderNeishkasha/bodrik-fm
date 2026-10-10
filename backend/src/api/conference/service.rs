//! Owned conference mutations: persist revocation/cleanup first, then terminate provider state.

use super::{
    cleanup,
    db::{self, Conference},
};
use crate::api::{AppState, blocking, runtime};

/// Own enablement/disablement and provider cleanup through request cancellation.
///
/// # Errors
/// Returns provider availability, worker, SQL, generation or termination failures.
pub async fn set_enabled(state: &AppState, room: i64, enabled: bool) -> Result<Conference, String> {
    let state = state.clone();
    tokio::spawn(enabled_command(state, room, enabled))
        .await
        .map_err(|_| "conference command task failed")?
}

/// Apply the persisted/mirrored command in one off-thread serialization boundary.
///
/// # Errors
/// Returns command persistence or durable cleanup failures; disabled state stays fail-closed.
async fn enabled_command(state: AppState, room: i64, enabled: bool) -> Result<Conference, String> {
    if enabled && state.conference_provider.is_none() {
        return Err("conference provider unavailable".into());
    }
    let runtime = runtime_for_command(&state, room).await;
    let db_state = state.clone();
    let conference = blocking::db_task(move || {
        let _serialized = runtime
            .as_ref()
            .map(|runtime| runtime.music_output.blocking_lock());
        let conference = db::set_enabled(&db_state, room, enabled)?;
        if let Some(runtime) = &runtime {
            runtime::set_conference_state(runtime, conference.allowed, conference.enabled);
        }
        Ok(conference)
    })
    .await?;
    if !enabled {
        cleanup::for_room(&state, room).await?;
    }
    Ok(conference)
}

/// Own entitlement changes and provider cleanup; revocation still persists without a configured adapter.
///
/// # Errors
/// Returns unavailable-provider grant, lookup/SQL/worker or termination failures.
pub async fn set_access(state: &AppState, user: i64, allowed: bool) -> Result<bool, String> {
    let state = state.clone();
    tokio::spawn(access_command(state, user, allowed))
        .await
        .map_err(|_| "conference access task failed")?
}

/// Apply an entitlement command and retry every retained old target, not the rotated new ID.
///
/// # Errors
/// Returns command/cleanup errors after retaining fail-closed persisted state.
async fn access_command(state: AppState, user: i64, allowed: bool) -> Result<bool, String> {
    let provider = state
        .conference_provider
        .as_deref()
        .map(|provider| provider.key());
    if allowed && provider.is_none() {
        return Err("conference provider unavailable".into());
    }
    let lookup = state.clone();
    let Some(room) = blocking::db_task(move || db::room_id_by_user_id(&lookup, user)).await? else {
        return Ok(false);
    };
    let runtime = runtime_for_command(&state, room).await;
    let db_state = state.clone();
    let changed = blocking::db_task(move || {
        let _serialized = runtime
            .as_ref()
            .map(|runtime| runtime.music_output.blocking_lock());
        let changed = db::set_allowed_by_user_id(&db_state, user, provider, allowed)?;
        let conference = db::by_room_id(&db_state, room)?;
        if let (Some(runtime), Some(conference)) = (&runtime, conference) {
            runtime::set_conference_state(runtime, conference.allowed, conference.enabled);
        }
        Ok(changed)
    })
    .await?;
    if !allowed {
        cleanup::for_room(&state, room).await?;
    }
    Ok(changed)
}

/// Obtain optional live mirroring without making security commands depend on runtime initialization.
async fn runtime_for_command(
    state: &AppState,
    room: i64,
) -> Option<std::sync::Arc<runtime::RoomRuntime>> {
    match runtime::ensure_room_runtime(state, room).await {
        Ok(runtime) => Some(runtime),
        Err(error) => {
            tracing::error!(room_id = room, %error, "conference runtime mirror unavailable");
            None
        }
    }
}
