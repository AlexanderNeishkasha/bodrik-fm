//! Admission and explicit-leave transitions used by the active Rust membership owner.

use crate::room::Actor;

/// Admission phases; socket recovery is owned by the replacement session store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Identity verified, room admission not yet completed.
    Pending,
    /// Verified join stopped specifically by the password policy; still no participant rights.
    Password,
    /// Presenter approval required; no media or recipient rights.
    Lobby,
    /// Current connection can use authorized room resources.
    Admitted,
    /// Explicit leave has removed authority; resource cleanup may still be running.
    Leaving,
    /// Terminal incarnation; only a separate new admission may join again.
    Closed,
}

/// Rejected transitions never change phase or epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransitionError {
    /// Caller acts on an old connection/admission incarnation.
    StaleEpoch,
    /// Current phase does not permit the requested transition.
    InvalidPhase,
    /// Private player generation no longer matches this admission.
    Revoked,
}

/// One server-created membership incarnation; browser DTOs cannot create or update this record.
#[derive(Clone, Debug)]
pub struct Membership {
    /// Private player generation at identity admission.
    generation: u64,
    /// Immutable admission epoch fencing resource requests and cleanup.
    epoch: u64,
    /// Current mutually exclusive lifecycle phase.
    phase: Phase,
    /// Presenter role assigned by authenticated admission/authorized room transitions.
    presenter: bool,
}

impl Membership {
    /// Start a verified identity with no media/recipient rights; room gates must still be satisfied.
    pub fn pending(generation: u64, epoch: u64, presenter: bool) -> Self {
        Self {
            generation,
            epoch,
            phase: Phase::Pending,
            presenter,
        }
    }

    /// Read the phase without duplicating lifecycle state in another owner.
    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Read the fencing value used by owned resource requests and cleanup callbacks.
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Read the verified/current role without granting admission rights to pending sessions.
    pub fn presenter(&self) -> bool {
        self.presenter
    }

    /// Change a role after the registry has checked actor and target admission atomically.
    pub(crate) fn set_presenter(&mut self, presenter: bool) {
        self.presenter = presenter;
    }

    /// Reject old timers/commands before examining their transition payload.
    ///
    /// # Errors
    /// Returns stale epoch for any obsolete connection incarnation.
    fn check_epoch(&self, epoch: u64) -> Result<(), TransitionError> {
        if epoch != self.epoch {
            return Err(TransitionError::StaleEpoch);
        }
        Ok(())
    }

    /// Record a password-gated join without granting recipient or media rights.
    ///
    /// # Errors
    /// Rejects stale epochs and any phase other than pending.
    pub fn wait_for_password(&mut self, epoch: u64) -> Result<(), TransitionError> {
        self.check_epoch(epoch)?;
        if self.phase != Phase::Pending {
            return Err(TransitionError::InvalidPhase);
        }
        self.phase = Phase::Password;
        Ok(())
    }

    /// Put an unadmitted identity into the presenter-controlled lobby.
    ///
    /// # Errors
    /// Rejects stale epochs and any phase other than pending.
    pub fn wait_in_lobby(&mut self, epoch: u64) -> Result<(), TransitionError> {
        self.check_epoch(epoch)?;
        if self.phase != Phase::Pending {
            return Err(TransitionError::InvalidPhase);
        }
        self.phase = Phase::Lobby;
        Ok(())
    }

    /// Complete gates after authorized password/role/lobby validation by the room owner.
    ///
    /// # Errors
    /// Rejects stale epochs, revoked generation, and phases other than pending/password/lobby.
    pub fn admit(&mut self, epoch: u64, generation: u64) -> Result<(), TransitionError> {
        self.check_epoch(epoch)?;
        if generation != self.generation {
            return Err(TransitionError::Revoked);
        }
        if !matches!(self.phase, Phase::Pending | Phase::Password | Phase::Lobby) {
            return Err(TransitionError::InvalidPhase);
        }
        self.phase = Phase::Admitted;
        Ok(())
    }

    /// Remove authority immediately for explicit leave; no recovery grace is applied.
    ///
    /// # Errors
    /// Rejects stale epochs and an already terminal admission.
    pub fn leave(&mut self, epoch: u64) -> Result<(), TransitionError> {
        self.check_epoch(epoch)?;
        if matches!(self.phase, Phase::Leaving | Phase::Closed) {
            return Err(TransitionError::InvalidPhase);
        }
        self.phase = Phase::Leaving;
        Ok(())
    }

    /// Commit cleanup only after an explicit leave has removed admission rights.
    ///
    /// # Errors
    /// Rejects stale epochs and phases other than leaving.
    pub fn cleanup(&mut self, epoch: u64) -> Result<(), TransitionError> {
        self.check_epoch(epoch)?;
        if self.phase != Phase::Leaving {
            return Err(TransitionError::InvalidPhase);
        }
        self.phase = Phase::Closed;
        Ok(())
    }

    /// Derive room command rights; pending/lobby/revoked identities never receive live rights.
    pub fn actor(&self, generation: u64) -> Actor {
        Actor {
            member: generation == self.generation && self.phase == Phase::Admitted,
            lobby: self.phase == Phase::Lobby,
            presenter: self.presenter,
        }
    }
}

/// Admission and cleanup fencing tables for the active membership lifecycle.
#[cfg(test)]
mod tests {
    use super::*;

    /// Failed admission preserves phase and epoch for stale and revoked bindings.
    #[test]
    fn admission_rejections() {
        for (name, epoch, generation, expected) in [
            ("stale epoch", 6, 3, TransitionError::StaleEpoch),
            ("revoked generation", 7, 4, TransitionError::Revoked),
        ] {
            let mut member = Membership::pending(3, 7, false);
            assert_eq!(member.admit(epoch, generation), Err(expected), "{name}");
            assert_eq!(member.phase(), Phase::Pending, "{name}");
            assert_eq!(member.epoch(), 7, "{name}");
        }
    }

    /// Leave removes rights from each live phase; stale and premature cleanup cannot close it.
    #[test]
    fn explicit_leave_cases() {
        for (name, phase) in [
            ("pending", Phase::Pending),
            ("password", Phase::Password),
            ("lobby", Phase::Lobby),
            ("admitted", Phase::Admitted),
        ] {
            let mut member = Membership::pending(3, 7, true);
            member.phase = phase;
            assert_eq!(
                member.cleanup(7),
                Err(TransitionError::InvalidPhase),
                "{name}"
            );
            assert_eq!(member.leave(6), Err(TransitionError::StaleEpoch), "{name}");
            assert_eq!(member.phase(), phase, "{name}");
            member.leave(7).expect(name);
            assert!(!member.actor(3).member, "{name}");
            assert_eq!(
                member.cleanup(6),
                Err(TransitionError::StaleEpoch),
                "{name}"
            );
            member.cleanup(7).expect(name);
            assert_eq!(member.phase(), Phase::Closed, "{name}");
            assert_eq!(
                member.admit(7, 3),
                Err(TransitionError::InvalidPhase),
                "{name}"
            );
        }
    }
}
