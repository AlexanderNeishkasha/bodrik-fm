//! Viewer-owned pause/resume must not control another participant's receiver.

use super::{Binding, Engine, Operation};
use crate::media::protocol::Consumer as ConsumerRef;

/// Check ownership for the receiver created by the real native lifecycle test.
pub(super) async fn check(
    engine: &Engine,
    receiver: &Binding,
    sender: &Binding,
    consumed: &serde_json::Value,
) {
    for (name, owner, action, permitted) in [
        (
            "owner pauses receiver",
            receiver,
            Operation::PauseConsumer(ConsumerRef {
                consumer_id: consumed["id"].as_str().expect("consumer").into(),
            }),
            true,
        ),
        (
            "foreign peer cannot pause receiver",
            sender,
            Operation::PauseConsumer(ConsumerRef {
                consumer_id: consumed["id"].as_str().expect("consumer").into(),
            }),
            false,
        ),
        (
            "owner resumes same receiver",
            receiver,
            Operation::ResumeConsumer(ConsumerRef {
                consumer_id: consumed["id"].as_str().expect("consumer").into(),
            }),
            true,
        ),
    ] {
        assert_eq!(
            engine.operation(owner, &action).await.is_ok(),
            permitted,
            "{name}"
        );
    }
}
