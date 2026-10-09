//! Replacement-control HTTP integration fixtures.

use super::end_conference;
use crate::api::mirotalk::Config;
use axum::{Router, http::StatusCode, routing::delete};

/// Run one isolated replacement termination fixture.
async fn termination_server(status: StatusCode) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/internal/replacement/v1/conferences/{room}",
        delete(move || async move { status }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let task = tokio::spawn(async move { axum::serve(listener, app).await.expect("server") });
    (format!("http://{address}"), task)
}

/// Build isolated, non-secret replacement-control configuration.
fn config(replacement_url: String) -> Config {
    Config {
        public_url: "https://meet.example".into(),
        replacement_url,
        replacement_secret: "synthetic-replacement-secret-32".into(),
    }
}

/// Preserve idempotent missing-room termination while rejecting control failures.
#[tokio::test]
async fn termination_is_idempotent_but_rejects_control_failures() {
    let (url, task) = termination_server(StatusCode::NOT_FOUND).await;
    assert!(end_conference(&config(url), "opaque-id").await.is_ok());
    task.abort();
    let (url, task) = termination_server(StatusCode::FORBIDDEN).await;
    assert!(
        end_conference(&config(url), "opaque")
            .await
            .expect_err("failure")
            .contains("403")
    );
    task.abort();
}
