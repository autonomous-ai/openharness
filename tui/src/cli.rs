//! tim from a shell, as `tmux ls` and `tmux send-keys` are used from scripts and editors:
//!
//!   tim ls                          every harness on every machine
//!   tim send -t <harness> <text>    a message to a harness (a turn, as if typed and sent)
//!
//! Anything else starts the client.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::daemon::{http_json, Link};
use crate::fleet::agent_from;

/// Run a CLI subcommand; None when `args` is not one (the client should start).
pub async fn run(args: &[String], port: u16) -> Option<i32> {
    let cmd = args.first()?.as_str();
    match cmd {
        "ls" | "list-sessions" | "list" => Some(ls(port).await),
        "send" | "send-message" => Some(send(port, &args[1..]).await),
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
        if id.is_empty() || id == local { continue }
        let name = ["name", "hostname"].iter().filter_map(|k| row.get(*k).and_then(Value::as_str)).find(|s| !s.trim().is_empty()).unwrap_or(&id).to_string();
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

/// `tim ls`: `machine: name (engine) status  folder`, one line each, as `tmux ls` is one per session.
async fn ls(port: u16) -> i32 {
    let (_, list) = match machines(port).await { Ok(m) => m, Err(e) => { eprintln!("tim: {e}"); return 1 } };
    for (id, name, up) in list {
        if !up { println!("{name}: offline"); continue }
        for a in roster(port, &id).await {
            if a.status == "stopped" { continue }
            println!("{name}: {} ({}) {}  {}", a.name, a.engine, if a.working { "working" } else { a.status.as_str() }, a.cwd);
        }
    }
    0
}

/// `tim send -t <harness> <text…>`: the harness is a name (its start will do) or an id.
async fn send(port: u16, args: &[String]) -> i32 {
    let mut target = None;
    let mut text = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-t" { target = args.get(i + 1).cloned(); i += 2; continue }
        text.push(args[i].clone());
        i += 1;
    }
    let (Some(target), false) = (target, text.is_empty()) else { eprintln!("usage: tim send -t <harness> <text>"); return 2 };
    let (_, list) = match machines(port).await { Ok(m) => m, Err(e) => { eprintln!("tim: {e}"); return 1 } };
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
    eprintln!("tim: can't find harness: {target}");
    1
}
