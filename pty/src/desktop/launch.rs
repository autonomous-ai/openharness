//! The launch path: `Harness.exe [--wait-pid <pid>] [<link>...]` starts `app\<current>\harness-desktop.exe` from its
//! version folder with the same arguments, records the start and exits. rollback.rs decides when to go back;
//! an install-scoped OS guard serializes its history with folder replacement. Diagnostics go to `launch.log`
//! beside the launcher, kept to [LOG_MAX_BYTES].

use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::pointer::{self, CURRENT, PREVIOUS};
use super::rollback::{self, Choice, LaunchHistory, Looked, Record, Start};
use super::system::System;
use super::{APP_DIR, APP_EXE, EXIT_BROKEN, EXIT_FAILED, EXIT_OK, EXIT_SPAWN};
use super::{LAUNCHER_EXE, registry};

pub const LOG: &str = "launch.log";
pub const STATE: &str = "launch-state.json";
const HISTORY_LOCK: &str = "launch-state.lock";
const HISTORY_WAIT: Duration = Duration::from_secs(10);
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

/// Recorded starts belong to this install's version folders.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub starts: Vec<Start>,
}

/// Missing/corrupt history only delays rollback; it never prevents starting.
pub fn read_state(root: &Path) -> State {
    fs::read(root.join(STATE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// One persistent empty coordination file. Never unlink it: a waiter must keep
/// observing the same OS lock. The File is non-inheritable and closes on unwind.
pub(super) struct HistoryGuard {
    _file: fs::File,
    root: std::path::PathBuf,
}
impl HistoryGuard {
    pub(super) fn acquire(root: &Path) -> io::Result<Self> {
        Self::acquire_for(root, HISTORY_WAIT)
    }
    fn acquire_for(root: &Path, budget: Duration) -> io::Result<Self> {
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join(HISTORY_LOCK))?;
        let began = Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => {
                    return Ok(Self {
                        _file: file,
                        root: root.to_owned(),
                    });
                }
                Err(fs::TryLockError::Error(error)) => return Err(error),
                Err(fs::TryLockError::WouldBlock) => {
                    let left = budget.saturating_sub(began.elapsed());
                    if left.is_zero() {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "another Harness launch or install is still finishing. Try again",
                        ));
                    }
                    std::thread::sleep(left.min(Duration::from_millis(50)));
                }
            }
        }
    }
    pub(super) fn write(&self, state: &State) -> io::Result<()> {
        let tmp = self
            .root
            .join(format!("{STATE}.{}.tmp", uuid::Uuid::new_v4().simple()));
        write_state_file(&self.root, state, &tmp)
    }
}

/// Replace one complete JSON document through an exclusively owned temporary.
fn write_state_file(root: &Path, state: &State, tmp: &Path) -> io::Result<()> {
    let bytes = serde_json::to_vec(state).map_err(io::Error::other)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp)?;
    let written = (move || {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        crate::files::rename(tmp, &root.join(STATE))
    })();
    if written.is_err() {
        let _ = fs::remove_file(tmp);
    }
    written
}

/// Independent callers acquire once; code already holding HistoryGuard uses write.
pub fn write_state(root: &Path, state: &State) -> io::Result<()> {
    HistoryGuard::acquire(root)?.write(state)
}

pub fn look(root: &Path, state: &State, system: &mut impl System) -> LaunchHistory {
    let current = pointer::read(&root.join(CURRENT)).ok();
    let previous = pointer::read(&root.join(PREVIOUS)).ok();
    let has = |v: &Option<String>, name: &str| {
        v.as_ref()
            .is_some_and(|v| root.join(APP_DIR).join(v).join(name).is_file())
    };
    let starts: Vec<_> = state
        .starts
        .iter()
        .map(|start| Looked {
            start: start.clone(),
            liveness: system.liveness(start.pid, start.created),
        })
        .collect();
    // A recorded current app can still own the instance before creating its
    // Flutter window. Preserve that proof instead of recording handover exits.
    let instance_running = !system.app_processes(root).is_empty()
        || starts.iter().any(|looked| {
            current.as_ref() == Some(&looked.start.version)
                && looked.liveness == rollback::Liveness::Running
        });
    LaunchHistory {
        now_ms: system.now_ms(),
        current_exe: has(&current, APP_EXE),
        current_started: has(&current, super::STARTED_MARKER),
        previous_exe: has(&previous, APP_EXE),
        instance_running,
        starts,
        current,
        previous,
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

/// The Flutter updater changes `current` without running `--install`, so keep
/// Settings ▸ Apps' existing version in step with the folder we actually open.
fn heal_uninstall_version(
    root: &Path,
    registry_root: &str,
    version: &str,
    system: &mut impl System,
) {
    let old = system.read_value(registry_root, registry::UNINSTALL_KEY, "DisplayVersion");
    // An extracted or portable copy must not create a partial uninstall entry.
    if old.is_none() || old.as_deref() == Some(std::ffi::OsStr::new(version)) {
        return;
    }
    let key = registry::Key {
        path: registry::UNINSTALL_KEY.to_owned(),
        values: vec![(
            "DisplayVersion".to_owned(),
            registry::Value::Text(OsString::from(version)),
        )],
    };
    if let Err(error) = system.write_keys(registry_root, &[key]) {
        log(
            root,
            &format!("could not update Settings version to {version}: {error}"),
        );
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
    run_after_wait(root, args, None, system)
}

fn go_back(root: &Path, to: &str, guard: &HistoryGuard) -> io::Result<()> {
    pointer::write(&root.join(CURRENT), to)?;
    pointer::remove(&root.join(PREVIOUS))?;
    guard.write(&State::default())
}

/// Dispatch and public run have already waited. Acquire once before healing and
/// keep the history/folder decision protected through spawn and recording.
pub(super) fn run_after_wait(
    root: &Path,
    args: &[OsString],
    heal_registry: Option<&str>,
    system: &mut impl System,
) -> i32 {
    if matches!(fs::metadata(root), Err(error) if error.kind() == io::ErrorKind::NotFound) {
        return broken(
            root,
            "`current` is missing or does not name one version folder",
            system,
        );
    }
    let guard = match HistoryGuard::acquire(root) {
        Ok(guard) => guard,
        Err(error) => {
            let reason = format!("could not coordinate this launch: {error}");
            log(root, &reason);
            system.say(&format!("Harness could not start: {reason}."));
            return EXIT_FAILED;
        }
    };
    if let Some(registry) = heal_registry {
        heal_protocol_key(root, registry, system);
    }
    let mut state = read_state(root);
    for _ in 0..2 {
        let history = look(root, &state, system);
        match rollback::decide(&history) {
            Choice::Broken { reason } => return broken(root, &reason, system),
            Choice::RollBack { to, reason } => {
                let result = go_back(root, &to, &guard);
                if let Err(error) = result {
                    return broken(
                        root,
                        &format!("could not finish going back to {to} ({reason}): {error}"),
                        system,
                    );
                }
                state = State::default();
                log(root, &format!("went back to {to}: {reason}"));
            }
            Choice::Launch { version, record } => {
                if let Some(registry) = heal_registry {
                    heal_uninstall_version(root, registry, &version, system);
                }
                let dir = root.join(APP_DIR).join(&version);
                let exe = dir.join(APP_EXE);
                return match system.start_app(&exe, &dir, args) {
                    Ok((pid, created)) => {
                        log(root, &format!("started {version} (process {pid})"));
                        if record != Record::Keep {
                            let start = Start {
                                version,
                                at_ms: history.now_ms,
                                pid,
                                created,
                            };
                            let starts = rollback::recorded(state.starts, Some(start), record);
                            if let Err(error) = guard.write(&State { starts }) {
                                log(root, &format!("could not record the start: {error}"));
                            }
                        }
                        EXIT_OK
                    }
                    Err(error) => {
                        log(root, &format!("could not start {}: {error}", exe.display()));
                        system.say(&format!("Harness could not start: {error}."));
                        EXIT_SPAWN
                    }
                };
            }
        }
    }
    EXIT_BROKEN
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

#[cfg(test)]
mod rollback_tests {
    use super::*;
    use crate::desktop::{
        rollback::{Liveness, Start},
        system::Fake,
    };
    use std::io::Read;
    use std::process::{Child, Command, Stdio};
    use std::time::Instant;

    fn install() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for v in ["1.0.0", "2.0.0"] {
            let folder = dir.path().join("app").join(v);
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join(APP_EXE), b"app").unwrap();
        }
        pointer::write(&dir.path().join(CURRENT), "2.0.0").unwrap();
        pointer::write(&dir.path().join("previous"), "1.0.0").unwrap();
        fs::write(dir.path().join("app/1.0.0/.started"), b"once").unwrap();
        dir
    }
    fn start(n: u32) -> Start {
        Start {
            version: "2.0.0".into(),
            at_ms: 1_000,
            pid: n,
            created: u64::from(n),
        }
    }
    fn failures(root: &Path) {
        write_state(
            root,
            &State {
                starts: vec![start(10), start(11)],
            },
        )
        .unwrap();
    }

    #[test]
    fn third_start_goes_back_and_forgets_history() {
        let dir = install();
        let mut sys = Fake {
            liveness: Liveness::Ended,
            ..Default::default()
        };
        for _ in 0..3 {
            assert_eq!(run(dir.path(), None, &[], &mut sys), EXIT_OK);
        }
        let versions: Vec<_> = sys
            .started
            .iter()
            .map(|(_, dir, _)| dir.file_name().unwrap().to_str().unwrap())
            .collect();
        assert_eq!(versions, ["2.0.0", "2.0.0", "1.0.0"]);
        assert_eq!(fs::read(dir.path().join(CURRENT)).unwrap(), b"1.0.0\r\n");
        assert!(!dir.path().join("previous").exists());
        assert!(read_state(dir.path()).starts.is_empty());
        assert!(
            fs::read_to_string(dir.path().join(LOG))
                .unwrap()
                .contains("went back to 1.0.0")
        );
    }
    #[test]
    fn running_start_never_rolls_back_and_success_marker_clears_history() {
        let dir = install();
        failures(dir.path());
        let mut sys = Fake {
            liveness: Liveness::Running,
            ..Default::default()
        };
        assert_eq!(run(dir.path(), None, &[], &mut sys), EXIT_OK);
        assert_eq!(pointer::read(&dir.path().join(CURRENT)).unwrap(), "2.0.0");
        fs::write(dir.path().join("app/2.0.0/.started"), b"once").unwrap();
        sys.liveness = Liveness::Ended;
        assert_eq!(run(dir.path(), None, &[], &mut sys), EXIT_OK);
        assert!(read_state(dir.path()).starts.is_empty());
    }
    #[test]
    fn handoff_keeps_nonempty_state_without_rewriting_it() {
        let dir = install();
        failures(dir.path());
        let before = fs::read(dir.path().join(STATE)).unwrap();
        let mut sys = Fake {
            running: vec![3],
            liveness: Liveness::Ended,
            ..Default::default()
        };
        assert_eq!(run(dir.path(), None, &[], &mut sys), EXIT_OK);
        assert_eq!(fs::read(dir.path().join(STATE)).unwrap(), before);
        assert_eq!(pointer::read(&dir.path().join(CURRENT)).unwrap(), "2.0.0");
    }
    #[test]
    fn wait_failure_precedes_guard_and_all_history_effects() {
        let dir = install();
        let mut sys = Fake {
            fail_wait: Some(io::ErrorKind::TimedOut),
            ..Default::default()
        };
        assert_eq!(run(dir.path(), Some(7), &[], &mut sys), EXIT_FAILED);
        assert!(!dir.path().join(HISTORY_LOCK).exists());
        assert!(!dir.path().join(STATE).exists());
        assert!(sys.started.is_empty());
        assert_eq!(pointer::read(&dir.path().join(CURRENT)).unwrap(), "2.0.0");
    }
    #[test]
    fn missing_root_is_broken_without_creating_it() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert_eq!(run(&missing, None, &[], &mut Fake::default()), EXIT_BROKEN);
        assert!(!missing.exists());
    }
    #[test]
    fn spawn_failure_never_appends_and_logs_no_uri() {
        let dir = install();
        write_state(
            dir.path(),
            &State {
                starts: vec![start(1)],
            },
        )
        .unwrap();
        let before = fs::read(dir.path().join(STATE)).unwrap();
        let mut sys = Fake {
            fail_start: true,
            ..Default::default()
        };
        assert_eq!(
            run(dir.path(), None, &["harness://secret".into()], &mut sys),
            EXIT_SPAWN
        );
        assert_eq!(fs::read(dir.path().join(STATE)).unwrap(), before);
        sys.fail_start = false;
        assert_eq!(
            run(dir.path(), None, &["harness://secret".into()], &mut sys),
            EXIT_OK
        );
        let log = fs::read_to_string(dir.path().join(LOG)).unwrap();
        assert!(log.contains("started 2.0.0 (process 100)"));
        assert!(!log.contains("secret"));
    }
    #[test]
    fn partial_rollback_failure_never_claims_success_or_spawns() {
        let dir = install();
        failures(dir.path());
        fs::remove_file(dir.path().join(CURRENT)).unwrap();
        fs::create_dir(dir.path().join(CURRENT)).unwrap();
        let mut sys = Fake {
            liveness: Liveness::Ended,
            ..Default::default()
        };
        assert_eq!(run(dir.path(), None, &[], &mut sys), EXIT_BROKEN);
        assert!(sys.started.is_empty());
        assert!(
            !fs::read_to_string(dir.path().join(LOG))
                .unwrap()
                .contains("went back to")
        );
        // Exercise failure after the already-selected fallback is published.
        let dir = install();
        failures(dir.path());
        fs::remove_file(dir.path().join(PREVIOUS)).unwrap();
        fs::create_dir(dir.path().join(PREVIOUS)).unwrap();
        let guard = HistoryGuard::acquire(dir.path()).unwrap();
        assert!(go_back(dir.path(), "1.0.0", &guard).is_err());
        assert_eq!(pointer::read(&dir.path().join(CURRENT)).unwrap(), "1.0.0");
        assert_eq!(read_state(dir.path()).starts.len(), 2);
        assert!(!dir.path().join(LOG).exists());
    }

    #[test]
    fn corrupt_state_is_empty_and_whole_replacements_leave_no_temporary_file() {
        let dir = install();
        fs::write(dir.path().join(STATE), b"{broken").unwrap();
        assert!(read_state(dir.path()).starts.is_empty());
        for pid in [1, 2] {
            write_state(
                dir.path(),
                &State {
                    starts: vec![start(pid)],
                },
            )
            .unwrap();
            assert_eq!(read_state(dir.path()).starts, vec![start(pid)]);
        }
        assert!(
            !fs::read_dir(dir.path()).unwrap().any(|e| e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp"))
        );
    }
    #[test]
    fn state_temp_collision_preserves_other_output_and_prior_json() {
        let dir = install();
        failures(dir.path());
        let prior = fs::read(dir.path().join(STATE)).unwrap();
        let tmp = dir.path().join("collision.tmp");
        fs::write(&tmp, b"other writer").unwrap();
        assert!(write_state_file(dir.path(), &State::default(), &tmp).is_err());
        assert_eq!(fs::read(&tmp).unwrap(), b"other writer");
        assert_eq!(fs::read(dir.path().join(STATE)).unwrap(), prior);
        fs::remove_file(dir.path().join(STATE)).unwrap();
        fs::create_dir(dir.path().join(STATE)).unwrap();
        let owned = dir.path().join("owned.tmp");
        assert!(write_state_file(dir.path(), &State::default(), &owned).is_err());
        assert!(!owned.exists());
    }
    #[test]
    fn failed_history_write_after_spawn_is_logged_without_failing_the_app() {
        let dir = install();
        fs::create_dir(dir.path().join(STATE)).unwrap();
        let mut sys = Fake::default();
        assert_eq!(run(dir.path(), None, &[], &mut sys), EXIT_OK);
        assert_eq!(sys.started.len(), 1);
        assert!(
            fs::read_to_string(dir.path().join(LOG))
                .unwrap()
                .contains("could not record the start")
        );
    }
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }
    fn child(root: &Path, mode: &str) -> OwnedChild {
        OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "desktop::launch::rollback_tests::lock_child",
                    "--nocapture",
                ])
                .env("HARNESS_LOCK_TEST_ROOT", root)
                .env("HARNESS_LOCK_TEST_MODE", mode)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        )
    }
    #[test]
    fn coordination_io_failure_is_immediate_and_never_starts() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("not-a-directory");
        fs::write(&file, b"unchanged").unwrap();
        let mut sys = Fake::default();
        let began = Instant::now();
        assert_eq!(run(&file, None, &[], &mut sys), EXIT_FAILED);
        assert!(began.elapsed() < Duration::from_secs(1));
        assert!(sys.started.is_empty());
        assert_eq!(fs::read(file).unwrap(), b"unchanged");
    }
    #[test]
    fn a_windowless_running_current_start_survives_ended_secondary_attempts() {
        let dir = install();
        let mut sys = Fake::default();
        assert_eq!(run(dir.path(), None, &[], &mut sys), EXIT_OK);
        let original = read_state(dir.path());
        assert_eq!(original.starts.len(), 1);
        let before = fs::read(dir.path().join(STATE)).unwrap();
        // A has no window. B/C/D are handover attempts; none may replace A's proof.
        sys.liveness = Liveness::Running;
        for _ in 0..3 {
            assert_eq!(run(dir.path(), None, &[], &mut sys), EXIT_OK);
            assert_eq!(fs::read(dir.path().join(STATE)).unwrap(), before);
            assert_eq!(pointer::read(&dir.path().join(CURRENT)).unwrap(), "2.0.0");
        }
        assert!(
            !fs::read_to_string(dir.path().join(LOG))
                .unwrap()
                .contains("went back")
        );
        // A ends without a frame. A and the next cold start are two genuine failures.
        sys.liveness = Liveness::Ended;
        assert_eq!(run(dir.path(), None, &[], &mut sys), EXIT_OK);
        assert_eq!(pointer::read(&dir.path().join(CURRENT)).unwrap(), "2.0.0");
        assert_eq!(read_state(dir.path()).starts.len(), 2);
        assert_eq!(run(dir.path(), None, &[], &mut sys), EXIT_OK);
        assert_eq!(pointer::read(&dir.path().join(CURRENT)).unwrap(), "1.0.0");
    }
    #[test]
    fn only_positive_current_evidence_adds_a_running_instance() {
        let dir = install();
        let mut state = State {
            starts: vec![start(1)],
        };
        let mut sys = Fake {
            liveness: Liveness::Running,
            ..Default::default()
        };
        assert!(look(dir.path(), &state, &mut sys).instance_running);
        state.starts[0].version = "1.0.0".into();
        assert!(!look(dir.path(), &state, &mut sys).instance_running);
        state.starts[0].version = "2.0.0".into();
        for liveness in [Liveness::Unknown, Liveness::Ended] {
            sys.liveness = liveness;
            assert!(!look(dir.path(), &state, &mut sys).instance_running);
        }
        sys.liveness = Liveness::Running;
        fs::remove_file(dir.path().join("app/2.0.0").join(APP_EXE)).unwrap();
        let history = look(dir.path(), &state, &mut sys);
        assert!(matches!(rollback::decide(&history), Choice::RollBack { to, .. } if to == "1.0.0"));
    }
    #[test]
    fn lock_child() {
        let Some(root) = std::env::var_os("HARNESS_LOCK_TEST_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        match std::env::var("HARNESS_LOCK_TEST_MODE").unwrap().as_str() {
            "probe" => {
                assert!(HistoryGuard::acquire_for(&root, Duration::ZERO).is_err());
            }
            "append" => {
                let guard = HistoryGuard::acquire(&root).unwrap();
                let mut state = read_state(&root);
                state.starts.push(start(12));
                guard.write(&state).unwrap();
            }
            "hold" => {
                let _guard = HistoryGuard::acquire(&root).unwrap();
                fs::write(root.join("ready"), b"ready").unwrap();
                let mut one = [0u8];
                let _ = std::io::stdin().read_exact(&mut one);
            }
            _ => panic!("unknown owned child mode"),
        }
    }
    #[test]
    fn crossprocess_guard_serializes_records_and_owner_exit_releases_it() {
        let dir = install();
        let guard = HistoryGuard::acquire(dir.path()).unwrap();
        let mut probe = child(dir.path(), "probe");
        assert!(probe.0.wait().unwrap().success());
        let began = Instant::now();
        assert!(HistoryGuard::acquire_for(dir.path(), Duration::from_millis(20)).is_err());
        assert!(began.elapsed() < Duration::from_secs(2));
        guard
            .write(&State {
                starts: vec![start(11)],
            })
            .unwrap();
        drop(guard);
        let mut append = child(dir.path(), "append");
        assert!(append.0.wait().unwrap().success());
        assert_eq!(read_state(dir.path()).starts, vec![start(11), start(12)]);
        let mut sys = Fake {
            liveness: Liveness::Ended,
            ..Default::default()
        };
        assert_eq!(run(dir.path(), None, &[], &mut sys), EXIT_OK);
        assert_eq!(pointer::read(&dir.path().join(CURRENT)).unwrap(), "1.0.0");
        let hold = child(dir.path(), "hold");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !dir.path().join("ready").is_file() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(hold);
        let _guard = HistoryGuard::acquire_for(dir.path(), Duration::ZERO).unwrap();
        assert!(dir.path().join(HISTORY_LOCK).is_file());
    }
}
