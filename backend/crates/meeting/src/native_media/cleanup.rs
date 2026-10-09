//! Bounded orphan cleanup, including committed resources whose caller was cancelled.
use super::*;
use crate::media::protocol::Binding;
use std::time::{Duration, Instant};

/// Native orphan lease; application renewal cannot change admission or moderation.
pub(super) const LEASE: Duration = Duration::from_secs(30);

impl Engine {
    /// Extend an exact current owner after a trusted inventory or renewal command.
    ///
    /// # Errors
    /// Expired/replaced owners cannot be revived.
    pub(super) fn renew(&self, b: &Binding) -> Result<(), MediaError> {
        let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
        state.peer_mut(b)?.deadline = Instant::now() + LEASE;
        Ok(())
    }
}

impl Core {
    /// Detach expired owners before native drop callbacks can publish observations.
    pub(super) fn expire(&self) {
        let removed = match self.state.lock() {
            Ok(mut state) => {
                let now = Instant::now();
                let mut peers = Vec::new();
                let mut transports = Vec::new();
                let mut producers = Vec::new();
                let mut consumers = Vec::new();
                for room in state.rooms.values_mut() {
                    let expired = room
                        .peers
                        .iter()
                        .filter(|(_, p)| now >= p.deadline)
                        .map(|(id, _)| id.clone())
                        .collect::<Vec<_>>();
                    for id in expired {
                        if let Some(peer) = room.peers.remove(&id) {
                            let ids = peer.producers.keys().cloned().collect::<Vec<_>>();
                            consumers.extend(super::lifecycle::take_consumers(room, &ids));
                            peers.push(peer);
                        }
                    }
                    for peer in room.peers.values_mut() {
                        let ids = peer
                            .transports
                            .iter()
                            .filter(|(_, t)| t.closed())
                            .map(|(id, _)| id.clone())
                            .collect::<Vec<_>>();
                        for id in ids {
                            if let Some(t) = peer.transports.remove(&id) {
                                transports.push(t);
                            }
                        }
                        let ids = peer
                            .producers
                            .iter()
                            .filter(|(_, (p, _))| p.closed())
                            .map(|(id, _)| id.clone())
                            .collect::<Vec<_>>();
                        for id in ids {
                            if let Some(p) = peer.producers.remove(&id) {
                                producers.push(p);
                            }
                        }
                        let ids = peer
                            .consumers
                            .iter()
                            .filter(|(_, c)| c.closed())
                            .map(|(id, _)| id.clone())
                            .collect::<Vec<_>>();
                        for id in ids {
                            if let Some(c) = peer.consumers.remove(&id) {
                                consumers.push(c);
                            }
                        }
                    }
                }
                let expired = state
                    .rooms
                    .iter()
                    .filter(|(_, r)| r.peers.is_empty() && now >= r.deadline)
                    .map(|(id, r)| (id.clone(), r.instance.clone()))
                    .collect::<Vec<_>>();
                let mut rooms = Vec::new();
                for (id, instance) in expired {
                    state.retired.insert((id.clone(), instance));
                    if let Some(room) = state.rooms.remove(&id) {
                        rooms.push(room);
                    }
                }
                Some((peers, transports, producers, consumers, rooms))
            }
            Err(_) => {
                tracing::error!("native orphan cleanup registry poisoned");
                None
            }
        };
        drop(removed);
    }
}

impl Drop for Core {
    /// Abort the owned lease supervisor when the last engine owner disappears.
    fn drop(&mut self) {
        if let Ok(task) = self.cleanup.get_mut()
            && let Some(task) = task.take()
        {
            task.abort();
        }
    }
}
