//! Hatching, in the terminal (daemons/README.md "Eggs" and "Hatching").
//!
//! The ready egg rocks in its nest (its `p4` frames, one every `eggMs.loop`) until harnessd answers
//! `zoo.hatch`, then opens: `rock` twice through, `burst` — the top lifts and light pours out in the
//! rarity's colour (a secret's stage goes black, its shell dims) —, `tumble` (the top breaks in two)
//! and `open` (the bottom half). The hatchling rises out of it a row at a time as `#` in the faint
//! colour, holds 850 ms, and fills with its colour: the individual's own plate, as harnessd drew it,
//! or its species' painted in its colour family until that arrives, its idle loop running (line art
//! blinks). Its species' name types in as a banner, then the rarity stamp, `fork() returned 0.`, its
//! flags and `1 in N`, and its first words; then its card, where the person may name it
//! (`zoo.nickname { uid, name }`, optional). Reduce Motion (`set -g @daemon-motion off`) goes
//! straight to the card. A zoo from before individuals may still answer with a duplicate: it says it
//! merged (`another tux. +150 xp.`), and a level-up morphs the portrait to the new version.
//!
//! The egg shows at the `reveal` size (56 columns) when the whole reveal fits the terminal, else at
//! the `portrait` size (28): `fit` decides, from the reveal's tallest moment, so nothing moves.
//!
//! `frame` is a pure function of the reveal and the time, so the tests can read any moment of it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::card::{card_art, card_lines, one_in_text, CardOpts, INNER};
use super::plates::{self, Art, Light, Paint, PlateInk, PORTRAIT, REVEAL};
use super::render::{self, individual_flags, one_in, roll_traits, Opts, Traits};
use super::roster::{roster, Daemon, EggMs};

/// The ready egg's frames at least this long before it opens (and until harnessd answers).
const MIN_WAIT: u64 = 760;
/// The hatchling rises a row every RISE ms, then holds as a silhouette for HOLD.
const RISE: u64 = 50;
const HOLD: u64 = 850;
/// From the colour to the card.
const TO_CARD: u64 = 2600;
/// A name is 1 to 24 printable characters (`zoo.nickname`).
pub const NAME_MAX: usize = 24;

/// Blocks of rows, for laying them out: an egg, the hatchling, a card.
const EGG: u32 = 1;
const HATCHLING: u32 = 2;
const CARD: u32 = 3;

#[derive(Clone, Debug, Default)]
pub struct Outcome {
    /// The species.
    pub daemon: String,
    /// The individual: the server's uid (empty from a zoo before individuals) and its seed.
    pub uid: String,
    pub seed: u64,
    pub shiny: bool,
    pub serial: Option<u64>,
    pub duplicate: bool,
    pub xp: u64,
    /// A duplicate that grew it: (bond, version) — and the version it had.
    pub grew: Option<(u32, String)>,
    pub old_version: String,
    pub hatched: Option<String>,
    pub nickname: Option<String>,
    pub total_xp: u64,
    /// Now shiny because this duplicate was.
    pub became_shiny: bool,
    /// How many of it you have now (the original and the duplicates merged into it).
    pub count: u32,
}

impl Outcome {
    pub fn traits(&self) -> Option<Traits> { roll_traits(roster(), &self.daemon, self.seed) }
}

#[derive(Clone, Debug)]
pub struct Reveal {
    pub egg_kind: String,
    pub started: Instant,
    pub answered: Option<Instant>,
    pub outcome: Option<Outcome>,
    pub error: Option<String>,
    pub motion: bool,
    /// Any key skips to the card (from the fourth hatch on).
    pub skippable: bool,
    pub skipped: bool,
    /// After the card: what the daemon sees, until the person has answered it once.
    pub consent_next: bool,
    /// The size the egg and a plate show at: `reveal` when the terminal has room for all of it.
    pub size: &'static str,
    /// The individual's own art the hatchling rises as (taken only before it starts to rise, so it
    /// never changes shape on screen), and the size it was drawn at.
    pub rise_art: Option<(&'static str, Arc<Art>)>,
    /// Its own portrait, for the card.
    pub card_art: Option<Arc<Art>>,
    /// The name being typed at the card.
    pub name: String,
}

/// How a row is drawn: its ink. A plate's row is inked glyph by glyph (plates.rs), a painted row
/// (an egg's, an individual's) cell by cell.
#[derive(Clone, Debug, PartialEq)]
pub enum Ink { Plain, Faint, Bold, Colour(u8), Dark(u8), Cyan, Yellow, Plate(PlateInk), Paint(Paint) }

impl Ink {
    /// The same ink `n` cells further right (a painted row's cells move with it).
    fn shifted(&self, n: usize) -> Ink { match self { Ink::Paint(p) => Ink::Paint(p.shifted(n)), other => other.clone() } }
}

#[derive(Clone, Debug, Default)]
pub struct Frame {
    pub rows: Vec<(String, Ink)>,
    /// The stage is pitch black (a secret).
    pub black: bool,
    /// The card is up.
    #[cfg_attr(not(test), allow(dead_code))]
    pub done: bool,
}

/// When each moment of the reveal begins, in ms from its start, once harnessd has answered.
#[derive(Clone, Copy, Debug)]
struct Times { rock: u64, burst: u64, tumble: u64, open: u64, rise: u64, hold: u64, colour: u64, card: u64 }

impl Reveal {
    pub fn new(egg_kind: &str, motion: bool, skippable: bool, consent_next: bool) -> Reveal {
        Reveal { egg_kind: egg_kind.into(), started: Instant::now(), answered: None, outcome: None, error: None, motion, skippable, skipped: false, consent_next, size: PORTRAIT, rise_art: None, card_art: None, name: String::new() }
    }

    fn ms(&self, now: Instant) -> u64 { now.saturating_duration_since(self.started).as_millis() as u64 }

    fn times(&self) -> Option<Times> {
        let e = egg_ms();
        let answered = self.ms(self.answered?);
        let o = self.outcome.as_ref();
        // The ready egg's frames until the answer (at least MIN_WAIT), ending on a frame's end.
        let every = e.r#loop.max(1);
        let rock = answered.max(MIN_WAIT).div_ceil(every) * every;
        let n = |stage: &str| plates::egg_frames(&self.egg_kind, self.size, stage).len().max(1) as u64;
        let burst = rock + 2 * n("rock") * e.rock;
        let tumble = burst + e.burst_hold + (n("burst") - 1) * e.burst;
        let open = tumble + n("tumble") * e.tumble;
        let rise = open + e.open;
        let hold = rise + self.hatchling_rows().len() as u64 * RISE;
        let colour = hold + HOLD;
        let card = match o {
            Some(o) if o.duplicate => rise + if o.grew.is_some() { 2600 } else { 1700 },
            _ => colour + TO_CARD,
        };
        Some(Times { rock, burst, tumble, open, rise, hold, colour, card })
    }

    /// The reveal's length (ms from the start), once answered.
    pub fn length(&self) -> Option<u64> { Some(self.times()?.card) }

    pub fn done(&self, now: Instant) -> bool {
        if self.error.is_some() { return true }
        if self.outcome.is_some() && (self.skipped || !self.motion) { return true }
        self.length().map(|l| self.ms(now) >= l).unwrap_or(false)
    }

    /// Whether the hatchling has started to rise (its art is chosen by then).
    pub fn rising(&self, now: Instant) -> bool { self.outcome.is_some() && self.times().map(|t| self.ms(now) >= t.rise).unwrap_or(false) }

    /// The card asks for a name: a new individual (not a duplicate from a zoo before individuals).
    pub fn naming(&self) -> bool { self.outcome.as_ref().map(|o| !o.duplicate).unwrap_or(false) && self.error.is_none() }

    /// harnessd drew the individual's art: the hatchling rises as it when it came in time, and the
    /// card shows its portrait.
    pub fn offer(&mut self, size: &'static str, art: Arc<Art>, now: Instant) {
        if size == PORTRAIT && self.card_art.is_none() { self.card_art = Some(art.clone()) }
        let taken = self.rise_art.as_ref().map(|(s, _)| *s == size).unwrap_or(false);
        if size == self.size && !taken && !self.rising(now) { self.rise_art = Some((size, art)) }
    }

    fn own(&self) -> Option<&Art> { self.rise_art.as_ref().filter(|(s, _)| *s == self.size).map(|(_, a)| a.as_ref()) }

    /// The hatchling's rows at the reveal's size: its own art, or its species' (line art's portrait).
    fn hatchling_rows(&self) -> Vec<String> {
        let Some(o) = self.outcome.as_ref() else { return Vec::new() };
        let Some(d) = roster().daemon(&o.daemon) else { return Vec::new() };
        let young = &roster().rules.versions[0];
        if let Some(f) = self.own().and_then(|a| a.frame(0)) { return f.rows() }
        if d.plate { plates::rows(&d.id, self.size, young, "idle", 0) } else { render::portrait(roster(), d, young, "idle", Opts::still()) }
    }
}

fn egg_ms() -> EggMs { roster().rules.plate.egg_ms }

fn rarity(id: &str) -> String { roster().daemon(id).map(|d| d.rarity.clone()).unwrap_or_default() }

/// The light an opening egg shows: its hatchling's rarity (a secret's dims the shell).
fn light_of(o: &Outcome) -> Light<'static> {
    let name = match rarity(&o.daemon).as_str() { "rare" => "rare", "legendary" => "legendary", "secret" => "secret", _ => "common" };
    Light { name, dim: name == "secret" }
}

const PLAIN: Light<'static> = Light { name: "plain", dim: false };

/// An egg's frame, painted.
fn egg(kind: &str, size: &str, stage: &str, frame: usize, light: Light) -> Vec<(String, Ink)> {
    let Some(f) = plates::egg_frame(kind, size, stage, frame) else { return vec![(format!("[{kind} egg]"), Ink::Bold)] };
    plates::paint_egg(kind, f, light, EGG).into_iter().map(|(r, p)| (r, Ink::Paint(p))).collect()
}

/// Every drawn cell, as `#`.
fn hashed(rows: &[String]) -> Vec<String> { rows.iter().map(|r| super::card::silhouette(r)).collect() }

/// A daemon's portrait as rows in its ink: a plate at `size` (the mood's loop, frame `frame`) — an
/// individual's own art when it is given, else the species' painted in the individual's colour
/// family, or (no individual) down the species' gradient — or line art in its colour (`lid` while
/// it blinks).
#[allow(clippy::too_many_arguments)]
pub fn art(d: &Daemon, traits: Option<&Traits>, own: Option<&Art>, size: &str, version: &str, mood: &str, frame: usize, shiny: bool, lid: Option<&str>) -> Vec<(String, Ink)> {
    if d.plate {
        if let Some(t) = traits {
            let (rows, mats) = match own.and_then(|a| a.frame(frame)) { Some(f) => (f.rows(), Some(f.mats())), None => (plates::rows(&d.id, size, version, mood, frame), None) };
            return plates::paint_individual(d, t, shiny, rows, mats, HATCHLING).into_iter().map(|(r, p)| (r, Ink::Paint(p))).collect();
        }
        return PlateInk::rows(d, shiny, plates::rows(&d.id, size, version, mood, frame)).into_iter().map(|(r, ink)| (r, Ink::Plate(ink))).collect();
    }
    let colour = d.colour(shiny);
    render::portrait(roster(), d, version, mood, Opts { t: 0, lid, motion: false }).into_iter().map(|r| (r, Ink::Colour(colour))).collect()
}

/// Rows of text, without their ink.
fn texts(rows: &[(String, Ink)]) -> Vec<String> { rows.iter().map(|(r, _)| r.clone()).collect() }

/// A duplicate's level-up: of the cells that differ, a quarter more each frame, in ordered-dither
/// order, from the old version's portrait to the new one's.
pub fn morph(old: &[String], new: &[String], step: u8) -> Vec<String> {
    const BAYER: [[u8; 4]; 4] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
    let h = old.len().max(new.len());
    let w = old.iter().chain(new.iter()).map(String::len).max().unwrap_or(0);
    (0..h).map(|y| {
        let a: Vec<char> = format!("{:<w$}", old.get(y).map(String::as_str).unwrap_or("")).chars().collect();
        let b: Vec<char> = format!("{:<w$}", new.get(y).map(String::as_str).unwrap_or("")).chars().collect();
        (0..w).map(|x| if BAYER[y % 4][x % 4] < step * 4 { b[x] } else { a[x] }).collect::<String>().trim_end().to_string()
    }).collect()
}

/// How wide the reveal is: the card, and a margin.
pub const WIDTH: usize = 44;

/// How wide the reveal is at a size: the card's width, or a reveal plate's and a margin.
pub fn width(size: &str) -> usize {
    if size == REVEAL { WIDTH.max(roster().rules.plate.cols.get(REVEAL).copied().unwrap_or(56) + 2) } else { WIDTH }
}

/// Two rows of one block: the same ink, rows of one plate, or rows of one painted art.
fn one_block(a: &Ink, b: &Ink) -> bool {
    match (a, b) { (Ink::Plate(x), Ink::Plate(y)) => x.same_plate(y), (Ink::Paint(x), Ink::Paint(y)) => x.block == y.block, _ => a == b }
}

/// Each block (a run of rows in one ink, between blank rows) centred in the reveal's width, and a
/// line longer than it wrapped: the art keeps its shape and nothing jumps as rows are added.
fn centre(rows: Vec<(String, Ink)>, width: usize) -> Vec<(String, Ink)> {
    let mut wrapped: Vec<(String, Ink)> = Vec::new();
    for (r, ink) in rows {
        if r.len() <= width - 2 { wrapped.push((r, ink)); continue }
        let mut line = String::new();
        for w in r.split(' ') {
            if !line.is_empty() && line.len() + 1 + w.len() > width - 2 { wrapped.push((std::mem::take(&mut line), ink.clone())) }
            if !line.is_empty() { line.push(' ') }
            line.push_str(w);
        }
        if !line.is_empty() { wrapped.push((line, ink)) }
    }
    let mut out = Vec::with_capacity(wrapped.len());
    let mut i = 0;
    while i < wrapped.len() {
        let ink = wrapped[i].1.clone();
        let mut j = i;
        while j < wrapped.len() && one_block(&wrapped[j].1, &ink) && !wrapped[j].0.is_empty() { j += 1 }
        if j == i { out.push(wrapped[i].clone()); i += 1; continue }
        let w = wrapped[i..j].iter().map(|(r, _)| r.len()).max().unwrap_or(0);
        let pad = width.saturating_sub(w) / 2;
        for (r, ink) in &wrapped[i..j] { out.push((format!("{}{r}", " ".repeat(pad)), ink.shifted(pad))) }
        i = j;
    }
    out
}

/// What the reveal shows at `now`, laid out in its width.
pub fn frame(rv: &Reveal, now: Instant) -> Frame {
    let f = raw(rv, now);
    Frame { rows: centre(f.rows, width(rv.size)), ..f }
}

/// How much room the reveal takes at a size, once harnessd has answered: the widest and the tallest
/// it gets (the opening egg, the hatchling as it holds, the last moment before the card, and the
/// card), so it is laid out once.
pub fn extent(rv: &Reveal, size: &'static str) -> (usize, usize) {
    let mut probe = rv.clone();
    probe.size = size;
    probe.motion = true;
    probe.skipped = false;
    let Some(t) = probe.times().filter(|_| probe.outcome.is_some()) else { return (width(size), 0) };
    let (mut w, mut h) = (width(size), 0);
    for ms in [t.rock, t.colour.saturating_sub(1), t.card.saturating_sub(1), t.card] {
        let f = frame(&probe, probe.started + Duration::from_millis(ms));
        h = h.max(f.rows.len());
        w = w.max(f.rows.iter().map(|(r, _)| r.len()).max().unwrap_or(0));
    }
    (w, h)
}

/// The size the egg and a plate show at in `width` x `height`: `reveal` when all of the reveal fits,
/// else `portrait`. A line-art hatchling has one size.
pub fn fit(rv: &Reveal, width: usize, height: usize) -> &'static str {
    let filled = rv.outcome.as_ref().and_then(|o| roster().daemon(&o.daemon)).map(|d| d.plate).unwrap_or(false);
    if !filled { return PORTRAIT }
    let (w, h) = extent(rv, REVEAL);
    if w <= width && h <= height { REVEAL } else { PORTRAIT }
}

/// The status line's egg while it opens (render.rs `egg_line`): p4 while harnessd draws, then
/// rock, burst, tumble, open, and the hatchling between the halves of its shell.
pub fn line(rv: &Reveal, now: Instant, lid: Option<&str>) -> String {
    let r = roster();
    let t = rv.ms(now);
    let hatchling = || {
        let o = rv.outcome.as_ref();
        let d = o.and_then(|o| r.daemon(&o.daemon));
        let sprite = d.map(|d| render::individual_sprite(r, d, o.and_then(Outcome::traits).as_ref(), 0, "idle", Opts::still())).unwrap_or_default();
        render::egg_line(r, &rv.egg_kind, "hatchling", None, &sprite)
    };
    if rv.error.is_some() || rv.outcome.is_none() { return render::egg_line(r, &rv.egg_kind, "p4", lid, "") }
    if rv.done(now) { return hatchling() }
    let Some(tm) = rv.times() else { return render::egg_line(r, &rv.egg_kind, "p4", lid, "") };
    let stage = if t < tm.rock { "p4" } else if t < tm.burst { "rock" } else if t < tm.tumble { "burst" } else if t < tm.open { "tumble" } else if t < tm.rise { "open" } else { return hatchling() };
    render::egg_line(r, &rv.egg_kind, stage, lid, "")
}

fn raw(rv: &Reveal, now: Instant) -> Frame {
    let t = rv.ms(now);
    let e = egg_ms();
    let kind = rv.egg_kind.as_str();
    let still = |ms: u64, every: u64| if rv.motion { (ms / every.max(1)) as usize } else { 0 };
    if let Some(err) = &rv.error {
        let mut rows = egg(kind, rv.size, "p4", 0, PLAIN);
        rows.push((String::new(), Ink::Plain));
        rows.push((format!("the egg did not hatch: {err}"), Ink::Bold));
        return Frame { rows, black: false, done: true };
    }
    let (Some(o), Some(tm)) = (rv.outcome.as_ref(), rv.times()) else {
        // The ready egg, rocking in its nest until harnessd answers.
        let mut rows = egg(kind, rv.size, "p4", still(t, e.r#loop), PLAIN);
        rows.push((String::new(), Ink::Plain));
        rows.push(("hatching...".into(), Ink::Faint));
        return Frame { rows, black: false, done: false };
    };
    if rv.done(now) { return card_frame(rv, o) }
    let light = light_of(o);
    // A secret's stage goes pitch black as it bursts.
    let black = light.dim && t >= tm.burst;
    // Above the egg, room for the hatchling to rise into: nothing moves when it does.
    let open = plates::egg_frame(kind, rv.size, "open", 0).map(|f| f.rows()).unwrap_or_default();
    let rim = open.iter().position(|r| !r.trim().is_empty()).unwrap_or(0);
    let hatchling = rv.hatchling_rows();
    let above = hatchling.len().saturating_sub(rim);
    let blank = |n: usize| vec![(String::new(), Ink::Plain); n];
    let framed = |mut rows: Vec<(String, Ink)>| { let mut out = blank(above); out.append(&mut rows); Frame { rows: out, black, done: false } };
    if t < tm.rock { return framed(egg(kind, rv.size, "p4", still(t, e.r#loop), PLAIN)) }
    if t < tm.burst { return framed(egg(kind, rv.size, "rock", still(t - tm.rock, e.rock), PLAIN)) }
    if t < tm.tumble {
        let s = t - tm.burst;
        let i = if !rv.motion || s < e.burst_hold { 0 } else { 1 + ((s - e.burst_hold) / e.burst.max(1)) as usize };
        return framed(egg(kind, rv.size, "burst", i.min(plates::egg_frames(kind, rv.size, "burst").len().saturating_sub(1)), light));
    }
    if t < tm.open { return framed(egg(kind, rv.size, "tumble", still(t - tm.tumble, e.tumble), light)) }
    if t < tm.rise { return framed(egg(kind, rv.size, "open", 0, light)) }
    let Some(d) = roster().daemon(&o.daemon) else { return card_frame(rv, o) };
    if o.duplicate { return duplicate(rv, o, d, t - tm.rise, black) }
    let traits = o.traits();
    let young = roster().rules.versions[0].clone();
    let shell: Vec<(String, Ink)> = egg(kind, rv.size, "open", 0, light).into_iter().skip(rim).collect();
    if t < tm.colour {
        // Rising out of the bottom half a row at a time, then held: the silhouette, faint.
        let k = if t < tm.hold { ((t - tm.rise) / RISE + 1) as usize } else { hatchling.len() }.min(hatchling.len());
        let mut rows = blank(above + rim - k);
        rows.extend(hashed(&hatchling[..k]).into_iter().map(|r| (r, Ink::Faint)));
        rows.extend(shell);
        return Frame { rows, black, done: false };
    }
    // In colour, out of its shell: a plate runs its idle loop (Reduce Motion: frame 0); line art blinks.
    let s = t - tm.colour;
    let lid = (200..320).contains(&s).then_some("-");
    let frames = rv.own().map(|a| a.frames.len()).unwrap_or(8);
    let frame = if rv.motion { plates::frame_at(s, frames) } else { 0 };
    let lit = art(d, traits.as_ref(), rv.own(), rv.size, &young, "idle", frame, o.shiny, lid);
    let mut out = blank((above + rim).saturating_sub(lit.len()));
    out.extend(lit);
    if s >= 320 {
        out.push((String::new(), Ink::Plain));
        let banner = render::banner(super::roster::banner(), &d.id);
        let wide = banner.iter().map(String::len).max().unwrap_or(0);
        let shown = ((s - 320) as usize * wide / 600).min(wide);
        out.extend(banner.into_iter().map(|b| (b.chars().take(shown).collect(), Ink::Bold)));
    }
    if s >= 920 { out.push((String::new(), Ink::Plain)); out.push((stamp(o), Ink::Bold)) }
    if s >= 1200 { out.push(("fork() returned 0.".into(), Ink::Plain)) }
    if s >= 1480 {
        if let Some(t) = &traits {
            out.push((individual_flags(roster(), &d.id, t), Ink::Plain));
            out.push((one_in_text(one_in(roster(), &d.id, t)), Ink::Faint));
        }
    }
    if s >= 1760 { out.push((format!("\"{}\"", d.first), Ink::Plain)) }
    Frame { rows: out, black, done: false }
}

/// A duplicate from a zoo before individuals: yours, as it was, then what the duplicate did to it.
fn duplicate(rv: &Reveal, o: &Outcome, d: &Daemon, s: u64, black: bool) -> Frame {
    let frame = if rv.motion { plates::frame_at(s, 8) } else { 0 };
    let name = o.nickname.clone().unwrap_or(d.id.clone());
    let old = art(d, None, None, rv.size, &o.old_version, "idle", frame, o.shiny, None);
    let mut out = Vec::new();
    let grew_at = 1000;
    let shown = match &o.grew {
        Some((_, v)) if s >= grew_at + 200 => {
            let new = art(d, None, None, rv.size, v, "idle", frame, o.shiny, None);
            let step = ((s - grew_at - 200) / 160 + 1).min(4) as u8;
            if step >= 4 { new } else { remorph(d, o.shiny, &old, &new, step) }
        }
        _ => old,
    };
    out.extend(shown);
    out.push((String::new(), Ink::Plain));
    out.push((format!("{} x{} · +{} xp", d.id, o.count.max(2), o.xp), Ink::Bold));
    out.push((format!("another {}. +{} xp.", d.id, o.xp), Ink::Plain));
    if o.became_shiny { out.push(("yours is shiny now.".into(), Ink::Plain)) }
    if let Some((bond, v)) = &o.grew { if s >= grew_at { out.push((format!("{name} grew: bond {bond} · {v}"), Ink::Bold)) } }
    Frame { rows: out, black, done: false }
}

/// The morph between two portraits in their ink: a plate's rows keep their width, each version
/// centred over the other, so the art does not slide.
fn remorph(d: &Daemon, shiny: bool, old: &[(String, Ink)], new: &[(String, Ink)], step: u8) -> Vec<(String, Ink)> {
    let (mut old, mut new) = (texts(old), texts(new));
    if !d.plate { return morph(&old, &new, step).into_iter().map(|r| (r, Ink::Colour(d.colour(shiny)))).collect() }
    let w = old.iter().chain(new.iter()).map(String::len).max().unwrap_or(0);
    for rows in [&mut old, &mut new] {
        let pad = " ".repeat(w.saturating_sub(rows.iter().map(String::len).max().unwrap_or(0)) / 2);
        for r in rows.iter_mut() { *r = format!("{pad}{r}") }
    }
    let rows = morph(&old, &new, step).into_iter().map(|r| format!("{r:<w$}")).collect();
    PlateInk::rows(d, shiny, rows).into_iter().map(|(r, ink)| (r, Ink::Plate(ink))).collect()
}

/// `[ LEGENDARY ]`, `[ SHINY RARE ]`.
pub fn stamp(o: &Outcome) -> String { format!("[ {}{} ]", if o.shiny { "SHINY " } else { "" }, rarity(&o.daemon).to_uppercase()) }

/// The name as the card says it while it is typed: what was typed, else the one it has.
fn typed_name(rv: &Reveal, o: &Outcome) -> Option<String> {
    let typed = rv.name.trim();
    if typed.is_empty() { o.nickname.clone() } else { Some(typed.to_string()) }
}

/// The card as the reveal ends on it: its portrait plate in the individual's ink (its own, once
/// harnessd has drawn it), its name, flags and `1 in N`.
fn card_rows(rv: &Reveal, o: &Outcome, d: &Daemon) -> Vec<(String, Ink)> {
    let r = roster();
    let young = r.rules.versions[0].clone();
    let traits = o.traits();
    let own = rv.card_art.as_ref().filter(|_| traits.is_some() && d.plate).and_then(|a| a.frame(0));
    let plate = own.map(|f| f.rows()).unwrap_or_else(|| card_art(r, d, &young));
    let card = card_lines(r, d, &CardOpts { version: None, shiny: o.shiny, serial: o.serial.map(|s| s.to_string()), name: typed_name(rv, o), hatched: o.hatched.clone(), egg: Some(rv.egg_kind.clone()), traits: traits.clone(), plate: Some(plate.clone()) });
    let n = plate.len();
    let pad = 2 + INNER.saturating_sub(plate.iter().map(String::len).max().unwrap_or(0)) / 2;
    // The portrait's rows in the daemon's ink: an individual's painted, a species plate down its
    // gradient, line art in its colour.
    let inks: Vec<Ink> = match (&traits, d.plate) {
        (Some(t), true) => plates::paint_individual(d, t, o.shiny, plate.clone(), own.map(|f| f.mats()), CARD).into_iter().map(|(_, p)| Ink::Paint(p.shifted(pad))).collect(),
        (None, true) => (0..n).map(|i| Ink::Plate(PlateInk::of(d, o.shiny, i, n))).collect(),
        _ => (0..n).map(|_| Ink::Colour(d.colour(o.shiny))).collect(),
    };
    card.into_iter().enumerate().map(|(i, l)| { let ink = if (3..3 + n).contains(&i) { inks[i - 3].clone() } else { Ink::Plain }; (l, ink) }).collect()
}

/// The end of it: the card and a name for it (a duplicate's merge held, its new version when it grew).
fn card_frame(rv: &Reveal, o: &Outcome) -> Frame {
    let r = roster();
    let secret = rarity(&o.daemon) == "secret";
    let Some(d) = r.daemon(&o.daemon) else { return Frame { rows: vec![(format!("hatched {}", o.daemon), Ink::Bold)], black: false, done: true } };
    let mut out: Vec<(String, Ink)> = Vec::new();
    if o.duplicate {
        let v = o.grew.as_ref().map(|(_, v)| v.clone()).unwrap_or(o.old_version.clone());
        out.extend(art(d, None, None, rv.size, &v, "idle", 0, o.shiny, None));
        out.push((String::new(), Ink::Plain));
        out.push((format!("another {}. +{} xp.", d.id, o.xp), Ink::Bold));
        if o.became_shiny { out.push(("yours is shiny now.".into(), Ink::Plain)) }
        match &o.grew {
            Some((bond, v)) => out.push((format!("{} {v}: bond {bond}, {} xp.", d.id, o.total_xp), Ink::Plain)),
            None => out.push((format!("{}: {} xp.", d.id, o.total_xp), Ink::Plain)),
        }
        out.push((String::new(), Ink::Plain));
        out.push((if rv.consent_next { "any key: next · Esc: later".into() } else { "any key: close".into() }, Ink::Faint));
        return Frame { rows: out, black: secret, done: true };
    }
    out.push((stamp(o), Ink::Bold));
    out.push(("fork() returned 0.".into(), Ink::Plain));
    out.push((String::new(), Ink::Plain));
    out.extend(card_rows(rv, o, d));
    out.push((String::new(), Ink::Plain));
    // A name for it, optional: typed here, sent as zoo.nickname by its uid.
    out.push((format!("name it: {}_{}", rv.name, " ".repeat(NAME_MAX - rv.name.len().min(NAME_MAX))), Ink::Bold));
    out.push(("Enter: done · Esc: later".into(), Ink::Faint));
    Frame { rows: out, black: secret, done: true }
}

/// A key typed at the card's name: printable ASCII, 24 at most, never a leading space.
pub fn type_name(rv: &mut Reveal, c: char) {
    if (' '..='~').contains(&c) && rv.name.len() < NAME_MAX && !(c == ' ' && rv.name.is_empty()) { rv.name.push(c) }
}

/// The next frame is due (the reveal is animating).
pub fn next_in(rv: &Reveal, now: Instant) -> Option<Duration> { (!rv.done(now)).then_some(Duration::from_millis(40)) }

#[cfg(test)]
mod tests {
    use super::*;

    fn at(rv: &Reveal, ms: u64) -> Frame { frame(rv, rv.started + Duration::from_millis(ms)) }
    fn text(f: &Frame) -> String { f.rows.iter().map(|(r, _)| r.as_str()).collect::<Vec<_>>().join("\n") }

    /// An answered reveal: tim, seed 826, is `tim -c lilac --freckles --big-head --long-arms --curly
    /// --wide-eyes --fidgety`, 1 in 34.
    fn answered(daemon: &str, seed: u64, duplicate: bool) -> Reveal {
        let mut rv = Reveal::new("first", true, false, true);
        rv.answered = Some(rv.started + Duration::from_millis(300));
        rv.outcome = Some(Outcome { daemon: daemon.into(), uid: "u1".into(), seed, serial: Some(42), duplicate, xp: if duplicate { 150 } else { 0 }, old_version: "0.1".into(), hatched: Some("2026-09-27".into()), total_xp: 210, ..Default::default() });
        rv
    }

    fn times(rv: &Reveal) -> Times { rv.times().unwrap() }

    /// The rows of a painted block, trimmed.
    fn painted(f: &Frame, block: u32) -> Vec<String> { f.rows.iter().filter(|(_, ink)| matches!(ink, Ink::Paint(p) if p.block == block)).map(|(r, _)| r.trim().to_string()).collect() }
    fn solid(rows: Vec<String>) -> Vec<String> { rows.into_iter().filter(|r| !r.is_empty()).collect() }

    #[test]
    fn the_egg_rocks_bursts_tumbles_and_opens() {
        let mut rv = Reveal::new("first", true, false, true);
        // Before the answer: the ready egg's p4 frames, a frame every eggMs.loop.
        let p4 = |i: usize| solid(plates::egg_frame("first", PORTRAIT, "p4", i).unwrap().rows().iter().map(|r| r.trim().to_string()).collect());
        assert_eq!(solid(painted(&at(&rv, 0), EGG)), p4(0));
        assert_eq!(solid(painted(&at(&rv, 190), EGG)), p4(1));
        assert!(text(&at(&rv, 0)).contains("hatching..."));
        rv = answered("tim", 826, false);
        let tm = times(&rv);
        // At least MIN_WAIT of it, ending on a frame: then rock (65 ms a frame, twice through), burst
        // (420 ms, then 150 each), tumble (75 each) and open (380).
        assert_eq!((tm.rock, tm.burst - tm.rock, tm.tumble - tm.burst, tm.open - tm.tumble, tm.rise - tm.open), (760, 1040, 1170, 600, 380));
        let stage = |ms: u64, stage: &str, i: usize, light: Light| {
            let want = egg("first", PORTRAIT, stage, i, light);
            let got: Vec<(String, Ink)> = at(&rv, ms).rows.into_iter().filter(|(_, ink)| matches!(ink, Ink::Paint(p) if p.block == EGG)).collect();
            assert_eq!(got.len(), want.len(), "{stage} at {ms}");
            for ((g, gi), (w, wi)) in got.iter().zip(&want) {
                assert_eq!(g.trim(), w.trim(), "{stage} {i} at {ms}");
                // Each cell keeps its colour, moved with its row.
                assert_eq!(gi, &wi.shifted(g.len() - w.len()));
            }
        };
        let common = Light { name: "common", dim: false };
        stage(tm.rock + 70, "rock", 1, PLAIN);
        stage(tm.burst + 100, "burst", 0, common);
        stage(tm.burst + 420 + 160, "burst", 2, common);
        stage(tm.tumble + 80, "tumble", 1, common);
        stage(tm.open + 10, "open", 0, common);
        // The status line's egg opens with it.
        let line = |ms: u64| super::line(&rv, rv.started + Duration::from_millis(ms), None);
        assert_eq!([line(10), line(tm.rock + 1), line(tm.burst + 1), line(tm.tumble + 1), line(tm.open + 1), line(tm.rise + 1)],
            ["\\_(oo)_/", "\\_(oo)_/", "'*(oo)*'", "')_^^_('", ")\\_^^_/(", ")(o o)("].map(String::from));
        assert_eq!(super::line(&rv, rv.started, Some("-")), "\\_(--)_/");
    }

    #[test]
    fn the_hatchling_rises_holds_and_fills_with_its_colour() {
        let rv = answered("tim", 826, false);
        let tm = times(&rv);
        let young = plates::rows("tim", PORTRAIT, "0.1", "idle", 0);
        // A row at a time out of the shell, as `#`, faint; the shell's bottom half below it.
        let first = at(&rv, tm.rise + 10);
        let faint: Vec<&String> = first.rows.iter().filter(|(_, ink)| *ink == Ink::Faint).map(|(r, _)| r).collect();
        assert_eq!(faint.len(), 1);
        assert_eq!(faint[0].trim(), super::super::card::silhouette(&young[0]).trim());
        assert!(!painted(&first, EGG).is_empty());
        let held = at(&rv, tm.hold + 10);
        assert_eq!(held.rows.iter().filter(|(_, ink)| *ink == Ink::Faint).count(), young.len());
        // Nothing moves as it rises: the shell stays where the egg's bottom half was.
        let first_egg_row = |f: &Frame| f.rows.iter().position(|(_, ink)| matches!(ink, Ink::Paint(p) if p.block == EGG)).unwrap();
        let opened = at(&rv, tm.open + 10);
        let rim = first_egg_row(&opened) + opened.rows.iter().skip(first_egg_row(&opened)).position(|(r, _)| !r.trim().is_empty()).unwrap();
        assert_eq!(first_egg_row(&first), rim);
        // Then in colour, out of the shell: tim's plate painted in its colour family (lilac), its idle
        // loop running, standing where it rose to.
        let tim = roster().daemon("tim").unwrap();
        let traits = roll_traits(roster(), "tim", 826).unwrap();
        let lit = at(&rv, tm.colour + 10);
        let want = plates::paint_individual(tim, &traits, false, young.clone(), None, HATCHLING);
        let got: Vec<&(String, Ink)> = lit.rows.iter().filter(|(_, ink)| matches!(ink, Ink::Paint(p) if p.block == HATCHLING)).collect();
        assert_eq!(got.len(), young.len());
        for ((g, gi), (w, wp)) in got.iter().zip(&want) {
            assert_eq!(&g[g.len() - w.len()..], w.as_str());
            assert_eq!(gi, &Ink::Paint(wp.shifted(g.len() - w.len())));
        }
        assert_eq!(lit.rows.iter().position(|(_, ink)| matches!(ink, Ink::Paint(p) if p.block == HATCHLING)).unwrap() + young.len(), rim);
        assert!(painted(&lit, EGG).is_empty(), "out of its shell");
        assert_ne!(painted(&at(&rv, tm.colour + 180), HATCHLING), painted(&lit, HATCHLING), "the loop moves");
        let words = text(&at(&rv, tm.colour + 1800));
        assert!(words.contains("[ COMMON ]") && words.contains("fork() returned 0.") && words.contains("1 in 34") && words.contains("\"oh hi. i'm tim."), "{words}");
        assert!(words.contains("tim -c lilac --freckles --big-head"), "{words}");
    }

    #[test]
    fn the_card_then_a_name() {
        let mut rv = answered("tim", 826, false);
        let tm = times(&rv);
        let card = at(&rv, tm.card);
        let t = text(&card);
        assert!(card.done && rv.naming(), "{t}");
        assert!(t.contains("| #01/09  DROP 1: INIT            COMMON |") && t.contains("tim 0.1  #0042") && t.contains("|   tim -c lilac --freckles --big-head \\ |") && t.contains("1 in 34"), "{t}");
        assert!(t.contains("hatched 2026-09-27, first egg") && t.contains("name it: _") && t.contains("Enter: done · Esc: later"), "{t}");
        // The card's plate: the species', painted in its colour family, until harnessd has drawn its own.
        assert_eq!(painted(&card, CARD).len(), plates::rows("tim", PORTRAIT, "0.1", "idle", 0).len());
        // The name shows on the card as it is typed: printable ASCII only, 24 at most.
        for c in " pip\u{7}".chars() { type_name(&mut rv, c) }
        let t = text(&at(&rv, tm.card));
        assert!(t.contains("pip the tim 0.1  #0042") && t.contains("name it: pip_"), "{t}");
        for _ in 0..40 { type_name(&mut rv, 'x') }
        assert_eq!(rv.name.len(), NAME_MAX);
        // Its own portrait, once harnessd has drawn it.
        let own = Art { frames: vec![plates::Framed { rows: "  x##x  \n x@@@@x \n  ;xx;  ".into(), mats: "........\n..m..e..\n........".into() }], frame_ms: 170 };
        rv.offer(PORTRAIT, Arc::new(own), rv.started + Duration::from_millis(tm.card + 5));
        let t = text(&at(&rv, tm.card));
        assert!(t.contains(&format!("|{}x@@@@x{}|", " ".repeat(17), " ".repeat(17))), "{t}");
        // Reduce Motion: straight to the card.
        let mut still = answered("tim", 826, false);
        still.motion = false;
        assert!(at(&still, 350).done);
    }

    #[test]
    fn its_own_art_only_before_it_rises() {
        let mut rv = answered("tim", 826, false);
        let tm = times(&rv);
        let own = Arc::new(Art { frames: vec![plates::Framed { rows: "  ab  \n cdef \n gh   \n  ij  ".into(), mats: "......\n..m...\n......\n......".into() }], frame_ms: 170 });
        rv.offer(PORTRAIT, own.clone(), rv.started + Duration::from_millis(tm.rock + 5));
        let tm = times(&rv);
        assert_eq!(painted(&at(&rv, tm.colour + 10), HATCHLING), ["ab", "cdef", "gh", "ij"]);
        // Too late (it had started to rise): the species plate stays; the card takes it.
        let mut late = answered("tim", 826, false);
        let lt = times(&late);
        late.offer(PORTRAIT, own, late.started + Duration::from_millis(lt.rise + 5));
        assert!(late.rise_art.is_none() && late.card_art.is_some());
    }

    #[test]
    fn at_the_reveal_size_when_it_fits() {
        let mut rv = answered("tim", 826, false);
        // Room for all of it (a 120 x 32 terminal's popup): the reveal size, 56 columns wide.
        assert_eq!(fit(&rv, 116, 30), REVEAL);
        let (w, h) = extent(&rv, REVEAL);
        assert!(w <= 116 && h <= 30 && w == width(REVEAL), "{w} x {h}");
        // Too narrow or too short: the portrait size.
        assert_eq!(fit(&rv, 50, 30), PORTRAIT);
        assert_eq!(fit(&rv, 116, h - 1), PORTRAIT);
        rv.size = REVEAL;
        let tm = times(&rv);
        let big = plates::rows("tim", REVEAL, "0.1", "idle", 0);
        assert_eq!(painted(&at(&rv, tm.colour + 10), HATCHLING).len(), big.len());
        // No row moves as the rest arrives: the reveal is never taller than its extent.
        for ms in (0..tm.card + 200).step_by(50) { assert!(at(&rv, ms).rows.len() <= h, "{ms}") }
        assert_eq!(fit(&Reveal::new("first", true, false, true), 116, 30), PORTRAIT);
    }

    #[test]
    fn rarity_lights_and_a_secret_in_the_dark() {
        // The burst pours out in the rarity's light (a rare's, #5fd7ff); before it, the plain light.
        let lit = |f: &Frame, rgb: [u8; 3]| f.rows.iter().any(|(_, ink)| matches!(ink, Ink::Paint(p) if p.cells.contains(&Some(rgb))));
        let rare = answered("yak", 3, false);
        let tm = times(&rare);
        assert!(lit(&at(&rare, tm.burst + 420 + 300), [0x5f, 0xd7, 0xff]) && !lit(&at(&rare, tm.rock + 10), [0x5f, 0xd7, 0xff]));
        assert!(lit(&at(&rare, 10), [0xff, 0xff, 0xd7]), "the plain light while it waits");
        let secret = answered("beastie", 3, false);
        let st = times(&secret);
        assert!(at(&secret, st.burst + 10).black && at(&secret, st.card + 10).black);
        assert!(!at(&secret, 500).black && !at(&secret, st.rock + 10).black, "black only as it bursts");
        // A shiny one says so.
        let mut gold = answered("tux", 3, false);
        gold.outcome.as_mut().unwrap().shiny = true;
        let gt = times(&gold);
        assert!(text(&at(&gold, gt.colour + 1000)).contains("[ SHINY LEGENDARY ]"));
    }

    #[test]
    fn a_duplicate_merges_and_grows() {
        let mut rv = answered("tim", 0, true);
        rv.outcome.as_mut().unwrap().grew = Some((2, "1.0".into()));
        assert!(!rv.naming());
        let tm = times(&rv);
        assert!(text(&at(&rv, tm.rise + 100)).contains("another tim. +150 xp."));
        assert!(!text(&at(&rv, tm.rise + 100)).contains("fork()"), "no new name for a duplicate");
        assert!(text(&at(&rv, tm.rise + 1100)).contains("tim grew: bond 2 · 1.0"));
        let held = at(&rv, tm.card + 10);
        let grown = plates::rows("tim", PORTRAIT, "1.0", "idle", 0);
        assert!(held.done && grown.iter().all(|row| text(&held).contains(row.as_str())), "the new version: {}", text(&held));
        let old = plates::rows("tim", PORTRAIT, "0.1", "idle", 0);
        assert_eq!(morph(&old, &grown, 4), grown.iter().map(|l| l.trim_end().to_string()).collect::<Vec<_>>());
        assert!(morph(&old, &grown, 2) != morph(&old, &grown, 1));
    }

    #[test]
    fn an_error_says_so() {
        let mut rv = Reveal::new("turn", true, false, false);
        rv.error = Some("that egg is gone".into());
        let f = at(&rv, 10);
        assert!(f.done && text(&f).contains("the egg did not hatch: that egg is gone"));
    }
}
