//! Fixture-only ownership. The World calls cleanup before TempDir drops and retains
//! that directory on failure. Never use PID reports alone as permission to terminate.
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, FILETIME, HANDLE,
    INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessId, GetProcessTimes, OpenProcess,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
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

fn api_error(operation: &str, pid: u32, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{operation} pid={pid}: {error}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn os_tool_lineage_excludes_siblings_and_timeout_never_terminates() {
        use super::*;
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let mut dir = tempfile::tempdir().unwrap();
        let owned = OwnedProcesses::new(dir.path());
        let root = std::env::var_os("SystemRoot").expect("Windows SystemRoot");
        let cmd = PathBuf::from(&root).join("System32").join("cmd.exe");
        let ping = PathBuf::from(&root).join("System32").join("PING.EXE");
        fs::write(
            dir.path().join("lineage.cmd"),
            b"@echo off\r\n\"%SystemRoot%\\System32\\PING.EXE\" -n 4 127.0.0.1 >nul\r\n",
        )
        .unwrap();
        let start = || {
            Command::new(&cmd)
                .args(["/d", "/v:off", "/c", "lineage.cmd"])
                .current_dir(dir.path())
                .creation_flags(0x0800_0000 | 0x0000_0200)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        };
        let mut child = start();
        let mut sibling = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            owned
                .observe_child(&child, &cmd, &[cmd.clone(), ping.clone()])
                .unwrap();
            sibling = Some(start());
            let sibling = sibling.as_mut().unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                owned.capture().unwrap();
                if owned
                    .handles
                    .borrow()
                    .values()
                    .any(|p| p.image == key(&ping).unwrap())
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "actual cmd -> ping lineage was not observed"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(!owned.handles.borrow().contains_key(&sibling.id()));
            assert!(owned.handles.borrow().values().all(|p| p.query_only));
            let denied = owned
                .handles
                .borrow()
                .get(&child.id())
                .unwrap()
                .confirm_exit_after_image_error(io::Error::from_raw_os_error(5))
                .unwrap_err();
            assert_eq!(
                denied.raw_os_error(),
                Some(5),
                "a live handle must preserve the image error"
            );
            assert_eq!(
                owned.cleanup(Duration::from_millis(10)).unwrap_err().kind(),
                io::ErrorKind::TimedOut
            );
            assert!(
                child.try_wait().unwrap().is_none(),
                "query-only cleanup terminated cmd"
            );
            assert!(
                sibling.try_wait().unwrap().is_none(),
                "unrelated cmd was affected"
            );
        }));
        // These exact Child capabilities naturally finish their bounded ping command.
        // Never kill an OS utility, including on an assertion unwind.
        let deadline = Instant::now() + Duration::from_secs(8);
        for child in std::iter::once(&mut child).chain(sibling.iter_mut()) {
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {}
                    Err(error) => {
                        dir.disable_cleanup(true);
                        panic!(
                            "OS fixture child wait is unknown; retained {}: {error}",
                            dir.path().display()
                        );
                    }
                }
                if Instant::now() >= deadline {
                    dir.disable_cleanup(true);
                    panic!(
                        "OS fixture child stayed live; retained {}",
                        dir.path().display()
                    );
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        // QueryFullProcessImageNameW may no longer work after positive exit.
        // The exact returned Child and previously validated held identity remain.
        let after_exit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            owned
                .handles
                .borrow()
                .get(&child.id())
                .unwrap()
                .confirm_exit_after_image_error(io::Error::from_raw_os_error(5))
                .unwrap();
            owned
                .observe_child(&child, &cmd, &[cmd.clone(), ping.clone()])
                .unwrap();
        }));
        if let Err(error) = owned.cleanup(Duration::from_secs(5)) {
            dir.disable_cleanup(true);
            panic!(
                "OS fixture descendants unconfirmed; retained {}: {error}",
                dir.path().display()
            );
        }
        if let Err(panic) = result.and(after_exit) {
            std::panic::resume_unwind(panic);
        }
    }
}

struct Process {
    handle: HANDLE,
    pid: u32,
    image: String,
    query_only: bool,
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
            let error = io::Error::last_os_error();
            return Err(api_error(
                "QueryFullProcessImageNameW",
                unsafe { GetProcessId(handle) },
                error,
            ));
        }
        Ok(PathBuf::from(OsString::from_wide(&data[..size as usize])))
    }
    fn open(pid: u32, access: u32) -> io::Result<Option<Self>> {
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32)
                && !snapshot()?.iter().any(|(id, _, _)| *id == pid)
            {
                return Ok(None);
            }
            return Err(api_error(
                &format!("OpenProcess access={access:#x}"),
                pid,
                error,
            ));
        }
        let mut process = Self {
            handle,
            pid,
            image: String::new(),
            query_only: access & PROCESS_TERMINATE == 0,
        };
        match Self::image(handle) {
            Ok(path) => process.image = key(&path)?,
            Err(error) => {
                process.confirm_exit_after_image_error(error)?;
                return Ok(None);
            }
        }
        Ok(Some(process))
    }
    fn confirm_exit_after_image_error(&self, error: io::Error) -> io::Result<()> {
        // Teardown can remove the image before signaling the process handle.
        // Only a positive kernel wait authorizes treating it as already gone.
        match unsafe { WaitForSingleObject(self.handle, 100) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(error),
            WAIT_FAILED => Err(api_error(
                "WaitForSingleObject(image error)",
                self.pid,
                io::Error::last_os_error(),
            )),
            other => Err(io::Error::other(format!(
                "unexpected image-error wait {other}"
            ))),
        }
    }
    fn exited(&self) -> io::Result<bool> {
        match unsafe { WaitForSingleObject(self.handle, 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            WAIT_FAILED => Err(api_error(
                "WaitForSingleObject(zero)",
                self.pid,
                io::Error::last_os_error(),
            )),
            other => Err(io::Error::other(format!("unexpected fixture wait {other}"))),
        }
    }
    fn stop(&self, deadline: Instant) -> io::Result<()> {
        if self.exited()? {
            return Ok(());
        }
        if self.query_only {
            return self.wait(deadline);
        }
        if unsafe { TerminateProcess(self.handle, 1) } == 0 {
            let error = io::Error::last_os_error();
            if self.exited()? {
                return Ok(());
            }
            return Err(error);
        }
        self.wait(deadline)
    }
    fn wait(&self, deadline: Instant) -> io::Result<()> {
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
            WAIT_FAILED => Err(api_error(
                "WaitForSingleObject(final)",
                self.pid,
                io::Error::last_os_error(),
            )),
            other => Err(io::Error::other(format!(
                "unexpected fixture final wait {other}"
            ))),
        }
    }
    fn lifetime(&self) -> io::Result<(u64, Option<u64>)> {
        // GetProcessTimes' exit value is undefined while the process is live.
        let exited = self.exited()?;
        let [mut creation, mut exit, mut kernel, mut user]: [FILETIME; 4] =
            unsafe { std::mem::zeroed() };
        if unsafe {
            GetProcessTimes(
                self.handle,
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(api_error(
                "GetProcessTimes",
                self.pid,
                io::Error::last_os_error(),
            ));
        }
        let ticks =
            |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
        let created = ticks(creation);
        let exit = exited.then(|| ticks(exit));
        if created == 0 || exit.is_some_and(|end| end < created) {
            return Err(io::Error::other("fixture process timing is unknown"));
        }
        Ok((created, exit))
    }
}

fn snapshot() -> io::Result<Vec<(u32, String, u32)>> {
    let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(api_error(
            "CreateToolhelp32Snapshot",
            0,
            io::Error::last_os_error(),
        ));
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
                    Err(api_error("Process32FirstW/Process32NextW", 0, error))
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
                entry.th32ParentProcessID,
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
    tools: RefCell<BTreeSet<String>>,
    uncertain_child: Cell<bool>,
}
impl OwnedProcesses {
    pub fn new(root: &Path) -> Self {
        Self {
            root: key(root).unwrap(),
            allowed: RefCell::default(),
            handles: RefCell::default(),
            pending: RefCell::default(),
            observed: RefCell::default(),
            tools: RefCell::default(),
            uncertain_child: Cell::new(false),
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
        for (pid, name, _) in snapshot()? {
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
            if !snapshot()?.iter().any(|(id, _, _)| *id == pid) {
                self.observed.borrow_mut().insert(expected.clone());
                self.pending.borrow_mut().remove(&expected);
            }
        }
        self.capture_tools()
    }
    /// Seed lineage from the actual returned Child handle, never a PID report.
    /// System tools retain QUERY/SYNCHRONIZE rights only; they are never killed.
    pub fn observe_child(
        &self,
        child: &std::process::Child,
        expected: &Path,
        tools: &[PathBuf],
    ) -> io::Result<()> {
        // A returned child may already be using this World: failed validation
        // must retain it even when no process identity could be registered.
        let prior_uncertainty = self.uncertain_child.replace(true);
        let expected = key(expected)?;
        let tools: BTreeSet<_> = tools.iter().map(|p| key(p)).collect::<io::Result<_>>()?;
        let inside = expected.starts_with(&(self.root.clone() + r"\"));
        if !inside && !tools.contains(&expected) {
            return Err(io::Error::other(
                "direct child is not an exact fixture tool",
            ));
        }
        let retained = self
            .handles
            .borrow()
            .get(&child.id())
            .map(|p| (p.pid, p.image.clone()));
        if let Some((retained_pid, retained_image)) = retained {
            let actual_pid = unsafe { GetProcessId(child.as_raw_handle() as HANDLE) };
            if actual_pid == 0 {
                return Err(api_error(
                    "GetProcessId(returned Child)",
                    child.id(),
                    io::Error::last_os_error(),
                ));
            }
            if actual_pid != child.id() || actual_pid != retained_pid || retained_image != expected
            {
                return Err(io::Error::other(
                    "returned child does not match its retained identity",
                ));
            }
            // Its held handle prevents PID reuse. Keep that positively checked
            // image identity instead of querying an exited process's image again.
            self.tools.borrow_mut().extend(tools);
            self.capture_tools()?;
            self.uncertain_child.set(prior_uncertainty);
            return Ok(());
        }
        let mut handle = std::ptr::null_mut();
        let current = unsafe { GetCurrentProcess() };
        if unsafe {
            DuplicateHandle(
                current,
                child.as_raw_handle() as HANDLE,
                current,
                &mut handle,
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                0,
            )
        } == 0
        {
            return Err(api_error(
                "DuplicateHandle(returned Child)",
                child.id(),
                io::Error::last_os_error(),
            ));
        }
        let mut process = Process {
            handle,
            pid: child.id(),
            image: String::new(),
            query_only: true,
        };
        process.image = key(&Process::image(handle)?)?;
        process.lifetime()?;
        if process.image != expected {
            return Err(io::Error::other(
                "returned child has a different executable",
            ));
        }
        self.tools.borrow_mut().extend(tools);
        if inside {
            self.allow(Path::new(&expected))?;
            // Preserve the original inside-root termination/capture contract.
            self.capture()?;
            if !self.handles.borrow().contains_key(&process.pid) {
                self.retain(process);
            }
        } else {
            self.retain(process);
        }
        self.capture_tools()?;
        self.uncertain_child.set(prior_uncertainty);
        Ok(())
    }
    fn capture_tools(&self) -> io::Result<()> {
        let tools = self.tools.borrow().clone();
        if tools.is_empty() {
            return Ok(());
        }
        // One finite snapshot per poll: discover its parent/child rows to a fixed
        // point without chasing an active producer beyond the cleanup deadline.
        let rows = snapshot()?;
        loop {
            let mut added = false;
            for (pid, name, parent_pid) in &rows {
                // Do not even open unrelated same-name OS processes.
                if self.handles.borrow().contains_key(pid)
                    || !tools.iter().any(|p| p.rsplit('\\').next() == Some(name))
                    || !self.handles.borrow().contains_key(parent_pid)
                {
                    continue;
                }
                let Some(child) = Process::open(
                    *pid,
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                )?
                else {
                    continue;
                };
                if !tools.contains(&child.image) {
                    continue;
                }
                let created = child.lifetime()?.0;
                let handles = self.handles.borrow();
                let parent = handles.get(parent_pid).unwrap();
                let (start, end) = parent.lifetime()?;
                if created < start || end.is_some_and(|end| created > end) {
                    return Err(io::Error::other(
                        "fixture descendant timing does not prove lineage",
                    ));
                }
                drop(handles);
                self.retain(child);
                added = true;
            }
            if !added {
                return Ok(());
            }
        }
    }
    /// Takes ownership of Shell's optional handle immediately; retains a separately
    /// opened, image-validated handle with the rights needed for cleanup.
    pub fn watch_shell(&self, image: &Path, report: &Path, handle: HANDLE) -> io::Result<()> {
        // Own the incoming handle before path checks can fail.
        let shell = (!handle.is_null()).then(|| Process {
            handle,
            pid: unsafe { GetProcessId(handle) },
            image: String::new(),
            query_only: true,
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
            // Retain parent handles/identities until after the final descendant scan.
            let handles = self.handles.borrow();
            let mut ordered: Vec<_> = handles.values().collect();
            // Stop/reap every possible producer before the final stand-in enumeration.
            ordered.sort_by_key(|p| {
                if p.query_only {
                    3
                } else if p.image.ends_with(r"\harness-shell-bootstrap.exe") {
                    0
                } else if p.image.ends_with(r"\harness.exe") {
                    1
                } else {
                    2
                }
            });
            let mut failed = None;
            for process in ordered {
                if let Err(error) = process.stop(deadline) {
                    failed = Some(error);
                }
            }
            drop(handles);
            if let Some(error) = failed.or(capture_error) {
                return Err(error);
            }
            if self.uncertain_child.get() {
                return Err(io::Error::other(
                    "returned child identity is uncertain; retain the fixture directory",
                ));
            }
            self.capture()?;
            if self
                .handles
                .borrow()
                .values()
                .try_fold(true, |all, p| p.exited().map(|done| all && done))?
                && self.pending.borrow().is_empty()
            {
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
