//! Native-owned source readback rejects absent, ambiguous and malformed resume metadata.

use super::{resume_policy, source_capability};
use serde_json::json;

/// Resume permission comes from the immutable owned source, not requested browser mediaType.
#[test]
fn source_readback_cases() {
    for (name, inventory, accepted) in [
        (
            "owned microphone",
            json!({"producerSources":[{"id":"producer","kind":"audio","mediaType":"audioType"}]}),
            true,
        ),
        (
            "owned camera",
            json!({"producerSources":[{"id":"producer","kind":"video","mediaType":"videoType"}]}),
            true,
        ),
        (
            "owned screen",
            json!({"producerSources":[{"id":"producer","kind":"audio","mediaType":"screenType"}]}),
            true,
        ),
        (
            "foreign producer",
            json!({"producerSources":[{"id":"other","kind":"audio","mediaType":"audioType"}]}),
            false,
        ),
        (
            "missing descriptors",
            json!({"producers":["producer"]}),
            false,
        ),
        (
            "duplicate",
            json!({"producerSources":[{"id":"producer","kind":"audio","mediaType":"audioType"},{"id":"producer","kind":"video","mediaType":"videoType"}]}),
            false,
        ),
        (
            "invalid kind",
            json!({"producerSources":[{"id":"producer","kind":"other","mediaType":"audioType"}]}),
            false,
        ),
        (
            "mismatched category",
            json!({"producerSources":[{"id":"producer","kind":"video","mediaType":"audioType"}]}),
            false,
        ),
    ] {
        let result = resume_policy(&inventory, "producer")
            .and_then(|operation| source_capability(&operation));
        assert_eq!(result.is_ok(), accepted, "{name}");
    }
}
