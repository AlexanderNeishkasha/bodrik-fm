//! Classified operation failures, so handlers map HTTP statuses by variant, not message text.

use crate::api::{internal_error_response, json_message};
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use std::fmt;

/// Operation failure carrying its public classification.
///
/// Unclassified `String` errors convert into [`OpError::Internal`], so existing `?`
/// chains keep working while known outcomes stay typed.
#[derive(Debug, PartialEq)]
pub(crate) enum OpError {
    /// The target room, track, section or job no longer exists (404 `missing`).
    Missing,
    /// A stable public conflict such as `slug exists` or `playing` (409).
    Conflict(&'static str),
    /// Input rejected while applying the operation, such as `invalid order` (400).
    Rejected(&'static str),
    /// Operational failure; logged with context and never exposed to clients.
    Internal(String),
}

impl OpError {
    /// Build the browser response, logging internal failures under `context`.
    pub(crate) fn respond(self, context: &str) -> Response {
        match self {
            Self::Missing => json_message(StatusCode::NOT_FOUND, "missing").into_response(),
            Self::Conflict(message) => json_message(StatusCode::CONFLICT, message).into_response(),
            Self::Rejected(message) => {
                json_message(StatusCode::BAD_REQUEST, message).into_response()
            }
            Self::Internal(error) => internal_error_response(context, error),
        }
    }

    /// Map a UNIQUE violation of `constraint` to `Conflict(message)`; other errors stay internal.
    ///
    /// `constraint` is the index name for expression indexes (`idx_...`) or `table.column`
    /// for column constraints, as SQLite names it in the failure message.
    pub(crate) fn on_unique(
        constraint: &'static str,
        message: &'static str,
    ) -> impl FnOnce(rusqlite::Error) -> Self {
        move |error| {
            if is_unique_violation(&error, constraint) {
                Self::Conflict(message)
            } else {
                Self::Internal(error.to_string())
            }
        }
    }
}

/// Return whether `error` is SQLite's UNIQUE failure for exactly the named constraint.
fn is_unique_violation(error: &rusqlite::Error, constraint: &str) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, Some(message))
            if failure.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
                && message.contains(constraint)
    )
}

impl fmt::Display for OpError {
    /// Render the public message, or the internal detail for logs.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => f.write_str("missing"),
            Self::Conflict(message) | Self::Rejected(message) => f.write_str(message),
            Self::Internal(error) => f.write_str(error),
        }
    }
}

impl From<String> for OpError {
    /// Treat unclassified string failures as internal.
    fn from(error: String) -> Self {
        Self::Internal(error)
    }
}

impl From<&str> for OpError {
    /// Treat unclassified string failures as internal.
    fn from(error: &str) -> Self {
        Self::Internal(error.to_owned())
    }
}

/// Status/body mapping and structured UNIQUE detection against real SQLite failures.
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Each variant keeps the status and public message its string predecessor produced.
    #[test]
    fn respond_cases() {
        for (name, error, status) in [
            ("missing", OpError::Missing, StatusCode::NOT_FOUND),
            (
                "conflict",
                OpError::Conflict("slug exists"),
                StatusCode::CONFLICT,
            ),
            (
                "rejected",
                OpError::Rejected("invalid order"),
                StatusCode::BAD_REQUEST,
            ),
            (
                "internal",
                OpError::Internal("disk".into()),
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
        ] {
            assert_eq!(error.respond("test").status(), status, "{name}");
        }
    }

    /// Only a UNIQUE failure on the named constraint becomes a conflict.
    #[test]
    fn on_unique_cases() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE users(login TEXT UNIQUE, age INTEGER NOT NULL);
            CREATE TABLE tracks(title TEXT);
            CREATE UNIQUE INDEX idx_tracks_title ON tracks(lower(title));
            INSERT INTO users VALUES('a', 1);
            INSERT INTO tracks VALUES('A');",
        )
        .unwrap();
        for (name, sql, constraint, expected) in [
            (
                "column unique",
                "INSERT INTO users VALUES('a', 2)",
                "users.login",
                OpError::Conflict("exists"),
            ),
            (
                "expression index",
                "INSERT INTO tracks VALUES('a')",
                "idx_tracks_title",
                OpError::Conflict("exists"),
            ),
            (
                "other unique constraint",
                "INSERT INTO tracks VALUES('a')",
                "users.login",
                OpError::Internal("UNIQUE constraint failed: index 'idx_tracks_title'".into()),
            ),
            (
                "not unique",
                "INSERT INTO users VALUES('b', NULL)",
                "users.login",
                OpError::Internal("NOT NULL constraint failed: users.age".into()),
            ),
        ] {
            let error = conn.execute(sql, []).unwrap_err();
            assert_eq!(
                OpError::on_unique(constraint, "exists")(error),
                expected,
                "{name}"
            );
        }
    }
}
