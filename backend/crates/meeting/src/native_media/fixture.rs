//! Direct failure fixture for application continuity tests; never included in production.
use super::NativeEventStream;
use crate::media::{
    Event, MediaError,
    protocol::{Command, Metadata, Operation},
};
use tokio::sync::{broadcast, mpsc};

/// Synthetic command sink and finite event history for exact-owner drain assertions.
#[derive(Clone)]
pub(crate) struct Fixture {
    /// Observations queued after the ready baseline.
    pub(crate) events: Vec<Event>,
    /// Cleanup commands emitted by the application.
    pub(crate) closed: mpsc::Sender<Command>,
}

impl Fixture {
    /// Keep the failed fixture unavailable during supervisor reconnect attempts.
    ///
    /// # Errors
    /// Always reports continuity loss after the synthetic subscription.
    pub(crate) async fn metadata(&self) -> Result<Metadata, MediaError> {
        Err(MediaError::ReconcileRequired)
    }

    /// Record the exact room owner being retired, without a transport envelope.
    ///
    /// # Errors
    /// Unexpected operations or a dropped assertion receiver reject cleanup.
    pub(crate) async fn execute(&self, command: &Command) -> Result<super::Reply, MediaError> {
        if !matches!(command.operation, Operation::CloseRoom(_)) {
            return Err(MediaError::InvalidCommand);
        }
        self.closed
            .send(command.clone())
            .await
            .map_err(|_| MediaError::Transport)?;
        Ok(super::Reply::Empty)
    }

    /// Reject renewals of synthetic retired owners.
    ///
    /// # Errors
    /// Always rejects renewal; the fixture never represents live resources.
    pub(crate) async fn renew_resources(&self, _: &Command) -> Result<super::Reply, MediaError> {
        Err(MediaError::ReconcileRequired)
    }

    /// Build the same bounded direct subscription used by the real engine.
    ///
    /// # Errors
    /// A mismatched worker incarnation rejects subscription.
    pub(crate) fn events(&self, boot: &str) -> Result<NativeEventStream, MediaError> {
        if boot != "native-boot" {
            return Err(MediaError::ReconcileRequired);
        }
        let (sender, receiver) = broadcast::channel(self.events.len().max(1));
        let stream = NativeEventStream::new(boot.into(), 0, receiver);
        for event in &self.events {
            let _ = sender.send(event.clone());
        }
        Ok(stream)
    }
}
