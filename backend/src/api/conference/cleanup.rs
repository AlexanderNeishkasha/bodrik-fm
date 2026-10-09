//! Durable, idempotent retirement of provider resources after revocation/deletion.

use crate::api::{AppState, studio_v2};
use rusqlite::{Transaction, params};

/// One retired provider mapping, never a new-join authority.
struct Pending {
    /// Provider adapter key.
    provider: String,
    /// Retired private room target, not logged or exposed to clients.
    target: String,
    /// Application room identity, retained even after deletion.
    room: i64,
}

/// Queue the currently enabled provider target in the caller's deletion/revocation transaction.
///
/// # Errors
/// Returns SQL errors; the caller must roll back its state change on queue failure.
pub(crate) fn queue_current_tx(tx: &Transaction<'_>, room: i64) -> Result<(), String> {
    tx.execute(
        "INSERT OR IGNORE INTO conference_termination_outbox(provider, provider_room_id, room_id)
        SELECT provider, provider_room_id, room_id FROM room_conferences
        WHERE room_id = ?1 AND enabled = 1 AND provider_room_id IS NOT NULL",
        params![room],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Retry pending targets for one room; successful provider calls alone remove records.
///
/// # Errors
/// Returns unavailable-provider, worker, SQL or provider termination errors.
pub(crate) async fn for_room(state: &AppState, room: i64) -> Result<(), String> {
    drain(state, Some(room)).await
}

/// Drain a bounded batch so provider outages do not create unbounded memory/work.
///
/// # Errors
/// Returns lookup/provider/ack failures; failed targets stay durable.
async fn drain(state: &AppState, room: Option<i64>) -> Result<(), String> {
    let query_state = state.clone();
    let pending = studio_v2::db_task(move || {
        let conn = query_state.db.lock().map_err(|_| "db lock poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT provider, provider_room_id, room_id FROM conference_termination_outbox
            WHERE ?1 IS NULL OR room_id = ?1 ORDER BY created_at, provider_room_id LIMIT 16",
            )
            .map_err(|err| err.to_string())?;
        stmt.query_map(params![room], |row| {
            Ok(Pending {
                provider: row.get(0)?,
                target: row.get(1)?,
                room: row.get(2)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
    })
    .await?;
    let mut failure = None;
    for entry in pending {
        let provider = state
            .conference_provider
            .as_deref()
            .ok_or("conference provider unavailable")?;
        if entry.provider != provider.key() {
            failure.get_or_insert_with(|| "pending conference provider not configured".to_owned());
            continue;
        }
        if let Err(error) = provider.terminate(&entry.target).await {
            failure.get_or_insert(error);
            continue;
        }
        let ack_state = state.clone();
        if let Err(error) = studio_v2::db_task(move || {
            let conn = ack_state.db.lock().map_err(|_| "db lock poisoned")?;
            conn.execute("DELETE FROM conference_termination_outbox WHERE provider = ?1 AND provider_room_id = ?2 AND room_id = ?3",
                params![entry.provider, entry.target, entry.room]).map_err(|err| err.to_string())?;
            Ok(())
        }).await { failure.get_or_insert(error); }
    }
    failure.map_or(Ok(()), Err)
}

/// Main-owned cleanup supervision; dropping it aborts the periodic retry task.
pub(crate) struct Worker {
    /// Finite-batch retry loop, owning state only while the process is serving.
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Worker {
    /// Release the process-owned loop rather than leaving an untracked state ownership cycle.
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Start bounded retries, including an initial pass after migrations have completed.
pub(crate) fn start(state: AppState) -> Worker {
    Worker {
        task: tokio::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_secs(60));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                timer.tick().await;
                if let Err(error) = drain(&state, None).await {
                    tracing::warn!(%error, "conference cleanup retry failed");
                }
            }
        }),
    }
}
