//! Private coturn REST credential issuance at the admitted signaling boundary.
use super::{Service, session};
use crate::signaling::SessionStamp;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha1::Sha1;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

/// Private relay inputs; deliberately lacks Debug and serialization.
#[derive(Default)]
pub(super) struct Policy {
    /// Present only when relay support is explicitly enabled.
    relay: Option<Relay>,
}

/// Validated coturn credentials and browser routing policy.
struct Relay {
    /// Bounded browser TURN URLs, never containing embedded credentials.
    urls: Vec<String>,
    /// Shared server secret; only derived temporary credentials leave this module.
    secret: String,
    /// Lifetime in seconds, between one minute and one day.
    ttl: u64,
    /// Require relay candidates without silently falling back to direct ICE.
    force: bool,
}

impl Policy {
    /// Read explicit relay inputs without changing process environment.
    ///
    /// # Errors
    /// Rejects non-Unicode or malformed configuration without printing values.
    pub(super) fn from_env() -> Result<Self, String> {
        let read = |name: &str| match std::env::var(name) {
            Ok(value) => Ok(value),
            Err(std::env::VarError::NotPresent) => Ok(String::new()),
            Err(_) => Err(format!("invalid {name}")),
        };
        Self::parse(
            &read("TURN_ENABLED")?,
            &read("TURN_URLS")?,
            &read("TURN_SHARED_SECRET")?,
            &read("TURN_CREDENTIAL_TTL_SECONDS")?,
            &read("TURN_FORCE_RELAY")?,
        )
    }

    /// Validate relay settings before meeting readiness or credential issuance.
    ///
    /// # Errors
    /// Rejects invalid flags, missing/unsafe URLs, weak secrets or out-of-range lifetimes.
    pub(super) fn parse(
        enabled: &str,
        urls: &str,
        secret: &str,
        ttl: &str,
        force: &str,
    ) -> Result<Self, String> {
        let enabled = flag(enabled)?;
        let force = flag(force)?;
        if !enabled {
            if force {
                return Err("TURN_FORCE_RELAY requires TURN_ENABLED".into());
            }
            return Ok(Self::default());
        }
        let urls = urls
            .split(',')
            .map(str::trim)
            .map(validate_url)
            .collect::<Result<Vec<_>, _>>()?;
        if urls.len() > 8 {
            return Err("too many TURN_URLS".into());
        }
        if secret.len() < 32 || secret.len() > 1024 || secret.chars().any(char::is_whitespace) {
            return Err("invalid TURN_SHARED_SECRET".into());
        }
        let ttl = if ttl.is_empty() {
            3600
        } else {
            ttl.parse::<u64>()
                .map_err(|_| "invalid TURN_CREDENTIAL_TTL_SECONDS")?
        };
        if !(60..=86400).contains(&ttl) {
            return Err("invalid TURN_CREDENTIAL_TTL_SECONDS".into());
        }
        Ok(Self {
            relay: Some(Relay {
                urls,
                secret: secret.into(),
                ttl,
                force,
            }),
        })
    }

    /// Derive expiring coturn REST credentials for an already authorized opaque session.
    ///
    /// # Errors
    /// Rejects timestamp overflow or unavailable credential construction.
    fn issue(&self, session_id: &str, now: u64) -> Result<Value, &'static str> {
        let Some(relay) = &self.relay else {
            return Ok(json!({"iceServers":[],"iceTransportPolicy":"all","expiresAt":null}));
        };
        let expires = now.checked_add(relay.ttl).ok_or("unavailable")?;
        let username = format!("{expires}:{session_id}");
        // coturn REST authentication specifies HMAC-SHA1; this is not a password hash.
        let mut mac =
            Hmac::<Sha1>::new_from_slice(relay.secret.as_bytes()).map_err(|_| "unavailable")?;
        mac.update(username.as_bytes());
        let credential = STANDARD.encode(mac.finalize().into_bytes());
        Ok(
            json!({"iceServers":[{"urls":relay.urls,"username":username,"credential":credential}],
            "iceTransportPolicy":if relay.force {"relay"} else {"all"},"expiresAt":expires}),
        )
    }
}

/// Parse only explicit boolean values, defaulting absent flags to false.
///
/// # Errors
/// Rejects ambiguous flags instead of silently disabling relay protection.
fn flag(value: &str) -> Result<bool, String> {
    match value {
        "" | "false" => Ok(false),
        "true" => Ok(true),
        _ => Err("invalid TURN boolean setting".into()),
    }
}

/// Validate TURN authority and optional transport query without logging private inputs.
///
/// # Errors
/// Rejects non-TURN schemes, userinfo, paths, fragments, invalid ports and unknown queries.
fn validate_url(raw: &str) -> Result<String, String> {
    let (scheme, address) = raw.split_once(':').ok_or("invalid TURN_URLS")?;
    if !matches!(scheme, "turn" | "turns")
        || raw.len() > 512
        || raw.chars().any(char::is_whitespace)
    {
        return Err("invalid TURN_URLS".into());
    }
    let url = Url::parse(&format!("https://{address}")).map_err(|_| "invalid TURN_URLS")?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.fragment().is_some()
        || !matches!(
            url.query(),
            None | Some("transport=tcp") | Some("transport=udp")
        )
        || (scheme == "turns" && url.query() == Some("transport=udp"))
        || address.contains('/')
        || url.port() == Some(0)
    {
        return Err("invalid TURN_URLS".into());
    }
    Ok(raw.into())
}

/// Issue credentials only after current domain membership and session ownership are checked.
///
/// # Errors
/// Rejects pending, disconnected, revoked, expired or stale sessions and clock failures.
pub(super) fn configuration(
    service: &Service,
    stamp: &SessionStamp,
) -> Result<Value, &'static str> {
    session::snapshot(service, stamp)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "unavailable")?
        .as_secs();
    service.config.turn.issue(&stamp.session_id, now)
}

#[cfg(test)]
mod tests;
