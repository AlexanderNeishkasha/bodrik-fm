//! Authenticated, bounded webhook admission; recipients and arbitrary messages are never accepted.

use axum::{
    body::Bytes,
    extract::State as ExtractState,
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;

/// Private admission state shared by HTTP handlers.
#[derive(Clone)]
pub(crate) struct State {
    /// Random per-start token also passed to Dozzle, never logged or persisted.
    pub(crate) secret: String,
    /// Bounded delivery queue, independent of backend requests and Dozzle dispatch latency.
    pub(crate) queue: mpsc::Sender<Alert>,
}

/// Minimal template contract, deliberately excluding recipient overrides and raw log content.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Alert {
    /// Human-readable Dozzle rule name, used for grouping and notification context.
    pub(crate) rule: String,
    /// Docker container name, used to identify the affected service.
    pub(crate) container: String,
    /// Optional structured HTTP status; explicit client errors are not operational alerts.
    #[serde(default)]
    pub(crate) status: Option<u16>,
}

impl Alert {
    /// Require short operational identifiers, not arbitrary text, URLs or control characters.
    pub(crate) fn valid(&self) -> bool {
        [&self.rule, &self.container].iter().all(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || " ._-".contains(ch))
                && !value.trim().is_empty()
        }) && self
            .status
            .is_none_or(|status| (100..=599).contains(&status))
    }

    /// Suppress explicit HTTP client errors without matching ambiguous strings such as "404".
    pub(crate) fn ignored(&self) -> bool {
        self.status
            .is_some_and(|status| (400..500).contains(&status))
    }

    /// Build bounded plain text from operational identifiers only, never raw downloader diagnostics.
    pub(crate) fn text(&self, suppressed: u32) -> String {
        let mut text = format!(
            "Bodrik FM alert\nRule: {}\nContainer: {}\nInspect Dozzle for details.",
            self.rule, self.container
        );
        if suppressed > 0 {
            text.push_str(&format!("\nRepeated alerts suppressed: {suppressed}"));
        }
        text
    }
}

/// Authenticate before JSON parsing, reject recipient fields, and enqueue without awaiting Telegram.
/// Returns 503 on saturation so failure is visible instead of claiming successful delivery.
pub(crate) async fn receive(
    ExtractState(state): ExtractState<State>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let provided = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if !provided.is_some_and(|value| bool::from(value.as_bytes().ct_eq(state.secret.as_bytes()))) {
        return StatusCode::UNAUTHORIZED;
    }
    let alert: Alert = match serde_json::from_slice(&body) {
        Ok(alert) => alert,
        Err(_) => return StatusCode::BAD_REQUEST,
    };
    if !alert.valid() {
        return StatusCode::BAD_REQUEST;
    }
    if alert.ignored() {
        return StatusCode::NO_CONTENT;
    }
    match state.queue.try_send(alert) {
        Ok(()) => StatusCode::ACCEPTED,
        Err(_) => {
            tracing::warn!("alert delivery queue full or unavailable");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

/// Admission decisions and recipient-override rejection, with no external services.
#[cfg(test)]
mod tests;
