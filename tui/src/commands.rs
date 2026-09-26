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
    ("new-window", "neww", "Create a window, and choose the harness for it"),
    ("split-window", "splitw", "Split the pane (-h beside, default below) and choose its harness"),
    ("kill-pane", "killp", "Close the active pane (the harness keeps running)"),
    ("kill-window", "killw", "Close the window (its harnesses keep running)"),
    ("next-window", "next", "Next window (-a: next with an alert)"),
    ("previous-window", "prev", "Previous window (-a: previous with an alert)"),
    ("last-window", "last", "The previously current window"),
    ("select-window", "selectw", "Select a window: -t <index>"),
    ("rename-window", "renamew", "Rename the window"),
    ("move-window", "movew", "Move the window: -L, -R or -t <index>"),
    ("select-pane", "selectp", "Select a pane: -L -R -U -D, -t :.+"),
    ("last-pane", "lastp", "The previously active pane"),
    ("resize-pane", "resizep", "Resize: -L -R -U -D [n], or -Z to zoom"),
    ("swap-pane", "swapp", "Swap the pane: -U or -D"),
    ("break-pane", "breakp", "Move the pane to a window of its own"),
    ("rotate-window", "rotatew", "Rotate the panes (-D: the other way)"),
    ("next-layout", "nextl", "The next layout"),
    ("select-layout", "selectl", "even-horizontal even-vertical main-horizontal main-vertical tiled, -E spread"),
    ("display-panes", "displayp", "Show pane numbers; press one to select it"),
    ("copy-mode", "copy-mode", "Copy mode (-u: and scroll up)"),
    ("paste-buffer", "pasteb", "Paste the most recent buffer into the pane"),
    ("choose-buffer", "choose-buffer", "Choose a paste buffer"),
    ("list-buffers", "lsb", "List paste buffers"),
    ("delete-buffer", "deleteb", "Delete the most recent buffer"),
    ("choose-tree", "choose-tree", "-w windows · -s harnesses · -m machines · -a waiting · -i models · -S store"),
    ("find-window", "findw", "Search every harness on every machine"),
    ("display-message", "display", "Show information about the pane, or a message"),
    ("show-messages", "showmsgs", "Messages so far"),
    ("list-keys", "lsk", "Every key binding"),
    ("list-windows", "lsw", "The windows"),
    ("list-panes", "lsp", "The panes in this window"),
    ("list-sessions", "ls", "The session (this computer) and its windows"),
    ("list-clients", "lsc", "This client"),
    ("show-options", "show", "Options as they are now"),
    ("set-option", "set", "Set an option: set -g mouse on"),
    ("bind-key", "bind", "Bind a key: bind h select-pane -L"),
    ("unbind-key", "unbind", "Unbind a key"),
    ("source-file", "source", "Read a tmux.conf again: source ~/.tmux.conf"),
    ("swap-window", "swapw", "Swap this window with another: swap-window -t 2"),
    ("join-pane", "joinp", "Move this pane into another window: join-pane -t :1"),
    ("move-pane", "movep", "Same as join-pane"),
    ("clear-history", "clearhist", "Forget this pane's scrollback (here)"),
    ("capture-pane", "capturep", "Copy the visible pane into a paste buffer"),
    ("set-buffer", "setb", "Put text in a paste buffer"),
    ("show-buffer", "showb", "Show the newest paste buffer"),
    ("respawn-pane", "respawnp", "Restart the harness in this pane"),
    ("suspend-client", "suspendc", "Suspend (C-z); fg brings it back"),
    ("rename-session", "rename", "Sessions are computers here — rename it from the desktop app"),
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
    let mut commands = vec![Vec::new()];
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
                        if in_word || !word.is_empty() { commands.last_mut().unwrap().push(std::mem::take(&mut word)); in_word = false }
                        commands.last_mut().unwrap().push(";".into());
                        continue;
                    }
                    word.push(n); in_word = true
                }
            }
            (None, ';') if word.is_empty() && !in_word => commands.push(Vec::new()),
            (None, ';') if chars.peek().map(|n| n.is_whitespace()).unwrap_or(true) => { commands.last_mut().unwrap().push(std::mem::take(&mut word)); in_word = false; commands.push(Vec::new()) }
            (None, '#') if word.is_empty() && !in_word => break,
            (None, c) if c.is_whitespace() => { if in_word || !word.is_empty() { commands.last_mut().unwrap().push(std::mem::take(&mut word)); in_word = false } }
            (None, c) => { word.push(c); in_word = true }
        }
    }
    if in_word || !word.is_empty() { commands.last_mut().unwrap().push(word) }
    commands.retain(|c| !c.is_empty());
    commands
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

/// A window target, as tmux reads one: `:2`, `=2`, `^` first, `$` last, `!` the last window,
/// `+`/`-` (with a count) next/previous, or a name's start.
fn window_target(app: &App, target: &str) -> Option<usize> {
    let t = target.trim_start_matches(':').trim_start_matches('=');
    let n = app.tabs.len();
    if n == 0 { return None }
    match t {
        "" => Some(app.active),
        "^" => Some(0),
        "$" => Some(n - 1),
        "!" => app.last_tab.as_ref().and_then(|id| app.tabs.iter().position(|x| &x.id == id)),
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
            let (c, r) = p.map(|p| (p.cols, p.rows)).unwrap_or((0, 0));
            let title = p.and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| a.name.clone()).unwrap_or_default();
            let machine = p.map(|p| app.fleet.machine_name(&p.machine_id)).unwrap_or_default();
            format!("{}: [{c}x{r}] \"{title}\" {machine} %{id}{}", i + app.pane_base_index, if Some(*id) == app.focused() { " (active)" } else { "" })
        }).collect(),
        "list-sessions" => {
            let mut out = vec![format!("{}: {} windows (attached)", app.session_name(), app.tabs.len())];
            for m in &app.fleet.machines { if m.id != app.fleet.local_id { out.push(format!("  {} — a machine; its harnesses open in any window", m.name)) } }
            out
        }
        "list-clients" => vec![format!("{}: {} [{}x{} {}] (utf8)", std::env::var("SSH_TTY").or_else(|_| std::env::var("TTY")).unwrap_or_else(|_| "tty".into()), app.session_name(), app.size.0, app.size.1, std::env::var("TERM").unwrap_or_default())],
        _ => vec![
            format!("base-index {}", app.base_index),
            format!("mode-keys {}", if app.opts.mode_keys_emacs == Some(true) { "emacs" } else { "vi" }),
            format!("renumber-windows {}", if app.opts.renumber_windows == Some(true) { "on" } else { "off" }),
            format!("status {}", if app.opts.status == Some(false) { "off" } else { "on" }),
            format!("status-left {}", app.opts.status_left.clone().map(|s| format!("\"{s}\"")).unwrap_or_else(|| "\"[#S] \"".into())),
            format!("status-right {}", app.opts.status_right.clone().map(|s| format!("\"{s}\"")).unwrap_or_else(|| r##""#{=21:pane_title}" %H:%M %d-%b-%y"##.into())),
            format!("synchronize-panes {}", if app.tab().sync { "on" } else { "off" }),
            format!("pane-border-status {}", if app.opts.border_titles == Some(false) { "off" } else { "top" }),
            format!("@hn-hint-time {}", if app.keymap.hint_ms == u64::MAX { 0 } else { app.keymap.hint_ms }),
            format!("display-panes-time {}", app.display_panes_ms),
            format!("display-time {}", app.display_ms),
            format!("mouse {}", if app.mouse { "on" } else { "off" }),
            format!("pane-base-index {}", app.pane_base_index),
            format!("prefix {}", crate::keys::name(&app.keymap.prefix)),
            format!("prefix2 {}", app.keymap.prefix2.map(|c| crate::keys::name(&c)).unwrap_or_else(|| "None".into())),
            format!("repeat-time {}", app.keymap.repeat_ms),
            format!("status-position {}", if app.status_top { "top" } else { "bottom" }),
        ],
    }
}

fn resolve(name: &str) -> &str {
    COMMANDS.iter().find(|(full, alias, _)| *full == name || *alias == name).map(|(full, _, _)| *full).unwrap_or(name)
}

/// Run a command line (one or more commands separated by `;`).
pub fn execute(app: &mut App, line: &str) {
    for words in split(line) {
        // A bound `\;` runs here as the separator it stood for.
        for part in words.split(|w| w == ";") { if !part.is_empty() { run_words(app, part) } }
    }
}

fn flag(words: &[String], f: &str) -> bool { words.iter().skip(1).any(|w| w == f || (w.starts_with('-') && !w.starts_with("--") && w.len() > 2 && w[1..].contains(&f[1..]) && f.len() == 2)) }
fn opt(words: &[String], f: &str) -> Option<String> {
    let at = words.iter().position(|w| w == f)?;
    words.get(at + 1).cloned()
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
    match command {
        "new-window" => {
            let was = app.active;
            let cwd = opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty());
            let command = shell_command(words);
            app.new_tab();
            if let Some(name) = opt(words, "-n") { app.rename_tab(&name) }
            // -d: made, not gone to.
            if flag(words, "-d") { let id = app.tabs[was.min(app.tabs.len() - 1)].id.clone(); if let Some(i) = app.tabs.iter().position(|t| t.id == id) { app.select_tab(i) } return }
            // -P: the harness list in it, instead of a shell.
            if flag(words, "-P") { input::launch(app, "", Filter::All); return }
            input::new_shell(app, Placement::Auto(None), cwd, command);
        }
        "split-window" => {
            let dir = if flag(words, "-h") { Dir::Horizontal } else { Dir::Vertical };
            // A shell, as tmux gives; `split-window -P` (or an empty window) picks a harness instead.
            if flag(words, "-P") { input::split_pick(app, dir); return }
            let cwd = opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty());
            let command = shell_command(words);
            let placement = if app.tab().root.is_none() { Placement::Auto(None) } else { Placement::Split(dir) };
            input::new_shell(app, placement, cwd, command);
        }
        "kill-pane" => { if let Some(f) = app.focused() { app.close_pane(f) } else if app.tabs.len() > 1 { let i = app.active; app.close_tab(i) } }
        "kill-window" => { let i = app.active; app.close_tab(i) }
        "next-window" => if flag(words, "-a") { input::run(app, "next-waiting") } else { let n = app.tabs.len(); let i = (app.active + 1) % n; app.select_tab(i) },
        "previous-window" => if flag(words, "-a") { input::run(app, "prev-waiting") } else { let n = app.tabs.len(); let i = (app.active + n - 1) % n; app.select_tab(i) },
        "last-window" => input::run(app, "last-tab"),
        "select-window" => {
            let target = opt(words, "-t").or_else(|| Some(rest(words))).unwrap_or_default();
            if flag(words, "-l") { input::run(app, "last-tab"); return }
            match window_target(app, &target) { Some(i) => app.select_tab(i), None => app.say(format!("Can't find window: {}", target.trim_start_matches(':')), theme::WARN) }
        }
        "rename-window" => { let name = rest(words); if !name.trim().is_empty() { app.rename_tab(name.trim()) } }
        "move-window" => {
            if flag(words, "-L") { app.move_tab(-1) } else if flag(words, "-R") { app.move_tab(1) }
            else if let Some(n) = opt(words, "-t").or_else(|| Some(rest(words))).and_then(|t| t.trim_start_matches(':').parse::<usize>().ok()) {
                if let Err(e) = app.move_tab_to(n) { app.say(e, theme::WARN) }
            }
        }
        "select-pane" => {
            if flag(words, "-m") { app.say("marked panes are not used here", theme::WARN); return }
            let toward = if flag(words, "-L") { Some(Toward::Left) } else if flag(words, "-R") { Some(Toward::Right) } else if flag(words, "-U") { Some(Toward::Up) } else if flag(words, "-D") { Some(Toward::Down) } else { None };
            match toward {
                Some(t) => app.focus_toward(t),
                None => {
                    let target = opt(words, "-t").unwrap_or_default();
                    if target.ends_with(".+") || target.ends_with('+') { app.cycle_pane(1) }
                    else if target.ends_with(".-") || target.ends_with('-') { app.cycle_pane(-1) }
                    else if let Ok(n) = target.trim_start_matches(":.").trim_start_matches('.').parse::<usize>() { app.select_pane_index(n.saturating_sub(app.pane_base_index)) }
                }
            }
        }
        "last-pane" => app.last_pane(),
        "resize-pane" => {
            if flag(words, "-Z") { input::run(app, "zoom"); return }
            let n: f32 = rest(words).trim().parse().unwrap_or(1.0);
            let (dir, sign) = if flag(words, "-L") { (Dir::Horizontal, -1.0) } else if flag(words, "-R") { (Dir::Horizontal, 1.0) } else if flag(words, "-U") { (Dir::Vertical, -1.0) } else { (Dir::Vertical, 1.0) };
            app.resize_focused(dir, sign * n);
        }
        "swap-pane" => app.swap_pane(if flag(words, "-U") { -1 } else { 1 }),
        "break-pane" => { if app.tab().panes().len() < 2 { app.say("can't break with only one pane", theme::WARN) } else { input::run(app, "pane-tab") } }
        "rotate-window" => app.rotate(if flag(words, "-D") { -1 } else { 1 }),
        "next-layout" => app.next_layout(),
        "select-layout" => {
            if flag(words, "-E") { input::run(app, "equalize"); return }
            let preset = match rest(words).trim() {
                "even-horizontal" => Preset::Columns, "even-vertical" => Preset::Rows,
                "main-horizontal" | "main-horizontal-mirrored" => Preset::MainRow, "main-vertical" | "main-vertical-mirrored" => Preset::MainStack,
                "tiled" => Preset::Grid,
                "" => { input::run(app, "layout"); return }
                other => { app.say(format!("unknown layout: {other}"), theme::WARN); return }
            };
            app.apply_preset(preset);
        }
        "display-panes" => app.modal = Some(Modal::DisplayPanes { until: std::time::Instant::now() + std::time::Duration::from_millis(app.display_panes_ms) }),
        "copy-mode" => { input::run(app, "copy-mode"); if flag(words, "-u") { if let Some(f) = app.focused() { if let Some(p) = app.panes.get_mut(&f) { let half = p.rows as i32 - 2; p.copy_move(0, -half) } } } }
        "search-backward" | "search-forward" => { if let Some(pane) = app.focused() { app.modal = Some(Modal::Find { pane, query: String::new(), found: None, up: command == "search-backward" }) } }
        "paste-buffer" => input::paste_buffer(app, 0),
        "list-buffers" | "choose-buffer" => input::run(app, "choose-buffer"),
        "delete-buffer" => { if !app.buffers.is_empty() { app.buffers.remove(0); } }
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
            // display [-p] [-d ms] [-t target] [format]: -p prints (here: to the status line too).
            let mut text = Vec::new();
            let mut i = 1;
            while i < words.len() {
                match words[i].as_str() { "-d" | "-c" | "-t" | "-F" => i += 1, w if w.starts_with('-') && w.len() > 1 && text.is_empty() => {}, w => text.push(w.to_string()) }
                i += 1;
            }
            let text = text.join(" ");
            if text.is_empty() { input::run(app, "info") } else { let t = expand(app, &text); app.say(t, theme::WARN) }
        }
        "show-messages" => input::run(app, "messages"),
        "list-keys" => {
            // -T copy-mode-vi / copy-mode / root: that table.
            if let Some(t) = opt(words, "-T").and_then(|t| crate::keys::table_named(&t)) {
                let list = app.keymap.table_mut(t).clone();
                let lines = list.iter().map(|b| format!("bind-key -T {} {:<8} {}", opt(words, "-T").unwrap_or_default(), crate::keys::name(&b.chord), b.command)).collect();
                input::picker(app, crate::modal::PickerKind::Output { title: "list-keys".into(), lines }, "list-keys", "");
            } else { input::run(app, "keys") }
        }
        "list-windows" | "list-sessions" | "list-panes" | "list-clients" | "show-options" => {
            let mut lines = listing(app, command);
            // show -g prefix: just that one.
            if command == "show-options" { let want = rest(words); if !want.is_empty() { lines.retain(|l| l.split(' ').next() == Some(want.as_str())) } }
            input::picker(app, crate::modal::PickerKind::Output { title: command.to_string(), lines }, command, "");
        }
        "set-option" | "set-window-option" | "setw" | "bind-key" | "unbind-key" => {
            let mut settings = crate::tmuxconf::Settings::default();
            let mut words = words.to_vec();
            words[0] = command.to_string();
            if command != "bind-key" && command != "unbind-key" {
                // A switch with no value toggles, as tmux's does (`bind C-s set status`).
                let args: Vec<usize> = (1..words.len()).filter(|i| !words[*i].starts_with('-')).collect();
                if let Some(&at) = args.first() {
                    let name = words[at].clone();
                    let now = match name.as_str() {
                        "status" => Some(app.opts.status != Some(false)), "mouse" => Some(app.mouse),
                        "synchronize-panes" => Some(app.tab().sync), "renumber-windows" => Some(app.opts.renumber_windows == Some(true)),
                        _ => None,
                    };
                    if let Some(now) = now {
                        let value = args.get(1).map(|i| words[*i].clone());
                        let on = match value.as_deref() { None | Some("") => !now, Some(v) => matches!(v, "on" | "yes" | "1" | "true") };
                        if name == "synchronize-panes" { app.tab_mut().sync = on; return }
                        if args.len() < 2 { words.push(if on { "on".into() } else { "off".into() }) }
                    }
                }
            }
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
            let dst = opt(words, "-t").map(|t| window_target(app, &t)).unwrap_or(Some(app.active));
            match (src, dst) {
                (Some(a), Some(b)) => {
                    // -d leaves the current window where it was; without it, focus follows the move.
                    let keep = flag(words, "-d");
                    if a != app.active { let cur = app.active; app.active = a; app.swap_tabs(a, b); if keep { app.active = cur } } else { app.swap_tabs(a, b) }
                }
                _ => app.say("Can't find window", theme::WARN),
            }
        }
        "join-pane" | "move-pane" => {
            // -s :N brings that window's pane here; -t :N sends this pane there.
            if let Some(from) = opt(words, "-s").and_then(|t| window_target(app, t.split('.').next().unwrap_or(""))) {
                let here = app.active;
                if from == here { return }
                let Some(p) = app.tabs[from].focus else { return };
                let Some((machine, agent)) = app.panes.get(&p).map(|x| (x.machine_id.clone(), x.agent_id.clone())) else { return };
                let here_id = app.tabs[here].id.clone();
                app.close_pane(p);
                if let Some(i) = app.tabs.iter().position(|t| t.id == here_id) { app.select_tab(i) }
                app.open_agent(&machine, &agent, Placement::Split(if flag(words, "-h") { Dir::Horizontal } else { Dir::Vertical }));
                return;
            }
            let Some(target) = opt(words, "-t") else { app.say("join-pane -t :N (or -s :N)", theme::WARN); return };
            let Some(to) = window_target(app, target.split('.').next().unwrap_or("")) else { app.say(format!("Can't find window: {target}"), theme::WARN); return };
            let n = app.win_num(to);
            if to == app.active { return }
            let Some((machine, agent)) = input::focused_agent(app) else { return };
            if let Some(f) = app.focused() { app.close_pane(f) }
            let to = app.tab_by_num(n).unwrap_or(to);
            app.select_tab(to);
            app.open_agent(&machine, &agent, Placement::Split(if flag(words, "-h") { Dir::Horizontal } else { Dir::Vertical }));
        }
        "clear-history" => { if let Some(p) = app.focused().and_then(|f| app.panes.get_mut(&f)) { p.clear_history() } }
        "capture-pane" => {
            if let Some(text) = app.focused().and_then(|f| app.panes.get(&f)).map(|p| p.visible_text()) { app.buffers.insert(0, text) }
        }
        "set-buffer" => { let text = rest(words); if !text.is_empty() { app.buffers.insert(0, text) } }
        "show-buffer" => {
            let lines = app.buffers.first().map(|b| b.lines().map(str::to_string).collect()).unwrap_or_default();
            input::picker(app, crate::modal::PickerKind::Output { title: "show-buffer".into(), lines }, "show-buffer", "");
        }
        "respawn-pane" => input::run(app, "restart"),
        "suspend-client" => app.suspend = true,
        "rename-session" => app.say("sessions are computers here: rename one from the desktop app", theme::WARN),
        "clock-mode" => { if let Some(f) = app.focused() { app.modal = Some(Modal::Clock { pane: f }) } else { app.modal = Some(Modal::Clock { pane: 0 }) } }
        "refresh-client" => { app.redraw_all = true; for id in app.panes.keys().copied().collect::<Vec<_>>() { if app.rects.iter().any(|(r, _)| *r == id) { app.open_stream(id, false) } } }
        "detach-client" | "kill-server" | "kill-session" => app.quit = true,
        "switch-client" => {
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
            while i < words.len() && words[i].starts_with('-') && words[i].len() > 1 {
                if words[i].contains('F') { format = true }
                if words[i] == "-t" { i += 1 }
                i += 1;
            }
            let Some(cond) = words.get(i) else { return };
            // -F: a format. Else a shell command, run here — unless it asks about the pane's tty
            // (vim-tmux-navigator), which lives on another machine: a harness pane is not vim.
            let truth = if format { !matches!(expand(app, cond).trim(), "" | "0") }
                else if cond.contains("#{") || cond.contains("pane_tty") || cond.contains("is_vim") {
                    // "Is vim in this pane?": a shell pane on the alternate screen is running a full-screen program.
                    app.focused().and_then(|f| app.panes.get(&f)).filter(|p| app.fleet.agent(&p.machine_id, &p.agent_id).map(|a| a.engine == "terminal").unwrap_or(false))
                        .map(|p| p.mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN)).unwrap_or(false)
                } else { crate::tmuxconf::shell_true(&expand(app, cond)) };
            let pick = if truth { words.get(i + 1) } else { words.get(i + 2) };
            if let Some(command) = pick.cloned() { execute(app, &command) }
        }
        // run-shell: on this computer, as tmux's server would; what it prints is shown.
        "run-shell" | "run" => {
            let cmd = rest(words);
            if cmd.is_empty() { return }
            let cmd = expand(app, &cmd);
            let out = std::process::Command::new("sh").arg("-c").arg(&cmd).output();
            match out {
                Ok(o) => {
                    let text = String::from_utf8_lossy(&o.stdout).to_string() + &String::from_utf8_lossy(&o.stderr);
                    let lines: Vec<String> = text.lines().map(str::to_string).collect();
                    if lines.len() > 1 { input::picker(app, crate::modal::PickerKind::Output { title: "run-shell".into(), lines }, "run-shell", "") }
                    else if let Some(l) = lines.first() { app.say(l.clone(), theme::WARN) }
                }
                Err(e) => app.say(format!("run-shell: {e}"), theme::WARN),
            }
        }
        "send-prefix" => { let prefix = crate::keys::name(&app.keymap.prefix); input::send_keys(app, &[prefix]) }
        "command-prompt" => {
            let label = opt(words, "-p").unwrap_or_else(|| ":".into());
            let initial = opt(words, "-I").map(|i| expand(app, &i)).unwrap_or_default();
            let template = rest(words);
            let label = if label == ":" { ":".to_string() } else { format!("{label} ") };
            app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Command { template: (!template.is_empty()).then_some(template) }, &label, &initial)));
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
    }

    #[test]
    fn resolves_aliases() {
        assert_eq!(resolve("splitw"), "split-window");
        assert_eq!(resolve("neww"), "new-window");
        assert_eq!(resolve("whatever"), "whatever");
    }
}
