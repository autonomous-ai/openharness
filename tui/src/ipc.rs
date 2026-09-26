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
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)); }
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let sink = sink.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut line = String::new();
                if BufReader::new(read).read_line(&mut line).await.is_err() { return }
                let words: Vec<String> = serde_json::from_str(line.trim()).unwrap_or_default();
                let (tx, rx) = oneshot::channel::<(Vec<String>, Vec<String>)>();
                let command = words.iter().map(|w| crate::tmuxconf::quote_word(w)).collect::<Vec<_>>().join(" ");
                let _ = sink.send(Event::Apply(Box::new(move |app: &mut crate::app::App| {
                    app.capture = Some(Vec::new());
                    app.capture_err = Some(Vec::new());
                    crate::commands::execute(app, &command);
                    let out = app.capture.take().unwrap_or_default();
                    let err = app.capture_err.take().unwrap_or_default();
                    // A command that prints what it makes (-P) answers when it is made.
                    if app.print_new.is_some() && err.is_empty() { app.held_reply = Some(tx) } else { app.print_new = None; let _ = tx.send((out, err)); }
                })));
                let (out, err) = rx.await.unwrap_or_default();
                let _ = write.write_all(format!("{}\n", json!({ "out": out, "err": err })).as_bytes()).await;
            });
        }
    });
    Some(path)
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
                if write.write_all(format!("{}\n", serde_json::to_string(words).unwrap_or_default()).as_bytes()).await.is_err() { return 1 }
                let mut line = String::new();
                let _ = BufReader::new(read).read_line(&mut line).await;
                let reply: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
                // Written quietly: `hn … | head` closing the pipe is not an error.
                use std::io::Write;
                let mut out = std::io::stdout().lock();
                for l in reply.get("out").and_then(Value::as_array).cloned().unwrap_or_default() { if writeln!(out, "{}", l.as_str().unwrap_or("")).is_err() { break } }
                let err: Vec<Value> = reply.get("err").and_then(Value::as_array).cloned().unwrap_or_default();
                let mut e = std::io::stderr().lock();
                for l in &err { let _ = writeln!(e, "{}", l.as_str().unwrap_or("")); }
                return if err.is_empty() { 0 } else { 1 };
            }
            // A socket left by a client that died: gone, try the next.
            Err(_) => {
                if pinned { eprintln!("no client at {}", path.display()); return 1 }
                let _ = std::fs::remove_file(&path); tried += 1; if tried > 8 { eprintln!("no client running (start one with: hn)"); return 1 }
            }
        }
    }
}
