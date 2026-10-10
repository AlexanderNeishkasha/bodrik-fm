//! Atomic sliding-window admission with bounded per-client history and stale-key cleanup.

use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};

/// Track attempts before expensive authentication/provider work with monotonic time.
pub struct LoginRateLimiter {
    /// Threshold and maximum retained timestamps per client.
    max_attempts: usize,
    /// Inclusive attempt lifetime.
    window: Duration,
    /// Serialized attempt histories and housekeeping state.
    state: tokio::sync::Mutex<LimiterState>,
}

/// Mutable window bookkeeping shared by all requests using a limiter.
struct LimiterState {
    /// Recent attempts, bounded by the configured threshold for each client.
    attempts: HashMap<String, VecDeque<Instant>>,
    /// Last full stale-client sweep.
    last_cleanup: Instant,
}

impl LoginRateLimiter {
    /// Create a limiter; zero threshold rejects all requests without allocating histories.
    pub fn new(max_attempts: usize, window_secs: u64) -> Self {
        Self {
            max_attempts,
            window: Duration::from_secs(window_secs),
            state: tokio::sync::Mutex::new(LimiterState {
                attempts: HashMap::new(),
                last_cleanup: Instant::now(),
            }),
        }
    }

    /// Atomically check and reserve admission; rejected requests cannot extend/overbook history.
    pub async fn try_record_attempt(&self, key: &str) -> bool {
        let mut state = self.state.lock().await;
        let now = Instant::now();
        state.cleanup(now, self.window);
        if self.max_attempts == 0 {
            return false;
        }
        let bucket = state.attempts.entry(key.to_owned()).or_default();
        purge_old(bucket, now, self.window);
        if bucket.len() >= self.max_attempts {
            return false;
        }
        bucket.push_back(now);
        true
    }

    /// Forget attempts after successful authentication; conference admission deliberately never resets.
    pub async fn reset(&self, key: &str) {
        self.state.lock().await.attempts.remove(key);
    }
}

impl LimiterState {
    /// Reclaim stale client histories at most once per window on incoming activity.
    fn cleanup(&mut self, now: Instant, window: Duration) {
        if now.saturating_duration_since(self.last_cleanup) < window {
            return;
        }
        self.attempts.retain(|_, bucket| {
            purge_old(bucket, now, window);
            !bucket.is_empty()
        });
        self.last_cleanup = now;
    }
}

/// Expire attempts strictly older than the inclusive window edge.
fn purge_old(bucket: &mut VecDeque<Instant>, now: Instant, window: Duration) {
    while bucket
        .front()
        .is_some_and(|time| now.saturating_duration_since(*time) > window)
    {
        bucket.pop_front();
    }
}

/// Table-driven admission/expiry/reset tests, not HTTP fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Concurrent callers cannot exceed zero/one/five thresholds, and reset releases capacity.
    #[tokio::test]
    async fn atomic_admission_cases() {
        for threshold in [0, 1, 5] {
            let limiter = std::sync::Arc::new(LoginRateLimiter::new(threshold, 60));
            let mut tasks = tokio::task::JoinSet::new();
            for _ in 0..20 {
                let limiter = limiter.clone();
                tasks.spawn(async move { limiter.try_record_attempt("client").await });
            }
            let mut admitted = 0;
            while let Some(result) = tasks.join_next().await {
                admitted += usize::from(result.unwrap());
            }
            assert_eq!(admitted, threshold);
            let state = limiter.state.lock().await;
            assert_eq!(
                state.attempts.get("client").map_or(0, VecDeque::len),
                threshold
            );
            drop(state);
            limiter.reset("client").await;
            assert_eq!(limiter.try_record_attempt("client").await, threshold > 0);
        }
    }

    /// Expired histories allow new admission without preserving stale attempts.
    #[tokio::test]
    async fn expiry_cases() {
        for (age, admitted) in [(1, false), (61, true)] {
            let limiter = LoginRateLimiter::new(1, 60);
            assert!(limiter.try_record_attempt("client").await);
            limiter
                .state
                .lock()
                .await
                .attempts
                .get_mut("client")
                .unwrap()[0] = Instant::now() - Duration::from_secs(age);
            assert_eq!(limiter.try_record_attempt("client").await, admitted);
            assert_eq!(limiter.state.lock().await.attempts["client"].len(), 1);
        }
    }

    /// Sweeps and purges cover empty/fresh/edge/expired/mixed timestamp cases.
    #[test]
    fn window_cases() {
        let now = Instant::now();
        for (ages, remaining) in [
            (&[][..], 0),
            (&[0][..], 1),
            (&[60][..], 1),
            (&[61][..], 0),
            (&[62, 61, 60, 1][..], 2),
        ] {
            let mut bucket = ages
                .iter()
                .map(|age| now - Duration::from_secs(*age))
                .collect();
            purge_old(&mut bucket, now, Duration::from_secs(60));
            assert_eq!(bucket.len(), remaining);
        }
        for (elapsed, retained, swept) in [(59, true, false), (60, true, true), (61, false, true)] {
            let mut state = LimiterState {
                attempts: HashMap::from([("client".into(), VecDeque::from([now]))]),
                last_cleanup: now,
            };
            let next = now + Duration::from_secs(elapsed);
            state.cleanup(next, Duration::from_secs(60));
            assert_eq!(state.attempts.contains_key("client"), retained);
            assert_eq!(state.last_cleanup == next, swept);
        }
    }
}
