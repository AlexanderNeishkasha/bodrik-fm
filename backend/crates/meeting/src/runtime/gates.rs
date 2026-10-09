//! Atomic admission gates and private room controls; no password is serialized in a public projection.

use crate::{
    membership::Phase,
    room::{Actor, RoomConfig},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use uuid::Uuid;

/// Ban lifetime, matching the legacy strict-after-24-hours boundary.
const BAN_TTL: Duration = Duration::from_secs(86400);

/// One live device ban; the device identifier never leaves Rust.
struct BanEntry {
    /// Opaque identifier presenters use to lift this ban.
    id: Uuid,
    /// Display name of the banned participant at ban time, for the presenter list.
    name: String,
    /// Monotonic expiry deadline.
    deadline: Instant,
}

/// Presenter-only ban list row; carries no device identifier.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BanView {
    /// Opaque identifier accepted by `Unban`.
    pub id: Uuid,
    /// Display name recorded when the ban was applied.
    pub name: String,
    /// Whole seconds until the ban expires.
    pub expires_in: u64,
}

/// Private typed controls; actor and native/session fences are supplied separately by the gateway.
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Action {
    /// Read public boolean configuration.
    Read,
    /// Enable a private password gate.
    Lock {
        /// Private password, never returned or logged.
        password: String,
    },
    /// Disable password gating.
    Unlock,
    /// Set presenter-controlled lobby admission.
    Lobby {
        /// Requested state.
        status: bool,
    },
    /// Block new nonpresenter admissions.
    JoinLock {
        /// Requested state.
        status: bool,
    },
    /// Retained guest notification for a globally configured lobby.
    GlobalLobby,
    /// Check a password and complete eligible pending admission atomically.
    Password {
        /// Submitted password, never returned or logged.
        password: String,
    },
    /// Add a bounded, expiring legacy device identifier ban.
    Ban {
        /// Server-extracted legacy device identifier.
        uuid: String,
        /// Server-held display name of the banned participant (bounded, may be empty).
        name: String,
    },
    /// Read the live ban list (presenters only).
    Bans,
    /// Lift one live ban by its opaque identifier (presenters only).
    Unban {
        /// Identifier from a `BanView`.
        id: Uuid,
    },
}

/// Sole room-gate authority, including bounded private password/ban state.
#[derive(Default)]
pub(super) struct Gates {
    /// Safe public room control projection.
    pub config: RoomConfig,
    /// Immutable startup lobby option.
    pub global_lobby: bool,
    /// Private password, not part of the public Policy DTO.
    password: Option<String>,
    /// Legacy device bans keyed by device identifier; not an account-authenticated identity.
    bans: HashMap<String, BanEntry>,
}

impl Gates {
    /// Expire bans on access using monotonic time; retain the legacy strict-after-24-hours boundary.
    pub fn expire(&mut self, now: Instant) {
        self.bans.retain(|_, entry| now <= entry.deadline);
    }

    /// Check a session-bound device identifier against the current live ban set.
    pub fn banned(&self, uuid: &str) -> bool {
        self.bans.contains_key(uuid)
    }

    /// Live bans for the presenter list, soonest expiry last; never exposes device identifiers.
    pub fn ban_list(&self, now: Instant) -> Vec<BanView> {
        let mut list: Vec<BanView> = self
            .bans
            .values()
            .map(|entry| BanView {
                id: entry.id,
                name: entry.name.clone(),
                expires_in: entry.deadline.saturating_duration_since(now).as_secs(),
            })
            .collect();
        list.sort_by(|a, b| {
            b.expires_in
                .cmp(&a.expires_in)
                .then_with(|| a.name.cmp(&b.name))
        });
        list
    }

    /// Decide initial admission from current Rust role and gates, never native Peer flags.
    pub fn decision(&self, uuid: &str, presenter: bool) -> &'static str {
        if self.banned(uuid) {
            "banned"
        } else if presenter {
            "admitted"
        } else if self.config.is_join_locked {
            "joinLocked"
        } else if self.config.is_locked {
            "password"
        } else if self.config.is_lobby_enabled || self.global_lobby {
            "lobby"
        } else {
            "admitted"
        }
    }

    /// Apply one validated actor-owned control; false is a confirmed invalid operation, not an outage fallback.
    ///
    /// # Errors
    /// Rejects unadmitted/nonpresenter actors before mutation; private credentials never occur in errors.
    pub fn apply(
        &mut self,
        actor: Actor,
        phase: Phase,
        uuid: &str,
        action: Action,
        now: Instant,
    ) -> Result<bool, &'static str> {
        if matches!(action, Action::Read) {
            return if actor.member || phase == Phase::Password {
                Ok(true)
            } else {
                Err("runtime denied")
            };
        }
        if let Action::Password { password } = action {
            if password.encode_utf16().count() > 256 {
                return Ok(false);
            }
            return Ok(self.password.as_deref() == Some(password.as_str())
                && !self.banned(uuid)
                && (actor.member
                    || (phase == Phase::Password
                        && !self.config.is_join_locked
                        && !self.config.is_lobby_enabled
                        && !self.global_lobby)));
        }
        if !actor.member || (!actor.presenter && !matches!(action, Action::GlobalLobby)) {
            return Err("runtime denied");
        }
        match action {
            Action::Lock { password } => {
                if password.is_empty() || password.encode_utf16().count() > 256 {
                    return Ok(false);
                }
                if !self.config.is_locked {
                    self.password = Some(password);
                    self.config.is_locked = true;
                }
            }
            Action::Unlock => {
                self.config.is_locked = false;
                self.password = None;
            }
            Action::Lobby { status } => self.config.is_lobby_enabled = status,
            Action::JoinLock { status } => self.config.is_join_locked = status,
            Action::GlobalLobby => {
                if !self.global_lobby {
                    return Ok(false);
                }
                self.config.is_lobby_enabled = true;
            }
            Action::Ban { uuid, name } => {
                if uuid.is_empty() || uuid.encode_utf16().count() > 160 {
                    return Ok(false);
                }
                if !self.bans.contains_key(&uuid) && self.bans.len() >= 1000 {
                    return Err("runtime capacity exhausted");
                }
                let name: String = name.chars().take(64).collect();
                self.bans.entry(uuid).or_insert_with(|| BanEntry {
                    id: Uuid::new_v4(),
                    name,
                    deadline: now + BAN_TTL,
                });
            }
            Action::Bans => {}
            Action::Unban { id } => {
                let before = self.bans.len();
                self.bans.retain(|_, entry| entry.id != id);
                return Ok(self.bans.len() != before);
            }
            Action::Read | Action::Password { .. } => return Err("runtime denied"),
        }
        Ok(true)
    }
}
