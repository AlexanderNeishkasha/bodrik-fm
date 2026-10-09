//! Named delivery/fencing/backpressure fixtures exercise the actual domain recipient boundary.

mod interactions;
mod isolation;
mod producer_state;
mod stream;
use super::*;
use crate::{
    integration::Grant,
    replacement::{
        chat::{ReactionAction, Target},
        config::{Config, Settings},
        moderation::{PeerAction, RoomAction},
        participant::{FollowAction, ProfileChange},
        session::{Room, Session},
        wire::Outbound,
    },
    room::{ModeratorChange, ModeratorField},
    signaling::SessionStamp,
};
use std::sync::{Arc, Mutex, atomic::AtomicBool};
use tokio::sync::{Semaphore, mpsc};

/// Isolated service with an explicitly verified sender host; no network or production config is used.
pub(crate) fn fixture(
    pending: bool,
    disconnected: bool,
) -> (Service, Vec<mpsc::Receiver<Outbound>>, Binding) {
    let config = Config::parse(Settings {
        bind: "127.0.0.1:0",
        media_bind: "127.0.0.1",
        media_announced: "",
        media_min: "43000",
        media_max: "43100",
        player_url: "http://127.0.0.1:2",
        player_secret: "synthetic-player-service-secret-32",
        key: "synthetic-ticket-signing-secret-32",
        issuer: "player",
        audience: "meeting",
        origins: "http://localhost:3000",
        invite_base: "https://example.test/api/conferences",
        bye_url: "http://localhost:3000/bye",
        buttons: "false",
        brand: "false",
        avatar_dir: "uploads/avatars",
        chat_image_dir: "uploads/chat",
        diagnostics_dir: "logs/diagnostics",
        diagnostics_retention_days: "14",
        diagnostics_file_bytes: "10485760",
        diagnostics_total_bytes: "104857600",
        ffmpeg_path: "ffmpeg",
        music_rtp_host: "127.0.0.1",
    })
    .expect("config");
    let service = Service {
        config: Arc::new(config),
        runtime: Default::default(),
        store: Arc::new(Mutex::new(Default::default())),
        lifecycle: Arc::new(tokio::sync::Mutex::new(())),
        sockets: Arc::new(Semaphore::new(512)),
        observing: Arc::new(AtomicBool::new(true)),
        draining: Arc::new(AtomicBool::new(false)),
        upload_limits: Arc::new(crate::replacement::uploads::Limits::new()),
        diagnostics: crate::replacement::diagnostics::Handle::disconnected(),
        diagnostic_limits: Arc::new(crate::replacement::diagnostics::Limits::new()),
        chat_limits: Arc::new(crate::replacement::chat::Limits::new()),
    };
    let grant = Grant {
        version: 1,
        conference_id: "conference".into(),
        generation: 3,
        room_slug: "public-room".into(),
        lease_seconds: 15,
    };
    let reservation = service
        .runtime
        .apply_verified(
            Command::Reserve {
                room_id: "conference".into(),
            },
            Some(grant.clone()),
        )
        .expect("reserve")
        .epoch
        .expect("epoch");
    service
        .runtime
        .apply_verified(
            Command::Commit {
                room_id: "conference".into(),
                epoch: reservation,
                room_instance_id: "instance".into(),
                presenter_names: Vec::new(),
                moderator: Default::default(),
                global_lobby: false,
            },
            Some(grant.clone()),
        )
        .expect("commit");
    let mut receivers = Vec::new();
    let mut bindings = Vec::new();
    for id in ["sender", "receiver"] {
        let reply = service
            .runtime
            .apply_verified(
                Command::Begin {
                    room_id: "conference".into(),
                    room_instance_id: "instance".into(),
                    peer_id: id.into(),
                    presenter: id == "sender",
                    username: id.into(),
                },
                Some(grant.clone()),
            )
            .expect("begin");
        let binding = Binding {
            room_id: "conference".into(),
            room_instance_id: "instance".into(),
            peer_id: id.into(),
            admission_epoch: reply.epoch.expect("epoch"),
        };
        if id == "sender" || !pending {
            service
                .runtime
                .apply_verified(
                    Command::Gate {
                        room_id: "conference".into(),
                        room_instance_id: "instance".into(),
                        peer_id: id.into(),
                        epoch: binding.admission_epoch,
                        uuid: id.into(),
                    },
                    None,
                )
                .expect("gate");
        }
        let (sink, receiver) = mpsc::channel(1);
        receivers.push(receiver);
        bindings.push(binding.clone());
        service.store.lock().expect("store").sessions.insert(
            id.into(),
            Session {
                stamp: SessionStamp {
                    room_instance_id: "instance".into(),
                    session_id: id.into(),
                    admission_epoch: 1,
                },
                binding,
                owner: [0; 32],
                recovery: [0; 32],
                actor: id.into(),
                name: id.into(),
                avatar: String::new(),
                events: if disconnected && id == "receiver" {
                    None
                } else {
                    Some(sink)
                },
                grace: None,
                revision: 0,
            },
        );
    }
    service.store.lock().expect("store").rooms.insert(
        "conference".into(),
        Room {
            binding: bindings[0].clone(),
            boot: "native-boot".into(),
            generation: 3,
            reservation,
            slug: "public-room".into(),
            renewal: crate::replacement::room_lease::Schedule::new(15, reservation),
            follow: None,
            music: None,
        },
    );
    (service, receivers, bindings.remove(0))
}

/// One retired native source cannot hide live pre-existing participants from a late joiner.
#[test]
fn producer_projection_skips_stale_sources_individually() {
    let (service, _receivers, sender_binding) = fixture(false, false);
    let sender = SessionStamp {
        room_instance_id: "instance".into(),
        session_id: "sender".into(),
        admission_epoch: 1,
    };
    let receiver_binding = service
        .store
        .lock()
        .expect("store")
        .sessions
        .get("receiver")
        .expect("receiver")
        .binding
        .clone();
    let stale_binding = Binding {
        peer_id: "retired".into(),
        ..sender_binding
    };
    service
        .store
        .lock()
        .expect("store")
        .rooms
        .get_mut("conference")
        .expect("room")
        .music = Some(crate::replacement::session::Music {
        producer_id: "live-music".into(),
        volume: 0.4,
    });
    let native = json!({"sources":[
        {"id":"retired-producer","kind":"audio","mediaType":"audioType","binding":stale_binding},
        {"id":"live-producer","kind":"video","mediaType":"videoType","binding":receiver_binding},
        {"id":"retired-music","kind":"audio","mediaType":"audioType","system":"music"},
        {"id":"live-music","kind":"audio","mediaType":"audioType","system":"music"}
    ]});

    let projected = crate::replacement::producer_state::producers(&service, &sender, native)
        .expect("projection");

    assert_eq!(projected.as_array().expect("sources").len(), 2);
    assert_eq!(projected[0]["producerId"], "live-producer");
    assert_eq!(projected[0]["participant"]["sessionId"], "receiver");
    assert_eq!(projected[1]["producerId"], "live-music");
    assert_eq!(projected[1]["participant"]["sessionId"], "bodrik-music");
}

/// Room policy mutations use Runtime authority and publish revisioned retained events.
#[test]
fn replacement_room_policy_and_role_cases() {
    let (service, mut receivers, _) = fixture(false, false);
    let sender = SessionStamp {
        room_instance_id: "instance".into(),
        session_id: "sender".into(),
        admission_epoch: 1,
    };
    let receiver = SessionStamp {
        room_instance_id: "instance".into(),
        session_id: "receiver".into(),
        admission_epoch: 1,
    };
    let policy = crate::replacement::moderation::room_action(
        &service,
        &sender,
        RoomAction::Lobby { status: true },
    )
    .expect("room action");
    assert_eq!(policy["config"]["isLobbyEnabled"], true);
    assert_eq!(
        receivers[0].try_recv().expect("sender event")["kind"],
        "roomAction"
    );
    assert_eq!(
        receivers[1].try_recv().expect("receiver event")["kind"],
        "roomAction"
    );
    let role =
        crate::replacement::moderation::role(&service, &sender, &receiver, true).expect("role");
    assert_eq!(role["presenter"], true);
}

/// Lobby approval and peer moderation require exact current target stamps.
#[tokio::test]
async fn replacement_lobby_and_peer_action_cases() {
    let (service, mut receivers, _) = fixture(true, false);
    let sender = SessionStamp {
        room_instance_id: "instance".into(),
        session_id: "sender".into(),
        admission_epoch: 1,
    };
    let receiver = SessionStamp {
        room_instance_id: "instance".into(),
        session_id: "receiver".into(),
        admission_epoch: 1,
    };
    let receiver_binding = service
        .store
        .lock()
        .expect("store")
        .sessions
        .get("receiver")
        .expect("receiver")
        .binding
        .clone();
    service
        .runtime
        .apply_verified(
            Command::Phase {
                room_id: receiver_binding.room_id,
                room_instance_id: receiver_binding.room_instance_id,
                peer_id: receiver_binding.peer_id,
                epoch: receiver_binding.admission_epoch,
                phase: crate::runtime::AdmissionPhase::Lobby,
            },
            None,
        )
        .expect("lobby phase");
    crate::replacement::moderation::announce_lobby(&service, &receiver).expect("announce lobby");
    let waiting = receivers[0].try_recv().expect("waiting event");
    assert_eq!(waiting["kind"], "roomLobby");
    assert_eq!(waiting["value"]["stamp"]["sessionId"], "receiver");
    let approved =
        crate::replacement::moderation::lobby(&service, &sender, vec![receiver.clone()], true)
            .await
            .expect("approve");
    assert_eq!(approved["count"], 1);
    let accepted = receivers[1].try_recv().expect("lobby event");
    assert_eq!(accepted["kind"], "roomLobby");
    assert_eq!(accepted["value"]["peer_id"], "receiver");
    assert_eq!(accepted["value"]["peers_id"], json!(["receiver"]));
    assert!(accepted["value"]["snapshot"].is_object());
    let relayed = crate::replacement::moderation::peer_action(
        &service,
        &sender,
        vec![receiver],
        PeerAction::Mute,
        None,
    )
    .await
    .expect("peer action");
    assert_eq!(relayed["count"], 1);
}

/// Construct an authenticated close observation; native stream sequence validation is tested upstream.
fn event(binding: &Binding, kind: &str) -> Event {
    Event {
        boot_id: "native-boot".into(),
        sequence: 1,
        kind: kind.into(),
        payload: json!({"binding":binding,"resourceId":"resource-one"}),
    }
}

/// Construct a normalized speaker observation without public identity or provider handles.
fn speaker_event(binding: &Binding, kind: &str, level: Option<u8>) -> Event {
    Event {
        boot_id: "native-boot".into(),
        sequence: 1,
        kind: kind.into(),
        payload: level.map_or_else(
            || json!({"binding":binding}),
            |level| json!({"binding":binding,"level":level}),
        ),
    }
}

/// Resource ownership, phase and socket liveness determine recipients; private authority never escapes.
#[test]
fn recipient_cases() {
    for (name, kind, pending, disconnected, receiver_expected) in [
        ("producer shared", "producerClosed", false, false, true),
        ("transport private", "transportClosed", false, false, false),
        ("consumer private", "consumerClosed", false, false, false),
        ("pending excluded", "producerClosed", true, false, false),
        (
            "disconnected excluded",
            "producerClosed",
            false,
            true,
            false,
        ),
    ] {
        let (service, mut receivers, binding) = fixture(pending, disconnected);
        assert!(
            deliver(&service, event(&binding, kind))
                .expect(name)
                .is_empty()
        );
        let sender = receivers[0].try_recv().expect("owner observation");
        assert_eq!(sender["revision"], 1, "{name}");
        assert_eq!(sender["stamp"]["sessionId"], "sender", "{name}");
        let encoded = sender.to_string();
        for secret in [
            "native-boot",
            "conference",
            "recoveryToken",
            "actorId",
            "binding",
        ] {
            assert!(!encoded.contains(secret), "{name}: {secret}");
        }
        assert_eq!(receivers[1].try_recv().is_ok(), receiver_expected, "{name}");
    }
}

/// Speaker events expose only public owner stamps and normalized levels to admitted peers.
#[test]
fn speaker_recipient_and_schema_cases() {
    for (name, kind, level, pending, disconnected, receiver_expected) in [
        ("volume shared", "audioVolume", Some(3), false, false, true),
        (
            "dominant shared",
            "dominantSpeaker",
            None,
            false,
            false,
            true,
        ),
        (
            "pending excluded",
            "audioVolume",
            Some(10),
            true,
            false,
            false,
        ),
        (
            "disconnected excluded",
            "dominantSpeaker",
            None,
            false,
            true,
            false,
        ),
    ] {
        let (service, mut receivers, binding) = fixture(pending, disconnected);
        assert!(
            deliver(&service, speaker_event(&binding, kind, level))
                .expect(name)
                .is_empty()
        );
        let sender = receivers[0].try_recv().expect("owner speaker event");
        assert_eq!(sender["kind"], kind, "{name}");
        assert_eq!(sender["value"]["owner"]["sessionId"], "sender", "{name}");
        assert_eq!(
            sender["value"]
                .get("level")
                .and_then(serde_json::Value::as_u64),
            level.map(u64::from),
            "{name}"
        );
        let encoded = sender.to_string();
        for private in [
            "native-boot",
            "conference",
            "binding",
            "producerId",
            "peerId",
        ] {
            assert!(!encoded.contains(private), "{name}: {private}");
        }
        assert_eq!(receivers[1].try_recv().is_ok(), receiver_expected, "{name}");
    }
}

/// Foreign native incarnations cannot target a current public connection.
#[test]
fn stale_binding_cases() {
    for name in ["boot", "room", "epoch", "peer"] {
        let (service, mut receivers, mut binding) = fixture(false, false);
        match name {
            "room" => binding.room_instance_id = "foreign".into(),
            "epoch" => binding.admission_epoch += 1,
            "peer" => binding.peer_id = "foreign".into(),
            _ => {}
        }
        let mut observation = event(&binding, "producerClosed");
        if name == "boot" {
            observation.boot_id = "foreign".into();
        }
        assert!(deliver(&service, observation).expect(name).is_empty());
        assert!(
            receivers
                .iter_mut()
                .all(|receiver| receiver.try_recv().is_err()),
            "{name}"
        );
    }
}

/// Invalid observations and death request fail-closed reconciliation instead of silent fallback.
#[test]
fn malformed_observation_cases() {
    for name in [
        "unknown field",
        "invalid resource",
        "invalid binding",
        "death",
        "unknown kind",
        "draining",
        "invalid volume low",
        "invalid volume high",
        "speaker extra field",
    ] {
        let (service, _, binding) = fixture(false, false);
        let mut observation = event(&binding, "producerClosed");
        match name {
            "unknown field" => observation.payload["secret"] = json!("foreign"),
            "invalid resource" => observation.payload["resourceId"] = json!("bad/id"),
            "invalid binding" => observation.payload["binding"]["admissionEpoch"] = json!(0),
            "death" => observation.kind = "workerDied".into(),
            "unknown kind" => observation.kind = "foreign".into(),
            "draining" => service.draining.store(true, Ordering::Release),
            "invalid volume low" => observation = speaker_event(&binding, "audioVolume", Some(1)),
            "invalid volume high" => observation = speaker_event(&binding, "audioVolume", Some(11)),
            "speaker extra field" => {
                observation = speaker_event(&binding, "dominantSpeaker", None);
                observation.payload["producerId"] = json!("private-native-handle");
            }
            _ => unreachable!(),
        }
        assert!(deliver(&service, observation).is_err(), "{name}");
    }
}

/// One owned cleanup scan selects only disconnected, expired current stamps.
#[test]
fn grace_selection_cases() {
    for (name, connected, grace, expected) in [
        ("connected", true, Some(-1_i32), false),
        ("not expired", false, Some(1), false),
        ("expired", false, Some(-1), true),
        ("recovered", true, None, false),
        ("no grace", false, None, false),
    ] {
        let (service, _, _) = fixture(false, false);
        let now = Instant::now();
        {
            let mut store = service.store.lock().expect("store");
            let recipient = store.sessions.get_mut("receiver").expect("receiver");
            if !connected {
                recipient.events = None;
            }
            recipient.grace = grace.map(|seconds| {
                if seconds < 0 {
                    now - Duration::from_secs(1)
                } else {
                    now + Duration::from_secs(1)
                }
            });
            if name == "recovered" {
                recipient.stamp.admission_epoch = 2;
            }
        }
        let stamps = expired(&service, now).expect(name);
        assert_eq!(stamps.len(), usize::from(expected), "{name}");
        if expected {
            assert_eq!(stamps[0].session_id, "receiver", "{name}");
        }
    }
}

/// Queue overflow identifies only exact slow sessions; other rooms are not evicted.
#[test]
fn backpressure_cases() {
    let (service, mut receivers, binding) = fixture(false, false);
    deliver(&service, event(&binding, "producerClosed")).expect("first");
    receivers[0].try_recv().expect("owner reads");
    let slow = deliver(&service, event(&binding, "producerClosed")).expect("second");
    assert_eq!(slow.len(), 1);
    assert_eq!(slow[0].session_id, "receiver");
    assert_eq!(
        receivers[0].try_recv().expect("owner continues")["revision"],
        2
    );
}
