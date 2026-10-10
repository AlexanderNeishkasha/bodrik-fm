//! Pure library ordering decisions and fallible SQLite row collection.

use crate::api::op_error::OpError;

/// Collect integer query rows without discarding query or per-row errors.
///
/// # Errors
/// Returns the original query/row conversion error as text.
pub(crate) fn collect_i64(
    rows: rusqlite::Result<
        rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<i64>>,
    >,
) -> Result<Vec<i64>, String> {
    rows.map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

/// Accept an exact permutation of unique IDs, rejecting duplicates and partial lists.
pub(crate) fn same_id_set(left: &[i64], right: &[i64]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut left = left.to_vec();
    let mut right = right.to_vec();
    left.sort_unstable();
    right.sort_unstable();
    left.windows(2).all(|pair| pair[0] != pair[1]) && left == right
}

/// Convert an index to SQLite's signed integer range and add it without overflow.
///
/// # Errors
/// Returns `Rejected("invalid order")` for index conversion or signed addition overflow.
pub(crate) fn checked_order(base: i64, index: usize) -> Result<i64, OpError> {
    let invalid = || OpError::Rejected("invalid order");
    let index = i64::try_from(index).map_err(|_| invalid())?;
    base.checked_add(index).ok_or_else(invalid)
}

/// Pure duplicate/permutation/arithmetic tests; no SQLite fixtures.
#[cfg(test)]
mod tests {
    use super::*;

    /// Both matching and malformed reorder lists cover length, identity and duplicate branches.
    #[test]
    fn permutation_cases() {
        let cases: &[(&str, &[i64], &[i64], bool)] = &[
            ("empty", &[], &[], true),
            ("same", &[1, 2], &[1, 2], true),
            ("reordered", &[1, 2], &[2, 1], true),
            ("missing", &[1, 2], &[1], false),
            ("extra", &[1], &[1, 2], false),
            ("other", &[1, 2], &[1, 3], false),
            ("duplicate input", &[1, 2], &[1, 1], false),
            ("duplicate source", &[1, 1], &[1, 1], false),
        ];
        for (name, left, right, expected) in cases {
            assert_eq!(same_id_set(left, right), *expected, "{name}");
        }
    }

    /// Signed addition and platform-sized index conversions reject overflow explicitly.
    #[test]
    fn order_cases() {
        for (base, index, expected) in [
            (-1, 1, Some(0)),
            (0, 0, Some(0)),
            (10, 2, Some(12)),
            (i64::MAX, 0, Some(i64::MAX)),
            (i64::MAX, 1, None),
        ] {
            assert_eq!(
                checked_order(base, index).ok(),
                expected,
                "base={base}, index={index}"
            );
        }
        let expected = i64::try_from(usize::MAX).ok();
        assert_eq!(checked_order(0, usize::MAX).ok(), expected);
    }
}
