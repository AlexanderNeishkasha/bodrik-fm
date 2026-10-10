//! Shared state-socket resource ownership and bounded transport policy.

use super::runtime::{self, RoomRuntime};
use axum::extract::ws::{Message, WebSocket};
use std::sync::{Arc, atomic::Ordering};
use tokio::time::{self, Duration};

/// State sockets accept only small client/control messages, never playback commands.
pub(crate) const INPUT_LIMIT: usize = 1024;

/// Counted state-socket ownership, released on return, error or task cancellation.
pub(crate) struct ListenerLease {
    /// Room whose listener count this lease owns.
    runtime: Arc<RoomRuntime>,
}

impl Drop for ListenerLease {
    /// Release exactly one listener and wake remaining state observers.
    fn drop(&mut self) {
        self.runtime
            .active_listeners
            .fetch_sub(1, Ordering::Relaxed);
        runtime::notify(&self.runtime);
    }
}

/// Acquire one listener lease for the complete lifetime of a socket task.
pub(crate) fn listen(runtime: Arc<RoomRuntime>) -> ListenerLease {
    runtime.active_listeners.fetch_add(1, Ordering::Relaxed);
    runtime::notify(&runtime);
    ListenerLease { runtime }
}

/// Treat EOF, transport errors and close frames as terminal rather than retrying a broken socket.
pub(crate) fn terminal(message: &Option<Result<Message, axum::Error>>) -> bool {
    matches!(message, None | Some(Err(_)) | Some(Ok(Message::Close(_))))
}

/// Bound slow sends; after a timeout callers must drop the socket, not reuse a partial send.
pub(crate) async fn send(socket: &mut WebSocket, text: String) -> bool {
    matches!(
        time::timeout(
            Duration::from_secs(10),
            socket.send(Message::Text(text.into()))
        )
        .await,
        Ok(Ok(()))
    )
}

/// Pure frame policy tables, without network sockets.
#[cfg(test)]
mod tests {
    use super::*;

    /// EOF/error/close are terminal; harmless small data/control frames are ignored.
    #[test]
    fn terminal_cases() {
        let cases = [
            (None, true),
            (Some(Ok(Message::Close(None))), true),
            (
                Some(Err(axum::Error::new(std::io::Error::from(
                    std::io::ErrorKind::BrokenPipe,
                )))),
                true,
            ),
            (Some(Ok(Message::Text("ignored".into()))), false),
            (Some(Ok(Message::Ping(Vec::new().into()))), false),
        ];
        for (message, expected) in cases {
            assert_eq!(terminal(&message), expected);
        }
    }
}
