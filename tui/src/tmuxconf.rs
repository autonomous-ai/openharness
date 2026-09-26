//! Your `~/.tmux.conf`, read — so the prefix, binds and look you have spent years on come with you.
//!
//! Understood: `set[-option] … prefix / prefix2 / base-index / pane-base-index / mouse /
//! status-position / display-time / display-panes-time / repeat-time / status-style / status-bg /
//! status-fg / message-style / pane-active-border-style / pane-border-style / window-style /
//! window-active-style`,
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
    pub window_fg: Option<Color>,
    pub window_bg: Option<Color>,
    pub active_window_fg: Option<Color>,
    pub active_window_bg: Option<Color>,
}

/// tmux's formats and switches for the status line, borders and copy mode.
#[derive(Default, Clone, Debug)]
pub struct Options {
    pub status_left: Option<String>,
    pub status_right: Option<String>,
    pub status_left_length: Option<usize>,
    pub status_right_length: Option<usize>,
    pub window_status_format: Option<String>,
    pub window_status_current_format: Option<String>,
    pub window_status_current_style: Option<(Option<Color>, Option<Color>)>,
    pub window_status_separator: Option<String>,
    pub renumber_windows: Option<bool>,
    /// pane-border-status: Some(false) is `off` — no title row on the panes.
    pub border_titles: Option<bool>,
    pub mode_keys_emacs: Option<bool>,
    pub status: Option<bool>,
    pub status_justify: Option<String>,
    pub window_status_style: Option<(Option<Color>, Option<Color>)>,
    pub pane_border_format: Option<String>,
    pub tim_off: Option<bool>,
    pub user: std::collections::BTreeMap<String, String>,
    /// main-pane-width / -height: cells, or 1000 + a percentage.
    pub main_pane_width: Option<u16>,
    pub main_pane_height: Option<u16>,
    pub copy_command: Option<String>,
    pub status_keys_vi: Option<bool>,
}

#[derive(Default, Clone, Debug)]
pub struct Settings {
    pub options: Options,
    pub notes: Vec<String>,
    depth: u8,
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

/// A word as it must be written to read back as itself.
pub fn quote_word(w: &str) -> String {
    if w == ";" { return w.to_string() }
    if !w.is_empty() && !w.chars().any(|c| c.is_whitespace() || matches!(c, '#' | '"' | '\'' | ';' | '\\')) { return w.to_string() }
    if !w.contains('\'') { return format!("'{w}'") }
    format!("\"{}\"", w.replace('\\', "\\\\").replace('"', "\\\""))
}

fn truthy(v: &str) -> bool { let v = v.trim(); !v.is_empty() && v != "0" }

fn unquote(s: &str) -> &str { s.trim().trim_matches('"').trim_matches('\'') }

/// The tmux level hn speaks, for version-gated configs (`%if #{>=:#{version},3.2}`).
pub const TMUX_VERSION: &str = "3.5";

/// Formats as tmux.conf can ask them at load: #{version}, #{@user}, #{==: != < > <= >= && ||},
/// #{?c,a,b}, #{e|op:a,b}. Anything else is empty (no window exists yet).
pub fn eval(s: &Settings, text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find("#{") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let (body, tail) = brace(after);
        out.push_str(&eval_braces(s, body));
        rest = tail;
    }
    out.push_str(rest);
    out
}

fn brace(s: &str) -> (&str, &str) {
    let mut depth = 1;
    for (i, c) in s.char_indices() { match c { '{' => depth += 1, '}' => { depth -= 1; if depth == 0 { return (&s[..i], &s[i + 1..]) } } _ => {} } }
    (s, "")
}

fn top_commas(s: &str) -> Vec<&str> {
    let (mut out, mut depth, mut start) = (Vec::new(), 0, 0);
    for (i, c) in s.char_indices() { match c { '{' => depth += 1, '}' => depth -= 1, ',' if depth == 0 => { out.push(&s[start..i]); start = i + 1 } _ => {} } }
    out.push(&s[start..]);
    out
}

/// Compare as versions / numbers where both read as such ("3.10" > "3.2"), else as text.
pub fn compare(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |v: &str| -> Option<Vec<u64>> { v.trim().split('.').map(|p| p.trim_end_matches(|c: char| c.is_ascii_alphabetic()).parse().ok()).collect() };
    match (parts(a), parts(b)) { (Some(x), Some(y)) => x.cmp(&y), _ => a.cmp(b) }
}

fn eval_braces(s: &Settings, body: &str) -> String {
    let b = |v: bool| if v { "1".to_string() } else { "0".to_string() };
    if let Some(rest) = body.strip_prefix('?') {
        let p = top_commas(rest);
        let c = eval(s, &format!("#{{{}}}", p.first().copied().unwrap_or("")));
        return eval(s, if truthy(&c) { p.get(1).copied().unwrap_or("") } else { p.get(2).copied().unwrap_or("") });
    }
    for (op, f) in [("==:", 0), ("!=:", 1), ("<=:", 2), (">=:", 3), ("<:", 4), (">:", 5), ("&&:", 6), ("||:", 7)] {
        if let Some(rest) = body.strip_prefix(op) {
            let p = top_commas(rest);
            let (x, y) = (eval(s, p.first().copied().unwrap_or("")), eval(s, p.get(1).copied().unwrap_or("")));
            use std::cmp::Ordering::*;
            return b(match f { 0 => x == y, 1 => x != y, 2 => compare(&x, &y) != Greater, 3 => compare(&x, &y) != Less, 4 => compare(&x, &y) == Less, 5 => compare(&x, &y) == Greater, 6 => truthy(&x) && truthy(&y), _ => truthy(&x) || truthy(&y) });
        }
    }
    match body {
        "version" => TMUX_VERSION.into(),
        n if n.starts_with('@') => s.options.user.get(n).cloned().unwrap_or_default(),
        _ => String::new(),
    }
}

pub fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/") { Some(rest) => format!("{}/{rest}", std::env::var("HOME").unwrap_or_default()), None => path.to_string() }
}

/// Run a condition with sh, a second at most; true when it exits 0.
pub fn shell_true(cond: &str) -> bool {
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new("sh").arg("-c").arg(cond).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return false };
    let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if std::time::Instant::now() < until => std::thread::sleep(std::time::Duration::from_millis(5)),
            _ => { let _ = child.kill(); return false }
        }
    }
}

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
    // %if / %elif / %else / %endif: a stack of (this branch runs, a branch already ran).
    let mut stack: Vec<(bool, bool)> = Vec::new();
    for (n, raw) in joined.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') { continue }
        let live = stack.iter().all(|(on, _)| *on);
        if let Some(cond) = line.strip_prefix("%if") {
            let t = live && truthy(&eval(settings, unquote(cond.trim())));
            stack.push((t, t));
            continue;
        }
        if let Some(cond) = line.strip_prefix("%elif") {
            let outer = stack.len() < 2 || stack[..stack.len() - 1].iter().all(|(on, _)| *on);
            if let Some(top) = stack.last_mut() { let t = outer && !top.1 && truthy(&eval(settings, unquote(cond.trim()))); top.0 = t; top.1 |= t; }
            continue;
        }
        if line.starts_with("%else") {
            let outer = stack.len() < 2 || stack[..stack.len() - 1].iter().all(|(on, _)| *on);
            if let Some(top) = stack.last_mut() { top.0 = outer && !top.1; top.1 = true; }
            continue;
        }
        if line.starts_with("%endif") { stack.pop(); continue }
        if line.starts_with("%hidden") { continue }
        if !live { continue }
        for words in split(line) {
            // `\;` chains commands: part of the command a bind binds, else one directive after another.
            let parts: Vec<&[String]> = if matches!(words.first().map(|w| w.as_str()), Some("bind" | "bind-key")) { vec![&words[..]] } else { words.split(|w| w == ";").filter(|p| !p.is_empty()).collect() };
            for part in parts {
                if let Err(e) = directive(part, keymap, settings) { settings.problems.push(format!("tmux.conf:{}: {e}", n + 1)) }
            }
        }
    }
}

pub fn directive(words: &[String], keymap: &mut Keymap, s: &mut Settings) -> Result<(), String> {
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
                "@hn-hint-time" => { if let Ok(ms) = value.parse::<u64>() { keymap.hint_ms = if ms == 0 { u64::MAX } else { ms } } }
                "repeat-time" => { if let Ok(ms) = value.parse() { keymap.repeat_ms = ms } }
                "status-style" => { let (fg, bg) = style(value); s.look.status_fg = fg.or(s.look.status_fg); s.look.status_bg = bg.or(s.look.status_bg) }
                "status-bg" => s.look.status_bg = colour(value),
                "status-fg" => s.look.status_fg = colour(value),
                "message-style" => { let (fg, bg) = style(value); s.look.message_fg = fg.or(s.look.message_fg); s.look.message_bg = bg.or(s.look.message_bg) }
                "pane-active-border-style" => { let (fg, _) = style(value); s.look.active_border = fg }
                "window-style" => { let (fg, bg) = style(value); s.look.window_fg = fg; s.look.window_bg = bg }
                "window-active-style" => { let (fg, bg) = style(value); s.look.active_window_fg = fg; s.look.active_window_bg = bg }
                "history-limit" => { if let Ok(n) = value.parse::<usize>() { crate::pane::HISTORY.store(n, std::sync::atomic::Ordering::Relaxed) } }
                "main-pane-width" => s.options.main_pane_width = value.trim_end_matches('%').parse().ok().map(|n: u16| if value.ends_with('%') { 1000 + n } else { n }),
                "main-pane-height" => s.options.main_pane_height = value.trim_end_matches('%').parse().ok().map(|n: u16| if value.ends_with('%') { 1000 + n } else { n }),
                "status-keys" => s.options.status_keys_vi = Some(value == "vi"),
                "copy-command" => s.options.copy_command = Some(value.to_string()).filter(|v| !v.is_empty()),
                "status-justify" => s.options.status_justify = Some(value.to_string()),
                "window-status-style" => { let (fg, bg) = style(value); s.options.window_status_style = Some((fg, bg)) }
                "pane-border-format" => s.options.pane_border_format = Some(value.to_string()),
                "status-left" => s.options.status_left = Some(value.to_string()),
                "status-right" => s.options.status_right = Some(value.to_string()),
                "status-left-length" => s.options.status_left_length = value.parse().ok(),
                "status-right-length" => s.options.status_right_length = value.parse().ok(),
                "window-status-format" => s.options.window_status_format = Some(value.to_string()),
                "window-status-current-format" => s.options.window_status_current_format = Some(value.to_string()),
                "window-status-current-style" => { let (fg, bg) = style(value); s.options.window_status_current_style = Some((fg, bg)) }
                "window-status-separator" => s.options.window_status_separator = Some(value.to_string()),
                "renumber-windows" => s.options.renumber_windows = on_off(value),
                "pane-border-status" => s.options.border_titles = Some(value != "off"),
                "mode-keys" => s.options.mode_keys_emacs = Some(value == "emacs"),
                "status" => s.options.status = on_off(value),
                // Options with no effect here (the terminal's, the server's): accepted quietly.
                "escape-time" | "default-terminal" | "terminal-overrides" | "terminal-features" | "focus-events" | "set-clipboard"
                | "allow-passthrough" | "extended-keys" | "default-shell" | "default-command" | "aggressive-resize" | "status-interval"
                | "monitor-activity" | "visual-activity" | "visual-bell" | "bell-action" | "automatic-rename" | "allow-rename"
                | "set-titles" | "set-titles-string" | "update-environment" | "destroy-unattached" | "exit-empty" | "word-separators" | "wrap-search"
                | "status-left-style" | "status-right-style" | "window-status-activity-style" | "window-status-bell-style"
                | "mode-style" | "message-command-style" | "clock-mode-colour" | "clock-mode-style" | "display-panes-colour" | "display-panes-active-colour"
                | "pane-border-lines" | "popup-style" | "popup-border-style" => {}
                "@tim" => s.options.tim_off = Some(matches!(value, "off" | "0" | "no")),
                // A user option (themes, plugins): kept, for #{@name} and show -v.
                n if n.starts_with('@') => { s.options.user.insert(n.to_string(), value.to_string()); }
                "pane-border-style" => { let (fg, _) = style(value); s.look.border = fg }
                // Not an error in your tmux.conf: noted (`hn --keys` lists them, `:set` says so).
                other => s.notes.push(format!("set {other}: not used here")),
            }
        }
        // Another file, as tmux reads it (-q: quiet when missing). Depth-limited against loops.
        "source-file" | "source" => {
            let quiet = words.iter().any(|w| w == "-q");
            for path in words[1..].iter().filter(|w| !w.starts_with('-')) {
                let path = expand_home(path);
                if s.depth > 8 { return Err("source-file nested too deep".into()) }
                match std::fs::read_to_string(&path) {
                    Ok(text) => { s.depth += 1; apply(&text, keymap, s); s.depth -= 1 }
                    Err(_) if quiet => {}
                    Err(_) => return Err(format!("{path}: No such file or directory")),
                }
            }
        }
        // if-shell at load time runs on this computer, as tmux's server would.
        "if-shell" | "if" => {
            let mut i = 1;
            let mut format = false;
            while i < words.len() && words[i].starts_with('-') && words[i].len() > 1 { if words[i].contains('F') { format = true } if words[i] == "-t" { i += 1 } i += 1 }
            let Some(cond) = words.get(i) else { return Ok(()) };
            let truth = if format { truthy(&eval(s, cond)) } else { shell_true(cond) };
            if let Some(command) = words.get(if truth { i + 1 } else { i + 2 }) {
                for part in split(command) { directive(&part, keymap, s)? }
            }
        }
        // Hooks are not run here; said so, not silently dropped.
        "set-hook" => s.notes.push(format!("set-hook {}: hooks do not run here", words[1..].join(" "))),
        // Plugins (tpm) and scripts run through tmux itself; noted, not run at load.
        "run-shell" | "run" => s.notes.push(format!("{}: not run (tmux plugins do not load here)", words[1..].join(" "))),
        "bind" | "bind-key" => {
            let mut table = Table::Prefix;
            let mut repeat = false;
            let mut i = 1;
            while i < words.len() && words[i].starts_with('-') && words[i].len() > 1 {
                let flag = &words[i];
                if flag == "-T" { i += 1; table = match words.get(i).and_then(|t| keys::table_named(t)) { Some(t) => t, None => return Ok(()) } }
                else if flag == "-N" { i += 1 }
                else { if flag.contains('n') { table = Table::Root } if flag.contains('r') { repeat = true } }
                i += 1;
            }
            let Some(key) = words.get(i) else { return Err("bind without a key".into()) };
            let chord = keys::parse(key)?;
            // Stored as a command line again: anything the tokenizer would read differently (a space,
            // a `#` that would start a comment, a quote) goes back in quotes.
            let command = words[i + 1..].iter().map(|w| quote_word(w)).collect::<Vec<_>>().join(" ");
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
                    "-T" => { i += 1; table = match words.get(i).and_then(|t| keys::table_named(t)) { Some(t) => t, None => return Ok(()) } }
                    w => key = Some(w.to_string()),
                }
                i += 1;
            }
            if all { keymap.table_mut(table).clear() }
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
set -g window-style fg=colour245,bg=colour234
set -g window-active-style fg=terminal,bg=terminal
set -g @plugin 'tmux-plugins/tpm'
bind r source-file ~/.tmux.conf \; display "Reloaded!"
unbind -T copy-mode-vi Space
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
        let mut k2 = Keymap::tmux_defaults();
        let mut s2 = Settings::default();
        apply("set -g @a x\n%if #{==:#{@a},x}\nset -g @r yes\n%else\nset -g @r no\n%endif\n%if #{>=:#{version},3.2}\nset -g @v new\n%endif\n", &mut k2, &mut s2);
        assert_eq!(s2.options.user.get("@r").map(String::as_str), Some("yes"));
        assert_eq!(s2.options.user.get("@v").map(String::as_str), Some("new"));
        assert_eq!(s.pane_base_index, Some(1));
        assert_eq!(s.status_top, Some(true));
        assert_eq!(s.look.status_bg, Some(Color::Indexed(235)));
        assert_eq!(s.look.active_border, Some(Color::Indexed(208)));
        assert_eq!(s.look.window_bg, Some(Color::Indexed(234)));
        assert_eq!(km.prefix_command(&keys::parse("r").unwrap()).unwrap().command, "source-file ~/.tmux.conf ; display Reloaded!");
        assert_eq!(km.prefix_command(&keys::parse("|").unwrap()).unwrap().command, "split-window -h -c '#{pane_current_path}'");
        assert!(km.prefix_command(&keys::parse("Space").unwrap()).is_some());
        assert_eq!(s.look.active_window_bg, Some(Color::Reset));
    }
}
