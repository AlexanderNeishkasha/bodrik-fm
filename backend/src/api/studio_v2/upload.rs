//! Streaming upload ownership and accepted-body publication/persistence supervision.

use super::{auth::studio_user_from_http_async, context::db_task};
use crate::api::media_v2::Artifacts;
use crate::api::{
    AppState, db_v2, internal_error_response, json_message, media_v2, runtime_v2, util_v2,
};
use axum::{
    extract::{Multipart, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::{io::ErrorKind, path::PathBuf};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

/// Existing multipart request budget; JSON endpoints use a smaller independent budget.
pub(crate) const UPLOAD_BODY_LIMIT: usize = 1024 * 1024 * 1024;

/// A fully received upload whose publication/processing/SQL completion is now owned.
struct CompletedUpload {
    /// Authorized room identity.
    room: i64,
    /// Sanitized display title.
    title: String,
    /// Server-generated original-file key.
    key: String,
    /// Exclusively created receiving file.
    temporary: PathBuf,
    /// Destination-filesystem staging file used only for cross-device publication.
    staged: PathBuf,
    /// Published original-file destination.
    original: PathBuf,
    /// Optional owned HLS destination.
    hls: PathBuf,
    /// Uncommitted cleanup obligations, transferred into the owned continuation.
    artifacts: Artifacts,
}

/// Receive one supported file with bounded streaming memory and owned temporary cleanup.
/// After a complete flushed body, publication/processing/SQL finish even if the
/// initiating HTTP connection disappears; failed/uncommitted artifacts are removed.
pub async fn upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    let user = match studio_user_from_http_async(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return *response,
    };
    loop {
        let mut field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => return json_message(StatusCode::BAD_REQUEST, "no file").into_response(),
            Err(_) => {
                return json_message(StatusCode::BAD_REQUEST, "invalid upload").into_response();
            }
        };
        if field.name().unwrap_or("file") != "file" {
            continue;
        }
        let original = util_v2::sanitize_name(field.file_name().unwrap_or("track"));
        let Some(title) = util_v2::normalize_track_title(&original) else {
            return json_message(StatusCode::BAD_REQUEST, "unsupported format").into_response();
        };
        let check_state = state.clone();
        let check_title = title.clone();
        match db_task(move || {
            db_v2::room_track_title_exists(&check_state, user.room_id, &check_title)
        })
        .await
        {
            Ok(true) => return json_message(StatusCode::CONFLICT, "name exists").into_response(),
            Ok(false) => {}
            Err(err) => return internal_error_response("studio.upload.title_exists", err),
        }
        let Some((_, ext)) = util_v2::split_name(&title) else {
            return json_message(StatusCode::BAD_REQUEST, "invalid filename").into_response();
        };
        let uuid = Uuid::new_v4();
        let key = format!("{uuid}.{ext}");
        let temporary = std::path::Path::new(&state.temp_upload_dir).join(format!("{uuid}.upload"));
        let create_path = temporary.clone();
        // The creation worker owns the guard as well as the file, even if its await is cancelled.
        let (mut out, artifacts) = match tokio::task::spawn_blocking(move || {
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&create_path)?;
            let mut artifacts = Artifacts::new();
            artifacts.file(create_path);
            Ok::<_, std::io::Error>((tokio::fs::File::from_std(file), artifacts))
        })
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(err)) => return internal_error_response("studio.upload.create_temp", err),
            Err(err) => return internal_error_response("studio.upload.create_temp.task", err),
        };
        let mut size = 0;
        loop {
            let chunk = match field.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => {
                    return json_message(StatusCode::BAD_REQUEST, "invalid upload").into_response();
                }
            };
            let Some(next) = next_size(size, chunk.len()) else {
                return json_message(StatusCode::PAYLOAD_TOO_LARGE, "upload too large")
                    .into_response();
            };
            size = next;
            if let Err(err) = out.write_all(&chunk).await {
                return internal_error_response("studio.upload.write", err);
            }
        }
        if size == 0 {
            return json_message(StatusCode::BAD_REQUEST, "empty upload").into_response();
        }
        if let Err(err) = out.flush().await {
            return internal_error_response("studio.upload.flush", err);
        }
        drop(out);
        let upload = CompletedUpload {
            room: user.room_id,
            title,
            original: media_v2::media_path(&state, &key),
            hls: media_v2::hls_dir(&state, &key),
            staged: std::path::Path::new(&state.media_dir).join(format!(".{uuid}.upload")),
            key,
            temporary,
            artifacts,
        };
        return match tokio::spawn(finish_upload(state, upload)).await {
            Ok(response) => response,
            Err(err) => internal_error_response("studio.upload.command", err),
        };
    }
}

/// Own native publication and optional processing until commit or artifact cleanup.
async fn finish_upload(state: AppState, upload: CompletedUpload) -> Response {
    let upload = match tokio::task::spawn_blocking(move || publish(upload)).await {
        Ok(Ok(upload)) => upload,
        Ok(Err(err)) => return internal_error_response("studio.upload.publish", err),
        Err(err) => return internal_error_response("studio.upload.publish.task", err),
    };
    let duration = media_v2::process_uploaded_file(&state, &upload.original, &upload.key).await;
    let db_state = state.clone();
    let room = upload.room;
    match db_task(move || {
        let mut upload = upload;
        db_v2::create_room_upload_track(
            &db_state,
            upload.room,
            &upload.key,
            &upload.title,
            duration,
        )?;
        upload.artifacts.keep(&upload.original);
        upload.artifacts.keep(&upload.hls);
        Ok(())
    })
    .await
    {
        Ok(()) => {
            match runtime_v2::ensure_room_runtime(&state, room).await {
                Ok(runtime) => {
                    runtime_v2::bump_library(&runtime);
                    runtime_v2::notify(&runtime);
                }
                Err(error) => {
                    tracing::error!(%error, "upload committed but runtime notification failed")
                }
            }
            json_message(StatusCode::OK, "ok").into_response()
        }
        Err(err) if err.contains("idx_room_tracks_title_unique") => {
            json_message(StatusCode::CONFLICT, "name exists").into_response()
        }
        Err(err) => internal_error_response("studio.upload.insert", err),
    }
}

/// Publish within one filesystem, copying through a staging file only for cross-device moves.
/// The blocking worker owns all paths until it completes, including cancellation.
///
/// # Errors
/// Returns native move/copy errors; ownership guards remove uncommitted results.
fn publish(mut upload: CompletedUpload) -> Result<CompletedUpload, std::io::Error> {
    upload.artifacts.file(upload.staged.clone());
    upload.artifacts.file(upload.original.clone());
    upload.artifacts.directory(upload.hls.clone());
    if let Err(error) = std::fs::rename(&upload.temporary, &upload.original) {
        if !needs_copy(error.kind()) {
            return Err(error);
        }
        std::fs::copy(&upload.temporary, &upload.staged)?;
        std::fs::rename(&upload.staged, &upload.original)?;
    }
    Ok(upload)
}

/// Restrict cross-filesystem fallback to the native cross-device error.
fn needs_copy(kind: ErrorKind) -> bool {
    kind == ErrorKind::CrossesDevices
}

/// Count bytes without overflow, rejecting anything above the multipart budget.
fn next_size(current: usize, chunk: usize) -> Option<usize> {
    current
        .checked_add(chunk)
        .filter(|size| *size <= UPLOAD_BODY_LIMIT)
}

/// Pure byte-budget/publication decisions without multipart/filesystem fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Empty/minimum/max/overflow and specific copy-fallback decisions have explicit cases.
    #[test]
    fn upload_policy_cases() {
        for (current, chunk, expected) in [
            (0, 0, Some(0)),
            (0, 1, Some(1)),
            (UPLOAD_BODY_LIMIT - 1, 1, Some(UPLOAD_BODY_LIMIT)),
            (UPLOAD_BODY_LIMIT, 1, None),
            (usize::MAX, 1, None),
            (0, usize::MAX, None),
        ] {
            assert_eq!(next_size(current, chunk), expected);
        }
        for (kind, copy) in [
            (ErrorKind::CrossesDevices, true),
            (ErrorKind::PermissionDenied, false),
            (ErrorKind::NotFound, false),
            (ErrorKind::AlreadyExists, false),
        ] {
            assert_eq!(needs_copy(kind), copy);
        }
    }
}
