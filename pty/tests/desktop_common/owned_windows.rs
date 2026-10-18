//! Fixture-only ownership. The World calls cleanup before TempDir drops and retains
//! that directory on failure. Never use PID reports alone as permission to terminate.
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE,
    WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
};

fn key(path: &Path) -> io::Result<String> {
    let path = std::path::absolute(path)?;
    let text = path
        .to_str()
        .ok_or_else(|| io::Error::other("fixture path is not Unicode"))?;
    Ok(text
        .strip_prefix(r"\\?\")
        .unwrap_or(text)
        .trim_end_matches('\\')
        .to_lowercase())
}

struct Process {
    handle: HANDLE,
    pid: u32,
    image: String,
}
impl Drop for Process {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle) };
    }
}
impl Process {
    fn image(handle: HANDLE) -> io::Result<PathBuf> {
        let mut data = vec![0u16; 32_768];
        let mut size = data.len() as u32;
        if unsafe { QueryFullProcessImageNameW(handle, 0, data.as_mut_ptr(), &mut size) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(PathBuf::from(OsString::from_wide(&data[..size as usize])))
    }
    fn open(pid: u32, access: u32) -> io::Result<Option<Self>> {
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32)
                && !snapshot()?.iter().any(|(id, _)| *id == pid)
            {
                return Ok(None);
            }
            return Err(error);
        }
        let mut process = Self {
            handle,
            pid,
            image: String::new(),
        };
        match Self::image(handle) {
            Ok(path) => process.image = key(&path)?,
            Err(_error) if process.exited()? => return Ok(None),
            Err(error) => return Err(error),
        }
        Ok(Some(process))
    }
    fn exited(&self) -> io::Result<bool> {
        match unsafe { WaitForSingleObject(self.handle, 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            other => Err(io::Error::other(format!("unexpected fixture wait {other}"))),
        }
    }
    fn stop(&self, deadline: Instant) -> io::Result<()> {
        if self.exited()? {
            return Ok(());
        }
        if unsafe { TerminateProcess(self.handle, 1) } == 0 {
            let error = io::Error::last_os_error();
            if self.exited()? {
                return Ok(());
            }
            return Err(error);
        }
        let left = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u128::from(u32::MAX - 1)) as u32;
        match unsafe { WaitForSingleObject(self.handle, left) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("owned fixture process {} did not exit", self.pid),
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            other => Err(io::Error::other(format!(
                "unexpected fixture final wait {other}"
            ))),
        }
    }
}

fn snapshot() -> io::Result<Vec<(u32, String)>> {
    let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut rows = Vec::new();
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = unsafe { Process32FirstW(handle, &mut entry) };
        loop {
            if ok == 0 {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                    Ok(rows)
                } else {
                    Err(error)
                };
            }
            let end = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            rows.push((
                entry.th32ProcessID,
                String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase(),
            ));
            ok = unsafe { Process32NextW(handle, &mut entry) };
        }
    })();
    unsafe { CloseHandle(handle) };
    result
}

pub struct OwnedProcesses {
    root: String,
    allowed: RefCell<BTreeSet<String>>,
    handles: RefCell<BTreeMap<u32, Process>>,
    // A successful Shell call may start later and may return neither handle nor report.
    pending: RefCell<BTreeMap<String, PathBuf>>,
    observed: RefCell<BTreeSet<String>>,
}
impl OwnedProcesses {
    pub fn new(root: &Path) -> Self {
        Self {
            root: key(root).unwrap(),
            allowed: RefCell::default(),
            handles: RefCell::default(),
            pending: RefCell::default(),
            observed: RefCell::default(),
        }
    }
    pub fn allow(&self, image: &Path) -> io::Result<()> {
        let image = key(image)?;
        if !image.starts_with(&(self.root.clone() + r"\")) {
            return Err(io::Error::other("owned executable is outside the fixture"));
        }
        self.allowed.borrow_mut().insert(image);
        Ok(())
    }
    fn retain(&self, process: Process) {
        self.observed.borrow_mut().insert(process.image.clone());
        self.pending.borrow_mut().remove(&process.image);
        self.handles.borrow_mut().insert(process.pid, process);
    }
    fn capture(&self) -> io::Result<()> {
        let allowed = self.allowed.borrow().clone();
        let names: BTreeSet<_> = allowed
            .iter()
            .map(|p| p.rsplit('\\').next().unwrap().to_owned())
            .collect();
        for (pid, name) in snapshot()? {
            if !names.contains(&name) || self.handles.borrow().contains_key(&pid) {
                continue;
            }
            let Some(query) =
                Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)?
            else {
                continue;
            };
            if !allowed.contains(&query.image) {
                continue;
            }
            let Some(owned) = Process::open(
                pid,
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
            )?
            else {
                self.observed.borrow_mut().insert(query.image.clone());
                self.pending.borrow_mut().remove(&query.image);
                continue;
            };
            if owned.image != query.image {
                return Err(io::Error::other("fixture process identity changed"));
            }
            self.retain(owned);
        }
        // A unique self-report can establish prior ownership only when exit is proven.
        // A live PID is still checked against its actual image/handle by capture above.
        let pending = self.pending.borrow().clone();
        for (expected, report) in pending {
            let Ok(bytes) = fs::read(report) else {
                continue;
            };
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                continue;
            };
            let (Some(exe), Some(pid)) = (
                value["exe"].as_str(),
                value["pid"]
                    .as_u64()
                    .and_then(|p| u32::try_from(p).ok())
                    .filter(|p| *p > 0),
            ) else {
                continue;
            };
            if key(Path::new(exe))? != expected {
                return Err(io::Error::other(
                    "fixture report has a different executable",
                ));
            }
            if !snapshot()?.iter().any(|(id, _)| *id == pid) {
                self.observed.borrow_mut().insert(expected.clone());
                self.pending.borrow_mut().remove(&expected);
            }
        }
        Ok(())
    }
    /// Takes ownership of Shell's optional handle immediately; retains a separately
    /// opened, image-validated handle with the rights needed for cleanup.
    pub fn watch_shell(&self, image: &Path, report: &Path, handle: HANDLE) -> io::Result<()> {
        // Own the incoming handle before path checks can fail.
        let shell = (!handle.is_null()).then(|| Process {
            handle,
            pid: unsafe { GetProcessId(handle) },
            image: String::new(),
        });
        if shell.as_ref().is_some_and(|process| process.pid == 0) {
            return Err(io::Error::last_os_error());
        }
        self.allow(image)?;
        if !key(report)?.starts_with(&(self.root.clone() + r"\")) {
            return Err(io::Error::other("fixture report is outside the owned root"));
        }
        let expected = key(image)?;
        self.pending
            .borrow_mut()
            .insert(expected.clone(), report.to_owned());
        if let Some(shell) = shell {
            if let Some(owned) = Process::open(
                shell.pid,
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
            )? {
                if owned.image != expected {
                    return Err(io::Error::other("Shell returned an unrelated process"));
                }
                self.retain(owned);
            }
            // shell closes here on every success/error path.
        }
        self.capture()
    }
    pub fn await_observed(&self, image: &Path, timeout: Duration) -> io::Result<()> {
        let expected = key(image)?;
        let deadline = Instant::now() + timeout;
        loop {
            self.capture()?;
            if self.observed.borrow().contains(&expected) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "owned bootstrap was not observed",
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    pub fn live_count(&self) -> io::Result<usize> {
        self.capture()?;
        self.handles
            .borrow()
            .values()
            .try_fold(0, |n, p| p.exited().map(|exited| n + usize::from(!exited)))
    }
    pub fn cleanup(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            // Even a discovery error must not skip handles already positively owned.
            let capture_error = self.capture().err();
            let mut handles: Vec<_> = std::mem::take(&mut *self.handles.borrow_mut())
                .into_values()
                .collect();
            // Stop/reap every possible producer before the final stand-in enumeration.
            handles.sort_by_key(|p| {
                if p.image.ends_with(r"\harness-shell-bootstrap.exe") {
                    0
                } else if p.image.ends_with(r"\harness.exe") {
                    1
                } else {
                    2
                }
            });
            let mut failed = None;
            for process in handles {
                if let Err(error) = process.stop(deadline) {
                    failed = Some(error);
                }
            }
            if let Some(error) = failed.or(capture_error) {
                return Err(error);
            }
            self.capture()?;
            if self.handles.borrow().is_empty() && self.pending.borrow().is_empty() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "cannot establish that all owned fixture processes exited; retain the fixture directory",
                ));
            }
            std::thread::sleep(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(20)),
            );
        }
    }
}
