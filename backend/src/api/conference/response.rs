//! No-store token responses and safe browser/API unavailable response negotiation.

use axum::{
    Json,
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{ACCEPT, CACHE_CONTROL},
    },
    response::{IntoResponse, Redirect, Response},
};

/// Return an uncached temporary redirect, rejecting invalid header/scheme configuration.
pub(super) fn no_store_redirect(url: &str) -> Response {
    let valid = url::Url::parse(url).ok().is_some_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
    });
    let response = if valid && HeaderValue::from_str(url).is_ok() {
        Redirect::temporary(url).into_response()
    } else {
        crate::api::internal_error_response("conference.redirect", "invalid redirect URL")
    };
    no_store(response)
}

/// Return token-bearing JSON with the same no-cache policy as redirect admission.
pub(super) fn no_store_json(body: impl serde::Serialize) -> Response {
    no_store(Json(body).into_response())
}

/// Apply one cache policy consistently to all sensitive response forms.
fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Redirect browser invitations only to the configured frontend; API callers retain JSON.
pub(super) fn unavailable_invitation(headers: &HeaderMap) -> Response {
    let url = std::env::var("CONFERENCE_UNAVAILABLE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty());
    unavailable_invitation_with_url(headers, url.as_deref())
}

/// Select unavailable policy without process-global environment mutation.
fn unavailable_invitation_with_url(headers: &HeaderMap, url: Option<&str>) -> Response {
    if accepts_html(headers) {
        if let Some(url) = url {
            return no_store_redirect(url);
        }
        tracing::warn!("CONFERENCE_UNAVAILABLE_URL is not configured");
    }
    no_store(
        crate::api::json_message(StatusCode::NOT_FOUND, "conference not found").into_response(),
    )
}

/// Respect explicit HTML refusal (q=0), not merely the presence of a text/html token.
fn accepts_html(headers: &HeaderMap) -> bool {
    headers
        .get(ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|part| {
                let mut pieces = part.split(';').map(str::trim);
                if !pieces
                    .next()
                    .is_some_and(|kind| kind.eq_ignore_ascii_case("text/html"))
                {
                    return false;
                }
                let quality = pieces.find_map(|param| {
                    param
                        .to_ascii_lowercase()
                        .strip_prefix("q=")
                        .map(str::to_owned)
                });
                quality.is_none_or(|value| {
                    value
                        .parse::<f64>()
                        .is_ok_and(|value| value.is_finite() && value > 0.0 && value <= 1.0)
                })
            })
        })
}

/// Pure response/header/negotiation tables, with no HTTP server.
#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header::LOCATION;

    /// HTML/JSON/missing/zero-quality/malformed accept cases preserve safe response behavior.
    #[test]
    fn unavailable_cases() {
        for (accept, redirect) in [
            (None, false),
            (Some("text/html"), true),
            (Some("text/html;q=0.5,application/json"), true),
            (Some("text/html;q=0"), false),
            (Some("text/html;q=invalid"), false),
            (Some("application/json,*/*"), false),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(value) = accept {
                headers.insert(ACCEPT, HeaderValue::from_str(value).unwrap());
            }
            let response =
                unavailable_invitation_with_url(&headers, Some("https://example.test/unavailable"));
            assert_eq!(
                response.status(),
                if redirect {
                    StatusCode::TEMPORARY_REDIRECT
                } else {
                    StatusCode::NOT_FOUND
                }
            );
            assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        }
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("text/html"));
        assert_eq!(
            unavailable_invitation_with_url(&headers, None).status(),
            StatusCode::NOT_FOUND
        );
    }

    /// Both token JSON and redirect forms are no-store, and unsafe redirects never panic.
    #[test]
    fn token_cache_cases() {
        for (url, valid) in [
            ("https://meet.example/join?token=short-lived", true),
            ("javascript:alert(1)", false),
            ("https://user:pass@meet.example", false),
            ("https://meet.example/\r\n", false),
        ] {
            let response = no_store_redirect(url);
            assert_eq!(
                response.status(),
                if valid {
                    StatusCode::TEMPORARY_REDIRECT
                } else {
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            );
            assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
            assert_eq!(response.headers().contains_key(LOCATION), valid);
        }
        assert_eq!(
            no_store_json(serde_json::json!({"join_url":"signed"})).headers()[CACHE_CONTROL],
            "no-store"
        );
    }
}
