//! YouTube HTTP admission/dismissal; native work and SQLite never block async workers.

pub(crate) mod policy;

use crate::api::{
    AppState, blocking, internal_error_response, json_message, runtime, studio,
    youtube_download_runner, youtube_jobs,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

/// Submit one supported YouTube media URL for the effective Studio room.
#[derive(serde::Deserialize)]
pub struct YoutubeDownloadRequest {
    /// HTTPS provider URL, validated before invoking the downloader.
    url: String,
}

/// Dismiss an error job belonging to the effective Studio room.
#[derive(serde::Deserialize)]
pub struct YoutubeDismissRequest {
    /// Server-generated job identity.
    id: String,
}

/// Probe bounded metadata, atomically reserve room quota, and start owned download work.
pub async fn submit_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<YoutubeDownloadRequest>,
) -> Response {
    let user = match studio::studio_user_from_http_async(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return *response,
    };
    let url = match policy::normalize_url(&payload.url) {
        Ok(url) => url,
        Err(message) => return json_message(StatusCode::BAD_REQUEST, message).into_response(),
    };
    let check_state = state.clone();
    match blocking::db_task(move || youtube_jobs::active_room_job_count(&check_state, user.room_id))
        .await
    {
        Ok(count) if !policy::can_admit(count) => {
            return json_message(StatusCode::CONFLICT, "download busy").into_response();
        }
        Ok(_) => {}
        Err(err) => return internal_error_response("youtube.active_count", err),
    }
    let permit = match state.youtube_download_limiter.clone().acquire_owned().await {
        Ok(permit) => permit,
        Err(err) => return internal_error_response("youtube.metadata.queue", err),
    };
    let metadata = match youtube_download_runner::fetch_metadata(&url).await {
        Ok(metadata) => metadata,
        Err(err) => {
            tracing::warn!(%err, "youtube metadata probe failed");
            return json_message(StatusCode::BAD_GATEWAY, "youtube metadata failed")
                .into_response();
        }
    };
    drop(permit);
    if let Err(message) = policy::validate_duration(metadata.duration) {
        let status = if message == "youtube too long" {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::BAD_GATEWAY
        };
        return json_message(status, message).into_response();
    }
    let Some(title) = policy::title(&metadata) else {
        return json_message(StatusCode::BAD_GATEWAY, "youtube metadata failed").into_response();
    };
    let room = user.room_id;
    let job_id = uuid::Uuid::new_v4().to_string();
    let job_state = state.clone();
    // The admission worker owns dispatch after commit, even if its requesting future disappears.
    match blocking::op_task(move || {
        youtube_jobs::create_job(
            &job_state,
            youtube_jobs::CreateYoutubeJob {
                id: &job_id,
                room_id: room,
                user_id: user.user_id,
                url: &url,
                video_id: metadata.id.as_deref(),
                title: &title,
            },
        )?;
        let _job = tokio::spawn(youtube_download_runner::run_download_job(
            job_state, job_id, room, url, title,
        ));
        Ok(())
    })
    .await
    {
        Ok(()) => {}
        Err(err) => return err.respond("youtube.admission"),
    }
    let query_state = state.clone();
    match blocking::db_task(move || youtube_jobs::list_room_jobs(&query_state, room)).await {
        Ok(jobs) => Json(jobs).into_response(),
        Err(err) => internal_error_response("youtube.list_jobs", err),
    }
}

/// Remove only an error owned by the effective room; active/other-room jobs remain untouched.
pub async fn dismiss_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<YoutubeDismissRequest>,
) -> Response {
    let user = match studio::studio_user_from_http_async(&state, &headers).await {
        Ok(user) => user,
        Err(response) => return *response,
    };
    if uuid::Uuid::parse_str(&payload.id).is_err() {
        return json_message(StatusCode::BAD_REQUEST, "invalid id").into_response();
    }
    let command = tokio::spawn(async move {
        let query_state = state.clone();
        match blocking::db_task(move || {
            youtube_jobs::delete_error_job(&query_state, user.room_id, &payload.id)
        })
        .await
        {
            Ok(true) => {
                notify_room(&state, user.room_id, false).await;
                json_message(StatusCode::OK, "ok").into_response()
            }
            Ok(false) => json_message(StatusCode::NOT_FOUND, "missing").into_response(),
            Err(err) => internal_error_response("youtube.dismiss", err),
        }
    });
    match command.await {
        Ok(response) => response,
        Err(err) => internal_error_response("youtube.dismiss.task", err),
    }
}

/// Recover interrupted jobs off-thread before serving requests.
///
/// # Errors
/// Returns recovery SQL/worker errors rather than silently starting with stale active jobs.
pub async fn init_jobs(state: &AppState) -> Result<(), String> {
    let state = state.clone();
    blocking::db_task(move || youtube_jobs::reset_active_jobs(&state)).await
}

/// Wake current room observers after progress/terminal changes; persistence doesn't depend on runtime loading.
pub(crate) async fn notify_room(state: &AppState, room: i64, library: bool) {
    match runtime::ensure_room_runtime(state, room).await {
        Ok(runtime) => {
            if library {
                runtime::bump_library(&runtime);
            }
            runtime::notify(&runtime);
        }
        Err(error) => {
            tracing::warn!(room_id = room, %error, "youtube room notification unavailable")
        }
    }
}
