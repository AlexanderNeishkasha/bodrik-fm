//! Bounded, nonredirecting replacement-control client for durable conference retirement.

use super::Config;
use std::{sync::LazyLock, time::Duration};

/// Reuse connections without forwarding the independent control bearer across redirects.
static CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "replacement control client initialization failed".into())
});

/// Terminate a retired provider target through the authoritative replacement runtime.
///
/// # Errors
/// Returns sanitized configuration, client, request or unsuccessful-status errors.
pub async fn end_conference(config: &Config, room: &str) -> Result<(), String> {
    let mut endpoint = control_url(&config.replacement_url)?;
    endpoint
        .path_segments_mut()
        .map_err(|_| "invalid replacement control URL")?
        .extend(["internal", "replacement", "v1", "conferences", room]);
    let status = CLIENT
        .as_ref()
        .map_err(Clone::clone)?
        .delete(endpoint)
        .bearer_auth(&config.replacement_secret)
        .send()
        .await
        .map_err(|_| "replacement termination request failed")?
        .status();
    if terminated(status) {
        return Ok(());
    }
    Err(format!("replacement termination returned {status}"))
}

/// Parse a credential-free private HTTP control base with no path/query ambiguity.
///
/// # Errors
/// Rejects non-HTTP, credentialed, path-prefixed or otherwise ambiguous bases.
fn control_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| "invalid replacement control URL")?;
    if url.scheme() != "http"
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("invalid replacement control URL".into());
    }
    Ok(url)
}

/// Treat only success and already-missing resources as successful termination.
fn terminated(status: reqwest::StatusCode) -> bool {
    status.is_success() || status == reqwest::StatusCode::NOT_FOUND
}

#[cfg(test)]
mod integration_tests;

#[cfg(test)]
mod tests {
    use super::*;

    /// Control bases and idempotent response statuses stay explicit.
    #[test]
    fn control_contract_cases() {
        for (name, raw, valid) in [
            ("valid", "http://127.0.0.1:3020", true),
            ("tls unsupported", "https://meeting:3020", false),
            ("credentials", "http://user:pass@meeting:3020", false),
            ("path", "http://meeting:3020/control", false),
            ("query", "http://meeting:3020/?x=1", false),
        ] {
            assert_eq!(control_url(raw).is_ok(), valid, "{name}");
        }
        for (code, accepted) in [
            (200, true),
            (204, true),
            (404, true),
            (403, false),
            (500, false),
        ] {
            assert_eq!(
                terminated(reqwest::StatusCode::from_u16(code).expect("status")),
                accepted,
                "{code}"
            );
        }
    }
}
