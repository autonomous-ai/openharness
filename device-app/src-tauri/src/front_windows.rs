//! The app in front on Windows: the system tells each foreground change. No timer, no permission.

#[cfg(windows)]
use {
    crate::front::{FrontSource, Source, Stop, on_thread},
    crate::types::Log,
    std::cell::OnceCell,
    std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    std::panic::{self, AssertUnwindSafe},
    std::ptr,
    std::sync::Arc,
    windows_sys::Win32::Foundation::HWND,
    windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    },
    windows_sys::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent},
    windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_SWITCHEND,
        GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, MSG, PostQuitMessage, WINEVENT_OUTOFCONTEXT,
    },
};

/// The exe's file name in an image path: the text after the last `\` or `/`.
pub fn file_name(image: &str) -> String {
    image.rsplit(['\\', '/']).next().unwrap_or_default().to_string()
}

/// The exe name of the foreground window's process: once at start, then on each change.
#[cfg(windows)]
pub struct WinFront {
    pub log: Arc<dyn Log>,
}

#[cfg(windows)]
impl FrontSource for WinFront {
    fn start(&self, changed: Box<dyn Fn(String) + Send + Sync>) {
        on_thread(self.log.clone(), Source::Windows, move || follow(changed));
    }
}

#[cfg(windows)]
thread_local! {
    /// Where the hook's calls tell: the hook takes no context, and an out-of-context hook is called on the thread
    /// that set it.
    static CHANGED: OnceCell<Box<dyn Fn(String) + Send + Sync>> = const { OnceCell::new() };
}

/// The events after which the window in front may have changed, as hook ranges: the foreground's own, and the end of
/// an Alt+Tab and of a minimize or a restore (a minimize's start is between them), for which Windows may raise none.
#[cfg(windows)]
const EVENTS: [(u32, u32); 2] =
    [(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND), (EVENT_SYSTEM_SWITCHEND, EVENT_SYSTEM_MINIMIZEEND)];

/// Sets the hooks, tells the window in front now, then runs this thread's message loop, inside which the hooks are
/// called. The hooks are set first, so a change before the first value waits in the queue and is not missed.
#[cfg(windows)]
fn follow(changed: Box<dyn Fn(String) + Send + Sync>) -> Stop {
    let hooks: [HWINEVENTHOOK; 2] = EVENTS.map(|(first, last)| {
        // SAFETY: no module (the procedure is in this process), and `foreground` lives as long as the process.
        unsafe { SetWinEventHook(first, last, ptr::null_mut(), Some(foreground), 0, 0, WINEVENT_OUTOFCONTEXT) }
    });
    let unhook = || {
        for hook in hooks.into_iter().filter(|hook| !hook.is_null()) {
            // SAFETY: set by this thread, and unhooked once.
            unsafe { UnhookWinEvent(hook) };
        }
    };
    if hooks.iter().any(|hook| hook.is_null()) {
        unhook();
        return Stop::NotFollowed;
    }
    // SAFETY: takes no argument.
    changed(app(unsafe { GetForegroundWindow() }));
    CHANGED.with(|cell| {
        cell.get_or_init(|| changed);
    });
    // SAFETY: MSG is plain data; all zeros is a valid value for GetMessageW to fill.
    let mut message: MSG = unsafe { std::mem::zeroed() };
    // SAFETY: `message` is writable for the call; the null window takes every message of this thread.
    while unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) } > 0 {
        // SAFETY: `message` was filled by GetMessageW.
        unsafe { DispatchMessageW(&message) };
    }
    unhook();
    Stop::Ended
}

/// Tells the window in front now, whichever window and event called it: a late or a stray event is put right by the
/// next one, and FrontFeed drops a value told again.
#[cfg(windows)]
unsafe extern "system" fn foreground(_: HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
    CHANGED.with(|cell| {
        if let Some(changed) = cell.get() {
            // SAFETY: takes no argument.
            let told = panic::catch_unwind(AssertUnwindSafe(|| changed(app(unsafe { GetForegroundWindow() }))));
            // A panic cannot unwind into Windows, which would end the app: it ends following instead, and `follow`
            // says so, as a panic on a Linux source's thread ends only that source.
            if told.is_err() {
                // SAFETY: takes no pointer; ends this thread's message loop.
                unsafe { PostQuitMessage(0) };
            }
        }
    });
}

/// The longest path Windows has, in UTF-16 units.
#[cfg(windows)]
const IMAGE_MAX: usize = 32_768;

/// The exe name of the process that owns `window`. No window, or a process this user may not open (a protected one,
/// or another account's), is the empty value.
#[cfg(windows)]
fn app(window: HWND) -> String {
    if window.is_null() {
        return String::new();
    }
    let mut pid = 0;
    // SAFETY: `pid` is writable; a window that has gone answers 0.
    unsafe { GetWindowThreadProcessId(window, &mut pid) };
    if pid == 0 {
        return String::new();
    }
    // SAFETY: no handle is inherited; a null answer is checked before it is owned.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return String::new();
    }
    // SAFETY: an open handle this function alone holds; it closes on drop.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let mut image = vec![0u16; IMAGE_MAX];
    let mut size = IMAGE_MAX as u32;
    // SAFETY: `image` holds `size` units; `size` is set to the units written.
    let read = unsafe {
        QueryFullProcessImageNameW(process.as_raw_handle(), PROCESS_NAME_WIN32, image.as_mut_ptr(), &mut size)
    };
    if read == 0 {
        return String::new();
    }
    file_name(&String::from_utf16_lossy(&image[..size as usize]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_value_is_the_exe_file_name() {
        assert_eq!(file_name(r"C:\Program Files\Microsoft VS Code\Code.exe"), "Code.exe");
        assert_eq!(file_name("C:/x/wezterm-gui.exe"), "wezterm-gui.exe");
        assert_eq!(file_name("WindowsTerminal.exe"), "WindowsTerminal.exe");
        assert_eq!(file_name(""), "");
    }

    #[cfg(windows)]
    #[test]
    fn the_source_tells_the_app_in_front_once_at_start() {
        use crate::front::{FrontSource, front_line};
        use crate::types::MemoryLog;
        use std::sync::Arc;
        use std::sync::mpsc;

        let (send, told) = mpsc::channel();
        WinFront { log: Arc::new(MemoryLog::default()) }.start(Box::new(move |value| {
            let _ = send.send(value);
        }));
        let value = told.recv_timeout(std::time::Duration::from_secs(5)).expect("a value within 5 s");
        // A runner's service session may have no window in front: the empty value.
        if !value.is_empty() {
            assert_eq!(front_line(&value), serde_json::json!({ "front": value }).to_string());
        }
    }

    /// A panic where the hook tells (a poisoned lock in the app) would unwind into Windows, which ends the process.
    #[cfg(windows)]
    #[test]
    fn a_panic_where_the_hook_tells_ends_following_not_the_app() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{PM_REMOVE, PeekMessageW, WM_QUIT};

        CHANGED.with(|cell| {
            let _ = cell.set(Box::new(|_| panic!("a poisoned lock")));
        });
        // SAFETY: called as Windows calls it, on the thread whose CHANGED it reads.
        unsafe { foreground(ptr::null_mut(), EVENT_SYSTEM_FOREGROUND, ptr::null_mut(), 0, 0, 0, 0) };
        // The message loop the hook runs in is told to quit: following ends, with its line.
        // SAFETY: MSG is plain data; all zeros is a valid value for PeekMessageW to fill.
        let mut message: MSG = unsafe { std::mem::zeroed() };
        let mut quit = false;
        // SAFETY: `message` is writable; the null window takes every message of this thread.
        while !quit && unsafe { PeekMessageW(&mut message, ptr::null_mut(), 0, 0, PM_REMOVE) } != 0 {
            quit = message.message == WM_QUIT;
        }
        assert!(quit, "the hook's message loop was not told to quit");
    }

    /// So any event, even a late or a stray one, brings the value back to the window in front.
    #[cfg(windows)]
    #[test]
    fn the_hook_tells_the_window_in_front_not_the_one_its_event_names() {
        use std::sync::mpsc;
        use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE};

        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        // SAFETY: a system class, NUL-terminated; no title, menu, instance or parameter. A message-only window: this
        // test's own, and never the window in front.
        let ours = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                ptr::null(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            )
        };
        assert!(!ours.is_null());
        let (send, told) = mpsc::channel();
        CHANGED.with(|cell| {
            let _ = cell.set(Box::new(move |value| {
                let _ = send.send(value);
            }));
        });
        // SAFETY: takes no argument.
        let before = app(unsafe { GetForegroundWindow() });
        // SAFETY: called as Windows calls it, on the thread whose CHANGED it reads.
        unsafe { foreground(ptr::null_mut(), EVENT_SYSTEM_FOREGROUND, ours, 0, 0, 0, 0) };
        // SAFETY: takes no argument.
        let after = app(unsafe { GetForegroundWindow() });
        let named = app(ours);
        // SAFETY: the window was made by this thread and is destroyed once.
        unsafe { DestroyWindow(ours) };
        let value = told.try_recv().expect("one value, told during the call");
        assert_ne!(value, named, "the event's window was told");
        assert!(value == before || value == after, "{value:?} is neither {before:?} nor {after:?}");
    }
}
