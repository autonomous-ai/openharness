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
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

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

    #[test]
    fn the_system_answers() {
        // Read-only lookups: either answer is right; the calls must return.
        let _ = SystemDesktopApp.installed();
        let _ = SystemDesktopApp.running();
    }

    fn entry(exec: &str) -> String {
        format!("[Desktop Entry]\nType=Application\nName=Harness\n{exec}\nTerminal=false\n")
    }

    #[test]
    fn an_entrys_exec_names_its_program() {
        assert_eq!(exec_target(&entry(r#"Exec="/a b/H.AppImage" %u"#)).as_deref(), Some("/a b/H.AppImage"));
        assert_eq!(exec_target(&entry("Exec=/a/H.AppImage %u")).as_deref(), Some("/a/H.AppImage"));
        assert_eq!(exec_target(&entry("Exec=/a/H.AppImage")).as_deref(), Some("/a/H.AppImage"));
        // Desktop puts a backslash before `"`, `` ` ``, `$` and `\` inside the quotes.
        let escaped = entry(r#"Exec="/a \"b\" \$c\\d/H.AppImage" %u"#);
        assert_eq!(exec_target(&escaped).as_deref(), Some(r#"/a "b" $c\d/H.AppImage"#));
        assert_eq!(exec_target(&entry(r#"Exec="/a b/H.AppImage %u"#)), None);
        assert_eq!(exec_target(&entry("TryExec=/a/H.AppImage")), None);
    }

    // Unix only: `/home/n` is not an absolute path on Windows.
    #[cfg(unix)]
    #[test]
    fn the_linux_desktop_app_is_its_entrys_appimage_while_it_is_on_disk() {
        let home = Path::new("/home/n");
        let image = "/home/n/My Apps/Harness.AppImage";
        let text = entry(r#"Exec="/home/n/My Apps/Harness.AppImage" %u"#);
        let at = |entry_path: &'static str, text: String| {
            move |path: &Path| (path == Path::new(entry_path)).then(|| text.clone())
        };
        let on_disk = |path: &Path| path == Path::new(image);
        let gone = |_: &Path| false;
        let found = Some(PathBuf::from(image));

        let local = at("/home/n/.local/share/applications/harness.desktop", text.clone());
        assert_eq!(linux_desktop_app(None, home, &local, &on_disk), found);
        assert_eq!(linux_desktop_app(None, home, &|_: &Path| None, &on_disk), None);
        assert_eq!(linux_desktop_app(None, home, &local, &gone), None);

        let xdg = at("/x/data/applications/harness.desktop", text.clone());
        assert_eq!(linux_desktop_app(Some(OsStr::new("/x/data")), home, &xdg, &on_disk), found);
        // A relative XDG_DATA_HOME is invalid by the base directory spec: the default stands.
        assert_eq!(linux_desktop_app(Some(OsStr::new("x/data")), home, &local, &on_disk), found);
        assert_eq!(linux_desktop_app(Some(OsStr::new("")), home, &local, &on_disk), found);

        let relative = at("/home/n/.local/share/applications/harness.desktop", entry("Exec=Harness.AppImage %u"));
        assert_eq!(linux_desktop_app(None, home, &relative, &|_: &Path| true), None);
    }

    #[test]
    fn the_windows_desktop_app_is_its_launcher() {
        let local = OsStr::new("/u/AppData/Local");
        let launcher = Path::new("/u/AppData/Local").join("Programs").join("Harness").join("Harness.exe");
        let there = |path: &Path| path == launcher;
        assert_eq!(windows_desktop_app(Some(local), &there), Some(launcher.clone()));
        assert_eq!(windows_desktop_app(Some(local), &|_: &Path| false), None);
        assert_eq!(windows_desktop_app(None, &|_: &Path| true), None);
        assert_eq!(windows_desktop_app(Some(OsStr::new("")), &|_: &Path| true), None);
    }
}
