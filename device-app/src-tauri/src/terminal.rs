//! Linux: one command in a terminal the person sees, its exit code read back from a file beside it.

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
