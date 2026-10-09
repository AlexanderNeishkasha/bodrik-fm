//! Backend composition and process lifecycle; domain and HTTP policy live in modules.

mod api;
mod config;
mod meeting;
mod stream;

use std::{collections::HashMap, env, net::SocketAddr, process::ExitCode, sync::Arc};

use axum::extract::DefaultBodyLimit;
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing::info;

/// Initialize diagnostics and report startup/server failures with a nonzero exit code.
#[tokio::main]
async fn main() -> ExitCode {
    init_tracing();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "backend stopped with an error");
            ExitCode::FAILURE
        }
    }
}

/// Compose storage, integrations and routes, then serve until shutdown is requested.
///
/// # Errors
/// Returns contextual configuration, storage, initialization, binding or serving errors.
async fn run() -> Result<(), String> {
    let db_path = env::var("DB_PATH").unwrap_or_else(|_| "./data/app.db".into());
    let migrations_dir = env::var("MIGRATIONS_DIR").unwrap_or_else(|_| "./migrations".into());
    if env::args().nth(1).as_deref() == Some("migrate") {
        api::migrate_only(&db_path, &migrations_dir).await?;
        info!("migrations completed");
        return Ok(());
    }

    let temp_upload_dir = env::var("UPLOAD_TMP_DIR").unwrap_or_else(|_| {
        env::temp_dir()
            .join("bodrik_fm_uploads")
            .to_string_lossy()
            .into_owned()
    });
    tokio::fs::create_dir_all(&temp_upload_dir)
        .await
        .map_err(|err| format!("failed to create temp upload directory: {err}"))?;
    let media_dir = env::var("MEDIA_DIR").unwrap_or_else(|_| "./uploads".into());
    tokio::fs::create_dir_all(&media_dir)
        .await
        .map_err(|err| format!("failed to create media directory: {err}"))?;
    let jwt_secret = env::var("BODRIK_FM_JWT_SECRET")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or("BODRIK_FM_JWT_SECRET is required")?;
    let allowed_origins = config::load_allowed_origins()?;
    let cors = config::build_cors(&allowed_origins)?;
    let meeting_service_secret = config::meeting_service_secret()?;
    let meeting_shared = meeting::Shared::new();
    let meeting_enabled = config::env_flag("MEETING_ENABLED", false);
    let conference_provider = if meeting_enabled {
        let public_url =
            env::var("MIROTALK_PUBLIC_URL").map_err(|_| "MIROTALK_PUBLIC_URL is required")?;
        let url = url::Url::parse(&public_url).map_err(|_| "invalid meeting public URL")?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.has_host()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("invalid meeting public URL".into());
        }
        Some(api::conference::Provider::embedded(
            public_url,
            meeting_shared.clone(),
        ))
    } else {
        None
    };
    let ticket_issuer = if meeting_enabled {
        Some(api::conference::TicketIssuer::embedded_from_env(
            meeting_shared.clone(),
            &jwt_secret,
        )?)
    } else {
        None
    };
    let music_bridge_secret = meeting_service_secret.clone();
    let open_path = db_path.clone();
    let connection = tokio::task::spawn_blocking(move || api::open_database(&open_path))
        .await
        .map_err(|err| format!("database opening task failed: {err}"))??;
    let state = api::AppState {
        temp_upload_dir,
        media_dir,
        db: Arc::new(std::sync::Mutex::new(connection)),
        jwt_secret,
        trust_proxy_headers: config::env_flag("TRUST_PROXY_HEADERS", false),
        csrf_allowed_origins: Arc::new(allowed_origins),
        login_rate_limiter: Arc::new(api::auth_v2::LoginRateLimiter::new(5, 600)),
        conference_join_rate_limiter: Arc::new(api::auth_v2::LoginRateLimiter::new(30, 60)),
        conference_provider: conference_provider.map(Arc::new),
        music_bridge_secret,
        playback_observer: Arc::new(api::playback_observer::PlaybackObserver::new(256)),
        youtube_download_limiter: Arc::new(tokio::sync::Semaphore::new(
            config::env_usize("YOUTUBE_MAX_CONCURRENT_DOWNLOADS", 2).max(1),
        )),
        runtimes: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
    };
    let admin_login = env::var("ADMIN_LOGIN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let admin_password = env::var("ADMIN_PASSWORD")
        .ok()
        .filter(|value| !value.trim().is_empty());
    api::init(
        &state,
        &db_path,
        &migrations_dir,
        admin_login,
        admin_password,
    )
    .await
    .map_err(|err| format!("startup initialization failed: {err}"))?;
    let _conference_cleanup = api::conference::start_cleanup(state.clone());
    let chat_directory = std::path::Path::new(&db_path)
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("chat-attachments");
    let (chat_routes, _chat_cleanup, chat_state) = api::conference::chat_setup(
        state.clone(),
        meeting_service_secret.clone(),
        chat_directory,
    );
    let mut meeting_owner = if meeting_enabled {
        let services = Arc::new(api::conference::embedded::HostServices::new(
            state.clone(),
            chat_state,
        ));
        Some(meeting::Supervisor::start(
            meeting_shared.clone(),
            services,
        )?)
    } else {
        None
    };
    let app = api::router(state.clone())
        .merge(chat_routes)
        .merge(meeting_shared.routes())
        .route(
            "/health",
            axum::routing::get(|| async { axum::http::StatusCode::OK }),
        )
        .route(
            "/ready",
            axum::routing::get(|| async { axum::http::StatusCode::OK }),
        )
        .merge(api::conference::ticket_routes(state.clone(), ticket_issuer))
        .merge(api::conference::admission_routes(
            state,
            meeting_service_secret,
        ))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        // Multipart overrides this at its route; ordinary JSON must not buffer 1 GiB.
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024));
    let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3001".into());
    let listener = TcpListener::bind(&bind_addr)
        .await
        .map_err(|err| format!("failed to bind backend listener at {bind_addr}: {err}"))?;
    info!("backend on http://{bind_addr}");
    use std::future::IntoFuture;
    let (http_stop, mut http_stopped) = tokio::sync::watch::channel(false);
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = http_stopped.changed().await;
    })
    .into_future();
    tokio::pin!(server);
    let mut server_finished = false;
    let outcome = tokio::select! {
        result = &mut server => { server_finished = true; result.map_err(|err| format!("backend serving failed: {err}")) },
        _ = shutdown_signal() => Ok(()),
        _ = async { match &mut meeting_owner { Some(owner) => owner.failed().await, None => std::future::pending().await } } => Err("meeting cleanup requires process restart".into()),
    };
    let drain = match &mut meeting_owner {
        Some(owner) => owner.shutdown().await,
        None => Ok(()),
    };
    http_stop.send_replace(true);
    if !server_finished {
        tokio::time::timeout(std::time::Duration::from_secs(15), &mut server)
            .await
            .map_err(|_| "backend HTTP drain deadline exceeded")?
            .map_err(|err| format!("backend serving failed: {err}"))?;
    }
    outcome.and(drain)
}

/// Stop accepting HTTP work on Ctrl-C or Unix SIGTERM; existing HTTP requests drain.
/// Signal setup failures are reported and cause serving to stop rather than hang.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(error) => {
                    tracing::error!(%error, "failed to install SIGTERM handler");
                    return;
                }
            };
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result { tracing::error!(%error, "Ctrl-C handler failed"); }
            }
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "Ctrl-C handler failed");
    }
    info!("HTTP shutdown requested");
}

/// Install the process tracing subscriber, defaulting to info-level diagnostics.
///
/// # Panics
/// Panics if another subscriber was installed before the application entry point.
fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}
