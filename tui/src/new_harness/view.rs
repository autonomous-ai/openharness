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
    for ch in text.chars().filter(|c| !c.is_control()) {
        let w = ch.width().unwrap_or(0);
        if used + w > limit.saturating_sub(usize::from(trunc)) {
            break;
        }
        out.push(ch);
        used += w;
    }
    if trunc {
        out.push('…');
    }
    buf.set_stringn(x, y, out, width as usize, style);
}

/// The form's height: enough rows for every agent's settings, the same whatever is open, so
/// changing agents or opening an editor never moves it.
pub(super) const HEIGHT: u16 = 17;

/// The form's surface, as the settings panel draws its own: filled, no border.
fn panel(buf: &mut Buffer, r: Rect, base: Style) {
    crate::settings::fill(buf, r, base)
}

pub fn draw(buf: &mut Buffer, body: Rect, form: &mut Form) -> Option<Position> {
    form.hits.clear();
    form.area = Rect::default();
    form.child_area = Rect::default();
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
    // The settings panel's colours, and its quiet backdrop over the working panes.
    let crate::settings::Chrome {
        base,
        muted,
        accent,
        backdrop,
        ..
    } = crate::settings::chrome();
    crate::settings::backdrop(buf, body, backdrop);
    // The form is a Form panel (settings::area): centred — the form, not the form and its chooser —
    // and as tall as every agent's settings need, so changing agents or opening an editor never
    // moves it. A chooser opens beside it where there is room, else in its place.
    let r = crate::settings::area(body, crate::settings::PanelSize::Form, HEIGHT);
    let (x, y, form_w, form_h) = (r.x, r.y, r.width, r.height);
    let side_w = body.right().saturating_sub(r.right() + 4).min(60);
    let side = side_w >= 32;
    let child_w = if side { side_w } else { form_w };
    let child_h = if side {
        body.bottom().saturating_sub(y + 1).min(22).max(form_h)
    } else {
        form_h
    };
    let fields = form.fields();
    let fields_y = y + if form_h >= 9 { 3 } else { 1 };
    let errors = error_lines(&form.error, form_w.saturating_sub(4) as usize);
    // Even a long error in a tiny terminal leaves one field (the focused action) visible.
    let error_h = errors.len().min(r.bottom().saturating_sub(fields_y + 2).max(1) as usize) as u16;
    form.area = r;
    if form.child.is_none() || side || !form.child_active {
        panel(buf, r, base);
        if form_h >= 9 {
            put(buf, x + 3, y + 1, form_w - 6, "New Harness", base.add_modifier(Modifier::BOLD));
        }
        let error_y = r.bottom() - 1 - error_h;
        let capacity = error_y.saturating_sub(fields_y);
        let mut row: u16 = 0;
        let rows: Vec<_> = fields
            .iter()
            .map(|field| {
                // One blank line between the task and settings, and before the launch action.
                if matches!(field, Field::Branch | Field::Create) {
                    row += 1;
                }
                let at = row;
                row += 1;
                (at, field)
            })
            .collect();
        let focus = rows
            .iter()
            .find(|(_, field)| **field == form.focus)
            .map(|(row, _)| *row)
            .unwrap_or(0);
        let skip = focus.saturating_sub(capacity.saturating_sub(1));
        for (row, field) in rows
            .into_iter()
            .filter(|(row, _)| *row >= skip && *row < skip + capacity)
        {
            let fy = fields_y + row - skip;
            let active = *field == form.focus;
            let st = if form.blocked(*field).is_some() {
                muted
            } else if active {
                accent
            } else {
                base
            };
            let (label, value) = form.describe(*field);
            put(buf, r.x + 1, fy, 1, if active { "›" } else { " " }, accent);
            let label_w = if r.width < 45 { 10 } else { 12 };
            put(
                buf,
                r.x + 3,
                fy,
                if *field == Field::Create {
                    r.width.saturating_sub(6)
                } else {
                    label_w
                },
                &label,
                if *field == Field::Create {
                    st.add_modifier(Modifier::BOLD)
                } else {
                    muted
                },
            );
            let value_width = r.width.saturating_sub(6 + label_w);
            let value_x = r.x + 3 + label_w;
            if *field == Field::Project {
                // Keep the destination visible even when the project name must be shortened.
                let suffix = format!(" @ {}", form.machine_label);
                let suffix_width = suffix.width() as u16;
                if value_width > suffix_width + 2 {
                    let name = form.project_name();
                    let name_width = (name.width() as u16).min(value_width - suffix_width);
                    put(buf, value_x, fy, name_width, &name, st);
                    put(buf, value_x + name_width, fy, suffix_width, &suffix, st);
                } else {
                    put(
                        buf,
                        value_x,
                        fy,
                        value_width,
                        &format!("@ {}", form.machine_label),
                        st,
                    );
                }
            } else {
                put(
                    buf,
                    value_x,
                    fy,
                    value_width,
                    &value,
                    if *field == Field::Task && form.draft.task.is_empty() && !active {
                        muted
                    } else {
                        st
                    },
                );
            }
            form.hits
                .push((Rect::new(r.x + 1, fy, r.width - 2, 1), *field));
        }
        if form.error.is_empty() {
            put(buf, r.x + 2, error_y, r.width - 4, &form.hint(), muted);
        } else {
            for (row, line) in errors.iter().take(error_h as usize).enumerate() {
                put(
                    buf,
                    r.x + 2,
                    error_y + row as u16,
                    r.width - 4,
                    line,
                    base.patch(theme::fg(theme::DANGER)),
                );
            }
        }
    }
    if !side && !form.child_active {
        return None;
    }
    let Some(c) = &mut form.child else {
        return None;
    };
    let r = Rect::new(if side { x + form_w + 2 } else { x }, y, child_w, child_h);
    form.child_area = r;
    panel(buf, r, base);
    if c.kind == Choice::Task {
        let cursor = task::draw(
            buf,
            r,
            &mut c.picker,
            &form.error,
            form.child_active,
            base,
            muted,
            accent,
        );
        return form.child_active.then_some(cursor);
    }
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
