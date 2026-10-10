//! Owned media artifact cleanup, dispatched off the async executor on cancellation.

use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

/// Cleanup operation for an exclusively owned media artifact.
#[derive(Clone, Copy)]
enum Kind {
    /// A temporary or unpublished original file.
    File,
    /// An exclusively owned staging or per-asset HLS directory.
    Directory,
}

/// One owned artifact, never a user-selected path or shared media directory.
struct Artifact {
    /// Server-generated artifact path.
    path: PathBuf,
    /// Removal operation.
    kind: Kind,
}

/// Single source of remaining cleanup obligations, independent of runtime/file I/O.
#[derive(Default)]
struct Plan {
    /// Exclusively owned paths still requiring removal.
    artifacts: Vec<Artifact>,
}

impl Plan {
    /// Transfer a committed path out of cleanup ownership.
    fn keep(&mut self, path: &Path) {
        self.artifacts.retain(|item| item.path != path);
    }
}

/// Own temporary/uncommitted media paths across awaits and worker transfers.
pub(crate) struct Artifacts {
    /// Current cleanup obligations.
    plan: Plan,
    /// Runtime on which blocking cleanup remains owned after a request is cancelled.
    handle: tokio::runtime::Handle,
}

impl Artifacts {
    /// Create a guard in a Tokio request/task context.
    ///
    /// # Panics
    /// Panics if called outside the application's Tokio runtime.
    pub(crate) fn new() -> Self {
        Self {
            plan: Plan::default(),
            handle: tokio::runtime::Handle::current(),
        }
    }

    /// Register an exclusively owned temporary/unpublished file before writing it.
    pub(crate) fn file(&mut self, path: PathBuf) {
        self.plan.artifacts.push(Artifact {
            path,
            kind: Kind::File,
        });
    }

    /// Register only owned staging/per-asset directories, never a shared media root.
    pub(crate) fn directory(&mut self, path: PathBuf) {
        self.plan.artifacts.push(Artifact {
            path,
            kind: Kind::Directory,
        });
    }

    /// Preserve a path only after its database transaction committed successfully.
    pub(crate) fn keep(&mut self, path: &Path) {
        self.plan.keep(path);
    }
}

impl Drop for Artifacts {
    /// Dispatch remaining cleanup off-thread; temporary paths remain owned after commit.
    fn drop(&mut self) {
        let plan = std::mem::take(&mut self.plan);
        if plan.artifacts.is_empty() {
            return;
        }
        // Intentionally detached from the request: the runtime owns cleanup completion.
        let _cleanup = self.handle.spawn_blocking(move || {
            for item in plan.artifacts {
                for attempt in 0..3 {
                    let result = match item.kind {
                        Kind::File => std::fs::remove_file(&item.path),
                        Kind::Directory => std::fs::remove_dir_all(&item.path),
                    };
                    match result {
                        Ok(()) => break,
                        Err(error) if error.kind() == ErrorKind::NotFound => break,
                        Err(error) if attempt < 2 && retryable(error.kind()) => {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                        Err(error) => {
                            tracing::error!(path = %item.path.display(), %error, "media artifact cleanup failed");
                            break;
                        }
                    }
                }
            }
        });
    }
}

/// Retry short-lived file-handle/directory races, not arbitrary persistent I/O errors.
fn retryable(kind: ErrorKind) -> bool {
    matches!(
        kind,
        ErrorKind::PermissionDenied | ErrorKind::WouldBlock | ErrorKind::DirectoryNotEmpty
    )
}

/// Pure cleanup ownership/error decisions; no files are created or removed.
#[cfg(test)]
mod tests {
    use super::*;

    /// Commit keeps only its registered media paths, never temporary upload obligations.
    #[test]
    fn ownership_cases() {
        for committed in [false, true] {
            let mut plan = Plan {
                artifacts: vec![
                    Artifact {
                        path: "temporary".into(),
                        kind: Kind::File,
                    },
                    Artifact {
                        path: "original".into(),
                        kind: Kind::File,
                    },
                    Artifact {
                        path: "hls".into(),
                        kind: Kind::Directory,
                    },
                ],
            };
            if committed {
                plan.keep(Path::new("original"));
                plan.keep(Path::new("hls"));
            }
            assert_eq!(plan.artifacts.len(), if committed { 1 } else { 3 });
            assert_eq!(plan.artifacts[0].path, Path::new("temporary"));
        }
        for (kind, retry) in [
            (ErrorKind::PermissionDenied, true),
            (ErrorKind::WouldBlock, true),
            (ErrorKind::DirectoryNotEmpty, true),
            (ErrorKind::NotFound, false),
            (ErrorKind::InvalidInput, false),
        ] {
            assert_eq!(retryable(kind), retry);
        }
    }
}
