//! The app's one log, redacted.

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
