//! Explicitly owned durable file cleanup and bounded abandoned-upload recovery.
use super::{ChatState, database, files::storage_key};
use rusqlite::params;
use std::time::{Duration, SystemTime};

/// Cleanup task cancelled when the application releases its worker owner.
pub(crate) struct Worker {
    /// Sole periodic cleanup task; never detached on orderly shutdown.
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Worker {
    /// Stop periodic cleanup when application ownership ends.
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Start cleanup immediately and repeat each minute without blocking async workers.
pub(super) fn start(state: ChatState) -> Worker {
    Worker {
        task: tokio::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_secs(60));
            loop {
                timer.tick().await;
                if let Err(error) = sweep(&state).await {
                    tracing::error!(%error,"chat file cleanup failed; jobs retained for retry");
                }
            }
        }),
    }
}

/// Prune staged metadata, process durable removals and collect old crash-orphaned files.
///
/// # Errors
/// Returns database, filesystem and worker failures; failed removals stay queued.
async fn sweep(state: &ChatState) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    let (jobs,known)=database(state,move |conn| {
        conn.execute("DELETE FROM conference_chat_attachments WHERE created_at<?1 AND NOT EXISTS(SELECT 1 FROM conference_chat_messages m WHERE m.attachment_id=conference_chat_attachments.id)",[now-3_600_000]).map_err(|e|e.to_string())?;
        let mut statement=conn.prepare("SELECT storage_key FROM conference_chat_file_cleanup LIMIT 100").map_err(|e|e.to_string())?;
        let jobs=statement.query_map([],|row|row.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())?;
        let mut statement=conn.prepare("SELECT storage_key FROM conference_chat_attachments").map_err(|e|e.to_string())?;
        let known=statement.query_map([],|row|row.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<rusqlite::Result<std::collections::HashSet<_>>>().map_err(|e|e.to_string())?;
        Ok((jobs,known))
    }).await?;
    for key in jobs {
        if !storage_key(&key) {
            return Err("invalid cleanup storage key".into());
        }
        match tokio::fs::remove_file(state.directory.join(&key)).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        database(state, move |conn| {
            conn.execute(
                "DELETE FROM conference_chat_file_cleanup WHERE storage_key=?1",
                params![key],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await?;
    }
    let mut entries = match tokio::fs::read_dir(&state.directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let staging = name
            .strip_prefix('.')
            .and_then(|v| v.strip_suffix(".upload"))
            .is_some_and(super::types::uuid_key);
        if !(staging || storage_key(&name) && !known.contains(&name)) {
            continue;
        }
        let metadata = entry.metadata().await.map_err(|e| e.to_string())?;
        if metadata.is_file()
            && SystemTime::now()
                .duration_since(metadata.modified().map_err(|e| e.to_string())?)
                .unwrap_or_default()
                >= Duration::from_secs(3600)
        {
            tokio::fs::remove_file(entry.path())
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
