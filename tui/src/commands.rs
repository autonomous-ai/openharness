//! tmux commands. Every key, the `:` prompt and `~/.tmux.conf` speak the same language —
//! `split-window -h`, `select-layout tiled`, `confirm-before -p "kill-pane #P? (y/n)" kill-pane` —
//! and this is where a command line becomes an action on tabs (windows), panes and harnesses.

use crate::app::{App, Placement};
use crate::input;
use crate::layout::{Dir, Preset, Toward};
use crate::modal::{Filter, Modal, Prompt, PromptKind};
use crate::theme;

/// Every command the `:` prompt completes, with what it does (tmux names and their aliases).
pub const COMMANDS: &[(&str, &str, &str)] = &[
    ("new-window", "neww", "A new window with a shell (-d: stay here, -a: after this one, -n name, -c dir, a command)"),
    ("split-window", "splitw", "A shell beside (-h) or below the pane (-c dir, a command, -P -F prints it)"),
    ("kill-pane", "killp", "Close the active pane (the harness keeps running)"),
    ("kill-window", "killw", "Close the window (its harnesses keep running)"),
    ("next-window", "next", "Next window (-a: next with an alert)"),
    ("previous-window", "prev", "Previous window (-a: previous with an alert)"),
    ("last-window", "last", "The previously current window"),
    ("select-window", "selectw", "Select a window: -t index, name, ^ $ ! +N -N, @id; -l the last"),
    ("rename-window", "renamew", "Rename the window"),
    ("move-window", "movew", "Move a window: -t index (-s which one), -r renumber, -L/-R"),
    ("select-pane", "selectp", "Select a pane: -L -R -U -D, -t target, -l last; -m/-M mark; -T title"),
    ("last-pane", "lastp", "The previously active pane"),
    ("resize-pane", "resizep", "Resize: -L -R -U -D [n], -x/-y size, -Z zoom"),
    ("swap-pane", "swapp", "Swap panes: -U, -D, -s/-t, or with the marked pane"),
    ("break-pane", "breakp", "Move the pane to a window of its own"),
    ("rotate-window", "rotatew", "Rotate the panes (-D: the other way)"),
    ("next-layout", "nextl", "The next layout"),
    ("select-layout", "selectl", "even-horizontal even-vertical main-horizontal[-mirrored] main-vertical[-mirrored] tiled, a layout string, -E"),
    ("display-panes", "displayp", "Show pane numbers; press one to select it"),
    ("copy-mode", "copy-mode", "Copy mode, tmux's copy-mode-vi keys (-u: and scroll up)"),
    ("paste-buffer", "pasteb", "Paste a buffer into a pane (-b name, -t pane)"),
    ("choose-buffer", "choose-buffer", "Choose a paste buffer"),
    ("list-buffers", "lsb", "List paste buffers"),
    ("delete-buffer", "deleteb", "Delete a buffer (-b name, else the newest)"),
    ("choose-tree", "choose-tree", "-w windows · -s harnesses · -m machines · -a waiting · -i models · -S store"),
    ("find-window", "findw", "Find a harness on any machine by what you type"),
    ("display-message", "display", "A message or format (-p prints it, -t a pane)"),
    ("show-messages", "showmsgs", "Messages so far"),
    ("list-keys", "lsk", "Key bindings (-T a table, -1N one key)"),
    ("list-windows", "lsw", "The windows (-F a format)"),
    ("list-panes", "lsp", "The panes (-a/-s every window, -t one, -F a format)"),
    ("list-sessions", "ls", "The session (this computer) and its windows"),
    ("list-clients", "lsc", "This client"),
    ("show-options", "show", "Options as they are now"),
    ("set-option", "set", "Set an option: set -g mouse on"),
    ("set-window-option", "setw", "Set a window option: setw -g mode-keys vi"),
    ("bind-key", "bind", "Bind a key: bind h select-pane -L"),
    ("unbind-key", "unbind", "Unbind a key"),
    ("source-file", "source", "Read a tmux.conf again: source ~/.tmux.conf"),
    ("swap-window", "swapw", "Swap this window with another: swap-window -t 2"),
    ("join-pane", "joinp", "Move this pane into another window: join-pane -t :1"),
    ("move-pane", "movep", "Same as join-pane"),
    ("clear-history", "clearhist", "Forget this pane's scrollback (here)"),
    ("capture-pane", "capturep", "A pane's text into a buffer, or printed (-p, -S/-E lines, -t)"),
    ("set-buffer", "setb", "Put text in a buffer (-b name, -a append)"),
    ("show-buffer", "showb", "Print a buffer (-b name)"),
    ("respawn-pane", "respawnp", "Restart the harness in this pane"),
    ("suspend-client", "suspendc", "Suspend (C-z); fg brings it back"),
    ("tim", "tim", "tim, the creature in the status line: how it is (set -g @tim off hides it)"),
    ("display-popup", "popup", "A shell (or a command: display-popup -E lazygit) floating over the window"),
    ("list-commands", "lscm", "Every command"),
    ("display-menu", "menu", "A menu: display-menu -T title name key command …"),
    ("customize-mode", "customize-mode", "Options and keys, as they are"),
    ("has-session", "has", "Is it running (for scripts: hn has-session)"),
    ("set-environment", "setenv", "Set a variable for this client"),
    ("show-environment", "showenv", "Variables set with setenv"),
    ("save-buffer", "saveb", "Write the newest buffer to a file (- prints it)"),
    ("load-buffer", "loadb", "Read a file into a buffer"),
    ("previous-layout", "prevl", "The layout before this one"),
    ("show-window-options", "showw", "Same as show-options"),
    ("rename-session", "rename", "What this session (this computer) is called here"),
    ("clock-mode", "clock-mode", "A clock"),
    ("refresh-client", "refresh", "Redraw"),
    ("detach-client", "detach", "Detach — everything keeps running"),
    ("kill-server", "kill-server", "Quit (harnesses keep running)"),
    ("switch-client", "switchc", "-l: the last harness · -n/-p: next/previous harness"),
    ("send-keys", "send", "Type keys into the pane: send-keys 'make test' Enter"),
    ("command-prompt", "command-prompt", "Prompt for a command"),
    ("confirm-before", "confirm", "Ask y/n before a command"),
    ("new-harness", "newh", "New harness: [engine] [@machine] [folder] — or choose"),
    ("new-terminal", "newt", "A shell on this pane's machine"),
    ("clone-harness", "cloneh", "A second harness with this one's history"),
    ("restart-harness", "restarth", "Restart this harness"),
    ("pause-harness", "pauseh", "Pause this harness (the conversation is kept)"),
    ("resume-harness", "resumeh", "Resume this harness"),
    ("rename-harness", "renameh", "Rename this harness"),
    ("send-task", "task", "Send a task — Harness picks the harness"),
    ("broadcast", "bcast", "Send one message to every harness in the window"),
    ("send-message", "msg", "Send a message (a turn) to this harness"),
];

/// Split a command line the way tmux does: words, quotes, and `;` between commands.
pub fn split(line: &str) -> Vec<Vec<String>> {
    split_blocks(line).into_iter().map(|c| c.into_iter().map(|(w, _)| w).collect()).collect()
}

/// `split`, each word marked when it was a `{ … }` block (so it can be written back as one).
pub fn split_blocks(line: &str) -> Vec<Vec<(String, bool)>> {
    let mut commands: Vec<Vec<(String, bool)>> = vec![Vec::new()];
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut in_word = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') => { if let Some(n) = chars.next() { word.push(n) } }
            (Some(_), c) => word.push(c),
            (None, '"' | '\'') => { quote = Some(c); in_word = true }
            // `\;` is a `;` that belongs to the command being bound (`bind r source-file x \; display y`):
            // a word of its own, split out only when that binding runs.
            (None, '\\') => {
                if let Some(n) = chars.next() {
                    if n == ';' {
                        if in_word || !word.is_empty() { commands.last_mut().unwrap().push((std::mem::take(&mut word), false)); in_word = false }
                        commands.last_mut().unwrap().push((";".into(), false));
                        continue;
                    }
                    word.push(n); in_word = true
                }
            }
            (None, ';') if word.is_empty() && !in_word => commands.push(Vec::new()),
            (None, ';') if chars.peek().map(|n| n.is_whitespace()).unwrap_or(true) => { commands.last_mut().unwrap().push((std::mem::take(&mut word), false)); in_word = false; commands.push(Vec::new()) }
            // `{ … }`: tmux's command block — one argument, the commands inside it (lines become `;`).
            (None, '{') if word.is_empty() && !in_word && chars.peek().map(|n| n.is_whitespace()).unwrap_or(true) => {
                let block = take_block(&mut chars);
                commands.last_mut().unwrap().push((block, true));
            }
            (None, '#') if word.is_empty() && !in_word => break,
            (None, c) if c.is_whitespace() => { if in_word || !word.is_empty() { commands.last_mut().unwrap().push((std::mem::take(&mut word), false)); in_word = false } }
            (None, c) => { word.push(c); in_word = true }
        }
    }
    if in_word || !word.is_empty() { commands.last_mut().unwrap().push((word, false)) }
    commands.retain(|c| !c.is_empty());
    commands
}

/// The inside of a `{ … }` block, up to its standalone closing `}` (nested blocks, quotes and
/// `#{format}` braces kept whole); newlines separate its commands, as `;` does.
fn take_block(chars: &mut std::iter::Peekable<std::str::Chars>) -> String {
    let mut out = String::new();
    let (mut depth, mut quote, mut format, mut prev) = (1usize, None::<char>, 0usize, ' ');
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => { quote = None; out.push(c) }
            (Some(_), c) => out.push(c),
            (None, '"' | '\'') => { quote = Some(c); out.push(c) }
            (None, '{') if prev == '#' => { format += 1; out.push(c) }
            (None, '}') if format > 0 => { format -= 1; out.push(c) }
            (None, '{') if prev.is_whitespace() && chars.peek().map(|n| n.is_whitespace()).unwrap_or(true) => { depth += 1; out.push(c) }
            (None, '}') if prev.is_whitespace() || prev == ';' => {
                depth -= 1;
                if depth == 0 { break }
                out.push(c)
            }
            (None, '\n') if depth == 1 => {
                // A line break between commands: `;`, the next line's indent dropped.
                while chars.peek().map(|n| *n == ' ' || *n == '\t').unwrap_or(false) { chars.next(); }
                let t = out.trim_end().len();
                out.truncate(t);
                if !out.is_empty() && !out.ends_with(';') { out.push_str(" ;") }
                out.push(' ');
                prev = ' ';
                continue;
            }
            (None, c) => out.push(c),
        }
        prev = c;
    }
    out.trim().trim_matches(';').trim().to_string()
}

/// A tmux format, expanded (see format.rs).
pub fn expand(app: &App, text: &str) -> String { crate::format::text(app, text, None) }

/// The shell command a split-window / new-window was given (its last positional word).
fn shell_command(words: &[String]) -> Option<String> {
    let mut i = 1;
    let mut last = None;
    while i < words.len() {
        match words[i].as_str() {
            "-c" | "-l" | "-t" | "-n" | "-e" | "-F" | "-p" => i += 1,
            w if w.starts_with('-') && w.len() > 1 => {}
            w => last = Some(w.to_string()),
        }
        i += 1;
    }
    last.filter(|c| !c.trim().is_empty())
}

/// vim-tmux-navigator's test of a pane's command: `^g?(view|l?n?vim?x?|fzf)(diff)?$`.
fn is_vim_command(cmd: &str) -> bool {
    let c = cmd.rsplit('/').next().unwrap_or(cmd);
    let c = c.strip_prefix('g').filter(|r| !r.is_empty() && (r.starts_with('v') || r.starts_with('n') || r.starts_with('l'))).unwrap_or(c);
    let c = c.strip_suffix("diff").unwrap_or(c);
    if c == "view" || c == "fzf" { return true }
    let c = c.strip_prefix('l').unwrap_or(c);
    let c = c.strip_prefix('n').unwrap_or(c);
    let c = c.strip_suffix('x').unwrap_or(c);
    c == "vi" || c == "vim"
}

/// `40` or `30%` of `total`.
fn size_arg(v: &str, total: u16) -> Option<u16> {
    match v.strip_suffix('%') { Some(p) => p.parse::<u32>().ok().map(|p| (total as u32 * p / 100) as u16), None => v.parse().ok() }
}

/// A pane target: `:W.P`, `W.P`, `.P`, `P` (index), `%N` (id), `!` (the last pane).
pub fn pane_target(app: &App, target: &str) -> Option<(usize, u64)> {
    let target = unsession(app, target)?;
    let target = if target.is_empty() { ":" } else { target };
    if let Some(id) = target.strip_prefix('%').and_then(|n| n.parse::<u64>().ok()) {
        return app.tabs.iter().position(|t| t.panes().contains(&id)).map(|w| (w, id));
    }
    if target == "!" || target == "{last}" { return app.tab().last_focus.map(|p| (app.active, p)) }
    if target == "{marked}" { return app.marked.and_then(|m| app.tabs.iter().position(|t| t.panes().contains(&m)).map(|w| (w, m))) }
    // {up-of} {down-of} {left-of} {right-of}: the pane that way from this one.
    for (name, toward) in [("{up-of}", Toward::Up), ("{down-of}", Toward::Down), ("{left-of}", Toward::Left), ("{right-of}", Toward::Right)] {
        if target == name { return app.focused().and_then(|f| crate::layout::neighbour(&app.rects, f, toward)).map(|p| (app.active, p)) }
    }
    // {top} {bottom} {left} {right} and their corners: the pane at that edge of this window.
    if target.starts_with('{') && target.ends_with('}') {
        let rects = &app.rects;
        let pick = |key: &dyn Fn(&ratatui::layout::Rect) -> i32| rects.iter().min_by_key(|(_, r)| key(r)).map(|(id, _)| (app.active, *id));
        return match target {
            "{top}" => pick(&|r| r.y as i32), "{bottom}" => pick(&|r| -((r.y + r.height) as i32)),
            "{left}" => pick(&|r| r.x as i32), "{right}" => pick(&|r| -((r.x + r.width) as i32)),
            "{top-left}" => pick(&|r| r.x as i32 + r.y as i32), "{bottom-right}" => pick(&|r| -((r.x + r.width + r.y + r.height) as i32)),
            "{top-right}" => pick(&|r| r.y as i32 * 1000 - (r.x + r.width) as i32), "{bottom-left}" => pick(&|r| -((r.y + r.height) as i32 * 1000) + r.x as i32),
            _ => None,
        };
    }
    let (w, p) = match target.rsplit_once('.') { Some((w, p)) => (w, p), None if target.starts_with(':') => (target, ""), None => ("", target) };
    let window = if w.is_empty() { app.active } else { window_target(app, w)? };
    let panes = app.tabs[window].panes();
    let pane = match p {
        "" => app.tabs[window].focus?,
        "+" => { let at = panes.iter().position(|x| Some(*x) == app.tabs[window].focus)?; panes[(at + 1) % panes.len()] }
        "-" => { let at = panes.iter().position(|x| Some(*x) == app.tabs[window].focus)?; panes[(at + panes.len() - 1) % panes.len()] }
        n => *panes.get(n.parse::<usize>().ok()?.checked_sub(app.pane_base_index)?)?,
    };
    Some((window, pane))
}

/// A window target, as tmux reads one: `:2`, `=2`, `^` first, `$` last, `!` the last window,
/// `+`/`-` (with a count) next/previous, or a name's start.
/// `session:rest` → `rest` when the session is this one (tmux scripts qualify every target).
fn unsession<'a>(app: &App, target: &'a str) -> Option<&'a str> {
    match target.split_once(':') {
        Some((sess, rest)) if !sess.is_empty() && !sess.starts_with('{') && !sess.starts_with('%') => {
            let name = app.session_name();
            let sess = sess.trim_start_matches('=').trim_start_matches('$');
            (sess == name || name.starts_with(sess) || sess == "0").then_some(rest)
        }
        _ => Some(target),
    }
}

fn window_target(app: &App, target: &str) -> Option<usize> {
    let target = unsession(app, target)?;
    let t = target.trim_start_matches(':').trim_start_matches('=');
    let n = app.tabs.len();
    if n == 0 { return None }
    match t {
        "" => Some(app.active),
        "^" | "{start}" => Some(0),
        "$" | "{end}" => Some(n - 1),
        "{next}" => Some((app.active + 1) % n),
        "{previous}" => Some((app.active + n - 1) % n),
        t if t.starts_with('@') => t[1..].parse::<usize>().ok().and_then(|n| app.tab_by_num(n)),
        "!" | "{last}" => app.last_tab.as_ref().and_then(|id| app.tabs.iter().position(|x| &x.id == id)),
        _ if t.starts_with('+') || t.starts_with('-') => {
            let by: i64 = t[1..].parse().unwrap_or(1);
            let by = if t.starts_with('-') { -by } else { by };
            Some((app.active as i64 + by).rem_euclid(n as i64) as usize)
        }
        _ => match t.parse::<usize>() {
            Ok(k) => app.tab_by_num(k),
            Err(_) => app.tabs.iter().position(|x| x.name.to_lowercase().starts_with(&t.to_lowercase())),
        },
    }
}

/// What tmux's list-* commands print.
fn listing(app: &App, command: &str) -> Vec<String> {
    let window = |i: usize| {
        let tab = &app.tabs[i];
        let flag = if i == app.active { "*" } else if app.last_tab.as_ref() == Some(&tab.id) { "-" } else { "" };
        format!("{}: {}{flag} ({} panes){}", app.win_num(i), tab.name, tab.panes().len(), if i == app.active { " (active)" } else { "" })
    };
    match command {
        "list-windows" => (0..app.tabs.len()).map(window).collect(),
        "list-panes" => app.tab().panes().iter().enumerate().map(|(i, id)| {
            let p = app.panes.get(id);
            let (c, r) = app.rects.iter().find(|(x, _)| x == id).map(|(_, r)| (r.width, r.height.saturating_sub(app.header_rows()))).or(p.map(|p| (p.cols, p.rows))).unwrap_or((0, 0));
            let title = p.and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| a.name.clone()).unwrap_or_default();
            let machine = p.map(|p| app.fleet.machine_name(&p.machine_id)).unwrap_or_default();
            format!("{}: [{c}x{r}] \"{title}\" {machine} %{id}{}", i + app.pane_base_index, if Some(*id) == app.focused() { " (active)" } else { "" })
        }).collect(),
        "list-sessions" => {
            vec![format!("{}: {} windows (attached)", app.session_name(), app.tabs.len())]
        }
        "list-clients" => vec![format!("{}: {} [{}x{} {}] (utf8)", std::env::var("SSH_TTY").or_else(|_| std::env::var("TTY")).unwrap_or_else(|_| "tty".into()), app.session_name(), app.size.0, app.size.1, std::env::var("TERM").unwrap_or_default())],
        _ => app.opts.user.iter().map(|(k, v)| format!("{k} \"{v}\"")).chain(vec![
            format!("base-index {}", app.base_index),
            format!("mode-keys {}", if app.opts.mode_keys_emacs == Some(true) { "emacs" } else { "vi" }),
            format!("renumber-windows {}", if app.opts.renumber_windows == Some(true) { "on" } else { "off" }),
            format!("status {}", if app.opts.status == Some(false) { "off" } else { "on" }),
            format!("status-justify {}", app.opts.status_justify.clone().unwrap_or_else(|| "left".into())),
            format!("pane-border-format {}", app.opts.pane_border_format.clone().map(|s| format!("\"{s}\"")).unwrap_or_else(|| "(hn's: index, title, state, machine)".into())),
            format!("history-limit {}", crate::pane::HISTORY.load(std::sync::atomic::Ordering::Relaxed)),
            format!("escape-time 0"),
            format!("display-time {}", app.display_ms),
            format!("status-left {}", app.opts.status_left.clone().map(|s| format!("\"{s}\"")).unwrap_or_else(|| "\"[#S] \"".into())),
            format!("status-right {}", app.opts.status_right.clone().map(|s| format!("\"{s}\"")).unwrap_or_else(|| r##""#{=21:pane_title}" %H:%M %d-%b-%y"##.into())),
            format!("synchronize-panes {}", if app.tab().sync { "on" } else { "off" }),
            format!("pane-border-status {}", if app.opts.border_titles == Some(false) { "off" } else { "top" }),
            format!("@hn-hint-time {}", if app.keymap.hint_ms == u64::MAX { 0 } else { app.keymap.hint_ms }),
            format!("main-pane-width {}", app.opts.main_pane_width.map(|v| if v >= 1000 { format!("{}%", v - 1000) } else { v.to_string() }).unwrap_or_else(|| "80".into())),
            format!("main-pane-height {}", app.opts.main_pane_height.map(|v| if v >= 1000 { format!("{}%", v - 1000) } else { v.to_string() }).unwrap_or_else(|| "24".into())),
            format!("display-panes-time {}", app.display_panes_ms),
            format!("display-time {}", app.display_ms),
            format!("mouse {}", if app.mouse { "on" } else { "off" }),
            format!("pane-base-index {}", app.pane_base_index),
            format!("prefix {}", crate::keys::name(&app.keymap.prefix)),
            format!("prefix2 {}", app.keymap.prefix2.map(|c| crate::keys::name(&c)).unwrap_or_else(|| "None".into())),
            format!("repeat-time {}", app.keymap.repeat_ms),
            format!("status-position {}", if app.status_top { "top" } else { "bottom" }),
        ]).collect(),
    }
}

/// A bound command as tmux prints it: canonical names, double quotes, `\;` between commands.
fn canonical(command: &str) -> String { canonical_with(command, " \\; ") }

/// Inside a block, tmux separates the commands with a plain `;`.
fn canonical_with(command: &str, separator: &str) -> String {
    split_blocks(command).iter().map(|words| {
        words.iter().enumerate().map(|(i, (w, block))| {
            if *block { return format!("{{ {} }}", canonical_with(w, " ; ")) }
            if i == 0 { return resolve(w).to_string() }
            if w == ";" { return "\\;".into() }
            // tmux's args_escape: what list-keys prints reads back the same.
            crate::options::escape(w)
        }).collect::<Vec<_>>().join(" ")
    }).collect::<Vec<_>>().join(separator)
}

/// A tmux command's name or alias (for `hn <command>` from a shell).
/// A title with its `#[…]` styles taken out (a menu's border draws it plain).
fn strip_styles(t: &str) -> String {
    let mut out = String::new();
    let mut rest = t;
    while let Some(i) = rest.find("#[") {
        out.push_str(&rest[..i]);
        rest = rest[i..].find(']').map(|j| &rest[i + j + 1..]).unwrap_or("");
    }
    out.push_str(rest);
    out
}

pub fn is_command_name(name: &str) -> bool {
    COMMANDS.iter().any(|(full, alias, _)| *full == name || *alias == name)
        || matches!(name, "display" | "send" | "neww" | "splitw" | "killp" | "killw" | "selectw" | "selectp" | "lsw" | "lsp" | "ls" | "capturep" | "showw" | "show" | "set" | "bind" | "unbind" | "source" | "run" | "if"
            | "run-shell" | "if-shell" | "wait-for" | "wait" | "pipe-pane" | "pipep" | "set-hook" | "show-hooks" | "resize-window" | "resizew" | "kill-session" | "send-prefix" | "display-menu" | "menu"
            | "set-option" | "set-window-option" | "setw" | "bind-key" | "unbind-key" | "source-file" | "kill-server" | "detach-client" | "detach"
            | "customize-mode" | "refresh-client" | "refresh")
}

/// A command's full name from any alias (`splitw` → `split-window`), for comparing with tmux.
#[cfg(test)]
pub fn canonical_name(name: &str) -> String { resolve(name).to_string() }

fn resolve(name: &str) -> &str {
    COMMANDS.iter().find(|(full, alias, _)| *full == name || *alias == name).map(|(full, _, _)| *full).unwrap_or(name)
}

/// Run a command line (one or more commands separated by `;`), in order. A shell command tmux
/// waits for (if-shell, run-shell) runs off the screen's thread, and the commands after it wait for
/// it, as tmux's command queue does; from a shell (`hn <command>`) it is simply waited for.
pub fn execute(app: &mut App, line: &str) {
    // A bound `\;` runs here as the separator it stood for.
    let queue: std::collections::VecDeque<Vec<String>> = crate::tmuxconf::split_marked(line).into_iter()
        .flat_map(|words| words.split(|w| w == ";").filter(|p| !p.is_empty()).map(|p| p.to_vec()).collect::<Vec<_>>())
        .collect();
    run_queue(app, queue);
}

fn run_queue(app: &mut App, mut queue: std::collections::VecDeque<Vec<String>>) {
    while let Some(words) = queue.pop_front() {
        if app.capture.is_none() {
            if let Some(job) = shell_job(app, &words) {
                let Job { command, cwd, delay, background, done } = job;
                let run = async move {
                    if delay > 0.0 { tokio::time::sleep(std::time::Duration::from_secs_f64(delay)).await }
                    let mut c = tokio::process::Command::new("/bin/sh");
                    c.arg("-c").arg(&command).stdin(std::process::Stdio::null());
                    if let Some(p) = crate::ipc::here() { c.env("HN_SOCKET", p); }
                    if let Some(d) = cwd { c.current_dir(d); }
                    match c.output().await {
                        Ok(o) => (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string() + &String::from_utf8_lossy(&o.stderr)),
                        Err(e) => (-1, e.to_string()),
                    }
                };
                if background {
                    // -b: in the background; the next commands do not wait.
                    app.spawn(run, move |app, (code, out)| done(app, code, out));
                    continue;
                }
                app.spawn(run, move |app, (code, out)| { done(app, code, out); run_queue(app, queue) });
                return;
            }
        }
        run_words(app, &words);
    }
}

/// A shell command to run, and what to do with its exit status and output.
struct Job { command: String, cwd: Option<String>, delay: f64, background: bool, done: Box<dyn FnOnce(&mut App, i32, String) + Send> }

/// if-shell and run-shell that go to the shell (not -F, not -C): the job, its command already
/// expanded as a format for its pane (-t), as tmux's are.
fn shell_job(app: &App, words: &[String]) -> Option<Job> {
    let words = &crate::tmuxconf::unblock(words)[..];
    let command = resolve(words.first()?.as_str());
    let (mut background, mut format, mut tmux_cmd, mut target, mut cwd, mut delay, mut args) = (false, false, false, None, None, 0.0, Vec::new());
    let mut i = 1;
    while i < words.len() {
        let w = &words[i];
        if args.is_empty() && w.starts_with('-') && w.len() > 1 {
            let chars: Vec<char> = w[1..].chars().collect();
            for (k, c) in chars.iter().enumerate() {
                match c {
                    'b' => background = true, 'F' => format = true, 'C' => tmux_cmd = true,
                    't' | 'c' | 'd' => {
                        let tail: String = chars[k + 1..].iter().collect();
                        let v = if tail.is_empty() { i += 1; words.get(i).cloned() } else { Some(tail) };
                        match c { 't' => target = v, 'c' => cwd = v, _ => delay = v.and_then(|d| d.parse().ok()).unwrap_or(0.0) }
                        break;
                    }
                    _ => {}
                }
            }
        } else { args.push(w.clone()) }
        i += 1;
    }
    let (w, p) = match target.as_deref() { Some(t) => pane_target(app, t)?, None => (app.active, app.focused()?) };
    match command {
        "if-shell" => {
            if format { return None }
            let cond = args.first()?.clone();
            // vim-tmux-navigator asks `ps` about the pane's tty: a pane on another machine has none
            // here, so hn answers from what that machine says the pane runs (run_words).
            if cond.contains("pane_tty") && app.panes.get(&p).and_then(|x| x.remote_tty.clone()).is_none() { return None }
            let expanded = crate::format::expand(app, &cond, w, Some(p), false);
            let (yes, no) = (args.get(1).cloned(), args.get(2).cloned());
            Some(Job { command: expanded, cwd: None, delay: 0.0, background, done: Box::new(move |app, code, _| { if let Some(c) = if code == 0 { yes } else { no } { execute(app, &c) } }) })
        }
        "run-shell" => {
            if tmux_cmd || args.is_empty() { return None }
            let cmd = args.join(" ");
            let expanded = crate::format::expand(app, &cmd, w, Some(p), false);
            let shown = cmd.clone();
            Some(Job { command: expanded, cwd: cwd.map(|d| crate::tmuxconf::expand_home(&d)), delay, background, done: Box::new(move |app, code, out| {
                // What it printed, in view mode; a failure says so, as tmux's does.
                let mut lines: Vec<String> = out.lines().map(str::to_string).collect();
                if code != 0 { lines.push(format!("'{shown}' returned {code}")) }
                if !lines.is_empty() { app.print("run-shell", lines) }
            }) })
        }
        _ => None,
    }
}

fn flag(words: &[String], f: &str) -> bool { words.iter().skip(1).any(|w| w == f || (w.starts_with('-') && !w.starts_with("--") && w.len() > 2 && w[1..].contains(&f[1..]) && f.len() == 2)) }
fn opt(words: &[String], f: &str) -> Option<String> {
    let at = words.iter().position(|w| w == f)?;
    words.get(at + 1).cloned()
}
/// The positional words: past the flags and the values the flags take (`-t x`, `-l 10`).
fn positional(words: &[String]) -> Vec<String> {
    const VALUED: &str = "tcdFlnpsxyTIeNPb";
    let mut out = Vec::new();
    let mut i = 1;
    while i < words.len() {
        let w = &words[i];
        if out.is_empty() && w.starts_with('-') && w.len() > 1 && w.parse::<f64>().is_err() {
            if w == "--" { out.extend(words[i + 1..].iter().cloned()); break }
            // A flag that takes a value, last in its cluster, takes the next word.
            if w.len() == 2 && VALUED.contains(&w[1..]) { i += 1 }
            i += 1;
            continue;
        }
        out.push(w.clone());
        i += 1;
    }
    out
}

fn rest(words: &[String]) -> String {
    // Everything after the options: the positional text.
    let mut out = Vec::new();
    let mut i = 1;
    while i < words.len() {
        let w = &words[i];
        if w.starts_with('-') && w.len() > 1 && out.is_empty() {
            if matches!(w.as_str(), "-t" | "-n" | "-p" | "-I" | "-c" | "-T" | "-F") { i += 2 } else { i += 1 }
            continue;
        }
        out.push(w.clone());
        i += 1;
    }
    out.join(" ")
}

fn run_words(app: &mut App, words: &[String]) {
    let Some(first) = words.first() else { return };
    let command = resolve(first);
    // Blocks are plain arguments to every command but bind (which writes them back as blocks).
    let plain;
    let words = if command == "bind-key" { words } else { plain = crate::tmuxconf::unblock(words); &plain[..] };
    match command {
        "new-window" => {
            let was = app.active;
            let cwd = opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty());
            let command = shell_command(words);
            // The pane this came from decides the machine and folder — read before the new window.
            let from = input::focused_agent(app);
            let last_before = app.last_tab.clone();
            let was_id = app.tab().id.clone();
            let _ = was;
            // -t N: at that index (tmux: "index N in use" when it is taken).
            let at = opt(words, "-t").map(|t| t.trim_start_matches(|c| c == ':' || c == '=').to_string()).filter(|t| !t.is_empty());
            let at = match at.as_deref().map(|t| t.parse::<usize>()) {
                Some(Ok(n)) => { if app.tab_by_num(n).is_some() && !flag(words, "-a") { return app.say(format!("index {n} in use"), theme::WARN) } Some(n) }
                Some(Err(_)) => None,
                None => None,
            };
            app.new_tab();
            if let Some(n) = at { let _ = app.move_tab_to(n); }
            // -a: at the index after this window's, the ones after it moving up one.
            if flag(words, "-a") { app.place_after(&was_id) }
            if let Some(name) = opt(words, "-n") { app.rename_tab(&name) }
            // -d: made, not gone to.
            if flag(words, "-d") {
                // Made, not visited: its shell starts there, and you stay where you were.
                app.return_to = Some((was_id, last_before));
            }
            if flag(words, "-P") { app.print_new = Some(opt(words, "-F").unwrap_or_else(|| "#{session_name}:#{window_index}.#{pane_index}".into())) }
            input::new_shell_from(app, from, Placement::Auto(None), cwd, command);
        }
        "split-window" => {
            // tmux's split-window [-bdfhIvPZ] [-c dir] [-l size] [-t target] [-F fmt] [command]: a
            // shell beside (-h) or below the target pane, in its machine and folder; -b before it,
            // -f across the whole window, -l its size (cells, or n%), -d not gone to, -P printed.
            let dir = if flag(words, "-h") { Dir::Horizontal } else { Dir::Vertical };
            let (w, p) = match opt(words, "-t") {
                Some(t) => match pane_target(app, &t) { Some(x) => x, None => return app.say(format!("can't find pane: {t}"), theme::WARN) },
                None => (app.active, app.focused().unwrap_or(0)),
            };
            let size = match opt(words, "-l").or_else(|| opt(words, "-p").map(|p| format!("{p}%"))) {
                Some(l) => match l.strip_suffix('%') {
                    Some(n) => match n.parse::<u16>() { Ok(n) if n <= 100 => Some((n, true)), _ => return app.say(format!("percentage {l}"), theme::WARN) },
                    None => match l.parse::<u16>() { Ok(n) => Some((n, false)), Err(_) => return app.say(format!("size {l}"), theme::WARN) },
                },
                None => None,
            };
            if flag(words, "-P") { app.print_new = Some(opt(words, "-F").unwrap_or_else(|| "#{session_name}:#{window_index}.#{pane_index}".into())) }
            let cwd = opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty());
            let command = shell_command(words);
            let from = app.panes.get(&p).map(|x| (x.machine_id.clone(), x.agent_id.clone()));
            let pane = app.tabs[w].panes().contains(&p).then_some(p);
            let at = crate::app::At { tab: app.tabs[w].id.clone(), pane, dir, before: flag(words, "-b"), full: flag(words, "-f"), size, detached: flag(words, "-d") };
            input::new_shell_from(app, from, Placement::At(at), cwd, command);
        }
        "kill-pane" => {
            // -t: that pane; -a: every pane but it (tmux's order of reading).
            let target = match opt(words, "-t") { Some(t) => match pane_target(app, &t) { Some(x) => Some(x), None => { app.say(format!("can't find pane: {t}"), theme::WARN); return } }, None => app.focused().map(|f| (app.active, f)) };
            match target {
                Some((w, p)) if flag(words, "-a") => { let others: Vec<u64> = app.tabs[w].panes().into_iter().filter(|x| *x != p).collect(); for o in others { app.close_pane(o) } }
                Some((_, p)) => app.close_pane(p),
                None => { if app.tabs.len() > 1 { let i = app.active; app.close_tab(i) } }
            }
        }
        "kill-window" => {
            let target = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => { app.say(format!("can't find window: {t}"), theme::WARN); return } }, None => app.active };
            if flag(words, "-a") {
                let keep = app.tabs[target].id.clone();
                while let Some(i) = app.tabs.iter().position(|t| t.id != keep) { app.close_tab(i) }
            } else { app.close_tab(target) }
        }
        "next-window" => if flag(words, "-a") { input::run(app, "next-waiting") } else { let n = app.tabs.len(); let i = (app.active + 1) % n; app.select_tab(i) },
        "previous-window" => if flag(words, "-a") { input::run(app, "prev-waiting") } else { let n = app.tabs.len(); let i = (app.active + n - 1) % n; app.select_tab(i) },
        "last-window" => input::run(app, "last-tab"),
        "select-window" => {
            let target = opt(words, "-t").or_else(|| Some(rest(words))).unwrap_or_default();
            if flag(words, "-l") { input::run(app, "last-tab"); return }
            match window_target(app, &target) { Some(i) => app.select_tab(i), None => app.say(format!("can't find window: {}", target.trim_start_matches(':')), theme::WARN) }
        }
        "rename-window" => {
            // rename-window [-t target-window] new-name
            let target = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.say(format!("can't find window: {t}"), theme::WARN) }, None => app.active };
            let name = positional(words).join(" ");
            app.rename_tab_at(target, &name);
        }
        "move-window" => {
            // -r renumbers every window; -s moves that window (you stay put); else this one.
            if flag(words, "-r") { app.renumber_all(); return }
            if flag(words, "-L") { app.move_tab(-1) } else if flag(words, "-R") { app.move_tab(1) }
            else if let Some(n) = opt(words, "-t").or_else(|| Some(rest(words))).and_then(|t| t.trim_start_matches(':').parse::<usize>().ok()) {
                let cur = app.tab().id.clone();
                if let Some(src) = opt(words, "-s").and_then(|t| window_target(app, &t)) { app.active = src }
                let moved = app.move_tab_to(n);
                if let Some(i) = app.tabs.iter().position(|t| t.id == cur) { app.active = i }
                if let Err(e) = moved { app.say(e, theme::WARN) }
            }
        }
        "select-pane" => {
            // -m marks this pane (again: unmarks), -M clears the mark; join-pane and swap-pane
            // take the marked pane as their source, as tmux's do.
            if flag(words, "-M") { app.marked = None; return }
            // -t: the pane the flags are about (else this one).
            let about = match opt(words, "-t") { Some(t) => pane_target(app, &t).map(|(_, p)| p), None => app.focused() };
            if flag(words, "-m") { app.marked = if app.marked == about { None } else { about }; return }
            if let Some(title) = opt(words, "-T") {
                if let Some(p) = about.and_then(|f| app.panes.get_mut(&f)) { p.title = title }
                app.sync_titles();
                if opt(words, "-t").is_none() { return }
            }
            let toward = if flag(words, "-L") { Some(Toward::Left) } else if flag(words, "-R") { Some(Toward::Right) } else if flag(words, "-U") { Some(Toward::Up) } else if flag(words, "-D") { Some(Toward::Down) } else { None };
            match toward {
                Some(t) => app.focus_toward(t),
                None if flag(words, "-l") => app.last_pane(),
                None => {
                    let target = opt(words, "-t").unwrap_or_default();
                    if target.is_empty() { return }
                    if target.ends_with(".+") || target == "+" { app.cycle_pane(1) }
                    else if target.ends_with(".-") || target == "-" { app.cycle_pane(-1) }
                    else {
                        match pane_target(app, &target) {
                            Some((w, p)) => app.focus_pane(w, p),
                            None => app.say(format!("can't find pane: {target}"), theme::WARN),
                        }
                    }
                }
            }
        }
        "last-pane" => app.last_pane(),
        "resize-pane" => {
            // resize-pane [-DLMRTUZ] [-t target-pane] [-x width] [-y height] [adjustment]
            let (w, p) = match opt(words, "-t") {
                Some(t) => match pane_target(app, &t) { Some(x) => x, None => return app.say(format!("can't find pane: {t}"), theme::WARN) },
                None => match app.focused() { Some(f) => (app.active, f), None => return },
            };
            if flag(words, "-Z") {
                if w != app.active || app.focused() != Some(p) { app.focus_pane(w, p) }
                input::run(app, "zoom");
                return;
            }
            // -x / -y: that many cells (or n% of the window).
            let body = app.body();
            if let Some(cols) = opt(words, "-x").and_then(|v| size_arg(&v, body.width)) { return app.size_pane(w, p, Dir::Horizontal, cols) }
            if let Some(rows) = opt(words, "-y").and_then(|v| size_arg(&v, body.height)) { return app.size_pane(w, p, Dir::Vertical, rows) }
            let n: i32 = positional(words).first().and_then(|v| v.parse().ok()).unwrap_or(1);
            let (dir, sign) = if flag(words, "-L") { (Dir::Horizontal, -1) } else if flag(words, "-R") { (Dir::Horizontal, 1) } else if flag(words, "-U") { (Dir::Vertical, -1) } else if flag(words, "-D") { (Dir::Vertical, 1) } else { return };
            app.resize_pane(w, p, dir, sign * n);
        }
        "swap-pane" => {
            // -s/-t name the two (in this window); else -U/-D, the previous / next.
            let src = opt(words, "-s").and_then(|t| pane_target(app, &t)).map(|(_, p)| p).or(app.focused());
            // No target: the marked pane and this one trade places (tmux's swap-pane with a mark).
            let dst = opt(words, "-t").and_then(|t| pane_target(app, &t)).map(|(_, p)| p)
                .or_else(|| if !flag(words, "-U") && !flag(words, "-D") && opt(words, "-s").is_none() { app.marked.filter(|m| Some(*m) != app.focused()) } else { None });
            match (src, dst) {
                (Some(a), Some(b)) if a != b && app.tab().panes().contains(&a) && app.tab().panes().contains(&b) => {
                    if let Some(root) = app.tab_mut().root.as_mut() { root.swap(a, b) }
                    app.sync_titles();
                    app.fit_panes();
                }
                (_, Some(_)) => app.say("swap-pane: both panes in this window", theme::WARN),
                _ => app.swap_pane(if flag(words, "-U") { -1 } else { 1 }),
            }
        }
        "break-pane" => {
            // -s names the pane (any window); it becomes a window of its own.
            let back = app.tab().id.clone();
            if let Some((w, p)) = opt(words, "-s").and_then(|t| pane_target(app, &t)) { if w != app.active || app.focused() != Some(p) { app.focus_pane(w, p) } }
            if app.tab().panes().len() < 2 { app.say("can't break with only one pane", theme::WARN); return }
            input::run(app, "pane-tab");
            // -d: the new window is made, not gone to.
            if flag(words, "-d") { if let Some(i) = app.tabs.iter().position(|t| t.id == back) { let new = app.tab().id.clone(); app.select_tab(i); app.last_tab = Some(new) } }
        }
        "rotate-window" => app.rotate(if flag(words, "-D") { -1 } else { 1 }),
        "next-layout" => app.next_layout(),
        "select-layout" => {
            // -t: that window (else this one).
            let target = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.say(format!("can't find window: {t}"), theme::WARN) }, None => app.active };
            if target != app.active {
                let name = positional(words).join(" ");
                let preset = match name.as_str() { "even-horizontal" => Preset::Columns, "even-vertical" => Preset::Rows, "main-horizontal" => Preset::MainRow, "main-vertical" => Preset::MainStack, "tiled" => Preset::Grid, other => return app.say(format!("unknown layout: {other}"), theme::WARN) };
                return app.apply_preset_at(target, preset);
            }
            if flag(words, "-E") { input::run(app, "equalize"); return }
            let preset = match positional(words).join(" ").trim() {
                "even-horizontal" => Preset::Columns, "even-vertical" => Preset::Rows,
                "main-horizontal" => Preset::MainRow, "main-vertical" => Preset::MainStack,
                // The main pane on the other side (tmux 3.5's M-6 / M-7).
                "main-horizontal-mirrored" => { app.apply_preset(Preset::MainRow); app.mirror_layout(); return }
                "main-vertical-mirrored" => { app.apply_preset(Preset::MainStack); app.mirror_layout(); return }
                "tiled" => Preset::Grid,
                "" => { input::run(app, "layout"); return }
                // A tmux layout string (#{window_layout}, tmux-resurrect's): the panes take its cells.
                other if other.contains('x') && other.contains(',') => {
                    let ids = app.tab().panes();
                    match crate::layout::Node::from_tmux(other, &ids) {
                        Some(root) => { let tab = app.tab_mut(); tab.root = Some(root); tab.zoomed = false; app.fit_panes() }
                        None => app.say(format!("invalid layout: {other}"), theme::WARN),
                    }
                    return;
                }
                other => { app.say(format!("unknown layout: {other}"), theme::WARN); return }
            };
            app.apply_preset(preset);
        }
        "display-panes" => app.modal = Some(Modal::DisplayPanes { until: std::time::Instant::now() + std::time::Duration::from_millis(app.display_panes_ms) }),
        "copy-mode" => {
            // -t: that pane (it is brought forward: copy mode is where the keys go).
            if let Some(t) = opt(words, "-t") {
                match pane_target(app, &t) { Some((w, p)) => { if app.active != w || app.focused() != Some(p) { app.focus_pane(w, p) } } None => return app.say(format!("can't find pane: {t}"), theme::WARN) }
            }
            // -q: out of copy mode.
            if flag(words, "-q") { if let Some(Modal::Copy { pane }) = app.modal { if let Some(p) = app.panes.get_mut(&pane) { p.copy_end() } app.modal = None } return }
            input::run(app, "copy-mode");
            if flag(words, "-u") { if let Some(f) = app.focused() { if let Some(p) = app.panes.get_mut(&f) { let half = p.rows as i32 - 2; p.copy_move(0, -half) } } }
        }
        "search-backward" | "search-forward" => { if let Some(pane) = app.focused() { app.modal = Some(Modal::Find { pane, query: String::new(), found: None, up: command == "search-backward" }) } }
        "paste-buffer" => {
            // -b a named buffer, -t the pane.
            let text = match opt(words, "-b") { Some(b) => app.named_buffers.get(&b).cloned(), None => app.buffers.first().cloned() };
            let Some(text) = text else { app.say("no buffers", theme::WARN); return };
            match opt(words, "-t").map(|t| pane_target(app, &t)) {
                Some(Some((_, p))) => { if let Some(pane) = app.panes.get(&p) { if pane.stream.is_some() { app.send_paste(p, &text) } } }
                Some(None) => app.say(format!("can't find pane: {}", opt(words, "-t").unwrap_or_default()), theme::WARN),
                None => { if let Some(f) = app.focused() { app.send_paste(f, &text) } }
            }
        }
        "list-buffers" | "choose-buffer" if app.capture.is_some() => {
            let lines = app.buffers.iter().enumerate().map(|(i, b)| format!("buffer{i}: {} bytes: \"{}\"", b.len(), b.lines().next().unwrap_or("").chars().take(50).collect::<String>())).collect();
            app.print("list-buffers", lines)
        }
        "list-buffers" | "choose-buffer" => input::run(app, "choose-buffer"),
        "delete-buffer" => { match opt(words, "-b") { Some(b) => { app.named_buffers.remove(&b); } None => { if !app.buffers.is_empty() { app.buffers.remove(0); } } } }
        "choose-tree" => {
            if flag(words, "-s") { input::launch(app, "", Filter::All) }
            else if flag(words, "-m") { input::launch(app, "@", Filter::All) }
            else if flag(words, "-a") { input::run(app, "inbox") }
            else if flag(words, "-i") { input::launch(app, ":", Filter::All) }
            else if flag(words, "-S") { input::launch(app, "*", Filter::All) }
            else { input::run(app, "tree") }
        }
        "choose-client" => input::run(app, "tree"),
        "find-window" => { input::launch(app, "", Filter::All); let q = rest(words); if !q.is_empty() { if let Some(Modal::Picker { picker, .. }) = &mut app.modal { for c in q.chars() { picker.type_char(c) } } } }
        "display-message" => {
            // display [-p] [-t target] [-d ms] [format]: the format against the target pane.
            let mut text = Vec::new();
            let mut i = 1;
            while i < words.len() {
                match words[i].as_str() { "-d" | "-c" | "-t" | "-F" => i += 1, w if w.starts_with('-') && w.len() > 1 && text.is_empty() => {}, w => text.push(w.to_string()) }
                i += 1;
            }
            let text = opt(words, "-F").unwrap_or_else(|| text.join(" "));
            if text.is_empty() && app.capture.is_none() { input::run(app, "info"); return }
            let text = if text.is_empty() { "[#S] #I:#W, current pane #P - (%H:%M %d-%b-%y)".to_string() } else { text };
            let target = match opt(words, "-t") { Some(t) => match pane_target(app, &t) { Some(x) => Some(x), None => { app.say(format!("can't find pane: {t}"), theme::WARN); return } }, None => None };
            let out = match target {
                Some((w, p)) => crate::format::expand(app, &text, w, Some(p), true),
                None => expand(app, &text),
            };
            // -p prints (to the shell that asked); without it the message is the client's, as tmux's.
            if flag(words, "-p") { app.print("display", vec![out]) } else {
                let cap = app.capture_err.take();
                app.say(out, theme::WARN);
                app.capture_err = cap;
            }
        }
        "show-messages" if app.capture.is_some() => { let lines = app.messages.iter().map(|(_, t)| t.clone()).collect(); app.print("show-messages", lines) }
        "show-messages" => input::run(app, "messages"),
        "list-keys" => {
            // tmux's list-keys (cmd-list-keys.c): -T one table, a key for that key alone, -N the notes
            // (-a with the commands of keys without one, -P what goes before them), -1 the first.
            let (mut one, mut notes, mut all, mut table, mut pfx, mut key) = (false, false, false, None::<String>, None::<String>, None::<String>);
            let mut i = 1;
            while i < words.len() {
                let w = &words[i];
                if key.is_none() && w.starts_with('-') && w.len() > 1 {
                    let chars: Vec<char> = w[1..].chars().collect();
                    for (k, c) in chars.iter().enumerate() {
                        match c {
                            '1' => one = true, 'N' => notes = true, 'a' => all = true,
                            'T' | 'P' => {
                                let tail: String = chars[k + 1..].iter().collect();
                                let v = if tail.is_empty() { i += 1; words.get(i).cloned() } else { Some(tail) };
                                if *c == 'T' { table = v } else { pfx = v }
                                break;
                            }
                            _ => {}
                        }
                    }
                } else if key.is_none() { key = Some(w.clone()) }
                i += 1;
            }
            // In the client, asked for nothing in particular: the list to look through (C-b ?).
            if app.capture.is_none() && !one && key.is_none() && table.is_none() { return input::run(app, "keys") }
            let only = match &key { Some(k) => match crate::keys::parse(k) { Ok(c) => Some(c), Err(_) => return app.say(format!("invalid key: {k}"), theme::WARN) }, None => None };
            let tables = app.keymap.tables();
            if let Some(t) = &table { if !tables.iter().any(|(n, _)| n == t) { return app.say(format!("table {t} doesn't exist"), theme::WARN) } }
            let width = |s: &str| unicode_width::UnicodeWidthStr::width(s);
            let keyname = |b: &crate::keys::Binding| crate::keys::name(&b.chord);
            let mut lines: Vec<String> = Vec::new();
            if notes {
                let shown = |b: &crate::keys::Binding| (all || !b.note.is_empty()) && only.map(|o| o == b.chord).unwrap_or(true);
                let note = |b: &crate::keys::Binding| if b.note.is_empty() { canonical(&b.command) } else { b.note.clone() };
                let get = |name: &str| tables.iter().find(|(n, _)| n == name).map(|(_, l)| l.clone()).unwrap_or_default();
                let kw = |list: &[crate::keys::Binding]| list.iter().filter(|b| shown(b)).map(|b| width(&keyname(b))).max().unwrap_or(0);
                let mut add = |list: &[crate::keys::Binding], start: &str, kw: usize| {
                    for b in list.iter().filter(|b| shown(b)) { lines.push(format!("{start}{}{}{}", keyname(b), " ".repeat(kw + 1 - width(&keyname(b))), note(b))) }
                };
                match &table {
                    None => {
                        let start = pfx.clone().unwrap_or_else(|| format!("{} ", crate::keys::name(&app.keymap.prefix)));
                        let (root, prefix) = (get("root"), get("prefix"));
                        let w = kw(&root).max(kw(&prefix));
                        add(&root, &" ".repeat(width(&start)), w);
                        add(&prefix, &start, w);
                    }
                    Some(t) => { let list = get(t); let w = kw(&list); add(&list, pfx.as_deref().unwrap_or(""), w) }
                }
            } else {
                let rows: Vec<(&String, &crate::keys::Binding)> = tables.iter().filter(|(n, _)| table.as_ref().map(|t| t == n).unwrap_or(true))
                    .flat_map(|(n, l)| l.iter().map(move |b| (n, b))).filter(|(_, b)| only.map(|o| o == b.chord).unwrap_or(true)).collect();
                let repeat = rows.iter().any(|(_, b)| b.repeat);
                let tw = rows.iter().map(|(n, _)| width(n)).max().unwrap_or(0);
                let kw = rows.iter().map(|(_, b)| width(&crate::options::escape(&keyname(b)))).max().unwrap_or(0);
                for (n, b) in rows {
                    let r = if !repeat { "" } else if b.repeat { "-r " } else { "   " };
                    let k = crate::options::escape(&keyname(b));
                    lines.push(format!("bind-key {r}-T {n}{} {k}{} {}", " ".repeat(tw - width(n)), " ".repeat(kw - width(&k)), canonical(&b.command)));
                }
            }
            if only.is_some() && lines.is_empty() { return app.say(format!("unknown key: {}", key.unwrap_or_default()), theme::WARN) }
            if one {
                lines.truncate(1);
                // -1 in a client: the line goes to the status line.
                if app.capture.is_none() { if let Some(l) = lines.pop() { let cap = app.capture_err.take(); app.say(l, theme::WARN); app.capture_err = cap } return }
            }
            app.print("list-keys", lines);
        }
        "show-options" | "show-window-options" => {
            // tmux's show-options: -g global, -s server, -w window, -p pane, -v values only,
            // -A what is inherited too (marked *), -q quiet, -t the window or pane.
            let mut f = crate::options::SetFlags { window: command == "show-window-options", ..Default::default() };
            let (mut values_only, mut inherited, mut quiet, mut target, mut name) = (false, false, false, None, None);
            let mut i = 1;
            while i < words.len() {
                let w = &words[i];
                if name.is_none() && w.starts_with('-') && w.len() > 1 {
                    for c in w[1..].chars() {
                        match c { 'g' => f.global = true, 's' => f.server = true, 'w' => f.window = true, 'p' => f.pane = true, 'v' => values_only = true, 'A' => inherited = true, 'q' => quiet = true, 't' => { i += 1; target = words.get(i).cloned() } _ => {} }
                    }
                } else if name.is_none() { name = Some(w.clone()) } else { return app.say("command show-options: too many arguments (need at most 1)", theme::WARN) }
                i += 1;
            }
            let (tab, pane) = match target.as_deref() {
                Some(t) => match pane_target(app, t) { Some(tp) => tp, None => return app.say(format!("can't find window: {t}"), theme::WARN) },
                None => (app.active, app.focused().unwrap_or(0)),
            };
            let tab_id = app.tabs[tab].id.clone();
            match app.options.show(name.as_deref(), &f, inherited, values_only, &tab_id, pane) {
                Ok(lines) => { if !lines.is_empty() { app.print("show-options", lines) } }
                Err(_) if quiet => {}
                Err(e) => app.say(e, theme::WARN),
            }
        }
        "list-windows" | "list-sessions" | "list-panes" | "list-clients" => {
            // -F: a format, one line per window or pane.
            let lines = match (command, opt(words, "-F")) {
                ("list-windows", Some(f)) => (0..app.tabs.len()).map(|w| crate::format::expand(app, &f, w, None, false)).collect(),
                ("list-panes", f) => {
                    // -a / -s: every window's panes; -t: that window's; -F: a format per pane.
                    let windows: Vec<usize> = if flag(words, "-a") || flag(words, "-s") { (0..app.tabs.len()).collect() } else { vec![opt(words, "-t").and_then(|t| window_target(app, &t)).unwrap_or(app.active)] };
                    let all = windows.len() > 1;
                    let f = f.unwrap_or_else(|| if all { "#{session_name}:#{window_index}.#{pane_index}: [#{pane_width}x#{pane_height}] #{pane_id}#{?pane_active, (active),}".into() } else { "#{pane_index}: [#{pane_width}x#{pane_height}] #{pane_id}#{?pane_active, (active),}".into() });
                    windows.into_iter().flat_map(|w| app.tabs[w].panes().into_iter().map(move |p| (w, p))).collect::<Vec<_>>().into_iter()
                        .map(|(w, p)| crate::format::expand(app, &f, w, Some(p), false)).collect()
                }
                ("list-clients", Some(f)) => vec![expand(app, &f)],
                ("list-sessions", Some(f)) => vec![expand(app, &f)],
                _ => listing(app, command),
            };
            app.print(command, lines);
        }
        "set-option" | "set-window-option" => {
            // tmux's set-option: checked, kept where the flags say (the session, the window, the
            // pane, or globally), then the options hn acts on read the value now in force.
            let (f, quiet, format, target, args) = crate::tmuxconf::set_flags(&words[1..], command == "set-window-option");
            let Some(name) = args.first().cloned() else { return app.say("command set-option: too few arguments (need at least 1)", theme::WARN) };
            let value = args.get(1).map(|v| if format { expand(app, v) } else { v.clone() });
            // -t: the window (or pane) the option is for; else the one here.
            let (tab, pane) = match target.as_deref() {
                Some(t) => match pane_target(app, t) { Some(tp) => tp, None => return app.say(format!("can't find window: {t}"), theme::WARN) },
                None => (app.active, app.focused().unwrap_or(0)),
            };
            let tab_id = app.tabs[tab].id.clone();
            let now = match app.options.set(&name, value.as_deref(), &f, &tab_id, pane) {
                Ok(now) => now,
                Err(e) if quiet && e.starts_with("invalid option") => return,
                Err(e) => return app.say(e, theme::WARN),
            };
            // tim: `set -g @tim off` hides the creature (kept), `on` brings it back.
            if name == "@tim" { app.tim.set_off(matches!(now.as_deref(), Some("off" | "0" | "no"))); return }
            if name.starts_with('@') && now.is_none() { app.opts.user.remove(&name); return }
            // synchronize-panes belongs to a window: this one, or (-g) every window without its own.
            if name == "synchronize-panes" {
                let on = now.as_deref() == Some("on");
                if f.global { for i in 0..app.tabs.len() { let id = app.tabs[i].id.clone(); if !app.options.windows.get(&id).map(|m| m.contains_key(&name)).unwrap_or(false) { app.tabs[i].sync = on } } }
                else { app.tabs[tab].sync = on }
                return;
            }
            let mut settings = crate::tmuxconf::Settings::default();
            let words = vec!["set".to_string(), "-g".to_string(), name, now.unwrap_or_default()];
            match crate::tmuxconf::directive(&words, &mut app.keymap, &mut settings) {
                Ok(()) => app.apply_settings(&settings),
                Err(e) => app.say(e, theme::WARN),
            }
        }
        "bind-key" | "unbind-key" => {
            let mut settings = crate::tmuxconf::Settings::default();
            let mut words = words.to_vec();
            words[0] = command.to_string();
            match crate::tmuxconf::directive(&words, &mut app.keymap, &mut settings) {
                Ok(()) => { app.apply_settings(&settings); if let Some(n) = settings.notes.first() { app.say(n.clone(), theme::WARN) } }
                Err(e) => app.say(e, theme::WARN),
            }
        }
        "source-file" => {
            let path = rest(words);
            let path = if let Some(r) = path.strip_prefix("~/") { format!("{}/{r}", std::env::var("HOME").unwrap_or_default()) } else { path };
            match std::fs::read_to_string(&path) {
                Ok(text) => {
                    let mut settings = crate::tmuxconf::Settings::default();
                    crate::tmuxconf::apply(&text, &mut app.keymap, &mut settings);
                    let problems = settings.problems.clone();
                    app.apply_settings(&settings);
                    for p in problems { app.say(p, theme::WARN) }
                }
                Err(_) => app.say(format!("{path}: No such file or directory"), theme::WARN),
            }
        }
        "swap-window" => {
            let src = opt(words, "-s").map(|t| window_target(app, &t)).unwrap_or(Some(app.active));
            // No target: the window holding the marked pane, as tmux's.
            let marked = app.marked.and_then(|m| app.tabs.iter().position(|t| t.panes().contains(&m)));
            let dst = match opt(words, "-t") { Some(t) => window_target(app, &t), None => marked.or(Some(app.active)) };
            match (src, dst) {
                (Some(a), Some(b)) => {
                    // -d leaves the current window where it was; without it, focus follows the move.
                    let keep = flag(words, "-d");
                    if a != app.active { let cur = app.active; app.active = a; app.swap_tabs(a, b); if keep { app.active = cur } } else { app.swap_tabs(a, b) }
                }
                _ => app.say("can't find window", theme::WARN),
            }
        }
        "join-pane" | "move-pane" => {
            // -s names the pane to move (default: this one), -t the pane to split beside (default:
            // the current one of that window); -h side by side, else above/below.
            let dir = if flag(words, "-h") { Dir::Horizontal } else { Dir::Vertical };
            let src = match opt(words, "-s") { Some(t) => pane_target(app, &t), None => pane_target(app, "{marked}").or_else(|| app.focused().map(|f| (app.active, f))) };
            let dst = match opt(words, "-t") { Some(t) => pane_target(app, &t), None => app.tabs[app.active].focus.map(|f| (app.active, f)) };
            let (Some((_, sp)), Some((dw, dp))) = (src, dst) else { app.say("join-pane: can't find pane", theme::WARN); return };
            if sp == dp { return }
            let Some((machine, agent)) = app.panes.get(&sp).map(|x| (x.machine_id.clone(), x.agent_id.clone())) else { return };
            let dst_tab = app.tabs[dw].id.clone();
            let key = (machine.clone(), agent.clone());
            let shell = app.shells.remove(&key);
            app.close_pane(sp);
            if shell { app.shells.insert(key); }
            let Some(di) = app.tabs.iter().position(|t| t.id == dst_tab) else { return };
            if app.tabs[di].panes().contains(&dp) { app.focus_pane(di, dp) } else { app.select_tab(di) }
            app.open_agent(&machine, &agent, Placement::Split(dir));
        }
        "clear-history" => { if let Some(p) = app.focused().and_then(|f| app.panes.get_mut(&f)) { p.clear_history() } }
        "capture-pane" => {
            // -p prints it; else it becomes a paste buffer. -t names the pane.
            let pane = match opt(words, "-t") { Some(t) => match pane_target(app, &t) { Some((_, p)) => Some(p), None => { app.say(format!("can't find pane: {t}"), theme::WARN); return } }, None => app.focused() };
            let range = (opt(words, "-S").and_then(|v| v.parse::<i32>().ok().or(if v == "-" { Some(i32::MIN) } else { None })), opt(words, "-E").and_then(|v| v.parse::<i32>().ok().or(if v == "-" { Some(i32::MAX) } else { None })));
            let Some(text) = pane.and_then(|p| app.panes.get(&p)).map(|p| p.text_range(range.0, range.1)) else { return };
            if flag(words, "-p") { app.print("capture-pane", text.lines().map(str::to_string).collect()) } else { app.buffers.insert(0, text) }
        }
        "has-session" => { if let Some(t) = opt(words, "-t") { if unsession(app, &format!("{}:", t.trim_end_matches(':'))).is_none() { app.say(format!("can't find session: {t}"), theme::WARN) } } }
        "list-commands" => { let lines = COMMANDS.iter().map(|(n, a, d)| format!("{n} ({a}) — {d}")).collect(); app.print("list-commands", lines) }
        "set-environment" | "setenv" => { if let (Some(k), Some(v)) = (words.iter().skip(1).find(|w| !w.starts_with('-')), words.last()) { app.env.insert(k.clone(), v.clone()); } }
        "show-environment" | "showenv" => { let lines = app.env.iter().map(|(k, v)| format!("{k}={v}")).collect(); app.print("show-environment", lines) }
        "set-hook" | "show-hooks" => {}
        "wait-for" | "wait" => {}
        "pipe-pane" => app.say("pipe-pane: a harness pane's output lives on its machine (use capture-pane -p)", theme::WARN),
        "save-buffer" | "saveb" => {
            let path = rest(words);
            let text = app.buffers.first().cloned().unwrap_or_default();
            if path.is_empty() || path == "-" { app.print("save-buffer", text.lines().map(str::to_string).collect()) }
            else if let Err(e) = std::fs::write(crate::tmuxconf::expand_home(&path), text) { app.say(format!("{path}: {e}"), theme::WARN) }
        }
        "load-buffer" | "loadb" => {
            let path = rest(words);
            match std::fs::read_to_string(crate::tmuxconf::expand_home(&path)) { Ok(t) => app.buffers.insert(0, t), Err(e) => app.say(format!("{path}: {e}"), theme::WARN) }
        }
        "previous-layout" => { let at = (app.tab().layout_at + 3) % 5; app.tab_mut().layout_at = at; app.next_layout() }
        "resize-window" => app.say("resize-window: a window is the terminal's size here", theme::WARN),
        "respawn-window" => input::run(app, "restart"),
        "set-buffer" => {
            // set-buffer [-a] [-b name] text
            let mut text = Vec::new();
            let mut i = 1;
            while i < words.len() { match words[i].as_str() { "-b" | "-n" | "-t" => i += 1, "-a" | "-w" => {}, w => text.push(w.to_string()) } i += 1 }
            let text = text.join(" ");
            match opt(words, "-b") {
                Some(b) => { let e = app.named_buffers.entry(b).or_default(); if flag(words, "-a") { e.push_str(&text) } else { *e = text } }
                None => { if flag(words, "-a") && !app.buffers.is_empty() { app.buffers[0].push_str(&text) } else if !text.is_empty() { app.buffers.insert(0, text) } }
            }
        }
        "show-buffer" => {
            let text = match opt(words, "-b") { Some(b) => app.named_buffers.get(&b).cloned(), None => app.buffers.first().cloned() };
            let lines = text.map(|b| b.lines().map(str::to_string).collect()).unwrap_or_default();
            app.print("show-buffer", lines);
        }
        "respawn-pane" => input::run(app, "restart"),
        "suspend-client" => app.suspend = true,
        "rename-session" => { let name = rest(words); if name.trim().is_empty() { app.say("rename-session: a name", theme::WARN) } else { app.session_alias = Some(name.trim().to_string()) } }
        "clock-mode" => { if let Some(f) = app.focused() { app.modal = Some(Modal::Clock { pane: f }) } else { app.modal = Some(Modal::Clock { pane: 0 }) } }
        "refresh-client" => { app.redraw_all = true; for id in app.panes.keys().copied().collect::<Vec<_>>() { if app.rects.iter().any(|(r, _)| *r == id) { app.open_stream(id, false) } } }
        "detach-client" | "kill-server" | "kill-session" => app.quit = true,
        "switch-client" => {
            // -T: the key table the next key is looked up in (tmux's modal keys).
            if let Some(t) = opt(words, "-T") {
                match t.as_str() {
                    "root" => { app.key_table = None; app.prefix = false }
                    "prefix" => { app.key_table = None; app.prefix = true; app.prefix_at = Some(std::time::Instant::now()) }
                    _ if app.keymap.named.contains_key(&t) => { app.key_table = Some(t); app.prefix = false }
                    _ => app.say(format!("table {t} doesn't exist"), theme::WARN),
                }
                return;
            }
            if flag(words, "-l") { input::run(app, "last-harness") }
            else if flag(words, "-n") { input::run(app, "next-tab-harness") }
            else if flag(words, "-p") { input::run(app, "prev-tab-harness") }
        }
        "send-keys" => input::send_keys(app, &words[1..]),
        // vim-tmux-navigator and friends: `if-shell COND THEN [ELSE]`. The condition asks about the
        // pane's tty, which lives on another machine here; a harness pane is not vim, so the else
        // branch runs (a -F format of 1/0 is honoured).
        "if-shell" | "if" => {
            let mut i = 1;
            let mut format = false;
            let mut target = None;
            while i < words.len() && words[i].starts_with('-') && words[i].len() > 1 {
                if words[i].contains('F') { format = true }
                if words[i] == "-t" { i += 1; target = words.get(i).cloned() }
                i += 1;
            }
            let Some(cond) = words.get(i) else { return };
            let (w, p) = match target.as_deref().and_then(|t| pane_target(app, t)) { Some((w, p)) => (w, Some(p)), None => (app.active, app.focused()) };
            let tty_unknown = p.and_then(|p| app.panes.get(&p)).and_then(|x| x.remote_tty.clone()).is_none();
            // -F: a format. Else a shell command, the format expanded first, as tmux's — unless it
            // asks `ps` about the tty of a pane on another machine (vim-tmux-navigator), which has
            // none here: then what that machine says the pane runs decides.
            let truth = if format { !matches!(crate::format::expand(app, cond, w, p, false).trim(), "" | "0") }
                else if (cond.contains("pane_tty") && tty_unknown) || cond.contains("$is_vim") {
                    // "Is vim in this pane?": what tmux says the pane runs (vim-tmux-navigator's own test,
                    // `g?(view|l?n?vim?x?|fzf)(diff)?`), else a shell pane on the alternate screen.
                    let pane = app.focused().and_then(|f| app.panes.get(&f));
                    match pane.and_then(|p| p.fg_command.clone()) {
                        Some(cmd) => is_vim_command(&cmd),
                        None => pane.filter(|p| app.fleet.agent(&p.machine_id, &p.agent_id).map(|a| a.engine == "terminal").unwrap_or(false))
                            .map(|p| p.mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN)).unwrap_or(false),
                    }
                } else { crate::tmuxconf::shell_true(&crate::format::expand(app, cond, w, p, false)) };
            let pick = if truth { words.get(i + 1) } else { words.get(i + 2) };
            if let Some(command) = pick.cloned() { execute(app, &command) }
        }
        // run-shell: on this computer, as tmux's server would; what it prints is shown.
        "display-popup" | "popup" => {
            // -C closes an open one; -w/-h size (50% by default); -d the folder; -T a title.
            if flag(words, "-C") { app.close_popup(); return }
            let w = opt(words, "-w").unwrap_or_else(|| "50%".into());
            let h = opt(words, "-h").unwrap_or_else(|| "50%".into());
            let cwd = opt(words, "-d").map(|d| expand(app, &d)).filter(|d| !d.is_empty());
            let title = opt(words, "-T").map(|t| expand(app, &t)).unwrap_or_default();
            let mut i = 1;
            let mut command = None;
            while i < words.len() {
                match words[i].as_str() { "-w" | "-h" | "-d" | "-T" | "-x" | "-y" | "-t" | "-c" | "-b" | "-s" | "-S" | "-e" => i += 1, w if w.starts_with('-') && w.len() > 1 => {}, w => command = Some(w.to_string()) }
                i += 1;
            }
            input::popup(app, &w, &h, cwd, command, title, flag(words, "-E"));
        }
        "tim" => { let l = crate::tim::line(app); app.say(l, theme::WARN) }
        "run-shell" | "run" => {
            // -C: a tmux command, not a shell one.
            if flag(words, "-C") { let c = rest(words); return execute(app, &c) }
            let cmd = rest(words);
            if cmd.is_empty() { return }
            let cmd = expand(app, &cmd);
            let mut c = std::process::Command::new("sh");
            c.arg("-c").arg(&cmd);
            if let Some(p) = crate::ipc::here() { c.env("HN_SOCKET", p); }
            let out = c.output();
            match out {
                Ok(o) => {
                    let text = String::from_utf8_lossy(&o.stdout).to_string() + &String::from_utf8_lossy(&o.stderr);
                    let lines: Vec<String> = text.lines().map(str::to_string).collect();
                    if !lines.is_empty() { app.print("run-shell", lines) }
                }
                Err(e) => app.say(format!("run-shell: {e}"), theme::WARN),
            }
        }
        "send-prefix" => { let prefix = crate::keys::name(&app.keymap.prefix); input::send_keys(app, &[prefix]) }
        "command-prompt" => {
            // command-prompt [-1bFikN] [-I initial] [-p prompt] [-T type] [template]:
            // -k takes one key (its name fills %%), -F expands the template as a format first.
            let (mut label, mut initial, mut template, mut key, mut format) = (":".to_string(), String::new(), Vec::new(), false, false);
            let mut i = 1;
            while i < words.len() {
                match words[i].as_str() {
                    "-p" => { label = words.get(i + 1).cloned().unwrap_or_default(); i += 1 }
                    "-I" => { initial = expand(app, words.get(i + 1).map(String::as_str).unwrap_or("")); i += 1 }
                    "-T" | "-t" => i += 1,
                    w if w.starts_with('-') && w.len() > 1 && template.is_empty() => { if w.contains('k') { key = true } if w.contains('F') { format = true } }
                    w => template.push(w.to_string()),
                }
                i += 1;
            }
            let template = template.iter().map(|w| if w.contains(' ') { w.clone() } else { w.clone() }).collect::<Vec<_>>().join(" ");
            let template = if format { expand(app, &template) } else { template };
            // No -p: tmux names the prompt after the template's command, `(find-window)`.
            let label = if label == ":" && !template.is_empty() && !key { format!("({})", template.split_whitespace().next().unwrap_or("")) } else { label };
            let label = if label == ":" { ":".to_string() } else { format!("{label} ") };
            let kind = if key { PromptKind::Key { template } } else { PromptKind::Command { template: (!template.is_empty()).then_some(template) } };
            app.modal = Some(Modal::Prompt(Prompt::status(kind, &label, &initial)));
        }
        "display-menu" | "menu" => {
            // display-menu [-O] [-T title] [-x x] [-y y] name key command … ('' a separator; a
            // name that expands empty leaves the item out; a name starting `-` shows it disabled).
            let mut title = String::new();
            let mut i = 1;
            while i < words.len() {
                match words[i].as_str() {
                    "-T" => { title = expand(app, words.get(i + 1).map(String::as_str).unwrap_or("")); i += 2 }
                    "-x" | "-y" | "-t" | "-c" | "-b" | "-s" | "-S" | "-H" | "-C" => i += 2,
                    "-O" | "-M" => i += 1,
                    _ => break,
                }
            }
            let mut items: Vec<crate::modal::MenuItem> = Vec::new();
            while i < words.len() {
                let name = words[i].clone();
                if name.is_empty() {
                    if items.last().map(|it| !it.separator).unwrap_or(false) { items.push(crate::modal::MenuItem { label: String::new(), key: String::new(), command: String::new(), disabled: true, separator: true }) }
                    i += 1;
                    continue;
                }
                let (key, command) = (words.get(i + 1).cloned().unwrap_or_default(), words.get(i + 2).cloned().unwrap_or_default());
                i += 3;
                let label: String = crate::format::text(app, &name, None);
                if label.is_empty() { continue }
                let (disabled, label) = match label.strip_prefix('-') { Some(l) => (true, l.to_string()), None => (false, label) };
                items.push(crate::modal::MenuItem { label, key, command, disabled, separator: false });
            }
            while items.last().map(|it| it.separator).unwrap_or(false) { items.pop(); }
            let title = strip_styles(&title);
            let cursor = items.iter().position(|it| !it.disabled && !it.separator).unwrap_or(0);
            if items.is_empty() { return }
            app.modal = Some(Modal::Menu { title, items, cursor });
        }
        "customize-mode" => {
            // tmux's options-and-keys tree, read here as one list: the options as they are, then every key.
            let mut lines = listing(app, "show-options");
            lines.push(String::new());
            for b in &app.keymap.prefix_table { lines.push(format!("{} {:<9} {}", crate::keys::name(&app.keymap.prefix), crate::keys::name(&b.chord), b.command)) }
            app.print("customize-mode", lines);
        }
        "confirm-before" => {
            let prompt = opt(words, "-p").map(|p| expand(app, &p));
            let command = rest(words);
            if command.is_empty() { return }
            let prompt = prompt.unwrap_or_else(|| format!("{}? (y/n)", command.split_whitespace().next().unwrap_or("")));
            app.modal = Some(Modal::Confirm { prompt, command });
        }
        "new-harness" => { let args = rest(words); if args.is_empty() { input::run(app, "new") } else { input::new_harness_from(app, &args) } }
        "new-terminal" => input::run(app, "terminal"),
        "clone-harness" => input::run(app, "clone"),
        "restart-harness" => input::run(app, "restart"),
        "pause-harness" => input::run(app, "pause"),
        "resume-harness" => input::run(app, "resume-focused"),
        "rename-harness" => { let name = rest(words); if name.is_empty() { input::run(app, "rename") } else { input::rename_focused(app, &name) } }
        "send-task" => { let text = rest(words); if text.is_empty() { input::run(app, "send") } else { input::route_task(app, text) } }
        "broadcast" => { let text = rest(words); if text.is_empty() { input::run(app, "broadcast") } else { input::broadcast(app, &text) } }
        "send-message" => { let text = rest(words); input::message_focused(app, &text) }
        // Harness-era command ids still work, for old configs and the palette.
        other if input::is_command(other) => input::run(app, other),
        other => app.say(format!("unknown command: {other}"), theme::WARN),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_tmux() {
        assert_eq!(split("split-window -h"), vec![vec!["split-window", "-h"]]);
        assert_eq!(split("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane"), vec![vec!["confirm-before", "-p", "kill-pane #P? (y/n)", "kill-pane"]]);
        assert_eq!(split("copy-mode ; search-backward"), vec![vec!["copy-mode"], vec!["search-backward"]]);
        assert_eq!(split("copy-mode \\; send -X begin-selection"), vec![vec!["copy-mode", ";", "send", "-X", "begin-selection"]]);
        assert_eq!(split("send-keys 'make test' Enter"), vec![vec!["send-keys", "make test", "Enter"]]);
        assert_eq!(split("display 'a;b'"), vec![vec!["display", "a;b"]]);
        // tmux 3's command blocks: one argument each, their commands inside.
        assert_eq!(split("command-prompt -I \"#W\" { rename-window \"%%\" }"), vec![vec!["command-prompt", "-I", "#W", "rename-window \"%%\""]]);
        assert_eq!(split("if -F '#{pane_at_left}' { send-keys M-h } { select-pane -L }"), vec![vec!["if", "-F", "#{pane_at_left}", "send-keys M-h", "select-pane -L"]]);
        assert_eq!(split("bind x {\n  display a\n  display b\n}"), vec![vec!["bind", "x", "display a ; display b"]]);
        assert_eq!(split("display-menu Swap l { swap-window -t :-1 } '' Kill X { kill-window }"), vec![vec!["display-menu", "Swap", "l", "swap-window -t :-1", "", "Kill", "X", "kill-window"]]);
        for yes in ["vim", "nvim", "vi", "view", "gvim", "vimdiff", "nvimdiff", "lvim", "fzf", "/usr/bin/nvim", "vimx"] { assert!(is_vim_command(yes), "{yes}") }
        for no in ["zsh", "bash", "claude", "node", "vite", "vim-server", "less"] { assert!(!is_vim_command(no), "{no}") }
    }

    #[test]
    fn resolves_aliases() {
        assert_eq!(resolve("splitw"), "split-window");
        assert_eq!(resolve("neww"), "new-window");
        assert_eq!(resolve("whatever"), "whatever");
    }
}
