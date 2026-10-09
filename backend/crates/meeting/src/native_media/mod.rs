//! In-process mediasoup engine; authorization remains in the meeting application.
mod cleanup;
mod client;
mod config;
pub use client::Client;
mod events;
#[cfg(test)]
pub(crate) mod fixture;
mod jobs;
mod lifecycle;
mod operations;
mod result;
pub use result::{MusicDestination, Reply};
mod state;
#[cfg(test)]
mod tests;
pub use config::Network;
pub use events::NativeEventStream;

use crate::media::{
    MediaError,
    protocol::{Command, Metadata},
};
use mediasoup::prelude::*;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use uuid::Uuid;

/// Cloneable direct media engine with a single authoritative resource registry.
#[derive(Clone)]
pub struct Engine {
    /// Shared worker, native registry and ordered event publication.
    pub(super) core: Arc<Core>,
}

/// Owned native process resources; callbacks capture weak references to avoid cycles.
pub(super) struct Core {
    /// Native worker; dropped after room resources during final teardown.
    worker: Worker,
    /// Validated socket settings.
    network: Network,
    /// Fresh identity fences all handles after process restart.
    boot: String,
    /// Resource state; never held across native awaits or callback-triggering drops.
    state: Mutex<state::State>,
    /// Ordered event bus; lag forces application reconciliation.
    events: broadcast::Sender<crate::media::Event>,
    /// Serialize sequence assignment with publication.
    sequence: Mutex<u64>,
    /// Owned orphan expiry task; weak captures cannot retain native workers.
    cleanup: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Bounded command concurrency, including caller-cancelled allocations.
    requests: Arc<tokio::sync::Semaphore>,
    /// Bounded native requests awaiting an active command slot.
    pending: Arc<tokio::sync::Semaphore>,
    /// Owned native command abort handles used only during service shutdown.
    jobs: Mutex<std::collections::HashMap<Uuid, tokio::task::AbortHandle>>,
}

impl Engine {
    /// Start one native worker and retain failure observation for its entire lifetime.
    ///
    /// # Errors
    /// Native worker initialization failure prevents meeting readiness.
    pub async fn start(network: Network) -> Result<Self, MediaError> {
        let mut settings = WorkerSettings::default();
        settings.log_level = mediasoup::worker::WorkerLogLevel::Error;
        let worker = WorkerManager::new()
            .create_worker(settings)
            .await
            .map_err(|error| {
                tracing::error!(%error, "native worker startup failed");
                MediaError::Transport
            })?;
        let (events, _) = broadcast::channel(1024);
        let core = Arc::new(Core {
            worker,
            network,
            boot: Uuid::new_v4().to_string(),
            state: Mutex::new(state::State::default()),
            events,
            sequence: Mutex::new(0),
            cleanup: Mutex::new(None),
            requests: Arc::new(tokio::sync::Semaphore::new(8)),
            pending: Arc::new(tokio::sync::Semaphore::new(128)),
            jobs: Mutex::new(std::collections::HashMap::new()),
        });
        let weak = Arc::downgrade(&core);
        core.worker
            .on_dead(move |result| {
                if let Some(core) = weak.upgrade() {
                    tracing::error!(
                        ?result,
                        "native worker exited; meeting media unavailable until restart"
                    );
                    core.publish("workerDied", serde_json::json!({}));
                }
            })
            .detach();
        let weak = Arc::downgrade(&core);
        let task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let Some(core) = weak.upgrade() else {
                    return;
                };
                core.expire();
            }
        });
        *core.cleanup.lock().map_err(|_| MediaError::Transport)? = Some(task);
        Ok(Self { core })
    }

    /// Read current worker incarnation only while native media is available.
    ///
    /// # Errors
    /// A dead worker or poisoned registry fails closed.
    pub async fn metadata(&self) -> Result<Metadata, MediaError> {
        if self.core.worker.closed()
            || self
                .core
                .state
                .lock()
                .map_err(|_| MediaError::Transport)?
                .stopped
        {
            return Err(MediaError::Transport);
        }
        Ok(Metadata {
            boot_id: self.core.boot.clone(),
        })
    }

    /// Execute a server-issued command directly without an HTTP credential boundary.
    ///
    /// # Errors
    /// Rejects stale/invalid commands, unavailable workers and native allocation failures.
    pub async fn execute(&self, command: &Command) -> Result<Reply, MediaError> {
        if !command.binding.is_valid() || !command.operation.is_bounded() {
            return Err(MediaError::InvalidCommand);
        }
        if command.boot_id != self.core.boot {
            return Err(state::reject(crate::media::protocol::ErrorCode::StaleBoot));
        }
        if std::time::Instant::now() >= command.deadline {
            return Err(state::reject(
                crate::media::protocol::ErrorCode::RequestExpired,
            ));
        }
        self.metadata().await?;
        self.owned(&command.binding, &command.operation, command.deadline)
            .await
    }

    /// Renew an exact resource owner without allocating or changing application membership.
    ///
    /// # Errors
    /// Invalid operation or stale owner fails closed.
    pub async fn renew_resources(&self, command: &Command) -> Result<Reply, MediaError> {
        if !matches!(
            command.operation,
            crate::media::protocol::Operation::Inventory(_)
        ) {
            return Err(MediaError::InvalidCommand);
        }
        self.execute(command).await
    }

    /// Drop all resource owners after application supervisors stop.
    ///
    /// # Errors
    /// Poisoned registry cannot be safely claimed as a successful drain.
    pub fn shutdown(&self) -> Result<(), MediaError> {
        let rooms = {
            let mut state = self.core.state.lock().map_err(|_| MediaError::Transport)?;
            state.stopped = true;
            std::mem::take(&mut state.rooms)
        };
        drop(rooms);
        let jobs = std::mem::take(&mut *self.core.jobs.lock().map_err(|_| MediaError::Transport)?);
        for job in jobs.into_values() {
            job.abort();
        }
        Ok(())
    }
}
