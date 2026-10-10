//! Authoritative per-room state, owned playback supervision, and repair snapshots.

use crate::{
    api::{AppState, conference, db, playback_observer::PlaybackObserver, room_settings},
    stream::{self, PlayerState, Streamer},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::{sync::Mutex, task::JoinHandle};

/// Authoritative process-local room state; database settings initialize it once.
pub struct RoomRuntime {
    /// Database room identity.
    pub room_id: i64,
    /// Playback serialization lock, also protecting state/revision pairing.
    pub streamer: Arc<Mutex<Streamer>>,
    /// Persisted room theme mirrored for observers.
    pub theme: Arc<Mutex<String>>,
    /// Audible output surface.
    pub music_output: Arc<Mutex<String>>,
    /// Meeting-wide music gain.
    pub conference_music_volume: Arc<Mutex<f64>>,
    /// Administrator entitlement.
    pub conference_allowed: Arc<AtomicBool>,
    /// Owner-controlled conference enablement.
    pub conference_enabled: Arc<AtomicBool>,
    /// Current public invitation slug.
    pub room_slug: Arc<Mutex<String>>,
    /// Bounded wake-ups; subscribers repair with snapshots on lag.
    pub state_broadcast: tokio::sync::broadcast::Sender<()>,
    /// Process-local change token, wrapping only on machine-range exhaustion.
    pub sync_token: Arc<AtomicUsize>,
    /// Library invalidation token.
    pub library_version: Arc<AtomicUsize>,
    /// Active public and Studio state sockets.
    pub active_listeners: Arc<AtomicUsize>,
    /// Optional external playback event fan-out.
    pub playback_observer: Arc<PlaybackObserver>,
    /// Terminal lifecycle flag observed by state sockets.
    closed: AtomicBool,
    /// Automatic advancement task, aborted on eviction or final runtime release.
    auto_advance: JoinHandle<()>,
}

impl Drop for RoomRuntime {
    /// Abort the owned timer; it must not outlive a room through its own Arc clones.
    fn drop(&mut self) {
        self.auto_advance.abort();
    }
}

/// Load settings off-thread and publish one authoritative runtime for a live room.
///
/// # Errors
/// Returns loading/task errors or a room deleted while its runtime was being created.
pub async fn ensure_room_runtime(
    state: &AppState,
    room_id: i64,
) -> Result<Arc<RoomRuntime>, String> {
    if let Some(runtime) = state.runtimes.lock().await.get(&room_id).cloned() {
        return Ok(runtime);
    }
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        // Serialize creation against eviction entirely off-thread: no guard crosses await.
        // The worker finishes publication even if its requesting HTTP future is cancelled.
        let mut map = state.runtimes.blocking_lock();
        if let Some(runtime) = map.get(&room_id) {
            return Ok(runtime.clone());
        }
        let settings = room_settings::load(&state, room_id)?;
        let room = db::room_by_id(&state, room_id)?.ok_or("room missing")?;
        let conference = conference::db::by_room_id(&state, room_id)?;
        let runtime = create_runtime(
            room_id,
            room.slug,
            settings,
            conference.as_ref().is_some_and(|value| value.allowed),
            conference.as_ref().is_some_and(|value| value.enabled),
            state.playback_observer.clone(),
        );
        map.insert(room_id, runtime.clone());
        Ok(runtime)
    })
    .await
    .map_err(|err| format!("room creation task failed: {err}"))?
}

/// Compose a runtime and its timer without a task-to-runtime ownership cycle.
fn create_runtime(
    room_id: i64,
    slug: String,
    settings: room_settings::RoomSettings,
    allowed: bool,
    enabled: bool,
    observer: Arc<PlaybackObserver>,
) -> Arc<RoomRuntime> {
    let streamer = Arc::new(Mutex::new(Streamer::new(settings.repeat_one)));
    let (state_broadcast, _) = tokio::sync::broadcast::channel(64);
    let sync_token = Arc::new(AtomicUsize::new(0));
    let event_token = sync_token.clone();
    let event_observer = observer.clone();
    let auto_advance = stream::start_auto_advance(
        streamer.clone(),
        state_broadcast.clone(),
        sync_token.clone(),
        Arc::new(move || event_observer.publish(room_id, event_token.load(Ordering::Relaxed))),
    );
    Arc::new(RoomRuntime {
        room_id,
        streamer,
        theme: Arc::new(Mutex::new(settings.theme)),
        music_output: Arc::new(Mutex::new(settings.music_output)),
        conference_music_volume: Arc::new(Mutex::new(settings.conference_music_volume)),
        conference_allowed: Arc::new(AtomicBool::new(allowed)),
        conference_enabled: Arc::new(AtomicBool::new(enabled)),
        room_slug: Arc::new(Mutex::new(slug)),
        state_broadcast,
        sync_token,
        library_version: Arc::new(AtomicUsize::new(0)),
        active_listeners: Arc::new(AtomicUsize::new(0)),
        playback_observer: observer,
        closed: AtomicBool::new(false),
        auto_advance,
    })
}

/// Remove a room, abort advancement and wake existing sockets so they terminate.
pub async fn evict_room(state: &AppState, room_id: i64) {
    if let Some(runtime) = state.runtimes.lock().await.remove(&room_id) {
        close(&runtime);
    }
}

/// Mark a runtime terminal without awaiting while the registry is locked.
fn close(runtime: &RoomRuntime) {
    runtime.closed.store(true, Ordering::Release);
    runtime.auto_advance.abort();
    notify(runtime);
}

/// Check the durable lifecycle flag rather than relying on lossy wake-up delivery.
pub fn is_closed(runtime: &RoomRuntime) -> bool {
    runtime.closed.load(Ordering::Acquire)
}

/// Commit/publish a playback change token while holding the playback mutation lock.
pub fn bump_sync(runtime: &RoomRuntime) {
    let revision = runtime
        .sync_token
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    runtime.playback_observer.publish(runtime.room_id, revision);
}

/// Invalidate Studio's library cache after committed persistence changes.
pub fn bump_library(runtime: &RoomRuntime) {
    runtime.library_version.fetch_add(1, Ordering::Relaxed);
}

/// Wake state subscribers; no listeners is a normal, non-failing condition.
pub fn notify(runtime: &RoomRuntime) {
    let _ = runtime.state_broadcast.send(());
}

/// Wake embedded music for output/gain commits without changing track playback identity.
pub fn notify_music(runtime: &RoomRuntime) {
    runtime
        .playback_observer
        .publish(runtime.room_id, runtime.sync_token.load(Ordering::Relaxed));
    notify(runtime);
}

/// Publish a committed playback mutation under the caller-held playback lock.
pub fn notify_playback(runtime: &RoomRuntime) {
    bump_sync(runtime);
    notify(runtime);
}

/// Mirror entitlement/enablement after a committed conference command.
pub fn set_conference_state(runtime: &RoomRuntime, allowed: bool, enabled: bool) {
    runtime.conference_allowed.store(allowed, Ordering::Relaxed);
    runtime.conference_enabled.store(enabled, Ordering::Relaxed);
    notify(runtime);
}

/// Copy playback/revision coherently, then read independently owned room preferences.
pub async fn snapshot(runtime: &RoomRuntime) -> RuntimeSnapshot {
    let playback = playback_snapshot(runtime).await;
    let theme = runtime.theme.lock().await.clone();
    let music_output = runtime.music_output.lock().await.clone();
    let conference_music_volume = *runtime.conference_music_volume.lock().await;
    let room_slug = runtime.room_slug.lock().await.clone();
    RuntimeSnapshot {
        player: playback.player,
        sync_token: playback.revision,
        listeners: runtime.active_listeners.load(Ordering::Relaxed),
        library_version: runtime.library_version.load(Ordering::Relaxed),
        theme,
        music_output,
        conference_music_volume,
        room_slug,
        conference_allowed: runtime.conference_allowed.load(Ordering::Relaxed),
        conference_enabled: runtime.conference_enabled.load(Ordering::Relaxed),
    }
}

/// Pair playback with its token before releasing the same lock used by every mutation.
pub async fn playback_snapshot(runtime: &RoomRuntime) -> PlaybackSnapshot {
    let player = runtime.streamer.lock().await;
    PlaybackSnapshot {
        player: player.snapshot(),
        revision: runtime.sync_token.load(Ordering::Relaxed),
    }
}

/// Queue-free repair snapshot for external playback consumers.
pub struct PlaybackSnapshot {
    /// Change token paired with the captured playback state.
    pub revision: usize,
    /// Authoritative player snapshot.
    pub player: PlayerState,
}

/// Studio/public room state; preferences are independently owned values.
pub struct RuntimeSnapshot {
    /// Authoritative playback state.
    pub player: PlayerState,
    /// Active state socket count.
    pub listeners: usize,
    /// Library invalidation token.
    pub library_version: usize,
    /// Playback change token.
    pub sync_token: usize,
    /// Current room theme.
    pub theme: String,
    /// Audible output surface.
    pub music_output: String,
    /// Meeting-wide gain.
    pub conference_music_volume: f64,
    /// Administrator conference entitlement.
    pub conference_allowed: bool,
    /// Owner enablement.
    pub conference_enabled: bool,
    /// Current public slug.
    pub room_slug: String,
}

#[cfg(test)]
mod tests;
