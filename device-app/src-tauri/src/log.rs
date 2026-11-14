//! The app's one log, redacted.

use crate::types::{Clock, Log};
use regex::Regex;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

/// Days of logs kept besides today's.
pub const KEEP_DAYS: u64 = 14;

const DAY: u64 = 86_400;

/// `app-YYYYMMDD.log` in `dir`, one per UTC day.
pub struct FileLog {
    dir: PathBuf,
    clock: Arc<dyn Clock>,
    /// The day last written; also keeps two lines from interleaving.
    day: Mutex<u64>,
}

impl FileLog {
    pub fn new(dir: PathBuf, clock: Arc<dyn Clock>) -> FileLog {
        let today = clock.now() / DAY;
        let log = FileLog { dir, clock, day: Mutex::new(today) };
        log.prune(today);
        log
    }

    /// Removes this log's own files older than KEEP_DAYS, and nothing else in the folder.
    fn prune(&self, today: u64) {
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        let oldest = ymd(today.saturating_sub(KEEP_DAYS));
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(day) = name.to_str().and_then(|name| name.strip_prefix("app-")?.strip_suffix(".log")) else {
                continue;
            };
            if day.len() == 8 && day.bytes().all(|byte| byte.is_ascii_digit()) && day < oldest.as_str() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

impl Log for FileLog {
    /// Never fails: a log that cannot be written must not stop the app.
    fn line(&self, text: &str) {
        let now = self.clock.now();
        let today = now / DAY;
        let mut day = self.day.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *day != today {
            *day = today;
            self.prune(today);
        }
        let (hours, minutes, seconds) = (now % DAY / 3600, now % 3600 / 60, now % 60);
        let stamp = format!("{}T{hours:02}:{minutes:02}:{seconds:02}Z", dashed(&ymd(today)));
        let _ = fs::create_dir_all(&self.dir)
            .and_then(|()| {
                fs::OpenOptions::new().create(true).append(true).open(self.dir.join(format!("app-{}.log", ymd(today))))
            })
            .and_then(|mut file| file.write_all(format!("{stamp} {}\n", redact(text)).as_bytes()));
    }
}

/// `YYYYMMDD` for a count of days since 1970-01-01 (Hinnant's civil_from_days).
fn ymd(days: u64) -> String {
    let z = days + 719_468;
    let (era, doe) = (z / 146_097, z % 146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}")
}

fn dashed(ymd: &str) -> String {
    format!("{}-{}-{}", &ymd[..4], &ymd[4..6], &ymd[6..])
}

/// The desktop's four text rules (`redactSecretsInText` in its logging folder; keep the two in step), then two
/// more: a URL loses its query and fragment, an email address becomes `<email>`.
static REDACTIONS: LazyLock<[(Regex, &str); 6]> = LazyLock::new(|| {
    let rule = |pattern: &str, replace| (Regex::new(pattern).unwrap(), replace);
    [
        rule(r"(?i)(Bearer\s+)[A-Za-z0-9._\-]{8,}", "${1}<redacted>"),
        rule(r"\bsk-[A-Za-z0-9_\-]{8,}", "sk-<redacted>"),
        rule(
            r#"(?i)(["']?\b\w*(?:token|secret|password|passphrase|credential|api[_-]?key)\w*\b["']?\s*[:=]\s*["']?)([^\s"',}]{6,})"#,
            "${1}<redacted>",
        ),
        rule(r"(?i)([?&][^=\s&]*(?:token|key|secret|sig|signature)[^=\s&]*=)[^\s&]+", "${1}<redacted>"),
        rule(r#"(?i)(\b[a-z][a-z0-9+.\-]*://[^\s?#"'<>]*)[?#][^\s"'<>]*"#, "${1}"),
        rule(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", "<email>"),
    ]
});

/// The home folder holds the person's name (`/Users/<name>`), and the install script prints paths under it.
static HOME: LazyLock<Option<Regex>> = LazyLock::new(|| home_rule(&std::env::var("HOME").unwrap_or_default()));

/// `home` as a whole path segment, so `/Users/a` leaves `/Users/ab` alone; none for a home of `/` or nothing.
fn home_rule(home: &str) -> Option<Regex> {
    let home = home.trim_end_matches('/');
    (!home.is_empty()).then(|| Regex::new(&format!(r#"{}([/\s"'),:;]|$)"#, regex::escape(home))).unwrap())
}

/// `text` with anything that could be a secret or a person's address blanked.
pub fn redact(text: &str) -> String {
    redact_with(text, HOME.as_ref())
}

fn redact_with(text: &str, home: Option<&Regex>) -> String {
    let text = REDACTIONS
        .iter()
        .fold(text.to_string(), |text, (pattern, replace)| pattern.replace_all(&text, *replace).into_owned());
    match home {
        Some(home) => home.replace_all(&text, "~${1}").into_owned(),
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FixedClock, Log};
    use std::fs;
    use std::sync::Arc;

    /// 2026-11-13T23:59:59Z, the last second of a UTC day.
    const LAST_SECOND: u64 = 1794614399;

    fn clock(now: u64) -> Arc<FixedClock> {
        let clock = Arc::new(FixedClock::default());
        clock.set(now);
        clock
    }

    fn names(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        names
    }

    #[test]
    fn the_file_is_named_for_the_utc_day() {
        let dir = tempfile::tempdir().unwrap();
        let clock = clock(LAST_SECOND);
        let log = FileLog::new(dir.path().to_path_buf(), clock.clone());
        log.line("harness start --if-down: exit 0");
        assert_eq!(
            fs::read_to_string(dir.path().join("app-20261113.log")).unwrap(),
            "2026-11-13T23:59:59Z harness start --if-down: exit 0\n"
        );
        clock.set(LAST_SECOND + 1);
        log.line("next");
        assert_eq!(fs::read_to_string(dir.path().join("app-20261114.log")).unwrap(), "2026-11-14T00:00:00Z next\n");
    }

    #[test]
    fn nothing_secret_is_written() {
        let cases = [
            ("Bearer abcdefgh1234", "Bearer <redacted>"),
            ("key sk-ant-abcdefgh1234 failed", "key sk-<redacted> failed"),
            (r#"{"session_token": "abc123def"}"#, r#"{"session_token": "<redacted>"}"#),
            ("open https://id.example/cb?code=abc&state=def now", "open https://id.example/cb now"),
            ("open https://id.example/cb#token=abc", "open https://id.example/cb"),
            ("signed in as person@example.com", "signed in as <email>"),
            ("harness start --if-down: exit 0", "harness start --if-down: exit 0"),
        ];
        for (text, expected) in cases {
            assert_eq!(redact(text), expected, "{text}");
        }
        let dir = tempfile::tempdir().unwrap();
        FileLog::new(dir.path().to_path_buf(), clock(LAST_SECOND)).line("as person@example.com");
        assert_eq!(
            fs::read_to_string(dir.path().join("app-20261113.log")).unwrap(),
            "2026-11-13T23:59:59Z as <email>\n"
        );
    }

    #[test]
    fn the_home_folder_is_written_as_a_tilde() {
        let home = home_rule("/Users/person");
        let cases = [
            ("Installed to /Users/person/.local/bin/harness", "Installed to ~/.local/bin/harness"),
            ("cd /Users/person && ls /Users/person/a", "cd ~ && ls ~/a"),
            ("\"/Users/person\"", "\"~\""),
            ("Installed to /Users/person.", "Installed to ~."),
            ("[/Users/person] {/Users/person} </Users/person> /Users/person|wc", "[~] {~} <~> ~|wc"),
            ("/Users/person@host /Users/person=x", "~@host ~=x"),
            // Another person's folder: a name goes on with letters, digits, `_`, `-` and `.`.
            ("/Users/personal/x stays", "/Users/personal/x stays"),
            ("/Users/person.b /Users/person-b /Users/person_b /Users/person..b", "/Users/person.b /Users/person-b /Users/person_b /Users/person..b"),
        ];
        for (text, expected) in cases {
            assert_eq!(redact_with(text, home.as_ref()), expected, "{text}");
        }
        assert!(home_rule("/").is_none() && home_rule("").is_none());
    }

    #[test]
    fn old_logs_go_and_nothing_else_does() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["app-20261029.log", "app-20261030.log", "app-junk.log", "cli.txt"] {
            fs::write(dir.path().join(name), "").unwrap();
        }
        let _log = FileLog::new(dir.path().to_path_buf(), clock(LAST_SECOND));
        assert_eq!(KEEP_DAYS, 14);
        assert_eq!(names(dir.path()), ["app-20261030.log", "app-junk.log", "cli.txt"]);
    }

    #[test]
    fn a_new_day_prunes_too() {
        // The app runs for weeks between restarts, so pruning only at start would keep every day since.
        let dir = tempfile::tempdir().unwrap();
        let clock = clock(LAST_SECOND);
        let log = FileLog::new(dir.path().to_path_buf(), clock.clone());
        fs::write(dir.path().join("app-20261030.log"), "").unwrap();
        log.line("today");
        assert!(dir.path().join("app-20261030.log").exists());
        clock.set(LAST_SECOND + 1);
        log.line("tomorrow");
        assert_eq!(names(dir.path()), ["app-20261113.log", "app-20261114.log"]);
    }

    #[test]
    fn a_log_that_cannot_be_written_never_stops_the_app() {
        let root = tempfile::tempdir().unwrap();
        let not_a_folder = root.path().join("file");
        fs::write(&not_a_folder, "").unwrap();
        let log = FileLog::new(not_a_folder.clone(), clock(LAST_SECOND));
        log.line("lost");
        assert_eq!(fs::read_to_string(&not_a_folder).unwrap(), "");
    }

    #[test]
    fn a_missing_folder_is_made() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("Logs").join("ai.autonomous.harness.device");
        FileLog::new(dir.clone(), clock(LAST_SECOND)).line("first");
        assert_eq!(names(&dir), ["app-20261113.log"]);
    }
}
