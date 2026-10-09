//! Typed ephemeral chat and reaction relay using current Rust membership authority.
use super::{Service, session};
use crate::{
    media::protocol::{Binding, JS_SAFE_INTEGER},
    runtime::{Capability, Command},
    signaling::SessionStamp,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

/// Retained JavaScript UTF-16 message-body limit.
const MESSAGE_LIMIT: usize = 4000;
/// Retained JavaScript UTF-16 message identifier limit.
const ID_LIMIT: usize = 160;
/// Retained JavaScript UTF-16 reaction glyph limit.
const EMOJI_LIMIT: usize = 16;
/// Retained shared chat/reaction events per sliding window.
const RATE_LIMIT: usize = 60;
/// Retained shared chat/reaction sliding window.
const RATE_WINDOW: Duration = Duration::from_secs(10);
/// Maximum active session counters, matching the public socket ceiling.
const RATE_CAPACITY: usize = 512;

/// Shared bounded per-session chat/reaction rates.
pub(super) struct Limits {
    /// Sliding accepted-event windows keyed by Rust-issued session identity.
    entries: Mutex<HashMap<String, VecDeque<Instant>>>,
}

/// Public or exact-session private chat destination.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Target {
    /// All other admitted connected members of the exact room.
    Public,
    /// One exact current admitted session.
    Private {
        /// Rust-issued target stamp; stale recovery incarnations cannot receive.
        stamp: SessionStamp,
    },
}

/// Retained reaction mutation vocabulary.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ReactionAction {
    /// Add the sender's reaction.
    Add,
    /// Remove the sender's reaction.
    Remove,
}

impl ReactionAction {
    /// Stable lower-camel wire value.
    fn wire(&self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Remove => "remove",
        }
    }
}

impl Limits {
    /// Create empty bounded chat rate state.
    pub(super) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Consume one shared chat/reaction allowance using retained sliding-window semantics.
    pub(super) fn allow(&self, session_id: &str, now: Instant) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        entries.retain(|_, times| {
            while times
                .front()
                .is_some_and(|time| now.duration_since(*time) >= RATE_WINDOW)
            {
                times.pop_front();
            }
            !times.is_empty()
        });
        if !entries.contains_key(session_id) && entries.len() >= RATE_CAPACITY {
            return false;
        }
        let times = entries.entry(session_id.to_owned()).or_default();
        if times.len() >= RATE_LIMIT {
            return false;
        }
        times.push_back(now);
        true
    }
}

/// Authorize and relay one public/private ephemeral text event.
///
/// # Errors
/// Rejects malformed UTF-16 bounds, stale targets, denied policy, flood or recipient capacity.
pub(super) async fn message(
    service: &Service,
    sender: &SessionStamp,
    target: Target,
    message_id: String,
    text: String,
) -> Result<Value, &'static str> {
    bounded(&message_id, ID_LIMIT)?;
    bounded(&text, MESSAGE_LIMIT)?;
    if !service
        .chat_limits
        .allow(&sender.session_id, Instant::now())
    {
        return Err("capacity");
    }
    let (binding, _) = session::binding(service, sender)?;
    let public = matches!(target, Target::Public);
    authorize(service, &binding, public)?;
    let members = members(service, &binding)?;
    let target_stamp = match target {
        Target::Public => None,
        Target::Private { stamp } => Some(stamp),
    };
    let value = json!({
        "sender":sender,
        "target":target_stamp,
        "messageId":message_id,
        "text":text
    });
    let slow = deliver(
        service,
        sender,
        &binding,
        &members,
        target_stamp.as_ref(),
        "chatMessage",
        value,
    )?;
    retire_slow(service, slow).await;
    Ok(json!({}))
}

/// Authorize and relay one ephemeral reaction to all other admitted room members.
///
/// # Errors
/// Rejects malformed UTF-16 bounds, stale membership, flood or recipient capacity.
pub(super) async fn reaction(
    service: &Service,
    sender: &SessionStamp,
    message_id: String,
    emoji: String,
    action: ReactionAction,
) -> Result<Value, &'static str> {
    bounded(&message_id, ID_LIMIT)?;
    bounded(&emoji, EMOJI_LIMIT)?;
    if !service
        .chat_limits
        .allow(&sender.session_id, Instant::now())
    {
        return Err("capacity");
    }
    let (binding, _) = session::binding(service, sender)?;
    let members = members(service, &binding)?;
    let value = json!({
        "sender":sender,
        "messageId":message_id,
        "emoji":emoji,
        "action":action.wire()
    });
    let slow = deliver(
        service,
        sender,
        &binding,
        &members,
        None,
        "chatReaction",
        value,
    )?;
    retire_slow(service, slow).await;
    Ok(json!({}))
}

/// Apply the shared moderator policy for text and file attachments before delivery.
///
/// # Errors
/// Rejects stale membership and public/private chat denied by the room moderator.
pub(super) fn authorize(
    service: &Service,
    binding: &Binding,
    public: bool,
) -> Result<(), &'static str> {
    let capability = if public {
        Capability::PublicChat
    } else {
        Capability::PrivateChat
    };
    if service
        .runtime
        .apply_verified(
            Command::Authorize {
                room_id: binding.room_id.clone(),
                room_instance_id: binding.room_instance_id.clone(),
                peer_id: binding.peer_id.clone(),
                epoch: binding.admission_epoch,
                capability,
            },
            None,
        )?
        .allowed
        != Some(true)
    {
        return Err("denied");
    }
    Ok(())
}

/// Require non-empty trimmed text within the exact JavaScript UTF-16 budget.
fn bounded(value: &str, maximum: usize) -> Result<(), &'static str> {
    if value.trim().is_empty() || value.encode_utf16().count() > maximum {
        Err("invalid")
    } else {
        Ok(())
    }
}

/// Derive admitted room recipients from the sole runtime authority.
pub(super) fn members(
    service: &Service,
    binding: &crate::media::protocol::Binding,
) -> Result<Vec<String>, &'static str> {
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

/// Deliver one revisioned event only to current connected exact-room recipients.
pub(super) fn deliver(
    service: &Service,
    sender: &SessionStamp,
    binding: &Binding,
    members: &[String],
    target: Option<&SessionStamp>,
    kind: &str,
    value: Value,
) -> Result<Vec<SessionStamp>, &'static str> {
    let mut store = service.store.lock().map_err(|_| "unavailable")?;
    let sender_current = store
        .sessions
        .get(&sender.session_id)
        .is_some_and(|session| {
            session.stamp == *sender
                && session.events.is_some()
                && session.binding.room_id == binding.room_id
                && session.binding.room_instance_id == binding.room_instance_id
                && members.contains(&session.binding.peer_id)
        });
    if !sender_current {
        return Err("stale");
    }
    if let Some(target) = target
        && !store
            .sessions
            .get(&target.session_id)
            .is_some_and(|session| {
                session.stamp == *target
                    && session.events.is_some()
                    && session.binding.room_id == binding.room_id
                    && session.binding.room_instance_id == binding.room_instance_id
                    && members.contains(&session.binding.peer_id)
            })
    {
        return Err("denied");
    }
    let mut slow = Vec::new();
    for recipient in store.sessions.values_mut().filter(|session| {
        session.stamp != *sender
            && session.events.is_some()
            && session.binding.room_id == binding.room_id
            && session.binding.room_instance_id == binding.room_instance_id
            && members.contains(&session.binding.peer_id)
            && target.is_none_or(|target| session.stamp == *target)
    }) {
        recipient.revision = recipient
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= JS_SAFE_INTEGER)
            .ok_or("capacity")?;
        let frame = json!({
            "type":"event","version":1,"stamp":recipient.stamp,
            "revision":recipient.revision,"kind":kind,"value":value
        });
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

/// Retire only exact slow recipient sessions after releasing the registry lock.
pub(super) async fn retire_slow(service: &Service, slow: Vec<SessionStamp>) {
    for stamp in slow {
        session::leave(service, &stamp).await;
    }
}

/// UTF-16 and shared sliding-window regression fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// JavaScript astral characters consume two UTF-16 code units at exact boundaries.
    #[test]
    fn utf16_boundaries() {
        assert!(bounded(&"😀".repeat(2000), MESSAGE_LIMIT).is_ok());
        assert!(bounded(&"😀".repeat(2001), MESSAGE_LIMIT).is_err());
        assert!(bounded("  ", MESSAGE_LIMIT).is_err());
    }

    /// Messages and reactions share exactly sixty accepted events per sliding ten seconds.
    #[test]
    fn shared_rate_boundaries() {
        let limits = Limits::new();
        let now = Instant::now();
        for _ in 0..RATE_LIMIT {
            assert!(limits.allow("session", now));
        }
        assert!(!limits.allow("session", now));
        assert!(limits.allow("other", now));
        assert!(limits.allow("session", now + RATE_WINDOW));
    }
}
