//! Typed participant profile, count and Follow Me notifications.
use super::{Service, session};
use crate::{
    media::protocol::{Binding, JS_SAFE_INTEGER},
    runtime::Command,
    signaling::SessionStamp,
};
use serde::Deserialize;
use serde_json::{Value, json};

/// Retained display-name JavaScript UTF-16 limit.
const NAME_LIMIT: usize = 32;

/// Explicit participant profile fields; server-owned role/resource fields are absent.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum ProfileChange {
    /// Change the participant display name.
    Name {
        /// Non-empty bounded display name.
        value: String,
    },
    /// Change the participant avatar to one replacement-owned public upload.
    Avatar {
        /// Same-origin public avatar path returned by the Rust upload endpoint, or empty
        /// to reset to the default avatar.
        value: String,
    },
}

/// Presenter-owned room view policy.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum FollowAction {
    /// Enable or disable Follow Me.
    Toggle {
        /// Requested Follow Me state.
        enabled: bool,
    },
    /// Pin one exact current participant.
    Pin {
        /// Exact Rust-issued target session.
        target: SessionStamp,
    },
    /// Focus one exact current participant.
    Focus {
        /// Exact Rust-issued target session.
        target: SessionStamp,
    },
    /// Clear pin/focus while leaving Follow Me enabled.
    Clear,
}

/// Notify existing admitted peers about one newly admitted participant.
///
/// # Errors
/// Rejects stale sessions, unavailable role authority or recipient capacity.
pub(super) async fn joined(service: &Service, sender: &SessionStamp) -> Result<(), &'static str> {
    let (binding, _) = session::binding(service, sender)?;
    let members = members(service, &binding)?;
    let presenter = service
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
        .ok_or("unavailable")?;
    let value = {
        let mut store = service.store.lock().map_err(|_| "unavailable")?;
        let participant = exact(&mut store, sender, &binding, &members)?;
        json!({"participant":sender,"name":participant.name,"avatar":participant.avatar,
            "presenter":presenter,"count":members.len()})
    };
    let slow = broadcast(
        service,
        sender,
        &binding,
        &members,
        "participantJoined",
        value,
        false,
    )?;
    retire(service, slow).await;
    Ok(())
}

/// Publish the server-owned music source to every connected room participant.
pub(super) fn music_started(service: &Service, room_id: &str, producer_id: &str, volume: f64) {
    system_event(
        service,
        room_id,
        "producerCreated",
        json!({"producerId":producer_id,"participant":{"roomInstanceId":"system","sessionId":"bodrik-music","admissionEpoch":1},
            "name":"Бодрик FM","avatar":"/images/bodrik-ava.png","kind":"audio","mediaType":"audioType",
            "system":"music","volume":volume}),
    );
}

/// Remove the server-owned music source from every connected room participant.
pub(super) fn music_stopped(service: &Service, room_id: &str, producer_id: &str) {
    system_event(
        service,
        room_id,
        "producerClosed",
        json!({"resourceId":producer_id}),
    );
}

/// Publish a validated meeting-wide music gain without restarting RTP.
pub(super) fn music_volume(service: &Service, room_id: &str, volume: f64) {
    system_event(service, room_id, "musicVolume", json!({"volume":volume}));
}

/// Deliver one server-owned event with per-recipient revisions and bounded sinks.
fn system_event(service: &Service, room_id: &str, kind: &'static str, value: Value) {
    let Ok(mut store) = service.store.lock() else {
        return;
    };
    for session in store
        .sessions
        .values_mut()
        .filter(|session| session.events.is_some() && session.binding.room_id == room_id)
    {
        let Some(revision) = session
            .revision
            .checked_add(1)
            .filter(|value| *value <= JS_SAFE_INTEGER)
        else {
            session.events = None;
            continue;
        };
        session.revision = revision;
        let frame = json!({"type":"event","version":1,"stamp":session.stamp,
            "revision":revision,"kind":kind,"value":value});
        if session
            .events
            .as_ref()
            .is_some_and(|events| events.try_send(frame.into()).is_err())
        {
            session.events = None;
        }
    }
}

/// Broadcast one removed participant after logical authority has been revoked.
pub(super) fn left(service: &Service, binding: &Binding, stamp: &SessionStamp) {
    let Ok(mut store) = service.store.lock() else {
        tracing::error!("replacement registry poisoned during departure notification");
        return;
    };
    let count = store
        .sessions
        .values()
        .filter(|participant| {
            participant.events.is_some()
                && participant.binding.room_id == binding.room_id
                && participant.binding.room_instance_id == binding.room_instance_id
        })
        .count();
    for recipient in store.sessions.values_mut().filter(|participant| {
        participant.events.is_some()
            && participant.binding.room_id == binding.room_id
            && participant.binding.room_instance_id == binding.room_instance_id
    }) {
        let Some(revision) = recipient
            .revision
            .checked_add(1)
            .filter(|value| *value <= JS_SAFE_INTEGER)
        else {
            tracing::warn!("replacement departure revision exhausted");
            continue;
        };
        recipient.revision = revision;
        let frame = json!({"type":"event","version":1,"stamp":recipient.stamp,
            "revision":revision,"kind":"participantLeft",
            "value":{"participant":stamp,"count":count}});
        if recipient
            .events
            .as_ref()
            .is_some_and(|events| events.try_send(frame.into()).is_err())
        {
            tracing::warn!("replacement departure recipient backpressure");
        }
    }
}

/// Update one allowlisted profile field and notify admitted room members.
///
/// # Errors
/// Rejects stale sessions, invalid UTF-16/path bounds or recipient capacity.
pub(super) async fn profile(
    service: &Service,
    sender: &SessionStamp,
    change: ProfileChange,
) -> Result<Value, &'static str> {
    let (binding, _) = session::binding(service, sender)?;
    let members = members(service, &binding)?;
    let (field, value) = match change {
        ProfileChange::Name { value } => {
            if value.trim().is_empty() || value.encode_utf16().count() > NAME_LIMIT {
                return Err("invalid");
            }
            ("name", value.trim().to_owned())
        }
        ProfileChange::Avatar { value } => {
            // An empty value resets to the default (initials) avatar.
            if !value.is_empty() && !avatar(&value) {
                return Err("invalid");
            }
            ("avatar", value)
        }
    };
    {
        let mut store = service.store.lock().map_err(|_| "unavailable")?;
        let participant = exact(&mut store, sender, &binding, &members)?;
        match field {
            "name" => participant.name = value.clone(),
            "avatar" => participant.avatar = value.clone(),
            _ => return Err("invalid"),
        }
    }
    let slow = broadcast(
        service,
        sender,
        &binding,
        &members,
        "participantProfile",
        json!({"participant":sender,"field":field,"value":value}),
        true,
    )?;
    retire(service, slow).await;
    Ok(json!({}))
}

/// Return the authoritative admitted human count and optionally notify other members.
///
/// # Errors
/// Rejects stale/non-admitted actors or recipient capacity.
pub(super) async fn count(
    service: &Service,
    sender: &SessionStamp,
    broadcast_count: bool,
) -> Result<Value, &'static str> {
    let (binding, _) = session::binding(service, sender)?;
    let members = members(service, &binding)?;
    let count = members.len();
    if broadcast_count {
        let slow = broadcast(
            service,
            sender,
            &binding,
            &members,
            "participantCount",
            json!({"count":count}),
            true,
        )?;
        retire(service, slow).await;
    }
    Ok(json!({"count":count}))
}

/// Mutate presenter-owned Follow Me state and notify non-sender admitted members.
///
/// # Errors
/// Rejects nonpresenters, stale targets and recipient capacity.
pub(super) async fn follow(
    service: &Service,
    sender: &SessionStamp,
    action: FollowAction,
) -> Result<Value, &'static str> {
    let (binding, _) = session::binding(service, sender)?;
    presenter(service, &binding)?;
    let members = members(service, &binding)?;
    let (value, state) = match action {
        FollowAction::Toggle { enabled } => (
            json!({"action":"toggle","enabled":enabled}),
            enabled.then_some(session::Follow {
                owner: sender.clone(),
                enabled: true,
                action: None,
                target: None,
            }),
        ),
        FollowAction::Pin { target } => {
            target_current(service, &target, &binding, &members)?;
            (
                json!({"action":"pin","target":target}),
                Some(session::Follow {
                    owner: sender.clone(),
                    enabled: true,
                    action: Some("pin".into()),
                    target: Some(target),
                }),
            )
        }
        FollowAction::Focus { target } => {
            target_current(service, &target, &binding, &members)?;
            (
                json!({"action":"focus","target":target}),
                Some(session::Follow {
                    owner: sender.clone(),
                    enabled: true,
                    action: Some("focus".into()),
                    target: Some(target),
                }),
            )
        }
        FollowAction::Clear => (
            json!({"action":"clear"}),
            Some(session::Follow {
                owner: sender.clone(),
                enabled: true,
                action: None,
                target: None,
            }),
        ),
    };
    {
        let mut store = service.store.lock().map_err(|_| "unavailable")?;
        exact(&mut store, sender, &binding, &members)?;
        let room = store.rooms.get_mut(&binding.room_id).ok_or("stale")?;
        if room.binding.room_instance_id != binding.room_instance_id {
            return Err("stale");
        }
        room.follow = state;
    }
    let slow = broadcast(
        service, sender, &binding, &members, "followMe", value, false,
    )?;
    retire(service, slow).await;
    Ok(json!({}))
}

/// Derive admitted humans from the sole runtime authority; native music is not a member.
pub(super) fn members(service: &Service, binding: &Binding) -> Result<Vec<String>, &'static str> {
    service
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
        .ok_or("denied")
}

/// Require current presenter authority.
fn presenter(service: &Service, binding: &Binding) -> Result<(), &'static str> {
    if service
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
        == Some(true)
    {
        Ok(())
    } else {
        Err("denied")
    }
}

/// Resolve one exact mutable current participant.
pub(super) fn exact<'a>(
    store: &'a mut session::Store,
    stamp: &SessionStamp,
    binding: &Binding,
    members: &[String],
) -> Result<&'a mut session::Session, &'static str> {
    store
        .sessions
        .get_mut(&stamp.session_id)
        .filter(|participant| {
            participant.stamp == *stamp
                && participant.events.is_some()
                && participant.binding == *binding
                && members.contains(&participant.binding.peer_id)
        })
        .ok_or("stale")
}

/// Verify an exact current Follow Me target.
fn target_current(
    service: &Service,
    target: &SessionStamp,
    binding: &Binding,
    members: &[String],
) -> Result<(), &'static str> {
    let store = service.store.lock().map_err(|_| "unavailable")?;
    if store
        .sessions
        .get(&target.session_id)
        .is_some_and(|participant| {
            participant.stamp == *target
                && participant.events.is_some()
                && participant.binding.room_id == binding.room_id
                && participant.binding.room_instance_id == binding.room_instance_id
                && members.contains(&participant.binding.peer_id)
        })
    {
        Ok(())
    } else {
        Err("denied")
    }
}

/// Broadcast one revisioned participant event from server-derived identity.
pub(super) fn broadcast(
    service: &Service,
    sender: &SessionStamp,
    binding: &Binding,
    members: &[String],
    kind: &str,
    value: Value,
    include_sender: bool,
) -> Result<Vec<SessionStamp>, &'static str> {
    let mut store = service.store.lock().map_err(|_| "unavailable")?;
    exact(&mut store, sender, binding, members)?;
    let mut slow = Vec::new();
    for recipient in store.sessions.values_mut().filter(|participant| {
        (include_sender || participant.stamp != *sender)
            && participant.events.is_some()
            && participant.binding.room_id == binding.room_id
            && participant.binding.room_instance_id == binding.room_instance_id
            && members.contains(&participant.binding.peer_id)
    }) {
        recipient.revision = recipient
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= JS_SAFE_INTEGER)
            .ok_or("capacity")?;
        let frame = json!({"type":"event","version":1,"stamp":recipient.stamp,
            "revision":recipient.revision,"kind":kind,"value":value});
        if recipient
            .events
            .as_ref()
            .ok_or("stale")?
            .try_send(frame.into())
            .is_err()
        {
            slow.push(recipient.stamp.clone());
        }
    }
    Ok(slow)
}

/// Retire exact slow recipients after releasing the registry lock.
pub(super) async fn retire(service: &Service, slow: Vec<SessionStamp>) {
    for stamp in slow {
        session::leave(service, &stamp).await;
    }
}

/// Accept only the Rust avatar endpoint's retained public namespace and UUID names.
fn avatar(value: &str) -> bool {
    let Some(name) = value.strip_prefix("/uploads/avatars/") else {
        return false;
    };
    let Some((id, extension)) = name.rsplit_once('.') else {
        return false;
    };
    matches!(extension, "png" | "jpg" | "webp") && uuid::Uuid::parse_str(id).is_ok()
}

/// Participant field boundary fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Avatar paths are same-origin, namespace-bound UUID image names only.
    #[test]
    fn avatar_path_cases() {
        let id = uuid::Uuid::new_v4();
        assert!(avatar(&format!("/uploads/avatars/{id}.webp")));
        assert!(!avatar("https://example.test/uploads/avatars/a.webp"));
        assert!(!avatar("/uploads/chat/a.webp"));
        assert!(!avatar("/uploads/avatars/../secret.webp"));
    }
}
