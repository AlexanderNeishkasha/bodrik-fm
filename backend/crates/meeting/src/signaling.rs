//! Replacement public signaling contracts, deliberately separate from private native RPC.
//! Schema validity is not authentication or admission; only the isolated replacement router consumes it.

#[cfg(test)]
#[path = "signaling_tests.rs"]
mod tests;

use crate::media::protocol::{JS_SAFE_INTEGER, identifier};
use serde::{Deserialize, Serialize};

/// First replacement public signaling version; not the legacy Socket.IO wire version.
pub const VERSION: u8 = 1;
/// Bound the initial authentication frame before deserializing opaque credentials.
pub const HELLO_LIMIT: usize = 4096;

/// First frame on a replacement WebSocket; never put credentials in a URL/subprotocol.
/// Deliberately lacks Debug so opaque bearer material is not accidentally logged.
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Hello {
    /// Redeem a short-lived single-use ticket issued through the private player authority.
    /// Cryptographic validation, audience/generation/role and replay checks are separate.
    Admit {
        /// Exact replacement protocol version.
        version: u8,
        /// Opaque credential-free admission ticket, never a legacy encrypted host password.
        ticket: String,
        /// Independent 256-bit browser-generated ownership proof, retained only in private runtime memory.
        /// The rotated recovery capability alone is insufficient for session ownership.
        #[serde(rename = "ownerProof")]
        owner_proof: String,
    },
    /// Recover an existing Rust-owned session with its distinct, rotatable capability.
    /// A session ID or admission epoch alone is never recovery authorization.
    Resume {
        /// Exact replacement protocol version.
        version: u8,
        /// Rust-issued session identifier; never a Socket.IO ID or browser-selected peer ID.
        #[serde(rename = "sessionId")]
        session_id: String,
        /// Opaque recovery capability, not an initial ticket or legacy per-tab secret.
        #[serde(rename = "recoveryToken")]
        recovery_token: String,
        /// Independent original ownership proof; never issued in the welcome response or shared snapshots.
        #[serde(rename = "ownerProof")]
        owner_proof: String,
    },
}

/// Sanitized handshake-schema errors without echoing credential material.
#[derive(Debug, PartialEq, Eq)]
pub enum HelloError {
    /// Unsupported public signaling version.
    Version,
    /// Too large, malformed, ambiguous or unexpected fields.
    Malformed,
}

impl Hello {
    /// Parse a bounded authentication frame and reject legacy/private identity claims.
    ///
    /// # Errors
    /// Rejects oversize JSON, unknown fields/types, invalid opaque credentials or versions.
    /// A successful parse still requires server-side authentication and fresh entitlement.
    pub fn parse(bytes: &[u8]) -> Result<Self, HelloError> {
        if bytes.len() > HELLO_LIMIT {
            return Err(HelloError::Malformed);
        }
        let hello: Self = serde_json::from_slice(bytes).map_err(|_| HelloError::Malformed)?;
        let version = match &hello {
            Self::Admit {
                version,
                ticket,
                owner_proof,
            } => {
                if !opaque(ticket) || !ownership(owner_proof) {
                    return Err(HelloError::Malformed);
                }
                *version
            }
            Self::Resume {
                version,
                session_id,
                recovery_token,
                owner_proof,
            } => {
                if !identifier(session_id) || !opaque(recovery_token) || !ownership(owner_proof) {
                    return Err(HelloError::Malformed);
                }
                *version
            }
        };
        if version != VERSION {
            return Err(HelloError::Version);
        }
        Ok(hello)
    }
}

/// Require the canonical representation of a browser-generated independent 256-bit proof.
fn ownership(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Bounded URL-safe opaque material; parsing does not interpret or trust token contents.
fn opaque(value: &str) -> bool {
    (32..=2048).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

/// Server-owned session identity carried by subsequent responses/events, not client authority.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStamp {
    /// Logical Rust room incarnation, replaced on retirement/restart.
    pub room_instance_id: String,
    /// Rust-issued session identifier, stable only for this admitted session.
    pub session_id: String,
    /// Current admission/recovery incarnation; old requests cannot mutate a replacement.
    pub admission_epoch: u64,
}

impl SessionStamp {
    /// Check the common browser-safe identity boundaries without granting membership.
    pub fn is_valid(&self) -> bool {
        identifier(&self.room_instance_id)
            && identifier(&self.session_id)
            && (1..=JS_SAFE_INTEGER).contains(&self.admission_epoch)
    }
}
