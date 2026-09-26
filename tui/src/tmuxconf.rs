//! Your `~/.tmux.conf`, read — so the prefix, binds and look you have spent years on come with you.
//!
//! Understood: `set[-option] … prefix / prefix2 / base-index / pane-base-index / mouse /
//! status-position / display-time / display-panes-time / repeat-time / status-style / status-bg /
//! status-fg / message-style / pane-active-border-style / pane-border-style`,
//! `bind[-key] [-r] [-n] [-T prefix|root] key command…`, `unbind[-key] [-a] [-n] [-T …] key`.
//! Everything else (plugins, `if-shell`, copy-mode tables, hooks) is skipped quietly; binds to a
//! command this TUI does not have are kept and say so when pressed. `HARNESS_TUI_TMUX_CONF=off`
//! ignores the file.

use std::path::PathBuf;

use ratatui::style::Color;

use crate::commands::split;
use crate::keys::{self, Keymap, Table};

#[derive(Default, Clone, Debug)]
pub struct Look {
    pub status_bg: Option<Color>,
    pub status_fg: Option<Color>,
    pub message_bg: Option<Color>,
    pub message_fg: Option<Color>,
    pub active_border: Option<Color>,
    pub border: Option<Color>,
}

#[derive(Default, Clone, Debug)]
pub struct Settings {
    pub base_index: Option<usize>,
    pub pane_base_index: Option<usize>,
    pub mouse: Option<bool>,
    pub status_top: Option<bool>,
    pub display_ms: Option<u64>,
    pub display_panes_ms: Option<u64>,
    pub look: Look,
    pub problems: Vec<String>,
    pub path: Option<PathBuf>,
}

pub fn find() -> Option<PathBuf> {
    if std::env::var("HARNESS_TUI_TMUX_CONF").as_deref() == Ok("off") { return None }
    if let Ok(p) = std::env::var("HARNESS_TUI_TMUX_CONF") { return Some(PathBuf::from(p)) }
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let xdg = std::env::var("XDG_CONFIG_HOME").ok().filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
    [home.join(".tmux.conf"), xdg.join("tmux").join("tmux.conf")].into_iter().find(|p| p.exists())
}

/// A tmux colour: a name, `colourN`/`colorN`, `#rrggbb`, `default`.
pub fn colour(text: &str) -> Option<Color> {
    let t = text.trim().to_lowercase();
    Some(match t.as_str() {
        "default" | "terminal" => Color::Reset,
        "black" => Color::Black, "red" => Color::Red, "green" => Color::Green, "yellow" => Color::Yellow,
        "blue" => Color::Blue, "magenta" => Color::Magenta, "cyan" => Color::Cyan, "white" => Color::Gray,
        "brightblack" => Color::DarkGray, "brightred" => Color::LightRed, "brightgreen" => Color::LightGreen, "brightyellow" => Color::LightYellow,
        "brightblue" => Color::LightBlue, "brightmagenta" => Color::LightMagenta, "brightcyan" => Color::LightCyan, "brightwhite" => Color::White,
        c if c.starts_with('#') && c.len() == 7 => {
            let n = u32::from_str_radix(&c[1..], 16).ok()?;
            Color::Rgb((n >> 16) as u8, (n >> 8) as u8, n as u8)
        }
        c if c.starts_with("colour") || c.starts_with("color") => Color::Indexed(c.trim_start_matches("colour").trim_start_matches("color").parse().ok()?),
        _ => return None,
    })
}

/// `bg=colour235,fg=white,bold` → (fg, bg).
fn style(text: &str) -> (Option<Color>, Option<Color>) {
    let (mut fg, mut bg) = (None, None);
    for part in text.split(|c| c == ',' || c == ' ') {
        if let Some(v) = part.strip_prefix("fg=") { fg = colour(v) }
        if let Some(v) = part.strip_prefix("bg=") { bg = colour(v) }
    }
    (fg, bg)
}

fn on_off(v: &str) -> Option<bool> { match v { "on" | "yes" | "1" | "true" => Some(true), "off" | "no" | "0" | "false" => Some(false), _ => None } }

pub fn load(keymap: &mut Keymap) -> Settings {
    let mut settings = Settings::default();
    let Some(path) = find() else { return settings };
    let Ok(text) = std::fs::read_to_string(&path) else { return settings };
    settings.path = Some(path.clone());
    apply(&text, keymap, &mut settings);
    settings
}

pub fn apply(text: &str, keymap: &mut Keymap, settings: &mut Settings) {
    // Join continued lines (a trailing backslash).
    let joined = text.replace("\\\n", " ");
    for (n, raw) in joined.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') { continue }
        for words in split(line) {
            if let Err(e) = directive(&words, keymap, settings) { settings.problems.push(format!("tmux.conf:{}: {e}", n + 1)) }
        }
    }
}

fn directive(words: &[String], keymap: &mut Keymap, s: &mut Settings) -> Result<(), String> {
    let Some(cmd) = words.first() else { return Ok(()) };
    match cmd.as_str() {
        "set" | "set-option" | "setw" | "set-window-option" => {
            let args: Vec<&String> = words[1..].iter().filter(|w| !w.starts_with('-')).collect();
            let (Some(name), value) = (args.first(), args.get(1).map(|v| v.as_str()).unwrap_or("")) else { return Ok(()) };
            match name.as_str() {
                "prefix" => keymap.prefix = keys::parse(value)?,
                "prefix2" => keymap.prefix2 = if value == "None" { None } else { Some(keys::parse(value)?) },
                "base-index" => s.base_index = value.parse().ok(),
                "pane-base-index" => s.pane_base_index = value.parse().ok(),
                "mouse" => s.mouse = on_off(value),
                "status-position" => s.status_top = Some(value == "top"),
                "display-time" => s.display_ms = value.parse().ok(),
                "display-panes-time" => s.display_panes_ms = value.parse().ok(),
                "repeat-time" => { if let Ok(ms) = value.parse() { keymap.repeat_ms = ms } }
                "status-style" => { let (fg, bg) = style(value); s.look.status_fg = fg.or(s.look.status_fg); s.look.status_bg = bg.or(s.look.status_bg) }
                "status-bg" => s.look.status_bg = colour(value),
                "status-fg" => s.look.status_fg = colour(value),
                "message-style" => { let (fg, bg) = style(value); s.look.message_fg = fg.or(s.look.message_fg); s.look.message_bg = bg.or(s.look.message_bg) }
                "pane-active-border-style" => { let (fg, _) = style(value); s.look.active_border = fg }
                "pane-border-style" => { let (fg, _) = style(value); s.look.border = fg }
                _ => {}
            }
        }
        "bind" | "bind-key" => {
            let mut table = Table::Prefix;
            let mut repeat = false;
            let mut i = 1;
            while i < words.len() && words[i].starts_with('-') && words[i].len() > 1 {
                let flag = &words[i];
                if flag == "-T" { i += 1; table = match words.get(i).map(|t| t.as_str()) { Some("root") => Table::Root, Some("prefix") => Table::Prefix, _ => return Ok(()) } }
                else if flag == "-N" { i += 1 }
                else { if flag.contains('n') { table = Table::Root } if flag.contains('r') { repeat = true } }
                i += 1;
            }
            let Some(key) = words.get(i) else { return Err("bind without a key".into()) };
            let chord = keys::parse(key)?;
            let command = words[i + 1..].iter().map(|w| if w.contains(' ') || w.is_empty() { format!("\"{w}\"") } else { w.clone() }).collect::<Vec<_>>().join(" ");
            if command.is_empty() { return Err(format!("bind {key} without a command")) }
            keymap.bind(table, chord, command, repeat);
        }
        "unbind" | "unbind-key" => {
            let mut table = Table::Prefix;
            let mut all = false;
            let mut key = None;
            let mut i = 1;
            while i < words.len() {
                match words[i].as_str() {
                    "-a" => all = true,
                    "-n" => table = Table::Root,
                    "-T" => { i += 1; table = if words.get(i).map(|t| t == "root").unwrap_or(false) { Table::Root } else { Table::Prefix } }
                    w => key = Some(w.to_string()),
                }
                i += 1;
            }
            if all { match table { Table::Prefix => keymap.prefix_table.clear(), Table::Root => keymap.root_table.clear() } }
            else if let Some(k) = key {
                let chord = keys::parse(&k)?;
                // `unbind C-b` right after `set prefix C-a` means "C-b is not the prefix any more".
                if chord == keymap.prefix && table == Table::Prefix { return Ok(()) }
                keymap.unbind(table, &chord);
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyModifiers};
    use crate::config::Chord;

    #[test]
    fn a_typical_tmux_conf() {
        let conf = r##"
# my tmux
set -g prefix C-a
unbind C-b
bind C-a send-prefix
bind | split-window -h -c "#{pane_current_path}"
bind - split-window -v
unbind '"'
unbind %
bind -r h select-pane -L
bind -n M-Left select-pane -L
set -g base-index 1
setw -g pane-base-index 1
set -g mouse on
set -g status-position top
set -g status-style bg=colour235,fg=colour136
set -g pane-active-border-style fg=colour208
set -g @plugin 'tmux-plugins/tpm'
run '~/.tmux/plugins/tpm/tpm'
"##;
        let mut km = Keymap::tmux_defaults();
        let mut s = Settings::default();
        apply(conf, &mut km, &mut s);
        assert!(s.problems.is_empty(), "{:?}", s.problems);
        assert_eq!(km.prefix, Chord::normal(KeyCode::Char('a'), KeyModifiers::CONTROL));
        assert!(km.prefix_command(&keys::parse("|").unwrap()).unwrap().command.starts_with("split-window -h"));
        assert!(km.prefix_command(&keys::parse("\"").unwrap_or(Chord::normal(KeyCode::Char('"'), KeyModifiers::NONE))).is_none());
        assert!(km.prefix_command(&keys::parse("%").unwrap()).is_none());
        assert!(km.prefix_command(&keys::parse("h").unwrap()).unwrap().repeat);
        assert_eq!(km.root_command(&keys::parse("M-Left").unwrap()).unwrap().command, "select-pane -L");
        assert_eq!(s.base_index, Some(1));
        assert_eq!(s.pane_base_index, Some(1));
        assert_eq!(s.status_top, Some(true));
        assert_eq!(s.look.status_bg, Some(Color::Indexed(235)));
        assert_eq!(s.look.active_border, Some(Color::Indexed(208)));
    }
}
