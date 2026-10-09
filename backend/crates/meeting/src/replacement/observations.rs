//! Fail-closed native lifecycle observations and secret-free bounded public delivery.
use super::{Service, available, session};
use crate::{
    media::{Event, protocol::Binding},
    native_media::NativeEventStream as EventStream,
    runtime::Command,
    signaling::SessionStamp,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tokio::sync::watch;

/// Strict lifecycle payload; native handles never become browser-selected authority.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Closed {
    /// Exact native room/peer/epoch owner of the disappearing handle.
    binding: Binding,
    /// Resource identifier, scoped by its authenticated owner.
    resource_id: String,
}

/// Normalized bounded volume from the exact live native audio producer owner.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AudioVolume {
    /// Exact native owner; Rust resolves its current public stamp.
    binding: Binding,
    /// Provider-independent audible level from two through ten.
    level: u8,
}

/// Exact live native audio producer owner selected as dominant speaker.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DominantSpeaker {
    /// Exact native owner; Rust resolves its current public stamp.
    binding: Binding,
}

/// Retire all current rooms after a missing event, native death or explicit drain.
/// Lifecycle serialization prevents replacing a room while its exact owner is retired.
pub(super) async fn retire_all(service: &Service) {
    let _lifecycle = service.lifecycle.lock().await;
    let rooms = match service.store.lock() {
        Ok(store) => store.rooms.values().cloned().collect::<Vec<_>>(),
        Err(_) => {
            tracing::error!("replacement registry poisoned during drain");
            return;
        }
    };
    for room in rooms {
        session::retire(service, &room).await;
    }
}

/// Own one stream, retire rather than trust missed history, and reconnect with bounded backoff.
pub(super) async fn supervise(
    service: Service,
    mut stream: EventStream,
    mut stop: watch::Receiver<bool>,
) {
    let mut cleanup = tokio::time::interval(Duration::from_millis(250));
    cleanup.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let result = tokio::select! {
            _ = cleanup.tick() => {
                match expired(&service, Instant::now()) {
                    Ok(stamps) => { for stamp in stamps { session::leave(&service, &stamp).await; } continue; },
                    Err(category) => Err(category),
                }
            },
            _ = stop.changed() => return,
            event = stream.next_event() => match event {
                Ok(event) => deliver(&service, event),
                Err(_) => Err("native observation continuity lost"),
            },
        };
        let result = match result {
            Ok(slow) => {
                for stamp in slow {
                    session::leave(&service, &stamp).await;
                }
                Ok(())
            }
            Err(category) => Err(category),
        };
        if let Err(category) = result {
            service.observing.store(false, Ordering::Release);
            tracing::warn!(category, "replacement native observations failed closed");
            drop(stream);
            retire_all(&service).await;
            let mut delay = Duration::from_millis(200);
            stream = loop {
                tokio::select! { _ = stop.changed() => return, _ = tokio::time::sleep(delay) => {} }
                let attempt = async {
                    let boot = service.config.media.metadata().await.ok()?.boot_id;
                    let mut stream = service.config.media.events(&boot).await.ok()?;
                    stream.next_event().await.ok()?;
                    Some(stream)
                };
                if let Some(next) =
                    tokio::select! { _ = stop.changed() => return, result = attempt => result }
                {
                    break next;
                }
                delay = (delay * 2).min(Duration::from_secs(5));
            };
            if service.draining.load(Ordering::Acquire) {
                return;
            }
            service.observing.store(true, Ordering::Release);
        }
    }
}

/// Derive expired disconnected stamps; recovery clears grace and rotates ownership before cleanup.
///
/// # Errors
/// Registry poisoning prevents reliable cleanup selection and requests fail-closed retirement.
fn expired(service: &Service, now: Instant) -> Result<Vec<SessionStamp>, &'static str> {
    let store = service
        .store
        .lock()
        .map_err(|_| "grace registry unavailable")?;
    Ok(store
        .sessions
        .values()
        .filter(|session| {
            session.events.is_none() && session.grace.is_some_and(|deadline| now >= deadline)
        })
        .map(|session| session.stamp.clone())
        .collect())
}

/// Normalize known close observations, deriving current admitted recipients from Runtime.
///
/// # Errors
/// Invalid payload, worker death or registry failure requires room retirement.
/// Slow recipients are returned for exact-session cleanup, never global eviction.
fn deliver(service: &Service, event: Event) -> Result<Vec<SessionStamp>, &'static str> {
    if !available(service) {
        return Err("draining");
    }
    match event.kind.as_str() {
        "workerDied" => return Err("native worker died"),
        "audioVolume" => {
            let volume: AudioVolume = serde_json::from_value(event.payload.clone())
                .map_err(|_| "invalid native volume payload")?;
            if !(2..=10).contains(&volume.level) {
                return Err("invalid native volume level");
            }
            return deliver_speaker(service, &event, volume.binding, Some(volume.level));
        }
        "dominantSpeaker" => {
            let speaker: DominantSpeaker = serde_json::from_value(event.payload.clone())
                .map_err(|_| "invalid native speaker payload")?;
            return deliver_speaker(service, &event, speaker.binding, None);
        }
        "transportClosed" | "producerClosed" | "consumerClosed" => {}
        _ => return Err("unsupported native observation"),
    }
    let closed: Closed =
        serde_json::from_value(event.payload).map_err(|_| "invalid native close payload")?;
    if !closed.binding.is_valid() || !crate::media::protocol::identifier(&closed.resource_id) {
        return Err("invalid native close binding");
    }
    let mut store = service.store.lock().map_err(|_| "registry unavailable")?;
    let Some(room) = store.rooms.get(&closed.binding.room_id) else {
        return Ok(Vec::new());
    };
    if room.boot != event.boot_id
        || room.binding.room_instance_id != closed.binding.room_instance_id
    {
        return Ok(Vec::new());
    }
    let Some(owner) = store
        .sessions
        .values()
        .find(|session| session.binding == closed.binding)
    else {
        return Ok(Vec::new());
    };
    let owner_stamp = owner.stamp.clone();
    let Some(members) = recipients(service, &closed.binding)? else {
        return Ok(Vec::new());
    };
    let mut slow = Vec::new();
    for recipient in store.sessions.values_mut().filter(|session| {
        session.binding.room_id == closed.binding.room_id
            && session.binding.room_instance_id == closed.binding.room_instance_id
            && members.contains(&session.binding.peer_id)
            && (event.kind == "producerClosed" || session.binding == closed.binding)
    }) {
        let Some(sink) = recipient.events.as_ref() else {
            continue;
        };
        recipient.revision = recipient
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= crate::media::protocol::JS_SAFE_INTEGER)
            .ok_or("revision exhausted")?;
        let frame = json!({"type":"event","version":1,"stamp":recipient.stamp,"revision":recipient.revision,
            "kind":event.kind,"value":{"resourceId":closed.resource_id,"owner":owner_stamp}});
        if sink.try_send(frame.into()).is_err() {
            slow.push(recipient.stamp.clone());
        }
    }
    Ok(slow)
}

/// Resolve a native speaker owner to admitted connected recipients and public-only data.
///
/// # Errors
/// Invalid/stale authority is ignored; registry/runtime/revision failures fail closed.
fn deliver_speaker(
    service: &Service,
    event: &Event,
    binding: Binding,
    level: Option<u8>,
) -> Result<Vec<SessionStamp>, &'static str> {
    if !binding.is_valid() {
        return Err("invalid native speaker binding");
    }
    let mut store = service.store.lock().map_err(|_| "registry unavailable")?;
    let Some(room) = store.rooms.get(&binding.room_id) else {
        return Ok(Vec::new());
    };
    if room.boot != event.boot_id || room.binding.room_instance_id != binding.room_instance_id {
        return Ok(Vec::new());
    }
    let Some(owner) = store
        .sessions
        .values()
        .find(|session| session.binding == binding)
    else {
        return Ok(Vec::new());
    };
    let owner_stamp = owner.stamp.clone();
    let Some(members) = recipients(service, &binding)? else {
        return Ok(Vec::new());
    };
    let mut slow = Vec::new();
    for recipient in store.sessions.values_mut().filter(|session| {
        session.binding.room_id == binding.room_id
            && session.binding.room_instance_id == binding.room_instance_id
            && members.contains(&session.binding.peer_id)
    }) {
        let Some(sink) = recipient.events.as_ref() else {
            continue;
        };
        recipient.revision = recipient
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= crate::media::protocol::JS_SAFE_INTEGER)
            .ok_or("revision exhausted")?;
        let value = level.map_or_else(
            || json!({"owner":owner_stamp.clone()}),
            |level| json!({"owner":owner_stamp.clone(),"level":level}),
        );
        let frame = json!({"type":"event","version":1,"stamp":recipient.stamp,
            "revision":recipient.revision,"kind":event.kind,"value":value});
        if sink.try_send(frame.into()).is_err() {
            slow.push(recipient.stamp.clone());
        }
    }
    Ok(slow)
}

/// Ignore events belonging to definitively retired rooms; preserve global failure handling.
///
/// # Errors
/// Registry poisoning and unexpected failures for a current room still fail closed globally.
fn recipients(service: &Service, binding: &Binding) -> Result<Option<Vec<String>>, &'static str> {
    if !service
        .runtime
        .room_current(&binding.room_id, &binding.room_instance_id)?
    {
        return Ok(None);
    }
    let result = service.runtime.apply_verified(
        Command::Members {
            room_id: binding.room_id.clone(),
            room_instance_id: binding.room_instance_id.clone(),
            peer_id: binding.peer_id.clone(),
            epoch: binding.admission_epoch,
            pending: false,
        },
        None,
    );
    match result {
        Ok(reply) => reply
            .members
            .map(Some)
            .ok_or("native recipients unavailable"),
        Err(_)
            if !service
                .runtime
                .room_current(&binding.room_id, &binding.room_instance_id)? =>
        {
            Ok(None)
        }
        Err(category) => Err(category),
    }
}

/// Delivery authority, schema and slow-recipient failure tables.
#[cfg(test)]
pub(crate) mod tests;
