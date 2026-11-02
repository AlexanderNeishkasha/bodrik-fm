//! Fixed-recipient Telegram transport and bounded, rate-limited single-owner delivery.

use crate::webhook::Alert;
use reqwest::Client;
use serde::Deserialize;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};

/// Suppression interval for repeated alerts from one rule/container pair.
const COOLDOWN: Duration = Duration::from_secs(300);
/// Minimum interval between unrelated messages; only one worker sends to Telegram.
const SEND_INTERVAL: Duration = Duration::from_secs(5);
/// Maximum remembered grouping keys, independent of incoming container/rule churn.
const MAX_GROUPS: usize = 256;

/// Transport credentials are private and cannot be overridden by a webhook.
pub(crate) struct Telegram {
    /// HTTPS client with redirects and environment proxies disabled.
    client: Client,
    /// Fixed Telegram sendMessage endpoint containing the validated bot token; never logged.
    endpoint: String,
    /// Canonical positive numeric private-user identifier, never a channel/group/username.
    user: i64,
}

/// Small Telegram response subset; arbitrary returned message/user content is ignored.
#[derive(Deserialize)]
struct Reply {
    /// Telegram's application-level acknowledgement, checked even on HTTP 200.
    ok: bool,
}

impl Telegram {
    /// Validate the sole recipient and build a verified-TLS Telegram transport.
    ///
    /// # Errors
    /// Returns sanitized configuration/client errors; never includes credential values.
    pub(crate) fn new(token: &str, user: &str) -> Result<Self, &'static str> {
        let user = recipient(user)?;
        let (id, secret) = token.split_once(':').ok_or("invalid TELEGRAM_BOT_TOKEN")?;
        if id.is_empty()
            || !id.bytes().all(|ch| ch.is_ascii_digit())
            || secret.len() < 16
            || secret.len() > 128
            || !secret
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || b"_-".contains(&ch))
        {
            return Err("invalid TELEGRAM_BOT_TOKEN");
        }
        let client = Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "could not initialize Telegram TLS client")?;
        Ok(Self {
            client,
            endpoint: format!("https://api.telegram.org/bot{token}/sendMessage"),
            user,
        })
    }

    /// Send plain text to the configured user only; check HTTP and Telegram acknowledgements.
    /// No automatic retry follows an ambiguous timeout, avoiding blind duplicate sends.
    ///
    /// # Errors
    /// Returns sanitized transport, HTTP, response-limit, JSON or API rejection errors.
    async fn send(&self, text: &str) -> Result<(), &'static str> {
        let mut response = self
            .client
            .post(&self.endpoint)
            .json(&serde_json::json!({
                "chat_id": self.user,
                "text": text,
                "link_preview_options": { "is_disabled": true }
            }))
            .send()
            .await
            .map_err(|_| "Telegram request failed or timed out")?;
        if !response.status().is_success() {
            return Err("Telegram returned a non-success HTTP status");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Telegram response read failed")?
        {
            if bytes.len() + chunk.len() > 16 * 1024 {
                return Err("Telegram response exceeded limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        let reply: Reply =
            serde_json::from_slice(&bytes).map_err(|_| "Telegram response was invalid")?;
        if !reply.ok {
            return Err("Telegram rejected the message");
        }
        Ok(())
    }
}

/// Parse a private-user ID, rejecting group IDs, usernames, whitespace and overflow.
///
/// # Errors
/// Returns a fixed configuration error for anything other than a positive decimal i64.
fn recipient(value: &str) -> Result<i64, &'static str> {
    if value.is_empty() || !value.bytes().all(|ch| ch.is_ascii_digit()) {
        return Err("TELEGRAM_USER_ID must be a positive numeric private user ID");
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or("TELEGRAM_USER_ID must be a positive numeric private user ID")
}

/// One grouping entry; failed attempts also cool down to prevent notification failure storms.
struct Group {
    /// Last attempted delivery time, measured monotonically.
    attempted: Instant,
    /// Number of subsequent matching events suppressed within the cooldown.
    suppressed: u32,
}

/// Single-owner grouping state, never shared or synchronized across async tasks.
#[derive(Default)]
struct Groups {
    /// Bounded rule/container entries, each containing only operational identifiers.
    entries: HashMap<(String, String), Group>,
}

impl Groups {
    /// Reserve an attempt or suppress a repeat; evict the oldest key when capacity is reached.
    fn admit(&mut self, alert: &Alert, now: Instant) -> Option<u32> {
        let key = (alert.rule.clone(), alert.container.clone());
        if let Some(group) = self.entries.get_mut(&key) {
            if now.duration_since(group.attempted) < COOLDOWN {
                group.suppressed = group.suppressed.saturating_add(1);
                return None;
            }
            let count = group.suppressed;
            *group = Group {
                attempted: now,
                suppressed: 0,
            };
            return Some(count);
        }
        if self.entries.len() >= MAX_GROUPS
            && let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, group)| group.attempted)
                .map(|(key, _)| key.clone())
        {
            self.entries.remove(&oldest);
        }
        self.entries.insert(
            key,
            Group {
                attempted: now,
                suppressed: 0,
            },
        );
        Some(0)
    }
}

/// Own queue consumption, grouping and rate limits until shutdown; no locks span network awaits.
/// Delivery is best-effort: failures are logged, not reported as successful Telegram deliveries.
pub(crate) async fn work(
    mut queue: mpsc::Receiver<Alert>,
    telegram: Option<Telegram>,
    mut stop: watch::Receiver<bool>,
) {
    let Some(telegram) = telegram else {
        // Closing admission prevents stale/custom local rules from acknowledging delivery.
        queue.close();
        if !*stop.borrow() {
            let _ = stop.changed().await;
        }
        return;
    };
    let mut groups = Groups::default();
    let mut next_send = tokio::time::Instant::now();
    loop {
        if *stop.borrow() {
            return;
        }
        let alert = tokio::select! {
            _ = stop.changed() => return,
            value = queue.recv() => match value { Some(value) => value, None => return },
        };
        let Some(suppressed) = groups.admit(&alert, Instant::now()) else {
            continue;
        };
        tokio::select! {
            _ = stop.changed() => return,
            _ = tokio::time::sleep_until(next_send) => {}
        }
        let text = alert.text(suppressed);
        let result = tokio::select! {
            _ = stop.changed() => return,
            result = telegram.send(&text) => result,
        };
        next_send = tokio::time::Instant::now() + SEND_INTERVAL;
        match result {
            Ok(()) => {
                tracing::info!(rule = %alert.rule, container = %alert.container, "Telegram alert delivered")
            }
            Err(error) => {
                tracing::warn!(rule = %alert.rule, container = %alert.container, error, "Telegram alert delivery failed; inspect Dozzle")
            }
        }
    }
}

/// Configuration, grouping and mocked HTTP delivery acceptance.
#[cfg(test)]
mod tests;
