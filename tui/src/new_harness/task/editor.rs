//! The first task's inline editor. Offsets are UTF-8 grapheme boundaries; wrapping uses cells.
use super::*;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Default)]
pub(crate) struct Editor {
    pub cursor: usize,
    scroll: usize,
    column: Option<usize>,
    killed: String,
    free_scroll: bool,
}

struct Line { start: usize, end: usize, text: String }
fn width(glyph: &str) -> usize { if glyph == "\t" { 4 } else { glyph.width() } }

fn lines(text: &str, limit: usize) -> Vec<Line> {
    let limit = limit.max(1);
    let mut out = vec![Line { start: 0, end: 0, text: String::new() }];
    let mut col = 0;
    for (at, glyph) in text.grapheme_indices(true) {
        if glyph == "\n" {
            out.last_mut().unwrap().end = at;
            out.push(Line { start: at + 1, end: at + 1, text: String::new() });
            col = 0;
            continue;
        }
        let w = width(glyph);
        if col > 0 && col + w > limit {
            out.push(Line { start: at, end: at, text: String::new() });
            col = 0;
        }
        let line = out.last_mut().unwrap();
        line.text.push_str(glyph);
        line.end = at + glyph.len();
        col += w;
    }
    if col >= limit { out.push(Line { start: text.len(), end: text.len(), text: String::new() }); }
    out
}
fn position(lines: &[Line], cursor: usize) -> (usize, usize) {
    let row = lines.iter().rposition(|line| line.start <= cursor).unwrap_or(0);
    let col = lines[row].text.grapheme_indices(true)
        .take_while(|(at, _)| lines[row].start + at < cursor).map(|(_, g)| width(g)).sum();
    (row, col)
}
fn at_column(line: &Line, col: usize) -> usize {
    let mut used = 0;
    for (at, glyph) in line.text.grapheme_indices(true) {
        let w = width(glyph);
        if used + w > col { return line.start + at }
        used += w;
    }
    line.end
}

impl Editor {
    fn clamp(&mut self, text: &str) {
        self.cursor = text.grapheme_indices(true).map(|(at, _)| at)
            .chain(std::iter::once(text.len())).take_while(|at| *at <= self.cursor).last().unwrap_or(0);
    }
    fn finish_edit(&mut self, text: &str) {
        // An insertion, or deleting a line break before a combining mark, can join
        // two graphemes. Keep the edit point after the resulting whole grapheme.
        self.cursor = text.grapheme_indices(true).map(|(at, _)| at)
            .chain(std::iter::once(text.len())).find(|at| *at >= self.cursor).unwrap_or(text.len());
        self.column = None;
    }
    fn previous(&self, text: &str) -> usize {
        text[..self.cursor].grapheme_indices(true).next_back().map(|(at, _)| at).unwrap_or(0)
    }
    fn next(&self, text: &str) -> usize {
        self.cursor + text[self.cursor..].graphemes(true).next().map(str::len).unwrap_or(0)
    }
    fn line_start(&self, text: &str) -> usize { text[..self.cursor].rfind('\n').map(|at| at + 1).unwrap_or(0) }
    fn line_end(&self, text: &str) -> usize { text[self.cursor..].find('\n').map(|at| self.cursor + at).unwrap_or(text.len()) }
    fn word_left(&self, text: &str) -> usize {
        let mut at = self.cursor;
        let mut word = false;
        for (i, glyph) in text[..self.cursor].grapheme_indices(true).rev() {
            let space = glyph.chars().all(char::is_whitespace);
            if word && space { break }
            word |= !space;
            at = i;
        }
        at
    }
    fn word_right(&self, text: &str) -> usize {
        let mut at = text.len();
        let mut word = false;
        for (i, glyph) in text[self.cursor..].grapheme_indices(true) {
            let space = glyph.chars().all(char::is_whitespace);
            if word && space { at = self.cursor + i; break }
            word |= !space;
        }
        at
    }
    pub fn insert(&mut self, text: &mut String, value: &str) {
        self.free_scroll = false;
        self.clamp(text);
        let clean: String = value.replace("\r\n", "\n").replace('\r', "\n").chars()
            .filter(|ch| matches!(ch, '\n' | '\t') || !ch.is_control()).collect();
        text.insert_str(self.cursor, &clean);
        self.cursor += clean.len();
        self.finish_edit(text);
    }
    fn remove(&mut self, text: &mut String, start: usize, end: usize, kill: bool) {
        if start < end {
            if kill { self.killed = text[start..end].to_string(); }
            text.replace_range(start..end, "");
            self.cursor = start;
            self.finish_edit(text);
        }
        self.column = None;
    }
    fn vertical(&mut self, text: &str, delta: isize, limit: usize) -> bool {
        let rows = lines(text, limit);
        let (row, col) = position(&rows, self.cursor);
        let col = *self.column.get_or_insert(col);
        let to = (row as isize + delta).clamp(0, rows.len() as isize - 1) as usize;
        if to == row { return false }
        self.cursor = at_column(&rows[to], col);
        true
    }
    pub fn key(&mut self, text: &mut String, key: KeyEvent, limit: usize) -> bool {
        self.free_scroll = false;
        self.clamp(text);
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let vertical = matches!(key.code, KeyCode::Up | KeyCode::Down) || ctrl && matches!(key.code, KeyCode::Char('p' | 'n'));
        if !vertical { self.column = None; }
        match key.code {
            KeyCode::Enter if alt || key.modifiers.contains(KeyModifiers::SHIFT) => self.insert(text, "\n"),
            KeyCode::Left => self.cursor = if ctrl || alt { self.word_left(text) } else { self.previous(text) },
            KeyCode::Right => self.cursor = if ctrl || alt { self.word_right(text) } else { self.next(text) },
            KeyCode::Char('b') if ctrl || alt => self.cursor = if alt { self.word_left(text) } else { self.previous(text) },
            KeyCode::Char('f') if ctrl || alt => self.cursor = if alt { self.word_right(text) } else { self.next(text) },
            KeyCode::Up => return self.vertical(text, -1, limit),
            KeyCode::Down => return self.vertical(text, 1, limit),
            KeyCode::Char('p') if ctrl => { self.vertical(text, -1, limit); }
            KeyCode::Char('n') if ctrl => { self.vertical(text, 1, limit); }
            KeyCode::Home if ctrl => self.cursor = 0,
            KeyCode::End if ctrl => self.cursor = text.len(),
            KeyCode::Home => self.cursor = self.line_start(text),
            KeyCode::End => self.cursor = self.line_end(text),
            KeyCode::Char('a') if ctrl => self.cursor = self.line_start(text),
            KeyCode::Char('e') if ctrl => self.cursor = self.line_end(text),
            KeyCode::Backspace => self.remove(text, if ctrl || alt { self.word_left(text) } else { self.previous(text) }, self.cursor, ctrl || alt),
            KeyCode::Delete => self.remove(text, self.cursor, if ctrl || alt { self.word_right(text) } else { self.next(text) }, ctrl || alt),
            KeyCode::Char('d') if ctrl => self.remove(text, self.cursor, self.next(text), false),
            KeyCode::Char('w') if ctrl => self.remove(text, self.word_left(text), self.cursor, true),
            KeyCode::Char('u') if ctrl => self.remove(text, self.line_start(text), self.cursor, true),
            KeyCode::Char('k') if ctrl => {
                let end = self.line_end(text);
                self.remove(text, self.cursor, if end == self.cursor { self.next(text) } else { end }, true);
            }
            KeyCode::Char('y') if ctrl => self.insert(text, &self.killed.clone()),
            KeyCode::Char(ch) if !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) => self.insert(text, &ch.to_string()),
            _ => return false,
        }
        true
    }
    pub fn click(&mut self, text: &str, area: Rect, pos: Position) {
        if !area.contains(pos) { return }
        let rows = lines(text, area.width as usize);
        let row = (self.scroll + (pos.y - area.y) as usize).min(rows.len() - 1);
        self.cursor = at_column(&rows[row], (pos.x - area.x) as usize);
        self.column = None;
        self.free_scroll = false;
    }
    pub fn scroll_by(&mut self, text: &str, area: Rect, delta: isize) {
        if area.is_empty() { return }
        let max = lines(text, area.width as usize).len().saturating_sub(area.height as usize);
        self.scroll = (self.scroll as isize + delta).clamp(0, max as isize) as usize;
        self.free_scroll = true;
    }
    pub fn draw(&mut self, buf: &mut Buffer, area: Rect, text: &str, active: bool, base: Style, muted: Style) -> Option<Position> {
        if area.is_empty() { return None }
        self.clamp(text);
        let rows = lines(text, area.width as usize);
        let (row, col) = position(&rows, self.cursor);
        if self.free_scroll { self.scroll = self.scroll.min(rows.len().saturating_sub(area.height as usize)); }
        else { self.scroll = self.scroll.min(row).max(row.saturating_sub(area.height as usize - 1)); }
        if text.is_empty() {
            view::put(buf, area.x, area.y, area.width, "What should this agent work on?", muted);
        } else {
            for (dy, line) in rows.iter().skip(self.scroll).take(area.height as usize).enumerate() {
                view::put(buf, area.x, area.y + dy as u16, area.width, &line.text.replace('\t', "    "), base);
            }
        }
        (active && row >= self.scroll && row < self.scroll + area.height as usize)
            .then(|| Position::new(area.x + (col as u16).min(area.width - 1), area.y + (row - self.scroll) as u16))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(editor: &mut Editor, text: &mut String, code: KeyCode, modifiers: KeyModifiers) {
        assert!(editor.key(text, KeyEvent::new(code, modifiers), 8));
    }
    #[test]
    fn editing_never_splits_a_grapheme_and_paste_preserves_newlines() {
        let mut editor = Editor::default();
        let mut text = String::new();
        editor.insert(&mut text, "cafe\u{301}👨‍👩‍👧‍👦\r\n界\r\n");
        assert_eq!(text, "cafe\u{301}👨‍👩‍👧‍👦\n界\n");
        key(&mut editor, &mut text, KeyCode::Home, KeyModifiers::CONTROL);
        for _ in 0..4 { key(&mut editor, &mut text, KeyCode::Right, KeyModifiers::NONE); }
        key(&mut editor, &mut text, KeyCode::Delete, KeyModifiers::NONE);
        assert_eq!(text, "cafe\u{301}\n界\n");
        key(&mut editor, &mut text, KeyCode::Backspace, KeyModifiers::NONE);
        assert_eq!(text, "caf\n界\n");
    }
    #[test]
    fn line_editing_and_yank_preserve_the_other_task_lines() {
        let mut editor = Editor::default();
        let mut text = String::new();
        editor.insert(&mut text, "one\nsecond task\nthree");
        key(&mut editor, &mut text, KeyCode::Char('a'), KeyModifiers::CONTROL);
        key(&mut editor, &mut text, KeyCode::Backspace, KeyModifiers::NONE);
        assert_eq!(text, "one\nsecond taskthree");
        key(&mut editor, &mut text, KeyCode::Char('u'), KeyModifiers::CONTROL);
        assert_eq!(text, "one\nthree");
        key(&mut editor, &mut text, KeyCode::Char('y'), KeyModifiers::CONTROL);
        assert_eq!(text, "one\nsecond taskthree");
    }
    #[test]
    fn wrapping_and_mouse_use_cells_not_bytes_or_codepoints() {
        let rows = lines("e\u{301}界👨‍👩‍👧‍👦x", 5);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].text, "e\u{301}界👨‍👩‍👧‍👦");
        assert_eq!(at_column(&rows[0], 2), "e\u{301}".len());
        let rows = lines("界界", 4);
        assert_eq!(position(&rows, "界界".len()), (1, 0));
        let mut editor = Editor::default();
        editor.click("ab界cd", Rect::new(10, 4, 6, 2), Position::new(13, 4));
        assert_eq!(editor.cursor, 2);
    }

    #[test]
    fn scrolling_a_long_task_does_not_move_the_edit_point() {
        let mut editor = Editor::default();
        let mut text = String::new();
        editor.insert(&mut text, "one\ntwo\nthree\nfour\nfive");
        let area = Rect::new(3, 4, 12, 2);
        let mut buf = Buffer::empty(Rect::new(0, 0, 20, 10));
        let style = Style::default();
        assert_eq!(editor.draw(&mut buf, area, &text, true, style, style), Some(Position::new(7, 5)));
        let end = editor.cursor;
        editor.scroll_by(&text, area, -20);
        assert_eq!(editor.draw(&mut buf, area, &text, true, style, style), None);
        assert_eq!(editor.cursor, end);
        assert_eq!(buf[(3, 4)].symbol(), "o");
        editor.insert(&mut text, "!");
        assert!(text.ends_with("five!"));
        assert_eq!(editor.draw(&mut buf, area, &text, true, style, style), Some(Position::new(8, 5)));
        editor.scroll_by(&text, area, -20);
        editor.click(&text, area, Position::new(4, 4));
        editor.insert(&mut text, "X");
        assert!(text.starts_with("oXne\n"));
    }

    #[test]
    fn wrapped_arrows_escape_only_at_visual_edges() {
        let mut editor = Editor::default();
        let mut text = String::new();
        editor.insert(&mut text, "ab界cdef");
        assert!(!editor.key(&mut text, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE), 4));
        assert!(editor.key(&mut text, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE), 4));
        assert_eq!(editor.cursor, "ab界".len());
        assert!(editor.key(&mut text, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE), 4));
        assert_eq!(editor.cursor, 0);
        assert!(!editor.key(&mut text, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE), 4));
        assert_eq!(text, "ab界cdef");
    }

    #[test]
    fn deleting_a_line_break_before_a_combining_mark_keeps_the_edit_point_valid() {
        for (cursor, code) in [(1, KeyCode::Delete), (2, KeyCode::Backspace)] {
            let mut editor = Editor::default();
            let mut text = String::from("e\n\u{301}x");
            editor.cursor = cursor;
            key(&mut editor, &mut text, code, KeyModifiers::NONE);
            assert_eq!(text, "e\u{301}x");
            assert_eq!(editor.cursor, "e\u{301}".len());
            key(&mut editor, &mut text, KeyCode::Char('!'), KeyModifiers::NONE);
            assert_eq!(text, "e\u{301}!x");
        }
    }

    #[test]
    fn mixed_unicode_edits_and_resizes_keep_the_cursor_at_a_grapheme_boundary() {
        let mut editor = Editor::default();
        let mut text = String::new();
        let codes = [KeyCode::Left, KeyCode::Right, KeyCode::Up, KeyCode::Down,
            KeyCode::Home, KeyCode::End, KeyCode::Backspace, KeyCode::Delete,
            KeyCode::Char('a'), KeyCode::Char('e'), KeyCode::Char('b'), KeyCode::Char('f'),
            KeyCode::Char('p'), KeyCode::Char('n'), KeyCode::Char('u'), KeyCode::Char('k'),
            KeyCode::Char('w'), KeyCode::Char('y'), KeyCode::Char('d'), KeyCode::Enter];
        let modifiers = [KeyModifiers::NONE, KeyModifiers::CONTROL, KeyModifiers::ALT, KeyModifiers::SHIFT];
        let snippets = ["café", "e\u{301}", "界", "👨‍👩‍👧‍👦", "\r\n\t", "\u{301}", "\x00\x1b", " words "];
        let mut seed = 0x19c3a51_u64;
        for step in 0..5000 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let n = (seed >> 32) as usize;
            let width = [1, 2, 4, 8, 40][n % 5];
            if step % 3 == 0 {
                editor.insert(&mut text, snippets[n % snippets.len()]);
            } else {
                editor.key(&mut text, KeyEvent::new(codes[n % codes.len()], modifiers[n / 20 % modifiers.len()]), width);
            }
            assert!(editor.cursor == text.len() || text.grapheme_indices(true).any(|(at, _)| at == editor.cursor),
                "invalid edit point after step {step} at {}", editor.cursor);
            let area = Rect::new(2, 2, width as u16, 3);
            let cursor = editor.draw(&mut Buffer::empty(Rect::new(0, 0, 44, 8)), area, &text, true, Style::default(), Style::default());
            assert!(cursor.is_some_and(|point| area.contains(point)), "cursor lost after step {step}");
        }
    }
}
