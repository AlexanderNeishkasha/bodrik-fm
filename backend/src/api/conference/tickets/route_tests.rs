//! Actual replacement issuance routes against isolated SQLite and private discovery fixtures.
#![cfg(test)]
use super::*;
use crate::api::{auth_v2, mirotalk, playback_observer::PlaybackObserver};
use axum::{Json, routing::get};
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::task::JoinHandle;

/// Owned loopback listener; failures/panics cannot leave a detached fixture server.
struct Server {
    /// Credential-free ephemeral test URL.
    url: String,
    /// Listener task aborted when its fixture scope ends.
    task: JoinHandle<()>,
}
impl Drop for Server {
    /// Abort the owned fixture listener.
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Start one isolated real HTTP route composition, including ConnectInfo injection.
async fn serve(router: Router) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let url = format!("http://{}", listener.local_addr().expect("address"));
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("server");
    });
    Server { url, task }
}

/// Create an entitled isolated player database; no applied migration or production data is changed.
fn state() -> AppState {
    let db = rusqlite::Connection::open_in_memory().expect("database");
    db.execute_batch("CREATE TABLE users(id INTEGER PRIMARY KEY,login TEXT,role TEXT,password_hash TEXT,is_active INTEGER); INSERT INTO users VALUES(10,'owner','user','unused',1),(20,'other','user','unused',1); CREATE TABLE rooms(id INTEGER PRIMARY KEY, slug TEXT, owner_user_id INTEGER,is_listed INTEGER DEFAULT 1); CREATE TABLE room_conferences(room_id INTEGER PRIMARY KEY, provider TEXT, allowed INTEGER, enabled INTEGER, provider_room_id TEXT, generation INTEGER); INSERT INTO rooms(id,slug,owner_user_id) VALUES(1,'public-room',10),(2,'other-room',20); INSERT INTO room_conferences VALUES(1,'mirotalk',1,1,'conference-one',3);").expect("schema");
    db.execute_batch(include_str!(
        "../../../../migrations/0019_conference_hosts.sql"
    ))
    .expect("host tables");
    AppState {
        temp_upload_dir: String::new(),
        media_dir: String::new(),
        db: Arc::new(Mutex::new(db)),
        jwt_secret: "synthetic-cookie-key-unrelated-to-tickets".into(),
        trust_proxy_headers: false,
        csrf_allowed_origins: Arc::new(vec!["http://localhost:3000".into()]),
        login_rate_limiter: Arc::new(auth_v2::LoginRateLimiter::new(5, 60)),
        conference_join_rate_limiter: Arc::new(auth_v2::LoginRateLimiter::new(30, 60)),
        conference_provider: Some(Arc::new(super::super::Provider::mirotalk(
            mirotalk::Config {
                public_url: "https://legacy-unused.test".into(),
                replacement_url: "http://replacement-unused".into(),
                replacement_secret: "synthetic-replacement-secret-32".into(),
            },
        ))),
        music_bridge_secret: None,
        playback_observer: Arc::new(PlaybackObserver::new(16)),
        youtube_download_limiter: Arc::new(Semaphore::new(1)),
        runtimes: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
    }
}

/// Server-resolved guest tickets carry no client-selected identity; live revocation denies issuance.
#[tokio::test]
async fn public_issuance_authority_cases() {
    for (name, path, origin, enabled, issuer_enabled, expected) in [
        (
            "guest",
            "/api/rooms/public-room/conference/ticket",
            Some("http://localhost:3000"),
            true,
            true,
            StatusCode::OK,
        ),
        (
            "foreign origin",
            "/api/rooms/public-room/conference/ticket",
            Some("https://evil.test"),
            true,
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            "missing origin",
            "/api/rooms/public-room/conference/ticket",
            None,
            true,
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            "disabled issuer",
            "/api/rooms/public-room/conference/ticket",
            Some("http://localhost:3000"),
            true,
            false,
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        (
            "revoked",
            "/api/rooms/public-room/conference/ticket",
            Some("http://localhost:3000"),
            false,
            true,
            StatusCode::NOT_FOUND,
        ),
        (
            "missing room",
            "/api/rooms/missing/conference/ticket",
            Some("http://localhost:3000"),
            true,
            true,
            StatusCode::NOT_FOUND,
        ),
        (
            "unauthenticated presenter",
            "/api/studio/conference/ticket",
            Some("http://localhost:3000"),
            true,
            true,
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let app = state();
        if !enabled {
            app.db
                .lock()
                .expect("db")
                .execute("UPDATE room_conferences SET allowed=0", [])
                .expect("revoke");
        }
        let contacted = Arc::new(AtomicBool::new(false));
        let flag = contacted.clone();
        let discovery = serve(Router::new().route("/internal/replacement/v1/incarnation", get(move || {
            let flag = flag.clone();
            async move { flag.store(true, Ordering::SeqCst); Json(serde_json::json!({"version":1,"meetingInstanceId":"instance-one","issuer":"player","audience":"meeting"})) }
        }))).await;
        let issuer = issuer_enabled.then(|| {
            Issuer::new(
                "synthetic-replacement-ticket-key-32",
                "player",
                "meeting",
                &discovery.url,
                Arc::from("synthetic-discovery-secret-32-bytes"),
            )
            .expect("issuer")
        });
        let server = serve(routes(app, issuer)).await;
        let mut request = reqwest::Client::new()
            .post(format!("{}{path}", server.url))
            .json(&serde_json::json!({}));
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = request.send().await.expect("request");
        assert_eq!(response.status(), expected, "{name}");
        if expected == StatusCode::OK {
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "no-store",
                "{name}"
            );
            let body: serde_json::Value = response.json().await.expect("response");
            let mut validation = jsonwebtoken::Validation::new(Algorithm::HS256);
            validation.set_audience(&["meeting"]);
            let claims = jsonwebtoken::decode::<serde_json::Value>(
                body["ticket"].as_str().expect("ticket"),
                &jsonwebtoken::DecodingKey::from_secret(b"synthetic-replacement-ticket-key-32"),
                &validation,
            )
            .expect("signature")
            .claims;
            assert_eq!(claims["role"], "guest", "{name}");
            assert_ne!(claims["actorId"], "forged", "{name}");
            assert_eq!(claims["generation"], 3);
        }
        if expected == StatusCode::FORBIDDEN
            || expected == StatusCode::UNAUTHORIZED
            || !issuer_enabled
        {
            assert!(
                !contacted.load(Ordering::SeqCst),
                "denied before discovery: {name}"
            );
        }
    }
}

/// Live account/role authorization is required; cookie role and presenter input cannot promote an actor.
#[tokio::test]
async fn presenter_live_identity_cases() {
    for (name, active, as_user, delete_during_discovery, expected) in [
        ("live owner", true, None, false, StatusCode::OK),
        (
            "inactive actor",
            false,
            None,
            false,
            StatusCode::UNAUTHORIZED,
        ),
        (
            "forged admin claim",
            true,
            Some("20"),
            false,
            StatusCode::FORBIDDEN,
        ),
        (
            "deleted during discovery",
            true,
            None,
            true,
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let app = state();
        if !active {
            app.db
                .lock()
                .expect("db")
                .execute("UPDATE users SET is_active=0 WHERE id=10", [])
                .expect("deactivate");
        }
        let actor_state = app.clone();
        let discovery = serve(Router::new().route("/internal/replacement/v1/incarnation", get(move || {
            let app = actor_state.clone();
            async move {
                if delete_during_discovery { tokio::task::spawn_blocking(move || app.db.lock().expect("db").execute("DELETE FROM users WHERE id=10", []).expect("delete fixture actor")).await.expect("worker"); }
                Json(serde_json::json!({"version":1,"meetingInstanceId":"instance-one","issuer":"player","audience":"meeting"}))
            }
        }))).await;
        let issuer = Issuer::new(
            "synthetic-replacement-ticket-key-32",
            "player",
            "meeting",
            &discovery.url,
            Arc::from("synthetic-discovery-secret-32-bytes"),
        )
        .expect("issuer");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_secs();
        let cookie = jsonwebtoken::encode(
            &Header::default(),
            &serde_json::json!({"sub":10,"login":"owner","role":"admin","exp":now+300}),
            &EncodingKey::from_secret(app.jwt_secret.as_bytes()),
        )
        .expect("synthetic cookie");
        let server = serve(routes(app, Some(issuer))).await;
        let mut request = reqwest::Client::new()
            .post(format!("{}/api/studio/conference/ticket", server.url))
            .header("origin", "http://localhost:3000")
            .header("cookie", format!("bodrik_fm_token={cookie}"))
            .json(&serde_json::json!({}));
        if let Some(target) = as_user {
            request = request.header("x-studio-as-user-id", target);
        }
        let response = request.send().await.expect("request");
        assert_eq!(response.status(), expected, "{name}");
        if expected == StatusCode::OK {
            let body: serde_json::Value = response.json().await.expect("response");
            let mut validation = jsonwebtoken::Validation::new(Algorithm::HS256);
            validation.set_audience(&["meeting"]);
            let claims = jsonwebtoken::decode::<serde_json::Value>(
                body["ticket"].as_str().expect("ticket"),
                &jsonwebtoken::DecodingKey::from_secret(b"synthetic-replacement-ticket-key-32"),
                &validation,
            )
            .expect("signature")
            .claims;
            assert_eq!(claims["actorId"], "account-10");
            assert_eq!(claims["role"], "presenter");
        }
    }
}

/// Unknown browser authority claims and oversized bodies cannot reach private discovery/signing.
#[tokio::test]
async fn issuance_body_rejection_cases() {
    let app = state();
    let issuer = Issuer::new(
        "synthetic-replacement-ticket-key-32",
        "player",
        "meeting",
        "http://127.0.0.1:1",
        Arc::from("synthetic-discovery-secret-32-bytes"),
    )
    .expect("issuer");
    let server = serve(routes(app, Some(issuer))).await;
    for (name, body, expected) in [
        (
            "claimed role",
            serde_json::json!({"role":"presenter"}).to_string(),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "claimed actor",
            serde_json::json!({"actorId":"account-10"}).to_string(),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "claimed instance",
            serde_json::json!({"meetingInstanceId":"old-instance"}).to_string(),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        ("oversize", "x".repeat(1025), StatusCode::PAYLOAD_TOO_LARGE),
    ] {
        let response = reqwest::Client::new()
            .post(format!(
                "{}/api/rooms/public-room/conference/ticket",
                server.url
            ))
            .header("origin", "http://localhost:3000")
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .expect("request");
        assert_eq!(response.status(), expected, "{name}");
    }
}

/// Revocation racing authenticated incarnation discovery is seen by the post-await authority lookup.
#[tokio::test]
async fn revocation_during_discovery_denies_ticket() {
    let app = state();
    let revoke = app.clone();
    let discovery = serve(Router::new().route("/internal/replacement/v1/incarnation", get(move || {
        let app = revoke.clone();
        async move {
            tokio::task::spawn_blocking(move || app.db.lock().expect("db").execute("UPDATE room_conferences SET enabled=0, generation=4", []).expect("revoke")).await.expect("worker");
            Json(serde_json::json!({"version":1,"meetingInstanceId":"instance-one","issuer":"player","audience":"meeting"}))
        }
    }))).await;
    let issuer = Issuer::new(
        "synthetic-replacement-ticket-key-32",
        "player",
        "meeting",
        &discovery.url,
        Arc::from("synthetic-discovery-secret-32-bytes"),
    )
    .expect("issuer");
    let server = serve(routes(app, Some(issuer))).await;
    let response = reqwest::Client::new()
        .post(format!(
            "{}/api/rooms/public-room/conference/ticket",
            server.url
        ))
        .header("origin", "http://localhost:3000")
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// A Studio host pass makes this browser host of the room on later entries too; other
/// browsers and reused passes stay guests.
#[tokio::test]
async fn host_pass_remembers_the_browser() {
    let app = state();
    let discovery = serve(Router::new().route(
        "/internal/replacement/v1/incarnation",
        get(|| async { Json(serde_json::json!({"version":1,"meetingInstanceId":"instance-one","issuer":"player","audience":"meeting"})) }),
    ))
    .await;
    let issuer = Issuer::new(
        "synthetic-replacement-ticket-key-32",
        "player",
        "meeting",
        &discovery.url,
        Arc::from("synthetic-discovery-secret-32-bytes"),
    )
    .expect("issuer");
    let token = super::super::hosts::mint_grant(
        &app,
        1,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_secs(),
    )
    .expect("grant");
    let server = serve(routes(app, Some(issuer))).await;
    let client = reqwest::Client::new();
    /// Request a guest ticket with an optional device cookie and pass; return role and Set-Cookie.
    async fn ticket(
        client: &reqwest::Client,
        url: &str,
        cookie: Option<&str>,
        grant: Option<&str>,
    ) -> (String, Option<String>) {
        let mut request = client
            .post(format!("{url}/api/rooms/public-room/conference/ticket"))
            .header("origin", "http://localhost:3000")
            .json(&grant.map_or_else(
                || serde_json::json!({}),
                |grant| serde_json::json!({"hostGrant": grant}),
            ));
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        let response = request.send().await.expect("request");
        assert_eq!(response.status(), StatusCode::OK);
        let set_cookie = response.headers().get(header::SET_COOKIE).map(|value| {
            value
                .to_str()
                .expect("ascii")
                .split(';')
                .next()
                .expect("pair")
                .to_owned()
        });
        let body: serde_json::Value = response.json().await.expect("body");
        let payload = body["ticket"]
            .as_str()
            .expect("ticket")
            .split('.')
            .nth(1)
            .expect("payload")
            .to_owned();
        let claims: serde_json::Value =
            serde_json::from_slice(&base64_url_decode(&payload)).expect("claims");
        (
            claims["role"].as_str().expect("role").to_owned(),
            set_cookie,
        )
    }
    let (role, cookie) = ticket(&client, &server.url, None, Some(&token)).await;
    assert_eq!(role, "presenter", "pass redeemed");
    let cookie = cookie.expect("device cookie issued");
    for (name, cookie, grant, expected) in [
        (
            "same browser, plain link",
            Some(cookie.as_str()),
            None,
            "presenter",
        ),
        (
            "same browser, reused pass",
            Some(cookie.as_str()),
            Some(token.as_str()),
            "presenter",
        ),
        ("other browser, plain link", None, None, "guest"),
        (
            "other browser, reused pass",
            None,
            Some(token.as_str()),
            "guest",
        ),
    ] {
        assert_eq!(
            ticket(&client, &server.url, cookie, grant).await.0,
            expected,
            "{name}"
        );
    }
}

/// Decode unpadded base64url (JWT payload) for assertions.
fn base64_url_decode(input: &str) -> Vec<u8> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bits = 0_u32;
    let mut count = 0;
    let mut out = Vec::new();
    for byte in input.bytes() {
        let value = alphabet
            .iter()
            .position(|candidate| *candidate == byte)
            .expect("base64url") as u32;
        bits = (bits << 6) | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}
