//! A child on Windows: a job that holds what it starts, a queued stdin, and how it ended.

use crate::cli::spawn_lock;
use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, ExitStatus};
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, WAIT_TIMEOUT};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, INFINITE, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME, WaitForSingleObject,
};

/// A child's stdin, which never waits: a line past those queued is `Unwritten::Full`.
pub(crate) use crate::stdin_queue::Queue as Stdin;

/// A console no one sees, which the console programs the child starts share, and suspended until it is in its job.
/// Never DETACHED_PROCESS: a child with no console at all gives each console program it starts a window of its own.
pub(crate) const CREATION_FLAGS: u32 = CREATE_NO_WINDOW | CREATE_SUSPENDED;

/// A started child and everything it starts: a job of its own. The job closes with the last clone, and ends what is
/// still in it then.
#[derive(Clone)]
pub(crate) struct Group(Arc<Job>);

struct Job {
    job: OwnedHandle,
    /// The child's handle, apart from std's, so a wait on it never outlives it, nor its pid another's.
    process: OwnedHandle,
    /// The group ended the child, which has no code then.
    killed: AtomicBool,
}

/// Starts `command` in a job of its own before it runs: suspended, put in the job, then resumed. The job lets a process
/// leave when it asks (the daemon: harness-launch.exe starts it with CREATE_BREAKAWAY_FROM_JOB), and nothing else.
pub(crate) fn spawn(command: &mut Command) -> io::Result<(Child, Group)> {
    let job = job()?;
    command.creation_flags(CREATION_FLAGS);
    let mut child = {
        let _spawning = spawn_lock();
        command.spawn()?
    };
    let group = child.as_handle().try_clone_to_owned().and_then(|process| {
        // SAFETY: both handles are open: the job's and the child's.
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        resume(child.id())?;
        Ok(Group(Arc::new(Job { job, process, killed: AtomicBool::new(false) })))
    });
    match group {
        Ok(group) => Ok((child, group)),
        Err(error) => {
            // It never ran: nothing of it is left.
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

/// A job that ends what is in it when it closes, and lets a process leave when it asks. Its handle is not inheritable
/// (no security attributes), so no child holds it open.
fn job() -> io::Result<OwnedHandle> {
    // SAFETY: null attributes and name ask for an unnamed job; nothing is kept of them.
    let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a new handle, which nothing else owns.
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: the limits are read during the call only, at the size given.
    let set = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            ptr::from_ref(&limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if set == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

/// Resumes the suspended process `pid`: each of its threads once, as a thread something else put in it may be listed
/// before the one suspended at its start; a thread that runs is left as it is. std's handle to that thread is not
/// public (`ChildExt::main_thread_handle` is unstable), so the threads are found in a snapshot of the system's threads.
/// One that cannot be resumed (it has ended since) is passed over; none resumed is an error.
fn resume(pid: u32) -> io::Result<()> {
    // SAFETY: a snapshot of every thread, closed by its OwnedHandle below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a new handle, which nothing else owns.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry = THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
    let (mut resumed, mut failed) = (false, None);
    // SAFETY: entry is a THREADENTRY32 with its size set, which each call fills.
    let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            match resume_thread(entry.th32ThreadID) {
                Ok(was_suspended) => resumed |= was_suspended,
                Err(error) => failed = Some(error),
            }
        }
        // SAFETY: as Thread32First.
        more = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    if resumed { Ok(()) } else { Err(failed.unwrap_or_else(|| io::ErrorKind::NotFound.into())) }
}

/// Resumes the thread `id` once; true when it was suspended.
fn resume_thread(id: u32) -> io::Result<bool> {
    // SAFETY: OpenThread only opens a handle, which OwnedHandle closes.
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, id) };
    if thread.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a new handle, which nothing else owns.
    let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
    // SAFETY: the handle is open, with the right to resume.
    match unsafe { ResumeThread(thread.as_raw_handle()) } {
        u32::MAX => Err(io::Error::last_os_error()),
        // The count it had: 0 for a thread that runs, which stays as it is.
        count => Ok(count > 0),
    }
}

impl Group {
    /// Blocks until the child has exited. The group holds its handle, so until the group goes its pid is not another's.
    pub(crate) fn exited(&self) {
        // SAFETY: the handle is open while the group lives.
        unsafe { WaitForSingleObject(self.0.process.as_raw_handle(), INFINITE) };
    }

    /// Ends the job: the child and everything it started, but what left the job.
    pub(crate) fn kill(&self) {
        // SAFETY: the handles are open while the group lives.
        unsafe {
            // A child that has exited by itself keeps its code, as an unreaped one does on unix; what it left in the
            // job ends all the same.
            if WaitForSingleObject(self.0.process.as_raw_handle(), 0) == WAIT_TIMEOUT {
                self.0.killed.store(true, Ordering::SeqCst);
            }
            // The code the job's processes get is never read: `code` answers None.
            TerminateJobObject(self.0.job.as_raw_handle(), 1);
        }
    }

    /// The child's exit code; `None`: this group ended it, as a signal does on unix.
    pub(crate) fn code(&self, status: ExitStatus) -> Option<i32> {
        status.code().filter(|_| !self.0.killed.load(Ordering::SeqCst))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{CreateThread, THREAD_CREATE_SUSPENDED};

    unsafe extern "system" fn returns(_: *mut c_void) -> u32 {
        0
    }

    #[test]
    fn resume_starts_a_suspended_thread_listed_after_running_ones() {
        // This test process stands for a suspended child that something else put a thread in first: a thread that
        // runs is listed before the suspended one, and resume must not stop at it.
        // SAFETY: a suspended thread of this process that only returns; OwnedHandle closes its handle.
        let thread = unsafe {
            CreateThread(ptr::null(), 0, Some(returns), ptr::null(), THREAD_CREATE_SUSPENDED, ptr::null_mut())
        };
        assert!(!thread.is_null(), "{}", io::Error::last_os_error());
        // SAFETY: a new handle, which nothing else owns.
        let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
        resume(std::process::id()).unwrap();
        // SAFETY: the handle is open while `thread` lives.
        assert_eq!(unsafe { WaitForSingleObject(thread.as_raw_handle(), 5_000) }, WAIT_OBJECT_0);
    }
}
