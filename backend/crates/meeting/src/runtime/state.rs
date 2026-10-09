//! Bounded atomic registry transitions; all network and cryptographic work happens before entry.

mod controls;
#[cfg(test)]
use super::commands::AdmissionPhase;

use super::{
    Reply,
    commands::{Capability, Command},
};
use crate::{
    integration::Grant,
    media::protocol::identifier,
    membership::{Membership, Phase},
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// Fixed live-room ceiling, including pending native allocations.
const MAX_ROOMS: usize = 128;
/// Fixed process-wide participant ceiling; no unbounded peer-ID map.
const MAX_MEMBERS: usize = 4000;
/// Per-room recipient/response ceiling.
const MAX_ROOM_MEMBERS: usize = 1000;
/// Pending native allocations share a bounded independent budget.
const MAX_PENDING: usize = 8;

/// One pending native allocation or current native room binding.
struct Room {
    /// Rust-issued incarnation/reservation fence.
    epoch: u64,
    /// Player revocation generation, never accepted from a browser DTO.
    generation: u64,
    /// Positive authority lease/reservation deadline; renewal cannot resurrect expired records.
    deadline: Instant,
    /// Native incarnation is absent until a successful fenced commit.
    instance: Option<String>,
    /// Sole participant phase store; native resource ownership lives in the direct engine.
    members: HashMap<String, Session>,
    /// Startup-configured identities, never matched against editable participant nicknames.
    presenter_names: Vec<String>,
    /// Sole integrated moderation state; native Room fields remain standalone/startup configuration only.
    moderator: crate::room::Moderator,
    /// Sole private gate authority.
    gates: super::gates::Gates,
}

/// Membership and its initial unconfirmed-admission deadline; no browser/native object is stored.
struct Session {
    /// Sole authoritative phase and epoch record.
    value: Membership,
    /// Unacknowledged initial join cannot pin capacity forever; established gates clear this deadline.
    pending_deadline: Option<Instant>,
    /// Configured presenters cannot be demoted by runtime role commands.
    pinned_presenter: bool,
    /// Legacy device identifier bound exactly once by initial gate evaluation.
    uuid: String,
    /// Initial device/gate evaluation is single-shot even for rejected pending candidates.
    gate_checked: bool,
}

/// Process-local room/member owner; callers serialize only the short transition below.
#[derive(Default)]
pub(super) struct Registry {
    /// Pending and active room incarnations.
    rooms: HashMap<String, Room>,
    /// Monotonic process-local fencing sequence; boot identity is checked by the HTTP boundary.
    sequence: u64,
}

impl Registry {
    /// Distinguish a definitively expired/foreign room from global registry failure.
    pub(super) fn room_current(&self, id: &str, instance: &str, now: Instant) -> bool {
        self.rooms
            .get(id)
            .is_some_and(|room| room.instance.as_deref() == Some(instance) && now < room.deadline)
    }

    /// Allocate a JavaScript-safe fence without wrapping or reusing an incarnation.
    ///
    /// # Errors
    /// Rejects exhausted JavaScript-safe epoch space without changing the sequence.
    fn next(&mut self) -> Result<u64, &'static str> {
        let next = self
            .sequence
            .checked_add(1)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or("runtime capacity exhausted")?;
        self.sequence = next;
        Ok(next)
    }

    /// Resolve one current native incarnation before processing any participant payload.
    ///
    /// # Errors
    /// Rejects malformed, missing or foreign native bindings.
    fn room(&mut self, id: &str, instance: &str) -> Result<&mut Room, &'static str> {
        if !identifier(id) || !identifier(instance) {
            return Err("runtime denied");
        }
        let room = self.rooms.get_mut(id).ok_or("runtime unavailable")?;
        if room.instance.as_deref() != Some(instance) {
            return Err("runtime stale");
        }
        Ok(room)
    }

    /// Apply one command after expiring stale records, with rejection checks preceding its own mutation.
    ///
    /// # Errors
    /// Rejects stale/expired/foreign bindings, invalid transitions, revoked grants and exhausted capacity.
    pub(super) fn apply(
        &mut self,
        command: Command,
        grant: Option<Grant>,
        now: Instant,
    ) -> Result<Reply, &'static str> {
        self.rooms.retain(|_, room| now < room.deadline);
        for room in self.rooms.values_mut() {
            room.gates.expire(now);
            room.members.retain(|_, member| {
                member
                    .pending_deadline
                    .is_none_or(|deadline| now < deadline)
            });
        }
        match command {
            Command::Reserve { room_id, .. } => {
                if !identifier(&room_id) {
                    return Err("runtime denied");
                }
                if self.rooms.contains_key(&room_id) {
                    return Err("already exists");
                }
                if self.rooms.len() >= MAX_ROOMS
                    || self
                        .rooms
                        .values()
                        .filter(|room| room.instance.is_none())
                        .count()
                        >= MAX_PENDING
                {
                    return Err("runtime capacity exhausted");
                }
                let grant = grant.ok_or("runtime denied")?;
                if grant.conference_id != room_id {
                    return Err("runtime denied");
                }
                let epoch = self.next()?;
                self.rooms.insert(
                    room_id,
                    Room {
                        epoch,
                        generation: grant.generation,
                        deadline: now + Duration::from_secs(10),
                        instance: None,
                        members: HashMap::new(),
                        presenter_names: Vec::new(),
                        moderator: crate::room::Moderator::default(),
                        gates: super::gates::Gates::default(),
                    },
                );
                Ok(Reply {
                    epoch: Some(epoch),
                    ..Reply::default()
                })
            }
            Command::Commit {
                room_id,
                epoch,
                room_instance_id,
                presenter_names,
                moderator,
                global_lobby,
            } => {
                if presenter_names.len() > 100
                    || presenter_names
                        .iter()
                        .any(|name| name.is_empty() || name.len() > 256)
                {
                    return Err("runtime denied");
                }
                if !identifier(&room_instance_id) {
                    return Err("runtime denied");
                }
                let grant = grant.ok_or("runtime denied")?;
                let room = self.rooms.get_mut(&room_id).ok_or("runtime unavailable")?;
                if room.epoch != epoch
                    || room.instance.is_some()
                    || room.generation != grant.generation
                    || grant.conference_id != room_id
                {
                    return Err("runtime stale");
                }
                room.instance = Some(room_instance_id);
                room.presenter_names = presenter_names;
                room.moderator = moderator;
                room.gates.global_lobby = global_lobby;
                room.deadline = now + Duration::from_secs(u64::from(grant.lease_seconds));
                Ok(Reply::default())
            }
            Command::Abort { room_id, epoch } => {
                if self
                    .rooms
                    .get(&room_id)
                    .is_some_and(|room| room.epoch == epoch)
                {
                    self.rooms.remove(&room_id);
                }
                Ok(Reply::default())
            }
            Command::Renew {
                room_id,
                room_instance_id,
            } => {
                let grant = grant.ok_or("runtime denied")?;
                let room = self.room(&room_id, &room_instance_id)?;
                if grant.conference_id != room_id || room.generation != grant.generation {
                    return Err("runtime stale");
                }
                room.deadline = now + Duration::from_secs(u64::from(grant.lease_seconds));
                Ok(Reply::default())
            }
            Command::Begin {
                room_id,
                room_instance_id,
                peer_id,
                presenter,
                username,
                ..
            } => {
                if !identifier(&peer_id)
                    || self
                        .rooms
                        .iter()
                        .any(|(id, room)| id != &room_id && room.members.contains_key(&peer_id))
                {
                    return Err("runtime denied");
                }
                let replacing = self
                    .rooms
                    .get(&room_id)
                    .is_some_and(|room| room.members.contains_key(&peer_id));
                if !replacing
                    && self
                        .rooms
                        .values()
                        .map(|room| room.members.len())
                        .sum::<usize>()
                        >= MAX_MEMBERS
                {
                    return Err("runtime capacity exhausted");
                }
                let grant = grant.ok_or("runtime denied")?;
                let room = self.room(&room_id, &room_instance_id)?;
                if room.generation != grant.generation
                    || grant.conference_id != room_id
                    || (!replacing && room.members.len() >= MAX_ROOM_MEMBERS)
                {
                    return Err("runtime denied");
                }
                // Integrated proofs share a mint identity: configuration must never promote a signed guest.
                let pinned_presenter = presenter && room.presenter_names.contains(&username);
                // Replacement never inherits an admitted phase; stale cleanup carries the old epoch.
                let epoch = self.next()?;
                self.room(&room_id, &room_instance_id)?.members.insert(
                    peer_id,
                    Session {
                        value: Membership::pending(grant.generation, epoch, presenter),
                        pending_deadline: Some(now + Duration::from_secs(10)),
                        pinned_presenter,
                        uuid: String::new(),
                        gate_checked: false,
                    },
                );
                Ok(Reply {
                    epoch: Some(epoch),
                    presenter: Some(presenter),
                    ..Reply::default()
                })
            }
            Command::Role {
                room_id,
                room_instance_id,
                peer_id,
                epoch,
            } => {
                let room = self.room(&room_id, &room_instance_id)?;
                let member = room.members.get(&peer_id).ok_or("runtime denied")?;
                if member.value.epoch() != epoch {
                    return Err("runtime stale");
                }
                Ok(Reply {
                    presenter: Some(member.value.presenter()),
                    ..Reply::default()
                })
            }
            Command::SetRole {
                room_id,
                room_instance_id,
                peer_id,
                epoch,
                target_id,
                target_epoch,
                presenter,
            } => {
                let room = self.room(&room_id, &room_instance_id)?;
                let actor = room.members.get(&peer_id).ok_or("runtime denied")?;
                let rights = room.actor(actor);
                if actor.value.epoch() != epoch || !rights.member || !rights.presenter {
                    return Err("runtime denied");
                }
                let target = room.members.get_mut(&target_id).ok_or("runtime denied")?;
                if target.value.epoch() != target_epoch
                    || !target.value.actor(room.generation).member
                    || room.gates.banned(&target.uuid)
                {
                    return Err("runtime stale");
                }
                if !presenter && target.pinned_presenter {
                    return Err("runtime denied");
                }
                target.value.set_presenter(presenter);
                Ok(Reply {
                    presenter: Some(presenter),
                    ..Reply::default()
                })
            }
            Command::Authorize {
                room_id,
                room_instance_id,
                peer_id,
                epoch,
                capability,
            } => {
                let room = self.room(&room_id, &room_instance_id)?;
                let member = room.members.get(&peer_id).ok_or("runtime denied")?;
                if member.value.epoch() != epoch {
                    return Err("runtime stale");
                }
                let actor = room.actor(member);
                let policy = crate::room::Policy {
                    moderator: room.moderator.clone(),
                    ..Default::default()
                };
                let allowed = match capability {
                    Capability::Audio => policy.permits_media(actor, "audioType"),
                    Capability::Video => policy.permits_media(actor, "videoType"),
                    Capability::Screen => policy.permits_media(actor, "screenType"),
                    Capability::PublicChat => actor.member && !policy.moderator.chat_cant_publicly,
                    Capability::PrivateChat => {
                        actor.member && !policy.moderator.chat_cant_privately
                    }
                };
                Ok(Reply {
                    allowed: Some(allowed),
                    ..Reply::default()
                })
            }
            Command::Moderator {
                room_id,
                room_instance_id,
                peer_id,
                epoch,
                change,
            } => {
                let room = self.room(&room_id, &room_instance_id)?;
                let member = room.members.get(&peer_id).ok_or("runtime denied")?;
                let actor = room.actor(member);
                if member.value.epoch() != epoch
                    || !(actor.member
                        || change.is_none() && matches!(member.value.phase(), Phase::Password))
                {
                    return Err("runtime denied");
                }
                if let Some(change) = change {
                    if !actor.presenter {
                        return Err("runtime denied");
                    }
                    room.moderator.change(change);
                }
                Ok(Reply {
                    moderator: Some(room.moderator.clone()),
                    ..Reply::default()
                })
            }
            Command::Gate {
                room_id,
                room_instance_id,
                peer_id,
                epoch,
                uuid,
            } => self.gate(&room_id, &room_instance_id, &peer_id, epoch, uuid),
            Command::Control {
                room_id,
                room_instance_id,
                peer_id,
                epoch,
                action,
            } => self.control(&room_id, &room_instance_id, &peer_id, epoch, action, now),
            Command::Approve {
                room_id,
                room_instance_id,
                peer_id,
                epoch,
                target_id,
                target_epoch,
            } => self.approve(
                &room_id,
                &room_instance_id,
                &peer_id,
                epoch,
                &target_id,
                target_epoch,
            ),
            #[cfg(test)]
            Command::Phase {
                room_id,
                room_instance_id,
                peer_id,
                epoch,
                phase,
            } => {
                let room = self.room(&room_id, &room_instance_id)?;
                let member = room.members.get_mut(&peer_id).ok_or("runtime denied")?;
                match phase {
                    AdmissionPhase::Admitted => member.value.admit(epoch, room.generation),
                    AdmissionPhase::Password => member.value.wait_for_password(epoch),
                    AdmissionPhase::Lobby => member.value.wait_in_lobby(epoch),
                }
                .map_err(|_| "runtime stale")?;
                member.pending_deadline = None;
                Ok(Reply::default())
            }
            Command::Inspect {
                room_id,
                room_instance_id,
                peer_id,
                epoch,
            } => {
                let room = self.room(&room_id, &room_instance_id)?;
                let member = room.members.get(&peer_id).ok_or("runtime denied")?;
                if member.value.epoch() != epoch {
                    return Err("runtime stale");
                }
                let phase = match member.value.phase() {
                    Phase::Pending => "pending",
                    Phase::Password => "password",
                    Phase::Lobby => "lobby",
                    Phase::Admitted => "admitted",
                    Phase::Leaving => "leaving",
                    Phase::Closed => "closed",
                };
                Ok(Reply {
                    phase: Some(phase),
                    ..Reply::default()
                })
            }
            Command::Members {
                room_id,
                room_instance_id,
                peer_id,
                epoch,
                pending,
            } => {
                let room = self.room(&room_id, &room_instance_id)?;
                let member = room.members.get(&peer_id).ok_or("runtime denied")?;
                if member.value.epoch() != epoch
                    || !(room.actor(member).member
                        || pending && matches!(member.value.phase(), Phase::Password))
                {
                    return Err("runtime denied");
                }
                let mut members: Vec<_> = room
                    .members
                    .iter()
                    .filter(|(_, member)| room.actor(member).member)
                    .map(|(id, _)| id.clone())
                    .collect();
                members.sort_unstable();
                let presenters = members
                    .iter()
                    .filter(|id| room.members[*id].value.presenter())
                    .cloned()
                    .collect();
                Ok(Reply {
                    members: Some(members),
                    presenters: Some(presenters),
                    ..Reply::default()
                })
            }
            Command::Leave {
                room_id,
                room_instance_id,
                peer_id,
                epoch,
            } => {
                let room = self.room(&room_id, &room_instance_id)?;
                let member = room.members.get_mut(&peer_id).ok_or("runtime denied")?;
                member.value.leave(epoch).map_err(|_| "runtime stale")?;
                member.value.cleanup(epoch).map_err(|_| "runtime stale")?;
                room.members.remove(&peer_id);
                if room.members.is_empty() {
                    self.rooms.remove(&room_id);
                }
                Ok(Reply::default())
            }
        }
    }
}
