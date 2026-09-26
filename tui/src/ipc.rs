//! The shell's way in, as tmux's socket is: a running hn listens on
//! /tmp/hn-<uid>/<pid>.sock (0600, in a 0700 directory, as tmux's /tmp/tmux-<uid>), and `hn <tmux command>` from any shell runs the
//! command there and prints what it prints — `hn display -p '#{pane_current_path}'`,
//! `hn send-keys -t 1 'make' Enter`, `hn capture-pane -p`, `hn list-panes -F '#{pane_id}'`.

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
pub fn here() -> Option<PathBuf> { HERE.get().cloned() }

pub fn dir() -> PathBuf {
    let base = std::env::var("HN_TMPDIR").or_else(|_| std::env::var("TMUX_TMPDIR")).unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(base).join(format!("hn-{}", unsafe { getuid() }))
}

/// Listen for commands from shells; each is run on the app loop, its output sent back.
pub fn serve(sink: mpsc::UnboundedSender<Event>) -> Option<PathBuf> {
    let dir = dir();
    std::fs::create_dir_all(&dir).ok()?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)); }
    // Named with -L (as tmux's), else by this client's pid. Sockets of clients gone are swept.
    sweep(&dir);
    // tmux's way: the first client is `default` (where unpinned commands go); more get their pid.
    let name = std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| {
        if dir.join("default.sock").exists() { std::process::id().to_string() } else { "default".into() }
    });
    let path = dir.join(format!("{name}.sock"));
    let _ = std::fs::remove_file(&path);
    let listener = tokio::net::UnixListener::bind(&path).ok()?;
    let _ = HERE.set(path.clone());
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)); }
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let sink = sink.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut line = String::new();
                if BufReader::new(read).read_line(&mut line).await.is_err() { return }
                // {"argv": [...], "cwd": "..."} (or just the words, from an older hn).
                let request: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
                let words: Vec<String> = request.get("argv").or(Some(&request)).and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
                let cwd = request.get("cwd").and_then(Value::as_str).map(str::to_string);
                let stdin = request.get("stdin").and_then(Value::as_str).map(str::to_string);
                let (tx, rx) = oneshot::channel::<crate::app::Reply>();
                let _ = sink.send(Event::Apply(Box::new(move |app: &mut crate::app::App| {
                    app.capture = Some(Vec::new());
                    app.capture_err = Some(Vec::new());
                    app.cli_tx = Some(tx);
                    app.cli_code = 0;
                    app.cli_cwd = cwd;
                    app.cli_stdin = stdin;
                    crate::commands::execute_args(app, &words);
                    // Still waiting on a job (run-shell, if-shell): it answers when it is done.
                    if app.capture.is_some() { app.finish_cli() }
                })));
                let (mut out, err, code) = rx.await.unwrap_or_default();
                // A last line marked bare (show-buffer's data without a newline) is printed bare.
                let bare = out.last().map(|l| l.ends_with(crate::app::BARE)).unwrap_or(false);
                if let Some(l) = out.last_mut() { if let Some(s) = l.strip_suffix(crate::app::BARE) { *l = s.to_string() } }
                let _ = write.write_all(format!("{}\n", json!({ "out": out, "err": err, "code": code, "bare": bare })).as_bytes()).await;
            });
        }
    });
    Some(path)
}

/// What hn's jobs (run-shell, if-shell, #(), copy-pipe) run with, as tmux's run with TMUX set:
/// HN_SOCKET naming this client, TMUX saying they run under one, and a `tmux` on the PATH that
/// is hn — so a script's (or a plugin's) `tmux …` reaches this client, never a tmux server.
pub fn job_env() -> Vec<(String, String)> {
    let mut env = Vec::new();
    let Some(sock) = here() else { return env };
    env.push(("HN_SOCKET".into(), sock.display().to_string()));
    env.push(("TMUX".into(), format!("{},{},0", sock.display(), std::process::id())));
    if let Some(bin) = shim() {
        let path = std::env::var("PATH").unwrap_or_default();
        env.push(("PATH".into(), format!("{}:{path}", bin.display())));
    }
    env
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

/// Remove sockets nobody answers on (a client that was killed).
fn sweep(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().map(|x| x == "sock").unwrap_or(false) && std::os::unix::net::UnixStream::connect(&p).is_err() { let _ = std::fs::remove_file(&p); }
    }
}

/// Which client to ask: -S path, -L name, $HN_SOCKET, else the newest.
fn chosen(socket: Option<&str>, name: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = socket.map(str::to_string).or_else(|| std::env::var("HN_SOCKET").ok().filter(|s| !s.is_empty())) { return Some(PathBuf::from(p)) }
    if let Some(n) = name { return Some(dir().join(format!("{n}.sock"))) }
    let default = dir().join("default.sock");
    if default.exists() { return Some(default) }
    newest()
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
        let Some(path) = chosen(socket, name) else { eprintln!("no client running (start one with: hn)"); return 1 };
        match tokio::net::UnixStream::connect(&path).await {
            Ok(stream) => {
                let (read, mut write) = stream.into_split();
                let cwd = find_cwd();
                // load-buffer - and source-file -: what is piped in goes with the command.
                let reads_stdin = words.first().and_then(|w| crate::cmd::find(w).ok()).map(|e| matches!(e.name, "load-buffer" | "source-file")).unwrap_or(false) && words.iter().skip(1).any(|w| w == "-");
                let stdin = if reads_stdin { let mut s = String::new(); let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut s); Some(s) } else { None };
                if write.write_all(format!("{}\n", json!({ "argv": words, "cwd": cwd, "stdin": stdin })).as_bytes()).await.is_err() { return 1 }
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
                return match reply.get("code").and_then(Value::as_i64) { Some(c) => c as i32, None => if err.is_empty() { 0 } else { 1 } };
            }
            // A socket left by a client that died: gone, try the next.
            Err(_) => {
                if pinned { eprintln!("no client at {}", path.display()); return 1 }
                let _ = std::fs::remove_file(&path); tried += 1; if tried > 8 { eprintln!("no client running (start one with: hn)"); return 1 }
            }
        }
    }
}
