//! Participant media authority and wire-schema rejection tables.

use super::*;
use crate::media::protocol::{Empty, Producer};
use crate::runtime::{
    commands::Command,
    gate_tests::{begin, fixture, gate},
};
use std::time::Instant;

/// Current server-derived native binding for the synthetic registry.
fn binding(epoch: u64) -> Binding {
    Binding {
        room_id: "room".into(),
        room_instance_id: "native".into(),
        peer_id: "guest".into(),
        admission_epoch: epoch,
    }
}

/// A capability query still requires admitted current Rust membership.
#[test]
fn participant_binding_cases() {
    for (name, admitted, stale, replaced, banned) in [
        ("admitted", true, false, false, false),
        ("pending", false, false, false, false),
        ("stale epoch", true, true, false, false),
        ("replaced", true, false, true, false),
        ("banned", true, false, false, true),
    ] {
        let now = Instant::now();
        let (mut registry, host) = fixture(now);
        let epoch = begin(&mut registry, now, "guest", false);
        if admitted {
            registry
                .apply(gate("guest", epoch, "guest-device"), None, now)
                .expect("gate");
        }
        if replaced {
            begin(&mut registry, now, "guest", false);
        }
        if banned {
            registry
                .apply(
                    crate::runtime::gate_tests::control(
                        "host",
                        host,
                        crate::runtime::gates::Action::Ban {
                            name: String::new(),
                            uuid: "guest-device".into(),
                        },
                    ),
                    None,
                    now,
                )
                .expect("ban");
        }
        let runtime = Runtime {
            registry: std::sync::Arc::new(std::sync::Mutex::new(registry)),
            ..Runtime::default()
        };
        let result = runtime.media_authorized(
            &binding(if stale { epoch + 100 } else { epoch }),
            &Operation::Capabilities(Empty::default()),
        );
        assert_eq!(
            result.is_ok(),
            admitted && !stale && !replaced && !banned,
            "{name}"
        );
    }
}

/// Source activation uses Rust moderator policy independently of resource-provider flags.
#[test]
fn source_policy_changes_are_rechecked() {
    let now = Instant::now();
    let (mut registry, host) = fixture(now);
    let epoch = begin(&mut registry, now, "guest", false);
    registry
        .apply(gate("guest", epoch, "guest-device"), None, now)
        .expect("gate");
    let runtime = Runtime {
        registry: std::sync::Arc::new(std::sync::Mutex::new(registry)),
        ..Runtime::default()
    };
    let operation = Operation::Produce {
        transport_id: "transport".into(),
        kind: MediaKind::Audio,
        media_type: MediaType::Audio,
        rtp_parameters: serde_json::json!({}),
    };
    assert!(
        runtime
            .media_authorized(&binding(epoch), &operation)
            .is_ok()
    );
    runtime
        .registry
        .lock()
        .expect("lock")
        .apply(
            Command::Moderator {
                room_id: "room".into(),
                room_instance_id: "native".into(),
                peer_id: "host".into(),
                epoch: host,
                change: Some(crate::room::ModeratorChange::One {
                    field: crate::room::ModeratorField::AudioCantUnmute,
                    status: true,
                }),
            },
            None,
            now,
        )
        .expect("moderator");
    assert!(
        runtime
            .media_authorized(&binding(epoch), &operation)
            .is_err()
    );
}

/// Broader lifecycle and source-unknown operations cannot be smuggled through a participant gateway.
#[test]
fn unsupported_operation_cases() {
    for (name, operation) in [
        (
            "native router allocation",
            Operation::CreateRoom(Empty::default()),
        ),
        (
            "native peer allocation",
            Operation::CreatePeer(Empty::default()),
        ),
        ("room retirement", Operation::CloseRoom(Empty::default())),
        ("peer retirement", Operation::ClosePeer(Empty::default())),
        (
            "source unknown resume",
            Operation::ResumeProducer(Producer {
                producer_id: "producer".into(),
            }),
        ),
        (
            "kind mismatch",
            Operation::Produce {
                transport_id: "transport".into(),
                kind: MediaKind::Video,
                media_type: MediaType::Audio,
                rtp_parameters: serde_json::json!({}),
            },
        ),
        (
            "bad transport",
            Operation::RestartIce(protocol::Transport {
                transport_id: "../other".into(),
            }),
        ),
    ] {
        assert!(source_capability(&operation).is_err(), "{name}");
    }
}

/// Typed native operations reject extra lifecycle/ownership fields rather than silently ignoring them.
#[test]
fn operation_schema_cases() {
    for (name, value, accepted) in [
        (
            "capabilities",
            serde_json::json!({"operation":"capabilities","payload":{}}),
            true,
        ),
        (
            "extra field",
            serde_json::json!({"operation":"capabilities","payload":{"presenter":true}}),
            false,
        ),
        (
            "extra envelope",
            serde_json::json!({"operation":"capabilities","payload":{},"epoch":1}),
            false,
        ),
        (
            "bad kind",
            serde_json::json!({"operation":"produce","payload":{"transportId":"transport","kind":"other","mediaType":"audioType","rtpParameters":{}}}),
            false,
        ),
    ] {
        assert_eq!(
            serde_json::from_value::<Operation>(value).is_ok(),
            accepted,
            "{name}"
        );
    }
}
