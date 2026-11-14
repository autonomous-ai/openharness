//! state.json in the app's data folder.

use crate::types::{Log, Saved};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Arc;

pub trait StateFile: Send + Sync {
    fn load(&self) -> Saved;
    fn save(&self, saved: &Saved) -> io::Result<()>;
}

/// `state.json` in `dir`.
pub struct JsonStateFile {
    dir: PathBuf,
    log: Arc<dyn Log>,
}

impl JsonStateFile {
    pub fn new(dir: PathBuf, log: Arc<dyn Log>) -> Self {
        JsonStateFile { dir, log }
    }

}

impl StateFile for JsonStateFile {
    fn load(&self) -> Saved {
        let text = match fs::read_to_string(self.dir.join("state.json")) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Saved::default(),
            text => text.ok(),
        };
        let saved = text.and_then(|text| serde_json::from_str::<Saved>(&text).ok());
        // A file from a newer app means what this one cannot know: start over rather than guess. Only a missing file is
        // a first run, though: the CLI counts as seen, so one the person removed is not installed again.
        saved.filter(|saved| saved.version == 1).unwrap_or_else(|| {
            // No reason in the line: a parse error quotes the file, and the file is the person's.
            self.log.line("state: unreadable, starting from defaults");
            Saved { cli_seen: true, ..Saved::default() }
        })
    }

    /// Written whole or not at all: a crash mid-write leaves the old file, never half of one.
    fn save(&self, saved: &Saved) -> io::Result<()> {
        let mut folder = fs::DirBuilder::new();
        folder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut folder, 0o700);
        folder.create(&self.dir)?;

        let temp = self.dir.join("state.json.tmp");
        // A temp file a dead save left keeps its own mode if opened again, so it goes first.
        match fs::remove_file(&temp) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let written = options.open(&temp).and_then(|mut file| {
            file.write_all(&serde_json::to_vec(saved)?)?;
            file.sync_all()
        });
        let renamed = written.and_then(|()| fs::rename(&temp, self.dir.join("state.json")));
        if renamed.is_err() {
            let _ = fs::remove_file(&temp);
        }
        renamed
    }
}

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
    fn an_unknown_or_unreadable_file_gives_defaults_with_the_cli_seen_and_one_log_line() {
        // A file there is no first run: a CLI the person removed is never installed again on their behalf.
        let seen = Saved { cli_seen: true, ..Saved::default() };
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
            assert_eq!(file.load(), seen, "{content}");
            assert_eq!(log.lines(), ["state: unreadable, starting from defaults"], "{content}");
        }
        // A folder where the file should be cannot be read either.
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("state.json")).unwrap();
        let log = Arc::new(MemoryLog::default());
        let file = JsonStateFile::new(dir.path().to_path_buf(), log.clone());
        assert_eq!(file.load(), seen);
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
