//! A port of daemons/tools/render.mjs, the reference renderer: sprites, portraits, the status
//! cell, the banner face, the eggs (their stage and their line) and the individuals (the roll of
//! their traits, their flags, how rare they are and their status line). Every function draws exactly
//! what its JS twin draws — the tests below check every frame and roll in daemons/frames.json byte
//! for byte. Keep the two in step.
//!
//! Placeholders in sprites and portraits:
//!   {e}          an eye: the mood's eye, or the lid while blinking (never in noBlinkMoods)
//!   {<part>}     a moving part (d.parts): its `rest` glyph, or a frame of `work` every `ms` while working
//!   {<moodPart>} a mood-driven part (d.moodParts): its value for the mood, else its idle value

use std::collections::HashMap;

use serde_json::{json, Value};

use super::roster::{Banner, Daemon, Roster};

/// How a frame is drawn: `t` in milliseconds, the lid while blinking, and whether parts move.
#[derive(Clone, Copy, Debug)]
pub struct Opts<'a> { pub t: u64, pub lid: Option<&'a str>, pub motion: bool }

impl Default for Opts<'_> {
    fn default() -> Self { Opts { t: 0, lid: None, motion: true } }
}

impl<'a> Opts<'a> {
    pub fn still() -> Opts<'a> { Opts { t: 0, lid: None, motion: false } }
    #[cfg(test)]
    pub fn at(t: u64) -> Opts<'a> { Opts { t, ..Default::default() } }
}

pub fn eye_for<'r>(roster: &'r Roster, d: &'r Daemon, mood: &str) -> &'r str {
    if let Some(e) = d.eyes.as_ref().and_then(|e| e.get(mood)) { return e }
    roster.rules.eyes.get(mood).map(String::as_str).unwrap_or("o")
}

fn fill(tpl: &str, roster: &Roster, d: &Daemon, mood: &str, o: Opts) -> String {
    // `lid && …`: an empty lid is no blink, as in JS.
    let blinking = o.lid.map(|l| !l.is_empty()).unwrap_or(false) && !roster.rules.no_blink_moods.iter().any(|m| m == mood);
    let eye: String = if blinking { d.lid.clone().unwrap_or_else(|| o.lid.unwrap_or("").to_string()) } else { eye_for(roster, d, mood).to_string() };
    let moving = o.motion && mood == "work";
    let mut out = String::with_capacity(tpl.len() + 8);
    let bytes = tpl.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_alphabetic() { j += 1 }
            if j > i + 1 && j < bytes.len() && bytes[j] == b'}' {
                let key = &tpl[i + 1..j];
                let value: Option<String> = if key == "e" { Some(eye.clone()) }
                    else if let Some(mp) = d.mood_parts.get(key) { mp.get(mood).or_else(|| mp.get("idle")).cloned() }
                    else if let Some(part) = d.parts.get(key) {
                        Some(if moving { part.work[((o.t / part.ms.max(1)) as usize) % part.work.len()].clone() } else { part.rest.clone() })
                    } else { None };
                match value { Some(v) => out.push_str(&v), None => out.push_str(&tpl[i..=j]) }
                i = j + 1;
                continue;
            }
        }
        // Printable ASCII only (the art rules), so a byte is a character.
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// What the status line draws a daemon from: its sprites, work frames and pace — the species' own, or
/// an individual's (render.mjs `individualDaemon`: a rare extra's sprites and work frames, a fidgety
/// temper's half `workMs`). The rest (eyes, lid, parts) is the species'.
#[derive(Clone, Copy)]
pub struct Look<'a> { pub d: &'a Daemon, pub sprites: &'a HashMap<String, String>, pub work: &'a [String], pub work_ms: u64 }

impl<'a> Look<'a> {
    pub fn of(d: &'a Daemon) -> Look<'a> { Look { d, sprites: &d.sprites, work: &d.work, work_ms: d.work_ms } }
}

/// One line for the status bar. `vi` is 0, 1 or 2 (0.1, 1.0, 2.0).
pub fn sprite(roster: &Roster, d: &Daemon, vi: usize, mood: &str, o: Opts) -> String { look_sprite(roster, Look::of(d), vi, mood, o) }

/// render.mjs `renderSprite` over a look (a species', or an individual's).
pub fn look_sprite(roster: &Roster, look: Look, vi: usize, mood: &str, o: Opts) -> String {
    let rules = &roster.rules;
    let last = rules.versions.len() - 1;
    let moving = o.motion && (mood == "work" || mood == "back");
    let mut tpl: &str = look.sprites.get(&rules.versions[vi]).map(String::as_str).unwrap_or("");
    if moving && vi == last && !look.work.is_empty() {
        let ms = if mood == "back" { rules.back_frame_ms } else { look.work_ms };
        tpl = &look.work[((o.t / ms.max(1)) as usize) % look.work.len()];
    }
    let mut s = fill(tpl, roster, look.d, mood, Opts { t: o.t, lid: o.lid, motion: false });
    // Younger versions have no moving part yet; they borrow the twirling baton.
    if moving && vi < last && s.len() <= rules.status_cells - 2 {
        s.push(' ');
        s.push(['|', '/', '-', '\\'][((o.t / 130) % 4) as usize]);
    }
    if mood == "nap" && s.len() < rules.status_cells { s.push('z') }
    s
}

/// The portrait for a version, falling back to the nearest one drawn.
pub fn portrait_for<'r>(roster: &Roster, d: &'r Daemon, version: &str) -> &'r [String] {
    if let Some(p) = d.portraits.get(version) { return p }
    let versions = &roster.rules.versions;
    let drawn: Vec<&String> = versions.iter().filter(|v| d.portraits.contains_key(*v)).collect();
    let at = versions.iter().position(|v| v == version).map(|i| i as i64).unwrap_or(-1);
    let below: Vec<&&String> = drawn.iter().filter(|v| versions.iter().position(|x| x == **v).map(|i| i as i64).unwrap_or(-1) <= at).collect();
    let pick = below.last().map(|v| **v).or(drawn.first().copied());
    pick.and_then(|v| d.portraits.get(v)).map(Vec::as_slice).unwrap_or(&[])
}

pub fn portrait(roster: &Roster, d: &Daemon, version: &str, mood: &str, o: Opts) -> Vec<String> {
    portrait_for(roster, d, version).iter().map(|line| fill(line, roster, d, mood, o)).collect()
}

/// The status cell: statusCells wide plus one cell of gutter each side, the sprite centred on its
/// base width (a borrowed baton or a nap's `z` grows to the right; the face never shifts).
pub fn status_cell(roster: &Roster, sprite: &str, base_width: usize) -> String {
    let cells = roster.rules.status_cells;
    let left = cells.saturating_sub(base_width.min(cells)) / 2;
    let mut s = format!(" {}{sprite}", " ".repeat(left));
    while s.len() < cells + 2 { s.push(' ') }
    s.truncate(cells + 2);
    s
}

/// The base width status_cell centres on: the version's sprite in its idle mood.
pub fn base_width(roster: &Roster, d: &Daemon, vi: usize) -> usize { look_base_width(roster, Look::of(d), vi) }

/// The base width of a look (an individual's centres on its own extra's sprite).
pub fn look_base_width(roster: &Roster, look: Look, vi: usize) -> usize { look_sprite(roster, look, vi, "idle", Opts::still()).len() }

/// A daemon's name as a banner, in the face from daemons/banner.json: every glyph padded to its own
/// widest row, `gap` columns between letters, blank rows dropped.
pub fn banner(b: &Banner, word: &str) -> Vec<String> {
    let blank: &[String] = b.glyphs.get(" ").map(Vec::as_slice).unwrap_or(&[]);
    let glyphs: Vec<Vec<String>> = word.to_lowercase().chars().map(|ch| {
        let g: &[String] = b.glyphs.get(&ch.to_string()).map(Vec::as_slice).unwrap_or(blank);
        let w = g.iter().map(String::len).max().unwrap_or(0);
        g.iter().map(|r| format!("{r:<w$}")).collect()
    }).collect();
    let gap = " ".repeat(b.gap);
    (0..b.rows)
        .map(|r| glyphs.iter().map(|g| g.get(r).map(String::as_str).unwrap_or("")).collect::<Vec<_>>().join(&gap).trim_end().to_string())
        .filter(|l| !l.trim().is_empty())
        .collect()
}

// ── eggs ──────────────────────────────────────────────────────────────────────

/// render.mjs `habitProgress`: how far the first egg is (habits count up to firstEgg.need, and until
/// every required habit — a finished turn — is among them at most need - 1 count), or the setup
/// egg (every known habit toward setupEgg.need). Unknown and repeated habits count nothing.
pub fn habit_progress(roster: &Roster, habits_done: &[String], kind: &str) -> (u64, u64) {
    let first = &roster.rules.first_egg;
    let mut done: Vec<&str> = Vec::new();
    for h in habits_done { if first.habits.iter().any(|k| &k.key == h) && !done.contains(&h.as_str()) { done.push(h) } }
    if kind == "setup" { let need = roster.rules.setup_egg.need; return (done.len().min(need) as u64, need as u64) }
    let required = first.require.iter().all(|k| done.contains(&k.as_str()));
    let cap = if required { first.need } else { first.need.saturating_sub(1) };
    (done.len().min(cap) as u64, first.need as u64)
}

/// render.mjs `eggStage`: `p4` once the egg is earned and waits to be opened; otherwise by done /
/// need, `p0` at none, `p1` below a third, `p2` below two thirds, `p3` from there.
pub fn egg_stage(done: u64, need: u64, ready: bool) -> &'static str {
    if ready { return "p4" }
    let f = if need > 0 { done as f64 / need as f64 } else { 0.0 };
    if !(f > 0.0) { return "p0" }
    if f < 1.0 / 3.0 { "p1" } else if f < 2.0 / 3.0 { "p2" } else { "p3" }
}

/// render.mjs `eggLine`: an egg in the status line, 8 cells at most. `{k}` is the kind's mark; a
/// ready egg (p4, or rocking as it opens) blinks with `lid`; stage `hatchling` is the hatchling's 0.1
/// sprite between the halves of its shell, or the sprite alone when that does not fit.
pub fn egg_line(roster: &Roster, kind: &str, stage: &str, lid: Option<&str>, sprite: &str) -> String {
    let rules = &roster.rules;
    if stage == "hatchling" { return if sprite.len() + 2 <= rules.status_cells { format!("){sprite}(") } else { sprite.to_string() } }
    let blinking = lid.map(|l| !l.is_empty()).unwrap_or(false) && (stage == "p4" || stage == "rock");
    let line = rules.egg_line.get(if blinking { "blink" } else { stage }).map(String::as_str).unwrap_or("");
    let mark = rules.eggs.get(kind).map(|e| e.mark.as_str()).unwrap_or(" ");
    line.replacen("{k}", mark, 1)
}

// ── individuals ───────────────────────────────────────────────────────────────
// A species (tim, the octopus) is a type; every hatch is its own individual. The server draws a
// seed; the traits follow from the species and the seed alone, the same on every client, from the
// species' catalogue. A trait is never stored as truth: only the seed is.

/// plate.mjs `rng`: mulberry32 on a seed, 0 <= r < 1.
pub struct Rng(u32);

impl Rng {
    /// `seed >>> 0`.
    pub fn new(seed: u64) -> Rng { Rng(seed as u32) }

    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4_294_967_296.0
    }
}

/// JavaScript's `Math.round`: the nearest whole number, a half rounding up.
pub fn js_round(x: f64) -> f64 { let f = x.floor(); if x - f >= 0.5 { f + 1.0 } else { f } }

/// An individual's traits (render.mjs `rollTraits`).
#[derive(Clone, Debug, PartialEq)]
pub struct Traits {
    pub seed: u64,
    pub colour: String,
    pub marks: Option<String>,
    pub extra: Option<String>,
    pub odd_eye: bool,
    /// Each proportion, in catalogue order.
    pub props: Vec<(String, f64)>,
    pub fidgety: bool,
    /// The colour its markings are painted in.
    pub accent: String,
}

impl Traits {
    pub fn temper(&self) -> &'static str { if self.fidgety { "fidgety" } else { "calm" } }

    /// As render.mjs returns it.
    pub fn to_json(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("seed".into(), json!(self.seed));
        m.insert("colour".into(), json!(self.colour));
        m.insert("marks".into(), json!(self.marks));
        m.insert("extra".into(), json!(self.extra));
        m.insert("oddEye".into(), json!(self.odd_eye));
        for (k, v) in &self.props { m.insert(k.clone(), json!(v)); }
        m.insert("temper".into(), json!(self.temper()));
        m.insert("accent".into(), json!(self.accent));
        Value::Object(m)
    }
}

/// render.mjs `rollTraits`: the traits of an individual of species `id` hatched with `seed` (1 to
/// 4294967295). Seed 0 is the species as it was drawn before individuals: its first colour, no
/// markings, no extra, every proportion 1, calm. Otherwise one stream of mulberry32 on the seed, in
/// this order: the colour, the markings and the extra (each a weighted pick), the odd eye, each
/// proportion in catalogue order (rounded to hundredths), the temper. The accent is
/// accents[seed % accents.length]. None for a species without a catalogue.
pub fn roll_traits(roster: &Roster, id: &str, seed: u64) -> Option<Traits> {
    let t = roster.daemon(id)?.traits.as_ref()?;
    let mut traits = Traits {
        seed, colour: t.colours.first()?.name.clone(), marks: None, extra: None, odd_eye: false,
        props: t.props.iter().map(|(k, _)| (k.clone(), 1.0)).collect(), fidgety: false, accent: t.accents.first()?.clone(),
    };
    if seed == 0 { return Some(traits) }
    let mut r = Rng::new(seed);
    // A weighted pick: r * the total weight, walked down the list until it drops below 0.
    fn pick<T: Clone>(r: &mut Rng, list: &[(T, f64)]) -> T {
        let mut x = r.next() * list.iter().fold(0.0, |a, e| a + e.1);
        for e in list { x -= e.1; if x < 0.0 { return e.0.clone() } }
        list[0].0.clone()
    }
    let colours: Vec<(String, f64)> = t.colours.iter().map(|c| (c.name.clone(), c.weight)).collect();
    let extras: Vec<(Option<String>, f64)> = t.extras.iter().map(|e| (e.name.clone(), e.weight)).collect();
    traits.colour = pick(&mut r, &colours);
    traits.marks = pick(&mut r, &t.marks);
    traits.extra = pick(&mut r, &extras);
    traits.odd_eye = r.next() < t.odd_eye;
    for (i, (_, (lo, hi))) in t.props.iter().enumerate() { traits.props[i].1 = js_round((lo + (hi - lo) * r.next()) * 100.0) / 100.0 }
    traits.fidgety = r.next() < t.fidgety;
    traits.accent = t.accents[(seed % t.accents.len() as u64) as usize].clone();
    Some(traits)
}

/// render.mjs `individualFlags`: `tim -c coral --spots --glasses --fidgety`. The colour always; then
/// its markings, its extra, `--odd-eye`, a proportion's flag when it falls in the top fifth of its
/// range (a `low` flag, the bottom fifth), in catalogue order, and `--fidgety`.
pub fn individual_flags(roster: &Roster, id: &str, traits: &Traits) -> String {
    let mut out = vec![id.to_string(), format!("-c {}", traits.colour)];
    if let Some(m) = &traits.marks { out.push(format!("--{m}")) }
    if let Some(x) = &traits.extra { out.push(format!("--{x}")) }
    if traits.odd_eye { out.push("--odd-eye".into()) }
    if let Some(t) = roster.daemon(id).and_then(|d| d.traits.as_ref()) {
        for (k, (lo, hi)) in &t.props {
            let v = traits.props.iter().find(|(n, _)| n == k).map(|p| p.1).unwrap_or(1.0);
            let Some(f) = t.flags.get(k) else { continue };
            if let Some(high) = &f.high { if v >= hi - (hi - lo) * 0.2 { out.push(format!("--{high}")) } }
            if let Some(low) = &f.low { if v <= lo + (hi - lo) * 0.2 { out.push(format!("--{low}")) } }
        }
    }
    if traits.fidgety { out.push("--fidgety".into()) }
    out.join(" ")
}

/// render.mjs `oneIn`: how rare an individual's look is, `1 in N`: N = round(1 / p), p the chance of
/// its colour, its markings, its extra and its eyes (odd or not) together.
pub fn one_in(roster: &Roster, id: &str, traits: &Traits) -> u64 {
    let Some(t) = roster.daemon(id).and_then(|d| d.traits.as_ref()) else { return 1 };
    fn chance<T: PartialEq>(list: &[(T, f64)], v: &T) -> f64 {
        list.iter().find(|e| &e.0 == v).map(|e| e.1).unwrap_or(0.0) / list.iter().fold(0.0, |a, e| a + e.1)
    }
    let colours: Vec<(String, f64)> = t.colours.iter().map(|c| (c.name.clone(), c.weight)).collect();
    let extras: Vec<(Option<String>, f64)> = t.extras.iter().map(|e| (e.name.clone(), e.weight)).collect();
    let p = chance(&colours, &traits.colour) * chance(&t.marks, &traits.marks) * chance(&extras, &traits.extra) * if traits.odd_eye { t.odd_eye } else { 1.0 - t.odd_eye };
    js_round(1.0 / p) as u64
}

/// `2,130`: a number with a comma every three digits (card.mjs `oneInText`).
pub fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() { if i > 0 && (s.len() - i) % 3 == 0 { out.push(',') } out.push(c) }
    out
}

/// render.mjs `individualDaemon`: the look an individual shows in the status line — a rare extra's
/// sprites and work frames, and a fidgety temper at half `workMs`. Colour, markings and the odd eye
/// do not show there. (Every species' workMs is even, so half is whole.)
pub fn individual<'a>(d: &'a Daemon, traits: Option<&Traits>) -> Look<'a> {
    let mut look = Look::of(d);
    let Some(tr) = traits else { return look };
    let extra = tr.extra.as_deref().and_then(|x| d.traits.as_ref()?.extras.iter().find(|e| e.name.as_deref() == Some(x))).and_then(|e| e.look.as_ref());
    if let Some(x) = extra { look.sprites = &x.sprites; look.work = &x.work }
    if tr.fidgety { look.work_ms = d.work_ms / 2 }
    look
}

/// render.mjs `renderIndividualSprite`: an individual's line — its extra's sprite, its temper's pace.
pub fn individual_sprite(roster: &Roster, d: &Daemon, traits: Option<&Traits>, vi: usize, mood: &str, o: Opts) -> String {
    look_sprite(roster, individual(d, traits), vi, mood, o)
}

#[cfg(test)]
pub mod tests {
    use super::super::roster::{banner as the_banner, roster};
    use super::*;
    use serde_json::Value;

    pub fn frames() -> Value { serde_json::from_str(include_str!("../../../daemons/frames.json")).unwrap() }

    fn s(v: &Value) -> String { v.as_str().unwrap().to_string() }
    fn lines(v: &Value) -> Vec<String> { v.as_array().unwrap().iter().map(s).collect() }

    #[test]
    fn every_sprite_in_frames_json() {
        let r = roster();
        let f = frames();
        let mut n = 0;
        for c in f["sprites"].as_array().unwrap() {
            let d = r.daemon(c["id"].as_str().unwrap()).unwrap();
            let vi = r.version_index(c["v"].as_str().unwrap());
            let lid = c["lid"].as_str();
            let got = sprite(r, d, vi, c["mood"].as_str().unwrap(), Opts { t: c["t"].as_u64().unwrap(), lid, motion: true });
            assert_eq!(got, s(&c["out"]), "sprite {c}");
            n += 1;
        }
        assert_eq!(n, 2880);
    }

    #[test]
    fn every_portrait_in_frames_json() {
        let r = roster();
        for c in frames()["portraits"].as_array().unwrap() {
            let d = r.daemon(c["id"].as_str().unwrap()).unwrap();
            let got = portrait(r, d, c["v"].as_str().unwrap(), c["mood"].as_str().unwrap(), Opts::at(c["t"].as_u64().unwrap()));
            assert_eq!(got, lines(&c["out"]), "portrait {} {} {} {}", c["id"], c["v"], c["mood"], c["t"]);
        }
    }

    #[test]
    fn every_status_cell_in_frames_json() {
        let r = roster();
        for c in frames()["cells"].as_array().unwrap() {
            let d = r.daemon(c["id"].as_str().unwrap()).unwrap();
            let vi = r.version_index(c["v"].as_str().unwrap());
            let sp = sprite(r, d, vi, c["mood"].as_str().unwrap(), Opts::at(c["t"].as_u64().unwrap()));
            let got = status_cell(r, &sp, base_width(r, d, vi));
            assert_eq!(got, s(&c["out"]), "cell {c}");
            assert_eq!(got.len(), r.rules.status_cells + 2);
        }
    }

    #[test]
    fn every_banner_in_frames_json() {
        for c in frames()["banners"].as_array().unwrap() {
            assert_eq!(banner(the_banner(), c["id"].as_str().unwrap()), lines(&c["out"]), "banner {}", c["id"]);
        }
    }

    #[test]
    fn every_egg_stage_and_line_in_frames_json() {
        let r = roster();
        let f = frames();
        for c in f["eggStages"].as_array().unwrap() {
            assert_eq!(egg_stage(c["done"].as_u64().unwrap(), c["need"].as_u64().unwrap(), c["ready"].as_bool().unwrap()), c["stage"].as_str().unwrap(), "{c}");
        }
        for c in f["firstEgg"].as_array().unwrap() {
            let kind = c["kind"].as_str().unwrap();
            let (done, need) = habit_progress(r, &lines(&c["habits"]), kind);
            assert_eq!((done, need), (c["done"].as_u64().unwrap(), c["need"].as_u64().unwrap()), "{c}");
            let stage = egg_stage(done, need, false);
            assert_eq!(stage, c["stage"].as_str().unwrap());
            assert_eq!(egg_line(r, kind, stage, None, ""), s(&c["out"]));
        }
        let mut n = 0;
        for c in f["eggLines"].as_array().unwrap() {
            let got = egg_line(r, c["kind"].as_str().unwrap(), c["stage"].as_str().unwrap(), c["lid"].as_str(), c["sprite"].as_str().unwrap_or(""));
            assert_eq!(got, s(&c["out"]), "egg line {c}");
            assert!(got.len() <= r.rules.status_cells && got.bytes().all(|b| (0x20..0x7f).contains(&b)));
            if let Some(id) = c["id"].as_str() { assert_eq!(c["sprite"].as_str().unwrap(), sprite(r, r.daemon(id).unwrap(), 0, "idle", Opts::default())) }
            n += 1;
        }
        assert!(n > 100, "{n}");
    }

    #[test]
    fn every_trait_roll_in_frames_json() {
        let r = roster();
        let mut n = 0;
        for c in frames()["traitRolls"].as_array().unwrap() {
            let id = c["id"].as_str().unwrap();
            let seed = c["seed"].as_u64().unwrap();
            let traits = roll_traits(r, id, seed).unwrap();
            assert_eq!(traits.to_json(), c["traits"], "roll {id} {seed}");
            assert_eq!(individual_flags(r, id, &traits), s(&c["flags"]), "flags {id} {seed}");
            assert_eq!(one_in(r, id, &traits), c["oneIn"].as_u64().unwrap(), "oneIn {id} {seed}");
            n += 1;
        }
        assert!(n > 200, "{n}");
        // A species without a catalogue has no individuals' traits.
        assert!(roll_traits(r, "tmux", 7).is_none());
        assert_eq!((thousands(7), thousands(2130), thousands(1234567)), ("7".into(), "2,130".into(), "1,234,567".into()));
    }

    #[test]
    fn every_individual_sprite_in_frames_json() {
        let r = roster();
        let mut n = 0;
        for c in frames()["individualSprites"].as_array().unwrap() {
            let d = r.daemon(c["id"].as_str().unwrap()).unwrap();
            let traits = roll_traits(r, &d.id, c["seed"].as_u64().unwrap());
            let vi = r.version_index(c["v"].as_str().unwrap());
            let o = Opts { t: c["t"].as_u64().unwrap(), lid: c["lid"].as_str(), motion: true };
            let got = individual_sprite(r, d, traits.as_ref(), vi, c["mood"].as_str().unwrap(), o);
            assert_eq!(got, s(&c["out"]), "individual sprite {c}");
            let cell = status_cell(r, &got, look_base_width(r, individual(d, traits.as_ref()), vi));
            assert_eq!(cell, s(&c["cell"]), "individual cell {c}");
            n += 1;
        }
        assert!(n > 2000, "{n}");
    }
}
