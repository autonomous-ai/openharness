//! The pair brain's frames (daemons/BRAIN.md, cli/src/pair/protocol.ts), heard only from this
//! computer's harnessd and answered only over its Unix socket.
//!
//! In: `daemon_state` (the face's inputs across every machine), `daemon_say` (a line, keys first),
//! `daemon_unsay`, `daemon_brief`, and the results of what hn sends. Out: `daemon_shown` once a line
//! and everything a key on it would act on (its `detail`) are on screen, `daemon_act`,
//! `daemon_confirm`, `daemon_talk` and `daemon_presence`.
//!
//! A line takes over the status line as tmux's display-message does, for its `ttlMs`. Its keys go
//! through the daemon key table (`C-b Z` then y, n, g or s) and count only while it shows, 400 ms
//! after hn said it drew it — until then they are drawn faint and do nothing. A line whose detail
//! (the exact command, diff, prompt or lesson) has not been on screen opens it first: the key counts
//! once the person has seen what it does.

use std::time::{Duration, Instant};

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use serde_json::{json, Value};

use crate::app::App;
use crate::daemon::{Link, RpcError};

/// A key arms this long after hn said it drew the line (BRAIN.md: at least 400 ms before the key).
pub const ARM: Duration = Duration::from_millis(400);
/// At most one line nobody asked for every two minutes.
pub const UNSOLICITED_EVERY: Duration = Duration::from_secs(120);
/// A line waits for a pause at most this long, then is dropped.
pub const WAIT_AT_MOST: Duration = Duration::from_secs(20);
/// Without Enter or a pane switch, this long without a key is a pause.
pub const QUIET_KEYS: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, PartialEq)]
pub struct Action { pub key: char, pub label: String, pub choice: String }

#[derive(Clone, Debug)]
pub struct Line {
    pub id: String,
    pub mood: String,
    pub text: String,
    pub actions: Vec<Action>,
    pub detail: Option<String>,
    pub from_pair: bool,
    /// A setting waiting for the person's yes: (kind, nonce), answered with daemon_confirm.
    pub confirm: Option<(String, String)>,
    /// `name@machine`, for a proposal.
    pub harness: Option<String>,
    /// (machineId, agentId) the line is about — what g opens, and never the pane in front.
    pub about: Option<(String, String)>,
    pub arrived: Instant,
    pub until: Instant,
    /// On screen at least once (the status line or the brief drew it).
    pub drawn: bool,
    /// Its detail has been on screen in full.
    pub detail_seen: bool,
    /// When hn said `daemon_shown`.
    pub shown_at: Option<Instant>,
    /// Came from hn itself (a reply, an error): never acknowledged, no keys.
    pub local: bool,
}

impl Line {
    pub fn keyed(&self) -> bool { !self.local && (!self.actions.is_empty() || self.confirm.is_some()) }
    pub fn live(&self) -> bool { Instant::now() < self.until }
    pub fn armed(&self) -> bool { self.shown_at.map(|t| t.elapsed() >= ARM).unwrap_or(false) }
    pub fn has_key(&self, k: char) -> bool { self.actions.iter().any(|a| a.key == k) || (self.confirm.is_some() && matches!(k, 'y' | 'n')) }
    /// Loud lines take the message line's yellow: something needs you, failed, or asks.
    pub fn loud(&self) -> bool { matches!(self.mood.as_str(), "need" | "fail" | "ask") || self.confirm.is_some() }
    /// The keys first, as the line is shown: `[y/n/g] `.
    pub fn keys(&self) -> String {
        let mut ks: Vec<char> = ['y', 'n', 's', 'g'].into_iter().filter(|k| self.actions.iter().any(|a| a.key == *k)).collect();
        if self.confirm.is_some() { for k in ['y', 'n'] { if !ks.contains(&k) { ks.push(k) } } ks.sort_by_key(|k| "ynsg".find(*k)); }
        if ks.is_empty() { String::new() } else { format!("[{}] ", ks.iter().map(char::to_string).collect::<Vec<_>>().join("/")) }
    }
    /// The words after the keys (the brain sends them keys first already; an older one might not).
    pub fn words(&self) -> String {
        let k = self.keys();
        if !k.is_empty() && self.text.starts_with(&k) { self.text[k.len()..].to_string() } else { self.text.clone() }
    }
}

/// A `daemon_say` (or a brief's item) as a line.
pub fn line_from(p: &Value, now: Instant) -> Option<Line> {
    let s = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_string);
    let id = s("id")?;
    let actions = p.get("actions").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| {
        let key = x.get("key").and_then(Value::as_str)?.chars().next()?;
        Some(Action { key, label: x.get("label").and_then(Value::as_str).unwrap_or("").to_string(), choice: x.get("choice").and_then(Value::as_str).unwrap_or(&key.to_string()).to_string() })
    }).filter(|a| matches!(a.key, 'y' | 'n' | 's' | 'g')).collect()).unwrap_or_default();
    let from_pair = s("from").as_deref() == Some("pair");
    let confirm = p.get("confirm").and_then(|c| Some((c.get("kind")?.as_str()?.to_string(), c.get("nonce")?.as_str()?.to_string())));
    let harness = p.get("harness").and_then(|h| { let name = h.get("name")?.as_str()?; Some(match h.get("machine").and_then(Value::as_str) { Some(m) if !m.is_empty() => format!("{name}@{m}"), _ => name.to_string() }) });
    let about = p.get("about").and_then(|a| Some((a.get("machineId")?.as_str()?.to_string(), a.get("agentId")?.as_str()?.to_string()))).filter(|(_, a)| !a.is_empty())
        .or_else(|| Some((s("machineId")?, s("agentId")?)));
    let ttl = p.get("ttlMs").and_then(Value::as_u64).unwrap_or(5200);
    // The pair's `say` never carries a key, whatever it sends (BRAIN.md "Security" 5).
    let mood = s("mood").unwrap_or_else(|| "need".into());
    let actions = if from_pair && mood == "say" { Vec::new() } else { actions };
    Some(Line { id, mood, text: crate::daemon::hooks::printable(&s("line").unwrap_or_default()), actions, detail: s("detail").filter(|d| !d.is_empty()), from_pair, confirm, harness, about,
        arrived: now, until: now + Duration::from_millis(ttl), drawn: false, detail_seen: false, shown_at: None, local: false })
}

pub struct Brief { pub line: String, pub items: Vec<Line>, pub until: Instant }

#[derive(Default)]
pub struct Brain {
    /// The last `daemon_state` (Null before one).
    pub state: Value,
    /// The line on the status line.
    pub line: Option<Line>,
    /// Lines nobody asked for, waiting for a pause.
    pub waiting: Vec<Line>,
    pub last_unsolicited: Option<Instant>,
    pub brief: Option<Brief>,
    /// The back line of the last return (the brief's header).
    pub back: Option<String>,
    pub replies: u64,
}

fn local_link(app: &App) -> Option<Link> { app.link(&app.fleet.local_id) }

/// A reply of hn's own, dim in the status line (a talk's answer, why a key did nothing).
pub fn reply(app: &mut App, text: impl Into<String>) {
    let now = Instant::now();
    // A keyed line keeps its place: the reply is tmux's message instead.
    if app.daemons.brain.line.as_ref().map(|l| l.keyed() && l.live()).unwrap_or(false) { app.say(text.into(), crate::theme::WARN); return }
    app.daemons.brain.replies += 1;
    let id = format!("local:{}", app.daemons.brain.replies);
    app.daemons.brain.line = Some(Line { id, mood: "say".into(), text: text.into(), actions: Vec::new(), detail: None, from_pair: false, confirm: None, harness: None, about: None,
        arrived: now, until: now + Duration::from_millis(5200), drawn: false, detail_seen: false, shown_at: None, local: true });
    wake(app, 5250);
}

/// A redraw in `ms` (a line's end, a key arming, a blink's frame).
pub fn wake(app: &App, ms: u64) {
    if app.headless { return }
    app.spawn(async move { tokio::time::sleep(Duration::from_millis(ms)).await }, |_, _| {});
}

/// A frame from this computer's harnessd; true when it was the brain's.
pub fn on_frame(app: &mut App, ty: &str, p: &Value) -> bool {
    match ty {
        "daemon_state" => { state(app, p); true }
        "daemon_say" => { if let Some(line) = line_from(p, Instant::now()) { said(app, line) } true }
        "daemon_unsay" => {
            let id = p.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            unsay(app, &id);
            true
        }
        "daemon_brief" => { brief(app, p); true }
        // Results reach the request that asked (daemon::Link); one that comes late is dropped.
        "daemon_act_result" | "daemon_confirm_result" | "daemon_talk_result" | "daemon_plate" | "daemon_plate_get_result" => true,
        _ => false,
    }
}

/// `daemon_state`, pushed when a window attaches and whenever pairing, the paired daemon, the dial or
/// the daemons switch changes — unasked. `pair: null` is the brain not thinking (nothing paired, no
/// consent, or the daemons switched off): its lines and brief go (their keys would answer PAIR_OFF),
/// and, when it was thinking a moment ago, the zoo is read again — an off switch shows there.
fn state(app: &mut App, p: &Value) {
    let was = app.daemons.brain.state.get("pair").map(|v| !v.is_null()).unwrap_or(false);
    app.daemons.brain.state = p.clone();
    if p.get("pair").map(Value::is_null).unwrap_or(true) {
        let b = &mut app.daemons.brain;
        if b.line.as_ref().map(|l| !l.local).unwrap_or(false) { b.line = None }
        b.waiting.clear();
        b.brief = None;
        if matches!(app.daemons.overlay, Some(super::overlay::Overlay::Detail { keyed: true, .. })) { app.daemons.overlay = None }
        if was { super::hooks::fetch(app) }
    }
}

pub fn unsay(app: &mut App, id: &str) {
    let b = &mut app.daemons.brain;
    if b.line.as_ref().map(|l| l.id == id).unwrap_or(false) { b.line = None }
    b.waiting.retain(|l| l.id != id);
    if let Some(brief) = b.brief.as_mut() { brief.items.retain(|l| l.id != id) }
    if matches!(&app.daemons.overlay, Some(super::overlay::Overlay::Detail { id: d, .. }) if d == id) { app.daemons.overlay = None }
}

/// The pane in front: (machine, agent).
pub fn focused(app: &App) -> Option<(String, String)> {
    app.focused().and_then(|f| app.panes.get(&f)).map(|p| (p.machine_id.clone(), p.agent_id.clone()))
}

/// A `daemon_say`, by its mood (BRAIN.md "As built"; desktop/design/daemons.md "The pair brain").
fn said(app: &mut App, line: Line) {
    let now = Instant::now();
    // The same id again: the line replaced in place (the model's words), with the time now left.
    if let Some(cur) = app.daemons.brain.line.as_mut().filter(|l| l.id == line.id) {
        let (drawn, seen, shown) = (cur.drawn, cur.detail_seen && cur.detail == line.detail, cur.shown_at);
        *cur = Line { drawn, detail_seen: seen, shown_at: shown, ..line };
        let ms = cur.until.saturating_duration_since(now).as_millis() as u64;
        wake(app, ms + 50);
        return;
    }
    match line.mood.as_str() {
        // A return: the wave and the brief carry it, never a line.
        "back" => {
            app.daemons.brain.back = Some(line.text.clone());
            app.daemons.hold("back");
            app.daemons.blink("slow");
        }
        // Something needs you, failed, or a rule or the pair acted: a line nobody asked for.
        "need" | "fail" | "auto" => {
            if line.mood == "auto" { app.daemons.hold("done") }
            app.daemons.blink("ack");
            if app.daemons.quiet(app) { return }
            if app.daemons.napping() && line.mood != "need" { return }
            if line.about.is_some() && line.about == focused(app).filter(|_| app.terminal_focused) { return }
            if app.daemons.brain.last_unsolicited.map(|t| t.elapsed() < UNSOLICITED_EVERY).unwrap_or(false) { return }
            app.daemons.brain.waiting.retain(|l| l.id != line.id);
            app.daemons.brain.waiting.push(line);
            release(app);
            wake(app, QUIET_KEYS.as_millis() as u64 + 50);
        }
        // A proposal, a lesson or a setting waiting for a yes: at once, even mid-thought — its keys
        // are short-lived. The pair talking, or a setting that changed: a dim reply, at once.
        _ => { show(app, line) }
    }
}

fn show(app: &mut App, line: Line) {
    let ms = line.until.saturating_duration_since(Instant::now()).as_millis() as u64;
    // Something that needs you, said with its keys: it takes the place of hn's own notice.
    if line.loud() { app.toast = None }
    app.daemons.brain.line = Some(line);
    wake(app, ms + 50);
}

/// A waiting line speaks at a pause: after Enter or a pane switch, or 8 s without a key — never
/// while a dialog, a list or the daemon's own popup is open.
pub fn release(app: &mut App) {
    let now = Instant::now();
    app.daemons.brain.waiting.retain(|l| now.duration_since(l.arrived) < WAIT_AT_MOST && l.live());
    if app.daemons.brain.waiting.is_empty() { return }
    if app.modal.is_some() || app.daemons.overlay.is_some() || app.prefix || app.key_table.is_some() { return }
    if app.daemons.brain.line.as_ref().map(|l| l.live() && l.keyed()).unwrap_or(false) { return }
    let first = &app.daemons.brain.waiting[0];
    let paused = app.daemons.pause_at.map(|p| p >= first.arrived).unwrap_or(false) || app.daemons.last_key.elapsed() >= QUIET_KEYS;
    if !paused { return }
    let line = app.daemons.brain.waiting.remove(0);
    // Never about the pane in front, even if it came to the front while the line waited.
    if line.about.is_some() && line.about == focused(app).filter(|_| app.terminal_focused) { return }
    app.daemons.brain.last_unsolicited = Some(now);
    show(app, line);
}

fn brief(app: &mut App, p: &Value) {
    let now = Instant::now();
    let items: Vec<Line> = p.get("items").and_then(Value::as_array).map(|a| a.iter().enumerate().filter_map(|(i, item)| {
        let mut item = item.clone();
        if item.get("id").is_none() { item["id"] = json!(format!("brief-item:{i}")) }
        // Its text (a lesson's) is its detail.
        if item.get("detail").is_none() { if let Some(t) = item.get("text").cloned() { item["detail"] = t } }
        line_from(&item, now)
    }).collect()).unwrap_or_default();
    let kinds: Vec<&str> = p.get("items").and_then(Value::as_array).map(|a| a.iter().filter_map(|i| i.get("kind").and_then(Value::as_str)).collect()).unwrap_or_default();
    // A lesson's `[s]`: its text in full.
    if kinds == ["lesson"] {
        if let Some(item) = items.into_iter().next() {
            let text = item.detail.clone().unwrap_or(item.text.clone());
            app.daemons.overlay = Some(super::overlay::Overlay::Detail { id: item.id.clone(), title: "the lesson, in full".into(), text, top: 0, keyed: false });
        }
        return;
    }
    let keyed = items.iter().any(Line::keyed);
    let line = p.get("line").and_then(Value::as_str).map(str::to_string).or(app.daemons.brain.back.clone()).unwrap_or_default();
    let until = now + if keyed { Duration::from_secs(60) } else { Duration::from_secs(10) };
    let items = items.into_iter().map(|mut l| { l.until = until; l }).collect();
    app.daemons.brain.brief = Some(Brief { line, items, until });
    wake(app, until.saturating_duration_since(now).as_millis() as u64 + 50);
}

/// The line a key answers: the one on the status line, else the brief's first keyed item.
fn target(app: &App) -> Option<Line> {
    let b = &app.daemons.brain;
    if let Some(l) = b.line.as_ref().filter(|l| l.live() && l.keyed()) { return Some(l.clone()) }
    b.brief.as_ref().filter(|br| Instant::now() < br.until).and_then(|br| br.items.iter().find(|l| l.keyed()).cloned())
}

fn with_line(app: &mut App, id: &str, f: impl FnOnce(&mut Line)) {
    let b = &mut app.daemons.brain;
    if let Some(l) = b.line.as_mut().filter(|l| l.id == id) { return f(l) }
    if let Some(l) = b.brief.as_mut().and_then(|br| br.items.iter_mut().find(|l| l.id == id)) { f(l) }
}

/// A line, or a brief's items, on screen: acknowledge each keyed one whose detail has been seen.
pub fn drawn(app: &mut App, id: &str) {
    let mut ack = false;
    with_line(app, id, |l| { if !l.drawn { l.drawn = true } ack = l.keyed() && l.shown_at.is_none() && (l.detail.is_none() || l.detail_seen) });
    if ack {
        // After this frame reaches the terminal: the next turn of the loop.
        let id = id.to_string();
        app.spawn(async move { tokio::time::sleep(Duration::from_millis(5)).await }, move |app, _| shown(app, &id));
    }
}

/// Its detail was on screen in full.
pub fn detail_seen(app: &mut App, id: &str) {
    let mut ack = false;
    with_line(app, id, |l| { l.detail_seen = true; ack = l.keyed() && l.shown_at.is_none() });
    if ack { let id = id.to_string(); app.spawn(async move { tokio::time::sleep(Duration::from_millis(5)).await }, move |app, _| shown(app, &id)); }
}

/// `daemon_shown { id }`, over the socket: the line and its detail are on screen.
fn shown(app: &mut App, id: &str) {
    let Some(link) = local_link(app) else { return };
    if !link.over_socket() { return }
    let mut send = false;
    with_line(app, id, |l| { if l.shown_at.is_none() { l.shown_at = Some(Instant::now()); send = true } });
    if send && link.send("daemon_shown", json!({ "id": id })) { wake(app, ARM.as_millis() as u64 + 20) }
}

/// A key in the daemon table (or the detail popup): y, n, s or g on the line that shows.
pub fn key(app: &mut App, k: char) {
    let Some(line) = target(app) else { return reply(app, "nothing to answer") };
    if k == 'g' {
        // The window's own: the harness opens here; nothing is typed.
        if let Some((m, a)) = line.about.clone() { app.daemons.overlay = None; app.open_agent(&m, &a, crate::app::Placement::Tab) } else { reply(app, "that line is about no harness") }
        return;
    }
    if !line.has_key(k) { return reply(app, format!("{} offers no [{k}]", line.keys().trim())) }
    // What the key does, in full, before it may count.
    if line.detail.is_some() && !line.detail_seen {
        open_detail(app, &line);
        return;
    }
    if !line.armed() {
        if line.shown_at.is_none() { drawn(app, &line.id) }
        return reply(app, "a moment — its keys arm once it has been on screen");
    }
    let Some(link) = local_link(app) else { return reply(app, "harnessd is not connected") };
    if !link.over_socket() { return reply(app, "keys need harnessd's socket (this hn reaches it over TCP)") }
    let id = line.id.clone();
    if let Some((kind, nonce)) = line.confirm.clone() {
        let accept = k == 'y';
        let line_id = id.clone();
        app.spawn(async move { link.request("daemon_confirm", json!({ "id": id, "kind": kind, "nonce": nonce, "accept": accept }), Duration::from_secs(20)).await }, move |app, r| result(app, r, "confirm", &line_id));
        return;
    }
    let choice = line.actions.iter().find(|a| a.key == k).map(|a| a.choice.clone()).unwrap_or(k.to_string());
    let line_id = id.clone();
    app.spawn(async move { link.request("daemon_act", json!({ "id": id, "choice": choice }), Duration::from_secs(30)).await }, move |app, r| result(app, r, "act", &line_id));
}

fn open_detail(app: &mut App, line: &Line) {
    let title = match (&line.harness, line.mood.as_str()) {
        _ if line.id.starts_with("lesson:") => "the lesson, in full".to_string(),
        _ if line.confirm.is_some() => "what a yes turns on".to_string(),
        (Some(h), _) => format!("{h} · exactly what a key does"),
        (None, _) => "exactly what a key does".to_string(),
    };
    app.daemons.overlay = Some(super::overlay::Overlay::Detail { id: line.id.clone(), title, text: line.detail.clone().unwrap_or_default(), top: 0, keyed: true });
}

/// Open a line's detail on demand (the table's `d`).
pub fn detail(app: &mut App) {
    match target(app).or_else(|| app.daemons.brain.line.clone().filter(|l| l.live() && l.detail.is_some())) {
        Some(l) if l.detail.is_some() => open_detail(app, &l),
        _ => reply(app, "no detail on this line"),
    }
}

/// Esc in the table: the line goes (nothing answered; the brain keeps what waits).
pub fn dismiss(app: &mut App) {
    app.daemons.brain.line = None;
    app.daemons.brain.brief = None;
}

fn worded(code: &str, detail: &str) -> String {
    match code {
        "LOCAL_SOCKET_REQUIRED" => "keys need harnessd's socket, not its TCP port".into(),
        "UI_ONLY" => "only a window on this computer answers that".into(),
        "NOT_SHOWN" | "TOO_SOON" => "a moment — press it again".into(),
        "PERSON_ONLY" | "INSIDE_HARNESS" => "only you teach a lesson, from a window outside a harness".into(),
        "PAIR_OFF" => "pairing is off".into(),
        "GONE" => "that harness or question is gone".into(),
        "STALE_QUESTION" => "the question changed — nothing typed".into(),
        "DENY_CLASS" => "that one is yours to answer, in the harness".into(),
        "NOT_ALLOW_CLASS" | "NOT_OFFERED" | "PERSISTENT" => "not a key this line offers".into(),
        "AUTONOMY_WATCH" => "at watch it only tells you".into(),
        "RATE_LIMITED" => "too many — wait a moment".into(),
        "REMOTE_ANSWERS_ONLY" => "another machine only takes answers".into(),
        "STALE_CONFIRM" => "no longer waiting".into(),
        "UNSUPPORTED" => "this harnessd has no pair brain".into(),
        _ if !detail.is_empty() => format!("{code}: {detail}"),
        _ => code.to_string(),
    }
}

fn result(app: &mut App, r: Result<(String, Value), RpcError>, what: &str, id: &str) {
    let p = match r { Ok((_, p)) => p, Err(e) => return reply(app, e.to_string()) };
    let id = id.to_string();
    if p.get("ok").and_then(Value::as_bool) != Some(true) {
        let code = p.get("error").and_then(Value::as_str).unwrap_or("FAILED").to_string();
        if code == "DAEMONS_OFF" { return super::hooks::daemons_off(app) }
        // A new connection, or a key a little early: acknowledge again, and it re-arms.
        if matches!(code.as_str(), "NOT_SHOWN" | "TOO_SOON") { with_line(app, &id, |l| l.shown_at = None); drawn(app, &id) }
        return reply(app, worded(&code, p.get("detail").and_then(Value::as_str).unwrap_or("")));
    }
    // Answered: the line goes, and the next line nobody asked for may come sooner.
    unsay(app, &id);
    app.daemons.brain.last_unsolicited = None;
    if matches!(app.daemons.overlay, Some(super::overlay::Overlay::Detail { keyed: true, .. })) { app.daemons.overlay = None }
    if what == "confirm" { return reply(app, if p.get("accepted").and_then(Value::as_bool) == Some(true) { "yes — it is on" } else { "kept as it is" }) }
    if let Some(text) = p.get("lesson").and_then(Value::as_str) {
        app.daemons.overlay = Some(super::overlay::Overlay::Detail { id, title: "the lesson, in full".into(), text: text.to_string(), top: 0, keyed: false });
        return;
    }
    if p.get("learned").is_some() { return reply(app, "taught: your agents have it now") }
    if p.get("skipped").is_some() { return reply(app, "skipped") }
    if let (Some(m), Some(a)) = (p.pointer("/open/machineId").and_then(Value::as_str), p.pointer("/open/agentId").and_then(Value::as_str)) {
        let (m, a) = (m.to_string(), a.to_string());
        app.open_agent(&m, &a, crate::app::Placement::Tab);
    }
}

/// `daemon_talk`: the person's words to their daemon (the pair harness).
pub fn talk(app: &mut App, text: &str) {
    let text = text.trim().to_string();
    if text.is_empty() { return reply(app, "say something") }
    let Some(link) = local_link(app) else { return reply(app, "harnessd is not connected") };
    if !link.over_socket() { return reply(app, "talking needs harnessd's socket (this hn reaches it over TCP)") }
    let name = app.daemons.name();
    reply(app, format!("to {name}: {text}"));
    app.spawn(async move { link.request("daemon_talk", json!({ "text": text }), Duration::from_secs(60)).await }, move |app, r| {
        let p = match r { Ok((_, p)) => p, Err(e) => return reply(app, e.to_string()) };
        let cost = p.get("cost").and_then(Value::as_str).map(|c| format!(" — {c}")).unwrap_or_default();
        if p.get("ok").and_then(Value::as_bool) == Some(true) {
            let how = if p.get("started").is_some() { "waking (a new conversation)" } else if p.get("resumed").is_some() { "resuming" } else { "reached" };
            return reply(app, format!("{name}: {how}{cost}"));
        }
        let code = p.get("error").and_then(Value::as_str).unwrap_or("FAILED");
        if code == "DAEMONS_OFF" { return super::hooks::daemons_off(app) }
        let again = p.get("retryAfterMs").and_then(Value::as_u64).map(|ms| format!(" — again in {}s", ms.div_ceil(1000))).unwrap_or_default();
        reply(app, format!("{}{again}", worded(code, p.get("detail").and_then(Value::as_str).unwrap_or(""))))
    });
}

/// The line over the status line, as tmux's display-message draws a message: the keys first (faint
/// until they arm), the pair's words after its nick. False when there is none to draw.
pub fn draw_line(buf: &mut Buffer, app: &mut App, rect: Rect) -> bool {
    let Some(line) = app.daemons.brain.line.clone() else { return false };
    if !line.live() { app.daemons.brain.line = None; return false }
    let base = if line.loud() { app.message_style() } else { app.status_style() };
    let body = if line.loud() { base } else { base.add_modifier(Modifier::DIM) };
    buf.set_style(rect, base);
    let width = rect.width as usize;
    let mut x = rect.x;
    let mut put = |buf: &mut Buffer, text: &str, st: Style| {
        let room = (rect.x as usize + width).saturating_sub(x as usize);
        if room == 0 { return }
        let t: String = text.chars().take(room).collect();
        buf.set_stringn(x, rect.y, &t, room, st);
        x += t.chars().count() as u16;
    };
    let keys = line.keys();
    if !keys.is_empty() { put(buf, &keys, if line.armed() { base.add_modifier(Modifier::BOLD) } else { base.add_modifier(Modifier::DIM) }) }
    if line.from_pair { put(buf, &format!("<{}> ", app.daemons.name()), base.add_modifier(Modifier::BOLD)) }
    put(buf, &line.words(), body);
    // Where the keys are, right-aligned when there is room.
    if line.keyed() {
        let prefix = app.keymap.key_for_name("switch-client -T daemon").unwrap_or_else(|| "C-b Z".into());
        let hint = format!(" {prefix}{} ", if line.detail.is_some() && !line.detail_seen { " · d detail" } else { "" });
        let used = (x - rect.x) as usize;
        if used + hint.chars().count() + 1 < width { buf.set_string(rect.x + (width - hint.chars().count()) as u16, rect.y, &hint, base.add_modifier(Modifier::DIM)) }
    }
    let id = line.id.clone();
    drawn(app, &id);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_say_as_a_line() {
        let now = Instant::now();
        let l = line_from(&json!({ "id": "q1", "about": { "machineId": "m1", "agentId": "a1", "requestId": "r" }, "mood": "need", "line": "[y/n/g] api@office Bash: npm test",
            "actions": [{ "key": "y", "label": "Yes", "choice": "Yes" }, { "key": "n", "label": "No", "choice": "No" }, { "key": "g", "label": "open", "choice": "g" }], "ttlMs": 5200, "detail": "npm test" }), now).unwrap();
        assert_eq!(l.keys(), "[y/n/g] ");
        assert_eq!(l.words(), "api@office Bash: npm test");
        assert_eq!(l.about, Some(("m1".into(), "a1".into())));
        assert!(l.keyed() && l.loud() && !l.armed() && l.has_key('y') && !l.has_key('s'));
        // The pair's say never carries keys.
        let p = line_from(&json!({ "id": "p", "mood": "say", "from": "pair", "line": "[y/n] sure", "actions": [{ "key": "y", "label": "Yes", "choice": "Yes" }] }), now).unwrap();
        assert!(!p.keyed() && p.from_pair);
        // A confirmation answers y and n.
        let c = line_from(&json!({ "id": "c", "mood": "ask", "line": "raise the dial to act on key?", "actions": [], "confirm": { "kind": "autonomy", "nonce": "n1" } }), now).unwrap();
        assert_eq!(c.keys(), "[y/n] ");
        assert_eq!(c.words(), "raise the dial to act on key?");
    }
}
