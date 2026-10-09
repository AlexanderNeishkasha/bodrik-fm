//! Versioned strict replacement request vocabulary; actor/native bindings are server-derived.
use super::{chat, diagnostics, file, moderation, participant};
use crate::{media::protocol::Operation, signaling::SessionStamp};
use serde::Deserialize;
use serde_json::Value;
use std::{fmt, ops::Index};
use uuid::Uuid;

/// Maximum public control/media frame, separate from the smaller authentication budget.
pub(super) const FRAME_LIMIT: usize = 262_144;

/// Ordered socket output; binary queue accounting is released when selected for sending.
pub(super) enum Outbound {
    /// One bounded JSON control/result/event frame.
    Json(Value),
    /// A last frame for a session the server is ending (eject/ban): sent without the
    /// entitlement renewal that would otherwise drop it, then the socket closes.
    Final(Value),
    /// One exact file frame with recipient queue ownership metadata.
    Binary {
        /// Transfer whose queue slot is held.
        transfer_id: Uuid,
        /// Exact recipient whose queue slot is held.
        recipient: SessionStamp,
        /// Immutable binary frame bytes.
        bytes: Vec<u8>,
    },
}

impl From<Value> for Outbound {
    /// Wrap a JSON value for ordered socket delivery.
    fn from(value: Value) -> Self {
        Self::Json(value)
    }
}

impl fmt::Display for Outbound {
    /// Render JSON fixture output; binary bytes are intentionally not formatted.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(value) | Self::Final(value) => value.fmt(formatter),
            Self::Binary { .. } => formatter.write_str("<binary>"),
        }
    }
}

impl Index<&str> for Outbound {
    type Output = Value;

    /// Preserve concise JSON fixture assertions for control events.
    ///
    /// # Panics
    /// Panics when a fixture indexes a binary frame as JSON.
    fn index(&self, key: &str) -> &Self::Output {
        match self {
            Self::Json(value) | Self::Final(value) => &value[key],
            Self::Binary { .. } => panic!("binary frame indexed as JSON"),
        }
    }
}

/// One sequenced connection command; identifiers are scoped to the exact current socket stamp.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    /// Exact command frame type, checked before dispatch.
    pub r#type: String,
    /// Exact replacement protocol version.
    pub version: u8,
    /// Monotonic positive connection-local request identity; no wrapping or identity reuse.
    pub id: u64,
    /// Exact Rust-issued ownership fence; never selects a private native binding.
    pub stamp: SessionStamp,
    /// Finite typed participant command.
    pub action: Action,
}

/// Public domain commands, not arbitrary private runtime command JSON.
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Action {
    /// Obtain temporary ICE credentials for this authorized, admitted session.
    IceConfig {},
    /// Read authoritative same-room participants.
    Snapshot {},
    /// Discover current same-room media producers.
    Producers {},
    /// Execute supported participant media parameters under current runtime policy.
    Media {
        /// Typed native parameters only; lifecycle operations remain forbidden.
        operation: Operation,
    },
    /// Submit one public/private ephemeral chat message.
    Chat {
        /// Public room or exact-session private destination.
        target: chat::Target,
        /// Browser conversation identifier used by retained reaction consumers.
        message_id: String,
        /// Plain text or retained image-URL text; never trusted server-side HTML.
        text: String,
        /// Optional staged persistent attachment; private conversations reject this field.
        attachment_id: Option<String>,
    },
    /// Read one bounded durable public history page.
    ChatHistory {
        /// Exclusive message cursor, absent for newest page.
        before: Option<String>,
    },
    /// Delete one durable public message under sender/presenter authority.
    ChatDelete {
        /// Canonical persisted message sequence.
        message_id: String,
    },
    /// Relay one ephemeral reaction to admitted room members.
    ChatReaction {
        /// Existing browser conversation identifier; no durable message registry is implied.
        message_id: String,
        /// Bounded reaction glyph/text.
        emoji: String,
        /// Add/remove mutation.
        action: chat::ReactionAction,
    },
    /// Change one allowlisted participant profile field.
    ParticipantProfile {
        /// Name/avatar update only; authority fields are not expressible.
        change: participant::ProfileChange,
    },
    /// Read the authoritative admitted human count and optionally notify room consumers.
    ParticipantCount {
        /// Emit a revisioned count event in addition to the command result.
        broadcast: bool,
    },
    /// Apply presenter-owned Follow Me view policy.
    FollowMe {
        /// Typed toggle/pin/focus/clear action.
        action: participant::FollowAction,
    },
    /// Apply one presenter-owned room gate or exact pending password command.
    RoomControl {
        /// Typed room control with no browser-selected actor identity.
        action: moderation::RoomAction,
    },
    /// Apply one allowlisted moderator policy mutation.
    Moderator {
        /// Typed one-field or complete moderator mutation.
        change: crate::room::ModeratorChange,
    },
    /// Transfer presenter authority to one exact current participant.
    SetRole {
        /// Exact Rust-issued participant target.
        target: SessionStamp,
        /// Requested presenter state.
        presenter: bool,
    },
    /// Approve or reject exact current lobby participants.
    Lobby {
        /// Exact Rust-issued pending targets.
        targets: Vec<SessionStamp>,
        /// True approves; false rejects and retires the targets.
        accepted: bool,
    },
    /// Notify peers that the actor joined without a camera producer.
    VideoOff {},
    /// Relay or enforce one presenter-owned participant action.
    PeerModeration {
        /// Exact Rust-issued current participant targets.
        targets: Vec<SessionStamp>,
        /// Finite moderation action.
        action: moderation::PeerAction,
        /// Optional bounded human-readable reason.
        message: Option<String>,
    },
    /// Allocate one bounded Rust-owned file transfer.
    FileOffer {
        /// Strict versioned transfer metadata.
        offer: file::Offer,
    },
    /// Cancel an owned transfer or only the actor's recipient delivery.
    FileCancel {
        /// Strict versioned transfer identity.
        cancel: file::Cancel,
    },
    /// Submit bounded credential-free operational diagnostics for this exact session.
    Diagnostics {
        /// One retained-schema diagnostics batch.
        events: Vec<diagnostics::Event>,
    },
    /// Release this exact session and native peer promptly, bypassing disconnect grace.
    Leave {},
}

#[cfg(test)]
mod tests {
    use super::Action;

    /// Browser camelCase fields deserialize at the strict action boundary.
    #[test]
    fn browser_action_fields_use_camel_case() {
        let action = serde_json::from_str::<Action>(
            r#"{"type":"chat","target":{"type":"public"},"messageId":"message-1","text":"hello"}"#,
        );
        assert!(matches!(action, Ok(Action::Chat { message_id, .. }) if message_id == "message-1"));
    }

    /// Legacy snake_case fields remain rejected instead of creating two accepted wire forms.
    #[test]
    fn snake_case_action_fields_are_rejected() {
        let action = serde_json::from_str::<Action>(
            r#"{"type":"chat","target":{"type":"public"},"message_id":"message-1","text":"hello"}"#,
        );
        assert!(action.is_err());
    }
}

/// Public JSON cannot construct internal actors, admission phases or native lifecycle commands.
#[cfg(test)]
mod boundary_tests {
    use super::*;
    use serde_json::json;

    /// Removed recording commands fail at ingress instead of relaying events or changing policy.
    #[test]
    fn recording_commands_are_rejected() {
        for (name, value) in [
            ("start", json!({"type":"recordingAction","action":"start"})),
            ("stop", json!({"type":"recordingAction","action":"stop"})),
            ("pause", json!({"type":"recordingAction","action":"pause"})),
            (
                "resume",
                json!({"type":"recordingAction","action":"resume"}),
            ),
            (
                "host-only policy",
                json!({"type":"roomControl","action":{"type":"recording","status":true}}),
            ),
        ] {
            assert!(serde_json::from_value::<Action>(value).is_err(), "{name}");
        }
    }

    /// Reject forged gateway-era fields at the current browser ingress.
    #[test]
    fn internal_command_injection_cases() {
        for (name, value) in [
            ("snapshot", json!({"type":"snapshot"})),
            ("producers", json!({"type":"producers"})),
            ("video off", json!({"type":"videoOff"})),
            ("leave", json!({"type":"leave"})),
            (
                "producers extra",
                json!({"type":"producers","peerId":"host"}),
            ),
            (
                "video off extra",
                json!({"type":"videoOff","peerId":"host"}),
            ),
            ("leave extra", json!({"type":"leave","peerId":"host"})),
            (
                "forged presenter",
                json!({"type":"snapshot","presenter":true}),
            ),
            (
                "forged username",
                json!({"type":"snapshot","username":"host"}),
            ),
            ("forged actor", json!({"type":"snapshot","peerId":"host"})),
            ("legacy phase", json!({"type":"phase","phase":"admitted"})),
            ("legacy begin", json!({"type":"begin","presenter":true})),
            (
                "native binding",
                json!({"type":"media","operation":{"operation":"capabilities","payload":{}},"binding":{"peerId":"host"}}),
            ),
        ] {
            assert_eq!(
                serde_json::from_value::<Action>(value).is_ok(),
                ["snapshot", "producers", "video off", "leave"].contains(&name),
                "{name}"
            );
        }
    }
}
