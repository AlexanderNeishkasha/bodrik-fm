//! Explicit owner of the replacement event subscription and resource drain.
use super::{Service, config::Config, diagnostics, file, observations, session};
use axum::Router;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    sync::{Semaphore, watch},
    task::JoinHandle,
    time::{Duration, timeout},
};

/// Maximum time allowed for an observation task already inside cleanup to stop cooperatively.
const SUPERVISOR_STOP_TIMEOUT: Duration = Duration::from_secs(2);
/// Global bound for retiring all remaining exact room owners during process shutdown.
const RESOURCE_DRAIN_TIMEOUT: Duration = Duration::from_secs(15);

/// Isolated application lifetime; callers must invoke shutdown before dropping owned resources.
pub struct Application {
    /// Cloneable route composition; no background work is created by router cloning.
    router: Router,
    /// Domain/socket/native owner shared with the observation supervisor.
    service: Service,
    /// Explicit supervisor cancellation signal.
    stop: watch::Sender<bool>,
    /// Exactly one owned native event supervisor.
    task: Option<JoinHandle<()>>,
    /// Owned temporary-upload expiry supervisor.
    upload_task: Option<JoinHandle<()>>,
    /// Owned bounded diagnostics writer/retention supervisor.
    diagnostic_task: Option<JoinHandle<()>>,
    /// Owned file-transfer deadline supervisor.
    file_task: Option<JoinHandle<()>>,
    /// Owned room-level authority refresh supervisor.
    lease_task: Option<JoinHandle<()>>,
    /// Owned player snapshot and FFmpeg supervisor.
    music_task: Option<JoinHandle<Result<(), &'static str>>>,
}

impl Application {
    /// Establish a validated native event baseline before accepting public admissions.
    ///
    /// # Errors
    /// Native metadata/subscription/baseline failures prevent service startup.
    pub async fn start(config: Config) -> Result<Self, &'static str> {
        let media = config.media.clone();
        let result = Self::start_owned(config).await;
        if result.is_err() {
            media
                .shutdown()
                .map_err(|_| "native startup cleanup failed")?;
        }
        result
    }

    /// Initialize supervisors only after native baseline validation; startup errors release media.
    async fn start_owned(config: Config) -> Result<Self, &'static str> {
        let boot = config
            .media
            .metadata()
            .await
            .map_err(|_| "native unavailable")?
            .boot_id;
        let mut stream = config
            .media
            .events(&boot)
            .await
            .map_err(|_| "native events unavailable")?;
        stream
            .next_event()
            .await
            .map_err(|_| "native baseline unavailable")?;
        let (stop, receiver) = watch::channel(false);
        let (diagnostic_handle, diagnostic_task) =
            diagnostics::start(config.diagnostics.clone(), receiver.clone()).await?;
        let service = Service {
            config: Arc::new(config),
            runtime: crate::runtime::Runtime::default(),
            store: Arc::new(Mutex::new(session::Store::default())),
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            sockets: Arc::new(Semaphore::new(512)),
            observing: Arc::new(AtomicBool::new(true)),
            draining: Arc::new(AtomicBool::new(false)),
            upload_limits: Arc::new(super::uploads::Limits::new()),
            diagnostics: diagnostic_handle,
            diagnostic_limits: Arc::new(diagnostics::Limits::new()),
            chat_limits: Arc::new(super::chat::Limits::new()),
        };
        let router = super::routes(service.clone());
        let observation_stop = receiver.clone();
        let owner = service.clone();
        let task = tokio::spawn(async move {
            observations::supervise(owner, stream, observation_stop).await;
        });
        let upload_owner = service.clone();
        let upload_stop = receiver.clone();
        let upload_task = tokio::spawn(async move {
            super::uploads::supervise(upload_owner, upload_stop).await;
        });
        let file_owner = service.clone();
        let file_stop = receiver.clone();
        let file_task = tokio::spawn(async move {
            file::supervise(file_owner, file_stop).await;
        });
        let lease_owner = service.clone();
        let lease_stop = receiver.clone();
        let lease_task = tokio::spawn(async move {
            super::room_lease::supervise(lease_owner, lease_stop).await;
        });
        let music_owner = service.clone();
        let music_task =
            tokio::spawn(async move { super::music::supervise(music_owner, receiver).await });
        Ok(Self {
            router,
            service,
            stop,
            task: Some(task),
            upload_task: Some(upload_task),
            diagnostic_task: Some(diagnostic_task),
            file_task: Some(file_task),
            music_task: Some(music_task),
            lease_task: Some(lease_task),
        })
    }

    /// Borrow a cloneable lifecycle capability for this exact incarnation.
    pub fn handle(&self) -> super::Handle {
        super::Handle {
            service: self.service.clone(),
        }
    }

    /// Clone routes while retaining this application's explicit lifetime owner.
    pub fn router(&self) -> Router {
        self.router.clone()
    }

    /// Observe native failure independently of public socket or HTTP activity.
    pub fn media_failure(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let media = self.service.config.media.clone();
        async move { media.failed().await }
    }

    /// Stop admission/delivery, cancel bounded observation work and retire exact owned rooms.
    ///
    /// # Errors
    /// Returns when the global native resource drain deadline is exceeded. The caller must fail
    /// the process rather than claim a graceful shutdown; native leases still bound orphan lifetime.
    pub async fn shutdown(&mut self) -> Result<(), &'static str> {
        self.service.draining.store(true, Ordering::Release);
        self.service.observing.store(false, Ordering::Release);
        self.stop.send_replace(true);
        if let Some(task) = self.task.take() {
            stop_supervisor(task).await;
        }
        if let Some(task) = self.upload_task.take() {
            stop_supervisor(task).await;
        }
        if let Some(task) = self.diagnostic_task.take() {
            stop_supervisor(task).await;
        }
        if let Some(task) = self.file_task.take() {
            stop_supervisor(task).await;
        }
        if let Some(task) = self.music_task.take() {
            let mut task = task;
            match timeout(RESOURCE_DRAIN_TIMEOUT, &mut task).await {
                Ok(Ok(Ok(()))) => {}
                _ => {
                    task.abort();
                    let _ = task.await;
                    return Err("music resource drain failed");
                }
            }
        }
        if let Some(task) = self.lease_task.take() {
            stop_supervisor(task).await;
        }
        timeout(
            RESOURCE_DRAIN_TIMEOUT,
            observations::retire_all(&self.service),
        )
        .await
        .map_err(|_| "replacement resource drain deadline exceeded")?;
        self.service
            .config
            .media
            .shutdown()
            .map_err(|_| "native media drain failed")?;
        Ok(())
    }
}

/// Stop one replacement background task cooperatively, then abort work past its deadline.
async fn stop_supervisor(task: JoinHandle<()>) {
    stop_supervisor_with_timeout(task, SUPERVISOR_STOP_TIMEOUT).await;
}

/// Apply an explicit stop bound; the parameter keeps deadline behavior deterministic in tests.
async fn stop_supervisor_with_timeout(mut task: JoinHandle<()>, deadline: Duration) {
    match timeout(deadline, &mut task).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::error!(%error, "replacement background owner failed"),
        Err(_) => {
            tracing::error!("replacement background owner exceeded stop deadline");
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for Application {
    /// Fail closed and stop the owned subscription if a caller omits explicit asynchronous drain.
    fn drop(&mut self) {
        if let Err(error) = self.service.config.media.shutdown() {
            tracing::error!(%error, "native media drop cleanup failed");
        }
        self.service.draining.store(true, Ordering::Release);
        self.service.observing.store(false, Ordering::Release);
        if let Some(task) = self.task.take() {
            tracing::error!("replacement dropped without explicit resource drain");
            task.abort();
        }
        if let Some(task) = self.upload_task.take() {
            task.abort();
        }
        if let Some(task) = self.diagnostic_task.take() {
            task.abort();
        }
        if let Some(task) = self.file_task.take() {
            task.abort();
        }
        if let Some(task) = self.music_task.take() {
            task.abort();
        }
        if let Some(task) = self.lease_task.take() {
            task.abort();
        }
    }
}

/// Explicit shutdown deadline fixtures.
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    /// A non-cooperative supervisor is aborted and cannot complete after shutdown returns.
    #[tokio::test]
    async fn supervisor_stop_deadline_aborts_non_cooperative_work() {
        let completed = Arc::new(AtomicBool::new(false));
        let marker = Arc::clone(&completed);
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            marker.store(true, Ordering::Release);
        });
        stop_supervisor_with_timeout(task, Duration::from_millis(10)).await;
        assert!(!completed.load(Ordering::Acquire));
    }
}
