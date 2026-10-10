//! In-process runtime/notification units; no AppState, SQLite or socket fixtures.

use super::*;
use crate::{api::state_socket::listen, stream::TrackEntry};

/// Construct only runtime-owned in-memory state and its timer.
fn runtime() -> Arc<RoomRuntime> {
    create_runtime(
        1,
        "room".into(),
        room_settings::RoomSettings {
            theme: "mono".into(),
            repeat_one: false,
            music_output: "studio".into(),
            conference_music_volume: 1.0,
        },
        false,
        false,
        Arc::new(PlaybackObserver::new(4)),
    )
}

/// Snapshot state/revision remain paired through concurrent synchronous commits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paired_snapshots() {
    let runtime = runtime();
    let producer = runtime.clone();
    let task = tokio::spawn(async move {
        for revision in 1..=1000 {
            {
                let mut player = producer.streamer.lock().await;
                player
                    .play_track(
                        TrackEntry {
                            id: revision.to_string(),
                            filename: "track".into(),
                            duration: None,
                            media_path: "track.mp3".into(),
                            section_id: None,
                            sort_order: 0,
                        },
                        0.0,
                    )
                    .unwrap();
                bump_sync(&producer);
            }
            tokio::task::yield_now().await;
        }
    });
    for _ in 0..1000 {
        let snapshot = playback_snapshot(&runtime).await;
        if let Some(track) = snapshot.player.current {
            assert_eq!(track.id, snapshot.revision.to_string());
        }
    }
    task.await.unwrap();
    assert_eq!(playback_snapshot(&runtime).await.revision, 1000);
}

/// Listener leases release accounting, including terminal rooms with live leases.
#[tokio::test]
async fn listener_and_close_cases() {
    for listeners in [0, 1, 3] {
        let runtime = runtime();
        let leases = (0..listeners)
            .map(|_| listen(runtime.clone()))
            .collect::<Vec<_>>();
        assert_eq!(runtime.active_listeners.load(Ordering::Relaxed), listeners);
        close(&runtime);
        assert!(is_closed(&runtime));
        drop(leases);
        assert_eq!(runtime.active_listeners.load(Ordering::Relaxed), 0);
    }
}

/// Exhausted token arithmetic is explicit and does not panic in debug builds.
#[tokio::test]
async fn token_boundary_cases() {
    for (before, after) in [(0, 1), (usize::MAX - 1, usize::MAX), (usize::MAX, 0)] {
        let runtime = runtime();
        runtime.sync_token.store(before, Ordering::Relaxed);
        let _player = runtime.streamer.lock().await;
        bump_sync(&runtime);
        assert_eq!(runtime.sync_token.load(Ordering::Relaxed), after);
    }
}
