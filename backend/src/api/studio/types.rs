//! Studio request/response DTOs; wire field names remain unchanged.

/// A resolved room track requested for playback or queue insertion.
#[derive(serde::Deserialize)]
pub struct TrackRequest {
    /// Database track ID encoded as text.
    pub(super) id: String,
}

/// Insert a track at a queue position, appending past the end.
#[derive(serde::Deserialize)]
pub struct QueueInsertRequest {
    /// Room-owned track ID.
    pub(super) id: String,
    /// Desired queue position.
    pub(super) index: usize,
}

/// Reorder existing queue positions.
#[derive(serde::Deserialize)]
pub struct QueueReorderRequest {
    /// Existing source position.
    pub(super) from: usize,
    /// Existing destination position.
    pub(super) to: usize,
}

/// Remove or force-play one queued entry.
#[derive(serde::Deserialize)]
pub struct QueueRemoveRequest {
    /// Existing queue position.
    pub(super) index: usize,
}

/// Seek the current track without changing play/pause state.
#[derive(serde::Deserialize)]
pub struct SeekRequest {
    /// Finite position in seconds; negatives clamp to zero.
    pub(super) position: f64,
}

/// Natural-completion repeat policy.
#[derive(serde::Deserialize)]
pub struct RepeatPayload {
    /// Whether to restart the current track at EOF.
    pub(super) repeat_one: bool,
}

/// Authoritative room theme selection.
#[derive(serde::Deserialize)]
pub struct ThemePayload {
    /// Requested theme identifier.
    pub(super) theme: String,
}

/// Rename a non-current room track.
#[derive(serde::Deserialize)]
pub struct RenamePayload {
    /// Canonicalized database track identity.
    pub(super) id: String,
    /// New display title.
    pub(super) to: String,
}

/// Delete a non-current room track.
#[derive(serde::Deserialize)]
pub struct DeletePayload {
    /// Canonicalized database track identity.
    pub(super) id: String,
}

/// Change the owned room's public slug.
#[derive(serde::Deserialize)]
pub struct SlugPayload {
    /// Slug to normalize and persist.
    pub(super) slug: String,
}

/// Committed public slug response.
#[derive(serde::Serialize)]
pub(super) struct SlugResponse {
    /// Persisted slug.
    pub(super) slug: String,
}

/// Change public-directory visibility without changing direct-link access.
#[derive(serde::Deserialize)]
pub struct RoomListedPayload {
    /// Desired directory visibility.
    pub(super) listed: bool,
}

/// Committed visibility response.
#[derive(serde::Serialize)]
pub(super) struct RoomListedResponse {
    /// Persisted directory visibility.
    pub(super) listed: bool,
}
