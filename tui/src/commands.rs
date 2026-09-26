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
    ("tim", "tim", "tim, the creature in the status line: how it is (set -g @tim off hides it)"),
    ("display-popup", "popup", "A shell (or a command: display-popup -E lazygit) floating over the window"),
    ("list-commands", "lscm", "Every command"),
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
fn canonical(command: &str) -> String {
    let word = |i: usize, w: &String| -> String {
        let w = if i == 0 { resolve(w).to_string() } else { w.clone() };
        if w == ";" { "\\;".into() }
        else if w.is_empty() || w.chars().any(|c| c.is_whitespace() || "#\"'$;\\".contains(c)) { format!("\"{}\"", w.replace('\\', "\\\\").replace('"', "\\\"")) }
        else { w }
    };
    split(command).iter().map(|words| words.iter().enumerate().map(|(i, w)| word(i, w)).collect::<Vec<_>>().join(" ")).collect::<Vec<_>>().join(" \\; ")
}

/// A tmux command's name or alias (for `hn <command>` from a shell).
pub fn is_command_name(name: &str) -> bool {
    COMMANDS.iter().any(|(full, alias, _)| *full == name || *alias == name)
        || matches!(name, "display" | "send" | "neww" | "splitw" | "killp" | "killw" | "selectw" | "selectp" | "lsw" | "lsp" | "ls" | "capturep" | "showw" | "show" | "set" | "bind" | "unbind" | "source" | "run" | "if"
            | "run-shell" | "if-shell" | "wait-for" | "wait" | "pipe-pane" | "pipep" | "set-hook" | "show-hooks" | "resize-window" | "resizew" | "kill-session" | "send-prefix" | "display-menu" | "menu"
            | "set-option" | "set-window-option" | "setw" | "bind-key" | "unbind-key" | "source-file" | "kill-server" | "detach-client" | "detach")
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
            // The pane this came from decides the machine and folder — read before the new window.
            let from = input::focused_agent(app);
            let last_before = app.last_tab.clone();
            let was_id = app.tab().id.clone();
            let _ = was;
            app.new_tab();
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
            let dir = if flag(words, "-h") { Dir::Horizontal } else { Dir::Vertical };
            // A shell, as tmux gives. -P prints the new pane (-F its format) once it is up.
            if flag(words, "-P") { app.print_new = Some(opt(words, "-F").unwrap_or_else(|| "#{session_name}:#{window_index}.#{pane_index}".into())) }
            let cwd = opt(words, "-c").map(|c| expand(app, &c)).filter(|c| !c.is_empty());
            let command = shell_command(words);
            let placement = if app.tab().root.is_none() { Placement::Auto(None) } else { Placement::Split(dir) };
            input::new_shell(app, placement, cwd, command);
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
        "rename-window" => { let name = rest(words); if !name.trim().is_empty() { app.rename_tab(name.trim()) } }
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
            if flag(words, "-m") { let f = app.focused(); app.marked = if app.marked == f { None } else { f }; return }
            let toward = if flag(words, "-L") { Some(Toward::Left) } else if flag(words, "-R") { Some(Toward::Right) } else if flag(words, "-U") { Some(Toward::Up) } else if flag(words, "-D") { Some(Toward::Down) } else { None };
            match toward {
                Some(t) => app.focus_toward(t),
                None if flag(words, "-l") => app.last_pane(),
                None => {
                    let target = opt(words, "-t").unwrap_or_default();
                    // -T: the pane's title (as #{pane_title} reads it).
                    if let Some(title) = opt(words, "-T") { if let Some(p) = app.focused().and_then(|f| app.panes.get_mut(&f)) { p.title = title } }
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
            if flag(words, "-Z") { input::run(app, "zoom"); return }
            // -x / -y: an absolute size, as the difference from now.
            if let Some(cols) = opt(words, "-x").and_then(|v| size_arg(&v, app.size.0)) {
                if let Some(r) = app.focused().and_then(|f| app.rects.iter().find(|(id, _)| *id == f)).map(|(_, r)| *r) { app.resize_focused(Dir::Horizontal, cols as f32 - r.width as f32) }
                return;
            }
            if let Some(rows) = opt(words, "-y").and_then(|v| size_arg(&v, app.size.1)) {
                if let Some(r) = app.focused().and_then(|f| app.rects.iter().find(|(id, _)| *id == f)).map(|(_, r)| *r) { app.resize_focused(Dir::Vertical, rows as f32 - r.height as f32) }
                return;
            }
            let n: f32 = rest(words).trim().parse().unwrap_or(1.0);
            let (dir, sign) = if flag(words, "-L") { (Dir::Horizontal, -1.0) } else if flag(words, "-R") { (Dir::Horizontal, 1.0) } else if flag(words, "-U") { (Dir::Vertical, -1.0) } else { (Dir::Vertical, 1.0) };
            app.resize_focused(dir, sign * n);
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
            if flag(words, "-E") { input::run(app, "equalize"); return }
            let preset = match rest(words).trim() {
                "even-horizontal" => Preset::Columns, "even-vertical" => Preset::Rows,
                "main-horizontal" | "main-horizontal-mirrored" => Preset::MainRow, "main-vertical" | "main-vertical-mirrored" => Preset::MainStack,
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
        "copy-mode" => { input::run(app, "copy-mode"); if flag(words, "-u") { if let Some(f) = app.focused() { if let Some(p) = app.panes.get_mut(&f) { let half = p.rows as i32 - 2; p.copy_move(0, -half) } } } }
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
                Some((w, p)) => crate::format::spans_for_pane(app, &text, w, p, ratatui::style::Style::default()).into_iter().map(|s| s.content.into_owned()).collect(),
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
            // -T copy-mode-vi / copy-mode / root: that table.
            if let Some(t) = opt(words, "-T").and_then(|t| crate::keys::table_named(&t)) {
                let list = app.keymap.table_mut(t).clone();
                let lines = list.iter().map(|b| format!("bind-key -T {} {:<10} {}", opt(words, "-T").unwrap_or_default(), crate::keys::name(&b.chord), canonical(&b.command))).collect();
                app.print("list-keys", lines);
            } else if app.capture.is_some() {
                // From a shell: tmux's own lines, `bind-key [-r] -T prefix KEY command`.
                let mut lines = Vec::new();
                for b in &app.keymap.prefix_table { lines.push(format!("bind-key {}-T prefix {:<10} {}", if b.repeat { "-r " } else { "   " }, crate::keys::name(&b.chord), canonical(&b.command))) }
                for b in &app.keymap.root_table { lines.push(format!("bind-key    -T root   {:<10} {}", crate::keys::name(&b.chord), canonical(&b.command))) }
                for b in &app.keymap.copy_vi { lines.push(format!("bind-key    -T copy-mode-vi {:<10} {}", crate::keys::name(&b.chord), canonical(&b.command))) }
                for b in &app.keymap.copy_emacs { lines.push(format!("bind-key    -T copy-mode {:<10} {}", crate::keys::name(&b.chord), canonical(&b.command))) }
                app.print("list-keys", lines);
            } else { input::run(app, "keys") }
        }
        "list-windows" | "list-sessions" | "list-panes" | "list-clients" | "show-options" | "show-window-options" => {
            let command = if command == "show-window-options" { "show-options" } else { command };
            // -F: a format, one line per window or pane.
            let mut lines = match (command, opt(words, "-F")) {
                ("list-windows", Some(f)) => (0..app.tabs.len()).map(|w| crate::format::spans(app, &f, Some(w), ratatui::style::Style::default()).into_iter().map(|s| s.content.into_owned()).collect()).collect(),
                ("list-panes", f) => {
                    // -a / -s: every window's panes; -t: that window's; -F: a format per pane.
                    let windows: Vec<usize> = if flag(words, "-a") || flag(words, "-s") { (0..app.tabs.len()).collect() } else { vec![opt(words, "-t").and_then(|t| window_target(app, &t)).unwrap_or(app.active)] };
                    let all = windows.len() > 1;
                    let f = f.unwrap_or_else(|| if all { "#{session_name}:#{window_index}.#{pane_index}: [#{pane_width}x#{pane_height}] #{pane_id}#{?pane_active, (active),}".into() } else { "#{pane_index}: [#{pane_width}x#{pane_height}] #{pane_id}#{?pane_active, (active),}".into() });
                    windows.into_iter().flat_map(|w| app.tabs[w].panes().into_iter().map(move |p| (w, p))).collect::<Vec<_>>().into_iter()
                        .map(|(w, p)| crate::format::spans_for_pane(app, &f, w, p, ratatui::style::Style::default()).into_iter().map(|s| s.content.into_owned()).collect()).collect()
                }
                ("list-clients", Some(f)) => vec![expand(app, &f)],
                ("list-sessions", Some(f)) => vec![expand(app, &f)],
                _ => listing(app, command),
            };
            // show -g prefix: just that one; -v: only its value.
            if command == "show-options" {
                let want = rest(words);
                if !want.is_empty() { lines.retain(|l| l.split(' ').next() == Some(want.as_str())) }
                if flag(words, "-v") { lines = lines.into_iter().map(|l| l.split_once(' ').map(|(_, v)| v.trim_matches('"').to_string()).unwrap_or_default()).collect() }
            }
            app.print(command, lines);
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
                    // tim: `set -g @tim off` hides the creature (kept), `on` brings it back.
                    if name == "@tim" {
                        let v = args.get(1).map(|i| words[*i].clone()).unwrap_or_default();
                        let off = match v.as_str() { "off" | "0" | "no" => true, "on" | "1" | "yes" => false, _ => !app.tim.off };
                        app.tim.set_off(off);
                        return;
                    }
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
                    // "Is vim in this pane?": what tmux says the pane runs (vim-tmux-navigator's own test,
                    // `g?(view|l?n?vim?x?|fzf)(diff)?`), else a shell pane on the alternate screen.
                    let pane = app.focused().and_then(|f| app.panes.get(&f));
                    match pane.and_then(|p| p.fg_command.clone()) {
                        Some(cmd) => is_vim_command(&cmd),
                        None => pane.filter(|p| app.fleet.agent(&p.machine_id, &p.agent_id).map(|a| a.engine == "terminal").unwrap_or(false))
                            .map(|p| p.mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN)).unwrap_or(false),
                    }
                } else { crate::tmuxconf::shell_true(&expand(app, cond)) };
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
            let cmd = rest(words);
            if cmd.is_empty() { return }
            let cmd = expand(app, &cmd);
            let out = std::process::Command::new("sh").arg("-c").arg(&cmd).output();
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
