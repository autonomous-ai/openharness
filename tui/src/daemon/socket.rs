//! harnessd's Unix socket, beside its loopback port (cli/src/lib/localSocket.ts; the desktop's
//! desktop/lib/ws/local_daemon_transport.dart). The port takes any process on this computer, any
//! user's; the socket is 0600 in a 0700 folder, so only this user's processes open it — and the pair
//! brain takes a key, a talk, a confirmation or presence only over it (daemons/BRAIN.md, "Security":
//! LOCAL_SOCKET_REQUIRED over TCP). hn prefers it for its connections and falls back to the port for
//! a harnessd that predates it, one that could not open it, or a moment when it is missing.
//!
//! One socket per control port, `daemon-<port>.sock` in harnessd's data folder
//! (`$ADAPTER_DATA_DIR`, else `~/.harness/cli/data`), named for the port hn would otherwise dial:
//! the socket and the fallback always lead to the same harnessd. `HARNESS_TUI_SOCKET` names another
//! path, or `off`.

use std::path::PathBuf;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;

/// harnessd opens no socket path longer than this (sun_path, less its staging suffix).
const MAX_SOCKET_PATH_BYTES: usize = 96;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

pub type Ws = WebSocketStream<Box<dyn Io>>;

/// Where the socket of the harnessd on `port` would be, or None where there is none.
pub fn path(port: u16) -> Option<PathBuf> {
    match std::env::var("HARNESS_TUI_SOCKET") {
        Ok(v) if v == "off" => return None,
        Ok(v) if !v.is_empty() => return Some(PathBuf::from(v)),
        _ => {}
    }
    let dir = std::env::var("ADAPTER_DATA_DIR").ok().filter(|d| !d.is_empty()).map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().filter(|h| !h.is_empty()).map(|h| PathBuf::from(h).join(".harness").join("cli").join("data")))?;
    let p = dir.join(format!("daemon-{port}.sock"));
    (p.as_os_str().len() <= MAX_SOCKET_PATH_BYTES).then_some(p)
}

/// Whether a socket file is there to try.
pub fn present(port: u16) -> Option<PathBuf> {
    use std::os::unix::fs::FileTypeExt;
    let p = path(port)?;
    std::fs::symlink_metadata(&p).ok().filter(|m| m.file_type().is_socket()).map(|_| p)
}

/// The local WebSocket (`/api/local-ws`): over the socket when it is there and answers, else over
/// the loopback port. True when it is the socket.
pub async fn connect(port: u16) -> Result<(Ws, bool), String> {
    if let Some(p) = present(port) {
        if let Ok(stream) = tokio::net::UnixStream::connect(&p).await {
            let boxed: Box<dyn Io> = Box::new(stream);
            if let Ok((ws, _)) = tokio_tungstenite::client_async("ws://localhost/api/local-ws", boxed).await { return Ok((ws, true)) }
        }
    }
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| e.to_string())?;
    let boxed: Box<dyn Io> = Box::new(tcp);
    let (ws, _) = tokio_tungstenite::client_async(format!("ws://127.0.0.1:{port}/api/local-ws"), boxed).await.map_err(|e| e.to_string())?;
    Ok((ws, false))
}

#[cfg(test)]
mod tests {
    #[test]
    fn named_for_the_port_in_the_data_folder() {
        // Read-only: where it would be, never opened.
        let p = super::path(18473);
        if std::env::var("HARNESS_TUI_SOCKET").is_err() {
            if let Some(p) = p { assert!(p.ends_with("daemon-18473.sock")) }
        }
    }
}
