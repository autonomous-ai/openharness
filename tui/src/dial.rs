//! The dial: the Harness device, plugged into this computer by USB and served by the daemon.
//!
//! The daemon owns the cable, the microphone's words and the harnesses; a window tells it what is on
//! screen and does what the dial asks. The window's half is a handful of local frames:
//!
//!   hn → daemon   app_panes (the dial's ring: this window's panes, in pane order), app_swarms (the
//!                 windows), app_focus (the active pane), app_unread, agent_seen, voice_route_reply
//!   daemon → hn   dial_focus (turned to a harness), dial_scroll (a finger on the glass), dial_open (a
//!                 notification tapped), dial_forked, dial_swarm (a window picked), dial_status,
//!                 voice_route_request (words spoken with no harness chosen), device_focus,
//!                 device_prepare_open
//!
//! The daemon keeps one desk and says every dial frame to every window, so two windows answering it
//! fight: the desktop app's tabs and hn's replace each other on the ring, and a spoken task routed
//! in both is sent twice. So hn leads only while the desktop app is not running. With the app open,
//! the app keeps the ring, the taps and the voice, and hn follows the dial's moves while its own
//! terminal is in front.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::app::{App, Placement};
use crate::modal::{Modal, PickerKind};
use crate::theme;

/// The desktop's numbers (terminal_panel.dart), so a swipe moves hn as far as it moves the app:
/// pixels per unit of finger travel, the line those pixels are counted in, and the fling's floor
/// and decay (velocity × DECAY^seconds).
const SCALE: f32 = 2.5;
const LINE: f32 = 16.0;
const STOP: f32 = 40.0;
const DECAY: f32 = 0.002;

/// The desktop palette's line (task_palette.dart): a spoken task goes without asking only when the
/// router is this sure.
const CONFIDENT: f64 = 0.85;

pub struct Dial {
    /// Plugged in, and what it runs (dial_status).
    pub attached: bool,
    pub fw: Option<String>,
    /// A firmware update going over the cable: the version.
    pub updating: Option<String>,
    /// The desktop app is running here (it answers the dial; hn follows). Assumed until asked, so
    /// hn never takes the ring from an app it has not looked for yet.
    pub app_running: bool,
    /// Whether the desktop app has been looked for yet.
    pub checked: bool,
    /// What the daemon was last told, so each change is said once.
    sent: String,
    unread_sent: String,
    /// Finger travel not yet a whole line, and the fling after the finger lifts.
    remainder: f32,
    velocity: f32,
    fling_at: Option<Instant>,
    fling: u64,
    /// A spoken task whose picker is open: answered `sent` or `cancelled` when it goes.
    pub voice: Option<String>,
}

impl Default for Dial {
    fn default() -> Dial {
        Dial { attached: false, fw: None, updating: None, app_running: true, checked: false, sent: String::new(), unread_sent: String::new(), remainder: 0.0, velocity: 0.0, fling_at: None, fling: 0, voice: None }
    }
}

/// hn answers the dial: the desktop app is not running.
pub fn leading(app: &App) -> bool { app.dial.checked && !app.dial.app_running }

/// hn follows the dial: it leads, or its terminal is the one in front.
fn following(app: &App) -> bool { leading(app) || app.terminal_focused }

fn local_link(app: &App) -> Option<crate::daemon::Link> { app.link(&app.fleet.local_id) }

fn str_of<'a>(p: &'a Value, key: &str) -> &'a str { p.get(key).and_then(Value::as_str).unwrap_or("") }

/// A frame from this computer's daemon about the dial; false when it was not one.
pub fn on_frame(app: &mut App, ty: &str, p: &Value) -> bool {
    match ty {
        "dial_status" => status(app, p),
        "dial_focus" => { if following(app) { focus(app, str_of(p, "machineId"), str_of(p, "agentId")); } }
        "dial_open" => {
            if !following(app) { return true }
            let (machine, agent) = (str_of(p, "machineId"), str_of(p, "agentId"));
            // A question screen coming up on its own only brings forward what is already here.
            if !focus(app, machine, agent) && leading(app) && str_of(p, "reason") != "question" && !agent.is_empty() {
                app.open_agent(machine, agent, Placement::Tab);
            }
        }
        "dial_forked" => {
            if !leading(app) { return true }
            let (machine, agent, source) = (str_of(p, "machineId"), str_of(p, "agentId"), str_of(p, "sourceAgentId"));
            if agent.is_empty() { return true }
            // Beside the harness it was forked from, as the window's own fork lands.
            let placement = if !source.is_empty() && focus(app, machine, source) { Placement::Auto(None) } else { Placement::Tab };
            app.open_agent(machine, agent, placement);
        }
        "dial_swarm" => {
            if !following(app) { return true }
            let id = str_of(p, "swarmId");
            if let Some(index) = app.tabs.iter().position(|t| t.id == id) { app.select_tab(index) }
        }
        "dial_scroll" => {
            if !following(app) { return true }
            let n = |k: &str| p.get(k).and_then(Value::as_f64).unwrap_or(0.0) as f32;
            scroll(app, str_of(p, "phase"), n("dy"), n("velocity"));
        }
        // Asked of ONE window (the daemon's first), so answered whoever leads: left alone, it is lost.
        "device_focus" => {
            let expires = p.get("expiresAt").and_then(Value::as_f64).unwrap_or(0.0);
            if expires <= crate::fleet::now_ms() as f64 { return true }
            let (machine, agent) = (str_of(p, "machineId"), str_of(p, "agentId"));
            if app.focused().is_some() { app.announce_focus(); return true }
            if !focus(app, machine, agent) && !agent.is_empty() { app.open_agent(machine, agent, Placement::Auto(None)) }
            let revision = str_of(p, "focusRevision").to_string();
            if let Some(link) = app.link(machine) { link.send("app_focus", json!({ "agentId": agent, "focusRevision": revision })); }
        }
        "device_prepare_open" => {
            let (operation, machine, agent) = (str_of(p, "operationId").to_string(), str_of(p, "machineId").to_string(), str_of(p, "agentId").to_string());
            if operation.len() != 64 || agent.is_empty() || machine != app.fleet.local_id { return true }
            if !focus(app, &machine, &agent) { app.open_agent(&machine, &agent, Placement::Auto(None)) }
            if let Some(link) = local_link(app) { link.send("device_prepare_opened", json!({ "operationId": operation, "agentId": agent })); }
        }
        "voice_route_request" => { if leading(app) { voice(app, p) } }
        _ => return false,
    }
    true
}

fn status(app: &mut App, p: &Value) {
    let attached = p.get("attached").and_then(Value::as_bool).unwrap_or(false);
    let text = |k: &str| p.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let updating = text("updating");
    if updating.is_some() && updating != app.dial.updating {
        app.say(format!("The dial is updating to {} — leave it plugged in", updating.clone().unwrap_or_default()), theme::WARN);
    } else if updating.is_none() && app.dial.updating.is_some() && attached {
        app.say("The dial is up to date", theme::ONLINE);
    }
    app.dial.attached = attached;
    app.dial.fw = text("fw");
    app.dial.updating = updating;
}

/// Bring a harness's pane forward: its window, then the pane. A zoomed window stays zoomed on the
/// new pane (select-pane -Z), so the dial flips through panes full size. False when hn has none.
pub fn focus(app: &mut App, machine: &str, agent: &str) -> bool {
    let Some((tab, pane)) = app.find_pane(machine, agent) else { return false };
    if tab == app.active && app.focused() == Some(pane) { return true }
    // Copy mode belongs to the pane it was on; moving away ends it, as a focus change does in hn.
    if let Some(Modal::Copy { pane: was }) = app.modal {
        if was != pane { if let Some(p) = app.panes.get_mut(&was) { p.copy_end() } app.modal = None }
    }
    let zoomed = app.tabs[tab].zoomed;
    app.focus_pane(tab, pane);
    if zoomed && !app.tabs[tab].zoomed { app.tabs[tab].zoomed = true; app.fit_panes() }
    true
}

// ── the ring ────────────────────────────────────────────────────────────────

/// Tell the daemon what the dial turns through — this window's panes in pane order — and the
/// windows it can pick from. Said on change ([force]: again, as after a reconnect).
pub fn announce(app: &mut App, force: bool) {
    if !leading(app) { return }
    let Some(link) = local_link(app) else { return };
    let ids = |tab: &crate::app::Tab| -> Vec<String> { tab.panes().iter().filter_map(|id| app.panes.get(id)).map(|p| p.agent_id.clone()).collect() };
    let ring = ids(app.tab());
    let swarms: Vec<Value> = app.tabs.iter().map(|t| json!({ "id": t.id, "name": t.name, "agentIds": ids(t), "panes": t.panes().len() })).collect();
    let panes = json!({ "agentIds": ring, "foreground": app.terminal_focused });
    let tabs = json!({ "active": app.tab().id, "swarms": swarms });
    let said = format!("{panes}{tabs}");
    if !force && said == app.dial.sent { return }
    // The ring first: a focus for a pane the dial's ring does not hold yet is dropped on the device.
    if link.send("app_panes", panes) && link.send("app_swarms", tabs) { app.dial.sent = said }
}

/// What the dial's drawer should hold when it comes back from a reboot: every harness here with a
/// finished turn not yet looked at, or a question, newest first.
fn announce_unread(app: &mut App) {
    if !leading(app) { return }
    let Some(link) = local_link(app) else { return };
    let mine: Vec<(String, String)> = app.panes.values().map(|p| (p.machine_id.clone(), p.agent_id.clone())).collect();
    let mut marks: Vec<&crate::fleet::Agent> = app.fleet.agents.values().filter(|a| (a.unread || a.question.is_some()) && mine.contains(&a.key())).collect();
    marks.sort_by_key(|a| std::cmp::Reverse(a.active_at));
    let items: Vec<Value> = marks.iter().map(|a| json!({ "agentId": a.id, "machineId": a.machine_id, "question": a.question.is_some(), "text": a.question.as_ref().map(|q| q.prompt.clone()).unwrap_or_default() })).collect();
    let said = Value::from(items.clone()).to_string();
    if said == app.dial.unread_sent { return }
    if link.send("app_unread", json!({ "items": items })) { app.dial.unread_sent = said }
}

/// A harness was looked at here: the dial's notification for it is stale.
pub fn seen(app: &App, agent: &str) {
    if let Some(link) = local_link(app) { link.send("agent_seen", json!({ "agentId": agent })); }
}

/// The daemon forgot what this connection said (it reconnected): say it all again.
pub fn reconnected(app: &mut App) {
    app.dial.sent.clear();
    app.dial.unread_sent.clear();
}

/// Every tick: the ring and the drawer as they are now; every few seconds, whether the desktop app
/// is running — hn takes the dial when it goes, and leaves it when it comes.
pub fn tick(app: &mut App) {
    if app.tick % 20 == 1 { check_app(app) }
    announce(app, false);
    announce_unread(app);
    settle_voice(app);
}

fn check_app(app: &mut App) {
    if let Ok(v) = std::env::var("HN_DESKTOP") { set_app_running(app, v == "on"); return }
    app.spawn(async { app_running().await }, set_app_running);
}

fn set_app_running(app: &mut App, running: bool) {
    let first = !app.dial.checked;
    app.dial.checked = true;
    if running == app.dial.app_running && !first { return }
    app.dial.app_running = running;
    if !running { reconnected(app); announce(app, true); app.announce_focus() }
}

/// The desktop app's process: `Harness` (the macOS bundle's executable), `harness` on Linux.
async fn app_running() -> bool {
    let name = if cfg!(target_os = "macos") { "Harness" } else { "harness" };
    tokio::process::Command::new("pgrep").args(["-x", name]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .status().await.map(|s| s.success()).unwrap_or(false)
}

// ── scrolling ───────────────────────────────────────────────────────────────

/// A finger on the glass: `down` stops a fling, `move` carries travel, `up` may throw one.
pub fn scroll(app: &mut App, phase: &str, dy: f32, velocity: f32) {
    if phase == "down" { app.dial.fling += 1; app.dial.fling_at = None; app.dial.remainder = 0.0 }
    if dy != 0.0 { travel(app, -dy * SCALE) }
    if phase == "up" && velocity.abs() >= STOP {
        app.dial.fling += 1;
        app.dial.velocity = velocity;
        app.dial.fling_at = Some(Instant::now());
        let generation = app.dial.fling;
        step_later(app, generation);
    }
}

fn step_later(app: &App, generation: u64) {
    app.spawn(async { tokio::time::sleep(Duration::from_millis(16)).await }, move |app, _| fling_step(app, generation));
}

fn fling_step(app: &mut App, generation: u64) {
    let Some(at) = app.dial.fling_at.filter(|_| app.dial.fling == generation) else { return };
    let dt = at.elapsed().as_secs_f32().min(0.05);
    app.dial.fling_at = Some(Instant::now());
    let v = app.dial.velocity;
    travel(app, -v * dt * SCALE);
    app.dial.velocity = v * DECAY.powf(dt);
    if app.dial.velocity.abs() < STOP { app.dial.fling_at = None; return }
    step_later(app, generation);
}

/// Pixels of travel (negative: up, toward older lines), spent a whole line at a time.
fn travel(app: &mut App, px: f32) {
    app.dial.remainder += px;
    let lines = (app.dial.remainder / LINE).trunc() as i32;
    if lines == 0 { return }
    app.dial.remainder -= lines as f32 * LINE;
    crate::input::scroll_by(app, -lines);
}

// ── spoken tasks ────────────────────────────────────────────────────────────

/// Words spoken with no harness chosen: taken at once, routed as `send-task` routes typed ones, sent
/// without asking only when the router is sure, else put to you in the picker.
fn voice(app: &mut App, p: &Value) {
    let (id, words) = (str_of(p, "voiceId").to_string(), str_of(p, "text").trim().to_string());
    let Some(link) = local_link(app) else { return };
    if id.is_empty() || words.is_empty() { return }
    link.send("voice_route_reply", json!({ "voiceId": id, "state": "taken" }));
    let cmd = str_of(p, "cmd").trim().trim_start_matches('/').to_string();
    let text = if cmd.is_empty() { words.clone() } else { format!("/{cmd} {words}") };
    let asked = words.clone();
    app.spawn(async move { link.request("route_task", json!({ "text": asked }), Duration::from_secs(60)).await }, move |app, reply| {
        let reply = match reply { Ok((_, r)) => r, Err(e) => { voice_reply(app, &id, None); app.say(format!("Could not route “{words}”: {e}"), theme::DANGER); return } };
        let best = reply.get("agentId").and_then(Value::as_str).unwrap_or("").to_string();
        let machine = reply.get("machineId").and_then(Value::as_str).unwrap_or("").to_string();
        let sure = reply.get("confidence").and_then(Value::as_f64).unwrap_or(0.0) >= CONFIDENT;
        if sure && !best.is_empty() {
            send_spoken(app, &id, &machine, &best, &text);
            return;
        }
        let rows = crate::modal::route_rows(&reply);
        if rows.is_empty() {
            voice_reply(app, &id, None);
            app.say(format!("No harness fits “{words}”"), theme::MUTED);
            return;
        }
        let mut picker = crate::picker::Picker::new(format!("Send: {}", words.chars().take(48).collect::<String>()), "Filter…");
        picker.keep_order = true;
        picker.set_rows(rows);
        picker.hints = vec![("enter", "send")];
        app.toast = None;
        app.dial.voice = Some(id.clone());
        app.modal = Some(Modal::Picker { kind: PickerKind::Route { text, voice: Some(id) }, picker });
        if !app.terminal_focused { crate::bell() }
    });
}

/// Deliver a spoken task and tell the daemon where it went.
pub fn send_spoken(app: &mut App, voice_id: &str, machine: &str, agent: &str, text: &str) {
    if app.dial.voice.as_deref() == Some(voice_id) { app.dial.voice = None }
    let Some(link) = app.link(machine) else { voice_reply(app, voice_id, None); return };
    link.send("message", json!({ "agentId": agent, "content": text }));
    voice_reply(app, voice_id, Some(agent));
    let name = app.fleet.agent(machine, agent).map(|a| a.name.clone()).unwrap_or_default();
    app.say(format!("Sent to {name}: {text}"), theme::ONLINE);
}

/// `sent` (to [agent]) or `cancelled`.
fn voice_reply(app: &App, voice_id: &str, agent: Option<&str>) {
    let Some(link) = local_link(app) else { return };
    let reply = match agent { Some(a) => json!({ "voiceId": voice_id, "state": "sent", "agentId": a }), None => json!({ "voiceId": voice_id, "state": "cancelled" }) };
    link.send("voice_route_reply", reply);
}

/// A spoken task's picker that went away without a choice (esc, or another list over it) was
/// cancelled: the dial is told rather than left waiting out its minute.
pub fn settle_voice(app: &mut App) {
    let Some(id) = app.dial.voice.clone() else { return };
    let open = matches!(&app.modal, Some(Modal::Picker { kind: PickerKind::Route { voice: Some(v), .. }, .. }) if *v == id);
    if open { return }
    app.dial.voice = None;
    voice_reply(app, &id, None);
}
