//! The overlays and what their rows are: ⌥O open, ⌥P palette, ⌥I needs input, ⌥N new (machine →
//! agent → folder → first message), ⌥M machines, ⌥L layout, ⌥S store, ⌥B send, ⌥/ keys, and the
//! one-line prompts (rename, first message, send, link password).

use ratatui::style::Style;
use ratatui::text::Span;
use serde_json::Value;

use crate::app::App;
use crate::fleet::{ago, Reach, State};
use crate::layout::Preset;
use crate::picker::{Picker, Row};
use crate::theme::{self, engine_label, engine_mark, fg, state_mark};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Filter { All, NeedsInput, Running, Paused }

impl Filter {
    pub fn next(self) -> Filter { match self { Filter::All => Filter::NeedsInput, Filter::NeedsInput => Filter::Running, Filter::Running => Filter::Paused, Filter::Paused => Filter::All } }
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
    Open { filter: Filter, machine: Option<String> },
    Palette,
    Inbox,
    Machines,
    Layout,
    Help,
    Store,
    NewMachine,
    NewWhat { machine: String },
    NewFolder { machine: String, what: What },
    Route { text: String },
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
}

pub struct Prompt {
    pub kind: PromptKind,
    pub title: String,
    pub label: String,
    pub hint: String,
    pub value: String,
    pub secret: bool,
    pub busy: Option<String>,
}

pub enum Modal {
    Picker { kind: PickerKind, picker: Picker },
    Prompt(Prompt),
}

pub const ENGINES: [&str; 14] = ["claude", "codex", "opencode", "cursor", "pi", "amp", "hermes", "kilo", "grok", "devin", "copilot", "commandcode", "muse", "terminal"];

/// The palette's commands: (id, title, keys, hint, group).
pub const COMMANDS: &[(&str, &str, &str, &str, &str)] = &[
    ("open", "Open Harness…", "⌥O", "every harness on every machine", "Harness"),
    ("new", "New Harness…", "⌥N", "", "Harness"),
    ("terminal", "New Terminal", "⌥⇧T", "a shell on this pane's machine", "Harness"),
    ("inbox", "Agents needing input", "⌥I", "", "Harness"),
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
    ("split-right", "Split Right", "⌥\\", "", "Panes"),
    ("split-down", "Split Down", "⌥-", "", "Panes"),
    ("close-pane", "Close Pane", "⌥W", "the harness keeps running", "Panes"),
    ("zoom", "Zoom Pane", "⌥Z", "", "Panes"),
    ("layout", "Layout…", "⌥L", "grid, columns, main + stack…", "Panes"),
    ("equalize", "Equalize Panes", "⌥=", "", "Panes"),
    ("pane-tab", "Move Pane to New Tab", "", "", "Panes"),
    ("machines", "Machines", "⌥M", "", "Machines"),
    ("store", "Harness Store", "⌥S", "", "Machines"),
    ("help", "Keyboard Shortcuts", "⌥/", "", "Session"),
    ("quit", "Quit", "⌥Q", "harnesses keep running", "Session"),
];

pub const SHORTCUTS: &[(&str, &str, &str)] = &[
    ("Harness", "⌥O", "Open Harness — every harness on every machine"),
    ("Harness", "⌥P", "Command palette"),
    ("Harness", "⌥N", "New Harness"),
    ("Harness", "⌥⇧T", "New Terminal"),
    ("Harness", "⌥I", "Agents needing input — ⌥1…9 answers"),
    ("Harness", "⌥B", "Send a task — Harness routes it"),
    ("Harness", "⌥M", "Machines"),
    ("Harness", "⌥S", "Harness Store"),
    ("Tabs", "⌥T", "New tab"),
    ("Tabs", "⌥1…9", "Go to tab"),
    ("Tabs", "⌥{  ⌥}", "Previous / next tab"),
    ("Tabs", "⌥⇧R", "Rename tab"),
    ("Tabs", "⌥⇧W", "Close tab (harnesses keep running)"),
    ("Panes", "⌥\\  ⌥-", "Split right / down"),
    ("Panes", "⌥h ⌥j ⌥k ⌥l", "Focus left / down / up / right (⌘ arrows too)"),
    ("Panes", "⌥H ⌥J ⌥K ⌥L", "Grow left / down / up / right"),
    ("Panes", "⌥Z", "Zoom pane (⌘↵ too)"),
    ("Panes", "⌥W", "Close pane"),
    ("Panes", "⌥=", "Equalize panes"),
    ("Panes", "wheel  ⇧PgUp", "Scroll the pane's history"),
    ("Session", "^␣", "Prefix — then any key above without ⌥ (^␣ o, ^␣ n, …)"),
    ("Session", "⌘", "In kitty / Ghostty / WezTerm, ⌘ works where ⌥ is shown"),
    ("Session", "⌥Q", "Quit — everything keeps running; your tabs come back"),
];

fn span(text: impl Into<String>, style: Style) -> Span<'static> { Span::styled(text.into(), style) }

pub fn agent_rows(app: &App, filter: Filter, machine: Option<&str>) -> Vec<Row> {
    let many = app.fleet.machines.iter().filter(|m| m.usable()).count() > 1;
    let open: Vec<(String, String)> = app.panes.values().map(|p| (p.machine_id.clone(), p.agent_id.clone())).collect();
    app.fleet.ranked().into_iter()
        .filter(|a| machine.map(|m| a.machine_id == m).unwrap_or(true))
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
            Row::new(format!("{}:{}", a.machine_id, a.id), a.name.clone())
                .extra(format!("{} {} {} {} {} {}", a.project, a.branch, app.fleet.machine_name(&a.machine_id), a.engine, engine_label(&a.engine), a.dsh))
                .group(group)
                .lead(vec![span(dot, fg(color)), span(" ", Style::default()), span(mark, fg(mark_color)), span(" ", Style::default())])
                .detail(detail)
                .right(right)
        })
        .collect()
}

pub fn open_status(app: &App, filter: Filter, machine: Option<&str>) -> String {
    [Filter::All, Filter::NeedsInput, Filter::Running, Filter::Paused].iter().map(|f| {
        let n = app.fleet.agents.values().filter(|a| machine.map(|m| a.machine_id == m).unwrap_or(true)).filter(|a| f.keeps(app.fleet.state_of(a))).count();
        if *f == filter { format!("[{} {n}]", f.label()) } else { format!("{} {n}", f.label()) }
    }).collect::<Vec<_>>().join("  ")
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

pub fn palette_rows(app: &App) -> Vec<Row> {
    let pane_name = app.focused().and_then(|id| app.panes.get(&id)).and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| a.name.clone());
    COMMANDS.iter().map(|(id, title, keys, hint, group)| {
        let title = match (*id, &pane_name) {
            ("clone" | "restart" | "pause" | "rename", Some(name)) => format!("{title} · {name}"),
            _ => title.to_string(),
        };
        Row::new(*id, title).extra(format!("{hint} {group}")).group(*group).detail(vec![span(*hint, fg(theme::MUTED))]).right(*keys)
    }).collect()
}

pub fn machine_rows(app: &App) -> Vec<Row> {
    app.fleet.machines.iter().map(|m| {
        let running = app.fleet.agents.values().filter(|a| a.machine_id == m.id && a.status == "active").count();
        let waiting = app.fleet.agents.values().filter(|a| a.machine_id == m.id && a.question.is_some()).count();
        let (dot, color, word) = match &m.reach {
            _ if m.local && m.reach == Reach::Ready => ("●", theme::ONLINE, "this computer".to_string()),
            Reach::Ready => ("●", theme::ONLINE, "connected".into()),
            Reach::Connecting => ("◌", theme::WARN, "connecting…".into()),
            Reach::NeedsLink => ("●", theme::ATTENTION, "not linked — ^L to link".into()),
            Reach::Error(e) => ("●", theme::DANGER, e.chars().take(40).collect()),
            _ if m.online() => ("○", theme::SOFT, "online".into()),
            _ => ("○", theme::MUTED, "offline".into()),
        };
        let counts = if waiting > 0 { format!("{running} running · {waiting} waiting") } else { format!("{running} running") };
        Row::new(m.id.clone(), m.name.clone()).extra(m.status.clone())
            .lead(vec![span(dot, fg(color)), span(" ", Style::default())])
            .detail(vec![span(word, fg(color))])
            .right(counts)
    }).collect()
}

pub fn layout_rows() -> Vec<Row> {
    Preset::ALL.iter().enumerate().map(|(i, (_, name, detail))| Row::new(i.to_string(), *name).detail(vec![span(*detail, fg(theme::MUTED))])).collect()
}

pub fn help_rows() -> Vec<Row> {
    SHORTCUTS.iter().enumerate().map(|(i, (group, keys, what))| Row::new(i.to_string(), what.to_string()).extra(*keys).group(*group).lead(vec![span(format!("{keys:<16}"), fg(theme::ACCENT))])).collect()
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
