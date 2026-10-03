//! The terminal hn draws on: ratatui's crossterm backend, with colours written as tmux writes
//! them — the eight colours and their bright forms as SGR 30–37, 90–97 (40–47, 100–107 behind),
//! and so `colour0`–`colour15` too (terminfo's setaf/setab do that for the first sixteen),
//! `colourN` past them as 38;5;N, RGB as 38;2;R;G;B — where crossterm writes every colour as
//! 38;5;N, which an eight-colour terminal (the Linux console) does not read. Everything else is
//! crossterm's.

use std::io::{self, Write};

use ratatui::backend::{Backend, ClearType, CrosstermBackend, WindowSize};
use ratatui::buffer::Cell;
use ratatui::layout::{Position, Size};
use ratatui::style::{Color, Modifier};

/// [shadow]: every cell as last written, row by row — so a row whose width the terminal may
/// count otherwise can be written again whole.
pub struct TmuxBackend<W: Write> {
    inner: CrosstermBackend<W>,
    shadow: Vec<Vec<Cell>>,
    extra_shadow: std::collections::HashMap<(u16, u16), Extra>,
    /// A frame with several changes is one synchronized update (?2026), closed at its flush.
    syncing: bool,
    /// Whether that is done at all (`HARNESS_TUI_SYNC=off` turns it off).
    sync_ok: bool,
    /// The next clear-all writes the screen again row by row instead of erasing it first (see
    /// [`TmuxBackend::soft_clear_next`]); `force_whole` is that rewrite waiting for its draw.
    soft: bool,
    force_whole: bool,
    /// The cursor as last written: a frame that changes nothing writes nothing (an idle hn is
    /// silent, as tmux is — a terminal's or an outer tmux's activity mark stays clear).
    cursor_at: Option<Position>,
    cursor_shown: Option<bool>,
}

/// Whether a frame is wrapped in synchronized output (?2026): yes, unless `HARNESS_TUI_SYNC=off`
/// (a terminal that mishandles it, e.g. ghostty-org/ghostty discussion 12062).
fn sync_wanted(setting: &str) -> bool {
    !matches!(setting.to_ascii_lowercase().as_str(), "off" | "0" | "false")
}

/// A cluster whose width terminals may count otherwise than hn does: several code points (a
/// base and its marks, ZWJ emoji, a keycap, VS16), or a script whose vowels some count as
/// spacing and some as combining (Thai, Lao, Tibetan, Myanmar, Khmer).
fn risky(symbol: &str) -> bool {
    let mut n = 0;
    for c in symbol.chars() {
        n += 1;
        if n > 1 { return true }
        let u = c as u32;
        if (0x0E00..=0x0FFF).contains(&u) || (0x1000..=0x109F).contains(&u) || (0x1780..=0x17FF).contains(&u) { return true }
        // One code point, but terminals and unicode-width part on it: private-use icons (Nerd
        // Font), the arrows, shapes and dingbats of ambiguous width (⚡ ✓ ● ▶), and emoji.
        // Box-drawing and block characters (U+2500–259F) are every border's and count alike.
        if (0xE000..=0xF8FF).contains(&u) || (0xF0000..=0x10FFFF).contains(&u)
            || ((0x2190..=0x2BFF).contains(&u) && !(0x2500..=0x259F).contains(&u))
            || (0x1F000..=0x1FAFF).contains(&u) { return true }
    }
    false
}

/// What the terminal was last told: colours, attributes, the underline's style, the open link.
struct Pen { fg: Color, bg: Color, ul: Color, modifier: Modifier, style: u8, overline: bool, link: Option<std::sync::Arc<str>> }

impl Pen {
    fn new() -> Pen { Pen { fg: Color::Reset, bg: Color::Reset, ul: Color::Reset, modifier: Modifier::empty(), style: 0, overline: false, link: None } }

    /// A cell's attributes (as tmux's tty_attributes writes them) and its symbol.
    fn put(&mut self, w: &mut impl Write, cell: &Cell, extra: Option<&Extra>, usstyle: bool, links: bool) -> io::Result<()> {
        // The colours fitted to the terminal (tty_check_fg / _bg): a bright foreground where
        // there are only 8 colours is its plain colour, bold.
        let (fg, bold) = fit_bright(cell.fg);
        let (bg, ul) = (fit(cell.bg), fit(cell.underline_color));
        let modifier = if bold { cell.modifier | Modifier::BOLD } else { cell.modifier };
        if modifier != self.modifier {
            // tmux's tty_attributes: an attribute taken away resets everything, then what is
            // wanted is set again.
            if !(self.modifier - modifier).is_empty() {
                w.write_all(b"\x1b[0m")?;
                (self.fg, self.bg, self.ul, self.modifier, self.style, self.overline) = (Color::Reset, Color::Reset, Color::Reset, Modifier::empty(), 0, false);
            }
            for (flag, code) in ATTRS { if modifier.contains(flag) && !self.modifier.contains(flag) { write!(w, "\x1b[{code}m")?; if code == 4 { self.style = 1 } } }
            self.modifier = modifier;
        }
        // tty_attributes' Smulx: a curly (double, dotted, dashed) underline where the
        // terminal reads one, else a plain one.
        let want = if !cell.modifier.contains(Modifier::UNDERLINED) { 0 } else if usstyle { extra.map(|e| e.underline).filter(|u| *u >= 2).unwrap_or(1) } else { 1 };
        if want != self.style && want > 0 { if want == 1 { w.write_all(b"\x1b[4:1m")? } else { write!(w, "\x1b[4:{want}m")? } self.style = want }
        let overline = extra.is_some_and(|e| e.overline);
        if overline != self.overline { w.write_all(if overline { b"\x1b[53m" } else { b"\x1b[55m" })?; self.overline = overline; }
        if fg != self.fg { write!(w, "\x1b[{}m", sgr(fg, 30))?; self.fg = fg; }
        if bg != self.bg { write!(w, "\x1b[{}m", sgr(bg, 40))?; self.bg = bg; }
        if usstyle && ul != self.ul { write!(w, "\x1b[{}m", sgr_underline(ul))?; self.ul = ul; }
        // A link (OSC 8) opened where it starts and closed where it ends.
        let want_link = if links { extra.and_then(|e| e.link.clone()) } else { None };
        if want_link != self.link {
            match &want_link { Some(uri) => write!(w, "\x1b]8;;{uri}\x1b\\")?, None => w.write_all(b"\x1b]8;;\x1b\\")? }
            self.link = want_link;
        }
        // A cell is printed, never executed: a control character (a tab a pane's grid keeps, a
        // stray escape) would move the terminal's cursor where hn does not count it, and every
        // cell after it on the row would land elsewhere. It goes as the blank it stands for.
        let symbol = cell.symbol();
        if symbol.chars().any(char::is_control) { return w.write_all(b" ") }
        w.write_all(symbol.as_bytes())
    }

    /// Everything back to the terminal's defaults (and so known).
    fn reset(&mut self, w: &mut impl Write) -> io::Result<()> {
        if self.link.is_some() { w.write_all(b"\x1b]8;;\x1b\\")? }
        if self.fg != Color::Reset || self.bg != Color::Reset || self.ul != Color::Reset || !self.modifier.is_empty() || self.style != 0 || self.overline {
            w.write_all(b"\x1b[0m")?;
        }
        *self = Pen::new();
        Ok(())
    }
}

/// What a pane's cell carries that ratatui's cell cannot: its underline's style (2 double, 3
/// curly, 4 dotted, 5 dashed — tmux's 4:N) and its link (OSC 8). Kept by position for the frame
/// being drawn (ui's pane_body), and written with the cell when the outer terminal reads them.
#[derive(Clone, PartialEq, Default, Debug)]
pub struct Extra { pub underline: u8, pub overline: bool, pub link: Option<std::sync::Arc<str>> }

struct Frame { extras: std::collections::HashMap<(u16, u16), Extra>, usstyle: bool, links: bool }
static FRAME: std::sync::Mutex<Option<Frame>> = std::sync::Mutex::new(None);

/// A frame begins: no cell's extras yet, and what the outer terminal reads — styled and coloured
/// underlines (tmux's usstyle feature), links (hyperlinks).
pub fn begin_frame(usstyle: bool, links: bool) {
    if let Ok(mut f) = FRAME.lock() { *f = Some(Frame { extras: Default::default(), usstyle, links }) }
}

pub fn set_extra(x: u16, y: u16, extra: Extra) {
    if let Ok(mut f) = FRAME.lock() { if let Some(f) = f.as_mut() { f.extras.insert((x, y), extra); } }
}

/// An overlay owns its cells; pane metadata underneath must not bleed through it.
pub fn clear_extras(area: ratatui::layout::Rect) {
    if let Ok(mut frame) = FRAME.lock() { if let Some(frame) = frame.as_mut() {
        frame.extras.retain(|&(x, y), _| !area.contains(Position::new(x, y)));
    } }
}

/// Whether the outer terminal reads styled underlines with their colour (usstyle) and links
/// (hyperlinks): terminal-features for this TERM (as tmux's), else the terminals known to.
pub fn outer_features(features: &[String]) -> (bool, bool) {
    static KNOWN: std::sync::OnceLock<(String, bool)> = std::sync::OnceLock::new();
    let (term, known) = KNOWN.get_or_init(|| {
        let term = std::env::var("TERM").unwrap_or_default();
        let program = std::env::var("TERM_PROGRAM").unwrap_or_default();
        let known = matches!(program.as_str(), "iTerm.app" | "WezTerm" | "ghostty" | "vscode" | "tmux")
            || ["xterm-kitty", "xterm-ghostty", "wezterm", "alacritty", "foot", "tmux", "contour", "rio"].iter().any(|t| term.starts_with(t));
        (term, known)
    });
    // (A terminal that said what it is and has them: tmux's features for it.)
    let said = terminal_name().map(|n| n.to_lowercase()).is_some_and(|n| ["iterm2", "tmux", "wezterm", "foot", "kitty", "ghostty", "contour", "rio"].iter().any(|p| n.starts_with(p)));
    let (mut us, mut links) = (*known || said, *known || said);
    for f in features {
        let (pattern, rest) = f.split_once(':').unwrap_or((f.as_str(), ""));
        if !crate::cmd::fnmatch(pattern, term) { continue }
        for x in rest.split(':') { match x { "usstyle" => us = true, "hyperlinks" => links = true, _ => {} } }
    }
    (us, links)
}

impl<W: Write> TmuxBackend<W> {
    pub fn new(writer: W) -> Self {
        let sync_ok = sync_wanted(&std::env::var("HARNESS_TUI_SYNC").unwrap_or_default());
        Self { sync_ok, ..Self::with_sync(writer) }
    }

    fn with_sync(writer: W) -> Self { Self { inner: CrosstermBackend::new(writer), shadow: Vec::new(), extra_shadow: Default::default(), syncing: false, sync_ok: true, soft: false, force_whole: false, cursor_at: None, cursor_shown: None } }

    /// The next `clear()` does not erase the screen: every row is written again, each erased and
    /// rewritten in the same write, so a stale cell goes but the screen is never seen blank.
    pub fn soft_clear_next(&mut self) { self.soft = true }

    fn row_risky(&self, y: u16) -> bool { self.shadow.get(y as usize).map(|r| r.iter().any(|c| risky(c.symbol()))).unwrap_or(false) }

    fn remember(&mut self, x: u16, y: u16, cell: &Cell) {
        let (x, y) = (x as usize, y as usize);
        if self.shadow.len() <= y { self.shadow.resize(y + 1, Vec::new()) }
        // (A wide cluster covers the cells after it: ratatui blanks them and sends none.)
        let wide = unicode_width::UnicodeWidthStr::width(cell.symbol()).max(1);
        let row = &mut self.shadow[y];
        if row.len() < x + wide { row.resize(x + wide, Cell::default()) }
        row[x] = cell.clone();
        for c in &mut row[x + 1..x + wide] { *c = Cell::default() }
    }
}

/// What has been written to the terminal, in bytes (#{client_written}).
pub static WRITTEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The terminal's writer, its bytes counted.
pub struct Counted<W: Write>(pub W);

impl<W: Write> Write for Counted<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.0.write(buf)?;
        WRITTEN.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
        crate::verify::capture(&buf[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> { self.0.flush() }
}

impl<W: Write> Write for TmuxBackend<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> { self.cursor_at = None; self.inner.write(buf) }
    fn flush(&mut self) -> io::Result<()> { Write::flush(&mut self.inner) }
}

/// The mouse modes tmux asks the terminal for (tty_update_mode): presses, drags and SGR (1000,
/// 1002, 1006) — and every motion (1003) only while a pane or a menu wants it. 0 off, 1 on, 2 all.
pub struct Mouse(pub u8);

impl crossterm::Command for Mouse {
    fn write_ansi(&self, f: &mut impl std::fmt::Write) -> std::fmt::Result {
        f.write_str(match self.0 { 0 => "\x1b[?1006l\x1b[?1000l\x1b[?1002l\x1b[?1003l", 1 => "\x1b[?1003l\x1b[?1006h\x1b[?1000h\x1b[?1002h", _ => "\x1b[?1006h\x1b[?1000h\x1b[?1002h\x1b[?1003h" })
    }
    #[cfg(windows)]
    fn execute_winapi(&self) -> io::Result<()> { Ok(()) }
}

/// What the terminal said it is (XDA, `CSI > q`: `iTerm2 3.5.4`, `tmux 3.5a`, `kitty(0.36.4)`),
/// as tmux asks it at attach; None when it said nothing.
static TERMINAL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
static TERMINAL_ANSWERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Query without waiting: the normal input reader separates replies from typeahead.
/// OSC 11 (default background) is asked, and now OSC 10 (default foreground) too: hn reports
/// them to each machine's daemon (`theme_set`) so agent panes are painted to match, exactly as
/// the desktop app does. Asking OSC 10 is what keeps hn's chrome on the terminal's own
/// foreground (an ivory/cream), not a white computed from the background. OSC 4 asks the terminal's
/// own colours 1-7 too: with no theme chosen, hn's accent is one of them (`native_accent`), so the
/// focused pane, the current tab and the panels' marks are in the terminal's theme, not a fixed teal.
pub fn ask_terminal() {
    let mut out = io::stdout();
    let _ = out.write_all(b"\x1b[>q\x1b[c\x1b]11;?\x07\x1b]10;?\x07\x1b]4;1;?\x07\x1b]4;2;?\x07\x1b]4;3;?\x07\x1b]4;4;?\x07\x1b]4;5;?\x07\x1b]4;6;?\x07\x1b]4;7;?\x07");
    let _ = out.flush();
}

/// The terminal's colours 1-7 as it answered OSC 4 (`#rrggbb`), where it did.
static PALETTE: std::sync::RwLock<[Option<[u8; 3]>; 8]> = std::sync::RwLock::new([None; 8]);

/// Record an OSC 4 answer for colour [n] (1-7 are kept; the rest are not asked).
pub fn set_palette_colour(n: u8, colour: Option<String>) {
    let Some((r, g, b)) = colour.as_deref().and_then(hex_rgb) else { return };
    if (1..8).contains(&n) { if let Ok(mut p) = PALETTE.write() { p[n as usize] = Some([r, g, b]) } }
}

/// The accent the terminal's own theme gives, when it answered its colours and its background:
/// picked from colours 1-7 as a bundled theme's is (`theme::accent_of`).
pub fn native_accent() -> Option<[u8; 3]> {
    let (bg, _) = native_terminal_colours()?;
    let (r, g, b) = hex_rgb(&bg)?;
    let p = PALETTE.read().ok()?;
    let colours: Vec<(usize, [u8; 3])> = (1..8).filter_map(|i| p[i].map(|c| (i, c))).collect();
    // (Most of them, or it is not the terminal's palette speaking.)
    if colours.len() < 5 { return None }
    Some(crate::theme::accent_of([r, g, b], &colours))
}

pub fn terminal_answer(answer: Option<String>) -> bool {
    let first = !TERMINAL_ANSWERED.swap(true, std::sync::atomic::Ordering::Relaxed);
    answer.map(|name| TERMINAL.set(name).is_ok()).unwrap_or(false) || first
}

/// The terminal's own name for itself (XDA), when it gave one.
pub fn terminal_name() -> Option<&'static str> { TERMINAL.get().map(String::as_str) }

/// A terminal that says what it is and is one tmux gives 24-bit colour (tty_default_features:
/// iTerm2, tmux, WezTerm, foot, XTerm, mintty) — or one of today's that has it too.
fn modern_terminal() -> bool {
    let Some(name) = terminal_name() else { return false };
    let n = name.to_lowercase();
    ["iterm2", "tmux", "wezterm", "foot", "xterm(", "mintty", "kitty", "ghostty", "alacritty", "contour", "rio", "konsole", "xterm.js", "warp", "vte"].iter().any(|p| n.starts_with(p))
}

/// How many colours the terminal shows, as tmux reads it (terminfo's colors; 24-bit with RGB):
/// 0, 8, 16, 256, or 1 << 24.
static COLOURS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1 << 24);

pub fn set_colours(n: u32) { COLOURS.store(n, std::sync::atomic::Ordering::Relaxed) }

/// The terminal's own default background and foreground, from its OSC 10/11 answers, as
/// `#rrggbb` (bg, fg). None until the terminal answers. hn starts on top of the terminal, so
/// these are asked directly and answer reliably; the daemon uses them to paint agent panes.
#[derive(Clone)]
struct TerminalColours { bg: String, fg: String, foreground_reported: bool }
static TERMINAL_FG_BG: std::sync::RwLock<Option<TerminalColours>> = std::sync::RwLock::new(None);

fn hex_rgb(hex: &str) -> Option<(u8, u8, u8)> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 { return None }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some(((v >> 16) as u8, ((v >> 8) & 0xff) as u8, (v & 0xff) as u8))
}

/// A foreground that reads on the background: dark on light, light on dark.
fn companion_fg(bg: &str) -> String {
    let Some((r, g, b)) = hex_rgb(bg) else { return "#f5f5f5".into() };
    let lum = 0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64;
    if lum > 128.0 { "#1a1a1a".into() } else { "#f5f5f5".into() }
}

/// What the terminal answered for its default colours, (bg, fg) hex, when it answered.
/// A theme chosen in the settings (`@hn-theme`) stands in for them: hn's chrome, and the panes the
/// daemon paints, take the theme's background and foreground.
pub fn terminal_colours() -> Option<(String, String)> {
    if let Some(theme) = THEME_COLOURS.read().ok().and_then(|g| g.clone()) { return Some(theme) }
    TERMINAL_FG_BG.read().ok()?.as_ref().map(|c| (c.bg.clone(), c.fg.clone()))
}

/// The terminal's own answer, whatever theme is chosen (the settings' "Terminal default").
pub fn native_terminal_colours() -> Option<(String, String)> {
    TERMINAL_FG_BG.read().ok()?.as_ref().map(|c| (c.bg.clone(), c.fg.clone()))
}

/// The chosen theme's (background, foreground) as `#rrggbb`; None: the terminal's own.
static THEME_COLOURS: std::sync::RwLock<Option<(String, String)>> = std::sync::RwLock::new(None);

/// Tests that set hn's colours (a theme, an accent) or read them back hold this, one at a time:
/// the colours are one for the whole process, and tests run side by side.
#[cfg(test)]
pub fn colours_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether a theme's colours stand in for the terminal's now.
pub fn theme_chosen() -> bool { THEME_COLOURS.read().ok().is_some_and(|g| g.is_some()) }

/// Draw with a theme's colours (or, None, the terminal's again). True when that changed them.
pub fn set_theme_colours(colours: Option<(String, String)>) -> bool {
    let Ok(mut g) = THEME_COLOURS.write() else { return false };
    let changed = *g != colours;
    *g = colours;
    changed
}

/// The `[look]` accent (`@hn-accent`, a `#rrggbb`) to draw hn's chrome with, when the look names
/// one. Kept separate from the terminal palette because an accent is a choice, not a terminal
/// answer; `theme::accent()` consults it first and falls back to the derived teal.
static ACCENT_OVERRIDE: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

pub fn set_accent_override(hex: Option<String>) {
    if let Ok(mut g) = ACCENT_OVERRIDE.write() { *g = hex.map(normalise_hex_short) }
}

pub fn accent_override() -> Option<String> { ACCENT_OVERRIDE.read().ok()?.clone() }

/// Accept `#rgb` too (shorthand) by expanding it to `#rrggbb`, the form hn parses.
fn normalise_hex_short(hex: String) -> String {
    let h = hex.trim_start_matches('#');
    if h.len() == 3 { format!("#{}{}{}{}{}{}", &h[0..1], &h[0..1], &h[1..2], &h[1..2], &h[2..3], &h[2..3]) } else { hex }
}

#[cfg(test)]
mod accent_override_tests {
    use super::*;
    #[test]
    fn shorthand_accent_is_expanded_and_roundtrips() {
        let _colours = colours_lock();
        set_accent_override(Some("#7aa".into()));
        assert_eq!(normalise_hex_short("#7aa".into()), "#77aaaa");
        assert_eq!(accent_override().as_deref(), Some("#77aaaa"));
        set_accent_override(None);
        assert_eq!(accent_override(), None);
    }
}

/// Record an OSC 10/11 answer. A half left blank keeps the other (a terminal may answer bg only);
/// a missing foreground is chosen for contrast on the background.
pub fn set_terminal_colours(bg: Option<String>, fg: Option<String>) {
    if let Ok(mut guard) = TERMINAL_FG_BG.write() {
        *guard = updated_terminal_colours(guard.as_ref(), bg, fg);
    }
}

fn updated_terminal_colours(existing: Option<&TerminalColours>, bg: Option<String>, fg: Option<String>) -> Option<TerminalColours> {
    let foreground_reported = fg.is_some() || existing.is_some_and(|c| c.foreground_reported);
    let bg = bg.or_else(|| existing.map(|c| c.bg.clone()))?;
    let fg = fg.or_else(|| existing.filter(|c| c.foreground_reported).map(|c| c.fg.clone()))
        .unwrap_or_else(|| companion_fg(&bg));
    Some(TerminalColours { bg, fg, foreground_reported })
}

#[cfg(test)]
mod terminal_colour_tests {
    use super::*;

    #[test]
    fn a_background_change_recomputes_inferred_foreground_only() {
        let dark = updated_terminal_colours(None, Some("#101010".into()), None).unwrap();
        assert_eq!(dark.fg, "#f5f5f5");
        let light = updated_terminal_colours(Some(&dark), Some("#f7f7f7".into()), None).unwrap();
        assert_eq!(light.fg, "#1a1a1a");
        let own = updated_terminal_colours(Some(&light), None, Some("#202020".into())).unwrap();
        let next = updated_terminal_colours(Some(&own), Some("#eeeeee".into()), None).unwrap();
        assert_eq!(next.fg, "#202020");
    }
}

/// Whether the terminal's background is light, from its OSC 11 answer, when it answered.
pub fn terminal_is_light() -> Option<bool> {
    let (bg, _) = terminal_colours()?;
    let (r, g, b) = hex_rgb(&bg)?;
    Some(0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64 > 128.0)
}

/// The terminal's colours from its name and what it says of itself, and what the config says of
/// it: 24-bit with COLORTERM truecolor or 24bit, a `-direct` terminal, an explicit RGB
/// feature/override, or a recognized terminal name. A query still awaiting a reply leaves
/// the TERM entry's colour limit intact. Else 16 for a 16-colour one, 8 for xterm, screen,
/// linux and their kin, none for vt100 and dumb.
pub fn colours_for(term: &str, colorterm: &str, features: &[String], overrides: &[String]) -> u32 {
    let says = |list: &[String], caps: &[&str]| list.iter().any(|f| {
        let mut parts = f.split(':');
        let pat = parts.next().unwrap_or("");
        crate::cmd::fnmatch(pat, term) && parts.any(|c| caps.contains(&c.split('=').next().unwrap_or(c)))
    });
    if matches!(colorterm, "truecolor" | "24bit") || term.ends_with("-direct") || says(features, &["RGB"]) || says(overrides, &["Tc", "RGB"]) { return 1 << 24 }
    // What the terminal said it is, whatever TERM says (an old outer tmux's `screen`, TERM=xterm
    // over ssh from iTerm2): its features, as tmux adds them.
    if modern_terminal() { return 1 << 24 }
    if matches!(term, "xterm-kitty" | "xterm-ghostty" | "alacritty" | "wezterm" | "foot") { return 1 << 24 }
    // A missing or delayed capability reply is not evidence of RGB support.
    if term.contains("256color") { return 256 }
    if term.contains("16color") { return 16 }
    if term.is_empty() { return 256 }
    if matches!(term, "vt100" | "vt102" | "vt220" | "dumb") { return 0 }
    8
}

/// tmux's colour_find_rgb: the nearest of the 256 (the 6x6x6 cube, or the grey ramp).
fn find_rgb(r: u8, g: u8, b: u8) -> u8 {
    const Q2C: [i32; 6] = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
    let cube = |v: i32| if v < 48 { 0 } else if v < 114 { 1 } else { (v - 35) / 40 };
    let (r, g, b) = (r as i32, g as i32, b as i32);
    let (qr, qg, qb) = (cube(r), cube(g), cube(b));
    let (cr, cg, cb) = (Q2C[qr as usize], Q2C[qg as usize], Q2C[qb as usize]);
    if cr == r && cg == g && cb == b { return (16 + 36 * qr + 6 * qg + qb) as u8 }
    let avg = (r + g + b) / 3;
    let grey_idx = if avg > 238 { 23 } else { (avg - 3) / 10 };
    let grey = 8 + 10 * grey_idx;
    let dist = |x: i32, y: i32, z: i32| (x - r) * (x - r) + (y - g) * (y - g) + (z - b) * (z - b);
    if dist(grey, grey, grey) < dist(cr, cg, cb) { (232 + grey_idx) as u8 } else { (16 + 36 * qr + 6 * qg + qb) as u8 }
}

/// tmux's colour_256to16.
const TO16: [u8; 256] = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    0, 4, 4, 4, 12, 12, 2, 6, 4, 4, 12, 12, 2, 2, 6, 4,
    12, 12, 2, 2, 2, 6, 12, 12, 10, 10, 10, 10, 14, 12, 10, 10,
    10, 10, 10, 14, 1, 5, 4, 4, 12, 12, 3, 8, 4, 4, 12, 12,
    2, 2, 6, 4, 12, 12, 2, 2, 2, 6, 12, 12, 10, 10, 10, 10,
    14, 12, 10, 10, 10, 10, 10, 14, 1, 1, 5, 4, 12, 12, 1, 1,
    5, 4, 12, 12, 3, 3, 8, 4, 12, 12, 2, 2, 2, 6, 12, 12,
    10, 10, 10, 10, 14, 12, 10, 10, 10, 10, 10, 14, 1, 1, 1, 5,
    12, 12, 1, 1, 1, 5, 12, 12, 1, 1, 1, 5, 12, 12, 3, 3,
    3, 7, 12, 12, 10, 10, 10, 10, 14, 12, 10, 10, 10, 10, 10, 14,
    9, 9, 9, 9, 13, 12, 9, 9, 9, 9, 13, 12, 9, 9, 9, 9,
    13, 12, 9, 9, 9, 9, 13, 12, 11, 11, 11, 11, 7, 12, 10, 10,
    10, 10, 10, 14, 9, 9, 9, 9, 9, 13, 9, 9, 9, 9, 9, 13,
    9, 9, 9, 9, 9, 13, 9, 9, 9, 9, 9, 13, 9, 9, 9, 9,
    9, 13, 11, 11, 11, 11, 11, 15, 0, 0, 0, 0, 0, 0, 8, 8,
    8, 8, 8, 8, 7, 7, 7, 7, 7, 7, 15, 15, 15, 15, 15, 15,
];

/// A colour fitted to the terminal, as tty_check_fg / _bg fit it: 24-bit to the nearest of the
/// 256 where there is no 24-bit; 256 to 16 where there are fewer, the bright ones the aixterm
/// ones — or their plain colours where there are only 8; none at all where there is none.
pub fn fit(c: Color) -> Color { fit_bright(c).0 }

/// [fit], and whether a bright colour became a plain one (a foreground is then bold).
fn fit_bright(c: Color) -> (Color, bool) {
    let colours = COLOURS.load(std::sync::atomic::Ordering::Relaxed);
    if colours == 0 { return (Color::Reset, false) }
    let c = match c { Color::Rgb(r, g, b) if colours < (1 << 24) => Color::Indexed(find_rgb(r, g, b)), c => c };
    if colours >= 256 { return (c, false) }
    let plain = [Color::Black, Color::Red, Color::Green, Color::Yellow, Color::Blue, Color::Magenta, Color::Cyan, Color::Gray];
    let bright = [Color::DarkGray, Color::LightRed, Color::LightGreen, Color::LightYellow, Color::LightBlue, Color::LightMagenta, Color::LightCyan, Color::White];
    match c {
        // One of the 256: its nearest of the 16, a bright one plain where there are 8.
        Color::Indexed(n) => {
            let n = TO16[n as usize] as usize;
            (if n < 8 { plain[n] } else if colours >= 16 { bright[n - 8] } else { plain[n - 8] }, false)
        }
        // An aixterm colour (90–97) where there are 8: its plain colour, bright (bold).
        c => match bright.iter().position(|b| *b == c) { Some(n) if colours < 16 => (plain[n], true), _ => (c, false) },
    }
}

/// A colour's SGR parameters as tmux's tty_colours_fg / _bg write them ([base] 30, 40 or 58).
fn sgr(c: Color, base: u16) -> String {
    let named = |n: u16| (n + base).to_string();
    let bright = |n: u16| (n + base + 60).to_string();
    match c {
        Color::Reset => (base + 9).to_string(),
        Color::Black => named(0), Color::Red => named(1), Color::Green => named(2), Color::Yellow => named(3),
        Color::Blue => named(4), Color::Magenta => named(5), Color::Cyan => named(6), Color::Gray => named(7),
        Color::DarkGray => bright(0), Color::LightRed => bright(1), Color::LightGreen => bright(2), Color::LightYellow => bright(3),
        Color::LightBlue => bright(4), Color::LightMagenta => bright(5), Color::LightCyan => bright(6), Color::White => bright(7),
        // setaf's `%p1%{8}%<%t3%p1%d%e%p1%{16}%<%t9%p1%{8}%-%d%e38;5;%p1%d`.
        Color::Indexed(n) if n < 8 && base != 58 => named(n as u16),
        Color::Indexed(n) if n < 16 && base != 58 => bright(n as u16 - 8),
        Color::Indexed(n) => format!("{};5;{n}", base + 8),
        Color::Rgb(r, g, b) => format!("{};2;{r};{g};{b}", base + 8),
    }
}

/// The underline colour: 58;5;N or 58;2;R;G;B (a named one as its index), 59 for none.
fn sgr_underline(c: Color) -> String {
    match c {
        Color::Reset => "59".into(),
        Color::Indexed(n) => format!("58;5;{n}"),
        Color::Rgb(r, g, b) => format!("58;2;{r};{g};{b}"),
        named => {
            let order = [Color::Black, Color::Red, Color::Green, Color::Yellow, Color::Blue, Color::Magenta, Color::Cyan, Color::Gray,
                Color::DarkGray, Color::LightRed, Color::LightGreen, Color::LightYellow, Color::LightBlue, Color::LightMagenta, Color::LightCyan, Color::White];
            format!("58;5;{}", order.iter().position(|o| *o == named).unwrap_or(0))
        }
    }
}

const ATTRS: [(Modifier, u8); 9] = [
    (Modifier::BOLD, 1), (Modifier::DIM, 2), (Modifier::ITALIC, 3), (Modifier::UNDERLINED, 4), (Modifier::SLOW_BLINK, 5),
    (Modifier::RAPID_BLINK, 6), (Modifier::REVERSED, 7), (Modifier::HIDDEN, 8), (Modifier::CROSSED_OUT, 9),
];

impl<W: Write> Backend for TmuxBackend<W> {
    type Error = io::Error;

    fn draw<'a, I>(&mut self, content: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        let mut cells: Vec<(u16, u16, Cell)> = content.map(|(x, y, c)| (x, y, c.clone())).collect();
        let frame = FRAME.lock().ok();
        let frame = frame.as_ref().and_then(|f| f.as_ref());
        let extras = frame.map(|f| f.extras.clone()).unwrap_or_default();
        // Ratatui cannot compare underline styles, links or overline. Redraw those
        // cells even when their text and ordinary attributes have not changed.
        let changed: std::collections::HashSet<(u16, u16)> = self.extra_shadow.keys().chain(extras.keys()).copied()
            .filter(|p| self.extra_shadow.get(p) != extras.get(p)).collect();
        for (x, y) in changed {
            if cells.iter().any(|(cx, cy, _)| *cx == x && *cy == y) { continue }
            if let Some(cell) = self.shadow.get(y as usize).and_then(|row| row.get(x as usize)) { cells.push((x, y, cell.clone())); }
        }
        self.extra_shadow = extras;
        // Nothing changed: nothing written.
        let all = std::mem::take(&mut self.force_whole);
        if cells.is_empty() && !all { return Ok(()) }
        // A row that holds (or held) a cluster the terminal may count otherwise is written again
        // whole from its first column, as fzf writes a line: a cell-by-cell update there would
        // leave a stale character where the two counts part (a Thai vowel beside a keycap).
        let touched: std::collections::BTreeSet<u16> = cells.iter().map(|c| c.1).collect();
        let was: std::collections::HashSet<u16> = touched.iter().copied().filter(|y| self.row_risky(*y)).collect();
        for (x, y, c) in &cells { self.remember(*x, *y, c) }
        let mut whole: std::collections::BTreeSet<u16> = touched.into_iter().filter(|y| was.contains(y) || self.row_risky(*y)).collect();
        // A soft clear: every row of the screen (the terminal's height; else the rows known).
        if all {
            let rows = self.inner.size().map(|s| s.height as usize).unwrap_or(self.shadow.len()).max(self.shadow.len());
            whole.extend((0..rows).map(|y| y as u16));
        }
        // A single-cell update fits in the writer's one buffered flush; synchronizing it
        // adds sixteen bytes to an ordinary one-byte echo without hiding any redraw.
        if self.sync_ok && !self.syncing && (cells.len() > 1 || !whole.is_empty()) { self.inner.write_all(b"\x1b[?2026h")?; self.syncing = true }
        let (usstyle, links) = frame.map(|f| (f.usstyle, f.links)).unwrap_or((false, false));
        let extra_at = |x: u16, y: u16| frame.and_then(|f| f.extras.get(&(x, y)));
        // CrosstermBackend writes through to its writer.
        let w = &mut self.inner;
        let mut pen = Pen::new();
        for (x, y, cell) in cells.iter().filter(|c| !whole.contains(&c.1)) {
            // Printing advances the cursor. Keep that position across frames as well: an
            // ordinary echoed key needs neither a CUP before it nor one after it.
            if self.cursor_at != Some(Position::new(*x, *y)) { write!(w, "\x1b[{};{}H", y + 1, x + 1)?; }
            pen.put(w, cell, extra_at(*x, *y), usstyle, links)?;
            let width = unicode_width::UnicodeWidthStr::width(cell.symbol()).max(1) as u16;
            self.cursor_at = Some(Position::new(x.saturating_add(width), *y));
        }
        for y in whole {
            // A row of a soft clear with nothing on it is still erased: a stale cell may be there.
            let Some(row) = self.shadow.get(y as usize) else {
                if all { write!(w, "\x1b[{};1H", y + 1)?; pen.reset(w)?; w.write_all(b"\x1b[2K")?; self.cursor_at = None }
                continue
            };
            write!(w, "\x1b[{};1H", y + 1)?;
            self.cursor_at = Some(Position::new(0, y));
            pen.reset(w)?;
            w.write_all(b"\x1b[2K")?;
            let (mut skip, mut placed) = (0usize, true);
            for (x, cell) in row.iter().enumerate() {
                if skip > 0 { skip -= 1; continue }
                // After a cluster the terminal may have counted otherwise, the next cell goes
                // where hn counts it.
                if !placed { write!(w, "\x1b[{};{}H", y + 1, x + 1)?; }
                pen.put(w, cell, extra_at(x as u16, y), usstyle, links)?;
                let width = unicode_width::UnicodeWidthStr::width(cell.symbol()).max(1);
                skip = width - 1;
                placed = !risky(cell.symbol());
                self.cursor_at = placed.then(|| Position::new((x + width) as u16, y));
            }
        }
        // SGR 0 restores all three colours and attributes in one command; when they
        // are already default, a plain-text echo has nothing to restore.
        pen.reset(w)
    }

    fn hide_cursor(&mut self) -> io::Result<()> { if self.cursor_shown == Some(false) { return Ok(()) } self.cursor_shown = Some(false); self.inner.hide_cursor() }
    fn show_cursor(&mut self) -> io::Result<()> { if self.cursor_shown == Some(true) { return Ok(()) } self.cursor_shown = Some(true); self.inner.show_cursor() }
    // (Never asked of the terminal — \e[6n and a wait for its answer: hn draws the whole screen,
    // and a terminal slow to answer, or one that never does, must not stop it starting.)
    fn get_cursor_position(&mut self) -> io::Result<Position> { Ok(Position::ORIGIN) }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
        let p = position.into();
        if self.cursor_at == Some(p) { return Ok(()) }
        self.cursor_at = Some(p);
        self.inner.set_cursor_position(p)
    }
    fn clear(&mut self) -> io::Result<()> { self.shadow.clear(); self.extra_shadow.clear(); self.cursor_at = None; self.cursor_shown = None; self.inner.clear() }
    fn clear_region(&mut self, clear_type: ClearType) -> io::Result<()> {
        if matches!(clear_type, ClearType::All) {
            self.shadow.clear();
            self.extra_shadow.clear();
            // A soft clear forgets what was written but erases nothing: the draw that follows writes
            // every row, each erased and rewritten at once, so the screen is never seen blank.
            if std::mem::take(&mut self.soft) { self.cursor_at = None; self.force_whole = true; return Ok(()) }
        }
        self.inner.clear_region(clear_type)
    }
    fn append_lines(&mut self, n: u16) -> io::Result<()> { self.cursor_at = None; self.inner.append_lines(n) }
    fn size(&self) -> io::Result<Size> { self.inner.size() }
    fn window_size(&mut self) -> io::Result<WindowSize> { self.inner.window_size() }
    fn flush(&mut self) -> io::Result<()> {
        if std::mem::take(&mut self.syncing) { self.inner.write_all(b"\x1b[?2026l")? }
        Backend::flush(&mut self.inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_control_character_in_a_cell_is_never_sent_to_the_terminal() {
        // A tab written as a cell moves the terminal's cursor to its next tab stop: every cell after
        // it on the row, written without a cursor move, then lands to the right of where hn put it.
        use alacritty_terminal::index::{Column, Line};
        let mut written = Vec::new();
        let mut backend = TmuxBackend::with_sync(&mut written);
        let (mut a, mut tab, mut b) = (Cell::default(), Cell::default(), Cell::default());
        a.set_char('a'); tab.set_symbol("\t"); b.set_char('b');
        backend.draw([(0u16, 0u16, &a), (1, 0, &tab), (2, 0, &b)].into_iter()).unwrap();
        Backend::flush(&mut backend).unwrap();
        drop(backend);
        assert!(!written.contains(&b'\t'), "{:?}", String::from_utf8_lossy(&written));
        let mut pane = crate::pane::Pane::new(1, "m", "a", 20, 2);
        pane.feed(&written);
        assert_eq!(pane.term.grid()[Line(0)][Column(2)].c, 'b', "b lands where hn drew it");
    }

    #[test]
    fn a_soft_clear_writes_every_row_over_the_screen_without_erasing_it() {
        use alacritty_terminal::index::{Column, Line};
        let mut written = Vec::new();
        let mut backend = TmuxBackend::with_sync(&mut written);
        let (mut a, mut b) = (Cell::default(), Cell::default());
        a.set_char('a'); b.set_char('b');
        backend.draw([(0u16, 0u16, &a), (1, 0, &b)].into_iter()).unwrap();
        Backend::flush(&mut backend).unwrap();
        // The next frame is the same (so a normal draw would write nothing), but a cell the terminal
        // holds wrongly — a ghost — is the reason to write the screen again, and with no blank flash.
        backend.soft_clear_next();
        Backend::clear_region(&mut backend, ClearType::All).unwrap();
        backend.draw([(0u16, 0u16, &a), (1, 0, &b)].into_iter()).unwrap();
        Backend::flush(&mut backend).unwrap();
        drop(backend);
        let mut pane = crate::pane::Pane::new(1, "m", "a", 20, 4);
        // The terminal before the repaint: the first frame, and a stale X the backend never wrote.
        let first_len = written.iter().position(|&c| c == b'a').unwrap_or(0);
        let _ = first_len;
        pane.feed(b"\x1b[1;6HX\x1b[1;1H");
        pane.feed(&written);
        let text = String::from_utf8_lossy(&written);
        assert!(!text.contains("\x1b[2J"), "a soft clear must not erase the screen: {text:?}");
        assert_eq!(pane.term.grid()[Line(0)][Column(0)].c, 'a');
        assert_eq!(pane.term.grid()[Line(0)][Column(5)].c, ' ', "the stale cell was erased by its row being written again");
    }

    #[test]
    fn synchronized_output_is_on_unless_turned_off() {
        assert!(sync_wanted(""));
        assert!(sync_wanted("on"));
        assert!(!sync_wanted("off"));
        assert!(!sync_wanted("OFF"));
    }

    #[test]
    fn a_frame_is_not_wrapped_in_2026_when_it_is_left_out() {
        let draw = |sync_ok: bool| {
            let mut written = Vec::new();
            let mut backend = TmuxBackend::with_sync(&mut written);
            backend.sync_ok = sync_ok;
            let (mut a, mut b) = (Cell::default(), Cell::default());
            a.set_char('a'); b.set_char('b');
            backend.draw([(0u16, 0u16, &a), (1, 0, &b)].into_iter()).unwrap();
            Backend::flush(&mut backend).unwrap();
            drop(backend);
            String::from_utf8_lossy(&written).to_string()
        };
        assert!(draw(true).contains("\x1b[?2026h") && draw(true).contains("\x1b[?2026l"));
        assert!(!draw(false).contains("2026"));
    }

    #[test]
    fn single_symbols_terminals_count_otherwise_are_risky_too() {
        // Private-use icons (Nerd Font), arrows/shapes/dingbats of ambiguous width, and emoji
        // written as one code point: terminals disagree on their width as they do on clusters.
        for s in ["\u{e0a0}", "\u{f07b}", "\u{26a1}", "\u{2713}", "\u{25cf}", "\u{25b6}", "\u{1f44d}"] {
            assert!(risky(s), "{s:?} should be written with its row");
        }
        // Text, the box-drawing and block characters of every border, and wide CJK are counted alike everywhere.
        for s in ["a", "é", "中", "─", "│", "█", "▀"] {
            assert!(!risky(s), "{s:?} should stay a cell-by-cell update");
        }
    }

    #[test]
    fn plain_echo_keeps_the_printed_cursor_and_needs_few_bytes() {
        let mut written = Vec::new();
        let mut backend = TmuxBackend::new(&mut written);
        backend.set_cursor_position(Position::new(2, 1)).unwrap();
        let mut cell = Cell::default();
        cell.set_char('x');
        backend.draw(std::iter::once((2, 1, &cell))).unwrap();
        backend.set_cursor_position(Position::new(3, 1)).unwrap();
        Backend::flush(&mut backend).unwrap();
        drop(backend);
        let bytes = written.as_slice();
        assert!(bytes.len() <= 7, "one echoed key wrote {} bytes including its initial cursor", bytes.len());
        let mut pane = crate::pane::Pane::new(1, "m", "a", 20, 4);
        pane.feed(bytes);
        use alacritty_terminal::index::{Column, Line, Point};
        assert_eq!(pane.term.grid()[Line(1)][Column(2)].c, 'x');
        assert_eq!(pane.term.grid().cursor.point, Point::new(Line(1), Column(3)));
    }

    #[test]
    fn styled_frame_restores_colours_before_plain_echo() {
        let mut written = Vec::new();
        let mut backend = TmuxBackend::new(&mut written);
        let mut coloured = Cell::default();
        coloured.set_char('a').set_fg(Color::Red).set_bg(Color::Blue);
        backend.draw(std::iter::once((0, 0, &coloured))).unwrap();
        Backend::flush(&mut backend).unwrap();
        let mut plain = Cell::default();
        plain.set_char('b');
        backend.draw(std::iter::once((1, 0, &plain))).unwrap();
        Backend::flush(&mut backend).unwrap();
        let mut pane = crate::pane::Pane::new(1, "m", "a", 20, 4);
        drop(backend);
        pane.feed(&written);
        use alacritty_terminal::index::{Column, Line};
        use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor};
        let grid = pane.term.grid();
        assert_eq!(grid[Line(0)][Column(0)].fg, AnsiColor::Named(NamedColor::Red));
        assert_eq!(grid[Line(0)][Column(1)].fg, AnsiColor::Named(NamedColor::Foreground));
        assert_eq!(grid[Line(0)][Column(1)].bg, AnsiColor::Named(NamedColor::Background));
    }

    #[test]
    fn pane_attributes_are_written_and_reset_independently() {
        let mut written = Vec::new();
        let mut pen = Pen::new();
        let mut cell = Cell::default();
        cell.set_char('X').set_style(ratatui::style::Style::default().add_modifier(Modifier::UNDERLINED | Modifier::SLOW_BLINK));
        pen.put(&mut written, &cell, Some(&Extra { underline: 2, overline: true, link: None }), true, false).unwrap();
        // Removing only overline must not disturb blink or double underline.
        cell.set_char('Y');
        pen.put(&mut written, &cell, Some(&Extra { underline: 2, ..Default::default() }), true, false).unwrap();
        pen.reset(&mut written).unwrap();
        written.push(b'Z');
        let mut pane = crate::pane::Pane::new(1, "local", "rendered", 20, 4);
        pane.feed(&written);
        use alacritty_terminal::{index::{Column, Line}, term::cell::Flags};
        assert!(pane.term.grid()[Line(0)][Column(0)].flags.contains(Flags::DOUBLE_UNDERLINE | Flags::BLINK | Flags::OVERLINE));
        assert!(pane.term.grid()[Line(0)][Column(1)].flags.contains(Flags::DOUBLE_UNDERLINE | Flags::BLINK));
        assert!(!pane.term.grid()[Line(0)][Column(1)].flags.contains(Flags::OVERLINE));
        assert_eq!(pane.term.grid()[Line(0)][Column(2)].flags, Flags::empty());
    }

    #[test]
    fn colours_as_tmux_writes_them() {
        assert_eq!(super::find_rgb(255, 128, 0), 208);
        assert_eq!(super::find_rgb(0, 64, 128), 24);
        assert_eq!(super::TO16[208], 9);
        assert_eq!(super::colours_for("xterm-16color", "", &[], &[]), 16);
        assert_eq!(super::colours_for("xterm-256color", "", &[], &[]), 256);
        assert_eq!(super::colours_for("screen-256color", "", &[], &[]), 256);
        assert_eq!(super::colours_for("xterm-256color", "truecolor", &[], &[]), 1 << 24);
        assert_eq!(super::colours_for("xterm-256color", "", &["xterm*:RGB".to_string()], &[]), 1 << 24);
        assert_eq!(super::colours_for("xterm", "", &[], &[]), 8);
        assert_eq!(super::colours_for("vt100", "", &[], &[]), 0);
        assert_eq!(sgr(Color::Red, 30), "31");
        assert_eq!(sgr(Color::Green, 40), "42");
        assert_eq!(sgr(Color::LightBlue, 30), "94");
        assert_eq!(sgr(Color::White, 40), "107");
        assert_eq!(sgr(Color::Reset, 40), "49");
        // The first sixteen of the 256 as terminfo's setaf/setab write them (\e[38;5;1m → 31).
        assert_eq!(sgr(Color::Indexed(1), 30), "31");
        assert_eq!(sgr(Color::Indexed(9), 30), "91");
        assert_eq!(sgr(Color::Indexed(4), 40), "44");
        assert_eq!(sgr(Color::Indexed(12), 40), "104");
        assert_eq!(sgr(Color::Indexed(16), 30), "38;5;16");
        assert_eq!(sgr(Color::Rgb(1, 2, 3), 40), "48;2;1;2;3");
    }
}
