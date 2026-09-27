//! daemons/plates.json, read once (`include_str!`, parsed the first time a plate is drawn): every
//! frame of drop `init`'s filled daemons, baked by daemons/tools/bake.mjs at two sizes — `portrait`
//! (28 columns, at most 12 rows: the zoo, a duplicate's growth, the card) and `reveal` (56 columns,
//! at most 24 rows: the hatch, when the terminal has room). hn never runs a model; it prints the text.
//!
//! And the colour every client gives a plate (daemons/README.md "Plate colour", bake.mjs
//! `plateColor`): row r of R takes mix(top, bottom, r / (R - 1)) of the daemon's gradient (the shiny
//! one when shiny); a glyph's ink level at most 1 mixes from the background toward the row colour, above
//! 1 on toward white. In truecolor hn prints that colour glyph by glyph (the tests match frames.json
//! `plateColors`); with 256 colours the row's nearest xterm index, SGR dim below 0.6 and bold above 1;
//! with 16, the nearest base colour the same way; NO_COLOR, the plain text.
//!
//! The eggs are baked there too, every kind through every stage with a material per cell (`g` glow,
//! `s` star, `p` peek), and coloured by bake.mjs `eggColor`; an individual's own plates come from
//! harnessd with their materials (`m` a marking, `a` the extra, `e` the odd eye), coloured by
//! `individualColor` — and until they arrive the species plate is painted in the individual's colour
//! family. Both are drawn as a `Paint`: each cell's base colour, inked by its glyph the same way.

use std::collections::HashMap;
use std::sync::OnceLock;

use ratatui::style::{Color, Modifier, Style};
use serde::Deserialize;

use super::render::Traits;
use super::roster::{roster, Daemon, Gradient};

pub const PLATES_JSON: &str = include_str!("../../../daemons/plates.json");

/// The two sizes a plate is baked at.
pub const PORTRAIT: &str = "portrait";
pub const REVEAL: &str = "reveal";

/// The reference background faint glyphs mix from (bake.mjs, frames.json `plateColors`).
pub const BG: [u8; 3] = [0x0c, 0x0c, 0x0c];

/// id → size → version → mood → frames, each frame its rows joined by `\n`, all rows one width.
type Baked = HashMap<String, HashMap<String, HashMap<String, HashMap<String, Vec<String>>>>>;

/// One frame of a plate with its material rows: `.` the body or the shell, else a material's letter.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Framed { pub rows: String, pub mats: String }

impl Framed {
    pub fn rows(&self) -> Vec<String> { self.rows.split('\n').map(str::to_string).collect() }
    pub fn mats(&self) -> Vec<String> { self.mats.split('\n').map(str::to_string).collect() }
}

/// kind → size → stage → frames.
type Eggs = HashMap<String, HashMap<String, HashMap<String, Vec<Framed>>>>;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Plates {
    pub frame_ms: u64,
    pub daemons: Baked,
    #[serde(default)]
    pub eggs: Eggs,
}

pub fn plates() -> &'static Plates {
    static P: OnceLock<Plates> = OnceLock::new();
    P.get_or_init(|| serde_json::from_str(PLATES_JSON).expect("daemons/plates.json"))
}

/// A daemon's loop at a size, version and mood: the nearest version baked (as portraits fall
/// back), and idle for a mood it has none of. Empty for a daemon drawn in line art.
pub fn frames(id: &str, size: &str, version: &str, mood: &str) -> &'static [String] {
    let Some(by_version) = plates().daemons.get(id).and_then(|s| s.get(size)) else { return &[] };
    let versions = &roster().rules.versions;
    let at = versions.iter().position(|v| v == version).unwrap_or(0);
    let pick = by_version.get(version).or_else(|| {
        // The nearest baked at or below it, else the youngest baked.
        versions[..=at.min(versions.len() - 1)].iter().rev().chain(versions.iter()).find_map(|v| by_version.get(v))
    });
    let Some(by_mood) = pick else { return &[] };
    by_mood.get(mood).or_else(|| by_mood.get("idle")).map(Vec::as_slice).unwrap_or(&[])
}

/// One frame (wrapping around its loop) as rows, all one width.
pub fn rows(id: &str, size: &str, version: &str, mood: &str, frame: usize) -> Vec<String> {
    let f = frames(id, size, version, mood);
    if f.is_empty() { return Vec::new() }
    f[frame % f.len()].split('\n').map(str::to_string).collect()
}

/// The frame `t` ms into a loop of `n`: one every frameMs. (Reduce Motion, or a card: frame 0.)
pub fn frame_at(t: u64, n: usize) -> usize { if n == 0 { 0 } else { ((t / plates().frame_ms.max(1)) as usize) % n } }

/// How long until the frame after the one `t` ms in: when a popup animating a plate draws again.
pub fn next_frame_in(t: u64) -> u64 { let ms = plates().frame_ms.max(1); ms - t % ms }

/// An egg's frames at a size and stage (`p0` to `p4`, `rock`, `burst`, `tumble`, `open`): every
/// stage of one kind and size shares one crop, so nothing jumps as it opens.
pub fn egg_frames(kind: &str, size: &str, stage: &str) -> &'static [Framed] {
    plates().eggs.get(kind).and_then(|s| s.get(size)).and_then(|s| s.get(stage)).map(Vec::as_slice).unwrap_or(&[])
}

/// One egg frame (wrapping around its loop).
pub fn egg_frame(kind: &str, size: &str, stage: &str, frame: usize) -> Option<&'static Framed> {
    let f = egg_frames(kind, size, stage);
    (!f.is_empty()).then(|| &f[frame % f.len()])
}

/// A plate's frames as harnessd draws an individual's (`daemon_plate`): rows with their materials.
#[derive(Clone, Debug, PartialEq)]
pub struct Art { pub frames: Vec<Framed>, pub frame_ms: u64 }

impl Art {
    pub fn frame(&self, i: usize) -> Option<&Framed> { (!self.frames.is_empty()).then(|| &self.frames[i % self.frames.len()]) }
}

// ── colour ────────────────────────────────────────────────────────────────────

fn rgb(hex: &str) -> [u8; 3] {
    let n = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0);
    [(n >> 16) as u8, (n >> 8) as u8, n as u8]
}

/// `Math.round(v + (b - v) * t)`, a channel at a time, as bake.mjs mixes.
fn mix(a: [u8; 3], b: [u8; 3], t: f64) -> [u8; 3] {
    let m = |x: u8, y: u8| (x as f64 + (y as f64 - x as f64) * t).round().clamp(0.0, 255.0) as u8;
    [m(a[0], b[0]), m(a[1], b[1]), m(a[2], b[2])]
}

pub fn hex(c: [u8; 3]) -> String { format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]) }

/// Row r of a plate of `rows`: its place down the gradient.
pub fn row_rgb(g: &Gradient, rows: usize, r: usize) -> [u8; 3] {
    mix(rgb(&g.top.hex), rgb(&g.bottom.hex), if rows > 1 { r as f64 / (rows - 1) as f64 } else { 0.0 })
}

/// bake.mjs `inked`: a base colour as a glyph of it is drawn — at most 1 mixes from the background
/// toward it, above 1 on toward white.
pub fn inked(base: [u8; 3], ch: char, bg: [u8; 3]) -> Option<[u8; 3]> {
    let level = level(ch)?;
    Some(if level > 1.0 { mix(base, [255, 255, 255], level - 1.0) } else { mix(bg, base, level) })
}

/// The light an egg's glow shows: `plain` while it is earned, the rarity's once it opens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Light<'a> { pub name: &'a str, pub dim: bool }

/// bake.mjs `eggColor`, before its ink: a glow cell is the light, a peek cell `light.peek`, a star
/// the kind's stars (a secret's opening takes them to 0.3), the shell its row down the kind's
/// gradient (a secret's opening, 0.22 of it).
pub fn egg_base(kind: &str, rows: usize, r: usize, mat: char, light: Light, bg: [u8; 3]) -> Option<[u8; 3]> {
    let rules = &roster().rules;
    let egg = rules.eggs.get(kind)?;
    let l = &rules.plate.light;
    Some(match mat {
        'g' => rgb(&l.get(light.name).or_else(|| l.get("plain"))?.hex),
        'p' => rgb(&l.get("peek")?.hex),
        's' => { let star = rgb(&egg.stars.as_ref().unwrap_or(&egg.gradient.top).hex); if light.dim { mix(bg, star, 0.3) } else { star } }
        _ => { let row = row_rgb(&egg.gradient, rows, r); if light.dim { mix(bg, row, 0.22) } else { row } }
    })
}

/// bake.mjs `eggColor`: the colour of one glyph of an egg plate.
pub fn egg_rgb(kind: &str, rows: usize, r: usize, ch: char, mat: char, light: Light, bg: [u8; 3]) -> Option<[u8; 3]> {
    inked(egg_base(kind, rows, r, mat, light, bg)?, ch, bg)
}

/// bake.mjs `individualColor`, before its ink: a marking (`m`) its accent, the extra (`a`) the extra's
/// colour, the odd eye (`e`) rules.plate.oddEye, the body its row down its colour family (a shiny
/// one's, the species' shiny gradient).
pub fn individual_base(d: &Daemon, traits: &Traits, rows: usize, r: usize, mat: char, shiny: bool) -> Option<[u8; 3]> {
    Some(match mat {
        'm' => rgb(&traits.accent),
        'a' => rgb(d.traits.as_ref()?.extras.iter().find(|e| e.name.is_some() && e.name == traits.extra)?.hex.as_deref()?),
        'e' => rgb(&roster().rules.plate.odd_eye.hex),
        _ => family_row(d, traits, rows, r, shiny)?,
    })
}

/// Row r of an individual's body: down its colour family, or the shiny gradient.
pub fn family_row(d: &Daemon, traits: &Traits, rows: usize, r: usize, shiny: bool) -> Option<[u8; 3]> {
    if shiny { return Some(row_rgb(d.gradient(true)?, rows, r)) }
    let f = d.family(&traits.colour)?;
    Some(mix(rgb(&f.top), rgb(&f.bottom), if rows > 1 { r as f64 / (rows - 1) as f64 } else { 0.0 }))
}

/// bake.mjs `individualColor`: the colour of one glyph of an individual's plate.
pub fn individual_rgb(d: &Daemon, traits: &Traits, rows: usize, r: usize, ch: char, mat: char, shiny: bool, bg: [u8; 3]) -> Option<[u8; 3]> {
    inked(individual_base(d, traits, rows, r, mat, shiny)?, ch, bg)
}

/// A glyph's ink level (rules.plate.ink); None for a space or anything that is not ink.
pub fn level(ch: char) -> Option<f64> {
    let mut b = [0u8; 4];
    roster().rules.plate.ink.get(ch.encode_utf8(&mut b) as &str).copied()
}

/// bake.mjs `plateColor`: the colour of one glyph of a plate of `rows`, on `bg`.
pub fn glyph_rgb(d: &Daemon, rows: usize, r: usize, ch: char, bg: [u8; 3], shiny: bool) -> Option<[u8; 3]> {
    inked(row_rgb(d.gradient(shiny)?, rows, r), ch, bg)
}

/// The nearest xterm-256 colour: the 6x6x6 cube's or the grey ramp's, whichever is closer.
pub fn nearest_xterm(c: [u8; 3]) -> u8 {
    const LEVELS: [u8; 6] = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
    let near = |v: u8| (0..6).min_by_key(|&i| (LEVELS[i] as i32 - v as i32).abs()).unwrap_or(0);
    let (r, g, b) = (near(c[0]), near(c[1]), near(c[2]));
    let dist = |x: [u8; 3]| (0..3).map(|i| (x[i] as i32 - c[i] as i32).pow(2)).sum::<i32>();
    let cube = [LEVELS[r], LEVELS[g], LEVELS[b]];
    let avg = (c[0] as i32 + c[1] as i32 + c[2] as i32) / 3;
    let step = ((avg - 8 + 5) / 10).clamp(0, 23);
    let grey = (8 + 10 * step) as u8;
    if dist([grey; 3]) < dist(cube) { 232 + step as u8 } else { (16 + 36 * r + 6 * g + b) as u8 }
}

/// How this terminal shows colour: as hn decides for its own chrome (NO_COLOR, COLORTERM, TERM).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode { Plain, Truecolor, Xterm, Basic }

impl Mode {
    pub fn now() -> Mode {
        if crate::theme::no_color() { return Mode::Plain }
        match crate::theme::depth() { d if d >= 1 << 24 => Mode::Truecolor, d if d >= 256 => Mode::Xterm, _ => Mode::Basic }
    }
}

/// Where a plate's row is drawn: whose (its place in the roster), shiny or not, row `row` of `rows`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlateInk { pub daemon: u16, pub shiny: bool, pub row: u16, pub rows: u16 }

impl PlateInk {
    pub fn of(d: &Daemon, shiny: bool, row: usize, rows: usize) -> PlateInk {
        let at = roster().daemons.iter().position(|x| x.id == d.id).unwrap_or(0);
        PlateInk { daemon: at as u16, shiny, row: row as u16, rows: rows as u16 }
    }

    /// Every row of a plate in its ink.
    pub fn rows(d: &Daemon, shiny: bool, rows: Vec<String>) -> Vec<(String, PlateInk)> {
        let n = rows.len();
        rows.into_iter().enumerate().map(|(i, r)| (r, PlateInk::of(d, shiny, i, n))).collect()
    }

    /// Same plate (the rows of one block).
    pub fn same_plate(&self, other: &PlateInk) -> bool { self.daemon == other.daemon && self.rows == other.rows }
}

/// A glyph of a plate's row as this terminal draws it; None for a space or anything not ink (a
/// card's border), which keeps the row's own style.
pub fn style(ink: PlateInk, ch: char, mode: Mode) -> Option<Style> {
    let d = roster().daemons.get(ink.daemon as usize)?;
    glyph_style(row_rgb(d.gradient(ink.shiny)?, ink.rows as usize, ink.row as usize), ch, mode)
}

/// A glyph of a base colour as this terminal draws it (the README's terminal rule): in truecolor its
/// exact colour, inked; with 256 or 16 colours the base's nearest, SGR dim below 0.6 and bold above
/// 1; NO_COLOR, plain. None for a space or anything not ink.
pub fn glyph_style(base: [u8; 3], ch: char, mode: Mode) -> Option<Style> {
    let level = level(ch)?;
    if mode == Mode::Plain { return Some(Style::default()) }
    if mode == Mode::Truecolor {
        let [red, green, blue] = inked(base, ch, BG)?;
        return Some(Style::default().fg(Color::Rgb(red, green, blue)));
    }
    let fg = if mode == Mode::Xterm { Color::Indexed(nearest_xterm(base)) } else { crate::theme::depth_fit(Color::Rgb(base[0], base[1], base[2])) };
    let mut s = Style::default().fg(fg);
    if level < 0.6 { s = s.add_modifier(Modifier::DIM) }
    if level > 1.0 { s = s.add_modifier(Modifier::BOLD) }
    Some(s)
}

/// A row painted cell by cell: each cell's base colour (None: not ink), inked by its glyph as it is
/// drawn. An egg's row, an individual's (its own art, or its species' painted in its colour family).
/// `block` names the art the row belongs to, so the rows of one art are laid out together.
#[derive(Clone, Debug, PartialEq)]
pub struct Paint { pub block: u32, pub cells: Vec<Option<[u8; 3]>> }

impl Paint {
    /// The same row, `n` cells further right.
    pub fn shifted(&self, n: usize) -> Paint {
        let mut cells = vec![None; n];
        cells.extend(self.cells.iter().copied());
        Paint { block: self.block, cells }
    }

    pub fn style(&self, col: usize, ch: char, mode: Mode) -> Option<Style> { glyph_style((*self.cells.get(col)?)?, ch, mode) }
}

/// An egg frame's rows, painted (`light` in its glow).
pub fn paint_egg(kind: &str, f: &Framed, light: Light, block: u32) -> Vec<(String, Paint)> {
    let (rows, mats) = (f.rows(), f.mats());
    let n = rows.len();
    rows.into_iter().enumerate().map(|(r, row)| {
        let m: Vec<char> = mats.get(r).map(|m| m.chars().collect()).unwrap_or_default();
        let cells = row.chars().enumerate().map(|(c, ch)| if ch == ' ' { None } else { egg_base(kind, n, r, m.get(c).copied().unwrap_or('.'), light, BG) }).collect();
        (row, Paint { block, cells })
    }).collect()
}

/// An individual's plate rows, painted: with its materials (its own art), or without (the species
/// plate in its colour family).
pub fn paint_individual(d: &Daemon, traits: &Traits, shiny: bool, rows: Vec<String>, mats: Option<Vec<String>>, block: u32) -> Vec<(String, Paint)> {
    let n = rows.len();
    rows.into_iter().enumerate().map(|(r, row)| {
        let m: Vec<char> = mats.as_ref().and_then(|m| m.get(r)).map(|m| m.chars().collect()).unwrap_or_default();
        let cells = row.chars().enumerate().map(|(c, ch)| if ch == ' ' { None } else { individual_base(d, traits, n, r, m.get(c).copied().unwrap_or('.'), shiny) }).collect();
        (row, Paint { block, cells })
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::super::render::tests::frames as reference;
    use super::*;

    #[test]
    fn every_filled_daemon_is_baked_at_both_sizes() {
        let r = roster();
        let filled: Vec<&Daemon> = r.daemons.iter().filter(|d| d.plate).collect();
        assert_eq!(filled.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["tim", "gnu", "lynx", "mutt", "yak", "gopher", "bug", "tux", "auk", "beastie"]);
        for d in filled {
            assert!(d.portraits.is_empty() && d.gradient.is_some() && d.shiny_gradient.is_some(), "{}", d.id);
            for (size, cols, max) in [(PORTRAIT, 28, 12), (REVEAL, 56, 24)] {
                for v in &r.rules.versions {
                    assert_eq!(frames(&d.id, size, v, "idle").len(), 8, "{} {size} {v}", d.id);
                    assert_eq!(frames(&d.id, size, v, "work").len(), 4);
                    let first = rows(&d.id, size, v, "idle", 0);
                    assert!(!first.is_empty() && first.len() <= max);
                    // One crop for every mood and frame: nothing jumps.
                    for mood in ["idle", "work", "need", "nap"] {
                        for i in 0..frames(&d.id, size, v, mood).len() {
                            let f = rows(&d.id, size, v, mood, i);
                            assert_eq!(f.len(), first.len());
                            assert!(f.iter().all(|row| row.len() == first[0].len() && row.len() <= cols));
                        }
                    }
                }
            }
        }
        // Line art has no plate; a mood with no loop of its own is idle's.
        assert!(frames("tmux", PORTRAIT, "2.0", "idle").is_empty());
        assert_eq!(frames("tim", PORTRAIT, "2.0", "bogus"), frames("tim", PORTRAIT, "2.0", "idle"));
    }

    #[test]
    fn a_frame_every_frame_ms() {
        assert_eq!(plates().frame_ms, 170);
        assert_eq!((frame_at(0, 8), frame_at(169, 8), frame_at(170, 8), frame_at(170 * 9, 8)), (0, 0, 1, 1));
        assert_eq!(frame_at(500, 0), 0);
        assert_eq!((next_frame_in(0), next_frame_in(100)), (170, 70));
    }

    #[test]
    fn every_plate_colour_in_frames_json_in_truecolor() {
        let r = roster();
        let mut n = 0;
        for c in reference()["plateColors"].as_array().unwrap() {
            let d = r.daemon(c["id"].as_str().unwrap()).unwrap();
            let shiny = c["shiny"].as_bool().unwrap();
            assert_eq!(c["bg"].as_str(), Some(hex(BG).as_str()));
            let plate = rows(&d.id, c["size"].as_str().unwrap(), c["v"].as_str().unwrap(), c["mood"].as_str().unwrap(), c["frame"].as_u64().unwrap() as usize);
            assert_eq!(plate.len() as u64, c["rows"].as_u64().unwrap());
            for cell in c["cells"].as_array().unwrap() {
                let (row, col) = (cell["r"].as_u64().unwrap() as usize, cell["c"].as_u64().unwrap() as usize);
                let ch = cell["ch"].as_str().unwrap().chars().next().unwrap();
                assert_eq!(plate[row].as_bytes()[col] as char, ch, "{} {row},{col}", d.id);
                let want = cell["hex"].as_str().unwrap();
                assert_eq!(glyph_rgb(d, plate.len(), row, ch, BG, shiny).map(hex).as_deref(), Some(want), "{} shiny={shiny} {row},{col} {ch}", d.id);
                // What hn prints for it, in truecolor.
                let ink = PlateInk::of(d, shiny, row, plate.len());
                let [red, green, blue] = rgb(want);
                assert_eq!(style(ink, ch, Mode::Truecolor), Some(Style::default().fg(Color::Rgb(red, green, blue))));
                n += 1;
            }
        }
        assert!(n > 1000, "{n} cells");
    }

    #[test]
    fn every_egg_colour_in_frames_json_in_truecolor() {
        let mut n = 0;
        for c in reference()["eggColors"].as_array().unwrap() {
            let kind = c["kind"].as_str().unwrap();
            let f = egg_frame(kind, c["size"].as_str().unwrap(), c["stage"].as_str().unwrap(), c["frame"].as_u64().unwrap() as usize).unwrap();
            let (rows, mats) = (f.rows(), f.mats());
            assert_eq!(rows.len() as u64, c["rows"].as_u64().unwrap());
            let light = Light { name: c["light"].as_str().unwrap(), dim: c["dim"].as_bool().unwrap() };
            let painted = paint_egg(kind, f, light, 1);
            for cell in c["cells"].as_array().unwrap() {
                let (row, col) = (cell["r"].as_u64().unwrap() as usize, cell["c"].as_u64().unwrap() as usize);
                let ch = cell["ch"].as_str().unwrap().chars().next().unwrap();
                let mat = cell["mat"].as_str().unwrap().chars().next().unwrap();
                assert_eq!((rows[row].as_bytes()[col] as char, mats[row].as_bytes()[col] as char), (ch, mat), "{kind} {row},{col}");
                let want = cell["hex"].as_str().unwrap();
                assert_eq!(egg_rgb(kind, rows.len(), row, ch, mat, light, BG).map(hex).as_deref(), Some(want), "{kind} {light:?} {row},{col} {ch}{mat}");
                // What hn prints for it, in truecolor.
                let [red, green, blue] = rgb(want);
                assert_eq!(painted[row].1.style(col, ch, Mode::Truecolor), Some(Style::default().fg(Color::Rgb(red, green, blue))));
                n += 1;
            }
        }
        assert!(n > 500, "{n} cells");
    }

    #[test]
    fn every_individual_colour_in_frames_json_in_truecolor() {
        let r = roster();
        let mut n = 0;
        for c in reference()["individualColors"].as_array().unwrap() {
            let d = r.daemon(c["id"].as_str().unwrap()).unwrap();
            let traits = super::super::render::roll_traits(r, &d.id, c["traits"]["seed"].as_u64().unwrap()).unwrap();
            // The case paints a marking, an extra and an odd eye on the first seed's roll.
            let traits = Traits { marks: c["traits"]["marks"].as_str().map(str::to_string), extra: c["traits"]["extra"].as_str().map(str::to_string), odd_eye: c["traits"]["oddEye"].as_bool().unwrap(), ..traits };
            assert_eq!(traits.to_json(), c["traits"]);
            let shiny = c["shiny"].as_bool().unwrap();
            let rows: Vec<String> = c["rows"].as_str().unwrap().split('\n').map(str::to_string).collect();
            let mats: Vec<String> = c["mats"].as_str().unwrap().split('\n').map(str::to_string).collect();
            let painted = paint_individual(d, &traits, shiny, rows.clone(), Some(mats.clone()), 1);
            for cell in c["cells"].as_array().unwrap() {
                let (row, col) = (cell["r"].as_u64().unwrap() as usize, cell["c"].as_u64().unwrap() as usize);
                let ch = cell["ch"].as_str().unwrap().chars().next().unwrap();
                let mat = cell["mat"].as_str().unwrap().chars().next().unwrap();
                assert_eq!(mats[row].as_bytes()[col] as char, mat);
                let want = cell["hex"].as_str().unwrap();
                assert_eq!(individual_rgb(d, &traits, rows.len(), row, ch, mat, shiny, BG).map(hex).as_deref(), Some(want), "{} shiny={shiny} {row},{col} {ch}{mat}", d.id);
                let [red, green, blue] = rgb(want);
                assert_eq!(painted[row].1.style(col, ch, Mode::Truecolor), Some(Style::default().fg(Color::Rgb(red, green, blue))));
                n += 1;
            }
        }
        assert!(n > 500, "{n} cells");
    }

    #[test]
    fn every_egg_is_baked_through_every_stage() {
        let r = roster();
        for kind in r.rules.eggs.keys() {
            for (size, cols) in [(PORTRAIT, 28), (REVEAL, 56)] {
                let first = egg_frame(kind, size, "p0", 0).unwrap().rows();
                for (stage, n) in [("p0", 8), ("p1", 1), ("p2", 1), ("p3", 1), ("p4", 8), ("rock", 8), ("burst", 6), ("tumble", 8), ("open", 1)] {
                    assert_eq!(egg_frames(kind, size, stage).len(), n, "{kind} {size} {stage}");
                    // One crop for the kind and size: nothing jumps as it opens.
                    for f in egg_frames(kind, size, stage) {
                        let (rows, mats) = (f.rows(), f.mats());
                        assert_eq!((rows.len(), mats.len()), (first.len(), first.len()));
                        assert!(rows.iter().zip(&mats).all(|(a, m)| a.len() == first[0].len() && m.len() == a.len() && a.len() <= cols));
                    }
                }
            }
        }
        // At 256 colours an egg's glow is its light's xterm colour; the shell its row's.
        let f = egg_frame("first", REVEAL, "p4", 0).unwrap();
        let painted = paint_egg("first", f, Light { name: "plain", dim: false }, 1);
        let mats = f.mats();
        let (row, col) = mats.iter().enumerate().find_map(|(r, m)| m.find('g').map(|c| (r, c))).unwrap();
        let ch = f.rows()[row].as_bytes()[col] as char;
        assert_eq!(painted[row].1.style(col, ch, Mode::Xterm).and_then(|s| s.fg), Some(Color::Indexed(230)));
        assert_eq!(painted[row].1.style(col, ch, Mode::Plain), Some(Style::default()));
        // Shifted right by a centring pad, a cell keeps its colour.
        let moved = painted[row].1.shifted(3);
        assert_eq!(moved.style(col + 3, ch, Mode::Xterm), painted[row].1.style(col, ch, Mode::Xterm));
        assert_eq!(moved.style(0, '#', Mode::Xterm), None);
    }

    #[test]
    fn at_256_colours_the_row_colour_dim_and_bold() {
        let r = roster();
        let tim = r.daemon("tim").unwrap();
        // The stops are xterm colours: the top row is the top's index, the bottom row the bottom's.
        for d in r.daemons.iter().filter(|d| d.plate) {
            for g in [d.gradient(false).unwrap(), d.gradient(true).unwrap()] {
                assert_eq!(nearest_xterm(rgb(&g.top.hex)), g.top.xterm, "{}", d.id);
                assert_eq!(nearest_xterm(rgb(&g.bottom.hex)), g.bottom.xterm, "{}", d.id);
            }
        }
        let top = PlateInk::of(tim, false, 0, 11);
        let bottom = PlateInk::of(tim, false, 10, 11);
        assert_eq!(style(top, '#', Mode::Xterm), Some(Style::default().fg(Color::Indexed(213))));
        assert_eq!(style(bottom, '%', Mode::Xterm), Some(Style::default().fg(Color::Indexed(134))));
        assert_eq!(style(top, '.', Mode::Xterm), Some(Style::default().fg(Color::Indexed(213)).add_modifier(Modifier::DIM)));
        assert_eq!(style(top, 'o', Mode::Xterm), Some(Style::default().fg(Color::Indexed(213))));
        assert_eq!(style(top, '@', Mode::Xterm), Some(Style::default().fg(Color::Indexed(213)).add_modifier(Modifier::BOLD)));
        // Shiny is gold.
        assert_eq!(style(PlateInk::of(tim, true, 0, 11), '#', Mode::Xterm), Some(Style::default().fg(Color::Indexed(229))));
        // Between the stops: the nearest xterm colour of the mixed row.
        assert_eq!(hex(row_rgb(tim.gradient(false).unwrap(), 3, 1)), "#d773eb");
        assert_eq!(nearest_xterm([0xd7, 0x73, 0xeb]), 170);
        assert_eq!(nearest_xterm([0x80, 0x80, 0x80]), 244);
        assert_eq!(nearest_xterm([0, 0, 0]), 16);
        // NO_COLOR: the plain text. A space, or a card's border, is not ink.
        assert_eq!(style(top, '@', Mode::Plain), Some(Style::default()));
        assert_eq!(style(top, ' ', Mode::Truecolor), None);
        assert_eq!(style(top, '|', Mode::Xterm), None);
    }
}
