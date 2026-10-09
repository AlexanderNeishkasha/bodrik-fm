//! Owner-authenticated attachment streaming and internal nginx download authorization.
use super::{Service, persistent_chat, session};
use axum::{
    Router,
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::Value;

/// Persistent attachment API, with explicitly bounded streaming bodies.
pub(super) fn routes() -> Router<Service> {
    Router::new()
        .route(
            "/api/meeting/chat-attachments",
            post(upload).layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route("/api/meeting/chat-attachments/{id}", get(download))
}

/// Resolve the exact connected owner before trusting any public upload metadata.
///
/// # Errors
/// Rejects missing or forged proofs, stale sessions and denied runtime authority.
fn identity(
    service: &Service,
    headers: &HeaderMap,
    send: bool,
) -> Result<(crate::signaling::SessionStamp, persistent_chat::Authority), StatusCode> {
    let proof = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let id = headers
        .get("x-meeting-session-id")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let stamp = {
        let store = service
            .store
            .lock()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let session = store
            .sessions
            .get(id)
            .filter(|s| {
                s.events.is_some()
                    && session::proves(&s.owner, session::owner_purpose(&s.actor).as_bytes(), proof)
            })
            .ok_or(StatusCode::FORBIDDEN)?;
        session.stamp.clone()
    };
    let who =
        persistent_chat::authority(service, &stamp, send).map_err(|_| StatusCode::FORBIDDEN)?;
    Ok((stamp, who))
}

/// Forward bytes without buffering whole files or accepting caller-selected destinations.
async fn upload(State(service): State<Service>, request: Request) -> Response {
    let (stamp, who) = match identity(&service, request.headers(), true) {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let headers = request.headers();
    let Some(name) = headers
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let media = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let Some(size) = headers
        .get("x-file-size")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0 && *v <= 104_857_600)
    else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let upload = crate::integration::services::Upload {
        encoded_name: name,
        media_type: media,
        size,
        body: request.into_body(),
    };
    match service.config.player.upload(&who.claims(), upload).await {
        Ok(value) if persistent_chat::authority(&service, &stamp, true).is_ok() => {
            axum::Json(value).into_response()
        }
        Ok(_) => StatusCode::FORBIDDEN.into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

/// Authorize a same-room attachment before nginx serves its bytes from an internal location.
async fn download(
    State(service): State<Service>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (stamp, who) = match identity(&service, &headers, false) {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if uuid::Uuid::parse_str(&id)
        .ok()
        .is_none_or(|v| v.to_string() != id)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let result = service
        .config
        .player
        .chat(
            &who.claims(),
            crate::integration::services::ChatOperation::Attachment(id),
        )
        .await;
    let Ok(value) = result else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if persistent_chat::authority(&service, &stamp, false).is_err() {
        return StatusCode::FORBIDDEN.into_response();
    }
    authorized_file(value)
}

/// Build safe byte-serving headers from validated backend metadata, never from browser paths.
fn authorized_file(value: Value) -> Response {
    let Some(key) = value["storageKey"].as_str().filter(|key| valid_key(key)) else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let Some(name) = value["attachment"]["name"].as_str() else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let image = value["attachment"]["kind"] == "image";
    let media = if image {
        value["attachment"]["mediaType"]
            .as_str()
            .filter(|v| matches!(*v, "image/png" | "image/jpeg" | "image/webp"))
            .unwrap_or("application/octet-stream")
    } else {
        "application/octet-stream"
    };
    let encoded = url::form_urlencoded::byte_serialize(name.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    let disposition = format!(
        "{}; filename=\"attachment\"; filename*=UTF-8''{encoded}",
        if image { "inline" } else { "attachment" }
    );
    let mut response = ().into_response();
    for (name, value) in [
        ("x-accel-redirect", format!("/_chat_attachments/{key}")),
        ("content-type", media.into()),
        ("content-disposition", disposition),
        ("cache-control", "private, no-store".into()),
        ("x-content-type-options", "nosniff".into()),
    ] {
        let Ok(value) = HeaderValue::from_str(&value) else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        response.headers_mut().insert(name, value);
    }
    response
}

/// Only canonical immutable single-component file keys reach nginx.
fn valid_key(key: &str) -> bool {
    let Some((stem, ext)) = key.rsplit_once('.') else {
        return false;
    };
    let Some((time, id)) = stem.strip_prefix("upload-").and_then(|v| v.split_once('-')) else {
        return false;
    };
    time.parse::<u64>().is_ok()
        && uuid::Uuid::parse_str(id).is_ok_and(|v| v.to_string() == id)
        && matches!(ext, "bin" | "png" | "jpg" | "webp")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Only canonical storage keys can produce an nginx internal redirect.
    #[test]
    fn redirect_boundary_cases() {
        let id = uuid::Uuid::new_v4();
        for (key, valid) in [
            (format!("upload-1-{id}.bin"), true),
            (format!("upload-1-{id}.png"), true),
            (format!("upload-1-{id}.html"), false),
            ("../secret".into(), false),
            ("upload-1-deadbeef.bin".into(), false),
        ] {
            assert_eq!(valid_key(&key), valid, "{key}");
        }
        let response = authorized_file(
            json!({"storageKey":format!("upload-1-{id}.bin"),"attachment":{"name":"Файл.txt","kind":"document","mediaType":"text/html"}}),
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            "application/octet-stream"
        );
        assert!(
            response.headers()["content-disposition"]
                .to_str()
                .expect("header")
                .starts_with("attachment;")
        );
        assert!(
            response.headers()["content-disposition"]
                .to_str()
                .expect("header")
                .contains("%D0")
        );
        assert_eq!(
            authorized_file(json!({"storageKey":"../secret"})).status(),
            StatusCode::BAD_GATEWAY
        );
    }
}
