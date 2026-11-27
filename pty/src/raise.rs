//! `raise` and `open-link` (cli.rs): how a tap on the dial brings an app forward on Windows
//! (cli/src/cable/hosts/windowsRaise.ts calls them).
//!
//! Only Windows' documented calls: a process without foreground rights is refused, and Windows
//! flashes the window's taskbar button instead (spec, Decided 4). Nothing works around that.

use std::time::Duration;

/// What `pick` reads of a top-level window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Candidate {
    pub visible: bool,
    /// Owned by another window, as a dialog is.
    pub owned: bool,
    /// A tool window, which has no taskbar button.
    pub tool: bool,
    /// Of the dialog class (`#32770`), as a message or task dialog is, even an unowned one.
    pub dialog: bool,
}

/// The window a raise brings forward, from the target's top-level windows in Z order: the first
/// that is the app's own window as a person sees it, a dialog only when the app shows nothing
/// else. The first in Z order is the one used last.
pub fn pick(in_z_order: &[Candidate]) -> Option<usize> {
    let shown = |window: &Candidate| window.visible && !window.owned && !window.tool;
    in_z_order
        .iter()
        .position(|window| shown(window) && !window.dialog)
        .or_else(|| in_z_order.iter().position(shown))
}

/// How long a raise waits for its window to come to the front: Windows may move the foreground
/// after SetForegroundWindow returns, and an answer read at once would call a raise refused.
pub const SETTLE: Duration = Duration::from_millis(250);

/// Whether [in_front] holds within [limit]. It is asked at once, then again after each [wait],
/// which waits for a change at most the time left and says how long it waited.
pub fn settles(
    limit: Duration,
    mut in_front: impl FnMut() -> bool,
    mut wait: impl FnMut(Duration) -> Duration,
) -> bool {
    let mut left = limit;
    loop {
        if in_front() {
            return true;
        }
        if left.is_zero() {
            return false;
        }
        left = left.saturating_sub(wait(left));
    }
}

/// The scheme of a link, as Windows names its handler: `codex` for `codex://…`.
pub fn scheme(url: &str) -> &str {
    url.split_once(':').map_or(url, |(scheme, _)| scheme)
}

#[cfg(windows)]
pub use windows::{open_link, raise};

#[cfg(windows)]
mod windows {
    use std::collections::HashSet;
    use std::ffi::OsStr;
    use std::ptr::{null, null_mut};
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
    use windows_sys::Win32::UI::Shell::{
        ASSOCF_IS_PROTOCOL, ASSOCSTR_PROGID, AssocQueryStringW, SEE_MASK_FLAG_NO_UI,
        SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, ShellExecuteExW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, EVENT_SYSTEM_FOREGROUND, EnumWindows, GW_OWNER, GWL_EXSTYLE,
        GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongW, GetWindowThreadProcessId,
        IsIconic, IsWindowVisible, MSG, MsgWaitForMultipleObjects, PM_REMOVE, PeekMessageW,
        QS_ALLINPUT, SW_RESTORE, SW_SHOWNORMAL, SetForegroundWindow, ShowWindowAsync,
        WINEVENT_OUTOFCONTEXT, WS_EX_TOOLWINDOW,
    };

    use super::{Candidate, SETTLE, pick, scheme, settles};
    use crate::cli::RaiseTarget;
    use crate::desktop::win::{Apartment, wide};

    /// `raised` when the target's window is now in front; `refused` when Windows kept the
    /// foreground elsewhere (the taskbar flash); `none` when the target has no window to raise.
    pub fn raise(target: &RaiseTarget) -> &'static str {
        let windows = windows_of(target);
        let candidates: Vec<Candidate> = windows.iter().map(|&window| candidate(window)).collect();
        let Some(picked) = pick(&candidates) else {
            return "none";
        };
        let window = windows[picked];
        unsafe {
            if IsIconic(window) != 0 {
                // Posted: a hung window would hold a sent restore for seconds.
                ShowWindowAsync(window, SW_RESTORE);
            }
            // Out of context, the hook's events come through this thread's queue and wake the wait.
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                null_mut(),
                Some(foreground_moved),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            SetForegroundWindow(window);
            // Without the hook the wait runs its whole time, and the foreground is read after it.
            let raised = settles(SETTLE, || GetForegroundWindow() == window, wait_for_events);
            if !hook.is_null() {
                UnhookWinEvent(hook);
            }
            if raised { "raised" } else { "refused" }
        }
    }

    /// The wait reads the foreground itself after each event.
    unsafe extern "system" fn foreground_moved(
        _hook: HWINEVENTHOOK,
        _event: u32,
        _window: HWND,
        _object: i32,
        _child: i32,
        _thread: u32,
        _time: u32,
    ) {
    }

    /// Waits up to [left] for anything in this thread's queue, delivers it, and says how long it
    /// waited.
    fn wait_for_events(left: Duration) -> Duration {
        let start = Instant::now();
        let millis = u32::try_from(left.as_millis()).unwrap_or(u32::MAX);
        unsafe {
            MsgWaitForMultipleObjects(0, null(), 0, millis, QS_ALLINPUT);
            let mut message: MSG = std::mem::zeroed();
            while PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) != 0 {
                DispatchMessageW(&message);
            }
        }
        start.elapsed()
    }

    /// The target's top-level windows in EnumWindows' order, which is the Z order, topmost first.
    fn windows_of(target: &RaiseTarget) -> Vec<HWND> {
        let mut all: Vec<HWND> = Vec::new();
        // A failed enumeration leaves what it listed: at worst `none`.
        unsafe { EnumWindows(Some(collect), &mut all as *mut Vec<HWND> as LPARAM) };
        let pids: HashSet<u32> = match target {
            RaiseTarget::Pid(pid) => HashSet::from([*pid]),
            // Each program's name from the one process list `ps` reads; a failed list is `none`.
            RaiseTarget::Exe(name) => {
                // Without case, as Windows compares file names.
                let name = name.to_lowercase();
                crate::ps::listed_processes()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|(_, _, program)| program.to_lowercase() == name)
                    .map(|(pid, ..)| pid)
                    .collect()
            }
        };
        all.into_iter()
            .filter(|&window| {
                let mut pid = 0;
                unsafe { GetWindowThreadProcessId(window, &mut pid) };
                pids.contains(&pid)
            })
            .collect()
    }

    unsafe extern "system" fn collect(window: HWND, all: LPARAM) -> BOOL {
        unsafe { (*(all as *mut Vec<HWND>)).push(window) };
        1
    }

    fn candidate(window: HWND) -> Candidate {
        // Room for a character more than `#32770`, so a longer name, cut to fit, never reads as it.
        let mut class = [0u16; 8];
        unsafe {
            let length = GetClassNameW(window, class.as_mut_ptr(), class.len() as i32).max(0);
            Candidate {
                visible: IsWindowVisible(window) != 0,
                owned: !GetWindow(window, GW_OWNER).is_null(),
                tool: GetWindowLongW(window, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0,
                dialog: String::from_utf16_lossy(&class[..length as usize]) == "#32770",
            }
        }
    }

    /// Whether a program is registered for links of [scheme]. ShellExecuteExW, even with the
    /// no-UI flag, answers a scheme with none by opening "pick an app" and reporting success. The
    /// ProgID is asked because a packaged handler (a Store app's) has one but no command or
    /// executable to read. With no buffer, a registered one answers S_FALSE and its length.
    fn handled(scheme: &str) -> bool {
        let scheme = wide(OsStr::new(scheme));
        let mut len = 0u32;
        let result = unsafe {
            AssocQueryStringW(
                ASSOCF_IS_PROTOCOL,
                ASSOCSTR_PROGID,
                scheme.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                &mut len,
            )
        };
        result >= 0
    }

    /// `opened` when the link's handler took it; `refused` otherwise, a scheme with no handler
    /// among them. The no-UI flag keeps Windows' error boxes away.
    pub fn open_link(url: &str) -> &'static str {
        // A handler may be a shell extension, which needs COM on the calling thread
        // (ShellExecuteExW's documentation). Without it, a handler that is a program still opens.
        let _apartment = Apartment::enter().ok();
        if !handled(scheme(url)) {
            return "refused";
        }
        let (verb, file) = (wide(OsStr::new("open")), wide(OsStr::new(url)));
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
        // NOASYNC: this process exits as soon as it answers, which would cut short a hand-off
        // still under way.
        info.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.nShow = SW_SHOWNORMAL;
        if unsafe { ShellExecuteExW(&mut info) } != 0 {
            "opened"
        } else {
            "refused"
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const SHOWN: Candidate = Candidate {
        visible: true,
        owned: false,
        tool: false,
        dialog: false,
    };
    const HIDDEN: Candidate = Candidate {
        visible: false,
        ..SHOWN
    };
    const OWNED: Candidate = Candidate {
        owned: true,
        ..SHOWN
    };
    const TOOL: Candidate = Candidate {
        tool: true,
        ..SHOWN
    };
    const DIALOG: Candidate = Candidate {
        dialog: true,
        ..SHOWN
    };

    /// This file's code without its tests, which name the calls they look for.
    fn code() -> &'static str {
        before_tests(include_str!("raise.rs"))
    }

    fn before_tests(source: &str) -> &str {
        // The attribute alone: what follows it on the next line depends on the checkout's line ends.
        source.split_once("#[cfg(test)]").unwrap().0
    }

    /// A Windows checkout (Git's autocrlf, as on GitHub's Windows runners) ends lines with CRLF.
    #[test]
    fn the_code_is_found_in_a_crlf_checkout() {
        let crlf = include_str!("raise.rs").replace('\n', "\r\n");
        assert_eq!(before_tests(&crlf), code().replace('\n', "\r\n"));
    }

    #[test]
    fn pick_skips_hidden_owned_and_tool_windows_and_takes_the_first_left() {
        assert_eq!(pick(&[HIDDEN, OWNED, TOOL, SHOWN, SHOWN]), Some(3));
        assert_eq!(pick(&[SHOWN, HIDDEN]), Some(0));
    }

    /// Cursor left an unowned "not responding" dialog of its own (the VM's notes, Task 37 section 1):
    /// above its main window, a raise would bring the dialog forward instead.
    #[test]
    fn pick_takes_the_main_window_before_a_dialog_above_it() {
        assert_eq!(pick(&[DIALOG, SHOWN]), Some(1));
        assert_eq!(pick(&[HIDDEN, DIALOG]), Some(1));
    }

    #[test]
    fn pick_finds_none_when_no_window_qualifies() {
        assert_eq!(pick(&[HIDDEN, OWNED, TOOL]), None);
        assert_eq!(pick(&[]), None);
    }

    /// Windows' foreground rules are kept: no input injected, no thread input joined, no lock
    /// timeout changed, no rights handed out (spec, Decided 4).
    #[test]
    fn the_window_code_uses_only_the_documented_calls() {
        for call in [
            "AttachThreadInput",
            "SendInput",
            "keybd_event",
            "SystemParametersInfo",
            "AllowSetForegroundWindow",
        ] {
            assert!(!code().contains(call), "{call}");
        }
    }

    fn ms(millis: u64) -> Duration {
        Duration::from_millis(millis)
    }

    /// Windows may move the foreground after SetForegroundWindow returns: the answer is read again
    /// after each change, within the time left.
    #[test]
    fn a_raise_waits_for_the_foreground_to_settle() {
        let mut asked = 0;
        let mut waited = Vec::new();
        let in_front = || {
            asked += 1;
            asked == 3
        };
        let wait = |left| {
            waited.push(left);
            ms(10)
        };
        assert!(settles(ms(250), in_front, wait));
        assert_eq!(waited, [ms(250), ms(240)]);
    }

    #[test]
    fn a_foreground_kept_elsewhere_is_known_when_the_time_is_up() {
        let mut waited = Duration::ZERO;
        let wait = |left: Duration| {
            let step = left.min(ms(100));
            waited += step;
            step
        };
        assert!(!settles(ms(250), || false, wait));
        assert_eq!(waited, ms(250));
    }

    #[test]
    fn a_window_already_in_front_is_answered_at_once() {
        assert!(settles(ms(250), || true, |_| panic!("waited")));
    }

    /// A hung window answers no message, and ShowWindow on another process's window waits for the
    /// answer: the restore is posted.
    #[test]
    fn a_hung_window_cannot_hold_the_raise() {
        assert!(!code().contains("ShowWindow("));
        assert!(code().contains("ShowWindowAsync("));
    }

    /// A link the shell takes but cannot open shows no error box.
    #[test]
    fn the_link_code_asks_for_no_ui() {
        assert!(code().contains("SEE_MASK_FLAG_NO_UI"));
    }

    /// The no-UI flag does not stop Windows' "pick an app" window for a scheme with no handler
    /// (the VM's notes, Task 37 section 3), so the handler is asked for first, by its ProgID: the
    /// one answer a packaged handler (the ChatGPT app's `codex`) gives as a classic one does.
    #[test]
    fn the_link_code_asks_for_a_handler_before_opening() {
        let code = code();
        let asked = code.find("AssocQueryStringW(").expect("AssocQueryStringW");
        let opened = code.find("ShellExecuteExW(").expect("ShellExecuteExW");
        assert!(asked < opened);
        assert!(code.contains("ASSOCSTR_PROGID"));
        assert!(!code.contains("ASSOCSTR_COMMAND"));
        assert!(!code.contains("ASSOCSTR_EXECUTABLE"));
    }

    #[test]
    fn a_links_scheme_is_its_name_before_the_colon() {
        assert_eq!(scheme("codex://harness-test"), "codex");
        assert_eq!(
            scheme("vscode://anthropic.claude-code/open?session=a:b"),
            "vscode"
        );
    }
}
