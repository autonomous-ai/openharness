//! A child on unix: its own process group, a non-blocking stdin, and how it ended.

use crate::cli::{Unwritten, spawn_lock};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, ExitStatus};

/// A started child and everything it starts: its process group, whose id is the child's pid.
#[derive(Clone)]
pub(crate) struct Group(libc::pid_t);

/// Starts `command` in a process group of its own.
pub(crate) fn spawn(command: &mut Command) -> io::Result<(Child, Group)> {
    command.process_group(0);
    let child = {
        let _spawning = spawn_lock();
        command.spawn()?
    };
    let group = Group(child.id() as libc::pid_t);
    Ok((child, group))
}

impl Group {
    /// Blocks until the child has exited, and leaves it unreaped: until it is reaped neither its pid nor its group
    /// can be another's.
    pub(crate) fn exited(&self) {
        // SAFETY: waitid writes only the siginfo it is handed, which zeroes are a valid value of.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        while unsafe { libc::waitid(libc::P_PID, self.0 as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) } == -1
            && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted
        {}
    }

    /// SIGKILL to the child and everything it started in its group.
    pub(crate) fn kill(&self) {
        // SAFETY: kill only sends a signal; callers hold an unreaped child's group, whose id is its pid.
        unsafe { libc::kill(-self.0, libc::SIGKILL) };
    }

    /// The child's exit code; `None`: it was killed (ended by a signal).
    pub(crate) fn code(&self, status: ExitStatus) -> Option<i32> {
        status.code()
    }
}

/// A child's stdin, which never waits: a write to a full pipe is `Unwritten::Full`.
pub(crate) struct Stdin(ChildStdin);

impl Stdin {
    pub(crate) fn new(pipe: ChildStdin) -> Stdin {
        // SAFETY: fcntl only reads and sets the flags of the pipe this child's handle owns.
        unsafe {
            let flags = libc::fcntl(pipe.as_raw_fd(), libc::F_GETFL);
            libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        Stdin(pipe)
    }

    /// The text and a newline.
    pub(crate) fn line(&mut self, text: &str) -> Result<(), Unwritten> {
        self.0.write_all(format!("{text}\n").as_bytes()).map_err(|error| match error.kind() {
            io::ErrorKind::WouldBlock => Unwritten::Full,
            _ => Unwritten::Closed,
        })
    }
}
