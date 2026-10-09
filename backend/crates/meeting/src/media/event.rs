//! Ordered observations emitted by the in-process native worker.
use serde::Deserialize;
use serde_json::Value;

/// A private boot-scoped observation; payloads are not authorization decisions.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    /// Media adapter process incarnation.
    pub boot_id: String,
    /// Contiguous process-local observation identity, not a durable log offset.
    pub sequence: u64,
    /// Known lifecycle/speaker observation, or initial ready baseline.
    #[serde(rename = "type")]
    pub kind: String,
    /// Bounded provider observation; caller normalizes it before public delivery.
    pub payload: Value,
}
