//! Fenced active admission/control commands, separated from native room allocation transitions.

use super::{Registry, Room, Session};
use crate::runtime::{Reply, gates::Action};
use crate::{
    membership::Phase,
    room::{Actor, Policy},
};
use std::time::Instant;

impl Room {
    /// Derive current participant rights, including immediate denial after a device ban.
    pub(super) fn actor(&self, member: &Session) -> Actor {
        let mut actor = member.value.actor(self.generation);
        actor.member &= !self.gates.banned(&member.uuid);
        actor
    }

    /// Derive safe controls and moderation without serializing password/ban storage.
    fn policy(&self) -> Policy {
        Policy {
            config: self.gates.config.clone(),
            moderator: self.moderator.clone(),
        }
    }
}

impl Registry {
    /// Bind a pending identity's legacy device identifier and evaluate all gates in the sole Rust owner.
    ///
    /// # Errors
    /// Rejects malformed identifiers, old epochs and repeated admission attempts before mutation.
    pub(super) fn gate(
        &mut self,
        id: &str,
        instance: &str,
        peer: &str,
        epoch: u64,
        uuid: String,
    ) -> Result<Reply, &'static str> {
        if uuid.encode_utf16().count() > 160 {
            return Err("runtime denied");
        }
        let room = self.room(id, instance)?;
        // Session takeover: the same verified actor (browser device or account) rejoining
        // while an earlier session is still present, e.g. after a refresh. The new session
        // inherits the presenter role and skips gates the earlier one already passed; the
        // gateway then closes the earlier session.
        let mut takeover = false;
        let mut inherits_presenter = false;
        if !room.gates.banned(&uuid) {
            for (other, member) in &room.members {
                if other.as_str() != peer && member.gate_checked && member.uuid == uuid {
                    takeover |= member.value.phase() == Phase::Admitted;
                    inherits_presenter |= member.value.presenter();
                }
            }
        }
        let member = room.members.get_mut(peer).ok_or("runtime denied")?;
        if member.value.epoch() != epoch
            || member.value.phase() != Phase::Pending
            || member.gate_checked
        {
            return Err("runtime stale");
        }
        member.uuid = uuid;
        member.gate_checked = true;
        if inherits_presenter && !room.gates.banned(&member.uuid) {
            member.value.set_presenter(true);
        }
        let decision = if takeover {
            "admitted"
        } else {
            room.gates.decision(&member.uuid, member.value.presenter())
        };
        match decision {
            "admitted" => member.value.admit(epoch, room.generation),
            "password" => member.value.wait_for_password(epoch),
            "lobby" => member.value.wait_in_lobby(epoch),
            _ => {
                return Ok(Reply {
                    phase: Some(decision),
                    ..Default::default()
                });
            }
        }
        .map_err(|_| "runtime stale")?;
        member.pending_deadline = None;
        Ok(Reply {
            phase: Some(decision),
            presenter: Some(member.value.presenter()),
            ..Default::default()
        })
    }

    /// Execute controls/password completion atomically against current role, phase and ban state.
    ///
    /// # Errors
    /// Rejects stale/foreign/unadmitted actors and unauthorized changes without exposing private material.
    pub(super) fn control(
        &mut self,
        id: &str,
        instance: &str,
        peer: &str,
        epoch: u64,
        action: Action,
        now: Instant,
    ) -> Result<Reply, &'static str> {
        let room = self.room(id, instance)?;
        let member = room.members.get(peer).ok_or("runtime denied")?;
        if member.value.epoch() != epoch {
            return Err("runtime stale");
        }
        let actor = room.actor(member);
        let phase = member.value.phase();
        let password = matches!(action, Action::Password { .. });
        let lists_bans = matches!(
            action,
            Action::Ban { .. } | Action::Bans | Action::Unban { .. }
        );
        let changed = match &action {
            Action::Read => false,
            Action::Lock { .. } => !room.gates.config.is_locked,
            Action::Password { .. } => phase == Phase::Password,
            _ => true,
        };
        let accepted = room.gates.apply(actor, phase, &member.uuid, action, now)?;
        if password && accepted && phase == Phase::Password {
            room.members
                .get_mut(peer)
                .ok_or("runtime denied")?
                .value
                .admit(epoch, room.generation)
                .map_err(|_| "runtime stale")?;
        }
        // Gates::apply already rejected non-presenters for ban actions.
        let bans = lists_bans.then(|| room.gates.ban_list(now));
        Ok(Reply {
            accepted: Some(accepted),
            changed: Some(changed && accepted),
            policy: Some(room.policy()),
            bans,
            ..Default::default()
        })
    }

    /// Approve a lobby target only after checking both exact epochs and the current presenter's rights.
    ///
    /// # Errors
    /// Rejects stale actors/targets, bans and any target not actually waiting in the Rust lobby.
    pub(super) fn approve(
        &mut self,
        id: &str,
        instance: &str,
        peer: &str,
        epoch: u64,
        target: &str,
        target_epoch: u64,
    ) -> Result<Reply, &'static str> {
        let room = self.room(id, instance)?;
        let member = room.members.get(peer).ok_or("runtime denied")?;
        let actor = room.actor(member);
        if member.value.epoch() != epoch || !actor.member || !actor.presenter {
            return Err("runtime denied");
        }
        let target = room.members.get_mut(target).ok_or("runtime denied")?;
        if target.value.epoch() != target_epoch
            || target.value.phase() != Phase::Lobby
            || room.gates.banned(&target.uuid)
        {
            return Err("runtime stale");
        }
        target
            .value
            .admit(target_epoch, room.generation)
            .map_err(|_| "runtime stale")?;
        Ok(Reply::default())
    }
}
