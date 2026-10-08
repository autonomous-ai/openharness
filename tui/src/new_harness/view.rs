//! Terminal rendering of the compact desktop form.
use super::*;
use ratatui::{text::{Line, Span}, widgets::{Block, Clear, Padding, Paragraph, StatefulWidget, Widget}};
use unicode_segmentation::UnicodeSegmentation;

// Keep the recovery instruction readable, including long project names and wide glyphs.
pub(super) fn error_lines(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.width() + 1 + word.width() > width {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        for glyph in word.graphemes(true) {
            if !line.is_empty() && line.width() + glyph.width() > width {
                lines.push(std::mem::take(&mut line));
            }
            line.push_str(glyph);
        }
    }
    lines.push(line);
    lines
}

pub(super) fn put(buf: &mut Buffer, x: u16, y: u16, width: u16, text: &str, style: Style) {
    if width == 0 {
        return;
    }
    let mut out = String::new();
    let mut used = 0;
    let limit = width as usize;
    let trunc = text.width() > limit;
    for ch in text.graphemes(true).filter(|g| !g.chars().any(char::is_control)) {
        let w = ch.width();
        if used + w > limit.saturating_sub(usize::from(trunc)) {
            break;
        }
        out.push_str(ch);
        used += w;
    }
    if trunc {
        out.push('…');
    }
    buf.set_stringn(x, y, out, width as usize, style);
}

/// The form's height: enough rows for every agent's settings, the same whatever is open, so
/// changing agents or opening an editor never moves it.
pub(super) const HEIGHT: u16 = 19;

/// The form's surface, as the settings panel draws its own: filled, no border.
fn panel(buf: &mut Buffer, r: Rect, base: Style) {
    crate::settings::fill(buf, r, base)
}

pub fn draw(buf: &mut Buffer, body: Rect, form: &mut Form) -> Option<Position> {
    form.hits.clear();
    form.area = Rect::default();
    form.child_area = Rect::default();
    form.task_area = Rect::default();
    if body.width < 22 || body.height < 5 {
        put(
            buf,
            body.x,
            body.y,
            body.width,
            "New Harness · resize or Esc",
            Style::default(),
        );
        return None;
    }
    let page = matches!(form.surface, Surface::Window(_));
    let crate::settings::Chrome { base, muted, accent, backdrop, selected, .. } = crate::settings::chrome();
    if page {
        panel(buf, body, Style::default().bg(ratatui::style::Color::Reset).fg(ratatui::style::Color::Reset));
    } else { crate::settings::backdrop(buf, body, backdrop); }
    // Only the terminal's size changes this anchor. Task wrapping, history, and choosers do not.
    let r = crate::settings::area(body, crate::settings::PanelSize::Form, if page { 28 } else { HEIGHT });
    let (x, y, form_w, form_h) = (r.x, r.y, r.width, r.height);
    let spacious = if page { form_h >= 27 } else { form_h >= HEIGHT };
    let task_h = if spacious { 3 } else if page && form_h >= 21 { 2 } else { 1 };
    let mut task_cursor = None;
    let fields_y = y + if spacious { if page { 4 } else { 3 } } else if form_h >= 9 { 2 } else { 1 };
    let live_error = task::error(&form.draft.what.engine, &form.draft.task);
    // (While a chooser is dropped down its error is in it, in place of its keys: not twice.)
    let dropped = form.child.is_some() && form.child_active;
    let message = if form.error.is_empty() || dropped { live_error.as_deref().unwrap_or("") } else { &form.error };
    let errors = error_lines(message, form_w.saturating_sub(4) as usize);
    let footer_h = if message.is_empty() { 2 } else { errors.len().max(2) as u16 }
        .min(r.bottom().saturating_sub(fields_y + 1 + u16::from(spacious)).max(1));
    let footer_y = r.bottom().saturating_sub(footer_h + u16::from(spacious));
    form.area = r;
    let capacity = footer_y.saturating_sub(fields_y);
    let mut row: u16 = 0;
    let mut recent_header = None;
    let rows: Vec<_> = form.fields().into_iter().map(|field| {
        if spacious && matches!(field, Field::Branch | Field::Create) { row += 1; }
        if page && field == Field::Browse {
            if spacious { row += 1; }
            recent_header = Some(row);
        }
        let at = row;
        row += if field == Field::Task { task_h } else if page && field == Field::Browse { 2 } else { 1 };
        (at, field)
    }).collect();
    let focus = rows.iter().find(|(_, field)| *field == form.focus).map(|(row, _)| *row).unwrap_or(0);
    let skip = focus.saturating_sub(capacity.saturating_sub(1));
    // An entered chooser drops down under its field (under the task's text when `@ : %` opened
    // it there). Where too few rows are left it covers the form, as it always did when narrow.
    let under = rows.iter().find(|(row, field)| *field == form.focus && *row >= skip && *row < skip + capacity)
        .map(|(row, field)| {
            let fy = fields_y + row - skip;
            fy + if *field == Field::Task { task_h.min(footer_y.saturating_sub(fy)) } else { 1 }
        });
    let chooser = form.child.as_ref().filter(|_| form.child_active)
        .map(|c| under.and_then(|at| dropdown(c, x + 1, at, form_w - 2, r.bottom() - 1)).unwrap_or(r));
    if chooser != Some(r) {
        panel(buf, r, base);
        if form_h >= 9 {
            let title = if page { if form.first_run { "Welcome to Harness" } else { "New Window" } } else { "New Harness" };
            put(buf, x + 3, y + u16::from(spacious), form_w - 6, title, base.add_modifier(Modifier::BOLD));
            if page && spacious {
                put(buf, x + 3, y + 2, form_w - 6, "Start a task. Your agent takes it from here.", muted);
            }
        }
        if let Some(row) = recent_header.filter(|row| *row >= skip && *row < skip + capacity) {
            put(buf, x + 3, fields_y + row - skip, form_w.saturating_sub(12), &form.recent_status, muted);
        }
        for (row, field) in rows.into_iter().filter(|(row, _)| *row >= skip && *row < skip + capacity) {
            let fy = fields_y + row - skip;
            let active = field == form.focus;
            let st = if form.blocked(field).is_some() { muted } else if active { accent } else { base };
            let (label, value) = form.describe(field);
            if page && field == Field::Browse {
                let hit = Rect::new(r.right() - 6, fy, 3, 1);
                put(buf, hit.x, hit.y, hit.width, "All", st);
                form.hits.push((hit, field));
                continue;
            }
            put(buf, x + 1, fy, 1, if active { "›" } else { " " }, accent);
            let label_w = if form_w < 45 { 10 } else { 12 };
            let action = matches!(field, Field::Create | Field::Terminal | Field::Browse);
            let recent = matches!(field, Field::Recent(_));
            let height = if field == Field::Task { task_h.min(footer_y.saturating_sub(fy)) } else { 1 };
            if !recent {
                put(buf, x + 3, fy, if action { form_w - 6 } else { label_w }, &label,
                    if field == Field::Create { st.add_modifier(Modifier::BOLD) } else if action { st } else { muted });
            }
            let value_width = form_w.saturating_sub(6 + label_w);
            let value_x = x + 3 + label_w;
            if field == Field::Task && (task::supported(&form.draft.what.engine) || !form.draft.task.is_empty()) {
                form.task_area = Rect::new(value_x, fy, value_width, height);
                task_cursor = form.task_editor.draw(buf, form.task_area, &form.draft.task,
                    active && !form.child_active && !form.starting && form.attempt.is_none(), base, muted);
            } else if field == Field::Project && !page {
                let suffix = format!(" @ {}", form.machine_label);
                let suffix_width = suffix.width() as u16;
                if value_width > suffix_width + 2 {
                    let name = form.project_name();
                    let name_width = (name.width() as u16).min(value_width - suffix_width);
                    put(buf, value_x, fy, name_width, &name, st);
                    put(buf, value_x + name_width, fy, suffix_width, &suffix, st);
                } else { put(buf, value_x, fy, value_width, &format!("@ {}", form.machine_label), st); }
            } else if let Field::Recent(i) = field {
                // The chosen row as the panel's lists mark it, as the welcome page's Recent does.
                let st = if active { selected } else { st };
                if active { panel(buf, Rect::new(x + 3, fy, form_w - 6, 1), st); }
                if let Some((title, detail)) = form.recent_labels.get(i) {
                    let room = form_w - 6;
                    let detail_w = if room >= 42 { (detail.width() as u16).min(22) } else { 0 };
                    put(buf, x + 3, fy, room.saturating_sub(detail_w + u16::from(detail_w > 0)), title, st);
                    if detail_w > 0 { put(buf, r.right() - 3 - detail_w, fy, detail_w, detail, if active { st.remove_modifier(Modifier::BOLD) } else { muted }); }
                }
            } else if !action { put(buf, value_x, fy, value_width, &value, st); }
            form.hits.push((Rect::new(x + 1, fy, form_w - 2, height), field));
        }
        if message.is_empty() {
            if form.local_only && form.draft.what.engine != "terminal" {
                put(buf, x + 2, footer_y, form_w - 4, "Run `harness start` to connect agents.", muted);
                if footer_h > 1 { put(buf, x + 2, footer_y + 1, form_w - 4, "You can prepare a task or open a terminal now.", muted); }
            } else {
                put(buf, x + 2, footer_y, form_w - 4, &form.hint(), muted);
            }
            if footer_h > 1 && form.focus == Field::Task && !form.local_only {
                let count = task::length(&form.draft.task);
                if count >= 1600 {
                    put(buf, x + 2, footer_y + 1, form_w - 4, &format!("{count}/{} characters", task::MAX_LENGTH), muted);
                }
            }
        } else {
            for (row, line) in errors.iter().take(footer_h as usize).enumerate() {
                put(buf, x + 2, footer_y + row as u16, form_w - 4, line, base.patch(theme::fg(theme::DANGER)));
            }
        }
    }
    match chooser {
        Some(at) => draw_child(buf, at, form).or(task_cursor),
        None => task_cursor,
    }
}

/// The rows [c] wants: the query, the count rule, its list (a group's heading and the blank before
/// it count too) and the keys line, at most 12 — a path or a name being typed, the query and keys.
fn wanted(c: &Child) -> u16 {
    if c.kind.editing() { return 2 }
    (3 + crate::settings::list_lines(&c.picker)).min(12) as u16
}

/// Where an entered chooser drops down: at (x, y), [width] wide, as tall as it wants down to
/// [bottom]; None when fewer rows are left than its list (or its query and keys) needs.
pub(super) fn dropdown(c: &Child, x: u16, y: u16, width: u16, bottom: u16) -> Option<Rect> {
    let room = bottom.saturating_sub(y);
    (room >= if c.kind.editing() { 2 } else { 4 } && width > 0).then(|| Rect::new(x, y, width, wanted(c).min(room)))
}

/// An entered chooser, dropped down: on the panel's surface, the command panel's query line,
/// count rule, rows and keys line, as the shell composer draws them (the chooser's error in place
/// of its keys). A path or a name being typed has no list: its query and keys only. Rendered by
/// reference, it leaves the query's text cursor in [cursor].
pub(super) struct Dropdown<'a> {
    pub editing: bool,
    pub error: &'a str,
    pub chrome: crate::settings::Chrome,
    pub cursor: Option<Position>,
}

impl StatefulWidget for &mut Dropdown<'_> {
    type State = Picker;
    fn render(self, area: Rect, buf: &mut Buffer, picker: &mut Picker) {
        use ratatui::layout::{Constraint::{Fill, Length}, Layout};
        let c = &self.chrome;
        crate::term_out::clear_extras(area);
        Clear.render(area, buf);
        let surface = Block::new().style(c.base).padding(Padding::horizontal(1));
        let inner = surface.inner(area);
        surface.render(area, buf);
        picker.row_at.clear();
        // (Too short for a list: the query and keys only, as a path being typed has.)
        let list = !self.editing && inner.height >= 4;
        let rows = if list { Layout::vertical([Length(1), Length(1), Fill(1), Length(1)]).split(inner) }
            else { Layout::vertical([Length(1), Fill(1)]).split(inner) };
        // The query, rule, keys and rows are the command panel's own helpers, so the three
        // read as one list (and its rows report where they are drawn, for the mouse).
        let ghost = picker.placeholder.clone();
        let mut query = crate::settings::QueryLine::new(picker, &ghost, c);
        query.render(rows[0], buf);
        self.cursor = Some(query.cursor);
        let keys = rows[rows.len() - 1];
        if keys.height > 0 {
            if self.error.is_empty() {
                let what: &[(&str, &str)] = if list { &[("↑↓", "move"), ("enter", "choose"), ("esc", "back")] } else { &[("enter", "choose"), ("esc", "back")] };
                crate::settings::KeysLine { keys: what, chrome: c }.render(keys, buf);
            } else {
                Paragraph::new(Line::styled(self.error, c.base.patch(theme::fg(theme::DANGER)))).render(keys, buf);
            }
        }
        if !list { return }
        let total = picker.total_rows.unwrap_or_else(|| picker.rows.iter().filter(|r| !r.disabled).count());
        // While it loads, the rule ends in what it waits for, as the shell composer's does.
        let wait = picker.busy.as_ref().map(|b| format!(" {} {b}", theme::spinner(0)));
        let room = wait.as_ref().map_or(0, |t| (t.width() as u16).min(rows[1].width / 2));
        let [rule, waiting] = Layout::horizontal([Fill(1), Length(room)]).areas(rows[1]);
        crate::settings::CountRule { shown: picker.visible.len(), total, marked: None, chrome: c }.render(rule, buf);
        if let Some(t) = wait { Paragraph::new(Span::styled(t, c.muted)).render(waiting, buf) }
        picker.page_rows.set(rows[2].height as i64);
        if picker.busy.is_none() || !picker.visible.is_empty() {
            crate::settings::list_from(buf, picker, rows[2], c, true, false);
        }
    }
}

pub(super) fn draw_child(buf: &mut Buffer, r: Rect, form: &mut Form) -> Option<Position> {
    let Some(c) = &mut form.child else { return None };
    form.child_area = r;
    let mut dropdown = Dropdown { editing: c.kind.editing(), error: &form.error, chrome: crate::settings::chrome(), cursor: None };
    (&mut dropdown).render(r, buf, &mut c.picker);
    dropdown.cursor.filter(|_| form.child_active)
}

/// The dropdown as it was drawn (2026-10-08), on the command panel's hand-drawn lines, kept so the
/// widgets that replaced those lines can be shown to draw the very same buffer.
#[cfg(test)]
pub(super) mod oracle {
    use super::*;

    pub fn render(d: &mut Dropdown<'_>, area: Rect, buf: &mut Buffer, picker: &mut Picker) {
        use ratatui::layout::{Constraint::{Fill, Length}, Layout};
        let c = &d.chrome;
        crate::term_out::clear_extras(area);
        Clear.render(area, buf);
        let surface = Block::new().style(c.base).padding(Padding::horizontal(1));
        let inner = surface.inner(area);
        surface.render(area, buf);
        picker.row_at.clear();
        // (Too short for a list: the query and keys only, as a path being typed has.)
        let list = !d.editing && inner.height >= 4;
        let rows = if list { Layout::vertical([Length(1), Length(1), Fill(1), Length(1)]).split(inner) }
            else { Layout::vertical([Length(1), Fill(1)]).split(inner) };
        let ghost = picker.placeholder.clone();
        let (at, _) = crate::settings::oracle::query_line(buf, picker, rows[0].x, rows[0].y, rows[0].width, &ghost, c);
        d.cursor = Some(at);
        let keys = rows[rows.len() - 1];
        if keys.height > 0 {
            if d.error.is_empty() {
                let what: &[(&str, &str)] = if list { &[("↑↓", "move"), ("enter", "choose"), ("esc", "back")] } else { &[("enter", "choose"), ("esc", "back")] };
                crate::settings::oracle::keys_line(buf, what, keys.x, keys.y, keys.width, c);
            } else {
                Paragraph::new(Line::styled(d.error, c.base.patch(theme::fg(theme::DANGER)))).render(keys, buf);
            }
        }
        if !list { return }
        let total = picker.total_rows.unwrap_or_else(|| picker.rows.iter().filter(|r| !r.disabled).count());
        let wait = picker.busy.as_ref().map(|b| format!(" {} {b}", theme::spinner(0)));
        let room = wait.as_ref().map_or(0, |t| (t.width() as u16).min(rows[1].width / 2));
        let [rule, waiting] = Layout::horizontal([Fill(1), Length(room)]).areas(rows[1]);
        crate::settings::oracle::count_rule(buf, picker.visible.len(), total, None, rule.x, rule.y, rule.width, c);
        if let Some(t) = wait { Paragraph::new(Span::styled(t, c.muted)).render(waiting, buf) }
        picker.page_rows.set(rows[2].height as i64);
        if picker.busy.is_none() || !picker.visible.is_empty() {
            crate::settings::list_from(buf, picker, rows[2], c, true, false);
        }
    }
}
