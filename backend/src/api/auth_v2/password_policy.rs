//! Shared byte-length and confirmation policy for registration and password changes.

/// Validate a 4–128-byte password and optional exact confirmation.
///
/// # Errors
/// Returns the existing browser-facing validation message for length or mismatch.
pub(crate) fn validate(password: &str, confirmation: Option<&str>) -> Result<(), &'static str> {
    if !(4..=128).contains(&password.len()) {
        return Err("password must be 4-128 chars");
    }
    if confirmation.is_some_and(|value| value != password) {
        return Err("password confirmation mismatch");
    }
    Ok(())
}

/// Pure boundary coverage shared by all password mutation entry points.
#[cfg(test)]
mod tests {
    use super::*;

    /// Password lengths are UTF-8 bytes; confirmation is optional but exact if present.
    #[test]
    fn password_cases() {
        let cases = [
            (
                "empty",
                "".into(),
                None,
                Some("password must be 4-128 chars"),
            ),
            (
                "short",
                "abc".into(),
                None,
                Some("password must be 4-128 chars"),
            ),
            ("minimum", "abcd".into(), None, None),
            ("maximum", "x".repeat(128), None, None),
            (
                "too long",
                "x".repeat(129),
                None,
                Some("password must be 4-128 chars"),
            ),
            ("unicode bytes", "яя".into(), None, None),
            ("confirmation", "abcd".into(), Some("abcd"), None),
            (
                "mismatch",
                "abcd".into(),
                Some("abce"),
                Some("password confirmation mismatch"),
            ),
            (
                "empty confirmation",
                "abcd".into(),
                Some(""),
                Some("password confirmation mismatch"),
            ),
        ];
        for (name, password, confirmation, error) in cases {
            assert_eq!(validate(&password, confirmation).err(), error, "{name}");
        }
    }
}
