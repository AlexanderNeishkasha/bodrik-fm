//! Native results stay typed until a public browser reply needs JSON.
use serde_json::{Value, json};

/// Native music destination passed directly to the application-owned FFmpeg process.
pub struct MusicDestination {
    /// Exact producer handle used for projection and cancelled-allocation cleanup.
    pub producer_id: String,
    /// Bound RTP receiver port selected by the native transport.
    pub port: u16,
}

/// Typed lifecycle acknowledgments and native destinations alongside browser media JSON.
pub enum Reply {
    /// Lifecycle or state operation completed without a payload.
    Empty,
    /// Native music receiver allocation; never parsed back from JSON by the application.
    Music(MusicDestination),
    /// Browser-visible RTP, DTLS, source inventory or resource descriptor.
    Browser(Value),
}

impl Reply {
    /// Encode only when producing a browser-facing value or a public-shape assertion.
    pub fn into_json(self) -> Value {
        match self {
            Self::Empty => json!({}),
            Self::Music(value) => json!({"producerId":value.producer_id,"port":value.port}),
            Self::Browser(value) => value,
        }
    }
}
