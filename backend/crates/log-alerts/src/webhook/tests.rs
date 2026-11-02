//! Webhook admission tests, including authentication, body limits and recipient confinement.

use super::*;
use axum::{Router, body::Body, http::Request, routing::post};
use tower::ServiceExt;

/// Build a bounded admission router and queue using an isolated test secret.
fn fixture(capacity: usize) -> (Router, mpsc::Receiver<Alert>) {
    let (queue, receiver) = mpsc::channel(capacity);
    let state = State {
        secret: "test-secret".into(),
        queue,
    };
    let router = Router::new()
        .route("/alerts", post(receive))
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024))
        .with_state(state);
    (router, receiver)
}

/// Each rejected branch leaves the delivery queue empty.
#[tokio::test]
async fn admission_cases() {
    for (name, auth, body, expected, queued) in [
        (
            "valid",
            Some("Bearer test-secret"),
            r#"{"rule":"YouTube failure","container":"backend"}"#,
            StatusCode::ACCEPTED,
            true,
        ),
        (
            "no auth",
            None,
            r#"{"rule":"x","container":"backend"}"#,
            StatusCode::UNAUTHORIZED,
            false,
        ),
        (
            "wrong token",
            Some("Bearer bad"),
            r#"{"rule":"x","container":"backend"}"#,
            StatusCode::UNAUTHORIZED,
            false,
        ),
        (
            "wrong scheme",
            Some("Basic test-secret"),
            r#"{"rule":"x","container":"backend"}"#,
            StatusCode::UNAUTHORIZED,
            false,
        ),
        (
            "recipient override",
            Some("Bearer test-secret"),
            r#"{"rule":"x","container":"backend","chat_id":999}"#,
            StatusCode::BAD_REQUEST,
            false,
        ),
        (
            "user override",
            Some("Bearer test-secret"),
            r#"{"rule":"x","container":"backend","user_id":999}"#,
            StatusCode::BAD_REQUEST,
            false,
        ),
        (
            "raw message",
            Some("Bearer test-secret"),
            r#"{"rule":"x","container":"backend","text":"secret"}"#,
            StatusCode::BAD_REQUEST,
            false,
        ),
        (
            "malformed",
            Some("Bearer test-secret"),
            "{",
            StatusCode::BAD_REQUEST,
            false,
        ),
        (
            "empty name",
            Some("Bearer test-secret"),
            r#"{"rule":"","container":"backend"}"#,
            StatusCode::BAD_REQUEST,
            false,
        ),
        (
            "unsafe name",
            Some("Bearer test-secret"),
            r#"{"rule":"https://secret","container":"backend"}"#,
            StatusCode::BAD_REQUEST,
            false,
        ),
        (
            "404",
            Some("Bearer test-secret"),
            r#"{"rule":"HTTP","container":"backend","status":404}"#,
            StatusCode::NO_CONTENT,
            false,
        ),
        (
            "400",
            Some("Bearer test-secret"),
            r#"{"rule":"HTTP","container":"backend","status":400}"#,
            StatusCode::NO_CONTENT,
            false,
        ),
        (
            "500",
            Some("Bearer test-secret"),
            r#"{"rule":"HTTP","container":"backend","status":500}"#,
            StatusCode::ACCEPTED,
            true,
        ),
        (
            "invalid status",
            Some("Bearer test-secret"),
            r#"{"rule":"HTTP","container":"backend","status":600}"#,
            StatusCode::BAD_REQUEST,
            false,
        ),
    ] {
        let (router, mut queue) = fixture(1);
        let mut request = Request::builder().method("POST").uri("/alerts");
        if let Some(auth) = auth {
            request = request.header("authorization", auth);
        }
        let response = router
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "{name}");
        assert_eq!(queue.try_recv().is_ok(), queued, "{name}");
    }
}

/// Oversized identifiers and bodies cannot bypass memory limits.
#[tokio::test]
async fn boundary_cases() {
    for (name, body, expected) in [
        (
            "max identifier",
            serde_json::json!({"rule":"a".repeat(128),"container":"backend"}).to_string(),
            StatusCode::ACCEPTED,
        ),
        (
            "too long identifier",
            serde_json::json!({"rule":"a".repeat(129),"container":"backend"}).to_string(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "too large body",
            "a".repeat(32 * 1024 + 1),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        let (router, _queue) = fixture(1);
        let response = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/alerts")
                    .header("authorization", "Bearer test-secret")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "{name}");
    }
}

/// Saturation is visible to Dozzle, rather than silently losing an acknowledged alert.
#[tokio::test]
async fn full_queue_returns_unavailable() {
    let (router, _queue) = fixture(1);
    for expected in [StatusCode::ACCEPTED, StatusCode::SERVICE_UNAVAILABLE] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/alerts")
                    .header("authorization", "Bearer test-secret")
                    .body(Body::from(r#"{"rule":"x","container":"backend"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
}
