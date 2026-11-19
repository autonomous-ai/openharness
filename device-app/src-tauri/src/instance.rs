//! One instance: a lock in the app's data folder, so a second launch leaves the first one running.

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
