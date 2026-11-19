//! The app's own update. The runner reaches the updater through this door only, so no test reaches the network.

use crate::types::UpdateFailure;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri_plugin_updater::{Error, Update, UpdaterExt};

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

/// The app's own update: the one door the updater is reached through.
pub trait AppUpdater: Send + Sync {
    /// Asks once. Ok(Some(version)): a strictly newer release.
    fn check(&self) -> Result<Option<String>, UpdateFailure>;
    /// Downloads the release the last check found and checks its signature, once the person can replace the app;
    /// keeps it for the install.
    fn download(&self) -> Result<(), UpdateFailure>;
    /// Puts the kept download in place of the running app. Check: nothing was downloaded.
    fn install(&self) -> Result<(), UpdateFailure>;
}

/// Whether installing ends the app: on Windows the plugin exits it the moment it starts the installer, so the install
/// itself waits for what a relaunch waits for.
pub fn install_exits_app() -> bool {
    cfg!(windows)
}

/// Whether this build updates itself: a release build on macOS that a release wrote its version into. A local
/// `cargo tauri build` keeps the placeholder 0.0.0, which every published release outranks.
pub fn enabled(debug: bool, os: &str, version: &str) -> bool {
    !debug && os == "macos" && version != "0.0.0"
}

/// A manifest's version when it is plain X.Y.Z, each part 1 to 5 digits: the only text of the manifest that
/// reaches the menu and the log.
pub fn plain_version(version: &str) -> Option<String> {
    let parts: Vec<&str> = version.splitn(4, '.').collect();
    let plain = parts.len() == 3
        && parts.iter().all(|part| (1..=5).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_digit()));
    plain.then(|| version.to_string())
}

/// The bundle an executable runs from: <name>.app/Contents/MacOS/<exe>.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let inside = macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && bundle.extension()? == "app";
    inside.then(|| bundle.to_path_buf())
}

/// Whether the person can replace the bundle: its folder and the bundle itself are writable.
pub fn replaceable(bundle: &Path) -> bool {
    // The plugin moves the bundle out of its folder, which rewrites the bundle's own `..`: a refusal of either
    // is where it asks for an administrator password.
    bundle.parent().is_some_and(writable) && writable(bundle)
}

/// access(2) answers for the person, with ACLs and a read-only volume (the app run from its dmg) included.
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
    // SAFETY: access only reads the NUL-terminated path, which outlives the call.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

/// The door, where this build updates itself (`enabled`); None elsewhere.
pub fn system(handle: &tauri::AppHandle) -> Option<Arc<dyn AppUpdater>> {
    if !enabled(cfg!(debug_assertions), std::env::consts::OS, &handle.package_info().version.to_string()) {
        return None;
    }
    Some(Arc::new(SystemUpdater { handle: handle.clone(), found: Mutex::default(), downloaded: Mutex::default() }))
}

/// No error's text leaves this door: the plugin's may hold the manifest's URLs.
struct SystemUpdater {
    handle: tauri::AppHandle,
    /// What the last check found, for the download that follows it.
    found: Mutex<Option<Update>>,
    /// The download whose signature checked out, for the install that follows it.
    downloaded: Mutex<Option<(Update, Vec<u8>)>>,
}

impl AppUpdater for SystemUpdater {
    fn check(&self) -> Result<Option<String>, UpdateFailure> {
        let updater = self.handle.updater_builder().timeout(CHECK_TIMEOUT).build().map_err(|_| UpdateFailure::Check)?;
        let found = tauri::async_runtime::block_on(updater.check()).map_err(|_| UpdateFailure::Check)?;
        // The version is text whoever writes the bucket chose: anything but plain X.Y.Z is a failed check.
        let version =
            found.as_ref().map(|update| plain_version(&update.version).ok_or(UpdateFailure::Check)).transpose()?;
        *self.found.lock().unwrap() = found;
        Ok(version)
    }

    fn download(&self) -> Result<(), UpdateFailure> {
        let mut update = self.found.lock().unwrap().take().ok_or(UpdateFailure::Check)?;
        // Before any download, so the plugin's password prompt is never reached. Tauri's current_exe is the one the
        // plugin finds the bundle from.
        let bundle = tauri::utils::platform::current_exe().ok().and_then(|exe| bundle_of(&exe));
        if !bundle.is_some_and(|bundle| replaceable(&bundle)) {
            return Err(UpdateFailure::NotWritable);
        }
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        let bytes = tauri::async_runtime::block_on(update.download(|_, _| {}, || {}))
            .map_err(|error| download_failure(&error))?;
        *self.downloaded.lock().unwrap() = Some((update, bytes));
        Ok(())
    }

    fn install(&self) -> Result<(), UpdateFailure> {
        let (update, bytes) = self.downloaded.lock().unwrap().take().ok_or(UpdateFailure::Check)?;
        update.install(bytes).map_err(|_| UpdateFailure::Install)
    }
}

/// `download` checks the signature before it returns: its errors are the signature's or the download's.
fn download_failure(error: &Error) -> UpdateFailure {
    match error {
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => UpdateFailure::Signature,
        _ => UpdateFailure::Download,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn only_a_release_build_on_a_mac_updates_itself() {
        assert!(enabled(false, "macos", "0.0.1"));
        assert!(!enabled(true, "macos", "0.0.1"));
        assert!(!enabled(false, "linux", "0.0.1"));
        assert!(!enabled(false, "windows", "0.0.1"));
        // A local `cargo tauri build` keeps the placeholder: it never replaces itself with the published release.
        assert!(!enabled(false, "macos", "0.0.0"));
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
