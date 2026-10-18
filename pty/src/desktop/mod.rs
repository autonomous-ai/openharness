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

pub mod launch;
pub mod pointer;
pub mod system;
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
            launch::run(&root, wait_pid, &args, &mut system::Real::default())
        }
        // C4.2 and C4.3.
        Command::Install { .. } | Command::Uninstall => {
            system::say("This Harness.exe does not install or uninstall yet.");
            EXIT_USAGE
        }
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
}
