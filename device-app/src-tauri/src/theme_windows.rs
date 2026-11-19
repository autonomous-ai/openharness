//! The Windows taskbar's colour, light or dark, told as it changes.

#[cfg(windows)]
use std::{ptr, thread};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, WAIT_OBJECT_0};
#[cfg(windows)]
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_NOTIFY, KEY_QUERY_VALUE, REG_NOTIFY_CHANGE_LAST_SET, REG_NOTIFY_THREAD_AGNOSTIC,
    RRF_RT_REG_DWORD, RegCloseKey, RegGetValueW, RegNotifyChangeKeyValue, RegOpenKeyExW,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE, WaitForSingleObject};

/// The taskbar's theme key, under HKCU.
#[cfg(windows)]
pub const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

/// 1 when the taskbar is light.
#[cfg(windows)]
const VALUE: &str = "SystemUsesLightTheme";

/// Only 1 is light: Windows 10's taskbar with no value is dark.
pub fn light_panel(value: Option<u32>) -> bool {
    value == Some(1)
}

/// Whether the taskbar under HKCU's `key` is light now.
#[cfg(windows)]
pub fn read(key: &str) -> bool {
    light_panel(value(HKEY_CURRENT_USER, &wide(key)))
}

/// Tells `changed` each time HKCU's `key` turns light or dark. Windows pushes every write to the key; a write that
/// leaves the colour as it was tells nothing.
#[cfg(windows)]
pub fn watch(key: &'static str, changed: impl Fn(bool) + Send + 'static) {
    watch_under(HKEY_CURRENT_USER, key, changed)
}

/// `watch` under any open key, which a test makes in a hive of its own. The first notice is asked for before this
/// returns, so a change made after it is never missed.
#[cfg(windows)]
fn watch_under(root: HKEY, key: &str, changed: impl Fn(bool) + Send + 'static) {
    let key = wide(key);
    let mut opened: HKEY = ptr::null_mut();
    // SAFETY: the subkey is NUL-terminated and outlives the call; `opened` receives the key.
    if unsafe { RegOpenKeyExW(root, key.as_ptr(), 0, KEY_NOTIFY | KEY_QUERY_VALUE, &mut opened) } != ERROR_SUCCESS {
        return;
    }
    // Auto-reset: each wait takes one notice.
    // SAFETY: no attributes and no name; a null handle is checked below.
    let event = unsafe { CreateEventW(ptr::null(), 0, 0, ptr::null()) };
    let watched = Watched { key: opened, event };
    if event.is_null() || !watched.ask() {
        return;
    }
    // Asked before read: a change in between is a notice still to come.
    let mut last = watched.light();
    thread::spawn(move || {
        let watched = watched;
        // SAFETY: the event is open until `watched` drops, after the loop.
        while unsafe { WaitForSingleObject(watched.event, INFINITE) } == WAIT_OBJECT_0 && watched.ask() {
            let now = watched.light();
            if now != last {
                last = now;
                changed(now);
            }
        }
    });
}

/// The watched key and the event its notices set, closed together.
#[cfg(windows)]
struct Watched {
    key: HKEY,
    event: HANDLE,
}

// SAFETY: registry and event handles may be used from any thread; only the watch's own thread uses these once made.
#[cfg(windows)]
unsafe impl Send for Watched {}

#[cfg(windows)]
impl Watched {
    /// Asks for the next write to the key's values. Thread-agnostic: the notice outlives the thread that asked.
    fn ask(&self) -> bool {
        let filter = REG_NOTIFY_CHANGE_LAST_SET | REG_NOTIFY_THREAD_AGNOSTIC;
        // SAFETY: the key and the event are open.
        unsafe { RegNotifyChangeKeyValue(self.key, 0, filter, self.event, 1) == ERROR_SUCCESS }
    }

    fn light(&self) -> bool {
        light_panel(value(self.key, &[0]))
    }
}

#[cfg(windows)]
impl Drop for Watched {
    fn drop(&mut self) {
        // SAFETY: each is closed once; a null event was never opened.
        unsafe {
            RegCloseKey(self.key);
            if !self.event.is_null() {
                CloseHandle(self.event);
            }
        }
    }
}

/// The DWORD under `key`'s `subkey` (NUL-terminated, empty for `key` itself); None when missing or not a DWORD.
#[cfg(windows)]
fn value(key: HKEY, subkey: &[u16]) -> Option<u32> {
    let name = wide(VALUE);
    let (mut data, mut size) = (0u32, 4u32);
    // SAFETY: both strings are NUL-terminated and outlive the call; `data` holds the four bytes `size` names.
    let code = unsafe {
        RegGetValueW(
            key,
            subkey.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            ptr::null_mut(),
            (&raw mut data).cast(),
            &mut size,
        )
    };
    (code == ERROR_SUCCESS).then_some(data)
}

/// `text` NUL-terminated, for the W calls.
#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_value_of_one_is_a_light_panel() {
        assert!(light_panel(Some(1)));
        assert!(!light_panel(Some(0)));
        assert!(!light_panel(Some(2)));
        // Windows 10's taskbar with no value is dark.
        assert!(!light_panel(None));
    }

    /// The person's theme is read, never written: the changes go to a hive file of the test's own, which no other
    /// program sees.
    #[cfg(windows)]
    #[test]
    fn the_watch_tells_a_change_once() {
        use std::ptr;
        use std::sync::mpsc;
        use std::time::Duration;
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::{
            HKEY, KEY_ALL_ACCESS, REG_DWORD, RegCloseKey, RegLoadAppKeyW, RegSetKeyValueW,
        };

        // The real value reads, whichever it is.
        let _ = read(PERSONALIZE);

        let folder = tempfile::tempdir().unwrap();
        let hive = wide(&folder.path().join("theme.dat").display().to_string());
        let mut root: HKEY = ptr::null_mut();
        // SAFETY: the path is NUL-terminated and outlives the call; `root` receives the loaded hive.
        assert_eq!(unsafe { RegLoadAppKeyW(hive.as_ptr(), &mut root, KEY_ALL_ACCESS, 0, 0) }, ERROR_SUCCESS);
        let (key, name) = (wide("Personalize"), wide(VALUE));
        let set = |value: u32| {
            let data = value.to_le_bytes();
            // SAFETY: `root` is open; both strings are NUL-terminated; `data` holds the four bytes named.
            let code =
                unsafe { RegSetKeyValueW(root, key.as_ptr(), name.as_ptr(), REG_DWORD, data.as_ptr().cast(), 4) };
            assert_eq!(code, ERROR_SUCCESS);
        };
        set(0);

        let (told, tells) = mpsc::channel();
        watch_under(root, "Personalize", move |light| {
            let _ = told.send(light);
        });
        let wait = Duration::from_secs(10);
        set(1);
        assert_eq!(tells.recv_timeout(wait), Ok(true));
        // 1 again tells nothing: the next value told is the 0 after it.
        set(1);
        set(0);
        assert_eq!(tells.recv_timeout(wait), Ok(false));
        // SAFETY: `root` is open and closed once.
        unsafe { RegCloseKey(root) };
    }
}
