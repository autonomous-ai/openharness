//! Session, window and pane ids ($N @N %N) as tmux's server gives them: unique among every client
//! of a server name (-L), and kept with the session when it moves between clients — so an id a
//! script got from one terminal names the same thing from any other, and after a detach.
//!
//! Each id comes from counters kept beside the sessions file (under a lock of their own, never
//! taken while the sessions file's is held), one at a time as tmux's next_session_id++ gives
//! them — no gaps between clients — and the desk's windows and panes (one desk, shown by every
//! client) have theirs recorded there too, so every client calls them the same. The counters
//! start again when the server is gone (no client, no session kept), as a new tmux server's do.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Kind { Session, Window, Pane }

impl Kind {
    fn key(self) -> &'static str { match self { Kind::Session => "session", Kind::Window => "window", Kind::Pane => "pane" } }
    /// The first id there is: %0 is pane 1 inside (pane::tag), $0 and @0 are 0.
    fn first(self) -> u64 { match self { Kind::Pane => 1, _ => 0 } }
}

#[derive(Default)]
struct Ids { file: Option<PathBuf>, local: HashMap<Kind, u64>, desk: HashMap<(Kind, String), u64> }

static IDS: Mutex<Option<Ids>> = Mutex::new(None);

/// Whether this client's server is a new one (its counters started again when it came).
static FRESH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Whether this client is its server's first (no other client, no session kept, when it came).
pub fn fresh() -> bool { FRESH.load(std::sync::atomic::Ordering::Relaxed) }

/// The counters' file, beside the sessions file of this server name.
fn path_for(sessions: &std::path::Path) -> PathBuf { sessions.with_extension("ids.json") }

/// This client's ids come from the counters of [sessions]'s server name from now on — started
/// again when no other client numbers from them and no session is kept: a new server, as tmux's
/// numbers from $0 @0 %0.
pub fn use_file(sessions: &std::path::Path) {
    let path = path_for(sessions);
    let kept = crate::app::read_sessions(sessions)["sessions"].as_array()
        .map(|rows| rows.iter().any(|r| !r.get("desk").and_then(Value::as_bool).unwrap_or(false))).unwrap_or(false);
    let me = std::process::id() as u64;
    with_file(&path, |doc| {
        let others: Vec<u64> = doc["clients"].as_array().map(|a| a.iter().filter_map(Value::as_u64).filter(|p| *p != me && running(*p)).collect()).unwrap_or_default();
        // (A server whose last terminal detached from the desk lives on, as tmux's does.)
        let fresh = others.is_empty() && !kept && !doc["detached"].as_bool().unwrap_or(false);
        FRESH.store(fresh, std::sync::atomic::Ordering::Relaxed);
        if fresh { *doc = json!({}) }
        doc["clients"] = json!(others.into_iter().chain([me]).collect::<Vec<_>>());
    });
    if let Ok(mut g) = IDS.lock() { g.get_or_insert_with(Ids::default).file = Some(path) }
}

/// This client numbers from the counters no more (it is going) — [lives_on]: the server with it
/// (it detached from the desk; kill-server says no), for the next client to take up.
pub fn leave(lives_on: Option<bool>) {
    let Some(path) = IDS.lock().ok().and_then(|g| g.as_ref().and_then(|i| i.file.clone())) else { return };
    let me = std::process::id() as u64;
    with_file(&path, |doc| {
        if let Some(a) = doc["clients"].as_array_mut() { a.retain(|p| p.as_u64() != Some(me)) }
        if let Some(on) = lives_on { doc["detached"] = json!(on) }
    });
}

/// Whether process [pid] is running (kill 0: there, or there and not ours to signal).
fn running(pid: u64) -> bool {
    let Ok(pid) = i32::try_from(pid) else { return false };
    if pid <= 0 { return false }
    let there = unsafe { libc::kill(pid, 0) } == 0;
    there || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Read the counters' file, do [f] with it, and write it back — all while its lock is held.
fn with_file<R>(path: &std::path::Path, f: impl FnOnce(&mut Value) -> R) -> R {
    let _lock = crate::ipc::lock(&path.with_extension("lock"));
    let mut doc: Value = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
    if !doc.is_object() { doc = json!({}) }
    let r = f(&mut doc);
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    if std::fs::write(&temp, doc.to_string()).is_ok() { let _ = std::fs::rename(&temp, path); }
    r
}

/// A new id of [kind], never given before by any client of this server name.
pub fn next(kind: Kind) -> u64 {
    let Ok(mut g) = IDS.lock() else { return kind.first() };
    let ids = g.get_or_insert_with(Ids::default);
    let Some(path) = ids.file.clone() else {
        // No server name (a unit test, the CLI): numbered here alone.
        let n = ids.local.entry(kind).or_insert(kind.first());
        let id = *n;
        *n += 1;
        return id;
    };
    with_file(&path, |doc| {
        let id = doc["next"][kind.key()].as_u64().unwrap_or(kind.first()).max(kind.first());
        doc["next"][kind.key()] = json!(id + 1);
        id
    })
}

/// The id [next] would give now, not taken (#{next_session_id}).
pub fn peek(kind: Kind) -> u64 {
    let Ok(g) = IDS.lock() else { return kind.first() };
    let Some(ids) = g.as_ref() else { return kind.first() };
    match ids.file.clone() {
        Some(path) => std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|doc| doc["next"][kind.key()].as_u64()).unwrap_or(kind.first()).max(kind.first()),
        None => ids.local.get(&kind).copied().unwrap_or(kind.first()),
    }
}

/// An id a session brought from another client (the sessions file): taken as it is. The
/// counters are past it already (it was given from them), unless the file is older than them.
pub fn keep(kind: Kind, id: u64) {
    let Ok(mut g) = IDS.lock() else { return };
    let ids = g.get_or_insert_with(Ids::default);
    let Some(path) = ids.file.clone() else { return };
    with_file(&path, |doc| {
        let next = doc["next"][kind.key()].as_u64().unwrap_or(kind.first());
        if id >= next { doc["next"][kind.key()] = json!(id + 1) }
    });
}

/// A desk thing this client made, by the id it gave it: every client calls it that (unless one
/// was recorded for it first).
pub fn desk_set(kind: Kind, key: &str, id: u64) {
    let path = match IDS.lock() { Ok(g) => g.as_ref().and_then(|i| i.file.clone()), Err(_) => None };
    let Some(path) = path else { return };
    let id = with_file(&path, |doc| {
        if let Some(had) = doc["desk"][kind.key()][key].as_u64() { return had }
        doc["desk"][kind.key()][key] = json!(id);
        id
    });
    if let Ok(mut g) = IDS.lock() { g.get_or_insert_with(Ids::default).desk.insert((kind, key.to_string()), id); }
}

/// The id every client gives a desk thing (a window by its tab id, a pane by its harness): the
/// one recorded, else the counter's next, recorded — in one hold of the file.
pub fn desk(kind: Kind, key: &str) -> u64 {
    let (path, known) = match IDS.lock() {
        Ok(g) => (g.as_ref().and_then(|i| i.file.clone()), g.as_ref().and_then(|i| i.desk.get(&(kind, key.to_string())).copied())),
        Err(_) => (None, None),
    };
    if let Some(id) = known { return id }
    let Some(path) = path else { return next(kind) };
    let id = with_file(&path, |doc| {
        if let Some(id) = doc["desk"][kind.key()][key].as_u64() { return id }
        let id = doc["next"][kind.key()].as_u64().unwrap_or(kind.first()).max(kind.first());
        doc["next"][kind.key()] = json!(id + 1);
        doc["desk"][kind.key()][key] = json!(id);
        id
    });
    if let Ok(mut g) = IDS.lock() { g.get_or_insert_with(Ids::default).desk.insert((kind, key.to_string()), id); }
    id
}
