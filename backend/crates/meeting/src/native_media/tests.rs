//! Real native worker and ownership boundary tests.
mod consumer_visibility;
mod traffic;
use super::*;
use crate::media::protocol::{Binding, Empty, Operation};

/// Synthetic server-issued media owner, independent of browser credentials.
pub(super) fn binding(epoch: u64) -> Binding {
    Binding {
        room_id: "native-test".into(),
        room_instance_id: "incarnation".into(),
        peer_id: "participant".into(),
        admission_epoch: epoch,
    }
}

/// Real capabilities, stereo music, stale epochs and explicit cleanup.
#[tokio::test]
async fn native_lifecycle() {
    let engine = Engine::start(Network::parse("127.0.0.1", "", "43000", "43100").expect("network"))
        .await
        .expect("worker");
    let b = binding(1);
    engine
        .operation(&b, &Operation::CreateRoom(Empty::default()))
        .await
        .expect("room")
        .into_json();
    engine
        .operation(&b, &Operation::CreatePeer(Empty::default()))
        .await
        .expect("peer")
        .into_json();
    let caps = engine
        .operation(&b, &Operation::Capabilities(Empty::default()))
        .await
        .expect("capabilities")
        .into_json();
    assert!(
        caps["codecs"]
            .as_array()
            .expect("codecs")
            .iter()
            .any(|codec| codec["mimeType"] == "audio/opus")
    );
    let transport = engine
        .operation(&b, &Operation::CreateTransport(Empty::default()))
        .await
        .expect("transport")
        .into_json();
    assert!(transport["iceCandidates"].is_array());
    let music = engine
        .operation(&b, &Operation::CreateMusic { ssrc: 42 })
        .await
        .expect("music")
        .into_json();
    assert!(music["port"].as_u64().is_some());
    engine.close_music(&b).expect("close music");
    engine.close_peer(&b).expect("close peer");
    assert!(
        engine.create_peer(&b).is_err(),
        "same epoch cannot resurrect"
    );
    engine.create_peer(&binding(2)).expect("new epoch");
    assert!(
        engine.current(&b).is_err(),
        "old owner cannot use replacement"
    );
    engine.close_room(&binding(2)).expect("retire room");
    assert!(
        engine.create_room(&binding(2)).await.is_err(),
        "retired incarnation cannot resurrect"
    );
    engine.shutdown().expect("drain");
}

/// Ownership checks, source categories, native consumption and ICE rotation use real handles.
#[tokio::test]
async fn participant_media_boundaries() {
    use crate::media::protocol::{
        Consumer as ConsumerRef, MediaKind, MediaType, Producer as ProducerRef, Transport,
    };
    use serde_json::json;
    let engine = Engine::start(Network::parse("127.0.0.1", "", "43500", "43600").expect("network"))
        .await
        .expect("worker");
    let sender = binding(1);
    engine.create_room(&sender).await.expect("room");
    engine.create_peer(&sender).expect("sender");
    let mut receiver = sender.clone();
    receiver.peer_id = "receiver".into();
    engine.create_peer(&receiver).expect("receiver");
    let sending = engine
        .operation(&sender, &Operation::CreateTransport(Empty::default()))
        .await
        .expect("send")
        .into_json();
    let receiving = engine
        .operation(&receiver, &Operation::CreateTransport(Empty::default()))
        .await
        .expect("receive")
        .into_json();
    let send_id = sending["id"].as_str().expect("send ID").to_owned();
    let receive_id = receiving["id"].as_str().expect("receive ID").to_owned();
    let caps = engine
        .operation(&sender, &Operation::Capabilities(Empty::default()))
        .await
        .expect("caps")
        .into_json();
    let opus = caps["codecs"]
        .as_array()
        .expect("codecs")
        .iter()
        .find(|c| c["mimeType"] == "audio/opus")
        .expect("opus");
    let rtp = json!({"codecs":[{"mimeType":"audio/opus","clockRate":48000,"channels":2,"payloadType":opus["preferredPayloadType"]}],
        "headerExtensions":[],"encodings":[{"ssrc":12345678}],"rtcp":{"cname":"test","reducedSize":true}});
    let produced = engine
        .operation(
            &sender,
            &Operation::Produce {
                transport_id: send_id.clone(),
                kind: MediaKind::Audio,
                media_type: MediaType::Audio,
                rtp_parameters: rtp.clone(),
            },
        )
        .await
        .expect("produce")
        .into_json();
    let producer_id = produced["producerId"]
        .as_str()
        .expect("producer ID")
        .to_owned();
    for (name, owner, action) in [
        (
            "foreign transport",
            &receiver,
            Operation::Produce {
                transport_id: send_id.clone(),
                kind: MediaKind::Audio,
                media_type: MediaType::Audio,
                rtp_parameters: rtp,
            },
        ),
        (
            "foreign producer",
            &receiver,
            Operation::PauseProducer(ProducerRef {
                producer_id: producer_id.clone(),
            }),
        ),
        (
            "wrong source category",
            &receiver,
            Operation::Consume {
                transport_id: receive_id.clone(),
                producer_id: producer_id.clone(),
                rtp_capabilities: caps.clone(),
                media_type: MediaType::Screen,
            },
        ),
    ] {
        assert!(engine.operation(owner, &action).await.is_err(), "{name}");
    }
    let consumed = engine
        .operation(
            &receiver,
            &Operation::Consume {
                transport_id: receive_id.clone(),
                producer_id: producer_id.clone(),
                rtp_capabilities: caps,
                media_type: MediaType::Audio,
            },
        )
        .await
        .expect("consume")
        .into_json();
    engine
        .operation(
            &receiver,
            &Operation::ResumeConsumer(ConsumerRef {
                consumer_id: consumed["id"].as_str().expect("consumer").into(),
            }),
        )
        .await
        .expect("resume")
        .into_json();
    consumer_visibility::check(&engine, &receiver, &sender, &consumed).await;
    engine
        .operation(
            &sender,
            &Operation::PauseProducer(ProducerRef {
                producer_id: producer_id.clone(),
            }),
        )
        .await
        .expect("pause")
        .into_json();
    let sources = engine
        .operation(&receiver, &Operation::Sources(Empty::default()))
        .await
        .expect("sources")
        .into_json();
    assert_eq!(sources["sources"][0]["paused"], true);
    let ice = engine
        .operation(
            &sender,
            &Operation::RestartIce(Transport {
                transport_id: send_id.clone(),
            }),
        )
        .await
        .expect("ICE restart")
        .into_json();
    assert_ne!(
        ice["usernameFragment"],
        sending["iceParameters"]["usernameFragment"]
    );
    engine
        .operation(
            &sender,
            &Operation::CloseTransport(Transport {
                transport_id: send_id,
            }),
        )
        .await
        .expect("close send")
        .into_json();
    let inventory = engine
        .operation(&receiver, &Operation::Inventory(Empty::default()))
        .await
        .expect("inventory")
        .into_json();
    assert_eq!(
        inventory["consumers"],
        json!([]),
        "producer descendants retire synchronously"
    );
    engine.close_room(&sender).expect("close room");
    assert!(engine.core.state.lock().expect("state").rooms.is_empty());
}

/// Cancellation releases reservations; replaced owners and orphan deadlines cannot resurrect.
#[tokio::test]
async fn allocation_and_orphan_boundaries() {
    let engine = Engine::start(Network::parse("127.0.0.1", "", "43700", "43800").expect("network"))
        .await
        .expect("worker");
    let b = binding(1);
    engine.create_room(&b).await.expect("room");
    engine.create_peer(&b).expect("peer");
    let mut pending = Vec::new();
    for _ in 0..32 {
        pending.push(engine.reserve(&b, |p| p.transports.len()).expect("reserve"));
    }
    assert!(
        engine.reserve(&b, |p| p.transports.len()).is_err(),
        "pending allocations count toward capacity"
    );
    drop(pending.pop());
    let cancelled = engine
        .reserve(&b, |p| p.transports.len())
        .expect("cancelled slot released");
    drop(cancelled);
    drop(pending);
    let old = engine
        .reserve(&b, |p| p.transports.len())
        .expect("old owner");
    engine.close_peer(&b).expect("retire old peer");
    let newer = binding(2);
    engine.create_peer(&newer).expect("new peer");
    drop(old);
    assert_eq!(
        engine
            .core
            .state
            .lock()
            .expect("state")
            .peer(&newer)
            .expect("peer")
            .pending,
        0
    );
    {
        let mut state = engine.core.state.lock().expect("state");
        state.peer_mut(&newer).expect("peer").deadline = std::time::Instant::now();
    }
    assert!(engine.renew(&newer).is_err(), "expired lease cannot renew");
    engine.core.expire();
    assert!(
        engine.current(&newer).is_err(),
        "orphan expiry releases owner"
    );
    engine.shutdown().expect("shutdown");
    assert!(
        engine.metadata().await.is_err(),
        "shutdown prevents readiness"
    );
}

/// Direct event loss is explicit and the baseline does not consume a real observation.
#[tokio::test]
async fn observation_continuity_boundaries() {
    let engine = Engine::start(Network::parse("127.0.0.1", "", "43900", "44000").expect("network"))
        .await
        .expect("worker");
    let mut stream = engine.events(&engine.core.boot).await.expect("subscribe");
    engine.core.publish("workerDied", serde_json::json!({}));
    assert_eq!(stream.next_event().await.expect("ready").kind, "ready");
    assert_eq!(
        stream.next_event().await.expect("native failure").kind,
        "workerDied"
    );
    for _ in 0..1025 {
        engine
            .core
            .publish("dominantSpeaker", serde_json::json!({}));
    }
    assert!(
        stream.next_event().await.is_err(),
        "event lag cannot silently skip history"
    );
    assert!(
        engine.events("wrong-boot").await.is_err(),
        "old boot cannot subscribe"
    );
}

/// Native network validation fails startup rather than advertising unusable candidates.
#[test]
fn network_configuration_boundaries() {
    for (name, ip, announced, min, max, accepted) in [
        ("loopback", "127.0.0.1", "", "40000", "40010", true),
        ("NAT", "0.0.0.0", "127.0.0.1", "40000", "40010", true),
        (
            "unannounced wildcard",
            "0.0.0.0",
            "",
            "40000",
            "40010",
            false,
        ),
        ("reversed", "127.0.0.1", "", "40010", "40000", false),
        ("privileged", "127.0.0.1", "", "80", "90", false),
        ("range capacity", "127.0.0.1", "", "40000", "42000", false),
        (
            "trailing newline",
            "0.0.0.0",
            "127.0.0.1\r",
            "40000",
            "40010",
            false,
        ),
        (
            "announced path",
            "0.0.0.0",
            "example.test/path",
            "40000",
            "40010",
            false,
        ),
    ] {
        assert_eq!(
            Network::parse(ip, announced, min, max).is_ok(),
            accepted,
            "{name}"
        );
    }
}

/// Invalid, replaced and expired direct commands cannot allocate native resources.
#[tokio::test]
async fn direct_command_boundaries() {
    let engine = Engine::start(Network::parse("127.0.0.1", "", "45300", "45400").expect("network"))
        .await
        .expect("worker");
    let boot = engine.metadata().await.expect("metadata").boot_id;
    for (name, invalid, stale, expired, expected) in [
        ("invalid binding", true, false, false, "invalid"),
        ("stale worker", false, true, false, "stale"),
        ("expired monotonic deadline", false, false, true, "expired"),
    ] {
        let mut owner = binding(1);
        if invalid {
            owner.peer_id.clear();
        }
        let command = Command {
            boot_id: if stale {
                "old-worker".into()
            } else {
                boot.clone()
            },
            deadline: if expired {
                std::time::Instant::now()
            } else {
                std::time::Instant::now() + std::time::Duration::from_secs(30)
            },
            binding: owner,
            operation: Operation::CreateRoom(Empty::default()),
        };
        let category = match engine.execute(&command).await {
            Err(MediaError::InvalidCommand) => "invalid",
            Err(MediaError::Rejected(crate::media::protocol::ErrorCode::StaleBoot)) => "stale",
            Err(MediaError::Rejected(crate::media::protocol::ErrorCode::RequestExpired)) => {
                "expired"
            }
            _ => "unexpected",
        };
        assert_eq!(category, expected, "{name}");
        assert!(
            engine.core.state.lock().expect("state").rooms.is_empty(),
            "{name}"
        );
    }
    engine.shutdown().expect("shutdown");
}
