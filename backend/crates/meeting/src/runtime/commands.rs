//! Internal domain transitions; no transport can deserialize an authenticated actor or grant.

use crate::room::{Moderator, ModeratorChange};
/// Internal domain commands constructed only after public request authorization.
pub(crate) enum Command {
    /// Reserve a room before any native allocation; identity proof is independently verified in Rust.
    Reserve {
        /// Exact private conference identifier.
        room_id: String,
    },
    /// Commit only the current unexpired reservation to one native room incarnation.
    Commit {
        /// Reserved conference identifier.
        room_id: String,
        /// Rust-issued allocation fence.
        epoch: u64,
        /// Native resource-owner incarnation.
        room_instance_id: String,
        /// Immutable configured presenter identities, matched only against independently verified usernames.
        presenter_names: Vec<String>,
        /// Immutable initial moderation configuration, thereafter owned exclusively by Rust.
        moderator: Moderator,
        /// Immutable global lobby startup option.
        global_lobby: bool,
    },
    /// Release only the owned failed allocation, including an unknown commit outcome.
    Abort {
        /// Reserved conference identifier.
        room_id: String,
        /// Exact reservation fence; cannot delete a replacement owner.
        epoch: u64,
    },
    /// Renew an existing room lease only after a fresh private-player decision.
    Renew {
        /// Conference identifier.
        room_id: String,
        /// Native incarnation that must still match.
        room_instance_id: String,
    },
    /// Verify identity and create a pending membership without inheriting an old admission.
    Begin {
        /// Conference identifier.
        room_id: String,
        /// Native room incarnation.
        room_instance_id: String,
        /// Server-issued participant identity, never browser-selected.
        peer_id: String,
        /// Independently verified token role, populated only after Rust admission; never deserialized.
        presenter: bool,
        /// Independently authenticated identity; never accepted from browser JSON.
        username: String,
    },
    /// Read current Rust role authority for the exact membership, including pending join presentation.
    Role {
        /// Private conference identifier.
        room_id: String,
        /// Current native incarnation.
        room_instance_id: String,
        /// Server-resolved participant identity.
        peer_id: String,
        /// Rust-issued participant fence.
        epoch: u64,
    },
    /// Transfer a role only from an admitted current presenter to an admitted current target.
    SetRole {
        /// Private conference identifier.
        room_id: String,
        /// Current native incarnation.
        room_instance_id: String,
        /// Server-resolved actor, never the browser's claimed sender.
        peer_id: String,
        /// Actor's Rust-issued fence.
        epoch: u64,
        /// Server-resolved target identity.
        target_id: String,
        /// Target fence captured before the command; replacement targets cannot inherit a late grant.
        target_epoch: u64,
        /// Requested presenter state.
        presenter: bool,
    },
    /// Decide media/chat permission using current Rust membership, roles and moderator restrictions.
    Authorize {
        /// Exact private room identifier.
        room_id: String,
        /// Native resource incarnation.
        room_instance_id: String,
        /// Server-resolved actor.
        peer_id: String,
        /// Current admission fence.
        epoch: u64,
        /// Exact domain operation, not arbitrary browser-provided policy keys.
        capability: Capability,
    },
    /// Read or atomically mutate the integrated moderation authority for one exact admitted actor.
    Moderator {
        /// Private conference identifier.
        room_id: String,
        /// Current native resource incarnation.
        room_instance_id: String,
        /// Server-resolved actor identity.
        peer_id: String,
        /// Actor's current Rust admission fence.
        epoch: u64,
        /// Omission reads state; mutations require current admitted presenter authority.
        change: Option<ModeratorChange>,
    },
    /// Evaluate initial admission in the Rust owner and bind the legacy device identifier once.
    Gate {
        /// Exact private conference.
        room_id: String,
        /// Native resource incarnation.
        room_instance_id: String,
        /// Server-resolved actor.
        peer_id: String,
        /// Current membership fence.
        epoch: u64,
        /// Legacy device identifier extracted from the owned native peer.
        uuid: String,
    },
    /// Read or mutate private room gates using the current actor authority.
    Control {
        /// Exact private conference.
        room_id: String,
        /// Native resource incarnation.
        room_instance_id: String,
        /// Server-resolved actor.
        peer_id: String,
        /// Current membership fence.
        epoch: u64,
        /// Validated private control operation.
        action: super::gates::Action,
    },
    /// Approve only an exact waiting target from a current admitted presenter.
    Approve {
        /// Exact private conference.
        room_id: String,
        /// Native resource incarnation.
        room_instance_id: String,
        /// Current presenter identity.
        peer_id: String,
        /// Presenter membership fence.
        epoch: u64,
        /// Current waiting target.
        target_id: String,
        /// Target membership fence.
        target_epoch: u64,
    },
    /// Test-only domain transition fixture; public JSON cannot select phases.
    #[cfg(test)]
    Phase {
        /// Conference identifier.
        room_id: String,
        /// Native room incarnation.
        room_instance_id: String,
        /// Server-resolved peer identity.
        peer_id: String,
        /// Rust-issued membership fence.
        epoch: u64,
        /// Validated admission/lobby decision, never copied from browser fields.
        phase: AdmissionPhase,
    },
    /// Read the sole owner's phase for a server-resolved native peer without consulting editable UI flags.
    Inspect {
        /// Conference identifier.
        room_id: String,
        /// Native room incarnation.
        room_instance_id: String,
        /// Exact server-resolved participant.
        peer_id: String,
        /// Privately issued admission fence.
        epoch: u64,
    },
    /// Return admitted recipients only if the requesting current member has live rights.
    Members {
        /// Conference identifier.
        room_id: String,
        /// Native room incarnation.
        room_instance_id: String,
        /// Server-resolved command actor.
        peer_id: String,
        /// Rust-issued membership fence.
        epoch: u64,
        /// Password checks can examine a pending member but not use media/recipient rights.
        pending: bool,
    },
    /// Remove membership immediately; native cleanup cannot accidentally remove its replacement.
    Leave {
        /// Conference identifier.
        room_id: String,
        /// Native room incarnation.
        room_instance_id: String,
        /// Current server-resolved peer.
        peer_id: String,
        /// Admission incarnation at cleanup scheduling.
        epoch: u64,
    },
}

/// Finite integrated domain permissions evaluated by the authoritative runtime.
#[derive(Clone, Copy)]
pub(crate) enum Capability {
    /// Microphone activation or resume.
    Audio,
    /// Camera activation or resume.
    Video,
    /// Screen activation or resume.
    Screen,
    /// Public human chat submission.
    PublicChat,
    /// Private human chat submission.
    PrivateChat,
}

/// Domain transition fixtures available only to deterministic unit tests.
#[cfg(test)]
#[derive(Clone, Copy)]
pub(crate) enum AdmissionPhase {
    /// Existing presenter/password/lobby policy has completed admission.
    Admitted,
    /// Existing password policy stopped this specific pending join.
    Password,
    /// Existing presenter policy requires approval; no participant rights.
    Lobby,
}
