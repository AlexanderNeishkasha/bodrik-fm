//! Authoritative room policy transitions, independent of HTTP, Node and browser rendering.

use serde::{Deserialize, Serialize};

/// Retained boolean moderation settings; unknown fields cannot become policy accidentally.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Moderator {
    /// Initial camera privacy preference.
    pub video_start_privacy: bool,
    /// Initial microphone mute preference.
    pub audio_start_muted: bool,
    /// Initial camera-hidden preference.
    pub video_start_hidden: bool,
    /// Server restriction on microphone activation/resume.
    pub audio_cant_unmute: bool,
    /// Server restriction on camera activation/resume.
    pub video_cant_unhide: bool,
    /// Server restriction on screen sources.
    pub screen_cant_share: bool,
    /// Restriction on private human chat.
    pub chat_cant_privately: bool,
    /// Restriction on public human chat.
    pub chat_cant_publicly: bool,
}

/// Exact allowlisted moderation field; browser strings cannot create arbitrary policy keys.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModeratorField {
    /// Initial camera privacy preference.
    VideoStartPrivacy,
    /// Initial microphone mute preference.
    AudioStartMuted,
    /// Initial camera hidden preference.
    VideoStartHidden,
    /// Restrict microphone activation.
    AudioCantUnmute,
    /// Restrict camera activation.
    VideoCantUnhide,
    /// Restrict screen activation.
    ScreenCantShare,
    /// Restrict private chat.
    ChatCantPrivately,
    /// Restrict public chat.
    ChatCantPublicly,
}

/// Validated atomic moderation mutation; caller identity is resolved by the runtime, not this payload.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ModeratorChange {
    /// Update one allowlisted field without overwriting concurrent changes to other fields.
    One {
        /// Exact retained setting.
        field: ModeratorField,
        /// Requested boolean state.
        status: bool,
    },
    /// Replace the full eight-field projection atomically.
    All {
        /// Complete validated boolean state.
        moderator: Moderator,
    },
}

impl Moderator {
    /// Commit one already authorized typed change; parsing/authorization precedes this infallible transition.
    pub(crate) fn change(&mut self, change: ModeratorChange) {
        match change {
            ModeratorChange::All { moderator } => *self = moderator,
            ModeratorChange::One { field, status } => {
                let value = match field {
                    ModeratorField::VideoStartPrivacy => &mut self.video_start_privacy,
                    ModeratorField::AudioStartMuted => &mut self.audio_start_muted,
                    ModeratorField::VideoStartHidden => &mut self.video_start_hidden,
                    ModeratorField::AudioCantUnmute => &mut self.audio_cant_unmute,
                    ModeratorField::VideoCantUnhide => &mut self.video_cant_unhide,
                    ModeratorField::ScreenCantShare => &mut self.screen_cant_share,
                    ModeratorField::ChatCantPrivately => &mut self.chat_cant_privately,
                    ModeratorField::ChatCantPublicly => &mut self.chat_cant_publicly,
                };
                *value = status;
            }
        }
    }
}

/// Retained room-level controls; password material stays outside this public projection.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomConfig {
    /// Password gate enabled for new guests.
    pub is_locked: bool,
    /// Presenter-controlled lobby enabled.
    pub is_lobby_enabled: bool,
    /// All new nonpresenter admissions blocked.
    pub is_join_locked: bool,
}

/// Immutable public policy snapshot, never containing admission credentials or room passwords.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    /// Current room-level boolean policy.
    pub config: RoomConfig,
    /// Current media/chat moderation policy.
    pub moderator: Moderator,
}

/// Server-owned actor authority; caller display names are not part of this decision.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Actor {
    /// Actor currently belongs to this room/session incarnation.
    pub member: bool,
    /// Waiting guests cannot change policy or use admitted-room resources.
    pub lobby: bool,
    /// Role granted by server admission/authorized role transitions.
    pub presenter: bool,
}

/// Exact room-policy mutations; external adapters parse before reaching transitions.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum PolicyCommand {
    /// Set password-gate flag; password setting remains a separate private command.
    Locked(bool),
    /// Set lobby flag.
    Lobby(bool),
    /// Set admission lock flag.
    JoinLocked(bool),
    /// Replace the complete validated moderation projection atomically.
    Moderator(Moderator),
}

/// Explicit rejection categories matched by the transitional policy acknowledgement.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Rejection {
    /// Actor lacks an admitted current membership.
    Unavailable,
    /// Actor has no presenter authority for this mutation.
    Denied,
}

impl Policy {
    /// Apply one authorized transition; rejected commands never partially mutate the state.
    ///
    /// # Errors
    /// Returns unavailable for stale/lobby actors and denied for nonpresenters.
    pub fn apply(&mut self, actor: Actor, command: PolicyCommand) -> Result<(), Rejection> {
        if !actor.member || actor.lobby {
            return Err(Rejection::Unavailable);
        }
        if !actor.presenter {
            return Err(Rejection::Denied);
        }
        match command {
            PolicyCommand::Locked(value) => self.config.is_locked = value,
            PolicyCommand::Lobby(value) => self.config.is_lobby_enabled = value,
            PolicyCommand::JoinLocked(value) => self.config.is_join_locked = value,
            PolicyCommand::Moderator(value) => self.moderator = value,
        }
        Ok(())
    }

    /// Check media activation/resume against current server policy rather than disabled UI controls.
    pub fn permits_media(&self, actor: Actor, media_type: &str) -> bool {
        if !actor.member || actor.lobby {
            return false;
        }
        if actor.presenter {
            return matches!(media_type, "audioType" | "videoType" | "screenType");
        }
        match media_type {
            "audioType" => !self.moderator.audio_cant_unmute,
            "videoType" => !self.moderator.video_cant_unhide,
            "screenType" => !self.moderator.screen_cant_share,
            _ => false,
        }
    }
}

/// Named authority/media tables run without networks, databases, threads or environment mutation.
#[cfg(test)]
mod tests {
    use super::*;

    /// Rejected actors leave the entire policy unchanged.
    #[test]
    fn authority_cases() {
        for (name, actor, accepted) in [
            (
                "presenter",
                Actor {
                    member: true,
                    lobby: false,
                    presenter: true,
                },
                true,
            ),
            (
                "guest",
                Actor {
                    member: true,
                    lobby: false,
                    presenter: false,
                },
                false,
            ),
            (
                "waiting presenter",
                Actor {
                    member: true,
                    lobby: true,
                    presenter: true,
                },
                false,
            ),
            (
                "stale presenter",
                Actor {
                    member: false,
                    lobby: false,
                    presenter: true,
                },
                false,
            ),
        ] {
            let mut policy = Policy::default();
            let before = policy.clone();
            assert_eq!(
                policy.apply(actor, PolicyCommand::Lobby(true)).is_ok(),
                accepted,
                "{name}"
            );
            if !accepted {
                assert_eq!(policy, before, "{name}");
            }
        }
    }

    /// Forbidden sources cannot bypass moderation with a different string category.
    #[test]
    fn media_cases() {
        let policy = Policy {
            moderator: Moderator {
                audio_cant_unmute: true,
                video_cant_unhide: true,
                screen_cant_share: true,
                ..Moderator::default()
            },
            ..Policy::default()
        };
        for (name, actor, kind, allowed) in [
            (
                "guest mic",
                Actor {
                    member: true,
                    lobby: false,
                    presenter: false,
                },
                "audioType",
                false,
            ),
            (
                "guest camera",
                Actor {
                    member: true,
                    lobby: false,
                    presenter: false,
                },
                "videoType",
                false,
            ),
            (
                "guest screen",
                Actor {
                    member: true,
                    lobby: false,
                    presenter: false,
                },
                "screenType",
                false,
            ),
            (
                "presenter mic",
                Actor {
                    member: true,
                    lobby: false,
                    presenter: true,
                },
                "audioType",
                true,
            ),
            (
                "unknown presenter source",
                Actor {
                    member: true,
                    lobby: false,
                    presenter: true,
                },
                "futureType",
                false,
            ),
            (
                "lobby",
                Actor {
                    member: true,
                    lobby: true,
                    presenter: true,
                },
                "audioType",
                false,
            ),
        ] {
            assert_eq!(policy.permits_media(actor, kind), allowed, "{name}");
        }
    }
}
