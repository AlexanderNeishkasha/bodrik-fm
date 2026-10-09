//! Lazy direct engine startup; the application owns shutdown and event supervision.
use super::{Engine, MusicDestination, NativeEventStream, Network, Reply};
use crate::media::{
    MediaError,
    protocol::{Command, Metadata},
};
use std::sync::Arc;
use tokio::sync::OnceCell;

/// Direct native dependency; constructing configuration does not allocate native resources.
#[derive(Clone)]
pub struct Client {
    /// Validated native network settings.
    network: Network,
    /// Single worker shared by all application calls.
    engine: Arc<OnceCell<Engine>>,
    /// Existing protocol fixtures exercise event failure paths without native networking.
    #[cfg(test)]
    fixture: Option<super::fixture::Fixture>,
}

impl Client {
    /// Construct a direct dependency with no credential or HTTP endpoint.
    pub fn new(network: Network) -> Self {
        Self {
            network,
            engine: Arc::new(OnceCell::new()),
            #[cfg(test)]
            fixture: None,
        }
    }

    /// Initialize the single worker exactly once before the application accepts admissions.
    ///
    /// # Errors
    /// Native initialization failure prevents readiness.
    async fn engine(&self) -> Result<&Engine, MediaError> {
        self.engine
            .get_or_try_init(|| Engine::start(self.network.clone()))
            .await
    }

    /// Read current native boot identity.
    ///
    /// # Errors
    /// Worker startup or availability failures are returned.
    pub async fn metadata(&self) -> Result<Metadata, MediaError> {
        #[cfg(test)]
        if let Some(fixture) = &self.fixture {
            return fixture.metadata().await;
        }
        self.engine().await?.metadata().await
    }

    /// Execute one authorized in-process command.
    ///
    /// # Errors
    /// Ownership, provider and capacity failures propagate sanitized categories.
    pub async fn execute(&self, command: &Command) -> Result<Reply, MediaError> {
        #[cfg(test)]
        if let Some(fixture) = &self.fixture {
            return fixture.execute(command).await;
        }
        self.engine().await?.execute(command).await
    }

    /// Allocate music through the same owned command path and return its typed RTP destination.
    ///
    /// # Errors
    /// Ownership, capacity, cancellation or native failures reject allocation.
    pub async fn create_music(
        &self,
        boot: &str,
        binding: &crate::media::protocol::Binding,
        ssrc: u32,
    ) -> Result<MusicDestination, MediaError> {
        let command = Command::new(
            boot,
            binding,
            crate::media::protocol::Operation::CreateMusic { ssrc },
        );
        match self.execute(&command).await? {
            Reply::Music(destination) => Ok(destination),
            _ => Err(MediaError::Protocol),
        }
    }

    /// Validate current ownership without allocating or extending application membership.
    ///
    /// # Errors
    /// Stale or invalid renewal requests fail closed.
    pub(crate) async fn renew_resources(&self, command: &Command) -> Result<Reply, MediaError> {
        #[cfg(test)]
        if let Some(fixture) = &self.fixture {
            return fixture.renew_resources(command).await;
        }
        self.engine().await?.renew_resources(command).await
    }

    /// Subscribe to bounded direct native observations.
    ///
    /// # Errors
    /// Startup, stale boot or subscription failures prevent observation continuity.
    pub async fn events(&self, boot: &str) -> Result<NativeEventStream, MediaError> {
        #[cfg(test)]
        if let Some(fixture) = &self.fixture {
            return fixture.events(boot);
        }
        self.engine().await?.events(boot).await
    }

    /// Release resources after application teardown; configuration-only clients need no work.
    ///
    /// # Errors
    /// Poisoned native state cannot be successfully drained.
    pub fn shutdown(&self) -> Result<(), MediaError> {
        match self.engine.get() {
            Some(engine) => engine.shutdown(),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
impl From<super::fixture::Fixture> for Client {
    /// Inject direct command/event observations without starting native networking.
    fn from(fixture: super::fixture::Fixture) -> Self {
        Self {
            network: Network::parse("127.0.0.1", "", "43000", "43100").expect("fixture network"),
            engine: Arc::new(OnceCell::new()),
            fixture: Some(fixture),
        }
    }
}

impl Client {
    /// Wait until the initialized native worker fails; the process owner must drain and restart.
    pub async fn failed(&self) {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            if self.metadata().await.is_err() {
                return;
            }
        }
    }
}
