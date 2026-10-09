//! Server-generated private native commands and fenced cleanup; no browser can select lifecycle bindings.
use super::Service;
use crate::media::{
    MediaError,
    protocol::{self, Binding, Command, Empty, Operation},
};

/// Bind an in-process operation to one current native owner and a monotonic deadline.
pub(super) fn command(boot: &str, binding: &Binding, operation: Operation) -> Command {
    Command::new(boot, binding, operation)
}

/// Execute one lifecycle action without constructing an unused JSON acknowledgment.
///
/// # Errors
/// Propagates sanitized native failures; callers must retire exact owned bindings on admission failure.
pub(super) async fn execute(
    service: &Service,
    boot: &str,
    binding: &Binding,
    operation: Operation,
) -> Result<crate::native_media::Reply, &'static str> {
    let command = command(boot, binding, operation);
    service
        .config
        .media
        .execute(&command)
        .await
        .map_err(|_| "native unavailable")
}

/// Extend only the server-bound native handle lifetime after fresh domain authorization.
///
/// # Errors
/// Expired/stale ownership or unavailable private renewal fails closed; it cannot allocate resources.
pub(super) async fn renew(
    service: &Service,
    boot: &str,
    binding: &Binding,
) -> Result<(), &'static str> {
    let command = command(boot, binding, Operation::Inventory(Empty::default()));
    service
        .config
        .media
        .renew_resources(&command)
        .await
        .map_err(|_| "native lease unavailable")?;
    Ok(())
}

/// Return whether a native rejection proves the exact old ownership scope is already unreachable.
fn retirement_confirmed(error: &MediaError) -> bool {
    matches!(
        error,
        MediaError::Rejected(
            protocol::ErrorCode::StaleBoot | protocol::ErrorCode::UnauthorizedSession
        )
    )
}

/// Attempt bounded idempotent retirement with one exact ownership binding; old boots and stale sessions cannot touch replacement resources.
pub(super) async fn close(service: &Service, boot: &str, binding: &Binding, room: bool) {
    let operation = if room {
        Operation::CloseRoom(Empty::default())
    } else {
        Operation::ClosePeer(Empty::default())
    };
    let command = command(boot, binding, operation);
    for attempt in 0..3 {
        match service.config.media.execute(&command).await {
            Ok(_) => return,
            Err(error) if retirement_confirmed(&error) => return,
            Err(error) => {
                tracing::warn!(category = ?error, attempt, "owned native retirement not confirmed");
                if attempt < 2 {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    }
    tracing::error!(
        "owned native cleanup exhausted; native orphan expiry will retire remaining resources"
    );
}

#[cfg(test)]
mod tests {
    use super::retirement_confirmed;
    use crate::media::{MediaError, protocol::ErrorCode};

    /// Only ownership-fenced cleanup outcomes confirm that the exact retired scope is unreachable.
    #[test]
    fn retirement_confirmation_cases() {
        for (name, error, expected) in [
            (
                "stale boot",
                MediaError::Rejected(ErrorCode::StaleBoot),
                true,
            ),
            (
                "missing or replaced session",
                MediaError::Rejected(ErrorCode::UnauthorizedSession),
                true,
            ),
            (
                "operational failure",
                MediaError::Rejected(ErrorCode::MediaFailure),
                false,
            ),
        ] {
            assert_eq!(retirement_confirmed(&error), expected, "{name}");
        }
    }
}
