//! The whole TUI's state and everything that changes it — except keys, which are `input.rs`, and
//! drawing, which is `ui.rs`. One owner, one loop: machine frames, terminal bytes, keys and the
//! results of background requests all arrive as `Event`s and are applied here in order.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use ratatui::layout::Rect;
use ratatui::style::Color;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::daemon::{http_json, Link, RpcError};
use crate::event::{Event, MachineEvent};
use crate::fleet::{self, Fleet, Machine, Reach};
use crate::layout::{self, Dir, Node, Preset};
use crate::modal::Modal;
use crate::pane::{self, Pane, Phase};
use crate::proto::{self, Kind};
use crate::theme;

pub struct Tab {
    /// The desk's tab id (32 hex), shared with every other window on the account.
    pub id: String,
    pub name: String,
    pub named: bool,
    pub root: Option<Node>,
    pub focus: Option<u64>,
    pub zoomed: bool,
    /// Whether the desk knows this tab yet (a new, empty tab is local until its first harness).
    pub on_desk: bool,
    /// The desk's layout document for this tab, kept whole: a preset chosen here updates its entry
    /// and leaves the sizes other windows saved alone.
    pub layout: Value,
}

impl Tab {
    pub fn new(name: &str) -> Tab {
        Tab { id: Uuid::new_v4().simple().to_string(), name: name.to_string(), named: false, root: None, focus: None, zoomed: false, on_desk: false, layout: json!({}) }
    }
    pub fn panes(&self) -> Vec<u64> { self.root.as_ref().map(Node::leaves).unwrap_or_default() }
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
    pub size: (u16, u16),
    /// Each visible pane's full rect (header row included), from the last layout.
    pub rects: Vec<(u64, Rect)>,
    pub quit: bool,
    pub prefix: bool,
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
    /// Terminal frames for a stream no pane has yet — the keyframe can outrun `terminal_ready`.
    orphans: HashMap<Uuid, (Instant, Vec<proto::Frame>)>,
    /// Desk writes sent and not yet answered; while any are out, the desk is not reconciled.
    desk_inflight: u32,
    /// The desk moved while writes were out: fetch it once they land.
    desk_stale: bool,
    /// The tab before this one, by id — ⌥` goes back to it.
    pub last_tab: Option<String>,
    /// The person's own bindings (tui.toml): chord → command, or None to leave it to the pane.
    pub keys: Vec<(crate::config::Chord, Option<String>)>,
    pub prefix_key: crate::config::Chord,
    /// Whether the terminal window has focus (focus reporting) — notifications go out when it does not.
    pub terminal_focused: bool,
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
            homes: HashMap::new(),
            last_focus_sent: None,
            mouse_drag: None,
            selecting: None,
            last_click: None,
            title: String::new(),
            first_frame: false,
            orphans: HashMap::new(),
            desk_inflight: 0,
            desk_stale: false,
            last_tab: None,
            keys: Vec::new(),
            prefix_key: crate::config::Config::default().prefix,
            terminal_focused: true,
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

    pub fn say(&mut self, text: impl Into<String>, color: Color) {
        self.toast = Some((text.into(), color, Instant::now()));
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
                if machine_id == self.fleet.local_id { self.daemon_down = false }
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
                            Phase::Card { title: "This machine is not linked here".into(), detail: format!("Link it once with its remote password (⌥M, then ^L), or run:\nharness link connect {machine_id}"), keys: vec![("enter".into(), "retry".into()), ("⌥M".into(), "machines".into())] }
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
        self.spawn(async move { fast.rpc("agents_list", json!({}), Duration::from_secs(20)).await }, move |app, reply| {
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
                    if mine && !visible.contains(&agent.key()) {
                        agent.unread = true;
                        self.say(format!("● {name} finished"), theme::ONLINE);
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
                        self.say(format!("◆ {name} needs input — ⌥⇧I"), theme::ATTENTION);
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
        if cols < pane::MIN_COLS || rows < pane::MIN_ROWS {
            pane.phase = Phase::Card { title: "Pane too small".into(), detail: format!("A terminal needs {}×{}; this one is {cols}×{rows}.", pane::MIN_COLS, pane::MIN_ROWS), keys: vec![("⌥Z".into(), "zoom".into())] };
            pane.dirty = true;
            return;
        }
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
                    pane.phase = Phase::Card { title: "Could not open the terminal".into(), detail: code, keys: vec![("enter".into(), "retry".into()), ("⌥W".into(), "close pane".into())] };
                }
            }
            Err(error) => {
                pane.phase = Phase::Card { title: "Could not open the terminal".into(), detail: error.to_string(), keys: vec![("enter".into(), "retry".into()), ("⌥W".into(), "close pane".into())] };
            }
        }
        if let Some(pane) = self.panes.get_mut(&pane_id) { pane.dirty = true }
    }

    /// The stream ended with nobody taking it: say why, from the agent's state.
    fn after_end(&mut self, pane_id: u64, reason: String) {
        let Some(pane) = self.panes.get_mut(&pane_id) else { return };
        let agent = self.fleet.agent(&pane.machine_id, &pane.agent_id);
        pane.stream = None;
        pane.phase = match agent.map(|a| a.status.as_str()) {
            Some("stopped") => Phase::Card { title: "Paused".into(), detail: "The conversation is saved.".into(), keys: vec![("enter".into(), "resume".into()), ("⌥O".into(), "open another".into()), ("⌥W".into(), "close pane".into())] },
            None => Phase::Card { title: "This harness is gone".into(), detail: "It is no longer on its machine.".into(), keys: vec![("⌥O".into(), "open another".into()), ("⌥W".into(), "close pane".into())] },
            _ if agent.map(|a| a.launch == "starting").unwrap_or(false) => Phase::Connecting("Starting…".into()),
            _ => Phase::Card { title: "The terminal closed".into(), detail: reason, keys: vec![("enter".into(), "reopen".into()), ("⌥⇧E".into(), "restart".into()), ("⌥W".into(), "close pane".into())] },
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
        self.spawn(async move { link.rpc("agent_resume", json!({ "agentId": agent_id }), Duration::from_secs(120)).await }, move |app, reply| match reply {
            Ok(_) => { app.relist(&machine_id); app.open_stream(pane_id, true) }
            Err(error) => {
                if let Some(pane) = app.panes.get_mut(&pane_id) {
                    pane.phase = Phase::Card { title: "Could not resume".into(), detail: error.to_string(), keys: vec![("enter".into(), "try again".into()), ("⌥W".into(), "close pane".into())] };
                }
            }
        });
    }

    pub fn send_input(&mut self, pane_id: u64, bytes: &[u8]) {
        let Some(pane) = self.panes.get_mut(&pane_id) else { return };
        let Some(stream) = pane.stream else { return };
        if pane.read_only { return }
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
        let Some(link) = self.links.get(&pane.machine_id).and_then(|s| s.link.clone()) else { return };
        link.send_binary(proto::encode(Kind::Paste, stream, 0, text.as_bytes()));
    }

    /// Resize every visible pane's far terminal to its tile. Called after any layout change.
    pub fn fit_panes(&mut self) {
        self.rects = self.compute_rects();
        let visible: Vec<(u64, Rect)> = self.rects.clone();
        // A tile comes on screen without a stream (a desk tab never visited): open it as a watcher —
        // whoever has the keyboard elsewhere keeps it until someone types here.
        let idle: Vec<u64> = visible.iter().map(|(id, _)| *id).filter(|id| self.panes.get(id).map(|p| p.stream.is_none() && !p.opening && matches!(p.phase, Phase::Connecting(_))).unwrap_or(false)).collect();
        for (id, rect) in visible {
            let content = (rect.width, rect.height.saturating_sub(1));
            let Some(pane) = self.panes.get_mut(&id) else { continue };
            pane.dirty = true;
            let want = pane::stream_size(content.0, content.1);
            let too_small = content.0 < pane::MIN_COLS || content.1 < pane::MIN_ROWS;
            if too_small { continue }
            if matches!(pane.phase, Phase::Card { ref title, .. } if title == "Pane too small") {
                pane.phase = Phase::Connecting("Opening…".into());
                self.open_stream(id, true);
                continue;
            }
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
        let Some(id) = self.focused() else { return };
        let Some(pane) = self.panes.get(&id) else { return };
        let key = (pane.machine_id.clone(), pane.agent_id.clone());
        if self.last_focus_sent.as_ref() == Some(&key) { return }
        if let Some(link) = self.link(&pane.machine_id) {
            if link.send("app_focus", json!({ "agentId": pane.agent_id })) { self.last_focus_sent = Some(key) }
        }
    }

    // ── tabs & panes ─────────────────────────────────────────────────────────

    pub fn tab(&self) -> &Tab { &self.tabs[self.active] }
    pub fn tab_mut(&mut self) -> &mut Tab { &mut self.tabs[self.active] }
    pub fn focused(&self) -> Option<u64> { self.tab().focus }

    pub fn body(&self) -> Rect { Rect::new(0, 1, self.size.0, self.size.1.saturating_sub(1)) }

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
        if let Some((_, r)) = rects.iter().find(|(id, _)| *id == pane_id) { return Some((r.width, r.height.saturating_sub(1))) }
        // A pane in a background tab: size it as if its tab were showing.
        for (index, tab) in self.tabs.iter().enumerate() {
            if index == self.active { continue }
            if let Some(root) = &tab.root {
                let mut out = Vec::new();
                root.rects(self.body(), &mut out);
                if let Some((_, r)) = out.iter().find(|(id, _)| *id == pane_id) { return Some((r.width, r.height.saturating_sub(1))) }
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
        self.active = tab;
        if self.tabs[tab].zoomed && self.tabs[tab].focus != Some(pane) { self.tabs[tab].zoomed = false }
        self.tabs[tab].focus = Some(pane);
        self.seen(pane);
        self.fit_panes();
    }

    fn seen(&mut self, pane: u64) {
        if let Some(p) = self.panes.get(&pane) {
            if let Some(agent) = self.fleet.agents.get_mut(&(p.machine_id.clone(), p.agent_id.clone())) { agent.unread = false }
        }
    }

    pub fn visible_agents(&self) -> Vec<(String, String)> {
        self.rects.iter().filter_map(|(id, _)| self.panes.get(id)).map(|p| (p.machine_id.clone(), p.agent_id.clone())).collect()
    }

    fn new_pane(&mut self, machine_id: &str, agent_id: &str) -> u64 {
        let id = self.next_pane;
        self.next_pane += 1;
        let (cols, rows) = pane::stream_size(self.size.0, self.size.1.saturating_sub(2));
        self.panes.insert(id, Pane::new(id, machine_id, agent_id, cols, rows));
        id
    }

    /// Put a harness on screen. Already showing somewhere: go there instead.
    pub fn open_agent(&mut self, machine_id: &str, agent_id: &str, placement: Placement) {
        if placement != Placement::Replace {
            if let Some((tab, pane)) = self.find_pane(machine_id, agent_id) { self.focus_pane(tab, pane); return }
        }
        let id = self.new_pane(machine_id, agent_id);
        let empty = self.tab().root.is_none();
        match (placement, empty) {
            (Placement::Tab, false) => {
                let name = self.fleet.agent(machine_id, agent_id).map(|a| a.name.clone()).unwrap_or_else(|| "tab".into());
                let mut tab = Tab::new(&name);
                tab.root = Some(Node::Leaf(id));
                tab.focus = Some(id);
                self.tabs.insert(self.active + 1, tab);
                self.active += 1;
            }
            (_, true) => {
                let tab = self.tab_mut();
                tab.root = Some(Node::Leaf(id));
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
                self.tab_mut().focus = Some(id);
                self.drop_pane(old);
            }
            (Placement::Split(dir), false) | (Placement::Auto(Some(dir)), false) => self.split_focused(id, dir),
            (Placement::Auto(None), false) => {
                let dir = self.smart_dir();
                self.split_focused(id, dir);
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

    fn split_focused(&mut self, id: u64, dir: Dir) {
        let focus = self.focused();
        let tab = self.tab_mut();
        match (tab.root.as_mut(), focus) {
            (Some(root), Some(focus)) => { root.split(focus, id, dir); }
            _ => tab.root = Some(Node::Leaf(id)),
        }
        tab.focus = Some(id);
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
            let first = self.tabs[index].panes().first().copied();
            if let Some(name) = first.and_then(|id| self.panes.get(&id)).and_then(|p| self.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| a.name.clone()) {
                self.tabs[index].name = name;
            }
        }
    }

    fn drop_pane(&mut self, id: u64) {
        if let Some(pane) = self.panes.remove(&id) {
            if let (Some(stream), Some(link)) = (pane.stream, self.links.get(&pane.machine_id).and_then(|s| s.link.clone())) {
                link.send("terminal_close", json!({ "streamId": stream.to_string() }));
            }
        }
    }

    pub fn close_pane(&mut self, id: u64) {
        let Some(index) = self.tabs.iter().position(|t| t.panes().contains(&id)) else { return };
        let agent = self.panes.get(&id).map(|p| (p.machine_id.clone(), p.agent_id.clone()));
        let tab = &mut self.tabs[index];
        let leaves = tab.panes();
        let at = leaves.iter().position(|x| *x == id).unwrap_or(0);
        tab.root = tab.root.take().and_then(|root| root.remove(id));
        tab.zoomed = false;
        let rest = tab.panes();
        tab.focus = rest.get(at.min(rest.len().saturating_sub(1))).copied();
        let tab_id = tab.id.clone();
        self.drop_pane(id);
        if let Some((machine, agent)) = agent { self.desk_op(json!({ "op": "pane.remove", "tabId": tab_id, "machineId": machine, "agentId": agent })) }
        if self.tabs[index].root.is_none() && self.tabs.len() > 1 { self.close_tab(index) }
        else if self.tabs[index].root.is_none() && !self.tabs[index].named { self.tabs[index].name = "home".into() }
        self.fit_panes();
    }

    pub fn close_tab(&mut self, index: usize) {
        if index >= self.tabs.len() { return }
        let tab = self.tabs.remove(index);
        for id in tab.panes() { self.drop_pane(id) }
        if tab.on_desk { self.desk_op(json!({ "op": "tab.close", "id": tab.id })) }
        if self.tabs.is_empty() { self.tabs.push(Tab::new("home")) }
        if self.active >= self.tabs.len() || (index < self.active) { self.active = self.active.saturating_sub(1).min(self.tabs.len() - 1) }
        self.fit_panes();
    }

    pub fn new_tab(&mut self) {
        self.tabs.insert(self.active + 1, Tab::new("home"));
        self.active += 1;
        self.home_cursor = 0;
        self.fit_panes();
    }

    pub fn select_tab(&mut self, index: usize) {
        if index < self.tabs.len() {
            if index != self.active { self.last_tab = Some(self.tabs[self.active].id.clone()) }
            self.active = index;
            if let Some(f) = self.tabs[index].focus { self.seen(f) }
            self.fit_panes();
        }
    }

    pub fn rename_tab(&mut self, name: &str) {
        let tab = self.tab_mut();
        tab.name = name.to_string();
        tab.named = true;
        let (id, on_desk) = (tab.id.clone(), tab.on_desk);
        if on_desk { self.desk_op(json!({ "op": "tab.rename", "id": id, "name": name, "nameIsCustom": true })) }
    }

    pub fn apply_preset(&mut self, preset: Preset) {
        let tab = self.tab_mut();
        let ids = tab.panes();
        tab.root = layout::build(&ids, preset);
        tab.zoomed = false;
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
                        tab.root = layout::build(&ids, preset);
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
                    tab.root = layout::build(&ids, preset);
                    if tab.focus.map(|f| !ids.contains(&f)).unwrap_or(true) { tab.focus = ids.first().copied() }
                }
                None => {
                    let ids: Vec<u64> = panes.iter().map(|(m, a)| self.new_pane(m, a)).collect();
                    let mut tab = Tab::new(&name);
                    tab.id = id;
                    tab.named = named;
                    tab.on_desk = true;
                    tab.layout = layout_doc;
                    tab.root = layout::build(&ids, preset);
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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Placement {
    /// Into the focused tile's place when the tab is empty, else a smart split (or the one given).
    Auto(Option<Dir>),
    Split(Dir),
    Tab,
    Replace,
}

pub fn hostname() -> String {
    let raw = std::process::Command::new("hostname").arg("-s").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    if raw.is_empty() { "this computer".into() } else { raw }
}
