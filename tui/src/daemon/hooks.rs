//! Where the rest of hn calls into the daemons — one line at each place (a frame, a key, the focus,
//! the tick, the status line, a format, a command) — and the zoo's reads and writes.

use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent};
use serde_json::{json, Value};

use super::brain;
use super::hatch::{Outcome, Reveal};
use super::overlay::Overlay;
use super::state::{self, ZooState, BACK_AFTER, IDLE, NAP, RETRY_FIRST, RETRY_MOST};
use super::zoo::{op, ZooDoc};
use crate::app::App;
use crate::daemon::{http_json, RpcError};
use crate::keys::{Binding, Chord, Keymap};

/// Printable, one line: what a status line can draw.
pub fn printable(s: &str) -> String { s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect() }

// ── keys ──────────────────────────────────────────────────────────────────────

/// What `prefix Z` runs: the `daemon` key table.
pub const ENTER: &str = "switch-client -T daemon";

fn ch(c: char) -> Chord { Chord::normal(KeyCode::Char(c), crossterm::event::KeyModifiers::NONE) }
fn bind(chord: Chord, command: &str, note: &str) -> Binding { Binding { chord, command: command.into(), repeat: false, note: note.into() } }

/// The daemon's keys: `prefix Z` — a key tmux 3.5a leaves unbound, and hn's own Harness keys do not
/// use — enters the `daemon` table, whose keys answer the line, talk, open the zoo and hatch. Plain
/// tmux: `bind Z switch-client -T daemon`; `bind -T daemon y …` changes any of them.
pub fn table() -> Vec<Binding> {
    vec![
        bind(ch('y'), "daemon key y", "Yes: the line's y (a one-time yes, or teach)"),
        bind(ch('n'), "daemon key n", "No: the line's n (decline, or skip)"),
        bind(ch('g'), "daemon key g", "Go to the harness the line is about"),
        bind(ch('s'), "daemon key s", "Show the lesson in full"),
        bind(ch('d'), "daemon detail", "What a key on the line does, in full"),
        bind(ch('t'), "command-prompt -p (talk) { daemon talk \"%%\" }", "Talk to your daemon"),
        bind(ch('z'), "daemon zoo", "The zoo: the box back, eggs, what's next"),
        bind(ch('h'), "daemon hatch", "Hatch an egg"),
        bind(Chord::normal(KeyCode::Esc, crossterm::event::KeyModifiers::NONE), "daemon dismiss", "Dismiss the line"),
    ]
}

/// Bound while the daemons are on, gone while they are off — never over a key of your own (a
/// tmux.conf that binds Z, or `unbind -a`, keeps its way).
pub fn keys(km: &mut Keymap, on: bool) {
    let z = ch('Z');
    if on {
        if km.prefix_command(&z).is_none() && !km.removed.contains(&crate::keys::Table::Prefix) {
            km.prefix_table.push(bind(z, ENTER, "Your daemon: y n g answer its line; d t z h s; Escape"));
        }
        let own = km.named.entry("daemon".into()).or_default();
        for b in table() { if !own.iter().any(|x| x.chord == b.chord) { own.push(b) } }
    } else {
        km.prefix_table.retain(|b| !(b.chord == z && b.command == ENTER));
        let ours = table();
        if let Some(own) = km.named.get_mut("daemon") {
            own.retain(|b| !ours.iter().any(|o| o.chord == b.chord && o.command == b.command));
            if own.is_empty() { km.named.remove("daemon"); }
        }
    }
}

/// harnessd said the daemons are off (`DAEMONS_OFF` on a key, a talk or a confirmation): off at once,
/// and the zoo read again to be sure.
pub fn daemons_off(app: &mut App) {
    set_state(app, ZooState::Off);
    fetch(app);
}

/// The daemons on or off (the zoo's answer): the keys follow, and off leaves nothing on screen.
pub fn set_state(app: &mut App, state: ZooState) {
    let on = state.on();
    app.daemons.zoo_state = state;
    if on != app.daemons.keys_on {
        app.daemons.keys_on = on;
        keys(&mut app.keymap, on);
        // Presence is said again, now that there is someone to say it for.
        app.daemons.presence_gen = None;
    }
    if !on {
        app.daemons.overlay = None;
        app.daemons.brain = Default::default();
        if app.key_table.as_deref() == Some("daemon") { app.key_table = None }
    }
}

/// A key: presence and pauses, then any popup of the daemons' takes it. True when it was taken.
pub fn on_key(app: &mut App, key: &KeyEvent) -> bool {
    if !app.daemons.zoo_state.on() { return false }
    let d = &mut app.daemons;
    let gone = d.last_key.elapsed();
    d.last_key = Instant::now();
    if key.code == KeyCode::Enter { d.pause_at = Some(Instant::now()) }
    // Idle in front, and back: the whole absence.
    if d.idle_sent {
        d.idle_sent = false;
        presence(app, json!({ "active": true, "awayMs": gone.as_millis() as u64 }));
        if gone >= BACK_AFTER { back(app) }
    }
    super::overlay::key(app, key)
}

/// The terminal came to the front, or went behind (FocusGained / FocusLost).
pub fn on_focus(app: &mut App, gained: bool) {
    if !app.daemons.zoo_state.on() { return }
    if !gained {
        app.daemons.away_since = Some(Instant::now());
        app.daemons.focus_back = None;
        return presence(app, json!({ "active": false }));
    }
    let away = app.daemons.away_since.take().map(|t| t.elapsed()).unwrap_or_default();
    presence(app, json!({ "active": true, "awayMs": away.as_millis() as u64 }));
    // You looked: one blink (at most once in 2.5 s), and the tally is seen after 4 s in front.
    look(app);
    app.daemons.focus_back = Some(Instant::now());
    if away >= BACK_AFTER { back(app) }
}

fn look(app: &mut App) {
    if app.daemons.last_look.map(|t| t.elapsed() < Duration::from_millis(2500)).unwrap_or(false) { return }
    app.daemons.last_look = Some(Instant::now());
    app.daemons.blink("look");
    brain::wake(app, 300);
}

/// Back after a break: the wave, and a slow blink.
fn back(app: &mut App) {
    app.daemons.hold("back");
    app.daemons.blink("slow");
    brain::wake(app, 1400);
}

fn presence(app: &App, mut fields: Value) {
    if !app.daemons.zoo_state.on() { return }
    let Some(link) = app.link(&app.fleet.local_id) else { return };
    if !link.over_socket() { return }
    if let (Some(c), Value::Object(m)) = (app.daemons.zoo.zoo.consent.as_ref().filter(|_| app.daemons.zoo_state == ZooState::Account), &mut fields) { m.insert("consent".into(), json!(c.watching)); }
    link.send("daemon_presence", fields);
}

// ── frames ────────────────────────────────────────────────────────────────────

/// A frame from a machine: the brain's and the zoo's (from this computer's harnessd) are taken;
/// the fleet's events move the face (and are left for the app). True when taken.
pub fn on_frame(app: &mut App, machine_id: &str, ty: &str, p: &Value) -> bool {
    let local = machine_id == app.fleet.local_id;
    if local && ty == "zoo_changed" {
        let revision = p.get("revision").and_then(Value::as_i64).unwrap_or(i64::MAX);
        if revision > app.daemons.zoo.revision || app.daemons.zoo_state != ZooState::Account { fetch(app) }
        return true;
    }
    if local && ty.starts_with("daemon_") { return !app.daemons.zoo_state.on() || brain::on_frame(app, ty, p) }
    if !app.daemons.zoo_state.on() { return false }
    let flag = |k: &str| p.get(k).and_then(Value::as_bool).unwrap_or(false);
    let agent = p.get("agentId").and_then(Value::as_str).unwrap_or("").to_string();
    match ty {
        // A real agent event: one step of the work frames (a heartbeat is not one).
        "turn_started" | "tool_start" | "tool_end" | "text_delta" => app.daemons.step(),
        "turn_ended" if !flag("replay") && !flag("subagent") => {
            let mine = app.panes.values().any(|pane| pane.machine_id == machine_id && pane.agent_id == agent);
            let failed = flag("aborted") || app.fleet.agents.get(&(machine_id.to_string(), agent.clone())).map(|a| a.errored).unwrap_or(false);
            if mine && !failed {
                // A turn you started finished: `done` for 3 s, at most once in 20 s; and the habit.
                if app.daemons.last_done.map(|t| t.elapsed() >= Duration::from_secs(20)).unwrap_or(true) { app.daemons.hold("done"); app.daemons.last_done = Some(Instant::now()) }
                habit(app, "turn");
            }
            app.daemons.blink("ack");
            brain::wake(app, 400);
        }
        "error" if !flag("replay") => { app.daemons.hold("fail"); app.daemons.blink("ack"); brain::wake(app, 4300) }
        "commander_question" => { app.daemons.blink("ack"); brain::wake(app, 400) }
        _ => {}
    }
    false
}

// ── the tick ──────────────────────────────────────────────────────────────────

pub fn tick(app: &mut App) {
    // The local link again (a reconnect): the zoo is read again.
    let generation = app.link(&app.fleet.local_id).map(|l| l.generation);
    if generation.is_some() && generation != app.daemons.fetched_gen {
        // The first connection needs no read of its own (hn read the zoo as it started) — unless
        // that read found nothing yet.
        let again = app.daemons.fetched_gen.is_some() || app.daemons.zoo_state == ZooState::Unknown;
        app.daemons.fetched_gen = generation;
        if again { fetch(app) }
    }
    // The zoo did not answer: ask again.
    if app.daemons.retry_at.map(|t| Instant::now() >= t).unwrap_or(false) { app.daemons.retry_at = None; fetch(app) }
    if !app.daemons.zoo_state.on() { return }
    // Presence, said again on a new connection (or once the daemons came on).
    if generation.is_some() && generation != app.daemons.presence_gen {
        app.daemons.presence_gen = generation;
        app.daemons.focus_sent = None;
        presence(app, json!({ "active": app.terminal_focused }));
    }
    // Idle in front for five minutes is away, with how long.
    if app.terminal_focused && !app.daemons.idle_sent && app.daemons.last_key.elapsed() >= IDLE {
        app.daemons.idle_sent = true;
        presence(app, json!({ "active": false, "awayMs": app.daemons.last_key.elapsed().as_millis() as u64 }));
    }
    // What is in front (never spoken about); a pane switch is a pause a waiting line may speak into.
    let focus = brain::focused(app).filter(|_| app.terminal_focused);
    if app.daemons.focus_sent.as_ref() != Some(&focus) {
        if app.daemons.focus_sent.is_some() { app.daemons.pause_at = Some(Instant::now()) }
        app.daemons.focus_sent = Some(focus.clone());
        presence(app, match &focus { Some((m, a)) => json!({ "focusAgentId": a, "focusMachineId": m }), None => json!({ "focusAgentId": null }) });
    }
    // Looked at for 4 s: the finished turns are seen.
    if app.daemons.focus_back.map(|t| t.elapsed() >= Duration::from_secs(4)).unwrap_or(false) {
        app.daemons.focus_back = None;
        presence(app, json!({ "doneSeen": true }));
    }
    brain::release(app);
    // Two harnesses side by side in one window.
    if !app.daemons.settings.habits.iter().any(|h| h == "split") {
        let mut agents: Vec<(String, String)> = Vec::new();
        for id in app.tab().panes() {
            if let Some(p) = app.panes.get(&id) {
                let harness = app.fleet.agent(&p.machine_id, &p.agent_id).map(|a| a.engine != "terminal").unwrap_or(false);
                if harness && !agents.contains(&(p.machine_id.clone(), p.agent_id.clone())) { agents.push((p.machine_id.clone(), p.agent_id.clone())) }
            }
        }
        if agents.len() >= 2 { habit(app, "split") }
    }
    if app.daemons.nap_until.map(|t| Instant::now() >= t).unwrap_or(false) { app.daemons.nap_until = None }
}

/// hn started: the zoo read, and today counted toward `days`.
pub fn boot(app: &mut App) {
    let today = super::zoo::local_today();
    let three = app.daemons.settings.ran_today(&today);
    app.daemons.settings.save();
    if three { habit(app, "days") }
    fetch(app);
}

// ── the zoo ───────────────────────────────────────────────────────────────────

/// A zoo read (or a write's answer): what changed since the last one is news — a new egg (an ack
/// blink, the egg in the slot for 3 s), a level-up (a slow blink). The first read is a baseline.
fn take(app: &mut App, doc: ZooDoc) {
    if doc.revision < app.daemons.zoo.revision && app.daemons.zoo_state == ZooState::Account { return }
    let first = app.daemons.zoo_state != ZooState::Account;
    let before = std::mem::replace(&mut app.daemons.zoo, doc);
    set_state(app, ZooState::Account);
    if first { return report_habits(app) }
    let now = &app.daemons.zoo.zoo;
    let arrived = now.eggs.iter().any(|e| !before.zoo.eggs.iter().any(|b| b.id == e.id));
    let grew = now.paired().zip(before.zoo.paired()).map(|((a, _), (b, _))| a.id == b.id && a.bond > b.bond).unwrap_or(false);
    if arrived && !now.daemons.is_empty() { app.daemons.egg_until = Some(Instant::now() + Duration::from_secs(3)); app.daemons.blink("ack"); brain::wake(app, 3050) }
    if grew { app.daemons.blink("slow"); brain::wake(app, 200) }
    report_habits(app);
}

/// `GET /api/zoo`, through harnessd (as the desk is read).
pub fn fetch(app: &mut App) {
    if app.daemons.fetching { app.daemons.refetch = true; return }
    app.daemons.fetching = true;
    let port = app.port;
    app.spawn(async move { http_json(port, "GET", "/api/zoo", None).await }, |app, r| {
        app.daemons.fetching = false;
        let now = Instant::now();
        match r {
            // The server's switch (a 404, harnessd's `DAEMONS_OFF` among them), or `{ enabled: false }`:
            // off, and asked again at most every six hours (zoo_changed and a reconnect ask sooner).
            Ok(v) if v.get("enabled").and_then(Value::as_bool) == Some(false) => { set_state(app, ZooState::Off); app.daemons.retry_at = Some(now + RETRY_MOST) }
            Err(e) if e.code == "HTTP_404" => { set_state(app, ZooState::Off); app.daemons.retry_at = Some(now + RETRY_MOST) }
            Ok(v) => { app.daemons.retry = RETRY_FIRST; app.daemons.retry_at = None; take(app, serde_json::from_value(v).unwrap_or_default()) }
            Err(e) if e.code == "HTTP_401" => { app.daemons.retry = RETRY_FIRST; app.daemons.retry_at = None; set_state(app, ZooState::SignedOut) }
            // A 5xx, or no answer, is not off: what was shown stays, and it is asked again later.
            Err(_) => {
                app.daemons.retry_at = Some(now + app.daemons.retry);
                app.daemons.retry = (app.daemons.retry * 2).min(RETRY_MOST);
            }
        }
        if std::mem::take(&mut app.daemons.refetch) { fetch(app) }
    });
}

/// `POST /api/zoo/ops`; its answer is the zoo now.
pub fn ops(app: &mut App, ops: Vec<Value>, then: impl FnOnce(&mut App, Result<Value, RpcError>) + Send + 'static) {
    let port = app.port;
    let body = json!({ "ops": ops });
    app.spawn(async move { http_json(port, "POST", "/api/zoo/ops", Some(&body)).await }, move |app, r| {
        if let Ok(v) = &r { if let Ok(doc) = serde_json::from_value::<ZooDoc>(v.clone()) { take(app, doc) } }
        then(app, r)
    });
}

/// A habit hn saw (daemons/README.md "First egg: habits"): kept here, and reported to the account.
pub fn habit(app: &mut App, key: &str) {
    if app.daemons.zoo_state == ZooState::Off { return }
    if app.daemons.settings.saw(key) { app.daemons.settings.save(); }
    report_habits(app);
}

fn report_habits(app: &mut App) {
    if app.daemons.zoo_state != ZooState::Account { return }
    let missing: Vec<String> = app.daemons.settings.habits.iter().filter(|h| !app.daemons.zoo.zoo.habits.contains(h) && !app.daemons.reported.contains(h)).cloned().collect();
    if missing.is_empty() { return }
    app.daemons.reported.extend(missing.iter().cloned());
    ops(app, missing.iter().map(|k| op("zoo.habit", json!({ "key": k }))).collect(), |_, _| {});
}

/// Hatch an egg (the first waiting, or the one named): the reveal, while harnessd draws.
pub fn hatch(app: &mut App, egg: Option<String>) {
    match &app.daemons.zoo_state {
        ZooState::SignedOut => return brain::reply(app, "sign in to hatch (harness login) — the nest grows meanwhile"),
        ZooState::Unknown => return brain::reply(app, "the zoo has not answered yet"),
        ZooState::Off => return app.error("the daemons are off here"),
        ZooState::Account => {}
    }
    let zoo = app.daemons.zoo.zoo.clone();
    let Some(e) = zoo.eggs.iter().find(|e| egg.as_ref().map(|id| &e.id == id).unwrap_or(true)).cloned() else {
        return brain::reply(app, if zoo.daemons.is_empty() { "no egg yet — the nest grows with your habits (C-b Z z)" } else { "no egg to hatch — work earns them" });
    };
    let reveal = Reveal::new(&e.id, &e.kind, state::motion(app), app.daemons.settings.hatches >= 3, zoo.consent.is_none());
    app.daemons.overlay = Some(Overlay::Hatch(Box::new(reveal)));
    brain::wake(app, 40);
    let egg_id = e.id.clone();
    ops(app, vec![op("zoo.hatch", json!({ "eggId": e.id }))], move |app, r| {
        let outcome = r.map_err(|e| e.to_string()).and_then(|v| {
            let h = v.get("hatched").and_then(Value::as_array).and_then(|a| a.iter().find(|h| h.get("eggId").and_then(Value::as_str) == Some(&egg_id)).cloned()).ok_or("that egg is gone".to_string())?;
            let id = h.get("daemonId").and_then(Value::as_str).unwrap_or("").to_string();
            let was = zoo.owned(&id).cloned();
            let now = app.daemons.zoo.zoo.owned(&id).cloned().unwrap_or_default();
            let grew = v.get("levelUps").and_then(Value::as_array).and_then(|a| a.iter().find(|l| l.get("id").and_then(Value::as_str) == Some(&id)))
                .map(|l| (l.get("level").and_then(Value::as_u64).unwrap_or(0) as u32, l.get("version").and_then(Value::as_str).unwrap_or("0.1").to_string()));
            let duplicate = h.get("duplicate").and_then(Value::as_bool).unwrap_or(false);
            let shiny = h.get("shiny").and_then(Value::as_bool).unwrap_or(false);
            Ok(Outcome {
                daemon: id, shiny: shiny || (duplicate && now.shiny), serial: h.get("serial").and_then(Value::as_u64), duplicate, xp: h.get("xp").and_then(Value::as_u64).unwrap_or(0), grew,
                old_version: was.as_ref().map(|w| w.version()).unwrap_or_else(|| "0.1".into()), hatched: now.hatched_day().or_else(|| Some(super::zoo::local_today())),
                nickname: now.nickname.clone(), total_xp: now.xp, became_shiny: duplicate && shiny && !was.map(|w| w.shiny).unwrap_or(false), count: now.dupes + 1,
            })
        });
        app.daemons.settings.hatches += 1;
        app.daemons.settings.save();
        if let Some(Overlay::Hatch(rv)) = app.daemons.overlay.as_mut() {
            rv.answered = Some(Instant::now());
            match outcome { Ok(o) => rv.outcome = Some(o), Err(e) => rv.error = Some(e) }
            brain::wake(app, 40);
        }
    });
}

/// The first-day consent's answer (`zoo.consent`).
pub fn consent(app: &mut App, watching: bool) {
    let name = app.daemons.name();
    ops(app, vec![op("zoo.consent", json!({ "watching": watching }))], move |app, r| match r {
        Ok(_) if watching => brain::reply(app, format!("{name} watches now — at watch it only tells you")),
        Ok(_) => brain::reply(app, format!("{name} watches nothing. {} shows what it would see", app.keymap.key_for_name("switch-client -T daemon").map(|k| format!("{k} z")).unwrap_or_default())),
        Err(e) => brain::reply(app, e.to_string()),
    });
}

/// The paired daemon's card, as a fenced code block, to the clipboard (OSC 52).
pub fn copy_card(app: &mut App) {
    let Some(text) = card_text(&app.daemons.zoo, None) else { return brain::reply(app, "no daemon yet — hatch one first") };
    crate::clipboard::store(&format!("```\n{text}\n```\n"));
    brain::reply(app, format!("{}'s card is copied", app.daemons.name()));
}

/// A daemon's card from the zoo: the paired one, or `id` when it is yours.
pub fn card_text(doc: &ZooDoc, id: Option<&str>) -> Option<String> {
    let zoo = &doc.zoo;
    let mine = match id { Some(id) => zoo.owned(id)?, None => zoo.paired()?.0 };
    let d = super::roster::roster().shown(&mine.id)?;
    let o = card_opts(mine);
    Some(super::card::card_lines(super::roster::roster(), d, &o).join("\n"))
}

pub fn card_opts(mine: &super::zoo::Owned) -> super::card::CardOpts {
    super::card::CardOpts { version: Some(mine.version()), shiny: mine.shiny, serial: mine.serial.map(|s| s.to_string()), nickname: mine.nickname.clone(), hatched: mine.hatched_day(), egg: mine.egg.clone() }
}

// ── the status line, formats, commands, options ──────────────────────────────

/// `#{daemon}` (`#{tim}`), `#{daemon_tally}`, `#{daemon_name}`, `#{daemon_mood}`.
pub fn format(app: &App, name: &str) -> Option<String> {
    Some(match name {
        "daemon" | "tim" => state::format(app),
        "daemon_tally" => state::tally(app),
        "daemon_name" => if app.daemons.zoo.zoo.paired().is_some() { app.daemons.name() } else { String::new() },
        "daemon_mood" => if app.daemons.zoo.zoo.paired().is_some() { state::mood(app).to_string() } else { String::new() },
        _ => return None,
    })
}

/// `daemon [key y|n|g|s | detail | dismiss | talk <words> | zoo | hatch [egg] | card | nap | quiet [on|off] | boop | consent]`.
pub fn command(app: &mut App, words: &[String]) {
    let verb = words.get(1).map(String::as_str).unwrap_or("");
    let rest = words.get(2..).map(|w| w.join(" ")).unwrap_or_default();
    if !app.daemons.zoo_state.on() { return app.error(if app.daemons.zoo_state == ZooState::Off { "the daemons are off here" } else { "the zoo has not answered yet" }) }
    // Anything you do with it ends a nap (a nap asked for again starts one).
    if verb != "nap" && !verb.is_empty() { app.daemons.nap_until = None }
    match verb {
        "" => { let l = state::describe(app); brain::reply(app, l) }
        "key" => match rest.chars().next() { Some(k @ ('y' | 'n' | 'g' | 's')) => brain::key(app, k), _ => app.error("usage: daemon key y|n|g|s") },
        "detail" => brain::detail(app),
        "dismiss" => { if app.daemons.overlay.take().is_none() { brain::dismiss(app) } }
        "talk" => brain::talk(app, &rest),
        "zoo" => { app.daemons.overlay = Some(Overlay::Zoo); look(app); presence(app, json!({ "doneSeen": true })) }
        "hatch" => hatch(app, (!rest.is_empty()).then_some(rest)),
        "card" => copy_card(app),
        "consent" => { if app.daemons.zoo.zoo.paired().is_some() { app.daemons.overlay = Some(Overlay::Consent { name: app.daemons.name() }) } else { brain::reply(app, "no daemon yet — hatch one first") } }
        "nap" => { app.daemons.nap_until = Some(Instant::now() + NAP); brain::reply(app, format!("{} naps for 15 minutes — a harness that needs you still wakes it", app.daemons.name())) }
        "quiet" => {
            let on = match rest.as_str() { "on" => true, "off" => false, _ => !app.daemons.settings.quiet };
            app.daemons.settings.quiet = on;
            app.daemons.settings.save();
            let also = if on { "" } else if app.daemons.tim_off || state::option_on(app, "@daemon-quiet") { " (your tmux.conf still says quiet)" } else { "" };
            brain::reply(app, format!("{}: {}{also}", app.daemons.name(), if on { "quiet — no line nobody asked for" } else { "speaks again when something needs you" }));
        }
        "boop" => { app.daemons.boop_until = Some(Instant::now() + Duration::from_millis(900)); brain::wake(app, 950) }
        other => app.error(format!("daemon: unknown verb {other} (key detail dismiss talk zoo hatch card consent nap quiet boop)")),
    }
}

/// `set -g @tim off` (as tim.json's `off` was): Quiet.
pub fn tim_option(app: &mut App, value: Option<&str>) { app.daemons.tim_off = matches!(value, Some("off" | "0" | "no")) }

/// The daemon key table came up: you looked at it.
pub fn table_opened(app: &mut App) { look(app); presence(app, json!({ "doneSeen": true })) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Keymap;

    #[test]
    fn the_key_table_comes_and_goes_with_the_daemons() {
        let mut km = Keymap::tmux_defaults();
        let z = ch('Z');
        assert!(km.prefix_command(&z).is_none(), "tmux 3.5a leaves Z unbound, and so does hn");
        keys(&mut km, true);
        assert_eq!(km.prefix_command(&z).unwrap().command, ENTER);
        assert_eq!(km.named["daemon"].iter().find(|b| b.chord == ch('y')).unwrap().command, "daemon key y");
        assert_eq!(km.named["daemon"].iter().find(|b| b.chord == ch('t')).unwrap().command, "command-prompt -p (talk) { daemon talk \"%%\" }");
        keys(&mut km, false);
        assert!(km.prefix_command(&z).is_none() && !km.named.contains_key("daemon"));
        // A Z of your own is yours, on or off; your own daemon-table keys stay.
        km.bind(crate::keys::Table::Prefix, z, "display-message mine".into(), false);
        km.named.insert("daemon".into(), vec![bind(ch('y'), "display-message yes", "")]);
        keys(&mut km, true);
        assert_eq!(km.prefix_command(&z).unwrap().command, "display-message mine");
        assert_eq!(km.named["daemon"].iter().find(|b| b.chord == ch('y')).unwrap().command, "display-message yes");
        keys(&mut km, false);
        assert_eq!(km.prefix_command(&z).unwrap().command, "display-message mine");
        assert_eq!(km.named["daemon"].len(), 1);
    }
}
