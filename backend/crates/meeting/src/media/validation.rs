//! Bound untrusted media parameters before cloning them into owned native work.
use super::protocol::{Operation, identifier};
use serde_json::Value;

/// Allocation budget for JSON values already bounded by the public WebSocket frame limit.
const PAYLOAD_BUDGET: usize = 256 * 1024;
/// Nested RTP/DTLS parameters are shallow; excessive nesting is rejected before native parsing.
const MAX_DEPTH: usize = 64;

impl Operation {
    /// Check handles and bound parameter allocation independently of transport serialization.
    pub(crate) fn is_bounded(&self) -> bool {
        let (handles, payload): (Vec<&str>, Option<&Value>) = match self {
            Self::ConnectTransport {
                transport_id,
                dtls_parameters,
            } => (vec![transport_id], Some(dtls_parameters)),
            Self::Produce {
                transport_id,
                rtp_parameters,
                ..
            } => (vec![transport_id], Some(rtp_parameters)),
            Self::Consume {
                transport_id,
                producer_id,
                rtp_capabilities,
                ..
            } => (vec![transport_id, producer_id], Some(rtp_capabilities)),
            Self::RestartIce(value) | Self::CloseTransport(value) => {
                (vec![&value.transport_id], None)
            }
            Self::CloseProducer(value)
            | Self::PauseProducer(value)
            | Self::ResumeProducer(value) => (vec![&value.producer_id], None),
            Self::PauseConsumer(value) | Self::ResumeConsumer(value) => {
                (vec![&value.consumer_id], None)
            }
            _ => (Vec::new(), None),
        };
        handles.into_iter().all(identifier)
            && payload.is_none_or(|value| {
                let mut budget = PAYLOAD_BUDGET;
                bounded(value, 0, &mut budget)
            })
    }
}

/// Charge structural nodes, keys and strings without encoding or allocating an intermediate body.
fn bounded(value: &Value, depth: usize, remaining: &mut usize) -> bool {
    if depth > MAX_DEPTH || *remaining < 8 {
        return false;
    }
    *remaining -= 8;
    match value {
        Value::String(text) => charge(text.len(), remaining),
        Value::Array(values) => values
            .iter()
            .all(|value| bounded(value, depth + 1, remaining)),
        Value::Object(values) => values.iter().all(|(key, value)| {
            charge(key.len(), remaining) && bounded(value, depth + 1, remaining)
        }),
        _ => true,
    }
}

/// Deduct one bounded byte charge without underflow.
fn charge(bytes: usize, remaining: &mut usize) -> bool {
    match remaining.checked_sub(bytes) {
        Some(next) => {
            *remaining = next;
            true
        }
        None => false,
    }
}

/// Named payload/handle boundary cases protect direct callers as well as browser ingress.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Shallow valid RTP/DTLS, oversized strings/collections and malformed handles are distinct cases.
    #[test]
    fn parameter_bounds() {
        let mut nested = json!({});
        for _ in 0..=MAX_DEPTH {
            nested = json!([nested]);
        }
        for (name, handle, payload, accepted) in [
            (
                "valid",
                "transport",
                json!({"fingerprints":[{"algorithm":"sha-256","value":"synthetic"}]}),
                true,
            ),
            ("foreign path", "../transport", json!({}), false),
            ("empty handle", "", json!({}), false),
            ("oversized handle", &"x".repeat(161), json!({}), false),
            (
                "oversized string",
                "transport",
                json!({"value":"x".repeat(PAYLOAD_BUDGET)}),
                false,
            ),
            (
                "oversized key",
                "transport",
                json!({"x".repeat(PAYLOAD_BUDGET):null}),
                false,
            ),
            (
                "wide collection",
                "transport",
                json!(vec![0; PAYLOAD_BUDGET / 8]),
                false,
            ),
            ("deep collection", "transport", nested, false),
        ] {
            assert_eq!(
                Operation::ConnectTransport {
                    transport_id: handle.into(),
                    dtls_parameters: payload
                }
                .is_bounded(),
                accepted,
                "{name}"
            );
        }
    }
}
