//! Admission races preserve single-shot identity binding and verified presenter ownership.

use super::{
    commands::Command,
    gate_tests::{begin, control, gate, grant},
    gates::Action,
    state::Registry,
};
use crate::room::Moderator;
use std::time::Instant;

/// Build one room through production transitions without automatic guest promotion.
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
                presenter_names: Vec::new(),
                moderator: Moderator::default(),
                global_lobby: false,
            },
            Some(grant()),
            now,
        )
        .expect("commit");
    registry
}

/// A host leaving during a pending join cannot promote the joining guest.
#[test]
fn presenter_leaves_during_pending_join() {
    let now = Instant::now();
    let mut registry = registry(now);
    let host = begin(&mut registry, now, "host", true);
    registry
        .apply(gate("host", host, "host-device"), None, now)
        .expect("host gate");
    let pending = begin(&mut registry, now, "pending", false);
    registry
        .apply(
            Command::Leave {
                room_id: "room".into(),
                room_instance_id: "native".into(),
                peer_id: "host".into(),
                epoch: host,
            },
            None,
            now,
        )
        .expect("leave");
    let reply = registry
        .apply(gate("pending", pending, "pending-device"), None, now)
        .expect("pending gate");
    assert_eq!(reply.phase, Some("admitted"));
    assert_eq!(reply.presenter, Some(false));
}

/// A denied candidate cannot rerun its gate with a different device identifier on the same admission epoch.
#[test]
fn rejected_gate_is_single_shot() {
    let now = Instant::now();
    let mut registry = registry(now);
    let host = begin(&mut registry, now, "host", true);
    registry
        .apply(gate("host", host, "host-device"), None, now)
        .expect("host gate");
    registry
        .apply(
            control(
                "host",
                host,
                Action::Ban {
                    name: String::new(),
                    uuid: "banned-device".into(),
                },
            ),
            None,
            now,
        )
        .expect("ban");
    let guest = begin(&mut registry, now, "guest", false);
    assert_eq!(
        registry
            .apply(gate("guest", guest, "banned-device"), None, now)
            .expect("denial")
            .phase,
        Some("banned")
    );
    assert!(
        registry
            .apply(gate("guest", guest, "other-device"), None, now)
            .is_err()
    );
}
