//! File operations the host's state files share.

use std::io::{self, Write};
use std::path::Path;

/// Replace `path` with `body` atomically, through the temporary file `tmp` in the same
/// directory: a reader sees the old file or the whole new one. The temporary file is created new
/// and the owner's alone from the start (mode 0600 on Unix; on Windows the user-only DACL given
/// at creation), so nothing written to it is ever readable by anyone else. A temporary file an
/// earlier host left behind is removed first.
pub fn replace_private(tmp: &Path, path: &Path, body: &[u8]) -> io::Result<()> {
    let written = (|| {
        match std::fs::remove_file(tmp) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        let mut file = create_private(tmp)?;
        file.write_all(body)?;
        file.sync_all()?;
        drop(file);
        rename(tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    written
}

fn create_private(path: &Path) -> io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        // Whatever the umask took away, exactly 0600.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        Ok(file)
    }
    #[cfg(windows)]
    {
        crate::transport::windows::create_private_file(path)
    }
}

/// `std::fs::rename`, which on Windows is tried again for a moment when the file is busy: a
/// virus scanner or the indexer may hold a handle on a file the host just wrote, and replacing it
/// then fails with access denied or a sharing violation.
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        const ERROR_ACCESS_DENIED: i32 = 5;
        const ERROR_SHARING_VIOLATION: i32 = 32;
        const ERROR_LOCK_VIOLATION: i32 = 33;
        // 10 + 20 + … + 320 ms: about 0.6 s in all.
        let mut wait = std::time::Duration::from_millis(10);
        for _ in 0..6 {
            match std::fs::rename(from, to) {
                Err(e)
                    if matches!(
                        e.raw_os_error(),
                        Some(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
                    ) =>
                {
                    std::thread::sleep(wait);
                    wait *= 2;
                }
                done => return done,
            }
        }
    }
    std::fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_private_writes_a_new_private_file_over_the_old_and_a_stale_temporary() {
        let dir = tempfile::tempdir().unwrap();
        let (tmp, path) = (dir.path().join("f.tmp"), dir.path().join("f"));
        std::fs::write(&path, "old").unwrap();
        // Left by a host that died mid-write, readable by anyone.
        std::fs::write(&tmp, "stale").unwrap();
        replace_private(&tmp, &path, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert!(!tmp.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        #[cfg(windows)]
        crate::transport::windows::file_dacl(&path).assert_users_alone(false);
    }

    #[cfg(windows)]
    #[test]
    fn a_private_file_is_the_users_alone_from_its_creation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p");
        // Open, nothing written yet: the DACL is already the user's alone, nothing inherited.
        let file = create_private(&path).unwrap();
        crate::transport::windows::file_dacl(&path).assert_users_alone(false);
        drop(file);
        // A new file: one that exists is not opened.
        assert!(create_private(&path).is_err());
    }

    #[test]
    fn renames_over_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&from, "new").unwrap();
        std::fs::write(&to, "old").unwrap();
        rename(&from, &to).unwrap();
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "new");
        assert!(!from.exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_target_held_open_for_a_moment_is_replaced_once_it_is_let_go() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&from, "new").unwrap();
        std::fs::write(&to, "old").unwrap();
        // A scanner's handle: no delete sharing, so the file cannot be replaced while it is open.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1) // FILE_SHARE_READ
            .open(&to)
            .unwrap();
        assert!(
            std::fs::rename(&from, &to).is_err(),
            "the held file was replaced: the test shows nothing"
        );
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(held);
        });
        rename(&from, &to).unwrap();
        release.join().unwrap();
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "new");
    }
}
