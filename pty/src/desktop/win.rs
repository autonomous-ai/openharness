//! The Windows calls behind system.rs's [Real](super::system::Real): starting the app, waiting for a process and
//! the message box.

use std::ffi::{OsStr, OsString};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};
use std::time::Duration;

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

pub fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
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
        |warning| super::launch::log(dir.parent().and_then(Path::parent).unwrap_or(dir), &warning),
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
