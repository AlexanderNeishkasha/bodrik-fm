//! Named ticket authentication and single-use ownership regression cases.
use super::*;
use serde_json::{Value, json};

/// Independent synthetic signing key; never production configuration.
const KEY: &[u8] = b"synthetic-ticket-test-key-32-bytes!";

/// Construct the exact test service incarnation verifier.
fn verifier() -> Verifier {
    Verifier::new(KEY, "player", "meeting", "instance-one").expect("valid fixture")
}

/// Build a valid signed payload with deterministic time boundaries.
fn payload() -> Value {
    json!({"iss":"player","aud":"meeting","jti":"ticket-one","iat":100,
        "nbf":100,"exp":160,"meetingInstanceId":"instance-one",
        "conferenceId":"conference-one","generation":1,"actorId":"actor-one","role":"guest"})
}

/// Sign arbitrary fixture JSON to distinguish authenticated schema failures from signature failures.
fn sign(header: Value, claims: Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).expect("header JSON"));
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).expect("claims JSON"));
    let input = format!("{header}.{payload}");
    let mut mac = Hmac::<Sha256>::new_from_slice(KEY).expect("fixture key");
    mac.update(input.as_bytes());
    format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

/// Sign with the one permitted algorithm and explicit replacement purpose.
fn ticket(claims: Value) -> String {
    sign(json!({"alg":"HS256","typ":"meeting-ticket+jwt"}), claims)
}

/// Check signed scope, identity, schema, numeric and time failure branches by name.
#[test]
fn rejects_authenticated_invalid_claims() {
    let cases = [
        ("issuer", "iss", json!("foreign")),
        ("audience", "aud", json!("legacy")),
        ("incarnation", "meetingInstanceId", json!("instance-two")),
        ("ticket identity", "jti", json!("bad/identity")),
        ("actor", "actorId", json!("")),
        ("conference", "conferenceId", json!("bad/room")),
        ("role", "role", json!("host")),
        ("future issue", "iat", json!(102)),
        ("not before", "nbf", json!(99)),
        ("expired", "exp", json!(101)),
        ("lifetime", "exp", json!(161)),
        ("generation", "generation", json!(JS_SAFE_INTEGER + 1)),
        ("timestamp", "exp", json!(JS_SAFE_INTEGER + 1)),
        ("unknown claim", "password", json!("forbidden")),
    ];
    for (name, field, value) in cases {
        let mut claims = payload();
        claims[field] = value;
        assert!(
            matches!(
                verifier().verify_at(&ticket(claims), 101),
                Err(Error::Invalid)
            ),
            "{name}"
        );
    }
}

/// Check exact expiry and restart fencing independently of replay memory.
#[test]
fn time_and_incarnation_boundaries() {
    let token = ticket(payload());
    for (name, now, accepted) in [
        ("before issue", 99, false),
        ("issue", 100, true),
        ("last second", 159, true),
        ("expiry", 160, false),
    ] {
        assert_eq!(
            verifier().verify_at(&token, now).is_ok(),
            accepted,
            "{name}"
        );
    }
    let restarted =
        Verifier::new(KEY, "player", "meeting", "instance-two").expect("restart fixture");
    assert!(matches!(
        restarted.verify_at(&token, 101),
        Err(Error::Invalid)
    ));
}

/// Reject authenticated alternate headers, bad signatures and malformed envelopes.
#[test]
fn header_signature_and_envelope_fail_closed() {
    for (name, header) in [
        (
            "algorithm",
            json!({"alg":"none","typ":"meeting-ticket+jwt"}),
        ),
        ("purpose", json!({"alg":"HS256","typ":"JWT"})),
        (
            "extension",
            json!({"alg":"HS256","typ":"meeting-ticket+jwt","kid":"other"}),
        ),
    ] {
        assert!(
            matches!(
                verifier().verify_at(&sign(header, payload()), 101),
                Err(Error::Invalid)
            ),
            "{name}"
        );
    }
    let valid = ticket(payload());
    let signed_prefix = valid.rsplit_once('.').expect("signature").0;
    for (name, token) in [
        ("empty", String::new()),
        ("missing parts", "a.b".into()),
        ("extra part", format!("{valid}.extra")),
        (
            "signature",
            format!("{signed_prefix}.{}", URL_SAFE_NO_PAD.encode([0_u8; 32])),
        ),
        ("oversize", "a".repeat(TOKEN_LIMIT + 1)),
    ] {
        assert!(
            matches!(verifier().verify_at(&token, 101), Err(Error::Invalid)),
            "{name}"
        );
    }
}

/// Reusable upload authentication verifies a ticket without consuming admission identity.
#[tokio::test]
async fn reusable_authentication_does_not_consume_ticket() {
    let owner = Redeemer::new(verifier(), 8).expect("owner");
    let now = unix_seconds().expect("clock");
    let token = ticket(json!({"iss":"player","aud":"meeting","jti":"ticket-live",
        "iat":now,"nbf":now,"exp":now + MAX_LIFETIME,"meetingInstanceId":"instance-one",
        "conferenceId":"conference-one","generation":1,"actorId":"actor-one","role":"guest"}));
    for _ in 0..2 {
        let claims = owner
            .authenticate(token.clone())
            .await
            .expect("authenticate");
        assert_eq!(claims.conference_id, "conference-one");
    }
}

/// Clones share atomic single-use ownership even under competing redemption threads.
#[test]
fn concurrent_redemption_has_one_winner() {
    let owner = Redeemer::new(verifier(), 8).expect("owner");
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let owner = owner.clone();
            std::thread::spawn(move || {
                let claims = verifier()
                    .verify_at(&ticket(payload()), 101)
                    .expect("claims");
                owner.consume(&claims, 101)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().expect("thread"))
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| **result == Err(Error::Replay))
            .count(),
        7
    );
}

/// Capacity never evicts live tickets, expiry prunes exactly, and regressing time fails closed.
#[test]
fn replay_capacity_expiry_and_clock_boundaries() {
    let owner = Redeemer::new(verifier(), 1).expect("owner");
    let first = verifier()
        .verify_at(&ticket(payload()), 101)
        .expect("first");
    owner.consume(&first, 101).expect("first redemption");
    let mut next = payload();
    next["jti"] = json!("ticket-two");
    next["iat"] = json!(159);
    next["nbf"] = json!(159);
    next["exp"] = json!(219);
    let second = verifier().verify_at(&ticket(next), 159).expect("second");
    assert_eq!(owner.consume(&second, 159), Err(Error::Capacity));
    assert_eq!(owner.consume(&first, 159), Err(Error::Replay));
    assert_eq!(owner.consume(&first, 160), Err(Error::Invalid));
    owner.consume(&second, 160).expect("expired entry pruned");
    assert_eq!(owner.consume(&first, 159), Err(Error::Unavailable));
}

/// Fresh player denial never consumes a ticket; successful authorization does exactly once.
#[tokio::test]
async fn fresh_authority_and_redemption_cases() {
    use axum::{Router, extract::State, http::StatusCode, routing::get};
    for (name, status, generation, slug, expected) in [
        ("authorized", StatusCode::OK, 1, "public-room", None),
        (
            "revoked",
            StatusCode::NOT_FOUND,
            1,
            "public-room",
            Some(Error::Denied),
        ),
        (
            "generation",
            StatusCode::OK,
            2,
            "public-room",
            Some(Error::Denied),
        ),
        (
            "mapping",
            StatusCode::OK,
            1,
            "other-room",
            Some(Error::Denied),
        ),
        (
            "outage",
            StatusCode::SERVICE_UNAVAILABLE,
            1,
            "public-room",
            Some(Error::Unavailable),
        ),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let base = format!("http://{}", listener.local_addr().expect("address"));
        let body = json!({"version":1,"conferenceId":"conference-one","generation":generation,"roomSlug":slug,"leaseSeconds":15}).to_string();
        let router =
            Router::new()
                .route(
                    "/api/internal/conferences/conference-one/admission",
                    get(
                        |State((status, body)): State<(StatusCode, String)>| async move {
                            (status, body)
                        },
                    ),
                )
                .with_state((status, body));
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("server");
        });
        let player =
            PlayerClient::new(&base, "synthetic-player-secret-32-characters").expect("client");
        let owner = Redeemer::new(verifier(), 8).expect("owner");
        let now = unix_seconds().expect("clock");
        let mut claims = payload();
        claims["iat"] = json!(now);
        claims["nbf"] = json!(now);
        claims["exp"] = json!(now + 60);
        let token = ticket(claims);
        let result = owner.authorize(&player, "public-room", token.clone()).await;
        assert_eq!(result.err(), expected, "{name}");
        if expected.is_none() {
            assert_eq!(
                owner.authorize(&player, "public-room", token).await.err(),
                Some(Error::Replay),
                "{name}"
            );
        } else {
            assert!(
                owner.replay.lock().expect("registry").entries.is_empty(),
                "{name}"
            );
        }
        task.abort();
        let _ = task.await;
    }
}

/// Decode the exact synthetic JWT fixture produced by the private player's actual encoder test.
#[test]
fn player_encoder_interoperability_fixture() {
    let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/player-ticket.json"))
        .expect("fixture");
    let verifier = Verifier::new(
        fixture["key"].as_str().expect("synthetic key").as_bytes(),
        "player",
        "meeting",
        "instance-one",
    )
    .expect("verifier");
    let claims = verifier
        .verify_at(fixture["token"].as_str().expect("synthetic token"), 100)
        .expect("player signature/schema");
    assert_eq!(claims.jti, "cross-issuer-fixture");
    assert_eq!(claims.actor_id, "actor-one");
    assert_eq!(claims.generation, 3);
    assert_eq!(claims.role, Role::Guest);
}

/// Invalid independent configuration cannot silently supply permissive defaults.
#[test]
fn configuration_boundaries() {
    for (name, key, issuer) in [
        ("short key", &KEY[..31], "player"),
        ("invalid issuer", KEY, "bad/issuer"),
    ] {
        assert!(
            matches!(
                Verifier::new(key, issuer, "meeting", "instance-one"),
                Err(Error::Configuration)
            ),
            "{name}"
        );
    }
    for capacity in [0, 4097] {
        assert!(matches!(
            Redeemer::new(verifier(), capacity),
            Err(Error::Configuration)
        ));
    }
}
