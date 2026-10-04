//! Change the software running a harness while keeping its project and pane geometry.
//! One user selection owns one launch receipt; uncertain replies can only be checked.
use std::{collections::{HashMap, HashSet}, time::{Duration, Instant}};
use ratatui::text::{Line, Span};
use serde_json::{Value, json};
use crate::{app::App, daemon::RpcError, fleet::Agent, modal::{Modal, PickerKind}, picker::{Picker, Row}, session_close::Identity, theme};

#[derive(Clone)]
struct Selection { source: Agent, identity: Identity }

#[derive(Clone, Copy, Debug, PartialEq)]
enum Stage { Handoff, Recent, Stop, Create, Check, Terminal, Failed }

#[derive(Clone)]
struct Change {
    id: String,
    source: Agent,
    identity: Identity,
    engine: String,
    stage: Stage,
    handoff: Option<String>,
    context_loaded: bool,
    handoff_failed: bool,
    preserving: bool,
    closed: bool,
    creation_sent: bool,
    creation_finished: bool,
    next: Option<String>,
    next_row: Option<Value>,
    error: String,
    since: Instant,
}

impl Change {
    fn busy(&self) -> bool { !matches!(self.stage, Stage::Failed | Stage::Terminal) }
    fn current(&self, app: &App) -> bool {
        self.identity.connection_matches(app) && match app.fleet.agent(&self.source.machine_id, &self.source.id) {
            Some(a) => a.session_id == self.identity.session && a.created_at_wire == self.identity.created,
            // A daemon can broadcast removal before its addressed close acknowledgement.
            None => self.closed || self.stage == Stage::Stop,
        }
    }
    fn belongs(&self, app: &App) -> bool {
        self.identity.owner_matches(app) && app.fleet.agent(&self.source.machine_id, &self.source.id)
            .map(|a| a.session_id == self.identity.session && a.created_at_wire == self.identity.created)
            .unwrap_or(self.preserving || self.closed)
    }
}

#[derive(Default)]
pub struct State {
    selection: Option<Selection>,
    changes: HashMap<String, Change>,
    placements: HashMap<String, Placement>,
    recovered_placements: HashSet<String>,
    #[cfg(test)]
    pub sent: Vec<(String, String, Value)>,
}

/// The process launch and the shared desk write are separate acknowledgements. Retain the
/// replacement's local views until the latter arrives; retrying these writes never launches
/// or stops another process.
struct Placement {
    receipt: String,
    owner: String,
    machine: String,
    agent: String,
    views: Vec<(String, u64)>,
    ops: Vec<Value>,
    retry: Option<Instant>,
    attempts: u8,
    failed: bool,
}

fn placement_views(app: &App, placement: &Placement) -> Vec<(String, u64)> {
    let identity = app.saved_identity();
    let owner = identity["machine"].as_str().unwrap_or(&app.fleet.local_id);
    if placement.owner != owner { return vec![] }
    if app.fleet.agent(&placement.machine, &placement.agent).is_some_and(|a| a.status == "stopped") { return vec![] }
    placement.views.iter().filter(|(tab, id)| {
        app.panes.get(id).is_some_and(|p| p.machine_id == placement.machine && p.agent_id == placement.agent)
            && app.tabs.iter().chain(app.sessions.iter().flat_map(|s| s.tabs.iter())).any(|t| t.on_desk && &t.id == tab && t.panes().contains(id))
    }).cloned().collect()
}

pub fn retain_placement(app: &mut App, machine: &str, agent: &str, ops: &[Value]) {
    if app.desk_mode != crate::app::DeskMode::Sync || !app.session_desk || ops.is_empty() { return }
    let views = app.tabs.iter().filter(|t| t.on_desk).flat_map(|t| t.panes().into_iter().map(move |p| (t.id.clone(), p)))
        .filter(|(_, id)| app.panes.get(id).is_some_and(|p| p.machine_id == machine && p.agent_id == agent)).collect::<Vec<_>>();
    if views.is_empty() { return }
    app.agent_switch.placements.insert(format!("{machine}:{agent}"), Placement { receipt:uuid::Uuid::new_v4().to_string(), owner:app.fleet.local_id.clone(), machine:machine.into(), agent:agent.into(), views,
        ops:ops.to_vec(), retry:None, attempts:0, failed:false });
    // The process already exists. Include its view in this event batch's session snapshot.
    app.sessions_sig.clear();
}

/// Only the unacknowledged pane placement is durable here, never a process-launch request.
/// Keep it beside the existing session snapshots, under the same file lock and account scope.
pub fn saved_placements(app: &App) -> Vec<Value> {
    let mut rows = Vec::new();
    for p in app.agent_switch.placements.values() {
        let views = placement_views(app, p);
        if views.is_empty() { continue }
        let windows: Vec<_> = std::iter::once((app.session_desk, &app.tabs, &app.nums)).chain(app.sessions.iter().map(|s| (s.desk, &s.tabs, &s.nums)))
            .filter(|(desk, _, _)| *desk).flat_map(|(_, tabs, nums)| tabs.iter().enumerate().filter(|(_, t)| views.iter().any(|(id, _)| id == &t.id)).map(|(index, tab)| {
                let mut win = app.window_json(tab, nums.get(&tab.id).copied());
                win["sharedLayout"] = tab.layout.clone(); win["index"] = json!(index); win
            })).collect();
        rows.push(json!({"id":p.receipt, "harnessIdentity":app.saved_identity(), "machine":p.machine, "agent":p.agent, "ops":p.ops, "windows":windows}));
    }
    rows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    rows
}

pub fn merge_saved_placements(app: &App, doc: &Value, leave: bool) -> Value {
    if app.forget_sessions { return json!([]) }
    let me = crate::ipc::here().map(|p| p.display().to_string());
    let ours = saved_placements(app);
    let mut rows: Vec<_> = doc["pending_workspace"].as_array().into_iter().flatten().filter(|row| {
        row["owner"].as_str() != me.as_deref()
            && !row["id"].as_str().is_some_and(|id| app.agent_switch.recovered_placements.contains(id))
            && !ours.iter().any(|ours| ours["id"] == row["id"])
    }).cloned().collect();
    for mut row in ours {
        row["owner"] = if leave { Value::Null } else { json!(me) };
        rows.push(row);
    }
    json!(rows)
}

/// Called while the session file is locked. Another live client keeps its pending writes;
/// the first client restoring an orphan claims it without issuing any create/stop RPC.
pub fn restore_placements(app: &mut App, doc: &Value) {
    if app.desk_mode != crate::app::DeskMode::Sync { return }
    let identity = app.saved_identity();
    let Some(owner) = identity["machine"].as_str() else { return };
    let me = crate::ipc::here().map(|p| p.display().to_string());
    let back = app.session_id;
    if !app.session_desk {
        let Some(desk) = app.sessions.iter().find(|s| s.desk).map(|s| s.id) else { return };
        app.swap_session(desk);
    }
    for row in doc["pending_workspace"].as_array().into_iter().flatten() {
        if row["harnessIdentity"] != identity || crate::app::live_owner(row).is_some_and(|client| Some(&client) != me.as_ref()) { continue }
        let (Some(receipt), Some(machine), Some(agent), Some(ops), Some(windows)) =
            (row["id"].as_str(), row["machine"].as_str(), row["agent"].as_str(), row["ops"].as_array(), row["windows"].as_array()) else { continue };
        if receipt.is_empty() || machine.is_empty() || agent.is_empty() { continue }
        let mut views = Vec::new();
        for win in windows {
            if win["harnessIdentity"] != identity { continue }
            let Some(win) = app.scoped_window(win) else { continue };
            let win = &win;
            let Some(id) = win["id"].as_str() else { continue };
            if !win["panes"].as_array().is_some_and(|panes| panes.iter().any(|p| p[0] == machine && p[1] == agent)) { continue }
            if !app.tabs.iter().any(|t| t.id == id && t.root.is_some()) {
                let Some((mut tab, num)) = app.tab_from_json(win) else { continue };
                tab.on_desk = true; tab.layout = win["sharedLayout"].clone(); tab.desk_layout = tab.layout.clone();
                crate::ids::desk_set(crate::ids::Kind::Window, &tab.id, tab.wid());
                if let Some(num) = num { app.nums.insert(tab.id.clone(), num); }
                let at = win["index"].as_u64().unwrap_or(app.tabs.len() as u64) as usize;
                app.tabs.insert(at.min(app.tabs.len()), tab);
            }
            if let Some(tab) = app.tabs.iter().find(|t| t.id == id) {
                for pane in tab.panes().into_iter().filter(|id| app.panes.get(id).is_some_and(|p| p.machine_id == machine && p.agent_id == agent)) {
                    crate::ids::desk_set(crate::ids::Kind::Pane, &format!("{machine}:{agent}"), pane);
                    views.push((id.into(), pane));
                }
            }
        }
        app.agent_switch.recovered_placements.insert(receipt.into());
        if views.is_empty() { continue }
        app.agent_switch.placements.insert(format!("{machine}:{agent}"), Placement { receipt:receipt.into(), owner:owner.into(), machine:machine.into(), agent:agent.into(), views,
            ops:ops.clone(), retry:Some(Instant::now() + Duration::from_secs(2)), attempts:0, failed:true });
    }
    if app.tabs.iter().any(|t| t.on_desk) { app.tabs.retain(|t| t.root.is_some() || t.on_desk); }
    app.active = app.desk_active_saved.unwrap_or(app.active).min(app.tabs.len().saturating_sub(1));
    if back != app.session_id { app.swap_session(back); }
}

/// Read the unmodified server document, before retained local views are overlaid onto it.
pub fn desk_observed(app: &mut App, desk: &Value) {
    let rows = desk["tabs"].as_array();
    let done: Vec<_> = app.agent_switch.placements.iter().filter_map(|(key, p)| {
        let views = placement_views(app, p);
        let confirmed = views.iter().all(|(tab, _)| rows.is_some_and(|rows| rows.iter().any(|r| r["id"] == *tab
            && r["panes"].as_array().is_some_and(|panes| panes.iter().any(|a| a["machineId"] == p.machine && a["agentId"] == p.agent)))));
        (views.is_empty() || confirmed).then(|| key.clone())
    }).collect();
    let changed = !done.is_empty();
    for key in done { app.agent_switch.placements.remove(&key); }
    if changed { app.sessions_sig.clear(); }
    crate::workspace_controls::refresh_workspace(app);
}

pub fn desk_write_failed(app: &mut App, ops: &[Value]) {
    let mut failed = false;
    for placement in app.agent_switch.placements.values_mut().filter(|p| p.owner == app.fleet.local_id) {
        if !ops.iter().any(|o| o["op"] == "pane.add" && o["machineId"] == placement.machine && o["agentId"] == placement.agent) { continue }
        placement.failed = true;
        placement.retry = (placement.attempts < 3).then(|| Instant::now() + Duration::from_secs(2 << placement.attempts));
        failed = true;
    }
    if failed { app.say("Agent is running here; workspace sync is pending. Retry is available in the workspace menu.", theme::WARN); }
    crate::workspace_controls::refresh_workspace(app);
}

/// A successful HTTP reply can still omit an operation (for example, a tab was closed on
/// another client). Check only pane additions in this batch: later batches may contain the
/// placement's other views. An accepted request without its pane is not an acknowledgement.
pub fn desk_write_replied(app: &mut App, ops: &[Value], desk: &Value) {
    let missing: Vec<_> = ops.iter().filter(|op| {
        if op["op"] != "pane.add" { return false }
        let tracked = app.agent_switch.placements.values().any(|p| op["machineId"] == p.machine && op["agentId"] == p.agent
            && placement_views(app, p).iter().any(|(tab, _)| op["tabId"] == *tab));
        tracked && !desk["tabs"].as_array().is_some_and(|tabs| tabs.iter().any(|tab| tab["id"] == op["tabId"]
            && tab["panes"].as_array().is_some_and(|panes| panes.iter().any(|pane| pane["machineId"] == op["machineId"] && pane["agentId"] == op["agentId"]))))
    }).cloned().collect();
    if !missing.is_empty() { desk_write_failed(app, &missing); }
}

pub fn sync_pending(app: &App) -> bool {
    app.agent_switch.placements.values().any(|p| p.failed && !placement_views(app, p).is_empty())
}

pub fn retry_sync(app: &mut App) {
    for p in app.agent_switch.placements.values_mut().filter(|p| p.failed) { p.retry = Some(Instant::now()); p.attempts = 0; }
    retry_placements(app);
}

fn retry_placements(app: &mut App) {
    let stale: Vec<_> = app.agent_switch.placements.iter().filter(|(_, p)| placement_views(app, p).is_empty()).map(|(k, _)| k.clone()).collect();
    for key in stale { app.agent_switch.placements.remove(&key); }
    let keys: Vec<_> = app.agent_switch.placements.iter().filter(|(_, p)| p.retry.is_some_and(|t| t <= Instant::now())).map(|(k, _)| k.clone()).collect();
    if keys.is_empty() { return }
    let back = app.session_id;
    if !app.session_desk {
        let Some(desk) = app.sessions.iter().find(|s| s.desk).map(|s| s.id) else { return };
        app.swap_session(desk);
    }
    for key in keys {
        let p = &app.agent_switch.placements[&key];
        if p.owner != app.fleet.local_id || app.link(&p.owner).is_none() { continue }
        let tabs: HashSet<_> = placement_views(app, p).into_iter().map(|(t, _)| t).collect();
        let mut ops = Vec::new();
        for original in &p.ops {
            let mut op = original.clone();
            let id = if matches!(op["op"].as_str(), Some("pane.add" | "pane.remove")) { op["tabId"].as_str() } else { op["id"].as_str() };
            if op["op"] == "tab.close" { ops.push(op); continue }
            let Some((index, tab)) = id.filter(|id| tabs.contains(*id)).and_then(|id| app.tabs.iter().enumerate().find(|(_, t)| t.id == id)) else { continue };
            // User edits since the failed write win: do not replay an old name or geometry.
            if op["op"] == "tab.create" { op["name"] = json!(tab.name); op["nameIsCustom"] = json!(tab.named); op["index"] = json!(index); }
            if op["op"] == "tab.layout" { op["layout"] = tab.layout.clone(); }
            if op["op"] == "pane.add" {
                let at = tab.panes().iter().position(|id| app.panes.get(id).is_some_and(|pane| pane.machine_id == p.machine && pane.agent_id == p.agent));
                let Some(at) = at else { continue }; op["index"] = json!(at);
            }
            ops.push(op);
        }
        let p = app.agent_switch.placements.get_mut(&key).unwrap(); p.retry = None; p.attempts += 1;
        app.desk_ops(ops);
    }
    if back != app.session_id { app.swap_session(back); }
}

fn source_for(app: &App, pane: u64) -> Option<Agent> {
    let p = app.panes.get(&pane)?;
    app.fleet.agent(&p.machine_id, &p.agent_id).cloned().or_else(|| app.agent_switch.changes.values()
        .find(|c| c.source.machine_id == p.machine_id && c.source.id == p.agent_id && c.belongs(app)).map(|c| c.source.clone()))
}

pub fn pane_supports(app: &App, pane: u64) -> bool {
    source_for(app, pane).is_some_and(|a| a.engine != "terminal" && a.dsh_id != "autonomous/pair"
        && app.fleet.machine(&a.machine_id).is_some_and(|m| !m.shared))
}

pub fn pane_label(app: &App, pane: u64) -> String {
    source_for(app, pane).map(|a| theme::engine_label(&a.engine).to_string()).unwrap_or_else(|| "Agent".into())
}

fn engines(app: &App, source: &Agent) -> Vec<String> {
    let all = crate::modal::ENGINES.iter().filter(|e| **e != "terminal").map(|e| e.to_string()).collect::<Vec<_>>();
    let mut supported = if source.dsh_id.is_empty() || source.dsh_id == "autonomous/devices" { all }
    else if source.dsh_id == "autonomous/pair" { Vec::new() }
    else { app.dsh.get(&source.machine_id).into_iter().flatten().find(|r| r["id"] == source.dsh_id)
        .map(|r| r["engines"].as_array().map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>())
            .filter(|list| !list.is_empty()).unwrap_or_else(|| vec![r["engine"].as_str().unwrap_or(&source.engine).into()]))
        .unwrap_or_else(|| vec![source.engine.clone()]) };
    supported.retain(|e| crate::modal::ENGINES.contains(&e.as_str()) && e != "terminal");
    supported.sort_by_key(|e| (e != "opencode", theme::engine_label(e).to_string()));
    supported.dedup();
    supported
}

pub fn open(app: &mut App, pane: u64) {
    if app.read_only() { app.error("This client is read-only"); return }
    let Some(source) = source_for(app, pane) else { app.error("This harness is no longer available"); return };
    if !pane_supports(app, pane) { app.error(if source.dsh_id == "autonomous/pair" { "Open this collection in Companions to change its agent" } else { "This pane cannot change agents" }); return }
    let identity = Identity::capture(app, &source);
    app.agent_switch.selection = Some(Selection { source: source.clone(), identity: identity.clone() });
    crate::input::picker(app, PickerKind::AgentSwitch, "Change agent", "Search agents");
    if let Some(Modal::Picker { picker, .. }) = &mut app.modal { picker.select(&format!("engine:{}", source.engine)); }
    // A package can have gained support for an engine since startup. Read without moving the
    // selection, and keep the conservative cached answer if the catalog is unavailable.
    #[cfg(not(test))]
    if let Some(link) = app.link(&source.machine_id) {
        app.spawn(async move { link.rpc("dsh_list", json!({}), Duration::from_secs(10)).await }, move |app, reply| {
            if !identity.matches(app) { return }
            if let Ok(r) = reply { if let Some(rows) = r["dsh"].as_array() { app.dsh.insert(source.machine_id, rows.clone()); } }
            crate::input::refill(app);
        });
    }
}

pub fn fill(app: &App, picker: &mut Picker) {
    let Some(selection) = &app.agent_switch.selection else { picker.set_rows(vec![]); return };
    let source = &selection.source;
    let pending = app.agent_switch.changes.values().find(|c| c.source.machine_id == source.machine_id && c.source.id == source.id);
    let supported = engines(app, source);
    let mut choices: Vec<_> = crate::modal::ENGINES.iter().copied().filter(|e| *e != "terminal").collect();
    choices.sort_by_key(|e| (*e != "opencode", theme::engine_label(e).to_string()));
    let mut rows = Vec::new();
    for engine in choices {
        let mut row = Row::new(format!("engine:{engine}"), theme::engine_label(engine));
        let word = if let Some(change) = pending.filter(|c| c.engine == engine) {
            if change.busy() && change.current(app) { "Switching…" } else if change.creation_sent && !change.creation_finished { "Check status" } else { "Try again" }
        } else if source.engine == engine { "Current agent" }
        else if !supported.iter().any(|e| e == engine) { "Not supported by this harness" }
        else if crate::agent_handoff::supported(engine) { "Continue with recent context" }
        else { "New conversation in this project" };
        row.right = word.into();
        if source.engine == engine { row.lead = vec![Span::styled("✓ ", theme::fg(theme::ONLINE))]; }
        rows.push(row);
    }
    picker.keep_order = true;
    picker.set_rows(rows);
    picker.status = pending.filter(|c| !c.error.is_empty()).map(|c| c.error.clone()).unwrap_or_else(|| source.name.clone());
    picker.busy = pending.filter(|c| c.busy() && c.current(app)).map(|_| "Switching agent…".into());
    picker.hints = vec![("enter", "change agent"), ("esc", "back")];
}

pub fn preview(app: &App, id: &str) -> Vec<Line<'static>> {
    let Some(selection) = &app.agent_switch.selection else { return vec![] };
    let source = &selection.source;
    let engine = id.strip_prefix("engine:").unwrap_or("");
    let pending = app.agent_switch.changes.values().find(|c| c.source.machine_id == source.machine_id && c.source.id == source.id);
    let mut out = vec![Line::raw(theme::engine_label(engine).to_string()), Line::raw(""), Line::raw(format!("Project  {}", source.cwd))];
    if let Some(c) = pending {
        if !c.error.is_empty() { out.extend([Line::raw(""), Line::raw(c.error.clone())]); }
        if c.creation_sent && !c.creation_finished { out.push(Line::raw("Choose the same agent to check its existing launch.")); }
    } else if engine == source.engine { out.push(Line::raw("This harness already uses this agent.")); }
    else if !engines(app, source).iter().any(|e| e == engine) { out.push(Line::raw("The installed harness does not support this agent.")); }
    else {
        out.push(Line::raw(""));
        out.push(Line::raw(if crate::agent_handoff::supported(engine) { "Save this conversation and continue this project with its recent context." } else { "Save this conversation and start a new one in the same project." }));
        out.push(Line::raw("The pane stays in place. The previous conversation remains saved."));
    }
    out
}

pub fn choose(app: &mut App, mut picker: Picker, selected: &str) {
    let engine = selected.strip_prefix("engine:").unwrap_or("");
    let selection = app.agent_switch.selection.clone();
    let Some(selection) = selection else { return };
    let source = selection.source.clone();
    let same = |c: &&Change| c.source.machine_id == source.machine_id && c.source.id == source.id;
    let pending = app.agent_switch.changes.values().find(same).cloned();
    let message = if app.read_only() { Some("This client is read-only") }
        else if !engines(app, &source).iter().any(|e| e == engine) { Some("This agent is not supported by the installed harness") }
        else if !selection.identity.connection_matches(app) || pending.as_ref().is_some_and(|c| !c.belongs(app))
            || (!selection.identity.matches(app) && !pending.as_ref().is_some_and(|c| c.closed && c.belongs(app))) { Some("This session or connection changed. Reopen Change agent.") }
        else if source.cwd.is_empty() { Some("This harness has no project folder to open with another agent") }
        else if pending.as_ref().is_some_and(|c| c.busy() && c.current(app)) { Some("The agent is already switching") }
        else if pending.as_ref().is_some_and(|c| c.creation_sent && !c.creation_finished && c.engine != engine) { Some("Check the pending switch before choosing another agent") }
        else { None };
    if let Some(message) = message { picker.say(message); app.modal = Some(Modal::Picker { kind: PickerKind::AgentSwitch, picker }); return }
    if pending.is_none() && engine == source.engine { app.modal = None; return }
    if let Some(change) = &pending {
        if change.creation_sent && !change.creation_finished {
            // Only an explicit re-selection after reconnect rebinds the original receipt.
            // An old callback still carries its old connection generation and cannot apply.
            if let Some(c) = app.agent_switch.changes.get_mut(&change.id) { c.identity = selection.identity; c.stage = Stage::Failed; }
            app.modal = Some(Modal::Picker { kind: PickerKind::AgentSwitch, picker });
            check(app, &change.id); return;
        }
    }
    let closed = pending.as_ref().is_some_and(|c| c.closed) || app.fleet.agent(&source.machine_id, &source.id).is_some_and(|a| a.status == "stopped");
    if !closed && (!source.close_supported || source.created_at_wire.is_empty()) {
        picker.say("Update the Harness CLI on this machine to save and change agents");
        app.modal = Some(Modal::Picker { kind: PickerKind::AgentSwitch, picker }); return;
    }
    if let Some(c) = &pending { app.agent_switch.changes.remove(&c.id); }
    let id = uuid::Uuid::new_v4().to_string();
    let retained = pending.as_ref().filter(|c| c.closed && c.context_loaded);
    let context_loaded = retained.is_some();
    let handoff = retained.filter(|_| crate::agent_handoff::supported(engine)).and_then(|c| c.handoff.clone());
    app.agent_switch.changes.insert(id.clone(), Change { id: id.clone(), source, identity: selection.identity, engine: engine.into(), stage: Stage::Handoff,
        handoff, context_loaded, handoff_failed: retained.is_some_and(|c| c.handoff_failed), preserving: closed, closed, creation_sent: false, creation_finished: false, next: None, next_row: None, error: String::new(), since: Instant::now() });
    app.modal = Some(Modal::Picker { kind: PickerKind::AgentSwitch, picker });
    if closed && context_loaded { create(app, &id); } else { prepare(app, &id); }
}

fn fail(app: &mut App, id: &str, message: impl Into<String>) {
    let message = message.into();
    if let Some(c) = app.agent_switch.changes.get_mut(id) { c.stage = Stage::Failed; c.error = message.clone(); }
    app.say(message, theme::WARN);
    crate::input::refill(app);
}

fn valid(app: &mut App, id: &str) -> bool {
    if app.agent_switch.changes.get(id).is_some_and(|c| c.current(app)) { return true }
    fail(app, id, "This session or connection changed. Reopen Change agent."); false
}

type Reply = Result<Value, RpcError>;

fn request(app: &mut App, id: &str, kind: &'static str, payload: Value, timeout: u64, then: fn(&mut App, &str, Reply)) {
    let Some(change) = app.agent_switch.changes.get(id) else { return };
    let machine = change.source.machine_id.clone();
    let stage = change.stage;
    let identity = change.identity.clone();
    #[cfg(test)] {
        let _ = (timeout, then, stage, identity);
        app.agent_switch.sent.push((id.into(), kind.into(), payload));
    }
    #[cfg(not(test))] {
        let Some(link) = app.link(&machine) else { then(app, id, Err(RpcError::new("DISCONNECTED", "That machine is not connected"))); return };
        let id = id.to_string();
        app.spawn(async move { link.rpc(kind, payload, Duration::from_secs(timeout)).await }, move |app, reply| {
            if !identity.connection_matches(app) { return }
            if app.agent_switch.changes.get(&id).is_some_and(|c| c.stage == stage) && valid(app, &id) { then(app, &id, reply); }
        });
    }
    #[cfg(test)] let _ = machine;
    crate::input::refill(app);
}

fn prepare(app: &mut App, id: &str) {
    if !valid(app, id) { return }
    let c = &app.agent_switch.changes[id];
    if !crate::agent_handoff::supported(&c.engine) { stop(app, id); return }
    request(app, id, "agent_handoff_prepare", json!({"agentId":c.source.id, "changeId":id, "targetEngine":c.engine}), 6, prepared);
}

fn prepared(app: &mut App, id: &str, reply: Reply) {
    if !valid(app, id) { return }
    let c = &app.agent_switch.changes[id];
    let accepted = reply.as_ref().ok().and_then(|r| crate::agent_handoff::accept(r, &c.source.id, id, &c.source.cwd, theme::engine_label(&c.source.engine)));
    if let Some(prompt) = accepted {
        let c = app.agent_switch.changes.get_mut(id).unwrap(); c.handoff = prompt; c.context_loaded = true;
        stop(app, id);
    } else {
        let c = app.agent_switch.changes.get_mut(id).unwrap(); c.stage = Stage::Recent;
        let agent = c.source.id.clone();
        request(app, id, "agent_recent", json!({"agentId":agent, "n":5}), 4, recent);
    }
}

fn recent(app: &mut App, id: &str, reply: Reply) {
    if !valid(app, id) { return }
    let c = &app.agent_switch.changes[id];
    let Some(r) = reply.ok().filter(|r| r["error"].is_null() && (r["agentId"].is_null() || r["agentId"] == c.source.id)) else {
        fail(app, id, "Could not read the conversation for the handoff. Try switching again."); return;
    };
    let c = app.agent_switch.changes.get_mut(id).unwrap();
    c.handoff = crate::agent_handoff::excerpt(&c.source.engine, &r);
    c.handoff_failed = c.handoff.is_none(); c.context_loaded = true;
    stop(app, id);
}

fn stop(app: &mut App, id: &str) {
    if !valid(app, id) { return }
    let c = app.agent_switch.changes.get_mut(id).unwrap();
    c.preserving = true;
    if c.closed { create(app, id); return }
    c.stage = Stage::Stop;
    let payload = c.identity.payload("now");
    request(app, id, "agent_close", payload, 35, stopped);
}

fn stopped(app: &mut App, id: &str, reply: Reply) {
    if !valid(app, id) { return }
    let closed = reply.as_ref().ok().is_some_and(|r| r["closed"] == true);
    if !closed {
        let detail = reply.as_ref().err().map(|e| if e.detail.is_empty() { e.code.as_str() } else { &e.detail })
            .or_else(|| reply.as_ref().ok().and_then(|r| r["detail"].as_str())).unwrap_or("The machine did not confirm the stop");
        fail(app, id, format!("Could not save and stop this conversation: {detail}. Its pane is kept.")); return;
    }
    let c = app.agent_switch.changes.get_mut(id).unwrap(); c.closed = true;
    if let Some(a) = app.fleet.agents.get_mut(&c.source.key()) { a.status = "stopped".into(); a.working = false; a.question = None; }
    create(app, id);
}

fn create(app: &mut App, id: &str) {
    if !valid(app, id) { return }
    let c = app.agent_switch.changes.get_mut(id).unwrap();
    if c.creation_sent { check(app, id); return }
    let mode = if crate::new_harness::data::modes(&c.engine).iter().any(|(m, _)| *m == c.source.permission_mode) { c.source.permission_mode.as_str() } else { "ask" };
    let mut payload = json!({"creationId":id, "engine":c.engine, "cwd":c.source.cwd, "name":c.source.name, "permissionMode":mode, "bypassPermission":matches!(mode, "auto" | "full")});
    if !c.source.dsh_id.is_empty() { payload["dsh"] = json!(c.source.dsh_id); }
    if let Some(prompt) = &c.handoff { payload["prompt"] = json!(prompt); }
    c.creation_sent = true; c.stage = Stage::Create; c.error.clear();
    request(app, id, "agent_create", payload, 20, created);
}

fn check(app: &mut App, id: &str) {
    if !valid(app, id) { return }
    let c = app.agent_switch.changes.get_mut(id).unwrap();
    if c.busy() { return }
    c.stage = Stage::Check; c.error.clear();
    request(app, id, "agent_create_status", json!({"creationId":id}), 10, checked);
}

fn created(app: &mut App, id: &str, reply: Reply) { creation_reply(app, id, reply, false); }
fn checked(app: &mut App, id: &str, reply: Reply) { creation_reply(app, id, reply, true); }

fn creation_reply(app: &mut App, id: &str, reply: Reply, checking: bool) {
    if !valid(app, id) { return }
    use crate::new_harness::receipt::{outcome, Outcome};
    match outcome(id, &reply, checking) {
        Outcome::Created => {
            let row = &reply.as_ref().unwrap()["agent"];
            let c = &app.agent_switch.changes[id];
            let next = row["id"].as_str().unwrap();
            if next == c.source.id || row["engine"].as_str().is_some_and(|engine| engine != c.engine) {
                fail(app, id, "The launch reply did not identify the chosen agent. Check its status."); return;
            }
            let machine = c.source.machine_id.clone();
            let next = next.to_string();
            let agent = crate::fleet::agent_from(&machine, row, app.fleet.agent(&machine, &next));
            app.fleet.agents.insert(agent.key(), agent);
            let c = app.agent_switch.changes.get_mut(id).unwrap(); c.next = Some(next); c.next_row = Some(row.clone()); c.stage = Stage::Terminal; c.since = Instant::now();
            attach(app, id);
            app.relist(&machine);
        }
        Outcome::Failed { message, .. } => {
            app.agent_switch.changes.get_mut(id).unwrap().creation_finished = true;
            fail(app, id, format!("{message}. The previous conversation is saved; choose an agent to try again."));
        }
        Outcome::Uncertain(message) => fail(app, id, message),
    }
}

fn attach(app: &mut App, id: &str) {
    if !valid(app, id) { return }
    let c = &app.agent_switch.changes[id];
    let Some(next) = c.next.as_ref() else { return };
    let Some(agent) = app.fleet.agent(&c.source.machine_id, next) else { return };
    if !agent.terminal_available {
        if agent.launch == "failed" {
            let why = agent.launch_error.clone();
            app.agent_switch.changes.get_mut(id).unwrap().creation_finished = true;
            fail(app, id, format!("The new agent could not start: {why}. Its previous conversation is saved."));
        } else if c.since.elapsed() > Duration::from_secs(30) {
            fail(app, id, "The new terminal is not available yet. Choose the same agent to check its start.");
        }
        return;
    }
    let machine = c.source.machine_id.clone(); let old = c.source.id.clone(); let next = next.clone();
    let target = theme::engine_label(&c.engine).to_string();
    let no_history = c.context_loaded && c.handoff.is_none();
    let handoff_failed = c.handoff_failed;
    let owns_picker = app.agent_switch.selection.as_ref().is_some_and(|s| s.source.key() == c.source.key())
        && matches!(app.modal, Some(Modal::Picker { kind: PickerKind::AgentSwitch, .. }));
    if let Some(mut row) = c.next_row.clone() {
        row["terminal"] = json!({"available":true});
        crate::workspace_events::publish(app, &c.identity, Some(row));
    }
    let replaced = app.replace_harness_views(&machine, &old, &next);
    app.agent_switch.changes.remove(id);
    if owns_picker { app.modal = None; }
    let message = if replaced == 0 { format!("{target} started. Open it from Harnesses; the original pane was closed.") }
        else if no_history && handoff_failed { format!("Switched to {target}. The earlier history could not be prepared.") }
        else if no_history { format!("Switched to {target}. No earlier conversation was found to hand off.") }
        else { format!("Switched to {target}") };
    app.say(message, theme::ONLINE);
}

/// Keep a view while its source has stopped and the replacement is being checked, including
/// an ambiguous launch. An explicit close still removes that view normally.
pub fn preserves(app: &App, pane: u64) -> bool {
    app.panes.get(&pane).is_some_and(|p| app.agent_switch.changes.values().any(|c| c.preserving && c.belongs(app)
        && c.source.machine_id == p.machine_id && c.source.id == p.agent_id))
        || app.agent_switch.placements.values().any(|p| placement_views(app, p).iter().any(|(_, id)| *id == pane))
}

pub fn tick(app: &mut App) {
    let waiting: Vec<_> = app.agent_switch.changes.iter().filter(|(_, c)| c.stage == Stage::Terminal).map(|(id, _)| id.clone()).collect();
    for id in waiting { attach(app, &id); }
    retry_placements(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{app::{DeskMode, Tab}, fleet::{Machine, Reach}, layout::{Dir, Node}, pane::Pane};

    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19799, sink, (120, 32));
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(Machine { id:"local".into(), name:"studio".into(), local:true, shared:false, status:"online".into(), reach:Reach::Ready });
        app.desk_mode = DeskMode::Off;
        app.handed_over = true; app.cfg_finished = true;
        let mut tab = Tab::with_wid("work", 1);
        let mut root = Node::new(1, 120, 30); root.split(1, 2, Dir::Horizontal);
        tab.root = Some(root); tab.focus = Some(1); app.tabs = vec![tab];
        for n in 1..=2 {
            let id = format!("a{n}");
            let row = json!({"id":id, "engine":"codex", "sessionId":format!("s{n}"), "name":format!("Task {n}"), "createdAt":"2026-10-03T10:00:00.123Z",
                "closeSupported":true, "terminal":{"available":true}, "project":{"cwd":"/repo", "name":"repo"}, "permissionMode":"readOnly"});
            let a = crate::fleet::agent_from("local", &row, None);
            app.fleet.agents.insert(a.key(), a);
            let mut pane = Pane::new(n, "local", &id, 60, 30); pane.open_token = 7;
            app.panes.insert(n, pane);
        }
        app.fit_panes(); app
    }

    fn select(app: &mut App, engine: &str) {
        let Some(Modal::Picker { picker, .. }) = app.modal.take() else { panic!("missing picker") };
        choose(app, picker, &format!("engine:{engine}"));
    }

    fn start(app: &mut App, engine: &str) -> String {
        open(app, 1); select(app, engine);
        app.agent_switch.changes.keys().next().unwrap().clone()
    }

    fn handoff(app: &mut App, id: &str) {
        prepared(app, id, Ok(json!({"agentId":"a1", "degraded":[], "file":crate::agent_handoff::file("a1", id), "cwd":"/repo", "gitRepo":true})));
    }

    fn ready(id: &str, available: bool) -> Value {
        json!({"creationId":id, "state":"created", "agent":{"id":"replacement", "engine":"claude", "sessionId":"new-session", "createdAt":"2026-10-03T11:00:00.123Z",
            "name":"Task 1", "launch":{"state":"starting"}, "terminal":{"available":available}, "project":{"cwd":"/repo"}}})
    }

    fn sent(app: &App, ty: &str) -> Vec<Value> { app.agent_switch.sent.iter().filter(|(_, t, _)| t == ty).map(|(_, _, p)| p.clone()).collect() }

    #[tokio::test]
    async fn replacement_keeps_its_view_until_workspace_ack_and_retry_does_not_launch_again() {
        let mut app = app();
        app.desk_mode = DeskMode::Sync;
        app.tabs[0].on_desk = true;
        let tab = app.tabs[0].id.clone();
        let layout = app.tab().root.as_ref().unwrap().to_tmux();
        let id = start(&mut app, "claude"); handoff(&mut app, &id);
        stopped(&mut app, &id, Ok(json!({"closed":true})));
        created(&mut app, &id, Ok(ready(&id, true)));
        assert!(preserves(&app, 1));
        let ops = app.agent_switch.placements.values().next().unwrap().ops.clone();
        desk_write_failed(&mut app, &ops);
        assert!(sync_pending(&app));
        let peer = json!({"revision":2, "tabs":[{"id":tab,"name":"work","panes":[{"machineId":"local","agentId":"a2"}],"layout":{"presets":{"1":"rows"}}}]});
        app.apply_desk(&peer);
        assert_eq!(app.tabs[0].panes().len(), 2);
        assert_eq!(app.panes[&1].agent_id, "replacement");
        assert_eq!(app.tab().root.as_ref().unwrap().to_tmux(), layout);
        retry_sync(&mut app);
        assert_eq!(sent(&app, "agent_create").len(), 1);
        assert_eq!(sent(&app, "agent_close").len(), 1);
        let acknowledged = json!({"revision":3,"tabs":[{"id":tab,"name":"work","panes":[{"machineId":"local","agentId":"replacement"},{"machineId":"local","agentId":"a2"}],"layout":app.tabs[0].layout}]});
        app.apply_desk(&acknowledged);
        assert!(!preserves(&app, 1)); assert!(!sync_pending(&app));
        let mut closed = peer; closed["revision"] = json!(4);
        app.apply_desk(&closed);
        assert!(!app.panes.contains_key(&1), "an explicit peer close after acknowledgement is respected");
    }

    #[tokio::test]
    async fn workspace_retry_cannot_reopen_a_view_closed_locally_or_cross_its_owner() {
        for close in [true, false] {
            let mut app = app(); app.desk_mode = DeskMode::Sync; app.tabs[0].on_desk = true;
            let id = start(&mut app, "claude"); handoff(&mut app, &id);
            stopped(&mut app, &id, Ok(json!({"closed":true}))); created(&mut app, &id, Ok(ready(&id, true)));
            let ops = app.agent_switch.placements.values().next().unwrap().ops.clone();
            desk_write_failed(&mut app, &ops);
            if close { app.close_pane(1); } else { app.fleet.local_id = "another-owner".into(); }
            assert!(!preserves(&app, 1));
            retry_sync(&mut app);
            assert!(app.agent_switch.placements.is_empty());
            assert_eq!(sent(&app, "agent_create").len(), 1);
        }
    }

    #[tokio::test]
    async fn accepted_workspace_write_without_its_pane_is_recoverable_without_relaunch() {
        let mut app = app(); app.desk_mode = DeskMode::Sync; app.tabs[0].on_desk = true;
        let id = start(&mut app, "claude"); handoff(&mut app, &id);
        stopped(&mut app, &id, Ok(json!({"closed":true}))); created(&mut app, &id, Ok(ready(&id, true)));
        let ops = app.agent_switch.placements.values().next().unwrap().ops.clone();
        // An earlier batch that doesn't contain this pane cannot reject its later addition.
        desk_write_replied(&mut app, &[json!({"op":"tab.rename","id":"other","name":"Other"})], &json!({"revision":2,"tabs":[]}));
        assert!(!sync_pending(&app));
        desk_write_replied(&mut app, &ops, &json!({"revision":3,"tabs":[]}));
        assert!(sync_pending(&app)); assert!(preserves(&app, 1));
        retry_sync(&mut app);
        assert_eq!(sent(&app, "agent_create").len(), 1);
        assert_eq!(sent(&app, "agent_close").len(), 1);
    }

    #[tokio::test]
    async fn success_saves_then_replaces_the_original_pane_without_moving_focus_or_layout() {
        let mut app = app();
        let layout = app.tab().root.as_ref().unwrap().to_tmux();
        let id = start(&mut app, "claude");
        assert!(sent(&app, "agent_close").is_empty());
        handoff(&mut app, &id);
        assert_eq!(sent(&app, "agent_close")[0], json!({"agentId":"a1", "sessionId":"s1", "createdAt":"2026-10-03T10:00:00.123Z", "mode":"now"}));
        assert!(sent(&app, "agent_create").is_empty());
        app.tabs[0].focus = Some(2);
        stopped(&mut app, &id, Ok(json!({"closed":true})));
        let payload = &sent(&app, "agent_create")[0];
        assert_eq!(payload["cwd"], "/repo");
        assert_eq!(payload["permissionMode"], "ask", "an incompatible permission falls back to ask");
        assert_eq!(payload["bypassPermission"], false);
        assert!(payload["prompt"].as_str().unwrap().contains(&crate::agent_handoff::file("a1", &id)));
        created(&mut app, &id, Ok(ready(&id, true)));
        assert_eq!(app.panes[&1].agent_id, "replacement");
        assert_eq!(app.panes[&2].agent_id, "a2");
        assert!(app.panes[&1].open_token > 7, "the old stream's late reply must be invalid");
        assert_eq!(app.focused(), Some(2));
        assert_eq!(app.tab().root.as_ref().unwrap().to_tmux(), layout);
        assert!(app.agent_switch.changes.is_empty());
        assert!(app.modal.is_none());
    }

    #[tokio::test]
    async fn failed_handoff_or_unconfirmed_stop_never_starts_a_replacement() {
        let mut app = app();
        let id = start(&mut app, "claude");
        prepared(&mut app, &id, Err(RpcError::new("UNSUPPORTED", "")));
        assert_eq!(sent(&app, "agent_recent"), vec![json!({"agentId":"a1", "n":5})]);
        recent(&mut app, &id, Err(RpcError::new("TIMEOUT", "")));
        assert!(sent(&app, "agent_close").is_empty());
        select(&mut app, "claude");
        let id = app.agent_switch.changes.keys().next().unwrap().clone();
        handoff(&mut app, &id);
        stopped(&mut app, &id, Err(RpcError::new("TIMEOUT", "No acknowledgement")));
        assert!(sent(&app, "agent_create").is_empty());
        assert_eq!(app.panes[&1].agent_id, "a1");
        assert_eq!(app.fleet.agent("local", "a1").unwrap().status, "active");
        assert!(app.agent_switch.changes[&id].error.contains("No acknowledgement"));
    }

    #[tokio::test]
    async fn a_lost_create_reply_can_only_check_the_original_receipt() {
        let mut app = app();
        let id = start(&mut app, "claude"); handoff(&mut app, &id); stopped(&mut app, &id, Ok(json!({"closed":true})));
        created(&mut app, &id, Err(RpcError::new("TIMEOUT", "")));
        assert_eq!(sent(&app, "agent_create").len(), 1);
        select(&mut app, "opencode");
        assert!(sent(&app, "agent_create_status").is_empty());
        select(&mut app, "claude");
        assert_eq!(sent(&app, "agent_create_status"), vec![json!({"creationId":id})]);
        checked(&mut app, &id, Ok(json!({"creationId":"unrelated", "state":"created", "agent":{"id":"wrong"}})));
        assert_eq!(app.panes[&1].agent_id, "a1");
        select(&mut app, "claude");
        checked(&mut app, &id, Ok(ready(&id, true)));
        assert_eq!(sent(&app, "agent_create").len(), 1);
        assert_eq!(app.panes[&1].agent_id, "replacement");
    }

    #[tokio::test]
    async fn a_starting_terminal_attaches_early_and_keeps_a_different_picker_open() {
        let mut app = app();
        let id = start(&mut app, "claude"); handoff(&mut app, &id); stopped(&mut app, &id, Ok(json!({"closed":true})));
        open(&mut app, 2);
        created(&mut app, &id, Ok(ready(&id, false)));
        assert_eq!(app.panes[&1].agent_id, "a1");
        assert!(preserves(&app, 1));
        app.fleet.agents.get_mut(&("local".into(), "replacement".into())).unwrap().terminal_available = true;
        tick(&mut app);
        assert_eq!(app.panes[&1].agent_id, "replacement");
        assert!(matches!(app.modal, Some(Modal::Picker { kind:PickerKind::AgentSwitch, .. })), "do not close the picker for the other pane");
        assert_eq!(app.agent_switch.selection.as_ref().unwrap().source.id, "a2");
    }

    #[tokio::test]
    async fn changed_identity_or_account_refuses_the_late_handoff() {
        for owner in [false, true] {
            let mut app = app(); let id = start(&mut app, "claude");
            if owner { app.fleet.local_id = "another-owner".into(); }
            else { app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap().session_id = "newer".into(); }
            handoff(&mut app, &id);
            assert!(sent(&app, "agent_close").is_empty());
            assert!(sent(&app, "agent_create").is_empty());
        }
    }

    #[tokio::test]
    async fn package_compatibility_and_shared_ownership_are_enforced() {
        let mut app = app();
        app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap().dsh_id = "tools/cad".into();
        app.dsh.insert("local".into(), vec![json!({"id":"tools/cad", "engine":"codex", "engines":["codex"]})]);
        open(&mut app, 1); select(&mut app, "claude");
        assert!(app.agent_switch.sent.is_empty());
        app.fleet.machines[0].shared = true;
        assert!(!pane_supports(&app, 1));
        app.modal = None; open(&mut app, 1);
        assert!(app.modal.is_none());
    }

    #[tokio::test]
    async fn desk_pruning_keeps_the_switch_view_then_gives_its_replacement_a_fresh_tab_identity() {
        let mut app = app();
        app.tabs[0].root = Some(Node::new(1, 120, 30));
        app.tabs[0].on_desk = true; app.session_desk = true;
        app.tabs[0].name = "Pinned task".into(); app.tabs[0].named = true;
        app.panes.remove(&2);
        let original_tab = app.tab().id.clone();
        app.nums.insert(original_tab.clone(), 7);
        app.fit_panes();
        let layout = app.tab().root.as_ref().unwrap().to_tmux();
        let id = start(&mut app, "claude"); handoff(&mut app, &id); stopped(&mut app, &id, Ok(json!({"closed":true})));
        app.apply_desk(&json!({"revision":5, "tabs":[]}));
        assert_eq!(app.tab().id, original_tab);
        assert_eq!(app.panes[&1].agent_id, "a1");
        created(&mut app, &id, Ok(ready(&id, true)));
        assert_ne!(app.tab().id, original_tab, "a queued peer close must not target the new conversation");
        assert_eq!(app.nums.get(&app.tab().id), Some(&7));
        assert_eq!(app.tab().name, "Pinned task");
        assert_eq!(app.focused(), Some(1));
        assert_eq!(app.tab().root.as_ref().unwrap().to_tmux(), layout);
    }

    #[tokio::test]
    async fn all_open_views_change_in_place_and_a_closed_view_is_not_recreated() {
        let mut app = app();
        let mut second = Tab::with_wid("second view", 3);
        second.root = Some(Node::new(3, 120, 30)); second.focus = Some(3);
        app.tabs.push(second);
        app.panes.insert(3, Pane::new(3, "local", "a1", 120, 30));
        let id = start(&mut app, "claude"); handoff(&mut app, &id); stopped(&mut app, &id, Ok(json!({"closed":true})));
        app.close_pane(1);
        assert!(!app.panes.contains_key(&1));
        created(&mut app, &id, Ok(ready(&id, true)));
        assert!(!app.panes.contains_key(&1));
        assert_eq!(app.panes[&3].agent_id, "replacement");
        assert_eq!(app.panes[&2].agent_id, "a2");
    }

    #[tokio::test]
    async fn removal_before_close_ack_still_uses_that_exact_ack() {
        let mut app = app();
        let id = start(&mut app, "claude"); handoff(&mut app, &id);
        app.fleet.agents.remove(&("local".into(), "a1".into()));
        assert!(preserves(&app, 1));
        stopped(&mut app, &id, Ok(json!({"closed":true})));
        assert_eq!(sent(&app, "agent_create").len(), 1);
        created(&mut app, &id, Ok(ready(&id, true)));
        assert_eq!(app.panes[&1].agent_id, "replacement");
    }

    #[tokio::test]
    async fn confirmed_launch_failure_retries_from_saved_context_when_source_was_pruned() {
        let mut app = app();
        let id = start(&mut app, "claude"); handoff(&mut app, &id); stopped(&mut app, &id, Ok(json!({"closed":true})));
        app.fleet.agents.remove(&("local".into(), "a1".into()));
        created(&mut app, &id, Err(RpcError::new("INVALID_ENGINE", "Engine not ready")));
        open(&mut app, 1); select(&mut app, "claude");
        assert_eq!(sent(&app, "agent_close").len(), 1, "do not stop the already saved source again");
        assert_eq!(sent(&app, "agent_handoff_prepare").len(), 1, "reuse context from the saved source");
        let creates = sent(&app, "agent_create"); assert_eq!(creates.len(), 2);
        assert_ne!(creates[0]["creationId"], creates[1]["creationId"]);
        assert_eq!(creates[0]["prompt"], creates[1]["prompt"]);
        let retry = app.agent_switch.changes.keys().next().unwrap().clone();
        created(&mut app, &retry, Ok(ready(&retry, true)));
        assert_eq!(app.panes[&1].agent_id, "replacement");
    }
}
