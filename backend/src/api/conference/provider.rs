//! Provider-neutral configured meeting operations; ordinary playback never invokes them.

/// Persisted provider key for every conference row and termination outbox entry.
///
/// The value predates the embedded meeting runtime (migration 0013 seeded it) and is
/// kept for compatibility; changing it requires a data migration.
const PROVIDER_KEY: &str = "mirotalk";

/// Configured in-process meeting lifecycle hidden behind provider-neutral operations.
#[derive(Clone)]
pub struct Provider {
    /// Canonical public invitation origin.
    public_url: String,
    /// Exact current meeting lifetime capability.
    meeting: crate::meeting::Shared,
}

impl Provider {
    /// Configure direct meeting lifecycle without private HTTP endpoints or service credentials.
    pub(crate) fn embedded(public_url: String, meeting: crate::meeting::Shared) -> Self {
        Self {
            public_url,
            meeting,
        }
    }

    /// Return the stable persistence key for this configured provider.
    pub fn key(&self) -> &'static str {
        PROVIDER_KEY
    }

    /// Return the readable public invitation for the room's current slug.
    pub fn invitation_url(&self, room_slug: &str) -> String {
        format!("{}/room/{room_slug}", self.public_url.trim_end_matches('/'))
    }

    /// End active meeting state and eject connected participants idempotently.
    ///
    /// # Errors
    /// Returns meeting unavailability or termination errors.
    pub async fn terminate(&self, conference_id: &str) -> Result<(), String> {
        self.meeting.terminate(conference_id).await
    }
}
