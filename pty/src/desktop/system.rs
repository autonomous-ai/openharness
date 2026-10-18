//! What the launcher asks of Windows, behind one trait: the launch, install and uninstall steps are plain Rust over
//! files, and these are the calls around them. [Real] makes them (win.rs on Windows; on Unix the few that exist
//! there), and the unit tests use [Fake], so every step runs in `cargo test` on any OS.

use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::time::Duration;

pub trait System {
    /// Start `exe` from `dir` with `args`: its process id and creation time.
    fn start_app(&mut self, exe: &Path, dir: &Path, args: &[OsString]) -> io::Result<(u32, u64)>;
    /// Wait up to `wait` for `pid` to end. A timeout or inaccessible process is an error,
    /// never permission to start a replacement while the old app still holds its mutex.
    fn wait_for_exit(&mut self, pid: u32, wait: Duration) -> io::Result<()>;
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

/// A recording stand-in for the unit tests.
#[cfg(test)]
#[derive(Default)]
pub struct Fake {
    /// (exe, dir, args) of each start.
    pub started: Vec<(std::path::PathBuf, std::path::PathBuf, Vec<OsString>)>,
    pub fail_start: bool,
    pub waited: Vec<u32>,
    pub fail_wait: Option<io::ErrorKind>,
    pub said: Vec<String>,
    pub now: u64,
}

#[cfg(test)]
impl System for Fake {
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
