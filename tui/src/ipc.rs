//! The shell's way in, as tmux's socket is: a running hn listens on /tmp/hn-<uid>/<name>.sock
//! (-L name, else `default`; a second client of the name on <name>@<pid>.sock beside it; 0600, in
//! a 0700 directory, as tmux's /tmp/tmux-<uid>), and `hn <tmux command>` from any shell runs the
//! command there and prints what it prints — `hn display -p '#{pane_current_path}'`,
//! `hn send-keys -t 1 'make' Enter`, `hn capture-pane -p`, `hn list-panes -F '#{pane_id}'`. A
//! command naming a session another client of the name has goes to that client.

use std::path::PathBuf;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::event::Event;

unsafe extern "C" { fn getuid() -> u32; }

/// Where the sockets live: short enough for a socket path (104 bytes on macOS), private to you.
/// This client's own socket, once it listens: what HN_SOCKET says to the commands it runs, and
/// #{socket_path}.
static HERE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Set while this client runs a command another client passed it: it asks no client in turn (two
/// clients each waiting on the other would freeze both).
static FORWARDED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Where commands are handed to the app loop (claim_name's listener too), and whether this client
/// has taken the name's socket.
static SINK: std::sync::OnceLock<mpsc::UnboundedSender<Event>> = std::sync::OnceLock::new();
static CLAIMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn forwarded() -> bool { FORWARDED.load(std::sync::atomic::Ordering::Relaxed) }
pub fn here() -> Option<PathBuf> { HERE.get().cloned() }

/// A client with no terminal (hn --headless) marks its socket so (`<socket>.headless`): the
/// clients with one run what shows on a terminal first.
pub fn mark_headless(socket: &std::path::Path) { let _ = std::fs::write(socket.with_extension("headless"), b""); }

/// This client typed into just now (`<socket>.activity`'s time): where a command from a shell
/// with no target goes, as tmux's cmd_find_best_client takes the client used last.
pub fn mark_active() { if let Some(here) = here() { let _ = std::fs::write(here.with_extension("activity"), b""); } }

/// A terminal's usable dimensions, kept beside its socket. A command can use its invoking
/// client's size even when its target belongs to another client, without asking that client's
/// event loop while it might already be waiting on this one.
pub fn publish_size(size: (u16, u16)) {
    let Some(own) = here() else { return };
    let value = format!("{},{}", size.0, size.1);
    let write = |socket: &std::path::Path| {
        let path = socket.with_extension("size");
        if std::fs::read_to_string(&path).ok().as_deref() != Some(&value) { let _ = std::fs::write(path, &value); }
    };
    write(&own);
    if CLAIMED.load(std::sync::atomic::Ordering::Relaxed) {
        if let Some(name) = own.file_stem().and_then(|s| s.to_str()).and_then(|s| s.split('@').next()) { write(&own.with_file_name(format!("{name}.sock"))); }
    }
}

fn saved_size(socket: &std::path::Path) -> Option<(u16, u16)> {
    if is_headless(socket) { return None }
    let value = std::fs::read_to_string(socket.with_extension("size")).ok()?;
    let (x, y) = value.split_once(',')?;
    let size = (x.parse().ok()?, y.parse().ok()?);
    (size.0 > 0 && size.1 > 0).then_some(size)
}

/// The command's client is its enclosing pane's client, or the attached client used last.
/// This is independent of the socket chosen for its target session.
fn command_size(target: &std::path::Path) -> Option<(u16, u16)> {
    if let Some(inside) = std::env::var("HN_SOCKET").ok().filter(|s| !s.is_empty()) { return saved_size(std::path::Path::new(&inside)) }
    let name = target.file_stem()?.to_str()?.split('@').next()?;
    busiest(name).and_then(|c| saved_size(&c)).or_else(|| saved_size(target))
}

/// Of this name's clients with a terminal, the one used last, ahead of a detached server.
pub fn busiest(name: &str) -> Option<PathBuf> {
    let attached: Vec<PathBuf> = clients_of(name).into_iter().filter(|p| !is_headless(p)).collect();
    if attached.is_empty() { return None }
    let when = |p: &PathBuf| std::fs::metadata(p.with_extension("activity")).and_then(|m| m.modified()).or_else(|_| std::fs::metadata(p).and_then(|m| m.modified())).ok();
    attached.into_iter().max_by_key(|p| when(p))
}

/// Whether the client at [socket] has no terminal.
pub fn is_headless(socket: &std::path::Path) -> bool { socket.with_extension("headless").exists() }

pub fn dir() -> PathBuf {
    let base = std::env::var("HN_TMPDIR").or_else(|_| std::env::var("TMUX_TMPDIR")).unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(base).join(format!("hn-{}", unsafe { getuid() }))
}

/// Listen for commands from shells; each is run on the app loop, its output sent back.
pub fn serve(sink: mpsc::UnboundedSender<Event>, port: u16) -> Option<PathBuf> {
    let dir = dir();
    std::fs::create_dir_all(&dir).ok()?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)); }
    // Sockets of clients gone are swept.
    sweep(&dir);
    // Named with -L (as tmux's), else `default`. The name's socket is its first client's: one
    // already listening there keeps it (commands go there), and this one listens beside it,
    // named with its pid — both reach every session of the name (a command naming one goes to
    // the client that has it).
    let name = std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "default".into());
    let primary = dir.join(format!("{name}.sock"));
    let (listener, path) = match tokio::net::UnixListener::bind(&primary) {
        Ok(l) => (l, primary),
        Err(_) => {
            let beside = dir.join(format!("{name}@{}.sock", std::process::id()));
            let _ = std::fs::remove_file(&beside);
            (tokio::net::UnixListener::bind(&beside).ok()?, beside)
        }
    };
    let _ = HERE.set(path.clone());
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)); }
    // Which daemon this client talks to, beside its socket: `hn -L name list-harnesses` asks that
    // one, never another it happens to find on the default port.
    let _ = std::fs::write(path.with_extension("port"), port.to_string());
    let _ = SINK.set(sink.clone());
    accept(listener, sink);
    Some(path)
}

/// Each connection's command run on the app loop, its output sent back.
fn accept(listener: tokio::net::UnixListener, sink: mpsc::UnboundedSender<Event>) {
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let sink = sink.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut line = String::new();
                // A connection that says nothing (whether this client answers) runs nothing.
                if BufReader::new(read).read_line(&mut line).await.is_err() || line.trim().is_empty() { return }
                // {"argv": [...], "cwd": "..."} (or just the words, from an older hn).
                let request: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
                let words: Vec<String> = request.get("argv").or(Some(&request)).and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
                let cwd = request.get("cwd").and_then(Value::as_str).map(str::to_string);
                let stdin = request.get("stdin").and_then(Value::as_str).map(str::to_string);
                let client_size = serde_json::from_value::<(u16, u16)>(request["client_size"].clone()).ok().filter(|(x, y)| *x > 0 && *y > 0);
                let passed = request.get("forwarded").and_then(Value::as_bool).unwrap_or(false);
                // From a shell outside hn (not its jobs', not another client's): no client's.
                let outside = !passed && !request.get("inside").and_then(Value::as_bool).unwrap_or(false);
                let (tx, rx) = oneshot::channel::<crate::app::Reply>();
                let asked = words.clone();
                let job: Box<dyn FnOnce(&mut crate::app::App) + Send> = Box::new(move |app: &mut crate::app::App| {
                    app.capture = Some(Vec::new());
                    app.capture_err = Some(Vec::new());
                    app.cli_tx = Some(tx);
                    app.cli_code = 0;
                    app.cli_cwd = cwd;
                    app.cli_size = client_size;
                    app.cli_stdin = stdin;
                    app.cli_outside = outside;
                    FORWARDED.store(passed, std::sync::atomic::Ordering::Relaxed);
                    crate::commands::execute_args(app, &words);
                    FORWARDED.store(false, std::sync::atomic::Ordering::Relaxed);
                    // Another client's command (one showing a session of this one's): what it
                    // changed written before it hears back, so it shows it at once.
                    if passed { app.save_if_changed() }
                    // Still waiting on a job (run-shell, if-shell): it answers when it is done.
                    if app.capture.is_some() { app.finish_cli() }
                });
                let _ = sink.send(Event::Apply(Box::new(move |app: &mut crate::app::App| app.run_cli(&asked, job))));
                let (mut out, err, code) = rx.await.unwrap_or_else(|_| (Vec::new(), vec!["command did not complete".into()], 1));
                // A last line marked bare (show-buffer's data without a newline) is printed bare.
                let bare = out.last().map(|l| l.ends_with(crate::app::BARE)).unwrap_or(false);
                if let Some(l) = out.last_mut() { if let Some(s) = l.strip_suffix(crate::app::BARE) { *l = s.to_string() } }
                let _ = write.write_all(format!("{}\n", json!({ "out": out, "err": err, "code": code, "bare": bare })).as_bytes()).await;
            });
        }
    });
}

/// The name's socket (`work.sock`) when no client answers there any more — its client gone, or
/// hn with no terminal handed over — taken by this one beside its own, so `-S …/work.sock` and
/// `-L work` keep reaching the server, as tmux's one socket does. (Checked every two seconds.)
pub fn claim_name() {
    if CLAIMED.load(std::sync::atomic::Ordering::Relaxed) { return }
    let name = std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "default".into());
    let primary = dir().join(format!("{name}.sock"));
    if here().as_deref() == Some(primary.as_path()) || answers(&primary) { return }
    let Some(sink) = SINK.get().cloned() else { return };
    let Some(_held) = lock(&primary) else { return };
    // (Another client may have taken it while this one waited for the lock.)
    if answers(&primary) { return }
    let _ = std::fs::remove_file(&primary);
    let Ok(std_listener) = std::os::unix::net::UnixListener::bind(&primary) else { return };
    let _ = std_listener.set_nonblocking(true);
    let Ok(listener) = tokio::net::UnixListener::from_std(std_listener) else { return };
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&primary, std::fs::Permissions::from_mode(0o600)); }
    if let Some(own) = here() {
        for ext in ["port", "size"] { if let Ok(value) = std::fs::read_to_string(own.with_extension(ext)) { let _ = std::fs::write(primary.with_extension(ext), value); } }
        // The primary name is now an alias of this client, including whether it has a
        // terminal. A former owner's marker must never turn a server into an attached UI.
        if is_headless(&own) { mark_headless(&primary); }
        else { let _ = std::fs::remove_file(primary.with_extension("headless")); }
        let stamp = std::fs::metadata(own.with_extension("activity")).or_else(|_| std::fs::metadata(&own)).and_then(|m| m.modified());
        if let Ok(stamp) = stamp {
            if let Ok(file) = std::fs::File::create(primary.with_extension("activity")) { let _ = file.set_times(std::fs::FileTimes::new().set_modified(stamp)); }
        }
    }
    CLAIMED.store(true, std::sync::atomic::Ordering::Relaxed);
    accept(listener, sink);
}

/// Another client told something (hn-server-sync, hn-mirror-refresh): sent, and its answer
/// waited for off the app loop (5s at most).
pub async fn notify(peer: &std::path::Path, words: &[String]) {
    let Ok(stream) = tokio::net::UnixStream::connect(peer).await else { return };
    let (read, mut write) = stream.into_split();
    let line = format!("{}\n", json!({ "argv": words, "forwarded": true }));
    if write.write_all(line.as_bytes()).await.is_err() { return }
    let mut reply = String::new();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), BufReader::new(read).read_line(&mut reply)).await;
}

/// The same, from a client that is going: sent now, not waited for.
pub fn notify_now(peer: &std::path::Path, words: &[String]) {
    use std::io::Write;
    let Ok(mut stream) = std::os::unix::net::UnixStream::connect(peer) else { return };
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(300)));
    let _ = stream.write_all(format!("{}\n", json!({ "argv": words, "forwarded": true })).as_bytes());
}

/// What hn's jobs (run-shell, if-shell, #(), copy-pipe) run with, as tmux's run with TMUX set:
/// HN_SOCKET naming this client, TMUX saying they run under one, and a `tmux` on the PATH that
/// is hn — so a script's (or a plugin's) `tmux …` reaches this client, never a tmux server.
pub fn job_env() -> Vec<(String, String)> { job_env_with(&std::env::var("PATH").unwrap_or_default()) }

/// job_env over the PATH [path] (the server's, set-environment's).
pub fn job_env_with(path: &str) -> Vec<(String, String)> {
    let mut env = Vec::new();
    let Some(sock) = here() else { return env };
    env.push(("HN_SOCKET".into(), sock.display().to_string()));
    env.push(("TMUX".into(), format!("{},{},0", sock.display(), std::process::id())));
    if let Some(bin) = shim() { env.push(("PATH".into(), format!("{}:{path}", bin.display()))); }
    env
}

/// A job's whole environment, as tmux's job_run gives one (environ_for_session): the server's
/// global environment with the session's over it (a variable marked to go, gone), and job_env's
/// on top. None while the global environment is not known (the process's is used then).
pub fn job_environ(global: &std::collections::BTreeMap<String, crate::app::EnvVar>, session: &std::collections::BTreeMap<String, crate::app::EnvVar>) -> Option<Vec<(String, String)>> {
    if global.is_empty() { return None }
    let mut m: std::collections::BTreeMap<String, Option<String>> = global.iter().map(|(k, v)| (k.clone(), v.value.clone())).collect();
    for (k, v) in session { m.insert(k.clone(), v.value.clone()); }
    let path = m.get("PATH").cloned().flatten().unwrap_or_default();
    let mut out: Vec<(String, String)> = m.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))).collect();
    for (k, v) in job_env_with(&path) { out.retain(|(x, _)| *x != k); out.push((k, v)) }
    Some(out)
}

/// A job's command given its environment: the whole of [env] when known, else job_env over hn's.
pub fn set_job_env(c: &mut tokio::process::Command, env: &Option<Vec<(String, String)>>) {
    match env { Some(e) => { c.env_clear(); c.envs(e.iter().cloned()); } None => { c.envs(job_env()); } }
}

/// The folder holding hn's `tmux` (made once): a script running this hn as tmux.
fn shim() -> Option<PathBuf> {
    static SHIM: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    SHIM.get_or_init(|| {
        // One folder per hn binary: a test build's tmux never stands in for another hn's.
        let me = std::env::current_exe().ok()?;
        let tag = { use std::hash::{Hash, Hasher}; let mut h = std::collections::hash_map::DefaultHasher::new(); me.hash(&mut h); h.finish() };
        let bin = dir().join(format!("bin-{tag:016x}"));
        std::fs::create_dir_all(&bin).ok()?;
        let script = format!("#!/bin/sh\n# hn's tmux: what hn runs reaches hn, not a tmux server.\nHN_AS_TMUX=1 exec '{}' \"$@\"\n", me.display().to_string().replace('\'', "'\\''"));
        let path = bin.join("tmux");
        if std::fs::read_to_string(&path).ok().as_deref() != Some(script.as_str()) {
            let tmp = bin.join(format!(".tmux.{}", std::process::id()));
            std::fs::write(&tmp, &script).ok()?;
            #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).ok()?; }
            std::fs::rename(&tmp, &path).ok()?;
        }
        Some(bin)
    }).clone()
}

/// tmux's find_cwd: $PWD when it is where we are (symlinks kept, as the shell shows it), else
/// the real folder.
fn find_cwd() -> Option<String> {
    let cwd = std::env::current_dir().ok()?;
    let Some(pwd) = std::env::var("PWD").ok().filter(|p| !p.is_empty()) else { return Some(cwd.display().to_string()) };
    match (std::fs::canonicalize(&pwd), std::fs::canonicalize(&cwd)) {
        (Ok(a), Ok(b)) if a == b => Some(pwd),
        _ => Some(cwd.display().to_string()),
    }
}

/// Remove sockets nobody answers on (a client that was killed), and the ports beside them.
fn sweep(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let name = std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "default".into());
    for e in entries.flatten() {
        let p = e.path();
        // Starting one namespace must not remove another server's closed socket: tmux
        // keeps it so later commands distinguish a stopped server from one never started.
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if stem != name && !stem.strip_prefix(&name).is_some_and(|s| s.starts_with('@')) { continue }
        if p.extension().map(|x| x == "sock").unwrap_or(false) && std::os::unix::net::UnixStream::connect(&p).is_err() {
            let _ = std::fs::remove_file(&p);
            for ext in ["port", "headless", "activity", "size"] { let _ = std::fs::remove_file(p.with_extension(ext)); }
        }
        if p.extension().map(|x| x == "port").unwrap_or(false) && !p.with_extension("sock").exists() { let _ = std::fs::remove_file(&p); }
    }
}

/// The daemon port of the client a command names (-S, -L, $HN_SOCKET, else the newest one): what
/// it wrote beside its socket. None when no client is found.
pub fn client_port(socket: Option<&str>, name: Option<&str>) -> Option<u16> {
    let path = chosen(socket, name)?;
    std::fs::read_to_string(path.with_extension("port")).ok()?.trim().parse().ok()
}

/// Which client to ask: -S path, -L name, $HN_SOCKET, $HN_SOCKET_NAME (what a client sets for
/// what it runs, as tmux's $TMUX: a job's `hn …` reaches the client that ran it), else the newest.
/// A name's first client, else another of its clients still running.
pub fn chosen(socket: Option<&str>, name: Option<&str>) -> Option<PathBuf> {
    // -S and -L say which, before $HN_SOCKET (a job's `tmux -L other ls` asks the other).
    if let Some(p) = socket { return Some(PathBuf::from(p)) }
    if let Some(n) = name { return Some(clients_of(n).into_iter().next().unwrap_or_else(|| dir().join(format!("{n}.sock")))) }
    if let Some(p) = std::env::var("HN_SOCKET").ok().filter(|s| !s.is_empty()) { return Some(PathBuf::from(p)) }
    // $TMUX naming an hn socket (what hn's jobs run with; kept where $HN_SOCKET is not, by sudo
    // or `env -i TMUX=…`): that client, as tmux takes its server from $TMUX. (A real tmux's
    // socket is not hn's: hn's own are found as before.)
    if let Some(p) = std::env::var("TMUX").ok().and_then(|t| t.split(',').next().map(PathBuf::from)).filter(|p| p.starts_with(dir())) { return Some(p) }
    let name = std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty());
    if let Some(n) = name { return Some(clients_of(&n).into_iter().next().unwrap_or_else(|| dir().join(format!("{n}.sock")))) }
    if let Some(p) = clients_of("default").into_iter().next() { return Some(p) }
    newest()
}

/// A client goes: its socket with it — but the name's own (`work.sock`) stays, nothing listening
/// on it, when it was the name's first client or the last to go, as tmux's server leaves its
/// socket: the next command says `no server running on …` (a name never used: `error connecting`).
pub fn gone(path: &std::path::Path) {
    let _ = std::fs::remove_file(path.with_extension("port"));
    let _ = std::fs::remove_file(path.with_extension("activity"));
    let _ = std::fs::remove_file(path.with_extension("size"));
    let name = std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "default".into());
    let primary = dir().join(format!("{name}.sock"));
    if path == primary { return }
    let _ = std::fs::remove_file(path);
    if path.parent() == primary.parent() && !primary.exists() && clients_of(&name).is_empty() {
        drop(std::os::unix::net::UnixListener::bind(&primary));
    }
}

/// Whether a client listens at [path] (the connection is let go at once, and runs nothing).
pub fn answers(path: &std::path::Path) -> bool { std::os::unix::net::UnixStream::connect(path).is_ok() }

/// A server name's running clients: its first one's socket (`work.sock`), then the others'
/// (`work@4242.sock`), the newest first.
pub fn clients_of(name: &str) -> Vec<PathBuf> {
    let dir = dir();
    let primary = dir.join(format!("{name}.sock"));
    let mut found = Vec::new();
    if answers(&primary) { found.push(primary) }
    let prefix = format!("{name}@");
    let mut more: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&dir).map(|d| d.filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "sock").unwrap_or(false) && p.file_name().and_then(|f| f.to_str()).map(|f| f.starts_with(&prefix)).unwrap_or(false))
        .filter_map(|p| std::fs::metadata(&p).and_then(|m| m.modified()).ok().map(|t| (t, p))).collect()).unwrap_or_default();
    more.sort();
    found.extend(more.into_iter().rev().map(|(_, p)| p).filter(|p| answers(p)));
    found
}

/// clients_of, less this process's own sockets (its own, and the name's when it took it).
pub fn others_of(name: &str) -> Vec<PathBuf> {
    let primary = dir().join(format!("{name}.sock"));
    let claimed = CLAIMED.load(std::sync::atomic::Ordering::Relaxed);
    clients_of(name).into_iter().filter(|p| Some(p) != here().as_ref() && !(claimed && *p == primary)).collect()
}

/// Whether a client is running where a command would go (its socket answers).
pub fn alive(socket: Option<&str>, name: Option<&str>) -> bool {
    chosen(socket, name).map(|p| answers(&p)).unwrap_or(false)
}

/// A command run by another client, from this one's loop (a command naming a session that
/// client has; that client giving a session up): what it printed, its errors and its status —
/// none when it does not answer in time.
pub fn ask(path: &std::path::Path, words: &[String]) -> Option<crate::app::Reply> { ask_with_size(path, words, None) }

/// Forward a user command while retaining its invoking terminal's geometry.
pub fn ask_with_size(path: &std::path::Path, words: &[String], size: Option<(u16, u16)>) -> Option<crate::app::Reply> {
    use std::io::{BufRead, Write};
    // Serving another client's command: never wait on a client (it may be the one waiting).
    if forwarded() { return None }
    let mut s = std::os::unix::net::UnixStream::connect(path).ok()?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok()?;
    s.set_write_timeout(Some(std::time::Duration::from_secs(2))).ok()?;
    writeln!(s, "{}", json!({ "argv": words, "cwd": find_cwd(), "forwarded": true, "client_size": size })).ok()?;
    let mut line = String::new();
    std::io::BufReader::new(&s).read_line(&mut line).ok()?;
    let reply: Value = serde_json::from_str(line.trim()).ok()?;
    let lines = |k: &str| -> Vec<String> { reply.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|l| l.as_str().map(str::to_string)).collect()).unwrap_or_default() };
    let mut out = lines("out");
    if reply.get("bare").and_then(Value::as_bool).unwrap_or(false) { if let Some(l) = out.last_mut() { l.push(crate::app::BARE) } }
    Some((out, lines("err"), reply.get("code").and_then(Value::as_i64).unwrap_or(0) as i32))
}

/// The sessions file held for this client alone while it is read and written again (flock):
/// clients of one name keep their sessions in one file.
pub fn lock(path: &std::path::Path) -> Option<std::fs::File> {
    use std::os::unix::io::AsRawFd;
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(path.with_extension("lock")).ok()?;
    // SAFETY: a valid descriptor, held open for as long as the lock.
    (unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } == 0).then_some(f)
}

/// The newest running client's socket.
fn newest() -> Option<PathBuf> {
    let mut socks: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir()).ok()?.filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "sock").unwrap_or(false))
        .filter_map(|p| std::fs::metadata(&p).and_then(|m| m.modified()).ok().map(|t| (t, p))).collect();
    socks.sort();
    socks.into_iter().rev().map(|(_, p)| p).next()
}

/// `hn <command> …` from a shell: 0 when it ran, 1 with its error, 1 "no client" when none runs.
pub async fn call(words: &[String], socket: Option<&str>, name: Option<&str>) -> i32 {
    let mut tried = 0;
    let pinned = socket.is_some() || name.is_some() || std::env::var("HN_SOCKET").map(|s| !s.is_empty()).unwrap_or(false);
    loop {
        let Some(path) = chosen(socket, name) else { eprintln!("{}", no_server(&dir().join("default.sock"))); return 1 };
        match call_at(&path, words).await {
            Some(code) => return code,
            // A socket left by a client that died: gone, try the next.
            None => {
                if pinned || tried > 8 { eprintln!("{}", no_server(&path)); return 1 }
                let _ = std::fs::remove_file(&path); tried += 1;
            }
        }
    }
}

/// tmux's words for no server at [path]: none there (ENOENT), or one that is gone (ECONNREFUSED).
pub fn no_server(path: &std::path::Path) -> String {
    if path.exists() { format!("no server running on {}", path.display()) } else { format!("error connecting to {} (No such file or directory)", path.display()) }
}

/// A command run by the client at [path], its output printed here; None when nothing answers.
pub async fn call_at(path: &std::path::Path, words: &[String]) -> Option<i32> {
    {
        match tokio::net::UnixStream::connect(path).await {
            Ok(stream) => {
                let (read, mut write) = stream.into_split();
                let cwd = find_cwd();
                // load-buffer - and source-file -: what is piped in goes with the command.
                let reads_stdin = words.first().and_then(|w| crate::cmd::find(w).ok()).map(|e| matches!(e.name, "load-buffer" | "source-file")).unwrap_or(false) && words.iter().skip(1).any(|w| crate::commands::is_stdin(w));
                let stdin = if reads_stdin { let mut s = String::new(); let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut s); Some(s) } else { None };
                // From one of a client's own jobs (its $HN_SOCKET): that client is the command's client.
                let inside = std::env::var("HN_SOCKET").map(|s| !s.is_empty()).unwrap_or(false);
                if write.write_all(format!("{}\n", json!({ "argv": words, "cwd": cwd, "stdin": stdin, "inside": inside, "client_size": command_size(path) })).as_bytes()).await.is_err() { return Some(1) }
                let mut line = String::new();
                let _ = BufReader::new(read).read_line(&mut line).await;
                let reply: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
                // Written quietly: `hn … | head` closing the pipe is not an error.
                use std::io::Write;
                let mut out = std::io::stdout().lock();
                // The last line without its newline when the command printed none (show-buffer).
                let lines = reply.get("out").and_then(Value::as_array).cloned().unwrap_or_default();
                let bare = reply.get("bare").and_then(Value::as_bool).unwrap_or(false);
                for (i, l) in lines.iter().enumerate() {
                    let l = l.as_str().unwrap_or("");
                    let r = if bare && i + 1 == lines.len() { write!(out, "{l}") } else { writeln!(out, "{l}") };
                    if r.is_err() { break }
                }
                let err: Vec<Value> = reply.get("err").and_then(Value::as_array).cloned().unwrap_or_default();
                let mut e = std::io::stderr().lock();
                for l in &err { let _ = writeln!(e, "{}", l.as_str().unwrap_or("")); }
                Some(match reply.get("code").and_then(Value::as_i64) { Some(c) => c as i32, None => if err.is_empty() { 0 } else { 1 } })
            }
            Err(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    /// A command naming a client asks that client's daemon (the port it wrote beside its socket),
    /// and a client that wrote none gives no port — never a guess.
    #[test]
    fn a_named_client_says_which_daemon() {
        let tmp = std::env::temp_dir().join(format!("hn-port-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var("HN_TMPDIR", &tmp) }
        let dir = super::dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("work.sock"), "").unwrap();
        std::fs::write(dir.join("work.port"), "18999\n").unwrap();
        assert_eq!(super::client_port(None, Some("work")), Some(18999));
        assert_eq!(super::client_port(None, Some("other")), None);
        assert_eq!(super::client_port(Some(dir.join("work.sock").to_str().unwrap()), None), Some(18999));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
