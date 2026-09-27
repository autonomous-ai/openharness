//! The daemons from a shell, beside `hn ls` and `hn send-message`:
//!
//!   hn zoo                     the box back, what you own, eggs and what's next (or the nest)
//!   hn card [daemon] [--version v] [--svg]
//!                              a card, as text (copied with OSC 52 at a terminal) or SVG, at your
//!                              daemon's version or the one asked for (a filled daemon's shows its
//!                              portrait plate)
//!   hn hatch                   the running hn hatches an egg, full screen
//!   hn talk "<words>"          words to your daemon, from the running hn (a window)
//!   hn lessons [...]           harness pair lessons (approving stays yours, at a terminal)
//!   hn tim | hn daemon         one line about it

use std::io::IsTerminal;

use super::overlay::{zoo_rows, Face, Row};
use super::roster::roster;
use super::state::ZooState;
use super::zoo::{local_today, now_ms, Settings, ZooDoc};
use crate::daemon::http_json;

/// The zoo as harnessd answers it: the account's, or why there is none.
async fn read(port: u16) -> (ZooState, ZooDoc) {
    match http_json(port, "GET", "/api/zoo", None).await {
        Ok(v) if v.get("enabled").and_then(serde_json::Value::as_bool) == Some(false) => (ZooState::Off, ZooDoc::default()),
        Ok(v) => (ZooState::Account, serde_json::from_value(v).unwrap_or_default()),
        Err(e) if e.code == "HTTP_401" => (ZooState::SignedOut, ZooDoc::default()),
        Err(e) if e.code == "HTTP_404" => (ZooState::Off, ZooDoc::default()),
        Err(e) => { eprintln!("hn: {e}"); (ZooState::Unknown, ZooDoc::default()) }
    }
}

fn habits(state: &ZooState, doc: &ZooDoc) -> Vec<String> {
    let mut h = if *state == ZooState::Account { doc.zoo.habits.clone() } else { Vec::new() };
    for k in Settings::load().habits { if !h.contains(&k) { h.push(k) } }
    h
}

/// Whether a shell's `hn <verb>` is the daemons' (`hn daemon talk …` with words is the client's
/// command, sent on as any other).
pub fn takes(args: &[String]) -> bool {
    match args.first().map(String::as_str) { Some("daemon" | "tim") => args.len() == 1, Some(_) => true, None => false }
}

/// `hn <verb> …` for the daemons; None when `verb` is not one of theirs.
pub async fn run(args: &[String], port: u16, socket: Option<&str>, name: Option<&str>) -> Option<i32> {
    let verb = args.first()?.as_str();
    let rest: Vec<String> = args[1..].to_vec();
    let alive = crate::ipc::alive(socket, name);
    // `hn lessons` is the CLI's; everything else asks the zoo first — off, and there are no daemons.
    let (state, doc) = if verb == "lessons" { (ZooState::Unknown, ZooDoc::default()) } else { read(port).await };
    if state == ZooState::Off { eprintln!("hn: the daemons are off here"); return Some(1) }
    Some(match verb {
        "zoo" => {
            if state == ZooState::Unknown { return Some(1) }
            // The paired daemon's portrait at rest (idle, its first frame), as text.
            let rows = zoo_rows(&state, &doc, &habits(&state, &doc), &local_today(), now_ms(), Some(Face { mood: "idle", frame: 0 }));
            let text: Vec<&str> = rows.iter().map(Row::text).collect();
            crate::cli::out(&(text.join("\n").trim_end().to_string() + "\n"));
            0
        }
        "card" => {
            let svg = rest.iter().any(|a| a == "--svg");
            // `--version v` takes the word after it; the first other word is the daemon.
            let version = rest.iter().position(|a| a == "--version").map(|i| rest.get(i + 1).cloned().unwrap_or_default());
            let id = rest.iter().enumerate().find(|(i, a)| !a.starts_with('-') && (*i == 0 || rest[i - 1] != "--version")).map(|(_, a)| a.clone());
            if let Some(v) = version.as_ref().filter(|v| !roster().rules.versions.contains(v)) {
                eprintln!("hn: no version {v:?} — {}", roster().rules.versions.join(", "));
                return Some(2);
            }
            if state == ZooState::SignedOut { eprintln!("hn: no zoo — sign in to hatch (harness login)"); return Some(1) }
            if state != ZooState::Account { return Some(1) }
            let mine = match &id { Some(i) => doc.zoo.owned(i), None => doc.zoo.paired().map(|(m, _)| m) };
            let Some(mine) = mine else {
                eprintln!("hn: {}", match &id { Some(i) if roster().shown(i).is_some() => format!("you have not hatched {i}"), Some(i) => format!("no daemon is called {i}"), None => "no daemon yet — hatch one first".into() });
                return Some(1);
            };
            let d = roster().shown(&mine.id)?;
            let mut o = super::hooks::card_opts(mine);
            if version.is_some() { o.version = version }
            if svg { crate::cli::out(&super::card::card_svg(roster(), d, &o)); return Some(0) }
            let text = super::card::card_lines(roster(), d, &o).join("\n");
            crate::cli::out(&format!("{text}\n"));
            // At a terminal: to the clipboard too, as a fenced code block (OSC 52 reaches the
            // computer you sit at, over SSH too).
            if std::io::stdout().is_terminal() { crate::clipboard::store(&format!("```\n{text}\n```\n")); eprintln!("(copied as a code block)") }
            0
        }
        "hatch" | "talk" => {
            if !alive { eprintln!("hn: {verb} happens in a window — start hn first"); return Some(1) }
            if verb == "talk" && rest.join(" ").trim().is_empty() { eprintln!("usage: hn talk \"<words>\""); return Some(1) }
            let mut words = vec!["daemon".to_string(), verb.to_string()];
            words.extend(rest);
            crate::ipc::call(&words, socket, name).await
        }
        "lessons" => {
            // Listing, showing, skipping and reverting are the CLI's; approving a lesson asks you
            // at the terminal (a one-time challenge), never through hn.
            let mut cmd = std::process::Command::new("harness");
            cmd.arg("pair").arg("lessons").args(&rest);
            match cmd.status() { Ok(s) => s.code().unwrap_or(1), Err(e) => { eprintln!("hn: harness: {e}"); 1 } }
        }
        "tim" | "daemon" if rest.is_empty() => {
            if state == ZooState::Unknown { return Some(1) }
            let r = roster();
            let line = match (&state, doc.zoo.paired()) {
                (ZooState::Account, Some((mine, d))) => {
                    let vi = r.version_index(&mine.version());
                    let cell = super::render::status_cell(r, &super::render::sprite(r, d, vi, "idle", super::render::Opts::still()), super::render::base_width(r, d, vi));
                    format!("{cell} {} {} · {} · bond {} · {} xp", mine.nickname.clone().unwrap_or(d.id.clone()), mine.version(), d.rarity, mine.bond, mine.xp)
                }
                (ZooState::Account, None) if !doc.zoo.eggs.is_empty() => format!("{}  an egg is ready — hn hatch", r.rules.eggs.get(&doc.zoo.eggs[0].kind).map(|e| e.look.clone()).unwrap_or_default()),
                _ => {
                    let h = habits(&state, &doc);
                    let stage = super::render::nest_stage(r, &h);
                    let why = if state == ZooState::SignedOut { " — sign in to hatch" } else { "" };
                    format!("{}  the nest ({} habits){why}", r.rules.nest[stage], h.len())
                }
            };
            println!("{line}");
            0
        }
        _ => return None,
    })
}
