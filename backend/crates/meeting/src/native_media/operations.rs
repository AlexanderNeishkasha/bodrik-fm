//! Direct participant operations; cloned native handles never bypass owner fences.
use super::*;
use super::{
    lifecycle::{native_error, take_consumers},
    state::reject,
};
use crate::media::protocol::{Binding, ErrorCode, MediaType, Operation};
use serde_json::{Value, json};

impl Engine {
    /// Dispatch the existing application command vocabulary without changing browser DTOs.
    ///
    /// # Errors
    /// Ownership, capacity, parameter and provider failures are sanitized.
    pub(super) async fn operation(&self, b: &Binding, op: &Operation) -> Result<Reply, MediaError> {
        match op {
            Operation::CreateRoom(_) => return self.create_room(b).await.map(|()| Reply::Empty),
            Operation::CreatePeer(_) => return self.create_peer(b).map(|()| Reply::Empty),
            Operation::CloseRoom(_) => return self.close_room(b).map(|()| Reply::Empty),
            Operation::ClosePeer(_) => return self.close_peer(b).map(|()| Reply::Empty),
            Operation::CreateMusic { ssrc } => {
                return self.create_music(b, *ssrc).await.map(Reply::Music);
            }
            Operation::CloseMusic(_) => return self.close_music(b).map(|()| Reply::Empty),
            _ => self.current(b)?,
        }
        match op {
            Operation::Capabilities(_) => {
                let state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
                Ok(Reply::Browser(json!(
                    state
                        .room(b)?
                        .router
                        .as_ref()
                        .ok_or(MediaError::Transport)?
                        .rtp_capabilities()
                )))
            }
            Operation::Inventory(_) => {
                self.renew(b)?;
                let state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
                let p = state.peer(b)?;
                Ok(Reply::Browser(json!({
                    "transports":p.transports.iter().filter(|(_, t)| !t.closed()).map(|(id, _)| id).collect::<Vec<_>>(),
                    "producers":p.producers.iter().filter(|(_, (p, _))| !p.closed()).map(|(id, _)| id).collect::<Vec<_>>(),
                    "producerSources":p.producers.values().filter(|(p, _)| !p.closed())
                        .map(|(p, mt)| json!({"id":p.id(),"kind":p.kind(),"mediaType":mt})).collect::<Vec<_>>(),
                    "consumers":p.consumers.iter().filter(|(_, c)| !c.closed()).map(|(id, _)| id).collect::<Vec<_>>()
                })))
            }
            Operation::Sources(_) => {
                self.renew(b)?;
                self.sources(b).map(Reply::Browser)
            }
            Operation::CreateTransport(_) => self.create_transport(b).await.map(Reply::Browser),
            Operation::ConnectTransport {
                transport_id,
                dtls_parameters,
            } => {
                let t = self.transport(b, transport_id)?;
                let dtls_parameters = serde_json::from_value(dtls_parameters.clone())
                    .map_err(|_| reject(ErrorCode::InvalidRequest))?;
                t.connect(WebRtcTransportRemoteParameters { dtls_parameters })
                    .await
                    .map_err(native_error)?;
                self.current(b)?;
                drop(self.transport(b, transport_id)?);
                Ok(Reply::Empty)
            }
            Operation::RestartIce(reference) => {
                let t = self.transport(b, &reference.transport_id)?;
                let ice = t.restart_ice().await.map_err(native_error)?;
                self.current(b)?;
                drop(self.transport(b, &reference.transport_id)?);
                Ok(Reply::Browser(json!(ice)))
            }
            Operation::CloseTransport(reference) => self
                .close_transport(b, &reference.transport_id)
                .map(Reply::Browser),
            Operation::Produce {
                transport_id,
                kind,
                media_type,
                rtp_parameters,
            } => {
                let t = self.transport(b, transport_id)?;
                let _reservation = self.reserve(b, |p| p.producers.len())?;
                let kind = match kind {
                    crate::media::protocol::MediaKind::Audio => {
                        mediasoup::prelude::MediaKind::Audio
                    }
                    crate::media::protocol::MediaKind::Video => {
                        mediasoup::prelude::MediaKind::Video
                    }
                };
                let rtp = serde_json::from_value(rtp_parameters.clone())
                    .map_err(|_| reject(ErrorCode::InvalidRequest))?;
                let p = t
                    .produce(ProducerOptions::new(kind, rtp))
                    .await
                    .map_err(native_error)?;
                self.current(b)?;
                if t.closed() || p.closed() {
                    return Err(reject(ErrorCode::ResourceNotFound));
                }
                if p.kind() == mediasoup::prelude::MediaKind::Audio {
                    let (volume, speaker) = {
                        let state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
                        let room = state.room(b)?;
                        (
                            room.volume.clone().ok_or(MediaError::Transport)?,
                            room.speaker.clone().ok_or(MediaError::Transport)?,
                        )
                    };
                    volume
                        .add_producer(RtpObserverAddProducerOptions::new(p.id()))
                        .await
                        .map_err(native_error)?;
                    speaker
                        .add_producer(RtpObserverAddProducerOptions::new(p.id()))
                        .await
                        .map_err(native_error)?;
                }
                self.current(b)?;
                if t.closed() || p.closed() {
                    return Err(reject(ErrorCode::ResourceNotFound));
                }
                self.observe_producer(b, &p);
                let result = json!({"producerId":p.id()});
                self.core
                    .state
                    .lock()
                    .map_err(|_| MediaError::Transport)?
                    .peer_mut(b)?
                    .producers
                    .insert(p.id().to_string(), (p, media_type.clone()));
                Ok(Reply::Browser(result))
            }
            Operation::Consume {
                transport_id,
                producer_id,
                rtp_capabilities,
                media_type,
            } => self
                .consume(b, transport_id, producer_id, rtp_capabilities, media_type)
                .await
                .map(Reply::Browser),
            Operation::CloseProducer(reference) => self
                .close_producer(b, &reference.producer_id)
                .map(Reply::Browser),
            Operation::PauseProducer(reference) | Operation::ResumeProducer(reference) => {
                let p = self.producer(b, &reference.producer_id)?;
                if matches!(op, Operation::PauseProducer(_)) {
                    p.pause().await.map_err(native_error)?;
                } else {
                    p.resume().await.map_err(native_error)?;
                }
                self.current(b)?;
                drop(self.producer(b, &reference.producer_id)?);
                Ok(Reply::Empty)
            }
            Operation::PauseConsumer(reference) | Operation::ResumeConsumer(reference) => {
                let c = {
                    let state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
                    state
                        .peer(b)?
                        .consumers
                        .get(&reference.consumer_id)
                        .filter(|c| !c.closed())
                        .cloned()
                        .ok_or_else(|| reject(ErrorCode::ResourceNotFound))?
                };
                if matches!(op, Operation::PauseConsumer(_)) {
                    c.pause().await.map_err(native_error)?;
                } else {
                    c.resume().await.map_err(native_error)?;
                }
                self.current(b)?;
                if c.closed() {
                    return Err(reject(ErrorCode::ResourceNotFound));
                }
                Ok(Reply::Empty)
            }
            _ => Err(MediaError::InvalidCommand),
        }
    }

    /// Clone only a live participant-owned WebRTC transport.
    ///
    /// # Errors
    /// Foreign/stale/closed handles are unavailable.
    fn transport(&self, b: &Binding, id: &str) -> Result<WebRtcTransport, MediaError> {
        let state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
        state
            .peer(b)?
            .transports
            .get(id)
            .filter(|t| !t.closed())
            .cloned()
            .ok_or_else(|| reject(ErrorCode::ResourceNotFound))
    }

    /// Clone only a live participant-owned producer.
    ///
    /// # Errors
    /// Foreign/stale/closed producers are unavailable.
    fn producer(&self, b: &Binding, id: &str) -> Result<Producer, MediaError> {
        let state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
        state
            .peer(b)?
            .producers
            .get(id)
            .filter(|(p, _)| !p.closed())
            .map(|(p, _)| p.clone())
            .ok_or_else(|| reject(ErrorCode::ResourceNotFound))
    }

    /// Discover current same-room sources with exact native ownership and paused state.
    ///
    /// # Errors
    /// Missing/replaced ownership fails closed.
    fn sources(&self, b: &Binding) -> Result<Value, MediaError> {
        let state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
        state.peer(b)?;
        let room = state.room(b)?;
        let mut sources = Vec::new();
        if let Some((_, p)) = &room.music
            && !p.closed()
        {
            sources
                .push(json!({"id":p.id(),"kind":"audio","mediaType":"audioType","system":"music"}));
        }
        for (id, peer) in &room.peers {
            for (p, mt) in peer.producers.values().filter(|(p, _)| !p.closed()) {
                sources.push(json!({"id":p.id(),"kind":p.kind(),"mediaType":mt,"paused":p.paused(),
                    "binding":{"roomId":b.room_id,"roomInstanceId":b.room_instance_id,"peerId":id,"admissionEpoch":peer.epoch}}));
            }
        }
        Ok(json!({"sources":sources}))
    }

    /// Allocate a transport with protocol-compatible ICE/DTLS JSON.
    ///
    /// # Errors
    /// Capacity, stale continuation or provider failure rejects allocation.
    async fn create_transport(&self, b: &Binding) -> Result<Value, MediaError> {
        let router = {
            let state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            state.room(b)?.router.clone().ok_or(MediaError::Transport)?
        };
        let _reservation = self.reserve(b, |p| p.transports.len())?;
        {
            let state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            tracing::debug!(
                rooms = state.rooms.len(),
                peers = state.room(b)?.peers.len(),
                transports = state.peer(b)?.transports.len(),
                "native transport allocation"
            );
        }
        let listen = WebRtcTransportListenInfos::new(self.core.network.listen(Protocol::Udp, true))
            .insert(self.core.network.listen(Protocol::Tcp, true));
        let mut options = WebRtcTransportOptions::new(listen);
        options.enable_tcp = true;
        options.prefer_udp = true;
        let t = router
            .create_webrtc_transport(options)
            .await
            .map_err(native_error)?;
        self.current(b)?;
        if t.closed() {
            return Err(reject(ErrorCode::ResourceNotFound));
        }
        let result = json!({"id":t.id(),"iceParameters":t.ice_parameters(),
            "iceCandidates":t.ice_candidates(),"dtlsParameters":t.dtls_parameters()});
        let weak = Arc::downgrade(&self.core);
        let binding = b.clone();
        let id = t.id().to_string();
        t.on_close(Box::new(move || {
            if let Some(core) = weak.upgrade() {
                core.publish(
                    "transportClosed",
                    json!({"binding":binding,"resourceId":id}),
                );
            }
        }))
        .detach();
        self.core
            .state
            .lock()
            .map_err(|_| MediaError::Transport)?
            .peer_mut(b)?
            .transports
            .insert(t.id().to_string(), t);
        Ok(result)
    }

    /// Create a paused consumer only for a matching source in the same room.
    ///
    /// # Errors
    /// Rejects foreign/missing sources, mismatched categories and incompatible capabilities.
    async fn consume(
        &self,
        b: &Binding,
        transport: &str,
        producer: &str,
        capabilities: &Value,
        mt: &MediaType,
    ) -> Result<Value, MediaError> {
        let t = self.transport(b, transport)?;
        let (router, p) = {
            let state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            let room = state.room(b)?;
            let p = room
                .music
                .as_ref()
                .filter(|(_, p)| p.id().to_string() == producer && !p.closed())
                .map(|(_, p)| (p.clone(), MediaType::Audio))
                .or_else(|| {
                    room.peers
                        .values()
                        .flat_map(|p| p.producers.values())
                        .find(|(p, _)| p.id().to_string() == producer && !p.closed())
                        .cloned()
                })
                .ok_or_else(|| reject(ErrorCode::ProducerNotFound))?;
            if json!(p.1) != json!(mt) {
                return Err(reject(ErrorCode::InvalidRequest));
            }
            (room.router.clone().ok_or(MediaError::Transport)?, p.0)
        };
        let capabilities = serde_json::from_value(capabilities.clone())
            .map_err(|_| reject(ErrorCode::InvalidRequest))?;
        if !router.can_consume(&p.id(), &capabilities) {
            return Err(reject(ErrorCode::InvalidRequest));
        }
        let _reservation = self.reserve(b, |p| p.consumers.len())?;
        let mut options = ConsumerOptions::new(p.id(), capabilities);
        options.paused = true;
        let c = t.consume(options).await.map_err(|e| {
            if p.closed() {
                reject(ErrorCode::ProducerNotFound)
            } else {
                native_error(e)
            }
        })?;
        self.current(b)?;
        if p.closed() {
            return Err(reject(ErrorCode::ProducerNotFound));
        }
        if c.closed() || t.closed() {
            return Err(reject(ErrorCode::ResourceNotFound));
        }
        let result = json!({"id":c.id(),"producerId":p.id(),"kind":c.kind(),"rtpParameters":c.rtp_parameters(),
            "type":c.r#type(),"producerPaused":c.producer_paused()});
        let weak = Arc::downgrade(&self.core);
        let binding = b.clone();
        let id = c.id().to_string();
        c.on_close(move || {
            if let Some(core) = weak.upgrade() {
                core.publish("consumerClosed", json!({"binding":binding,"resourceId":id}));
            }
        })
        .detach();
        self.core
            .state
            .lock()
            .map_err(|_| MediaError::Transport)?
            .peer_mut(b)?
            .consumers
            .insert(c.id().to_string(), c);
        Ok(result)
    }

    /// Observe native producer closure without retaining a strong registry reference.
    fn observe_producer(&self, b: &Binding, p: &Producer) {
        let weak = Arc::downgrade(&self.core);
        let binding = b.clone();
        let id = p.id().to_string();
        p.on_close(move || {
            if let Some(core) = weak.upgrade() {
                core.publish("producerClosed", json!({"binding":binding,"resourceId":id}));
            }
        })
        .detach();
    }

    /// Remove transport descendants synchronously before dropping their owners.
    ///
    /// # Errors
    /// Stale participant ownership fails closed.
    fn close_transport(&self, b: &Binding, id: &str) -> Result<Value, MediaError> {
        let (transport, producers, consumers, dependent) = {
            let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            let peer = state.peer_mut(b)?;
            let transport = peer.transports.remove(id);
            let producer_ids = peer
                .producers
                .iter()
                .filter(|(_, (p, _))| p.transport().id().to_string() == id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let consumer_ids = peer
                .consumers
                .iter()
                .filter(|(_, c)| c.transport().id().to_string() == id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let producers = producer_ids
                .iter()
                .filter_map(|id| peer.producers.remove(id))
                .collect::<Vec<_>>();
            let consumers = consumer_ids
                .iter()
                .filter_map(|id| peer.consumers.remove(id))
                .collect::<Vec<_>>();
            let dependent = take_consumers(
                state
                    .rooms
                    .get_mut(&b.room_id)
                    .ok_or(MediaError::Transport)?,
                &producer_ids,
            );
            (transport, producers, consumers, dependent)
        };
        drop(dependent);
        drop(consumers);
        drop(producers);
        drop(transport);
        Ok(json!({}))
    }

    /// Remove one owned producer and dependent consumers, idempotently within its owner.
    ///
    /// # Errors
    /// Stale ownership is rejected before any handle removal.
    fn close_producer(&self, b: &Binding, id: &str) -> Result<Value, MediaError> {
        let (producer, consumers) = {
            let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            let producer = state.peer_mut(b)?.producers.remove(id);
            let consumers = if producer.is_some() {
                take_consumers(
                    state
                        .rooms
                        .get_mut(&b.room_id)
                        .ok_or(MediaError::Transport)?,
                    &[id.into()],
                )
            } else {
                Vec::new()
            };
            (producer, consumers)
        };
        drop(consumers);
        drop(producer);
        Ok(json!({}))
    }
}
