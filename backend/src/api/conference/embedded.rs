//! Private host implementation of the public meeting application's typed ports.
use super::{admission, chat, music_bridge};
use crate::api::{AppState, media};
use meeting_backend::integration::{Grant, Playback, PlaybackTrack, services::*};
use serde_json::Value;
use tokio::sync::watch;

/// One host adapter, retaining authoritative state rather than an independent room cache.
pub(crate) struct HostServices {
    /// Backend-owned SQLite and playback runtime.
    app: AppState,
    /// Existing persistent storage and upload concurrency owner.
    chat: chat::ChatState,
}

impl HostServices {
    /// Compose direct host services after persistence has initialized.
    pub(crate) fn new(app: AppState, chat: chat::ChatState) -> Self {
        Self { app, chat }
    }
}

impl Services for HostServices {
    /// Fresh room entitlement and mapping lookup; no network, request queue or positive cache.
    fn authorize(&self, id: String) -> Operation<'_, Result<Option<Grant>, String>> {
        Box::pin(async move {
            admission::grant(&self.app, id)
                .await?
                .map(|grant| {
                    Ok(Grant {
                        version: grant.version,
                        conference_id: grant.conference_id,
                        generation: u64::try_from(grant.generation)
                            .map_err(|_| "invalid generation")?,
                        room_slug: grant.room_slug,
                        lease_seconds: grant.lease_seconds,
                    })
                })
                .transpose()
        })
    }
    /// Read playback through the same authority recheck as the standalone bridge.
    fn playback(&self, id: String) -> Operation<'_, Result<Option<Playback>, String>> {
        Box::pin(async move {
            Ok(music_bridge::current(&self.app, id)
                .await?
                .map(|value| Playback {
                    revision: value.revision,
                    output: value.output,
                    volume: value.volume,
                    is_playing: value.is_playing,
                    position: value.position,
                    track: value.track.map(|track| PlaybackTrack {
                        id: track.id,
                        title: track.title,
                        duration: track.duration,
                        media_url: track.media_url,
                    }),
                }))
        })
    }
    /// Restrict FFmpeg input to a validated single-component original media key.
    fn media_source(&self, reference: &str) -> Result<String, String> {
        let key = media_key(reference)?;
        media::media_path(&self.app, &key)
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| "invalid media path".into())
    }
    /// Bounded latest-state wake-up; slow consumers repair through fresh snapshots.
    fn playback_changes(&self) -> watch::Receiver<u64> {
        self.app.playback_observer.changes()
    }
    /// Persisted chat capabilities use the current mapping and sender/presenter assertions.
    fn chat(
        &self,
        who: ChatIdentity,
        operation: ChatOperation,
    ) -> Operation<'_, Result<Value, &'static str>> {
        Box::pin(async move {
            chat::direct::execute(&self.chat, who, operation)
                .await
                .map_err(sanitize)
        })
    }
    /// Storage owns quotas, raster validation, publication and cancellation cleanup.
    fn upload(
        &self,
        who: ChatIdentity,
        upload: Upload,
    ) -> Operation<'_, Result<Value, &'static str>> {
        Box::pin(async move {
            tokio::time::timeout(
                std::time::Duration::from_secs(300),
                chat::direct::upload(&self.chat, who, upload),
            )
            .await
            .map_err(|_| "unavailable")?
            .map_err(sanitize)
        })
    }
}

/// Decode only backend-generated original-file references, rejecting remote/protocol/traversal input.
///
/// # Errors
/// Returns invalid reference/encoding/storage-key errors before process construction.
fn media_key(reference: &str) -> Result<String, String> {
    let encoded = reference
        .strip_prefix("/media/")
        .filter(|v| !v.contains(['?', '#']))
        .ok_or("invalid media reference")?;
    let key = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| "invalid media encoding")?;
    if !media::valid_storage_key(&key) {
        return Err("invalid media key".into());
    }
    Ok(key.into_owned())
}

/// Preserve stable browser error categories while retaining internal diagnostics server-side.
fn sanitize(error: String) -> &'static str {
    match error.as_str() {
        "invalid" => "invalid",
        "denied" => "denied",
        "gone" => "gone",
        "capacity" => "capacity",
        "unavailable" => "unavailable",
        _ => {
            tracing::error!(%error, "embedded chat operation failed");
            "unavailable"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// FFmpeg cannot receive URLs, traversal, option-shaped paths or encoded separators.
    #[test]
    fn media_reference_cases() {
        for (name, reference, valid) in [
            ("original", "/media/song.mp3", true),
            ("unicode", "/media/%D0%A4%D0%B0%D0%B9%D0%BB.mp3", true),
            ("remote", "http://host/file", false),
            ("parent", "/media/../private", false),
            ("encoded separator", "/media/a%2Fb", false),
            ("query", "/media/song?token=x", false),
            ("drive", "/media/C%3Asecret", false),
        ] {
            assert_eq!(media_key(reference).is_ok(), valid, "{name}");
        }
    }
}
