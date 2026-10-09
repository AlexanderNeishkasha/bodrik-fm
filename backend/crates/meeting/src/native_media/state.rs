//! Resource ownership, bounded allocation reservations and stale-owner fences.
use super::*;
use crate::media::protocol::{Binding, ErrorCode, MediaType};
use std::{
    collections::{HashMap, HashSet},
    sync::Weak,
};

/// Stable provider rejection without native error details.
pub(super) fn reject(code: ErrorCode) -> MediaError {
    MediaError::Rejected(code)
}

/// Process-local resource registry with bounded retained incarnation history.
#[derive(Default)]
pub(super) struct State {
    /// Sole room owners, including pending router reservations.
    pub rooms: HashMap<String, Room>,
    /// Retired room identities cannot be recreated during this boot.
    pub retired: HashSet<(String, String)>,
    /// Shutdown rejects all subsequent allocation.
    pub stopped: bool,
}

/// One router incarnation and its current native participant leases.
pub(super) struct Room {
    /// Server-issued room incarnation.
    pub instance: String,
    /// Empty-room orphan deadline, unaffected by replacement peers.
    pub deadline: std::time::Instant,
    /// Router is absent until observer setup finishes.
    pub router: Option<Router>,
    /// Current media peers; application membership is owned elsewhere.
    pub peers: HashMap<String, Peer>,
    /// Maximum previously allocated epoch per peer.
    pub epochs: HashMap<String, u64>,
    /// Room-owned music transport/producer.
    pub music: Option<(PlainTransport, Producer)>,
    /// Prevent simultaneous music allocation.
    pub music_pending: bool,
    /// Music replacement generation fences late PlainTransport allocations.
    pub music_generation: u64,
    /// Audio level observer lifetime owner.
    pub volume: Option<AudioLevelObserver>,
    /// Dominant speaker observer lifetime owner.
    pub speaker: Option<ActiveSpeakerObserver>,
}

/// Participant native handles are retained until explicitly retired or closed.
pub(super) struct Peer {
    /// Admission incarnation; reuse is forbidden.
    pub epoch: u64,
    /// Exact native owner lease expiry.
    pub deadline: std::time::Instant,
    /// Participant transports.
    pub transports: HashMap<String, WebRtcTransport>,
    /// Producer handles and their browser category.
    pub producers: HashMap<String, (Producer, MediaType)>,
    /// Participant consumers.
    pub consumers: HashMap<String, Consumer>,
    /// Concurrent native allocations reserve capacity across awaits.
    pub pending: usize,
}

impl State {
    /// Resolve only an exact live room incarnation.
    ///
    /// # Errors
    /// Retired, missing or stopped owners fail closed.
    pub fn room(&self, b: &Binding) -> Result<&Room, MediaError> {
        self.rooms
            .get(&b.room_id)
            .filter(|r| !self.stopped && r.instance == b.room_instance_id)
            .ok_or_else(|| reject(ErrorCode::UnauthorizedSession))
    }

    /// Resolve an exact participant and reject a pending router.
    ///
    /// # Errors
    /// Missing/replaced participants or uninitialized rooms are unauthorized.
    pub fn peer(&self, b: &Binding) -> Result<&Peer, MediaError> {
        let room = self.room(b)?;
        room.peers
            .get(&b.peer_id)
            .filter(|p| {
                room.router.is_some()
                    && p.epoch == b.admission_epoch
                    && std::time::Instant::now() < p.deadline
            })
            .ok_or_else(|| reject(ErrorCode::UnauthorizedSession))
    }

    /// Resolve mutable participant state after validating its exact identity.
    ///
    /// # Errors
    /// Same rejection as immutable owner resolution.
    pub fn peer_mut(&mut self, b: &Binding) -> Result<&mut Peer, MediaError> {
        self.peer(b)?;
        self.rooms
            .get_mut(&b.room_id)
            .and_then(|r| r.peers.get_mut(&b.peer_id))
            .ok_or_else(|| reject(ErrorCode::UnauthorizedSession))
    }
}

/// Cancellation-safe reservation; dropping a future releases pending capacity.
pub(super) struct Reservation {
    /// Weak registry reference avoids extending service lifetime.
    core: Weak<Core>,
    /// Exact owner whose pending capacity was reserved.
    binding: Binding,
}

impl Engine {
    /// Reserve bounded capacity before awaiting a native allocation.
    ///
    /// # Errors
    /// Stale owners, poisoned state or exhausted handle capacity reject allocation.
    pub(super) fn reserve(
        &self,
        b: &Binding,
        count: fn(&Peer) -> usize,
    ) -> Result<Reservation, MediaError> {
        let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
        let peer = state.peer_mut(b)?;
        if count(peer) + peer.pending >= 32 {
            return Err(reject(ErrorCode::ResourceCapacity));
        }
        peer.pending += 1;
        Ok(Reservation {
            core: Arc::downgrade(&self.core),
            binding: b.clone(),
        })
    }

    /// Check native continuation authority after every asynchronous operation.
    ///
    /// # Errors
    /// A retired owner cannot publish a late native handle.
    pub(super) fn current(&self, b: &Binding) -> Result<(), MediaError> {
        self.core
            .state
            .lock()
            .map_err(|_| MediaError::Transport)?
            .peer(b)?;
        Ok(())
    }
}

impl Drop for Reservation {
    /// Release only the original owner; replacements never inherit pending work.
    fn drop(&mut self) {
        if let Some(core) = self.core.upgrade() {
            match core.state.lock() {
                Ok(mut state) => {
                    if let Ok(peer) = state.peer_mut(&self.binding) {
                        peer.pending = peer.pending.saturating_sub(1);
                    }
                }
                Err(_) => tracing::error!("native allocation registry poisoned"),
            }
        }
    }
}
