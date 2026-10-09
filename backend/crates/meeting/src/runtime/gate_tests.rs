//! Active gate/control tables exercise Rust ownership, exact participant fences and safe projections.

use super::{
    commands::{Capability, Command},
    gates::Action,
    state::Registry,
};
use crate::{integration::Grant, room::Moderator};
use std::time::Instant;

/// Current synthetic player grant used only after independently verified admission.
pub(super) fn grant() -> Grant {
    Grant {
        version: 1,
        conference_id: "room".into(),
        generation: 7,
        room_slug: "slug".into(),
        lease_seconds: 15,
    }
}

/// Create a native incarnation and one admitted presenter through the actual gate path.
pub(super) fn fixture(now: Instant) -> (Registry, u64) {
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
                presenter_names: Vec::new(),
                moderator: Moderator::default(),
                global_lobby: false,
            },
            Some(grant()),
            now,
        )
        .expect("commit");
    let host = begin(&mut registry, now, "host", true);
    assert_eq!(
        registry
            .apply(gate("host", host, "host-device"), None, now)
            .expect("host gate")
            .phase,
        Some("admitted")
    );
    (registry, host)
}

/// Begin one verified identity without importing browser role flags.
pub(super) fn begin(registry: &mut Registry, now: Instant, id: &str, presenter: bool) -> u64 {
    registry
        .apply(
            Command::Begin {
                room_id: "room".into(),
                room_instance_id: "native".into(),
                peer_id: id.into(),

                presenter,
                username: "verified".into(),
            },
            Some(grant()),
            now,
        )
        .expect("begin")
        .epoch
        .expect("epoch")
}

/// Bind the initial legacy device identifier and evaluate current Rust gates.
pub(super) fn gate(id: &str, epoch: u64, uuid: &str) -> Command {
    Command::Gate {
        room_id: "room".into(),
        room_instance_id: "native".into(),
        peer_id: id.into(),
        epoch,
        uuid: uuid.into(),
    }
}

/// Build a current actor-fenced private control.
pub(super) fn control(id: &str, epoch: u64, action: Action) -> Command {
    Command::Control {
        room_id: "room".into(),
        room_instance_id: "native".into(),
        peer_id: id.into(),
        epoch,
        action,
    }
}

/// Query normal recipient rights rather than treating phase/projection flags as authorization.
fn members(id: &str, epoch: u64) -> Command {
    Command::Members {
        room_id: "room".into(),
        room_instance_id: "native".into(),
        peer_id: id.into(),
        epoch,
        pending: false,
    }
}

/// All initial gate outcomes and presenter exceptions are selected by the Rust owner.
#[test]
fn initial_gate_cases() {
    for (name, action, presenter, expected) in [
        ("open guest", Action::Read, false, "admitted"),
        (
            "password guest",
            Action::Lock {
                password: "private-password".into(),
            },
            false,
            "password",
        ),
        (
            "password presenter",
            Action::Lock {
                password: "private-password".into(),
            },
            true,
            "admitted",
        ),
        (
            "lobby guest",
            Action::Lobby { status: true },
            false,
            "lobby",
        ),
        (
            "join locked guest",
            Action::JoinLock { status: true },
            false,
            "joinLocked",
        ),
        (
            "banned guest",
            Action::Ban {
                name: String::new(),
                uuid: "device".into(),
            },
            false,
            "banned",
        ),
        (
            "banned presenter",
            Action::Ban {
                name: String::new(),
                uuid: "device".into(),
            },
            true,
            "banned",
        ),
    ] {
        let now = Instant::now();
        let (mut registry, host) = fixture(now);
        registry
            .apply(control("host", host, action), None, now)
            .expect(name);
        let guest = begin(&mut registry, now, "guest", presenter);
        let reply = registry
            .apply(gate("guest", guest, "device"), None, now)
            .expect(name);
        assert_eq!(reply.phase, Some(expected), "{name}");
        assert_eq!(
            registry.apply(members("guest", guest), None, now).is_ok(),
            expected == "admitted",
            "{name}"
        );
    }
}

/// Password confirmation atomically rechecks current gates and never returns its private material.
#[test]
fn password_completion_cases() {
    for (name, password, block, accepted) in [
        ("correct", "private-password", None, true),
        ("wrong", "wrong", None, false),
        (
            "join lock changed",
            "private-password",
            Some(Action::JoinLock { status: true }),
            false,
        ),
        (
            "lobby changed",
            "private-password",
            Some(Action::Lobby { status: true }),
            false,
        ),
        (
            "device banned",
            "private-password",
            Some(Action::Ban {
                name: String::new(),
                uuid: "device".into(),
            }),
            false,
        ),
    ] {
        let now = Instant::now();
        let (mut registry, host) = fixture(now);
        registry
            .apply(
                control(
                    "host",
                    host,
                    Action::Lock {
                        password: "private-password".into(),
                    },
                ),
                None,
                now,
            )
            .expect("lock");
        let guest = begin(&mut registry, now, "guest", false);
        registry
            .apply(gate("guest", guest, "device"), None, now)
            .expect("guest gate");
        if let Some(block) = block {
            registry
                .apply(control("host", host, block), None, now)
                .expect("change gates");
        }
        let reply = registry
            .apply(
                control(
                    "guest",
                    guest,
                    Action::Password {
                        password: password.into(),
                    },
                ),
                None,
                now,
            )
            .expect(name);
        assert_eq!(reply.accepted, Some(accepted), "{name}");
        assert_eq!(
            registry.apply(members("guest", guest), None, now).is_ok(),
            accepted,
            "{name}"
        );
        assert!(
            !serde_json::to_string(&reply)
                .expect("serialize")
                .contains("private-password")
        );
    }
}

/// Lobby approval rejects unadmitted/guest/stale actors and stale target incarnations.
#[test]
fn approval_fencing_cases() {
    for (name, actor_is_host, old_actor, old_target, accepted) in [
        ("current presenter", true, false, false, true),
        ("waiting guest", false, false, false, false),
        ("old presenter", true, true, false, false),
        ("old target", true, false, true, false),
    ] {
        let now = Instant::now();
        let (mut registry, host) = fixture(now);
        registry
            .apply(
                control("host", host, Action::Lobby { status: true }),
                None,
                now,
            )
            .expect("lobby");
        let guest = begin(&mut registry, now, "guest", false);
        registry
            .apply(gate("guest", guest, "device"), None, now)
            .expect("waiting");
        let result = registry.apply(
            Command::Approve {
                room_id: "room".into(),
                room_instance_id: "native".into(),
                peer_id: if actor_is_host { "host" } else { "guest" }.into(),
                epoch: if actor_is_host { host } else { guest } + u64::from(old_actor),
                target_id: "guest".into(),
                target_epoch: guest + u64::from(old_target),
            },
            None,
            now,
        );
        assert_eq!(result.is_ok(), accepted, "{name}");
        assert_eq!(
            registry.apply(members("guest", guest), None, now).is_ok(),
            accepted,
            "{name}"
        );
    }
}

/// Banning an existing admitted session immediately removes send, receive and media rights.
#[test]
fn ban_removes_current_participant_rights() {
    let now = Instant::now();
    let (mut registry, host) = fixture(now);
    let guest = begin(&mut registry, now, "guest", false);
    registry
        .apply(gate("guest", guest, "device"), None, now)
        .expect("admit");
    registry
        .apply(
            control(
                "host",
                host,
                Action::Ban {
                    name: String::new(),
                    uuid: "device".into(),
                },
            ),
            None,
            now,
        )
        .expect("ban");
    assert!(registry.apply(members("guest", guest), None, now).is_err());
    assert_eq!(
        registry
            .apply(members("host", host), None, now)
            .expect("recipients")
            .members,
        Some(vec!["host".into()])
    );
    for capability in [
        Capability::Audio,
        Capability::PublicChat,
        Capability::PrivateChat,
    ] {
        assert_eq!(
            registry
                .apply(
                    Command::Authorize {
                        room_id: "room".into(),
                        room_instance_id: "native".into(),
                        peer_id: "guest".into(),
                        epoch: guest,
                        capability
                    },
                    None,
                    now
                )
                .expect("permission")
                .allowed,
            Some(false)
        );
    }
}

/// A ban applied through the registry appears in the presenter's ban list read.
#[test]
fn registry_ban_is_listed_for_presenter() {
    let now = Instant::now();
    let (mut registry, host) = fixture(now);
    let guest = begin(&mut registry, now, "guest", false);
    registry
        .apply(gate("guest", guest, "device"), None, now)
        .expect("admit");
    let ban = Action::Ban {
        name: "Eve".into(),
        uuid: "device".into(),
    };
    registry
        .apply(control("host", host, ban), None, now)
        .expect("ban");
    let reply = registry
        .apply(control("host", host, Action::Bans), None, now)
        .expect("bans");
    let names: Vec<String> = reply
        .bans
        .expect("list")
        .into_iter()
        .map(|row| row.name)
        .collect();
    assert_eq!(names, ["Eve"]);
}

/// Gate a second session of an actor already in the room (e.g. after a refresh).
fn rejoin(registry: &mut Registry, now: Instant, id: &str, device: &str) -> super::Reply {
    let epoch = begin(registry, now, id, false);
    registry
        .apply(gate(id, epoch, device), None, now)
        .expect("gate")
}

/// A rejoining actor takes over: it inherits the presenter role and skips gates it passed.
#[test]
fn same_actor_rejoin_takes_over() {
    let now = Instant::now();
    for (name, device, lobby, phase, presenter) in [
        (
            "presenter refresh keeps the role",
            "host-device",
            false,
            "admitted",
            true,
        ),
        (
            "presenter refresh skips an enabled lobby",
            "host-device",
            true,
            "admitted",
            true,
        ),
        (
            "a different actor is not promoted",
            "other-device",
            false,
            "admitted",
            false,
        ),
        (
            "a different actor still waits in the lobby",
            "other-device",
            true,
            "lobby",
            false,
        ),
    ] {
        let (mut registry, host) = fixture(now);
        if lobby {
            registry
                .apply(
                    control("host", host, Action::Lobby { status: true }),
                    None,
                    now,
                )
                .expect("lobby");
        }
        let reply = rejoin(&mut registry, now, "second", device);
        assert_eq!(reply.phase, Some(phase), "{name}");
        assert_eq!(reply.presenter, Some(presenter), "{name}");
    }
}

/// A banned actor never takes over its earlier session.
#[test]
fn banned_actor_cannot_take_over() {
    let now = Instant::now();
    let (mut registry, host) = fixture(now);
    let guest = begin(&mut registry, now, "guest", false);
    registry
        .apply(gate("guest", guest, "device"), None, now)
        .expect("admit");
    let ban = Action::Ban {
        name: String::new(),
        uuid: "device".into(),
    };
    registry
        .apply(control("host", host, ban), None, now)
        .expect("ban");
    assert_eq!(
        rejoin(&mut registry, now, "again", "device").phase,
        Some("banned")
    );
}
