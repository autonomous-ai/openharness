//! Drawing, the way tmux and fzf draw. A frame is the active window's panes (edge to edge when
//! there is one; tmux borders with `pane-border-status top` when there are several), then the
//! status line — tmux's: green, at the bottom, `[harness] 0:name* 1:name-`, the pane's title and
//! the time on the right; prompts and messages take it over in yellow. The search is fzf's own
//! layout and colours, with a preview window.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    // The status lines (tmux's status: off, on, 2 … 5), at the bottom or (status-position) the top.
    let lines = app.status_lines().max(1).min(area.height);
    let status = Rect::new(0, if app.status_top { 0 } else { area.height - lines }, area.width, lines);
    let body = app.body();
    let buf = frame.buffer_mut();
    let mut cursor: Option<Position> = None;
    // A list takes the window (with --height, only its bottom rows: the panes stay in view).
    let full_screen = matches!(app.modal, Some(Modal::Tree { .. })) || matches!(app.modal, Some(Modal::Picker { .. }) if theme::fzf_opts().height.is_none());
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
    if let Some(modal) = &mut app.modal {
        match modal {
            Modal::Picker { kind, picker } => { cursor = Some(fzf(buf, body, picker, kind, &*app_preview_placeholder())) }
            _ => {}
        }
    }
    // The picker drew with a placeholder preview; a live pane preview needs the whole app.
    if let Some(Modal::Picker { kind, picker }) = &app.modal {
        if let Some(area) = picker_preview_area(fzf_frame(body, picker).inner, picker) { preview(buf, app, kind, picker, area) }
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
    if let Some(Modal::Menu(m)) = &app.modal { menu(buf, app, m) }
    if app.prefix && app.prefix_at.map(|t| t.elapsed() >= Duration::from_millis(app.keymap.hint_ms)).unwrap_or(false) { which_key(buf, app, body) }
    // `set -g status off`: no status line — a prompt or a message still borrows the last row.
    let hidden = app.status_lines() == 0;
    let speaking = matches!(app.modal, Some(Modal::Prompt(_)) | Some(Modal::Confirm { .. })) || app.toast.as_ref().map(|(_, _, at)| at.elapsed() < Duration::from_millis(app.display_ms)).unwrap_or(false);
    if !hidden || speaking { if let Some(pos) = status_line(buf, app, status) { cursor = Some(pos) } }
    if let Some(pos) = cursor { frame.set_cursor_position(pos) }
}

/// tmux's menu (menu_draw_cb, screen_write_menu, screen_write_box): a box width + 4 wide at its
/// place in menu-border-lines and menu-border-style, the title drawn over the top border from its
/// third column, each item from the third column in menu-style — menu-selected-style when chosen,
/// dim when disabled — its key right-aligned as (k); '' a rule across, joined to the sides.
fn menu(buf: &mut Buffer, app: &App, m: &crate::modal::Menu) {
    let tab_id = app.tab().id.clone();
    let opt = |name: &str, default: &str| app.options.get(name, &tab_id, None).unwrap_or_else(|| default.to_string());
    let base = Style::default();
    let style = crate::draw::style_over(&opt("menu-style", "default"), base);
    let selected = crate::draw::style_over(&opt("menu-selected-style", "bg=yellow,fg=black"), base);
    let border = crate::draw::style_over(&opt("menu-border-style", "default"), style);
    let lines = opt("menu-border-lines", "single");
    // screen_write_box_border_set: corners, sides, and the rule's joins.
    let (tl, tr, bl, br, hz, vt, lj, rj) = match lines.as_str() {
        "double" => ("╔", "╗", "╚", "╝", "═", "║", "╠", "╣"),
        "heavy" => ("┏", "┓", "┗", "┛", "━", "┃", "┣", "┫"),
        "simple" => ("+", "+", "+", "+", "-", "|", "+", "+"),
        "rounded" => ("╭", "╮", "╰", "╯", "─", "│", "├", "┤"),
        "padded" | "none" => (" ", " ", " ", " ", " ", " ", " ", " "),
        _ => ("┌", "┐", "└", "┘", "─", "│", "├", "┤"),
    };
    let (w, h) = (m.width + 4, m.items.len() as u16 + 2);
    let (x0, y0) = (m.x, m.y);
    let put = |buf: &mut Buffer, x: u16, y: u16, s: &str, st: Style| { if let Some(c) = buf.cell_mut((x, y)) { c.set_symbol(s); c.set_style(st); } };
    for y in y0..y0 + h { for x in x0..x0 + w { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); c.set_style(style); } } }
    let (x1, y1) = (x0 + w - 1, y0 + h - 1);
    for x in x0 + 1..x1 { put(buf, x, y0, hz, border); put(buf, x, y1, hz, border) }
    for y in y0 + 1..y1 { put(buf, x0, y, vt, border); put(buf, x1, y, vt, border) }
    put(buf, x0, y0, tl, border); put(buf, x1, y0, tr, border); put(buf, x0, y1, bl, border); put(buf, x1, y1, br, border);
    let draw_at = |buf: &mut Buffer, x: u16, y: u16, text: &str, st: Style, avail: u16| {
        for (i, cell) in crate::draw::format_draw_over(text, st, avail).into_iter().enumerate() {
            if let Some((ch, cs)) = cell { if let Some(c) = buf.cell_mut((x + i as u16, y)) { c.set_symbol(if ch.is_empty() { " " } else { &ch }); c.set_style(cs); } }
        }
    };
    if !m.title.is_empty() { draw_at(buf, x0 + 2, y0, &m.title, border, w.saturating_sub(4)) }
    for (i, it) in m.items.iter().enumerate() {
        let y = y0 + 1 + i as u16;
        if it.separator {
            put(buf, x0, y, lj, border);
            for x in x0 + 1..x1 { put(buf, x, y, hz, border) }
            put(buf, x1, y, rj, border);
            continue;
        }
        let st = if m.choice == Some(i) && !it.disabled { selected } else if it.disabled { style.add_modifier(Modifier::DIM) } else { style };
        for x in x0 + 1..x0 + 1 + m.width + 2 { put(buf, x, y, " ", st) }
        let text = if it.key.is_empty() { it.label.clone() } else { format!("{}#[default] #[align=right]({})", it.label, it.key) };
        draw_at(buf, x0 + 2, y, &text, st, m.width);
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

/// The active window's panes, then their borders and status lines as tmux draws them.
fn window(buf: &mut Buffer, app: &mut App, body: Rect) -> Option<Position> {
    let focus = app.focused();
    let rects = app.rects.clone();
    let many = rects.len() > 1;
    let mut cursor = None;
    for (id, rect) in rects.iter() {
        let active = Some(*id) == focus;
        let content = app.content_of(app.tab(), *rect);
        // tmux's window-style / window-active-style: the default colours a pane's cells fall back to.
        let window = if active && many { (app.look.active_window_fg, app.look.active_window_bg) } else if many { (app.look.window_fg, app.look.window_bg) } else { (app.look.active_window_fg.or(app.look.window_fg), app.look.active_window_bg.or(app.look.window_bg)) };
        if app.panes.get(id).map(|p| p.in_mode()).unwrap_or(false) {
            let (styles, ctx) = (crate::copy::styles(app, *id), crate::copy::ctx(app, *id));
            if let Some(m) = app.panes.get(id).and_then(|p| p.modes.last()) {
                if let Some(bg) = window.1 { buf.set_style(content, Style::default().bg(bg)) }
                let (x, y) = m.draw(buf, content, &styles, window, &ctx);
                if active && x < content.width && y < content.height { cursor = Some(Position::new(content.x + x, content.y + y)) }
            }
            if let Some(pane) = app.panes.get_mut(id) { pane.dirty = false }
            continue;
        }
        if let Some(pane) = app.panes.get_mut(id) {
            if let Some(pos) = pane_body(buf, pane, content, active, window) { cursor = Some(pos) }
            pane.dirty = false;
        }
    }
    borders(buf, app, body);
    if app.modal.is_some() && !matches!(app.modal, Some(Modal::Copy { .. })) { None } else { cursor }
}

/// screen-redraw.c over the window: every border cell (its junction, the active pane's in
/// pane-active-border-style, the marked pane's reversed, pane-border-indicators' arrows) and each
/// pane's status line, the format drawn over border characters from two cells in.
fn borders(buf: &mut Buffer, app: &App, body: Rect) {
    let tab = app.tab();
    let status = app.pane_status(tab);
    let all = app.pane_geoms(app.active);
    let visible: Vec<(u64, crate::layout::Geom)> = if tab.zoomed {
        app.rects.iter().map(|(id, r)| { let c = app.content_of(tab, *r); (*id, crate::layout::Geom { x: (c.x - body.x) as u32, y: (c.y - body.y) as u32, w: c.width as u32, h: c.height as u32 }) }).collect()
    } else { all.clone() };
    let get = |name: &str| app.options.get(name, &tab.id, None).unwrap_or_default();
    let frame = crate::borders::Frame {
        sx: body.width as u32, sy: body.height as u32, all: &all, visible: &visible, active: app.focused(), marked: app.marked,
        status, lines: crate::borders::Lines::of(&get("pane-border-lines")), indicators: crate::borders::Indicators::of(&get("pane-border-indicators")), base: app.pane_base_index,
    };
    for c in frame.cells() {
        let style = border_style(app, c.paint == crate::borders::Paint::Active);
        let style = if c.marked { style.add_modifier(Modifier::REVERSED) } else { style };
        if let Some(cell) = buf.cell_mut((body.x + c.x as u16, body.y + c.y as u16)) { cell.set_symbol(&c.glyph).set_style(style); }
    }
    for t in frame.titles() {
        let style = border_style(app, t.active);
        let (x, y) = (body.x + t.x as u16, body.y + t.y as u16);
        for (k, g) in t.fill.iter().enumerate() { if let Some(cell) = buf.cell_mut((x + k as u16, y)) { cell.set_symbol(g).set_style(style); } }
        title_line(buf, app, t.pane, Rect::new(x, y, t.width as u16, 1), style);
    }
}

fn border_style(app: &App, active: bool) -> Style {
    // tmux's pane-active-border-style: yellow while the pane is in copy mode, red while the
    // window's panes are synchronized, else green (or your tmux.conf's colour).
    if active {
        let in_mode = app.focused().and_then(|f| app.panes.get(&f)).map(|p| p.in_mode()).unwrap_or(false);
        let colour = if app.look.active_border.is_some() { app.look.active_border.unwrap() } else if in_mode { Color::Yellow } else if app.tab().sync { Color::Red } else { theme::TMUX_ACTIVE_BORDER };
        Style::default().fg(colour)
    }
    else { app.look.border.map(|c| Style::default().fg(c)).unwrap_or_default() }
}

/// A pane's status line text over its border characters: your pane-border-format, or hn's — the
/// harness at a glance (its state's symbol, none for a plain shell) and its name, and where the
/// pane is wide enough, its project and branch at the far end (the focused pane's are on the
/// status line whatever the width).
fn title_line(buf: &mut Buffer, app: &App, id: u64, area: Rect, style: Style) {
    if area.width == 0 { return }
    let Some(pane) = app.panes.get(&id) else { return };
    if let Some(fmt) = &app.opts.pane_border_format {
        let line = clip_spans(crate::format::spans_for_pane(app, fmt, app.active, id, style), area.width as usize);
        buf.set_line(area.x, area.y, &line, area.width);
        return;
    }
    let title = crate::format::pane_title(app, app.active, id);
    let mut spans: Vec<Span> = vec![Span::styled(" ", style)];
    if let Some(state) = app.pane_state(id) {
        let (glyph, _, color) = theme::state_mark(state, app.tick);
        spans.push(Span::styled(glyph, style.fg(color)));
        spans.push(Span::styled(" ", style));
    }
    spans.push(Span::styled(title, style));
    if let Some(word) = pane_state_word(app, pane) { spans.push(Span::styled(" ", style)); spans.push(word) }
    spans.push(Span::styled(" ", style));
    let (project, branch) = app.fleet.agent(&pane.machine_id, &pane.agent_id).filter(|a| a.engine != "terminal" || !a.branch.is_empty())
        .map(|a| (a.project.clone(), a.branch.clone())).unwrap_or_default();
    let line = clip_spans(spans, area.width as usize);
    let used = line.width();
    buf.set_line(area.x, area.y, &line, area.width);
    // As the status line writes them (zsh's robbyrussell prompt), shorter as the pane narrows.
    let choices = [
        (!project.is_empty() && !branch.is_empty()).then(|| format!(" {project} git:({branch}) ")),
        (!branch.is_empty()).then(|| format!(" git:({branch}) ")),
        (!branch.is_empty()).then(|| format!(" {branch} ")),
    ];
    if let Some(right) = choices.into_iter().flatten().find(|r| area.width as usize >= used + r.width() + 4) {
        buf.set_string(area.x + area.width - right.width() as u16, area.y, &right, style.add_modifier(Modifier::DIM));
    }
}

/// What a harness is doing, in a word, when it is worth saying.
fn pane_state_word(app: &App, pane: &Pane) -> Option<Span<'static>> {
    if let Phase::Watching(who) = &pane.phase {
        return Some(Span::styled(format!("[watching{}]", if who.is_empty() { String::new() } else { format!(" — {who} has it") }), Style::default().fg(Color::Yellow)));
    }
    // The marked pane: tmux reverses its border, nothing in its title.
    let _ = app;
    None
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
            let (dot, _, color) = state_mark(state, app.tick);
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
    let prompt_like: Option<(String, String, usize, String, bool)> = match &app.modal {
        Some(Modal::Prompt(p)) => {
            let shown: String = if p.secret { "*".repeat(p.value.chars().count()) } else { p.value.clone() };
            Some((p.label.clone(), shown, p.cursor, p.hint.clone(), p.vi_normal))
        }
        Some(Modal::Confirm { prompt, .. }) => Some((format!("{prompt} "), String::new(), 0, String::new(), false)),
        _ => None,
    };
    if let Some((mut label, value, cursor, hint, command_mode)) = prompt_like {
        // status_prompt_redraw: the line in message-style (message-command-style in vi's command
        // mode), the prompt, then the text with the cursor's cell reversed — a reversed blank
        // after it at the end; scrolled to keep the cursor in view. The terminal's own cursor is
        // hidden, as tmux hides it.
        if !label.ends_with(' ') && label != ":" { label.push(' ') }
        let tab_id = app.tab().id.clone();
        let command_style = app.options.get("message-command-style", &tab_id, None).unwrap_or_else(|| "bg=black,fg=yellow".into());
        let gc = if command_mode && !plain { crate::draw::style_over(&command_style, Style::default()) } else { yellow };
        let cursorgc = if gc.add_modifier.contains(Modifier::REVERSED) { gc.remove_modifier(Modifier::REVERSED) } else { gc.add_modifier(Modifier::REVERSED) };
        for x in rect.x..rect.x + rect.width { if let Some(c) = buf.cell_mut((x, rect.y)) { c.reset(); c.set_symbol(" "); c.set_style(gc); } }
        let sx = rect.width as usize;
        let start = label.width().min(sx);
        for (i, cell) in crate::draw::format_draw_over(&label, gc, start as u16).into_iter().enumerate() {
            if let Some((ch, st)) = cell { if let Some(c) = buf.cell_mut((rect.x + i as u16, rect.y)) { c.set_symbol(if ch.is_empty() { " " } else { &ch }); c.set_style(st); } }
        }
        let left = sx - start;
        if left > 0 {
            let chars: Vec<char> = value.chars().collect();
            let w = |c: &char| unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0);
            let pcursor: usize = chars.iter().take(cursor).map(w).sum();
            let mut pwidth: usize = chars.iter().map(w).sum();
            let offset = if pcursor >= left { pwidth = left; pcursor - left + 1 } else { 0 };
            if pwidth > left { pwidth = left }
            let (mut width, mut x, mut i) = (0usize, rect.x + start as u16, 0usize);
            while i < chars.len() {
                let cw = w(&chars[i]);
                if width < offset { width += cw; i += 1; continue }
                if width >= offset + pwidth { break }
                width += cw;
                if width > offset + pwidth { break }
                if let Some(c) = buf.cell_mut((x, rect.y)) { c.set_char(chars[i]); c.set_style(if i != cursor { gc } else { cursorgc }); }
                x += cw as u16;
                i += 1;
            }
            if x < rect.x + rect.width && cursor >= i { if let Some(c) = buf.cell_mut((x, rect.y)) { c.set_symbol(" "); c.set_style(cursorgc); } }
            if !hint.is_empty() {
                let used = label.width() + value.width() + 3;
                if used + hint.width() < sx { buf.set_string(rect.x + rect.width - hint.width() as u16 - 1, rect.y, &hint, gc.add_modifier(Modifier::DIM)); }
            }
        }
        return None;
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
    // Each line is its status-format, expanded and drawn as tmux's format_draw draws it: the
    // left, the window list (cut around the current window, `<` `>` where it was cut) and the
    // right; the windows' ranges are where a click selects them.
    app.status_ranges.clear();
    let tab_id = app.tab().id.clone();
    for row in 0..rect.height {
        let Some(fmt) = app.options.get(&format!("status-format[{row}]"), &tab_id, None) else { continue };
        let expanded = crate::format::expand(app, &fmt, app.active, app.focused(), true);
        let (cells, ranges) = crate::draw::format_draw(&expanded, base, rect.width);
        for (x, (ch, st)) in cells.iter().enumerate() {
            if let Some(cell) = buf.cell_mut((rect.x + x as u16, rect.y + row)) {
                if !ch.is_empty() { cell.set_symbol(ch); } else { cell.set_symbol(""); }
                cell.set_style(*st);
            }
        }
        for mut r in ranges { r.start += rect.x; r.end += rect.x; app.status_ranges.push((row, r)) }
    }
    None
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

/// Where a list is drawn (fzf's adjustMarginAndPadding and resizeWindows): the screen it has — the
/// window, or with --height its bottom rows, as fzf takes the rows under a prompt at the bottom of
/// a terminal (the panes stay in view above) — the outer --border's box, and the area inside the
/// margin, the border and the padding, where the list and its preview go.
pub struct FzfFrame { pub screen: Rect, pub border: Option<Rect>, pub inner: Rect }

/// The --border shape's sides (top, right, bottom, left); none without one.
fn border_sides() -> (bool, bool, bool, bool) {
    match theme::fzf_opts().border.as_deref() {
        None | Some("none") | Some("line") => (false, false, false, false),
        Some("horizontal") => (true, false, true, false), Some("vertical") => (false, true, false, true),
        Some("top") => (true, false, false, false), Some("right") => (false, true, false, false),
        Some("bottom") => (false, false, true, false), Some("left") => (false, false, false, true),
        _ => (true, true, true, true),
    }
}

/// fzf's noSeparatorLine: no line for the separator (--info=inline, or hidden and inline-right
/// with --no-separator).
fn no_separator_line() -> bool {
    let o = theme::fzf_opts();
    match o.info_mode.as_str() { "inline" => true, "hidden" | "inline-right" => !o.separator, _ => false }
}

/// fzf's --height over a screen [h] rows tall: at least its minimum, no more than the screen
/// (maxHeightFunc); with `~` no more than its items and the lines around them need (Loop's fit).
fn fzf_rows(h: u16, height: theme::Height, picker: &Picker) -> u16 {
    let o = theme::fzf_opts();
    let term = h as i64;
    let border_lines = |(t, _, b, _): (bool, bool, bool, bool)| t as i64 + b as i64;
    // --min-height's automatic value (10 and what surrounds the list) for a height in percent.
    let mut min_height = o.min_height;
    if height.size.percent && min_height < 0 {
        min_height = -min_height + border_lines(border_sides()) + 1 + if no_separator_line() { 0 } else { 1 };
        if !picker.hints.is_empty() || picker.heading.is_some() { min_height += 1 }
        for s in [o.margin[0], o.margin[2], o.padding[0], o.padding[2]] { if !s.percent { min_height += s.size as i64 } }
    }
    let size = height.size.size;
    let evaluated = if height.size.percent {
        ((if height.inverse { 100.0 - size } else { size } * term as f64 / 100.0) as i64).max(min_height)
    } else if height.inverse { term - size as i64 } else { size as i64 };
    let effective_min = 3 - no_separator_line() as i64 + border_lines(border_sides());
    let mut rows = term.min(evaluated.max(effective_min));
    if height.auto {
        // The rows it takes: its items (as many as fit) and the lines around them, and the margins.
        let (_, m, p) = margin_and_padding(Rect::new(0, 0, 1000, rows.max(0) as u16));
        let pad = (m[0] + m[2] + p[0] + p[2]) as i64;
        let extra = 1 + !no_separator_line() as i64 + (!picker.hints.is_empty() || picker.heading.is_some()) as i64;
        let fit = (rows - pad - extra).max(0);
        let items = picker.rows.iter().filter(|r| !r.disabled).count() as i64;
        rows = term.min(items.min(fit) + extra + pad);
    }
    rows.clamp(0, term) as u16
}

/// adjustMarginAndPadding over [screen]: the margins (each with the border's width in it) and the
/// paddings, top, right, bottom, left — both given up, in proportion, where the screen cannot hold
/// them and fzf's smallest list.
fn margin_and_padding(screen: Rect) -> (Rect, [u16; 4], [u16; 4]) {
    let o = theme::fzf_opts();
    let (sw, sh) = (screen.width as i64, screen.height as i64);
    let to_int = |idx: usize, s: theme::Size| -> i64 { if s.percent { ((if idx % 2 == 0 { sh } else { sw }) as f64 * s.size * 0.01) as i64 } else { s.size as i64 } };
    let mut padding = [0i64; 4];
    let mut margin = [0i64; 4];
    let mut extra = [0i64; 4];
    let (t, r, b, l) = border_sides();
    for idx in 0..4 {
        padding[idx] = to_int(idx, o.padding[idx]);
        // A row for a top or bottom side, two columns (the glyph and a blank) for a left or right one.
        extra[idx] = match idx { 0 => t as i64, 1 => 2 * r as i64, 2 => b as i64, _ => 2 * l as i64 };
        margin[idx] = to_int(idx, o.margin[idx]) + extra[idx];
    }
    let mut adjust = |i1: usize, i2: usize, max: i64, min: i64| {
        let min = min.min(max);
        let total = margin[i1] + margin[i2] + padding[i1] + padding[i2];
        if max - total < min {
            let desired = max - min;
            padding[i1] = desired * padding[i1] / total;
            padding[i2] = desired * padding[i2] / total;
            margin[i1] = extra[i1].max(desired * margin[i1] / total);
            margin[i2] = extra[i2].max(desired * margin[i2] / total);
        }
    };
    adjust(1, 3, sw, 4);
    adjust(0, 2, sh, 3 - no_separator_line() as i64);
    let m = margin.map(|v| v.max(0) as u16);
    let p = padding.map(|v| v.max(0) as u16);
    (screen, m, p)
}

pub fn fzf_frame(body: Rect, picker: &Picker) -> FzfFrame {
    let screen = match theme::fzf_opts().height { Some(h) => { let rows = fzf_rows(body.height, h, picker); Rect::new(body.x, body.y + body.height - rows, body.width, rows) } None => body };
    let (_, m, p) = margin_and_padding(screen);
    let width = screen.width.saturating_sub(m[1] + m[3]);
    let height = screen.height.saturating_sub(m[0] + m[2]);
    let (t, r, b, l) = border_sides();
    let border = (t || r || b || l).then(|| {
        let x = screen.x + m[3] - 2 * l as u16;
        let y = screen.y + m[0] - t as u16;
        Rect::new(x, y, width + 2 * l as u16 + 2 * r as u16, height + t as u16 + b as u16)
    });
    let inner = Rect::new(screen.x + m[3] + p[3], screen.y + m[0] + p[0], width.saturating_sub(p[1] + p[3]), height.saturating_sub(p[0] + p[2]));
    FzfFrame { screen, border, inner }
}

/// The outer --border (rounded, sharp, bold, block, thinblock, double, horizontal, vertical, top,
/// bottom, left, right) around [body], in the border colour, and --border-label on it where
/// --border-label-pos puts it (printLabel: centred by default; a column from the left, or from the
/// right when negative; the bottom line with :bottom), cut with the ellipsis when it is too long.
/// fzf's glyphs for a border style (tui.go MakeBorderStyle): top, bottom, left, right, then the
/// corners — ASCII under --no-unicode.
fn border_glyphs(style: &str) -> (&'static str, &'static str, &'static str, &'static str, &'static str, &'static str, &'static str, &'static str) {
    if !theme::fzf().unicode { return ("-", "-", "|", "|", "+", "+", "+", "+") }
    match style {
        "sharp" => ("─", "─", "│", "│", "┌", "┐", "└", "┘"),
        "bold" => ("━", "━", "┃", "┃", "┏", "┓", "┗", "┛"),
        "double" => ("═", "═", "║", "║", "╔", "╗", "╚", "╝"),
        "block" => ("▀", "▄", "▌", "▐", "▛", "▜", "▙", "▟"),
        "thinblock" => ("▔", "▁", "▏", "▕", "🭽", "🭾", "🭼", "🭿"),
        _ => ("─", "─", "│", "│", "╭", "╮", "╰", "╯"),
    }
}

fn fzf_border(buf: &mut Buffer, body: Rect) {
    let Some(style) = theme::fzf_opts().border.clone() else { return };
    let st = theme::fzf().border_style();
    let (top_c, bottom_c, left_c, right_c, tl, tr, bl, br) = border_glyphs(&style);
    let (top, bottom, left, right) = match style.as_str() { "none" => (false, false, false, false), "horizontal" => (true, true, false, false), "vertical" => (false, false, true, true), "top" => (true, false, false, false), "bottom" => (false, true, false, false), "left" => (false, false, true, false), "right" => (false, false, false, true), _ => (true, true, true, true) };
    if body.width < 2 || body.height < 2 { return }
    let (x1, y1) = (body.x + body.width - 1, body.y + body.height - 1);
    if top { for x in body.x..=x1 { buf.set_string(x, body.y, top_c, st) } }
    if bottom { for x in body.x..=x1 { buf.set_string(x, y1, bottom_c, st) } }
    // A side's glyph and the column of margin inside it, both in the border's pair (the corners'
    // rows have no margin).
    let (y0, yn) = if top || bottom { (body.y + top as u16, y1 - bottom as u16) } else { (body.y, y1) };
    if left { for y in body.y..=y1 { buf.set_string(body.x, y, left_c, st) } for y in y0..=yn { buf.set_string(body.x + 1, y, " ", st) } }
    if right { for y in body.y..=y1 { buf.set_string(x1, y, right_c, st) } for y in y0..=yn { buf.set_string(x1 - 1, y, " ", st) } }
    if top && left { buf.set_string(body.x, body.y, tl, st) }
    if top && right { buf.set_string(x1, body.y, tr, st) }
    if bottom && left { buf.set_string(body.x, y1, bl, st) }
    if bottom && right { buf.set_string(x1, y1, br, st) }
    let o = theme::fzf_opts();
    if o.border_label.is_empty() || !(top || bottom) { return }
    let w = body.width as i64;
    let len = o.border_label.width() as i64;
    let (column, at_bottom) = o.border_label_pos;
    let col = if column == 0 { ((w - len) / 2).max(0) } else if column < 0 { (w + column + 1 - len).max(0) } else { (column - 1).min(w - len) };
    let row = if style == "bottom" || at_bottom { y1 } else { body.y };
    // ansiLabelPrinter: the whole label when it fits, else as much as fits and the ellipsis.
    let text = if len > w {
        let ell: String = { let mut used = 0; o.ellipsis.chars().take_while(|c| { used += unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0) as i64; used <= w }).collect() };
        trim_right(&o.border_label, (w - ell.width() as i64) as i32) + &ell
    } else { o.border_label.clone() };
    if col >= 0 { buf.set_stringn(body.x + col as u16, row, &text, (w - col).max(0) as usize, theme::fzf().pal.border_label.style()); }
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
    let frame = fzf_frame(body, picker);
    // (A --height list is drawn over the panes: its rows are its own.)
    for y in frame.screen.y..frame.screen.y + frame.screen.height {
        for x in frame.screen.x..frame.screen.x + frame.screen.width { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } }
    }
    if let Some(b) = frame.border { fzf_border(buf, b) }
    let body = frame.inner;
    // --color=bg: under everything (the preview too); list-bg: under the list alone.
    let pal = theme::fzf().pal;
    if let Some(bg) = pal.border.style().bg { buf.set_style(body, Style::default().bg(bg)) }
    let preview = picker_preview_area(body, picker);
    let area = match preview { Some(p) => Rect::new(body.x, body.y, p.x - body.x, body.height), None => body };
    // fzf's listStickToRight: with a border on the right and nothing between (no preview), the
    // list takes back the column of padding there, its scrollbar against the border.
    let right_border = matches!(theme::fzf_opts().border.as_deref(), Some(b) if !matches!(b, "none" | "horizontal" | "top" | "bottom" | "left"));
    let area = if right_border && preview.is_none() { Rect { width: area.width + 1, ..area } } else { area };
    if right_border && preview.is_none() {
        // (The border's margin there is the list's column now, blank until the list draws on it.)
        let plain = theme::fzfcolor::P { fg: theme::fzfcolor::Col::Default, bg: pal.normal.bg, attr: 0 }.style();
        for y in area.y..area.y + area.height { buf.set_string(area.x + area.width - 1, y, " ", plain) }
    }
    if let Some(bg) = pal.normal.style().bg { buf.set_style(area, Style::default().bg(bg)) }
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
    // (fzf's noSeparatorLine: inline has none; hidden and inline-right keep the rule on a line of
    // its own unless --no-separator.)
    let info_own_line = !no_separator_line();
    let (prompt_y, info_y) = if prompt_top { (area.y, if info_own_line { area.y + 1 } else { area.y }) } else { (bottom - 1, if info_own_line { bottom.saturating_sub(2) } else { bottom - 1 }) };
    // Rows come first in a short window, as in fzf: the key hints go before any row does.
    let header = if area.height >= 6 { header_line(picker, kind, width.saturating_sub(1)) } else { None };
    // --header-first: the header on the prompt's other side — above it with the prompt on top,
    // on the last line below it otherwise.
    let header_first = o.header_first && header.is_some();
    let (prompt_y, info_y) = match (header_first, prompt_top) { (true, true) => (prompt_y + 1, info_y + 1), (true, false) => (prompt_y - 1, info_y - 1), _ => (prompt_y, info_y) };
    let edge = if prompt_top { prompt_y.max(info_y) } else { prompt_y.min(info_y) };
    let header_y = match (header_first, prompt_top) { (true, true) => area.y, (true, false) => bottom - 1, _ => if header.is_some() { if prompt_top { edge + 1 } else { edge.saturating_sub(1) } } else { edge } };
    let prompt = theme::fzf().prompt_style();
    let prompt_text = theme::fzf().prompt_text.clone();
    // The prompt in its pair (bold as fzf makes it, unless --no-bold or prompt:regular); its
    // trailing blanks in the pair's colours without the attributes — parsePrompt's AttrClear, laid
    // on the characters at the blanks' byte offsets, as fzf lays it (after `❯` it misses them); a
    // tab out to the next --tabstop.
    let blank_from = prompt_text.trim_end_matches([' ', '\t', '\n', '\x0c', '\r']).len();
    let clear = theme::fzfcolor::P { attr: 0, ..pal.prompt }.style();
    let mut pw = 0u16;
    for (i, c) in prompt_text.chars().enumerate() {
        let st = if i >= blank_from && i < prompt_text.len() { clear } else { prompt };
        let (text, w) = if c == '\t' { let n = o.tabstop - pw as usize % o.tabstop; (" ".repeat(n), n) } else { (c.to_string(), unicode_width::UnicodeWidthChar::width(c).unwrap_or(0)) };
        buf.set_string(area.x + pw, prompt_y, text, st);
        pw += w as u16;
    }
    let q_room = width.saturating_sub(pw as usize + 1);
    // A query longer than the line scrolls to keep the cursor in view, as fzf's does.
    let before: String = picker.query.chars().take(picker.qcursor).collect();
    let skip = before.width().saturating_sub(q_room);
    let shown: String = { let mut w = 0; picker.query.chars().skip_while(|c| { let cw = unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0); if w < skip { w += cw; true } else { false } }).collect() };
    buf.set_stringn(area.x + pw, prompt_y, &shown, q_room, pal.input.style());
    let mut typed_w = shown.width().min(q_room) as u16;
    // What an inline count keeps clear of: the query and a margin, or the ghost, as fzf shifts it.
    let mut shift = typed_w as i32 + 1;
    if picker.query.is_empty() && !picker.placeholder.is_empty() {
        // The placeholder (fzf's --ghost), whole scopes only, leaving an inline count its place.
        let room = if mode.starts_with("inline") { q_room.saturating_sub(16) } else { q_room };
        let mut text = String::new();
        for part in picker.placeholder.split("   ") { if text.width() + part.width() + 3 > room { break } if !text.is_empty() { text.push_str("   ") } text.push_str(part) }
        buf.set_stringn(area.x + pw, prompt_y, &text, q_room, pal.ghost.style());
        typed_w = text.width() as u16;
        if !text.is_empty() { shift = typed_w as i32 }
    }
    let cursor = Position::new(area.x + pw + (before.width().saturating_sub(skip) as u16).min(q_room as u16), prompt_y);
    let total = picker.rows.iter().filter(|r| !r.disabled).count();
    let mut count = format!("{}/{}", picker.visible.len(), total);
    if !picker.marked.is_empty() || matches!(kind, PickerKind::Open { .. }) { count.push_str(&format!(" ({})", picker.marked.len())) }
    // fzf's printInfoImpl, each --info laid out as it lays it out: the count in the info pair, cut
    // with `..` when the room runs out (trimMessage); the separator's line filled with its string
    // (RepeatToFill) after a blank in its pair; the last column left blank. A list still loading
    // spins in the spinner's pair where fzf's does, and gives an info prefix that pair too.
    let (info_style, sep_style, spin_style) = (pal.info.style(), pal.separator.style(), pal.spinner.style());
    let reading = picker.busy.is_some();
    // fzf's makeSpinner (ASCII under --no-unicode).
    const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const ASCII_SPINNER: [&str; 8] = ["-", "\\", "|", "/", "-", "\\", "|", "/"];
    let frames: &[&str] = if theme::fzf().unicode { &SPINNER } else { &ASCII_SPINNER };
    let spinner = frames[(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0) / 100) as usize % frames.len()];
    let w = area.width as i32;
    let put = |buf: &mut Buffer, x: i32, y: u16, s: &str, st: Style| { if x >= 0 && x < w && !s.is_empty() { buf.set_stringn(area.x + x as u16, y, s, (w - x) as usize, st); } };
    let bar = |buf: &mut Buffer, x: i32, y: u16, n: i32| { if o.separator && n > 0 { put(buf, x, y, &repeat_to_fill(&o.separator_char, n as usize), sep_style) } };
    // printInfoPrefix: the prefix at [pos] (what fits of it), in the prompt's pair.
    let prefix = |buf: &mut Buffer, pos: i32, y: u16| -> i32 {
        let room = w - pos;
        let (text, width) = if o.info_prefix.width() as i32 > room { (trim_right(&o.info_prefix, room), room) } else { (o.info_prefix.clone(), o.info_prefix.width() as i32) };
        put(buf, pos, y, &text, if reading { spin_style } else { prompt });
        pos + width
    };
    let len = count.len() as i32;
    if w > 1 {
        match mode {
            // Hidden: no count, but the rule keeps its line (only --no-separator takes it away).
            "hidden" => bar(buf, 0, info_y, w - 1),
            // `> query  < 3/6 (0) ────`
            "inline" => {
                let pos = prefix(buf, pw as i32 + shift, info_y);
                let max = w - pos - 1;
                let out = trim_message(&count, max);
                put(buf, pos, info_y, &out, info_style);
                let (mut x, mut len) = (pos + out.width() as i32, len);
                if len < max - 1 && reading { put(buf, x + 1, info_y, spinner, spin_style); x += 2; len += 2 }
                let fill = max - len - 1;
                if fill > 0 { put(buf, x, info_y, " ", sep_style); bar(buf, x + 1, info_y, fill) }
            }
            // The count at the right of the prompt line, a column short of the edge (the spinner
            // two before it, or the prefix just before); the rule on a line of its own.
            "inline-right" => {
                let mut pos = pw as i32 + shift;
                if o.info_prefix.is_empty() {
                    pos = pos.max(w - len - 3);
                    if pos < w { if reading { put(buf, pos, prompt_y, spinner, spin_style) } pos += 1 }
                    if pos < w - 1 { pos += 1 }
                } else {
                    pos = prefix(buf, pos.max(w - len - o.info_prefix.width() as i32 - 1), prompt_y);
                }
                put(buf, pos, prompt_y, &trim_message(&count, w - pos - 1), info_style);
                bar(buf, 0, info_y, w - 1);
            }
            // `──────── 3/6 (0) `: the rule from the first column (the spinner after it), the count.
            "right" => {
                let out = trim_message(&count, w - 1 - if reading { 2 } else { 0 });
                let fill = w - out.len() as i32 - 2;
                let mut x = 0;
                if reading {
                    if fill >= 2 { bar(buf, 0, info_y, fill - 2); x = fill - 1 }
                    put(buf, x, info_y, spinner, spin_style);
                    x += 2;
                } else if fill >= 0 { bar(buf, 0, info_y, fill); x = fill + 1 }
                put(buf, x, info_y, &out, info_style);
            }
            // `⠋ 3/6 (0) ────`: the spinner's cell, a margin, the count, a blank, the rule.
            _ => {
                if reading { put(buf, 0, info_y, spinner, spin_style) }
                let max = w - 3;
                let out = trim_message(&count, max);
                put(buf, 2, info_y, &out, info_style);
                let fill = max - len - 1;
                if fill > 0 { let x = 2 + out.width() as i32; put(buf, x, info_y, " ", sep_style); bar(buf, x + 1, info_y, fill) }
            }
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
    let (list_top, list_bottom) = if prompt_top { (if header.is_some() && !header_first { header_y + 1 } else { edge + 1 }, bottom) } else { (area.y, if header.is_some() && !header_first { header_y } else { edge }) };
    picker.page_rows.set(list_bottom.saturating_sub(list_top).max(1) as i64);
    let list_h = list_bottom.saturating_sub(list_top) as usize;
    let n = picker.visible.len();
    if n == 0 {
        // A list with nothing in it says why; one the query emptied, or one still loading (its
        // spinner turning), is blank, as fzf's is.
        if !picker.empty.is_empty() && list_h > 0 && total == 0 && !reading { buf.set_string(area.x + 2, if reverse { list_top } else { list_bottom - 1 }, &picker.empty, Style::default().add_modifier(Modifier::DIM)); }
        picker.row_at.clear();
        return cursor;
    }
    // fzf's maxWidth: the window less the pointer and marker, and less barCol() — a column for the
    // scrollbar whenever there is one (shown or not), or for whatever is on the right edge.
    let bar_col = theme::fzf_opts().scrollbar.is_some() || right_border || preview.is_some();
    let text_w = width.saturating_sub(gutter_width() as usize + bar_col as usize);
    picker.row_at.clear();
    if picker.wrap || theme::fzf_opts().gap > 0 { fzf_wrapped(buf, picker, area, list_top, list_bottom, text_w, reverse); return cursor }
    // Scroll so the cursor row is in view (scroll = first visible index from the bottom), with
    // fzf's --scroll-off rows (3; at most half the list) kept on either side of it.
    let so = theme::fzf_opts().scroll_off.min(list_h / 2);
    if picker.cursor < picker.scroll + so { picker.scroll = picker.cursor.saturating_sub(so) }
    if picker.cursor + so >= picker.scroll + list_h { picker.scroll = (picker.cursor + so + 1).saturating_sub(list_h) }
    picker.scroll = picker.scroll.min(n.saturating_sub(list_h.max(1)));
    // The right column lines up down the list: one edge for every row on screen, after the widest
    // line, within the list.
    let shown = picker.scroll..(picker.scroll + list_h.min(n - picker.scroll));
    let right_edge = shown.clone().map(|vi| { let r = &picker.rows[picker.visible[vi].0]; r.lead.iter().map(|s| s.content.width()).sum::<usize>() + crate::picker::line(r).width() }).max().unwrap_or(0).min(text_w);
    for slot in 0..list_h.min(n - picker.scroll) {
        let vi = picker.scroll + slot;
        let y = if reverse { list_top + slot as u16 } else { list_bottom - 1 - slot as u16 };
        picker.row_at.push((y, vi));
        fzf_row(buf, picker, vi, area.x, y, text_w, right_edge);
    }
    // Scrollbar on the right edge, like fzf's: only the thumb, in the border colour.
    // fzf's getScrollbar: the thumb's length and its start from the prompt's side, both floored.
    if let (true, Some(bar)) = (n > list_h && list_h > 2, theme::fzf_opts().scrollbar.clone()) {
        let thumb = ((list_h * list_h) / n).max(1);
        let start = ((list_h - thumb) * picker.scroll.min(n - list_h) / (n - list_h)).min(list_h - thumb);
        for i in 0..thumb {
            let y = if reverse { list_top + (start + i) as u16 } else { list_bottom - 1 - (start + i) as u16 };
            if y >= list_top && y < list_bottom { buf.set_string(area.x + area.width - 1, y, &bar, theme::fzf().scrollbar_style()); }
        }
    }
    cursor
}

/// One fzf row as printItem draws it: the pointer (or the gutter), the marker cell, then the
/// text — the row's pair (normal, selected, or the current line's), matches in the match pair,
/// the parts with colours of their own merged as fzf merges --ansi text (colorOffsets).
fn fzf_row(buf: &mut Buffer, picker: &Picker, vi: usize, x: u16, y: u16, text_w: usize, right_edge: usize) {
    let (ri, hits) = &picker.visible[vi];
    let row = &picker.rows[*ri];
    let o = theme::fzf_opts();
    let pal = theme::fzf().pal;
    let (base, matched, current, marked, alt) = row_gutter(buf, picker, vi, x, y, None);
    let base_style = base.style();
    let cell = |part: Option<Style>, on: bool| paint(base, matched, part, on);
    let mut spans: Vec<Span> = Vec::new();
    for s in &row.lead { spans.push(Span::styled(s.content.clone(), cell(Some(s.style), false))) }
    let lead_w: usize = row.lead.iter().map(|s| s.content.width()).sum();
    let label_len = row.label.chars().count();
    let mut cells: Vec<Cell> = row.label.chars().enumerate().map(|(i, c)| (c, None, hits.contains(&(i as u32)))).collect();
    let detail_len: usize = row.detail.iter().map(|s| s.content.chars().count()).sum();
    if detail_len > 0 {
        cells.push((' ', None, false));
        cells.push((' ', None, false));
        let mut at = label_len + 2;
        for s in &row.detail {
            for c in s.content.chars() { cells.push((c, Some(s.style), hits.contains(&(at as u32)))); at += 1 }
        }
    }
    let right_w = row.right.width();
    let show_right = !row.right.is_empty() && text_w >= lead_w + right_w + 14;
    let avail = text_w.saturating_sub(lead_w + if show_right { right_w + 2 } else { 0 });
    let cells: Vec<(char, Style)> = hscroll(cells, avail, &o.ellipsis, o.hscroll, o.hscroll_off, o.keep_right).into_iter().map(|(c, part, on)| (c, cell(part, on))).collect();
    let mut run = String::new();
    let mut run_style = None::<Style>;
    for (c, st) in &cells {
        if run_style != Some(*st) && !run.is_empty() { spans.push(Span::styled(std::mem::take(&mut run), run_style.unwrap_or_default())) }
        run_style = Some(*st);
        run.push(*c);
    }
    if !run.is_empty() { spans.push(Span::styled(run, run_style.unwrap_or_default())) }
    let used: usize = spans.iter().map(|s| s.content.width()).sum();
    // Past the text the current row keeps bg+ only as far as the line goes (fzf; --highlight-line
    // fills the row): to the end of the right column when there is one.
    let fill = if current { base_style } else { pal.normal.style() };
    if show_right {
        let end = right_edge.clamp(used + right_w + 2, text_w);
        spans.push(Span::styled(" ".repeat(end.saturating_sub(used + right_w)), fill));
        let right_at = label_len + if detail_len > 0 { 2 + detail_len } else { 0 } + 2;
        // The right column is dim text of the line's own.
        let dim = Style::default().add_modifier(Modifier::DIM);
        for (i, c) in row.right.chars().enumerate() {
            let on = hits.contains(&((right_at + i) as u32));
            spans.push(Span::styled(c.to_string(), cell(Some(dim), on)));
        }
    }
    let used: usize = spans.iter().map(|s| s.content.width()).sum();
    // --highlight-line fills the rest of the current, a marked or a striped row (postTask).
    if o.highlight_line && (current || marked || alt) {
        let fill = if current { base_style } else if alt { pal.selected.with_bg(pal.alt_bg).style() } else { pal.selected.style() };
        spans.push(Span::styled(" ".repeat(text_w.saturating_sub(used)), fill));
    }
    buf.set_line(x + gutter_width(), y, &Line::from(spans), text_w as u16);
}

/// printItem's preTask and pairs for a row: the pointer on the current line, the gutter elsewhere
/// (no column at all for --pointer=''); the marker cell — the marker on a selected row ([marker]
/// instead on a line of a row of several), else blank (bg+ on the current line; plain, the default
/// colour on the list's background, elsewhere; none for --marker=''); and the row's pairs, the
/// current line's, a selected row's or the normal ones — on --color=alt-bg every other row counted
/// from the first one shown (fzf's itemCount), unless it is marked on a selected-bg of its own; the
/// current row keeps bg+. Returns (base, matched, current, marked, alt).
fn row_gutter(buf: &mut Buffer, picker: &Picker, vi: usize, x: u16, y: u16, marker: Option<&str>) -> (theme::fzfcolor::P, theme::fzfcolor::P, bool, bool, bool) {
    let row = &picker.rows[picker.visible[vi].0];
    let current = vi == picker.cursor;
    let marked = picker.marked.contains(&row.id);
    let z = theme::fzf();
    let pal = z.pal;
    let pw = pointer_w();
    if pw > 0 && current { buf.set_string(x, y, format!("{:<pw$}", z.pointer_char), pal.current_cursor.style()) }
    else if pw > 0 {
        // The gutter: --gutter's character, `▌`, or under --no-unicode a blank in reverse.
        let o = theme::fzf_opts();
        let (gutter, st) = match &o.gutter { Some(g) => (g.as_str(), pal.cursor_empty_char), None if o.unicode => ("▌", pal.cursor_empty_char), None => (" ", pal.cursor_empty) };
        buf.set_string(x, y, format!("{:<pw$}", gutter), st.style())
    }
    let mw = marker_w();
    let marker = marker.unwrap_or(&z.marker_char);
    let plain = theme::fzfcolor::P { fg: theme::fzfcolor::Col::Default, bg: pal.normal.bg, attr: 0 };
    let (mark, mark_style) = match (current, marked) {
        (true, true) => (format!("{:<mw$}", marker), pal.current_marker.style()),
        (true, false) => (" ".repeat(mw), pal.current_selected_empty.style()),
        (false, true) => (format!("{:<mw$}", marker), pal.marker.style()),
        (false, false) => (" ".repeat(mw), plain.style()),
    };
    buf.set_string(x + pw as u16, y, mark, mark_style);
    let (base, matched) = match (current, marked) {
        (true, _) => (pal.current, pal.current_match),
        (false, true) => (pal.selected, pal.selected_match),
        (false, false) => (pal.normal, pal.matched),
    };
    let alt = !(marked && pal.selected.bg != pal.normal.bg) && pal.alt_bg.col != theme::fzfcolor::Col::Undef && vi.saturating_sub(picker.scroll) % 2 == 1;
    let (base, matched) = if alt && !current { (base.with_bg(pal.alt_bg), matched.with_bg(pal.alt_bg)) } else { (base, matched) };
    (base, matched, current, marked, alt)
}

/// A cell of a row's line as fzf reads it (picker::line): the title in the row's pair, the detail
/// and the glyphs in their own colours over it; the match pair where the query lit it.
fn paint(base: theme::fzfcolor::P, matched: theme::fzfcolor::P, part: Option<Style>, on: bool) -> Style {
    use theme::fzfcolor::{ansi, lit, own};
    let colored = theme::fzf().pal.colored;
    match (part, on) {
        (None, false) => base.style(),
        (Some(st), false) => ansi(own(st), base, colored).style(),
        (part, true) => lit(base, matched, part.map(own), colored).style(),
    }
}

/// Whether a row's line fits hn's one-line layout at [text_w] (fzf_row: its title and detail in
/// the room its lead and right column leave, the right column shown when there is one).
fn fits_line(row: &crate::picker::Row, text_w: usize) -> bool {
    let cw = |c: char| unicode_width::UnicodeWidthChar::width(c).unwrap_or(0);
    let lead_w: usize = row.lead.iter().map(|s| s.content.width()).sum();
    let right_w = row.right.width();
    let show_right = !row.right.is_empty() && text_w >= lead_w + right_w + 14;
    let avail = text_w.saturating_sub(lead_w + if show_right { right_w + 2 } else { 0 });
    let detail: usize = row.detail.iter().flat_map(|s| s.content.chars()).map(cw).sum();
    let has_detail = row.detail.iter().any(|s| !s.content.is_empty());
    row.label.chars().map(cw).sum::<usize>() + if has_detail { 2 + detail } else { 0 } <= avail && (row.right.is_empty() || show_right)
}

/// A row's whole line as cells, for --wrap: the lead's glyphs, the title and the detail (lit where
/// the query matched them) and the right column, dim — picker::line after the lead.
fn line_cells(row: &crate::picker::Row, hits: &[u32]) -> Vec<Cell> {
    let mut cells: Vec<Cell> = row.lead.iter().flat_map(|s| s.content.chars().map(move |c| (c, Some(s.style), false))).collect();
    cells.extend(row.label.chars().enumerate().map(|(i, c)| (c, None, hits.contains(&(i as u32)))));
    let mut at = row.label.chars().count();
    if row.detail.iter().any(|s| !s.content.is_empty()) {
        cells.extend([(' ', None, false), (' ', None, false)]);
        at += 2;
        for s in &row.detail { for c in s.content.chars() { cells.push((c, Some(s.style), hits.contains(&(at as u32)))); at += 1 } }
    }
    if !row.right.is_empty() {
        let dim = Style::default().add_modifier(Modifier::DIM);
        cells.extend([(' ', None, false), (' ', None, false)]);
        at += 2;
        for c in row.right.chars() { cells.push((c, Some(dim), hits.contains(&(at as u32)))); at += 1 }
    }
    cells
}

/// fzf's Chars.Lines for one line: cut where it runs past [cols] columns (a line after the first
/// [sign_w] fewer, for the wrap sign; at least one character a line), no more than [at_most] lines
/// — and whether there was more.
fn wrap_cells(cells: &[Cell], cols: usize, sign_w: usize, at_most: usize) -> (Vec<Vec<Cell>>, bool) {
    let cw = |c: char| unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) as i64;
    let (mut out, mut rest, mut signed) = (Vec::new(), cells, false);
    loop {
        let limit = cols as i64 - if signed { sign_w as i64 } else { 0 };
        let mut w = 0;
        let over = rest.iter().position(|c| { w += cw(c.0); w > limit });
        if out.len() >= at_most { return (out, true) }
        match over {
            Some(i) => { let i = i.max(1); out.push(rest[..i].to_vec()); rest = &rest[i..]; signed = true }
            None => { out.push(rest.to_vec()); return (out, false) }
        }
    }
}

/// fzf's numItemLines with --wrap: how many lines a row takes (no more than [at_most]), and
/// whether it needs more.
fn item_lines(p: &Picker, vi: usize, at_most: i64, text_w: usize) -> (usize, bool) {
    // (With --gap, its blank lines after it count too.)
    let gap = theme::fzf_opts().gap;
    if !p.wrap { return (1 + gap, (1 + gap) as i64 > at_most) }
    let (ri, hits) = &p.visible[vi];
    {
        let cache = p.line_cache.borrow();
        if cache.0 == text_w { if let Some(&(room, n)) = cache.1.get(ri) { if room <= at_most { return (n, false) } } }
    }
    let (lines, over) = if at_most <= 0 { (0, true) } else {
        let row = &p.rows[*ri];
        if fits_line(row, text_w) { (1, false) } else {
            let (l, over) = wrap_cells(&line_cells(row, hits), text_w.max(1), theme::fzf_opts().wrap_sign.width(), at_most as usize);
            (l.len(), over)
        }
    };
    if !over {
        let mut cache = p.line_cache.borrow_mut();
        if cache.0 != text_w { *cache = (text_w, Default::default()) }
        cache.1.insert(*ri, (at_most, lines + gap));
    }
    (lines + gap, over || (lines + gap) as i64 > at_most)
}

/// fzf's page-up/-down and half-page-up/-down ([direction] as move_by's: toward the far end of the
/// list is positive): a page is the list's lines less one, half a page half of them; with --wrap
/// the cursor goes a row at a time, constrain() after each, and stops before the screen would
/// scroll past the rows that were on it.
pub fn page(p: &mut Picker, direction: i64, half: bool) {
    let max_items = p.page_rows.get().max(0) as usize;
    let lines_to_move = (if half { max_items / 2 } else { max_items.saturating_sub(1) }).max(1) as i64;
    let text_w = p.wrap_width.get();
    if !(p.wrap || theme::fzf_opts().gap > 0) || text_w == 0 || p.visible.is_empty() { return p.vset(p.cursor as i64 + direction * lines_to_move, direction) }
    let n = p.visible.len();
    let (mut min_offset, mut max_offset, mut sum) = (0i64, 0i64, 0usize);
    if direction > 0 {
        max_offset = p.scroll as i64;
        while (max_offset as usize) < n {
            sum += item_lines(p, max_offset as usize, max_items as i64, text_w).0;
            if sum >= max_items { break }
            max_offset += 1;
        }
    } else {
        min_offset = p.scroll as i64;
        while min_offset >= 0 && (min_offset as usize) < n {
            sum += item_lines(p, min_offset as usize, max_items as i64, text_w).0;
            if sum >= max_items { if sum > max_items { min_offset += 1 } break }
            min_offset -= 1;
        }
    }
    for i in 0..lines_to_move {
        let (cy, offset) = (p.cursor, p.scroll);
        p.vset(cy as i64 + direction, direction);
        let q: &Picker = p;
        let next = constrain_wrapped(q, max_items, &|vi, at_most| item_lines(q, vi, at_most, text_w));
        p.scroll = next;
        if cy == p.cursor { break }
        if i > 0 && ((direction > 0 && p.scroll as i64 > max_offset) || (direction < 0 && (p.scroll as i64) < min_offset)) {
            p.vset(cy as i64, -direction);
            p.scroll = offset;
            break;
        }
    }
}

/// fzf's constrain() with rows of more than one line: the offset (the first row on the prompt's
/// side) that fits the current row, then keeps --scroll-off lines on either side of it.
fn constrain_wrapped(p: &Picker, max_lines: usize, lines: &dyn Fn(usize, i64) -> (usize, bool)) -> usize {
    let count = p.visible.len();
    let cy = p.cursor.min(count.saturating_sub(1));
    let mut offset = p.scroll.min(count);
    for _ in 0..max_lines {
        // How many rows fit on screen with the current one.
        let (mut found, mut sum) = (0usize, 0usize);
        let add = |i: usize, found: &mut usize, sum: &mut usize| -> bool {
            let (l, overflow) = lines(i, (max_lines - *sum) as i64);
            *sum += l;
            if *sum >= max_lines { if *found == 0 || !overflow { *found += 1 } return false }
            *found += 1;
            true
        };
        for i in offset..count { if !add(i, &mut found, &mut sum) { break } }
        if sum < max_lines { for i in (0..offset).rev() { if !add(i, &mut found, &mut sum) { break } } }
        let num_items = found;
        let min_offset = (cy + 1).saturating_sub(num_items);
        let max_offset = count.saturating_sub(num_items).min(cy);
        let prev = offset;
        offset = offset.min(max_offset).max(min_offset);
        let scroll_off = theme::fzf_opts().scroll_off;
        if scroll_off > 0 {
            let so = scroll_off.min(max_lines / 2) as i64;
            let mut next = offset;
            for phase in 0..2 {
                loop {
                    let before_move = next;
                    let item_lines = lines(cy, max_lines as i64).0 as i64;
                    let mut before = 0i64;
                    for i in next..cy { before += lines(i, max_lines as i64 - before - item_lines).0 as i64 }
                    let after = max_lines as i64 - (before + item_lines);
                    if before < so && after < so { break }
                    if phase == 0 && before < so { next = next.saturating_sub(1).max(min_offset) }
                    else if phase == 1 && after < so { next = (next + 1).min(max_offset) }
                    if next == before_move { break }
                }
                offset = next;
            }
        }
        if offset == prev { break }
    }
    offset
}

/// fzf --wrap (toggle-wrap, M-/): a row too long for its line goes on over the next ones, each
/// after the wrap sign (`↳ `, in the row's colours, dim), the pointer and the marker on every one
/// of them (a marked row's ╻ ┃ ╹). constrain() keeps the current row on screen with --scroll-off
/// lines around it, the rows stack from the prompt, a row cut at the far end shows the part nearest
/// the prompt in the default layout (its first lines otherwise), and the scrollbar counts
/// avgNumLines — as fzf 0.67 draws it. A row that fits keeps hn's layout, its right column lined up.
fn fzf_wrapped(buf: &mut Buffer, picker: &mut Picker, area: Rect, list_top: u16, list_bottom: u16, text_w: usize, reverse: bool) {
    let o = theme::fzf_opts();
    let max_lines = list_bottom.saturating_sub(list_top) as usize;
    let n = picker.visible.len();
    if max_lines == 0 || n == 0 { return }
    let (cols, sign_w) = (text_w.max(1), o.wrap_sign.width());
    picker.wrap_width.set(text_w);
    let p: &Picker = picker;
    let lines = |vi: usize, at_most: i64| item_lines(p, vi, at_most, text_w);
    let offset = constrain_wrapped(p, max_lines, &lines);
    // The rows from the prompt: (visible index, fzf's line — 0 nearest the prompt — and the part of
    // a wrapped row on it: its cells, whether it goes on from the line before, its marker's place).
    let maxy = max_lines - 1;
    let mut placed: Vec<(usize, usize, Option<(Vec<Cell>, bool, usize)>)> = Vec::new();
    // --gap's lines: (fzf's line, whether it is the one the gap line is drawn on).
    let mut gaps: Vec<(usize, bool)> = Vec::new();
    let gap = o.gap;
    let (mut line, mut k) = (0usize, 0usize);
    while line <= maxy && offset + k < n {
        let vi = offset + k;
        k += 1;
        let (ri, hits) = &p.visible[vi];
        let row = &p.rows[*ri];
        if !p.wrap || fits_line(row, text_w) {
            placed.push((vi, line, None));
            // printItem: the gap after the row, while there is room.
            let mut last = line;
            for i in 0..gap { if last >= maxy { break } last += 1; gaps.push((last, i == gap - 1)) }
            line = last + 1;
            continue;
        }
        let cells = line_cells(row, hits);
        let at_most = maxy - line + 1;
        let (mut parts, overflow) = wrap_cells(&cells, cols, sign_w, at_most);
        let count = parts.len();
        // In the default layout a row that is not the current one and runs past the top shows its
        // last lines.
        let top_cut = !reverse && vi != p.cursor && count == at_most && overflow;
        let skip = if top_cut { parts = wrap_cells(&cells, cols, sign_w, usize::MAX).0; parts.len() - at_most } else { 0 };
        let mut last = line;
        for (idx, part) in parts.into_iter().enumerate().skip(skip) {
            let a = idx - skip;
            if line + a > maxy { break }
            // markerSingle (0), markerTop (1), markerMiddle (2), markerBottom (3)
            let class = if count == 1 { if !overflow { 0 } else if top_cut { 3 } else { 1 } }
                else if a == 0 { if top_cut { 2 } else { 1 } }
                else if a == count - 1 { if top_cut || !overflow { 3 } else { 2 } }
                else { 2 };
            placed.push((vi, if reverse { line + a } else { line + count - 1 - a }, Some((part, idx > 0, class))));
            last = line + a;
        }
        for i in 0..gap { if last >= maxy { break } last += 1; gaps.push((last, i == gap - 1)) }
        line = last + 1;
    }
    // avgNumLines: the rows from the offset (or the last screenful), a screen's worth at most — 1
    // without --wrap (--gap's lines are not counted).
    let per_line = if !p.wrap { 1 } else {
        let from = (offset as i64).min(n as i64 - max_lines as i64 - 1).max(0) as usize;
        let counted: Vec<usize> = (from..n).take(max_lines).map(|vi| lines(vi, max_lines as i64).0).collect();
        if counted.is_empty() { 1 } else { counted.iter().sum::<usize>() / counted.len() }
    };
    let right_edge = placed.iter().filter(|x| x.2.is_none()).map(|x| { let r = &p.rows[p.visible[x.0].0]; r.lead.iter().map(|s| s.content.width()).sum::<usize>() + crate::picker::line(r).width() }).max().unwrap_or(0).min(text_w);
    picker.scroll = offset;
    for (vi, fline, part) in placed {
        let y = if reverse { list_top + fline as u16 } else { list_bottom - 1 - fline as u16 };
        picker.row_at.push((y, vi));
        match part {
            None => fzf_row(buf, picker, vi, area.x, y, text_w, right_edge),
            Some((cells, signed, class)) => fzf_row_part(buf, picker, vi, area.x, y, text_w, &cells, signed, class),
        }
    }
    // renderGapLine: the gutter, a blank marker, and on a gap's last line the gap line across.
    let z = theme::fzf();
    let pal = z.pal;
    let gap_line = o.gap_line.clone().unwrap_or_else(|| if z.unicode { "┈".into() } else { "-".into() });
    let (pw, mw) = (pointer_w(), marker_w());
    for (fline, draw) in gaps {
        let y = if reverse { list_top + fline as u16 } else { list_bottom - 1 - fline as u16 };
        if pw > 0 {
            let (gutter, st) = match &o.gutter { Some(g) => (g.as_str(), pal.cursor_empty_char), None if o.unicode => ("▌", pal.cursor_empty_char), None => (" ", pal.cursor_empty) };
            buf.set_string(area.x, y, format!("{:<pw$}", gutter), st.style());
        }
        let width = (area.width as usize).saturating_sub(pw + mw + 1);
        if draw && !gap_line.is_empty() { buf.set_string(area.x + (pw + mw) as u16, y, repeat_to_fill(&gap_line, width), pal.list_border.style()); }
    }
    // getScrollbar(avgNumLines, …): the thumb and its start from the prompt's side.
    let (total, h) = (n * per_line.max(1), max_lines);
    if let (true, Some(bar)) = (total > h && h > 2, o.scrollbar.clone()) {
        let thumb = (h * h / total).max(1);
        let start = if n == h { 0 } else { ((h * per_line - thumb) * offset / (total - h)).min(h - thumb) };
        for i in 0..thumb {
            let y = if reverse { list_top + (start + i) as u16 } else { list_bottom - 1 - (start + i) as u16 };
            if y >= list_top && y < list_bottom { buf.set_string(area.x + area.width - 1, y, &bar, theme::fzf().scrollbar_style()); }
        }
    }
}

/// A line of a wrapped row (printHighlighted with --wrap): the pointer and the marker for its
/// place in the row, the wrap sign when it goes on from the line before, then its cells.
#[allow(clippy::too_many_arguments)]
fn fzf_row_part(buf: &mut Buffer, picker: &Picker, vi: usize, x: u16, y: u16, text_w: usize, cells: &[Cell], signed: bool, class: usize) {
    let z = theme::fzf();
    let marker = (class > 0).then(|| z.marker_multi[class - 1].as_str());
    let (base, matched, current, marked, alt) = row_gutter(buf, picker, vi, x, y, marker);
    let mut spans: Vec<Span> = Vec::new();
    if signed {
        let mut w = 0;
        let sign: String = theme::fzf_opts().wrap_sign.chars().take_while(|c| { w += unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0); w <= text_w }).collect();
        spans.push(Span::styled(sign, base.style().add_modifier(Modifier::DIM)));
    }
    let (mut run, mut run_style) = (String::new(), None::<Style>);
    for (c, part, on) in cells {
        let st = paint(base, matched, *part, *on);
        if run_style != Some(st) && !run.is_empty() { spans.push(Span::styled(std::mem::take(&mut run), run_style.unwrap_or_default())) }
        run_style = Some(st);
        run.push(*c);
    }
    if !run.is_empty() { spans.push(Span::styled(run, run_style.unwrap_or_default())) }
    // --highlight-line fills the rest of the current, a marked or a striped row's line.
    if theme::fzf_opts().highlight_line && (current || marked || alt) {
        let pal = z.pal;
        let used: usize = spans.iter().map(|s| s.content.width()).sum();
        let fill = if current { base.style() } else if alt { pal.selected.with_bg(pal.alt_bg).style() } else { pal.selected.style() };
        spans.push(Span::styled(" ".repeat(text_w.saturating_sub(used)), fill));
    }
    buf.set_line(x + gutter_width(), y, &Line::from(spans), text_w as u16);
}

/// fzf's trimRight: as much of [s] as fits in [limit] columns.
fn trim_right(s: &str, limit: i32) -> String {
    let mut width = 0;
    s.chars().take_while(|c| { width += unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0) as i32; width <= limit }).collect()
}

/// fzf's trimMessage: a message longer than [max] (in bytes, as fzf counts) cut to leave room for
/// two dots — or as many as there is room for.
fn trim_message(s: &str, max: i32) -> String {
    if s.len() as i32 <= max { return s.to_string() }
    trim_right(s, max - 2) + &".".repeat(max.clamp(0, 2) as usize)
}

/// fzf's util.RepeatToFill (a separator longer than the room is cut to it): the string over and
/// over, then as much of it as fits.
fn repeat_to_fill(s: &str, limit: usize) -> String {
    let length = s.width();
    if length == 0 { return String::new() }
    if length > limit { return trim_right(s, limit as i32) }
    let mut out = s.repeat(limit / length);
    let mut rest = (limit % length) as i32;
    if rest > 0 {
        for c in s.chars() {
            rest -= unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) as i32;
            if rest < 0 { break }
            out.push(c);
            if rest == 0 { break }
        }
    }
    out
}

/// fzf's hscroll (terminal.go, printHighlighted): a line wider than its room keeps its last match
/// in view with --hscroll-off columns after it, the ellipsis where it was cut on either side.
fn hscroll(cells: Vec<Cell>, room: usize, ellipsis: &str, scroll: bool, scroll_off: usize, keep_right: bool) -> Vec<Cell> {
    let cw = |c: char| unicode_width::UnicodeWidthChar::width(c).unwrap_or(0);
    let w = |c: &[Cell]| -> usize { c.iter().map(|x| cw(x.0)).sum() };
    if w(&cells) <= room { return cells }
    // util.Truncate(ellipsis, maxWidth): as much of it as the room takes.
    let mut ew = 0;
    let ell: Vec<char> = ellipsis.chars().take_while(|c| { ew += cw(*c); ew <= room }).collect();
    let ew: usize = ell.iter().map(|c| cw(*c)).sum();
    let trim_right = |c: &[Cell], width: usize| -> Vec<Cell> {
        let mut out = Vec::new();
        let mut used = 0;
        for x in c { if used + cw(x.0) > width { break } used += cw(x.0); out.push(*x) }
        out
    };
    // --keep-right, a row the query did not light: its end in view, the ellipsis before it (trimLeft).
    if scroll && keep_right && !cells.iter().any(|c| c.2) {
        let mut from = cells.len().saturating_sub(room);
        while from < cells.len() && w(&cells[from..]) > room.saturating_sub(ew) { from += 1 }
        let mut out: Vec<Cell> = ell.iter().map(|c| (*c, None, false)).collect();
        out.extend(cells[from..].iter().cloned());
        return out;
    }
    let max_end = cells.iter().rposition(|c| c.2).map(|i| i + 1).unwrap_or(0);
    // (Less than the last match's end when the ellipsis is wider than half the room.)
    let maxe = (max_end as i64 + ((room / 2) as i64 - ew as i64).min(scroll_off as i64)).clamp(0, cells.len() as i64) as usize;
    if !scroll || w(&cells[..maxe]) <= room.saturating_sub(ew) {
        let mut out = trim_right(&cells, room.saturating_sub(ew));
        // The ellipsis in what fzf's colour offsets leave on it: cut only at the end, they stay
        // where they were, so a part of the line's own running on under it colours it; under
        // --no-hscroll they are pulled back into it, so whatever was past the cut does — a match
        // too.
        let mut runs: Vec<(usize, usize, Style)> = Vec::new();
        for (i, x) in cells.iter().enumerate() {
            let Some(st) = x.1 else { continue };
            match runs.last_mut() { Some(r) if r.1 == i && r.2 == st => r.1 = i + 1, _ => runs.push((i, i + 1, st)) }
        }
        let (n, start) = (ell.len(), out.len());
        for (k, &c) in ell.iter().enumerate() {
            let at = start + k;
            let covers = |b: usize, e: usize| if scroll { b <= at && at < e } else { b.min(room.saturating_sub(n)) <= at && at < e.min(room) };
            let part = runs.iter().rev().find(|r| covers(r.0, r.1)).map(|r| r.2);
            let on = cells.iter().enumerate().any(|(i, x)| x.2 && covers(i, i + 1));
            out.push((c, part, on));
        }
        return out;
    }
    // Scrolled: the ellipses are the row's own, nothing of the line's reaching them.
    let plain = |c: &char| (*c, None, false);
    let mut cells = cells;
    if w(&cells[maxe..]) > ew { cells.truncate(maxe); cells.extend(ell.iter().map(plain)) }
    // Trim from the left until it fits beside the leading ellipsis.
    let width = room.saturating_sub(ew);
    let mut current = w(&cells);
    let mut from = 0;
    while current > width && from < cells.len() { current -= cw(cells[from].0); from += 1 }
    let mut out: Vec<Cell> = ell.iter().map(plain).collect();
    out.extend(cells[from..].iter().cloned());
    out
}

/// A character of a row's line: its own colours if it has them (hn's glyphs, a dim detail — an
/// --ansi part to fzf), and whether the query lit it.
type Cell = (char, Option<Style>, bool);

/// The pointer's cells (fzf pads every row to it) and the pointer and marker together.
fn pointer_w() -> usize { theme::fzf().pointer_char.width() }
fn marker_w() -> usize { theme::fzf().marker_char.width() }
fn gutter_width() -> u16 { (pointer_w() + marker_w()) as u16 }

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
    if picker.hints.is_empty() && picker.heading.is_none() { return None }
    // Indented to the rows' text (past the pointer and marker).
    let indent = gutter_width() as usize;
    let mut spans = vec![Span::raw(" ".repeat(indent))];
    let mut used = indent;
    // What the list is for, first (a task about to be sent).
    if let Some(h) = &picker.heading {
        let h = clip(h, width.saturating_sub(indent + 12));
        used += h.width() + 3;
        spans.push(Span::styled(h, theme::fzf().header_style().add_modifier(Modifier::BOLD)));
        if !picker.hints.is_empty() { spans.push(Span::styled(" · ", theme::fzf().border_style())) }
    }
    for (i, (k, w)) in picker.hints.iter().enumerate() {
        // Whole hints only: the ones that do not fit are left out, not cut.
        let piece = if i > 0 { 3 } else { 0 } + k.width() + 1 + w.width();
        if used + piece > width { break }
        used += piece;
        if i > 0 { spans.push(Span::styled(" · ", theme::fzf().border_style())) }
        spans.push(Span::styled(k.to_string(), theme::fzf().header_style().add_modifier(Modifier::BOLD)));
        spans.push(Span::styled(format!(" {w}"), theme::fzf().header_style()));
    }
    Some(Line::from(spans))
}

/// The preview window: fzf's rounded border in 59, a label at the top, the content inside.
fn preview(buf: &mut Buffer, app: &App, kind: &PickerKind, picker: &Picker, area: Rect) {
    let border = theme::fzf().border_style();
    let w = area.width;
    let h = area.height;
    for y in area.y..area.y + h {
        for x in area.x..area.x + w { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } }
    }
    if let Some(bg) = theme::fzf_opts().bg { buf.set_style(area, Style::default().bg(bg)) }
    let (top_c, bottom_c, left_c, right_c, tl, tr, bl, br) = border_glyphs("rounded");
    buf.set_string(area.x, area.y, tl, border);
    buf.set_string(area.x + w - 1, area.y, tr, border);
    buf.set_string(area.x, area.y + h - 1, bl, border);
    buf.set_string(area.x + w - 1, area.y + h - 1, br, border);
    for x in area.x + 1..area.x + w - 1 { buf.set_string(x, area.y, top_c, border); buf.set_string(x, area.y + h - 1, bottom_c, border); }
    // The padding inside the sides is the border's too (the right one is the scrollbar's column).
    for y in area.y + 1..area.y + h - 1 { buf.set_string(area.x, y, format!("{left_c} "), border); buf.set_string(area.x + w - 2, y, format!(" {right_c}"), border); }
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
    // A preview that fits does not scroll; one that does scrolls until its last line is at the
    // top (fzf's scrollPreviewTo).
    let (total, height) = (lines.len(), inner.height as usize);
    let scrollable = total > height && height > 0;
    let most = if scrollable { (total - 1).min(u16::MAX as usize) as u16 } else { 0 };
    picker.preview_max.set(most);
    picker.preview_lines.set(total);
    picker.preview_rows.set(inner.height);
    let offset = picker.preview_scroll.min(most) as usize;
    for (i, line) in lines.iter().skip(offset).take(height).enumerate() {
        buf.set_line(inner.x, inner.y + i as u16, line, inner.width);
    }
    if !scrollable { return }
    // fzf's preview scrollbar, in the column before the border: getScrollbar's thumb and start.
    if let Some(bar) = theme::fzf_opts().preview_scrollbar.clone() {
        let thumb = (height * height / total).max(1);
        let start = ((height - thumb) * offset / (total - height)).min(height - thumb);
        for i in 0..thumb { buf.set_string(area.x + w - 2, inner.y + (start + i) as u16, &bar, border); }
    }
    // Its offset, N/M, at the top right in the info colour reversed.
    let mark = format!("{}/{}", offset + 1, total);
    if (mark.width() as u16) < inner.width {
        buf.set_string(inner.x + inner.width - mark.width() as u16, inner.y, &mark, theme::fzf().pal.info.style().add_modifier(Modifier::REVERSED));
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
                if row.window == app.active { flags.push('*') } else if app.last_tab() == Some(&tab.id) { flags.push('-') }
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
            let c = app.content_of(app.tab(), *rect);
            let size = format!("{}x{}", c.width, c.height);
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



#[allow(dead_code)]
fn _unused(_: &keys::Keymap, _: PromptKind) {}

#[allow(dead_code)]
fn _ago(ms: u64) -> String { ago(ms) }


pub(crate) fn map_color(color: AColor, colors: &alacritty_terminal::term::color::Colors, fg_side: bool) -> (Color, bool) {
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

#[cfg(test)]
mod fzf_info_tests {
    use super::{repeat_to_fill, trim_message};

    /// printInfoImpl's pieces: the count cut as trimMessage cuts it, the separator repeated to
    /// fill as RepeatToFill does.
    #[test]
    fn info_cut_and_filled_as_fzf_does() {
        assert_eq!(trim_message("0/100", 5), "0/100");
        assert_eq!(trim_message("0/100", 4), "0/..");
        assert_eq!(trim_message("0/100", 3), "0..");
        assert_eq!(trim_message("0/100", 1), ".");
        assert_eq!(trim_message("0/100", -2), "");
        assert_eq!(repeat_to_fill("-=", 5), "-=-=-");
        assert_eq!(repeat_to_fill("─", 3), "───");
        assert_eq!(repeat_to_fill("abc", 2), "ab");
    }
}

#[cfg(test)]
mod fzf_list_tests {
    use super::*;
    use crate::picker::Row;

    /// The ellipsis takes what fzf's colour offsets leave on it (printHighlighted): under
    /// --no-hscroll whatever was past the cut, a match too; cut only at the end, a part of the
    /// line's own running on under it; scrolled, nothing.
    #[test]
    fn the_ellipsis_in_what_it_covers() {
        let dim = Style::default().add_modifier(Modifier::DIM);
        let line = |lit: &[usize], part: std::ops::Range<usize>| -> Vec<Cell> { "abcdefghijklmnop".chars().enumerate().map(|(i, c)| (c, part.contains(&i).then_some(dim), lit.contains(&i))).collect() };
        let tail = |cells: Vec<Cell>| cells[8..].to_vec();
        // --no-hscroll: a match past the cut lights both dots; one on the first dot's cell, that one.
        assert_eq!(tail(hscroll(line(&[14], 0..0), 10, "··", false, 10, false)), [('·', None, true), ('·', None, true)]);
        assert_eq!(tail(hscroll(line(&[8], 0..0), 10, "··", false, 10, false)), [('·', None, true), ('·', None, false)]);
        // Cut at the end: a dim part running on under the dots dims them.
        assert_eq!(tail(hscroll(line(&[0], 5..16), 10, "··", true, 10, false)), [('·', Some(dim), false), ('·', Some(dim), false)]);
        assert_eq!(tail(hscroll(line(&[0], 5..9), 10, "··", true, 10, false)), [('·', Some(dim), false), ('·', None, false)]);
        // Scrolled to a match at the end: the dots are the row's own.
        assert_eq!(hscroll(line(&[15], 0..16), 10, "··", true, 10, false)[..2], [('·', None, false), ('·', None, false)]);
    }

    fn screen(p: &mut Picker) -> String {
        let area = Rect::new(0, 0, 40, 10);
        let mut buf = Buffer::empty(area);
        fzf(&mut buf, area, p, &PickerKind::Output { title: String::new(), lines: vec![] }, "");
        (0..area.height).map(|y| (0..area.width).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    /// A list with nothing in it says why; one the query emptied is blank, as fzf's is, and so is
    /// one still loading (its spinner says so).
    #[test]
    fn a_list_the_query_emptied_is_blank() {
        let mut p = Picker::new("t", "");
        p.empty = "(empty)".into();
        assert!(screen(&mut p).contains("(empty)"));
        p.busy = Some("loading".into());
        assert!(!screen(&mut p).contains("(empty)"));
        p.busy = None;
        p.set_rows(vec![Row::new("a", "alpha")]);
        p.set_query("zzz");
        assert!(!screen(&mut p).contains("(empty)"));
    }
}
