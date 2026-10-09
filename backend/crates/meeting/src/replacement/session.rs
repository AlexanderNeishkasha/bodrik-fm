//! Socket ownership and private native handles; domain phases/roles remain in the existing Runtime.
use super::{Service, file, native, wire::Outbound};
use crate::{media::protocol::Binding, runtime::Command, signaling::SessionStamp};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Instant};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;

/// Bounded connection/native-handle metadata, not a second policy registry.
#[derive(Default)]
pub(super) struct Store {
    /// Current native router bindings keyed by private conference identifier.
    pub rooms: HashMap<String, Room>,
    /// Rust-issued socket/session ownership records.
    pub sessions: HashMap<String, Session>,
    /// Rust-owned active file transfers keyed by canonical UUID.
    pub transfers: HashMap<uuid::Uuid, file::Transfer>,
}

/// Private resource mapping; rights are always derived from Runtime and fresh player grants.
#[derive(Clone)]
pub(super) struct Room {
    /// Exact native allocation binding; room lifecycle ignores its placeholder peer identity.
    pub binding: Binding,
    /// Native service boot used for every command; never silently replaced.
    pub boot: String,
    /// Player generation at room admission, rechecked for every lease renewal.
    pub generation: u64,
    /// Rust reservation epoch used for exact room retirement.
    pub reservation: u64,
    /// Canonical public slug, rechecked on renewal/recovery.
    pub slug: String,
    /// Shared refresh schedule; Runtime owns the sole authoritative grant deadline.
    pub renewal: std::sync::Arc<std::sync::Mutex<super::room_lease::Schedule>>,
    /// Sole current presenter-owned Follow Me projection.
    pub follow: Option<Follow>,
    /// Current server-owned music source and meeting-wide gain.
    pub music: Option<Music>,
}

/// Current server-owned music source projected separately from admitted humans.
#[derive(Clone)]
pub(super) struct Music {
    /// Opaque native producer handle.
    pub producer_id: String,
    /// Validated meeting-wide gain.
    pub volume: f64,
}

/// Current room Follow Me projection; target is always an exact current public stamp.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Follow {
    /// Exact presenter incarnation that owns this view policy.
    pub owner: SessionStamp,
    /// Follow Me is enabled whenever this projection exists.
    pub enabled: bool,
    /// Current pin/focus action, absent after toggle/clear.
    pub action: Option<String>,
    /// Exact current participant target for pin/focus.
    pub target: Option<SessionStamp>,
}

/// One established session, with no plaintext credentials or copied domain role/phase.
pub(super) struct Session {
    /// Current public connection fence; rotates atomically on recovery.
    pub stamp: SessionStamp,
    /// Exact native binding; resources remain owned during bounded disconnect grace.
    pub binding: Binding,
    /// Independent owner-proof digest bound at initial admission.
    pub owner: [u8; 32],
    /// Single-use rotating recovery capability digest; plaintext exists only in welcome output.
    pub recovery: [u8; 32],
    /// Server-verified actor identity; never edited by profile/name commands.
    pub actor: String,
    /// Bounded participant display name; never role or actor authority.
    pub name: String,
    /// Same-origin Rust-uploaded avatar path or empty fallback.
    pub avatar: String,
    /// Current connection event sink; absence means grace, never an admitted delivery recipient.
    pub events: Option<mpsc::Sender<Outbound>>,
    /// Exclusive recovery deadline after disconnect; connected sessions have no grace deadline.
    pub grace: Option<Instant>,
    /// Contiguous public event revision for this socket incarnation; reset on recovery.
    pub revision: u64,
}

/// Build the actor-bound domain separator shared by admission, recovery and uploads.
pub(super) fn owner_purpose(actor: &str) -> String {
    format!("replacement-owner-v1:{actor}")
}

/// Domain-separated private credential digest; secret-bearing inputs are never formatted.
pub(super) fn digest(purpose: &[u8], secret: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(purpose);
    hash.update(secret.as_bytes());
    hash.finalize().into()
}

/// Constant-time comparison against the expected domain-separated credential digest.
pub(super) fn proves(expected: &[u8; 32], purpose: &[u8], secret: &str) -> bool {
    bool::from(expected.ct_eq(&digest(purpose, secret)))
}

/// Read an exact live socket incarnation without accepting browser-selected native identities.
///
/// # Errors
/// Rejects stale/disconnected/recovered socket ownership.
pub(super) fn binding(
    service: &Service,
    stamp: &SessionStamp,
) -> Result<(Binding, Room), &'static str> {
    let store = service.store.lock().map_err(|_| "unavailable")?;
    let session = store
        .sessions
        .get(&stamp.session_id)
        .filter(|session| session.stamp == *stamp && session.events.is_some())
        .ok_or("stale")?;
    let room = store.rooms.get(&session.binding.room_id).ok_or("stale")?;
    Ok((session.binding.clone(), room.clone()))
}

/// Derive a public authoritative snapshot without exposing provider/native/actor/recovery secrets.
///
/// # Errors
/// Rejects stale or unadmitted command actors; domain policy determines all recipients/roles/phases.
pub(super) fn snapshot(service: &Service, stamp: &SessionStamp) -> Result<Value, &'static str> {
    let (binding, _) = binding(service, stamp)?;
    let members = service
        .runtime
        .apply_verified(
            Command::Members {
                room_id: binding.room_id.clone(),
                room_instance_id: binding.room_instance_id.clone(),
                peer_id: binding.peer_id.clone(),
                epoch: binding.admission_epoch,
                pending: false,
            },
            None,
        )?
        .members
        .ok_or("denied")?;
    let store = service.store.lock().map_err(|_| "unavailable")?;
    let peers = store
        .sessions
        .values()
        .filter(|session| {
            session.binding.room_id == binding.room_id && members.contains(&session.binding.peer_id)
        })
        .map(|session| {
            let role = service.runtime.apply_verified(
                Command::Role {
                    room_id: binding.room_id.clone(),
                    room_instance_id: binding.room_instance_id.clone(),
                    peer_id: session.binding.peer_id.clone(),
                    epoch: session.binding.admission_epoch,
                },
                None,
            )?;
            Ok(
                json!({"stamp":session.stamp,"presenter":role.presenter.ok_or("unavailable")?,
            "connected":session.events.is_some(),"name":session.name,"avatar":session.avatar}),
            )
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    let revision = store
        .sessions
        .get(&stamp.session_id)
        .ok_or("stale")?
        .revision;
    let follow = store
        .rooms
        .get(&binding.room_id)
        .and_then(|room| room.follow.clone());
    Ok(json!({"peers":peers,"revision":revision,"count":members.len(),"followMe":follow}))
}

/// Derive credential-free diagnostics enrichment from one exact connected session.
///
/// # Errors
/// Rejects stale, disconnected or replaced session stamps.
pub(super) fn diagnostic_context(
    service: &Service,
    stamp: &SessionStamp,
) -> Result<(String, String), &'static str> {
    let store = service.store.lock().map_err(|_| "unavailable")?;
    let session = store
        .sessions
        .get(&stamp.session_id)
        .filter(|session| session.stamp == *stamp && session.events.is_some())
        .ok_or("stale")?;
    Ok((session.binding.room_id.clone(), session.actor.clone()))
}

/// Remove rights synchronously before attempting owned native cleanup; stale timers cannot remove recovery.
pub(super) async fn leave(service: &Service, stamp: &SessionStamp) {
    let _lifecycle = service.lifecycle.lock().await;
    let removed = {
        let Ok(mut store) = service.store.lock() else {
            tracing::error!("replacement registry poisoned");
            return;
        };
        if !store
            .sessions
            .get(&stamp.session_id)
            .is_some_and(|session| session.stamp == *stamp)
        {
            return;
        }
        file::cancel_session(&mut store, stamp, "left");
        let Some(session) = store.sessions.remove(&stamp.session_id) else {
            return;
        };
        if let Some(room) = store.rooms.get_mut(&session.binding.room_id)
            && room.follow.as_ref().is_some_and(|follow| {
                follow.owner.session_id == session.stamp.session_id
                    || follow
                        .target
                        .as_ref()
                        .is_some_and(|target| target.session_id == session.stamp.session_id)
            })
        {
            room.follow = None;
        }
        let room = store.rooms.get(&session.binding.room_id).cloned();
        (session, room)
    };
    let (session, room) = removed;
    if let Err(category) = service.runtime.apply_verified(
        Command::Leave {
            room_id: session.binding.room_id.clone(),
            room_instance_id: session.binding.room_instance_id.clone(),
            peer_id: session.binding.peer_id.clone(),
            epoch: session.binding.admission_epoch,
        },
        None,
    ) {
        tracing::warn!(category, "replacement logical leave failed closed");
    }
    super::participant::left(service, &session.binding, &session.stamp);
    if let Some(room) = room {
        native::close(service, &room.boot, &session.binding, false).await;
        let last = service
            .store
            .lock()
            .map(|store| {
                !store
                    .sessions
                    .values()
                    .any(|other| other.binding.room_id == session.binding.room_id)
            })
            .unwrap_or(false);
        if last {
            if let Ok(mut store) = service.store.lock() {
                store.rooms.remove(&session.binding.room_id);
            }
            if let Err(category) = service.runtime.apply_verified(
                Command::Abort {
                    room_id: session.binding.room_id.clone(),
                    epoch: room.reservation,
                },
                None,
            ) {
                tracing::warn!(category, "replacement room retirement failed");
            }
            native::close(service, &room.boot, &room.binding, true).await;
        }
    }
}

/// Retire a whole exact room after failed commit, revocation or native restart.
/// Caller holds the lifecycle mutex; rights/sinks disappear before any native await.
pub(super) async fn retire(service: &Service, room: &Room) {
    let removed = {
        let Ok(mut store) = service.store.lock() else {
            tracing::error!("replacement registry poisoned");
            return;
        };
        if !store
            .rooms
            .get(&room.binding.room_id)
            .is_some_and(|current| {
                current.binding.room_instance_id == room.binding.room_instance_id
            })
        {
            return;
        }
        let transfer_owners: Vec<_> = store
            .transfers
            .values()
            .filter(|transfer| transfer.room_instance_id == room.binding.room_instance_id)
            .map(|transfer| transfer.owner.clone())
            .collect();
        for owner in transfer_owners {
            file::cancel_session(&mut store, &owner, "room_retired");
        }
        store.rooms.remove(&room.binding.room_id);
        let ids: Vec<_> = store
            .sessions
            .iter()
            .filter(|(_, session)| session.binding.room_id == room.binding.room_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| store.sessions.remove(&id))
            .collect::<Vec<_>>()
    };
    for session in removed {
        if let Err(category) = service.runtime.apply_verified(
            Command::Leave {
                room_id: session.binding.room_id,
                room_instance_id: session.binding.room_instance_id,
                peer_id: session.binding.peer_id,
                epoch: session.binding.admission_epoch,
            },
            None,
        ) {
            tracing::warn!(category, "retired domain session already unavailable");
        }
    }
    if let Err(category) = service.runtime.apply_verified(
        Command::Abort {
            room_id: room.binding.room_id.clone(),
            epoch: room.reservation,
        },
        None,
    ) {
        tracing::warn!(category, "replacement room retirement unavailable");
    }
    native::close(service, &room.boot, &room.binding, true).await;
}

/// Check the shared unexpired room lease and exact session/native ownership locally.
///
/// # Errors
/// Revocation, expiry, native restart and stale session ownership fail closed.
/// A transient player outage can use only the remaining shared grant lifetime.
pub(super) async fn renew(service: &Service, stamp: &SessionStamp) -> Result<(), &'static str> {
    if !super::available(service) {
        return Err("unavailable");
    }
    let (binding, room) = binding(service, stamp)?;
    if !service
        .runtime
        .room_current(&binding.room_id, &binding.room_instance_id)?
    {
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
    // Recheck readiness and socket ownership after I/O; gaps/recovery cannot inherit completions.
    if !super::available(service) {
        return Err("unavailable");
    }
    self::binding(service, stamp)?;
    service.runtime.apply_verified(
        Command::Inspect {
            room_id: binding.room_id.clone(),
            room_instance_id: binding.room_instance_id.clone(),
            peer_id: binding.peer_id.clone(),
            epoch: binding.admission_epoch,
        },
        None,
    )?;
    // Local commands and delivery never extend player or native lifetimes.
    if !super::available(service) {
        return Err("unavailable");
    }
    self::binding(service, stamp)?;
    Ok(())
}

/// Extend native resources on the socket heartbeat only, under the existing room authority.
///
/// # Errors
/// Expired room/session ownership or native failures cannot extend any resource lifetime.
pub(super) async fn heartbeat(service: &Service, stamp: &SessionStamp) -> Result<(), &'static str> {
    renew(service, stamp).await?;
    let (binding, room) = binding(service, stamp)?;
    native::renew(service, &room.boot, &binding).await?;
    renew(service, stamp).await
}
