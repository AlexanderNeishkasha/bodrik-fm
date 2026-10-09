//! Named role-authority cases exercise active registry transitions without native flags or network I/O.

use super::{
    commands::{AdmissionPhase, Command},
    state::Registry,
};
use crate::integration::Grant;
use std::time::Instant;

/// Verified synthetic player decision; never derived from a browser payload.
fn grant() -> Grant {
    Grant {
        version: 1,
        conference_id: "room".into(),
        generation: 7,
        room_slug: "slug".into(),
        lease_seconds: 15,
    }
}

/// Establish a native room with immutable startup role options.
fn registry(now: Instant) -> Registry {
    let mut registry = Registry::default();
    let epoch = registry
        .apply(
            Command::Reserve {
                room_id: "room".into(),
            },
            Some(grant()),
            now,
        )
        .expect("reserve")
        .epoch
        .expect("epoch");
    registry
        .apply(
            Command::Commit {
                room_id: "room".into(),
                epoch,
                room_instance_id: "native".into(),
                presenter_names: vec!["configured".into()],
                moderator: crate::room::Moderator::default(),
                global_lobby: false,
            },
            Some(grant()),
            now,
        )
        .expect("commit");
    registry
}

/// Begin an identity whose role/name were independently verified before this transition.
fn begin(registry: &mut Registry, now: Instant, id: &str, presenter: bool, username: &str) -> u64 {
    registry
        .apply(
            Command::Begin {
                room_id: "room".into(),
                room_instance_id: "native".into(),
                peer_id: id.into(),

                presenter,
                username: username.into(),
            },
            Some(grant()),
            now,
        )
        .expect("begin")
        .epoch
        .expect("epoch")
}

/// Complete admission using a verified domain transition; pending roles alone do not authorize actions.
fn admit(registry: &mut Registry, now: Instant, id: &str, epoch: u64) {
    registry
        .apply(
            Command::Phase {
                room_id: "room".into(),
                room_instance_id: "native".into(),
                peer_id: id.into(),
                epoch,
                phase: AdmissionPhase::Admitted,
            },
            None,
            now,
        )
        .expect("admit");
}

/// Construct a current role projection request, independent of native peer flags.
fn role(id: &str, epoch: u64) -> Command {
    Command::Role {
        room_id: "room".into(),
        room_instance_id: "native".into(),
        peer_id: id.into(),
        epoch,
    }
}

/// Construct an actor/target-fenced role transfer.
fn transfer(actor: &str, epoch: u64, target: &str, target_epoch: u64, presenter: bool) -> Command {
    Command::SetRole {
        room_id: "room".into(),
        room_instance_id: "native".into(),
        peer_id: actor.into(),
        epoch,
        target_id: target.into(),
        target_epoch,
        presenter,
    }
}

/// Only a verified signed role grants initial presenter authority, including the first guest.
#[test]
fn initial_role_cases() {
    for (name, token, username, expected) in [
        ("first guest", false, "guest", false),
        ("token", true, "guest", true),
        ("configured mint guest", false, "configured", false),
        ("configured signed presenter", true, "configured", true),
    ] {
        let now = Instant::now();
        let mut registry = registry(now);
        let epoch = begin(&mut registry, now, "actor", token, username);
        assert_eq!(
            registry
                .apply(role("actor", epoch), None, now)
                .expect(name)
                .presenter,
            Some(expected),
            "{name}"
        );
        // A pending presenter cannot grant another identity a role before admission completes.
        let target = begin(&mut registry, now, "target", false, "guest");
        admit(&mut registry, now, "target", target);
        assert!(
            registry
                .apply(transfer("actor", epoch, "target", target, true), None, now)
                .is_err(),
            "{name}"
        );
    }
}

/// Rejected transfers never change target authority; both participant epochs are mandatory.
#[test]
fn transfer_rejection_cases() {
    for (name, actor_presenter, actor_admitted, stale_actor, stale_target, pinned, expected) in [
        ("presenter grants", true, true, false, false, false, true),
        ("guest denied", false, true, false, false, false, false),
        ("pending denied", true, false, false, false, false, false),
        ("stale actor", true, true, true, false, false, false),
        ("stale target", true, true, false, true, false, false),
        ("configured demotion", true, true, false, false, true, false),
    ] {
        let now = Instant::now();
        let mut registry = registry(now);
        let actor = begin(&mut registry, now, "actor", actor_presenter, "guest");
        let target = begin(
            &mut registry,
            now,
            "target",
            pinned,
            if pinned { "configured" } else { "guest" },
        );
        if actor_admitted {
            admit(&mut registry, now, "actor", actor);
        }
        admit(&mut registry, now, "target", target);
        let result = registry.apply(
            transfer(
                "actor",
                actor + u64::from(stale_actor),
                "target",
                target + u64::from(stale_target),
                !pinned,
            ),
            None,
            now,
        );
        assert_eq!(result.is_ok(), expected, "{name}");
        assert_eq!(
            registry
                .apply(role("target", target), None, now)
                .expect(name)
                .presenter,
            Some(pinned || expected),
            "{name}"
        );
    }
}

/// Host departure never grants presenter authority to remaining guests or waiting identities.
#[test]
fn leave_preserves_guest_roles() {
    let now = Instant::now();
    let mut registry = registry(now);
    let actor = begin(&mut registry, now, "actor", true, "guest");
    admit(&mut registry, now, "actor", actor);
    let waiting = begin(&mut registry, now, "waiting", false, "guest");
    registry
        .apply(
            Command::Phase {
                room_id: "room".into(),
                room_instance_id: "native".into(),
                peer_id: "waiting".into(),
                epoch: waiting,
                phase: AdmissionPhase::Lobby,
            },
            None,
            now,
        )
        .expect("lobby");
    let next = begin(&mut registry, now, "next", false, "guest");
    admit(&mut registry, now, "next", next);
    registry
        .apply(
            Command::Leave {
                room_id: "room".into(),
                room_instance_id: "native".into(),
                peer_id: "actor".into(),
                epoch: actor,
            },
            None,
            now,
        )
        .expect("leave");
    assert_eq!(
        registry
            .apply(role("waiting", waiting), None, now)
            .expect("waiting role")
            .presenter,
        Some(false)
    );
    assert_eq!(
        registry
            .apply(role("next", next), None, now)
            .expect("next role")
            .presenter,
        Some(false)
    );
    let replacement = begin(&mut registry, now, "next", false, "guest");
    assert!(registry.apply(role("next", next), None, now).is_err());
    assert_eq!(
        registry
            .apply(role("next", replacement), None, now)
            .expect("replacement role")
            .presenter,
        Some(false)
    );
}
