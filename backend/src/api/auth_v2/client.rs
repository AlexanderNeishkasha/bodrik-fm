//! Client identity for authentication and conference admission throttling.

use std::net::{IpAddr, SocketAddr};

use axum::http::{HeaderMap, HeaderValue};

/// Return an IP-based key, trusting forwarded addresses only when configured.
/// User-Agent is deliberately excluded because clients can change it freely.
pub(crate) fn client_key(
    headers: &HeaderMap,
    remote_ip: Option<IpAddr>,
    trust_proxy_headers: bool,
) -> String {
    let ip = if trust_proxy_headers {
        client_ip_from_proxy_headers(headers)
    } else {
        None
    };
    ip.or(remote_ip)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Prefer the proxy's explicit client address over its forwarded chain.
fn client_ip_from_proxy_headers(headers: &HeaderMap) -> Option<IpAddr> {
    headers
        .get("x-real-ip")
        .and_then(parse_single_ip_header)
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(parse_forwarded_for_header)
        })
}

/// Parse a single textual proxy header, rejecting non-text values.
fn parse_single_ip_header(value: &HeaderValue) -> Option<IpAddr> {
    value.to_str().ok().and_then(parse_ip)
}

/// Select the rightmost valid address, preserving the configured proxy contract.
fn parse_forwarded_for_header(value: &HeaderValue) -> Option<IpAddr> {
    let raw = value.to_str().ok()?;
    raw.split(',').rev().find_map(parse_ip)
}

/// Accept plain IP addresses and proxy addresses with brackets or ports.
fn parse_ip(value: &str) -> Option<IpAddr> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        return Some(ip);
    }
    if let Some(inside) = trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
    {
        return inside.parse().ok();
    }
    trimmed
        .parse::<SocketAddr>()
        .ok()
        .map(|address| address.ip())
}

/// Regression coverage for client-controlled identity and proxy trust.
#[cfg(test)]
mod tests {
    use super::*;

    /// Changing User-Agent must not provide a fresh rate-limit bucket.
    #[test]
    fn user_agent_does_not_change_key() {
        let ip = Some("192.0.2.1".parse().unwrap());
        let mut headers = HeaderMap::new();
        let original = client_key(&headers, ip, false);
        headers.insert("user-agent", HeaderValue::from_static("different client"));
        assert_eq!(client_key(&headers, ip, false), original);
    }

    /// Identity selection covers proxy trust, header precedence, and missing IPs.
    #[test]
    fn client_identity_cases() {
        let cases = [
            (
                "untrusted",
                false,
                Some("198.51.100.2"),
                None,
                Some("192.0.2.1"),
                "192.0.2.1",
            ),
            (
                "trusted",
                true,
                Some("198.51.100.2"),
                None,
                Some("192.0.2.1"),
                "198.51.100.2",
            ),
            (
                "invalid proxy",
                true,
                Some("invalid"),
                None,
                Some("192.0.2.1"),
                "192.0.2.1",
            ),
            (
                "proxy precedence",
                true,
                Some("198.51.100.2"),
                Some("192.0.2.3"),
                None,
                "198.51.100.2",
            ),
            (
                "forwarded fallback",
                true,
                Some("invalid"),
                Some("192.0.2.3, [2001:db8::1]:443"),
                None,
                "2001:db8::1",
            ),
            (
                "invalid chain",
                true,
                None,
                Some("invalid, "),
                Some("192.0.2.1"),
                "192.0.2.1",
            ),
            ("unknown", false, None, None, None, "unknown"),
        ];
        for (name, trust, real, forwarded, remote, expected) in cases {
            let mut headers = HeaderMap::new();
            if let Some(real) = real {
                headers.insert("x-real-ip", HeaderValue::from_str(real).unwrap());
            }
            if let Some(forwarded) = forwarded {
                headers.insert("x-forwarded-for", HeaderValue::from_str(forwarded).unwrap());
            }
            let remote = remote.map(|ip: &str| ip.parse().unwrap());
            assert_eq!(client_key(&headers, remote, trust), expected, "{name}");
        }
        for header in ["x-real-ip", "x-forwarded-for"] {
            let mut headers = HeaderMap::new();
            headers.insert(header, HeaderValue::from_bytes(b"\xff").unwrap());
            assert_eq!(client_key(&headers, None, true), "unknown", "{header}");
        }
    }

    /// Address parsing covers plain, bracketed, port-bearing, and malformed values.
    #[test]
    fn ip_parsing_cases() {
        let cases = [
            ("", None),
            (" ", None),
            ("192.0.2.1", Some("192.0.2.1")),
            (" 192.0.2.1 ", Some("192.0.2.1")),
            ("2001:db8::1", Some("2001:db8::1")),
            ("[2001:db8::1]:443", Some("2001:db8::1")),
            ("192.0.2.1:443", Some("192.0.2.1")),
            ("[::1]", Some("::1")),
            ("[::1]trailing", None),
            ("[::1]:invalid", None),
            ("192.0.2.1:invalid", None),
            ("192.0.2.1:65536", None),
            ("[invalid]:443", None),
            ("[2001:db8::1", None),
            ("invalid:443", None),
            ("invalid", None),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                parse_ip(raw),
                expected.map(|ip| ip.parse().unwrap()),
                "{raw:?}"
            );
        }
    }
}
