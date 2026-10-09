//! Pure conference grant binding decisions, independent of HTTP/SQLite/provider I/O.

use super::db::Conference;

/// Require entitlement, enablement, configured adapter and a nonempty private mapping.
pub(super) fn joinable(conference: &Conference, provider: &str) -> bool {
    conference.allowed
        && conference.enabled
        && conference.provider.as_deref() == Some(provider)
        && conference
            .provider_room_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
}

/// Pure binding/entitlement branch tables; no room or provider fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Construct an in-memory domain record, not a database-backed fixture.
    fn conference() -> Conference {
        Conference {
            allowed: true,
            enabled: true,
            provider_room_id: Some("private".into()),
            room_slug: "room".into(),
            provider: Some("mirotalk".into()),
            room_id: 1,
            generation: 0,
        }
    }

    /// Every grant precondition can independently reject admission.
    #[test]
    fn grant_cases() {
        for case in 0..7 {
            let mut value = conference();
            match case {
                1 => value.allowed = false,
                2 => value.enabled = false,
                3 => value.provider = None,
                4 => value.provider = Some("other".into()),
                5 => value.provider_room_id = None,
                6 => value.provider_room_id = Some(String::new()),
                _ => {}
            }
            assert_eq!(joinable(&value, "mirotalk"), case == 0);
        }
    }
}
