//! Pure YouTube validation/state/error tables; no downloads, files or SQL fixtures.

use super::*;

/// Supported provider hosts and security boundary failures have explicit cases.
#[test]
fn url_cases() {
    for (url, valid) in [
        ("https://youtube.com/watch?v=abc", true),
        ("https://www.youtube.com/shorts/abc", true),
        ("https://m.youtube.com/watch?v=abc", true),
        ("https://music.youtube.com/watch?v=abc", true),
        (" https://youtu.be/abc ", true),
        ("http://youtube.com/watch?v=abc", false),
        ("https://youtube.com.evil.test/watch", false),
        ("https://user:pass@youtube.com/watch", false),
        ("https://youtube.com:444/watch", false),
        ("https://youtube.com/redirect?q=evil", false),
        ("https://youtube.com/attribution_link?q=evil", false),
        ("", false),
        ("invalid", false),
    ] {
        assert_eq!(normalize_url(url).is_ok(), valid, "{url:?}");
    }
    assert!(normalize_url(&format!("https://youtube.com/{}", "a".repeat(2048))).is_err());
    assert_eq!(
        normalize_url("https://youtube.com/watch?v=abc#fragment").unwrap(),
        "https://youtube.com/watch?v=abc"
    );
}

/// Unknown/non-finite/live-like duration cannot masquerade as a zero-length video.
#[test]
fn duration_cases() {
    for (duration, expected) in [
        (None, Err("youtube metadata failed")),
        (Some(0.0), Err("youtube metadata failed")),
        (Some(-1.0), Err("youtube metadata failed")),
        (Some(f64::NAN), Err("youtube metadata failed")),
        (Some(f64::INFINITY), Err("youtube metadata failed")),
        (Some(1.0), Ok(())),
        (Some(MAX_DURATION), Ok(())),
        (Some(MAX_DURATION + 1.0), Err("youtube too long")),
    ] {
        assert_eq!(validate_duration(duration), expected);
    }
}

/// Unicode titles fit the actual byte budget without splitting codepoints.
#[test]
fn title_cases() {
    for raw in [
        None,
        Some("".into()),
        Some("   ".into()),
        Some("Song?/name".into()),
        Some("я".repeat(210)),
        Some("😀".repeat(210)),
        Some("title\nline".into()),
    ] {
        let value = title(&Metadata {
            title: raw,
            duration: None,
            id: None,
        })
        .unwrap();
        assert!(value.len() <= 220);
        assert!(value.ends_with(".m4a"));
        assert!(!value.chars().any(char::is_control));
    }
    assert_eq!(
        title(&Metadata {
            title: None,
            duration: None,
            id: None
        })
        .as_deref(),
        Some("youtube.m4a")
    );
}

/// Downloader lines reject malformed/non-finite/negative and unrelated percentages.
#[test]
fn percent_cases() {
    for (line, expected) in [
        ("[download] 0.0%", Some(0.0)),
        ("[download] 50% of bytes", Some(0.5)),
        ("[download] 100%", Some(1.0)),
        ("[download] 150%", Some(1.0)),
        ("[download] -1%", None),
        ("[download] NaN%", None),
        ("[download] inf%", None),
        ("[download] unknown%", None),
        ("[download] no percentage", None),
        ("unrelated 50%", None),
    ] {
        assert_eq!(percent(line), expected);
    }
}

/// Room count boundaries reserve at most the existing two-job quota.
#[test]
fn admission_cases() {
    for (count, allowed) in [
        (-1, false),
        (0, true),
        (1, true),
        (2, false),
        (3, false),
        (i64::MAX, false),
    ] {
        assert_eq!(can_admit(count), allowed);
    }
}

/// All state pairs are checked against an independent allowlist of forward transitions.
#[test]
fn transition_cases() {
    let allowed = [
        ("queued", "downloading"),
        ("queued", "error"),
        ("downloading", "downloading"),
        ("downloading", "processing"),
        ("downloading", "error"),
        ("processing", "processing"),
        ("processing", "ready"),
        ("processing", "error"),
    ];
    for from in [
        "queued",
        "downloading",
        "processing",
        "ready",
        "error",
        "unknown",
    ] {
        for to in [
            "queued",
            "downloading",
            "processing",
            "ready",
            "error",
            "unknown",
        ] {
            assert_eq!(
                transition(from, to),
                allowed.contains(&(from, to)),
                "{from}->{to}"
            );
        }
    }
    for (status, stage, valid) in [
        ("downloading", "downloading", true),
        ("processing", "processing", true),
        ("processing", "hls", true),
        ("ready", "ready", false),
        ("downloading", "hls", false),
    ] {
        assert_eq!(valid_progress(status, stage, 0.5), valid);
    }
    for (progress, valid) in [
        (0.0, true),
        (0.99, true),
        (1.0, false),
        (-0.1, false),
        (f64::NAN, false),
        (f64::INFINITY, false),
    ] {
        assert_eq!(valid_progress("processing", "hls", progress), valid);
    }
    for (error, public) in [
        ("name exists", "name exists"),
        ("cookie secret detail", "youtube download failed"),
        ("", "youtube download failed"),
    ] {
        assert_eq!(public_error(error), public);
    }
}
