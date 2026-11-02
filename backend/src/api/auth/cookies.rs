//! HttpOnly session cookies and byte-safe extraction.
//!
//! Without a configured domain the cookie is host-scoped. With one (production:
//! `bodrik.fm`) it is shared with subdomains such as `meet.bodrik.fm`, so the meeting
//! can recognise the room owner; issuance then also clears any older host-only copy.
//! The domain applies only to requests addressed to that domain, so direct local access
//! (`localhost:3001`) keeps working with host-only cookies.

use axum::http::{HeaderMap, HeaderValue, header};

/// Stable browser cookie name shared by issuance, extraction and clearing.
const AUTH_COOKIE_NAME: &str = "bodrik_fm_token";
/// Existing ten-year cookie lifetime, matching session expiry.
const AUTH_COOKIE_MAX_AGE: usize = 315_360_000;

/// Shared cookie attributes after the value; the lifetime and domain are appended per use.
const AUTH_COOKIE_ATTRIBUTES: &str = "Path=/; HttpOnly; SameSite=Lax";

/// Host-only clearing header, for logout and for replacing pre-domain sessions.
const CLEAR_HOST_ONLY: &str = "bodrik_fm_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";

/// Issue an HttpOnly cookie containing a server-generated JWT, shared with subdomains of
/// `domain` when configured.
///
/// # Errors
/// Rejects empty/non-JWT-alphabet values or invalid HTTP header construction.
pub(super) fn append_auth_cookies(
    headers: &mut HeaderMap,
    token: &str,
    domain: Option<&str>,
) -> Result<(), String> {
    if token.is_empty()
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("invalid authentication cookie token".into());
    }
    let value = HeaderValue::from_str(&format!(
        "{AUTH_COOKIE_NAME}={token}; {AUTH_COOKIE_ATTRIBUTES}; Max-Age={AUTH_COOKIE_MAX_AGE}{}",
        domain_attribute(domain)
    ))
    .map_err(|err| err.to_string())?;
    if domain.is_some() {
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static(CLEAR_HOST_ONLY),
        );
    }
    headers.append(header::SET_COOKIE, value);
    Ok(())
}

/// Clear the host-only cookie and, when configured, the domain-wide one.
pub(crate) fn append_clear_auth_cookies(headers: &mut HeaderMap, domain: Option<&str>) {
    headers.append(
        header::SET_COOKIE,
        HeaderValue::from_static(CLEAR_HOST_ONLY),
    );
    if domain.is_some()
        && let Ok(value) = HeaderValue::from_str(&format!(
            "{AUTH_COOKIE_NAME}=; {AUTH_COOKIE_ATTRIBUTES}; Max-Age=0{}",
            domain_attribute(domain)
        ))
    {
        headers.append(header::SET_COOKIE, value);
    }
}

/// The configured cookie domain if the request's `Host` is that domain or a subdomain;
/// browsers reject a `Domain` that does not cover the responding host.
pub(crate) fn request_cookie_domain<'a>(
    configured: Option<&'a str>,
    request: &HeaderMap,
) -> Option<&'a str> {
    let domain = configured?;
    let host = request.get(header::HOST)?.to_str().ok()?;
    let host = host
        .rsplit_once(':')
        .filter(|(_, port)| port.bytes().all(|byte| byte.is_ascii_digit()))
        .map_or(host, |(name, _)| name)
        .to_ascii_lowercase();
    (host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.')))
    .then_some(domain)
}

/// `; Domain=...` for a configured (startup-validated) cookie domain, else nothing.
fn domain_attribute(domain: Option<&str>) -> String {
    domain.map_or_else(String::new, |domain| format!("; Domain={domain}"))
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
                append_auth_cookies(&mut headers, token, None).is_ok(),
                valid,
                "{token:?}"
            );
            if valid {
                assert_eq!(
                    set_cookies(&headers),
                    [format!(
                        "bodrik_fm_token={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000"
                    )]
                );
            } else {
                assert!(!headers.contains_key(header::SET_COOKIE));
            }
        }
    }

    /// All Set-Cookie values in order.
    fn set_cookies(headers: &HeaderMap) -> Vec<String> {
        headers
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect()
    }

    /// A configured domain shares the session with subdomains and retires the host-only copy.
    #[test]
    fn domain_issuance_replaces_host_only_cookie() {
        let mut headers = HeaderMap::new();
        append_auth_cookies(&mut headers, "a.b.c", Some("bodrik.fm")).unwrap();
        assert_eq!(
            set_cookies(&headers),
            [
                CLEAR_HOST_ONLY.to_owned(),
                "bodrik_fm_token=a.b.c; Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000; Domain=bodrik.fm".to_owned(),
            ]
        );
    }

    /// The domain applies to itself and its subdomains (any port), never to other hosts.
    #[test]
    fn request_domain_cases() {
        for (name, configured, host, expected) in [
            (
                "apex",
                Some("bodrik.fm"),
                Some("bodrik.fm"),
                Some("bodrik.fm"),
            ),
            (
                "subdomain",
                Some("bodrik.fm"),
                Some("meet.bodrik.fm"),
                Some("bodrik.fm"),
            ),
            (
                "port",
                Some("pc.lan"),
                Some("meet.pc.lan:3443"),
                Some("pc.lan"),
            ),
            ("case", Some("pc.lan"), Some("PC.LAN:3443"), Some("pc.lan")),
            (
                "direct local access",
                Some("pc.lan"),
                Some("localhost:3001"),
                None,
            ),
            (
                "suffix lookalike",
                Some("bodrik.fm"),
                Some("evilbodrik.fm"),
                None,
            ),
            ("missing host", Some("bodrik.fm"), None, None),
            ("not configured", None, Some("bodrik.fm"), None),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(host) = host {
                headers.insert(header::HOST, HeaderValue::from_static(host));
            }
            assert_eq!(
                request_cookie_domain(configured, &headers),
                expected,
                "{name}"
            );
        }
    }

    /// Logout clears exactly our cookie: host-only always, the domain copy when configured.
    #[test]
    fn clearing_targets_our_cookie() {
        for (name, domain, expected) in [
            ("host only", None, vec![CLEAR_HOST_ONLY.to_owned()]),
            (
                "with domain",
                Some("bodrik.fm"),
                vec![
                    CLEAR_HOST_ONLY.to_owned(),
                    "bodrik_fm_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Domain=bodrik.fm"
                        .to_owned(),
                ],
            ),
        ] {
            let mut headers = HeaderMap::new();
            append_clear_auth_cookies(&mut headers, domain);
            assert_eq!(set_cookies(&headers), expected, "{name}");
        }
    }
}
