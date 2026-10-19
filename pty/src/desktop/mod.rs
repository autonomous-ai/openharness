//! `Harness.exe`, the Harness desktop app's launcher on Windows (desktop spec section 3). It is the one program the
//! Start Menu shortcut, the `harness://` key and the uninstall entry name, so an update, which swaps the app's
//! version folder, never breaks any of them:
//!
//! ```text
//! %LOCALAPPDATA%\Programs\Harness\
//!   Harness.exe   Harness.ico   current   previous   app\<ver>\   launch.log   launch-state.json
//! ```
//!
//! - no arguments, or a `harness://` link: start `app\<current>\harness-desktop.exe` with the same arguments, then
//!   exit (`launch`). `--wait-pid <pid>` first waits for that process to end: the updater and the self-install pass
//!   the app they are replacing, which still holds the single-instance mutex.
//! - `--install [--wait-pid <pid>]`, run from an extracted zip: install that zip's version (`install`).
//! - `--uninstall`, from Settings ▸ Apps (`uninstall`).
//! - `--version`.
//!
//! It is a GUI-subsystem program, so nothing it does opens a console window, and it says what went wrong in a message
//! box and in `launch.log`. It builds and runs on Unix too, where the launch path starts the app with `Command` and
//! the Windows-only steps (registry, Start Menu, windows) are absent, so `cargo test` covers the rest everywhere.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub mod install;
pub mod launch;
pub mod pointer;
pub mod registry;
pub mod rollback;
pub mod shortcut;
pub mod system;
pub mod uninstall;
#[cfg(windows)]
pub mod win;

/// The Flutter app in each version folder (`BINARY_NAME`, desktop/windows/CMakeLists.txt).
pub const APP_EXE: &str = "harness-desktop.exe";
/// This program, as the zip and the install name it.
pub const LAUNCHER_EXE: &str = "Harness.exe";
/// The icon the shortcut and the uninstall entry show, beside the launcher (the launcher has no icon resource).
pub const ICON: &str = "Harness.ico";
/// The version folders.
pub const APP_DIR: &str = "app";
/// What the app writes in its version folder once its first frame is drawn (desktop/lib/update/started_marker.dart).
pub const STARTED_MARKER: &str = ".started";
pub const AUMID: &str = "Autonomous.Harness";
pub const DISPLAY_NAME: &str = "Harness";
pub const PUBLISHER: &str = "Autonomous";

pub const INSTALL_ROOT_ENV: &str = "HARNESS_DESKTOP_INSTALL_ROOT";
pub const PROGRAMS_DIR_ENV: &str = "HARNESS_DESKTOP_PROGRAMS_DIR";
pub const REGISTRY_ROOT_ENV: &str = "HARNESS_DESKTOP_REGISTRY_ROOT";

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_BROKEN: i32 = 3;
pub const EXIT_SPAWN: i32 = 4;

pub const USAGE: &str = "usage: Harness.exe [--wait-pid <pid>] [<harness:// link>...] | --install [--wait-pid <pid>] | --uninstall | --version";

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Launch {
        wait_pid: Option<u32>,
        args: Vec<OsString>,
    },
    Install {
        wait_pid: Option<u32>,
    },
    Uninstall,
    Version,
}

fn pid_after(args: &[OsString], at: usize) -> Result<u32, String> {
    args.get(at)
        .and_then(|value| value.to_str())
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|&pid| pid > 0)
        .ok_or_else(|| format!("--wait-pid needs a process id\n{USAGE}"))
}

/// Only the first word can be one of this program's own options. A `harness://` link is whatever the shell passes
/// as `%1` and always begins with the scheme, so no link reads as `--uninstall`.
pub fn parse(args: &[OsString]) -> Result<Command, String> {
    match args.first().and_then(|first| first.to_str()) {
        Some("--version") if args.len() == 1 => Ok(Command::Version),
        Some("--uninstall") if args.len() == 1 => Ok(Command::Uninstall),
        Some("--install") => match args.len() {
            1 => Ok(Command::Install { wait_pid: None }),
            3 if args[1] == "--wait-pid" => Ok(Command::Install {
                wait_pid: Some(pid_after(args, 2)?),
            }),
            _ => Err(format!("unexpected arguments after --install\n{USAGE}")),
        },
        Some("--version" | "--uninstall") => {
            Err(format!("unexpected arguments after {:?}\n{USAGE}", args[0]))
        }
        Some("--wait-pid") => Ok(Command::Launch {
            wait_pid: Some(pid_after(args, 1)?),
            args: args[2..].to_vec(),
        }),
        _ => Ok(Command::Launch {
            wait_pid: None,
            args: args.to_vec(),
        }),
    }
}

/// The folder this program runs from: the root it launches from, unless [INSTALL_ROOT_ENV] names another (tests).
pub fn launch_root(own_exe: &Path, env: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    if let Some(root) = env(INSTALL_ROOT_ENV).filter(|root| !root.is_empty()) {
        return std::path::absolute(root).ok();
    }
    own_exe
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(Path::to_path_buf)
}

/// The folders and the registry root an install and an uninstall use. Each comes from a known folder, never from a
/// hard-coded path or `%LOCALAPPDATA%` text, so a redirected Start Menu or profile is followed (Review Focus 5), and
/// each has an override for the tests (they never write the real Start Menu, `harness://` key or uninstall entry).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    /// The folder this Harness.exe runs from: an extracted zip, or the install.
    pub own: PathBuf,
    /// `<FOLDERID_UserProgramFiles>\Harness` (`%LOCALAPPDATA%\Programs\Harness`), or [INSTALL_ROOT_ENV].
    pub install: PathBuf,
    /// `FOLDERID_Programs`, the Start Menu's Programs folder, or [PROGRAMS_DIR_ENV].
    pub programs: PathBuf,
    /// The HKCU subkey that stands for `Software`, or [REGISTRY_ROOT_ENV].
    pub registry: String,
    /// The profile the app keeps `.harness\desktop-app*` in: `USERPROFILE`, as the app's `homeDir()` reads it, then
    /// `FOLDERID_Profile` (`HOME` off Windows).
    pub profile: PathBuf,
}

/// The known folders [Paths] asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnownFolder {
    UserProgramFiles,
    Programs,
    Profile,
}

/// A registry override is a relative HKCU path: no leading, trailing or doubled backslash, and no `/`.
pub fn valid_registry_root(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('/')
        && value
            .split('\\')
            .all(|part| !part.is_empty() && part != "..")
}

impl Paths {
    pub fn resolve(
        own_exe: &Path,
        env: impl Fn(&str) -> Option<OsString>,
        known: impl Fn(KnownFolder) -> Option<PathBuf>,
    ) -> Result<Paths, String> {
        let set = |key: &str| env(key).filter(|value| !value.is_empty());
        // A test's install root never comes with the real Start Menu or registry.
        if set(INSTALL_ROOT_ENV).is_some()
            && (set(PROGRAMS_DIR_ENV).is_none() || set(REGISTRY_ROOT_ENV).is_none())
        {
            return Err(format!(
                "{INSTALL_ROOT_ENV} needs {PROGRAMS_DIR_ENV} and {REGISTRY_ROOT_ENV} as well"
            ));
        }
        let own = own_exe
            .parent()
            .map(Path::to_path_buf)
            .ok_or("Harness.exe does not know its own folder")?;
        let install = match set(INSTALL_ROOT_ENV) {
            Some(root) => PathBuf::from(root),
            None => known(KnownFolder::UserProgramFiles)
                .ok_or("Windows did not say where your programs go")?
                .join(DISPLAY_NAME),
        };
        let programs = match set(PROGRAMS_DIR_ENV) {
            Some(dir) => PathBuf::from(dir),
            None => {
                known(KnownFolder::Programs).ok_or("Windows did not say where the Start Menu is")?
            }
        };
        let registry = match set(REGISTRY_ROOT_ENV) {
            Some(root) => {
                let root = root
                    .into_string()
                    .map_err(|_| format!("{REGISTRY_ROOT_ENV} is not text"))?;
                if !valid_registry_root(&root) {
                    return Err(format!(
                        "{REGISTRY_ROOT_ENV} {root:?} is not a registry path under HKEY_CURRENT_USER"
                    ));
                }
                root
            }
            None => "Software".to_owned(),
        };
        let profile = set("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| known(KnownFolder::Profile))
            .or_else(|| set("HOME").filter(|_| !cfg!(windows)).map(PathBuf::from))
            .ok_or("Windows did not say where your profile is")?;
        for (name, path) in [
            ("the install folder", &install),
            ("the Start Menu folder", &programs),
            ("the profile", &profile),
        ] {
            if !path.is_absolute() {
                return Err(format!("{name} {} is not a full path", path.display()));
            }
        }
        Ok(Paths {
            own,
            install,
            programs,
            registry,
            profile,
        })
    }

    /// This computer's, for the running program.
    pub fn current() -> Result<Paths, String> {
        let exe = std::env::current_exe()
            .map_err(|err| format!("Harness.exe does not know its own path: {err}"))?;
        #[cfg(windows)]
        let known = win::known_folder;
        #[cfg(not(windows))]
        let known = |_: KnownFolder| None;
        Paths::resolve(&exe, |key| std::env::var_os(key), known)
    }

    pub fn launcher(&self) -> PathBuf {
        self.install.join(LAUNCHER_EXE)
    }

    pub fn shortcut(&self) -> PathBuf {
        self.programs.join(shortcut::LINK_NAME)
    }

    /// Whether this Harness.exe is the installed one.
    pub fn running_installed(&self) -> bool {
        same_folder(&self.own, &self.install)
    }
}

/// Two folders compared as Windows does: resolved when they exist (8.3 names, links), and without case.
pub fn same_folder(a: &Path, b: &Path) -> bool {
    let plain = |path: &Path| {
        let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let text = resolved.to_string_lossy().into_owned();
        let text = text
            .strip_prefix(r"\\?\")
            .map(str::to_owned)
            .unwrap_or(text);
        text.trim_end_matches(['\\', '/']).to_lowercase()
    };
    plain(a) == plain(b)
}

/// Dispatch only after waiting, and only an actual installed launcher owns its protocol.
fn launch_from(
    root: &Path,
    paths: Option<&Paths>,
    wait_pid: Option<u32>,
    args: &[OsString],
    system: &mut impl system::System,
) -> i32 {
    if !launch::wait_before_launch(root, wait_pid, system) {
        return EXIT_FAILED;
    }
    let heal = paths.filter(|p| p.running_installed() && same_folder(root, &p.install));
    launch::run_after_wait(root, args, heal.map(|p| p.registry.as_str()), system)
}

/// The program: see the module comment.
pub fn run(args: Vec<OsString>) -> i32 {
    let command = match parse(&args) {
        Ok(command) => command,
        Err(err) => {
            system::say(&err);
            return EXIT_USAGE;
        }
    };
    match command {
        Command::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            EXIT_OK
        }
        Command::Launch { wait_pid, args } => {
            let Some(root) = std::env::current_exe()
                .ok()
                .and_then(|exe| launch_root(&exe, |key| std::env::var_os(key)))
            else {
                system::say("Harness.exe does not know its own folder.");
                return EXIT_BROKEN;
            };
            // Path discovery is optional for a portable/off-Windows launch, but an
            // explicit invalid override must never silently become a launch target.
            let explicit = [INSTALL_ROOT_ENV, PROGRAMS_DIR_ENV, REGISTRY_ROOT_ENV]
                .iter()
                .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()));
            let paths = match Paths::current() {
                Ok(paths) => Some(paths),
                Err(error) if explicit => {
                    system::say(&format!("Harness could not start: {error}."));
                    return EXIT_FAILED;
                }
                Err(_) => None,
            };
            launch_from(
                &root,
                paths.as_ref(),
                wait_pid,
                &args,
                &mut system::Real::default(),
            )
        }
        Command::Install { wait_pid } => match Paths::current() {
            Ok(paths) => install::main(&paths, wait_pid, &mut system::Real::default()),
            Err(error) => {
                system::say(&format!("Harness could not install itself: {error}."));
                EXIT_FAILED
            }
        },
        Command::Uninstall => match Paths::current() {
            Ok(paths) => uninstall::main(&paths, &mut system::Real::default()),
            Err(err) => {
                system::say(&format!("Harness could not uninstall itself: {err}."));
                EXIT_FAILED
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_each_form_and_passes_a_link_through() {
        assert_eq!(
            parse(&os(&[])).unwrap(),
            Command::Launch {
                wait_pid: None,
                args: vec![]
            }
        );
        assert_eq!(
            parse(&os(&["harness://notification/m/a"])).unwrap(),
            Command::Launch {
                wait_pid: None,
                args: os(&["harness://notification/m/a"])
            }
        );
        assert_eq!(
            parse(&os(&["--wait-pid", "42", "harness://x"])).unwrap(),
            Command::Launch {
                wait_pid: Some(42),
                args: os(&["harness://x"])
            }
        );
        assert_eq!(
            parse(&os(&["--install"])).unwrap(),
            Command::Install { wait_pid: None }
        );
        assert_eq!(
            parse(&os(&["--install", "--wait-pid", "7"])).unwrap(),
            Command::Install { wait_pid: Some(7) }
        );
        assert_eq!(parse(&os(&["--uninstall"])).unwrap(), Command::Uninstall);
        assert_eq!(parse(&os(&["--version"])).unwrap(), Command::Version);
    }

    #[test]
    fn an_option_counts_only_as_the_first_word() {
        // What a link to `harness:--uninstall` would hand over: one argument, the whole link.
        assert_eq!(
            parse(&os(&["harness:--uninstall"])).unwrap(),
            Command::Launch {
                wait_pid: None,
                args: os(&["harness:--uninstall"])
            }
        );
        assert_eq!(
            parse(&os(&["harness://x", "--uninstall"])).unwrap(),
            Command::Launch {
                wait_pid: None,
                args: os(&["harness://x", "--uninstall"])
            }
        );
    }

    #[test]
    fn refuses_a_malformed_option() {
        assert!(
            parse(&os(&["--wait-pid"]))
                .unwrap_err()
                .contains("needs a process id")
        );
        assert!(
            parse(&os(&["--wait-pid", "0"]))
                .unwrap_err()
                .contains("needs a process id")
        );
        assert!(
            parse(&os(&["--wait-pid", "x"]))
                .unwrap_err()
                .contains("needs a process id")
        );
        assert!(
            parse(&os(&["--install", "--wait-pid"]))
                .unwrap_err()
                .contains("unexpected arguments")
        );
        assert!(
            parse(&os(&["--install", "extra"]))
                .unwrap_err()
                .contains("unexpected arguments")
        );
        assert!(
            parse(&os(&["--uninstall", "now"]))
                .unwrap_err()
                .contains("unexpected arguments")
        );
    }

    #[test]
    fn the_launch_root_is_the_programs_folder_unless_the_tests_name_one() {
        // Use an actual absolute temp path: /T is drive-relative on Windows and
        // becomes <current-drive>:\T when the override is made absolute.
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("Harness.exe");
        assert_eq!(launch_root(&exe, |_| None), Some(dir.path().to_path_buf()));
        let overridden = dir.path().join("override");
        let env =
            |key: &str| (key == INSTALL_ROOT_ENV).then(|| overridden.clone().into_os_string());
        assert_eq!(launch_root(&exe, env), Some(overridden.clone()));
        let empty = |key: &str| (key == INSTALL_ROOT_ENV).then(OsString::new);
        assert_eq!(launch_root(&exe, empty), Some(dir.path().to_path_buf()));
        assert_eq!(launch_root(Path::new("Harness.exe"), |_| None), None);
    }
    /// A full path on this OS: `C:\<path>` on Windows, `/<path>` elsewhere.
    fn at(path: &str) -> PathBuf {
        Path::new(if cfg!(windows) { "C:\\" } else { "/" }).join(path)
    }

    fn known(folder: KnownFolder) -> Option<PathBuf> {
        Some(at(match folder {
            KnownFolder::UserProgramFiles => "K/Programs",
            KnownFolder::Programs => "K/Start Menu/Programs",
            KnownFolder::Profile => "K/Profile",
        }))
    }

    #[test]
    fn paths_come_from_the_known_folders() {
        let paths = Paths::resolve(&at("zip/Harness.exe"), |_| None, known).unwrap();
        assert_eq!(
            paths,
            Paths {
                own: at("zip"),
                install: at("K/Programs").join("Harness"),
                programs: at("K/Start Menu/Programs"),
                registry: "Software".to_owned(),
                profile: at("K/Profile"),
            }
        );
        assert_eq!(
            paths.launcher(),
            at("K/Programs").join("Harness").join("Harness.exe")
        );
        assert_eq!(
            paths.shortcut(),
            at("K/Start Menu/Programs").join("Harness.lnk")
        );
    }

    #[test]
    fn the_tests_overrides_win_and_userprofile_comes_before_the_known_profile() {
        let env = |key: &str| {
            Some(
                at(match key {
                    INSTALL_ROOT_ENV => "T/Harness",
                    PROGRAMS_DIR_ENV => "T/Programs",
                    "USERPROFILE" => "T/Nguyễn Văn A'",
                    REGISTRY_ROOT_ENV => return Some(OsString::from(r"Software\HarnessTest\1")),
                    _ => return None,
                })
                .into_os_string(),
            )
        };
        let paths = Paths::resolve(&at("zip/Harness.exe"), env, known).unwrap();
        assert_eq!(paths.install, at("T/Harness"));
        assert_eq!(paths.programs, at("T/Programs"));
        assert_eq!(paths.registry, r"Software\HarnessTest\1");
        assert_eq!(paths.profile, at("T/Nguyễn Văn A'"));
    }

    #[test]
    fn refuses_a_registry_override_that_is_not_a_relative_key_and_a_relative_folder() {
        for bad in [
            "",
            r"\Software",
            r"Software\",
            r"Software\\X",
            "Software/X",
            r"Software\..\X",
        ] {
            assert!(!valid_registry_root(bad), "{bad:?}");
        }
        let env = |key: &str| (key == REGISTRY_ROOT_ENV).then(|| OsString::from(r"\Software"));
        assert!(
            Paths::resolve(&at("zip/Harness.exe"), env, known)
                .unwrap_err()
                .contains("not a registry path")
        );
        let env = |key: &str| (key == PROGRAMS_DIR_ENV).then(|| OsString::from("relative"));
        assert!(
            Paths::resolve(&at("zip/Harness.exe"), env, known)
                .unwrap_err()
                .contains("not a full path")
        );
        // The tests' install root alone would reach the real Start Menu and registry.
        let env = |key: &str| (key == INSTALL_ROOT_ENV).then(|| at("T/Harness").into_os_string());
        assert!(
            Paths::resolve(&at("zip/Harness.exe"), env, known)
                .unwrap_err()
                .contains("needs")
        );
        assert!(Paths::resolve(&at("zip/Harness.exe"), |_| None, |_| None).is_err());
    }

    #[test]
    fn folders_compare_without_case_and_trailing_separators() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Harness");
        std::fs::create_dir(&path).unwrap();
        let mut trailing = path.clone().into_os_string();
        trailing.push(std::path::MAIN_SEPARATOR_STR);
        assert!(same_folder(&path, Path::new(&trailing)));
        assert!(same_folder(
            Path::new("/X/Harness"),
            Path::new("/x/harness/")
        ));
        assert!(!same_folder(
            Path::new("/X/Harness"),
            Path::new("/X/Harness2")
        ));
    }
    #[test]
    fn only_the_actual_installed_launcher_heals_after_a_successful_wait() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().join("Harness");
        std::fs::create_dir_all(install.join("app/1.2.3")).unwrap();
        std::fs::write(install.join("app/1.2.3").join(APP_EXE), b"app").unwrap();
        pointer::write(&install.join("current"), "1.2.3").unwrap();
        let mut paths = Paths {
            own: dir.path().join("zip"),
            install: install.clone(),
            programs: dir.path().join("programs"),
            registry: r"Software\HarnessTest\dispatch".into(),
            profile: dir.path().to_owned(),
        };
        let mut system = system::Fake::default();
        assert_eq!(
            launch_from(&install, Some(&paths), None, &[], &mut system),
            EXIT_OK
        );
        assert_eq!(
            system.writes, 0,
            "a zip with a root override cannot acquire the scheme"
        );
        paths.own = install.clone();
        let mut system = system::Fake {
            fail_wait: Some(std::io::ErrorKind::TimedOut),
            ..Default::default()
        };
        assert_eq!(
            launch_from(&install, Some(&paths), Some(77), &[], &mut system),
            EXIT_FAILED
        );
        assert_eq!(system.waited, vec![77]);
        assert_eq!(system.writes, 0);
        assert_eq!(system.reads, 0);
        assert!(system.started.is_empty());
        system.fail_wait = None;
        assert_eq!(
            launch_from(&install, Some(&paths), Some(78), &[], &mut system),
            EXIT_OK
        );
        assert_eq!(
            system.waited,
            vec![77, 78],
            "the successful wait is not repeated"
        );
        assert_eq!(system.writes, 1);
        let key = (
            paths.registry.clone(),
            r"Classes\harness\shell\open\command".into(),
            String::new(),
        );
        assert_eq!(
            system.values.get(&key),
            Some(&OsString::from(format!(
                "\"{}\" \"%1\"",
                paths.launcher().display()
            )))
        );
        let reads = system.reads;
        assert_eq!(
            launch_from(&install, Some(&paths), None, &[], &mut system),
            EXIT_OK
        );
        assert_eq!(system.writes, 1);
        assert_eq!(
            system.reads,
            reads + 2,
            "the protocol and installed version are checked"
        );
        let another_root = dir.path().join("another");
        launch_from(&another_root, Some(&paths), None, &[], &mut system);
        assert_eq!(
            system.reads,
            reads + 2,
            "an overridden launch elsewhere does not heal"
        );
    }

    #[test]
    fn an_updated_installed_launcher_refreshes_settings_display_version() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().join("Harness");
        std::fs::create_dir_all(install.join("app/1.0.1")).unwrap();
        std::fs::write(install.join("app/1.0.1").join(APP_EXE), b"app").unwrap();
        pointer::write(&install.join("current"), "1.0.1").unwrap();
        std::fs::write(install.join("app/1.0.1/.started"), b"").unwrap();
        let paths = Paths {
            own: install.clone(),
            install: install.clone(),
            programs: dir.path().join("programs"),
            registry: r"Software\HarnessTest\update".into(),
            profile: dir.path().to_owned(),
        };
        let display_version = (
            paths.registry.clone(),
            registry::UNINSTALL_KEY.to_owned(),
            "DisplayVersion".to_owned(),
        );
        let uninstall_string = (
            paths.registry.clone(),
            registry::UNINSTALL_KEY.to_owned(),
            "UninstallString".to_owned(),
        );
        let mut system = system::Fake::default();
        system
            .values
            .insert(display_version.clone(), "1.0.0".into());
        system.values.insert(
            uninstall_string.clone(),
            "keep existing uninstall command".into(),
        );

        assert_eq!(
            launch_from(&install, Some(&paths), None, &[], &mut system),
            EXIT_OK
        );
        assert_eq!(
            system.values.get(&display_version),
            Some(&OsString::from("1.0.1"))
        );
        assert_eq!(
            system.values.get(&uninstall_string),
            Some(&OsString::from("keep existing uninstall command"))
        );
    }
}
