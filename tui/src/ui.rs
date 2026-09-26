//! Drawing, the way tmux and fzf draw. A frame is the active window's panes (edge to edge when
//! there is one; tmux borders with `pane-border-status top` when there are several), then the
//! status line — tmux's: green, at the bottom, `[harness] 0:name* 1:name-`, the pane's title and
//! the time on the right; prompts and messages take it over in yellow. The search is fzf's own
//! layout and colours, with a preview window.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::vte::ansi::{Color as AColor, NamedColor};
use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::Frame;
use unicode_width::UnicodeWidthStr;

use crate::app::App;
use crate::fleet::{ago, State};
use crate::keys;
use crate::modal::{Modal, PickerKind, PromptKind};
use crate::pane::{Pane, Phase};
use crate::picker::Picker;
use crate::theme::{self, bold, fg, engine_mark, state_mark};
use crate::input::home_agents;

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    if area.width == 0 || area.height == 0 { return }
    let status = Rect::new(0, if app.status_top { 0 } else { area.height - 1 }, area.width, 1);
    let body = app.body();
    let buf = frame.buffer_mut();
    let mut cursor: Option<Position> = None;
    let full_screen = matches!(app.modal, Some(Modal::Picker { .. }) | Some(Modal::Tree { .. }));
    if !full_screen {
        if app.tab().root.is_none() { empty_window(buf, app, body) }
        else { cursor = window(buf, app, body) }
    }
    match &app.modal {
        Some(Modal::DisplayPanes { .. }) => display_panes(buf, app),
        Some(Modal::Clock { pane }) => {
            let rect = app.rects.iter().find(|(id, _)| id == pane).map(|(_, r)| *r).unwrap_or(body);
            clock(buf, rect);
            cursor = None;
        }
        _ => {}
    }
    let rects = app.rects.clone();
    if let Some(modal) = &mut app.modal {
        match modal {
            Modal::Picker { kind, picker } => { cursor = Some(fzf(buf, body, picker, kind, &*app_preview_placeholder())) }
            Modal::Tree { .. } => {}
            Modal::Copy { pane } => {
                if let (Some(p), Some((_, rect))) = (app.panes.get(pane), rects.iter().find(|(id, _)| id == pane)) {
                    let hdr = app.header_rows();
                    let content = Rect::new(rect.x, rect.y + hdr, rect.width, rect.height.saturating_sub(hdr));
                    copy_indicator(buf, p, content);
                    cursor = p.copy.and_then(|c| {
                        let row = c.point.line.0 + p.term.grid().display_offset() as i32;
                        let col = c.point.column.0 as u16;
                        (row >= 0 && (row as u16) < content.height && col < content.width).then(|| Position::new(content.x + col, content.y + row as u16))
                    });
                }
            }
            _ => {}
        }
    }
    // The picker drew with a placeholder preview; a live pane preview needs the whole app.
    if let Some(Modal::Picker { kind, picker }) = &app.modal {
        if let Some(area) = picker_preview_area(body, picker) { preview(buf, app, kind, picker, area) }
    }
    if let Some(Modal::Tree { cursor: at, collapsed }) = &app.modal { tree(buf, app, body, *at, collapsed) }
    if let Some(pos) = status_line(buf, app, status) { cursor = Some(pos) }
    if let Some(pos) = cursor { frame.set_cursor_position(pos) }
}

fn app_preview_placeholder() -> String { String::new() }

// ── the window ───────────────────────────────────────────────────────────────

/// The active window's panes, their borders and the seams between them.
fn window(buf: &mut Buffer, app: &mut App, body: Rect) -> Option<Position> {
    let focus = app.focused();
    let rects = app.rects.clone();
    let hdr = app.header_rows();
    let many = rects.len() > 1;
    let mut cursor = None;
    for (index, (id, rect)) in rects.iter().enumerate() {
        let active = Some(*id) == focus;
        let content = Rect::new(rect.x, rect.y + hdr, rect.width, rect.height.saturating_sub(hdr));
        // tmux's window-style / window-active-style: the default colours a pane's cells fall back to.
        let window = if active && many { (app.look.active_window_fg, app.look.active_window_bg) } else if many { (app.look.window_fg, app.look.window_bg) } else { (app.look.active_window_fg.or(app.look.window_fg), app.look.active_window_bg.or(app.look.window_bg)) };
        if let Some(pane) = app.panes.get_mut(id) {
            if let Some(pos) = pane_body(buf, pane, content, active, window) { cursor = Some(pos) }
            pane.dirty = false;
        }
        if hdr == 1 {
            let pane_index = app.tab().panes().iter().position(|p| p == id).unwrap_or(index) + app.pane_base_index;
            border_line(buf, app, *id, pane_index, *rect, active);
        }
    }
    if many {
        // Seams between side-by-side panes; green where they touch the active pane.
        let active_rect = rects.iter().find(|(id, _)| Some(*id) == focus).map(|(_, r)| *r);
        for (_, rect) in &rects {
            let seam = rect.x + rect.width;
            if seam >= body.x + body.width { continue }
            for y in rect.y..rect.y + rect.height {
                let touches = active_rect.map(|a| (a.x + a.width == seam || a.x == seam + 1) && y >= a.y && y < a.y + a.height).unwrap_or(false);
                if let Some(cell) = buf.cell_mut((seam, y)) { cell.set_symbol("│").set_style(border_style(app, touches)); }
            }
        }
        junctions(buf, body);
    }
    if app.modal.is_some() && !matches!(app.modal, Some(Modal::Copy { .. })) { None } else { cursor }
}

fn border_style(app: &App, active: bool) -> Style {
    if active { Style::default().fg(app.look.active_border.unwrap_or(theme::TMUX_ACTIVE_BORDER)) }
    else { app.look.border.map(|c| Style::default().fg(c)).unwrap_or_default() }
}

/// `pane-border-status top`, tmux's default format: the index (reversed on the active pane) and
/// the title in quotes — then, because a harness has one, its state; its machine at the far end.
fn border_line(buf: &mut Buffer, app: &App, id: u64, index: usize, rect: Rect, active: bool) {
    let style = border_style(app, active);
    for x in rect.x..rect.x + rect.width { if let Some(c) = buf.cell_mut((x, rect.y)) { c.set_symbol("─").set_style(style); } }
    let Some(pane) = app.panes.get(&id) else { return };
    let agent = app.fleet.agent(&pane.machine_id, &pane.agent_id);
    let title = agent.map(|a| a.name.clone()).unwrap_or_else(|| pane.agent_id.chars().take(8).collect());
    let mut spans: Vec<Span> = vec![Span::styled("─", style), Span::styled(index.to_string(), if active { style.add_modifier(Modifier::REVERSED) } else { style }), Span::styled(format!(" \"{title}\""), style)];
    if let Some(word) = pane_state_word(app, pane) { spans.push(Span::raw(" ")); spans.push(word) }
    spans.push(Span::styled(" ", style));
    let machine = if app.fleet.machines.len() > 1 { app.fleet.machine_name(&pane.machine_id) } else { String::new() };
    let right = if machine.is_empty() { String::new() } else { format!(" {machine} ") };
    let limit = rect.width.saturating_sub(right.width() as u16 + 1) as usize;
    let line = clip_spans(spans, limit);
    buf.set_line(rect.x, rect.y, &line, rect.width);
    if !right.is_empty() && rect.width as usize > line.width() + right.width() + 2 {
        buf.set_string(rect.x + rect.width - right.width() as u16 - 1, rect.y, &right, style);
    }
}

/// What a harness is doing, in a word, when it is worth saying.
fn pane_state_word(app: &App, pane: &Pane) -> Option<Span<'static>> {
    if let Phase::Watching(who) = &pane.phase {
        return Some(Span::styled(format!("[watching{}]", if who.is_empty() { String::new() } else { format!(" — {who} has it") }), Style::default().fg(Color::Yellow)));
    }
    let agent = app.fleet.agent(&pane.machine_id, &pane.agent_id)?;
    Some(match app.fleet.state_of(agent) {
        State::NeedsInput => Span::styled("[waiting]", Style::default().fg(Color::Black).bg(Color::Yellow)),
        State::Working => Span::styled("[working]", Style::default().fg(Color::Cyan)),
        State::Paused => Span::styled("[paused]", Style::default().add_modifier(Modifier::DIM)),
        State::Offline => Span::styled("[offline]", Style::default().add_modifier(Modifier::DIM)),
        State::Starting => Span::styled("[starting]", Style::default().fg(Color::Yellow)),
        State::Failed => Span::styled("[failed]", Style::default().fg(Color::Red)),
        State::Done | State::Ready => return None,
    })
}

/// Where a seam meets a border line, the box-drawing character that joins them.
fn junctions(buf: &mut Buffer, body: Rect) {
    let sym = |buf: &Buffer, x: u16, y: u16| -> String { buf.cell((x, y)).map(|c| c.symbol().to_string()).unwrap_or_default() };
    let horizontal = |s: &str| matches!(s, "─" | "┬" | "┴" | "┼" | "├" | "┤");
    let vertical = |s: &str| matches!(s, "│" | "┬" | "┴" | "┼" | "├" | "┤");
    for y in body.y..body.y + body.height {
        for x in body.x..body.x + body.width {
            if sym(buf, x, y) != "│" { continue }
            let left = x > body.x && horizontal(&sym(buf, x - 1, y));
            let right = x + 1 < body.x + body.width && horizontal(&sym(buf, x + 1, y));
            if !left && !right { continue }
            let up = y > body.y && vertical(&sym(buf, x, y - 1));
            let down = y + 1 < body.y + body.height && vertical(&sym(buf, x, y + 1));
            let joined = match (left, right, up, down) {
                (true, true, true, true) => "┼", (true, true, false, true) => "┬", (true, true, true, false) => "┴",
                (false, true, _, _) => "├", (true, false, _, _) => "┤", _ => "│",
            };
            if let Some(c) = buf.cell_mut((x, y)) { let st = c.style(); c.set_symbol(joined).set_style(st); }
        }
    }
}

/// A window with no harness in it: the harnesses you were just with, one key away.
const WORDMARK: [&str; 2] = ["█ █ ▄▀█ █▀█ █▄ █ █▀▀ █▀ █▀", "█▀█ █▀█ █▀▄ █ ▀█ ██▄ ▄█ ▄█"];

fn empty_window(buf: &mut Buffer, app: &App, area: Rect) {
    let rows = home_agents(app);
    let width = area.width.min(84).saturating_sub(4);
    let left = area.x + (area.width.saturating_sub(width)) / 2;
    let compact = area.height < 22;
    let mut lines: Vec<Line> = Vec::new();
    if !compact { for w in WORDMARK { lines.push(Line::styled(w, fg(theme::ACCENT))) } lines.push(Line::raw("")) }
    else { lines.push(Line::styled("harness", bold(theme::ACCENT))) }
    let local = app.fleet.machine(&app.fleet.local_id).map(|m| m.name.clone()).unwrap_or_default();
    let up = app.fleet.machines.iter().filter(|m| m.usable()).count();
    let sub = if app.fleet.machines.len() > 1 { format!("{local} · {up}/{} machines connected", app.fleet.machines.len()) } else { local };
    lines.push(Line::styled(sub, fg(theme::MUTED)));
    lines.push(Line::raw(""));
    let centered = lines.len();
    if app.daemon_down {
        lines.push(Line::styled("The Harness daemon is not running here.", bold(theme::DANGER)));
        lines.push(Line::styled("Run `harness start` — this screen connects by itself.", fg(theme::SOFT)));
    } else if app.fleet.agents.is_empty() && app.started.elapsed().as_secs() < 3 {
        lines.push(Line::styled(format!("{} Finding your harnesses…", theme::spinner(app.tick)), fg(theme::SOFT)));
    } else if rows.is_empty() {
        lines.push(Line::styled("Nothing running.", fg(theme::SOFT)));
        lines.push(Line::from(vec![Span::styled("n", bold(theme::ACCENT)), Span::styled(" starts a harness · ", fg(theme::MUTED)), Span::styled("o", bold(theme::ACCENT)), Span::styled(" opens a paused one", fg(theme::MUTED))]));
    } else {
        let many = app.fleet.machines.iter().filter(|m| m.usable()).count() > 1;
        for (index, (m, a)) in rows.iter().enumerate() {
            let Some(agent) = app.fleet.agent(m, a) else { continue };
            let state = app.fleet.state_of(agent);
            let (dot, _, color) = state_mark(state);
            let (mark, mark_color) = engine_mark(&agent.engine);
            let right = format!("{}{}", if many { format!("{}  ", app.fleet.machine_name(m)) } else { String::new() }, ago(agent.recency()));
            let detail = agent.question.as_ref().map(|q| (q.prompt.clone(), theme::ATTENTION)).unwrap_or((if agent.project.is_empty() { agent.cwd.clone() } else { agent.project.clone() }, theme::MUTED));
            let name_w = 28usize;
            let name: String = if agent.name.width() > name_w { agent.name.chars().take(name_w - 1).collect::<String>() + "…" } else { agent.name.clone() };
            let detail_room = (width as usize).saturating_sub(name_w + right.width() + 12);
            let detail_text: String = if detail.0.width() > detail_room { detail.0.chars().take(detail_room.saturating_sub(1)).collect::<String>() + "…" } else { detail.0 };
            let used = 2 + 2 + 2 + name_w + 2 + detail_text.width();
            let pad = (width as usize).saturating_sub(used + right.width());
            let selected = index == app.home_cursor;
            let bg = if selected { Style::default().bg(theme::SELECT) } else { Style::default() };
            lines.push(Line::from(vec![
                Span::styled(format!("{} ", index + 1), bg.fg(theme::ACCENT)),
                Span::styled(format!("{dot} "), bg.fg(color)),
                Span::styled(format!("{mark} "), bg.fg(mark_color)),
                Span::styled(format!("{name:<name_w$}  "), bg.fg(if selected { theme::TEXT } else { Color::Reset }).add_modifier(Modifier::BOLD)),
                Span::styled(detail_text, bg.fg(detail.1)),
                Span::styled(" ".repeat(pad), bg),
                Span::styled(right, bg.fg(theme::MUTED)),
            ]));
        }
    }
    lines.push(Line::raw(""));
    let keys = [("↵", "open"), ("p", "harnesses"), ("o", "projects"), ("n", "new"), ("t", "terminal"), ("i", "models"), ("I", "needs input"), ("m", "machines"), ("s", "store"), (">", "commands"), ("?", "help")];
    let mut row: Vec<Span> = Vec::new();
    let mut row_w = 0;
    for (k, w) in keys {
        let piece_w = k.width() + w.width() + 4;
        if row_w + piece_w > width as usize { lines.push(Line::from(std::mem::take(&mut row))); row_w = 0 }
        row.push(Span::styled(k, bold(theme::ACCENT)));
        row.push(Span::styled(format!(" {w}   "), fg(theme::SOFT)));
        row_w += piece_w;
    }
    if !row.is_empty() { lines.push(Line::from(row)) }
    lines.push(Line::raw(""));
    let prefix = crate::keys::name(&app.keymap.prefix);
    lines.push(Line::from(vec![Span::styled(format!("{prefix} ?"), bold(theme::ACCENT)), Span::styled(" every key   ", fg(theme::SOFT)), Span::styled(format!("{prefix} d"), bold(theme::ACCENT)), Span::styled(" detach — everything keeps running", fg(theme::SOFT))]));
    let top = area.y + area.height.saturating_sub(lines.len() as u16) / 2;
    for (index, line) in lines.iter().enumerate() {
        let y = top + index as u16;
        if y >= area.y + area.height { break }
        let w = line.width() as u16;
        let x = if index < centered { area.x + area.width.saturating_sub(w) / 2 } else { left };
        buf.set_line(x, y, line, area.width.saturating_sub(x - area.x));
    }
}


// ── the status line ──────────────────────────────────────────────────────────

/// tmux's status line — or, while there is one, the prompt, question or message that takes it.
fn status_line(buf: &mut Buffer, app: &mut App, rect: Rect) -> Option<Position> {
    let yellow = Style::default().bg(app.look.message_bg.unwrap_or(theme::TMUX_MESSAGE_BG)).fg(app.look.message_fg.unwrap_or(theme::TMUX_MESSAGE_FG));
    let prompt_like: Option<(String, String, usize, String)> = match &app.modal {
        Some(Modal::Prompt(p)) => {
            let shown: String = if p.secret { "*".repeat(p.value.chars().count()) } else { p.value.clone() };
            Some((p.label.clone(), shown, p.cursor, p.hint.clone()))
        }
        Some(Modal::Confirm { prompt, .. }) => Some((format!("{prompt} "), String::new(), 0, String::new())),
        Some(Modal::Find { query, found, .. }) => Some(("(search up) ".into(), query.clone(), query.chars().count(), if *found == Some(false) && !query.is_empty() { "no match".into() } else { String::new() })),
        _ => None,
    };
    if let Some((label, value, cursor, hint)) = prompt_like {
        buf.set_style(rect, yellow);
        buf.set_string(rect.x, rect.y, &label, yellow);
        let x0 = rect.x + label.width() as u16;
        let room = rect.width.saturating_sub(label.width() as u16 + 1) as usize;
        // Keep the cursor in view on a long line.
        let before: String = value.chars().take(cursor).collect();
        let skip = before.width().saturating_sub(room);
        let visible: String = { let mut w = 0; value.chars().skip_while(|c| { let cw = unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0); if w < skip { w += cw; true } else { false } }).collect() };
        buf.set_stringn(x0, rect.y, &visible, room, yellow);
        let cx = x0 + before.width().saturating_sub(skip) as u16;
        if let Some(c) = buf.cell_mut((cx.min(rect.x + rect.width - 1), rect.y)) { let st = c.style(); c.set_style(st.add_modifier(Modifier::REVERSED)); }
        if !hint.is_empty() {
            let used = label.width() + value.width() + 3;
            if used + hint.width() < rect.width as usize {
                buf.set_string(rect.x + rect.width - hint.width() as u16 - 1, rect.y, &hint, yellow.add_modifier(Modifier::DIM));
            }
        }
        return None;
    }
    if let Some((text, _, at)) = &app.toast {
        if at.elapsed() < Duration::from_millis(app.display_ms) {
            buf.set_style(rect, yellow);
            buf.set_stringn(rect.x, rect.y, text, rect.width as usize, yellow);
            return None;
        }
    }
    let base = Style::default().bg(app.look.status_bg.unwrap_or(theme::TMUX_STATUS_BG)).fg(app.look.status_fg.unwrap_or(theme::TMUX_STATUS_FG));
    buf.set_style(rect, base);
    // status-left: tmux's "[#S] " — here this computer's name, the session a window lives in.
    let host = app.fleet.machine(&app.fleet.local_id).map(|m| m.name.clone()).unwrap_or_else(crate::app::hostname);
    let host: String = host.chars().take(12).collect();
    let left = format!("[{host}] ");
    // While the prefix waits for its key, the name shows it (reversed), the one thing tmux users add first.
    buf.set_string(rect.x, rect.y, &left, if app.prefix { base.add_modifier(Modifier::REVERSED) } else { base });
    // status-right: "#{=21:pane_title}" %H:%M %d-%b-%y, with the harnesses waiting on you before it.
    let (clock, date) = local_time(app.utc_offset_secs);
    let title = crate::input::focused_title(app);
    let title: String = if title.is_empty() { host.clone() } else { title.chars().take(21).collect() };
    let machine = app.focused().and_then(|f| app.panes.get(&f)).filter(|_| app.fleet.machines.len() > 1).map(|p| app.fleet.machine_name(&p.machine_id));
    let mut right: Vec<Span> = Vec::new();
    let waiting = app.fleet.waiting();
    if app.daemon_down { right.push(Span::styled("daemon down ", base.add_modifier(Modifier::REVERSED))); right.push(Span::styled(" ", base)) }
    if waiting > 0 { right.push(Span::styled(format!("{waiting} waiting"), base.add_modifier(Modifier::REVERSED))); right.push(Span::styled(" ", base)) }
    if app.focused().and_then(|f| app.panes.get(&f)).map(|p| matches!(p.phase, Phase::Watching(_))).unwrap_or(false) && app.rects.len() < 2 {
        right.push(Span::styled("[watching] ", base));
    }
    let who = match machine { Some(m) => format!("\"{title}\" {m} "), None => format!("\"{title}\" ") };
    right.push(Span::styled(format!("{who}{clock} {date}"), base));
    let right_line = Line::from(right);
    let right_w = (right_line.width() as u16).min(rect.width.saturating_sub(12));
    let right_x = rect.x + rect.width - right_w;
    buf.set_line(right_x, rect.y, &right_line, right_w);
    // The window list, scrolled with < and > when it does not fit (as tmux does).
    let list_x = rect.x + left.width() as u16;
    let list_end = right_x.saturating_sub(1);
    let entries: Vec<(String, bool)> = (0..app.tabs.len()).map(|i| window_entry(app, i)).collect();
    let widths: Vec<u16> = entries.iter().map(|(e, _)| e.width() as u16 + 1).collect();
    let room = list_end.saturating_sub(list_x);
    let mut first = 0;
    while first < app.active && widths[first..=app.active].iter().sum::<u16>() > room.saturating_sub(2) { first += 1 }
    let mut x = list_x;
    if first > 0 { buf.set_string(x, rect.y, "<", base); x += 1 }
    app.tab_hits.clear();
    for (i, (entry, alert)) in entries.iter().enumerate().skip(first) {
        let w = entry.width() as u16;
        if x + w + 1 > list_end { buf.set_string(list_end.saturating_sub(1).max(x), rect.y, ">", base); break }
        let style = if *alert { base.add_modifier(Modifier::REVERSED) } else { base };
        buf.set_string(x, rect.y, entry, style);
        app.tab_hits.push((i, x, x + w));
        x += w + 1;
    }
    None
}

/// `#I:#W#{window_flags}` — `*` current, `-` last, `Z` zoomed, `!` a harness is waiting on you
/// (tmux's bell flag), `#` one finished (activity). The bool: draw it reversed, as tmux does alerts.
fn window_entry(app: &App, index: usize) -> (String, bool) {
    let tab = &app.tabs[index];
    let mut name: String = tab.name.chars().take(24).collect();
    if tab.name.chars().count() > 24 { name.pop(); name.push('…') }
    let mut flags = String::new();
    if index == app.active { flags.push('*') }
    else if app.last_tab.as_ref() == Some(&tab.id) { flags.push('-') }
    let (mut bell, mut activity) = (false, false);
    for id in tab.panes() {
        let Some(pane) = app.panes.get(&id) else { continue };
        let Some(agent) = app.fleet.agent(&pane.machine_id, &pane.agent_id) else { continue };
        match app.fleet.state_of(agent) { State::NeedsInput => bell = true, State::Done => activity = true, _ => {} }
    }
    if bell { flags.push('!') }
    if activity && !bell { flags.push('#') }
    if tab.zoomed { flags.push('Z') }
    (format!("{}:{}{}", index + app.base_index, name, flags), (bell || activity) && index != app.active)
}

/// "%H:%M" and "%d-%b-%y" in local time, without a date crate.
fn local_time(offset: i64) -> (String, String) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) + offset;
    let (days, secs) = (now.div_euclid(86_400), now.rem_euclid(86_400));
    // Civil date from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    (format!("{:02}:{:02}", secs / 3600, (secs / 60) % 60), format!("{:02}-{}-{:02}", d, MONTHS[(m - 1) as usize], y % 100))
}

// ── fzf ──────────────────────────────────────────────────────────────────────

fn picker_preview_area(body: Rect, picker: &Picker) -> Option<Rect> {
    (picker.preview && body.width >= 80 && body.height >= 8).then(|| {
        let list_w = body.width / 2;
        Rect::new(body.x + list_w, body.y, body.width - list_w, body.height)
    })
}

/// fzf 0.67's default layout, measured: rows bottom-up (best nearest the prompt), `▌` gutter
/// (236; the current row's in 161 on 236), matches in 108 (151 on the current row), the info line
/// `  4/7 ───` (144, separator 59), the prompt `> ` (110). Returns where the cursor goes.
fn fzf(buf: &mut Buffer, body: Rect, picker: &mut Picker, kind: &PickerKind, _: &str) -> Position {
    let preview = picker_preview_area(body, picker);
    let area = match preview { Some(p) => Rect::new(body.x, body.y, p.x - body.x, body.height), None => body };
    let width = area.width as usize;
    let bottom = area.y + area.height;
    // Prompt, then info, then the header (the keys), then the list above.
    let prompt_y = bottom - 1;
    let info_y = prompt_y.saturating_sub(1);
    let header = header_line(picker, kind);
    let header_y = if header.is_some() { info_y.saturating_sub(1) } else { info_y };
    let prompt = Style::default().fg(theme::FZF_PROMPT);
    buf.set_string(area.x, prompt_y, ">", prompt.add_modifier(Modifier::BOLD));
    buf.set_string(area.x + 1, prompt_y, " ", prompt);
    let q_room = width.saturating_sub(3);
    buf.set_stringn(area.x + 2, prompt_y, &picker.query, q_room, Style::default().add_modifier(Modifier::BOLD));
    if picker.query.is_empty() && !picker.placeholder.is_empty() {
        buf.set_stringn(area.x + 2, prompt_y, &picker.placeholder, q_room, Style::default().add_modifier(Modifier::DIM));
    }
    let before: String = picker.query.chars().take(picker.qcursor).collect();
    let cursor = Position::new(area.x + 2 + (before.width() as u16).min(q_room as u16), prompt_y);
    // Info: "  matched/total" then the title, then the separator to the edge.
    let total = picker.rows.iter().filter(|r| !r.disabled).count();
    let mut info = format!("  {}/{}", picker.visible.len(), total);
    if !picker.marked.is_empty() { info.push_str(&format!(" ({})", picker.marked.len())) }
    buf.set_string(area.x, info_y, &info, Style::default().fg(theme::FZF_INFO));
    let mut x = area.x + info.width() as u16;
    let label = picker.busy.clone().or_else(|| (!picker.title.is_empty()).then(|| picker.title.clone()));
    if let Some(label) = label {
        let text = format!(" {label} ");
        if (x as usize) + text.width() + 4 < (area.x as usize + width) {
            buf.set_string(x, info_y, " ", Style::default());
            buf.set_string(x + 1, info_y, &text, Style::default().fg(theme::FZF_HEADER));
            x += text.width() as u16 + 1;
        }
    }
    if x + 1 < area.x + area.width {
        buf.set_string(x, info_y, " ", Style::default());
        let sep = "─".repeat((area.x + area.width).saturating_sub(x + 1) as usize);
        buf.set_string(x + 1, info_y, &sep, Style::default().fg(theme::FZF_BORDER));
    }
    if let Some(flash) = picker.flash.as_ref().map(|f| f.0.clone()) {
        let text = format!(" {flash} ");
        let fx = (area.x + area.width).saturating_sub(text.width() as u16 + 1);
        buf.set_string(fx, info_y, &text, Style::default().fg(Color::Black).bg(Color::Yellow));
    }
    if let Some(h) = header { buf.set_line(area.x, header_y, &h, area.width); }
    // The list, bottom-up.
    let list_bottom = header_y; // exclusive
    let list_h = list_bottom.saturating_sub(area.y) as usize;
    let n = picker.visible.len();
    if n == 0 {
        if !picker.empty.is_empty() && list_h > 0 { buf.set_string(area.x + 2, list_bottom - 1, &picker.empty, Style::default().add_modifier(Modifier::DIM)); }
        picker.row_at.clear();
        return cursor;
    }
    // Scroll so the cursor row is in view (scroll = first visible index from the bottom).
    if picker.cursor < picker.scroll { picker.scroll = picker.cursor }
    if picker.cursor >= picker.scroll + list_h { picker.scroll = picker.cursor + 1 - list_h }
    picker.scroll = picker.scroll.min(n.saturating_sub(list_h.max(1)));
    picker.row_at.clear();
    let text_w = width.saturating_sub(3);
    for slot in 0..list_h.min(n - picker.scroll) {
        let vi = picker.scroll + slot;
        let y = list_bottom - 1 - slot as u16;
        picker.row_at.push((y, vi));
        fzf_row(buf, picker, vi, area.x, y, text_w);
    }
    // Scrollbar on the right edge, like fzf's: only the thumb, in the border colour.
    if n > list_h && list_h > 2 {
        let thumb = ((list_h * list_h) / n).max(1);
        let top_frac = (n - list_h - picker.scroll.min(n - list_h)) as f32 / (n - list_h) as f32;
        let start = ((list_h - thumb) as f32 * top_frac).round() as usize;
        for i in 0..thumb {
            let y = area.y + (start + i) as u16;
            if y < list_bottom { buf.set_string(area.x + area.width - 1, y, "│", Style::default().fg(theme::FZF_BORDER)); }
        }
    }
    cursor
}

/// One fzf row: gutter, marker, then the text — matches lit, the current row on 236.
fn fzf_row(buf: &mut Buffer, picker: &Picker, vi: usize, x: u16, y: u16, text_w: usize) {
    let (ri, hits) = &picker.visible[vi];
    let row = &picker.rows[*ri];
    let current = vi == picker.cursor;
    let marked = picker.marked.contains(&row.id);
    let plus = Style::default().bg(theme::FZF_BG_PLUS);
    if current {
        buf.set_string(x, y, "▌", Style::default().fg(theme::FZF_POINTER).bg(theme::FZF_BG_PLUS).add_modifier(Modifier::BOLD));
    } else {
        buf.set_string(x, y, "▌", Style::default().fg(theme::FZF_GUTTER));
    }
    let marker_style = if current { plus.fg(theme::FZF_MARKER) } else { Style::default().fg(theme::FZF_MARKER) };
    buf.set_string(x + 1, y, if marked { "┃" } else { " " }, marker_style);
    let base = if current { plus.fg(theme::FZF_FG_PLUS).add_modifier(Modifier::BOLD) } else { Style::default() };
    let hit = if current { plus.fg(theme::FZF_HL_PLUS).add_modifier(Modifier::BOLD) } else { Style::default().fg(theme::FZF_HL) };
    let mut spans: Vec<Span> = Vec::new();
    for s in &row.lead { spans.push(Span::styled(s.content.clone(), if current { s.style.patch(plus) } else { s.style })) }
    let mut run = String::new();
    let mut lit = false;
    for (i, ch) in row.label.chars().enumerate() {
        let on = hits.contains(&(i as u32));
        if on != lit && !run.is_empty() { spans.push(Span::styled(std::mem::take(&mut run), if lit { hit } else { base })) }
        lit = on;
        run.push(ch);
    }
    if !run.is_empty() { spans.push(Span::styled(run, if lit { hit } else { base })) }
    let right_w = row.right.width();
    let head_w: usize = spans.iter().map(|s| s.content.width()).sum();
    let show_right = !row.right.is_empty() && head_w + right_w + 4 <= text_w;
    let detail_room = text_w.saturating_sub(head_w + 2 + if show_right { right_w + 2 } else { 0 });
    if !row.detail.is_empty() && detail_room > 3 {
        spans.push(Span::styled("  ", if current { plus } else { Style::default() }));
        let mut left = detail_room;
        for s in &row.detail {
            if left == 0 { break }
            let t = clip(&s.content, left);
            left = left.saturating_sub(t.width());
            spans.push(Span::styled(t, if current { s.style.patch(plus) } else { s.style }));
        }
    }
    let used: usize = spans.iter().map(|s| s.content.width()).sum();
    if show_right {
        spans.push(Span::styled(" ".repeat(text_w.saturating_sub(used + right_w)), Style::default()));
        spans.push(Span::styled(row.right.clone(), Style::default().add_modifier(Modifier::DIM)));
    }
    buf.set_line(x + 2, y, &Line::from(spans), text_w as u16);
}

/// fzf's `--header`: the keys this list answers to, in the header colour.
fn header_line(picker: &Picker, _: &PickerKind) -> Option<Line<'static>> {
    if picker.hints.is_empty() { return None }
    let mut spans = vec![Span::raw("  ")];
    for (i, (k, w)) in picker.hints.iter().enumerate() {
        if i > 0 { spans.push(Span::styled(" · ", Style::default().fg(theme::FZF_BORDER))) }
        spans.push(Span::styled(k.to_string(), Style::default().fg(theme::FZF_HEADER).add_modifier(Modifier::BOLD)));
        spans.push(Span::styled(format!(" {w}"), Style::default().fg(theme::FZF_HEADER)));
    }
    Some(Line::from(spans))
}

/// The preview window: fzf's rounded border in 59, a label at the top, the content inside.
fn preview(buf: &mut Buffer, app: &App, kind: &PickerKind, picker: &Picker, area: Rect) {
    let border = Style::default().fg(theme::FZF_BORDER);
    let w = area.width;
    let h = area.height;
    for y in area.y..area.y + h {
        for x in area.x..area.x + w { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } }
    }
    buf.set_string(area.x, area.y, "╭", border);
    buf.set_string(area.x + w - 1, area.y, "╮", border);
    buf.set_string(area.x, area.y + h - 1, "╰", border);
    buf.set_string(area.x + w - 1, area.y + h - 1, "╯", border);
    for x in area.x + 1..area.x + w - 1 { buf.set_string(x, area.y, "─", border); buf.set_string(x, area.y + h - 1, "─", border); }
    for y in area.y + 1..area.y + h - 1 { buf.set_string(area.x, y, "│", border); buf.set_string(area.x + w - 1, y, "│", border); }
    let inner = Rect::new(area.x + 2, area.y + 1, w.saturating_sub(4), h.saturating_sub(2));
    let Some(id) = picker.current_id() else { return };
    let label = picker.current().map(|r| r.label.clone()).unwrap_or_default();
    let label = format!(" {} ", clip(&label, (w as usize).saturating_sub(6)));
    buf.set_string(area.x + 2, area.y, &label, border.add_modifier(Modifier::BOLD));
    // A harness that is on screen somewhere: its terminal, live.
    if matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) {
        let key = id.split('#').next().unwrap_or(&id);
        if let Some((m, a)) = key.split_once(':') {
            if let Some((_, pane_id)) = app.find_pane(m, a) {
                if let Some(pane) = app.panes.get(&pane_id) {
                    if matches!(pane.phase, Phase::Live | Phase::Watching(_)) { preview_grid(buf, pane, inner, picker.preview_scroll); return }
                }
            }
        }
    }
    let lines = crate::preview::lines(app, kind, &id);
    for (i, line) in lines.iter().skip(picker.preview_scroll as usize).take(inner.height as usize).enumerate() {
        buf.set_line(inner.x, inner.y + i as u16, line, inner.width);
    }
}

/// A pane's terminal, drawn into a preview box: its bottom, where the work is.
fn preview_grid(buf: &mut Buffer, pane: &Pane, area: Rect, scroll: u16) {
    let content = pane.term.renderable_content();
    let colors = content.colors;
    let rows = pane.rows as i32;
    // Show the last `area.height` rows of the screen (minus scroll).
    let first = (rows - area.height as i32 - scroll as i32).max(0);
    for indexed in content.display_iter {
        let row = indexed.point.line.0 - first;
        let col = indexed.point.column.0 as u16;
        if row < 0 || row as u16 >= area.height || col >= area.width { continue }
        let cell = indexed.cell;
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) { continue }
        let (fg_color, dim) = map_color(cell.fg, colors, true);
        let (bg_color, _) = map_color(cell.bg, colors, false);
        let mut style = Style::default().fg(fg_color).bg(bg_color);
        if cell.flags.contains(Flags::BOLD) { style = style.add_modifier(Modifier::BOLD) }
        if cell.flags.contains(Flags::DIM) || dim { style = style.add_modifier(Modifier::DIM) }
        if cell.flags.contains(Flags::INVERSE) { style = style.add_modifier(Modifier::REVERSED) }
        if let Some(t) = buf.cell_mut((area.x + col, area.y + row as u16)) { t.set_char(if cell.c == '\0' { ' ' } else { cell.c }).set_style(style); }
    }
}

// ── tmux modes ───────────────────────────────────────────────────────────────

/// A row of choose-tree: a window, or one of its panes.
pub struct TreeRow { pub window: usize, pub pane: Option<u64> }

pub fn tree_rows(app: &App, collapsed: &[String]) -> Vec<TreeRow> {
    let mut rows = Vec::new();
    for (w, tab) in app.tabs.iter().enumerate() {
        rows.push(TreeRow { window: w, pane: None });
        if collapsed.contains(&tab.id) { continue }
        for id in tab.panes() { rows.push(TreeRow { window: w, pane: Some(id) }) }
    }
    rows
}

/// choose-tree -w: tmux's format — `(0) + 0: name* (2 panes)`, `(1) ├─> 0: "title"` — the chosen
/// row in mode-style (yellow), and the window it names previewed below.
fn tree(buf: &mut Buffer, app: &App, body: Rect, cursor: usize, collapsed: &[String]) {
    for y in body.y..body.y + body.height { for x in body.x..body.x + body.width { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } } }
    let rows = tree_rows(app, collapsed);
    let list_h = (body.height / 2).max(3).min(rows.len() as u16 + 1).min(body.height);
    let mode = Style::default().bg(Color::Yellow).fg(Color::Black);
    let start = cursor.saturating_sub(list_h as usize - 1);
    for (i, row) in rows.iter().enumerate().skip(start).take(list_h as usize) {
        let y = body.y + (i - start) as u16;
        let tab = &app.tabs[row.window];
        let text = match row.pane {
            None => {
                let n = tab.panes().len();
                let (entry, _) = window_entry(app, row.window);
                format!("({i}) {} {entry}: {n} pane{}", if collapsed.contains(&tab.id) { "+" } else { "-" }, if n == 1 { "" } else { "s" })
            }
            Some(p) => {
                let panes = tab.panes();
                let at = panes.iter().position(|x| *x == p).unwrap_or(0);
                let branch = if at + 1 == panes.len() { "└─>" } else { "├─>" };
                let pane = app.panes.get(&p);
                let name = pane.and_then(|pn| app.fleet.agent(&pn.machine_id, &pn.agent_id)).map(|a| a.name.clone()).unwrap_or_default();
                let machine = pane.map(|pn| app.fleet.machine_name(&pn.machine_id)).unwrap_or_default();
                let state = pane.and_then(|pn| app.fleet.agent(&pn.machine_id, &pn.agent_id)).map(|a| match app.fleet.state_of(a) { State::NeedsInput => " [waiting]", State::Working => " [working]", State::Paused => " [paused]", State::Offline => " [offline]", _ => "" }).unwrap_or("");
                format!("({i})     {branch} {}: \"{name}\" {machine}{state}", at + app.pane_base_index)
            }
        };
        let style = if i == cursor { mode } else { Style::default() };
        if i == cursor { buf.set_style(Rect::new(body.x, y, body.width, 1), mode) }
        buf.set_stringn(body.x, y, &text, body.width as usize, style);
    }
    // The preview: the chosen window's (or pane's) terminal, in a box below.
    let top = body.y + list_h;
    if body.height <= list_h + 3 { return }
    let area = Rect::new(body.x, top, body.width, body.height - list_h);
    let border = Style::default();
    for x in area.x..area.x + area.width { buf.set_string(x, area.y, "─", border); buf.set_string(x, area.y + area.height - 1, "─", border); }
    for y in area.y..area.y + area.height { buf.set_string(area.x, y, "│", border); buf.set_string(area.x + area.width - 1, y, "│", border); }
    buf.set_string(area.x, area.y, "┌", border); buf.set_string(area.x + area.width - 1, area.y, "┐", border);
    buf.set_string(area.x, area.y + area.height - 1, "└", border); buf.set_string(area.x + area.width - 1, area.y + area.height - 1, "┘", border);
    let Some(row) = rows.get(cursor) else { return };
    let pane_id = row.pane.or(app.tabs[row.window].focus);
    let inner = Rect::new(area.x + 1, area.y + 1, area.width - 2, area.height - 2);
    match pane_id.and_then(|p| app.panes.get(&p)) {
        Some(pane) if matches!(pane.phase, Phase::Live | Phase::Watching(_)) => preview_grid(buf, pane, inner, 0),
        Some(_) => { buf.set_string(inner.x + 1, inner.y, "(not streaming yet — open it to see it)", Style::default().add_modifier(Modifier::DIM)); }
        None => { buf.set_string(inner.x + 1, inner.y, "(empty window)", Style::default().add_modifier(Modifier::DIM)); }
    }
}

/// tmux's big digits (clock-mode, display-panes): 5 wide, 5 tall, drawn as coloured blocks.
const DIGITS: [[&str; 5]; 11] = [
    ["xxxxx", "x...x", "x...x", "x...x", "xxxxx"], ["....x", "....x", "....x", "....x", "....x"],
    ["xxxxx", "....x", "xxxxx", "x....", "xxxxx"], ["xxxxx", "....x", "xxxxx", "....x", "xxxxx"],
    ["x...x", "x...x", "xxxxx", "....x", "....x"], ["xxxxx", "x....", "xxxxx", "....x", "xxxxx"],
    ["xxxxx", "x....", "xxxxx", "x...x", "xxxxx"], ["xxxxx", "....x", "....x", "....x", "....x"],
    ["xxxxx", "x...x", "xxxxx", "x...x", "xxxxx"], ["xxxxx", "x...x", "xxxxx", "....x", "xxxxx"],
    [".....", "..x..", ".....", "..x..", "....."],
];

fn big(buf: &mut Buffer, text: &str, area: Rect, color: Color) {
    let glyphs: Vec<usize> = text.chars().filter_map(|c| c.to_digit(10).map(|d| d as usize).or((c == ':').then_some(10))).collect();
    let w = glyphs.len() as u16 * 6;
    if area.width < w || area.height < 5 {
        // Too small for blocks: the plain text, as tmux does.
        let x = area.x + area.width.saturating_sub(text.len() as u16) / 2;
        buf.set_string(x, area.y + area.height / 2, text, Style::default().fg(color));
        return;
    }
    let x0 = area.x + (area.width - w) / 2;
    let y0 = area.y + (area.height - 5) / 2;
    for (i, g) in glyphs.iter().enumerate() {
        for (r, row) in DIGITS[*g].iter().enumerate() {
            for (c, bit) in row.chars().enumerate() {
                if bit == 'x' { if let Some(cell) = buf.cell_mut((x0 + i as u16 * 6 + c as u16, y0 + r as u16)) { cell.set_symbol(" ").set_style(Style::default().bg(color)); } }
            }
        }
    }
}

/// display-panes (C-b q): each pane's index, big, in its middle — the active one red, others blue.
fn display_panes(buf: &mut Buffer, app: &App) {
    let focus = app.focused();
    let ids = app.tab().panes();
    for (id, rect) in &app.rects {
        let n = ids.iter().position(|p| p == id).unwrap_or(0) + app.pane_base_index;
        let color = if Some(*id) == focus { theme::TMUX_DISPLAY_PANES_ACTIVE } else { theme::TMUX_DISPLAY_PANES };
        big(buf, &n.to_string(), *rect, color);
    }
}

/// clock-mode (C-b t): the time, big, in blue, on a cleared pane.
fn clock(buf: &mut Buffer, rect: Rect) {
    for y in rect.y..rect.y + rect.height { for x in rect.x..rect.x + rect.width { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } } }
    let (time, _) = local_time(crate::app::utc_offset());
    big(buf, &time, rect, Color::Blue);
}

/// Copy mode's position, top right, in mode-style: `[offset/history]`.
fn copy_indicator(buf: &mut Buffer, pane: &Pane, content: Rect) {
    let grid = pane.term.grid();
    let text = format!("[{}/{}]", grid.display_offset(), grid.history_size());
    let x = (content.x + content.width).saturating_sub(text.width() as u16);
    buf.set_string(x, content.y, &text, Style::default().bg(Color::Yellow).fg(Color::Black));
}

fn clip(text: &str, cols: usize) -> String {
    if text.width() <= cols { return text.to_string() }
    let mut out = String::new();
    for ch in text.chars() {
        if out.width() + unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0) + 1 > cols { break }
        out.push(ch);
    }
    out.push('…');
    out
}

fn clip_spans(spans: Vec<Span<'static>>, cols: usize) -> Line<'static> {
    let mut out = Vec::new();
    let mut used = 0;
    for s in spans {
        if used >= cols { break }
        let room = cols - used;
        let text = if s.content.width() > room { clip(&s.content, room) } else { s.content.to_string() };
        used += text.width();
        out.push(Span::styled(text, s.style));
    }
    Line::from(out)
}

pub fn tab_at(app: &App, x: u16) -> Option<usize> {
    app.tab_hits.iter().find(|(_, from, to)| x >= *from && x < *to).map(|(i, _, _)| *i)
}

pub fn keys_for(app: &App, command: &str) -> String { app.keymap.hint(command).unwrap_or_default() }

#[allow(dead_code)]
fn _unused(_: &keys::Keymap, _: PromptKind) {}

#[allow(dead_code)]
fn _ago(ms: u64) -> String { ago(ms) }


fn map_color(color: AColor, colors: &alacritty_terminal::term::color::Colors, fg_side: bool) -> (Color, bool) {
    match color {
        AColor::Spec(rgb) => (Color::Rgb(rgb.r, rgb.g, rgb.b), false),
        AColor::Indexed(i) => (colors[i as usize].map(|c| Color::Rgb(c.r, c.g, c.b)).unwrap_or(Color::Indexed(i)), false),
        AColor::Named(named) => {
            let index = named as usize;
            if let Some(c) = colors[index] { return (Color::Rgb(c.r, c.g, c.b), false) }
            match named {
                NamedColor::Foreground | NamedColor::BrightForeground | NamedColor::Background | NamedColor::Cursor => (Color::Reset, false),
                NamedColor::DimForeground => (Color::Reset, fg_side),
                n if (n as usize) < 16 => (Color::Indexed(n as u8), false),
                n if (n as usize) >= NamedColor::DimBlack as usize && (n as usize) <= NamedColor::DimWhite as usize => (Color::Indexed((n as usize - NamedColor::DimBlack as usize) as u8), true),
                _ => (Color::Reset, false),
            }
        }
    }
}

/// The pane's terminal, cell for cell. Returns where the cursor goes when this pane has it.
fn pane_body(buf: &mut Buffer, pane: &mut Pane, area: Rect, active: bool, window: (Option<Color>, Option<Color>)) -> Option<Position> {
    if let Some(bg) = window.1 { buf.set_style(area, Style::default().bg(bg)) }
    match &pane.phase {
        Phase::Connecting(note) => { card(buf, area, &[(note.clone(), Style::default().add_modifier(Modifier::DIM))]); return None }
        Phase::Card { title, detail, keys } => {
            let mut lines = vec![(title.clone(), Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))];
            for row in detail.lines() { lines.push((row.to_string(), Style::default())) }
            lines.push((String::new(), Style::default()));
            lines.push((keys.iter().map(|(k, w)| format!("{k}: {w}")).collect::<Vec<_>>().join("   "), Style::default().add_modifier(Modifier::DIM)));
            card(buf, area, &lines);
            return None;
        }
        _ => {}
    }
    let content = pane.term.renderable_content();
    // A far terminal taller than this tile (a watcher cannot resize it; a resize not answered
    // yet): keep its cursor in view, as a terminal does — for an agent, that is its prompt.
    let cursor_view = content.cursor.point.line.0 + content.display_offset as i32;
    let spare = (pane.rows as i32 - area.height as i32).max(0);
    let shift = if content.display_offset > 0 { 0 } else { (cursor_view - area.height as i32 + 1).clamp(0, spare) };
    let offset = content.display_offset as i32 - shift;
    let colors = content.colors;
    let mode = content.mode;
    let cursor_point = content.cursor.point;
    let selection = content.selection;
    for indexed in content.display_iter {
        let row = indexed.point.line.0 + offset;
        let col = indexed.point.column.0 as u16;
        if row < 0 || row as u16 >= area.height || col >= area.width { continue }
        let cell = indexed.cell;
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) { continue }
        let (mut fg_color, dim_fg) = map_color(cell.fg, colors, true);
        let (mut bg_color, _) = map_color(cell.bg, colors, false);
        if fg_color == Color::Reset { if let Some(c) = window.0 { fg_color = c } }
        if bg_color == Color::Reset { if let Some(c) = window.1 { bg_color = c } }
        let mut style = Style::default();
        let mut mods = Modifier::empty();
        if cell.flags.contains(Flags::BOLD) { mods |= Modifier::BOLD }
        if cell.flags.contains(Flags::ITALIC) { mods |= Modifier::ITALIC }
        if cell.flags.intersects(Flags::ALL_UNDERLINES) { mods |= Modifier::UNDERLINED }
        if cell.flags.contains(Flags::DIM) || dim_fg { mods |= Modifier::DIM }
        if cell.flags.contains(Flags::STRIKEOUT) { mods |= Modifier::CROSSED_OUT }
        if cell.flags.contains(Flags::INVERSE) {
            std::mem::swap(&mut fg_color, &mut bg_color);
            if fg_color == Color::Reset && bg_color == Color::Reset { mods |= Modifier::REVERSED }
            else {
                if fg_color == Color::Reset { fg_color = Color::Black }
                if bg_color == Color::Reset { bg_color = Color::White }
            }
        }
        style = style.fg(fg_color).bg(bg_color).add_modifier(mods);
        // tmux mode-style: selections are yellow on black.
        if selection.map(|r| r.contains(indexed.point)).unwrap_or(false) { style = style.bg(Color::Yellow).fg(Color::Black) }
        let target = buf.cell_mut((area.x + col, area.y + row as u16));
        let Some(target) = target else { continue };
        if cell.flags.contains(Flags::HIDDEN) || cell.c == '\0' {
            target.set_symbol(" ").set_style(style);
            continue;
        }
        match cell.zerowidth() {
            Some(extra) if !extra.is_empty() => {
                let mut s = String::with_capacity(8);
                s.push(cell.c);
                s.extend(extra.iter());
                target.set_symbol(&s).set_style(style);
            }
            _ => { target.set_char(cell.c).set_style(style); }
        }
    }
    // Local echo, drawn over the grid: underlined until the far side confirms it.
    for (col, row, c, _) in &pane.predictions {
        let row = (*row as i32 - shift).max(0) as u16;
        if let Some(cell) = buf.cell_mut((area.x + col, area.y + row)) {
            if *col < area.width && row < area.height { cell.set_char(*c).set_style(Style::default().add_modifier(Modifier::UNDERLINED)); }
        }
    }
    if pane.scrolled() > 0 || !active { return None }
    if let Some((col, row, _, _)) = pane.predictions.last() {
        let row = (*row as i32 - shift).max(0) as u16;
        if col + 1 < area.width && row < area.height { return Some(Position::new(area.x + col + 1, area.y + row)) }
    }
    if !mode.contains(TermMode::SHOW_CURSOR) || matches!(pane.phase, Phase::Watching(_)) { return None }
    let row = cursor_point.line.0 + offset;
    let col = cursor_point.column.0 as u16;
    (row >= 0 && (row as u16) < area.height && col < area.width).then(|| Position::new(area.x + col, area.y + row as u16))
}

fn card(buf: &mut Buffer, area: Rect, lines: &[(String, Style)]) {
    let top = area.y + area.height.saturating_sub(lines.len() as u16) / 2;
    for (index, (text, style)) in lines.iter().enumerate() {
        let y = top + index as u16;
        if y >= area.y + area.height { break }
        let w = (text.width() as u16).min(area.width);
        let x = area.x + area.width.saturating_sub(w) / 2;
        buf.set_stringn(x, y, text, area.width as usize, *style);
    }
}


