//! Bounded authority backpressure without caching or relaxing authorization.

use std::{sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Maximum queue time, kept below the five-second heartbeat and sixty-second lease.
const WAIT: Duration = Duration::from_secs(1);

/// Wait for an HTTP slot within a bounded queue; cancellation releases both budgets.
///
/// # Errors
/// Rejects queue overflow, closed budgets or a queue wait exceeding one second.
pub(super) async fn acquire(
    active: &Arc<Semaphore>,
    pending: &Arc<Semaphore>,
) -> Result<OwnedSemaphorePermit, String> {
    let queued = pending
        .clone()
        .try_acquire_owned()
        .map_err(|_| "player authority queue exhausted")?;
    let permit = tokio::time::timeout(WAIT, active.clone().acquire_owned())
        .await
        .map_err(|_| "player authority queue deadline exceeded")?
        .map_err(|_| "player authority unavailable")?;
    drop(queued);
    Ok(permit)
}

#[cfg(test)]
mod tests {
    //! Burst, failure and cancellation contracts for authority backpressure.
    use super::*;

    /// A nine-peer broadcast waits for a slot instead of immediately ejecting a peer.
    #[tokio::test]
    async fn burst_waits_and_releases_budgets() {
        let active = Arc::new(Semaphore::new(8));
        let pending = Arc::new(Semaphore::new(64));
        let held = active
            .clone()
            .acquire_many_owned(8)
            .await
            .expect("eight slots");
        let a = active.clone();
        let p = pending.clone();
        let task = tokio::spawn(async move { acquire(&a, &p).await });
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        drop(held);
        drop(task.await.expect("join").expect("queued permit"));
        assert_eq!(active.available_permits(), 8);
        assert_eq!(pending.available_permits(), 64);
    }

    /// Queue overflow and closed authority fail without issuing an HTTP request.
    #[tokio::test]
    async fn named_failure_cases() {
        for (name, closed, queued, expected) in [
            ("queue full", false, 0, "player authority queue exhausted"),
            ("closed", true, 1, "player authority unavailable"),
        ] {
            let active = Arc::new(Semaphore::new(1));
            if closed {
                active.close();
            }
            let pending = Arc::new(Semaphore::new(queued));
            assert_eq!(
                acquire(&active, &pending).await.err().as_deref(),
                Some(expected),
                "{name}"
            );
            assert_eq!(pending.available_permits(), queued);
        }
    }

    /// A slow authority still fails closed and returns its pending queue permit.
    #[tokio::test]
    async fn deadline_releases_queue() {
        let active = Arc::new(Semaphore::new(0));
        let pending = Arc::new(Semaphore::new(1));
        assert_eq!(
            acquire(&active, &pending).await.err().as_deref(),
            Some("player authority queue deadline exceeded")
        );
        assert_eq!(pending.available_permits(), 1);
    }
}
