//! Actual player HTTP, FFmpeg and in-process music lifecycle integration.
use super::*;
use crate::{
    integration::PlayerClient,
    media::protocol::{Empty, MediaType},
};
use axum::{Json, Router, http::StatusCode, routing::get};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Playback fixture stays on the explicitly configured player media origin.
fn playback(revision: usize, playing: bool, position: f64, track: &str) -> Value {
    json!({"revision":revision,"output":"conference","volume":0.4,"isPlaying":playing,
        "position":position,"track":{"id":track,"title":"Synthetic music","duration":4.0,"mediaUrl":"/media/tone.wav"}})
}

/// Exercise pause/resume, seek/replacement, late consumption and missing/invalid authority silence.
#[tokio::test]
async fn native_music_authority_and_controls() {
    let audio = tokio::process::Command::new("ffmpeg")
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:sample_rate=48000",
            "-t",
            "4",
            "-ac",
            "2",
            "-f",
            "wav",
            "pipe:1",
        ])
        .kill_on_drop(true)
        .output()
        .await
        .expect("synthetic WAV");
    assert!(audio.status.success());
    let snapshot = Arc::new(Mutex::new((
        StatusCode::OK,
        playback(1, true, 0.0, "first"),
    )));
    let authority = snapshot.clone();
    let reads = Arc::new(AtomicUsize::new(0));
    let requests = reads.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("player listener");
    let player_url = format!("http://{}", listener.local_addr().expect("player address"));
    let routes = Router::new()
        .route(
            "/api/internal/conferences/conference/music",
            get(move || {
                let authority = authority.clone();
                requests.fetch_add(1, Ordering::Relaxed);
                async move {
                    let (status, value) = authority.lock().expect("authority").clone();
                    (status, Json(value))
                }
            }),
        )
        .route(
            "/media/tone.wav",
            get(move || {
                let wav = audio.stdout.clone();
                async move { ([("content-type", "audio/wav")], wav) }
            }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, routes).await });
    let (mut service, _receivers, binding) =
        crate::replacement::observations::tests::fixture(false, false);
    let config = Arc::get_mut(&mut service.config).expect("unique config");
    config.player =
        PlayerClient::new(&player_url, "synthetic-player-service-secret-32").expect("player");
    config.media = crate::native_media::Client::new(
        crate::native_media::Network::parse("127.0.0.1", "", "44700", "44800").expect("network"),
    );
    let boot = config.media.metadata().await.expect("boot").boot_id;
    native::execute(
        &service,
        &boot,
        &binding,
        Operation::CreateRoom(Empty::default()),
    )
    .await
    .expect("native room")
    .into_json();
    native::execute(
        &service,
        &boot,
        &binding,
        Operation::CreatePeer(Empty::default()),
    )
    .await
    .expect("native peer")
    .into_json();
    let room = {
        let mut store = service.store.lock().expect("store");
        for session in store.sessions.values_mut() {
            session.events = None;
        }
        let room = store.rooms.get_mut("conference").expect("room");
        room.boot = boot.clone();
        room.clone()
    };
    let mut states = HashMap::new();
    let mut seen = HashMap::new();
    reconcile(&service, &mut states, &mut seen, true)
        .await
        .expect("music reconciliation");
    let first = states.get_mut("conference").expect("playing state");
    assert!(
        first
            .process
            .as_mut()
            .expect("FFmpeg")
            .try_wait()
            .expect("child status")
            .is_none()
    );
    let first_id = first.producer_id.clone();
    let before = reads.load(Ordering::Relaxed);
    reconcile(&service, &mut states, &mut seen, false)
        .await
        .expect("healthy membership check");
    assert_eq!(
        reads.load(Ordering::Relaxed),
        before,
        "healthy membership checks do not fetch playback"
    );
    *snapshot.lock().expect("authority") = (StatusCode::OK, playback(2, false, 0.1, "first"));
    reconcile(&service, &mut states, &mut seen, true)
        .await
        .expect("music reconciliation");
    assert!(states["conference"].process.is_none(), "pause reaps FFmpeg");
    let before = reads.load(Ordering::Relaxed);
    reconcile(&service, &mut states, &mut seen, false)
        .await
        .expect("paused membership check");
    assert_eq!(
        reads.load(Ordering::Relaxed),
        before,
        "paused membership checks do not fetch playback"
    );
    assert_eq!(
        states["conference"].producer_id, first_id,
        "paused room retains one source"
    );
    *snapshot.lock().expect("authority") = (StatusCode::OK, playback(3, true, 0.2, "first"));
    reconcile(&service, &mut states, &mut seen, true)
        .await
        .expect("music reconciliation");
    assert!(
        states["conference"].process.is_some(),
        "resume starts FFmpeg"
    );
    let resumed_id = states["conference"].producer_id.clone();
    assert_ne!(
        resumed_id, first_id,
        "resume must retire the RTP source used by the stopped FFmpeg process"
    );
    for (name, revision, playing) in [
        ("repeated paused snapshot", 3, false),
        ("second resume", 3, true),
    ] {
        *snapshot.lock().expect("authority") =
            (StatusCode::OK, playback(revision, playing, 0.2, "first"));
        reconcile(&service, &mut states, &mut seen, true)
            .await
            .expect("repeated pause/resume reconciliation");
        assert_eq!(states["conference"].process.is_some(), playing, "{name}");
        if playing {
            assert_ne!(
                states["conference"].producer_id, resumed_id,
                "{name}: restart replaces RTP even without a revision change"
            );
        } else {
            assert_eq!(states["conference"].producer_id, resumed_id, "{name}");
        }
    }
    let resumed_id = states["conference"].producer_id.clone();
    *snapshot.lock().expect("authority") = (StatusCode::OK, playback(4, true, 0.8, "first"));
    reconcile(&service, &mut states, &mut seen, true)
        .await
        .expect("music reconciliation");
    assert_ne!(
        states["conference"].producer_id, resumed_id,
        "active seek retires prior RTP source"
    );
    let sought_id = states["conference"].producer_id.clone();
    *snapshot.lock().expect("authority") = (StatusCode::OK, playback(5, true, 0.0, "second"));
    reconcile(&service, &mut states, &mut seen, true)
        .await
        .expect("music reconciliation");
    assert_ne!(
        states["conference"].producer_id, sought_id,
        "track replacement allocates fresh RTP source"
    );
    let current_id = states["conference"].producer_id.clone();
    let mut late = binding.clone();
    late.peer_id = "late-listener".into();
    native::execute(
        &service,
        &boot,
        &late,
        Operation::CreatePeer(Empty::default()),
    )
    .await
    .expect("late join")
    .into_json();
    let sources = native::execute(&service, &boot, &late, Operation::Sources(Empty::default()))
        .await
        .expect("late sources")
        .into_json();
    assert_eq!(sources["sources"].as_array().expect("sources").len(), 1);
    assert_eq!(sources["sources"][0]["id"], current_id);
    let caps = native::execute(
        &service,
        &boot,
        &late,
        Operation::Capabilities(Empty::default()),
    )
    .await
    .expect("caps")
    .into_json();
    let transport = native::execute(
        &service,
        &boot,
        &late,
        Operation::CreateTransport(Empty::default()),
    )
    .await
    .expect("receive transport")
    .into_json();
    native::execute(
        &service,
        &boot,
        &late,
        Operation::Consume {
            transport_id: transport["id"].as_str().expect("transport ID").into(),
            producer_id: current_id,
            rtp_capabilities: caps,
            media_type: MediaType::Audio,
        },
    )
    .await
    .expect("late listener consumes current music")
    .into_json();
    for (name, status, value) in [
        ("missing authority", StatusCode::NOT_FOUND, json!({})),
        (
            "invalid authority",
            StatusCode::OK,
            json!({"revision":"wrong"}),
        ),
    ] {
        *snapshot.lock().expect("authority") = (status, value);
        reconcile(&service, &mut states, &mut seen, true)
            .await
            .expect("music reconciliation");
        assert!(states.is_empty(), "{name}: process owner removed");
        assert!(
            service.store.lock().expect("store").rooms["conference"]
                .music
                .is_none(),
            "{name}: projection removed"
        );
        let inventory = native::execute(
            &service,
            &boot,
            &late,
            Operation::Inventory(Empty::default()),
        )
        .await
        .expect("inventory")
        .into_json();
        assert!(
            inventory["consumers"]
                .as_array()
                .expect("consumers")
                .is_empty(),
            "{name}: dependent native consumers closed"
        );
        let sources = native::execute(&service, &boot, &late, Operation::Sources(Empty::default()))
            .await
            .expect("sources")
            .into_json();
        assert!(
            sources["sources"].as_array().expect("sources").is_empty(),
            "{name}: native music closed"
        );
        // Restore valid playback so each failure independently proves retirement of an active source.
        *snapshot.lock().expect("authority") = (StatusCode::OK, playback(6, true, 0.0, "second"));
        reconcile(&service, &mut states, &mut seen, true)
            .await
            .expect("music reconciliation");
        assert!(
            states["conference"].process.is_some(),
            "valid authority restores playback"
        );
    }
    for state in states.values_mut() {
        silence(state).await.expect("process reaped");
    }
    close_native(&service, &room).await;
    native::execute(
        &service,
        &boot,
        &binding,
        Operation::CloseRoom(Empty::default()),
    )
    .await
    .expect("room cleanup")
    .into_json();
    service.config.media.shutdown().expect("native drain");
    server.abort();
    let _ = server.await;
}
