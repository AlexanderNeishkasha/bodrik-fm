//! Studio HTTP entry points, separated by authorization, playback, preferences and media ownership.
//! Re-exports retain the existing route consumers and shared Studio identity paths.

mod auth;
mod context;
mod playback;
mod preferences;
mod queue;
mod tracks;
mod types;
mod upload;

pub use auth::StudioAsQuery;
pub(crate) use auth::{
    resolve_studio_user, studio_user_error_status, studio_user_from_http,
    studio_user_from_http_async,
};
pub(crate) use context::db_task;
pub use playback::{pause, play_track, resume, seek, set_repeat, skip};
pub use preferences::{set_room_listed, set_room_slug, set_theme};
pub use queue::{force_play, insert_track, queue_track, remove_from_queue, reorder_queue};
pub use tracks::{delete_track, rename_track, tracks};
pub(crate) use upload::UPLOAD_BODY_LIMIT;
pub use upload::upload;
