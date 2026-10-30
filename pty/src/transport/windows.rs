//! The named pipe `\\.\pipe\harness-pty-<hash>-<random>-<instance>`, open to its owner only.
//!
//! - The name hashes the user's SID and the canonical home, so each user and each home has its
//!   own pipe, and a long home path cannot make the name too long.
//! - Each host start adds 16 random hex digits, so no other process can guess the name and create
//!   the pipe before the host does. A process of another user could otherwise wait on it for the
//!   daemon: the hello's proof keeps such a squatter from passing for the host, but Node's pipe
//!   client (libuv's `CreateFileW`) cannot ask for `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`,
//!   so the squatter could impersonate the daemon on the connection. The name is no secret once the
//!   host runs (anyone can list `\\.\pipe\`): after the host dies its name could be taken over, so
//!   the daemon never dials the endpoint of a host proven dead (cli/src/lib/ptyHost/launch.ts
//!   `discoveredHostDead`), and connects only to the endpoint the discovery file names. One host per
//!   home is the home's lock (`host_lock`), not the name.
//! - The first instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`: when another process
//!   already has the name, creating it fails with `ERROR_ACCESS_DENIED` (`Bound::Taken`).
//! - Every instance has the DACL `D:P(A;;GA;;;<user SID>)`: only the user can connect, and
//!   `PIPE_REJECT_REMOTE_CLIENTS` keeps the network out.
//! - A connection's reader and writer are separate threads on one pipe handle. A synchronous
//!   handle serializes its I/O (a blocked read would hold up every write), so the handle is
//!   overlapped and each read or write waits for its own completion. That is also how a read
//!   times out and how `shutdown` wakes a blocked read or write (`CancelIoEx`).

use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_BROKEN_PIPE, ERROR_INSUFFICIENT_BUFFER,
    ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY,
    ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, GetLastError,
    HANDLE, INVALID_HANDLE_VALUE, LocalFree, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    SetFileSecurityW, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL,
    FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS, PIPE_ACCESS_DUPLEX, ReadFile,
    SECURITY_IDENTIFICATION, SYNCHRONIZE, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, WaitNamedPipeW,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, INFINITE, OpenProcessToken, ResetEvent, WaitForSingleObject,
};

use super::{Bound, Connection, Listener};

/// Each direction's pipe buffer.
const BUFFER: u32 = 64 * 1024;
/// How long `connect` waits for a free instance while the host is between accepts.
const BUSY_WAIT: Duration = Duration::from_secs(5);

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// `\\.\pipe\harness-pty-<16 hex of SHA-256(sid + "\0" + home)>-<suffix>-<instance>`.
pub fn pipe_name(user_sid: &str, canonical_home: &str, suffix: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(user_sid.as_bytes());
    hash.update([0]);
    hash.update(canonical_home.as_bytes());
    let digest = hash.finalize();
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!(
        r"\\.\pipe\harness-pty-{hex}-{suffix}-{}",
        crate::instance::current()
    )
}

/// 16 random hex digits (64 bits from the system's random source, through a v4 UUID).
pub fn random_suffix() -> String {
    let random = Sha256::digest(uuid::Uuid::new_v4().as_bytes());
    random[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// A new pipe name for a host of `home` (which must exist) for this user: random each call.
pub fn pipe_name_for(home: &Path) -> io::Result<String> {
    let home = std::fs::canonicalize(home)?;
    Ok(pipe_name(
        &user_sid()?,
        &home.to_string_lossy(),
        &random_suffix(),
    ))
}

/// This process's `TOKEN_USER`, in u64 words (so it is aligned): the user's SID is inside.
fn token_user() -> io::Result<Vec<u64>> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = OwnedHandle::from_raw_handle(token as _);
        let mut len = 0u32;
        GetTokenInformation(
            token.as_raw_handle() as _,
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut len,
        );
        if GetLastError() != ERROR_INSUFFICIENT_BUFFER {
            return Err(io::Error::last_os_error());
        }
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        if GetTokenInformation(
            token.as_raw_handle() as _,
            TokenUser,
            buf.as_mut_ptr().cast(),
            len,
            &mut len,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(buf)
    }
}

/// The current user's SID, as a string (`S-1-5-21-…`).
pub fn user_sid() -> io::Result<String> {
    let buf = token_user()?;
    unsafe {
        let user = &*buf.as_ptr().cast::<TOKEN_USER>();
        let mut text: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(io::Error::last_os_error());
        }
        let len = (0..).take_while(|&i| *text.add(i) != 0).count();
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
        LocalFree(text.cast());
        Ok(sid)
    }
}

/// The security descriptor `D:P(A;;GA;;;<user SID>)`: a protected DACL that lets the user, and
/// nobody else, do anything. (`for_directory` adds `OICI`: what is made inside inherits it.)
pub struct OwnerOnly(PSECURITY_DESCRIPTOR);

// The descriptor is immutable once made, and freed only on drop.
unsafe impl Send for OwnerOnly {}
unsafe impl Sync for OwnerOnly {}

impl OwnerOnly {
    pub fn new() -> io::Result<OwnerOnly> {
        OwnerOnly::from_sddl(&format!("D:P(A;;GA;;;{})", user_sid()?))
    }

    /// For a directory: the same entry, inherited by the files and directories made in it.
    pub fn for_directory() -> io::Result<OwnerOnly> {
        OwnerOnly::from_sddl(&format!("D:P(A;OICI;GA;;;{})", user_sid()?))
    }

    fn from_sddl(sddl: &str) -> io::Result<OwnerOnly> {
        let sddl = wide(sddl);
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(OwnerOnly(sd))
    }

    /// Attributes for a new object: this descriptor, not inherited by children.
    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }

    /// Replace the DACL of the file at `path` with this one (inherited entries go too: the DACL
    /// is protected).
    pub fn apply_to(&self, path: &Path) -> io::Result<()> {
        let name = wide_path(path);
        if unsafe { SetFileSecurityW(name.as_ptr(), DACL_SECURITY_INFORMATION, self.0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for OwnerOnly {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

/// Create the directory `path` the user's alone (`OwnerOnly::for_directory`), or, when it is
/// there already, replace its DACL with that one. (Files already in it keep theirs.)
pub fn secure_dir(path: &Path) -> io::Result<()> {
    let security = OwnerOnly::for_directory()?;
    let attributes = security.attributes();
    let name = wide_path(path);
    if unsafe { CreateDirectoryW(name.as_ptr(), &attributes) } != 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    if err.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) {
        return Err(err);
    }
    if !path.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} is not a directory", path.display()),
        ));
    }
    security.apply_to(path)
}

/// Create the new file `path` (it must not exist) with the user-only DACL from the start, open
/// for writing: what is written in it is never readable by anyone else, not even for a moment.
pub fn create_private_file(path: &Path) -> io::Result<std::fs::File> {
    let security = OwnerOnly::new()?;
    let attributes = security.attributes();
    let name = wide_path(path);
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_handle(handle as _) })
}

/// Open `path` to append to, creating it with the user-only DACL when it is not there (a file that
/// is keeps its own). Shared for reading, writing and deletion: the person can read the log while the
/// host runs, another host's line or two goes in, and the file can be renamed (rotated).
pub fn open_private_append(path: &Path) -> io::Result<std::fs::File> {
    let security = OwnerOnly::new()?;
    let attributes = security.attributes();
    let name = wide_path(path);
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_handle(handle as _) })
}

fn create_instance(name: &[u16], first: bool, security: &OwnerOnly) -> io::Result<OwnedHandle> {
    let mut open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
    if first {
        open |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    let attributes = security.attributes();
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            BUFFER,
            BUFFER,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
}

pub struct PipeListener {
    name: String,
    wide: Vec<u16>,
    security: OwnerOnly,
    /// The instance the next client connects to. There is always one between accepts, so a
    /// client never finds the name missing (only, for a moment, busy).
    next: Mutex<Option<OwnedHandle>>,
}

/// Create the pipe's first instance, unless another process has the name.
pub fn bind(name: &str) -> io::Result<Bound<PipeListener>> {
    let security = OwnerOnly::new()?;
    let wide = wide(name);
    match create_instance(&wide, true, &security) {
        Ok(first) => Ok(Bound::Listening(PipeListener {
            name: name.to_owned(),
            wide,
            security,
            next: Mutex::new(Some(first)),
        })),
        Err(e) if e.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => Ok(Bound::Taken),
        Err(e) => Err(e),
    }
}

/// A manual-reset event for one overlapped operation at a time.
struct Event(OwnedHandle);

impl Event {
    fn new() -> io::Result<Event> {
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Event(unsafe { OwnedHandle::from_raw_handle(handle as _) }))
    }

    fn raw(&self) -> HANDLE {
        self.0.as_raw_handle() as _
    }

    /// A zeroed OVERLAPPED that signals this event, which is reset first.
    fn overlapped(&self) -> OVERLAPPED {
        unsafe { ResetEvent(self.raw()) };
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = self.raw();
        ov
    }
}

impl Listener for PipeListener {
    type Conn = PipeConn;

    fn accept(&self) -> io::Result<PipeConn> {
        let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
        let event = Event::new()?;
        loop {
            let pipe = match next.take() {
                Some(pipe) => pipe,
                None => create_instance(&self.wide, false, &self.security)?,
            };
            let connected = connect_instance(&pipe, &event);
            // The next instance before this one is handed out.
            match create_instance(&self.wide, false, &self.security) {
                Ok(instance) => *next = Some(instance),
                Err(err) => log::error!("no pipe instance for the next client: {err}"),
            }
            match connected {
                Ok(true) => return PipeConn::new(pipe),
                // The client left before it was accepted: wait for the next one.
                Ok(false) => continue,
                Err(err) => return Err(err),
            }
        }
    }

    fn endpoint(&self) -> String {
        self.name.clone()
    }
}

/// Wait for a client on `pipe`: true once one is connected, false when it already left.
fn connect_instance(pipe: &OwnedHandle, event: &Event) -> io::Result<bool> {
    let handle = pipe.as_raw_handle() as HANDLE;
    let mut ov = event.overlapped();
    if unsafe { ConnectNamedPipe(handle, &mut ov) } != 0 {
        return Ok(true);
    }
    match unsafe { GetLastError() } {
        ERROR_PIPE_CONNECTED => Ok(true),
        ERROR_NO_DATA => Ok(false),
        ERROR_IO_PENDING => {
            let mut n = 0u32;
            if unsafe { GetOverlappedResult(handle, &ov, &mut n, 1) } != 0 {
                return Ok(true);
            }
            match unsafe { GetLastError() } {
                ERROR_NO_DATA | ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED => Ok(false),
                code => Err(io::Error::from_raw_os_error(code as i32)),
            }
        }
        code => Err(io::Error::from_raw_os_error(code as i32)),
    }
}

/// Open the pipe `name` as a client: the file `OpenOptions` opens, overlapped. A pipe whose
/// instances are all busy is tried again for a few seconds.
pub fn connect(name: &str) -> io::Result<PipeConn> {
    let end = Instant::now() + BUSY_WAIT;
    loop {
        let opened = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_OVERLAPPED)
            // The server may identify this client, never act as it (std adds SECURITY_SQOS_PRESENT).
            .security_qos_flags(SECURITY_IDENTIFICATION)
            .open(name);
        match opened {
            Ok(file) => return PipeConn::new(OwnedHandle::from(file)),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && Instant::now() < end => {
                unsafe { WaitNamedPipeW(wide(name).as_ptr(), 100) };
            }
            Err(e) => return Err(e),
        }
    }
}

/// What the handles of one connection share.
struct Shared {
    pipe: OwnedHandle,
    closed: AtomicBool,
    /// The read timeout in milliseconds; 0 is none.
    read_timeout_ms: AtomicU32,
}

/// One end of a pipe connection. Clones share the pipe (and its read timeout, as a socket's
/// handles do); each has its own events, so a reader and a writer thread never wait on each
/// other.
pub struct PipeConn {
    shared: Arc<Shared>,
    read_event: Event,
    write_event: Event,
}

impl PipeConn {
    fn new(pipe: OwnedHandle) -> io::Result<PipeConn> {
        Ok(PipeConn {
            shared: Arc::new(Shared {
                pipe,
                closed: AtomicBool::new(false),
                read_timeout_ms: AtomicU32::new(0),
            }),
            read_event: Event::new()?,
            write_event: Event::new()?,
        })
    }

    fn handle(&self) -> HANDLE {
        self.shared.pipe.as_raw_handle() as HANDLE
    }

    fn closed(&self) -> bool {
        self.shared.closed.load(Ordering::SeqCst)
    }

    /// Wait for the operation `ov` started (pending), within `timeout` ms (none for 0); a
    /// shutdown or a timeout cancels it. Returns the bytes moved, or the error code, and whether
    /// it timed out.
    fn finish(&self, ov: &OVERLAPPED, event: &Event, timeout: u32) -> (Result<u32, u32>, bool) {
        let handle = self.handle();
        // A shutdown that came after the check before the operation started: its cancel missed
        // this operation, so cancel it here.
        if self.closed() {
            unsafe { CancelIoEx(handle, ov) };
        }
        let mut timed_out = false;
        if timeout != 0 && unsafe { WaitForSingleObject(event.raw(), timeout) } == WAIT_TIMEOUT {
            unsafe { CancelIoEx(handle, ov) };
            timed_out = true;
        }
        let mut n = 0u32;
        // Always waits for the end: the OVERLAPPED and the buffer must outlive the operation.
        if unsafe { GetOverlappedResult(handle, ov, &mut n, 1) } != 0 {
            return (Ok(n), false);
        }
        (Err(unsafe { GetLastError() }), timed_out)
    }
}

/// The codes that mean the other end has gone.
fn is_gone(code: u32) -> bool {
    matches!(
        code,
        ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA
    )
}

impl Read for PipeConn {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.closed() || buf.is_empty() {
            return Ok(0);
        }
        let len = buf.len().min(u32::MAX as usize) as u32;
        let ov = self.read_event.overlapped();
        let started = unsafe {
            ReadFile(
                self.handle(),
                buf.as_mut_ptr(),
                len,
                std::ptr::null_mut(),
                &ov as *const OVERLAPPED as *mut OVERLAPPED,
            )
        };
        if started == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_IO_PENDING {
                return if is_gone(code) {
                    Ok(0)
                } else {
                    Err(io::Error::from_raw_os_error(code as i32))
                };
            }
        }
        let timeout = self.shared.read_timeout_ms.load(Ordering::SeqCst);
        match self.finish(&ov, &self.read_event, timeout) {
            (Ok(n), _) => Ok(n as usize),
            (Err(ERROR_OPERATION_ABORTED), true) if !self.closed() => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the read timed out",
            )),
            // Shut down (by this end), or the other end has gone: the end of the stream.
            (Err(code), _) if code == ERROR_OPERATION_ABORTED || is_gone(code) => Ok(0),
            (Err(code), _) => Err(io::Error::from_raw_os_error(code as i32)),
        }
    }
}

impl Write for PipeConn {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.closed() {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        if buf.is_empty() {
            return Ok(0);
        }
        let len = buf.len().min(u32::MAX as usize) as u32;
        let ov = self.write_event.overlapped();
        let started = unsafe {
            WriteFile(
                self.handle(),
                buf.as_ptr(),
                len,
                std::ptr::null_mut(),
                &ov as *const OVERLAPPED as *mut OVERLAPPED,
            )
        };
        if started == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_IO_PENDING {
                return Err(if is_gone(code) {
                    io::ErrorKind::BrokenPipe.into()
                } else {
                    io::Error::from_raw_os_error(code as i32)
                });
            }
        }
        match self.finish(&ov, &self.write_event, 0) {
            (Ok(n), _) => Ok(n as usize),
            (Err(code), _) if code == ERROR_OPERATION_ABORTED || is_gone(code) => {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            (Err(code), _) => Err(io::Error::from_raw_os_error(code as i32)),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Connection for PipeConn {
    fn try_clone(&self) -> io::Result<Self> {
        Ok(PipeConn {
            shared: self.shared.clone(),
            read_event: Event::new()?,
            write_event: Event::new()?,
        })
    }

    /// Every handle's blocked read returns the end of the stream and its blocked write fails;
    /// later ones do the same at once. The other end sees the end of the stream once the last
    /// handle closes, after what was already written: a disconnect would discard that.
    fn shutdown(&self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        unsafe { CancelIoEx(self.handle(), std::ptr::null()) };
    }

    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        let ms = match timeout {
            None => 0,
            Some(t) if t.is_zero() => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "a zero read timeout",
                ));
            }
            Some(t) => t.as_millis().clamp(1, (INFINITE - 1) as u128) as u32,
        };
        self.shared.read_timeout_ms.store(ms, Ordering::SeqCst);
        Ok(())
    }
}

/// What a test reads of a DACL: whether it is protected, and its entries.
#[cfg(test)]
#[derive(Debug)]
pub(crate) struct Dacl {
    pub protected: bool,
    pub aces: Vec<Ace>,
}

#[cfg(test)]
#[derive(Debug)]
pub(crate) struct Ace {
    pub allowed: bool,
    pub flags: u8,
    pub mask: u32,
    /// Whether the entry's SID is this process's user (`EqualSid` with the token's).
    pub is_user: bool,
}

#[cfg(test)]
impl Dacl {
    /// Protected, one entry, allowing the user everything; inherited by what is made inside
    /// when `inheritable` (a directory's).
    pub fn assert_users_alone(&self, inheritable: bool) {
        use windows_sys::Win32::Security::{CONTAINER_INHERIT_ACE, OBJECT_INHERIT_ACE};
        assert!(self.protected, "{self:?}");
        assert_eq!(self.aces.len(), 1, "{self:?}");
        let ace = &self.aces[0];
        // GENERIC_ALL, or what it maps to on a file or a pipe (FILE_ALL_ACCESS).
        assert!(ace.allowed && ace.is_user, "{self:?}");
        assert!(ace.mask == 0x1F01FF || ace.mask == 0x1000_0000, "{self:?}");
        let inherit = (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8;
        assert_eq!(
            ace.flags & inherit,
            if inheritable { inherit } else { 0 },
            "{self:?}"
        );
    }

    /// Every entry allows the user, and nobody else has one.
    pub fn assert_only_user_entries(&self) {
        assert!(!self.aces.is_empty(), "{self:?}");
        assert!(self.aces.iter().all(|a| a.allowed && a.is_user), "{self:?}");
    }
}

#[cfg(test)]
fn dacl_in(sd: PSECURITY_DESCRIPTOR) -> Dacl {
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACL, EqualSid, GetAce, GetSecurityDescriptorControl,
        GetSecurityDescriptorDacl, SE_DACL_PROTECTED,
    };
    /// `ACCESS_ALLOWED_ACE_TYPE` (Win32_System_SystemServices, a feature this crate does not use).
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    let user = token_user().unwrap();
    let user_sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut control = 0u16;
    let mut revision = 0u32;
    assert_ne!(
        unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) },
        0
    );
    let (mut present, mut defaulted) = (0, 0);
    let mut acl: *mut ACL = std::ptr::null_mut();
    assert_ne!(
        unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut acl, &mut defaulted) },
        0
    );
    assert!(present != 0 && !acl.is_null(), "no DACL");
    let count = unsafe { (*acl).AceCount };
    let aces = (0..count as u32)
        .map(|i| {
            let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
            assert_ne!(unsafe { GetAce(acl, i, &mut ace) }, 0);
            let ace = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            let allowed = ace.Header.AceType == ACCESS_ALLOWED_ACE_TYPE;
            let sid = (&ace.SidStart as *const u32).cast_mut().cast();
            Ace {
                allowed,
                flags: ace.Header.AceFlags,
                mask: ace.Mask,
                is_user: allowed && unsafe { EqualSid(sid, user_sid) } != 0,
            }
        })
        .collect();
    Dacl {
        protected: control & SE_DACL_PROTECTED != 0,
        aces,
    }
}

/// The DACL of the file or directory at `path`.
#[cfg(test)]
pub(crate) fn file_dacl(path: &Path) -> Dacl {
    use windows_sys::Win32::Security::GetFileSecurityW;
    let name = wide_path(path);
    let mut len = 0u32;
    unsafe {
        GetFileSecurityW(
            name.as_ptr(),
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut len,
        )
    };
    assert!(
        len > 0,
        "{}: {}",
        path.display(),
        io::Error::last_os_error()
    );
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    let ok = unsafe {
        GetFileSecurityW(
            name.as_ptr(),
            DACL_SECURITY_INFORMATION,
            buf.as_mut_ptr().cast(),
            len,
            &mut len,
        )
    };
    assert!(
        ok != 0,
        "{}: {}",
        path.display(),
        io::Error::last_os_error()
    );
    dacl_in(buf.as_mut_ptr().cast())
}

/// The DACL of the pipe `conn` is connected to. (Opening a pipe by name connects to an instance,
/// so a pipe's descriptor is read through a connection.)
#[cfg(test)]
pub(crate) fn pipe_dacl(conn: &PipeConn) -> Dacl {
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let code = unsafe {
        GetSecurityInfo(
            conn.handle(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    assert_eq!(code, 0, "{}", io::Error::from_raw_os_error(code as i32));
    let dacl = dacl_in(sd);
    unsafe { LocalFree(sd) };
    dacl
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    fn unique_name() -> String {
        pipe_name(
            &user_sid().unwrap(),
            &uuid::Uuid::new_v4().to_string(),
            &random_suffix(),
        )
    }

    #[test]
    fn the_name_hashes_the_user_and_the_home_and_is_new_each_start() {
        let a = pipe_name("S-1-5-21-1", r"\\?\C:\Users\a\.harness", "0123456789abcdef");
        assert_eq!(
            a,
            pipe_name("S-1-5-21-1", r"\\?\C:\Users\a\.harness", "0123456789abcdef")
        );
        let hash = a
            .strip_prefix(r"\\.\pipe\harness-pty-")
            .unwrap()
            .strip_suffix(&format!("-0123456789abcdef-{}", crate::instance::current()))
            .unwrap();
        assert_eq!(hash.len(), 16);
        let s = "0123456789abcdef";
        assert_ne!(a, pipe_name("S-1-5-21-2", r"\\?\C:\Users\a\.harness", s));
        assert_ne!(a, pipe_name("S-1-5-21-1", r"\\?\C:\Users\b\.harness", s));
        // The separator keeps "ab"+"c" apart from "a"+"bc".
        assert_ne!(pipe_name("ab", "c", s), pipe_name("a", "bc", s));
        // SHA-256("S-1-5-21-1\0C:\h"), first 8 bytes.
        let digest = Sha256::digest(b"S-1-5-21-1\0C:\\h");
        let want: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            pipe_name("S-1-5-21-1", r"C:\h", s),
            format!(
                r"\\.\pipe\harness-pty-{want}-{s}-{}",
                crate::instance::current()
            )
        );
        // A new name each call, for the same home, however it is written: only its hash part is
        // the home's.
        let home = tempfile::tempdir().unwrap();
        let other = format!("{}\\.\\", home.path().display());
        let (first, second) = (
            pipe_name_for(home.path()).unwrap(),
            pipe_name_for(Path::new(&other)).unwrap(),
        );
        assert_ne!(first, second);
        let home_part = |name: &str| {
            name[..name.len() - format!("-{s}-{}", crate::instance::current()).len()].to_owned()
        };
        assert_eq!(home_part(&first), home_part(&second));
        let suffix = random_suffix();
        assert_eq!(suffix.len(), 16);
        assert!(
            suffix
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        );
        assert_ne!(suffix, random_suffix());
    }

    #[test]
    fn the_first_instance_is_the_hosts_and_only_the_user_may_connect() {
        let name = unique_name();
        let Bound::Listening(listener) = bind(&name).unwrap() else {
            panic!("not bound")
        };
        assert_eq!(listener.endpoint(), name);
        // Another host cannot take the name while this one has it.
        assert!(matches!(bind(&name).unwrap(), Bound::Taken));
        // (Compared by SID: SDDL writes some users as an alias, the built-in Administrator as `LA`.)
        pipe_dacl(&connect(&name).unwrap()).assert_users_alone(false);
        drop(listener);
        // The name goes with its last instance.
        assert!(matches!(bind(&name).unwrap(), Bound::Listening(_)));
    }

    #[test]
    fn reads_and_writes_cross_and_a_blocked_read_does_not_hold_up_a_write() {
        let name = unique_name();
        let Bound::Listening(listener) = bind(&name).unwrap() else {
            panic!("not bound")
        };
        let server = std::thread::spawn(move || {
            let conn = listener.accept().unwrap();
            let mut reader = BufReader::new(conn.try_clone().unwrap());
            let mut writer = conn;
            // A reader thread blocked on a read while this one writes, as the host's are.
            let blocked = std::thread::spawn(move || {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                line
            });
            std::thread::sleep(Duration::from_millis(200));
            writer.write_all(b"from-server\n").unwrap();
            let line = blocked.join().unwrap();
            (listener, line)
        });
        let client = connect(&name).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut r = BufReader::new(client.try_clone().unwrap());
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        assert_eq!(line, "from-server\n");
        let mut w = client;
        w.write_all(b"from-client\n").unwrap();
        let (_listener, got) = server.join().unwrap();
        assert_eq!(got, "from-client\n");
    }

    #[test]
    fn a_read_times_out_and_shutdown_wakes_a_blocked_read() {
        let name = unique_name();
        let Bound::Listening(listener) = bind(&name).unwrap() else {
            panic!("not bound")
        };
        let client = connect(&name).unwrap();
        let server = listener.accept().unwrap();
        server
            .set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        let mut reader = server.try_clone().unwrap();
        let started = Instant::now();
        let err = reader.read(&mut [0u8; 8]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(150));
        // Data written before the timeout's cancel is not lost.
        server.set_read_timeout(None).unwrap();
        let blocked = std::thread::spawn(move || reader.read(&mut [0u8; 8]));
        std::thread::sleep(Duration::from_millis(200));
        server.shutdown();
        assert_eq!(blocked.join().unwrap().unwrap(), 0);
        // Writes after the shutdown fail; the client sees what came before, then the end.
        let mut w = server.try_clone().unwrap();
        assert!(w.write(b"x").is_err());
        drop((w, server));
        let mut c = client;
        c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        assert_eq!(c.read(&mut [0u8; 8]).unwrap(), 0);
    }

    #[test]
    fn what_was_written_before_the_close_still_reaches_the_client() {
        let name = unique_name();
        let Bound::Listening(listener) = bind(&name).unwrap() else {
            panic!("not bound")
        };
        let client = connect(&name).unwrap();
        let mut server = listener.accept().unwrap();
        server.write_all(b"last words\n").unwrap();
        server.shutdown();
        drop(server);
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut r = BufReader::new(client);
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        assert_eq!(line, "last words\n");
        line.clear();
        assert_eq!(r.read_line(&mut line).unwrap(), 0);
    }

    #[test]
    fn many_clients_connect_at_once() {
        let name = unique_name();
        let Bound::Listening(listener) = bind(&name).unwrap() else {
            panic!("not bound")
        };
        let accepting = std::thread::spawn(move || {
            let conns: Vec<_> = (0..16).map(|_| listener.accept().unwrap()).collect();
            (listener, conns)
        });
        let clients: Vec<_> = (0..16)
            .map(|_| {
                let name = name.clone();
                std::thread::spawn(move || connect(&name).unwrap())
            })
            .collect();
        // Kept open until accepted: a client that has left by then is skipped, not accepted.
        let clients: Vec<_> = clients.into_iter().map(|c| c.join().unwrap()).collect();
        let (_listener, conns) = accepting.join().unwrap();
        drop(clients);
        assert_eq!(conns.len(), 16);
    }
}
