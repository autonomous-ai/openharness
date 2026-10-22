//! Desktop's Close contract: inspect, stop idle sessions without a prompt, and
//! explicitly confirm other activity. A missing acknowledgement never removes a view.
use std::collections::HashSet;
#[cfg(not(test))]
use std::time::Duration;

use serde_json::{json, Value};

use crate::app::App;
use crate::daemon::RpcError;
use crate::fleet::Agent;
use crate::modal::Modal;
use crate::{theme, workspace_menu as menu};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub machine: String,
    pub agent: String,
    pub session: String,
    pub created: String,
    owner: String,
    generation: Option<u64>,
}

impl Identity {
    pub fn capture(app: &App, agent: &Agent) -> Self {
        Self { machine: agent.machine_id.clone(), agent: agent.id.clone(), session: agent.session_id.clone(),
            created: agent.created_at_wire.clone(), owner: app.fleet.local_id.clone(), generation: app.connection_generation(&agent.machine_id) }
    }

    pub fn matches(&self, app: &App) -> bool {
        self.connection_matches(app)
            && app.fleet.agent(&self.machine, &self.agent).is_some_and(|a| a.session_id == self.session && a.created_at_wire == self.created)
    }

    /// The reviewed harness, as it is now: the same agent, and the reviewed conversation or, reviewed before its
    /// engine bound one (Codex's first seconds), the one it bound since. The row may now be stopped. Desktop's
    /// `Agent.continuesSession`; a Stop still names the reviewed identity and the daemon decides (cli `matches`).
    pub fn continues(&self, app: &App) -> bool {
        self.connection_matches(app) && app.fleet.agent(&self.machine, &self.agent)
            .is_some_and(|a| a.created_at_wire == self.created && (a.session_id == self.session || self.session.is_empty()))
    }

    pub fn connection_matches(&self, app: &App) -> bool {
        self.owner_matches(app) && self.generation == app.connection_generation(&self.machine)
    }

    pub fn owner_matches(&self, app: &App) -> bool {
        self.owner == app.fleet.local_id && !app.fleet.machine(&self.machine).is_none_or(|m| m.shared)
    }

    pub fn payload(&self, mode: &str) -> Value {
        json!({ "agentId": self.agent, "sessionId": self.session, "createdAt": self.created, "mode": mode })
    }
}

#[derive(Clone)]
struct Target { identity: Identity, name: String, activity: String, closed: bool }

#[derive(Clone)]
struct View { pane: u64, machine: String, agent: String, epoch: Option<(String, String)>, owner: String }

impl View {
    fn capture(app: &App, pane: u64) -> Option<Self> {
        let p = app.panes.get(&pane)?;
        let epoch = app.fleet.agent(&p.machine_id, &p.agent_id).map(|a| (a.session_id.clone(), a.created_at_wire.clone()));
        Some(Self { pane, machine: p.machine_id.clone(), agent: p.agent_id.clone(), epoch, owner: app.fleet.local_id.clone() })
    }

    fn matches(&self, app: &App) -> bool {
        self.owner == app.fleet.local_id && app.panes.get(&self.pane).is_some_and(|p| p.machine_id == self.machine && p.agent_id == self.agent)
            && match (&self.epoch, app.fleet.agent(&self.machine, &self.agent)) {
                // (Captured before its first conversation bound: the same view of it once one has.)
                (Some((session, created)), Some(a)) => *created == a.created_at_wire && (session.is_empty() || *session == a.session_id),
                (epoch, agent) => epoch.is_none() && agent.is_none(),
            }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage { Inspect, Review, Stop, Failed }

struct Operation {
    id: String,
    title: String,
    /// The tab's name when closing a whole tab; a pane's close has none.
    tab: Option<String>,
    targets: Vec<Target>,
    views: Vec<View>,
    /// Plain shells obey tmux's kill contract, after an explicit confirmation.
    shells: bool,
    /// A harness whose CLI can't save and stop it: the others stop, then the close says why it could not.
    unsupported: bool,
    return_to_shell: bool,
    stage: Stage,
    at: usize,
    force: bool,
}

#[derive(Default)]
pub struct State {
    operation: Option<Operation>,
    #[cfg(test)]
    pub replies: std::collections::VecDeque<Result<Value, RpcError>>,
    #[cfg(test)]
    pub sent: Vec<(String, Value)>,
}

pub fn pane(app: &mut App, pane: u64) { begin(app, vec![pane], "Close pane", None, true); }

/// Default tmux close keys keep their keys, while managed harnesses use the same lifecycle as ×.
/// Explicit kill commands and ordinary shells retain tmux's behavior.
pub fn managed_pane(app: &App, pane: u64) -> bool {
    app.panes.get(&pane).is_some_and(|p| !crate::local::is_local(&p.machine_id)
        && !app.shells.contains(&(p.machine_id.clone(), p.agent_id.clone()))
        && app.fleet.agent(&p.machine_id, &p.agent_id).is_some_and(|a| a.engine != "terminal"))
}

pub fn tab(app: &mut App, tab: usize) {
    let Some(tab) = app.tabs.get(tab) else { return };
    if tab.panes().is_empty() { app.close_tab(app.tabs.iter().position(|t| t.id == tab.id).unwrap()); return }
    let title = format!("Close Tab · {}", tab.name);
    let name = tab.name.clone();
    begin(app, tab.panes(), &title, Some(name), false);
}

fn begin(app: &mut App, panes: Vec<u64>, title: &str, tab: Option<String>, return_to_shell: bool) {
    if app.read_only() { app.error("client is read-only"); return }
    if app.session_close.operation.as_ref().is_some_and(|op| matches!(op.stage, Stage::Inspect | Stage::Stop) && (op.stage == Stage::Stop || showing(app, &op.id))) {
        app.say("A stop is already being checked", theme::MUTED);
        return;
    }
    let mut targets = Vec::new();
    let mut views = Vec::new();
    let mut seen = HashSet::new();
    let mut shells = false;
    let mut unsupported = false;
    for pane in panes {
        let Some(p) = app.panes.get(&pane) else { continue };
        views.extend(View::capture(app, pane));
        if crate::local::is_local(&p.machine_id) || app.shells.contains(&(p.machine_id.clone(), p.agent_id.clone())) {
            shells = true;
            continue;
        }
        let shared = app.fleet.machine(&p.machine_id).is_some_and(|m| m.shared);
        if shared { continue }
        // As Desktop's Close: a harness no longer listed, already stopped, without a terminal, or the
        // monitor's reusable dashboard has nothing to stop. Its view closes.
        let Some(a) = app.fleet.agent(&p.machine_id, &p.agent_id) else { continue };
        if a.status == "stopped" || a.dsh_id == "autonomous/harness-monitor" || !a.terminal_available { continue }
        // An older CLI can't save and stop it. Say so, and still let the view close (Close pane) rather than
        // hide it silently, or keep it with no way out.
        if !a.close_supported || a.created_at_wire.is_empty() { unsupported = true; continue }
        if seen.insert((a.machine_id.clone(), a.id.clone())) {
            targets.push(Target { identity: Identity::capture(app, a), name: a.name.clone(), activity: "unknown".into(), closed: false });
        }
    }
    if views.is_empty() { return }
    let id = uuid::Uuid::new_v4().simple().to_string();
    app.session_close.operation = Some(Operation { id: id.clone(), title: title.into(), tab, targets, views, shells, unsupported,
        return_to_shell, stage: Stage::Inspect, at: 0, force: false });
    if !show(app, "Checking session activity…", false) { app.session_close.operation = None; return }
    advance(app, &id);
}

/// What a harness is doing, as a row of the dialog says it (Desktop's `_activityLabel`).
fn activity_label(activity: &str) -> &'static str {
    match activity {
        "working" => "Working",
        "needs_input" => "Waiting for input",
        "draft" => "Unsent text",
        "idle" => "Idle",
        "stopped" => "Stopped",
        "unconfirmed" => "Stop not confirmed",
        _ => "Activity unknown",
    }
}

/// The question's first line, for the harnesses that are not idle (Desktop's `_summary`).
fn summary(attention: &[&Target]) -> String {
    let one = attention.len() == 1;
    let subject = if one { "1 harness".to_string() } else { format!("{} harnesses", attention.len()) };
    let kinds: HashSet<&str> = attention.iter().map(|t| t.activity.as_str()).collect();
    if kinds.len() != 1 { return format!("{subject} {} attention.", if one { "needs" } else { "need" }) }
    match kinds.into_iter().next().unwrap_or_default() {
        "working" => format!("{subject} {} still working.", if one { "is" } else { "are" }),
        "needs_input" => format!("{subject} {} waiting for input.", if one { "is" } else { "are" }),
        "draft" => format!("{subject} {} unsent text.", if one { "has" } else { "have" }),
        _ => format!("{subject} may still be working."),
    }
}

fn showing(app: &App, id: &str) -> bool {
    let cancel = format!("close-harness -x {id}");
    matches!(&app.modal, Some(Modal::Menu(m)) if m.buttons.as_ref().is_some_and(|b| b.actions.contains(&cancel)))
}

fn show(app: &mut App, message: &str, confirm: bool) -> bool {
    let Some(op) = &app.session_close.operation else { return false };
    let mut items = Vec::new();
    let title = op.title.clone();
    let id = op.id.clone();
    let failed = op.stage == Stage::Failed;
    let room = app.size.1.saturating_sub(if confirm || failed { 6 } else { 4 }) as usize;
    // One row per harness: its name, its machine when the close spans several, and what it is doing.
    let several = op.targets.iter().map(|t| &t.identity.machine).collect::<HashSet<_>>().len() > 1;
    let rows = |items: &mut Vec<_>, listed: &[&Target]| {
        let space = room.saturating_sub(items.len() + 1);
        for t in listed.iter().take(space) {
            let activity = activity_label(if t.closed { "stopped" } else { &t.activity });
            items.push(menu::note(&if several { format!("{} · {} · {activity}", t.name, app.fleet.machine_name(&t.identity.machine)) }
                else { format!("{} · {activity}", t.name) }));
        }
        if listed.len() > space { items.push(menu::note(&format!("and {} more", listed.len() - space))); }
    };
    if confirm {
        // Desktop's question: what needs attention, then what Stop will do.
        let pending: Vec<&Target> = op.targets.iter().filter(|t| !t.closed).collect();
        let attention: Vec<&Target> = pending.iter().copied().filter(|t| t.activity != "idle").collect();
        if !attention.is_empty() { items.push(menu::note(&summary(&attention))); }
        if !pending.is_empty() {
            let these = if pending.len() == 1 { "this harness".to_string() } else { format!("all {} harnesses", pending.len()) };
            let scope = op.tab.as_ref().map_or("this pane".to_string(), |name| format!("the tab “{name}”"));
            items.push(menu::note(&format!("Stopping {these} will close {scope}. History will be saved.")));
        }
        rows(&mut items, &attention);
        if op.shells && items.len() < room { items.push(menu::note("The terminal and its running commands will end.")); }
        let closed = op.targets.len() - pending.len();
        if closed > 0 && items.len() < room {
            items.push(menu::note(&format!("{closed} {} already closed.", if closed == 1 { "harness has" } else { "harnesses have" })));
        }
    }
    if failed {
        // Desktop's failure: why, that the view can still close, and where each harness got to.
        items.push(menu::note(message));
        items.push(menu::note(if op.tab.is_some() { "You can close this tab. Some harnesses may still be running." }
            else { "You can close this pane. The harness may still be running." }));
        rows(&mut items, &op.targets.iter().collect::<Vec<_>>());
    } else if !message.is_empty() { items.push(menu::note(message)); }
    let button = |label: &str, key| crate::buttons::Button { label: label.into(), key };
    let (buttons, hint) = match op.stage {
        // Keep open is the default; Close pane removes only the views (`dismiss`).
        Stage::Failed => (vec![button("Keep open", None), button(if op.tab.is_some() { "Close Tab" } else { "Close pane" }, None)], crate::buttons::KEYS),
        Stage::Stop => (vec![button("Back", None)], ""),
        _ if confirm => (vec![button("Cancel", None), button("Stop", Some('s'))], crate::buttons::KEYS),
        // (One button: nothing to move between.)
        _ => (vec![button("Cancel", None)], ""),
    };
    let row = crate::buttons::Row { buttons, chosen: 0, hint: hint.into() };
    menu::open_buttons(app, &title, items, row, vec![format!("close-harness -x {id}"), format!("close-harness -y {id}")])
}

fn fail(app: &mut App, message: String) {
    let visible = app.session_close.operation.as_ref().is_some_and(|op| showing(app, &op.id));
    let Some(op) = &mut app.session_close.operation else { return };
    let closed = op.targets.iter().filter(|t| t.closed).count();
    // The harness whose stop went unanswered or was refused: its row says so.
    if op.stage == Stage::Stop { if let Some(t) = op.targets.get_mut(op.at).filter(|t| !t.closed) { t.activity = "unconfirmed".into(); } }
    op.stage = Stage::Failed;
    let message = if closed == 0 { message } else { format!("{closed} stopped. {message}") };
    // Keep the full explanation in messages even when the terminal is too narrow for its row.
    app.say(&message, theme::WARN);
    if visible { show(app, &message, false); }
}

fn advance(app: &mut App, id: &str) {
    let Some(op) = &app.session_close.operation else { return };
    if op.id != id { return }
    if op.stage == Stage::Inspect && !showing(app, id) { app.session_close.operation = None; return }
    if !op.targets.iter().filter(|t| !t.closed).all(|t| t.identity.continues(app)) {
        fail(app, "The session or connection changed. Check it before trying again.".into()); return;
    }
    if op.at >= op.targets.len() {
        if op.stage == Stage::Inspect {
            let confirm = op.shells || op.targets.iter().any(|t| !t.closed && t.activity != "idle");
            let op = app.session_close.operation.as_mut().unwrap();
            op.at = 0;
            if confirm {
                op.stage = Stage::Review;
                show(app, "", true);
                return;
            }
            op.stage = Stage::Stop;
            show(app, "Saving and stopping…", false);
            advance(app, id);
        } else if op.unsupported {
            // (Desktop's: the others are stopped; the one an older CLI serves keeps its view until Close pane.)
            fail(app, "Update the Harness CLI on this machine to save and stop this harness".into());
        } else { finish(app); }
        return;
    }
    let (index, target, mode) = (op.at, op.targets[op.at].clone(), if op.stage == Stage::Inspect { "inspect" } else if op.force { "now" } else { "idle" });
    if target.closed { app.session_close.operation.as_mut().unwrap().at += 1; advance(app, id); return }
    let id = id.to_string();
    let payload = target.identity.payload(mode);
    #[cfg(test)]
    {
        app.session_close.sent.push((target.identity.machine.clone(), payload.clone()));
        if let Some(reply) = app.session_close.replies.pop_front() { received(app, &id, index, mode, reply); }
        return;
    }
    #[cfg(not(test))]
    {
        let Some(link) = app.link(&target.identity.machine) else {
            fail(app, format!("{} is not connected. The pane is still here.", app.fleet.machine_name(&target.identity.machine)));
            return;
        };
        app.spawn(async move { link.request("agent_close", payload, Duration::from_secs(35)).await.map(|(_, reply)| reply) },
            move |app, reply| received(app, &id, index, mode, reply));
    }
}

fn received(app: &mut App, id: &str, index: usize, mode: &str, reply: Result<Value, RpcError>) {
    let Some(op) = &app.session_close.operation else { return };
    if op.id != id || op.at != index { return }
    if mode == "inspect" && !showing(app, id) { app.session_close.operation = None; return }
    let mut identity = op.targets[index].identity.clone();
    // Closed and its row already gone: an inspect can answer that too, when it was closed elsewhere first.
    let removed_before_ack = identity.connection_matches(app)
        && app.fleet.agent(&identity.machine, &identity.agent).is_none() && reply.as_ref().is_ok_and(|r| r["closed"] == true);
    if !identity.continues(app) && !removed_before_ack { fail(app, "The session or connection changed. No replacement was stopped.".into()); return }
    // From here on, the conversation it bound since the review (if it did): the views and other clients know that one.
    if let Some(a) = app.fleet.agent(&identity.machine, &identity.agent) { identity.session = a.session_id.clone(); }
    let reply = match reply {
        Ok(reply) => reply,
        Err(error) => {
            fail(app, format!("Stop not confirmed: {error}. Check the session before trying again."));
            app.relist(&identity.machine);
            return;
        }
    };
    let activity = reply["activity"].as_str().unwrap_or("unknown").to_string();
    if reply["error"] == "SESSION_NOT_IDLE" && mode == "idle" {
        if !showing(app, id) { fail(app, "Activity changed before stopping. Check the session before trying again.".into()); return }
        let op = app.session_close.operation.as_mut().unwrap();
        op.targets[index].activity = activity;
        // Inspect the remaining set again; activity may have changed while saving.
        op.stage = Stage::Inspect;
        op.at = 0;
        show(app, "Activity changed. Checking the remaining sessions…", false);
        advance(app, id);
        return;
    }
    if let Some(error) = reply["error"].as_str() {
        fail(app, format!("Stop not confirmed: {}", reply["detail"].as_str().filter(|s| !s.is_empty()).unwrap_or(error)));
        return;
    }
    // An inspect can answer closed too: stopped already (by another window, or a close whose answer was lost).
    let closed = reply["closed"] == true;
    if mode != "inspect" && !closed {
        fail(app, "Stop not confirmed. The pane is still here.".into()); return;
    }
    let op = app.session_close.operation.as_mut().unwrap();
    let target = &mut op.targets[index];
    if closed { target.closed = true; target.identity = identity.clone(); } else { target.activity = activity; }
    op.at += 1;
    if closed {
        crate::workspace_events::publish(app, &identity, None);
        remove_confirmed(app, &identity);
    }
    advance(app, id);
}

fn remove_confirmed(app: &mut App, identity: &Identity) {
    if !identity.connection_matches(app) || app.fleet.agent(&identity.machine, &identity.agent)
        .is_some_and(|a| a.session_id != identity.session || a.created_at_wire != identity.created) { return }
    if let Some(a) = app.fleet.agents.get_mut(&(identity.machine.clone(), identity.agent.clone())) { a.status = "stopped".into(); a.working = false; }
    // Stop is global, including views in a session this client is not showing.
    // Exact session targets use the normal context save/restore path; other clients'
    // ordinary sessions follow the view receipt, and desk tabs follow desk updates.
    let elsewhere: Vec<_> = app.owned_harness_views(&identity.machine, &identity.agent).into_iter().filter(|(sid, _)| *sid != app.session_id).collect();
    for (sid, pane) in elsewhere {
        if crate::shell_context::is_session_visit(app, pane) { continue }
        if app.panes.contains_key(&pane) { crate::commands::execute(app, &format!("kill-pane -t '${sid}:.{}'", crate::pane::tag(pane))); }
    }
    let panes: Vec<_> = app.panes.values().filter(|p| p.machine_id == identity.machine && p.agent_id == identity.agent).map(|p| p.id).collect();
    for pane in panes {
        if !crate::shell_context::is_session_visit(app, pane) { app.close_pane(pane); }
    }
}

pub fn confirm(app: &mut App, id: &str) {
    let Some(op) = &mut app.session_close.operation else { return };
    if op.id == id && op.stage == Stage::Failed { dismiss(app); return }
    if op.id != id || op.stage != Stage::Review { return }
    op.stage = Stage::Stop;
    op.force = true;
    op.at = 0;
    show(app, "Saving and stopping…", false);
    advance(app, id);
}

pub fn cancel(app: &mut App, id: &str) {
    if let Some(op) = &app.session_close.operation {
        if op.id != id { return }
        // Already-issued requests still own their receipts. Cancel never cancels a remote save.
        if op.stage != Stage::Stop { app.session_close.operation = None; }
    }
    if showing(app, id) { app.modal = None; }
}

/// Close pane / Close Tab after a stop that failed: Desktop's `closeAfterError`. Only the captured views close. No
/// stop is sent again, and a lost answer is not taken as a stop: the harness may still be running, and it stays in
/// the list to open again. A harness launched again under the same id since the review is another one, and keeps
/// its views. A conversation that changed within the same launch is still that harness: the daemon can drop a
/// binding it can no longer read (a guest's harness, run as another OS user), and refusing then left the pane
/// with no way to close. Plain terminals close only after their Stop was confirmed.
fn dismiss(app: &mut App) {
    let Some(op) = app.session_close.operation.take() else { return };
    if showing(app, &op.id) { app.modal = None; }
    let relaunched = op.targets.iter().any(|t| app.fleet.agent(&t.identity.machine, &t.identity.agent)
        .is_some_and(|a| a.created_at_wire != t.identity.created));
    if relaunched || op.targets.iter().any(|t| !t.identity.owner_matches(app)) {
        app.say("The harness changed. Check it before closing.", theme::WARN);
        return;
    }
    let mut seen = HashSet::new();
    for view in op.views {
        // A pane showing a picked session in place of its shell returns to that shell.
        if op.return_to_shell && crate::shell_context::is_session_visit(app, view.pane) { crate::shell_context::leave(app, view.pane); continue }
        let Some(p) = app.panes.get(&view.pane) else { continue };
        let shell = crate::local::is_local(&p.machine_id) || app.shells.contains(&(p.machine_id.clone(), p.agent_id.clone()));
        if view.owner != app.fleet.local_id || p.machine_id != view.machine || p.agent_id != view.agent || (shell && !op.force) { continue }
        if seen.insert(view.pane) { app.close_pane(view.pane); }
    }
}

fn finish(app: &mut App) {
    let Some(op) = app.session_close.operation.take() else { return };
    if showing(app, &op.id) { app.modal = None; }
    let views = op.views;
    for target in &op.targets {
        if target.closed { remove_confirmed(app, &target.identity); }
    }
    let mut seen = HashSet::new();
    for view in views {
        if op.return_to_shell && crate::shell_context::is_session_visit(app, view.pane) { continue }
        if seen.insert(view.pane) && view.matches(app) {
            app.close_pane(view.pane);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{DeskMode, Tab};
    use crate::fleet::{agent_from, Machine, Reach};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19799, sink, (100, 32));
        app.handed_over = true;
        app.cfg_finished = true;
        app.desk_mode = DeskMode::Off;
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(Machine { id: "local".into(), name: "This computer".into(), shared: false, local: true, status: "online".into(), reach: Reach::Ready });
        app.tabs.clear();
        for i in 1..=2 {
            let mut tab = Tab::with_wid(&format!("tab-{i}"), i);
            tab.root = Some(crate::layout::Node::new(i, 100, 30));
            tab.focus = Some(i);
            app.tabs.push(tab);
            let agent = format!("a{i}");
            app.panes.insert(i, crate::pane::Pane::new(i, "local", &agent, 100, 30));
            let a = agent_from("local", &json!({ "id": agent, "sessionId": format!("s{i}"), "createdAt": "2026-10-03T10:00:00.123Z",
                "name": format!("Task {i}"), "engine": "codex", "status": "active", "closeSupported": true, "terminal": {"available": true} }), None);
            app.fleet.agents.insert(("local".into(), agent), a);
        }
        app.fit_panes();
        app
    }

    fn id(app: &App) -> String { app.session_close.operation.as_ref().unwrap().id.clone() }
    fn modes(app: &App) -> Vec<&str> { app.session_close.sent.iter().filter_map(|(_, p)| p["mode"].as_str()).collect() }
    fn answer(app: &mut App, mode: &str, reply: Value) {
        let op = app.session_close.operation.as_ref().unwrap();
        let (id, at) = (op.id.clone(), op.at);
        received(app, &id, at, mode, Ok(reply));
    }
    fn key(app: &mut App, key: KeyCode) { crate::input::modal_key(app, KeyEvent::new(key, KeyModifiers::NONE)); }

    #[tokio::test]
    async fn idle_stop_uses_exact_identity_and_removes_only_the_confirmed_view() {
        let mut app = app();
        pane(&mut app, 1);
        assert_eq!(modes(&app), ["inspect"]);
        app.select_tab(1);
        answer(&mut app, "inspect", json!({"activity":"idle"}));
        assert_eq!(modes(&app), ["inspect", "idle"]);
        assert!(app.panes.contains_key(&1), "retain the pane until a stop is confirmed");
        assert_eq!(app.session_close.sent[1].1, json!({"agentId":"a1", "sessionId":"s1", "createdAt":"2026-10-03T10:00:00.123Z", "mode":"idle"}));
        answer(&mut app, "idle", json!({"closed":true}));
        assert!(!app.panes.contains_key(&1));
        assert_eq!(app.focused(), Some(2));
        assert_eq!(app.fleet.agent("local", "a1").unwrap().status, "stopped");
        assert!(app.modal.is_none(), "a completed idle stop leaves no dialog over the workspace");
    }

    #[tokio::test]
    async fn acknowledged_stop_removes_duplicate_views_in_inactive_owned_sessions() {
        let mut app = app();
        app.session_id = 11; app.session_desk = false; app.session_alias = Some("front".into());
        for (sid, desk, pane) in [(43, false, 3), (44, true, 5)] {
            let mut tab = Tab::with_wid("Background work", pane);
            let mut root = crate::layout::Node::new(pane, 100, 30);
            root.split(pane, pane + 1, crate::layout::Dir::Horizontal);
            tab.root = Some(root); tab.focus = Some(pane + 1); tab.on_desk = desk;
            app.panes.insert(pane, crate::pane::Pane::new(pane, "local", "a1", 50, 30));
            app.panes.insert(pane + 1, crate::pane::Pane::new(pane + 1, "local", "a2", 50, 30));
            app.sessions.push(crate::app::Stash { id:sid, used:0, mirror:None, alias:Some(format!("background-{sid}")), desk,
                tabs:vec![tab], active:0, lastw:vec![], nums:Default::default(), created:0, activity:0, last_attached:0,
                options:Default::default(), env:Default::default(), path:None, group:None });
        }
        pane(&mut app, 1);
        answer(&mut app, "inspect", json!({"activity":"idle"}));
        app.select_tab(1);
        answer(&mut app, "idle", json!({"closed":true}));
        assert_eq!(modes(&app), ["inspect", "idle"], "duplicate views never stop the process twice");
        for pane in [1, 3, 5] { assert!(!app.panes.contains_key(&pane), "stopped view {pane} remains"); }
        for pane in [2, 4, 6] { assert!(app.panes.contains_key(&pane), "unrelated view {pane} was closed"); }
        for session in &app.sessions { assert_eq!(session.tabs.len(), 1); assert_eq!(session.tabs[0].panes().len(), 1); }
        assert_eq!(app.session_id, 11); assert_eq!(app.focused(), Some(2));
    }

    #[tokio::test]
    async fn every_non_idle_state_requires_confirmation_and_enter_cancels() {
        for state in ["working", "needs_input", "draft", "unknown", "unrecognized"] {
            let mut app = app();
            pane(&mut app, 1);
            answer(&mut app, "inspect", json!({"activity":state}));
            assert_eq!(modes(&app), ["inspect"]);
            key(&mut app, KeyCode::Enter);
            assert!(app.modal.is_none());
            assert!(app.session_close.operation.is_none());
            assert_eq!(modes(&app), ["inspect"]);
            assert!(app.panes.contains_key(&1));
        }
    }

    #[tokio::test]
    async fn right_then_enter_stops_and_the_buttons_are_one_row_model() {
        let mut app = app();
        pane(&mut app, 1);
        answer(&mut app, "inspect", json!({"activity":"working"}));
        let Some(Modal::Menu(m)) = &app.modal else { panic!("no confirmation") };
        let b = m.buttons.as_ref().expect("a button row");
        assert_eq!(b.row.buttons.iter().map(|x| x.label.as_str()).collect::<Vec<_>>(), ["Cancel", "Stop"]);
        assert_eq!(b.row.chosen, 0, "a destructive action starts on Cancel");
        key(&mut app, KeyCode::Right);
        key(&mut app, KeyCode::Enter);
        assert_eq!(modes(&app), ["inspect", "now"]);
    }

    #[tokio::test]
    async fn every_way_out_of_the_buttons_cancels_and_other_keys_do_nothing() {
        let press = |app: &mut App, code, mods| crate::input::modal_key(app, KeyEvent::new(code, mods));
        let ask = || { let mut app = app(); pane(&mut app, 1); answer(&mut app, "inspect", json!({"activity":"working"})); app };
        for (code, mods) in [(KeyCode::Esc, KeyModifiers::NONE), (KeyCode::Char('q'), KeyModifiers::NONE),
            (KeyCode::Char('c'), KeyModifiers::CONTROL), (KeyCode::Char('g'), KeyModifiers::CONTROL)] {
            let mut app = ask();
            press(&mut app, code, mods);
            assert!(app.modal.is_none(), "{code:?} {mods:?} leaves the dialog");
            assert!(app.session_close.operation.is_none(), "{code:?} {mods:?} must not leave the close pending");
            assert_eq!(modes(&app), ["inspect"], "{code:?} {mods:?} stops nothing");
        }
        let mut app = ask();
        for (code, mods) in [(KeyCode::Char('j'), KeyModifiers::NONE), (KeyCode::Char('k'), KeyModifiers::NONE), (KeyCode::Char('q'), KeyModifiers::CONTROL),
            (KeyCode::Tab, KeyModifiers::NONE), (KeyCode::BackTab, KeyModifiers::SHIFT)] {
            press(&mut app, code, mods);
            assert!(matches!(app.modal, Some(Modal::Menu(_))), "{code:?} keeps the dialog");
            assert_eq!(modes(&app), ["inspect"]);
        }
        let Some(Modal::Menu(m)) = &app.modal else { unreachable!() };
        assert_eq!(m.buttons.as_ref().unwrap().row.chosen, 0, "Tab then Shift-Tab returns to Cancel");
    }

    #[tokio::test]
    async fn explicit_stop_keeps_its_target_when_focus_moves() {
        let mut app = app();
        pane(&mut app, 1);
        answer(&mut app, "inspect", json!({"activity":"working"}));
        app.select_tab(1);
        key(&mut app, KeyCode::Char('s'));
        assert_eq!(modes(&app), ["inspect", "now"]);
        assert_eq!(app.session_close.sent[1].1["agentId"], "a1");
        answer(&mut app, "now", json!({"closed":true}));
        assert_eq!(app.focused(), Some(2));
    }

    #[tokio::test]
    async fn work_starting_during_an_idle_stop_is_reinspected_then_confirmed() {
        let mut app = app();
        pane(&mut app, 1);
        answer(&mut app, "inspect", json!({"activity":"idle"}));
        answer(&mut app, "idle", json!({"error":"SESSION_NOT_IDLE", "activity":"working"}));
        answer(&mut app, "inspect", json!({"activity":"draft"}));
        assert_eq!(modes(&app), ["inspect", "idle", "inspect"]);
        assert!(app.panes.contains_key(&1));
        key(&mut app, KeyCode::Char('s'));
        assert_eq!(modes(&app), ["inspect", "idle", "inspect", "now"]);
    }

    #[tokio::test]
    async fn lost_or_malformed_stop_acknowledgement_never_closes_or_retries() {
        for reply in [Err(RpcError::new("TIMEOUT", "lost answer")), Ok(json!({})), Ok(json!({"error":"SAVE_FAILED"}))] {
            let mut app = app();
            pane(&mut app, 1);
            answer(&mut app, "inspect", json!({"activity":"idle"}));
            let token = id(&app);
            received(&mut app, &token, 0, "idle", reply);
            assert!(app.panes.contains_key(&1));
            assert_eq!(modes(&app), ["inspect", "idle"]);
            assert!(app.session_close.operation.as_ref().is_some_and(|op| op.stage == Stage::Failed));
        }
    }

    #[tokio::test]
    async fn changed_session_or_account_cannot_inherit_an_old_confirmation() {
        for change in ["created", "session", "owner", "shared"] {
            let mut app = app();
            pane(&mut app, 1);
            answer(&mut app, "inspect", json!({"activity":"working"}));
            match change {
                "created" => app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap().created_at_wire.push('x'),
                "session" => app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap().session_id = "replacement".into(),
                "owner" => app.fleet.local_id = "other-account".into(),
                _ => app.fleet.machines[0].shared = true,
            }
            key(&mut app, KeyCode::Char('s'));
            assert_eq!(modes(&app), ["inspect"]);
            assert!(app.panes.contains_key(&1));
        }
    }

    #[tokio::test]
    async fn dismissing_an_inspection_does_not_stop_in_the_background() {
        let mut app = app();
        pane(&mut app, 1);
        let token = id(&app);
        key(&mut app, KeyCode::Esc);
        received(&mut app, &token, 0, "inspect", Ok(json!({"activity":"idle"})));
        assert!(app.modal.is_none());
        assert_eq!(modes(&app), ["inspect"]);
        assert!(app.panes.contains_key(&1));
    }

    #[tokio::test]
    async fn tab_inspects_every_distinct_session_before_stopping_any() {
        let mut app = app();
        app.tabs[0].root.as_mut().unwrap().split(1, 3, crate::layout::Dir::Horizontal);
        app.tabs[0].root.as_mut().unwrap().split(1, 4, crate::layout::Dir::Vertical);
        app.panes.insert(3, crate::pane::Pane::new(3, "local", "a1", 40, 20));
        app.panes.insert(4, crate::pane::Pane::new(4, "local", "a2", 40, 20));
        tab(&mut app, 0);
        answer(&mut app, "inspect", json!({"activity":"idle"}));
        assert_eq!(modes(&app), ["inspect", "inspect"]);
        assert_eq!(app.session_close.sent[1].1["agentId"], "a2");
        answer(&mut app, "inspect", json!({"activity":"working"}));
        assert_eq!(modes(&app), ["inspect", "inspect"]);
        key(&mut app, KeyCode::Enter);
        assert_eq!(app.panes.len(), 4);
    }

    #[tokio::test]
    async fn shared_views_do_not_stop_the_owners_harness() {
        let mut app = app();
        app.fleet.machines[0].shared = true;
        pane(&mut app, 1);
        assert!(app.session_close.sent.is_empty());
        assert!(!app.panes.contains_key(&1));
        assert_eq!(app.fleet.agent("local", "a1").unwrap().status, "active");
    }

    #[tokio::test]
    async fn an_old_daemon_cannot_turn_stop_into_hide() {
        // It says why it can't stop, and the view closes only when asked (Close pane), as after any failed stop.
        let mut app = app();
        app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap().close_supported = false;
        pane(&mut app, 1);
        assert!(app.session_close.sent.is_empty());
        assert!(app.panes.contains_key(&1));
        assert!(notes(&app).iter().any(|n| n.contains("Update the Harness CLI")), "{:?}", notes(&app));
        assert_eq!(buttons(&app), ["Keep open", "Close pane"]);
        key(&mut app, KeyCode::Right);
        key(&mut app, KeyCode::Enter);
        assert!(app.session_close.sent.is_empty(), "Close pane never asks to stop");
        assert!(!app.panes.contains_key(&1)); assert!(app.panes.contains_key(&2));
        assert_eq!(app.fleet.agent("local", "a1").unwrap().status, "active");
    }

    #[tokio::test]
    async fn a_tab_with_an_old_cli_harness_still_stops_the_others_then_says_why_one_could_not() {
        let mut app = app();
        app.tabs[0].root.as_mut().unwrap().split(1, 3, crate::layout::Dir::Horizontal);
        app.panes.insert(3, crate::pane::Pane::new(3, "local", "a2", 40, 20));
        app.fleet.agents.get_mut(&("local".into(), "a2".into())).unwrap().close_supported = false;
        tab(&mut app, 0);
        answer(&mut app, "inspect", json!({"activity":"idle"}));
        answer(&mut app, "idle", json!({"closed":true}));
        assert_eq!(modes(&app), ["inspect", "idle"], "only the harness that can be saved is asked");
        assert!(!app.panes.contains_key(&1), "the stopped harness's view closes");
        assert!(app.panes.contains_key(&3));
        assert!(notes(&app).iter().any(|n| n.contains("Update the Harness CLI")), "{:?}", notes(&app));
        assert_eq!(buttons(&app), ["Keep open", "Close Tab"]);
        key(&mut app, KeyCode::Right);
        key(&mut app, KeyCode::Enter);
        assert_eq!(modes(&app), ["inspect", "idle"]);
        assert!(!app.panes.contains_key(&3));
        assert_eq!(app.fleet.agent("local", "a2").unwrap().status, "active");
    }

    fn notes(app: &App) -> Vec<String> {
        let Some(Modal::Menu(m)) = &app.modal else { return vec![] };
        m.items.iter().map(|i| i.label.clone()).collect()
    }
    fn buttons(app: &App) -> Vec<String> {
        let Some(Modal::Menu(m)) = &app.modal else { return vec![] };
        m.buttons.as_ref().map(|b| b.row.buttons.iter().map(|x| x.label.clone()).collect()).unwrap_or_default()
    }

    #[tokio::test]
    async fn a_refused_stop_offers_close_pane_which_closes_only_the_view() {
        // A guest's harness on a shared computer: its owner's daemon can't read the conversation, and refuses.
        let refuse = |app: &mut App| {
            pane(app, 1);
            answer(app, "inspect", json!({"activity":"idle"}));
            answer(app, "idle", json!({"error":"IDENTITY_UNAVAILABLE",
                "detail":"Conversation identity is held: the native control probe did not complete."}));
        };
        let mut app = app();
        refuse(&mut app);
        assert_eq!(buttons(&app), ["Keep open", "Close pane"]);
        let Some(Modal::Menu(m)) = &app.modal else { unreachable!() };
        assert_eq!(m.buttons.as_ref().unwrap().row.chosen, 0, "Keep open is the default");
        let said = notes(&app);
        assert!(said.iter().any(|n| n.contains("the native control probe did not complete")), "{said:?}");
        assert!(said.iter().any(|n| n == "You can close this pane. The harness may still be running."), "{said:?}");
        assert!(said.iter().any(|n| n == "Task 1 · Stop not confirmed"), "{said:?}");
        key(&mut app, KeyCode::Enter);
        assert!(app.modal.is_none() && app.session_close.operation.is_none());
        assert!(app.panes.contains_key(&1), "Keep open keeps the pane");

        let mut app = self::app();
        refuse(&mut app);
        key(&mut app, KeyCode::Right);
        key(&mut app, KeyCode::Enter);
        assert_eq!(modes(&app), ["inspect", "idle"], "no stop is sent again");
        assert!(app.modal.is_none() && app.session_close.operation.is_none());
        assert!(!app.panes.contains_key(&1)); assert!(app.panes.contains_key(&2));
        assert_eq!(app.fleet.agent("local", "a1").unwrap().status, "active", "it may still be running, and stays listed");
    }

    #[tokio::test]
    async fn close_pane_after_a_failure_keeps_a_relaunched_harness_but_not_a_dropped_conversation() {
        let fail_then = |change: fn(&mut crate::fleet::Agent)| {
            let mut app = app();
            pane(&mut app, 1);
            answer(&mut app, "inspect", json!({"activity":"idle"}));
            answer(&mut app, "idle", json!({"error":"IDENTITY_UNAVAILABLE"}));
            change(app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap());
            key(&mut app, KeyCode::Right);
            key(&mut app, KeyCode::Enter);
            assert_eq!(modes(&app), ["inspect", "idle"]);
            app
        };
        // The daemon dropped a binding it could not read: the same launch, so the view closes.
        let app = fail_then(|a| a.session_id.clear());
        assert!(!app.panes.contains_key(&1));
        // Launched again under the same id: another harness, which keeps its view.
        let app = fail_then(|a| a.created_at_wire.push('x'));
        assert!(app.panes.contains_key(&1));
        assert!(app.toast.as_ref().unwrap().0.contains("changed"));
    }

    #[tokio::test]
    async fn a_view_of_an_unlisted_harness_or_one_without_a_terminal_just_closes() {
        for change in ["unlisted", "no terminal"] {
            let mut app = app();
            if change == "unlisted" { app.fleet.agents.remove(&("local".into(), "a1".into())); }
            else { app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap().terminal_available = false; }
            pane(&mut app, 1);
            assert!(app.session_close.sent.is_empty(), "{change}: nothing to stop");
            assert!(!app.panes.contains_key(&1), "{change}: its view closes");
            assert!(app.panes.contains_key(&2));
            assert!(app.modal.is_none());
        }
    }

    #[tokio::test]
    async fn the_question_says_what_needs_attention_and_what_stop_closes() {
        let mut app = app();
        pane(&mut app, 1);
        answer(&mut app, "inspect", json!({"activity":"working"}));
        let Some(Modal::Menu(m)) = &app.modal else { panic!("no question") };
        assert_eq!(m.title.to_string(), "Close pane");
        assert_eq!(notes(&app), ["1 harness is still working.", "Stopping this harness will close this pane. History will be saved.",
            "Task 1 · Working"]);
        // A whole tab: each harness that needs attention, and the tab by name.
        let mut app = self::app();
        app.tabs[0].root.as_mut().unwrap().split(1, 3, crate::layout::Dir::Horizontal);
        app.panes.insert(3, crate::pane::Pane::new(3, "local", "a2", 40, 20));
        tab(&mut app, 0);
        answer(&mut app, "inspect", json!({"activity":"needs_input"}));
        answer(&mut app, "inspect", json!({"activity":"draft"}));
        assert_eq!(notes(&app), ["2 harnesses need attention.", "Stopping all 2 harnesses will close the tab “tab-1”. History will be saved.",
            "Task 1 · Waiting for input", "Task 2 · Unsent text"]);
        assert_eq!(buttons(&app), ["Cancel", "Stop"]);
    }

    #[tokio::test]
    async fn close_tab_after_a_failure_keeps_terminals_whose_end_was_not_confirmed() {
        let mut app = app();
        app.tabs[0].root.as_mut().unwrap().split(1, 3, crate::layout::Dir::Horizontal);
        app.panes.insert(3, crate::pane::Pane::new(3, "local", "zsh", 40, 20));
        app.shells.insert(("local".into(), "zsh".into()));
        tab(&mut app, 0);
        answer(&mut app, "inspect", json!({"error":"ENGINE_UNAVAILABLE","detail":"Could not check Task 1."}));
        assert_eq!(buttons(&app), ["Keep open", "Close Tab"]);
        assert!(notes(&app).iter().any(|n| n == "You can close this tab. Some harnesses may still be running."));
        key(&mut app, KeyCode::Right);
        key(&mut app, KeyCode::Enter);
        assert_eq!(modes(&app), ["inspect"]);
        assert!(!app.panes.contains_key(&1), "the harness's view closes");
        assert!(app.panes.contains_key(&3), "the terminal keeps running: nobody agreed to end it");
    }

    #[tokio::test]
    async fn a_session_removed_before_its_ack_closes_only_its_old_view() {
        let mut app = app(); pane(&mut app, 1);
        answer(&mut app, "inspect", json!({"activity":"idle"}));
        app.fleet.agents.remove(&("local".into(), "a1".into()));
        answer(&mut app, "idle", json!({"closed":true}));
        assert!(!app.panes.contains_key(&1)); assert!(app.panes.contains_key(&2));
    }

    #[tokio::test]
    async fn a_harness_that_bound_its_first_conversation_while_stopping_is_stopped() {
        // Codex's first seconds: reviewed with no conversation; the daemon waits for the bind (agent_synced),
        // stops it (agent_deleted marks the row stopped), then answers closed.
        let mut app = app();
        app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap().session_id.clear();
        pane(&mut app, 1);
        answer(&mut app, "inspect", json!({"activity":"idle"}));
        assert_eq!(app.session_close.sent[1].1["sessionId"], "");
        let row = app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap();
        row.session_id = "codex-bound".into();
        row.status = "stopped".into();
        answer(&mut app, "idle", json!({"closed":true}));
        assert!(app.session_close.operation.is_none(), "the stop is done");
        assert!(!app.panes.contains_key(&1)); assert!(app.panes.contains_key(&2));
        assert!(app.modal.is_none());
        assert!(app.toast.as_ref().is_none_or(|t| !t.0.contains("changed")));
    }

    #[tokio::test]
    async fn another_conversation_after_a_bound_one_is_still_a_change() {
        let mut app = app();
        pane(&mut app, 1);
        answer(&mut app, "inspect", json!({"activity":"idle"}));
        app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap().session_id = "replacement".into();
        answer(&mut app, "idle", json!({"closed":true}));
        assert!(app.panes.contains_key(&1));
        assert!(app.session_close.operation.as_ref().is_some_and(|op| op.stage == Stage::Failed));
    }

    #[tokio::test]
    async fn inspecting_an_already_closed_harness_finishes_the_close() {
        let mut app = app();
        pane(&mut app, 1);
        answer(&mut app, "inspect", json!({"closed":true}));
        assert_eq!(modes(&app), ["inspect"], "nothing left to stop");
        assert!(app.session_close.operation.is_none());
        assert!(!app.panes.contains_key(&1)); assert!(app.panes.contains_key(&2));
        assert_eq!(app.fleet.agent("local", "a1").unwrap().status, "stopped");
        assert!(app.modal.is_none());
    }

    #[tokio::test]
    async fn inspecting_a_harness_already_closed_and_gone_from_the_list_finishes_the_close() {
        // Closed elsewhere, and its row removed before the inspect's answer: closed, not "changed".
        let mut app = app();
        pane(&mut app, 1);
        app.fleet.agents.remove(&("local".into(), "a1".into()));
        answer(&mut app, "inspect", json!({"closed":true}));
        assert_eq!(modes(&app), ["inspect"], "nothing left to stop");
        assert!(app.session_close.operation.is_none());
        assert!(!app.panes.contains_key(&1)); assert!(app.panes.contains_key(&2));
        assert!(app.toast.as_ref().is_none_or(|t| !t.0.contains("changed")));
        // A row gone with an inspect answering what it is doing is still a change.
        let mut app = self::app();
        pane(&mut app, 1);
        app.fleet.agents.remove(&("local".into(), "a1".into()));
        answer(&mut app, "inspect", json!({"activity":"idle"}));
        assert!(app.panes.contains_key(&1));
        assert!(app.session_close.operation.as_ref().is_some_and(|op| op.stage == Stage::Failed));
    }

    #[tokio::test]
    async fn partial_tab_stop_keeps_failed_sessions_and_other_tabs() {
        let mut app = app();
        app.tabs[0].root.as_mut().unwrap().split(1, 3, crate::layout::Dir::Horizontal);
        app.panes.insert(3, crate::pane::Pane::new(3, "local", "a2", 40, 20));
        tab(&mut app, 0);
        answer(&mut app, "inspect", json!({"activity":"idle"}));
        answer(&mut app, "inspect", json!({"activity":"idle"}));
        answer(&mut app, "idle", json!({"closed":true}));
        assert!(!app.panes.contains_key(&1));
        answer(&mut app, "idle", json!({"error":"SAVE_FAILED","detail":"Could not save the conversation"}));
        assert!(app.panes.contains_key(&2)); assert!(app.panes.contains_key(&3));
        assert_eq!(app.fleet.agent("local", "a2").unwrap().status, "active");
        assert_eq!(modes(&app), ["inspect", "inspect", "idle", "idle"]);
        assert!(matches!(&app.modal, Some(Modal::Menu(menu)) if menu.items.iter().any(|i| i.label.contains("1 stopped"))));
    }

    #[tokio::test]
    async fn default_tmux_close_keys_inspect_but_custom_confirmation_is_unchanged() {
        for button in ['x', '&'] {
            let mut app = app();
            crate::input::handle(&mut app, crossterm::event::Event::Key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL)));
            crate::input::handle(&mut app, crossterm::event::Event::Key(KeyEvent::new(KeyCode::Char(button), KeyModifiers::NONE)));
            assert_eq!(modes(&app), ["inspect"], "{button}");
        }
        let mut app = app();
        crate::commands::execute(&mut app, "confirm-before -p 'Really remove this view?' kill-pane");
        assert!(app.session_close.sent.is_empty());
        assert!(matches!(app.modal, Some(Modal::Confirm { .. })));
    }
}
