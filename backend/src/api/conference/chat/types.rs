//! Bounded durable public chat contract; actors remain private to the meeting service.
use serde::{Deserialize, Serialize};

/// Maximum public messages retained per stable room.
pub(super) const MESSAGE_LIMIT: usize = 1000;
/// Maximum retained attachment bytes per room (one GiB).
pub(super) const STORAGE_LIMIT: u64 = 1024 * 1024 * 1024;
/// Maximum one document upload.
pub(super) const FILE_LIMIT: u64 = 100 * 1024 * 1024;
/// Maximum one verified image upload.
pub(super) const IMAGE_LIMIT: u64 = 5 * 1024 * 1024;

/// Meeting-server assertions obtained only after service-bearer authentication.
#[derive(Clone)]
pub(super) struct Identity {
    /// Exact currently enabled private provider mapping.
    pub conference: String,
    /// Expected durable revocation generation.
    pub generation: i64,
    /// Stable actor from the verified meeting ticket, never a nickname.
    pub actor: String,
    /// Current meeting role verified by the meeting runtime.
    pub presenter: bool,
}

/// Metadata for a staged or published attachment; bytes never enter SQLite.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Attachment {
    /// Opaque immutable attachment identity.
    pub id: String,
    /// Exact display and download filename provided by the browser.
    pub name: String,
    /// Validated content type (binary for documents).
    pub media_type: String,
    /// Image or document rendering vocabulary.
    pub kind: String,
    /// Exact verified stored length.
    pub size: u64,
}

/// Canonical persisted message returned only over the private interservice API.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Message {
    /// SQLite sequence rendered as text to avoid JavaScript integer truncation.
    pub id: String,
    /// Server-captured display name at submission.
    pub name: String,
    /// Validated local avatar path at submission.
    pub avatar: String,
    /// Text or attachment caption.
    pub text: String,
    /// Server millisecond UTC timestamp.
    pub created_at: i64,
    /// Current request actor authored the message.
    pub own: bool,
    /// Current actor may remove this message globally.
    pub can_delete: bool,
    /// Optional durable attachment.
    pub attachment: Option<Attachment>,
}

/// Strict public submission; internal actors and roles are supplied through authenticated headers.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Submission {
    /// Browser-generated idempotency nonce.
    pub client_id: String,
    /// Server-snapshotted display name.
    pub name: String,
    /// Server-validated local avatar path.
    pub avatar: String,
    /// Bounded text or caption; may be empty only with an attachment.
    pub text: String,
    /// Optional staged attachment owned by this exact room and actor.
    pub attachment_id: Option<String>,
}

impl Submission {
    /// Reject malformed UTF-16 budgets and arbitrary avatar/attachment paths.
    ///
    /// # Errors
    /// Returns a sanitized validation error before any database mutation.
    pub fn validate(&self) -> Result<(), String> {
        if self.client_id.trim().is_empty()
            || self.client_id.len() > 160
            || self.name.trim().is_empty()
            || self.name.encode_utf16().count() > 64
            || self.text.encode_utf16().count() > 4000
            || (self.text.trim().is_empty() && self.attachment_id.is_none())
            || (!self.avatar.is_empty() && !valid_avatar(&self.avatar))
            || self.attachment_id.as_ref().is_some_and(|id| !uuid_key(id))
        {
            return Err("invalid".into());
        }
        Ok(())
    }
}

/// Recognize only a canonical lowercase UUID as an attachment handle.
pub(super) fn uuid_key(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

/// Preserve existing same-origin avatar paths without accepting arbitrary URL schemes.
fn valid_avatar(value: &str) -> bool {
    value.strip_prefix("/uploads/avatars/").is_some_and(|name| {
        name.rsplit_once('.')
            .is_some_and(|(id, ext)| uuid_key(id) && matches!(ext, "png" | "jpg" | "webp"))
    })
}

/// Bounded history page with a snapshot revision for racing live-event reconciliation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct History {
    /// Chronological page, newest selected first in SQL then reversed for rendering.
    pub messages: Vec<Message>,
    /// Durable room mutation revision.
    pub revision: u64,
    /// Earlier retained messages are available.
    pub has_more: bool,
}

/// One committed mutation and any entries pruned by its retention transaction.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Mutation {
    /// Canonical submitted message, absent for deletion.
    pub message: Option<Message>,
    /// Deleted/pruned message identities, never a fabricated local deletion.
    pub removed: Vec<String>,
    /// Durable room mutation revision.
    pub revision: u64,
}
