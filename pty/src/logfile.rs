//! The host's log: `<home>/logs/pty-host-<instance>.log`, the owner's alone, kept to a size.
//!
//! The daemon starts the host with no stdio, so `log` records (and the host's own diagnostics) would
//! go nowhere without this. Each line goes to the file and to stderr, so a host run by hand in a
//! terminal still shows them. Past [`MAX_BYTES`] the file is moved to `pty-host-<instance>.log.1` (one older
//! file is kept) and a new one is started.
//!
//! One host per home and instance holds the home's lock (`host_lock`), but a host that lost the race for it, or the
//! Windows copy that left a job (`breakaway`), may append a line or two before it exits. Only the
//! lock's holder rotates (`own_rotation`, called once the lock is taken): a loser that rotated would
//! leave the winner writing to `.log.1`, and the winner's next rotation would replace those lines.
//!
//! A rotation that fails (on Windows, a reader holding the file without delete sharing) is not
//! tried again on every line, each with `files::rename`'s waits under the lock: the file grows by
//! another [`MAX_BYTES`] first.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

/// The size past which the log is rotated.
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;

pub fn log_dir(home: &Path) -> PathBuf {
    home.join("logs")
}

pub fn log_path(home: &Path) -> PathBuf {
    crate::instance::log_path(home, &crate::instance::current())
}

/// The rotated file: `pty-host-<instance>.log.1`.
pub fn rotated_path(home: &Path) -> PathBuf {
    let mut rotated = log_path(home).into_os_string();
    rotated.push(".1");
    PathBuf::from(rotated)
}

pub struct FileLog {
    level: log::LevelFilter,
    max_bytes: u64,
    stderr: bool,
    /// Whether this process may rotate the file: the home lock's holder only.
    rotates: AtomicBool,
    state: Mutex<State>,
}

/// The installed logger, for `own_rotation`.
static INSTALLED: std::sync::OnceLock<&'static FileLog> = std::sync::OnceLock::new();

struct State {
    path: PathBuf,
    rotated: PathBuf,
    /// None once the file could not be opened: lines then go to stderr only.
    file: Option<File>,
    size: u64,
}

impl FileLog {
    /// Open (or create) the log under [home]. When the file cannot be opened, the logger still
    /// writes to stderr, and the error is returned alongside so the caller can report it.
    pub fn open(
        home: &Path,
        max_bytes: u64,
        stderr: bool,
        rotates: bool,
    ) -> (FileLog, Option<io::Error>) {
        let (path, rotated) = (log_path(home), rotated_path(home));
        let opened = open_log(home, &path);
        let (file, size, error) = match opened {
            Ok((file, size)) => (Some(file), size, None),
            Err(err) => (None, 0, Some(err)),
        };
        let level = std::env::var("HARNESS_PTY_LOG")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(log::LevelFilter::Info);
        let log = FileLog {
            level,
            max_bytes,
            stderr,
            rotates: AtomicBool::new(rotates),
            state: Mutex::new(State {
                path,
                rotated,
                file,
                size,
            }),
        };
        (log, error)
    }

    fn write_line(&self, line: &str) {
        if self.stderr {
            let _ = io::stderr().write_all(line.as_bytes());
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.file.is_none() {
            return;
        }
        if state.size > 0
            && state.size + line.len() as u64 > self.max_bytes
            && self.rotates.load(Ordering::Relaxed)
        {
            state.rotate();
        }
        let State { file, size, .. } = &mut *state;
        if let Some(file) = file
            && file.write_all(line.as_bytes()).is_ok()
        {
            *size += line.len() as u64;
        }
    }
}

impl State {
    /// `pty-host-<instance>.log` → `pty-host-<instance>.log.1` (replacing it), then a new, empty
    /// `pty-host-<instance>.log`. When the rename fails the same file is reopened, and its size
    /// counted from zero: the next try is another cap's worth of lines away.
    fn rotate(&mut self) {
        self.file = None;
        let renamed = crate::files::rename(&self.path, &self.rotated).is_ok();
        let home = self
            .path
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf);
        if let Some(home) = home
            && let Ok((file, size)) = open_log(&home, &self.path)
        {
            self.file = Some(file);
            self.size = if renamed { size } else { 0 };
        }
    }
}

impl log::Log for FileLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} pid {} {} {}: {}\n",
            utc_now(),
            std::process::id(),
            record.level(),
            record.target(),
            record.args()
        );
        self.write_line(&line);
    }

    fn flush(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(file) = state.file.as_mut() {
            let _ = file.flush();
        }
    }
}

/// Install the host's logger for [home] (once per process; a second call changes nothing). A log
/// file that cannot be opened is reported, on stderr, and the host carries on without one.
pub fn install(home: &Path) {
    let (log, error) = FileLog::open(home, MAX_BYTES, true, false);
    let level = log.level;
    // Leaked: the logger lives as long as the process.
    let log: &'static FileLog = Box::leak(Box::new(log));
    if log::set_logger(log).is_ok() {
        log::set_max_level(level);
        let _ = INSTALLED.set(log);
    }
    if let Some(err) = error {
        log::warn!("no log file under {}: {err}", log_dir(home).display());
    }
}

/// This process holds the home's lock: from now on it rotates the log (the module comment).
pub fn own_rotation() {
    if let Some(log) = INSTALLED.get() {
        log.rotates.store(true, Ordering::Relaxed);
    }
}

/// `<home>/logs/`, the owner's alone (0700 on Unix, the run directory's user-only DACL on Windows),
/// then the log in it, opened to append: created 0600 on Unix (and made so, whatever an older file
/// had), on Windows with the user-only DACL from its creation, and shared, so it can be read (and
/// rotated) while it is open.
fn open_log(home: &Path, path: &Path) -> io::Result<(File, u64)> {
    let dir = log_dir(home);
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        let file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(path)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file
    };
    #[cfg(windows)]
    let file = {
        std::fs::create_dir_all(home)?;
        crate::transport::windows::secure_dir(&dir)?;
        crate::transport::windows::open_private_append(path)?
    };
    let size = file.metadata()?.len();
    Ok((file, size))
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, with no date crate.
fn utc_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format_utc(now.as_secs(), now.subsec_millis())
}

fn format_utc(secs: u64, millis: u32) -> String {
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::Log;

    fn record(log: &FileLog, level: log::Level, message: &str) {
        log.log(
            &log::Record::builder()
                .level(level)
                .target("harness_pty::test")
                .args(format_args!("{message}"))
                .build(),
        );
    }

    #[test]
    fn formats_utc_times() {
        assert_eq!(format_utc(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_utc(951_782_400, 7), "2000-02-29T00:00:00.007Z");
        assert_eq!(format_utc(1_791_893_045, 999), "2026-10-13T12:04:05.999Z");
    }

    #[test]
    fn writes_lines_to_an_owner_only_file_and_appends_across_opens() {
        let home = tempfile::tempdir().unwrap();
        let (log, error) = FileLog::open(home.path(), MAX_BYTES, false, true);
        assert!(error.is_none(), "{error:?}");
        record(&log, log::Level::Info, "first");
        record(&log, log::Level::Debug, "not at info");
        drop(log);
        let (log, _) = FileLog::open(home.path(), MAX_BYTES, false, true);
        record(&log, log::Level::Error, "second");
        let text = std::fs::read_to_string(log_path(home.path())).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(
            lines[0].ends_with("INFO harness_pty::test: first"),
            "{text}"
        );
        assert!(
            lines[1].ends_with("ERROR harness_pty::test: second"),
            "{text}"
        );
        assert!(lines[1].contains(&format!(" pid {} ", std::process::id())));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&log_dir(home.path())), 0o700);
            assert_eq!(mode(&log_path(home.path())), 0o600);
        }
        #[cfg(windows)]
        {
            use crate::transport::windows::file_dacl;
            file_dacl(&log_dir(home.path())).assert_users_alone(true);
            file_dacl(&log_path(home.path())).assert_only_user_entries();
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_older_log_readable_by_others_is_made_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(log_dir(home.path())).unwrap();
        std::fs::write(log_path(home.path()), "old\n").unwrap();
        std::fs::set_permissions(
            log_path(home.path()),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let (_log, error) = FileLog::open(home.path(), MAX_BYTES, false, true);
        assert!(error.is_none());
        let mode = std::fs::metadata(log_path(home.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn rotates_at_the_cap_and_keeps_one_older_file() {
        let home = tempfile::tempdir().unwrap();
        // Lines of 101 to 150 bytes (the pid's digits vary): two fit under the cap, three do not.
        let (log, _) = FileLog::open(home.path(), 300, false, true);
        let message = "x".repeat(60);
        for _ in 0..3 {
            record(&log, log::Level::Info, &message);
        }
        // The third did not fit beside the first two: they were moved aside.
        let older = std::fs::read_to_string(rotated_path(home.path())).unwrap();
        let current = std::fs::read_to_string(log_path(home.path())).unwrap();
        assert_eq!(older.lines().count(), 2, "{older}");
        assert_eq!(current.lines().count(), 1, "{current}");
        for _ in 0..2 {
            record(&log, log::Level::Info, &message);
        }
        // Rotated again: the oldest file is replaced, not kept beside.
        assert_eq!(
            std::fs::read_to_string(rotated_path(home.path()))
                .unwrap()
                .lines()
                .count(),
            2
        );
        assert_eq!(
            std::fs::read_to_string(log_path(home.path()))
                .unwrap()
                .lines()
                .count(),
            1
        );
        let names: Vec<_> = std::fs::read_dir(log_dir(home.path()))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(log_path(home.path()))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_process_that_does_not_hold_the_lock_never_rotates() {
        let home = tempfile::tempdir().unwrap();
        let (log, _) = FileLog::open(home.path(), 300, false, false);
        for _ in 0..5 {
            record(&log, log::Level::Info, &"x".repeat(60));
        }
        assert!(!rotated_path(home.path()).exists());
        let text = std::fs::read_to_string(log_path(home.path())).unwrap();
        assert_eq!(text.lines().count(), 5);
        // Once it holds it, it does.
        log.rotates.store(true, Ordering::Relaxed);
        record(&log, log::Level::Info, "next");
        assert!(rotated_path(home.path()).exists());
    }

    #[test]
    fn a_rotation_that_fails_is_tried_again_only_a_cap_later() {
        let home = tempfile::tempdir().unwrap();
        let (log, _) = FileLog::open(home.path(), 300, false, true);
        // `.log.1` is a directory with something in it: the file cannot be renamed over it.
        std::fs::create_dir_all(rotated_path(home.path()).join("held")).unwrap();
        let message = "x".repeat(60);
        for _ in 0..3 {
            record(&log, log::Level::Info, &message);
        }
        // The third line went in, to the same file.
        assert_eq!(
            std::fs::read_to_string(log_path(home.path()))
                .unwrap()
                .lines()
                .count(),
            3
        );
        // Free to rotate now, but not yet tried again: the count started over at the failure.
        std::fs::remove_dir_all(rotated_path(home.path())).unwrap();
        record(&log, log::Level::Info, &message);
        assert!(!rotated_path(home.path()).exists());
        // The next line would take it over the cap again: the rotation is made.
        record(&log, log::Level::Info, &message);
        assert!(rotated_path(home.path()).is_file());
        assert_eq!(
            std::fs::read_to_string(log_path(home.path()))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }

    #[test]
    fn a_log_that_cannot_be_opened_leaves_stderr() {
        let home = tempfile::tempdir().unwrap();
        // `logs` is a file: no directory can be made there.
        std::fs::write(log_dir(home.path()), "").unwrap();
        let (log, error) = FileLog::open(home.path(), MAX_BYTES, false, true);
        assert!(error.is_some());
        record(&log, log::Level::Error, "still fine");
    }
}
