//! Native burst, cancellation and queued deadline contracts.
use super::*;
use crate::media::protocol::{Command, Empty, ErrorCode};
use crate::native_media::tests::binding;

/// Saturated native work waits; cancellation releases queue slots and expired work never starts.
#[tokio::test]
async fn named_native_queue_cases() {
    let engine = Engine::start(Network::parse("127.0.0.1", "", "45100", "45200").expect("network"))
        .await
        .expect("engine");
    let binding = Binding {
        room_id: "queue-room".into(),
        room_instance_id: "instance".into(),
        peer_id: "peer".into(),
        admission_epoch: 1,
    };
    for (name, expired, cancel, queue_full) in [
        ("ninth operation waits", false, false, false),
        ("queued deadline expires", true, false, false),
        ("cancelled waiter releases budget", false, true, false),
        ("full queue rejects", false, false, true),
    ] {
        let held = engine
            .core
            .requests
            .clone()
            .acquire_many_owned(8)
            .await
            .expect("slots");
        let full = if queue_full {
            Some(
                engine
                    .core
                    .pending
                    .clone()
                    .acquire_many_owned(128)
                    .await
                    .expect("queue"),
            )
        } else {
            None
        };
        let mut command = Command::new(
            &engine.core.boot,
            &binding,
            Operation::Inventory(Empty::default()),
        );
        if expired {
            command.deadline = std::time::Instant::now() + std::time::Duration::from_millis(10);
        }
        let owner = engine.clone();
        let task = tokio::spawn(async move { owner.execute(&command).await });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        if !queue_full {
            assert!(!task.is_finished(), "{name}");
        }
        if cancel {
            task.abort();
            let _ = task.await;
        } else {
            drop(held);
            let error = task
                .await
                .expect("join")
                .err()
                .expect("missing room or expired");
            assert!(
                matches!(error, MediaError::Busy) == queue_full,
                "{name}: {error}"
            );
            if expired {
                assert!(
                    matches!(error, MediaError::Rejected(ErrorCode::RequestExpired)),
                    "{name}"
                );
            }
        }
        drop(full);
        assert_eq!(engine.core.pending.available_permits(), 128, "{name}");
    }
    engine.shutdown().expect("shutdown");
}

/// Cancelling a requesting socket cannot strand completed native allocations or close replacements.
#[tokio::test]
async fn cancelled_owned_command_cleanup() {
    let engine = Engine::start(Network::parse("127.0.0.1", "", "44100", "44200").expect("network"))
        .await
        .expect("worker");
    let b = binding(1);
    engine.create_room(&b).await.expect("room");
    engine.create_peer(&b).expect("peer");
    let action = Operation::CreateTransport(Empty::default());
    let mut request = Box::pin(engine.owned(
        &b,
        &action,
        std::time::Instant::now() + std::time::Duration::from_secs(30),
    ));
    assert!(futures_util::poll!(request.as_mut()).is_pending());
    drop(request);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while engine.current(&b).is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cancelled allocation retires exact owner");
    let newer = binding(2);
    engine.create_peer(&newer).expect("new peer");
    let mut request = Box::pin(engine.owned(
        &newer,
        &action,
        std::time::Instant::now() + std::time::Duration::from_secs(30),
    ));
    assert!(futures_util::poll!(request.as_mut()).is_pending());
    drop(request);
    engine.close_peer(&newer).expect("retire requester");
    let replacement = binding(3);
    engine.create_peer(&replacement).expect("replacement");
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !engine.core.jobs.lock().expect("jobs").is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owned work finishes");
    assert!(
        engine.current(&replacement).is_ok(),
        "cancelled old job cannot retire replacement"
    );
    let conflict = Operation::CreateRoom(Empty::default());
    let mut request = Box::pin(engine.owned(
        &replacement,
        &conflict,
        std::time::Instant::now() + std::time::Duration::from_secs(30),
    ));
    assert!(futures_util::poll!(request.as_mut()).is_pending());
    drop(request);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !engine.core.jobs.lock().expect("jobs").is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("failed owned work finishes");
    assert!(
        engine.current(&replacement).is_ok(),
        "failed allocation preserves existing room"
    );
    let old = engine
        .create_music(&replacement, 1234)
        .await
        .expect("old music");
    engine.close_music(&replacement).expect("replace music");
    let new = engine
        .create_music(&replacement, 1235)
        .await
        .expect("new music");
    engine
        .close_music_matching(&replacement, Some(old.producer_id.as_str()))
        .expect("late cleanup");
    let state = engine.core.state.lock().expect("state");
    assert_eq!(
        state
            .room(&replacement)
            .expect("room")
            .music
            .as_ref()
            .expect("music")
            .1
            .id()
            .to_string(),
        new.producer_id.as_str()
    );
    drop(state);
    engine.close_room(&replacement).expect("drain");
}
