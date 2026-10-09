//! Pure YouTube URL, metadata, progress and job-transition decisions.

use crate::api::util_v2;
use serde::Deserialize;

/// Existing maximum accepted video duration: five hours.
pub(crate) const MAX_DURATION: f64 = 18_000.0;
/// Existing maximum active jobs per room, enforced within admission's transaction.
pub(crate) const MAX_ACTIVE: i64 = 2;

/// Decide room quota admission without treating invalid counts as available capacity.
pub(crate) fn can_admit(active: i64) -> bool {
    (0..MAX_ACTIVE).contains(&active)
}

/// Minimal native metadata, excluding downloader diagnostics or cookies.
#[derive(Deserialize)]
pub(crate) struct Metadata {
    /// Optional human-readable video title.
    pub title: Option<String>,
    /// Known finite video duration in seconds.
    pub duration: Option<f64>,
    /// Optional provider video identity.
    pub id: Option<String>,
}

/// Normalize supported HTTPS YouTube URLs, excluding credentials, ports and redirect gateways.
///
/// # Errors
/// Returns the existing invalid-URL message for unsupported input.
pub(crate) fn normalize_url(raw: &str) -> Result<String, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 2048 {
        return Err("invalid youtube url");
    }
    let mut url = url::Url::parse(raw).map_err(|_| "invalid youtube url")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !matches!(
            url.host_str(),
            Some(
                "youtube.com"
                    | "www.youtube.com"
                    | "m.youtube.com"
                    | "music.youtube.com"
                    | "youtu.be"
            )
        )
        || matches!(url.path(), "/redirect" | "/attribution_link")
    {
        return Err("invalid youtube url");
    }
    url.set_fragment(None);
    Ok(url.to_string())
}

/// Require known finite positive duration; unknown/live streams cannot bypass the maximum.
///
/// # Errors
/// Returns existing metadata or duration-limit messages.
pub(crate) fn validate_duration(duration: Option<f64>) -> Result<(), &'static str> {
    let duration = duration
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or("youtube metadata failed")?;
    if duration > MAX_DURATION {
        return Err("youtube too long");
    }
    Ok(())
}

/// Sanitize a human title within the actual UTF-8 byte budget, reserving the m4a suffix.
pub(crate) fn title(metadata: &Metadata) -> Option<String> {
    let sanitized = util_v2::sanitize_name(metadata.title.as_deref().unwrap_or("youtube"));
    let mut base = String::new();
    for ch in sanitized.trim().chars() {
        let ch = if ch.is_control() { '_' } else { ch };
        if base.len() + ch.len_utf8() > 216 {
            break;
        }
        base.push(ch);
    }
    if base.is_empty() {
        base.push_str("youtube");
    }
    util_v2::normalize_track_title(&format!("{base}.m4a"))
}

/// Parse only downloader percentage lines, rejecting negative/non-finite values before clamping.
pub(crate) fn percent(line: &str) -> Option<f64> {
    if !line.starts_with("[download]") {
        return None;
    }
    let raw = line[..line.find('%')?].split_whitespace().last()?;
    let value = raw.parse::<f64>().ok()?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    Some((value / 100.0).min(1.0))
}

/// Match the supported nonterminal state/stage vocabulary.
pub(crate) fn valid_progress(status: &str, stage: &str, progress: f64) -> bool {
    progress.is_finite()
        && (0.0..=0.99).contains(&progress)
        && matches!(
            (status, stage),
            ("downloading", "downloading") | ("processing", "processing" | "hls")
        )
}

/// Allow forward nonterminal transitions and repeated progress only, never terminal regression.
pub(crate) fn transition(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("queued", "downloading" | "error")
            | ("downloading", "downloading" | "processing" | "error")
            | ("processing", "processing" | "ready" | "error")
    )
}

/// Preserve only public error classifications; never expose native stderr/cookie paths.
pub(crate) fn public_error(error: &str) -> &'static str {
    if error == "name exists" {
        "name exists"
    } else {
        "youtube download failed"
    }
}

#[cfg(test)]
mod tests;
