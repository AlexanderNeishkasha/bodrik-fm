//! Native source lifecycle notifications: creation, inventory projection and mute state.
use super::{
    Service,
    participant::{broadcast, exact, members, retire},
    session,
};
use crate::{
    media::protocol::{Binding, MediaKind, MediaType},
    signaling::SessionStamp,
};
use serde_json::{Value, json};

/// Notify admitted peers about one newly published native source.
///
/// # Errors
/// Rejects stale actors, malformed native results or recipient capacity.
pub(super) async fn producer_created(
    service: &Service,
    sender: &SessionStamp,
    result: &Value,
    kind: MediaKind,
    media_type: MediaType,
) -> Result<(), &'static str> {
    let producer_id = result
        .get("producerId")
        .and_then(Value::as_str)
        .filter(|value| crate::media::protocol::identifier(value))
        .ok_or("unknown_outcome")?;
    let (binding, _) = session::binding(service, sender)?;
    let members = members(service, &binding)?;
    let value = {
        let mut store = service.store.lock().map_err(|_| "unavailable")?;
        let participant = exact(&mut store, sender, &binding, &members)?;
        json!({"producerId":producer_id,"participant":sender,"name":participant.name,
            "avatar":participant.avatar,"kind":kind,"mediaType":media_type})
    };
    let slow = broadcast(
        service,
        sender,
        &binding,
        &members,
        "producerCreated",
        value,
        false,
    )?;
    retire(service, slow).await;
    Ok(())
}

/// Relay one successful owner-initiated producer pause/resume to the other exact-room members.
///
/// Native ownership (`owned` in the worker) already guarantees `producer_id` belongs to `sender`;
/// callers invoke this only after a clean native result, so no unverified state is published.
///
/// # Errors
/// Rejects malformed producer identifiers, stale actors or recipient capacity.
pub(super) async fn paused_changed(
    service: &Service,
    sender: &SessionStamp,
    producer_id: &str,
    paused: bool,
) -> Result<(), &'static str> {
    if !crate::media::protocol::identifier(producer_id) {
        return Err("invalid");
    }
    let (binding, _) = session::binding(service, sender)?;
    let members = members(service, &binding)?;
    let value = json!({"producerId":producer_id,"participant":sender,"paused":paused});
    let slow = broadcast(
        service,
        sender,
        &binding,
        &members,
        "producerState",
        value,
        false,
    )?;
    retire(service, slow).await;
    Ok(())
}

/// Project native producer handles through exact current participant ownership.
///
/// Stale native handles are omitted individually so one retired producer cannot hide the
/// remaining live room inventory from a late joiner.
///
/// # Errors
/// Rejects malformed native source data or unavailable membership authority.
pub(super) fn producers(
    service: &Service,
    sender: &SessionStamp,
    native: Value,
) -> Result<Value, &'static str> {
    let (binding, _) = session::binding(service, sender)?;
    let members = members(service, &binding)?;
    let sources = native
        .get("sources")
        .and_then(Value::as_array)
        .ok_or("unknown_outcome")?;
    let store = service.store.lock().map_err(|_| "unavailable")?;
    let mut result = Vec::with_capacity(sources.len());
    for source in sources {
        let id = source
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| crate::media::protocol::identifier(value))
            .ok_or("unknown_outcome")?;
        let kind = source
            .get("kind")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "audio" | "video"))
            .ok_or("unknown_outcome")?;
        let media_type = source
            .get("mediaType")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "audioType" | "videoType" | "screenType"))
            .ok_or("unknown_outcome")?;
        if source.get("system").and_then(Value::as_str) == Some("music") {
            let Some(music) = store
                .rooms
                .get(&binding.room_id)
                .and_then(|room| room.music.as_ref())
                .filter(|music| music.producer_id == id)
            else {
                continue;
            };
            result.push(json!({"producerId":id,"participant":{"roomInstanceId":binding.room_instance_id,
                "sessionId":"bodrik-music","admissionEpoch":1},"name":"Бодрик FM","avatar":"/images/bodrik-ava.png",
                "kind":kind,"mediaType":media_type,"system":"music","volume":music.volume}));
            continue;
        }
        let owner: Binding =
            serde_json::from_value(source.get("binding").cloned().ok_or("unknown_outcome")?)
                .map_err(|_| "unknown_outcome")?;
        let Some(participant) = store.sessions.values().find(|participant| {
            participant.binding == owner
                && participant.events.is_some()
                && members.contains(&participant.binding.peer_id)
        }) else {
            continue;
        };
        if participant.stamp != *sender {
            // Absent means active, matching producer creation; non-boolean values are rejected.
            let paused = match source.get("paused") {
                None => false,
                Some(value) => value.as_bool().ok_or("unknown_outcome")?,
            };
            result.push(
                json!({"producerId":id,"participant":participant.stamp,"name":participant.name,
                "avatar":participant.avatar,"kind":kind,"mediaType":media_type,"paused":paused}),
            );
        }
    }
    Ok(json!(result))
}
