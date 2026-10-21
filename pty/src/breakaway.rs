//! Windows: a host started inside a Job Object starts a copy of itself outside it, so the job
//! (the daemon's, say, killed on close) cannot take the host and its panes with it.
//!
//! The copy is started with `CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS |
//! CREATE_NEW_PROCESS_GROUP`, and the host started first exits 0. A job that does not allow
//! breakaway refuses that (`ERROR_ACCESS_DENIED`): a Harness pane's job is one (no
//! `BREAKAWAY_OK`), and a daemon run from a pane starts its host inside it. Then the copy is
//! started without breakaway, still detached from the console and its Ctrl+C, with a warning:
//! the host stays in the job and may end with it (harnessd, sub-project B, starts the host
//! outside any job in production). When no copy can be started at all, this process serves.
//!
//! The copy gets `--no-reexec`, so a copy still in a job (one that could not break away) does
//! not start copies of its own.

use std::io;

pub const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
pub const DETACHED_PROCESS: u32 = 0x0000_0008;
pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// What became of the job the host started in.
#[derive(Debug, PartialEq, Eq)]
pub enum Left {
    /// It was in none: this process serves.
    NotInJob,
    /// A copy outside the job serves; this process exits.
    BrokeAway,
    /// The job refused the breakaway: a detached copy, still in the job, serves; this process
    /// exits.
    Detached,
    /// No copy could be started: this process serves, in the job.
    Stayed,
}

/// Leave the job when `in_job`: `spawn(flags)` starts the copy with those creation flags, and
/// `warn` says what could not be done.
pub fn leave_job(
    in_job: bool,
    mut spawn: impl FnMut(u32) -> io::Result<()>,
    mut warn: impl FnMut(String),
) -> Left {
    if !in_job {
        return Left::NotInJob;
    }
    let detached = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    match spawn(CREATE_BREAKAWAY_FROM_JOB | detached) {
        Ok(()) => return Left::BrokeAway,
        Err(err) => warn(format!(
            "the job this host was started in does not let it break away ({err}): the host stays \
             in the job, and may end with it"
        )),
    }
    match spawn(detached) {
        Ok(()) => Left::Detached,
        Err(err) => {
            warn(format!(
                "could not start a detached host ({err}): serving from this process"
            ));
            Left::Stayed
        }
    }
}

/// Whether this process is in a job.
#[cfg(windows)]
pub fn in_job() -> io::Result<bool> {
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut result = 0;
    if unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut result) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(result != 0)
}

/// Start this program again with `args` and the creation `flags`; it inherits only stderr.
#[cfg(windows)]
pub fn spawn_copy(args: &[std::ffi::OsString], flags: u32) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    Command::new(std::env::current_exe()?)
        .args(args)
        .creation_flags(flags)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DENIED: i32 = 5; // ERROR_ACCESS_DENIED

    fn run(in_job: bool, results: &[Option<i32>]) -> (Left, Vec<u32>, Vec<String>) {
        let mut flags = Vec::new();
        let mut warnings = Vec::new();
        let mut results = results.iter();
        let left = leave_job(
            in_job,
            |f| {
                flags.push(f);
                match results.next().expect("one spawn too many") {
                    None => Ok(()),
                    Some(code) => Err(io::Error::from_raw_os_error(*code)),
                }
            },
            |w| warnings.push(w),
        );
        (left, flags, warnings)
    }

    const DETACHED: u32 = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;

    #[test]
    fn outside_a_job_nothing_is_started() {
        assert_eq!(run(false, &[]), (Left::NotInJob, vec![], vec![]));
    }

    #[test]
    fn a_job_that_allows_it_is_left() {
        let (left, flags, warnings) = run(true, &[None]);
        assert_eq!(left, Left::BrokeAway);
        assert_eq!(flags, [CREATE_BREAKAWAY_FROM_JOB | DETACHED]);
        assert!(warnings.is_empty());
    }

    #[test]
    fn a_job_that_refuses_gets_a_detached_copy_and_a_warning() {
        // A Harness pane's job has no BREAKAWAY_OK: the daemon in a pane starts its host there.
        let (left, flags, warnings) = run(true, &[Some(DENIED), None]);
        assert_eq!(left, Left::Detached);
        assert_eq!(flags, [CREATE_BREAKAWAY_FROM_JOB | DETACHED, DETACHED]);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("stays in the job"), "{warnings:?}");
    }

    #[test]
    fn when_no_copy_starts_this_process_serves() {
        let (left, flags, warnings) = run(true, &[Some(DENIED), Some(DENIED)]);
        assert_eq!(left, Left::Stayed);
        assert_eq!(flags.len(), 2);
        assert_eq!(warnings.len(), 2);
        assert!(
            warnings[1].contains("serving from this process"),
            "{warnings:?}"
        );
    }
}
