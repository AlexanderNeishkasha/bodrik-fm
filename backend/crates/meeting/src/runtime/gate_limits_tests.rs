//! Boundaries for private gate storage, retained TTL and strict control authorization.

use super::gates::{Action, Gates};
use crate::{membership::Phase, room::Actor};
use std::time::{Duration, Instant};

/// Synthetic current admitted presenter for pure control-storage tests.
fn host() -> Actor {
    Actor {
        member: true,
        lobby: false,
        presenter: true,
    }
}

/// Bans are bounded, do not refresh on duplicate intent, and retain the old exact TTL boundary.
#[test]
fn ban_capacity_and_expiry_boundaries() {
    let now = Instant::now();
    let mut gates = Gates::default();
    for index in 0..1000 {
        assert_eq!(
            gates.apply(
                host(),
                Phase::Admitted,
                "host",
                Action::Ban {
                    name: String::new(),
                    uuid: format!("device-{index}")
                },
                now
            ),
            Ok(true)
        );
    }
    assert_eq!(
        gates.apply(
            host(),
            Phase::Admitted,
            "host",
            Action::Ban {
                name: String::new(),
                uuid: "overflow".into()
            },
            now
        ),
        Err("runtime capacity exhausted")
    );
    assert_eq!(
        gates.apply(
            host(),
            Phase::Admitted,
            "host",
            Action::Ban {
                name: String::new(),
                uuid: "device-0".into()
            },
            now + Duration::from_secs(86000)
        ),
        Ok(true)
    );
    let deadline = now + Duration::from_secs(86400);
    gates.expire(deadline);
    assert!(gates.banned("device-0"));
    gates.expire(deadline + Duration::from_nanos(1));
    assert!(!gates.banned("device-0"));
    assert_eq!(
        gates.apply(
            host(),
            Phase::Admitted,
            "host",
            Action::Ban {
                name: String::new(),
                uuid: "overflow".into()
            },
            deadline
        ),
        Ok(true)
    );
}

/// Guest and unadmitted presenter flags cannot mutate the public controls or set a private password.
#[test]
fn denied_controls_preserve_state() {
    for (name, actor) in [
        (
            "guest",
            Actor {
                member: true,
                lobby: false,
                presenter: false,
            },
        ),
        (
            "pending presenter",
            Actor {
                member: false,
                lobby: false,
                presenter: true,
            },
        ),
        (
            "lobby presenter",
            Actor {
                member: false,
                lobby: true,
                presenter: true,
            },
        ),
    ] {
        let now = Instant::now();
        let mut gates = Gates::default();
        assert_eq!(
            gates.apply(
                actor,
                Phase::Pending,
                "device",
                Action::Lock {
                    password: "private-password".into()
                },
                now
            ),
            Err("runtime denied"),
            "{name}"
        );
        assert!(!gates.config.is_locked, "{name}");
        assert_eq!(
            gates.apply(
                host(),
                Phase::Admitted,
                "host",
                Action::Password {
                    password: "private-password".into()
                },
                now
            ),
            Ok(false),
            "{name}"
        );
    }
}

/// Unicode password bounds retain JavaScript UTF-16 semantics instead of imposing a UTF-8 byte limit.
#[test]
fn utf16_password_boundaries() {
    for (name, password, accepted) in [
        ("empty", String::new(), false),
        ("256 ASCII units", "a".repeat(256), true),
        ("257 ASCII units", "a".repeat(257), false),
        ("256 emoji units", "🔒".repeat(128), true),
        ("258 emoji units", "🔒".repeat(129), false),
    ] {
        let mut gates = Gates::default();
        assert_eq!(
            gates.apply(
                host(),
                Phase::Admitted,
                "host",
                Action::Lock { password },
                Instant::now()
            ),
            Ok(accepted),
            "{name}"
        );
        assert_eq!(gates.config.is_locked, accepted, "{name}");
    }
}
