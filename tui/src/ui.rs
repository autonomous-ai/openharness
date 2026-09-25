//! Drawing. One frame = the tab strip, the active tab's tiles (each a header line and its
//! terminal), then whatever overlay is open. ratatui diffs frames, so a keystroke's echo costs the
//! cells it changed and nothing else.

use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::vte::ansi::{Color as AColor, NamedColor};
use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph, Widget};
use ratatui::Frame;
use unicode_width::UnicodeWidthStr;

use crate::app::App;
use crate::fleet::{ago, State};
use crate::input::home_agents;
use crate::modal::Modal;
use crate::pane::{Pane, Phase};
use crate::picker::Picker;
use crate::theme::{self, bold, engine_mark, fg, state_mark};

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    let buf = frame.buffer_mut();
    tab_strip(buf, app, Rect::new(0, 0, area.width, 1));
    let mut cursor: Option<Position> = None;
    if app.tab().root.is_none() {
        home(buf, app, app.body());
    } else {
        let focus = app.focused();
        let rects = app.rects.clone();
        let body = app.body();
        for (id, rect) in &rects {
            let Some(pane) = app.panes.get_mut(id) else { continue };
            let active = Some(*id) == focus;
            header(buf, &app.fleet, pane, *rect, active, rects.len() > 1, app.tick);
            let content = Rect::new(rect.x, rect.y + 1, rect.width, rect.height.saturating_sub(1));
            if let Some(pos) = pane_body(buf, pane, content, active) { cursor = Some(pos) }
            pane.dirty = false;
            // The seam to the right of a tile.
            let seam = rect.x + rect.width;
            if seam < body.x + body.width {
                for y in rect.y..rect.y + rect.height {
                    if let Some(cell) = buf.cell_mut((seam, y)) { cell.set_symbol("│").set_style(fg(theme::LINE)); }
                }
            }
        }
    }
    if let Some((text, color, _)) = &app.toast { toast(buf, area, text, *color) }
    let body = app.body();
    let rects = app.rects.clone();
    if let Some(modal) = &mut app.modal {
        match modal {
            Modal::Picker { picker, .. } => { picker_box(buf, area, picker); cursor = picker.cursor_pos }
            Modal::Prompt(prompt) => cursor = Some(prompt_box(buf, area, prompt)),
            Modal::Copy { pane } => {
                let rect = rects.iter().find(|(id, _)| id == pane).map(|(_, r)| *r).unwrap_or(body);
                let label = " COPY  hjkl w b 0 $ g G · v select · y copy · / find · q leave ";
                let x = rect.x + rect.width.saturating_sub(label.width() as u16 + 1);
                buf.set_string(x, rect.y, label, Style::default().bg(theme::WARN).fg(Color::Black).add_modifier(Modifier::BOLD));
            }
            Modal::Find { pane, query, found } => {
                let rect = rects.iter().find(|(id, _)| id == pane).map(|(_, r)| *r).unwrap_or(body);
                cursor = Some(find_bar(buf, rect, query, *found));
            }
        }
    }
    if app.prefix {
        let text = " ^␣ … ";
        buf.set_string(area.width.saturating_sub(text.width() as u16 + 1), 0, text, Style::default().fg(Color::Black).bg(theme::WARN));
    }
    if let Some(pos) = cursor { frame.set_cursor_position(pos) }
}

// ── the tab strip ────────────────────────────────────────────────────────────

fn tab_label(app: &App, index: usize) -> (String, Option<(char, Color)>) {
    let tab = &app.tabs[index];
    let mut mark = None;
    for id in tab.panes() {
        let Some(pane) = app.panes.get(&id) else { continue };
        let Some(agent) = app.fleet.agent(&pane.machine_id, &pane.agent_id) else { continue };
        match app.fleet.state_of(agent) {
            State::NeedsInput => { mark = Some(('◆', theme::ATTENTION)); break }
            State::Done if mark.is_none() => mark = Some(('●', theme::ONLINE)),
            State::Working if mark.is_none() => mark = Some(('●', theme::ACCENT_SOFT)),
            _ => {}
        }
    }
    let name: String = if tab.name.chars().count() > 22 { tab.name.chars().take(21).collect::<String>() + "…" } else { tab.name.clone() };
    (name, mark)
}

/// Where each tab sits in the strip, between x=10 and [limit]: (index, x from, x to). When they do
/// not all fit, the strip scrolls so the active tab is always in it.
fn tab_spans(app: &App, limit: u16) -> (Vec<(usize, u16, u16)>, bool, bool) {
    let widths: Vec<u16> = (0..app.tabs.len()).map(|index| {
        let (name, mark) = tab_label(app, index);
        (format!(" {} ", index + 1).width() + name.width() + 1 + if mark.is_some() { 2 } else { 0 }) as u16
    }).collect();
    let room = limit.saturating_sub(10 + 2);
    // Skip tabs from the left until the active one fits.
    let mut first = 0;
    while first < app.active && widths[first..=app.active].iter().sum::<u16>() > room { first += 1 }
    let mut x = 10 + if first > 0 { 2 } else { 0 };
    let mut out = Vec::new();
    let mut clipped = false;
    for index in first..app.tabs.len() {
        if x + widths[index] > limit { clipped = true; break }
        out.push((index, x, x + widths[index]));
        x += widths[index];
    }
    (out, first > 0, clipped)
}

pub fn tab_at(app: &App, x: u16) -> Option<usize> {
    app.tab_hits.iter().find(|(_, from, to)| x >= *from && x < *to).map(|(i, _, _)| *i)
}

fn tab_strip(buf: &mut Buffer, app: &mut App, area: Rect) {
    buf.set_style(area, Style::default());
    buf.set_string(0, 0, " ▍", fg(theme::ACCENT));
    buf.set_string(2, 0, "harness", bold(theme::ACCENT));
    // Right side first, so tabs can stop short of it.
    let mut right: Vec<Span> = Vec::new();
    let waiting = app.fleet.waiting();
    let working = app.fleet.working();
    if app.daemon_down { right.push(Span::styled("daemon not running — harness start  ", bold(theme::DANGER))) }
    if waiting > 0 { right.push(Span::styled(format!("◆ {waiting} need{} input  ", if waiting == 1 { "s" } else { "" }), bold(theme::ATTENTION))) }
    if working > 0 { right.push(Span::styled(format!("{} {working} working  ", theme::spinner(app.tick)), fg(theme::ACCENT_SOFT))) }
    right.push(Span::styled(format!("{} running  ", app.fleet.running()), fg(theme::MUTED)));
    let up = app.fleet.machines.iter().filter(|m| m.usable()).count();
    let all = app.fleet.machines.len().max(1);
    right.push(Span::styled(format!("▣ {up}/{all} ", ), fg(if up == all { theme::ONLINE } else { theme::SOFT })));
    let right_w: u16 = right.iter().map(|s| s.content.width() as u16).sum();
    let right_x = area.width.saturating_sub(right_w);
    let mut x = right_x;
    for span in &right { buf.set_string(x, 0, span.content.as_ref(), span.style); x += span.content.width() as u16 }
    let (spans, before, after) = tab_spans(app, right_x.saturating_sub(3));
    if before { buf.set_string(10, 0, "‹ ", fg(theme::MUTED)); }
    if after { if let Some((_, _, to)) = spans.last() { buf.set_string(*to, 0, " ›", fg(theme::MUTED)); } }
    app.tab_hits = spans.clone();
    for (index, from, _to) in spans {
        let (name, mark) = tab_label(app, index);
        let active = index == app.active;
        let base = if active { Style::default().bg(theme::SELECT).fg(theme::TEXT).add_modifier(Modifier::BOLD) } else { fg(theme::SOFT) };
        let mut x = from;
        let num = format!(" {} ", index + 1);
        buf.set_string(x, 0, &num, if active { base.fg(theme::ACCENT_SOFT) } else { fg(theme::MUTED) });
        x += num.width() as u16;
        if let Some((m, color)) = mark {
            buf.set_string(x, 0, format!("{m} "), if active { base.fg(color) } else { fg(color) });
            x += 2;
        }
        buf.set_string(x, 0, format!("{name} "), base);
    }
}

// ── a tile ───────────────────────────────────────────────────────────────────

fn header(buf: &mut Buffer, fleet: &crate::fleet::Fleet, pane: &Pane, rect: Rect, active: bool, many: bool, tick: u64) {
    let y = rect.y;
    let line_style = fg(if active && many { theme::ACCENT } else { theme::LINE });
    for x in rect.x..rect.x + rect.width { if let Some(c) = buf.cell_mut((x, y)) { c.set_symbol("─").set_style(line_style); } }
    let agent = fleet.agent(&pane.machine_id, &pane.agent_id);
    let mut spans: Vec<Span> = vec![Span::styled(if active && many { "━━ " } else { "── " }, line_style)];
    if let Some(agent) = agent {
        let (mark, color) = engine_mark(&agent.engine);
        spans.push(Span::styled(format!("{mark} "), fg(color)));
        spans.push(Span::styled(agent.name.clone(), if active { bold(Color::Reset) } else { fg(theme::SOFT) }));
        let state = fleet.state_of(agent);
        let (dot, word, color) = state_mark(state);
        let dot = if state == State::Working { theme::spinner(tick) } else { dot };
        spans.push(Span::styled(format!("  {dot} {word}"), fg(color)));
        if let Some(q) = &agent.question { spans.push(Span::styled(format!("  {}", q.prompt), fg(theme::ATTENTION))) }
    } else {
        spans.push(Span::styled(pane.agent_id.chars().take(8).collect::<String>(), fg(theme::SOFT)));
    }
    spans.push(Span::raw(" "));
    let machine = fleet.machine(&pane.machine_id);
    let right = match (&pane.phase, machine) {
        (Phase::Watching(who), _) => format!(" watching{} · type to take over ", if who.is_empty() { String::new() } else { format!(" — {who} has it") }),
        (_, Some(m)) if fleet.machines.len() > 1 => format!(" {} ", m.name),
        _ => String::new(),
    };
    let scrolled = pane.scrolled();
    let right = if scrolled > 0 { format!(" ↑{scrolled} ⇧PgDn {right}") } else { right };
    // What typing here costs, measured: keystroke out → first echo back (p50).
    let right = match pane.echo_ms() {
        Some((p50, _)) if active => format!(" {}{right}", if p50 < 10.0 { format!("{p50:.1}ms ") } else { format!("{p50:.0}ms ") }),
        _ => right,
    };
    let right_w = right.width() as u16;
    let mut x = rect.x;
    let limit = rect.x + rect.width.saturating_sub(right_w + 1);
    for span in spans {
        if x >= limit { break }
        let room = (limit - x) as usize;
        let text: String = if span.content.width() > room { let mut t = String::new(); for ch in span.content.chars() { if t.width() + 2 > room { break } t.push(ch) } t + "…" } else { span.content.to_string() };
        buf.set_string(x, y, &text, span.style);
        x += text.width() as u16;
    }
    if right_w > 0 && rect.width > right_w + 4 {
        let color = if matches!(pane.phase, Phase::Watching(_)) { theme::WARN } else { theme::MUTED };
        buf.set_string(rect.x + rect.width - right_w, y, &right, fg(color));
    }
}

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
fn pane_body(buf: &mut Buffer, pane: &mut Pane, area: Rect, active: bool) -> Option<Position> {
    match &pane.phase {
        Phase::Connecting(note) => { card(buf, area, &[(format!("◌ {note}"), fg(theme::ACCENT_SOFT))]); return None }
        Phase::Card { title, detail, keys } => {
            let mut lines = vec![(title.clone(), bold(theme::ATTENTION))];
            for row in detail.lines() { lines.push((row.to_string(), fg(theme::SOFT))) }
            lines.push((String::new(), Style::default()));
            lines.push((keys.iter().map(|(k, w)| format!("{k} {w}")).collect::<Vec<_>>().join("   "), fg(theme::ACCENT_SOFT)));
            card(buf, area, &lines);
            return None;
        }
        _ => {}
    }
    let content = pane.term.renderable_content();
    let offset = content.display_offset as i32;
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
        if selection.map(|r| r.contains(indexed.point)).unwrap_or(false) { style = style.bg(theme::SELECT_TEXT).fg(theme::TEXT) }
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
    // Copy mode's cursor: a block over the cell it is on.
    if let Some(copy) = pane.copy {
        let row = copy.point.line.0 + pane.term.grid().display_offset() as i32;
        let col = copy.point.column.0 as u16;
        if row >= 0 && (row as u16) < area.height && col < area.width {
            if let Some(cell) = buf.cell_mut((area.x + col, area.y + row as u16)) { let st = cell.style(); cell.set_style(st.bg(theme::WARN).fg(Color::Black)); }
        }
    }
    // Local echo, drawn over the grid: underlined until the far side confirms it.
    for (col, row, c, _) in &pane.predictions {
        if let Some(cell) = buf.cell_mut((area.x + col, area.y + row)) {
            if *col < area.width && *row < area.height { cell.set_char(*c).set_style(Style::default().add_modifier(Modifier::UNDERLINED)); }
        }
    }
    if pane.scrolled() > 0 || !active { return None }
    if let Some((col, row, _, _)) = pane.predictions.last() {
        if col + 1 < area.width && *row < area.height { return Some(Position::new(area.x + col + 1, area.y + row)) }
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

// ── home: an empty tab ───────────────────────────────────────────────────────

const WORDMARK: [&str; 2] = ["█ █ ▄▀█ █▀█ █▄ █ █▀▀ █▀ █▀", "█▀█ █▀█ █▀▄ █ ▀█ ██▄ ▄█ ▄█"];

fn home(buf: &mut Buffer, app: &App, area: Rect) {
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
    let top = area.y + area.height.saturating_sub(lines.len() as u16) / 2;
    for (index, line) in lines.iter().enumerate() {
        let y = top + index as u16;
        if y >= area.y + area.height { break }
        let w = line.width() as u16;
        let x = if index < centered { area.x + area.width.saturating_sub(w) / 2 } else { left };
        buf.set_line(x, y, line, area.width.saturating_sub(x - area.x));
    }
}

// ── overlays ─────────────────────────────────────────────────────────────────


/// The launcher, docked at the bottom the way fzf draws with `--height`: the panes stay in view
/// above it, the prompt is the last line, the best match sits right above the prompt, and the
/// count reads `4/7`. Full width, no card — a terminal's own furniture.
fn picker_box(buf: &mut Buffer, area: Rect, picker: &mut Picker) {
    let want = (picker.visible.len() as u16 + picker.visible.len().min(12) as u16 / 3 + 3).max(10);
    let h = want.min((area.height * 11 / 20).max(12)).min(area.height.saturating_sub(1));
    let rect = Rect::new(area.x, area.y + area.height - h, area.width, h);
    dim_backdrop(buf, Rect::new(area.x, area.y, area.width, area.height - h));
    Clear.render(rect, buf);
    buf.set_style(rect, Style::default().bg(theme::PANEL));
    let width = rect.width as usize;
    // Top rule: title on the left, the keys on the right — fzf's --header, in one line.
    let rule_y = rect.y;
    for x in rect.x..rect.x + rect.width { if let Some(c) = buf.cell_mut((x, rule_y)) { c.set_symbol("─").set_style(fg(theme::LINE).bg(theme::PANEL)); } }
    let title = format!(" {} ", picker.title);
    buf.set_string(rect.x + 1, rule_y, &title, bold(theme::ACCENT_SOFT).bg(theme::PANEL));
    let hint_line: Line = if let Some((text, _)) = &picker.flash { Line::styled(format!(" {text} "), bold(theme::ONLINE).bg(theme::PANEL)) } else {
        let mut spans = Vec::new();
        let mut used = title.width() + 4;
        for (k, w) in picker.hints.iter().chain([("esc", "close")].iter()) {
            let piece = k.width() + w.width() + 3;
            if used + piece > width { break }
            used += piece;
            spans.push(Span::styled(format!(" {k}"), bold(theme::ACCENT).bg(theme::PANEL)));
            spans.push(Span::styled(format!(" {w} "), fg(theme::SOFT).bg(theme::PANEL)));
        }
        Line::from(spans)
    };
    let hint_w = hint_line.width() as u16;
    buf.set_line(rect.x + rect.width.saturating_sub(hint_w + 1), rule_y, &hint_line, hint_w);
    // The list, bottom-up: groups keep their heading on top, the first group sits nearest the prompt.
    let body_h = rect.height.saturating_sub(2) as usize;
    let searching = !picker.query.trim().is_empty();
    let mut groups: Vec<(Option<String>, Vec<usize>)> = Vec::new();
    for (vi, (ri, _)) in picker.visible.iter().enumerate() {
        let g = if searching { None } else { picker.rows[*ri].group.clone() };
        match groups.last_mut() { Some((last, list)) if *last == g => list.push(vi), _ => groups.push((g, vec![vi])) }
    }
    let mut lines: Vec<(Option<usize>, Line)> = Vec::new();
    for (g, list) in groups.iter().rev() {
        if let Some(g) = g { lines.push((None, Line::styled(format!("  {}", g.to_uppercase()), bold(theme::MUTED).bg(theme::PANEL)))) }
        for vi in list.iter().rev() { lines.push((Some(*vi), picker_row(picker, *vi, width))) }
    }
    let n = lines.len();
    let cursor_line = lines.iter().position(|(v, _)| *v == Some(picker.cursor)).unwrap_or(n.saturating_sub(1));
    // `scroll` counts from the bottom: 0 shows the last `body_h` lines.
    let from_bottom = n.saturating_sub(1).saturating_sub(cursor_line);
    if from_bottom < picker.scroll { picker.scroll = from_bottom }
    if from_bottom >= picker.scroll + body_h { picker.scroll = from_bottom + 1 - body_h }
    let end = n.saturating_sub(picker.scroll);
    let start = end.saturating_sub(body_h);
    let top = rect.y + 1 + (body_h - (end - start)) as u16;
    if n == 0 { buf.set_string(rect.x + 2, rect.y + rect.height - 2, &picker.empty, fg(theme::MUTED).bg(theme::PANEL)); }
    picker.row_at.clear();
    for (i, (vi, line)) in lines[start..end].iter().enumerate() {
        buf.set_line(rect.x, top + i as u16, line, rect.width);
        if let Some(vi) = vi { picker.row_at.push((top + i as u16, *vi)) }
    }
    // The prompt: mode ❯ query▏            4/7  status
    let y = rect.y + rect.height - 1;
    let total = picker.rows.iter().filter(|r| !r.disabled).count();
    let count = format!("{}/{}", picker.visible.len(), total);
    let right = if picker.status.is_empty() { format!(" {count} ") } else { format!(" {}  {count} ", picker.status) };
    let busy = picker.busy.as_ref().map(|b| format!("  {b}")).unwrap_or_default();
    let mut spans = vec![Span::styled(" ❯ ", bold(theme::ACCENT).bg(theme::PANEL))];
    if picker.query.is_empty() { spans.push(Span::styled(picker.placeholder.clone(), fg(theme::MUTED).bg(theme::PANEL))) }
    else { spans.push(Span::styled(picker.query.clone(), fg(theme::TEXT).bg(theme::PANEL))) }
    spans.push(Span::styled(busy, fg(theme::MUTED).bg(theme::PANEL)));
    buf.set_line(rect.x, y, &Line::from(spans), rect.width);
    let rw = right.width() as u16;
    if rw + 20 < rect.width { buf.set_string(rect.x + rect.width - rw, y, &right, fg(theme::MUTED).bg(theme::PANEL)); }
    picker.cursor_pos = Some(Position::new(rect.x + 3 + picker.query.width() as u16, y));
}

/// One row of the launcher: pointer, lead marks, the label lit where the query matched, the
/// detail (cut to fit), the right column when there is room.
fn picker_row(picker: &Picker, vi: usize, width: usize) -> Line<'static> {
    let (ri, hits) = &picker.visible[vi];
    let row = &picker.rows[*ri];
    let selected = vi == picker.cursor;
    let base = if selected { Style::default().bg(theme::SELECT) } else { Style::default().bg(theme::PANEL) };
    let mut spans: Vec<Span> = vec![Span::styled(if selected { "▌ " } else { "  " }, base.fg(theme::ACCENT))];
    for s in &row.lead { spans.push(Span::styled(s.content.clone(), s.style.patch(Style { bg: base.bg, ..Style::default() }))) }
    let label_style = base.fg(theme::TEXT).add_modifier(if selected { Modifier::BOLD } else { Modifier::empty() });
    let hit_style = base.fg(theme::ACCENT_SOFT).add_modifier(Modifier::BOLD);
    let mut current = String::new();
    let mut lit = false;
    for (i, ch) in row.label.chars().enumerate() {
        let on = hits.contains(&(i as u32));
        if on != lit && !current.is_empty() { spans.push(Span::styled(std::mem::take(&mut current), if lit { hit_style } else { label_style })) }
        lit = on;
        current.push(ch);
    }
    if !current.is_empty() { spans.push(Span::styled(current, if lit { hit_style } else { label_style })) }
    let right_w = row.right.width();
    let head_w: usize = spans.iter().map(|s| s.content.width()).sum();
    let show_right = head_w + right_w + 4 <= width;
    let detail_room = width.saturating_sub(head_w + 2 + if show_right { right_w + 2 } else { 1 });
    spans.push(Span::styled("  ", base));
    let mut left = detail_room;
    for s in &row.detail {
        if left == 0 { break }
        let text = clip(&s.content, left);
        left = left.saturating_sub(text.width());
        spans.push(Span::styled(text, s.style.patch(Style { bg: base.bg, ..Style::default() })));
    }
    let used: usize = spans.iter().map(|s| s.content.width()).sum();
    if show_right && used + right_w + 1 <= width {
        spans.push(Span::styled(" ".repeat(width - used - right_w - 1), base));
        spans.push(Span::styled(row.right.clone(), base.fg(theme::MUTED)));
        spans.push(Span::styled(" ", base));
    } else { spans.push(Span::styled(" ".repeat(width.saturating_sub(used)), base)) }
    Line::from(spans)
}

/// Everything behind an overlay steps back, so the overlay is the one thing in front.
fn dim_backdrop(buf: &mut Buffer, area: Rect) {
    for y in area.y..area.y + area.height {
        for x in area.x..area.x + area.width {
            if let Some(cell) = buf.cell_mut((x, y)) {
                let style = cell.style();
                cell.set_style(style.fg(theme::MUTED).add_modifier(Modifier::DIM));
            }
        }
    }
}

/// [text] cut to [cols] display columns, with an ellipsis when cut.
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

/// A one-line question (rename, first message, send, a password), docked where the launcher's
/// prompt is: a rule with the title, the hint, the input.
fn prompt_box(buf: &mut Buffer, area: Rect, prompt: &crate::modal::Prompt) -> Position {
    let h: u16 = if prompt.hint.is_empty() { 2 } else { 3 };
    let rect = Rect::new(area.x, area.y + area.height.saturating_sub(h), area.width, h);
    dim_backdrop(buf, Rect::new(area.x, area.y, area.width, area.height.saturating_sub(h)));
    Clear.render(rect, buf);
    buf.set_style(rect, Style::default().bg(theme::PANEL));
    for x in rect.x..rect.x + rect.width { if let Some(c) = buf.cell_mut((x, rect.y)) { c.set_symbol("─").set_style(fg(theme::LINE).bg(theme::PANEL)); } }
    let title = format!(" {} ", prompt.title);
    buf.set_string(rect.x + 1, rect.y, &title, bold(theme::ACCENT_SOFT).bg(theme::PANEL));
    let keys = " enter ok  esc cancel ";
    buf.set_string(rect.x + rect.width.saturating_sub(keys.width() as u16 + 1), rect.y, keys, fg(theme::SOFT).bg(theme::PANEL));
    if !prompt.hint.is_empty() { buf.set_stringn(rect.x + 3, rect.y + 1, &prompt.hint, rect.width as usize - 4, fg(theme::MUTED).bg(theme::PANEL)); }
    let y = rect.y + rect.height - 1;
    let shown: String = if prompt.secret { "•".repeat(prompt.value.chars().count()) } else { prompt.value.clone() };
    let room = rect.width.saturating_sub(5) as usize;
    let visible: String = if shown.width() > room { shown.chars().rev().take(room).collect::<Vec<_>>().into_iter().rev().collect() } else { shown };
    buf.set_string(rect.x, y, " ❯ ", bold(theme::ACCENT).bg(theme::PANEL));
    if visible.is_empty() { buf.set_stringn(rect.x + 3, y, &prompt.label, room, fg(theme::MUTED).bg(theme::PANEL)); }
    else { buf.set_string(rect.x + 3, y, &visible, fg(theme::TEXT).bg(theme::PANEL)); }
    Position::new(rect.x + 3 + visible.width() as u16, y)
}

/// ⌥F's bar, in the pane's header line: what is being looked for and whether it is there.
fn find_bar(buf: &mut Buffer, pane: Rect, query: &str, found: Option<bool>) -> Position {
    let status = match found { Some(false) if !query.is_empty() => "  no more", _ => "" };
    let text = format!(" find: {query}");
    let hint = "  ↑ older  ↓ newer  esc done ";
    let w = (text.width() + status.width() + hint.width()) as u16;
    let x = pane.x + pane.width.saturating_sub(w + 1);
    let style = Style::default().bg(theme::SELECT).fg(theme::TEXT);
    buf.set_string(x, pane.y, &text, style.add_modifier(Modifier::BOLD));
    let after = x + text.width() as u16;
    buf.set_string(after, pane.y, status, style.fg(theme::ATTENTION));
    buf.set_string(after + status.width() as u16, pane.y, hint, style.fg(theme::SOFT));
    Position::new(after, pane.y)
}

fn toast(buf: &mut Buffer, area: Rect, text: &str, color: Color) {
    let w = (text.width() as u16 + 4).min(area.width);
    let rect = Rect::new(area.width.saturating_sub(w + 1), area.height.saturating_sub(2), w, 1);
    Clear.render(rect, buf);
    Paragraph::new(Line::from(vec![Span::styled(format!("  {text}  "), Style::default().fg(color).bg(theme::PANEL).add_modifier(Modifier::BOLD))])).render(rect, buf);
}

