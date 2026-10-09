//! A retired room event cannot revoke independent rooms; genuine continuity failures still propagate.
use super::*;

/// Native close/speaker events from a room whose authority retired are ignored locally.
#[test]
fn named_retired_room_events_preserve_other_authority() {
    for kind in [
        "producerClosed",
        "consumerClosed",
        "transportClosed",
        "audioVolume",
        "dominantSpeaker",
    ] {
        let (service, _receivers, binding) = fixture(false, false);
        let grant = Grant {
            version: 1,
            conference_id: "healthy".into(),
            generation: 3,
            room_slug: "healthy-room".into(),
            lease_seconds: 15,
        };
        let reservation = service
            .runtime
            .apply_verified(
                Command::Reserve {
                    room_id: "healthy".into(),
                },
                Some(grant.clone()),
            )
            .expect("reserve")
            .epoch
            .expect("epoch");
        service
            .runtime
            .apply_verified(
                Command::Commit {
                    room_id: "healthy".into(),
                    epoch: reservation,
                    room_instance_id: "healthy-instance".into(),
                    presenter_names: vec![],
                    moderator: Default::default(),
                    global_lobby: false,
                },
                Some(grant),
            )
            .expect("commit");
        let original = service.store.lock().expect("store").rooms["conference"].clone();
        service
            .runtime
            .apply_verified(
                Command::Abort {
                    room_id: "conference".into(),
                    epoch: original.reservation,
                },
                None,
            )
            .expect("retire authority");
        let payload = match kind {
            "audioVolume" => json!({"binding":binding,"level":5}),
            "dominantSpeaker" => json!({"binding":binding}),
            _ => json!({"binding":binding,"resourceId":"resource"}),
        };
        let event = Event {
            boot_id: "native-boot".into(),
            sequence: 1,
            kind: kind.into(),
            payload,
        };
        assert!(deliver(&service, event).expect(kind).is_empty(), "{kind}");
        assert!(
            service
                .runtime
                .room_current("healthy", "healthy-instance")
                .expect("healthy"),
            "{kind}"
        );
        assert!(available(&service), "{kind}");
    }
}
