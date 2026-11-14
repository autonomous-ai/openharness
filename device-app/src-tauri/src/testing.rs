//! What the tests share: the fake CLI.

use crate::cli::{HarnessCli, find_cli};
use crate::types::MemoryLog;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// The fake `harness` script.
pub fn fake_harness() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fake-harness")
}

/// A fake CLI of one test's own: a temp folder with the script and, beside it, the `fake` folder the script reads when
/// FAKE_HARNESS is unset, so tests run side by side with no environment variable. The script is linked, not copied: a
/// file just written cannot be run while another test's thread forks with it open (ETXTBSY on Linux).
pub struct Fake {
    folder: tempfile::TempDir,
    log: Arc<MemoryLog>,
}

impl Fake {
    pub fn new() -> Fake {
        let folder = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(fake_harness(), folder.path().join("fake-harness")).unwrap();
        fs::create_dir(folder.path().join("fake")).unwrap();
        Fake { folder, log: Arc::default() }
    }

    pub fn program(&self) -> PathBuf {
        self.folder.path().join("fake-harness")
    }

    /// What a run with these arguments prints, a line each (`@err`, `@wait` and the rest: see the script).
    pub fn script(&self, args: &str, lines: &[&str]) {
        let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        fs::write(self.file(&args.replace(' ', "_")), text).unwrap();
    }

    pub fn touch(&self, name: &str) {
        fs::write(self.file(name), "").unwrap();
    }

    pub fn calls(&self) -> Vec<String> {
        self.lines("calls.log")
    }

    pub fn ends(&self) -> Vec<String> {
        self.lines("ends.log")
    }

    pub fn pids(&self) -> Vec<i32> {
        self.lines("pids.log").iter().map(|pid| pid.parse().unwrap()).collect()
    }

    /// The log `cli()` writes to.
    pub fn log(&self) -> Arc<MemoryLog> {
        self.log.clone()
    }

    /// The script as the override, with the test's own PATH, where the script's tools are.
    pub fn cli(&self) -> HarnessCli {
        let path_var = env::var_os("PATH");
        let invocation = find_cli(self.folder.path(), path_var.as_deref(), Some(&self.program())).unwrap();
        HarnessCli::new(invocation, self.log.clone())
    }

    fn file(&self, name: &str) -> PathBuf {
        self.folder.path().join("fake").join(name)
    }

    fn lines(&self, name: &str) -> Vec<String> {
        fs::read_to_string(self.file(name)).unwrap_or_default().lines().map(String::from).collect()
    }
}

/// Whether the process is there (a zombie still is).
pub fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 sends nothing; it only asks whether the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Asks until the process is gone, 5 s at most: how a test sees a kill without a fixed sleep.
pub fn wait_gone(pid: i32) -> bool {
    let end = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        if Instant::now() >= end {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
    true
}
