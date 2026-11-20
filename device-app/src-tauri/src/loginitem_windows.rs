//! Open at login on Windows: the Run value, and the switch Windows' startup settings keep beside it.

use crate::loginitem::Status;
#[cfg(windows)]
use crate::loginitem::{LoginItem, SystemLoginItem, register_from};
use std::path::Path;
#[cfg(windows)]
use std::ptr;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
#[cfg(windows)]
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE, RRF_NOEXPAND, RRF_RT_ANY,
    RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW,
};

/// The Run value's name: the app's installed name, which the uninstaller removes too.
pub const RUN_VALUE: &str = "Harness Device";

/// What Windows says of the app's login item. Startup Apps keeps its switch in a value of its own: a first byte other
/// than 02 is off, also with the Run value gone, since a value written again would stay off.
pub fn status(run: Option<&str>, approved: Option<&[u8]>) -> Status {
    match (run, approved) {
        (_, Some([first, ..])) if *first != 0x02 => Status::RequiresApproval,
        (Some(_), _) => Status::Enabled,
        (None, _) => Status::NotRegistered,
    }
}

/// The Run value's data: the exe's path in double quotes, which a path with a space needs.
pub fn run_data(exe: &Path) -> String {
    format!("\"{}\"", exe.display())
}

/// The Run key and Startup Apps' key beside it, under HKCU.
#[cfg(windows)]
pub struct Keys {
    pub run: &'static str,
    pub approved: &'static str,
}

#[cfg(windows)]
pub const SYSTEM: Keys = Keys {
    run: r"Software\Microsoft\Windows\CurrentVersion\Run",
    approved: r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
};

/// Writes the Run value for `exe` only when `register_from` says so.
#[cfg(windows)]
pub fn register_in(keys: &Keys, exe: &Path) -> Result<(), String> {
    let run = read(keys.run, RUN_VALUE).map_err(failed)?.map(|data| text(&data));
    let approved = read(keys.approved, RUN_VALUE).map_err(failed)?;
    register_from(status(run.as_deref(), approved.as_deref()), || {
        write(keys.run, RUN_VALUE, REG_SZ, &sz(&run_data(exe))).map_err(failed)
    })
}

/// The error code only, as on macOS.
#[cfg(windows)]
fn failed(code: u32) -> String {
    format!("Login item not added (error {code}).")
}

#[cfg(windows)]
impl LoginItem for SystemLoginItem {
    /// Never called under `cargo test`: it would make the test binary a login item of the developer's account.
    fn register(&self) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|error| failed(error.raw_os_error().unwrap_or_default() as u32))?;
        register_in(&SYSTEM, &exe)
    }
}

/// `text` NUL-terminated, for the W calls.
#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

/// A REG_SZ value's bytes.
#[cfg(windows)]
fn sz(text: &str) -> Vec<u8> {
    wide(text).iter().flat_map(|unit| unit.to_le_bytes()).collect()
}

/// A REG_SZ value's text, without its NUL.
#[cfg(windows)]
fn text(data: &[u8]) -> String {
    let units: Vec<u16> = data.as_chunks().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
    String::from_utf16_lossy(&units).trim_end_matches('\0').to_string()
}

/// A value's bytes under HKCU, None when it or its key is missing.
#[cfg(windows)]
fn read(subkey: &str, name: &str) -> Result<Option<Vec<u8>>, u32> {
    let (subkey, name) = (wide(subkey), wide(name));
    // Unexpanded: a REG_EXPAND_SZ value's expanded size may exceed the size first asked for.
    let flags = RRF_RT_ANY | RRF_NOEXPAND;
    let mut size = 0;
    // SAFETY: both strings are NUL-terminated and outlive the call; no data is written with a null buffer.
    let code = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            name.as_ptr(),
            flags,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut size,
        )
    };
    if code == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if code != ERROR_SUCCESS {
        return Err(code);
    }
    let mut data = vec![0u8; size as usize];
    // SAFETY: as above, and `data` holds the `size` bytes the call may write.
    let code = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            name.as_ptr(),
            flags,
            ptr::null_mut(),
            data.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if code != ERROR_SUCCESS {
        return Err(code);
    }
    data.truncate(size as usize);
    Ok(Some(data))
}

/// Sets a value under HKCU, making its key when a fresh profile has none.
#[cfg(windows)]
fn write(subkey: &str, name: &str, kind: REG_VALUE_TYPE, data: &[u8]) -> Result<(), u32> {
    let (subkey, name) = (wide(subkey), wide(name));
    let mut key: HKEY = ptr::null_mut();
    // SAFETY: the subkey is NUL-terminated and outlives the call; `key` receives the opened key.
    let code = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            ptr::null(),
            &mut key,
            ptr::null_mut(),
        )
    };
    if code != ERROR_SUCCESS {
        return Err(code);
    }
    // SAFETY: `key` is open; the name is NUL-terminated and `data` holds the bytes named.
    let code = unsafe { RegSetValueExW(key, name.as_ptr(), 0, kind, data.as_ptr(), data.len() as u32) };
    // SAFETY: `key` is open and closed once.
    unsafe { RegCloseKey(key) };
    if code == ERROR_SUCCESS { Ok(()) } else { Err(code) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loginitem::Status;
    use std::path::Path;

    const EXE: &str = r#""C:\Users\Nguyễn Văn A\AppData\Local\Harness Device\harness-device.exe""#;
    const ON: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const OFF: [u8; 12] = [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    #[test]
    fn only_a_missing_value_is_written_and_a_turned_off_one_stays_off() {
        assert_eq!(status(None, None), Status::NotRegistered);
        assert_eq!(status(Some(EXE), None), Status::Enabled);
        assert_eq!(status(Some(EXE), Some(&ON)), Status::Enabled);
        assert_eq!(status(Some(EXE), Some(&OFF)), Status::RequiresApproval);
        // Turned off in Startup Apps, then its value removed: a value written again would stay off, so none is.
        assert_eq!(status(None, Some(&OFF)), Status::RequiresApproval);
        assert_eq!(status(Some(EXE), Some(&[])), Status::Enabled);
    }

    #[test]
    fn the_value_is_the_quoted_exe() {
        let exe = Path::new(r"C:\Users\Nguyễn Văn A\AppData\Local\Harness Device\harness-device.exe");
        assert_eq!(run_data(exe), EXE);
    }

    /// Scratch keys under HKCU, removed when dropped, so no test touches the machine's real Run key.
    #[cfg(windows)]
    struct Scratch(Vec<u16>);

    #[cfg(windows)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RegDeleteTreeW};
            // SAFETY: the subkey is NUL-terminated and outlives the call.
            unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, self.0.as_ptr()) };
        }
    }

    #[cfg(windows)]
    #[test]
    fn register_writes_the_value_once_and_never_turns_one_back_on() {
        use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, REG_BINARY, RegDeleteKeyValueW};
        let root = format!(r"Software\HarnessDeviceTest-{}", std::process::id());
        let _scratch = Scratch(wide(&root));
        let keys = Keys { run: format!(r"{root}\Run").leak(), approved: format!(r"{root}\StartupApproved\Run").leak() };
        let exe = Path::new(r"C:\Users\Nguyễn Văn A\AppData\Local\Harness Device\harness-device.exe");
        let run = || read(keys.run, RUN_VALUE).unwrap();

        register_in(&keys, exe).unwrap();
        assert_eq!(run(), Some(sz(&run_data(exe))));

        // A value there is never written again, also by another build.
        register_in(&keys, Path::new(r"C:\Other\harness-device.exe")).unwrap();
        assert_eq!(run(), Some(sz(&run_data(exe))));

        // Turned off in Startup Apps, then the value removed: it stays off.
        write(keys.approved, RUN_VALUE, REG_BINARY, &OFF).unwrap();
        // SAFETY: both strings are NUL-terminated and outlive the call.
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, wide(keys.run).as_ptr(), wide(RUN_VALUE).as_ptr()) };
        register_in(&keys, exe).unwrap();
        assert_eq!(run(), None);

        // Turned on again in Startup Apps: the missing value is written.
        write(keys.approved, RUN_VALUE, REG_BINARY, &ON).unwrap();
        register_in(&keys, exe).unwrap();
        assert_eq!(run(), Some(sz(&run_data(exe))));
    }

    /// Tauri's uninstaller removes the Run value on an uninstall, and on a manual upgrade that uninstalls first, and
    /// leaves state.json and Startup Apps' switch: each launch writes it again, unless that switch is off.
    #[cfg(windows)]
    #[test]
    fn a_removed_value_comes_back_unless_startup_apps_turned_it_off() {
        use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, REG_BINARY, RegDeleteKeyValueW};
        let root = format!(r"Software\HarnessDeviceTest-{}-removed", std::process::id());
        let _scratch = Scratch(wide(&root));
        let keys = Keys { run: format!(r"{root}\Run").leak(), approved: format!(r"{root}\StartupApproved\Run").leak() };
        let exe = Path::new(r"C:\Users\Nguyễn Văn A\AppData\Local\Harness Device\harness-device.exe");
        let run = || read(keys.run, RUN_VALUE).unwrap();
        // SAFETY: both strings are NUL-terminated and outlive the call.
        let uninstall =
            || unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, wide(keys.run).as_ptr(), wide(RUN_VALUE).as_ptr()) };

        assert_eq!(register_in(&keys, exe), Ok(true));
        assert_eq!(register_in(&keys, exe), Ok(false));
        for approved in [None, Some(ON)] {
            if let Some(approved) = approved {
                write(keys.approved, RUN_VALUE, REG_BINARY, &approved).unwrap();
            }
            uninstall();
            assert_eq!(register_in(&keys, exe), Ok(true), "{approved:?}");
            assert_eq!(run(), Some(sz(&run_data(exe))));
        }
        write(keys.approved, RUN_VALUE, REG_BINARY, &OFF).unwrap();
        uninstall();
        assert_eq!(register_in(&keys, exe), Ok(false));
        assert_eq!(run(), None);
    }
}
