//! A Windows Job Object: one per pane child, so the child and everything it starts can be listed
//! (`jobPids`) and ended together, as a Unix pane's process group is.
//!
//! The job is kill-on-close, and only the host holds its handle (created not inheritable, so no
//! child gets a copy): when the host dies, every pane's tree dies with it, as a tmux server's
//! panes do when it crashes (spec §4). Without it, a shell still starting when the host died
//! could outlive the host with its console, unreachable (Task 17). The vendored ConPTY spawn puts
//! the child in the job while it is still suspended (`alacritty_terminal::tty::Options::job`).
//!
//! The job also allows **explicit** breakaway (`JOB_OBJECT_LIMIT_BREAKAWAY_OK`), and only that:
//! a pane's tree stays whole unless a program inside it asks with `CREATE_BREAKAWAY_FROM_JOB`.
//! Without the flag Windows refuses that request with `ERROR_ACCESS_DENIED`, and an engine that
//! starts a long-lived helper of its own dies at once — Hermes exits 2 with
//! `Gateway inaccessible: windows_breakaway_unavailable` on DESKTOP-0TFH0OJ (2026-11-09), because
//! its gateway daemon is spawned with breakaway. What is given up: a process that breaks away on
//! purpose is no longer listed by `pids()` and is not ended by `end()` — which is exactly what
//! asking to outlive the pane means.
//!
//! A pane whose program is a Cygwin/MSYS one (Git Bash) is the exception, and gets no
//! `BREAKAWAY_OK` (`breakaway_allowed`): Cygwin reads that flag off a foreign job and then passes
//! `CREATE_BREAKAWAY_FROM_JOB` to every child it starts (`setup_user_rlimits`, winsup/cygwin/
//! resource.cc, read 2026-11-09), so an ordinary `sleep 30` in a Git Bash pane would leave the job
//! — `pids()` would stop listing it and `end()` would stop ending it.

use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, GetLastError};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject,
};

/// How often `end` looks whether the job is empty.
const POLL: Duration = Duration::from_millis(50);

/// Whether [program]'s job may allow explicit breakaway: not when it is a Cygwin/MSYS one.
///
/// Cygwin keeps its own per-user rlimits job, and to join it from a foreign job it must break away;
/// so it reads `BREAKAWAY_OK` off the job it was started in and, when it is set, passes
/// `CREATE_BREAKAWAY_FROM_JOB` to **every** child it starts (`setup_user_rlimits`,
/// winsup/cygwin/resource.cc). In a Harness pane that would take an ordinary `npm run dev` out of
/// the pane's job: `jobPids` would stop listing it and `end()` would stop ending it.
pub fn breakaway_allowed(program: &str) -> bool {
    match on_path(program) {
        Some(file) => !beside_cygwin_dll(&file),
        // Not on PATH: whichever program Windows finds, it is not one this check can see.
        None => true,
    }
}

/// Whether a Cygwin/MSYS DLL sits beside [program] or in the `usr\bin` beside it, as Git for
/// Windows lays them out (`bin\bash.exe`, the DLL in `usr\bin`).
fn beside_cygwin_dll(program: &std::path::Path) -> bool {
    let Some(dir) = program.parent().filter(|dir| !dir.as_os_str().is_empty()) else {
        return false;
    };
    ["msys-2.0.dll", "cygwin1.dll"].iter().any(|dll| {
        dir.join(dll).is_file() || dir.join("..").join("usr").join("bin").join(dll).is_file()
    })
}

/// [program] as the path Windows would run: itself when it names a path, else the first match on
/// `PATH`.
fn on_path(program: &str) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(program);
    if path.components().count() > 1 {
        return Some(path.to_path_buf());
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

pub struct Job(OwnedHandle);

impl Job {
    /// A new, unnamed job that ends its processes when its last handle closes, and that lets a
    /// process inside it break away when it asks. Its handle is not inheritable (no security
    /// attributes), so only the host has one.
    pub fn new() -> io::Result<Job> {
        Job::with_breakaway(true)
    }

    /// The job for the program [program] (its path or bare name): breakaway except for a
    /// Cygwin/MSYS one, which takes it for every child (`breakaway_allowed`).
    pub fn for_program(program: &str) -> io::Result<Job> {
        Job::with_breakaway(breakaway_allowed(program))
    }

    fn with_breakaway(breakaway: bool) -> io::Result<Job> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Job(unsafe { OwnedHandle::from_raw_handle(handle as _) });
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | if breakaway {
                JOB_OBJECT_LIMIT_BREAKAWAY_OK
            } else {
                0
            };
        let ok = unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle() as _,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// The job's raw `HANDLE`, for `Options::job`; valid while the `Job` lives.
    pub fn handle(&self) -> isize {
        self.0.as_raw_handle() as isize
    }

    /// The ids of the processes in the job now.
    pub fn pids(&self) -> io::Result<Vec<u32>> {
        let header = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
        let word = std::mem::size_of::<usize>();
        let mut room = 16usize;
        loop {
            // `usize` words, so the list is aligned as the struct is.
            let mut buf = vec![0usize; header.div_ceil(word) + room];
            let size = (buf.len() * word) as u32;
            let ok = unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle() as _,
                    JobObjectBasicProcessIdList,
                    buf.as_mut_ptr().cast(),
                    size,
                    std::ptr::null_mut(),
                )
            };
            let list = unsafe { &*buf.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
            let assigned = list.NumberOfAssignedProcesses as usize;
            if ok == 0 {
                if unsafe { GetLastError() } != ERROR_MORE_DATA {
                    return Err(io::Error::last_os_error());
                }
            } else if list.NumberOfProcessIdsInList as usize >= assigned {
                let ids = unsafe {
                    std::slice::from_raw_parts(
                        buf.as_ptr().cast::<u8>().add(header).cast::<usize>(),
                        list.NumberOfProcessIdsInList as usize,
                    )
                };
                return Ok(ids.iter().map(|&id| id as u32).collect());
            }
            // More processes than room (some may start before the next call): grow past them.
            room = (assigned + 8).max(room * 2);
        }
    }

    /// End every process in the job with exit code `code`.
    pub fn terminate(&self, code: u32) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0.as_raw_handle() as _, code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Terminate whatever is in the job now (exit code 1); a failure is logged.
    pub fn end_now(&self) {
        if let Err(err) = self.terminate(1) {
            log::error!("job: terminate failed: {err}");
        }
    }

    /// Wait up to `grace` for the job to empty, then terminate whatever is left (exit code 1).
    pub fn end(&self, grace: Duration) {
        let deadline = Instant::now().checked_add(grace);
        loop {
            if matches!(self.pids(), Ok(pids) if pids.is_empty()) {
                return;
            }
            let left = deadline.map_or(POLL, |d| d.saturating_duration_since(Instant::now()));
            if left.is_zero() {
                self.end_now();
                return;
            }
            std::thread::sleep(left.min(POLL));
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn a_new_job_is_empty_and_terminating_it_is_harmless() {
        let job = Job::new().unwrap();
        assert_ne!(job.handle(), 0);
        assert_eq!(job.pids().unwrap(), Vec::<u32>::new());
        job.terminate(1).unwrap();
        let start = Instant::now();
        job.end(Duration::from_secs(5));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    /// A child that cannot join its job never runs: the spawn fails.
    #[test]
    fn a_job_kills_on_close_and_its_handle_is_the_hosts_alone() {
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
        use windows_sys::Win32::System::JobObjects::QueryInformationJobObject;
        let job = Job::new().unwrap();
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            QueryInformationJobObject(
                job.handle() as _,
                JobObjectExtendedLimitInformation,
                (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(ok, 0, "{}", io::Error::last_os_error());
        assert_eq!(
            limits.BasicLimitInformation.LimitFlags,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK
        );
        // Not inheritable: no child of the host gets a handle that would keep the job open.
        let mut flags = 0u32;
        assert_ne!(
            unsafe { GetHandleInformation(job.handle() as _, &mut flags) },
            0
        );
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
    }

    /// The limit flags a job reports, as `QueryInformationJobObject` gives them.
    fn limit_flags(job: &Job) -> u32 {
        use windows_sys::Win32::System::JobObjects::QueryInformationJobObject;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            QueryInformationJobObject(
                job.handle() as _,
                JobObjectExtendedLimitInformation,
                (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(ok, 0, "{}", io::Error::last_os_error());
        limits.BasicLimitInformation.LimitFlags
    }

    /// A Git Bash pane keeps its tree: Cygwin passes breakaway to every child it starts, so the
    /// flag is left off there and an ordinary background job stays in the job.
    #[test]
    fn a_cygwin_root_gets_no_breakaway() {
        // A directory laid out as Git for Windows lays it out: bin\bash.exe, DLL in usr\bin.
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(dir.path().join("usr").join("bin")).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let bash = bin.join("bash.exe");
        std::fs::write(&bash, b"").unwrap();
        std::fs::write(dir.path().join("usr").join("bin").join("msys-2.0.dll"), b"").unwrap();

        let job = Job::for_program(bash.to_str().unwrap()).unwrap();
        assert_eq!(limit_flags(&job), JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);

        // A native shell keeps the flag: its own children are not asked to break away.
        let cmd = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        assert_eq!(
            limit_flags(&Job::for_program(&cmd).unwrap()),
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK
        );
    }

    #[test]
    fn a_child_that_cannot_join_the_job_never_runs() {
        use alacritty_terminal::tty::{self, Options, Shell};
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let options = Options {
            shell: Some(Shell::new(
                "cmd.exe".into(),
                vec!["/c".into(), format!("type nul > {}", marker.display())],
            )),
            working_directory: None,
            env: Default::default(),
            drain_on_exit: true,
            escape_args: false,
            job: Some(0), // not a job
            env_remove: Vec::new(),
        };
        let size = alacritty_terminal::event::WindowSize {
            num_lines: 24,
            num_cols: 80,
            cell_width: 1,
            cell_height: 1,
        };
        assert!(tty::new(&options, size, 0).is_err());
        std::thread::sleep(Duration::from_secs(1));
        assert!(!marker.exists(), "the child ran");

        // The same child in a real job runs.
        let job = Job::new().unwrap();
        let options = Options {
            job: Some(job.handle()),
            ..options
        };
        let pty = tty::new(&options, size, 0).unwrap();
        let end = Instant::now() + Duration::from_secs(10);
        while !marker.exists() {
            assert!(Instant::now() < end, "the child never ran");
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(pty);
    }

    #[test]
    fn job_lists_children_and_terminates_tree() {
        let (tx, _rx) = std::sync::mpsc::channel();
        // cmd starts a child powershell that sleeps; both must be in the job.
        let pane = crate::pane::Pane::spawn(
            "%1".into(),
            crate::pane::PaneSpec {
                command: vec![
                    "cmd.exe".into(),
                    "/c".into(),
                    "powershell -NoProfile -Command Start-Sleep 30".into(),
                ],
                cwd: None,
                env: Default::default(),
                cols: 80,
                rows: 24,
                clear_env: Vec::new(),
                seed: None,
            },
            1000,
            tx,
        )
        .unwrap();
        let end = Instant::now() + Duration::from_secs(10);
        while pane.job_pids().unwrap().len() < 2 {
            assert!(Instant::now() < end);
            std::thread::sleep(Duration::from_millis(100))
        }
        assert!(pane.job_pids().unwrap().contains(&pane.root_pid().unwrap()));
        pane.kill(Duration::from_millis(200));
        let end = Instant::now() + Duration::from_secs(5);
        while !pane.job_pids().unwrap().is_empty() {
            assert!(Instant::now() < end);
            std::thread::sleep(Duration::from_millis(50))
        }
    }
}
