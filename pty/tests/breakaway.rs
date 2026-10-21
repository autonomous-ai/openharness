//! Windows: a host started inside a Job Object serves from a copy of itself started outside it,
//! or, when the job refuses the breakaway (a Harness pane's job does), from a detached copy that
//! stays in the job.
#![cfg(windows)]
mod common;
use common::{WAIT, call, connect, kill_pid, wait_discovery};
use std::io::{BufRead, BufReader};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, OpenProcess, OpenThread, PROCESS_QUERY_LIMITED_INFORMATION, ResumeThread,
    THREAD_SUSPEND_RESUME,
};

/// A job that kills its processes when its handle closes, as a daemon's job might, with or
/// without `BREAKAWAY_OK`.
fn job(breakaway_ok: bool) -> OwnedHandle {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        assert!(!job.is_null());
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | if breakaway_ok {
                JOB_OBJECT_LIMIT_BREAKAWAY_OK
            } else {
                0
            };
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

/// Resume every thread of the suspended process `pid`.
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

fn in_job(pid: u32, job: &OwnedHandle) -> bool {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        assert!(
            !process.is_null(),
            "{pid}: {}",
            std::io::Error::last_os_error()
        );
        let mut result = 0;
        let ok = IsProcessInJob(process, job.as_raw_handle() as HANDLE, &mut result);
        CloseHandle(process);
        assert_ne!(ok, 0);
        result != 0
    }
}

/// Start `serve` in `job`: it is put in the job while suspended, so it starts there.
fn serve_in(job: &OwnedHandle, home: &std::path::Path) -> (std::process::Child, serde_json::Value) {
    let mut child = common::host_command(home)
        .creation_flags(CREATE_SUSPENDED)
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let ok = unsafe {
        AssignProcessToJobObject(
            job.as_raw_handle() as HANDLE,
            child.as_raw_handle() as HANDLE,
        )
    };
    assert_ne!(ok, 0, "{}", std::io::Error::last_os_error());
    resume(child.id());
    let disc = wait_discovery(home);
    // The host started first leaves the serving to its copy, and exits with success.
    let end = Instant::now() + WAIT;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < end, "the first host did not exit");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "{status}");
    assert_ne!(disc["pid"], child.id());
    (child, disc)
}

/// What the host (and its copy) wrote to stderr within a moment: its log lines. (The copy
/// inherits stderr, so the pipe stays open while it runs: no reading to the end.)
fn first_lines(stderr: std::process::ChildStderr) -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let end = Instant::now() + Duration::from_secs(2);
    let mut lines = Vec::new();
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(line) => lines.push(line),
            Err(_) => break,
        }
    }
    lines.join("\n")
}

fn answers(disc: &serde_json::Value) {
    let (mut w, mut r) = connect(disc);
    assert_eq!(
        call(&mut w, &mut r, r#"{"id":1,"op":"titles"}"#)["ok"],
        true
    );
}

#[test]
fn a_host_in_a_job_that_refuses_breakaway_serves_from_a_detached_copy_in_it() {
    // A Harness pane's job: no BREAKAWAY_OK.
    let job = job(false);
    let home = tempfile::tempdir().unwrap();
    let (mut child, disc) = serve_in(&job, home.path());
    let pid = disc["pid"].as_u64().unwrap() as u32;
    let stderr = first_lines(child.stderr.take().unwrap());
    assert!(
        stderr
            .lines()
            .any(|line| line.contains(" WARN ") && line.contains("stays in the job")),
        "{stderr}"
    );
    // The copy is in the job (it could not leave), and serves.
    assert!(in_job(pid, &job));
    answers(&disc);
    // It ends with the job, as the warning said.
    drop(job);
    let end = Instant::now() + WAIT;
    while common::open(disc["endpoint"].as_str().unwrap()).is_ok() {
        assert!(Instant::now() < end, "the host outlived its job");
        std::thread::sleep(Duration::from_millis(50));
    }
    kill_pid(pid);
}

#[test]
fn a_host_in_a_job_that_allows_breakaway_serves_from_a_copy_outside_it() {
    let job = job(true);
    let home = tempfile::tempdir().unwrap();
    let (mut child, disc) = serve_in(&job, home.path());
    let pid = disc["pid"].as_u64().unwrap() as u32;
    // No warning: it broke away. (Even when this test runs inside a job of its own, an SSH
    // session's or a CI runner's, that does not allow breakaway: the job left is the nearest.)
    let stderr = first_lines(child.stderr.take().unwrap());
    assert!(stderr.contains("serving"), "{stderr}");
    assert!(!stderr.contains(" WARN "), "{stderr}");
    // The copy is out of the job, and closing the job (which kills what is in it) leaves it.
    assert!(!in_job(pid, &job));
    drop(job);
    std::thread::sleep(Duration::from_millis(300));
    answers(&disc);
    kill_pid(pid);
}
