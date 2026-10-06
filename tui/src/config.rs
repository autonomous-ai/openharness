//! `~/.config/harness/tui.toml` — the person's own keys, a few switches, and the look of hn.
//!
//! ```toml
//! prefix = "ctrl+a"              # instead of ctrl+space
//! prefix2 = "C-b"                # a second one (⌘ keys reach only some terminals)
//!
//! [prefix_keys]                  # after the prefix (Alt-k in the command panel writes these)
//! "h" = "new-harness"
//! "N" = "none"
//! desk = "read"                  # sync | read | off   (as HARNESS_TUI_DESK)
//! predict = "off"                # auto | always | off (as HARNESS_TUI_PREDICT)
//! notify = false                 # OS notifications through the terminal
//!
//! [keys]
//! "alt+h" = "none"               # give ⌥h back to the pane (vim, readline…)
//! "alt+x" = "close-pane"
//! "super+k" = "palette"
//!
//! [look]
//! preset = "classic"            # classic|panes|tmux|vim|lazyvim — a named bundle
//! focus = "line"                # line|surface — a highlighted border vs the "blurred" surface
//! border_lines = "single"      # single|double|heavy|simple|number
//! border_indicators = "colour" # off|colour|arrows|both
//! border_status = "off"        # off|top|bottom (each pane's title row)
//! layout_orientation = "auto"  # auto|vertical|horizontal (default split direction)
//! layout_preset = "auto"       # auto|even-horizontal|even-vertical|main-horizontal|main-vertical|tiled
//! # optional color overrides (#rrggbb or a tmux colour name)
//! # active_border = "#7aa2f7"
//! # border = "#3b4261"
//! # accent = "#7aa2f7"
//! ```
//!
//! Every `[look]` field is optional: an unset one falls back to the preset (or hn's default).
//! The file is a startup default — `hn set -g` afterward still wins.
//!
//! A key names modifiers (`ctrl` `alt` `shift` `super`, joined by `+`) and one key: a character,
//! or `enter` `tab` `esc` `space` `backspace` `left` `right` `up` `down` `pageup` `pagedown`
//! `home` `end` `f1`…`f12`. A command is anything ⌥P's `>` lists by id (see `harness tui --keys`),
//! or `none` to leave the chord to the pane. Environment variables win over the file.

use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chord { pub code: KeyCode, pub mods: KeyModifiers }

impl Chord {
    /// A key typed as itself — no Ctrl, ⌥ or ⌘ (Shift alone still types): `a`, `` ` ``, Enter, F12.
    pub fn plain(&self) -> bool { !self.mods.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) }

    /// One spelling per key: letters lower-case with SHIFT as a modifier; a shifted symbol (`{`,
    /// `?`) is its own character, without SHIFT.
    pub fn normal(code: KeyCode, mods: KeyModifiers) -> Chord {
        let mods = mods.intersection(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SHIFT | KeyModifiers::SUPER);
        match code {
            KeyCode::Char(c) if mods.contains(KeyModifiers::CONTROL) => Chord { code: KeyCode::Char(if mods.contains(KeyModifiers::SHIFT) { c } else { c.to_ascii_lowercase() }), mods },
            KeyCode::Char(c) if c.is_alphabetic() && c.is_uppercase() => Chord { code: KeyCode::Char(c.to_ascii_lowercase()), mods: mods | KeyModifiers::SHIFT },
            // A mouse key (tmux's MouseDown1Pane…) keeps S- as tmux's does.
            KeyCode::Char(c) if !c.is_alphabetic() && !crate::keys::is_mouse(&code) => Chord { code: KeyCode::Char(c), mods: mods - KeyModifiers::SHIFT },
            other => Chord { code: other, mods },
        }
    }

    /// A key from the terminal, as tmux names what it sent: 0x1c–0x1f (crossterm's C-4 … C-7)
    /// are C-\ C-] C-^ C-_, and BTab has no S- (crossterm's reads S-BTab).
    pub fn of(key: &KeyEvent) -> Chord {
        let code = match key.code {
            KeyCode::Char(c @ '4'..='7') if key.modifiers.contains(KeyModifiers::CONTROL) => KeyCode::Char(['\\', ']', '^', '_'][(c as u8 - b'4') as usize]),
            code => code,
        };
        let mods = if code == KeyCode::BackTab { key.modifiers - KeyModifiers::SHIFT } else { key.modifiers };
        Chord::normal(code, mods)
    }

    pub fn parse(text: &str) -> Result<Chord, String> {
        let text = text.trim().to_lowercase();
        let parts: Vec<&str> = if text.ends_with("++") { let mut p: Vec<&str> = text[..text.len() - 2].split('+').collect(); p.push("+"); p } else { text.split('+').collect() };
        let (key, mods) = parts.split_last().ok_or_else(|| format!("empty key {text:?}"))?;
        let mut m = KeyModifiers::NONE;
        for part in mods {
            m |= match *part {
                "ctrl" | "control" | "c" => KeyModifiers::CONTROL,
                "alt" | "opt" | "option" | "meta" | "m" => KeyModifiers::ALT,
                "shift" | "s" => KeyModifiers::SHIFT,
                "super" | "cmd" | "command" | "d" => KeyModifiers::SUPER,
                other => return Err(format!("unknown modifier {other:?} in {text:?}")),
            };
        }
        let code = match *key {
            "enter" | "return" => KeyCode::Enter,
            "tab" => KeyCode::Tab,
            "esc" | "escape" => KeyCode::Esc,
            "space" => KeyCode::Char(' '),
            "backspace" => KeyCode::Backspace,
            "left" => KeyCode::Left, "right" => KeyCode::Right, "up" => KeyCode::Up, "down" => KeyCode::Down,
            "pageup" => KeyCode::PageUp, "pagedown" => KeyCode::PageDown, "home" => KeyCode::Home, "end" => KeyCode::End,
            k if k.len() > 1 && k.starts_with('f') && k[1..].parse::<u8>().is_ok() => KeyCode::F(k[1..].parse().unwrap()),
            k if k.chars().count() == 1 => KeyCode::Char(k.chars().next().unwrap()),
            other => return Err(format!("unknown key {other:?} in {text:?}")),
        };
        Ok(Chord::normal(code, m))
    }
}

/// The one place the look/theme of hn is configured — a named preset plus per-knob overrides.
/// Every field is optional: unset fields fall back to the preset (or hn's default look).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Look {
    /// The named look: `classic` (default) | `panes` | `tmux` | `vim` | `lazyvim`.
    pub preset: Option<String>,
    /// Pane focus: `line` (active pane's border is highlighted) | `surface` ("blur": the active
    /// pane's surface pops and the rest are dimmed, no border line).
    pub focus: Option<String>,
    /// `pane-border-lines`: single | double | heavy | simple | number.
    pub border_lines: Option<String>,
    /// `pane-border-indicators`: off | colour | arrows | both.
    pub border_indicators: Option<String>,
    /// `pane-border-status` (each pane's title row): off | top | bottom.
    pub border_status: Option<String>,
    /// Default split direction for a new harness/pane: auto | vertical | horizontal.
    pub layout_orientation: Option<String>,
    /// The layout arranged when a tab has several panes: auto | even-horizontal | even-vertical
    /// | main-horizontal | main-vertical | tiled.
    pub layout_preset: Option<String>,
    /// Optional color overrides (`#rrggbb` or a tmux colour name).
    pub active_border: Option<String>,
    pub border: Option<String>,
    pub accent: Option<String>,
    /// A bundled terminal theme picked from `hn theme` (one of hn's bundled theme names). hn
    /// draws its palette from the terminal, so the theme's colours show up there; hn only records
    /// the choice here (and tints its chrome with the theme's signature colour) so it survives a
    /// restart. `None` = keep the terminal's own theme.
    pub theme: Option<String>,
    // ── status bar ──
    /// Where the status bar goes: `bottom` (default) | `top` (tmux's status line, status-position)
    /// | `left` | `right` (a bar down the side: the windows with their panes, the machines with theirs).
    pub status_bar: Option<String>,
    /// How panes are set apart: `box` (default: each pane its own frame) | `line` (tmux's shared lines).
    pub border_style: Option<String>,
    /// The bar's width down a side, in columns (18-36; 26 unless dragged).
    pub status_bar_width: Option<String>,
    /// `on`: the panes you are not in, a little quieter (`off` unless chosen).
    pub dim: Option<String>,
    /// How the current tab (the window) is marked in the status bar: `star` (default: `*` beside
    /// its name) | `filled` (the tab is inverted — filled — with no `*`).
    pub window_active: Option<String>,
    /// How a tab's name is shown in the status bar: `tmux` (default: the window's short name) |
    /// `pane` (the window's full name).
    pub window_name: Option<String>,
}

pub struct Config {
    pub prefix: Chord,
    /// Whether the file named a prefix (else tmux's, or ~/.tmux.conf's, stands).
    pub prefix_set: bool,
    /// A second prefix (tmux's prefix2), where the file names one: `prefix = "D-b"` (⌘B, which
    /// only some terminals pass on) with `prefix2 = "C-b"` works in every terminal.
    pub prefix2: Option<Chord>,
    /// `[prefix_keys]`: keys after the prefix, each with its command (None: unbound).
    pub prefix_keys: Vec<(Chord, Option<String>)>,
    pub keys: Vec<(Chord, Option<String>)>,
    /// The `[look]` table, if any.
    pub look: Option<Look>,
    pub problems: Vec<String>,
}

impl Look {
    /// The bundle each named look sets beyond its `@hn-look` value. Focus (line|surface) is the
    /// piece that changes the most — how panes are drawn (a highlighted border vs a "blurred"
    /// surface) — so it is what the presets differ by. Colors are left to the theme or [look].
    pub fn look_preset(preset: &str) -> Vec<(&'static str, &'static str)> {
        match preset {
            "panes" | "lazyvim" => vec![("@hn-focus", "surface")],
            _ => vec![],
        }
    }

    /// The `(option, value)` pairs this `[look]` table sets at boot: the preset's defaults first,
    /// then whichever knobs the file named, which override them.
    pub fn assignments(&self) -> Vec<(String, String)> {
        let preset = self.preset.as_deref().unwrap_or("classic");
        // `@hn-look` tells structure which bundle is on; `@hn-focus` (from the preset or an
        // explicit `focus`) tells how panes are drawn. Both are options, so `hn show` sees them.
        // (Only a preset the file names: none named is hn's own look, not one written back as
        // `classic` the next time a setting is saved.)
        let mut out: Vec<(String, String)> = self.preset.iter().map(|p| ("@hn-look".to_string(), p.clone())).collect();
        // A preset's `@hn-focus` is its default; an explicit `focus` knob overrides it, so do not
        // emit the preset's when the file named one (the later assignment would win anyway).
        for (n, v) in Self::look_preset(preset) {
            if n == "@hn-focus" && self.focus.is_some() { continue }
            out.push((n.into(), v.into()))
        }
        if let Some(f) = &self.focus { out.push(("@hn-focus".into(), f.clone())) }
        if let Some(b) = &self.border_lines { out.push(("pane-border-lines".into(), b.clone())) }
        if let Some(b) = &self.border_indicators { out.push(("pane-border-indicators".into(), b.clone())) }
        if let Some(b) = &self.border_status { out.push(("pane-border-status".into(), b.clone())) }
        if let Some(o) = &self.layout_orientation { out.push(("@hn-layout".into(), o.clone())) }
        if let Some(o) = &self.layout_preset { out.push(("@hn-layout-preset".into(), o.clone())) }
        if let Some(c) = &self.active_border { out.push(("pane-active-border-style".into(), format!("fg={c}"))) }
        if let Some(c) = &self.border { out.push(("pane-border-style".into(), format!("fg={c}"))) }
        // The accent: an explicit `accent` wins; otherwise a chosen terminal theme supplies its
        // signature color (so the picker's choice tints chrome at boot too, not only live).
        if let Some(c) = &self.accent { out.push(("@hn-accent".into(), c.clone())) }
        else if let Some(g) = &self.theme {
            if let Some(a) = crate::theme::theme_accent_hex(g) { out.push(("@hn-accent".into(), a)) }
        }
        if let Some(g) = &self.theme { out.push(("@hn-theme".into(), g.clone())) }
        // ── status bar ──
        // (At the top or the bottom it is tmux's own status line, so status-position says where.)
        if let Some(b) = &self.status_bar {
            out.push(("@hn-status-bar".into(), b.clone()));
            if matches!(b.as_str(), "top" | "bottom") { out.push(("status-position".into(), b.clone())) }
        }
        if let Some(b) = &self.border_style { out.push(("@hn-border".into(), b.clone())) }
        if let Some(w) = &self.status_bar_width { out.push(("@hn-status-bar-width".into(), w.clone())) }
        if let Some(d) = &self.dim { out.push(("@hn-dim".into(), d.clone())) }
        // ── status bar tabs ──
        // Two options shape the window list in the status bar: how the current tab is marked and
        // how a tab's name is shown. `@hn-window-active`/`@hn-window-name` carry the choice for the
        // Appearance list; the format/style overrides below are what actually draws it.
        if let Some(a) = &self.window_active { out.push(("@hn-window-active".into(), a.clone())) }
        if let Some(n) = &self.window_name { out.push(("@hn-window-name".into(), n.clone())) }
        // The window-status-* overrides these two options need (empty for the tmux + star defaults).
        let name = self.window_name.as_deref().unwrap_or("tmux");
        let active = self.window_active.as_deref().unwrap_or("star");
        for (o, v) in crate::options::window_status_overrides(name, active) { out.push((o, v)) }
        out
    }
}

impl Default for Config {
    fn default() -> Self {
        Config { prefix: Chord::normal(KeyCode::Char('b'), KeyModifiers::CONTROL), prefix_set: false, prefix2: None, prefix_keys: Vec::new(), keys: Vec::new(), look: None, problems: Vec::new() }
    }
}

pub fn path() -> PathBuf {
    // (Tests never read or write the real config: theirs is their own.)
    #[cfg(test)]
    return std::env::temp_dir().join(format!("hn-test-{}", std::process::id())).join("harness").join("tui.toml");
    #[allow(unreachable_code)]
    let base = std::env::var("XDG_CONFIG_HOME").ok().filter(|s| !s.is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config"));
    base.join("harness").join("tui.toml")
}

/// Read the file and fold its switches into the environment (the environment wins).
pub fn load() -> Config {
    let Ok(text) = std::fs::read_to_string(path()) else { return Config::default() };
    // SAFETY: called from `main` before the async runtime (or any other thread) exists.
    read(&text, |name, value| { if std::env::var(name).is_err() { unsafe { std::env::set_var(name, value) } } })
}

/// The file's [text] as [load] reads it, its switches handed to [setenv].
fn read(text: &str, setenv: impl Fn(&str, &str)) -> Config {
    let mut config = Config::default();
    let value: toml::Value = match text.parse() {
        Ok(v) => v,
        Err(error) => { config.problems.push(format!("tui.toml: {}", error.to_string().lines().next().unwrap_or(""))); return config }
    };
    if let Some(p) = value.get("prefix").and_then(|v| v.as_str()) {
        match crate::keys::parse(p) { Ok(c) => { config.prefix = c; config.prefix_set = true } Err(e) => config.problems.push(format!("tui.toml prefix: {e}")) }
    }
    if let Some(p) = value.get("prefix2").and_then(|v| v.as_str()) {
        match crate::keys::parse(p) { Ok(c) => config.prefix2 = Some(c), Err(e) => config.problems.push(format!("tui.toml prefix2: {e}")) }
    }
    if let Some(d) = value.get("desk").and_then(|v| v.as_str()) { setenv("HARNESS_TUI_DESK", d) }
    if let Some(p) = value.get("predict").and_then(|v| v.as_str()) { setenv("HARNESS_TUI_PREDICT", p) }
    if let Some(false) = value.get("notify").and_then(|v| v.as_bool()) { setenv("HARNESS_TUI_NOTIFY", "off") }
    if let Some(keys) = value.get("keys").and_then(|v| v.as_table()) {
        for (chord, command) in keys {
            let Some(command) = command.as_str() else { config.problems.push(format!("tui.toml keys.{chord}: expected a command name")); continue };
            match crate::keys::parse(chord) {
                Ok(c) => config.keys.push((c, if command == "none" { None } else { Some(command.to_string()) })),
                Err(e) => config.problems.push(format!("tui.toml keys: {e}")),
            }
        }
    }
    // [prefix_keys]: after the prefix, a key and the command it runs ("none": nothing) — what
    // Alt-k in the command panel writes.
    if let Some(keys) = value.get("prefix_keys").and_then(|v| v.as_table()) {
        for (chord, command) in keys {
            let Some(command) = command.as_str() else { config.problems.push(format!("tui.toml prefix_keys.{chord}: expected a command")); continue };
            match crate::keys::parse(chord) {
                Ok(c) => config.prefix_keys.push((c, if command == "none" { None } else { Some(command.to_string()) })),
                Err(e) => config.problems.push(format!("tui.toml prefix_keys: {e}")),
            }
        }
    }
    if let Some(look) = value.get("look").and_then(|v| v.as_table()) { config.look = Some(look_of(look, &mut config.problems)) }
    config
}

// ── keys ──

/// A TOML string: [s] quoted.
fn toml_str(s: &str) -> String { format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")) }

/// Whether [line] sets [key] (bare or quoted).
fn sets(line: &str, key: &str) -> bool {
    let t = line.trim_start();
    let rest = t.strip_prefix(&toml_str(key)).or_else(|| t.strip_prefix(key).filter(|_| key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')));
    rest.is_some_and(|r| r.trim_start().starts_with('='))
}

/// The table [line] opens (`[ prefix_keys ]  # mine` opens `prefix_keys`), if it is a header.
fn table_of(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix('[')?;
    let (name, after) = rest.split_once(']')?;
    let after = after.trim_start();
    (after.is_empty() || after.starts_with('#')).then(|| name.trim())
}

/// [text] with the top-level `key = "value"` set ([value] None: taken out), the rest as written.
fn with_top(text: &str, key: &str, value: Option<&str>) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let end = lines.iter().position(|l| table_of(l).is_some() || is_section_header(l.trim())).unwrap_or(lines.len());
    let line = value.map(|v| format!("{key} = {}", toml_str(v)));
    match (lines[..end].iter().position(|l| sets(l, key)), line) {
        (Some(i), Some(l)) => lines[i] = l,
        (Some(i), None) => { lines.remove(i); }
        (None, Some(l)) => {
            // After the top's last setting (before the blank line that ends it).
            let at = lines[..end].iter().rposition(|l| !l.trim().is_empty()).map(|i| i + 1).unwrap_or(0);
            lines.insert(at, l);
        }
        (None, None) => {}
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// [text] with `"entry" = "value"` in [table] (made when there is none), the rest as written.
fn with_entry(text: &str, table: &str, entry: &str, value: &str) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let line = format!("{} = {}", toml_str(entry), toml_str(value));
    let header = format!("[{table}]");
    match lines.iter().position(|l| table_of(l) == Some(table)) {
        Some(h) => {
            let end = lines[h + 1..].iter().position(|l| table_of(l).is_some() || is_section_header(l.trim())).map(|i| h + 1 + i).unwrap_or(lines.len());
            match lines[h + 1..end].iter().position(|l| sets(l, entry)) {
                Some(i) => lines[h + 1 + i] = line,
                None => { let at = lines[h + 1..end].iter().rposition(|l| !l.trim().is_empty()).map(|i| h + 2 + i).unwrap_or(h + 1); lines.insert(at, line) }
            }
        }
        None => {
            if lines.last().is_some_and(|l| !l.trim().is_empty()) { lines.push(String::new()) }
            lines.push(header);
            lines.push(line);
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn rewrite(change: impl FnOnce(&str) -> String) -> std::io::Result<()> {
    let p = path();
    let existing = std::fs::read_to_string(&p).unwrap_or_default();
    if let Some(dir) = p.parent() { std::fs::create_dir_all(dir)? }
    std::fs::write(p, change(&existing))
}

/// `prefix` / `prefix2` in tui.toml ([value] None: taken out).
pub fn write_top(key: &str, value: Option<&str>) -> std::io::Result<()> { rewrite(|t| with_top(t, key, value)) }

/// One key after the prefix in tui.toml's `[prefix_keys]`: its command, or "none".
pub fn write_prefix_key(key: &str, command: &str) -> std::io::Result<()> { rewrite(|t| with_entry(t, "prefix_keys", key, command)) }

/// The `[look]` table as read, a knob that is not a string said in [problems].
fn look_of(look: &toml::Table, problems: &mut Vec<String>) -> Look {
    let mut l = Look::default();
    let mut field = |t: &toml::Table, key: &str, slot: &mut Option<String>| {
        if let Some(v) = t.get(key) {
            if let Some(s) = v.as_str() { *slot = Some(s.to_string()) }
            else { problems.push(format!("tui.toml look.{key}: expected a string")) }
        }
    };
    field(look, "preset", &mut l.preset);
    field(look, "focus", &mut l.focus);
    field(look, "border_lines", &mut l.border_lines);
    field(look, "border_indicators", &mut l.border_indicators);
    field(look, "border_status", &mut l.border_status);
    field(look, "layout_orientation", &mut l.layout_orientation);
    field(look, "layout_preset", &mut l.layout_preset);
    field(look, "active_border", &mut l.active_border);
    field(look, "border", &mut l.border);
    field(look, "accent", &mut l.accent);
    field(look, "theme", &mut l.theme);
    // ── status bar ──
    field(look, "status_bar", &mut l.status_bar);
    field(look, "border_style", &mut l.border_style);
    field(look, "status_bar_width", &mut l.status_bar_width);
    field(look, "dim", &mut l.dim);
    field(look, "window_active", &mut l.window_active);
    field(look, "window_name", &mut l.window_name);
    // (An older file's `tabs` is left alone: the tabs over the panes are gone, the bar lists the windows.)
    l
}

/// Write the `[look]` table back to the file, replacing an existing `[look]` section in place and
/// leaving the rest of the file (and its comments) untouched. Used by the `hn theme` picker so the
/// file stays the single place the look is described.
pub fn write_look(look: &Look) -> std::io::Result<()> {
    let p = path();
    let existing = std::fs::read_to_string(&p).unwrap_or_default();
    // (A first setting on a machine with no config yet: its folder too.)
    if let Some(dir) = p.parent() { std::fs::create_dir_all(dir)? }
    std::fs::write(p, replace_look_section(&existing, &format_look(look)))?;
    Ok(())
}

fn is_section_header(line: &str) -> bool { line.starts_with('[') && line.trim_end().ends_with(']') }

fn format_look(look: &Look) -> String {
    let mut s = String::from("[look]\n");
    let push = |slot: &Option<String>, key: &str, s: &mut String| {
        if let Some(v) = slot { s.push_str(&format!("{key} = \"{}\"\n", v.replace('\\', "\\\\").replace('"', "\\\""))) }
    };
    push(&look.preset, "preset", &mut s);
    push(&look.focus, "focus", &mut s);
    push(&look.border_lines, "border_lines", &mut s);
    push(&look.border_indicators, "border_indicators", &mut s);
    push(&look.border_status, "border_status", &mut s);
    push(&look.layout_orientation, "layout_orientation", &mut s);
    push(&look.layout_preset, "layout_preset", &mut s);
    push(&look.theme, "theme", &mut s);
    // ── status bar ──
    push(&look.status_bar, "status_bar", &mut s);
    push(&look.border_style, "border_style", &mut s);
    push(&look.status_bar_width, "status_bar_width", &mut s);
    push(&look.dim, "dim", &mut s);
    push(&look.window_active, "window_active", &mut s);
    push(&look.window_name, "window_name", &mut s);
    s
}

fn replace_look_section(text: &str, block: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let header_at = lines.iter().position(|l| is_section_header(l) && l.trim() == "[look]");
    let Some(header_at) = header_at else {
        // No [look] yet: append a fresh section, separated from whatever preceded it.
        let mut out = text.to_string();
        if !out.is_empty() {
            if !out.ends_with('\n') { out.push('\n') }
            out.push('\n');
        }
        out.push_str(block);
        if !out.ends_with('\n') { out.push('\n') }
        return out;
    };
    // Replace from the header through the line before the next section header (or end).
    let next_header = lines[header_at + 1..].iter().position(|l| is_section_header(l)).map(|i| header_at + 1 + i).unwrap_or(lines.len());
    let mut out: Vec<&str> = lines[..header_at].to_vec();
    let tail = lines[next_header..].to_vec();
    // Rebuild: head lines, the new block as its own lines, then the tail.
    let block_lines: Vec<&str> = block.lines().collect();
    out.extend(block_lines.iter().copied());
    out.extend(tail.iter().copied());
    let mut joined = out.join("\n");
    joined.push('\n');
    joined
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_normalises() {
        assert_eq!(Chord::parse("alt+shift+p").unwrap(), Chord::normal(KeyCode::Char('P'), KeyModifiers::ALT));
        assert_eq!(Chord::parse("ctrl+space").unwrap(), Chord::normal(KeyCode::Char(' '), KeyModifiers::CONTROL));
        assert_eq!(Chord::parse("alt+{").unwrap(), Chord::normal(KeyCode::Char('{'), KeyModifiers::ALT | KeyModifiers::SHIFT));
        assert_eq!(Chord::parse("super+enter").unwrap().code, KeyCode::Enter);
        assert_eq!(Chord::parse("alt++").unwrap().code, KeyCode::Char('+'));
        assert!(Chord::parse("hyper+x").is_err());
    }

    #[test]
    fn look_preset_sets_surface_for_the_blur_bundles() {
        assert_eq!(Look::look_preset("lazyvim"), vec![("@hn-focus", "surface")]);
        assert_eq!(Look::look_preset("panes"), vec![("@hn-focus", "surface")]);
        assert!(Look::look_preset("vim").is_empty());
        assert!(Look::look_preset("classic").is_empty());
        assert!(Look::look_preset("tmux").is_empty());
    }

    #[test]
    fn look_assignments_follow_preset_then_overrides() {
        // Defaults from the preset, with an explicit `focus` replacing the preset's surface.
        let look = Look {
            preset: Some("lazyvim".into()), focus: Some("line".into()),
            border_lines: Some("heavy".into()), layout_orientation: Some("vertical".into()),
            active_border: Some("#7aa2f7".into()), ..Default::default()
        };
        let a = look.assignments();
        let get = |name: &str| a.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
        assert_eq!(get("@hn-look").as_deref(), Some("lazyvim"));
        // The explicit `focus` replaces the preset's, not added after it.
        assert_eq!(get("@hn-focus").as_deref(), Some("line"));
        assert_eq!(get("pane-border-lines").as_deref(), Some("heavy"));
        assert_eq!(get("@hn-layout").as_deref(), Some("vertical"));
        assert_eq!(get("pane-active-border-style").as_deref(), Some("fg=#7aa2f7"));
        // The surface preset, without an override, keeps its default focus.
        let plain = Look { preset: Some("panes".into()), ..Default::default() };
        let b = plain.assignments();
        let get_b = |name: &str| b.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
        assert_eq!(get_b("@hn-focus").as_deref(), Some("surface"));
    }

    #[test]
    fn theme_is_recorded_and_replayed() {
        // Choosing a terminal theme writes it to the config; at boot `@hn-theme` is replayed so
        // the picker marks it, and its signature colour becomes the accent unless one is named.
        let look = Look { preset: Some("panes".into()), theme: Some("Atom One Dark".into()), ..Default::default() };
        let a = look.assignments();
        assert_eq!(a.iter().find(|(n, _)| n == "@hn-theme").map(|(_, v)| v.as_str()), Some("Atom One Dark"));
        assert!(a.iter().any(|(n, _)| n == "@hn-accent"));
        // The [look] block carries it, escaping quotes/backslashes.
        let block = format_look(&look);
        assert!(block.contains("theme = \"Atom One Dark\"\n"));
        // An explicit `accent` wins over the theme's own.
        let explicit = Look { theme: Some("Atom One Dark".into()), accent: Some("#abcdef".into()), ..Default::default() };
        let b = explicit.assignments();
        assert_eq!(b.iter().find(|(n, _)| n == "@hn-accent").map(|(_, v)| v.as_str()), Some("#abcdef"));
    }

    #[test]
    fn keys_from_the_terminal_as_tmux_names_them() {
        let key = |code, mods| crate::keys::name(&Chord::of(&KeyEvent::new(code, mods)));
        // 0x1c–0x1f, which crossterm reads as C-4 … C-7.
        assert_eq!(key(KeyCode::Char('4'), KeyModifiers::CONTROL), "C-\\");
        assert_eq!(key(KeyCode::Char('5'), KeyModifiers::CONTROL), "C-]");
        assert_eq!(key(KeyCode::Char('6'), KeyModifiers::CONTROL), "C-^");
        assert_eq!(key(KeyCode::Char('7'), KeyModifiers::CONTROL), "C-_");
        assert_eq!(key(KeyCode::BackTab, KeyModifiers::SHIFT), "BTab");
        assert_eq!(Chord::of(&KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT)), crate::keys::parse("BTab").unwrap());
        assert_eq!(Chord::of(&KeyEvent::new(KeyCode::Char('4'), KeyModifiers::CONTROL)), crate::keys::parse("C-\\").unwrap());
        assert_eq!(key(KeyCode::Char('4'), KeyModifiers::ALT), "M-4");
    }

    #[test]
    fn replace_look_section_rewrites_in_place_and_preserves_rest() {
        // Replaces an existing [look] block, keeping the lines before and after (and comments).
        let original = "prefix = \"ctrl+a\"\n# my comment\n[look]\npreset = \"classic\"\nfocus = \"line\"\n[keys]\n\"alt+h\" = \"none\"\n";
        let block = "[look]\npreset = \"panes\"\nfocus = \"surface\"\nborder_lines = \"single\"\n";
        let replaced = replace_look_section(original, block);
        assert!(replaced.starts_with("prefix = \"ctrl+a\"\n# my comment\n"));
        assert!(replaced.contains("[look]\npreset = \"panes\"\nfocus = \"surface\"\nborder_lines = \"single\"\n"));
        assert!(!replaced.contains("preset = \"classic\""));
        assert!(replaced.ends_with("[keys]\n\"alt+h\" = \"none\"\n"));

        // Appends a fresh [look] section when the file has none.
        let none = "prefix = \"ctrl+a\"\n";
        let appended = replace_look_section(none, block);
        assert!(appended.ends_with("prefix = \"ctrl+a\"\n\n[look]\npreset = \"panes\"\nfocus = \"surface\"\nborder_lines = \"single\"\n"));
    }

    // ── status bar ──

    #[test]
    fn the_status_bar_and_border_style_go_through_tui_toml_and_back() {
        let look = Look { status_bar: Some("left".into()), border_style: Some("line".into()), ..Default::default() };
        let text = format_look(&look);
        assert!(text.contains("status_bar = \"left\"\nborder_style = \"line\"\n"), "{text}");
        let value: toml::Value = text.parse().unwrap();
        let mut problems = Vec::new();
        assert_eq!(look_of(value.get("look").and_then(|v| v.as_table()).unwrap(), &mut problems), look);
        assert!(problems.is_empty());
        // An older file's `tabs` line reads as nothing, and says no problem.
        let old: toml::Value = format!("{text}tabs = \"off\"\n").parse().unwrap();
        assert_eq!(look_of(old.get("look").and_then(|v| v.as_table()).unwrap(), &mut problems), look);
        assert!(problems.is_empty());
        // Each is an option at boot; at the top or bottom the bar is tmux's status line, placed so.
        let a = look.assignments();
        let get = |a: &[(String, String)], n: &str| a.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
        assert_eq!(get(&a, "@hn-status-bar").as_deref(), Some("left"));
        assert_eq!(get(&a, "@hn-border").as_deref(), Some("line"));
        assert_eq!(get(&a, "status-position"), None);
        let top = Look { status_bar: Some("top".into()), ..Default::default() }.assignments();
        assert_eq!(get(&top, "status-position").as_deref(), Some("top"));
    }

    #[test]
    fn window_status_options_emit_format_and_style_overrides() {
        let get = |a: &[(String, String)], n: &str| a.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
        // The defaults (tmux + star) put just the two @hn markers; no format/style overrides, so
        // the tmux defaults draw the bar.
        let star = Look { window_active: Some("star".into()), window_name: Some("tmux".into()), ..Default::default() }.assignments();
        assert_eq!(get(&star, "@hn-window-active").as_deref(), Some("star"));
        assert_eq!(get(&star, "@hn-window-name").as_deref(), Some("tmux"));
        assert!(get(&star, "window-status-format").is_none(), "default keeps tmux's format");
        assert!(get(&star, "window-status-current-format").is_none());
        assert!(get(&star, "window-status-current-style").is_none());
        // `pane` names the window with its active pane's title; `filled` drops the `*` and the tab
        // takes the status line's own colours swapped (a solid block, as the preview draws it).
        let filled = Look { window_active: Some("filled".into()), window_name: Some("pane".into()), ..Default::default() }.assignments();
        let normal = get(&filled, "window-status-format").unwrap();
        let current = get(&filled, "window-status-current-format").unwrap();
        assert!(normal.contains("#{pane_title}"), "pane uses the active pane's title: {normal}");
        assert!(current.contains("#{pane_title}"));
        assert!(!current.contains("#{window_active,*"), "filled leaves no `*`: {current}");
        let style = get(&filled, "window-status-current-style").unwrap();
        assert!(style.contains("bold"), "{style}");
        // The filled tab swaps the status line's colours: its background the theme foreground's,
        // its lettering the theme's background.
        let (bg, fg, _) = crate::theme::palette();
        let fg = crate::tmuxconf::colour_name(fg);
        let bg = crate::tmuxconf::colour_name(bg);
        assert!(style.contains(&format!("fg={fg}")) && style.contains(&format!("bg={bg}")), "{style}");
    }

    #[test]
    fn window_status_options_round_trip_through_tui_toml() {
        let look = Look { window_active: Some("filled".into()), window_name: Some("pane".into()), ..Default::default() };
        let text = format_look(&look);
        assert!(text.contains("window_active = \"filled\"") && text.contains("window_name = \"pane\""), "{text}");
        let value: toml::Value = text.parse().unwrap();
        let mut problems = Vec::new();
        assert_eq!(look_of(value.get("look").and_then(|v| v.as_table()).unwrap(), &mut problems), look);
        assert!(problems.is_empty());
    }

    // ── keys ──

    /// The prefix goes into tui.toml as the panel sets it: the top's `prefix` replaced (or added,
    /// before the first table), `prefix2` added and taken out, every other line as it was.
    #[test]
    fn the_prefix_chosen_in_the_panel_is_written_into_tui_toml() {
        let text = "# mine\nprefix = \"D-b\"\n\n[look]\nfocus = \"line\"\n";
        let t = with_top(text, "prefix", Some("C-a"));
        assert_eq!(t, "# mine\nprefix = \"C-a\"\n\n[look]\nfocus = \"line\"\n");
        let t = with_top(&t, "prefix2", Some("C-b"));
        assert_eq!(t, "# mine\nprefix = \"C-a\"\nprefix2 = \"C-b\"\n\n[look]\nfocus = \"line\"\n");
        assert_eq!(with_top(&t, "prefix2", None), "# mine\nprefix = \"C-a\"\n\n[look]\nfocus = \"line\"\n");
        // A file with only tables: the prefix goes on top, before them.
        assert_eq!(with_top("[look]\nfocus = \"line\"\n", "prefix", Some("C-a")), "prefix = \"C-a\"\n[look]\nfocus = \"line\"\n");
        let v: toml::Value = t.parse().unwrap();
        assert_eq!(v["prefix"].as_str(), Some("C-a"));
    }

    /// A command's key goes into tui.toml as the panel sets it: `[prefix_keys]` made or added
    /// to, every other line as it was — and read back at start as written.
    #[test]
    fn keys_chosen_in_the_panel_are_written_into_tui_toml() {
        let text = "# mine\nprefix = \"C-a\"\n\n[look]\nfocus = \"line\"\n";
        let t = with_entry(text, "prefix_keys", "h", "new-harness");
        assert!(t.ends_with("focus = \"line\"\n\n[prefix_keys]\n\"h\" = \"new-harness\"\n"), "{t}");
        let t = with_entry(&t, "prefix_keys", "N", "none");
        let t = with_entry(&t, "prefix_keys", "h", "kill-pane");
        assert!(t.starts_with("# mine\nprefix = \"C-a\"\n\n[look]\nfocus = \"line\"\n"), "{t}");
        assert!(t.ends_with("[prefix_keys]\n\"h\" = \"kill-pane\"\n\"N\" = \"none\"\n"), "{t}");
        // A key that is a quote itself.
        assert!(with_entry("", "prefix_keys", "\"", "split-window").contains("\"\\\"\" = \"split-window\""));
        // And read back as the start reads it: the prefix, and each key with its command (none: unbound).
        let c = read(&t, |_, _| {});
        assert!(c.problems.is_empty(), "{:?}", c.problems);
        assert_eq!(crate::keys::name(&c.prefix), "C-a");
        let mut keys: Vec<(String, Option<String>)> = c.prefix_keys.iter().map(|(k, v)| (crate::keys::name(k), v.clone())).collect();
        keys.sort();
        assert_eq!(keys, [("N".to_string(), None), ("h".to_string(), Some("kill-pane".to_string()))]);
    }

    /// `[prefix_keys]` is found however its header is written — spaced, or with a comment after
    /// it — so a second table (which TOML refuses) is never added.
    #[test]
    fn the_prefix_keys_header_is_found_spaced_or_commented() {
        for header in ["[ prefix_keys ]", "[prefix_keys]  # mine", "  [ prefix_keys ] # mine"] {
            let text = format!("{header}\n\"h\" = \"new-harness\"\n\n[look] # the look\nfocus = \"line\"\n");
            let t = with_entry(&text, "prefix_keys", "n", "none");
            assert_eq!(t.matches("prefix_keys").count(), 1, "{t}");
            assert_eq!(t, format!("{header}\n\"h\" = \"new-harness\"\n\"n\" = \"none\"\n\n[look] # the look\nfocus = \"line\"\n"));
            let c = read(&t, |_, _| {});
            assert!(c.problems.is_empty(), "{:?}", c.problems);
            assert_eq!(c.prefix_keys.len(), 2);
            let t = with_entry(&t, "prefix_keys", "h", "kill-pane");
            assert!(t.contains("\"h\" = \"kill-pane\"\n\"n\" = \"none\"\n\n[look]"), "{t}");
        }
        // (Another table whose name only starts the same is not it.)
        let t = with_entry("[prefix_keys_old]\n\"h\" = \"x\"\n", "prefix_keys", "n", "none");
        assert!(t.ends_with("\n[prefix_keys]\n\"n\" = \"none\"\n"), "{t}");
    }
}
