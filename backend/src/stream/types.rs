//! Serialized playback contracts shared by Studio, players and conference snapshots.

use serde::Serialize;

/// Room-owned library entry with a relative media key, not an absolute server path.
#[derive(Debug, Clone, Serialize)]
pub struct TrackEntry {
    /// Canonical database track ID encoded as text.
    pub id: String,
    /// User-visible title.
    pub filename: String,
    /// Optional probed duration in seconds.
    pub duration: Option<f64>,
    /// Original-file storage key used in public media URLs.
    pub media_path: String,
    /// Optional library section identifier.
    pub section_id: Option<i64>,
    /// Authoritative library ordering key.
    pub sort_order: i64,
}

/// Authoritative room playback state copied under the playback lock.
#[derive(Debug, Clone, Serialize)]
pub struct PlayerState {
    /// Whether the current track advances with monotonic time.
    pub is_playing: bool,
    /// Current playback position in seconds.
    pub position: f64,
    /// Current entry, retained while paused.
    pub current: Option<TrackEntry>,
    /// Ordered entries waiting to play.
    pub queue: Vec<TrackEntry>,
    /// Whether natural completion repeats the current entry.
    pub repeat_one: bool,
}
