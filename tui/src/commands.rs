//! tmux commands. Every key, the `:` prompt and `~/.tmux.conf` speak the same language —
//! `split-window -h`, `select-layout tiled`, `confirm-before -p "kill-pane #P? (y/n)" kill-pane` —
//! and this is where a command line becomes an action on tabs (windows), panes and harnesses.

use crate::app::{App, Placement};
use crate::input;
use crate::layout::{self, Dir, Preset, Toward};
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
            (None, '\\') => { if let Some(n) = chars.next() { if n == ';' && word.is_empty() { commands.push(Vec::new()); in_word = false; continue } word.push(n); in_word = true } }
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

/// `#W` window name, `#P` pane index, `#T` pane (harness) title, `#I` window index, `#S` session.
pub fn expand(app: &App, text: &str) -> String {
    let window = app.tab().name.clone();
    let index = (app.active + app.base_index).to_string();
    let pane = app.focused().and_then(|f| app.tab().panes().iter().position(|p| *p == f)).map(|i| (i + app.base_index).to_string()).unwrap_or_default();
    let title = input::focused_title(app);
    text.replace("#{window_name}", &window).replace("#W", &window).replace("#{pane_index}", &pane).replace("#P", &pane)
        .replace("#{pane_title}", &title).replace("#T", &title).replace("#{window_index}", &index).replace("#I", &index).replace("#S", "harness")
}

fn resolve(name: &str) -> &str {
    COMMANDS.iter().find(|(full, alias, _)| *full == name || *alias == name).map(|(full, _, _)| *full).unwrap_or(name)
}

/// Run a command line (one or more commands separated by `;`).
pub fn execute(app: &mut App, line: &str) {
    for words in split(line) { run_words(app, &words) }
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
            app.new_tab();
            if let Some(name) = opt(words, "-n") { app.rename_tab(&name) }
            input::launch(app, "", Filter::All);
        }
        "split-window" => {
            let dir = if flag(words, "-h") { Dir::Horizontal } else { Dir::Vertical };
            input::split_pick(app, dir);
        }
        "kill-pane" => { if let Some(f) = app.focused() { app.close_pane(f) } else if app.tabs.len() > 1 { let i = app.active; app.close_tab(i) } }
        "kill-window" => { let i = app.active; app.close_tab(i) }
        "next-window" => if flag(words, "-a") { input::run(app, "next-waiting") } else { let n = app.tabs.len(); let i = (app.active + 1) % n; app.select_tab(i) },
        "previous-window" => if flag(words, "-a") { input::run(app, "prev-waiting") } else { let n = app.tabs.len(); let i = (app.active + n - 1) % n; app.select_tab(i) },
        "last-window" => input::run(app, "last-tab"),
        "select-window" => {
            let target = opt(words, "-t").or_else(|| Some(rest(words))).unwrap_or_default();
            let target = target.trim_start_matches(':').trim_start_matches('=');
            match target.parse::<usize>() {
                Ok(n) if n >= app.base_index && n - app.base_index < app.tabs.len() => app.select_tab(n - app.base_index),
                Ok(n) => app.say(format!("can't find window: {n}"), theme::WARN),
                Err(_) => {
                    // By name, as tmux allows.
                    if let Some(i) = app.tabs.iter().position(|t| t.name.to_lowercase().starts_with(&target.to_lowercase())) { app.select_tab(i) }
                    else { app.say(format!("can't find window: {target}"), theme::WARN) }
                }
            }
        }
        "rename-window" => { let name = rest(words); if !name.trim().is_empty() { app.rename_tab(name.trim()) } }
        "move-window" => {
            if flag(words, "-L") { app.move_tab(-1) } else if flag(words, "-R") { app.move_tab(1) }
            else if let Some(n) = opt(words, "-t").or_else(|| Some(rest(words))).and_then(|t| t.trim_start_matches(':').parse::<usize>().ok()) {
                let to = n.saturating_sub(app.base_index).min(app.tabs.len().saturating_sub(1));
                while app.active > to { app.move_tab(-1) }
                while app.active < to { app.move_tab(1) }
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
        "break-pane" => input::run(app, "pane-tab"),
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
        "search-backward" | "search-forward" => { if let Some(pane) = app.focused() { app.modal = Some(Modal::Find { pane, query: String::new(), found: None }) } }
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
        "display-message" => { let text = rest(words); if text.is_empty() { input::run(app, "info") } else { let t = expand(app, &text); app.say(t, theme::WARN) } }
        "show-messages" => input::run(app, "messages"),
        "list-keys" => input::run(app, "keys"),
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
            let truth = format && !matches!(expand(app, cond).trim(), "" | "0");
            let pick = if truth { words.get(i + 1) } else { words.get(i + 2) };
            if let Some(command) = pick.cloned() { execute(app, &command) }
        }
        "run-shell" | "run" => {}
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

pub fn placement_for(dir: Dir) -> Placement { Placement::Split(dir) }
pub fn tiled_ids(ids: &[u64]) -> Option<layout::Node> { layout::build(ids, Preset::Grid) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_tmux() {
        assert_eq!(split("split-window -h"), vec![vec!["split-window", "-h"]]);
        assert_eq!(split("confirm-before -p \"kill-pane #P? (y/n)\" kill-pane"), vec![vec!["confirm-before", "-p", "kill-pane #P? (y/n)", "kill-pane"]]);
        assert_eq!(split("copy-mode ; search-backward"), vec![vec!["copy-mode"], vec!["search-backward"]]);
        assert_eq!(split("copy-mode \\; send -X begin-selection"), vec![vec!["copy-mode"], vec!["send", "-X", "begin-selection"]]);
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
