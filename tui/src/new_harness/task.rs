//! The optional first task, edited beside the form (in its place on narrow terminals).
use super::*;

// Keep these aligned with cli/src/lib/engineLaunch.ts and desktop/lib/core/first_task.dart.
const MAX_LENGTH: usize = 2000;

pub(super) fn supported(engine: &str) -> bool {
    matches!(engine, "claude" | "codex" | "opencode" | "hermes")
}

pub(super) fn error(engine: &str, text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        None
    } else if !supported(engine) {
        Some("This agent cannot start with a task. Clear Task or choose another agent.".into())
    } else if text.encode_utf16().count() > MAX_LENGTH {
        Some(format!(
            "Task is too long. Shorten it to {MAX_LENGTH} characters."
        ))
    } else {
        None
    }
}

struct Line {
    start: usize,
    text: String,
}

fn char_width(ch: char) -> usize {
    if ch == '\t' {
        4
    } else {
        ch.width().unwrap_or(0)
    }
}

fn lines(text: &str, width: usize) -> Vec<Line> {
    let width = width.max(1);
    let mut lines = vec![Line {
        start: 0,
        text: String::new(),
    }];
    let mut col = 0;
    for (at, ch) in text.chars().enumerate() {
        if ch == '\n' {
            lines.push(Line {
                start: at + 1,
                text: String::new(),
            });
            col = 0;
            continue;
        }
        let w = char_width(ch);
        if col > 0 && col + w > width {
            lines.push(Line {
                start: at,
                text: String::new(),
            });
            col = 0;
        }
        lines.last_mut().unwrap().text.push(ch);
        col += w;
    }
    // Leave a cell for the insertion cursor after a completely full final line.
    if col >= width {
        lines.push(Line {
            start: text.chars().count(),
            text: String::new(),
        });
    }
    lines
}

fn position(lines: &[Line], cursor: usize) -> (usize, usize) {
    let row = lines
        .iter()
        .rposition(|line| line.start <= cursor)
        .unwrap_or(0);
    let col = lines[row]
        .text
        .chars()
        .take(cursor.saturating_sub(lines[row].start))
        .map(char_width)
        .sum();
    (row, col)
}

fn at_column(line: &Line, col: usize) -> usize {
    let mut width = 0;
    let mut at = line.start;
    for ch in line.text.chars() {
        let w = char_width(ch);
        if width + w > col {
            break;
        }
        width += w;
        at += 1;
    }
    at
}

pub(super) fn move_vertical(picker: &mut Picker, delta: isize, width: usize) {
    let lines = lines(&picker.query, width);
    let (row, col) = position(&lines, picker.qcursor);
    let to = (row as isize + delta).clamp(0, lines.len() as isize - 1) as usize;
    if row != to {
        picker.qcursor = at_column(&lines[to], col)
    }
}

fn text_area(r: Rect) -> Rect {
    let top = if r.height >= 8 { 4 } else { 1 };
    let footer = if r.width < 43 && r.height >= 9 { 3 } else { 2 };
    Rect::new(
        r.x + 3,
        r.y + top,
        r.width.saturating_sub(6).max(1),
        r.height.saturating_sub(top + footer).max(1),
    )
}

pub(super) fn click(picker: &mut Picker, panel: Rect, pos: Position) {
    let r = text_area(panel);
    if !r.contains(pos) {
        return;
    }
    let lines = lines(&picker.query, r.width as usize);
    let row = (picker.scroll + (pos.y - r.y) as usize).min(lines.len() - 1);
    picker.qcursor = at_column(&lines[row], (pos.x - r.x) as usize);
}

pub(super) fn draw(
    buf: &mut Buffer,
    panel: Rect,
    picker: &mut Picker,
    error: &str,
    active: bool,
    base: Style,
    muted: Style,
    accent: Style,
) -> Position {
    let r = text_area(panel);
    if panel.height >= 8 {
        view::put(buf, r.x, panel.y + 2, r.width, "Task (optional)", muted);
        let count = format!(
            "{}/{}",
            picker.query.trim().encode_utf16().count(),
            MAX_LENGTH
        );
        let width = count.width() as u16;
        if r.width >= width + 18 {
            view::put(buf, r.right() - width, panel.y + 2, width, &count, muted);
        }
    }
    let lines = lines(&picker.query, r.width as usize);
    let (row, col) = position(&lines, picker.qcursor);
    picker.scroll = picker
        .scroll
        .min(row)
        .max(row.saturating_sub(r.height as usize - 1));
    if picker.query.is_empty() {
        view::put(buf, r.x, r.y, r.width, &picker.placeholder, muted);
    } else {
        for (dy, line) in lines
            .iter()
            .skip(picker.scroll)
            .take(r.height as usize)
            .enumerate()
        {
            view::put(
                buf,
                r.x,
                r.y + dy as u16,
                r.width,
                &line.text.replace('\t', "    "),
                base,
            );
        }
    }
    let y = r.y + (row - picker.scroll) as u16;
    if active {
        view::put(buf, panel.x + 1, y, 1, "›", accent);
    }
    let short_footer = panel.width < 43 && panel.height >= 9;
    if error.is_empty() && short_footer && active {
        view::put(buf, panel.x + 2, panel.bottom() - 3, panel.width - 4, "Alt-Enter newline", muted);
    }
    view::put(
        buf,
        panel.x + 2,
        panel.bottom() - if panel.height >= 5 { 2 } else { 1 },
        panel.width.saturating_sub(4),
        if error.is_empty() {
            if !active {
                "Enter or → to edit"
            } else if short_footer {
                "Enter done · Esc back"
            } else {
                "Enter done · Alt-Enter newline · Esc back"
            }
        } else {
            error
        },
        if error.is_empty() {
            muted
        } else {
            base.patch(theme::fg(theme::DANGER))
        },
    );
    Position::new(r.x + (col as u16).min(r.width - 1), y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_task_validation_preserves_text_and_matches_wire_length() {
        assert!(error("terminal", "  ").is_none());
        assert!(error("cursor", "Fix login").is_some());
        assert!(error("codex", &"🦀".repeat(1000)).is_none());
        assert!(error("claude", &"🦀".repeat(1001)).is_some());
        assert!(error("claude", &format!("\n{}\n", "x".repeat(MAX_LENGTH))).is_none());
    }

    #[test]
    fn wrapped_task_navigation_tracks_unicode_and_hard_breaks() {
        let mut p = Picker::new("", "");
        p.query = "ab界cd\nnext".into();
        p.qcursor = 3;
        move_vertical(&mut p, 1, 5);
        assert_eq!(p.qcursor, 5);
        move_vertical(&mut p, 1, 5);
        assert_eq!(p.qcursor, 7);
        let lines = lines("界界", 4);
        assert_eq!(position(&lines, 2), (1, 0));
    }
}
