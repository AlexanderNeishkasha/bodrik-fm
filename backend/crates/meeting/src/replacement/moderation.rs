//! Typed replacement room policy, role, lobby and participant moderation commands.

use super::{Service, session, wire::Outbound};
use crate::{
    media::protocol::Binding,
    room::ModeratorChange,
    runtime::{Command, ControlAction},
    signaling::SessionStamp,
};
use serde::Deserialize;
use serde_json::{Value, json};

/// Public room-gate mutations with private password material confined to the command.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum RoomAction {
    /// Enable the password gate.
    Lock {
        /// Non-empty bounded password retained only by Runtime.
        password: String,
    },
    /// Disable the password gate.
    Unlock,
    /// Enable or disable lobby admission.
    Lobby {
        /// Requested lobby state.
        status: bool,
    },
    /// Enable or disable the nonpresenter join lock.
    JoinLock {
        /// Requested join-lock state.
        status: bool,
    },
    /// Submit a password for this exact pending session.
    Password {
        /// Candidate password, never returned or broadcast.
        password: String,
    },
    /// Read the live ban list (presenters only).
    Bans,
    /// Lift one live ban (presenters only).
    Unban {
        /// Opaque identifier from the ban list.
        id: uuid::Uuid,
    },
}

/// Presenter-issued participant action; identity and recipient scope are exact stamps.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum PeerAction {
    /// Ban and remove a participant.
    Ban,
    /// Remove a participant without retaining a ban.
    Eject,
    /// Request microphone disable.
    Mute,
    /// Request microphone enable with recipient consent.
    Unmute,
    /// Request camera disable.
    Hide,
    /// Request camera enable with recipient consent.
    Unhide,
    /// Request screen-share stop.
    Stop,
    /// Request screen-share start with recipient consent.
    Start,
}

impl PeerAction {
    /// Stable retained event action label.
    fn wire(self) -> &'static str {
        match self {
            Self::Ban => "ban",
            Self::Eject => "eject",
            Self::Mute => "mute",
            Self::Unmute => "unmute",
            Self::Hide => "hide",
            Self::Unhide => "unhide",
            Self::Stop => "stop",
            Self::Start => "start",
        }
    }
}

/// Apply one room gate command and broadcast only its safe public projection.
///
/// # Errors
/// Rejects stale/nonpresenter actors, invalid passwords and denied pending admission.
pub(super) fn room_action(
    service: &Service,
    sender: &SessionStamp,
    action: RoomAction,
) -> Result<Value, &'static str> {
    let (binding, _) = session::binding(service, sender)?;
    let (runtime, event) = match action {
        RoomAction::Lock { password } => {
            (ControlAction::Lock { password }, json!({"action":"lock"}))
        }
        RoomAction::Unlock => (ControlAction::Unlock, json!({"action":"unlock"})),
        RoomAction::Lobby { status } => (
            ControlAction::Lobby { status },
            json!({"action":if status {"lobbyOn"} else {"lobbyOff"}}),
        ),
        RoomAction::JoinLock { status } => (
            ControlAction::JoinLock { status },
            json!({"action":if status {"joinLockOn"} else {"joinLockOff"}}),
        ),
        RoomAction::Bans => {
            return bans(service, &binding, ControlAction::Bans).map(|(_, list)| list);
        }
        RoomAction::Unban { id } => {
            let (accepted, list) = bans(service, &binding, ControlAction::Unban { id })?;
            return if accepted { Ok(list) } else { Err("stale") };
        }
        RoomAction::Password { password } => {
            let accepted = control(service, &binding, ControlAction::Password { password })?;
            return if accepted {
                Ok(json!({"accepted":true}))
            } else {
                Err("denied")
            };
        }
    };
    if !control(service, &binding, runtime)? {
        return Err("invalid");
    }
    broadcast(service, &binding, "roomAction", event, true)?;
    policy(service, &binding)
}

/// Update one or all moderator fields and notify every admitted participant.
///
/// # Errors
/// Rejects stale/nonpresenter actors and recipient backpressure.
pub(super) fn moderator(
    service: &Service,
    sender: &SessionStamp,
    change: ModeratorChange,
) -> Result<Value, &'static str> {
    let (binding, _) = session::binding(service, sender)?;
    let moderator = service
        .runtime
        .apply_verified(
            Command::Moderator {
                room_id: binding.room_id.clone(),
                room_instance_id: binding.room_instance_id.clone(),
                peer_id: binding.peer_id.clone(),
                epoch: binding.admission_epoch,
                change: Some(change),
            },
            None,
        )?
        .moderator
        .ok_or("unavailable")?;
    broadcast(
        service,
        &binding,
        "moderator",
        serde_json::to_value(&moderator).map_err(|_| "unavailable")?,
        true,
    )?;
    Ok(json!({"moderator":moderator}))
}

/// Transfer presenter authority to one exact current participant.
///
/// # Errors
/// Rejects stale actors/targets, pinned presenters and recipient backpressure.
pub(super) fn role(
    service: &Service,
    sender: &SessionStamp,
    target: &SessionStamp,
    presenter: bool,
) -> Result<Value, &'static str> {
    let (binding, _) = session::binding(service, sender)?;
    let target_binding = target_binding(service, target, &binding)?;
    service.runtime.apply_verified(
        Command::SetRole {
            room_id: binding.room_id.clone(),
            room_instance_id: binding.room_instance_id.clone(),
            peer_id: binding.peer_id.clone(),
            epoch: binding.admission_epoch,
            target_id: target_binding.peer_id,
            target_epoch: target_binding.admission_epoch,
            presenter,
        },
        None,
    )?;
    let value = json!({"participant":target,"presenter":presenter,"from":sender});
    broadcast(service, &binding, "presenter", value, true)?;
    Ok(json!({"presenter":presenter}))
}

/// Approve or reject exact current lobby sessions.
///
/// # Errors
/// Rejects stale/nonpresenter actors, nonwaiting targets and recipient backpressure.
pub(super) async fn lobby(
    service: &Service,
    sender: &SessionStamp,
    targets: Vec<SessionStamp>,
    accepted: bool,
) -> Result<Value, &'static str> {
    if targets.is_empty() || targets.len() > 512 {
        return Err("invalid");
    }
    let (binding, _) = session::binding(service, sender)?;
    let mut selected = Vec::with_capacity(targets.len());
    for target in &targets {
        let target_binding = target_binding(service, target, &binding)?;
        if accepted {
            service.runtime.apply_verified(
                Command::Approve {
                    room_id: binding.room_id.clone(),
                    room_instance_id: binding.room_instance_id.clone(),
                    peer_id: binding.peer_id.clone(),
                    epoch: binding.admission_epoch,
                    target_id: target_binding.peer_id.clone(),
                    target_epoch: target_binding.admission_epoch,
                },
                None,
            )?;
        }
        selected.push(target.clone());
    }
    for target in &selected {
        let value = if accepted {
            json!({"peer_id":&target.session_id,"peers_id":[&target.session_id],
                "lobby_status":"accept","snapshot":session::snapshot(service, target)?})
        } else {
            json!({"peer_id":&target.session_id,"peers_id":[&target.session_id],
                "lobby_status":"reject"})
        };
        targeted(
            service,
            std::slice::from_ref(target),
            "roomLobby",
            value,
            false,
        )?;
    }
    if !accepted {
        for target in &selected {
            session::leave(service, target).await;
        }
    }
    broadcast_except(
        service,
        &binding,
        "roomLobby",
        json!({"peers_id":selected.iter().map(|stamp| &stamp.session_id).collect::<Vec<_>>(),
            "lobby_status":if accepted {"accept"} else {"reject"}}),
        &selected,
    )?;
    Ok(json!({"count":selected.len()}))
}

/// Notify other admitted participants that the actor has no camera producer.
///
/// # Errors
/// Rejects stale actors or recipient backpressure.
pub(super) fn video_off(service: &Service, sender: &SessionStamp) -> Result<Value, &'static str> {
    let (binding, _) = session::binding(service, sender)?;
    let store = service.store.lock().map_err(|_| "unavailable")?;
    let participant = store.sessions.get(&sender.session_id).ok_or("stale")?;
    let value = json!({"participant":sender,"name":participant.name,"avatar":participant.avatar});
    drop(store);
    broadcast(service, &binding, "videoOff", value, false)?;
    Ok(json!({}))
}

/// Relay or enforce one presenter-owned participant action.
///
/// # Errors
/// Rejects stale/nonpresenter actors, stale targets, invalid messages and recipient backpressure.
pub(super) async fn peer_action(
    service: &Service,
    sender: &SessionStamp,
    targets: Vec<SessionStamp>,
    action: PeerAction,
    message: Option<String>,
) -> Result<Value, &'static str> {
    if targets.is_empty() || targets.len() > 512 {
        return Err("invalid");
    }
    let (binding, _) = session::binding(service, sender)?;
    presenter(service, &binding)?;
    let message = message.unwrap_or_default();
    if message.encode_utf16().count() > 400 {
        return Err("invalid");
    }
    for target in &targets {
        let target_binding = target_binding(service, target, &binding)?;
        if matches!(action, PeerAction::Ban) {
            let (actor, name) = {
                let store = service.store.lock().map_err(|_| "unavailable")?;
                let session = store.sessions.get(&target.session_id).ok_or("stale")?;
                (session.actor.clone(), session.name.clone())
            };
            if !control(service, &binding, ControlAction::Ban { uuid: actor, name })? {
                return Err("invalid");
            }
        }
        let _ = target_binding;
    }
    let ending = matches!(action, PeerAction::Ban | PeerAction::Eject);
    targeted(
        service,
        &targets,
        "peerAction",
        json!({"action":action.wire(),"message":message,"from":sender}),
        ending,
    )?;
    if ending {
        for target in &targets {
            session::leave(service, target).await;
        }
    }
    Ok(json!({"count":targets.len()}))
}

/// Close earlier sessions of the same actor after a takeover: each gets a final
/// `sessionReplaced` event, then leaves without a presenter fallback race (the new
/// session already holds any inherited role).
pub(super) async fn replace_sessions(service: &Service, current: &SessionStamp) {
    let replaced: Vec<SessionStamp> = {
        let Ok(store) = service.store.lock() else {
            return;
        };
        let Some(session) = store.sessions.get(&current.session_id) else {
            return;
        };
        store
            .sessions
            .values()
            .filter(|other| {
                other.stamp != *current
                    && other.actor == session.actor
                    && other.binding.room_id == session.binding.room_id
            })
            .map(|other| other.stamp.clone())
            .collect()
    };
    for stamp in replaced {
        // A full outbound queue only loses the notice; the session still ends.
        let _ = targeted(
            service,
            std::slice::from_ref(&stamp),
            "sessionReplaced",
            json!({}),
            true,
        );
        session::leave(service, &stamp).await;
    }
}

/// Notify current room members that one exact participant is waiting in the lobby.
///
/// # Errors
/// Rejects stale sessions or recipient backpressure.
pub(super) fn announce_lobby(service: &Service, target: &SessionStamp) -> Result<(), &'static str> {
    let store = service.store.lock().map_err(|_| "unavailable")?;
    let waiting = store.sessions.get(&target.session_id).ok_or("stale")?;
    let binding = waiting.binding.clone();
    let value = json!({"peer_id":target.session_id,"peer_name":waiting.name,
        "peer_avatar":waiting.avatar,"lobby_status":"waiting","stamp":target});
    drop(store);
    broadcast(service, &binding, "roomLobby", value, false)
}

/// Read current public policy after an authorized operation.
fn policy(service: &Service, binding: &Binding) -> Result<Value, &'static str> {
    let value = service
        .runtime
        .apply_verified(
            Command::Control {
                room_id: binding.room_id.clone(),
                room_instance_id: binding.room_instance_id.clone(),
                peer_id: binding.peer_id.clone(),
                epoch: binding.admission_epoch,
                action: ControlAction::Read,
            },
            None,
        )?
        .policy
        .ok_or("unavailable")?;
    serde_json::to_value(value).map_err(|_| "unavailable")
}

/// Run one ban-list control and return its acceptance plus the presenter-only `{bans}` list.
///
/// # Errors
/// Rejects stale/nonpresenter actors; a missing list is reported as unavailable.
fn bans(
    service: &Service,
    binding: &Binding,
    action: ControlAction,
) -> Result<(bool, Value), &'static str> {
    let reply = service.runtime.apply_verified(
        Command::Control {
            room_id: binding.room_id.clone(),
            room_instance_id: binding.room_instance_id.clone(),
            peer_id: binding.peer_id.clone(),
            epoch: binding.admission_epoch,
            action,
        },
        None,
    )?;
    let accepted = reply.accepted.ok_or("unavailable")?;
    let list = reply.bans.ok_or("unavailable")?;
    Ok((accepted, json!({ "bans": list })))
}

/// Execute one typed room control under current Runtime authority.
fn control(
    service: &Service,
    binding: &Binding,
    action: ControlAction,
) -> Result<bool, &'static str> {
    service
        .runtime
        .apply_verified(
            Command::Control {
                room_id: binding.room_id.clone(),
                room_instance_id: binding.room_instance_id.clone(),
                peer_id: binding.peer_id.clone(),
                epoch: binding.admission_epoch,
                action,
            },
            None,
        )?
        .accepted
        .ok_or("unavailable")
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

/// Resolve one exact current same-room target binding.
fn target_binding(
    service: &Service,
    target: &SessionStamp,
    actor: &Binding,
) -> Result<Binding, &'static str> {
    service
        .store
        .lock()
        .map_err(|_| "unavailable")?
        .sessions
        .get(&target.session_id)
        .filter(|session| {
            session.stamp == *target
                && session.binding.room_id == actor.room_id
                && session.binding.room_instance_id == actor.room_instance_id
        })
        .map(|session| session.binding.clone())
        .ok_or("stale")
}

/// Send one revisioned event to selected exact sessions.
fn targeted(
    service: &Service,
    targets: &[SessionStamp],
    kind: &str,
    value: Value,
    ending: bool,
) -> Result<(), &'static str> {
    let mut store = service.store.lock().map_err(|_| "unavailable")?;
    for target in targets {
        let recipient = store.sessions.get_mut(&target.session_id).ok_or("stale")?;
        if recipient.stamp != *target {
            return Err("stale");
        }
        send(recipient, kind, value.clone(), ending)?;
    }
    Ok(())
}

/// Broadcast one revisioned event to connected exact room sessions.
fn broadcast(
    service: &Service,
    binding: &Binding,
    kind: &str,
    value: Value,
    include_sender: bool,
) -> Result<(), &'static str> {
    let mut store = service.store.lock().map_err(|_| "unavailable")?;
    for recipient in store.sessions.values_mut().filter(|session| {
        session.binding.room_id == binding.room_id
            && session.binding.room_instance_id == binding.room_instance_id
            && (include_sender || session.binding.peer_id != binding.peer_id)
    }) {
        send(recipient, kind, value.clone(), false)?;
    }
    Ok(())
}

/// Broadcast one revisioned event while excluding exact target sessions.
fn broadcast_except(
    service: &Service,
    binding: &Binding,
    kind: &str,
    value: Value,
    excluded: &[SessionStamp],
) -> Result<(), &'static str> {
    let mut store = service.store.lock().map_err(|_| "unavailable")?;
    for recipient in store.sessions.values_mut().filter(|session| {
        session.binding.room_id == binding.room_id
            && session.binding.room_instance_id == binding.room_instance_id
            && !excluded.contains(&session.stamp)
    }) {
        send(recipient, kind, value.clone(), false)?;
    }
    Ok(())
}

/// Queue one bounded revisioned event without dropping older observations.
fn send(
    recipient: &mut session::Session,
    kind: &str,
    value: Value,
    ending: bool,
) -> Result<(), &'static str> {
    let Some(events) = &recipient.events else {
        return Ok(());
    };
    recipient.revision = recipient.revision.checked_add(1).ok_or("capacity")?;
    let frame = json!({"type":"event","version":1,"stamp":recipient.stamp,
        "revision":recipient.revision,"kind":kind,"value":value});
    events
        .try_send(if ending {
            Outbound::Final(frame)
        } else {
            frame.into()
        })
        .map_err(|_| "capacity")
}
