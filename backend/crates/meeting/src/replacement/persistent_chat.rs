//! Durable public chat; actor/profile assertions originate only in current admitted sessions.
use super::{Service, chat, session};
use crate::integration::services::{ChatOperation, Submission};
use crate::{media::protocol::Binding, runtime::Command, signaling::SessionStamp};
use serde_json::{Value, json};

/// Captured authority; no registry locks survive network I/O.
pub(super) struct Authority {
    /// Exact admitted allocation binding.
    pub binding: Binding,
    /// Stable verified actor, never a nickname.
    pub actor: String,
    /// Current player revocation generation.
    pub generation: u64,
    /// Current runtime-derived presenter rights.
    pub presenter: bool,
    /// Validated display name.
    pub name: String,
    /// Validated public avatar path.
    pub avatar: String,
}

impl Authority {
    /// Borrow captured claims for the private storage transport.
    pub(super) fn claims(&self) -> crate::integration::ChatClaims<'_> {
        crate::integration::ChatClaims {
            conference: &self.binding.room_id,
            generation: self.generation,
            actor: &self.actor,
            presenter: self.presenter,
        }
    }
}

/// Capture trusted identity after current membership and policy checks.
///
/// # Errors
/// Rejects stale sessions, missing allocations and denied public-chat policy.
pub(super) fn authority(
    service: &Service,
    stamp: &SessionStamp,
    send: bool,
) -> Result<Authority, &'static str> {
    let (binding, _) = session::binding(service, stamp)?;
    if send {
        chat::authorize(service, &binding, true)?;
    }
    chat::members(service, &binding)?;
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
    let store = service.store.lock().map_err(|_| "unavailable")?;
    let session = store
        .sessions
        .get(&stamp.session_id)
        .filter(|s| s.stamp == *stamp && s.events.is_some())
        .ok_or("stale")?;
    let generation = store
        .rooms
        .get(&binding.room_id)
        .ok_or("unavailable")?
        .generation;
    Ok(Authority {
        binding,
        actor: session.actor.clone(),
        generation,
        presenter,
        name: session.name.clone(),
        avatar: session.avatar.clone(),
    })
}

/// Read one retained page through the application backend.
///
/// # Errors
/// Rejects stale authority, invalid cursors and unavailable storage.
pub(super) async fn history(
    service: &Service,
    stamp: &SessionStamp,
    before: Option<String>,
) -> Result<Value, &'static str> {
    let who = authority(service, stamp, false)?;
    let before = before
        .map(|value| value.parse::<i64>().map_err(|_| "invalid"))
        .transpose()?;
    let result = service
        .config
        .player
        .chat(&who.claims(), ChatOperation::History(before))
        .await?;
    authority(service, stamp, false)?;
    Ok(result)
}

/// Persist before acknowledgement/broadcast; retry IDs prevent duplicate rows.
///
/// # Errors
/// Rejects denied policy, invalid records, revoked sessions and unavailable storage.
pub(super) async fn append(
    service: &Service,
    stamp: &SessionStamp,
    id: String,
    text: String,
    attachment: Option<String>,
) -> Result<Value, &'static str> {
    if !service
        .chat_limits
        .allow(&stamp.session_id, std::time::Instant::now())
    {
        return Err("capacity");
    }
    let who = authority(service, stamp, true)?;
    let result = service
        .config
        .player
        .chat(
            &who.claims(),
            ChatOperation::Append(Submission {
                client_id: id,
                name: who.name.clone(),
                avatar: who.avatar.clone(),
                text,
                attachment_id: attachment,
            }),
        )
        .await?;
    broadcast(service, stamp, &who, &result).await?;
    Ok(result)
}

/// Delete globally with sender/presenter ownership checked against SQLite.
///
/// # Errors
/// Rejects stale authority, foreign ownership and unavailable storage.
pub(super) async fn delete(
    service: &Service,
    stamp: &SessionStamp,
    id: String,
) -> Result<Value, &'static str> {
    let who = authority(service, stamp, false)?;
    let id = id.parse::<i64>().map_err(|_| "invalid")?;
    let result = service
        .config
        .player
        .chat(&who.claims(), ChatOperation::Delete(id))
        .await?;
    broadcast(service, stamp, &who, &result).await?;
    Ok(result)
}

/// Deliver committed mutations per recipient, deriving ownership without exposing actor IDs.
///
/// # Errors
/// Rejects retired sender incarnations and event capacity failures.
async fn broadcast(
    service: &Service,
    stamp: &SessionStamp,
    who: &Authority,
    value: &Value,
) -> Result<(), &'static str> {
    authority(service, stamp, false)?;
    let members = chat::members(service, &who.binding)?;
    let recipients = {
        let store = service.store.lock().map_err(|_| "unavailable")?;
        store
            .sessions
            .values()
            .filter(|s| {
                s.stamp != *stamp
                    && s.events.is_some()
                    && s.binding.room_id == who.binding.room_id
                    && s.binding.room_instance_id == who.binding.room_instance_id
                    && members.contains(&s.binding.peer_id)
            })
            .map(|s| s.stamp.clone())
            .collect::<Vec<_>>()
    };
    let mut slow = Vec::new();
    for recipient in recipients {
        let target = authority(service, &recipient, false)?;
        let mut event = value.clone();
        if let Some(message) = event.get_mut("message").filter(|m| m.is_object()) {
            let own = target.actor == who.actor;
            message["own"] = json!(own);
            message["canDelete"] = json!(own || target.presenter);
        }
        slow.extend(chat::deliver(
            service,
            stamp,
            &who.binding,
            &members,
            Some(&recipient),
            "chatMutation",
            event,
        )?);
    }
    chat::retire_slow(service, slow).await;
    Ok(())
}
