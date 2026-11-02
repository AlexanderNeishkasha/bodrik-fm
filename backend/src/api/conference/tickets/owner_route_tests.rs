//! The room owner's own session cookie makes their guest ticket a presenter ticket,
//! with no Studio link; other sessions stay guests.
#![cfg(test)]
use super::route_tests::{serve, state, ticket};
use super::*;
use axum::{Json, routing::get};

/// A signed session cookie for a fixture account, valid for `ttl` seconds from now
/// (expired when negative).
fn session(app: &AppState, user_id: i64, ttl: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let token = jsonwebtoken::encode(
        &Header::default(),
        &serde_json::json!({"sub": user_id, "login": "fixture", "role": "user", "exp": now.saturating_add_signed(ttl)}),
        &EncodingKey::from_secret(app.jwt_secret.as_bytes()),
    )
    .expect("synthetic cookie");
    format!("bodrik_fm_token={token}")
}

/// Owner, other account, deactivated owner, expired and forged sessions, and no session.
#[tokio::test]
async fn room_owner_session_cases() {
    let discovery = serve(Router::new().route(
        "/internal/replacement/v1/incarnation",
        get(|| async { Json(serde_json::json!({"version":1,"meetingInstanceId":"instance-one","issuer":"player","audience":"meeting"})) }),
    ))
    .await;
    let mut forged = state();
    forged.jwt_secret = "some-other-signing-key".into();
    for (name, cookie, deactivate_owner, expected) in [
        ("owner", Some((10, 300, false)), false, "presenter"),
        ("other account", Some((20, 300, false)), false, "guest"),
        ("deactivated owner", Some((10, 300, false)), true, "guest"),
        (
            "expired owner session",
            Some((10, -300, false)),
            false,
            "guest",
        ),
        (
            "forged owner session",
            Some((10, 300, true)),
            false,
            "guest",
        ),
        ("no session", None, false, "guest"),
    ] {
        let app = state();
        if deactivate_owner {
            app.db
                .lock()
                .expect("db")
                .execute("UPDATE users SET is_active=0 WHERE id=10", [])
                .expect("deactivate");
        }
        let cookie =
            cookie.map(|(user, ttl, forge)| session(if forge { &forged } else { &app }, user, ttl));
        let issuer = Issuer::new(
            "synthetic-replacement-ticket-key-32",
            "player",
            "meeting",
            &discovery.url,
            Arc::from("synthetic-discovery-secret-32-bytes"),
        )
        .expect("issuer");
        let server = serve(routes(app, Some(issuer))).await;
        let (role, _) = ticket(&reqwest::Client::new(), &server.url, cookie.as_deref()).await;
        assert_eq!(role, expected, "{name}");
    }
}
