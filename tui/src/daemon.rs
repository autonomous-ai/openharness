//! One held connection per machine to this OS user's private daemon socket (`/api/local-ws`), selected onto
//! that machine — this computer's own, or another the daemon relays to (relay + P2P live inside the
//! daemon; this side never sees anything but plaintext frames).
//!
//! Requests carry a `requestId` and resolve on `<type>_result` (or `terminal_ready` / `terminal_error`
//! for `terminal_open`, `route_result` for `route_task`). Everything else the machine pushes — turns,
//! questions, agents appearing — goes to the app as an event, as do binary terminal frames.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::path::{Path, PathBuf};
use std::os::unix::fs::{FileTypeExt, MetadataExt};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;

use crate::event::{Event, MachineEvent};
use crate::proto;

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: String,
    pub detail: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.detail.is_empty() || self.detail == self.code { write!(f, "{}", self.code) } else { write!(f, "{}: {}", self.code, self.detail) }
    }
}

impl RpcError {
    pub fn new(code: &str, detail: impl Into<String>) -> Self { RpcError { code: code.to_string(), detail: detail.into() } }
}

enum Out {
    Text(String),
    Binary(Vec<u8>),
}

trait SocketIo: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> SocketIo for T {}

type Pending = Arc<Mutex<HashMap<String, (String, oneshot::Sender<(String, Value)>)>>>;

/// The daemon's owner-only socket, shared with Desktop. Never fall back to TCP: loopback is shared
/// by every OS user, so the process holding a port may belong to a completely different account.
pub fn socket_path(port: u16) -> PathBuf {
    let dir = std::env::var_os("ADAPTER_DATA_DIR").filter(|s| !s.is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".harness/cli/data"));
    dir.join(format!("daemon-{port}.sock"))
}

async fn connect_owned(path: &Path) -> std::io::Result<tokio::net::UnixStream> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Harness requires a private daemon socket owned by this OS user"));
    }
    tokio::net::UnixStream::connect(path).await
}

// Clear requests on every exit, including cancellation and failures before selection.
// Otherwise RPC clones can keep their own waiters alive until the full request deadline.
struct PendingGuard(Pending);
impl Drop for PendingGuard {
    fn drop(&mut self) { self.0.lock().unwrap().clear(); }
}

#[derive(Clone)]
pub struct Link {
    #[allow(dead_code)]
    pub machine_id: String,
    tx: mpsc::UnboundedSender<Out>,
    pending: Pending,
    task: tokio::task::AbortHandle,
    /// Bumped per connection so the app can tell a stale link's events from the live one's.
    #[allow(dead_code)]
    pub generation: u64,
}

impl Link {
    /// Dial and select [machine_id]. Events (including `Connected` / `Closed`) arrive on [sink].
    pub fn spawn(port: u16, machine_id: &str, generation: u64, sink: mpsc::UnboundedSender<Event>) -> Link {
        Self::spawn_at(port, socket_path(port), machine_id, generation, sink)
    }

    fn spawn_at(port: u16, socket_path: PathBuf, machine_id: &str, generation: u64, sink: mpsc::UnboundedSender<Event>) -> Link {
        let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let guard = PendingGuard(pending.clone());
        let requests = pending.clone();
        let id = machine_id.to_string();
        let task = tokio::spawn(async move {
            let _guard = guard;
            let pending = requests;
            let emit = |event: MachineEvent| {
                let _ = sink.send(Event::Machine { machine_id: id.clone(), generation, event });
            };
            let url = format!("ws://127.0.0.1:{port}/api/local-ws");
            // Local shells use the same protocol on a private Unix socket. The rest of the
            // request, heartbeat, ordering and reconnect machinery remains shared.
            let connect = tokio::time::timeout(Duration::from_secs(20), async {
                let io: Box<dyn SocketIo> = if crate::local::is_local(&id) {
                    Box::new(crate::local::connect(port).await.map_err(tokio_tungstenite::tungstenite::Error::Io)?)
                } else {
                    Box::new(connect_owned(&socket_path).await.map_err(tokio_tungstenite::tungstenite::Error::Io)?)
                };
                tokio_tungstenite::client_async(&url, io).await
            }).await;
            let (ws, _) = match connect {
                Ok(Ok(ok)) => ok,
                Ok(Err(error)) => { emit(MachineEvent::Failed(RpcError::new("DAEMON_UNREACHABLE", error.to_string()))); return }
                Err(_) => { emit(MachineEvent::Failed(RpcError::new("TIMEOUT", "the daemon did not answer"))); return }
            };
            let (mut write, mut read) = ws.split();
            // `client` makes this its own presence, not the desktop app's (cli localWsServer, backend presence).
            let select = json!({ "type": "machine_select", "payload": { "machineId": id, "localProtocolVersion": 1, "client": "tui" } });
            if write.send(Message::text(select.to_string())).await.is_err() {
                emit(MachineEvent::Failed(RpcError::new("DISCONNECTED", "")));
                return;
            }
            let mut selected = false;
            let select_deadline = tokio::time::sleep(Duration::from_secs(25));
            tokio::pin!(select_deadline);
            // The WebSocket can remain open when its daemon is hung. Require a pong to a
            // ping we sent, even when no RPC or terminal output is expected.
            let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
            let mut ping: Option<(tokio::time::Instant, Vec<u8>)> = None;
            let mut ping_id = 0u64;
            loop {
                tokio::select! {
                    _ = &mut select_deadline, if !selected => {
                        emit(MachineEvent::Failed(RpcError::new("TIMEOUT", "the machine did not answer in time")));
                        return;
                    }
                    _ = tokio::time::sleep_until(ping.as_ref().map(|(at, _)| *at + Duration::from_secs(10)).unwrap_or_else(tokio::time::Instant::now)), if ping.is_some() => {
                        emit(MachineEvent::Closed(RpcError::new("HEARTBEAT_TIMEOUT", "the daemon stopped answering")));
                        break;
                    }
                    _ = heartbeat.tick(), if selected => {
                        if ping.is_none() {
                            ping_id += 1;
                            let bytes = ping_id.to_be_bytes().to_vec();
                            ping = Some((tokio::time::Instant::now(), bytes.clone()));
                            if !matches!(tokio::time::timeout(Duration::from_secs(5), write.send(Message::Ping(bytes.into()))).await, Ok(Ok(()))) {
                                emit(MachineEvent::Closed(RpcError::new("HEARTBEAT_TIMEOUT", "the daemon stopped answering")));
                                break;
                            }
                        }
                    }
                    out = rx.recv() => {
                        let Some(out) = out else { let _ = write.close().await; return };
                        let message = match out { Out::Text(text) => Message::text(text), Out::Binary(bytes) => Message::binary(bytes) };
                        if !matches!(tokio::time::timeout(Duration::from_secs(10), write.send(message)).await, Ok(Ok(()))) {
                            let error = RpcError::new("DISCONNECTED", "could not write to the daemon");
                            if selected { emit(MachineEvent::Closed(error)) } else { emit(MachineEvent::Failed(error)) }
                            break;
                        }
                    }
                    incoming = read.next() => {
                        let Some(Ok(message)) = incoming else {
                            if selected { emit(MachineEvent::Closed(RpcError::new("DISCONNECTED", ""))) }
                            else { emit(MachineEvent::Failed(RpcError::new("DISCONNECTED", "the daemon closed the connection"))) }
                            break;
                        };
                        match message {
                            Message::Binary(bytes) => {
                                if let Some(frame) = proto::decode(&bytes) { emit(MachineEvent::Terminal(frame)) }
                            }
                            Message::Text(text) => {
                                let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                                let ty = value.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                                let mut payload = value.get("payload").cloned().unwrap_or(Value::Null);
                                // Agent events name their agent on the ENVELOPE (`agentId`, `dbSessionId`),
                                // beside the payload — `commander_question` among them — and say there
                                // whether a turn's end is a re-read (`replay`) or a sub-agent's
                                // (`subagent`). Fold those in.
                                if let Value::Object(map) = &mut payload {
                                    for key in ["agentId", "dbSessionId", "replay", "subagent"] {
                                        if !map.contains_key(key) { if let Some(v) = value.get(key) { map.insert(key.into(), v.clone()); } }
                                    }
                                }
                                if !selected {
                                    if ty == "connected" { selected = true; emit(MachineEvent::Connected) }
                                    else if ty == "machine_select_error" {
                                        let code = payload.get("error").and_then(Value::as_str).unwrap_or("MACHINE_UNAVAILABLE");
                                        emit(MachineEvent::Failed(RpcError::new(code, payload.get("detail").and_then(Value::as_str).unwrap_or(""))));
                                        return;
                                    }
                                    continue;
                                }
                                if let Some(request_id) = payload.get("requestId").and_then(Value::as_str) {
                                    let waiter = {
                                        let mut map = pending.lock().unwrap();
                                        let matches = map.get(request_id).map(|(want, _)| {
                                            ty == format!("{want}_result") || (want == "terminal_open" && (ty == "terminal_ready" || ty == "terminal_error")) || (want == "route_task" && ty == "route_result")
                                        }).unwrap_or(false);
                                        if matches { map.remove(request_id) } else { None }
                                    };
                                    if let Some((_, reply)) = waiter { let _ = reply.send((ty, payload)); continue }
                                }
                                emit(MachineEvent::Frame { ty, payload });
                            }
                            Message::Pong(bytes) => {
                                if ping.as_ref().is_some_and(|(_, sent)| sent.as_slice() == bytes.as_ref()) { ping = None }
                            }
                            Message::Close(frame) => {
                                let (code, reason) = frame.map(|f| (f.code, f.reason.to_string())).unwrap_or((CloseCode::Normal, String::new()));
                                let code = match u16::from(code) { 4404 => "NO_PEER_LINK", 4403 => "MACHINE_UNAVAILABLE", _ => "DISCONNECTED" };
                                let error = RpcError::new(code, reason);
                                if selected { emit(MachineEvent::Closed(error)) } else { emit(MachineEvent::Failed(error)) }
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }
        });
        Link { machine_id: machine_id.to_string(), tx, pending, task: task.abort_handle(), generation }
    }

    /// Close a failed route even when in-flight RPCs still hold clones of this link.
    pub fn close(&self) { self.task.abort(); }

    pub fn send(&self, ty: &str, payload: Value) -> bool {
        self.tx.send(Out::Text(json!({ "type": ty, "payload": payload }).to_string())).is_ok()
    }

    pub fn send_binary(&self, bytes: Vec<u8>) -> bool {
        self.tx.send(Out::Binary(bytes)).is_ok()
    }

    /// A request and its reply frame `(type, payload)`.
    pub async fn request(&self, ty: &str, mut payload: Value, timeout: Duration) -> Result<(String, Value), RpcError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        if let Value::Object(map) = &mut payload { map.insert("requestId".into(), Value::String(request_id.clone())); }
        let (reply_tx, reply_rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(request_id.clone(), (ty.to_string(), reply_tx));
        if !self.send(ty, payload) {
            self.pending.lock().unwrap().remove(&request_id);
            return Err(RpcError::new("DISCONNECTED", "not connected"));
        }
        match tokio::time::timeout(timeout, reply_rx).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_)) => Err(RpcError::new("DISCONNECTED", "the connection closed")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&request_id);
                Err(RpcError::new("TIMEOUT", format!("no {ty} answer within {}s", timeout.as_secs())))
            }
        }
    }

    /// `request`, with an `error` field in the reply returned as an error.
    pub async fn rpc(&self, ty: &str, payload: Value, timeout: Duration) -> Result<Value, RpcError> {
        let (_, reply) = self.request(ty, payload, timeout).await?;
        if let Some(code) = reply.get("error").and_then(Value::as_str) {
            return Err(RpcError::new(code, reply.get("detail").and_then(Value::as_str).unwrap_or("")));
        }
        Ok(reply)
    }
}

// ── REST on the same port (machines, desk, status) ──────────────────────────────

pub async fn http_json(port: u16, method: &str, path: &str, body: Option<&Value>) -> Result<Value, RpcError> {
    http_json_for(port, method, path, body, Duration::from_secs(15)).await
}

/// [http_json] with its own wait: a long poll (`POST /api/pair` holds the request for as long as a
/// phone's handshake runs) needs more than the usual 15 s.
pub async fn http_json_for(port: u16, method: &str, path: &str, body: Option<&Value>, wait: Duration) -> Result<Value, RpcError> {
    http_json_at(port, &socket_path(port), method, path, body, wait).await
}

async fn http_json_at(port: u16, socket: &Path, method: &str, path: &str, body: Option<&Value>, wait: Duration) -> Result<Value, RpcError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let work = async {
        let mut stream = connect_owned(socket).await.map_err(|e| RpcError::new("DAEMON_UNREACHABLE", e.to_string()))?;
        let body = body.map(|b| b.to_string()).unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: application/json\r\nx-adapter-local: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.map_err(|e| RpcError::new("DISCONNECTED", e.to_string()))?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.map_err(|e| RpcError::new("DISCONNECTED", e.to_string()))?;
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| RpcError::new("BAD_RESPONSE", "no header end"))?;
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let mut content = raw[split + 4..].to_vec();
        if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { content = dechunk(&content) }
        let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let value: Value = serde_json::from_slice(&content).unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            let message = value.pointer("/error/message").or_else(|| value.get("error")).and_then(Value::as_str).unwrap_or("request failed");
            return Err(RpcError::new(&format!("HTTP_{status}"), message));
        }
        Ok(if value.get("success").is_some() && value.get("data").is_some() { value["data"].clone() } else { value })
    };
    tokio::time::timeout(wait, work).await.unwrap_or_else(|_| Err(RpcError::new("TIMEOUT", "the daemon did not answer")))
}

fn dechunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < body.len() {
        let Some(line_end) = body[at..].windows(2).position(|w| w == b"\r\n") else { break };
        let size = usize::from_str_radix(String::from_utf8_lossy(&body[at..at + line_end]).trim(), 16).unwrap_or(0);
        at += line_end + 2;
        if size == 0 || at + size > body.len() { break }
        out.extend_from_slice(&body[at..at + size]);
        at += size + 2;
    }
    out
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct TestSocket(PathBuf);
    impl Drop for TestSocket { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }
    fn listener() -> (tokio::net::UnixListener, TestSocket) {
        let path = PathBuf::from(format!("/tmp/hn-daemon-{}.sock", uuid::Uuid::new_v4().simple()));
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        (listener, TestSocket(path))
    }

    #[tokio::test]
    async fn rest_uses_only_the_users_private_socket_and_never_the_tcp_listener() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let foreign = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = foreign.local_addr().unwrap().port();
        let (owned, socket) = listener();
        let server = tokio::spawn(async move {
            let (mut peer, _) = owned.accept().await.unwrap();
            let mut bytes = [0u8; 4096];
            let n = peer.read(&mut bytes).await.unwrap();
            assert!(String::from_utf8_lossy(&bytes[..n]).starts_with("GET /api/desk "));
            let body = r#"{"owner":"this-user","tabs":[]}"#;
            peer.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let desk = http_json_at(port, &socket.0, "GET", "/api/desk", None, Duration::from_secs(15)).await.unwrap();
        assert_eq!(desk["owner"], "this-user");
        server.await.unwrap();
        std::fs::remove_file(&socket.0).unwrap();
        assert!(http_json_at(port, &socket.0, "GET", "/api/desk", None, Duration::from_secs(15)).await.is_err());
        assert!(tokio::time::timeout(Duration::from_millis(50), foreign.accept()).await.is_err());
    }

    #[tokio::test]
    async fn rejects_public_sockets_and_symlinks_before_sending_any_request() {
        let (owned, socket) = listener();
        std::fs::set_permissions(&socket.0, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(connect_owned(&socket.0).await.unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
        std::fs::set_permissions(&socket.0, std::fs::Permissions::from_mode(0o600)).unwrap();
        let alias = TestSocket(socket.0.with_extension("link"));
        std::os::unix::fs::symlink(&socket.0, &alias.0).unwrap();
        assert_eq!(connect_owned(&alias.0).await.unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
        assert!(tokio::time::timeout(Duration::from_millis(50), owned.accept()).await.is_err());
    }

    #[tokio::test]
    async fn cancel_closes_socket_and_releases_rpc_clones() {
        let (listener, socket) = listener();
        let port = 19418;
        let (sink, mut events) = mpsc::unbounded_channel();
        let (requested, request_seen) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let _select = ws.next().await.unwrap().unwrap();
            ws.send(Message::text(json!({"type":"connected", "payload":{}}).to_string())).await.unwrap();
            let mut requested = Some(requested);
            while let Some(Ok(message)) = ws.next().await {
                if let Message::Text(text) = message {
                    if text.contains("terminal_open") { if let Some(tx) = requested.take() { let _ = tx.send(()); } }
                }
            }
        });
        let link = Link::spawn_at(port, socket.0.clone(), "test-peer", 1, sink);
        assert!(matches!(tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap(), Some(Event::Machine { event: MachineEvent::Connected, .. })));
        let clone = link.clone();
        let rpc = tokio::spawn(async move { clone.request("terminal_open", json!({}), Duration::from_secs(45)).await });
        tokio::time::timeout(Duration::from_secs(2), request_seen).await.unwrap().unwrap();
        link.close();
        link.close(); // repeated cancellation is harmless
        let result = tokio::time::timeout(Duration::from_secs(2), rpc).await.unwrap().unwrap();
        assert_eq!(result.unwrap_err().code, "DISCONNECTED");
        assert!(link.pending.lock().unwrap().is_empty());
        tokio::time::timeout(Duration::from_secs(2), server).await.unwrap().unwrap();
        assert!(!link.send("terminal_alive", json!({})));
    }

    #[tokio::test]
    async fn selection_failure_releases_pending_requests_immediately() {
        let (listener, socket) = listener();
        let port = 19418;
        let (sink, _events) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let _select = ws.next().await;
            ws.send(Message::text(json!({"type":"machine_select_error", "payload":{"error":"NO_PEER_LINK"}}).to_string())).await.unwrap();
        });
        let link = Link::spawn_at(port, socket.0.clone(), "test-peer", 1, sink);
        let result = tokio::time::timeout(Duration::from_secs(2), link.request("agents_list", json!({}), Duration::from_secs(20))).await.unwrap();
        assert_eq!(result.unwrap_err().code, "DISCONNECTED");
        assert!(link.pending.lock().unwrap().is_empty());
        server.await.unwrap();
    }
}
