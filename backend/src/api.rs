//! Application composition, routes, shared state, and HTTP middleware.

use std::{collections::HashMap, sync::Arc};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::Connection;
use tower_http::services::ServeDir;

mod account;
mod admin;
pub(crate) mod auth;
pub(crate) mod blocking;
pub(crate) mod conference;
mod db;
mod library;
mod library_db;
mod library_db_util;
mod library_playback;
mod media;
pub(crate) mod op_error;
pub(crate) mod playback_observer;
mod public;
mod request_security;
mod room_settings;
mod runtime;
mod state_socket;
mod studio;
mod studio_state;
mod util;
mod youtube;
mod youtube_download_runner;
mod youtube_jobs;

pub(crate) use request_security::normalize_origin;
use request_security::{csrf_origin_from_headers, requires_csrf};

/// Shared dependencies composed at startup and cloned into HTTP handlers.
#[derive(Clone)]
pub struct AppState {
    /// Temporary directory for multipart uploads.
    pub temp_upload_dir: String,
    /// Original media and HLS cache root.
    pub media_dir: String,
    /// Serialized SQLite connection; blocking users must run off the executor.
    pub db: Arc<std::sync::Mutex<Connection>>,
    /// Server-side signing secret for authentication sessions.
    pub jwt_secret: String,
    /// Whether client identity may trust configured proxy headers.
    pub trust_proxy_headers: bool,
    /// Canonical HTTP(S) origins allowed to make state-changing requests.
    pub csrf_allowed_origins: Arc<Vec<String>>,
    /// Shared registration/login failure throttle.
    pub login_rate_limiter: Arc<auth::LoginRateLimiter>,
    /// Separate conference admission throttle.
    pub conference_join_rate_limiter: Arc<auth::LoginRateLimiter>,
    /// Optional provider-neutral conference capability.
    pub conference_provider: Option<Arc<conference::Provider>>,
    /// Optional secret for room-bound music bridge tokens.
    pub music_bridge_secret: Option<Arc<str>>,
    /// Bounded fan-out of authoritative playback revisions.
    pub playback_observer: Arc<playback_observer::PlaybackObserver>,
    /// Concurrency bound for background YouTube downloads.
    pub youtube_download_limiter: Arc<tokio::sync::Semaphore>,
    /// Authoritative in-memory runtimes keyed by database room identifier.
    pub runtimes: Arc<tokio::sync::Mutex<HashMap<i64, Arc<runtime::RoomRuntime>>>>,
}

/// Build API/WebSocket routes and static media serving with shared middleware.
pub fn router(state: AppState) -> Router {
    let media_dir = state.media_dir.clone();
    let csrf_state = state.clone();
    Router::new()
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me))
        .route("/api/account/password", post(account::change_password))
        .route("/api/account/delete", post(account::delete_account))
        .route("/api/rooms", get(public::rooms_list))
        .merge(conference::routes())
        .route("/api/rooms/{slug}/state/public", get(public::state_public))
        .route("/api/studio/tracks", get(studio::tracks))
        .route("/api/studio/library", get(library::library))
        .route(
            "/api/studio/upload",
            post(studio::upload).layer(DefaultBodyLimit::max(studio::UPLOAD_BODY_LIMIT)),
        )
        .route(
            "/api/studio/youtube-downloads",
            post(youtube::submit_download),
        )
        .route(
            "/api/studio/youtube-downloads/dismiss",
            post(youtube::dismiss_download),
        )
        .route("/api/studio/track/rename", post(studio::rename_track))
        .route("/api/studio/track/delete", post(studio::delete_track))
        .route("/api/studio/sections", post(library::create_section))
        .route("/api/studio/sections/rename", post(library::rename_section))
        .route("/api/studio/sections/delete", post(library::delete_section))
        .route(
            "/api/studio/sections/reorder",
            post(library::reorder_sections),
        )
        .route(
            "/api/studio/sections/queue",
            post(library_playback::queue_section),
        )
        .route(
            "/api/studio/sections/play",
            post(library_playback::play_section),
        )
        .route("/api/studio/tracks/move", post(library::move_track))
        .route("/api/studio/tracks/reorder", post(library::reorder_tracks))
        .route("/api/studio/queue", post(studio::queue_track))
        .route("/api/studio/queue/insert", post(studio::insert_track))
        .route("/api/studio/queue/reorder", post(studio::reorder_queue))
        .route("/api/studio/queue/remove", post(studio::remove_from_queue))
        .route("/api/studio/queue/force-play", post(studio::force_play))
        .route("/api/studio/play", post(studio::play_track))
        .route("/api/studio/pause", post(studio::pause))
        .route("/api/studio/resume", post(studio::resume))
        .route("/api/studio/seek", post(studio::seek))
        .route("/api/studio/skip", post(studio::skip))
        .route("/api/studio/repeat", post(studio::set_repeat))
        .route("/api/studio/theme", post(studio::set_theme))
        .route("/api/studio/room/slug", post(studio::set_room_slug))
        .route("/api/studio/room/listed", post(studio::set_room_listed))
        .route("/api/admin/users", get(admin::users))
        .route(
            "/api/admin/users/{id}/reset-password",
            post(admin::reset_password),
        )
        .route("/api/admin/users/{id}/delete", post(admin::delete_user))
        .route(
            "/api/admin/users/{id}/conference-access",
            post(admin::set_conference_access),
        )
        .route("/api/admin/users/{id}/room", post(admin::update_room))
        .route("/ws/studio/state", get(studio_state::state_ws))
        .route(
            "/ws/rooms/{slug}/state/public",
            get(public::state_public_ws),
        )
        .layer(middleware::from_fn_with_state(csrf_state, csrf_guard))
        .nest(
            "/media",
            Router::new()
                .fallback_service(ServeDir::new(media_dir))
                .layer(middleware::from_fn(media_cache_headers)),
        )
        .with_state(state)
}

/// Prevent cached HLS playlists/segments from outliving playback changes.
async fn media_cache_headers(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;
    if path.starts_with("/media/hls/") || path.starts_with("/hls/") {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, no-cache, must-revalidate"),
        );
    }
    response
}

/// Uniform browser-facing status/error message payload.
#[derive(Debug, serde::Serialize)]
pub(crate) struct ApiMessage {
    /// User-facing text; internal error details must stay in server logs.
    message: String,
}

/// Pair a status with the standard JSON message body.
pub(crate) fn json_message(status: StatusCode, message: impl Into<String>) -> impl IntoResponse {
    let body = ApiMessage {
        message: message.into(),
    };
    (status, Json(body))
}

/// Log an operational failure once and return a generic browser-facing 500.
pub(crate) fn internal_error_response(context: &str, err: impl std::fmt::Display) -> Response {
    tracing::error!("{context}: {err}");
    json_message(StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
}

/// Reject state-changing requests lacking an explicitly allowed request origin.
async fn csrf_guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !requires_csrf(request.method()) {
        return next.run(request).await;
    }
    let Some(request_origin) = csrf_origin_from_headers(request.headers()) else {
        return json_message(StatusCode::FORBIDDEN, "forbidden").into_response();
    };
    let is_allowed = state
        .csrf_allowed_origins
        .iter()
        .any(|origin| origin == &request_origin);
    if !is_allowed {
        return json_message(StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    next.run(request).await
}

/// Apply migrations, initialize assets/admin/jobs, and warm the HLS cache.
///
/// # Errors
/// Returns migration, asset loading, duration backfill, admin provisioning or job recovery errors.
pub async fn init(
    state: &AppState,
    db_path: &str,
    migrations_dir: &str,
    admin_login: Option<String>,
    admin_password: Option<String>,
) -> Result<(), String> {
    let migration_state = state.clone();
    let migrations_dir = migrations_dir.to_owned();
    tokio::task::spawn_blocking(move || db::run_migrations(&migration_state, &migrations_dir))
        .await
        .map_err(|err| format!("migration task failed: {err}"))??;
    db::seed_prepared_assets(state).await?;
    let updated_durations = db::backfill_missing_durations(state).await?;
    if updated_durations > 0 {
        tracing::info!("backfilled durations for {updated_durations} assets");
    }
    if let (Some(login), Some(password)) = (admin_login, admin_password) {
        let admin_state = state.clone();
        tokio::task::spawn_blocking(move || db::upsert_admin_user(&admin_state, &login, &password))
            .await
            .map_err(|err| format!("admin provisioning task failed: {err}"))??;
    }
    tracing::info!("database ready at {db_path}");
    youtube::init_jobs(state).await?;
    media::init_hls_cache(state).await;
    Ok(())
}

/// Open SQLite with the application's database configuration.
///
/// # Errors
/// Returns directory creation or SQLite opening/configuration errors.
pub fn open_database(path: &str) -> Result<Connection, String> {
    db::open_database(path)
}

/// Apply schema migrations without initializing media, users, or background jobs.
///
/// # Errors
/// Returns database opening or migration errors.
pub async fn migrate_only(db_path: &str, migrations_dir: &str) -> Result<(), String> {
    let db_path = db_path.to_owned();
    let migrations_dir = migrations_dir.to_owned();
    tokio::task::spawn_blocking(move || {
        let conn = db::open_database(&db_path)?;
        let state = AppState {
            temp_upload_dir: String::new(),
            media_dir: String::new(),
            db: Arc::new(std::sync::Mutex::new(conn)),
            jwt_secret: String::new(),
            trust_proxy_headers: false,
            csrf_allowed_origins: Arc::new(Vec::new()),
            login_rate_limiter: Arc::new(auth::LoginRateLimiter::new(5, 600)),
            conference_join_rate_limiter: Arc::new(auth::LoginRateLimiter::new(30, 60)),
            conference_provider: None,
            music_bridge_secret: None,
            playback_observer: Arc::new(playback_observer::PlaybackObserver::new(16)),
            youtube_download_limiter: Arc::new(tokio::sync::Semaphore::new(1)),
            runtimes: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        };
        db::run_migrations(&state, &migrations_dir)?;
        tracing::info!("migrations complete for {db_path}");
        Ok(())
    })
    .await
    .map_err(|err| format!("migration task failed: {err}"))?
}
