//! The overlays and what their rows are: the fzf list's modes (harnesses, > commands, @ machines,
//! # projects, : models, * store, ? help), needs input, new harness (machine → agent → folder →
//! first message), layouts, and the
//! one-line prompts (rename, first message, send, link password).

use ratatui::style::Style;
use ratatui::text::Span;
use serde_json::Value;

use crate::app::App;
use crate::fleet::{ago, Reach, State};
use crate::layout::Preset;
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
    NewMachine,
    NewWhat { machine: String, cwd: Option<String> },
    NewFolder { machine: String, what: What },
    Route { text: String },
    /// `show-messages`, `list-keys`, `choose-buffer`.
    Messages,
    Keys,
    Buffers,
    /// What `list-windows`, `list-panes`, `show-options`… print, in a view (tmux's view mode).
    Output { title: String, lines: Vec<String> },
}

#[derive(Clone, Debug)]
pub enum PromptKind {
    RenameTab,
    RenameHarness { machine: String, agent: String },
    NewPath { machine: String, what: What },
    NewMessage { machine: String, what: What, cwd: Option<String> },
    Send,
    Broadcast,
    LinkPassword { machine: String },
    /// tmux `command-prompt`: with a template, the typed text fills it (`rename-window %%`);
    /// without one, the typed text is the command.
    Command { template: Option<String> },
    /// command-prompt -k: the next key pressed, by its tmux name, fills the template.
    Key { template: String },
}

/// A line typed in the status line, tmux-style: `(rename-window) name`, `:split-window -h`.
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
    pub vi_pending: Option<char>,
}

impl Prompt {
    pub fn status(kind: PromptKind, label: &str, initial: &str) -> Prompt {
        Prompt { kind, title: String::new(), label: label.to_string(), hint: String::new(), value: initial.to_string(), secret: false, cursor: initial.chars().count(), history_at: None, vi_normal: false, vi_pending: None }
    }
}

/// One row of a tmux display-menu: a label, its shortcut key, the command it runs.
#[derive(Clone, Debug)]
pub struct MenuItem { pub label: String, pub key: String, pub command: String, pub disabled: bool, pub separator: bool }

pub enum Modal {
    /// tmux's display-menu: a box of items, each with its key; Enter or the key runs one.
    Menu { title: String, items: Vec<MenuItem>, cursor: usize },
    Picker { kind: PickerKind, picker: Picker },
    Prompt(Prompt),
    /// tmux `confirm-before`: `kill-pane 0? (y/n)` in the status line.
    Confirm { prompt: String, command: String },
    /// tmux `display-panes` (C-b q): a big number on every pane; press one to go there.
    DisplayPanes { until: std::time::Instant },
    /// tmux `clock-mode` (C-b t).
    Clock { pane: u64 },
    /// tmux `choose-tree -w` (C-b w): windows and their panes, with a preview.
    Tree { cursor: usize, collapsed: Vec<String> },
    /// Search in the focused pane's history (copy mode's / and ?). `found` is None before the first search.
    Find { pane: u64, query: String, found: Option<bool>, up: bool },
    /// display-popup: a shell floating over the window; it goes when its program exits.
    Popup { pane: u64, width: u16, height: u16, title: String },
    /// copy-mode (C-b [): move a cursor over the pane's text and copy from it, vi-style.
    Copy { pane: u64 },
}

pub const ENGINES: [&str; 14] = ["claude", "codex", "opencode", "cursor", "pi", "amp", "hermes", "kilo", "grok", "devin", "copilot", "commandcode", "muse", "terminal"];

/// The palette's commands: (id, title, keys, hint, group).
pub const COMMANDS: &[(&str, &str, &str, &str, &str)] = &[
    ("open", "Harnesses…", "⌥P", "every harness on every machine", "Harness"),
    ("projects", "Projects…", "⌥O", "a project, then one of its harnesses", "Harness"),
    ("models", "Models…", "⌥I", "switch this harness's model and effort", "Harness"),
    ("new", "New Harness…", "⌥N", "", "Harness"),
    ("terminal", "New Terminal", "⌥⇧T", "a shell on this pane's machine", "Harness"),
    ("inbox", "Agents needing input", "⌥⇧I", "", "Harness"),
    ("next-waiting", "Next harness waiting on you", "⌥A", "oldest question first", "Harness"),
    ("send", "Send to harness…", "⌥B", "type a task — Harness picks who", "Harness"),
    ("broadcast", "Broadcast to this tab…", "", "one message to every harness in the tab", "Harness"),
    ("clone", "Clone Harness", "⌥⇧N", "a second one with this one's history", "Harness"),
    ("restart", "Restart Harness", "⌥⇧E", "", "Harness"),
    ("pause", "Pause Harness", "", "stop the engine, keep the conversation", "Harness"),
    ("rename", "Rename Harness…", "", "", "Harness"),
    ("take", "Take over this pane", "", "when another window has the keyboard", "Harness"),
    ("tab", "New Tab", "⌥T", "", "Tabs"),
    ("rename-tab", "Rename Tab…", "⌥⇧R", "", "Tabs"),
    ("close-tab", "Close Tab", "⌥⇧W", "harnesses keep running", "Tabs"),
    ("next-tab", "Next Tab", "⌥}", "", "Tabs"),
    ("prev-tab", "Previous Tab", "⌥{", "", "Tabs"),
    ("tab-left", "Move Tab Left", "⌥<", "", "Tabs"),
    ("tab-right", "Move Tab Right", "⌥>", "", "Tabs"),
    ("split-right", "Split Right", "⌥\\", "", "Panes"),
    ("split-down", "Split Down", "⌥-", "", "Panes"),
    ("close-pane", "Close Pane", "⌥W", "the harness keeps running", "Panes"),
    ("zoom", "Zoom Pane", "⌥Z", "", "Panes"),
    ("layout", "Layout…", "⌥L", "grid, columns, main + stack…", "Panes"),
    ("equalize", "Equalize Panes", "⌥=", "", "Panes"),
    ("pane-tab", "Move Pane to New Tab", "", "", "Panes"),
    ("find", "Find in Pane…", "⌥⇧F", "search this pane's history", "Panes"),
    ("copy-mode", "Copy Mode", "⌥V", "select and copy with the keyboard", "Panes"),
    ("machines", "Machines", "⌥M", "", "Machines"),
    ("store", "Harness Store", "⌥S", "", "Machines"),
    ("help", "Keyboard Shortcuts", "⌥/", "", "Session"),
    ("quit", "Quit", "⌥Q", "harnesses keep running", "Session"),
];


fn span(text: impl Into<String>, style: Style) -> Span<'static> { Span::styled(text.into(), style) }

pub fn agent_rows(app: &App, filter: Filter, machine: Option<&str>, project: Option<&str>) -> Vec<Row> {
    let many = app.fleet.machines.iter().filter(|m| m.usable()).count() > 1;
    let open: Vec<(String, String)> = app.panes.values().map(|p| (p.machine_id.clone(), p.agent_id.clone())).collect();
    app.fleet.ranked().into_iter()
        .filter(|a| machine.map(|m| a.machine_id == m).unwrap_or(true))
        .filter(|a| project.map(|p| a.project_root == p || a.cwd == p).unwrap_or(true))
        .filter(|a| filter.keeps(app.fleet.state_of(a)))
        .map(|a| {
            let state = app.fleet.state_of(a);
            let (dot, _, color) = state_mark(state);
            let (mark, mark_color) = engine_mark(&a.engine);
            let group = match state {
                State::NeedsInput => "Needs input", State::Working => "Working", State::Paused => "Paused", State::Offline => "Offline", _ => "Running",
            };
            let is_open = open.contains(&a.key());
            let detail = if let Some(q) = &a.question { vec![span(format!("? {}", q.prompt), fg(theme::ATTENTION))] }
                else {
                    let where_ = [if a.project != a.name { a.project.clone() } else { String::new() }, a.branch.clone()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
                    vec![span(where_, fg(theme::MUTED))]
                };
            let right = [if many { app.fleet.machine_name(&a.machine_id) } else { String::new() }, if is_open { "open".into() } else { String::new() }, ago(a.recency())]
                .into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("  ");
            let live = !matches!(state, State::Paused | State::Offline);
            Row::new(format!("{}:{}", a.machine_id, a.id), a.name.clone())
                .boost(if state == State::NeedsInput { 60 } else if live { 30 } else { 0 })
                .extra(format!("{} {} {} {} {} {}", a.project, a.branch, app.fleet.machine_name(&a.machine_id), a.engine, engine_label(&a.engine), a.dsh))
                .group(group)
                .lead(vec![span(dot, fg(color)), span(" ", Style::default()), span(mark, fg(mark_color)), span(" ", Style::default())])
                .detail(detail)
                .right(right)
        })
        .collect()
}

/// Only says something when a filter is on — the count beside the prompt already says the rest.
pub fn open_status(_app: &App, filter: Filter) -> String {
    if filter == Filter::All { String::new() } else { format!("{} · tab ↹", filter.label().to_lowercase()) }
}

/// The mode a launcher query is in, by its first character.
pub fn launcher_kind(query: &str, current: &PickerKind) -> PickerKind {
    match query.trim_start().chars().next() {
        Some('>') => PickerKind::Palette,
        Some('@') => PickerKind::Machines,
        Some('#') => PickerKind::Projects,
        Some(':') => PickerKind::Models,
        Some('*') => PickerKind::Store,
        Some('?') => PickerKind::Help,
        _ => match current { PickerKind::Open { .. } => current.clone(), _ => PickerKind::Open { filter: Filter::All, machine: None, project: None } },
    }
}

pub fn is_launcher(kind: &PickerKind) -> bool {
    matches!(kind, PickerKind::Open { .. } | PickerKind::Palette | PickerKind::Machines | PickerKind::Projects | PickerKind::Models | PickerKind::Store | PickerKind::Help)
}

/// (title, placeholder) for a launcher mode.
pub fn launcher_title(app: &App, kind: &PickerKind) -> (String, String) {
    match kind {
        PickerKind::Open { machine: Some(m), project: None, .. } => (format!("harnesses · @{}", app.fleet.machine_name(m)), "Search this machine's harnesses — esc back".into()),
        PickerKind::Open { project: Some(p), .. } => (format!("harnesses · #{}", p.rsplit('/').next().unwrap_or(p)), "Search this project's harnesses — esc back".into()),
        PickerKind::Open { .. } => ("harnesses".into(), "Search harnesses   > commands   @ machines   # projects   : models   * store   ? help".into()),
        PickerKind::Palette => ("commands".into(), "Run anything by name".into()),
        PickerKind::Machines => ("machines".into(), "Choose a machine, then one of its harnesses".into()),
        PickerKind::Projects => ("projects".into(), "Choose a project, then one of its harnesses".into()),
        PickerKind::Models => ("models".into(), "Switch the focused harness's model and effort".into()),
        PickerKind::Store => ("store".into(), "Find a harness in the Store".into()),
        PickerKind::Help => ("quick access".into(), "What this box can do".into()),
        _ => (String::new(), String::new()),
    }
}

/// `#`: every project folder with harnesses in it, grouped per machine.
pub fn project_rows(app: &App) -> Vec<Row> {
    let mut groups: std::collections::BTreeMap<(String, String), (usize, usize, u64)> = std::collections::BTreeMap::new();
    for a in app.fleet.agents.values() {
        if a.project_root.is_empty() { continue }
        let entry = groups.entry((a.machine_id.clone(), a.project_root.clone())).or_insert((0, 0, 0));
        entry.0 += 1;
        if !matches!(app.fleet.state_of(a), State::Paused | State::Offline) { entry.1 += 1 }
        entry.2 = entry.2.max(a.recency());
    }
    let many = app.fleet.machines.iter().filter(|m| m.usable()).count() > 1;
    let mut rows: Vec<(u64, Row)> = groups.into_iter().map(|((machine, root), (all, live, recent))| {
        let name = root.rsplit('/').next().unwrap_or(&root).to_string();
        let home = app.homes.get(&machine).cloned().unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
        let short = if !home.is_empty() && root.starts_with(&home) { format!("~{}", &root[home.len()..]) } else { root.clone() };
        let right = format!("{}{} harness{}{}", if many { format!("{}  ", app.fleet.machine_name(&machine)) } else { String::new() }, all, if all == 1 { "" } else { "es" }, if live > 0 { format!(" · {live} live") } else { String::new() });
        (recent, Row::new(format!("proj:{machine}\t{root}"), name).extra(format!("{short} {}", app.fleet.machine_name(&machine)))
            .lead(vec![span(if live > 0 { "● " } else { "○ " }, fg(if live > 0 { theme::ONLINE } else { theme::MUTED }))])
            .detail(vec![span(short, fg(theme::MUTED))]).right(right).boost(if live > 0 { 30 } else { 0 }))
    }).collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.into_iter().map(|(_, r)| r).collect()
}

/// `:`: the focused harness's models, the one it runs marked.
pub fn model_rows(app: &App) -> Vec<Row> {
    let Some((machine, agent)) = app.focused().and_then(|f| app.panes.get(&f)).map(|p| (p.machine_id.clone(), p.agent_id.clone())) else { return vec![] };
    let current = app.fleet.agent(&machine, &agent).map(|a| a.model.clone()).unwrap_or_default();
    let list = app.models.get(&(machine, agent)).cloned().unwrap_or_default();
    list.iter().filter_map(|m| {
        let id = m.get("id")?.as_str()?.to_string();
        let name = m.get("displayName").and_then(Value::as_str).unwrap_or(&id).to_string();
        let (family, effort) = name.split_once(" / ").map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or((name.clone(), String::new()));
        let on = id == current;
        Some(Row::new(id, name.clone()).group(family).extra(effort)
            .lead(vec![span(if on { "● " } else { "  " }, fg(theme::ONLINE))])
            .right(if on { "current".to_string() } else { String::new() }))
    }).collect()
}

/// The machine a `:` list is about: the focused pane's, else this computer.
pub fn models_machine(app: &App) -> String {
    app.focused().and_then(|f| app.panes.get(&f)).map(|p| p.machine_id.clone()).unwrap_or_else(|| app.fleet.local_id.clone())
}

/// `:`, part two: the machine's local models — start one that is downloaded, get one that is not.
pub fn local_model_rows(app: &App) -> Vec<Row> {
    let machine = models_machine(app);
    let name = app.fleet.machine_name(&machine);
    let Some(list) = app.local_models.get(&machine) else { return vec![] };
    let gb = |b: f64| if b >= 1e9 { format!("{:.1} GB", b / 1e9) } else { format!("{:.0} MB", b / 1e6) };
    let mut rows: Vec<(u8, Row)> = list.iter().filter_map(|m| {
        let id = m.get("id")?.as_str()?;
        let state = m.get("state").and_then(Value::as_str).unwrap_or("available");
        let label = m.get("name").and_then(Value::as_str).unwrap_or(id).to_string();
        let size = m.get("sizeBytes").and_then(Value::as_f64).map(gb).unwrap_or_default();
        let (dot, color, rank) = match state { "running" | "serving" => ("●", theme::ONLINE, 0), "downloaded" => ("○", theme::SOFT, 1), s if s.contains("load") || s.contains("start") => ("◌", theme::WARN, 0), _ => ("·", theme::MUTED, 2) };
        let action = match rank { 0 => "running · ^S stops", 1 => "enter starts", _ => "enter downloads" };
        let recommended = m.get("recommended").and_then(Value::as_bool).unwrap_or(false);
        Some((rank, Row::new(format!("grid:{machine}\t{id}"), label).group(format!("Local models · {name}"))
            .extra(format!("{id} {} {state}", m.get("quant").and_then(Value::as_str).unwrap_or("")))
            .lead(vec![span(format!("{dot} "), fg(color))])
            .detail(vec![span(format!("{state}{}", if recommended { " · recommended" } else { "" }), fg(theme::MUTED))])
            .right(format!("{size}  {action}"))))
    }).collect();
    rows.sort_by_key(|(rank, _)| *rank);
    rows.into_iter().map(|(_, r)| r).collect()
}

/// `?`: what the box does, one prefix per line, then every key.
pub fn mode_rows(app: &App) -> Vec<Row> {
    let hint = |c: &str| app.keymap.hint(c).unwrap_or_default();
    let modes = [(">", "commands", "every tmux command, by name", hint("command-prompt")), ("@", "machines", "a machine, then its harnesses", hint("choose-tree -m")),
        ("#", "projects", "a project folder, then its harnesses", String::new()), (":", "models", "this harness's model; local models", hint("choose-tree -i")),
        ("*", "store", "the Harness Store", hint("choose-tree -S"))];
    let mut rows: Vec<Row> = modes.iter().map(|(p, t, d, k)| Row::new(format!("mode:{p}"), format!("{p} {t}")).detail(vec![span(*d, Style::default().add_modifier(ratatui::style::Modifier::DIM))]).right(k.clone())).collect();
    let prefix = crate::keys::name(&app.keymap.prefix);
    rows.extend(app.keymap.prefix_table.iter().filter(|b| !b.note.is_empty()).map(|b| Row::new(format!("key:{}", b.command), b.note.clone()).extra(b.command.clone())
        .lead(vec![span(format!("{prefix} {:<7}", crate::keys::name(&b.chord)), Style::default().fg(theme::fzf().hl))])));
    rows
}

pub fn inbox_rows(app: &App) -> Vec<Row> {
    let mut agents: Vec<_> = app.fleet.agents.values().filter(|a| a.question.is_some() && a.status != "stopped").collect();
    agents.sort_by_key(|a| a.question.as_ref().map(|q| q.since));
    let mut rows = Vec::new();
    for a in agents {
        let q = a.question.as_ref().unwrap();
        let head = format!("{} · {}", a.name, app.fleet.machine_name(&a.machine_id));
        let (mark, mark_color) = engine_mark(&a.engine);
        rows.push(Row::new(format!("{}:{}#", a.machine_id, a.id), q.prompt.clone()).extra(head.clone()).group(head.clone())
            .lead(vec![span("◆ ", fg(theme::ATTENTION)), span(mark, fg(mark_color)), span(" ", Style::default())])
            .right(format!("{}s", q.since.elapsed().as_secs())));
        for (index, option) in q.options.iter().enumerate() {
            rows.push(Row::new(format!("{}:{}#{index}", a.machine_id, a.id), option.clone()).extra(head.clone()).group(head.clone())
                .lead(vec![span(format!("    {} ", index + 1), fg(theme::ACCENT))]));
        }
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

/// Commands that mean nothing without words after them.
pub const NEEDS_ARGS: &[&str] = &["select-window", "rename-window", "move-window", "select-pane", "resize-pane", "swap-pane", "select-layout", "send-keys", "command-prompt", "confirm-before", "display-message", "send-message", "rename-harness", "send-task", "broadcast"];

pub fn machine_rows(app: &App) -> Vec<Row> {
    app.fleet.machines.iter().map(|m| {
        let running = app.fleet.agents.values().filter(|a| a.machine_id == m.id && a.status == "active").count();
        let waiting = app.fleet.agents.values().filter(|a| a.machine_id == m.id && a.question.is_some()).count();
        let (dot, color, word) = match &m.reach {
            _ if m.local && m.reach == Reach::Ready => ("●", theme::ONLINE, "this computer".to_string()),
            Reach::Ready => ("●", theme::ONLINE, "connected".into()),
            Reach::Connecting => ("◌", theme::WARN, "connecting…".into()),
            Reach::NeedsLink => ("●", theme::ATTENTION, "not linked — M-l links it".into()),
            Reach::Error(e) => ("●", theme::DANGER, e.chars().take(40).collect()),
            _ if m.online() => ("○", theme::SOFT, "online".into()),
            _ => ("○", theme::MUTED, "offline".into()),
        };
        let rtt = app.rtt.get(&m.id).filter(|_| m.usable()).map(|d| format!("{}ms  ", d.as_millis())).unwrap_or_default();
        let counts = if waiting > 0 { format!("{rtt}{running} running · {waiting} waiting") } else { format!("{rtt}{running} running") };
        Row::new(m.id.clone(), m.name.clone()).extra(m.status.clone())
            .lead(vec![span(dot, fg(color)), span(" ", Style::default())])
            .detail(vec![span(word, fg(color))])
            .right(counts)
    }).collect()
}

pub fn layout_rows() -> Vec<Row> {
    Preset::ALL.iter().enumerate().map(|(i, (_, name, detail))| Row::new(i.to_string(), *name).detail(vec![span(*detail, fg(theme::MUTED))])).collect()
}


pub fn new_machine_rows(app: &App, prefer: &str) -> Vec<Row> {
    let mut rows: Vec<Row> = app.fleet.machines.iter().filter(|m| m.usable()).map(|m| {
        let running = app.fleet.agents.values().filter(|a| a.machine_id == m.id && a.status == "active").count();
        Row::new(m.id.clone(), m.name.clone())
            .lead(vec![span(if m.id == prefer { "● " } else { "○ " }, fg(if m.id == prefer { theme::ACCENT } else { theme::ONLINE }))])
            .detail(vec![span(format!("{}{running} running", if m.local { "this computer · " } else { "" }), fg(theme::MUTED))])
    }).collect();
    rows.sort_by_key(|r| r.id != prefer);
    rows
}

pub fn new_what_rows(catalog: &[Value]) -> Vec<Row> {
    let mut rows: Vec<Row> = ENGINES.iter().map(|e| {
        let (mark, color) = engine_mark(e);
        Row::new(format!("engine:{e}"), engine_label(e)).extra(*e).group("Agents")
            .lead(vec![span(mark, fg(color)), span(" ", Style::default())])
            .detail(vec![span(if *e == "terminal" { "a plain shell" } else { "" }, fg(theme::MUTED))])
    }).collect();
    for row in catalog {
        if row.get("installed").and_then(Value::as_bool) == Some(false) || row.get("kind").and_then(Value::as_str) == Some("viewer") { continue }
        let Some(id) = row.get("id").and_then(Value::as_str) else { continue };
        let name = row.get("name").and_then(Value::as_str).unwrap_or(id);
        let description = row.get("description").and_then(Value::as_str).unwrap_or("");
        let engine = row.get("engine").and_then(Value::as_str).unwrap_or("claude");
        rows.push(Row::new(format!("dsh:{id}:{engine}"), name).extra(format!("{id} {description}")).group("From the Store")
            .lead(vec![span("◆ ", fg(theme::TEAL))]).detail(vec![span(description.to_string(), fg(theme::MUTED))]));
    }
    rows
}

pub fn new_folder_rows(app: &App, machine: &str) -> Vec<Row> {
    let home = app.homes.get(machine).cloned().unwrap_or_default();
    let tilde = |p: &str| if !home.is_empty() && p.starts_with(&home) { format!("~{}", &p[home.len()..]) } else { p.to_string() };
    let mut rows = vec![
        Row::new("__new", "+ New project").group("Start").detail(vec![span(format!("{}/harnesses/<name>", tilde(&home)), fg(theme::MUTED))]),
        Row::new("__path", "… Type a path").group("Start").detail(vec![span("any folder on that machine", fg(theme::MUTED))]),
    ];
    let mut agents: Vec<_> = app.fleet.agents.values().filter(|a| a.machine_id == machine && !a.cwd.is_empty()).collect();
    agents.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    let mut seen = Vec::new();
    for a in agents {
        if seen.contains(&a.cwd) || seen.len() >= 40 { continue }
        seen.push(a.cwd.clone());
        let short = tilde(&a.cwd);
        let leaf = short.rsplit('/').next().unwrap_or(&short).to_string();
        rows.push(Row::new(a.cwd.clone(), leaf).extra(short.clone()).group("Recent folders").detail(vec![span(short, fg(theme::MUTED))]));
    }
    if !home.is_empty() { rows.push(Row::new(home.clone(), "~").group("Recent folders").detail(vec![span("home folder", fg(theme::MUTED))])) }
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
            .lead(vec![span(if installed { "● " } else { "○ " }, fg(if installed { theme::ONLINE } else { theme::MUTED }))])
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
