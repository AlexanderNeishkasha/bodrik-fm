//! Origin-gated bounded WebSockets; native/service credentials never enter the public wire.
use super::{
    Service, admission, chat, diagnostics, file, moderation, native, participant, persistent_chat,
    producer_state, recovery, session,
    wire::{Action, FRAME_LIMIT, Outbound, Request},
};
use crate::signaling::{Hello, SessionStamp};
use axum::{
    extract::{
        OriginalUri, Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, mpsc};

/// Reject foreign/missing origins and exhausted connection capacity before upgrading.
pub(super) async fn upgrade(
    State(service): State<Service>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    ws: WebSocketUpgrade,
) -> Response {
    if !super::available(&service) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if uri.query().is_some() || headers.contains_key(header::SEC_WEBSOCKET_PROTOCOL) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if !crate::media::protocol::identifier(&slug)
        || !headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|origin| {
                service
                    .config
                    .origins
                    .iter()
                    .any(|allowed| allowed == origin)
            })
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(permit) = service.sockets.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    ws.max_message_size(FRAME_LIMIT)
        .max_frame_size(FRAME_LIMIT)
        .on_upgrade(move |socket| run(service, slug, socket, permit))
}

/// Require authentication within eight seconds, then hold exactly one owning connection loop.
async fn run(service: Service, slug: String, mut socket: WebSocket, _permit: OwnedSemaphorePermit) {
    let first = tokio::time::timeout(Duration::from_secs(8), socket.recv()).await;
    let Ok(Some(Ok(Message::Text(first)))) = first else {
        return;
    };
    let hello = match Hello::parse(first.as_bytes()) {
        Ok(hello) => hello,
        Err(_) => {
            let _ = send_json(
                &mut socket,
                json!({"type":"error","version":1,"code":"invalid"}),
            )
            .await;
            return;
        }
    };
    let (events, receiver) = mpsc::channel(32);
    let hello_kind = match hello {
        Hello::Admit { .. } => HelloKind::Admit,
        Hello::Resume { .. } => HelloKind::Resume,
    };
    let result = match hello {
        Hello::Admit { .. } => admission::admit(&service, &slug, hello, events).await,
        Hello::Resume { .. } => recovery::resume(&service, &slug, hello, events).await,
    };
    let welcome = match result {
        Ok(welcome) => welcome,
        Err(_) => {
            let _ = send_json(
                &mut socket,
                json!({"type":"error","version":1,"code":"denied"}),
            )
            .await;
            return;
        }
    };
    let admitted = matches!(hello_kind, HelloKind::Admit) && welcome.frame["phase"] == "admitted";
    if send_json(&mut socket, welcome.frame).await.is_err() {
        session::leave(&service, &welcome.stamp).await;
        return;
    }
    // Takeover cleanup runs here, after admission released the lifecycle lock that
    // `session::leave` needs; earlier sessions of the same actor end now.
    if admitted {
        super::moderation::replace_sessions(&service, &welcome.stamp).await;
    }
    connected(&service, &welcome.stamp, &mut socket, receiver).await;
    recovery::disconnect(&service, &welcome.stamp);
}

/// Send one final frame, then a close frame, each bounded by the slow-recipient deadline.
async fn close_with(socket: &mut WebSocket, frame: Value) {
    let _ = send_json(socket, frame).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Close(None))).await;
}

/// After the session ended, deliver a final frame (kick, ban, takeover) that is queued
/// behind ordinary events, which can no longer be delivered; then close.
async fn send_final(socket: &mut WebSocket, events: &mut mpsc::Receiver<Outbound>) {
    while let Ok(event) = events.try_recv() {
        if let Outbound::Final(frame) = event {
            close_with(socket, frame).await;
            return;
        }
    }
}

/// Which hello opened the socket; only a fresh admission can take over earlier sessions.
#[derive(Clone, Copy)]
enum HelloKind {
    /// Ticket admission of a new session.
    Admit,
    /// Recovery of the same session.
    Resume,
}

/// Serialize bounded output with a two-second slow-recipient deadline.
///
/// # Errors
/// Rejects oversized serialization, socket failure or output backpressure timeout.
async fn send_json(socket: &mut WebSocket, frame: Value) -> Result<(), &'static str> {
    let text = serde_json::to_string(&frame).map_err(|_| "invalid")?;
    if text.len() > FRAME_LIMIT {
        return Err("capacity");
    }
    tokio::time::timeout(
        Duration::from_secs(2),
        socket.send(Message::Text(text.into())),
    )
    .await
    .map_err(|_| "slow recipient")?
    .map_err(|_| "disconnected")
}

/// Drive one socket with bounded request rate, strict sequence, duplicate readback and periodic entitlement.
async fn connected(
    service: &Service,
    stamp: &SessionStamp,
    socket: &mut WebSocket,
    mut events: mpsc::Receiver<Outbound>,
) {
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut seen = Instant::now();
    let mut window = Instant::now();
    let mut count = 0_u32;
    let mut bytes = 0_usize;
    let mut last: Option<(u64, [u8; 32], Value)> = None;
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if seen.elapsed() >= Duration::from_secs(15) || session::heartbeat(service, stamp).await.is_err() {
                    session::leave(service, stamp).await;
                    return;
                }
                match tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Ping(Vec::new().into()))).await { Ok(Ok(())) => {}, _ => return }
            }
            event = events.recv() => {
                let Some(event) = event else { return; };
                match event {
                    Outbound::Json(event) => {
                        if session::renew(service, stamp).await.is_err() {
                            session::leave(service, stamp).await;
                            send_final(socket, &mut events).await;
                            return;
                        }
                        if send_json(socket, event).await.is_err() { return; }
                    }
                    Outbound::Final(event) => {
                        close_with(socket, event).await;
                        return;
                    }
                    Outbound::Binary { transfer_id, recipient, bytes } => {
                        file::released(service, transfer_id, &recipient);
                        if tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Binary(bytes.into()))).await.map_or(true, |result| result.is_err()) { return; }
                    }
                }
            }
            frame = socket.recv() => {
                let Some(Ok(frame)) = frame else { return; };
                seen = Instant::now();
                let frame_bytes = match &frame {
                    Message::Text(text) => text.len(),
                    Message::Binary(payload) => payload.len(),
                    _ => 0,
                };
                if frame_bytes > 0 {
                    if window.elapsed() >= Duration::from_secs(1) { window = Instant::now(); count = 0; bytes = 0; }
                    count += 1;
                    bytes = bytes.saturating_add(frame_bytes);
                    if count > 32 || bytes > FRAME_LIMIT { session::leave(service, stamp).await; return; }
                }
                let text = match frame {
                    Message::Text(text) => text,
                    Message::Binary(payload) => {
                        if file::binary(service, stamp, payload.to_vec()).is_err() {
                            file::cancel_connected(service, stamp, "invalid");
                            return;
                        }
                        continue;
                    }
                    Message::Pong(_) => continue,
                    Message::Ping(payload) => {
                        match tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Pong(payload))).await { Ok(Ok(())) => continue, _ => return }
                    }
                    _ => return,
                };
                let hash: [u8; 32] = Sha256::digest(text.as_bytes()).into();
                let request = match tokio::task::spawn_blocking(move || serde_json::from_str::<Request>(&text)).await {
                    Ok(Ok(request)) => request,
                    Ok(Err(error)) => {
                        tracing::warn!(category = %error, "replacement command schema rejected");
                        let _ = send_json(socket, json!({"type":"error","version":1,"code":"invalid"})).await;
                        return;
                    }
                    Err(error) => {
                        tracing::warn!(category = %error, "replacement command parser task failed");
                        let _ = send_json(socket, json!({"type":"error","version":1,"code":"invalid"})).await;
                        return;
                    }
                };
                if request.r#type != "command" {
                    tracing::warn!(category = "frame_type", "replacement command envelope rejected");
                    return;
                }
                if request.version != 1 {
                    tracing::warn!(category = "version", "replacement command envelope rejected");
                    return;
                }
                if request.stamp != *stamp {
                    tracing::warn!(category = "stamp", "replacement command envelope rejected");
                    return;
                }
                if !stamp.is_valid() {
                    tracing::warn!(category = "invalid_session", "replacement command envelope rejected");
                    return;
                }
                if request.id == 0 || request.id > crate::media::protocol::JS_SAFE_INTEGER {
                    tracing::warn!(category = "request_id", request_id = request.id, "replacement command envelope rejected");
                    return;
                }
                if let Some((id, expected, cached)) = &last
                    && request.id == *id && hash == *expected {
                    if session::renew(service, stamp).await.is_err() { session::leave(service, stamp).await; return; }
                    if send_json(socket, cached.clone()).await.is_err() { return; }
                    continue;
                }
                let expected_id = last.as_ref().map_or(1, |(id, _, _)| id + 1);
                if request.id != expected_id {
                    tracing::warn!(
                        category = "sequence",
                        request_id = request.id,
                        expected_id,
                        "replacement command envelope rejected"
                    );
                    return;
                }
                let leave = matches!(request.action, Action::Leave {});
                let result = dispatch(service, stamp, request.action).await;
                let frame = match result {
                    Ok(value) => json!({"type":"result","version":1,"id":request.id,"stamp":stamp,"ok":true,"value":value}),
                    Err(code) => json!({"type":"result","version":1,"id":request.id,"stamp":stamp,"ok":false,"error":{"code":code}}),
                };
                last = Some((request.id, hash, frame.clone()));
                if send_json(socket, frame).await.is_err() || leave { return; }
            }
        }
    }
}

/// Execute only server-bound domain/media requests after fresh entitlement; no legacy fallback exists.
///
/// # Errors
/// Rejects stale/denied policy or unknown native outcomes, which require explicit inventory/readback.
async fn dispatch(
    service: &Service,
    stamp: &SessionStamp,
    action: Action,
) -> Result<Value, &'static str> {
    if matches!(action, Action::Leave {}) {
        session::leave(service, stamp).await;
        return Ok(json!({}));
    }
    session::renew(service, stamp).await?;
    match action {
        Action::IceConfig {} => super::turn::configuration(service, stamp),
        Action::Snapshot {} => session::snapshot(service, stamp),
        Action::Producers {} => {
            let (binding, room) = session::binding(service, stamp)?;
            let command = native::command(
                &room.boot,
                &binding,
                crate::media::protocol::Operation::Sources(Default::default()),
            );
            let sources = service
                .runtime
                .execute_media(
                    command,
                    &service.config.media,
                )
                .await
                .map_err(|error| {
                    tracing::warn!(category = ?error, "replacement producer source readback failed");
                    "unknown_outcome"
                })?;
            producer_state::producers(service, stamp, sources).inspect_err(|category| {
                tracing::warn!(category, "replacement producer projection failed");
            })
        }
        Action::Chat {
            target,
            message_id,
            text,
            attachment_id,
        } => match target {
            chat::Target::Public => {
                persistent_chat::append(service, stamp, message_id, text, attachment_id).await
            }
            target if attachment_id.is_none() => {
                chat::message(service, stamp, target, message_id, text).await
            }
            _ => Err("invalid"),
        },
        Action::ChatHistory { before } => persistent_chat::history(service, stamp, before).await,
        Action::ChatDelete { message_id } => {
            persistent_chat::delete(service, stamp, message_id).await
        }
        Action::ChatReaction {
            message_id,
            emoji,
            action,
        } => chat::reaction(service, stamp, message_id, emoji, action).await,
        Action::ParticipantProfile { change } => participant::profile(service, stamp, change).await,
        Action::ParticipantCount { broadcast } => {
            participant::count(service, stamp, broadcast).await
        }
        Action::FollowMe { action } => participant::follow(service, stamp, action).await,
        Action::RoomControl { action } => moderation::room_action(service, stamp, action),
        Action::Moderator { change } => moderation::moderator(service, stamp, change),
        Action::SetRole { target, presenter } => {
            moderation::role(service, stamp, &target, presenter)
        }
        Action::Lobby { targets, accepted } => {
            moderation::lobby(service, stamp, targets, accepted).await
        }
        Action::VideoOff {} => moderation::video_off(service, stamp),
        Action::PeerModeration {
            targets,
            action,
            message,
        } => moderation::peer_action(service, stamp, targets, action, message).await,
        Action::FileOffer { offer } => file::offer(service, stamp, offer),
        Action::FileCancel { cancel } => file::cancel(service, stamp, cancel),
        Action::Diagnostics { events } => diagnostics::submit(service, stamp, events),
        Action::Media { operation } => {
            let produced = match &operation {
                crate::media::protocol::Operation::Produce {
                    kind, media_type, ..
                } => Some((kind.clone(), media_type.clone())),
                _ => None,
            };
            let paused = match &operation {
                crate::media::protocol::Operation::PauseProducer(value) => {
                    Some((value.producer_id.clone(), true))
                }
                crate::media::protocol::Operation::ResumeProducer(value) => {
                    Some((value.producer_id.clone(), false))
                }
                _ => None,
            };
            let (binding, room) = session::binding(service, stamp)?;
            let command = native::command(&room.boot, &binding, operation);
            let result = service
                .runtime
                .execute_media(command, &service.config.media)
                .await
                .map_err(|_| "unknown_outcome")?;
            if let Some((kind, media_type)) = produced {
                producer_state::producer_created(service, stamp, &result, kind, media_type).await?;
            }
            // A `nativeError` (e.g. producer_not_found for a non-owned id) is not a state change.
            if let Some((producer_id, paused)) = paused
                && result.get("nativeError").is_none()
            {
                producer_state::paused_changed(service, stamp, &producer_id, paused).await?;
            }
            Ok(result)
        }
        Action::Leave {} => Err("invalid"),
    }
}
