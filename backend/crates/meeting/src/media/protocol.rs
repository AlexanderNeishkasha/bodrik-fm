//! Typed native ownership and browser media actions; commands stay inside the Rust process.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Integer bound shared with JavaScript to prevent identity truncation.
pub const JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Rust-issued native resource owner; the engine checks ownership, not admission policy.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    /// Private provider room identifier, never a public slug credential.
    pub room_id: String,
    /// Logical room incarnation; reused room names must not authorize old handles.
    pub room_instance_id: String,
    /// Server-issued participant identity.
    pub peer_id: String,
    /// Current admission incarnation, invalidated on replacement or revocation.
    pub admission_epoch: u64,
}

impl Binding {
    /// Validate wire identifiers and the JavaScript integer range before issuing a request.
    pub fn is_valid(&self) -> bool {
        identifier(&self.room_id)
            && identifier(&self.room_instance_id)
            && identifier(&self.peer_id)
            && (1..=JS_SAFE_INTEGER).contains(&self.admission_epoch)
    }
}

/// Wire-safe opaque ID; path separators and control characters are forbidden.
pub fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}

/// Mutually exclusive media commands with an explicit JSON operation/payload representation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    content = "payload",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    /// Explicitly allocate a router incarnation in the native resource owner.
    /// Never available through public participant media actions; does not admit a participant.
    CreateRoom(Empty),
    /// Allocate a native peer lease after Rust authorizes its lifecycle.
    /// The worker checks epoch monotonicity but cannot grant meeting membership.
    CreatePeer(Empty),
    /// Query mediasoup's router capabilities without allocating resources.
    Capabilities(Empty),
    /// Obtain participant-owned handles after event loss or an unknown request outcome.
    Inventory(Empty),
    /// Discover current same-room producer handles with exact native owners.
    Sources(Empty),
    /// Allocate the one server-owned music PlainTransport and Opus producer for this room.
    CreateMusic {
        /// Rust-selected RTP synchronization source.
        ssrc: u32,
    },
    /// Release the room's server-owned music transport and producer idempotently.
    CloseMusic(Empty),
    /// Allocate a WebRTC transport; the application deduplicates browser command IDs.
    CreateTransport(Empty),
    /// Supply browser DTLS parameters for a participant-owned transport.
    ConnectTransport {
        /// Participant-owned transport handle.
        #[serde(rename = "transportId")]
        transport_id: String,
        /// Mediasoup-validated DTLS object, not arbitrary domain settings.
        #[serde(rename = "dtlsParameters")]
        dtls_parameters: Value,
    },
    /// Request new ICE parameters for a participant-owned transport.
    RestartIce(Transport),
    /// Release one transport and its descendants.
    CloseTransport(Transport),
    /// Create a source after Rust admission/moderation authorization.
    Produce {
        /// Participant-owned sending transport.
        #[serde(rename = "transportId")]
        transport_id: String,
        /// Audio or video source kind.
        kind: MediaKind,
        /// Retained legacy media category, including screen audio/video.
        #[serde(rename = "mediaType")]
        media_type: MediaType,
        /// Mediasoup-validated RTP object.
        #[serde(rename = "rtpParameters")]
        rtp_parameters: Value,
    },
    /// Consume a producer belonging to the same media room.
    Consume {
        /// Participant-owned receiving transport.
        #[serde(rename = "transportId")]
        transport_id: String,
        /// Producer in this room, not a globally transferable capability.
        #[serde(rename = "producerId")]
        producer_id: String,
        /// Browser's RTP capabilities, interpreted only by mediasoup.
        #[serde(rename = "rtpCapabilities")]
        rtp_capabilities: Value,
        /// Retained category of the consumed source.
        #[serde(rename = "mediaType")]
        media_type: MediaType,
    },
    /// Release a participant-owned producer.
    CloseProducer(Producer),
    /// Pause an existing participant-owned producer.
    PauseProducer(Producer),
    /// Resume a producer only after current Rust moderation policy allows it.
    ResumeProducer(Producer),
    /// Pause only this viewer's participant-owned consumer; the producer stays live.
    PauseConsumer(Consumer),
    /// Resume a participant-owned consumer after the browser attaches it.
    ResumeConsumer(Consumer),
    /// Release a participant; host resolver must authorize this lifecycle command.
    ClosePeer(Empty),
    /// Retire a room; host resolver must explicitly authorize this broader operation.
    CloseRoom(Empty),
}

/// Explicit empty object for browser media action payloads.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

/// Participant-owned transport reference.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transport {
    /// Opaque transport handle.
    pub transport_id: String,
}

/// Participant-owned producer reference.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Producer {
    /// Opaque producer handle.
    pub producer_id: String,
}

/// Participant-owned consumer reference.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Consumer {
    /// Opaque consumer handle.
    pub consumer_id: String,
}

/// WebRTC source kind, with no stringly typed alternative.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    /// Microphone or screen audio.
    Audio,
    /// Camera or screen video.
    Video,
}

/// Categories retained by the existing Room/Peer implementation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum MediaType {
    /// Microphone source.
    #[serde(rename = "audioType")]
    Audio,
    /// Camera source.
    #[serde(rename = "videoType")]
    Video,
    /// Screen audio or video.
    #[serde(rename = "screenType")]
    Screen,
}

/// Server-issued in-process operation with exact ownership and a monotonic admission deadline.
#[derive(Clone, Debug)]
pub struct Command {
    /// Native worker incarnation; old commands cannot affect restarted resources.
    pub boot_id: String,
    /// Monotonic deadline prevents stale queued work from beginning after retirement.
    pub deadline: std::time::Instant,
    /// Current participant ownership scope.
    pub binding: Binding,
    /// Typed action; browser authorization happens before dispatch.
    pub operation: Operation,
}

impl Command {
    /// Issue one server-bound operation with a thirty-second monotonic start deadline.
    pub fn new(boot: &str, binding: &Binding, operation: Operation) -> Self {
        Self {
            boot_id: boot.into(),
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(30),
            binding: binding.clone(),
            operation,
        }
    }
}

/// Native incarnation discovery, never proof of meeting admission.
#[derive(Clone, Debug)]
pub struct Metadata {
    /// Current worker identity used to fence handles and commands.
    pub boot_id: String,
}

/// Known sanitized media service rejection codes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    /// Revoked, replaced, missing or lobby participant.
    UnauthorizedSession,
    /// Wrong wire schema or parameters.
    InvalidRequest,
    /// Worker restarted; old native handles cannot affect new resources.
    StaleBoot,
    /// Monotonic command deadline expired before dispatch.
    RequestExpired,
    /// Participant-owned resource is missing.
    ResourceNotFound,
    /// The native room or peer lease already exists, or its epoch cannot be reused.
    ResourceConflict,
    /// Native handle or retained-incarnation capacity exhausted; no allocation occurred.
    ResourceCapacity,
    /// Same-room producer ended before consumer creation; retained browser code distinguishes this race.
    ProducerNotFound,
    /// Sanitized provider operational failure; its outcome may need readback.
    MediaFailure,
}
