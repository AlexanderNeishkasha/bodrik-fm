//! Embedded meeting lifecycle, dynamic routing and safe subsystem recovery.
#[cfg(test)]
mod recovery_tests;
use axum::{
    Router,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use meeting_backend::{
    integration::services::Services,
    replacement::{Application, Handle, config::Config},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle};
use tower::ServiceExt;

/// Explicit lifecycle state; backend availability does not depend on meeting readiness.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// Configuration is valid; native startup is in progress.
    Starting,
    /// Current incarnation accepts admission.
    Ready,
    /// Old resources are draining before a fresh startup.
    Recovering,
    /// Startup failed safely; retry backoff is in progress.
    Unavailable,
    /// Shutdown fences further recovery and browser work.
    Stopped,
}

/// Current incarnation's ready capability and precomposed public router.
#[derive(Clone)]
struct Active {
    /// Exact room lifecycle owner; unavailable instances never issue tickets.
    handle: Handle,
    /// Routes are composed once per incarnation rather than once per request.
    router: Router,
}

/// Shared lifecycle view, not a second copy of room/session authorization state.
#[derive(Clone)]
pub(crate) struct Shared {
    /// Latest safely published meeting incarnation.
    active: Arc<Mutex<Option<Active>>>,
    /// Observable subsystem lifecycle; no browser protocol changes.
    phase: watch::Sender<Phase>,
}

impl Shared {
    /// Create an unavailable capability before backend composition.
    pub(crate) fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(None)),
            phase: watch::channel(Phase::Starting).0,
        }
    }
    /// Clone ready state without retaining a synchronous lock across any await.
    fn current(&self) -> Option<Active> {
        self.active
            .lock()
            .ok()?
            .as_ref()
            .filter(|active| active.handle.ready())
            .cloned()
    }
    /// Discover live ticket scopes directly; stale incarnations cannot issue credentials.
    pub(crate) fn incarnation(&self) -> Option<(String, String, String)> {
        self.current()?.handle.incarnation()
    }
    /// Retire an exact private mapping, preserving durable retry on unavailable media.
    ///
    /// # Errors
    /// Returns unavailable-subsystem or native retirement failures.
    pub(crate) async fn terminate(&self, id: &str) -> Result<(), String> {
        let active = self.current().ok_or("meeting unavailable")?;
        active.handle.terminate(id).await
    }
    /// Publish readiness only after native startup; clearing precedes any drain.
    fn publish(&self, active: Option<Active>, phase: Phase) -> Result<(), String> {
        *self
            .active
            .lock()
            .map_err(|_| "meeting lifecycle poisoned")? = active;
        self.phase.send_replace(phase);
        Ok(())
    }
    /// Routes keep their browser paths while resolving the current incarnation on every request.
    pub(crate) fn routes(&self) -> Router {
        // A second capturing router would append duplicate Path parameters to the request.
        Router::new()
            .route("/ready/meeting", get(readiness))
            .fallback(dispatch)
            .with_state(self.clone())
    }
}

/// Forward in-process with original request extensions, including socket ConnectInfo and upgrade.
async fn dispatch(State(shared): State<Shared>, request: Request) -> Response {
    if !meeting_path(request.uri().path()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(active) = shared.current() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match active.router.oneshot(request).await {
        Ok(response) => response,
        Err(never) => match never {},
    }
}

/// Restrict the host fallback to the existing public meeting surface, without extracting captures.
fn meeting_path(path: &str) -> bool {
    if matches!(
        path,
        "/config"
            | "/brand"
            | "/join/"
            | "/privacy"
            | "/newroom"
            | "/activeRooms"
            | "/customizeRoom"
            | "/login"
            | "/logged"
            | "/logout"
            | "/iframe"
    ) {
        return true;
    }
    if path
        .strip_prefix("/api/meeting/")
        .is_some_and(|tail| !tail.is_empty())
    {
        return true;
    }
    [
        "/ws/meeting/v1/",
        "/uploads/avatars/",
        "/uploads/chat/",
        "/join/",
        "/room/",
        "/whoAreYou/",
    ]
    .iter()
    .any(|prefix| {
        path.strip_prefix(prefix)
            .is_some_and(|tail| !tail.is_empty() && !tail.contains('/'))
    })
}

/// Meeting readiness is independent of the healthy backend listener.
async fn readiness(State(shared): State<Shared>) -> StatusCode {
    if shared.current().is_some() {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

/// Main-owned supervisor; explicit shutdown drains media before the listener stops.
pub(crate) struct Supervisor {
    /// Cooperative stop signal interrupts startup/backoff and active monitoring.
    stop: watch::Sender<bool>,
    /// Escalation signal for failed/unconfirmed cleanup or unexpected task failure.
    fatal: watch::Receiver<bool>,
    /// Single lifetime owner of all meeting applications.
    task: Option<JoinHandle<Result<(), String>>>,
}

impl Supervisor {
    /// Validate configuration and start native recovery without blocking player availability.
    ///
    /// # Errors
    /// Returns invalid meeting configuration before creating any supervision task.
    pub(crate) fn start(shared: Shared, services: Arc<dyn Services>) -> Result<Self, String> {
        Self::start_factory(
            shared,
            Arc::new(move || Config::embedded_from_env(services.clone())),
        )
    }

    /// Validate a fresh-incarnation factory; tests inject explicit settings without mutating environment.
    ///
    /// # Errors
    /// Rejects invalid settings before allocating a supervisor.
    fn start_factory(shared: Shared, factory: ConfigFactory) -> Result<Self, String> {
        let config = factory()?;
        let (stop, receiver) = watch::channel(false);
        let (fatal_sender, fatal) = watch::channel(false);
        let task = tokio::spawn(async move {
            use futures_util::FutureExt;
            let result = std::panic::AssertUnwindSafe(supervise(shared, factory, config, receiver))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err("meeting supervisor panicked".into()));
            if let Err(error) = &result {
                tracing::error!(%error, "meeting cleanup requires process restart");
                fatal_sender.send_replace(true);
            }
            result
        });
        Ok(Self {
            stop,
            fatal,
            task: Some(task),
        })
    }
    /// Wait for an unsafe recovery requiring whole-process shutdown.
    pub(crate) async fn failed(&mut self) {
        while !*self.fatal.borrow_and_update() {
            if self.fatal.changed().await.is_err() {
                return;
            }
        }
    }
    /// Stop retries and await confirmed resource drain.
    ///
    /// # Errors
    /// Returns timeout, unexpected task failure or unconfirmed native/process cleanup.
    pub(crate) async fn shutdown(&mut self) -> Result<(), String> {
        self.stop.send_replace(true);
        if let Some(mut task) = self.task.take() {
            match tokio::time::timeout(Duration::from_secs(45), &mut task).await {
                Ok(result) => result.map_err(|_| "meeting supervisor failed")?,
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    Err("meeting shutdown deadline exceeded".into())
                }
            }
        } else {
            Ok(())
        }
    }
}

impl Drop for Supervisor {
    /// Exceptional process teardown cannot leave detached supervision/recovery work.
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Fresh configuration factory; never restore a previous native/ticket incarnation.
type ConfigFactory = Arc<dyn Fn() -> Result<Config, String> + Send + Sync>;

/// Recover only after confirmed cleanup; a fresh application invalidates prior-incarnation tickets.
async fn supervise(
    shared: Shared,
    factory: ConfigFactory,
    first: Config,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    let mut first = Some(first);
    let mut attempts = 0_u32;
    loop {
        if *stop.borrow() {
            return shared.publish(None, Phase::Stopped);
        }
        let config = match first.take() {
            Some(config) => config,
            None => factory()?,
        };
        let mut application = match Application::start(config).await {
            Ok(application) => application,
            Err("native startup cleanup failed") => {
                return Err("native startup cleanup failed".into());
            }
            Err(error) => {
                tracing::warn!(error, "meeting startup unavailable; retrying safely");
                shared.publish(None, Phase::Unavailable)?;
                attempts = attempts.saturating_add(1);
                if backoff(&mut stop, attempts).await {
                    return shared.publish(None, Phase::Stopped);
                }
                continue;
            }
        };
        let handle = application.handle();
        shared.publish(
            Some(Active {
                router: handle.router(),
                handle: handle.clone(),
            }),
            Phase::Ready,
        )?;
        let started = std::time::Instant::now();
        let failure = application.media_failure();
        tokio::pin!(failure);
        loop {
            tokio::select! {
                _ = &mut failure => break,
                changed = stop.changed() => { if changed.is_err() || *stop.borrow() { break; } },
                _ = tokio::time::sleep(Duration::from_secs(1)) => { if !handle.ready() { break; } },
            }
        }
        shared.publish(None, Phase::Recovering)?;
        drop(handle);
        application.shutdown().await.map_err(str::to_owned)?;
        drop(application);
        if *stop.borrow() {
            return shared.publish(None, Phase::Stopped);
        }
        if started.elapsed() > Duration::from_secs(60) {
            attempts = 0;
        }
        attempts = attempts.saturating_add(1);
        if backoff(&mut stop, attempts).await {
            return shared.publish(None, Phase::Stopped);
        }
    }
}

/// Sample a bounded retry delay, returning early when shutdown cancels recovery.
async fn backoff(stop: &mut watch::Receiver<bool>, attempts: u32) -> bool {
    let ceiling = 1000_u64
        .saturating_mul(1_u64 << attempts.saturating_sub(1).min(5))
        .min(30_000);
    let seed = uuid::Uuid::new_v4().as_u128();
    let delay = ceiling / 2 + u64::try_from(seed % u128::from(ceiling / 2 + 1)).unwrap_or(0);
    tokio::select! { _ = tokio::time::sleep(Duration::from_millis(delay)) => false, _ = stop.changed() => true }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Unknown host paths stay ordinary 404s; only public meeting paths enter the inner router.
    #[test]
    fn dispatch_path_cases() {
        for (path, allowed) in [
            ("/ws/meeting/v1/room", true),
            ("/api/meeting/chat/files", true),
            ("/uploads/avatars/id.png", true),
            ("/join/", true),
            ("/room/one", true),
            ("/", false),
            ("/api/private", false),
            ("/ws/meeting/v1/", false),
            ("/room/one/two", false),
            ("/uploads/avatars/one/two", false),
        ] {
            assert_eq!(meeting_path(path), allowed, "{path}");
        }
    }
    /// Unavailable media does not claim readiness or permit discovery/termination; retry is cancellable.
    #[tokio::test]
    async fn unavailable_and_cancelled_recovery() {
        let shared = Shared::new();
        assert!(shared.incarnation().is_none());
        assert!(shared.terminate("room").await.is_err());
        assert_eq!(
            readiness(State(shared.clone())).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let (stop, mut receiver) = watch::channel(false);
        stop.send_replace(true);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), backoff(&mut receiver, 100))
                .await
                .expect("cancelled")
        );
        shared.publish(None, Phase::Stopped).expect("stop");
        assert_eq!(*shared.phase.borrow(), Phase::Stopped);
    }
}
