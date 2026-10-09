//! Direct stream discontinuity/drain acceptance with synthetic native resources.
use super::*;
use tokio::sync::mpsc;

/// A ready baseline followed by loss/death/malformed payload retires resources, not just socket state.
#[tokio::test]
async fn continuity_failure_cases() {
    for (name, tail) in [
        (
            "sequence gap",
            json!({"bootId":"native-boot","sequence":2,"type":"producerClosed","payload":{}}),
        ),
        (
            "native death",
            json!({"bootId":"native-boot","sequence":1,"type":"workerDied","payload":{}}),
        ),
        (
            "malformed close",
            json!({"bootId":"native-boot","sequence":1,"type":"consumerClosed","payload":{"resourceId":"one"}}),
        ),
    ] {
        let (mut service, _, _) = fixture(false, false);
        let (closed, mut closed_receiver) = mpsc::channel(4);
        Arc::get_mut(&mut service.config)
            .expect("isolated config")
            .media = crate::native_media::fixture::Fixture {
            events: vec![serde_json::from_value(tail).expect("event fixture")],
            closed,
        }
        .into();
        let mut stream = service
            .config
            .media
            .events("native-boot")
            .await
            .expect("subscribe");
        stream.next_event().await.expect("ready");
        let (stop, receiver) = watch::channel(false);
        let owner = service.clone();
        let supervisor = tokio::spawn(async move {
            supervise(owner, stream, receiver).await;
        });
        let close = tokio::time::timeout(Duration::from_secs(3), closed_receiver.recv())
            .await
            .expect(name)
            .expect("native close");
        assert_eq!(close.binding.room_instance_id, "instance", "{name}");
        assert!(!available(&service), "{name}");
        assert!(
            service.store.lock().expect("store").sessions.is_empty(),
            "{name}"
        );
        assert!(
            service.store.lock().expect("store").rooms.is_empty(),
            "{name}"
        );
        stop.send_replace(true);
        tokio::time::timeout(Duration::from_secs(3), supervisor)
            .await
            .expect("supervisor stops")
            .expect("task");
    }
}
