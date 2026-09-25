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
use ratatui::widgets::{Block, BorderType, Borders, Clear, Paragraph, Widget};
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
    if let Some(modal) = &mut app.modal {
        cursor = None;
        match modal {
            Modal::Picker { picker, .. } => picker_box(buf, area, picker),
            Modal::Prompt(prompt) => cursor = Some(prompt_box(buf, area, prompt)),
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

/// Where each tab sits in the strip: (index, x from, x to).
fn tab_spans(app: &App) -> Vec<(usize, u16, u16)> {
    let mut x = 10u16;
    let mut out = Vec::new();
    for index in 0..app.tabs.len() {
        let (name, mark) = tab_label(app, index);
        let w = (format!(" {} ", index + 1).width() + name.width() + 1 + if mark.is_some() { 2 } else { 0 }) as u16;
        out.push((index, x, x + w));
        x += w;
    }
    out
}

pub fn tab_at(app: &App, x: u16) -> Option<usize> {
    tab_spans(app).into_iter().find(|(_, from, to)| x >= *from && x < *to).map(|(i, _, _)| i)
}

fn tab_strip(buf: &mut Buffer, app: &App, area: Rect) {
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
    for (index, from, to) in tab_spans(app) {
        if to > right_x.saturating_sub(1) { buf.set_string(from, 0, " …", fg(theme::MUTED)); break }
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
        spans.push(Span::styled(agent.name.clone(), if active { bold(theme::TEXT) } else { fg(theme::SOFT) }));
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
    if pane.scrolled() > 0 || !active { return None }
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
                Span::styled(format!("{name:<name_w$}  "), bg.fg(theme::TEXT).add_modifier(Modifier::BOLD)),
                Span::styled(detail_text, bg.fg(detail.1)),
                Span::styled(" ".repeat(pad), bg),
                Span::styled(right, bg.fg(theme::MUTED)),
            ]));
        }
    }
    lines.push(Line::raw(""));
    let keys = [("↵", "open"), ("o", "open…"), ("n", "new"), ("t", "terminal"), ("i", "needs input"), ("b", "send"), ("m", "machines"), ("s", "store"), ("p", "commands"), ("/", "keys")];
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

fn overlay_rect(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width.saturating_sub(4)).max(20.min(area.width));
    let h = h.min(area.height.saturating_sub(2));
    Rect::new(area.x + (area.width - w) / 2, area.y + 2.min(area.height.saturating_sub(h)), w, h)
}

fn picker_box(buf: &mut Buffer, area: Rect, picker: &mut Picker) {
    let want_h = (picker.visible.len() as u16 + picker.visible.len().min(8) as u16 / 2 + 6).clamp(10, area.height * 3 / 4);
    let rect = overlay_rect(area, (area.width * 4 / 5).clamp(60, 120), want_h);
    Clear.render(rect, buf);
    let block = Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(fg(theme::ACCENT))
        .title(Line::from(vec![Span::styled(format!(" {} ", picker.title), bold(theme::ACCENT_SOFT))]))
        .title(Line::from(Span::styled(format!(" {} ", picker.status), fg(theme::MUTED))).right_aligned())
        .style(Style::default().bg(theme::PANEL));
    let inner = block.inner(rect);
    block.render(rect, buf);
    // Query line.
    let busy = picker.busy.as_ref().map(|b| format!("  {b}")).unwrap_or_default();
    let query_line = if picker.query.is_empty() {
        Line::from(vec![Span::styled("❯ ", bold(theme::ACCENT)), Span::styled(picker.placeholder.clone(), fg(theme::MUTED)), Span::styled(busy, fg(theme::MUTED))])
    } else {
        Line::from(vec![Span::styled("❯ ", bold(theme::ACCENT)), Span::styled(picker.query.clone(), fg(theme::TEXT)), Span::styled("▏", fg(theme::ACCENT)), Span::styled(busy, fg(theme::MUTED))])
    };
    buf.set_line(inner.x + 1, inner.y, &query_line, inner.width.saturating_sub(2));
    for x in inner.x..inner.x + inner.width { if let Some(c) = buf.cell_mut((x, inner.y + 1)) { c.set_symbol("─").set_style(fg(theme::LINE).bg(theme::PANEL)); } }
    // Rows (with group headings when not searching).
    let body = Rect::new(inner.x, inner.y + 2, inner.width, inner.height.saturating_sub(3));
    let mut lines: Vec<(Option<usize>, Line)> = Vec::new();
    let searching = !picker.query.trim().is_empty();
    let mut last_group: Option<&str> = None;
    for (vi, (ri, hits)) in picker.visible.iter().enumerate() {
        let row = &picker.rows[*ri];
        if !searching {
            if let Some(g) = row.group.as_deref() {
                if last_group != Some(g) { lines.push((None, Line::styled(format!(" {}", g.to_uppercase()), bold(theme::MUTED)))); last_group = Some(g) }
            }
        }
        let selected = vi == picker.cursor;
        let base = if selected { Style::default().bg(theme::SELECT) } else { Style::default().bg(theme::PANEL) };
        let mut spans: Vec<Span> = vec![Span::styled(if selected { "▍" } else { " " }, base.fg(theme::ACCENT))];
        for s in &row.lead { spans.push(Span::styled(s.content.clone(), s.style.patch(base.bg.map(|b| Style::default().bg(b)).unwrap_or_default()))) }
        // The label, matched characters lit.
        let label_style = base.fg(theme::TEXT).add_modifier(if selected { Modifier::BOLD } else { Modifier::empty() });
        let mut current = String::new();
        let mut lit = false;
        for (i, ch) in row.label.chars().enumerate() {
            let on = hits.contains(&(i as u32));
            if on != lit && !current.is_empty() {
                spans.push(Span::styled(std::mem::take(&mut current), if lit { base.fg(theme::ACCENT_SOFT).add_modifier(Modifier::BOLD | Modifier::UNDERLINED) } else { label_style }));
            }
            lit = on;
            current.push(ch);
        }
        if !current.is_empty() { spans.push(Span::styled(current, if lit { base.fg(theme::ACCENT_SOFT).add_modifier(Modifier::BOLD | Modifier::UNDERLINED) } else { label_style })) }
        spans.push(Span::styled("  ", base));
        for s in &row.detail { spans.push(Span::styled(s.content.clone(), s.style.patch(Style { bg: base.bg, ..Style::default() }))) }
        let used: usize = spans.iter().map(|s| s.content.width()).sum();
        let right_w = row.right.width();
        let room = body.width as usize;
        if used + right_w + 2 < room { spans.push(Span::styled(" ".repeat(room - used - right_w - 1), base)); spans.push(Span::styled(row.right.clone(), base.fg(theme::MUTED))); spans.push(Span::styled(" ", base)) }
        else { spans.push(Span::styled(" ".repeat(room.saturating_sub(used)), base)) }
        lines.push((Some(vi), Line::from(spans)));
    }
    let cursor_line = lines.iter().position(|(v, _)| *v == Some(picker.cursor)).unwrap_or(0);
    let h = body.height as usize;
    if cursor_line < picker.scroll { picker.scroll = cursor_line.saturating_sub(if cursor_line > 0 && lines[cursor_line - 1].0.is_none() { 1 } else { 0 }) }
    if cursor_line >= picker.scroll + h { picker.scroll = cursor_line + 1 - h }
    picker.scroll = picker.scroll.min(lines.len().saturating_sub(h));
    if lines.is_empty() {
        buf.set_string(body.x + 2, body.y, &picker.empty, fg(theme::MUTED));
    }
    for (i, (_, line)) in lines.iter().skip(picker.scroll).take(h).enumerate() {
        buf.set_line(body.x, body.y + i as u16, line, body.width);
    }
    // Key line.
    let hint_y = inner.y + inner.height.saturating_sub(1);
    let hint: Line = if let Some((text, _)) = &picker.flash { Line::styled(format!(" {text}"), fg(theme::ONLINE)) } else {
        let mut spans = Vec::new();
        for (k, w) in picker.hints.iter().chain([("esc", "close")].iter()) {
            spans.push(Span::styled(format!(" {k}"), bold(theme::ACCENT)));
            spans.push(Span::styled(format!(" {w}  "), fg(theme::SOFT)));
        }
        Line::from(spans)
    };
    buf.set_line(inner.x, hint_y, &hint, inner.width);
}

fn prompt_box(buf: &mut Buffer, area: Rect, prompt: &crate::modal::Prompt) -> Position {
    let rect = overlay_rect(area, 76, 8);
    Clear.render(rect, buf);
    let block = Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(fg(theme::ACCENT))
        .title(Span::styled(format!(" {} ", prompt.title), bold(theme::ACCENT_SOFT))).style(Style::default().bg(theme::PANEL));
    let inner = block.inner(rect);
    block.render(rect, buf);
    buf.set_string(inner.x + 1, inner.y, &prompt.label, fg(theme::SOFT));
    let shown: String = if prompt.secret { "•".repeat(prompt.value.chars().count()) } else { prompt.value.clone() };
    let room = inner.width.saturating_sub(5) as usize;
    let visible: String = if shown.width() > room { shown.chars().rev().take(room).collect::<Vec<_>>().into_iter().rev().collect() } else { shown };
    buf.set_string(inner.x + 1, inner.y + 2, "❯ ", bold(theme::ACCENT));
    buf.set_string(inner.x + 3, inner.y + 2, &visible, fg(theme::TEXT));
    if !prompt.hint.is_empty() { buf.set_stringn(inner.x + 1, inner.y + 4, &prompt.hint, inner.width as usize - 2, fg(theme::MUTED)); }
    let keys = Line::from(vec![Span::styled(" enter", bold(theme::ACCENT)), Span::styled(" ok   ", fg(theme::SOFT)), Span::styled("esc", bold(theme::ACCENT)), Span::styled(" cancel", fg(theme::SOFT))]);
    buf.set_line(inner.x, inner.y + inner.height.saturating_sub(1), &keys, inner.width);
    Position::new(inner.x + 3 + visible.width() as u16, inner.y + 2)
}

fn toast(buf: &mut Buffer, area: Rect, text: &str, color: Color) {
    let w = (text.width() as u16 + 4).min(area.width);
    let rect = Rect::new(area.width.saturating_sub(w + 1), area.height.saturating_sub(2), w, 1);
    Clear.render(rect, buf);
    Paragraph::new(Line::from(vec![Span::styled(format!("  {text}  "), Style::default().fg(color).bg(theme::PANEL).add_modifier(Modifier::BOLD))])).render(rect, buf);
}

