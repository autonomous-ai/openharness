//! One held connection per machine to the daemon's loopback socket (`/api/local-ws`), selected onto
//! that machine — this computer's own, or another the daemon relays to (relay + P2P live inside the
//! daemon; this side never sees anything but plaintext frames).
//!
//! Requests carry a `requestId` and resolve on `<type>_result` (or `terminal_ready` / `terminal_error`
//! for `terminal_open`, `route_result` for `route_task`). Everything else the machine pushes — turns,
//! questions, agents appearing — goes to the app as an event, as do binary terminal frames.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

type Pending = Arc<Mutex<HashMap<String, (String, oneshot::Sender<(String, Value)>)>>>;

#[derive(Clone)]
pub struct Link {
    #[allow(dead_code)]
    pub machine_id: String,
    tx: mpsc::UnboundedSender<Out>,
    pending: Pending,
    /// Bumped per connection so the app can tell a stale link's events from the live one's.
    #[allow(dead_code)]
    pub generation: u64,
}

impl Link {
    /// Dial and select [machine_id]. Events (including `Connected` / `Closed`) arrive on [sink].
    pub fn spawn(port: u16, machine_id: &str, generation: u64, sink: mpsc::UnboundedSender<Event>) -> Link {
        let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let link = Link { machine_id: machine_id.to_string(), tx, pending: pending.clone(), generation };
        let id = machine_id.to_string();
        tokio::spawn(async move {
            let emit = |event: MachineEvent| {
                let _ = sink.send(Event::Machine { machine_id: id.clone(), generation, event });
            };
            let url = format!("ws://127.0.0.1:{port}/api/local-ws");
            let connect = tokio::time::timeout(Duration::from_secs(20), tokio_tungstenite::connect_async(url)).await;
            let (ws, _) = match connect {
                Ok(Ok(ok)) => ok,
                Ok(Err(error)) => { emit(MachineEvent::Failed(RpcError::new("DAEMON_UNREACHABLE", error.to_string()))); return }
                Err(_) => { emit(MachineEvent::Failed(RpcError::new("TIMEOUT", "the daemon did not answer"))); return }
            };
            let (mut write, mut read) = ws.split();
            let select = json!({ "type": "machine_select", "payload": { "machineId": id, "localProtocolVersion": 1 } });
            if write.send(Message::text(select.to_string())).await.is_err() {
                emit(MachineEvent::Failed(RpcError::new("DISCONNECTED", "")));
                return;
            }
            let mut selected = false;
            let select_deadline = tokio::time::sleep(Duration::from_secs(25));
            tokio::pin!(select_deadline);
            loop {
                tokio::select! {
                    _ = &mut select_deadline, if !selected => {
                        emit(MachineEvent::Failed(RpcError::new("TIMEOUT", "the machine did not answer in time")));
                        return;
                    }
                    out = rx.recv() => {
                        let Some(out) = out else { let _ = write.close().await; return };
                        let message = match out { Out::Text(text) => Message::text(text), Out::Binary(bytes) => Message::binary(bytes) };
                        if write.send(message).await.is_err() { break }
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
                                // beside the payload — `commander_question` among them. Fold those in.
                                if let Value::Object(map) = &mut payload {
                                    for key in ["agentId", "dbSessionId"] {
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
            // Anyone still waiting learns the socket is gone.
            pending.lock().unwrap().clear();
        });
        link
    }

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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let work = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| RpcError::new("DAEMON_UNREACHABLE", e.to_string()))?;
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
    tokio::time::timeout(Duration::from_secs(15), work).await.unwrap_or_else(|_| Err(RpcError::new("TIMEOUT", "the daemon did not answer")))
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
