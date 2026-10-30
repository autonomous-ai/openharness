//! The Unix socket `<home>/run/pty-host-<instance>.sock`, readable and writable by its owner only.

use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{Bound, Connection, Listener};

pub fn socket_path(run_dir: &Path) -> PathBuf {
    crate::instance::socket_path(run_dir, &crate::instance::current())
}

pub struct UnixTransport {
    listener: UnixListener,
    path: PathBuf,
}

/// Bind `path`, unless a host already answers there. A socket file nobody answers on (a host
/// that died) is replaced.
pub fn bind(path: &Path) -> io::Result<Bound<UnixTransport>> {
    for _ in 0..2 {
        if path.exists() {
            if UnixStream::connect(path).is_ok() {
                return Ok(Bound::Taken);
            }
            match std::fs::remove_file(path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        // `serve` binds under an owner-only umask, so the socket is never open to others; the
        // chmod makes sure of it whatever the umask.
        match UnixListener::bind(path) {
            Ok(listener) => {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
                return Ok(Bound::Listening(UnixTransport {
                    listener,
                    path: path.to_owned(),
                }));
            }
            // Another host bound it between our look and our bind: look again.
            Err(e) if e.kind() == io::ErrorKind::AddrInUse => continue,
            Err(e) => return Err(e),
        }
    }
    if UnixStream::connect(path).is_ok() {
        Ok(Bound::Taken)
    } else {
        Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            format!("{} is in use", path.display()),
        ))
    }
}

impl Listener for UnixTransport {
    type Conn = UnixStream;

    fn accept(&self) -> io::Result<UnixStream> {
        self.listener.accept().map(|(stream, _)| stream)
    }

    fn endpoint(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Connection for UnixStream {
    fn try_clone(&self) -> io::Result<Self> {
        UnixStream::try_clone(self)
    }

    fn shutdown(&self) {
        let _ = UnixStream::shutdown(self, std::net::Shutdown::Both);
    }

    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        UnixStream::set_read_timeout(self, timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_owner_only_and_sees_a_live_host() {
        let dir = tempfile::tempdir().unwrap();
        let path = socket_path(dir.path());
        let Bound::Listening(first) = bind(&path).unwrap() else {
            panic!("not bound")
        };
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(first.endpoint(), path.to_string_lossy());
        assert!(matches!(bind(&path).unwrap(), Bound::Taken));
        drop(first);
        // The file stays, nobody answers: replaced. (A child another test forks just now holds
        // the listener until it execs: wait for the refusal.)
        let end = std::time::Instant::now() + Duration::from_secs(5);
        while UnixStream::connect(&path).is_ok() {
            assert!(std::time::Instant::now() < end, "the listener stays open");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(path.exists());
        assert!(matches!(bind(&path).unwrap(), Bound::Listening(_)));
    }
}
