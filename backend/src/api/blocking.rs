//! Offload synchronous SQLite, filesystem and CPU work from async workers.

use crate::api::op_error::OpError;

/// Execute synchronous work on the blocking pool, preserving operation errors.
///
/// # Errors
/// Returns operation errors or useful worker failure context.
pub(crate) async fn db_task<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    run(operation).await
}

/// Execute synchronous work whose failures carry an HTTP classification.
///
/// # Errors
/// Returns classified operation errors, or worker failures as internal errors.
pub(crate) async fn op_task<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, OpError> + Send + 'static,
) -> Result<T, OpError> {
    run(operation).await
}

/// Shared offload body; the typed wrappers keep call-site error inference unambiguous.
///
/// # Errors
/// Returns operation errors or worker failure context converted into `E`.
async fn run<T: Send + 'static, E: From<String> + Send + 'static>(
    operation: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> Result<T, E> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|err| E::from(format!("blocking task failed: {err}")))?
}
