//! Sanitized native failures shared by the domain and resource owner.
use super::protocol::ErrorCode;
use std::fmt;

/// Sanitized native failures; provider text and participant credentials are never formatted.
#[derive(Debug)]
pub enum MediaError {
    /// Invalid ownership binding, resource handle or unbounded native parameter.
    InvalidCommand,
    /// Local concurrency capacity exhausted.
    Busy,
    /// Native execution failed; mutating command outcome may be unknown.
    Transport,
    /// Native data could not be represented by the expected type.
    Protocol,
    /// Worker boot/sequence changed or the stream ended; reconcile before further assumptions.
    ReconcileRequired,
    /// Known sanitized native rejection.
    Rejected(ErrorCode),
}

impl fmt::Display for MediaError {
    /// Format stable categories without including addresses, headers or provider payloads.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(code) => write!(formatter, "media command rejected: {code:?}"),
            other => write!(formatter, "native media failure: {other:?}"),
        }
    }
}

impl std::error::Error for MediaError {}
