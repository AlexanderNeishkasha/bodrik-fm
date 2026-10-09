//! Real loopback HTTP authorization tests with synthetic grants, never a shared player database.

use axum::{Router, extract::State, http::StatusCode, routing::get};
use meeting_backend::integration::PlayerClient;
use serde_json::json;

/// Validate bound version/generation/lease and fail closed on disabled or unavailable player state.
#[tokio::test]
async fn authority_response_cases() {
    for (name, status, body, expected) in [
        (
            "current mapping",
            StatusCode::OK,
            json!({"version":1,"conferenceId":"room-1","generation":3,"roomSlug":"public-room","leaseSeconds":15}),
            "grant",
        ),
        (
            "sixty-second grant",
            StatusCode::OK,
            json!({"version":1,"conferenceId":"room-1","generation":3,"roomSlug":"public-room","leaseSeconds":60}),
            "grant",
        ),
        (
            "zero lifetime",
            StatusCode::OK,
            json!({"version":1,"conferenceId":"room-1","generation":3,"roomSlug":"public-room","leaseSeconds":0}),
            "error",
        ),
        (
            "retired",
            StatusCode::NOT_FOUND,
            json!({"message":"unavailable"}),
            "absent",
        ),
        (
            "wrong mapping",
            StatusCode::OK,
            json!({"version":1,"conferenceId":"other","generation":3,"roomSlug":"public-room","leaseSeconds":15}),
            "error",
        ),
        (
            "overlong lease",
            StatusCode::OK,
            json!({"version":1,"conferenceId":"room-1","generation":3,"roomSlug":"public-room","leaseSeconds":61}),
            "error",
        ),
        (
            "player outage",
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"message":"unavailable"}),
            "error",
        ),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let base = format!("http://{}", listener.local_addr().expect("test address"));
        let router =
            Router::new()
                .route(
                    "/api/internal/conferences/room-1/admission",
                    get(
                        |State((status, body)): State<(StatusCode, String)>| async move {
                            (status, body)
                        },
                    ),
                )
                .with_state((status, body.to_string()));
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("test server");
        });
        let client = PlayerClient::new(&base, "synthetic-service-secret-32-characters")
            .expect("test client");
        let result = client.authorize("room-1").await;
        task.abort();
        let outcome = match result {
            Ok(Some(_)) => "grant",
            Ok(None) => "absent",
            Err(_) => "error",
        };
        assert_eq!(outcome, expected, "{name}");
    }
}
