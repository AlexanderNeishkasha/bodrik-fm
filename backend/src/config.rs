//! Startup configuration parsing; pure helpers keep tests independent of process environment.

use std::env;

use axum::http::{HeaderName, HeaderValue};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::api;

/// Load an optional independent meeting service credential; an empty variable disables integration.
///
/// # Errors
/// Rejects non-Unicode, short, oversized, whitespace or control-bearing configured secrets.
pub(crate) fn meeting_service_secret() -> Result<Option<std::sync::Arc<str>>, String> {
    let raw = match env::var("MEETING_PLAYER_SECRET") {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err("invalid MEETING_PLAYER_SECRET".into()),
    };
    parse_service_secret(raw.as_deref())
}

/// Parse a service credential without process-global environment changes in tests.
///
/// # Errors
/// Rejects configured credentials outside the private HTTP bearer contract.
fn parse_service_secret(raw: Option<&str>) -> Result<Option<std::sync::Arc<str>>, String> {
    match raw {
        None | Some("") => Ok(None),
        Some(value)
            if (32..=256).contains(&value.len())
                && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) =>
        {
            Ok(Some(std::sync::Arc::from(value)))
        }
        _ => Err("invalid MEETING_PLAYER_SECRET".into()),
    }
}

/// Load the origin allowlist, defaulting only when the variable is absent.
///
/// # Errors
/// Rejects an explicitly empty or malformed allowlist without logging its contents.
pub(crate) fn load_allowed_origins() -> Result<Vec<String>, String> {
    parse_allowed_origins(env::var("CORS_ALLOW_ORIGIN").ok().as_deref())
}

/// Parse and deduplicate canonical origins; invalid explicit configuration is an error.
///
/// # Errors
/// Returns an error for an empty list or any nonempty invalid URL.
fn parse_allowed_origins(raw: Option<&str>) -> Result<Vec<String>, String> {
    let mut origins = Vec::new();
    for item in raw
        .unwrap_or("http://localhost:3000")
        .split(',')
        .map(str::trim)
    {
        if item.is_empty() {
            continue;
        }
        let origin = api::normalize_origin(item).ok_or("invalid CORS_ALLOW_ORIGIN entry")?;
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    if origins.is_empty() {
        return Err("CORS_ALLOW_ORIGIN must contain an origin".into());
    }
    Ok(origins)
}

/// Build credentialed browser CORS rules from the validated origin allowlist.
///
/// # Errors
/// Returns an error if a canonical origin cannot be represented as an HTTP header.
pub(crate) fn build_cors(origins: &[String]) -> Result<CorsLayer, String> {
    let values = origins
        .iter()
        .map(|origin| origin.parse::<HeaderValue>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "invalid CORS origin header")?;
    Ok(CorsLayer::new()
        .allow_origin(AllowOrigin::list(values))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::ACCEPT,
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
            axum::http::header::COOKIE,
            HeaderName::from_static("x-studio-as-user-id"),
        ])
        .allow_credentials(true))
}

/// Read a boolean flag, preserving the default for missing/unrecognized values.
pub(crate) fn env_flag(name: &str, default: bool) -> bool {
    parse_flag(env::var(name).ok().as_deref(), default)
}

/// Accept the existing textual boolean spellings without process-global test setup.
fn parse_flag(raw: Option<&str>, default: bool) -> bool {
    match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("1" | "true" | "yes" | "on") => true,
        Some("0" | "false" | "no" | "off") => false,
        _ => default,
    }
}

/// Read an unsigned setting; missing, negative or overflowing values use the default.
pub(crate) fn env_usize(name: &str, default: usize) -> usize {
    parse_usize(env::var(name).ok().as_deref(), default)
}

/// Parse an unsigned setting using the caller's default for invalid text.
fn parse_usize(raw: Option<&str>, default: usize) -> usize {
    raw.and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

/// Pure table coverage for startup configuration branches.
#[cfg(test)]
mod tests {
    use super::*;

    /// Disabled configuration is distinct from an invalid configured secret.
    #[test]
    fn private_service_secret_cases() {
        for (name, raw, valid, enabled) in [
            ("missing", None, true, false),
            ("disabled", Some(""), true, false),
            ("short", Some("short"), false, false),
            (
                "valid",
                Some("synthetic-secret-with-32-characters"),
                true,
                true,
            ),
            (
                "header injection",
                Some("synthetic-secret-with-32-characters\n"),
                false,
                false,
            ),
        ] {
            let result = parse_service_secret(raw);
            assert_eq!(result.is_ok(), valid, "{name}");
            if let Ok(value) = result {
                assert_eq!(value.is_some(), enabled, "{name}");
            }
        }
    }

    /// Missing values use localhost; explicit invalid input never silently falls back.
    #[test]
    fn origin_configuration_cases() {
        let cases = [
            (None, Some(vec!["http://localhost:3000"])),
            (
                Some("https://EXAMPLE.test:443,https://example.test"),
                Some(vec!["https://example.test"]),
            ),
            (
                Some("http://localhost:3000,,http://pc.local:3000"),
                Some(vec!["http://localhost:3000", "http://pc.local:3000"]),
            ),
            (Some(""), None),
            (Some(" , "), None),
            (Some("invalid"), None),
            (Some("http://localhost:3000,invalid"), None),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                parse_allowed_origins(raw).ok(),
                expected.map(|items| items.into_iter().map(str::to_owned).collect()),
                "{raw:?}"
            );
        }
    }

    /// Every accepted boolean spelling and both default branches are covered.
    #[test]
    fn flag_cases() {
        for (raw, parsed) in [
            (None, None),
            (Some("invalid"), None),
            (Some(""), None),
            (Some("1"), Some(true)),
            (Some("true"), Some(true)),
            (Some("yes"), Some(true)),
            (Some(" ON "), Some(true)),
            (Some("0"), Some(false)),
            (Some("false"), Some(false)),
            (Some("no"), Some(false)),
            (Some("OFF"), Some(false)),
        ] {
            for default in [false, true] {
                assert_eq!(
                    parse_flag(raw, default),
                    parsed.unwrap_or(default),
                    "{raw:?}"
                );
            }
        }
    }

    /// Numeric parsing distinguishes zero/valid values from absent or invalid input.
    #[test]
    fn unsigned_setting_cases() {
        for (raw, expected) in [
            (None, 2),
            (Some(" 3 "), 3),
            (Some("0"), 0),
            (Some("-1"), 2),
            (Some("invalid"), 2),
            (Some(""), 2),
            (Some("999999999999999999999999999999"), 2),
        ] {
            assert_eq!(parse_usize(raw, 2), expected, "{raw:?}");
        }
    }
}
