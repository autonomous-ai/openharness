//! The zoo (daemons/README.md, "The zoo", "Individuals"): the account's individuals and eggs, read
//! with `GET /api/zoo` and changed with `POST /api/zoo/ops` through this computer's harnessd, as the
//! desk is — and re-read on `zoo_changed`, never on a desk change. Signed out there is no account
//! zoo: hn shows the first egg cracking with the habits it saw here and says "sign in to hatch" (no
//! guest draws in hn).
//!
//! A zoo holds individuals, `{ uid, id (species), seed, serial?, name?, shiny, xp, bond, version,
//! hatched, egg }`, and `paired` names a uid. A zoo in the shape from before individuals (one record
//! per species: no uid, `nickname`, `hatchedAt`, `pair` naming a species) reads the same way: each
//! record one individual of seed 0, named by its species.
//!
//! What hn keeps on this computer is ~/.harness/tui/daemon.json: Quiet, the habits it saw (so the
//! nest grows signed out, and they are reported once there is an account), and the days it ran.
//! It replaces tim.json, of which only `off` is kept (as Quiet).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::render::{self, Traits};
use super::roster::{roster, Daemon};

/// An individual: one hatch of a species, with its own seed (its traits roll from it), serial and name.
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Owned {
    /// The server's id for it (24 hex). None in a zoo from before individuals: its species names it.
    pub uid: String,
    /// Its species.
    pub id: String,
    /// What its traits roll from (render.rs `roll_traits`); 0 is the species as drawn before individuals.
    #[serde(deserialize_with = "lenient_u64")]
    pub seed: u64,
    pub serial: Option<u64>,
    /// The name given at the hatch (a zoo from before individuals called it `nickname`).
    #[serde(alias = "nickname")]
    pub name: Option<String>,
    pub shiny: bool,
    pub bond: u32,
    pub xp: u64,
    pub version: String,
    /// When it hatched (`hatchedAt` before individuals).
    #[serde(alias = "hatchedAt")]
    pub hatched: Value,
    pub egg: Option<String>,
    /// Duplicates merged into it, from before individuals (a same-species hatch is its own now).
    pub dupes: u32,
    pub origin: Option<String>,
}

/// A whole number however it came (a number, or null for none).
fn lenient_u64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    Ok(Value::deserialize(d)?.as_u64().unwrap_or(0))
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Egg { pub id: String, pub kind: String, pub granted_at: Value, pub date: Option<String> }

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Consent { pub watching: bool, pub at: Value }

/// What counts toward eggs earned from work (server-written).
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Progress {
    /// Counted turns, all time.
    pub turns: u64,
    /// Counted turns per local day, the last 14 days.
    pub days: std::collections::BTreeMap<String, u64>,
    /// ISO weeks whose week egg was earned.
    pub weeks: Vec<String>,
    /// Nights counted since the last night egg.
    pub nights: Vec<String>,
    /// Marathon eggs earned (`turns`, `machines`).
    pub marathon: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Zoo {
    pub daemons: Vec<Owned>,
    pub eggs: Vec<Egg>,
    /// The paired individual's uid.
    #[serde(rename = "paired")]
    pub paired_uid: Option<String>,
    /// The pair as a zoo from before individuals names it (a species, which is its one record).
    pub pair: Option<String>,
    pub autonomy: Option<String>,
    pub consent: Option<Consent>,
    pub habits: Vec<String>,
    pub first_egg: bool,
    pub setup_egg: bool,
    pub progress: Progress,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ZooDoc { pub revision: i64, pub zoo: Zoo }

impl Zoo {
    /// Who is paired: a uid (a zoo from before individuals: a species, its one record).
    pub fn pair_uid(&self) -> Option<&str> { self.paired_uid.as_deref().or(self.pair.as_deref()).filter(|u| !u.is_empty()) }

    /// The paired individual: its record, and its species (never one of a drop on hold).
    pub fn paired(&self) -> Option<(&Owned, &'static Daemon)> {
        let uid = self.pair_uid()?;
        let mine = self.daemons.iter().find(|d| d.uid() == uid).or_else(|| self.daemons.iter().find(|d| d.id == uid))?;
        Some((mine, roster().shown(&mine.id)?))
    }

    /// The individuals hn may show, in the zoo's order (never one of a drop on hold).
    pub fn shown(&self) -> impl Iterator<Item = (&Owned, &'static Daemon)> {
        self.daemons.iter().filter_map(|o| Some((o, roster().shown(&o.id)?)))
    }

    /// An individual of a species (the paired one when it is of it, else the first); none for a
    /// species of a drop on hold, which is never shown.
    pub fn owned(&self, id: &str) -> Option<&Owned> {
        roster().shown(id)?;
        let paired = self.paired().map(|(o, _)| o).filter(|o| o.id == id);
        paired.or_else(|| self.daemons.iter().find(|d| d.id == id))
    }

    /// An individual by what a person calls it: its uid, its name (`pip`), `tim#42` (its species and
    /// serial), or its species (`tim`: as `owned`).
    pub fn find(&self, who: &str) -> Option<&Owned> {
        let who = who.trim();
        let shown = |o: &&Owned| roster().shown(&o.id).is_some();
        if let Some(o) = self.daemons.iter().filter(shown).find(|o| !o.uid.is_empty() && o.uid == who) { return Some(o) }
        if let Some(o) = self.daemons.iter().filter(shown).find(|o| o.name.as_deref().map(|n| n.eq_ignore_ascii_case(who)).unwrap_or(false)) { return Some(o) }
        if let Some((id, serial)) = who.split_once('#') {
            let serial: u64 = serial.trim().parse().ok()?;
            return self.daemons.iter().filter(shown).find(|o| o.id == id.trim() && o.serial == Some(serial));
        }
        self.owned(who)
    }

    /// Whether an individual is the paired one.
    pub fn is_paired(&self, o: &Owned) -> bool { self.paired().map(|(p, _)| std::ptr::eq(p, o)).unwrap_or(false) }
}

impl Owned {
    /// Its uid: the server's, or (a zoo from before individuals) its species.
    pub fn uid(&self) -> &str { if self.uid.is_empty() { &self.id } else { &self.uid } }

    /// Its traits, rolled from its seed; none for a species without a catalogue (line art).
    pub fn traits(&self) -> Option<Traits> { render::roll_traits(roster(), &self.id, self.seed) }

    /// How it is called: its name, else `tim #0042` (its species and serial), else its species.
    pub fn called(&self) -> String {
        match (&self.name, self.serial) {
            (Some(n), _) if !n.trim().is_empty() => n.clone(),
            (_, Some(s)) => format!("{} #{s:04}", self.id),
            _ => self.id.clone(),
        }
    }

    /// Its title: `pip the tim`, or `tim #0042` while it has no name.
    pub fn title(&self) -> String {
        match &self.name { Some(n) if !n.trim().is_empty() => format!("{n} the {}", self.id), _ => self.called() }
    }

    /// Its flags and how rare it is: `tim -c coral --spots · 1 in 644` (none for line art).
    pub fn flags(&self) -> Option<(String, u64)> {
        let t = self.traits()?;
        Some((render::individual_flags(roster(), &self.id, &t), render::one_in(roster(), &self.id, &t)))
    }

    /// Its version, as the roster names them (a record from before versions reads 0.1).
    pub fn version(&self) -> String { if roster().rules.versions.contains(&self.version) { self.version.clone() } else { roster().rules.versions[0].clone() } }

    /// `2026-09-26`, however the server wrote it (a date, an ISO time, or ms since the epoch).
    pub fn hatched_day(&self) -> Option<String> {
        match &self.hatched {
            Value::String(s) if s.len() >= 10 => Some(s[..10].to_string()),
            Value::Number(n) => n.as_i64().map(|ms| civil(ms.div_euclid(86_400_000))),
            _ => None,
        }
    }
}

// ── eggs, earned and earning ──────────────────────────────────────────────────

/// An egg as hn shows it: earned and waiting in the nest (`egg`, its id), or being earned (done of need).
#[derive(Clone, Debug, PartialEq)]
pub struct EggShown { pub kind: String, pub egg: Option<String>, pub done: u64, pub need: u64 }

impl EggShown {
    pub fn ready(&self) -> bool { self.egg.is_some() }
    /// render.rs `egg_stage`: p4 waiting, else by done / need.
    pub fn stage(&self) -> &'static str { render::egg_stage(self.done, self.need, self.ready()) }
    fn fraction(&self) -> f64 { if self.ready() { f64::INFINITY } else if self.need > 0 { self.done as f64 / self.need as f64 } else { 0.0 } }
    /// What it waits on, in words: `ready`, `2/3 habits`, `12/40 turns`.
    pub fn words(&self) -> String {
        if self.ready() { return "ready".into() }
        let what = match self.kind.as_str() { "first" | "setup" => "habits", "week" => "days this week", "night" => "nights", _ => "turns" };
        format!("{}/{} {what}", self.done, self.need)
    }
}

/// The eggs waiting to be opened, then the eggs being earned (daemons/README.md "Eggs": what counts
/// toward each kind) — the first egg over its habits until it is granted (signed out, only it); then
/// the setup egg until it is granted, the turn, week and night eggs, and the marathon until earned.
pub fn eggs_shown(zoo: &Zoo, account: bool, habits: &[String], today: &str) -> Vec<EggShown> {
    let r = roster();
    let mut out: Vec<EggShown> = if account { zoo.eggs.iter().map(|e| EggShown { kind: e.kind.clone(), egg: Some(e.id.clone()), done: 0, need: 0 }).collect() } else { Vec::new() };
    let earning = |kind: &str, (done, need): (u64, u64)| EggShown { kind: kind.into(), egg: None, done: done.min(need), need };
    let first_done = account && (zoo.first_egg || !zoo.daemons.is_empty());
    if !first_done {
        // Earned on the server: a first egg already waiting is not earned again.
        if !out.iter().any(|e| e.kind == "first") { out.push(earning("first", render::habit_progress(r, habits, "first"))) }
        return out;
    }
    let earn = &r.rules.earn;
    let p = &zoo.progress;
    if !zoo.setup_egg { out.push(earning("setup", render::habit_progress(r, habits, "setup"))) }
    out.push(earning("turn", (p.turns % earn.turn.every.max(1), earn.turn.every)));
    let week = if p.weeks.iter().any(|w| Some(w.as_str()) == iso_week(today).as_deref()) { 0 } else { week_days(p, today) };
    out.push(earning("week", (week, earn.week.days)));
    out.push(earning("night", (p.nights.len() as u64, earn.night.nights)));
    if !p.marathon.iter().any(|m| m == "turns") { out.push(earning("marathon", (p.turns, earn.marathon.turns))) }
    out
}

/// The egg nearest to hatching (the status line's): one waiting to be opened, else the one being
/// earned with the highest done / need (the first of them on a tie).
pub fn nearest(eggs: &[EggShown]) -> Option<&EggShown> {
    let mut best: Option<&EggShown> = None;
    for e in eggs { if best.map(|b| e.fraction() > b.fraction()).unwrap_or(true) { best = Some(e) } }
    best
}

/// The local days of `today`'s ISO week (Monday first) with a counted turn.
fn week_days(p: &Progress, today: &str) -> u64 {
    let Some(t) = super::card::day_number(today) else { return 0 };
    let monday = t - (t + 3).rem_euclid(7);
    (monday..=t).filter(|d| p.days.get(&civil(*d)).copied().unwrap_or(0) > 0).count() as u64
}

/// `2026-W39`: the ISO week of a day (the week's Thursday names its year).
pub fn iso_week(day: &str) -> Option<String> {
    let t = super::card::day_number(day)?;
    let thursday = t - (t + 3).rem_euclid(7) + 3;
    let date = civil(thursday);
    let jan1 = super::card::day_number(&format!("{}-01-01", &date[..4]))?;
    Some(format!("{}-W{:02}", &date[..4], (thursday - jan1) / 7 + 1))
}

/// `YYYY-MM-DD` of a day number (days since 1970-01-01).
pub fn civil(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Today on this computer's clock, as the zoo counts days.
pub fn local_today() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    civil((secs + crate::app::utc_offset()).div_euclid(86_400))
}

pub fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

// ── this computer's settings (daemon.json) ─────────────────────────────────────

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Settings {
    /// Silent until turned off (the README's Quiet): no line nobody asked for.
    pub quiet: bool,
    /// Habits seen here (daemons/README.md, "First egg: habits").
    pub habits: Vec<String>,
    /// The local days hn ran (three make the `days` habit), the last few.
    pub days: Vec<String>,
    /// Hatches seen here: from the fourth, any key skips the reveal to the card.
    pub hatches: u32,
}

fn tui_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().filter(|h| !h.is_empty()).map(|h| PathBuf::from(h).join(".harness").join("tui"))
}

impl Settings {
    pub fn path() -> Option<PathBuf> { tui_dir().map(|d| d.join("daemon.json")) }

    /// daemon.json, or — the first time — what tim.json said: only its `off`, as Quiet. The rest of
    /// tim.json (a species drawn on this computer) is not a daemon, and goes.
    pub fn load() -> Settings {
        let Some(path) = Settings::path() else { return Settings::default() };
        if let Some(s) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Settings>(&t).ok()) { return s }
        let old = tui_dir().map(|d| d.join("tim.json"));
        let off = old.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.get("off").and_then(Value::as_bool));
        let settings = Settings { quiet: off.unwrap_or(false), ..Default::default() };
        if off.is_some() && settings.save() { if let Some(p) = old { let _ = std::fs::remove_file(p); } }
        settings
    }

    pub fn save(&self) -> bool {
        let Some(path) = Settings::path() else { return false };
        if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
        std::fs::write(&path, serde_json::to_string_pretty(self).unwrap_or_default()).is_ok()
    }

    /// A habit seen here; true when it is new.
    pub fn saw(&mut self, key: &str) -> bool {
        if self.habits.iter().any(|h| h == key) { return false }
        self.habits.push(key.to_string());
        true
    }

    /// Today counted; true when it makes three different days.
    pub fn ran_today(&mut self, today: &str) -> bool {
        if !self.days.iter().any(|d| d == today) { self.days.push(today.to_string()); self.days.sort(); let n = self.days.len(); if n > 8 { self.days.drain(..n - 8); } }
        self.days.len() >= 3
    }
}

/// An op, as the server takes it.
pub fn op(name: &str, fields: Value) -> Value {
    let mut o = json!({ "op": name });
    if let (Value::Object(m), Value::Object(f)) = (&mut o, fields) { m.extend(f) }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_both_ways() {
        for d in ["1970-01-01", "2026-09-26", "2000-02-29", "2027-01-01"] {
            assert_eq!(civil(super::super::card::day_number(d).unwrap()), d);
        }
    }

    #[test]
    fn reads_a_zoo_of_individuals() {
        let doc: ZooDoc = serde_json::from_value(json!({ "revision": 4, "zoo": { "daemons": [
            { "uid": "a1b2c3d4e5f6a1b2c3d4e5f6", "id": "tim", "seed": 826, "serial": 42, "name": "pip", "shiny": false, "xp": 60, "bond": 1, "version": "0.1", "hatched": "2026-09-27T10:00:00Z", "egg": "turn" },
            { "uid": "0000000000000000000000aa", "id": "tim", "seed": 13, "serial": 43, "shiny": true, "xp": 0, "bond": 0, "version": "0.1", "hatched": 1790000000000i64, "egg": "first" },
            { "uid": "0000000000000000000000bb", "id": "vim", "seed": 5, "version": "2.0" }],
            "paired": "0000000000000000000000aa", "eggs": [], "progress": { "turns": 3 } } })).unwrap();
        let z = &doc.zoo;
        let (mine, d) = z.paired().unwrap();
        assert_eq!((mine.uid(), d.id.as_str(), mine.serial), ("0000000000000000000000aa", "tim", Some(43)));
        assert_eq!((mine.called(), mine.title()), ("tim #0043".to_string(), "tim #0043".to_string()));
        let pip = z.find("pip").unwrap();
        assert_eq!((pip.title(), pip.hatched_day().as_deref()), ("pip the tim".to_string(), Some("2026-09-27")));
        assert_eq!(pip.flags(), Some(("tim -c lilac --freckles --big-head --long-arms --curly --wide-eyes --fidgety".to_string(), 34)));
        assert!(std::ptr::eq(z.find("PIP").unwrap(), pip) && std::ptr::eq(z.find("tim#42").unwrap(), pip) && std::ptr::eq(z.find("a1b2c3d4e5f6a1b2c3d4e5f6").unwrap(), pip));
        // A species names the paired one when it is of it; a drop on hold is never found.
        assert!(std::ptr::eq(z.find("tim").unwrap(), mine) && z.is_paired(mine) && !z.is_paired(pip));
        assert!(z.find("vim").is_none() && z.find("tim#7").is_none() && z.find("nobody").is_none());
        assert_eq!(z.shown().count(), 2);
    }

    #[test]
    fn reads_a_zoo_from_before_individuals() {
        let doc: ZooDoc = serde_json::from_value(json!({ "revision": 3, "zoo": { "daemons": [{ "id": "tim", "hatchedAt": "2026-09-26T10:00:00Z", "egg": "first", "shiny": true, "bond": 2, "xp": 160, "version": "1.0", "serial": 42, "nickname": "pip", "dupes": 1 }],
            "eggs": [{ "id": "e1", "kind": "turn", "grantedAt": 1 }], "pair": "tim", "consent": null, "habits": ["turn"], "progress": { "turns": 41, "days": { "2026-09-26": 3 } } } })).unwrap();
        let (mine, d) = doc.zoo.paired().unwrap();
        assert_eq!((d.id.as_str(), mine.version().as_str(), mine.hatched_day().as_deref()), ("tim", "1.0", Some("2026-09-26")));
        // One individual of seed 0 (the species' own look), its uid its species.
        assert_eq!((mine.uid(), mine.seed, mine.title().as_str()), ("tim", 0, "pip the tim"));
        assert_eq!(mine.flags(), Some(("tim -c magenta".to_string(), 11)));
        assert!(doc.zoo.consent.is_none());
        assert_eq!(op("zoo.habit", json!({ "key": "split" })), json!({ "op": "zoo.habit", "key": "split" }));
        let mut s = Settings::default();
        assert!(s.saw("split") && !s.saw("split"));
        assert!(!s.ran_today("2026-09-24") && !s.ran_today("2026-09-25") && s.ran_today("2026-09-26") && s.ran_today("2026-09-26"));
    }

    #[test]
    fn eggs_being_earned_and_the_nearest() {
        let zoo = |v: Value| serde_json::from_value::<ZooDoc>(json!({ "revision": 1, "zoo": v })).unwrap().zoo;
        let habits: Vec<String> = vec!["split".into(), "find".into()];
        // Before the first egg: only it, over the habits (without a turn, at most 2 of 3 count).
        let fresh = zoo(json!({ "habits": [] }));
        let e = eggs_shown(&fresh, true, &habits, "2026-09-27");
        assert_eq!(e, vec![EggShown { kind: "first".into(), egg: None, done: 2, need: 3 }]);
        assert_eq!((e[0].stage(), e[0].words().as_str()), ("p3", "2/3 habits"));
        // Signed out: the same, from this computer's habits.
        assert_eq!(eggs_shown(&fresh, false, &[], "2026-09-27")[0].stage(), "p0");
        // The first egg waiting: it, ready (p4), and nothing earned twice.
        let waiting = zoo(json!({ "habits": ["turn", "split", "find"], "firstEgg": true, "eggs": [{ "id": "egg-1", "kind": "first" }] }));
        let e = eggs_shown(&waiting, true, &habits, "2026-09-27");
        assert_eq!((e[0].kind.as_str(), e[0].stage(), e[0].words().as_str()), ("first", "p4", "ready"));
        assert_eq!(nearest(&e).unwrap().egg.as_deref(), Some("egg-1"));
        // After: setup, turn, week, night and marathon, each by its own count; the nearest is the furthest along.
        let later = zoo(json!({ "daemons": [{ "uid": "u1", "id": "tim", "seed": 1 }], "firstEgg": true, "habits": ["turn", "split", "find", "store"],
            "progress": { "turns": 532, "days": { "2026-09-21": 2, "2026-09-23": 1, "2026-09-20": 5 }, "weeks": [], "nights": ["2026-09-20", "2026-09-22"], "marathon": ["turns"] } }));
        let e = eggs_shown(&later, true, &later.habits, "2026-09-27");
        let got: Vec<(&str, u64, u64)> = e.iter().map(|x| (x.kind.as_str(), x.done, x.need)).collect();
        // 2026-09-27 is a Sunday: its week began Monday the 21st (the 20th is last week's).
        assert_eq!(got, [("setup", 4, 6), ("turn", 12, 40), ("week", 2, 3), ("night", 2, 3)]);
        assert_eq!(nearest(&e).map(|x| x.kind.as_str()), Some("setup"), "4/6 before 2/3 on a tie");
        assert_eq!(iso_week("2026-09-27").as_deref(), Some("2026-W39"));
        assert_eq!(iso_week("2027-01-01").as_deref(), Some("2026-W53"));
        // This week's egg earned: the week counts again from none.
        let earned = zoo(json!({ "daemons": [{ "uid": "u1", "id": "tim" }], "firstEgg": true, "setupEgg": true, "progress": { "days": { "2026-09-21": 1 }, "weeks": ["2026-W39"] } }));
        assert_eq!(eggs_shown(&earned, true, &[], "2026-09-27").iter().find(|x| x.kind == "week").map(|x| x.done), Some(0));
    }
}
