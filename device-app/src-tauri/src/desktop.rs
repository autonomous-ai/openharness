//! The desktop app: installed, running, and opening it.

use crate::types::Log;
use std::io;
use std::process::{Command, Stdio};
use std::sync::Arc;

pub const DESKTOP_BUNDLE_ID: &str = "ai.autonomous.harness";

/// On macOS both are AppKit lookups: the caller reads them on the main thread.
pub trait DesktopApp: Send + Sync {
    fn installed(&self) -> bool;
    fn running(&self) -> bool;
}

pub struct SystemDesktopApp;

#[cfg(target_os = "macos")]
impl DesktopApp for SystemDesktopApp {
    fn installed(&self) -> bool {
        let id = objc2_foundation::NSString::from_str(DESKTOP_BUNDLE_ID);
        objc2_app_kit::NSWorkspace::sharedWorkspace().URLForApplicationWithBundleIdentifier(&id).is_some()
    }

    fn running(&self) -> bool {
        let id = objc2_foundation::NSString::from_str(DESKTOP_BUNDLE_ID);
        !objc2_app_kit::NSRunningApplication::runningApplicationsWithBundleIdentifier(&id).is_empty()
    }
}

#[cfg(not(target_os = "macos"))]
impl DesktopApp for SystemDesktopApp {
    /// Not looked up off a Mac in this wave.
    fn installed(&self) -> bool {
        false
    }

    fn running(&self) -> bool {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
        let Ok(mut system) = System::new() else {
            return false;
        };
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
        );
        let executables = system
            .processes()
            .values()
            .filter_map(|process| process.exe())
            .map(|exe| exe.to_string_lossy().into_owned());
        running_among(std::env::consts::OS, executables)
    }
}

/// The desktop app's executable, as its Linux and Windows packaging names it.
pub fn process_names(os: &str) -> &'static [&'static str] {
    match os {
        "linux" => &["harness"],
        "windows" => &["harness-desktop.exe"],
        _ => &[],
    }
}

/// Whether one of these executables is the desktop app: its file name, whole.
pub fn running_among(os: &str, mut executables: impl Iterator<Item = String>) -> bool {
    let names = process_names(os);
    // Windows paths may use either separator, and its file names ignore case.
    let windows = os == "windows";
    executables.any(|exe| {
        let file = if windows { exe.rsplit(['/', '\\']).next() } else { exe.rsplit('/').next() }.unwrap_or_default();
        names.iter().any(|name| if windows { name.eq_ignore_ascii_case(file) } else { *name == file })
    })
}

pub fn open_desktop_args() -> [&'static str; 2] {
    ["-b", DESKTOP_BUNDLE_ID]
}

/// By its full path on macOS: a PATH the app was started with never decides what opens a sign-in URL.
#[cfg(target_os = "macos")]
const OPEN: &str = "/usr/bin/open";
#[cfg(not(target_os = "macos"))]
const OPEN: &str = "xdg-open";

/// Starts `open` with these arguments and does not wait for it. An exit that is not 0 is a log line without the
/// arguments: a sign-in URL carries its state in its query.
pub fn run_open(args: &[&str], log: Arc<dyn Log>) -> io::Result<()> {
    let mut command = Command::new(OPEN);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = {
        let _spawning = crate::cli::spawn_lock();
        command.spawn()?
    };
    // Reaped off the caller's thread, so each click leaves no zombie behind.
    std::thread::spawn(move || match child.wait() {
        Ok(status) if !status.success() => log.line(&match status.code() {
            Some(code) => format!("open: exit {code}"),
            None => "open: killed by a signal".to_string(),
        }),
        _ => {}
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_names_come_from_the_desktop_packaging() {
        assert_eq!(process_names("linux"), &["harness"]);
        assert_eq!(process_names("windows"), &["harness-desktop.exe"]);
        assert!(process_names("macos").is_empty());
    }

    fn among(os: &str, exe: &str) -> bool {
        running_among(os, std::iter::once(exe.to_string()))
    }

    #[test]
    fn a_name_matches_the_file_whole() {
        assert!(among("linux", "/opt/harness/harness"));
        for other in ["/usr/bin/node", "/x/harness-pty", "/x/harnessd", "/x/Harness"] {
            assert!(!among("linux", other), "{other}");
        }
        assert!(among("windows", r"C:\x\Harness-Desktop.exe"));
        assert!(!among("macos", "/Applications/Harness.app/Contents/MacOS/harness"));
        assert!(!among("macos", "harness"));
    }

    #[test]
    fn open_harness_is_one_fixed_command() {
        assert_eq!(open_desktop_args(), ["-b", "ai.autonomous.harness"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_system_answers() {
        // Read-only lookups: either answer is right; the calls must return.
        let _ = SystemDesktopApp.installed();
        let _ = SystemDesktopApp.running();
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn no_desktop_app_is_installed_off_a_mac() {
        assert!(!SystemDesktopApp.installed());
        let _ = SystemDesktopApp.running();
    }
}
