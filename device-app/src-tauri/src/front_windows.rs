//! The app in front on Windows: the system tells each foreground change. No timer, no permission.

#[cfg(windows)]
use {
    crate::front::{FrontSource, Source, Stop, on_thread},
    crate::types::Log,
    std::cell::OnceCell,
    std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    std::ptr,
    std::sync::Arc,
    windows_sys::Win32::Foundation::HWND,
    windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    },
    windows_sys::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent},
    windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, EVENT_SYSTEM_FOREGROUND, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, MSG,
        WINEVENT_OUTOFCONTEXT,
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

/// Sets the hook, tells the window in front now, then runs this thread's message loop, inside which the hook is called.
/// The hook is set first, so a change before the first value waits in the queue and is not missed.
#[cfg(windows)]
fn follow(changed: Box<dyn Fn(String) + Send + Sync>) -> Stop {
    // SAFETY: no module (the procedure is in this process), and `foreground` lives as long as the process.
    let hook: HWINEVENTHOOK = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            ptr::null_mut(),
            Some(foreground),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        )
    };
    if hook.is_null() {
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
    // SAFETY: the hook was set by this thread and is unhooked once.
    unsafe { UnhookWinEvent(hook) };
    Stop::Ended
}

#[cfg(windows)]
unsafe extern "system" fn foreground(_: HWINEVENTHOOK, _: u32, window: HWND, _: i32, _: i32, _: u32, _: u32) {
    CHANGED.with(|cell| {
        if let Some(changed) = cell.get() {
            changed(app(window));
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
}
