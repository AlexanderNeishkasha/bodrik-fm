//! Shared input normalization policies for accounts, room URLs and library display names.

/// Trim display text and replace filesystem-reserved punctuation with underscores.
pub fn sanitize_name(name: &str) -> String {
    name.trim()
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_")
}

/// Split a trimmed filename at its final dot, requiring nonempty base and extension.
pub fn split_name(name: &str) -> Option<(&str, &str)> {
    let (base, ext) = name.trim().rsplit_once('.')?;
    if base.is_empty() || ext.is_empty() {
        return None;
    }
    Some((base, ext))
}

/// Accept the supported audio/video container extensions, case-insensitively.
pub fn is_allowed_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp3" | "flac" | "m4a" | "wav" | "ogg" | "opus" | "aac" | "mp4" | "webm"
    )
}

/// Require both a usable filename shape and a supported extension.
pub fn is_allowed_file(name: &str) -> bool {
    split_name(name).is_some_and(|(_, ext)| is_allowed_ext(ext))
}

/// Canonicalize 3–48-byte ASCII logins, rejecting unsupported characters.
pub fn normalize_login(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if !(3..=48).contains(&trimmed.len())
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
    {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

/// Canonicalize 3–48-byte public slugs, folding separators and excluding application routes.
pub fn normalize_slug(raw: &str) -> Option<String> {
    let lowered = raw.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(lowered.len());
    let mut previous_dash = false;
    for ch in lowered.chars() {
        let mapped = if ch.is_ascii_alphanumeric() {
            Some(ch)
        } else if matches!(ch, '_' | '-' | ' ') {
            Some('-')
        } else {
            None
        };
        let Some(next) = mapped else {
            continue;
        };
        if next == '-' {
            if previous_dash || out.is_empty() {
                continue;
            }
            previous_dash = true;
        } else {
            previous_dash = false;
        }
        out.push(next);
    }
    while out.ends_with('-') {
        out.pop();
    }
    if !(3..=48).contains(&out.len()) || is_reserved_slug(&out) {
        return None;
    }
    Some(out)
}

/// Prevent new room URLs from shadowing current static frontend/infrastructure routes.
/// Existing conflicting stored slugs need an explicit owner/admin rename, not a data rewrite.
pub fn is_reserved_slug(slug: &str) -> bool {
    matches!(
        slug,
        "studio"
            | "admin"
            | "puppet_master"
            | "api"
            | "ws"
            | "media"
            | "_next"
            | "404"
            | "500"
            | "favicon.ico"
            | "bye"
            | "privacy"
            | "terms"
            | "meeting-unavailable"
            | "download"
    )
}

/// Validate an upload display filename, preserving the 220-byte and supported-extension contract.
pub fn normalize_track_title(raw: &str) -> Option<String> {
    let cleaned = normalize_room_track_title(raw)?;
    is_allowed_file(&cleaned).then_some(cleaned)
}

/// Validate renamed display text without requiring an extension; reject embedded control bytes.
pub fn normalize_room_track_title(raw: &str) -> Option<String> {
    let cleaned = sanitize_name(raw);
    if cleaned.is_empty() || cleaned.len() > 220 || cleaned.chars().any(char::is_control) {
        return None;
    }
    Some(cleaned)
}

/// Collapse whitespace in section names while preserving punctuation and an 80-character limit.
pub fn normalize_section_name(raw: &str) -> Option<String> {
    let cleaned = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() || cleaned.chars().count() > 80 {
        return None;
    }
    Some(cleaned)
}

#[cfg(test)]
mod tests;
