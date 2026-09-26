//! hn from a shell, as `tmux ls` and `tmux send-keys` are used from scripts and editors:
//!
//!   hn list-harnesses (lsh)                every harness on every machine
//!   hn send-message -t <harness> <text>    a message to a harness (a turn, as if typed and sent)
//!   hn tim                                 tim, the creature
//!
//! (`hn ls` and `hn send` are tmux's: list-sessions and send-keys.)
//!
//! Anything else starts the client.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::daemon::{http_json, Link};
use crate::fleet::agent_from;

/// Run a CLI subcommand; None when `args` is not one (the client should start).
/// tmux's usage line, hn's flags.
pub const USAGE: &str = "usage: hn [-hV] [-f file] [-L socket-name] [-S socket-path] [--port port]\n          [command [flags]]";

/// The command line, read as tmux reads its own: flags, then a command.
#[derive(Default, Debug)]
pub struct Flags { pub help: bool, pub long_help: bool, pub version: bool, pub keys: bool, pub licenses: bool, pub config: Option<String>, pub socket: Option<String>, pub name: Option<String>, pub port: Option<u16>, pub rest: Vec<String> }

pub fn flags(args: &[String]) -> Result<Flags, String> {
    let mut f = Flags::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--" { i += 1; break }
        if !a.starts_with('-') || a == "-" { break }
        match a {
            "--help" => f.long_help = true,
            "--version" => f.version = true,
            "--keys" => f.keys = true,
            "--licenses" => f.licenses = true,
            "--port" => { i += 1; f.port = Some(args.get(i).and_then(|p| p.parse().ok()).ok_or("--port needs a port")?) }
            _ if a.starts_with("--") => return Err(format!("unknown option -- {}", &a[2..])),
            _ => {
                // Short flags, bundled as getopt allows (-hV); -f -L -S take the rest or the next word.
                let chars: Vec<char> = a[1..].chars().collect();
                let mut j = 0;
                while j < chars.len() {
                    match chars[j] {
                        'h' => f.help = true,
                        'V' => f.version = true,
                        c @ ('f' | 'L' | 'S') => {
                            let value: String = if j + 1 < chars.len() { chars[j + 1..].iter().collect() } else { i += 1; args.get(i).cloned().ok_or(format!("option requires an argument -- {c}"))? };
                            match c { 'f' => f.config = Some(value), 'L' => f.name = Some(value), _ => f.socket = Some(value) }
                            break;
                        }
                        c => return Err(format!("unknown option -- {c}")),
                    }
                    j += 1;
                }
            }
        }
        i += 1;
    }
    f.rest = args[i.min(args.len())..].to_vec();
    Ok(f)
}

/// Run a command given on the command line; None when there is none (the client starts).
pub async fn run(args: &[String], explicit_port: Option<u16>, socket: Option<&str>, name: Option<&str>) -> Option<i32> {
    // hn's own commands ask a daemon: --port or $PORT, else the one the named (or newest) client
    // talks to, else the default — never a daemon other than the client's the command names.
    let port = explicit_port.or_else(|| crate::ipc::client_port(socket, name)).unwrap_or(18473);
    let socket = socket.map(str::to_string);
    let name = name.map(str::to_string);
    let cmd = args.first()?.as_str();
    match cmd {
        // Every harness on every machine (hn's; `ls` is tmux's list-sessions).
        "list-harnesses" | "lsh" => Some(ls(port).await),
        "send-message" => Some(send(port, &args[1..]).await),
        "tim" => { println!("{}", crate::tim::cli_line()); Some(0) }
        // attach / a: the client itself, as `tmux attach` is.
        "attach" | "attach-session" | "a" | "at" => None,
        // Any tmux command: run on the newest running client, its output printed here.
        // Any tmux command (by name, alias, or the start of one), or hn's: run by the client.
        c if crate::commands::is_command_name(c) || crate::cmd::find(c).is_ok() => Some(crate::ipc::call(args, socket.as_deref(), name.as_deref()).await),
        c if !c.starts_with('-') => { eprintln!("{}", crate::cmd::find(c).err().unwrap_or_default()); Some(1) }
        _ => None,
    }
}

async fn machines(port: u16) -> Result<(String, Vec<(String, String, bool)>), String> {
    let status = http_json(port, "GET", "/api/status", None).await.map_err(|e| format!("the daemon is not running ({e}) — harness start"))?;
    let local = status.get("machineId").and_then(Value::as_str).unwrap_or("").to_string();
    let reply = http_json(port, "GET", "/api/machines", None).await.unwrap_or(json!({}));
    let mut out = vec![(local.clone(), crate::app::hostname(), true)];
    for row in reply.get("machines").and_then(Value::as_array).cloned().unwrap_or_default() {
        let id = row.get("machineId").and_then(Value::as_str).unwrap_or("").to_string();
        let name = ["name", "hostname"].iter().filter_map(|k| row.get(*k).and_then(Value::as_str)).find(|s| !s.trim().is_empty()).unwrap_or(&id).to_string();
        // This computer by the name the fleet (and the status line) gives it.
        if id == local { out[0].1 = name; continue }
        if id.is_empty() { continue }
        let up = matches!(row.get("status").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase().as_str(), "running" | "online" | "connected" | "ready");
        out.push((id, name, up));
    }
    Ok((local, out))
}

async fn roster(port: u16, machine: &str) -> Vec<crate::fleet::Agent> {
    let (tx, _rx) = mpsc::unbounded_channel();
    let link = Link::spawn(port, machine, 0, tx);
    let reply = link.rpc("agents_list", json!({}), Duration::from_secs(8)).await.unwrap_or(json!({}));
    reply.get("agents").and_then(Value::as_array).cloned().unwrap_or_default().iter().map(|r| agent_from(machine, r, None)).collect()
}

/// `hn list-harnesses`: `machine: name (engine) status  folder`, one line each, as `tmux ls` is
/// one per session.
async fn ls(port: u16) -> i32 {
    let (_, list) = match machines(port).await { Ok(m) => m, Err(e) => { eprintln!("hn: {e}"); return 1 } };
    for (id, name, up) in list {
        if !up { if !out(&format!("{name}: offline\n")) { break } continue }
        for a in roster(port, &id).await {
            if a.status == "stopped" { continue }
            if !out(&format!("{name}: {} ({}) {}  {}\n", a.name, a.engine, if a.working { "working" } else { a.status.as_str() }, a.cwd)) { return 0 }
        }
    }
    0
}

/// Standard output, written quietly: `hn … | head` closing the pipe is not an error (tmux's exits
/// the same way). False once nobody is reading.
pub fn out(text: &str) -> bool {
    use std::io::Write;
    let mut o = std::io::stdout().lock();
    o.write_all(text.as_bytes()).and_then(|_| o.flush()).is_ok()
}

/// `hn send-message -t <harness> <text…>`: the harness is a name (its start will do) or an id.
async fn send(port: u16, args: &[String]) -> i32 {
    let mut target = None;
    let mut text = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-t" { target = args.get(i + 1).cloned(); i += 2; continue }
        text.push(args[i].clone());
        i += 1;
    }
    let (Some(target), false) = (target, text.is_empty()) else { eprintln!("usage: hn send-message -t <harness> <text>"); return 2 };
    let (_, list) = match machines(port).await { Ok(m) => m, Err(e) => { eprintln!("hn: {e}"); return 1 } };
    let want = target.to_lowercase();
    for (id, _, up) in list {
        if !up { continue }
        if let Some(a) = roster(port, &id).await.into_iter().find(|a| a.id == target || a.name.to_lowercase().starts_with(&want)) {
            let (tx, _rx) = mpsc::unbounded_channel();
            let link = Link::spawn(port, &id, 0, tx);
            let _ = link.rpc("agents_list", json!({}), Duration::from_secs(8)).await;
            link.send("message", json!({ "agentId": a.id, "content": text.join(" ") }));
            tokio::time::sleep(Duration::from_millis(300)).await;
            return 0;
        }
    }
    eprintln!("hn: can't find harness: {target}");
    1
}
