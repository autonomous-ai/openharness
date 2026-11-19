//! Linux: one command in a terminal the person sees, its exit code read back from a file beside it. In a terminal so
//! `sudo` in the command can ask for the person's password; the app never sees it.

use crate::open;
use crate::types::Output;
use std::fs::{self, DirBuilder, Permissions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

/// Desktop's order (`_defaultOpenTerminal`): the terminal Debian and Ubuntu name as the default, then the two most
/// common. Each takes the script's path after its flag.
pub const CANDIDATES: [(&str, &str); 3] = [("x-terminal-emulator", "-e"), ("gnome-terminal", "--"), ("xterm", "-e")];
/// None of CANDIDATES is on this computer.
pub const NO_TERMINAL: &str = "No terminal found.";
/// How often the result is read. Desktop reads it every 5 s; here the Install screen waits on it.
const READ_EVERY: Duration = Duration::from_secs(1);

/// Before the line: the result is written whole (a temp file, then a rename), so a read never sees half of it. A
/// closed terminal (HUP), a Ctrl-C (INT) or a kill (TERM) writes 129 at once, so the app does not wait out its
/// deadline.
const SCRIPT_HEAD: &str = r#"#!/bin/sh
# Harness: setup's host half, in a terminal so sudo can ask for a password.
result="$(dirname "$0")/host.exit"
finish() { printf '%s\n' "$1" > "$result.tmp" && mv "$result.tmp" "$result"; }
trap 'finish 129; exit 129' HUP INT TERM
"#;
/// After the line: a failure keeps the terminal open until Enter, so the person can read why.
const SCRIPT_TAIL: &str = r#"status=$?
finish "$status"
if [ "$status" -ne 0 ]; then
  printf '\nSetup failed. Press Enter to close. '
  read -r _
fi
exit "$status"
"#;

/// The script the terminal runs: `line`, its exit code then written to `host.exit` beside the script.
pub fn script(line: &str) -> String {
    format!("{SCRIPT_HEAD}{line}\n{SCRIPT_TAIL}")
}

/// The code in `result`, read at once, then every READ_EVERY until `deadline` has passed on `now`'s clock; None then.
/// A file missing, unreadable or not a whole number is still pending, as Desktop reads it.
pub fn wait_result(
    result: &Path,
    deadline: Duration,
    now: &dyn Fn() -> Instant,
    pause: &dyn Fn(Duration),
) -> Option<i32> {
    let end = now() + deadline;
    loop {
        if let Some(code) = fs::read_to_string(result).ok().and_then(|text| text.trim().parse().ok()) {
            return Some(code);
        }
        let left = end.saturating_duration_since(now());
        if left.is_zero() {
            return None;
        }
        pause(left.min(READ_EVERY));
    }
}

/// Writes `script(line)` to `host.sh` in `folder`, both the person's alone (0700), and has `start` open it in the first
/// of CANDIDATES that is there: one that is not (NotFound) moves on, any other error is the answer. Then waits up to
/// `deadline` for its code. Output holds no stdout or stderr: what the line prints is the person's, in the terminal.
pub fn run(
    folder: &Path,
    line: &str,
    deadline: Duration,
    start: &dyn Fn(&str, &str, &Path) -> io::Result<()>,
) -> io::Result<Output> {
    DirBuilder::new().recursive(true).mode(0o700).create(folder)?;
    // An existing folder or script keeps its mode: one left open to others since is closed again.
    fs::set_permissions(folder, Permissions::from_mode(0o700))?;
    let script_path = folder.join("host.sh");
    fs::write(&script_path, script(line))?;
    fs::set_permissions(&script_path, Permissions::from_mode(0o700))?;
    // An earlier run's code would read as this run's.
    let result = folder.join("host.exit");
    if let Err(error) = fs::remove_file(&result)
        && error.kind() != io::ErrorKind::NotFound
    {
        return Err(error);
    }
    CANDIDATES
        .iter()
        .map(|(program, flag)| start(program, flag, &script_path))
        .find(|started| !matches!(started, Err(error) if error.kind() == io::ErrorKind::NotFound))
        .unwrap_or_else(|| Err(io::Error::new(io::ErrorKind::NotFound, NO_TERMINAL)))?;
    let code = wait_result(&result, deadline, &Instant::now, &thread::sleep);
    Ok(Output { code, timed_out: code.is_none(), ..Output::default() })
}

/// Starts `program flag script` as the app opens a page (`open::start`): in its own process group, so a signal to the
/// app's group (a Ctrl-C where the app was started from a shell) does not close the person's terminal, and in the
/// person's environment, not the AppImage's. How it ends says nothing: gnome-terminal's ends at once and leaves the
/// window to its server, so the run's end is read from `host.exit` alone.
pub fn start(program: &str, flag: &str, script: &Path) -> io::Result<()> {
    open::start(Command::new(program).arg(flag).arg(script), None)
}

#[cfg(test)]
mod tests {
    use super::{CANDIDATES, NO_TERMINAL, run, script, start, wait_result};
    use crate::cli::spawn_lock;
    use crate::install::HOST;
    use crate::types::Output;
    use std::cell::{Cell, RefCell};
    use std::fs;
    use std::io::{self, BufRead, BufReader};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    const WAIT: Duration = Duration::from_secs(5);

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// `host.sh` holding `script(line)`, in a folder of its own.
    fn written(line: &str) -> (tempfile::TempDir, PathBuf) {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("host.sh");
        fs::write(&path, script(line)).unwrap();
        (folder, path)
    }

    #[test]
    fn the_script_writes_its_lines_exit_code() {
        for (line, code) in [("(exit 3)", 3), ("true", 0)] {
            let (folder, path) = written(line);
            // stdin at /dev/null: the failed run's Enter is read at once.
            let mut child = {
                let _spawning = spawn_lock();
                Command::new("/bin/sh").arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).spawn().unwrap()
            };
            assert_eq!(child.wait().unwrap().code(), Some(code));
            assert_eq!(fs::read_to_string(folder.path().join("host.exit")).unwrap(), format!("{code}\n"));
            assert!(!folder.path().join("host.exit.tmp").exists());
        }
        assert!(script(HOST).lines().any(|line| line == HOST));
    }

    #[test]
    fn a_hangup_writes_129() {
        // The line's own child says `ready`: the trap is set and the child is there to be hung up too. A hangup before
        // the shell starts its child would wait for that child's end, as a terminal's line would.
        let (folder, path) = written("/bin/sh -c 'echo ready; exec sleep 30'");
        let mut child = {
            let _spawning = spawn_lock();
            Command::new("/bin/sh")
                .arg(&path)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .unwrap()
        };
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready).unwrap();
        assert_eq!(ready, "ready\n");
        // SAFETY: kill only sends a signal, to the group of a child this test has not reaped.
        unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGHUP) };
        let (send, ended) = mpsc::channel();
        thread::spawn(move || send.send(child.wait().unwrap().code()));
        assert_eq!(ended.recv_timeout(WAIT), Ok(Some(129)));
        assert_eq!(fs::read_to_string(folder.path().join("host.exit")).unwrap(), "129\n");
    }

    #[test]
    fn the_first_terminal_found_is_used_in_desktops_order() {
        assert_eq!(CANDIDATES, [("x-terminal-emulator", "-e"), ("gnome-terminal", "--"), ("xterm", "-e")]);
        let data = tempfile::tempdir().unwrap();
        let folder = data.path().join("setup");
        let script_path = folder.join("host.sh");
        let tried = RefCell::new(Vec::new());
        let output = run(&folder, HOST, WAIT, &|program, flag, script| {
            tried.borrow_mut().push((program.to_string(), flag.to_string(), script.to_path_buf()));
            if program == "x-terminal-emulator" {
                return Err(io::ErrorKind::NotFound.into());
            }
            fs::write(script.with_file_name("host.exit"), "0\n")
        })
        .unwrap();
        assert_eq!(output, Output { code: Some(0), ..Output::default() });
        assert_eq!(
            tried.into_inner(),
            [
                ("x-terminal-emulator".to_string(), "-e".to_string(), script_path.clone()),
                ("gnome-terminal".to_string(), "--".to_string(), script_path),
            ]
        );

        // A terminal that is there but will not start is the one used: its error, not the next terminal.
        let tried = Cell::new(0);
        let error = run(&folder, HOST, WAIT, &|_, _, _| {
            tried.set(tried.get() + 1);
            Err(io::ErrorKind::PermissionDenied.into())
        })
        .unwrap_err();
        assert_eq!((tried.get(), error.kind()), (1, io::ErrorKind::PermissionDenied));
    }

    #[test]
    fn no_terminal_is_one_fixed_error() {
        assert_eq!(NO_TERMINAL, "No terminal found.");
        let folder = tempfile::tempdir().unwrap();
        let tried = Cell::new(0);
        let error = run(folder.path(), HOST, WAIT, &|_, _, _| {
            tried.set(tried.get() + 1);
            Err(io::ErrorKind::NotFound.into())
        })
        .unwrap_err();
        assert_eq!(tried.get(), CANDIDATES.len());
        assert_eq!((error.kind(), error.to_string()), (io::ErrorKind::NotFound, NO_TERMINAL.to_string()));
        // A program that is not there is NotFound when started, so the next one is tried.
        let missing = start("harness-no-such-terminal", "-e", &folder.path().join("host.sh")).unwrap_err();
        assert_eq!(missing.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn an_old_result_is_removed_first() {
        let folder = tempfile::tempdir().unwrap();
        let result = folder.path().join("host.exit");
        fs::write(&result, "0\n").unwrap();
        let there_at_start = Cell::new(true);
        let output = run(folder.path(), HOST, Duration::ZERO, &|_, _, script| {
            there_at_start.set(script.with_file_name("host.exit").exists());
            Ok(())
        })
        .unwrap();
        assert!(!there_at_start.get());
        assert!(output.timed_out);
    }

    #[test]
    fn a_result_is_waited_for_and_a_half_written_one_is_still_pending() {
        let folder = tempfile::tempdir().unwrap();
        let result = folder.path().join("host.exit");
        let clock = Cell::new(Instant::now());
        let pauses = RefCell::new(Vec::new());
        // Missing at first; then made with nothing in it yet; then a word, not a number; then the code.
        let next = RefCell::new(["", "ok\n", "12\n"].into_iter());
        let code = wait_result(&result, Duration::from_secs(600), &|| clock.get(), &|pause| {
            pauses.borrow_mut().push(pause);
            clock.set(clock.get() + pause);
            fs::write(&result, next.borrow_mut().next().unwrap()).unwrap();
        });
        assert_eq!(code, Some(12));
        assert_eq!(pauses.into_inner(), [Duration::from_secs(1); 3]);
    }

    #[test]
    fn no_result_by_the_deadline_is_a_timeout() {
        let folder = tempfile::tempdir().unwrap();
        let result = folder.path().join("host.exit");
        let clock = Cell::new(Instant::now());
        let pauses = RefCell::new(Vec::new());
        let code = wait_result(&result, Duration::from_millis(2500), &|| clock.get(), &|pause| {
            pauses.borrow_mut().push(pause);
            clock.set(clock.get() + pause);
        });
        assert_eq!(code, None);
        assert_eq!(pauses.into_inner(), [Duration::from_secs(1), Duration::from_secs(1), Duration::from_millis(500)]);

        let output = run(folder.path(), HOST, Duration::ZERO, &|_, _, _| Ok(())).unwrap();
        assert_eq!(output, Output { timed_out: true, ..Output::default() });
    }

    #[test]
    fn the_folder_and_the_script_are_the_persons_alone() {
        let data = tempfile::tempdir().unwrap();
        let folder = data.path().join("setup");
        let script_path = folder.join("host.sh");
        run(&folder, HOST, Duration::ZERO, &|_, _, _| Ok(())).unwrap();
        assert_eq!((mode(&folder), mode(&script_path)), (0o700, 0o700));
        assert_eq!(fs::read_to_string(&script_path).unwrap(), script(HOST));

        // Left open to others since: the person's alone again.
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&script_path, fs::Permissions::from_mode(0o644)).unwrap();
        run(&folder, HOST, Duration::ZERO, &|_, _, _| Ok(())).unwrap();
        assert_eq!((mode(&folder), mode(&script_path)), (0o700, 0o700));
    }
}
