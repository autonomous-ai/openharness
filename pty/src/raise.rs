//! `raise` and `open-link` (cli.rs): how a tap on the dial brings an app forward on Windows
//! (cli/src/cable/hosts/windowsRaise.ts calls them).
//!
//! Only Windows' documented calls: a process without foreground rights is refused, and Windows
//! flashes the window's taskbar button instead (spec, Decided 4). Nothing works around that.

/// What `pick` reads of a top-level window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Candidate {
    pub visible: bool,
    /// Owned by another window, as a dialog is.
    pub owned: bool,
    /// A tool window, which has no taskbar button.
    pub tool: bool,
}

/// The window a raise brings forward, from the target's top-level windows in Z order: the first
/// that is the app's own window as a person sees it. The first in Z order is the one used last.
pub fn pick(in_z_order: &[Candidate]) -> Option<usize> {
    in_z_order
        .iter()
        .position(|window| window.visible && !window.owned && !window.tool)
}

/// The scheme of a link, as Windows names its handler: `codex` for `codex://…`.
pub fn scheme(url: &str) -> &str {
    url.split_once(':').map_or(url, |(scheme, _)| scheme)
}

#[cfg(windows)]
pub use windows::{open_link, raise};

#[cfg(windows)]
mod windows {
    use std::collections::HashMap;
    use std::ffi::OsStr;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::{BOOL, HANDLE, HWND, LPARAM};
    use windows_sys::Win32::System::Com::{
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx,
    };
    use windows_sys::Win32::System::Threading::{PROCESS_NAME_WIN32, QueryFullProcessImageNameW};
    use windows_sys::Win32::UI::Shell::{
        ASSOCF_IS_PROTOCOL, ASSOCSTR_PROGID, AssocQueryStringW, SEE_MASK_FLAG_NO_UI,
        SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, ShellExecuteExW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GWL_EXSTYLE, GetForegroundWindow, GetWindow, GetWindowLongW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SW_RESTORE, SW_SHOWNORMAL,
        SetForegroundWindow, ShowWindow, WS_EX_TOOLWINDOW,
    };

    use super::{Candidate, pick, scheme};
    use crate::cli::RaiseTarget;
    use crate::desktop::win::wide;

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
                ShowWindow(window, SW_RESTORE);
            }
            SetForegroundWindow(window);
            if GetForegroundWindow() == window {
                "raised"
            } else {
                "refused"
            }
        }
    }

    /// The target's top-level windows in EnumWindows' order, which is the Z order, topmost first.
    fn windows_of(target: &RaiseTarget) -> Vec<HWND> {
        let mut all: Vec<HWND> = Vec::new();
        // A failed enumeration leaves what it listed: at worst `none`.
        unsafe { EnumWindows(Some(collect), &mut all as *mut Vec<HWND> as LPARAM) };
        // One process owns many windows: its program is read once.
        let mut of_target: HashMap<u32, bool> = HashMap::new();
        all.into_iter()
            .filter(|&window| {
                let mut pid = 0;
                unsafe { GetWindowThreadProcessId(window, &mut pid) };
                *of_target.entry(pid).or_insert_with(|| match target {
                    RaiseTarget::Pid(wanted) => pid == *wanted,
                    // Without case, as Windows compares file names.
                    RaiseTarget::Exe(name) => program_name(pid)
                        .is_some_and(|program| program.to_lowercase() == name.to_lowercase()),
                })
            })
            .collect()
    }

    unsafe extern "system" fn collect(window: HWND, all: LPARAM) -> BOOL {
        unsafe { (*(all as *mut Vec<HWND>)).push(window) };
        1
    }

    /// The file name of [pid]'s program, read from its image as desktop/win.rs reads one; None
    /// when it cannot be opened (another user's, a protected one, or one that has exited).
    fn program_name(pid: u32) -> Option<String> {
        let (process, _) = crate::ps::open_process(pid)?;
        let mut path = vec![0u16; 32_768];
        let mut len = path.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(
                process.as_raw_handle() as HANDLE,
                PROCESS_NAME_WIN32,
                path.as_mut_ptr(),
                &mut len,
            )
        };
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&path[..len as usize]);
        path.rsplit('\\').next().map(str::to_string)
    }

    fn candidate(window: HWND) -> Candidate {
        unsafe {
            Candidate {
                visible: IsWindowVisible(window) != 0,
                owned: !GetWindow(window, GW_OWNER).is_null(),
                tool: GetWindowLongW(window, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0,
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
        // (ShellExecuteExW's documentation).
        unsafe {
            CoInitializeEx(
                std::ptr::null(),
                (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
            )
        };
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
    use super::*;

    const SHOWN: Candidate = Candidate {
        visible: true,
        owned: false,
        tool: false,
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
