//! Read-only public delivery of Rust-published avatar and chat images.
//!
//! The removed static shell used to serve these volumes. Only canonical
//! `<uuid>.<png|jpg|webp>` names inside the configured directories are readable, so
//! no path traversal, listing, temporary sibling or foreign file can be addressed.
use super::Service;
use axum::{
    Router,
    extract::{Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use std::{fs, io::Read, path::PathBuf};
use uuid::Uuid;

/// Largest published image (the chat upload limit); larger files are never served.
const READ_LIMIT: u64 = 5 * 1024 * 1024;

/// Public read routes for the two Rust-owned upload namespaces.
pub(super) fn routes() -> Router<Service> {
    Router::new()
        .route("/uploads/avatars/{name}", get(avatar))
        .route("/uploads/chat/{name}", get(chat))
}

/// Serve one avatar; avatar names are immutable UUIDs, so a day of caching is safe.
async fn avatar(State(service): State<Service>, Path(name): Path<String>) -> Response {
    serve(
        service.config.avatar_dir.clone(),
        name,
        "public, max-age=86400",
    )
    .await
}

/// Serve one chat image; images expire server-side, so keep caching private and short.
async fn chat(State(service): State<Service>, Path(name): Path<String>) -> Response {
    serve(
        service.config.chat_image_dir.clone(),
        name,
        "private, max-age=3600",
    )
    .await
}

/// Map a canonical image name to its content type, rejecting everything else.
///
/// Returns `None` unless the stem is a canonical lowercase hyphenated UUID and the
/// extension is one the upload handler publishes.
fn content_type(name: &str) -> Option<&'static str> {
    let (stem, extension) = name.split_once('.')?;
    let id = Uuid::parse_str(stem).ok()?;
    if id.hyphenated().to_string() != stem {
        return None;
    }
    match extension {
        "png" => Some("image/png"),
        "jpg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Read one validated file off the async workers and attach safe response headers.
async fn serve(directory: PathBuf, name: String, cache: &'static str) -> Response {
    let Some(kind) = content_type(&name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = directory.join(&name);
    let read = tokio::task::spawn_blocking(move || -> std::io::Result<Option<Vec<u8>>> {
        let file = fs::File::open(path)?;
        if !file.metadata()?.is_file() {
            return Ok(None);
        }
        let mut body = Vec::new();
        file.take(READ_LIMIT + 1).read_to_end(&mut body)?;
        Ok((body.len() as u64 <= READ_LIMIT).then_some(body))
    })
    .await;
    let Ok(Ok(Some(body))) = read else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only canonical published names resolve to an image type.
    #[test]
    fn content_type_accepts_only_canonical_names() {
        let id = Uuid::new_v4();
        for (name, expected) in [
            (format!("{id}.png"), Some("image/png")),
            (format!("{id}.jpg"), Some("image/jpeg")),
            (format!("{id}.webp"), Some("image/webp")),
            (format!("{id}.svg"), None),
            (format!("{id}.png.png"), None),
            (format!("{}.png", id.simple()), None),
            (format!("{}.png", id.to_string().to_uppercase()), None),
            (format!(".{id}.upload"), None),
            ("../secret.png".into(), None),
            ("..%2fsecret.png".into(), None),
            ("".into(), None),
        ] {
            assert_eq!(content_type(&name), expected, "{name}");
        }
    }

    /// Existing files are served with safe headers; missing, oversized and invalid names are 404.
    #[tokio::test]
    async fn serve_reads_only_bounded_existing_files() {
        let directory = std::env::temp_dir().join(format!("replacement-read-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("directory");
        let small = format!("{}.png", Uuid::new_v4());
        fs::write(directory.join(&small), b"\x89PNG\r\n\x1a\nbody").expect("small");
        let large = format!("{}.png", Uuid::new_v4());
        fs::write(directory.join(&large), vec![0_u8; READ_LIMIT as usize + 1]).expect("large");
        let folder = format!("{}.png", Uuid::new_v4());
        fs::create_dir_all(directory.join(&folder)).expect("folder");

        let ok = serve(directory.clone(), small, "private, max-age=3600").await;
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(ok.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(ok.headers()[header::CACHE_CONTROL], "private, max-age=3600");
        for name in [
            large,
            folder,
            format!("{}.png", Uuid::new_v4()),
            "../x.png".into(),
        ] {
            let response = serve(directory.clone(), name.clone(), "x").await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{name}");
        }
        fs::remove_dir_all(directory).expect("cleanup");
    }
}
