//! Provider-neutral conference routes, authorization and durable resource retirement.

mod admission;
mod chat;
mod cleanup;
pub(crate) mod db;
#[cfg(test)]
mod db_tests;
pub(crate) mod embedded;
mod guest;
mod handlers;
mod hosts;
mod music_bridge;
mod policy;
mod provider;
mod response;
pub(crate) mod service;
#[cfg(test)]
mod service_tests;
mod tickets;

pub(crate) use admission::routes as admission_routes;
pub(crate) use chat::setup as chat_setup;
pub(crate) use cleanup::{
    for_room as cleanup_room, queue_current_tx as queue_room_cleanup, start as start_cleanup,
};
pub(crate) use db::allowed_by_user_id;
pub(crate) use guest::{guest_invite, public_join, public_status};
pub(crate) use handlers::{
    set_enabled, set_music_output, set_music_volume, studio_join, studio_status,
};
pub use provider::Provider;
pub(crate) use service::set_access;
pub(crate) use tickets::{Issuer as TicketIssuer, routes as ticket_routes};

use axum::{
    Router,
    routing::{get, post},
};

use super::AppState;

/// Build the provider-neutral conference routes.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/conferences/{slug}", get(guest_invite))
        .route(
            "/api/internal/conferences/{conference_id}/music",
            get(music_bridge::snapshot),
        )
        .route("/api/rooms/{slug}/conference", get(public_status))
        .route("/api/rooms/{slug}/conference/join", post(public_join))
        .route(
            "/api/studio/conference",
            get(studio_status).post(set_enabled),
        )
        .route("/api/studio/conference/join", post(studio_join))
        .route(
            "/api/studio/conference/music-volume",
            post(set_music_volume),
        )
        .route(
            "/api/studio/conference/music-output",
            post(set_music_output),
        )
}
