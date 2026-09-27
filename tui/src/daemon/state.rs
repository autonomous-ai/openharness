//! What hn keeps of the daemons while it runs, and the face in the status line: the mood by the
//! README's precedence, from what hn already sees (the fleet's events) and what the pair brain says
//! (`daemon_state`); work frames that step once per real agent event (at most two a second); blinks
//! that answer something (ack, look, slow); a nap; Quiet. There is no idle animation timer: a timer
//! only ends a held face, runs a blink, or clears a line.

use std::time::{Duration, Instant};

use serde_json::Value;

use super::brain::Brain;
use super::render::{self, Opts};
use super::roster::roster;
use super::zoo::{Settings, ZooDoc};
use crate::app::App;
use crate::fleet::State;

/// How long a nap lasts, and how long a return must have been to wave.
pub const NAP: Duration = Duration::from_secs(15 * 60);
pub const BACK_AFTER: Duration = Duration::from_secs(15 * 60);
/// Idle in front this long is away (presence), as the desktop measures it.
pub const IDLE: Duration = Duration::from_secs(5 * 60);
/// The zoo not answering (a 5xx, no answer) is asked again after this, doubling to RETRY_MOST; off is
/// asked again after RETRY_MOST (daemons/README.md, "Off switches": at most every six hours).
pub const RETRY_FIRST: Duration = Duration::from_secs(5 * 60);
pub const RETRY_MOST: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Debug, PartialEq)]
pub enum ZooState {
    /// Not read yet (or harnessd could not reach the backend): nothing is drawn, and it is asked again.
    Unknown,
    /// The daemons are off: the server's switch (`GET /api/zoo` answers 404, or `{ enabled: false }`),
    /// or a harnessd with no zoo. Nothing of the daemons at all: no cell, no keys, no frames.
    Off,
    /// The account's zoo.
    Account,
    /// No account (harnessd answered 401): the nest from this computer's habits.
    SignedOut,
}

impl ZooState {
    /// The daemons show: a zoo, or the nest signed out.
    pub fn on(&self) -> bool { matches!(self, ZooState::Account | ZooState::SignedOut) }
}

pub struct Daemons {
    pub settings: Settings,
    /// `set -g @tim off` (tmux.conf, or set-option): honoured as Quiet.
    pub tim_off: bool,
    pub zoo: ZooDoc,
    pub zoo_state: ZooState,
    pub fetching: bool,
    /// A zoo_changed came while a read or a write was out: read again after.
    pub refetch: bool,
    /// Habits reported to the account this run (each once).
    pub reported: Vec<String>,
    /// When to ask for the zoo again: off, at most every six hours; not answering (a 5xx, no
    /// answer), after `retry` — five minutes, doubling to six hours.
    pub retry_at: Option<Instant>,
    pub retry: Duration,
    /// The key table is bound (the daemons are on).
    pub keys_on: bool,
    /// The local link's generation the zoo was read on, and presence said on (a reconnect does both again).
    pub fetched_gen: Option<u64>,
    // ── the face ──
    /// A held reaction: the mood and until when (done, back, fail).
    pub held: Option<(&'static str, Instant)>,
    pub last_done: Option<Instant>,
    /// A blink: which (ack, look, slow) and when its first frame starts.
    pub blink: Option<(&'static str, Instant)>,
    pub last_look: Option<Instant>,
    /// Work frames: one step per real agent event, at most two a second.
    pub step: u64,
    pub last_step: Option<Instant>,
    pub back_at: Option<Instant>,
    pub nap_until: Option<Instant>,
    pub boop_until: Option<Instant>,
    /// A new egg sits in the slot for 3 s.
    pub egg_until: Option<Instant>,
    // ── presence (daemon_presence) ──
    pub last_key: Instant,
    /// Enter pressed, or the pane in front changed: a pause a waiting line may speak into.
    pub pause_at: Option<Instant>,
    pub idle_sent: bool,
    pub away_since: Option<Instant>,
    pub focus_back: Option<Instant>,
    pub focus_sent: Option<Option<(String, String)>>,
    pub presence_gen: Option<u64>,
    /// The daemon key table was up at the last frame.
    pub table_up: bool,
    /// When a popup's animation draws next (a plate's frame, the reveal): one timer at a time.
    pub frame_due: Option<Instant>,
    // ── the pair brain, and what is open over the window ──
    pub brain: Brain,
    pub overlay: Option<super::overlay::Overlay>,
}

impl Daemons {
    pub fn load() -> Daemons {
        Daemons {
            settings: Settings::load(), tim_off: false, zoo: ZooDoc::default(), zoo_state: ZooState::Unknown, fetching: false, refetch: false, reported: Vec::new(), retry_at: None, retry: RETRY_FIRST, keys_on: false, fetched_gen: None,
            held: None, last_done: None, blink: None, last_look: None, step: 0, last_step: None, back_at: None, nap_until: None, boop_until: None, egg_until: None,
            last_key: Instant::now(), pause_at: None, idle_sent: false, away_since: None, focus_back: None, focus_sent: None, presence_gen: None, table_up: false, frame_due: None,
            brain: Brain::default(), overlay: None,
        }
    }

    /// Quiet: `set -g @daemon-quiet on`, `@tim off`, or daemon.json's `quiet`.
    pub fn quiet(&self, app: &App) -> bool {
        self.tim_off || self.settings.quiet || option_on(app, "@daemon-quiet")
    }

    pub fn napping(&self) -> bool { self.nap_until.map(|t| Instant::now() < t).unwrap_or(false) }

    /// The paired daemon's name (its nickname when it has one), or `your daemon`.
    pub fn name(&self) -> String {
        self.zoo.zoo.paired().map(|(mine, d)| mine.nickname.clone().unwrap_or_else(|| d.id.clone())).unwrap_or_else(|| "your daemon".into())
    }

    /// The habits the nest counts: the account's, and (signed out) this computer's.
    pub fn habits(&self) -> Vec<String> {
        let mut h = if self.zoo_state == ZooState::Account { self.zoo.zoo.habits.clone() } else { Vec::new() };
        for k in &self.settings.habits { if !h.contains(k) { h.push(k.clone()) } }
        h
    }

    /// Start a blink (never over another).
    pub fn blink(&mut self, kind: &'static str) {
        if self.blink.map(|(_, at)| at.elapsed() < Duration::from_millis(900)).unwrap_or(false) { return }
        let delay = if kind == "ack" { 160 } else { 0 };
        self.blink = Some((kind, Instant::now() + Duration::from_millis(delay)));
    }

    /// The lid now, while a blink runs.
    pub fn lid(&self) -> Option<String> {
        let (kind, start) = self.blink?;
        let now = Instant::now();
        if now < start { return None }
        let mut at = start;
        for (lid, ms) in roster().rules.blinks.get(kind).map(Vec::as_slice).unwrap_or(&[]) {
            at += Duration::from_millis(*ms);
            if now < at { return Some(lid.clone()) }
        }
        None
    }

    pub fn hold(&mut self, mood: &'static str) {
        let ms = roster().rules.hold_ms.get(mood).copied().unwrap_or(1000);
        self.held = Some((mood, Instant::now() + Duration::from_millis(ms)));
        if mood == "back" { self.back_at = Some(Instant::now()) }
    }

    /// A real agent event: one step of the work frames, at most two a second.
    pub fn step(&mut self) {
        if self.last_step.map(|t| t.elapsed() < Duration::from_millis(500)).unwrap_or(false) { return }
        self.step += 1;
        self.last_step = Some(Instant::now());
    }
}

/// A tmux user option that is on (`on`, `1`, `yes`).
pub fn option_on(app: &App, name: &str) -> bool {
    let v = app.options.get(name, "", None).or_else(|| app.opts.user.get(name).cloned());
    matches!(v.as_deref(), Some("on" | "1" | "yes" | "true"))
}

/// A tmux user option that is off.
pub fn option_off(app: &App, name: &str) -> bool {
    let v = app.options.get(name, "", None).or_else(|| app.opts.user.get(name).cloned());
    matches!(v.as_deref(), Some("off" | "0" | "no" | "false"))
}

/// Motion: off with `set -g @daemon-motion off` (the README's Reduce Motion), and while the
/// terminal is not in front (a background window stops all frames).
pub fn motion(app: &App) -> bool { !option_off(app, "@daemon-motion") }

/// The face's mood, in the README's order: boop, need, nap, a held reaction, work, fail, idle.
pub fn mood(app: &App) -> &'static str {
    let d = &app.daemons;
    let now = Instant::now();
    if d.boop_until.map(|t| now < t).unwrap_or(false) { return "boop" }
    let state = &d.brain.state;
    let listed = |k: &str| state.get(k).and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false);
    if app.fleet.waiting() > 0 || listed("needs") || listed("asks") || listed("confirms") { return "need" }
    if d.napping() { return "nap" }
    if let Some((m, until)) = d.held { if now < until { return m } }
    let working = app.fleet.agents.values().any(|a| a.engine != "terminal" && matches!(app.fleet.state_of(a), State::Working))
        || state.get("working").and_then(Value::as_u64).unwrap_or(0) > 0;
    if working { return "work" }
    // A harness you have open that failed to start, or whose last turn failed. A machine asleep or
    // out of reach is not a failure.
    let open_failed = app.panes.values().any(|p| app.fleet.agent(&p.machine_id, &p.agent_id).map(|a| app.fleet.state_of(a) == State::Failed).unwrap_or(false));
    if open_failed || listed("failing") { return "fail" }
    "idle"
}

/// The status cell (ten cells): the paired daemon; else a waiting egg; else the nest. None until
/// the zoo has answered. In the status line's own colours, always.
pub fn cell(app: &App) -> Option<String> {
    let r = roster();
    if !app.daemons.zoo_state.on() { return None }
    let centred = |s: &str| render::status_cell(r, s, s.len());
    let zoo = app.daemons.zoo.zoo.clone();
    let hatching = matches!(app.daemons.overlay, Some(super::overlay::Overlay::Hatch(_)));
    let fresh_egg = app.daemons.egg_until.map(|t| Instant::now() < t).unwrap_or(false);
    let egg_look = zoo.eggs.first().and_then(|e| r.rules.eggs.get(&e.kind)).map(|e| e.look.clone());
    if let Some((mine, d)) = zoo.paired().filter(|_| !hatching && !fresh_egg) {
        let vi = r.version_index(&mine.version());
        let m = mood(app);
        let lid = if app.terminal_focused { app.daemons.lid() } else { None };
        let moving = motion(app) && app.terminal_focused;
        let last = r.rules.versions.len() - 1;
        let t = match m {
            "back" => app.daemons.back_at.map(|b| b.elapsed().as_millis() as u64).unwrap_or(0),
            _ => app.daemons.step * if vi == last { d.work_ms } else { 130 },
        };
        let sprite = render::sprite(r, d, vi, m, Opts { t, lid: lid.as_deref(), motion: moving });
        let mut s = render::status_cell(r, &sprite, render::base_width(r, d, vi));
        // Shiny: a `*` in the left gutter.
        if mine.shiny { s.replace_range(0..1, "*") }
        return Some(s);
    }
    if let Some(look) = egg_look { return Some(centred(&look)) }
    let stage = render::nest_stage(r, &app.daemons.habits());
    Some(centred(&r.rules.nest[stage]))
}

/// `#{daemon}` (and `#{tim}`): the cell, bold when it wants you, dim asleep.
pub fn format(app: &App) -> String {
    let Some(c) = cell(app) else { return String::new() };
    let paired = app.daemons.zoo.zoo.paired().is_some();
    match if paired { mood(app) } else { "" } {
        "need" | "fail" => format!("#[bold]{c}#[nobold]"),
        "nap" => format!("#[dim]{c}#[nodim]"),
        _ => c,
    }
}

/// `#{daemon_tally}`: eggs waiting to be opened (`+1 egg`).
pub fn tally(app: &App) -> String {
    let n = app.daemons.zoo.zoo.eggs.len();
    if app.daemons.zoo_state != ZooState::Account || n == 0 || app.daemons.zoo.zoo.daemons.is_empty() { return String::new() }
    format!("+{n} egg{}", if n == 1 { "" } else { "s" })
}

/// One line about the daemon, for `:daemon` and `hn tim`.
pub fn describe(app: &App) -> String {
    let d = &app.daemons;
    let quiet = if d.quiet(app) { " · quiet" } else { "" };
    match (&d.zoo_state, d.zoo.zoo.paired()) {
        (ZooState::Unknown, _) => "the zoo has not answered yet".into(),
        (ZooState::Off, _) => "the daemons are off here".into(),
        (ZooState::Account, Some((mine, r))) => format!("{} {} · {} · bond {} · {} xp · {}{quiet}", mine.nickname.clone().unwrap_or(r.id.clone()), mine.version(), r.rarity, mine.bond, mine.xp, mood(app)),
        (ZooState::Account, None) if !d.zoo.zoo.eggs.is_empty() => format!("an egg is ready — {} hatches it{quiet}", app.keymap.key_for_name("switch-client -T daemon").map(|k| format!("{k} h")).unwrap_or("C-b Z h".into())),
        (ZooState::SignedOut, _) => format!("the nest ({} habits) — sign in to hatch{quiet}", d.habits().len()),
        _ => format!("the nest ({} habits){quiet}", d.habits().len()),
    }
}
