//! Bounded streaming attachment publication; nginx owns authorized download byte serving.
use super::{ChatState, database, failure, identity, response, store, types::*};
use axum::{
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use percent_encoding::percent_decode_str;
use serde_json::json;
use std::{path::Path as DiskPath, time::Duration};
use tokio::io::AsyncWriteExt;

/// Read and validate display metadata without giving uploaded names filesystem semantics.
///
/// # Errors
/// Rejects malformed names, sizes and unsupported image size budgets.
pub(super) fn metadata_input(
    headers: &HeaderMap,
) -> Result<(String, String, String, u64), StatusCode> {
    let encoded = headers
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::BAD_REQUEST)?;
    let name = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .into_owned();
    if name.trim().is_empty()
        || name.encode_utf16().count() > 255
        || name
            .chars()
            .any(|v| v.is_control() || matches!(v, '/' | ':') || v == char::from(92))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let media = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream");
    let image = matches!(media, "image/png" | "image/jpeg" | "image/webp");
    let size = headers
        .get("x-file-size")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0 && *v <= if image { IMAGE_LIMIT } else { FILE_LIMIT })
        .ok_or(StatusCode::PAYLOAD_TOO_LARGE)?;
    Ok((
        name,
        if image {
            media.into()
        } else {
            "application/octet-stream".into()
        },
        if image {
            "image".into()
        } else {
            "document".into()
        },
        size,
    ))
}

/// Recognize the same raster image signatures accepted by the existing meeting upload path.
fn image_matches(media: &str, bytes: &[u8]) -> bool {
    match media {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    }
}

/// Stream an exact-size upload into an exclusively created staging file and sync it.
///
/// # Errors
/// Rejects body failures, size mismatch, timeout, malformed raster signatures and disk errors.
async fn receive(request: Request, path: &DiskPath, file: &Attachment) -> Result<(), StatusCode> {
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stream = request.into_body().into_data_stream();
    let mut count = 0_u64;
    let mut prefix = Vec::with_capacity(16);
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(60), stream.next())
        .await
        .map_err(|_| StatusCode::REQUEST_TIMEOUT)?
    {
        let chunk = chunk.map_err(|_| StatusCode::BAD_REQUEST)?;
        count = count
            .checked_add(chunk.len() as u64)
            .filter(|v| *v <= file.size)
            .ok_or(StatusCode::PAYLOAD_TOO_LARGE)?;
        prefix.extend_from_slice(&chunk[..chunk.len().min(16 - prefix.len())]);
        output
            .write_all(&chunk)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    if count != file.size || (file.kind == "image" && !image_matches(&file.media_type, &prefix)) {
        return Err(StatusCode::BAD_REQUEST);
    }
    output
        .sync_all()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// Receive a bounded attachment and register it only after rechecking generation and actor authority.
pub(super) async fn upload(
    State(state): State<ChatState>,
    Path(conference): Path<String>,
    request: Request,
) -> Response {
    let who = match identity(&state, conference, request.headers()) {
        Ok(who) => who,
        Err(status) => return status.into_response(),
    };
    let (name, media_type, kind, size) = match metadata_input(request.headers()) {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    match publish(&state, who, (name, media_type, kind, size), request).await {
        Ok(file) => response(file),
        Err(error) => failure(error),
    }
}

/// Publish one attachment through the sole storage owner; HTTP and embedded calls share checks.
///
/// # Errors
/// Returns authority, quota, stream validation, publication and database failures.
pub(super) async fn publish(
    state: &ChatState,
    who: Identity,
    metadata: (String, String, String, u64),
    request: Request,
) -> Result<Attachment, String> {
    let (name, media_type, kind, size) = metadata;
    let _permit = state
        .uploads
        .clone()
        .try_acquire_owned()
        .map_err(|_| "capacity".to_owned())?;
    let check = who.clone();
    database(state, move |conn| store::room(conn, &check)).await?;
    if tokio::fs::create_dir_all(&state.directory).await.is_err() {
        return Err("unavailable".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let ext = match media_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "bin",
    };
    let key = format!("upload-{now}-{id}.{ext}");
    let temporary = state.directory.join(format!(".{id}.upload"));
    let published = state.directory.join(&key);
    let file = Attachment {
        id,
        name,
        media_type,
        kind,
        size,
    };
    if let Err(status) = receive(request, &temporary, &file).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(match status {
            StatusCode::PAYLOAD_TOO_LARGE => "capacity",
            StatusCode::BAD_REQUEST => "invalid",
            _ => "unavailable",
        }
        .into());
    }
    // Hard-link publication refuses to replace an existing destination, even on an ID collision.
    if let Err(error) = tokio::fs::hard_link(&temporary, &published).await {
        tracing::error!(%error,"chat attachment publication failed");
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err("unavailable".into());
    }
    let _ = tokio::fs::remove_file(&temporary).await;
    let registered = file.clone();
    match database(state, move |conn| {
        store::register(conn, &who, &registered, &key, now)
    })
    .await
    {
        Ok(()) => Ok(file),
        Err(error) => {
            let _ = tokio::fs::remove_file(&published).await;
            Err(error)
        }
    }
}

/// Return an internal nginx storage key only for a currently published same-room attachment.
pub(super) async fn metadata(
    State(state): State<ChatState>,
    Path((conference, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let who = match identity(&state, conference, &headers) {
        Ok(who) => who,
        Err(status) => return status.into_response(),
    };
    if !uuid_key(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match database(&state, move |conn| store::attachment(conn, &who, &id)).await {
        Ok((attachment, key)) => response(json!({"attachment":attachment,"storageKey":key})),
        Err(error) => failure(error),
    }
}

/// Accept only generated single-component storage names before filesystem cleanup or nginx mapping.
pub(super) fn storage_key(value: &str) -> bool {
    let Some((prefix, ext)) = value.rsplit_once('.') else {
        return false;
    };
    let Some(rest) = prefix.strip_prefix("upload-") else {
        return false;
    };
    let Some((time, id)) = rest.split_once('-') else {
        return false;
    };
    time.parse::<u64>().is_ok() && uuid_key(id) && matches!(ext, "png" | "jpg" | "webp" | "bin")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exact size and raster signatures are enforced before publication.
    #[tokio::test]
    async fn stream_validation_cases() {
        let directory = std::env::temp_dir().join(format!("chat-stream-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("directory");
        for (name, media, bytes, declared, expected) in [
            (
                "document",
                "application/octet-stream",
                b"hello".as_slice(),
                5,
                true,
            ),
            (
                "short",
                "application/octet-stream",
                b"hello".as_slice(),
                6,
                false,
            ),
            (
                "long",
                "application/octet-stream",
                b"hello".as_slice(),
                4,
                false,
            ),
            ("forged png", "image/png", b"hello".as_slice(), 5, false),
            (
                "png",
                "image/png",
                b"\x89PNG\r\n\x1a\nbody".as_slice(),
                12,
                true,
            ),
        ] {
            let file = Attachment {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.into(),
                media_type: media.into(),
                kind: if media.starts_with("image/") {
                    "image"
                } else {
                    "document"
                }
                .into(),
                size: declared,
            };
            let request = Request::new(axum::body::Body::from(bytes));
            assert_eq!(
                receive(request, &directory.join(name), &file).await.is_ok(),
                expected,
                "{name}"
            );
        }
        tokio::fs::remove_dir_all(directory)
            .await
            .expect("cleanup test directory");
    }

    /// Names and declared size budgets cannot select filesystem paths or bypass limits.
    #[test]
    fn upload_metadata_cases() {
        for (name, size, media, valid) in [
            ("rules.pdf", "5", "application/pdf", true),
            ("%D0%A4%D0%B0%D0%B9%D0%BB.txt", "5", "text/plain", true),
            ("..%2Fsecret", "5", "text/plain", false),
            ("%00.txt", "5", "text/plain", false),
            ("photo.png", "5242881", "image/png", false),
            ("big.zip", "104857601", "application/zip", false),
            ("empty.txt", "0", "text/plain", false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("x-file-name", name.parse().expect("name"));
            headers.insert("x-file-size", size.parse().expect("size"));
            headers.insert("content-type", media.parse().expect("media"));
            assert_eq!(metadata_input(&headers).is_ok(), valid, "{name}");
        }
    }
}
