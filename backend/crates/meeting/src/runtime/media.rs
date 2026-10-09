//! Boot-fenced participant media execution; native I/O never holds the membership registry lock.

#[cfg(test)]
#[path = "media_resume_tests.rs"]
mod resume_tests;
#[cfg(test)]
#[path = "media_tests.rs"]
mod tests;

use super::{
    Runtime,
    commands::{Capability, Command},
};
use crate::media::{
    Executor,
    protocol::{self, Binding, MediaKind, MediaType, Operation},
};
use serde_json::Value;

impl Runtime {
    /// Check current membership and source policy immediately around native I/O.
    ///
    /// # Errors
    /// Rejects stale/revoked bindings and invalid or unsupported participant actions.
    fn media_authorized(
        &self,
        binding: &Binding,
        operation: &Operation,
    ) -> Result<(), &'static str> {
        if !binding.is_valid() {
            return Err("runtime denied");
        }
        let capability = source_capability(operation)?;
        let command = match capability {
            Some(capability) => Command::Authorize {
                room_id: binding.room_id.clone(),
                room_instance_id: binding.room_instance_id.clone(),
                peer_id: binding.peer_id.clone(),
                epoch: binding.admission_epoch,
                capability,
            },
            None => Command::Members {
                room_id: binding.room_id.clone(),
                room_instance_id: binding.room_instance_id.clone(),
                peer_id: binding.peer_id.clone(),
                epoch: binding.admission_epoch,
                pending: false,
            },
        };
        let reply = self
            .registry
            .lock()
            .map_err(|_| "runtime unavailable")?
            .apply(command, None, std::time::Instant::now())?;
        if capability.is_some() && reply.allowed != Some(true) {
            return Err("runtime denied");
        }
        Ok(())
    }

    /// Execute a participant command with the exact native owner and monotonic deadline and fresh Rust policy.
    ///
    /// # Errors
    /// Sanitized native failure can have an unknown mutation outcome; callers must reconcile cancelled or uncertain allocations.
    pub(crate) async fn execute_media(
        &self,
        request: protocol::Command,
        media: &impl Executor,
    ) -> Result<Value, &'static str> {
        if self.boot.is_none() || !protocol::identifier(&request.boot_id) {
            return Err("runtime denied");
        }
        let policy_operation = if let Operation::ResumeProducer(producer) = &request.operation {
            if !protocol::identifier(&producer.producer_id) {
                return Err("runtime denied");
            }
            let inventory_operation = Operation::Inventory(protocol::Empty::default());
            self.media_authorized(&request.binding, &inventory_operation)?;
            let inventory = media
                .execute(&protocol::Command {
                    boot_id: request.boot_id.clone(),
                    deadline: request.deadline,
                    binding: request.binding.clone(),
                    operation: inventory_operation,
                })
                .await
                .map_err(|_| "media inventory unavailable")?;
            resume_policy(&inventory, &producer.producer_id)?
        } else {
            request.operation.clone()
        };
        self.media_authorized(&request.binding, &policy_operation)?;
        let command = request;
        let value = match media.execute(&command).await {
            Ok(value) => value,
            Err(crate::media::MediaError::Rejected(protocol::ErrorCode::ProducerNotFound)) => {
                self.media_authorized(&command.binding, &policy_operation)?;
                return Ok(serde_json::json!({ "nativeError": { "code": "producer_not_found" } }));
            }
            Err(error) => {
                tracing::warn!(category = ?error, "participant native command unavailable");
                return Err("media outcome unavailable");
            }
        };
        self.media_authorized(&command.binding, &policy_operation)?;
        Ok(value)
    }
}

/// Recover the immutable native producer category for resume authorization; never trust browser source labels.
///
/// # Errors
/// Rejects missing, ambiguous or malformed owned producer descriptors.
fn resume_policy(inventory: &Value, producer_id: &str) -> Result<Operation, &'static str> {
    let sources = inventory
        .get("producerSources")
        .and_then(Value::as_array)
        .ok_or("media inventory unavailable")?;
    let mut matches = sources
        .iter()
        .filter(|source| source.get("id").and_then(Value::as_str) == Some(producer_id));
    let source = matches.next().ok_or("runtime denied")?;
    if matches.next().is_some() {
        return Err("media inventory unavailable");
    }
    let kind = serde_json::from_value(
        source
            .get("kind")
            .cloned()
            .ok_or("media inventory unavailable")?,
    )
    .map_err(|_| "media inventory unavailable")?;
    let media_type = serde_json::from_value(
        source
            .get("mediaType")
            .cloned()
            .ok_or("media inventory unavailable")?,
    )
    .map_err(|_| "media inventory unavailable")?;
    Ok(Operation::Produce {
        transport_id: "resume-policy".into(),
        kind,
        media_type,
        rtp_parameters: serde_json::json!({}),
    })
}

/// Validate participant operations and derive the activation policy, never trusting a native role flag.
///
/// # Errors
/// Lifecycle and source-unknown resume operations remain unavailable until their distinct authority path is wired.
fn source_capability(operation: &Operation) -> Result<Option<Capability>, &'static str> {
    match operation {
        Operation::Produce {
            transport_id,
            kind,
            media_type,
            rtp_parameters,
        } => {
            if !protocol::identifier(transport_id) || !rtp_parameters.is_object() {
                return Err("runtime denied");
            }
            Ok(Some(match (kind, media_type) {
                (MediaKind::Audio, MediaType::Audio) => Capability::Audio,
                (MediaKind::Video, MediaType::Video) => Capability::Video,
                (_, MediaType::Screen) => Capability::Screen,
                _ => return Err("runtime denied"),
            }))
        }
        Operation::ConnectTransport {
            transport_id,
            dtls_parameters,
        } => {
            if !protocol::identifier(transport_id) || !dtls_parameters.is_object() {
                return Err("runtime denied");
            }
            Ok(None)
        }
        Operation::Consume {
            transport_id,
            producer_id,
            rtp_capabilities,
            ..
        } => {
            if !protocol::identifier(transport_id)
                || !protocol::identifier(producer_id)
                || !rtp_capabilities.is_object()
            {
                return Err("runtime denied");
            }
            Ok(None)
        }
        Operation::RestartIce(value) | Operation::CloseTransport(value) => {
            if !protocol::identifier(&value.transport_id) {
                return Err("runtime denied");
            }
            Ok(None)
        }
        Operation::CloseProducer(value) | Operation::PauseProducer(value) => {
            if !protocol::identifier(&value.producer_id) {
                return Err("runtime denied");
            }
            Ok(None)
        }
        Operation::PauseConsumer(value) | Operation::ResumeConsumer(value) => {
            if !protocol::identifier(&value.consumer_id) {
                return Err("runtime denied");
            }
            Ok(None)
        }
        Operation::Capabilities(_)
        | Operation::Inventory(_)
        | Operation::Sources(_)
        | Operation::CreateTransport(_) => Ok(None),
        Operation::CreateRoom(_)
        | Operation::CreatePeer(_)
        | Operation::CreateMusic { .. }
        | Operation::CloseMusic(_)
        | Operation::ResumeProducer(_)
        | Operation::ClosePeer(_)
        | Operation::CloseRoom(_) => Err("runtime denied"),
    }
}
