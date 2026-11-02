//! Fixed-recipient, safe transport, suppression and resource-bound tests.

use super::*;
use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use serde_json::{Value, json};

/// Build a safe operational alert for grouping tests.
fn alert(rule: &str) -> Alert {
    Alert {
        rule: rule.into(),
        container: "backend".into(),
        status: None,
    }
}

/// Private-user identifiers reject groups, usernames, malformed input and overflow.
#[test]
fn recipient_cases() {
    for (name, value, expected) in [
        ("positive", "123456789", Some(123456789)),
        ("leading zero", "00123", Some(123)),
        ("zero", "0", None),
        ("group", "-123456", None),
        ("channel", "-100123456789", None),
        ("username", "@someone", None),
        ("blank", "", None),
        ("whitespace", " 123 ", None),
        ("plus", "+123", None),
        ("overflow", "9223372036854775808", None),
    ] {
        assert_eq!(recipient(value).ok(), expected, "{name}");
    }
}

/// A token cannot inject path/query components or a second endpoint.
#[test]
fn token_cases() {
    for (name, token, expected) in [
        ("valid", "123456:abcdefghijklmnop_123", true),
        ("missing separator", "abcdefghijklmnop", false),
        ("short", "123:short", false),
        ("non numeric bot", "abc:abcdefghijklmnop", false),
        ("path injection", "123:abcdefghijklmnop/other", false),
        ("query injection", "123:abcdefghijklmnop?x", false),
    ] {
        assert_eq!(Telegram::new(token, "123").is_ok(), expected, "{name}");
    }
}

/// Repeats are grouped only for the same rule/container, and the cooldown boundary is inclusive.
#[test]
fn grouping_cases() {
    let now = Instant::now();
    let mut groups = Groups::default();
    let first = alert("YouTube failure");
    assert_eq!(groups.admit(&first, now), Some(0), "first");
    assert_eq!(
        groups.admit(&first, now + Duration::from_secs(299)),
        None,
        "repeat"
    );
    assert_eq!(
        groups.admit(&alert("Backend error"), now),
        Some(0),
        "other rule"
    );
    let mut other_container = first.clone();
    other_container.container = "other".into();
    assert_eq!(
        groups.admit(&other_container, now),
        Some(0),
        "other container"
    );
    assert_eq!(
        groups.admit(&first, now + COOLDOWN),
        Some(1),
        "cooldown boundary"
    );
    assert_eq!(
        groups.admit(&first, now + COOLDOWN),
        None,
        "repeat after reset"
    );
}

/// Group churn cannot allocate an unbounded suppression map.
#[test]
fn grouping_capacity() {
    let mut groups = Groups::default();
    for index in 0..(MAX_GROUPS + 100) {
        assert_eq!(
            groups.admit(&alert(&format!("rule-{index}")), Instant::now()),
            Some(0)
        );
        assert!(groups.entries.len() <= MAX_GROUPS);
    }
}

/// Notification text contains only validated identifiers and an optional repeat count.
#[test]
fn text_cases() {
    for (count, expected) in [(0, false), (7, true)] {
        let text = alert("YouTube failure").text(count);
        assert_eq!(text.contains("Repeated alerts suppressed"), expected);
        assert!(text.len() < 512);
    }
}

/// Mock response and captured outbound bodies; no test contacts Telegram.
#[derive(Clone)]
struct Mock {
    /// HTTP status returned by the local endpoint.
    status: StatusCode,
    /// JSON body or deliberately malformed reply.
    reply: String,
    /// Captured requests for proving recipient confinement.
    queue: mpsc::Sender<Value>,
}

/// Capture one Telegram request and return the chosen application/HTTP response.
async fn mock_send(State(state): State<Mock>, Json(payload): Json<Value>) -> (StatusCode, String) {
    state.queue.send(payload).await.unwrap();
    (state.status, state.reply)
}

/// Only an HTTP success plus ok=true counts as delivered; the recipient is always fixed.
#[tokio::test]
async fn transport_cases() {
    for (name, status, reply, success) in [
        (
            "acknowledged",
            StatusCode::OK,
            r#"{"ok":true}"#.to_owned(),
            true,
        ),
        (
            "api rejected",
            StatusCode::OK,
            r#"{"ok":false}"#.to_owned(),
            false,
        ),
        (
            "rate limited",
            StatusCode::TOO_MANY_REQUESTS,
            r#"{"ok":false}"#.to_owned(),
            false,
        ),
        (
            "server failure",
            StatusCode::BAD_GATEWAY,
            "{}".to_owned(),
            false,
        ),
        ("redirect", StatusCode::FOUND, "{}".to_owned(), false),
        ("invalid json", StatusCode::OK, "invalid".to_owned(), false),
        (
            "missing acknowledgement",
            StatusCode::OK,
            "{}".to_owned(),
            false,
        ),
        (
            "oversized response",
            StatusCode::OK,
            "a".repeat(16 * 1024 + 1),
            false,
        ),
    ] {
        let (sender, mut queue) = mpsc::channel(1);
        let app = Router::new()
            .route("/send", post(mock_send))
            .with_state(Mock {
                status,
                reply,
                queue: sender,
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let telegram = Telegram {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            endpoint: format!("http://{address}/send"),
            user: 123456789,
        };
        let result = telegram.send(&alert("YouTube failure").text(0)).await;
        let payload = queue.recv().await.unwrap();
        server.abort();
        let _ = server.await;
        assert_eq!(result.is_ok(), success, "{name}");
        assert_eq!(payload["chat_id"], json!(123456789), "{name}");
        assert!(payload.get("parse_mode").is_none(), "{name}");
        assert_eq!(
            payload["link_preview_options"]["is_disabled"],
            json!(true),
            "{name}"
        );
    }
}

/// Local viewer mode closes admission and cannot instantiate or contact Telegram.
#[tokio::test]
async fn disabled_worker_closes_admission() {
    let (sender, queue) = mpsc::channel(1);
    let (stop, stopped) = watch::channel(false);
    let worker = tokio::spawn(work(queue, None, stopped));
    tokio::time::timeout(Duration::from_secs(1), sender.closed())
        .await
        .unwrap();
    assert!(sender.try_send(alert("Local test")).is_err());
    stop.send_replace(true);
    worker.await.unwrap();
}

/// Shutdown releases the worker even with a queued message and an unavailable endpoint.
#[tokio::test]
async fn worker_stops_without_delivery() {
    let (sender, queue) = mpsc::channel(1);
    let (stop, stopped) = watch::channel(false);
    let telegram = Telegram::new("123:abcdefghijklmnop", "123").unwrap();
    stop.send_replace(true);
    // A closed stop sender makes changed() immediately ready, with no external request.
    drop(stop);
    drop(sender);
    tokio::time::timeout(Duration::from_secs(1), work(queue, Some(telegram), stopped))
        .await
        .unwrap();
}
