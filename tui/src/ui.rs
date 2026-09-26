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
    app.renumber();
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
        if let Some(area) = picker_preview_area(fzf_inner(body), picker) { preview(buf, app, kind, picker, area) }
    }
    if let Some(Modal::Tree { cursor: at, collapsed }) = &app.modal { tree(buf, app, body, *at, collapsed) }
    let popup = match &app.modal { Some(Modal::Popup { pane, width, height, title }) => Some((*pane, *width, *height, title.clone())), _ => None };
    if let Some((pane, width, height, title)) = popup {
        // tmux's popup: a single-line box in the middle, the program inside.
        let (w, h) = (width.min(body.width), height.min(body.height));
        let area = Rect::new(body.x + (body.width - w) / 2, body.y + (body.height - h) / 2, w, h);
        for y in area.y..area.y + h { for x in area.x..area.x + w { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } } }
        let border = Style::default();
        for x in area.x..area.x + w { buf.set_string(x, area.y, "─", border); buf.set_string(x, area.y + h - 1, "─", border) }
        for y in area.y..area.y + h { buf.set_string(area.x, y, "│", border); buf.set_string(area.x + w - 1, y, "│", border) }
        buf.set_string(area.x, area.y, "┌", border); buf.set_string(area.x + w - 1, area.y, "┐", border);
        buf.set_string(area.x, area.y + h - 1, "└", border); buf.set_string(area.x + w - 1, area.y + h - 1, "┘", border);
        if !title.is_empty() { buf.set_stringn(area.x + 2, area.y, format!(" {title} "), w.saturating_sub(4) as usize, border); }
        let inner = Rect::new(area.x + 1, area.y + 1, w.saturating_sub(2), h.saturating_sub(2));
        if let Some(p) = app.panes.get_mut(&pane) { cursor = pane_body(buf, p, inner, true, (None, None)); }
    }
    if let Some(Modal::Menu { title, items, cursor }) = &app.modal { menu(buf, body, title, items, *cursor) }
    if app.prefix && app.prefix_at.map(|t| t.elapsed() >= Duration::from_millis(app.keymap.hint_ms)).unwrap_or(false) { which_key(buf, app, body) }
    // `set -g status off`: no status line — a prompt or a message still borrows the last row.
    let hidden = app.opts.status == Some(false);
    let speaking = matches!(app.modal, Some(Modal::Prompt(_)) | Some(Modal::Confirm { .. }) | Some(Modal::Find { .. })) || app.toast.as_ref().map(|(_, _, at)| at.elapsed() < Duration::from_millis(app.display_ms)).unwrap_or(false);
    if !hidden || speaking { if let Some(pos) = status_line(buf, app, status) { cursor = Some(pos) } }
    if let Some(pos) = cursor { frame.set_cursor_position(pos) }
}

/// tmux's display-menu: a box in the middle, the title in its top border, `Label  (k)` rows, the
/// chosen one in menu-selected-style (yellow on black), disabled ones dim, '' a rule across.
fn menu(buf: &mut Buffer, body: Rect, title: &str, items: &[crate::modal::MenuItem], cursor: usize) {
    let row_w = items.iter().filter(|it| !it.separator).map(|it| it.label.width() + if it.key.is_empty() { 0 } else { it.key.width() + 4 }).max().unwrap_or(0);
    let w = (row_w.max(title.width() + 2) as u16 + 4).min(body.width);
    let h = (items.len() as u16 + 2).min(body.height);
    let area = Rect::new(body.x + (body.width - w) / 2, body.y + (body.height - h) / 2, w, h);
    for y in area.y..area.y + h { for x in area.x..area.x + w { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } } }
    let border = Style::default();
    let (x1, y1) = (area.x + w - 1, area.y + h - 1);
    for x in area.x..=x1 { buf.set_string(x, area.y, "─", border); buf.set_string(x, y1, "─", border) }
    for y in area.y..=y1 { buf.set_string(area.x, y, "│", border); buf.set_string(x1, y, "│", border) }
    buf.set_string(area.x, area.y, "┌", border); buf.set_string(x1, area.y, "┐", border);
    buf.set_string(area.x, y1, "└", border); buf.set_string(x1, y1, "┘", border);
    if !title.is_empty() {
        let t = clip(&format!(" {title} "), w.saturating_sub(2) as usize);
        buf.set_string(area.x + (w - t.width() as u16) / 2, area.y, &t, border);
    }
    let inner = w.saturating_sub(2) as usize;
    for (i, it) in items.iter().enumerate().take(h.saturating_sub(2) as usize) {
        let y = area.y + 1 + i as u16;
        if it.separator {
            buf.set_string(area.x, y, "├", border);
            for x in area.x + 1..x1 { buf.set_string(x, y, "─", border) }
            buf.set_string(x1, y, "┤", border);
            continue;
        }
        let key = if it.key.is_empty() { String::new() } else { format!("({})", it.key) };
        let gap = inner.saturating_sub(it.label.width() + key.width() + 2);
        let text = format!(" {}{}{} ", it.label, " ".repeat(gap), key);
        let style = if i == cursor && !it.disabled { Style::default().bg(Color::Yellow).fg(Color::Black) } else if it.disabled { Style::default().add_modifier(Modifier::DIM) } else { Style::default() };
        buf.set_stringn(area.x + 1, y, clip(&text, inner), inner, style);
    }
}

/// A pause after the prefix: every key that can come next, from the live table (your binds too),
/// in a box over the bottom of the window — tmux's keys, with the hint zellij users praise.
fn which_key(buf: &mut Buffer, app: &App, body: Rect) {
    let mut items: Vec<(String, String)> = Vec::new();
    let mut digits = false;
    for b in &app.keymap.prefix_table {
        let key = crate::keys::name(&b.chord);
        if b.command.starts_with("select-window -t ") && key.len() == 1 && key.chars().all(|c| c.is_ascii_digit()) { digits = true; continue }
        let what = if b.note.is_empty() { b.command.clone() } else { b.note.clone() };
        items.push((key, what));
    }
    if digits { items.insert(0, ("0-9".into(), "Select window 0 to 9".into())) }
    let key_w = items.iter().map(|(k, _)| k.width()).max().unwrap_or(1).min(8);
    let col_w: usize = key_w + if body.width >= 150 { 44 } else { 32 };
    let cols = ((body.width as usize).saturating_sub(4) / col_w).max(1);
    let rows_needed = items.len().div_ceil(cols);
    let height = (rows_needed as u16 + 2).min(body.height);
    let area = Rect::new(body.x, body.y + body.height - height, body.width, height);
    for y in area.y..area.y + area.height { for x in area.x..area.x + area.width { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } } }
    let border = Style::default();
    for x in area.x..area.x + area.width { buf.set_string(x, area.y, "─", border); buf.set_string(x, area.y + area.height - 1, "─", border) }
    for y in area.y..area.y + area.height { buf.set_string(area.x, y, "│", border); buf.set_string(area.x + area.width - 1, y, "│", border) }
    buf.set_string(area.x, area.y, "┌", border); buf.set_string(area.x + area.width - 1, area.y, "┐", border);
    buf.set_string(area.x, area.y + area.height - 1, "└", border); buf.set_string(area.x + area.width - 1, area.y + area.height - 1, "┘", border);
    let title = format!(" {} ", crate::keys::name(&app.keymap.prefix));
    buf.set_string(area.x + 2, area.y, &title, Style::default().add_modifier(Modifier::BOLD));
    let inner_rows = area.height.saturating_sub(2) as usize;
    // Column-major, like ls: read down, then across.
    let fits = cols * inner_rows.max(1);
    if items.len() > fits && fits > 0 {
        // Say there is more, bottom right of the box (C-b ? has them all).
        let more = format!(" +{} more — {} ? ", items.len() - fits + 1, crate::keys::name(&app.keymap.prefix));
        let mx = (area.x + area.width).saturating_sub(more.width() as u16 + 2);
        buf.set_string(mx, area.y + area.height - 1, &more, Style::default().add_modifier(Modifier::DIM));
    }
    for (i, (key, what)) in items.iter().enumerate() {
        let (col, row) = (i / inner_rows.max(1), i % inner_rows.max(1));
        if col >= cols || (items.len() > fits && i + 1 >= fits) { break }
        let x = area.x + 2 + (col * col_w) as u16;
        let y = area.y + 1 + row as u16;
        buf.set_string(x, y, format!("{key:>key_w$}"), Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD));
        let room = col_w - key_w - 3;
        buf.set_stringn(x + key_w as u16 + 1, y, clip(what, room), room, Style::default());
    }
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
        let contents: Vec<Rect> = rects.iter().map(|(_, r)| Rect::new(r.x, r.y + hdr, r.width, r.height.saturating_sub(hdr))).collect();
        junctions(buf, body, &contents);
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
    // Your pane-border-format, if tmux.conf has one.
    if let Some(fmt) = &app.opts.pane_border_format {
        let line = clip_spans(crate::format::spans_for_pane(app, fmt, app.active, id, style), rect.width.saturating_sub(1) as usize);
        buf.set_line(rect.x + 1, rect.y, &line, rect.width.saturating_sub(1));
        return;
    }
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
    if app.marked == Some(pane.id) { return Some(Span::styled("[marked]", Style::default().add_modifier(Modifier::REVERSED))) }
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
fn junctions(buf: &mut Buffer, body: Rect, contents: &[Rect]) {
    // Only border cells join: a pane's own `────` touching a seam is the pane's business.
    let inside = |x: u16, y: u16| contents.iter().any(|r| r.contains(Position::new(x, y)));
    let sym = |buf: &Buffer, x: u16, y: u16| -> String { if inside(x, y) { String::new() } else { buf.cell((x, y)).map(|c| c.symbol().to_string()).unwrap_or_default() } };
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
            // Narrow: the machine goes before the title gives way (then the age).
            let right = if width < 56 { String::new() } else { format!("{}{}", if many && width >= 70 { format!("{}  ", app.fleet.machine_name(m)) } else { String::new() }, ago(agent.recency())) };
            let detail = agent.question.as_ref().map(|q| (q.prompt.clone(), theme::ATTENTION)).unwrap_or((if agent.project.is_empty() { agent.cwd.clone() } else { agent.project.clone() }, theme::MUTED));
            let name_w = if width < 56 { (width as usize).saturating_sub(10).min(28) } else { 28 };
            // Widths are display widths: a CJK or emoji title keeps the columns straight.
            let name = clip(&agent.name, name_w);
            let name = format!("{name}{}", " ".repeat(name_w.saturating_sub(name.width())));
            let detail_room = (width as usize).saturating_sub(name_w + right.width() + 12);
            let detail_text = clip(&detail.0, detail_room);
            let used = 2 + 2 + 2 + name_w + 2 + detail_text.width();
            let pad = (width as usize).saturating_sub(used + right.width());
            let selected = index == app.home_cursor;
            // The chosen row as fzf draws its current line (reverse video where there is no colour).
            let bg = match (selected, theme::fzf().bw) { (true, true) => Style::default().add_modifier(Modifier::REVERSED), (true, false) => Style::default().bg(theme::fzf().bg_plus), _ => Style::default() };
            let tint = |c: Color| if c == theme::MUTED || c == theme::SOFT { bg.add_modifier(Modifier::DIM) } else { bg.fg(theme::paint(c)) };
            lines.push(Line::from(vec![
                Span::styled(format!("{} ", index + 1), tint(theme::ACCENT)),
                Span::styled(format!("{dot} "), tint(color)),
                Span::styled(format!("{mark} "), tint(mark_color)),
                Span::styled(format!("{name}  "), bg.add_modifier(Modifier::BOLD)),
                Span::styled(detail_text, tint(detail.1)),
                Span::styled(" ".repeat(pad), bg),
                Span::styled(right, tint(theme::MUTED)),
            ]));
        }
    }
    lines.push(Line::raw(""));
    let keys = [("enter", "open"), ("p", "harnesses"), ("o", "projects"), ("n", "new"), ("t", "terminal"), ("i", "models"), ("I", "needs input"), ("m", "machines"), ("s", "store"), (">", "commands"), ("?", "help")];
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
    // NO_COLOR (and no colours of your own): reverse video carries the status line and messages.
    let plain = theme::no_color() && app.look.status_bg.is_none() && app.look.message_bg.is_none();
    let yellow = if plain { Style::default().add_modifier(Modifier::REVERSED) } else { Style::default().bg(app.look.message_bg.unwrap_or(theme::TMUX_MESSAGE_BG)).fg(app.look.message_fg.unwrap_or(theme::TMUX_MESSAGE_FG)) };
    let prompt_like: Option<(String, String, usize, String)> = match &app.modal {
        Some(Modal::Prompt(p)) => {
            let shown: String = if p.secret { "*".repeat(p.value.chars().count()) } else { p.value.clone() };
            Some((p.label.clone(), shown, p.cursor, p.hint.clone()))
        }
        Some(Modal::Confirm { prompt, .. }) => Some((format!("{prompt} "), String::new(), 0, String::new())),
        Some(Modal::Find { query, found, up, .. }) => Some((if *up { "(search up) ".into() } else { "(search down) ".into() }, query.clone(), query.chars().count(), if *found == Some(false) && !query.is_empty() { "no match".into() } else { String::new() })),
        _ => None,
    };
    if let Some((mut label, value, cursor, hint)) = prompt_like {
        if !label.ends_with(' ') && label != ":" { label.push(' ') }
        buf.set_style(rect, yellow);
        buf.set_string(rect.x, rect.y, &label, yellow);
        let x0 = rect.x + label.width() as u16;
        let room = rect.width.saturating_sub(label.width() as u16 + 1) as usize;
        // Keep the cursor in view on a long line.
        let before: String = value.chars().take(cursor).collect();
        let skip = before.width().saturating_sub(room);
        let visible: String = { let mut w = 0; value.chars().skip_while(|c| { let cw = unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0); if w < skip { w += cw; true } else { false } }).collect() };
        buf.set_stringn(x0, rect.y, &visible, room, yellow);
        // The terminal's own cursor sits in the prompt, as in tmux: it blinks, it has your shape.
        let cx = (x0 + before.width().saturating_sub(skip) as u16).min(rect.x + rect.width - 1);
        if !hint.is_empty() {
            let used = label.width() + value.width() + 3;
            if used + hint.width() < rect.width as usize {
                buf.set_string(rect.x + rect.width - hint.width() as u16 - 1, rect.y, &hint, yellow.add_modifier(Modifier::DIM));
            }
        }
        return Some(Position::new(cx, rect.y));
    }
    if let Some((text, _, at)) = &app.toast {
        if at.elapsed() < Duration::from_millis(app.display_ms) {
            buf.set_style(rect, yellow);
            buf.set_stringn(rect.x, rect.y, clip(text, rect.width as usize), rect.width as usize, yellow);
            return None;
        }
    }
    let base = if plain { Style::default().add_modifier(Modifier::REVERSED) } else { Style::default().bg(app.look.status_bg.unwrap_or(theme::TMUX_STATUS_BG)).fg(app.look.status_fg.unwrap_or(theme::TMUX_STATUS_FG)) };
    buf.set_style(rect, base);
    // status-left: tmux's "[#S] " — here this computer's name, the session a window lives in — or
    // the tmux.conf's own format, cut to status-left-length (10, as tmux).
    let host = app.session_name();
    let host: String = host.chars().take(12).collect();
    let left: Line<'static> = match &app.opts.status_left {
        Some(fmt) => clip_spans(crate::format::spans(app, fmt, None, base), app.opts.status_left_length.unwrap_or(10)),
        // While the prefix waits for its key, the name shows it (reversed), the one thing tmux users add first.
        None => Line::from(Span::styled(format!("[{host}] "), if app.prefix { base.add_modifier(Modifier::REVERSED) } else { base })),
    };
    let left_w = left.width() as u16;
    buf.set_line(rect.x, rect.y, &left, rect.width);
    let (clock, date) = local_time(app.utc_offset_secs);
    let current_w = window_entry(app, app.active, 24).0.width() as u16 + 1;
    let right: Vec<Span<'static>> = match &app.opts.status_right {
        Some(fmt) => {
            let cap = app.opts.status_right_length.unwrap_or(40).min(rect.width.saturating_sub(left_w + current_w + 1) as usize);
            keep_tail(crate::format::spans(app, fmt, None, base), cap)
        }
        None => {
            // status-right: "#{=21:pane_title}" %H:%M %d-%b-%y, with the harnesses waiting on you before it.
            let title = crate::input::focused_title(app);
            let title: String = if title.is_empty() { host.clone() } else { title.chars().take(21).collect() };
            let machine = app.focused().and_then(|f| app.panes.get(&f)).filter(|p| p.machine_id != app.fleet.local_id).map(|p| app.fleet.machine_name(&p.machine_id));
            let mut right: Vec<Span<'static>> = Vec::new();
            let waiting = app.fleet.waiting();
            if app.daemon_down { right.push(Span::styled("daemon down ", base.add_modifier(Modifier::REVERSED))); right.push(Span::styled(" ", base)) }
            if waiting > 0 { right.push(Span::styled(format!("{waiting} waiting"), base.add_modifier(Modifier::REVERSED))); right.push(Span::styled(" ", base)) }
            if app.focused().and_then(|f| app.panes.get(&f)).map(|p| matches!(p.phase, Phase::Watching(_))).unwrap_or(false) && app.rects.len() < 2 {
                right.push(Span::styled("[watching] ", base));
            }
            let who = match machine { Some(m) => format!("\"{title}\" {m} "), None => format!("\"{title}\" ") };
            right.push(Span::styled(who, base));
            // tim, before the clock.
            if let Some((f, st)) = crate::tim::face(app) { right.push(Span::styled(f, base.patch(st))); right.push(Span::styled(" ", base)) }
            right.push(Span::styled(format!("{clock} {date}"), base));
            // tmux's status-right-length is 40 (60 here: a waiting count, a far machine), and the
            // window list comes first. Too long: the pane title goes first, then the date, then
            // what is left is cut from the left, so the clock stays.
            let cap = 60u16.min(rect.width.saturating_sub(left_w + current_w + 1));
            let width = |r: &Vec<Span<'static>>| r.iter().map(|s| s.content.width()).sum::<usize>();
            if width(&right) > cap as usize && right.len() >= 2 { let at = right.len() - 2; right.remove(at); }
            if width(&right) > cap as usize { if let Some(last) = right.last_mut() { *last = Span::styled(clock.clone(), base) } }
            keep_tail(right, cap as usize)
        }
    };
    let right_line = Line::from(right);
    let right_w = right_line.width() as u16;
    let right_x = rect.x + rect.width - right_w;
    buf.set_line(right_x, rect.y, &right_line, right_w);
    // The window list, scrolled with < and > when it does not fit (as tmux does).
    let list_x = rect.x + left_w;
    let list_end = right_x.saturating_sub(1);
    let room = list_end.saturating_sub(list_x);
    let sep = app.opts.window_status_separator.clone().unwrap_or_else(|| " ".into());
    let sep_w = sep.width() as u16;
    let custom = app.opts.window_status_format.is_some() || app.opts.window_status_current_format.is_some();
    let entry = |app: &App, i: usize, max: usize| -> Vec<Span<'static>> {
        if custom {
            let current = i == app.active;
            let fmt = if current { app.opts.window_status_current_format.clone() } else { None }.or_else(|| app.opts.window_status_format.clone()).unwrap_or_else(|| "#I:#W#F".into());
            let paint = |(fg, bg): (Option<Color>, Option<Color>)| { let mut st = base; if let Some(c) = fg { st = st.fg(c) } if let Some(c) = bg { st = st.bg(c) } st };
            let style = match (current, app.opts.window_status_current_style, app.opts.window_status_style) { (true, Some(c), _) => paint(c), (false, _, Some(c)) => paint(c), _ => base };
            crate::format::spans(app, &fmt, Some(i), style)
        } else {
            let (text, alert) = window_entry(app, i, max);
            vec![Span::styled(text, if alert { base.add_modifier(Modifier::REVERSED) } else { base })]
        }
    };
    let width_of = |e: &Vec<Span<'static>>| e.iter().map(|s| s.content.width() as u16).sum::<u16>();
    // Harness titles are long where tmux's names are short: the other windows give way first.
    let mut entries: Vec<Vec<Span<'static>>> = (0..app.tabs.len()).map(|i| entry(app, i, 24)).collect();
    if !custom {
        for short in [16, 10, 6] {
            if entries.iter().map(|e| width_of(e) + sep_w).sum::<u16>() <= room { break }
            entries = (0..app.tabs.len()).map(|i| entry(app, i, if i == app.active { 24 } else { short })).collect();
        }
    }
    let widths: Vec<u16> = entries.iter().map(|e| width_of(e) + sep_w).collect();
    let mut first = 0;
    if widths[..=app.active].iter().sum::<u16>() > room {
        while first < app.active && widths[first..=app.active].iter().sum::<u16>() > room.saturating_sub(2) { first += 1 }
    }
    let mut x = list_x;
    // status-justify: the list in the middle (centre, absolute-centre) or at the right.
    let total: u16 = widths[first..].iter().sum();
    if total < room {
        match app.opts.status_justify.as_deref() {
            Some("centre") => x = list_x + (room - total) / 2,
            Some("absolute-centre") => x = (rect.x + rect.width.saturating_sub(total) / 2).max(list_x),
            Some("right") => x = list_end.saturating_sub(total),
            _ => {}
        }
    }
    if first > 0 { buf.set_string(x, rect.y, "<", base); x += 1 }
    app.tab_hits.clear();
    for (i, e) in entries.into_iter().enumerate().skip(first) {
        let w = width_of(&e);
        if x + w + 1 > list_end {
            // The current window always shows, cut to fit if it must.
            if i == app.active && list_end > x + 1 {
                buf.set_line(x, rect.y, &clip_spans(e, (list_end - x) as usize), list_end - x);
                app.tab_hits.push((i, x, list_end));
            } else { buf.set_string(list_end.saturating_sub(1).max(x), rect.y, ">", base) }
            break
        }
        buf.set_line(x, rect.y, &Line::from(e), w);
        app.tab_hits.push((i, x, x + w));
        x += w;
        if x + sep_w <= list_end { buf.set_string(x, rect.y, &sep, base) }
        x += sep_w;
    }
    None
}

/// The last `width` columns of some spans.
fn keep_tail(spans: Vec<Span<'static>>, width: usize) -> Vec<Span<'static>> {
    let mut out = Vec::new();
    let mut room = width;
    for span in spans.into_iter().rev() {
        if room == 0 { break }
        let w = span.content.width();
        if w <= room { room -= w; out.push(span); continue }
        let mut tail: Vec<char> = Vec::new();
        let mut used = 0;
        for c in span.content.chars().rev() {
            let cw = unicode_width::UnicodeWidthChar::width(c).unwrap_or(0);
            if used + cw > room { break }
            used += cw;
            tail.push(c);
        }
        // A part that does not fit goes whole (a clock, not half a title); only the last part is cut.
        let tail: String = if out.is_empty() { tail.into_iter().rev().collect() } else { String::new() };
        let pad = room - tail.width();
        out.push(Span::styled(format!("{}{tail}", " ".repeat(pad)), span.style));
        room = 0;
    }
    out.reverse();
    out
}

/// `#I:#W#{window_flags}` — `*` current, `-` last, `Z` zoomed, `!` a harness is waiting on you
/// (tmux's bell flag), `#` one finished (activity). The bool: draw it reversed, as tmux does alerts.
fn window_entry(app: &App, index: usize, max: usize) -> (String, bool) {
    let tab = &app.tabs[index];
    let name = clip(&tab.name, max);
    let flags = crate::format::flags(app, index);
    let alert = flags.contains('!') || flags.contains('#');
    (format!("{}:{}{}", app.win_num(index), name, flags), alert && index != app.active)
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

/// FZF_DEFAULT_OPTS --border: the lists' box (rounded, sharp, bold, double, horizontal, vertical,
/// top, bottom, left, right, none), drawn in the border colour; the list lives inside it.
fn fzf_inner(body: Rect) -> Rect {
    let Some(style) = theme::fzf_opts().border.as_deref() else { return body };
    let (t, b, l, r) = match style { "none" => (0, 0, 0, 0), "horizontal" => (1, 1, 0, 0), "vertical" => (0, 0, 1, 1), "top" => (1, 0, 0, 0), "bottom" => (0, 1, 0, 0), "left" => (0, 0, 1, 0), "right" => (0, 0, 0, 1), _ => (1, 1, 1, 1) };
    Rect::new(body.x + l, body.y + t, body.width.saturating_sub(l + r), body.height.saturating_sub(t + b))
}

fn fzf_border(buf: &mut Buffer, body: Rect) {
    let Some(style) = theme::fzf_opts().border.clone() else { return };
    let st = Style::default().fg(theme::fzf().border);
    let (h, v, tl, tr, bl, br) = match style.as_str() {
        "sharp" => ("─", "│", "┌", "┐", "└", "┘"), "bold" => ("━", "┃", "┏", "┓", "┗", "┛"), "double" => ("═", "║", "╔", "╗", "╚", "╝"),
        "block" | "thinblock" => ("▀", "█", "█", "█", "█", "█"), _ => ("─", "│", "╭", "╮", "╰", "╯"),
    };
    let (top, bottom, left, right) = match style.as_str() { "none" => (false, false, false, false), "horizontal" => (true, true, false, false), "vertical" => (false, false, true, true), "top" => (true, false, false, false), "bottom" => (false, true, false, false), "left" => (false, false, true, false), "right" => (false, false, false, true), _ => (true, true, true, true) };
    if body.width < 2 || body.height < 2 { return }
    let (x1, y1) = (body.x + body.width - 1, body.y + body.height - 1);
    if top { for x in body.x..=x1 { buf.set_string(x, body.y, h, st) } }
    if bottom { for x in body.x..=x1 { buf.set_string(x, y1, h, st) } }
    if left { for y in body.y..=y1 { buf.set_string(body.x, y, v, st) } }
    if right { for y in body.y..=y1 { buf.set_string(x1, y, v, st) } }
    if top && left { buf.set_string(body.x, body.y, tl, st) }
    if top && right { buf.set_string(x1, body.y, tr, st) }
    if bottom && left { buf.set_string(body.x, y1, bl, st) }
    if bottom && right { buf.set_string(x1, y1, br, st) }
}

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
    fzf_border(buf, body);
    let body = fzf_inner(body);
    // --color=bg: the list's own background, under everything drawn on it.
    if let Some(bg) = theme::fzf_opts().bg { buf.set_style(body, Style::default().bg(bg)) }
    let preview = picker_preview_area(body, picker);
    let area = match preview { Some(p) => Rect::new(body.x, body.y, p.x - body.x, body.height), None => body };
    let width = area.width as usize;
    let bottom = area.y + area.height;
    // Prompt, then info, then the header (the keys), then the list above — or, with
    // `--layout=reverse` in FZF_DEFAULT_OPTS, all of it top-down.
    let reverse = theme::fzf().reverse;
    let o = theme::fzf_opts();
    // --layout=reverse puts the prompt on top; reverse-list keeps it at the bottom, rows top-down.
    let prompt_top = o.prompt_top;
    // --info: default (its own line), inline (after the query), inline-right (right of the
    // prompt, the rule on its own line), right (its own line, the count at the right), hidden.
    let mode = o.info_mode.as_str();
    let info_own_line = matches!(mode, "default" | "right" | "inline-right");
    let (prompt_y, info_y) = if prompt_top { (area.y, if info_own_line { area.y + 1 } else { area.y }) } else { (bottom - 1, if info_own_line { bottom.saturating_sub(2) } else { bottom - 1 }) };
    // Rows come first in a short window, as in fzf: the key hints go before any row does.
    let header = if area.height >= 6 { header_line(picker, kind, width.saturating_sub(1)) } else { None };
    // --header-first (reverse): the header above the prompt.
    let header_first = o.header_first && prompt_top && header.is_some();
    let (prompt_y, info_y) = if header_first { (prompt_y + 1, info_y + 1) } else { (prompt_y, info_y) };
    let edge = if prompt_top { prompt_y.max(info_y) } else { prompt_y.min(info_y) };
    let header_y = if header_first { area.y } else if header.is_some() { if prompt_top { edge + 1 } else { edge.saturating_sub(1) } } else if prompt_top { edge } else { edge };
    let prompt = Style::default().fg(theme::fzf().prompt);
    let prompt_text = theme::fzf().prompt_text.clone();
    let pw = prompt_text.width() as u16;
    // The glyph bold in the prompt colour; its trailing space plain, as fzf draws it.
    let glyph = prompt_text.trim_end();
    buf.set_string(area.x, prompt_y, glyph, prompt.add_modifier(Modifier::BOLD));
    let q_room = width.saturating_sub(pw as usize + 1);
    // A query longer than the line scrolls to keep the cursor in view, as fzf's does.
    let before: String = picker.query.chars().take(picker.qcursor).collect();
    let skip = before.width().saturating_sub(q_room);
    let shown: String = { let mut w = 0; picker.query.chars().skip_while(|c| { let cw = unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0); if w < skip { w += cw; true } else { false } }).collect() };
    buf.set_stringn(area.x + pw, prompt_y, &shown, q_room, Style::default().add_modifier(Modifier::BOLD));
    let mut typed_w = shown.width().min(q_room) as u16;
    if picker.query.is_empty() && !picker.placeholder.is_empty() {
        // The placeholder (fzf's --ghost), whole scopes only, leaving an inline count its place.
        let room = if mode.starts_with("inline") { q_room.saturating_sub(16) } else { q_room };
        let mut text = String::new();
        for part in picker.placeholder.split("   ") { if text.width() + part.width() + 3 > room { break } if !text.is_empty() { text.push_str("   ") } text.push_str(part) }
        buf.set_stringn(area.x + pw, prompt_y, &text, q_room, Style::default().add_modifier(Modifier::DIM));
        typed_w = text.width() as u16;
    }
    let cursor = Position::new(area.x + pw + (before.width().saturating_sub(skip) as u16).min(q_room as u16), prompt_y);
    let total = picker.rows.iter().filter(|r| !r.disabled).count();
    let mut count = format!("{}/{}", picker.visible.len(), total);
    if !picker.marked.is_empty() || matches!(kind, PickerKind::Open { .. }) { count.push_str(&format!(" ({})", picker.marked.len())) }
    let info_style = Style::default().fg(theme::fzf().info);
    let rule = |buf: &mut Buffer, from: u16, to: u16, y: u16| {
        if !o.separator || to <= from { return }
        let ch = o.separator_char.clone();
        let n = (to - from) as usize / ch.width().max(1);
        buf.set_string(from, y, ch.repeat(n), Style::default().fg(theme::fzf().border));
    };
    let gap = if preview.is_some() { 2 } else { 1 };
    let end = (area.x + area.width).saturating_sub(gap);
    match mode {
        "hidden" => {}
        "inline" => {
            // `> query  < 3/6 (0) ────`: the rule runs on to the edge.
            let x = area.x + pw + typed_w + 1;
            if x + 3 + count.width() as u16 <= area.x + area.width {
                buf.set_string(x, info_y, " < ", prompt.add_modifier(Modifier::BOLD));
                buf.set_string(x + 3, info_y, &count, info_style);
                rule(buf, x + 4 + count.width() as u16, end, info_y);
            }
        }
        "inline-right" => {
            // The count at the right of the prompt line; the rule has a line of its own.
            let x = end.saturating_sub(count.width() as u16);
            if x > area.x + pw + typed_w + 1 { buf.set_string(x, prompt_y, &count, info_style) }
            rule(buf, area.x + 1, end, info_y);
        }
        "right" => {
            // `──────── 3/6 (0)`: the count at the end of its own line.
            let x = end.saturating_sub(count.width() as u16);
            rule(buf, area.x + 1, x.saturating_sub(1), info_y);
            buf.set_string(x, info_y, &count, info_style);
        }
        _ => {
            // `  3/6 (0)  harnesses  ────`.
            let info = format!("  {count}");
            buf.set_string(area.x, info_y, &info, info_style);
            let mut x = area.x + info.width() as u16;
            let label = picker.busy.clone().or_else(|| (!picker.title.is_empty()).then(|| picker.title.clone()));
            if let Some(label) = label {
                let text = format!(" {label} ");
                if (x as usize) + text.width() + 4 < (area.x as usize + width) {
                    buf.set_string(x + 1, info_y, &text, Style::default().fg(theme::fzf().header));
                    x += text.width() as u16 + 1;
                }
            }
            rule(buf, x + 1, end, info_y);
        }
    }
    if let Some(flash) = picker.flash.as_ref().map(|f| f.0.clone()) {
        let text = format!(" {flash} ");
        let fx = (area.x + area.width).saturating_sub(text.width() as u16 + 1);
        buf.set_string(fx, info_y, &text, Style::default().fg(Color::Black).bg(Color::Yellow));
    }
    if let Some(h) = &header { buf.set_line(area.x, header_y, h, area.width); }
    // The list: bottom-up (default), or top-down — under the prompt (reverse) or from the top
    // with the prompt below (reverse-list).
    let (list_top, list_bottom) = if prompt_top { (if header.is_some() && !header_first { header_y + 1 } else { edge + 1 }, bottom) } else { (area.y, if header.is_some() { header_y } else { edge }) };
    picker.page_rows.set(list_bottom.saturating_sub(list_top).max(1) as i64);
    let list_h = list_bottom.saturating_sub(list_top) as usize;
    let n = picker.visible.len();
    if n == 0 {
        if !picker.empty.is_empty() && list_h > 0 { buf.set_string(area.x + 2, if reverse { list_top } else { list_bottom - 1 }, &picker.empty, Style::default().add_modifier(Modifier::DIM)); }
        picker.row_at.clear();
        return cursor;
    }
    // Scroll so the cursor row is in view (scroll = first visible index from the bottom).
    if picker.cursor < picker.scroll { picker.scroll = picker.cursor }
    if picker.cursor >= picker.scroll + list_h { picker.scroll = picker.cursor + 1 - list_h }
    picker.scroll = picker.scroll.min(n.saturating_sub(list_h.max(1)));
    picker.row_at.clear();
    // A column of air before the scrollbar, so right-aligned keys never touch it.
    let bar = n > list_h && list_h > 2 && theme::fzf_opts().scrollbar.is_some();
    let text_w = width.saturating_sub(gutter_width() as usize + if bar { 2 } else { 1 });
    for slot in 0..list_h.min(n - picker.scroll) {
        let vi = picker.scroll + slot;
        let y = if reverse { list_top + slot as u16 } else { list_bottom - 1 - slot as u16 };
        picker.row_at.push((y, vi));
        fzf_row(buf, picker, vi, area.x, y, text_w);
    }
    // Scrollbar on the right edge, like fzf's: only the thumb, in the border colour.
    if let (true, Some(bar)) = (n > list_h && list_h > 2, theme::fzf_opts().scrollbar.clone()) {
        let thumb = ((list_h * list_h) / n).max(1);
        let from_top = picker.scroll.min(n - list_h) as f32 / (n - list_h) as f32;
        let top_frac = if reverse { from_top } else { 1.0 - from_top };
        let start = ((list_h - thumb) as f32 * top_frac).round() as usize;
        for i in 0..thumb {
            let y = list_top + (start + i) as u16;
            if y < list_bottom { buf.set_string(area.x + area.width - 1, y, &bar, Style::default().fg(theme::fzf().border)); }
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
    let z = theme::fzf();
    // fzf --color=bw: the current line in reverse video, matches underlined.
    let plus = if z.bw { Style::default().add_modifier(Modifier::REVERSED) } else { Style::default().bg(z.bg_plus) };
    if current {
        buf.set_string(x, y, format!("{:<w$}", z.pointer_char, w = pointer_w()), if z.bw { Style::default().add_modifier(Modifier::BOLD) } else { Style::default().fg(z.pointer).bg(z.bg_plus).add_modifier(Modifier::BOLD) });
    } else {
        buf.set_string(x, y, format!("{:<w$}", "▌", w = pointer_w()), Style::default().fg(z.gutter));
    }
    let marker_style = if current { plus.fg(z.marker) } else { Style::default().fg(z.marker) };
    let mw = z.marker_char.width().max(1);
    buf.set_string(x + pointer_w() as u16, y, if marked { format!("{:<mw$}", z.marker_char) } else { " ".repeat(mw) }, marker_style);
    let base = if current { plus.fg(z.fg_plus).add_modifier(Modifier::BOLD) } else { theme::fzf_opts().fg.map(|c| Style::default().fg(c)).unwrap_or_default() };
    let hit = match (current, z.bw) {
        (_, true) => base.add_modifier(Modifier::UNDERLINED),
        (true, false) => plus.fg(z.hl_plus).add_modifier(Modifier::BOLD),
        (false, false) => Style::default().fg(z.hl),
    };
    let fill = if current { plus } else { Style::default() };
    // Room: the right column first (so every row lines up), then the title, then the detail.
    let lead_w: usize = row.lead.iter().map(|s| s.content.width()).sum();
    let right_w = row.right.width();
    let show_right = !row.right.is_empty() && text_w >= lead_w + right_w + 14;
    let avail = text_w.saturating_sub(lead_w + if show_right { right_w + 2 } else { 0 });
    // A waiting question keeps some of itself in view; any other detail gives way to the title.
    let asking = row.detail.first().map(|s| s.content.starts_with("? ")).unwrap_or(false);
    // …and a row that matched only in its detail gives the detail room to show why.
    let label_n = row.label.chars().count() as u32;
    let detail_hit = !hits.is_empty() && hits.iter().all(|h| *h >= label_n);
    let label_room = if (asking && avail >= 50) || (detail_hit && avail >= 24) { row.label.width().min((avail * 3 / 5).max(12)).min(avail) } else { avail };
    // fzf's --hscroll: a hit past the end of the room slides the title left, `..` in front.
    let label_chars: Vec<char> = row.label.chars().collect();
    let label_len = label_chars.len();
    let last_hit = hits.iter().copied().filter(|h| (*h as usize) < label_len).max().map(|h| h as usize);
    let (label, offset) = match last_hit {
        Some(h) if row.label.width() > label_room && h + 2 > label_room && label_room > 6 => {
            let start = (h + 3).saturating_sub(label_room).min(label_len);
            let tail: String = label_chars[start..].iter().collect();
            let ell = theme::fzf_opts().ellipsis.clone();
            let ew = ell.chars().count();
            (format!("{ell}{}", clip_fzf(&tail, label_room - ew)), start as isize - ew as isize)
        }
        _ => (clip_fzf(&row.label, label_room), 0),
    };
    let mut spans: Vec<Span> = Vec::new();
    // The glyphs' colours follow the scheme: none in bw, the 16 in 16.
    let tone = |st: Style| -> Style {
        if z.bw { Style { fg: None, bg: None, ..st } }
        else if z.sixteen { Style { fg: st.fg.map(theme::to16), ..st } }
        else { st }
    };
    for s in &row.lead { spans.push(Span::styled(s.content.clone(), if current { tone(s.style).patch(plus) } else { tone(s.style) })) }
    // Characters, lit where they matched: `at` is each one's place in the searched line.
    let push_lit = |spans: &mut Vec<Span<'static>>, text: &str, first: isize, plain: Style, lit_style: Style| {
        let mut run = String::new();
        let mut lit = false;
        for (i, ch) in text.chars().enumerate() {
            let at = first + i as isize;
            let on = at >= 0 && hits.contains(&(at as u32)) && !theme::fzf_opts().ellipsis.contains(ch) && ch != '…';
            if on != lit && !run.is_empty() { spans.push(Span::styled(std::mem::take(&mut run), if lit { lit_style } else { plain })) }
            lit = on;
            run.push(ch);
        }
        if !run.is_empty() { spans.push(Span::styled(run, if lit { lit_style } else { plain })) }
    };
    push_lit(&mut spans, &label, offset, base, hit);
    // The detail, lit too (dim kept); it starts two cells after the title in the searched line.
    let detail_room = avail.saturating_sub(label.width() + 2);
    if !row.detail.is_empty() && detail_room >= 4 {
        spans.push(Span::styled("  ", fill));
        let mut left = detail_room;
        let mut at = label_len as isize + 2;
        for s in &row.detail {
            if left == 0 { break }
            let chars: Vec<char> = s.content.chars().collect();
            let len = chars.len() as isize;
            // A hit past the room slides this part left too, the ellipsis in front.
            let last = hits.iter().map(|h| *h as isize - at).filter(|r| *r >= 0 && *r < len).max();
            let (t, first) = match last {
                Some(r) if s.content.width() > left && r as usize + 2 > left && left > 6 => {
                    let ell = theme::fzf_opts().ellipsis.clone();
                    let ew = ell.chars().count();
                    // Room for the ellipsis in front and (if more follows) one behind, the hit between.
                    let start = (r as usize + 1 + 2 * ew).saturating_sub(left).min(chars.len());
                    let tail: String = chars[start..].iter().collect();
                    (format!("{ell}{}", clip_fzf(&tail, left - ew)), at + start as isize - ew as isize)
                }
                _ => (clip_fzf(&s.content, left), at),
            };
            left = left.saturating_sub(t.width());
            let st = tone(if current { s.style.patch(plus) } else { s.style });
            // A hit is full intensity, in dim text too (fzf's hl is not dimmed).
            let lit = hit.remove_modifier(Modifier::DIM);
            push_lit(&mut spans, &t, first, st, lit);
            at += len;
        }
    }
    let used: usize = spans.iter().map(|s| s.content.width()).sum();
    if show_right {
        // The right column sits at the row's end, or not far past a short row's text.
        let end = text_w.min((used + right_w + 24).max(text_w.min(90)));
        spans.push(Span::styled(" ".repeat(end.saturating_sub(used + right_w)), fill));
        // The right column is part of the line: its hits are lit too.
        let detail_len: isize = row.detail.iter().map(|s| s.content.chars().count() as isize).sum();
        let right_at = label_len as isize + 2 + detail_len + 2;
        push_lit(&mut spans, &row.right, right_at, fill.add_modifier(Modifier::DIM), hit.remove_modifier(Modifier::DIM));
    } else if current {
        spans.push(Span::styled(" ".repeat(text_w.saturating_sub(used)), fill));
    }
    buf.set_line(x + gutter_width(), y, &Line::from(spans), text_w as u16);
    // --color=selected-bg: marked rows carry it (the current row keeps bg+).
    if marked && !current { if let Some(bg) = theme::fzf_opts().selected_bg { buf.set_style(Rect::new(x + gutter_width(), y, text_w as u16, 1), Style::default().bg(bg)) } }
}

/// The pointer's cells (fzf pads every row to it) and the pointer and marker together.
fn pointer_w() -> usize { theme::fzf().pointer_char.width().max(1) }
fn gutter_width() -> u16 { (pointer_w() + theme::fzf().marker_char.width().max(1)) as u16 }

/// Break a styled line into lines no wider than `width`, at spaces where it can.
fn wrap_line(line: Line<'static>, width: usize) -> Vec<Line<'static>> {
    if width == 0 || line.width() <= width { return vec![line] }
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut cur: Vec<Span<'static>> = Vec::new();
    let mut used = 0;
    for span in line.spans {
        let style = span.style;
        for word in span.content.split_inclusive(' ') {
            let w = word.width();
            if used + w > width && used > 0 { out.push(Line::from(std::mem::take(&mut cur))); used = 0 }
            let word = if w > width { clip(word, width) } else { word.to_string() };
            used += word.width();
            cur.push(Span::styled(word, style));
        }
    }
    if !cur.is_empty() { out.push(Line::from(cur)) }
    // A wrapped line does not start with the separator it broke at.
    for line in out.iter_mut().skip(1) {
        while let Some(first) = line.spans.first() {
            let t = first.content.trim();
            if t.is_empty() || t == "·" { line.spans.remove(0); } else { break }
        }
    }
    out
}

/// fzf's `--header`: the keys this list answers to, in the header colour.
fn header_line(picker: &Picker, _: &PickerKind, width: usize) -> Option<Line<'static>> {
    if picker.hints.is_empty() { return None }
    // Indented to the rows' text (past the pointer and marker).
    let indent = gutter_width() as usize;
    let mut spans = vec![Span::raw(" ".repeat(indent))];
    let mut used = indent;
    for (i, (k, w)) in picker.hints.iter().enumerate() {
        // Whole hints only: the ones that do not fit are left out, not cut.
        let piece = if i > 0 { 3 } else { 0 } + k.width() + 1 + w.width();
        if used + piece > width { break }
        used += piece;
        if i > 0 { spans.push(Span::styled(" · ", Style::default().fg(theme::fzf().border))) }
        spans.push(Span::styled(k.to_string(), Style::default().fg(theme::fzf().header).add_modifier(Modifier::BOLD)));
        spans.push(Span::styled(format!(" {w}"), Style::default().fg(theme::fzf().header)));
    }
    Some(Line::from(spans))
}

/// The preview window: fzf's rounded border in 59, a label at the top, the content inside.
fn preview(buf: &mut Buffer, app: &App, kind: &PickerKind, picker: &Picker, area: Rect) {
    let border = Style::default().fg(theme::fzf().border);
    let w = area.width;
    let h = area.height;
    for y in area.y..area.y + h {
        for x in area.x..area.x + w { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } }
    }
    if let Some(bg) = theme::fzf_opts().bg { buf.set_style(area, Style::default().bg(bg)) }
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
    // Long lines wrap, as fzf's preview does (it is text, not a screen).
    let lines: Vec<Line> = crate::preview::lines(app, kind, &id).into_iter().flat_map(|l| wrap_line(l, inner.width as usize)).collect();
    // A preview that fits does not scroll; one that does stops at its last line.
    let most = lines.len().saturating_sub(inner.height as usize) as u16;
    picker.preview_max.set(most);
    for (i, line) in lines.iter().skip(picker.preview_scroll.min(most) as usize).take(inner.height as usize).enumerate() {
        buf.set_line(inner.x, inner.y + i as u16, line, inner.width);
    }
}

/// A pane's terminal, drawn into a preview box: its bottom, where the work is.
fn preview_grid(buf: &mut Buffer, pane: &Pane, area: Rect, scroll: u16) {
    let content = pane.term.renderable_content();
    let colors = content.colors;
    let rows = pane.rows as i32;
    // The rows that end at the cursor (an agent's prompt), not a screen's blank bottom.
    let cursor = content.cursor.point.line.0.max(0);
    let spare = (rows - area.height as i32).max(0);
    let first = (cursor + 1 - area.height as i32 - scroll as i32).clamp(0, spare);
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
        if cell.flags.contains(Flags::ITALIC) { style = style.add_modifier(Modifier::ITALIC) }
        if cell.flags.intersects(Flags::ALL_UNDERLINES) { style = style.add_modifier(Modifier::UNDERLINED) }
        if cell.flags.contains(Flags::STRIKEOUT) { style = style.add_modifier(Modifier::CROSSED_OUT) }
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
        // A lone pane's title is on its window's row, as tmux's tree has it.
        let panes = tab.panes();
        if panes.len() > 1 { for id in panes { rows.push(TreeRow { window: w, pane: Some(id) }) } }
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
    // tmux's tree: the session first, then its windows, then (expanded) their panes.
    let session = format!("(0)  - {}: {} windows (attached)", app.session_name(), app.tabs.len());
    buf.set_stringn(body.x, body.y, &session, body.width as usize, Style::default());
    let room = list_h.saturating_sub(1) as usize;
    let start = cursor.saturating_sub(room.saturating_sub(1));
    let pane_title = |p: u64| {
        let pane = app.panes.get(&p);
        let name = pane.and_then(|pn| app.fleet.agent(&pn.machine_id, &pn.agent_id)).map(|a| a.name.clone()).unwrap_or_default();
        let machine = pane.filter(|pn| pn.machine_id != app.fleet.local_id).map(|pn| format!(" {}", app.fleet.machine_name(&pn.machine_id))).unwrap_or_default();
        let state = pane.and_then(|pn| app.fleet.agent(&pn.machine_id, &pn.agent_id)).map(|a| match app.fleet.state_of(a) { State::NeedsInput => " [waiting]", State::Working => " [working]", State::Paused => " [paused]", State::Offline => " [offline]", _ => "" }).unwrap_or("");
        format!("\"{name}\"{machine}{state}")
    };
    let last_window = rows.iter().rposition(|r| r.pane.is_none()).unwrap_or(0);
    for (i, row) in rows.iter().enumerate().skip(start).take(room) {
        let y = body.y + 1 + (i - start) as u16;
        let tab = &app.tabs[row.window];
        let n = i + 1;
        let text = match row.pane {
            None => {
                let panes = tab.panes();
                let branch = if i == last_window { "└─>" } else { "├─>" };
                let fold = if panes.len() < 2 { " " } else if collapsed.contains(&tab.id) { "+" } else { "-" };
                let mut flags = String::new();
                if row.window == app.active { flags.push('*') } else if app.last_tab.as_ref() == Some(&tab.id) { flags.push('-') }
                if tab.zoomed { flags.push('Z') }
                let tail = match panes.as_slice() { [only] => format!(": {}", pane_title(*only)), [] => String::new(), _ => format!(" ({} panes)", panes.len()) };
                format!("({n}) {branch} {fold} {}: {}{flags}{tail}", app.win_num(row.window), tab.name)
            }
            Some(p) => {
                let panes = tab.panes();
                let at = panes.iter().position(|x| *x == p).unwrap_or(0);
                let rail = if rows.iter().skip(i + 1).any(|r| r.pane.is_none()) { "│" } else { " " };
                let branch = if at + 1 == panes.len() { "└─>" } else { "├─>" };
                format!("({n}) {rail}   {branch} {}: {}", at + app.pane_base_index, pane_title(p))
            }
        };
        let style = if i == cursor { mode } else { Style::default() };
        if i == cursor { buf.set_style(Rect::new(body.x, y, body.width, 1), mode) }
        buf.set_stringn(body.x, y, &clip(&text, body.width as usize), body.width as usize, style);
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
        Some(pane) if matches!(pane.phase, Phase::Live | Phase::Watching(_)) => {
            let label = format!(" {}: {} ", app.win_num(row.window), app.tabs[row.window].name);
            buf.set_stringn(area.x + 2, area.y, &clip(&label, area.width.saturating_sub(4) as usize), area.width.saturating_sub(4) as usize, Style::default());
            preview_grid(buf, pane, inner, 0)
        }
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
        // tmux also prints each pane's size in its top-right corner.
        if app.panes.contains_key(id) {
            let size = format!("{}x{}", rect.width, rect.height.saturating_sub(app.header_rows()));
            let x = (rect.x + rect.width).saturating_sub(size.width() as u16);
            buf.set_string(x, rect.y, &size, Style::default().fg(color));
        }
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
    // toggle-position (P): tmux hides the position indicator.
    if pane.copy_hide_position { return }
    let grid = pane.term.grid();
    let count = pane.find_count().map(|(i, n)| format!("({i}/{n} results) ")).unwrap_or_default();
    let text = format!("{count}[{}/{}]", grid.display_offset(), grid.history_size());
    let x = (content.x + content.width).saturating_sub(text.width() as u16);
    buf.set_string(x, content.y, &text, Style::default().bg(Color::Yellow).fg(Color::Black));
}

/// clip, with fzf's ellipsis (`··`, or --ellipsis).
fn clip_fzf(text: &str, cols: usize) -> String {
    let ell = &theme::fzf_opts().ellipsis;
    if text.width() <= cols { return text.to_string() }
    if cols <= ell.width() { return ell.chars().take(cols).collect() }
    let mut out = String::new();
    for ch in text.chars() {
        if out.width() + unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0) + ell.width() > cols { break }
        out.push(ch);
    }
    format!("{}{ell}", out.trim_end())
}

fn clip(text: &str, cols: usize) -> String {
    if text.width() <= cols { return text.to_string() }
    if cols == 0 { return String::new() }
    let mut out = String::new();
    for ch in text.chars() {
        if out.width() + unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0) + 1 > cols { break }
        out.push(ch);
    }
    let mut out = out.trim_end().to_string();
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
            lines.push((keys.iter().map(|(k, w)| format!("{k} {w}")).collect::<Vec<_>>().join(" · "), Style::default().add_modifier(Modifier::DIM)));
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
    // Wider than the tile (a pane under the daemon's 40 columns): likewise keep the cursor's column.
    let hspare = (pane.cols as i32 - area.width as i32).max(0);
    let hshift = (content.cursor.point.column.0 as i32 - area.width as i32 + 1).clamp(0, hspare) as u16;
    let colors = content.colors;
    let mode = content.mode;
    let cursor_point = content.cursor.point;
    let selection = content.selection;
    let find = pane.find_at.clone();
    // Only the matches on screen are asked about, cell by cell.
    let (lo, hi) = (-(content.display_offset as i32) - 1, pane.rows as i32 - content.display_offset as i32 + 1);
    let lit: Vec<alacritty_terminal::term::search::Match> = pane.find_all.iter().filter(|m| m.end().line.0 >= lo && m.start().line.0 <= hi).cloned().collect();
    for indexed in content.display_iter {
        let row = indexed.point.line.0 + offset;
        let Some(col) = (indexed.point.column.0 as u16).checked_sub(hshift) else { continue };
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
        // Reverse video stays reverse video: the terminal swaps in its own default colours, light
        // theme or dark.
        if cell.flags.contains(Flags::INVERSE) { mods |= Modifier::REVERSED }
        style = style.fg(fg_color).bg(bg_color).add_modifier(mods);
        // tmux mode-style: selections are yellow on black; the search match is
        // copy-mode-current-match-style, magenta on black.
        if find.as_ref().map(|m| m.contains(&indexed.point)).unwrap_or(false) { style = style.bg(Color::Magenta).fg(Color::Black) }
        // The other matches: copy-mode-match-style, cyan.
        else if lit.iter().any(|m| m.contains(&indexed.point)) { style = style.bg(Color::Cyan).fg(Color::Black) }
        else if selection.map(|r| r.contains(indexed.point)).unwrap_or(false) { style = style.bg(Color::Yellow).fg(Color::Black) }
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
        let Some(col) = &col.checked_sub(hshift) else { continue };
        if let Some(cell) = buf.cell_mut((area.x + col, area.y + row)) {
            if *col < area.width && row < area.height { cell.set_char(*c).set_style(Style::default().add_modifier(Modifier::UNDERLINED)); }
        }
    }
    if pane.scrolled() > 0 || !active { return None }
    if let Some((col, row, _, _)) = pane.predictions.last() {
        let row = (*row as i32 - shift).max(0) as u16;
        let col = &col.saturating_sub(hshift);
        if col + 1 < area.width && row < area.height { return Some(Position::new(area.x + col + 1, area.y + row)) }
    }
    if !mode.contains(TermMode::SHOW_CURSOR) || matches!(pane.phase, Phase::Watching(_)) { return None }
    let row = cursor_point.line.0 + offset;
    let col = (cursor_point.column.0 as u16).saturating_sub(hshift);
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


