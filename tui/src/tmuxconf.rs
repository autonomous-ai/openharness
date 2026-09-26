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
    /// Every option set, as tmux keeps them (show-options, formats).
    pub store: crate::options::Store,
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
/// Marks a word that was a `{ … }` block, until it is written back (quote_word) or used.
pub const BLOCK: char = '\u{1}';

/// A command's words with their block marks taken off (what every command but bind sees).
pub fn unblock(words: &[String]) -> Vec<String> { words.iter().map(|w| w.strip_prefix(BLOCK).unwrap_or(w).to_string()).collect() }

/// A line's commands, blocks marked (split_blocks).
pub fn split_marked(line: &str) -> Vec<Vec<String>> {
    crate::commands::split_blocks(line).into_iter().map(|c| c.into_iter().map(|(w, b)| if b { format!("{BLOCK}{w}") } else { w }).collect()).collect()
}

pub fn quote_word(w: &str) -> String {
    if let Some(block) = w.strip_prefix(BLOCK) { return format!("{{ {block} }}") }
    if w == ";" { return w.to_string() }
    // A lone brace would open (or close) a block when read back.
    if !w.is_empty() && w != "{" && w != "}" && !w.chars().any(|c| c.is_whitespace() || matches!(c, '#' | '"' | '\'' | ';' | '\\')) { return w.to_string() }
    if !w.contains('\'') { return format!("'{w}'") }
    format!("\"{}\"", w.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The config's logical lines: a `{ … }` block that runs over several lines (tmux 3 configs)
/// stays one line, its own newlines kept (they separate its commands); comments inside dropped.
fn logical_lines(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut open: Option<String> = None;
    let mut depth: i32 = 0;
    for line in text.lines() {
        match open.as_mut() {
            Some(buf) => {
                let t = line.trim();
                if t.starts_with('#') || t.is_empty() { continue }
                buf.push('\n');
                buf.push_str(line);
            }
            None => open = Some(line.to_string()),
        }
        depth += brace_delta(line);
        if depth <= 0 { depth = 0; out.extend(open.take()) }
    }
    out.extend(open.take());
    out
}

/// Standalone `{` opened minus `}` closed on a line (quotes and #{formats} not counted).
fn brace_delta(line: &str) -> i32 {
    let (mut d, mut quote, mut format, mut prev) = (0i32, None::<char>, 0usize, ' ');
    let chars: Vec<char> = line.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '#') if prev.is_whitespace() && format == 0 && chars.get(i + 1) != Some(&'{') => break,
            (None, '"' | '\'') => quote = Some(c),
            (None, '{') if prev == '#' => format += 1,
            (None, '}') if format > 0 => format -= 1,
            (None, '{') if prev.is_whitespace() && chars.get(i + 1).map(|n| n.is_whitespace()).unwrap_or(true) => d += 1,
            (None, '}') if prev.is_whitespace() || i == 0 || prev == ';' => d -= 1,
            _ => {}
        }
        prev = c;
    }
    d
}

fn truthy(v: &str) -> bool { let v = v.trim(); !v.is_empty() && v != "0" }

fn unquote(s: &str) -> &str { s.trim().trim_matches('"').trim_matches('\'') }

/// The tmux level hn speaks, for version-gated configs (`%if #{>=:#{version},3.2}`).
pub const TMUX_VERSION: &str = "3.5a";

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
    let mut c = Command::new("sh");
    c.arg("-c").arg(cond).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(p) = crate::ipc::here() { c.env("HN_SOCKET", p); }
    let Ok(mut child) = c.spawn() else { return false };
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
    let joined = logical_lines(&text.replace("\\\n", " "));
    // %if / %elif / %else / %endif: a stack of (this branch runs, a branch already ran).
    let mut stack: Vec<(bool, bool)> = Vec::new();
    for (n, raw) in joined.iter().enumerate() {
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
        for words in split_marked(line) {
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
    // Only a binding keeps its blocks as blocks (written back into the command it binds).
    let plain;
    let words = if matches!(cmd.as_str(), "bind" | "bind-key") { words } else { plain = unblock(words); &plain[..] };
    match cmd.as_str() {
        "set" | "set-option" | "setw" | "set-window-option" => {
            // tmux's flags, then the option and its value — checked and kept as tmux keeps them
            // (show-options, formats); then the options hn acts on read the value now in force. In a
            // file there is no current session yet, so everything is global.
            let (f, quiet, _format, _target, args) = set_flags(&words[1..], matches!(cmd.as_str(), "setw" | "set-window-option"));
            let Some(name) = args.first().cloned() else { return Err("command set-option: too few arguments (need at least 1)".into()) };
            let f = crate::options::SetFlags { global: true, ..f };
            let now = match s.options.store.set(&name, args.get(1).map(|v| v.as_str()), &f, "", 0) {
                Ok(now) => now.unwrap_or_default(),
                Err(e) if quiet && e.starts_with("invalid option") => return Ok(()),
                Err(e) => return Err(e),
            };
            let (name, value) = (&name, now.as_str());
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
                "@tim" => s.options.tim_off = Some(matches!(value, "off" | "0" | "no")),
                // A user option (themes, plugins): kept, for #{@name} and show -v.
                n if n.starts_with('@') => { s.options.user.insert(n.to_string(), value.to_string()); }
                "pane-border-style" => { let (fg, _) = style(value); s.look.border = fg }
                // Every other tmux option is kept as tmux keeps it, for show-options and formats.
                _ => {}
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
            // A table of your own (`bind -T resize h …`), reached with switch-client -T.
            let mut named: Option<String> = None;
            let mut repeat = false;
            let mut note = String::new();
            let mut i = 1;
            while i < words.len() && words[i].starts_with('-') && words[i].len() > 1 {
                let flag = &words[i];
                if flag == "-T" {
                    i += 1;
                    let Some(t) = words.get(i) else { return Err("command bind-key: -T expects an argument".into()) };
                    match keys::table_named(t) { Some(t) => table = t, None => named = Some(t.clone()) }
                }
                else if flag == "-N" { i += 1; note = words.get(i).cloned().unwrap_or_default() }
                else { if flag.contains('n') { table = Table::Root } if flag.contains('r') { repeat = true } }
                i += 1;
            }
            let Some(key) = words.get(i) else { return Err("bind without a key".into()) };
            let chord = keys::parse(key)?;
            // Stored as a command line again: anything the tokenizer would read differently (a space,
            // a `#` that would start a comment, a quote) goes back in quotes.
            // One argument (a `{ }` block, or a quoted string) is a command list of its own, as
            // tmux parses it; several are one command's words.
            let rest = &words[i + 1..];
            let command = if rest.len() == 1 { rest[0].strip_prefix(BLOCK).unwrap_or(&rest[0]).trim().to_string() } else { rest.iter().map(|w| quote_word(w)).collect::<Vec<_>>().join(" ") };
            if command.is_empty() { return Err(format!("bind {key} without a command")) }
            match named {
                Some(t) => {
                    let list = keymap.named.entry(t).or_default();
                    list.retain(|b| b.chord != chord);
                    list.push(keys::Binding { chord, command, repeat, note });
                }
                None => {
                    keymap.bind(table, chord, command, repeat);
                    if !note.is_empty() { if let Some(b) = keymap.table_mut(table).iter_mut().rev().find(|b| b.chord == chord) { b.note = note } }
                }
            }
        }
        "unbind" | "unbind-key" => {
            // tmux's unbind-key [-anq] [-T key-table] key: -a every key of the table, -n root's,
            // -q no complaint; the table must exist and the key must be one.
            let (mut table, mut all, mut quiet, mut key, mut named) = (Table::Prefix, false, false, None, None);
            let mut i = 1;
            while i < words.len() {
                match words[i].as_str() {
                    "-a" => all = true,
                    "-n" => table = Table::Root,
                    "-q" => quiet = true,
                    "-T" => { i += 1; named = words.get(i).cloned() }
                    w => key = Some(w.to_string()),
                }
                i += 1;
            }
            let fail = |e: String| if quiet { Ok(()) } else { Err(e) };
            if all && key.is_some() { return fail("key given with -a".into()) }
            if let Some(name) = &named {
                match keys::table_named(name) {
                    Some(t) => table = t,
                    None if keymap.named.contains_key(name) => {
                        if all { keymap.named.remove(name); return Ok(()) }
                        let Some(k) = key else { return fail("missing key".into()) };
                        let chord = match keys::parse(&k) { Ok(c) => c, Err(e) => return fail(e) };
                        if let Some(list) = keymap.named.get_mut(name) { list.retain(|b| b.chord != chord) }
                        return Ok(());
                    }
                    None => return fail(format!("table {name} doesn't exist")),
                }
            }
            if all { keymap.remove_table(table); return Ok(()) }
            let Some(k) = key else { return fail("missing key".into()) };
            let chord = match keys::parse(&k) { Ok(c) => c, Err(e) => return fail(e) };
            keymap.unbind(table, &chord);
        }
        _ => {}
    }
    Ok(())
}

/// set-option's flags (`-aFgopqsuUw`, `-t target`), and the words after them: the flags, quiet
/// (-q), format (-F), the target, the option and its value.
pub fn set_flags(words: &[String], window: bool) -> (crate::options::SetFlags, bool, bool, Option<String>, Vec<String>) {
    let mut f = crate::options::SetFlags { window, ..Default::default() };
    let (mut quiet, mut format, mut target) = (false, false, None);
    let mut rest = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let w = &words[i];
        if rest.is_empty() && w == "--" { i += 1; rest.extend(words[i..].iter().cloned()); break }
        if rest.is_empty() && w.starts_with('-') && w.len() > 1 {
            let chars: Vec<char> = w[1..].chars().collect();
            for (k, c) in chars.iter().enumerate() {
                match c {
                    'g' => f.global = true, 's' => f.server = true, 'w' => f.window = true, 'p' => f.pane = true,
                    'u' | 'U' => f.unset = true, 'a' => f.append = true, 'o' => f.only_if_unset = true,
                    'q' => quiet = true, 'F' => format = true,
                    't' => {
                        let tail: String = chars[k + 1..].iter().collect();
                        target = if tail.is_empty() { i += 1; words.get(i).cloned() } else { Some(tail) };
                        break;
                    }
                    _ => {}
                }
            }
            i += 1;
            continue;
        }
        rest.push(w.clone());
        i += 1;
    }
    (f, quiet, format, target, rest)
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
        // tmux 3 blocks over several lines, and in one.
        let mut k3 = Keymap::tmux_defaults();
        let mut s3 = Settings::default();
        apply("bind -n M-h if -F '#{pane_at_left}' {\n  send-keys M-h\n} {\n  # go left\n  select-pane -L\n}\nbind , command-prompt -I \"#W\" { rename-window \"%%\" }\nset -g @after yes\n", &mut k3, &mut s3);
        assert!(s3.problems.is_empty(), "{:?}", s3.problems);
        let mh = k3.root_command(&keys::parse("M-h").unwrap()).unwrap().command.clone();
        assert!(mh.contains("send-keys M-h") && mh.contains("select-pane -L"), "{mh}");
        assert!(k3.prefix_command(&keys::parse(",").unwrap()).unwrap().command.contains("rename-window"));
        assert_eq!(s3.options.user.get("@after").map(String::as_str), Some("yes"));
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
