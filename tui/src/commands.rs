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
    ("choose-tree", "choose-tree", "-w windows · -s harnesses (sessions, with -F -f -K -O -r -N) · -m machines · -a waiting · -i models · -S store"),
    ("find-window", "findw", "Find a harness on any machine by what you type"),
    ("display-message", "display", "A message or format (-p prints it, -t a pane)"),
    ("show-messages", "showmsgs", "Messages so far"),
    ("list-keys", "lsk", "Key bindings (-T a table, -1N one key)"),
    ("keys", "keys", "Every key binding, searched as you type (C-b ? lists them as tmux does)"),
    ("answer-harness", "answer", "Answer a harness's question: answer -t name 2 (its second choice), 1,3, or your own words"),
    ("open-viewer", "view", "Open viewer in your browser (-t harness, -p print link, -c copy, -w browser app)"),
    ("open-harness", "openh", "A harness into a window of its own (-h/-v beside/below -t's pane, -d not gone to): open-harness -s name"),
    ("list-windows", "lsw", "The windows (-F a format)"),
    ("list-panes", "lsp", "The panes (-a/-s every window, -t one, -F a format)"),
    ("list-sessions", "ls", "The session (this computer) and its windows"),
    ("list-harnesses", "lsh", "Every harness on every machine, the most urgent first (-F format: #{harness_state} #{harness_line} …, -f filter)"),
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
    ("choose-command", "choosec", "Every command and setting by name (C-b Enter)"),
    ("take-control", "take", "Reclaim control of all panes across the TUI's tabs"),
    ("clone-harness", "cloneh", "A second harness with this one's history"),
    ("restart-harness", "restarth", "Restart this harness"),
    ("pause-harness", "pauseh", "Pause this harness (the conversation is kept)"),
    ("resume-harness", "resumeh", "Resume this harness"),
    ("rename-harness", "renameh", "Rename this harness"),
    ("send-task", "task", "Send a task — Harness picks the harness"),
    ("broadcast", "bcast", "Send one message to every harness in the window"),
    ("send-message", "msg", "Send a message (a turn) to this harness"),
    ("next-harness", "nexth", "The next harness that needs you: waiting on you, failed, then done (-p: the one before)"),
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
    // args_percentage_and_expand uses format_expand, not format_expand_time. In particular,
    // musl strftime rejects a trailing percent sign and turns an ordinary size into "".
    let expand_size = |value: &str| match app.current() {
        Some((w, p)) => crate::format::expand(app, value, w, Some(p), false),
        None => crate::format::expand(app, value, app.active, None, false),
    };
    if let Some(l) = opt(words, "-l") {
        // args_percentage_and_expand: no "empty" here — an empty size is an invalid number.
        let l = expand_size(&l);
        return match l.strip_suffix('%') {
            Some(n) => strtonum(n, 0, 100).map(|n| Some((fit(n), true))),
            None => strtonum(&l, 0, i32::MAX as i64).map(|n| Some((fit(n), false))),
        }.map_err(|e| format!("size {e}"));
    }
    match opt(words, "-p") {
        Some(p) => strtonum(&expand_size(&p), 0, 100).map(|n| Some((fit(n), true))).map_err(|e| format!("size {e}")),
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
    let index = app.tabs.get(w).and_then(|t| t.panes().iter().position(|x| *x == p)).unwrap_or(0) + app.pane_base(w);
    format!("{}:{}.{index}", app.session_name(), app.win_num(w))
}

/// Whether a harness still runs in a pane (respawn-pane needs -k then, as tmux does for a live pane).
fn pane_alive(app: &App, p: u64) -> bool {
    app.panes.get(&p).filter(|x| x.dead.is_none()).and_then(|x| app.fleet.agent(&x.machine_id, &x.agent_id)).map(|a| a.status != "stopped").unwrap_or(false)
}

/// Restart the harness in a pane (respawn-pane, respawn-window).
fn respawn(app: &mut App, p: u64, command: Option<String>, cwd: Option<String>) {
    let start_command = command.clone();
    let Some((machine, agent)) = app.panes.get(&p).map(|x| (x.machine_id.clone(), x.agent_id.clone())) else { return };
    let Some(link) = app.link(&machine) else { return app.say("That machine is not connected", theme::WARN) };
    if crate::local::is_local(&machine) {
        let previous_exit = app.panes.get(&p).and_then(|pane| pane.dead.as_ref().map(|exit| exit.id.clone()));
        app.spawn(async move { link.rpc("agent_restart", serde_json::json!({"agentId":agent,"command":command,"cwd":cwd}), std::time::Duration::from_secs(30)).await }, move |app, reply| match reply {
            Ok(_) => {
                if let Some(pane) = app.panes.get_mut(&p) {
                    pane.complete_restart(previous_exit.as_deref(), start_command);
                }
                app.relist(&machine); app.open_stream(p, true);
            }
            Err(e) => app.error(format!("respawn pane failed: {e}")),
        });
        return;
    }
    // A shell's new program (respawn-pane 'cmd', -c dir): typed into the new shell, as a new
    // window's command is — a harness's own program is its own.
    let shell = app.fleet.agent(&machine, &agent).map(|a| a.engine == "terminal").unwrap_or(false);
    let quoted = |c: &str| format!("'{}'", c.replace('\'', "'\\''"));
    let typed = (shell && (command.is_some() || cwd.is_some())).then(|| {
        let cd = cwd.as_deref().map(|d| format!("cd {} && ", quoted(d))).unwrap_or_default();
        match &command { Some(c) => format!(" {cd}clear; exec \"${{SHELL:-sh}}\" -c {}", quoted(c)), None => format!(" {cd}clear") }
    });
    app.spawn(async move { link.rpc("agent_restart", serde_json::json!({ "agentId": agent }), std::time::Duration::from_secs(120)).await.map(|r| (r, link, agent)) }, move |app, reply| match reply {
        Ok((_, link, agent)) => {
            if shell && start_command.is_some() { if let Some(pane) = app.panes.get_mut(&p) { pane.start_command = start_command; } }
            if let Some(text) = typed { link.send("message", serde_json::json!({ "agentId": agent, "content": text })); }
            app.relist(&machine)
        }
        Err(e) => app.error(format!("respawn pane failed: {e}")),
    });
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
        // cmd_print: its flags as args_print puts them (those without values bundled, by letter,
        // then each with its value), then its arguments — for a command with no block in it.
        if !words.iter().any(|(_, b)| *b) {
            let plain: Vec<String> = words.iter().map(|(w, _)| w.clone()).collect();
            if let Some(line) = plain.first().and_then(|n| crate::cmd::find(n).ok()).filter(|_| !words.iter().any(|(w, _)| w == ";")).and_then(|e| crate::cmd::parse(e, &plain).ok().map(|a| (e, a))).map(|(e, a)| {
                let rest = a.print();
                if rest.is_empty() { e.name.to_string() } else { format!("{} {rest}", e.name) }
            }) { return line }
        }
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
    if read_only_refused(app, &q) { return }
    let saved = std::mem::replace(&mut app.key_run, app.key_name.clone());
    run_queue(app, q);
    app.key_run = saved;
}

/// key_bindings_dispatch: a read-only client's key runs only what a read-only client may
/// (commands flagged CMD_READONLY: attach, detach, list-clients, switch-client); anything else is
/// "client is read-only".
fn read_only_refused(app: &mut App, q: &Queue) -> bool {
    if !app.read_only() { return false }
    let allowed = q.iter().all(|i| i.words.first().and_then(|w| crate::cmd::find(w).ok()).map(|e| matches!(e.name, "attach-session" | "detach-client" | "list-clients" | "switch-client")).unwrap_or(false));
    if !allowed { app.error("client is read-only") }
    !allowed
}

fn bound_queue(app: &mut App, line: &str) -> Queue {
    let mouse = app.mouse_ev.clone();
    queue_of(app, line).into_iter()
        .flat_map(|item| crate::cmdparse::from_arguments(&item.words).into_iter().map(|words| Item { words, origin: None, mouse: mouse.clone(), hook: app.hook_state.clone() }).collect::<Vec<_>>())
        .collect()
}

/// A mouse key's binding: its commands run with the event (the pane under the mouse their
/// target, `-t =` it, send-keys -M passing the event on).
pub fn execute_mouse(app: &mut App, line: &str, m: crate::mouse::Event) {
    let saved = app.mouse_ev.replace(m);
    let q = bound_queue(app, line);
    app.mouse_ev = saved;
    if read_only_refused(app, &q) { return }
    run_queue(app, q);
}

/// A command given as arguments (`hn <command> …` from a shell), split as tmux splits them.
pub fn execute_args(app: &mut App, words: &[String]) {
    // cmd_parse_from_arguments: each command's alias expanded (the alias's commands, the last
    // taking this one's words).
    let aliases = app.options.array("command-alias");
    let mut q = Queue::new();
    for words in crate::cmdparse::from_arguments(words) {
        let alias = words.first().and_then(|n| aliases.iter().find_map(|a| a.split_once('=').filter(|(k, _)| k == n).map(|(_, v)| v.to_string())));
        match alias.and_then(|a| crate::cmdparse::parse(&a, app, true).ok()) {
            Some(cmds) if !cmds.is_empty() => {
                let n = cmds.len();
                for (i, c) in cmds.iter().enumerate() {
                    let mut w = crate::cmdparse::words(c);
                    if i + 1 == n { w.extend(words[1..].iter().cloned()) }
                    q.push_back(Item { words: w, origin: None, mouse: None, hook: None });
                }
            }
            _ => q.push_back(Item { words, origin: None, mouse: None, hook: None }),
        }
    }
    run_queue(app, q);
}

/// A command waiting in the queue, and the file and line it was read from (a config's).
#[derive(Clone, Debug)]
pub struct Item { pub words: Vec<String>, pub origin: Option<(std::sync::Arc<str>, usize)>, pub mouse: Option<crate::mouse::Event>, pub hook: Option<std::sync::Arc<HookState>> }

/// What a hook's commands run with (cmdq_new_state, CMDQ_STATE_NOHOOKS): its formats and the pane
/// it is about (the tab's id and the pane), their current one.
#[derive(Clone, Debug, Default)]
pub struct HookState { pub formats: Vec<(String, String)>, pub target: Option<(String, u64)>, pub session: Option<u32>, pub made: bool }

pub type Queue = std::collections::VecDeque<Item>;

/// A command string as the queue's commands, parsed by tmux's grammar (cmdparse); its error
/// said, and nothing run, when it has one.
fn queue_of(app: &mut App, line: &str) -> Queue {
    let cmds = match crate::cmdparse::parse(line, app, false) { Ok(c) => c, Err((_, e)) => { app.error(e); return Queue::new() } };
    // cmd_parse_build_commands: aliases expanded (choose-window, splitp, your own), each command
    // found and checked before any runs.
    let aliases = app.options.array("command-alias");
    let alias = |name: &str| aliases.iter().find_map(|a| a.split_once('=').filter(|(n, _)| *n == name).map(|(_, v)| v.to_string()));
    let built = match crate::cmdparse::build(&cmds, app, None, false, &alias) { Ok(b) => b, Err((_, e)) => { app.error(e); return Queue::new() } };
    // Commands a command queues (if-shell's, a menu's) keep its mouse event, as tmux's inserted
    // items keep their state.
    built.commands.iter().map(|c| Item { words: crate::cmdparse::words(c), origin: None, mouse: app.mouse_ev.clone(), hook: app.hook_state.clone() }).collect()
}

fn run_queue(app: &mut App, mut queue: Queue) {
    // What it runs may change the server's state (server.rs looks when the loop comes round).
    app.server_dirty = true;
    while let Some(Item { words, origin, mouse, hook }) = queue.pop_front() {
        app.origin = origin;
        let saved = std::mem::replace(&mut app.mouse_ev, mouse);
        let saved_hook = std::mem::replace(&mut app.hook_state, hook.clone());
        // cmdq_add_message: each command once the config is read — the key that ran it, else
        // the client (a shell's `hn …` has none).
        if app.cfg_finished {
            let text = words.iter().map(|w| crate::tmuxconf::quote_word(w)).collect::<Vec<_>>().join(" ");
            let line = match (&app.key_run, app.capture.is_some()) { (Some(k), _) => format!("{} key {k}: {text}", crate::app::tty_name()), (None, true) => format!("command: {text}"), (None, false) => format!("{} command: {text}", crate::app::tty_name()) };
            app.add_message(line);
        }
        let job = match wait_job(app, &words).unwrap_or_else(|| shell_job(app, &words)) { Ok(j) => j, Err(e) => { app.error(e); app.origin = None; app.mouse_ev = saved; app.hook_state = saved_hook; continue } };
        let Some(Job { command, cwd, delay, background, done, wait }) = job else {
            let errors = app.errors;
            // select-pane inserts its after hook only when it actually changes the active pane.
            let selecting = words.first().and_then(|w| crate::cmd::find(w).ok()).is_some_and(|e| e.name == "select-pane");
            let focus = |app: &App| app.tabs.iter().chain(app.sessions.iter().flat_map(|s| s.tabs.iter())).map(|t| (t.id.clone(), t.focus)).collect::<Vec<_>>();
            let before_focus = selecting.then(|| focus(app));
            let pending_before = app.pending_hooks.len();
            let shell_before = app.starting_shell.clone();
            app.chain_follows = !queue.is_empty();
            // A hook about a session not in front (its own after- hook): run there.
            let there = hook.as_ref().and_then(|h| h.session).filter(|s| *s != app.session_id && app.swap_back.is_none() && app.sessions.iter().any(|x| x.id == *s && x.mirror.is_none()));
            match there {
                Some(sid) => {
                    let back = app.session_id;
                    app.swap_back = Some(back);
                    app.swap_session(sid);
                    run_words(app, &words);
                    app.swap_back = None;
                    if app.session_id != back { app.swap_session(back); }
                }
                None => run_words(app, &words),
            }
            let creates_pane = words.first().and_then(|w| crate::cmd::find(w).ok()).is_some_and(|e| matches!(e.name, "new-session" | "new-window" | "split-window"));
            let started_shell = app.starting_shell.as_ref().filter(|_| creates_pane).filter(|current| shell_before.as_ref().is_none_or(|before| !std::sync::Arc::ptr_eq(before, current))).cloned();
            // cmdq_fire_command: a command that failed fires command-error, one that did not its
            // after- hook — not a command a hook ran.
            let selected = before_focus.as_ref().is_none_or(|before| *before != focus(app));
            let mut hooks = if hook.is_none() && (app.errors != errors || selected) { command_hooks(app, &words, app.errors != errors) } else { Queue::new() };
            if words.first().and_then(|w| crate::cmd::find(w).ok()).is_some_and(|e| e.name == "new-session") {
                hooks.extend(app.pending_hooks.split_off(pending_before.min(app.pending_hooks.len())));
            }
            let made_hooks: Vec<_> = hooks.iter().filter_map(|item| item.hook.as_ref()).filter(|state| state.made).cloned().collect();
            app.origin = None;
            app.mouse_ev = saved;
            app.hook_state = saved_hook;
            // What source-file read runs next, before the rest; the hooks before that.
            if !app.insert_next.is_empty() { let mut next = std::mem::take(&mut app.insert_next); next.extend(queue); queue = next }
            if !hooks.is_empty() { let mut next = hooks; next.extend(queue); queue = next }
            // A shell on its way (new-session, new-window, split-window …): what comes after it
            // waits for its pane, as tmux's queue has the pane before the next command runs —
            // and so does the shell that ran the chain.
            if let Some(request) = started_shell.filter(|_| !queue.is_empty() || app.capture.is_some()) {
                let (tx, rx) = tokio::sync::oneshot::channel::<crate::app::ShellCompletion>();
                app.shell_waiters.push((request, tx));
                let waiting = (app.capture.take(), app.capture_err.take(), app.cli_tx.take(), app.cli_code, app.cli_cwd.clone(), app.cli_size, app.cli_stdin.take(), app.cli_outside);
                app.spawn(async move {
                    tokio::time::timeout(std::time::Duration::from_secs(90), rx).await.ok().and_then(Result::ok)
                        .unwrap_or_else(|| Err("create pane did not complete".into()))
                }, move |app, result| {
                    let (mut cap, mut err, tx, code, cwd, size, stdin, outside) = waiting;
                    let from_shell = cap.is_some();
                    let succeeded = result.is_ok();
                    let (out, errors) = match result {
                        Ok((out, (session, tab, pane))) => {
                            // Freeze this command's hooks to its own pane, including hooks that
                            // themselves suspend for run-shell or if-shell.
                            for item in &mut queue {
                                if let Some(state) = item.hook.as_mut().filter(|state| made_hooks.iter().any(|made| std::sync::Arc::ptr_eq(made, state))) {
                                    let state = std::sync::Arc::make_mut(state);
                                    state.target = Some((tab.clone(), pane)); state.session = Some(session); state.made = false;
                                }
                            }
                            (out, Vec::new())
                        }
                        Err(error) => (Vec::new(), vec![error]),
                    };
                    if from_shell {
                        cap.as_mut().unwrap().extend(out);
                        err.get_or_insert_with(Vec::new).extend(errors);
                        app.capture = cap; app.capture_err = err; app.cli_tx = tx;
                        app.cli_code = if succeeded { code } else { 1 };
                        app.cli_cwd = cwd; app.cli_size = size; app.cli_stdin = stdin; app.cli_outside = outside;
                    }
                    if succeeded { run_queue(app, queue) }
                    if from_shell && app.capture.is_some() { app.finish_cli() }
                });
                return;
            }
            continue;
        };
        app.hook_state = saved_hook;
        app.origin = None;
        // What the job chooses to run next keeps the item's mouse event — and, run by a hook, the
        // hook's state (its harness, its formats), as cmd_if_shell_callback inserts the chosen
        // commands with the item's state.
        let mouse = std::mem::replace(&mut app.mouse_ev, saved);
        let job_hook = hook.clone();
        let jenv = crate::ipc::job_environ(&app.global_env, &app.session_env);
        let run = async move {
            if let Some(w) = wait { let _ = w.await; return Outcome::default() }
            if delay > 0.0 { tokio::time::sleep(std::time::Duration::from_secs_f64(delay)).await }
            let Some(command) = command else { return Outcome::default() };
            let mut c = tokio::process::Command::new("/bin/sh");
            // tmux's job: the shell's output read, its errors to /dev/null.
            c.arg("-c").arg(&command).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            crate::ipc::set_job_env(&mut c, &jenv);
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
                let saved_hook = std::mem::replace(&mut app.hook_state, job_hook);
                let next = done(app, o);
                app.mouse_ev = saved;
                app.hook_state = saved_hook;
                if !next.is_empty() { run_queue(app, next) }
            });
            continue;
        }
        // The queue waits for it — and so does the shell that ran the command, if one did.
        let waiting = (app.capture.take(), app.capture_err.take(), app.cli_tx.take(), app.cli_code, app.cli_cwd.clone(), app.cli_size);
        app.spawn(run, move |app, o| {
            let (cap, err, tx, code, cwd, size) = waiting;
            let from_shell = cap.is_some();
            if from_shell { app.capture = cap; app.capture_err = err; app.cli_tx = tx; app.cli_code = code; app.cli_cwd = cwd; app.cli_size = size }
            // What it chose to run next (if-shell's command, run-shell -C's) goes first.
            let saved = std::mem::replace(&mut app.mouse_ev, mouse);
            let saved_hook = std::mem::replace(&mut app.hook_state, job_hook);
            let mut next = done(app, o);
            app.mouse_ev = saved;
            app.hook_state = saved_hook;
            next.extend(queue);
            run_queue(app, next);
            if from_shell && app.capture.is_some() { app.finish_cli() }
        });
        return;
    }
    // (Windows numbered after what ran — with no terminal to draw, too: renumber-windows.)
    app.renumber();
}

/// The commands a hook holds, as queue items run with [state] — each item of the hook array,
/// looked up as notify_insert_hook looks (the pane's, the window's, the session's, globally).
/// Whether hook [name] has a command set anywhere it could be looked up (globally, for the
/// session, the window [window], its pane [pane] or its active one): its formats are made only
/// then (they number a window that has no number yet).
fn hooked(app: &App, name: &str, window: Option<usize>, pane: Option<u64>) -> bool {
    let w = window.filter(|w| *w < app.tabs.len()).unwrap_or(app.active);
    let tab_id = app.tabs.get(w).map(|t| t.id.clone()).unwrap_or_default();
    let panes: Vec<Option<u64>> = [pane, app.tabs.get(w).and_then(|t| t.focus), None].into_iter().collect();
    panes.into_iter().any(|p| (0..64).any(|i| app.options.get(&format!("{name}[{i}]"), &tab_id, p).is_some()))
}

fn hook_items(app: &mut App, name: &str, target: Option<(usize, u64)>, state: HookState) -> Queue {
    let (tab_id, pane) = match target { Some((w, p)) => (app.tabs.get(w).map(|t| t.id.clone()).unwrap_or_default(), p), None => (String::new(), 0) };
    let values: Vec<String> = (0..64).filter_map(|i| app.options.get(&format!("{name}[{i}]"), &tab_id, Some(pane))).collect();
    if values.is_empty() { return Queue::new() }
    let state = std::sync::Arc::new(state);
    let mut out = Queue::new();
    for v in values {
        match crate::cmdparse::parse(&v, app, false) {
            Ok(cmds) => out.extend(cmds.iter().map(|c| Item { words: crate::cmdparse::words(c), origin: None, mouse: None, hook: Some(state.clone()) })),
            Err(_) => {}
        }
    }
    out
}

/// A command's hooks (cmdq_insert_hook): after-<command> when it did its work, command-error
/// when it failed — with #{hook}, #{hook_arguments} and the rest, about the command's pane.
fn command_hooks(app: &mut App, words: &[String], failed: bool) -> Queue {
    let Some(first) = words.first() else { return Queue::new() };
    let Ok(entry) = crate::cmd::find(first) else { return Queue::new() };
    let after = match entry.name { "next-window" | "previous-window" | "last-window" => "select-window", name => name };
    let name = if failed { "command-error".to_string() } else { format!("after-{after}") };
    if !crate::options::is_hook(&name) || name == "after-queue" { return Queue::new() }
    let args = crate::cmd::parse(entry, &crate::tmuxconf::unblock(words)).unwrap_or_default();
    if !failed && entry.name == "select-pane" && args.has('l') != 0 { return Queue::new() }
    // cmdq_insert_hook: the hook of the command's target session (its options), run about it.
    // (What a kill- command named is gone: its hook is about where you are, as tmux's.)
    let killed = matches!(entry.name, "kill-pane" | "kill-window" | "kill-session");
    // (-t naming another session — `set -t a`, `display -t a`, `list-windows -t a` — is that
    // session's, whether or not the command itself went there.)
    let named = |t: &str| target_session(app, t).or_else(|| app.find_session(t.split(':').next().unwrap_or(t)));
    let sid = if killed { None } else { other_session(app, words).or_else(|| args.get('t').and_then(named)) }
        .filter(|s| *s != app.session_id && app.swap_back.is_none() && app.sessions.iter().any(|x| x.id == *s && x.mirror.is_none()));
    let back = app.session_id;
    if let Some(sid) = sid { app.swap_back = Some(back); app.swap_session(sid); }
    // About the command's target (cmdq_insert_hook's fsp): what it made (new-window's window,
    // split-window's pane — there once the queue has waited for it), else its -t, else the
    // current pane.
    let made = matches!(entry.name, "new-window" | "split-window") && !failed;
    let by_pane = entry.target.map(|t| t.kind == crate::cmd::Kind::Pane || t.kind == crate::cmd::Kind::Window).unwrap_or(false);
    // (A session named alone — `a`, `a:` — is its current window's active pane.)
    let only_session = |t: &str| sid.is_some() && (!t.contains([':', '.']) || t.ends_with(':')) && !t.starts_with(['%', '@']);
    let target = args.get('t').filter(|t| !made && !killed && by_pane && !only_session(t)).and_then(|t| pane_target(app, t)).or_else(|| app.current());
    let mut formats = vec![("hook".to_string(), name.clone())];
    formats.extend(args.hook_formats());
    let state = HookState { formats, target: target.and_then(|(w, p)| app.tabs.get(w).map(|t| (t.id.clone(), p))), session: sid, made };
    let items = hook_items(app, &name, target, state);
    if sid.is_some() { app.swap_back = None; if app.session_id != back { app.swap_session(back); } }
    items
}

/// An event's hook (notify_add): run once the work that caused it is done, with #{hook},
/// #{hook_client}, #{hook_session}, #{hook_session_name} and — when it is about one — the
/// window's #{hook_window} and #{hook_window_name} and the pane's #{hook_pane}.
pub fn notify(app: &mut App, name: &str, window: Option<usize>, pane: Option<u64>) {
    if app.hook_state.is_some() && name.starts_with("after-") { return }
    if !hooked(app, name, window, pane) { return }
    let client = name.starts_with("client-");
    let session = (client && name != "client-detached") || matches!(name, "window-linked" | "window-unlinked");
    let mut formats = vec![
        ("hook".to_string(), name.to_string()),
        ("hook_client".to_string(), if client { crate::format::expand(app, "#{client_name}", app.active, None, false) } else { String::new() }),
        ("hook_session".to_string(), if session { format!("${}", app.session_id) } else { String::new() }),
        ("hook_session_name".to_string(), if session { app.session_name() } else { String::new() }),
    ];
    let w = window.filter(|w| *w < app.tabs.len());
    if let Some(w) = w {
        formats.push(("hook_window".to_string(), crate::format::expand(app, "#{window_id}", w, None, false)));
        formats.push(("hook_window_name".to_string(), app.tabs[w].name.clone()));
    }
    // #{hook_pane} only for an event about a pane (notify_pane); the commands' pane is the
    // window's active one otherwise.
    if let Some(p) = pane { formats.push(("hook_pane".to_string(), crate::pane::tag(p))) }
    let target = w.or(Some(app.active)).and_then(|w| pane.or(app.tabs.get(w).and_then(|t| t.focus)).map(|p| (w, p)));
    let state = HookState { formats, target: target.and_then(|(w, p)| app.tabs.get(w).map(|t| (t.id.clone(), p))), session: None, made: false };
    let items = hook_items(app, name, target, state);
    app.pending_hooks.extend(items);
}

/// An event about a session (notify_session: session-created, -closed, -renamed; with a window,
/// notify_session_window: window-linked and -unlinked of a session not in front) — its $id and
/// name, and the window's @number and name.
pub fn notify_session(app: &mut App, name: &str, sid: u32, session_name: &str, window: Option<(u64, String)>) {
    if !hooked(app, name, None, None) { return }
    let mut formats = vec![
        ("hook".to_string(), name.to_string()),
        ("hook_client".to_string(), String::new()),
        ("hook_session".to_string(), format!("${sid}")),
        ("hook_session_name".to_string(), session_name.to_string()),
    ];
    if let Some((wid, w)) = window { formats.push(("hook_window".to_string(), format!("@{wid}"))); formats.push(("hook_window_name".to_string(), w)) }
    let target = app.tabs.get(app.active).and_then(|t| t.focus).map(|p| (app.active, p));
    let state = HookState { formats, target: target.and_then(|(w, p)| app.tabs.get(w).map(|t| (t.id.clone(), p))), session: None, made: false };
    let items = hook_items(app, name, target, state);
    app.pending_hooks.extend(items);
}

/// A harness's event (harness-needs: it asks; harness-done: it ended a turn; harness-failed: an
/// error): #{hook_harness_*} say which and what, and the commands run with its pane as the target
/// when it is open here (else this one's).
pub fn notify_harness(app: &mut App, name: &str, key: &(String, String)) {
    let pane = app.find_pane(&key.0, &key.1);
    if !hooked(app, name, pane.map(|(w, _)| w), pane.map(|(_, p)| p)) { return }
    // Once per server, not once per terminal: the oldest client runs it.
    if !app.runs_agent_hooks() { return }
    let Some(a) = app.fleet.agent(&key.0, &key.1) else { return };
    let question = a.question.as_ref().map(|q| q.prompt.clone()).unwrap_or_default();
    let line = if !question.is_empty() { question.clone() } else if !a.launch_error.is_empty() { a.launch_error.clone() } else { a.did.clone().unwrap_or_default() };
    let formats = vec![
        ("hook".to_string(), name.to_string()),
        ("hook_client".to_string(), crate::format::expand(app, "#{client_name}", app.active, None, false)),
        ("hook_session".to_string(), format!("${}", app.session_id)),
        ("hook_session_name".to_string(), app.session_name()),
        ("hook_harness_name".to_string(), a.name.clone()),
        ("hook_harness_id".to_string(), format!("{}:{}", a.machine_id, a.id)),
        ("hook_harness_machine".to_string(), app.fleet.machine_name(&a.machine_id)),
        ("hook_harness_line".to_string(), line),
        ("hook_harness_question".to_string(), question),
        // A delayed hook may outlive this question. Keep its identity with the other hook
        // formats, which the command queue also carries through if-shell and run-shell.
        ("hook_harness_request".to_string(), a.question.as_ref().map(|q| q.request_id.clone()).unwrap_or_default()),
    ];
    let target = pane.or_else(|| app.focused().map(|p| (app.active, p)));
    let state = HookState { formats, target: target.and_then(|(w, p)| app.tabs.get(w).map(|t| (t.id.clone(), p))), session: None, made: false };
    let items = hook_items(app, name, target, state);
    app.pending_hooks.extend(items);
}

/// An event about a window that is gone (window-unlinked): its @number and name, as it was.
pub fn notify_gone(app: &mut App, name: &str, wid: u64, window_name: &str) {
    if !hooked(app, name, None, None) { return }
    let formats = vec![
        ("hook".to_string(), name.to_string()),
        ("hook_client".to_string(), String::new()),
        ("hook_session".to_string(), format!("${}", app.session_id)),
        ("hook_session_name".to_string(), app.session_name()),
        ("hook_window".to_string(), format!("@{wid}")),
        ("hook_window_name".to_string(), window_name.to_string()),
    ];
    let target = app.focused().map(|p| (app.active, p));
    let state = HookState { formats, target: target.and_then(|(w, p)| app.tabs.get(w).map(|t| (t.id.clone(), p))), session: None, made: false };
    let items = hook_items(app, name, target, state);
    app.pending_hooks.extend(items);
}

/// The event hooks waiting, run (from the main loop, after the event's work).
pub fn run_pending_hooks(app: &mut App) {
    // A hook's commands can raise events of their own: a few rounds, not forever.
    for _ in 0..8 {
        if app.pending_hooks.is_empty() { return }
        let q = std::mem::take(&mut app.pending_hooks);
        run_queue(app, q);
    }
    app.pending_hooks.clear();
}

/// How a job ended: tmux's exit status (128 + the signal for one killed), and what it printed.
#[derive(Default)]
struct Outcome { code: i32, signal: Option<i32>, out: String, failed: Option<String> }

/// A shell command to run, and what to do when it has: the commands to run next, first.
struct Job { command: Option<String>, cwd: Option<String>, delay: f64, background: bool, done: Box<dyn FnOnce(&mut App, Outcome) -> Queue + Send>,
    /// wait-for: what the job waits on instead of a command (the channel woken, its lock handed on).
    wait: Option<tokio::sync::oneshot::Receiver<()>> }

/// wait-for [-L | -S | -U] channel, as cmd-wait-for.c: a wait (or a lock someone holds) is a job
/// the queue — and the shell that ran it — waits on until -S wakes the channel (a -S nobody
/// waited for wakes the next wait at once) or -U hands the lock on; -S and -U are done at once.
/// None for any other command.
fn wait_job(app: &mut App, words: &[String]) -> Option<Result<Option<Job>, String>> {
    let entry = words.first().and_then(|w| crate::cmd::find(w).ok())?;
    if entry.name != "wait-for" { return None }
    let args = match crate::cmd::parse(entry, &crate::tmuxconf::unblock(words)) { Ok(a) => a, Err(e) => return Some(Err(e)) };
    let name = args.values.first().cloned().unwrap_or_default();
    // No client to wait (a config read at start): tmux's words.
    let clientless = app.origin.is_some() && app.capture.is_none() && app.key_run.is_none();
    let job = |rx| Some(Ok(Some(Job { command: None, cwd: None, delay: 0.0, background: false, done: Box::new(|_, _| Default::default()), wait: Some(rx) })));
    let ch = app.wait_channels.entry(name.clone()).or_default();
    let result = if args.has('S') > 0 {
        if ch.waiters.is_empty() { ch.woken = true } else { for w in ch.waiters.drain(..) { let _ = w.send(()); } }
        Some(Ok(None))
    } else if args.has('L') > 0 {
        if clientless { return Some(Err("not able to lock".into())) }
        if !ch.locked { ch.locked = true; Some(Ok(None)) } else { let (tx, rx) = tokio::sync::oneshot::channel(); ch.lockers.push_back(tx); job(rx) }
    } else if args.has('U') > 0 {
        if !ch.locked { Some(Err(format!("channel {name} not locked"))) }
        else { match ch.lockers.pop_front() { Some(next) => { let _ = next.send(()); } None => ch.locked = false } Some(Ok(None)) }
    } else {
        if clientless { return Some(Err("not able to wait".into())) }
        if ch.woken { ch.woken = false; Some(Ok(None)) } else { let (tx, rx) = tokio::sync::oneshot::channel(); ch.waiters.push(tx); job(rx) }
    };
    if app.wait_channels.get(&name).map(|c| !c.woken && !c.locked && c.waiters.is_empty() && c.lockers.is_empty()).unwrap_or(false) { app.wait_channels.remove(&name); }
    result
}

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
            }), wait: None }))
        }
        _ => {
            let delay = match args.get('d') { Some(d) => d.trim().parse::<f64>().map_err(|_| format!("invalid delay time: {d}"))?, None => 0.0 };
            if args.get('d').is_none() && args.values.is_empty() { return Ok(Some(Job { command: None, cwd: None, delay: 0.0, background: true, done: Box::new(|_, _| Default::default()), wait: None })) }
            if args.has('C') > 0 {
                // -C: after the delay, the argument runs as tmux commands.
                let c = args.values.first().cloned();
                return Ok(Some(Job { command: None, cwd: None, delay, background, done: Box::new(move |app, _| c.map(|c| queue_of(app, &c)).unwrap_or_default()), wait: None }));
            }
            let command = args.values.first().map(|c| expand(c));
            let shown = command.clone().unwrap_or_default();
            // -t: its output goes to that pane's view mode, whoever asked (cmd_run_shell_print).
            let into = p.filter(|_| args.get('t').is_some());
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
                if !lines.is_empty() {
                    // Waited for, it prints to the client as any command does; with -b, into the
                    // pane's view mode with its escapes read (cmd_run_shell_print).
                    if into.is_some_and(|pane| crate::copy::print_to(app, pane, &lines, true)) {}
                    else if background && app.capture.is_none() && crate::copy::print(app, &lines, true) {} else { app.print("run-shell", lines) }
                }
                Default::default()
            }), wait: None }))
        }
    }
}

/// args_make_commands: answers into a template, run. A `{ }` block was parsed when it was bound,
/// so each answer goes into its parsed arguments as they stand (cmd_list_copy) and is never read
/// as tmux syntax again — `\[ERROR\]`, `a"b` and `~/src` stay as typed; a string template is
/// filled, then parsed, as tmux parses it.
pub fn execute_template(app: &mut App, template: &str, answers: &[String]) {
    let fill = |s: &str| answers.iter().enumerate().fold(s.to_string(), |cmd, (i, a)| template_replace(&cmd, a, i + 1));
    match template.strip_prefix(crate::tmuxconf::BLOCK) {
        Some(block) => {
            let cmds = match crate::cmdparse::parse(block, app, false) { Ok(c) => c, Err((_, e)) => return app.error(e) };
            let q: Queue = cmds.iter().map(|c| Item { words: crate::cmdparse::words(c).iter().map(|w| fill(w)).collect(), origin: None, mouse: app.mouse_ev.clone(), hook: app.hook_state.clone() }).collect();
            run_queue(app, q);
        }
        None => { let command = fill(template); if !command.trim().is_empty() { execute(app, &command) } }
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
    // A folder reads as nothing, and nothing is said (tmux's file_read of one).
    if std::fs::metadata(file).map(|m| m.is_dir()).unwrap_or(false) { return source_text(app, file, "", parse_only, verbose) }
    let text = std::fs::read_to_string(file).map_err(|e| format!("{file}: {}", match e.kind() {
        std::io::ErrorKind::NotFound => "No such file or directory".to_string(),
        std::io::ErrorKind::PermissionDenied => "Permission denied".to_string(),
        _ => e.to_string(),
    }))?;
    source_text(app, file, &text, parse_only, verbose)
}

/// A file source-file could not read is an error; one that does not parse is a cause, which
/// tmux prints (cfg_print_causes: into view mode for a terminal, the shell's output otherwise —
/// which then exits 1).
fn config_cause(app: &mut App, file: &str, e: String) {
    let parse = e.strip_prefix(&format!("{file}:")).map(|r| r.starts_with(|c: char| c.is_ascii_digit())).unwrap_or(false);
    if !parse { return app.error(e) }
    if app.capture.is_some() { app.cli_code = 1 }
    app.print("source-file", vec![e]);
}

/// The standard input's names: what a shell pipes in, never hn's own terminal.
pub fn is_stdin(path: &str) -> bool { matches!(path, "-" | "/dev/stdin" | "/dev/fd/0") }

/// The standard output's (and error's) names: the shell's, the command's output.
fn is_stdout(path: &str) -> bool { matches!(path, "-" | "/dev/stdout" | "/dev/fd/1" | "/dev/stderr" | "/dev/fd/2") }

/// source's second half: [text] read as a config file called [file].
pub fn source_text(app: &mut App, file: &str, text: &str, parse_only: bool, verbose: bool) -> Result<Queue, String> {
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
    Ok(built.commands.iter().map(|c| Item { words: crate::cmdparse::words(c), origin: Some((origin.clone(), c.line)), mouse: None, hook: None }).collect())
}

/// The config at start, as tmux reads it: ~/.tmux.conf and the XDG ones that exist (or -f's);
/// a missing one is no error. Its commands then run in order.
pub fn load_config(app: &mut App) -> Vec<String> {
    let files = crate::tmuxconf::files();
    let (mut queue, mut read) = (Queue::new(), Vec::new());
    for file in files {
        match source(app, &file, false, false) {
            Ok(items) => { queue.extend(items); read.push(file) }
            // load_cfg: a file that does not parse is a cause, and none of it runs.
            Err(e) => { app.config_causes.push(e); read.push(file) }
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
fn positional(words: &Words) -> Vec<String> { positional_with(words, "tcdFlnpsxyTIeNPb") }

/// positional, where only the flags in [valued] take a value (hn's harness verbs: -t; their -l
/// and -y are flags alone).
fn positional_with(words: &Words, valued: &str) -> Vec<String> {
    if let Some(a) = &words.args { return a.values.clone() }
    let mut out = Vec::new();
    let mut i = 1;
    while i < words.len() {
        let w = &words[i];
        if out.is_empty() && w.starts_with('-') && w.len() > 1 && w.parse::<f64>().is_err() {
            if w == "--" { out.extend(words[i + 1..].iter().cloned()); break }
            // A flag that takes a value, last in its cluster, takes the next word.
            if w.len() == 2 && valued.contains(&w[1..]) { i += 1 }
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

/// A command that names another session (`-t work:2`, `has-session -t work`, a pane's `%12`)
/// runs in it, as tmux's commands act on any session: that session in front while it runs, the
/// one on screen back after.
fn run_words(app: &mut App, words: &[String]) {
    // A command for another terminal (-c its tty, or -t where the target is a client): run there.
    if let Some(tty) = other_client_target(words) { return to_client(app, &tty, words) }
    let words = &session_targets(app, words);
    if cross_session(app, words) { return }
    match other_session(app, words).or_else(|| best_session(app, words)) {
        Some(id) if app.swap_back.is_none() => {
            // Another client's session: the command runs in that client, its output here.
            if let Some(owner) = app.remote_owner(id) { return forward(app, &owner, words) }
            let back = app.session_id;
            app.swap_back = Some(back);
            app.swap_session(id);
            run_words_in(app, words);
            // Its windows numbered as that session's options say (renumber-windows) before it
            // goes back aside.
            app.renumber();
            app.swap_back = None;
            if app.session_id != back { app.swap_session(back); }
            app.fit_panes();
            app.save_sessions();
        }
        _ => {
            // The session in front is another client's (shown here as it has it): done there.
            if crate::mirror::route(app, words) { return }
            run_words_in(app, words)
        }
    }
}

/// What follows an option set (its value now [now]; [global]: -g, else for window [tab]): what
/// hn keeps outside the store — the prefix, the mouse, a window's synchronize-panes …
fn after_set(app: &mut App, name: &str, now: Option<String>, global: bool, tab: Option<usize>) {
    let name = name.to_string();
    if name == "@hn-look" { app.redraw_all = true; app.fit_panes(); app.push_theme(); }
    // (Set by hand too — `set -g @hn-theme …`, `@hn-lists fzf`: the colours and lists follow.)
    if matches!(name.as_str(), "@hn-accent" | "@hn-theme" | "@hn-lists") { app.sync_accent(); app.redraw_all = true }
    // (The bar down a side and the pane frames change the panes' room.)
    if matches!(name.as_str(), "@hn-status-bar" | "@hn-border" | "@hn-focus") { app.redraw_all = true; app.fit_panes(); }
    if name == "@hn-dim" { app.redraw_all = true }
    // alerts_reset_all: every window's silence timer starts again.
    if name == "monitor-silence" { for t in app.tabs.iter_mut() { t.last_output = std::time::Instant::now() } }
    if name.starts_with('@') && now.is_none() { app.opts.user.remove(&name); return }
    // synchronize-panes belongs to a window: this one, or (-g) every window without its own.
    if name == "synchronize-panes" {
        let on = now.as_deref() == Some("on");
        if global { for i in 0..app.tabs.len() { let id = app.tabs[i].id.clone(); if !app.options.windows.get(&id).map(|m| m.contains_key(&name)).unwrap_or(false) { app.tabs[i].sync = on } } }
        else if let Some(tab) = tab.filter(|t| *t < app.tabs.len()) { app.tabs[tab].sync = on }
        return;
    }
    // An array is read where it is used (command-alias, update-environment …): nothing of
    // hn's own follows it, and setting it again with its last item would replace it.
    if name.contains('[') || crate::options::find(&name).map(|o| o.array).unwrap_or(false) { return }
    // What hn keeps outside the options (the prefix, the mouse, the history limit …)
    // follows a global value; the options themselves are in the store already, where the
    // flags put them — a window's own stays that window's.
    let scope = crate::options::find(&name).map(|o| o.scope);
    if !global && matches!(scope, Some(crate::options::Scope::Window | crate::options::Scope::Pane)) { app.redraw_all = true; return }
    let mut settings = crate::tmuxconf::Settings::default();
    let words = vec!["set".to_string(), "-g".to_string(), name, now.unwrap_or_default()];
    match crate::tmuxconf::directive(&words, &mut app.keymap, &mut settings) {
        Ok(()) => { settings.options.store = Default::default(); app.apply_settings(&settings) }
        Err(e) => app.error(e),
    }
}

/// A global or server option another client of the server changed (server.rs): what follows
/// its value now in force.
pub fn option_changed(app: &mut App, name: &str) {
    // A hook's command (after-new-window[0]) is read when the hook fires.
    if crate::options::is_hook(name.split('[').next().unwrap_or(name)) { return }
    let now = app.options.get(name, "", None);
    after_set(app, name, now, true, None);
}

/// The harness a harness-* hook is about (#{hook_harness_id}), in one.
fn hook_harness(app: &App) -> Option<(String, String)> {
    let id = app.hook_state.as_ref()?.formats.iter().find(|(k, _)| k == "hook_harness_id")?.1.clone();
    let (m, a) = id.split_once(':')?;
    Some((m.to_string(), a.to_string()))
}

/// A target that is a format (`-t "#{hook_harness_id}"`): expanded first.
fn expand_target(app: &App, t: &str) -> String { if t.contains("#{") { expand(app, t) } else { t.to_string() } }

/// The harness hn's harness commands mean: -t's (a format expanded), else the hook's in a
/// harness-* hook; none said.
fn harness_target(app: &App, words: &Words) -> Result<Option<(String, String)>, String> {
    match opt(words, "-t") {
        Some(t) => find_harness(app, &expand_target(app, &t)).map(Some),
        None => Ok(hook_harness(app)),
    }
}

/// A harness a command names: `machine:agent` (the machine by id or name) or its id, a pane that
/// shows it (%N, a:1.0), or its name — exact, else the only one it starts, else the only one it
/// matches as a pattern.
fn find_harness(app: &App, t: &str) -> Result<(String, String), String> {
    if let Some((m, a)) = t.split_once(':') {
        if app.fleet.agent(m, a).is_some() { return Ok((m.to_string(), a.to_string())) }
        if let Some(machine) = app.fleet.machines.iter().find(|x| app.fleet.machine_name(&x.id) == m && app.fleet.agent(&x.id, a).is_some()) { return Ok((machine.id.clone(), a.to_string())) }
    }
    if let Some(a) = app.fleet.agents.values().find(|a| a.id == t) { return Ok(a.key()) }
    if t.starts_with('%') || t.contains([':', '.']) {
        if let Some(p) = pane_target(app, t).and_then(|(_, p)| app.panes.get(&p)) { return Ok((p.machine_id.clone(), p.agent_id.clone())) }
    }
    let one = |hits: Vec<(String, String)>| -> Option<Result<(String, String), String>> {
        match hits.len() { 0 => None, 1 => Some(Ok(hits[0].clone())), _ => Some(Err(format!("more than one harness: {t}"))) }
    };
    let agents: Vec<&crate::fleet::Agent> = app.fleet.agents.values().collect();
    if let Some(r) = one(agents.iter().filter(|a| a.name == t).map(|a| a.key()).collect()) { return r }
    if let Some(r) = one(agents.iter().filter(|a| a.name.starts_with(t)).map(|a| a.key()).collect()) { return r }
    if let Some(r) = one(agents.iter().filter(|a| crate::cmd::fnmatch(t, &a.name)).map(|a| a.key()).collect()) { return r }
    // Nothing to look in: say why.
    if app.link(&app.fleet.local_id).is_none() { return Err("the daemon is not running (harness start)".into()) }
    Err(format!("can't find harness: {t}"))
}

/// The client a command names that is not this one: display-message -c, switch-client -c,
/// display-menu -c, display-popup -c; refresh-client -t, show-messages -t, display-panes -t,
/// command-prompt -t, confirm-before -t (by its tty, `/dev/` or not).
fn other_client_target(words: &[String]) -> Option<String> {
    let entry = crate::cmd::find(words.first()?).ok()?;
    let flag = match entry.name {
        "display-message" | "switch-client" | "display-menu" | "display-popup" | "send-keys" => 'c',
        "refresh-client" | "show-messages" | "display-panes" | "command-prompt" | "confirm-before" | "lock-client" | "suspend-client" => 't',
        _ => return None,
    };
    let args = crate::cmd::parse(entry, &crate::tmuxconf::unblock(words)).ok()?;
    let t = args.get(flag)?.trim_end_matches(':').to_string();
    let me = crate::app::tty_name();
    let bare = |s: &str| s.trim_start_matches("/dev/").to_string();
    (bare(&t) != bare(&me)).then_some(t)
}

/// A command for the client whose tty is [tty]: run by it, its output here; tmux's error when no
/// client of this server name has that tty.
fn to_client(app: &mut App, tty: &str, words: &[String]) {
    let bare = |s: &str| s.trim_start_matches("/dev/").to_string();
    for other in other_clients() {
        let Some((out, _, _)) = crate::ipc::ask(&other, &["hn-list-clients".into(), "-F".into(), "#{client_tty}".into()]) else { continue };
        if out.iter().any(|l| bare(l) == bare(tty)) { return forward(app, &other.display().to_string(), words) }
    }
    // send-keys declares CMD_CLIENT_CANFAIL: no matching client means no injected keys.
    if words.first().and_then(|w| crate::cmd::find(w).ok()).is_some_and(|e| e.name == "send-keys") { return }
    app.error(format!("can't find client: {tty}"))
}

/// The options commands' error for a -t they can't find (cmd-set-option.c): `no such session`,
/// `no such window` or `no such pane`, as the flags (or the option's own scope) say.
fn no_such(f: &crate::options::SetFlags, name: Option<&str>, t: &str) -> String {
    let window_option = name.and_then(|n| crate::options::find(n.split('[').next().unwrap_or(n))).map(|o| matches!(o.scope, crate::options::Scope::Window | crate::options::Scope::Pane)).unwrap_or(false);
    let scope = if f.pane { "pane" } else if f.window || window_option { "window" } else { "session" };
    format!("no such {scope}: {t}")
}

/// The other running clients of this server name (-L): their sockets.
pub fn other_clients() -> Vec<std::path::PathBuf> {
    let me = crate::ipc::here();
    let name = std::env::var("HN_SOCKET_NAME").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "default".into());
    crate::ipc::clients_of(&name).into_iter().filter(|c| Some(c) != me.as_ref()).collect()
}

/// A command for a session another client has, run by that client: what it prints printed here,
/// its errors said here, its status this command's.
pub fn forward(app: &mut App, owner: &str, words: &[String]) {
    // Passed here by another client already: the two sessions are in two terminals.
    if crate::ipc::forwarded() { return app.error("can't do that across terminals: the sessions are in two") }
    let size = if app.capture.is_some() { app.cli_size } else if !app.headless { let b = app.body(); Some((b.width, b.height)) } else { None };
    match crate::ipc::ask_with_size(std::path::Path::new(owner), words, size) {
        Some((out, err, code)) => {
            if !out.is_empty() { app.print(&words[0], out) }
            for e in err { app.error(e) }
            if code != 0 { app.cli_code = code }
        }
        None => app.error(format!("no client at {owner}")),
    }
}

/// cmd_find_get_window / cmd_find_get_pane's last try: a bare word (`-t main`) that is no window
/// (or pane) of the session in front but names a session is that session's current window (its
/// active pane) — written `main:` so the command finds it there.
fn session_targets(app: &App, words: &[String]) -> Vec<String> {
    let Some(entry) = words.first().and_then(|w| crate::cmd::find(w).ok()) else { return words.to_vec() };
    let Ok(args) = crate::cmd::parse(entry, &crate::tmuxconf::unblock(words)) else { return words.to_vec() };
    let mut out = words.to_vec();
    for (spec, flag) in [(entry.target, 't'), (entry.source, 's')] {
        let (Some(spec), Some(t)) = (spec, args.get(flag)) else { continue };
        if spec.kind == crate::cmd::Kind::Session || t.is_empty() || t.contains([':', '.']) || t.starts_with(['%', '@', '$', '{', '!', '+', '-', '~', '^']) { continue }
        // `=`: an exact window; the session tried after is the rest, not exact (cmd_find_target
        // strips it from a window, never from a pane — `=web` is no pane's).
        let bare = match t.strip_prefix('=') { Some(_) if spec.kind == crate::cmd::Kind::Pane => continue, Some(b) => b, None => t };
        if crate::cmd::resolve(app, Some(t), spec).is_ok() || app.find_session(bare).is_none() { continue }
        // The word itself, where it stands (`-tmain` or `-t main`).
        let want = format!("-{flag}");
        if let Some(i) = out.iter().position(|w| *w == want).filter(|i| out.get(i + 1).map(|v| v == t).unwrap_or(false)) { out[i + 1] = format!("{bare}:") }
        else if let Some(i) = out.iter().position(|w| *w == format!("{want}{t}")) { out[i] = format!("{want}{bare}:") }
    }
    out
}

/// The session a target names, when it names one: `sess:…`, `$N`, a `%pane`'s or an `@window`'s.
fn target_session(app: &App, t: &str) -> Option<u32> {
    if let Some(p) = t.strip_prefix('%') { return crate::pane::from_tag(p.split(['.', ':']).next().unwrap_or("")).and_then(|p| app.session_of_pane(p).or_else(|| app.remote_session_of(Some(p), None))) }
    if let Some(w) = t.strip_prefix('@') { return w.split(['.', ':']).next().and_then(|n| n.parse().ok()).and_then(|w| app.session_of_window(w).or_else(|| app.remote_session_of(None, Some(w)))) }
    if let Some((s, _)) = t.split_once(':') { return (!s.is_empty()).then(|| app.find_session(s)).flatten() }
    if t.starts_with('$') { return app.find_session(t) }
    None
}

/// move-window, swap-window, join-pane (move-pane) and break-pane whose -s and -t are in two
/// sessions, as tmux's winlinks go anywhere: what -s names leaves its session for the target's,
/// and the command runs there; a session it leaves with no window is gone. True when it was one.
fn cross_session(app: &mut App, words: &[String]) -> bool {
    let Some(entry) = words.first().and_then(|w| crate::cmd::find(w).ok()) else { return false };
    if !matches!(entry.name, "move-window" | "link-window" | "swap-window" | "join-pane" | "move-pane" | "break-pane" | "swap-pane") || app.swap_back.is_some() { return false }
    // swap-pane -U/-D stay in the target's window.
    if entry.name == "swap-pane" && (words.iter().any(|w| w == "-U" || w == "-D")) { return false }
    let Ok(args) = crate::cmd::parse(entry, &crate::tmuxconf::unblock(words)) else { return false };
    // move-window -r only renumbers -t's session: nothing moves.
    if entry.name == "move-window" && args.has('r') > 0 { return false }
    let back = app.session_id;
    let (src_t, dst_t) = (args.get('s').map(str::to_string), args.get('t').map(str::to_string));
    let src = src_t.as_deref().and_then(|t| target_session(app, t)).unwrap_or(back);
    let dst = dst_t.as_deref().and_then(|t| target_session(app, t)).unwrap_or(back);
    if src == dst { return false }
    // A -t that names nothing (no session, and nothing here): its error, and nothing moved.
    if let (Some(t), None) = (dst_t.as_deref(), dst_t.as_deref().and_then(|t| target_session(app, t))) {
        // (move-window finds its -t itself, as a window index: cmd-move-window.c.)
        let spec = entry.target.unwrap_or(crate::cmd::Spec { kind: crate::cmd::Kind::Window, can_fail: false, window_index: true, default_marked: false });
        if let Err(e) = crate::cmd::resolve(app, Some(t), spec) { app.error(e); return true }
    }
    let name_of = |app: &App, id: u32| app.session_list().into_iter().find(|(i, _)| *i == id).map(|(_, n)| n).unwrap_or_default();
    // move-window between two terminals' sessions: the window goes from the client that has it
    // to the one that has the other session (its harnesses running on, its shells that client's).
    // server_link_window: not between two sessions of one group (they have the same windows).
    if matches!(entry.name, "move-window" | "link-window") && app.group_of(src).is_some() && app.group_of(src) == app.group_of(dst) { app.error("sessions are grouped"); return true }
    if entry.name == "swap-window" && app.group_of(src).is_some() && app.group_of(src) == app.group_of(dst) { app.error("can't move window, sessions are grouped"); return true }
    if entry.name == "link-window" && (app.remote_owner(src).is_some() || app.remote_owner(dst).is_some()) { app.error("can't link a window between two clients' sessions"); return true }
    if entry.name == "move-window" && app.remote_owner(src).is_some() != app.remote_owner(dst).is_some() {
        let detached = args.has('d') > 0;
        if let Some(owner) = app.remote_owner(dst) {
            let src_target = src_t.clone().unwrap_or_else(|| format!("={}:", name_of(app, src)));
            let dst_target = dst_t.clone().unwrap_or_else(|| format!("={}:", name_of(app, dst)));
            give_window(app, src, &src_target, &owner, &dst_target, detached);
        } else if let Some(owner) = app.remote_owner(src) {
            let src_target = src_t.clone().unwrap_or_default();
            let dst_target = dst_t.clone().unwrap_or_else(|| format!("={}:", name_of(app, dst)));
            take_window(app, &owner, &src_target, dst, &dst_target, detached);
        }
        return true;
    }
    for s in [src, dst] { if app.remote_owner(s).is_some() { app.error(format!("session {} is another client's", name_of(app, s))); return true } }
    // A word's value replaced (-s: what moved, where it is now).
    let with = |words: &[String], flag: &str, value: String| -> Vec<String> {
        let mut w: Vec<String> = words.iter().filter(|x| !x.starts_with(flag) || x.as_str() == flag).cloned().collect();
        match w.iter().position(|x| x == flag) { Some(i) if i + 1 < w.len() => w[i + 1] = value, _ => { w.push(flag.to_string()); w.push(value) } }
        w
    };
    let detached = args.has('d') > 0;
    // Its windows before, for the hooks after (window-linked where one came, session-window-
    // changed where the current one changed, window-unlinked where one went).
    let (src_before, _) = app.windows_of(src);
    let (dst_before, dst_current) = app.windows_of(dst);
    let name_of_session = |app: &App, id: u32| app.session_list().into_iter().find(|(i, _)| *i == id).map(|(_, n)| n).unwrap_or_default();
    let (src_name, dst_name) = (name_of_session(app, src), name_of_session(app, dst));
    app.swap_back = Some(back);
    let result: Result<(), String> = (|| {
        app.swap_session(src);
        match entry.name {
            "move-window" | "link-window" => {
                let i = match src_t.as_deref() { Some(t) => window_target(app, t).ok_or_else(|| format!("can't find window: {t}"))?, None => app.active };
                // server_link_window: an index -t names that is taken (without -k) is an error
                // before anything moves.
                if args.has('k') == 0 && args.has('a') == 0 && args.has('b') == 0 {
                    app.swap_session(dst);
                    let spec = crate::cmd::Spec { kind: crate::cmd::Kind::Window, can_fail: false, window_index: true, default_marked: false };
                    let taken = crate::cmd::resolve(app, dst_t.as_deref(), spec).ok().and_then(|f| f.idx).filter(|n| app.tab_by_num(*n).is_some());
                    app.swap_session(src);
                    if let Some(n) = taken { return Err(format!("index in use: {n}")) }
                }
                // link-window: the same window in both (its copy here, its alerts its own).
                let link = entry.name == "link-window";
                let tab = if link { let mut t = app.tabs[i].clone(); t.alerts = 0; t } else { app.take_tab(i) };
                let wid = tab.wid();
                app.swap_session(dst);
                if link && app.tabs.iter().any(|t| t.id == tab.id) { return Err("window is already linked to that session".into()) }
                app.put_tab(tab, None);
                // (Then placed there as move-window places it: -t's number, -a/-b, -k, -d.)
                let mut there = with(words, "-s", format!("@{wid}"));
                there[0] = "move-window".into();
                run_words_in(app, &there);
                // Its number, if the move there failed (the index taken): the first free one.
                if let Some(w) = app.tabs.iter().position(|t| t.is_wid(wid)) {
                    let id = app.tabs[w].id.clone();
                    if app.nums.get(&id).copied() == Some(usize::MAX / 2) { app.nums.remove(&id); app.renumber() }
                }
            }
            "swap-window" => {
                // Each window takes the other's number (its winlink): what tmux keeps on the
                // winlink stays with the number — which one is current, where it is in the last
                // windows (the - flag), its alerts. -d selects the swapped numbers instead, as
                // cmd-swap-window.c's session_select does (whatever its manual says).
                let i = match src_t.as_deref() { Some(t) => window_target(app, t).ok_or_else(|| format!("can't find window: {t}"))?, None => app.active };
                let (na, cur_src) = (app.win_num(i), app.win_num(app.active));
                let last_src = app.lastw.iter().position(|x| *x == app.tabs[i].id);
                let mut a = app.take_tab(i);
                app.swap_session(dst);
                let j = match dst_t.as_deref() { Some(t) => window_target(app, t).ok_or_else(|| format!("can't find window: {t}"))?, None => app.active };
                let (nb, cur_dst) = (app.win_num(j), app.win_num(app.active));
                let last_dst = app.lastw.iter().position(|x| *x == app.tabs[j].id);
                let mut b = app.take_tab(j);
                std::mem::swap(&mut a.alerts, &mut b.alerts);
                let (a_id, b_id) = (a.id.clone(), b.id.clone());
                // The current number kept (the window swapped in shown, if it was that one); -d:
                // the swapped number chosen, the one it leaves the last window.
                let current = |app: &mut App, keep: usize, choose: Option<usize>| {
                    if let Some(at) = app.tab_by_num(keep) { app.active = at }
                    if let Some(at) = choose.and_then(|n| app.tab_by_num(n)).filter(|at| *at != app.active) { app.select_tab(at) }
                };
                app.put_tab(a, Some((j, nb)));
                if let Some(k) = last_dst { let k = k.min(app.lastw.len()); app.lastw.insert(k, a_id) }
                current(app, cur_dst, detached.then_some(nb));
                app.swap_session(src);
                app.put_tab(b, Some((i, na)));
                if let Some(k) = last_src { let k = k.min(app.lastw.len()); app.lastw.insert(k, b_id) }
                current(app, cur_src, detached.then_some(na));
            }
            "swap-pane" => {
                // Each pane in the other's place (cmd-swap-pane.c across two windows): its cell,
                // its point; active in both unless -d.
                let keep_zoom = args.has('Z') > 0;
                let (sw, sp) = match src_t.as_deref() { Some(t) => pane_target(app, t).ok_or_else(|| format!("can't find pane: {t}"))?, None => pane_target(app, "{marked}").or_else(|| app.current()).ok_or("can't find pane")? };
                let spoint = app.tabs[sw].points.remove(&sp);
                app.swap_session(dst);
                let (dw, dp) = match dst_t.as_deref() { Some(t) => pane_target(app, t).ok_or_else(|| format!("can't find pane: {t}"))?, None => app.current().ok_or("can't find pane")? };
                let dpoint = app.tabs[dw].points.remove(&dp);
                let dtab = app.tabs[dw].id.clone();
                if let Some((m, a)) = app.panes.get(&dp).map(|x| (x.machine_id.clone(), x.agent_id.clone())) { app.desk_op(serde_json::json!({ "op": "pane.remove", "tabId": dtab, "machineId": m, "agentId": a })) }
                app.pane_in_place(dw, dp, sp, spoint, detached, keep_zoom);
                app.swap_session(src);
                let stab = app.tabs[sw].id.clone();
                if let Some((m, a)) = app.panes.get(&sp).map(|x| (x.machine_id.clone(), x.agent_id.clone())) { app.desk_op(serde_json::json!({ "op": "pane.remove", "tabId": stab, "machineId": m, "agentId": a })) }
                app.pane_in_place(sw, sp, dp, dpoint, detached, keep_zoom);
                app.sync_titles();
            }
            "join-pane" | "move-pane" => {
                let (_, p) = match src_t.as_deref() { Some(t) => pane_target(app, t).ok_or_else(|| format!("can't find pane: {t}"))?, None => pane_target(app, "{marked}").or_else(|| app.current()).ok_or("can't find pane")? };
                app.take_pane(p);
                app.swap_session(dst);
                app.tab_of_pane(p, "");
                run_words_in(app, &with(words, "-s", crate::pane::tag(p)));
            }
            _ => {
                // break-pane: a window of its own there, at -t's number or the first free one,
                // named -n or for its harness.
                let (sw, p) = match src_t.as_deref() { Some(t) => pane_target(app, t).ok_or_else(|| format!("can't find pane: {t}"))?, None => app.current().ok_or("can't find pane")? };
                let spec = crate::cmd::Spec { kind: crate::cmd::Kind::Window, can_fail: false, window_index: true, default_marked: false };
                // A window of one pane moves whole, its id and name kept (server_link_window).
                if app.tabs[sw].panes().len() == 1 {
                    let tab = app.take_tab(sw);
                    app.swap_session(dst);
                    let at = app.put_tab(tab, None);
                    if let Some(n) = args.get('n') { app.name_window(at, n) }
                    let idx = crate::cmd::resolve(app, dst_t.as_deref(), spec).ok().and_then(|f| f.idx);
                    return app.move_window(at, idx, false, !detached);
                }
                let label = args.get('n').map(str::to_string).or_else(|| app.panes.get(&p).and_then(|x| app.fleet.agent(&x.machine_id, &x.agent_id)).map(|a| a.name.clone())).unwrap_or_else(|| "tab".into());
                app.take_pane(p);
                app.swap_session(dst);
                let w = app.tab_of_pane(p, &label);
                if args.get('n').is_some() { app.tabs[w].named = true }
                // Named as tmux names it (automatic-rename: a shell by what runs in it).
                app.sync_titles();
                let spec = crate::cmd::Spec { kind: crate::cmd::Kind::Window, can_fail: false, window_index: true, default_marked: false };
                let idx = crate::cmd::resolve(app, dst_t.as_deref(), spec).ok().and_then(|f| f.idx);
                app.move_window(w, idx, false, !detached)?;
            }
        }
        Ok(())
    })();
    if let Err(e) = result { app.error(e) }
    // server_link_window then server_unlink_window: linked in the one it went to (its current
    // window changed, unless -d), then unlinked from the one it left.
    let (src_after, _) = app.windows_of(src);
    let (dst_after, dst_now) = app.windows_of(dst);
    for (wid, w) in dst_after.iter().filter(|(wid, _)| !dst_before.iter().any(|(b, _)| b == wid)) { notify_session(app, "window-linked", dst, &dst_name, Some((*wid, w.clone()))) }
    if dst_now != dst_current && dst_current.is_some() { notify_session(app, "session-window-changed", dst, &dst_name, None) }
    for (wid, w) in src_before.iter().filter(|(wid, _)| !src_after.iter().any(|(a, _)| a == wid)) { notify_session(app, "window-unlinked", src, &src_name, Some((*wid, w.clone()))) }
    // The session it left, if that has no window now: gone (the client's own: detach-on-destroy).
    if app.swap_session(src) && !app.has_windows() && !app.session_desk {
        app.swap_back = (src != back).then_some(back);
        app.session_gone();
    }
    if app.session_id != back && !app.quit { app.swap_session(back); }
    app.swap_back = None;
    app.fit_panes();
    app.save_sessions();
    // (Said above, in tmux's order: not again when the hooks next look.)
    app.hooks_seen_now();
    true
}

/// A window's session name and number from a target (`=a:1`, `a:1`, `a:`): the session this
/// client has, and the window's place in it (its current one without a number).
fn window_of_target(app: &mut App, target: &str) -> Result<(u32, usize), String> {
    let (s, w) = target.split_once(':').unwrap_or((target, ""));
    let sid = app.find_session(s).ok_or_else(|| format!("can't find session: {}", s.trim_start_matches('=')))?;
    let back = app.session_id;
    if sid != back { app.swap_back = Some(back); app.swap_session(sid); }
    let found = if w.is_empty() { Some(app.active) } else { window_target(app, &format!(":{w}")) };
    if sid != back { app.swap_session(back); app.swap_back = None; }
    found.map(|i| (sid, i)).ok_or_else(|| format!("can't find window: {target}"))
}

/// move-window to a session another client has: this client's window, described, put there by
/// that client; gone from here once it is (its harnesses left running, its shells that
/// client's now).
fn give_window(app: &mut App, src: u32, src_target: &str, owner: &str, dst_target: &str, detached: bool) {
    let (sid, i) = match window_of_target(app, src_target) { Ok(x) => x, Err(e) => return app.error(e) };
    let back = app.session_id;
    if sid != back { app.swap_back = Some(back); app.swap_session(sid); }
    let win = app.window_json(&app.tabs[i], None);
    let mut ask = vec!["hn-put-window".to_string(), "-t".into(), dst_target.to_string(), "-j".into(), win.to_string()];
    if detached { ask.push("-d".into()) }
    match crate::ipc::ask(std::path::Path::new(owner), &ask) {
        Some((_, err, 0)) => {
            let (sname, wid, wname) = (app.session_name(), app.tabs[i].wid(), app.tabs[i].name.clone());
            let tab = app.take_tab(i);
            for p in tab.panes() {
                if let Some(k) = app.panes.get(&p).map(|x| (x.machine_id.clone(), x.agent_id.clone())) { app.shells.remove(&k); }
                app.forget_pane(p);
            }
            notify_session(app, "window-unlinked", sid, &sname, Some((wid, wname)));
            for e in err { app.error(e) }
        }
        Some((_, err, _)) => { for e in err { app.error(e) } }
        None => app.error(format!("no client at {owner}")),
    }
    // The session it left, with no window now: gone (the client's own: detach-on-destroy).
    if !app.has_windows() && !app.session_desk && app.tabs.iter().all(|t| t.root.is_none()) {
        app.swap_back = (sid != back).then_some(back);
        app.session_gone();
    }
    if app.session_id != back && !app.quit { app.swap_session(back); }
    app.swap_back = None;
    let _ = src;
    app.fit_panes();
    app.save_sessions();
}

/// move-window from a session another client has: that client gives the window up, described,
/// and it is put here.
fn take_window(app: &mut App, owner: &str, src_target: &str, dst: u32, dst_target: &str, detached: bool) {
    let Some((out, err, code)) = crate::ipc::ask(std::path::Path::new(owner), &["hn-take-window".into(), "-s".into(), src_target.to_string()]) else { return app.error(format!("no client at {owner}")) };
    if code != 0 { for e in err { app.error(e) } return }
    let Ok(win) = serde_json::from_str::<serde_json::Value>(&out.join("")) else { return app.error("the window did not come") };
    put_window(app, dst, dst_target, &win, detached);
}

/// A window described (window_json) put into session [dst] at [target]'s index (or the next
/// free one), as move-window links it: window-linked there, gone to unless [detached].
fn put_window(app: &mut App, dst: u32, target: &str, win: &serde_json::Value, detached: bool) {
    let back = app.session_id;
    if dst != back { app.swap_back = Some(back); app.swap_session(dst); }
    if let Some((tab, _)) = app.tab_from_json(win) {
        let (wid, wname) = (tab.wid(), tab.name.clone());
        let at = app.put_tab(tab, None);
        let spec = crate::cmd::Spec { kind: crate::cmd::Kind::Window, can_fail: false, window_index: true, default_marked: false };
        let idx = target.split_once(':').map(|(_, w)| w).filter(|w| !w.is_empty()).and_then(|w| crate::cmd::resolve(app, Some(&format!(":{w}")), spec).ok()).and_then(|f| f.idx);
        if let Err(e) = app.move_window(at, idx, false, !detached && dst == back) { app.error(e) }
        let (sid, sname) = (app.session_id, app.session_name());
        notify_session(app, "window-linked", sid, &sname, Some((wid, wname)));
    } else { app.error("the window has no pane") }
    if app.session_id != back { app.swap_session(back); }
    app.swap_back = None;
    app.fit_panes();
    app.save_sessions();
}

/// cmd_find_from_nothing: a command from a shell outside hn with no -t (and no -s) is for the
/// session used last — a key, or its making (`hn new -d -s dev; hn split-window` splits dev) —
/// when that is not the one in front. This client's sessions only.
fn best_session(app: &App, words: &[String]) -> Option<u32> {
    if !app.cli_outside || app.capture.is_none() || app.swap_back.is_some() { return None }
    let entry = crate::cmd::find(words.first()?).ok()?;
    if entry.target.is_none() || matches!(entry.name, "switch-client" | "attach-session" | "new-session" | "detach-client" | "kill-server" | "list-sessions" | "has-session") { return None }
    let args = crate::cmd::parse(entry, &crate::tmuxconf::unblock(words)).ok()?;
    // A target with no session of its own (`:`, `:.0`, `.1`, `+`, `!`, a window's number or
    // name) is in the current session — from a shell the one used last, as with no -t.
    let best = app.sessions.iter().filter(|s| !s.desk && s.tabs.iter().any(|t| t.root.is_some())).max_by_key(|s| s.used)?;
    // (A bare word is a window of that session first, then a session by that name — cmd-find.c's
    // order: `-t main` with a session main is main, unless the session used last has a window
    // called main.)
    let windows = app.session_windows(best.id);
    let a_window = |t: &str| windows.iter().any(|(n, name, _)| name == t || n.to_string() == t);
    let a_session = |t: &str| app.find_session(t).is_some();
    let implicit = |t: &str| t.is_empty() || t.starts_with([':', '.', '+', '-', '!', '^'])
        || (!t.contains(':') && !t.starts_with(['$', '@', '%', '{', '=', '~']) && (a_window(t.split('.').next().unwrap_or(t)) || !a_session(t.split('.').next().unwrap_or(t))));
    if args.get('t').map(implicit) == Some(false) || args.get('s').map(implicit) == Some(false) { return None }
    (best.used > app.session_used).then_some(best.id)
}

/// The session (not the one in front) a command's -t or -s names: the part before `:`, the whole
/// target for a session's own commands, `$N`, or the session of a `%pane` or `@window`.
fn other_session(app: &App, words: &[String]) -> Option<u32> {
    let entry = crate::cmd::find(words.first()?).ok()?;
    if matches!(entry.name, "switch-client" | "attach-session" | "new-session" | "detach-client" | "kill-server" | "list-sessions") { return None }
    // list-windows -a and list-panes -a go through every session themselves.
    if matches!(entry.name, "list-windows" | "list-panes") && words.iter().any(|w| w == "-a") { return None }
    // move-window -r: -t is a session (cmd-move-window.c finds it itself), renumbered there.
    if entry.name == "move-window" && words.iter().any(|w| w == "-r") {
        let args = crate::cmd::parse(entry, &crate::tmuxconf::unblock(words)).ok()?;
        let t = args.get('t')?;
        let id = target_session(app, t).or_else(|| app.find_session(t.split(':').next().unwrap_or(t)))?;
        return (id != app.session_id).then_some(id);
    }
    let args = crate::cmd::parse(entry, &crate::tmuxconf::unblock(words)).ok()?;
    for (spec, flag) in [(entry.target, 't'), (entry.source, 's')] {
        let (Some(spec), Some(t)) = (spec, args.get(flag)) else { continue };
        let id = if let Some(p) = t.strip_prefix('%') { crate::pane::from_tag(p.split(['.', ':']).next().unwrap_or("")).and_then(|p| app.session_of_pane(p).or_else(|| app.remote_session_of(Some(p), None))) }
            else if let Some(w) = t.strip_prefix('@') { w.split(['.', ':']).next().and_then(|n| n.parse().ok()).and_then(|w| app.session_of_window(w).or_else(|| app.remote_session_of(None, Some(w)))) }
            else if let Some((s, _)) = t.split_once(':') { (!s.is_empty()).then(|| app.find_session(s)).flatten() }
            else if spec.kind == crate::cmd::Kind::Session || t.starts_with('$') { app.find_session(t) }
            else { None };
        if let Some(id) = id.filter(|id| *id != app.session_id) { return Some(id) }
    }
    None
}

/// kill-session: the windows of the session in front closed, the last taking the session with it.
/// server_check_unattached: this client's sessions that no client shows (the one in front too
/// when it is [leaving]), with destroy-unattached on — keep-group too, as there are no groups
/// — gone as kill-session takes them.
pub fn destroy_unattached(app: &mut App, leaving: bool) {
    let me = app.session_id;
    // server_check_unattached: on, or keep-last (only one of a group with others left in it), or
    // keep-group (any but the last of its group) — each looked at after the one before went.
    let doomed = |app: &App, id: u32| -> bool {
        if app.mirrors.values().any(|m| *m == id) { return false }
        let own = if id == me { app.options.session.get("destroy-unattached").cloned() } else { app.sessions.iter().find(|s| s.id == id).and_then(|s| s.options.get("destroy-unattached").cloned()) };
        let v = own.or_else(|| app.options.global_session.get("destroy-unattached").cloned()).unwrap_or_default();
        let in_group = app.group_of(id).map(|g| app.group_sessions(&g).len());
        match v.as_str() { "on" => true, "keep-last" => in_group.map(|n| n > 1).unwrap_or(false), "keep-group" => in_group.map(|n| n != 1).unwrap_or(true), _ => false }
    };
    let ids: Vec<u32> = app.sessions.iter().filter(|s| !s.desk && s.mirror.is_none() && s.id != me).map(|s| s.id).collect();
    // (The session in front is attached here — unless it is leaving, or there is no terminal.)
    let front_free = (leaving || app.headless) && !app.session_desk && app.mirror.is_none();
    if !ids.iter().any(|id| doomed(app, *id)) && !(front_free && doomed(app, me)) { return }
    let (quit, exited, back) = (std::mem::replace(&mut app.quit, false), app.exited, app.swap_back);
    for id in ids {
        if !doomed(app, id) { continue }
        app.swap_back = Some(me);
        if app.swap_session(id) { kill_windows(app); app.swap_session(me); }
    }
    app.swap_back = back;
    if front_free && doomed(app, me) { kill_windows(app) }
    // (Leaving: the client says it detached, whatever the session's going did to it.)
    app.quit = quit || app.quit;
    if leaving { app.exited = exited }
}

fn kill_windows(app: &mut App) {
    let sid = app.session_id;
    let was = std::mem::replace(&mut app.killing_session, true);
    while app.session_id == sid && !app.quit {
        let empty = app.tabs.iter().all(|t| t.root.is_none());
        let last = app.tabs.len() - 1;
        app.close_tab(last);
        if empty { break }
    }
    app.killing_session = was;
    app.unlinked_later.clear();
}

fn run_words_in(app: &mut App, words: &[String]) {
    let Some(first) = words.first() else { return };
    // Blocks are plain arguments to every command but bind (which writes them back as blocks) and
    // command-prompt (which fills a block's parsed arguments, where it parses a string again).
    let keeps = |n: &str| n == "bind-key" || n == "command-prompt";
    let list = if keeps(resolve(first)) || crate::cmd::find(first).map(|e| keeps(e.name)).unwrap_or(false) { words.to_vec() } else { crate::tmuxconf::unblock(words) };
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
    if app.os_session && !app.headless && matches!(command, "detach-client" | "suspend-client") {
        return app.error("hn is the OS session; open a Terminal with C-b N")
    }
    // A client's own command where no terminal is attached: tmux's cmd_find_client finds none.
    let client_only = matches!(command, "switch-client" | "detach-client" | "refresh-client" | "suspend-client" | "lock-client" | "display-panes" | "command-prompt" | "confirm-before" | "display-menu" | "display-popup");
    if app.headless && client_only && !(command == "detach-client" && opt(words, "-s").is_some()) { return app.error("no current client") }
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
            // C-b c (a bare new-window, from a key or the prompt): the home page in the new window —
            // its recent harnesses and conversations to pick from, `t` a shell — as the desktop's
            // new tab. From a script, or with anything asked of it (-c, -n, a command…), a shell as
            // tmux makes; `set -g @hn-new-window shell` makes the key tmux's too.
            // (Not when commands follow it in the same line or binding — `new-window \; split-window
            // -h` — which want its pane, as tmux's has one.)
            let bare = app.capture.is_none() && !app.headless && !app.chain_follows && command.is_none() && cwd.is_none() && name.is_none() && opt(words, "-t").is_none()
                && !["-d", "-a", "-b", "-k", "-P"].iter().any(|f| flag(words, f)) && opt(words, "-e").is_none()
                && app.options.get("@hn-new-window", "", None).as_deref() != Some("shell")
                // (tmux's look is tmux's C-b c too.)
                && app.options.get("@hn-look", "", None).as_deref() != Some("tmux");
            // Use the local shell service when the local daemon is unavailable.
            let machine = input::shell_machine(app, from.as_ref());
            if app.link(&machine).is_none() { return app.error("create window failed: the daemon is not running (harness start)") }
            app.new_tab_at(idx);
            if app.capture.is_some() { app.tab_mut().size = app.cli_size; }
            if bare {
                app.tab_mut().home = true;
                crate::new_harness::ensure_welcome(app, from.clone(), cwd.clone());
                let tab = app.tab().id.clone();
                input::new_shell_from(app, from, Placement::Fill(tab), cwd, command);
                return;
            }
            if let Some(n) = &name { let n = expand(app, n); app.rename_tab(&n) }
            // A window made in a session not in front: its window-linked (notify_changes sees
            // only the one in front).
            if app.swap_back.is_some_and(|b| b != app.session_id) {
                let (sid, sname, wid, w) = (app.session_id, app.session_name(), app.tabs[app.active].wid(), app.tabs[app.active].name.clone());
                notify_session(app, "window-linked", sid, &sname, Some((wid, w)));
            }
            if flag(words, "-P") { app.print_new = Some(opt(words, "-F").unwrap_or_else(|| "#{session_name}:#{window_index}.#{pane_index}".into())) }
            // The reply can arrive after another window was selected or created.
            // Bind it to this window, never to the later active window.
            app.tab_mut().home = false;
            let tab = app.tab().id.clone();
            input::new_shell_from(app, from, Placement::Fill(tab), cwd, command);
            // -d never visits the new window, even while its shell is still being created.
            // A later completion must not restore stale selection or last-window history.
            if flag(words, "-d") {
                if let Some(i) = app.tabs.iter().position(|t| t.id == was_id) {
                    app.active = i; app.lastw = last_before;
                    app.home_order.borrow_mut().clear();
                    app.fit_panes();
                }
            }
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
            // No room: tmux's error, and no shell made.
            if !app.can_split(&at) { app.print_new = None; return app.error("no space for new pane") }
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
            // (session_next_alert); else simply the next (previous) one — none when there is
            // only this one (tmux's "no next window").
            let n = app.tabs.len();
            if n <= 1 { return app.error(format!("no {} window", if command == "next-window" { "next" } else { "previous" })) }
            let step = |i: usize| if command == "next-window" { (i + 1) % n } else { (i + n - 1) % n };
            if flag(words, "-a") {
                let mut i = step(app.active);
                while i != app.active && !crate::format::flags(app, i).contains(['#', '!', '~']) { i = step(i) }
                if i == app.active { return app.error(format!("no {} window", if command == "next-window" { "next" } else { "previous" })) }
                return app.select_tab(i);
            }
            app.select_tab(step(app.active))
        }
        "last-window" => {
            if !app.lastw.iter().any(|id| app.tabs.iter().any(|t| t.id == *id)) { return app.error("no last window") }
            input::run(app, "last-tab")
        }
        "select-window" => {
            let target = opt(words, "-t").or_else(|| Some(rest(words))).unwrap_or_default();
            // -l the last window, -n and -p the next and previous (their errors too).
            if flag(words, "-l") { return run_words(app, &["last-window".to_string()]) }
            if flag(words, "-n") { return run_words(app, &["next-window".to_string()]) }
            if flag(words, "-p") { return run_words(app, &["previous-window".to_string()]) }
            // -T: the last window when the target is the current one already.
            if flag(words, "-T") && window_target(app, &target) == Some(app.active) { return run_words(app, &["last-window".to_string()]) }
            match window_target(app, &target) { Some(i) => app.select_tab(i), None => app.error(format!("can't find window: {}", target.trim_start_matches(':'))) }
        }
        "rename-window" => {
            // rename-window [-t target-window] new-name
            let target = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            let name = positional(words).join(" ");
            app.rename_tab_at(target, &name);
        }
        // link-window within one session: tmux links a window twice into one session; hn has a
        // window once in each session.
        "link-window" => app.error("window is already linked to that session"),
        "unlink-window" => {
            // cmd-kill-window.c: the window out of this session — only when another session (one
            // outside its group) has it, unless -k, which kills it when none does.
            let w = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            let id = app.tabs[w].id.clone();
            let group = app.session_group.clone();
            let outside = app.sessions.iter().any(|s| s.mirror.is_none() && (group.is_none() || s.group != group) && s.tabs.iter().any(|t| t.id == id && t.root.is_some()));
            if !outside && !flag(words, "-k") { return app.error("window only linked to one session") }
            app.unlinking = outside;
            app.close_tab(w);
            app.unlinking = false;
            app.window_gone = true;
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
            if let Err(e) = app.move_window(src, idx, flag(words, "-k"), !flag(words, "-d")) { return app.error(e) }
            // Moving within this session changes its index without renumbering its other windows.
        }
        "select-pane" => {
            // tmux's select-pane [-DdeLlMmRUZ] [-T title] [-t target-pane]. -M clears the mark,
            // -m marks the pane (again: unmarks); -l the last pane; -L/-R/-U/-D the pane that
            // way (round the far side); -d/-e input off/on; -T the title. Else the pane becomes
            // its window's active one — the window does not become the current one. A zoomed
            // window is unzoomed unless -Z.
            if flag(words, "-M") { app.marked = None; app.marked_session = None; return }
            let (w, p) = match opt(words, "-t") {
                Some(t) => match pane_target(app, &t) { Some(x) => x, None => return app.error(format!("can't find pane: {t}")) },
                None => match app.current() { Some(x) => x, None => return },
            };
            let keep_zoom = flag(words, "-Z");
            if flag(words, "-m") { app.marked = if app.marked == Some(p) && app.marked_session == Some(app.session_id) { None } else { Some(p) }; app.marked_session = app.marked.map(|_| app.session_id); return }
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
                // window_zoom (or unzoom) of the target's window, its pane the active one there —
                // that window made current by nothing (tmux zooms it where it is).
                if w != app.active {
                    app.tabs[w].set_active(p);
                    if app.tabs[w].panes().len() > 1 { app.tabs[w].zoomed = !app.tabs[w].zoomed; app.fit_panes(); app.view_layout_changed(w) }
                    return;
                }
                if app.focused() != Some(p) { app.focus_pane(w, p) }
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
            // -t as a window index (cmd-find's WINDOW_INDEX: a number no window has yet is fine).
            let spec = crate::cmd::Spec { kind: crate::cmd::Kind::Window, can_fail: false, window_index: true, default_marked: false };
            let found = match opt(words, "-t") { Some(t) => match crate::cmd::resolve(app, Some(&t), spec) { Ok(f) => Some(f), Err(e) => return app.error(e) }, None => None };
            let mut num = found.as_ref().and_then(|f| f.idx);
            // -a after the target window (else this one), -b before it: the windows from there
            // move up one (winlink_shuffle_up).
            if flag(words, "-a") || flag(words, "-b") {
                let at = found.as_ref().and_then(|f| f.window).map(|w| app.win_num(w)).unwrap_or_else(|| app.win_num(app.active));
                let at = if flag(words, "-b") { at } else { at + 1 };
                app.shuffle_up(at);
                num = Some(at);
            }
            let single = app.tabs.iter().find(|t| t.panes().contains(&src)).is_some_and(|t| t.panes().len() == 1);
            if let Err(e) = app.break_pane(src, opt(words, "-n"), num, flag(words, "-d")) { return app.error(e) }
            // A one-pane window uses the move-window path, which prints no new pane target.
            if flag(words, "-P") && !single {
                let Some(w) = app.tabs.iter().position(|t| t.panes().contains(&src)) else { return };
                let template = opt(words, "-F").unwrap_or_else(|| "#{session_name}:#{window_index}.#{pane_index}".into());
                let line = crate::format::expand(app, &template, w, Some(src), true);
                app.print("break-pane", vec![line]);
            }
        }
        "rotate-window" => {
            // -t: that window; -D the other way; -Z keeps a zoomed window zoomed.
            let w = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            app.rotate(w, if flag(words, "-D") { -1 } else { 1 }, flag(words, "-Z"))
        }
        // -t: that window's layout, the current window staying where it is.
        "next-layout" | "previous-layout" => {
            let target = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            app.step_layout(target, command == "next-layout");
            app.layout_changed(target);
        }
        "select-layout" => {
            // -t: that window (else this one).
            // select-layout [-Enop] [-t target-window] [layout-name]: tmux's seven by name (or the
            // one a prefix names), -n/-p the next/previous, -E spread out, or a layout string.
            let target = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(i) => i, None => return app.error(format!("can't find window: {t}")) }, None => app.active };
            // cmd-select-layout.c notifies once more after whatever changed the layout.
            if flag(words, "-n") || flag(words, "-p") { app.step_layout(target, !flag(words, "-p")); return app.layout_changed(target) }
            if flag(words, "-E") {
                if let Some(f) = app.tabs[target].focus { if let Some(root) = app.tabs[target].root.as_mut() { root.spread_out(f) } }
                app.fit_panes();
                return app.layout_changed(target);
            }
            let name = positional(words).join(" ");
            let name = name.trim();
            // No name: the layout last applied, again (nothing if there was none).
            if name.is_empty() {
                if let Some(at) = app.tabs[target].layout_at { app.arrange_tab(target, crate::layout::Named::ALL[at]); app.layout_changed(target) }
                return;
            }
            if let Some(named) = crate::layout::Named::lookup(name) { app.arrange_tab(target, named); return app.layout_changed(target) }
            // A tmux layout string (#{window_layout}, tmux-resurrect's): the panes take its cells.
            let ids = app.tabs[target].panes();
            let body = app.body();
            match crate::layout::Node::from_tmux(name, &ids, body.width, body.height).filter(|_| crate::layout::checksum_ok(name)) {
                Some(root) => { let tab = &mut app.tabs[target]; tab.root = Some(root); tab.zoomed = false; app.fit_panes(); app.layout_changed(target); app.layout_changed(target) }
                None => app.error(format!("invalid layout: {name}")),
            }
        }
        "display-panes" => {
            // cmd_display_panes_exec: none over one already open; -d how long (0: until a key),
            // else display-panes-time; the template a number runs; -N no keys; a shell that ran
            // it waits until it closes (not with -b).
            if matches!(app.modal, Some(Modal::DisplayPanes { .. })) { return }
            let ms = match opt(words, "-d") {
                Some(d) => match d.parse::<i64>() { Ok(n) if n < 0 => return app.error("delay too small"), Ok(n) if n > u32::MAX as i64 => return app.error("delay too large"), Ok(n) => n as u64, Err(_) => return app.error("delay invalid") },
                None => app.display_panes_ms,
            };
            let until = (ms > 0).then(|| std::time::Instant::now() + std::time::Duration::from_millis(ms));
            app.modal = Some(Modal::DisplayPanes { until, template: positional(words).first().cloned(), keys: !flag(words, "-N") });
            app.wait_cli = app.capture.is_some() && !flag(words, "-b");
        }
        "copy-mode" => {
            // cmd-copy-mode.c [-deHMqu] [-s src-pane] [-t target-pane]: the pane into copy mode, a
            // copy of its screen and history (another pane's with -s) — -q every mode it is in
            // ended instead; -M the pane under the mouse (nothing when there is none), a selection
            // dragged from where it went down; -e it ends when scrolled back to the bottom, -H its
            // position not shown; then -u a page up, -d a page down.
            let pane = if flag(words, "-M") {
                match app.mouse_ev.clone().filter(|m| m.valid).and_then(|m| crate::mouse::mouse_pane(app, &m)) { Some((_, p)) => p, None => return }
            } else {
                match target_pane(app, words) { Some((_, p)) => p, None => return }
            };
            if flag(words, "-q") { crate::copy::exit_all(app, pane); crate::tree::exit(app, pane); return app.sync_copy_modal() }
            let source = match opt(words, "-s") {
                Some(s) => match pane_target(app, &s) { Some((_, p)) => p, None => return app.say(format!("can't find pane: {s}"), theme::WARN) },
                None => pane,
            };
            let already = crate::copy::enter(app, pane, source, flag(words, "-e"), flag(words, "-H"));
            if !already && flag(words, "-M") { if let Some(m) = app.mouse_ev.clone() { crate::copy::start_drag(app, &m) } }
            let c = crate::copy::ctx(app, pane);
            if flag(words, "-u") { if let Some(m) = app.panes.get_mut(&pane).and_then(|p| p.modes.last_mut()) { m.pageup(false, &c) } }
            if flag(words, "-d") {
                let exit = flag(words, "-e");
                let done = app.panes.get_mut(&pane).and_then(|p| p.modes.last_mut()).map(|m| m.pagedown(false, exit, &c)).unwrap_or(false);
                if done { crate::copy::exit(app, pane) }
            }
            if let Some(p) = app.panes.get_mut(&pane) { p.dirty = true }
            app.sync_copy_modal();
        }
        // hn's own: copy mode's search prompt, as the table opens it.
        "search-backward" | "search-forward" => { execute(app, "copy-mode"); input::search_prompt(app, command == "search-backward") }
        "paste-buffer" => {
            // tmux's paste-buffer [-dpr] [-s separator] [-b buffer-name] [-t target-pane]: the
            // buffer (the newest automatic one without -b) into the pane — its newlines as -s, a
            // newline with -r, else a carriage return; -p bracketed; -d the buffer then deleted.
            let name = match opt(words, "-b") {
                Some(b) => { if app.paste.get(&b).is_none() { return app.error(format!("no buffer {b}")) } Some(b) }
                None => app.paste.top().map(|b| b.name.clone()),
            };
            let Some(name) = name else { return };
            let text = app.paste.get(&name).map(|b| b.data.clone()).unwrap_or_default();
            if app.capture.is_none() && opt(words, "-t").is_none() && input::paste_form(app, &text) {
                if flag(words, "-d") { app.paste.free(&name) }
                return;
            }
            let Some((_, pane)) = target_pane(app, words) else { return };
            let sep = opt(words, "-s").unwrap_or_else(|| if flag(words, "-r") { "\n".into() } else { "\r".into() });
            input::paste_into(app, pane, &text, &sep, flag(words, "-p"));
            if flag(words, "-d") { app.paste.free(&name) }
        }
        "list-buffers" => {
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
        "choose-buffer" => {
            // cmd-choose-tree.c for window-buffer.c: the pane into buffer mode — every paste buffer,
            // -F the items' format, -K their keys', -f a filter, -O the sort (time, name, size), -r
            // reversed, -N no preview, -Z zoomed while it lasts; the template run on the chosen
            // buffer (paste-buffer -p -b '%%'). No buffers: nothing.
            if app.paste.walk().next().is_none() { return }
            let Some((w, p)) = target_pane(app, words) else { return };
            let command = positional(words).first().cloned().filter(|c| !c.is_empty());
            let a = crate::tree::Start {
                buffer: true, session: false, window: false, format: opt(words, "-F"), key_format: opt(words, "-K"), command,
                filter: opt(words, "-f"), sort: opt(words, "-O"), reversed: flag(words, "-r"), no_preview: flag(words, "-N"), zoom: flag(words, "-Z"), groups: flag(words, "-G"),
            };
            crate::tree::enter(app, p, w, &a);
        }
        "delete-buffer" => {
            let name = match opt(words, "-b") {
                Some(b) => { if app.paste.get(&b).is_none() { return app.error(format!("unknown buffer: {b}")) } b }
                None => match app.paste.top() { Some(b) => b.name.clone(), None => return app.error("no buffer") },
            };
            app.paste.free(&name);
        }
        "choose-tree" => {
            // -s alone — C-b s, tmux's `choose-tree -Zs` — is hn's list of every harness; -s with
            // any of the tree's own options (as a tmux.conf binds it) is tmux's tree of sessions.
            let tree_options = ["-F", "-f", "-K", "-O", "-t"].iter().any(|o| opt(words, o).is_some())
                || ["-G", "-N", "-r", "-w"].iter().any(|f| flag(words, f)) || !positional(words).is_empty();
            if flag(words, "-s") && !tree_options { input::launch(app, "", Filter::All) }
            else if flag(words, "-m") { input::launch(app, "@", Filter::All) }
            else if flag(words, "-a") { input::run(app, "inbox") }
            else if flag(words, "-i") { input::launch(app, ":", Filter::All) }
            else if flag(words, "-S") { input::launch(app, "*", Filter::All) }
            else {
                // cmd-choose-tree.c: the pane into tree mode (window-tree.c), every session in it —
                // -s starting on its session and -w on its window, collapsed; -F the items' format,
                // -K their keys', -f a filter, -O the sort, -r reversed, -N no preview, -Z zoomed
                // while it lasts; the template run on the chosen item (switch-client -Zt '%%').
                let Some((w, p)) = target_pane(app, words) else { return };
                let command = positional(words).first().cloned().filter(|c| !c.is_empty());
                let a = crate::tree::Start {
                    buffer: false, session: flag(words, "-s"), window: flag(words, "-w"), format: opt(words, "-F"), key_format: opt(words, "-K"), command,
                    filter: opt(words, "-f"), sort: opt(words, "-O"), reversed: flag(words, "-r"), no_preview: flag(words, "-N"), zoom: flag(words, "-Z"), groups: flag(words, "-G"),
                };
                crate::tree::enter(app, p, w, &a);
            }
        }
        "choose-client" => input::run(app, "tree"),
        "find-window" => {
            // cmd-find-window.c: the tree of every session (window-tree mode), filtered to the
            // panes whose contents (-C), window name (-N) or title (-T) match — all three unless
            // some are given; -r a regular expression, -i ignoring case; -Z zoomed.
            let s = positional(words).first().cloned().unwrap_or_default();
            let (mut c, mut n, mut t) = (flag(words, "-C"), flag(words, "-N"), flag(words, "-T"));
            if !c && !n && !t { (c, n, t) = (true, true, true) }
            let (r, i) = (flag(words, "-r"), flag(words, "-i"));
            let star = if r { "" } else { "*" };
            let suffix = match (r, i) { (true, true) => "/ri", (true, false) => "/r", (false, true) => "/i", _ => "" };
            let content = format!("#{{C{suffix}:{s}}}");
            let name = format!("#{{m{suffix}:{star}{s}{star},#{{window_name}}}}");
            let title = format!("#{{m{suffix}:{star}{s}{star},#{{pane_title}}}}");
            let filter = match (c, n, t) {
                (true, true, true) => format!("#{{||:{content},#{{||:{name},{title}}}}}"),
                (true, true, false) => format!("#{{||:{content},{name}}}"),
                (true, false, true) => format!("#{{||:{content},{title}}}"),
                (false, true, true) => format!("#{{||:{name},{title}}}"),
                (true, false, false) => content,
                (false, true, false) => name,
                _ => title,
            };
            let Some((w, p)) = target_pane(app, words) else { return };
            let a = crate::tree::Start { buffer: false, session: false, window: false, format: None, key_format: None, command: None, filter: Some(filter), sort: None, reversed: false, no_preview: false, zoom: flag(words, "-Z"), groups: false };
            crate::tree::enter(app, p, w, &a);
        }
        "display-message" => {
            if flag(words, "-I") {
                if opt(words, "-t").map(|t| pane_target(app, &t)).unwrap_or_else(|| app.current()).is_some() { return app.error("pane is not empty") }
                return;
            }
            // tmux's display-message [-lp] [-F format] [-t target-pane] [message]: the format
            // (-l: as it is) against the target pane — one tmux can't find leaves it none.
            if flag(words, "-a") {
                let (w, p) = match opt(words, "-t").map(|t| pane_target(app, &t)) { Some(Some((w, p))) => (w, Some(p)), Some(None) => (usize::MAX, None), None => app.current().map(|(w, p)| (w, Some(p))).unwrap_or((app.active, None)) };
                let lines = crate::format::every(app, w, p);
                return app.print("display", lines);
            }
            if opt(words, "-F").is_some() && !positional(words).is_empty() { return app.error("only one of -F or argument must be given") }
            // An empty one is empty (only none is the default).
            let text = positional(words).first().cloned().or_else(|| opt(words, "-F")).unwrap_or_else(|| "[#{session_name}] #{window_index}:#{window_name}, current pane #{pane_index} - (%H:%M %d-%b-%y)".to_string());
            let out = if flag(words, "-l") { text } else if flag(words, "-v") {
                let (w, p) = match opt(words, "-t").map(|t| pane_target(app, &t)) { Some(Some((w, p))) => (w, Some(p)), Some(None) => (usize::MAX, None), None => app.current().map(|(w, p)| (w, Some(p))).unwrap_or((app.active, None)) };
                let (out, lines) = crate::format::verbose(app, &text, w, p);
                app.print("display", lines);
                out
            } else {
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
                // -d: this long (0: until a key), whatever display-time says.
                if let Some(d) = opt(words, "-d").and_then(|d| d.trim().parse::<u64>().ok()) { app.toast_exact = Some(d) }
            }
        }
        // -T the terminals, -J the jobs, in place of the messages.
        "show-messages" if app.headless => app.error("no current client"),
        "show-messages" if flag(words, "-T") || flag(words, "-J") => {
            let lines = if flag(words, "-T") { vec![format!("Terminal 0: {} for {}, flags=0x0:", std::env::var("TERM").unwrap_or_default(), crate::app::tty_name())] } else { Vec::new() };
            app.print("show-messages", lines)
        }
        "show-messages" => {
            // SHOW_MESSAGES_TEMPLATE, newest first: `#{t/p:message_time}: #{message_text}`.
            let off = crate::app::utc_offset();
            let lines = app.messages.iter().rev().map(|(at, t)| {
                let secs = at.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) + off;
                format!("{:02}:{:02}: {t}", secs.rem_euclid(86400) / 3600, (secs.rem_euclid(3600)) / 60)
            }).collect();
            app.print("show-messages", lines)
        }
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
            let only = match &key { Some(k) => match crate::keys::parse(k) { Ok(c) => Some(c), Err(_) => return app.error(format!("invalid key: {k}")) }, None => None };
            let mut tables = app.keymap.tables();
            // (From a script: tmux's keys and yours, not hn's own — see keys::hn_added.)
            if app.capture.is_some() { for (_, list) in tables.iter_mut() { list.retain(|b| !crate::keys::hn_added(b)) } }
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
        "show-options" | "show-window-options" | "show-hooks" => {
            // tmux's show-options: -g global, -s server, -w window, -p pane, -v values only,
            // -A what is inherited too (marked *), -q quiet, -t the window or pane.
            let mut f = crate::options::SetFlags { window: command == "show-window-options", ..Default::default() };
            let (mut values_only, mut inherited, mut quiet, mut target, mut name, mut hooks) = (false, false, false, None, None, false);
            let mut i = 1;
            while i < words.len() {
                let w = &words[i];
                if name.is_none() && w.starts_with('-') && w.len() > 1 {
                    for c in w[1..].chars() {
                        match c { 'g' => f.global = true, 's' => f.server = true, 'w' => f.window = true, 'p' => f.pane = true, 'v' => values_only = true, 'A' => inherited = true, 'q' => quiet = true, 'H' => hooks = true, 't' => { i += 1; target = words.get(i).cloned() } _ => {} }
                    }
                } else if name.is_none() { name = Some(w.clone()) } else { return app.error("command show-options: too many arguments (need at most 1)") }
                i += 1;
            }
            let name = match name.as_deref().map(crate::options::resolve).transpose() { Ok(n) => n, Err(_) if quiet => return, Err(e) => return app.error(e) };
            let (tab, pane) = match target.as_deref() {
                Some(t) => match pane_target(app, t) { Some(tp) => tp, None => return app.error(no_such(&f, name.as_deref(), t)) },
                None => app.current().unwrap_or((app.active, 0)),
            };
            let tab_id = app.tabs[tab].id.clone();
            let which = if command == "show-hooks" { crate::options::Which::Hooks } else if hooks { crate::options::Which::All } else { crate::options::Which::Options };
            match app.options.show(name.as_deref(), &f, inherited, values_only, which, &tab_id, pane) {
                Ok(lines) => { if !lines.is_empty() { app.print("show-options", lines) } }
                Err(_) if quiet => {}
                Err(e) => app.error(e),
            }
        }
        "list-windows" | "list-sessions" | "list-panes" | "list-clients" | "hn-list-clients" => {
            // tmux's list-* with its own templates (-F another), -f a filter, #{line} the count.
            // list-clients: this client's line, then the other clients' of this name (each asked
            // for its own: hn-list-clients).
            let (command, clients) = if command == "hn-list-clients" { ("list-clients", false) } else { (command, command == "list-clients") };
            let format_type = app.format_type;
            app.format_type = Some(match command { "list-sessions" => crate::tree::FORMAT_SESSION, "list-windows" => crate::tree::FORMAT_WINDOW, "list-panes" => crate::tree::FORMAT_PANE, _ => 0 });
            let filter = opt(words, "-f");
            // Every session's (list-sessions, and -a): each in front in turn while its lines are made.
            let all = command == "list-sessions" || flag(words, "-a");
            let me = app.session_id;
            // list-clients: this client's own session (not one a command has in front for a moment).
            let client_sid = app.swap_back.unwrap_or(me);
            let order: Vec<u32> = if all { app.session_list().into_iter().map(|(id, _)| id).collect() } else if command == "list-clients" { vec![client_sid] } else { vec![me] };
            let outer = app.swap_back;
            let mut lines = Vec::new();
            for sid in order {
            // Another client's session: its row made here (list-sessions), else its lines asked
            // of that client (a client's own line is its own, whoever has its session).
            // The session in front is another terminal's (shown here as it has it): list-panes and
            // list-windows as they were asked, answered there (its targets made absolute).
            if sid == app.session_id && !all && app.mirror.is_some() && matches!(command, "list-panes" | "list-windows") {
                if let (Some(m), Ok(entry)) = (app.mirror.clone(), crate::cmd::find(command)) {
                    let w = crate::mirror::absolute(app, &entry, words);
                    if let Some((out, err, _)) = crate::ipc::ask(std::path::Path::new(&m.owner), &w) { lines.extend(out); for e in err { app.error(e) } }
                    continue;
                }
            }
            if let Some(owner) = app.remote_owner(sid).filter(|_| command != "list-clients") {
                let template = opt(words, "-F");
                if command == "list-sessions" {
                    let template = template.unwrap_or_else(|| "#{session_name}: #{session_windows} windows (created #{t:session_created})#{?session_grouped, (group ,}#{session_group}#{?session_grouped,),}#{?session_attached, (attached),}".into());
                    let keep = filter.as_ref().map(|f| { let v = crate::format::expand_session(app, f, sid); !v.is_empty() && v != "0" }).unwrap_or(true);
                    if keep { lines.push(crate::format::expand_session(app, &template, sid)) }
                    continue;
                }
                let name = app.session_list().into_iter().find(|(i, _)| *i == sid).map(|(_, n)| n).unwrap_or_default();
                let mut ask = vec![command.to_string()];
                if command == "list-panes" { ask.push("-s".into()) }
                ask.extend(["-t".to_string(), if command == "list-panes" { format!("={name}:") } else { format!("={name}") }, "-F".into()]);
                ask.push(template.unwrap_or_else(|| match command {
                    "list-panes" => "#{session_name}:#{window_index}.#{pane_index}: [#{pane_width}x#{pane_height}] [history #{history_size}/#{history_limit}, #{history_bytes} bytes] #{pane_id}#{?pane_active, (active),}#{?pane_dead, (dead),}".into(),
                    _ => "#{session_name}:#{window_index}: #{window_name}#{window_raw_flags} (#{window_panes} panes) [#{window_width}x#{window_height}] ".into(),
                }));
                if let Some(f) = &filter { ask.extend(["-f".to_string(), f.clone()]) }
                if let Some((out, _, _)) = crate::ipc::ask(std::path::Path::new(&owner), &ask) { lines.extend(out) }
                continue;
            }
            if sid != me { app.swap_back = Some(me); if !app.swap_session(sid) { app.swap_back = outer; continue } }
            let rows: Vec<(usize, Option<u64>)> = match command {
                "list-panes" => {
                    let windows: Vec<usize> = if flag(words, "-a") || flag(words, "-s") { (0..app.tabs.len()).collect() } else { vec![opt(words, "-t").and_then(|t| window_target(app, &t)).unwrap_or(app.active)] };
                    windows.into_iter().flat_map(|w| app.tabs[w].panes().into_iter().map(move |p| (w, Some(p)))).collect()
                }
                "list-windows" => (0..app.tabs.len()).map(|w| (w, None)).collect(),
                // hn with no terminal is tmux's server, not a client of it.
                "list-clients" if app.headless => Vec::new(),
                // list-clients -t: only when this client shows that session.
                "list-clients" if opt(words, "-t").map(|t| app.find_session(t.split(':').next().unwrap_or(&t)) != Some(client_sid)).unwrap_or(false) => Vec::new(),
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
            let mut last_window = None;
            let mut n = 0usize;
            for (w, p) in rows {
                // #{line}: the row's number — list-panes counts each window's panes from 0.
                if command == "list-panes" && last_window != Some(w) { n = 0; last_window = Some(w) }
                app.format_line = Some(n);
                n += 1;
                // format_expand, not format_expand_time: a % in -F is itself (cmd-list-*.c).
                let keep = filter.as_ref().map(|f| { let v = crate::format::expand(app, f, w, p, false); !v.is_empty() && v != "0" }).unwrap_or(true);
                if keep { lines.push(crate::format::expand(app, &template, w, p, false)) }
            }
            if sid != me { app.swap_session(me); app.swap_back = outer; }
            }
            app.format_line = None;
            if clients {
                let mut ask: Vec<String> = vec!["hn-list-clients".into()];
                if let Some(t) = opt(words, "-F") { ask.extend(["-F".to_string(), t]) }
                if let Some(t) = opt(words, "-t") { ask.extend(["-t".to_string(), t]) }
                if let Some(f) = &filter { ask.extend(["-f".to_string(), f.clone()]) }
                for other in other_clients() { if let Some((out, _, _)) = crate::ipc::ask(&other, &ask) { lines.extend(out) } }
            }
            app.format_type = format_type;
            app.print(command, lines);
        }
        "set-option" | "set-window-option" => {
            // tmux's set-option: checked, kept where the flags say (the session, the window, the
            // pane, or globally), then the options hn acts on read the value now in force.
            let (f, quiet, format, target, args) = crate::tmuxconf::set_flags(&words[1..], command == "set-window-option");
            let Some(name) = args.first().cloned() else { return app.error("command set-option: too few arguments (need at least 1)") };
            let name = match crate::options::resolve(&name) { Ok(n) => n, Err(_) if quiet => return, Err(e) => return app.error(e) };
            let value = args.get(1).map(|v| if format { expand(app, v) } else { v.clone() });
            // -t: the window (or pane) the option is for; else the one here.
            let (tab, pane) = match target.as_deref() {
                Some(t) => match pane_target(app, t) { Some(tp) => tp, None => return app.error(no_such(&f, Some(&name), t)) },
                None => app.current().unwrap_or((app.active, 0)),
            };
            let tab_id = app.tabs[tab].id.clone();
            let now = match app.options.set(&name, value.as_deref(), &f, &tab_id, pane) {
                Ok(now) => now,
                // (-q: quiet about an option it does not know, and one -o finds already set.)
                Err(e) if quiet && (e.starts_with("invalid option") || e.starts_with("already set")) => return,
                Err(e) => return app.error(e),
            };
            after_set(app, &name, now, f.global, Some(tab));
        }
        "bind-key" | "unbind-key" => {
            let mut settings = crate::tmuxconf::Settings::default();
            settings.aliases = app.options.array("command-alias");
            if command == "bind-key" {
                let values = positional(words);
                let rest = values.get(1..).unwrap_or_default();
                let line = if rest.len() == 1 { rest[0].trim_start_matches(crate::tmuxconf::BLOCK).to_string() } else { rest.iter().map(|w| crate::tmuxconf::quote_word(w)).collect::<Vec<_>>().join(" ") };
                if !line.is_empty() {
                    let aliases = settings.aliases.clone();
                    let alias = |name: &str| aliases.iter().find_map(|a| a.split_once('=').filter(|(n, _)| *n == name).map(|(_, v)| v.to_string()));
                    let parsed = match crate::cmdparse::parse(&line, app, false) { Ok(cmds) => cmds, Err((_, error)) => return app.error(error) };
                    if let Err((_, error)) = crate::cmdparse::build(&parsed, app, None, false, &alias) { return app.error(error) }
                }
            }
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
                // The shell's input (- or /dev/stdin): what it piped in — never hn's own terminal,
                // which would wait for keys forever.
                if is_stdin(&path) {
                    let Some(text) = app.cli_stdin.clone() else { app.error(format!("{path}: no standard input here")); continue };
                    match source_text(app, "-", &text, parse_only, verbose) { Ok(items) => app.insert_next.extend(items), Err(e) => config_cause(app, "-", e) }
                    continue;
                }
                let pattern = if path.starts_with('/') { path.clone() } else { format!("{cwd}/{path}") };
                let found = glob(&pattern);
                if found.is_empty() { if !quiet { app.error(format!("{path}: No such file or directory")) } continue }
                files.extend(found);
            }
            for file in files {
                match source(app, &file, parse_only, verbose) {
                    Ok(items) => app.insert_next.extend(items),
                    Err(e) => config_cause(app, &file, e),
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
            // cmd-capture-pane.c [-aCeJNpPqT] [-b buffer] [-S start] [-E end] [-t pane]: the lines
            // from -S to -E (formats; `-` the history's first or the screen's last), trailing
            // spaces trimmed unless -N or -J, wrapped lines joined with -J, colours and attributes
            // as escape sequences with -e (escaped with -C) — printed with -p, else a buffer (each
            // line ending in a newline). -a the screen a full-screen program hides: alacritty keeps
            // it out of reach, so it is empty; -P what the pane has not finished writing: none.
            let pane = match opt(words, "-t") { Some(t) => match pane_target(app, &t) { Some((_, p)) => Some(p), None => { app.error(format!("can't find pane: {t}")); return } }, None => app.current().map(|(_, p)| p) };
            let (start, end) = (opt(words, "-S").map(|v| expand(app, &v)), opt(words, "-E").map(|v| expand(app, &v)));
            let Some(p) = pane.and_then(|p| app.panes.get(&p)) else { return };
            let alt = p.term.mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN);
            let text = if flag(words, "-a") {
                if !alt && !flag(words, "-q") { return app.error("no alternate screen") }
                String::new()
            } else if flag(words, "-P") { String::new() } else {
                let (top, bottom) = (crate::capture::line_of(p, start.as_deref(), true), crate::capture::line_of(p, end.as_deref(), false));
                let (top, bottom) = if bottom < top { (bottom, top) } else { (top, bottom) };
                let join = flag(words, "-J");
                let f = crate::capture::Flags2 { join, sequences: flag(words, "-e"), escape: flag(words, "-C"), empty_cells: !join && !flag(words, "-T"), trim: !join && !flag(words, "-N") };
                crate::capture::history(p, top, bottom, f)
            };
            if flag(words, "-p") {
                let t = text.strip_suffix('\n').unwrap_or(&text);
                app.print("capture-pane", t.split('\n').map(str::to_string).collect())
            } else {
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
            if let Some(t) = opt(words, "-t").filter(|_| !flag(words, "-g")) { if app.find_session(t.split(':').next().unwrap_or(&t)).is_none() { return app.error(format!("no such session: {t}")) } }
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
            if !flag(words, "-g") { if let Some(t) = opt(words, "-t") { if app.find_session(t.split(':').next().unwrap_or(&t)).is_none() { return app.error(format!("no such session: {t}")) } } }
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
        "set-hook" => {
            // cmd-set-option.c, as set-hook [-agpRuw] [-t target-pane] hook [command] runs it: -R
            // fires the hook now (notify_hook); else it is set as an option is — a hook is an
            // array of commands, kept as tmux prints them (display → display-message), -a adding
            // one, -u removing the hook (or hook[N]).
            let args = positional(words);
            let Some(name) = args.first().map(|n| expand(app, n)) else { return app.error("command set-hook: too few arguments (need at least 1)") };
            let name = match crate::options::resolve(&name) { Ok(n) => n, Err(e) => return app.error(e) };
            let (tab, pane) = match opt(words, "-t") {
                Some(t) => match pane_target(app, &t) { Some(tp) => tp, None => return app.error(format!("can't find pane: {t}")) },
                None => app.current().unwrap_or((app.active, 0)),
            };
            if flag(words, "-R") {
                // notify_hook inserts these commands in the caller's queue, so display -p
                // and asynchronous hook commands reply to the shell that requested them.
                let pending = app.pending_hooks.len();
                notify(app, &name, Some(tab), Some(pane));
                app.insert_next.extend(app.pending_hooks.split_off(pending));
                return;
            }
            let f = crate::options::SetFlags { global: flag(words, "-g"), pane: flag(words, "-p"), window: flag(words, "-w"), unset: flag(words, "-u"), append: flag(words, "-a"), ..Default::default() };
            let mut value = args.get(1).cloned();
            if let (Some(v), Some(o)) = (value.as_ref(), crate::options::find(&name)) {
                if matches!(o.kind, crate::options::Kind::Command) {
                    if let Err((_, e)) = crate::cmdparse::parse(v, app, false) { return app.error(e) }
                    value = Some(canonical_with(v, " ; "));
                }
            }
            let tab_id = app.tabs[tab].id.clone();
            if let Err(e) = app.options.set(&name, value.as_deref(), &f, &tab_id, pane) { app.error(e) }
        }
        "wait-for" | "wait" => {}
        // Every harness on every machine, as C-b s ranks them (the ones that need you first), each
        // a line of -F (#{harness_*}), those -f keeps.
        "list-harnesses" => {
            let template = opt(words, "-F").unwrap_or_else(|| "#{harness_machine}: #{harness_name} (#{harness_engine}) #{harness_state}#{?harness_line,  #{harness_line},}".into());
            let filter = opt(words, "-f");
            let keys: Vec<(String, String)> = app.fleet.ranked().into_iter().map(|a| a.key()).collect();
            let mut lines = Vec::new();
            for key in keys {
                app.format_agent = Some(key);
                let keep = filter.as_ref().map(|f| { let v = expand(app, f); !v.is_empty() && v != "0" }).unwrap_or(true);
                if keep { lines.push(expand(app, &template)) }
            }
            app.format_agent = None;
            app.print("list-harnesses", lines);
        }
        "server-access" => {
            if flag(words, "-l") {
                let user = crate::format::text(app, "#{user}", None);
                let lines = if unsafe { libc::getuid() } == 0 { Vec::new() } else { vec![format!("{user} (W)")] };
                return app.print("server-access", lines);
            }
            let Some(user) = positional(words).first().cloned() else { return app.error("missing user argument") };
            let user = expand(app, &user);
            let pw = std::ffi::CString::new(user.as_str()).ok().map(|n| unsafe { libc::getpwnam(n.as_ptr()) }).unwrap_or(std::ptr::null_mut());
            if pw.is_null() { return app.error(format!("unknown user: {user}")) }
            let uid = unsafe { (*pw).pw_uid };
            if uid == 0 || uid == unsafe { libc::getuid() } { return app.error(format!("{user} owns the server, can't change access")) }
            if flag(words, "-a") && flag(words, "-d") { return app.error("-a and -d cannot be used together") }
            if flag(words, "-r") && flag(words, "-w") { return app.error("-r and -w cannot be used together") }
            app.error("server access is limited to its owner");
        }
        // The server is this client (or a headless one): running already.
        "start-server" => {}
        // tmux locks the terminal with lock-command; hn leaves that to the terminal's own.
        "lock-server" | "lock-session" | "lock-client" => app.error(format!("{command}: hn does not lock the terminal (use your terminal's or the system's lock)")),
        // cmd-show-prompt-history.c: each type's history, oldest first; clear-prompt-history.
        "show-prompt-history" | "clear-prompt-history" => {
            const TYPES: [&str; 4] = ["command", "search", "target", "window-target"];
            let which: Vec<usize> = match opt(words, "-T") {
                Some(t) => match TYPES.iter().position(|x| *x == t) { Some(i) => vec![i], None => return app.error(format!("invalid type: {t}")) },
                None => (0..4).collect(),
            };
            if command == "clear-prompt-history" { for i in which { crate::history::clear(app, i) } return }
            let mut lines = Vec::new();
            for i in which {
                lines.push(format!("History for {}:", TYPES[i]));
                lines.push(String::new());
                for (n, h) in app.history[i].iter().enumerate() { lines.push(format!("{}: {h}", n + 1)) }
                lines.push(String::new());
            }
            app.print(command, lines);
        }
        "pipe-pane" => {
            // cmd-pipe-pane.c [-IOo] [-t pane] [command]: the pane's old pipe closed; then, given a
            // command (expanded as a format), a new one — its stdin what the pane prints (-O, the
            // default), its output typed into the pane (-I) — unless -o and there was one (a key
            // toggles it: bind P pipe-pane -o 'cat >> ~/log').
            let Some((w, p)) = target_pane(app, words) else { return };
            let had = app.pipes.remove(&p).is_some();
            let command = positional(words).first().cloned().unwrap_or_default();
            if command.is_empty() || (flag(words, "-o") && had) { return }
            let (input, output) = if flag(words, "-I") { (true, flag(words, "-O")) } else { (false, true) };
            let command = crate::format::expand(app, &command, w, Some(p), true);
            app.open_pipe(p, &command, input, output);
        }
        "save-buffer" | "saveb" | "show-buffer" => {
            // tmux's save-buffer [-a] [-b buffer-name] path (show-buffer: to the shell, or a view):
            // the newest automatic buffer without -b; a path from the shell's folder (- its stdout).
            let b = match opt(words, "-b") {
                Some(n) => match app.paste.get(&n) { Some(b) => b.clone(), None => return app.error(format!("no buffer {n}")) },
                None => match app.paste.top() { Some(b) => b.clone(), None => return app.error("no buffers") },
            };
            let path = if command == "show-buffer" { "-".to_string() } else { expand(app, &positional(words).first().cloned().unwrap_or_default()) };
            // (The shell's output: printed there, not onto hn's own terminal.)
            if is_stdout(&path) { return app.print_data(command, &b.data) }
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
            let given = expand(app, &positional(words).first().cloned().unwrap_or_default());
            // (The shell's input: what it piped in, never hn's own terminal.)
            if is_stdin(&given) && app.cli_stdin.is_none() { return app.error(format!("{given}: no standard input here")) }
            let path = if is_stdin(&given) { "-".to_string() } else { client_path(app, &given) };
            let text = if path == "-" { app.cli_stdin.clone().unwrap_or_default() } else {
                match std::fs::read(&path) { Ok(t) => String::from_utf8_lossy(&t).into_owned(), Err(e) => return app.error(format!("{path}: {}", io_error(&e))) }
            };
            // -w: to the terminal's clipboard too (OSC 52), when there is a terminal.
            if flag(words, "-w") && !app.headless { crate::clipboard::store_as("", &text) }
            let limit = app.buffer_limit();
            if let Err(e) = app.paste.set(text, opt(words, "-b").as_deref(), limit) { app.error(e) }
        }
        "resize-window" => {
            // An explicit resize gives any window a manual size, including one on screen.
            let Some(w) = opt(words, "-t").map(|t| window_target(app, &t)).unwrap_or(Some(app.active)) else { return app.error(format!("can't find window: {}", opt(words, "-t").unwrap_or_default())) };
            let old = app.tabs[w].root.as_ref().map(|r| r.size()).unwrap_or_else(|| app.default_size());
            let (mut x, mut y) = (old.0 as i64, old.1 as i64);
            let by = match positional(words).first() {
                Some(v) => match strtonum(v, 1, i32::MAX as i64) { Ok(n) => n, Err(e) => return app.error(format!("adjustment {e}")) },
                None => 1,
            };
            if let Some(v) = opt(words, "-x") { x = match strtonum(&v, 1, 10000) { Ok(n) => n, Err(e) => return app.error(format!("width {e}")) } }
            if let Some(v) = opt(words, "-y") { y = match strtonum(&v, 1, 10000) { Ok(n) => n, Err(e) => return app.error(format!("height {e}")) } }
            if flag(words, "-L") { if x >= by { x -= by } }
            else if flag(words, "-R") { x += by }
            else if flag(words, "-U") { if y >= by { y -= by } }
            else if flag(words, "-D") { y += by }
            if flag(words, "-A") || flag(words, "-a") { let body = app.body(); x = body.width as i64; y = body.height as i64 }
            let size = (x.clamp(1, 10000) as u16, y.clamp(1, 10000) as u16);
            app.tabs[w].size = Some(size);
            app.options.windows.entry(app.tabs[w].id.clone()).or_default().insert("window-size".into(), "manual".into());
            app.fit_panes();
            if app.headless && old != size { app.view_layout_changed(w) }
        }
        "respawn-window" => {
            // tmux's respawn-window: refused while anything runs in the window, unless -k.
            let w = match opt(words, "-t") { Some(t) => match window_target(app, &t) { Some(w) => w, None => return }, None => app.active };
            let panes = app.tabs[w].panes();
            if !flag(words, "-k") && panes.iter().any(|p| pane_alive(app, *p)) { return app.error(format!("respawn window failed: window {}:{} still active", app.session_name(), app.win_num(w))) }
            let (command, cwd) = (shell_command(words), opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty()));
            // spawn_window keeps the first pane, discards the other splits, and selects
            // this window. respawn-pane leaves both the layout and selection alone.
            if let Some(&first) = panes.first() {
                for p in panes.into_iter().skip(1) { app.close_pane(p) }
                app.tabs[w].set_active(first);
                respawn(app, first, command, cwd);
            }
            app.select_tab(w);
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
            // -w: to the terminal's clipboard too (OSC 52), when there is a terminal.
            if flag(words, "-w") && !app.headless { crate::clipboard::store_as("", &data) }
            let limit = app.buffer_limit();
            if let Err(e) = app.paste.set(data, name.as_deref(), limit) { app.error(e) }
        }
        "respawn-pane" => {
            // tmux's respawn-pane: a pane whose harness still runs needs -k.
            let Some((w, p)) = target_pane(app, words) else { return };
            if !flag(words, "-k") && pane_alive(app, p) { return app.error(format!("respawn pane failed: pane {} still active", pane_name(app, w, p))) }
            let (command, cwd) = (shell_command(words), opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty()));
            respawn(app, p, command, cwd);
        }
        "suspend-client" => app.suspend = true,
        "rename-session" => {
            // session_check_name (`:` and `.` as `_`); another session's name is refused.
            let raw = positional(words).first().cloned().unwrap_or_default();
            let Some(name) = crate::app::session_check_name(&raw) else { return app.error(format!("invalid session: {raw}")) };
            if name != app.session_name() && app.find_session(&format!("={name}")).is_some() { return app.error(format!("duplicate session: {name}")) }
            let renamed = name != app.session_name();
            app.session_alias = Some(name.clone());
            app.save_sessions();
            if renamed { let sid = app.session_id; notify_session(app, "session-renamed", sid, &name, None) }
        }
        // A mode of the pane (window-clock.c): -t's, or this one; it stays there while you go
        // elsewhere, until a key reaches the pane.
        "clock-mode" => { if let Some((_, p)) = target_pane(app, words) { if let Some(pane) = app.panes.get_mut(&p) { pane.clock = true; app.redraw_all = true } } }
        "refresh-client" => { app.redraw_all = true; for id in app.panes.keys().copied().collect::<Vec<_>>() { if app.rects.iter().any(|(r, _)| *r == id) { app.open_stream(id, false) } } }
        // Every session goes, the saved ones too (the harnesses keep running) — and every other
        // client of this server name with them.
        "kill-server" => {
            for other in other_clients() { let _ = crate::ipc::ask(&other, &["hn-kill-client".into()]); }
            app.sessions.clear(); app.session_alias = None; app.forget_sessions = true; app.quit = true
        }
        // kill-server, from another client of this name: this one's sessions go, and it exits.
        "hn-kill-client" => { app.sessions.clear(); app.session_alias = None; app.forget_sessions = true; app.quit = true }
        // A client attached: a headless hn gives it every session, and goes.
        // Another client changed the server's state (options, keys, buffers, environment).
        "hn-server-sync" => crate::server::take(app),
        // move-window between two clients' sessions: this one's window given up, described
        // (hn-take-window -s), or one put here (hn-put-window -t … -j <window> [-d]).
        "hn-take-window" => {
            let Some(t) = opt(words, "-s") else { return app.error("missing -s") };
            let (sid, i) = match window_of_target(app, &t) { Ok(x) => x, Err(e) => return app.error(e) };
            let back = app.session_id;
            if sid != back { app.swap_back = Some(back); app.swap_session(sid); }
            let win = app.window_json(&app.tabs[i], None);
            let (sname, wid, wname) = (app.session_name(), app.tabs[i].wid(), app.tabs[i].name.clone());
            let tab = app.take_tab(i);
            for p in tab.panes() {
                if let Some(k) = app.panes.get(&p).map(|x| (x.machine_id.clone(), x.agent_id.clone())) { app.shells.remove(&k); }
                app.forget_pane(p);
            }
            notify_session(app, "window-unlinked", sid, &sname, Some((wid, wname)));
            if app.tabs.iter().all(|t| t.root.is_none()) && !app.session_desk {
                app.swap_back = (sid != back).then_some(back);
                app.session_gone();
            }
            if app.session_id != back && !app.quit { app.swap_session(back); }
            app.swap_back = None;
            app.fit_panes();
            app.save_sessions();
            app.print("hn-take-window", vec![win.to_string()]);
        }
        "hn-put-window" => {
            let Some(t) = opt(words, "-t") else { return app.error("missing -t") };
            let Some(win) = opt(words, "-j").and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok()) else { return app.error("missing -j") };
            let s = t.split(':').next().unwrap_or(&t).to_string();
            let Some(dst) = app.find_session(&s) else { return app.error(format!("can't find session: {}", s.trim_start_matches('='))) };
            put_window(app, dst, &t, &win, flag(words, "-d"));
        }
        // A client shows a session of this one's (-a its socket, -t the session), or no longer (-d).
        "hn-mirror" => {
            if let Some(sock) = opt(words, "-a") {
                let sid = opt(words, "-t").and_then(|t| t.trim_start_matches('$').parse::<u32>().ok()).unwrap_or(app.session_id);
                if let Some(tty) = opt(words, "-c") { app.mirror_ttys.insert(sock.clone(), tty); }
                app.mirrors.insert(sock, sid);
                // A client went to it (server_client_set_session): used and attached now — the
                // session a command from a shell with no -t is for.
                let now = crate::app::epoch_secs();
                if sid == app.session_id { app.session_used = crate::app::use_order(); app.session_activity = now; app.session_last_attached = now }
                else if let Some(s) = app.sessions.iter_mut().find(|s| s.id == sid) { s.used = crate::app::use_order(); s.activity = now; s.last_attached = now }
                app.save_sessions();
            } else if let Some(sock) = opt(words, "-d") {
                let sid = opt(words, "-t").and_then(|t| t.trim_start_matches('$').parse::<u32>().ok());
                // Switching between two sessions of this owner registers the new session before
                // dropping the old one. Its late unregister must not remove the new attachment.
                if sid.is_none() || app.mirrors.get(&sock).copied() == sid { app.mirrors.remove(&sock); app.mirror_ttys.remove(&sock); app.save_sessions(); }
            }
            app.status_redraws += 1;
        }
        // The client that has the session this one shows changed it, or went.
        "hn-mirror-refresh" => crate::mirror::refresh(app),
        "hn-hand-over" => { app.write_sessions(crate::app::Save::Leave); app.handed_over = true; app.quit = true }
        // Another client of this name takes a session this one has (it attached there).
        "hn-release-session" => {
            let Some(t) = opt(words, "-t") else { return app.error("missing -t") };
            if let Err(e) = app.release_session(&t) { app.error(e) }
        }
        "kill-session" => {
            // -C: the windows' alerts cleared; -a: every other session; else this one (or -t's),
            // its windows closed as kill-window closes them — the last taking the session with it,
            // and the client to another session or out (detach-on-destroy).
            if flag(words, "-C") { for t in app.tabs.iter_mut() { t.alerts = 0 } return }
            if flag(words, "-a") {
                let (me, back) = (app.session_id, app.swap_back);
                // (Not the desk's, nor another terminal's shown here: this client's own.)
                for id in app.sessions.iter().filter(|s| !s.desk && s.mirror.is_none()).map(|s| s.id).collect::<Vec<_>>() {
                    app.swap_back = Some(me);
                    app.swap_session(id);
                    kill_windows(app);
                    app.swap_session(me);
                }
                app.swap_back = back;
                // The session this terminal showed was among them: as tmux's clients of a
                // destroyed session — [exited] (detach-on-destroy on), else here on -t's.
                if let Some(shown) = back.filter(|b| *b != me && !app.sessions.iter().any(|s| s.id == *b)) {
                    let _ = shown;
                    app.swap_back = None;
                    app.last_session = None;
                    let how = app.options.get("detach-on-destroy", "", None).unwrap_or_default();
                    if !app.headless && !matches!(how.as_str(), "off" | "no-detached") { app.exited = true; app.quit = true }
                }
                return;
            }
            kill_windows(app);
        }
        "attach-session" => {
            // attach -t: the client to that session (it is attached already); another client's
            // shown here as it has it (-r only watched), or taken with -d (that client detaching).
            let how = if flag(words, "-d") { crate::app::Attach::Take } else if flag(words, "-r") { crate::app::Attach::Watch } else { crate::app::Attach::Share };
            if let Some(t) = opt(words, "-t") {
                match app.find_session(t.split(':').next().unwrap_or(&t)) { Some(id) => app.switch_session_as(id, how), None => return app.error(format!("can't find session: {t}")) }
            }
            // -c: the session's start directory from now on (a format, as tmux expands it).
            if let Some(c) = opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty()) { app.session_path = Some(c) }
        }
        "new-session" => {
            // tmux's new-session [-AdP] [-c start-directory] [-F format] [-n window-name]
            // [-s session-name] [shell-command]: a session (-s, else its number) with one window,
            // a shell (or the command) in -c; gone to unless -d; -A: to the one of that name if
            // there is one; -P printed (#{session_name}: or -F).
            let name = opt(words, "-s");
            if flag(words, "-A") {
                if let Some(id) = name.as_deref().and_then(|n| app.find_session(&format!("={n}"))) { if !flag(words, "-d") { app.switch_session(id) } return }
            }
            // -t: a session in that one's group, sharing its windows (no shell of its own).
            if let Some(t) = opt(words, "-t") {
                if !positional(words).is_empty() || opt(words, "-n").is_some() { return app.error("command or window name given with target") }
                // -t names a session (or a window or pane of one), else a group (session_group_find):
                // one of its sessions — or, none yet, a new group of that name the new session starts.
                let target = app.find_session(&t).or_else(|| target_session(app, &t)).or_else(|| app.group_member(&t));
                let Some(target) = target else {
                    let Some(g) = crate::app::session_check_name(&t) else { return app.error(format!("invalid session group name: {t}")) };
                    let cwd = opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty());
                    match app.new_session(name.as_deref(), None, cwd, None, flag(words, "-d")) {
                        Ok(id) => {
                            if id == app.session_id { app.session_group = Some(g) } else if let Some(s) = app.sessions.iter_mut().find(|s| s.id == id) { s.group = Some(g) }
                            if app.headless || flag(words, "-d") { let size = app.default_size(); app.size_session(id, size) }
                            app.save_sessions();
                            if flag(words, "-P") { let line = crate::format::expand_session(app, &opt(words, "-F").unwrap_or_else(|| "#{session_name}:".into()), id); app.print("new-session", vec![line]) }
                        }
                        Err(e) => app.error(e),
                    }
                    return;
                };
                match app.group_session(target, name.as_deref(), flag(words, "-d")) {
                    Ok(id) => if flag(words, "-P") {
                        let line = crate::format::expand_session(app, &opt(words, "-F").unwrap_or_else(|| "#{session_name}:".into()), id);
                        app.print("new-session", vec![line]);
                    },
                    Err(e) => app.error(e),
                }
                return;
            }
            let cwd = opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty());
            let detached = flag(words, "-d");
            // -P: printed once its pane is there (#{pane_index}, #{pane_id}), as new-window -P.
            if flag(words, "-P") { app.print_new = Some(opt(words, "-F").unwrap_or_else(|| "#{session_name}:".into())) }
            match app.new_session(name.as_deref(), opt(words, "-n").as_deref(), cwd, shell_command(words), detached) {
                // A session no terminal shows yet: -x by -y, else default-size (tmux's 80x24).
                Ok(id) => {
                // -e NAME=value: into the session's environment (environ_put).
                let puts: Vec<(String, String)> = words.args.as_ref().map(|a| a.all('e').into_iter().filter_map(|v| v.split_once('=').map(|(k, v)| (k.to_string(), v.to_string()))).collect()).unwrap_or_default();
                for (k, v) in puts {
                    let var = crate::app::EnvVar { value: Some(v), hidden: false };
                    if id == app.session_id { app.session_env.insert(k, var); } else if let Some(st) = app.sessions.iter_mut().find(|st| st.id == id) { st.env.insert(k, var); }
                }
                if detached || app.headless {
                    let (dx, dy) = app.default_size();
                    let n = |f: &str, d: u16| opt(words, f).and_then(|v| v.parse::<u16>().ok()).filter(|v| *v > 0).unwrap_or(d);
                    let size = (n("-x", dx), n("-y", dy));
                    // -x/-y: the session's own default-size, as tmux keeps them (its next windows
                    // that size too).
                    if opt(words, "-x").is_some() || opt(words, "-y").is_some() {
                        let v = format!("{}x{}", size.0, size.1);
                        if id == app.session_id { app.options.session.insert("default-size".into(), v); }
                        else if let Some(st) = app.sessions.iter_mut().find(|st| st.id == id) { st.options.insert("default-size".into(), v); }
                    }
                    app.size_session(id, size);
                }
                }
                Err(e) => { app.print_new = None; app.error(e) }
            }
        }
        "detach-client" => {
            // -s: the clients showing that session (this one, another of this name's, or none: one
            // not found is nothing); -a: every other client of this name; -t: that client, by its
            // tty (this one or another), or tmux's error. -E: each becomes that shell command
            // (MSG_EXEC); -P: each one's parent is sent SIGHUP.
            let exec = opt(words, "-E");
            let hup = flag(words, "-P");
            let mut go: Vec<String> = vec!["detach-client".into()];
            if let Some(e) = &exec { go.extend(["-E".to_string(), e.clone()]) }
            if hup { go.push("-P".into()) }
            let leave = |app: &mut App| { app.exec_after = exec.clone(); app.hup_parent = hup && exec.is_none(); app.quit = true };
            if let Some(s) = opt(words, "-s") {
                let Some(id) = app.find_session(&s) else { return };
                // The clients showing it as this one has it (mirror.rs), and the one that has it.
                let theirs: Vec<String> = app.mirrors.iter().filter(|(_, m)| **m == id).map(|(k, _)| k.clone()).collect();
                for m in theirs { app.mirrors.remove(&m); crate::ipc::notify_now(std::path::Path::new(&m), &go) }
                if let Some(owner) = app.remote_owner(id).filter(|_| !crate::ipc::forwarded()) {
                    let mut ask = go.clone();
                    ask.extend(["-s".to_string(), format!("${id}")]);
                    let _ = crate::ipc::ask(std::path::Path::new(&owner), &ask);
                }
                if id == app.session_id { leave(app) }
                return;
            }
            if flag(words, "-a") { for other in other_clients() { let _ = crate::ipc::ask(&other, &go); } return }
            if let Some(t) = opt(words, "-t") {
                let t = t.strip_suffix(':').unwrap_or(&t).to_string();
                let tty = crate::app::tty_name();
                if t != tty && Some(t.as_str()) != tty.strip_prefix("/dev/") {
                    let mut ask = go.clone();
                    ask.extend(["-t".to_string(), t.clone()]);
                    for other in other_clients() { if matches!(crate::ipc::ask(&other, &ask), Some((_, _, 0))) { return } }
                    return app.error(format!("can't find client: {t}"))
                }
            }
            leave(app);
        }
        "switch-client" => {
            // -r: the client read-only (and its size ignored), or not — turned over.
            if flag(words, "-r") {
                if app.client_flags.iter().any(|f| f == "read-only") { app.client_flags.retain(|f| f != "read-only" && f != "ignore-size") }
                else { app.client_flags.extend(["read-only".to_string(), "ignore-size".to_string()]) }
                app.status_redraws += 1;
                if opt(words, "-t").is_none() && opt(words, "-T").is_none() { return }
            }
            // -T: the key table the next key is looked up in (tmux's modal keys).
            if let Some(t) = opt(words, "-T") {
                match t.as_str() {
                    "root" => { app.key_table = None; app.prefix = false }
                    "prefix" => { app.key_table = None; app.prefix = true; app.prefix_at = Some(std::time::Instant::now()) }
                    _ if app.keymap.named.contains_key(&t) => { app.key_table = Some(t); app.prefix = false; app.key_table_until = None }
                    _ => app.error(format!("table {t} doesn't exist")),
                }
                return;
            }
            // -l the last session, -n and -p the next and previous by name (round), as tmux's.
            if flag(words, "-l") {
                match app.last_session.filter(|l| app.find_session(&format!("${l}")).is_some()) { Some(id) => app.switch_session(id), None => app.error("can't find last session") }
            } else if flag(words, "-n") {
                match app.neighbour_session(true) { Some(id) => app.switch_session(id), None => app.error("can't find next session") }
            } else if flag(words, "-p") {
                match app.neighbour_session(false) { Some(id) => app.switch_session(id), None => app.error("can't find previous session") }
            } else if let Some(t) = opt(words, "-t") {
                // tmux: a target with `:`, `.` or `%` is a pane (its session, window and pane become
                // the current ones), else a session.
                let kind = if t.contains([':', '.', '%']) { crate::cmd::Kind::Pane } else { crate::cmd::Kind::Session };
                let session = if let Some(p) = t.strip_prefix('%') { crate::pane::from_tag(p).and_then(|p| app.session_of_pane(p)) }
                    else if kind == crate::cmd::Kind::Session { match app.find_session(&t) { Some(id) => Some(id), None => return app.error(format!("can't find session: {t}")) } }
                    else { t.split_once(':').map(|(s, _)| s).filter(|s| !s.is_empty()).and_then(|s| app.find_session(s)) };
                if let Some(id) = session { app.switch_session(id) }
                if kind == crate::cmd::Kind::Session { return }
                let t = match t.split_once(':') { Some((s, rest)) if !s.is_empty() => format!(":{rest}"), _ => t.clone() };
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
                // A pane in the tree: its mode has the event (window_tree_key).
                if app.panes.get(&pane).map(|p| p.tree_top()).unwrap_or(false) {
                    if let Some(k) = m.key { crate::tree::key(app, pane, k, Some(&m), true) }
                    return;
                }
                if app.panes.get(&pane).map(|p| p.in_mode()).unwrap_or(false) || m.wp != Some(pane) { return }
                return crate::mouse::input_key_mouse(app, pane, &m);
            }
            // -K: the keys as if typed at the client — its key tables, its bindings, then the pane
            // (server_client_handle_key); nothing where no terminal is attached.
            if flag(words, "-K") && !flag(words, "-X") {
                let Some(args) = words.args.clone() else { return };
                if app.headless { return }
                let count = match args.get('N').map(|n| expand(app, n)) {
                    None => 1,
                    Some(n) => match n.parse::<i64>() {
                        Ok(n) if n >= 1 && n <= u32::MAX as i64 => n as u32,
                        Ok(n) if n < 1 => return app.error("repeat count too small"),
                        Ok(_) => return app.error("repeat count too large"),
                        Err(_) => return app.error("repeat count invalid"),
                    },
                };
                // The injected keys belong to the attached client's queue. A prompt opened
                // by a binding must not hold the CLI that sent those keys until it closes.
                let caller = (app.capture.take(), app.capture_err.take(), app.cli_tx.take(), app.cli_code, app.wait_cli);
                let mut held = std::mem::take(&mut app.cli_held);
                app.wait_cli = false;
                for _ in 0..count { for word in &args.values {
                    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
                    let parsed = (args.has('l') == 0).then(|| crate::keys::parse(word).ok()).flatten();
                    let events: Vec<KeyEvent> = match parsed {
                        Some(c) => {
                            // Binding chords normalize A to S-a. Restore the original character
                            // for a prompt or pane; an explicit S-a still carries lowercase a.
                            let uppercase = word.rsplit('-').next().is_some_and(|s| s.chars().count() == 1 && s.chars().next().is_some_and(char::is_uppercase));
                            let code = match c.code { KeyCode::Char(ch) if uppercase => KeyCode::Char(ch.to_ascii_uppercase()), code => code };
                            vec![KeyEvent::new(code, c.mods)]
                        }
                        None => word.chars().map(|c| KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)).collect(),
                    };
                    for event in events {
                        // Explicit shifted characters are modified key codes in tmux, not
                        // text for a status prompt (unmodified uppercase text still inserts).
                        let shifted_name = args.has('l') == 0 && word.rsplit_once('-').is_some_and(|(mods, _)| mods.split('-').any(|m| m == "S"));
                        let text_prompt = matches!(&app.modal, Some(Modal::Prompt(p)) if !matches!(p.kind, PromptKind::Key { .. } | PromptKind::Command { digits: true, .. }));
                        if shifted_name && text_prompt && matches!(event.code, KeyCode::Char(_)) { continue }
                        input::handle(app, Event::Key(event));
                    }
                } }
                (app.capture, app.capture_err, app.cli_tx, app.cli_code, app.wait_cli) = caller;
                held.append(&mut app.cli_held);
                app.cli_held = held;
                return;
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
            // cmd_display_popup_exec: -C closes an open one (and nothing opens over one); -w/-h its
            // size (cells or n% of the terminal, half of it by default); placed by -x/-y as a menu
            // is (the middle by default); -B no border; -d the folder; -T a title.
            if flag(words, "-C") { app.close_popup(); return }
            if matches!(app.modal, Some(Modal::Menu(_)) | Some(Modal::Popup { .. })) { return }
            let (sx, sy) = (app.size.0 as i64, app.size.1 as i64);
            let h = match opt(words, "-h") { Some(v) => match percentage(&v, 1, sy, sy) { Ok(n) => n, Err(e) => return app.error(format!("height {e}")) }, None => sy / 2 };
            let w = match opt(words, "-w") { Some(v) => match percentage(&v, 1, sx, sx) { Ok(n) => n, Err(e) => return app.error(format!("width {e}")) }, None => sx / 2 };
            let (w, h) = (w.min(sx) as u16, h.min(sy) as u16);
            let args = words.args.clone().unwrap_or_default();
            let target = args.get('t').and_then(|t| pane_target(app, t)).or_else(|| app.current());
            let Some((x, y)) = menu_position(app, &args, target, w, h) else { return };
            let cwd = opt(words, "-d").map(|d| expand(app, &d)).filter(|d| !d.is_empty());
            let title = opt(words, "-T").map(|t| expand(app, &t)).unwrap_or_default();
            let mut i = 1;
            let mut command = None;
            while i < words.len() {
                match words[i].as_str() { "-w" | "-h" | "-d" | "-T" | "-x" | "-y" | "-t" | "-c" | "-b" | "-s" | "-S" | "-e" => i += 1, w if w.starts_with('-') && w.len() > 1 => {}, w => command = Some(w.to_string()) }
                i += 1;
            }
            // popup.c: -b the box's lines (else popup-border-lines), -s its style and -S its border's
            // (else popup-style and popup-border-style).
            let tab_id = app.tab().id.clone();
            let option = |app: &App, name: &str| app.options.get(name, &tab_id, None).unwrap_or_default();
            let look = crate::modal::PopupLook {
                lines: opt(words, "-b").unwrap_or_else(|| option(app, "popup-border-lines")),
                style: opt(words, "-s").unwrap_or_else(|| option(app, "popup-style")),
                border_style: opt(words, "-S").unwrap_or_else(|| option(app, "popup-border-style")),
            };
            input::popup(app, (x, y, w, h), !flag(words, "-B") && look.lines != "none", cwd, command, title, flag(words, "-E"), look);
        }
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
            // The template: a block (kept marked, filled as parsed), or a string (-F: expanded
            // first), filled then parsed.
            let first = positional(words).first().cloned().unwrap_or_default();
            let block = first.starts_with(crate::tmuxconf::BLOCK);
            let text = first.strip_prefix(crate::tmuxconf::BLOCK).unwrap_or(&first).to_string();
            let text = if flag(words, "-F") && !block { expand(app, &text) } else { text };
            let name = crate::cmdparse::parse(&text, app, true).ok().and_then(|c| c.first().and_then(|c| c.args.first().cloned())).and_then(|a| match a { crate::cmdparse::Arg::Str(s) => Some(s), _ => None });
            let template = if block { first.clone() } else { text.clone() };
            let (labels, spaced): (Vec<String>, bool) = match opt(words, "-p") {
                Some(p) => (p.split(',').map(|l| expand(app, l)).collect(), true),
                None if !text.is_empty() => (vec![format!("({})", name.unwrap_or_default())], true),
                None => (vec![":".into()], false),
            };
            let inputs: Vec<String> = opt(words, "-I").map(|i| i.split(',').map(|v| expand(app, v)).collect()).unwrap_or_default();
            let mut prompts: Vec<(String, String)> = labels.into_iter().enumerate().map(|(k, l)| (if spaced { format!("{l} ") } else { l }, inputs.get(k).cloned().unwrap_or_default())).collect();
            // -T: the prompt's type, for its history.
            let ptype = match opt(words, "-T").as_deref() {
                None | Some("command") => 0, Some("search") => 1, Some("target") => 2, Some("window-target") => 3,
                Some(t) => return app.say(format!("unknown type: {t}"), theme::WARN),
            };
            // -1, else -N, else -i, else -k.
            let (one, digits, incremental) = (flag(words, "-1"), !flag(words, "-1") && flag(words, "-N"), !flag(words, "-1") && !flag(words, "-N") && flag(words, "-i"));
            // A shell that ran it waits for the answer (not with -b or -i).
            app.wait_cli = app.capture.is_some() && !flag(words, "-b") && !incremental;
            if flag(words, "-k") && !one && !digits && !incremental { return app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Key { template }, &prompts[0].0, ""))) }
            let (label, initial) = prompts.remove(0);
            // -i: the input is what C-r and C-s bring back; the line starts empty, and the template
            // runs at once with `=`.
            let (initial, last) = if incremental { (String::new(), initial) } else { (initial, String::new()) };
            let kind = PromptKind::Command { template: (!text.is_empty()).then_some(template), more: prompts, answers: Vec::new(), one, digits, incremental, ptype, last };
            let p = Prompt::status(kind, &label, &initial);
            if incremental { input::prompt_changed(app, &p, '=') }
            app.modal = Some(Modal::Prompt(p));
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
            app.modal = Some(Modal::Menu(crate::modal::Menu { title, items, choice, x, y, width, stay_open: args.has('O') > 0, no_mouse, mouse: app.mouse_ev.clone(), tree: None, complete: None }));
            app.wait_cli = app.capture.is_some();
        }
        "customize-mode" => {
            if app.headless { return }
            // tmux's options-and-keys tree, read here as one list: the server's, the session's and
            // the windows' options as they are, then every key.
            let mut lines = Vec::new();
            for (title, f) in [("Server Options", crate::options::SetFlags { server: true, ..Default::default() }), ("Session Options", crate::options::SetFlags { global: true, ..Default::default() }), ("Window & Pane Options", crate::options::SetFlags { global: true, window: true, ..Default::default() })] {
                lines.push(title.to_string());
                lines.extend(app.options.show(None, &f, false, false, crate::options::Which::Options, "", 0).unwrap_or_default().into_iter().map(|l| format!("  {l}")));
                lines.push(String::new());
            }
            lines.push("Key Bindings".into());
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
        "open-viewer" => {
            let options = match crate::viewer::Options::parse(&words[1..]) { Ok(o) => o, Err(e) => return app.error(e) };
            let key = match harness_target(app, words) {
                Ok(Some(k)) => k,
                Ok(None) => match input::focused_key(app) { Some(k) => k, None => return app.error("no harness here — use view -t <harness>") },
                Err(e) => return app.error(e),
            };
            crate::viewer::show(app, key, options);
        }
        "new-harness" => { if words.len() < 2 { input::run(app, "new") } else { input::new_harness_words(app, &words[1..]) } }
        "new-terminal" => input::run(app, "terminal"),
        "choose-command" => input::run(app, "commands"),
        "take-control" => app.take_control(),
        // A harness's verbs, on -t's harness (the hook's in a harness-* hook), else the focused
        // pane's; from a shell -t is needed, and one mid-turn is restarted or paused only with -y
        // (the keys ask first).
        "clone-harness" | "restart-harness" | "pause-harness" | "resume-harness" | "rename-harness" => {
            let verb = words[0].as_str();
            let name = positional_with(words, "t").join(" ");
            let key = match harness_target(app, words) {
                Ok(Some(k)) => k,
                Ok(None) if app.capture.is_some() => return app.error(format!("{verb}: which harness? (-t)")),
                Ok(None) => return match verb {
                    "clone-harness" => input::run(app, "clone"),
                    "restart-harness" => input::run(app, "restart"),
                    "pause-harness" => input::run(app, "pause"),
                    "resume-harness" => input::run(app, "resume-focused"),
                    _ => if name.is_empty() { input::run(app, "rename") } else { input::rename_focused(app, &name) },
                },
                Err(e) => return app.error(e),
            };
            if verb == "rename-harness" && name.trim().is_empty() { return app.error("usage: rename-harness [-t harness] name") }
            input::harness_verb(app, verb, key, flag(words, "-y"), &name);
        }
        "send-task" => { let text = rest(words); if text.is_empty() { input::run(app, "send") } else { input::route_task(app, text) } }
        "broadcast" => { let text = rest(words); if text.is_empty() { input::run(app, "broadcast") } else { input::broadcast(app, &text) } }
        // send-message [-t harness] text: a turn for it — -t's, the hook's harness in a harness-*
        // hook, else the focused pane's.
        "send-message" => {
            let text = positional_with(words, "t").join(" ");
            if text.trim().is_empty() { return app.error("usage: send-message [-t harness] text") }
            let key = match harness_target(app, words) {
                Ok(Some(k)) => k,
                // From a shell: which one is not a guess (as answer-harness).
                Ok(None) if app.capture.is_some() => return app.error("send-message: which harness? (-t)"),
                Ok(None) => match input::focused_key(app) { Some(k) => k, None => return app.error("no harness here (-t)") },
                Err(e) => return app.error(e),
            };
            let name = app.fleet.agent(&key.0, &key.1).map(|a| a.name.clone()).unwrap_or_default();
            match app.link(&key.0) { Some(link) => { link.send("message", serde_json::json!({ "agentId": key.1, "content": text })); } None => app.error(format!("{name}'s machine is not connected")) }
        }
        // answer-harness [-t harness] answer: its question answered — a choice's number (1 the
        // first; 1,3 several where it takes several) or your own words; without -t, the pane's
        // harness, else the first one waiting on you.
        // answer-harness [-l] [-t harness] answer: its question answered — choices by number (2;
        // 1,3 where it takes several), or with -l your own words. -t is a format (a hook's
        // #{hook_harness_id}); in a harness-* hook the hook's harness, from the keys the focused
        // pane's — from a shell, never a guess (an answer may approve a command).
        "answer-harness" => {
            let text = positional_with(words, "t").join(" ");
            if text.trim().is_empty() { return app.error("usage: answer-harness [-l] [-t harness] answer") }
            let key = match harness_target(app, words) {
                Ok(Some(k)) => k,
                Ok(None) if app.capture.is_some() => return app.error("answer-harness: which harness? (-t)"),
                Ok(None) => match input::focused_key(app) { Some(k) => k, None => return app.error("no harness here (-t)") },
                Err(e) => return app.error(e),
            };
            let name = app.fleet.agent(&key.0, &key.1).map(|a| a.name.clone()).unwrap_or_default();
            let Some(q) = app.fleet.agent(&key.0, &key.1).and_then(|a| a.question.clone()) else { return app.error(format!("{name} is not asking anything")) };
            if hook_harness(app).as_ref() == Some(&key) {
                let request = app.hook_state.as_ref().and_then(|s| s.formats.iter().find(|(k, _)| k == "hook_harness_request")).map(|(_, v)| v.as_str());
                if request.is_some_and(|r| !r.is_empty() && r != q.request_id) {
                    return app.error(format!("answer-harness: {name}'s question changed since the hook ran — not answered"));
                }
            }
            let value = if flag(words, "-l") { text.trim().to_string() } else {
                match crate::fleet::choices(&q, &text) { Ok(v) => v, Err(e) => return app.error(format!("answer-harness: {e}")) }
            };
            if !input::answer_with(app, &key.0, &key.1, &value) { app.error(format!("{name}'s machine is not connected")) }
        }
        // open-harness [-bdfhv] [-s harness] [-t target]: a harness into a window of its own in
        // the session (-t's), or split into -t's pane (-h beside, -v below; -b before, -f across
        // the window) — -d not gone to. Open already: gone to.
        "open-harness" => {
            let hooked = hook_harness(app);
            let who = opt(words, "-s").or_else(|| positional(words).first().cloned());
            let (m, a) = match who {
                Some(w) => match find_harness(app, &expand_target(app, &w)) { Ok(k) => k, Err(e) => return app.error(e) },
                None => match hooked { Some(k) => k, None => return app.error("usage: open-harness [-bdfhv] [-s harness] [-t target]") },
            };
            let detached = flag(words, "-d");
            let target = opt(words, "-t").map(|t| expand_target(app, &t));
            // -t's session (billing:, billing:3, billing:1.0; a pane's %N), else this one; another
            // terminal's: done by that terminal.
            let sid = match target.as_deref() {
                Some(t) if t.starts_with('%') => crate::pane::from_tag(&t[1..]).and_then(|p| app.session_of_pane(p).or_else(|| app.remote_session_of(Some(p), None))),
                Some(t) => { let s = t.split(':').next().unwrap_or(t); if s.is_empty() || !t.contains(':') && (flag(words, "-h") || flag(words, "-v")) { Some(app.session_id) } else { app.find_session(s) } }
                None => Some(app.session_id),
            };
            let Some(sid) = sid else { return app.error(format!("can't find session: {}", target.unwrap_or_default())) };
            if let Some(owner) = app.remote_owner(sid) {
                let mut w: Vec<String> = words.iter().filter(|x| !x.starts_with("-s")).cloned().collect();
                w.retain(|x| Some(x) != opt(words, "-s").as_ref());
                w.extend(["-s".to_string(), format!("{m}:{a}")]);
                return forward(app, &owner, &w);
            }
            let back = app.session_id;
            if sid != back { app.swap_back = Some(back); app.swap_session(sid); }
            let rest = target.as_deref().and_then(|t| t.split_once(':').map(|(_, r)| r.to_string()));
            if let Some((w, p)) = app.find_pane(&m, &a) {
                // Open in this session already: gone to (not opened twice).
                if !detached { app.select_tab(w); app.focus_pane(w, p) }
            } else if flag(words, "-h") || flag(words, "-v") {
                let dir = if flag(words, "-h") { Dir::Horizontal } else { Dir::Vertical };
                let pane = match (target.as_deref(), rest.as_deref()) {
                    (Some(t), _) if t.starts_with('%') => pane_target(app, t),
                    (_, Some(r)) if !r.is_empty() => pane_target(app, &format!(":{r}")),
                    (Some(t), None) => pane_target(app, t),
                    _ => app.current(),
                };
                let Some((w, p)) = pane.or_else(|| app.current()) else { if sid != back { app.swap_session(back); app.swap_back = None } return app.error("can't find pane") };
                let at = crate::app::At { tab: app.tabs[w].id.clone(), pane: Some(p), dir, before: flag(words, "-b"), full: flag(words, "-f"), size: None, detached, zoom: false };
                app.open_agent(&m, &a, crate::app::Placement::At(at));
            } else {
                let was = app.tabs.get(app.active).map(|t| t.id.clone());
                app.open_agent(&m, &a, crate::app::Placement::Window);
                // At -t's index (billing:3), as new-window -t puts it.
                let idx = rest.as_deref().and_then(|r| r.split('.').next()).and_then(|r| r.parse::<usize>().ok());
                if let (Some(n), Some((w, _))) = (idx, app.find_pane(&m, &a)) { if let Err(e) = app.move_window(w, Some(n), false, !detached) { app.error(e) } }
                if detached { if let Some(i) = was.and_then(|b| app.tabs.iter().position(|t| t.id == b)) { app.select_tab(i) } }
            }
            if sid != back { app.renumber(); app.swap_session(back); app.swap_back = None; app.fit_panes(); app.save_sessions() }
        }
        "next-harness" => input::next_attention(app, flag(words, "-p")),
        // Harness-era command ids still work, for old configs and the palette.
        other if input::is_command(other) => input::run(app, other),
        other => app.error(format!("unknown command: {other}")),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn os_session_refuses_detach_and_suspend_including_aliases() {
        for command in ["detach-client", "detach", "detach -E sh", "suspend-client", "suspendc", "quit"] {
            let (sink, _) = tokio::sync::mpsc::unbounded_channel();
            let mut app = App::new(19789, sink, (80, 24));
            app.os_session = true;
            app.handed_over = true;
            execute(&mut app, command);
            assert!(!app.quit, "{command}");
            assert!(!app.suspend, "{command}");
            assert!(app.exec_after.is_none(), "{command}");
            assert_eq!(app.errors, 1, "{command}");
        }
    }

    #[tokio::test]
    async fn ordinary_client_can_still_detach_and_suspend() {
        for command in ["detach", "suspendc"] {
            let (sink, _) = tokio::sync::mpsc::unbounded_channel();
            let mut app = App::new(19789, sink, (80, 24));
            app.os_session = false;
            app.handed_over = true;
            execute(&mut app, command);
            assert_eq!(app.quit, command == "detach");
            assert_eq!(app.suspend, command == "suspendc");
            assert_eq!(app.errors, 0);
        }
    }

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

    #[tokio::test]
    async fn split_percentages_expand_formats_without_strftime() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let app = App::new(19789, sink, (80, 24));
        let size = |flag: &str, value: &str| split_size(&app, &Words::plain(vec!["split-window".into(), flag.into(), value.into()]));
        assert_eq!(size("-l", "35%"), Ok(Some((35, true))));
        assert_eq!(size("-l", "#{client_width}%"), Ok(Some((80, true))));
        assert_eq!(size("-l", "35"), Ok(Some((35, false))));
        assert_eq!(size("-p", "35"), Ok(Some((35, true))));
        for flag in ["-l", "-p"] { assert_eq!(size(flag, "%H"), Err("size invalid".into())); }
    }

    #[test]
    fn resolves_aliases() {
        assert_eq!(resolve("splitw"), "split-window");
        assert_eq!(resolve("neww"), "new-window");
        assert_eq!(resolve("whatever"), "whatever");
    }
}
