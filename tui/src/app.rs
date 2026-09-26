//! The whole TUI's state and everything that changes it — except keys, which are `input.rs`, and
//! drawing, which is `ui.rs`. One owner, one loop: machine frames, terminal bytes, keys and the
//! results of background requests all arrive as `Event`s and are applied here in order.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use ratatui::layout::Rect;
use ratatui::style::Color;
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

/// A command's answer to the shell that ran it: printed lines, errors, exit status.
pub type Reply = (Vec<String>, Vec<String>, i32);

pub struct Tab {
    /// The desk's tab id (32 hex), shared with every other window on the account.
    pub id: String,
    /// tmux's window id (#{window_id} `@N`): given when the window is made, never reused.
    pub wid: u64,
    pub name: String,
    pub named: bool,
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
    /// Where `next-layout` (Space) is in its cycle.
    pub layout_at: usize,
    /// Whether the desk knows this tab yet (a new, empty tab is local until its first harness).
    pub on_desk: bool,
    /// synchronize-panes: keys go to every pane here.
    pub sync: bool,
    /// The desk's layout document for this tab, kept whole: a preset chosen here updates its entry
    /// and leaves the sizes other windows saved alone.
    pub layout: Value,
}

impl Tab {
    pub fn new(name: &str) -> Tab {
        static WID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let wid = WID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Tab { id: Uuid::new_v4().simple().to_string(), wid, name: name.to_string(), named: false, root: None, focus: None, zoomed: false, last: Vec::new(), order: Vec::new(), points: HashMap::new(), layout_at: 4, on_desk: false, sync: false, layout: json!({}) }
    }
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
    pub sink: UnboundedSender<Event>,
    pub fleet: Fleet,
    links: HashMap<String, LinkState>,
    generation: u64,
    pub tabs: Vec<Tab>,
    pub active: usize,
    pub panes: HashMap<u64, Pane>,
    next_pane: u64,
    pub modal: Option<Modal>,
    pub toast: Option<(String, Color, Instant)>,
    /// tmux `display-time`: how long a message holds the status line.
    pub display_ms: u64,
    pub display_panes_ms: u64,
    /// tmux `base-index` / `pane-base-index`.
    pub base_index: usize,
    pub pane_base_index: usize,
    /// Everything said in the status line, for `show-messages` (C-b ~).
    pub messages: Vec<(std::time::SystemTime, String)>,
    /// Paste buffers, newest first (copy mode's `y`, and `paste-buffer`).
    pub buffers: Vec<String>,
    pub keymap: crate::keys::Keymap,
    /// Colours from ~/.tmux.conf (status, messages, borders).
    pub look: crate::tmuxconf::Look,
    /// Until when a `-r` key may be pressed again without the prefix.
    pub repeat_until: Option<Instant>,
    /// Redraw everything next frame (refresh-client).
    pub redraw_all: bool,
    /// tmux `status-position`.
    pub status_top: bool,
    pub mouse: bool,
    /// The harness focused before this one, anywhere (switch-client -l).
    pub last_harness: Option<(String, String)>,
    /// `agent_recent` answers (asks and recaps), for the preview window.
    pub recent: HashMap<(String, String), Value>,
    /// Seconds east of UTC (for the status line's clock).
    pub utc_offset_secs: i64,
    /// `:` command history (Up/Down in the prompt).
    pub history: Vec<String>,
    /// The last copy-mode search (n / N).
    pub last_search: Option<String>,
    pub size: (u16, u16),
    /// Each visible pane's full rect (header row included), from the last layout.
    pub rects: Vec<(u64, Rect)>,
    pub quit: bool,
    pub prefix: bool,
    /// When the prefix was pressed: a pause after it shows the keys (which-key).
    pub prefix_at: Option<Instant>,
    pub tick: u64,
    pub home_cursor: usize,
    pub desk_mode: DeskMode,
    pub desk_revision: i64,
    desk_loaded: bool,
    pub started: Instant,
    pub daemon_down: bool,
    pub dsh: HashMap<String, Vec<Value>>,
    /// Each harness's selectable models (`models_list`), for ⌥I.
    pub models: HashMap<(String, String), Vec<Value>>,
    /// Each machine's local models (the grid): downloaded, running, available.
    pub local_models: HashMap<String, Vec<Value>>,
    /// Each machine's last measured round trip (the live roster request), for `@`.
    pub rtt: HashMap<String, Duration>,
    pub homes: HashMap<String, String>,
    last_focus_sent: Option<(String, String)>,
    pub mouse_drag: Option<(u64, u16, u16)>,
    /// A text selection being dragged out in this pane.
    pub selecting: Option<u64>,
    /// The last click (pane, col, row, when, count) — for double and triple clicks.
    pub last_click: Option<(u64, u16, u16, Instant, u8)>,
    /// What the outer terminal's title was last set to.
    pub title: String,
    pub first_frame: bool,
    /// Where each tab was drawn in the strip, for clicks.
    pub tab_hits: Vec<(usize, u16, u16)>,
    /// Terminal frames for a stream no pane has yet — the keyframe can outrun `terminal_ready`.
    orphans: HashMap<Uuid, (Instant, Vec<proto::Frame>)>,
    /// Desk writes sent and not yet answered; while any are out, the desk is not reconciled.
    desk_inflight: u32,
    /// The desk moved while writes were out: fetch it once they land.
    desk_stale: bool,
    /// The tab before this one, by id — ⌥` goes back to it.
    pub last_tab: Option<String>,
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
    /// select-pane -m: the marked pane (join-pane and swap-pane take it as their source).
    pub marked: Option<u64>,
    /// copy-pipe's command, for the copy about to happen.
    pub copy_pipe: Option<String>,
    /// new-window -d: the window to go back to (and the last window then) once its shell is up.
    pub return_to: Option<(String, Option<String>)>,
    pub held_reply: Option<tokio::sync::oneshot::Sender<Reply>>,
    /// The shell waiting on the command it ran (hn <command>): its answer goes here when the
    /// command is done — at once, or when a job it waits on (run-shell, if-shell) has finished.
    pub cli_tx: Option<tokio::sync::oneshot::Sender<Reply>>,
    /// That command's exit status (run-shell's, when its shell command failed).
    pub cli_code: i32,
    /// That shell's folder: where run-shell and if-shell run what it asked (tmux's client cwd).
    pub cli_cwd: Option<String>,
    /// set-buffer -b name: named paste buffers.
    pub named_buffers: std::collections::BTreeMap<String, String>,
    pub capture_err: Option<Vec<String>>,
    /// setenv's variables (this client's).
    pub env: std::collections::BTreeMap<String, String>,
    /// tim, the creature in the status line.
    pub tim: crate::tim::Tim,
    /// Shells hn made for split-window / new-window: they end with their pane.
    pub shells: HashSet<(String, String)>,
    /// Keys typed while a split's shell starts, for it.
    pub starting_shell: Option<Vec<Vec<u8>>>,
    /// Copy mode's pending count (5k), f/F/t/T waiting for a character, and the last one for ; and ,.
    pub copy_count: usize,
    pub copy_pending: Option<char>,
    pub copy_last_find: Option<(char, char)>,
    /// tmux's status/window/border/copy options from tmux.conf or `set`.
    pub opts: crate::tmuxconf::Options,
    /// Which way the last copy-mode search went (? up, / down).
    pub last_search_up: bool,
    /// The home list's order while it is on screen (see `home_agents`).
    pub home_order: std::cell::RefCell<Vec<(String, String)>>,
    pub mouse_changed: bool,
    /// Whether the terminal window has focus (focus reporting) — notifications go out when it does not.
    pub terminal_focused: bool,
    /// The Harness device on this desk, and hn's half of talking to it (dial.rs).
    pub dial: crate::dial::Dial,
    /// A key table of your own the next key is looked up in (`switch-client -T`).
    pub key_table: Option<String>,
    /// tmux's options, as set (options.rs): what show-options prints and formats read.
    pub options: crate::options::Store,
    /// `#()` commands in formats: their last output, run again every status-interval.
    pub jobs: std::cell::RefCell<std::collections::HashMap<String, crate::format::Job>>,
    pub fleet_marked: bool,
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
            sink,
            fleet: Fleet::default(),
            links: HashMap::new(),
            generation: 0,
            tabs: vec![Tab::new("home")],
            active: 0,
            panes: HashMap::new(),
            next_pane: 1,
            modal: None,
            toast: None,
            display_ms: 750,
            display_panes_ms: 1000,
            base_index: 0,
            nums: HashMap::new(),
            cursor_shape: String::new(),
            suspend: false,
            capture: None,
            print_new: None,
            session_alias: None,
            marked: None,
            copy_pipe: None,
            return_to: None,
            held_reply: None,
            cli_tx: None,
            cli_code: 0,
            cli_cwd: None,
            named_buffers: Default::default(),
            capture_err: None,
            env: Default::default(),
            tim: crate::tim::Tim::load(),
            shells: HashSet::new(),
            starting_shell: None,
            copy_count: 0,
            copy_pending: None,
            copy_last_find: None,
            opts: Default::default(),
            prefix_at: None,
            last_search_up: true,
            home_order: Default::default(),
            mouse_changed: false,
            pane_base_index: 0,
            messages: Vec::new(),
            buffers: Vec::new(),
            keymap: crate::keys::Keymap::tmux_defaults(),
            look: Default::default(),
            repeat_until: None,
            redraw_all: false,
            status_top: false,
            mouse: true,
            last_harness: None,
            history: Vec::new(),
            recent: HashMap::new(),
            utc_offset_secs: utc_offset(),
            last_search: None,
            size,
            rects: Vec::new(),
            quit: false,
            prefix: false,
            tick: 0,
            home_cursor: 0,
            desk_mode,
            desk_revision: -1,
            desk_loaded: false,
            started: Instant::now(),
            daemon_down: false,
            dsh: HashMap::new(),
            models: HashMap::new(),
            local_models: HashMap::new(),
            rtt: HashMap::new(),
            homes: HashMap::new(),
            last_focus_sent: None,
            mouse_drag: None,
            selecting: None,
            last_click: None,
            title: String::new(),
            first_frame: false,
            tab_hits: Vec::new(),
            orphans: HashMap::new(),
            desk_inflight: 0,
            desk_stale: false,
            last_tab: None,
            terminal_focused: true,
            dial: Default::default(),
            options: Default::default(),
            jobs: Default::default(),
            key_table: None,
            fleet_marked: false,
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
        // Run from a shell: a message is the command's error, printed there.
        if let Some(err) = self.capture_err.as_mut() { err.push(text); return }
        self.messages.push((std::time::SystemTime::now(), text.clone()));
        if self.messages.len() > 200 { self.messages.remove(0); }
        self.toast = Some((text, color, Instant::now()));
    }

    pub fn link(&self, machine_id: &str) -> Option<Link> {
        self.links.get(machine_id).and_then(|s| s.link.clone()).filter(|_| self.fleet.machine(machine_id).map(Machine::usable).unwrap_or(false))
    }

    // ── start: this machine, the account's machines, the desk ─────────────────

    pub fn boot(&mut self) {
        if self.fleet.agents.is_empty() && self.fleet.machines.is_empty() { self.fleet.load_cache() }
        let port = self.port;
        self.spawn(async move { http_json(port, "GET", "/api/status", None).await }, |app, status| match status {
            Ok(status) => {
                app.daemon_down = false;
                let id = status.get("machineId").and_then(Value::as_str).unwrap_or("").to_string();
                if status.get("signedIn").and_then(Value::as_bool) == Some(false) {
                    app.say("This computer is not signed in — run `harness login`", theme::DANGER);
                }
                if id.is_empty() { return }
                app.fleet.local_id = id.clone();
                if app.fleet.machine(&id).is_none() {
                    app.fleet.machines.insert(0, Machine { id: id.clone(), name: hostname(), local: true, status: "running".into(), reach: Reach::Unknown });
                }
                app.connect(&id);
                app.refresh_machines();
            }
            Err(_) => {
                app.daemon_down = true;
                app.retry_boot();
            }
        });
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
                let name = ["name", "hostname"].iter().filter_map(|k| row.get(*k).and_then(Value::as_str)).map(str::trim).find(|s| !s.is_empty()).unwrap_or(&id[..8.min(id.len())]).to_string();
                let status = row.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string();
                match app.fleet.machine_mut(&id) {
                    Some(machine) => { machine.name = name; machine.status = status }
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
        state.link = None;
        state.attempts += 1;
        let wait = Duration::from_millis((500 * 2u64.pow(state.attempts.min(5))).min(15_000));
        state.retry_at = Some(Instant::now() + wait);
    }

    // ── machine events ───────────────────────────────────────────────────────

    pub fn on_machine(&mut self, machine_id: String, generation: u64, event: MachineEvent) {
        let current = self.links.get(&machine_id).map(|s| s.generation) == Some(generation);
        if !current { return }
        match event {
            MachineEvent::Connected => {
                if let Some(state) = self.links.get_mut(&machine_id) { state.attempts = 0 }
                if let Some(machine) = self.fleet.machine_mut(&machine_id) { machine.reach = Reach::Ready }
                if machine_id == self.fleet.local_id { self.daemon_down = false; crate::dial::reconnected(self) }
                self.relist(&machine_id);
                // Its home folder, so its paths read `~/…` like this machine's do.
                if !self.homes.contains_key(&machine_id) {
                    if let Some(link) = self.link(&machine_id) {
                        let id = machine_id.clone();
                        self.spawn(async move { link.rpc("fs_list_dir", json!({}), Duration::from_secs(20)).await }, move |app, reply| {
                            if let Some(path) = reply.ok().and_then(|r| r.get("path").and_then(Value::as_str).map(str::to_string)) { app.homes.insert(id, path); }
                        });
                    }
                }
                if machine_id == self.fleet.local_id && !self.desk_loaded { self.load_desk() }
                // Every pane of this machine that lost its stream gets it back.
                let ids: Vec<u64> = self.panes.values().filter(|p| p.machine_id == machine_id && p.stream.is_none() && !matches!(p.phase, Phase::Card { .. })).map(|p| p.id).collect();
                for id in ids { self.open_stream(id, false) }
            }
            MachineEvent::Failed(error) | MachineEvent::Closed(error) => {
                let needs_link = error.code == "NO_PEER_LINK";
                if let Some(machine) = self.fleet.machine_mut(&machine_id) {
                    machine.reach = if needs_link { Reach::NeedsLink } else if machine.online() { Reach::Error(error.to_string()) } else { Reach::Offline };
                }
                if machine_id == self.fleet.local_id && error.code == "DAEMON_UNREACHABLE" { self.daemon_down = true }
                for pane in self.panes.values_mut().filter(|p| p.machine_id == machine_id) {
                    pane.stream = None;
                    pane.opening = false;
                    pane.open_token += 1;
                    if !matches!(pane.phase, Phase::Card { .. }) {
                        pane.phase = if needs_link {
                            Phase::Card { title: "This machine is not linked here".into(), detail: format!("Link it once with its remote password (machines, then C-l), or run:\nharness link connect {machine_id}"), keys: vec![("enter".into(), "retry".into()), (self.keymap.hint("choose-tree -m").unwrap_or_default(), "machines".into())] }
                        } else {
                            Phase::Connecting(format!("Reconnecting to {}…", self.fleet.machines.iter().find(|m| m.id == machine_id).map(|m| m.name.clone()).unwrap_or_default()))
                        };
                    }
                    pane.dirty = true;
                }
                if needs_link { if let Some(state) = self.links.get_mut(&machine_id) { state.link = None } }
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
            }
        });
        self.spawn(async move { link.rpc("agents_list", json!({ "includeStopped": true }), Duration::from_secs(20)).await }, move |app, reply| {
            if let Ok(reply) = reply {
                let rows = reply.get("agents").and_then(Value::as_array).cloned().unwrap_or_default();
                app.fleet.replace_roster(&id, &rows);
                app.sync_titles();
            }
        });
    }

    fn on_frame(&mut self, machine_id: &str, ty: &str, payload: Value) {
        // The dial's frames come from this computer's daemon, to the windows on it.
        if machine_id == self.fleet.local_id && crate::dial::on_frame(self, ty, &payload) { return }
        match ty {
            "agent_synced" | "agent_created" | "agent_renamed" => {
                let row = payload.get("agent").cloned().unwrap_or(payload.clone());
                let Some(id) = row.get("id").and_then(Value::as_str).map(str::to_string) else { return };
                let key = (machine_id.to_string(), id);
                if ty == "agent_renamed" && row.get("engine").is_none() {
                    if let (Some(agent), Some(name)) = (self.fleet.agents.get_mut(&key), row.get("name").and_then(Value::as_str)) { agent.name = name.to_string() }
                } else {
                    let agent = fleet::agent_from(machine_id, &row, self.fleet.agents.get(&key));
                    self.fleet.agents.insert(key, agent);
                }
                self.sync_titles();
            }
            "agent_deleted" => {
                let id = payload.get("agentId").or_else(|| payload.get("id")).and_then(Value::as_str).unwrap_or("");
                if let Some(agent) = self.fleet.agents.get_mut(&(machine_id.to_string(), id.to_string())) {
                    agent.status = "stopped".into();
                    agent.working = false;
                    agent.question = None;
                }
                self.relist(machine_id);
            }
            "turn_started" | "turn_heartbeat" | "tool_start" | "tool_end" => {
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) {
                    agent.working = true;
                    agent.last_beat = Some(Instant::now());
                    agent.active_at = fleet::now_ms();
                    if ty == "turn_started" { agent.unread = false }
                }
            }
            "turn_ended" => {
                let visible = self.visible_agents();
                let opened: Vec<(String, String)> = self.panes.values().map(|p| (p.machine_id.clone(), p.agent_id.clone())).collect();
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) {
                    agent.working = false;
                    agent.active_at = fleet::now_ms();
                    // Only harnesses you have on a tab: a hundred others finish turns all day.
                    let name = agent.name.clone();
                    let mine = opened.contains(&agent.key());
                    // tim hatches on the first turn finished while you watch, and is pleased after each.
                    if mine { self.tim.turn_done() }
                    if mine && !visible.contains(&agent.key()) {
                        agent.unread = true;
                        self.say(format!("{name} finished"), theme::ONLINE);
                    }
                    if mine && !self.terminal_focused { crate::notify("Harness", &format!("{name} finished")) }
                }
            }
            "commander_question" => {
                let visible = self.visible_agents();
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) {
                    let next = fleet::question_from(&payload, agent.question.as_ref());
                    let fresh = next.as_ref().map(|q| agent.question.as_ref().map(|p| p.request_id != q.request_id).unwrap_or(true)).unwrap_or(false);
                    if next.is_some() { agent.question = next }
                    let name = agent.name.clone();
                    let prompt = agent.question.as_ref().map(|q| q.prompt.clone()).unwrap_or_default();
                    if fresh && !visible.contains(&agent.key()) {
                        { let k = self.keymap.hint("choose-tree -a").unwrap_or_default(); self.say(format!("{name} is waiting on you — {k}"), theme::ATTENTION); }
                        crate::bell();
                    }
                    if fresh && !self.terminal_focused { crate::notify(&format!("{name} needs input"), &prompt) }
                }
            }
            "commander_question_close" => {
                if let Some(agent) = self.fleet.event_agent(machine_id, &payload) { agent.question = None }
            }
            "machines_changed" => self.refresh_machines(),
            "desk_changed" => {
                let revision = payload.get("revision").and_then(Value::as_i64).unwrap_or(i64::MAX);
                if revision > self.desk_revision && self.desk_mode != DeskMode::Off { self.fetch_desk() }
            }
            "terminal_closed" => {
                let stream = payload.get("streamId").and_then(Value::as_str).and_then(|s| Uuid::parse_str(s).ok());
                let Some(pane) = self.panes.values_mut().find(|p| p.stream.is_some() && p.stream == stream) else { return };
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
                    self.after_end(id, payload.get("reason").and_then(Value::as_str).unwrap_or("the terminal closed").to_string());
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
            pane.feed(&bytes);
            pane.settle_predictions();
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

    /// Open (or re-open) a pane's terminal. [takeover]: take the keyboard from any other window.
    pub fn open_stream(&mut self, pane_id: u64, takeover: bool) {
        let content = self.content_size(pane_id);
        let Some(pane) = self.panes.get_mut(&pane_id) else { return };
        if pane.opening { return }
        let Some(link) = self.links.get(&pane.machine_id).and_then(|s| s.link.clone()) else {
            pane.phase = Phase::Connecting("Connecting…".into());
            return;
        };
        let (cols, rows) = content.unwrap_or((pane.cols, pane.rows));
        // Below the daemon's 40×12 the far terminal stays 40×12 and the tile shows the part of it
        // around the cursor, as tmux shows a window bigger than its client.
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
        let host = hostname();
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
            // The pane went away (or opened again) while this was in flight: give the terminal back,
            // or this window would hold its keyboard lease with nothing on screen.
            if let (Some(stream), Some(link)) = (stream, self.links.get(machine_id).and_then(|s| s.link.clone())) {
                link.send("terminal_close", json!({ "streamId": stream.to_string() }));
            }
            return;
        }
        let Some(pane) = self.panes.get_mut(&pane_id) else { return };
        pane.opening = false;
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
                let queued = std::mem::take(&mut pane.queued);
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
            }
            Ok((_, payload)) => {
                let code = payload.get("code").and_then(Value::as_str).unwrap_or("TERMINAL_OPEN_FAILED").to_string();
                if code == "TERMINAL_AGENT_NOT_FOUND" || code == "TERMINAL_RUNTIME_UNAVAILABLE" {
                    self.after_end(pane_id, code);
                } else {
                    pane.phase = Phase::Card { title: "Could not open the terminal".into(), detail: code, keys: vec![("enter".into(), "retry".into()), (self.keymap.hint("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane").unwrap_or_else(|| "C-b x".into()), "close pane".into())] };
                }
            }
            Err(error) => {
                pane.phase = Phase::Card { title: "Could not open the terminal".into(), detail: error.to_string(), keys: vec![("enter".into(), "retry".into()), (self.keymap.hint("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane").unwrap_or_else(|| "C-b x".into()), "close pane".into())] };
            }
        }
        if let Some(pane) = self.panes.get_mut(&pane_id) { pane.dirty = true }
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
            Some("stopped") => Phase::Card { title: "Paused".into(), detail: "The conversation is saved.".into(), keys: vec![("enter".into(), "resume".into()), (self.keymap.hint("choose-tree -s").unwrap_or_default(), "open another".into()), (self.keymap.hint("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane").unwrap_or_else(|| "C-b x".into()), "close pane".into())] },
            None => Phase::Card { title: "This harness is gone".into(), detail: "It is no longer on its machine.".into(), keys: vec![(self.keymap.hint("choose-tree -s").unwrap_or_default(), "open another".into()), (self.keymap.hint("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane").unwrap_or_else(|| "C-b x".into()), "close pane".into())] },
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
        if pane.read_only || pane.input_off { return }
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
        if pane.input_off { return }
        let Some(link) = self.links.get(&pane.machine_id).and_then(|s| s.link.clone()) else { return };
        link.send_binary(proto::encode(Kind::Paste, stream, 0, text.as_bytes()));
    }

    /// Resize every visible pane's far terminal to its tile. Called after any layout change.
    pub fn fit_panes(&mut self) {
        // Every window's cells follow the client's size (tmux resizes its windows to it), with the
        // title rows counted when the window shows them.
        let body = self.body();
        for i in 0..self.tabs.len() {
            let status = self.pane_status(&self.tabs[i]);
            if let Some(root) = self.tabs[i].root.as_mut() {
                root.status = status;
                if root.size() != (body.width, body.height) { root.resize(body.width, body.height) }
            }
        }
        self.rects = self.compute_rects();
        let visible: Vec<(u64, Rect)> = self.rects.clone();
        // A tile comes on screen without a stream (a desk tab never visited): open it as a watcher —
        // whoever has the keyboard elsewhere keeps it until someone types here.
        let idle: Vec<u64> = visible.iter().map(|(id, _)| *id).filter(|id| self.panes.get(id).map(|p| p.stream.is_none() && !p.opening && matches!(p.phase, Phase::Connecting(_))).unwrap_or(false)).collect();
        for (id, rect) in visible {
            let content = self.content_of(self.tab(), rect);
            let content = (content.width, content.height);
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
        let out = self.capture.take().unwrap_or_default();
        let err = self.capture_err.take().unwrap_or_default();
        let Some(tx) = self.cli_tx.take() else { return };
        if self.print_new.is_some() && err.is_empty() { self.held_reply = Some(tx); return }
        self.print_new = None;
        let code = if self.cli_code != 0 { self.cli_code } else if err.is_empty() { 0 } else { 1 };
        let _ = tx.send((out, err, code));
    }

    /// What a command prints: to the shell that asked (hn <command>), else a message or a list.
    pub fn print(&mut self, title: &str, lines: Vec<String>) {
        if let Some(out) = self.capture.as_mut() { out.extend(lines); return }
        if lines.len() <= 1 { self.say(lines.into_iter().next().unwrap_or_default(), crate::theme::WARN) }
        else { crate::input::picker(self, crate::modal::PickerKind::Output { title: title.to_string(), lines }, title, "") }
    }

    /// Ask the pane's machine what its tmux pane runs and where (terminal_info) — for this
    /// machine's panes; a daemon that predates it, or a peer, just leaves the fallbacks.
    pub fn refresh_pane_info(&mut self, pane_id: u64) {
        let Some(p) = self.panes.get(&pane_id) else { return };
        if p.machine_id != self.fleet.local_id || p.stream.is_none() { return }
        let (machine, agent) = (p.machine_id.clone(), p.agent_id.clone());
        let Some(link) = self.link(&machine) else { return };
        self.spawn(async move { link.rpc("terminal_info", json!({ "agentId": agent }), Duration::from_secs(3)).await }, move |app, reply| {
            let Ok(info) = reply else { return };
            if info.get("error").is_some() { return }
            let Some(p) = app.panes.get_mut(&pane_id) else { return };
            let text = |k: &str| info.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
            p.fg_command = text("command");
            p.live_path = text("path");
            p.remote_pid = info.get("pid").and_then(Value::as_u64);
            p.remote_tty = text("tty");
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

    /// The popup's inner size for a percentage or cell size (tmux: -w 50% -h 50%).
    pub fn popup_size(&self, w: &str, h: &str) -> (u16, u16) {
        let dim = |v: &str, total: u16| -> u16 {
            let v = v.trim();
            let n = if let Some(p) = v.strip_suffix('%') { p.parse::<u32>().map(|p| (total as u32 * p / 100) as u16).unwrap_or(total / 2) } else { v.parse().unwrap_or(total / 2) };
            n.clamp(10, total.saturating_sub(2))
        };
        (dim(w, self.size.0), dim(h, self.size.1.saturating_sub(1)))
    }

    /// What a tmux.conf (or `set`, `source-file`) said, over what is set now.
    pub fn apply_settings(&mut self, s: &crate::tmuxconf::Settings) {
        if let Some(n) = s.base_index { self.base_index = n }
        if let Some(n) = s.pane_base_index { self.pane_base_index = n }
        if let Some(m) = s.mouse { self.mouse = m; self.mouse_changed = true }
        if let Some(t) = s.status_top { self.status_top = t; self.fit_panes() }
        if let Some(ms) = s.display_ms { self.display_ms = ms.max(300) }
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
        if let Some(off) = s.options.tim_off { self.tim.off = off }
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

    /// tmux's #S: this computer's name, as the status line's `[…]` shows it.
    pub fn session_name(&self) -> String {
        if let Some(a) = &self.session_alias { return a.clone() }
        self.fleet.machine(&self.fleet.local_id).map(|m| m.name.clone()).unwrap_or_else(hostname)
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
        tab.layout_at = layout::Named::ALL.iter().position(|n| *n == named).unwrap_or(0);
        self.fit_panes();
    }

    /// new-window -a: the new (current) window takes the index after `after`'s, the windows
    /// numbered from there moving up one, and its place in the order.
    pub fn place_after(&mut self, after: &str) {
        self.renumber();
        let Some(base) = self.tabs.iter().find(|t| t.id == after).and_then(|t| self.nums.get(&t.id).copied()) else { return };
        let me = self.tab().id.clone();
        let want = base + 1;
        let ids: Vec<String> = self.tabs.iter().filter(|t| t.id != me).map(|t| t.id.clone()).collect();
        for id in ids { if let Some(n) = self.nums.get_mut(&id) { if *n >= want { *n += 1 } } }
        self.nums.insert(me.clone(), want);
        let Some(from) = self.tabs.iter().position(|t| t.id == me) else { return };
        let tab = self.tabs.remove(from);
        let at = self.tabs.iter().position(|t| self.nums.get(&t.id).map(|n| *n > want).unwrap_or(false)).unwrap_or(self.tabs.len());
        self.tabs.insert(at, tab);
        self.active = at;
        self.fit_panes();
    }

    /// move-window -r: every window numbered in order from base-index.
    pub fn renumber_all(&mut self) {
        for (i, t) in self.tabs.iter().enumerate() { self.nums.insert(t.id.clone(), i + self.base_index); }
        self.fit_panes();
    }

    /// Give every window without an index the first free one; forget closed windows'.
    pub fn renumber(&mut self) {
        let ids: HashSet<String> = self.tabs.iter().map(|t| t.id.clone()).collect();
        self.nums.retain(|id, _| ids.contains(id));
        // renumber-windows on: no gaps, in order.
        if self.opts.renumber_windows == Some(true) {
            for (i, t) in self.tabs.iter().enumerate() { self.nums.insert(t.id.clone(), i + self.base_index); }
            return;
        }
        for i in 0..self.tabs.len() {
            if self.nums.contains_key(&self.tabs[i].id) { continue }
            let n = self.free_num();
            self.nums.insert(self.tabs[i].id.clone(), n);
        }
    }

    fn free_num(&self) -> usize {
        let used: HashSet<usize> = self.nums.values().copied().collect();
        (self.base_index..).find(|n| !used.contains(n)).unwrap_or(self.base_index)
    }

    /// The window index tmux would show for the tab at `index`.
    pub fn win_num(&self, index: usize) -> usize {
        self.tabs.get(index).and_then(|t| self.nums.get(&t.id).copied()).unwrap_or(index + self.base_index)
    }

    pub fn tab_by_num(&self, n: usize) -> Option<usize> { (0..self.tabs.len()).find(|i| self.win_num(*i) == n) }

    /// move-window -t N: the window takes index N (if free) and its place in the order.
    pub fn move_tab_to(&mut self, n: usize) -> Result<(), String> {
        self.renumber();
        if self.tab_by_num(n).map(|i| i != self.active).unwrap_or(false) { return Err(format!("index in use: {n}")) }
        let id = self.tab().id.clone();
        self.nums.insert(id, n);
        let to = (0..self.tabs.len()).filter(|i| *i != self.active && self.win_num(*i) < n).count();
        while self.active > to { self.move_tab(-1) }
        while self.active < to { self.move_tab(1) }
        Ok(())
    }
    pub fn tab_mut(&mut self) -> &mut Tab { &mut self.tabs[self.active] }
    pub fn focused(&self) -> Option<u64> { self.tab().focus }

    /// Everything but the status line (tmux `status-position`, bottom by default).
    pub fn body(&self) -> Rect {
        if self.opts.status == Some(false) { return Rect::new(0, 0, self.size.0, self.size.1) }
        Rect::new(0, if self.status_top { 1 } else { 0 }, self.size.0, self.size.1.saturating_sub(1))
    }

    /// A pane's own border line: tmux draws none for a lone pane, and with `pane-border-status top`
    /// a titled line above each pane when a window holds several.

    /// A window's pane-border-status as it shows: hn's default (top) where it has several panes;
    /// once you set it yourself, as tmux has it — on a lone pane too, and bottom or off.
    pub fn pane_status(&self, tab: &Tab) -> layout::Status {
        if self.opts.border_titles == Some(false) { return layout::Status::Off }
        let yours = self.options.global_window.contains_key("pane-border-status") || self.options.windows.get(&tab.id).map(|m| m.contains_key("pane-border-status")).unwrap_or(false);
        if tab.panes().len() < 2 && !yours { return layout::Status::Off }
        layout::Status::of(&self.options.get("pane-border-status", &tab.id, None).unwrap_or_default())
    }

    /// A pane's own cells within its tile: the status line taken off, above or below.
    pub fn content_of(&self, tab: &Tab, r: Rect) -> Rect {
        match self.pane_status(tab) {
            layout::Status::Top => Rect::new(r.x, r.y + 1, r.width, r.height.saturating_sub(1)),
            layout::Status::Bottom => Rect::new(r.x, r.y, r.width, r.height.saturating_sub(1)),
            layout::Status::Off => r,
        }
    }

    fn compute_rects(&self) -> Vec<(u64, Rect)> {
        let tab = self.tab();
        let mut out = Vec::new();
        let body = self.body();
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
                root.rects(self.body(), &mut out);
                if let Some((_, r)) = out.iter().find(|(id, _)| *id == pane_id) { let c = self.content_of(tab, *r); return Some((c.width, c.height)) }
            }
        }
        None
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
        if tab != self.active { self.last_tab = Some(self.tabs[self.active].id.clone()); self.home_order.borrow_mut().clear() }
        self.active = tab;
        if self.tabs[tab].zoomed && self.tabs[tab].focus != Some(pane) { self.tabs[tab].zoomed = false }
        self.tabs[tab].set_active(pane);
        self.seen(pane);
        self.sync_titles();
        self.fit_panes();
        self.refresh_pane_info(pane);
    }

    fn seen(&mut self, pane: u64) {
        let Some(p) = self.panes.get(&pane) else { return };
        let key = (p.machine_id.clone(), p.agent_id.clone());
        if let Some(agent) = self.fleet.agents.get_mut(&key) {
            // Looked at here: the dial takes its notification away too.
            if std::mem::take(&mut agent.unread) { crate::dial::seen(self, &key.1) }
        }
    }

    pub fn visible_agents(&self) -> Vec<(String, String)> {
        self.rects.iter().filter_map(|(id, _)| self.panes.get(id)).map(|p| (p.machine_id.clone(), p.agent_id.clone())).collect()
    }

    pub fn new_pane(&mut self, machine_id: &str, agent_id: &str) -> u64 {
        let id = self.next_pane;
        self.next_pane += 1;
        let (cols, rows) = pane::stream_size(self.size.0, self.size.1.saturating_sub(2));
        self.panes.insert(id, Pane::new(id, machine_id, agent_id, cols, rows));
        id
    }

    /// Put a harness on screen. Already showing somewhere: go there instead.
    pub fn open_agent(&mut self, machine_id: &str, agent_id: &str, placement: Placement) {
        if placement != Placement::Replace {
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
            let Some(t) = self.tabs.iter().position(|x| x.id == at.tab) else { self.drop_pane(id); return };
            if !self.split_at(t, id, at) { self.drop_pane(id); self.say("no space for new pane", theme::WARN); return }
            let tab = &mut self.tabs[t];
            tab.add_pane(id, at.pane, at.before, at.full);
            // tmux takes a zoomed window out of zoom (-Z: zooms its active pane after); the new
            // pane is its active one unless -d.
            if !at.detached || tab.focus.is_none() { tab.set_active(id) }
            tab.zoomed = at.zoom && tab.panes().len() > 1;
            let tab_id = tab.id.clone();
            self.open_stream(id, true);
            self.fit_panes();
            self.desk_pane_added(&tab_id, machine_id, agent_id);
            return;
        }
        let empty = self.tab().root.is_none();
        match (placement, empty) {
            (Placement::Tab, false) => {
                let name = self.fleet.agent(machine_id, agent_id).map(|a| a.name.clone()).unwrap_or_else(|| "tab".into());
                let mut tab = Tab::new(&name);
                tab.root = Some(Node::new(id, self.size.0, self.size.1.saturating_sub(1)));
                tab.focus = Some(id);
                // As new-window: the first free index, in its place in the order.
                self.renumber();
                self.last_tab = Some(self.tabs[self.active].id.clone());
                let n = self.free_num();
                self.nums.insert(tab.id.clone(), n);
                let at = self.tabs.iter().position(|t| self.nums.get(&t.id).map(|m| *m > n).unwrap_or(false)).unwrap_or(self.tabs.len());
                self.tabs.insert(at, tab);
                self.active = at;
            }
            (_, true) => {
                let body = self.body();
                let tab = self.tab_mut();
                tab.root = Some(Node::new(id, body.width, body.height));
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
            (Placement::At(_), _) => {}
            (Placement::Split(dir), false) | (Placement::Auto(Some(dir)), false) => { if !self.split_focused(id, dir) { self.drop_pane(id); self.say("no space for new pane", theme::WARN); return } }
            (Placement::Auto(None), false) => {
                let dir = self.smart_dir();
                if !self.split_focused(id, dir) { self.drop_pane(id); self.say("no space for new pane", theme::WARN); return }
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
    fn split_at(&mut self, t: usize, id: u64, at: &At) -> bool {
        let body = self.body();
        // -l n%: of the target pane's width or height (-f: the window's), measured as tmux
        // measures it — before a zoomed window is unzoomed.
        let cur = if at.full {
            let (w, h) = self.tabs[t].root.as_ref().map(|r| r.size()).unwrap_or((body.width, body.height));
            if at.dir == Dir::Horizontal { w } else { h }
        } else {
            at.pane.and_then(|p| crate::format::content_rect(self, t, p)).map(|r| if at.dir == Dir::Horizontal { r.width } else { r.height }).unwrap_or(0)
        };
        let size = at.size.map(|(n, pct)| if pct { cur as u32 * n as u32 / 100 } else { n as u32 });
        self.fit_panes_of(t);
        let tab = &mut self.tabs[t];
        tab.zoomed = false;
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
        Ok(())
    }

    /// tmux's break-pane: the pane becomes a window of its own (keeping its id), at the first
    /// free index or `num`; -d: not gone to.
    pub fn break_pane(&mut self, src: u64, name: Option<String>, num: Option<usize>, detached: bool) -> Result<(), String> {
        let Some(from) = self.tabs.iter().position(|t| t.panes().contains(&src)) else { return Err("can't find pane".into()) };
        if self.tabs[from].panes().len() < 2 { return Err("can't break with only one pane".into()) }
        self.renumber();
        let n = match num { Some(n) => { if self.tab_by_num(n).is_some() { return Err(format!("index in use: {n}")) } n } None => self.free_num() };
        let back = self.tabs[self.active].id.clone();
        let point = self.tabs[from].points.get(&src).copied();
        self.unhook_pane(src);
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
        if detached {
            if let Some(i) = self.tabs.iter().position(|t| t.id == back) { self.active = i }
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

    /// Wide tiles split left|right, tall ones top/bottom — the way a tiling window manager does.
    pub fn smart_dir(&self) -> Dir {
        let Some(focus) = self.focused() else { return Dir::Horizontal };
        let rect = self.rects.iter().find(|(id, _)| *id == focus).map(|(_, r)| *r).unwrap_or(self.body());
        if rect.width as f32 >= rect.height as f32 * 2.2 { Dir::Horizontal } else { Dir::Vertical }
    }

    fn name_tab_after_first(&mut self) {
        let tab = &self.tabs[self.active];
        if tab.named { return }
        let Some(first) = tab.panes().first().copied() else { return };
        let name = self.panes.get(&first).and_then(|p| self.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| a.name.clone());
        if let Some(name) = name { self.tabs[self.active].name = name }
    }

    pub fn sync_titles(&mut self) {
        for index in 0..self.tabs.len() {
            if self.tabs[index].named { continue }
            // tmux's automatic-rename (unless it is off): an unnamed window is called after its
            // active pane — a shell by what runs in it (automatic-rename-format: `zsh`, `vim`,
            // `[tmux]` in copy mode), a harness by its name.
            let tab_id = self.tabs[index].id.clone();
            if self.options.get("automatic-rename", &tab_id, None).as_deref() == Some("off") { continue }
            let first = self.tabs[index].focus.or_else(|| self.tabs[index].panes().first().copied());
            let Some(id) = first else { continue };
            let Some(pane) = self.panes.get(&id) else { continue };
            let Some(agent) = self.fleet.agent(&pane.machine_id, &pane.agent_id) else { continue };
            let name = if agent.engine == "terminal" && pane.fg_command.is_some() {
                let fmt = self.options.get("automatic-rename-format", &tab_id, Some(id)).unwrap_or_default();
                crate::format::expand(self, &fmt, index, Some(id), false)
            } else { agent.name.clone() };
            if !name.is_empty() { self.tabs[index].name = name }
        }
    }

    fn drop_pane(&mut self, id: u64) {
        if self.marked == Some(id) { self.marked = None }
        if let Some(pane) = self.panes.remove(&id) {
            if let (Some(stream), Some(link)) = (pane.stream, self.links.get(&pane.machine_id).and_then(|s| s.link.clone())) {
                link.send("terminal_close", json!({ "streamId": stream.to_string() }));
            }
        }
    }

    pub fn close_pane(&mut self, id: u64) {
        let Some(index) = self.tabs.iter().position(|t| t.panes().contains(&id)) else { return };
        let agent = self.panes.get(&id).map(|p| (p.machine_id.clone(), p.agent_id.clone()));
        // A shell made by a split or new-window goes when its pane does (tmux kills the pane's
        // shell); an agent keeps running.
        if let Some(key) = agent.clone().filter(|k| self.shells.remove(k)) {
            if let Some(link) = self.link(&key.0) {
                let agent_id = key.1.clone();
                self.spawn(async move { link.rpc("agent_delete", json!({ "agentId": agent_id }), Duration::from_secs(30)).await }, |_, _| {});
            }
        }
        let tab = &mut self.tabs[index];
        tab.lose(id);
        tab.root = tab.root.take().and_then(|root| root.remove(id));
        tab.zoomed = false;
        let tab_id = tab.id.clone();
        self.drop_pane(id);
        if let Some((machine, agent)) = agent { self.desk_op(json!({ "op": "pane.remove", "tabId": tab_id, "machineId": machine, "agentId": agent })) }
        if self.tabs[index].root.is_none() && self.tabs.len() > 1 { self.close_tab(index) }
        else if self.tabs[index].root.is_none() && !self.tabs[index].named { self.tabs[index].name = "home".into() }
        self.sync_titles();
        self.fit_panes();
    }

    pub fn close_tab(&mut self, index: usize) {
        if index >= self.tabs.len() { return }
        let tab = self.tabs.remove(index);
        for id in tab.panes() { self.drop_pane(id) }
        if tab.on_desk { self.desk_op(json!({ "op": "tab.close", "id": tab.id })) }
        if self.tabs.is_empty() { self.tabs.push(Tab::new("home")) }
        // Closing the current window lands on the last one, as tmux does; else keep our place.
        let last = self.last_tab.as_ref().and_then(|id| self.tabs.iter().position(|t| &t.id == id));
        if index == self.active && last.is_some() { self.active = last.unwrap_or(0); self.last_tab = None }
        else if self.active >= self.tabs.len() || (index < self.active) { self.active = self.active.saturating_sub(1).min(self.tabs.len() - 1) }
        self.fit_panes();
    }

    pub fn new_tab(&mut self) {
        // tmux's new-window: the first free index; the others keep their numbers.
        self.renumber();
        self.last_tab = Some(self.tabs[self.active].id.clone());
        let tab = Tab::new("home");
        let n = self.free_num();
        self.nums.insert(tab.id.clone(), n);
        let at = self.tabs.iter().position(|t| self.nums.get(&t.id).map(|m| *m > n).unwrap_or(false)).unwrap_or(self.tabs.len());
        self.tabs.insert(at, tab);
        self.active = at;
        self.home_cursor = 0;
        self.home_order.borrow_mut().clear();
        self.fit_panes();
    }

    pub fn select_tab(&mut self, index: usize) {
        if index < self.tabs.len() {
            if index != self.active { self.last_tab = Some(self.tabs[self.active].id.clone()); self.home_order.borrow_mut().clear() }
            self.active = index;
            if let Some(f) = self.tabs[index].focus { self.seen(f) }
            self.fit_panes();
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
            let c = self.content_of(tab, *r);
            (id, layout::Geom { x: (c.x - body.x) as u32, y: (c.y - body.y) as u32, w: c.width as u32, h: c.height as u32 })
        })).collect()
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

    pub fn select_pane_index(&mut self, index: usize) {
        if let Some(id) = self.tab().panes().get(index).copied() { let tab = self.active; self.focus_pane(tab, id) }
    }

    /// last-pane (select-pane -l): the pane active before this one — with no such pane in a
    /// window of two, the other one, as tmux has it; -Z keeps a zoomed window zoomed.
    pub fn select_last(&mut self, w: usize, keep_zoom: bool) {
        let Some(tab) = self.tabs.get(w) else { return };
        let ids = tab.panes();
        let other = || if ids.len() == 2 { ids.iter().copied().find(|p| Some(*p) != tab.focus) } else { None };
        let Some(last) = tab.last_focus().filter(|l| ids.contains(l)).or_else(other) else { self.say("no last pane", theme::WARN); return };
        let zoomed = tab.zoomed;
        if w == self.active { self.focus_pane(w, last) } else { self.tabs[w].set_active(last) }
        self.tabs[w].zoomed = zoomed && keep_zoom;
        self.fit_panes();
    }

    /// `resize-pane -L/-R/-U/-D n`: n cells, the way tmux counts them.
    /// resize-pane -L/-R/-U/-D: the pane's nearest border in that direction moves `cells`.
    pub fn resize_pane(&mut self, tab: usize, pane: u64, dir: Dir, cells: i32) {
        self.fit_panes_of(tab);
        if let Some(root) = self.tabs.get_mut(tab).and_then(|t| t.root.as_mut()) { root.resize_pane(pane, dir, cells, true); }
        self.fit_panes();
    }

    /// A window's cells at the client's size before they are moved.
    fn fit_panes_of(&mut self, tab: usize) -> bool {
        let body = self.body();
        let status = self.tabs.get(tab).map(|t| self.pane_status(t)).unwrap_or_default();
        match self.tabs.get_mut(tab).and_then(|t| t.root.as_mut()) {
            Some(root) => { root.status = status; if root.size() != (body.width, body.height) { root.resize(body.width, body.height) } true }
            None => false,
        }
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
        if let Some(root) = self.tabs.get_mut(tab).and_then(|t| t.root.as_mut()) { root.resize_pane_to(pane, dir, cells as u32); }
        self.fit_panes();
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
    }

    /// `next-layout` (C-b Space): even-horizontal → even-vertical → main-horizontal → main-vertical → tiled.
    /// next-layout / previous-layout: tmux's seven named layouts in its order.
    pub fn next_layout(&mut self) { self.step_layout(1) }
    pub fn step_layout(&mut self, by: i64) {
        let n = layout::Named::ALL.len() as i64;
        let at = (self.tab().layout_at as i64 + by).rem_euclid(n) as usize;
        let i = self.active;
        self.arrange_tab(i, layout::Named::ALL[at]);
    }

    pub fn apply_preset(&mut self, preset: Preset) { let i = self.active; self.apply_preset_at(i, preset) }

    /// select-layout -t: that window's panes in that shape.
    pub fn apply_preset_at(&mut self, index: usize, preset: Preset) {
        self.arrange_tab(index, layout::Named::of(preset));
        let Some(tab) = self.tabs.get_mut(index) else { return };
        let ids = tab.panes();
        // The same shape on every window: the desk's layout keys presets by pane count.
        if tab.on_desk && !ids.is_empty() {
            if !tab.layout.is_object() { tab.layout = json!({}) }
            if !tab.layout.get("presets").map(Value::is_object).unwrap_or(false) { tab.layout["presets"] = json!({}) }
            tab.layout["presets"][ids.len().to_string()] = json!(preset_to_desk(preset, ids.len()));
            let op = json!({ "op": "tab.layout", "id": tab.id, "layout": tab.layout });
            self.desk_op(op);
        }
        self.fit_panes();
    }

    // ── the desk: tabs shared with every window on the account ─────────────────

    fn load_desk(&mut self) {
        self.desk_loaded = true;
        if self.desk_mode == DeskMode::Off { return }
        self.fetch_desk();
    }

    fn fetch_desk(&mut self) {
        if self.desk_inflight > 0 { self.desk_stale = true; return }
        let port = self.port;
        self.spawn(async move { http_json(port, "GET", "/api/desk", None).await }, |app, desk| {
            if app.desk_inflight > 0 { app.desk_stale = true; return }
            if let Ok(desk) = desk { app.apply_desk(&desk) }
        });
    }

    /// Reconcile tabs to the desk: new tabs appear, closed ones go, panes follow. What a window
    /// keeps for itself (active tab, focus, zoom, sizes) is left alone.
    fn apply_desk(&mut self, desk: &Value) {
        let revision = desk.get("revision").and_then(Value::as_i64).unwrap_or(0);
        if revision <= self.desk_revision { return }
        self.desk_revision = revision;
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
            let preset = preset_from_desk(row.pointer(&format!("/layout/presets/{}", panes.len())).and_then(Value::as_str).unwrap_or(""), panes.len());
            let layout_doc = row.get("layout").cloned().unwrap_or(json!({}));
            match self.tabs.iter().position(|t| t.id == id) {
                Some(index) => {
                    let tab = &mut self.tabs[index];
                    if named || !tab.named { tab.name = name; tab.named = named }
                    tab.on_desk = true;
                    let relayout = tab.layout != layout_doc;
                    tab.layout = layout_doc;
                    if relayout && missing_is_empty(&tab.panes(), &panes, &self.panes) {
                        let ids = tab.panes();
                        let (w, h) = (self.size.0, self.size.1.saturating_sub(2));
                        tab.root = layout::arrange(layout::Named::of(preset), &ids, w, h, layout::Status::Top, ("80", "24"), ("0", "0"));
                        continue;
                    }
                    let have: Vec<(u64, (String, String))> = tab.panes().into_iter().filter_map(|pid| self.panes.get(&pid).map(|p| (pid, (p.machine_id.clone(), p.agent_id.clone())))).collect();
                    let missing: Vec<&(String, String)> = panes.iter().filter(|want| !have.iter().any(|(_, k)| k == *want)).collect();
                    let extra: Vec<u64> = have.iter().filter(|(_, k)| !panes.contains(k)).map(|(pid, _)| *pid).collect();
                    if missing.is_empty() && extra.is_empty() { continue }
                    for pid in &extra {
                        let tab = &mut self.tabs[index];
                        tab.root = tab.root.take().and_then(|r| r.remove(*pid));
                        self.drop_pane(*pid);
                    }
                    let mut new_ids = Vec::new();
                    for (m, a) in missing { new_ids.push(self.new_pane(m, a)) }
                    let tab = &mut self.tabs[index];
                    let mut ids = tab.panes();
                    ids.extend(new_ids.iter().copied());
                    let (w, h) = (self.size.0, self.size.1.saturating_sub(2));
                    tab.root = layout::arrange(layout::Named::of(preset), &ids, w, h, layout::Status::Top, ("80", "24"), ("0", "0"));
                    if tab.focus.map(|f| !ids.contains(&f)).unwrap_or(true) { tab.focus = ids.first().copied() }
                }
                None => {
                    let ids: Vec<u64> = panes.iter().map(|(m, a)| self.new_pane(m, a)).collect();
                    let mut tab = Tab::new(&name);
                    tab.id = id;
                    tab.named = named;
                    tab.on_desk = true;
                    tab.layout = layout_doc;
                    let (w, h) = (self.size.0, self.size.1.saturating_sub(2));
                    tab.root = layout::arrange(layout::Named::of(preset), &ids, w, h, layout::Status::Top, ("80", "24"), ("0", "0"));
                    tab.focus = ids.first().copied();
                    let at = rows.iter().position(|r| r.get("id").and_then(Value::as_str) == Some(tab.id.as_str())).unwrap_or(self.tabs.len()).min(self.tabs.len());
                    self.tabs.insert(at, tab);
                    if at <= self.active && !first_load { self.active += 1 }
                }
            }
        }
        // Tabs the desk no longer has — closed on another computer.
        let gone: Vec<usize> = self.tabs.iter().enumerate().filter(|(_, t)| t.on_desk && !seen.contains(&t.id)).map(|(i, _)| i).collect();
        for index in gone.into_iter().rev() {
            let tab = self.tabs.remove(index);
            for id in tab.panes() { self.drop_pane(id) }
            if index < self.active || self.active >= self.tabs.len() { self.active = self.active.saturating_sub(1) }
        }
        // First load: the desk's tabs replace the empty home tab we started on.
        if first_load && self.tabs.len() > 1 {
            if let Some(home) = self.tabs.iter().position(|t| t.root.is_none() && !t.on_desk) { self.tabs.remove(home); }
            self.active = 0;
        }
        if self.tabs.is_empty() { self.tabs.push(Tab::new("home")) }
        self.active = self.active.min(self.tabs.len() - 1);
        self.sync_titles();
        self.fit_panes();
    }

    fn desk_pane_added(&mut self, tab_id: &str, machine_id: &str, agent_id: &str) {
        let Some(index) = self.tabs.iter().position(|t| t.id == tab_id) else { return };
        let mut ops = Vec::new();
        if !self.tabs[index].on_desk && self.desk_mode == DeskMode::Sync {
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

    /// Send ops as one write. The reply is the whole desk, other windows' changes included; it is
    /// reconciled only when none of this window's writes are still out — reconciling to a desk that
    /// has the tab but not yet its pane would close the tab this window just made.
    pub fn desk_ops(&mut self, ops: Vec<Value>) {
        if self.desk_mode != DeskMode::Sync || ops.is_empty() { return }
        let port = self.port;
        self.desk_inflight += 1;
        self.spawn(async move { http_json(port, "POST", "/api/desk/ops", Some(&json!({ "ops": ops }))).await }, |app, reply| {
            app.desk_inflight = app.desk_inflight.saturating_sub(1);
            if app.desk_inflight > 0 { app.desk_stale = true; return }
            match reply {
                Ok(desk) => app.apply_desk(&desk),
                Err(_) => app.fetch_desk(),
            }
            if std::mem::take(&mut app.desk_stale) { app.fetch_desk() }
        });
    }

    /// The outer terminal's title: the harness in front of you, so a terminal tab says what is in it.
    pub fn window_title(&self) -> String {
        let focused = self.focused().and_then(|id| self.panes.get(&id)).and_then(|p| self.fleet.agent(&p.machine_id, &p.agent_id));
        let waiting = self.fleet.waiting();
        let lead = if waiting > 0 { format!("◆{waiting} ") } else { String::new() };
        match focused {
            Some(agent) => format!("{lead}{} — Harness", agent.name),
            None => format!("{lead}Harness"),
        }
    }

    // ── the loop's slow tick ─────────────────────────────────────────────────

    pub fn on_tick(&mut self) {
        self.tick += 1;
        crate::dial::tick(self);
        // What the panes on screen run (vim? a build?) moves as you work: asked every two seconds.
        // …and every other window's active pane, which names that window (automatic-rename).
        if self.tick % 8 == 4 {
            let mut ids = self.tab().panes();
            ids.extend(self.tabs.iter().filter_map(|t| t.focus).filter(|f| !ids.contains(f)).collect::<Vec<_>>());
            for p in ids { self.refresh_pane_info(p) }
        }
        // display-panes goes away after display-panes-time, as in tmux.
        if matches!(self.modal, Some(crate::modal::Modal::DisplayPanes { until }) if Instant::now() >= until) { self.modal = None }
        self.orphans.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(10));
        for pane in self.panes.values_mut() { pane.settle_predictions() }
        let now = Instant::now();
        for agent in self.fleet.agents.values_mut() {
            if agent.working && agent.last_beat.map(|t| now.duration_since(t) > Duration::from_secs(90)).unwrap_or(true) { agent.working = false }
        }
        let due: Vec<String> = self.links.iter().filter(|(_, s)| s.link.is_none() && s.retry_at.map(|t| t <= now).unwrap_or(false)).map(|(id, _)| id.clone()).collect();
        for id in due {
            if let Some(state) = self.links.get_mut(&id) { state.retry_at = None }
            if id == self.fleet.local_id || self.fleet.machine(&id).map(Machine::online).unwrap_or(false) { self.connect(&id) }
        }
        if self.tick % 120 == 0 { self.refresh_machines() }
        if self.tick % 80 == 40 { self.fleet.save_cache() }
        if self.tick % 240 == 0 { let ids: Vec<String> = self.links.keys().cloned().collect(); for id in ids { self.relist(&id) } }
        if self.toast.as_ref().map(|t| now.duration_since(t.2) > Duration::from_secs(4)).unwrap_or(false) { self.toast = None }
        if let Some(Modal::Picker { picker, .. }) = &mut self.modal {
            if picker.flash.as_ref().map(|f| now.duration_since(f.1) > Duration::from_secs(4)).unwrap_or(false) { picker.flash = None }
        }
    }

}

/// The desktop's preset ids (desktop/lib/state/pane_preset.dart, enum names) → our shapes.
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

fn preset_to_desk(preset: Preset, count: usize) -> &'static str {
    match preset {
        Preset::Columns => match count { 2 => "columns", 3 => "cols3", 4 => "cols4", 5 => "cols5", _ => "columns" },
        Preset::Rows => "rows",
        Preset::MainStack => "mainAndStack",
        Preset::MainRow => "mainOverGrid",
        Preset::Grid => if count == 4 { "quad" } else { "auto" },
    }
}

/// Whether a tab already shows exactly the desk's panes (only the layout changed).
fn missing_is_empty(have: &[u64], want: &[(String, String)], panes: &HashMap<u64, Pane>) -> bool {
    have.len() == want.len() && have.iter().all(|id| panes.get(id).map(|p| want.contains(&(p.machine_id.clone(), p.agent_id.clone()))).unwrap_or(false))
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
    Replace,
    At(At),
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

pub fn hostname() -> String {
    static HOST: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HOST.get_or_init(|| {
        let raw = std::process::Command::new("hostname").arg("-s").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        if raw.is_empty() { "this computer".into() } else { raw }
    }).clone()
}
