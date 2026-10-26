//! The accept loop, the hello, and control connections.
//!
//! Threads:
//! - the accept loop (`run`'s caller) starts one thread per connection;
//! - the dispatcher takes every pane event, applies it to the table and the streams
//!   (`Panes::event`) and broadcasts what it says to every control connection;
//! - a control connection has a reader thread, which answers its requests in order, and a
//!   writer thread, which owns the write half. Both feed the writer one bounded queue: replies
//!   wait for room, notices do not. A connection whose queue is full when a notice comes is
//!   closed, so a slow client never holds up the dispatcher or other clients.
//! - a stream connection (`stream.rs`) has the same pair of threads; the dispatcher queues the
//!   pane's output for it, and drops it when it falls `stream::QUEUE_LIMIT` bytes behind.
//!
//! Locks: the client list (only for non-blocking sends), the pane table, and each pane's own.
//! No thread holds one while it waits on a socket.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::pane::PaneEvent;
use crate::panes::Panes;
use crate::protocol::{
    FEATURES, Failure, HelloLine, Op, PROTOCOL, Request, Role, hello_auth, hello_proof, valid_nonce,
};
use crate::transport::{Connection, Listener};

/// How long a new connection has to say hello.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HELLO: usize = 64 * 1024;
/// The longest request line: a `write` of a full frame's worth of base64, with room to spare.
const MAX_LINE: usize = 32 * 1024 * 1024;
/// Lines waiting for a control connection's writer.
const QUEUE: usize = 1024;

/// What the host says about itself in the hello reply.
#[derive(Debug, Clone)]
pub struct HostInfo {
    pub token: String,
    pub instance: String,
    pub version: String,
    pub pid: u32,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

type Closer = Box<dyn Fn() + Send + Sync>;

struct Client {
    id: u64,
    queue: SyncSender<String>,
    close: Closer,
}

/// The control connections, for broadcasts.
#[derive(Default)]
struct Clients {
    next: AtomicU64,
    list: Mutex<Vec<Client>>,
}

impl Clients {
    fn add(&self, queue: SyncSender<String>, close: Closer) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        lock(&self.list).push(Client { id, queue, close });
        id
    }

    fn remove(&self, id: u64) {
        lock(&self.list).retain(|c| c.id != id);
    }

    /// Queue `line` for every client without waiting; close (and forget) a client that has no
    /// room for it.
    fn broadcast(&self, line: &str) {
        lock(&self.list).retain(|c| match c.queue.try_send(line.to_owned()) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                log::warn!("control client {} is not reading: closed", c.id);
                (c.close)();
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        });
    }
}

/// What a host does once a `shutdown` was granted and its reply written: take down what it
/// published, and exit.
pub type OnShutdown = Arc<dyn Fn() + Send + Sync>;
/// How long the reply to a granted `shutdown` may take to be written before the host exits anyway: a
/// client that stopped reading must not keep a host that makes no more panes.
const SHUTDOWN_REPLY_WAIT: Duration = Duration::from_secs(5);

struct Ctx {
    panes: Arc<Panes>,
    info: HostInfo,
    clients: Clients,
    on_shutdown: OnShutdown,
}

/// Serve `listener` until a `shutdown` is granted (`on_shutdown`, which exits): the dispatcher
/// for `events` (the receiver `Panes::new` returned) and one thread per connection.
pub fn run<L: Listener>(
    listener: L,
    panes: Panes,
    events: Receiver<(String, PaneEvent)>,
    info: HostInfo,
    on_shutdown: OnShutdown,
) -> io::Result<()> {
    let ctx = Arc::new(Ctx {
        panes: Arc::new(panes),
        info,
        clients: Clients::default(),
        on_shutdown,
    });
    let dispatcher = ctx.clone();
    std::thread::Builder::new()
        .name("pty-dispatch".into())
        .spawn(move || {
            for (id, event) in events {
                if let Some(notice) = dispatcher.panes.event(&id, &event) {
                    dispatcher.clients.broadcast(&notice.to_line());
                }
            }
        })?;
    loop {
        match listener.accept() {
            Ok(conn) => {
                let ctx = ctx.clone();
                let spawned =
                    std::thread::Builder::new()
                        .name("pty-conn".into())
                        .spawn(move || {
                            if let Err(err) = connection(conn, &ctx) {
                                log::debug!("connection ended: {err}");
                            }
                        });
                if let Err(err) = spawned {
                    log::error!("no thread for a connection: {err}");
                }
            }
            Err(err) => {
                log::error!("accept failed: {err}");
                // Out of descriptors, say: do not spin.
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// One line, without its newline; `None` at the end of the stream. A line longer than `max`
/// is an error.
fn read_line(reader: &mut impl BufRead, max: usize) -> io::Result<Option<String>> {
    let mut buf = Vec::new();
    let n = reader.take(max as u64 + 1).read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
    } else if buf.len() > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "line too long"));
    }
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    String::from_utf8(buf)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Compare without stopping at the first difference.
fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

impl Ctx {
    /// The client's role, and the nonce the reply proves the token over. The client proves it
    /// knows the token with `auth` (it never sends the token itself).
    fn check_hello(&self, line: &str) -> Result<(Role, String), String> {
        let hello = serde_json::from_str::<HelloLine>(line)
            .map_err(|e| format!("bad hello: {e}"))?
            .hello;
        if !valid_nonce(&hello.nonce) {
            return Err("the nonce is not 64 hex digits".into());
        }
        if !same_secret(&hello.auth, &hello_auth(&self.info.token, &hello.nonce)) {
            return Err("wrong token: the auth does not prove this host's token".into());
        }
        if hello.protocol != PROTOCOL {
            return Err(format!(
                "protocol {} is not supported; this host speaks {PROTOCOL}",
                hello.protocol
            ));
        }
        Ok((hello.role, hello.nonce))
    }

    /// The hello reply, with the proof that this host knows the token.
    fn hello_ok(&self, nonce: &str) -> String {
        json!({"hello": {
            "ok": true,
            "instance": self.info.instance,
            "version": self.info.version,
            "pid": self.info.pid,
            "features": FEATURES,
            "proof": hello_proof(&self.info.token, nonce),
        }})
        .to_string()
    }

    /// The reply line for one request line, and whether it grants a `shutdown`: the host exits
    /// once that line is written.
    fn answer(&self, line: &str) -> (String, bool) {
        let failure = |id: u64, code: &str, reason: String| {
            let line = serde_json::to_string(&Failure::new(id, code, reason)).unwrap_or_default();
            (line, false)
        };
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => return failure(0, "bad_request", e.to_string()),
        };
        let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
        let request: Request = match serde_json::from_value(value) {
            Ok(r) => r,
            Err(e) => return failure(id, "bad_request", e.to_string()),
        };
        let shutdown = matches!(request.op, Op::Shutdown);
        let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.panes.handle(request.op)
        }));
        match handled {
            Ok(Ok(fields)) => {
                let mut out = Map::new();
                out.insert("id".into(), id.into());
                out.insert("ok".into(), true.into());
                out.extend(fields);
                (Value::Object(out).to_string(), shutdown)
            }
            Ok(Err(err)) => failure(id, err.code, err.reason),
            Err(_) => failure(id, "internal", "the host failed this request".into()),
        }
    }
}

fn write_line(w: &mut impl Write, line: &str) -> io::Result<()> {
    w.write_all(line.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

fn refuse<C: Connection>(conn: &mut C, code: &str, reason: &str) -> io::Result<()> {
    let line = json!({"hello": {"ok": false, "code": code, "reason": reason}}).to_string();
    let written = write_line(conn, &line);
    conn.shutdown();
    written
}

fn connection<C: Connection>(mut conn: C, ctx: &Ctx) -> io::Result<()> {
    conn.set_read_timeout(Some(HELLO_TIMEOUT))?;
    let mut reader = BufReader::new(conn.try_clone()?);
    let Some(line) = read_line(&mut reader, MAX_HELLO)? else {
        return Ok(());
    };
    match ctx.check_hello(&line) {
        Err(reason) => refuse(&mut conn, "incompatible", &reason),
        Ok((Role::Stream, nonce)) => {
            write_line(&mut conn, &ctx.hello_ok(&nonce))?;
            conn.set_read_timeout(None)?;
            crate::stream::serve(reader, conn, &ctx.panes)
        }
        Ok((Role::Control, nonce)) => {
            write_line(&mut conn, &ctx.hello_ok(&nonce))?;
            conn.set_read_timeout(None)?;
            control(reader, conn, ctx)
        }
    }
}

fn control<C: Connection>(mut reader: BufReader<C>, conn: C, ctx: &Ctx) -> io::Result<()> {
    let (queue, lines) = mpsc::sync_channel::<String>(QUEUE);
    let closer = Mutex::new(conn.try_clone()?);
    let mut writer = conn;
    let written = std::thread::Builder::new()
        .name("pty-conn-writer".into())
        .spawn(move || {
            for line in lines {
                if write_line(&mut writer, &line).is_err() {
                    writer.shutdown();
                    break;
                }
            }
        })?;
    let id = ctx
        .clients
        .add(queue.clone(), Box::new(move || lock(&closer).shutdown()));
    let mut shutdown = false;
    let ended = (|| {
        while let Some(line) = read_line(&mut reader, MAX_LINE)? {
            if line.trim().is_empty() {
                continue;
            }
            let (reply, granted) = ctx.answer(&line);
            if queue.send(reply).is_err() {
                break;
            }
            if granted {
                shutdown = true;
                break;
            }
        }
        Ok(())
    })();
    ctx.clients.remove(id);
    if shutdown {
        // The reply first: the writer ends once every handle on its queue is gone (the clients
        // list's went above), after what is queued is written.
        drop(queue);
        let exit = ctx.on_shutdown.clone();
        let _ = std::thread::Builder::new()
            .name("pty-shutdown".into())
            .spawn(move || {
                std::thread::sleep(SHUTDOWN_REPLY_WAIT);
                exit();
            });
        let _ = written.join();
        log::info!("shutdown granted: no panes left; exiting");
        (ctx.on_shutdown)();
    }
    // The writer sends what is queued, then ends; the socket closes with the last handle.
    ended
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_line_limits_and_trims() {
        let mut r = BufReader::new(&b"ab\r\ncd\nlong-line\nlast"[..]);
        assert_eq!(read_line(&mut r, 100).unwrap().as_deref(), Some("ab"));
        assert_eq!(read_line(&mut r, 100).unwrap().as_deref(), Some("cd"));
        assert!(read_line(&mut r, 4).is_err());
        let mut r = BufReader::new(&b"last"[..]);
        assert_eq!(read_line(&mut r, 100).unwrap().as_deref(), Some("last"));
        assert_eq!(read_line(&mut r, 100).unwrap(), None);
    }

    #[test]
    fn tokens_compare_whole() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "ab"));
    }

    fn ctx() -> Ctx {
        let (panes, _events) = Panes::new(100, "p1");
        Ctx {
            panes: Arc::new(panes),
            info: HostInfo {
                token: "tok".into(),
                instance: "p1".into(),
                version: "v".into(),
                pid: 1,
            },
            clients: Clients::default(),
            on_shutdown: Arc::new(|| {}),
        }
    }

    const NONCE: &str = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";

    fn hello_line(auth: &str, nonce: &str, protocol: u32) -> String {
        format!(
            r#"{{"hello":{{"auth":"{auth}","nonce":"{nonce}","protocol":{protocol},"role":"control","clientId":"c"}}}}"#
        )
    }

    #[test]
    fn hello_needs_the_proof_of_the_token_and_the_protocol() {
        let ctx = ctx();
        let auth = hello_auth("tok", NONCE);
        assert_eq!(
            ctx.check_hello(&hello_line(&auth, NONCE, PROTOCOL)),
            Ok((Role::Control, NONCE.to_owned()))
        );
        // An auth made with another token.
        let other = hello_auth("bad", NONCE);
        assert!(
            ctx.check_hello(&hello_line(&other, NONCE, PROTOCOL))
                .unwrap_err()
                .contains("token")
        );
        // An auth for another nonce (one replayed from another connection).
        let replayed = hello_auth("tok", &"1e".repeat(32));
        assert!(
            ctx.check_hello(&hello_line(&replayed, NONCE, PROTOCOL))
                .is_err()
        );
        assert!(
            ctx.check_hello(&hello_line(&auth, NONCE, PROTOCOL + 1))
                .unwrap_err()
                .contains("protocol")
        );
        // A nonce that is not 64 hex digits.
        assert!(
            ctx.check_hello(&hello_line(&hello_auth("tok", "xyz"), "xyz", PROTOCOL))
                .unwrap_err()
                .contains("nonce")
        );
        // The token itself, as the old hello carried it, is not a hello.
        let old = format!(
            r#"{{"hello":{{"token":"tok","protocol":{PROTOCOL},"role":"control","clientId":"c"}}}}"#
        );
        assert!(ctx.check_hello(&old).is_err());
        assert!(ctx.check_hello("{}").is_err());
    }

    #[test]
    fn the_reply_proves_the_token_and_cannot_be_reflected_as_an_auth() {
        let ctx = ctx();
        let reply: Value = serde_json::from_str(&ctx.hello_ok(NONCE)).unwrap();
        let proof = reply["hello"]["proof"].as_str().unwrap().to_owned();
        assert_eq!(proof, hello_proof("tok", NONCE));
        // A squatter that relays a client's nonce to the host and sends the host's proof back
        // as its own auth gets nothing.
        assert!(
            ctx.check_hello(&hello_line(&proof, NONCE, PROTOCOL))
                .unwrap_err()
                .contains("token")
        );
    }

    #[test]
    fn answers_carry_the_request_id() {
        let ctx = ctx();
        let answer = |line: &str| -> Value {
            let (reply, shutdown) = ctx.answer(line);
            assert!(!shutdown);
            serde_json::from_str(&reply).unwrap()
        };
        let v = answer(r#"{"id":7,"op":"titles"}"#);
        assert_eq!(v, json!({"id": 7, "ok": true, "titles": {}}));
        let v = answer(r#"{"id":8,"op":"bogus"}"#);
        assert_eq!(
            (v["id"].clone(), v["code"].clone()),
            (json!(8), json!("bad_request"))
        );
        let v = answer("not json");
        assert_eq!(
            (v["id"].clone(), v["code"].clone()),
            (json!(0), json!("bad_request"))
        );
    }

    #[test]
    fn only_a_granted_shutdown_says_so() {
        let ctx = ctx();
        let (reply, shutdown) = ctx.answer(r#"{"id":3,"op":"shutdown"}"#);
        assert!(shutdown);
        assert_eq!(
            serde_json::from_str::<Value>(&reply).unwrap(),
            json!({"id": 3, "ok": true})
        );
    }

    #[test]
    fn a_client_with_a_full_queue_is_closed_and_dropped() {
        let clients = Clients::default();
        let (slow, _keep) = mpsc::sync_channel(1);
        let (fast, fast_rx) = mpsc::sync_channel(10);
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let c = closed.clone();
        clients.add(slow, Box::new(move || c.store(true, Ordering::SeqCst)));
        clients.add(fast, Box::new(|| {}));
        clients.broadcast("one");
        assert!(!closed.load(Ordering::SeqCst));
        clients.broadcast("two");
        assert!(closed.load(Ordering::SeqCst));
        assert_eq!(lock(&clients.list).len(), 1);
        assert_eq!(fast_rx.try_iter().collect::<Vec<_>>(), ["one", "two"]);
    }
}
