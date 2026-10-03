//! What tmux's one server holds for every client: the server and global options (hooks and
//! command aliases among them), the key tables, the paste buffers and the global environment.
//! hn's clients of a server name (-L) each hold a copy, kept the same through a file beside the
//! sessions file: a client that changes any of it (`set -g`, `bind`, a copy, `setenv -g`, a
//! `source-file`) writes what changed there and tells the others, which take it — so a copy in
//! one terminal pastes in another, as it does under one tmux server. A client starting while the
//! server lives (another client, or sessions kept) takes the file's instead of what its own
//! ~/.tmux.conf would give, as a tmux server reads its configuration once; a new server's first
//! client starts the file again.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{json, Map, Value};

use crate::app::{App, EnvVar};
use crate::keys::{Binding, Keymap, Table};
use crate::paste::Paste;

/// The server-wide state as this client last wrote or took it (the buffers by name and version:
/// their text is compared by neither).
#[derive(Clone, PartialEq)]
pub struct Synced { options: [BTreeMap<String, String>; 5], keymap: Keymap, buffers: Vec<(String, u64)>, env: BTreeMap<String, EnvVar>, marked: Option<(u32, u64)>, history: [Vec<String>; 4] }

fn path() -> PathBuf { crate::app::sessions_path(None).with_extension("server.json") }

fn now(app: &App) -> Synced {
    Synced {
        options: [app.options.server.clone(), app.options.global_session.clone(), app.options.global_window.clone(), desk_session_options(app), desk_window_options(app)],
        keymap: app.keymap.clone(),
        buffers: versions(&app.paste),
        env: app.global_env.clone(),
        marked: app.marked.map(|p| (app.marked_session.unwrap_or(app.session_id), p)),
        history: app.history.clone(),
    }
}

fn versions(p: &Paste) -> Vec<(String, u64)> { p.walk().map(|b| (b.name.clone(), b.order)).collect() }

/// The desk's session is every client's (its windows the desk's tabs): its own options, and its
/// windows' (`tab<TAB>name`), are the server's to keep alike too — one terminal's `set` or
/// `setw` is the other's, and a detach loses none of it.
fn desk_session_options(app: &App) -> BTreeMap<String, String> {
    if app.session_desk { app.options.session.clone() } else { app.sessions.iter().find(|s| s.desk).map(|s| s.options.clone()).unwrap_or_default() }
}

fn set_desk_session_options(app: &mut App, m: BTreeMap<String, String>) {
    if app.session_desk { app.options.session = m } else if let Some(s) = app.sessions.iter_mut().find(|s| s.desk) { s.options = m }
}

fn desk_tab_ids(app: &App) -> Vec<String> {
    let tabs: &[crate::app::Tab] = if app.session_desk { &app.tabs } else { app.sessions.iter().find(|s| s.desk).map(|s| s.tabs.as_slice()).unwrap_or(&[]) };
    tabs.iter().filter(|t| t.on_desk).map(|t| t.id.clone()).collect()
}

fn desk_window_options(app: &App) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for id in desk_tab_ids(app) { for (k, v) in app.options.windows.get(&id).cloned().unwrap_or_default() { out.insert(format!("{id}\t{k}"), v); } }
    out
}

fn set_desk_window_options(app: &mut App, m: BTreeMap<String, String>) {
    for id in desk_tab_ids(app) {
        let mine: BTreeMap<String, String> = m.iter().filter_map(|(k, v)| k.strip_prefix(&format!("{id}\t")).map(|n| (n.to_string(), v.clone()))).collect();
        if mine.is_empty() { app.options.windows.remove(&id); } else { app.options.windows.insert(id, mine); }
    }
}

/// Whether the server's state here is still what was last written or taken.
fn unchanged(app: &App, s: &Synced) -> bool {
    app.options.server == s.options[0] && app.options.global_session == s.options[1] && app.options.global_window == s.options[2]
        && desk_session_options(app) == s.options[3] && desk_window_options(app) == s.options[4]
        && app.history == s.history && app.keymap == s.keymap && app.global_env == s.env && app.marked.map(|p| (app.marked_session.unwrap_or(app.session_id), p)) == s.marked && app.paste.walk().map(|b| (&b.name, b.order)).eq(s.buffers.iter().map(|(n, o)| (n, *o)))
}

// ── the key tables as JSON (keys by tmux's names) ──────────────────────────────

fn table_name(t: Table) -> &'static str { match t { Table::Prefix => "prefix", Table::Root => "root", Table::CopyVi => "copy-mode-vi", Table::CopyEmacs => "copy-mode" } }

fn bindings_json(list: &[Binding]) -> Value {
    json!(list.iter().map(|b| json!([crate::keys::name(&b.chord), b.command, b.repeat, b.note])).collect::<Vec<_>>())
}

fn bindings_from(v: &Value) -> Vec<Binding> {
    v.as_array().map(|a| a.iter().filter_map(|b| Some(Binding {
        chord: crate::keys::parse(b.get(0)?.as_str()?).ok()?,
        command: b.get(1)?.as_str()?.to_string(),
        repeat: b.get(2).and_then(Value::as_bool).unwrap_or(false),
        note: b.get(3).and_then(Value::as_str).unwrap_or("").to_string(),
    })).collect()).unwrap_or_default()
}

fn keys_json(k: &Keymap) -> Value {
    json!({
        "prefix": crate::keys::name(&k.prefix),
        "prefix2": k.prefix2.map(|c| crate::keys::name(&c)),
        "prefix-table": bindings_json(&k.prefix_table), "root": bindings_json(&k.root_table),
        "copy-mode-vi": bindings_json(&k.copy_vi), "copy-mode": bindings_json(&k.copy_emacs),
        "named": k.named.iter().map(|(n, l)| (n.clone(), bindings_json(l))).collect::<Map<String, Value>>(),
        "copy-unbound": k.copy_unbound.iter().map(|(t, c)| json!([table_name(*t), crate::keys::name(c)])).collect::<Vec<_>>(),
        "removed": k.removed.iter().map(|t| table_name(*t)).collect::<Vec<_>>(),
        "repeat-ms": k.repeat_ms, "hint-ms": k.hint_ms,
    })
}

fn keys_from(v: &Value, mut k: Keymap) -> Keymap {
    if let Some(c) = v.get("prefix").and_then(Value::as_str).and_then(|s| crate::keys::parse(s).ok()) { k.prefix = c }
    k.prefix2 = v.get("prefix2").and_then(Value::as_str).and_then(|s| crate::keys::parse(s).ok());
    k.prefix_table = bindings_from(&v["prefix-table"]);
    // (Kept before a default changed: that default moves on with it.)
    Keymap::migrate_defaults(&mut k.prefix_table);
    k.root_table = bindings_from(&v["root"]);
    k.copy_vi = bindings_from(&v["copy-mode-vi"]);
    k.copy_emacs = bindings_from(&v["copy-mode"]);
    k.named = v.get("named").and_then(Value::as_object).map(|m| m.iter().map(|(n, l)| (n.clone(), bindings_from(l))).collect()).unwrap_or_default();
    k.copy_unbound = v.get("copy-unbound").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| {
        Some((crate::keys::table_named(x.get(0)?.as_str()?)?, crate::keys::parse(x.get(1)?.as_str()?).ok()?))
    }).collect()).unwrap_or_default();
    k.removed = v.get("removed").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| crate::keys::table_named(x.as_str()?)).collect()).unwrap_or_default();
    if let Some(n) = v.get("repeat-ms").and_then(Value::as_u64) { k.repeat_ms = n }
    if let Some(n) = v.get("hint-ms").and_then(Value::as_u64) { k.hint_ms = n }
    k
}

// ── the file ───────────────────────────────────────────────────────────────────

/// Read the file, change it with [f], and write it back, while its lock is held.
fn with_file(f: impl FnOnce(&mut Value)) {
    let path = path();
    let _lock = crate::ipc::lock(&path.with_extension("lock"));
    let mut doc: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
    if !doc.is_object() { doc = json!({}) }
    f(&mut doc);
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    if std::fs::write(&temp, doc.to_string()).is_ok() { let _ = std::fs::rename(&temp, &path); }
}

const MAPS: [&str; 5] = ["server", "global-session", "global-window", "desk-session", "desk-windows"];

/// What changed from [before] to [after], into the file's copy: an option set or unset, the key
/// tables (whole), a buffer made, set or freed, a variable of the global environment.
fn merge(doc: &mut Value, before: Option<&Synced>, after: &Synced, paste: &Paste, history_changes: &[crate::history::Change]) {
    for (i, name) in MAPS.iter().enumerate() {
        if !doc["options"][*name].is_object() { doc["options"][*name] = json!({}) }
        let map = doc["options"][*name].as_object_mut().unwrap();
        match before {
            None => { map.clear(); for (k, v) in &after.options[i] { map.insert(k.clone(), json!(v)); } }
            Some(b) => {
                for (k, v) in &after.options[i] { if b.options[i].get(k) != Some(v) { map.insert(k.clone(), json!(v)); } }
                for k in b.options[i].keys() { if !after.options[i].contains_key(k) { map.remove(k); } }
            }
        }
    }
    match before {
        Some(b) if b.keymap == after.keymap => {}
        // What this client bound and unbound, into the file's tables binding by binding: two
        // terminals binding at the same moment both keep theirs.
        Some(b) if doc["keys"].is_object() => { let file = keys_from(&doc["keys"], after.keymap.clone()); doc["keys"] = keys_json(&merge_keys(file, &b.keymap, &after.keymap)) }
        _ => doc["keys"] = keys_json(&after.keymap),
    }
    // Buffers by name: each one new or set again, each one gone; the counters past every client's.
    let old: &[(String, u64)] = before.map(|b| b.buffers.as_slice()).unwrap_or(&[]);
    let mut list: Vec<Value> = if before.is_none() { Vec::new() } else { doc["buffers"]["list"].as_array().cloned().unwrap_or_default() };
    let named = |v: &Value| v.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_default();
    for (n, _) in old.iter().filter(|(n, _)| !after.buffers.iter().any(|(m, _)| m == n)) { list.retain(|v| named(v) != *n) }
    for b in paste.walk().filter(|b| !old.iter().any(|(n, o)| *n == b.name && *o == b.order)) {
        list.retain(|v| named(v) != b.name);
        list.push(json!({ "name": b.name, "data": b.data, "automatic": b.automatic, "order": b.order, "created": b.created }));
    }
    doc["buffers"]["list"] = json!(list);
    let (index, order) = paste.counters();
    for (key, n) in [("next-index", index), ("next-order", order)] {
        let was = doc["buffers"][key].as_u64().unwrap_or(0);
        doc["buffers"][key] = json!(was.max(n));
    }
    match before {
        None => doc["history"] = json!(after.history),
        Some(before) if !history_changes.is_empty() => {
            let mut history = serde_json::from_value(doc["history"].clone()).unwrap_or_else(|_| before.history.clone());
            for change in history_changes { change.apply(&mut history) }
            doc["history"] = json!(history);
        }
        _ => {}
    }
    // The marked pane belongs to the server, so another terminal or a detach keeps it.
    if before.map(|b| b.marked != after.marked).unwrap_or(true) { doc["marked"] = json!(after.marked) }
    // The global environment: the server's — its first client's, whole — and what changed since.
    if !doc["env"].is_object() || before.is_none() { doc["env"] = json!({}) }
    if before.is_none() { doc["env-whole"] = json!(true) }
    let env = doc["env"].as_object_mut().unwrap();
    for (k, v) in &after.env { if before.map(|b| b.env.get(k) != Some(v)).unwrap_or(true) { env.insert(k.clone(), json!({ "value": v.value, "hidden": v.hidden })); } }
    if let Some(b) = before { for k in b.env.keys() { if !after.env.contains_key(k) { env.insert(k.clone(), Value::Null); } } }
}

/// One table's changes from [before] to [after] made to [file]: each binding added or changed
/// set there (in its place, else last), each one gone taken out.
fn merge_table(file: &mut Vec<Binding>, before: &[Binding], after: &[Binding]) {
    for b in after.iter().filter(|b| !before.contains(b)) {
        match file.iter_mut().find(|f| f.chord == b.chord) { Some(f) => *f = b.clone(), None => file.push(b.clone()) }
    }
    for gone in before.iter().filter(|b| !after.iter().any(|a| a.chord == b.chord)) { file.retain(|f| f.chord != gone.chord) }
}

/// The key tables as the file has them, with what this client changed (from [before] to
/// [after]) made to them.
fn merge_keys(mut file: Keymap, before: &Keymap, after: &Keymap) -> Keymap {
    if before.prefix != after.prefix { file.prefix = after.prefix }
    if before.prefix2 != after.prefix2 { file.prefix2 = after.prefix2 }
    if before.repeat_ms != after.repeat_ms { file.repeat_ms = after.repeat_ms }
    if before.hint_ms != after.hint_ms { file.hint_ms = after.hint_ms }
    merge_table(&mut file.prefix_table, &before.prefix_table, &after.prefix_table);
    merge_table(&mut file.root_table, &before.root_table, &after.root_table);
    merge_table(&mut file.copy_vi, &before.copy_vi, &after.copy_vi);
    merge_table(&mut file.copy_emacs, &before.copy_emacs, &after.copy_emacs);
    let names: std::collections::BTreeSet<String> = before.named.keys().chain(after.named.keys()).cloned().collect();
    for name in names {
        match (before.named.get(&name), after.named.get(&name)) {
            (Some(_), None) => { file.named.remove(&name); }
            (b, Some(a)) => merge_table(file.named.entry(name).or_default(), b.map(Vec::as_slice).unwrap_or(&[]), a),
            (None, None) => {}
        }
    }
    for x in after.copy_unbound.iter().filter(|x| !before.copy_unbound.contains(x)) { if !file.copy_unbound.contains(x) { file.copy_unbound.push(*x) } }
    for x in before.copy_unbound.iter().filter(|x| !after.copy_unbound.contains(x)) { file.copy_unbound.retain(|f| f != x) }
    for t in after.removed.iter().filter(|t| !before.removed.contains(t)) { if !file.removed.contains(t) { file.removed.push(*t) } }
    for t in before.removed.iter().filter(|t| !after.removed.contains(t)) { file.removed.retain(|f| f != t) }
    file
}

/// The file's buffers, as a Paste.
fn paste_from(doc: &Value) -> Paste {
    let list = doc["buffers"]["list"].as_array().cloned().unwrap_or_default().iter().filter_map(|v| Some(crate::paste::Buffer {
        name: v.get("name")?.as_str()?.to_string(),
        data: v.get("data")?.as_str()?.to_string(),
        automatic: v.get("automatic").and_then(Value::as_bool).unwrap_or(true),
        order: v.get("order").and_then(Value::as_u64).unwrap_or(0),
        created: v.get("created").and_then(Value::as_i64).unwrap_or(0),
    })).collect();
    Paste::from_parts(list, doc["buffers"]["next-index"].as_u64().unwrap_or(0), doc["buffers"]["next-order"].as_u64().unwrap_or(0))
}

/// Save the latest server history while holding the same lock that publishes additions.
/// Use the server's filename too: this client may not yet have received a changed option.
pub fn save_history(app: &App) {
    with_file(|doc| {
        let history = serde_json::from_value(doc["history"].clone()).unwrap_or_else(|_| app.history.clone());
        let file = if doc["options"]["server"].is_object() {
            doc["options"]["server"]["history-file"].as_str().unwrap_or("").to_string()
        } else { app.options.get("history-file", "", None).unwrap_or_default() };
        crate::history::save_file(&file, &history);
    });
}

// ── joining, publishing, taking ────────────────────────────────────────────────

/// A client started (its configuration read): a new server's first client starts the file with
/// what it has; any other takes the server's.
pub fn join(app: &mut App) {
    if crate::ids::fresh() || !path().exists() {
        crate::history::load(app);
        let mine = now(app);
        with_file(|doc| { *doc = json!({}); merge(doc, None, &mine, &app.paste, &[]) });
        app.history_changes.clear();
        app.server_synced = Some(mine);
    } else {
        take(app);
    }
}

/// After commands ran: what they changed of the server's state, into the file and to the other
/// clients.
pub fn publish(app: &mut App) {
    if !std::mem::take(&mut app.server_dirty) { return }
    let Some(before) = app.server_synced.as_ref() else { return };
    if app.history_changes.is_empty() && unchanged(app, before) { return }
    let before = before.clone();
    let mut after = now(app);
    let history_changes = std::mem::take(&mut app.history_changes);
    with_file(|doc| {
        merge(doc, Some(&before), &after, &app.paste, &history_changes);
        if let Ok(history) = serde_json::from_value(doc["history"].clone()) { after.history = history }
    });
    app.history = after.history.clone();
    app.server_synced = Some(after);
    let others = crate::commands::other_clients();
    if others.is_empty() { return }
    tokio::spawn(async move { for peer in others { crate::ipc::notify(&peer, &["hn-server-sync".to_string()]).await } });
}

/// hn-server-sync: another client changed the server's state; this one takes it (what it
/// changed itself first written, so neither is lost).
pub fn take(app: &mut App) {
    app.server_dirty = true;
    publish(app);
    let doc: Value = std::fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    if !doc.is_object() { app.server_synced = Some(now(app)); return }
    // Options: each one that differs set as `set -g` sets it (what hn keeps outside the store
    // follows), each one gone unset.
    for (i, name) in MAPS.iter().enumerate() {
        let theirs: BTreeMap<String, String> = doc["options"][*name].as_object().map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default();
        let mine = match i { 0 => app.options.server.clone(), 1 => app.options.global_session.clone(), 2 => app.options.global_window.clone(), 3 => desk_session_options(app), _ => desk_window_options(app) };
        if theirs == mine { continue }
        // (A file from before the desk's were kept: the desk's left as they are here.)
        if i >= 3 && doc["options"][*name].is_null() { continue }
        let changed: Vec<String> = theirs.iter().filter(|(k, v)| mine.get(*k) != Some(*v)).map(|(k, _)| k.clone()).chain(mine.keys().filter(|k| !theirs.contains_key(*k)).cloned()).collect();
        match i { 0 => app.options.server = theirs, 1 => app.options.global_session = theirs, 2 => app.options.global_window = theirs, 3 => set_desk_session_options(app, theirs), _ => set_desk_window_options(app, theirs) }
        for name in changed { let name = name.rsplit('\t').next().unwrap_or(&name).to_string(); crate::commands::option_changed(app, &name) }
    }
    if doc["keys"].is_object() { app.keymap = keys_from(&doc["keys"], app.keymap.clone()) }
    app.paste = paste_from(&doc);
    if let Ok(history) = serde_json::from_value(doc["history"].clone()) { app.history = history }
    app.history_changes.clear();
    app.marked_session = doc["marked"].get(0).and_then(Value::as_u64).map(|s| s as u32);
    app.marked = doc["marked"].get(1).and_then(Value::as_u64);
    if let Some(env) = doc["env"].as_object() {
        // The server's environment, as tmux's is its first client's (else only what changed).
        if doc["env-whole"].as_bool().unwrap_or(false) { app.global_env.clear() }
        for (k, v) in env {
            match v.as_object() {
                Some(o) => { app.global_env.insert(k.clone(), EnvVar { value: o.get("value").and_then(Value::as_str).map(str::to_string), hidden: o.get("hidden").and_then(Value::as_bool).unwrap_or(false) }); }
                None => { app.global_env.remove(k); }
            }
        }
    }
    app.redraw_all = true;
    app.server_dirty = false;
    app.server_synced = Some(now(app));
}
