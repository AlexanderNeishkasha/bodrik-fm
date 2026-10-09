//! Producer mute-state relay and inventory projection with the domain recipient boundary.
use super::*;
use crate::replacement::producer_state;

/// Exact stamp for one fixture session.
fn stamp(session_id: &str) -> SessionStamp {
    SessionStamp {
        room_instance_id: "instance".into(),
        session_id: session_id.into(),
        admission_epoch: 1,
    }
}

/// Pause/resume changes reach other exact-room members only, never the actor itself.
#[tokio::test]
async fn paused_change_relays_to_other_members_only() {
    for paused in [true, false] {
        let (service, mut receivers, _) = fixture(false, false);
        let sender = stamp("sender");
        producer_state::paused_changed(&service, &sender, "producer", paused)
            .await
            .expect("relayed");
        assert!(receivers[0].try_recv().is_err(), "actor receives no echo");
        let event = receivers[1].try_recv().expect("receiver event");
        assert_eq!(event["kind"], "producerState");
        assert_eq!(event["value"]["producerId"], "producer");
        assert_eq!(event["value"]["paused"], paused);
        assert_eq!(event["value"]["participant"], json!(sender));
    }
}

/// Malformed identifiers and stale actors publish nothing.
#[tokio::test]
async fn paused_change_rejects_invalid_or_stale_actors() {
    for (name, actor, producer, expected) in [
        ("malformed producer id", stamp("sender"), "", "invalid"),
        ("unknown session", stamp("missing"), "producer", "stale"),
    ] {
        let (service, mut receivers, _) = fixture(false, false);
        let error = producer_state::paused_changed(&service, &actor, producer, true)
            .await
            .expect_err(name);
        assert_eq!(error, expected, "{name}");
        assert!(
            receivers
                .iter_mut()
                .all(|receiver| receiver.try_recv().is_err()),
            "{name}"
        );
    }
}

/// Late-joiner inventory carries a strict boolean paused flag; absence means active.
#[test]
fn inventory_projects_strict_paused_flag() {
    for (name, paused, expected) in [
        ("paused", Some(json!(true)), Ok(json!(true))),
        ("active", Some(json!(false)), Ok(json!(false))),
        ("absent from older worker", None, Ok(json!(false))),
        ("non-boolean", Some(json!("yes")), Err("unknown_outcome")),
    ] {
        let (service, _receivers, _) = fixture(false, false);
        let owner = service
            .store
            .lock()
            .expect("store")
            .sessions
            .get("receiver")
            .expect("receiver")
            .binding
            .clone();
        let mut source = json!({"id":"mic","kind":"audio","mediaType":"audioType","binding":owner});
        if let Some(value) = paused {
            source["paused"] = value;
        }
        let projected =
            producer_state::producers(&service, &stamp("sender"), json!({"sources":[source]}));
        match expected {
            Ok(flag) => assert_eq!(projected.expect(name)[0]["paused"], flag, "{name}"),
            Err(error) => assert_eq!(projected.expect_err(name), error, "{name}"),
        }
    }
}
