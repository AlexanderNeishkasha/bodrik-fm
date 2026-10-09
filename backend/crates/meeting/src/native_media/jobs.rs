//! Owned native commands complete allocation even when their requesting socket is cancelled.
use super::*;
use crate::media::protocol::{Binding, Operation};
use tokio::sync::oneshot;

/// One owned native command; its registry entry is removed on completion or abort.
struct Job {
    /// Shared engine retains native resources until command completion.
    engine: Engine,
    /// Unique task identity, independent of browser request IDs.
    id: Uuid,
}

impl Drop for Job {
    /// Remove only this task's cancellation handle.
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.engine.core.jobs.lock() {
            jobs.remove(&self.id);
        }
    }
}

impl Engine {
    /// Execute a bounded owned task; native allocation futures are not dropped by socket cancellation.
    ///
    /// # Errors
    /// Capacity, deadline, stopped worker and native command errors fail closed.
    pub(super) async fn owned(
        &self,
        b: &Binding,
        op: &Operation,
        deadline: std::time::Instant,
    ) -> Result<Reply, MediaError> {
        let queued = self
            .core
            .pending
            .clone()
            .try_acquire_owned()
            .map_err(|_| MediaError::Busy)?;
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            self.core.requests.clone().acquire_owned(),
        )
        .await
        .map_err(|_| MediaError::Busy)?
        .map_err(|_| MediaError::Transport)?;
        drop(queued);
        if std::time::Instant::now() >= deadline {
            return Err(state::reject(
                crate::media::protocol::ErrorCode::RequestExpired,
            ));
        }
        self.metadata().await?;
        let (sender, receiver) = oneshot::channel();
        let (start, started) = oneshot::channel();
        let engine = self.clone();
        let binding = b.clone();
        let operation = op.clone();
        let id = Uuid::new_v4();
        let task = tokio::spawn(async move {
            let _job = Job {
                engine: engine.clone(),
                id,
            };
            let _permit = permit;
            if started.await.is_err() {
                return;
            }
            let result = engine.operation(&binding, &operation).await;
            if let Err(Ok(value)) = sender.send(result) {
                let cleanup = match operation {
                    Operation::CreateRoom(_) => engine.close_room(&binding),
                    Operation::CreateMusic { .. } => match &value {
                        Reply::Music(destination) => engine
                            .close_music_matching(&binding, Some(destination.producer_id.as_str())),
                        _ => Err(MediaError::Protocol),
                    },
                    Operation::CreatePeer(_)
                    | Operation::CreateTransport(_)
                    | Operation::Produce { .. }
                    | Operation::Consume { .. } => engine.close_peer(&binding),
                    _ => return,
                };
                if let Err(error) = cleanup {
                    tracing::debug!(%error, "cancelled native command owner already retired");
                }
            }
        });
        {
            let mut jobs = self.core.jobs.lock().map_err(|_| MediaError::Transport)?;
            jobs.insert(id, task.abort_handle());
        }
        if start.send(()).is_err() {
            return Err(MediaError::Transport);
        }
        tokio::time::timeout(std::time::Duration::from_secs(8), receiver)
            .await
            .map_err(|_| MediaError::Transport)?
            .map_err(|_| MediaError::Transport)?
    }
}

#[cfg(test)]
mod tests;
