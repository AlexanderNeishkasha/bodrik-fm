//! Presenter ban list: named entries, opaque unban identifiers and presenter-only access.

use super::gates::{Action, Gates};
use crate::{membership::Phase, room::Actor};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Synthetic admitted actor with the given role.
fn actor(presenter: bool) -> Actor {
    Actor {
        member: true,
        lobby: false,
        presenter,
    }
}

/// Ban one device under a display name as the presenter.
fn ban(gates: &mut Gates, uuid: &str, name: &str, now: Instant) {
    let action = Action::Ban {
        uuid: uuid.into(),
        name: name.into(),
    };
    assert_eq!(
        gates.apply(actor(true), Phase::Admitted, "host", action, now),
        Ok(true)
    );
}

/// The list carries names and remaining time but never the device identifier.
#[test]
fn ban_list_names_entries_without_device_ids() {
    let now = Instant::now();
    let mut gates = Gates::default();
    ban(&mut gates, "device-a", "Alice", now);
    ban(&mut gates, "device-b", "Bob", now + Duration::from_secs(10));
    let list = gates.ban_list(now + Duration::from_secs(10));
    assert_eq!(
        list.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
        ["Bob", "Alice"]
    );
    assert_eq!(list[0].expires_in, 86400);
    assert_eq!(list[1].expires_in, 86390);
    let json = serde_json::to_string(&list).expect("serialize");
    assert!(
        !json.contains("device-"),
        "device identifiers must stay private: {json}"
    );
}

/// Names are bounded and a repeated ban keeps the original entry.
#[test]
fn ban_names_are_bounded_and_duplicates_keep_first_entry() {
    let now = Instant::now();
    let mut gates = Gates::default();
    ban(&mut gates, "device", &"x".repeat(100), now);
    let first = gates.ban_list(now)[0].clone();
    ban(
        &mut gates,
        "device",
        "Renamed",
        now + Duration::from_secs(5),
    );
    let list = gates.ban_list(now);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, first.id);
    assert_eq!(list[0].name.chars().count(), 64);
}

/// Unban lifts exactly the matching entry; unknown identifiers are a confirmed no-op.
#[test]
fn unban_by_opaque_identifier() {
    let now = Instant::now();
    for (name, known, expected, remaining) in [
        ("known identifier lifts the ban", true, true, 0),
        ("unknown identifier changes nothing", false, false, 1),
    ] {
        let mut gates = Gates::default();
        ban(&mut gates, "device", "Alice", now);
        let id = if known {
            gates.ban_list(now)[0].id
        } else {
            Uuid::new_v4()
        };
        let result = gates.apply(
            actor(true),
            Phase::Admitted,
            "host",
            Action::Unban { id },
            now,
        );
        assert_eq!(result, Ok(expected), "{name}");
        assert_eq!(gates.ban_list(now).len(), remaining, "{name}");
        assert_eq!(gates.banned("device"), remaining == 1, "{name}");
    }
}

/// Only presenters may read or change the ban list.
#[test]
fn ban_list_actions_require_presenter() {
    let now = Instant::now();
    for (name, action) in [
        ("read", Action::Bans),
        ("unban", Action::Unban { id: Uuid::new_v4() }),
    ] {
        let mut gates = Gates::default();
        assert_eq!(
            gates.apply(actor(false), Phase::Admitted, "guest", action, now),
            Err("runtime denied"),
            "{name}"
        );
    }
}
