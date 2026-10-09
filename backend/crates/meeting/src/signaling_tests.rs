//! Replacement handshake fixtures; parser tests never claim cryptographic admission.

use super::*;
use serde_json::json;

/// Accept only explicit versioned admit/resume envelopes, never legacy or native authority claims.
#[test]
fn hello_schema_cases() {
    let ticket = "t".repeat(32);
    for (name, value, accepted) in [
        (
            "admit",
            json!({"type":"admit","version":1,"ticket":ticket}),
            true,
        ),
        (
            "resume",
            json!({"type":"resume","version":1,"sessionId":"session","recoveryToken":ticket}),
            true,
        ),
        (
            "foreign version",
            json!({"type":"admit","version":2,"ticket":ticket}),
            false,
        ),
        (
            "missing version",
            json!({"type":"admit","ticket":ticket}),
            false,
        ),
        (
            "legacy proof",
            json!({"type":"admit","version":1,"peerToken":ticket}),
            false,
        ),
        (
            "password envelope",
            json!({"type":"admit","version":1,"ticket":ticket,"password":"host-password"}),
            false,
        ),
        (
            "role forgery",
            json!({"type":"admit","version":1,"ticket":ticket,"presenter":true}),
            false,
        ),
        (
            "room forgery",
            json!({"type":"admit","version":1,"ticket":ticket,"roomId":"room"}),
            false,
        ),
        (
            "native binding",
            json!({"type":"admit","version":1,"ticket":ticket,"binding":{}}),
            false,
        ),
        (
            "resume missing capability",
            json!({"type":"resume","version":1,"sessionId":"session"}),
            false,
        ),
        (
            "resume path",
            json!({"type":"resume","version":1,"sessionId":"../other","recoveryToken":ticket}),
            false,
        ),
        (
            "resume claimed epoch",
            json!({"type":"resume","version":1,"sessionId":"session","recoveryToken":ticket,"admissionEpoch":1}),
            false,
        ),
    ] {
        let mut value = value;
        value["ownerProof"] = json!("a".repeat(64));
        let bytes = serde_json::to_vec(&value).expect("fixture JSON");
        assert_eq!(Hello::parse(&bytes).is_ok(), accepted, "{name}");
    }
}

/// Opaque material and JSON are bounded without echoing malformed credentials in errors.
#[test]
fn hello_boundary_cases() {
    for (name, ticket, accepted) in [
        ("short", "t".repeat(31), false),
        ("minimum", "t".repeat(32), true),
        ("maximum", "t".repeat(2048), true),
        ("oversize token", "t".repeat(2049), false),
        ("whitespace", format!("{} ", "t".repeat(32)), false),
        ("unicode", "я".repeat(32), false),
        ("URL", format!("https://{}", "t".repeat(32)), false),
    ] {
        let bytes = serde_json::to_vec(
            &json!({"type":"admit","version":1,"ticket":ticket,"ownerProof":"a".repeat(64)}),
        )
        .expect("fixture JSON");
        assert_eq!(Hello::parse(&bytes).is_ok(), accepted, "{name}");
    }
    for (name, bytes) in [
        ("oversize frame", vec![b' '; HELLO_LIMIT + 1]),
        ("malformed JSON", b"{".to_vec()),
        ("invalid UTF-8", vec![255]),
        (
            "duplicate type",
            format!(
                r#"{{"type":"admit","type":"resume","version":1,"ticket":"{}"}}"#,
                "t".repeat(32)
            )
            .into_bytes(),
        ),
    ] {
        assert!(
            matches!(Hello::parse(&bytes), Err(HelloError::Malformed)),
            "{name}"
        );
    }
}

/// A capability without the independently generated ownership proof never authenticates recovery.
#[test]
fn ownership_proof_cases() {
    for (name, proof, accepted) in [
        ("missing", None, false),
        ("short", Some("a".repeat(63)), false),
        ("invalid hex", Some("g".repeat(64)), false),
        ("canonical", Some("a".repeat(64)), true),
    ] {
        let mut value = json!({"type":"resume","version":1,"sessionId":"session","recoveryToken":"t".repeat(64)});
        if let Some(proof) = proof {
            value["ownerProof"] = json!(proof);
        }
        assert_eq!(
            Hello::parse(&serde_json::to_vec(&value).expect("JSON")).is_ok(),
            accepted,
            "{name}"
        );
    }
}

/// Public session stamps remain bounded and distinct from private worker boot/resource binding.
#[test]
fn session_stamp_cases() {
    for (name, epoch, valid) in [
        ("first", 1, true),
        ("zero", 0, false),
        ("safe maximum", JS_SAFE_INTEGER, true),
        ("unsafe epoch", JS_SAFE_INTEGER + 1, false),
    ] {
        let stamp = SessionStamp {
            room_instance_id: "room-instance".into(),
            session_id: "session".into(),
            admission_epoch: epoch,
        };
        assert_eq!(stamp.is_valid(), valid, "{name}");
    }
    assert!(
        serde_json::from_value::<SessionStamp>(json!({
            "roomInstanceId":"room","sessionId":"session","admissionEpoch":1,"bootId":"native-boot"
        }))
        .is_err()
    );
}
