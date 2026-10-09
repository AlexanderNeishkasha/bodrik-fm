//! Ordered bounded direct observations; dropped history requires reconciliation.
use super::*;
use crate::media::{Event, protocol::Binding};
use serde_json::{Value, json};

impl Core {
    /// Assign contiguous sequence numbers under the same lock as broadcast publication.
    pub(super) fn publish(&self, kind: &str, payload: Value) {
        match self.sequence.lock() {
            Ok(mut sequence) => {
                let Some(next) = sequence.checked_add(1) else {
                    return;
                };
                *sequence = next;
                let _ = self.events.send(Event {
                    boot_id: self.boot.clone(),
                    sequence: next,
                    kind: kind.into(),
                    payload,
                });
            }
            Err(_) => tracing::error!("native observation sequence poisoned"),
        }
    }

    /// Resolve exact current audio ownership before producing a speaking observation.
    pub(super) fn speaking(&self, producer: &Producer, level: Option<u8>) {
        let binding = self.state.lock().ok().and_then(|state| {
            state.rooms.iter().find_map(|(id, room)| {
                room.peers.iter().find_map(|(peer_id, peer)| {
                    peer.producers
                        .get(&producer.id().to_string())
                        .filter(|(p, _)| !p.closed())
                        .map(|_| Binding {
                            room_id: id.clone(),
                            room_instance_id: room.instance.clone(),
                            peer_id: peer_id.clone(),
                            admission_epoch: peer.epoch,
                        })
                })
            })
        });
        if let Some(binding) = binding {
            match level {
                Some(level) if level > 1 => {
                    self.publish("audioVolume", json!({"binding":binding,"level":level}))
                }
                None => self.publish("dominantSpeaker", json!({"binding":binding})),
                _ => {}
            }
        }
    }
}

/// Owned direct broadcast subscription with an atomic initial sequence baseline.
pub struct NativeEventStream {
    /// Ready frame, consumed before observations.
    ready: Option<Event>,
    /// Bounded receiver; lag requests fail-closed reconciliation.
    receiver: broadcast::Receiver<Event>,
    /// Expected native worker identity.
    boot: String,
    /// Last delivered sequence; gaps cannot be trusted.
    sequence: u64,
    /// Terminal continuity loss cannot be retried on the same stream.
    failed: bool,
}

impl Engine {
    /// Subscribe atomically with initial baseline; no event can fall between the two.
    ///
    /// # Errors
    /// Wrong boot, dead worker or sequence poisoning rejects subscription.
    pub async fn events(&self, boot: &str) -> Result<NativeEventStream, MediaError> {
        self.metadata().await?;
        if boot != self.core.boot {
            return Err(MediaError::ReconcileRequired);
        }
        let sequence = self
            .core
            .sequence
            .lock()
            .map_err(|_| MediaError::Transport)?;
        let receiver = self.core.events.subscribe();
        Ok(NativeEventStream::new(boot.into(), *sequence, receiver))
    }
}

impl NativeEventStream {
    /// Construct an atomic ready baseline and its already subscribed receiver.
    pub(super) fn new(boot: String, sequence: u64, receiver: broadcast::Receiver<Event>) -> Self {
        Self {
            ready: Some(Event {
                boot_id: boot.clone(),
                sequence,
                kind: "ready".into(),
                payload: json!({}),
            }),
            receiver,
            boot,
            sequence,
            failed: false,
        }
    }

    /// Read one observation; loss is surfaced instead of silently skipping history.
    ///
    /// # Errors
    /// Lag or closed publisher requires full resource reconciliation.
    pub async fn next_event(&mut self) -> Result<Event, MediaError> {
        if let Some(ready) = self.ready.take() {
            return Ok(ready);
        }
        if self.failed {
            return Err(MediaError::ReconcileRequired);
        }
        let event = match self.receiver.recv().await {
            Ok(event)
                if event.boot_id == self.boot
                    && self.sequence.checked_add(1) == Some(event.sequence) =>
            {
                event
            }
            _ => {
                self.failed = true;
                return Err(MediaError::ReconcileRequired);
            }
        };
        self.sequence = event.sequence;
        Ok(event)
    }
}

/// Direct-stream continuity remains terminal and cancellation-safe without SSE parsing.
#[cfg(test)]
mod tests {
    use super::*;

    /// Build one synthetic same-worker observation.
    fn event(sequence: u64) -> Event {
        Event {
            boot_id: "boot".into(),
            sequence,
            kind: "workerDied".into(),
            payload: json!({}),
        }
    }

    /// Gaps, replaced workers, lag and closed publishers permanently invalidate subscriptions.
    #[tokio::test]
    async fn continuity_cases() {
        for name in ["gap", "wrong boot", "lag", "closed"] {
            let (sender, receiver) = broadcast::channel(1);
            let mut stream = NativeEventStream::new("boot".into(), 0, receiver);
            stream.next_event().await.expect("baseline");
            let mut next = event(1);
            match name {
                "gap" => next.sequence = 2,
                "wrong boot" => next.boot_id = "replacement".into(),
                _ => {}
            }
            if name != "closed" {
                sender.send(next).expect("receiver");
            }
            if name == "lag" {
                sender.send(event(2)).expect("receiver");
            }
            drop(sender);
            assert!(
                matches!(
                    stream.next_event().await,
                    Err(MediaError::ReconcileRequired)
                ),
                "{name}"
            );
            assert!(
                matches!(
                    stream.next_event().await,
                    Err(MediaError::ReconcileRequired)
                ),
                "{name} remains terminal"
            );
        }
    }

    /// Cancelling a pending read does not consume or corrupt the next observation.
    #[tokio::test]
    async fn cancelled_read_preserves_event() {
        let (sender, receiver) = broadcast::channel(1);
        let mut stream = NativeEventStream::new("boot".into(), 7, receiver);
        assert_eq!(stream.next_event().await.expect("baseline").sequence, 7);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), stream.next_event())
                .await
                .is_err()
        );
        sender.send(event(8)).expect("receiver");
        assert_eq!(
            stream
                .next_event()
                .await
                .expect("after cancellation")
                .sequence,
            8
        );
    }
}
