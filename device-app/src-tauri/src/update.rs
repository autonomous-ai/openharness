//! The app's own update. The runner reaches the updater through this door only, so no test reaches the network.

use crate::types::UpdateFailure;

/// The app's own update: the one door the updater is reached through.
pub trait AppUpdater: Send + Sync {
    /// Asks once. Ok(Some(version)): a strictly newer release.
    fn check(&self) -> Result<Option<String>, UpdateFailure>;
    /// Downloads the release the last check found, checks its signature and puts it over the running bundle.
    fn install(&self) -> Result<(), UpdateFailure>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn only_a_release_build_on_a_mac_updates_itself() {
        assert!(enabled(false, "macos"));
        assert!(!enabled(true, "macos"));
        assert!(!enabled(false, "linux"));
        assert!(!enabled(false, "windows"));
    }

    #[test]
    fn only_a_plain_version_is_an_update() {
        for version in ["0.1.3", "10.20.30"] {
            assert_eq!(plain_version(version), Some(version.to_string()));
        }
        let long = "1".repeat(10_000);
        for version in [
            "0.1.3-beta",
            "0.1.3+build",
            "v0.1.3",
            "0.1",
            "1.2.3.4",
            "",
            "0.1.x",
            " 0.1.3",
            "0.1.3\n",
            "123456.0.0",
            &long,
        ] {
            assert_eq!(plain_version(version), None, "{version:?}");
        }
    }

    #[test]
    fn the_bundle_is_three_folders_up() {
        assert_eq!(
            bundle_of(Path::new("/Applications/Harness Device.app/Contents/MacOS/harness-device")),
            Some("/Applications/Harness Device.app".into())
        );
        assert_eq!(bundle_of(Path::new("/x/target/release/harness-device")), None);
        assert_eq!(bundle_of(Path::new("/x/Y.app/Contents/Resources/z")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_bundle_is_replaceable_only_when_it_and_its_folder_are_writable() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        // Root writes anywhere: no mode below would refuse it.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let folder = tempfile::tempdir().unwrap();
        let bundle = folder.path().join("X.app");
        fs::create_dir(&bundle).unwrap();
        let set = |path: &Path, mode: u32| fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        assert!(replaceable(&bundle));

        // Each mode is put back before anything asserts, so a failure still lets the temp folder go.
        set(folder.path(), 0o555);
        let folder_shut = replaceable(&bundle);
        set(folder.path(), 0o755);
        set(&bundle, 0o555);
        let bundle_shut = replaceable(&bundle);
        set(&bundle, 0o755);
        assert!(!folder_shut);
        assert!(!bundle_shut);
        assert!(!replaceable(&folder.path().join("Gone.app")));
    }

    #[test]
    fn a_signature_error_is_not_a_download_error() {
        use tauri_plugin_updater::Error;
        assert_eq!(download_failure(&Error::SignatureUtf8("x".into())), UpdateFailure::Signature);
        assert_eq!(download_failure(&Error::Network("x".into())), UpdateFailure::Download);
        assert_eq!(download_failure(&Error::ReleaseNotFound), UpdateFailure::Download);
    }
}
