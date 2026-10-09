//! Shared native media data and the authorized in-process execution boundary.

mod error;
mod event;
pub mod protocol;
mod validation;

pub use error::MediaError;
pub use event::Event;

/// Authorized runtime command boundary implemented by native media and protocol fixtures.
pub(crate) trait Executor {
    /// Execute a single command without changing its server-issued ownership scope.
    fn execute(
        &self,
        command: &protocol::Command,
    ) -> impl std::future::Future<Output = Result<serde_json::Value, MediaError>> + Send;
}

impl Executor for crate::native_media::Client {
    /// Execute directly against the Rust-owned native worker.
    async fn execute(&self, command: &protocol::Command) -> Result<serde_json::Value, MediaError> {
        crate::native_media::Client::execute(self, command)
            .await
            .map(crate::native_media::Reply::into_json)
    }
}
