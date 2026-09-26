//! hn from a shell, as `tmux ls` and `tmux send-keys` are used from scripts and editors:
//!
//!   hn ls                          every harness on every machine
//!   hn send -t <harness> <text>    a message to a harness (a turn, as if typed and sent)
//!   hn tim                         tim, the creature
//!
//! Anything else starts the client.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::daemon::{http_json, Link};
use crate::fleet::agent_from;

/// Run a CLI subcommand; None when `args` is not one (the client should start).
pub async fn run(args: &[String], port: u16) -> Option<i32> {
    // -S path / -L name choose the client (as tmux's server); -L alone names the one starting.
    let (mut socket, mut name, mut i) = (None, None, 0);
    while i + 1 < args.len() && matches!(args[i].as_str(), "-S" | "-L") {
        if args[i] == "-S" { socket = Some(args[i + 1].clone()) } else { name = Some(args[i + 1].clone()) }
        i += 2;
    }
    let args = &args[i..];
    if args.is_empty() { if let Some(n) = &name { unsafe { std::env::set_var("HN_SOCKET_NAME", n) } } return None }
    let cmd = args.first()?.as_str();
    match cmd {
        "-V" | "--version" => { println!("hn {} (tmux {})", env!("CARGO_PKG_VERSION"), crate::tmuxconf::TMUX_VERSION); Some(0) }
        "ls" | "list-sessions" | "list" => Some(ls(port).await),
        "send" | "send-message" => Some(send(port, &args[1..]).await),
        "tim" => { println!("{}", crate::tim::cli_line()); Some(0) }
        // attach / a: the client itself, as `tmux attach` is.
        "attach" | "attach-session" | "a" | "at" => None,
        // Any tmux command: run on the newest running client, its output printed here.
        c if crate::commands::is_command_name(c) => Some(crate::ipc::call(args, socket.as_deref(), name.as_deref()).await),
        c if !c.starts_with('-') => { eprintln!("unknown command: {c}"); Some(1) }
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

/// `hn ls`: `machine: name (engine) status  folder`, one line each, as `tmux ls` is one per session.
async fn ls(port: u16) -> i32 {
    let (_, list) = match machines(port).await { Ok(m) => m, Err(e) => { eprintln!("hn: {e}"); return 1 } };
    for (id, name, up) in list {
        if !up { println!("{name}: offline"); continue }
        for a in roster(port, &id).await {
            if a.status == "stopped" { continue }
            println!("{name}: {} ({}) {}  {}", a.name, a.engine, if a.working { "working" } else { a.status.as_str() }, a.cwd);
        }
    }
    0
}

/// `hn send -t <harness> <text…>`: the harness is a name (its start will do) or an id.
async fn send(port: u16, args: &[String]) -> i32 {
    let mut target = None;
    let mut text = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-t" { target = args.get(i + 1).cloned(); i += 2; continue }
        text.push(args[i].clone());
        i += 1;
    }
    let (Some(target), false) = (target, text.is_empty()) else { eprintln!("usage: hn send -t <harness> <text>"); return 2 };
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
