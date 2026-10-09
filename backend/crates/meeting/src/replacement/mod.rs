//! Isolated replacement service: no legacy admission or gateway is a fallback.

mod admission;
mod application;
mod handle;
pub use handle::Handle;
mod chat;
mod chat_http;
mod diagnostics;
mod file;
mod moderation;
mod music;
mod observations;
mod participant;
mod persistent_chat;
mod producer_state;
mod public_http;
pub use application::Application;
pub mod config;
mod native;
mod recovery;
mod room_lease;
mod session;
mod socket;
mod turn;
mod upload_files;
mod uploads;
mod wire;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get},
};
use config::Config;
use serde::Serialize;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

/// Process-local replacement dependencies, independent of the legacy gateway runtime.
#[derive(Clone)]
struct Service {
    /// Explicit replacement configuration and fresh service identity.
    config: Arc<Config>,
    /// Existing single domain phase/role/moderation owner.
    runtime: crate::runtime::Runtime,
    /// Bounded socket ownership and native-handle metadata.
    store: Arc<Mutex<session::Store>>,
    /// Serialized lifecycle work; blocking state locks never cross I/O.
    lifecycle: Arc<tokio::sync::Mutex<()>>,
    /// Bounded live and unauthenticated sockets, held through owned cleanup.
    sockets: Arc<Semaphore>,
    /// A contiguous native observation stream is established; gaps stop admissions.
    observing: Arc<AtomicBool>,
    /// Explicit process drain fences new and existing socket authority.
    draining: Arc<AtomicBool>,
    /// Bounded authenticated upload throttles shared by every route clone.
    upload_limits: Arc<uploads::Limits>,
    /// Non-blocking producer for the single diagnostics disk owner.
    diagnostics: diagnostics::Handle,
    /// Per-session diagnostics event bounds.
    diagnostic_limits: Arc<diagnostics::Limits>,
    /// Shared retained chat/reaction sliding-window bounds.
    chat_limits: Arc<chat::Limits>,
}

/// Strict player-facing discovery; exposes no native binding or credentials.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Incarnation<'a> {
    /// Discovery contract version.
    version: u8,
    /// Fresh random startup identity, invalidating prior-incarnation tickets.
    meeting_instance_id: &'a str,
    /// Exact configured player issuer.
    issuer: &'a str,
    /// Exact configured replacement audience.
    audience: &'a str,
}

/// Compose routes for an explicitly owned application; never merge with the legacy router.
fn routes(service: Service) -> Router {
    browser_routes()
        .route("/health", get(|| async { StatusCode::OK }))
        .route("/ready", get(readiness))
        .route("/internal/replacement/v1/incarnation", get(incarnation))
        .route(
            "/internal/replacement/v1/conferences/{id}",
            delete(terminate),
        )
        .with_state(service)
}

/// Browser-facing routes shared by standalone and embedded hosts.
fn browser_routes() -> Router<Service> {
    Router::new()
        .merge(public_http::routes())
        .merge(uploads::routes())
        .merge(upload_files::routes())
        .merge(chat_http::routes())
        .route("/ws/meeting/v1/{slug}", get(socket::upgrade))
}

/// Distinguish liveness from an established native baseline and admission readiness.
async fn readiness(State(service): State<Service>) -> StatusCode {
    if available(&service) {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

/// Determine whether current native observations permit new or renewed public authority.
fn available(service: &Service) -> bool {
    !service.draining.load(Ordering::Acquire) && service.observing.load(Ordering::Acquire)
}

/// Check the independent private-player bearer without exposing its value.
fn player_authorized(service: &Service, headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| {
            bool::from(
                value
                    .as_bytes()
                    .ct_eq(service.config.player_secret.as_bytes()),
            )
        })
}

/// Authenticate the private player before revealing ticket scopes and the fresh service incarnation.
async fn incarnation(State(service): State<Service>, headers: HeaderMap) -> Response {
    if !player_authorized(&service, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut response = Json(Incarnation {
        version: 1,
        meeting_instance_id: &service.config.instance,
        issuer: &service.config.issuer,
        audience: &service.config.audience,
    })
    .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

/// Retire one exact private conference mapping idempotently after durable player revocation.
async fn terminate(
    State(service): State<Service>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> StatusCode {
    if !player_authorized(&service, &headers) {
        return StatusCode::UNAUTHORIZED;
    }
    if !crate::media::protocol::identifier(&id) {
        return StatusCode::BAD_REQUEST;
    }
    let _lifecycle = service.lifecycle.lock().await;
    let room = service
        .store
        .lock()
        .ok()
        .and_then(|store| store.rooms.get(&id).cloned());
    if let Some(room) = room {
        session::retire(&service, &room).await;
    }
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Private retirement rejects bad authority/input and removes an exact room idempotently.
    #[tokio::test]
    async fn termination_cases() {
        let (service, _, _) = observations::tests::fixture(false, false);
        let mut authorized = HeaderMap::new();
        authorized.insert(
            header::AUTHORIZATION,
            "Bearer synthetic-player-service-secret-32"
                .parse()
                .expect("header"),
        );
        for (name, id, headers, expected) in [
            (
                "unauthorized",
                "conference",
                HeaderMap::new(),
                StatusCode::UNAUTHORIZED,
            ),
            (
                "invalid",
                "bad/id",
                authorized.clone(),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            assert_eq!(
                terminate(State(service.clone()), Path(id.into()), headers).await,
                expected,
                "{name}"
            );
        }
        assert_eq!(
            terminate(
                State(service.clone()),
                Path("conference".into()),
                authorized.clone(),
            )
            .await,
            StatusCode::NO_CONTENT
        );
        assert!(service.store.lock().expect("store").rooms.is_empty());
        assert!(service.store.lock().expect("store").sessions.is_empty());
        assert_eq!(
            terminate(State(service), Path("conference".into()), authorized,).await,
            StatusCode::NO_CONTENT
        );
    }
}
