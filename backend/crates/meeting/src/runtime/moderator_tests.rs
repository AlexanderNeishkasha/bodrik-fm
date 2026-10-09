//! Moderation authority tables cover active atomic commands, parsing and rejected actor phases.

use super::{
    commands::{AdmissionPhase, Capability, Command},
    state::Registry,
};
use crate::{
    integration::Grant,
    room::{Moderator, ModeratorChange, ModeratorField},
};
use std::time::Instant;

/// Current synthetic player authority, used only after the outer identity boundary.
fn grant() -> Grant {
    Grant {
        version: 1,
        conference_id: "room".into(),
        generation: 7,
        room_slug: "slug".into(),
        lease_seconds: 15,
    }
}

/// Build one exact actor binding with an optional completed phase and independently verified role.
fn fixture(now: Instant, presenter: bool, phase: Option<AdmissionPhase>) -> (Registry, u64) {
    fixture_with_moderator(now, presenter, phase, Moderator::default())
}

/// Establish initial startup restrictions before any guest enters the registry.
fn fixture_with_moderator(
    now: Instant,
    presenter: bool,
    phase: Option<AdmissionPhase>,
    moderator: Moderator,
) -> (Registry, u64) {
    let mut registry = Registry::default();
    let reservation = registry
        .apply(
            Command::Reserve {
                room_id: "room".into(),
            },
            Some(grant()),
            now,
        )
        .expect("reserve")
        .epoch
        .expect("epoch");
    registry
        .apply(
            Command::Commit {
                room_id: "room".into(),
                epoch: reservation,
                room_instance_id: "native".into(),
                presenter_names: Vec::new(),
                moderator,
                global_lobby: false,
            },
            Some(grant()),
            now,
        )
        .expect("commit");
    let epoch = registry
        .apply(
            Command::Begin {
                room_id: "room".into(),
                room_instance_id: "native".into(),
                peer_id: "actor".into(),

                presenter,
                username: "verified".into(),
            },
            Some(grant()),
            now,
        )
        .expect("begin")
        .epoch
        .expect("epoch");
    if let Some(phase) = phase {
        registry
            .apply(
                Command::Phase {
                    room_id: "room".into(),
                    room_instance_id: "native".into(),
                    peer_id: "actor".into(),
                    epoch,
                    phase,
                },
                None,
                now,
            )
            .expect("phase");
    }
    (registry, epoch)
}

/// Construct one actor-fenced moderation command; omitted change grants no mutation rights.
fn command(epoch: u64, change: Option<ModeratorChange>) -> Command {
    Command::Moderator {
        room_id: "room".into(),
        room_instance_id: "native".into(),
        peer_id: "actor".into(),
        epoch,
        change,
    }
}

/// Guests, pending/lobby actors and stale presenters cannot alter moderation state.
#[test]
fn moderator_authority_cases() {
    for (name, presenter, phase, stale, accepted) in [
        (
            "admitted presenter",
            true,
            Some(AdmissionPhase::Admitted),
            false,
            true,
        ),
        (
            "admitted guest",
            false,
            Some(AdmissionPhase::Admitted),
            false,
            false,
        ),
        ("pending presenter", true, None, false, false),
        (
            "lobby presenter",
            true,
            Some(AdmissionPhase::Lobby),
            false,
            false,
        ),
        (
            "password presenter",
            true,
            Some(AdmissionPhase::Password),
            false,
            false,
        ),
        (
            "old presenter epoch",
            true,
            Some(AdmissionPhase::Admitted),
            true,
            false,
        ),
    ] {
        let now = Instant::now();
        let (mut registry, epoch) = fixture(now, presenter, phase);
        let result = registry.apply(
            command(
                epoch + u64::from(stale),
                Some(ModeratorChange::One {
                    field: ModeratorField::AudioCantUnmute,
                    status: true,
                }),
            ),
            None,
            now,
        );
        assert_eq!(result.is_ok(), accepted, "{name}");
        if let Ok(read) = registry.apply(command(epoch, None), None, now) {
            assert_eq!(
                read.moderator.expect("moderator").audio_cant_unmute,
                accepted,
                "{name}"
            );
        }
    }
}

/// All eight allowlisted mutations preserve other fields and retain explicit false restoration.
#[test]
fn moderator_field_and_restore_cases() {
    let fields = [
        ModeratorField::VideoStartPrivacy,
        ModeratorField::AudioStartMuted,
        ModeratorField::VideoStartHidden,
        ModeratorField::AudioCantUnmute,
        ModeratorField::VideoCantUnhide,
        ModeratorField::ScreenCantShare,
        ModeratorField::ChatCantPrivately,
        ModeratorField::ChatCantPublicly,
    ];
    for field in fields {
        let now = Instant::now();
        let (mut registry, epoch) = fixture(now, true, Some(AdmissionPhase::Admitted));
        let reply = registry
            .apply(
                command(
                    epoch,
                    Some(ModeratorChange::One {
                        field,
                        status: true,
                    }),
                ),
                None,
                now,
            )
            .expect("change");
        let values = serde_json::to_value(reply.moderator.expect("moderator")).expect("serialize");
        assert_eq!(
            values
                .as_object()
                .expect("object")
                .values()
                .filter(|value| **value == true)
                .count(),
            1,
            "{field:?}"
        );
        let restored = registry
            .apply(
                command(
                    epoch,
                    Some(ModeratorChange::One {
                        field,
                        status: false,
                    }),
                ),
                None,
                now,
            )
            .expect("restore");
        assert_eq!(restored.moderator, Some(Moderator::default()), "{field:?}");
    }
}

/// Full replacements and later independent field changes remain atomic and support explicit restoration.
#[test]
fn full_moderator_replacement_and_independent_fields() {
    let now = Instant::now();
    let (mut registry, epoch) = fixture(now, true, Some(AdmissionPhase::Admitted));
    let all = Moderator {
        video_start_privacy: true,
        audio_start_muted: true,
        video_start_hidden: true,
        audio_cant_unmute: true,
        video_cant_unhide: true,
        screen_cant_share: true,
        chat_cant_privately: true,
        chat_cant_publicly: true,
    };
    let reply = registry
        .apply(
            command(
                epoch,
                Some(ModeratorChange::All {
                    moderator: all.clone(),
                }),
            ),
            None,
            now,
        )
        .expect("replace");
    assert_eq!(reply.moderator, Some(all));
    let changed = registry
        .apply(
            command(
                epoch,
                Some(ModeratorChange::One {
                    field: ModeratorField::ChatCantPrivately,
                    status: false,
                }),
            ),
            None,
            now,
        )
        .expect("independent field")
        .moderator
        .expect("moderator");
    assert!(!changed.chat_cant_privately);
    assert!(changed.chat_cant_publicly && changed.audio_cant_unmute);
    let restored = registry
        .apply(
            command(
                epoch,
                Some(ModeratorChange::All {
                    moderator: Moderator::default(),
                }),
            ),
            None,
            now,
        )
        .expect("restore");
    assert_eq!(restored.moderator, Some(Moderator::default()));
}

/// Password-pending actors may read the public boolean result without acquiring participant/mutation rights.
#[test]
fn password_read_is_not_participant_authority() {
    let now = Instant::now();
    let (mut registry, epoch) = fixture(now, false, Some(AdmissionPhase::Password));
    assert!(registry.apply(command(epoch, None), None, now).is_ok());
    assert!(
        registry
            .apply(
                Command::Members {
                    room_id: "room".into(),
                    room_instance_id: "native".into(),
                    peer_id: "actor".into(),
                    epoch,
                    pending: false,
                },
                None,
                now
            )
            .is_err()
    );
}

/// Active permission decisions are made in Rust, including presenter media exceptions but not chat exceptions.
#[test]
fn active_permission_cases() {
    for (name, presenter, phase, capability, allowed) in [
        (
            "guest microphone",
            false,
            Some(AdmissionPhase::Admitted),
            Capability::Audio,
            false,
        ),
        (
            "guest camera",
            false,
            Some(AdmissionPhase::Admitted),
            Capability::Video,
            false,
        ),
        (
            "guest screen",
            false,
            Some(AdmissionPhase::Admitted),
            Capability::Screen,
            false,
        ),
        (
            "presenter microphone",
            true,
            Some(AdmissionPhase::Admitted),
            Capability::Audio,
            true,
        ),
        (
            "presenter camera",
            true,
            Some(AdmissionPhase::Admitted),
            Capability::Video,
            true,
        ),
        (
            "presenter screen",
            true,
            Some(AdmissionPhase::Admitted),
            Capability::Screen,
            true,
        ),
        (
            "presenter public chat",
            true,
            Some(AdmissionPhase::Admitted),
            Capability::PublicChat,
            false,
        ),
        (
            "presenter private chat",
            true,
            Some(AdmissionPhase::Admitted),
            Capability::PrivateChat,
            false,
        ),
        ("pending presenter", true, None, Capability::Audio, false),
        (
            "lobby presenter",
            true,
            Some(AdmissionPhase::Lobby),
            Capability::Audio,
            false,
        ),
        (
            "password presenter",
            true,
            Some(AdmissionPhase::Password),
            Capability::Audio,
            false,
        ),
    ] {
        let now = Instant::now();
        let moderator = Moderator {
            audio_cant_unmute: true,
            video_cant_unhide: true,
            screen_cant_share: true,
            chat_cant_publicly: true,
            chat_cant_privately: true,
            ..Default::default()
        };
        let (mut registry, epoch) = fixture_with_moderator(now, presenter, phase, moderator);
        let reply = registry
            .apply(
                Command::Authorize {
                    room_id: "room".into(),
                    room_instance_id: "native".into(),
                    peer_id: "actor".into(),
                    epoch,
                    capability,
                },
                None,
                now,
            )
            .expect(name);
        assert_eq!(reply.allowed, Some(allowed), "{name}");
    }
}

/// Unknown fields, partial replacements and nonboolean values cannot enter the active mutation path.
#[test]
fn moderator_payload_rejections() {
    for (name, change) in [
        (
            "unknown field",
            serde_json::json!({"type":"one", "field":"password", "status":true}),
        ),
        (
            "nonboolean",
            serde_json::json!({"type":"one", "field":"audio_cant_unmute", "status":"true"}),
        ),
        (
            "extra identity",
            serde_json::json!({"type":"one", "field":"audio_cant_unmute", "status":true, "presenter":true}),
        ),
        (
            "partial all",
            serde_json::json!({"type":"all", "moderator":{"audio_cant_unmute":true}}),
        ),
    ] {
        assert!(
            serde_json::from_value::<ModeratorChange>(change).is_err(),
            "{name}"
        );
    }
}
