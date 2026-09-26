//! What fzf's preview window shows for a row that has no live terminal to show: a harness's
//! state, place and open question, its recent asks; a machine's harnesses; a command's keys.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;

use crate::app::App;
use crate::fleet::{ago, State};
use crate::modal::PickerKind;
use crate::theme;

fn dim(text: impl Into<String>) -> Span<'static> { Span::styled(text.into(), Style::default().add_modifier(Modifier::DIM)) }
fn bold(text: impl Into<String>) -> Span<'static> { Span::styled(text.into(), Style::default().add_modifier(Modifier::BOLD)) }
fn kv(k: &str, v: impl Into<String>) -> Line<'static> { Line::from(vec![dim(format!("{k:<9}")), Span::raw(v.into())]) }

pub fn lines(app: &App, kind: &PickerKind, id: &str) -> Vec<Line<'static>> {
    match kind {
        PickerKind::Open { .. } | PickerKind::Inbox | PickerKind::Route { .. } => {
            let key = id.split('#').next().unwrap_or(id);
            match key.split_once(':') { Some((m, a)) => harness(app, m, a), None => vec![] }
        }
        PickerKind::Machines => machine(app, id),
        PickerKind::Projects => project(app, id),
        PickerKind::Palette => command(app, id),
        PickerKind::Keys => id.split_once('\t').map(|(k, c)| vec![Line::from(vec![bold(format!("{} {k}", crate::keys::name(&app.keymap.prefix)))]), Line::raw(""), Line::raw(c.to_string())]).unwrap_or_default(),
        PickerKind::Buffers => id.parse::<usize>().ok().and_then(|i| app.buffers.get(i)).map(|b| b.lines().map(|l| Line::raw(l.to_string())).collect()).unwrap_or_default(),
        PickerKind::Store => store(app, id),
        PickerKind::Models => vec![Line::raw(id.rsplit(':').next().unwrap_or(id).to_string())],
        _ => vec![],
    }
}

fn harness(app: &App, machine_id: &str, agent_id: &str) -> Vec<Line<'static>> {
    let Some(a) = app.fleet.agent(machine_id, agent_id) else { return vec![dim("(gone)").into()] };
    let state = app.fleet.state_of(a);
    let (word, color) = match state {
        State::NeedsInput => ("waiting on you", Color::Yellow), State::Working => ("working", Color::Cyan), State::Done => ("finished a turn", Color::Green),
        State::Ready => ("ready", Color::Green), State::Starting => ("starting", Color::Yellow), State::Failed => ("failed to start", Color::Red),
        State::Paused => ("paused — enter resumes it", Color::DarkGray), State::Offline => ("offline", Color::DarkGray),
    };
    let home = app.homes.get(machine_id).cloned().unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
    let cwd = if !home.is_empty() && a.cwd.starts_with(&home) { format!("~{}", &a.cwd[home.len()..]) } else { a.cwd.clone() };
    let mut out = vec![
        Line::from(vec![Span::styled(word.to_string(), Style::default().fg(color).add_modifier(Modifier::BOLD)), dim(format!("  {}", ago(a.recency())))]),
        Line::raw(""),
        kv("agent", theme::engine_label(&a.engine).to_string()),
        kv("machine", app.fleet.machine_name(machine_id)),
    ];
    if !cwd.is_empty() { out.push(kv("folder", cwd)) }
    if !a.branch.is_empty() { out.push(kv("branch", a.branch.clone())) }
    let model = a.model.rsplit(':').next().unwrap_or("").to_string();
    if !model.is_empty() { out.push(kv("model", model)) }
    if !a.dsh.is_empty() { out.push(kv("harness", a.dsh.clone())) }
    if let Some(q) = &a.question {
        out.push(Line::raw(""));
        out.push(Line::from(vec![Span::styled("? ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)), bold(q.prompt.clone())]));
        for (i, o) in q.options.iter().enumerate() { out.push(Line::from(vec![Span::styled(format!("  M-{} ", i + 1), Style::default().fg(theme::FZF_HL)), Span::raw(o.clone())])) }
    }
    if let Some(recent) = app.recent.get(&(machine_id.to_string(), agent_id.to_string())) {
        let asks: Vec<String> = recent.get("asks").and_then(Value::as_array).map(|x| x.iter().filter_map(|v| v.as_str().map(str::to_string).or_else(|| v.get("text").and_then(Value::as_str).map(str::to_string))).collect()).unwrap_or_default();
        let recaps: Vec<String> = recent.get("events").and_then(Value::as_array).map(|x| x.iter().filter_map(|e| e.pointer("/payload/recap").or_else(|| e.get("recap")).or_else(|| e.pointer("/payload/text")).and_then(Value::as_str).map(str::to_string)).collect()).unwrap_or_default();
        if !asks.is_empty() || !recaps.is_empty() { out.push(Line::raw("")) }
        for ask in asks.iter().take(3) { out.push(Line::from(vec![Span::styled("❯ ", Style::default().fg(theme::FZF_PROMPT)), Span::raw(ask.lines().next().unwrap_or("").to_string())])) }
        for recap in recaps.iter().take(2) { for (i, l) in recap.lines().take(6).enumerate() { out.push(Line::from(vec![dim(if i == 0 { "⏺ " } else { "  " }), Span::raw(l.to_string())])) } }
    }
    out.push(Line::raw(""));
    out.push(dim(if app.find_pane(machine_id, agent_id).is_some() { "on screen — enter goes to it" } else { "enter opens it here · C-t window · C-v beside · C-x below" }).into());
    out
}

fn machine(app: &App, id: &str) -> Vec<Line<'static>> {
    let Some(m) = app.fleet.machine(id) else { return vec![] };
    let mut out = vec![Line::from(vec![bold(m.name.clone()), dim(if m.local { "  this computer" } else { "" })]), Line::raw("")];
    if let Some(rtt) = app.rtt.get(id) { out.push(kv("rtt", format!("{}ms", rtt.as_millis()))) }
    let mut agents: Vec<_> = app.fleet.agents.values().filter(|a| a.machine_id == id && a.status != "stopped").collect();
    agents.sort_by_key(|a| std::cmp::Reverse(a.recency()));
    out.push(kv("running", agents.len().to_string()));
    out.push(Line::raw(""));
    for a in agents.iter().take(30) { out.push(Line::from(vec![Span::raw(format!("  {}", a.name)), dim(format!("  {}", a.project))])) }
    out
}

fn project(app: &App, id: &str) -> Vec<Line<'static>> {
    let Some((m, root)) = id.trim_start_matches("proj:").split_once('\t') else { return vec![] };
    let mut out = vec![bold(root.to_string()).into(), dim(app.fleet.machine_name(m)).into(), Line::raw("")];
    for a in app.fleet.agents.values().filter(|a| a.machine_id == m && (a.project_root == root || a.cwd == root)) {
        out.push(Line::from(vec![Span::raw(format!("  {}", a.name)), dim(format!("  {}  {}", a.branch, a.status))]));
    }
    out
}

fn command(app: &App, id: &str) -> Vec<Line<'static>> {
    let key = app.keymap.key_for_name(id);
    let about = crate::commands::COMMANDS.iter().find(|(n, _, _)| *n == id).map(|(_, _, d)| d.to_string())
        .or_else(|| crate::modal::COMMANDS.iter().find(|c| c.0 == id).map(|c| c.3.to_string())).unwrap_or_default();
    let mut out = vec![bold(id.to_string()).into(), Line::raw("")];
    if !about.is_empty() { out.push(Line::raw(about)) }
    if let Some(k) = key { out.push(Line::raw("")); out.push(kv("key", k)) }
    out
}

fn store(app: &App, id: &str) -> Vec<Line<'static>> {
    let catalog = app.dsh.get(&app.fleet.local_id).cloned().unwrap_or_default();
    let Some(row) = catalog.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(id)) else { return vec![] };
    let mut out = vec![bold(row.get("name").and_then(Value::as_str).unwrap_or(id).to_string()).into(), dim(id.to_string()).into(), Line::raw("")];
    if let Some(d) = row.get("description").and_then(Value::as_str) { for l in textwrap(d, 60) { out.push(Line::raw(l)) } }
    out.push(Line::raw(""));
    out.push(dim(if row.get("installed").and_then(Value::as_bool) == Some(false) { "M-i installs it" } else { "enter starts one" }).into());
    out
}

fn textwrap(text: &str, width: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if line.len() + word.len() + 1 > width && !line.is_empty() { out.push(std::mem::take(&mut line)) }
        if !line.is_empty() { line.push(' ') }
        line.push_str(word);
    }
    if !line.is_empty() { out.push(line) }
    out
}
