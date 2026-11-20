//! The app's own update. The runner reaches the updater through this door only, so no test reaches the network.

use crate::types::UpdateFailure;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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

/// Whether this build updates itself: a release build that a release wrote its version into, on macOS, on Windows,
/// and on Linux run as an AppImage, the one Linux form the updater replaces. A local `cargo tauri build` keeps the
/// placeholder 0.0.0, which every published release outranks.
pub fn enabled(debug: bool, os: &str, version: &str, appimage: bool) -> bool {
    let updates = match os {
        "macos" | "windows" => true,
        "linux" => appimage,
        _ => false,
    };
    !debug && updates && version != "0.0.0"
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

/// What an update replaces: the bundle on macOS, the install folder on Windows, the AppImage on Linux. None: this
/// run has nothing the updater can replace.
pub fn target(os: &str, exe: &Path, appimage: Option<&Path>) -> Option<PathBuf> {
    match os {
        "macos" => bundle_of(exe),
        "windows" => exe.parent().map(Path::to_path_buf),
        "linux" => appimage.map(Path::to_path_buf),
        _ => None,
    }
}

/// Whether the person can replace `target` without being asked for an administrator.
pub fn replaceable(os: &str, target: &Path) -> bool {
    match os {
        // The installer rewrites the folder's files; a copy an administrator installed refuses a new file where the
        // installer would ask for elevation.
        "windows" => a_file_can_be_made_in(target),
        // The plugin moves the bundle out of its folder, which rewrites the bundle's own `..`: a refusal of either is
        // where it asks for an administrator password.
        #[cfg(unix)]
        "macos" => target.parent().is_some_and(writable) && writable(target),
        // The plugin renames the AppImage away and writes a new file in its place: only the folder is written.
        #[cfg(unix)]
        "linux" => target.exists() && target.parent().is_some_and(writable),
        _ => false,
    }
}

/// access(2) answers for the person, with ACLs and a read-only volume (the app run from its dmg) included.
#[cfg(unix)]
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
    // SAFETY: access only reads the NUL-terminated path, which outlives the call.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

/// Whether a file can be made, then removed, in the folder: Windows answers for the person with every ACL included,
/// where a folder's read-only flag says nothing.
fn a_file_can_be_made_in(folder: &Path) -> bool {
    // A name no earlier check left behind, even one whose process ended between the two calls.
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let probe = folder.join(format!("update-check-{}-{nanos}.tmp", std::process::id()));
    File::create_new(&probe).is_ok() && fs::remove_file(&probe).is_ok()
}

/// The door, where this build updates itself (`enabled`); None elsewhere.
pub fn system(handle: &tauri::AppHandle) -> Option<Arc<dyn AppUpdater>> {
    // An AppImage's runtime sets APPIMAGE to its own file: the one the plugin replaces.
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|path| path.is_absolute());
    let version = handle.package_info().version.to_string();
    if !enabled(cfg!(debug_assertions), std::env::consts::OS, &version, appimage.is_some()) {
        return None;
    }
    Some(Arc::new(SystemUpdater {
        handle: handle.clone(),
        appimage,
        found: Mutex::default(),
        downloaded: Mutex::default(),
    }))
}

/// No error's text leaves this door: the plugin's may hold the manifest's URLs.
struct SystemUpdater {
    handle: tauri::AppHandle,
    /// The AppImage this run is, on Linux.
    appimage: Option<PathBuf>,
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
        // Before any download, so the plugin's password prompt or the installer's elevation is never reached. Tauri's
        // current_exe is the one the plugin finds the bundle or the install folder from.
        let os = std::env::consts::OS;
        let replaced =
            tauri::utils::platform::current_exe().ok().and_then(|exe| target(os, &exe, self.appimage.as_deref()));
        if !replaced.is_some_and(|replaced| replaceable(os, &replaced)) {
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
    fn a_release_build_updates_itself_on_macos_windows_and_as_an_appimage() {
        // (debug, os, version, appimage, updates itself)
        for (debug, os, version, appimage, updates) in [
            (false, "macos", "0.0.1", false, true),
            (false, "windows", "0.0.1", false, true),
            (false, "linux", "0.0.1", true, true),
            // A dev run or a distro package: the updater replaces only an AppImage.
            (false, "linux", "0.0.1", false, false),
            (true, "macos", "0.0.1", false, false),
            (true, "windows", "0.0.1", false, false),
            (true, "linux", "0.0.1", true, false),
            // A local `cargo tauri build` keeps the placeholder: it never replaces itself with the published release.
            (false, "macos", "0.0.0", false, false),
            (false, "windows", "0.0.0", false, false),
            (false, "linux", "0.0.0", true, false),
            (false, "freebsd", "0.0.1", true, false),
        ] {
            assert_eq!(enabled(debug, os, version, appimage), updates, "{debug} {os} {version} {appimage}");
        }
    }

    #[test]
    fn what_an_update_replaces_on_each_os() {
        let in_bundle = Path::new("/Applications/Harness Device.app/Contents/MacOS/harness-device");
        let appimage = Path::new("/home/a/My Apps/Harness-Device-linux-x64.AppImage");
        let mounted = Path::new("/tmp/.mount_HarnesAbC/usr/bin/harness-device");
        let installed = Path::new("C:/Users/Nguyễn Văn A/AppData/Local/Harness Device/harness-device.exe");

        assert_eq!(target("macos", in_bundle, None), Some("/Applications/Harness Device.app".into()));
        // An APPIMAGE another program left in the environment changes nothing off Linux.
        assert_eq!(target("macos", in_bundle, Some(appimage)), Some("/Applications/Harness Device.app".into()));
        assert_eq!(target("macos", Path::new("/x/target/release/harness-device"), None), None);
        assert_eq!(
            target("windows", installed, None),
            Some("C:/Users/Nguyễn Văn A/AppData/Local/Harness Device".into())
        );
        assert_eq!(target("linux", mounted, Some(appimage)), Some(appimage.into()));
        assert_eq!(target("linux", mounted, None), None);
        assert_eq!(target("freebsd", mounted, Some(appimage)), None);
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
        assert!(replaceable("macos", &bundle));

        // Each mode is put back before anything asserts, so a failure still lets the temp folder go.
        set(folder.path(), 0o555);
        let folder_shut = replaceable("macos", &bundle);
        set(folder.path(), 0o755);
        set(&bundle, 0o555);
        let bundle_shut = replaceable("macos", &bundle);
        set(&bundle, 0o755);
        assert!(!folder_shut);
        assert!(!bundle_shut);
        assert!(!replaceable("macos", &folder.path().join("Gone.app")));
    }

    #[cfg(unix)]
    #[test]
    fn an_appimage_is_replaceable_when_its_folder_is_writable() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        // Root writes anywhere: no mode below would refuse it.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let folder = tempfile::tempdir().unwrap();
        let appimage = folder.path().join("Harness-Device-linux-x64.AppImage");
        fs::write(&appimage, b"").unwrap();
        let set = |path: &Path, mode: u32| fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        set(&appimage, 0o755);
        assert!(replaceable("linux", &appimage));

        // Each mode is put back before anything asserts, so a failure still lets the temp folder go.
        set(folder.path(), 0o555);
        let folder_shut = replaceable("linux", &appimage);
        set(folder.path(), 0o755);
        // The plugin renames the AppImage away and writes a new one in its place: the file's own mode is not asked.
        set(&appimage, 0o555);
        let read_only = replaceable("linux", &appimage);
        set(&appimage, 0o755);
        assert!(!folder_shut);
        assert!(read_only);
        assert!(!replaceable("linux", &folder.path().join("Gone.AppImage")));
    }

    #[cfg(windows)]
    #[test]
    fn an_install_folder_is_replaceable_only_when_a_file_can_be_made_in_it() {
        use std::process::Command;
        let folder = tempfile::tempdir().unwrap();
        // Windows' own icacls, by its full path, so no PATH puts another first.
        let icacls = std::path::PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot"))
            .join("System32")
            .join("icacls.exe");
        let acl = |args: &[&str]| {
            let status = Command::new(&icacls).arg(folder.path()).args(args).status().unwrap();
            assert!(status.success(), "icacls {args:?}");
        };
        assert!(replaceable("windows", folder.path()));
        // The check leaves nothing in the install folder.
        assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 0);

        // A folder the person may read but not add a file to, as an administrator's install is. Everyone is
        // S-1-1-0, a name in no language; WD on a folder is "add a file". Put back before anything asserts.
        acl(&["/deny", "*S-1-1-0:(WD)"]);
        let shut = replaceable("windows", folder.path());
        acl(&["/remove:d", "*S-1-1-0"]);
        assert!(!shut);
        assert!(!replaceable("windows", &folder.path().join("Gone")));
    }

    #[test]
    fn a_signature_error_is_not_a_download_error() {
        use tauri_plugin_updater::Error;
        assert_eq!(download_failure(&Error::SignatureUtf8("x".into())), UpdateFailure::Signature);
        assert_eq!(download_failure(&Error::Network("x".into())), UpdateFailure::Download);
        assert_eq!(download_failure(&Error::ReleaseNotFound), UpdateFailure::Download);
    }
}
