//! `harness-pty raise` and `open-link` run as the daemon runs them: one word on stdout and exit 0
//! on Windows; elsewhere `{"unsupported":true}` and exit 3, as `ps` answers.
use std::process::{Command, Output};

const PTY: &str = env!("CARGO_BIN_EXE_harness-pty");

fn run(args: &[&str]) -> Output {
    Command::new(PTY).args(args).output().unwrap()
}

#[cfg(not(windows))]
#[test]
fn off_windows_both_answer_unsupported() {
    for args in [
        &["raise", "--pid", "1"][..],
        &["raise", "--exe", "Code.exe"],
        &["open-link", "vscode://x"],
    ] {
        let out = run(args);
        assert_eq!(out.status.code(), Some(3), "{args:?}");
        assert_eq!(out.stdout, b"{\"unsupported\":true}\n", "{args:?}");
    }
}

#[cfg(windows)]
mod windows {
    use super::run;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::ptr::{null, null_mut};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    use windows_sys::Win32::UI::Shell::{ASSOCF_IS_PROTOCOL, ASSOCSTR_PROGID, AssocQueryStringW};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, IsIconic, MSG, PostMessageW, SW_MINIMIZE,
        SW_SHOWNORMAL, ShowWindow, WM_CLOSE, WS_OVERLAPPEDWINDOW,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }

    /// The helper's answer, which must be one word on a line and exit 0.
    fn word(args: &[&str]) -> String {
        let out = run(args);
        assert_eq!(
            out.status.code(),
            Some(0),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let stdout = String::from_utf8(out.stdout).unwrap();
        stdout.strip_suffix('\n').unwrap_or(&stdout).to_string()
    }

    #[test]
    fn a_program_with_no_window_is_none() {
        assert_eq!(word(&["raise", "--exe", "no-such-program.exe"]), "none");
        let mut child = Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let answer = word(&["raise", "--pid", &child.id().to_string()]);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(answer, "none");
    }

    /// A top-level window of this test's own process, minimized, on a thread that pumps its
    /// messages as an app's UI thread does: a restore from another process arrives as messages.
    fn minimized_window() -> usize {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || unsafe {
            let (class, title) = (wide("STATIC"), wide("harness-pty raise test"));
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                300,
                200,
                null_mut(),
                null_mut(),
                null_mut(),
                null(),
            );
            assert!(!hwnd.is_null(), "{}", std::io::Error::last_os_error());
            // Shown first, then minimized: a process's first ShowWindow may take its start-up
            // flags instead of the one asked.
            ShowWindow(hwnd, SW_SHOWNORMAL);
            ShowWindow(hwnd, SW_MINIMIZE);
            tx.send(hwnd as usize).unwrap();
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                DispatchMessageW(&msg);
            }
        });
        rx.recv().unwrap()
    }

    #[test]
    fn a_minimized_window_is_raised_or_refused_and_no_longer_minimized() {
        let hwnd = minimized_window() as HWND;
        assert_ne!(unsafe { IsIconic(hwnd) }, 0, "the window did not minimize");
        let answer = word(&["raise", "--pid", &std::process::id().to_string()]);
        let end = Instant::now() + Duration::from_secs(5);
        while unsafe { IsIconic(hwnd) } != 0 && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
        }
        let restored = unsafe { IsIconic(hwnd) } == 0;
        unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) };
        // `refused` is Windows' own answer to a process without foreground rights: the taskbar
        // flash. The window is restored either way.
        assert!(answer == "raised" || answer == "refused", "{answer}");
        assert!(restored, "the window is still minimized");
    }

    /// Whether Windows knows a program for links of [scheme]: with no buffer, a registered one
    /// answers S_FALSE and its length, an unknown one an error. Asked by ProgID: the command and
    /// executable are missing for a packaged handler (the ChatGPT app's `codex`).
    fn handled(scheme: &str) -> bool {
        let scheme = wide(scheme);
        let mut len = 0u32;
        let result = unsafe {
            AssocQueryStringW(
                ASSOCF_IS_PROTOCOL,
                ASSOCSTR_PROGID,
                scheme.as_ptr(),
                null(),
                null_mut(),
                &mut len,
            )
        };
        result >= 0
    }

    /// The pids of Windows' "pick an app" program now running.
    fn pickers() -> Vec<u32> {
        harness_pty::ps::snapshot()
            .unwrap()
            .into_iter()
            .filter(|row| row.executable.eq_ignore_ascii_case("OpenWith.exe"))
            .map(|row| row.pid)
            .collect()
    }

    /// Seen only in a signed-in console session: there Windows answered such a link with "pick an
    /// app" (OpenWith.exe) and a success (the VM's notes, Task 37 section 3). A session with no
    /// desktop, as a CI runner's may be, shows no picker either way.
    #[test]
    fn a_link_with_no_handler_is_refused() {
        if handled("codex") {
            eprintln!("skipped: this machine has a codex link handler");
            return;
        }
        let before = pickers();
        let start = Instant::now();
        let answer = word(&["open-link", "codex://harness-test"]);
        let elapsed = start.elapsed();
        // The helper waits for the shell's hand-off (NOASYNC), so a picker it started runs now.
        let shown: Vec<u32> = pickers()
            .into_iter()
            .filter(|pid| !before.contains(pid))
            .collect();
        for pid in &shown {
            // A picker left open holds the next link for minutes.
            let _ = Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
        assert_eq!(answer, "refused");
        assert!(shown.is_empty(), "a pick-an-app window: {shown:?}");
        assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");
    }
}
