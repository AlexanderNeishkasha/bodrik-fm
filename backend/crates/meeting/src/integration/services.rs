//! Typed host application ports; embedded meetings never call their host over HTTP.
use super::{Grant, Playback};
use axum::body::Body;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{future::Future, pin::Pin};
use tokio::sync::watch;

/// Object-safe asynchronous application operation, without a macro dependency.
pub type Operation<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Trusted identity captured from an admitted meeting session, never browser headers.
pub struct ChatIdentity {
    /// Exact private provider mapping.
    pub conference: String,
    /// Durable authority generation.
    pub generation: u64,
    /// Verified stable sender identity.
    pub actor: String,
    /// Role verified by the current meeting runtime.
    pub presenter: bool,
}

/// Validated-at-storage message submission with no caller-selected actor or role.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Submission {
    /// Retry idempotency identity.
    pub client_id: String,
    /// Server-snapshotted name.
    pub name: String,
    /// Server-snapshotted local avatar.
    pub avatar: String,
    /// Message text or attachment caption.
    pub text: String,
    /// Optional same-room staged attachment.
    pub attachment_id: Option<String>,
}

/// Explicit chat capability; no generic URL, method or header dispatch.
pub enum ChatOperation {
    /// Read retained messages before the optional exclusive sequence.
    History(Option<i64>),
    /// Commit a message before broadcasting it.
    Append(Submission),
    /// Delete one sender/presenter-owned message.
    Delete(i64),
    /// Authorize metadata for a same-room immutable attachment.
    Attachment(String),
}

/// Bounded attachment stream; storage validates metadata and actual bytes independently.
pub struct Upload {
    /// Percent-encoded original display name, with no filesystem semantics.
    pub encoded_name: String,
    /// Claimed content type; raster signatures must also match.
    pub media_type: String,
    /// Declared exact byte count.
    pub size: u64,
    /// Streamed bytes, never an entire buffered file.
    pub body: Body,
}

/// Application-owned authority, playback and storage operations injected into meetings.
pub trait Services: Send + Sync {
    /// Obtain a fresh grant; missing/revoked bindings return None, failures stay closed.
    fn authorize(&self, id: String) -> Operation<'_, Result<Option<Grant>, String>>;
    /// Read authoritative queue-free playback for the current enabled mapping.
    fn playback(&self, id: String) -> Operation<'_, Result<Option<Playback>, String>>;
    /// Resolve a trusted original media reference into a local FFmpeg input path.
    fn media_source(&self, reference: &str) -> Result<String, String>;
    /// Subscribe to coalesced committed playback changes; snapshots remain authoritative.
    fn playback_changes(&self) -> watch::Receiver<u64>;
    /// Execute one storage capability with fresh generation and ownership validation.
    fn chat(
        &self,
        who: ChatIdentity,
        operation: ChatOperation,
    ) -> Operation<'_, Result<Value, &'static str>>;
    /// Stream and publish one attachment after fresh authority checks.
    fn upload(
        &self,
        who: ChatIdentity,
        upload: Upload,
    ) -> Operation<'_, Result<Value, &'static str>>;
}

/// Direct delegation regression cases do not bind any HTTP listener.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::integration::{ChatClaims, PlayerClient};
    use std::sync::Arc;

    /// Deterministic host implementation with no network fallback.
    struct Host {
        /// Coalesced application commit signal.
        changes: watch::Sender<u64>,
    }
    impl Services for Host {
        /// Return only the enabled synthetic mapping.
        fn authorize(&self, id: String) -> Operation<'_, Result<Option<Grant>, String>> {
            Box::pin(async move {
                Ok((id == "room").then(|| Grant {
                    version: 1,
                    conference_id: id,
                    generation: 2,
                    room_slug: "table".into(),
                    lease_seconds: 60,
                }))
            })
        }
        /// No track is selected in this fixture.
        fn playback(&self, _: String) -> Operation<'_, Result<Option<Playback>, String>> {
            Box::pin(async { Ok(None) })
        }
        /// Resolve only a trusted local media reference.
        fn media_source(&self, reference: &str) -> Result<String, String> {
            if reference == "/media/tone.wav" {
                Ok("/uploads/tone.wav".into())
            } else {
                Err("invalid".into())
            }
        }
        /// Clone the bounded latest-commit subscription.
        fn playback_changes(&self) -> watch::Receiver<u64> {
            self.changes.subscribe()
        }
        /// Expose the captured actor for delegation verification.
        fn chat(
            &self,
            who: ChatIdentity,
            _: ChatOperation,
        ) -> Operation<'_, Result<Value, &'static str>> {
            Box::pin(async move { Ok(serde_json::json!({"actor":who.actor})) })
        }
        /// Consume the stream under the declared fixture byte budget.
        fn upload(
            &self,
            _: ChatIdentity,
            upload: Upload,
        ) -> Operation<'_, Result<Value, &'static str>> {
            Box::pin(async move {
                let bytes = axum::body::to_bytes(upload.body, 8)
                    .await
                    .map_err(|_| "capacity")?;
                Ok(serde_json::json!({"size":bytes.len()}))
            })
        }
    }

    /// Every direct capability works with no listening player, and commits coalesce.
    #[tokio::test]
    async fn embedded_capabilities_do_not_use_http() {
        let host = Arc::new(Host {
            changes: watch::channel(0).0,
        });
        let player = PlayerClient::embedded(host.clone()).expect("direct client");
        for (name, id, granted) in [("enabled", "room", true), ("revoked", "retired", false)] {
            assert_eq!(
                player.authorize(id).await.expect(name).is_some(),
                granted,
                "{name}"
            );
        }
        assert!(player.playback("room").await.expect("snapshot").is_none());
        assert_eq!(
            player.media_source("/media/tone.wav").expect("local"),
            "/uploads/tone.wav"
        );
        assert!(player.media_source("http://foreign/file").is_err());
        let who = ChatClaims {
            conference: "room",
            generation: 2,
            actor: "verified",
            presenter: false,
        };
        assert_eq!(
            player
                .chat(&who, ChatOperation::History(None))
                .await
                .expect("chat")["actor"],
            "verified"
        );
        assert_eq!(
            player
                .upload(
                    &who,
                    Upload {
                        encoded_name: "file".into(),
                        media_type: "text/plain".into(),
                        size: 3,
                        body: Body::from("abc")
                    }
                )
                .await
                .expect("stream")["size"],
            3
        );
        let mut changes = player.playback_changes().expect("events");
        host.changes.send_replace(1);
        host.changes.send_replace(2);
        changes.changed().await.expect("commit");
        assert_eq!(*changes.borrow_and_update(), 2);
    }
}
