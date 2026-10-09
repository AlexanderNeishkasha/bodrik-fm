//! Native RTP ingress and repeated allocation teardown, beyond registry-only assertions.
use super::*;

/// Stereo FFmpeg RTP reaches the in-process PlainTransport and replacing it leaves no native handles.
#[tokio::test]
async fn stereo_music_rtp_and_replacement() {
    let engine = Engine::start(Network::parse("127.0.0.1", "", "44300", "44400").expect("network"))
        .await
        .expect("worker");
    let b = binding(1);
    engine.create_room(&b).await.expect("room");
    engine.create_peer(&b).expect("peer");
    let music = engine.create_music(&b, 2468).await.expect("music");
    let (router, producer) = {
        let state = engine.core.state.lock().expect("state");
        let room = state.room(&b).expect("room");
        (
            room.router.clone().expect("router"),
            room.music.as_ref().expect("music").1.clone(),
        )
    };
    assert_eq!(producer.rtp_parameters().codecs.len(), 1);
    let output = tokio::process::Command::new("ffmpeg")
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:sample_rate=48000",
            "-t",
            "0.5",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-c:a",
            "libopus",
            "-payload_type",
            "111",
            "-ssrc",
            "2468",
            "-f",
            "rtp",
        ])
        .arg(format!(
            "rtp://127.0.0.1:{}?pkt_size=1200",
            u64::from(music.port)
        ))
        .kill_on_drop(true)
        .output()
        .await
        .expect("FFmpeg");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stats = producer.get_stats().await.expect("native RTP stats");
    assert!(
        stats
            .iter()
            .any(|stat| stat.packet_count > 0 && stat.byte_count > 0),
        "native producer must receive actual encoded stereo RTP"
    );
    drop(producer);
    engine.close_music(&b).expect("pause cleanup");
    native_empty(&router).await;
    let replacement = engine
        .create_music(&b, 2469)
        .await
        .expect("seek/replacement");
    assert_ne!(replacement.producer_id, music.producer_id);
    assert_eq!(
        engine
            .operation(&b, &Operation::Sources(Empty::default()))
            .await
            .expect("sources")
            .into_json()["sources"][0]["system"],
        "music"
    );
    engine.close_music(&b).expect("replace cleanup");
    native_empty(&router).await;
    engine.close_room(&b).expect("room cleanup");
}

/// Repeated joins and leaves return the real worker's transport allocation count to zero.
#[tokio::test]
async fn repeated_peer_teardown_returns_native_baseline() {
    let engine = Engine::start(Network::parse("127.0.0.1", "", "44500", "44600").expect("network"))
        .await
        .expect("worker");
    let initial = binding(1);
    engine.create_room(&initial).await.expect("room");
    let router = engine
        .core
        .state
        .lock()
        .expect("state")
        .room(&initial)
        .expect("room")
        .router
        .clone()
        .expect("router");
    for epoch in 1..=8 {
        let b = binding(epoch);
        engine.create_peer(&b).expect("join");
        for _ in 0..2 {
            engine
                .operation(&b, &Operation::CreateTransport(Empty::default()))
                .await
                .expect("transport")
                .into_json();
        }
        assert_eq!(
            router
                .dump()
                .await
                .expect("allocated native dump")
                .transport_ids
                .len(),
            2,
            "epoch {epoch}"
        );
        engine.close_peer(&b).expect("leave");
        native_empty(&router).await;
    }
    engine.close_room(&initial).expect("room cleanup");
}

/// Native handle Drop queues closure asynchronously; require bounded convergence to zero.
async fn native_empty(router: &Router) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if router
                .dump()
                .await
                .expect("native dump")
                .transport_ids
                .is_empty()
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("native resources return to baseline");
}
