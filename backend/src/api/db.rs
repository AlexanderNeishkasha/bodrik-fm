//! Persistence entry points, grouped by transactional responsibility.
//! Async callers must offload synchronous operations; prepared-media async APIs
//! own their blocking boundaries. Re-exports preserve existing consumer paths.

mod accounts;
mod prepared;
mod rooms;
mod schema;
mod tracks;
mod types;

pub use crate::api::room_settings::{set_room_repeat, set_room_theme};
pub use accounts::{
    create_user_with_room, delete_user_and_collect_assets, get_user_by_id, get_user_by_login,
    list_admin_users, reset_user_password, upsert_admin_user,
};
pub use prepared::{backfill_missing_durations, seed_prepared_assets};
pub use rooms::{
    list_rooms, room_by_id, room_by_slug, set_user_room_listed, update_user_room,
    update_user_room_slug,
};
pub use schema::{open_database, run_migrations};
pub use tracks::{
    create_room_upload_track, delete_room_track, list_all_storage_keys, list_room_tracks,
    rename_room_track, resolve_track, room_track_title_exists,
};
pub(crate) use tracks::{insert_upload_track_tx, list_room_tracks_on};
pub use types::{AdminUserRow, DeleteTrackOutcome, RoomRecord, UserRecord};
