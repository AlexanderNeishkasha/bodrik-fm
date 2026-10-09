//! Rust-owned bounded file-transfer allocation, relay, integrity and cleanup.
use super::{Service, chat::Target, session, wire::Outbound};
use crate::{media::protocol::JS_SAFE_INTEGER, runtime::Command, signaling::SessionStamp};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use uuid::Uuid;

/// File protocol version independent from the outer WebSocket command version.
pub(super) const VERSION: u8 = 1;
/// Retained browser chunk payload size.
pub(super) const CHUNK_BYTES: usize = 16 * 1024;
/// Maximum one transfer size agreed for bounded replacement relay.
pub(super) const TRANSFER_BYTES: u64 = 100 * 1024 * 1024;
/// Maximum concurrent sender-owned transfers.
pub(super) const SESSION_OUTGOING: usize = 2;
/// Maximum concurrent transfers delivered to one recipient.
pub(super) const SESSION_INCOMING: usize = 4;
/// Maximum concurrent transfers in one room.
pub(super) const ROOM_TRANSFERS: usize = 8;
/// Maximum queued binary chunks per recipient before that recipient fails slow.
pub(super) const RECIPIENT_CHUNKS: usize = 4;
/// Transfer idle deadline.
pub(super) const IDLE: Duration = Duration::from_secs(30);
/// Absolute transfer deadline.
pub(super) const LIFETIME: Duration = Duration::from_secs(5 * 60);
/// Fixed binary frame header bytes.
pub(super) const HEADER_BYTES: usize = 27;
/// Fixed binary protocol magic.
const MAGIC: &[u8; 3] = b"BF1";

const _: () = assert!(RECIPIENT_CHUNKS * CHUNK_BYTES <= 64 * 1024);
const _: () = assert!(SESSION_OUTGOING <= ROOM_TRANSFERS);
const _: () = assert!(SESSION_INCOMING <= ROOM_TRANSFERS);
const _: () = assert!(IDLE.as_secs() < LIFETIME.as_secs());

/// Strict transfer offer submitted before any binary bytes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Offer {
    /// Exact file contract version.
    pub version: u8,
    /// Public room or exact private recipient stamp.
    pub target: Target,
    /// Display filename; no path semantics.
    pub file_name: String,
    /// Bounded declared MIME label, treated as display metadata only.
    pub media_type: String,
    /// Exact positive byte length.
    pub size: u64,
    /// Lowercase SHA-256 of the complete file.
    pub sha256: String,
}

/// Sender- or recipient-scoped transfer cancellation.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Cancel {
    /// Exact file contract version.
    pub version: u8,
    /// Rust-issued canonical transfer UUID.
    pub transfer_id: String,
}

/// One decoded binary chunk borrowing its WebSocket frame.
pub(super) struct Chunk<'a> {
    /// Rust-issued transfer UUID.
    pub transfer_id: Uuid,
    /// Exact zero-based sequence.
    pub sequence: u32,
    /// Sender-declared final chunk flag.
    pub final_chunk: bool,
    /// One non-empty bounded payload.
    pub payload: &'a [u8],
}

/// One current recipient delivery projection.
pub(super) struct Recipient {
    /// Exact connected recipient incarnation.
    stamp: SessionStamp,
    /// Binary frames queued but not yet selected by its socket loop.
    queued: usize,
}

/// One authoritative in-memory transfer state machine.
pub(super) struct Transfer {
    /// Exact sender socket incarnation.
    pub(super) owner: SessionStamp,
    /// Private room identifier used only for authority comparison.
    pub(super) room_id: String,
    /// Exact room incarnation.
    pub(super) room_instance_id: String,
    /// Display filename.
    file_name: String,
    /// Display-only MIME label.
    media_type: String,
    /// Declared complete byte length.
    size: u64,
    /// Expected lowercase complete-file digest.
    sha256: String,
    /// Next exact sequence number.
    sequence: u32,
    /// Bytes accepted so far.
    received: u64,
    /// Incremental complete-file digest.
    digest: Sha256,
    /// Allocation time for the absolute deadline.
    started: Instant,
    /// Last accepted owner activity for the idle deadline.
    active: Instant,
    /// Current independently bounded recipients.
    recipients: HashMap<String, Recipient>,
}

impl Offer {
    /// Validate metadata before allocating transfer ownership.
    ///
    /// # Errors
    /// Rejects unsupported versions, paths/control characters, unsafe sizes/MIME or hashes.
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if self.version != VERSION
            || self.size == 0
            || self.size > TRANSFER_BYTES
            || self.size > JS_SAFE_INTEGER
            || self.file_name.trim().is_empty()
            || self.file_name.encode_utf16().count() > 255
            || self.file_name.chars().any(|character| {
                character.is_control() || matches!(character, '/' | '\\' | ':' | '\0')
            })
            || self.media_type.encode_utf16().count() > 128
            || self.media_type.chars().any(char::is_control)
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid");
        }
        Ok(())
    }
}

impl Cancel {
    /// Parse one canonical cancellation transfer identifier.
    ///
    /// # Errors
    /// Rejects unsupported versions and noncanonical UUIDs.
    pub(super) fn validate(&self) -> Result<Uuid, &'static str> {
        if self.version != VERSION {
            return Err("invalid");
        }
        let id = Uuid::parse_str(&self.transfer_id).map_err(|_| "invalid")?;
        if id.to_string() != self.transfer_id {
            return Err("invalid");
        }
        Ok(id)
    }
}

impl<'a> Chunk<'a> {
    /// Decode one final binary frame without allocating its payload.
    ///
    /// # Errors
    /// Rejects malformed magic/version/flags/length and empty/oversized payloads.
    pub(super) fn decode(frame: &'a [u8]) -> Result<Self, &'static str> {
        if frame.len() < HEADER_BYTES || &frame[..3] != MAGIC || frame[3] != VERSION {
            return Err("invalid");
        }
        let transfer_id = Uuid::from_slice(&frame[4..20]).map_err(|_| "invalid")?;
        let sequence = u32::from_be_bytes(frame[20..24].try_into().map_err(|_| "invalid")?);
        let flags = frame[24];
        if flags & !1 != 0 {
            return Err("invalid");
        }
        let length = u16::from_be_bytes(frame[25..27].try_into().map_err(|_| "invalid")?) as usize;
        if length == 0 || length > CHUNK_BYTES || frame.len() != HEADER_BYTES + length {
            return Err("invalid");
        }
        Ok(Self {
            transfer_id,
            sequence,
            final_chunk: flags == 1,
            payload: &frame[HEADER_BYTES..],
        })
    }
}

/// Allocate one transfer and enqueue metadata before binary delivery.
///
/// # Errors
/// Rejects stale authority, targets, metadata, quotas or recipient queue capacity.
pub(super) fn offer(
    service: &Service,
    sender: &SessionStamp,
    offer: Offer,
) -> Result<Value, &'static str> {
    offer.validate()?;
    let (binding, _) = session::binding(service, sender)?;
    let public = matches!(offer.target, Target::Public);
    super::chat::authorize(service, &binding, public)?;
    let members = members(service, &binding)?;
    let now = Instant::now();
    let mut store = service.store.lock().map_err(|_| "unavailable")?;
    exact_sender(
        &store,
        sender,
        &binding.room_id,
        &binding.room_instance_id,
        &members,
    )?;
    let recipients = recipients(
        &store,
        sender,
        &binding.room_id,
        &binding.room_instance_id,
        &members,
        &offer.target,
    )?;
    if recipients.is_empty()
        || store
            .transfers
            .values()
            .filter(|transfer| transfer.owner == *sender)
            .count()
            >= SESSION_OUTGOING
        || store
            .transfers
            .values()
            .filter(|transfer| {
                transfer.room_id == binding.room_id
                    && transfer.room_instance_id == binding.room_instance_id
            })
            .count()
            >= ROOM_TRANSFERS
        || recipients.iter().any(|stamp| {
            store
                .transfers
                .values()
                .filter(|transfer| {
                    transfer
                        .recipients
                        .values()
                        .any(|recipient| recipient.stamp == *stamp)
                })
                .count()
                >= SESSION_INCOMING
        })
    {
        return Err("capacity");
    }
    for stamp in &recipients {
        let participant = store.sessions.get(&stamp.session_id).ok_or("stale")?;
        if participant.events.as_ref().ok_or("stale")?.capacity() == 0 {
            return Err("capacity");
        }
    }
    let id = Uuid::new_v4();
    let sender_public = sender.clone();
    let metadata = json!({"transferId":id.to_string(),"sender":sender_public,"fileName":offer.file_name,
        "mediaType":offer.media_type,"size":offer.size,"sha256":offer.sha256,"chunkBytes":CHUNK_BYTES,"target":{"type":if public { "public" } else { "private" }}});
    let mut delivery = HashMap::new();
    for stamp in recipients {
        enqueue_json(&mut store, &stamp, "fileOffer", metadata.clone())?;
        delivery.insert(stamp.session_id.clone(), Recipient { stamp, queued: 0 });
    }
    store.transfers.insert(
        id,
        Transfer {
            owner: sender.clone(),
            room_id: binding.room_id,
            room_instance_id: binding.room_instance_id,
            file_name: offer.file_name,
            media_type: offer.media_type,
            size: offer.size,
            sha256: offer.sha256,
            sequence: 0,
            received: 0,
            digest: Sha256::new(),
            started: now,
            active: now,
            recipients: delivery,
        },
    );
    Ok(json!({"transferId":id.to_string(),"chunkBytes":CHUNK_BYTES}))
}

/// Apply sender-wide or recipient-local cancellation.
///
/// # Errors
/// Rejects stale actors, unknown transfers and foreign cancellation scope.
pub(super) fn cancel(
    service: &Service,
    actor: &SessionStamp,
    cancel: Cancel,
) -> Result<Value, &'static str> {
    let id = cancel.validate()?;
    let mut store = service.store.lock().map_err(|_| "unavailable")?;
    let transfer = store.transfers.get(&id).ok_or("stale")?;
    if transfer.owner == *actor {
        finish(&mut store, id, "cancelled", false);
        return Ok(json!({}));
    }
    let is_recipient = transfer
        .recipients
        .values()
        .any(|recipient| recipient.stamp == *actor);
    if !is_recipient {
        return Err("denied");
    }
    if let Some(transfer) = store.transfers.get_mut(&id) {
        transfer.recipients.remove(&actor.session_id);
    }
    enqueue_owner(
        &mut store,
        id,
        "fileRecipientFailed",
        json!({"transferId":id.to_string(),"recipient":actor,"reason":"cancelled"}),
    );
    if store
        .transfers
        .get(&id)
        .is_some_and(|transfer| transfer.recipients.is_empty())
    {
        finish(&mut store, id, "no_recipients", false);
    }
    Ok(json!({}))
}

/// Accept and relay one exact owner binary frame.
///
/// # Errors
/// Rejects malformed, stale/foreign, out-of-order, oversized or inconsistent final frames.
pub(super) fn binary(
    service: &Service,
    sender: &SessionStamp,
    frame: Vec<u8>,
) -> Result<(), &'static str> {
    let chunk = Chunk::decode(&frame)?;
    let now = Instant::now();
    let mut store = service.store.lock().map_err(|_| "unavailable")?;
    let Some(transfer) = store.transfers.get(&chunk.transfer_id) else {
        return Err("stale");
    };
    if transfer.owner != *sender {
        return Err("denied");
    }
    if expired(transfer, now) {
        finish(&mut store, chunk.transfer_id, "expired", false);
        return Err("expired");
    }
    let payload_len = u64::try_from(chunk.payload.len()).map_err(|_| "invalid")?;
    let next_size = transfer
        .received
        .checked_add(payload_len)
        .ok_or("capacity")?;
    if chunk.sequence != transfer.sequence
        || next_size > transfer.size
        || chunk.final_chunk != (next_size == transfer.size)
    {
        finish(&mut store, chunk.transfer_id, "invalid", false);
        return Err("invalid");
    }
    let recipient_ids: Vec<_> = transfer.recipients.keys().cloned().collect();
    let mut failed = Vec::new();
    for session_id in recipient_ids {
        let recipient = store
            .transfers
            .get(&chunk.transfer_id)
            .and_then(|current| current.recipients.get(&session_id))
            .map(|recipient| (recipient.stamp.clone(), recipient.queued));
        let Some((stamp, queued)) = recipient else {
            continue;
        };
        let send = store
            .sessions
            .get(&session_id)
            .and_then(|session| session.events.as_ref())
            .filter(|_| queued < RECIPIENT_CHUNKS)
            .cloned();
        let Some(send) = send else {
            failed.push(stamp);
            continue;
        };
        let outbound = Outbound::Binary {
            transfer_id: chunk.transfer_id,
            recipient: stamp.clone(),
            bytes: frame.clone(),
        };
        if send.try_send(outbound).is_err() {
            failed.push(stamp);
        } else if let Some(recipient) = store
            .transfers
            .get_mut(&chunk.transfer_id)
            .and_then(|current| current.recipients.get_mut(&session_id))
        {
            recipient.queued += 1;
        }
    }
    for stamp in failed {
        if let Some(transfer) = store.transfers.get_mut(&chunk.transfer_id) {
            transfer.recipients.remove(&stamp.session_id);
        }
        enqueue_owner(
            &mut store,
            chunk.transfer_id,
            "fileRecipientFailed",
            json!({"transferId":chunk.transfer_id.to_string(),"recipient":stamp,"reason":"slow"}),
        );
    }
    let Some(transfer) = store.transfers.get_mut(&chunk.transfer_id) else {
        return Err("stale");
    };
    transfer.digest.update(chunk.payload);
    transfer.received = next_size;
    transfer.sequence = transfer.sequence.checked_add(1).ok_or("capacity")?;
    transfer.active = now;
    if transfer.recipients.is_empty() {
        finish(&mut store, chunk.transfer_id, "no_recipients", false);
        return Err("capacity");
    }
    if chunk.final_chunk {
        let actual = format!("{:x}", transfer.digest.clone().finalize());
        if actual != transfer.sha256 {
            finish(&mut store, chunk.transfer_id, "integrity", false);
            return Err("invalid");
        }
        finish(&mut store, chunk.transfer_id, "complete", true);
    }
    Ok(())
}

/// Release one recipient queue slot after its socket selects a binary frame.
pub(super) fn released(service: &Service, id: Uuid, recipient: &SessionStamp) {
    if let Ok(mut store) = service.store.lock()
        && let Some(delivery) = store
            .transfers
            .get_mut(&id)
            .and_then(|transfer| transfer.recipients.get_mut(&recipient.session_id))
        && delivery.stamp == *recipient
    {
        delivery.queued = delivery.queued.saturating_sub(1);
    }
}

/// Cancel a session's transfers through the shared registry.
pub(super) fn cancel_connected(service: &Service, stamp: &SessionStamp, reason: &str) {
    if let Ok(mut store) = service.store.lock() {
        cancel_session(&mut store, stamp, reason);
    }
}

/// Cancel every transfer owned by or targeting one exact session.
pub(super) fn cancel_session(store: &mut session::Store, stamp: &SessionStamp, reason: &str) {
    let ids: Vec<_> = store
        .transfers
        .iter()
        .filter_map(|(id, transfer)| {
            (transfer.owner == *stamp
                || transfer
                    .recipients
                    .values()
                    .any(|recipient| recipient.stamp == *stamp))
            .then_some(*id)
        })
        .collect();
    for id in ids {
        if store
            .transfers
            .get(&id)
            .is_some_and(|transfer| transfer.owner == *stamp)
        {
            finish(store, id, reason, false);
        } else {
            if let Some(transfer) = store.transfers.get_mut(&id) {
                transfer.recipients.remove(&stamp.session_id);
            }
            enqueue_owner(
                store,
                id,
                "fileRecipientFailed",
                json!({"transferId":id.to_string(),"recipient":stamp,"reason":reason}),
            );
            if store
                .transfers
                .get(&id)
                .is_some_and(|transfer| transfer.recipients.is_empty())
            {
                finish(store, id, "no_recipients", false);
            }
        }
    }
}

/// Expire idle or absolute-deadline transfers.
pub(super) fn expire(service: &Service, now: Instant) {
    let Ok(mut store) = service.store.lock() else {
        return;
    };
    let ids: Vec<_> = store
        .transfers
        .iter()
        .filter_map(|(id, transfer)| expired(transfer, now).then_some(*id))
        .collect();
    for id in ids {
        finish(&mut store, id, "expired", false);
    }
}

/// Run bounded deadline cleanup until application shutdown.
pub(super) async fn supervise(service: Service, mut stop: tokio::sync::watch::Receiver<bool>) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = tick.tick() => expire(&service, Instant::now()),
            changed = stop.changed() => if changed.is_err() || *stop.borrow() { return; },
        }
    }
}

/// Determine whether either transfer deadline elapsed.
fn expired(transfer: &Transfer, now: Instant) -> bool {
    now.duration_since(transfer.active) >= IDLE || now.duration_since(transfer.started) >= LIFETIME
}

/// Derive admitted humans from Runtime.
fn members(
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

/// Verify exact sender authority while the registry is locked.
fn exact_sender(
    store: &session::Store,
    sender: &SessionStamp,
    room_id: &str,
    instance: &str,
    members: &[String],
) -> Result<(), &'static str> {
    store
        .sessions
        .get(&sender.session_id)
        .filter(|session| {
            session.stamp == *sender
                && session.events.is_some()
                && session.binding.room_id == room_id
                && session.binding.room_instance_id == instance
                && members.contains(&session.binding.peer_id)
        })
        .map(|_| ())
        .ok_or("stale")
}

/// Resolve exact current recipients for a public/private target.
fn recipients(
    store: &session::Store,
    sender: &SessionStamp,
    room_id: &str,
    instance: &str,
    members: &[String],
    target: &Target,
) -> Result<Vec<SessionStamp>, &'static str> {
    let candidates: Vec<_> = store
        .sessions
        .values()
        .filter(|session| {
            session.stamp != *sender
                && session.events.is_some()
                && session.binding.room_id == room_id
                && session.binding.room_instance_id == instance
                && members.contains(&session.binding.peer_id)
        })
        .map(|session| session.stamp.clone())
        .collect();
    match target {
        Target::Public => Ok(candidates),
        Target::Private { stamp } => candidates
            .into_iter()
            .find(|candidate| candidate == stamp)
            .map(|candidate| vec![candidate])
            .ok_or("denied"),
    }
}

/// Enqueue one revisioned JSON event to an exact current session.
fn enqueue_json(
    store: &mut session::Store,
    stamp: &SessionStamp,
    kind: &str,
    value: Value,
) -> Result<(), &'static str> {
    let recipient = store
        .sessions
        .get_mut(&stamp.session_id)
        .filter(|session| session.stamp == *stamp && session.events.is_some())
        .ok_or("stale")?;
    recipient.revision = recipient
        .revision
        .checked_add(1)
        .filter(|revision| *revision <= JS_SAFE_INTEGER)
        .ok_or("capacity")?;
    let frame = json!({"type":"event","version":1,"stamp":recipient.stamp,"revision":recipient.revision,"kind":kind,"value":value});
    recipient
        .events
        .as_ref()
        .ok_or("stale")?
        .try_send(frame.into())
        .map_err(|_| "capacity")
}

/// Best-effort sender event for an already allocated transfer.
fn enqueue_owner(store: &mut session::Store, id: Uuid, kind: &str, value: Value) {
    let owner = store
        .transfers
        .get(&id)
        .map(|transfer| transfer.owner.clone());
    if let Some(owner) = owner {
        let _ = enqueue_json(store, &owner, kind, value);
    }
}

/// Remove one transfer and publish terminal state after removal.
fn finish(store: &mut session::Store, id: Uuid, reason: &str, complete: bool) {
    let Some(transfer) = store.transfers.remove(&id) else {
        return;
    };
    let recipient_stamps: Vec<_> = transfer
        .recipients
        .into_values()
        .map(|recipient| recipient.stamp)
        .collect();
    let recipient_value = json!({"transferId":id.to_string(),"reason":reason,"fileName":transfer.file_name,"mediaType":transfer.media_type,"size":transfer.size});
    for recipient in &recipient_stamps {
        let _ = enqueue_json(
            store,
            recipient,
            if complete {
                "fileComplete"
            } else {
                "fileFailed"
            },
            recipient_value.clone(),
        );
    }
    let _ = enqueue_json(
        store,
        &transfer.owner,
        if complete {
            "fileTransferComplete"
        } else {
            "fileTransferFailed"
        },
        json!({"transferId":id.to_string(),"reason":reason,"recipients":recipient_stamps}),
    );
}

#[cfg(test)]
pub(super) mod tests;
