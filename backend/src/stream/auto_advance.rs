//! Timer supervision for synchronous playback transitions.

use crate::stream::Streamer;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::{
    sync::Mutex,
    task::JoinHandle,
    time::{self, Duration},
};

/// Start automatic completion checks and return the task to its owning room runtime.
/// State, revision and publication are committed under the same playback lock.
pub fn start_auto_advance(
    streamer: Arc<Mutex<Streamer>>,
    notifier: tokio::sync::broadcast::Sender<()>,
    sync_token: Arc<AtomicUsize>,
    on_advance: Arc<dyn Fn() + Send + Sync>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = time::interval(Duration::from_secs(1));
        ticker.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let mut streamer = streamer.lock().await;
            if streamer.advance_if_finished() {
                sync_token.fetch_add(1, Ordering::Relaxed);
                on_advance();
                let _ = notifier.send(());
            }
        }
    })
}
