//! The whole TUI's state and everything that changes it — except keys, which are `input.rs`, and
//! drawing, which is `ui.rs`. One owner, one loop: machine frames, terminal bytes, keys and the
//! results of background requests all arrive as `Event`s and are applied here in order.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::daemon::{http_json, Link, RpcError};
use crate::event::{Event, MachineEvent};
use crate::fleet::{self, Fleet, Machine, Reach};
use crate::layout::{self, Dir, Node, Preset, Toward};
use crate::modal::Modal;
use crate::pane::{self, Pane, Phase};
use crate::proto::{self, Kind};
use crate::theme;

/// What tmux's parser asks of the server: its global environment, formats, home folders.
impl crate::cmdparse::Env for App {
    fn var(&self, name: &str) -> Option<String> { self.global_env.get(name).and_then(|e| e.value.clone()) }
    fn assign(&mut self, assignment: &str, hidden: bool) {
        let Some((k, v)) = assignment.split_once('=') else { return };
        self.global_env.insert(k.to_string(), EnvVar { value: Some(v.to_string()), hidden });
    }
    fn expand(&mut self, format: &str) -> String { crate::format::expand_nojobs(self, format) }
    fn home(&self, user: Option<&str>) -> Option<String> {
        if user.is_none() { if let Some(h) = self.var("HOME").filter(|h| !h.is_empty()) { return Some(h) } }
        let pw = unsafe { match user { Some(u) => { let c = std::ffi::CString::new(u).ok()?; libc::getpwnam(c.as_ptr()) } None => libc::getpwuid(libc::getuid()) } };
        if pw.is_null() { return None }
        Some(unsafe { std::ffi::CStr::from_ptr((*pw).pw_dir) }.to_string_lossy().into_owned())
    }
}

/// tmux's winlink alert flags.
pub const ACTIVITY: u8 = 1;
pub const BELL: u8 = 2;
pub const SILENCE: u8 = 4;

/// An environment's variable, as tmux's environ keeps one: a value, or none (cleared: `-NAME`,
/// taken away from what runs), and whether it is hidden (%hidden, set-environment -h).
#[derive(Clone, Debug, PartialEq)]
pub struct EnvVar { pub value: Option<String>, pub hidden: bool }

/// A session not on screen (tmux's sessions): its windows and what a session keeps of them,
/// swapped in whole when the client switches to it — or for a moment, while a command that names
/// it (`-t work:2`) runs. The session on screen keeps the same in App's own fields.
pub struct Stash {
    pub id: u32,
    /// When it was last used, in order (use_order): the session used last is the one a command
    /// from a shell with no -t is for, whatever second two uses fell in.
    pub used: u64,
    /// Another client's session, shown here as it has it (mirror.rs).
    pub mirror: Option<Mirror>,
    /// Its name; None for the desk's session while it is named for this computer.
    pub alias: Option<String>,
    /// The desk's session: its windows are the desk's tabs, shared with every window on the account.
    pub desk: bool,
    pub tabs: Vec<Tab>,
    pub active: usize,
    pub lastw: Vec<String>,
    pub nums: HashMap<String, usize>,
    pub created: i64,
    /// When it was last used (session_update_activity): when the client left it, else when made.
    pub activity: i64,
    /// When a client last went to it (server_client_set_session); 0 while none has.
    pub last_attached: i64,
    pub options: std::collections::BTreeMap<String, String>,
    pub env: std::collections::BTreeMap<String, EnvVar>,
    /// Its start directory (tmux's s->cwd: new -c, attach -c; else the folder it was made in).
    pub path: Option<String>,
    /// Its session group (new -t): the sessions of one group have the same windows.
    pub group: Option<String>,
}

/// What `hn new` or `hn attach` asked for when it started this client.
#[derive(Clone, Debug, Default)]
pub struct StartSession { pub name: Option<String>, pub create: bool, pub attach_existing: bool, pub window: Option<String>, pub cwd: Option<String>, pub command: Option<String>, pub target: Option<String>,
    /// attach -d (new -A -D): the session's other clients detached, as tmux's; -r: only watched.
    pub detach: bool, pub readonly: bool,
    /// attach -f's client flags (read-only, ignore-size, active-pane …; -r is read-only and ignore-size).
    pub flags: Vec<String>,
    /// new -t: the session whose group it joins (its windows shared). 
    pub group: Option<String> }

impl StartSession {
    /// How it goes to a session another client has: -d takes it, -r watches it, else shared.
    pub fn attach_how(&self) -> Attach { if self.detach { Attach::Take } else if self.readonly { Attach::Watch } else { Attach::Share } }
}

/// The next in the order sessions are used in (a key, a switch, a new session): finer than
/// #{session_activity}'s seconds, as tmux compares its activity times to the microsecond.
/// How long the wheel must rest before the screen is written whole once more.
pub const SCROLL_SETTLE: Duration = Duration::from_millis(250);

/// How long until the settle repaint is due (None: no scroll to settle; zero: due now).
pub fn scroll_settle_in(scrolled_at: Option<Instant>, now: Instant) -> Option<Duration> {
    scrolled_at.map(|at| (at + SCROLL_SETTLE).saturating_duration_since(now))
}

pub fn use_order() -> u64 {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// A session another client of the server has, shown here as that client has it — tmux's second
/// client of a session (mirror.rs): the socket of the client that has it, and whether this one
/// only watches (attach -r).
#[derive(Clone, Debug, PartialEq)]
pub struct Mirror { pub owner: String, pub readonly: bool }

/// How switch-client goes to a session another client has: shown here as that client has it
/// (tmux's attach), only watched (attach -r), or taken, that client detaching (attach -d).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Attach { Share, Watch, Take }

/// A session this client does not have: another client of this server name has it (`owner`, the
/// socket that client listens on), or none does (its client detached). As the sessions file says:
/// listed with this client's own, and made this client's when it is gone to.
#[derive(Clone, Debug)]
pub struct RemoteSession { pub id: u32, pub name: String, pub owner: Option<String>,
    /// The clients showing it: its owner's (when in front there) and those that show it as it has it.
    pub attached: u32, pub created: i64, pub activity: i64, pub last_attached: i64, pub active: usize, pub windows: Vec<(usize, String, usize)>,
    /// Its windows' ids (@N) and its panes' (%N inside: pane::tag), as its client keeps them.
    pub wids: Vec<u64>, pub pane_ids: Vec<u64>,
    /// Each window's active pane (%N inside).
    pub active_panes: Vec<u64>,
    /// Its last window (of its windows, as listed).
    pub last: Option<usize>,
    pub stack: Vec<usize>,
    pub window_flags: Vec<String>,
    pub alerts: String,
    pub attached_clients: Vec<(u64, String)>,
    pub path: Option<String>,
    /// Its session group (new -t), if it is in one.
    pub group: Option<String> }

/// The sessions file as last read (its time and size, and when its clients were last asked after),
/// the sessions in it this client does not have, and the ids this client gives them (`$N`).
#[derive(Default)]
pub struct Remote { stamp: Option<(std::time::SystemTime, u64)>, read_at: Option<Instant>, rows: Vec<RemoteSession>, pub ids: HashMap<String, u32> }

/// A wait-for channel (cmd-wait-for.c's wait_channel): woken with nobody waiting, locked, and who
/// waits for it or for its lock.
#[derive(Default)]
pub struct WaitChannel { pub woken: bool, pub locked: bool, pub waiters: Vec<tokio::sync::oneshot::Sender<()>>, pub lockers: std::collections::VecDeque<tokio::sync::oneshot::Sender<()>> }

/// How a client writes its sessions: as its own; one of them given up to another client; or every
/// one of them left for the next (it detaches).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Save { Stay, Release(u32), Leave }

/// The sessions file, as read (empty when there is none).
pub fn read_sessions(path: &std::path::Path) -> Value {
    let mut doc: Value = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    if !doc.is_object() { doc = json!({}) }
    if !doc.get("sessions").map(Value::is_array).unwrap_or(false) { doc["sessions"] = json!([]) }
    doc
}

/// A session's client (its row's owner) while it runs: the socket it listens on.
pub fn live_owner(row: &Value) -> Option<String> {
    row.get("owner").and_then(Value::as_str).filter(|o| crate::ipc::answers(std::path::Path::new(o))).map(str::to_string)
}

/// A session's environment as its row keeps it (a variable taken away: its value null).
pub fn env_json(env: &std::collections::BTreeMap<String, EnvVar>) -> Value {
    json!(env.iter().map(|(k, v)| (k.clone(), json!({ "value": v.value, "hidden": v.hidden }))).collect::<serde_json::Map<String, Value>>())
}

pub fn env_from(row: &Value) -> std::collections::BTreeMap<String, EnvVar> {
    row.get("env").and_then(Value::as_object).map(|m| m.iter().map(|(k, v)| (k.clone(), EnvVar {
        value: v.get("value").and_then(Value::as_str).map(str::to_string), hidden: v.get("hidden").and_then(Value::as_bool).unwrap_or(false),
    })).collect()).unwrap_or_default()
}

pub fn options_from(row: &Value) -> std::collections::BTreeMap<String, String> {
    row.get("options").and_then(Value::as_object).map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default()
}

/// Where a server name's (-L) sessions are kept between clients.
pub fn sessions_path(name: Option<&str>) -> std::path::PathBuf {
    let name = name.map(str::to_string).or_else(|| std::env::var("HN_SOCKET_NAME").ok()).filter(|n| !n.is_empty()).unwrap_or_else(|| "default".into());
    state_dir().join(format!("sessions-{name}.json"))
}

/// Where hn keeps its state (~/.harness/tui). Tests never read or write the real one: theirs is
/// a folder of their own.
pub fn state_dir() -> std::path::PathBuf {
    #[cfg(test)]
    return std::env::temp_dir().join(format!("hn-test-{}", std::process::id())).join("tui");
    #[allow(unreachable_code)]
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".harness").join("tui")
}

/// The agent a reply is about (`agentId`).
fn agent_id_of(reply: &Value) -> Option<String> { reply.get("agentId").and_then(Value::as_str).map(str::to_string) }

/// Seconds since the epoch.
pub fn epoch_secs() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) }

/// session_check_name: a session's name as tmux keeps it — `:` and `.` (which targets read) as
/// `_`; none for an empty one.
pub fn session_check_name(name: &str) -> Option<String> {
    if name.is_empty() { return None }
    Some(name.chars().map(|c| if c == ':' || c == '.' { '_' } else { c }).collect())
}

/// Marks a printed text's last line as having no newline of its own (show-buffer's data).
pub const BARE: char = '\u{2}';

/// A command's answer to the shell that ran it: printed lines, errors, exit status.
pub type Reply = (Vec<String>, Vec<String>, i32);

/// Type-ahead belongs to the shell request that will receive it, even if another starts first.
pub type ShellInput = std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>>;

/// One shell request's printed output and exact session/window/pane, or its error.
pub type ShellCompletion = Result<(Vec<String>, (u32, String, u64)), String>;

/// A Claude Code or Codex conversation on a machine that Harness did not start (a session_search
/// hit with `external`): offered on the home page and found by C-b s, and resumed as a harness.
#[derive(Clone, Debug)]
pub struct External {
    pub machine: String,
    pub session_id: String,
    pub engine: String,
    pub title: String,
    /// The folder it ran in (and resumes in).
    pub cwd: String,
    /// Still open in a terminal or the engine's app: not to be opened twice.
    pub open: bool,
    /// Its latest turn (ms since the epoch).
    pub last_at: u64,
}

/// A session_search hit: a harness's session found by what was said in it, or a conversation
/// Harness did not start.
#[derive(Clone, Debug)]
pub struct Said {
    pub machine: String,
    pub session_id: String,
    pub agent_id: String,
    /// Where it matched (the words between \u{2} and \u{3}); the turn (-1: its name).
    pub snippet: String,
    pub turn: i64,
    pub at: u64,
    pub external: Option<External>,
}

/// The hits in a session_search reply from [machine], best first.
pub fn said_hits(machine: &str, reply: &Value) -> Vec<Said> {
    let externals = externals(machine, reply);
    reply.get("hits").and_then(Value::as_array).map(|hits| hits.iter().filter_map(|h| {
        let text = |k: &str| h.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let session_id = text("sessionId");
        if session_id.is_empty() { return None }
        Some(Said {
            machine: machine.to_string(), agent_id: text("agentId"), snippet: text("snippet"),
            turn: h.get("turn").and_then(Value::as_i64).unwrap_or(-1), at: h.get("at").and_then(Value::as_f64).unwrap_or(0.0) as u64,
            external: externals.iter().find(|x| x.session_id == session_id).cloned(), session_id,
        })
    }).collect()).unwrap_or_default()
}

/// The external conversations in a session_search reply from [machine].
pub fn externals(machine: &str, reply: &Value) -> Vec<External> {
    reply.get("hits").and_then(Value::as_array).map(|hits| hits.iter().filter_map(|h| {
        let x = h.get("external")?;
        let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        Some(External {
            machine: machine.to_string(), session_id: text(h, "sessionId"), engine: text(h, "engine"), title: text(x, "title"), cwd: text(x, "cwd"),
            open: x.get("open").and_then(Value::as_bool).unwrap_or(false),
            last_at: h.get("lastAt").and_then(Value::as_f64).or_else(|| h.get("at").and_then(Value::as_f64)).unwrap_or(0.0) as u64,
        })
    }).filter(|x| !x.session_id.is_empty()).collect()).unwrap_or_default()
}

/// A window not numbered yet (Tab::wid).
const NO_WID: u64 = u64::MAX;
/// The session a client starts in, before it is one (App::first_session).
pub const UNNUMBERED: u32 = u32::MAX;

/// A window. One linked into several sessions (link-window, a session group) is the same id in
/// each — its copies kept alike (App::sync_links); what is the winlink's (alerts) is each one's.
#[derive(Clone)]
pub struct Tab {
    /// The desk's tab id (32 hex), shared with every other window on the account.
    pub id: String,
    /// tmux's window id (#{window_id} `@N`): given when the window is made, never reused — an
    /// empty window (the one a client starts with, new-window's before its pane) has it when it
    /// is first asked for (wid), so one that is never a window takes no number.
    wid: std::cell::Cell<u64>,
    /// The window's own size while no terminal shows it (new -x -y, resize-window, the size the
    /// last terminal gave it): hn with no terminal keeps it, as tmux keeps a detached window's.
    pub size: Option<(u16, u16)>,
    pub name: String,
    pub named: bool,
    /// The recent-harness home page over this window's shell; scripts still see a real pane.
    pub home: bool,
    pub root: Option<Node>,
    pub focus: Option<u64>,
    pub zoomed: bool,
    /// tmux's w->last_panes: the panes that were active before this one, the latest first (`;`).
    pub last: Vec<u64>,
    /// tmux's w->panes: the order the panes are numbered in, which a layout does not change
    /// (main-horizontal-mirrored draws pane 0 at the bottom).
    pub order: Vec<u64>,
    /// tmux's active_point: when each pane last became the active one (higher is later).
    pub points: HashMap<u64, u64>,
    /// tmux's winlink alert flags (alerts.c): activity, bell, silence — set while the window is
    /// not the current one, cleared when it becomes current.
    pub alerts: u8,
    /// When a pane of the window last printed, or the window was chosen (monitor-silence counts
    /// from here).
    pub last_output: Instant,
    /// The same, in seconds since the epoch: #{window_activity}.
    pub activity: i64,
    /// The named layout last applied (tmux's w->lastlayout): where `next-layout` (Space) goes on
    /// from, none until one is chosen — the cycle then starts at even-horizontal.
    pub layout_at: Option<usize>,
    /// Whether the desk knows this tab yet (a new, empty tab is local until its first harness).
    pub on_desk: bool,
    /// synchronize-panes: keys go to every pane here.
    pub sync: bool,
    /// automatic-rename off: the window has had the name tmux gives one when it is made
    /// (default_window_name: a shell by its command), and keeps it.
    pub first_named: bool,
    /// The desk's complete layout document. An explicit edit replaces the
    /// current count's normalized slots, retaining other counts' saved layouts.
    pub layout: Value,
    /// Last layout observed on the desk, separate from the local edit awaiting its reply.
    pub desk_layout: Value,
    /// Last pane sequence received from the desk, independent of local tmux numbering.
    desk_panes: Vec<(String, String)>,
    /// A named choice awaiting publication, separate from the last observed desk document.
    desk_preset: Option<(usize, &'static str)>,
    /// Unrounded shared slots and their local pane identities, independent of
    /// tmux pane numbering and the current terminal dimensions.
    shared_geometry: Option<crate::desk_layout::Geometry>,
}

impl Tab {
    pub fn new(name: &str) -> Tab {
        // tmux's @N: unique among every client of this server name (ids.rs).
        Tab::with_wid(name, crate::ids::next(crate::ids::Kind::Window))
    }
    /// The empty window a session has before its first pane (numbered when first asked for).
    pub fn home() -> Tab { Tab::with_wid("home", NO_WID) }
    /// A window with the id it had (a session another client kept, the desk's).
    pub fn with_wid(name: &str, wid: u64) -> Tab {
        Tab { id: Uuid::new_v4().simple().to_string(), wid: std::cell::Cell::new(wid), size: None, name: name.to_string(), named: false, home: false, root: None, focus: None, zoomed: false, last: Vec::new(), order: Vec::new(), points: HashMap::new(), alerts: 0, last_output: Instant::now(), activity: crate::format::now_secs(), layout_at: None, on_desk: false, sync: false, first_named: false, layout: json!({}), desk_layout: json!({}), desk_panes: Vec::new(), desk_preset: None, shared_geometry: None }
    }
    fn fit_layout(&mut self, size: (u16, u16), status: layout::Status) -> bool {
        let Some(root) = self.root.as_mut() else { return false };
        let changed = root.size() != size || root.status != status;
        root.status = status;
        if changed && !self.shared_geometry.as_mut().is_some_and(|g| g.fit(root, size.0, size.1, status)) {
            root.resize(size.0, size.1);
        }
        changed
    }

    fn read_shared_layout(&mut self, ids: &[u64], w: u16, h: u16) {
        let preset = preset_from_desk(crate::desk_layout::preset_id(&self.layout, ids.len()), ids.len());
        let (root, geometry) = desk_geometry(&self.layout, preset, ids, w, h).unzip();
        self.root = root;
        self.shared_geometry = geometry;
    }
    /// Its @N, numbered now if it has none yet.
    pub fn wid(&self) -> u64 {
        if self.wid.get() == NO_WID { self.wid.set(crate::ids::next(crate::ids::Kind::Window)) }
        self.wid.get()
    }
    /// Whether it is window @[wid] (one not numbered yet is none).
    pub fn is_wid(&self, wid: u64) -> bool { self.wid.get() == wid }
    /// Its @N, if it has one yet.
    pub fn has_wid(&self) -> Option<u64> { Some(self.wid.get()).filter(|w| *w != NO_WID) }
    /// window_update_activity: something happened in the window just now — its activity time,
    /// and the silence timer starts again (alerts_reset).
    pub fn touch(&mut self) { self.last_output = Instant::now(); self.activity = crate::format::now_secs() }
    /// The panes in tmux's order (pane_index); one the list has not placed yet comes last.
    pub fn panes(&self) -> Vec<u64> {
        let leaves = self.root.as_ref().map(Node::leaves).unwrap_or_default();
        let mut out: Vec<u64> = self.order.iter().copied().filter(|p| leaves.contains(p)).collect();
        out.extend(leaves.into_iter().filter(|p| !self.order.contains(p)));
        out
    }
    /// The pane `;` goes back to.
    pub fn last_focus(&self) -> Option<u64> { self.last.first().copied() }
    /// tmux's window_set_active_pane: the pane left goes on top of the last-panes stack.
    pub fn set_active(&mut self, pane: u64) {
        if self.focus == Some(pane) { return }
        self.last.retain(|p| *p != pane);
        if let Some(old) = self.focus { self.last.retain(|p| *p != old); self.last.insert(0, old) }
        self.focus = Some(pane);
        static POINT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        self.points.insert(pane, POINT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    }
    /// tmux's window_add_pane: after `other` (the active pane), before it with -b; -f at the
    /// end of the list (-bf the start).
    pub fn add_pane(&mut self, pane: u64, other: Option<u64>, before: bool, full: bool) {
        let mut order = self.panes();
        order.retain(|p| *p != pane);
        let other = other.or(self.focus).and_then(|o| order.iter().position(|p| *p == o));
        let at = match (full, other) {
            _ if order.is_empty() => 0,
            (true, _) => if before { 0 } else { order.len() },
            (false, Some(i)) => if before { i } else { i + 1 },
            (false, None) => order.len(),
        };
        order.insert(at, pane);
        self.order = order;
    }
    /// tmux's window_lost_pane: a pane leaves; if it was the active one, the last pane takes
    /// over, else the one before it in the list, else the one after. (Before it leaves the layout.)
    pub fn lose(&mut self, pane: u64) {
        let order = self.panes();
        self.last.retain(|p| *p != pane);
        if self.focus == Some(pane) {
            let at = order.iter().position(|p| *p == pane);
            let next = self.last.first().copied()
                .or_else(|| at.and_then(|i| i.checked_sub(1)).map(|i| order[i]))
                .or_else(|| at.and_then(|i| order.get(i + 1).copied()));
            if let Some(n) = next { self.last.retain(|p| *p != n) }
            self.focus = next;
        }
        self.order = order.into_iter().filter(|p| *p != pane).collect();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DeskMode { Off, Read, Sync }

struct LinkState {
    link: Option<Link>,
    generation: u64,
    attempts: u32,
    retry_at: Option<Instant>,
}

pub struct App {
    pub port: u16,
    pub viewer_web_url: String,
    pub sink: UnboundedSender<Event>,
    pub fleet: Fleet,
    links: HashMap<String, LinkState>,
    generation: u64,
    pub tabs: Vec<Tab>,
    pub active: usize,
    pub panes: HashMap<u64, Pane>,
    /// The session this client started in (its id, from the counters): until it has a window,
    /// a placeholder.
    pub first_session: u32,
    pub modal: Option<Modal>,
    pub toast: Option<(String, Color, Instant)>,
    /// How long hn's own notice stays (a harness waiting on you: longer than display-time's
    /// 750 ms, which is for tmux's messages); none for any other message.
    pub toast_hold: Option<u64>,
    /// display-message -d: how long this message stays, exactly (0: until a key).
    pub toast_exact: Option<u64>,
    /// tmux `display-time`: how long a message holds the status line.
    pub display_ms: u64,
    pub display_panes_ms: u64,
    /// Everything said in the status line, for `show-messages` (C-b ~).
    pub messages: Vec<(std::time::SystemTime, String)>,
    /// Paste buffers, newest first (copy mode's `y`, and `paste-buffer`).
    /// tmux's paste buffers (paste.c).
    pub paste: crate::paste::Paste,
    pub keymap: crate::keys::Keymap,
    /// Colours from ~/.tmux.conf (status, messages, borders).
    pub look: crate::tmuxconf::Look,
    /// Until when a `-r` key may be pressed again without the prefix.
    pub repeat_until: Option<Instant>,
    /// Redraw everything next frame (refresh-client).
    pub redraw_all: bool,
    /// When the wheel last turned. A scroll rewrites most of the screen cell by cell; once it stops
    /// for SCROLL_SETTLE the whole screen is written once more, so a cell the terminal missed
    /// (a ghost of the old text) is overwritten whatever the reason it was missed.
    pub scrolled_at: Option<Instant>,
    /// tmux `status-position`.
    pub status_top: bool,
    pub mouse: bool,
    /// The harness focused before this one, anywhere (switch-client -l).
    pub last_harness: Option<(String, String)>,
    /// The pane next-harness (C-b a) last showed a harness in: pressed again from there, the next
    /// one takes its place, so going through the queue keeps to one window.
    pub loop_pane: Option<u64>,
    /// The harnesses this go down the queue has shown, so C-b a walks all of them once (an
    /// unanswered one is not shown again until the rest have been).
    pub loop_seen: Vec<(String, String)>,
    /// `agent_recent` answers (asks and recaps), for the preview window.
    pub recent: HashMap<(String, String), Value>,
    /// Seconds east of UTC (for the status line's clock).
    /// The prompts' histories (Up/Down), one per type: command, search, target, window-target.
    pub history: [Vec<String>; 4],
    /// Prompt additions and clears not yet merged into the shared server history.
    pub history_changes: Vec<crate::history::Change>,
    pub size: (u16, u16),
    /// Each visible pane's full rect (header row included), from the last layout.
    pub rects: Vec<(u64, Rect)>,
    pub quit: bool,
    /// detach-client -E: the shell command the client becomes as it goes (MSG_EXEC); -P: its
    /// parent sent SIGHUP after it (MSG_DETACHKILL).
    pub exec_after: Option<String>,
    pub hup_parent: bool,
    /// The last window went (tmux's session ended): hn says `[exited]`, not `[detached …]`.
    pub exited: bool,
    /// Where the startup shell stands: the desk has answered (or there is none), and whether
    /// the shell was asked for.
    desk_answered: bool,
    pub(crate) shell_asked: bool,
    pub prefix: bool,
    /// When the prefix was pressed: a pause after it shows the keys (which-key).
    pub prefix_at: Option<Instant>,
    pub tick: u64,
    pub home_cursor: usize,
    /// The home page's selection moved by you (until then Enter, like any key, starts a shell).
    pub home_moved: bool,
    /// More commands of the same line or binding wait behind the one running.
    pub chain_follows: bool,
    /// The Claude Code and Codex conversations Harness did not start that the home page offers
    /// (each machine's session index, asked once each time the page shows), and the machines
    /// asked so far.
    pub home_external: Vec<External>,
    pub home_asked: HashSet<String>,
    home_shown: bool,
    /// The pane C-b c was pressed from: the machine and folder the home page's shell (t) takes.
    pub home_from: Option<(String, String)>,
    /// C-b s's search by what was said (each machine's session_search): the query wanted and when
    /// to ask (a moment after the last key), the query the hits answer, and the hits.
    pub said_want: String,
    pub said_due: Option<Instant>,
    /// Current search requests still awaiting a machine, and their generation.
    pub said_pending: usize,
    pub said_generation: u64,
    pub said_for: String,
    pub said: Vec<Said>,
    /// Sessions' latest turns (session_tail), by session id: read once each time C-b s opens.
    pub tails: HashMap<String, Value>,
    pub tails_asked: HashSet<String>,
    pub desk_mode: DeskMode,
    pub desk_revision: i64,
    /// The desk session's windows' own state as the last client left it (their options, zoom,
    /// pane titles), put back as the desk's tabs come.
    pub desk_windows_saved: HashMap<String, Value>,
    pub desk_active_saved: Option<usize>,
    desk_loaded: bool,
    pub started: Instant,
    pub daemon_down: bool,
    pub dsh: HashMap<String, Vec<Value>>,
    /// A dismissed New Harness draft, including any pending creation receipt.
    pub new_harness_draft: Option<Box<crate::new_harness::Form>>,
    /// ── models: the Models view's replies (local models, grids, APIs) and a Use under way ──
    pub models_view: crate::models::Models,
    /// Each machine's last measured round trip (the live roster request), for `@`.
    pub rtt: HashMap<String, Duration>,
    pub homes: HashMap<String, String>,
    last_focus_sent: Option<(String, String)>,
    /// The mouse event of the key whose commands are running (tmux's item event): `-t =`, the
    /// commands' target, send-keys -M and the mouse_* formats read it.
    pub mouse_ev: Option<crate::mouse::Event>,
    /// The client's mouse: the last event, a drag, the clicks being counted.
    pub mouse_state: crate::mouse::State,
    /// The last click in a list (row, when) — a second one opens it.
    pub last_click: Option<(u64, u16, u16, Instant, u8)>,
    /// What the outer terminal's title was last set to.
    pub title: String,
    pub first_frame: bool,
    /// The status line's ranges as drawn (row, range): where a click lands (status_get_range).
    pub status_ranges: Vec<(u16, crate::draw::Range)>,
    /// Terminal frames for a stream no pane has yet — the keyframe can outrun `terminal_ready`.
    orphans: HashMap<Uuid, (Instant, Vec<proto::Frame>)>,
    /// Native exit notices can race the same terminal_ready callback as its first frame.
    orphan_exits: HashMap<Uuid, (Instant, pane::Exit)>,
    /// One desk write at a time: an older layout must not land after a newer choice.
    desk_inflight: bool,
    desk_pending: Vec<Value>,
    /// Accepted layouts since the last reconciliation. Their replies acknowledge our local
    /// geometry, including when an older backend can store only the desktop preset.
    desk_acked_layouts: HashMap<String, Value>,
    /// The desk moved while writes were out: fetch it once they land.
    desk_stale: bool,
    /// tmux's s->lastw: the windows current before, the most recent first, by tab id — C-b l goes
    /// back to the first (the - flag's); closing the current window lands there.
    pub lastw: Vec<String>,
    /// tmux's window indexes, by tab id: given once, kept until the window closes (a gap stays).
    pub nums: HashMap<String, usize>,
    /// The cursor shape last sent to the terminal.
    pub cursor_shape: String,
    /// suspend-client (C-z): the main loop hands the terminal back and stops itself.
    pub suspend: bool,
    /// Output of a command run from a shell (`hn display -p …`): printed there, not on screen.
    pub capture: Option<Vec<String>>,
    /// -P [-F fmt] on split-window / new-window: print the new pane once it is there; the
    /// shell that asked waits for it (the reply is held here).
    pub print_new: Option<String>,
    /// rename-session: what this session is called here (else the machine's name).
    pub session_alias: Option<String>,
    /// The other sessions (tmux's), each kept whole until the client switches to it.
    pub sessions: Vec<Stash>,
    /// This session's id (`$N`), whether its windows are the desk's, and when it was made.
    pub session_id: u32,
    pub session_desk: bool,
    pub session_created: i64,
    /// When the session in front was last used: when the client last left it (the client's own
    /// is in use now).
    pub session_activity: i64,
    /// Its place in the order sessions are used in (use_order).
    pub session_used: u64,
    /// session_last_attached of the session in front (0 while no client has gone to it).
    pub session_last_attached: i64,
    /// The session the client was in before this one (switch-client -l, C-b L).
    pub last_session: Option<u32>,
    /// The sessions this client does not have (other clients', or no client's), as the file said.
    pub remote: std::cell::RefCell<Remote>,
    /// This client gave its sessions to another (a terminal attached to the one it showed, as
    /// `attach -d`): it writes none of them again.
    pub handed_over: bool,
    /// Its sessions' windows and panes as last written (save_if_changed).
    pub sessions_sig: String,
    /// wait-for's channels, by name.
    pub wait_channels: HashMap<String, WaitChannel>,
    /// Commands from shells held while this client's machine is not connected yet (its first
    /// moments), the first of them one that opens a shell: run in order once it is (run_cli).
    pub cli_held: std::collections::VecDeque<Box<dyn FnOnce(&mut App) + Send>>,
    /// When a command from a shell last came (hn with no terminal stays that long after it).
    pub last_cli: Instant,
    /// kill-session under way (kill_windows): its windows' window-unlinked wait for its
    /// session-closed, as session_destroy orders them.
    pub killing_session: bool,
    /// unlink-window under way: a window closed here stays in the other sessions it is in.
    pub unlinking: bool,
    /// Pull requests by repository and branch (`machine|root|branch`): the answer and when it
    /// came, shared with this computer's other clients through prs.json — one question per
    /// branch every five minutes (an hour for a merged or closed one), not one per harness each.
    pub prs: HashMap<String, (Option<fleet::Pr>, u64)>,
    /// A window has gone since the last renumber (renumber-windows closes the gap then).
    pub window_gone: bool,
    /// Questions for harnesses not listed when they came (machine, frame, when).
    pub pending_questions: Vec<(String, Value, Instant)>,
    /// Branches whose pull request is being asked right now (one ask per branch).
    pub pr_asking: HashSet<String>,
    pub prs_read: Option<Instant>,
    /// Desk windows whose layout changed here, to be sent (send_desk_layouts).
    pub desk_layouts: HashSet<String>,
    /// The desk refused a layout's tmux form (a backend from before it): not sent again.
    pub desk_no_tmux: bool,
    /// The harnesses that failed to start, as last looked (harness-failed for each new one).
    pub launch_failed: Option<HashSet<(String, String)>>,
    pub unlinked_later: Vec<(u32, String, u64, String)>,
    /// The server's state (global options, key tables, buffers, global environment) as this
    /// client last wrote or took it, and whether a command ran since (server.rs).
    pub server_synced: Option<crate::server::Synced>,
    pub server_dirty: bool,
    /// The session in front is another client's, shown as it has it (mirror.rs); and the clients
    /// showing sessions of this one's (their sockets, and which session).
    pub mirror: Option<Mirror>,
    pub mirrors: HashMap<String, u32>,
    pub mirror_ttys: HashMap<String, String>,
    /// The clients showing the session this one shows as another has it (its row's count).
    pub mirror_attached: u32,
    /// No terminal (--headless): tmux's server with no client attached, holding sessions for
    /// the commands of a script until a client takes them.
    pub headless: bool,
    /// The OS's primary screen: keep a home screen when empty and refuse client detach/suspend.
    /// This controls the interface, not the user's ability to administer their machine.
    pub os_session: bool,
    /// A disposable USB session offers direct try, install and network actions on its home.
    pub os_live: bool,
    /// While a command runs in another session (`-t work:2`): the session to come back to.
    pub swap_back: Option<u32>,
    /// The session asked for at start (`hn new -A -s main`, `hn attach -t work`).
    pub start_session: Option<StartSession>,
    /// The client's flags (attach -r / -f, switch-client -r): read-only, ignore-size, active-pane …
    pub client_flags: Vec<String>,
    /// Why the start asked for could not be done (`can't find session: work`).
    pub start_failed: Option<String>,
    /// kill-server: no session is kept for the next client.
    pub forget_sessions: bool,
    /// Questions out to the daemons about harnesses (recaps, pull requests), at most a few at once.
    pub enriching: u32,
    /// The key being handled (its tmux name), and the one whose binding's commands are running —
    /// for the message log (`/dev/ttys003 key C-b: …`); the log starts once the config is read.
    /// Each machine's agent accounts' rate limits (usage_read), and when they were last asked.
    pub usage: HashMap<String, Vec<fleet::Usage>>,
    pub usage_checked: Option<Instant>,
    pub key_name: Option<String>,
    pub key_run: Option<String>,
    pub cfg_finished: bool,
    /// When the terminal lost focus, and the fleet's counts then (needs you, failed, done).
    pub away: Option<(Instant, (usize, usize, usize))>,
    /// When you last looked at each harness (ms), kept between runs (~/.harness/tui/seen.json):
    /// one that did something after it, while hn was closed or on another screen, is done and
    /// unread when hn next hears of it. Before [seen_since] (hn's first run) everything counts as
    /// seen. [seen_rostered]: the machines whose first roster has been read against it.
    pub seen_at: HashMap<(String, String), u64>,
    pub seen_since: u64,
    pub seen_dirty: bool,
    pub seen_rostered: HashSet<String>,
    /// The turns that ended in an error, not looked at since (when, and the error's line): kept
    /// in seen.json, so a failure is still ✗ after hn starts again.
    pub agent_errors: HashMap<(String, String), (u64, String)>,
    /// The questions harness-needs was fired for, by this server name ("name\trequest" → when):
    /// a client that starts later (the headless left at a detach) does not fire them again.
    pub announced: HashMap<String, u64>,
    /// Questions announced in a row (how many, the last when): a burst is said once.
    pub asking_burst: Option<(usize, Instant)>,
    /// seen.json as this client last read or wrote it (its time and size): another terminal's
    /// write is read in.
    seen_stamp: Option<(std::time::SystemTime, u64)>,
    /// When a harness was last looked at before this client started (seen.json), until it says
    /// what is waiting.
    back_from: Option<u64>,
    /// select-pane -m: the marked pane (join-pane and swap-pane take it as their source).
    pub marked: Option<u64>,
    pub marked_session: Option<u32>,
    pub held_reply: Option<tokio::sync::oneshot::Sender<Reply>>,
    /// A command that waits for what it opened (display-menu; command-prompt and confirm-before
    /// without -b): the shell that ran it is answered when that closes (CMD_RETURN_WAIT).
    pub wait_cli: bool,
    waiting_reply: Option<(tokio::sync::oneshot::Sender<Reply>, Reply)>,
    /// The shell waiting on the command it ran (hn <command>): its answer goes here when the
    /// command is done — at once, or when a job it waits on (run-shell, if-shell) has finished.
    pub cli_tx: Option<tokio::sync::oneshot::Sender<Reply>>,
    /// That command's exit status (run-shell's, when its shell command failed).
    pub cli_code: i32,
    /// That shell's folder: where run-shell and if-shell run what it asked (tmux's client cwd).
    pub cli_cwd: Option<String>,
    /// The invoking client's usable size, independent of the target session's owner.
    pub cli_size: Option<(u16, u16)>,
    /// The command came from a shell outside hn: with no -t, it is for the session used last
    /// (cmd_find_from_nothing), not the one this client shows.
    pub cli_outside: bool,
    /// #{command_list_name} #{command_list_alias} #{command_list_usage} (list-commands -F).
    pub format_command: Option<(String, String, String)>,
    /// The config files read at start (#{config_files}).
    pub config_files: Vec<String>,
    /// #{line}: the row a list-* command is printing.
    pub format_line: Option<usize>,
    /// format_defaults' type while choose-tree expands an item's format (tree::FORMAT_*): what
    /// #{session_format}, #{window_format} and #{pane_format} say.
    pub format_type: Option<u8>,
    /// How many times the status line has been drawn again for a key (server_status_client: a
    /// key with a binding, the prefix, a table left) — a pane's tree is built again then.
    pub status_redraws: u64,
    /// The paste buffer a format is expanded for (list-buffers -F).
    pub format_buffer: Option<String>,
    /// The list a message or an answer was typed from (M-s, M-a), to go back to after it.
    pub back_to_list: Option<Box<(crate::modal::PickerKind, crate::picker::Picker)>>,
    /// The harness a format is about (list-harnesses -F): its #{harness_*} values.
    pub format_agent: Option<(String, String)>,
    /// What the shell running the command piped in (load-buffer -, source-file -).
    pub cli_stdin: Option<String>,
    /// The file and line the running command was read from (a config's): its errors say so.
    pub origin: Option<(std::sync::Arc<str>, usize)>,
    /// Commands to run next, before the rest of the queue (source-file's).
    pub insert_next: std::collections::VecDeque<crate::commands::Item>,
    /// The hook whose commands are running (their formats and current pane); commands run from a
    /// hook fire none of their own.
    pub hook_state: Option<std::sync::Arc<crate::commands::HookState>>,
    /// Event hooks waiting to run (notify_add queues them; they run once the event's work is
    /// done).
    pub pending_hooks: std::collections::VecDeque<crate::commands::Item>,
    /// Geometry changes are notified after the session selected its new current window.
    pending_resize_hooks: Vec<String>,
    /// Errors said so far (a command that failed fires command-error, not its after- hook).
    pub errors: u64,
    /// A config file's errors (cfg_add_cause), shown in the current pane's view mode once there
    /// is one (cfg_show_causes), as tmux shows them when the client attaches.
    pub config_causes: Vec<String>,
    /// pipe-pane's pipes, by pane: what the pane prints goes to the command (-O).
    pub pipes: HashMap<u64, Pipe>,
    pipe_seq: u64,
    /// What the event hooks were last told of (notify_changes compares against it).
    pub hooks_seen: HooksSeen,

    pub capture_err: Option<Vec<String>>,
    /// tmux's global environment: what hn started with, then set-environment -g and a config's
    /// `NAME=value` (%hidden ones hidden).
    pub global_env: std::collections::BTreeMap<String, EnvVar>,
    /// The session's environment: update-environment's variables, as they were when hn started
    /// (set, or cleared when hn had none).
    pub session_env: std::collections::BTreeMap<String, EnvVar>,
    /// The session in front's start directory (#{session_path}); none: where hn started.
    pub session_path: Option<String>,
    /// The session in front's group (new -t), if it is in one.
    pub session_group: Option<String>,
    /// Windows killed (not only unlinked) since the links were last synced: gone from every
    /// session that has them.
    pub killed_windows: Vec<String>,
    /// Shells hn made for split-window / new-window: they end with their pane.
    pub shells: HashSet<(String, String)>,
    /// Keys typed while a split's shell starts, for it.
    pub starting_shell: Option<ShellInput>,
    /// Pending input by window, so switching windows cannot type into a different request.
    pub shell_inputs: HashMap<String, ShellInput>,
    /// Commands waiting for a shell on its way to have its pane (a chain after new-session,
    /// new-window, split-window): told when it has come (or failed).
    pub shell_waiters: Vec<(ShellInput, tokio::sync::oneshot::Sender<ShellCompletion>)>,
    /// `hn new … \; cmd …` / `hn attach … \; cmd …`: the chain after the command that started this
    /// client, run once its session is there (and its first shell, for new).
    pub start_then: Vec<String>,
    /// tmux's status/window/border/copy options from tmux.conf or `set`.
    pub opts: crate::tmuxconf::Options,
    /// The home list's order while it is on screen (see `home_agents`).
    pub home_order: std::cell::RefCell<Vec<(String, String)>>,
    pub mouse_changed: bool,
    /// Whether the terminal window has focus (focus reporting) — notifications go out when it does not.
    pub terminal_focused: bool,
    /// Waiting for a key to become the prefix, or a command's key (settings.rs): the next key.
    pub capturing: Option<crate::settings::Capture>,
    /// The Harness device on this desk, and hn's half of talking to it (dial.rs).
    pub dial: crate::dial::Dial,
    /// A key table of your own the next key is looked up in (`switch-client -T`).
    pub key_table: Option<String>,
    /// A -r key of that table ran: the table is kept until then (repeat-time), then root again.
    pub key_table_until: Option<Instant>,
    /// tmux's options, as set (options.rs): what show-options prints and formats read.
    pub options: crate::options::Store,
    /// `#()` commands in formats: their last output, run again every status-interval.
    pub jobs: std::cell::RefCell<std::collections::HashMap<String, crate::format::Job>>,
    pub fleet_marked: bool,
    // ── status bar ──
    /// The status bar down a side: where its entries were drawn (what a click there does), its
    /// lists' scroll, and whether it is folded to a rail.
    pub bar: crate::bar::State,
    // ── machines & devices ──
    /// The panel's machine and device views: what the CLI and the daemon last said (devices.rs).
    pub devices: crate::devices::Devices,
}

impl App {
    pub fn new(port: u16, sink: UnboundedSender<Event>, size: (u16, u16)) -> App {
        let desk_mode = match std::env::var("HARNESS_TUI_DESK").as_deref() {
            Ok("off") => DeskMode::Off,
            Ok("read") => DeskMode::Read,
            _ => DeskMode::Sync,
        };
        App {
            port,
            viewer_web_url: String::new(),
            sink,
            fleet: Fleet::default(),
            links: HashMap::new(),
            generation: 0,
            tabs: vec![Tab::home()],
            active: 0,
            panes: HashMap::new(),
            first_session: 0,
            modal: None,
            toast: None,
            display_ms: 750,
            toast_hold: None,
            toast_exact: None,
            display_panes_ms: 1000,
            nums: HashMap::new(),
            cursor_shape: String::new(),
            suspend: false,
            capture: None,
            print_new: None,
            session_alias: None,
            sessions: Vec::new(),
            session_id: 0,
            // desk=off: the first session is a session like any other (tmux's `0`).
            session_desk: desk_mode != DeskMode::Off,
            session_created: epoch_secs(),
            session_activity: epoch_secs(),
            session_used: use_order(),
            session_last_attached: 0,
            last_session: None,
            remote: Default::default(),
            handed_over: false,
            sessions_sig: String::new(),
            headless: false,
            os_session: std::env::var("HARNESS_OS").as_deref() == Ok("1"),
            os_live: std::env::var("HARNESS_OS").as_deref() == Ok("1") && std::env::var("HARNESS_OS_LIVE").as_deref() == Ok("1"),
            wait_channels: HashMap::new(),
            cli_held: std::collections::VecDeque::new(),
            last_cli: Instant::now(),
            killing_session: false,
            unlinking: false,
            prs: HashMap::new(),
            window_gone: false,
            pending_questions: Vec::new(),
            pr_asking: HashSet::new(),
            prs_read: None,
            desk_layouts: HashSet::new(),
            desk_no_tmux: false,
            launch_failed: None,
            unlinked_later: Vec::new(),
            server_synced: None,
            server_dirty: false,
            mirror: None,
            mirrors: HashMap::new(),
            mirror_ttys: HashMap::new(),
            mirror_attached: 0,
            swap_back: None,
            start_session: None,
            client_flags: Vec::new(),
            start_failed: None,
            forget_sessions: false,
            enriching: 0,
            usage: HashMap::new(),
            usage_checked: None,
            key_name: None,
            key_run: None,
            cfg_finished: false,
            away: None,
            seen_at: HashMap::new(),
            seen_since: 0,
            seen_dirty: false,
            seen_rostered: HashSet::new(),
            agent_errors: HashMap::new(),
            announced: HashMap::new(),
            asking_burst: None,
            seen_stamp: None,
            back_from: None,
            marked: None,
            marked_session: None,
            held_reply: None,
            wait_cli: false,
            waiting_reply: None,
            cli_tx: None,
            cli_code: 0,
            cli_cwd: None,
            cli_size: None,
            cli_outside: false,
            origin: None,
            format_buffer: None,
            format_agent: None,
            back_to_list: None,
            format_line: None,
            format_type: None,
            status_redraws: 0,
            config_files: Vec::new(),
            format_command: None,
            cli_stdin: None,
            insert_next: std::collections::VecDeque::new(),
            hook_state: None,
            pending_hooks: std::collections::VecDeque::new(),
            pending_resize_hooks: Vec::new(),
            errors: 0,
            pipes: HashMap::new(),
            config_causes: Vec::new(),
            pipe_seq: 0,
            hooks_seen: HooksSeen::default(),

            capture_err: None,
            global_env: std::env::vars().map(|(k, v)| (k, EnvVar { value: Some(v), hidden: false })).collect(),
            session_env: Default::default(),
            session_path: None,
            session_group: None,
            killed_windows: Vec::new(),
            shells: HashSet::new(),
            starting_shell: None,
            shell_inputs: HashMap::new(),
            shell_waiters: Vec::new(),
            start_then: Vec::new(),
            opts: Default::default(),
            prefix_at: None,
            home_order: Default::default(),
            mouse_changed: false,
            messages: Vec::new(),
            paste: Default::default(),
            keymap: crate::keys::Keymap::tmux_defaults(),
            look: Default::default(),
            repeat_until: None,
            redraw_all: false,
            scrolled_at: None,
            status_top: false,
            mouse: true,
            loop_seen: Vec::new(),
            loop_pane: None,
            last_harness: None,
            history: Default::default(),
            history_changes: Vec::new(),
            recent: HashMap::new(),
            size,
            rects: Vec::new(),
            quit: false,
            exec_after: None,
            hup_parent: false,
            prefix: false,
            tick: 0,
            home_cursor: 0,
            home_moved: false,
            chain_follows: false,
            home_external: Vec::new(),
            home_asked: HashSet::new(),
            home_shown: false,
            home_from: None,
            said_want: String::new(),
            said_due: None,
            said_pending: 0,
            said_generation: 0,
            said_for: String::new(),
            said: Vec::new(),
            tails: HashMap::new(),
            tails_asked: HashSet::new(),
            desk_mode,
            desk_revision: -1,
            desk_windows_saved: HashMap::new(),
            desk_active_saved: None,
            desk_loaded: false,
            exited: false,
            desk_answered: false,
            shell_asked: false,
            started: Instant::now(),
            daemon_down: false,
            dsh: HashMap::new(),
            new_harness_draft: None,
            models_view: Default::default(),
            rtt: HashMap::new(),
            homes: HashMap::new(),
            last_focus_sent: None,
            mouse_ev: None,
            mouse_state: Default::default(),
            last_click: None,
            title: String::new(),
            first_frame: false,
            status_ranges: Vec::new(),
            orphans: HashMap::new(),
            orphan_exits: HashMap::new(),
            desk_inflight: false,
            desk_pending: Vec::new(),
            desk_acked_layouts: HashMap::new(),
            desk_stale: false,
            lastw: Vec::new(),
            terminal_focused: true,
            capturing: None,
            dial: Default::default(),
            options: Default::default(),
            jobs: Default::default(),
            key_table: None,
            key_table_until: None,
            fleet_marked: false,
            bar: Default::default(),
            devices: Default::default(),
        }
    }

    // ── background work ──────────────────────────────────────────────────────

    /// Run [work] off the loop and apply its result on it.
    pub fn spawn<F, T>(&self, work: F, then: impl FnOnce(&mut App, T) + Send + 'static)
    where
        F: std::future::Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let sink = self.sink.clone();
        tokio::spawn(async move {
            let result = work.await;
            let _ = sink.send(Event::Apply(Box::new(move |app: &mut App| then(app, result))));
        });
    }

    /// A message in the status line (tmux `display-message`), kept for `show-messages`.
    pub fn say(&mut self, text: impl Into<String>, color: Color) {
        let text = text.into();
        // A command of the config read at start: where it was read (file:line:), as tmux's causes
        // say. Later, from a key or a shell, a message is the client's as any other is.
        let text = match &self.origin { Some((file, line)) if !self.cfg_finished => format!("{file}:{line}: {text}"), _ => text };
        // Run from a shell: a message is the command's error, printed there.
        if let Some(err) = self.capture_err.as_mut() { err.push(text); return }
        self.add_message(format!("{} message: {text}", tty_name()));
        self.toast = Some((text, color, Instant::now()));
        self.toast_hold = None;
        self.toast_exact = None;
    }

    /// How long the message on the status line stays: display-time, or longer for hn's notice.
    pub fn toast_ms(&self) -> u64 {
        // display-message -d, else display-time (0 either way: until a key, as tmux's).
        let ms = self.toast_exact.unwrap_or_else(|| self.toast_hold.unwrap_or(0).max(self.display_ms));
        if ms == 0 { u64::MAX } else { ms }
    }

    /// The fleet in counts: needs you, failed, done and unread.
    pub fn fleet_counts(&self) -> (usize, usize, usize) {
        use crate::fleet::State::*;
        (self.fleet.count(NeedsInput), self.fleet.count(Failed), self.fleet.count(Done))
    }

    /// Back after a while away (the terminal's focus gone three minutes or more): what changed
    /// meanwhile, and the key that goes through it — when something did.
    pub fn welcome_back(&mut self) {
        let Some((at, (needs0, failed0, done0))) = self.away.take() else { return };
        let gone = at.elapsed();
        if gone < Duration::from_secs(180) { return }
        let (needs, failed, done) = self.fleet_counts();
        let mut parts = Vec::new();
        if done > done0 { parts.push(format!("✓{} finished", done - done0)) }
        if needs > needs0 { parts.push(format!("?{} need you", needs - needs0)) }
        if failed > failed0 { parts.push(format!("✗{} failed", failed - failed0)) }
        if parts.is_empty() { return }
        let mins = gone.as_secs() / 60;
        let away = if mins >= 60 { format!("{}h{:02}m", mins / 60, mins % 60) } else { format!("{mins}m") };
        let key = self.keymap.key_for_name("next-harness").unwrap_or_else(|| "C-b a".into());
        self.say(format!("While you were away ({away}): {} — {key} goes through them", parts.join(" · ")), crate::theme::ATTENTION);
        self.toast_hold = Some(8000);
    }

    /// hn started again after a while (its last look at any harness, in seen.json, three minutes
    /// or more ago): what is waiting, as `While you were away` says it when the terminal comes back.
    fn back_again(&mut self) {
        let Some(last) = self.back_from.take() else { return };
        let gone = fleet::now_ms().saturating_sub(last) / 1000;
        if gone < 180 { return }
        let (needs, failed, done) = self.fleet_counts();
        let mut parts = Vec::new();
        if done > 0 { parts.push(format!("✓{done} finished")) }
        if needs > 0 { parts.push(format!("?{needs} need you")) }
        if failed > 0 { parts.push(format!("✗{failed} failed")) }
        if parts.is_empty() { return }
        let mins = gone / 60;
        let away = if mins >= 60 * 48 { format!("{}d", mins / 60 / 24) } else if mins >= 60 { format!("{}h{:02}m", mins / 60, mins % 60) } else { format!("{mins}m") };
        let key = self.keymap.key_for_name("next-harness").unwrap_or_else(|| "C-b a".into());
        self.say(format!("Since you were here ({away}): {} — {key} goes through them", parts.join(" · ")), crate::theme::ATTENTION);
        self.toast_hold = Some(8000);
    }

    /// server_add_message: a line into the message log (C-b ~), at most message-limit of them.
    pub fn add_message(&mut self, text: String) {
        self.messages.push((std::time::SystemTime::now(), text));
        let limit: usize = self.options.get("message-limit", "", None).and_then(|v| v.parse().ok()).unwrap_or(1000);
        if self.messages.len() > limit { let over = self.messages.len() - limit; self.messages.drain(..over); }
    }

    /// A command's error (cmdq_error): to a shell that ran the command as it is, and on the status
    /// line with its first letter a capital, as tmux shows it there ("Invalid layout: foo"); a
    /// config file's keeps its file:line and its case.
    pub fn error(&mut self, text: impl Into<String>) {
        self.errors += 1;
        let mut text = text.into();
        // A config file's command with no client (cmdq_error's cfg_add_cause: the config read at
        // start, or where no terminal is): kept, with its file and line, for view mode. With a
        // client — a key, a prompt, a shell — it is that client's error as any other is.
        if self.capture_err.is_none() && (!self.cfg_finished || self.headless) {
            if let Some((file, line)) = &self.origin { self.config_causes.push(format!("{file}:{line}: {text}")); return }
        }
        if self.capture_err.is_none() {
            if let Some(c) = text.chars().next() { text = c.to_uppercase().collect::<String>() + &text[c.len_utf8()..] }
        }
        self.say(text, theme::WARN)
    }

    pub fn link(&self, machine_id: &str) -> Option<Link> {
        self.links.get(machine_id).and_then(|s| s.link.clone()).filter(|_| self.fleet.machine(machine_id).map(Machine::usable).unwrap_or(false))
    }

    // ── start: this machine, the account's machines, the desk ─────────────────

    pub fn boot(&mut self) {
        let port = self.port;
        self.spawn(async move { http_json(port, "GET", "/api/status", None).await }, |app, status| match status {
            Ok(status) => {
                app.daemon_down = false;
                app.viewer_web_url = status.get("webUrl").and_then(Value::as_str).unwrap_or("").to_string();
                let id = status.get("machineId").and_then(Value::as_str).unwrap_or("").to_string();
                if id.is_empty() { return }
                if app.fleet.agents.is_empty() && app.fleet.machines.is_empty() { app.fleet.load_cache(&id) }
                app.fleet.local_id = id.clone();
                for machine in &mut app.fleet.machines { machine.local = machine.id == id || crate::local::is_local(&machine.id); }
                if app.fleet.machine(&id).is_none() {
                    app.fleet.machines.insert(0, Machine { id: id.clone(), name: fleet::machine_display_name(&id, None), local: true, status: "running".into(), reach: Reach::Unknown });
                }
                app.connect(&id);
                app.refresh_machines();
            }
            Err(_) => {
                app.daemon_down = true;
                app.fleet.local_id = crate::local::MACHINE.into();
                app.ensure_local_shells();
                // A local shell belongs to a normal persisted session. It is never uploaded
                // as a Harness desk pane if the daemon starts later.
                if app.session_desk && app.mirror.is_none() && app.tabs.iter().all(|t| t.root.is_none()) {
                    app.keep_local_shell_session();
                }
                app.desk_loaded = true;
                app.desk_answered = true;
                app.maybe_start_shell();
                app.retry_boot();
            }
        });
    }

    /// Once a desk window contains a local PTY, keep this client's windows as an ordinary
    /// session. They survive daemon reconnect without sending local pane ids to the desk.
    pub fn keep_local_shell_session(&mut self) {
        if !self.session_desk { return }
        let name = self.has_windows().then(|| self.session_name());
        self.session_desk = false;
        let old = self.session_id;
        self.session_id = self.alloc_session_id();
        if self.first_session == old { self.first_session = self.session_id; }
        if self.session_alias.is_none() { self.session_alias = Some(name.unwrap_or_else(|| self.session_id.to_string())); }
        for tab in &mut self.tabs { tab.on_desk = false; }
        self.desk_layouts.clear();
    }

    fn ensure_local_shells(&mut self) {
        if self.fleet.machine(crate::local::MACHINE).is_none() {
            self.fleet.machines.insert(0, Machine { id: crate::local::MACHINE.into(), name: "This computer".into(), local: true, status: "running".into(), reach: Reach::Unknown });
        }
        self.connect(crate::local::MACHINE);
    }

    fn retry_boot(&mut self) {
        let sink = self.sink.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let _ = sink.send(Event::Apply(Box::new(|app: &mut App| app.boot())));
        });
    }

    pub fn refresh_machines(&mut self) {
        let port = self.port;
        self.spawn(async move { http_json(port, "GET", "/api/machines", None).await }, |app, reply| {
            let Ok(reply) = reply else { return };
            let rows = reply.get("machines").and_then(Value::as_array).cloned().unwrap_or_default();
            let local = app.fleet.local_id.clone();
            for row in rows {
                let id = row.get("machineId").and_then(Value::as_str).unwrap_or("").to_string();
                if id.is_empty() { continue }
                let name = fleet::machine_display_name(&id, row.get("name").and_then(Value::as_str));
                let status = row.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string();
                match app.fleet.machine_mut(&id) {
                    Some(machine) => { machine.name = name; machine.status = status; machine.local = id == local }
                    None => app.fleet.machines.push(Machine { local: id == local, id: id.clone(), name, status, reach: Reach::Unknown }),
                }
            }
            // This computer first, then the ones that are up.
            app.fleet.machines.sort_by_key(|m| (!m.local, !m.online(), m.name.to_lowercase()));
            let ids: Vec<String> = app.fleet.machines.iter().filter(|m| m.online() && matches!(m.reach, Reach::Unknown | Reach::Error(_))).map(|m| m.id.clone()).collect();
            for id in ids { app.connect(&id) }
            for machine in app.fleet.machines.iter_mut() { if !machine.online() && machine.reach == Reach::Unknown { machine.reach = Reach::Offline } }
        });
    }

    pub fn connect(&mut self, machine_id: &str) {
        if let Some(state) = self.links.get(machine_id) {
            if state.link.is_some() { return }
        }
        self.generation += 1;
        let link = Link::spawn(self.port, machine_id, self.generation, self.sink.clone());
        let attempts = self.links.get(machine_id).map(|s| s.attempts).unwrap_or(0);
        self.links.insert(machine_id.to_string(), LinkState { link: Some(link), generation: self.generation, attempts, retry_at: None });
        if let Some(machine) = self.fleet.machine_mut(machine_id) { machine.reach = Reach::Connecting }
    }

    fn schedule_reconnect(&mut self, machine_id: &str) {
        let Some(state) = self.links.get_mut(machine_id) else { return };
        if let Some(link) = state.link.take() { link.close(); }
        state.attempts += 1;
        let wait = Duration::from_millis((500 * 2u64.pow(state.attempts.min(5))).min(15_000));
        state.retry_at = Some(Instant::now() + wait);
    }

    /// Tell every connected machine's daemon the terminal's own colours (`theme_set`), so it
    /// paints the panes to match and the agents in them read the right light/dark. Called when
    /// the terminal answers OSC 11 and again when a machine connects; the daemon restyles the
    /// existing sessions too, as the desktop app's `theme_set` does.
    pub fn push_theme(&mut self) {
        let Some((mut bg, mut fg)) = crate::term_out::terminal_colours() else { return };
        if self.options.pane_look() {
            let palette = crate::theme::pane_palette();
            bg = crate::tmuxconf::colour_name(palette.surface);
            fg = crate::tmuxconf::colour_name(palette.foreground);
        }
        let machines: Vec<String> = self.fleet.machines.iter()
            .filter(|m| self.link(&m.id).is_some())
            .map(|m| m.id.clone()).collect();
        for machine_id in machines {
            let Some(link) = self.link(&machine_id) else { continue };
            let bg = bg.clone(); let fg = fg.clone();
            self.spawn(async move { link.rpc("theme_set", json!({ "background": bg, "foreground": fg }), Duration::from_secs(5)).await }, |_app, _reply| {});
        }
    }

    // ── machine events ───────────────────────────────────────────────────────

    pub fn on_machine(&mut self, machine_id: String, generation: u64, event: MachineEvent) {
        // A cancelled link can already have queued events. Ignore them during backoff too,
        // before the replacement connection has a new generation.
        let current = self.links.get(&machine_id).is_some_and(|s| s.generation == generation && s.link.is_some());
        if !current { return }
        match event {
            MachineEvent::Connected => {
                if let Some(state) = self.links.get_mut(&machine_id) { state.attempts = 0 }
                // What finished while the link was down (asleep, a network gone) is read against
                // seen.json again when its list comes back.
                self.seen_rostered.remove(&machine_id);
                if let Some(machine) = self.fleet.machine_mut(&machine_id) { machine.reach = Reach::Ready }
                if machine_id == self.fleet.local_id && !crate::local::is_local(&machine_id) { self.daemon_down = false; crate::dial::reconnected(self) }
                self.relist(&machine_id);
                self.push_theme();
                // Its home folder, so its paths read `~/…` like this machine's do.
                if !self.homes.contains_key(&machine_id) {
                    if let Some(link) = self.link(&machine_id) {
                        let id = machine_id.clone();
                        self.spawn(async move { link.rpc("fs_list_dir", json!({}), Duration::from_secs(20)).await }, move |app, reply| {
                            if let Some(path) = reply.ok().and_then(|r| r.get("path").and_then(Value::as_str).map(str::to_string)) { app.homes.insert(id, path); }
                        });
                    }
                }
                if crate::local::is_local(&machine_id) { self.maybe_start_shell(); }
                else if machine_id == self.fleet.local_id && !self.desk_loaded { self.load_desk() }
                if machine_id == self.fleet.local_id { self.release_cli() }
                // Every pane of this machine that lost its stream gets it back.
                let ids: Vec<u64> = self.panes.values().filter(|p| p.machine_id == machine_id && p.stream.is_none() && !matches!(p.phase, Phase::Card { .. })).map(|p| p.id).collect();
                for id in ids { self.open_stream(id, false) }
            }
            MachineEvent::Failed(error) | MachineEvent::Closed(error) => {
                for agent in self.fleet.agents.values_mut().filter(|a| a.machine_id == machine_id) {
                    let unknown = agent.working || agent.activity.unknown;
                    agent.working = false;
                    agent.activity = crate::activity::Activity::default();
                    agent.activity.unknown = unknown;
                }
                let needs_link = error.code == "NO_PEER_LINK";
                if let Some(machine) = self.fleet.machine_mut(&machine_id) {
                    machine.reach = if needs_link { Reach::NeedsLink } else if machine.online() { Reach::Error(error.to_string()) } else { Reach::Offline };
                }
                if machine_id == self.fleet.local_id && !crate::local::is_local(&machine_id) && matches!(error.code.as_str(), "DAEMON_UNREACHABLE" | "HEARTBEAT_TIMEOUT" | "DISCONNECTED") {
                    self.daemon_down = true;
                    self.ensure_local_shells();
                }
                for pane in self.panes.values_mut().filter(|p| p.machine_id == machine_id) {
                    pane.stream = None;
                    pane.opening = false;
                    pane.takeover_pending = false;
                    pane.open_token += 1;
                    if !matches!(pane.phase, Phase::Card { .. }) {
                        pane.phase = if needs_link {
                            Phase::Card { title: "This machine is not linked here".into(), detail: format!("Link it once with its remote password (machines, then C-l), or run:\nharness link connect {machine_id}"), keys: vec![("enter".into(), "retry".into()), (self.keymap.hint("choose-tree -m").unwrap_or_default(), "machines".into())] }
                        } else {
                            Phase::Connecting(format!("Reconnecting to {}…", self.fleet.machine_name(&machine_id)))
                        };
                    }
                    pane.dirty = true;
                }
                if needs_link { if let Some(state) = self.links.get_mut(&machine_id) { if let Some(link) = state.link.take() { link.close(); } state.retry_at = None; } }
                else { self.schedule_reconnect(&machine_id) }
            }
            MachineEvent::Terminal(frame) => self.on_terminal(frame),
            MachineEvent::Frame { ty, payload } => self.on_frame(&machine_id, &ty, payload),
        }
    }

    pub fn relist(&mut self, machine_id: &str) {
        let Some(link) = self.link(machine_id) else { return };
        let id = machine_id.to_string();
        // Live harnesses first: the daemon answers those in milliseconds, while the list with every
        // paused one costs it most of a second. Paint what is running, then fold the rest in.
        let fast = link.clone();
        let fast_id = id.clone();
        self.spawn(async move { let t = Instant::now(); (fast.rpc("agents_list", json!({}), Duration::from_secs(20)).await, t.elapsed()) }, move |app, (reply, took)| {
            if reply.is_ok() { app.rtt.insert(fast_id.clone(), took); }
            if let Ok(reply) = reply {
                let rows = reply.get("agents").and_then(Value::as_array).cloned().unwrap_or_default();
                app.fleet.merge_roster(&fast_id, &rows);
                app.sync_titles();
                app.replay_questions(&fast_id);
            }
        });
        let asked = Instant::now();
        self.spawn(async move { link.rpc("agents_list", json!({ "includeStopped": true }), Duration::from_secs(20)).await }, move |app, reply| {
            if let Ok(reply) = reply {
                let rows = reply.get("agents").and_then(Value::as_array).cloned().unwrap_or_default();
                app.fleet.replace_roster(&id, &rows, asked);
                app.catch_up(&id);
                app.sync_titles();
                app.replay_questions(&id);
            }
        });
    }

    /// The questions kept for harnesses not listed then: asked again now that [machine]'s are.
    fn replay_questions(&mut self, machine: &str) {
        let (mine, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending_questions).into_iter().partition(|(m, _, _)| m == machine);
        self.pending_questions = rest;
        for (_, payload, at) in mine {
            let known = self.fleet.event_agent(machine, &payload).is_some();
            if known { self.on_frame(machine, "commander_question", payload) } else if at.elapsed() < Duration::from_secs(120) { self.pending_questions.push((machine.to_string(), payload, at)) }
        }
    }

    fn on_frame(&mut self, machine_id: &str, ty: &str, payload: Value) {
        // The dial's frames come from this computer's daemon, to the windows on it.
        if machine_id == self.fleet.local_id && crate::dial::on_frame(self, ty, &payload) { return }
        if payload.get("activity").is_some() {
            if let Some(agent) = self.fleet.event_agent(machine_id, &payload) {
                if let Some(working) = agent.activity.accept(&payload["activity"], Instant::now()) {
                    agent.working = working;
                } else if matches!(ty, "turn_ended" | "turn_started") { return }
            }
        }
        if ty == "agent_activity" { return }
        // ── models: a message to a resting model starts its pane's "Starting up…" ──
        crate::models::watch_turn(self, machine_id, ty, &payload);
        match ty {
            "agent_synced" | "agent_created" | "agent_renamed" => {
                let row = payload.get("agent").cloned().unwrap_or(payload.clone());
                let Some(id) = row.get("id").and_then(Value::as_str).map(str::to_string) else { return };
                let key = (machine_id.to_string(), id);
                if ty == "agent_renamed" && row.get("engine").is_none() {
                    if let (Some(agent), Some(name)) = (self.fleet.agents.get_mut(&key), row.get("name").and_then(Value::as_str)) { agent.name = name.to_string() }
                } else {
                    let previous = self.fleet.agents.get(&key);
                    let agent = fleet::agent_from(machine_id, &row, previous);
                    let viewer_ready = !agent.viewer_url.is_empty() && previous.is_none_or(|a| a.viewer_url.is_empty())
                        && crate::input::focused_key(self).as_ref() == Some(&key);
                    let viewer_name = if agent.viewer_name.is_empty() { "Viewer".to_string() } else { agent.viewer_name.clone() };
                    self.fleet.agents.insert(key, agent);
                    if viewer_ready { self.say(format!("{viewer_name} ready — C-b : view opens it"), theme::ONLINE) }
                }
                self.sync_titles();
            }
            "agent_deleted" => {
                let id = payload.get("agentId").or_else(|| payload.get("id")).and_then(Value::as_str).unwrap_or("");
                if let Some(agent) = self.fleet.agents.get_mut(&(machine_id.to_string(), id.to_string())) {
                    agent.status = "stopped".into();
                    agent.working = false; agent.activity.unknown = false;
                    agent.question = None;
                }
                self.relist(machine_id);
            }
            "turn_started" | "turn_heartbeat" | "tool_start" | "tool_end" | "text_delta" | "thinking_title" => {
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) {
                    let now = fleet::now_ms();
                    // A turn begun (or found running): the state's clock starts, what it says anew.
                    if ty == "turn_started" || !agent.working { agent.since = now; agent.doing = None; agent.said.clear() }
                    if !agent.activity.reported() && payload["replay"] != true {
                        if ty != "turn_heartbeat" { agent.activity.legacy_heartbeat_seen = false; }
                        if ty != "turn_heartbeat" || !agent.activity.legacy_heartbeat_seen {
                            agent.working = true; agent.activity.unknown = false;
                            agent.last_beat = Some(Instant::now());
                            agent.activity.legacy_heartbeat_seen = ty == "turn_heartbeat";
                        }
                    }
                    agent.active_at = now;
                    if ty == "turn_started" {
                        agent.unread = false; agent.errored = false;
                        // What its last turn came to is not what this one does.
                        agent.did = None;
                        let key = agent.key();
                        if self.agent_errors.remove(&key).is_some() { self.seen_dirty = true }
                    }
                    let text = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or("");
                    // What it was asked (the turn's message; not a replay of an old one).
                    if ty == "turn_started" { if let Some(l) = fleet::first_line(text("userMessage")) { agent.asked = Some(l) } }
                    // The main agent's own steps (a sub-agent's carry the tool call that spawned it).
                    let own = payload.get("parentToolUseId").map(Value::is_null).unwrap_or(true);
                    let input = payload.get("input").unwrap_or(&Value::Null);
                    // Its plan, and the sub-agents it starts and that end.
                    if ty == "tool_start" && own && text("tool") == "TodoWrite" { agent.todos = fleet::todos_of(input) }
                    if ty == "tool_start" && own && matches!(text("tool"), "Task" | "Agent") {
                        let what = input.get("description").and_then(Value::as_str).unwrap_or("an agent").to_string();
                        agent.subagents.push((text("id").to_string(), what));
                    }
                    if ty == "tool_end" { let id = text("id").to_string(); agent.subagents.retain(|(s, _)| *s != id) }
                    match ty {
                        // What it does now; the text before a tool call is not its final message.
                        "tool_start" if own => { agent.doing = Some(fleet::describe_tool(text("tool"), input)); agent.said.clear() }
                        "thinking_title" => { let t = text("title").trim(); if !t.is_empty() { agent.doing = Some(t.chars().take(160).collect()) } }
                        "text_delta" if own && agent.said.len() < 2000 => agent.said.push_str(text("content")),
                        _ => {}
                    }
                }
            }
            "turn_ended" => {
                let visible = self.visible_agents();
                let looking = self.focused().filter(|_| self.terminal_focused).and_then(|f| self.panes.get(&f)).map(|p| (p.machine_id.clone(), p.agent_id.clone()));
                let opened: Vec<(String, String)> = self.panes.values().map(|p| (p.machine_id.clone(), p.agent_id.clone())).collect();
                let flag = |k: &str| payload.get(k).and_then(Value::as_bool).unwrap_or(false);
                let (replay, subagent) = (flag("replay"), flag("subagent"));
                let aborted = payload.get("aborted").and_then(Value::as_bool).unwrap_or(false);
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) {
                    agent.working = false; agent.activity.unknown = false; agent.activity.until = None;
                    if !subagent { agent.subagents.clear() }
                    agent.active_at = fleet::now_ms();
                    agent.since = agent.active_at;
                    agent.doing = None;
                    // What the turn came to: the first line of its final message.
                    let said = std::mem::take(&mut agent.said);
                    if !said.trim().is_empty() && !aborted { agent.last_text = said.trim().to_string() }
                    if aborted { agent.did = Some("Interrupted".into()) } else if agent.errored { } else if let Some(line) = fleet::first_line(&said) { agent.did = Some(line) }
                    let name = agent.name.clone();
                    let mine = opened.contains(&agent.key());
                    // Done and not yet read — any harness's turn (not a re-read, not a sub-agent's)
                    // that ended where you were not looking: the focused pane, with the terminal
                    // focused. A visible pane beside the one you type in is not being read.
                    let key = agent.key();
                    let hook_key = key.clone();
                    // A turn that failed says so (its error), not that it finished — and is not done.
                    let failed = agent.errored && !aborted;
                    let what = if failed { format!("{name} failed{}", agent.did.as_ref().filter(|d| !d.is_empty()).map(|d| format!(": {d}")).unwrap_or_default()) } else { format!("{name} finished") };
                    if !replay && !subagent && looking.as_ref() != Some(&key) {
                        agent.unread = true;
                        if mine && !visible.contains(&key) { self.say(what.clone(), if failed { theme::DANGER } else { theme::ONLINE }) }
                    } else if looking.as_ref() == Some(&key) { self.mark_seen_key(key) }
                    if mine && !self.terminal_focused && !replay && !subagent { crate::notify("Harness", &what) }
                    if !replay && !subagent && !failed { crate::commands::notify_harness(self, "harness-done", &hook_key) }
                }
            }
            "done" => {
                // The turn's result, where the engine gives one: what it came to.
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) {
                    if let Some(line) = payload.get("result").and_then(Value::as_str).and_then(fleet::first_line) { agent.did = Some(line) }
                }
            }
            // What was typed to it (from any window): what it was asked.
            "user_message" => {
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) {
                    if let Some(l) = payload.get("content").and_then(Value::as_str).and_then(fleet::first_line) { agent.asked = Some(l) }
                }
            }
            // The daemon's recap of a finished turn ("recap\n\nbody"): what it came to, better said
            // than its last message's first line.
            "turn_summary" => {
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) {
                    if let Some(l) = payload.get("summary").and_then(Value::as_str).and_then(fleet::first_line) { agent.did = Some(l) }
                }
            }
            // A failure the engine or the daemon reports (a message not delivered, an abort).
            "error" => {
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) {
                    if let Some(l) = payload.get("message").and_then(Value::as_str).and_then(fleet::first_line) { agent.did = Some(format!("Error: {}", fleet::tidy_error(&l))) }
                    agent.errored = true;
                    let (key, line) = (agent.key(), agent.did.clone().unwrap_or_default());
                    self.agent_errors.insert(key.clone(), (fleet::now_ms(), line));
                    self.seen_dirty = true;
                    crate::commands::notify_harness(self, "harness-failed", &key);
                }
            }
            "commander_question" => {
                let visible = self.visible_agents();
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) {
                    let next = fleet::question_from(&payload, agent.question.as_ref());
                    let fresh = next.as_ref().map(|q| agent.question.as_ref().map(|p| p.request_id != q.request_id).unwrap_or(true)).unwrap_or(false);
                    if next.is_some() { agent.question = next }
                    let name = agent.name.clone();
                    let hook_key = agent.key();
                    let prompt = agent.question.as_ref().map(|q| q.prompt.clone()).unwrap_or_default();
                    let rid = agent.question.as_ref().map(|q| q.request_id.clone()).unwrap_or_default();
                    if fresh && !visible.contains(&agent.key()) {
                        // A burst (several asking at once, or a daemon's replay) said once: how many,
                        // and one bell.
                        let now = Instant::now();
                        let burst = self.asking_burst.filter(|(_, at)| now.duration_since(*at) < Duration::from_millis(1500)).map(|(n, _)| n + 1).unwrap_or(1);
                        self.asking_burst = Some((burst, now));
                        let k = self.keymap.hint("choose-tree -a").unwrap_or_default();
                        let text = if burst > 1 { format!("{burst} harnesses are waiting on you — {k}") } else { format!("{name} is waiting on you — {k}") };
                        self.say(text, theme::ATTENTION);
                        self.toast_hold = Some(4000);
                        // A bell as a window's is rung: not with bell-action none, nor visual-bell on.
                        let quiet = self.options.get("bell-action", "", None).as_deref() == Some("none") || self.options.get("visual-bell", "", None).as_deref() == Some("on");
                        if !quiet && burst == 1 { crate::bell() }
                    }
                    if fresh && !self.terminal_focused { crate::notify(&format!("{name} needs input"), &prompt) }
                    // harness-needs once a question, by this server name — not again from the client
                    // that takes over at a detach, nor at the next start.
                    let server = std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "default".into());
                    let asked_key = format!("{server}\t{machine_id}:{rid}");
                    if fresh && !self.announced.contains_key(&asked_key) {
                        self.announced.insert(asked_key, fleet::now_ms());
                        self.seen_dirty = true;
                        crate::commands::notify_harness(self, "harness-needs", &hook_key)
                    }
                } else {
                    // A harness not listed yet (the daemon hands the open questions over as the
                    // link comes up, before hn has asked for the list): kept until it is.
                    let rid = payload.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
                    self.pending_questions.retain(|(m, p, at)| !(m == machine_id && p.get("requestId").and_then(Value::as_str) == Some(rid.as_str())) && at.elapsed() < Duration::from_secs(120));
                    if self.pending_questions.len() < 256 { self.pending_questions.push((machine_id.to_string(), payload, Instant::now())) }
                }
            }
            // Which questions are open on this computer (after the ones handed over as the link
            // came up): one asked before and answered while the link was down is let go.
            "commander_questions_open" => {
                let open: std::collections::HashSet<String> = payload.get("requestIds").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
                for a in self.fleet.agents.values_mut().filter(|a| a.machine_id == machine_id) {
                    if a.question.as_ref().map(|q| !open.contains(&q.request_id)).unwrap_or(false) { a.question = None }
                }
                self.pending_questions.retain(|(m, p, _)| m != machine_id || p.get("requestId").and_then(Value::as_str).map(|r| open.contains(r)).unwrap_or(false));
            }
            "commander_question_close" => {
                let rid = payload.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
                self.pending_questions.retain(|(m, p, _)| !(m == machine_id && p.get("requestId").and_then(Value::as_str) == Some(rid.as_str())));
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) { agent.question = None }
            }
            "machines_changed" => self.refresh_machines(),
            "desk_changed" => {
                let revision = payload.get("revision").and_then(Value::as_i64).unwrap_or(i64::MAX);
                if revision > self.desk_revision && self.desk_mode != DeskMode::Off { self.fetch_desk() }
            }
            "terminal_restarted" => {
                let stream = payload["streamId"].as_str().and_then(|s| Uuid::parse_str(s).ok());
                if let Some(pane) = self.panes.values_mut().find(|p| p.stream.is_some() && p.stream == stream) {
                    pane.dead = None; pane.phase = Phase::Live; pane.dirty = true;
                    if let Some(agent) = self.fleet.agents.get_mut(&(pane.machine_id.clone(), pane.agent_id.clone())) { agent.status = "active".into(); }
                }
            }
            "terminal_closed" => {
                let stream = payload.get("streamId").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok());
                let death = crate::local::is_local(machine_id).then(|| serde_json::from_value::<pane::Exit>(payload["exit"].clone()).ok()).flatten();
                let Some(pane) = self.panes.values_mut().find(|p| p.stream.is_some() && p.stream == stream) else {
                    if let (Some(stream), Some(death)) = (stream, death) { if self.orphan_exits.len() < 16 { self.orphan_exits.insert(stream, (Instant::now(), death)); } }
                    return
                };
                if let Some(death) = death { let id = pane.id; self.local_ended(id, death); return }
                pane.stream = None;
                pane.dirty = true;
                if let Some(taken) = payload.get("takenBy") {
                    let who = taken.get("name").and_then(Value::as_str).unwrap_or("another window").to_string();
                    pane.phase = Phase::Watching(who);
                    // Still worth seeing: watch it until someone types here.
                    let id = pane.id;
                    self.open_stream(id, false);
                } else {
                    let id = pane.id;
                    let reason = payload.get("reason").and_then(Value::as_str).unwrap_or("the terminal closed");
                    if matches!(reason, "heartbeat timeout" | "backend disconnected") {
                        // A lease expiry says nothing about the process. Renew the machine route
                        // and all its panes, including hidden windows and split shells, without
                        // restarting anything or taking the keyboard from another client.
                        self.recover_streams(machine_id, reason);
                    } else {
                        self.after_end(id, reason.to_string());
                    }
                }
            }
            "terminal_error" => {
                let stream = payload.get("streamId").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok());
                if let Some(pane) = self.panes.values_mut().find(|p| p.stream.is_some() && p.stream == stream) {
                    if payload.get("code").and_then(Value::as_str) == Some("TERMINAL_INPUT_INVALID") {
                        if let Some(expected) = payload.get("expectedSeq").and_then(Value::as_u64) { pane.input_seq = expected }
                    }
                }
            }
            // ── models: the daemon's picture of the grids changed — the whole list, pushed ──
            "grid_models_changed" => crate::models::on_push(self, machine_id, &payload),
            _ => {}
        }
    }

    fn on_terminal(&mut self, frame: proto::Frame) {
        let Some(pane) = self.panes.values_mut().find(|p| p.stream == Some(frame.stream)) else {
            // Hold it for a moment: its `terminal_ready` may still be on the way.
            if self.orphans.len() < 16 {
                let entry = self.orphans.entry(frame.stream).or_insert_with(|| (Instant::now(), Vec::new()));
                if entry.1.len() < 64 { entry.1.push(frame) }
            }
            return;
        };
        pane.last_seq = Some(pane.last_seq.map(|s| s.max(frame.seq)).unwrap_or(frame.seq));
        pane.ack_due = true;
        if frame.kind == Kind::Sync { return }
        let bytes = if frame.compressed { match pane::inflate(&frame.bytes) { Some(b) => b, None => return } } else { frame.bytes };
        if let Ok(path) = std::env::var("HARNESS_TUI_TRACE") {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(f, "{} {:?} {}", if frame.kind == Kind::Keyframe { "K" } else { "O" }, frame.size, bytes.escape_ascii());
            }
        }
        if frame.kind == Kind::Keyframe {
            let (cols, rows) = frame.size.unwrap_or((pane.cols, pane.rows));
            pane.keyframe(cols, rows, &bytes);
            if matches!(pane.phase, Phase::Connecting(_)) { pane.phase = if pane.read_only { Phase::Watching(String::new()) } else { Phase::Live } }
        } else {
            pane.note_echo();
            if let Some(out) = self.pipes.get(&pane.id).and_then(|p| p.out.as_ref()) { let _ = out.send(bytes.clone()); }
            pane.feed(&bytes);
            pane.settle_predictions();
            let belled = std::mem::replace(&mut pane.bell, false);
            let copied = std::mem::take(&mut pane.copied);
            let id = pane.id;
            // set-clipboard (input.c's input_osc_52): a program's OSC 52 only with `on` — a paste
            // buffer, and the terminal's clipboard; `external` (the default) is for hn's own copies
            // alone, so a pane (a harness on another machine) never sets your clipboard unasked.
            for text in copied {
                if self.options.get("set-clipboard", "", None).as_deref() != Some("on") { continue }
                crate::clipboard::store(&text);
                let limit = self.buffer_limit();
                self.paste.add(text, limit);
                self.server_dirty = true;
            }
            // alerts.c: output is activity; a BEL is a bell.
            if let Some(t) = self.tabs.iter().position(|t| t.panes().contains(&id)) {
                self.tabs[t].touch();
                // alerts_check_all: the bell first, then the activity.
                if belled { self.alert(t, BELL) }
                self.alert(t, ACTIVITY);
            }
            // Each winlink has its own alerts. A grouped window can be current here and in the
            // background in another session, including one shown by a different terminal.
            let shown = (!self.headless).then_some(self.swap_back.unwrap_or(self.session_id));
            for session in self.sessions.iter_mut().filter(|s| s.mirror.is_none()) {
                let attached = shown == Some(session.id) || self.mirrors.values().any(|sid| *sid == session.id);
                for (i, tab) in session.tabs.iter_mut().enumerate().filter(|(_, t)| t.panes().contains(&id)) {
                    tab.touch();
                    if i == session.active && attached { continue }
                    if self.options.get("monitor-activity", &tab.id, None).as_deref() == Some("on") { tab.alerts |= ACTIVITY }
                    if belled && self.options.get("monitor-bell", &tab.id, None).as_deref() == Some("on") { tab.alerts |= BELL }
                }
            }
        }
    }

    /// Acks and heartbeats for every live stream — batched once per loop turn.
    pub fn flush_acks(&mut self) {
        let now = Instant::now();
        let mut sends: Vec<(String, &'static str, Value)> = Vec::new();
        for pane in self.panes.values_mut() {
            let Some(stream) = pane.stream else { continue };
            if pane.ack_due {
                pane.ack_due = false;
                if let Some(seq) = pane.last_seq { sends.push((pane.machine_id.clone(), "terminal_ack", json!({ "streamId": stream.to_string(), "lastSeq": seq }))) }
            }
            if now.duration_since(pane.last_alive) > Duration::from_secs(10) {
                pane.last_alive = now;
                sends.push((pane.machine_id.clone(), "terminal_alive", json!({ "streamId": stream.to_string() })));
            }
        }
        for (machine, ty, payload) in sends {
            if let Some(link) = self.link(&machine) { link.send(ty, payload); }
        }
    }

    // ── streams ─────────────────────────────────────────────────────────────

    fn recover_streams(&mut self, machine_id: &str, detail: &str) {
        if let Some(state) = self.links.get(machine_id) {
            self.on_machine(machine_id.to_string(), state.generation,
                MachineEvent::Closed(RpcError::new("TERMINAL_CONNECTION_LOST", detail)));
        }
    }

    /// A user asks for control of this TUI: reclaim every available pane across its tabs and
    /// sessions without moving focus. Reconnects and ownership notifications never call this.
    pub fn take_control(&mut self) {
        if self.read_only() { return }
        let mut ids: Vec<u64> = self.tabs.iter().chain(self.sessions.iter()
            .filter(|s| !s.mirror.as_ref().is_some_and(|m| m.readonly))
            .flat_map(|s| s.tabs.iter())).flat_map(Tab::panes).collect();
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            let Some(pane) = self.panes.get_mut(&id) else { continue };
            if pane.dead.is_some() || matches!(pane.phase, Phase::Card { .. }) { continue }
            if pane.stream.is_some() && !pane.read_only && !matches!(pane.phase, Phase::Watching(_)) { continue }
            if !self.fleet.machine(&pane.machine_id).is_some_and(Machine::usable)
                || !self.links.get(&pane.machine_id).is_some_and(|s| s.link.is_some()) { continue }
            if pane.opening { pane.takeover_pending = true }
            else { self.open_stream(id, true) }
        }
    }

    /// Open (or re-open) a pane's terminal. [takeover]: take the keyboard from any other window.
    pub fn open_stream(&mut self, pane_id: u64, takeover: bool) {
        let content = self.content_size(pane_id);
        // A harness whose start failed has no terminal: its pane says why (the daemon's words)
        // and what to do.
        let failed = self.panes.get(&pane_id).and_then(|p| self.fleet.agent(&p.machine_id, &p.agent_id)).filter(|a| a.launch == "failed").map(|a| a.launch_error.clone());
        if let Some(why) = failed {
            let restart = self.keymap.hint("confirm-before -p \"restart #T? (y/n)\" restart-harness").unwrap_or_else(|| "C-b R".into());
            let close = self.keymap.hint("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane").unwrap_or_else(|| "C-b x".into());
            if let Some(pane) = self.panes.get_mut(&pane_id) {
                pane.phase = Phase::Card { title: "Failed to start".into(), detail: if why.is_empty() { "The daemon did not say why.".into() } else { why }, keys: vec![(restart, "restart".into()), (close, "close pane".into())] };
                pane.dirty = true;
            }
            return;
        }
        let Some(pane) = self.panes.get_mut(&pane_id) else { return };
        if pane.opening { return }
        // Do not send an open before machine_select has succeeded: its reply could otherwise
        // be discarded by the selecting link, leaving this pane waiting for 45 seconds.
        let Some(link) = self.links.get(&pane.machine_id).and_then(|s| s.link.clone())
            .filter(|_| self.fleet.machine(&pane.machine_id).is_some_and(Machine::usable)) else {
            pane.phase = Phase::Connecting("Connecting…".into());
            return;
        };
        let (cols, rows) = content.unwrap_or((pane.cols, pane.rows));
        // The remote terminal follows the actual tile, including narrow or short split panes.
        let (cols, rows) = pane::stream_size(cols, rows);
        pane.opening = true;
        pane.want = (cols, rows);
        if !matches!(pane.phase, Phase::Watching(_)) || takeover { pane.phase = Phase::Connecting(if takeover { "Taking over…".into() } else { "Opening…".into() }) }
        let old = pane.stream.take();
        if let Some(old) = old { link.send("terminal_close", json!({ "streamId": old.to_string() })); }
        let agent_id = pane.agent_id.clone();
        let machine_id = pane.machine_id.clone();
        // Replies from an earlier open (a socket that has since dropped, a pane re-opened) are
        // recognised by this token and not allowed to overwrite the current state.
        pane.open_token += 1;
        let token = pane.open_token;
        let host = self.fleet.local_machine_name();
        self.spawn(async move {
            link.request("terminal_open", json!({
                "protocolVersion": 3,
                "agentId": agent_id,
                "cols": cols,
                "rows": rows,
                "compression": ["zlib", "none"],
                "client": { "kind": "tui", "name": format!("{host} terminal") },
                "takeover": takeover,
            }), Duration::from_secs(45)).await
        }, move |app, reply| app.opened(pane_id, &machine_id, token, (cols, rows), reply));
    }

    fn opened(&mut self, pane_id: u64, machine_id: &str, token: u64, asked: (u16, u16), reply: Result<(String, Value), RpcError>) {
        let stream = reply.as_ref().ok().filter(|(ty, _)| ty == "terminal_ready").and_then(|(_, p)| p.get("streamId").and_then(Value::as_str)).and_then(|s| Uuid::parse_str(s).ok());
        let current = self.panes.get(&pane_id).map(|p| p.open_token == token).unwrap_or(false);
        if !current {
            if let Some(stream) = stream { self.orphans.remove(&stream); self.orphan_exits.remove(&stream); }
            // The pane went away (or opened again) while this was in flight: give the terminal back,
            // or this window would hold its keyboard lease with nothing on screen.
            if let (Some(stream), Some(link)) = (stream, self.links.get(machine_id).and_then(|s| s.link.clone())) {
                link.send("terminal_close", json!({ "streamId": stream.to_string() }));
            }
            return;
        }
        let Some(pane) = self.panes.get_mut(&pane_id) else { return };
        pane.opening = false;
        let takeover_requested = std::mem::take(&mut pane.takeover_pending);
        match reply {
            Ok((ty, payload)) if ty == "terminal_ready" => {
                pane.stream = stream;
                pane.read_only = payload.get("readOnly").and_then(Value::as_bool).unwrap_or(false);
                pane.input_seq = 0;
                pane.resize_seq = 0;
                pane.last_seq = None;
                pane.last_alive = Instant::now();
                pane.phase = if pane.read_only {
                    Phase::Watching(payload.get("heldBy").and_then(|h| h.get("name")).and_then(Value::as_str).unwrap_or("another window").to_string())
                } else { Phase::Live };
                let retake = takeover_requested && pane.read_only;
                let queued = if retake { Vec::new() } else { std::mem::take(&mut pane.queued) };
                let read_only = pane.read_only;
                // The tile changed size while this was opening: tell the far pane now.
                if !read_only && pane.want != asked {
                    pane.resize_seq += 1;
                    let (seq, want) = (pane.resize_seq, pane.want);
                    if let (Some(stream), Some(link)) = (stream, self.links.get(machine_id).and_then(|s| s.link.clone())) {
                        link.send("terminal_resize", json!({ "streamId": stream.to_string(), "resizeSeq": seq, "cols": want.0, "rows": want.1 }));
                    }
                }
                // Frames that raced ahead of this reply (the keyframe, often) are applied now.
                if let Some(stream) = stream {
                    for frame in self.orphans.remove(&stream).map(|(_, f)| f).unwrap_or_default() { self.on_terminal(frame) }
                }
                if !read_only { for bytes in queued { self.send_input(pane_id, &bytes) } }
                // What it runs, asked now rather than at the next two-second look: a shell's window
                // is named for it (automatic-rename) from the start, as tmux names it.
                self.refresh_pane_info(pane_id);
                if crate::local::is_local(machine_id) {
                    let death = stream.and_then(|id| self.orphan_exits.remove(&id).map(|(_, death)| death)).or_else(|| serde_json::from_value::<pane::Exit>(payload["exit"].clone()).ok());
                    if let Some(death) = death { self.local_ended(pane_id, death) }
                }
                if retake && self.panes.get(&pane_id).is_some_and(|p| p.dead.is_none() && matches!(p.phase, Phase::Watching(_))) {
                    self.open_stream(pane_id, true);
                }
            }
            Ok((_, payload)) => {
                let code = payload.get("code").and_then(Value::as_str).unwrap_or("TERMINAL_OPEN_FAILED").to_string();
                if code == "TERMINAL_AGENT_NOT_FOUND" || code == "TERMINAL_RUNTIME_UNAVAILABLE" {
                    self.after_end(pane_id, code);
                } else {
                    pane.phase = Phase::Card { title: "Could not open the terminal".into(), detail: code, keys: vec![("enter".into(), "retry".into()), (self.keymap.hint("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane").unwrap_or_else(|| "C-b x".into()), "close pane".into())] };
                }
            }
            Err(error) if matches!(error.code.as_str(), "TIMEOUT" | "DISCONNECTED") => {
                // A local WebSocket pong cannot establish that the remote terminal route is
                // healthy. Drop that route so retrying cannot wait on the same stuck request.
                self.recover_streams(machine_id, &error.to_string());
            }
            Err(error) => {
                pane.phase = Phase::Card { title: "Could not open the terminal".into(), detail: error.to_string(), keys: vec![("enter".into(), "retry".into()), (self.keymap.hint("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane").unwrap_or_else(|| "C-b x".into()), "close pane".into())] };
            }
        }
        if let Some(pane) = self.panes.get_mut(&pane_id) { pane.dirty = true }
    }

    /// Native process death is distinct from losing a stream. Keep a requested dead pane's
    /// grid and status, and remember the exit identity so handoff never repeats pane-died.
    fn local_ended(&mut self, pane_id: u64, death: pane::Exit) {
        if matches!(self.modal, Some(crate::modal::Modal::Popup { pane, .. }) if pane == pane_id) { self.close_popup(); return }
        let Some(owner) = self.session_of_pane(pane_id) else { return };
        let back = self.session_id;
        if owner != back { self.swap_session(owner); }
        let Some(window) = self.tabs.iter().position(|t| t.panes().contains(&pane_id)) else { return };
        let pane = self.panes.get_mut(&pane_id).unwrap();
        let fresh = pane.dead.as_ref().map(|e| &e.id) != Some(&death.id);
        pane.dead = Some(death.clone()); pane.phase = Phase::Live; pane.dirty = true;
        let key = (pane.machine_id.clone(), pane.agent_id.clone());
        if let Some(agent) = self.fleet.agents.get_mut(&key) { agent.status = "stopped".into(); }
        if fresh {
            let remain = self.options.get("remain-on-exit", &self.tabs[window].id, Some(pane_id)).unwrap_or_default();
            if remain == "on" || remain == "failed" && (death.status != Some(0)) {
                let format = self.options.get("remain-on-exit-format", &self.tabs[window].id, Some(pane_id)).unwrap_or_default();
                let text = crate::format::expand(self, &format, window, Some(pane_id), false);
                if let Some(link) = self.link(&key.0) { link.send("terminal_remain", json!({"agentId":key.1,"exitId":death.id,"text":text})); }
                crate::commands::notify(self, "pane-died", Some(window), Some(pane_id));
                self.save_sessions();
            } else {
                crate::commands::notify(self, "pane-exited", Some(window), Some(pane_id));
                crate::commands::run_pending_hooks(self);
                self.close_pane(pane_id);
            }
        }
        if owner != back { self.swap_session(back); }
    }

    /// The stream ended with nobody taking it: say why, from the agent's state.
    fn after_end(&mut self, pane_id: u64, reason: String) {
        // A popup's program that exits closes the popup (display-popup -E).
        if matches!(self.modal, Some(crate::modal::Modal::Popup { pane, .. }) if pane == pane_id) { self.close_popup(); return }
        // A split's shell that exits takes its pane with it, as in tmux.
        if let Some(key) = self.panes.get(&pane_id).map(|p| (p.machine_id.clone(), p.agent_id.clone())) {
            if self.shells.contains(&key) { self.shells.remove(&key); self.close_pane(pane_id); return }
        }
        let Some(pane) = self.panes.get_mut(&pane_id) else { return };
        let agent = self.fleet.agent(&pane.machine_id, &pane.agent_id);
        pane.stream = None;
        pane.phase = match agent.map(|a| a.status.as_str()) {
            Some("stopped") => Phase::Card { title: "Paused".into(), detail: "The conversation is saved.".into(), keys: vec![("enter".into(), "resume".into()), (self.keymap.hint("choose-tree -Zs").or_else(|| self.keymap.hint("choose-tree -s")).unwrap_or_default(), "open another".into()), (self.keymap.hint("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane").unwrap_or_else(|| "C-b x".into()), "close pane".into())] },
            None => Phase::Card { title: "This harness is gone".into(), detail: "It is no longer on its machine.".into(), keys: vec![(self.keymap.hint("choose-tree -Zs").or_else(|| self.keymap.hint("choose-tree -s")).unwrap_or_default(), "open another".into()), (self.keymap.hint("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane").unwrap_or_else(|| "C-b x".into()), "close pane".into())] },
            _ if agent.map(|a| a.launch == "starting").unwrap_or(false) => Phase::Connecting("Starting…".into()),
            _ => Phase::Card { title: "The terminal closed".into(), detail: reason, keys: vec![("enter".into(), "reopen".into()), (self.keymap.hint("confirm-before -p \"restart #T? (y/n)\" restart-harness").unwrap_or_else(|| "C-b R".into()), "restart".into()), (self.keymap.hint("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane").unwrap_or_else(|| "C-b x".into()), "close pane".into())] },
        };
        pane.dirty = true;
        // A harness that is still starting will have a terminal in a moment.
        if matches!(pane.phase, Phase::Connecting(_)) {
            let sink = self.sink.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1200)).await;
                let _ = sink.send(Event::Apply(Box::new(move |app: &mut App| app.open_stream(pane_id, true))));
            });
        }
    }

    pub fn resume(&mut self, pane_id: u64) {
        let Some(pane) = self.panes.get_mut(&pane_id) else { return };
        let Some(link) = self.links.get(&pane.machine_id).and_then(|s| s.link.clone()) else { return };
        pane.phase = Phase::Connecting("Resuming the conversation…".into());
        let agent_id = pane.agent_id.clone();
        let machine_id = pane.machine_id.clone();
        let close_key = self.keymap.hint("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane").unwrap_or_else(|| "C-b x".into());
        self.spawn(async move { link.rpc("agent_resume", json!({ "agentId": agent_id }), Duration::from_secs(120)).await }, move |app, reply| match reply {
            Ok(_) => { app.relist(&machine_id); app.open_stream(pane_id, true) }
            Err(error) => {
                if let Some(pane) = app.panes.get_mut(&pane_id) {
                    pane.phase = Phase::Card { title: "Could not resume".into(), detail: error.to_string(), keys: vec![("enter".into(), "try again".into()), (close_key, "close pane".into())] };
                }
            }
        });
    }

    pub fn send_input(&mut self, pane_id: u64, bytes: &[u8]) {
        let Some(pane) = self.panes.get_mut(&pane_id) else { return };
        let Some(stream) = pane.stream else { return };
        // select-pane -d: input to this pane is off until select-pane -e.
        if pane.read_only || pane.input_off || pane.dead.is_some() { return }
        let Some(link) = self.links.get(&pane.machine_id).and_then(|s| s.link.clone()) else { return };
        pane.scroll_bottom();
        if pane.input_at.is_none() { pane.input_at = Some(Instant::now()) }
        for chunk in bytes.chunks(8 * 1024) {
            link.send_binary(proto::encode(Kind::Input, stream, pane.input_seq, chunk));
            pane.input_seq += 1;
        }
    }

    pub fn send_paste(&mut self, pane_id: u64, text: &str) {
        let Some(pane) = self.panes.get(&pane_id) else { return };
        let Some(stream) = pane.stream else { return };
        if pane.input_off || pane.dead.is_some() { return }
        let Some(link) = self.links.get(&pane.machine_id).and_then(|s| s.link.clone()) else { return };
        link.send_binary(proto::encode(Kind::Paste, stream, 0, text.as_bytes()));
    }

    /// Resize every visible pane's far terminal to its tile. Called after any layout change.
    /// A session's windows given a size of their own (new-session -d -x -y, default-size).
    pub fn size_session(&mut self, id: u32, size: (u16, u16)) {
        let tabs = if id == self.session_id { &mut self.tabs } else { match self.sessions.iter_mut().find(|s| s.id == id) { Some(s) => &mut s.tabs, None => return } };
        for t in tabs.iter_mut() { t.size = Some(size) }
        self.fit_panes();
    }

    /// default-size: a window's size when no terminal gave it one (tmux's 80x24).
    pub fn default_size(&self) -> (u16, u16) {
        let v = self.options.get("default-size", "", None).unwrap_or_default();
        v.split_once('x').and_then(|(w, h)| Some((w.parse::<u16>().ok()?.max(1), h.parse::<u16>().ok()?.max(1)))).unwrap_or((80, 24))
    }

    /// Where a window's panes are laid out: the client's body, or (hn with no terminal) the
    /// window's own size from the top left.
    pub fn window_area(&self, tab: &Tab) -> Rect {
        // (A window not in front is as big as it was when last in front, or made.)
        let front = self.swap_back.is_none_or(|b| b == self.session_id) && self.tabs.get(self.active).map(|t| t.id == tab.id).unwrap_or(false);
        let manual = self.options.get("window-size", &tab.id, None).as_deref() == Some("manual");
        let creating = self.shell_inputs.contains_key(&tab.id) && tab.size.is_some();
        if !self.headless && self.swap_back.is_none_or(|b| b == self.session_id) && !manual && !creating && (front || tab.root.is_none()) { return self.body() }
        let (w, h) = tab.root.as_ref().map(|r| r.size()).unwrap_or_else(|| tab.size.unwrap_or(self.default_size()));
        Rect::new(0, if front && !self.headless { self.body().y } else { 0 }, w, h)
    }

    /// Windows no terminal shows — every window, with no terminal; a session in the background's
    /// that has a size of its own (new -d -x -y) — laid out at their own sizes, and their panes'
    /// terminals made that size, as tmux keeps a detached session's windows.
    fn fit_detached(&mut self) {
        let default = self.default_size();
        let headless = self.headless;
        let mut wants: Vec<(u64, (u16, u16))> = Vec::new();
        let mut size_of = |app: &App, tab: &mut Tab, own: bool| {
            if !own && tab.size.is_none() { return }
            let status = app.pane_status(tab);
            let size = tab.size.unwrap_or(default);
            tab.fit_layout(size, status);
            let Some(root) = tab.root.as_ref() else { return };
            let area = Rect::new(0, 0, size.0, size.1);
            let mut out = Vec::new();
            match tab.focus.filter(|_| tab.zoomed) { Some(f) => out.push((f, area)), None => root.rects(area, &mut out) }
            for (id, r) in out { let c = app.content_of(tab, r); wants.push((id, (c.width, c.height))) }
        };
        if headless {
            let mut tabs = std::mem::take(&mut self.tabs);
            for t in tabs.iter_mut() { size_of(self, t, true) }
            self.tabs = tabs;
        }
        let mut sessions = std::mem::take(&mut self.sessions);
        for s in sessions.iter_mut().filter(|s| s.mirror.is_none()) { for t in s.tabs.iter_mut() { size_of(self, t, headless) } }
        self.sessions = sessions;
        let mut idle = Vec::new();
        for (id, content) in wants {
            let Some(pane) = self.panes.get_mut(&id) else { continue };
            if headless && pane.stream.is_none() && !pane.opening && matches!(pane.phase, Phase::Connecting(_)) { idle.push(id) }
            let want = pane::stream_size(content.0, content.1);
            if pane.want == want { continue }
            pane.want = want;
            let Some(stream) = pane.stream else { continue };
            if pane.read_only { continue }
            pane.resize_seq += 1;
            let seq = pane.resize_seq;
            if let Some(link) = self.links.get(&pane.machine_id).and_then(|s| s.link.clone()) {
                link.send("terminal_resize", json!({ "streamId": stream.to_string(), "resizeSeq": seq, "cols": want.0, "rows": want.1 }));
            }
        }
        for id in idle { self.open_stream(id, false) }
    }

    pub fn fit_panes(&mut self) {
        self.fit_detached();
        if self.headless { self.rects = self.compute_rects(); return }
        // Every window's cells follow the client's size (tmux resizes its windows to it), with the
        // title rows counted when the window shows them.
        let body = self.body();
        let onscreen = self.swap_back.is_none_or(|b| b == self.session_id);
        if onscreen { crate::ipc::publish_size((body.width, body.height)) }
        let mut resized = Vec::new();
        for i in 0..self.tabs.len() {
            let status = self.pane_status(&self.tabs[i]);
            let manual = self.options.get("window-size", &self.tabs[i].id, None).as_deref() == Some("manual");
            let creating = self.tabs[i].root.is_none() || self.shell_inputs.contains_key(&self.tabs[i].id);
            let size = if manual { self.tabs[i].size.or_else(|| self.tabs[i].root.as_ref().map(|r| r.size())) }
                else if creating && self.tabs[i].size.is_some() { self.tabs[i].size }
                else { self.tabs[i].size = None; (onscreen && i == self.active).then_some((body.width, body.height)) };
            if let Some(size) = size {
                if self.tabs[i].fit_layout(size, status) { resized.push(i) }
            } else if let Some(root) = self.tabs[i].root.as_mut() { root.status = status; }
        }
        for i in resized {
            let id = self.tabs[i].id.clone();
            if !self.pending_resize_hooks.contains(&id) { self.pending_resize_hooks.push(id) }
        }
        self.rects = self.compute_rects();
        let visible: Vec<(u64, Rect)> = self.rects.clone();
        // A tile comes on screen without a stream (a desk tab never visited): open it as a watcher —
        // whoever has the keyboard elsewhere keeps it until someone types here.
        let idle: Vec<u64> = visible.iter().map(|(id, _)| *id).filter(|id| self.panes.get(id).map(|p| p.stream.is_none() && !p.opening && matches!(p.phase, Phase::Connecting(_))).unwrap_or(false)).collect();
        for (id, rect) in visible {
            let content = self.content_of(self.tab(), rect);
            let content = (content.width, content.height);
            if self.panes.get(&id).map(|p| !p.modes.is_empty()).unwrap_or(false) { crate::copy::fit(self, id, content.0 as u32, content.1 as u32) }
            let Some(pane) = self.panes.get_mut(&id) else { continue };
            pane.dirty = true;
            let want = pane::stream_size(content.0, content.1);
            if pane.want == want { continue }
            pane.want = want;
            let Some(stream) = pane.stream else { continue };
            if pane.read_only { continue }
            pane.resize_seq += 1;
            let seq = pane.resize_seq;
            if let Some(link) = self.links.get(&pane.machine_id).and_then(|s| s.link.clone()) {
                link.send("terminal_resize", json!({ "streamId": stream.to_string(), "resizeSeq": seq, "cols": want.0, "rows": want.1 }));
            }
        }
        for id in idle { self.open_stream(id, false) }
        self.report_focus();
    }

    /// Tell the daemon which harness is in front of the person: its terminal gets the short (2ms)
    /// output window instead of 8ms. Local machine only — a relayed machine keeps its own.
    fn report_focus(&mut self) {
        // A headless client is in front of nobody.
        if self.headless { return }
        // The dial's ring before its focus: a focus the ring does not hold yet is dropped.
        crate::dial::announce(self, false);
        let Some(id) = self.focused() else { return };
        let Some(pane) = self.panes.get(&id) else { return };
        let key = (pane.machine_id.clone(), pane.agent_id.clone());
        if self.last_focus_sent.as_ref() == Some(&key) { return }
        if let Some(link) = self.link(&pane.machine_id) {
            if link.send("app_focus", json!({ "agentId": pane.agent_id })) { self.last_focus_sent = Some(key) }
        }
    }

    /// Say the active pane again, as when this terminal comes back to the front.
    pub fn announce_focus(&mut self) {
        self.last_focus_sent = None;
        self.report_focus();
    }

    // ── tabs & panes ─────────────────────────────────────────────────────────

    pub fn tab(&self) -> &Tab { &self.tabs[self.active] }

    /// The command a shell ran is done: what it printed, its errors and its exit status go back —
    /// or, for split-window/new-window -P, once the new pane is there.
    pub fn finish_cli(&mut self) {
        self.cli_size = None;
        let out = self.capture.take().unwrap_or_default();
        let err = self.capture_err.take().unwrap_or_default();
        let Some(tx) = self.cli_tx.take() else { return };
        if self.print_new.is_some() && err.is_empty() { self.held_reply = Some(tx); return }
        self.print_new = None;
        let code = if self.cli_code != 0 { self.cli_code } else if err.is_empty() { 0 } else { 1 };
        if std::mem::take(&mut self.wait_cli) && self.waiting_open() { self.waiting_reply = Some((tx, (out, err, code))); return }
        let _ = tx.send((out, err, code));
        // The shell's client gone (server_client_lost): an unattached session with
        // destroy-unattached goes now.
        crate::commands::destroy_unattached(self, false);
    }

    fn waiting_open(&self) -> bool { matches!(self.modal, Some(Modal::Menu(_)) | Some(Modal::Prompt(_)) | Some(Modal::Confirm { .. }) | Some(Modal::DisplayPanes { .. })) }

    /// The menu or prompt a shell's command opened has closed: the shell has its answer.
    /// A command from a shell: run now — or, when it opens a shell (new, neww, splitw, a popup,
    /// respawn) and this client's machine is not connected yet (it has only just started: `hn
    /// new -d` starting the server), once it is, or 5s on; the commands after it wait behind it.
    pub fn run_cli(&mut self, words: &[String], job: Box<dyn FnOnce(&mut App) + Send>) {
        let opens_shell = words.iter().any(|w| matches!(crate::cmd::find(w).map(|e| e.name), Ok("new-session" | "new-window" | "split-window" | "respawn-pane" | "respawn-window" | "display-popup")));
        // list-harnesses from a client just started (hn with no terminal, for a script): once
        // every machine's harnesses are known, so it says what each one is doing.
        let asks_fleet = matches!(words.first().map(String::as_str), Some("open-viewer" | "view" | "list-harnesses" | "lsh" | "answer-harness" | "answer" | "open-harness" | "openh" | "send-message" | "restart-harness" | "restarth" | "pause-harness" | "resume-harness" | "clone-harness" | "rename-harness"));
        self.last_cli = Instant::now();
        if !self.cli_held.is_empty() || (opens_shell && !self.cli_ready()) || (asks_fleet && !self.fleet_ready()) { self.cli_held.push_back(job); return }
        job(self)
    }

    fn cli_ready(&self) -> bool { self.link(&self.fleet.local_id).is_some() || self.started.elapsed() > Duration::from_secs(5) }

    /// Every connected machine's harnesses listed and read against seen.json (a moment for their
    /// lines to come), or 6s on.
    fn fleet_ready(&self) -> bool {
        let listed = !self.fleet.local_id.is_empty() && self.seen_rostered.contains(&self.fleet.local_id)
            && self.fleet.machines.iter().filter(|m| m.usable()).all(|m| self.seen_rostered.contains(&m.id));
        (listed && self.started.elapsed() > Duration::from_millis(1500)) || self.started.elapsed() > Duration::from_secs(6)
    }

    /// The commands held for the connection, run once it is up (one at a time: one still waiting
    /// on a job holds the rest).
    pub fn release_cli(&mut self) {
        while self.capture.is_none() && !self.cli_held.is_empty() && self.cli_ready() && (self.fleet_ready() || !self.headless) {
            if let Some(job) = self.cli_held.pop_front() { job(self) }
        }
    }

    pub fn release_waiting(&mut self) {
        if self.waiting_reply.is_some() && !self.waiting_open() {
            if let Some((tx, reply)) = self.waiting_reply.take() { let _ = tx.send(reply); }
        }
    }

    /// Data printed as it is (show-buffer): to a shell exactly, its last line without a newline
    /// when it has none; else shown as print shows lines.
    pub fn print_data(&mut self, title: &str, data: &str) {
        let mut lines: Vec<String> = data.split('\n').map(str::to_string).collect();
        if data.ends_with('\n') { lines.pop(); } else if self.capture.is_some() { if let Some(l) = lines.last_mut() { l.push(BARE) } }
        self.print(title, lines)
    }

    /// What a command prints: to the shell that asked (hn <command>), else into the current pane's
    /// view mode as tmux shows it (server_client_print) — with no pane (a window with no harness
    /// yet), a message or a list.
    pub fn print(&mut self, title: &str, lines: Vec<String>) {
        if let Some(out) = self.capture.as_mut() { out.extend(lines); return }
        if lines.is_empty() || crate::copy::print(self, &lines, false) { return }
        if lines.len() <= 1 { self.say(lines.into_iter().next().unwrap_or_default(), crate::theme::WARN) }
        else { crate::input::picker(self, crate::modal::PickerKind::Output { title: title.to_string(), lines }, title, "") }
    }

    /// Ask the pane's machine what its tmux pane runs and where (terminal_info) — for this
    /// machine's panes; a daemon that predates it, or a peer, just leaves the fallbacks.
    pub fn refresh_pane_info(&mut self, pane_id: u64) {
        let Some(p) = self.panes.get(&pane_id) else { return };
        // (No terminal open here for it is fine: the daemon's tmux knows what runs in it — a
        // window not on screen is named from it too, as tmux names every window.)
        if p.machine_id != self.fleet.local_id && !crate::local::is_local(&p.machine_id) { return }
        let (machine, agent) = (p.machine_id.clone(), p.agent_id.clone());
        let Some(link) = self.link(&machine) else { return };
        self.spawn(async move { link.rpc("terminal_info", json!({ "agentId": agent }), Duration::from_secs(3)).await }, move |app, reply| {
            let Ok(info) = reply else { return };
            if info.get("error").is_some() { return }
            let Some(p) = app.panes.get_mut(&pane_id) else { return };
            let text = |k: &str| info.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
            p.fg_command = text("command");
            if info.get("startCommand").is_some() { p.start_command = text("startCommand"); }
            p.live_path = text("path");
            p.remote_pid = info.get("pid").and_then(Value::as_u64);
            p.remote_tty = text("tty");
            // automatic-rename follows what runs, at once.
            app.sync_titles();
        });
    }

    /// Close the popup and end its shell.
    pub fn close_popup(&mut self) {
        let Some(crate::modal::Modal::Popup { pane, .. }) = self.modal.take() else { return };
        let key = self.panes.get(&pane).map(|p| (p.machine_id.clone(), p.agent_id.clone()));
        self.drop_pane(pane);
        if let Some((m, a)) = key {
            self.shells.remove(&(m.clone(), a.clone()));
            if let Some(link) = self.link(&m) { self.spawn(async move { link.rpc("agent_delete", json!({ "agentId": a }), Duration::from_secs(30)).await }, |_, _| {}) }
        }
        self.redraw_all = true;
    }

    /// What a tmux.conf (or `set`, `source-file`) said, over what is set now.
    pub fn apply_settings(&mut self, s: &crate::tmuxconf::Settings) {
        if let Some(m) = s.mouse { self.mouse = m; self.mouse_changed = true }
        if let Some(t) = s.status_top { self.status_top = t; self.fit_panes() }
        if let Some(ms) = s.display_ms { self.display_ms = if ms == 0 { 0 } else { ms.max(300) } }
        if let Some(ms) = s.display_panes_ms { self.display_panes_ms = ms }
        let (l, n) = (&mut self.look, &s.look);
        for (to, from) in [(&mut l.status_bg, n.status_bg), (&mut l.status_fg, n.status_fg), (&mut l.message_bg, n.message_bg), (&mut l.message_fg, n.message_fg),
            (&mut l.active_border, n.active_border), (&mut l.border, n.border), (&mut l.window_fg, n.window_fg), (&mut l.window_bg, n.window_bg),
            (&mut l.active_window_fg, n.active_window_fg), (&mut l.active_window_bg, n.active_window_bg)] {
            if from.is_some() { *to = from }
        }
        for (k, v) in &s.options.user { self.opts.user.insert(k.clone(), v.clone()); }
        // What tmux.conf set, into the options as tmux keeps them.
        let (to, from) = (&mut self.options, &s.options.store);
        for (a, b) in [(&mut to.server, &from.server), (&mut to.global_session, &from.global_session), (&mut to.global_window, &from.global_window), (&mut to.session, &from.session)] {
            for (k, v) in b { a.insert(k.clone(), v.clone()); }
        }
        let (o, n) = (&mut self.opts, &s.options);
        macro_rules! take { ($($f:ident),*) => { $( if n.$f.is_some() { o.$f = n.$f.clone() } )* } }
        take!(status_left, status_right, status_left_length, status_right_length, window_status_format, window_status_current_format,
            window_status_current_style, window_status_separator, renumber_windows, border_titles, mode_keys_emacs, status, status_justify, window_status_style, pane_border_format, main_pane_width, main_pane_height, copy_command, status_keys_vi);
        self.fit_panes();
        self.redraw_all = true;
    }

    /// swap-window: the two windows trade places and indexes; this one stays current.
    pub fn swap_tabs(&mut self, a: usize, b: usize) {
        if a == b || b >= self.tabs.len() { return }
        self.renumber();
        let (ia, ib) = (self.tabs[a].id.clone(), self.tabs[b].id.clone());
        let (na, nb) = (self.win_num(a), self.win_num(b));
        self.nums.insert(ia.clone(), nb);
        self.nums.insert(ib.clone(), na);
        let (lo, hi) = (a.min(b), a.max(b));
        self.active = lo;
        while self.active < hi { self.move_tab(1) }
        self.active = hi - 1;
        while self.active > lo { self.move_tab(-1) }
        self.active = self.tabs.iter().position(|t| t.id == ia).unwrap_or(self.active);
        self.fit_panes();
    }

    /// tmux's #S: the session alias, or this computer's name by default.
    pub fn session_name(&self) -> String {
        if let Some(a) = &self.session_alias { return a.clone() }
        self.machine_session_name()
    }

    /// The desk's session, named as this computer is.
    fn machine_session_name(&self) -> String {
        // (Before the daemon has said which it is, this computer as the fleet was last seen:
        // `hn attach -t studio` finds the desk's session at once.)
        self.fleet.local_machine_name()
    }

    fn stash_name(&self, s: &Stash) -> String { s.alias.clone().unwrap_or_else(|| self.machine_session_name()) }

    // ── sessions ────────────────────────────────────────────────────────────────

    fn stash_current(&mut self) -> Stash {
        self.sync_links();
        let activity = self.session_activity;
        Stash {
            id: self.session_id, used: self.session_used, mirror: self.mirror.take(), alias: self.session_alias.take(), desk: self.session_desk,
            tabs: std::mem::take(&mut self.tabs), active: self.active, lastw: std::mem::take(&mut self.lastw), nums: std::mem::take(&mut self.nums),
            created: self.session_created, activity, last_attached: self.session_last_attached, options: std::mem::take(&mut self.options.session), env: std::mem::take(&mut self.session_env),
            path: self.session_path.take(),
            group: self.session_group.take(),
        }
    }

    fn unstash(&mut self, s: Stash) {
        self.session_id = s.id;
        self.session_used = s.used;
        self.mirror = s.mirror;
        self.session_alias = s.alias;
        self.session_desk = s.desk;
        self.tabs = s.tabs;
        if self.tabs.is_empty() { self.tabs.push(Tab::home()) }
        self.active = s.active.min(self.tabs.len() - 1);
        self.lastw = s.lastw;
        self.nums = s.nums;
        self.session_created = s.created;
        self.session_activity = s.activity;
        self.session_last_attached = s.last_attached;
        self.options.session = s.options;
        self.session_env = s.env;
        self.session_path = s.path;
        self.session_group = s.group;
    }

    /// Session [id] in front, as it is, with nothing else done (a command that names it runs
    /// there); false if there is none. One no client has (its client detached) is this client's
    /// from now on.
    pub fn swap_session(&mut self, id: u32) -> bool {
        if id == self.session_id { return true }
        if !self.sessions.iter().any(|s| s.id == id) && !self.take_session(id, false) { return false }
        // (The one coming in front brought up to date with this one's windows first.)
        self.sync_links();
        let Some(i) = self.sessions.iter().position(|s| s.id == id) else { return false };
        let next = self.sessions.remove(i);
        let cur = self.stash_current();
        self.sessions.push(cur);
        self.unstash(next);
        true
    }

    /// switch-client (server_client_set_session): the client shows session [id] at its current
    /// window, whose alerts are seen; the one it leaves is its last session. Another client's is
    /// given up by that client first.
    pub fn switch_session(&mut self, id: u32) { self.switch_session_as(id, Attach::Share) }

    /// switch_session, to a session another client has: shown here as it has it (tmux's second
    /// client of a session), only watched, or taken (that client detaching, as attach -d does).
    pub fn switch_session_as(&mut self, id: u32, how: Attach) {
        if id == self.session_id { return }
        if !self.sessions.iter().any(|s| s.id == id) {
            let shown = how != Attach::Take && crate::mirror::show(self, id, how == Attach::Watch);
            if !shown && !self.take_session(id, true) { return }
        }
        let from = self.session_id;
        // The session the client leaves was in use until now (session_update_activity).
        let used = std::mem::replace(&mut self.session_activity, epoch_secs());
        let mirrored = self.sessions.iter().any(|s| s.id == id && s.mirror.is_some());
        if !self.swap_session(id) { self.session_activity = used; return }
        // (Another terminal's session: its hooks' snapshot is the owner's, so this client says it.)
        if mirrored && self.hooks_seen.ready { crate::commands::notify(self, "client-session-changed", Some(self.active), None) }
        // attach-session and switch-client: update-environment's variables from this client.
        self.update_environment();
        // …and the one it goes to is in use from now, and attached now (server_client_set_session).
        self.session_activity = epoch_secs();
        // (Not by hn with no terminal: no client is attached there.)
        if !self.headless { self.session_last_attached = epoch_secs() }
        self.session_used = use_order();
        self.last_session = Some(from);
        // A session left with no window (the one a client started in, before its shell came):
        // gone, as tmux has no session without a window.
        if let Some(i) = self.sessions.iter().position(|s| s.id == from && !s.desk && s.tabs.iter().all(|t| t.root.is_none())) {
            self.sessions.remove(i);
            self.last_session = None;
        }
        // Another client's session left: this client no longer shows it (the owner has it).
        if let Some(i) = self.sessions.iter().position(|s| s.id == from && s.mirror.is_some()) {
            let s = self.sessions.remove(i);
            crate::mirror::drop_stash(self, s);
        }
        // server_check_unattached: the sessions no client shows now, with destroy-unattached, go.
        crate::commands::destroy_unattached(self, false);
        let a = self.active;
        self.tabs[a].alerts = 0;
        if let Some(f) = self.tabs[a].focus { self.seen(f) }
        self.home_order.borrow_mut().clear();
        self.fit_panes();
        self.redraw_all = true;
        self.save_sessions();
    }

    /// The session a client starts in: the desk's (every client's, one id among them), else none
    /// yet — tmux has no session before its first. It is numbered when it is kept (load_sessions),
    /// and never when the client goes to another session instead (attach -t).
    pub fn first_session(&mut self) {
        self.session_id = if self.session_desk { crate::ids::desk(crate::ids::Kind::Session, "desk") as u32 } else { UNNUMBERED };
        self.first_session = self.session_id;
    }

    /// A new session id (`$N`), as tmux's next_session_id++: never given twice among the clients
    /// of this server name.
    pub fn alloc_session_id(&self) -> u32 { crate::ids::next(crate::ids::Kind::Session) as u32 }

    /// The id this client gives a session it does not have (the same each time it is asked).
    fn remote_id(&self, name: &str) -> u32 {
        if let Some(id) = self.remote.borrow().ids.get(name) { return *id }
        let id = self.alloc_session_id();
        self.remote.borrow_mut().ids.insert(name.to_string(), id);
        id
    }

    /// One of this client's own sessions, by its exact name.
    pub fn own_session(&self, name: &str) -> Option<u32> {
        if self.session_name() == name { return Some(self.session_id) }
        self.sessions.iter().find(|s| self.stash_name(s) == name).map(|s| s.id)
    }

    /// The sessions this client does not have — other clients' and those no client has — as the
    /// sessions file says: read again when it changes, and its clients asked after again when
    /// that is two seconds old.
    pub fn remote_rows(&self) -> Vec<RemoteSession> {
        let path = Self::sessions_path();
        let stamp = std::fs::metadata(&path).ok().map(|m| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len()));
        let stale = {
            let r = self.remote.borrow();
            r.stamp != stamp || stamp.is_none() || r.read_at.map(|t| t.elapsed() > Duration::from_secs(2)).unwrap_or(true)
        };
        if stale {
            let me = crate::ipc::here().map(|p| p.display().to_string());
            let doc = read_sessions(&path);
            let mut rows = Vec::new();
            for row in doc["sessions"].as_array().cloned().unwrap_or_default() {
                if row.get("desk").and_then(Value::as_bool).unwrap_or(false) { continue }
                let Some(name) = row.get("name").and_then(Value::as_str).map(str::to_string) else { continue };
                if me.is_some() && row.get("owner").and_then(Value::as_str) == me.as_deref() { continue }
                let owner = live_owner(&row);
                let windows = row.get("windows").and_then(Value::as_array).map(|ws| ws.iter().map(|w| (
                    w.get("num").and_then(Value::as_u64).unwrap_or(0) as usize,
                    w.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                    w.get("panes").and_then(Value::as_array).map(|p| p.len()).unwrap_or(0),
                )).collect()).unwrap_or_default();
                let created = row.get("created").and_then(Value::as_i64).unwrap_or(0);
                let id = row.get("id").and_then(Value::as_u64).map(|i| i as u32).unwrap_or_else(|| self.remote_id(&name));
                let wins = row.get("windows").and_then(Value::as_array).cloned().unwrap_or_default();
                let wids = wins.iter().filter_map(|w| w.get("wid").and_then(Value::as_u64)).collect();
                let active_panes = wins.iter().map(|w| { let f = w.get("focus").and_then(Value::as_u64).unwrap_or(0) as usize; w.get("panes").and_then(Value::as_array).and_then(|p| p.get(f)).and_then(|p| p.get(3)).and_then(Value::as_u64).unwrap_or(0) }).collect();
                let pane_ids = wins.iter().flat_map(|w| w.get("panes").and_then(Value::as_array).cloned().unwrap_or_default()).filter_map(|p| p.get(3).and_then(Value::as_u64)).collect();
                let front = owner.is_some() && row.get("front").and_then(Value::as_bool).unwrap_or(false);
                let attached = front as u32 + if owner.is_some() { row.get("mirrors").and_then(Value::as_u64).unwrap_or(0) as u32 } else { 0 };
                rows.push(RemoteSession {
                    id, wids, pane_ids, active_panes, attached, last: row.get("last").and_then(Value::as_array).and_then(|l| l.first()).and_then(Value::as_u64).map(|n| n as usize), owner: owner.clone(), name, created, group: row.get("group").and_then(Value::as_str).map(str::to_string),
                    stack: std::iter::once(row.get("active").and_then(Value::as_u64).unwrap_or(0) as usize).chain(row.get("last").and_then(Value::as_array).into_iter().flatten().filter_map(|n| n.as_u64().map(|n| n as usize))).filter_map(|i| wins.get(i).and_then(|w| w.get("num")).and_then(Value::as_u64).map(|n| n as usize)).collect(),
                    window_flags: wins.iter().enumerate().map(|(i, win)| {
                        let mut flags = String::new();
                        let alerts = win.get("alerts").and_then(Value::as_u64).unwrap_or(0) as u8;
                        for (bit, flag) in [(ACTIVITY, '#'), (BELL, '!'), (SILENCE, '~')] { if alerts & bit != 0 { flags.push(flag) } }
                        if row.get("active").and_then(Value::as_u64) == Some(i as u64) { flags.push('*') }
                        else if row.get("last").and_then(Value::as_array).and_then(|l| l.first()).and_then(Value::as_u64) == Some(i as u64) { flags.push('-') }
                        if win.get("zoomed").and_then(Value::as_bool).unwrap_or(false) { flags.push('Z') }
                        flags
                    }).collect(),
                    alerts: row.get("alerts").and_then(Value::as_str).unwrap_or_default().to_string(),
                    attached_clients: if owner.is_some() { serde_json::from_value(row.get("attached_clients").cloned().unwrap_or(Value::Null)).unwrap_or_default() } else { Vec::new() },
                    path: row.get("path").and_then(Value::as_str).map(str::to_string),
                    activity: row.get("activity").and_then(Value::as_i64).unwrap_or(created), last_attached: row.get("last_attached").and_then(Value::as_i64).unwrap_or(0), active: row.get("active").and_then(Value::as_u64).unwrap_or(0) as usize, windows,
                });
            }
            let mut r = self.remote.borrow_mut();
            r.rows = rows;
            r.stamp = stamp;
            r.read_at = Some(Instant::now());
        }
        let mine: Vec<String> = std::iter::once(self.session_name()).chain(self.sessions.iter().map(|s| self.stash_name(s))).collect();
        self.remote.borrow().rows.iter().filter(|s| !mine.contains(&s.name)).cloned().collect()
    }

    /// The client that has session [id], when another client has it: the socket it listens on.
    pub fn remote_owner(&self, id: u32) -> Option<String> {
        if id == self.session_id { return self.mirror.as_ref().map(|m| m.owner.clone()) }
        if let Some(s) = self.sessions.iter().find(|s| s.id == id) { return s.mirror.as_ref().map(|m| m.owner.clone()) }
        self.remote_rows().into_iter().find(|r| r.id == id).and_then(|r| r.owner)
    }

    /// A session this client does not have, made its own, as the file has it. One another client
    /// has ([from_client]) is given up by that client first — which detaches, as `attach -d`
    /// detaches a session's other clients, when it is the session it shows.
    pub fn take_session(&mut self, id: u32, from_client: bool) -> bool {
        let Some(r) = self.remote_rows().into_iter().find(|r| r.id == id) else { return false };
        if let Some(owner) = &r.owner {
            if !from_client { return false }
            let given = crate::ipc::ask(std::path::Path::new(owner), &["hn-release-session".into(), "-t".into(), r.name.clone()]);
            if !matches!(given, Some((_, _, 0))) { self.error(format!("session {} is another client's", r.name)); return false }
        }
        // Read and claimed while the file is held: two clients never both take it.
        let path = Self::sessions_path();
        let lock = crate::ipc::lock(&path);
        let doc = read_sessions(&path);
        let row = doc["sessions"].as_array().and_then(|rows| rows.iter().find(|row| row.get("name").and_then(Value::as_str) == Some(r.name.as_str())
            && !row.get("desk").and_then(Value::as_bool).unwrap_or(false) && live_owner(row).is_none()).cloned());
        let Some(stash) = row.and_then(|row| self.stash_from_row(&row, id)) else { drop(lock); self.error(format!("can't find session: {}", r.name)); return false };
        self.sessions.push(stash);
        self.write_sessions_held(Save::Stay);
        drop(lock);
        // The counters past every id loaded (a sessions file older than them).
        let top_pane = self.sessions.iter().flat_map(|s| s.tabs.iter().flat_map(|t| t.panes())).max();
        let top_window = self.sessions.iter().flat_map(|s| s.tabs.iter().filter_map(|t| t.has_wid())).max();
        let top_session = self.sessions.iter().map(|s| s.id).max();
        if let Some(p) = top_pane { crate::ids::keep(crate::ids::Kind::Pane, p) }
        if let Some(w) = top_window { crate::ids::keep(crate::ids::Kind::Window, w) }
        if let Some(s) = top_session { crate::ids::keep(crate::ids::Kind::Session, s as u64) }
        self.remote.borrow_mut().stamp = None;
        true
    }

    /// hn-release-session: session [name] given up to the client that asked (it goes there). The
    /// session this client shows: it detaches, every session it had left for the next client, as
    /// tmux's `attach -d` detaches the others.
    pub fn release_session(&mut self, name: &str) -> Result<(), String> {
        // attach -d detaches every other client of the session: those showing it as this one
        // has it too (before they could take it as this one leaves).
        let id = if self.session_name() == name { Some(self.session_id) } else { self.sessions.iter().find(|s| self.stash_name(s) == name).map(|s| s.id) };
        if let Some(id) = id {
            let theirs: Vec<String> = self.mirrors.iter().filter(|(_, s)| **s == id).map(|(m, _)| m.clone()).collect();
            for m in theirs { self.mirrors.remove(&m); crate::ipc::notify_now(std::path::Path::new(&m), &["detach-client".into()]) }
        }
        if !self.session_desk && self.session_name() == name {
            self.write_sessions(Save::Leave);
            self.handed_over = true;
            self.quit = true;
            return Ok(())
        }
        let Some(i) = self.sessions.iter().position(|s| !s.desk && self.stash_name(s) == name) else { return Err(format!("can't find session: {name}")) };
        let id = self.sessions[i].id;
        self.write_sessions(Save::Release(id));
        let gone = self.sessions.remove(i);
        for t in &gone.tabs { for p in t.panes() { self.forget_pane(p) } }
        let mut r = self.remote.borrow_mut();
        r.ids.insert(name.to_string(), id);
        r.stamp = None;
        Ok(())
    }

    /// The attached terminals of a session, whether it is owned here or by another client.
    pub fn session_attached(&self, id: u32) -> usize {
        if self.remote_owner(id).is_some() {
            if let Some(r) = self.remote_rows().into_iter().find(|r| r.id == id) { return r.attached as usize }
            if let Some(row) = crate::mirror::row_of(id, "") {
                return row.get("front").and_then(Value::as_bool).unwrap_or(false) as usize + row.get("mirrors").and_then(Value::as_u64).unwrap_or(0) as usize
            }
        }
        let shown = self.swap_back.unwrap_or(self.session_id);
        (id == shown && !self.headless) as usize + self.mirrors.values().filter(|s| **s == id).count()
    }

    fn session_clients(&self, id: u32) -> Vec<(u64, String)> {
        if self.remote_owner(id).is_some() {
            if let Some(r) = self.remote_rows().into_iter().find(|r| r.id == id) { return r.attached_clients }
            if let Some(row) = crate::mirror::row_of(id, "") {
                return serde_json::from_value(row.get("attached_clients").cloned().unwrap_or(Value::Null)).unwrap_or_default()
            }
        }
        // tmux lists clients in creation order, even when they moved between group members.
        let created = |socket: &std::path::Path| std::fs::metadata(socket).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0);
        let mut clients = Vec::new();
        if self.swap_back.unwrap_or(self.session_id) == id && !self.headless { clients.push((crate::ipc::here().map(|s| created(&s)).unwrap_or(0), tty_name())) }
        clients.extend(self.mirrors.iter().filter(|(_, s)| **s == id).filter_map(|(socket, _)| self.mirror_ttys.get(socket).map(|tty| (created(std::path::Path::new(socket)), tty.clone()))));
        clients.sort_by_key(|c| c.0);
        clients
    }

    pub fn session_attached_ttys(&self, id: u32) -> Vec<String> { self.session_clients(id).into_iter().map(|(_, tty)| tty).collect() }

    /// Group formats use the named session's group, including groups another terminal owns.
    pub fn session_group_value(&self, id: u32, key: &str) -> Option<String> {
        if !key.starts_with("session_group") { return None }
        let group = self.group_of(id);
        if key == "session_grouped" { return Some((group.is_some() as u8).to_string()) }
        let Some(group) = group else { return Some(String::new()) };
        let members = self.group_sessions(&group);
        Some(match key {
            "session_group" => group,
            "session_group_size" => members.len().to_string(),
            "session_group_list" => members.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(","),
            "session_group_attached" => members.iter().map(|(id, _)| self.session_attached(*id)).sum::<usize>().to_string(),
            "session_group_many_attached" => ((members.iter().map(|(id, _)| self.session_attached(*id)).sum::<usize>() > 1) as u8).to_string(),
            "session_group_attached_list" => {
                let mut clients: Vec<_> = members.iter().flat_map(|(id, _)| self.session_clients(*id)).collect();
                clients.sort_by_key(|c| c.0);
                clients.into_iter().map(|(_, tty)| tty).collect::<Vec<_>>().join(",")
            },
            _ => return None,
        })
    }

    pub fn session_alerts(&self, id: u32) -> String {
        let (tabs, nums, active) = if id == self.session_id { (&self.tabs, &self.nums, self.active) }
            else if let Some(s) = self.sessions.iter().find(|s| s.id == id) { (&s.tabs, &s.nums, s.active) }
            else { return self.remote_rows().into_iter().find(|r| r.id == id).map(|r| r.alerts).unwrap_or_default() };
        tabs.iter().enumerate().filter_map(|(i, t)| {
            let flags = crate::format::alert_flags(self, t, i == active);
            (!flags.is_empty()).then(|| format!("{}{flags}", nums.get(&t.id).copied().unwrap_or(i)))
        }).collect::<Vec<_>>().join(",")
    }

    /// A session's own formats, for a session not in front (a #{S:} loop's, list-sessions').
    pub fn stash_value(&self, id: u32, key: &str) -> Option<String> {
        if let Some(value) = self.session_group_value(id, key) { return Some(value) }
        if key == "session_attached" { return Some(self.session_attached(id).to_string()) }
        if key == "session_many_attached" { return Some(((self.session_attached(id) > 1) as u8).to_string()) }
        if key == "session_attached_list" { return Some(self.session_attached_ttys(id).join(",")) }
        if key == "session_alerts" { return Some(self.session_alerts(id)) }
        let Some(s) = self.sessions.iter().find(|s| s.id == id) else {
            let r = self.remote_rows().into_iter().find(|r| r.id == id)?;
            return Some(match key {
                "session_name" => r.name.clone(),
                "session_id" => format!("${}", r.id),
                "session_windows" => r.windows.len().to_string(),
                "session_marked" => (self.marked.is_some() && self.marked_session == Some(id)).then_some("1").unwrap_or("0").into(),
                "session_stack" => r.stack.iter().map(usize::to_string).collect::<Vec<_>>().join(","),
                "session_path" => r.path.unwrap_or_default(),
                "session_created" => r.created.to_string(),
                "session_last_attached" => if r.last_attached > 0 { r.last_attached.to_string() } else { String::new() },
                "session_activity" => r.activity.to_string(),
                "window_index" => r.windows.get(r.active).map(|w| w.0.to_string()).unwrap_or_default(),
                "window_name" => r.windows.get(r.active).map(|w| w.1.clone()).unwrap_or_default(),
                _ => return None,
            })
        };
        Some(match key {
            "session_name" => self.stash_name(s),
            "session_id" => format!("${}", s.id),
            "session_windows" => s.tabs.len().to_string(),
            "session_marked" => (self.marked.is_some() && self.marked_session == Some(id)).then_some("1").unwrap_or("0").into(),
            "session_stack" => std::iter::once(s.active).chain(s.lastw.iter().filter_map(|id| s.tabs.iter().position(|t| &t.id == id))).filter_map(|i| s.tabs.get(i).map(|t| s.nums.get(&t.id).copied().unwrap_or(i).to_string())).collect::<Vec<_>>().join(","),
            "session_path" => s.path.clone().unwrap_or_default(),
            "session_created" => s.created.to_string(),
            "session_last_attached" => if s.last_attached > 0 { s.last_attached.to_string() } else { String::new() },
            "session_activity" => s.activity.to_string(),
            "window_index" => s.tabs.get(s.active).and_then(|t| s.nums.get(&t.id)).map(|n| n.to_string()).unwrap_or_default(),
            "window_name" => s.tabs.get(s.active).map(|t| t.name.clone()).unwrap_or_default(),
            _ => return None,
        })
    }

    /// Sessions and clients whose current window is this shared window.
    pub fn active_window_value(&self, wid: u64, key: &str) -> String {
        let mut sessions: Vec<(u32, String)> = self.session_list().into_iter().filter(|(id, _)| {
            let active = if *id == self.session_id { self.tabs.get(self.active).map(|t| t.wid()) }
                else if let Some(s) = self.sessions.iter().find(|s| s.id == *id) { s.tabs.get(s.active).map(|t| t.wid()) }
                else { self.remote_rows().into_iter().find(|r| r.id == *id).and_then(|r| r.wids.get(r.active).copied()) };
            active == Some(wid)
        }).collect();
        sessions.sort_by_key(|(id, _)| *id);
        if key == "window_active_sessions" { return sessions.len().to_string() }
        if key == "window_active_sessions_list" { return sessions.into_iter().map(|(_, n)| n).collect::<Vec<_>>().join(",") }
        let mut clients: Vec<_> = sessions.into_iter().flat_map(|(id, _)| self.session_clients(id)).collect();
        clients.sort_by_key(|(created, _)| *created);
        clients.dedup();
        if key == "window_active_clients" { clients.len().to_string() } else { clients.into_iter().map(|(_, tty)| tty).collect::<Vec<_>>().join(",") }
    }

    /// A window of a session not in front ([k]th of session_windows), for a #{W:} loop inside a
    /// #{S:} one: its index, name, pane count and whether it is the session's current window.
    pub fn stash_window_value(&self, id: u32, k: usize, key: &str) -> Option<String> {
        let (num, name, panes) = self.session_windows(id).get(k).cloned()?;
        let current = if id == self.session_id { k == self.active } else { self.stash_value(id, "window_index") == Some(num.to_string()) };
        let flags = || {
            if id == self.session_id { return crate::format::flags(self, k) }
            if let Some(s) = self.sessions.iter().find(|s| s.id == id) {
                let Some(t) = s.tabs.get(k) else { return String::new() };
                let mut flags = crate::format::alert_flags(self, t, current);
                if current { flags.push('*') } else if s.lastw.first() == Some(&t.id) { flags.push('-') }
                if self.marked_session == Some(id) && self.marked.is_some_and(|p| t.panes().contains(&p)) { flags.push('M') }
                if t.zoomed { flags.push('Z') }
                return flags
            }
            self.remote_rows().into_iter().find(|r| r.id == id).and_then(|r| r.window_flags.get(k).cloned()).unwrap_or_default()
        };
        Some(match key {
            "window_index" => num.to_string(),
            "window_name" => name,
            "window_panes" => panes.to_string(),
            "window_active_sessions" | "window_active_sessions_list" | "window_active_clients" | "window_active_clients_list" => self.session_wids(id).get(k).map(|wid| self.active_window_value(*wid, key)).unwrap_or_default(),
            "window_active" => (current as u8).to_string(),
            "window_flags" => flags().replacen('#', "##", 1),
            "window_raw_flags" => flags(),
            "window_zoomed_flag" => flags().contains('Z').then_some("1").unwrap_or("0").into(),
            "window_activity_flag" => flags().contains('#').then_some("1").unwrap_or("0").into(),
            "window_bell_flag" => flags().contains('!').then_some("1").unwrap_or("0").into(),
            "window_silence_flag" => flags().contains('~').then_some("1").unwrap_or("0").into(),
            "window_marked_flag" => flags().contains('M').then_some("1").unwrap_or("0").into(),
            "window_id" => self.session_wids(id).get(k).map(|w| format!("@{w}")).unwrap_or_default(),
            "window_last_flag" => (self.session_last_window(id) == Some(k) && !current).then_some("1").unwrap_or("0").into(),
            _ => return None,
        })
    }

    /// The active pane of a session's [k]th window (session_windows' order), wherever it is kept.
    pub fn session_active_pane(&self, id: u32, k: usize) -> Option<u64> {
        if let Some((_, f, _)) = self.stash_panes(id, Some(k)) { return f }
        self.remote_rows().into_iter().find(|r| r.id == id).and_then(|r| r.active_panes.get(k).copied())
    }

    /// A session's windows' ids (@N), in session_windows' order.
    pub fn session_wids(&self, id: u32) -> Vec<u64> {
        let of = |tabs: &[Tab]| tabs.iter().filter(|t| t.root.is_some()).map(|t| t.wid()).collect();
        if id == self.session_id { return of(&self.tabs) }
        if let Some(s) = self.sessions.iter().find(|s| s.id == id) { return of(&s.tabs) }
        self.remote_rows().into_iter().find(|r| r.id == id).map(|r| r.wids).unwrap_or_default()
    }

    /// Which of a session's windows (session_windows' order) is its last one, where this client
    /// keeps it.
    fn session_last_window(&self, id: u32) -> Option<usize> {
        let (tabs, lastw) = if id == self.session_id { (&self.tabs, &self.lastw) } else {
            match self.sessions.iter().find(|s| s.id == id) { Some(s) => (&s.tabs, &s.lastw), None => return self.remote_rows().into_iter().find(|r| r.id == id).and_then(|r| r.last) }
        };
        let last = lastw.iter().find(|id| tabs.iter().any(|t| &t.id == *id && t.root.is_some()))?;
        tabs.iter().filter(|t| t.root.is_some()).position(|t| &t.id == last)
    }

    /// A session's window not in front (a #{S:} loop's; the `k`th of its windows, else its
    /// current one): its panes, and the active one.
    pub fn stash_panes(&self, id: u32, k: Option<usize>) -> Option<(Vec<u64>, Option<u64>, String)> {
        let s = self.sessions.iter().find(|s| s.id == id)?;
        let tabs: Vec<&Tab> = s.tabs.iter().filter(|t| t.root.is_some()).collect();
        let t = match k { Some(k) => tabs.get(k).copied()?, None => s.tabs.get(s.active)? };
        Some((t.panes(), t.focus, t.id.clone()))
    }

    /// A pane's own values there: its index (pane-base-index on), whether it is the active one.
    pub fn stash_pane_value(&self, id: u32, k: Option<usize>, pane: u64, key: &str) -> Option<String> {
        let (panes, focus, tab_id) = self.stash_panes(id, k)?;
        let i = panes.iter().position(|p| *p == pane)?;
        Some(match key {
            "pane_index" => (i + self.options.get("pane-base-index", &tab_id, None).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0)).to_string(),
            "pane_active" => ((focus == Some(pane)) as u8).to_string(),
            _ => return None,
        })
    }

    /// Session [id]'s group, if it is in one.
    pub fn group_of(&self, id: u32) -> Option<String> {
        if id == self.session_id { return self.session_group.clone() }
        match self.sessions.iter().find(|s| s.id == id) { Some(s) => s.group.clone(), None => self.remote_rows().into_iter().find(|r| r.id == id).and_then(|r| r.group) }
    }

    /// Whether window [id] (its tab id) is in a session besides the one in front.
    pub fn linked_elsewhere(&self, id: &str) -> bool {
        self.sessions.iter().any(|s| s.mirror.is_none() && s.tabs.iter().any(|t| t.id == id && t.root.is_some()))
    }

    /// The sessions window [id] is in, by name in tmux's order (#{window_linked_sessions_list}).
    pub fn window_sessions(&self, id: &str) -> Vec<String> {
        let mut v: Vec<(u32, String)> = Vec::new();
        if self.tabs.iter().any(|t| t.id == id && t.root.is_some()) { v.push((self.session_id, self.session_name())) }
        for s in self.sessions.iter().filter(|s| s.mirror.is_none() && s.tabs.iter().any(|t| t.id == id && t.root.is_some())) { v.push((s.id, self.stash_name(s))) }
        v.sort_by(|a, b| a.1.cmp(&b.1));
        v.into_iter().map(|(_, n)| n).collect()
    }

    /// The sessions of group [g] (the one in front too), by name.
    /// A session of the group named [g] (new -t's group, when [g] names no session).
    pub fn group_member(&self, g: &str) -> Option<u32> { self.group_sessions(g).first().map(|(id, _)| *id) }

    pub fn group_sessions(&self, g: &str) -> Vec<(u32, String)> {
        let mut v: Vec<(u32, String)> = Vec::new();
        if self.session_group.as_deref() == Some(g) { v.push((self.session_id, self.session_name())) }
        for s in self.sessions.iter().filter(|s| s.group.as_deref() == Some(g)) { v.push((s.id, self.stash_name(s))) }
        for r in self.remote_rows().into_iter().filter(|r| r.group.as_deref() == Some(g)) { if !v.iter().any(|x| x.0 == r.id) { v.push((r.id, r.name)) } }
        // In the order they joined it (tmux's sg->sessions): the order they were made.
        v.sort_by_key(|a| a.0);
        v
    }

    /// Linked windows (link-window, session groups) kept alike: the windows killed gone from
    /// every session (one left with none gone too), the session in front's windows copied into
    /// the other sessions that have them — and, for a group, its set of windows (at the same
    /// numbers) into every session of the group, each keeping its own current window.
    pub fn sync_links(&mut self) {
        let killed = std::mem::take(&mut self.killed_windows);
        let group = self.session_group.clone();
        let front: HashSet<String> = self.tabs.iter().filter(|t| t.root.is_some()).map(|t| t.id.clone()).collect();
        let shares = |s: &Stash| s.mirror.is_none() && ((group.is_some() && s.group == group) || s.tabs.iter().any(|t| front.contains(&t.id) || killed.contains(&t.id)));
        if !self.sessions.iter().any(shares) { return }
        let mut emptied = Vec::new();
        let tabs: Vec<Tab> = self.tabs.iter().filter(|t| t.root.is_some()).cloned().collect();
        let nums = self.nums.clone();
        for s in self.sessions.iter_mut().filter(|s| s.mirror.is_none()) {
            let had = s.tabs.iter().any(|t| t.root.is_some());
            let current = s.tabs.get(s.active).map(|t| t.id.clone());
            let alerts: HashMap<String, u8> = s.tabs.iter().map(|t| (t.id.clone(), t.alerts)).collect();
            // (A session in front with no window left is going: its group keeps theirs.)
            if group.is_some() && s.group == group && !tabs.is_empty() {
                // session_group_synchronize1: its current window and its last windows kept by
                // their numbers (winlink_find_by_index), whatever window is there now.
                let current_num = current.as_ref().and_then(|c| s.nums.get(c).copied());
                let last_nums: Vec<usize> = s.lastw.iter().filter_map(|id| s.nums.get(id).copied()).collect();
                // Its own windows with no pane yet (one made there, its shell on the way; its home
                // page) are its own until they have one: kept, at their numbers.
                let pending: Vec<(Tab, Option<usize>)> = s.tabs.iter().filter(|t| t.root.is_none() && !killed.contains(&t.id)).map(|t| (t.clone(), s.nums.get(&t.id).copied())).collect();
                s.tabs = tabs.iter().map(|t| { let mut c = t.clone(); c.alerts = alerts.get(&t.id).copied().unwrap_or(0); c }).collect();
                s.nums = tabs.iter().filter_map(|t| nums.get(&t.id).map(|n| (t.id.clone(), *n))).collect();
                for (t, n) in pending {
                    let Some(n) = n.filter(|n| !s.nums.values().any(|m| m == n)) else { continue };
                    let at = s.tabs.iter().position(|x| s.nums.get(&x.id).map(|m| *m > n).unwrap_or(false)).unwrap_or(s.tabs.len());
                    s.nums.insert(t.id.clone(), n);
                    s.tabs.insert(at, t);
                }
                let at_num = |s: &Stash, n: usize| s.tabs.iter().find(|t| s.nums.get(&t.id) == Some(&n)).map(|t| t.id.clone());
                s.lastw = last_nums.into_iter().filter_map(|n| at_num(s, n)).collect();
                s.active = current_num.and_then(|n| at_num(s, n)).and_then(|id| s.tabs.iter().position(|t| t.id == id))
                    .or_else(|| current.as_ref().and_then(|c| s.tabs.iter().position(|t| &t.id == c))).unwrap_or(0);
                if s.tabs.is_empty() { if had { emptied.push(s.id) } s.tabs.push(Tab::home()); s.active = 0 }
                continue;
            } else {
                s.tabs.retain(|t| !killed.contains(&t.id));
                for t in s.tabs.iter_mut() {
                    if let Some(f) = tabs.iter().find(|x| x.id == t.id) { *t = f.clone(); t.alerts = alerts.get(&t.id).copied().unwrap_or(0) }
                }
                for k in &killed { s.nums.remove(k); }
            }
            s.lastw.retain(|id| s.tabs.iter().any(|t| &t.id == id));
            s.active = current.and_then(|c| s.tabs.iter().position(|t| t.id == c)).unwrap_or(0);
            if s.tabs.is_empty() { if had { emptied.push(s.id) } s.tabs.push(Tab::home()); s.active = 0 }
        }
        // A session left with no window is gone (session_destroy).
        for id in emptied {
            let name = self.sessions.iter().find(|s| s.id == id).map(|s| self.stash_name(s)).unwrap_or_default();
            self.sessions.retain(|s| s.id != id);
            crate::commands::notify_session(self, "session-closed", id, &name, None);
        }
    }

    /// A window named (-n): automatic-rename off, as tmux's window_set_name with it.
    pub fn name_window(&mut self, w: usize, name: &str) {
        let Some(tab) = self.tabs.get_mut(w) else { return };
        tab.name = name.to_string();
        tab.named = true;
        let id = tab.id.clone();
        self.options.windows.entry(id).or_default().insert("automatic-rename".into(), "off".into());
    }

    /// harness-failed for a harness that failed to start since the last look (not for those failed
    /// already when this client first heard of its machines).
    fn check_launches(&mut self) {
        if self.seen_rostered.is_empty() { return }
        let now: HashSet<(String, String)> = self.fleet.agents.values().filter(|a| a.launch == "failed").map(|a| a.key()).collect();
        let fresh: Vec<(String, String)> = match &self.launch_failed { Some(before) => now.difference(before).cloned().collect(), None => Vec::new() };
        self.launch_failed = Some(now);
        for key in fresh { crate::commands::notify_harness(self, "harness-failed", &key) }
    }

    /// Whether harness hooks are set (harness-needs, -done, -failed): someone wants them run,
    /// attached or not.
    pub fn harness_hooks(&self) -> bool {
        [&self.options.server, &self.options.global_session, &self.options.global_window].iter().any(|m| m.keys().any(|k| k.starts_with("harness-")))
    }

    /// Whether this process runs the harness hooks: one of a server name's does, as tmux runs a
    /// hook once — the oldest running client with a terminal (a hook's message shows on one, as
    /// tmux shows it on the best client), else the oldest with none.
    pub fn runs_agent_hooks(&self) -> bool {
        let Some(me) = crate::ipc::here() else { return true };
        let name = std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "default".into());
        let made = |p: &std::path::Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let clients = crate::ipc::clients_of(&name);
        let attached: Vec<std::path::PathBuf> = clients.iter().filter(|p| !crate::ipc::is_headless(p)).cloned().collect();
        let pool = if attached.is_empty() { clients } else { attached };
        pool.into_iter().min_by_key(|p| made(p)).map(|oldest| oldest == me).unwrap_or(true)
    }

    /// A session of this client's: its windows' ids and names, and its current window's id.
    pub fn windows_of(&self, sid: u32) -> (Vec<(u64, String)>, Option<u64>) {
        let (tabs, active) = if sid == self.session_id { (&self.tabs, self.active) } else { match self.sessions.iter().find(|s| s.id == sid) { Some(s) => (&s.tabs, s.active), None => return (Vec::new(), None) } };
        (tabs.iter().filter(|t| t.root.is_some()).map(|t| (t.wid(), t.name.clone())).collect(), tabs.get(active).filter(|t| t.root.is_some()).map(|t| t.wid()))
    }

    /// A session's windows (number, name, panes), whichever client has it.
    pub fn session_windows(&self, id: u32) -> Vec<(usize, String, usize)> {
        let of = |tabs: &[Tab], nums: &HashMap<String, usize>| tabs.iter().filter(|t| t.root.is_some()).map(|t| (nums.get(&t.id).copied().unwrap_or(0), t.name.clone(), t.panes().len())).collect();
        if id == self.session_id { return of(&self.tabs, &self.nums) }
        if let Some(s) = self.sessions.iter().find(|s| s.id == id) { return of(&s.tabs, &s.nums) }
        self.remote_rows().into_iter().find(|r| r.id == id).map(|r| r.windows).unwrap_or_default()
    }

    /// The harnesses open in a session's windows (this client's sessions), as fleet keys.
    pub fn session_harnesses(&self, id: u32) -> Vec<(String, String)> {
        let tabs: &[Tab] = if id == self.session_id { &self.tabs } else { match self.sessions.iter().find(|s| s.id == id) { Some(s) => &s.tabs, None => return Vec::new() } };
        tabs.iter().flat_map(|t| t.panes()).filter_map(|p| self.panes.get(&p).map(|x| (x.machine_id.clone(), x.agent_id.clone()))).collect()
    }

    /// Every session, (id, name), in tmux's order: by name — this client's and the others'.
    pub fn session_list(&self) -> Vec<(u32, String)> {
        let mut v: Vec<(u32, String)> = std::iter::once((self.session_id, self.session_name())).filter(|(id, _)| *id != UNNUMBERED).chain(self.sessions.iter().map(|s| (s.id, self.stash_name(s))))
            .chain(self.remote_rows().into_iter().map(|r| (r.id, r.name))).collect();
        v.sort_by(|a, b| a.1.cmp(&b.1));
        v
    }

    /// cmd_find_get_session: `$id`, the exact name, the only name it starts, or the only name it
    /// matches as a pattern (`=` first: the exact name only).
    pub fn find_session(&self, target: &str) -> Option<u32> {
        let (exact, t) = match target.strip_prefix('=') { Some(t) => (true, t), None => (false, target) };
        let all = self.session_list();
        if let Some(id) = t.strip_prefix('$') { return id.parse::<u32>().ok().filter(|id| all.iter().any(|(i, _)| i == id)) }
        if let Some((id, _)) = all.iter().find(|(_, n)| n == t) { return Some(*id) }
        if exact { return None }
        let starts: Vec<u32> = all.iter().filter(|(_, n)| n.starts_with(t)).map(|(i, _)| *i).collect();
        match starts.len() { 1 => return Some(starts[0]), 0 => {} _ => return None }
        let matched: Vec<u32> = all.iter().filter(|(_, n)| crate::cmd::fnmatch(t, n)).map(|(i, _)| *i).collect();
        if matched.len() == 1 { Some(matched[0]) } else { None }
    }

    /// session_next_session / session_previous_session: the one after (or before) this one by
    /// name, round to the first (or last); none when this is the only one.
    pub fn neighbour_session(&self, next: bool) -> Option<u32> {
        let all = self.session_list();
        let at = all.iter().position(|(i, _)| *i == self.session_id)?;
        let to = if next { (at + 1) % all.len() } else { (at + all.len() - 1) % all.len() };
        (to != at).then(|| all[to].0)
    }

    /// The session a pane (or a window, by its tab id) is in.
    pub fn session_of_pane(&self, pane: u64) -> Option<u32> {
        if self.tabs.iter().any(|t| t.panes().contains(&pane)) { return Some(self.session_id) }
        self.sessions.iter().find(|s| s.tabs.iter().any(|t| t.panes().contains(&pane))).map(|s| s.id)
    }

    pub fn session_of_window(&self, wid: u64) -> Option<u32> {
        if self.tabs.iter().any(|t| t.is_wid(wid)) { return Some(self.session_id) }
        self.sessions.iter().find(|s| s.tabs.iter().any(|t| t.is_wid(wid))).map(|s| s.id)
    }

    /// The session another client has with pane [pane] (or window [wid]) in it: ids are unique
    /// among the clients of a server name, so %N names one pane whichever terminal asks.
    pub fn remote_session_of(&self, pane: Option<u64>, wid: Option<u64>) -> Option<u32> {
        self.remote_rows().into_iter().find(|r| pane.map(|p| r.pane_ids.contains(&p)).unwrap_or(false) || wid.map(|w| r.wids.contains(&w)).unwrap_or(false)).map(|r| r.id)
    }

    /// session_create: a session [name] (else its number: its id, as tmux's) with one window — a
    /// shell (or [command]) in [cwd], named [window] (automatic-rename off) — made in the
    /// background ([detached]) or gone to.
    pub fn new_session(&mut self, name: Option<&str>, window: Option<&str>, cwd: Option<String>, command: Option<String>, detached: bool) -> Result<u32, String> {
        let (id, name) = match name {
            Some(n) => {
                let n = session_check_name(n).ok_or_else(|| "invalid session: ".to_string())?;
                if self.find_session(&format!("={n}")).is_some() { return Err(format!("duplicate session: {n}")) }
                (self.alloc_session_id(), n)
            }
            None => loop { let id = self.alloc_session_id(); if self.find_session(&format!("={id}")).is_none() { break (id, id.to_string()) } },
        };
        // Named as tmux names a new window, for what it runs (the shell), until automatic-rename.
        let shell = self.options.get("default-shell", "", None).filter(|s| !s.is_empty()).or_else(|| std::env::var("SHELL").ok()).unwrap_or_else(|| "sh".into());
        let program = command.as_deref().and_then(|c| c.split_whitespace().next()).unwrap_or(&shell).rsplit('/').next().unwrap_or("sh").to_string();
        let mut tab = Tab::new(window.unwrap_or(&program));
        tab.first_named = true;
        if window.is_some() {
            tab.named = true;
            self.options.windows.entry(tab.id.clone()).or_default().insert("automatic-rename".into(), "off".into());
        }
        let tab_id = tab.id.clone();
        let base = self.base_index();
        let linked = (tab.wid(), tab.name.clone());
        // Its directory: -c, else the folder of the shell that asked (tmux's client cwd).
        let path = cwd.clone().or_else(|| self.cli_cwd.clone()).or_else(|| std::env::current_dir().ok().map(|d| d.display().to_string()));
        self.sessions.push(Stash { id, used: use_order(), mirror: None, alias: Some(name.clone()), desk: false, tabs: vec![tab], active: 0, lastw: Vec::new(), nums: HashMap::from([(tab_id.clone(), base)]),
            created: epoch_secs(), activity: epoch_secs(), last_attached: 0, options: Default::default(), env: self.environ_update(), path, group: None });
        // cmd-new-session.c: its window linked (spawn_window), then the session created.
        crate::commands::notify_session(self, "window-linked", id, &name, Some(linked));
        crate::commands::notify_session(self, "session-created", id, &name, None);
        // Its shell, on this computer, into its window wherever that is by then.
        crate::input::new_shell_from(self, None, Placement::Fill(tab_id), cwd, command);
        // A headless client shows nothing: the newest session is the one a command with no -t
        // is for (cmd_find_best_session).
        if !detached || self.headless { self.switch_session(id) }
        self.save_sessions();
        Ok(id)
    }

    /// new-session -t: a session in [target]'s group (made of [target] if it is in none), with its
    /// windows at their numbers, the lowest current — named [name], else `group-N` by its id.
    pub fn group_session(&mut self, target: u32, name: Option<&str>, detached: bool) -> Result<u32, String> {
        if let Some(owner) = self.remote_owner(target) {
            let mut words = vec!["new-session".into(), "-d".into(), "-P".into(), "-F".into(), "#{session_id}".into(), "-t".into(), format!("${target}")];
            if let Some(name) = name { words.extend(["-s".into(), name.to_string()]) }
            let id = match crate::ipc::ask(std::path::Path::new(&owner), &words) {
                Some((out, _, 0)) => out.first().and_then(|s| s.trim_end_matches(BARE).strip_prefix('$')).and_then(|s| s.parse().ok()).ok_or_else(|| "the client did not return a session".to_string())?,
                Some((_, err, _)) => return Err(err.join("\n")),
                None => return Err("the client that has it did not answer".into()),
            };
            self.remote.borrow_mut().stamp = None;
            if self.mirror.is_some() { crate::mirror::refresh(self) }
            if !detached { self.switch_session(id) }
            return Ok(id)
        }
        let tname = self.session_list().into_iter().find(|(i, _)| *i == target).map(|(_, n)| n).ok_or_else(|| "can't find session".to_string())?;
        let group = if target == self.session_id { self.session_group.clone() } else { self.sessions.iter().find(|s| s.id == target).and_then(|s| s.group.clone()) }.unwrap_or(tname);
        let name = match name {
            Some(n) => {
                let n = session_check_name(n).ok_or_else(|| format!("invalid session: {n}"))?;
                if self.find_session(&format!("={n}")).is_some() { return Err(format!("duplicate session: {n}")) }
                Some(n)
            }
            None => None,
        };
        // Its windows as the target has them now.
        self.sync_links();
        let (tabs, nums): (Vec<Tab>, HashMap<String, usize>) = if target == self.session_id { (self.tabs.clone(), self.nums.clone()) } else {
            let s = self.sessions.iter().find(|s| s.id == target).ok_or_else(|| "can't find session".to_string())?;
            (s.tabs.clone(), s.nums.clone())
        };
        let mut tabs: Vec<Tab> = tabs.into_iter().filter(|t| t.root.is_some()).collect();
        if tabs.is_empty() { return Err("no windows to share".into()) }
        tabs.sort_by_key(|t| nums.get(&t.id).copied().unwrap_or(usize::MAX));
        if target == self.session_id { self.session_group = Some(group.clone()) } else if let Some(s) = self.sessions.iter_mut().find(|s| s.id == target) { s.group = Some(group.clone()) }
        let id = self.alloc_session_id();
        let name = name.unwrap_or_else(|| format!("{group}-{id}"));
        let path = self.cli_cwd.clone().or_else(|| std::env::current_dir().ok().map(|d| d.display().to_string()));
        self.sessions.push(Stash { id, used: use_order(), mirror: None, alias: Some(name.clone()), desk: false, tabs, active: 0, lastw: Vec::new(), nums,
            created: epoch_secs(), activity: epoch_secs(), last_attached: 0, options: Default::default(), env: self.environ_update(), path, group: Some(group) });
        crate::commands::notify_session(self, "session-created", id, &name, None);
        if !detached || self.headless { self.switch_session(id) }
        self.save_sessions();
        Ok(id)
    }

    /// A session [name] with one empty window (its windows to come: a project's harnesses).
    pub fn empty_session(&mut self, name: &str) -> u32 {
        let id = self.alloc_session_id();
        let tab = Tab::home();
        let base = self.base_index();
        self.sessions.push(Stash { id, used: use_order(), mirror: None, alias: Some(name.to_string()), desk: false, nums: HashMap::from([(tab.id.clone(), base)]), tabs: vec![tab], active: 0, lastw: Vec::new(),
            created: epoch_secs(), activity: epoch_secs(), last_attached: 0, options: Default::default(), env: self.environ_update(), path: None, group: None });
        crate::commands::notify_session(self, "session-created", id, name, None);
        id
    }

    /// Where the sessions are kept between clients (`hn` again after C-b d, or after the last
    /// window of the session in front went): one file per server name (-L).
    fn sessions_path() -> std::path::PathBuf { sessions_path(None) }

    pub fn save_sessions(&self) { self.write_sessions(Save::Stay) }

    /// Written again when its sessions' windows or panes changed: what other clients of this
    /// name list of this one's sessions (and take, when one is gone to) is how they stand.
    pub fn save_if_changed(&mut self) {
        if self.handed_over || self.start_failed.is_some() || self.quit { return }
        self.send_desk_layouts();
        let mut sig = String::new();
        // (Each window's active pane, zoom and layout, and the current window: what the clients
        // showing the session show.)
        let options = &self.options;
        let mut add = |name: String, tabs: &[Tab], nums: &HashMap<String, usize>, active: usize| {
            sig.push_str(&format!("{name}@{active}"));
            for t in tabs.iter().filter(|t| t.root.is_some()) {
                sig.push_str(&format!("|{}:{}:{}:{:?}:{:?}:{}:{}:{:?}:{}", t.id, t.name, nums.get(&t.id).copied().unwrap_or(0), t.panes(), t.focus, t.zoomed, t.root.as_ref().map(|r| r.to_tmux()).unwrap_or_default(), options.windows.get(&t.id), t.home))
            }
            sig.push('\n');
        };
        if !self.session_desk && self.mirror.is_none() { add(self.session_name(), &self.tabs, &self.nums, self.active) }
        for s in self.sessions.iter().filter(|s| !s.desk && s.mirror.is_none()) { add(self.stash_name(s), &s.tabs, &s.nums, s.active) }
        // …and each session's options and environment (set-environment from the other client).
        sig.push_str(&format!("{:?}{:?}{:?}{:?}{}", self.options.session, self.session_env, self.session_group, self.lastw, self.session_alerts(self.session_id)));
        for s in self.sessions.iter().filter(|s| !s.desk && s.mirror.is_none()) { sig.push_str(&format!("{:?}{:?}{:?}{:?}{}", s.options, s.env, s.group, s.lastw, self.session_alerts(s.id))) }
        if sig != self.sessions_sig { self.sessions_sig = sig; self.save_sessions() }
    }

    /// Every session this client has as its windows stand — each window's name, number, layout
    /// and its panes' harnesses — marked as this client's (else left for the next, as [how]
    /// says), beside the other clients' sessions as they wrote them; the desk's name; and the
    /// session in front.
    pub fn write_sessions(&self, how: Save) {
        let path = Self::sessions_path();
        let _lock = crate::ipc::lock(&path);
        self.write_sessions_held(how)
    }

    /// write_sessions with the file's lock already held.
    pub fn write_sessions_held(&self, how: Save) {
        if self.handed_over || (self.capture.is_some() && self.tabs.is_empty()) { return }
        let window = |app: &App, t: &Tab, nums: &HashMap<String, usize>| app.window_json(t, nums.get(&t.id).copied());
        let me = crate::ipc::here().map(|p| p.display().to_string());
        let path = Self::sessions_path();
        let doc = read_sessions(&path);
        let here = Stash { id: self.session_id, used: self.session_used, mirror: self.mirror.clone(), alias: self.session_alias.clone(), desk: self.session_desk, tabs: Vec::new(), active: self.active, lastw: Vec::new(), nums: HashMap::new(), created: self.session_created, activity: epoch_secs(), last_attached: self.session_last_attached, options: self.options.session.clone(), env: self.session_env.clone(), path: self.session_path.clone(), group: self.session_group.clone() };
        let mut ours = Vec::new();
        let mut names = HashSet::new();
        let mut desk = None;
        for (s, tabs, nums, lastw, front) in std::iter::once((&here, &self.tabs, &self.nums, &self.lastw, true)).chain(self.sessions.iter().map(|s| (s, &s.tabs, &s.nums, &s.lastw, false))) {
            // The desk's session is every client's: its windows are the desk's tabs.
            // (Its windows are the desk's; what is the session's own — its options, environment,
            // group, folder — and its windows' own state are kept here, as any session's are.)
            if s.desk {
                let mut state: Vec<Value> = tabs.iter().filter(|t| t.root.is_some()).map(|t| self.window_kept(t)).collect();
                // The desk arrives asynchronously. Keep its saved window state until those
                // tabs arrive, including when a detached server starts before the next client.
                for (id, kept) in &self.desk_windows_saved { if !state.iter().any(|w| w["id"].as_str() == Some(id)) { state.push(kept.clone()) } }
                let active = self.desk_active_saved.unwrap_or(s.active);
                desk = Some(json!({ "name": s.alias, "desk": true, "created": s.created, "active": active, "windows": [], "options": s.options, "env": env_json(&s.env), "group": s.group, "path": s.path, "window_state": state }));
                continue
            }
            // Another client's, shown here: that client writes it.
            if s.mirror.is_some() { continue }
            let kept: Vec<&Tab> = tabs.iter().filter(|t| t.root.is_some()).collect();
            let windows: Vec<Value> = kept.iter().map(|t| window(self, t, nums)).collect();
            if windows.is_empty() { continue }
            let name = self.stash_name(s);
            names.insert(name.clone());
            let left = how == Save::Leave || how == Save::Release(s.id);
            // The current window and the ones before it (C-b l, the - flag), by their place here.
            let at = |id: &String| kept.iter().position(|t| t.id == *id);
            let active = tabs.get(s.active).and_then(|t| at(&t.id)).unwrap_or(0);
            let last: Vec<usize> = lastw.iter().filter_map(at).collect();
            ours.push(json!({ "name": name, "id": (s.id != UNNUMBERED).then_some(s.id), "desk": false, "created": s.created, "activity": s.activity, "last_attached": s.last_attached, "active": active, "last": last, "windows": windows,
                "owner": if left { Value::Null } else { json!(me) }, "front": front && !left && !self.headless, "headless": self.headless && !left,
                "mirrors": if left { 0 } else { self.mirrors.values().filter(|m| **m == s.id).count() },
                "attached_clients": if left { Vec::<(u64, String)>::new() } else { self.session_clients(s.id) }, "alerts": self.session_alerts(s.id),
                // Its own options and environment (set -t, setenv -t, update-environment's), kept
                // wherever it goes.
                "options": s.options, "env": env_json(&s.env), "path": s.path, "group": s.group }));
        }
        let mut rows = Vec::new();
        if !self.forget_sessions {
            // The others: every session as its client wrote it, but for one this client has now.
            for row in doc["sessions"].as_array().cloned().unwrap_or_default() {
                if row.get("desk").and_then(Value::as_bool).unwrap_or(false) { if desk.is_none() { rows.push(row) } continue }
                if me.is_some() && row.get("owner").and_then(Value::as_str) == me.as_deref() { continue }
                if row.get("name").and_then(Value::as_str).map(|n| names.contains(n)).unwrap_or(true) { continue }
                rows.push(row);
            }
            rows.extend(desk);
            rows.extend(ours);
        }
        let current = if self.forget_sessions { Value::Null }
            else if how == Save::Stay || how == Save::Leave { if self.session_desk { Value::Null } else { json!(self.session_name()) } }
            else { doc.get("current").cloned().unwrap_or(Value::Null) };
        let doc = json!({ "current": current, "sessions": rows });
        if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
        let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        if std::fs::write(&temp, doc.to_string()).is_ok() { let _ = std::fs::rename(temp, &path); }
        self.remote.borrow_mut().stamp = None;
        // The clients showing a session of this one's: told it may have changed.
        if !self.mirrors.is_empty() && how == Save::Stay { crate::mirror::tell_mirrors(self) }
    }

    /// A session as the file keeps it: each window's harnesses in their panes, laid out as they
    /// were, numbered and named as they were. None when none of its windows has a pane.
    /// A window as the sessions file keeps it (and as it goes to another client): its name,
    /// number, @id, layout, focus, zoom, and each pane's harness, whether hn made it (a shell, ended
    /// when its window is killed by whichever client does it), and its %id.
    pub fn window_json(&self, t: &Tab, num: Option<usize>) -> Value {
        let panes: Vec<Value> = t.panes().iter().filter_map(|p| self.panes.get(p)).map(|p| json!([p.machine_id, p.agent_id, self.shells.contains(&(p.machine_id.clone(), p.agent_id.clone())), p.id, p.dead, p.start_command])).collect();
        let focus = t.focus.and_then(|f| t.panes().iter().position(|p| *p == f)).unwrap_or(0);
        // Its own options (set -w) and its panes' (set -p), kept with it wherever it goes.
        let options = self.options.windows.get(&t.id).cloned().unwrap_or_default();
        let pane_options: serde_json::Map<String, Value> = t.panes().iter().filter_map(|p| self.options.panes.get(p).map(|m| (p.to_string(), json!(m)))).collect();
        let titles: serde_json::Map<String, Value> = t.panes().iter().filter_map(|p| self.panes.get(p).filter(|x| !x.title.is_empty()).map(|x| (p.to_string(), json!(x.title)))).collect();
        json!({ "id": t.id, "home": t.home, "titles": titles, "name": t.name, "named": t.named, "first_named": t.first_named, "num": num, "wid": t.wid(), "layout": t.root.as_ref().map(|r| r.to_tmux()).unwrap_or_default(), "panes": panes, "focus": focus, "alerts": t.alerts, "zoomed": t.zoomed && panes.len() > 1, "options": options, "pane_options": pane_options })
    }

    /// A window's own state that a client leaving keeps for the next (the desk's windows, whose
    /// panes and layout the desk has): its options, its panes', zoom, the panes' titles.
    fn window_kept(&self, t: &Tab) -> Value {
        let options = self.options.windows.get(&t.id).cloned().unwrap_or_default();
        let pane_options: serde_json::Map<String, Value> = t.panes().iter().filter_map(|p| self.options.panes.get(p).map(|m| (p.to_string(), json!(m)))).collect();
        let titles: serde_json::Map<String, Value> = t.panes().iter().filter_map(|p| self.panes.get(p).filter(|x| !x.title.is_empty()).map(|x| (p.to_string(), json!(x.title)))).collect();
        let shells: Vec<_> = t.panes().iter().filter_map(|p| self.panes.get(p)).map(|p| (p.machine_id.clone(), p.agent_id.clone())).filter(|key| self.shells.contains(key)).collect();
        json!({ "id": t.id, "home": t.home, "first_named": t.first_named, "options": options, "pane_options": pane_options, "zoomed": t.zoomed, "titles": titles, "focus": t.focus, "shells": shells })
    }

    /// The desk session's own state from the file: on the desk session (in front or kept), its
    /// windows' as their tabs come (apply_desk).
    fn take_desk_row(&mut self, row: &Value) {
        let (options, env) = (options_from(row), env_from(row));
        let group = row.get("group").and_then(Value::as_str).map(str::to_string);
        let path = row.get("path").and_then(Value::as_str).map(str::to_string);
        let created = row.get("created").and_then(Value::as_i64);
        if self.session_desk {
            if !options.is_empty() { self.options.session = options }
            if !env.is_empty() { self.session_env = env }
            if group.is_some() { self.session_group = group }
            if path.is_some() { self.session_path = path }
            if let Some(c) = created { self.session_created = c }
        } else if let Some(s) = self.sessions.iter_mut().find(|s| s.desk) {
            if !options.is_empty() { s.options = options }
            if !env.is_empty() { s.env = env }
            if group.is_some() { s.group = group }
            if path.is_some() { s.path = path }
            if let Some(c) = created { s.created = c }
        }
        self.desk_active_saved = row.get("active").and_then(Value::as_u64).map(|n| n as usize);
        for w in row.get("window_state").and_then(Value::as_array).cloned().unwrap_or_default() {
            if let Some(id) = w.get("id").and_then(Value::as_str) { self.desk_windows_saved.insert(id.to_string(), w.clone()); }
        }
    }

    /// A desk window's kept state on its tab (once: the desk's own updates after that are live).
    fn restore_desk_window(&mut self, index: usize) {
        let Some(tab) = self.tabs.get(index) else { return };
        let Some(w) = self.desk_windows_saved.remove(&tab.id) else { return };
        let mut tab = std::mem::replace(&mut self.tabs[index], Tab::home());
        self.take_window_options(&mut tab, &w);
        if let Ok(shells) = serde_json::from_value::<Vec<(String, String)>>(w["shells"].clone()) { self.shells.extend(shells) }
        // (Its active pane, by its id — the desk's panes keep theirs — then its zoom.)
        if let Some(f) = w.get("focus").and_then(Value::as_u64).filter(|f| tab.panes().contains(f)) { tab.set_active(f) }
        if w.get("zoomed").and_then(Value::as_bool).unwrap_or(false) && tab.panes().len() > 1 { tab.zoomed = true }
        for (p, title) in w.get("titles").and_then(Value::as_object).cloned().unwrap_or_default() {
            if let (Ok(p), Some(t)) = (p.parse::<u64>(), title.as_str()) { if let Some(x) = self.panes.get_mut(&p) { x.title = t.to_string() } }
        }
        self.tabs[index] = tab;
    }

    /// A window's own options and its panes', as window_json keeps them, taken on for [tab].
    pub fn take_window_options(&mut self, tab: &mut Tab, win: &Value) {
        tab.home = win.get("home").and_then(Value::as_bool).unwrap_or(false);
        tab.first_named = win.get("first_named").and_then(Value::as_bool).unwrap_or_else(|| win.get("name").and_then(Value::as_str).is_some_and(|n| !n.is_empty()));
        let options = options_from(&json!({ "options": win.get("options").cloned().unwrap_or(Value::Null) }));
        tab.sync = options.get("synchronize-panes").map(|v| v == "on").unwrap_or(tab.sync);
        if options.is_empty() { self.options.windows.remove(&tab.id); } else { self.options.windows.insert(tab.id.clone(), options); }
        for (p, m) in win.get("pane_options").and_then(Value::as_object).cloned().unwrap_or_default() {
            let Ok(p) = p.parse::<u64>() else { continue };
            self.options.panes.insert(p, options_from(&json!({ "options": m })));
        }
    }

    /// A window made again from window_json (its panes' harnesses, ids and shells taken on here),
    /// with its number if it had one. None when it has no pane.
    pub fn tab_from_json(&mut self, win: &Value) -> Option<(Tab, Option<usize>)> {
        let (w, h) = (self.body().width, self.body().height);
        let panes: Vec<(String, String)> = win.get("panes").and_then(Value::as_array).map(|a| a.iter().filter_map(|p| Some((p.get(0)?.as_str()?.to_string(), p.get(1)?.as_str()?.to_string()))).collect()).unwrap_or_default();
        if panes.is_empty() { return None }
        // A window another session has too (link-window, a group), already read: the same
        // window again — its id, its panes — not a second one. By its id (kept in the file), or
        // (a file from before ids were kept) its @N and harnesses.
        if let Some(id) = win.get("id").and_then(Value::as_str) {
            if let Some(t) = self.tabs.iter().chain(self.sessions.iter().flat_map(|s| s.tabs.iter())).find(|t| t.id == id && t.root.is_some()) {
                let mut t = t.clone();
                t.alerts = 0;
                t.on_desk = false;
                return Some((t, win.get("num").and_then(Value::as_u64).map(|n| n as usize)));
            }
        }
        if let Some(wid) = win.get("wid").and_then(Value::as_u64) {
            let same = |t: &Tab| t.root.is_some() && t.wid() == wid && t.panes().iter().map(|p| self.panes.get(p).map(|x| (x.machine_id.clone(), x.agent_id.clone()))).collect::<Option<Vec<_>>>().as_ref() == Some(&panes);
            if let Some(t) = self.tabs.iter().chain(self.sessions.iter().flat_map(|s| s.tabs.iter())).find(|t| same(t)) {
                let mut t = t.clone();
                t.alerts = 0;
                return Some((t, win.get("num").and_then(Value::as_u64).map(|n| n as usize)));
            }
        }
        for p in win.get("panes").and_then(Value::as_array).cloned().unwrap_or_default() {
            if p.get(2).and_then(Value::as_bool).unwrap_or(false) { if let (Some(m), Some(a)) = (p.get(0).and_then(Value::as_str), p.get(1).and_then(Value::as_str)) { self.shells.insert((m.to_string(), a.to_string())); } }
        }
        // Each pane with its id (%N) as it was.
        let kept: Vec<Option<u64>> = win.get("panes").and_then(Value::as_array).map(|a| a.iter().filter(|p| p.get(1).is_some()).map(|p| p.get(3).and_then(Value::as_u64)).collect()).unwrap_or_default();
        let ids: Vec<u64> = panes.iter().enumerate().map(|(i, (m, a))| self.new_pane_as(m, a, kept.get(i).copied().flatten())).collect();
        for (id, saved) in ids.iter().zip(win["panes"].as_array().into_iter().flatten()) {
            if let Some(pane) = self.panes.get_mut(id) {
                pane.dead = serde_json::from_value(saved.get(4).cloned().unwrap_or(Value::Null)).ok();
                pane.start_command = saved.get(5).and_then(Value::as_str).map(str::to_string);
            }
        }
        // And the window its id (@N).
        let name = win.get("name").and_then(Value::as_str).unwrap_or("");
        let mut tab = match win.get("wid").and_then(Value::as_u64).filter(|w| self.session_of_window(*w).is_none()) { Some(wid) => Tab::with_wid(name, wid), None => Tab::new(name) };
        // Its id as it was (a window linked elsewhere, the desk's, finds it by that).
        if let Some(id) = win.get("id").and_then(Value::as_str).filter(|i| !i.is_empty()) { tab.id = id.to_string() }
        // The titles its panes were given (select-pane -T).
        for (i, p) in win.get("panes").and_then(Value::as_array).cloned().unwrap_or_default().iter().enumerate() {
            let old = p.get(3).and_then(Value::as_u64).map(|n| n.to_string());
            let title = old.and_then(|o| win.pointer(&format!("/titles/{o}")).and_then(Value::as_str).map(str::to_string));
            if let (Some(t), Some(pid)) = (title, ids.get(i)) { if let Some(x) = self.panes.get_mut(pid) { x.title = t } }
        }
        tab.named = win.get("named").and_then(Value::as_bool).unwrap_or(false);
        let layout = win.get("layout").and_then(Value::as_str).unwrap_or("");
        // With no terminal: the size the last terminal gave it (tmux keeps it).
        // At the size it was saved at (the one in front takes the terminal's when it is shown);
        // hn with no terminal keeps it as the window's own.
        let (w, h) = match Node::tmux_size(layout) { Some(s) => { if self.headless { tab.size = Some(s) } s } None => (w, h) };
        tab.root = Node::from_tmux(layout, &ids, w, h).or_else(|| layout::arrange(layout::Named::Tiled, &ids, w, h, layout::Status::Top, DESK_MAIN, ("0", "0")));
        tab.order = ids.clone();
        tab.focus = ids.get(win.get("focus").and_then(Value::as_u64).unwrap_or(0) as usize).or(ids.first()).copied();
        tab.zoomed = win.get("zoomed").and_then(Value::as_bool).unwrap_or(false) && ids.len() > 1;
        tab.alerts = win.get("alerts").and_then(Value::as_u64).unwrap_or(0) as u8;
        self.take_window_options(&mut tab, win);
        let num = win.get("num").and_then(Value::as_u64).map(|n| n as usize);
        Some((tab, num))
    }

    fn stash_from_row(&mut self, row: &Value, id: u32) -> Option<Stash> {
        let name = row.get("name").and_then(Value::as_str)?.to_string();
        // Its own id ($N), kept wherever it goes — unless this client has a session by that id.
        let id = row.get("id").and_then(Value::as_u64).map(|i| i as u32).filter(|i| *i != self.session_id && !self.sessions.iter().any(|s| s.id == *i)).unwrap_or(id);
        let mut tabs = Vec::new();
        let mut nums = HashMap::new();
        for win in row.get("windows").and_then(Value::as_array).cloned().unwrap_or_default() {
            let Some((tab, num)) = self.tab_from_json(&win) else { continue };
            if let Some(n) = num { nums.insert(tab.id.clone(), n); }
            tabs.push(tab);
        }
        if tabs.is_empty() { return None }
        let active = row.get("active").and_then(Value::as_u64).unwrap_or(0) as usize;
        let created = row.get("created").and_then(Value::as_i64).unwrap_or_else(epoch_secs);
        let lastw: Vec<String> = row.get("last").and_then(Value::as_array).map(|l| l.iter().filter_map(|i| tabs.get(i.as_u64()? as usize).map(|t| t.id.clone())).collect()).unwrap_or_default();
        Some(Stash { id, used: 0, mirror: None, alias: Some(name), desk: false, active: active.min(tabs.len() - 1), tabs, lastw, nums,
            created, activity: row.get("activity").and_then(Value::as_i64).unwrap_or(created), last_attached: row.get("last_attached").and_then(Value::as_i64).unwrap_or(0), options: options_from(row), env: env_from(row), path: row.get("path").and_then(Value::as_str).map(str::to_string), group: row.get("group").and_then(Value::as_str).map(str::to_string) })
    }

    /// The sessions no running client has (save_sessions: left by clients that detached), back
    /// as they were; another client's stay with it, listed here. Then the one asked for at start
    /// (`hn attach -t work`, `hn new -A -s main`: another client's is given up by it), else the
    /// one in front when the last client left — unless another client has it.
    pub fn load_sessions(&mut self) {
        let mut doc = read_sessions(&Self::sessions_path());
        let me = crate::ipc::here().map(|p| p.display().to_string());
        // A headless hn (tmux's server with no client) hands everything to the first client that
        // attaches: one holder of the sessions again, as tmux has one server.
        if !self.headless {
            let held: HashSet<String> = doc["sessions"].as_array().map(|rows| rows.iter().filter(|r| r.get("headless").and_then(Value::as_bool).unwrap_or(false)).filter_map(live_owner).filter(|owner| Some(owner) != me.as_ref()).collect()).unwrap_or_default();
            for owner in &held { let _ = crate::ipc::ask(std::path::Path::new(owner), &["hn-hand-over".into()]); }
        }
        // The rows no client has are read and made this client's while the file is held: two
        // clients starting together never both take one.
        let path = Self::sessions_path();
        let lock = crate::ipc::lock(&path);
        doc = read_sessions(&path);
        for row in doc["sessions"].as_array().cloned().unwrap_or_default() {
            let name = row.get("name").and_then(Value::as_str).map(str::to_string);
            if row.get("desk").and_then(Value::as_bool).unwrap_or(false) {
                // A local fallback may have kept the initial desk name for its ordinary
                // shell session. Its stale desk metadata must not shadow that live session.
                let ordinary = name.as_ref().is_some_and(|name| doc["sessions"].as_array().is_some_and(|rows| rows.iter().any(|r| r["desk"].as_bool() != Some(true) && r["name"].as_str() == Some(name))));
                if name.is_some() && self.session_desk && !ordinary { self.session_alias = name }
                self.take_desk_row(&row);
                continue
            }
            let Some(name) = name else { continue };
            if live_owner(&row).filter(|o| Some(o) != me.as_ref()).is_some() { continue }
            if self.own_session(&name).is_some() { continue }
            // Its own id ($N), else (a file from before ids were kept) one given here.
            let id = row.get("id").and_then(Value::as_u64).map(|i| i as u32).filter(|i| *i != self.session_id && !self.sessions.iter().any(|s| s.id == *i)).unwrap_or_else(|| self.remote_id(&name));
            if let Some(stash) = self.stash_from_row(&row, id) { self.sessions.push(stash) }
        }
        self.write_sessions_held(Save::Stay);
        drop(lock);
        self.remote.borrow_mut().stamp = None;
        // The session in front when the last client left — or one a headless client holds (it
        // made them for a script; this client is where they are meant to be seen).
        let held = |name: &str| doc["sessions"].as_array().map(|rows| rows.iter().any(|r| r.get("name").and_then(Value::as_str) == Some(name)
            && r.get("headless").and_then(Value::as_bool).unwrap_or(false) && live_owner(r).is_some())).unwrap_or(false);
        let current = doc.get("current").and_then(Value::as_str).map(str::to_string)
            .and_then(|c| self.own_session(&c).or_else(|| if held(&c) && !self.headless { self.find_session(&format!("={c}")) } else { None }))
            .filter(|c| *c != self.session_id);
        match self.start_session.clone() {
            // No session asked for: the one in front when the last client left — or, when that one
            // is gone (a terminal whose session was destroyed), the session used last
            // (cmd_find_best_session), never an empty one of this client's own.
            None => {
                let fallback = || self.sessions.iter().filter(|s| !s.desk && s.mirror.is_none() && s.tabs.iter().any(|t| t.root.is_some())).max_by_key(|s| (s.activity, s.used)).map(|s| s.id);
                let own_empty = !self.tabs.iter().any(|t| t.root.is_some());
                if let Some(id) = current.or_else(|| if own_empty { fallback() } else { None }) { self.switch_session(id) }
            }
            Some(start) => {
                // attach -t finds a session as tmux does (its name, the only one it starts, a
                // pattern); new -s is the exact name.
                let found = start.name.as_deref().and_then(|n| if start.create { self.find_session(&format!("={n}")) } else { self.find_session(n) });
                match (found, start.create) {
                    // attach -t, new -A: there already (attach -t work:2: at that window).
                    (Some(id), false) => {
                        self.switch_session_as(id, start.attach_how());
                        self.start_session = None;
                        // attach -c: the session's start directory from now on.
                        if let Some(c) = start.cwd.clone().filter(|c| !c.is_empty()) { self.session_path = Some(c) }
                        if let Some(w) = &start.target {
                            let spec = crate::cmd::Spec { kind: crate::cmd::Kind::Window, can_fail: false, window_index: false, default_marked: false };
                            match crate::cmd::resolve(self, Some(&format!(":{w}")), spec).ok().and_then(|f| f.window) {
                                Some(i) => self.select_tab(i),
                                None => { let e = format!("can't find window: {w}"); self.start_error(e); return }
                            }
                        }
                    }
                    (Some(id), true) if start.attach_existing => { self.switch_session_as(id, start.attach_how()); self.start_session = None }
                    (Some(_), true) => { self.start_error(format!("duplicate session: {}", start.name.clone().unwrap_or_default())) }
                    // new -t: a session in that one's group — made by the client that has it
                    // (shown here as it has it), or here when it is this client's.
                    (None, true) if start.group.is_some() => {
                        self.start_session = None;
                        let t = start.group.clone().unwrap_or_default();
                        // -t names a session (or a window or pane of one), else a group: one of its
                        // sessions — or, none yet, a new group of that name this session starts.
                        let Some(target) = self.find_session(&t).or_else(|| self.group_member(&t)) else {
                            let Some(g) = session_check_name(&t) else { self.start_error(format!("invalid session group name: {t}")); return };
                            self.session_group = Some(g);
                            self.session_alias = start.name.as_deref().and_then(session_check_name);
                            return;
                        };
                        match self.remote_owner(target) {
                            Some(owner) => {
                                let mut ask: Vec<String> = vec!["new-session".into(), "-d".into(), "-P".into(), "-F".into(), "#{session_name}".into(), "-t".into(), format!("${target}")];
                                if let Some(n) = &start.name { ask.extend(["-s".into(), n.clone()]) }
                                match crate::ipc::ask(std::path::Path::new(&owner), &ask) {
                                    Some((out, _, 0)) => {
                                        let name = out.first().map(|l| l.trim_end_matches(BARE).to_string()).unwrap_or_default();
                                        self.remote.borrow_mut().stamp = None;
                                        match self.find_session(&format!("={name}")) { Some(id) => self.switch_session_as(id, start.attach_how()), None => { self.start_error(format!("can't find session: {name}")); return } }
                                    }
                                    Some((_, err, _)) => { self.start_error(err.join("\n")); return }
                                    None => { self.start_error("the client that has it did not answer".into()); return }
                                }
                            }
                            None => if let Err(e) = self.group_session(target, start.name.as_deref(), false) { self.start_error(e); return },
                        }
                    }
                    // A fresh start's first session is the desk's (desk=off: the client's first),
                    // named as asked; another is made once this computer is connected
                    // (maybe_start_shell).
                    (None, true) if self.sessions.is_empty() && self.session_alias.is_none() && start.window.is_none() => {
                        self.session_alias = start.name.as_deref().and_then(session_check_name);
                    }
                    (None, true) => {}
                    (None, false) => match &start.name {
                        Some(n) => self.start_error(format!("can't find session: {}", n.trim_start_matches('='))),
                        // attach with no -t: the session in front last, wherever it is (another
                        // terminal's is taken, as attach -t takes it); none kept: a new one.
                        None => {
                            self.start_session = None;
                            let last = doc.get("current").and_then(Value::as_str).and_then(|c| self.find_session(&format!("={c}"))).filter(|c| *c != self.session_id);
                            // (That one gone — its terminal's session destroyed: the session used last,
                            // as tmux attaches to cmd_find_best_session's.)
                            let best = self.sessions.iter().filter(|s| !s.desk && s.mirror.is_none() && s.tabs.iter().any(|t| t.root.is_some())).max_by_key(|s| (s.activity, s.used)).map(|s| s.id)
                                .or_else(|| self.remote_rows().into_iter().max_by_key(|r| r.activity).map(|r| r.id));
                            if let Some(id) = current.or(last).or(best) { self.switch_session(id) }
                        }
                    },
                }
            }
        }
        if self.start_failed.is_some() { return }
        // desk=off: the session the client started in is kept (it is not left for another, nor
        // made by hn new -s once connected) — numbered now, as session_create numbers a new
        // session: named by its number when it has no name, the next number while that is taken.
        let made_later = self.start_session.as_ref().map(|s| s.create && self.session_alias.as_deref() != s.name.as_deref()).unwrap_or(false);
        if self.session_id == UNNUMBERED && !self.headless && !made_later {
            let named = self.session_alias.is_some();
            loop {
                self.session_id = self.alloc_session_id();
                if named || self.find_session(&format!("={}", self.session_id)).is_none() { break }
            }
            self.first_session = self.session_id;
            if !named { self.session_alias = Some(self.session_id.to_string()) }
        }
        self.save_sessions();
    }

    /// A start that can't be done (`hn attach -t nosuch`): said as tmux says it, and no client.
    fn start_error(&mut self, e: String) {
        self.start_session = None;
        self.start_failed = Some(e);
        self.quit = true;
    }

    /// server_destroy_session, for the session in front, whose last window has gone: another
    /// session takes the client (detach-on-destroy off: the one it was in last, or the newest;
    /// previous, next: by name), else the client exits (`[exited]`). The desk's session stays,
    /// its window the home screen, for the desk's tabs to come back to.
    pub fn session_gone(&mut self) {
        self.notify_closed();
        self.session_gone_quiet()
    }

    /// session-closed, for the session in front (session_destroy's first notify).
    fn notify_closed(&mut self) {
        if !self.session_desk { let (sid, name) = (self.session_id, self.session_name()); crate::commands::notify_session(self, "session-closed", sid, &name, None) }
    }

    /// The session in front was destroyed elsewhere (its owner killed it): this client goes to
    /// another, or exits, as detach-on-destroy says — its hooks were the owner's to run.
    pub fn session_destroyed(&mut self) { self.session_gone_quiet(); self.fit_panes() }

    fn session_gone_quiet(&mut self) {
        let gone = self.session_id;
        // A session a command ran in for a moment: gone, and nothing else changes.
        if let Some(back) = self.swap_back.filter(|b| *b != gone) {
            if self.session_desk { return }
            self.swap_session(back);
            self.sessions.retain(|s| s.id != gone);
            self.save_sessions();
            return;
        }
        // (hn with no terminal is tmux's server, not a client: it keeps the sessions it has.)
        let how = if self.headless || self.os_session { "off".to_string() } else { self.options.get("detach-on-destroy", "", None).unwrap_or_default() };
        let others: Vec<u32> = self.sessions.iter().map(|s| s.id).collect();
        let next = match how.as_str() {
            "off" | "no-detached" => self.last_session.filter(|l| others.contains(l)).or_else(|| self.sessions.iter().max_by_key(|s| s.created).map(|s| s.id)),
            "previous" => self.neighbour_session(false),
            "next" => self.neighbour_session(true),
            _ => None,
        };
        let desk = self.session_desk;
        match next {
            Some(id) => {
                self.switch_session(id);
                self.last_session = None;
                if !desk { self.sessions.retain(|s| s.id != gone) }
            }
            None if self.os_session && desk => {
                self.tabs = vec![Tab::home()];
                self.active = 0;
            }
            // The OS surface stays on home, as does a headless server with exit-empty off.
            None if !desk && (self.os_session || (self.headless && self.options.get("exit-empty", "", None).as_deref() == Some("off"))) => {
                self.session_id = UNNUMBERED;
                self.session_alias = None;
                self.tabs = vec![Tab::home()];
                self.active = 0;
                self.options.session.clear();
                self.session_env.clear();
                self.session_path = None;
            }
            None => {
                if !desk { if let Some(desk_id) = self.sessions.iter().find(|s| s.desk).map(|s| s.id) { self.swap_session(desk_id); self.sessions.retain(|s| s.id != gone) } }
                self.quit = true;
                self.exited = true;
                if !self.headless { crate::commands::notify(self, "client-detached", None, None) }
            }
        }
        self.save_sessions();
    }

    /// tmux's named layout (layout-set.c) on a window: main-pane-* and other-pane-* as set,
    /// remembered for next-layout.
    pub fn arrange_tab(&mut self, index: usize, named: layout::Named) {
        let body = self.body();
        let Some(tab) = self.tabs.get(index) else { return };
        let tab_id = tab.id.clone();
        let get = |n: &str| self.options.get(n, &tab_id, None).unwrap_or_default();
        let (mw, mh, ow, oh) = (get("main-pane-width"), get("main-pane-height"), get("other-pane-width"), get("other-pane-height"));
        let status = self.pane_status(tab);
        let ids = tab.panes();
        let tab = &mut self.tabs[index];
        tab.root = layout::arrange(named, &ids, body.width, body.height, status, (&mw, &mh), (&ow, &oh));
        tab.zoomed = false;
        tab.layout_at = layout::Named::ALL.iter().position(|n| *n == named);
        if tab.on_desk { tab.desk_preset = named_to_desk(named, ids.len()).map(|preset| (ids.len(), preset)); }
        self.fit_panes();
        self.layout_changed(index);
    }


    /// move-window -r: every window numbered in order from base-index.
    pub fn renumber_all(&mut self) {
        for (i, t) in self.tabs.iter().enumerate() { self.nums.insert(t.id.clone(), i + self.base_index()); }
        self.fit_panes();
    }

    /// Give every window without an index the first free one; forget closed windows'.
    pub fn renumber(&mut self) {
        let ids: HashSet<String> = self.tabs.iter().map(|t| t.id.clone()).collect();
        let before = self.nums.len();
        self.nums.retain(|id, _| ids.contains(id));
        if self.nums.len() < before { self.window_gone = true }
        // renumber-windows on (server_renumber_session): when a window has gone, the others
        // numbered from base-index in their order — only then; a new one takes the first free.
        if std::mem::take(&mut self.window_gone) && self.options.get("renumber-windows", "", None).as_deref() == Some("on") {
            let mut order: Vec<(usize, String)> = self.tabs.iter().enumerate().filter_map(|(i, t)| self.nums.get(&t.id).map(|n| (*n, t.id.clone())).or(Some((usize::MAX - self.tabs.len() + i, t.id.clone())))).collect();
            order.sort();
            for (k, (_, id)) in order.into_iter().enumerate() { self.nums.insert(id, k + self.base_index()); }
        }
        for i in 0..self.tabs.len() {
            if self.nums.contains_key(&self.tabs[i].id) { continue }
            let n = self.free_num();
            self.nums.insert(self.tabs[i].id.clone(), n);
        }
    }

    fn free_num(&self) -> usize {
        let used: HashSet<usize> = self.nums.values().copied().collect();
        (self.base_index()..).find(|n| !used.contains(n)).unwrap_or(self.base_index())
    }

    /// The window index tmux would show for the tab at `index`.
    pub fn win_num(&self, index: usize) -> usize {
        self.tabs.get(index).and_then(|t| self.nums.get(&t.id).copied()).unwrap_or(index + self.base_index())
    }

    pub fn tab_by_num(&self, n: usize) -> Option<usize> { (0..self.tabs.len()).find(|i| self.win_num(*i) == n) }

    /// server_link_window then server_unlink_window, as move-window does them: the window at
    /// [src] takes number [idx] (the first free one from base-index when none — its own number
    /// still taken while it is looked for), a window already there replaced with [kill] ("index
    /// in use: N" without; "same index: N" when it is this one), made current if [select] (or if
    /// the one replaced was current); a current window moved without it leaves for the last one.
    pub fn move_window(&mut self, src: usize, idx: Option<usize>, kill: bool, select: bool) -> Result<(), String> {
        self.renumber();
        let id = self.tabs[src].id.clone();
        let mut select = select;
        if let Some(n) = idx {
            if let Some(i) = self.tab_by_num(n) {
                if i == src { return Err(format!("same index: {n}")) }
                if !kill { return Err(format!("index in use: {n}")) }
                // -k: that window goes (its harnesses keep running); if it was current, the moved
                // one takes its place as current.
                let gone = self.tabs.remove(i);
                self.lastw.retain(|x| *x != gone.id);
                if i == self.active { select = true; self.active = self.tabs.iter().position(|t| t.id == id).unwrap_or(0) }
                else if i < self.active { self.active -= 1 }
                // (Unlinked here; destroyed only when no other session has it.)
                if !self.linked_elsewhere(&gone.id) {
                    for p in gone.panes() { self.end_shell(p); self.drop_pane(p) }
                    if gone.on_desk { self.desk_op(json!({ "op": "tab.close", "id": gone.id })) }
                }
            }
        }
        let n = idx.unwrap_or_else(|| self.free_num());
        let old = self.nums.get(&id).copied().unwrap_or(n);
        let current = self.tabs[self.active].id.clone();
        // session_detach of the old place: the current window moved and not selected goes to the
        // last one, else the one before it by number, round to the highest.
        let leave = !select && current == id;
        self.nums.insert(id.clone(), n);
        let nums = self.nums.clone();
        self.tabs.sort_by_key(|t| nums.get(&t.id).copied().unwrap_or(usize::MAX));
        let at = self.tabs.iter().position(|t| t.id == id).unwrap_or(0);
        self.active = self.tabs.iter().position(|t| t.id == current).unwrap_or(at);
        if let Some(tab) = self.tabs.get(at).filter(|t| t.on_desk) { let op = json!({ "op": "tab.move", "id": tab.id, "index": at }); self.desk_op(op) }
        if select { self.select_tab(at) }
        else if leave {
            // session_last, else session_previous from the old number (the moved window, at its
            // new one, counts), round to the highest.
            let last = self.lastw.first().and_then(|x| self.tabs.iter().position(|t| &t.id == x)).filter(|p| *p != at);
            let before = (0..self.tabs.len()).filter(|p| self.win_num(*p) < old).max_by_key(|p| self.win_num(*p));
            let to = last.or(before).unwrap_or(self.tabs.len() - 1);
            self.select_tab(to);
            self.lastw.retain(|x| *x != id);
        }
        self.fit_panes();
        Ok(())
    }

    pub fn tab_mut(&mut self) -> &mut Tab { &mut self.tabs[self.active] }
    /// Whether every motion of the mouse is wanted: a pane here asked for it (1003), or a menu
    /// the mouse opened is up (tmux's MODE_MOUSE_ALL).
    pub fn wants_motion(&self) -> bool {
        matches!(&self.modal, Some(crate::modal::Modal::Menu(m)) if !m.no_mouse)
            // (A panel's list: the row under the mouse is the one chosen.)
            || matches!(&self.modal, Some(crate::modal::Modal::Picker { kind, .. }) if crate::settings::is_panel(kind) && !crate::theme::fzf_opts().no_mouse)
            || self.rects.iter().any(|(id, _)| self.panes.get(id).map(|p| p.mode().contains(alacritty_terminal::term::TermMode::MOUSE_MOTION)).unwrap_or(false))
    }

    pub fn focused(&self) -> Option<u64> { self.tab().focus }

    /// Everything but the status line (tmux `status-position`, bottom by default).
    /// A read-only client (attach -r, -f read-only, switch-client -r; or watching another's).
    pub fn read_only(&self) -> bool { self.client_flags.iter().any(|f| f == "read-only") || self.mirror.as_ref().is_some_and(|m| m.readonly) }

    pub fn body(&self) -> Rect {
        let n = self.status_lines();
        // hn with no terminal: the window in front's own size (its session's -x/-y, default-size)
        // — splits, resizes and layouts are worked out in it, as tmux's detached windows.
        if self.headless {
            let (w, h) = self.tabs.get(self.active).and_then(|t| t.root.as_ref().map(|r| r.size()).or(t.size)).unwrap_or_else(|| self.default_size());
            return Rect::new(0, 0, w, h);
        }
        // The bar down a side takes its columns.
        if let Some(bar) = self.bar_rect() { return Rect::new(if bar.x == 0 { bar.width } else { 0 }, 0, self.size.0.saturating_sub(bar.width), self.size.1) }
        Rect::new(0, if self.status_top { n } else { 0 }, self.size.0, self.size.1.saturating_sub(n))
    }

    /// tmux's status option: how many status lines (off, on, 2 … 5).
    pub fn status_lines(&self) -> u16 {
        // (The bar down a side is the status line: none across the bottom as well.)
        if self.bar_side().is_some() { return 0 }
        let lines = match self.options.get("status", "", None).as_deref() { Some("off") => 0, Some("2") => 2, Some("3") => 3, Some("4") => 4, Some("5") => 5, _ => 1 };
        // tmux's CLIENT_STATUSOFF: keep a pane row when the terminal cannot fit the status.
        if !self.headless && self.size.1 <= lines { 0 } else { lines }
    }

    /// A pane's own border line: tmux draws none for a lone pane, and with `pane-border-status top`
    /// a titled line above each pane when a window holds several.

    /// environ_update: each update-environment pattern's variables from hn's own environment
    /// into the session's, or the pattern cleared there when none match.
    pub fn update_environment(&mut self) {
        let u = self.environ_update();
        // Another client's session: its environment is that client's, so it is changed there
        // (one call, the variables `;`-separated) and read back.
        if let Some(m) = self.mirror.clone().filter(|_| !crate::ipc::forwarded() && !u.is_empty()) {
            let target = format!("${}", self.session_id);
            let mut words: Vec<String> = Vec::new();
            for (k, v) in &u {
                if !words.is_empty() { words.push(";".into()) }
                words.extend(["set-environment".into(), "-t".into(), target.clone()]);
                match &v.value { Some(val) => words.extend([k.clone(), val.clone()]), None => words.extend(["-r".into(), k.clone()]) }
            }
            crate::commands::forward(self, &m.owner, &words);
            crate::mirror::refresh(self);
            return;
        }
        self.session_env.extend(u)
    }

    /// environ_update: each variable update-environment names, from this client's environment —
    /// its value, or marked to be taken away (`-NAME`) when this client has none.
    pub fn environ_update(&self) -> std::collections::BTreeMap<String, EnvVar> {
        let mut out = std::collections::BTreeMap::new();
        for pattern in self.options.array("update-environment") {
            let found: Vec<(String, String)> = std::env::vars().filter(|(k, _)| crate::cmd::fnmatch(&pattern, k)).collect();
            if found.is_empty() { out.insert(pattern, EnvVar { value: None, hidden: false }); }
            for (k, v) in found { out.insert(k, EnvVar { value: Some(v), hidden: false }); }
        }
        out
    }

    /// buffer-limit: how many automatic paste buffers are kept.
    pub fn buffer_limit(&self) -> usize { self.options.get("buffer-limit", "", None).and_then(|v| v.parse().ok()).unwrap_or(50) }


    /// base-index of the session in front: the number its first window takes.
    pub fn base_index(&self) -> usize { self.options.get("base-index", "", None).and_then(|v| v.parse().ok()).unwrap_or(0) }

    /// pane-base-index for a window: the number its first pane has.
    pub fn pane_base(&self, window: usize) -> usize {
        let id = self.tabs.get(window).map(|t| t.id.as_str()).unwrap_or("");
        self.options.get("pane-base-index", id, None).and_then(|v| v.parse().ok()).unwrap_or(0)
    }

    /// A *-style option as tmux's style_add reads it for a window (and a pane): the value in force
    /// there, a format in it expanded first (options_string_to_style), parsed over no colours —
    /// its attributes and background included.
    pub fn style_of(&self, name: &str, window: usize, pane: Option<u64>) -> Style {
        crate::draw::style_over(&self.style_spec(name, window, pane), Style::default())
    }

    /// A *-style option's value in force for a window (and a pane), a format in it expanded.
    pub fn style_spec(&self, name: &str, window: usize, pane: Option<u64>) -> String {
        let id = self.tabs.get(window).map(|t| t.id.as_str()).unwrap_or("");
        let raw = self.options.get(name, id, pane).unwrap_or_default();
        if raw.contains("#{") { crate::format::expand(self, &raw, window, pane, false) } else { raw }
    }

    /// The status line's colours (status_redraw): status-style, then status-fg and status-bg
    /// where they are not `default` (NO_COLOR or not: tmux doesn't read it).
    pub fn status_style(&self) -> Style {
        let mut s = self.style_of("status-style", self.active, None);
        let mut own = !self.look.status_bg.is_none() || !self.look.status_fg.is_none();
        for (name, fg) in [("status-fg", true), ("status-bg", false)] {
            let c = self.options.get(name, "", None).and_then(|v| crate::tmuxconf::colour(&v)).filter(|c| *c != Color::Reset);
            if let Some(c) = c { own = true; s = if fg { s.fg(c) } else { s.bg(c) } }
        }
        // No status colours of its own and the terminal has told us what it looks like: the bar
        // swaps the theme's own colours — its background the terminal's foreground, its text the
        // terminal's background — so the bar is the theme's text colour with the theme's
        // background as its lettering (an ivory bar with dark text on a dark terminal), not a
        // transparent one, and not tmux's stock green.
        if !own && !self.options.pane_look() && !self.options.tmux_look() {
            let (bg, fg, _) = crate::theme::palette();
            s = s.bg(fg).fg(bg);
        }
        s
    }

    /// message-style (tmux's yellow), for messages and prompts.
    pub fn message_style(&self) -> Style {
        let mut s = self.style_of("message-style", self.active, None);
        let own = self.look.message_fg.is_some() || self.look.message_bg.is_some();
        // No message colours of its own and the terminal has told us what it looks like: the
        // message line shows the theme's readable text on the terminal's own background (left
        // transparent), so it blends with the theme instead of tmux's stock yellow.
        if !own && !self.options.tmux_look() {
            let (_, fg, _) = crate::theme::palette();
            s = s.bg(Color::Reset).fg(fg);
        }
        s
    }

    /// mode-keys as it stands (tmux's default: emacs, unless $VISUAL or $EDITOR is a vi).
    pub fn mode_keys_emacs(&self) -> bool {
        let tab = self.tabs.get(self.active).map(|t| t.id.clone()).unwrap_or_default();
        self.options.get("mode-keys", &tab, self.focused()).as_deref() != Some("vi")
    }

    /// A window's pane-border-status: the classic (default) look has none — a plain line
    /// between panes; the opt-in "panes" look and tmux's own show pane titles instead.
    pub fn pane_status(&self, tab: &Tab) -> layout::Status {
        // (A window one row tall: no room for a title row — the row is the pane's, as tmux shows it.)
        if !self.headless && self.body().height < 2 { return layout::Status::Off }
        // As tmux draws it: over a lone pane too.
        layout::Status::of(&self.options.get("pane-border-status", &tab.id, None).unwrap_or_default())
    }

    /// The structural cells used by tmux navigation and divider dragging.
    pub fn layout_content_of(&self, tab: &Tab, r: Rect) -> Rect {
        match self.pane_status(tab) {
            layout::Status::Top => Rect::new(r.x, r.y + 1, r.width, r.height.saturating_sub(1)),
            layout::Status::Bottom => Rect::new(r.x, r.y, r.width, r.height.saturating_sub(1)),
            layout::Status::Off => r,
        }
    }

    /// The program's actual viewport, shared by drawing, PTY resizing and mouse coordinates.
    pub fn content_of(&self, tab: &Tab, r: Rect) -> Rect {
        if self.options.pane_look() { crate::pane_frame::frame(r, self.window_area(tab), self.box_inner(tab), self.pane_status(tab)).content }
        else if self.options.box_panes() { crate::pane_frame::boxed_in(r, self.window_area(tab), self.box_inner(tab), self.pane_status(tab)).content }
        else { self.layout_content_of(tab, r) }
    }

    fn compute_rects(&self) -> Vec<(u64, Rect)> {
        let tab = self.tab();
        let mut out = Vec::new();
        let body = self.window_area(tab);
        if let Some(root) = &tab.root {
            if tab.zoomed { if let Some(focus) = tab.focus { return vec![(focus, body)] } }
            root.rects(body, &mut out);
        }
        out
    }

    fn content_size(&self, pane_id: u64) -> Option<(u16, u16)> {
        let rects = self.compute_rects();
        if let Some((_, r)) = rects.iter().find(|(id, _)| *id == pane_id) { let c = self.content_of(self.tab(), *r); return Some((c.width, c.height)) }
        // A pane in a background tab: size it as if its tab were showing.
        for (index, tab) in self.tabs.iter().enumerate() {
            if index == self.active { continue }
            if let Some(root) = &tab.root {
                let mut out = Vec::new();
                root.rects(self.window_area(tab), &mut out);
                if let Some((_, r)) = out.iter().find(|(id, _)| *id == pane_id) { let c = self.content_of(tab, *r); return Some((c.width, c.height)) }
            }
        }
        None
    }

    /// Where a harness is open in any of this client's sessions: the session, its window (by its
    /// number) and the pane.
    pub fn find_pane_anywhere(&self, machine_id: &str, agent_id: &str) -> Option<(u32, usize, u64)> {
        if let Some((w, p)) = self.find_pane(machine_id, agent_id) { return Some((self.session_id, self.win_num(w), p)) }
        let shows = |id: &u64| self.panes.get(id).map(|p| p.machine_id == machine_id && p.agent_id == agent_id).unwrap_or(false);
        self.sessions.iter().find_map(|s| s.tabs.iter().find_map(|t| t.panes().into_iter().find(|p| shows(p)).map(|p| (s.id, s.nums.get(&t.id).copied().unwrap_or(0), p))))
    }

    pub fn find_pane(&self, machine_id: &str, agent_id: &str) -> Option<(usize, u64)> {
        for (index, tab) in self.tabs.iter().enumerate() {
            for id in tab.panes() {
                if let Some(p) = self.panes.get(&id) { if p.machine_id == machine_id && p.agent_id == agent_id { return Some((index, id)) } }
            }
        }
        None
    }

    pub fn focus_pane(&mut self, tab: usize, pane: u64) {
        if let Some(prev) = self.focused().and_then(|f| self.panes.get(&f)).map(|p| (p.machine_id.clone(), p.agent_id.clone())) {
            if self.panes.get(&pane).map(|p| (p.machine_id.clone(), p.agent_id.clone())) != Some(prev.clone()) { self.last_harness = Some(prev) }
        }
        let changed = tab != self.active;
        if changed { self.lastw_leave(tab); self.home_order.borrow_mut().clear() }
        self.active = tab;
        self.tabs[tab].alerts = 0;
        if changed { self.tabs[tab].touch(); self.alert(tab, ACTIVITY) }
        if self.tabs[tab].zoomed && self.tabs[tab].focus != Some(pane) { self.tabs[tab].zoomed = false }
        self.tabs[tab].set_active(pane);
        self.seen(pane);
        self.sync_titles();
        self.fit_panes();
        self.refresh_pane_info(pane);
        self.take_if_watching(pane);
    }

    /// A pane you come to (a click, a key, the bar) that another window has the keyboard of is
    /// yours at once — as typing in it would make it — not "Take control" first.
    pub fn take_if_watching(&mut self, pane: u64) {
        let Some(p) = self.panes.get(&pane) else { return };
        if matches!(p.phase, Phase::Watching(_)) && !p.read_only && !p.opening { self.open_stream(pane, true) }
    }

    /// A machine's first roster since hn started, read against when you last looked at each of
    /// its harnesses: one that has done something since (its transcript changed after), and is
    /// not working or asking now, is done and unread — what finished while hn was closed.
    pub fn catch_up(&mut self, machine_id: &str) {
        if !self.seen_rostered.insert(machine_id.to_string()) { return }
        let floor = self.seen_since;
        let mut ended = Vec::new();
        for agent in self.fleet.agents.values_mut().filter(|a| a.machine_id == machine_id && a.engine != "terminal") {
            let key = (agent.machine_id.clone(), agent.id.clone());
            let seen = self.seen_at.get(&key).copied().unwrap_or(floor);
            // Working when the link went, its transcript changed since the last word from it: its
            // turn ended while the link was down (a turn still running says so again at its next
            // heartbeat). Its line asked for again.
            if agent.working && agent.usage_at > agent.active_at {
                agent.working = false;
                agent.doing = None;
                agent.did = None;
                agent.recap_asked = false;
                agent.since = agent.usage_at;
                ended.push(key.clone());
            }
            if agent.usage_at > seen && !agent.working && agent.question.is_none() && agent.status != "stopped" {
                agent.unread = true;
                if agent.since == 0 { agent.since = agent.usage_at }
            }
            // A turn that ended in an error, not looked at since: failed, with its error.
            if let Some((at, line)) = self.agent_errors.get(&key).filter(|(at, _)| *at > seen && !agent.working) {
                agent.errored = true;
                if !line.is_empty() { agent.did = Some(line.clone()) }
                if agent.since == 0 { agent.since = *at }
            }
        }
        for key in ended { crate::commands::notify_harness(self, "harness-done", &key) }
    }

    /// seen.json's path.
    fn seen_path() -> std::path::PathBuf {
        state_dir().join("seen.json")
    }

    /// When you last looked at each harness, from the run before (the first run starts the clock).
    pub fn load_seen(&mut self) {
        let doc: Value = std::fs::read_to_string(Self::seen_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        self.seen_since = doc.get("since").and_then(Value::as_u64).unwrap_or_else(fleet::now_ms);
        self.merge_seen(&doc);
        // The last time any harness was looked at: how long hn was away.
        self.back_from = self.seen_at.values().copied().max();
        self.seen_stamp = Self::seen_stamp_now();
        if doc.is_null() { self.seen_dirty = true }
    }

    fn seen_stamp_now() -> Option<(std::time::SystemTime, u64)> {
        std::fs::metadata(Self::seen_path()).ok().map(|m| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len()))
    }

    /// Another client's seen.json folded into this one's: the later look at each harness, and
    /// the errors neither has looked at since.
    fn merge_seen(&mut self, doc: &Value) {
        for (k, v) in doc.get("seen").and_then(Value::as_object).cloned().unwrap_or_default() {
            if let (Some((m, a)), Some(t)) = (k.split_once(':'), v.as_u64()) {
                let e = self.seen_at.entry((m.to_string(), a.to_string())).or_insert(0);
                *e = (*e).max(t);
            }
        }
        for (k, v) in doc.get("asked").and_then(Value::as_object).cloned().unwrap_or_default() {
            if let Some(t) = v.as_u64() { let e = self.announced.entry(k).or_insert(0); *e = (*e).max(t); }
        }
        for (k, v) in doc.get("errors").and_then(Value::as_object).cloned().unwrap_or_default() {
            let (Some((m, a)), Some(at)) = (k.split_once(':'), v.get("at").and_then(Value::as_u64)) else { continue };
            let key = (m.to_string(), a.to_string());
            let line = v.get("line").and_then(Value::as_str).unwrap_or("").to_string();
            if self.agent_errors.get(&key).map(|(t, _)| *t < at).unwrap_or(true) { self.agent_errors.insert(key, (at, line)); }
        }
        let seen = &self.seen_at;
        self.agent_errors.retain(|k, (at, _)| seen.get(k).map(|s| *s < *at).unwrap_or(true));
    }

    pub fn save_seen(&mut self) {
        if !self.seen_dirty { return }
        self.seen_dirty = false;
        // Whatever another terminal wrote meanwhile, kept.
        let doc: Value = std::fs::read_to_string(Self::seen_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        self.merge_seen(&doc);
        let seen: serde_json::Map<String, Value> = self.seen_at.iter().map(|((m, a), t)| (format!("{m}:{a}"), json!(t))).collect();
        let errors: serde_json::Map<String, Value> = self.agent_errors.iter().map(|((m, a), (at, line))| (format!("{m}:{a}"), json!({ "at": at, "line": line }))).collect();
        // (A week of them: a question open longer than that is asked again.)
        let week = fleet::now_ms().saturating_sub(7 * 24 * 3600 * 1000);
        self.announced.retain(|_, t| *t >= week);
        let asked: serde_json::Map<String, Value> = self.announced.iter().map(|(k, t)| (k.clone(), json!(t))).collect();
        let path = Self::seen_path();
        if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
        let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        if std::fs::write(&temp, json!({ "since": self.seen_since, "seen": seen, "errors": errors, "asked": asked }).to_string()).is_ok() { let _ = std::fs::rename(temp, path); }
        self.seen_stamp = Self::seen_stamp_now();
    }

    /// Read in what another terminal looked at (its seen.json write): those harnesses' ✓ and ✗
    /// go here too.
    pub fn reread_seen(&mut self) {
        let stamp = Self::seen_stamp_now();
        if stamp.is_none() || stamp == self.seen_stamp { return }
        self.seen_stamp = stamp;
        let doc: Value = std::fs::read_to_string(Self::seen_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        self.merge_seen(&doc);
        for agent in self.fleet.agents.values_mut() {
            let key = (agent.machine_id.clone(), agent.id.clone());
            let Some(seen) = self.seen_at.get(&key).copied() else { continue };
            if agent.unread && seen >= agent.usage_at && seen >= agent.since { agent.unread = false }
            if agent.errored && !self.agent_errors.contains_key(&key) { agent.errored = false }
        }
    }

    /// You have looked at this harness now.
    pub fn mark_seen_key(&mut self, key: (String, String)) {
        self.agent_errors.remove(&key);
        self.seen_at.insert(key, fleet::now_ms());
        self.seen_dirty = true;
    }

    pub fn seen(&mut self, pane: u64) {
        let Some(p) = self.panes.get(&pane) else { return };
        let key = (p.machine_id.clone(), p.agent_id.clone());
        self.mark_seen_key(key.clone());
        if let Some(agent) = self.fleet.agents.get_mut(&key) {
            // Looked at here (an error it ended in too): the dial takes its notification away.
            agent.errored = false;
            if std::mem::take(&mut agent.unread) { crate::dial::seen(self, &key.1) }
        }
    }

    pub fn visible_agents(&self) -> Vec<(String, String)> {
        self.rects.iter().filter_map(|(id, _)| self.panes.get(id)).map(|p| (p.machine_id.clone(), p.agent_id.clone())).collect()
    }

    pub fn new_pane(&mut self, machine_id: &str, agent_id: &str) -> u64 { self.new_pane_as(machine_id, agent_id, None) }

    /// A pane for a harness, with the id it had ([id]: a session moved from another client, a
    /// desk's pane), else a new one (tmux's %N, unique among the clients of this server name).
    pub fn new_pane_as(&mut self, machine_id: &str, agent_id: &str, id: Option<u64>) -> u64 {
        if crate::local::is_local(machine_id) { self.ensure_local_shells(); }
        let id = id.or_else(|| crate::local::is_local(machine_id).then(|| crate::local::pane_id(agent_id)).flatten());
        let id = id.filter(|i| !self.panes.contains_key(i)).unwrap_or_else(|| crate::ids::next(crate::ids::Kind::Pane));
        let (cols, rows) = pane::stream_size(self.size.0, self.size.1.saturating_sub(2));
        self.panes.insert(id, Pane::new(id, machine_id, agent_id, cols, rows));
        id
    }

    /// Put a harness on screen. Already showing somewhere: go there instead.
    pub fn open_agent(&mut self, machine_id: &str, agent_id: &str, placement: Placement) {
        if let Placement::Fill(tab_id) = &placement {
            let id = self.new_pane(machine_id, agent_id);
            let (w, h) = (self.body().width, self.body().height);
            let here = self.tabs.iter().position(|t| &t.id == tab_id);
            let tab = match here { Some(i) => Some(&mut self.tabs[i]), None => self.sessions.iter_mut().flat_map(|s| s.tabs.iter_mut()).find(|t| &t.id == tab_id) };
            match tab {
                Some(t) if t.root.is_none() => { let (w, h) = t.size.unwrap_or((w, h)); t.root = Some(Node::new(id, w, h)); t.focus = Some(id) }
                _ => { self.end_shell(id); self.drop_pane(id); return }
            }
            // A newly created shell must start even if its window is now in the background.
            self.open_stream(id, true);
            if let Some(index) = here.filter(|i| !self.tabs[*i].first_named) { self.name_tab_after_first_at(index) }
            self.fit_panes();
            if here.is_some() && self.session_desk { self.desk_pane_added(tab_id, machine_id, agent_id) }
            self.save_sessions();
            return;
        }
        // Selecting a harness from home replaces its unused shell. Creating that backing
        // shell uses Fill above, so it leaves the home page visible.
        let was_home = self.tab().home;
        let placement = if was_home && matches!(placement, Placement::Auto(None) | Placement::Tab) { Placement::Replace } else { placement };
        if was_home {
            self.tab_mut().home = false;
            if placement == Placement::Replace { if let Some(p) = self.focused() { self.end_shell(p) } }
        }
        if placement != Placement::Replace && placement != Placement::Window {
            // Open in another session of this client: that session, as tmux's chooser goes there.
            if self.find_pane(machine_id, agent_id).is_none() {
                if let Some((sid, _, _)) = self.find_pane_anywhere(machine_id, agent_id) { self.switch_session(sid) }
            }
            if let Some((tab, pane)) = self.find_pane(machine_id, agent_id) {
                // One harness, one pane: say where it went rather than splitting a second copy.
                if tab != self.active && matches!(placement, Placement::Split(_)) {
                    let name = self.fleet.agent(machine_id, agent_id).map(|a| a.name.clone()).unwrap_or_default();
                    self.say(format!("{name} is already in window {}", self.win_num(tab)), crate::theme::WARN);
                }
                self.focus_pane(tab, pane);
                return;
            }
        }
        let id = self.new_pane(machine_id, agent_id);
        if let Placement::At(at) = &placement {
            let Some(t) = self.tabs.iter().position(|x| x.id == at.tab) else { self.end_shell(id); self.drop_pane(id); return };
            if !self.split_at(t, id, at) { self.end_shell(id); self.drop_pane(id); self.error("no space for new pane"); return }
            let tab = &mut self.tabs[t];
            tab.add_pane(id, at.pane, at.before, at.full);
            // The new shell's first output is the window's activity (its time, not an alert).
            tab.touch();
            // tmux takes a zoomed window out of zoom (-Z: zooms its active pane after); the new
            // pane is its active one unless -d.
            if !at.detached || tab.focus.is_none() { tab.set_active(id) }
            tab.zoomed = at.zoom && tab.panes().len() > 1;
            let tab_id = tab.id.clone();
            self.open_stream(id, true);
            self.fit_panes();
            self.desk_pane_added(&tab_id, machine_id, agent_id);
            self.layout_changed(t);
            return;
        }
        let empty = self.tab().root.is_none();
        match (placement, empty) {
            (Placement::Tab, false) | (Placement::Window, false) => {
                let name = self.fleet.agent(machine_id, agent_id).map(|a| a.name.clone()).unwrap_or_else(|| "tab".into());
                let mut tab = Tab::new(&name);
                tab.root = Some(Node::new(id, self.size.0, self.size.1.saturating_sub(1)));
                tab.focus = Some(id);
                // As new-window: the first free index, in its place in the order.
                self.renumber();
                { let id = self.tabs[self.active].id.clone(); self.lastw_push(id) }
                let n = self.free_num();
                self.nums.insert(tab.id.clone(), n);
                let at = self.tabs.iter().position(|t| self.nums.get(&t.id).map(|m| *m > n).unwrap_or(false)).unwrap_or(self.tabs.len());
                self.tabs.insert(at, tab);
                self.active = at;
            }
            (_, true) => {
                let body = self.body();
                let tab = self.tab_mut();
                let (w, h) = tab.size.unwrap_or((body.width, body.height));
                tab.root = Some(Node::new(id, w, h));
                tab.focus = Some(id);
            }
            (Placement::Replace, false) => {
                let Some(focus) = self.focused() else { return };
                let old = focus;
                if let Some(p) = self.panes.get(&old) {
                    let op = json!({ "op": "pane.remove", "tabId": self.tab().id, "machineId": p.machine_id, "agentId": p.agent_id });
                    if self.tab().on_desk { self.desk_op(op) }
                }
                if let Some(root) = self.tab_mut().root.as_mut() { root.replace(old, id); }
                let tab = self.tab_mut();
                for p in tab.order.iter_mut().chain(tab.last.iter_mut()) { if *p == old { *p = id } }
                tab.focus = Some(id);
                self.drop_pane(old);
            }
            (Placement::At(_), _) | (Placement::Fill(_), _) => {}
            (Placement::Split(dir), false) | (Placement::Auto(Some(dir)), false) => { if !self.split_focused(id, dir) { self.drop_pane(id); self.error("no space for new pane"); return } let t = self.active; self.layout_changed(t) }
            (Placement::Auto(None), false) => {
                let dir = self.smart_dir();
                if !self.split_focused(id, dir) { self.drop_pane(id); self.error("no space for new pane"); return }
                let t = self.active;
                self.layout_changed(t);
            }
        }
        self.tab_mut().zoomed = false;
        self.name_tab_after_first();
        // The person asked for THIS harness: open it as the controller before the layout pass,
        // which would otherwise open it as a mere watcher of whoever has it elsewhere.
        self.open_stream(id, true);
        self.fit_panes();
        self.seen(id);
        let tab_id = self.tab().id.clone();
        self.desk_pane_added(&tab_id, machine_id, agent_id);
    }

    /// split-window's (and join-pane's) split: `id` gets a cell beside `at.pane` (-b before it,
    /// -f across the window) of `at.size`; false, and nothing changed, when there is no room.
    /// Whether split_at would find room (spawn_pane's check before anything is made): tried on a
    /// copy of the window's layout.
    pub fn can_split(&mut self, at: &At) -> bool {
        let Some(t) = self.tabs.iter().position(|x| x.id == at.tab) else { return false };
        let saved = (self.tabs[t].root.clone(), self.tabs[t].zoomed);
        let ok = self.split_at(t, u64::MAX - 1, at);
        let tab = &mut self.tabs[t];
        (tab.root, tab.zoomed) = saved;
        ok
    }

    fn split_at(&mut self, t: usize, id: u64, at: &At) -> bool {
        let body = self.body();
        // -l n%: of the target pane's width or height (-f: the window's), measured as tmux
        // measures it — before a zoomed window is unzoomed.
        let cur = if at.full {
            let (w, h) = self.tabs[t].root.as_ref().map(|r| r.size()).unwrap_or((body.width, body.height));
            if at.dir == Dir::Horizontal { w } else { h }
        } else {
            at.pane.and_then(|p| crate::format::layout_rect(self, t, p)).map(|r| if at.dir == Dir::Horizontal { r.width } else { r.height }).unwrap_or(0)
        };
        let size = at.size.map(|(n, pct)| if pct { cur as u32 * n as u32 / 100 } else { n as u32 });
        self.fit_panes_of(t);
        let tab = &mut self.tabs[t];
        tab.zoomed = false;
        tab.home = false;
        match tab.root.as_mut() {
            None => { tab.root = Some(Node::new(id, body.width, body.height)); true }
            Some(root) => root.split_with(at.pane, id, at.dir, size, at.before, at.full || at.pane.is_none()),
        }
    }

    /// A pane leaves its window but not the screen (join-pane, break-pane): its harness and
    /// stream go on, its id with it; a window left empty closes.
    fn unhook_pane(&mut self, id: u64) {
        let Some(index) = self.tabs.iter().position(|t| t.panes().contains(&id)) else { return };
        let tab = &mut self.tabs[index];
        tab.lose(id);
        tab.root = tab.root.take().and_then(|root| root.remove(id));
        tab.zoomed = false;
        let tab_id = tab.id.clone();
        if let Some(p) = self.panes.get(&id) { let op = json!({ "op": "pane.remove", "tabId": tab_id, "machineId": p.machine_id, "agentId": p.agent_id }); self.desk_op(op) }
        if self.tabs[index].root.is_none() && self.tabs.len() > 1 { self.close_tab(index) }
        else if self.tabs[index].root.is_none() && !self.tabs[index].named { self.tabs[index].name = "home".into() }
    }

    /// tmux's join-pane / move-pane: `src` splits `at.pane` where `at` says, keeping its id; in
    /// the list it goes after the target (before it with -b), -f or not. Not -d: its window
    /// becomes the current one with it active.
    pub fn join_pane(&mut self, src: u64, at: At) -> Result<(), String> {
        let Some(t) = self.tabs.iter().position(|x| x.id == at.tab) else { return Err("can't find window".into()) };
        let Some(dst) = at.pane else { return Err("can't find pane".into()) };
        if src == dst { return Err("source and target panes must be different".into()) }
        // The room is made first: no room, and nothing moves.
        const SLOT: u64 = u64::MAX;
        if !self.split_at(t, SLOT, &at) { return Err("create pane failed: pane too small".into()) }
        let point = self.tabs.iter().find_map(|x| x.points.get(&src).copied());
        let from = self.tabs.iter().position(|x| x.panes().contains(&src) && x.id != at.tab);
        let from_id = from.map(|w| self.tabs[w].id.clone());
        match from {
            Some(_) => self.unhook_pane(src),
            None => {
                // Within the window: its old cell closes, the list forgets it.
                let tab = &mut self.tabs[t];
                tab.lose(src);
                tab.root = tab.root.take().and_then(|root| root.remove(src));
            }
        }
        let Some(t) = self.tabs.iter().position(|x| x.id == at.tab) else { return Ok(()) };
        let tab = &mut self.tabs[t];
        if let Some(root) = tab.root.as_mut() { root.replace(SLOT, src); }
        tab.add_pane(src, Some(dst), at.before, false);
        if let Some(p) = point { tab.points.insert(src, p); }
        tab.zoomed = false;
        let (machine, agent) = self.panes.get(&src).map(|p| (p.machine_id.clone(), p.agent_id.clone())).unwrap_or_default();
        if !at.detached { self.tabs[t].set_active(src); self.focus_pane(t, src) }
        let tab_id = self.tabs[t].id.clone();
        self.desk_pane_added(&tab_id, &machine, &agent);
        self.sync_titles();
        self.fit_panes();
        // cmd-join-pane.c: the window it left (if it is still there), then this one.
        if let Some(w) = from_id.and_then(|id| self.tabs.iter().position(|x| x.id == id)) { self.layout_changed(w) }
        self.layout_changed(t);
        Ok(())
    }

    /// A window taken out of the session in front (it moves to another session), its harnesses
    /// still in its panes: its number freed, the current window kept; the desk told it closed.
    pub fn take_tab(&mut self, index: usize) -> Tab {
        let current = index == self.active;
        let mut tab = self.tabs.remove(index);
        if self.nums.remove(&tab.id).is_some() { self.window_gone = true }
        self.lastw.retain(|x| *x != tab.id);
        if index < self.active { self.active -= 1 }
        if self.tabs.is_empty() { self.tabs.push(Tab::home()) }
        self.active = self.active.min(self.tabs.len() - 1);
        // session_detach: the current window gone, the last one is current (session_last), else
        // the one before it, round.
        if current && self.tabs.len() > 0 {
            let last = self.lastw.first().and_then(|id| self.tabs.iter().position(|t| &t.id == id));
            self.active = last.unwrap_or(if index > 0 { index - 1 } else { self.tabs.len() - 1 }).min(self.tabs.len() - 1);
            if let Some(i) = last { let id = self.tabs[i].id.clone(); self.lastw.retain(|x| *x != id) }
        }
        if tab.on_desk && self.session_desk { self.desk_op(json!({ "op": "tab.close", "id": tab.id })) }
        tab.on_desk = false;
        tab
    }

    /// A window from another session, put in the one in front: at [index] numbered [num], else
    /// last with a number past every other (for move-window to give it its own); the desk's
    /// session tells the desk. Where it went.
    pub fn put_tab(&mut self, tab: Tab, at: Option<(usize, usize)>) -> usize {
        let (index, num) = at.unwrap_or((self.tabs.len(), usize::MAX / 2));
        let index = index.min(self.tabs.len());
        let id = tab.id.clone();
        let panes: Vec<(String, String)> = tab.panes().iter().filter_map(|p| self.panes.get(p).map(|x| (x.machine_id.clone(), x.agent_id.clone()))).collect();
        self.nums.insert(id.clone(), num);
        self.tabs.insert(index, tab);
        if index <= self.active && self.tabs.len() > 1 { self.active += 1 }
        // The placeholder of a session that had none (the current one then, or before it).
        if let Some(home) = self.tabs.iter().position(|t| t.root.is_none() && t.id != id) { self.tabs.remove(home); if home <= self.active && self.active > 0 { self.active -= 1 } }
        self.active = self.active.min(self.tabs.len() - 1);
        for (m, a) in panes { self.desk_pane_added(&id, &m, &a) }
        self.fit_panes();
        self.tabs.iter().position(|t| t.id == id).unwrap_or(0)
    }

    /// A pane taken out of its window in the session in front (it moves to another session), its
    /// harness still running: a window it leaves empty goes.
    pub fn take_pane(&mut self, pane: u64) {
        let Some(index) = self.tabs.iter().position(|t| t.panes().contains(&pane)) else { return };
        let tab = &mut self.tabs[index];
        tab.lose(pane);
        tab.root = tab.root.take().and_then(|root| root.remove(pane));
        tab.zoomed = false;
        let tab_id = tab.id.clone();
        if let Some(p) = self.panes.get(&pane) { let op = json!({ "op": "pane.remove", "tabId": tab_id, "machineId": p.machine_id, "agentId": p.agent_id }); self.desk_op(op) }
        if self.tabs[index].root.is_none() { self.take_tab(index); } else { self.layout_changed(index); self.fit_panes() }
    }

    /// A window of one pane (a pane from another session), named [name], put last in the
    /// session in front.
    pub fn tab_of_pane(&mut self, pane: u64, name: &str) -> usize {
        let mut tab = Tab::new(name);
        tab.root = Some(Node::new(pane, self.size.0, self.size.1.saturating_sub(1)));
        tab.order = vec![pane];
        tab.focus = Some(pane);
        self.put_tab(tab, None)
    }

    /// Whether the session in front has a window with a pane in it.
    pub fn has_windows(&self) -> bool { self.tabs.iter().any(|t| t.root.is_some()) }

    /// Whether this client has a session of its own: any but the desk's, and the one it started
    /// in only once it has a window (a headless client goes when it has none).
    pub fn holds_sessions(&self) -> bool {
        let first = self.first_session;
        let real = |id: u32, desk: bool, windows: bool| windows || (!desk && id != first);
        real(self.session_id, self.session_desk, self.has_windows()) || self.sessions.iter().any(|s| real(s.id, s.desk, s.tabs.iter().any(|t| t.root.is_some())))
    }

    /// tmux's break-pane: the pane becomes a window of its own (keeping its id), at the first
    /// free index or `num`; -d: not gone to.
    pub fn break_pane(&mut self, src: u64, name: Option<String>, num: Option<usize>, detached: bool) -> Result<(), String> {
        let Some(from) = self.tabs.iter().position(|t| t.panes().contains(&src)) else { return Err("can't find pane".into()) };
        // A window of one pane moves whole (cmd-break-pane.c's server_link_window): its id and
        // name kept, to -t's index or the next free one.
        if self.tabs[from].panes().len() < 2 {
            if let Some(n) = name { self.name_window(from, &n) }
            return self.move_window(from, num, false, !detached);
        }
        self.renumber();
        let n = match num { Some(n) => { if self.tab_by_num(n).is_some() { return Err(format!("index in use: {n}")) } n } None => self.free_num() };
        let back = self.tabs[self.active].id.clone();
        let point = self.tabs[from].points.get(&src).copied();
        self.unhook_pane(src);
        // layout_close_pane in the window it leaves.
        self.layout_changed(from);
        let label = name.clone().or_else(|| self.panes.get(&src).and_then(|p| self.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| a.name.clone())).unwrap_or_else(|| "tab".into());
        let mut tab = Tab::new(&label);
        tab.named = name.is_some();
        tab.root = Some(Node::new(src, self.size.0, self.size.1.saturating_sub(1)));
        tab.order = vec![src];
        tab.focus = Some(src);
        if let Some(p) = point { tab.points.insert(src, p); }
        let tab_id = tab.id.clone();
        self.nums.insert(tab_id.clone(), n);
        let at = self.tabs.iter().position(|t| self.nums.get(&t.id).map(|m| *m > n).unwrap_or(false)).unwrap_or(self.tabs.len());
        self.tabs.insert(at, tab);
        self.sync_titles();
        if detached {
            if let Some(i) = self.tabs.iter().position(|t| t.id == back) { self.active = i }
            // window_create: the new window is activity, flagged as it is not the current one.
            self.alert(at, ACTIVITY);
        } else {
            let prev = self.tabs.iter().position(|t| t.id == back);
            if let Some(i) = prev { self.active = i }
            self.select_tab(at);
        }
        let (machine, agent) = self.panes.get(&src).map(|p| (p.machine_id.clone(), p.agent_id.clone())).unwrap_or_default();
        self.desk_pane_added(&tab_id, &machine, &agent);
        self.sync_titles();
        self.fit_panes();
        Ok(())
    }

    fn split_focused(&mut self, id: u64, dir: Dir) -> bool {
        let focus = self.focused();
        let body = self.body();
        let active = self.active;
        self.fit_panes_of(active);
        let tab = self.tab_mut();
        let placed = match (tab.root.as_mut(), focus) {
            (Some(root), Some(focus)) => root.split(focus, id, dir),
            _ => { tab.root = Some(Node::new(id, body.width, body.height)); true }
        };
        if placed { tab.add_pane(id, focus, false, false); tab.set_active(id) }
        placed
    }

    /// Wide tiles split left|right, tall ones top/bottom — the way a tiling window manager does —
    /// unless `@hn-layout` (`[look].layout_orientation`) pins it to vertical or horizontal.
    pub fn smart_dir(&self) -> Dir {
        match self.options.look_orientation() {
            "vertical" => return Dir::Vertical,
            "horizontal" => return Dir::Horizontal,
            _ => {}
        }
        let Some(focus) = self.focused() else { return Dir::Horizontal };
        let rect = self.rects.iter().find(|(id, _)| *id == focus).map(|(_, r)| *r).unwrap_or(self.body());
        if rect.width as f32 >= rect.height as f32 * 2.2 { Dir::Horizontal } else { Dir::Vertical }
    }

    fn name_tab_after_first(&mut self) { self.name_tab_after_first_at(self.active) }

    fn name_tab_after_first_at(&mut self, index: usize) {
        let tab = &self.tabs[index];
        if tab.named || tab.home { return }
        let Some(first) = tab.panes().first().copied() else { return };
        let name = self.panes.get(&first).and_then(|p| self.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| a.name.clone());
        if let Some(name) = name { self.tabs[index].name = name }
    }

    pub fn sync_titles(&mut self) {
        for index in 0..self.tabs.len() {
            if self.tabs[index].named || self.tabs[index].home { continue }
            // tmux's automatic-rename (unless it is off): an unnamed window is called after its
            // active pane — a shell by what runs in it (automatic-rename-format: `zsh`, `vim`,
            // `[tmux]` in copy mode), a harness by its name.
            let tab_id = self.tabs[index].id.clone();
            let off = self.options.get("automatic-rename", &tab_id, None).as_deref() == Some("off");
            if off && self.tabs[index].first_named { continue }
            let first = self.tabs[index].focus.or_else(|| self.tabs[index].panes().first().copied());
            let Some(id) = first else { continue };
            let Some(pane) = self.panes.get(&id) else { continue };
            // Off: a shell is named once by its command, as tmux names a window when it makes it
            // (a harness keeps its own name).
            if off {
                let agent = self.fleet.agent(&pane.machine_id, &pane.agent_id);
                if agent.map(|a| a.engine != "terminal").unwrap_or(false) { self.tabs[index].first_named = true; continue }
                let Some(cmd) = pane.fg_command.clone() else { continue };
                let name = cmd.split_whitespace().next().unwrap_or("").rsplit('/').next().unwrap_or("").to_string();
                if !name.is_empty() { self.tabs[index].name = name; self.tabs[index].first_named = true }
                continue;
            }
            // (A harness this client has not heard of yet — another terminal's new shell — is
            // named by what runs in it, when that is known.)
            let agent = self.fleet.agent(&pane.machine_id, &pane.agent_id);
            let shell = agent.map(|a| a.engine == "terminal").unwrap_or(true);
            let name = if shell && pane.fg_command.is_some() {
                let fmt = self.options.get("automatic-rename-format", &tab_id, Some(id)).unwrap_or_default();
                crate::format::expand(self, &fmt, index, Some(id), false)
            } else { match agent { Some(a) => a.name.clone(), None => continue } };
            if !name.is_empty() { self.tabs[index].name = name }
        }
    }

    /// A pane's terminal closed here and the pane forgotten, its harness left running (a pane of
    /// another client's session).
    pub fn forget_pane(&mut self, id: u64) {
        let mark = (self.marked, self.marked_session);
        self.drop_pane(id);
        (self.marked, self.marked_session) = mark;
    }

    fn drop_pane(&mut self, id: u64) {
        if self.marked == Some(id) { self.marked = None; self.marked_session = None; self.server_dirty = true }
        self.pipes.remove(&id);
        if let Some(pane) = self.panes.remove(&id) {
            if let (Some(stream), Some(link)) = (pane.stream, self.links.get(&pane.machine_id).and_then(|s| s.link.clone())) {
                link.send("terminal_close", json!({ "streamId": stream.to_string() }));
            }
        }
    }

    /// A shell hn made (new-window, a split, the one it started with) goes when its pane is
    /// killed, as tmux kills the pane's shell; an agent keeps running.
    fn end_shell(&mut self, id: u64) {
        let Some(key) = self.panes.get(&id).map(|p| (p.machine_id.clone(), p.agent_id.clone())).filter(|k| self.shells.remove(k)) else { return };
        if let Some(link) = self.link(&key.0) {
            let agent_id = key.1;
            self.spawn(async move { link.rpc("agent_delete", json!({ "agentId": agent_id }), Duration::from_secs(30)).await }, |_, _| {});
        }
    }

    pub fn close_pane(&mut self, id: u64) {
        let Some(index) = self.tabs.iter().position(|t| t.panes().contains(&id)) else { return };
        let agent = self.panes.get(&id).map(|p| (p.machine_id.clone(), p.agent_id.clone()));
        self.end_shell(id);
        let tab = &mut self.tabs[index];
        tab.lose(id);
        tab.root = tab.root.take().and_then(|root| root.remove(id));
        tab.zoomed = false;
        let tab_id = tab.id.clone();
        self.drop_pane(id);
        if let Some((machine, agent)) = agent { self.desk_op(json!({ "op": "pane.remove", "tabId": tab_id, "machineId": machine, "agentId": agent })) }
        // A window whose last pane went goes too — the last one ending hn, as tmux ends.
        if self.tabs[index].root.is_none() { self.close_tab(index) }
        // layout_close_pane: the window's other panes take the room.
        else { self.layout_changed(index) }
        self.sync_titles();
        self.fit_panes();
    }

    pub fn close_tab(&mut self, index: usize) {
        if index >= self.tabs.len() { return }
        // session_detach: closing the current window goes to the last one (session_last), else
        // the one before it by number, round to the highest (session_previous).
        if index == self.active && self.tabs.len() > 1 {
            let last = self.lastw.first().and_then(|id| self.tabs.iter().position(|t| &t.id == id)).filter(|p| *p != index);
            let to = last.unwrap_or(if index > 0 { index - 1 } else { self.tabs.len() - 1 });
            self.select_tab(to);
        }
        let tab = self.tabs.remove(index);
        self.lastw.retain(|id| *id != tab.id);
        // Its window-unlinked: said here for a session not in front (a command there), which
        // notify_changes does not see, and when the session goes with it.
        let elsewhere = self.swap_back.is_some_and(|b| b != self.session_id);
        let gone = (self.session_id, self.session_name(), tab.wid(), tab.name.clone());
        let unlinked = |app: &mut App, g: (u32, String, u64, String)| crate::commands::notify_session(app, "window-unlinked", g.0, &g.1, Some((g.2, g.3)));
        // A window in other sessions too (link-window, a group): unlinked here only when this
        // session goes or unlink-window asks (the window lives on there); killed, it goes from
        // them all (sync_links).
        let linked = self.linked_elsewhere(&tab.id);
        if !(linked && (self.unlinking || self.killing_session)) {
            if linked { self.killed_windows.push(tab.id.clone()) }
            for id in tab.panes() { self.end_shell(id); self.drop_pane(id) }
            if tab.on_desk { self.desk_op(json!({ "op": "tab.close", "id": tab.id })) }
        }
        // The last window gone: the session is over (tmux's `[exited]` when it was the last).
        if self.tabs.is_empty() {
            self.tabs.push(Tab::home());
            self.active = 0;
            if self.killing_session {
                // kill-session (session_destroy): session-closed, then its windows unlinked.
                self.notify_closed();
                for g in std::mem::take(&mut self.unlinked_later) { unlinked(self, g) }
                unlinked(self, gone);
            } else {
                // Its last window killed: the window unlinked, then the session closed.
                unlinked(self, gone);
                self.notify_closed();
            }
            self.session_gone_quiet();
            self.fit_panes();
            return;
        }
        if index < self.active || self.active >= self.tabs.len() { self.active = self.active.saturating_sub(1).min(self.tabs.len() - 1) }
        if self.killing_session { self.unlinked_later.push(gone) } else if elsewhere { unlinked(self, gone) }
        self.fit_panes();
    }

    /// The event hooks (notify.c) for what changed since they were last told: windows unlinked,
    /// linked and renamed, a layout changed, the active pane of a window, the current window,
    /// pane focus (the current window's active pane, while the terminal has focus and no menu is
    /// over it), a pane entering or leaving a mode, the session renamed. The first look only
    /// takes note.
    fn hooks_snapshot(&self) -> HooksSeen {
        // tmux's CLIENT_FOCUSED: set when the client attaches; only focus-events brings the
        // terminal's focus reports that clear and set it again.
        let focus_events = self.options.get("focus-events", "", None).as_deref() == Some("on");
        let client = !focus_events || self.terminal_focused;
        HooksSeen {
            ready: true,
            session_id: self.session_id,
            titles: self.panes.iter().map(|(id, p)| (*id, (p.title.clone(), p.osc_title.clone()))).collect(),
            windows: self.tabs.iter().map(|t| (t.id.clone(), t.has_wid(), t.name.clone(), t.focus, t.root.as_ref().map(|r| r.to_tmux()).unwrap_or_default())).collect(),
            current: self.tabs.get(self.active).map(|t| t.id.clone()),
            client,
            modes: self.panes.values().filter(|p| p.in_mode()).map(|p| p.id).collect(),
            focused: self.hooks_seen.focused.clone(),
        }
    }

    /// What the hooks have seen is how things stand now (another client did it, and ran them).
    pub fn hooks_seen_now(&mut self) { if self.hooks_seen.ready { self.hooks_seen = self.hooks_snapshot() } }

    pub fn notify_changes(&mut self) {
        let resized = std::mem::take(&mut self.pending_resize_hooks);
        let focus_events = self.options.get("focus-events", "", None).as_deref() == Some("on");
        let mut now = self.hooks_snapshot();
        let before = std::mem::replace(&mut self.hooks_seen, now.clone());
        if self.quit && self.exited { return }
        // Another session in front: client-session-changed, and its windows are not new.
        if before.ready && before.session_id != now.session_id {
            crate::commands::notify(self, "client-session-changed", Some(self.active), None);
            return;
        }
        if !before.ready {
            // The client attached (server_client_set_session): the current pane takes focus.
            if let Some(p) = self.focused() { self.update_focus(p, &mut now.focused, false) }
            self.hooks_seen.focused = now.focused;
            return;
        }
        for (id, title) in &now.titles {
            if before.titles.get(id).is_some_and(|old| old != title) {
                if let Some(w) = self.tabs.iter().position(|t| t.panes().contains(id)) { crate::commands::notify(self, "pane-title-changed", Some(w), Some(*id)) }
            }
        }
        let at = |app: &App, id: &str| app.tabs.iter().position(|t| t.id == id);
        // (An empty window never numbered was never one: the one a client started in.)
        for (_, wid, name, _, _) in before.windows.iter().filter(|w| !now.windows.iter().any(|n| n.0 == w.0)) {
            if let Some(wid) = wid { crate::commands::notify_gone(self, "window-unlinked", *wid, name) }
        }
        for (id, ..) in now.windows.iter().filter(|w| !before.windows.iter().any(|b| b.0 == w.0)) {
            if let Some(w) = at(self, id) { crate::commands::notify(self, "window-linked", Some(w), None) }
        }
        for (id, _, name, focus, layout) in now.windows.iter() {
            let Some(old) = before.windows.iter().find(|b| &b.0 == id) else { continue };
            let Some(w) = at(self, id) else { continue };
            if &old.2 != name { crate::commands::notify(self, "window-renamed", Some(w), None) }
            let _ = layout;
            if &old.3 != focus && old.3.is_some() { crate::commands::notify(self, "window-pane-changed", Some(w), None) }
        }
        if before.current != now.current && before.current.is_some() { let (sid, name) = (self.session_id, self.session_name()); crate::commands::notify_session(self, "session-window-changed", sid, &name, None) }
        // Fitting a shared layout to this terminal fires tmux's resize hook, but is not
        // a new desk arrangement. Publishing it makes differently sized clients resize
        // one another indefinitely. Explicit layout/divider edits use layout_changed.
        for id in resized { if let Some(w) = at(self, &id) { crate::commands::notify(self, "window-layout-changed", Some(w), None) } }
        // Pane focus (window_pane_update_focus), where tmux looks again: a window's active pane
        // that changed and a window that became current only with focus-events; a window whose
        // active pane went away (window_lost_pane), and the client's own focus, always.
        let mut focused = now.focused.clone();
        focused.retain(|p| self.panes.contains_key(p));
        let old_window_active = |id: &str| before.windows.iter().find(|w| w.0 == id).and_then(|w| w.3);
        if before.current != now.current && focus_events {
            if let Some(p) = before.current.as_deref().and_then(old_window_active) { self.update_focus(p, &mut focused, true) }
            if let Some(p) = self.focused() { self.update_focus(p, &mut focused, true) }
        }
        for (id, _, _, focus, _) in now.windows.iter() {
            let Some(old) = before.windows.iter().find(|b| &b.0 == id).and_then(|b| b.3) else { continue };
            let Some(new) = *focus else { continue };
            if old == new { continue }
            // window_lost_pane: the active pane left this window (closed, or moved to another).
            let lost = !self.tabs.iter().find(|t| &t.id == id).map(|t| t.panes().contains(&old)).unwrap_or(false);
            if lost {
                let then = before.current.as_deref().and_then(|c| self.tabs.iter().position(|t| t.id == c)).unwrap_or(self.active);
                self.update_focus_in(new, &mut focused, true, then)
            }
            else if focus_events { self.update_focus(old, &mut focused, true); self.update_focus(new, &mut focused, true) }
        }
        if before.client != now.client { if let Some(p) = self.focused() { self.update_focus(p, &mut focused, true) } }
        self.hooks_seen.focused = focused;
        let changed: Vec<u64> = now.modes.iter().filter(|p| !before.modes.contains(p)).chain(before.modes.iter().filter(|p| !now.modes.contains(p))).copied().filter(|p| self.panes.contains_key(p)).collect();
        for p in changed {
            let w = self.tabs.iter().position(|t| t.panes().contains(&p));
            crate::commands::notify(self, "pane-mode-changed", w, Some(p));
        }
    }

    /// notify_window("window-layout-changed"), where tmux calls it: each preset (layout-set.c),
    /// a layout string applied, select-layout's own after either, every resize
    /// (layout_resize_layout), zoom and unzoom, a pane split in (spawn_pane) or closed
    /// (layout_close_pane), swap-pane and join-pane in each window.
    pub fn layout_changed(&mut self, t: usize) {
        // A desk window's layout changed here: every terminal lays it out so (sent once the
        // loop comes round).
        if self.session_desk { if let Some(tab) = self.tabs.get_mut(t).filter(|t| t.on_desk) {
            if let Some(root) = &tab.root {
                if !tab.shared_geometry.as_ref().is_some_and(|g| g.matches(root)) {
                    tab.shared_geometry = Some(crate::desk_layout::Geometry::capture(root));
                }
            }
            self.desk_layouts.insert(tab.id.clone());
        } }
        self.view_layout_changed(t)
    }

    /// Zoom, theme and viewport dimensions affect this client only.
    pub fn view_layout_changed(&mut self, t: usize) {
        crate::commands::notify(self, "window-layout-changed", Some(t), None)
    }

    /// Publish explicit geometry and its matching pane-reference order together.
    /// The tmux string remains as a fallback for older hn clients.
    pub fn send_desk_layouts(&mut self) {
        if self.desk_layouts.is_empty() || !self.session_desk { return }
        let mut ops = Vec::new();
        for id in std::mem::take(&mut self.desk_layouts) {
            let Some(tab) = self.tabs.iter_mut().find(|t| t.id == id) else { continue };
            let Some(root) = tab.root.as_ref() else { continue };
            if !tab.layout.is_object() { tab.layout = json!({}) }
            let before = tab.layout.clone();
            tab.layout["tmux"] = json!(root.to_tmux());
            let geometry = tab.shared_geometry.get_or_insert_with(|| crate::desk_layout::Geometry::capture(root));
            // Shell panes are local; do not assign their slots to remote harnesses.
            let shared = geometry.slots.iter().all(|(id, _)| self.panes.get(id)
                .is_some_and(|p| !crate::local::is_local(&p.machine_id)));
            if shared { geometry.write(&mut tab.layout); }
            // C-b Space and select-layout use this path too. Keep the desktop's
            // corresponding shape current, instead of leaving an older preset behind.
            if let Some((count, preset)) = tab.desk_preset.take() {
                if !tab.layout.get("presets").map(Value::is_object).unwrap_or(false) { tab.layout["presets"] = json!({}) }
                tab.layout["presets"][count.to_string()] = json!(preset);
            }
            if tab.layout != before { ops.push(json!({ "op": "tab.layout", "id": tab.id, "layout": tab.layout })); }
            // The slot order and the shared reference order must agree, even
            // for non-spatial desktop splits or mirrored tmux layouts.
            let panes: Vec<_> = geometry.slots.iter().filter_map(|(id, _)| self.panes.get(id))
                .filter(|p| !crate::local::is_local(&p.machine_id))
                .map(|p| (p.machine_id.clone(), p.agent_id.clone())).collect();
            if panes != tab.desk_panes {
                for (index, (machine, agent)) in panes.iter().enumerate() {
                    ops.push(json!({ "op": "pane.move", "tabId": tab.id, "machineId": machine, "agentId": agent, "index": index }));
                }
            }
        }
        self.desk_ops(ops);
    }

    /// window_pane_update_focus: [pane] is focused when it is the current window's active pane,
    /// the client has focus and no menu or popup is over it; a pane that gains or loses that
    /// fires pane-focus-in or pane-focus-out ([notify]), its flag kept in [focused].
    fn update_focus(&mut self, pane: u64, focused: &mut Vec<u64>, notify: bool) { let current = self.active; self.update_focus_in(pane, focused, notify, current) }

    /// window_pane_update_focus with [current] the window current when tmux looks (a pane lost
    /// before break-pane goes to its new window is looked at while the old one still is).
    fn update_focus_in(&mut self, pane: u64, focused: &mut Vec<u64>, notify: bool, current: usize) {
        let Some(w) = self.tabs.iter().position(|t| t.panes().contains(&pane)) else { return };
        let overlay = matches!(self.modal, Some(crate::modal::Modal::Menu(_)) | Some(crate::modal::Modal::Popup { .. }) | Some(crate::modal::Modal::NewHarness(_)));
        let focus_events = self.options.get("focus-events", "", None).as_deref() == Some("on");
        let client = !focus_events || self.terminal_focused;
        let is = w == current && self.tabs[w].focus == Some(pane) && client && !overlay;
        let had = focused.contains(&pane);
        // A program that asked for focus reports (\e[?1004h) is told, as tmux writes to the pane.
        let reports = self.panes.get(&pane).map(|p| p.mode().contains(alacritty_terminal::term::TermMode::FOCUS_IN_OUT)).unwrap_or(false);
        if !is && had {
            focused.retain(|p| *p != pane);
            if reports { self.send_input(pane, b"\x1b[O") }
            if notify { crate::commands::notify(self, "pane-focus-out", Some(w), Some(pane)) }
        } else if is && !had {
            focused.push(pane);
            if reports { self.send_input(pane, b"\x1b[I") }
            if notify { crate::commands::notify(self, "pane-focus-in", Some(w), Some(pane)) }
        }
    }

    /// cmd-pipe-pane.c's child: `sh -c` [command], its stdin what [pane] prints from now on
    /// ([output], -O), what it prints typed into the pane ([input], -I), its errors dropped; the
    /// pipe closes when it ends.
    pub fn open_pipe(&mut self, pane: u64, command: &str, input: bool, output: bool) {
        use std::process::Stdio;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut c = tokio::process::Command::new("/bin/sh");
        crate::ipc::set_job_env(&mut c, &crate::ipc::job_environ(&self.global_env, &self.session_env));
        c.arg("-c").arg(command)
            .stdin(if output { Stdio::piped() } else { Stdio::null() })
            .stdout(if input { Stdio::piped() } else { Stdio::null() })
            .stderr(Stdio::null());
        let mut child = match c.spawn() { Ok(c) => c, Err(e) => return self.error(format!("fork error: {e}")) };
        self.pipe_seq += 1;
        let id = self.pipe_seq;
        let out = child.stdin.take().map(|mut stdin| {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
            tokio::spawn(async move { while let Some(b) = rx.recv().await { if stdin.write_all(&b).await.is_err() { break } } });
            tx
        });
        if let Some(mut stdout) = child.stdout.take() {
            let sink = self.sink.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => { let bytes = buf[..n].to_vec(); let _ = sink.send(Event::Apply(Box::new(move |app: &mut App| crate::input::send_to_pane(app, pane, bytes)))); }
                    }
                }
            });
        }
        self.spawn(async move { let _ = child.wait().await; }, move |app, _| {
            if app.pipes.get(&pane).map(|p| p.id == id).unwrap_or(false) { app.pipes.remove(&pane); }
        });
        self.pipes.insert(pane, Pipe { out, id });
    }

    /// Whatever pane you are in (the terminal focused) is read: its harness's finished turn is
    /// no longer news — every way of getting there (a key, a click, a command, the dial).
    pub fn mark_seen(&mut self) {
        if !self.terminal_focused { return }
        if let Some(f) = self.focused() { self.seen(f) }
    }

    /// cfg_show_causes: a config file's errors into the current pane's view mode, once there is
    /// a pane to show them in.
    pub fn show_causes(&mut self) {
        if self.config_causes.is_empty() || self.capture.is_some() || self.focused().is_none() { return }
        let causes = std::mem::take(&mut self.config_causes);
        if !crate::copy::print(self, &causes, false) { self.config_causes = causes }
    }

    /// The last window (the top of tmux's lastw stack): C-b l's, the - flag's.
    pub fn last_tab(&self) -> Option<&String> { self.lastw.first() }

    /// winlink_stack_push: a window to the top of the stack, once.
    pub fn lastw_push(&mut self, id: String) {
        self.lastw.retain(|x| *x != id);
        self.lastw.insert(0, id);
    }

    /// session_set_current's stack: the window chosen comes off it, the current one goes on top.
    fn lastw_leave(&mut self, to: usize) {
        let (to, from) = (self.tabs[to].id.clone(), self.tabs[self.active].id.clone());
        self.lastw.retain(|x| *x != to);
        self.lastw_push(from);
    }

    /// new-window's window at index `n` (the first free one without), in its place in the order.
    pub fn new_tab_at(&mut self, n: Option<usize>) {
        self.renumber();
        { let id = self.tabs[self.active].id.clone(); self.lastw_push(id) }
        let tab = Tab::home();
        let n = n.unwrap_or_else(|| self.free_num());
        self.nums.insert(tab.id.clone(), n);
        let at = self.tabs.iter().position(|t| self.nums.get(&t.id).map(|m| *m > n).unwrap_or(false)).unwrap_or(self.tabs.len());
        self.tabs.insert(at, tab);
        self.active = at;
        self.home_cursor = 0;
        self.home_moved = false;
        self.home_order.borrow_mut().clear();
        self.fit_panes();
    }

    /// winlink_shuffle_up: the windows from index `idx` up to the first free one move up one,
    /// so `idx` is free.
    pub fn shuffle_up(&mut self, idx: usize) {
        self.renumber();
        let used: HashSet<usize> = self.nums.values().copied().collect();
        let mut last = idx;
        while used.contains(&last) { last += 1 }
        for n in (idx..last).rev() {
            if let Some(id) = self.nums.iter().find(|(_, v)| **v == n).map(|(k, _)| k.clone()) { self.nums.insert(id, n + 1); }
        }
    }

    pub fn new_tab(&mut self) {
        // tmux's new-window: the first free index; the others keep their numbers.
        self.renumber();
        { let id = self.tabs[self.active].id.clone(); self.lastw_push(id) }
        let tab = Tab::home();
        let n = self.free_num();
        self.nums.insert(tab.id.clone(), n);
        let at = self.tabs.iter().position(|t| self.nums.get(&t.id).map(|m| *m > n).unwrap_or(false)).unwrap_or(self.tabs.len());
        self.tabs.insert(at, tab);
        self.active = at;
        self.home_cursor = 0;
        self.home_order.borrow_mut().clear();
        self.fit_panes();
    }

    /// tmux's alerts_queue + alerts_check_*: when the window's monitor-activity / monitor-bell /
    /// monitor-silence is on, a window that is not the current one is flagged (activity and
    /// silence once until it is visited, a bell every time), and — as bell-action / activity-action
    /// / silence-action say — the terminal's bell rings or (visual-*) a message says where.
    pub fn alert(&mut self, t: usize, flag: u8) {
        let Some(tab) = self.tabs.get(t) else { return };
        let id = tab.id.clone();
        let (monitor, action, visual, word) = match flag {
            BELL => ("monitor-bell", "bell-action", "visual-bell", "Bell"),
            ACTIVITY => ("monitor-activity", "activity-action", "visual-activity", "Activity"),
            _ => ("monitor-silence", "silence-action", "visual-silence", "Silence"),
        };
        let on = self.options.get(monitor, &id, None).map(|v| v != "off" && v != "0").unwrap_or(false);
        if !on { return }
        let current = t == self.active;
        if flag != BELL && self.tabs[t].alerts & flag != 0 { return }
        if !current || self.session_attached(self.session_id) == 0 { self.tabs[t].alerts |= flag }
        let applies = match self.options.get(action, "", None).as_deref() { Some("any") => true, Some("current") => current, Some("other") => !current, _ => false };
        if !applies { return }
        // notify_winlink: alert-bell, alert-activity, alert-silence.
        let hook = match flag { BELL => "alert-bell", ACTIVITY => "alert-activity", _ => "alert-silence" };
        crate::commands::notify(self, hook, Some(t), None);
        let visual = self.options.get(visual, "", None).unwrap_or_default();
        if visual == "off" || visual == "both" { crate::bell() }
        if visual == "off" { return }
        let msg = if current { format!("{word} in current window") } else { format!("{word} in window {}", self.win_num(t)) };
        self.say(msg, theme::WARN);
    }

    /// monitor-silence: a window quiet that many seconds (checked on the tick).
    /// The timer runs again when it fires (alerts_reset), so a window that stays quiet is said
    /// again each time — to the current window only, the others being flagged already.
    pub fn check_silence(&mut self) {
        for t in 0..self.tabs.len() {
            let n: u64 = self.options.get("monitor-silence", &self.tabs[t].id, None).and_then(|v| v.parse().ok()).unwrap_or(0);
            if n > 0 && self.tabs[t].last_output.elapsed() >= Duration::from_secs(n) {
                self.tabs[t].last_output = Instant::now();
                self.alert(t, SILENCE)
            }
        }
    }

    pub fn select_tab(&mut self, index: usize) {
        if index < self.tabs.len() {
            // session_set_current: the window's alerts are seen, and choosing it is activity.
            self.tabs[index].alerts = 0;
            let changed = index != self.active;
            if changed { self.lastw_leave(index); self.home_order.borrow_mut().clear() }
            self.active = index;
            if changed { self.tabs[index].touch(); self.alert(index, ACTIVITY) }
            if let Some(f) = self.tabs[index].focus { self.seen(f) }
            self.fit_panes();
            if let Some(f) = self.tabs[index].focus { self.take_if_watching(f) }
        }
    }

    /// Move the active tab one place left (-1) or right (+1), on the desk too.
    pub fn move_tab(&mut self, by: i32) {
        let to = self.active as i32 + by;
        if to < 0 || to as usize >= self.tabs.len() { return }
        let to = to as usize;
        self.tabs.swap(self.active, to);
        self.active = to;
        let (id, on_desk) = (self.tabs[to].id.clone(), self.tabs[to].on_desk);
        if on_desk { self.desk_op(json!({ "op": "tab.move", "id": id, "index": to })) }
    }

    pub fn rename_tab(&mut self, name: &str) { let i = self.active; self.rename_tab_at(i, name) }

    /// rename-window -t: that window.
    pub fn rename_tab_at(&mut self, index: usize, name: &str) {
        let Some(tab) = self.tabs.get_mut(index) else { return };
        tab.name = name.to_string();
        tab.named = true;
        let (id, on_desk) = (tab.id.clone(), tab.on_desk);
        // tmux: a window named by hand is no longer renamed automatically.
        self.options.windows.entry(id.clone()).or_default().insert("automatic-rename".into(), "off".into());
        if on_desk { self.desk_op(json!({ "op": "tab.rename", "id": id, "name": name, "nameIsCustom": true })) }
    }

    // ── tmux pane moves ──────────────────────────────────────────────────────

    /// The panes of a window where tmux keeps them (zoom aside), in its list order.
    pub fn pane_geoms(&self, w: usize) -> Vec<(u64, layout::Geom)> {
        let Some(tab) = self.tabs.get(w) else { return Vec::new() };
        let body = self.body();
        let mut out = Vec::new();
        if let Some(root) = tab.root.as_ref() { root.rects(body, &mut out) }
        tab.panes().into_iter().filter_map(|id| out.iter().find(|(p, _)| *p == id).map(|(_, r)| {
            let c = self.layout_content_of(tab, *r);
            (id, layout::Geom { x: (c.x - body.x) as u32, y: (c.y - body.y) as u32, w: c.width as u32, h: c.height as u32 })
        })).collect()
    }

    /// The current window's panes as drawn (a zoomed window's one pane filling it), where their
    /// contents are in the window: tmux's xoff/yoff/sx/sy for the mouse.
    pub fn visible_geoms(&self) -> Vec<(u64, layout::Geom)> { self.visible_geoms_for(true) }
    pub fn visible_layout_geoms(&self) -> Vec<(u64, layout::Geom)> { self.visible_geoms_for(false) }

    fn visible_geoms_for(&self, inset: bool) -> Vec<(u64, layout::Geom)> {
        let body = self.body();
        let tab = self.tab();
        tab.panes().into_iter().filter_map(|id| self.rects.iter().find(|(p, _)| *p == id).map(|(_, r)| {
            let c = if inset { self.content_of(tab, *r) } else { self.layout_content_of(tab, *r) };
            (id, layout::Geom { x: (c.x - body.x) as u32, y: (c.y.saturating_sub(body.y)) as u32, w: c.width as u32, h: c.height as u32 })
        })).collect()
    }

    /// tmux's copy mode is a pane's: keys go to it while the active pane is in it, and to the pane
    /// when it is not (whatever other pane is in copy mode).
    pub fn sync_copy_modal(&mut self) {
        if !matches!(self.modal, None | Some(Modal::Copy { .. })) { return }
        let pane = self.focused().filter(|f| self.panes.get(f).map(|p| p.copy_top()).unwrap_or(false));
        self.modal = pane.map(|pane| Modal::Copy { pane });
    }

    /// A pane's harness at a glance (theme::state_mark): None for a plain shell or no harness.
    pub fn pane_state(&self, pane: u64) -> Option<fleet::State> {
        let p = self.panes.get(&pane)?;
        let agent = self.fleet.agent(&p.machine_id, &p.agent_id)?;
        if agent.engine == "terminal" { return None }
        Some(self.fleet.state_of(agent))
    }

    /// A window's most urgent harness state (its panes'), for the window list.
    pub fn window_state(&self, w: usize) -> Option<fleet::State> {
        let tab = self.tabs.get(w)?;
        crate::theme::most_urgent(tab.panes().into_iter().filter_map(|p| self.pane_state(p)))
    }

    /// The current pane for a command: while a mouse key's commands run, the pane under the mouse
    /// (cmd_find_from_mouse), else the active pane of the current window.
    pub fn current(&self) -> Option<(usize, u64)> {
        if let Some(found) = self.mouse_ev.as_ref().filter(|m| m.valid).and_then(|m| crate::mouse::mouse_pane(self, m)) { return Some(found) }
        // A hook's commands: the pane (window) it is about — for a command's that made one, the
        // one it made.
        if let Some((tab, pane)) = self.hook_state.as_ref().and_then(|h| h.target.clone()) {
            if let Some(w) = self.tabs.iter().position(|t| t.id == tab) { return Some((w, pane)) }
        }
        self.focused().map(|f| (self.active, f))
    }

    /// resize-pane -M's drag: the borders at (lx, ly) follow the mouse to (x, y).
    pub fn drag_border(&mut self, w: usize, lx: u32, ly: u32, x: u32, y: u32) {
        self.fit_panes_of(w);
        let moved = self.tabs.get_mut(w).and_then(|t| t.root.as_mut()).map(|r| r.drag_border(lx, ly, x, y)).unwrap_or(false);
        if moved { self.fit_panes(); self.layout_changed(w) }
    }

    /// The pane that way from `from`, as tmux's select-pane -L/-R/-U/-D finds it.
    pub fn pane_toward(&self, w: usize, from: u64, toward: Toward) -> Option<u64> {
        let tab = self.tabs.get(w)?;
        let body = self.body();
        let size = tab.root.as_ref().map(|r| r.size()).unwrap_or((body.width, body.height));
        layout::find_toward(&self.pane_geoms(w), from, toward, (size.0 as u32, size.1 as u32), self.pane_status(tab), &|p| tab.points.get(&p).copied().unwrap_or(0))
    }

    /// select-pane -L/-R/-U/-D: the pane that way becomes the active one; a zoomed window is
    /// unzoomed (-Z: the new pane is zoomed instead).
    pub fn select_toward(&mut self, toward: layout::Toward, keep_zoom: bool) {
        let Some(focus) = self.focused() else { return };
        let w = self.active;
        let Some(next) = self.pane_toward(w, focus, toward) else { return };
        if next == focus { return }
        let zoomed = self.tabs[w].zoomed;
        self.focus_pane(w, next);
        self.tabs[w].zoomed = zoomed && keep_zoom;
        self.fit_panes();
    }

    /// last-pane (select-pane -l): the pane active before this one — with no such pane in a
    /// window of two, the other one, as tmux has it; -Z keeps a zoomed window zoomed.
    pub fn select_last(&mut self, w: usize, keep_zoom: bool) {
        let Some(tab) = self.tabs.get(w) else { return };
        let ids = tab.panes();
        let other = || if ids.len() == 2 { ids.iter().copied().find(|p| Some(*p) != tab.focus) } else { None };
        let Some(last) = tab.last_focus().filter(|l| ids.contains(l)).or_else(other) else { self.error("no last pane"); return };
        let zoomed = tab.zoomed;
        if w == self.active { self.focus_pane(w, last) } else { self.tabs[w].set_active(last) }
        self.tabs[w].zoomed = zoomed && keep_zoom;
        self.fit_panes();
    }

    /// `resize-pane -L/-R/-U/-D n`: n cells, the way tmux counts them.
    /// resize-pane -L/-R/-U/-D: the pane's nearest border in that direction moves `cells`.
    pub fn resize_pane(&mut self, tab: usize, pane: u64, dir: Dir, cells: i32) {
        self.fit_panes_of(tab);
        let before = self.tabs.get(tab).and_then(|t| t.root.as_ref()).map(|r| r.to_tmux());
        if let Some(root) = self.tabs.get_mut(tab).and_then(|t| t.root.as_mut()) { root.resize_pane(pane, dir, cells, true); }
        self.fit_panes();
        if self.tabs.get(tab).and_then(|t| t.root.as_ref()).map(|r| r.to_tmux()) != before { self.layout_changed(tab) }
    }

    /// A window's cells at the client's size before they are moved.
    fn fit_panes_of(&mut self, tab: usize) -> bool {
        let body = self.body();
        let status = self.tabs.get(tab).map(|t| self.pane_status(t)).unwrap_or_default();
        let Some(tab) = self.tabs.get_mut(tab).filter(|t| t.root.is_some()) else { return false };
        tab.fit_layout((body.width, body.height), status);
        true
    }

    /// resize-pane -x/-y: the pane made that many cells wide or lines tall (its title row, when
    /// the window shows them, on top).
    pub fn size_pane(&mut self, tab: usize, pane: u64, dir: Dir, cells: u16) {
        self.fit_panes_of(tab);
        // cmd-resize-pane.c: -y counts the status line of the pane that gives a row to it — the
        // top pane's with pane-border-status top, the bottom one's with bottom.
        let (status, g) = match self.tabs.get(tab) { Some(t) => (self.pane_status(t), self.pane_geoms(tab).into_iter().find(|(id, _)| *id == pane).map(|(_, g)| g)), None => return };
        let sy = self.body().height as u32;
        let own_row = match (status, g) { (layout::Status::Top, Some(g)) => g.y == 1, (layout::Status::Bottom, Some(g)) => g.y + g.h + 1 == sy, _ => false };
        let cells = if dir == Dir::Vertical && own_row { cells + 1 } else { cells };
        let before = self.tabs.get(tab).and_then(|t| t.root.as_ref()).map(|r| r.to_tmux());
        if let Some(root) = self.tabs.get_mut(tab).and_then(|t| t.root.as_mut()) { root.resize_pane_to(pane, dir, cells as u32); }
        self.fit_panes();
        // layout_resize_pane_to returns early (nothing notified) when the pane has no parent to
        // resize it in that way.
        if self.tabs.get(tab).and_then(|t| t.root.as_ref()).map(|r| r.to_tmux()) != before { self.layout_changed(tab) }
    }

    /// tmux's swap-pane in one window: the two trade cells and places in the list; the target
    /// (`dst`) is the active pane after, or with -d the active place stays where it was.
    /// Zoom goes unless -Z.
    pub fn swap_panes(&mut self, w: usize, src: u64, dst: u64, detached: bool, keep_zoom: bool) {
        let Some(tab) = self.tabs.get_mut(w) else { return };
        let mut order = tab.panes();
        let (Some(i), Some(j)) = (order.iter().position(|p| *p == src), order.iter().position(|p| *p == dst)) else { return };
        if src == dst { return }
        order.swap(i, j);
        tab.order = order;
        if let Some(root) = tab.root.as_mut() { root.swap(src, dst) }
        if !detached { tab.set_active(dst) }
        else if tab.focus == Some(src) { tab.set_active(dst) }
        else if tab.focus == Some(dst) { tab.set_active(src) }
        tab.zoomed &= keep_zoom;
        self.sync_titles();
        self.fit_panes();
        self.layout_changed(w);
    }

    /// swap-pane across two windows: each pane takes the other's cell and place in its list;
    /// each window's active pane is the one that came in (-d: only where the active one left).
    pub fn swap_across(&mut self, src: (usize, u64), dst: (usize, u64), detached: bool, keep_zoom: bool) {
        let ((sw, sp), (dw, dp)) = (src, dst);
        if sw == dw || sw >= self.tabs.len() || dw >= self.tabs.len() { return }
        let (spoint, dpoint) = (self.tabs[sw].points.remove(&sp), self.tabs[dw].points.remove(&dp));
        if let Some(p) = spoint { self.tabs[dw].points.insert(sp, p); }
        if let Some(p) = dpoint { self.tabs[sw].points.insert(dp, p); }
        for (w, from, to) in [(sw, sp, dp), (dw, dp, sp)] {
            let tab = &mut self.tabs[w];
            let mut order = tab.panes();
            for p in order.iter_mut() { if *p == from { *p = to } }
            tab.order = order;
            if let Some(root) = tab.root.as_mut() { root.replace(from, to); }
            tab.last.retain(|p| *p != from);
            if tab.focus == Some(from) { tab.focus = Some(to) } else if !detached { tab.set_active(to) }
            tab.zoomed &= keep_zoom;
        }
        // The desk: each harness leaves its window for the other's.
        let (st, dt) = (self.tabs[sw].id.clone(), self.tabs[dw].id.clone());
        for (tab, pane, gone) in [(&dt, sp, &st), (&st, dp, &dt)] {
            if let Some((m, a)) = self.panes.get(&pane).map(|x| (x.machine_id.clone(), x.agent_id.clone())) {
                self.desk_op(json!({ "op": "pane.remove", "tabId": gone, "machineId": m, "agentId": a }));
                self.desk_pane_added(tab, &m, &a);
            }
        }
        self.sync_titles();
        self.fit_panes();
        self.layout_changed(sw);
        self.layout_changed(dw);
    }

    /// swap-pane between two sessions' windows, one side: [to] in [from]'s place in window [w]
    /// (its cell, its place in the list, its point), active where [from] was — or, not -d, anyway.
    pub fn pane_in_place(&mut self, w: usize, from: u64, to: u64, point: Option<u64>, detached: bool, keep_zoom: bool) {
        let Some(tab) = self.tabs.get_mut(w) else { return };
        if let Some(p) = point { tab.points.insert(to, p); }
        let mut order = tab.panes();
        for p in order.iter_mut() { if *p == from { *p = to } }
        tab.order = order;
        if let Some(root) = tab.root.as_mut() { root.replace(from, to); }
        tab.last.retain(|p| *p != from);
        if tab.focus == Some(from) { tab.focus = Some(to) } else if !detached { tab.set_active(to) }
        tab.zoomed &= keep_zoom;
        let tab_id = tab.id.clone();
        if let Some((m, a)) = self.panes.get(&to).map(|x| (x.machine_id.clone(), x.agent_id.clone())) { self.desk_pane_added(&tab_id, &m, &a) }
        self.layout_changed(w);
    }

    /// `rotate-window` (C-o): the list turns (the first pane to the end; -D the last to the
    /// start) and each pane takes the cell of the one now before it; the active place stays.
    pub fn rotate(&mut self, w: usize, by: i64, keep_zoom: bool) {
        let Some(tab) = self.tabs.get_mut(w) else { return };
        let ids = tab.panes();
        let n = ids.len();
        if n < 2 { return }
        let turned: Vec<u64> = (0..n).map(|i| ids[(i as i64 + by).rem_euclid(n as i64) as usize]).collect();
        if let Some(root) = tab.root.as_mut() {
            root.relabel(&mut |old| ids.iter().position(|p| *p == old).map(|i| turned[i]).unwrap_or(old));
        }
        let at = tab.focus.and_then(|f| ids.iter().position(|p| *p == f));
        tab.order = turned.clone();
        if let Some(i) = at { tab.set_active(turned[i]) }
        tab.zoomed &= keep_zoom;
        self.sync_titles();
        self.fit_panes();
        self.layout_changed(w);
    }

    /// next-layout / previous-layout (layout_set_next/previous): tmux's seven named layouts in its
    /// order, on from the one last applied — a window that has had none starts at even-horizontal
    /// going forward, tiled going back.
    pub fn step_layout(&mut self, index: usize, next: bool) {
        let Some(tab) = self.tabs.get(index) else { return };
        let last = layout::Named::ALL.len() - 1;
        let at = match (tab.layout_at, next) {
            (None, true) => 0,
            (None, false) => last,
            (Some(at), true) => if at >= last { 0 } else { at + 1 },
            (Some(at), false) => if at == 0 { last } else { at - 1 },
        };
        self.arrange_tab(index, layout::Named::ALL[at]);
    }

    /// The same concrete choices as the desktop palette. Native select-layout
    /// and C-b Space keep tmux's own catalogue and publish their exact geometry.
    pub fn apply_shared_preset(&mut self, id: &str) {
        let ids = self.tab().panes();
        let Some(preset) = crate::desk_layout::choices(ids.len()).into_iter().find(|p| *p == id) else { return };
        let Some(tiles) = crate::desk_layout::preset_tiles(preset, ids.len()) else { return };
        let body = self.body();
        let status = self.pane_status(self.tab());
        let Some((root, geometry)) = crate::desk_layout::Geometry::from_tiles(tiles, &ids, body.width, body.height, status) else { return };
        let tab = self.tab_mut();
        tab.root = Some(root);
        tab.shared_geometry = Some(geometry);
        tab.zoomed = false;
        tab.layout_at = None;
        tab.desk_preset = Some((ids.len(), preset));
        self.fit_panes();
        self.layout_changed(self.active);
    }

    /// `tui.toml`'s `[look]` table: set each choice as a global option, so `hn show` reflects it
    /// and the daemon (which reads options, not the file) keeps the running look. The file is a
    /// startup default; `hn set -g` afterward still wins.
    pub fn apply_look(&mut self, look: Option<&crate::config::Look>) {
        let Some(look) = look else { return };
        let global = crate::options::SetFlags { global: true, ..Default::default() };
        for (name, value) in look.assignments() {
            let _ = self.options.set(&name, Some(value.as_str()), &global, "", 0);
        }
        // ── status bar ──
        if let Some(b) = look.status_bar.as_deref().filter(|b| matches!(*b, "top" | "bottom")) { self.status_top = b == "top" }
        self.sync_accent();
    }

    /// Push the `@hn-accent` option (as the look holds it) to the colour layer, so `theme::accent()`
    /// draws chrome with it — and `@hn-theme`'s colours, so the status bar, the pane surfaces and
    /// the panes the daemons paint take the theme's. Called whenever the look is applied or a knob
    /// changes.
    pub fn sync_accent(&mut self) {
        crate::term_out::set_accent_override(self.options.get("@hn-accent", "", None));
        crate::settings::set_fzf_lists(self.options.get("@hn-lists", "", None).as_deref() == Some("fzf"));
        let hex = |c: [u8; 3]| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]);
        let theme = self.options.get("@hn-theme", "", None)
            .and_then(|n| crate::terminal_themes::TERMINAL_THEMES.iter().find(|t| t.name == n))
            .map(|t| (hex(t.background), hex(t.foreground)));
        if crate::term_out::set_theme_colours(theme) { self.push_theme() }
    }

    /// `hn theme`: a knob's new value from the picker. Applies it live (so the daemon, which reads
    /// options, changes the running look) and writes the config file's `[look]` table. Returns the
    /// confirmation shown in the picker.
    pub fn set_look(&mut self, knob: &str, value: &str) -> String {
        let global = crate::options::SetFlags { global: true, ..Default::default() };
        let (name, message) = match knob {
            // A preset also sets its focus (line or surface), so choosing one resets any knob
            // the user set earlier; they can override it again right after.
            "preset" => {
                let surface = crate::config::Look::look_preset(value).iter().any(|(_, v)| *v == "surface");
                let _ = self.options.set("@hn-focus", Some(if surface { "surface" } else { "line" }), &global, "", 0);
                ("@hn-look", format!("look: {value}"))
            }
            "focus" => ("@hn-focus", format!("focus: {value}")),
            "border_lines" => ("pane-border-lines", format!("border: {value}")),
            "border_indicators" => ("pane-border-indicators", format!("indicators: {value}")),
            "border_status" => ("pane-border-status", format!("title row: {value}")),
            "layout_orientation" => ("@hn-layout", format!("split: {value}")),
            "layout_preset" => ("@hn-layout-preset", format!("layout: {value}")),
            // A terminal theme only names the palette; hn keeps the choice recorded so it survives
            // a restart, and the theme draws on the terminal (OSC 10/11). Its signature colour
            // becomes the chrome accent so picking one visibly changes hn.
            "theme" => {
                // (None chosen: the terminal's own colours again, and hn's own accent.)
                if value.is_empty() {
                    let unset = crate::options::SetFlags { global: true, unset: true, ..Default::default() };
                    let _ = self.options.set("@hn-accent", None, &unset, "", 0);
                    let _ = self.options.set("@hn-theme", None, &unset, "", 0);
                    self.sync_accent();
                    let i = self.active;
                    self.view_layout_changed(i);
                    self.persist_look();
                    return "theme: the terminal's own".into();
                }
                if let Some(a) = crate::theme::theme_accent_hex(value) {
                    let _ = self.options.set("@hn-accent", Some(a.as_str()), &global, "", 0);
                }
                ("@hn-theme", format!("theme: {value}"))
            }
            // ── status bar ──
            // (At the top or the bottom the bar is tmux's status line: status-position places it.)
            "status_bar" => {
                if matches!(value, "top" | "bottom") { let _ = self.options.set("status-position", Some(value), &global, "", 0); self.status_top = value == "top" }
                ("@hn-status-bar", format!("status bar: {value}"))
            }
            "border_style" => ("@hn-border", format!("border style: {value}")),
            "dim" => ("@hn-dim", format!("dim other panes: {value}")),
            _ => return format!("unknown: {value}"),
        };
        let _ = self.options.set(name, Some(value), &global, "", 0);
        self.sync_accent();
        // (The bar and the frames change the panes' room: every program is told its size.)
        if matches!(knob, "status_bar" | "border_style") { self.redraw_all = true; self.fit_panes() }
        let i = self.active;
        self.view_layout_changed(i);
        self.persist_look();
        message
    }

    /// Write the current look (as the options hold it) to tui.toml's `[look]`, best-effort.
    pub fn persist_look(&mut self) {
        let mut look = crate::config::Look::default();
        look.preset = self.options.get("@hn-look", "", None);
        look.focus = self.options.get("@hn-focus", "", None);
        look.border_lines = self.options.get("pane-border-lines", "", None);
        look.border_indicators = self.options.get("pane-border-indicators", "", None);
        look.border_status = self.options.get("pane-border-status", "", None);
        look.layout_orientation = self.options.get("@hn-layout", "", None);
        look.layout_preset = self.options.get("@hn-layout-preset", "", None);
        look.theme = self.options.get("@hn-theme", "", None);
        // ── status bar ──
        look.status_bar = self.options.get("@hn-status-bar", "", None);
        look.border_style = self.options.get("@hn-border", "", None);
        look.status_bar_width = self.options.get("@hn-status-bar-width", "", None);
        look.dim = self.options.get("@hn-dim", "", None);
        if let Err(e) = crate::config::write_look(&look) { self.say(format!("could not write tui.toml: {e}"), crate::theme::DANGER) }
    }

    // ── the desk: tabs shared with every window on the account ─────────────────

    fn load_desk(&mut self) {
        self.desk_loaded = true;
        if self.desk_mode == DeskMode::Off { self.desk_answered = true; self.maybe_start_shell(); return }
        self.fetch_desk();
    }

    /// tmux starts in a shell: when hn opens with no window of its own to show (the desk had
    /// none, or there is no desk), window 0 is a shell on this computer, in the folder hn was
    /// started in — once, when the desk has answered and this computer's daemon is connected.
    /// Until then (or if it never connects: not signed in) the window shows what it can.
    pub fn maybe_start_shell(&mut self) {
        if self.shell_asked || !self.desk_answered || self.capture.is_some() { return }
        // A headless client makes only the sessions it is asked for.
        if self.headless { self.shell_asked = true; return }
        // The OS opens on the agent launcher. An explicit `hn new ...` still gets
        // its requested shell; reconnecting to existing work is handled by the desk.
        if self.os_session && self.start_session.is_none() { self.shell_asked = true; return }
        // `hn new -s work` (a session besides the desk's): made here, with its shell.
        if self.start_session.as_ref().map(|s| s.create && self.session_alias.as_deref() != s.name.as_deref()).unwrap_or(false) {
            if self.link(&self.fleet.local_id).is_none() { return }
            let start = self.start_session.take().unwrap_or_default();
            self.shell_asked = true;
            if let Err(e) = self.new_session(start.name.as_deref(), start.window.as_deref(), start.cwd, start.command, false) { self.error(e) }
            return;
        }
        if !(self.tabs.len() == 1 && self.tabs[0].root.is_none()) { self.shell_asked = true; return }
        if self.link(&self.fleet.local_id).is_none() { return }
        self.shell_asked = true;
        // The desk's first shell: where hn was started (-c: where it was asked to), running what
        // `hn new` asked for.
        let start = self.start_session.take().unwrap_or_default();
        let cwd = start.cwd.or_else(|| std::env::current_dir().ok().map(|d| d.display().to_string()));
        crate::input::new_shell_from(self, None, Placement::Auto(None), cwd, start.command);
    }

    fn fetch_desk(&mut self) {
        if self.desk_inflight { self.desk_stale = true; return }
        let port = self.port;
        self.spawn(async move { http_json(port, "GET", "/api/desk", None).await }, |app, desk| {
            if app.desk_inflight { app.desk_stale = true; return }
            if let Ok(desk) = desk { app.apply_desk(&desk) }
            if !app.desk_answered { app.desk_answered = true; app.maybe_start_shell() }
        });
    }

    /// Reconcile tabs to the desk: new tabs appear, closed ones go, panes follow. What a window
    /// keeps for itself (active tab, focus, zoom, sizes) is left alone.
    fn apply_desk(&mut self, desk: &Value) {
        // The desk is one session's windows: that session in front while they are reconciled.
        if !self.session_desk {
            let Some(id) = self.sessions.iter().find(|s| s.desk).map(|s| s.id) else { return };
            let back = self.session_id;
            self.swap_session(id);
            self.apply_desk(desk);
            self.swap_session(back);
            self.fit_panes();
            return;
        }
        let revision = desk.get("revision").and_then(Value::as_i64).unwrap_or(0);
        if revision <= self.desk_revision { return }
        self.desk_revision = revision;
        let acknowledged = std::mem::take(&mut self.desk_acked_layouts);
        let Some(rows) = desk.get("tabs").and_then(Value::as_array) else { return };
        let first_load = self.tabs.iter().all(|t| !t.on_desk);
        let mut seen = Vec::new();
        for row in rows {
            let id = row.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let panes: Vec<(String, String)> = row.get("panes").and_then(Value::as_array).map(|a| a.iter().filter_map(|p| Some((p.get("machineId")?.as_str()?.to_string(), p.get("agentId")?.as_str()?.to_string()))).collect()).unwrap_or_default();
            if id.is_empty() || panes.is_empty() { continue }
            seen.push(id.clone());
            let name = row.get("name").and_then(Value::as_str).unwrap_or("tab").to_string();
            let named = row.get("nameIsCustom").and_then(Value::as_bool).unwrap_or(false);
            let layout_doc = row.get("layout").cloned().unwrap_or(json!({}));
            match self.tabs.iter().position(|t| t.id == id) {
                Some(index) => {
                    let tab = &mut self.tabs[index];
                    // A name given (rename-window) is every terminal's; one automatic-rename gave
                    // stays as automatic-rename gives it here, from what the window runs.
                    if named { tab.name = name; tab.named = true } else if tab.named { tab.named = false }
                    tab.on_desk = true;
                    // A reply to our own write is an acknowledgement, not a request to
                    // arrange again. In particular, a legacy desk omits layout.tmux. Also
                    // keep input queued in this event batch until its layout is sent.
                    // Desktop serializes presets/sizes, dropping the tmux-only field.
                    // That round-trip, or another pane count's settings, is not a new
                    // arrangement. Compare only the geometry this window consumes.
                    let relayout = desk_layout_changed(&tab.desk_layout, &layout_doc, panes.len())
                        && desk_layout_changed(&tab.layout, &layout_doc, panes.len())
                        && acknowledged.get(&id) != Some(&layout_doc)
                        && !self.desk_layouts.contains(&id);
                    let reordered = tab.desk_panes != panes && !self.desk_layouts.contains(&id);
                    tab.desk_panes = panes.clone();
                    tab.desk_layout = layout_doc.clone();
                    tab.layout = layout_doc;
                    let have: Vec<(u64, (String, String))> = tab.panes().into_iter().filter_map(|pid| self.panes.get(&pid).map(|p| (pid, (p.machine_id.clone(), p.agent_id.clone())))).collect();
                    let missing = panes.iter().any(|want| !have.iter().any(|(_, key)| key == want));
                    let extra: Vec<u64> = have.iter().filter(|(_, key)| !panes.contains(key)).map(|(pid, _)| *pid).collect();
                    if !missing && extra.is_empty() {
                        let ids: Vec<u64> = panes.iter().filter_map(|key| have.iter().find(|(_, k)| k == key).map(|(id, _)| *id)).collect();
                        if relayout {
                            let (w, h) = (self.size.0, self.size.1.saturating_sub(2));
                            tab.read_shared_layout(&ids, w, h);
                            if reordered { tab.order = ids; }
                        } else if reordered {
                            // A desktop drag changes only the sequence. Keep our exact
                            // split sizes and the focused harness while changing places.
                            if let Some(root) = &mut tab.root {
                                if let Some(tiles) = tab.shared_geometry.as_ref().map(|g| g.slots.iter().map(|(_, t)| *t).collect())
                                    .or_else(|| crate::desk_layout::saved_tiles(&tab.layout, ids.len())) {
                                    if let Some((next, geometry)) = crate::desk_layout::Geometry::from_tiles(tiles, &ids, root.size().0, root.size().1, root.status) {
                                        *root = next;
                                        tab.shared_geometry = Some(geometry);
                                    }
                                } else {
                                    desk_reorder(root, &ids);
                                    tab.shared_geometry = Some(crate::desk_layout::Geometry::capture(root));
                                }
                                tab.order = ids;
                            }
                        }
                        continue;
                    }
                    for pid in &extra {
                        let tab = &mut self.tabs[index];
                        tab.root = tab.root.take().and_then(|r| r.remove(*pid));
                        self.drop_pane(*pid);
                    }
                    // Insertions belong at their shared index, including before an existing
                    // pane. Never append all new panes after the old local sequence.
                    let ids: Vec<u64> = panes.iter().map(|(m, a)| {
                        have.iter().find(|(_, key)| &key.0 == m && &key.1 == a).map(|(id, _)| *id)
                            .unwrap_or_else(|| self.new_pane_as(m, a, Some(crate::ids::desk(crate::ids::Kind::Pane, &format!("{m}:{a}")))))
                    }).collect();
                    let tab = &mut self.tabs[index];
                    let (w, h) = (self.size.0, self.size.1.saturating_sub(2));
                    tab.read_shared_layout(&ids, w, h);
                    tab.order = ids.clone();
                    if tab.focus.map(|f| !ids.contains(&f)).unwrap_or(true) { tab.focus = ids.first().copied() }
                }
                // The same window another session has (link-window, a group), already read: that
                // window here too — its panes, not a second pane for each of its harnesses.
                None if self.sessions.iter().any(|s| !s.desk && s.tabs.iter().any(|t| t.id == id && t.root.is_some())) => {
                    let Some(mut tab) = self.sessions.iter().flat_map(|s| s.tabs.iter()).find(|t| t.id == id && t.root.is_some()).cloned() else { continue };
                    tab.alerts = 0;
                    tab.on_desk = true;
                    let have = tab.panes();
                    let ids: Vec<_> = panes.iter().filter_map(|(m, a)| have.iter().copied().find(|id|
                        self.panes.get(id).is_some_and(|p| &p.machine_id == m && &p.agent_id == a))).collect();
                    tab.desk_panes = panes.clone();
                    tab.desk_layout = layout_doc.clone();
                    tab.layout = layout_doc;
                    if ids.len() == have.len() && ids.len() == panes.len() {
                        let (w, h) = tab.root.as_ref().unwrap().size();
                        tab.read_shared_layout(&ids, w, h);
                        tab.order = ids;
                    }
                    if named { tab.name = name; tab.named = true }
                    let at = rows.iter().position(|r| r.get("id").and_then(Value::as_str) == Some(tab.id.as_str())).unwrap_or(self.tabs.len()).min(self.tabs.len());
                    self.tabs.insert(at, tab);
                    if at <= self.active && !first_load { self.active += 1 }
                }
                None => {
                    // The desk's window and panes: the ids every client gives them.
                    let ids: Vec<u64> = panes.iter().map(|(m, a)| self.new_pane_as(m, a, Some(crate::ids::desk(crate::ids::Kind::Pane, &format!("{m}:{a}"))))).collect();
                    let mut tab = Tab::with_wid(&name, crate::ids::desk(crate::ids::Kind::Window, &id));
                    tab.id = id;
                    tab.named = named;
                    tab.on_desk = true;
                    tab.desk_panes = panes.clone();
                    tab.desk_layout = layout_doc.clone();
                    tab.layout = layout_doc;
                    let (w, h) = (self.size.0, self.size.1.saturating_sub(2));
                    tab.read_shared_layout(&ids, w, h);
                    tab.order = ids.clone();
                    tab.focus = ids.first().copied();
                    let at = rows.iter().position(|r| r.get("id").and_then(Value::as_str) == Some(tab.id.as_str())).unwrap_or(self.tabs.len()).min(self.tabs.len());
                    self.tabs.insert(at, tab);
                    if at <= self.active && !first_load { self.active += 1 }
                }
            }
        }
        // The desk windows' own state as the last client left it (options, zoom, titles).
        if !self.desk_windows_saved.is_empty() { for i in 0..self.tabs.len() { if self.tabs[i].on_desk { self.restore_desk_window(i) } } }
        // Tabs the desk no longer has — closed on another computer.
        let gone: Vec<usize> = self.tabs.iter().enumerate().filter(|(_, t)| t.on_desk && !seen.contains(&t.id)).map(|(i, _)| i).collect();
        for index in gone.into_iter().rev() {
            let tab = self.tabs.remove(index);
            self.lastw.retain(|id| *id != tab.id);
            for id in tab.panes() { self.drop_pane(id) }
            if index < self.active || self.active >= self.tabs.len() { self.active = self.active.saturating_sub(1) }
        }
        // First load: the desk's tabs replace the empty home tab we started on.
        if first_load && self.tabs.len() > 1 {
            if let Some(home) = self.tabs.iter().position(|t| t.root.is_none() && !t.on_desk) { self.tabs.remove(home); }
            self.active = self.desk_active_saved.take().unwrap_or(0);
        }
        if self.tabs.is_empty() { self.tabs.push(Tab::home()) }
        self.active = self.active.min(self.tabs.len() - 1);
        self.sync_titles();
        self.fit_panes();
    }

    fn desk_pane_added(&mut self, tab_id: &str, machine_id: &str, agent_id: &str) {
        if crate::local::is_local(machine_id) { return }
        let Some(index) = self.tabs.iter().position(|t| t.id == tab_id) else { return };
        let mut ops = Vec::new();
        // The ids this client gave them are every client's for them (%N, @N).
        if self.desk_mode == DeskMode::Sync && self.session_desk {
            if let Some(p) = self.tabs[index].panes().into_iter().find(|p| self.panes.get(p).map(|x| x.machine_id == machine_id && x.agent_id == agent_id).unwrap_or(false)) {
                crate::ids::desk_set(crate::ids::Kind::Pane, &format!("{machine_id}:{agent_id}"), p);
            }
            if !self.tabs[index].on_desk { let wid = self.tabs[index].wid(); crate::ids::desk_set(crate::ids::Kind::Window, tab_id, wid) }
        }
        if !self.tabs[index].on_desk && self.desk_mode == DeskMode::Sync && self.session_desk {
            self.tabs[index].on_desk = true;
            let tab = &self.tabs[index];
            let mut op = json!({ "op": "tab.create", "id": tab.id, "name": tab.name, "index": index });
            if tab.named { op["nameIsCustom"] = json!(true) }
            ops.push(op);
        }
        let at = self.tabs[index].panes().len().saturating_sub(1);
        ops.push(json!({ "op": "pane.add", "tabId": tab_id, "machineId": machine_id, "agentId": agent_id, "index": at }));
        self.desk_ops(ops);
    }

    pub fn desk_op(&mut self, op: Value) { self.desk_ops(vec![op]) }

    /// Preserve input order across writes, including the retry for an older desk schema.
    /// Only reconcile once the queue drains, so an earlier reply cannot undo a later edit.
    pub fn desk_ops(&mut self, ops: Vec<Value>) {
        if self.desk_mode != DeskMode::Sync || !self.session_desk || ops.is_empty() { return }
        self.desk_pending.extend(ops);
        self.send_desk_ops();
    }

    fn send_desk_ops(&mut self) {
        if self.desk_inflight || self.desk_pending.is_empty() { return }
        let strip = |ops: &[Value]| -> Vec<Value> { ops.iter().cloned().map(|mut o| { if let Some(l) = o.get_mut("layout").and_then(Value::as_object_mut) { l.remove("tmux"); } o }).collect() };
        // The backend accepts at most 200 operations per request.
        let ops: Vec<Value> = self.desk_pending.drain(..self.desk_pending.len().min(200)).collect();
        let ops = if self.desk_no_tmux { strip(&ops) } else { ops };
        let again = ops.iter().any(|o| o.pointer("/layout/tmux").is_some()).then(|| strip(&ops));
        let layouts: HashMap<String, Value> = ops.iter().filter(|o| o["op"] == "tab.layout")
            .filter_map(|o| Some((o["id"].as_str()?.to_string(), o["layout"].clone()))).collect();
        let port = self.port;
        self.desk_inflight = true;
        self.spawn(async move { http_json(port, "POST", "/api/desk/ops", Some(&json!({ "ops": ops }))).await }, move |app, reply| {
            app.desk_inflight = false;
            // Network/auth/server failures do not mean the schema lacks tmux layouts.
            if let (Err(error), Some(ops)) = (&reply, again) { if error.code == "HTTP_400" {
                app.desk_no_tmux = true;
                app.desk_pending.splice(0..0, ops);
                app.send_desk_ops();
                return;
            } }
            if reply.is_ok() { app.desk_acked_layouts.extend(layouts) }
            if !app.desk_pending.is_empty() { app.desk_stale = true; app.send_desk_ops(); return }
            match reply {
                Ok(desk) => app.apply_desk(&desk),
                Err(_) => app.fetch_desk(),
            }
            if std::mem::take(&mut app.desk_stale) { app.fetch_desk() }
        });
    }

    /// The outer terminal's title, as set-titles and set-titles-string say (hn's: the harnesses
    /// waiting on you and the one in front, so a terminal tab says what is in it); none with
    /// set-titles off, as tmux leaves the terminal's own.
    pub fn window_title(&self) -> Option<String> {
        if self.options.get("set-titles", "", None).as_deref() != Some("on") { return None }
        let fmt = self.options.get("set-titles-string", "", None).unwrap_or_default();
        Some(crate::format::expand(self, &fmt, self.active, self.focused(), true))
    }

    // ── the loop's slow tick ─────────────────────────────────────────────────

    /// What the daemons know of each harness beyond its row, asked a few at a time, the focused
    /// pane's first, then in the order they need you: its last recap (agent_recent — so what it did
    /// is there after hn starts again), and the pull request for its branch (git_pull_request, at
    /// most every five minutes; none for main or master).
    fn enrich(&mut self) {
        const AT_ONCE: u32 = 4;
        // The accounts' rate limits, from each machine that holds one (every five minutes; the
        // first a few seconds in).
        if self.started.elapsed() > Duration::from_secs(4) && self.usage_checked.map(|t| t.elapsed() > Duration::from_secs(300)).unwrap_or(true) {
            self.usage_checked = Some(Instant::now());
            let ids: Vec<String> = self.fleet.machines.iter().filter(|m| m.usable()).map(|m| m.id.clone()).collect();
            for id in ids {
                let Some(link) = self.link(&id) else { continue };
                self.spawn(async move { link.rpc("usage_read", json!({}), Duration::from_secs(30)).await }, move |app, reply| {
                    let Ok(reply) = reply else { return };
                    let readings: Vec<fleet::Usage> = reply.get("providers").and_then(Value::as_array).map(|p| p.iter().filter_map(fleet::usage_from).collect()).unwrap_or_default();
                    app.usage.insert(id, readings);
                });
            }
        }
        if self.enriching >= AT_ONCE { return }
        let now = Instant::now();
        let focused = self.focused().and_then(|f| self.panes.get(&f)).map(|p| (p.machine_id.clone(), p.agent_id.clone()));
        let rest: Vec<(String, String)> = self.fleet.ranked().into_iter().map(|a| a.key()).filter(|k| Some(k) != focused.as_ref()).collect();
        let order: Vec<(String, String)> = focused.into_iter().chain(rest).collect();
        for (machine, agent_id) in order {
            if self.enriching >= AT_ONCE { break }
            let Some(link) = self.link(&machine) else { continue };
            let Some(a) = self.fleet.agent(&machine, &agent_id) else { continue };
            let live = !matches!(a.status.as_str(), "stopped" | "offline");
            let recap = !a.recap_asked && a.did.is_none() && a.engine != "terminal";
            let pr = live && !a.branch.is_empty() && !matches!(a.branch.as_str(), "main" | "master" | "trunk" | "develop") && a.pr_checked.map(|t| now.duration_since(t) > Duration::from_secs(300)).unwrap_or(true);
            let branch_key = format!("{machine}|{}|{}", if a.project_root.is_empty() { &a.cwd } else { &a.project_root }, a.branch);
            let (working, active_at) = (a.working, a.active_at);
            if recap {
                if let Some(a) = self.fleet.agents.get_mut(&(machine.clone(), agent_id.clone())) { a.recap_asked = true }
                self.enriching += 1;
                let (m, id, link) = (machine.clone(), agent_id.clone(), link.clone());
                self.spawn(async move { link.rpc("agent_recent", json!({ "agentId": id, "n": 1 }), Duration::from_secs(15)).await }, move |app, reply| {
                    app.enriching = app.enriching.saturating_sub(1);
                    let Ok(reply) = reply else { return };
                    let Some(a) = app.fleet.agents.get_mut(&(m.clone(), agent_id_of(&reply).unwrap_or_default())) else { return };
                    let recap = reply.pointer("/events/0").and_then(|e| e.get("recap").or_else(|| e.get("text")).and_then(Value::as_str)).and_then(fleet::first_line);
                    if a.did.is_none() { a.did = recap }
                    let full = reply.pointer("/events/0").and_then(|e| e.get("fullText").or_else(|| e.get("text")).and_then(Value::as_str)).unwrap_or("");
                    if a.last_text.is_empty() { a.last_text = full.trim().to_string() }
                    let ask = reply.pointer("/asks/0").and_then(|x| x.as_str().map(str::to_string).or_else(|| x.get("text").and_then(Value::as_str).map(str::to_string)));
                    if a.asked.is_none() { a.asked = ask.as_deref().and_then(fleet::first_line) }
                });
            }
            // The branch's pull request as another harness (or another client) last heard it. Asked
            // again when a turn has ended since (that is when an agent pushes and opens one), every
            // 15 minutes while one runs, and otherwise every 30 (6 hours once merged or closed) —
            // each `gh` lookup is two calls against the same hourly limit the agents' own use.
            if pr {
                self.read_prs();
                let fresh = self.prs.get(&branch_key).filter(|(p, at)| {
                    let ended = !working && active_at > *at;
                    let ttl = if working { 900_000 } else if p.as_ref().map(|p| matches!(p.state.to_lowercase().as_str(), "merged" | "closed")).unwrap_or(false) { 21_600_000 } else { 1_800_000 };
                    !ended && fleet::now_ms().saturating_sub(*at) < ttl
                }).map(|(p, _)| p.clone());
                if let Some(found) = fresh {
                    if let Some(a) = self.fleet.agents.get_mut(&(machine.clone(), agent_id.clone())) { a.pr = found; a.pr_checked = Some(now) }
                    continue;
                }
                // Another harness on the branch is asking already.
                if self.pr_asking.contains(&branch_key) { continue }
            }
            // At most 20 a minute (a first look at 400 harnesses takes 20 minutes, the ones that
            // need you first) — 2,400 `gh` calls an hour at worst, under GitHub's 5,000.
            if pr && self.enriching < AT_ONCE && Self::take_pr_budget() {
                if let Some(a) = self.fleet.agents.get_mut(&(machine.clone(), agent_id.clone())) { a.pr_checked = Some(now) }
                self.enriching += 1;
                self.pr_asking.insert(branch_key.clone());
                let (m, id) = (machine.clone(), agent_id.clone());
                self.spawn(async move { link.rpc("git_pull_request", json!({ "agentId": id }), Duration::from_secs(30)).await }, move |app, reply| {
                    app.enriching = app.enriching.saturating_sub(1);
                    app.pr_asking.remove(&branch_key);
                    let Ok(reply) = reply else { return };
                    let found = match reply.get("status").and_then(Value::as_str) {
                        Some("found") => Some(Some(fleet::Pr { number: reply.get("number").and_then(Value::as_u64).unwrap_or(0), state: reply.get("state").and_then(Value::as_str).unwrap_or("").to_string(), url: reply.get("url").and_then(Value::as_str).unwrap_or("").to_string() })),
                        Some("none") => Some(None),
                        _ => None,
                    };
                    let Some(a) = app.fleet.agents.get_mut(&(m, agent_id.clone())) else { return };
                    if let Some(p) = found { a.pr = p.clone(); app.keep_pr(branch_key, p) }
                });
            }
        }
    }

    /// One PR lookup out of this computer's 20 a minute — shared by every terminal (and hn with
    /// none) through a file beside prs.json. False when the minute's are spent.
    fn take_pr_budget() -> bool {
        // (Spent: not asked again until the minute is out.)
        static SPENT_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        if fleet::now_ms() < SPENT_UNTIL.load(std::sync::atomic::Ordering::Relaxed) { return false }
        let path = Self::prs_path().with_file_name("prs-budget.json");
        if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
        let _lock = crate::ipc::lock(&path);
        let doc: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let now = fleet::now_ms();
        let (mut since, mut used) = (doc.get("since").and_then(Value::as_u64).unwrap_or(0), doc.get("used").and_then(Value::as_u64).unwrap_or(0));
        if now.saturating_sub(since) >= 60_000 { since = now; used = 0 }
        if used >= 20 { SPENT_UNTIL.store(since + 60_000, std::sync::atomic::Ordering::Relaxed); return false }
        let _ = std::fs::write(&path, json!({ "since": since, "used": used + 1 }).to_string());
        true
    }

    fn prs_path() -> std::path::PathBuf { state_dir().join("prs.json") }

    /// prs.json as this computer's clients last wrote it (read again at most every ten seconds).
    fn read_prs(&mut self) {
        if self.prs_read.map(|t| t.elapsed() < Duration::from_secs(10)).unwrap_or(false) { return }
        self.prs_read = Some(Instant::now());
        let doc: Value = std::fs::read_to_string(Self::prs_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        for (k, v) in doc.as_object().cloned().unwrap_or_default() {
            let at = v.get("at").and_then(Value::as_u64).unwrap_or(0);
            if self.prs.get(&k).map(|(_, mine)| *mine >= at).unwrap_or(false) { continue }
            let pr = v.get("number").and_then(Value::as_u64).map(|number| fleet::Pr { number, state: v.get("state").and_then(Value::as_str).unwrap_or("").into(), url: v.get("url").and_then(Value::as_str).unwrap_or("").into() });
            self.prs.insert(k, (pr, at));
        }
    }

    /// A branch's pull request heard now: kept, and written for the other clients.
    fn keep_pr(&mut self, key: String, pr: Option<fleet::Pr>) {
        let at = fleet::now_ms();
        self.prs.insert(key, (pr, at));
        // (A day's answers at most; the rest are asked again anyway.)
        self.prs.retain(|_, (_, t)| at.saturating_sub(*t) < 86_400_000);
        let doc: serde_json::Map<String, Value> = self.prs.iter().map(|(k, (p, t))| (k.clone(), match p {
            Some(p) => json!({ "number": p.number, "state": p.state, "url": p.url, "at": t }),
            None => json!({ "at": t }),
        })).collect();
        let path = Self::prs_path();
        if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
        let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        if std::fs::write(&temp, Value::Object(doc).to_string()).is_ok() { let _ = std::fs::rename(temp, path); }
    }

    /// The home page is on screen: a window with nothing in it, nothing over it.
    pub fn home_visible(&self) -> bool { self.modal.is_none() && self.tabs.get(self.active).map(|t| t.home || t.root.is_none()).unwrap_or(false) }

    /// The home page's conversations Harness did not start: each connected machine asked once
    /// while the page shows (`session_search` with a time and no words: the last 30 days), as the
    /// desktop's welcome page asks; one that connects meanwhile is asked too. Read afresh the next
    /// time the page shows.
    fn ask_home_external(&mut self) {
        let shown = self.home_visible();
        if shown && !self.home_shown { self.home_asked.clear(); self.home_external.clear() }
        self.home_shown = shown;
        if !shown { return }
        let now = fleet::now_ms();
        let machines: Vec<String> = self.fleet.machines.iter().filter(|m| m.usable() && !self.home_asked.contains(&m.id)).map(|m| m.id.clone()).collect();
        for machine in machines {
            let Some(link) = self.link(&machine) else { continue };
            self.home_asked.insert(machine.clone());
            let payload = json!({ "query": "", "from": now.saturating_sub(30 * 86_400_000), "to": now, "limit": 30 });
            self.spawn(async move { link.rpc("session_search", payload, Duration::from_secs(10)).await }, move |app, reply| {
                // (A daemon without session search has none to offer.)
                let Ok(reply) = reply else { return };
                for x in externals(&machine, &reply) {
                    if !x.open && !app.home_external.iter().any(|y| y.machine == x.machine && y.session_id == x.session_id) { app.home_external.push(x) }
                }
            });
        }
    }

    /// C-b s's query, a moment after its last key: every connected machine asked what was said
    /// (its hits kept while the query is still the one they answer; the list filled again).
    fn ask_said(&mut self) {
        if !self.said_due.is_some_and(|d| Instant::now() >= d) { return }
        self.said_due = None;
        let query = self.said_want.clone();
        let searches = crate::picker::said_searches(&query);
        let generation = self.said_generation;
        self.said_pending = 0;
        let machines: Vec<String> = self.fleet.machines.iter().filter(|m| m.usable()).map(|m| m.id.clone()).collect();
        for machine in machines {
            for search in &searches {
                let Some(link) = self.link(&machine) else { continue };
                self.said_pending += 1;
                let (q, m, query) = (search.clone(), machine.clone(), query.clone());
                self.spawn(async move { link.rpc("session_search", json!({ "query": q, "limit": 20 }), Duration::from_secs(10)).await }, move |app, reply| {
                    if app.said_want != query || app.said_generation != generation { return }
                    app.said_pending = app.said_pending.saturating_sub(1);
                    if app.said_for != query { app.said.clear(); app.said_for = query.clone() }
                    // Alternatives and machines contribute to the same generation. Keep their
                    // union, including different snippets of one conversation, without duplicates.
                    if let Ok(reply) = reply {
                        for hit in said_hits(&m, &reply) {
                            if !app.said.iter().any(|s| s.machine == hit.machine && s.session_id == hit.session_id && s.turn == hit.turn && s.snippet == hit.snippet) { app.said.push(hit) }
                        }
                    }
                    let top = matches!(&app.modal, Some(crate::modal::Modal::Picker { picker, .. }) if picker.cursor == 0);
                    crate::input::refill(app);
                    if top { if let Some(crate::modal::Modal::Picker { picker, .. }) = app.modal.as_mut() { picker.to_top() } }
                });
            }
        }
    }

    /// The latest turns of the rows C-b s shows first — the one it is on and the next two — read
    /// once while it is open (session_tail), for its preview.
    fn ask_tails(&mut self) {
        let Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Open { .. }, picker }) = &self.modal else { return };
        let ids: Vec<String> = picker.visible.iter().skip(picker.cursor).take(3).map(|(i, _)| picker.rows[*i].id.clone()).collect();
        for id in ids {
            let Some((machine, session)) = self.row_session(&id) else { continue };
            if session.is_empty() || !self.tails_asked.insert(session.clone()) { continue }
            let Some(link) = self.link(&machine) else { continue };
            let s = session.clone();
            self.spawn(async move { link.rpc("session_tail", json!({ "sessionId": s, "maxChars": 16_000 }), Duration::from_secs(10)).await }, move |app, reply| {
                if let Ok(tail) = reply { app.tails.insert(session, tail); }
            });
        }
    }

    /// A C-b s row's machine and session: a harness's (`machine:agent`), or a conversation's.
    pub fn row_session(&self, id: &str) -> Option<(String, String)> {
        if let Some(rest) = id.strip_prefix("external:") { return rest.split_once(':').map(|(m, s)| (m.to_string(), s.to_string())) }
        let (m, a) = id.split('#').next()?.split_once(':')?;
        self.fleet.agent(m, a).map(|x| (m.to_string(), x.session_id.clone()))
    }

    /// The chain after the command that started this client, once its session is there (a new
    /// one's first shell come).
    fn run_start_then(&mut self) {
        if self.start_then.is_empty() || self.start_session.is_some() || self.starting_shell.is_some() || !self.tabs.iter().any(|t| t.root.is_some()) { return }
        let then = std::mem::take(&mut self.start_then);
        crate::commands::execute_args(self, &then);
    }

    pub fn on_tick(&mut self) {
        self.run_start_then();
        self.ask_home_external();
        self.ask_said();
        self.ask_tails();
        self.tick += 1;
        // A table kept for a -r key: back to root once repeat-time is up (server_client_repeat_timer).
        if self.key_table_until.is_some_and(|t| Instant::now() >= t) { self.key_table = None; self.key_table_until = None; self.status_redraws += 1 }
        // Since you were here: once every machine's harnesses are listed, so it counts them all.
        if self.back_from.is_some() && !self.headless && self.fleet_ready() { self.back_again() }
        self.enrich();
        // ── models: this computer's models read as often as the Models view needs ──
        crate::models::tick(self);
        self.maybe_start_shell();
        self.release_waiting();
        self.release_cli();
        crate::dial::tick(self);
        if self.tick % 4 == 0 { self.check_silence(); self.check_launches() }
        // The client whose session this one shows gone without a word (killed, its terminal
        // closed): this one has the session now.
        if self.tick % 8 == 2 {
            crate::ipc::claim_name();
            if let Some(m) = self.mirror.clone() { if !crate::ipc::answers(std::path::Path::new(&m.owner)) { crate::mirror::refresh(self) } }
            let owners: Vec<String> = self.mirrors.keys().filter(|m| !crate::ipc::answers(std::path::Path::new(m.as_str()))).cloned().collect();
            if !owners.is_empty() { for m in owners { self.mirrors.remove(&m); self.mirror_ttys.remove(&m); } self.save_sessions() }
        }
        // What the panes on screen run (vim? a build?) moves as you work: asked every two seconds.
        // …and every other window's active pane, which names that window (automatic-rename).
        if self.tick % 8 == 4 {
            let mut ids = self.tab().panes();
            ids.extend(self.tabs.iter().filter_map(|t| t.focus).filter(|f| !ids.contains(f)).collect::<Vec<_>>());
            for p in ids { self.refresh_pane_info(p) }
        }
        // display-panes goes away after display-panes-time, as in tmux.
        if matches!(self.modal, Some(crate::modal::Modal::DisplayPanes { until: Some(until), .. }) if Instant::now() >= until) { self.modal = None }
        self.orphans.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(10));
        self.orphan_exits.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(10));
        for pane in self.panes.values_mut() { pane.settle_predictions() }
        let now = Instant::now();
        for agent in self.fleet.agents.values_mut() {
            if agent.activity.expired(now) { agent.working = false; }
            if !agent.activity.reported() && agent.working && agent.last_beat.map(|t| now.duration_since(t) > Duration::from_secs(30)).unwrap_or(true) {
                agent.working = false; agent.activity.unknown = true;
            }
        }
        let due: Vec<String> = self.links.iter().filter(|(_, s)| s.link.is_none() && s.retry_at.map(|t| t <= now).unwrap_or(false)).map(|(id, _)| id.clone()).collect();
        for id in due {
            if let Some(state) = self.links.get_mut(&id) { state.retry_at = None }
            if id == self.fleet.local_id || self.fleet.machine(&id).map(Machine::online).unwrap_or(false) { self.connect(&id) }
        }
        if self.tick % 120 == 0 { self.refresh_machines() }
        if self.tick % 80 == 40 { self.fleet.save_cache() }
        if self.tick % 20 == 10 { self.save_seen() }
        if self.tick % 8 == 4 { self.reread_seen() }
        if self.tick % 240 == 0 { let ids: Vec<String> = self.links.keys().cloned().collect(); for id in ids { self.relist(&id) } }
        if self.toast.as_ref().map(|t| now.duration_since(t.2).as_millis() > self.toast_ms().max(4000) as u128).unwrap_or(false) { self.toast = None }
        if let Some(Modal::Picker { picker, .. }) = &mut self.modal {
            if picker.flash.as_ref().map(|f| now.duration_since(f.1) > Duration::from_secs(4)).unwrap_or(false) { picker.flash = None }
        }
    }

}

/// The desktop's preset ids (desktop/lib/state/pane_preset.dart, enum names) → our shapes.
/// A desk tab's main pane, as the desktop app draws it: half the window (its presets' main tile is
/// .5 wide or tall), not tmux's main-pane-width of 80 cells, which a narrow terminal can't spare.
pub const DESK_MAIN: (&str, &str) = ("50%", "50%");

/// A desk tab's panes laid out: as another terminal left them (its tmux layout, fitted to this
/// one's size), else its preset for that many panes.
#[cfg(test)]
fn desk_root(doc: &Value, preset: Preset, ids: &[u64], w: u16, h: u16) -> Option<Node> {
    desk_geometry(doc, preset, ids, w, h).map(|(root, _)| root)
}

fn desk_geometry(doc: &Value, preset: Preset, ids: &[u64], w: u16, h: u16) -> Option<(Node, crate::desk_layout::Geometry)> {
    use crate::desk_layout::{self, Geometry};
    let status = layout::Status::Top;
    if let Some(geometry) = desk_layout::saved_tiles(doc, ids.len())
        .and_then(|tiles| Geometry::from_tiles(tiles, ids, w, h, status)) { return Some(geometry) }
    if let Some(mut root) = doc.get("tmux").and_then(Value::as_str).and_then(|l| Node::from_tmux(l, ids, w, h)) {
        desk_reorder(&mut root, ids);
        let geometry = Geometry::capture(&root);
        return Some((root, geometry));
    }
    if let Some(geometry) = desk_layout::preset_tiles(desk_layout::preset_id(doc, ids.len()), ids.len())
        .and_then(|tiles| Geometry::from_tiles(tiles, ids, w, h, status)) { return Some(geometry) }
    let mut root = layout::arrange(layout::Named::of(preset), ids, w, h, status, DESK_MAIN, ("0", "0"))?;
    // Numeric pane IDs belong to one hn server. The desk's ordered identities are
    // authoritative even if a saved native layout has stale or coincidentally matching IDs.
    desk_reorder(&mut root, ids);
    let geometry = Geometry::capture(&root);
    Some((root, geometry))
}

/// Desktop numbers its tiles across the top, then down; tmux tree traversal and
/// pane numbering can differ (a mirrored layout, or columns containing stacks).
fn desk_pane_ids(root: &Node) -> Vec<u64> {
    let (w, h) = root.size();
    let mut rects = Vec::new();
    root.rects(Rect::new(0, 0, w, h), &mut rects);
    rects.sort_by_key(|(_, r)| (r.y, r.x));
    rects.into_iter().map(|(id, _)| id).collect()
}

fn desk_reorder(root: &mut Node, ids: &[u64]) {
    let before = desk_pane_ids(root);
    if before.len() != ids.len() { return }
    root.relabel(&mut |old| before.iter().position(|p| *p == old).map(|i| ids[i]).unwrap_or(old));
}

fn preset_from_desk(id: &str, count: usize) -> Preset {
    match id {
        "columns" | "cols2" | "cols3" | "cols4" | "cols5" | "balanced2" | "balanced3" | "balanced4" | "balanced5" => Preset::Columns,
        "splitLong" if count == 2 => Preset::Columns,
        "rows" => Preset::Rows,
        "mainAndStack" | "mainLeft" | "mainAndGrid" | "mainRight" | "middleMain" => Preset::MainStack,
        "oneOverTwo" | "mainOverGrid" | "twoOverOne" | "twoOverThree" => Preset::MainRow,
        _ => Preset::Grid,
    }
}

/// Compare only this pane count's consumed geometry. Normalized slots take
/// precedence; native strings and presets support clients predating them.
fn desk_layout_changed(before: &Value, after: &Value, count: usize) -> bool {
    let tiles = |doc| crate::desk_layout::saved_tiles(doc, count);
    if tiles(after).is_some() { return tiles(before) != tiles(after) }
    if let Some(native) = after.get("tmux").and_then(Value::as_str) {
        return before.get("tmux").and_then(Value::as_str) != Some(native);
    }
    // Older desktop versions can omit sizes/tmux on an unrelated save. Only
    // their changed preset is an edit; new clients send geometry for resets too.
    let shape = |doc: &Value| doc.get("presets").and_then(|p| p.get(count.to_string()))
        .and_then(Value::as_str).and_then(|id| crate::desk_layout::preset_tiles(id, count));
    shape(before) != shape(after)
}

/// Desktop presets with the same split topology. Unsupported shapes retain their
/// exact native layout without publishing an invalid preset for that pane count.
fn named_to_desk(named: layout::Named, count: usize) -> Option<&'static str> {
    use layout::Named::*;
    Some(match (count, named) {
        (2, EvenHorizontal | MainVertical | MainVerticalMirrored) => "columns",
        (2, _) => "rows",
        (3, EvenHorizontal) => "cols3",
        (4, EvenHorizontal) => "cols4",
        (5, EvenHorizontal) => "cols5",
        (3 | 4, EvenVertical) => "rows",
        (3, MainHorizontal) => "oneOverTwo",
        (3, MainHorizontalMirrored | Tiled) => "twoOverOne",
        (3, MainVertical) => "mainLeft",
        (3, MainVerticalMirrored) => "mainRight",
        (4, MainHorizontal) => "mainOverGrid",
        (4, MainVertical) => "mainAndStack",
        (4, Tiled) => "quad",
        (5 | 6, Tiled) => "balanced2",
        (9, Tiled) => "balanced3",
        _ => return None,
    })
}

/// split-window's: where the new pane goes — beside a pane of a window (-t), before it (-b), across
/// the whole window (-f), its size (-l: cells, or a percentage), and whether it is gone to (-d).
#[derive(Clone, PartialEq, Debug)]
pub struct At { pub tab: String, pub pane: Option<u64>, pub dir: Dir, pub before: bool, pub full: bool, pub size: Option<(u16, bool)>, pub detached: bool, pub zoom: bool }

#[derive(Clone, PartialEq, Debug)]
pub enum Placement {
    /// Into the focused tile's place when the tab is empty, else a smart split (or the one given).
    Auto(Option<Dir>),
    Split(Dir),
    Tab,
    /// A window of its own in the session in front, even when it is open in another session (a
    /// project's session gathers its harnesses: each shown in both).
    Window,
    Replace,
    At(At),
    /// Into the empty window with this id, in whichever session it is (a new session's first).
    Fill(String),
}

/// This client's terminal (tmux's client name): /dev/ttys003.
pub fn tty_name() -> String {
    static TTY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TTY.get_or_init(|| {
        let p = unsafe { libc::ttyname(0) };
        if p.is_null() { return String::new() }
        unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }).clone()
}

/// This computer's offset from UTC, in seconds (`date +%z`), read once.
pub fn utc_offset() -> i64 {
    static OFFSET: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *OFFSET.get_or_init(|| {
        let out = std::process::Command::new("date").arg("+%z").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        let sign = if out.starts_with('-') { -1 } else { 1 };
        let h: i64 = out.get(1..3).and_then(|x| x.parse().ok()).unwrap_or(0);
        let m: i64 = out.get(3..5).and_then(|x| x.parse().ok()).unwrap_or(0);
        sign * (h * 3600 + m * 60)
    })
}

/// A pane's pipe (pipe-pane): the command's stdin, fed what the pane prints (-O); which pipe it
/// is, so one that ended does not close its successor.
pub struct Pipe { out: Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>, id: u64 }

/// The state the event hooks compare against: each window (its id, @number, name, active pane
/// and layout), the current window, the focused pane, the session's name, and which panes are
/// in a mode.
#[derive(Default, Clone)]
pub struct HooksSeen { ready: bool, session_id: u32, titles: HashMap<u64, (String, String)>, windows: Vec<(String, Option<u64>, String, Option<u64>, String)>, current: Option<String>, client: bool, modes: Vec<u64>, focused: Vec<u64> }

/// gethostname(3), as tmux's #{host} reads it (`mac.lan`, not `hostname -s`'s `mac`).
pub fn full_hostname() -> String {
    static HOST: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HOST.get_or_init(|| {
        let mut buf = [0u8; 256];
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0;
        if !ok { return String::new() }
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    }).clone()
}

pub fn hostname() -> String {
    static HOST: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HOST.get_or_init(|| {
        let raw = std::process::Command::new("hostname").arg("-s").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        if raw.is_empty() { "this computer".into() } else { raw }
    }).clone()
}

#[cfg(test)]
mod scroll_settle_tests {
    use super::*;

    #[test]
    fn the_screen_is_written_whole_once_the_wheel_has_rested() {
        let t0 = Instant::now();
        // No scroll, nothing to settle.
        assert_eq!(scroll_settle_in(None, t0), None);
        // Just scrolled: the whole rest period is still owed.
        assert_eq!(scroll_settle_in(Some(t0), t0), Some(SCROLL_SETTLE));
        // Part of it has passed.
        assert_eq!(scroll_settle_in(Some(t0), t0 + SCROLL_SETTLE / 2), Some(SCROLL_SETTLE / 2));
        // Rested for long enough: due now (zero), and never negative.
        assert_eq!(scroll_settle_in(Some(t0), t0 + SCROLL_SETTLE), Some(Duration::ZERO));
        assert_eq!(scroll_settle_in(Some(t0), t0 + SCROLL_SETTLE * 4), Some(Duration::ZERO));
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    #[tokio::test]
    async fn os_starts_at_the_agent_launcher_without_creating_an_unused_shell() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (80, 24));
        app.handed_over = true;
        app.os_session = true;
        app.desk_answered = true;
        app.maybe_start_shell();
        assert!(app.shell_asked);
        assert!(app.starting_shell.is_none());
        assert!(app.tabs.iter().all(|tab| tab.root.is_none()));
        assert!(!app.quit);
    }

    #[tokio::test]
    async fn os_surface_stays_home_after_its_last_session_closes() {
        for desk in [false, true] {
            let (sink, _) = tokio::sync::mpsc::unbounded_channel();
            let mut app = App::new(19789, sink, (80, 24));
            app.handed_over = true; // This state fixture must not persist a session.
            app.os_session = true;
            app.session_desk = desk;
            app.tabs.clear();
            app.session_gone_quiet();
            assert!(!app.quit);
            assert!(!app.exited);
            assert_eq!(app.tabs.len(), 1);
            assert!(app.tabs[0].root.is_none());
            assert_eq!(app.active, 0);
        }
    }

    #[tokio::test]
    async fn ordinary_client_still_exits_after_its_last_session_closes() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (80, 24));
        app.handed_over = true;
        app.os_session = false;
        app.session_desk = false;
        app.tabs.clear();
        app.session_gone_quiet();
        assert!(app.quit);
        assert!(app.exited);
    }

    #[tokio::test]
    async fn respawn_reply_and_fast_exit_deliver_one_death_hook_in_either_order() {
        for exit_before_reply in [false, true] {
            let (sink, _) = tokio::sync::mpsc::unbounded_channel();
            let mut app = App::new(19789, sink, (80, 24));
            // State/hook test only: never persist a fixture session.
            app.handed_over = true;
            let mut tab = Tab::with_wid("Respawn", 4);
            tab.root = Some(Node::new(1, 80, 23));
            tab.focus = Some(1);
            app.tabs = vec![tab];
            app.panes.insert(1, Pane::new(1, crate::local::MACHINE, "fixture", 80, 23));
            app.options.global_window.insert("remain-on-exit".into(), "on".into());
            crate::commands::execute(&mut app, "set-hook -g pane-died 'set -ag @deaths x'");
            let old = pane::Exit { id: "old-process".into(), status: Some(7), signal: None, time: 1 };
            let new = pane::Exit { id: "replacement-process".into(), status: Some(9), signal: None, time: 2 };
            app.local_ended(1, old.clone());
            assert_eq!(app.pending_hooks.len(), 1);
            app.pending_hooks.clear();
            if exit_before_reply { app.local_ended(1, new.clone()); }
            app.panes.get_mut(&1).unwrap().complete_restart(Some(&old.id), Some("exit 9".into()));
            if !exit_before_reply { app.local_ended(1, new.clone()); }
            // Reopening a stream replays the current exit. It must not emit a
            // second pane-died after the callback has handled the RPC reply.
            app.local_ended(1, new.clone());
            assert_eq!(app.pending_hooks.len(), 1, "exit before RPC reply: {exit_before_reply}");
            assert_eq!(app.panes[&1].dead.as_ref(), Some(&new));
            assert_eq!(app.panes[&1].start_command.as_deref(), Some("exit 9"));
        }
    }

    // Current-thread tests never yield to this link: it is cancelled before it can connect.
    // No daemon, disk cache, real pane or server socket is used.
    fn fixture() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (80, 24));
        app.fleet.machines.push(Machine { id: "test-peer".into(), name: "Peer".into(), local: false, status: "running".into(), reach: Reach::Ready });
        let link = Link::spawn(app.port, "test-peer", 1, app.sink.clone());
        app.links.insert("test-peer".into(), LinkState { link: Some(link), generation: 1, attempts: 0, retry_at: None });
        for id in 1..=4 {
            let mut pane = Pane::new(id, if id == 4 { "other-peer" } else { "test-peer" }, &format!("agent-{id}"), 80, 24);
            pane.phase = Phase::Live;
            pane.stream = Some(Uuid::new_v4());
            pane.open_token = 7;
            app.panes.insert(id, pane);
        }
        app.panes.get_mut(&3).unwrap().phase = Phase::Card { title: "Paused".into(), detail: String::new(), keys: Vec::new() };
        app.panes.get_mut(&3).unwrap().stream = None;
        app.shells.insert(("test-peer".into(), "agent-2".into()));
        app
    }

    #[tokio::test]
    async fn taking_control_reclaims_hidden_local_and_remote_panes_without_moving_focus() {
        let mut app = fixture();
        app.fleet.machines[0].local = true;
        app.fleet.local_id = "test-peer".into();
        app.fleet.machines.push(Machine { id: "other-peer".into(), name: "Remote".into(), local: false, status: "running".into(), reach: Reach::Ready });
        app.links.insert("other-peer".into(), LinkState { link: Some(Link::spawn(app.port, "other-peer", 1, app.sink.clone())), generation: 1, attempts: 0, retry_at: None });
        let mut controlled = Pane::new(5, "test-peer", "already-controlled", 80, 24);
        controlled.stream = Some(Uuid::new_v4());
        controlled.phase = Phase::Live;
        let stream = controlled.stream;
        app.panes.insert(5, controlled);
        app.tabs = (1..=5).map(|id| {
            let mut tab = Tab::with_wid("Control test", id);
            tab.root = Some(Node::new(id, 80, 23));
            tab.focus = Some(id);
            tab
        }).collect();
        app.active = 1;
        for id in [1, 2, 4] {
            let pane = app.panes.get_mut(&id).unwrap();
            pane.phase = Phase::Watching("another app".into());
            pane.read_only = true;
        }
        app.client_flags.push("read-only".into());
        app.take_control();
        assert!(![1, 2, 4].iter().any(|id| app.panes[id].opening));
        app.client_flags.clear();
        app.take_control();
        for id in [1, 2, 4] {
            assert!(app.panes[&id].opening);
            assert_eq!(app.panes[&id].open_token, 8);
        }
        assert!(matches!(app.panes[&3].phase, Phase::Card { .. }));
        assert_eq!(app.panes[&5].stream, stream);
        assert_eq!(app.active, 1);
        assert_eq!(app.focused(), Some(2));
        app.take_control();
        for id in [1, 2, 4] { assert_eq!(app.panes[&id].open_token, 8); }
        for state in app.links.values() { state.link.as_ref().unwrap().close(); }
    }

    #[tokio::test]
    async fn taking_control_during_a_passive_open_preserves_input_and_claims_once() {
        let mut app = fixture();
        app.tabs[0].root = Some(Node::new(1, 80, 23));
        app.tabs[0].focus = Some(1);
        let pane = app.panes.get_mut(&1).unwrap();
        pane.phase = Phase::Watching("another app".into());
        pane.read_only = true;
        pane.opening = true;
        pane.stream = None;
        pane.queued.push(b"hello".to_vec());
        app.take_control();
        assert!(app.panes[&1].takeover_pending);
        assert_eq!(app.panes[&1].open_token, 7);
        app.opened(1, "test-peer", 7, (80, 24), Ok(("terminal_ready".into(), json!({"streamId":Uuid::new_v4().to_string(),"readOnly":true}))));
        assert!(app.panes[&1].opening);
        assert!(!app.panes[&1].takeover_pending);
        assert_eq!(app.panes[&1].open_token, 8);
        assert_eq!(app.panes[&1].queued, [b"hello".to_vec()]);
        app.opened(1, "test-peer", 8, (80, 24), Ok(("terminal_ready".into(), json!({"streamId":Uuid::new_v4().to_string(),"readOnly":false}))));
        assert!(matches!(app.panes[&1].phase, Phase::Live));
        assert!(app.panes[&1].queued.is_empty());
        app.take_control();
        assert_eq!(app.panes[&1].open_token, 8);
        // A passive watcher response with no new gesture must never retake a terminal.
        app.opened(2, "test-peer", 7, (80, 24), Ok(("terminal_ready".into(), json!({"streamId":Uuid::new_v4().to_string(),"readOnly":true}))));
        assert!(matches!(app.panes[&2].phase, Phase::Watching(_)));
        assert!(!app.panes[&2].opening);
        app.links["test-peer"].link.as_ref().unwrap().close();
    }

    #[tokio::test]
    async fn expired_lease_recovers_hidden_shells_and_ignores_cancelled_events() {
        let mut app = fixture();
        let other = app.panes[&4].stream;
        let expired = app.panes[&2].stream.unwrap();
        app.on_machine("test-peer".into(), 1, MachineEvent::Frame { ty: "terminal_closed".into(), payload: json!({"streamId":expired.to_string(),"reason":"heartbeat timeout"}) });
        assert_eq!(app.panes.len(), 4);
        assert!(app.shells.contains(&("test-peer".into(), "agent-2".into())));
        for id in [1, 2] {
            assert!(matches!(app.panes[&id].phase, Phase::Connecting(_)));
            assert!(app.panes[&id].stream.is_none());
            assert_eq!(app.panes[&id].open_token, 8);
        }
        assert!(matches!(app.panes[&3].phase, Phase::Card { .. }));
        assert_eq!(app.panes[&4].stream, other);
        assert!(app.links["test-peer"].link.is_none());
        let retry = app.links["test-peer"].retry_at;
        assert!(retry.is_some());
        // Events already queued by the cancelled task cannot resurrect it or delay the retry.
        app.on_machine("test-peer".into(), 1, MachineEvent::Connected);
        app.on_machine("test-peer".into(), 1, MachineEvent::Closed(RpcError::new("DISCONNECTED", "")));
        assert_eq!(app.links["test-peer"].retry_at, retry);
        assert!(matches!(app.fleet.machines[0].reach, Reach::Error(_)));
        let late = Uuid::new_v4();
        app.opened(1, "test-peer", 7, (80, 24), Ok(("terminal_ready".into(), json!({"streamId":late.to_string()}))));
        assert!(app.panes[&1].stream.is_none());
        assert!(matches!(app.panes[&1].phase, Phase::Connecting(_)));
    }

    #[tokio::test]
    async fn open_timeout_and_disconnect_recover_but_protocol_refusals_do_not() {
        for code in ["TIMEOUT", "DISCONNECTED", "TERMINAL_PROTOCOL_UNSUPPORTED"] {
            let mut app = fixture();
            app.panes.get_mut(&1).unwrap().phase = Phase::Connecting("Opening…".into());
            app.panes.get_mut(&1).unwrap().opening = true;
            app.opened(1, "test-peer", 7, (80, 24), Err(RpcError::new(code, "test failure")));
            assert!(!app.panes[&1].opening);
            if code == "TERMINAL_PROTOCOL_UNSUPPORTED" {
                assert!(matches!(app.panes[&1].phase, Phase::Card { .. }));
                assert!(app.links["test-peer"].retry_at.is_none());
                app.links["test-peer"].link.as_ref().unwrap().close();
            } else {
                assert!(matches!(app.panes[&1].phase, Phase::Connecting(_)));
                assert!(app.links["test-peer"].retry_at.is_some());
                assert!(app.links["test-peer"].link.is_none());
            }
        }
    }

    #[tokio::test]
    async fn pane_waits_for_machine_selection_before_opening() {
        let mut app = fixture();
        app.fleet.machines[0].reach = Reach::Connecting;
        app.panes.get_mut(&1).unwrap().stream = None;
        app.open_stream(1, false);
        assert!(!app.panes[&1].opening);
        assert_eq!(app.panes[&1].open_token, 7);
        app.links["test-peer"].link.as_ref().unwrap().close();
    }
}


#[cfg(test)]
mod desk_layout_tests {
    use super::*;

    fn fixture() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19809, sink, (120, 36));
        app.session_desk = true;
        let mut tab = Tab::with_wid("Layout test", 1);
        tab.id = "layout-test".into();
        tab.on_desk = true;
        tab.layout = json!({"presets":{"3":"columns"}});
        tab.desk_layout = tab.layout.clone();
        tab.desk_panes = (1..=3).map(|id| ("layout-peer".into(), format!("agent-{id}"))).collect();
        tab.root = layout::arrange(layout::Named::MainHorizontal, &[1, 2, 3], 120, 35, layout::Status::Top, ("80", "12"), ("0", "0"));
        tab.focus = Some(1);
        for id in 1..=3 {
            let mut pane = Pane::new(id, "layout-peer", &format!("agent-{id}"), 120, 35);
            pane.phase = Phase::Live;
            app.panes.insert(id, pane);
        }
        app.tabs = vec![tab];
        app.desk_revision = 1;
        app
    }

    fn desk(revision: i64, layout: Value) -> Value {
        json!({"revision":revision,"tabs":[{"id":"layout-test","name":"Layout test","layout":layout,
            "panes":(1..=3).map(|id| json!({"machineId":"layout-peer","agentId":format!("agent-{id}")})).collect::<Vec<_>>()}]})
    }

    fn geometry(app: &App) -> String { app.tabs[0].root.as_ref().unwrap().to_tmux() }

    #[test]
    fn remote_pane_reorder_keeps_dividers_and_focused_identity() {
        let mut app = fixture();
        app.tabs[0].order = vec![1, 2, 3];
        app.tabs[0].focus = Some(2);
        let mut expected = app.tabs[0].root.clone().unwrap();
        expected.relabel(&mut |id| match id { 1 => 3, 2 => 1, 3 => 2, _ => id });
        let mut update = desk(2, app.tabs[0].layout.clone());
        update["tabs"][0]["panes"].as_array_mut().unwrap().rotate_right(1);
        app.apply_desk(&update);
        assert_eq!(geometry(&app), expected.to_tmux());
        assert_eq!(app.tabs[0].panes(), vec![3, 1, 2]);
        assert_eq!(app.tabs[0].focus, Some(2));
        assert_eq!(app.panes.len(), 3);
        assert!(app.panes.values().all(|p| matches!(p.phase, Phase::Live)));
        update["revision"] = json!(3);
        app.apply_desk(&update);
        assert_eq!(geometry(&app), expected.to_tmux());
    }

    #[test]
    fn remote_order_and_layout_change_apply_together() {
        let mut app = fixture();
        let mut update = desk(2, json!({"presets":{"3":"rows"}}));
        update["tabs"][0]["panes"].as_array_mut().unwrap().rotate_right(1);
        app.apply_desk(&update);
        assert_eq!(app.tabs[0].root.as_ref().unwrap().leaves(), vec![3, 1, 2]);
        assert_eq!(app.tabs[0].panes(), vec![3, 1, 2]);
        assert_eq!(app.tabs[0].focus, Some(1));
    }

    #[test]
    fn saved_native_layout_uses_desk_order_instead_of_old_pane_numbers() {
        let native = layout::arrange(layout::Named::EvenHorizontal, &[29, 31, 13], 120, 35,
            layout::Status::Top, DESK_MAIN, ("0", "0")).unwrap();
        let root = desk_root(&json!({"tmux": native.to_tmux()}), Preset::Columns,
            &[31, 13, 29], 120, 35).unwrap();
        assert_eq!(root.leaves(), vec![31, 13, 29]);
    }

    #[test]
    fn queued_local_rotation_survives_an_older_desk_snapshot() {
        let mut app = fixture();
        app.desk_mode = DeskMode::Read;
        app.tabs[0].order = vec![1, 2, 3];
        app.rotate(0, 1, false);
        let chosen = geometry(&app);
        let mut update = desk(2, app.tabs[0].layout.clone());
        update["tabs"][0]["panes"].as_array_mut().unwrap().swap(0, 1);
        app.apply_desk(&update);
        assert_eq!(geometry(&app), chosen);
        app.send_desk_layouts();
        assert_eq!(geometry(&app), chosen);
        // Once observed, the same snapshot is metadata, not a fresh reorder.
        update["revision"] = json!(3);
        app.apply_desk(&update);
        assert_eq!(geometry(&app), chosen);
        update["revision"] = json!(4);
        update["tabs"][0]["panes"].as_array_mut().unwrap().rotate_right(1);
        app.apply_desk(&update);
        assert_eq!(desk_pane_ids(app.tabs[0].root.as_ref().unwrap()), vec![3, 2, 1]);
    }

    #[test]
    fn shared_pane_sequence_is_spatial_not_tree_or_tmux_number_order() {
        let mut root = layout::arrange(layout::Named::MainVerticalMirrored, &[1, 2, 3], 120, 35,
            layout::Status::Top, DESK_MAIN, ("0", "0")).unwrap();
        assert_eq!(desk_pane_ids(&root), vec![2, 1, 3]);
        desk_reorder(&mut root, &[3, 1, 2]);
        assert_eq!(desk_pane_ids(&root), vec![3, 1, 2]);
    }

    #[test]
    fn unchanged_remote_layout_does_not_undo_an_unsaved_local_edit() {
        let mut app = fixture();
        let chosen = geometry(&app);
        app.tabs[0].layout["tmux"] = json!(chosen);
        // A failed save or read-only desk: a rename elsewhere bumps the revision, but this
        // tab's server layout is still what it was before the local change.
        app.apply_desk(&desk(2, json!({"presets":{"3":"columns"}})));
        assert_eq!(geometry(&app), chosen);
        // An actual subsequent layout choice elsewhere still takes effect.
        app.apply_desk(&desk(3, json!({"presets":{"3":"rows"}})));
        assert_ne!(geometry(&app), chosen);
    }

    #[test]
    fn a_desktop_round_trip_keeps_a_two_pane_layout_choice() {
        let mut app = fixture();
        app.tabs[0].root = layout::arrange(layout::Named::MainHorizontal, &[1, 2], 120, 35,
            layout::Status::Top, ("80", "12"), ("0", "0"));
        app.panes.remove(&3);
        let chosen = geometry(&app);
        app.tabs[0].layout = json!({"presets":{"2":"columns"},"tmux":chosen});
        app.tabs[0].desk_layout = app.tabs[0].layout.clone();
        let mut update = desk(2, json!({"presets":{"2":"columns"},"sizes":{}}));
        update["tabs"][0]["panes"].as_array_mut().unwrap().pop();
        // Desktop knows presets/sizes, but its serializer drops the terminal-only field.
        app.apply_desk(&update);
        assert_eq!(geometry(&app), chosen);
        // Editing another pane count's preset also leaves this two-pane window alone.
        update["revision"] = json!(3);
        update["tabs"][0]["layout"]["presets"]["3"] = json!("rows");
        app.apply_desk(&update);
        assert_eq!(geometry(&app), chosen);
        // A deliberate remote choice for the current count still applies.
        update["revision"] = json!(4);
        update["tabs"][0]["layout"]["presets"]["2"] = json!("rows");
        app.apply_desk(&update);
        assert_ne!(geometry(&app), chosen);
    }

    #[test]
    fn desktop_metadata_and_preset_aliases_do_not_reset_native_geometry() {
        let mut app = fixture();
        let chosen = geometry(&app);
        app.tabs[0].layout = json!({"presets":{"3":"cols3"},"tmux":chosen});
        app.tabs[0].desk_layout = app.tabs[0].layout.clone();
        app.apply_desk(&desk(2, json!({"presets":{"3":"columns","4":"quad"},"sizes":{"4:quad":[]}})));
        assert_eq!(geometry(&app), chosen);
        // Another hn's explicit native geometry is still authoritative.
        let root = layout::arrange(layout::Named::EvenVertical, &[1, 2, 3], 120, 35,
            layout::Status::Top, DESK_MAIN, ("0", "0")).unwrap();
        app.apply_desk(&desk(3, json!({"presets":{"3":"columns"},"tmux":root.to_tmux()})));
        assert_ne!(geometry(&app), chosen);
    }

    #[test]
    fn queued_preset_survives_reconciliation_without_overwriting_later_remote_choices() {
        let mut app = fixture();
        app.desk_mode = DeskMode::Read; // Inspect publication without any HTTP task.
        app.arrange_tab(0, layout::Named::EvenHorizontal);
        let chosen = geometry(&app);
        app.apply_desk(&desk(2, json!({"presets":{"3":"rows"}})));
        app.send_desk_layouts();
        assert_eq!(geometry(&app), chosen);
        assert_eq!(app.tabs[0].layout["presets"]["3"], "cols3");
        let sent = app.tabs[0].layout.clone();
        app.apply_desk(&desk(3, sent));
        app.apply_desk(&desk(4, json!({"presets":{"3":"rows"}})));
        assert_ne!(geometry(&app), chosen);
        // A divider edit after the remote choice must not revive our old preset.
        app.layout_changed(0);
        app.send_desk_layouts();
        assert_eq!(app.tabs[0].layout["presets"]["3"], "rows");
    }

    #[test]
    fn named_layouts_publish_desktop_presets_valid_for_the_pane_count() {
        use layout::Named::*;
        for named in layout::Named::ALL {
            assert_eq!(named_to_desk(named, 1), None);
            assert!(matches!(named_to_desk(named, 2), Some("columns" | "rows")));
        }
        assert_eq!(named_to_desk(MainHorizontal, 3), Some("oneOverTwo"));
        assert_eq!(named_to_desk(MainHorizontalMirrored, 3), Some("twoOverOne"));
        assert_eq!(named_to_desk(MainVertical, 3), Some("mainLeft"));
        assert_eq!(named_to_desk(MainVerticalMirrored, 3), Some("mainRight"));
        assert_eq!(named_to_desk(MainVertical, 4), Some("mainAndStack"));
        assert_eq!(named_to_desk(EvenHorizontal, 6), None);
        assert_eq!(named_to_desk(EvenVertical, 5), None);
    }

    #[test]
    fn fitting_a_shared_layout_does_not_publish_an_edit() {
        let mut app = fixture();
        app.notify_changes();
        app.size = (96, 28);
        app.fit_panes();
        assert!(!app.pending_resize_hooks.is_empty());
        app.notify_changes();
        assert!(app.pending_resize_hooks.is_empty());
        assert!(app.desk_layouts.is_empty());
        // An intentional edit still marks the window for desk synchronization.
        app.step_layout(0, true);
        assert!(app.desk_layouts.contains("layout-test"));
    }

    #[test]
    fn legacy_acknowledgement_and_queued_input_keep_exact_geometry() {
        let mut app = fixture();
        let chosen = geometry(&app);
        let accepted = json!({"presets":{"3":"mainOverGrid"}});
        app.tabs[0].layout = accepted.clone();
        app.tabs[0].layout["tmux"] = json!(chosen);
        app.desk_acked_layouts.insert("layout-test".into(), accepted.clone());
        // A preset's fallback proportions differ from tmux's explicit 12-row main pane.
        app.apply_desk(&desk(2, accepted));
        assert_eq!(geometry(&app), chosen);
        assert!(app.desk_acked_layouts.is_empty());
        // A reply and a key can be drained in one event batch, before save_if_changed.
        app.desk_layouts.insert("layout-test".into());
        app.apply_desk(&desk(3, json!({"presets":{"3":"rows"}})));
        assert_eq!(geometry(&app), chosen);
        app.desk_layouts.clear();
        app.apply_desk(&desk(4, json!({"presets":{"3":"columns"}})));
        assert_ne!(geometry(&app), chosen);
    }

    #[test]
    fn desktop_manual_slot_order_survives_resize_focus_zoom_and_remote_moves() {
        let mut app = fixture();
        app.tabs[0].focus = Some(2);
        app.tabs[0].zoomed = true;
        // Splitting the first column makes slots 1 and 2 vertical siblings;
        // slot 3 is on the right. Index order is not screen reading order.
        let tiles = json!([[0.0,0.0,0.3,0.7],[0.0,0.7,0.3,1.0],[0.3,0.0,1.0,1.0]]);
        let layout = json!({"presets":{"3":"cols3"},"sizes":{"3:manual":tiles},"tmux":"obsolete"});
        let mut update = desk(2, layout.clone());
        app.apply_desk(&update);
        let original = geometry(&app);
        assert_eq!(desk_pane_ids(app.tabs[0].root.as_ref().unwrap()), [1, 3, 2]);
        assert_eq!(app.tabs[0].focus, Some(2));
        assert!(app.tabs[0].zoomed);
        for size in [(80, 24), (240, 80), (100, 30), (120, 36)] {
            app.size = size;
            app.fit_panes();
            app.notify_changes();
        }
        assert_eq!(geometry(&app), original);
        assert!(app.desk_layouts.is_empty());
        assert_eq!(app.tabs[0].layout, layout);
        update["revision"] = json!(3);
        update["tabs"][0]["panes"].as_array_mut().unwrap().swap(0, 1);
        app.apply_desk(&update);
        assert_eq!(desk_pane_ids(app.tabs[0].root.as_ref().unwrap()), [2, 3, 1]);
        assert_eq!(app.tabs[0].focus, Some(2));
        assert!(app.panes.values().all(|p| matches!(p.phase, Phase::Live)));
    }

    #[test]
    fn exact_local_preset_survives_queued_resize_and_old_snapshot() {
        let mut app = fixture();
        app.desk_mode = DeskMode::Read;
        app.apply_shared_preset("mainRight");
        app.size = (83, 27);
        app.fit_panes();
        app.apply_desk(&desk(2, json!({"presets":{"3":"rows"}})));
        app.send_desk_layouts();
        assert_eq!(app.tabs[0].layout["presets"]["3"], "mainRight");
        assert_eq!(crate::desk_layout::saved_tiles(&app.tabs[0].layout, 3), crate::desk_layout::preset_tiles("mainRight", 3));
        assert_eq!(desk_pane_ids(app.tabs[0].root.as_ref().unwrap()), [1, 2, 3]);
        let sent = app.tabs[0].layout.clone();
        app.apply_desk(&desk(3, sent.clone()));
        app.apply_desk(&desk(4, json!({"presets":{"3":"mainRight"},"sizes":{}})));
        // Old desktop metadata cannot reset the exact cut. An explicit new
        // desktop divider edit, even with the same preset, still applies.
        let mut resized = sent;
        resized["sizes"]["3:manual"] = json!([[0.0,0.0,0.2,0.6],[0.2,0.0,1.0,1.0],[0.0,0.6,0.2,1.0]]);
        app.apply_desk(&desk(5, resized));
        assert_eq!(app.tabs[0].shared_geometry.as_ref().unwrap().slots[0].1[2], 0.2);
    }

    #[test]
    fn zoom_and_local_chrome_never_publish_layouts() {
        let mut app = fixture();
        crate::input::run(&mut app, "zoom");
        assert!(app.tabs[0].zoomed);
        app.view_layout_changed(0);
        assert!(app.desk_layouts.is_empty());
        crate::input::run(&mut app, "zoom");
        assert!(!app.tabs[0].zoomed);
        assert!(app.desk_layouts.is_empty());
    }

    #[test]
    fn an_explicit_remote_default_replaces_a_read_only_clients_local_choice() {
        let mut app = fixture();
        app.desk_mode = DeskMode::Read;
        app.tabs[0].layout = json!({});
        app.tabs[0].desk_layout = json!({});
        app.apply_shared_preset("rows");
        app.send_desk_layouts();
        app.apply_desk(&desk(2, json!({"presets":{"3":"cols3"}})));
        let slots = app.tabs[0].shared_geometry.as_ref().unwrap();
        assert!(slots.slots.iter().all(|(_, tile)| tile[1] == 0.0 && tile[3] == 1.0));
    }
}
