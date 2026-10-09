//! Bounded, lossy playback change notifications; repair snapshots remain authoritative.

use tokio::sync::broadcast;

/// Notification identifying the room whose committed playback state changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybackEvent {
    /// Authoritative room identity.
    pub room_id: i64,
    /// Process-local change token, not a durable log sequence.
    pub revision: usize,
}

/// Optional in-process fan-out; no subscriber is a normal playback-only configuration.
#[derive(Clone)]
pub struct PlaybackObserver {
    /// Bounded notification channel.
    sender: broadcast::Sender<PlaybackEvent>,
    /// Latest commit wake-up for embedded consumers; no unbounded event queue.
    changes: tokio::sync::watch::Sender<u64>,
}

impl PlaybackObserver {
    /// Create bounded delivery; lagging receivers must repair from a fresh snapshot.
    ///
    /// # Panics
    /// Panics for zero capacity, which is a caller configuration bug.
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self {
            sender,
            changes: tokio::sync::watch::channel(0).0,
        }
    }

    /// Subscribe to coalesced commits; embedded callers repair through authoritative snapshots.
    pub fn changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Publish a committed transition without making playback depend on subscribers.
    pub fn publish(&self, room_id: i64, revision: usize) {
        let _ = self.sender.send(PlaybackEvent { room_id, revision });
        self.changes
            .send_modify(|token| *token = token.wrapping_add(1));
    }
}

/// In-process delivery/failure tables; no provider or socket fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Capacity/lag/no-subscriber behavior is explicit, including rejected zero capacity.
    #[test]
    fn channel_cases() {
        assert!(std::panic::catch_unwind(|| PlaybackObserver::new(0)).is_err());
        for capacity in [1, 2, 4] {
            let observer = PlaybackObserver::new(capacity);
            observer.publish(1, 0);
            let mut receiver = observer.sender.subscribe();
            for revision in 1..=capacity + 1 {
                observer.publish(7, revision);
            }
            assert!(matches!(
                receiver.try_recv(),
                Err(broadcast::error::TryRecvError::Lagged(_))
            ));
            let event = receiver.try_recv().unwrap();
            assert_eq!(event.room_id, 7);
            assert_eq!(event.revision, 2);
        }
    }
}
