//! Small helpers the unit tests share.
//!
//! Compiled only under `cfg(test)`, so nothing here ships in the binary. A
//! hand-rolled temporary directory keeps the dependency list to what the daemon
//! itself needs: adding a dev-dependency for four lines of `create_dir_all`
//! would put another crate in the supply chain of a binary whose whole job is
//! holding keys.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A directory under the system temp dir, removed when the handle drops.
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new() -> Self {
        let unique = format!(
            "varlock-test-{}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&path).expect("could not create a temp dir for the test");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
