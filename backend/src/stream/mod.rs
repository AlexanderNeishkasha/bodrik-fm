//! Playback domain contracts and explicitly owned automatic-advance supervision.

mod auto_advance;
mod streamer;
mod types;

pub use auto_advance::start_auto_advance;
pub use streamer::Streamer;
pub use types::{PlayerState, TrackEntry};
