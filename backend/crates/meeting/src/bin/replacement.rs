//! Standalone replacement process; never loads the legacy gateway/admission configuration.
use meeting_backend::replacement::{self, config::Config};
use std::{future::IntoFuture, process::ExitCode};

/// Initialize diagnostics and report sanitized replacement startup failures.
#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "replacement service stopped");
            ExitCode::FAILURE
        }
    }
}

/// Validate independent configuration before binding and serve only the isolated replacement routes.
///
/// # Errors
/// Returns sanitized configuration, worker, listener or serving failures.
async fn run() -> Result<(), String> {
    let config = tokio::task::spawn_blocking(Config::from_env)
        .await
        .map_err(|_| "configuration task failed")??;
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .map_err(|_| "replacement bind failed")?;
    let mut application = replacement::Application::start(config).await?;
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = axum::serve(listener, application.router())
        .with_graceful_shutdown(async move {
            let _ = stopped.await;
        })
        .into_future();
    tokio::pin!(server);
    let failed = application.media_failure();
    let result = tokio::select! {
        result = &mut server => {
            application.shutdown().await.map_err(String::from)?;
            result
        },
        _ = failed => {
            application.shutdown().await.map_err(String::from)?;
            return Err("native worker failed; restart required".into());
        },
        _ = shutdown_signal() => {
            application.shutdown().await.map_err(String::from)?;
            let _ = stop.send(());
            server.await
        },
    };
    result.map_err(|_| "replacement serving failed".into())
}

/// Wait for Ctrl-C or Unix SIGTERM; setup failures trigger fail-closed resource draining.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(terminate) => terminate,
                Err(error) => {
                    tracing::error!(%error, "replacement SIGTERM setup failed");
                    return;
                }
            };
        tokio::select! {
            result = tokio::signal::ctrl_c() => if let Err(error) = result { tracing::error!(%error, "replacement Ctrl-C failed"); },
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "replacement Ctrl-C failed");
    }
}
