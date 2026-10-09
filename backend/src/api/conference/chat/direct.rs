//! Typed storage services shared with the embedded meeting, without HTTP authentication shortcuts.
use super::{ChatState, database, files, store, types::*};
use meeting_backend::integration::services::{ChatIdentity, ChatOperation, Upload};
use serde_json::{Value, json};

#[cfg(test)]
mod storage_tests;

/// Validate trusted session claims before consulting fresh SQLite mapping authority.
///
/// # Errors
/// Rejects malformed identities and generations outside the persisted wire range.
fn identity(who: ChatIdentity) -> Result<Identity, String> {
    if who.conference.is_empty()
        || who.conference.len() > 160
        || who.actor.is_empty()
        || who.actor.len() > 160
        || who.generation > 9_007_199_254_740_991
        || !who
            .conference
            .bytes()
            .chain(who.actor.bytes())
            .all(|v| v.is_ascii_alphanumeric() || b"_.:-".contains(&v))
    {
        return Err("invalid".into());
    }
    Ok(Identity {
        conference: who.conference,
        generation: i64::try_from(who.generation).map_err(|_| "invalid")?,
        actor: who.actor,
        presenter: who.presenter,
    })
}

/// Execute a typed storage capability off-thread, preserving existing ownership/retention rules.
///
/// # Errors
/// Returns invalid inputs, stale mappings, foreign ownership or storage failures.
pub(crate) async fn execute(
    state: &ChatState,
    who: ChatIdentity,
    operation: ChatOperation,
) -> Result<Value, String> {
    let who = identity(who)?;
    database(state, move |conn| {
        match operation {
            ChatOperation::History(before) => {
                if before.is_some_and(|id| id < 1) {
                    return Err("invalid".into());
                }
                serde_json::to_value(store::history(conn, &who, before)?)
            }
            ChatOperation::Append(input) => serde_json::to_value(store::append(
                conn,
                &who,
                Submission {
                    client_id: input.client_id,
                    name: input.name,
                    avatar: input.avatar,
                    text: input.text,
                    attachment_id: input.attachment_id,
                },
                chrono::Utc::now().timestamp_millis(),
            )?),
            ChatOperation::Delete(id) => {
                if id < 1 {
                    return Err("invalid".into());
                }
                serde_json::to_value(store::delete(conn, &who, id)?)
            }
            ChatOperation::Attachment(id) => {
                if !uuid_key(&id) {
                    return Err("invalid".into());
                }
                let (attachment, key) = store::attachment(conn, &who, &id)?;
                return Ok(json!({"attachment":attachment,"storageKey":key}));
            }
        }
        .map_err(|error| error.to_string())
    })
    .await
}

/// Receive bytes through the same metadata validation and publication code as standalone uploads.
///
/// # Errors
/// Rejects invalid metadata, stale authority, oversized bodies and storage failures.
pub(crate) async fn upload(
    state: &ChatState,
    who: ChatIdentity,
    upload: Upload,
) -> Result<Value, String> {
    let who = identity(who)?;
    let mut request = axum::extract::Request::new(upload.body);
    for (name, value) in [
        ("x-file-name", upload.encoded_name),
        ("content-type", upload.media_type),
        ("x-file-size", upload.size.to_string()),
    ] {
        request
            .headers_mut()
            .insert(name, value.parse().map_err(|_| "invalid")?);
    }
    let metadata = files::metadata_input(request.headers()).map_err(|status| match status {
        axum::http::StatusCode::PAYLOAD_TOO_LARGE => "capacity",
        _ => "invalid",
    })?;
    let file = files::publish(state, who, metadata, request).await?;
    serde_json::to_value(file).map_err(|error| error.to_string())
}

/// Identity validation remains strict even though callers no longer send service bearers.
#[cfg(test)]
mod tests {
    use super::*;
    /// Reject caller-shaped malformed identifiers and out-of-range durable generations.
    #[test]
    fn identity_cases() {
        for (name, actor, generation, valid) in [
            ("valid", "guest:one", 2, true),
            ("empty", "", 0, false),
            ("path", "../actor", 0, false),
            ("overflow", "one", u64::MAX, false),
        ] {
            assert_eq!(
                identity(ChatIdentity {
                    conference: "room".into(),
                    actor: actor.into(),
                    generation,
                    presenter: false
                })
                .is_ok(),
                valid,
                "{name}"
            );
        }
    }
}
