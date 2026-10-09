//! Named relay validation, coturn compatibility and admitted-session boundary cases.
use super::*;

/// Synthetic independent secret, never a production input.
const SECRET: &str = "0123456789abcdef0123456789abcdef";

/// Enabled deterministic fixture with the production URL shape.
fn policy() -> Policy {
    Policy::parse(
        "true",
        "turns:turn.example.test:443?transport=tcp",
        SECRET,
        "3600",
        "true",
    )
    .expect("policy")
}

/// Known independently computed HMAC-SHA1 vector verifies coturn REST compatibility.
#[test]
fn coturn_credentials_are_temporary_and_session_bound() {
    let value = policy().issue("opaque-session", 1000).expect("issue");
    assert_eq!(value["expiresAt"], 4600);
    assert_eq!(value["iceTransportPolicy"], "relay");
    assert_eq!(value["iceServers"][0]["username"], "4600:opaque-session");
    assert_eq!(
        value["iceServers"][0]["credential"],
        "eQHT0rIWQNpzJoF62gXhnY9PFl0="
    );
    assert!(!value.to_string().contains(SECRET));
    assert_ne!(
        value,
        policy().issue("different-session", 1000).expect("other")
    );
    assert_ne!(
        value,
        policy().issue("opaque-session", 1001).expect("fresh")
    );
    assert!(policy().issue("session", u64::MAX).is_err());
}

/// Disabled relay emits direct ICE and no secret or lifetime-dependent timer inputs.
#[test]
fn disabled_turn_uses_direct_ice() {
    assert_eq!(
        Policy::default().issue("session", 0).expect("direct"),
        json!({"iceServers":[],"iceTransportPolicy":"all","expiresAt":null})
    );
    let optional = Policy::parse(
        "true",
        "turn:localhost:3478?transport=udp,turns:[::1]:443?transport=tcp",
        SECRET,
        "",
        "false",
    )
    .expect("optional");
    assert_eq!(
        optional.issue("session", 0).expect("issue")["iceTransportPolicy"],
        "all"
    );
}

/// Invalid enabled configurations fail without revealing supplied secrets.
#[test]
fn named_invalid_relay_inputs() {
    for (name, enabled, urls, secret, ttl, force) in [
        ("ambiguous enable", "yes", "turn:a", SECRET, "3600", "false"),
        ("ambiguous relay", "true", "turn:a", SECRET, "3600", "yes"),
        ("relay without TURN", "false", "", "", "", "true"),
        ("missing URL", "true", "", SECRET, "3600", "true"),
        (
            "wrong scheme",
            "true",
            "https://example.test",
            SECRET,
            "3600",
            "true",
        ),
        (
            "embedded password",
            "true",
            "turn:user:password@example.test",
            SECRET,
            "3600",
            "true",
        ),
        (
            "URL path",
            "true",
            "turn:example.test/path",
            SECRET,
            "3600",
            "true",
        ),
        (
            "fragment",
            "true",
            "turn:example.test#secret",
            SECRET,
            "3600",
            "true",
        ),
        (
            "unknown transport",
            "true",
            "turn:example.test?transport=other",
            SECRET,
            "3600",
            "true",
        ),
        (
            "TLS UDP",
            "true",
            "turns:example.test?transport=udp",
            SECRET,
            "3600",
            "true",
        ),
        (
            "invalid port",
            "true",
            "turn:example.test:70000",
            SECRET,
            "3600",
            "true",
        ),
        (
            "zero port",
            "true",
            "turn:example.test:0",
            SECRET,
            "3600",
            "true",
        ),
        (
            "control character",
            "true",
            "turn:example\n.test",
            SECRET,
            "3600",
            "true",
        ),
        (
            "weak secret",
            "true",
            "turn:example.test",
            "short",
            "3600",
            "true",
        ),
        (
            "short lifetime",
            "true",
            "turn:example.test",
            SECRET,
            "59",
            "true",
        ),
        (
            "long lifetime",
            "true",
            "turn:example.test",
            SECRET,
            "86401",
            "true",
        ),
        (
            "invalid lifetime",
            "true",
            "turn:example.test",
            SECRET,
            "invalid",
            "true",
        ),
    ] {
        let error = Policy::parse(enabled, urls, secret, ttl, force)
            .err()
            .expect(name);
        assert!(!error.contains(secret) || secret.is_empty(), "{name}");
    }
}

/// Credentials cannot be issued to pending, disconnected, absent or stale-session callers.
#[test]
fn named_session_authorization_boundaries() {
    for (name, pending, disconnected, epoch, missing, allowed) in [
        ("admitted", false, false, 1, false, true),
        ("pending lobby", true, false, 1, false, false),
        ("disconnected", false, true, 1, false, false),
        ("stale epoch", false, false, 2, false, false),
        ("missing session", false, false, 1, true, false),
    ] {
        let (mut service, _receivers, _) =
            super::super::observations::tests::fixture(pending, disconnected);
        std::sync::Arc::get_mut(&mut service.config)
            .expect("unique config")
            .turn = policy();
        let stamp = SessionStamp {
            room_instance_id: "instance".into(),
            session_id: if missing { "absent" } else { "receiver" }.into(),
            admission_epoch: epoch,
        };
        assert_eq!(configuration(&service, &stamp).is_ok(), allowed, "{name}");
        assert!(
            serde_json::from_value::<super::super::wire::Action>(
                json!({"type":"iceConfig","sessionId":"sender"})
            )
            .is_err()
        );
    }
}

/// Domain retirement and expired room grants deny issuance despite an unchanged socket stamp.
#[test]
fn retired_and_expired_rooms_cannot_issue_credentials() {
    use crate::{integration::Grant, runtime::Command};
    for retired in [false, true] {
        let (service, _receivers, binding) =
            super::super::observations::tests::fixture(false, false);
        if retired {
            let reservation = service.store.lock().expect("store").rooms["conference"].reservation;
            service
                .runtime
                .apply_verified(
                    Command::Abort {
                        room_id: binding.room_id.clone(),
                        epoch: reservation,
                    },
                    None,
                )
                .expect("retire");
        } else {
            service
                .runtime
                .apply_verified(
                    Command::Renew {
                        room_id: binding.room_id.clone(),
                        room_instance_id: binding.room_instance_id.clone(),
                    },
                    Some(Grant {
                        version: 1,
                        conference_id: binding.room_id,
                        generation: 3,
                        room_slug: "public-room".into(),
                        lease_seconds: 0,
                    }),
                )
                .expect("expire");
        }
        let stamp = SessionStamp {
            room_instance_id: "instance".into(),
            session_id: "receiver".into(),
            admission_epoch: 1,
        };
        assert!(
            configuration(&service, &stamp).is_err(),
            "retired={retired}"
        );
    }
}
