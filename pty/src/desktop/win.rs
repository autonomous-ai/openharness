//! The Windows calls behind system.rs's [Real](super::system::Real): starting the app, waiting for a process and
//! quitting it, the registry, the message box and the cmd.exe step of an uninstall.

use std::ffi::{OsStr, OsString, c_void};
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, FILETIME, HANDLE,
    INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetProcessTimes, OpenProcess, PROCESS_INFORMATION, PROCESS_SYNCHRONIZE,
    STARTUPINFOW, WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MessageBoxW,
};

use super::KnownFolder;
use super::registry::{Key, Value};
use windows_sys::Win32::Foundation::{BOOL, ERROR_FILE_NOT_FOUND, HWND, LPARAM, TRUE};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
    RRF_RT_REG_SZ, RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegGetValueW, RegSetValueExW,
};
use windows_sys::Win32::System::Threading::{
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    QueryFullProcessImageNameW, TerminateProcess,
};
use windows_sys::Win32::UI::Shell::{
    FOLDERID_Profile, FOLDERID_Programs, FOLDERID_UserProgramFiles, KF_FLAG_DONT_VERIFY,
    SHGetKnownFolderPath,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowThreadProcessId, PostMessageW, RegisterWindowMessageW,
};

/// The Flutter runner's window class (desktop/windows/runner/win32_window.cpp, kWindowClassName). Every Flutter app
/// has it, so a window counts only when its process is `<root>\app\*\harness-desktop.exe`; the title is not used.
const WINDOW_CLASS: &str = "FLUTTER_RUNNER_WIN32_WINDOW";
/// `WM_HARNESS_QUIT` (desktop/windows/runner/single_instance.h): a registered message, so it means the same in
/// every process and no other program's message collides with it.
pub const QUIT_MESSAGE: &str = "Autonomous.Harness.Quit";

pub fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
}

pub fn known_folder(folder: KnownFolder) -> Option<PathBuf> {
    let (id, flags) = match folder {
        // Resolve even if missing; installing creates directories only after waiting.
        KnownFolder::UserProgramFiles => (&FOLDERID_UserProgramFiles, KF_FLAG_DONT_VERIFY as u32),
        KnownFolder::Programs => (&FOLDERID_Programs, KF_FLAG_DONT_VERIFY as u32),
        KnownFolder::Profile => (&FOLDERID_Profile, KF_FLAG_DONT_VERIFY as u32),
    };
    let mut out = null_mut();
    let hr = unsafe { SHGetKnownFolderPath(id, flags, null_mut(), &mut out) };
    let path = (hr >= 0 && !out.is_null()).then(|| {
        let length = (0..).take_while(|&i| unsafe { *out.add(i) } != 0).count();
        PathBuf::from(OsString::from_wide(unsafe {
            std::slice::from_raw_parts(out, length)
        }))
    });
    // Freed whatever the answer: the shell may allocate it on a failure too.
    unsafe { CoTaskMemFree(out as *const c_void) };
    path
}

pub fn message_box(text: &str) {
    let text = wide(OsStr::new(text));
    let caption = wide(OsStr::new(super::DISPLAY_NAME));
    unsafe {
        MessageBoxW(
            null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND,
        )
    };
}

/// `"<exe>" <args>`, each argument quoted as the C runtime splits it back (launcher::quote_arg).
pub fn command_line(exe: &Path, args: &[OsString]) -> Vec<u16> {
    let mut line = vec![b'"' as u16];
    line.extend(exe.as_os_str().encode_wide());
    line.push(b'"' as u16);
    for arg in args {
        line.push(b' ' as u16);
        crate::launcher::quote_arg(&arg.encode_wide().collect::<Vec<u16>>(), &mut line);
    }
    line
}

fn filetime(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

/// A process's creation time, which tells it apart from a later process given the same pid.
fn created(process: HANDLE) -> u64 {
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut creation, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return 0;
    }
    filetime(creation)
}

/// Start [exe] with no inherited handle, outside this launcher's job when the job allows it (launcher::start): a
/// pane's job would end the app with the pane. Its pid and creation time.
pub fn start_app(exe: &Path, dir: &Path, args: &[OsString]) -> io::Result<(u32, u64)> {
    let application = wide(exe.as_os_str());
    let directory = wide(dir.as_os_str());
    let spawn = |flags: u32| -> io::Result<(u32, u64)> {
        let mut line = command_line(exe, args);
        line.push(0);
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            CreateProcessW(
                application.as_ptr(),
                line.as_mut_ptr(),
                null(),
                null(),
                0,
                flags,
                null(),
                directory.as_ptr(),
                &startup,
                &mut info,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let made = (info.dwProcessId, created(info.hProcess));
        unsafe {
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
        }
        Ok(made)
    };
    let mut made = None;
    let started = crate::launcher::start(
        |flags| {
            spawn(flags).map(|pid_created| {
                made = Some(pid_created);
                pid_created.0
            })
        },
        |warning| super::launch::start_warning(exe, dir, &warning),
    );
    started.map(|_| made.unwrap_or((0, 0)))
}

/// Confirm nonexistence after OpenProcess rejects a nonzero pid. In particular,
/// access denied never means the old app is gone.
fn process_exists(pid: u32) -> io::Result<bool> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = unsafe { Process32FirstW(snapshot, &mut entry) };
        loop {
            if found == 0 {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                    Ok(false)
                } else {
                    Err(error)
                };
            }
            if entry.th32ProcessID == pid {
                return Ok(true);
            }
            found = unsafe { Process32NextW(snapshot, &mut entry) };
        }
    })();
    unsafe { CloseHandle(snapshot) };
    result
}

/// Confirmed exit/reuse is Ended; unavailable creation identity stays Unknown.
fn observed_liveness(
    recorded: u64,
    actual: u64,
    exited: Option<bool>,
) -> super::rollback::Liveness {
    use super::rollback::Liveness;
    if exited == Some(true) || (recorded != 0 && actual != 0 && recorded != actual) {
        Liveness::Ended
    } else if exited == Some(false) && recorded != 0 && recorded == actual {
        Liveness::Running
    } else {
        Liveness::Unknown
    }
}

/// Observe the recorded PID and creation time without waiting or terminating.
pub fn liveness(pid: u32, recorded: u64) -> super::rollback::Liveness {
    use super::rollback::Liveness;
    if pid == 0 {
        return Liveness::Unknown;
    }
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if process.is_null() {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32)
            && matches!(process_exists(pid), Ok(false))
        {
            Liveness::Ended
        } else {
            Liveness::Unknown
        };
    }
    let actual = created(process);
    let exited = match unsafe { WaitForSingleObject(process, 0) } {
        WAIT_OBJECT_0 => Some(true),
        WAIT_TIMEOUT => Some(false),
        _ => None,
    };
    unsafe { CloseHandle(process) };
    observed_liveness(recorded, actual, exited)
}

pub fn wait_for_exit(pid: u32, wait: Duration) -> io::Result<()> {
    if pid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a positive process id",
        ));
    }
    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) && !process_exists(pid)? {
            return Ok(());
        }
        return Err(error);
    }
    let result = match unsafe {
        WaitForSingleObject(
            process,
            wait.as_millis().min(u128::from(u32::MAX - 1)) as u32,
        )
    } {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "the previous Harness app is still running",
        )),
        // Capture GetLastError before CloseHandle can overwrite it.
        WAIT_FAILED => Err(io::Error::last_os_error()),
        value => Err(io::Error::other(format!(
            "unexpected process wait result {value}"
        ))),
    };
    unsafe { CloseHandle(process) };
    result
}

fn image_of(pid: u32) -> io::Result<Option<PathBuf>> {
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if process.is_null() {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32)
            && !process_exists(pid)?
        {
            Ok(None)
        } else {
            Err(error)
        };
    }
    let mut buffer = vec![0u16; 32_768];
    let mut size = buffer.len() as u32;
    let result = if unsafe {
        QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size)
    } != 0
    {
        Ok(Some(PathBuf::from(OsString::from_wide(
            &buffer[..size as usize],
        ))))
    } else {
        let error = io::Error::last_os_error();
        if unsafe { WaitForSingleObject(process, 0) } == WAIT_OBJECT_0 {
            Ok(None)
        } else {
            Err(error)
        }
    };
    unsafe { CloseHandle(process) };
    result
}

/// Whether [image] is `<root>\app\<one folder>\harness-desktop.exe`.
fn from_install(image: &Path, root: &Path) -> bool {
    let Some(folder) = image.parent() else {
        return false;
    };
    let named = image
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(super::APP_EXE));
    named
        && folder
            .parent()
            .is_some_and(|app| super::same_folder(app, &root.join(super::APP_DIR)))
}

/// Each top-level window of [WINDOW_CLASS], hidden ones too (a window hidden to the tray is still there), with its
/// process id.
fn flutter_windows() -> io::Result<Vec<(HWND, u32)>> {
    unsafe extern "system" fn each(window: HWND, found: LPARAM) -> BOOL {
        let found = unsafe { &mut *(found as *mut Vec<(HWND, u32)>) };
        let mut class = [0u16; 64];
        let length = unsafe { GetClassNameW(window, class.as_mut_ptr(), class.len() as i32) };
        if length > 0 && String::from_utf16_lossy(&class[..length as usize]) == WINDOW_CLASS {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(window, &mut pid) };
            found.push((window, pid));
        }
        TRUE
    }
    let mut found: Vec<(HWND, u32)> = Vec::new();
    if unsafe { EnumWindows(Some(each), &mut found as *mut Vec<(HWND, u32)> as LPARAM) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(found)
}

fn app_windows(root: &Path) -> io::Result<Vec<(HWND, u32)>> {
    let mut found = Vec::new();
    for (window, pid) in flutter_windows()? {
        if image_of(pid)?.is_some_and(|image| from_install(&image, root)) {
            found.push((window, pid));
        }
    }
    Ok(found)
}

/// Best-effort observer: processes from [root] with a window, each once. Destructive
/// operations use checked enumeration instead and never infer exit from an observation error.
pub fn app_processes(root: &Path) -> Vec<u32> {
    let mut pids: Vec<u32> = app_windows(root)
        .unwrap_or_default()
        .into_iter()
        .map(|(_, pid)| pid)
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// Post `WM_HARNESS_QUIT` to each app window from [root], wait up to [wait] for their processes, then end the ones
/// still there (an install or uninstall must not leave the app holding its folder). How many processes there were.
pub fn quit_app(root: &Path, wait: Duration) -> io::Result<usize> {
    let windows = app_windows(root)?;
    if windows.is_empty() {
        return Ok(0);
    }
    // Keep the actual validated process alive as an identity until its handle closes.
    // Re-opening only by PID after posting/waiting could target a recycled PID.
    struct Process(HANDLE);
    impl Drop for Process {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
    let mut processes = Vec::new();
    for &(_, pid) in &windows {
        if processes.iter().any(|(id, _): &(u32, Process)| *id == pid) {
            continue;
        }
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) && !process_exists(pid)?
            {
                continue;
            }
            return Err(error);
        }
        let process = Process(handle);
        let mut image = vec![0u16; 32_768];
        let mut length = image.len() as u32;
        if unsafe {
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, image.as_mut_ptr(), &mut length)
        } == 0
        {
            let error = io::Error::last_os_error();
            if unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0 {
                continue;
            }
            return Err(error);
        }
        if !from_install(
            &PathBuf::from(OsString::from_wide(&image[..length as usize])),
            root,
        ) {
            return Err(io::Error::other(
                "the app process changed before it could be stopped",
            ));
        }
        processes.push((pid, process));
    }
    if processes.is_empty() {
        return Ok(0);
    }
    let message = unsafe { RegisterWindowMessageW(wide(OsStr::new(QUIT_MESSAGE)).as_ptr()) };
    if message == 0 {
        return Err(io::Error::last_os_error());
    }
    for (window, pid) in windows {
        let Some((_, process)) = processes.iter().find(|(id, _)| *id == pid) else {
            continue;
        };
        let mut current = 0;
        unsafe { GetWindowThreadProcessId(window, &mut current) };
        if current != pid {
            if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 {
                continue;
            }
            return Err(io::Error::other(
                "the app window changed before it could be asked to quit",
            ));
        }
        if unsafe { PostMessageW(window, message, 0, 0) } == 0 {
            let error = io::Error::last_os_error();
            if unsafe { WaitForSingleObject(process.0, 0) } != WAIT_OBJECT_0 {
                return Err(error);
            }
        }
    }
    let deadline = Instant::now() + wait;
    for (pid, process) in &processes {
        let left = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u128::from(u32::MAX - 1)) as u32;
        match unsafe { WaitForSingleObject(process.0, left) } {
            WAIT_OBJECT_0 => continue,
            WAIT_TIMEOUT => {}
            WAIT_FAILED => return Err(io::Error::last_os_error()),
            other => {
                return Err(io::Error::other(format!(
                    "unexpected app wait result {other}"
                )));
            }
        }
        super::launch::log(
            root,
            &format!("Harness (process {pid}) did not quit when asked; ending it"),
        );
        if unsafe { TerminateProcess(process.0, 1) } == 0 {
            let error = io::Error::last_os_error();
            if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 {
                continue;
            }
            return Err(error);
        }
        // TerminateProcess is asynchronous; copying/removing mapped files must wait for exit.
        match unsafe { WaitForSingleObject(process.0, 5_000) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Harness did not exit after being stopped",
                ));
            }
            WAIT_FAILED => return Err(io::Error::last_os_error()),
            other => {
                return Err(io::Error::other(format!(
                    "unexpected final app wait result {other}"
                )));
            }
        }
    }
    Ok(processes.len())
}

fn key_path(registry: &str, key: &str) -> Vec<u16> {
    wide(OsStr::new(&format!("{registry}\\{key}")))
}

fn win32(code: u32) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

pub fn read_value(registry: &str, key: &str, name: &str) -> Option<OsString> {
    let path = key_path(registry, key);
    let name = wide(OsStr::new(name));
    let mut size = 0u32;
    let probe = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            null_mut(),
            &mut size,
        )
    };
    if probe != 0 || size == 0 {
        return None;
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    let read = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if read != 0 {
        return None;
    }
    let length = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    Some(OsString::from_wide(&buffer[..length]))
}

pub fn write_keys(registry: &str, keys: &[Key]) -> io::Result<()> {
    for key in keys {
        let path = key_path(registry, &key.path);
        let mut handle: HKEY = null_mut();
        win32(unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                null(),
                &mut handle,
                null_mut(),
            )
        })?;
        let written = key.values.iter().try_for_each(|(name, value)| {
            let name = wide(OsStr::new(name));
            match value {
                Value::Text(text) => {
                    let data = wide(text);
                    win32(unsafe {
                        RegSetValueExW(
                            handle,
                            name.as_ptr(),
                            0,
                            REG_SZ,
                            data.as_ptr().cast(),
                            (data.len() * 2) as u32,
                        )
                    })
                }
                Value::Number(number) => {
                    let data = number.to_le_bytes();
                    win32(unsafe {
                        RegSetValueExW(handle, name.as_ptr(), 0, REG_DWORD, data.as_ptr(), 4)
                    })
                }
            }
        });
        unsafe { RegCloseKey(handle) };
        written?;
    }
    Ok(())
}

/// `HKCU\<registry>\<key>` and everything under it; a missing key is already removed.
pub fn delete_key(registry: &str, key: &str) -> io::Result<()> {
    match unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, key_path(registry, key).as_ptr()) } {
        0 | ERROR_FILE_NOT_FOUND => Ok(()),
        code => win32(code),
    }
}

/// Only the generated ASCII basename is passed to cmd, from its separately supplied cwd.
/// The full temporary path could contain a percent expansion in cmd /c.
pub fn start_script(script: &Path) -> io::Result<()> {
    start_script_with_warning(script, |warning| eprintln!("{warning}"))
}

pub(crate) fn start_script_with_warning(
    script: &Path,
    warning: impl FnMut(String),
) -> io::Result<()> {
    let dir = script.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let name = script
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(io::ErrorKind::InvalidInput)?;
    if !name.starts_with("harness-desktop-uninstall-")
        || !name.ends_with(".cmd")
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.'))
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let cmd = super::uninstall::system_root()
        .join("System32")
        .join("cmd.exe");
    let args = [
        OsString::from("/d"),
        OsString::from("/v:off"),
        OsString::from("/c"),
        OsString::from(format!(r".\{name}")),
    ];
    let application = wide(cmd.as_os_str());
    let directory = wide(dir.as_os_str());
    crate::launcher::start(
        |flags| {
            let mut line = command_line(&cmd, &args);
            line.push(0);
            let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
            startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe {
                CreateProcessW(
                    application.as_ptr(),
                    line.as_mut_ptr(),
                    null(),
                    null(),
                    0,
                    flags,
                    null(),
                    directory.as_ptr(),
                    &startup,
                    &mut info,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            unsafe {
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
            }
            Ok(info.dwProcessId)
        },
        warning,
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_command_line_splits_back_into_the_link() {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::UI::Shell::CommandLineToArgvW;
        let exe = PathBuf::from(
            r"C:\Users\Nguyễn Văn A' & 100% !x\AppData\Local\Programs\Harness\app\1.2.3\harness-desktop.exe",
        );
        let args = [
            OsString::from("harness://notification/m/a b"),
            OsString::from(r#"a\"b"#),
        ];
        let mut line = command_line(&exe, &args);
        line.push(0);
        let mut n = 0i32;
        let argv = unsafe { CommandLineToArgvW(line.as_ptr(), &mut n) };
        assert!(!argv.is_null());
        let words: Vec<String> = unsafe { std::slice::from_raw_parts(argv, n as usize) }
            .iter()
            .map(|&w| {
                let len = (0..).take_while(|&i| unsafe { *w.add(i) } != 0).count();
                String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(w, len) })
            })
            .collect();
        unsafe { LocalFree(argv.cast()) };
        assert_eq!(
            words,
            [
                exe.to_string_lossy().into_owned(),
                "harness://notification/m/a b".into(),
                r#"a\"b"#.into()
            ]
        );
    }
}

#[cfg(test)]
mod liveness_tests {
    use super::*;
    use crate::desktop::rollback::Liveness;

    #[test]
    fn uncertain_creation_time_keeps_the_ten_second_unknown_policy() {
        for (recorded, actual, exited, want) in [
            (1, 1, Some(false), Liveness::Running),
            (1, 2, Some(false), Liveness::Ended),
            (1, 0, Some(false), Liveness::Unknown),
            (0, 1, Some(false), Liveness::Unknown),
            (0, 0, Some(false), Liveness::Unknown),
            (1, 1, None, Liveness::Unknown),
            (1, 2, None, Liveness::Ended),
            (0, 0, Some(true), Liveness::Ended),
        ] {
            assert_eq!(observed_liveness(recorded, actual, exited), want);
        }
    }
    #[test]
    fn actual_process_identity_and_exit_are_observed() {
        let pid = std::process::id();
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        assert!(!handle.is_null());
        let mine = created(handle);
        unsafe { CloseHandle(handle) };
        assert_ne!(mine, 0);
        assert_eq!(liveness(pid, mine), Liveness::Running);
        assert_eq!(liveness(pid, mine + 1), Liveness::Ended);
        assert_eq!(liveness(pid, 0), Liveness::Unknown);
        assert_eq!(liveness(0, 0), Liveness::Unknown);
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        let captured = if handle.is_null() {
            0
        } else {
            let time = created(handle);
            unsafe { CloseHandle(handle) };
            time
        };
        assert!(child.wait().unwrap().success());
        assert_eq!(liveness(pid, captured), Liveness::Ended);
    }
}
