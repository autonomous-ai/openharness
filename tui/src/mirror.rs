//! tmux's several clients of one session, across hn's clients. A session another client of the
//! server has (its owner) is shown here as the owner has it — its windows and their layouts, the
//! current window, each window's active pane — and what changes it (split-window, select-pane,
//! new-window, kill-pane, a resize …) is done by the owner, with its targets made absolute here
//! (`%N @N $N`, one thing among every client). The owner tells each client showing the session
//! when it changed, and they show it again. Keys typed into a pane go to its harness from here,
//! as they do from the owner (the daemon's keyboard follows whoever types). The owner gone (it
//! detached), a client showing the session has it next; the session gone, it is `[exited]` here
//! too. `attach -r` shows a session without typing into it or changing it.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::app::{live_owner, read_sessions, App, Mirror, Stash, Tab};
use crate::layout::Node;

/// Session [name]'s row in the sessions file, read now.
/// Session [id]'s row (its $N is kept wherever it goes, whatever it is named now), else by
/// [name] (a row from before ids were kept).
pub fn row_of(id: u32, name: &str) -> Option<Value> {
    let doc = read_sessions(&crate::app::sessions_path(None));
    let rows = doc["sessions"].as_array()?;
    let live = |r: &&Value| !r.get("desk").and_then(Value::as_bool).unwrap_or(false);
    rows.iter().filter(live).find(|r| r.get("id").and_then(Value::as_u64) == Some(id as u64)).or_else(|| rows.iter().filter(live).find(|r| r.get("name").and_then(Value::as_str) == Some(name))).cloned()
}

fn row_named(name: &str) -> Option<Value> {
    let doc = read_sessions(&crate::app::sessions_path(None));
    doc["sessions"].as_array()?.iter().find(|r| r.get("name").and_then(Value::as_str) == Some(name) && !r.get("desk").and_then(Value::as_bool).unwrap_or(false)).cloned()
}

fn me() -> String { crate::ipc::here().map(|p| p.display().to_string()).unwrap_or_default() }

/// Tell the owner this client shows its session [id] (or, [add] false, no longer does).
fn register(owner: &str, id: u32, add: bool) {
    let words: Vec<String> = if add { vec!["hn-mirror".into(), "-a".into(), me(), "-t".into(), format!("${id}"), "-c".into(), crate::app::tty_name()] } else { vec!["hn-mirror".into(), "-d".into(), me(), "-t".into(), format!("${id}")] };
    let owner = std::path::PathBuf::from(owner);
    tokio::spawn(async move { crate::ipc::notify(&owner, &words).await });
}

/// attach-session / switch-client to session [id], another client's: kept among this client's
/// sessions as that client has it, to be gone to. False when no running client has it (it is
/// taken from the file instead, as before).
pub fn show(app: &mut App, id: u32, readonly: bool) -> bool {
    let Some(r) = app.remote_rows().into_iter().find(|r| r.id == id) else { return false };
    let Some(owner) = r.owner.clone() else { return false };
    let Some(row) = row_named(&r.name) else { return false };
    let (w, h) = (app.body().width, app.body().height);
    let mut stash = Stash { id, used: 0, alias: Some(r.name.clone()), desk: false, tabs: Vec::new(), active: 0, lastw: Vec::new(), nums: HashMap::new(),
        created: r.created, activity: r.activity, last_attached: r.last_attached, options: crate::app::options_from(&row), env: crate::app::env_from(&row), path: row.get("path").and_then(serde_json::Value::as_str).map(str::to_string), group: row.get("group").and_then(serde_json::Value::as_str).map(str::to_string), mirror: Some(Mirror { owner: owner.clone(), readonly }) };
    if !fill(app, &mut stash, &row, Vec::new(), (w, h)) { return false }
    app.sessions.push(stash);
    register(&owner, id, true);
    true
}

/// The windows of [stash] made again from the owner's [row] (fitted to [size]): the windows and
/// panes it had kept (their panes' terminals stay open), the others made, those gone dropped.
/// False when the row has no window.
fn fill(app: &mut App, stash: &mut Stash, row: &Value, mut old: Vec<Tab>, size: (u16, u16)) -> bool {
    let before: HashSet<u64> = old.iter().flat_map(|t| t.panes()).collect();
    let mut tabs = Vec::new();
    let mut nums = HashMap::new();
    let mut seen = HashSet::new();
    for win in row.get("windows").and_then(Value::as_array).cloned().unwrap_or_default() {
        let panes: Vec<(String, String, Option<u64>)> = win.get("panes").and_then(Value::as_array).map(|a| a.iter().filter_map(|p| Some((
            p.get(0)?.as_str()?.to_string(), p.get(1)?.as_str()?.to_string(), p.get(3).and_then(Value::as_u64),
        ))).collect()).unwrap_or_default();
        if panes.is_empty() { continue }
        let ids: Vec<u64> = panes.iter().map(|(m, a, id)| match id.filter(|i| app.panes.get(i).map(|p| p.machine_id == *m && p.agent_id == *a).unwrap_or(false)) {
            Some(i) => i,
            None => app.new_pane_as(m, a, *id),
        }).collect();
        seen.extend(ids.iter().copied());
        let name = win.get("name").and_then(Value::as_str).unwrap_or("");
        let wid = win.get("wid").and_then(Value::as_u64);
        let mut tab = match wid.and_then(|w| old.iter().position(|t| t.is_wid(w))) {
            Some(i) => old.remove(i),
            None => match wid { Some(w) => Tab::with_wid(name, w), None => Tab::new(name) },
        };
        tab.name = name.to_string();
        tab.named = win.get("named").and_then(Value::as_bool).unwrap_or(false);
        let layout = win.get("layout").and_then(Value::as_str).unwrap_or("");
        // A shared window keeps its own geometry. Only the active nonmanual window is fitted
        // to this terminal later; inactive and explicitly resized windows retain their size.
        let (w, h) = Node::tmux_size(layout).unwrap_or(size);
        tab.root = Node::from_tmux(layout, &ids, w, h).or_else(|| crate::layout::arrange(crate::layout::Named::Tiled, &ids, w, h, crate::layout::Status::Top, crate::app::DESK_MAIN, ("0", "0")));
        tab.order = ids.clone();
        tab.focus = ids.get(win.get("focus").and_then(Value::as_u64).unwrap_or(0) as usize).or(ids.first()).copied();
        tab.zoomed = win.get("zoomed").and_then(Value::as_bool).unwrap_or(false) && ids.len() > 1;
        tab.alerts = win.get("alerts").and_then(Value::as_u64).unwrap_or(0) as u8;
        app.take_window_options(&mut tab, &win);
        if let Some(n) = win.get("num").and_then(Value::as_u64) { nums.insert(tab.id.clone(), n as usize); }
        tabs.push(tab);
    }
    // Panes no longer the session's: their terminals closed here (the harnesses are the owner's).
    for p in before.difference(&seen) { app.forget_pane(*p) }
    for t in old { for p in t.panes() { if !seen.contains(&p) { app.forget_pane(p) } } }
    if tabs.is_empty() { return false }
    stash.active = (row.get("active").and_then(Value::as_u64).unwrap_or(0) as usize).min(tabs.len() - 1);
    stash.lastw = row.get("last").and_then(Value::as_array).map(|l| l.iter().filter_map(|i| tabs.get(i.as_u64()? as usize).map(|t| t.id.clone())).collect()).unwrap_or_default();
    stash.tabs = tabs;
    stash.nums = nums;
    true
}

/// hn-mirror-refresh (the owner changed the session, or went), and after a command the owner ran
/// for this client: the session shown again as its owner has it — taken, when no client has it
/// now; left, when it is gone.
pub fn refresh(app: &mut App) {
    let Some(m) = app.mirror.clone() else { return };
    let name = app.session_name();
    let Some(row) = row_of(app.session_id, &name) else { return gone(app) };
    // Renamed where it is kept (rename-session, C-b $): named so here too.
    if let Some(now) = row.get("name").and_then(Value::as_str).filter(|n| *n != name) { app.session_alias = Some(now.to_string()) }
    let name = app.session_name();
    match live_owner(&row) {
        // The owner detached: this client has the session now.
        None => {
            let path = crate::app::sessions_path(None);
            let lock = crate::ipc::lock(&path);
            let row = row_of(app.session_id, &name).filter(|r| live_owner(r).is_none());
            if let Some(row) = row {
                rebuild(app, &row);
                for p in row.get("windows").and_then(Value::as_array).cloned().unwrap_or_default().iter().flat_map(|w| w.get("panes").and_then(Value::as_array).cloned().unwrap_or_default()) {
                    if p.get(2).and_then(Value::as_bool).unwrap_or(false) { if let (Some(m), Some(a)) = (p.get(0).and_then(Value::as_str), p.get(1).and_then(Value::as_str)) { app.shells.insert((m.to_string(), a.to_string())); } }
                }
                app.mirror = None;
                app.write_sessions_held(crate::app::Save::Stay);
            }
            drop(lock);
            if app.mirror.is_some() { refresh(app) }
        }
        // Another client has it now (the owner detached, and another one showing it took it).
        Some(owner) if owner != m.owner => {
            app.mirror = Some(Mirror { owner: owner.clone(), readonly: m.readonly });
            register(&owner, app.session_id, true);
            rebuild(app, &row);
        }
        Some(_) => rebuild(app, &row),
    }
}

/// The session in front made again from its row.
fn rebuild(app: &mut App, row: &Value) {
    let body = app.body();
    let current = app.tabs.get(app.active).map(|t| t.id.clone());
    let mut stash = Stash { id: app.session_id, used: app.session_used, alias: app.session_alias.clone(), desk: false, tabs: Vec::new(), active: 0, lastw: Vec::new(), nums: HashMap::new(),
        created: app.session_created, activity: app.session_activity, last_attached: app.session_last_attached, options: Default::default(), env: Default::default(), path: app.session_path.clone(), group: app.session_group.clone(), mirror: app.mirror.clone() };
    let old = std::mem::take(&mut app.tabs);
    if !fill(app, &mut stash, row, old, (body.width, body.height)) { return gone(app) }
    app.tabs = stash.tabs;
    app.nums = stash.nums;
    app.active = stash.active;
    app.lastw = stash.lastw;
    app.options.session = crate::app::options_from(row);
    app.session_env = crate::app::env_from(row);
    app.session_group = row.get("group").and_then(Value::as_str).map(str::to_string);
    app.session_path = row.get("path").and_then(Value::as_str).map(str::to_string);
    app.session_activity = row.get("activity").and_then(Value::as_i64).unwrap_or(app.session_activity);
    app.session_last_attached = row.get("last_attached").and_then(Value::as_i64).unwrap_or(app.session_last_attached);
    // Its clients: the owner (when it shows it) and every one showing it as it has it.
    app.mirror_attached = row.get("front").and_then(Value::as_bool).unwrap_or(false) as u32 + row.get("mirrors").and_then(Value::as_u64).unwrap_or(1) as u32;
    // What the owner did is the owner's to hook: nothing fires here for it.
    app.hooks_seen_now();
    if current != app.tabs.get(app.active).map(|t| t.id.clone()) { if let Some(f) = app.tabs[app.active].focus { app.seen(f) } }
    app.fit_panes();
    app.redraw_all = true;
}

/// The session was killed (by its owner, or a command from anywhere): as tmux's clients of a
/// destroyed session, this one goes to another session, else exits.
fn gone(app: &mut App) {
    if let Some(m) = app.mirror.take() { register(&m.owner, app.session_id, false) }
    for t in std::mem::take(&mut app.tabs) { for p in t.panes() { app.forget_pane(p) } }
    app.tabs.push(Tab::home());
    app.active = 0;
    app.session_destroyed();
}

/// A mirror left behind (switch-client elsewhere): its terminals closed, the owner told.
pub fn drop_stash(app: &mut App, s: Stash) {
    if let Some(m) = &s.mirror { register(&m.owner, s.id, false) }
    // (A pane still in a session here — a group's windows are in each of its sessions — stays.)
    let kept: HashSet<u64> = app.tabs.iter().chain(app.sessions.iter().flat_map(|x| x.tabs.iter())).flat_map(|t| t.panes()).collect();
    for t in s.tabs { for p in t.panes() { if !kept.contains(&p) { app.forget_pane(p) } } }
}

/// This client goes (detach, exit): the owner told at once.
pub fn leave(app: &App) {
    let mut owners: Vec<String> = app.mirror.iter().map(|m| m.owner.clone()).collect();
    owners.extend(app.sessions.iter().filter_map(|s| s.mirror.as_ref().map(|m| m.owner.clone())));
    for o in owners { crate::ipc::notify_now(std::path::Path::new(&o), &["hn-mirror".into(), "-d".into(), me()]) }
}

/// A command's own to this client: what it shows or asks (display-message, choose-tree, list-*,
/// copy mode …), what it types into a pane (send-keys, paste-buffer: from here, as keys), and
/// the server's state (set -g, bind, buffers …, every client's already).
fn local(app: &App, entry: &crate::cmd::Entry, words: &[String]) -> bool {
    let global = || crate::cmd::parse(entry, &crate::tmuxconf::unblock(words)).map(|a| a.has('g') > 0 || a.has('s') > 0).unwrap_or(false);
    let _ = app;
    match entry.name {
        "set-option" | "set-window-option" | "set-hook" | "set-environment" | "show-options" | "show-window-options" | "show-hooks" | "show-environment" => entry.name.starts_with("show") || global(),
        "split-window" | "new-window" | "kill-pane" | "kill-window" | "kill-session" | "select-pane" | "select-window" | "next-window" | "previous-window"
        | "last-window" | "last-pane" | "resize-pane" | "resize-window" | "swap-pane" | "swap-window" | "move-window" | "move-pane" | "join-pane"
        | "break-pane" | "rotate-window" | "select-layout" | "next-layout" | "previous-layout" | "respawn-pane" | "respawn-window" | "rename-window"
        | "rename-session" | "link-window" | "unlink-window" => false,
        _ => true,
    }
}

/// A command for the session in front, when it is another client's: done by that client, its
/// targets (or where it would run: this pane, this window) made absolute first. True when it was.
pub fn route(app: &mut App, words: &[String]) -> bool {
    let Some(m) = app.mirror.clone() else { return false };
    if app.swap_back.is_some() { return false }
    let Some(entry) = words.first().and_then(|w| crate::cmd::find(w).ok()) else { return false };
    if local(app, &entry, words) { return false }
    if m.readonly { app.error("client is read-only"); return true }
    let words = absolute(app, &entry, words);
    crate::commands::forward(app, &m.owner, &words);
    refresh(app);
    true
}

/// [words] with -t and -s as ids: what they name here (or, with none, what the command would
/// take here) is the same thing to every client.
pub fn absolute(app: &App, entry: &crate::cmd::Entry, words: &[String]) -> Vec<String> {
    let args = crate::cmd::parse(entry, &crate::tmuxconf::unblock(words)).ok();
    let sid = app.session_id;
    let mut out = words.to_vec();
    for (flag, spec) in [('t', entry.target), ('s', entry.source)] {
        let Some(spec) = spec else { continue };
        let given = args.as_ref().and_then(|a| a.get(flag)).map(str::to_string);
        // A source only when one is given (without one it is the marked pane).
        if flag == 's' && given.is_none() { continue }
        let Ok(found) = crate::cmd::resolve(app, given.as_deref(), spec) else { continue };
        let wid = |w: Option<usize>| w.and_then(|w| app.tabs.get(w)).map(|t| format!("@{}", t.wid()));
        let id = match spec.kind {
            // (With its session and window: a pane is in every session of a group, and a session's
            // option set through it is that session's.)
            crate::cmd::Kind::Pane => found.pane.map(|p| match wid(found.window) { Some(w) => format!("${sid}:{w}.{}", crate::pane::tag(p)), None => crate::pane::tag(p) }).or_else(|| wid(found.window).map(|w| format!("${sid}:{w}"))),
            crate::cmd::Kind::Window if spec.window_index => Some(match (given.is_some(), found.idx) { (true, Some(i)) => format!("${sid}:{i}"), _ => format!("${sid}:") }),
            // (In its session: a window may be in several — link-window, a group.)
            crate::cmd::Kind::Window => wid(found.window).map(|w| format!("${sid}:{w}")),
            crate::cmd::Kind::Session => Some(format!("${sid}")),
        };
        let Some(id) = id else { continue };
        let f = format!("-{flag}");
        // The flag's value replaced (or added): `-t x`, `-tx`.
        let mut i = 1;
        let mut done = false;
        while i < out.len() {
            if out[i] == "--" { break }
            if out[i] == f && i + 1 < out.len() { out[i + 1] = id.clone(); done = true; break }
            if out[i].starts_with(&f) && out[i].len() > 2 && !out[i].starts_with("--") { out[i] = format!("{f}{id}"); done = true; break }
            i += 1;
        }
        if !done { out.insert(1, id); out.insert(1, f) }
    }
    out
}

/// The owner's side: the clients showing its sessions, told when they changed.
pub fn tell_mirrors(app: &App) {
    for m in app.mirrors.keys() {
        let peer = std::path::PathBuf::from(m);
        tokio::spawn(async move { crate::ipc::notify(&peer, &["hn-mirror-refresh".to_string()]).await });
    }
}

/// The owner's side, as it goes: told at once (its sessions are left for them).
pub fn tell_mirrors_now(app: &App) {
    for m in app.mirrors.keys() { crate::ipc::notify_now(std::path::Path::new(m), &["hn-mirror-refresh".into()]) }
}
