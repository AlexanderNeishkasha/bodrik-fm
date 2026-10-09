//! Native room, peer and music lifetimes; native handles drop outside registry locks.
use super::state::{Peer, Room, reject};
use super::*;
use crate::media::protocol::{Binding, ErrorCode};
use serde_json::json;
use std::collections::HashMap;

/// Pending room ownership is retired if startup is cancelled before publication.
struct RoomReservation {
    /// Engine retains lifetime through asynchronous initialization.
    engine: Engine,
    /// Exact pending room identity.
    binding: Binding,
    /// Successful publication disarms cancellation cleanup.
    committed: bool,
}

impl Drop for RoomReservation {
    /// Cancel pending router initialization without resurrecting its incarnation.
    fn drop(&mut self) {
        if !self.committed
            && let Err(error) = self.engine.close_room(&self.binding)
        {
            tracing::warn!(%error, "pending native room cleanup failed");
        }
    }
}

impl Engine {
    /// Reserve a bounded room then initialize native router and speaking observers.
    ///
    /// # Errors
    /// Rejects duplicate/retired rooms, capacity and native failures.
    pub(super) async fn create_room(&self, b: &Binding) -> Result<(), MediaError> {
        {
            let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            if state.stopped
                || state
                    .retired
                    .contains(&(b.room_id.clone(), b.room_instance_id.clone()))
            {
                return Err(reject(ErrorCode::UnauthorizedSession));
            }
            if state.rooms.contains_key(&b.room_id) {
                return Err(reject(ErrorCode::ResourceConflict));
            }
            if state.rooms.len() >= 32 || state.rooms.len() + state.retired.len() >= 4096 {
                return Err(reject(ErrorCode::ResourceCapacity));
            }
            state.rooms.insert(
                b.room_id.clone(),
                Room {
                    instance: b.room_instance_id.clone(),
                    deadline: std::time::Instant::now() + super::cleanup::LEASE,
                    router: None,
                    peers: HashMap::new(),
                    epochs: HashMap::new(),
                    music: None,
                    music_pending: false,
                    music_generation: 0,
                    volume: None,
                    speaker: None,
                },
            );
        }
        let mut reservation = RoomReservation {
            engine: self.clone(),
            binding: b.clone(),
            committed: false,
        };
        let codecs = serde_json::from_value(json!([
            {"kind":"audio","mimeType":"audio/opus","clockRate":48000,"channels":2},
            {"kind":"video","mimeType":"video/VP8","clockRate":90000}
        ]))
        .map_err(|_| MediaError::Protocol)?;
        let router = self
            .core
            .worker
            .create_router(RouterOptions::new(codecs))
            .await
            .map_err(native_error)?;
        let mut options = AudioLevelObserverOptions::default();
        options.max_entries = std::num::NonZeroU16::MIN;
        options.threshold = -70;
        options.interval = 100;
        let volume = router
            .create_audio_level_observer(options)
            .await
            .map_err(native_error)?;
        let speaker = router
            .create_active_speaker_observer(ActiveSpeakerObserverOptions::default())
            .await
            .map_err(native_error)?;
        let weak = Arc::downgrade(&self.core);
        volume
            .on_volumes(move |volumes| {
                if let (Some(core), Some(volume)) = (weak.upgrade(), volumes.first()) {
                    let level = (10_f64.powf(f64::from(volume.volume) / 70.0) * 10.0).round() as u8;
                    core.speaking(&volume.producer, Some(level));
                }
            })
            .detach();
        let weak = Arc::downgrade(&self.core);
        speaker
            .on_dominant_speaker(move |event| {
                if let Some(core) = weak.upgrade() {
                    core.speaking(&event.producer, None);
                }
            })
            .detach();
        {
            let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            state.room(b)?;
            let room = state
                .rooms
                .get_mut(&b.room_id)
                .ok_or(MediaError::Transport)?;
            room.router = Some(router);
            room.volume = Some(volume);
            room.speaker = Some(speaker);
        }
        reservation.committed = true;
        Ok(())
    }

    /// Allocate a participant lease with strictly increasing admission epochs.
    ///
    /// # Errors
    /// Rejects missing routers, duplicate/stale epochs and capacity.
    pub(super) fn create_peer(&self, b: &Binding) -> Result<(), MediaError> {
        let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
        let room = state.room(b)?;
        if room.router.is_none() {
            return Err(reject(ErrorCode::UnauthorizedSession));
        }
        if room.peers.contains_key(&b.peer_id)
            || room
                .epochs
                .get(&b.peer_id)
                .is_some_and(|epoch| *epoch >= b.admission_epoch)
        {
            return Err(reject(ErrorCode::ResourceConflict));
        }
        if room.peers.len() >= 256
            || (!room.epochs.contains_key(&b.peer_id) && room.epochs.len() >= 4096)
        {
            return Err(reject(ErrorCode::ResourceCapacity));
        }
        let room = state
            .rooms
            .get_mut(&b.room_id)
            .ok_or(MediaError::Transport)?;
        room.epochs.insert(b.peer_id.clone(), b.admission_epoch);
        room.peers.insert(
            b.peer_id.clone(),
            Peer {
                epoch: b.admission_epoch,
                deadline: std::time::Instant::now() + super::cleanup::LEASE,
                transports: HashMap::new(),
                producers: HashMap::new(),
                consumers: HashMap::new(),
                pending: 0,
            },
        );
        Ok(())
    }

    /// Retire the exact room before dropping native resources outside the lock.
    ///
    /// # Errors
    /// Missing or replaced room identities cannot close current resources.
    pub(super) fn close_room(&self, b: &Binding) -> Result<(), MediaError> {
        let room = {
            let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            state.room(b)?;
            state
                .retired
                .insert((b.room_id.clone(), b.room_instance_id.clone()));
            state.rooms.remove(&b.room_id)
        };
        drop(room);
        Ok(())
    }

    /// Retire exact participant resources and their same-room dependent consumers.
    ///
    /// # Errors
    /// Stale participant identities fail closed.
    pub(super) fn close_peer(&self, b: &Binding) -> Result<(), MediaError> {
        let (peer, consumers) = {
            let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            state.peer(b)?;
            let room = state
                .rooms
                .get_mut(&b.room_id)
                .ok_or(MediaError::Transport)?;
            let peer = room.peers.remove(&b.peer_id).ok_or(MediaError::Transport)?;
            let ids = peer.producers.keys().cloned().collect::<Vec<_>>();
            let consumers = take_consumers(room, &ids);
            (peer, consumers)
        };
        drop(consumers);
        drop(peer);
        Ok(())
    }

    /// Allocate fixed stereo Opus music resources; cancellation releases the reservation.
    ///
    /// # Errors
    /// Rejects duplicate music, retired rooms and native allocation failures.
    pub(super) async fn create_music(
        &self,
        b: &Binding,
        ssrc: u32,
    ) -> Result<MusicDestination, MediaError> {
        let (router, generation) = {
            let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            let room = state.room(b)?;
            if room.music.is_some() || room.music_pending {
                return Err(reject(ErrorCode::ResourceConflict));
            }
            let router = room
                .router
                .clone()
                .ok_or_else(|| reject(ErrorCode::UnauthorizedSession))?;
            let generation = room.music_generation;
            state
                .rooms
                .get_mut(&b.room_id)
                .ok_or(MediaError::Transport)?
                .music_pending = true;
            (router, generation)
        };
        let _reservation = MusicReservation {
            engine: self.clone(),
            binding: b.clone(),
            generation,
        };
        let mut options =
            PlainTransportOptions::new(self.core.network.listen(Protocol::Udp, false));
        options.comedia = true;
        let transport = router
            .create_plain_transport(options)
            .await
            .map_err(native_error)?;
        let rtp = serde_json::from_value(json!({
            "codecs":[{"mimeType":"audio/opus","payloadType":111,"clockRate":48000,"channels":2,
                "parameters":{"useinbandfec":1,"stereo":1,"sprop-stereo":1},"rtcpFeedback":[]}],
            "headerExtensions":[],"encodings":[{"ssrc":ssrc}],"rtcp":{"cname":format!("bodrik-music-{ssrc}"),"reducedSize":true}
        })).map_err(|_| MediaError::Protocol)?;
        let producer = transport
            .produce(ProducerOptions::new(
                mediasoup::prelude::MediaKind::Audio,
                rtp,
            ))
            .await
            .map_err(native_error)?;
        let result = MusicDestination {
            producer_id: producer.id().to_string(),
            port: transport.tuple().local_port(),
        };
        {
            let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            state.room(b)?;
            let room = state
                .rooms
                .get_mut(&b.room_id)
                .ok_or(MediaError::Transport)?;
            if room.music_generation != generation {
                return Err(reject(ErrorCode::UnauthorizedSession));
            }
            room.music = Some((transport, producer));
        }
        Ok(result)
    }

    /// Remove music resources and dependent consumers before dropping them.
    ///
    /// # Errors
    /// Missing/replaced room cannot retire a new room's music.
    pub(super) fn close_music(&self, b: &Binding) -> Result<(), MediaError> {
        self.close_music_matching(b, None)
    }

    /// Retire music only if a cancelled allocation still owns the current producer.
    ///
    /// # Errors
    /// Missing/replaced room ownership fails closed.
    pub(super) fn close_music_matching(
        &self,
        b: &Binding,
        expected: Option<&str>,
    ) -> Result<(), MediaError> {
        let (music, consumers) = {
            let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            state.room(b)?;
            let room = state
                .rooms
                .get_mut(&b.room_id)
                .ok_or(MediaError::Transport)?;
            if expected.is_some_and(|id| {
                room.music
                    .as_ref()
                    .is_none_or(|(_, producer)| producer.id().to_string() != id)
            }) {
                return Ok(());
            }
            room.music_generation = room
                .music_generation
                .checked_add(1)
                .ok_or(MediaError::Transport)?;
            room.music_pending = false;
            let music = room.music.take();
            let ids = music
                .as_ref()
                .map(|(_, p)| vec![p.id().to_string()])
                .unwrap_or_default();
            (music, take_consumers(room, &ids))
        };
        drop(consumers);
        drop(music);
        Ok(())
    }
}

/// Pending music capacity resets on success, failure or cancellation.
struct MusicReservation {
    /// Generation of the pending music allocation.
    generation: u64,
    /// Registry owner retained for cleanup.
    engine: Engine,
    /// Exact room incarnation.
    binding: Binding,
}

impl Drop for MusicReservation {
    /// Never reset a replacement room's reservation.
    fn drop(&mut self) {
        if let Ok(mut state) = self.engine.core.state.lock()
            && state.room(&self.binding).is_ok()
            && let Some(room) = state.rooms.get_mut(&self.binding.room_id)
            && room.music_generation == self.generation
        {
            room.music_pending = false;
        }
    }
}

/// Detach same-room consumers for retired producers; caller drops them after unlocking.
pub(super) fn take_consumers(room: &mut Room, ids: &[String]) -> Vec<Consumer> {
    let mut removed = Vec::new();
    for peer in room.peers.values_mut() {
        let keys = peer
            .consumers
            .iter()
            .filter(|(_, c)| ids.contains(&c.producer_id().to_string()))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(c) = peer.consumers.remove(&key) {
                removed.push(c);
            }
        }
    }
    removed
}

/// Sanitize native failures while retaining details only in server diagnostics.
pub(super) fn native_error(error: impl std::fmt::Display) -> MediaError {
    tracing::warn!(%error, "native media operation failed");
    reject(ErrorCode::MediaFailure)
}
