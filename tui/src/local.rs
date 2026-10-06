//! Persistent local shells when the Harness daemon is unavailable. The supervisor owns
//! PTYs, independently of attached clients and their headless handoffs. Its private Unix
//! socket speaks the same terminal protocol as the daemon; it never listens on TCP.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use alacritty_terminal::event::{OnResize, WindowSize};
use alacritty_terminal::tty;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::unix::AsyncFd;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::pane::Pane;
use crate::proto::{self, Kind};

#[path = "local_screen.rs"]
mod screen;
pub use screen::{ScreenState, colour};

pub const MACHINE: &str = "hn-local-shells";
pub fn is_local(id: &str) -> bool { id == MACHINE }
pub fn pane_id(id: &str) -> Option<u64> { id.strip_prefix("local-")?.split('-').next()?.parse().ok() }

pub fn socket_path() -> PathBuf {
    let name = std::env::var("HN_SOCKET_NAME").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "default".into());
    // A different extension keeps this out of the ordinary clients' socket inventory.
    crate::ipc::dir().join(format!("{name}.pty"))
}

/// Reuse the supervisor or start one once, under the same private socket namespace.
pub async fn connect(port: u16) -> io::Result<UnixStream> {
    let path = socket_path();
    if let Ok(stream) = UnixStream::connect(&path).await { return Ok(stream) }
    let dir = crate::ipc::dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let lock_path = path.with_file_name(format!("{}.start", path.file_name().unwrap().to_string_lossy()));
    let lock = crate::ipc::lock(&lock_path).ok_or_else(|| io::Error::other("could not lock local shell startup"))?;
    if let Ok(stream) = UnixStream::connect(&path).await { drop(lock); return Ok(stream) }
    let name = std::env::var("HN_SOCKET_NAME").unwrap_or_else(|_| "default".into());
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command.args(["-L", &name, "--port", &port.to_string(), "--local-server"])
        .env("HN_SOCKET_NAME", &name).env("PORT", port.to_string())
        .env_remove("TMUX").env_remove("TMUX_PANE").env_remove("HN_SOCKET")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    unsafe { command.pre_exec(|| { if libc::setsid() < 0 { Err(io::Error::last_os_error()) } else { Ok(()) } }); }
    let mut child = command.spawn()?;
    std::thread::spawn(move || { let _ = child.wait(); });
    for _ in 0..100 {
        if let Ok(stream) = UnixStream::connect(&path).await { drop(lock); return Ok(stream) }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err(io::Error::new(io::ErrorKind::TimedOut, "the local shell supervisor did not start"))
}

/// kill-server ends this namespace's local shells as well. It never starts a supervisor.
pub async fn stop() {
    let work = async {
        let stream = UnixStream::connect(socket_path()).await?;
        let (mut ws, _) = tokio_tungstenite::client_async("ws://localhost/local-shells", stream).await.map_err(io::Error::other)?;
        ws.send(Message::text(json!({"type":"local_shutdown"}).to_string())).await.map_err(io::Error::other)?;
        while ws.next().await.is_some() {}
        Ok::<_, io::Error>(())
    };
    let _ = tokio::time::timeout(Duration::from_secs(3), work).await;
}

enum Event {
    Client(Uuid, mpsc::Sender<Message>),
    Message(Uuid, Message),
    Gone(Uuid),
    Output(String, Uuid, Vec<u8>),
    Eof(String, Uuid),
}

struct Client { tx: mpsc::Sender<Message>, selected: bool }
struct Stream { client: Uuid, seq: u64, input: u64, readonly: bool }
struct Shell {
    agent: Value,
    pty: Option<tty::Pty>,
    pid: u32,
    payload: Value,
    generation: Uuid,
    death: Option<crate::pane::Exit>,
    death_drawn: bool,
    eof: bool,
    waiting: bool,
    input: mpsc::UnboundedSender<Vec<u8>>,
    reader: tokio::task::JoinHandle<()>,
    pane: Pane,
    tail: Tail,
    streams: HashMap<Uuid, Stream>,
    controller: Option<Uuid>,
    ended: bool,
    exited: Option<Instant>,
    tty: String,
}

fn envelope(ty: &str, payload: Value) -> Message { Message::text(json!({"type":ty,"payload":payload}).to_string()) }
fn send(clients: &mut HashMap<Uuid, Client>, id: Uuid, message: Message) {
    if clients.get(&id).is_some_and(|c| c.tx.try_send(message).is_err()) { clients.remove(&id); }
}
fn reply(clients: &mut HashMap<Uuid, Client>, id: Uuid, ty: &str, request: &Value, mut payload: Value) {
    if let Some(rid) = request.get("requestId") { payload["requestId"] = rid.clone() }
    send(clients, id, envelope(ty, payload));
}
fn error(clients: &mut HashMap<Uuid, Client>, id: Uuid, ty: &str, request: &Value, code: &str, detail: impl ToString) {
    reply(clients, id, &format!("{ty}_result"), request, json!({"error":code,"detail":detail.to_string()}));
}
fn size(p: &Value) -> (u16, u16) {
    (p["cols"].as_u64().unwrap_or(80).clamp(1, 300) as u16, p["rows"].as_u64().unwrap_or(24).clamp(1, 120) as u16)
}
fn winsize(cols: u16, rows: u16) -> WindowSize { WindowSize { num_cols: cols, num_lines: rows, cell_width: 0, cell_height: 0 } }

/// Reading and writing use the same nonblocking PTY, with backpressure on output and
/// complete writes for input. In particular, a large paste is never truncated at EAGAIN.
async fn drive(file: std::fs::File, id: String, generation: Uuid, mut input: mpsc::UnboundedReceiver<Vec<u8>>, events: mpsc::Sender<Event>) {
    let Ok(fd) = AsyncFd::new(file) else { let _ = events.send(Event::Eof(id, generation)).await; return };
    let mut queue: VecDeque<Vec<u8>> = VecDeque::new();
    let mut offset = 0;
    let mut bytes = vec![0; 32 * 1024];
    loop {
        tokio::select! {
            incoming = input.recv() => match incoming { Some(b) => if !b.is_empty() { queue.push_back(b) }, None => break },
            ready = fd.readable() => {
                let Ok(mut ready) = ready else { break };
                match ready.try_io(|fd| (&*fd.get_ref()).read(&mut bytes)) {
                    Ok(Ok(0)) | Ok(Err(_)) => break,
                    Ok(Ok(n)) => if events.send(Event::Output(id.clone(), generation, bytes[..n].to_vec())).await.is_err() { return },
                    Err(_) => {}
                }
            }
            ready = fd.writable(), if !queue.is_empty() => {
                let Ok(mut ready) = ready else { break };
                let Some(front) = queue.front() else { continue };
                match ready.try_io(|fd| (&*fd.get_ref()).write(&front[offset..])) {
                    Ok(Ok(0)) | Ok(Err(_)) => break,
                    Ok(Ok(n)) => { offset += n; if offset == front.len() { queue.pop_front(); offset = 0; } }
                    Err(_) => {}
                }
            }
        }
    }
    let _ = events.send(Event::Eof(id, generation)).await;
}

impl Shell {
    fn new(id: String, payload: &Value, events: mpsc::Sender<Event>) -> io::Result<Self> {
        let shell = payload["shell"].as_str().map(str::to_string).or_else(|| std::env::var("SHELL").ok()).filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        let cwd = payload["cwd"].as_str().map(PathBuf::from).unwrap_or(std::env::current_dir()?);
        if !cwd.is_dir() { return Err(io::Error::new(io::ErrorKind::NotFound, "the shell's working directory does not exist")) }
        let mut env: HashMap<String, String> = payload["environment"].as_object().map(|values| values.iter().filter_map(|(k,v)| v.as_str().map(|v| (k.clone(), v.into()))).collect()).unwrap_or_else(|| std::env::vars().collect());
        env.insert("TERM".into(), payload["term"].as_str().unwrap_or("tmux-256color").into());
        env.insert("COLORTERM".into(), "truecolor".into());
        env.insert("SHELL".into(), shell.clone());
        // The primary socket name survives UI/headless ownership changes.
        let name = std::env::var("HN_SOCKET_NAME").unwrap_or_else(|_| "default".into());
        let socket = crate::ipc::dir().join(format!("{name}.sock"));
        env.insert("HN_SOCKET_NAME".into(), name);
        env.insert("HN_SOCKET".into(), socket.display().to_string());
        env.insert("TMUX".into(), format!("{},{},0", socket.display(), std::process::id()));
        if let Some(pane) = pane_id(&id) { env.insert("TMUX_PANE".into(), crate::pane::tag(pane)); }
        env.remove("HN_AS_TMUX");
        // tty::Options overlays inherited variables. Remove only absent names with env -u;
        // values stay in the child's environment, never in argv, and no process-wide
        // environment is mutated. Also remove the PTY library's graphical-window variables.
        let mut args = Vec::new();
        for key in std::env::vars().map(|(k,_)| k).chain(["ALACRITTY_WINDOW_ID".into(), "WINDOWID".into(), "USER".into(), "HOME".into()]) {
            if !env.contains_key(&key) { args.extend(["-u".into(), key]); }
        }
        // The final pane dimensions are known at terminal_open. Stop before exec so even
        // an immediate `stty size` sees that size, keeping one PID across the bootstrap.
        args.extend(["/bin/sh".into(), "-c".into(), "kill -STOP $$; exec \"$@\"".into(), "hn-local-shell".into()]);
        if let Some(command) = payload["command"].as_str() { args.extend([shell.clone(), "-c".into(), command.into()]); }
        else if let Some(argv) = payload["argv"].as_array() {
            let argv = argv.iter().map(|arg| arg.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()
                .filter(|argv| !argv.is_empty() && !argv[0].is_empty() && argv.iter().all(|arg| !arg.contains('\0')))
                .ok_or_else(|| io::Error::other("Invalid shell arguments."))?;
            args.extend(argv);
        }
        else { args.extend([shell.clone(), "-l".into(), "-i".into()]); }
        let options = tty::Options { shell: Some(tty::Shell::new("/usr/bin/env".into(), args)), working_directory: Some(cwd.clone()), env, drain_on_exit: true };
        let pty = tty::new(&options, winsize(80, 24), 0)?;
        // Observe, without reaping, only this newly forked child's stop (or an exec error).
        loop {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let got = unsafe { libc::waitid(libc::P_PID, pty.child().id() as libc::id_t, &mut info, libc::WSTOPPED | libc::WEXITED | libc::WNOWAIT) };
            if got == 0 && info.si_code == libc::CLD_STOPPED {
                // Consume only the known stop; macOS can otherwise surface this WNOWAIT
                // record again while asking for an exit, even after SIGCONT.
                unsafe { libc::waitid(libc::P_PID, pty.child().id() as libc::id_t, &mut info, libc::WSTOPPED); }
                break
            }
            if got < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted { continue }
            return Err(io::Error::other("local shell bootstrap failed"));
        }
        let file = pty.file().try_clone()?;
        let tty = unsafe { let p = libc::ptsname(pty.file().as_raw_fd()); if p.is_null() { String::new() } else { std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned() } };
        let (input, rx) = mpsc::unbounded_channel();
        let generation = Uuid::new_v4();
        let reader = tokio::spawn(drive(file, id.clone(), generation, rx, events));
        let label = shell.rsplit('/').next().unwrap_or("sh");
        let agent = json!({"id":id,"sessionId":id,"name":label,"engine":"terminal","status":"active","launch":{"state":"ready"},"terminal":{"available":true},"project":{"cwd":cwd,"root":cwd,"name":""}});
        let mut pane = Pane::new(0, MACHINE, &id, 80, 24);
        pane.enable_local();
        let pid = pty.child().id();
        Ok(Self { agent, pty: Some(pty), pid, payload: payload.clone(), generation, death: None, death_drawn: false, eof: false, waiting: true, input, reader, pane, tail: Tail::default(), streams: HashMap::new(), controller: None, ended: false, exited: None, tty })
    }

    fn start(&mut self) {
        if self.waiting { self.waiting = false; unsafe { libc::kill(self.pid as i32, libc::SIGCONT); } }
    }

    fn keyframe(&mut self, stream: Uuid, clients: &mut HashMap<Uuid, Client>) {
        let bytes = self.pane.local_snapshot(self.tail.bytes());
        let Some(s) = self.streams.get_mut(&stream) else { return };
        let mut payload = Vec::with_capacity(bytes.len() + 4);
        payload.extend_from_slice(&self.pane.cols.to_be_bytes());
        payload.extend_from_slice(&self.pane.rows.to_be_bytes());
        payload.extend(bytes);
        let bytes = proto::encode(Kind::Keyframe, stream, s.seq, &payload);
        s.seq += 1;
        send(clients, s.client, Message::binary(bytes));
    }

    fn resize(&mut self, cols: u16, rows: u16, clients: &mut HashMap<Uuid, Client>) {
        if (cols, rows) == (self.pane.cols, self.pane.rows) { return }
        if let Some(pty) = &mut self.pty { pty.on_resize(winsize(cols, rows)); }
        self.pane.resize_local(cols, rows);
        let ids: Vec<_> = self.streams.keys().copied().collect();
        for stream in ids { self.keyframe(stream, clients) }
    }

    fn close(&mut self, clients: &mut HashMap<Uuid, Client>, reason: &str) {
        self.ended = true;
        self.agent["status"] = json!("stopped");
        self.agent["terminal"]["available"] = json!(false);
        for (id, stream) in self.streams.drain() { send(clients, stream.client, envelope("terminal_closed", json!({"streamId":id.to_string(),"reason":reason}))); }
        self.controller = None;
    }
}

async fn connection(stream: UnixStream, id: Uuid, events: mpsc::Sender<Event>) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else { return };
    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::channel(128);
    if events.send(Event::Client(id, tx)).await.is_err() { return }
    loop {
        tokio::select! {
            outgoing = rx.recv() => match outgoing {
                Some(m) => if !matches!(tokio::time::timeout(Duration::from_secs(5), write.send(m)).await, Ok(Ok(()))) { break },
                None => break,
            },
            incoming = read.next() => match incoming {
                Some(Ok(Message::Ping(b))) => { if write.send(Message::Pong(b)).await.is_err() { break } }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(m)) => if events.send(Event::Message(id, m)).await.is_err() { break },
            }
        }
    }
    let _ = write.close().await;
    let _ = events.send(Event::Gone(id)).await;
}

fn child_exited(pid: u32) -> Option<crate::pane::Exit> {
    // SAFETY: a zeroed output record, a child we own, and WNOWAIT leave wait/reaping to Pty.
    unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        if libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) != 0 || info.si_pid() == 0 { return None }
        if !matches!(info.si_code, libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED) { return None }
        let status = info.si_status();
        Some(crate::pane::Exit { id: Uuid::new_v4().to_string(), status: (info.si_code == libc::CLD_EXITED).then_some(status), signal: (info.si_code != libc::CLD_EXITED).then_some(status), time: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64 })
    }
}

fn reap(mut shell: Shell) -> tokio::task::JoinHandle<()> { shell.reader.abort(); reap_pty(shell.pty.take()) }

fn reap_pty(pty: Option<tty::Pty>) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        let Some(pty) = pty else { return };
        let pid = pty.child().id() as i32;
        // The shell has its own session/process group. Stop its jobs with it, including a
        // foreground program which has moved to a separate process group on this PTY.
        let foreground = unsafe { libc::tcgetpgrp(pty.file().as_raw_fd()) };
        let groups: Vec<_> = [pid, foreground].into_iter().filter(|group| *group > 1 && (*group == pid || unsafe { libc::getsid(*group) } == pid)).collect();
        for group in &groups { unsafe { libc::kill(-*group, libc::SIGHUP); } }
        std::thread::sleep(Duration::from_millis(100));
        for group in groups { if group == pid || unsafe { libc::getsid(group) } == pid { unsafe { libc::kill(-group, libc::SIGKILL); } } }
        drop(pty);
    })
}

/// The internal process entry point. Each PTY's emulator stays here while clients come
/// and go; attaching receives an ordered keyframe followed by only later output.
pub async fn run(_port: u16) -> io::Result<()> {
    let path = socket_path();
    std::fs::create_dir_all(crate::ipc::dir())?;
    std::fs::set_permissions(crate::ipc::dir(), std::fs::Permissions::from_mode(0o700))?;
    if UnixStream::connect(&path).await.is_ok() { return Ok(()) }
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    let (tx, mut rx) = mpsc::channel(128);
    let mut clients: HashMap<Uuid, Client> = HashMap::new();
    let mut shells: HashMap<String, Shell> = HashMap::new();
    let mut reaping = Vec::new();
    let mut empty = Instant::now();
    let mut pulse = tokio::time::interval(Duration::from_millis(100));
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = terminate.recv() => break,
            accepted = listener.accept() => if let Ok((stream, _)) = accepted { tokio::spawn(connection(stream, Uuid::new_v4(), tx.clone())); },
            _ = pulse.tick() => {
                for shell in shells.values_mut().filter(|s| !s.ended) {
                    // Leave the child unreaped until Pty::drop. Its PID cannot be reused while
                    // cleanup signals its process group, and final output can still drain.
                    if shell.exited.is_none() { if let Some(death) = child_exited(shell.pid) { shell.exited = Some(Instant::now()); shell.death = Some(death); } }
                }
                // Let the PTY reader drain final output before announcing exit. A background
                // job retaining the slave must not keep its exited shell alive forever.
                for shell in shells.values_mut().filter(|s| !s.ended && s.exited.is_some_and(|at| s.eof || at.elapsed() >= Duration::from_millis(300))) {
                    shell.ended = true;
                    shell.agent["status"] = json!("stopped");
                    shell.reader.abort();
                    reaping.push(reap_pty(shell.pty.take()));
                    for (id, stream) in &shell.streams { send(&mut clients, stream.client, envelope("terminal_closed", json!({"streamId":id.to_string(),"reason":"exited","exit":shell.death}))); }
                }
                reaping.retain(|task| !task.is_finished());
                for shell in shells.values_mut() {
                    shell.streams.retain(|_,s| clients.contains_key(&s.client));
                    if shell.controller.is_some_and(|s| !shell.streams.contains_key(&s)) { shell.controller = None }
                }
                if clients.is_empty() && shells.is_empty() { if empty.elapsed() > Duration::from_secs(3) { break } } else { empty = Instant::now() }
            }
            event = rx.recv() => match event {
                Some(Event::Client(id, client)) => { clients.insert(id, Client { tx: client, selected: false }); }
                Some(Event::Gone(id)) => { clients.remove(&id); }
                Some(Event::Eof(id, generation)) => { if let Some(shell) = shells.get_mut(&id).filter(|s| s.generation == generation) { shell.eof = true; } }
                Some(Event::Output(id, generation, bytes)) => if let Some(shell) = shells.get_mut(&id).filter(|s| s.generation == generation) {
                    shell.tail.advance(&bytes);
                    shell.pane.feed(&bytes);
                    for reply in shell.pane.take_local_replies() { let _ = shell.input.send(reply); }
                    for (id, stream) in &mut shell.streams {
                        send(&mut clients, stream.client, Message::binary(proto::encode(Kind::Output, *id, stream.seq, &bytes)));
                        stream.seq += 1;
                    }
                },
                Some(Event::Message(client, Message::Binary(raw))) => {
                    let Some(frame) = proto::decode(&raw) else { continue };
                    let Some(shell) = shells.values_mut().find(|s| s.streams.contains_key(&frame.stream)) else { continue };
                    let stream = shell.streams.get_mut(&frame.stream).unwrap();
                    if stream.client != client || stream.readonly || shell.ended { continue }
                    if frame.kind == Kind::Input {
                        if frame.seq < stream.input { continue }
                        if frame.seq != stream.input {
                            send(&mut clients, client, envelope("terminal_error", json!({"streamId":frame.stream.to_string(),"code":"TERMINAL_INPUT_INVALID","expectedSeq":stream.input})));
                            continue;
                        }
                        stream.input += 1;
                    } else if frame.kind != Kind::Paste { continue }
                    if !frame.compressed {
                        let bytes = if frame.kind == Kind::Paste { paste(&frame.bytes, shell.pane.mode().contains(alacritty_terminal::term::TermMode::BRACKETED_PASTE)) } else { frame.bytes };
                        let _ = shell.input.send(bytes);
                    }
                }
                Some(Event::Message(client, Message::Text(raw))) => {
                    let Ok(value) = serde_json::from_str::<Value>(&raw) else { continue };
                    let ty = value["type"].as_str().unwrap_or("");
                    let p = value.get("payload").cloned().unwrap_or(json!({}));
                    if ty == "local_shutdown" { break }
                    if ty == "machine_select" {
                        if p["machineId"].as_str() == Some(MACHINE) {
                            if let Some(c) = clients.get_mut(&client) { c.selected = true }
                            send(&mut clients, client, envelope("connected", json!({"machineId":MACHINE})));
                        } else { send(&mut clients, client, envelope("machine_select_error", json!({"error":"MACHINE_UNAVAILABLE"}))); }
                        continue;
                    }
                    if !clients.get(&client).is_some_and(|c| c.selected) { continue }
                    match ty {
                        "shell_context_reply" => reply(&mut clients, client, "shell_context_reply_result", &p, json!({"ok":crate::shell_context::local_reply(&p)})),
                        "agents_list" => reply(&mut clients, client, "agents_list_result", &p, json!({"agents":shells.values().filter(|s| !s.ended || p["includeStopped"].as_bool() == Some(true)).map(|s| s.agent.clone()).collect::<Vec<_>>()})),
                        "agent_create" => {
                            if p["engine"].as_str() != Some("terminal") { error(&mut clients, client, ty, &p, "DAEMON_UNREACHABLE", "start the Harness daemon to create an agent"); continue }
                            let id = p["paneId"].as_u64().map(|pane| format!("local-{pane}-{}", Uuid::new_v4())).unwrap_or_else(|| Uuid::new_v4().to_string());
                            match Shell::new(id.clone(), &p, tx.clone()) {
                                Ok(shell) => { let agent = shell.agent.clone(); shells.insert(id, shell); reply(&mut clients, client, "agent_create_result", &p, json!({"agent":agent})); }
                                Err(e) => error(&mut clients, client, ty, &p, "SHELL_START_FAILED", e),
                            }
                        }
                        "agent_restart" => {
                            let Some(id) = p["agentId"].as_str().map(str::to_string) else { continue };
                            let Some(mut old) = shells.remove(&id) else { error(&mut clients, client, ty, &p, "NOT_FOUND", "no such local shell"); continue };
                            let mut payload = old.payload.clone();
                            for key in ["command", "cwd"] { if p[key].is_string() { payload[key] = p[key].clone() } }
                            match Shell::new(id.clone(), &payload, tx.clone()) {
                                Ok(mut shell) => {
                                    shell.resize(old.pane.cols, old.pane.rows, &mut clients);
                                    shell.pane.inherit_history(&old.pane);
                                    shell.start();
                                    shell.streams = std::mem::take(&mut old.streams);
                                    shell.controller = old.controller.take();
                                    for (sid, stream) in &shell.streams { send(&mut clients, stream.client, envelope("terminal_restarted", json!({"streamId":sid.to_string()}))); }
                                    for sid in shell.streams.keys().copied().collect::<Vec<_>>() { shell.keyframe(sid, &mut clients); }
                                    let agent = shell.agent.clone(); shells.insert(id, shell); reaping.push(reap(old));
                                    reply(&mut clients, client, "agent_restart_result", &p, json!({"agent":agent}));
                                }
                                Err(e) => { shells.insert(id, old); error(&mut clients, client, ty, &p, "SHELL_START_FAILED", e); }
                            }
                        }
                        "terminal_remain" => {
                            let Some(shell) = p["agentId"].as_str().and_then(|id| shells.get_mut(id)) else { continue };
                            if !shell.ended || shell.death_drawn || shell.death.as_ref().map(|e| e.id.as_str()) != p["exitId"].as_str() { continue }
                            shell.death_drawn = true;
                            let text = p["text"].as_str().unwrap_or("");
                            if !text.is_empty() {
                                let bytes = format!("\x1b[?6l\x1b[r\x1b[0m\x1b[{};1H\r\n{text}", shell.pane.rows);
                                shell.pane.feed(bytes.as_bytes());
                                let streams: Vec<_> = shell.streams.keys().copied().collect();
                                for id in streams { shell.keyframe(id, &mut clients) }
                            }
                        }
                        "agent_delete" => {
                            if let Some(mut shell) = p["agentId"].as_str().and_then(|id| shells.remove(id)) { shell.close(&mut clients, "deleted"); reaping.push(reap(shell)) }
                            reply(&mut clients, client, "agent_delete_result", &p, json!({}));
                        }
                        "terminal_open" => {
                            let Some(shell) = p["agentId"].as_str().and_then(|id| shells.get_mut(id)) else { reply(&mut clients, client, "terminal_error", &p, json!({"code":"TERMINAL_AGENT_NOT_FOUND"})); continue };
                            shell.streams.retain(|_,s| clients.contains_key(&s.client));
                            if shell.controller.is_some_and(|s| !shell.streams.contains_key(&s)) { shell.controller = None }
                            let stream = Uuid::new_v4();
                            let readonly = shell.controller.is_some() && p["takeover"].as_bool() != Some(true);
                            if !readonly {
                                if let Some(old) = shell.controller.take().and_then(|id| shell.streams.remove(&id).map(|s|(id,s))) { send(&mut clients, old.1.client, envelope("terminal_closed", json!({"streamId":old.0.to_string(),"takenBy":{"name":"another terminal"}}))); }
                                shell.controller = Some(stream);
                                let (cols, rows) = size(&p); shell.resize(cols, rows, &mut clients); shell.start();
                            }
                            shell.streams.insert(stream, Stream { client, seq: 0, input: 0, readonly });
                            reply(&mut clients, client, "terminal_ready", &p, json!({"streamId":stream.to_string(),"readOnly":readonly,"heldBy":{"name":"another terminal"},"exit":shell.death}));
                            shell.keyframe(stream, &mut clients);
                        }
                        "terminal_close" | "terminal_resize" | "terminal_resync" => {
                            let Some(id) = p["streamId"].as_str().and_then(|s| Uuid::parse_str(s).ok()) else { continue };
                            let Some(shell) = shells.values_mut().find(|s| s.streams.get(&id).is_some_and(|s| s.client == client)) else { continue };
                            if ty == "terminal_close" { shell.streams.remove(&id); if shell.controller == Some(id) { shell.controller = None } }
                            else if ty == "terminal_resync" { shell.keyframe(id, &mut clients) }
                            else if shell.controller == Some(id) { let (cols, rows) = size(&p); shell.resize(cols, rows, &mut clients) }
                        }
                        "terminal_info" => {
                            let Some(shell) = p["agentId"].as_str().and_then(|id| shells.get(id)) else { error(&mut clients, client, ty, &p, "NOT_FOUND", "no such local shell"); continue };
                            let pid = shell.pid;
                            let group = shell.pty.as_ref().map(|pty| unsafe { libc::tcgetpgrp(pty.file().as_raw_fd()) }).unwrap_or(0);
                            let foreground = if group > 0 { group as u32 } else { pid };
                            let cwd = (!shell.ended).then(|| process_cwd(foreground).or_else(|| process_cwd(pid))).flatten().or_else(|| shell.pane.cwd.clone()).unwrap_or_else(|| shell.agent["project"]["cwd"].as_str().unwrap_or("").to_string());
                            let command = if shell.ended { String::new() } else { process_name(foreground).unwrap_or_default() };
                            reply(&mut clients, client, "terminal_info_result", &p, json!({"pid":pid,"tty":shell.tty,"path":cwd,"command":command,"startCommand":shell.payload["command"]}));
                        }
                        "fs_list_dir" => reply(&mut clients, client, "fs_list_dir_result", &p, json!({"path":std::env::var("HOME").unwrap_or_default(),"entries":[]})),
                        "message" => if let Some(shell) = p["agentId"].as_str().and_then(|id| shells.get(id)) {
                            if let Some(text) = p["content"].as_str() { let _ = shell.input.send(format!("{text}\r").into_bytes()); }
                        },
                        "terminal_alive" | "terminal_ack" | "terminal_focus" => {},
                        _ => if p.get("requestId").is_some() { error(&mut clients, client, ty, &p, "DAEMON_UNREACHABLE", "start the Harness daemon to use this feature") },
                    }
                }
                _ => {}
            }
        }
    }
    clients.clear();
    for (_, shell) in shells { reaping.push(reap(shell)) }
    for task in reaping { let _ = task.await; }
    drop(listener);
    let _ = std::fs::remove_file(path);
    Ok(())
}

/// Prefix of an unfinished UTF-8 scalar or escape sequence. Replaying it after a
/// snapshot lets a following delta finish the same parser operation after reattach.
#[derive(Default)]
struct Tail { parser: alacritty_terminal::vte::Parser, pending: Vec<u8> }
impl Tail {
    fn bytes(&self) -> &[u8] { &self.pending }
    fn advance(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.pending.push(*b);
            let mut end = Boundary::default();
            self.parser.advance(&mut end, &[*b]);
            if end.complete { self.pending.clear() }
            else if end.control { self.pending.pop(); }
            // VTE caps strings itself. Do not retain an unbounded malformed OSC here.
            if self.pending.len() > 1024 * 1024 { self.pending.clear() }
        }
    }
}
#[derive(Default)]
struct Boundary { complete: bool, control: bool }
impl alacritty_terminal::vte::Perform for Boundary {
    fn print(&mut self, _: char) { self.complete = true }
    fn execute(&mut self, _: u8) { self.control = true }
    fn esc_dispatch(&mut self, _: &[u8], _: bool, _: u8) { self.complete = true }
    fn csi_dispatch(&mut self, _: &alacritty_terminal::vte::Params, _: &[u8], _: bool, _: char) { self.complete = true }
    fn osc_dispatch(&mut self, _: &[&[u8]], _: bool) { self.complete = true }
    fn unhook(&mut self) { self.complete = true }
}

/// The daemon pastes with tmux paste-buffer -p: LF becomes Enter, bracketed only when
/// the pane requested it. Keep the complete paste queued together, including both marks.
fn paste(bytes: &[u8], bracket: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + if bracket { 12 } else { 0 });
    if bracket { out.extend_from_slice(b"\x1b[200~"); }
    out.extend(bytes.iter().map(|b| if *b == b'\n' { b'\r' } else { *b }));
    if bracket { out.extend_from_slice(b"\x1b[201~"); }
    out
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    // SAFETY: libproc writes at most the supplied, correctly sized output structure.
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    if unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size) } != size { return None }
    let bytes: Vec<_> = info.pvi_cdir.vip_path.iter().flatten().map(|c| *c as u8).take_while(|c| *c != 0).collect();
    (!bytes.is_empty()).then(|| String::from_utf8_lossy(&bytes).into_owned())
}
#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> { std::fs::read_link(format!("/proc/{pid}/cwd")).ok().map(|p| p.display().to_string()) }
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_cwd(_: u32) -> Option<String> { None }

#[cfg(target_os = "macos")]
fn process_name(pid: u32) -> Option<String> {
    let mut bytes = [0u8; 1024];
    // SAFETY: libproc writes into the bounded byte buffer supplied here.
    let n = unsafe { libc::proc_name(pid as i32, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&bytes[..n as usize]).trim_end_matches('\0').to_string())
}
#[cfg(target_os = "linux")]
fn process_name(pid: u32) -> Option<String> { std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|s| s.trim_end().to_string()) }
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_name(_: u32) -> Option<String> { None }

/// tmux uses sys_signame on macOS/BSD and a numeric fallback on Linux.
pub fn signal_name(signal: i32) -> String {
    if cfg!(target_os = "linux") { return signal.to_string() }
    #[cfg(target_os = "macos")]
    match signal { libc::SIGEMT => return "emt".into(), libc::SIGINFO => return "info".into(), _ => {} }
    match signal {
        libc::SIGHUP => "HUP", libc::SIGINT => "INT", libc::SIGQUIT => "QUIT", libc::SIGILL => "ILL",
        libc::SIGTRAP => "TRAP", libc::SIGABRT => "ABRT", libc::SIGBUS => "BUS", libc::SIGFPE => "FPE",
        libc::SIGKILL => "KILL", libc::SIGSEGV => "SEGV", libc::SIGPIPE => "PIPE", libc::SIGALRM => "ALRM",
        libc::SIGTERM => "TERM", libc::SIGUSR1 => "USR1", libc::SIGUSR2 => "USR2", libc::SIGXCPU => "XCPU",
        libc::SIGXFSZ => "XFSZ", libc::SIGCHLD => "CHLD", libc::SIGCONT => "CONT",
        libc::SIGSTOP => "STOP", libc::SIGTSTP => "TSTP", libc::SIGTTIN => "TTIN", libc::SIGTTOU => "TTOU",
        libc::SIGURG => "URG", libc::SIGVTALRM => "VTALRM", libc::SIGPROF => "PROF",
        libc::SIGWINCH => "WINCH", libc::SIGIO => "IO", libc::SIGSYS => "SYS", _ => return signal.to_string(),
    }.to_ascii_lowercase()
}
