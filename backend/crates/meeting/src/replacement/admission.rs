//! Ticket-to-domain-to-native admission on the isolated replacement path.
use super::{
    Service, native,
    session::{Room, Session, digest, owner_purpose},
    wire::Outbound,
};
use crate::{
    media::protocol::{Binding, Empty, Operation},
    runtime::Command,
    signaling::{Hello, SessionStamp},
    tickets::Role,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use uuid::Uuid;

/// Welcome result and the privately owned current connection fence; credentials are never Debug.
pub(super) struct Welcome {
    /// Server-issued public session stamp used by the owning socket loop.
    pub stamp: SessionStamp,
    /// Credential-bearing welcome frame sent only to that socket.
    pub frame: Value,
}

/// Generate an independent recovery capability from two random UUIDv4s (244 entropy bits).
/// It is never reused as the independently generated 256-bit browser ownership proof.
pub(super) fn capability() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// Redeem a ticket, commit current domain admission and allocate exactly owned native resources.
///
/// # Errors
/// Rejects invalid/replayed tickets, busy/expired/revoked authority and native/domain failures.
/// Owned exact bindings are retired before failure returns; the ticket remains consumed.
pub(super) async fn admit(
    service: &Service,
    slug: &str,
    hello: Hello,
    events: mpsc::Sender<Outbound>,
) -> Result<Welcome, &'static str> {
    let Hello::Admit {
        ticket,
        owner_proof,
        ..
    } = hello
    else {
        return Err("invalid");
    };
    let decision = service
        .config
        .redeemer
        .authorize(&service.config.player, slug, ticket)
        .await
        .map_err(|_| "admission denied")?;
    let lifecycle = service.lifecycle.lock().await;
    if !super::available(service) {
        return Err("unavailable");
    }
    let grant = service
        .config
        .player
        .authorize(&decision.claims.conference_id)
        .await
        .map_err(|_| "unavailable")?
        .ok_or("denied")?;
    if grant.generation != decision.claims.generation || grant.room_slug != slug {
        return Err("denied");
    }
    let existing = {
        let store = service.store.lock().map_err(|_| "unavailable")?;
        if store.sessions.len() >= 512 {
            return Err("capacity");
        }
        store.rooms.get(&grant.conference_id).cloned()
    };
    let room = match existing {
        Some(room) => {
            if room.generation != grant.generation
                || room.slug != slug
                || service
                    .config
                    .media
                    .metadata()
                    .await
                    .map_err(|_| "native unavailable")?
                    .boot_id
                    != room.boot
            {
                super::session::retire(service, &room).await;
                return Err("stale");
            }
            if service
                .runtime
                .apply_verified(
                    Command::Renew {
                        room_id: grant.conference_id.clone(),
                        room_instance_id: room.binding.room_instance_id.clone(),
                    },
                    Some(grant.clone()),
                )
                .is_err()
            {
                super::session::retire(service, &room).await;
                return Err("stale");
            }
            room
        }
        None => {
            let reservation = service
                .runtime
                .apply_verified(
                    Command::Reserve {
                        room_id: grant.conference_id.clone(),
                    },
                    Some(grant.clone()),
                )?
                .epoch
                .ok_or("unavailable")?;
            let boot = match service.config.media.metadata().await {
                Ok(metadata) => metadata.boot_id,
                Err(_) => {
                    service.runtime.apply_verified(
                        Command::Abort {
                            room_id: grant.conference_id.clone(),
                            epoch: reservation,
                        },
                        None,
                    )?;
                    return Err("native unavailable");
                }
            };
            let binding = Binding {
                room_id: grant.conference_id.clone(),
                room_instance_id: Uuid::new_v4().to_string(),
                peer_id: "room-owner".into(),
                admission_epoch: reservation,
            };
            let room = Room {
                binding: binding.clone(),
                boot,
                generation: grant.generation,
                reservation,
                slug: slug.into(),
                renewal: super::room_lease::Schedule::new(grant.lease_seconds, reservation),
                follow: None,
                music: None,
            };
            let result = native::execute(
                service,
                &room.boot,
                &binding,
                Operation::CreateRoom(Empty::default()),
            )
            .await;
            if result.is_err() {
                native::close(service, &room.boot, &binding, true).await;
                service.runtime.apply_verified(
                    Command::Abort {
                        room_id: grant.conference_id.clone(),
                        epoch: reservation,
                    },
                    None,
                )?;
                return Err("native unavailable");
            }
            let committed = service.runtime.apply_verified(
                Command::Commit {
                    room_id: grant.conference_id.clone(),
                    epoch: reservation,
                    room_instance_id: binding.room_instance_id.clone(),
                    presenter_names: Vec::new(),
                    moderator: Default::default(),
                    global_lobby: false,
                },
                Some(grant.clone()),
            );
            if committed.is_err() {
                native::close(service, &room.boot, &binding, true).await;
                service.runtime.apply_verified(
                    Command::Abort {
                        room_id: grant.conference_id.clone(),
                        epoch: reservation,
                    },
                    None,
                )?;
                return Err("stale");
            }
            service
                .store
                .lock()
                .map_err(|_| "unavailable")?
                .rooms
                .insert(grant.conference_id.clone(), room.clone());
            room
        }
    };
    let session_id = Uuid::new_v4().to_string();
    let began = service.runtime.apply_verified(
        Command::Begin {
            room_id: grant.conference_id.clone(),
            room_instance_id: room.binding.room_instance_id.clone(),
            peer_id: session_id.clone(),
            presenter: decision.claims.role == Role::Presenter,
            username: decision.claims.actor_id.clone(),
        },
        Some(grant.clone()),
    );
    let began = match began {
        Ok(began) => began,
        Err(category) => {
            let empty = service
                .store
                .lock()
                .map_err(|_| "unavailable")?
                .sessions
                .values()
                .all(|session| session.binding.room_id != room.binding.room_id);
            if empty {
                super::session::retire(service, &room).await;
            }
            return Err(category);
        }
    };
    let binding = Binding {
        room_id: grant.conference_id.clone(),
        room_instance_id: room.binding.room_instance_id.clone(),
        peer_id: session_id.clone(),
        admission_epoch: began.epoch.ok_or("unavailable")?,
    };
    let result = establish(
        service,
        &room,
        &binding,
        &decision.claims.actor_id,
        grant.generation,
        slug,
    )
    .await;
    let result = result.and_then(|(phase, presenter)| {
        if super::available(service) {
            Ok((phase, presenter))
        } else {
            Err("draining")
        }
    });
    let (phase, presenter) = match result {
        Ok(result) => result,
        Err(category) => {
            service.runtime.apply_verified(
                Command::Leave {
                    room_id: binding.room_id.clone(),
                    room_instance_id: binding.room_instance_id.clone(),
                    peer_id: binding.peer_id.clone(),
                    epoch: binding.admission_epoch,
                },
                None,
            )?;
            native::close(service, &room.boot, &binding, false).await;
            let empty = service
                .store
                .lock()
                .map_err(|_| "unavailable")?
                .sessions
                .values()
                .all(|session| session.binding.room_id != binding.room_id);
            if empty {
                service
                    .store
                    .lock()
                    .map_err(|_| "unavailable")?
                    .rooms
                    .remove(&binding.room_id);
                service.runtime.apply_verified(
                    Command::Abort {
                        room_id: binding.room_id.clone(),
                        epoch: room.reservation,
                    },
                    None,
                )?;
                native::close(service, &room.boot, &room.binding, true).await;
            }
            return Err(category);
        }
    };
    let stamp = SessionStamp {
        room_instance_id: room.binding.room_instance_id.clone(),
        session_id,
        admission_epoch: 1,
    };
    let recovery = capability();
    let owner_purpose = owner_purpose(&decision.claims.actor_id);
    service
        .store
        .lock()
        .map_err(|_| "unavailable")?
        .sessions
        .insert(
            stamp.session_id.clone(),
            Session {
                stamp: stamp.clone(),
                binding,
                owner: digest(owner_purpose.as_bytes(), &owner_proof),
                recovery: digest(b"replacement-recovery-v1", &recovery),
                name: decision.claims.actor_id.clone(),
                actor: decision.claims.actor_id,
                avatar: String::new(),
                events: Some(events),
                grace: None,
                revision: 0,
            },
        );
    if phase == "admitted"
        && let Err(category) = super::participant::joined(service, &stamp).await
    {
        // `session::leave` takes the lifecycle lock itself; holding it here would deadlock.
        drop(lifecycle);
        super::session::leave(service, &stamp).await;
        return Err(category);
    }
    if phase == "lobby" {
        super::moderation::announce_lobby(service, &stamp)?;
    }
    Ok(Welcome {
        frame: json!({"type":"welcome","version":1,"stamp":stamp,"recoveryToken":recovery,"revision":0,"phase":phase,"presenter":presenter}),
        stamp,
    })
}

/// Allocate an owned peer and revalidate entitlement before granting domain gate rights;
/// returns the gate phase and the role the gate granted.
///
/// # Errors
/// Native failure, generation/slug revocation or domain gates deny admission; caller owns cleanup.
async fn establish(
    service: &Service,
    room: &Room,
    binding: &Binding,
    actor: &str,
    generation: u64,
    slug: &str,
) -> Result<(&'static str, bool), &'static str> {
    native::execute(
        service,
        &room.boot,
        binding,
        Operation::CreatePeer(Empty::default()),
    )
    .await?;
    let grant = service
        .config
        .player
        .authorize(&binding.room_id)
        .await
        .map_err(|_| "unavailable")?
        .ok_or("denied")?;
    if grant.generation != generation || grant.room_slug != slug {
        return Err("denied");
    }
    service.runtime.apply_verified(
        Command::Renew {
            room_id: binding.room_id.clone(),
            room_instance_id: binding.room_instance_id.clone(),
        },
        Some(grant),
    )?;
    // The gate may grant the presenter role (first joiner or takeover), so the welcome
    // reports the gate's role rather than the one from Begin.
    let gated = service.runtime.apply_verified(
        Command::Gate {
            room_id: binding.room_id.clone(),
            room_instance_id: binding.room_instance_id.clone(),
            peer_id: binding.peer_id.clone(),
            epoch: binding.admission_epoch,
            uuid: actor.into(),
        },
        None,
    )?;
    Ok((
        gated.phase.ok_or("unavailable")?,
        gated.presenter.unwrap_or(false),
    ))
}
