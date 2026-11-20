//! One instance: a lock in the app's data folder, so a second launch leaves the first one running.

use std::fs::{DirBuilder, File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

/// The running app's hold on the lock. Only held, never read: dropping it lets go.
pub struct Instance(#[allow(dead_code)] File);

/// Takes `instance.lock` in `folder`, made if missing, without waiting: `Ok(None)` while another process holds it.
/// The lock is std's: `flock(LOCK_EX | LOCK_NB)` on unix, `LockFileEx` failing at once on Windows. Either ends with
/// the process, so a crashed app leaves no lock behind.
pub fn acquire(folder: &Path) -> io::Result<Option<Instance>> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    // The app's data folder is the person's alone, as the log and state.json make it.
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(folder)?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options.open(folder.join("instance.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(Instance(file))),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_acquire_is_refused_until_the_first_is_dropped() {
        let folder = tempfile::tempdir().unwrap();
        let first = acquire(folder.path()).unwrap().expect("the first launch takes the lock");
        assert!(acquire(folder.path()).unwrap().is_none());
        // A relaunch lets go first: the new process then takes the lock while the old one is still exiting.
        drop(first);
        assert!(acquire(folder.path()).unwrap().is_some());
    }

    #[test]
    fn the_folder_is_made() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("Harness Device").join("ai.autonomous.harness.device");
        let _held = acquire(&folder).unwrap().expect("a new folder's lock is free");
        assert!(folder.join("instance.lock").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!((mode(&folder), mode(&folder.join("instance.lock"))), (0o700, 0o600));
        }
    }
}
