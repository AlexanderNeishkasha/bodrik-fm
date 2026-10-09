//! Synchronous transactional chat storage; all callers execute on the blocking pool.
use super::types::*;
use rusqlite::{Connection, OptionalExtension, params};

/// Resolve a still-current enabled mapping inside the caller's database operation.
///
/// # Errors
/// Returns missing/revoked authority or database failures.
pub(super) fn room(conn: &Connection, who: &Identity) -> Result<i64, String> {
    conn.query_row("SELECT room_id FROM room_conferences WHERE provider_room_id=?1 AND generation=?2 AND allowed=1 AND enabled=1",
        params![who.conference, who.generation], |row| row.get(0)).optional().map_err(|e| e.to_string())?
        .ok_or_else(|| "unavailable".into())
}

/// Shared bounded message/attachment projection with no file bytes or disk paths.
const PROJECTION: &str = "SELECT m.id,m.actor,m.name,m.avatar,m.body,m.created_at,a.id,a.filename,a.media_type,a.kind,a.size
 FROM conference_chat_messages m LEFT JOIN conference_chat_attachments a ON a.id=m.attachment_id";

/// Decode one persisted record, deriving ownership for the current trusted actor.
///
/// # Errors
/// Returns SQLite row conversion errors.
fn message(row: &rusqlite::Row<'_>, who: &Identity) -> rusqlite::Result<Message> {
    let own = row.get::<_, String>(1)? == who.actor;
    let attachment = if let Some(id) = row.get::<_, Option<String>>(6)? {
        Some(Attachment {
            id,
            name: row.get(7)?,
            media_type: row.get(8)?,
            kind: row.get(9)?,
            size: row.get(10)?,
        })
    } else {
        None
    };
    Ok(Message {
        id: row.get::<_, i64>(0)?.to_string(),
        name: row.get(2)?,
        avatar: row.get(3)?,
        text: row.get(4)?,
        created_at: row.get(5)?,
        own,
        can_delete: own || who.presenter,
        attachment,
    })
}

/// Return a canonical record within this room.
///
/// # Errors
/// Returns missing records or SQLite failures.
fn find(conn: &Connection, room: i64, id: i64, who: &Identity) -> Result<Message, String> {
    conn.query_row(
        &format!("{PROJECTION} WHERE m.room_id=?1 AND m.id=?2"),
        params![room, id],
        |row| message(row, who),
    )
    .map_err(|e| e.to_string())
}

/// Read the current persisted mutation counter.
///
/// # Errors
/// Returns SQLite failures.
fn revision(conn: &Connection, room: i64) -> Result<u64, String> {
    conn.query_row(
        "SELECT revision FROM conference_chat_revisions WHERE room_id=?1",
        [room],
        |row| row.get(0),
    )
    .optional()
    .map(|value| value.unwrap_or(0))
    .map_err(|e| e.to_string())
}

/// Advance the persisted room mutation counter inside the same transaction.
///
/// # Errors
/// Returns SQLite failures.
fn advance(conn: &Connection, room: i64) -> Result<u64, String> {
    conn.execute("INSERT INTO conference_chat_revisions(room_id,revision) VALUES(?1,1) ON CONFLICT(room_id) DO UPDATE SET revision=revision+1", [room]).map_err(|e| e.to_string())?;
    revision(conn, room)
}

/// Read one chronological page of at most 100 retained messages.
///
/// # Errors
/// Rejects unavailable room authority and database failures.
pub(super) fn history(
    conn: &Connection,
    who: &Identity,
    before: Option<i64>,
) -> Result<History, String> {
    let room = room(conn, who)?;
    let mut statement = conn
        .prepare(&format!(
            "{PROJECTION} WHERE m.room_id=?1 AND m.id<?2 ORDER BY m.id DESC LIMIT 101"
        ))
        .map_err(|e| e.to_string())?;
    let mut messages = statement
        .query_map(params![room, before.unwrap_or(i64::MAX)], |row| {
            message(row, who)
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let has_more = messages.len() > 100;
    messages.truncate(100);
    messages.reverse();
    Ok(History {
        messages,
        has_more,
        revision: revision(conn, room)?,
    })
}

/// Append idempotently, claiming a staged attachment and pruning both room limits atomically.
///
/// # Errors
/// Rejects malformed records, retired authority, foreign attachments and deleted retries.
pub(super) fn append(
    conn: &mut Connection,
    who: &Identity,
    input: Submission,
    now: i64,
) -> Result<Mutation, String> {
    input.validate()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let room = room(&tx, who)?;
    let receipt: Option<Option<i64>> = tx.query_row("SELECT message_id FROM conference_chat_receipts WHERE room_id=?1 AND actor=?2 AND client_id=?3",
        params![room,who.actor,input.client_id], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
    if let Some(previous) = receipt {
        let id = previous.ok_or_else(|| "gone".to_string())?;
        return Ok(Mutation {
            message: Some(find(&tx, room, id, who)?),
            removed: vec![],
            revision: revision(&tx, room)?,
        });
    }
    if let Some(id) = &input.attachment_id {
        let owned: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM conference_chat_attachments a WHERE id=?1 AND room_id=?2 AND actor=?3 AND NOT EXISTS(SELECT 1 FROM conference_chat_messages WHERE attachment_id=a.id))",
            params![id,room,who.actor], |row| row.get(0)).map_err(|e| e.to_string())?;
        if !owned {
            return Err("denied".into());
        }
    }
    tx.execute("INSERT INTO conference_chat_messages(room_id,actor,client_id,name,avatar,body,attachment_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![room,who.actor,input.client_id,input.name,input.avatar,input.text,input.attachment_id,now]).map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    tx.execute("INSERT INTO conference_chat_receipts(room_id,actor,client_id,message_id) VALUES(?1,?2,?3,?4)",params![room,who.actor,input.client_id,id]).map_err(|e| e.to_string())?;
    let canonical = find(&tx, room, id, who)?;
    let removed = prune(&tx, room)?;
    tx.execute("DELETE FROM conference_chat_receipts WHERE room_id=?1 AND id NOT IN (SELECT id FROM conference_chat_receipts WHERE room_id=?1 ORDER BY id DESC LIMIT 10000)",[room]).map_err(|e| e.to_string())?;
    let revision = advance(&tx, room)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Mutation {
        message: Some(canonical),
        removed,
        revision,
    })
}

/// Prune oldest rows using cumulative attachment bytes and count from newest to oldest.
///
/// # Errors
/// Returns SQLite failures; delete triggers queue associated file cleanup durably.
fn prune(conn: &Connection, room: i64) -> Result<Vec<String>, String> {
    let mut statement = conn.prepare("SELECT id FROM (SELECT m.id,ROW_NUMBER() OVER(ORDER BY m.id DESC) AS position,SUM(COALESCE(a.size,0)) OVER(ORDER BY m.id DESC) AS bytes FROM conference_chat_messages m LEFT JOIN conference_chat_attachments a ON a.id=m.attachment_id WHERE m.room_id=?1) WHERE position>?2 OR bytes>?3").map_err(|e| e.to_string())?;
    let ids = statement
        .query_map(
            params![room, MESSAGE_LIMIT as i64, STORAGE_LIMIT as i64],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for id in &ids {
        conn.execute("DELETE FROM conference_chat_messages WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
    }
    Ok(ids.into_iter().map(|id| id.to_string()).collect())
}

/// Globally delete one exact room record after sender/presenter authorization; retries are idempotent.
///
/// # Errors
/// Rejects foreign sender deletion, retired authority and SQLite failures.
pub(super) fn delete(conn: &mut Connection, who: &Identity, id: i64) -> Result<Mutation, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let room = room(&tx, who)?;
    let owner: Option<String> = tx
        .query_row(
            "SELECT actor FROM conference_chat_messages WHERE room_id=?1 AND id=?2",
            params![room, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if owner
        .as_ref()
        .is_some_and(|owner| owner != &who.actor && !who.presenter)
    {
        return Err("denied".into());
    }
    tx.execute(
        "DELETE FROM conference_chat_messages WHERE room_id=?1 AND id=?2",
        params![room, id],
    )
    .map_err(|e| e.to_string())?;
    let revision = if owner.is_some() {
        advance(&tx, room)?
    } else {
        revision(&tx, room)?
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Mutation {
        message: None,
        removed: vec![id.to_string()],
        revision,
    })
}

/// Register one atomically published file after rechecking current room authority.
///
/// # Errors
/// Returns revoked authority and SQLite failures.
pub(super) fn register(
    conn: &Connection,
    who: &Identity,
    file: &Attachment,
    key: &str,
    now: i64,
) -> Result<(), String> {
    let room = room(conn, who)?;
    let staged: u64 = conn.query_row("SELECT COALESCE(SUM(size),0) FROM conference_chat_attachments a WHERE room_id=?1 AND NOT EXISTS(SELECT 1 FROM conference_chat_messages WHERE attachment_id=a.id)", [room], |row| row.get(0)).map_err(|e| e.to_string())?;
    if staged + file.size > 2 * FILE_LIMIT {
        return Err("capacity".into());
    }
    conn.execute("INSERT INTO conference_chat_attachments(id,room_id,actor,filename,storage_key,media_type,kind,size,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![file.id,room,who.actor,file.name,key,file.media_type,file.kind,file.size,now]).map_err(|e|e.to_string())?;
    Ok(())
}

/// Resolve only published attachments within the currently admitted room.
///
/// # Errors
/// Returns revoked room authority, missing attachments and database failures.
pub(super) fn attachment(
    conn: &Connection,
    who: &Identity,
    id: &str,
) -> Result<(Attachment, String), String> {
    let room = room(conn, who)?;
    conn.query_row("SELECT a.id,a.filename,a.media_type,a.kind,a.size,a.storage_key FROM conference_chat_attachments a JOIN conference_chat_messages m ON m.attachment_id=a.id WHERE a.room_id=?1 AND a.id=?2", params![room,id], |row| Ok((Attachment {id:row.get(0)?,name:row.get(1)?,media_type:row.get(2)?,kind:row.get(3)?,size:row.get(4)?},row.get(5)?))).optional().map_err(|e|e.to_string())?.ok_or_else(||"gone".into())
}
