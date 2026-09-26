//! tmux commands. Every key, the `:` prompt and `~/.tmux.conf` speak the same language —
//! `split-window -h`, `select-layout tiled`, `confirm-before -p "kill-pane #P? (y/n)" kill-pane` —
//! and this is where a command line becomes an action on tabs (windows), panes and harnesses.

use crate::app::{App, Placement};
use crate::input;
use crate::layout::{Dir, Toward};
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
fn shell_command(words: &Words) -> Option<String> {
    if let Some(a) = &words.args { return a.values.last().cloned().filter(|c| !c.trim().is_empty()) }
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

/// split-window's and join-pane's -l (cells, or n%) and -p (a percentage).
/// split-window's and join-pane's -l (cells, or n% — expanded as a format first) or -p (a
/// percentage): the size and whether it is a percentage, or tmux's error ("size invalid").
fn split_size(app: &App, words: &Words) -> Result<Option<(u16, bool)>, String> {
    let fit = |n: i64| n.min(u16::MAX as i64) as u16;
    if let Some(l) = opt(words, "-l") {
        // args_percentage_and_expand: no "empty" here — an empty size is an invalid number.
        let l = expand(app, &l);
        return match l.strip_suffix('%') {
            Some(n) => strtonum(n, 0, 100).map(|n| Some((fit(n), true))),
            None => strtonum(&l, 0, i32::MAX as i64).map(|n| Some((fit(n), false))),
        }.map_err(|e| format!("size {e}"));
    }
    match opt(words, "-p") {
        Some(p) => strtonum(&expand(app, &p), 0, 100).map(|n| Some((fit(n), true))).map_err(|e| format!("size {e}")),
        None => Ok(None),
    }
}

/// OpenBSD's strtonum, as tmux calls it: the number, or why not.
pub fn strtonum(s: &str, min: i64, max: i64) -> Result<i64, &'static str> {
    use std::num::IntErrorKind::{NegOverflow, PosOverflow};
    match s.trim_start().parse::<i64>() {
        Ok(n) if n < min => Err("too small"),
        Ok(n) if n > max => Err("too large"),
        Ok(n) => Ok(n),
        Err(e) if *e.kind() == PosOverflow => Err("too large"),
        Err(e) if *e.kind() == NegOverflow => Err("too small"),
        Err(_) => Err("invalid"),
    }
}

/// arguments.c's args_string_percentage: `n` cells, or `n%` of [cur], within min..=max.
pub fn percentage(value: &str, min: i64, max: i64, cur: i64) -> Result<i64, &'static str> {
    if value.is_empty() { return Err("empty") }
    match value.strip_suffix('%') {
        Some(n) => {
            let n = cur * strtonum(n, 0, 100)? / 100;
            if n < min { Err("too small") } else if n > max { Err("too large") } else { Ok(n) }
        }
        None => strtonum(value, min, max),
    }
}

/// A pane target: `:W.P`, `W.P`, `.P`, `P` (index), `%N` (id), `!` (the last pane).
/// A pane target, found as tmux's cmd-find.c finds one (crate::cmd::resolve).
pub fn pane_target(app: &App, target: &str) -> Option<(usize, u64)> {
    let spec = crate::cmd::Spec { kind: crate::cmd::Kind::Pane, can_fail: false, window_index: false, default_marked: false };
    let f = crate::cmd::resolve(app, Some(target), spec).ok()?;
    Some((f.window?, f.pane?))
}

/// A window target, found as tmux finds one.
fn window_target(app: &App, target: &str) -> Option<usize> {
    let spec = crate::cmd::Spec { kind: crate::cmd::Kind::Window, can_fail: false, window_index: false, default_marked: false };
    crate::cmd::resolve(app, Some(target), spec).ok()?.window
}

/// The pane a command's -t names (this one without it), as found before the command ran.
fn target_pane(app: &App, words: &Words) -> Option<(usize, u64)> {
    match opt(words, "-t") { Some(t) => pane_target(app, &t), None => app.current() }
}

/// `session:window.pane` — how tmux names a pane in its errors.
fn pane_name(app: &App, w: usize, p: u64) -> String {
    let index = app.tabs.get(w).and_then(|t| t.panes().iter().position(|x| *x == p)).unwrap_or(0) + app.pane_base_index;
    format!("{}:{}.{index}", app.session_name(), app.win_num(w))
}

/// Whether a harness still runs in a pane (respawn-pane needs -k then, as tmux does for a live pane).
fn pane_alive(app: &App, p: u64) -> bool {
    app.panes.get(&p).and_then(|x| app.fleet.agent(&x.machine_id, &x.agent_id)).map(|a| a.status != "stopped").unwrap_or(false)
}

/// Restart the harness in a pane (respawn-pane, respawn-window).
fn respawn(app: &mut App, p: u64) {
    let Some((machine, agent)) = app.panes.get(&p).map(|x| (x.machine_id.clone(), x.agent_id.clone())) else { return };
    let Some(link) = app.link(&machine) else { return app.say("That machine is not connected", theme::WARN) };
    app.spawn(async move { link.rpc("agent_restart", serde_json::json!({ "agentId": agent }), std::time::Duration::from_secs(120)).await }, move |app, reply| match reply {
        Ok(_) => app.relist(&machine),
        Err(e) => app.error(format!("respawn pane failed: {e}")),
    });
}

/// What tmux's list-* commands print.
fn listing(app: &App, command: &str) -> Vec<String> {
    let window = |i: usize| {
        let tab = &app.tabs[i];
        let flag = if i == app.active { "*" } else if app.last_tab() == Some(&tab.id) { "-" } else { "" };
        format!("{}: {}{flag} ({} panes){}", app.win_num(i), tab.name, tab.panes().len(), if i == app.active { " (active)" } else { "" })
    };
    match command {
        "list-windows" => (0..app.tabs.len()).map(window).collect(),
        "list-panes" => app.tab().panes().iter().enumerate().map(|(i, id)| {
            let p = app.panes.get(id);
            let (c, r) = app.rects.iter().find(|(x, _)| x == id).map(|(_, r)| app.content_of(app.tab(), *r)).map(|r| (r.width, r.height)).or(p.map(|p| (p.cols, p.rows))).unwrap_or((0, 0));
            let title = p.and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| a.name.clone()).unwrap_or_default();
            let machine = p.map(|p| app.fleet.machine_name(&p.machine_id)).unwrap_or_default();
            format!("{}: [{c}x{r}] \"{title}\" {machine} {}{}", i + app.pane_base_index, crate::pane::tag(*id), if Some(*id) == app.focused() { " (active)" } else { "" })
        }).collect(),
        "list-sessions" => {
            vec![format!("{}: {} windows (attached)", app.session_name(), app.tabs.len())]
        }
        "list-clients" => vec![format!("{}: {} [{}x{} {}] (utf8)", std::env::var("SSH_TTY").or_else(|_| std::env::var("TTY")).unwrap_or_else(|_| "tty".into()), app.session_name(), app.size.0, app.size.1, std::env::var("TERM").unwrap_or_default())],
        _ => app.opts.user.iter().map(|(k, v)| format!("{k} \"{v}\"")).chain(vec![
            format!("base-index {}", app.base_index),
            format!("mode-keys {}", if app.mode_keys_emacs() { "emacs" } else { "vi" }),
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

/// A command list's text in its line groups: split where a top-level ` ;; ` stands (quotes and
/// blocks kept whole) — what cmdparse writes between the commands of different lines.
fn split_groups(text: &str) -> Vec<&str> {
    let (mut out, mut start, mut depth, mut quote) = (Vec::new(), 0, 0i32, None::<char>);
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i] as char;
        match (quote, c) {
            (Some('"'), '\\') => i += 1,
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '\\') => i += 1,
            (None, '"' | '\'') => quote = Some(c),
            (None, '{') => depth += 1,
            (None, '}') => depth -= 1,
            (None, ' ') if depth == 0 && text[i..].starts_with(" ;; ") => { out.push(&text[start..i]); i += 4; start = i; continue }
            _ => {}
        }
        i += 1;
    }
    out.push(&text[start..]);
    out
}

/// Inside a block, tmux separates the commands with a plain `;` (`;;` where a new line starts);
/// outside, list-keys writes `\;` (and `\;\;`).
fn canonical_with(command: &str, separator: &str) -> String {
    let groups = split_groups(command);
    if groups.len() > 1 {
        let between = if separator.contains('\\') { " \\;\\; " } else { " ;; " };
        return groups.iter().map(|g| canonical_with(g, separator)).collect::<Vec<_>>().join(between);
    }
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
/// cmd_display_menu_get_position: where a w × h menu goes (its top-left corner), from -x and -y —
/// each a letter, a number or a format — kept on the screen; None when it cannot fit.
fn menu_position(app: &App, args: &crate::cmd::Args, target: Option<(usize, u64)>, w: u16, h: u16) -> Option<(u16, u16)> {
    let (sx, sy) = (app.size.0 as i64, app.size.1 as i64);
    let (w, h) = (w as i64, h as i64);
    if w > sx || h > sy { return None }
    let lines = app.status_lines() as i64;
    let top_status = lines > 0 && app.status_top;
    let top = if top_status { lines } else { 0 };
    let m = app.mouse_ev.as_ref().filter(|m| m.valid);
    let mut vars: Vec<(&str, i64)> = vec![("popup_width", w), ("popup_height", h)];
    if lines > 0 {
        // The target window's range on the status line.
        let wnum = target.map(|(tw, _)| app.win_num(tw) as u64);
        if let Some((row, r)) = app.status_ranges.iter().find(|(_, r)| matches!(r.kind, crate::draw::RangeKind::Window(n) if Some(n) == wnum)) {
            vars.push(("popup_window_status_line_x", r.start as i64));
            vars.push(("popup_window_status_line_y", if top_status { *row as i64 + 1 + h } else { sy - lines + *row as i64 }));
        }
        vars.push(("popup_status_line_y", if top_status { lines + h } else { sy - lines }));
    }
    let n = (sx - 1) / 2 - w / 2;
    vars.push(("popup_centre_x", n.max(0)));
    let n = (sy - 1) / 2 + h / 2;
    vars.push(("popup_centre_y", if n >= sy { sy - h } else { n }));
    if let Some(m) = m {
        let (mx, my) = (m.x as i64, m.y as i64);
        vars.push(("popup_mouse_x", mx));
        vars.push(("popup_mouse_y", my));
        vars.push(("popup_mouse_centre_x", (mx - w / 2).max(0)));
        let n = my - h / 2;
        vars.push(("popup_mouse_centre_y", if n + h >= sy { sy - h } else { n }));
        let n = my + h;
        vars.push(("popup_mouse_top", if n >= sy { sy - 1 } else { n }));
        vars.push(("popup_mouse_bottom", (my - h).max(0)));
    }
    if let Some(g) = target.and_then(|(_, p)| app.visible_geoms().into_iter().find(|(id, _)| *id == p)).map(|(_, g)| g) {
        let (xoff, yoff, psx, psy) = (g.x as i64, g.y as i64, g.w as i64, g.h as i64);
        let n = top + yoff + h;
        vars.push(("popup_pane_top", if n >= sy { sy - h } else { n }));
        vars.push(("popup_pane_bottom", top + yoff + psy));
        vars.push(("popup_pane_left", xoff));
        vars.push(("popup_pane_right", (xoff + psx - w).max(0)));
    }
    let value = |spec: &str| -> i64 {
        let name = spec.strip_prefix("#{").and_then(|s| s.strip_suffix('}')).unwrap_or(spec);
        if let Some((_, v)) = vars.iter().find(|(n, _)| *n == name) { return *v }
        let text = if spec.contains('#') { crate::format::text(app, spec, None) } else { spec.to_string() };
        // strtol: the leading number, else 0.
        let t = text.trim_start();
        let end = t.char_indices().take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '-' || *c == '+'))).last().map(|(i, c)| i + c.len_utf8()).unwrap_or(0);
        t[..end].parse().unwrap_or(0)
    };
    let xp = match args.get('x') { None | Some("C") => "#{popup_centre_x}", Some("R") => "#{popup_pane_right}", Some("P") => "#{popup_pane_left}", Some("M") => "#{popup_mouse_centre_x}", Some("W") => "#{popup_window_status_line_x}", Some(x) => x };
    let mut x = value(xp);
    if x + w >= sx { x = sx - w } else if x < 0 { x = 0 }
    let yp = match args.get('y') { None | Some("C") => "#{popup_centre_y}", Some("P") => "#{popup_pane_bottom}", Some("M") => "#{popup_mouse_top}", Some("S") => "#{popup_status_line_y}", Some("W") => "#{popup_window_status_line_y}", Some(y) => y };
    let mut y = value(yp);
    if y < h { y = 0 } else { y -= h }
    if y + h >= sy { y = sy - h } else if y < 0 { y = 0 }
    Some((x.max(0) as u16, y.max(0) as u16))
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

/// A command's full name: hn's table, then tmux's (an alias, or the start of one name).
fn resolve(name: &str) -> &str {
    COMMANDS.iter().find(|(full, alias, _)| *full == name || *alias == name).map(|(full, _, _)| *full)
        .or_else(|| crate::cmd::find(name).ok().map(|e| e.name))
        .unwrap_or(name)
}

/// Run a command line (one or more commands separated by `;`), in order. A shell command tmux
/// waits for (if-shell, run-shell) runs off the screen's thread, and the commands after it wait for
/// it, as tmux's command queue does; from a shell (`hn <command>`) it is simply waited for.
/// A command string, as tmux's cmd_parse_from_string reads one (the `:` prompt, if-shell's
/// commands, a menu's, a prompt's filled template): its commands run in order.
pub fn execute(app: &mut App, line: &str) {
    let q = queue_of(app, line);
    run_queue(app, q);
}

/// A command string run with a mouse event of its own (a menu's item, with the event of the
/// command that opened the menu).
pub fn execute_in(app: &mut App, line: &str, mouse: Option<crate::mouse::Event>) {
    let saved = std::mem::replace(&mut app.mouse_ev, mouse);
    let q = queue_of(app, line);
    app.mouse_ev = saved;
    run_queue(app, q);
}

/// A key binding's command: read as a string, then (as bind-key's arguments are) split where an
/// argument ends with `;` — `display a \; display b` is two commands.
pub fn execute_bound(app: &mut App, line: &str) {
    let q = bound_queue(app, line);
    run_queue(app, q);
}

fn bound_queue(app: &mut App, line: &str) -> Queue {
    let mouse = app.mouse_ev.clone();
    queue_of(app, line).into_iter()
        .flat_map(|item| crate::cmdparse::from_arguments(&item.words).into_iter().map(|words| Item { words, origin: None, mouse: mouse.clone() }).collect::<Vec<_>>())
        .collect()
}

/// A mouse key's binding: its commands run with the event (the pane under the mouse their
/// target, `-t =` it, send-keys -M passing the event on).
pub fn execute_mouse(app: &mut App, line: &str, m: crate::mouse::Event) {
    let saved = app.mouse_ev.replace(m);
    let q = bound_queue(app, line);
    app.mouse_ev = saved;
    run_queue(app, q);
}

/// A command given as arguments (`hn <command> …` from a shell), split as tmux splits them.
pub fn execute_args(app: &mut App, words: &[String]) {
    let q: Queue = crate::cmdparse::from_arguments(words).into_iter().map(|words| Item { words, origin: None, mouse: None }).collect();
    run_queue(app, q);
}

/// A command waiting in the queue, and the file and line it was read from (a config's).
#[derive(Clone, Debug)]
pub struct Item { pub words: Vec<String>, pub origin: Option<(std::sync::Arc<str>, usize)>, pub mouse: Option<crate::mouse::Event> }

pub type Queue = std::collections::VecDeque<Item>;

/// A command string as the queue's commands, parsed by tmux's grammar (cmdparse); its error
/// said, and nothing run, when it has one.
fn queue_of(app: &mut App, line: &str) -> Queue {
    match crate::cmdparse::parse(line, app, false) {
        // Commands a command queues (if-shell's, a menu's) keep its mouse event, as tmux's
        // inserted items keep their state.
        Ok(cmds) => cmds.iter().map(|c| Item { words: crate::cmdparse::words(c), origin: None, mouse: app.mouse_ev.clone() }).collect(),
        Err((_, e)) => { app.error(e); Queue::new() }
    }
}

fn run_queue(app: &mut App, mut queue: Queue) {
    while let Some(Item { words, origin, mouse }) = queue.pop_front() {
        app.origin = origin;
        let saved = std::mem::replace(&mut app.mouse_ev, mouse);
        let job = match shell_job(app, &words) { Ok(j) => j, Err(e) => { app.error(e); app.origin = None; app.mouse_ev = saved; continue } };
        let Some(Job { command, cwd, delay, background, done }) = job else {
            run_words(app, &words);
            app.origin = None;
            app.mouse_ev = saved;
            // What source-file read runs next, before the rest.
            if !app.insert_next.is_empty() { let mut next = std::mem::take(&mut app.insert_next); next.extend(queue); queue = next }
            continue;
        };
        app.origin = None;
        // What the job chooses to run next keeps the item's mouse event.
        let mouse = std::mem::replace(&mut app.mouse_ev, saved);
        let run = async move {
            if delay > 0.0 { tokio::time::sleep(std::time::Duration::from_secs_f64(delay)).await }
            let Some(command) = command else { return Outcome::default() };
            let mut c = tokio::process::Command::new("/bin/sh");
            // tmux's job: the shell's output read, its errors to /dev/null.
            c.arg("-c").arg(&command).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            c.envs(crate::ipc::job_env());
            if let Some(d) = cwd { c.current_dir(d); }
            match c.output().await {
                Ok(o) => {
                    use std::os::unix::process::ExitStatusExt;
                    let (code, signal) = match (o.status.code(), o.status.signal()) { (Some(c), _) => (c, None), (None, Some(s)) => (128 + s, Some(s)), _ => (0, None) };
                    Outcome { code, signal, out: String::from_utf8_lossy(&o.stdout).to_string(), failed: None }
                }
                Err(e) => Outcome { code: 127, signal: None, out: String::new(), failed: Some(format!("failed to run command: {e}")) },
            }
        };
        if background {
            // -b: in the background; the queue goes on, and so does the shell that asked.
            app.spawn(run, move |app, o| {
                let saved = std::mem::replace(&mut app.mouse_ev, mouse);
                let next = done(app, o);
                app.mouse_ev = saved;
                if !next.is_empty() { run_queue(app, next) }
            });
            continue;
        }
        // The queue waits for it — and so does the shell that ran the command, if one did.
        let waiting = (app.capture.take(), app.capture_err.take(), app.cli_tx.take(), app.cli_code, app.cli_cwd.clone());
        app.spawn(run, move |app, o| {
            let (cap, err, tx, code, cwd) = waiting;
            let from_shell = cap.is_some();
            if from_shell { app.capture = cap; app.capture_err = err; app.cli_tx = tx; app.cli_code = code; app.cli_cwd = cwd }
            // What it chose to run next (if-shell's command, run-shell -C's) goes first.
            let saved = std::mem::replace(&mut app.mouse_ev, mouse);
            let mut next = done(app, o);
            app.mouse_ev = saved;
            next.extend(queue);
            run_queue(app, next);
            if from_shell && app.capture.is_some() { app.finish_cli() }
        });
        return;
    }
}

/// How a job ended: tmux's exit status (128 + the signal for one killed), and what it printed.
#[derive(Default)]
struct Outcome { code: i32, signal: Option<i32>, out: String, failed: Option<String> }

/// A shell command to run, and what to do when it has: the commands to run next, first.
struct Job { command: Option<String>, cwd: Option<String>, delay: f64, background: bool, done: Box<dyn FnOnce(&mut App, Outcome) -> Queue + Send> }

/// if-shell and run-shell, as cmd-if-shell.c and cmd-run-shell.c run them: the command expanded
/// as a format for the target pane (a target not found leaves none), run by /bin/sh in the
/// folder of the shell that ran it (-c another), after -d seconds; -b in the background. if-shell
/// -F, and the vim-tmux-navigator test hn answers itself, stay with run_words.
fn shell_job(app: &App, words: &[String]) -> Result<Option<Job>, String> {
    let Some(entry) = words.first().and_then(|w| crate::cmd::find(w).ok()) else { return Ok(None) };
    if !matches!(entry.name, "if-shell" | "run-shell") || hn_owned(&words[0]) { return Ok(None) }
    let words = crate::tmuxconf::unblock(words);
    let args = crate::cmd::parse(entry, &words)?;
    let found = entry.target.and_then(|spec| crate::cmd::resolve(app, args.get('t'), spec).ok()).unwrap_or_default();
    let (w, p) = match (found.window, found.pane) { (Some(w), p) => (w, p), _ => (usize::MAX, None) };
    let expand = |s: &str| crate::format::expand(app, s, w, p, false);
    let cwd = args.get('c').map(crate::tmuxconf::expand_home).or_else(|| app.cli_cwd.clone())
        .or_else(|| std::env::current_dir().ok().map(|d| d.display().to_string()));
    let background = args.has('b') > 0;
    match entry.name {
        "if-shell" => {
            if args.has('F') > 0 { return Ok(None) }
            let cond = args.values[0].clone();
            let tty_unknown = p.and_then(|p| app.panes.get(&p)).and_then(|x| x.remote_tty.clone()).is_none();
            if (cond.contains("pane_tty") && tty_unknown) || cond.contains("$is_vim") { return Ok(None) }
            let (yes, no) = (args.values.get(1).cloned(), args.values.get(2).cloned());
            Ok(Some(Job { command: Some(expand(&cond)), cwd, delay: 0.0, background, done: Box::new(move |app, o| {
                if let Some(e) = o.failed { app.error(e); return Default::default() }
                let pick = if o.code == 0 && o.signal.is_none() { yes } else { no };
                pick.map(|c| queue_of(app, &c)).unwrap_or_default()
            }) }))
        }
        _ => {
            let delay = match args.get('d') { Some(d) => d.trim().parse::<f64>().map_err(|_| format!("invalid delay time: {d}"))?, None => 0.0 };
            if args.get('d').is_none() && args.values.is_empty() { return Ok(Some(Job { command: None, cwd: None, delay: 0.0, background: true, done: Box::new(|_, _| Default::default()) })) }
            if args.has('C') > 0 {
                // -C: after the delay, the argument runs as tmux commands.
                let c = args.values.first().cloned();
                return Ok(Some(Job { command: None, cwd: None, delay, background, done: Box::new(move |app, _| c.map(|c| queue_of(app, &c)).unwrap_or_default()) }));
            }
            let command = args.values.first().map(|c| expand(c));
            let shown = command.clone().unwrap_or_default();
            Ok(Some(Job { command, cwd, delay, background, done: Box::new(move |app, o| {
                if let Some(e) = o.failed { app.error(e); return Default::default() }
                // Each line it printed, then how it failed, to the shell that asked (else shown).
                let mut lines: Vec<String> = o.out.lines().map(str::to_string).collect();
                match o.signal {
                    Some(s) => lines.push(format!("'{shown}' terminated by signal {s}")),
                    None if o.code != 0 => lines.push(format!("'{shown}' returned {}", o.code)),
                    None => {}
                }
                if o.code != 0 { app.cli_code = o.code }
                if !lines.is_empty() { app.print("run-shell", lines) }
                Default::default()
            }) }))
        }
    }
}

/// cmd_template_replace: the answer for `%idx` — and for the first `%%` not yet used — into a
/// template (`%%%` and `%N%`… quoted: " \ $ ; ~ escaped).
pub fn template_replace(template: &str, s: &str, idx: usize) -> String {
    if !template.contains('%') { return template.to_string() }
    let b: Vec<char> = template.chars().collect();
    let (mut out, mut replaced, mut i) = (String::new(), false, 0);
    while i < b.len() {
        let ch = b[i];
        i += 1;
        if ch == '%' {
            let here = b.get(i).copied();
            let numbered = matches!(here, Some(c @ '1'..='9') if (c as usize - '0' as usize) == idx);
            if numbered || (here == Some('%') && !replaced) {
                if !numbered { replaced = true }
                i += 1;
                let quoted = b.get(i) == Some(&'%');
                if quoted { i += 1 }
                for c in s.chars() { if quoted && "\"\\$;~".contains(c) { out.push('\\') } out.push(c) }
                continue;
            }
        }
        out.push(ch);
    }
    out
}

/// A path as tmux's file_read/file_write take it: from the folder of the shell that ran the
/// command (else hn's), `-` as it is.
fn client_path(app: &App, path: &str) -> String {
    if path == "-" || path.starts_with('/') { return path.to_string() }
    let cwd = app.cli_cwd.clone().or_else(|| std::env::current_dir().ok().map(|d| d.display().to_string())).unwrap_or_else(|| "/".into());
    format!("{cwd}/{path}")
}

/// strerror's words for a file error.
fn io_error(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "No such file or directory".into(),
        std::io::ErrorKind::PermissionDenied => "Permission denied".into(),
        std::io::ErrorKind::IsADirectory => "Is a directory".into(),
        _ => e.to_string(),
    }
}

/// A tmux.conf read as tmux reads one (cmd-parse.y): parsed whole — `file:line: error` and none
/// of it runs — then checked command by command; its commands, each with its file and line (-n:
/// none; -v: each line printed as tmux prints it).
pub fn source(app: &mut App, file: &str, parse_only: bool, verbose: bool) -> Result<Queue, String> {
    let text = std::fs::read_to_string(file).map_err(|e| format!("{file}: {}", match e.kind() {
        std::io::ErrorKind::NotFound => "No such file or directory".to_string(),
        std::io::ErrorKind::PermissionDenied => "Permission denied".to_string(),
        _ => e.to_string(),
    }))?;
    if text.is_empty() { return Ok(Queue::new()) }
    let parsed = crate::cmdparse::parse(&text, app, parse_only).map_err(|(line, e)| format!("{file}:{line}: {e}"))?;
    let aliases = app.options.array("command-alias");
    let alias = |name: &str| aliases.iter().find_map(|a| a.split_once('=').filter(|(n, _)| *n == name).map(|(_, v)| v.to_string()));
    let built = crate::cmdparse::build(&parsed, app, Some(file), verbose, &alias);
    let (built, error) = match built { Ok(b) => (b, None), Err((b, e)) => (b, Some(e)) };
    if verbose && !built.verbose.is_empty() { app.print("source-file", built.verbose.clone()) }
    if let Some(e) = error { return Err(e) }
    if parse_only { return Ok(Queue::new()) }
    let origin: std::sync::Arc<str> = std::sync::Arc::from(file);
    Ok(built.commands.iter().map(|c| Item { words: crate::cmdparse::words(c), origin: Some((origin.clone(), c.line)), mouse: None }).collect())
}

/// The config at start, as tmux reads it: ~/.tmux.conf and the XDG ones that exist (or -f's);
/// a missing one is no error. Its commands then run in order.
pub fn load_config(app: &mut App) -> Vec<String> {
    let files: Vec<String> = match std::env::var("HARNESS_TUI_TMUX_CONF") {
        Ok(v) if v == "off" => Vec::new(),
        Ok(v) => vec![v],
        Err(_) => {
            let home = std::env::var("HOME").unwrap_or_default();
            let xdg = std::env::var("XDG_CONFIG_HOME").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| format!("{home}/.config"));
            let mut all = vec!["/etc/tmux.conf".to_string(), format!("{home}/.tmux.conf"), format!("{xdg}/tmux/tmux.conf")];
            if xdg != format!("{home}/.config") { all.push(format!("{home}/.config/tmux/tmux.conf")) }
            all.into_iter().filter(|f| std::path::Path::new(f).exists()).collect()
        }
    };
    let (mut queue, mut read) = (Queue::new(), Vec::new());
    for file in files {
        match source(app, &file, false, false) {
            Ok(items) => { queue.extend(items); read.push(file) }
            Err(e) => app.error(e),
        }
    }
    run_queue(app, queue);
    read
}

/// glob(3) as source-file uses it: `*` `?` `[…]` in any part of the path, the matches sorted.
fn glob(pattern: &str) -> Vec<String> {
    if !pattern.contains(['*', '?', '[']) { return if std::path::Path::new(pattern).exists() { vec![pattern.to_string()] } else { Vec::new() } }
    let mut found = vec![String::new()];
    for (i, part) in pattern.split('/').enumerate() {
        if i == 0 && part.is_empty() { found = vec!["/".into()]; continue }
        let mut next = Vec::new();
        for base in &found {
            let join = |n: &str| if base.is_empty() { n.to_string() } else if base.ends_with('/') { format!("{base}{n}") } else { format!("{base}/{n}") };
            if !part.contains(['*', '?', '[']) { next.push(join(part)); continue }
            let dir = if base.is_empty() { ".".to_string() } else { base.clone() };
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| (!n.starts_with('.') || part.starts_with('.')) && crate::cmd::fnmatch(part, n)).collect();
            names.sort();
            next.extend(names.iter().map(|n| join(n)));
        }
        found = next;
    }
    found.into_iter().filter(|p| std::path::Path::new(p).exists()).collect()
}

/// A command's words, and — for tmux's own commands — how tmux's args_parse reads them, which
/// the helpers below answer from (hn's own commands are read the older, looser way).
pub struct Words { list: Vec<String>, args: Option<crate::cmd::Args> }

impl std::ops::Deref for Words {
    type Target = [String];
    fn deref(&self) -> &[String] { &self.list }
}

impl Words {
    fn plain(list: Vec<String>) -> Words { Words { list, args: None } }
}

fn flag(words: &Words, f: &str) -> bool {
    if let (Some(a), Some(c)) = (&words.args, f.chars().nth(1)) { return a.has(c) > 0 }
    words.iter().skip(1).any(|w| w == f || (w.starts_with('-') && !w.starts_with("--") && w.len() > 2 && w[1..].contains(&f[1..]) && f.len() == 2))
}
fn opt(words: &Words, f: &str) -> Option<String> {
    if let (Some(a), Some(c)) = (&words.args, f.chars().nth(1)) { return a.get(c).map(str::to_string) }
    let at = words.iter().position(|w| w == f)?;
    words.get(at + 1).cloned()
}
/// The positional words: past the flags and the values the flags take (`-t x`, `-l 10`).
fn positional(words: &Words) -> Vec<String> {
    if let Some(a) = &words.args { return a.values.clone() }
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

fn rest(words: &Words) -> String {
    if let Some(a) = &words.args { return a.values.join(" ") }
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

/// hn's own commands, and the tmux names hn gives its own meaning (checked before tmux's table).
pub fn hn_owned(name: &str) -> bool {
    COMMANDS.iter().any(|(full, alias, _)| (*full == name || *alias == name) && crate::cmd::find(full).map(|e| e.name != *full).unwrap_or(true))
}

fn run_words(app: &mut App, words: &[String]) {
    let Some(first) = words.first() else { return };
    // Blocks are plain arguments to every command but bind (which writes them back as blocks).
    let list = if resolve(first) == "bind-key" || crate::cmd::find(first).map(|e| e.name == "bind-key").unwrap_or(false) { words.to_vec() } else { crate::tmuxconf::unblock(words) };
    // tmux's commands: found as cmd.c finds them (alias, name, or its unique start), read as
    // args_parse reads them, their -t and -s found as cmd-find.c finds them — or tmux's error,
    // and nothing is done.
    let words = match crate::cmd::find(first) {
        Err(e) if e.starts_with("ambiguous") => return app.error(e),
        Ok(entry) if !hn_owned(first) => {
            let args = match crate::cmd::parse(entry, &list) { Ok(a) => a, Err(e) => return app.error(e) };
            for (spec, f) in [(entry.target, 't'), (entry.source, 's')] {
                let Some(spec) = spec else { continue };
                if let Err(e) = crate::cmd::resolve(app, args.get(f), spec) { if !spec.can_fail { return app.error(e) } }
            }
            let mut list = list;
            list[0] = entry.name.to_string();
            &Words { list, args: Some(args) }
        }
        _ => &Words::plain(list),
    };
    let command = resolve(&words[0]);
    match command {
        "new-window" => {
            // tmux's new-window [-abdkPS] [-c dir] [-n name] [-t index] [-F fmt] [command]: a
            // window with a shell, at -t's index (else the first free one); -a after the target
            // window, -b before it (the windows from there moving up one); -k replacing a window
            // at that index (else `index N in use`); -S with -n: a window of that name selected
            // instead; -d not gone to; -P printed.
            let cwd = opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty());
            let command = shell_command(words);
            let name = opt(words, "-n");
            if flag(words, "-S") && opt(words, "-t").is_none() {
                if let Some(n) = &name {
                    let want = expand(app, n);
                    let hits: Vec<usize> = (0..app.tabs.len()).filter(|i| app.tabs[*i].name == want).collect();
                    if hits.len() > 1 { return app.error(format!("multiple windows named {n}")) }
                    if let Some(&i) = hits.first() { if !flag(words, "-d") { app.select_tab(i) } return }
                }
            }
            // The pane this came from decides the machine and folder — read before the new window.
            let from = input::focused_agent(app);
            let last_before = app.lastw.clone();
            let was_id = app.tab().id.clone();
            let spec = crate::cmd::Spec { kind: crate::cmd::Kind::Window, can_fail: false, window_index: true, default_marked: false };
            let found = crate::cmd::resolve(app, opt(words, "-t").as_deref(), spec).unwrap_or_default();
            let mut idx = found.idx;
            if flag(words, "-a") || flag(words, "-b") {
                let at = found.window.map(|w| app.win_num(w)).unwrap_or_else(|| app.win_num(app.active));
                let at = if flag(words, "-b") { at } else { at + 1 };
                app.shuffle_up(at);
                idx = Some(at);
            }
            if let Some(n) = idx {
                if let Some(i) = app.tab_by_num(n) {
                    if !flag(words, "-k") { return app.error(format!("create window failed: index {n} in use")) }
                    app.close_tab(i);
                }
            }
            app.new_tab_at(idx);
            if let Some(n) = &name { let n = expand(app, n); app.rename_tab(&n) }
            // -d: made, not visited: its shell starts there, and you stay where you were.
            if flag(words, "-d") { app.return_to = Some((was_id, last_before)) }
            if flag(words, "-P") { app.print_new = Some(opt(words, "-F").unwrap_or_else(|| "#{session_name}:#{window_index}.#{pane_index}".into())) }
            input::new_shell_from(app, from, Placement::Auto(None), cwd, command);
        }
        "split-window" => {
            // tmux's split-window [-bdfhIvPZ] [-c dir] [-l size] [-t target] [-F fmt] [command]: a
            // shell beside (-h) or below the target pane, in its machine and folder; -b before it,
            // -f across the whole window, -l its size (cells, or n%), -d not gone to, -P printed.
            let dir = if flag(words, "-h") { Dir::Horizontal } else { Dir::Vertical };
            let (w, p) = match opt(words, "-t") {
                Some(t) => match pane_target(app, &t) { Some(x) => x, None => return app.error(format!("can't find pane: {t}")) },
                None => app.current().unwrap_or((app.active, 0)),
            };
            let size = match split_size(app, words) { Ok(s) => s, Err(e) => return app.error(e) };
            if flag(words, "-P") { app.print_new = Some(opt(words, "-F").unwrap_or_else(|| "#{session_name}:#{window_index}.#{pane_index}".into())) }
            let cwd = opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty());
            let command = shell_command(words);
            let from = app.panes.get(&p).map(|x| (x.machine_id.clone(), x.agent_id.clone()));
            let pane = app.tabs[w].panes().contains(&p).then_some(p);
            let at = crate::app::At { tab: app.tabs[w].id.clone(), pane, dir, before: flag(words, "-b"), full: flag(words, "-f"), size, detached: flag(words, "-d"), zoom: flag(words, "-Z") };
            input::new_shell_from(app, from, Placement::At(at), cwd, command);
        }
        "kill-pane" => {
            // -t: that pane; -a: every pane but it (tmux's order of reading).
            let target = match opt(words, "-t") { Some(t) => match pane_target(app, &t) { Some(x) => Some(x), None => { app.error(format!("can't find pane: {t}")); return } }, None => app.current() };
            match target {
                Some((w, p)) if flag(words, "-a") => { let others: Vec<u64> = app.tabs[w].panes().into_iter().filter(|x| *x != p).collect(); for o in others { app.close_pane(o) } }
                Some((_, p)) => app.close_pane(p),
                None => { if app.tabs.len() > 1 { let i = app.active; app.close_tab(i) } }
            }
        }
        "kill-window" => {
            let target = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => { app.error(format!("can't find window: {t}")); return } }, None => app.active };
            if flag(words, "-a") {
                let keep = app.tabs[target].id.clone();
                while let Some(i) = app.tabs.iter().position(|t| t.id != keep) { app.close_tab(i) }
            } else { app.close_tab(target) }
        }
        "next-window" | "previous-window" => {
            // -a: the next (previous) window with an alert — # ! ~ — round the end
            // (session_next_alert); else simply the next (previous) one.
            let n = app.tabs.len();
            let step = |i: usize| if command == "next-window" { (i + 1) % n } else { (i + n - 1) % n };
            if flag(words, "-a") {
                let mut i = step(app.active);
                while i != app.active && !crate::format::flags(app, i).contains(['#', '!', '~']) { i = step(i) }
                if i == app.active { return app.error(format!("no {} window", if command == "next-window" { "next" } else { "previous" })) }
                return app.select_tab(i);
            }
            app.select_tab(step(app.active))
        }
        "last-window" => input::run(app, "last-tab"),
        "select-window" => {
            let target = opt(words, "-t").or_else(|| Some(rest(words))).unwrap_or_default();
            if flag(words, "-l") { input::run(app, "last-tab"); return }
            match window_target(app, &target) { Some(i) => app.select_tab(i), None => app.error(format!("can't find window: {}", target.trim_start_matches(':'))) }
        }
        "rename-window" => {
            // rename-window [-t target-window] new-name
            let target = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            let name = positional(words).join(" ");
            app.rename_tab_at(target, &name);
        }
        "move-window" => {
            // cmd-move-window.c: -r renumbers the windows; else the source (-s, else this window)
            // takes the target's number (-t: a number that may be free; none: the first free
            // one), -a after it or -b before it (the windows from there moving up one), -k
            // replacing a window there; it is made the current window unless -d.
            if flag(words, "-r") { app.renumber_all(); return }
            let src = match opt(words, "-s") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            let spec = crate::cmd::Spec { kind: crate::cmd::Kind::Window, can_fail: false, window_index: true, default_marked: false };
            let found = match crate::cmd::resolve(app, opt(words, "-t").as_deref(), spec) { Ok(f) => f, Err(e) => return app.error(e) };
            let id = app.tabs[src].id.clone();
            let mut idx = found.idx;
            if flag(words, "-a") || flag(words, "-b") {
                let at = found.window.map(|w| app.win_num(w)).unwrap_or_else(|| app.win_num(app.active));
                let at = if flag(words, "-b") { at } else { at + 1 };
                app.shuffle_up(at);
                idx = Some(at);
            }
            let Some(src) = app.tabs.iter().position(|t| t.id == id) else { return };
            if let Err(e) = app.move_window(src, idx, flag(words, "-k"), !flag(words, "-d")) { app.error(e) }
        }
        "select-pane" => {
            // tmux's select-pane [-DdeLlMmRUZ] [-T title] [-t target-pane]. -M clears the mark,
            // -m marks the pane (again: unmarks); -l the last pane; -L/-R/-U/-D the pane that
            // way (round the far side); -d/-e input off/on; -T the title. Else the pane becomes
            // its window's active one — the window does not become the current one. A zoomed
            // window is unzoomed unless -Z.
            if flag(words, "-M") { app.marked = None; return }
            let (w, p) = match opt(words, "-t") {
                Some(t) => match pane_target(app, &t) { Some(x) => x, None => return app.error(format!("can't find pane: {t}")) },
                None => match app.current() { Some(x) => x, None => return },
            };
            let keep_zoom = flag(words, "-Z");
            if flag(words, "-m") { app.marked = if app.marked == Some(p) { None } else { Some(p) }; return }
            if flag(words, "-l") { return app.select_last(w, keep_zoom) }
            let toward = if flag(words, "-L") { Some(Toward::Left) } else if flag(words, "-R") { Some(Toward::Right) } else if flag(words, "-U") { Some(Toward::Up) } else if flag(words, "-D") { Some(Toward::Down) } else { None };
            let p = match toward { Some(t) => match app.pane_toward(w, p, t) { Some(x) => x, None => return }, None => p };
            if flag(words, "-e") || flag(words, "-d") { if let Some(x) = app.panes.get_mut(&p) { x.input_off = flag(words, "-d") } return }
            if let Some(title) = opt(words, "-T") {
                let title = expand(app, &title);
                if let Some(x) = app.panes.get_mut(&p) { x.title = title; x.osc_title.clear() }
                app.sync_titles();
                return;
            }
            if app.tabs[w].focus == Some(p) { return }
            let zoomed = app.tabs[w].zoomed;
            if w == app.active { app.focus_pane(w, p) } else { app.tabs[w].set_active(p) }
            app.tabs[w].zoomed = zoomed && keep_zoom;
            app.fit_panes();
        }
        "last-pane" => {
            let w = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            if flag(words, "-e") || flag(words, "-d") {
                let last = app.tabs[w].last_focus();
                if let Some(x) = last.and_then(|l| app.panes.get_mut(&l)) { x.input_off = flag(words, "-d") }
                return;
            }
            app.select_last(w, flag(words, "-Z"))
        }
        "resize-pane" => {
            // resize-pane [-DLMRTUZ] [-t target-pane] [-x width] [-y height] [adjustment]
            // -M: the border under the mouse follows it until the button comes up.
            if flag(words, "-M") {
                if let Some(m) = app.mouse_ev.clone() { crate::mouse::resize_begin(app, &m) }
                return;
            }
            let (w, p) = match opt(words, "-t") {
                Some(t) => match pane_target(app, &t) { Some(x) => x, None => return app.error(format!("can't find pane: {t}")) },
                None => match app.current() { Some(x) => x, None => return },
            };
            if flag(words, "-Z") {
                if w != app.active || app.focused() != Some(p) { app.focus_pane(w, p) }
                input::run(app, "zoom");
                return;
            }
            // cmd-resize-pane.c: the adjustment read first; then -x, then -y (cells, or n% of the
            // window), then -L/-R/-U/-D by the adjustment — each that is given, in that order.
            let n = match positional(words).first() {
                None => 1,
                Some(v) => match strtonum(v, 1, i32::MAX as i64) { Ok(n) => n as i32, Err(e) => return app.error(format!("adjustment {e}")) },
            };
            let body = app.body();
            if let Some(v) = opt(words, "-x") {
                match percentage(&v, 0, i32::MAX as i64, body.width as i64) { Ok(x) => app.size_pane(w, p, Dir::Horizontal, x.min(u16::MAX as i64) as u16), Err(e) => return app.error(format!("width {e}")) }
            }
            if let Some(v) = opt(words, "-y") {
                match percentage(&v, 0, i32::MAX as i64, body.height as i64) { Ok(y) => app.size_pane(w, p, Dir::Vertical, y.min(u16::MAX as i64) as u16), Err(e) => return app.error(format!("height {e}")) }
            }
            let (dir, sign) = if flag(words, "-L") { (Dir::Horizontal, -1) } else if flag(words, "-R") { (Dir::Horizontal, 1) } else if flag(words, "-U") { (Dir::Vertical, -1) } else if flag(words, "-D") { (Dir::Vertical, 1) } else { return };
            app.resize_pane(w, p, dir, sign * n);
        }
        "swap-pane" => {
            // tmux's swap-pane [-dDUZ] [-s src] [-t dst]: the target (the current pane) and the
            // source (the marked pane, else the current one) trade places — in one window or
            // across two; -U/-D the source is the previous / next pane in the target's list.
            let dst = match opt(words, "-t") { Some(t) => match pane_target(app, &t) { Some(x) => x, None => return app.error(format!("can't find pane: {t}")) }, None => match app.current() { Some(x) => x, None => return } };
            let src = match opt(words, "-s") {
                Some(t) => match pane_target(app, &t) { Some(x) => x, None => return app.error(format!("can't find pane: {t}")) },
                None => pane_target(app, "{marked}").unwrap_or(dst),
            };
            let (detached, keep_zoom) = (flag(words, "-d"), flag(words, "-Z"));
            if flag(words, "-U") || flag(words, "-D") {
                let ids = app.tabs[dst.0].panes();
                let Some(at) = ids.iter().position(|p| *p == dst.1) else { return };
                let by = if flag(words, "-D") { 1 } else { -1 };
                let other = ids[(at as i64 + by).rem_euclid(ids.len() as i64) as usize];
                return app.swap_panes(dst.0, other, dst.1, detached, keep_zoom);
            }
            if src.0 == dst.0 { app.swap_panes(dst.0, src.1, dst.1, detached, keep_zoom) } else { app.swap_across(src, dst, detached, keep_zoom) }
        }
        "break-pane" => {
            // tmux's break-pane [-d] [-n name] [-s src] [-t dst-window]: the pane (this one, or
            // -s's) becomes a window of its own, keeping its id — at the first free index, or -t's.
            let src = match opt(words, "-s") { Some(t) => match pane_target(app, &t) { Some((_, p)) => p, None => return app.error(format!("can't find pane: {t}")) }, None => match app.focused() { Some(f) => f, None => return } };
            let num = match opt(words, "-t") { Some(t) => match t.trim_start_matches(':').trim_start_matches('=').parse::<usize>() { Ok(n) => Some(n), Err(_) => return app.error(format!("can't find window: {t}")) }, None => None };
            if let Err(e) = app.break_pane(src, opt(words, "-n"), num, flag(words, "-d")) { app.error(e) }
        }
        "rotate-window" => {
            // -t: that window; -D the other way; -Z keeps a zoomed window zoomed.
            let w = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            app.rotate(w, if flag(words, "-D") { -1 } else { 1 }, flag(words, "-Z"))
        }
        // -t: that window's layout, the current window staying where it is.
        "next-layout" | "previous-layout" => {
            let target = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            app.step_layout(target, command == "next-layout")
        }
        "select-layout" => {
            // -t: that window (else this one).
            // select-layout [-Enop] [-t target-window] [layout-name]: tmux's seven by name (or the
            // one a prefix names), -n/-p the next/previous, -E spread out, or a layout string.
            let target = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            if flag(words, "-n") || flag(words, "-p") { return app.step_layout(target, !flag(words, "-p")) }
            if flag(words, "-E") {
                if let Some(f) = app.tabs[target].focus { if let Some(root) = app.tabs[target].root.as_mut() { root.spread_out(f) } }
                return app.fit_panes();
            }
            let name = positional(words).join(" ");
            let name = name.trim();
            // No name: the layout last applied, again (nothing if there was none).
            if name.is_empty() {
                if let Some(at) = app.tabs[target].layout_at { app.arrange_tab(target, crate::layout::Named::ALL[at]) }
                return;
            }
            if let Some(named) = crate::layout::Named::lookup(name) { return app.arrange_tab(target, named) }
            // A tmux layout string (#{window_layout}, tmux-resurrect's): the panes take its cells.
            let ids = app.tabs[target].panes();
            let body = app.body();
            match crate::layout::Node::from_tmux(name, &ids, body.width, body.height) {
                Some(root) => { let tab = &mut app.tabs[target]; tab.root = Some(root); tab.zoomed = false; app.fit_panes() }
                None => app.error(format!("invalid layout: {name}")),
            }
        }
        "display-panes" => app.modal = Some(Modal::DisplayPanes { until: std::time::Instant::now() + std::time::Duration::from_millis(app.display_panes_ms) }),
        "copy-mode" => {
            // cmd-copy-mode.c [-deHMqu] [-s src-pane] [-t target-pane]: the pane into copy mode (-M
            // the one under the mouse, nothing when there is none) — -q out of it instead; -e it
            // leaves when scrolled back to the bottom, -H its position is not shown, -M a
            // selection dragged from the mouse; then -u a page up, -d a page down. Copy mode is the
            // pane's: its keys are its own while it is the active pane.
            let pane = if flag(words, "-M") {
                match app.mouse_ev.clone().filter(|m| m.valid).and_then(|m| crate::mouse::mouse_pane(app, &m)) { Some((_, p)) => p, None => return }
            } else {
                match target_pane(app, words) { Some((_, p)) => p, None => return }
            };
            if flag(words, "-q") {
                if let Some(p) = app.panes.get_mut(&pane) { if p.copy.is_some() { p.copy_end() } }
                return app.sync_copy_modal();
            }
            let fresh = app.panes.get(&pane).map(|p| p.copy.is_none()).unwrap_or(false);
            if fresh {
                let emacs = app.mode_keys_emacs();
                if let Some(p) = app.panes.get_mut(&pane) {
                    p.copy_start();
                    p.copy_by_wheel = flag(words, "-e");
                    p.copy_hide_position = flag(words, "-H");
                    p.copy_emacs = emacs;
                }
                if flag(words, "-M") { if let Some(m) = app.mouse_ev.clone() { crate::mouse::copy_drag_begin(app, &m) } }
            }
            if flag(words, "-u") { if let Some(p) = app.panes.get_mut(&pane) { p.copy_page(true, false); } }
            if flag(words, "-d") {
                let exit = flag(words, "-e");
                if let Some(p) = app.panes.get_mut(&pane) { if p.copy_page(false, false) && exit { p.copy_end() } }
            }
            app.sync_copy_modal();
        }
        "search-backward" | "search-forward" => { if let Some(pane) = app.focused() { app.modal = Some(Modal::Find { pane, query: String::new(), found: None, up: command == "search-backward" }) } }
        "paste-buffer" => {
            // tmux's paste-buffer [-dpr] [-s separator] [-b buffer-name] [-t target-pane]: the
            // buffer (the newest automatic one without -b) into the pane — its newlines as -s, a
            // newline with -r, else a carriage return; -p bracketed; -d the buffer then deleted.
            let Some((_, pane)) = target_pane(app, words) else { return };
            let name = match opt(words, "-b") {
                Some(b) => { if app.paste.get(&b).is_none() { return app.error(format!("no buffer {b}")) } Some(b) }
                None => app.paste.top().map(|b| b.name.clone()),
            };
            let Some(name) = name else { return };
            let text = app.paste.get(&name).map(|b| b.data.clone()).unwrap_or_default();
            let sep = opt(words, "-s").unwrap_or_else(|| if flag(words, "-r") { "\n".into() } else { "\r".into() });
            input::paste_into(app, pane, &text, &sep, flag(words, "-p"));
            if flag(words, "-d") { app.paste.free(&name) }
        }
        "list-buffers" if app.capture.is_some() => {
            // tmux's list-buffers [-F format] [-f filter]: newest first.
            let fmt = opt(words, "-F").unwrap_or_else(|| "#{buffer_name}: #{buffer_size} bytes: \"#{buffer_sample}\"".into());
            let filter = opt(words, "-f");
            let names: Vec<String> = app.paste.walk().map(|b| b.name.clone()).collect();
            let mut lines = Vec::new();
            for n in names {
                app.format_buffer = Some(n);
                let keep = filter.as_ref().map(|f| { let v = expand(app, f); !v.is_empty() && v != "0" }).unwrap_or(true);
                if keep { lines.push(expand(app, &fmt)) }
            }
            app.format_buffer = None;
            app.print("list-buffers", lines)
        }
        "list-buffers" | "choose-buffer" => input::run(app, "choose-buffer"),
        "delete-buffer" => {
            let name = match opt(words, "-b") {
                Some(b) => { if app.paste.get(&b).is_none() { return app.error(format!("unknown buffer: {b}")) } b }
                None => match app.paste.top() { Some(b) => b.name.clone(), None => return app.error("no buffer") },
            };
            app.paste.free(&name);
        }
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
            // tmux's display-message [-lp] [-F format] [-t target-pane] [message]: the format
            // (-l: as it is) against the target pane — one tmux can't find leaves it none.
            if flag(words, "-a") {
                let (w, p) = match opt(words, "-t").map(|t| pane_target(app, &t)) { Some(Some((w, p))) => (w, Some(p)), Some(None) => (usize::MAX, None), None => app.current().map(|(w, p)| (w, Some(p))).unwrap_or((app.active, None)) };
                let lines = crate::format::every(app, w, p);
                return app.print("display", lines);
            }
            if opt(words, "-F").is_some() && !positional(words).is_empty() { return app.error("only one of -F or argument must be given") }
            let text = opt(words, "-F").or_else(|| positional(words).first().cloned()).unwrap_or_default();
            if text.is_empty() && app.capture.is_none() { input::run(app, "info"); return }
            let text = if text.is_empty() { "[#S] #I:#W, current pane #P - (%H:%M %d-%b-%y)".to_string() } else { text };
            let out = if flag(words, "-l") { text } else {
                match opt(words, "-t").map(|t| pane_target(app, &t)) {
                    Some(Some((w, p))) => crate::format::expand(app, &text, w, Some(p), true),
                    Some(None) => crate::format::expand(app, &text, usize::MAX, None, true),
                    None => expand(app, &text),
                }
            };
            // -p prints (to the shell that asked); without it the message is the client's, as tmux's
            // (a message, not an error: no file:line before it).
            if flag(words, "-p") { app.print("display", vec![out]) } else {
                let (cap, origin) = (app.capture_err.take(), app.origin.take());
                app.say(out, theme::WARN);
                (app.capture_err, app.origin) = (cap, origin);
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
            let only = match &key { Some(k) => match crate::keys::parse(k) { Ok(c) => Some(c), Err(_) => return app.error(format!("invalid key: {k}")) }, None => None };
            let tables = app.keymap.tables();
            if let Some(t) = &table { if !tables.iter().any(|(n, _)| n == t) { return app.error(format!("table {t} doesn't exist")) } }
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
            if only.is_some() && lines.is_empty() { return app.error(format!("unknown key: {}", key.unwrap_or_default())) }
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
                } else if name.is_none() { name = Some(w.clone()) } else { return app.error("command show-options: too many arguments (need at most 1)") }
                i += 1;
            }
            let (tab, pane) = match target.as_deref() {
                Some(t) => match pane_target(app, t) { Some(tp) => tp, None => return app.error(format!("can't find window: {t}")) },
                None => app.current().unwrap_or((app.active, 0)),
            };
            let tab_id = app.tabs[tab].id.clone();
            match app.options.show(name.as_deref(), &f, inherited, values_only, &tab_id, pane) {
                Ok(lines) => { if !lines.is_empty() { app.print("show-options", lines) } }
                Err(_) if quiet => {}
                Err(e) => app.error(e),
            }
        }
        "list-windows" | "list-sessions" | "list-panes" | "list-clients" => {
            // tmux's list-* with its own templates (-F another), -f a filter, #{line} the count.
            let filter = opt(words, "-f");
            let rows: Vec<(usize, Option<u64>)> = match command {
                "list-panes" => {
                    let windows: Vec<usize> = if flag(words, "-a") || flag(words, "-s") { (0..app.tabs.len()).collect() } else { vec![opt(words, "-t").and_then(|t| window_target(app, &t)).unwrap_or(app.active)] };
                    windows.into_iter().flat_map(|w| app.tabs[w].panes().into_iter().map(move |p| (w, Some(p)))).collect()
                }
                "list-windows" => (0..app.tabs.len()).map(|w| (w, None)).collect(),
                _ => vec![(app.active, None)],
            };
            let history = "[#{pane_width}x#{pane_height}] [history #{history_size}/#{history_limit}, #{history_bytes} bytes] #{pane_id}#{?pane_active, (active),}#{?pane_dead, (dead),}";
            let template = opt(words, "-F").unwrap_or_else(|| match command {
                "list-panes" if flag(words, "-a") => format!("#{{session_name}}:#{{window_index}}.#{{pane_index}}: {history}"),
                "list-panes" if flag(words, "-s") => format!("#{{window_index}}.#{{pane_index}}: {history}"),
                "list-panes" => format!("#{{pane_index}}: {history}"),
                "list-windows" if flag(words, "-a") => "#{session_name}:#{window_index}: #{window_name}#{window_raw_flags} (#{window_panes} panes) [#{window_width}x#{window_height}] ".into(),
                "list-windows" => "#{window_index}: #{window_name}#{window_raw_flags} (#{window_panes} panes) [#{window_width}x#{window_height}] [layout #{window_layout}] #{window_id}#{?window_active, (active),}".into(),
                "list-sessions" => "#{session_name}: #{session_windows} windows (created #{t:session_created})#{?session_grouped, (group ,}#{session_group}#{?session_grouped,),}#{?session_attached, (attached),}".into(),
                _ => "#{client_name}: #{session_name} [#{client_width}x#{client_height} #{client_termname}] #{?#{!=:#{client_uid},#{uid}},[user #{?client_user,#{client_user},#{client_uid},}] ,}#{?client_flags,(,}#{client_flags}#{?client_flags,),}".into(),
            });
            let mut lines = Vec::new();
            let mut last_window = None;
            let mut n = 0usize;
            for (w, p) in rows {
                // #{line}: the row's number — list-panes counts each window's panes from 0.
                if command == "list-panes" && last_window != Some(w) { n = 0; last_window = Some(w) }
                app.format_line = Some(n);
                n += 1;
                let keep = filter.as_ref().map(|f| { let v = crate::format::expand(app, f, w, p, true); !v.is_empty() && v != "0" }).unwrap_or(true);
                if keep { lines.push(crate::format::expand(app, &template, w, p, true)) }
            }
            app.format_line = None;
            app.print(command, lines);
        }
        "set-option" | "set-window-option" => {
            // tmux's set-option: checked, kept where the flags say (the session, the window, the
            // pane, or globally), then the options hn acts on read the value now in force.
            let (f, quiet, format, target, args) = crate::tmuxconf::set_flags(&words[1..], command == "set-window-option");
            let Some(name) = args.first().cloned() else { return app.error("command set-option: too few arguments (need at least 1)") };
            let value = args.get(1).map(|v| if format { expand(app, v) } else { v.clone() });
            // -t: the window (or pane) the option is for; else the one here.
            let (tab, pane) = match target.as_deref() {
                Some(t) => match pane_target(app, t) { Some(tp) => tp, None => return app.error(format!("can't find window: {t}")) },
                None => app.current().unwrap_or((app.active, 0)),
            };
            let tab_id = app.tabs[tab].id.clone();
            let now = match app.options.set(&name, value.as_deref(), &f, &tab_id, pane) {
                Ok(now) => now,
                Err(e) if quiet && e.starts_with("invalid option") => return,
                Err(e) => return app.error(e),
            };
            // tim: `set -g @tim off` hides the creature (kept), `on` brings it back.
            if name == "@tim" { app.tim.set_off(matches!(now.as_deref(), Some("off" | "0" | "no"))); return }
            // alerts_reset_all: every window's silence timer starts again.
            if name == "monitor-silence" { for t in app.tabs.iter_mut() { t.last_output = std::time::Instant::now() } }
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
                Err(e) => app.error(e),
            }
        }
        "bind-key" | "unbind-key" => {
            let mut settings = crate::tmuxconf::Settings::default();
            let mut words = words.to_vec();
            words[0] = command.to_string();
            match crate::tmuxconf::directive(&words, &mut app.keymap, &mut settings) {
                Ok(()) => { app.apply_settings(&settings); if let Some(n) = settings.notes.first() { app.say(n.clone(), theme::WARN) } }
                Err(e) => app.error(e),
            }
        }
        "source-file" => {
            // tmux's source-file [-Fnqv] [-t target-pane] path …: each path a glob, from the folder
            // of the shell that ran it; each file parsed whole — an error in it and none of it runs,
            // said with its line; -n parsed only, -v each line printed as tmux read it, -q a
            // missing file no error, -F the paths expanded first. What it read runs next.
            let (quiet, parse_only, verbose) = (flag(words, "-q"), flag(words, "-n"), flag(words, "-v"));
            let cwd = app.cli_cwd.clone().or_else(|| std::env::current_dir().ok().map(|d| d.display().to_string())).unwrap_or_else(|| "/".into());
            let mut files = Vec::new();
            for path in positional(words) {
                let path = if flag(words, "-F") { expand(app, &path) } else { path };
                if path == "-" { app.say("-: reading the shell's input is not supported", theme::WARN); continue }
                let pattern = if path.starts_with('/') { path.clone() } else { format!("{cwd}/{path}") };
                let found = glob(&pattern);
                if found.is_empty() { if !quiet { app.error(format!("{path}: No such file or directory")) } continue }
                files.extend(found);
            }
            for file in files {
                match source(app, &file, parse_only, verbose) {
                    Ok(items) => app.insert_next.extend(items),
                    Err(e) => app.error(e),
                }
            }
        }
        "swap-window" => {
            // cmd-swap-window.c: the source (-s, else the marked pane's window, else this one) and
            // the target (-t, else this one) trade numbers. The current window number stays
            // current, so the window swapped in is the one shown; -d goes with the moved window
            // instead (the target's number is selected).
            let marked = app.marked.and_then(|m| app.tabs.iter().position(|t| t.panes().contains(&m)));
            let src = match opt(words, "-s") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => marked.unwrap_or(app.active) };
            let dst = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            if src == dst { return }
            // What tmux keeps on the winlink stays with the number, not the window: which one is
            // current, which was last (the - flag), and the alerts flagged there.
            let current = app.active;
            let (a, b) = (app.tabs[src].id.clone(), app.tabs[dst].id.clone());
            let (alerts_src, alerts_dst) = (app.tabs[src].alerts, app.tabs[dst].alerts);
            app.swap_tabs(src, dst);
            app.active = current;
            app.tabs[src].alerts = alerts_src;
            app.tabs[dst].alerts = alerts_dst;
            for x in app.lastw.iter_mut() { if *x == a { *x = b.clone() } else if *x == b { *x = a.clone() } }
            if flag(words, "-d") { app.select_tab(dst) } else { app.fit_panes() }
        }
        "join-pane" | "move-pane" => {
            // tmux's join-pane [-bdfhv] [-l size] [-s src] [-t dst]: the source (the marked pane,
            // else this one) leaves its window, keeping its id, and splits the target (this
            // window's active pane): -h beside it, -b before it, -f across the window, -l its
            // size, -d not gone to.
            let dir = if flag(words, "-h") { Dir::Horizontal } else { Dir::Vertical };
            let src = match opt(words, "-s") { Some(t) => pane_target(app, &t), None => pane_target(app, "{marked}").or_else(|| app.current()) };
            let dst = match opt(words, "-t") { Some(t) => pane_target(app, &t), None => app.tabs[app.active].focus.map(|f| (app.active, f)) };
            let (Some((_, sp)), Some((dw, dp))) = (src, dst) else { return app.error("can't find pane") };
            let size = match split_size(app, words) { Ok(s) => s, Err(e) => return app.error(e) };
            let at = crate::app::At { tab: app.tabs[dw].id.clone(), pane: Some(dp), dir, before: flag(words, "-b"), full: flag(words, "-f"), size, detached: flag(words, "-d"), zoom: false };
            if let Err(e) = app.join_pane(sp, at) { app.error(e) }
        }
        "clear-history" => { if let Some((_, p)) = target_pane(app, words) { if let Some(x) = app.panes.get_mut(&p) { x.clear_history() } } }
        "capture-pane" => {
            // -p prints it; else it becomes a paste buffer. -t names the pane.
            let pane = match opt(words, "-t") { Some(t) => match pane_target(app, &t) { Some((_, p)) => Some(p), None => { app.error(format!("can't find pane: {t}")); return } }, None => app.focused() };
            let range = (opt(words, "-S").and_then(|v| v.parse::<i32>().ok().or(if v == "-" { Some(i32::MIN) } else { None })), opt(words, "-E").and_then(|v| v.parse::<i32>().ok().or(if v == "-" { Some(i32::MAX) } else { None })));
            let Some(text) = pane.and_then(|p| app.panes.get(&p)).map(|p| p.text_range(range.0, range.1)) else { return };
            if flag(words, "-p") { app.print("capture-pane", text.lines().map(str::to_string).collect()) }
            else {
                let limit = app.buffer_limit();
                if let Err(e) = app.paste.set(text, opt(words, "-b").as_deref(), limit) { app.error(e) }
            }
        }
        // has-session: its -t was found (else tmux's error, and 1) before it ran.
        "has-session" => {}
        "list-commands" => {
            // tmux's list-commands [-F format] [command]: its commands in cmd.c's order, `name
            // (alias) usage` — then hn's own, their usage what they do.
            let fmt = opt(words, "-F").unwrap_or_else(|| "#{command_list_name}#{?command_list_alias, (#{command_list_alias}),} #{command_list_usage}".into());
            let only = positional(words).first().cloned();
            let mut rows: Vec<(String, String, String)> = crate::cmd::TABLE.iter().map(|e| (e.name.to_string(), e.alias.to_string(), e.usage.to_string())).collect();
            rows.extend(COMMANDS.iter().filter(|(n, _, _)| hn_owned(n)).map(|(n, a, d)| (n.to_string(), if a == n { String::new() } else { a.to_string() }, d.to_string())));
            let mut lines = Vec::new();
            for (name, alias, usage) in rows {
                if let Some(o) = &only { if *o != name && (alias.is_empty() || *o != alias) { continue } }
                app.format_command = Some((name, alias, usage));
                let line = expand(app, &fmt);
                if !line.is_empty() { lines.push(line) }
            }
            app.format_command = None;
            app.print("list-commands", lines)
        }
        "set-environment" | "setenv" => {
            // tmux's set-environment [-Fhgru] [-t target-session] name [value]: -g the global
            // environment (else the session's), -u unset, -r cleared (taken from what runs),
            // -h hidden, -F the value expanded.
            let args = positional(words);
            let name = args.first().cloned().unwrap_or_default();
            if name.is_empty() { return app.error("empty variable name") }
            if name.contains('=') { return app.error("variable name contains =") }
            let value = args.get(1).map(|v| if flag(words, "-F") { expand(app, v) } else { v.clone() });
            let env = if flag(words, "-g") { &mut app.global_env } else { &mut app.session_env };
            if flag(words, "-u") {
                if value.is_some() { return app.error("can't specify a value with -u") }
                env.remove(&name);
            } else if flag(words, "-r") {
                if value.is_some() { return app.error("can't specify a value with -r") }
                env.insert(name, crate::app::EnvVar { value: None, hidden: false });
            } else {
                let Some(value) = value else { return app.error("no value specified") };
                env.insert(name, crate::app::EnvVar { value: Some(value), hidden: flag(words, "-h") });
            }
        }
        "show-environment" | "showenv" => {
            // tmux's show-environment [-hgs] [-t target-session] [name]: NAME=value (-NAME when
            // cleared), -s as sh would set it, -h only the hidden ones (else only the others).
            let env = if flag(words, "-g") { &app.global_env } else { &app.session_env };
            let (hidden, shell) = (flag(words, "-h"), flag(words, "-s"));
            let show = |k: &str, e: &crate::app::EnvVar| -> Option<String> {
                if e.hidden != hidden { return None }
                Some(match (&e.value, shell) {
                    (Some(v), false) => format!("{k}={v}"),
                    (None, false) => format!("-{k}"),
                    (Some(v), true) => { let esc: String = v.chars().flat_map(|c| if matches!(c, '$' | '`' | '"' | '\\') { vec!['\\', c] } else { vec![c] }).collect(); format!("{k}=\"{esc}\"; export {k};") }
                    (None, true) => format!("unset {k};"),
                })
            };
            let lines: Vec<String> = match positional(words).first() {
                Some(name) => match env.get(name) { Some(e) => show(name, e).into_iter().collect(), None => return app.error(format!("unknown variable: {name}")) },
                None => env.iter().filter_map(|(k, e)| show(k, e)).collect(),
            };
            app.print("show-environment", lines)
        }
        "set-hook" | "show-hooks" => {}
        "wait-for" | "wait" => {}
        "pipe-pane" => app.error("pipe-pane: a harness pane's output lives on its machine (use capture-pane -p)"),
        "save-buffer" | "saveb" | "show-buffer" => {
            // tmux's save-buffer [-a] [-b buffer-name] path (show-buffer: to the shell, or a view):
            // the newest automatic buffer without -b; a path from the shell's folder (- its stdout).
            let b = match opt(words, "-b") {
                Some(n) => match app.paste.get(&n) { Some(b) => b.clone(), None => return app.error(format!("no buffer {n}")) },
                None => match app.paste.top() { Some(b) => b.clone(), None => return app.error("no buffers") },
            };
            let path = if command == "show-buffer" { "-".to_string() } else { expand(app, &positional(words).first().cloned().unwrap_or_default()) };
            if path == "-" { return app.print_data(command, &b.data) }
            let path = client_path(app, &path);
            let written = if flag(words, "-a") {
                use std::io::Write;
                std::fs::OpenOptions::new().append(true).create(true).open(&path).and_then(|mut f| f.write_all(b.data.as_bytes()))
            } else { std::fs::write(&path, &b.data) };
            if let Err(e) = written { app.error(format!("{path}: {}", io_error(&e))) }
        }
        "load-buffer" | "loadb" => {
            // tmux's load-buffer [-w] [-b buffer-name] path: the file (from the shell's folder)
            // into a buffer — named, or a new automatic one.
            let path = client_path(app, &expand(app, &positional(words).first().cloned().unwrap_or_default()));
            let text = if path == "-" { app.cli_stdin.clone().unwrap_or_default() } else {
                match std::fs::read(&path) { Ok(t) => String::from_utf8_lossy(&t).into_owned(), Err(e) => return app.error(format!("{path}: {}", io_error(&e))) }
            };
            let limit = app.buffer_limit();
            if let Err(e) = app.paste.set(text, opt(words, "-b").as_deref(), limit) { app.error(e) }
        }
        "resize-window" => app.error("resize-window: a window is the terminal's size here"),
        "respawn-window" => {
            // tmux's respawn-window: refused while anything runs in the window, unless -k.
            let w = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(w) => w, None => return }, None => app.active };
            let panes = app.tabs[w].panes();
            if !flag(words, "-k") && panes.iter().any(|p| pane_alive(app, *p)) { return app.error(format!("respawn window failed: window {}:{} still active", app.session_name(), app.win_num(w))) }
            for p in panes { respawn(app, p) }
        }
        "set-buffer" => {
            // tmux's set-buffer [-aw] [-b buffer-name] [-n new-buffer-name] data: -n renames (the
            // newest automatic buffer without -b), -a appends; an automatic buffer without -b.
            let name = opt(words, "-b");
            let exists = name.as_ref().map(|n| app.paste.get(n).is_some()).unwrap_or(false);
            if let Some(new) = opt(words, "-n") {
                let old = match &name {
                    Some(n) if exists => n.clone(),
                    Some(n) => return app.error(format!("unknown buffer: {n}")),
                    None => match app.paste.top() { Some(b) => b.name.clone(), None => return app.error("no buffer") },
                };
                if let Err(e) = app.paste.rename(&old, &new) { app.error(e) }
                return;
            }
            let args = positional(words);
            if args.len() != 1 { return app.error("no data specified") }
            if args[0].is_empty() { return }
            let mut data = String::new();
            if flag(words, "-a") && exists { data = app.paste.get(name.as_deref().unwrap_or("")).map(|b| b.data.clone()).unwrap_or_default() }
            data.push_str(&args[0]);
            let limit = app.buffer_limit();
            if let Err(e) = app.paste.set(data, name.as_deref(), limit) { app.error(e) }
        }
        "respawn-pane" => {
            // tmux's respawn-pane: a pane whose harness still runs needs -k.
            let Some((w, p)) = target_pane(app, words) else { return };
            if !flag(words, "-k") && pane_alive(app, p) { return app.error(format!("respawn pane failed: pane {} still active", pane_name(app, w, p))) }
            respawn(app, p);
        }
        "suspend-client" => app.suspend = true,
        "rename-session" => { let name = rest(words); if name.trim().is_empty() { app.error("rename-session: a name") } else { app.session_alias = Some(name.trim().to_string()) } }
        "clock-mode" => { if let Some(f) = app.focused() { app.modal = Some(Modal::Clock { pane: f }) } else { app.modal = Some(Modal::Clock { pane: 0 }) } }
        "refresh-client" => { app.redraw_all = true; for id in app.panes.keys().copied().collect::<Vec<_>>() { if app.rects.iter().any(|(r, _)| *r == id) { app.open_stream(id, false) } } }
        "kill-server" => app.quit = true,
        "kill-session" => {
            // -C: the windows' alerts cleared; -a: every other session (there is only this one);
            // else the session goes, and this client with it (its harnesses keep running).
            if flag(words, "-C") { for t in app.tabs.iter_mut() { t.alerts = 0 } return }
            if flag(words, "-a") { return }
            app.quit = true;
        }
        "detach-client" => {
            // -s: the clients of that session (one not found: nothing); -a: every other client;
            // -t: that client, by its tty, or tmux's error.
            if let Some(s) = opt(words, "-s") {
                let spec = crate::cmd::Spec { kind: crate::cmd::Kind::Session, can_fail: true, window_index: false, default_marked: false };
                if crate::cmd::resolve(app, Some(&s), spec).is_err() { return }
            } else if flag(words, "-a") { return }
            else if let Some(t) = opt(words, "-t") {
                let t = t.strip_suffix(':').unwrap_or(&t).to_string();
                let tty = crate::app::tty_name();
                if t != tty && Some(t.as_str()) != tty.strip_prefix("/dev/") { return app.error(format!("can't find client: {t}")) }
            }
            app.quit = true;
        }
        "switch-client" => {
            // -T: the key table the next key is looked up in (tmux's modal keys).
            if let Some(t) = opt(words, "-T") {
                match t.as_str() {
                    "root" => { app.key_table = None; app.prefix = false }
                    "prefix" => { app.key_table = None; app.prefix = true; app.prefix_at = Some(std::time::Instant::now()) }
                    _ if app.keymap.named.contains_key(&t) => { app.key_table = Some(t); app.prefix = false }
                    _ => app.error(format!("table {t} doesn't exist")),
                }
                return;
            }
            if flag(words, "-l") { input::run(app, "last-harness") }
            else if flag(words, "-n") { input::run(app, "next-tab-harness") }
            else if flag(words, "-p") { input::run(app, "prev-tab-harness") }
            else if let Some(t) = opt(words, "-t") {
                // tmux: a target with `:`, `.` or `%` is a pane (its window and pane become the
                // current ones), else a session.
                let kind = if t.contains([':', '.', '%']) { crate::cmd::Kind::Pane } else { crate::cmd::Kind::Session };
                let spec = crate::cmd::Spec { kind, can_fail: false, window_index: false, default_marked: false };
                match crate::cmd::resolve(app, Some(&t), spec) {
                    Ok(f) => match (f.window, f.pane) {
                        (Some(w), Some(p)) if kind == crate::cmd::Kind::Pane => app.focus_pane(w, p),
                        (Some(w), _) if kind == crate::cmd::Kind::Pane => app.select_tab(w),
                        _ => {}
                    },
                    Err(e) => app.error(e),
                }
            }
        }
        "send-keys" => {
            // -M: the mouse event of the key being run, to the pane it was over (window_pane_key:
            // its program, if it asked for the mouse; nothing for a pane in copy mode).
            if flag(words, "-M") {
                let m = app.mouse_ev.clone().filter(|m| m.valid);
                let Some((m, (_, pane))) = m.and_then(|m| crate::mouse::mouse_pane(app, &m).map(|t| (m, t))) else { return app.error("no mouse target") };
                if app.panes.get(&pane).map(|p| p.copy.is_some()).unwrap_or(false) || m.wp != Some(pane) { return }
                return crate::mouse::input_key_mouse(app, pane, &m);
            }
            let (Some(args), Some((_, pane))) = (words.args.clone(), target_pane(app, words)) else { return };
            input::send_keys(app, pane, &args);
        }
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
            let (w, p) = match target.as_deref().and_then(|t| pane_target(app, t)) { Some((w, p)) => (w, Some(p)), None => app.current().map(|(w, p)| (w, Some(p))).unwrap_or((app.active, None)) };
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
        // run-shell runs as a job (shell_job); nothing to run gets here.
        "run-shell" | "run" => {}
        "send-prefix" => {
            // The prefix key (-2: prefix2) to the pane, as if typed there.
            let Some((_, pane)) = target_pane(app, words) else { return };
            let key = if flag(words, "-2") { app.keymap.prefix2 } else { Some(app.keymap.prefix) };
            // To the active pane: what has the keyboard there (a list open over it) gets it.
            if let Some(key) = key {
                if Some(pane) == app.focused() { input::send_prefix_key(app, crossterm::event::KeyEvent::new(key.code, key.mods)) } else { input::send_chord(app, pane, key) }
            }
        }
        "command-prompt" => {
            // tmux's command-prompt [-1bFikN] [-I inputs] [-p prompts] [-T type] [template]: one
            // prompt per comma in -p (their initial text -I's, comma for comma, expanded as
            // formats), the answers filling the template's %1 %2 … (%% the first, %%% quoted);
            // no -p: `(command)` from the template, else `:`. -1 one key, -N numbers, -k a key's
            // name, -F the template expanded first.
            // The template is command text (a block's, or the string as it is).
            let template = positional(words).first().map(|w| w.strip_prefix(crate::tmuxconf::BLOCK).unwrap_or(w).to_string()).unwrap_or_default();
            let template = if flag(words, "-F") { expand(app, &template) } else { template };
            let name = crate::cmdparse::parse(&template, app, true).ok().and_then(|c| c.first().and_then(|c| c.args.first().cloned())).and_then(|a| match a { crate::cmdparse::Arg::Str(s) => Some(s), _ => None });
            let (labels, spaced): (Vec<String>, bool) = match opt(words, "-p") {
                Some(p) => (p.split(',').map(|l| expand(app, l)).collect(), true),
                None if !template.is_empty() => (vec![format!("({})", name.unwrap_or_default())], true),
                None => (vec![":".into()], false),
            };
            let inputs: Vec<String> = opt(words, "-I").map(|i| i.split(',').map(|v| expand(app, v)).collect()).unwrap_or_default();
            let mut prompts: Vec<(String, String)> = labels.into_iter().enumerate().map(|(k, l)| (if spaced { format!("{l} ") } else { l }, inputs.get(k).cloned().unwrap_or_default())).collect();
            // A shell that ran it waits for the answer (not with -b).
            app.wait_cli = app.capture.is_some() && !flag(words, "-b");
            if flag(words, "-k") { return app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Key { template }, &prompts[0].0, ""))) }
            let (label, initial) = prompts.remove(0);
            let kind = PromptKind::Command { template: (!template.is_empty()).then_some(template), more: prompts, answers: Vec::new(), one: flag(words, "-1"), digits: flag(words, "-N") };
            app.modal = Some(Modal::Prompt(Prompt::status(kind, &label, &initial)));
        }
        "display-menu" | "menu" => {
            // cmd-display-menu.c: name key command … ('' a separator; a name that expands empty
            // is left out; one starting '-' is shown dim, without its key), names and commands
            // expanded now; the box placed by -x and -y (C the centre, P/R the pane's left/right
            // and P its bottom, M the mouse, W the window in the status line, S the status line,
            // or a number); nothing over another menu; -O stays open; -C the item chosen first.
            if matches!(app.modal, Some(Modal::Menu(_)) | Some(Modal::Popup { .. })) { return }
            let Some(args) = words.args.clone() else { return };
            let starting: i64 = match args.get('C') { None => 0, Some("-") => -1, Some(c) => match c.parse::<u32>() { Ok(n) => n as i64, Err(_) => return app.error(format!("starting choice {c} is invalid")) } };
            let title = args.get('T').map(|t| expand(app, t)).unwrap_or_default();
            let mut items: Vec<crate::modal::MenuItem> = Vec::new();
            let vals = &args.values;
            let mut i = 0;
            while i < vals.len() {
                let name = vals[i].clone();
                i += 1;
                if name.is_empty() {
                    // menu_add_item: no separator first, or after another.
                    if items.last().map(|it| !it.separator).unwrap_or(false) { items.push(crate::modal::MenuItem { label: String::new(), key: String::new(), command: String::new(), disabled: true, separator: true }) }
                    continue;
                }
                if vals.len() - i < 2 { return app.error("not enough arguments") }
                let (key, command) = (vals[i].clone(), vals[i + 1].clone());
                i += 2;
                let label = expand(app, &name);
                if label.is_empty() { continue }
                let (disabled, label) = match label.strip_prefix('-') { Some(l) => (true, l.to_string()), None => (false, label) };
                let key = if disabled || key.eq_ignore_ascii_case("none") { String::new() } else { crate::keys::parse(&key).map(|c| crate::keys::name(&c)).unwrap_or_default() };
                let command = expand(app, command.strip_prefix(crate::tmuxconf::BLOCK).unwrap_or(&command));
                items.push(crate::modal::MenuItem { label, key, command, disabled, separator: false });
            }
            if items.is_empty() { return }
            // The width: the title's and each item's, its key's " (k)" included.
            let width = items.iter().filter(|it| !it.separator).map(|it| crate::draw::format_width(&it.label) + if it.key.is_empty() { 0 } else { it.key.chars().count() + 3 })
                .fold(crate::draw::format_width(&title), usize::max) as u16;
            let (w, h) = (width + 4, items.len() as u16 + 2);
            let target = args.get('t').and_then(|t| pane_target(app, t)).or_else(|| app.current());
            let Some((x, y)) = menu_position(app, &args, target, w, h) else { return };
            let no_mouse = !app.mouse_ev.as_ref().map(|m| m.valid).unwrap_or(false) && args.has('M') == 0;
            // menu_display: opened by the mouse, nothing is chosen until it moves over an item.
            let choice = if !no_mouse || starting < 0 { None } else {
                let n = items.len();
                let from = (starting as usize).min(n - 1);
                (0..n).map(|k| (from + k) % n).find(|k| !items[*k].disabled && !items[*k].separator)
            };
            app.modal = Some(Modal::Menu(crate::modal::Menu { title, items, choice, x, y, width, stay_open: args.has('O') > 0, no_mouse, mouse: app.mouse_ev.clone() }));
            app.wait_cli = app.capture.is_some();
        }
        "customize-mode" => {
            // tmux's options-and-keys tree, read here as one list: the options as they are, then every key.
            let mut lines = listing(app, "show-options");
            lines.push(String::new());
            for b in &app.keymap.prefix_table { lines.push(format!("{} {:<9} {}", crate::keys::name(&app.keymap.prefix), crate::keys::name(&b.chord), b.command)) }
            app.print("customize-mode", lines);
        }
        "confirm-before" => {
            // tmux's confirm-before [-by] [-c confirm-key] [-p prompt] command: `Confirm 'name'?
            // (y/n)` (or -p's, expanded), the confirm key (-c) or Enter with -y running it.
            let command = positional(words).first().map(|w| w.strip_prefix(crate::tmuxconf::BLOCK).unwrap_or(w).to_string()).unwrap_or_default();
            if command.is_empty() { return }
            let key = opt(words, "-c").and_then(|c| { let mut it = c.chars(); match (it.next(), it.next()) { (Some(k), None) if k.is_ascii_graphic() => Some(k), _ => None } });
            let Some(key) = key.or(if opt(words, "-c").is_some() { None } else { Some('y') }) else { return app.error("invalid confirm key") };
            let name = crate::cmdparse::parse(&command, app, true).ok().and_then(|c| c.first().and_then(|c| c.args.first().cloned())).and_then(|a| match a { crate::cmdparse::Arg::Str(s) => Some(resolve(&s).to_string()), _ => None }).unwrap_or_default();
            let prompt = match opt(words, "-p") { Some(p) => expand(app, &p), None => format!("Confirm '{name}'? ({key}/n)") };
            app.modal = Some(Modal::Confirm { prompt, command, key, enter_yes: flag(words, "-y") });
            app.wait_cli = app.capture.is_some() && !flag(words, "-b");
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
        other => app.error(format!("unknown command: {other}")),
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
