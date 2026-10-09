//! Provider-neutral configured adapter operations; ordinary playback never invokes them.

#[cfg(test)]
use crate::api::mirotalk;

/// Configured conferencing provider hidden behind provider-neutral operations.
#[derive(Clone)]
pub struct Provider {
    /// Concrete configured adapter hidden from application consumers.
    adapter: Adapter,
}

/// Supported concrete adapters, not a speculative plugin registry.
#[derive(Clone)]
enum Adapter {
    /// Server-only MiroTalk credentials and endpoint configuration.
    #[cfg(test)]
    MiroTalk(mirotalk::Config),
    /// In-process public meeting library with private host authority.
    Embedded {
        /// Canonical public invitation origin.
        public_url: String,
        /// Exact current meeting lifetime capability.
        meeting: crate::meeting::Shared,
    },
}

impl Provider {
    /// Build the currently supported provider without exposing it to consumers.
    #[cfg(test)]
    pub fn mirotalk(config: mirotalk::Config) -> Self {
        Self {
            adapter: Adapter::MiroTalk(config),
        }
    }

    /// Configure direct meeting lifecycle without private HTTP endpoints or service credentials.
    pub(crate) fn embedded(public_url: String, meeting: crate::meeting::Shared) -> Self {
        Self {
            adapter: Adapter::Embedded {
                public_url,
                meeting,
            },
        }
    }

    /// Return the stable persistence key for this configured adapter.
    pub fn key(&self) -> &'static str {
        match &self.adapter {
            #[cfg(test)]
            Adapter::MiroTalk(_) => "mirotalk",
            Adapter::Embedded { .. } => "mirotalk",
        }
    }

    /// Return the readable public invitation for the room's current slug.
    pub fn invitation_url(&self, room_slug: &str) -> String {
        match &self.adapter {
            Adapter::Embedded { public_url, .. } => {
                format!("{}/room/{room_slug}", public_url.trim_end_matches('/'))
            }
            #[cfg(test)]
            Adapter::MiroTalk(config) => format!(
                "{}/room/{room_slug}",
                config.public_url.trim_end_matches('/')
            ),
        }
    }

    /// End active provider state and eject connected participants idempotently.
    ///
    /// # Errors
    /// Returns sanitized adapter configuration, request or provider status errors.
    pub async fn terminate(&self, conference_id: &str) -> Result<(), String> {
        match &self.adapter {
            #[cfg(test)]
            Adapter::MiroTalk(config) => mirotalk::end_conference(config, conference_id).await,
            Adapter::Embedded { meeting, .. } => meeting.terminate(conference_id).await,
        }
    }
}
