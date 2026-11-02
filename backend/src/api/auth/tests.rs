//! Table-driven unit coverage for authentication parsing and cryptography helpers.

use axum::http::HeaderValue;

use super::*;

/// Header parsing distinguishes absence from malformed and nonpositive overrides.
#[test]
fn studio_override_header_cases() {
    let cases = [
        ("absent", None, Ok(None)),
        ("positive", Some(b"42".as_slice()), Ok(Some(42))),
        ("trimmed", Some(b" 42 ".as_slice()), Ok(Some(42))),
        (
            "empty",
            Some(b"".as_slice()),
            Err((StatusCode::BAD_REQUEST, "invalid user")),
        ),
        (
            "whitespace",
            Some(b" ".as_slice()),
            Err((StatusCode::BAD_REQUEST, "invalid user")),
        ),
        (
            "nonnumeric",
            Some(b"invalid".as_slice()),
            Err((StatusCode::BAD_REQUEST, "invalid user")),
        ),
        (
            "zero",
            Some(b"0".as_slice()),
            Err((StatusCode::BAD_REQUEST, "invalid user")),
        ),
        (
            "negative",
            Some(b"-1".as_slice()),
            Err((StatusCode::BAD_REQUEST, "invalid user")),
        ),
        (
            "overflow",
            Some(b"9223372036854775808".as_slice()),
            Err((StatusCode::BAD_REQUEST, "invalid user")),
        ),
        (
            "non-text",
            Some(b"\xff".as_slice()),
            Err((StatusCode::BAD_REQUEST, "invalid user")),
        ),
    ];
    for (name, raw, expected) in cases {
        let mut headers = HeaderMap::new();
        if let Some(raw) = raw {
            headers.insert(STUDIO_AS_USER_HEADER, HeaderValue::from_bytes(raw).unwrap());
        }
        assert_eq!(
            requested_as_user_id_from_headers(&headers),
            expected,
            "{name}"
        );
    }
}

/// Password verification rejects malformed hashes and mismatches, accepting a match.
#[test]
fn password_verification_cases() {
    let hash = hash_password("secret").unwrap();
    let cases = [
        ("match", hash.as_str(), "secret", true),
        ("mismatch", hash.as_str(), "wrong", false),
        ("empty password", hash.as_str(), "", false),
        ("malformed hash", "not a hash", "secret", false),
        ("empty hash", "", "secret", false),
    ];
    for (name, hash, password, expected) in cases {
        assert_eq!(verify_password(hash, password), expected, "{name}");
    }
}

/// Token decoding validates signatures, expiration, and token structure.
#[test]
fn token_verification_cases() {
    let secret = "test-secret";
    let encode = |exp| {
        jsonwebtoken::encode(
            &Header::default(),
            &Claims {
                sub: 1,
                login: "alice".into(),
                role: "user".into(),
                exp,
            },
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    };
    let valid = encode(token_expiry());
    let expired = encode(1);
    let cases = [
        ("valid", secret, valid.as_str(), true),
        ("wrong secret", "another-secret", valid.as_str(), false),
        ("expired", secret, expired.as_str(), false),
        ("malformed", secret, "invalid", false),
        ("empty", secret, "", false),
    ];
    for (name, secret, token, expected) in cases {
        assert_eq!(verify_token(secret, token).is_some(), expected, "{name}");
    }
}

/// One active account owning room 1, with an optional session cookie domain.
fn me_state(domain: Option<&str>) -> AppState {
    let db = rusqlite::Connection::open_in_memory().expect("database");
    db.execute_batch("CREATE TABLE users(id INTEGER PRIMARY KEY,login TEXT,role TEXT,password_hash TEXT,is_active INTEGER); INSERT INTO users VALUES(10,'owner','user','unused',1); CREATE TABLE rooms(id INTEGER PRIMARY KEY, slug TEXT, owner_user_id INTEGER,is_listed INTEGER DEFAULT 1); INSERT INTO rooms(id,slug,owner_user_id) VALUES(1,'owner-room',10);").expect("schema");
    AppState {
        temp_upload_dir: String::new(),
        media_dir: String::new(),
        db: std::sync::Arc::new(std::sync::Mutex::new(db)),
        jwt_secret: "synthetic-cookie-key".into(),
        trust_proxy_headers: false,
        csrf_allowed_origins: std::sync::Arc::new(Vec::new()),
        auth_cookie_domain: domain.map(std::sync::Arc::from),
        login_rate_limiter: std::sync::Arc::new(LoginRateLimiter::new(5, 60)),
        conference_join_rate_limiter: std::sync::Arc::new(LoginRateLimiter::new(5, 60)),
        conference_provider: None,
        music_bridge_secret: None,
        playback_observer: std::sync::Arc::new(
            crate::api::playback_observer::PlaybackObserver::new(16),
        ),
        youtube_download_limiter: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        runtimes: std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
    }
}

/// With a cookie domain configured, `/me` on that domain moves an existing session onto it
/// (retiring the host-only copy); otherwise, or without a valid session, it sets no cookies.
#[test]
fn me_moves_sessions_onto_the_cookie_domain() {
    let token = jsonwebtoken::encode(
        &Header::default(),
        &Claims {
            sub: 10,
            login: "owner".into(),
            role: "user".into(),
            exp: token_expiry(),
        },
        &EncodingKey::from_secret(b"synthetic-cookie-key"),
    )
    .unwrap();
    let domain_cookie = format!(
        "bodrik_fm_token={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000; Domain=bodrik.fm"
    );
    let host_only_clear = "bodrik_fm_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";
    for (name, domain, host, cookie, status, expected) in [
        (
            "no domain",
            None,
            "bodrik.fm",
            Some(token.as_str()),
            StatusCode::OK,
            vec![],
        ),
        (
            "domain",
            Some("bodrik.fm"),
            "bodrik.fm",
            Some(token.as_str()),
            StatusCode::OK,
            vec![host_only_clear, domain_cookie.as_str()],
        ),
        (
            "direct local access",
            Some("bodrik.fm"),
            "localhost:3001",
            Some(token.as_str()),
            StatusCode::OK,
            vec![],
        ),
        (
            "signed out",
            Some("bodrik.fm"),
            "bodrik.fm",
            None,
            StatusCode::UNAUTHORIZED,
            vec![],
        ),
        (
            "invalid session",
            Some("bodrik.fm"),
            "bodrik.fm",
            Some("forged.token.value"),
            StatusCode::UNAUTHORIZED,
            vec![],
        ),
    ] {
        let mut headers = HeaderMap::new();
        headers.insert(axum::http::header::HOST, HeaderValue::from_static(host));
        if let Some(cookie) = cookie {
            headers.insert(
                axum::http::header::COOKIE,
                HeaderValue::from_str(&format!("bodrik_fm_token={cookie}")).unwrap(),
            );
        }
        let response = me_response(me_state(domain), headers);
        assert_eq!(response.status(), status, "{name}");
        let cookies: Vec<_> = response
            .headers()
            .get_all(axum::http::header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect();
        assert_eq!(cookies, expected, "{name}");
    }
}
