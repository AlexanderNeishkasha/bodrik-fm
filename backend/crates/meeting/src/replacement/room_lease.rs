//! One bounded, cancellable authority refresh owner per live room incarnation.
use super::{
    Service,
    session::{self, Room},
};
use crate::runtime::Command;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{sync::watch, task::JoinSet};

/// Match the active authority budget; other rooms remain pending without spawning tasks.
const CONCURRENCY: usize = 8;

/// Refresh scheduling only; authoritative room validity remains exclusively in Runtime.
pub(super) struct Schedule {
    /// Next refresh/retry eligibility, staggered across room owners.
    next: Instant,
    /// One in-flight refresh per incarnation, never per participant.
    refreshing: bool,
}

impl Schedule {
    /// Seed a room from its fresh admission grant; spread initial checks within the refresh window.
    pub(super) fn new(seconds: u32, reservation: u64) -> Arc<Mutex<Self>> {
        let now = Instant::now();
        Arc::new(Mutex::new(Self {
            next: now + refresh_delay(seconds, u128::from(reservation.wrapping_mul(7919))),
            refreshing: false,
        }))
    }

    /// Claim one refresh; concurrent delivery, commands and heartbeats cannot duplicate it.
    fn claim(&mut self, now: Instant) -> bool {
        if self.refreshing || now < self.next {
            return false;
        }
        self.refreshing = true;
        true
    }

    /// Schedule the next check; this never creates or extends an authority deadline.
    fn accept(&mut self, now: Instant, seconds: u32) {
        self.next = now + refresh_delay(seconds, uuid::Uuid::new_v4().as_u128());
        self.refreshing = false;
    }

    /// Transient failure preserves only the unexpired grant and schedules a bounded retry.
    fn retry(&mut self, now: Instant) {
        self.next = now + retry_delay(uuid::Uuid::new_v4().as_u128());
        self.refreshing = false;
    }
}

/// Sample a nineteen-to-twenty-one-second refresh, capped at forty percent of a shorter grant.
fn refresh_delay(seconds: u32, sample: u128) -> Duration {
    Duration::from_millis(19000 + (sample % 2001) as u64)
        .min(Duration::from_secs(u64::from(seconds)) * 2 / 5)
}

/// Spread transient-error retries over half a second to one and a half seconds.
fn retry_delay(sample: u128) -> Duration {
    Duration::from_millis(500 + (sample % 1001) as u64)
}

/// Own all room refresh tasks; shutdown cancels and drains outstanding HTTP work.
pub(super) async fn supervise(service: Service, mut stop: watch::Receiver<bool>) {
    let mut tasks = JoinSet::new();
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if *stop.borrow() {
            break;
        }
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() { break; }
            }
            Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                if let Err(error) = result { tracing::error!(%error, "room authority owner failed"); }
            }
            _ = tick.tick() => {
                if !super::available(&service) { continue; }
                let rooms = match service.store.lock() {
                    Ok(store) => store.rooms.values().cloned().collect::<Vec<_>>(),
                    Err(_) => { tracing::error!("room authority registry poisoned"); break; }
                };
                for room in rooms {
                    if tasks.len() >= CONCURRENCY { break; }
                    let claimed = room.renewal.lock().is_ok_and(|mut lease| lease.claim(Instant::now()));
                    if claimed {
                        let owner = service.clone();
                        tasks.spawn(async move { refresh(&owner, &room).await; });
                    }
                }
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}

/// Fetch once for the room and commit only against the same current incarnation.
async fn refresh(service: &Service, room: &Room) {
    let result = service.config.player.authorize(&room.binding.room_id).await;
    tracing::debug!(
        outcome = if result.is_ok() {
            "response"
        } else {
            "unavailable"
        },
        "room authority refresh"
    );
    let now = Instant::now();
    let revoked = {
        let Ok(store) = service.store.lock() else {
            return;
        };
        let Some(current) = store.rooms.get(&room.binding.room_id).filter(|current| {
            current.binding.room_instance_id == room.binding.room_instance_id
                && current.boot == room.boot
        }) else {
            return;
        };
        let Ok(mut schedule) = current.renewal.lock() else {
            return;
        };
        if !super::available(service) {
            schedule.retry(now);
            return;
        }
        let authoritative = match service
            .runtime
            .room_current(&room.binding.room_id, &room.binding.room_instance_id)
        {
            Ok(current) => current,
            Err(category) => {
                tracing::error!(category, "room authority registry unavailable");
                false
            }
        };
        let denied = match result {
            Ok(Some(grant))
                if grant.generation == room.generation
                    && grant.room_slug == room.slug
                    && authoritative =>
            {
                let seconds = grant.lease_seconds;
                if service
                    .runtime
                    .apply_verified(
                        Command::Renew {
                            room_id: room.binding.room_id.clone(),
                            room_instance_id: room.binding.room_instance_id.clone(),
                        },
                        Some(grant),
                    )
                    .is_ok()
                {
                    schedule.accept(now, seconds);
                    false
                } else {
                    schedule.refreshing = true;
                    true
                }
            }
            Err(_) if authoritative => {
                schedule.retry(now);
                false
            }
            _ => {
                schedule.refreshing = true;
                true
            }
        };
        if denied {
            // Fence domain rights before waiting for lifecycle/native cleanup.
            if let Err(category) = service.runtime.apply_verified(
                Command::Abort {
                    room_id: room.binding.room_id.clone(),
                    epoch: room.reservation,
                },
                None,
            ) {
                tracing::warn!(category, "room authority retirement failed closed");
            }
        }
        denied
    };
    if revoked {
        tracing::warn!("room authority revoked or expired");
        let _lifecycle = service.lifecycle.lock().await;
        session::retire(service, room).await;
    }
}

#[cfg(test)]
mod tests;
