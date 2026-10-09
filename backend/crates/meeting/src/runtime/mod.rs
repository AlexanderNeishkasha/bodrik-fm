//! Single bounded Rust owner of integrated room incarnations and participant admission phases.
//! Native objects live in the direct engine; admission/policy transitions live here.

#[cfg(test)]
mod ban_list_tests;
mod commands;
#[cfg(test)]
mod gate_limits_tests;
#[cfg(test)]
mod gate_race_tests;
#[cfg(test)]
mod gate_tests;
mod gates;
/// Presenter-only ban list row.
pub use gates::BanView;
pub(crate) mod media;
#[cfg(test)]
mod moderator_tests;
#[cfg(test)]
mod role_tests;
mod state;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) use commands::AdmissionPhase;
pub(crate) use commands::{Capability, Command};
pub(crate) use gates::Action as ControlAction;
use serde::Serialize;
use state::Registry;
use std::sync::{Arc, Mutex};

/// Process-local runtime; restart intentionally invalidates all old room/session bindings.
#[derive(Clone)]
pub(crate) struct Runtime {
    /// Short atomic transitions only; cryptography and HTTP run outside this lock.
    registry: Arc<Mutex<Registry>>,
    /// Public process incarnation; old in-flight commands cannot affect a replacement runtime.
    boot: Option<Arc<str>>,
}

impl Default for Runtime {
    /// Construct a new process-local owner with no recovered authority or resource handles.
    fn default() -> Self {
        let boot = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|time| Arc::from(format!("{}-{}", std::process::id(), time.as_nanos())));
        Self {
            registry: Arc::new(Mutex::new(Registry::default())),
            boot,
        }
    }
}

/// Sanitized command result or transport-adapter fencing values, never private credentials.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    /// Reservation or admission epoch, meaningful only with exact room/native instance binding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
    /// Admitted current recipients, used as a per-command projection rather than a second registry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<String>>,
    /// Admitted presenter recipients from the same atomic membership query.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presenters: Option<Vec<String>>,
    /// Current phase for an exact private native/epoch binding, never a cached client flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<&'static str>,
    /// Current server-owned role; native flags are presentation only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presenter: Option<bool>,
    /// Fresh immutable moderation projection; no rendering copy is authoritative.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moderator: Option<crate::room::Moderator>,
    /// Current typed operation decision, never derived from browser/native flags.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed: Option<bool>,
    /// Fresh safe room controls/moderation projection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<crate::room::Policy>,
    /// Presenter-only live ban list, returned for ban-list reads and changes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bans: Option<Vec<BanView>>,
    /// Confirmed control validation or password result, never a fallback on transport failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted: Option<bool>,
    /// Whether a retained lock notification is needed; mutation/no-op is decided in Rust.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<bool>,
}

impl Runtime {
    /// Read exact room-incarnation lease validity without extending it or relying on socket copies.
    ///
    /// # Errors
    /// A poisoned registry remains a service-wide failure, unlike a retired room.
    pub(crate) fn room_current(&self, id: &str, instance: &str) -> Result<bool, &'static str> {
        Ok(self
            .registry
            .lock()
            .map_err(|_| "runtime registry unavailable")?
            .room_current(id, instance, std::time::Instant::now()))
    }

    /// Apply a server-derived replacement transition after ticket verification/fresh player authority.
    /// This is crate-private: no browser JSON can supply commands, actors or grants directly.
    ///
    /// # Errors
    /// Rejects stale, denied, unavailable or capacity-exhausted domain transitions.
    pub(crate) fn apply_verified(
        &self,
        command: Command,
        grant: Option<crate::integration::Grant>,
    ) -> Result<Reply, &'static str> {
        self.registry
            .lock()
            .map_err(|_| "runtime unavailable")?
            .apply(command, grant, std::time::Instant::now())
    }
}
