//! Where clients reach the host: a Unix socket, or a named pipe on Windows.

use std::io::{self, Read, Write};
use std::time::Duration;

#[cfg(unix)]
pub mod unix;
#[cfg(windows)]
pub mod windows;

/// One client connection.
pub trait Connection: Read + Write + Send + Sized + 'static {
    /// Another handle on the same connection (a reader and a writer thread each hold one).
    fn try_clone(&self) -> io::Result<Self>;
    /// End the connection for every handle: blocked reads and writes return.
    fn shutdown(&self);
    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()>;
}

/// A bound endpoint.
pub trait Listener: Send + 'static {
    type Conn: Connection;
    fn accept(&self) -> io::Result<Self::Conn>;
    /// What clients connect to (the discovery file's `endpoint`).
    fn endpoint(&self) -> String;
}

/// The outcome of binding the host's endpoint.
pub enum Bound<L> {
    Listening(L),
    /// Another host answers on the endpoint.
    Taken,
}
