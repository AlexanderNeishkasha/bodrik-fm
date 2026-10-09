//! Deterministic lease timing, single-flight and expiry contracts.
use super::*;

/// Eighty participants and arbitrary events still claim one check per room cadence.
#[test]
fn renewal_is_single_flight_and_cadenced() {
    let lease = Schedule::new(15, 1);
    let mut lease = lease.lock().expect("lease");
    let now = lease.next;
    assert!(lease.claim(now));
    for _ in 0..80 {
        assert!(!lease.claim(now));
    }
    lease.accept(now, 15);
    let next = lease.next;
    assert!(!lease.claim(next - Duration::from_nanos(1)));
    assert!(lease.claim(next));
    lease.retry(next);
    assert!(!lease.claim(next));
    let retry = lease.next;
    assert!(lease.claim(retry));
}

/// Distinct reservations spread first refreshes rather than synchronizing room bursts.
#[test]
fn initial_schedule_is_bounded_and_staggered() {
    let mut delays = std::collections::HashSet::new();
    for reservation in 1..=10 {
        let lease = Schedule::new(60, reservation);
        let lease = lease.lock().expect("lease");
        let start = Instant::now();
        let delay = lease.next.saturating_duration_since(start);
        assert!((Duration::from_millis(18999)..Duration::from_millis(21001)).contains(&delay));
        delays.insert(delay.as_millis());
    }
    assert_eq!(delays.len(), 10);
}

/// Exercise actual HTTP outcomes without renewing revoked, expired or replacement incarnations.
#[tokio::test]
async fn named_http_refresh_cases() {
    use axum::{Json, Router, http::StatusCode, routing::get};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    for (name, status, generation, slug, expired, replaced, remains, valid) in [
        (
            "valid grant",
            200,
            3,
            "public-room",
            false,
            false,
            true,
            true,
        ),
        (
            "revoked mapping",
            404,
            3,
            "public-room",
            false,
            false,
            false,
            false,
        ),
        (
            "generation rotated",
            200,
            4,
            "public-room",
            false,
            false,
            false,
            false,
        ),
        (
            "slug changed",
            200,
            3,
            "other-room",
            false,
            false,
            false,
            false,
        ),
        (
            "temporary outage",
            500,
            3,
            "public-room",
            false,
            false,
            true,
            true,
        ),
        (
            "outage at expiry",
            500,
            3,
            "public-room",
            true,
            false,
            false,
            false,
        ),
        (
            "late positive cannot revive",
            200,
            3,
            "public-room",
            true,
            false,
            false,
            false,
        ),
        (
            "old response cannot touch replacement",
            404,
            3,
            "public-room",
            false,
            true,
            true,
            true,
        ),
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let url = format!("http://{}", listener.local_addr().expect("address"));
        let routes = Router::new().route(
            "/api/internal/conferences/conference/admission",
            get(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                async move {
                    (
                        StatusCode::from_u16(status).expect("status"),
                        Json(json!({
                            "version":1,"conferenceId":"conference","generation":generation,
                            "roomSlug":slug,"leaseSeconds":15
                        })),
                    )
                }
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, routes).await });
        let (mut service, _receivers, _) =
            crate::replacement::observations::tests::fixture(false, false);
        Arc::get_mut(&mut service.config)
            .expect("unique config")
            .player =
            crate::integration::PlayerClient::new(&url, "synthetic-player-service-secret-32")
                .expect("player");
        let room = service.store.lock().expect("store").rooms["conference"].clone();
        if expired {
            service
                .runtime
                .apply_verified(
                    Command::Abort {
                        room_id: "conference".into(),
                        epoch: room.reservation,
                    },
                    None,
                )
                .expect("retire before response");
        }
        if replaced {
            let mut store = service.store.lock().expect("store");
            let current = store.rooms.get_mut("conference").expect("room");
            current.boot = "replacement-boot".into();
            current.renewal = Schedule::new(15, 2);
        }
        refresh(&service, &room).await;
        let current = service
            .store
            .lock()
            .expect("store")
            .rooms
            .get("conference")
            .cloned();
        assert_eq!(current.is_some(), remains, "{name}");
        if let Some(current) = current {
            assert_eq!(
                service
                    .runtime
                    .room_current("conference", &current.binding.room_instance_id)
                    .expect("room validity"),
                valid || replaced,
                "{name}"
            );
        }
        assert_eq!(calls.load(Ordering::Relaxed), 1, "{name}");
        server.abort();
        let _ = server.await;
    }
}

/// Stop cancels the shared HTTP owner without waiting for the eight-second client timeout.
#[tokio::test]
async fn shutdown_cancels_inflight_refresh() {
    use axum::{Router, routing::get};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let url = format!("http://{}", listener.local_addr().expect("address"));
    let reached = Arc::new(tokio::sync::Notify::new());
    let signal = reached.clone();
    let routes = Router::new().route(
        "/api/internal/conferences/conference/admission",
        get(move || {
            signal.notify_one();
            async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                "unavailable"
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, routes).await });
    let (mut service, _receivers, _) =
        crate::replacement::observations::tests::fixture(false, false);
    Arc::get_mut(&mut service.config)
        .expect("unique config")
        .player = crate::integration::PlayerClient::new(&url, "synthetic-player-service-secret-32")
        .expect("player");
    service.store.lock().expect("store").rooms["conference"]
        .renewal
        .lock()
        .expect("lease")
        .next = Instant::now();
    let (stop, receiver) = watch::channel(false);
    let owner = tokio::spawn(supervise(service, receiver));
    tokio::time::timeout(Duration::from_secs(2), reached.notified())
        .await
        .expect("HTTP started");
    stop.send_replace(true);
    tokio::time::timeout(Duration::from_secs(1), owner)
        .await
        .expect("bounded stop")
        .expect("join");
    server.abort();
    let _ = server.await;
}

/// A shorter server-issued lease refreshes before expiry without extending its lifetime.
#[test]
fn shorter_grants_cap_refresh_cadence() {
    for seconds in [1, 3, 15, 60] {
        let lease = Schedule::new(seconds, 1);
        let mut lease = lease.lock().expect("lease");
        assert!(
            lease.next < Instant::now() + Duration::from_secs(u64::from(seconds)),
            "{seconds}"
        );
        let now = lease.next;
        lease.accept(now, seconds);
        assert!(
            lease.next < Instant::now() + Duration::from_secs(u64::from(seconds)),
            "{seconds}"
        );
    }
}

/// Named endpoints, wraparound and shorter grants remain within the exclusive deadline.
#[test]
fn named_jitter_bounds() {
    for (name, seconds, sample, expected_ms) in [
        ("refresh minimum", 60, 0, 19000),
        ("refresh maximum", 60, 2000, 21000),
        ("refresh wraps", 60, 2001, 19000),
        ("short grant", 3, 2000, 1200),
        ("one-second grant", 1, u128::MAX, 400),
    ] {
        let delay = refresh_delay(seconds, sample);
        assert_eq!(delay, Duration::from_millis(expected_ms), "{name}");
        assert!(delay < Duration::from_secs(u64::from(seconds)), "{name}");
    }
    for (name, sample, expected_ms) in [
        ("retry minimum", 0, 500),
        ("retry maximum", 1000, 1500),
        ("retry wraps", 1001, 500),
    ] {
        assert_eq!(
            retry_delay(sample),
            Duration::from_millis(expected_ms),
            "{name}"
        );
    }
}
