//! Windows: a CLI that harness-launch starts outlives the job harness-launch was started in. That is an SSH session
//! (OpenSSH ends the session's job when it disconnects: A's E2E finding F16) or the scheduled task. A job that
//! refuses breakaway still gets its CLI, started inside it, with a warning in launch.log.
#![cfg(windows)]
use std::fs;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

const LAUNCH: &str = env!("CARGO_BIN_EXE_harness-launch");

/// The fake CLI says it started, then, three seconds later (after the test closed the job), that it is still alive.
const CLI_JS: &str = "const fs = require('node:fs')\n\
fs.writeFileSync(process.env.OUT + '.started', String(process.pid))\n\
setTimeout(() => fs.writeFileSync(process.env.OUT + '.alive', String(process.pid)), 3000)\n";

fn job(breakaway_ok: bool) -> OwnedHandle {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        assert!(!job.is_null());
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | if breakaway_ok { JOB_OBJECT_LIMIT_BREAKAWAY_OK } else { 0 };
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        assert_ne!(ok, 0, "{}", std::io::Error::last_os_error());
        OwnedHandle::from_raw_handle(job as _)
    }
}

fn resume(pid: u32) {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut more = Thread32First(snap, &mut entry) != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                assert!(!thread.is_null());
                ResumeThread(thread);
                CloseHandle(thread);
            }
            more = Thread32Next(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
}

fn node() -> PathBuf {
    let path = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("node.exe"))
        .find(|path| path.is_file())
        .expect("node.exe on PATH (setup-node in CI, Node on the VM)");
    fs::canonicalize(path).unwrap()
}

fn install(root: &Path) {
    let node = node();
    let dir = root.join("runtime").join("node-test");
    fs::create_dir_all(&dir).unwrap();
    let linked = dir.join("node.exe");
    if fs::hard_link(&node, &linked).is_err() {
        fs::copy(&node, &linked).unwrap();
    }
    fs::write(root.join("runtime").join("current-node"), format!("{}\r\n", linked.display())).unwrap();
    fs::create_dir_all(root.join("cli").join("1.2.3")).unwrap();
    fs::write(root.join("cli").join("1.2.3").join("cli.js"), CLI_JS).unwrap();
    fs::write(root.join("cli").join("current"), "1.2.3\r\n").unwrap();
}

/// Run harness-launch inside `job` (assigned while suspended, so it starts there), wait for it to exit 0 and for
/// the CLI to start, then close the job and report whether the CLI lived on.
fn cli_outlives(breakaway_ok: bool) -> (bool, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    install(root);
    let out = root.join("out");
    let job = job(breakaway_ok);
    let mut launcher = Command::new(LAUNCH)
        .arg("--root")
        .arg(root)
        .arg("--")
        .env("OUT", &out)
        .creation_flags(CREATE_SUSPENDED)
        .spawn()
        .unwrap();
    let ok = unsafe { AssignProcessToJobObject(job.as_raw_handle() as HANDLE, launcher.as_raw_handle() as HANDLE) };
    assert_ne!(ok, 0, "{}", std::io::Error::last_os_error());
    resume(launcher.id());
    assert!(launcher.wait().unwrap().success());
    let started = PathBuf::from(format!("{}.started", out.display()));
    let deadline = Instant::now() + Duration::from_secs(20);
    while !started.exists() {
        assert!(Instant::now() < deadline, "the CLI never started");
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(job); // KILL_ON_JOB_CLOSE: everything still in the job ends now.
    std::thread::sleep(Duration::from_secs(6));
    let alive = PathBuf::from(format!("{}.alive", out.display())).exists();
    let log = fs::read_to_string(root.join("cli").join("data").join("logs").join("launch.log")).unwrap_or_default();
    (alive, log)
}

#[test]
fn the_cli_outlives_a_job_that_allows_breakaway() {
    let (alive, log) = cli_outlives(true);
    assert!(alive, "the CLI ended with the launcher's job; launch.log: {log}");
    assert!(log.is_empty(), "{log}");
}

#[test]
fn a_job_that_refuses_breakaway_keeps_the_cli_and_the_log_says_so() {
    let (alive, log) = cli_outlives(false);
    assert!(!alive, "the CLI could only start inside the job, and ended with it");
    assert!(log.contains("starts inside the job"), "{log}");
}
