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
