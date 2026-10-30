//! What the launcher asks of Windows, behind one trait: the launch, install and uninstall steps are plain Rust over
//! files, and these are the calls around them. [Real] makes them (win.rs on Windows; on Unix the few that exist
//! there), and the unit tests use [Fake], so every step runs in `cargo test` on any OS.

use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::time::Duration;

use super::registry::Key;
use super::rollback::Liveness;

pub trait System {
    /// Start `exe` from `dir` with `args`: its process id and creation time.
    fn start_app(&mut self, exe: &Path, dir: &Path, args: &[OsString]) -> io::Result<(u32, u64)>;
    /// Wait up to `wait` for `pid` to end. A timeout or inaccessible process is an error,
    /// never permission to start a replacement while the old app still holds its mutex.
    fn wait_for_exit(&mut self, pid: u32, wait: Duration) -> io::Result<()>;
    /// Observe a recorded process identity; inspection failures are Unknown.
    fn liveness(&mut self, pid: u32, created: u64) -> Liveness;
    /// Best-effort observation of this install's running app windows.
    fn app_processes(&mut self, root: &Path) -> Vec<u32>;
    /// Ask the apps from `root` (`<root>\app\*\harness-desktop.exe`) to quit (`WM_HARNESS_QUIT`), wait up to `wait`,
    /// then end any still there. Return their count only after confirmed exit; errors prevent replacement.
    fn quit_app(&mut self, root: &Path, wait: Duration) -> io::Result<usize>;
    /// A text value under `HKCU\<registry>\<key>`; `name` "" is the key's default value.
    fn read_value(&mut self, registry: &str, key: &str, name: &str) -> Option<OsString>;
    fn write_keys(&mut self, registry: &str, keys: &[Key]) -> io::Result<()>;
    /// Remove only this subtree under the selected HKCU root; missing is already removed.
    fn delete_key(&mut self, registry: &str, key: &str) -> io::Result<()>;
    /// Start an owned temporary batch file hidden, outside this job when permitted.
    fn start_script(&mut self, script: &Path) -> io::Result<()>;
    /// The caller has already validated and retained this physical install path.
    fn start_script_logged(&mut self, script: &Path, install: &Path) -> io::Result<()> {
        let _ = install;
        self.start_script(script)
    }
    fn pid(&mut self) -> u32;
    /// The Start Menu shortcut: `link` to `target`, started in `dir`, showing `icon`, with the AUMID.
    fn create_shortcut(
        &mut self,
        link: &Path,
        target: &Path,
        icon: &Path,
        dir: &Path,
    ) -> io::Result<()>;
    fn say(&mut self, text: &str);
    fn now_ms(&mut self) -> u64;
}

/// Set by the tests that run the real program: messages go to stderr instead of a message box.
pub const NO_DIALOG_ENV: &str = "HARNESS_DESKTOP_NO_DIALOG";

/// This computer's.
#[derive(Default)]
pub struct Real;

/// A message for the person: a message box on Windows (there is no console), stderr elsewhere.
pub fn say(text: &str) {
    Real.say(text)
}

impl System for Real {
    fn liveness(&mut self, pid: u32, created: u64) -> Liveness {
        #[cfg(windows)]
        {
            super::win::liveness(pid, created)
        }
        #[cfg(unix)]
        {
            let _ = (pid, created);
            Liveness::Unknown
        }
    }
    fn app_processes(&mut self, root: &Path) -> Vec<u32> {
        #[cfg(windows)]
        {
            super::win::app_processes(root)
        }
        #[cfg(unix)]
        {
            let _ = root;
            Vec::new()
        }
    }

    fn start_script_logged(&mut self, script: &Path, install: &Path) -> io::Result<()> {
        #[cfg(windows)]
        {
            super::win::start_script_with_warning(script, |warning| {
                super::uninstall::script_warning(install, &warning)
            })
        }
        #[cfg(unix)]
        {
            let _ = install;
            self.start_script(script)
        }
    }
    fn delete_key(&mut self, registry: &str, key: &str) -> io::Result<()> {
        #[cfg(windows)]
        {
            super::win::delete_key(registry, key)
        }
        #[cfg(unix)]
        {
            let _ = (registry, key);
            Err(unsupported())
        }
    }
    fn start_script(&mut self, script: &Path) -> io::Result<()> {
        #[cfg(windows)]
        {
            super::win::start_script(script)
        }
        #[cfg(unix)]
        {
            let _ = script;
            Err(unsupported())
        }
    }
    fn pid(&mut self) -> u32 {
        std::process::id()
    }
    fn start_app(&mut self, exe: &Path, dir: &Path, args: &[OsString]) -> io::Result<(u32, u64)> {
        #[cfg(windows)]
        {
            super::win::start_app(exe, dir, args)
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            use std::process::{Command, Stdio};
            Command::new(exe)
                .args(args)
                .current_dir(dir)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .map(|child| (child.id(), 0))
        }
    }

    fn wait_for_exit(&mut self, pid: u32, wait: Duration) -> io::Result<()> {
        #[cfg(windows)]
        {
            super::win::wait_for_exit(pid, wait)
        }
        #[cfg(unix)]
        {
            let pid = i32::try_from(pid)
                .ok()
                .filter(|&pid| pid > 0)
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "expected a positive process id",
                    )
                })?;
            let started = std::time::Instant::now();
            loop {
                if unsafe { libc::kill(pid, 0) } != 0 {
                    let error = io::Error::last_os_error();
                    return if error.raw_os_error() == Some(libc::ESRCH) {
                        Ok(())
                    } else {
                        Err(error)
                    };
                }
                let remaining = wait.saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "the previous Harness app is still running",
                    ));
                }
                std::thread::sleep(remaining.min(Duration::from_millis(50)));
            }
        }
    }

    fn quit_app(&mut self, root: &Path, wait: Duration) -> io::Result<usize> {
        #[cfg(windows)]
        {
            super::win::quit_app(root, wait)
        }
        #[cfg(unix)]
        {
            let _ = (root, wait);
            Ok(0)
        }
    }

    fn read_value(&mut self, registry: &str, key: &str, name: &str) -> Option<OsString> {
        #[cfg(windows)]
        {
            super::win::read_value(registry, key, name)
        }
        #[cfg(unix)]
        {
            let _ = (registry, key, name);
            None
        }
    }

    fn write_keys(&mut self, registry: &str, keys: &[Key]) -> io::Result<()> {
        #[cfg(windows)]
        {
            super::win::write_keys(registry, keys)
        }
        #[cfg(unix)]
        {
            let _ = (registry, keys);
            Err(unsupported())
        }
    }

    fn create_shortcut(
        &mut self,
        link: &Path,
        target: &Path,
        icon: &Path,
        dir: &Path,
    ) -> io::Result<()> {
        #[cfg(windows)]
        {
            super::shortcut::create(link, target, icon, dir, super::AUMID)
        }
        #[cfg(unix)]
        {
            let _ = (link, target, icon, dir);
            Err(unsupported())
        }
    }

    fn say(&mut self, text: &str) {
        // The tests run the real program, where a message box would wait for a click nobody makes.
        if cfg!(unix) || std::env::var_os(NO_DIALOG_ENV).is_some() {
            eprintln!("{text}");
            return;
        }
        #[cfg(windows)]
        super::win::message_box(text);
    }

    fn now_ms(&mut self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

#[cfg(unix)]
fn unsupported() -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, "only on Windows")
}

/// A recording stand-in for the unit tests.
#[cfg(test)]
#[derive(Default)]
pub struct Fake {
    pub script_roots: Vec<std::path::PathBuf>,
    pub deleted: Vec<(String, String)>,
    pub fail_delete: bool,
    pub scripts: Vec<(std::path::PathBuf, String)>,
    pub fail_script: bool,
    /// (exe, dir, args) of each start.
    pub started: Vec<(std::path::PathBuf, std::path::PathBuf, Vec<OsString>)>,
    pub fail_start: bool,
    pub waited: Vec<u32>,
    pub fail_wait: Option<io::ErrorKind>,
    pub liveness: Liveness,
    /// What app_processes observes and quit_app ends.
    pub running: Vec<u32>,
    pub quit: Vec<std::path::PathBuf>,
    /// (registry root, key, value name) -> value.
    pub values: std::collections::BTreeMap<(String, String, String), OsString>,
    pub numbers: std::collections::BTreeMap<(String, String, String), u32>,
    pub writes: usize,
    /// (link, target, icon, dir).
    pub shortcuts: Vec<(
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
    )>,
    pub fail_shortcut: bool,
    pub fail_write: bool,
    pub fail_quit: bool,
    pub reads: usize,
    pub said: Vec<String>,
    pub now: u64,
}

#[cfg(test)]
impl Default for Liveness {
    fn default() -> Self {
        Self::Unknown
    }
}

#[cfg(test)]
impl System for Fake {
    fn liveness(&mut self, _pid: u32, _created: u64) -> Liveness {
        self.liveness
    }
    fn app_processes(&mut self, _root: &Path) -> Vec<u32> {
        self.running.clone()
    }
    fn start_script_logged(&mut self, script: &Path, install: &Path) -> io::Result<()> {
        self.script_roots.push(install.to_owned());
        self.start_script(script)
    }
    fn delete_key(&mut self, registry: &str, key: &str) -> io::Result<()> {
        if self.fail_delete {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.deleted.push((registry.to_owned(), key.to_owned()));
        let under = |k: &(String, String, String)| {
            k.0 == registry && (k.1 == key || k.1.starts_with(&format!("{key}\\")))
        };
        self.values.retain(|k, _| !under(k));
        self.numbers.retain(|k, _| !under(k));
        Ok(())
    }
    fn start_script(&mut self, script: &Path) -> io::Result<()> {
        if self.fail_script {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.scripts
            .push((script.to_owned(), std::fs::read_to_string(script)?));
        Ok(())
    }
    fn pid(&mut self) -> u32 {
        4242
    }
    fn start_app(&mut self, exe: &Path, dir: &Path, args: &[OsString]) -> io::Result<(u32, u64)> {
        if self.fail_start {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        self.started
            .push((exe.to_path_buf(), dir.to_path_buf(), args.to_vec()));
        Ok((99 + self.started.len() as u32, self.started.len() as u64))
    }
    fn wait_for_exit(&mut self, pid: u32, _wait: Duration) -> io::Result<()> {
        self.waited.push(pid);
        self.fail_wait
            .map_or(Ok(()), |kind| Err(io::Error::from(kind)))
    }
    fn quit_app(&mut self, root: &Path, _wait: Duration) -> io::Result<usize> {
        self.quit.push(root.to_path_buf());
        if self.fail_quit {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(std::mem::take(&mut self.running).len())
    }
    fn read_value(&mut self, registry: &str, key: &str, name: &str) -> Option<OsString> {
        self.reads += 1;
        self.values
            .get(&(registry.to_owned(), key.to_owned(), name.to_owned()))
            .cloned()
    }
    fn write_keys(&mut self, registry: &str, keys: &[Key]) -> io::Result<()> {
        use super::registry::Value;
        self.writes += 1;
        if self.fail_write {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        for key in keys {
            for (name, value) in &key.values {
                let at = (registry.to_owned(), key.path.clone(), name.clone());
                match value {
                    Value::Text(text) => drop(self.values.insert(at, text.clone())),
                    Value::Number(number) => drop(self.numbers.insert(at, *number)),
                }
            }
        }
        Ok(())
    }
    fn create_shortcut(
        &mut self,
        link: &Path,
        target: &Path,
        icon: &Path,
        dir: &Path,
    ) -> io::Result<()> {
        if self.fail_shortcut {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        self.shortcuts.push((
            link.to_path_buf(),
            target.to_path_buf(),
            icon.to_path_buf(),
            dir.to_path_buf(),
        ));
        Ok(())
    }
    fn say(&mut self, text: &str) {
        self.said.push(text.to_owned());
    }
    fn now_ms(&mut self) -> u64 {
        self.now += 1_000;
        1_000_000 + self.now
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiting_for_a_live_process_times_out_without_ending_it() {
        let error = Real
            .wait_for_exit(std::process::id(), Duration::ZERO)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn zero_is_not_a_process_to_wait_for() {
        assert_eq!(
            Real.wait_for_exit(0, Duration::ZERO).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_windows_pid_does_not_wrap_into_a_unix_process_group() {
        for pid in [i32::MAX as u32 + 1, u32::MAX] {
            assert_eq!(
                Real.wait_for_exit(pid, Duration::ZERO).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn an_exited_and_reaped_process_needs_no_wait() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(child.wait().unwrap().success());
        drop(child);
        Real.wait_for_exit(pid, Duration::from_secs(1)).unwrap();
    }
}
