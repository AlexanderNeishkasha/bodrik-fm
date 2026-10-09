//! Sanitized public configuration and redirect-only invitation/page routing.

use super::Service;
use crate::media::protocol::identifier;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;
use url::Url;

/// Compose retained public HTTP routes without serving a room shell or legacy token handshake.
pub(super) fn routes() -> Router<Service> {
    Router::new()
        .route("/config", get(config))
        .route("/brand", get(brand))
        .route("/join/", get(legacy_join))
        .route("/join/{slug}", get(invitation))
        .route("/room/{slug}", get(invitation))
        .route("/privacy", get(privacy))
        .route("/", get(retired))
        .route("/newroom", get(retired))
        .route("/activeRooms", get(retired))
        .route("/customizeRoom", get(retired))
        .route("/login", get(retired))
        .route("/logged", get(retired))
        .route("/logout", get(retired))
        .route("/whoAreYou/{slug}", get(retired))
        .route("/iframe", get(retired))
        .fallback(fallback)
}

/// Add no-store to public runtime configuration and admission-related responses.
fn no_store(response: &mut Response) {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
}

/// Return a redirect response with an already validated destination.
fn redirect(status: StatusCode, destination: &Url) -> Response {
    let mut response = status.into_response();
    match destination.as_str().parse() {
        Ok(location) => {
            response.headers_mut().insert(header::LOCATION, location);
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    no_store(&mut response);
    response
}

/// Expose only configured browser button capabilities and the public invitation base.
async fn config(State(service): State<Service>) -> Response {
    let mut response = Json(json!({
        "message": service.config.public.buttons,
        "inviteBaseUrl": service.config.public.invite_base.as_str().trim_end_matches('/'),
    }))
    .into_response();
    no_store(&mut response);
    response
}

/// Expose only the validated public branding object or `false`.
async fn brand(State(service): State<Service>) -> Response {
    let mut response = Json(json!({"message":service.config.public.brand})).into_response();
    no_store(&mut response);
    response
}

/// Redirect one safe public slug to the backend-owned invitation exchange.
async fn invitation(State(service): State<Service>, Path(slug): Path<String>) -> Response {
    if !identifier(&slug) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut destination = service.config.public.invite_base.clone();
    match destination.path_segments_mut() {
        Ok(mut segments) => {
            segments.pop_if_empty().push(&slug);
        }
        Err(()) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    redirect(StatusCode::TEMPORARY_REDIRECT, &destination)
}

/// Explicitly retire the legacy query-token/password-rendering route.
async fn legacy_join() -> Response {
    let mut response = (
        StatusCode::GONE,
        Json(json!({"message":"Legacy token admission is retired"})),
    )
        .into_response();
    no_store(&mut response);
    response
}

/// Redirect to the trusted site privacy page without retaining query or fragment state.
async fn privacy(State(service): State<Service>) -> Response {
    redirect(
        StatusCode::FOUND,
        &site_page(&service.config.public.bye_url, "/privacy"),
    )
}

/// Redirect retired standalone pages to the configured site exit destination.
async fn retired(State(service): State<Service>) -> Response {
    redirect(StatusCode::FOUND, &service.config.public.bye_url)
}

/// Preserve JSON 404s for API paths and trusted site 404 redirects for public pages.
async fn fallback(State(service): State<Service>, uri: Uri) -> Response {
    if uri.path() == "/api" || uri.path().starts_with("/api/") {
        return (StatusCode::NOT_FOUND, Json(json!({"message":"Not found"}))).into_response();
    }
    redirect(
        StatusCode::FOUND,
        &site_page(&service.config.public.bye_url, "/404"),
    )
}

/// Replace only the path of a validated site destination and remove query/fragment state.
fn site_page(base: &Url, path: &str) -> Url {
    let mut destination = base.clone();
    destination.set_path(path);
    destination.set_query(None);
    destination.set_fragment(None);
    destination
}

/// URL mapping fixtures prevent credential-bearing or shell-serving fallbacks.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::replacement::{
        config::{Config, Settings},
        session,
    };
    use std::sync::{Arc, Mutex, atomic::AtomicBool};
    use tokio::{sync::Semaphore, task::JoinHandle};

    /// Owned ephemeral route fixture; dropping it cannot leave a listener task behind.
    struct TestServer {
        /// Loopback HTTP origin.
        base: String,
        /// Owned Axum task.
        task: JoinHandle<()>,
    }

    impl Drop for TestServer {
        /// Abort the isolated listener after each fixture.
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    /// Start the actual route composition with synthetic, non-routable private dependencies.
    async fn server() -> TestServer {
        let config = Config::parse(Settings {
            bind: "127.0.0.1:0",
            media_bind: "127.0.0.1",
            media_announced: "",
            media_min: "43000",
            media_max: "43100",
            player_url: "http://127.0.0.1:2",
            player_secret: "synthetic-player-service-secret-32",
            key: "synthetic-ticket-signing-secret-32",
            issuer: "player",
            audience: "meeting",
            origins: "http://localhost:3000",
            invite_base: "https://example.test/api/conferences",
            bye_url: "http://localhost:3000/bye",
            buttons: r#"{"chat":true}"#,
            brand: r#"{"title":"Meeting"}"#,
            avatar_dir: "uploads/avatars",
            chat_image_dir: "uploads/chat",
            diagnostics_dir: "logs/diagnostics",
            diagnostics_retention_days: "14",
            diagnostics_file_bytes: "10485760",
            diagnostics_total_bytes: "104857600",
            ffmpeg_path: "ffmpeg",
            music_rtp_host: "127.0.0.1",
        })
        .expect("config");
        let service = Service {
            config: Arc::new(config),
            runtime: Default::default(),
            store: Arc::new(Mutex::new(session::Store::default())),
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            sockets: Arc::new(Semaphore::new(1)),
            observing: Arc::new(AtomicBool::new(true)),
            draining: Arc::new(AtomicBool::new(false)),
            upload_limits: Arc::new(crate::replacement::uploads::Limits::new()),
            diagnostics: crate::replacement::diagnostics::Handle::disconnected(),
            diagnostic_limits: Arc::new(crate::replacement::diagnostics::Limits::new()),
            chat_limits: Arc::new(crate::replacement::chat::Limits::new()),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let base = format!("http://{}", listener.local_addr().expect("address"));
        let task = tokio::spawn(async move {
            axum::serve(listener, routes().with_state(service))
                .await
                .expect("serve");
        });
        TestServer { base, task }
    }

    /// Site page redirects preserve only trusted scheme/authority and the requested fixed path.
    #[test]
    fn site_page_cases() {
        let base = Url::parse("https://example.test/bye").expect("base");
        assert_eq!(
            site_page(&base, "/privacy").as_str(),
            "https://example.test/privacy"
        );
        assert_eq!(
            site_page(&base, "/404").as_str(),
            "https://example.test/404"
        );
    }

    /// Actual public routes preserve sanitized DTOs and replace legacy admission with redirects.
    #[tokio::test]
    async fn public_route_cases() {
        let server = server().await;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client");
        for (path, status, location) in [
            (
                "/join/public-room",
                307,
                Some("https://example.test/api/conferences/public-room"),
            ),
            (
                "/room/public-room",
                307,
                Some("https://example.test/api/conferences/public-room"),
            ),
            ("/join/?room=legacy&token=private", 410, None),
            ("/privacy", 302, Some("http://localhost:3000/privacy")),
            ("/newroom", 302, Some("http://localhost:3000/bye")),
            ("/missing", 302, Some("http://localhost:3000/404")),
            ("/api/missing", 404, None),
        ] {
            let response = client
                .get(format!("{}{path}", server.base))
                .send()
                .await
                .expect(path);
            assert_eq!(response.status().as_u16(), status, "{path}");
            assert_eq!(
                response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|value| value.to_str().ok()),
                location,
                "{path}"
            );
        }
        let config = client
            .get(format!("{}/config", server.base))
            .send()
            .await
            .expect("config");
        assert_eq!(config.headers()[header::CACHE_CONTROL], "no-store");
        let body: serde_json::Value = config.json().await.expect("config JSON");
        assert_eq!(
            body,
            json!({"message":{"chat":true},"inviteBaseUrl":"https://example.test/api/conferences"})
        );
        let brand: serde_json::Value = client
            .get(format!("{}/brand", server.base))
            .send()
            .await
            .expect("brand")
            .json()
            .await
            .expect("brand JSON");
        assert_eq!(brand, json!({"message":{"title":"Meeting"}}));
        let encoded = format!("{body}{brand}").to_ascii_lowercase();
        for private in ["secret", "password", "token", "credential", "authorization"] {
            assert!(!encoded.contains(private), "{private}");
        }
    }
}
