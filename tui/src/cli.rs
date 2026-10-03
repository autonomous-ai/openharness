//! hn from a shell, as `tmux ls` and `tmux send-keys` are used from scripts and editors:
//!
//!   hn list-harnesses (lsh)                every harness on every machine
//!   hn send-message -t <harness> <text>    a message to a harness (a turn, as if typed and sent)
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
pub const USAGE: &str = "usage: hn [-2DhluNVv] [-c shell-command] [-f file] [-L socket-name]\n          [-S socket-path] [-T features] [--port port] [command [flags]]";

/// The command line, read as tmux reads its own: flags, then a command.
#[derive(Default, Debug)]
pub struct Flags { pub help: bool, pub long_help: bool, pub version: bool, pub keys: bool, pub licenses: bool, pub config: Option<String>, pub socket: Option<String>, pub name: Option<String>, pub port: Option<u16>, pub rest: Vec<String>,
    /// -c: a command for the shell (tmux as a login shell).
    pub shell_command: Option<String>,
    /// --headless: tmux's server with no client attached (started for a script's commands).
    pub headless: bool,
    /// Internal persistent PTY owner, used when Harness is unavailable.
    pub local_server: bool,
    /// -C: control mode, which hn does not have.
    pub control: bool }

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
            "--headless" => f.headless = true,
            "--local-server" => f.local_server = true,
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
                        // tmux's: 256 colours, UTF-8, a login shell, verbose logs, no server start,
                        // no daemon — each already so, or nothing to hn.
                        '2' | 'u' | 'l' | 'v' | 'N' | 'D' => {}
                        'C' => f.control = true,
                        c @ ('f' | 'L' | 'S' | 'T' | 'c') => {
                            let value: String = if j + 1 < chars.len() { chars[j + 1..].iter().collect() } else { i += 1; args.get(i).cloned().ok_or(format!("option requires an argument -- {c}"))? };
                            match c { 'f' => f.config = Some(value), 'L' => f.name = Some(value), 'S' => f.socket = Some(value), 'c' => f.shell_command = Some(value), _ => {} }
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
        "view" | "open-viewer" => Some(crate::viewer::cli(port, &args[1..], socket.as_deref(), name.as_deref()).await),
        // Every harness on every machine (hn's; `ls` is tmux's list-sessions).
        // The running client knows each one's state (what it asks, does, did); with none, the
        // daemons' rosters.
        // (No client: hn with no terminal answers it, as tmux's server starts for a command.)
        "list-harnesses" | "lsh" | "answer-harness" | "answer" | "open-harness" | "openh" => {
            let up = crate::ipc::alive(socket.as_deref(), name.as_deref()) || (socket.is_none() && spawn_headless(name.as_deref(), explicit_port).await);
            if up { Some(crate::ipc::call(args, socket.as_deref(), name.as_deref()).await) } else { Some(ls(port).await) }
        }
        // send-message: the client's, which knows each machine's link (and the hook's harness);
        // with none, straight to the daemons.
        "send-message" | "restart-harness" | "restarth" | "pause-harness" | "resume-harness" | "clone-harness" | "rename-harness" => {
            let up = crate::ipc::alive(socket.as_deref(), name.as_deref()) || (socket.is_none() && spawn_headless(name.as_deref(), explicit_port).await);
            if up { Some(crate::ipc::call(args, socket.as_deref(), name.as_deref()).await) }
            else if cmd == "send-message" { Some(send(port, &args[1..]).await) }
            else { eprintln!("no server running"); Some(1) }
        }
        // attach / a: the client itself, as `tmux attach` is.
        "attach" | "attach-session" | "a" | "at" => None,
        // new-session: a client here, as `tmux new` from a shell is — unless it is -d (a session
        // for the running client to keep) or comes from inside a client (one of its jobs), which
        // asks that client.
        c if crate::cmd::find(c).map(|e| e.name == "new-session").unwrap_or(false) => {
            let detached = crate::cmd::find(c).ok().and_then(|e| crate::cmd::parse(e, args).ok()).map(|a| a.has('d') > 0).unwrap_or(false);
            // $HN_SOCKET: what a client sets for what it runs, as tmux's $TMUX.
            let inside = std::env::var("HN_SOCKET").map(|v| !v.is_empty()).unwrap_or(false);
            // -A with that session there: tmux attaches to it, -d or not (cmd_attach_session) — a
            // client here, or `open terminal failed` from a shell with no terminal.
            let parsed = crate::cmd::find(c).ok().and_then(|e| crate::cmd::parse(e, args).ok());
            if let (Some(s), false) = (parsed.as_ref().filter(|a| a.has('A') > 0).and_then(|a| a.get('s')), inside) {
                let exact = format!("={s}");
                let there = if crate::ipc::alive(socket.as_deref(), name.as_deref()) {
                    crate::ipc::chosen(socket.as_deref(), name.as_deref()).map(|p| matches!(crate::ipc::ask(&p, &["has-session".into(), "-t".into(), exact.clone()]), Some((_, _, 0)))).unwrap_or(false)
                } else { has_session_named(name.as_deref(), &exact) };
                if there { return None }
            }
            // new -d with no client: tmux's server starts for it (hn with no terminal).
            if detached && !crate::ipc::alive(socket.as_deref(), name.as_deref()) && !spawn_headless(name.as_deref(), explicit_port).await { return Some(offline(port, args, name.as_deref()).await) }
            if detached || inside { Some(crate::ipc::call(args, socket.as_deref(), name.as_deref()).await) } else { None }
        }
        // start-server: hn with no terminal holds the sessions no client has (and goes, as tmux's
        // server does, when there are none).
        "start-server" | "start" => {
            if !crate::ipc::alive(socket.as_deref(), name.as_deref()) && has_sessions(name.as_deref()) { spawn_headless(name.as_deref(), explicit_port).await; }
            // `start-server \; has-session -t proj`: the commands after it, as they run alone.
            let rest: Vec<String> = args.iter().skip_while(|w| w.as_str() != ";").skip(1).cloned().collect();
            if rest.is_empty() { return Some(0) }
            return Box::pin(run(&rest, explicit_port, socket.as_deref(), name.as_deref())).await.or(Some(0));
        }
        // No client running: what tmux's server would answer — the sessions a client left (and the
        // desk's), from where they are kept.
        c if matches!(crate::cmd::find(c).map(|e| e.name), Ok("list-sessions" | "has-session" | "kill-session")) && !crate::ipc::alive(socket.as_deref(), name.as_deref()) => Some(offline(port, args, name.as_deref()).await),
        // Any tmux command: run on the newest running client, its output printed here.
        // Any tmux command (by name, alias, or the start of one), or hn's: run by the client.
        // (A name it does not know may be a command-alias: the running client knows.)
        c if crate::commands::is_command_name(c) || crate::cmd::find(c).is_ok() || (!c.starts_with('-') && crate::ipc::alive(socket.as_deref(), name.as_deref())) => {
            // No client, and sessions kept (the desk's too, which `ls` lists): tmux's server has
            // them — hn with no terminal, started, so every command is answered as `ls` is.
            if socket.is_none() && !crate::ipc::alive(None, name.as_deref()) && has_any_session(name.as_deref()) { spawn_headless(name.as_deref(), explicit_port).await; }
            // One naming a session another client of this name has: run by that client.
            if socket.is_none() {
                if let Some(owner) = owner_of_target(args, name.as_deref()) {
                    if let Some(code) = crate::ipc::call_at(&owner, args).await { return Some(code) }
                }
            }
            Some(crate::ipc::call(args, socket.as_deref(), name.as_deref()).await)
        }
        c if !c.starts_with('-') => { eprintln!("{}", crate::cmd::find(c).err().unwrap_or_default()); Some(1) }
        _ => None,
    }
}

/// Whether sessions are kept for this server name (no client has them, or one does).
/// A session no client runs, kept in the sessions file, by its name (as -t takes it: exact, `=`
/// exact, else the start of one name) or its id ($N).
pub fn has_session_named(name: Option<&str>, t: &str) -> bool {
    let doc = crate::app::read_sessions(&crate::app::sessions_path(name));
    let rows: Vec<Value> = doc["sessions"].as_array().cloned().unwrap_or_default();
    let names: Vec<String> = rows.iter().filter_map(|r| r.get("name").and_then(Value::as_str).map(str::to_string)).collect();
    if let Some(id) = t.strip_prefix('$').and_then(|i| i.parse::<u64>().ok()) { return rows.iter().any(|r| r.get("id").and_then(Value::as_u64) == Some(id)) }
    if let Some(exact) = t.strip_prefix('=') { return names.iter().any(|n| n == exact) }
    names.iter().any(|n| n == t) || names.iter().filter(|n| n.starts_with(t)).count() == 1
}

/// Any session kept for this server name, the desk's included.
pub fn has_any_session(name: Option<&str>) -> bool {
    let doc = crate::app::read_sessions(&crate::app::sessions_path(name));
    doc["sessions"].as_array().map(|rows| !rows.is_empty()).unwrap_or(false)
}

pub fn has_sessions(name: Option<&str>) -> bool {
    let doc = crate::app::read_sessions(&crate::app::sessions_path(name));
    doc["sessions"].as_array().map(|rows| rows.iter().any(|r| !r.get("desk").and_then(Value::as_bool).unwrap_or(false))).unwrap_or(false)
}

/// tmux's server, started for a command when no client runs: hn with no terminal (--headless), in
/// a session of its own (closing this terminal leaves it), holding the sessions until a client
/// attaches to them. False when it did not come up.
pub async fn spawn_headless(name: Option<&str>, port: Option<u16>) -> bool {
    use std::os::unix::process::CommandExt;
    let Ok(me) = std::env::current_exe() else { return false };
    let mut cmd = std::process::Command::new(me);
    if let Some(n) = name { cmd.args(["-L", n]); }
    if let Some(p) = port { cmd.args(["--port", &p.to_string()]); }
    cmd.arg("--headless").env_remove("HN_AS_TMUX").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    // SAFETY: setsid is async-signal-safe, called in the child before exec.
    unsafe { cmd.pre_exec(|| { libc::setsid(); Ok(()) }); }
    if cmd.spawn().is_err() { return false }
    for _ in 0..250 {
        if crate::ipc::alive(None, name) { return true }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

/// The client a command goes to when its -t (or -s) names a session a running client of this
/// server name has — tmux's one server has every session; hn's clients each have theirs.
fn owner_of_target(args: &[String], name: Option<&str>) -> Option<std::path::PathBuf> {
    let entry = crate::cmd::find(args.first()?).ok()?;
    if matches!(entry.name, "new-session" | "attach-session" | "switch-client" | "list-sessions" | "kill-server") { return None }
    let a = crate::cmd::parse(entry, &crate::tmuxconf::unblock(args)).ok()?;
    let doc = crate::app::read_sessions(&crate::app::sessions_path(name));
    let rows: Vec<Value> = doc["sessions"].as_array()?.iter().filter(|r| !r.get("desk").and_then(Value::as_bool).unwrap_or(false)).cloned().collect();
    let named = |r: &Value| r.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let id_of = |r: &Value| r.get("id").and_then(Value::as_u64);
    let has = |r: &Value, pane: Option<u64>, wid: Option<u64>| r.get("windows").and_then(Value::as_array).map(|ws| ws.iter().any(|w|
        wid.map(|x| w.get("wid").and_then(Value::as_u64) == Some(x)).unwrap_or(false)
        || pane.map(|x| w.get("panes").and_then(Value::as_array).map(|ps| ps.iter().any(|p| p.get(3).and_then(Value::as_u64) == Some(x))).unwrap_or(false)).unwrap_or(false))).unwrap_or(false);
    for flag in ['t', 's'] {
        let Some(t) = a.get(flag) else { continue };
        // An id ($N, @N, %N) is one thing among every client's: the client that has it.
        let head = t.split(['.', ':']).next().unwrap_or(t);
        let by_id = if let Some(n) = head.strip_prefix('$').and_then(|n| n.parse::<u64>().ok()) { rows.iter().find(|r| id_of(r) == Some(n)) }
            else if let Some(n) = head.strip_prefix('@').and_then(|n| n.parse::<u64>().ok()) { rows.iter().find(|r| has(r, None, Some(n))) }
            else if let Some(n) = head.strip_prefix('%').and_then(crate::pane::from_tag) { rows.iter().find(|r| has(r, Some(n), None)) }
            else { None };
        if let Some(owner) = by_id.and_then(crate::app::live_owner) { return Some(owner.into()) }
        if t.starts_with(['%', '@', '$']) || (!t.contains(':') && t.contains('.')) { continue }
        let s = t.split(':').next().unwrap_or(t);
        let (exact, s) = match s.strip_prefix('=') { Some(s) => (true, s), None => (false, s) };
        if s.is_empty() { continue }
        // cmd_find_get_session: the exact name, else the only one it starts.
        let hit = rows.iter().find(|r| named(r) == s).or_else(|| {
            if exact { return None }
            let starts: Vec<&Value> = rows.iter().filter(|r| named(r).starts_with(s)).collect();
            (starts.len() == 1).then(|| starts[0])
        });
        if let Some(owner) = hit.and_then(crate::app::live_owner) { return Some(owner.into()) }
    }
    // No target of its own (or one in the current session: `:1`, `.0`): the client used last,
    // as tmux's cmd_find_best_client — its session the current one.
    let implicit = |t: &str| t.is_empty() || t.starts_with([':', '.', '+', '-', '!', '^', '{']);
    // (From inside a pane — $HN_SOCKET — that pane's client, as tmux finds it from $TMUX.)
    let inside = std::env::var("HN_SOCKET").is_ok_and(|s| !s.is_empty());
    if !inside && a.get('t').is_none_or(implicit) && a.get('s').is_none_or(implicit) && a.get('c').is_none() {
        let n = name.map(str::to_string).or_else(|| std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty())).unwrap_or_else(|| "default".into());
        return crate::ipc::busiest(&n);
    }
    None
}

/// What `hn new …` or `hn attach …` asks of the client it starts: the session (-s, or attach's
/// -t), made if it is new-session (-A: attached to if it is there), its first window's name (-n),
/// folder (-c) and command.
pub fn start_session(args: &[String]) -> Option<crate::app::StartSession> {
    let entry = crate::cmd::find(args.first()?).ok()?;
    let a = crate::cmd::parse(entry, args).ok()?;
    match entry.name {
        "new-session" => Some(crate::app::StartSession {
            name: a.get('s').map(str::to_string), create: true, attach_existing: a.has('A') > 0, window: a.get('n').map(str::to_string),
            cwd: a.get('c').map(str::to_string), command: (!a.values.is_empty()).then(|| a.values.join(" ")), target: None,
            // new -A -D: attached, the session's other clients detached.
            detach: a.has('D') > 0, readonly: false, flags: Vec::new(), group: a.get('t').map(str::to_string),
        }),
        "attach-session" => Some(crate::app::StartSession {
            name: a.get('t').map(|t| t.split(':').next().unwrap_or(t).to_string()).filter(|t| !t.is_empty()), cwd: a.get('c').map(str::to_string),
            // attach -t work:2 — the window it goes to.
            target: a.get('t').and_then(|t| t.split_once(':')).map(|(_, w)| w.to_string()).filter(|w| !w.is_empty()),
            // -f's flags (a `!` before one: not it), -r read-only and ignore-size.
            flags: {
                let mut f: Vec<String> = Vec::new();
                if a.has('r') > 0 { f.extend(["read-only".to_string(), "ignore-size".to_string()]) }
                // (A terminal's flags: the others — no-output, wait-exit, pause-after — are a
                // control-mode client's, and tmux leaves them off one.)
                for x in a.get('f').unwrap_or("").split(',').map(str::trim).filter(|x| matches!(x.trim_start_matches('!'), "read-only" | "ignore-size" | "active-pane")) {
                    match x.strip_prefix('!') { Some(n) => f.retain(|y| y != n), None => if !f.iter().any(|y| y == x) { f.push(x.to_string()) } }
                }
                f
            },
            detach: a.has('d') > 0, readonly: a.has('r') > 0 || a.get('f').unwrap_or("").split(',').any(|x| x.trim() == "read-only"),
            ..Default::default()
        }),
        _ => None,
    }
}

/// Sessions with no client running (tmux's server answering alone): listed, checked, killed, or
/// made in the background (`new -d`: its shell started now, the session there for the next client).
async fn offline(port: u16, args: &[String], name: Option<&str>) -> i32 {
    let Ok(entry) = crate::cmd::find(&args[0]) else { return 1 };
    let a = match crate::cmd::parse(entry, args) { Ok(a) => a, Err(e) => { eprintln!("{e}"); return 1 } };
    let path = crate::app::sessions_path(name);
    let mut doc: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({ "sessions": [] }));
    if !doc.get("sessions").map(Value::is_array).unwrap_or(false) { doc["sessions"] = json!([]) }
    // The desk's session: named as it was, else for this computer; its windows the desk's tabs.
    let (local, list) = machines(port).await.unwrap_or_default();
    let machine_name = list.iter().find(|(id, _, _)| *id == local).map(|(_, n, _)| n.clone()).unwrap_or_else(|| {
        let mut fleet = crate::fleet::Fleet::default();
        fleet.load_cache(&local);
        fleet.local_machine_name()
    });
    let rows = doc["sessions"].as_array().cloned().unwrap_or_default();
    let desk_row = rows.iter().find(|r| r.get("desk").and_then(Value::as_bool).unwrap_or(false));
    let desk_name = desk_row.and_then(|r| r.get("name").and_then(Value::as_str)).map(str::to_string).unwrap_or(machine_name);
    let desk = http_json(port, "GET", "/api/desk", None).await.unwrap_or(json!({}));
    let desk_windows = desk.get("tabs").and_then(Value::as_array).map(|t| t.iter().filter(|t| t.get("panes").and_then(Value::as_array).map(|p| !p.is_empty()).unwrap_or(false)).count()).unwrap_or(0);
    let now = crate::app::epoch_secs();
    // The desk's session is there while the desk has windows (desk=off: there is none).
    let deskless = std::env::var("HARNESS_TUI_DESK").as_deref() == Ok("off");
    let mut sessions: Vec<(String, usize, i64, bool)> = Vec::new();
    let mut groups: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if !deskless && desk_windows > 0 { sessions.push((desk_name.clone(), desk_windows, desk_row.and_then(|r| r.get("created").and_then(Value::as_i64)).unwrap_or(now), true)) }
    for r in rows.iter().filter(|r| !r.get("desk").and_then(Value::as_bool).unwrap_or(false)) {
        let Some(n) = r.get("name").and_then(Value::as_str) else { continue };
        if let Some(g) = r.get("group").and_then(Value::as_str) { groups.insert(n.to_string(), g.to_string()); }
        sessions.push((n.to_string(), r.get("windows").and_then(Value::as_array).map(|w| w.len()).unwrap_or(0), r.get("created").and_then(Value::as_i64).unwrap_or(now), false));
    }
    sessions.sort_by(|x, y| x.0.cmp(&y.0));
    // No session anywhere: tmux's words for no server.
    if sessions.is_empty() && matches!(entry.name, "list-sessions" | "has-session" | "kill-session") {
        let sock = crate::ipc::dir().join(format!("{}.sock", name.unwrap_or("default")));
        eprintln!("{}", crate::ipc::no_server(&sock));
        return 1;
    }
    // cmd_find_get_session: exact, the only one it starts, the only one it matches.
    let find = |t: &str| -> Option<usize> {
        let (exact, t) = match t.strip_prefix('=') { Some(t) => (true, t), None => (false, t) };
        let t = t.split(':').next().unwrap_or(t);
        if let Some(i) = sessions.iter().position(|s| s.0 == t) { return Some(i) }
        if exact { return None }
        let starts: Vec<usize> = (0..sessions.len()).filter(|i| sessions[*i].0.starts_with(t)).collect();
        if starts.len() == 1 { return Some(starts[0]) }
        if !starts.is_empty() { return None }
        let matched: Vec<usize> = (0..sessions.len()).filter(|i| crate::cmd::fnmatch(t, &sessions[*i].0)).collect();
        (matched.len() == 1).then(|| matched[0])
    };
    let save = |doc: &Value| { if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); } let _ = std::fs::write(&path, doc.to_string()); };
    match entry.name {
        "list-sessions" => {
            let fmt = a.get('F').unwrap_or("#{session_name}: #{session_windows} windows (created #{t:session_created})#{?session_grouped, (group ,}#{session_group}#{?session_grouped,),}");
            for (n, w, c, _) in &sessions {
                // Its group (new -t), and the group's sessions by name.
                let g = groups.get(n).cloned();
                let members: Vec<&String> = sessions.iter().map(|s| &s.0).filter(|m| g.is_some() && groups.get(*m) == g.as_ref()).collect();
                let g = g.unwrap_or_default();
                let grouped = if g.is_empty() { "0" } else { "1" };
                let line = fmt.replace("#{?session_grouped, (group ,}#{session_group}#{?session_grouped,),}", &if g.is_empty() { String::new() } else { format!(" (group {g})") })
                    .replace("#{session_group_size}", &if g.is_empty() { String::new() } else { members.len().to_string() })
                    .replace("#{session_group_list}", &members.iter().map(|m| m.as_str()).collect::<Vec<_>>().join(","))
                    .replace("#{session_grouped}", grouped).replace("#{session_group}", &g)
                    .replace("#{session_name}", n).replace("#S", n).replace("#{session_windows}", &w.to_string()).replace("#{t:session_created}", &crate::format::strftime_at("%a %b %e %H:%M:%S %Y", *c))
                    .replace("#{session_created}", &c.to_string()).replace("#{session_attached}", "0").replace("#{?session_attached, (attached),}", "");
                if !out(&format!("{line}\n")) { break }
            }
            0
        }
        "has-session" => {
            let t = a.get('t').unwrap_or("");
            if t.is_empty() || find(t).is_some() { 0 } else { eprintln!("can't find session: {t}"); 1 }
        }
        "kill-session" => {
            let t = a.get('t').unwrap_or("");
            let Some(i) = find(t) else { eprintln!("can't find session: {t}"); return 1 };
            let (n, _, _, is_desk) = sessions[i].clone();
            if is_desk { eprintln!("hn: the desk's session ({n}) is killed from a client: its windows are the account's swarms"); return 1 }
            // Its shells end, as its windows' would.
            let row = rows.iter().find(|r| r.get("name").and_then(Value::as_str) == Some(n.as_str())).cloned().unwrap_or(Value::Null);
            for w in row.get("windows").and_then(Value::as_array).cloned().unwrap_or_default() {
                for p in w.get("panes").and_then(Value::as_array).cloned().unwrap_or_default() {
                    let (Some(m), Some(id), true) = (p.get(0).and_then(Value::as_str), p.get(1).and_then(Value::as_str), p.get(2).and_then(Value::as_bool).unwrap_or(false)) else { continue };
                    let (tx, _rx) = mpsc::unbounded_channel();
                    let link = Link::spawn(port, m, 0, tx);
                    let _ = link.rpc("agent_delete", json!({ "agentId": id }), Duration::from_secs(15)).await;
                }
            }
            let kept: Vec<Value> = rows.into_iter().filter(|r| r.get("name").and_then(Value::as_str) != Some(n.as_str())).collect();
            doc["sessions"] = json!(kept);
            if doc.get("current").and_then(Value::as_str) == Some(n.as_str()) { doc["current"] = Value::Null }
            save(&doc);
            0
        }
        "new-session" => {
            let n = match a.get('s') { Some(s) => match crate::app::session_check_name(s) { Some(n) => n, None => { eprintln!("invalid session: {s}"); return 1 } }, None => { let mut k = 0; while sessions.iter().any(|s| s.0 == k.to_string()) { k += 1 } k.to_string() } };
            if sessions.iter().any(|s| s.0 == n) {
                if a.has('A') > 0 { return 0 }
                eprintln!("duplicate session: {n}"); return 1
            }
            if local.is_empty() { eprintln!("hn: the daemon is not running (harness start)"); return 1 }
            let cwd = a.get('c').map(str::to_string).or_else(|| std::env::current_dir().ok().map(|d| d.display().to_string()));
            let (tx, _rx) = mpsc::unbounded_channel();
            let link = Link::spawn(port, &local, 0, tx);
            let mut payload = json!({ "engine": "terminal", "creationId": uuid::Uuid::new_v4().to_string(), "bypassPermission": false });
            if let Some(c) = &cwd { payload["cwd"] = json!(c) }
            let reply = match link.rpc("agent_create", payload, Duration::from_secs(60)).await { Ok(r) => r, Err(e) => { eprintln!("create session failed: {e}"); return 1 } };
            let Some(id) = reply.pointer("/agent/id").and_then(Value::as_str) else { eprintln!("create session failed: no shell"); return 1 };
            let command = (!a.values.is_empty()).then(|| a.values.join(" "));
            if let Some(c) = &command { link.send("message", json!({ "agentId": id, "content": format!(" clear; exec \"${{SHELL:-sh}}\" -c '{}'", c.replace('\'', "'\\''")) })); }
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".into());
            let window = a.get('n').map(str::to_string).unwrap_or_else(|| command.as_deref().and_then(|c| c.split_whitespace().next()).unwrap_or(&shell).rsplit('/').next().unwrap_or("sh").to_string());
            let mut kept = rows;
            kept.push(json!({ "name": n, "desk": false, "created": now, "active": 0, "windows": [{ "name": window, "named": a.get('n').is_some(), "num": 0, "layout": "", "panes": [[local, id, true]], "focus": 0 }] }));
            doc["sessions"] = json!(kept);
            save(&doc);
            if a.has('P') > 0 { out(&format!("{}\n", a.get('F').unwrap_or("#{session_name}:").replace("#{session_name}", &n))); }
            0
        }
        _ => 1,
    }
}

pub(crate) async fn machines(port: u16) -> Result<(String, Vec<(String, String, bool)>), String> {
    let status = http_json(port, "GET", "/api/status", None).await.map_err(|e| format!("the daemon is not running ({e}) — harness start"))?;
    let local = status.get("machineId").and_then(Value::as_str).unwrap_or("").to_string();
    let reply = http_json(port, "GET", "/api/machines", None).await.unwrap_or(json!({}));
    let mut out = vec![(local.clone(), crate::fleet::machine_display_name(&local, None), true)];
    for row in reply.get("machines").and_then(Value::as_array).cloned().unwrap_or_default() {
        let id = row.get("machineId").and_then(Value::as_str).unwrap_or("").to_string();
        let name = crate::fleet::machine_display_name(&id, row.get("name").and_then(Value::as_str));
        // This computer by the name the fleet (and the status line) gives it.
        if id == local { out[0].1 = name; continue }
        if id.is_empty() { continue }
        let up = matches!(row.get("status").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase().as_str(), "running" | "online" | "connected" | "ready");
        out.push((id, name, up));
    }
    Ok((local, out))
}

pub(crate) async fn roster(port: u16, machine: &str) -> Vec<crate::fleet::Agent> {
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
    // As tmux finds a target: its id, else its exact name, else the only name it starts —
    // more than one of those is ambiguous, and nothing is sent.
    let want = target.to_lowercase();
    let mut all: Vec<(String, crate::fleet::Agent)> = Vec::new();
    for (id, _, up) in list { if up { for a in roster(port, &id).await { all.push((id.clone(), a)) } } }
    let exact: Vec<&(String, crate::fleet::Agent)> = all.iter().filter(|(_, a)| a.id == target || a.name.to_lowercase() == want).collect();
    let starts: Vec<&(String, crate::fleet::Agent)> = all.iter().filter(|(_, a)| a.name.to_lowercase().starts_with(&want)).collect();
    let hits = if !exact.is_empty() { exact } else { starts };
    match hits.as_slice() {
        [] => { eprintln!("hn: can't find harness: {target}"); 1 }
        [(machine, a)] => {
            let (tx, _rx) = mpsc::unbounded_channel();
            let link = Link::spawn(port, machine, 0, tx);
            let _ = link.rpc("agents_list", json!({}), Duration::from_secs(8)).await;
            link.send("message", json!({ "agentId": a.id, "content": text.join(" ") }));
            tokio::time::sleep(Duration::from_millis(300)).await;
            0
        }
        many => {
            let names: Vec<String> = many.iter().take(8).map(|(_, a)| a.name.clone()).collect();
            eprintln!("hn: ambiguous harness: {target}, could be: {}{}", names.join(", "), if many.len() > 8 { ", …" } else { "" });
            1
        }
    }
}
