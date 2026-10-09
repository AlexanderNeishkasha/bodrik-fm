//! Deterministic bounded-owner tests: no native objects, network, credentials or shared clock mutation.

use super::{
    commands::{AdmissionPhase, Command},
    state::Registry,
};
use crate::integration::Grant;
use std::time::{Duration, Instant};

/// Synthetic current player mapping used only after the HTTP/identity boundary has validated it.
fn grant(id: &str, generation: u64) -> Grant {
    Grant {
        version: 1,
        conference_id: id.into(),
        generation,
        room_slug: "slug".into(),
        lease_seconds: 15,
    }
}

/// Reserve/commit a native incarnation using the exact production transition path.
fn room(registry: &mut Registry, now: Instant, id: &str) -> u64 {
    let epoch = registry
        .apply(
            Command::Reserve { room_id: id.into() },
            Some(grant(id, 7)),
            now,
        )
        .expect("reserve fixture")
        .epoch
        .expect("reservation fence");
    registry
        .apply(
            Command::Commit {
                room_id: id.into(),
                epoch,
                room_instance_id: "native-instance".into(),
                presenter_names: Vec::new(),
                moderator: crate::room::Moderator::default(),
                global_lobby: false,
            },
            Some(grant(id, 7)),
            now,
        )
        .expect("commit fixture");
    epoch
}

/// Begin a verified pending peer and return its privately issued resource fence.
fn begin(registry: &mut Registry, now: Instant, id: &str) -> u64 {
    registry
        .apply(
            Command::Begin {
                room_id: "room".into(),
                room_instance_id: "native-instance".into(),
                peer_id: id.into(),
                presenter: false,
                username: String::new(),
            },
            Some(grant("room", 7)),
            now,
        )
        .expect("pending fixture")
        .epoch
        .expect("admission epoch")
}

/// Build a phase-gated recipient query with exact server/native/session binding.
fn members(peer: &str, epoch: u64, pending: bool) -> Command {
    Command::Members {
        room_id: "room".into(),
        room_instance_id: "native-instance".into(),
        peer_id: peer.into(),
        epoch,
        pending,
    }
}

/// Concurrent reservation and cleanup cannot allocate two owners or delete a replacement.
#[test]
fn reservation_and_late_cleanup() {
    let now = Instant::now();
    let mut registry = Registry::default();
    let old = room(&mut registry, now, "room");
    assert!(
        registry
            .apply(
                Command::Reserve {
                    room_id: "room".into(),
                },
                Some(grant("room", 7)),
                now
            )
            .is_err()
    );
    registry
        .apply(
            Command::Abort {
                room_id: "room".into(),
                epoch: old,
            },
            None,
            now,
        )
        .expect("owned cleanup");
    let replacement = room(&mut registry, now, "room");
    assert!(replacement > old);
    registry
        .apply(
            Command::Abort {
                room_id: "room".into(),
                epoch: old,
            },
            None,
            now,
        )
        .expect("stale cleanup no-op");
    assert!(
        registry
            .apply(
                Command::Renew {
                    room_id: "room".into(),
                    room_instance_id: "native-instance".into()
                },
                Some(grant("room", 7)),
                now
            )
            .is_ok()
    );
}

/// Pending/password/lobby actors never inherit admitted recipient rights from rendering fields.
#[test]
fn phase_cases() {
    let now = Instant::now();
    for (name, phase, password_allowed) in [
        ("password", AdmissionPhase::Password, true),
        ("lobby", AdmissionPhase::Lobby, false),
    ] {
        let mut registry = Registry::default();
        room(&mut registry, now, "room");
        let epoch = begin(&mut registry, now, "peer");
        assert!(
            registry
                .apply(members("peer", epoch, false), None, now)
                .is_err(),
            "pending {name}"
        );
        registry
            .apply(
                Command::Phase {
                    room_id: "room".into(),
                    room_instance_id: "native-instance".into(),
                    peer_id: "peer".into(),
                    epoch,
                    phase,
                },
                None,
                now,
            )
            .expect("gate fixture");
        assert_eq!(
            registry
                .apply(members("peer", epoch, true), None, now)
                .is_ok(),
            password_allowed,
            "{name}"
        );
        assert!(
            registry
                .apply(members("peer", epoch, false), None, now)
                .is_err(),
            "{name}"
        );
        registry
            .apply(
                Command::Phase {
                    room_id: "room".into(),
                    room_instance_id: "native-instance".into(),
                    peer_id: "peer".into(),
                    epoch,
                    phase: AdmissionPhase::Admitted,
                },
                None,
                now,
            )
            .expect("admit fixture");
        assert_eq!(
            registry
                .apply(members("peer", epoch, false), None, now)
                .expect("members")
                .members,
            Some(vec!["peer".into()])
        );
    }
}

/// Same-ID replacement is pending with a fresh epoch; old commands/cleanup are rejected.
#[test]
fn replacement_fences_commands_and_leave() {
    let now = Instant::now();
    let mut registry = Registry::default();
    room(&mut registry, now, "room");
    let old = begin(&mut registry, now, "peer");
    let current = begin(&mut registry, now, "peer");
    assert!(current > old);
    assert!(
        registry
            .apply(members("peer", old, true), None, now)
            .is_err()
    );
    assert!(
        registry
            .apply(
                Command::Leave {
                    room_id: "room".into(),
                    room_instance_id: "native-instance".into(),
                    peer_id: "peer".into(),
                    epoch: old
                },
                None,
                now
            )
            .is_err()
    );
    registry
        .apply(
            Command::Phase {
                room_id: "room".into(),
                room_instance_id: "native-instance".into(),
                peer_id: "peer".into(),
                epoch: current,
                phase: AdmissionPhase::Admitted,
            },
            None,
            now,
        )
        .expect("new admission");
    assert!(
        registry
            .apply(members("peer", current, false), None, now)
            .is_ok()
    );
    registry
        .apply(
            Command::Leave {
                room_id: "room".into(),
                room_instance_id: "native-instance".into(),
                peer_id: "peer".into(),
                epoch: current,
            },
            None,
            now,
        )
        .expect("explicit leave");
    assert!(
        registry
            .apply(members("peer", current, false), None, now)
            .is_err()
    );
}

/// Renewal at exact expiry or on a revoked generation cannot resurrect a room.
#[test]
fn lease_and_generation_cases() {
    let now = Instant::now();
    for (name, generation, at) in [
        ("revoked", 8, now),
        ("exact deadline", 7, now + Duration::from_secs(15)),
    ] {
        let mut registry = Registry::default();
        room(&mut registry, now, "room");
        assert!(
            registry
                .apply(
                    Command::Renew {
                        room_id: "room".into(),
                        room_instance_id: "native-instance".into()
                    },
                    Some(grant("room", generation)),
                    at
                )
                .is_err(),
            "{name}"
        );
    }
}

/// Unconfirmed joins expire without keeping a native/socket admission alive or pinning capacity.
#[test]
fn pending_deadline_expires() {
    let now = Instant::now();
    let mut registry = Registry::default();
    room(&mut registry, now, "room");
    let epoch = begin(&mut registry, now, "peer");
    assert!(
        registry
            .apply(
                Command::Phase {
                    room_id: "room".into(),
                    room_instance_id: "native-instance".into(),
                    peer_id: "peer".into(),
                    epoch,
                    phase: AdmissionPhase::Admitted,
                },
                None,
                now + Duration::from_secs(10)
            )
            .is_err()
    );
}

/// Active rooms and participant maps enforce their advertised ceilings without partial insertion.
#[test]
fn registry_capacity_cases() {
    let now = Instant::now();
    let mut registry = Registry::default();
    for index in 0..128 {
        room(&mut registry, now, &format!("room-{index}"));
    }
    assert!(
        registry
            .apply(
                Command::Reserve {
                    room_id: "overflow".into(),
                },
                Some(grant("overflow", 7)),
                now
            )
            .is_err()
    );
    let mut registry = Registry::default();
    for index in 0..4 {
        let id = if index == 0 {
            "room".into()
        } else {
            format!("room-{index}")
        };
        room(&mut registry, now, &id);
        for member in 0..1000 {
            registry
                .apply(
                    Command::Begin {
                        room_id: id.clone(),
                        room_instance_id: "native-instance".into(),
                        peer_id: format!("peer-{index}-{member}"),
                        presenter: false,
                        username: String::new(),
                    },
                    Some(grant(&id, 7)),
                    now,
                )
                .expect("bounded member fixture");
        }
    }
    assert!(
        registry
            .apply(
                Command::Begin {
                    room_id: "room".into(),
                    room_instance_id: "native-instance".into(),
                    peer_id: "overflow".into(),
                    presenter: false,
                    username: String::new()
                },
                Some(grant("room", 7)),
                now
            )
            .is_err()
    );
    assert!(
        registry
            .apply(
                Command::Begin {
                    room_id: "room".into(),
                    room_instance_id: "native-instance".into(),
                    peer_id: "peer-0-0".into(),
                    presenter: false,
                    username: String::new()
                },
                Some(grant("room", 7)),
                now
            )
            .is_ok()
    );
}

/// Outstanding native allocations cannot grow beyond the independent eight-reservation budget.
#[test]
fn reservation_capacity() {
    let now = Instant::now();
    let mut registry = Registry::default();
    for index in 0..8 {
        let id = format!("room-{index}");
        registry
            .apply(
                Command::Reserve {
                    room_id: id.clone(),
                },
                Some(grant(&id, 7)),
                now,
            )
            .expect("bounded fixture");
    }
    assert!(
        registry
            .apply(
                Command::Reserve {
                    room_id: "overflow".into(),
                },
                Some(grant("overflow", 7)),
                now
            )
            .is_err()
    );
}

/// Read-only room queries derive validity from the same deadline used by every domain transition.
#[test]
fn named_room_current_boundaries() {
    for (name, instance, seconds, expected) in [
        ("live", "native-instance", 14, true),
        ("exclusive deadline", "native-instance", 15, false),
        ("foreign incarnation", "other-instance", 1, false),
    ] {
        let mut registry = Registry::default();
        let now = Instant::now();
        room(&mut registry, now, "conference");
        assert_eq!(
            registry.room_current("conference", instance, now + Duration::from_secs(seconds)),
            expected,
            "{name}"
        );
        assert!(
            registry.room_current("conference", "native-instance", now),
            "query cannot extend or mutate {name}"
        );
    }
}

/// Registry poisoning cannot masquerade as a safely ignored retired-room event.
#[test]
fn poisoned_registry_is_not_a_retired_room() {
    let runtime = super::Runtime::default();
    let registry = runtime.registry.clone();
    let failed = std::thread::spawn(move || {
        let _guard = registry.lock().expect("registry");
        panic!("synthetic registry poisoning");
    });
    assert!(failed.join().is_err());
    assert!(
        runtime
            .room_current("conference", "native-instance")
            .is_err()
    );
}

/// A sixty-second grant remains current after the old limit but expires exactly on its deadline.
#[test]
fn sixty_second_grant_has_exclusive_deadline() {
    let mut registry = Registry::default();
    let now = Instant::now();
    room(&mut registry, now, "conference");
    let mut renewed = grant("conference", 7);
    renewed.lease_seconds = 60;
    registry
        .apply(
            Command::Renew {
                room_id: "conference".into(),
                room_instance_id: "native-instance".into(),
            },
            Some(renewed),
            now,
        )
        .expect("renew longer grant");
    for (name, seconds, current) in [
        ("after old deadline", 15, true),
        ("last second", 59, true),
        ("exclusive deadline", 60, false),
        ("after deadline", 61, false),
    ] {
        assert_eq!(
            registry.room_current(
                "conference",
                "native-instance",
                now + Duration::from_secs(seconds)
            ),
            current,
            "{name}"
        );
    }
}
