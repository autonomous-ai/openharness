//! The launch path: `Harness.exe [--wait-pid <pid>] [<link>...]` starts `app\<current>\harness-desktop.exe` from its
//! version folder with the same arguments, and exits. What it did not manage goes to `launch.log` beside it, kept to
//! [LOG_MAX_BYTES].

use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use super::pointer::{self, CURRENT};
use super::system::System;
use super::{APP_DIR, APP_EXE, EXIT_BROKEN, EXIT_FAILED, EXIT_OK, EXIT_SPAWN};
use super::{LAUNCHER_EXE, registry};

pub const LOG: &str = "launch.log";
/// Past this the log keeps its newer half.
pub const LOG_MAX_BYTES: u64 = 64 * 1024;
/// How long `--wait-pid` waits for the app being replaced to end.
pub const WAIT_FOR_REPLACED: Duration = Duration::from_secs(15);

/// One line in `<root>\launch.log`. When the line would take the file past [LOG_MAX_BYTES], the older half goes
/// first, from a line's start. An oversized message keeps its UTF-8 suffix within
/// half the limit, leaving room for the retained older lines. A log that cannot be
/// written is not a second failure.
pub fn log(root: &Path, message: &str) {
    let path = root.join(LOG);
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let prefix = format!("{seconds} Harness.exe: ");
    let budget = LOG_MAX_BYTES as usize / 2 - prefix.len() - 4;
    let mut from = message.len().saturating_sub(budget);
    while !message.is_char_boundary(from) {
        from += 1;
    }
    let truncated = if from > 0 { "..." } else { "" };
    let line = format!("{prefix}{truncated}{}\n", &message[from..]);
    if let Ok(meta) = fs::metadata(&path)
        && meta.len() + line.len() as u64 > LOG_MAX_BYTES
        && let Ok(text) = fs::read(&path)
    {
        let from = text.len().saturating_sub((LOG_MAX_BYTES / 2) as usize);
        let start = text[from..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| from + i + 1)
            .unwrap_or(text.len());
        let _ = fs::write(&path, &text[start..]);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// The `harness://` key names this launcher; rewritten when it names anything else. One registry read when it does.
pub fn heal_protocol_key(root: &Path, registry_root: &str, system: &mut impl System) {
    let launcher = root.join(LAUNCHER_EXE);
    let want = registry::open_command(&launcher);
    let key = registry::protocol_command_key(registry::SCHEME);
    if system.read_value(registry_root, &key, "").as_deref() == Some(want.as_os_str()) {
        return;
    }
    match system.write_keys(
        registry_root,
        &registry::protocol_keys(registry::SCHEME, &launcher),
    ) {
        Ok(()) => log(
            root,
            &format!("harness:// links now open {}", launcher.display()),
        ),
        Err(err) => log(
            root,
            &format!(
                "could not point harness:// links at {}: {err}",
                launcher.display()
            ),
        ),
    }
}

/// Wait before any launch/installation side effect. The caller chooses the diagnostic location.
pub(super) fn wait_for_replaced(
    wait_pid: Option<u32>,
    system: &mut impl System,
) -> Result<(), String> {
    if let Some(pid) = wait_pid {
        system.wait_for_exit(pid, WAIT_FOR_REPLACED).map_err(|error| format!("could not wait for previous Harness process {pid}: {error}. Close Harness and try again"))?;
    }
    Ok(())
}

pub(super) fn wait_before_launch(
    root: &Path,
    wait_pid: Option<u32>,
    system: &mut impl System,
) -> bool {
    match wait_for_replaced(wait_pid, system) {
        Ok(()) => true,
        Err(reason) => {
            log(root, &reason);
            system.say(&format!("Harness could not start: {reason}."));
            false
        }
    }
}

/// B's fallback warning belongs to this install for either a launcher or app child.
#[cfg(any(windows, test))]
pub(super) fn start_warning(exe: &Path, dir: &Path, warning: &str) {
    let root = if exe
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case(LAUNCHER_EXE))
    {
        dir
    } else {
        dir.parent().and_then(Path::parent).unwrap_or(dir)
    };
    log(root, warning);
}

fn broken(root: &Path, reason: &str, system: &mut impl System) -> i32 {
    log(root, reason);
    system.say(&format!(
        "Harness cannot start: {reason}. Download Harness again and open it to repair it."
    ));
    EXIT_BROKEN
}

/// The launch: see the module comment.
pub fn run(root: &Path, wait_pid: Option<u32>, args: &[OsString], system: &mut impl System) -> i32 {
    if !wait_before_launch(root, wait_pid, system) {
        return EXIT_FAILED;
    }
    let Ok(version) = pointer::read(&root.join(CURRENT)) else {
        return broken(
            root,
            "`current` is missing or does not name one version folder",
            system,
        );
    };
    let dir = root.join(APP_DIR).join(&version);
    let exe = dir.join(APP_EXE);
    if !exe.is_file() {
        return broken(root, &format!("app\\{version} has no {APP_EXE}"), system);
    }
    match system.start_app(&exe, &dir, args) {
        Ok(_) => EXIT_OK,
        Err(err) => {
            log(root, &format!("could not start {}: {err}", exe.display()));
            system.say(&format!("Harness could not start: {err}."));
            EXIT_SPAWN
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::system::Fake;

    /// An install with these version folders (each with its exe) and `current`.
    fn install(versions: &[&str], current: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for version in versions {
            let folder = dir.path().join(APP_DIR).join(version);
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join(APP_EXE), b"").unwrap();
        }
        if let Some(current) = current {
            pointer::write(&dir.path().join(CURRENT), current).unwrap();
        }
        dir
    }

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn starts_the_current_version_from_its_folder_with_the_links() {
        let dir = install(&["1.2.3"], Some("1.2.3"));
        let mut system = Fake::default();
        assert_eq!(
            run(dir.path(), None, &os(&["harness://x y"]), &mut system),
            EXIT_OK
        );
        let folder = dir.path().join(APP_DIR).join("1.2.3");
        assert_eq!(
            system.started,
            vec![(folder.join(APP_EXE), folder.clone(), os(&["harness://x y"]))]
        );
    }

    #[test]
    fn waits_for_the_app_being_replaced_first() {
        let dir = install(&["1.2.3"], Some("1.2.3"));
        let mut system = Fake::default();
        run(dir.path(), Some(77), &[], &mut system);
        assert_eq!(system.waited, vec![77]);
        assert_eq!(system.started.len(), 1);
    }

    #[test]
    fn a_wait_timeout_or_error_never_starts_the_replacement() {
        let dir = install(&["1.2.3"], Some("1.2.3"));
        for kind in [
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::Other,
        ] {
            let mut system = Fake {
                fail_wait: Some(kind),
                ..Fake::default()
            };
            assert_eq!(
                run(dir.path(), Some(77), &os(&["harness://x"]), &mut system),
                EXIT_FAILED
            );
            assert!(system.started.is_empty());
            assert_eq!(system.waited, vec![77]);
            assert!(system.said[0].contains("Close Harness and try again"));
        }
        assert!(
            fs::read_to_string(dir.path().join(LOG))
                .unwrap()
                .contains("could not wait for previous Harness process 77")
        );
    }

    #[test]
    fn a_broken_install_says_so_and_exits_3() {
        let dir = install(&[], None);
        let mut system = Fake::default();
        assert_eq!(run(dir.path(), None, &[], &mut system), EXIT_BROKEN);
        assert!(
            system.said[0].contains("Download Harness again"),
            "{:?}",
            system.said
        );
        assert!(
            fs::read_to_string(dir.path().join(LOG))
                .unwrap()
                .contains("`current` is missing")
        );
        let dir = install(&[], Some("1.2.3"));
        assert_eq!(run(dir.path(), None, &[], &mut system), EXIT_BROKEN);
        assert!(
            fs::read_to_string(dir.path().join(LOG))
                .unwrap()
                .contains("has no harness-desktop.exe")
        );
        assert!(system.started.is_empty());
    }

    #[test]
    fn a_failed_start_says_so_and_exits_4() {
        let dir = install(&["1.2.3"], Some("1.2.3"));
        let mut system = Fake {
            fail_start: true,
            ..Fake::default()
        };
        assert_eq!(run(dir.path(), None, &[], &mut system), EXIT_SPAWN);
        assert!(
            fs::read_to_string(dir.path().join(LOG))
                .unwrap()
                .contains("could not start")
        );
    }

    #[test]
    fn the_log_keeps_its_newer_half_past_its_size() {
        let dir = tempfile::tempdir().unwrap();
        let old = "x".repeat(99) + "\n";
        fs::write(
            dir.path().join(LOG),
            old.repeat((LOG_MAX_BYTES / 100) as usize),
        )
        .unwrap();
        log(dir.path(), "the newest line");
        let text = fs::read_to_string(dir.path().join(LOG)).unwrap();
        assert!(
            text.len() as u64 <= LOG_MAX_BYTES / 2 + 100,
            "{}",
            text.len()
        );
        assert!(text.starts_with('x') && text.ends_with("Harness.exe: the newest line\n"));
    }

    #[test]
    fn one_long_unicode_diagnostic_cannot_overflow_the_log() {
        let dir = tempfile::tempdir().unwrap();
        log(
            dir.path(),
            &("日".repeat(LOG_MAX_BYTES as usize) + " newest"),
        );
        assert!(fs::metadata(dir.path().join(LOG)).unwrap().len() <= LOG_MAX_BYTES);
        log(dir.path(), "afterwards");
        let text = fs::read_to_string(dir.path().join(LOG)).unwrap();
        assert!(text.len() as u64 <= LOG_MAX_BYTES, "{}", text.len());
        assert!(text.contains(" newest\n") && text.ends_with("Harness.exe: afterwards\n"));
    }
    #[test]
    fn start_warnings_stay_beside_the_launcher_for_both_child_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Harness");
        let app = root.join("app/1.2.3");
        fs::create_dir_all(&app).unwrap();
        start_warning(&root.join(LAUNCHER_EXE), &root, "launcher fallback");
        start_warning(&app.join(APP_EXE), &app, "app fallback");
        let text = fs::read_to_string(root.join(LOG)).unwrap();
        assert!(text.contains("launcher fallback") && text.contains("app fallback"));
        assert!(!dir.path().join(LOG).exists());
        assert!(!app.join(LOG).exists());
    }
}
