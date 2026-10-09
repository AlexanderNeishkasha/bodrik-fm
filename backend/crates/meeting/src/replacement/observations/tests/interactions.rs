//! Chat and participant interaction delivery boundaries.
use super::*;

/// Public/private chat and reactions use current runtime recipients and revisioned events.
#[tokio::test]
async fn chat_recipient_and_policy_cases() {
    let (service, mut receivers, binding) = fixture(false, false);
    let sender = SessionStamp {
        room_instance_id: "instance".into(),
        session_id: "sender".into(),
        admission_epoch: 1,
    };
    crate::replacement::chat::message(
        &service,
        &sender,
        Target::Public,
        "message-one".into(),
        "hello".into(),
    )
    .await
    .expect("public chat");
    let public = receivers[1].try_recv().expect("public recipient");
    assert_eq!(public["kind"], "chatMessage");
    assert_eq!(public["value"]["text"], "hello");
    assert_eq!(public["revision"], 1);

    crate::replacement::chat::message(
        &service,
        &sender,
        Target::Private {
            stamp: SessionStamp {
                room_instance_id: "instance".into(),
                session_id: "receiver".into(),
                admission_epoch: 1,
            },
        },
        "message-two".into(),
        "private".into(),
    )
    .await
    .expect("private chat");
    assert_eq!(
        receivers[1].try_recv().expect("private recipient")["revision"],
        2
    );

    crate::replacement::chat::reaction(
        &service,
        &sender,
        "message-one".into(),
        "👍".into(),
        ReactionAction::Add,
    )
    .await
    .expect("reaction");
    assert_eq!(
        receivers[1].try_recv().expect("reaction recipient")["kind"],
        "chatReaction"
    );

    service
        .runtime
        .apply_verified(
            Command::Moderator {
                room_id: binding.room_id,
                room_instance_id: binding.room_instance_id,
                peer_id: binding.peer_id,
                epoch: binding.admission_epoch,
                change: Some(ModeratorChange::One {
                    field: ModeratorField::ChatCantPublicly,
                    status: true,
                }),
            },
            None,
        )
        .expect("block public chat");
    assert!(
        crate::replacement::chat::message(
            &service,
            &sender,
            Target::Public,
            "message-three".into(),
            "blocked".into(),
        )
        .await
        .is_err()
    );
}

/// Profile, count and Follow Me events use server-owned identity and authority.
#[tokio::test]
async fn participant_action_cases() {
    let (service, mut receivers, _) = fixture(false, false);
    let sender = SessionStamp {
        room_instance_id: "instance".into(),
        session_id: "sender".into(),
        admission_epoch: 1,
    };
    let receiver = SessionStamp {
        room_instance_id: "instance".into(),
        session_id: "receiver".into(),
        admission_epoch: 1,
    };
    crate::replacement::participant::joined(&service, &sender)
        .await
        .expect("joined");
    let joined = receivers[1].try_recv().expect("joined recipient");
    assert_eq!(joined["kind"], "participantJoined");
    assert_eq!(joined["value"]["participant"], json!(sender));
    crate::replacement::producer_state::producer_created(
        &service,
        &sender,
        &json!({"producerId":"producer"}),
        crate::media::protocol::MediaKind::Audio,
        crate::media::protocol::MediaType::Audio,
    )
    .await
    .expect("producer created");
    let producer = receivers[1].try_recv().expect("producer recipient");
    assert_eq!(producer["kind"], "producerCreated");
    assert_eq!(producer["value"]["producerId"], "producer");
    crate::replacement::participant::music_stopped(&service, "conference", "music-producer");
    for receiver in &mut receivers {
        let stopped = receiver.try_recv().expect("music stopped recipient");
        assert_eq!(stopped["kind"], "producerClosed");
        assert_eq!(stopped["value"]["resourceId"], "music-producer");
    }
    crate::replacement::participant::profile(
        &service,
        &sender,
        ProfileChange::Name {
            value: "New name".into(),
        },
    )
    .await
    .expect("profile");
    assert_eq!(
        receivers[0].try_recv().expect("sender profile")["kind"],
        "participantProfile"
    );
    assert_eq!(
        receivers[1].try_recv().expect("receiver profile")["value"]["value"],
        "New name"
    );
    assert_eq!(
        crate::replacement::participant::count(&service, &sender, false)
            .await
            .expect("count")["count"],
        2
    );
    crate::replacement::participant::follow(
        &service,
        &sender,
        FollowAction::Pin {
            target: receiver.clone(),
        },
    )
    .await
    .expect("follow");
    assert_eq!(
        receivers[1].try_recv().expect("follow recipient")["kind"],
        "followMe"
    );
    let snapshot = crate::replacement::session::snapshot(&service, &sender).expect("snapshot");
    assert_eq!(snapshot["count"], 2);
    let sender_peer = snapshot["peers"]
        .as_array()
        .expect("peers")
        .iter()
        .find(|peer| peer["stamp"]["sessionId"] == "sender")
        .expect("sender peer");
    assert_eq!(sender_peer["name"], "New name");
    assert_eq!(snapshot["followMe"]["action"], "pin");
    assert_eq!(snapshot["followMe"]["target"], json!(receiver));
    assert!(
        crate::replacement::participant::follow(
            &service,
            &receiver,
            FollowAction::Toggle { enabled: true },
        )
        .await
        .is_err()
    );
}

/// Pending and stale private targets receive no chat event.
#[tokio::test]
async fn chat_rejects_pending_and_stale_targets() {
    let (service, mut receivers, _) = fixture(true, false);
    let sender = SessionStamp {
        room_instance_id: "instance".into(),
        session_id: "sender".into(),
        admission_epoch: 1,
    };
    crate::replacement::chat::message(
        &service,
        &sender,
        Target::Public,
        "message-one".into(),
        "hello".into(),
    )
    .await
    .expect("public accepted without recipients");
    assert!(receivers[1].try_recv().is_err());
    assert!(
        crate::replacement::chat::message(
            &service,
            &sender,
            Target::Private {
                stamp: SessionStamp {
                    room_instance_id: "instance".into(),
                    session_id: "receiver".into(),
                    admission_epoch: 1,
                },
            },
            "message-two".into(),
            "denied".into(),
        )
        .await
        .is_err()
    );
}
