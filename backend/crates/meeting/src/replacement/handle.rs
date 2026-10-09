//! Host-owned lifecycle capability; it never accepts public browser credentials.
use super::{Service, session};
use axum::Router;

/// Cloneable capability for exactly one meeting incarnation, independent of the listener.
#[derive(Clone)]
pub struct Handle {
    /// Exact domain and media owner; callers release this handle before restarting.
    pub(super) service: Service,
}

impl Handle {
    /// Whether this incarnation accepts admission and has a contiguous media baseline.
    pub fn ready(&self) -> bool {
        super::available(&self.service)
    }

    /// Fresh ticket scope identity; unavailable incarnations cannot issue new tickets.
    pub fn incarnation(&self) -> Option<(String, String, String)> {
        self.ready().then(|| {
            (
                self.service.config.instance.clone(),
                self.service.config.issuer.clone(),
                self.service.config.audience.clone(),
            )
        })
    }

    /// Public browser routes only; host health and private service routes remain separate.
    pub fn router(&self) -> Router {
        super::browser_routes().with_state(self.service.clone())
    }

    /// Retire an exact private mapping idempotently after durable host revocation.
    ///
    /// # Errors
    /// Rejects invalid mappings, unavailable observations or a poisoned registry.
    pub async fn terminate(&self, id: &str) -> Result<(), String> {
        if !crate::media::protocol::identifier(id) {
            return Err("invalid conference binding".into());
        }
        if !self.ready() {
            return Err("meeting unavailable".into());
        }
        let _lifecycle = self.service.lifecycle.lock().await;
        let room = self
            .service
            .store
            .lock()
            .map_err(|_| "meeting registry poisoned")?
            .rooms
            .get(id)
            .cloned();
        if let Some(room) = room {
            session::retire(&self.service, &room).await;
        }
        Ok(())
    }
}
