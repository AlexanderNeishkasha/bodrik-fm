//! File contract boundary fixtures.
use super::*;
use crate::{
    replacement::{observations::tests::fixture, wire::Outbound},
    signaling::SessionStamp,
};
use serde_json::json;
use tokio::sync::mpsc;

/// Build one exact binary frame fixture.
pub(crate) fn frame(id: Uuid, sequence: u32, final_chunk: bool, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(HEADER_BYTES + payload.len());
    frame.extend_from_slice(MAGIC);
    frame.push(VERSION);
    frame.extend_from_slice(id.as_bytes());
    frame.extend_from_slice(&sequence.to_be_bytes());
    frame.push(u8::from(final_chunk));
    frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Contract metadata and framing reject unsafe boundaries.
#[test]
fn schema_and_frame_cases() {
    let valid: Offer = serde_json::from_value(json!({"version":1,"target":{"type":"public"},"fileName":"notes.txt","mediaType":"text/plain","size":12,"sha256":"a".repeat(64)})).expect("offer");
    assert!(valid.validate().is_ok());
    for name in ["../secret", "folder/file", "C:\\file", ""] {
        let offer = Offer {
            version: VERSION,
            target: Target::Public,
            file_name: name.into(),
            media_type: "text/plain".into(),
            size: 1,
            sha256: "a".repeat(64),
        };
        assert!(offer.validate().is_err(), "{name}");
    }
    let id = Uuid::new_v4();
    let bytes = frame(id, 7, true, b"payload");
    let chunk = Chunk::decode(&bytes).expect("chunk");
    assert_eq!(chunk.transfer_id, id);
    assert_eq!(chunk.sequence, 7);
    let mut invalid = bytes;
    invalid[24] = 2;
    assert!(Chunk::decode(&invalid).is_err());
}

/// Build the two exact fixture stamps.
fn stamps() -> (SessionStamp, SessionStamp) {
    (
        SessionStamp {
            room_instance_id: "instance".into(),
            session_id: "sender".into(),
            admission_epoch: 1,
        },
        SessionStamp {
            room_instance_id: "instance".into(),
            session_id: "receiver".into(),
            admission_epoch: 1,
        },
    )
}

/// Allocate one private one-byte transfer after widening the recipient fixture queue.
fn allocated() -> (
    Service,
    Vec<mpsc::Receiver<Outbound>>,
    mpsc::Receiver<Outbound>,
    SessionStamp,
    SessionStamp,
    Uuid,
) {
    let (service, receivers, _) = fixture(false, false);
    let (sender, receiver) = stamps();
    let (sink, file_receiver) = mpsc::channel(8);
    service
        .store
        .lock()
        .expect("store")
        .sessions
        .get_mut("receiver")
        .expect("receiver")
        .events = Some(sink);
    let value = offer(
        &service,
        &sender,
        Offer {
            version: VERSION,
            target: Target::Private {
                stamp: receiver.clone(),
            },
            file_name: "one.bin".into(),
            media_type: "application/octet-stream".into(),
            size: 1,
            sha256: format!("{:x}", Sha256::digest(b"x")),
        },
    )
    .expect("offer");
    let id = Uuid::parse_str(value["transferId"].as_str().expect("id")).expect("uuid");
    (service, receivers, file_receiver, sender, receiver, id)
}

/// Cancellation requires canonical versioned UUID text.
#[test]
fn cancellation_cases() {
    let id = Uuid::new_v4();
    assert_eq!(
        Cancel {
            version: VERSION,
            transfer_id: id.to_string()
        }
        .validate()
        .expect("cancel"),
        id
    );
    assert!(
        Cancel {
            version: VERSION,
            transfer_id: id.to_string().to_uppercase()
        }
        .validate()
        .is_err()
    );
}

/// Metadata precedes binary delivery and verified completion reaches both sides.
#[test]
fn complete_private_transfer() {
    let (service, mut senders, mut recipient, sender, _, id) = allocated();
    let metadata = recipient.try_recv().expect("metadata");
    assert_eq!(metadata["kind"], "fileOffer");
    assert_eq!(metadata["value"]["target"]["type"], "private");
    binary(&service, &sender, frame(id, 0, true, b"x")).expect("binary");
    assert!(
        matches!(recipient.try_recv().expect("binary"), Outbound::Binary { transfer_id, .. } if transfer_id == id)
    );
    assert_eq!(
        recipient.try_recv().expect("recipient complete")["kind"],
        "fileComplete"
    );
    assert_eq!(
        senders[0].try_recv().expect("sender complete")["kind"],
        "fileTransferComplete"
    );
    assert!(service.store.lock().expect("store").transfers.is_empty());
    let public = offer(
        &service,
        &sender,
        Offer {
            version: VERSION,
            target: Target::Public,
            file_name: "public.bin".into(),
            media_type: String::new(),
            size: 1,
            sha256: format!("{:x}", Sha256::digest(b"x")),
        },
    )
    .expect("public offer");
    let metadata = recipient.try_recv().expect("public metadata");
    assert_eq!(metadata["kind"], "fileOffer");
    assert_eq!(metadata["value"]["target"]["type"], "public");
    cancel(
        &service,
        &sender,
        Cancel {
            version: VERSION,
            transfer_id: public["transferId"].as_str().expect("public id").into(),
        },
    )
    .expect("sender cancel");
    assert!(service.store.lock().expect("store").transfers.is_empty());
}

/// Foreign owners, sequence gaps and integrity failures terminate exact transfer state.
#[test]
fn ownership_sequence_and_integrity_cases() {
    let (service, _, mut recipient, sender, receiver, id) = allocated();
    recipient.try_recv().expect("metadata");
    assert!(binary(&service, &receiver, frame(id, 0, true, b"x")).is_err());
    assert_eq!(service.store.lock().expect("store").transfers.len(), 1);
    assert!(binary(&service, &sender, frame(id, 1, true, b"x")).is_err());
    assert!(service.store.lock().expect("store").transfers.is_empty());

    let (service, _, mut recipient, sender, _, id) = allocated();
    recipient.try_recv().expect("metadata");
    assert!(binary(&service, &sender, frame(id, 0, true, b"y")).is_err());
    assert!(service.store.lock().expect("store").transfers.is_empty());
}

/// Outgoing quota and both deadlines remain bounded and remove owned state.
#[test]
fn quota_and_deadline_cases() {
    let (service, _, mut recipient, sender, receiver, _) = allocated();
    recipient.try_recv().expect("metadata");
    let second = Offer {
        version: VERSION,
        target: Target::Private {
            stamp: receiver.clone(),
        },
        file_name: "two.bin".into(),
        media_type: String::new(),
        size: 1,
        sha256: format!("{:x}", Sha256::digest(b"x")),
    };
    offer(&service, &sender, second).expect("second");
    recipient.try_recv().expect("second metadata");
    let third = Offer {
        version: VERSION,
        target: Target::Private { stamp: receiver },
        file_name: "three.bin".into(),
        media_type: String::new(),
        size: 1,
        sha256: format!("{:x}", Sha256::digest(b"x")),
    };
    assert_eq!(
        offer(&service, &sender, third).expect_err("quota"),
        "capacity"
    );
    {
        let mut store = service.store.lock().expect("store");
        for transfer in store.transfers.values_mut() {
            transfer.active = Instant::now() - IDLE;
        }
    }
    expire(&service, Instant::now());
    assert!(service.store.lock().expect("store").transfers.is_empty());
}

/// Disconnect cancels owned transfers rather than resuming partial state.
#[test]
fn disconnect_cancels_partial_transfer() {
    let (service, _, mut recipient, sender, _, _) = allocated();
    recipient.try_recv().expect("metadata");
    crate::replacement::recovery::disconnect(&service, &sender);
    assert!(service.store.lock().expect("store").transfers.is_empty());
}

/// File attachments obey the same moderator permissions as their chat conversations.
#[test]
fn chat_permission_cases() {
    use crate::room::{ModeratorChange, ModeratorField};
    for (name, field, public) in [
        ("public", ModeratorField::ChatCantPublicly, true),
        ("private", ModeratorField::ChatCantPrivately, false),
    ] {
        let (service, _receivers, binding) = fixture(false, false);
        let (sender, receiver) = stamps();
        service
            .runtime
            .apply_verified(
                Command::Moderator {
                    room_id: binding.room_id,
                    room_instance_id: binding.room_instance_id,
                    peer_id: binding.peer_id,
                    epoch: binding.admission_epoch,
                    change: Some(ModeratorChange::One {
                        field,
                        status: true,
                    }),
                },
                None,
            )
            .expect("restrict chat");
        let target = if public {
            Target::Public
        } else {
            Target::Private { stamp: receiver }
        };
        let result = offer(
            &service,
            &sender,
            Offer {
                version: VERSION,
                target,
                file_name: "notes.txt".into(),
                media_type: "text/plain".into(),
                size: 1,
                sha256: format!("{:x}", Sha256::digest(b"x")),
            },
        );
        assert_eq!(result.expect_err(name), "denied", "{name}");
        assert!(service.store.lock().expect("store").transfers.is_empty());
    }
}
