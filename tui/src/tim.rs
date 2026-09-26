//! tim, the creature: the same six species and twelve moods as the desktop's companion
//! (desktop/lib/state/workspace_companion.dart — keep the faces in step), eight cells in the
//! status line, before the clock. An egg until a harness finishes a turn while you watch; then one
//! species, drawn once and kept. Its face is the fleet's mood. `set -g @tim off` hides it.

use std::path::PathBuf;
use std::time::Instant;

use ratatui::style::{Color, Modifier, Style};
use serde_json::{json, Value};

use crate::app::App;
use crate::fleet::State;

/// Moods, in the desktop's order (the index into each species' faces). The terminal shows the
/// ones the fleet gives it; the rest are the desktop's (petting, play) and kept for the order.
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mood { Content = 0, Curious, Focused, Waiting, Happy, Celebrating, Puzzled, Grumpy, Sad, Startled, Affectionate, Asleep }

const SPECIES: [(&str, [&str; 12]); 6] = [
    ("cat", [r"=^o.o^=", r"=^o.o^=?", r"=^>.<^=", r"=^o_o^=", r"=^n.n^=", r"=^*.*^=", r"=^o.O^=", r"=^>_>^=", r"=^;.;^=", r"=^O.O^=", r"=^u.u^=", r"=^-.-^="]),
    ("mouse", [r"<:3)~~~", r"<o3)~~?", r"<.3)---", r"<:3)__~", r"<^3)~~~", r"<*3)~~!", r"<o3)~?~", r"<-3)===", r"<;3)___", r"<O3)!!!", r"<^3)~~<3", r"<-3)___"]),
    ("snail", [r"__@/oo", r"__@/oO", r"__@/..", r"___@/oo", r"__@/^^", r"~_@/^^!", r"__@/o?", r"__@/--", r"__@/;;", r"__@/OO!", r"__@/uu", r"__@___z"]),
    ("fish", [r"><(o)>", r"><(o)>?", r"><(.)>", r"><(o)>.", r"><(^)>", r"><(*)>o", r"><(?)>", r"><(-)>", r"><(;)>", r"><(O)>!", r"><(u)><3", r"><(-)>z"]),
    ("spider", [r"/\oo/\", r"/\oO/\", r"/\../\", r"/_oo_\", r"/\^^/\", r"\/^^\/", r"/\o?/\", r"/\--/\", r"/_;;_\", r"\\OO//", r"/\uu/\", r"/_--_\"]),
    ("bat", [r"\^oo^/", r"\^oO^/", r"\^..^/", r"/^oo^\", r"\^nn^/", r"\^**^/", r"\^o?^/", r"\^--^/", r"/^;;^\", r"\^OO^/", r"\^uu^/", r"/^--^\"]),
];

const EGG: &str = r"\_O_/";

pub struct Tim {
    pub species: Option<usize>,
    pub off: bool,
    /// When a turn last finished (a short happy face).
    pub cheered: Option<Instant>,
    /// The last key (asleep after 15 minutes without one).
    pub touched: Instant,
}

fn path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".harness").join("tui").join("tim.json")
}

impl Tim {
    pub fn load() -> Tim {
        let saved: Value = std::fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let species = saved.get("species").and_then(Value::as_str).and_then(|s| SPECIES.iter().position(|(n, _)| *n == s));
        Tim { species, off: saved.get("off").and_then(Value::as_bool).unwrap_or(false), cheered: None, touched: Instant::now() }
    }

    fn save(&self) {
        let body = json!({ "name": "tim", "species": self.species.map(|i| SPECIES[i].0), "off": self.off });
        let _ = std::fs::create_dir_all(path().parent().unwrap_or(&PathBuf::from(".")));
        let _ = std::fs::write(path(), body.to_string());
    }

    /// A turn finished: the egg hatches (the first time), and tim is pleased for a moment.
    pub fn turn_done(&mut self) {
        if self.species.is_none() {
            let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
            self.species = Some(seed as usize % SPECIES.len());
            self.save();
        }
        self.cheered = Some(Instant::now());
    }

    pub fn set_off(&mut self, off: bool) { self.off = off; self.save() }

    pub fn species_name(&self) -> &'static str { self.species.map(|i| SPECIES[i].0).unwrap_or("egg") }
}

/// What the fleet feels like, as a mood: someone waiting on you wins, then work, then rest.
pub fn mood(app: &App) -> Mood {
    let tim = &app.tim;
    if app.daemon_down { return Mood::Puzzled }
    if app.fleet.waiting() > 0 { return Mood::Waiting }
    if tim.cheered.map(|t| t.elapsed().as_secs() < 20).unwrap_or(false) { return Mood::Happy }
    if tim.touched.elapsed().as_secs() > 15 * 60 { return Mood::Asleep }
    let working = app.fleet.agents.values().any(|a| matches!(app.fleet.state_of(a), State::Working));
    if working { Mood::Focused } else { Mood::Content }
}

/// tim's face and colour for the status line (None when hidden).
pub fn face(app: &App) -> Option<(String, Style)> {
    if app.tim.off { return None }
    let plain = crate::theme::no_color();
    let style = |c: Color| if plain { Style::default() } else { Style::default().fg(c) };
    let Some(i) = app.tim.species else { return Some((EGG.to_string(), style(Color::Yellow))) };
    let m = mood(app);
    let color = match m { Mood::Waiting => Color::LightYellow, Mood::Puzzled | Mood::Grumpy => Color::Red, Mood::Asleep => Color::DarkGray, _ => Color::Green };
    let st = if m == Mood::Asleep { style(color).add_modifier(Modifier::DIM) } else { style(color) };
    Some((SPECIES[i].1[m as usize].to_string(), st))
}

/// One line about tim, for `hn tim` and #{tim}.
pub fn line(app: &App) -> String {
    match face(app) {
        Some((f, _)) => format!("{f}  tim · {} · {:?}", app.tim.species_name(), if app.tim.species.is_some() { mood(app) } else { Mood::Content }).to_lowercase(),
        None => "tim is hidden (set -g @tim on)".into(),
    }
}

/// `hn tim`, from a shell: tim as saved (no fleet to read, so content).
pub fn cli_line() -> String {
    let t = Tim::load();
    if t.off { return "tim is hidden (set -g @tim on)".into() }
    match t.species { Some(i) => format!("{}  tim · {}", SPECIES[i].1[0], SPECIES[i].0), None => format!("{EGG}  tim · an egg — it hatches when a harness finishes a turn while hn is open") }
}
