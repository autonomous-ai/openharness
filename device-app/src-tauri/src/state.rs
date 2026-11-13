//! state.json in the app's data folder.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{MemoryLog, Saved};
    use std::fs;
    use std::sync::Arc;

    fn names(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        names
    }

    #[test]
    fn a_save_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = JsonStateFile::new(dir.path().to_path_buf(), Arc::new(MemoryLog::default()));
        let saved = Saved { cli_seen: true, asked_claude: true, ..Saved::default() };
        file.save(&saved).unwrap();
        assert_eq!(file.load(), saved);
        assert_eq!(names(dir.path()), ["state.json"]);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private_and_whole() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        // A temp file left by a save that died, readable by anyone: the next save must not inherit its mode.
        let stale = dir.path().join("state.json.tmp");
        fs::write(&stale, "{").unwrap();
        fs::set_permissions(&stale, fs::Permissions::from_mode(0o644)).unwrap();
        let file = JsonStateFile::new(dir.path().to_path_buf(), Arc::new(MemoryLog::default()));
        file.save(&Saved { cli_seen: true, ..Saved::default() }).unwrap();
        let mode = fs::metadata(dir.path().join("state.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(names(dir.path()), ["state.json"]);
    }

    #[test]
    fn a_missing_file_is_a_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let log = Arc::new(MemoryLog::default());
        let file = JsonStateFile::new(dir.path().to_path_buf(), log.clone());
        assert_eq!(file.load(), Saved::default());
        assert!(log.lines().is_empty());
    }

    #[test]
    fn an_unknown_or_unreadable_file_gives_defaults_and_one_log_line() {
        let contents = [
            "not json",
            "[]",
            r#"{"version":2,"cliSeen":true}"#,
            r#"{"version":2,"cliSeen":true,"askedSignIn":true,"askedClaude":true,"loginItem":true}"#,
            r#"{"version":1,"cliSeen":"yes"}"#,
        ];
        for content in contents {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join("state.json"), content).unwrap();
            let log = Arc::new(MemoryLog::default());
            let file = JsonStateFile::new(dir.path().to_path_buf(), log.clone());
            assert_eq!(file.load(), Saved::default(), "{content}");
            assert_eq!(log.lines(), ["state: unreadable, starting from defaults"], "{content}");
        }
        // A folder where the file should be cannot be read either.
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("state.json")).unwrap();
        let log = Arc::new(MemoryLog::default());
        let file = JsonStateFile::new(dir.path().to_path_buf(), log.clone());
        assert_eq!(file.load(), Saved::default());
        assert_eq!(log.lines(), ["state: unreadable, starting from defaults"]);
    }

    #[test]
    fn a_newer_key_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("state.json"),
            r#"{"version":1,"cliSeen":true,"askedSignIn":false,"askedClaude":false,"loginItem":false,"later":1}"#,
        )
        .unwrap();
        let log = Arc::new(MemoryLog::default());
        let file = JsonStateFile::new(dir.path().to_path_buf(), log.clone());
        assert_eq!(file.load(), Saved { cli_seen: true, ..Saved::default() });
        assert!(log.lines().is_empty());
    }

    #[test]
    fn a_save_makes_its_folder_and_says_when_it_cannot() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("Application Support").join("ai.autonomous.harness.device");
        let file = JsonStateFile::new(dir.clone(), Arc::new(MemoryLog::default()));
        file.save(&Saved::default()).unwrap();
        assert_eq!(file.load(), Saved::default());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }

        let not_a_folder = root.path().join("file");
        fs::write(&not_a_folder, "").unwrap();
        let file = JsonStateFile::new(not_a_folder, Arc::new(MemoryLog::default()));
        assert!(file.save(&Saved::default()).is_err());
    }
}
