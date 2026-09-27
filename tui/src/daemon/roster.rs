//! daemons/roster.json and daemons/banner.json, read once (`include_str!`): the art, the rules and
//! the lines every client draws from. Never edited here — `node daemons/tools/generate.mjs` checks
//! the roster, and `render::tests` checks this port against daemons/frames.json. The filled
//! daemons' baked plates, and every egg's, are daemons/plates.json, read in `plates.rs`. A plate
//! species' trait catalogue (`traits`) is what an individual's seed rolls from (render.rs).

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

pub const ROSTER_JSON: &str = include_str!("../../../daemons/roster.json");
pub const BANNER_JSON: &str = include_str!("../../../daemons/banner.json");

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Roster {
    pub rules: Rules,
    pub drops: Vec<DropDef>,
    pub daemons: Vec<Daemon>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    pub eyes: HashMap<String, String>,
    /// ack, look, slow: each a list of (lid, ms).
    pub blinks: HashMap<String, Vec<(String, u64)>>,
    pub no_blink_moods: Vec<String>,
    pub hold_ms: HashMap<String, u64>,
    pub back_frame_ms: u64,
    pub versions: Vec<String>,
    pub bond: Bond,
    pub status_cells: usize,
    pub first_egg: FirstEgg,
    pub setup_egg: SetupEgg,
    pub eggs: HashMap<String, EggDef>,
    pub earn: Earn,
    /// An egg in the status line, a line per stage (`{k}` the kind's mark), and `blink`.
    pub egg_line: HashMap<String, String>,
    /// How plates are baked and inked (drop `init`'s filled daemons, and the eggs).
    pub plate: PlateRules,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlateRules {
    /// The columns each size is baked at (`portrait` 28, `reveal` 56). (Its frameMs is plates.json's.)
    pub cols: HashMap<String, usize>,
    /// Each glyph's brightness: at most 1 mixes from the background toward the row colour, above 1
    /// on toward white. A space is not drawn.
    pub ink: HashMap<String, f64>,
    /// The light inside an egg: `plain` while it is earned, the rarity's once opened, and `peek`,
    /// the eyes in a ready egg's chip.
    pub light: HashMap<String, Colour>,
    /// An individual's odd eye.
    pub odd_eye: Colour,
    /// How long each stage of an egg's opening takes.
    pub egg_ms: EggMs,
    /// The rows an individual's canvas may add above its species' (a hat, long tufts).
    #[serde(default)]
    pub room: usize,
}

/// rules.plate.eggMs: a waiting egg's loop, and the opening's stages.
#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct EggMs { pub r#loop: u64, pub rock: u64, pub burst_hold: u64, pub burst: u64, pub tumble: u64, pub open: u64 }

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bond { pub levels: Vec<u64> }

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FirstEgg {
    pub need: usize,
    #[serde(default)]
    pub require: Vec<String>,
    pub habits: Vec<Habit>,
}

#[derive(Deserialize, Debug)]
pub struct Habit { pub key: String, pub label: String }

#[derive(Deserialize, Debug)]
pub struct SetupEgg { pub need: usize }

/// An egg kind: its mark in the status line, its shell's gradient and (the night egg) its stars.
#[derive(Deserialize, Debug)]
pub struct EggDef {
    pub mark: String,
    pub gradient: Gradient,
    #[serde(default)]
    pub stars: Option<Colour>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Earn { pub turn: EarnTurn, pub week: EarnDays, pub marathon: EarnTurns, pub night: EarnNights }

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EarnTurn { pub every: u64, pub daily_cap: u64 }

#[derive(Deserialize, Debug)]
pub struct EarnDays { pub days: u64 }

#[derive(Deserialize, Debug)]
pub struct EarnTurns { pub turns: u64 }

#[derive(Deserialize, Debug)]
pub struct EarnNights { pub nights: u64 }

#[derive(Deserialize, Debug, Clone)]
pub struct DropDef {
    pub id: String,
    pub n: u32,
    pub name: String,
    #[serde(default)]
    pub announce: Option<String>,
    #[serde(default)]
    pub release: Option<String>,
    /// On hold: no dates, never drawn, hatched or shown anywhere.
    #[serde(default)]
    pub hold: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Colour { pub xterm: u8, pub hex: String }

/// A plate's colour, top row to bottom row.
#[derive(Deserialize, Debug, Clone)]
pub struct Gradient { pub top: Colour, pub bottom: Colour }

#[derive(Deserialize, Debug)]
pub struct Part { pub rest: String, pub work: Vec<String>, pub ms: u64 }

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Daemon {
    pub id: String,
    pub drop: String,
    pub rarity: String,
    pub color: Colour,
    #[serde(default)]
    pub shiny: Option<Colour>,
    /// (name, year): screen -> tmux -> tim.
    pub family: Vec<(String, serde_json::Value)>,
    pub lore: String,
    pub first: String,
    pub sprites: HashMap<String, String>,
    pub work: Vec<String>,
    pub work_ms: u64,
    /// Line art, one per version drawn. A filled daemon has none: its portraits are plates.
    #[serde(default)]
    pub portraits: HashMap<String, Vec<String>>,
    /// Drawn filled (plates.json), in its gradient; the status line keeps the one-line sprite.
    #[serde(default)]
    pub plate: bool,
    #[serde(default)]
    pub gradient: Option<Gradient>,
    #[serde(default)]
    pub shiny_gradient: Option<Gradient>,
    #[serde(default)]
    pub parts: HashMap<String, Part>,
    #[serde(default)]
    pub mood_parts: HashMap<String, HashMap<String, String>>,
    #[serde(default)]
    pub eyes: Option<HashMap<String, String>>,
    #[serde(default)]
    pub lid: Option<String>,
    /// The grue: pitch black wherever it is drawn.
    #[serde(default)]
    pub dark_only: bool,
    /// A plate species' trait catalogue: what an individual's seed rolls from.
    #[serde(default)]
    pub traits: Option<Catalogue>,
}

/// A species' trait catalogue (daemons/README.md "Individuals"), in the roster's order.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Catalogue {
    /// Colour families; the first is the species' gradient.
    #[serde(deserialize_with = "colours")]
    pub colours: Vec<Family>,
    /// Markings; None is none.
    #[serde(deserialize_with = "weighted")]
    pub marks: Vec<(Option<String>, f64)>,
    /// Rare extras (None is none): their colour and status-line variant.
    #[serde(deserialize_with = "extras")]
    pub extras: Vec<Extra>,
    /// Proportions, each a range around 1, in catalogue order (the roll draws them in it).
    #[serde(deserialize_with = "ordered")]
    pub props: Vec<(String, (f64, f64))>,
    /// A proportion's flag near an end of its range.
    #[serde(default)]
    pub flags: HashMap<String, PropFlag>,
    /// The colours markings are painted in.
    pub accents: Vec<String>,
    pub odd_eye: f64,
    pub fidgety: f64,
}

#[derive(Debug, Clone)]
pub struct Family { pub name: String, pub weight: f64, pub top: String, pub bottom: String }

#[derive(Debug)]
pub struct Extra { pub name: Option<String>, pub weight: f64, pub hex: Option<String>, pub look: Option<ExtraLook> }

/// A rare extra's one-line variant, in the species' sprite contract.
#[derive(Deserialize, Debug)]
pub struct ExtraLook { pub sprites: HashMap<String, String>, pub work: Vec<String> }

#[derive(Deserialize, Debug, Default)]
pub struct PropFlag { #[serde(default)] pub high: Option<String>, #[serde(default)] pub low: Option<String> }

fn colours<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Family>, D::Error> {
    let rows: Vec<(String, f64, String, String)> = Deserialize::deserialize(d)?;
    Ok(rows.into_iter().map(|(name, weight, top, bottom)| Family { name, weight, top, bottom }).collect())
}

fn weighted<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<(Option<String>, f64)>, D::Error> { Deserialize::deserialize(d) }

fn extras<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Extra>, D::Error> {
    use serde::de::Error;
    let rows: Vec<Vec<serde_json::Value>> = Deserialize::deserialize(d)?;
    rows.into_iter().map(|row| {
        let name = row.first().and_then(|v| v.as_str()).map(str::to_string);
        let weight = row.get(1).and_then(serde_json::Value::as_f64).ok_or_else(|| D::Error::custom("an extra's weight"))?;
        let hex = row.get(2).and_then(|v| v.as_str()).map(str::to_string);
        let look = match row.get(3) { Some(v) => Some(serde_json::from_value(v.clone()).map_err(D::Error::custom)?), None => None };
        Ok(Extra { name, weight, hex, look })
    }).collect()
}

/// A JSON object's entries in the order they are written (serde_json's own map sorts its keys).
fn ordered<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<(String, (f64, f64))>, D::Error> {
    struct V;
    impl<'de> serde::de::Visitor<'de> for V {
        type Value = Vec<(String, (f64, f64))>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("proportions, { key: [lo, hi] }") }
        fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::new();
            while let Some((k, v)) = map.next_entry::<String, (f64, f64)>()? { out.push((k, v)) }
            Ok(out)
        }
    }
    d.deserialize_map(V)
}

#[derive(Deserialize, Debug)]
pub struct Banner {
    pub rows: usize,
    pub gap: usize,
    pub glyphs: HashMap<String, Vec<String>>,
}

pub fn roster() -> &'static Roster {
    static R: OnceLock<Roster> = OnceLock::new();
    R.get_or_init(|| serde_json::from_str(ROSTER_JSON).expect("daemons/roster.json"))
}

pub fn banner() -> &'static Banner {
    static B: OnceLock<Banner> = OnceLock::new();
    B.get_or_init(|| serde_json::from_str(BANNER_JSON).expect("daemons/banner.json"))
}

impl Roster {
    pub fn daemon(&self, id: &str) -> Option<&Daemon> { self.daemons.iter().find(|d| d.id == id) }

    /// The index of a version (`0.1` → 0), else the youngest.
    pub fn version_index(&self, version: &str) -> usize { self.rules.versions.iter().position(|v| v == version).unwrap_or(0) }

    /// A daemon of a drop on hold: kept in the roster, never shown anywhere (a record of one in a
    /// zoo is passed over as a name the roster does not know).
    pub fn held(&self, d: &Daemon) -> bool { self.drops.iter().any(|x| x.id == d.drop && x.hold) }

    /// A daemon hn may show: known, and not of a drop on hold.
    pub fn shown(&self, id: &str) -> Option<&Daemon> { self.daemon(id).filter(|d| !self.held(d)) }
}

impl Daemon {
    /// Its colour on the terminal background: the shiny one when it is shiny.
    pub fn colour(&self, shiny: bool) -> u8 { if shiny { self.shiny.as_ref().map(|s| s.xterm).unwrap_or(self.color.xterm) } else { self.color.xterm } }

    /// A plate's gradient: the shiny one (every shiny in drop `init` is gold) when it is shiny.
    pub fn gradient(&self, shiny: bool) -> Option<&Gradient> {
        if shiny { self.shiny_gradient.as_ref().or(self.gradient.as_ref()) } else { self.gradient.as_ref() }
    }

    /// `screen -> tmux -> tim`.
    pub fn lineage(&self) -> String { self.family.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(" -> ") }

    /// A colour family of its catalogue, by name.
    pub fn family(&self, name: &str) -> Option<&Family> { self.traits.as_ref()?.colours.iter().find(|c| c.name == name) }
}
