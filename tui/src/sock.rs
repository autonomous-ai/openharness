//! hn's private sockets: a file at a path, which commands dial and clients listen on. A Unix socket on a Mac or
//! Linux. On Windows that file names a named pipe, which is what a socket path is here:
//!
//! - The file is in hn's own folder, under the person's profile, as the socket is under `0700` elsewhere. Its path
//!   keeps every meaning it has elsewhere: a file nobody answers on is a stopped server (`ipc::no_server`).
//! - The pipe's name is random, because anyone can list `\\.\pipe\`. Its DACL admits its owner alone
//!   (`D:P(A;;GA;;;<SID>)`), `PIPE_REJECT_REMOTE_CLIENTS` keeps the network out, and the first instance is created
//!   with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a name already taken fails. As in pty/src/transport/windows.rs.
//! - A dead client's name could be taken over by another account, which knows it from that listing. So a client
//!   checks that the pipe's server runs as this user before saying anything to it (`server_is_ours`).

use std::io;
use std::path::Path;

use tokio::io::{AsyncRead, AsyncWrite};

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
pub type Stream = Box<dyn Io>;

pub use imp::{Listener, answers, connect, exchange_sync, leave_closed, send_sync};

#[cfg(unix)]
mod imp {
    use std::io::{self, BufRead, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::time::Duration;

    use super::Stream;

    pub struct Listener(tokio::net::UnixListener);

    impl Listener {
        /// Fails when the path is taken, as binding a Unix socket does.
        pub fn bind(path: &Path) -> io::Result<Listener> {
            let listener = std::os::unix::net::UnixListener::bind(path)?;
            listener.set_nonblocking(true)?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            Ok(Listener(tokio::net::UnixListener::from_std(listener)?))
        }

        pub async fn accept(&mut self) -> io::Result<Stream> {
            Ok(Box::new(self.0.accept().await?.0))
        }
    }

    pub async fn connect(path: &Path) -> io::Result<Stream> {
        Ok(Box::new(tokio::net::UnixStream::connect(path).await?))
    }

    /// Whether anything listens at [path]; the connection is let go at once, and runs nothing.
    pub fn answers(path: &Path) -> bool { std::os::unix::net::UnixStream::connect(path).is_ok() }

    /// A file that stays, nothing listening on it (`ipc::gone`).
    pub fn leave_closed(path: &Path) { drop(std::os::unix::net::UnixListener::bind(path)); }

    /// One line written, one read, off the async runtime; None when it does not answer in time.
    pub fn exchange_sync(path: &Path, line: &str, read: Duration, write: Duration) -> Option<String> {
        let mut stream = std::os::unix::net::UnixStream::connect(path).ok()?;
        stream.set_read_timeout(Some(read)).ok()?;
        stream.set_write_timeout(Some(write)).ok()?;
        stream.write_all(line.as_bytes()).ok()?;
        let mut reply = String::new();
        std::io::BufReader::new(&stream).read_line(&mut reply).ok()?;
        Some(reply)
    }

    /// One line written, not waited for: from a client that is going.
    pub fn send_sync(path: &Path, line: &str, write: Duration) {
        let Ok(mut stream) = std::os::unix::net::UnixStream::connect(path) else { return };
        let _ = stream.set_write_timeout(Some(write));
        let _ = stream.write_all(line.as_bytes());
    }
}

#[cfg(windows)]
mod imp {
    use std::io::{self, BufRead, Write};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use std::time::Duration;

    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{ERROR_PIPE_BUSY, HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows_sys::Win32::Security::{EqualSid, GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

    use super::Stream;

    const PIPE_PREFIX: &str = r"\\.\pipe\hn-";

    /// The user in a process's token, as an aligned buffer holding a TOKEN_USER and its SID.
    fn token_user(process: HANDLE) -> io::Result<Vec<u64>> {
        // SAFETY: each output is a live local, the buffer is as long as said, and the token is closed by OwnedHandle.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 { return Err(io::Error::last_os_error()) }
            let token = OwnedHandle::from_raw_handle(token as _);
            let mut needed = 0u32;
            GetTokenInformation(token.as_raw_handle() as HANDLE, TokenUser, std::ptr::null_mut(), 0, &mut needed);
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            if GetTokenInformation(token.as_raw_handle() as HANDLE, TokenUser, buffer.as_mut_ptr().cast(), needed, &mut needed) == 0 { return Err(io::Error::last_os_error()) }
            Ok(buffer)
        }
    }

    fn sid_string() -> io::Result<String> {
        // SAFETY: the buffer outlives the call, and the string it returns is LocalFree'd after being copied.
        unsafe {
            let user = token_user(GetCurrentProcess())?;
            let mut text: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut text) == 0 { return Err(io::Error::last_os_error()) }
            let length = (0..).take_while(|i| *text.add(*i) != 0).count();
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
            LocalFree(text.cast());
            Ok(sid)
        }
    }

    /// Whether the process serving [pipe] runs as this user. A process it cannot open is not.
    fn server_is_ours(pipe: HANDLE) -> bool {
        // SAFETY: both token buffers live across EqualSid; the process handle is closed by OwnedHandle.
        unsafe {
            let mut pid = 0u32;
            if GetNamedPipeServerProcessId(pipe, &mut pid) == 0 { return false }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() { return false }
            let process = OwnedHandle::from_raw_handle(process as _);
            let (Ok(theirs), Ok(ours)) = (token_user(process.as_raw_handle() as HANDLE), token_user(GetCurrentProcess())) else { return false };
            EqualSid((*theirs.as_ptr().cast::<TOKEN_USER>()).User.Sid, (*ours.as_ptr().cast::<TOKEN_USER>()).User.Sid) != 0
        }
    }

    fn name_at(path: &Path) -> io::Result<String> {
        let name = std::fs::read_to_string(path)?;
        let name = name.trim();
        // Only a pipe on this computer of hn's own naming: never a file, or `\\host\pipe\`, an SMB connection.
        if name.starts_with(PIPE_PREFIX) && name[PIPE_PREFIX.len()..].chars().all(|c| c.is_ascii_hexdigit()) { Ok(name.to_string()) }
        else { Err(io::Error::new(io::ErrorKind::InvalidData, "not an hn socket")) }
    }

    struct OwnerOnly(*mut core::ffi::c_void);
    // SAFETY: an immutable security descriptor, read only by the kernel when an instance is created.
    unsafe impl Send for OwnerOnly {}
    impl OwnerOnly {
        fn new() -> io::Result<OwnerOnly> {
            let sddl: Vec<u16> = format!("D:P(A;;GA;;;{})", sid_string()?).encode_utf16().chain(Some(0)).collect();
            let mut descriptor = std::ptr::null_mut();
            // SAFETY: a NUL-terminated string and a live output; the descriptor is freed on drop.
            if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut()) } == 0 {
                return Err(io::Error::last_os_error())
            }
            Ok(OwnerOnly(descriptor))
        }
    }
    impl Drop for OwnerOnly {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW, and freed once.
        fn drop(&mut self) { unsafe { LocalFree(self.0); } }
    }

    fn instance(name: &str, first: bool, security: &OwnerOnly) -> io::Result<NamedPipeServer> {
        let mut attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: security.0, bInheritHandle: 0 };
        // SAFETY: the attributes and the descriptor they point at outlive the call, which copies them.
        unsafe { ServerOptions::new().first_pipe_instance(first).reject_remote_clients(true).create_with_security_attributes_raw(name, (&raw mut attributes).cast()) }
    }

    pub struct Listener { name: String, security: OwnerOnly, next: NamedPipeServer }

    impl Listener {
        /// Fails when something answers at [path], as binding a Unix socket does when the file exists. A file nobody
        /// answers on is taken here: its first client's name, kept as tmux keeps a closed socket (`ipc::gone`), is a
        /// stopped server's and this is its next.
        pub fn bind(path: &Path) -> io::Result<Listener> {
            if answers(path) { return Err(io::Error::new(io::ErrorKind::AddrInUse, "another client listens here")) }
            let security = OwnerOnly::new()?;
            let name = format!("{PIPE_PREFIX}{}", uuid::Uuid::new_v4().simple());
            let next = instance(&name, true, &security)?;
            // Beside it and renamed, so a dialer never reads half a name.
            let writing = path.with_extension(format!("next{}", std::process::id()));
            std::fs::write(&writing, &name)?;
            std::fs::rename(&writing, path)?;
            Ok(Listener { name, security, next })
        }

        pub async fn accept(&mut self) -> io::Result<Stream> {
            self.next.connect().await?;
            let fresh = instance(&self.name, false, &self.security)?;
            Ok(Box::new(std::mem::replace(&mut self.next, fresh)))
        }
    }

    pub async fn connect(path: &Path) -> io::Result<Stream> {
        let name = name_at(path)?;
        for _ in 0..50 {
            match ClientOptions::new().open(&name) {
                Ok(client) => {
                    use std::os::windows::io::AsRawHandle;
                    if !server_is_ours(client.as_raw_handle() as HANDLE) { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "this socket is not this user's")) }
                    return Ok(Box::new(client))
                }
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => tokio::time::sleep(Duration::from_millis(20)).await,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(io::ErrorKind::TimedOut, "this socket stayed busy"))
    }

    fn open_sync(path: &Path) -> io::Result<std::fs::File> {
        let name = name_at(path)?;
        for _ in 0..50 {
            match std::fs::OpenOptions::new().read(true).write(true).security_qos_flags(SECURITY_IDENTIFICATION as u32).open(&name) {
                Ok(file) => {
                    if !server_is_ours(file.as_raw_handle() as HANDLE) { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "this socket is not this user's")) }
                    return Ok(file)
                }
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => std::thread::sleep(Duration::from_millis(20)),
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(io::ErrorKind::TimedOut, "this socket stayed busy"))
    }

    /// Whether anything listens at [path]; the connection is let go at once, and runs nothing.
    pub fn answers(path: &Path) -> bool { open_sync(path).is_ok() }

    /// A file that stays, nothing listening on it (`ipc::gone`).
    pub fn leave_closed(path: &Path) { let _ = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(path); }

    /// One line written, one read, off the async runtime; None when it does not answer in time. A pipe's file has no
    /// timeouts of its own, so a thread waits, and is left to end with the pipe when nothing answers.
    pub fn exchange_sync(path: &Path, line: &str, read: Duration, _write: Duration) -> Option<String> {
        let mut file = open_sync(path).ok()?;
        let line = line.to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if file.write_all(line.as_bytes()).is_err() { let _ = tx.send(None); return }
            let mut reply = String::new();
            let read = std::io::BufReader::new(&file).read_line(&mut reply);
            let _ = tx.send(read.ok().map(|_| reply));
        });
        rx.recv_timeout(read).ok().flatten()
    }

    /// One line written, not waited for: from a client that is going.
    pub fn send_sync(path: &Path, line: &str, _write: Duration) {
        if let Ok(mut file) = open_sync(path) { let _ = file.write_all(line.as_bytes()); }
    }
}

/// Reads a line's worth of protocol and writes one, whichever kind of socket it is.
pub fn split(stream: Stream) -> (tokio::io::ReadHalf<Stream>, tokio::io::WriteHalf<Stream>) { tokio::io::split(stream) }

/// The owner's private folder for these sockets: `0700` on a Mac or Linux; the profile's ACL on Windows.
pub fn secure_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?; }
    #[cfg(windows)] { let _ = dir; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn a_listener_answers_and_a_closed_file_does_not() {
        let dir = std::env::temp_dir().join(format!("hn-sock-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.sock");
        assert!(!answers(&path), "nothing there");
        let mut listener = Listener::bind(&path).unwrap();
        assert!(answers(&path));
        assert!(Listener::bind(&path).is_err(), "a path taken refuses another");
        let serve = tokio::spawn(async move {
            // `answers` above took a connection and let it go; the next one speaks.
            loop {
                let (read, mut write) = split(listener.accept().await.unwrap());
                let mut line = String::new();
                if BufReader::new(read).read_line(&mut line).await.unwrap_or(0) == 0 { continue }
                write.write_all(format!("got {line}").as_bytes()).await.unwrap();
                break
            }
        });
        let (read, mut write) = split(connect(&path).await.unwrap());
        write.write_all(b"hello\n").await.unwrap();
        let mut reply = String::new();
        BufReader::new(read).read_line(&mut reply).await.unwrap();
        assert_eq!(reply, "got hello\n");
        serve.await.unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn the_blocking_form_answers_too() {
        let dir = std::env::temp_dir().join(format!("hn-sock-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.sock");
        let mut listener = Listener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (read, mut write) = split(listener.accept().await.unwrap());
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            write.write_all(b"pong\n").await.unwrap();
        });
        let at = path.clone();
        let reply = tokio::task::spawn_blocking(move || exchange_sync(&at, "ping\n", std::time::Duration::from_secs(5), std::time::Duration::from_secs(2))).await.unwrap();
        assert_eq!(reply.as_deref(), Some("pong\n"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_closed_file_stays_and_says_no_server() {
        let dir = std::env::temp_dir().join(format!("hn-sock-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.sock");
        leave_closed(&path);
        assert!(path.exists());
        assert!(!answers(&path));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
