//! Independent ownership verification, atomic capability rotation and one fenced grace-cleanup owner.
use super::{
    Service,
    admission::{Welcome, capability},
    session::{self, digest, proves},
    wire::Outbound,
};
use crate::{
    runtime::Command,
    signaling::{Hello, SessionStamp},
};
use serde_json::json;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// Disconnected native leases remain eligible for recovery for ten seconds, never indefinitely.
const GRACE: Duration = Duration::from_secs(10);

/// Authenticate both independent proofs and current entitlement before rotating a disconnected session.
///
/// # Errors
/// Denies stolen capability alone, expired/reused proof, connected takeover, room drift and outages.
pub(super) async fn resume(
    service: &Service,
    slug: &str,
    hello: Hello,
    events: mpsc::Sender<Outbound>,
) -> Result<Welcome, &'static str> {
    let Hello::Resume {
        session_id,
        recovery_token,
        owner_proof,
        ..
    } = hello
    else {
        return Err("invalid");
    };
    let _lifecycle = service.lifecycle.lock().await;
    if !super::available(service) {
        return Err("unavailable");
    }
    let (old_stamp, binding, room) = {
        let store = service.store.lock().map_err(|_| "unavailable")?;
        let session = store.sessions.get(&session_id).ok_or("denied")?;
        verify(session, &recovery_token, &owner_proof)?;
        let room = store
            .rooms
            .get(&session.binding.room_id)
            .filter(|room| room.slug == slug)
            .cloned()
            .ok_or("denied")?;
        (session.stamp.clone(), session.binding.clone(), room)
    };
    let grant = service
        .config
        .player
        .authorize(&binding.room_id)
        .await
        .map_err(|_| "unavailable")?
        .ok_or("denied")?;
    if grant.generation != room.generation || grant.room_slug != slug {
        return Err("denied");
    }
    if service
        .config
        .media
        .metadata()
        .await
        .map_err(|_| "unavailable")?
        .boot_id
        != room.boot
    {
        return Err("stale");
    }
    service.runtime.apply_verified(
        Command::Renew {
            room_id: binding.room_id.clone(),
            room_instance_id: binding.room_instance_id.clone(),
        },
        Some(grant),
    )?;
    let phase = service
        .runtime
        .apply_verified(
            Command::Inspect {
                room_id: binding.room_id.clone(),
                room_instance_id: binding.room_instance_id.clone(),
                peer_id: binding.peer_id.clone(),
                epoch: binding.admission_epoch,
            },
            None,
        )?
        .phase
        .ok_or("denied")?;
    let role = service
        .runtime
        .apply_verified(
            Command::Role {
                room_id: binding.room_id.clone(),
                room_instance_id: binding.room_instance_id.clone(),
                peer_id: binding.peer_id.clone(),
                epoch: binding.admission_epoch,
            },
            None,
        )?
        .presenter
        .ok_or("denied")?;
    if !super::available(service) {
        return Err("draining");
    }
    let recovery = capability();
    let stamp = {
        let mut store = service.store.lock().map_err(|_| "unavailable")?;
        let session = store
            .sessions
            .get_mut(&session_id)
            .filter(|session| session.stamp == old_stamp)
            .ok_or("stale")?;
        verify(session, &recovery_token, &owner_proof)?;
        session.stamp.admission_epoch = session
            .stamp
            .admission_epoch
            .checked_add(1)
            .filter(|epoch| *epoch <= crate::media::protocol::JS_SAFE_INTEGER)
            .ok_or("capacity")?;
        session.recovery = digest(b"replacement-recovery-v1", &recovery);
        session.events = Some(events);
        session.grace = None;
        session.revision = 0;
        session.stamp.clone()
    };
    Ok(Welcome {
        frame: json!({"type":"welcome","version":1,"stamp":stamp,"recoveryToken":recovery,"revision":0,"phase":phase,"presenter":role}),
        stamp,
    })
}

/// Verify a disconnected unexpired session and both domain-separated private proofs.
///
/// # Errors
/// Connected sessions cannot be displaced; possession of only one credential grants no ownership.
fn verify(session: &session::Session, recovery: &str, owner: &str) -> Result<(), &'static str> {
    let purpose = session::owner_purpose(&session.actor);
    if session.events.is_some()
        || session
            .grace
            .is_none_or(|deadline| Instant::now() >= deadline)
        || !proves(&session.owner, purpose.as_bytes(), owner)
        || !proves(&session.recovery, b"replacement-recovery-v1", recovery)
    {
        return Err("denied");
    }
    Ok(())
}

/// Mark only the current socket disconnected; the owned supervisor expires its exact grace stamp.
pub(super) fn disconnect(service: &Service, stamp: &SessionStamp) {
    {
        let Ok(mut store) = service.store.lock() else {
            tracing::error!("replacement registry poisoned");
            return;
        };
        if !store
            .sessions
            .get(&stamp.session_id)
            .is_some_and(|session| session.stamp == *stamp && session.events.is_some())
        {
            return;
        }
        super::file::cancel_session(&mut store, stamp, "disconnected");
        let Some(session) = store
            .sessions
            .get_mut(&stamp.session_id)
            .filter(|session| session.stamp == *stamp && session.events.is_some())
        else {
            return;
        };
        session.events = None;
        session.grace = Some(Instant::now() + GRACE);
    }
}

/// Independent ownership, grace and connected-takeover rejection tables.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::protocol::Binding;

    /// Construct private digest-only session metadata; no native service or player database is used.
    fn session(connected: bool, expired: bool) -> session::Session {
        let (events, _) = mpsc::channel(1);
        session::Session {
            stamp: SessionStamp {
                room_instance_id: "instance".into(),
                session_id: "session".into(),
                admission_epoch: 1,
            },
            binding: Binding {
                room_id: "conference".into(),
                room_instance_id: "instance".into(),
                peer_id: "session".into(),
                admission_epoch: 3,
            },
            owner: digest(b"replacement-owner-v1:actor", "owner"),
            recovery: digest(b"replacement-recovery-v1", "capability"),
            actor: "actor".into(),
            name: "actor".into(),
            avatar: String::new(),
            revision: 0,
            events: connected.then_some(events),
            grace: Some(if expired {
                Instant::now() - Duration::from_secs(1)
            } else {
                Instant::now() + GRACE
            }),
        }
    }

    /// Neither stolen proof alone, foreign actor binding, expired grace nor a connected takeover succeeds.
    #[test]
    fn ownership_cases() {
        for (name, connected, expired, recovery, owner, accepted) in [
            ("valid", false, false, "capability", "owner", true),
            (
                "connected takeover",
                true,
                false,
                "capability",
                "owner",
                false,
            ),
            ("expired", false, true, "capability", "owner", false),
            (
                "stolen capability",
                false,
                false,
                "capability",
                "other-owner",
                false,
            ),
            (
                "stolen owner proof",
                false,
                false,
                "other-capability",
                "owner",
                false,
            ),
        ] {
            assert_eq!(
                verify(&session(connected, expired), recovery, owner).is_ok(),
                accepted,
                "{name}"
            );
        }
        let mut foreign = session(false, false);
        foreign.actor = "other-actor".into();
        assert!(verify(&foreign, "capability", "owner").is_err());
        foreign = session(false, false);
        foreign.recovery = digest(b"replacement-recovery-v1", "rotated-capability");
        assert!(verify(&foreign, "capability", "owner").is_err());
        assert!(verify(&foreign, "rotated-capability", "owner").is_ok());
    }
}
