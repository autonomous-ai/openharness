//! `Harness.exe --install [--wait-pid <pid>]`, run from an extracted zip (desktop spec section 3.3). The zip has the
//! install's shape (`Harness.exe`, `Harness.ico`, `current`, `app\<ver>\`), and the install is, in order:
//! 1. `app\<ver>` copied to `<install>\app\<ver>.staging`, then renamed to `app\<ver>`;
//! 2. `Harness.exe` and `Harness.ico` copied beside it, each through `<name>.new` and a rename;
//! 3. `previous` (the version installed before, if any) and `current` written;
//! 4. the Start Menu shortcut, `<FOLDERID_Programs>\Harness.lnk`, with the AUMID;
//! 5. the `harness://` key and the Settings ▸ Apps entry;
//! 6. the installed `Harness.exe` started.
//!
//! With the same version installed it only does 4 to 6 (which also repairs them) and opens it. With a newer one
//! installed it says so and opens that one. Before it changes an install it waits for `--wait-pid` (the app that
//! ran it, which still holds the single-instance mutex) and asks any app still running from the install to quit.
//!
//! A copy never follows a link: a symlink or junction inside the zip folder is skipped, and so is `.started`, which
//! belongs to the copy that ran.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::launch;
use super::pointer::{self, CURRENT, PREVIOUS};
use super::registry;
use super::system::System;
use super::{APP_DIR, APP_EXE, EXIT_FAILED, EXIT_OK, ICON, LAUNCHER_EXE, Paths, STARTED_MARKER};

/// How long a running app from the install has to quit.
pub const QUIT_WAIT: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Installed { version: String },
    AlreadyInstalled { version: String },
    NewerInstalled { zip: String, installed: String },
}

/// `X.Y.Z` of [version], without its prerelease or build: the rule DesktopUpdater's `semverGt` applies.
fn core(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split(['-', '+']).next()?.split('.');
    let numbers = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(numbers)
}

/// Whether [a] is strictly newer than [b].
pub fn newer(a: &str, b: &str) -> bool {
    matches!((core(a), core(b)), (Some(a), Some(b)) if a > b)
}

/// Non-following metadata at every source boundary, including Windows junctions.
fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    }
    #[cfg(not(windows))]
    {
        meta.is_symlink()
    }
}

fn source_metadata(path: &Path, directory: bool) -> io::Result<fs::Metadata> {
    let meta = fs::symlink_metadata(path)?;
    if linked(&meta) || (directory && !meta.is_dir()) || (!directory && !meta.is_file()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} is not an ordinary {}",
                path.display(),
                if directory {
                    "source folder"
                } else {
                    "source file"
                }
            ),
        ));
    }
    Ok(meta)
}

/// The same tree under [to], which must not exist, without links and without `.started`.
pub fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    source_metadata(from, true)?;
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = fs::symlink_metadata(entry.path())?;
        if linked(&kind) || entry.file_name() == STARTED_MARKER {
            continue;
        }
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// A folder and what is in it, gone; a link is removed as a link (std's remove_dir_all never follows one).
fn remove_folder(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
        Ok(meta) if meta.is_symlink() => fs::remove_dir(path).or_else(|_| fs::remove_file(path)),
        Ok(_) => fs::remove_dir_all(path),
    }
}

/// [from] in place of [to], through `<to>.new`; the old file is renamed to `<to>.old` first, since a running
/// program can be renamed but not overwritten. An old `.old` that is still held stays for the next cleanup.
pub fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    source_metadata(from, false)?;
    let with = |suffix: &str| {
        let mut name = to.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    let (new, old) = (with(".new"), with(".old"));
    let _ = fs::remove_file(&new);
    fs::copy(from, &new)?;
    if to.exists() {
        let _ = fs::remove_file(&old);
        crate::files::rename(to, &old)?;
    }
    if let Err(err) = crate::files::rename(&new, to) {
        let _ = crate::files::rename(&old, to);
        return Err(err);
    }
    let _ = fs::remove_file(&old);
    Ok(())
}

/// The version an install's `current` names, when its folder has the app.
fn installed_version(install: &Path) -> Option<String> {
    pointer::read(&install.join(CURRENT))
        .ok()
        .filter(|version| install.join(APP_DIR).join(version).join(APP_EXE).is_file())
}

/// Steps 4 and 5: everything outside the install folder. Every value names the install, never the zip.
fn register(paths: &Paths, version: &str, system: &mut impl System) -> Result<(), String> {
    let launcher = paths.launcher();
    let icon = if paths.install.join(ICON).is_file() {
        paths.install.join(ICON)
    } else {
        launcher.clone()
    };
    system
        .create_shortcut(&paths.shortcut(), &launcher, &icon, &paths.install)
        .map_err(|err| {
            format!(
                "could not create the Start Menu shortcut {}: {err}",
                paths.shortcut().display()
            )
        })?;
    let mut keys = registry::protocol_keys(registry::SCHEME, &launcher);
    keys.extend(registry::uninstall_keys(&paths.install, version, &icon));
    system
        .write_keys(&paths.registry, &keys)
        .map_err(|err| format!("could not register Harness with Windows: {err}"))
}

/// Steps 1 to 3.
fn copy_in(
    paths: &Paths,
    version: &str,
    installed: Option<&str>,
    guard: &launch::HistoryGuard,
) -> Result<(), String> {
    let app = paths.install.join(APP_DIR);
    fs::create_dir_all(&app).map_err(|err| format!("could not create {}: {err}", app.display()))?;
    let source = paths.own.join(APP_DIR).join(version);
    let staging = app.join(format!("{version}.staging"));
    let target = app.join(version);
    remove_folder(&staging)
        .map_err(|err| format!("could not clear {}: {err}", staging.display()))?;
    if let Err(err) = copy_tree(&source, &staging) {
        let _ = remove_folder(&staging);
        return Err(format!(
            "could not copy {} into {}: {err}",
            source.display(),
            staging.display()
        ));
    }
    // Success belongs to a physical version folder, never to the extracted zip.
    let reset = (|| {
        match fs::remove_file(staging.join(STARTED_MARKER)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        guard.write(&launch::State::default())
    })();
    if let Err(error) = reset {
        let _ = remove_folder(&staging);
        return Err(format!(
            "could not clear the recorded starts before replacing {version}: {error}"
        ));
    }
    // A folder of this version that is not in use (a half-done earlier install) makes way.
    remove_folder(&target)
        .map_err(|err| format!("could not replace {}: {err}", target.display()))?;
    crate::files::rename(&staging, &target)
        .map_err(|err| format!("could not move {} into place: {err}", staging.display()))?;
    replace_file(&paths.own.join(LAUNCHER_EXE), &paths.launcher())
        .map_err(|err| format!("could not copy Harness.exe: {err}"))?;
    if paths.own.join(ICON).is_file() {
        replace_file(&paths.own.join(ICON), &paths.install.join(ICON))
            .map_err(|err| format!("could not copy {ICON}: {err}"))?;
    }
    if let Some(installed) = installed.filter(|installed| *installed != version) {
        pointer::write(&paths.install.join(PREVIOUS), installed)
            .map_err(|err| format!("could not write previous: {err}"))?;
    }
    pointer::write(&paths.install.join(CURRENT), version)
        .map_err(|err| format!("could not write current: {err}"))
}

fn source_version(paths: &Paths) -> Result<String, String> {
    let version = pointer::read(&paths.own.join(CURRENT))?;
    for (needed, directory) in [
        (paths.own.join(APP_DIR), true),
        (paths.own.join(APP_DIR).join(&version), true),
        (paths.own.join(APP_DIR).join(&version).join(APP_EXE), false),
        (paths.own.join(LAUNCHER_EXE), false),
    ] {
        source_metadata(&needed, directory).map_err(|error| {
            format!(
                "this copy of Harness has no ordinary source {}: {error}",
                needed.display()
            )
        })?;
    }
    match fs::symlink_metadata(paths.own.join(ICON)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("could not inspect {ICON}: {error}")),
        Ok(_) => {
            source_metadata(&paths.own.join(ICON), false)
                .map_err(|error| format!("could not use {ICON}: {error}"))?;
        }
    }
    Ok(version)
}

pub fn run(
    paths: &Paths,
    wait_pid: Option<u32>,
    system: &mut impl System,
) -> Result<Outcome, String> {
    let mut version = source_version(paths)?;
    launch::wait_for_replaced(wait_pid, system)?;
    if !paths
        .install
        .try_exists()
        .map_err(|err| format!("could not inspect the install folder: {err}"))?
    {
        // First install is allowed to create its root, only after the quit precondition.
        system.quit_app(&paths.install, QUIT_WAIT).map_err(|err| {
            format!("could not quit Harness before installing: {err}. Close Harness and try again")
        })?;
        fs::create_dir_all(&paths.install)
            .map_err(|err| format!("could not create the install folder: {err}"))?;
    }
    let guard = launch::HistoryGuard::acquire(&paths.install)
        .map_err(|err| format!("could not coordinate this install: {err}"))?;
    // An own-installed pointer may have changed while waiting for another launch.
    if paths.running_installed() {
        version = source_version(paths)?;
    }
    let installed = installed_version(&paths.install);
    let outcome = match installed.as_deref() {
        Some(same) if same == version => Outcome::AlreadyInstalled {
            version: version.clone(),
        },
        Some(newer_one) if newer(newer_one, &version) => Outcome::NewerInstalled {
            zip: version.clone(),
            installed: newer_one.to_owned(),
        },
        _ => {
            system.quit_app(&paths.install, QUIT_WAIT).map_err(|err| {
                format!(
                    "could not quit Harness before installing: {err}. Close Harness and try again"
                )
            })?;
            copy_in(paths, &version, installed.as_deref(), &guard)?;
            Outcome::Installed {
                version: version.clone(),
            }
        }
    };
    let registered = match &outcome {
        Outcome::NewerInstalled { installed, .. } => installed.clone(),
        Outcome::Installed { version } | Outcome::AlreadyInstalled { version } => version.clone(),
    };
    register(paths, &registered, system)?;
    Ok(outcome)
}

/// The program's `--install`: [run], then the installed Harness started, and every failure said.
pub fn main(paths: &Paths, wait_pid: Option<u32>, system: &mut impl System) -> i32 {
    let outcome = match run(paths, wait_pid, system) {
        Ok(outcome) => outcome,
        Err(err) => {
            let root = if paths.install.is_dir() {
                &paths.install
            } else {
                &paths.own
            };
            launch::log(root, &format!("install failed: {err}"));
            system.say(&format!("Harness could not install itself: {err}."));
            return EXIT_FAILED;
        }
    };
    match &outcome {
        Outcome::Installed { version } => launch::log(&paths.install, &format!("installed {version}")),
        Outcome::AlreadyInstalled { .. } => {}
        Outcome::NewerInstalled { zip, installed } => system.say(&format!(
            "This copy of Harness is version {zip}, older than the Harness {installed} already on this PC. The installed Harness opens instead."
        )),
    }
    match system.start_app(&paths.launcher(), &paths.install, &[]) {
        Ok(_) => EXIT_OK,
        Err(err) => {
            launch::log(
                &paths.install,
                &format!("Harness is installed, but did not start: {err}"),
            );
            system.say(&format!(
                "Harness is installed, but did not start: {err}. Open it from the Start Menu."
            ));
            EXIT_FAILED
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::system::Fake;

    /// An extracted zip of [version] under `<dir>\zip`, and an install folder `<dir>\Harness` (not created).
    struct World {
        _dir: tempfile::TempDir,
        paths: Paths,
    }

    fn world(version: &str) -> World {
        let dir = tempfile::tempdir().unwrap();
        // Review Focus 1: the profile holds a space, an apostrophe, `&`, `%`, `!` and letters outside ASCII.
        let base = dir.path().join("Nguyễn Văn A' & 100% !x");
        let own = base.join("zip");
        zip(&own, version);
        let paths = Paths {
            own,
            install: base.join("Programs").join("Harness"),
            programs: base.join("Start Menu").join("Programs"),
            registry: r"Software\HarnessTest".to_owned(),
            profile: base.clone(),
        };
        World { _dir: dir, paths }
    }

    fn zip(own: &Path, version: &str) {
        let app = own.join(APP_DIR).join(version);
        fs::create_dir_all(app.join("data")).unwrap();
        fs::write(app.join(APP_EXE), version).unwrap();
        fs::write(app.join("data").join("app.so"), b"so").unwrap();
        fs::write(app.join(STARTED_MARKER), b"").unwrap();
        fs::write(own.join(LAUNCHER_EXE), format!("launcher {version}")).unwrap();
        fs::write(own.join(ICON), b"ico").unwrap();
        pointer::write(&own.join(CURRENT), version).unwrap();
    }

    fn text(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn installs_the_zip_and_registers_the_installed_copy() {
        let World { _dir, paths } = world("1.2.3");
        let mut system = Fake::default();
        assert_eq!(
            run(&paths, Some(9), &mut system).unwrap(),
            Outcome::Installed {
                version: "1.2.3".into()
            }
        );
        let app = paths.install.join(APP_DIR).join("1.2.3");
        assert_eq!(text(&app.join(APP_EXE)), "1.2.3");
        assert_eq!(text(&app.join("data").join("app.so")), "so");
        assert!(
            !app.join(STARTED_MARKER).exists(),
            "the zip copy's marker is not the install's"
        );
        assert!(!paths.install.join(APP_DIR).join("1.2.3.staging").exists());
        assert_eq!(text(&paths.launcher()), "launcher 1.2.3");
        assert_eq!(
            pointer::read(&paths.install.join(CURRENT)).unwrap(),
            "1.2.3"
        );
        assert!(!paths.install.join(PREVIOUS).exists());
        assert_eq!(system.waited, vec![9]);
        assert_eq!(
            system.quit,
            vec![paths.install.clone(), paths.install.clone()]
        );
        let icon = paths.install.join(ICON);
        assert_eq!(
            system.shortcuts,
            vec![(
                paths.shortcut(),
                paths.launcher(),
                icon.clone(),
                paths.install.clone()
            )]
        );
        let value = |key: &str, name: &str| {
            system
                .values
                .get(&(paths.registry.clone(), key.to_owned(), name.to_owned()))
                .cloned()
        };
        assert_eq!(
            value(r"Classes\harness\shell\open\command", ""),
            Some(std::ffi::OsString::from(format!(
                "\"{}\" \"%1\"",
                paths.launcher().display()
            )))
        );
        let mut uninstall = std::ffi::OsString::from("\"");
        uninstall.push(paths.launcher());
        uninstall.push("\" --uninstall");
        assert_eq!(
            value(registry::UNINSTALL_KEY, "UninstallString"),
            Some(uninstall)
        );
        assert_eq!(
            value(registry::UNINSTALL_KEY, "InstallLocation"),
            Some(paths.install.clone().into_os_string())
        );
        assert_eq!(
            value(registry::UNINSTALL_KEY, "DisplayVersion"),
            Some("1.2.3".into())
        );
    }

    #[test]
    fn a_newer_zip_keeps_the_installed_version_as_previous() {
        let World { _dir, paths } = world("1.2.3");
        let mut system = Fake::default();
        run(&paths, None, &mut system).unwrap();
        zip(&paths.own, "1.3.0");
        fs::remove_dir_all(paths.own.join(APP_DIR).join("1.2.3")).unwrap();
        assert_eq!(
            run(&paths, None, &mut system).unwrap(),
            Outcome::Installed {
                version: "1.3.0".into()
            }
        );
        assert_eq!(
            pointer::read(&paths.install.join(CURRENT)).unwrap(),
            "1.3.0"
        );
        assert_eq!(
            pointer::read(&paths.install.join(PREVIOUS)).unwrap(),
            "1.2.3"
        );
        assert_eq!(text(&paths.launcher()), "launcher 1.3.0");
        assert!(
            !paths.install.join("Harness.exe.old").exists()
                && !paths.install.join("Harness.exe.new").exists()
        );
        assert_eq!(
            system.values.get(&(
                paths.registry.clone(),
                registry::UNINSTALL_KEY.to_owned(),
                "DisplayVersion".to_owned()
            )),
            Some(&"1.3.0".into())
        );
    }

    #[test]
    fn the_same_version_installed_is_only_registered_again() {
        let World { _dir, paths } = world("1.2.3");
        let mut system = Fake::default();
        run(&paths, None, &mut system).unwrap();
        let quits_before_open = system.quit.len();
        fs::write(paths.install.join(APP_DIR).join("1.2.3").join("mine"), b"").unwrap();
        assert_eq!(
            run(&paths, None, &mut system).unwrap(),
            Outcome::AlreadyInstalled {
                version: "1.2.3".into()
            }
        );
        assert!(
            paths
                .install
                .join(APP_DIR)
                .join("1.2.3")
                .join("mine")
                .exists(),
            "nothing was copied over it"
        );
        assert_eq!(system.shortcuts.len(), 2);
        assert_eq!(
            system.quit.len(),
            quits_before_open,
            "an app running the same version is left alone"
        );
    }

    #[test]
    fn an_older_zip_says_so_and_leaves_the_install_alone() {
        let World { _dir, paths } = world("2.0.0");
        let mut system = Fake::default();
        run(&paths, None, &mut system).unwrap();
        zip(&paths.own, "1.9.9");
        assert_eq!(
            run(&paths, None, &mut system).unwrap(),
            Outcome::NewerInstalled {
                zip: "1.9.9".into(),
                installed: "2.0.0".into()
            }
        );
        assert_eq!(
            pointer::read(&paths.install.join(CURRENT)).unwrap(),
            "2.0.0"
        );
        assert!(!paths.install.join(APP_DIR).join("1.9.9").exists());
        assert_eq!(main(&paths, None, &mut system), EXIT_OK);
        assert!(
            system
                .said
                .last()
                .unwrap()
                .contains("version 1.9.9, older than the Harness 2.0.0"),
            "{:?}",
            system.said
        );
        assert_eq!(system.started.last().unwrap().0, paths.launcher());
    }

    #[test]
    fn main_starts_the_installed_launcher_and_says_a_failure() {
        let World { _dir, paths } = world("1.2.3");
        let mut system = Fake::default();
        assert_eq!(main(&paths, None, &mut system), EXIT_OK);
        assert_eq!(
            system.started,
            vec![(paths.launcher(), paths.install.clone(), vec![])]
        );
        let mut broken = Fake {
            fail_shortcut: true,
            ..Fake::default()
        };
        assert_eq!(main(&paths, None, &mut broken), EXIT_FAILED);
        assert!(broken.said[0].starts_with(
            "Harness could not install itself: could not create the Start Menu shortcut"
        ));
        assert!(text(&paths.install.join(launch::LOG)).contains("install failed"));
    }

    #[test]
    fn a_zip_without_its_app_is_refused_before_anything_changes() {
        let World { _dir, paths } = world("1.2.3");
        fs::remove_file(paths.own.join(APP_DIR).join("1.2.3").join(APP_EXE)).unwrap();
        let mut system = Fake::default();
        assert!(
            run(&paths, None, &mut system)
                .unwrap_err()
                .contains("has no")
        );
        assert!(!paths.install.exists());
        assert!(system.quit.is_empty() && system.shortcuts.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_zip_folder_is_never_followed() {
        let World { _dir, paths } = world("1.2.3");
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), b"x").unwrap();
        std::os::unix::fs::symlink(
            outside.path(),
            paths.own.join(APP_DIR).join("1.2.3").join("elsewhere"),
        )
        .unwrap();
        run(&paths, None, &mut Fake::default()).unwrap();
        assert!(
            !paths
                .install
                .join(APP_DIR)
                .join("1.2.3")
                .join("elsewhere")
                .exists()
        );
    }

    #[test]
    fn versions_compare_by_their_numbers() {
        assert!(newer("1.10.0", "1.9.9"));
        assert!(newer("2.0.0", "1.99.99-dev.1"));
        assert!(!newer("1.2.3", "1.2.3"));
        assert!(!newer("1.2.3-dev.2", "1.2.3-dev.1"));
        assert!(!newer("x", "1.0.0"));
    }
    #[test]
    fn waiting_failure_prevents_every_install_effect_and_start() {
        for kind in [
            io::ErrorKind::TimedOut,
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::Other,
        ] {
            let World { _dir, paths } = world("1.2.3");
            let mut system = Fake {
                fail_wait: Some(kind),
                ..Fake::default()
            };
            assert!(
                run(&paths, Some(9), &mut system)
                    .unwrap_err()
                    .contains("Close Harness and try again")
            );
            assert!(!paths.install.exists());
            assert!(system.quit.is_empty() && system.shortcuts.is_empty());
            assert_eq!(system.writes, 0);
            assert!(system.started.is_empty());
            assert_eq!(main(&paths, Some(9), &mut system), EXIT_FAILED);
            assert!(system.started.is_empty());
            assert!(text(&paths.own.join(launch::LOG)).contains("could not wait"));
        }
    }

    #[test]
    fn registry_or_start_errors_are_reported_without_a_successful_launch() {
        let World { _dir, paths } = world("1.2.3");
        let mut system = Fake {
            fail_write: true,
            ..Fake::default()
        };
        assert_eq!(main(&paths, None, &mut system), EXIT_FAILED);
        assert!(system.started.is_empty());
        assert!(system.said[0].contains("register Harness"));
        let mut system = Fake {
            fail_start: true,
            ..Fake::default()
        };
        assert_eq!(main(&paths, None, &mut system), EXIT_FAILED);
        assert!(system.said[0].contains("did not start"));
        assert!(text(&paths.install.join(launch::LOG)).contains("did not start"));
    }

    #[test]
    fn a_copy_failure_does_not_switch_the_installed_pointer() {
        let World { _dir, paths } = world("1.2.3");
        let mut system = Fake::default();
        run(&paths, None, &mut system).unwrap();
        zip(&paths.own, "1.3.0");
        // An ordinary file cannot hold app/<version>.staging.
        fs::write(
            paths.install.join(APP_DIR).join("1.3.0.staging"),
            b"blocked",
        )
        .unwrap();
        assert!(run(&paths, None, &mut system).is_err());
        assert_eq!(
            pointer::read(&paths.install.join(CURRENT)).unwrap(),
            "1.2.3"
        );
        assert_eq!(
            text(&paths.install.join(APP_DIR).join("1.2.3").join(APP_EXE)),
            "1.2.3"
        );
    }

    #[test]
    fn a_quit_failure_leaves_the_installed_tree_and_registrations_untouched() {
        let World { _dir, paths } = world("1.2.3");
        run(&paths, None, &mut Fake::default()).unwrap();
        zip(&paths.own, "1.3.0");
        let mut system = Fake {
            fail_quit: true,
            ..Fake::default()
        };
        assert_eq!(main(&paths, None, &mut system), EXIT_FAILED);
        assert_eq!(
            pointer::read(&paths.install.join(CURRENT)).unwrap(),
            "1.2.3"
        );
        assert!(!paths.install.join(APP_DIR).join("1.3.0").exists());
        assert_eq!(text(&paths.launcher()), "launcher 1.2.3");
        assert!(system.shortcuts.is_empty() && system.started.is_empty());
        assert_eq!(system.writes, 0);
        assert!(system.said[0].contains("quit Harness"));
    }
    #[cfg(unix)]
    #[test]
    fn linked_source_boundaries_leave_install_and_external_bytes_unchanged() {
        for boundary in ["version", "app", "launcher", "icon", "app_exe"] {
            let World { _dir, paths } = world("1.2.3");
            run(&paths, None, &mut Fake::default()).unwrap();
            zip(&paths.own, "1.3.0");
            let external = tempfile::tempdir().unwrap();
            let external_version = external.path().join("1.3.0");
            fs::create_dir(&external_version).unwrap();
            fs::write(external_version.join(APP_EXE), b"external app").unwrap();
            fs::write(external.path().join("sentinel"), b"external sentinel").unwrap();
            let (from, to, directory) = match boundary {
                "version" => (
                    external_version.clone(),
                    paths.own.join(APP_DIR).join("1.3.0"),
                    true,
                ),
                "app" => (external.path().to_owned(), paths.own.join(APP_DIR), true),
                "launcher" => (
                    external.path().join("sentinel"),
                    paths.own.join(LAUNCHER_EXE),
                    false,
                ),
                "icon" => (
                    external.path().join("sentinel"),
                    paths.own.join(ICON),
                    false,
                ),
                "app_exe" => (
                    external.path().join("sentinel"),
                    paths.own.join(APP_DIR).join("1.3.0").join(APP_EXE),
                    false,
                ),
                _ => unreachable!(),
            };
            if directory {
                fs::remove_dir_all(&to).unwrap();
            } else {
                fs::remove_file(&to).unwrap();
            }
            std::os::unix::fs::symlink(&from, &to).unwrap();
            let mut system = Fake::default();
            assert!(
                run(&paths, Some(7), &mut system).is_err(),
                "followed {boundary}"
            );
            assert!(
                system.waited.is_empty() && system.quit.is_empty() && system.started.is_empty()
            );
            assert_eq!(system.writes, 0);
            assert!(system.shortcuts.is_empty());
            assert_eq!(text(&paths.install.join(CURRENT)), "1.2.3\r\n");
            assert_eq!(text(&paths.launcher()), "launcher 1.2.3");
            assert!(!paths.install.join(APP_DIR).join("1.3.0").exists());
            assert_eq!(
                fs::read(external.path().join("sentinel")).unwrap(),
                b"external sentinel"
            );
            assert_eq!(
                fs::read(external_version.join(APP_EXE)).unwrap(),
                b"external app"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn direct_copy_and_replace_refuse_linked_roots_before_destination_effects() {
        let dir = tempfile::tempdir().unwrap();
        let external = dir.path().join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("sentinel"), b"external").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&external, &link).unwrap();
        let destination = dir.path().join("destination");
        assert!(copy_tree(&link, &destination).is_err());
        assert!(!destination.exists());
        let file = dir.path().join("linked-file");
        std::os::unix::fs::symlink(external.join("sentinel"), &file).unwrap();
        fs::write(&destination, b"installed").unwrap();
        assert!(replace_file(&file, &destination).is_err());
        assert_eq!(fs::read(destination).unwrap(), b"installed");
        assert_eq!(fs::read(external.join("sentinel")).unwrap(), b"external");
    }
    fn old_failures(paths: &Paths) {
        let start = |pid| crate::desktop::rollback::Start {
            version: "1.2.3".into(),
            at_ms: 1_000,
            pid,
            created: 1,
        };
        launch::write_state(
            &paths.install,
            &launch::State {
                starts: vec![start(10), start(11)],
            },
        )
        .unwrap();
    }
    #[test]
    fn repaired_folder_forgets_old_failures_and_does_not_inherit_the_zip_marker() {
        let World { _dir, paths } = world("1.2.3");
        run(&paths, None, &mut Fake::default()).unwrap();
        old_failures(&paths);
        let previous = paths.install.join(APP_DIR).join("1.0.0");
        fs::create_dir(&previous).unwrap();
        fs::write(previous.join(APP_EXE), b"old").unwrap();
        pointer::write(&paths.install.join(PREVIOUS), "1.0.0").unwrap();
        fs::remove_file(paths.install.join(APP_DIR).join("1.2.3").join(APP_EXE)).unwrap();
        run(&paths, None, &mut Fake::default()).unwrap();
        assert!(launch::read_state(&paths.install).starts.is_empty());
        assert!(
            !paths
                .install
                .join(APP_DIR)
                .join("1.2.3")
                .join(STARTED_MARKER)
                .exists()
        );
        let mut sys = Fake {
            liveness: crate::desktop::rollback::Liveness::Ended,
            ..Default::default()
        };
        assert_eq!(launch::run(&paths.install, None, &[], &mut sys), EXIT_OK);
        assert_eq!(
            pointer::read(&paths.install.join(CURRENT)).unwrap(),
            "1.2.3"
        );
        assert_eq!(launch::read_state(&paths.install).starts.len(), 1);
    }
    #[test]
    fn same_and_older_zip_open_without_resetting_history() {
        let World { _dir, paths } = world("1.2.3");
        run(&paths, None, &mut Fake::default()).unwrap();
        old_failures(&paths);
        let before = fs::read(paths.install.join(launch::STATE)).unwrap();
        run(&paths, None, &mut Fake::default()).unwrap();
        zip(&paths.own, "1.0.0");
        run(&paths, None, &mut Fake::default()).unwrap();
        assert_eq!(fs::read(paths.install.join(launch::STATE)).unwrap(), before);
    }
    #[test]
    fn failed_history_reset_prevents_folder_and_pointer_publication() {
        let World { _dir, paths } = world("1.2.3");
        run(&paths, None, &mut Fake::default()).unwrap();
        let state = paths.install.join(launch::STATE);
        if state.exists() {
            fs::remove_file(&state).unwrap();
        }
        fs::create_dir(&state).unwrap();
        fs::write(state.join("sentinel"), b"retained").unwrap();
        zip(&paths.own, "1.3.0");
        let mut sys = Fake::default();
        assert!(
            run(&paths, None, &mut sys)
                .unwrap_err()
                .contains("recorded starts")
        );
        assert_eq!(
            pointer::read(&paths.install.join(CURRENT)).unwrap(),
            "1.2.3"
        );
        assert_eq!(
            text(&paths.install.join(APP_DIR).join("1.2.3").join(APP_EXE)),
            "1.2.3"
        );
        assert!(!paths.install.join(APP_DIR).join("1.3.0").exists());
        assert_eq!(fs::read(state.join("sentinel")).unwrap(), b"retained");
        assert!(sys.started.is_empty() && sys.shortcuts.is_empty());
        assert_eq!(sys.writes, 0);
    }
    #[test]
    fn initial_quit_failure_does_not_create_the_install_root() {
        let World { _dir, paths } = world("1.2.3");
        let mut sys = Fake {
            fail_quit: true,
            ..Default::default()
        };
        assert!(run(&paths, None, &mut sys).is_err());
        assert!(!paths.install.exists());
    }
    #[test]
    fn contended_install_never_publishes_or_quits_and_recovers_after_release() {
        let World { _dir, paths } = world("1.2.3");
        run(&paths, None, &mut Fake::default()).unwrap();
        old_failures(&paths);
        let before = fs::read(paths.install.join(launch::STATE)).unwrap();
        zip(&paths.own, "1.3.0");
        let guard = launch::HistoryGuard::acquire(&paths.install).unwrap();
        let mut sys = Fake::default();
        let began = std::time::Instant::now();
        assert!(
            run(&paths, None, &mut sys)
                .unwrap_err()
                .contains("still finishing")
        );
        assert!(
            began.elapsed() >= Duration::from_secs(9) && began.elapsed() < Duration::from_secs(20)
        );
        assert!(sys.quit.is_empty() && sys.started.is_empty() && sys.shortcuts.is_empty());
        assert_eq!(sys.writes, 0);
        assert_eq!(fs::read(paths.install.join(launch::STATE)).unwrap(), before);
        assert_eq!(
            pointer::read(&paths.install.join(CURRENT)).unwrap(),
            "1.2.3"
        );
        assert!(!paths.install.join(APP_DIR).join("1.3.0").exists());
        drop(guard);
        run(&paths, None, &mut sys).unwrap();
        assert!(launch::read_state(&paths.install).starts.is_empty());
        assert_eq!(
            pointer::read(&paths.install.join(CURRENT)).unwrap(),
            "1.3.0"
        );
    }
}
