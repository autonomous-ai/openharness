//! The overlays and what their rows are: the fzf list's modes (harnesses, > commands, @ machines,
//! # projects, : models, * store, ? help), needs input, the New Harness form, layouts, and the
//! one-line prompts (rename, first message, send).

use ratatui::style::Style;
use ratatui::text::Span;
use serde_json::Value;

use crate::app::App;
use crate::terminal_themes::TERMINAL_THEMES;
use crate::fleet::{ago, Reach, State};
use crate::picker::{Picker, Row};
use crate::theme::{self, engine_label, engine_mark, fg, state_mark};

/// Which harnesses a list shows. Only All is reachable from a key today.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Filter { All, NeedsInput, Running, Paused }

impl Filter {
    pub fn label(self) -> &'static str { match self { Filter::All => "All", Filter::NeedsInput => "Needs input", Filter::Running => "Running", Filter::Paused => "Paused" } }
    fn keeps(self, state: State) -> bool {
        match self {
            Filter::All => true,
            Filter::NeedsInput => state == State::NeedsInput,
            Filter::Paused => state == State::Paused,
            Filter::Running => !matches!(state, State::Paused | State::Offline),
        }
    }
}

#[derive(Clone, Debug)]
pub struct What { pub engine: String, pub dsh: Option<String>, pub label: String }

#[derive(Clone, Debug)]
pub enum PickerKind {
    ShellContext,
    /// Harnesses — optionally inside one machine or one project folder.
    Open { filter: Filter, machine: Option<String>, project: Option<String> },
    Palette,
    Projects,
    Models,
    Inbox,
    Machines,
    Layout,
    Help,
    Store,
    /// The look & theme of hn: a  `[look]` preset or a knob, applied live and written to tui.toml.
    Theme,
    /// C-b Enter: every command by name, in the settings panel — type a few letters, Enter runs it.
    Commands,
    /// Keybinds: the prefixes and each command's key after them — Enter on one changes it.
    Keybinds,
    /// A task routed to a harness; [voice]: the dial's spoken task it answers.
    Route { text: String, voice: Option<String> },
    /// `show-messages`, `list-keys`, `choose-buffer`.
    Messages,
    Keys,
    Buffers,
    /// What `list-windows`, `list-panes`, `show-options`… print, in a view (tmux's view mode).
    Output { title: String, lines: Vec<String> },
    // ── machines & devices ──
    /// Connect a machine, Add phone, Machines & devices: the desktop's machine screens in the panel.
    Devices(crate::devices::View),
    /// Optional Harness account and its browser/phone sign-in flow.
    Account,
    /// Software selection for one captured harness, sharing the desktop handoff lifecycle.
    AgentSwitch,
    /// Physical USB devices on owned computers; distinct from machine connections.
    Hardware,
}

#[derive(Clone, Debug)]
pub enum PromptKind {
    RenameTab { session: u32, window: String, owner: String },
    RenameHarness { machine: String, agent: String },
    Send,
    Broadcast,
    /// A question's answer, typed: option numbers or your own words.
    /// The question's request id when M-a was pressed: a new one meanwhile is not answered.
    Answer { machine: String, agent: String, request: String },
    /// A message to a harness (C-b s's M-s).
    Message { machine: String, agent: String },
    /// tmux `command-prompt`: with a template, the answers fill it (`%1` `%2` …, `%%` the first
    /// not yet used, `%%%` quoted); without one, the typed text is the command. `more`: the
    /// prompts still to ask (label, initial text); `answers`: those given; `one`: -1, a single
    /// key is the answer; `digits`: -N, only numbers; `incremental`: -i, the template run on
    /// every change (after `=`, `+` or `-`), `last` what C-r and C-s bring back; `ptype`: -T,
    /// whose history Up and Down walk (command, search, target, window-target).
    Command { template: Option<String>, more: Vec<(String, String)>, answers: Vec<String>, one: bool, digits: bool, incremental: bool, ptype: usize, last: String },
    /// command-prompt -k: the next key pressed, by its tmux name, fills the template.
    Key { template: String },
    /// A prompt of choose-tree's for the tree in [pane]: search, filter, kill (one key), a
    /// command for the tagged items.
    Tree { pane: u64, ask: crate::tree::Ask },
}

/// A line typed: tmux's in the status line (`(rename-window) name`, `:split-window -h`), hn's own
/// in a dialog ([Prompt::dialog]).
#[derive(Clone, Debug)]
pub struct Prompt {
    pub kind: PromptKind,
    pub title: String,
    pub label: String,
    pub hint: String,
    pub value: String,
    pub secret: bool,
    /// Cursor position in `value`, in chars (emacs keys move it, as in tmux's prompt).
    pub cursor: usize,
    /// Where Up/Down are in the command history.
    pub history_at: Option<usize>,
    /// status-keys vi: Esc leaves insert for normal mode; an operator (d, c, r) waits for its motion.
    pub vi_normal: bool,
    /// What C-w last cut (prompt_saved): C-y puts it back before the newest paste buffer.
    pub saved: Option<String>,
    /// hn's own questions ([Prompt::dialog]): the input's label, the line above it, whether the
    /// keys are on the buttons (Tab) and which one is chosen (0 Cancel, 1 the action).
    pub field: String,
    pub body: String,
    pub buttons: bool,
    pub chosen: usize,
}

impl Prompt {
    pub fn status(kind: PromptKind, label: &str, initial: &str) -> Prompt {
        Prompt { kind, title: String::new(), label: label.to_string(), hint: String::new(), value: initial.to_string(), secret: false, cursor: initial.chars().count(), history_at: None, vi_normal: false, saved: None, field: String::new(), body: String::new(), buttons: false, chosen: 1 }
    }

    /// hn's own questions are dialogs; tmux's (command-prompt, choose-tree's) keep the status line.
    pub fn dialog(&self) -> bool {
        matches!(self.kind, PromptKind::RenameTab { .. } | PromptKind::RenameHarness { .. } | PromptKind::Send | PromptKind::Broadcast | PromptKind::Answer { .. } | PromptKind::Message { .. })
    }

    /// The dialog's `[ Cancel ]  [ Rename ]` (Send, Broadcast, Answer), the chosen button only
    /// while the keys are on them.
    pub fn row(&self) -> crate::buttons::Row {
        let action = match self.kind {
            PromptKind::RenameTab { .. } | PromptKind::RenameHarness { .. } => "Rename",
            PromptKind::Broadcast => "Broadcast",
            PromptKind::Answer { .. } => "Answer",
            _ => "Send",
        };
        let button = |label: &str| crate::buttons::Button { label: label.into(), key: None };
        crate::buttons::Row { buttons: vec![button("Cancel"), button(action)], chosen: if self.buttons { self.chosen } else { usize::MAX }, hint: crate::buttons::KEYS.into() }
    }
}

/// One row of a tmux display-menu: a label (a format, its styles kept), its shortcut key, the
/// command it runs.
#[derive(Clone, Debug)]
pub struct MenuItem { pub label: String, pub key: String, pub command: String, pub disabled: bool, pub separator: bool }

/// tmux's display-menu (menu.c): its items, where its box is (x, y: the top-left corner; the box
/// is width + 4 by the items + 2), which item is chosen (none yet when the mouse opened it), -O,
/// and the mouse event of the command that opened it (its items' commands run with it). A
/// choose-tree's menu (a right click in it) gives its item's key to the tree in that pane, the
/// line clicked made current, in place of a command.
#[derive(Clone, Debug)]
pub struct Menu {
    pub title: String,
    pub items: Vec<MenuItem>,
    pub choice: Option<usize>,
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub stay_open: bool,
    pub no_mouse: bool,
    pub mouse: Option<crate::mouse::Event>,
    pub tree: Option<(u64, usize)>,
    /// A prompt's completion menu (status_prompt_complete_list_menu): the prompt under it, back
    /// when it closes, the chosen word put in it.
    pub complete: Option<Box<Complete>>,
    /// Harness menus reflow from their original labels when the terminal changes size.
    /// Explicit tmux display-menu coordinates keep tmux's existing behavior.
    pub responsive: Option<Box<crate::workspace_menu::Layout>>,
    /// A confirmation's buttons, drawn on the row under the notes.
    pub buttons: Option<crate::workspace_menu::Buttons>,
}

/// What a completion menu completes: the prompt, the words its items stand for, the flag they
/// go after (-t, -s), and whether the prompt is a window target's (the word is the whole line).
#[derive(Clone, Debug)]
pub struct Complete { pub prompt: Prompt, pub list: Vec<String>, pub flag: Option<char>, pub window_target: bool }

pub enum Modal {
    /// tmux's display-menu: a box of items, each with its key; Enter or the key runs one.
    Menu(Menu),
    /// Compact New Harness form with searchable choices and a persistent draft.
    NewHarness(Box<crate::new_harness::Form>),
    Picker { kind: PickerKind, picker: Picker },
    Prompt(Prompt),
    /// tmux `confirm-before`: `Confirm 'kill-pane'? (y/n)` in the status line; `key` answers
    /// yes (-c), and with `enter_yes` (-y) so does Enter.
    Confirm { prompt: String, command: String, key: char, enter_yes: bool },
    /// tmux `display-panes` (C-b q): a big number on every pane; press one to go there.
    /// display-panes: until when (none: until a key, -d 0), the command a number runs (%% its
    /// pane), and whether keys choose at all (-N: not).
    DisplayPanes { until: Option<std::time::Instant>, template: Option<String>, keys: bool },
    /// display-popup: a shell floating over the window; it goes when its program exits.
    /// display-popup: its program's pane, where it is, its border (lines: tmux's box lines,
    /// `none` for -B), title (a format drawn with its styles) and styles (-s, -S).
    Popup { pane: u64, x: u16, y: u16, width: u16, height: u16, border: bool, title: String, look: PopupLook },
    /// copy-mode (C-b [): move a cursor over the pane's text and copy from it, vi-style.
    Copy { pane: u64 },
}

pub const ENGINES: [&str; 15] = ["claude", "codex", "opencode", "cursor", "pi", "amp", "hermes", "kilo", "grok", "devin", "copilot", "commandcode", "muse", "agy", "terminal"];

/// The palette's commands: (id, title, keys, hint, group).
pub const COMMANDS: &[(&str, &str, &str, &str, &str)] = &[
    ("account", "Account…", "", "sign in, sign out, connect computers, sync your workspace and add your phone", "General"),
    ("signout", "Sign out", "", "leave your Harness account here — harnesses on this computer keep running", "General"),
    // (Together with the rows above: one General group, not two. Listed to a search only.)
    ("take", "Take control", "", "reclaim all panes across every tab", "General"),
    ("open", "Open harness…", "⌥P", "every harness on every machine", "Harness"),
    ("projects", "Open project…", "⌥O", "a project, then one of its harnesses", "Harness"),
    ("models", "Open models…", "⌥I", "local, shared, subscriptions, APIs — use one on this harness", "Harness"),
    ("change-agent", "Change agent…", "", "continue this project with another agent", "Harness"),
    ("terminal", "New pane", "⌥N", "a shell on this pane's machine", "Harness"),
    ("inbox", "Harnesses needing input", "⌥⇧I", "", "Harness"),
    ("next-waiting", "Next harness waiting on you", "⌥A", "oldest question first", "Harness"),
    ("send", "Send to harness…", "⌥B", "type a task — Harness picks who", "Harness"),
    ("broadcast", "Broadcast to this tab…", "", "one message to every harness in the tab", "Harness"),
    ("clone", "Clone harness", "⌥⇧N", "a second one with this one's history", "Harness"),
    ("restart", "Restart harness", "⌥⇧E", "", "Harness"),
    ("pause", "Pause harness", "", "stop the engine, keep the conversation", "Harness"),
    ("rename", "Rename harness…", "", "", "Harness"),
    ("tab", "New Tab", "⌥T", "", "Tabs"),
    ("rename-tab", "Rename Tab…", "⌥⇧R", "", "Tabs"),
    ("close-tab", "Close Tab", "⌥⇧W", "save and stop; confirm active work", "Tabs"),
    ("next-tab", "Next Tab", "⌥}", "", "Tabs"),
    ("prev-tab", "Previous Tab", "⌥{", "", "Tabs"),
    ("tab-left", "Move Tab left", "⌥<", "", "Tabs"),
    ("tab-right", "Move Tab right", "⌥>", "", "Tabs"),
    ("split-right", "Split right", "⌥\\", "", "Panes"),
    ("split-down", "Split down", "⌥-", "", "Panes"),
    ("close-pane", "Stop harness", "⌥W", "save its history; confirm active work", "Panes"),
    ("zoom", "Zoom pane", "⌥Z", "", "Panes"),
    ("layout", "Layout…", "⌥L", "grid, columns, main + stack…", "Panes"),
    ("equalize", "Equalize panes", "⌥=", "", "Panes"),
    ("pane-tab", "Move pane to a new tab", "", "", "Panes"),
    ("find", "Find in pane…", "⌥⇧F", "search this pane's history", "Panes"),
    // (Not "keyboard": `keyb` is Keybinds.)
    ("copy-mode", "Copy mode", "⌥V", "move over the pane's text, select and copy", "Panes"),
    // (The machines and what runs on each; Connect machines… is where one is linked, its password
    // asked — the one way in: a separate "Connect a computer…" only went there.)
    ("machines", "List machines", "⌥M", "your machines and the harnesses on each", "Machines"),
    ("store", "Harness store", "⌥S", "", "Machines"),
    // ── machines & devices ──
    ("devices", "Connect machines…", "", "link a machine, this computer's password, your machines and links", "Machines"),
    ("add-phone", "Add phone…", "", "a QR code your phone scans to sign in and pair", "Machines"),
    ("hardware-devices", "Devices…", "", "Harness hardware, brightness, sound and voice language", "Machines"),
    // (hn itself: how it looks, its keys, and closing it.)
    ("theme", "Appearance…", "", "theme, status bar, borders, focus, layout — settings", "Settings & help"),
    ("keybinds", "Keybinds…", "", "every command's key after the prefix — Enter changes one", "Settings & help"),
    ("help", "Quick help", "⌥/", "what the search box can do: > @ # : * ?", "Settings & help"),
    ("quit", "Close hn", "⌥Q", "your harnesses keep running", "Settings & help"),
];


fn span(text: impl Into<String>, style: Style) -> Span<'static> { Span::styled(text.into(), style) }

/// A popup's look (popup.c): its box lines, its style and its border's style.
#[derive(Clone, Debug, Default)]
pub struct PopupLook { pub lines: String, pub style: String, pub border_style: String }

pub fn agent_rows(app: &App, filter: Filter, machine: Option<&str>, project: Option<&str>) -> Vec<Row> {
    let many = app.fleet.visible_machines().filter(|m| m.usable()).count() > 1;
    // The project in each row when the harnesses work in more than one.
    let projects = { let mut p: Vec<&str> = app.fleet.agents.values().map(|a| a.project.as_str()).filter(|p| !p.is_empty()).collect(); p.sort(); p.dedup(); p.len() > 1 };
    let open: Vec<(String, String)> = app.panes.values().map(|p| (p.machine_id.clone(), p.agent_id.clone())).collect();
    // As the desktop's Cmd-P lists them ("Recently active"): the one active last first — a query
    // ranks by how well it matches, this order breaking ties. (C-b A lists those waiting on you.)
    let mut agents: Vec<&crate::fleet::Agent> = app.fleet.agents.values().collect();
    agents.sort_by(|a, b| b.recency().cmp(&a.recency()).then_with(|| a.name.cmp(&b.name)).then_with(|| a.id.cmp(&b.id)));
    agents.into_iter()
        .filter(|a| machine.map(|m| a.machine_id == m).unwrap_or(true))
        .filter(|a| project.map(|p| a.project_root == p || a.cwd == p).unwrap_or(true))
        .filter(|a| filter.keeps(app.fleet.state_of(a)))
        .map(|a| {
            let state = app.fleet.state_of(a);
            let (dot, _, color) = state_mark(state, app.tick);
            let (mark, mark_color) = engine_mark(&a.engine);
            // (No headings by state: the list is one, the one active last first — its mark says
            // what each is doing.)
            let is_open = open.contains(&a.key());
            // Its one line: the question it asks, what it is doing now, what its last turn came to,
            // why it failed — the rest in the finder's dim.
            let (line, loud) = match state {
                State::NeedsInput => (a.question.as_ref().map(|q| q.prompt.clone()).unwrap_or_default(), true),
                State::Working => (a.doing.clone().unwrap_or_else(|| "Working".into()), false),
                State::Done => (a.did.clone().unwrap_or_else(|| "Finished".into()), false),
                State::Failed => (Some(a.launch_error.clone()).filter(|e| !e.is_empty()).or_else(|| a.did.clone()).unwrap_or_else(|| "Failed to start".into()), true),
                State::Starting => ("Starting".into(), false),
                _ => (a.did.clone().unwrap_or_default(), false),
            };
            let quiet = matches!(state, State::Ready | State::Paused | State::Offline);
            // An idle one's line is where it works (its last turn in the preview).
            let line = if quiet && line.is_empty() { [a.project.clone(), a.branch.clone()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ") } else { line };
            let detail = vec![span(line, if loud { fg(theme::ATTENTION) } else if quiet { fg(theme::MUTED) } else { Style::default() })];
            // Where it works and how long it has been as it is (waiting on you since its question,
            // working since its turn began, done since it ended).
            let since = a.state_since(state);
            // Right: the machine (when there are several) and how long — the name and its line
            // come first; where it works is searchable and in the preview's title.
            // Its pull request, where it has one (what it cost is in the preview).
            let pr = a.pr.as_ref().map(|p| p.label()).unwrap_or_default();
            let _ = is_open;
            let narrow = ago(since);
            let right = [pr.clone(), if projects { a.project.clone() } else { String::new() }, if many { app.fleet.machine_name(&a.machine_id) } else { String::new() }, ago(since)]
                .into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("  ");
            let live = !matches!(state, State::Paused | State::Offline);
            // What a query finds it by besides its name: where it works, its engine, its pull
            // request, and its state in words ('failed, 'done, 'waiting, 'working, 'idle).
            let words = match state {
                State::NeedsInput => "waiting needs-you", State::Failed => "failed", State::Done => "done finished", State::Working => "working",
                State::Starting => "starting", State::Unknown => "status unavailable", State::Ready => "idle", State::Paused => "paused", State::Offline => "offline",
            };
            // Its pull request's state in words too: 'pr, 'open, 'merged.
            let pr_words = a.pr.as_ref().map(|p| format!("pr {}", p.state.to_lowercase())).unwrap_or_default();
            Row::new(format!("{}:{}", a.machine_id, a.id), a.name.clone())
                .boost(if state == State::NeedsInput { 60 } else if live { 30 } else { 0 })
                .extra(format!("{} {} {} {} {} {} {} {} {}", a.project, a.branch, app.fleet.machine_name(&a.machine_id), a.engine, engine_label(&a.engine), a.dsh, pr, pr_words, words))
                // What it is doing now and how long it has been as it is change as you look.
                .volatile(matches!(state, State::Working | State::Starting), narrow.chars().count())
                .lead(vec![span(dot, fg(color)), span(" ", Style::default()), span(mark, fg(mark_color)), span(" ", Style::default())])
                .detail(detail)
                .right(right)
                .right_narrow(narrow)
                .line_first(loud)
        })
        .collect()
}

/// The Claude Code and Codex conversations Harness did not start that C-b s's query found by what
/// was said in them (never in the list as it opens): `not in Harness`, Enter resuming one as a
/// harness; one open in another terminal or app is marked so, and not opened twice.
pub fn external_rows(app: &App) -> Vec<Row> {
    let many = app.fleet.visible_machines().filter(|m| m.usable()).count() > 1;
    app.said.iter().chain(app.shell_context.catalog.iter().filter(|_| app.shell_context.sessions_machine.is_some())).filter_map(|s| s.external.as_ref())
        .filter(|x| !app.fleet.agents.values().any(|a| a.machine_id == x.machine && a.session_id == x.session_id)).map(|x| {
        let (mark, mark_color) = engine_mark(&x.engine);
        let folder = x.cwd.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
        let title = if x.title.is_empty() { folder.clone() } else { x.title.clone() };
        let note = if x.open { "open elsewhere" } else if x.cwd.is_empty() { "folder unavailable" } else { "saved" };
        let right = [note.to_string(), if many { app.fleet.machine_name(&x.machine) } else { String::new() }, ago(x.last_at)].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("  ");
        let mut row = Row::new(format!("external:{}:{}", x.machine, x.session_id), title)
            .extra(format!("{} {} {} {}", x.cwd, x.engine, engine_label(&x.engine), app.fleet.machine_name(&x.machine)))
            .group("Saved conversations")
            .lead(vec![span("‖", fg(theme::MUTED)), span(" ", Style::default()), span(mark, fg(mark_color)), span(" ", Style::default())])
            .detail(vec![span(folder, fg(theme::MUTED))])
            .right(right)
            .right_narrow(ago(x.last_at));
        row.disabled = x.cwd.is_empty();
        row
    }).collect()
}

/// A hit's snippet on one line: its marks taken off, from a little before the first match
/// (`…`), at most a line's worth.
pub fn snippet_line(snippet: &str) -> String {
    let at = snippet.find('\u{2}').unwrap_or(0);
    let flat = |s: &str| s.replace(['\u{2}', '\u{3}'], "").split_whitespace().collect::<Vec<_>>().join(" ");
    let before: Vec<char> = flat(&snippet[..at]).chars().collect();
    let lead = if before.len() > 24 { format!("…{} ", before[before.len() - 23..].iter().collect::<String>().trim_start()) } else if before.is_empty() { String::new() } else { format!("{} ", before.iter().collect::<String>()) };
    let text = format!("{lead}{}", flat(&snippet[at..]));
    let chars: Vec<char> = text.chars().collect();
    if chars.len() > 110 { format!("{}…", chars[..109].iter().collect::<String>()) } else { text }
}

/// The sessions, when there is more than one: `work: 2 windows`, the one on screen `(attached)`.
pub fn session_rows(app: &App) -> Vec<Row> {
    let all = app.session_list();
    if all.len() < 2 { return Vec::new() }
    all.into_iter().map(|(id, name)| {
        let windows = app.session_windows(id).len();
        // Attached: this client's, or shown by another client.
        let attached = id == app.session_id || app.stash_value(id, "session_attached").as_deref() == Some("1");
        // The harnesses in its windows, in counts (this client's sessions: another's are its).
        let keys = app.session_harnesses(id);
        let counts = state_counts(app, app.fleet.agents.values().filter(|a| keys.contains(&a.key())));
        let right = [counts, if attached { "attached".to_string() } else { String::new() }].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("  ");
        Row::new(format!("session:{id}"), format!("{name}: {windows} windows")).group("Sessions")
            .lead(vec![span("§ ", fg(theme::MUTED))])
            .right(right)
    }).collect()
}

/// Only says something when a filter is on — the count beside the prompt already says the rest.
pub fn open_status(_app: &App, filter: Filter) -> String {
    if filter == Filter::All { String::new() } else { format!("{} · tab ↹", filter.label().to_lowercase()) }
}

/// The mode a launcher query is in, by its first character.
pub fn launcher_kind(query: &str, current: &PickerKind) -> PickerKind {
    match crate::picker::scope_of(query) {
        Some('>') => PickerKind::Palette,
        Some('@') => PickerKind::Machines,
        Some('#') => PickerKind::Projects,
        Some(':') => PickerKind::Models,
        Some('*') => PickerKind::Store,
        Some('?') => PickerKind::Help,
        _ => match current { PickerKind::Open { .. } => current.clone(), _ => PickerKind::Open { filter: Filter::All, machine: None, project: None } },
    }
}

// ── tabs ──

/// The launcher's tabs, in order: the query's first character that opens each (none: harnesses).
pub const LAUNCHER_TABS: &[(Option<char>, &str)] = &[(None, "harnesses"), (Some('>'), "commands"), (Some('@'), "machines"),
    (Some('#'), "projects"), (Some(':'), "models"), (Some('*'), "store"), (Some('?'), "help")];

/// The query that opens the tab [step] along from [query]'s — round from the last to the first.
pub fn next_tab(query: &str, step: i64) -> String {
    let here = crate::picker::scope_of(query);
    let at = LAUNCHER_TABS.iter().position(|(c, _)| *c == here).unwrap_or(0) as i64;
    LAUNCHER_TABS[(at + step).rem_euclid(LAUNCHER_TABS.len() as i64) as usize].0.map(String::from).unwrap_or_default()
}

pub fn is_launcher(kind: &PickerKind) -> bool {
    matches!(kind, PickerKind::Open { .. } | PickerKind::Palette | PickerKind::Machines | PickerKind::Projects | PickerKind::Models | PickerKind::Store | PickerKind::Help)
}

/// (title, placeholder) for a launcher mode.
pub fn launcher_title(app: &App, kind: &PickerKind) -> (String, String) {
    match kind {
        PickerKind::Open { .. } if app.shell_context.sessions_machine.is_some() => ("Sessions on this computer".into(), "Search sessions".into()),
        PickerKind::Open { machine: Some(m), project: None, .. } => (format!("harnesses · @{}", app.fleet.machine_name(m)), "Search this machine's harnesses — esc back".into()),
        PickerKind::Open { project: Some(p), .. } => (format!("harnesses · #{}", p.rsplit('/').next().unwrap_or(p)), "Search this project's harnesses — esc back".into()),
        PickerKind::Open { .. } => ("harnesses".into(), "Search harnesses   > commands   @ machines   # projects   : models   * store   ? help".into()),
        PickerKind::Palette => ("commands".into(), "Run anything by name".into()),
        PickerKind::Machines => ("machines".into(), "Choose a machine, then one of its harnesses".into()),
        PickerKind::Projects => ("projects".into(), "Choose a project, then one of its harnesses".into()),
        // (Which harness Enter moves, in the title: the focused one, or the only one on screen.)
        PickerKind::Models => (crate::models::target(app).and_then(|t| app.fleet.agent(&t.machine, &t.agent)).map(|a| format!("models · for {}", a.name)).unwrap_or_else(|| "models".into()),
            "Search models — Enter uses one on this harness".into()),
        PickerKind::Store => ("store".into(), "Find a harness in the Store".into()),
        PickerKind::Help => ("quick access".into(), "What this box can do".into()),
        _ => (String::new(), String::new()),
    }
}

/// `#`: every project folder with harnesses in it, grouped per machine.
/// A set of harnesses in counts, as the status line's (`?1 ✗1 ✓2 ⠹3`): the states that ask
/// something of you and the working ones; none is nothing.
pub fn state_counts<'a>(app: &App, agents: impl Iterator<Item = &'a crate::fleet::Agent>) -> String {
    let mut n = [0usize; 4];
    for a in agents.filter(|a| a.engine != "terminal") {
        match app.fleet.state_of(a) { State::NeedsInput => n[0] += 1, State::Failed => n[1] += 1, State::Done => n[2] += 1, State::Working => n[3] += 1, _ => {} }
    }
    let glyphs = ["?", "✗", "✓", crate::theme::spinner(app.tick)];
    (0..4).filter(|i| n[*i] > 0).map(|i| format!("{}{}", glyphs[i], n[i])).collect::<Vec<_>>().join(" ")
}

pub fn project_rows(app: &App) -> Vec<Row> {
    let mut groups: std::collections::BTreeMap<(String, String), (usize, usize, u64)> = std::collections::BTreeMap::new();
    for a in app.fleet.agents.values() {
        if a.project_root.is_empty() { continue }
        let entry = groups.entry((a.machine_id.clone(), a.project_root.clone())).or_insert((0, 0, 0));
        entry.0 += 1;
        if !matches!(app.fleet.state_of(a), State::Paused | State::Offline) { entry.1 += 1 }
        entry.2 = entry.2.max(a.recency());
    }
    let many = app.fleet.visible_machines().filter(|m| m.usable()).count() > 1;
    let mut rows: Vec<(u64, Row)> = groups.into_iter().map(|((machine, root), (all, live, recent))| {
        let name = root.rsplit('/').next().unwrap_or(&root).to_string();
        let home = app.homes.get(&machine).cloned().unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
        let short = if !home.is_empty() && root.starts_with(&home) { format!("~{}", &root[home.len()..]) } else { root.clone() };
        // Its harnesses in counts (who needs you there), then how many.
        let counts = state_counts(app, app.fleet.agents.values().filter(|a| a.machine_id == machine && a.project_root == root));
        let right = format!("{}{}{} harness{}{}", if many { format!("{}  ", app.fleet.machine_name(&machine)) } else { String::new() }, if counts.is_empty() { String::new() } else { format!("{counts}  ") }, all, if all == 1 { "" } else { "es" }, if live > 0 { format!(" · {live} live") } else { String::new() });
        (recent, Row::new(format!("proj:{machine}\t{root}"), name).extra(format!("{short} {}", app.fleet.machine_name(&machine)))
            .lead(vec![span(if live > 0 { "✓ " } else { "· " }, fg(if live > 0 { theme::ONLINE } else { theme::MUTED }))])
            .detail(vec![span(short, fg(theme::MUTED))]).right(right).boost(if live > 0 { 30 } else { 0 }))
    }).collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.into_iter().map(|(_, r)| r).collect()
}

/// `?`: what the box does, one prefix per line, then every key.
pub fn mode_rows(app: &App) -> Vec<Row> {
    let hint = |c: &str| app.keymap.hint(c).unwrap_or_default();
    let modes = [(">", "commands", "every tmux command, by name", hint("command-prompt")), ("@", "machines", "a machine, then its harnesses", hint("choose-tree -m")),
        ("#", "projects", "a project folder, then its harnesses", String::new()), (":", "models", "local, shared, subscriptions, APIs", hint("choose-tree -i")),
        ("*", "store", "the Harness Store", hint("choose-tree -S"))];
    let mut rows: Vec<Row> = modes.iter().map(|(p, t, d, k)| Row::new(format!("mode:{p}"), format!("{p} {t}")).detail(vec![span(*d, Style::default().add_modifier(ratatui::style::Modifier::DIM))]).right(k.clone())).collect();
    let prefix = crate::keys::name(&app.keymap.prefix);
    // Each key as part of its line (as fzf would be given it): searched for as any word is
    // (`C-b z`, `PPage`), lit only where the query matches.
    rows.extend(app.keymap.prefix_table.iter().filter(|b| !b.note.is_empty()).map(|b| Row::new(format!("key:{}", b.command), format!("{prefix} {:<7} {}", crate::keys::name(&b.chord), b.note)).extra(b.command.clone())));
    rows
}

pub fn inbox_rows(app: &App) -> Vec<Row> {
    let mut agents: Vec<_> = app.fleet.agents.values().filter(|a| a.question.is_some() && a.status != "stopped").collect();
    agents.sort_by_key(|a| a.question.as_ref().map(|q| q.since));
    let mut rows = Vec::new();
    for a in agents {
        let q = a.question.as_ref().unwrap();
        // Who asks (the harness, its project, its machine), then its options by number — one row
        // a question, answered where it stands (M-1…9, M-a).
        let who = [a.name.clone(), a.project.clone(), app.fleet.machine_name(&a.machine_id)].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
        let options = q.options.iter().enumerate().map(|(i, o)| format!("{} {o}", i + 1)).collect::<Vec<_>>().join(" · ");
        let (mark, mark_color) = engine_mark(&a.engine);
        let since = crate::fleet::now_ms().saturating_sub(q.since.elapsed().as_millis() as u64);
        let mut detail = vec![span(who.clone(), fg(theme::MUTED))];
        if !options.is_empty() { detail.push(span(format!("  {options}"), fg(theme::accent()))) }
        rows.push(Row::new(format!("{}:{}#", a.machine_id, a.id), q.prompt.clone()).extra(format!("{who} {} {options}", a.branch))
            .lead(vec![span("? ", fg(theme::ATTENTION).add_modifier(ratatui::style::Modifier::BOLD)), span(mark, fg(mark_color)), span(" ", Style::default())])
            .detail(detail)
            .right(ago(since)));
    }
    rows
}

/// `>`: every tmux command there is, with the key that runs it.
pub fn palette_rows(app: &App) -> Vec<Row> {
    crate::commands::COMMANDS.iter().map(|(name, alias, about)| {
        let key = app.keymap.key_for_name(name).unwrap_or_default();
        Row::new(*name, *name).extra(format!("{alias} {about}")).detail(vec![span(*about, Style::default().add_modifier(ratatui::style::Modifier::DIM))]).right(key)
    }).collect()
}

/// C-b Enter: hn's own commands (by the names they have in the menus), then every tmux command —
/// each with the key that runs it, where one does.
pub fn command_rows(app: &App) -> Vec<Row> {
    let own = COMMANDS.iter().map(|(id, title, _, hint, group)| {
        let key = own_key(app, id).unwrap_or_default();
        // (Tier 0: searched, listed above every tmux command that matches — `appe` is Appearance,
        // not a word in set-buffer's description. A row shows its name and key only: the hint is
        // searched, not printed, so the list is not a wall of text.)
        Row::new(format!("cmd:{id}"), title.trim_end_matches('…')).extra(format!("{id} {hint} {group}")).right(key).group(*group)
    });
    // tmux's after them, grouped (Windows, Panes…), and none one of hn's runs already (Copy mode is
    // copy-mode): each group's rows together, in TMUX_GROUPS' order.
    let ours: Vec<&str> = COMMANDS.iter().filter_map(|(id, ..)| runs_of(id)).collect();
    let mut tmux: Vec<(usize, Row)> = crate::commands::COMMANDS.iter().filter(|(name, ..)| !ours.contains(name)).map(|(name, alias, _)| {
        let key = app.keymap.key_for_name(name).unwrap_or_default();
        let group = tmux_group(name);
        // (Found by its name and alias: its description is neither shown nor searched — a word in it
        // would outrank what you meant, `appe` → set-buffer's "appends".)
        let row = Row::new(format!("tmux:{name}"), *name).extra(alias.to_string()).right(key).group(format!("tmux · {group}")).tier(1);
        (TMUX_GROUPS.iter().position(|g| *g == group).unwrap_or(TMUX_GROUPS.len()), row)
    }).collect();
    tmux.sort_by_key(|(g, _)| *g);
    own.chain(tmux.into_iter().map(|(_, r)| r)).collect()
}

/// tmux's commands' groups, in the order the list shows them.
const TMUX_GROUPS: &[&str] = &["Windows", "Panes", "Layouts", "Copy & buffers", "Harnesses", "Sessions & clients", "Keys", "Options & config", "Messages & prompts"];

/// The group a tmux command is listed under, by what it acts on.
fn tmux_group(name: &str) -> &'static str {
    let has = |w: &str| name.contains(w);
    if has("harness") || has("task") || has("broadcast") || matches!(name, "send-message" | "take-control" | "open-viewer" | "new-terminal") { "Harnesses" }
    else if has("layout") { "Layouts" }
    else if has("buffer") || name == "copy-mode" { "Copy & buffers" }
    else if has("window-option") || has("option") || has("environment") || matches!(name, "source-file" | "customize-mode") { "Options & config" }
    else if has("pane") || matches!(name, "split-window" | "clear-history") { "Panes" }
    else if has("window") { "Windows" }
    else if has("session") || has("client") || matches!(name, "kill-server" | "choose-tree") { "Sessions & clients" }
    else if has("key") { "Keys" }
    else { "Messages & prompts" }
}

/// The command list as it shows: hn's own commands and one row for tmux's — searched, tmux's too,
/// after hn's (their tier); [in_tmux] (Enter on that row): tmux's alone, grouped. The Panes
/// commands show only to a search: a harness is a pane already, and their keys stay as they are.
pub fn command_rows_for(app: &App, searching: bool, in_tmux: bool) -> Vec<Row> {
    let all = command_rows(app);
    if in_tmux { return all.into_iter().filter(|r| r.id.starts_with("tmux:")).collect() }
    let more = Row::new("cmd:tmux-commands", "tmux commands").extra("tmux every command").group("Settings & help");
    // (Sign out is in the Account panel already, and Take control is a rare repair: both are listed
    // only to a search, as the Panes commands are.)
    let rare = |r: &Row| matches!(r.id.as_str(), "cmd:signout" | "cmd:take");
    let (own, tmux): (Vec<Row>, Vec<Row>) = all.into_iter().filter(|r| searching || (r.group.as_deref() != Some("Panes") && !rare(r))).partition(|r| r.id.starts_with("cmd:"));
    // (The row for tmux's after hn's own settings, before Close hn.)
    let at = own.iter().position(|r| r.id == "cmd:quit").unwrap_or(own.len());
    let mut rows = own;
    rows.insert(at, more);
    if searching { rows.extend(tmux) }
    rows
}

/// The key (prefix, then the key) that runs one of hn's own commands, as the prefix table has it
/// now — so a rebinding shows. The command each menu entry is on a key as.
fn own_key(app: &App, id: &str) -> Option<String> {
    let runs = runs_of(id)?;
    let hit = key_running(app, runs)?;
    Some(format!("{} {}", crate::keys::name(&app.keymap.prefix), crate::keys::name(&hit)))
}

/// The key after the prefix that runs [runs] now, where one does.
pub fn key_running(app: &App, runs: &str) -> Option<crate::keys::Chord> {
    let table = &app.keymap.prefix_table;
    let hit = table.iter().find(|b| b.command == runs)
        .or_else(|| table.iter().find(|b| b.command.split(|c: char| c.is_whitespace() || c == '{' || c == '"').any(|w| w == runs)))
        .or_else(|| table.iter().find(|b| b.command.contains(runs)))?;
    Some(hit.chord)
}

// ── keys ──

/// Keybinds: (title, the command its key runs, group) — the keys a person reaches for, grouped
/// as they think of them. Every other key is `C-b ?` (list-keys), as in tmux.
pub const KEYBINDS: &[(&str, &str, &str)] = &[
    ("Harnesses…", "choose-tree -Zs", "Navigation"),
    ("Harnesses needing input", "choose-tree -a", "Navigation"),
    ("Next harness waiting on you", "next-harness", "Navigation"),
    ("Machines…", "choose-tree -m", "Navigation"),
    ("Pane left", "select-pane -L", "Navigation"),
    ("Pane right", "select-pane -R", "Navigation"),
    ("Pane up", "select-pane -U", "Navigation"),
    ("Pane down", "select-pane -D", "Navigation"),
    ("Next Tab", "next-window", "Navigation"),
    ("Previous Tab", "previous-window", "Navigation"),
    ("Last Tab", "last-window", "Navigation"),
    ("Split right", "split-window -h", "Panes"),
    ("Split down", "split-window", "Panes"),
    ("Close pane", "kill-pane", "Panes"),
    ("Zoom pane", "resize-pane -Z", "Panes"),
    ("Equalize panes", "select-layout -E", "Panes"),
    ("Next layout", "next-layout", "Panes"),
    ("Copy mode", "copy-mode", "Panes"),
    ("Find in pane…", "find-window", "Panes"),
    ("New Tab", "new-window", "Tabs (tmux windows)"),
    ("Rename Tab…", "rename-window", "Tabs (tmux windows)"),
    ("Close Tab", "kill-window", "Tabs (tmux windows)"),
    ("Move pane to a new tab", "break-pane", "Tabs (tmux windows)"),
    ("New Harness…", "new-harness", "Harnesses"),
    ("New terminal", "new-terminal", "Harnesses"),
    ("Models…", "choose-tree -i", "Harnesses"),
    ("Send to harness…", "send-task", "Harnesses"),
    ("Clone harness", "clone-harness", "Harnesses"),
    ("Restart harness", "restart-harness", "Harnesses"),
    ("Pause harness", "pause-harness", "Harnesses"),
    ("Commands", "choose-command", "General"),
    ("Every key (tmux's list)", "list-keys -N", "General"),
    ("Command prompt", "command-prompt", "General"),
    ("Detach", "detach-client", "General"),
];

/// The Keybinds panel: the prefix and the second one, then each command with its key now (or —).
/// Enter on one: the next key you press is it.
pub fn keybind_rows(app: &App) -> Vec<Row> {
    let prefix = crate::keys::name(&app.keymap.prefix);
    let prefixes = [
        Row::new("prefix", "Prefix").detail(vec![span("the key before every command", fg(theme::MUTED))]).right(prefix.clone()).group("Prefix"),
        Row::new("prefix2", "Second prefix").detail(vec![span("another key that works as the prefix", fg(theme::MUTED))])
            .right(app.keymap.prefix2.map(|c| crate::keys::name(&c)).unwrap_or_else(|| "none".into())).group("Prefix"),
    ];
    prefixes.into_iter().chain(KEYBINDS.iter().enumerate().map(|(i, (title, runs, group))| {
        let key = key_running(app, runs).map(|c| format!("{prefix} {}", crate::keys::name(&c))).unwrap_or_else(|| "—".into());
        Row::new(format!("key:{i}"), *title).right(key).group(*group)
    })).collect()
}

/// The tmux command one of hn's own commands is on a key as.
pub fn runs_of(id: &str) -> Option<&'static str> {
    Some(match id {
        "open" => "choose-tree -Zs", "models" => "choose-tree -i", "new" => "new-harness", "terminal" => "new-terminal",
        "inbox" => "choose-tree -a", "next-waiting" => "next-harness", "send" => "send-task", "broadcast" => "broadcast",
        "clone" => "clone-harness", "restart" => "restart-harness", "pause" => "pause-harness", "tab" => "new-window",
        "rename-tab" => "rename-window", "close-tab" => "kill-window", "next-tab" => "next-window", "prev-tab" => "previous-window",
        "split-right" => "split-window -h", "split-down" => "split-window", "close-pane" => "kill-pane", "zoom" => "resize-pane -Z",
        "equalize" => "select-layout -E", "find" => "find-window", "copy-mode" => "copy-mode", "machines" => "choose-tree -m",
        "store" => "choose-tree -S", "help" => "list-keys -N", "theme" | "commands" => "choose-command",
        _ => return None,
    })
}

/// Commands that mean nothing without words after them.
pub const NEEDS_ARGS: &[&str] = &["select-window", "rename-window", "move-window", "select-pane", "resize-pane", "swap-pane", "select-layout", "send-keys", "command-prompt", "confirm-before", "display-message", "send-message", "rename-harness", "send-task", "broadcast"];

pub fn machine_rows(app: &App) -> Vec<Row> {
    app.fleet.visible_machines().map(|m| {
        // Its harnesses by what they do: the fleet's counts, for this machine.
        let here: Vec<State> = app.fleet.agents.values().filter(|a| a.machine_id == m.id && a.engine != "terminal").map(|a| app.fleet.state_of(a)).collect();
        let n = |s: State| here.iter().filter(|x| **x == s).count();
        // (The harnesses' marks, no round ones: `✓` connected, a spinner connecting, `?` to link…)
        let (dot, color) = theme::machine_mark(&m.reach, m.online(), app.tick);
        let word: String = match &m.reach {
            _ if m.local && m.reach == Reach::Ready => "this computer".into(),
            Reach::Ready => "connected".into(),
            Reach::Connecting => "connecting…".into(),
            Reach::NeedsLink => "not linked — M-l links it".into(),
            Reach::Error(e) => e.chars().take(40).collect(),
            _ if m.online() => "online".into(),
            _ => "offline".into(),
        };
        let rtt = app.rtt.get(&m.id).filter(|_| m.usable()).map(|d| format!("{}ms  ", d.as_millis())).unwrap_or_default();
        let counts = [(State::NeedsInput, "waiting"), (State::Failed, "failed"), (State::Done, "done"), (State::Working, "working"), (State::Ready, "idle")]
            .iter().filter(|(s, _)| n(*s) > 0).map(|(s, w)| format!("{} {w}", n(*s))).collect::<Vec<_>>().join(" · ");
        let counts = format!("{rtt}{}", if counts.is_empty() { "no harnesses".into() } else { counts });
        Row::new(m.id.clone(), app.fleet.machine_name(&m.id)).extra(m.status.clone())
            .lead(vec![span(dot, fg(color)), span(" ", Style::default())])
            .detail(vec![span(word, fg(color))])
            .right(counts)
    }).collect()
}

pub fn layout_rows(count: usize) -> Vec<Row> {
    crate::desk_layout::choices(count).into_iter()
        .map(|id| Row::new(id, crate::desk_layout::label(id))).collect()
}

/// `hn theme`: every choice in the config file's `[look]` table, one per row, the current value
/// marked. Picking a row applies it live and writes it back to `tui.toml` — so the file stays the
/// single place the look is described.
/// The look/theme picker, level one: the sections. Right/Enter opens one's options in the same
/// list; the right pane previews the one the cursor is on.
pub fn theme_sections(app: &App) -> Vec<Row> {
    let o = &app.options;
    let status = o.get("pane-border-status", "", None).unwrap_or_else(|| "top".into());
    // (Named as its options are: the highlighted border, or the rest blurred.)
    // (And, with either, the other panes dimmed or not.)
    let focus = format!("{}{}", if o.focus_style() == "surface" { "blurred" } else { "border" }, if o.dim_others() { " · dim" } else { "" });
    let focus = focus.as_str();
    let theme = o.get("@hn-theme", "", None).unwrap_or_default();

    let sec = |id: &str, title: &str, detail: &str, cur: &str| Row::new(id, title)
        .detail(vec![span(detail, fg(theme::MUTED))])
        .right(if cur.is_empty() { "—".into() } else { cur.to_string() });

    vec![
        // (The lines' glyphs and tmux's arrow indicators are tmux.conf's to set: with every pane its
        // own box, coloured when focused, they say nothing more. Nor is the split direction here:
        // C-b % and C-b " choose it each time, and a harness hn opens splits by the pane's shape —
        // `layout_orientation` in tui.toml, or @hn-layout, where you want one way always. Nor a
        // layout: C-b Space, C-b M-1…5 and Commands → Layout… lay the panes out now.)
        sec("section:theme", "Theme", "bundled terminal themes", if theme.is_empty() { "terminal" } else { &theme }),
        sec("section:status", "Pane titles", "pane-border-status", &status),
        sec("section:focus", "Focus", "focus_style", focus),
        // ── status bar ──
        sec("section:bar", "Status bar", "status_bar", status_bar_of(app)),
        sec("section:boxes", "Borders", "every pane its own box", if border_style_of(app) == "box" { "on" } else { "off" }),
        // ── status bar tabs ──
        sec("section:tab", "Tab", "how the current tab is marked", tab_active_of(app)),
        // (No "Tab name": a tab shows the selected pane's title, or auto rename's name. `@hn-window-name
        // tmux` in a tmux.conf or tui.toml still shows the window's name instead.)
        sec("section:autorename", "Auto rename", "a window named for its repo and its work", if app.options.auto_rename() { "on" } else { "off" }),
        // (Keys are Keybinds', a panel of their own in Commands.)
    ]
}

// ── status bar ──

/// Where the status bar is: `@hn-status-bar`, or (none said) where tmux.conf's status-position put it.
fn status_bar_of(app: &App) -> &'static str { match app.options.status_bar() { "bottom" if app.status_top => "top", b => b } }

/// How panes are set apart: `box` unless `@hn-border line`.
fn border_style_of(app: &App) -> &'static str { app.options.border_style() }

/// How the current tab is marked: `star` (default) | `filled` (`@hn-window-active`).
fn tab_active_of(app: &App) -> &'static str { if app.options.get("@hn-window-active", "", None).as_deref() == Some("filled") { "filled" } else { "star" } }

/// The look/theme picker, level two: the options of one section. Enter on one applies it (and the
/// ▼ moves to it); Left/Esc returns to the section list.
pub fn theme_options(app: &App, section: &str) -> Vec<Row> {
    let o = &app.options;
    let mark = |is: bool| if is { "✓ " } else { "  " };
    let lead = |is: bool| vec![span(mark(is), fg(if is { theme::accent() } else { theme::MUTED }))];
    let current = |key: &str, default: &str| o.get(key, "", None).unwrap_or_else(|| default.into());
    let opt = |id: String, label: &str, picked: bool, hint: &str| {
        Row::new(id, label).lead(lead(picked)).detail(vec![span(if picked { "current" } else { hint }, fg(theme::MUTED))])
    };
    match section {
        "status" => { let cur = current("pane-border-status", "top");
            ["off", "top", "bottom"].iter().map(|v| opt(format!("border_status:{v}"), *v, cur == *v, "pane-border-status")).collect() }
        "indicators" => { let cur = current("pane-border-indicators", "colour");
            ["off", "colour", "arrows", "both"].iter().map(|v| opt(format!("border_indicators:{v}"), *v, cur == *v, "pane-border-indicators")).collect() }
        "border" => { let cur = current("pane-border-lines", "single");
            ["single", "double", "heavy", "simple", "number"].iter().map(|v| opt(format!("border_lines:{v}"), *v, cur == *v, "pane-border-lines")).collect() }
        "focus" => { let cur = o.focus_style().to_string();
            let styles = ["line", "surface"].iter().map(|v| opt(format!("focus:{v}"), if *v == "line" { "border" } else { "blurred" }, cur == *v, "focus_style"));
            // With either: the panes you are not in, a little quieter — a switch (Enter turns it
            // over; the preview shows it turned).
            let on = o.dim_others();
            let dim = Row::new(if on { "dim:off" } else { "dim:on" }, "Dim other panes").lead(lead(on))
                .detail(vec![span(if on { "on" } else { "the panes you are not in, a little quieter" }, fg(theme::MUTED))]);
            styles.chain(std::iter::once(dim)).collect() }
        "theme" => {
            let cur = o.get("@hn-theme", "", None).unwrap_or_default();
            // First, no theme: the terminal's own colours.
            let native = Row::new("theme:", "Terminal default").extra("none default terminal").lead(lead(cur.is_empty()));
            std::iter::once(native).chain(TERMINAL_THEMES.iter().map(|t| {
                let picked = cur == t.name;
                Row::new(format!("theme:{}", t.name), t.name).extra(t.name).lead(lead(picked))
            })).collect()
        }
        // ── status bar ──
        "bar" => { let cur = status_bar_of(app);
            [("bottom", "tmux's status line, at the bottom"), ("top", "tmux's status line, at the top"), ("left", "a bar down the left: windows and their panes, machines"), ("right", "a bar down the right")]
                .iter().map(|(v, hint)| opt(format!("status_bar:{v}"), v, cur == *v, hint)).collect() }
        "boxes" => { let cur = border_style_of(app);
            [("box", "on", "every pane its own box"), ("line", "off", "tmux's lines between panes")]
                .iter().map(|(v, label, hint)| opt(format!("border_style:{v}"), label, cur == *v, hint)).collect() }
        "tab" => { let cur = tab_active_of(app);
            // (`pane`, an older tui.toml's word, is `short`.)
            let named = match o.get("@hn-window-name", "", None).as_deref() { Some("full") => "full", Some("tmux") => "tmux", _ => "short" };
            let short = format!("names cut to {} columns, as tmux's", crate::options::TAB_NAME_COLS);
            [("star", "star", "the current tab is marked *"), ("filled", "filled", "the current tab is filled (inverted)")]
                .iter().map(|(v, label, hint)| opt(format!("window_active:{v}"), label, cur == *v, hint))
                .chain([("short", "short names", short.as_str()), ("full", "full names", "each tab's whole name")]
                    .iter().map(|(v, label, hint)| opt(format!("window_name:{v}"), label, named == *v, hint)))
                .collect() }
        "autorename" => { let cur = if o.auto_rename() { "on" } else { "off" };
            [("on", "a window with a repo is named for it and its work, by a small model, in the background (Harness TUI LMStudio)"),
             ("off", "windows keep the names they have")]
                .iter().map(|(v, hint)| opt(format!("auto_rename:{v}"), v, cur == *v, hint)).collect() }
        _ => vec![],
    }
}


pub fn new_machine_rows(app: &App, prefer: &str) -> Vec<Row> {
    let prefer = app.fleet.launch_machine_id(prefer);
    let mut rows: Vec<Row> = app.fleet.visible_machines().filter(|m| m.usable()).map(|m| {
        let running = app.fleet.agents.values().filter(|a| a.machine_id == m.id && a.status == "active").count();
        Row::new(m.id.clone(), app.fleet.machine_name(&m.id))
            .lead(vec![span(if m.id == prefer { "✓ " } else { "  " }, fg(theme::accent()))])
            .detail(vec![span(format!("{}{running} running", if m.local { "this computer · " } else { "" }), fg(theme::MUTED))])
    }).collect();
    rows.sort_by_key(|r| r.id != prefer);
    rows
}

pub fn new_what_rows(catalog: &[Value]) -> Vec<Row> {
    let mut rows: Vec<Row> = ENGINES.iter().filter(|e| **e != "terminal").map(|e| {
        let (mark, color) = engine_mark(e);
        Row::new(format!("engine:{e}"), engine_label(e)).extra(*e).group("Agents")
            .lead(vec![span(mark, fg(color)), span(" ", Style::default())])
    }).collect();
    for row in catalog {
        if row.get("installed").and_then(Value::as_bool) == Some(false) || row.get("kind").and_then(Value::as_str) == Some("viewer") { continue }
        let Some(id) = row.get("id").and_then(Value::as_str) else { continue };
        let name = row.get("name").and_then(Value::as_str).unwrap_or(id);
        let description = row.get("description").and_then(Value::as_str).unwrap_or("");
        let engine = row.get("engine").and_then(Value::as_str).unwrap_or("claude");
        if engine == "terminal" { continue }
        rows.push(Row::new(format!("dsh:{id}:{engine}"), name).extra(format!("{id} {description}")).group("From the Store")
            .lead(vec![span("◆ ", fg(theme::TEAL))]).detail(vec![span(description.to_string(), fg(theme::MUTED))]));
    }
    rows
}

pub fn store_rows(catalog: &[Value]) -> Vec<Row> {
    catalog.iter().filter(|r| r.get("kind").and_then(Value::as_str) != Some("viewer")).filter_map(|row| {
        let id = row.get("id")?.as_str()?;
        let installed = row.get("installed").and_then(Value::as_bool) != Some(false);
        let name = row.get("name").and_then(Value::as_str).unwrap_or(id);
        let description = row.get("description").and_then(Value::as_str).unwrap_or("");
        let category = row.get("category").and_then(Value::as_str).unwrap_or(if installed { "Installed" } else { "Available" });
        Some(Row::new(id, name).extra(format!("{id} {description} {category}")).group(category.to_string())
            .lead(vec![span(if installed { "✓ " } else { "  " }, fg(theme::ONLINE))])
            .detail(vec![span(description.to_string(), fg(theme::MUTED))]))
    }).collect()
}

pub fn route_rows(reply: &Value) -> Vec<Row> {
    let best = reply.get("agentId").and_then(Value::as_str).unwrap_or("");
    let mut rows: Vec<Row> = reply.get("candidates").and_then(Value::as_array).cloned().unwrap_or_default().iter().filter_map(|c| {
        let agent = c.get("agentId")?.as_str()?;
        let machine = c.get("machineId")?.as_str()?;
        let (mark, color) = engine_mark(c.get("engine").and_then(Value::as_str).unwrap_or(""));
        let confidence = c.get("confidence").and_then(Value::as_f64).unwrap_or(0.0);
        Some(Row::new(format!("{machine}:{agent}"), c.get("name").and_then(Value::as_str).unwrap_or(agent).to_string())
            .lead(vec![span(mark, fg(color)), span(" ", Style::default())])
            .detail(vec![span(c.get("recent").and_then(Value::as_str).unwrap_or("").to_string(), fg(theme::MUTED))])
            .right(format!("{}  {}", c.get("machine").and_then(Value::as_str).unwrap_or(""), if confidence > 0.0 { format!("{}%", (confidence * 100.0) as u32) } else { String::new() })))
    }).collect();
    rows.sort_by_key(|r| !r.id.ends_with(best) || best.is_empty());
    rows
}

#[cfg(test)]
mod theme_row_tests {
    use super::*;
    use crate::app::App;
    use crate::terminal_themes::TERMINAL_THEMES;

    fn app() -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (150, 42));
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(crate::fleet::Machine { shared: false,
            id: "local".into(), name: "studio".into(), local: true, status: "online".into(), reach: crate::fleet::Reach::Ready,
        });
        app.homes.insert("local".into(), "/home/dev".into());
        app
    }

    #[test]
    fn theme_sections_list_the_look_sections() {
        let app = app();
        let rows = theme_sections(&app);
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["section:theme", "section:status", "section:focus",
            // ── status bar ──
            "section:bar", "section:boxes", "section:tab", "section:autorename"]);
        // Each section shows its current value and opens onto a non-empty option list.
        assert!(rows.iter().all(|r| !r.right.is_empty()), "each section shows a value");
        for r in &rows {
            let sec = r.id.strip_prefix("section:").unwrap();
            assert!(!theme_options(&app, sec).is_empty(), "{sec} has options");
        }
    }

    #[test]
    fn theme_options_list_every_bundled_theme() {
        let app = app();
        let rows = theme_options(&app, "theme");
        // The terminal's own colours first, then every bundled theme.
        assert_eq!(rows.len(), TERMINAL_THEMES.len() + 1, "every bundled theme listed");
        assert_eq!(rows.first().map(|r| r.id.as_str()), Some("theme:"));
        let first_id = format!("theme:{}", TERMINAL_THEMES[0].name);
        assert_eq!(rows.get(1).map(|r| r.id.as_str()), Some(first_id.as_str()));
        assert!(rows.iter().all(|r| !r.lead.is_empty()), "mark on every theme row");
    }

    #[test]
    fn matching_theme_is_marked() {
        let a0 = app();
        let rows = theme_options(&a0, "theme");
        let idx = rows.iter().position(|r| r.id == "theme:Adwaita").unwrap();
        assert!(!rows[idx].lead.iter().any(|s| s.content.as_ref() == "✓ "));
        let mut a1 = app();
        let global = crate::options::SetFlags { global: true, ..Default::default() };
        let _ = a1.options.set("@hn-theme", Some("Adwaita"), &global, "", 0);
        let rows = theme_options(&a1, "theme");
        let idx = rows.iter().position(|r| r.id == "theme:Adwaita").unwrap();
        assert!(rows[idx].lead.iter().any(|s| s.content.as_ref() == "✓ "));
    }

    #[test]
    fn an_option_section_lists_its_choices() {
        let app = app();
        let status_opts = theme_options(&app, "status");
        let status_ids: Vec<&str> = status_opts.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(status_ids, vec!["border_status:off", "border_status:top", "border_status:bottom"]);
        // (No split direction section: C-b % and C-b " choose it.)
        assert!(theme_options(&app, "split").is_empty());
    }

    #[test]
    fn the_tab_section_lists_its_choices_and_there_is_no_tab_name_section() {
        let a0 = app();
        let tab_rows = theme_options(&a0, "tab");
        let tab_ids: Vec<&str> = tab_rows.iter().map(|r| r.id.as_str()).collect();
        // (How long a tab's name is shown is in the same section: short, the default, or full.)
        assert_eq!(tab_ids, vec!["window_active:star", "window_active:filled", "window_name:short", "window_name:full"]);
        assert!(tab_rows[2].lead.iter().any(|s| s.content.contains('✓')), "short names by default");
        // The mark follows the option in use.
        let mut a1 = app();
        let global = crate::options::SetFlags { global: true, ..Default::default() };
        let _ = a1.options.set("@hn-window-active", Some("filled"), &global, "", 0);
        let filled = theme_options(&a1, "tab");
        let idx = filled.iter().position(|r| r.id == "window_active:filled").unwrap();
        assert!(filled[idx].lead.iter().any(|s| s.content.as_ref() == "✓ "));
        // No Tab name: a tab shows the selected pane's title, or auto rename's name.
        assert!(theme_options(&a0, "tabname").is_empty());
        assert!(!theme_sections(&a0).iter().any(|r| r.id == "section:tabname"));
    }

    /// Auto rename is a switch of its own in Appearance, off until turned on, and saved to tui.toml.
    #[test]
    fn auto_rename_is_a_switch_off_until_turned_on() {
        let mut app = app();
        let section = |app: &App| theme_sections(app).into_iter().find(|r| r.id == "section:autorename").map(|r| r.right).unwrap();
        assert_eq!(section(&app), "off");
        assert_eq!(theme_options(&app, "autorename").iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["auto_rename:on", "auto_rename:off"]);
        assert_eq!(app.set_look("auto_rename", "on"), "auto rename: on");
        assert!(app.options.auto_rename());
        assert_eq!(section(&app), "on");
        let look = crate::config::Look { auto_rename: Some("on".into()), ..Default::default() };
        assert!(look.assignments().contains(&("@hn-auto-rename".into(), "on".into())), "tui.toml's auto_rename turns it on at start");
    }

    // ── keys ──

    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    /// A key pressed while a command's key is being chosen; what was said (no panel open: the
    /// client's message).
    fn press(app: &mut App, code: KeyCode, mods: KeyModifiers) -> String {
        crate::settings::captured(app, KeyEvent::new(code, mods));
        app.toast.as_ref().map(|t| t.0.clone()).unwrap_or_default()
    }

    /// What the key after the prefix runs now.
    fn runs(app: &App, code: KeyCode, mods: KeyModifiers) -> Option<String> { app.keymap.prefix_command(&crate::keys::of(&KeyEvent::new(code, mods))).map(|b| b.command.clone()) }

    /// Enter on [title]'s Keybinds row: its key is the next one pressed.
    fn change(app: &mut App, title: &str) -> Option<String> {
        let i = KEYBINDS.iter().position(|k| k.0 == title).unwrap().to_string();
        crate::settings::set_key(app, "key", &i)
    }

    fn right(app: &App, title: &str) -> String { keybind_rows(app).into_iter().find(|r| r.label == title).map(|r| r.right).unwrap() }

    // ── commands ──

    /// The command list: hn's own commands, each named in sentence case, and one row for tmux's —
    /// Enter on it lists them, grouped (Windows, Panes…), none that one of hn's runs already. A
    /// search finds both, hn's first.
    #[test]
    fn commands_are_hns_then_tmuxs_grouped_and_never_twice() {
        let app = app();
        let rows = command_rows_for(&app, false, false);
        let own: Vec<&Row> = rows.iter().filter(|r| r.id.starts_with("cmd:")).collect();
        assert!(rows.iter().all(|r| r.id.starts_with("cmd:")), "tmux's are behind their one row");
        assert!(own.iter().any(|r| r.id == "cmd:tmux-commands"));
        // The Panes commands only to a search (a harness is a pane already).
        assert!(!rows.iter().any(|r| r.group.as_deref() == Some("Panes")), "no Panes until searched");
        assert!(command_rows_for(&app, true, false).iter().any(|r| r.id == "cmd:split-right"), "searched, Split right is there");
        let inside = command_rows_for(&app, false, true);
        assert!(inside.iter().all(|r| r.id.starts_with("tmux:")), "inside: tmux's only");
        let tmux: Vec<&Row> = inside.iter().collect();
        // Sentence case: no word after the first starts with a capital (but hn and names).
        for r in &own {
            let caps: Vec<&str> = r.label.split_whitespace().skip(1).filter(|w| w.starts_with(|c: char| c.is_uppercase()) && !["Tab", "Tab…", "Harness…"].contains(w)).collect();
            assert!(caps.is_empty(), "{:?} {caps:?}", r.label);
        }
        // Grouped: each group's rows together, every group named for tmux.
        let mut groups: Vec<String> = Vec::new();
        for g in tmux.iter().filter_map(|r| r.group.clone()) { if groups.last() != Some(&g) { assert!(!groups.contains(&g), "{g} split"); groups.push(g) } }
        assert!(groups.len() > 3 && groups.iter().all(|g| g.starts_with("tmux · ")), "{groups:?}");
        // Never twice: copy-mode, new-window, clone-harness are hn's own already.
        for name in ["copy-mode", "new-window", "clone-harness", "kill-pane"] { assert!(!tmux.iter().any(|r| r.label == name), "{name} twice") }
        assert!(tmux.iter().any(|r| r.label == "select-layout"));
        // Searched: hn's matches before tmux's, whatever they score.
        let mut p = crate::picker::Picker::new("Commands", "");
        p.search_extra = true; // as the panel opens it: a row's hint is searched, not shown
        p.set_rows(command_rows_for(&app, true, false));
        p.set_query("lay");
        let shown: Vec<&str> = p.visible.iter().map(|(i, _)| p.rows[*i].id.as_str()).collect();
        let first_tmux = shown.iter().position(|id| id.starts_with("tmux:")).unwrap();
        assert!(shown[..first_tmux].contains(&"cmd:layout") && shown[first_tmux..].iter().all(|id| id.starts_with("tmux:")), "{shown:?}");
    }

    /// The list is names and keys: no description beside a row. Account is one row (Sign out is in
    /// it), so Sign out is listed only to a search, and both words find their way.
    #[test]
    fn commands_show_names_and_keys_only_and_sign_out_is_found_by_search() {
        let app = app();
        for searching in [false, true] {
            for row in command_rows_for(&app, searching, false).iter().chain(command_rows_for(&app, searching, true).iter()) {
                assert!(row.detail.is_empty(), "{} has text beside it", row.label);
            }
        }
        let listed = command_rows_for(&app, false, false);
        assert!(listed.iter().any(|r| r.id == "cmd:account" && r.label == "Account"), "one Account row, without a sign-in suffix");
        assert!(listed.iter().all(|r| !r.label.ends_with('…')), "names only, no trailing ellipsis");
        assert!(!listed.iter().any(|r| r.id == "cmd:signout" || r.id == "cmd:take"), "Sign out and Take control are not listed");
        for searching in [false, true] {
            let mut groups: Vec<String> = Vec::new();
            for g in command_rows_for(&app, searching, false).iter().filter(|r| r.id.starts_with("cmd:")).filter_map(|r| r.group.clone()) { if groups.last() != Some(&g) { groups.push(g) } }
            assert_eq!(groups.iter().filter(|g| *g == "General").count(), 1, "one General heading (searching {searching}): {groups:?}");
        }
        let find = |query: &str| {
            let mut p = crate::picker::Picker::new("Commands", "");
            p.search_extra = true;
            p.set_rows(command_rows_for(&app, true, false));
            p.set_query(query);
            p.visible.iter().map(|(i, _)| p.rows[*i].id.clone()).collect::<Vec<_>>()
        };
        assert!(find("sign out").contains(&"cmd:signout".to_string()), "searching finds Sign out");
        assert!(find("sign in").contains(&"cmd:account".to_string()), "searching finds Account");
        assert!(find("take control").contains(&"cmd:take".to_string()), "searching finds Take control");
    }

    /// Keybinds: the prefix and the second one first, then the commands grouped with their keys
    /// now. Appearance has no keys section.
    #[test]
    fn keybinds_are_the_prefixes_then_every_command_grouped() {
        let app = app();
        let rows = keybind_rows(&app);
        assert_eq!((rows[0].id.as_str(), rows[0].label.as_str(), rows[0].right.as_str()), ("prefix", "Prefix", "C-b"));
        assert_eq!((rows[1].id.as_str(), rows[1].right.as_str()), ("prefix2", "none"));
        let mut groups: Vec<String> = Vec::new();
        for g in rows.iter().filter_map(|r| r.group.clone()) { if groups.last() != Some(&g) { groups.push(g) } }
        assert_eq!(groups, ["Prefix", "Navigation", "Panes", "Tabs (tmux windows)", "Harnesses", "General"]);
        assert_eq!(right(&app, "Split right"), "C-b %");
        assert!(theme_sections(&app).iter().all(|r| r.id != "section:keys") && theme_options(&app, "keys").is_empty());
    }

    /// Any key the terminal sends becomes the prefix at once — Esc cancels, so not Esc — as `set -g
    /// prefix` does: no binding added or changed (prefix Enter is still Commands with Enter as the
    /// prefix). The second prefix the same; ⌫ none. Saved to tui.toml.
    #[test]
    fn any_key_becomes_the_prefix_and_no_binding_changes() {
        let mut app = app();
        let prefix = |app: &App| crate::keys::name(&app.keymap.prefix);
        let set = |app: &mut App, knob: &str| crate::settings::set_key(app, knob, "").unwrap_or_default();
        let before: Vec<(String, String)> = app.keymap.prefix_table.iter().map(|b| (crate::keys::name(&b.chord), b.command.clone())).collect();
        for (code, mods, name) in [(KeyCode::Char('a'), KeyModifiers::CONTROL, "C-a"), (KeyCode::Enter, KeyModifiers::NONE, "Enter"), (KeyCode::F(12), KeyModifiers::NONE, "F12"), (KeyCode::Char('`'), KeyModifiers::NONE, "`")] {
            assert_eq!(set(&mut app, "prefix"), "Prefix: press a key · Esc cancels");
            assert_eq!(press(&mut app, code, mods), format!("Prefix: {name} — saved"));
            assert_eq!(prefix(&app), name);
            assert!(app.capturing.is_none());
        }
        let after: Vec<(String, String)> = app.keymap.prefix_table.iter().map(|b| (crate::keys::name(&b.chord), b.command.clone())).collect();
        assert_eq!(after, before, "no binding added or changed");
        assert_eq!(runs(&app, KeyCode::Enter, KeyModifiers::NONE).as_deref(), Some("choose-command"), "prefix Enter is still Commands");
        let _ = set(&mut app, "prefix");
        assert_eq!(press(&mut app, KeyCode::Esc, KeyModifiers::NONE), "Unchanged");
        assert_eq!(prefix(&app), "`");
        assert_eq!(set(&mut app, "prefix2"), "Second prefix: press a key · ⌫ none · Esc cancels");
        assert_eq!(press(&mut app, KeyCode::Char('b'), KeyModifiers::CONTROL), "Second prefix: C-b — saved");
        assert_eq!(app.keymap.prefix2.map(|c| crate::keys::name(&c)).as_deref(), Some("C-b"));
        let _ = set(&mut app, "prefix2");
        assert_eq!(press(&mut app, KeyCode::Backspace, KeyModifiers::NONE), "Second prefix: none — saved");
        assert_eq!(app.keymap.prefix2, None);
    }

    /// A key chosen is the command's: its old key given up, the command in full kept (Rename
    /// swarm still asks for the name).
    #[test]
    fn a_key_chosen_frees_the_old_one_and_keeps_the_full_command() {
        let mut app = app();
        assert!(change(&mut app, "Split right").is_some_and(|s| s == "Split right: press a key · Esc cancels"));
        assert!(press(&mut app, KeyCode::Char('h'), KeyModifiers::NONE).starts_with("Split right: C-b h"));
        assert_eq!(runs(&app, KeyCode::Char('h'), KeyModifiers::NONE).as_deref(), Some("split-window -h"));
        assert_eq!(runs(&app, KeyCode::Char('%'), KeyModifiers::NONE), None);
        assert_eq!(right(&app, "Split right"), "C-b h");
        assert!(app.capturing.is_none());
        let _ = change(&mut app, "Rename Tab…");
        press(&mut app, KeyCode::F(5), KeyModifiers::NONE);
        assert!(runs(&app, KeyCode::F(5), KeyModifiers::NONE).is_some_and(|c| c.contains("command-prompt") && c.contains("rename-window")));
        assert_eq!(runs(&app, KeyCode::Char(','), KeyModifiers::NONE), None);
    }

    /// A key that runs another command is replaced only on its second press: the first says
    /// what it runs.
    #[test]
    fn a_key_in_use_needs_a_second_press() {
        let mut app = app();
        let _ = change(&mut app, "Split right");
        assert_eq!(press(&mut app, KeyCode::Char('n'), KeyModifiers::NONE), "C-b n is Next Tab — n again to replace · Esc to keep");
        assert!(app.capturing.is_some(), "still waiting");
        assert_eq!(runs(&app, KeyCode::Char('n'), KeyModifiers::NONE).as_deref(), Some("next-window"));
        assert_eq!(runs(&app, KeyCode::Char('%'), KeyModifiers::NONE).as_deref(), Some("split-window -h"));
        assert!(press(&mut app, KeyCode::Char('n'), KeyModifiers::NONE).starts_with("Split right: C-b n"));
        assert!(app.capturing.is_none());
        assert_eq!(runs(&app, KeyCode::Char('n'), KeyModifiers::NONE).as_deref(), Some("split-window -h"));
        assert_ne!(right(&app, "Next Tab"), "C-b n");
        // A command with no title of its own is named by its command.
        let _ = change(&mut app, "Split down");
        assert!(press(&mut app, KeyCode::Char('t'), KeyModifiers::NONE).starts_with("C-b t is clock-mode — t again"));
    }

    /// Esc — or any other key, once a key in use is named — keeps every key as it was.
    #[test]
    fn esc_or_another_key_keeps_every_key() {
        let mut app = app();
        let _ = change(&mut app, "Split right");
        assert_eq!(press(&mut app, KeyCode::Esc, KeyModifiers::NONE), "Unchanged");
        assert!(app.capturing.is_none());
        for other in [KeyCode::Esc, KeyCode::Char('y')] {
            let _ = change(&mut app, "Split right");
            press(&mut app, KeyCode::Char('n'), KeyModifiers::NONE);
            assert_eq!(press(&mut app, other, KeyModifiers::NONE), "Unchanged");
            assert!(app.capturing.is_none());
            assert_eq!(runs(&app, KeyCode::Char('n'), KeyModifiers::NONE).as_deref(), Some("next-window"));
            assert_eq!(runs(&app, KeyCode::Char('%'), KeyModifiers::NONE).as_deref(), Some("split-window -h"));
            assert_eq!(runs(&app, KeyCode::Char('y'), KeyModifiers::NONE), None);
        }
    }

    /// The prefix (and the second one), Enter, and Esc with a modifier are refused, each with
    /// why; the panel keeps waiting for a key.
    #[test]
    fn the_prefix_enter_and_a_modified_esc_are_refused() {
        let mut app = app();
        app.keymap.prefix2 = Some(crate::keys::parse("C-a").unwrap());
        let _ = change(&mut app, "Split right");
        let before = app.keymap.prefix_table.clone();
        for (code, mods, why) in [
            (KeyCode::Char('b'), KeyModifiers::CONTROL, "C-b is the prefix — press another key · Esc cancels"),
            (KeyCode::Char('a'), KeyModifiers::CONTROL, "C-a is the second prefix — press another key · Esc cancels"),
            (KeyCode::Enter, KeyModifiers::NONE, "Enter can not be a key here (C-b Enter is Commands) — press another key · Esc cancels"),
            (KeyCode::Esc, KeyModifiers::ALT, "Esc can not be a key here (it cancels) — press another key · Esc cancels"),
            (KeyCode::Esc, KeyModifiers::CONTROL, "Esc can not be a key here (it cancels) — press another key · Esc cancels"),
        ] {
            assert_eq!(press(&mut app, code, mods), why);
            assert!(app.capturing.is_some(), "still waiting after {why}");
        }
        assert_eq!(app.keymap.prefix_table.len(), before.len());
        assert!(app.keymap.prefix_table.iter().zip(&before).all(|(a, b)| a.chord == b.chord && a.command == b.command), "nothing rebound");
        assert_eq!(press(&mut app, KeyCode::Esc, KeyModifiers::NONE), "Unchanged");
    }

    // ── status bar ──

    #[test]
    fn the_status_bar_and_border_style_sections_mark_what_is_in_use() {
        let _colours = crate::term_out::colours_lock();
        let mut app = app();
        let ids = |rows: Vec<Row>| rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
        let picked = |rows: Vec<Row>| rows.iter().find(|r| r.lead.iter().any(|s| s.content.as_ref() == "✓ ")).map(|r| r.id.clone());
        assert_eq!(ids(theme_options(&app, "bar")), ["status_bar:bottom", "status_bar:top", "status_bar:left", "status_bar:right"]);
        assert_eq!(ids(theme_options(&app, "boxes")), ["border_style:box", "border_style:line"]);
        // The tabs over the panes are gone: no section, and an old knob sets nothing.
        assert!(theme_options(&app, "tabs").is_empty());
        assert!(app.set_look("tabs", "off").starts_with("unknown"));
        // The defaults: the status line at the bottom, boxes.
        assert_eq!(picked(theme_options(&app, "bar")).as_deref(), Some("status_bar:bottom"));
        assert_eq!(picked(theme_options(&app, "boxes")).as_deref(), Some("border_style:box"));
        // tmux.conf's status-position top is where the bar is, until the section says otherwise.
        app.status_top = true;
        assert_eq!(picked(theme_options(&app, "bar")).as_deref(), Some("status_bar:top"));
        let _ = app.set_look("status_bar", "left");
        let _ = app.set_look("border_style", "line");
        assert_eq!(picked(theme_options(&app, "bar")).as_deref(), Some("status_bar:left"));
        assert_eq!(picked(theme_options(&app, "boxes")).as_deref(), Some("border_style:line"));
        // Dim other panes, in Focus under border and blurred: off until chosen, a switch its row
        // turns over.
        let focus = ids(theme_options(&app, "focus"));
        assert_eq!(focus, ["focus:line", "focus:surface", "dim:on"]);
        let _ = app.set_look("dim", "on");
        assert!(app.options.dim_others());
        assert_eq!(ids(theme_options(&app, "focus"))[2], "dim:off");
        assert!(theme_sections(&app).iter().any(|r| r.id == "section:focus" && r.right == "border · dim"));
        let rows = theme_sections(&app);
        let right = |id: &str| rows.iter().find(|r| r.id == id).map(|r| r.right.clone()).unwrap_or_default();
        assert_eq!((right("section:bar"), right("section:boxes")), ("left".into(), "off".into()));
        // Back to the bottom: tmux's status line, placed there.
        let _ = app.set_look("status_bar", "bottom");
        assert!(!app.status_top);
        assert_eq!(app.options.get("status-position", "", None).as_deref(), Some("bottom"));
    }
}
