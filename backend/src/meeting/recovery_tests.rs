//! Real native-worker recovery using explicit synthetic configuration and no user data.
use super::*;
use meeting_backend::{native_media::Client, replacement::config::Settings};

/// Wait for a fresh ready incarnation under a bounded integration-test deadline.
async fn ready(shared: &Shared, previous: Option<&str>) -> String {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some((instance, _, _)) = shared.incarnation()
                && previous != Some(instance.as_str())
            {
                return instance;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("meeting recovered")
}

/// Fail native media, then verify fresh discovery and independent HTTP availability.
#[tokio::test]
async fn native_failure_recovers_without_restarting_host() {
    let directory = std::env::temp_dir().join(format!("meeting-recovery-{}", uuid::Uuid::new_v4()));
    let clients = Arc::new(Mutex::new(Vec::<Client>::new()));
    let sources = clients.clone();
    let storage = directory.clone();
    let factory: ConfigFactory = Arc::new(move || {
        let config = Config::parse(Settings {
            bind: "127.0.0.1:3001",
            media_bind: "127.0.0.1",
            media_announced: "",
            media_min: "45100",
            media_max: "45200",
            player_url: "http://127.0.0.1:9",
            player_secret: "synthetic-recovery-service-secret-32",
            key: "synthetic-recovery-ticket-secret-32",
            issuer: "player",
            audience: "meeting",
            origins: "https://example.test",
            invite_base: "https://example.test/api/conferences",
            bye_url: "https://example.test/bye",
            buttons: "false",
            brand: "false",
            avatar_dir: storage.join("avatars").to_str().expect("path"),
            chat_image_dir: storage.join("chat").to_str().expect("path"),
            diagnostics_dir: storage.join("diagnostics").to_str().expect("path"),
            diagnostics_retention_days: "1",
            diagnostics_file_bytes: "4096",
            diagnostics_total_bytes: "8192",
            ffmpeg_path: "ffmpeg",
            music_rtp_host: "127.0.0.1",
        })?;
        sources.lock().expect("clients").push(config.media.clone());
        Ok(config)
    });
    let shared = Shared::new();
    let mut owner = Supervisor::start_factory(shared.clone(), factory).expect("supervisor");
    let router = shared
        .routes()
        .route("/probe", get(|| async { "player available" }));
    let first = ready(&shared, None).await;
    {
        let mut active = shared.active.lock().expect("active incarnation");
        active.as_mut().expect("ready handle").router = Router::new().route(
            "/api/meeting/probe/{id}",
            get(|axum::extract::Path(id): axum::extract::Path<String>| async move { id }),
        );
    }
    let captured = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/meeting/probe/one")
                .body(axum::body::Body::empty())
                .expect("capture request"),
        )
        .await
        .expect("capture dispatch");
    assert_eq!(
        captured.status(),
        StatusCode::OK,
        "inner router extracts each parameter once"
    );
    assert_eq!(
        axum::body::to_bytes(captured.into_body(), 16)
            .await
            .expect("response"),
        "one"
    );
    let original = clients.lock().expect("clients")[0].clone();
    original.shutdown().expect("inject native failure");
    let probe = router
        .oneshot(
            Request::builder()
                .uri("/probe")
                .body(axum::body::Body::empty())
                .expect("request"),
        )
        .await
        .expect("host route");
    assert_eq!(probe.status(), StatusCode::OK);
    let second = ready(&shared, Some(&first)).await;
    assert_ne!(first, second, "recovery invalidates old tickets");
    owner.shutdown().await.expect("confirmed drain");
    assert!(shared.incarnation().is_none());
    assert_eq!(*shared.phase.borrow(), Phase::Stopped);
    drop(owner);
    drop(original);
    clients.lock().expect("clients").clear();
    tokio::fs::remove_dir_all(directory)
        .await
        .expect("remove synthetic storage");
}
