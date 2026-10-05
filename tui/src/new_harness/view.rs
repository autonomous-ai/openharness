//! Terminal rendering of the compact desktop form.
use super::*;
use unicode_segmentation::UnicodeSegmentation;

// Keep the recovery instruction readable, including long project names and wide glyphs.
fn error_lines(text: &str, width: usize) -> Vec<String> {
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
    let crate::settings::Chrome { base, muted, accent, backdrop, .. } = crate::settings::chrome();
    if page {
        panel(buf, body, Style::default().bg(ratatui::style::Color::Reset).fg(ratatui::style::Color::Reset));
    } else { crate::settings::backdrop(buf, body, backdrop); }
    // Only the terminal's size changes this anchor. Task wrapping, history, and choosers do not.
    let r = crate::settings::area(body, crate::settings::PanelSize::Form, if page { 28 } else { HEIGHT });
    let (x, y, form_w, form_h) = (r.x, r.y, r.width, r.height);
    let side_w = body.right().saturating_sub(r.right() + 4).min(60);
    let side = side_w >= 32;
    let child_w = if side { side_w } else { form_w };
    let child_h = if side { body.bottom().saturating_sub(y + 1).min(22).max(form_h.min(22)) } else { form_h };
    let spacious = if page { form_h >= 27 } else { form_h >= HEIGHT };
    let task_h = if spacious { 3 } else if page && form_h >= 21 { 2 } else { 1 };
    let mut task_cursor = None;
    let fields_y = y + if spacious { if page { 4 } else { 3 } } else if form_h >= 9 { 2 } else { 1 };
    let live_error = task::error(&form.draft.what.engine, &form.draft.task);
    let message = if form.error.is_empty() { live_error.as_deref().unwrap_or("") } else { &form.error };
    let errors = error_lines(message, form_w.saturating_sub(4) as usize);
    let footer_h = if message.is_empty() { 2 } else { errors.len().max(2) as u16 }
        .min(r.bottom().saturating_sub(fields_y + 1 + u16::from(spacious)).max(1));
    let footer_y = r.bottom().saturating_sub(footer_h + u16::from(spacious));
    form.area = r;
    if form.child.is_none() || side || !form.child_active {
        panel(buf, r, base);
        if form_h >= 9 {
            let title = if page { if form.first_run { "Welcome to Harness" } else { "New Window" } } else { "New Harness" };
            put(buf, x + 3, y + u16::from(spacious), form_w - 6, title, base.add_modifier(Modifier::BOLD));
            if page && spacious {
                put(buf, x + 3, y + 2, form_w - 6, "Start a task. Your agent takes it from here.", muted);
            }
        }
        let capacity = footer_y.saturating_sub(fields_y);
        let mut row: u16 = 0;
        let mut recent_header = None;
        let rows: Vec<_> = form.fields().into_iter().map(|field| {
            if spacious && matches!(field, Field::Branch | Field::Create) { row += 1; }
            if page && (field == Field::Recent(0) || field == Field::Browse && form.recent.is_empty()) {
                if spacious { row += 1; }
                recent_header = Some(row);
                row += 1;
            }
            let at = row;
            row += if field == Field::Task { task_h } else { 1 };
            (at, field)
        }).collect();
        let focus = rows.iter().find(|(_, field)| *field == form.focus).map(|(row, _)| *row).unwrap_or(0);
        let skip = focus.saturating_sub(capacity.saturating_sub(1));
        if let Some(row) = recent_header.filter(|row| *row >= skip && *row < skip + capacity) {
            put(buf, x + 3, fields_y + row - skip, form_w - 6, &form.recent_status, muted);
        }
        for (row, field) in rows.into_iter().filter(|(row, _)| *row >= skip && *row < skip + capacity) {
            let fy = fields_y + row - skip;
            let active = field == form.focus;
            let st = if form.blocked(field).is_some() { muted } else if active { accent } else { base };
            let (label, value) = form.describe(field);
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
            } else if field == Field::Project {
                let suffix = format!(" @ {}", form.machine_label);
                let suffix_width = suffix.width() as u16;
                if value_width > suffix_width + 2 {
                    let name = form.project_name();
                    let name_width = (name.width() as u16).min(value_width - suffix_width);
                    put(buf, value_x, fy, name_width, &name, st);
                    put(buf, value_x + name_width, fy, suffix_width, &suffix, st);
                } else { put(buf, value_x, fy, value_width, &format!("@ {}", form.machine_label), st); }
            } else if let Field::Recent(i) = field {
                let st = if active {
                    if theme::fzf().bw { st.add_modifier(Modifier::REVERSED) }
                    else { st.bg(theme::fzf().bg_plus) }
                } else { st };
                if active { panel(buf, Rect::new(x + 3, fy, form_w - 6, 1), st); }
                if let Some((title, detail)) = form.recent_labels.get(i) {
                    let room = form_w - 6;
                    let detail_w = if room >= 42 { (detail.width() as u16).min(22) } else { 0 };
                    put(buf, x + 3, fy, room.saturating_sub(detail_w + u16::from(detail_w > 0)), title, st);
                    if detail_w > 0 { put(buf, r.right() - 3 - detail_w, fy, detail_w, detail, if active { accent } else { muted }); }
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
                let hint = if count >= 1600 { format!("{count}/{} characters", task::MAX_LENGTH) }
                    else { "Task is optional · leave blank to start interactively".into() };
                put(buf, x + 2, footer_y + 1, form_w - 4, &hint, muted);
            }
        } else {
            for (row, line) in errors.iter().take(footer_h as usize).enumerate() {
                put(buf, x + 2, footer_y + row as u16, form_w - 4, line, base.patch(theme::fg(theme::DANGER)));
            }
        }
    }
    if !side && !form.child_active {
        return task_cursor;
    }
    let Some(c) = &mut form.child else {
        return task_cursor;
    };
    let r = Rect::new(if side { x + form_w + 2 } else { x }, y, child_w, child_h);
    form.child_area = r;
    panel(buf, r, base);
    let query_x = r.x + 4;
    let query_y = r.y + 2;
    let query_w = r.width.saturating_sub(6) as usize;
    put(buf, r.x + 2, query_y, 1, "›", accent);
    let chars: Vec<_> = c.picker.query.chars().collect();
    let at = c.picker.qcursor.min(chars.len());
    let mut from = at;
    let mut width = 0;
    while from > 0 && width + chars[from - 1].width().unwrap_or(0) < query_w {
        from -= 1;
        width += chars[from].width().unwrap_or(0);
    }
    let query: String = chars[from..].iter().collect();
    put(
        buf,
        query_x,
        query_y,
        query_w as u16,
        if query.is_empty() {
            &c.picker.placeholder
        } else {
            &query
        },
        if query.is_empty() { muted } else { base },
    );
    c.picker.row_at.clear();
    if !c.kind.editing() {
        // Project's blank line between folder actions and recents occupies a display row too.
        // Reserve it in the scroll window so the selected item cannot hide under the footer.
        let separated = c.kind == Choice::Project && c.picker.query.is_empty()
            && c.picker.visible.windows(2).any(|pair| {
                !c.picker.rows[pair[0].0].id.starts_with("at:")
                    && c.picker.rows[pair[1].0].id.starts_with("at:")
            });
        let rows = r.height.saturating_sub(6 + u16::from(separated)) as usize;
        c.picker.page_rows.set(rows as i64);
        c.picker.scroll = c
            .picker
            .scroll
            .min(c.picker.cursor)
            .max(c.picker.cursor.saturating_sub(rows.saturating_sub(1)));
        if c.picker.visible.is_empty() {
            put(
                buf,
                r.x + 3,
                r.y + 3,
                r.width - 6,
                c.picker.busy.as_deref().unwrap_or(&c.picker.empty),
                muted,
            );
        }
        let mut separator = 0;
        for (row, (index, _)) in c
            .picker
            .visible
            .iter()
            .enumerate()
            .skip(c.picker.scroll)
            .take(rows)
        {
            if c.kind == Choice::Project
                && c.picker.query.is_empty()
                && c.picker.rows[*index].id.starts_with("at:")
                && row > 0
                && !c.picker.rows[c.picker.visible[row - 1].0]
                    .id
                    .starts_with("at:")
            {
                separator = 1;
            }
            let at_y = r.y + 4 + (row - c.picker.scroll) as u16 + separator;
            if at_y >= r.bottom() - 2 {
                break;
            }
            let selected = row == c.picker.cursor;
            put(
                buf,
                r.x + 1,
                at_y,
                1,
                if selected { "›" } else { " " },
                accent,
            );
            put(
                buf,
                r.x + 3,
                at_y,
                r.width - 6,
                &c.picker.rows[*index].label,
                if c.picker.rows[*index].disabled {
                    muted
                } else if selected {
                    accent
                } else {
                    base
                },
            );
            c.picker.row_at.push((at_y, row));
        }
        let total = c.picker.visible.len();
        if total > rows && rows > 0 {
            let thumb = (rows * rows / total).max(1);
            let top = (rows - thumb) * c.picker.scroll / (total - rows);
            for dy in top..top + thumb {
                put(buf, r.right() - 2, r.y + 4 + dy as u16, 1, "│", muted);
            }
        }
    }
    let hint = if !form.error.is_empty() {
        &form.error
    } else {
        c.picker.busy.as_deref().unwrap_or(if form.child_active {
            "Enter select · Esc back"
        } else {
            "Enter or → to choose"
        })
    };
    put(buf, r.x + 2, r.bottom() - 2, r.width - 4, hint, muted);
    form.child_active.then(|| {
        Position::new(
            query_x + (width as u16).min(r.width.saturating_sub(7)),
            query_y,
        )
    })
}
