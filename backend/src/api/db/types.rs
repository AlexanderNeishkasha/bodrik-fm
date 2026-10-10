//! Persistence records returned to application operations.

/// Current account and owned room, including secrets only for server-side verification.
#[derive(Debug, Clone)]
pub struct UserRecord {
    /// Account identifier.
    pub id: i64,
    /// Normalized login.
    pub login: String,
    /// Current authorization role.
    pub role: String,
    /// Salted password hash; never serialize to browser payloads.
    pub password_hash: String,
    /// Whether the account may authenticate.
    pub is_active: bool,
    /// Owned room identifier.
    pub room_id: i64,
    /// Public room slug.
    pub room_slug: String,
    /// Public directory visibility.
    pub room_listed: bool,
}

/// Minimal room identity used by public lookup and runtime creation.
#[derive(Debug, Clone)]
pub struct RoomRecord {
    /// Database room identifier.
    pub id: i64,
    /// Public URL segment.
    pub slug: String,
}

/// Non-secret account/room row for administrator listings.
#[derive(Debug, Clone)]
pub struct AdminUserRow {
    /// Account identifier.
    pub id: i64,
    /// Account login.
    pub login: String,
    /// Current role.
    pub role: String,
    /// Owned room slug.
    pub room_slug: String,
    /// Public directory visibility.
    pub room_listed: bool,
    /// Creation timestamp.
    pub created_at: String,
}

/// Result of detaching a room track and deciding whether its file is unreferenced.
#[derive(Debug, Clone)]
pub struct DeleteTrackOutcome {
    /// Whether the room-owned track existed and was deleted.
    pub deleted: bool,
    /// Upload storage key to remove after transaction commit; prepared files remain shared.
    pub cleanup_storage_key: Option<String>,
}

/// Accept an unknown duration or a finite, nonnegative media duration.
pub(super) fn valid_duration(duration: Option<f64>) -> bool {
    duration.is_none_or(|value| value.is_finite() && value >= 0.0)
}

/// Pure persisted-duration boundary policy.
#[cfg(test)]
mod tests {
    use super::*;

    /// Unknown, finite and non-finite/negative probes follow explicit branches.
    #[test]
    fn duration_cases() {
        for (name, duration, valid) in [
            ("unknown", None, true),
            ("zero", Some(0.0), true),
            ("positive", Some(1.25), true),
            ("negative", Some(-1.0), false),
            ("nan", Some(f64::NAN), false),
            ("infinity", Some(f64::INFINITY), false),
            ("negative infinity", Some(f64::NEG_INFINITY), false),
        ] {
            assert_eq!(valid_duration(duration), valid, "{name}");
        }
    }
}
