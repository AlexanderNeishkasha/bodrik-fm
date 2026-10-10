//! Host-scoped HttpOnly session cookies and byte-safe extraction.

use axum::http::{HeaderMap, HeaderValue, header};

/// Stable browser cookie name shared by issuance, extraction and clearing.
const AUTH_COOKIE_NAME: &str = "bodrik_fm_token";
/// Existing ten-year cookie lifetime, matching session expiry.
const AUTH_COOKIE_MAX_AGE: usize = 315_360_000;

/// Issue an HttpOnly host-scoped cookie containing a server-generated JWT.
///
/// # Errors
/// Rejects empty/non-JWT-alphabet values or invalid HTTP header construction.
pub(super) fn append_auth_cookies(headers: &mut HeaderMap, token: &str) -> Result<(), String> {
    if token.is_empty()
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("invalid authentication cookie token".into());
    }
    let value = HeaderValue::from_str(&format!(
        "{AUTH_COOKIE_NAME}={token}; Path=/; Max-Age={AUTH_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax"
    ))
    .map_err(|err| err.to_string())?;
    headers.append(header::SET_COOKIE, value);
    Ok(())
}

/// Clear the same host/path cookie without fallible dynamic header parsing.
pub(crate) fn append_clear_auth_cookies(headers: &mut HeaderMap) {
    headers.append(
        header::SET_COOKIE,
        HeaderValue::from_static("bodrik_fm_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"),
    );
}

/// Extract only our ASCII token; unrelated cookie bytes may be non-ASCII.
/// An empty/invalid first matching cookie fails closed, including duplicate cookies.
pub(super) fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    for cookie in headers.get_all(header::COOKIE) {
        for part in cookie.as_bytes().split(|byte| *byte == b';') {
            let part = part.trim_ascii();
            let Some(separator) = part.iter().position(|byte| *byte == b'=') else {
                continue;
            };
            if part[..separator].trim_ascii() != AUTH_COOKIE_NAME.as_bytes() {
                continue;
            }
            let token = &part[separator + 1..];
            if token.is_empty() || !token.is_ascii() {
                return None;
            }
            return std::str::from_utf8(token).ok().map(str::to_owned);
        }
    }
    None
}

/// Pure cookie tables, including malformed/unrelated header bytes.
#[cfg(test)]
mod tests {
    use super::*;

    /// Cookie extraction tolerates unrelated UTF-8 but rejects invalid auth values.
    #[test]
    fn extraction_cases() {
        let cases: &[(&str, &[u8], Option<&str>)] = &[
            ("missing", b"other=value", None),
            ("malformed", b"malformed", None),
            (
                "match",
                b"bodrik_fm_token=header.payload.sig",
                Some("header.payload.sig"),
            ),
            (
                "trim",
                b" other=1; bodrik_fm_token =token ; another=2",
                Some("token"),
            ),
            (
                "unrelated Unicode",
                b"room_name=\xd0\x91;bodrik_fm_token=token",
                Some("token"),
            ),
            ("invalid auth bytes", b"bodrik_fm_token=\xff", None),
            ("Unicode auth", b"bodrik_fm_token=\xd0\x91", None),
            ("empty", b"bodrik_fm_token=", None),
            (
                "empty duplicate",
                b"bodrik_fm_token=;bodrik_fm_token=token",
                None,
            ),
            ("wrong name", b"bodrik_fm_token_other=token", None),
        ];
        for (name, raw, expected) in cases {
            let mut headers = HeaderMap::new();
            headers.insert(header::COOKIE, HeaderValue::from_bytes(raw).unwrap());
            assert_eq!(token_from_headers(&headers).as_deref(), *expected, "{name}");
        }
        assert_eq!(token_from_headers(&HeaderMap::new()), None);
        let mut headers = HeaderMap::new();
        headers.append(header::COOKIE, HeaderValue::from_static("other=1"));
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("bodrik_fm_token=token"),
        );
        assert_eq!(token_from_headers(&headers).as_deref(), Some("token"));
    }

    /// Only JWT-safe values are emitted, preserving the cookie's security attributes.
    #[test]
    fn issuance_cases() {
        for (token, valid) in [
            ("header.payload.sig", true),
            ("abc-_", true),
            ("", false),
            ("bad\r\nheader", false),
            ("token;injected=1", false),
            ("Б", false),
        ] {
            let mut headers = HeaderMap::new();
            assert_eq!(
                append_auth_cookies(&mut headers, token).is_ok(),
                valid,
                "{token:?}"
            );
            if valid {
                let value = headers[header::SET_COOKIE].to_str().unwrap();
                assert!(value.contains("HttpOnly; SameSite=Lax"));
                assert!(value.contains("Path=/; Max-Age=315360000"));
            } else {
                assert!(!headers.contains_key(header::SET_COOKIE));
            }
        }
    }

    /// Logout targets exactly the issued host/path cookie without other names.
    #[test]
    fn clearing_targets_our_cookie() {
        let mut headers = HeaderMap::new();
        append_clear_auth_cookies(&mut headers);
        assert_eq!(
            headers[header::SET_COOKIE],
            "bodrik_fm_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
        );
    }
}
