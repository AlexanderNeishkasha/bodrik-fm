//! Event-driven embedded playback, standalone reconciliation and owned FFmpeg lifecycle.

use super::{Service, native, session::Room};
use crate::{integration::Playback, media::protocol::Operation};
use std::{collections::HashMap, process::Stdio, time::Instant};
use tokio::{
    process::{Child, Command},
    sync::watch,
    time::Duration,
};

/// Snapshot cadence; every poll is authoritative and repairs missed revisions.
const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Seek when the local source differs materially from the authoritative position.
const DRIFT_LIMIT_SECONDS: f64 = 2.0;
/// Fixed stereo Opus synchronization source used by the room-owned producer.
const MUSIC_SSRC: u32 = 1_357_911;

/// One room's private native source and optional Rust-owned process.
struct State {
    /// Exact native room incarnation that owns this source.
    room_instance_id: String,
    /// Native service boot that allocated this source.
    boot: String,
    /// Current native producer handle.
    producer_id: String,
    /// Native UDP destination allocated from the bounded private range.
    port: u16,
    /// Current track/revision identity.
    source_key: Option<String>,
    /// Whether FFmpeg has used this producer; a restarted RTP stream needs a fresh producer.
    rtp_started: bool,
    /// Position used when the process started.
    source_position: f64,
    /// Monotonic process start instant.
    source_started: Instant,
    /// Sole FFmpeg child owner.
    process: Option<Child>,
}

impl State {
    /// Return whether this source belongs to the exact current native room incarnation.
    fn belongs_to(&self, room: &Room) -> bool {
        self.room_instance_id == room.binding.room_instance_id && self.boot == room.boot
    }
}

/// Poll every active replacement room and fail silent on authority/process errors.
pub(super) async fn supervise(
    service: Service,
    mut stop: watch::Receiver<bool>,
) -> Result<(), &'static str> {
    let mut states = HashMap::new();
    let mut seen = HashMap::new();
    let mut changes = service.config.player.playback_changes();
    let mut full = true;
    loop {
        if *stop.borrow() {
            break;
        }
        if let Err(error) =
            reconcile(&service, &mut states, &mut seen, full || changes.is_none()).await
        {
            service
                .observing
                .store(false, std::sync::atomic::Ordering::Release);
            return Err(error);
        }
        full = false;
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() { break; }
            }
            changed = async { match &mut changes {
                Some(receiver) => receiver.changed().await,
                None => std::future::pending().await,
            }} => {
                if changed.is_err() { break; }
                full = true;
            }
            () = tokio::time::sleep(POLL_INTERVAL) => {}
        }
    }
    for (room_id, mut state) in states {
        silence(&mut state).await?;
        if let Some(room) = room(&service, &room_id) {
            close_native(&service, &room).await;
        }
    }
    Ok(())
}

/// Reconcile all exact rooms; removed rooms cannot retain a process.
async fn reconcile(
    service: &Service,
    states: &mut HashMap<String, State>,
    seen: &mut HashMap<String, String>,
    full: bool,
) -> Result<(), &'static str> {
    let rooms = service
        .store
        .lock()
        .map(|store| store.rooms.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let active = rooms
        .iter()
        .map(|room| room.binding.room_id.clone())
        .collect::<std::collections::HashSet<_>>();
    seen.retain(|id, _| active.contains(id));
    let removed = states
        .keys()
        .filter(|id| !active.contains(*id))
        .cloned()
        .collect::<Vec<_>>();
    for id in removed {
        if let Some(mut state) = states.remove(&id) {
            silence(&mut state).await?;
        }
    }
    for room in rooms {
        let id = room.binding.room_id.clone();
        // In embedded mode the timer only discovers room membership and failed child processes.
        // Playback commits wake this loop directly; healthy/paused sources do not poll storage.
        if !full
            && seen.get(&id) == Some(&room.binding.room_instance_id)
            && states.get_mut(&id).is_none_or(|state| {
                state.belongs_to(&room)
                    && (state.source_key.is_none()
                        || state
                            .process
                            .as_mut()
                            .is_some_and(|child| matches!(child.try_wait(), Ok(None))))
            })
        {
            continue;
        }
        let snapshot = service.config.player.playback(&id).await;
        if snapshot.is_ok() {
            seen.insert(id.clone(), room.binding.room_instance_id.clone());
        } else {
            seen.remove(&id);
        }
        match snapshot {
            Ok(Some(snapshot)) if snapshot.output == "conference" => {
                if let Err(category) = apply(service, &room, states, snapshot).await {
                    if cleanup_failure(category) {
                        return Err(category);
                    }
                    seen.remove(&id);
                    tracing::warn!(
                        room_id = id,
                        category,
                        "meeting music reconciliation failed silent"
                    );
                    if let Some(state) = states.get_mut(&id) {
                        silence(state).await?;
                    }
                }
            }
            Err(category) => {
                tracing::warn!(room_id = id, category, "meeting music snapshot unavailable");
                if let Some(mut state) = states.remove(&id) {
                    silence(&mut state).await?;
                }
                close_native(service, &room).await;
            }
            _ => {
                if let Some(mut state) = states.remove(&id) {
                    silence(&mut state).await?;
                }
                close_native(service, &room).await;
            }
        }
    }
    Ok(())
}

/// Apply one authoritative snapshot, creating native resources and correcting drift as needed.
///
/// # Errors
/// Returns native allocation, media validation, spawn or bounded process-cleanup failures.
async fn apply(
    service: &Service,
    room: &Room,
    states: &mut HashMap<String, State>,
    snapshot: Playback,
) -> Result<(), &'static str> {
    let id = room.binding.room_id.clone();
    let stale_incarnation = states.get(&id).is_some_and(|state| !state.belongs_to(room));
    if stale_incarnation {
        if let Some(mut state) = states.remove(&id) {
            silence(&mut state).await?;
        }
        if let Ok(mut store) = service.store.lock()
            && let Some(current) = store.rooms.get_mut(&id)
            && current.binding.room_instance_id == room.binding.room_instance_id
        {
            current.music = None;
        }
    }
    if !states.contains_key(&id) {
        states.insert(
            id.clone(),
            create_native(service, room, snapshot.volume).await?,
        );
    }
    let state = states.get_mut(&id).ok_or("music unavailable")?;
    let mut volume_changed = false;
    if let Ok(mut store) = service.store.lock()
        && let Some(music) = store
            .rooms
            .get_mut(&id)
            .and_then(|room| room.music.as_mut())
        && music.producer_id == state.producer_id
    {
        volume_changed = (music.volume - snapshot.volume).abs() > f64::EPSILON;
        music.volume = snapshot.volume;
    }
    if volume_changed {
        super::participant::music_volume(service, &id, snapshot.volume);
    }
    if !snapshot.is_playing || snapshot.track.is_none() {
        silence(state).await?;
        return Ok(());
    }
    let track = snapshot.track.as_ref().ok_or("music unavailable")?;
    let key = format!("{}:{}", snapshot.revision, track.id);
    let local_position = state.source_position + state.source_started.elapsed().as_secs_f64();
    let healthy = state
        .process
        .as_mut()
        .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
    if state.source_key.as_deref() == Some(&key)
        && healthy
        && (snapshot.position - local_position).abs() < DRIFT_LIMIT_SECONDS
    {
        return Ok(());
    }
    // FFmpeg restarts RTP sequence/timestamp state, including after a pause cleared source_key.
    if state.rtp_started {
        let mut stale = states.remove(&id).ok_or("music unavailable")?;
        silence(&mut stale).await?;
        close_native(service, room).await;
        states.insert(
            id.clone(),
            create_native(service, room, snapshot.volume).await?,
        );
    } else {
        silence(state).await?;
    }
    let state = states.get_mut(&id).ok_or("music unavailable")?;
    let media = service
        .config
        .player
        .media_source(&track.media_url)
        .map_err(|_| "invalid music source")?;
    let mut command = Command::new(&service.config.ffmpeg_path);
    command.args(ffmpeg_args(
        &media,
        snapshot.position,
        &service.config.music_rtp_host,
        state.port,
        MUSIC_SSRC,
    ));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    state.process = Some(command.spawn().map_err(|_| "music process unavailable")?);
    state.rtp_started = true;
    state.source_key = Some(key);
    state.source_position = snapshot.position;
    state.source_started = Instant::now();
    Ok(())
}

/// Allocate one fresh native producer and publish its participant projection.
///
/// # Errors
/// Rejects unavailable native allocation or malformed producer destinations.
async fn create_native(service: &Service, room: &Room, volume: f64) -> Result<State, &'static str> {
    let destination = service
        .config
        .media
        .create_music(&room.boot, &room.binding, MUSIC_SSRC)
        .await
        .map_err(|_| "native music unavailable")?;
    let producer_id = destination.producer_id;
    let port = destination.port;
    if let Ok(mut store) = service.store.lock()
        && let Some(current) = store.rooms.get_mut(&room.binding.room_id)
    {
        current.music = Some(super::session::Music {
            producer_id: producer_id.clone(),
            volume,
        });
    }
    super::participant::music_started(service, &room.binding.room_id, &producer_id, volume);
    Ok(State {
        room_instance_id: room.binding.room_instance_id.clone(),
        boot: room.boot.clone(),
        producer_id,
        port,
        source_key: None,
        rtp_started: false,
        source_position: 0.0,
        source_started: Instant::now(),
        process: None,
    })
}

/// Stop and reap one process with a bounded graceful deadline.
async fn silence(state: &mut State) -> Result<(), &'static str> {
    state.source_key = None;
    let Some(mut child) = state.process.take() else {
        return Ok(());
    };
    if child
        .try_wait()
        .map_err(|_| "music process wait failed")?
        .is_some()
    {
        return Ok(());
    }
    if child.start_kill().is_err() && child.try_wait().ok().flatten().is_none() {
        return Err("music process kill failed");
    }
    tokio::time::timeout(Duration::from_secs(1), child.wait())
        .await
        .map_err(|_| "music process reap deadline exceeded")?
        .map_err(|_| "music process reap failed")?;
    Ok(())
}

/// Cleanup uncertainty requires a host restart rather than another music incarnation.
fn cleanup_failure(category: &str) -> bool {
    matches!(
        category,
        "music process wait failed"
            | "music process kill failed"
            | "music process reap deadline exceeded"
            | "music process reap failed"
    )
}

/// Idempotently release the room-owned native source.
async fn close_native(service: &Service, room: &Room) {
    let producer_id = service.store.lock().ok().and_then(|mut store| {
        let current = store.rooms.get_mut(&room.binding.room_id)?;
        (current.binding.room_instance_id == room.binding.room_instance_id)
            .then(|| current.music.take())
            .flatten()
            .map(|music| music.producer_id)
    });
    let _ = native::execute(
        service,
        &room.boot,
        &room.binding,
        Operation::CloseMusic(Default::default()),
    )
    .await;
    if let Some(producer_id) = producer_id {
        super::participant::music_stopped(service, &room.binding.room_id, &producer_id);
    }
}

/// Resolve the current exact room after asynchronous work.
fn room(service: &Service, id: &str) -> Option<Room> {
    service.store.lock().ok()?.rooms.get(id).cloned()
}

/// Build a fixed stereo Opus/RTP command; callers supply only validated player media and private destination.
fn ffmpeg_args(media: &str, position: f64, host: &str, port: u16, ssrc: u32) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "warning".into(),
        "-re".into(),
        "-ss".into(),
        position.to_string(),
        "-i".into(),
        media.into(),
        "-vn".into(),
        "-af".into(),
        "aresample=48000:async=1000:first_pts=0".into(),
        "-ac".into(),
        "2".into(),
        "-c:a".into(),
        "libopus".into(),
        "-application:a".into(),
        "audio".into(),
        "-frame_duration:a".into(),
        "20".into(),
        "-vbr:a".into(),
        "on".into(),
        "-fec:a".into(),
        "1".into(),
        "-packet_loss:a".into(),
        "5".into(),
        "-b:a".into(),
        "160k".into(),
        "-payload_type".into(),
        "111".into(),
        "-ssrc".into(),
        ssrc.to_string(),
        "-f".into(),
        "rtp".into(),
        format!("rtp://{host}:{port}?pkt_size=1200"),
    ]
}

/// Source lifecycle and fixed-command contract regression tests.
#[cfg(test)]
mod tests {
    mod flow;
    use super::*;

    /// Only unconfirmed process cleanup prevents meeting-only recovery.
    #[test]
    fn cleanup_failure_categories() {
        for (name, fatal) in [
            ("music process wait failed", true),
            ("music process kill failed", true),
            ("music process reap deadline exceeded", true),
            ("music process reap failed", true),
            ("native music unavailable", false),
            ("music unavailable", false),
        ] {
            assert_eq!(cleanup_failure(name), fatal, "{name}");
        }
    }

    /// Music state is reusable only for the exact native room incarnation and boot.
    #[test]
    fn state_rejects_replaced_room_incarnations() {
        let room = Room {
            binding: crate::media::protocol::Binding {
                room_id: "conference".into(),
                room_instance_id: "instance-new".into(),
                peer_id: "room-owner".into(),
                admission_epoch: 1,
            },
            boot: "boot-new".into(),
            generation: 1,
            reservation: 1,
            slug: "room".into(),
            renewal: crate::replacement::room_lease::Schedule::new(15, 1),
            follow: None,
            music: None,
        };
        let state = State {
            room_instance_id: "instance-old".into(),
            boot: "boot-old".into(),
            producer_id: "producer".into(),
            port: 40_000,
            source_key: None,
            rtp_started: false,
            source_position: 0.0,
            source_started: Instant::now(),
            process: None,
        };

        assert!(!state.belongs_to(&room));
    }

    /// FFmpeg remains fixed to stereo Opus and the selected private destination.
    #[test]
    fn ffmpeg_contract() {
        let args = ffmpeg_args("http://player/media/song", 12.5, "127.0.0.1", 41000, 7);
        assert!(args.windows(2).any(|pair| pair == ["-c:a", "libopus"]));
        assert!(args.windows(2).any(|pair| pair == ["-ac", "2"]));
        assert_eq!(
            args.last().map(String::as_str),
            Some("rtp://127.0.0.1:41000?pkt_size=1200")
        );
        assert!(!args.iter().any(|value| value.contains("stderr")));
    }
}
