//! Pure input-normalization tables, including identity, routing and filename boundaries.

use super::*;

/// Login length/ASCII/vocabulary/case rules reject unsupported inputs without ambiguity.
#[test]
fn login_cases() {
    for (raw, expected) in [
        (" Alice_1-2. ".to_owned(), Some("alice_1-2.".to_owned())),
        ("abc".into(), Some("abc".into())),
        ("x".repeat(48), Some("x".repeat(48))),
        ("x".repeat(49), None),
        ("ab".into(), None),
        ("".into(), None),
        ("a b".into(), None),
        ("Имя".into(), None),
        ("abc/def".into(), None),
    ] {
        assert_eq!(normalize_login(&raw), expected, "{raw:?}");
    }
}

/// Slug separator/length/reserved-page branches match the static application URL surface.
#[test]
fn slug_cases() {
    for (raw, expected) in [
        (" --Room__Name-- ".into(), Some("room-name".into())),
        ("abc!def".into(), Some("abcdef".into())),
        ("abc".into(), Some("abc".into())),
        ("x".repeat(48), Some("x".repeat(48))),
        ("x".repeat(49), None),
        ("---".into(), None),
        ("".into(), None),
        ("ab".into(), None),
        ("Имя".into(), None),
    ] {
        assert_eq!(normalize_slug(&raw), expected, "{raw:?}");
    }
    for page in [
        "studio",
        "admin",
        "puppet_master",
        "api",
        "ws",
        "media",
        "_next",
        "404",
        "500",
        "favicon.ico",
        "bye",
        "privacy",
        "terms",
        "meeting-unavailable",
        "download",
    ] {
        assert!(is_reserved_slug(page), "{page}");
    }
    for page in [
        "bye",
        "privacy",
        "terms",
        "meeting-unavailable",
        "download",
        "studio",
    ] {
        assert_eq!(normalize_slug(page), None, "static page {page}");
    }
    assert!(!is_reserved_slug("room"));
}

/// Every extension plus malformed basename/dot/unsupported cases has explicit coverage.
#[test]
fn file_cases() {
    for ext in [
        "mp3", "flac", "m4a", "wav", "ogg", "opus", "aac", "mp4", "webm",
    ] {
        assert!(is_allowed_ext(ext));
        assert!(is_allowed_file(&format!(
            "track.{}",
            ext.to_ascii_uppercase()
        )));
    }
    for (name, allowed, split) in [
        ("track.mp3", true, Some(("track", "mp3"))),
        (" track.extra.mp3 ", true, Some(("track.extra", "mp3"))),
        (".mp3", false, None),
        ("track.", false, None),
        ("track", false, None),
        ("track.txt", false, Some(("track", "txt"))),
        ("", false, None),
    ] {
        assert_eq!(is_allowed_file(name), allowed, "{name:?}");
        assert_eq!(split_name(name), split);
    }
    for ext in ["", "exe", " mp3 "] {
        assert!(!is_allowed_ext(ext));
    }
}

/// Renames need no extension; uploads do, and limits are UTF-8 bytes rather than characters.
#[test]
fn title_cases() {
    for (raw, rename, upload) in [
        (
            " track?name.mp3 ".into(),
            Some("track_name.mp3".into()),
            Some("track_name.mp3".into()),
        ),
        ("Title only".into(), Some("Title only".into()), None),
        ("".into(), None, None),
        ("x".repeat(220), Some("x".repeat(220)), None),
        ("x".repeat(221), None, None),
        ("я".repeat(111), None, None),
        ("track\0.mp3".into(), None, None),
        ("track\nname.mp3".into(), None, None),
    ] {
        assert_eq!(normalize_room_track_title(&raw), rename, "{raw:?}");
        assert_eq!(normalize_track_title(&raw), upload, "{raw:?}");
    }
    assert_eq!(sanitize_name(" \\/:*?\"<>| "), "_________");
}

/// Section names preserve punctuation, collapse all whitespace, and count Unicode characters.
#[test]
fn section_cases() {
    for (raw, expected) in [
        (
            " Boss fight? / phase: 2 ".into(),
            Some("Boss fight? / phase: 2".into()),
        ),
        (" Ambient\n\n  calm ".into(), Some("Ambient calm".into())),
        ("я".repeat(80), Some("я".repeat(80))),
        ("x".repeat(81), None),
        ("  ".into(), None),
        ("".into(), None),
    ] {
        assert_eq!(normalize_section_name(&raw), expected, "{raw:?}");
    }
}
