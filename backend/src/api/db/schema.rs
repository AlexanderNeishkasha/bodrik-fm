//! SQLite opening and transactional, ordered schema migrations.

use crate::api::AppState;
use rusqlite::{Connection, OptionalExtension, params};
use std::{fs, path::Path};

/// Open the SQLite database with write-ahead logging, a lock wait budget and
/// foreign-key enforcement.
///
/// WAL with `synchronous = NORMAL` shortens each commit while the shared connection mutex
/// is held; `busy_timeout` waits briefly instead of failing if another process (backup or
/// inspection tooling) holds the file lock.
///
/// # Errors
/// Returns directory creation, opening or configuration errors.
pub fn open_database(path: &str) -> Result<Connection, String> {
    let db_path = Path::new(path);
    if let Some(parent) = db_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let conn = Connection::open(path).map_err(|err| err.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;",
    )
    .map_err(|err| err.to_string())?;
    Ok(conn)
}

/// Apply each pending migration and its tracking row in the same transaction.
/// Migration scripts must not contain their own transaction control statements.
///
/// # Errors
/// Returns directory-entry/read, lock, SQL or commit errors. A failed migration
/// rolls back its SQL and does not acquire an applied marker.
pub fn run_migrations(state: &AppState, dir: &str) -> Result<(), String> {
    let mut entries = fs::read_dir(dir)
        .map_err(|err| format!("migration dir read failed: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("migration entry read failed: {err}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut conn = state.db.lock().map_err(|_| "db lock poisoned")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );",
    )
    .map_err(|err| err.to_string())?;
    for entry in entries {
        let path = entry.path();
        let Some(version) = migration_version(&path) else {
            continue;
        };
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        let applied: Option<String> = tx
            .query_row(
                "SELECT version FROM schema_migrations WHERE version = ?1",
                params![version],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        if applied.is_some() {
            continue;
        }
        let sql = fs::read_to_string(&path)
            .map_err(|err| format!("migration {version} read failed: {err}"))?;
        tx.execute_batch(&sql)
            .map_err(|err| format!("migration {version} failed: {err}"))?;
        tx.execute(
            "INSERT INTO schema_migrations(version) VALUES(?1)",
            params![version],
        )
        .map_err(|err| format!("migration {version} tracking failed: {err}"))?;
        tx.commit()
            .map_err(|err| format!("migration {version} commit failed: {err}"))?;
    }
    Ok(())
}

/// Select SQL migration filenames; non-SQL paths aren't migration versions.
fn migration_version(path: &Path) -> Option<&str> {
    if path.extension()?.to_str()? != "sql" {
        return None;
    }
    path.file_name()?.to_str()
}

/// Pure filename-policy tests, not database or filesystem fixture tests.
#[cfg(test)]
mod tests {
    use super::*;

    /// Only lowercase SQL extensions are accepted, preserving existing ordering policy.
    #[test]
    fn migration_filename_cases() {
        for (path, expected) in [
            ("0001_init.sql", Some("0001_init.sql")),
            ("migrations/0017_retire.sql", Some("0017_retire.sql")),
            ("README.md", None),
            ("0001.SQL", None),
            ("no_extension", None),
            ("", None),
        ] {
            assert_eq!(migration_version(Path::new(path)), expected, "{path}");
        }
    }

    /// File-backed connections apply every connection pragma; WAL needs a real file.
    #[test]
    fn open_database_pragmas() {
        let directory = std::env::temp_dir().join(format!("db-open-{}", uuid::Uuid::new_v4()));
        let path = directory.join("app.db");
        let conn = open_database(path.to_str().unwrap()).unwrap();
        for (pragma, expected) in [
            ("journal_mode", "wal"),
            ("synchronous", "1"),
            ("busy_timeout", "5000"),
            ("foreign_keys", "1"),
        ] {
            let value = conn
                .pragma_query_value(None, pragma, |row| row.get::<_, rusqlite::types::Value>(0))
                .unwrap();
            let value = match value {
                rusqlite::types::Value::Integer(number) => number.to_string(),
                rusqlite::types::Value::Text(text) => text,
                other => panic!("{pragma}: unexpected {other:?}"),
            };
            assert_eq!(value, expected, "{pragma}");
        }
        drop(conn);
        fs::remove_dir_all(directory).unwrap();
    }
}
