//! A local shell's pseudoconsole on Windows, for ./local.rs. Its reader and writer signal through a `polling::Poller`, not a
//! file descriptor tokio can watch, so one thread owns the console and is told what to do. A Job Object holds the shell and all
//! it starts: closing it ends them, as signalling a process group does elsewhere.

use std::collections::VecDeque;
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use alacritty_terminal::event::{OnResize, WindowSize};
use alacritty_terminal::tty::{self, EventedReadWrite};
use polling::{Event as PollEvent, Events, PollMode, Poller};
use tokio::sync::mpsc;
use uuid::Uuid;
use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW, WaitForSingleObject,
};

use super::Event;

enum Control { Input(Vec<u8>), Resize(WindowSize), Close }

/// One shell's console, by way of the thread that owns it.
pub struct Pty {
    control: std_mpsc::Sender<Control>,
    poller: Arc<Poller>,
    pid: u32,
    process: OwnedHandle,
    /// Dropped last: its close ends whatever the shell left running.
    job: OwnedHandle,
}

impl Pty {
    pub fn pid(&self) -> u32 { self.pid }

    fn tell(&self, what: Control) {
        if self.control.send(what).is_ok() { let _ = self.poller.notify(); }
    }

    /// How the shell ended, once it has.
    pub fn exited(&self) -> Option<crate::pane::Exit> {
        let process = self.process.as_raw_handle() as HANDLE;
        // SAFETY: a process handle this value owns; a zero wait does not block.
        unsafe {
            if WaitForSingleObject(process, 0) != WAIT_OBJECT_0 { return None }
            let mut code = 0u32;
            let status = (GetExitCodeProcess(process, &mut code) != 0).then_some(code as i32);
            Some(crate::pane::Exit { id: Uuid::new_v4().to_string(), status, signal: None,
                time: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64 })
        }
    }

    /// Ends it and all it started.
    pub fn end(self) {
        self.tell(Control::Close);
        drop(self.process);
        drop(self.job);
    }
}

impl OnResize for Pty {
    fn on_resize(&mut self, size: WindowSize) { self.tell(Control::Resize(size)); }
}

fn new_job() -> io::Result<OwnedHandle> {
    // SAFETY: an unnamed job; the limit structure outlives the call, and OwnedHandle closes the job.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() { return Err(io::Error::last_os_error()) }
        let owned = OwnedHandle::from_raw_handle(job as _);
        let mut limit: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&raw const limit).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 {
            return Err(io::Error::last_os_error())
        }
        Ok(owned)
    }
}

pub struct Spawn {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub size: WindowSize,
}

/// Starts [spawn] on a console of its own, with the thread that owns the console. Its output and end go to [events].
pub fn start(spawn: Spawn, id: String, generation: Uuid, mut input: mpsc::UnboundedReceiver<Vec<u8>>, events: mpsc::Sender<Event>) -> io::Result<(Pty, tokio::task::JoinHandle<()>)> {
    let job = new_job()?;
    let env_remove = std::env::vars_os().filter_map(|(key, _)| key.into_string().ok()).filter(|key| !spawn.env.keys().any(|set| set.eq_ignore_ascii_case(key))).collect();
    let options = tty::Options { shell: Some(tty::Shell::new(spawn.program, spawn.args)), working_directory: Some(spawn.cwd), env: spawn.env, drain_on_exit: true,
        escape_args: true, job: Some(job.as_raw_handle() as isize), env_remove };
    let size = spawn.size;
    let poller = Arc::new(Poller::new()?);
    let (control, controls) = std_mpsc::channel();
    let (ready, started) = std_mpsc::channel();
    let thread_poller = poller.clone();
    std::thread::spawn(move || own_console(options, size, thread_poller, controls, ready, id, generation, events));
    let pid = started.recv().map_err(|_| io::Error::other("the shell's console did not start"))??;
    // SAFETY: the pid of a process the console holds open, so it cannot be another's yet; OwnedHandle closes this one.
    let process = unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid);
        if process.is_null() { return Err(io::Error::last_os_error()) }
        OwnedHandle::from_raw_handle(process as _)
    };
    // Input arrives on the app's channel; this wakes the thread for it.
    let (forward, forward_poller) = (control.clone(), poller.clone());
    let reader = tokio::spawn(async move {
        while let Some(bytes) = input.recv().await {
            if forward.send(Control::Input(bytes)).is_err() { break }
            let _ = forward_poller.notify();
        }
    });
    Ok((Pty { control, poller, pid, process, job }, reader))
}

#[allow(clippy::too_many_arguments)]
fn own_console(options: tty::Options, size: WindowSize, poller: Arc<Poller>, controls: std_mpsc::Receiver<Control>, ready: std_mpsc::Sender<io::Result<u32>>, id: String, generation: Uuid, events: mpsc::Sender<Event>) {
    let mut pty = match tty::new(&options, size, 0) {
        Ok(pty) => pty,
        Err(error) => { let _ = ready.send(Err(error)); return }
    };
    let Some(pid) = pty.child_watcher().pid().map(|pid| pid.get()) else { let _ = ready.send(Err(io::Error::other("the shell did not start"))); return };
    // SAFETY: the poller outlives the console, and the console is dropped on this thread.
    if let Err(error) = unsafe { pty.register(&poller, PollEvent::all(0), PollMode::Level) } { let _ = ready.send(Err(error)); return }
    let _ = ready.send(Ok(pid));
    let mut queue: VecDeque<Vec<u8>> = VecDeque::new();
    let mut offset = 0;
    let mut bytes = vec![0; 32 * 1024];
    let mut seen = Events::new();
    'console: loop {
        seen.clear();
        // Nothing is lost by a wait that ends early; the timeout only bounds how late a close is seen.
        let _ = poller.wait(&mut seen, Some(Duration::from_millis(250)));
        loop {
            match controls.try_recv() {
                Ok(Control::Input(input)) => if !input.is_empty() { queue.push_back(input) },
                Ok(Control::Resize(size)) => pty.on_resize(size),
                Ok(Control::Close) | Err(std_mpsc::TryRecvError::Disconnected) => break 'console,
                Err(std_mpsc::TryRecvError::Empty) => break,
            }
        }
        loop {
            match pty.reader().read(&mut bytes) {
                Ok(0) => break 'console,
                Ok(n) => if events.blocking_send(Event::Output(id.clone(), generation, bytes[..n].to_vec())).is_err() { return },
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(_) => break 'console,
            }
        }
        while let Some(front) = queue.front() {
            match pty.writer().write(&front[offset..]) {
                Ok(0) => break 'console,
                Ok(n) => { offset += n; if offset == front.len() { queue.pop_front(); offset = 0; } }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(_) => break 'console,
            }
        }
    }
    let _ = events.blocking_send(Event::Eof(id, generation));
}

/// The program's file name, for `terminal_info`.
pub fn process_name(pid: u32) -> Option<String> {
    // SAFETY: the handle is checked and closed by OwnedHandle; the buffer is as long as said.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() { return None }
        let process = OwnedHandle::from_raw_handle(process as _);
        let mut path = [0u16; 1024];
        let mut length = path.len() as u32;
        if QueryFullProcessImageNameW(process.as_raw_handle() as HANDLE, 0, path.as_mut_ptr(), &mut length) == 0 { return None }
        let path = String::from_utf16_lossy(&path[..length as usize]);
        Some(crate::sys::shell_label(&path).to_string())
    }
}
