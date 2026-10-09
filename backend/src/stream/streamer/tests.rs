//! Pure state-transition tables with explicit monotonic times; no sleeps or media processes.

use super::*;
use std::time::Duration;

/// Build an in-memory track for domain tests, without resolving storage.
fn track(id: &str, duration: Option<f64>) -> TrackEntry {
    TrackEntry {
        id: id.into(),
        filename: format!("Track {id}"),
        duration,
        media_path: format!("{id}.mp3"),
        section_id: None,
        sort_order: 0,
    }
}

/// Project queue identity without coupling assertions to serialization details.
fn ids(player: &Streamer) -> Vec<&str> {
    player.queue.iter().map(|entry| entry.id.as_str()).collect()
}

/// Insert/reorder/remove boundaries preserve the queue on rejected operations.
#[test]
fn queue_cases() {
    for (index, expected) in [
        (0, vec!["x", "a", "b"]),
        (1, vec!["a", "x", "b"]),
        (2, vec!["a", "b", "x"]),
        (usize::MAX, vec!["a", "b", "x"]),
    ] {
        let mut player = Streamer::new(false);
        player.enqueue_many(vec![track("a", None), track("b", None)]);
        player.enqueue_at(index, track("x", None));
        assert_eq!(ids(&player), expected);
    }
    for (from, to, valid, expected) in [
        (0, 2, true, vec!["b", "c", "a"]),
        (2, 0, true, vec!["c", "a", "b"]),
        (1, 1, false, vec!["a", "b", "c"]),
        (3, 0, false, vec!["a", "b", "c"]),
        (0, 3, false, vec!["a", "b", "c"]),
    ] {
        let mut player = Streamer::new(false);
        player.enqueue_many(vec![track("a", None), track("b", None), track("c", None)]);
        assert_eq!(player.reorder_queue(from, to), valid, "{from}->{to}");
        assert_eq!(ids(&player), expected);
    }
    for (index, removed) in [
        (0, Some("a")),
        (1, Some("b")),
        (2, None),
        (usize::MAX, None),
    ] {
        let mut player = Streamer::new(false);
        player.enqueue_many(vec![track("a", None), track("b", None)]);
        assert_eq!(
            player.remove_at(index).map(|entry| entry.id),
            removed.map(str::to_owned)
        );
    }
}

/// Empty/paused/playing transitions preserve existing pause, queue and skip semantics.
#[test]
fn transport_cases() {
    for (current, queued, playing) in [
        (false, false, false),
        (false, true, false),
        (true, false, false),
        (true, true, true),
    ] {
        let mut player = Streamer::new(false);
        if current {
            player.play_track(track("a", None), 3.0).unwrap();
        }
        if !playing {
            player.pause();
        }
        if queued {
            player.enqueue(track("b", None));
        }
        player.resume();
        assert_eq!(player.is_playing, current || queued);
        assert_eq!(
            player.current.as_ref().map(|entry| entry.id.as_str()),
            if current {
                Some("a")
            } else if queued {
                Some("b")
            } else {
                None
            }
        );
        player.pause();
        let position = player.position;
        player.pause();
        assert_eq!(player.position, position);
        player.skip();
        assert!(!player.is_playing);
        assert_eq!(
            player.current.as_ref().map(|entry| entry.id.as_str()),
            if current && queued { Some("b") } else { None }
        );
    }
    let mut player = Streamer::new(false);
    player.play_track(track("a", None), 0.0).unwrap();
    player.enqueue(track("b", None));
    player.skip();
    assert!(player.is_playing);
    player.skip();
    assert!(!player.is_playing);
    assert!(player.current.is_none());
}

/// Non-finite seeks/starts are atomic failures; valid seeks retain paused state.
#[test]
fn position_cases() {
    for (position, expected) in [
        (-1.0, Some(0.0)),
        (0.0, Some(0.0)),
        (4.0, Some(4.0)),
        (f64::NAN, None),
        (f64::INFINITY, None),
        (f64::NEG_INFINITY, None),
    ] {
        let mut player = Streamer::new(false);
        player.play_track(track("a", None), 2.0).unwrap();
        player.pause();
        let old = player.position;
        assert_eq!(player.seek(position).is_ok(), expected.is_some());
        assert_eq!(player.position, expected.unwrap_or(old));
        assert!(!player.is_playing);
        assert_eq!(
            player.play_track(track("b", None), position).is_ok(),
            expected.is_some()
        );
        assert_eq!(
            player.current.as_ref().unwrap().id,
            if expected.is_some() { "b" } else { "a" }
        );
    }
    let mut player = Streamer::new(false);
    player.seek(3.0).unwrap();
    assert!(player.current.is_none());
}

/// Natural completion covers no current/duration, invalid duration, edges, pause and repeat.
#[test]
fn completion_cases() {
    let start = Instant::now();
    for (duration, playing, elapsed, repeat, changed) in [
        (None, true, 10, false, false),
        (Some(f64::NAN), true, 10, false, false),
        (Some(-1.0), true, 10, false, false),
        (Some(f64::INFINITY), true, 10, false, false),
        (Some(5.0), false, 10, false, false),
        (Some(5.0), true, 4, false, false),
        (Some(5.0), true, 5, false, true),
        (Some(5.0), true, 6, true, true),
        (Some(0.0), true, 0, false, true),
    ] {
        let mut player = Streamer::new(repeat);
        player.current = Some(track("a", duration));
        player.is_playing = playing;
        player.started_at = playing.then_some(start);
        player.enqueue(track("b", None));
        assert_eq!(
            player.advance_at(start + Duration::from_secs(elapsed)),
            changed
        );
        assert_eq!(
            player.current.as_ref().map(|entry| entry.id.as_str()),
            Some(if changed && !repeat { "b" } else { "a" })
        );
        if changed {
            assert_eq!(
                player.position_at(start + Duration::from_secs(elapsed)),
                0.0
            );
        }
    }
    assert!(!Streamer::new(false).advance_at(start));
}

/// Rename/removal handle duplicate queued occurrences and current identity correctly.
#[test]
fn identity_cases() {
    for id in ["a", "missing"] {
        let mut player = Streamer::new(false);
        player.play_track(track("a", None), 0.0).unwrap();
        player.enqueue_many(vec![track("a", None), track("b", None), track("a", None)]);
        assert_eq!(player.is_current_id(id), id == "a");
        assert_eq!(player.rename_track_by_id(id, "renamed"), id == "a");
        assert_eq!(
            player.remove_queued_by_id(id),
            if id == "a" { 2 } else { 0 }
        );
    }
    let mut player = Streamer::new(false);
    player.enqueue(track("c", None));
    player.prepend_many(vec![track("a", None), track("b", None)]);
    assert_eq!(ids(&player), vec!["a", "b", "c"]);
    player.prepend_many(Vec::new());
    assert_eq!(ids(&player), vec!["a", "b", "c"]);
    player.set_repeat_one(true);
    assert!(player.snapshot().repeat_one);
}
