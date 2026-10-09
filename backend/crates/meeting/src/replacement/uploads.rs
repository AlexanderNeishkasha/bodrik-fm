//! Bounded image publication with one Rust writer and cancellation-safe temporary files.
use super::{Service, available, session};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::watch;
use uuid::Uuid;

/// Avatar body limit retained from the legacy handler.
const AVATAR_LIMIT: usize = 256 * 1024;
/// Chat-image body limit retained from the legacy handler.
const CHAT_LIMIT: usize = 5 * 1024 * 1024;
/// Temporary chat images expire after 48 hours.
const CHAT_LIFETIME: Duration = Duration::from_secs(48 * 60 * 60);
/// Inaccessible interrupted temporary writes are removed after one hour.
const TEMP_LIFETIME: Duration = Duration::from_secs(60 * 60);
/// Avatar publications allowed per authenticated ticket in one fixed hour.
const AVATAR_RATE: u16 = 20;
/// Chat-image publications allowed per connected session in one fixed hour.
const CHAT_RATE: u16 = 30;
/// Maximum retained active throttling identities.
const RATE_CAPACITY: usize = 4096;
/// Fixed throttling window retained from the legacy handlers.
const RATE_WINDOW: Duration = Duration::from_secs(60 * 60);

/// Bounded authenticated-identity upload throttles; no plaintext credential is retained.
pub(super) struct Limits {
    /// Fixed-window counters keyed by a domain-separated credential digest.
    entries: Mutex<HashMap<[u8; 32], Window>>,
}

/// One fixed authenticated-identity throttling window.
struct Window {
    /// Window creation time.
    started: Instant,
    /// Accepted upload attempts in this window.
    count: u16,
}

impl Limits {
    /// Create empty bounded upload throttles.
    pub(super) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Consume one authenticated upload allowance without storing its bearer value.
    fn allow(&self, purpose: &[u8], identity: &str, maximum: u16, now: Instant) -> bool {
        let mut hash = Sha256::new();
        hash.update(purpose);
        hash.update(identity.as_bytes());
        let key = hash.finalize().into();
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        entries.retain(|_, window| now.duration_since(window.started) < RATE_WINDOW);
        if let Some(window) = entries.get_mut(&key) {
            if window.count >= maximum {
                return false;
            }
            window.count += 1;
            return true;
        }
        if entries.len() >= RATE_CAPACITY {
            return false;
        }
        entries.insert(
            key,
            Window {
                started: now,
                count: 1,
            },
        );
        true
    }
}

/// Compose upload routes; nginx remains the only public file reader.
pub(super) fn routes() -> Router<Service> {
    Router::new()
        .route(
            "/api/meeting/avatar",
            post(avatar).layer(DefaultBodyLimit::max(AVATAR_LIMIT)),
        )
        .route(
            "/api/meeting/chat-image",
            post(chat_image).layer(DefaultBodyLimit::max(CHAT_LIMIT)),
        )
}

/// Extract a strict bearer without accepting alternate schemes or empty credentials.
fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .filter(|value| !value.is_empty())
}

/// Validate supported content type and file signature, returning the safe extension.
fn image_type(headers: &HeaderMap, body: &[u8]) -> Option<&'static str> {
    let content = headers
        .get(header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .split(';')
        .next()?;
    match content {
        "image/jpeg" if body.starts_with(&[0xff, 0xd8, 0xff]) => Some("jpg"),
        "image/png" if body.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) => {
            Some("png")
        }
        "image/webp" if body.starts_with(b"RIFF") && body.get(8..12) == Some(b"WEBP") => {
            Some("webp")
        }
        _ => None,
    }
}

/// Publish a complete file by writing an inaccessible temporary sibling before atomic rename.
fn publish(directory: &Path, body: &[u8], extension: &str) -> Result<(PathBuf, String), ()> {
    fs::create_dir_all(directory).map_err(|_| ())?;
    let id = Uuid::new_v4();
    let filename = format!("{id}.{extension}");
    let temporary = directory.join(format!(".{id}.upload"));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| ())?;
    file.write_all(body)
        .and_then(|_| file.sync_all())
        .map_err(|_| ())?;
    Ok((temporary, filename))
}

/// Complete publication only after the caller's final authority check.
fn commit(temporary: &Path, directory: &Path, filename: &str) -> Result<(), ()> {
    fs::rename(temporary, directory.join(filename)).map_err(|_| ())
}

/// Accept a small avatar only from an exact connected replacement session owner.
async fn avatar(State(service): State<Service>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(proof) = bearer(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(session_id) = headers
        .get("x-meeting-session-id")
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !chat_authorized(&service, session_id, proof) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !service
        .upload_limits
        .allow(b"avatar", session_id, AVATAR_RATE, Instant::now())
    {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    if body.len() < 12 || body.len() > AVATAR_LIMIT {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(extension) = image_type(&headers, &body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let directory = service.config.avatar_dir.clone();
    let body = body.to_vec();
    let written = tokio::task::spawn_blocking({
        let directory = directory.clone();
        move || publish(&directory, &body, extension)
    })
    .await;
    let Ok(Ok((temporary, filename))) = written else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    if !chat_authorized(&service, session_id, proof) {
        remove(temporary).await;
        return StatusCode::FORBIDDEN.into_response();
    }
    if finish(temporary, directory, filename.clone())
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (
        StatusCode::CREATED,
        Json(json!({"url":format!("/uploads/avatars/{filename}")})),
    )
        .into_response()
}

/// Verify a connected session using its browser-generated ownership proof.
fn chat_authorized(service: &Service, session_id: &str, proof: &str) -> bool {
    available(service)
        && service
            .store
            .lock()
            .ok()
            .and_then(|store| {
                store.sessions.get(session_id).map(|value| {
                    let purpose = session::owner_purpose(&value.actor);
                    value.events.is_some()
                        && session::proves(&value.owner, purpose.as_bytes(), proof)
                })
            })
            .unwrap_or(false)
}

/// Accept a chat image only when the exact connected session remains authorized after writing.
async fn chat_image(State(service): State<Service>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(proof) = bearer(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(session_id) = headers
        .get("x-meeting-session-id")
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !chat_authorized(&service, session_id, proof) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !service
        .upload_limits
        .allow(b"chat", session_id, CHAT_RATE, Instant::now())
    {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    if body.len() < 12 || body.len() > CHAT_LIMIT {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(extension) = image_type(&headers, &body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let directory = service.config.chat_image_dir.clone();
    let body = body.to_vec();
    let written = tokio::task::spawn_blocking(move || publish(&directory, &body, extension)).await;
    let Ok(Ok((temporary, filename))) = written else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    if !chat_authorized(&service, session_id, proof) {
        remove(temporary).await;
        return StatusCode::FORBIDDEN.into_response();
    }
    if finish(
        temporary,
        service.config.chat_image_dir.clone(),
        filename.clone(),
    )
    .await
    .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (
        StatusCode::CREATED,
        Json(json!({"url":format!("/uploads/chat/{filename}")})),
    )
        .into_response()
}

/// Complete one publication without blocking an asynchronous worker.
async fn finish(temporary: PathBuf, directory: PathBuf, filename: String) -> Result<(), ()> {
    tokio::task::spawn_blocking(move || {
        let result = commit(&temporary, &directory, &filename);
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    })
    .await
    .map_err(|_| ())?
}

/// Remove an unpublished temporary file without blocking an asynchronous worker.
async fn remove(temporary: PathBuf) {
    let _ = tokio::task::spawn_blocking(move || fs::remove_file(temporary)).await;
}

/// Own hourly expiry cleanup until application shutdown.
pub(super) async fn supervise(service: Service, mut stop: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
    loop {
        tokio::select! {
            _ = stop.changed() => return,
            _ = interval.tick() => {
                let directory = service.config.chat_image_dir.clone();
                let _ = tokio::task::spawn_blocking(move || cleanup(&directory, SystemTime::now())).await;
            }
        }
    }
}

/// Remove only recognized expired chat images and inaccessible stale temporary writes.
fn cleanup(directory: &Path, now: SystemTime) -> Result<(), ()> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(()),
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let lifetime = if name.starts_with('.') && name.ends_with(".upload") {
            TEMP_LIFETIME
        } else if name.ends_with(".png") || name.ends_with(".jpg") || name.ends_with(".webp") {
            CHAT_LIFETIME
        } else {
            continue;
        };
        if entry
            .metadata()
            .ok()
            .and_then(|metadata| now.duration_since(metadata.modified().ok()?).ok())
            .is_some_and(|age| age >= lifetime)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Signature, atomic publication and expiration fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Build one exact content-type header set.
    fn headers(content_type: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            content_type.parse().expect("content type"),
        );
        headers
    }

    /// MIME declarations must match retained JPEG/PNG/WebP signatures.
    #[test]
    fn image_signature_cases() {
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
        assert_eq!(image_type(&headers("image/png"), &png), Some("png"));
        assert_eq!(image_type(&headers("image/jpeg"), &png), None);
        assert_eq!(image_type(&headers("text/plain"), &png), None);
    }

    /// Fixed-window limits accept exactly the configured count and reset after one hour.
    #[test]
    fn authenticated_rate_limit_boundaries() {
        let limits = Limits::new();
        let now = Instant::now();
        for _ in 0..AVATAR_RATE {
            assert!(limits.allow(b"avatar", "ticket", AVATAR_RATE, now));
        }
        assert!(!limits.allow(b"avatar", "ticket", AVATAR_RATE, now));
        assert!(limits.allow(b"avatar", "other", AVATAR_RATE, now));
        assert!(limits.allow(b"avatar", "ticket", AVATAR_RATE, now + RATE_WINDOW));
    }

    /// Publication is invisible until commit and cleanup removes only recognized expired files.
    #[test]
    fn publication_and_cleanup_cases() {
        let directory = std::env::temp_dir().join(format!("replacement-upload-{}", Uuid::new_v4()));
        let (temporary, filename) = publish(&directory, b"0123456789ab", "png").expect("publish");
        assert!(temporary.exists());
        assert!(!directory.join(&filename).exists());
        commit(&temporary, &directory, &filename).expect("commit");
        let keep = directory.join("keep.txt");
        fs::write(&keep, b"keep").expect("keep");
        cleanup(
            &directory,
            SystemTime::now() + CHAT_LIFETIME + Duration::from_secs(1),
        )
        .expect("cleanup");
        assert!(!directory.join(filename).exists());
        assert!(keep.exists());
        fs::remove_dir_all(directory).expect("remove fixture");
    }
}
