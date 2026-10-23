//! `<home>/run/pty-host-<instance>.lock`: one host per home.
//!
//! A host takes the lock before it binds its endpoint or reserves pane ids, and holds it for its
//! life; a host that cannot take it exits as one that found another host serving. Without it, two
//! hosts starting together on a stale Unix socket could each remove the other's socket, bind,
//! and reserve the same block of pane ids (Task 15 review).
//!
//! - Unix: `flock(LOCK_EX | LOCK_NB)` on the file. The kernel drops it with the process.
//! - Windows: the file open with no sharing. The pipe name is random per start
//!   (transport/windows.rs), so it is no lock at all; the file is the home's own.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};


pub fn file_path(run_dir: &Path) -> PathBuf {
    crate::instance::run_file(run_dir, &crate::instance::current(), "lock")
}

/// The lock, held while this lives.
#[derive(Debug)]
pub struct HostLock {
    _file: File,
}

/// Take the lock of `run_dir`, or `None` when another host holds it.
pub fn take(run_dir: &Path) -> io::Result<Option<HostLock>> {
    let path = file_path(run_dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::io::AsRawFd;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&path)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let err = io::Error::last_os_error();
            return if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
                Ok(None)
            } else {
                Err(err)
            };
        }
        Ok(Some(HostLock { _file: file }))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use std::time::Duration;
        const ERROR_SHARING_VIOLATION: i32 = 32;
        // A scanner or indexer that opened the file a moment ago looks like another host: look
        // a few times before believing it.
        let mut wait = Duration::from_millis(20);
        let mut tries = 0;
        loop {
            let opened = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .share_mode(0)
                .open(&path);
            match opened {
                Ok(file) => return Ok(Some(HostLock { _file: file })),
                Err(e) if e.raw_os_error() == Some(ERROR_SHARING_VIOLATION) => {
                    tries += 1;
                    if tries >= 5 {
                        return Ok(None);
                    }
                    std::thread::sleep(wait);
                    wait *= 2;
                }
                Err(e) => return Err(e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_holder_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let first = take(dir.path()).unwrap();
        assert!(first.is_some());
        // Another open of the file, in this process or another, cannot have it.
        assert!(take(dir.path()).unwrap().is_none());
        drop(first);
        assert!(take(dir.path()).unwrap().is_some());
    }

    #[test]
    fn a_missing_run_dir_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(take(&dir.path().join("missing")).is_err());
    }
}
