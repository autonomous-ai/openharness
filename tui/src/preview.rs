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
        PickerKind::Open { .. } if id.starts_with("session:") => session(app, id),
        PickerKind::Open { .. } if id.starts_with("external:") => external(app, id),
        PickerKind::Open { .. } | PickerKind::Inbox | PickerKind::Route { .. } => {
            let key = id.split('#').next().unwrap_or(id);
            match key.split_once(':') { Some((m, a)) => harness(app, m, a), None => vec![] }
        }
        PickerKind::Machines => machine(app, id),
        PickerKind::Projects => project(app, id),
        PickerKind::Palette => command(app, id),
        PickerKind::Keys => id.split_once('\t').map(|(k, c)| vec![Line::from(vec![bold(format!("{} {k}", crate::keys::name(&app.keymap.prefix)))]), Line::raw(""), Line::raw(c.to_string())]).unwrap_or_default(),
        PickerKind::Buffers => app.paste.get(id).map(|b| b.data.lines().map(|l| ansi_line(l, crate::theme::fzf_opts().tabstop)).collect()).unwrap_or_default(),
        PickerKind::Store => store(app, id),
        // ── models: a Models view row's facts and what Enter does (models.rs) ──
        PickerKind::Models if crate::models::is_row(id) => crate::models::preview(app, id),
        PickerKind::Models => vec![Line::raw(id.rsplit(':').next().unwrap_or(id).to_string()), Line::raw(""), Line::raw("Enter switches this harness to it.")],
        // ── machines & devices ──
        PickerKind::Devices(view) => crate::devices::preview(app, *view, id),
        _ => vec![],
    }
}

fn harness(app: &App, machine_id: &str, agent_id: &str) -> Vec<Line<'static>> {
    let Some(a) = app.fleet.agent(machine_id, agent_id) else { return vec![dim("(gone)").into()] };
    let state = app.fleet.state_of(a);
    let (word, color) = match state {
        State::NeedsInput => ("waiting on you", Color::Yellow), State::Working => ("working", Color::Cyan), State::Done => ("finished a turn", Color::Green),
        State::Unknown => ("status unavailable", Color::DarkGray), State::Ready => ("idle", Color::Green), State::Starting => ("starting", Color::Yellow), State::Failed => (if a.launch == "failed" { "failed to start" } else { "failed" }, Color::Red),
        State::Paused => ("paused — enter resumes it", Color::DarkGray), State::Offline => ("offline", Color::DarkGray),
    };
    let home = app.homes.get(machine_id).cloned().unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
    let cwd = if !home.is_empty() && a.cwd.starts_with(&home) { format!("~{}", &a.cwd[home.len()..]) } else { a.cwd.clone() };
    let mut out = vec![
        Line::from(vec![Span::styled(word.to_string(), Style::default().fg(color).add_modifier(Modifier::BOLD)), dim(format!("  {}", ago(a.state_since(state))))]),
    ];
    if !a.viewer_url.is_empty() || !a.viewer_name.is_empty() || !a.viewer_error.is_empty() {
        let label = if a.viewer_name.is_empty() { "Viewer" } else { &a.viewer_name };
        let state = if !a.viewer_error.is_empty() { a.viewer_error.as_str() } else if a.viewer_url.is_empty() { "starting" } else { "ready" };
        out.push(dim(format!("{label}: {state} · :view opens · :view -c copies link")).into());
    }
    // Its latest turns, when its session's index has them: as its terminal shows them, the newest
    // at the bottom (where the preview starts), what it asks you below them.
    if let Some(tail) = app.tails.get(&a.session_id) {
        // Its facts on one line: where, which model, its PR, what it has used.
        let model = a.model.rsplit(':').next().unwrap_or("").to_string();
        let pr = a.pr.as_ref().map(|p| format!("#{} {}", p.number, p.state)).unwrap_or_default();
        let tokens = if a.tokens > 0 { format!("{} tokens", crate::fleet::compact(a.tokens)) } else { String::new() };
        let facts = [app.fleet.machine_name(machine_id), cwd.clone(), a.branch.clone(), model, pr, tokens].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
        out.push(dim(facts).into());
        // Why it failed, first.
        if state == State::Failed {
            let why = if !a.launch_error.is_empty() { a.launch_error.clone() } else { a.did.clone().unwrap_or_default() };
            if !why.is_empty() { out.push(Line::raw("")); out.push(Line::from(vec![Span::styled("✗ ", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)), Span::raw(why)])) }
        }
        out.push(Line::raw(""));
        out.extend(turns(app, &a.session_id, tail));
        // While it works: its plan, under the turn it is on.
        if state == State::Working { out.extend(plan(a, true)) }
        if let Some(q) = &a.question {
            out.push(Line::raw(""));
            out.push(Line::from(vec![Span::styled("? ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)), bold(q.prompt.clone())]));
            for (i, o) in q.options.iter().enumerate() { out.push(Line::from(vec![Span::styled(format!("  M-{} ", i + 1), Style::default().fg(theme::fzf().hl)), Span::raw(o.clone())])) }
            out.push(dim(if q.multi { "  M-a several (1,3) or your own words" } else { "  M-a your own words" }).into());
        }
        out.push(Line::raw(""));
        let place = app.find_pane_anywhere(machine_id, agent_id).map(|(sid, n, _)| if sid == app.session_id { format!("in window {n} — enter goes to it") } else {
            let name = app.session_list().into_iter().find(|(i, _)| *i == sid).map(|(_, n)| n).unwrap_or_default();
            format!("in {name}:{n} — enter goes to it")
        });
        out.push(dim(place.unwrap_or_else(|| "enter adds a pane here · C-t new window · C-v beside · C-x below · M-enter here".into())).into());
        return out;
    }
    // What it asks, or why it failed, first: at 80×24 the preview is a few rows.
    if let Some(q) = &a.question {
        out.push(Line::raw(""));
        out.push(Line::from(vec![Span::styled("? ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)), bold(q.prompt.clone())]));
        for (i, o) in q.options.iter().enumerate() { out.push(Line::from(vec![Span::styled(format!("  M-{} ", i + 1), Style::default().fg(theme::fzf().hl)), Span::raw(o.clone())])) }
        out.push(dim(if q.multi { "  M-a several (1,3) or your own words" } else { "  M-a your own words" }).into());
    }
    if state == State::Failed && !a.launch_error.is_empty() { out.push(Line::raw("")); out.push(Line::from(vec![Span::styled("✗ ", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)), Span::raw(a.launch_error.clone())])) }
    // What its last turn came to — the recap, then its final message whole (to read it here) —
    // leads once it has stopped: after what you asked it, before the facts.
    let working = matches!(state, State::Working | State::NeedsInput);
    let mut said = Vec::new();
    if !working {
        if let Some(asked) = &a.asked { said.push(Line::from(vec![Span::styled("❯ ", Style::default().fg(theme::fzf().prompt)), Span::raw(asked.clone())])) }
        // (Not the recap when it is the final message's first line, shown next.)
        let first = crate::fleet::first_line(&a.last_text).unwrap_or_default();
        if let Some(did) = a.did.as_ref().filter(|d| crate::fleet::first_line(d).unwrap_or_default() != first) { said.push(Line::from(vec![dim("⏺ "), Span::raw(did.clone())])) }
        if !a.last_text.is_empty() {
            if !said.is_empty() { said.push(Line::raw("")) }
            said.extend(message(&a.last_text));
        }
        if !said.is_empty() { out.push(Line::raw("")); out.append(&mut said) }
    }
    out.push(Line::raw(""));
    out.push(kv("agent", theme::engine_label(&a.engine).to_string()));
    out.push(kv("machine", app.fleet.machine_name(machine_id)));
    if !cwd.is_empty() { out.push(kv("folder", cwd)) }
    if !a.branch.is_empty() { out.push(kv("branch", a.branch.clone())) }
    let model = a.model.rsplit(':').next().unwrap_or("").to_string();
    if !model.is_empty() { out.push(kv("model", model)) }
    if !a.dsh.is_empty() { out.push(kv("harness", a.dsh.clone())) }
    if let Some(pr) = &a.pr { out.push(Line::from(vec![dim(format!("{:<9}", "pr")), Span::raw(format!("#{} {}", pr.number, pr.state)), dim(format!("  {}", pr.url))])) }
    if a.tokens > 0 || a.added + a.removed > 0 {
        let mut used = Vec::new();
        if a.tokens > 0 { used.push(format!("{} tokens", crate::fleet::compact(a.tokens))) }
        if a.added + a.removed > 0 { used.push(format!("+{} −{}", a.added, a.removed)) }
        if a.prs_made > 0 { used.push(format!("{} PR{}", a.prs_made, if a.prs_made == 1 { "" } else { "s" })) }
        out.push(kv("used", used.join(" · ")));
    }
    if let Some(asked) = a.asked.as_ref().filter(|_| working) { out.push(Line::raw("")); out.push(Line::from(vec![Span::styled("❯ ", Style::default().fg(theme::fzf().prompt)), Span::raw(asked.clone())])) }
    // Its plan (TodoWrite): done ✓, doing ▸, to do ·; and the sub-agents it has running.
    out.extend(plan(a, working));
    if !a.subagents.is_empty() {
        out.push(Line::raw(""));
        out.push(Line::from(vec![dim(format!("{:<9}", "agents")), Span::raw(format!("{} running", a.subagents.len()))]));
        for (_, what) in a.subagents.iter().take(8) { out.push(Line::from(vec![Span::raw(format!("  ⠿ {what}"))])) }
    }
    // Waiting on you: the message it stopped at, below its plan.
    if state == State::NeedsInput && !a.last_text.is_empty() {
        out.push(Line::raw(""));
        out.extend(message(&a.last_text));
    }
    if let Some(recent) = app.recent.get(&(machine_id.to_string(), agent_id.to_string())) {
        let asks: Vec<String> = recent.get("asks").and_then(Value::as_array).map(|x| x.iter().filter_map(|v| v.as_str().map(str::to_string).or_else(|| v.get("text").and_then(Value::as_str).map(str::to_string))).collect()).unwrap_or_default();
        let recaps: Vec<String> = recent.get("events").and_then(Value::as_array).map(|x| x.iter().filter_map(|e| e.pointer("/payload/recap").or_else(|| e.get("recap")).or_else(|| e.pointer("/payload/text")).and_then(Value::as_str).map(str::to_string)).collect()).unwrap_or_default();
        if !asks.is_empty() || !recaps.is_empty() { out.push(Line::raw("")) }
        for ask in asks.iter().take(3) { out.push(Line::from(vec![Span::styled("❯ ", Style::default().fg(theme::fzf().prompt)), Span::raw(ask.lines().next().unwrap_or("").to_string())])) }
        for recap in recaps.iter().take(2) { for (i, l) in recap.lines().take(6).enumerate() { out.push(Line::from(vec![dim(if i == 0 { "⏺ " } else { "  " }), Span::raw(l.to_string())])) } }
    }
    out.push(Line::raw(""));
    // Where it is open, if it is: the window (another session's by name), Enter going there.
    let place = app.find_pane_anywhere(machine_id, agent_id).map(|(sid, n, _)| if sid == app.session_id { format!("in window {n} — enter goes to it") } else {
        let name = app.session_list().into_iter().find(|(i, _)| *i == sid).map(|(_, n)| n).unwrap_or_default();
        format!("in {name}:{n} — enter goes to it")
    });
    out.push(dim(place.unwrap_or_else(|| "enter adds a pane here · C-t new window · C-v beside · C-x below · M-enter here".into())).into());
    out
}

/// Whether a row's preview reads bottom up — a session's latest turns, the newest at the bottom —
/// so it starts at its end.
pub fn bottom_up(app: &App, kind: &PickerKind, id: &str) -> bool {
    if !matches!(kind, PickerKind::Open { .. }) { return false }
    app.row_session(id).map(|(_, s)| app.tails.contains_key(&s)).unwrap_or(false)
}

/// A session's latest turns (session_tail), oldest first: each ask after `❯`, the answer, the
/// tools it ran dim — the words C-b s searched for bold. An older turn the search matched says
/// where it was first.
/// Its plan (TodoWrite): done ✓, doing ▸ (while it works), to do ·.
fn plan(a: &crate::fleet::Agent, working: bool) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    if a.todos.is_empty() { return out }
    let done = a.todos.iter().filter(|(_, s)| s == "completed").count();
    out.push(Line::raw(""));
    out.push(Line::from(vec![dim(format!("{:<9}", "plan")), Span::raw(format!("{done}/{} done", a.todos.len()))]));
    for (words, status) in a.todos.iter().take(12) {
        // ▸ only while it works: a turn that ended left the item as it was.
        let (mark, style) = match status.as_str() { "completed" => ("✓ ", Style::default().add_modifier(Modifier::DIM)), "in_progress" if working => ("▸ ", Style::default().add_modifier(Modifier::BOLD)), _ => ("· ", Style::default()) };
        out.push(Line::from(vec![Span::styled(format!("  {mark}"), style), Span::styled(words.clone(), style)]));
    }
    out
}

fn turns(app: &App, session: &str, tail: &Value) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    let rows: Vec<Value> = tail.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
    let words: Vec<String> = crate::fzf::Query::parse(&app.said_for, crate::fzf::Case::Ignore, true, true).positive_terms().into_iter().filter(|w| w.chars().count() >= 2).collect();
    let first = rows.first().and_then(|r| r.get("turn")).and_then(Value::as_i64).unwrap_or(0);
    if let Some(hit) = app.said.iter().find(|h| h.session_id == session && h.turn >= 0 && h.turn < first) {
        out.push(Line::from(vec![Span::styled("Matched earlier", Style::default().fg(theme::fzf().hl).add_modifier(Modifier::BOLD)), dim(format!(" · {}", ago(hit.at)))]));
        out.push(Line::from(marked(&hit.snippet)));
        out.push(Line::raw(""));
    }
    let total = tail.get("total").and_then(Value::as_u64).unwrap_or(rows.len() as u64);
    if tail.get("hasMore").and_then(Value::as_bool).unwrap_or(false) && total > rows.len() as u64 { out.push(dim(format!("… {} earlier turns", total - rows.len() as u64)).into()); out.push(Line::raw("")) }
    for (i, r) in rows.iter().enumerate() {
        let text = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let (ask, answer, tools) = (text("ask"), text("answer"), text("tools"));
        if i > 0 && !ask.is_empty() { out.push(Line::raw("")) }
        for (j, l) in ask.lines().take(8).enumerate() {
            let mut spans = vec![if j == 0 { Span::styled("❯ ", Style::default().fg(theme::fzf().prompt)) } else { Span::raw("  ") }];
            spans.extend(lit(l, &words, Style::default().add_modifier(Modifier::BOLD)));
            out.push(Line::from(spans));
        }
        for t in tools.lines().filter(|t| !t.trim().is_empty()).take(6) { out.push(Line::from(vec![dim("  ⎿ "), dim(t.to_string())])) }
        // (Its answer as the agent's terminal writes it: ⏺ before the first line.)
        // (A long answer: its start and its end — where the question usually is — with how much
        // is left out between.)
        let lines: Vec<&str> = answer.lines().collect();
        let keep: Vec<(usize, &str)> = if lines.len() <= 80 { lines.iter().copied().enumerate().collect() } else { lines.iter().copied().enumerate().filter(|(j, _)| *j < 10 || *j >= lines.len() - 60).collect() };
        for (j, l) in keep {
            if lines.len() > 80 && j == lines.len() - 60 { out.push(dim(format!("  … {} lines …", lines.len() - 70)).into()) }
            let mut spans = vec![if j == 0 { dim("⏺ ") } else { Span::raw("  ") }]; spans.extend(lit(l, &words, Style::default())); out.push(Line::from(spans))
        }
    }
    if rows.is_empty() { out.push(dim("(nothing said yet)").into()) }
    out
}

/// [text] with the words searched for in bold (whole or in part, any case).
fn lit(text: &str, words: &[String], base: Style) -> Vec<Span<'static>> {
    if words.is_empty() { return vec![Span::styled(text.to_string(), base)] }
    let lower = text.to_lowercase();
    // (Byte ranges of the lower-cased text line up with the text's only for ASCII; otherwise plain.)
    if lower.len() != text.len() { return vec![Span::styled(text.to_string(), base)] }
    let mut marks = vec![false; text.len()];
    for w in words { let mut from = 0; while let Some(at) = lower[from..].find(w.as_str()) { let s = from + at; for m in &mut marks[s..s + w.len()] { *m = true } from = s + w.len(); } }
    let mut out = Vec::new();
    let mut start = 0;
    for i in 1..=text.len() {
        if i == text.len() || marks[i] != marks[start] {
            if text.is_char_boundary(start) && text.is_char_boundary(i) {
                // (The words found in fzf's match colour, as a list lights them.)
                let style = if marks[start] { base.fg(theme::fzf().hl).add_modifier(Modifier::BOLD) } else { base };
                out.push(Span::styled(text[start..i].to_string(), style));
                start = i;
            }
        }
    }
    out
}

/// A search snippet: its matched words (between \u{2} and \u{3}) bold, on one line.
fn marked(snippet: &str) -> Vec<Span<'static>> {
    let mut out = vec![Span::raw("  ")];
    let flat = snippet.replace('\n', " ");
    for (i, part) in flat.split(['\u{2}', '\u{3}']).enumerate() {
        if part.is_empty() { continue }
        out.push(if i % 2 == 1 { bold(part.to_string()) } else { Span::raw(part.to_string()) });
    }
    out
}

/// A conversation Harness did not start: what it is, where it ran, its latest turns (the newest
/// at the bottom), and what Enter does with it.
fn external(app: &App, id: &str) -> Vec<Line<'static>> {
    let Some((m, s)) = id.strip_prefix("external:").and_then(|r| r.split_once(':')) else { return vec![] };
    let Some(x) = app.said.iter().filter_map(|h| h.external.as_ref()).find(|x| x.machine == m && x.session_id == s) else { return vec![dim("(gone)").into()] };
    let home = app.homes.get(m).cloned().unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
    let cwd = if !home.is_empty() && x.cwd.starts_with(&home) { format!("~{}", &x.cwd[home.len()..]) } else { x.cwd.clone() };
    let mut out = vec![
        Line::from(vec![Span::styled("not in Harness", Style::default().fg(Color::DarkGray).add_modifier(Modifier::BOLD)), dim(format!("  {}", ago(x.last_at)))]),
        dim([theme::engine_label(&x.engine).to_string(), app.fleet.machine_name(m), cwd].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ")).into(),
        Line::raw(""),
    ];
    match app.tails.get(s) {
        Some(tail) => out.extend(turns(app, s, tail)),
        None => out.push(dim("…").into()),
    }
    out.push(Line::raw(""));
    out.push(if x.open { Line::styled("Open in another terminal or app — close it there to open it here", Style::default().fg(Color::Yellow)) }
        else { dim("enter resumes it as a pane here · C-t new window · C-v beside · C-x below · M-enter here — without permission prompts, as the desktop resumes it").into() });
    out
}

/// A session: its windows, as tmux's tree lists them.
fn session(app: &App, id: &str) -> Vec<Line<'static>> {
    let Some(sid) = id.strip_prefix("session:").and_then(|n| n.parse::<u32>().ok()) else { return vec![] };
    let name = app.session_list().into_iter().find(|(i, _)| *i == sid).map(|(_, n)| n).unwrap_or_default();
    let mut out = vec![Line::from(vec![bold(name), dim(if sid == app.session_id { "  attached" } else { "" })]), Line::raw("")];
    let windows = app.session_windows(sid);
    for (n, name, panes) in windows { out.push(Line::from(vec![Span::raw(format!("  {n}: {name}")), dim(format!("  ({panes} panes)"))])) }
    out.push(Line::raw(""));
    out.push(dim("enter goes to it").into());
    out
}

fn machine(app: &App, id: &str) -> Vec<Line<'static>> {
    let Some(m) = app.fleet.machine(id) else { return vec![] };
    let mut out = vec![Line::from(vec![bold(app.fleet.machine_name(id)), dim(if m.local { "  this computer" } else { "" })]), Line::raw("")];
    if let Some(rtt) = app.rtt.get(id) { out.push(kv("rtt", format!("{}ms", rtt.as_millis()))) }
    // Its agent accounts' rate limits (claude 5h 42% week 18%).
    for u in app.usage.get(id).into_iter().flatten() { out.push(kv("limits", u.line())) }
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
    // The name is already the preview's label.
    let mut out = Vec::new();
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

/// A line of an agent's message as a terminal reads it: `**bold**`, `` `code` `` (in the match
/// colour), a heading's #s taken off and the heading bold.
fn markdown(line: &str) -> Vec<Span<'static>> {
    let heading = line.trim_start().starts_with('#');
    let text = if heading { line.trim_start().trim_start_matches('#').trim_start() } else { line };
    let base = if heading { Style::default().add_modifier(Modifier::BOLD) } else { Style::default() };
    let (mut out, mut run, mut bold, mut code) = (Vec::new(), String::new(), false, false);
    let chars: Vec<char> = text.chars().collect();
    let style = |bold: bool, code: bool| { let s = if bold { base.add_modifier(Modifier::BOLD) } else { base }; if code { s.fg(theme::fzf().hl) } else { s } };
    let mut i = 0;
    while i < chars.len() {
        if !code && chars[i] == '*' && chars.get(i + 1) == Some(&'*') {
            if !run.is_empty() { out.push(Span::styled(std::mem::take(&mut run), style(bold, code))) }
            bold = !bold;
            i += 2;
            continue;
        }
        if chars[i] == '`' {
            if !run.is_empty() { out.push(Span::styled(std::mem::take(&mut run), style(bold, code))) }
            code = !code;
            i += 1;
            continue;
        }
        run.push(chars[i]);
        i += 1;
    }
    if !run.is_empty() { out.push(Span::styled(run, style(bold, code))) }
    out
}

/// A line as fzf's preview draws a command's output: its SGR codes as colours and attributes (30–37,
/// 90–97, 38;5;N, 38;2;R;G;B and their backgrounds, bold, dim, italic, underline, reverse,
/// strikethrough and their undoing), other escape sequences left out, tabs to the next tab stop.
pub fn ansi_line(text: &str, tabstop: usize) -> Line<'static> {
    let tabstop = tabstop.max(1);
    let (mut spans, mut run, mut style, mut col) = (Vec::new(), String::new(), Style::default(), 0usize);
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let flush = |spans: &mut Vec<Span<'static>>, run: &mut String, style: Style| if !run.is_empty() { spans.push(Span::styled(std::mem::take(run), style)) };
    while i < chars.len() {
        let c = chars[i];
        if c == '\x1b' {
            // CSI … final byte: SGR (m) read, the others dropped; OSC … BEL / ST dropped.
            if chars.get(i + 1) == Some(&'[') {
                let mut j = i + 2;
                while j < chars.len() && !('@'..='~').contains(&chars[j]) { j += 1 }
                if chars.get(j) == Some(&'m') {
                    flush(&mut spans, &mut run, style);
                    let params: String = chars[i + 2..j].iter().collect();
                    style = sgr(style, &params);
                }
                i = j + 1;
                continue;
            }
            if chars.get(i + 1) == Some(&']') {
                let mut j = i + 2;
                while j < chars.len() && chars[j] != '\x07' && !(chars[j] == '\x1b' && chars.get(j + 1) == Some(&'\\')) { j += 1 }
                i = if chars.get(j) == Some(&'\x07') { j + 1 } else { j + 2 };
                continue;
            }
            i += 2;
            continue;
        }
        if c == '\t' { let n = tabstop - col % tabstop; run.push_str(&" ".repeat(n)); col += n; i += 1; continue }
        if (c as u32) < 0x20 { i += 1; continue }
        run.push(c);
        col += unicode_width::UnicodeWidthChar::width(c).unwrap_or(0);
        i += 1;
    }
    flush(&mut spans, &mut run, style);
    Line::from(spans)
}

/// An SGR sequence's parameters over a style.
fn sgr(mut style: Style, params: &str) -> Style {
    let p: Vec<u16> = if params.is_empty() { vec![0] } else { params.split([';', ':']).map(|x| x.parse().unwrap_or(0)).collect() };
    let named = [Color::Black, Color::Red, Color::Green, Color::Yellow, Color::Blue, Color::Magenta, Color::Cyan, Color::Gray];
    let bright = [Color::DarkGray, Color::LightRed, Color::LightGreen, Color::LightYellow, Color::LightBlue, Color::LightMagenta, Color::LightCyan, Color::White];
    let mut k = 0;
    while k < p.len() {
        let n = p[k];
        let extended = |k: &mut usize| -> Option<Color> {
            match p.get(*k + 1) {
                Some(5) => { let c = p.get(*k + 2).map(|v| Color::Indexed(*v as u8)); *k += 2; c }
                Some(2) => { let c = (p.get(*k + 2), p.get(*k + 3), p.get(*k + 4)); *k += 4; match c { (Some(r), Some(g), Some(b)) => Some(Color::Rgb(*r as u8, *g as u8, *b as u8)), _ => None } }
                _ => None,
            }
        };
        style = match n {
            0 => Style::default(),
            1 => style.add_modifier(Modifier::BOLD), 2 => style.add_modifier(Modifier::DIM), 3 => style.add_modifier(Modifier::ITALIC),
            4 => style.add_modifier(Modifier::UNDERLINED), 5 => style.add_modifier(Modifier::SLOW_BLINK), 7 => style.add_modifier(Modifier::REVERSED),
            8 => style.add_modifier(Modifier::HIDDEN), 9 => style.add_modifier(Modifier::CROSSED_OUT),
            22 => style.remove_modifier(Modifier::BOLD | Modifier::DIM), 23 => style.remove_modifier(Modifier::ITALIC), 24 => style.remove_modifier(Modifier::UNDERLINED),
            25 => style.remove_modifier(Modifier::SLOW_BLINK), 27 => style.remove_modifier(Modifier::REVERSED), 28 => style.remove_modifier(Modifier::HIDDEN), 29 => style.remove_modifier(Modifier::CROSSED_OUT),
            30..=37 => style.fg(named[(n - 30) as usize]), 39 => style.fg(Color::Reset), 40..=47 => style.bg(named[(n - 40) as usize]), 49 => style.bg(Color::Reset),
            90..=97 => style.fg(bright[(n - 90) as usize]), 100..=107 => style.bg(bright[(n - 100) as usize]),
            38 => match extended(&mut k) { Some(c) => style.fg(c), None => style },
            48 => match extended(&mut k) { Some(c) => style.bg(c), None => style },
            _ => style,
        };
        k += 1;
    }
    style
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

/// A final message, indented, as markdown — all of it (the preview scrolls; its end is often the
/// question), or for a very long one its start and its end with how much is left out between.
fn message(text: &str) -> Vec<Line<'static>> {
    let lines: Vec<&str> = text.lines().collect();
    let line = |l: &str| { let mut spans = vec![dim("  ")]; spans.extend(markdown(l)); Line::from(spans) };
    if lines.len() <= 240 { return lines.iter().map(|l| line(l)).collect() }
    let (head, tail) = (&lines[..20], &lines[lines.len() - 200..]);
    let mut out: Vec<Line<'static>> = head.iter().map(|l| line(l)).collect();
    out.push(Line::from(vec![dim(format!("  … {} lines …", lines.len() - 220))]));
    out.extend(tail.iter().map(|l| line(l)));
    out
}
