//! Single-container Dozzle supervision and private Telegram alert delivery.

mod delivery;
mod webhook;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use std::{
    env,
    process::{ExitCode, Stdio},
    time::Duration,
};
use tokio::{net::TcpListener, process::Command, sync::mpsc};

/// Validate secrets, run both services, and report only sanitized lifecycle failures.
#[tokio::main(worker_threads = 2)]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(error, "logging container stopped");
            ExitCode::FAILURE
        }
    }
}

/// Compose the receiver and Dozzle; any process exit drains or terminates its peer.
///
/// # Errors
/// Returns sanitized configuration, storage, listener, process or shutdown failures.
async fn run() -> Result<(), &'static str> {
    let mode = env::var("TELEGRAM_ALERTS_ENABLED").ok();
    let enabled = alert_mode(mode.as_deref())?;
    let telegram = if enabled {
        let token = env::var("TELEGRAM_BOT_TOKEN").map_err(|_| "TELEGRAM_BOT_TOKEN is required")?;
        let user = env::var("TELEGRAM_USER_ID").map_err(|_| "TELEGRAM_USER_ID is required")?;
        Some(delivery::Telegram::new(&token, &user)?)
    } else {
        tracing::info!("local log viewer: Telegram delivery disabled");
        None
    };
    let secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    tokio::fs::create_dir_all("/data")
        .await
        .map_err(|_| "could not create Dozzle data directory")?;
    match tokio::fs::metadata("/data/notifications.yml").await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let seed = if enabled {
                "/etc/logging/notifications.yml"
            } else {
                "/etc/logging/notifications-disabled.yml"
            };
            tokio::fs::copy(seed, "/data/notifications.yml")
                .await
                .map_err(|_| "could not seed Dozzle notifications")?;
        }
        Err(_) => return Err("could not inspect Dozzle notifications"),
    }
    // Dozzle blocks loopback webhook destinations. Only its dashboard port is published.
    let listener = TcpListener::bind("0.0.0.0:9090")
        .await
        .map_err(|_| "could not bind alert receiver")?;
    let (queue, receiver) = mpsc::channel(64);
    let state = webhook::State { secret, queue };
    let app = Router::new()
        .route("/health", get(|| async { axum::http::StatusCode::OK }))
        .route("/alerts", post(webhook::receive))
        .layer(DefaultBodyLimit::max(32 * 1024))
        .with_state(state.clone());
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let mut http_stopped = stopped.clone();
    let mut http = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = http_stopped.changed().await;
            })
            .await
    });
    let mut worker = tokio::spawn(delivery::work(receiver, telegram, stopped));
    let mut command = Command::new("/dozzle");
    // Dozzle must not inherit bot credentials or unrelated application secrets.
    command
        .env_clear()
        .env(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        )
        .env("DOZZLE_ADDR", ":8080")
        .env("DOZZLE_NO_ANALYTICS", "true")
        .env("DOZZLE_FILTER", "label=com.docker.compose.project=dm_radio")
        .env("ALERT_WEBHOOK_TOKEN", &state.secret)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let mut dozzle = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            stop.send_replace(true);
            http.abort();
            worker.abort();
            let _ = http.await;
            let _ = worker.await;
            return Err("could not start Dozzle");
        }
    };
    let mut http_done = false;
    let mut worker_done = false;
    let mut dozzle_done = false;
    let outcome = tokio::select! {
        result = shutdown() => result,
        _ = dozzle.wait() => { dozzle_done = true; Err("Dozzle exited unexpectedly") },
        _ = &mut http => { http_done = true; Err("alert HTTP server exited unexpectedly") },
        _ = &mut worker => { worker_done = true; Err("Telegram worker exited unexpectedly") },
    };
    stop.send_replace(true);
    if !dozzle_done {
        dozzle.kill().await.map_err(|_| "could not reap Dozzle")?;
    }
    if !http_done
        && tokio::time::timeout(Duration::from_secs(5), &mut http)
            .await
            .is_err()
    {
        http.abort();
        let _ = http.await;
    }
    if !worker_done
        && tokio::time::timeout(Duration::from_secs(5), &mut worker)
            .await
            .is_err()
    {
        worker.abort();
        let _ = worker.await;
    }
    outcome
}

/// Default to production delivery, allowing an explicit credential-free local viewer mode.
///
/// # Errors
/// Rejects malformed flags rather than silently disabling requested alerts.
fn alert_mode(raw: Option<&str>) -> Result<bool, &'static str> {
    match raw {
        None | Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => Err("TELEGRAM_ALERTS_ENABLED must be true or false"),
    }
}

/// Wait for a container stop or Ctrl-C without leaving an unowned signal task.
///
/// # Errors
/// Returns a sanitized failure if signal handlers cannot be installed.
async fn shutdown() -> Result<(), &'static str> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .map_err(|_| "could not install SIGTERM handler")?;
        tokio::select! {
            _ = term.recv() => Ok(()),
            result = tokio::signal::ctrl_c() => result.map_err(|_| "Ctrl-C handler failed"),
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c()
        .await
        .map_err(|_| "Ctrl-C handler failed")
}

/// Notification mode contract, independent of process environment and credentials.
#[cfg(test)]
mod tests {
    use super::*;

    /// Only explicit false disables delivery; bad configuration never becomes success.
    #[test]
    fn alert_mode_cases() {
        for (name, raw, expected) in [
            ("production default", None, Ok(true)),
            ("enabled", Some("true"), Ok(true)),
            ("local viewer", Some("false"), Ok(false)),
            (
                "empty",
                Some(""),
                Err("TELEGRAM_ALERTS_ENABLED must be true or false"),
            ),
            (
                "typo",
                Some("flase"),
                Err("TELEGRAM_ALERTS_ENABLED must be true or false"),
            ),
        ] {
            assert_eq!(alert_mode(raw), expected, "{name}");
        }
    }
}
