//! Replacement issuer schema/configuration/discovery tests with synthetic credentials.
#![cfg(test)]
use super::*;
use jsonwebtoken::{DecodingKey, Validation};
use serde_json::Value;

/// Construct a synthetic replacement issuer, unrelated to provider host credentials.
fn issuer(base: &str) -> Issuer {
    Issuer::new(
        "synthetic-replacement-ticket-key-32",
        "player",
        "meeting",
        base,
        Arc::from("synthetic-discovery-secret-32-bytes"),
    )
    .expect("issuer fixture")
}

/// Current entitled mapping fixture with no legacy provider API or real player database.
fn conference() -> db::Conference {
    db::Conference {
        allowed: true,
        enabled: true,
        provider_room_id: Some("conference-one".into()),
        room_slug: "public-room".into(),
        provider: Some("mirotalk".into()),
        room_id: 1,
        generation: 3,
    }
}

/// Validate both server-selected role branches and the exact public verifier payload/header contract.
#[test]
fn signed_payload_contract() {
    let issuer = issuer("http://127.0.0.1:3021");
    for (name, presenter, role) in [("guest", false, "guest"), ("owner", true, "presenter")] {
        let ticket = issuer
            .sign(
                &conference(),
                "instance-one".into(),
                "actor-one".into(),
                presenter,
                100,
            )
            .expect("ticket");
        assert!(ticket.ticket.len() <= 2048, "{name}");
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = false;
        validation.validate_aud = false;
        let decoded = jsonwebtoken::decode::<Value>(
            &ticket.ticket,
            &DecodingKey::from_secret(issuer.key.as_bytes()),
            &validation,
        )
        .expect("signature");
        assert_eq!(
            decoded.header.typ.as_deref(),
            Some("meeting-ticket+jwt"),
            "{name}"
        );
        let claims = decoded.claims;
        assert_eq!(claims.as_object().expect("claims").len(), 11, "{name}");
        assert_eq!(claims["iss"], "player");
        assert_eq!(claims["aud"], "meeting");
        assert_eq!(claims["meetingInstanceId"], "instance-one");
        assert_eq!(claims["conferenceId"], "conference-one");
        assert_eq!(claims["generation"], 3);
        assert_eq!(claims["actorId"], "actor-one");
        assert_eq!(claims["role"], role);
        assert_eq!(claims["iat"], 100);
        assert_eq!(claims["nbf"], 100);
        assert_eq!(claims["exp"], 145);
        assert!(Uuid::parse_str(claims["jti"].as_str().expect("identity")).is_ok());
        assert_eq!(ticket.expires_at, 145);
        assert_eq!(ticket.room_slug, "public-room");
        let next = issuer
            .sign(
                &conference(),
                "instance-one".into(),
                "actor-one".into(),
                presenter,
                100,
            )
            .expect("next ticket");
        assert_ne!(ticket.ticket, next.ticket, "fresh ticket identity {name}");
    }
}

/// Player's actual JWT encoder matches the public shared synthetic interoperability fixture.
#[test]
fn public_verifier_interoperability_fixture() {
    let fixture: Value =
        serde_json::from_str(include_str!("ticket-fixture.json")).expect("fixture");
    let mut header = Header::new(Algorithm::HS256);
    header.typ = Some("meeting-ticket+jwt".into());
    let token = jsonwebtoken::encode(
        &header,
        &fixture["claims"],
        &EncodingKey::from_secret(fixture["key"].as_str().expect("synthetic key").as_bytes()),
    )
    .expect("encoder");
    assert_eq!(token, fixture["token"].as_str().expect("synthetic token"));
}

/// Configuration denies unsafe URLs and accidental legacy-purpose/invalid scope defaults.
#[test]
fn issuer_configuration_cases() {
    for (name, key, scope, url, accepted) in [
        (
            "valid",
            "synthetic-replacement-ticket-key-32",
            "player",
            "http://meeting:3021",
            true,
        ),
        ("weak key", "short", "player", "http://meeting:3021", false),
        (
            "scope",
            "synthetic-replacement-ticket-key-32",
            "bad/scope",
            "http://meeting:3021",
            false,
        ),
        (
            "credentials",
            "synthetic-replacement-ticket-key-32",
            "player",
            "http://user:secret@meeting",
            false,
        ),
        (
            "query",
            "synthetic-replacement-ticket-key-32",
            "player",
            "http://meeting?token=x",
            false,
        ),
        (
            "path",
            "synthetic-replacement-ticket-key-32",
            "player",
            "http://meeting/path",
            false,
        ),
        (
            "tls unsupported",
            "synthetic-replacement-ticket-key-32",
            "player",
            "https://meeting",
            false,
        ),
    ] {
        assert_eq!(
            Issuer::new(
                key,
                scope,
                "meeting",
                url,
                Arc::from("synthetic-discovery-secret-32-bytes")
            )
            .is_ok(),
            accepted,
            "{name}"
        );
    }
}

/// Reject invalid generation/identity/time instead of signing a default-valid ticket.
#[test]
fn signing_rejection_cases() {
    let issuer = issuer("http://meeting:3021");
    for (name, generation, id, actor, instance, now) in [
        (
            "negative generation",
            -1,
            Some("conference-one"),
            "actor-one",
            "instance-one",
            100,
        ),
        (
            "unsafe generation",
            9_007_199_254_740_992,
            Some("conference-one"),
            "actor-one",
            "instance-one",
            100,
        ),
        ("missing mapping", 1, None, "actor-one", "instance-one", 100),
        (
            "invalid mapping",
            1,
            Some("bad/id"),
            "actor-one",
            "instance-one",
            100,
        ),
        (
            "invalid actor",
            1,
            Some("conference-one"),
            "",
            "instance-one",
            100,
        ),
        (
            "invalid instance",
            1,
            Some("conference-one"),
            "actor-one",
            "",
            100,
        ),
        (
            "overflow",
            1,
            Some("conference-one"),
            "actor-one",
            "instance-one",
            u64::MAX,
        ),
    ] {
        let mut conference = conference();
        conference.generation = generation;
        conference.provider_room_id = id.map(str::to_owned);
        assert!(
            issuer
                .sign(&conference, instance.into(), actor.into(), false, now)
                .is_err(),
            "{name}"
        );
    }
}

/// Real private HTTP discovery checks its bearer, schema, status and exact scopes.
#[tokio::test]
async fn incarnation_discovery_cases() {
    use axum::{extract::State, routing::get};
    for (name, status, body, accepted) in [
        ("valid", StatusCode::OK, serde_json::json!({"version":1,"meetingInstanceId":"instance-one","issuer":"player","audience":"meeting"}).to_string(), true),
        ("foreign audience", StatusCode::OK, serde_json::json!({"version":1,"meetingInstanceId":"instance-one","issuer":"player","audience":"legacy"}).to_string(), false),
        ("outage", StatusCode::SERVICE_UNAVAILABLE, "{}".into(), false),
        ("unknown fields", StatusCode::OK, serde_json::json!({"version":1,"meetingInstanceId":"instance-one","issuer":"player","audience":"meeting","password":"bad"}).to_string(), false),
        ("oversize", StatusCode::OK, "x".repeat(1025), false),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let base = format!("http://{}", listener.local_addr().expect("address"));
        let router = Router::new().route("/internal/replacement/v1/incarnation", get(|State((status, body)): State<(StatusCode, String)>, headers: HeaderMap| async move {
            assert_eq!(headers[header::AUTHORIZATION], "Bearer synthetic-discovery-secret-32-bytes");
            (status, body)
        })).with_state((status, body));
        let task = tokio::spawn(async move { axum::serve(listener, router).await.expect("server"); });
        assert_eq!(issuer(&base).incarnation().await.is_ok(), accepted, "{name}");
        task.abort();
        let _ = task.await;
    }
}
