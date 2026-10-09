//! HTTP origin normalization and CSRF request policy, independent of routing.

use axum::http::{HeaderMap, Method, header};

/// Canonicalize a configured HTTP(S) URL or Referer to its scheme/host/port origin.
/// Default ports and URL paths/queries/fragments are omitted. Malformed,
/// non-HTTP(S), and credential-bearing URLs produce no origin.
pub(crate) fn normalize_origin(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// Prefer Origin; use Referer only when the Origin header is absent.
/// An explicitly invalid Origin must fail closed, not authorize via Referer.
pub(super) fn csrf_origin_from_headers(headers: &HeaderMap) -> Option<String> {
    if let Some(origin) = headers.get(header::ORIGIN) {
        return normalize_origin(origin.to_str().ok()?);
    }
    normalize_origin(headers.get(header::REFERER)?.to_str().ok()?)
}

/// Require an explicit allowlisted browser Origin for private state socket admission.
/// Referer is not a substitute for websocket Origin; public sockets use no credentials.
pub(super) fn websocket_origin_allowed(headers: &HeaderMap, allowed: &[String]) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .and_then(normalize_origin)
        .is_some_and(|origin| allowed.contains(&origin))
}

/// Require an allowed origin for the application's state-changing HTTP methods.
pub(super) fn requires_csrf(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

/// Table-driven pure policy tests; no router, server or database fixtures.
#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    /// URL normalization handles defaults, paths, IPv6 and invalid authorities.
    #[test]
    fn normalization_cases() {
        let cases = [
            ("https://example.test", Some("https://example.test")),
            (
                " HTTP://EXAMPLE.TEST:80/Studio ",
                Some("http://example.test"),
            ),
            (
                "https://example.test:443/path?query=1#section",
                Some("https://example.test"),
            ),
            (
                "https://example.test:3443/path",
                Some("https://example.test:3443"),
            ),
            ("http://[::1]:80/path", Some("http://[::1]")),
            ("https://example.test?query=1", Some("https://example.test")),
            ("https://example.test#section", Some("https://example.test")),
            ("", None),
            (" ", None),
            ("null", None),
            ("example.test", None),
            ("ftp://example.test", None),
            ("https://", None),
            ("https://example.test:invalid", None),
            ("https://example.test:65536", None),
            ("https://user:password@example.test", None),
            ("https://user@example.test", None),
            ("https://:password@example.test", None),
            ("https://[invalid]", None),
        ];
        for (raw, expected) in cases {
            assert_eq!(normalize_origin(raw).as_deref(), expected, "{raw:?}");
        }
    }

    /// Explicit invalid origins never inherit an allowed Referer.
    #[test]
    fn origin_header_precedence_cases() {
        let cases = [
            ("missing", None, None, None),
            (
                "referer",
                None,
                Some("https://example.test/studio"),
                Some("https://example.test"),
            ),
            ("invalid referer", None, Some("invalid"), None),
            (
                "origin",
                Some("https://example.test"),
                None,
                Some("https://example.test"),
            ),
            (
                "origin wins",
                Some("https://other.test"),
                Some("https://example.test/studio"),
                Some("https://other.test"),
            ),
            (
                "opaque origin",
                Some("null"),
                Some("https://example.test/studio"),
                None,
            ),
            (
                "malformed origin",
                Some("invalid"),
                Some("https://example.test/studio"),
                None,
            ),
            (
                "empty origin",
                Some(""),
                Some("https://example.test/studio"),
                None,
            ),
        ];
        for (name, origin, referer, expected) in cases {
            let mut headers = HeaderMap::new();
            if let Some(origin) = origin {
                headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            }
            if let Some(referer) = referer {
                headers.insert(header::REFERER, HeaderValue::from_str(referer).unwrap());
            }
            assert_eq!(
                csrf_origin_from_headers(&headers).as_deref(),
                expected,
                "{name}"
            );
        }
        for bad_header in [header::ORIGIN, header::REFERER] {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::REFERER,
                HeaderValue::from_static("https://example.test/studio"),
            );
            headers.insert(
                bad_header.clone(),
                HeaderValue::from_bytes(b"\xff").unwrap(),
            );
            assert_eq!(csrf_origin_from_headers(&headers), None, "{bad_header}");
        }
    }

    /// Private websocket admission requires Origin and rejects cross-site/opaque callers.
    #[test]
    fn websocket_origin_cases() {
        let allowed = vec!["https://example.test".to_owned()];
        for (origin, expected) in [
            (None, false),
            (Some("https://example.test"), true),
            (Some("https://example.test:443"), true),
            (Some("https://other.test"), false),
            (Some("null"), false),
            (Some("invalid"), false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::REFERER,
                HeaderValue::from_static("https://example.test/studio"),
            );
            if let Some(origin) = origin {
                headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            }
            assert_eq!(websocket_origin_allowed(&headers, &allowed), expected);
        }
    }

    /// Every standard method covers the safe and state-changing branches.
    #[test]
    fn method_policy_cases() {
        let cases = [
            (Method::GET, false),
            (Method::HEAD, false),
            (Method::OPTIONS, false),
            (Method::TRACE, false),
            (Method::CONNECT, false),
            (Method::POST, true),
            (Method::PUT, true),
            (Method::PATCH, true),
            (Method::DELETE, true),
        ];
        for (method, expected) in cases {
            assert_eq!(requires_csrf(&method), expected, "{method}");
        }
    }
}
