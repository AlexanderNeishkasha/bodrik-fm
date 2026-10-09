//! Narrow private player authority client; no shared database or player implementation dependency.

mod chat;
mod request_budget;
pub mod services;
pub use chat::ChatClaims;

use crate::media::protocol::identifier;
use reqwest::Client;
use serde::Deserialize;
use std::{sync::Arc, time::Duration};
use url::Url;

/// Maximum accepted player grant lifetime, matching the private authority contract.
const MAX_GRANT_SECONDS: u32 = 60;

/// Fresh authoritative lease; room/session state remains owned by the meeting runtime.
#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    /// Private interservice wire version.
    pub version: u8,
    /// Exact current conference binding, never an authorization from a public slug alone.
    pub conference_id: String,
    /// Player-persisted revocation generation.
    pub generation: u64,
    /// Current public invitation slug.
    pub room_slug: String,
    /// Maximum permitted positive cache lifetime for existing sessions.
    pub lease_seconds: u32,
}

/// Authoritative queue-free playback state for one currently enabled conference.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Playback {
    /// Process-local change identity; equality, not ordering, determines continuity.
    pub revision: usize,
    /// Selected output surface.
    pub output: String,
    /// Meeting-wide master gain.
    pub volume: f64,
    /// Whether the current source advances.
    pub is_playing: bool,
    /// Current authoritative position in seconds.
    pub position: f64,
    /// Current room-owned media descriptor.
    pub track: Option<PlaybackTrack>,
}

/// Bounded current-track descriptor from the private player.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybackTrack {
    /// Stable room track identifier.
    pub id: String,
    /// Display-only title.
    pub title: String,
    /// Optional duration in seconds.
    pub duration: Option<f64>,
    /// Same-player-origin original media path.
    pub media_url: String,
}

/// Separate credential/address scope from Node media authentication.
#[derive(Clone)]
pub struct PlayerClient {
    /// Optional direct host services; all transport methods delegate when embedded.
    services: Option<Arc<dyn services::Services>>,
    /// Pooled, bounded nonredirecting HTTP transport.
    http: Client,
    /// Fixed trusted private player base; no caller-selected host/path/query.
    base: Url,
    /// Independent server credential, deliberately without Debug output.
    secret: Arc<str>,
    /// Bounded concurrent authority queries, independently of music polling.
    requests: Arc<tokio::sync::Semaphore>,
    /// Bounded requests awaiting an authority permit.
    pending: Arc<tokio::sync::Semaphore>,
    /// Independent playback query budget so broadcasts cannot silence music.
    playback_requests: Arc<tokio::sync::Semaphore>,
}

impl PlayerClient {
    /// Construct direct host integration; the standalone HTTP adapter is never used.
    pub fn embedded(services: Arc<dyn services::Services>) -> Result<Self, String> {
        let mut client = Self::new(
            "http://127.0.0.1:3001",
            "embedded-unused-service-credential-32",
        )?;
        client.services = Some(services);
        Ok(client)
    }

    /// Subscribe to host playback commits; standalone deployments retain HTTP reconciliation.
    pub fn playback_changes(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        self.services
            .as_ref()
            .map(|services| services.playback_changes())
    }

    /// Resolve original media locally when embedded, or through the standalone player origin.
    pub fn media_source(&self, reference: &str) -> Result<String, String> {
        match &self.services {
            Some(services) => services.media_source(reference),
            None => self.media_url(reference).map(|url| url.into()),
        }
    }

    /// Build a validated local interservice transport.
    ///
    /// # Errors
    /// Rejects invalid HTTP bases and non-bearer-safe credentials.
    pub fn new(base: &str, secret: &str) -> Result<Self, String> {
        let base = Url::parse(base).map_err(|_| "invalid player service URL")?;
        if base.scheme() != "http"
            || !base.has_host()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.path() != "/"
            || base.query().is_some()
            || base.fragment().is_some()
            || !(32..=256).contains(&secret.len())
            || !secret.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        {
            return Err("invalid player authority configuration".into());
        }
        let http = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(8))
            .pool_max_idle_per_host(8)
            .build()
            .map_err(|_| "player authority client initialization failed")?;
        Ok(Self {
            services: None,
            http,
            base,
            secret: Arc::from(secret),
            requests: Arc::new(tokio::sync::Semaphore::new(8)),
            pending: Arc::new(tokio::sync::Semaphore::new(64)),
            playback_requests: Arc::new(tokio::sync::Semaphore::new(2)),
        })
    }

    /// Obtain a fresh authoritative admission decision; no cached-token or unavailable-service fallback.
    ///
    /// # Errors
    /// Returns sanitized transport/schema/size errors. Disabled/revoked/missing mappings return None.
    pub async fn authorize(&self, id: &str) -> Result<Option<Grant>, String> {
        if !identifier(id) {
            return Err("invalid conference binding".into());
        }
        if let Some(services) = &self.services {
            return services.authorize(id.to_owned()).await;
        }
        let _permit = request_budget::acquire(&self.requests, &self.pending).await?;
        let mut endpoint = self.base.clone();
        endpoint.set_path(&format!("/api/internal/conferences/{id}/admission"));
        let mut response = self
            .http
            .get(endpoint)
            .bearer_auth(self.secret.as_ref())
            .send()
            .await
            .map_err(|_| "player admission request failed")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status() != reqwest::StatusCode::OK {
            return Err("player admission rejected or unavailable".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "player admission body failed")?
        {
            if chunk.len() > 4096_usize.saturating_sub(bytes.len()) {
                return Err("player admission response exceeded budget".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let grant: Grant =
            serde_json::from_slice(&bytes).map_err(|_| "invalid player admission response")?;
        if grant.version != 1
            || grant.conference_id != id
            || grant.generation > 9_007_199_254_740_991
            || grant.room_slug.is_empty()
            || grant.room_slug.len() > 160
            || !identifier(&grant.room_slug)
            || !(1..=MAX_GRANT_SECONDS).contains(&grant.lease_seconds)
        {
            return Err("invalid player admission binding or lifetime".into());
        }
        Ok(Some(grant))
    }

    /// Obtain the current no-store playback snapshot for one private conference mapping.
    ///
    /// # Errors
    /// Returns sanitized transport/status/schema/size or unsafe media-path failures.
    pub async fn playback(&self, id: &str) -> Result<Option<Playback>, String> {
        if !identifier(id) {
            return Err("invalid conference binding".into());
        }
        if let Some(services) = &self.services {
            return services.playback(id.to_owned()).await;
        }
        let _permit = self
            .playback_requests
            .clone()
            .try_acquire_owned()
            .map_err(|_| "player playback capacity exhausted")?;
        let mut endpoint = self.base.clone();
        endpoint.set_path(&format!("/api/internal/conferences/{id}/music"));
        let response = self
            .http
            .get(endpoint)
            .bearer_auth(self.secret.as_ref())
            .send()
            .await
            .map_err(|_| "player playback request failed")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status() != reqwest::StatusCode::OK {
            return Err("player playback rejected or unavailable".into());
        }
        let bytes = bounded_body(response, 16 * 1024).await?;
        let playback: Playback =
            serde_json::from_slice(&bytes).map_err(|_| "invalid player playback response")?;
        validate_playback(&playback, &self.base)?;
        Ok(Some(playback))
    }

    /// Resolve one already-validated player-owned media path against the fixed private base.
    ///
    /// # Errors
    /// Rejects paths that do not remain on the configured player origin and `/media/` namespace.
    pub fn media_url(&self, path: &str) -> Result<Url, String> {
        let media = self
            .base
            .join(path)
            .map_err(|_| "invalid player media URL")?;
        if media.origin() != self.base.origin()
            || !media.path().starts_with("/media/")
            || media.query().is_some()
            || media.fragment().is_some()
        {
            return Err("invalid player media URL".into());
        }
        Ok(media)
    }
}

/// Read one response without trusting Content-Length.
async fn bounded_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "player response body failed")?
    {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err("player response exceeded budget".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Validate finite playback values and same-origin media ownership.
fn validate_playback(playback: &Playback, base: &Url) -> Result<(), String> {
    if !matches!(playback.output.as_str(), "studio" | "conference")
        || !playback.volume.is_finite()
        || !(0.0..=1.0).contains(&playback.volume)
        || !playback.position.is_finite()
        || playback.position < 0.0
    {
        return Err("invalid player playback state".into());
    }
    if let Some(track) = &playback.track {
        if !identifier(&track.id)
            || track.title.len() > 1024
            || track
                .duration
                .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err("invalid player playback track".into());
        }
        let media = base
            .join(&track.media_url)
            .map_err(|_| "invalid player media URL")?;
        if media.origin() != base.origin()
            || !media.path().starts_with("/media/")
            || media.query().is_some()
            || media.fragment().is_some()
        {
            return Err("invalid player media URL".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Wire-contract tests for private player responses.

    use super::Playback;

    /// Accepts the camel-case playback and track fields emitted by the player backend.
    #[test]
    fn playback_wire_shape_accepts_camel_case_track() {
        let playback: Playback = serde_json::from_value(serde_json::json!({
            "revision": 3,
            "output": "conference",
            "volume": 0.03,
            "isPlaying": true,
            "position": 116.8,
            "track": {
                "id": "61",
                "title": "Magical Whimsical.mp3",
                "duration": 3640.104,
                "mediaUrl": "/media/example.mp3"
            }
        }))
        .expect("camel-case playback response should deserialize");

        let track = playback.track.expect("track should be present");
        assert_eq!(track.media_url, "/media/example.mp3");
        assert!(playback.is_playing);
    }
}
