//! State outside the public emulator grid needed to reconstruct a local shell on reconnect.
use std::fmt::Write;
use alacritty_terminal::grid::{Cursor, Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::{cell::{Cell, Flags}, Term, TermMode};
use alacritty_terminal::vte::ansi::{self, CharsetIndex, KeyboardModes, StandardCharset};
use crate::pane::Listener;

pub struct ScreenState {
    pub main: Option<Grid<Cell>>,
    pub margins: (usize, usize),
    pub tabs: Vec<bool>,
    pub charset: CharsetIndex,
    pub keyboard: Vec<KeyboardModes>,
    pub main_keyboard: Vec<KeyboardModes>,
}

impl ScreenState {
    pub fn new(cols: usize, rows: usize) -> Self {
        Self { main: None, margins: (1, rows), tabs: (0..cols).map(|c| c % 8 == 0).collect(), charset: CharsetIndex::G0, keyboard: Vec::new(), main_keyboard: Vec::new() }
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        if let Some(main) = &mut self.main { main.resize(true, rows, cols); }
        let old = self.tabs.len();
        self.tabs.resize(cols, false);
        for c in old..cols { self.tabs[c] = c % 8 == 0; }
        self.margins = (1, rows);
    }

    pub fn snapshot(&self, term: &Term<Listener>, title: &str, path: Option<&str>, tail: &[u8]) -> Vec<u8> {
        let mut out = String::from("\x1bc\x1b[?25l");
        if let Some(main) = &self.main {
            grid(&mut out, main);
            cursor(&mut out, main, &main.cursor, 0);
            keyboard(&mut out, &self.main_keyboard, self.main_keyboard.last().map(|m| m.bits()).unwrap_or(0));
            out.push_str("\x1b[?1049h\x1b[H\x1b[2J");
        }
        grid(&mut out, term.grid());
        // Colours are applied after content, since cells retain their indexed colour identity.
        for i in 0..alacritty_terminal::term::color::COUNT {
            if let Some(c) = term.colors()[i] {
                if i < 256 { let _ = write!(out, "\x1b]4;{i};rgb:{:02x}/{:02x}/{:02x}\x1b\\", c.r, c.g, c.b); }
                else if let Some(osc) = match i { 256 => Some(10), 257 => Some(11), 258 => Some(12), _ => None } { let _ = write!(out, "\x1b]{osc};rgb:{:02x}/{:02x}/{:02x}\x1b\\", c.r, c.g, c.b); }
            }
        }
        out.push_str("\x1b[3g");
        for (col, set) in self.tabs.iter().enumerate() { if *set { let _ = write!(out, "\x1b[{}G\x1bH", col + 1); } }
        let (top, bottom) = self.margins;
        let _ = write!(out, "\x1b[{top};{bottom}r");
        // DECSC/DECRC save attributes and character sets along with the position.
        cursor(&mut out, term.grid(), &term.grid().saved_cursor, 0);
        out.push_str("\x1b7");
        let mode = *term.mode();
        for (flag, number) in [(TermMode::APP_CURSOR,1),(TermMode::LINE_WRAP,7),(TermMode::SHOW_CURSOR,25),(TermMode::MOUSE_REPORT_CLICK,1000),(TermMode::MOUSE_DRAG,1002),(TermMode::MOUSE_MOTION,1003),(TermMode::FOCUS_IN_OUT,1004),(TermMode::UTF8_MOUSE,1005),(TermMode::SGR_MOUSE,1006),(TermMode::ALTERNATE_SCROLL,1007),(TermMode::URGENCY_HINTS,1042),(TermMode::BRACKETED_PASTE,2004),(TermMode::ORIGIN,6)] {
            let _ = write!(out, "\x1b[?{number}{}", if mode.contains(flag) { 'h' } else { 'l' });
        }
        for (flag, number) in [(TermMode::LINE_FEED_NEW_LINE,20)] { let _ = write!(out, "\x1b[{number}{}", if mode.contains(flag) { 'h' } else { 'l' }); }
        out.push_str(if mode.contains(TermMode::APP_KEYPAD) { "\x1b=" } else { "\x1b>" });
        keyboard(&mut out, &self.keyboard, ((mode & TermMode::KITTY_KEYBOARD_PROTOCOL).bits() >> 18) as u8);
        cursor(&mut out, term.grid(), &term.grid().cursor, if mode.contains(TermMode::ORIGIN) { top - 1 } else { 0 });
        if mode.contains(TermMode::INSERT) { out.push_str("\x1b[4h"); }
        out.push_str(match self.charset { CharsetIndex::G0 => "\x0f", CharsetIndex::G1 => "\x0e", CharsetIndex::G2 => "\x1bn", CharsetIndex::G3 => "\x1bo" });
        let cs = term.cursor_style();
        let n = match cs.shape { ansi::CursorShape::Block => if cs.blinking {1}else{2}, ansi::CursorShape::Underline => if cs.blinking {3}else{4}, ansi::CursorShape::Beam => if cs.blinking {5}else{6}, _ => 0 };
        let _ = write!(out, "\x1b[{n} q");
        if !title.is_empty() { let _ = write!(out, "\x1b]2;{}\x1b\\", clean_osc(title)); }
        if let Some(path) = path { let _ = write!(out, "\x1b]7;{}\x1b\\", clean_osc(path)); }
        let mut bytes = out.into_bytes();
        bytes.extend_from_slice(tail);
        bytes
    }
}

fn clean_osc(value: &str) -> String { value.chars().filter(|c| !c.is_control()).collect() }
fn keyboard(out: &mut String, stack: &[KeyboardModes], current: u8) {
    for mode in stack { let _ = write!(out, "\x1b[>{}u", mode.bits()); }
    let _ = write!(out, "\x1b[={current}u");
}
fn style(out: &mut String, cell: &Cell) {
    out.push_str("\x1b[0m");
    out.push_str(&crate::capture::cell_style(cell));
    match cell.hyperlink() {
        Some(link) => { let _ = write!(out, "\x1b]8;id={};{}\x1b\\", clean_osc(link.id()), clean_osc(link.uri())); }
        None => out.push_str("\x1b]8;;\x1b\\"),
    }
}
fn text(out: &mut String, cell: &Cell) {
    out.push(if cell.c == '\0' || cell.c == '\t' { ' ' } else { cell.c });
    for c in cell.zerowidth().unwrap_or_default() { out.push(*c); }
}
fn grid(out: &mut String, grid: &Grid<Cell>) {
    out.push_str("\x1b[?6l\x1b[?7h\x1b[4l\x1b(B\x1b)B\x0f\x1b[H\x1b[0m");
    let mut last = Cell::default();
    for line in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
        let row = &grid[Line(line)];
        let wrap = row[Column(grid.columns()-1)].flags.contains(Flags::WRAPLINE);
        let used = if wrap { grid.columns() } else { (0..grid.columns()).rposition(|c| { let cell = &row[Column(c)]; cell != &Cell::default() }).map(|c| c + 1).unwrap_or(0) };
        for col in 0..used {
            let cell = &row[Column(col)];
            if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) { continue }
            out.push_str(&crate::capture::cell_style_change(&last, cell));
            if last.hyperlink() != cell.hyperlink() {
                match cell.hyperlink() { Some(link) => { let _ = write!(out,"\x1b]8;id={};{}\x1b\\", clean_osc(link.id()), clean_osc(link.uri())); }, None => out.push_str("\x1b]8;;\x1b\\") }
            }
            if cell.c == '\t' {
                // Keep Alacritty's tab marker as well as its visible blanks. Snapshot drawing
                // uses the reset terminal's eight-column stops; resume at the next cell.
                out.push('\t');
                let next = ((col / 8 + 1) * 8).min(grid.columns() - 1);
                if next > col + 1 { let _ = write!(out, "\x1b[{}D", next - col - 1); }
            } else { text(out, cell); }
            last = cell.clone();
        }
        if line + 1 < grid.screen_lines() as i32 && !wrap { out.push_str("\r\n"); }
    }
    out.push_str("\x1b[0m\x1b]8;;\x1b\\");
}
fn cursor(out: &mut String, grid: &Grid<Cell>, cursor: &Cursor<Cell>, origin: usize) {
    out.push_str("\x1b(B\x1b)B\x0f");
    let row = cursor.point.line.0.max(0) as usize;
    let col = cursor.point.column.0.min(grid.columns()-1);
    let _ = write!(out, "\x1b[{};{}H", row.saturating_sub(origin) + 1, col + 1);
    if cursor.input_needs_wrap {
        let base = if col > 0 && grid[Line(row as i32)][Column(col)].flags.contains(Flags::WIDE_CHAR_SPACER) { col - 1 } else { col };
        let _ = write!(out, "\x1b[{}G", base + 1);
        let cell = &grid[Line(row as i32)][Column(base)];
        style(out, cell);
        text(out, cell);
    }
    style(out, &cursor.template);
    for (intro, index) in [('(',CharsetIndex::G0),(')',CharsetIndex::G1),('*',CharsetIndex::G2),('+',CharsetIndex::G3)] { let _ = write!(out, "\x1b{intro}{}", if cursor.charsets[index] == StandardCharset::Ascii { 'B' } else { '0' }); }
}

pub fn colour(index: usize) -> ansi::Rgb {
    let rgb = match index {
        0..=15 => { const BASE: [u32;16] = [0x000000,0xcd0000,0x00cd00,0xcdcd00,0x0000ee,0xcd00cd,0x00cdcd,0xe5e5e5,0x7f7f7f,0xff0000,0x00ff00,0xffff00,0x5c5cff,0xff00ff,0x00ffff,0xffffff]; BASE[index] },
        16..=231 => { let i = index-16; let v = |x:usize| if x==0 {0} else {55+x*40}; ((v(i/36)<<16)|(v((i/6)%6)<<8)|v(i%6)) as u32 },
        232..=255 => { let c = 8+(index-232)*10; ((c<<16)|(c<<8)|c) as u32 },
        257 => 0,
        _ => 0xe5e5e5,
    };
    ansi::Rgb { r:(rgb>>16) as u8,g:(rgb>>8) as u8,b:rgb as u8 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{capture, pane::Pane};

    fn text(pane: &Pane) -> String {
        capture::history(pane, -(pane.term.grid().history_size() as i32), pane.rows as i32 - 1, capture::Flags2 { sequences: true, empty_cells: true, ..Default::default() })
    }
    fn same(a: &Pane, b: &Pane) {
        assert_eq!(text(a), text(b), "captured cells and attributes");
        assert_eq!(a.term.grid().cursor, b.term.grid().cursor, "cursor, attributes, charsets and wrap state");
        assert_eq!(a.mode(), b.mode(), "terminal modes");
        let ag = a.term.grid(); let bg = b.term.grid();
        for line in -(ag.history_size() as i32)..a.rows as i32 { for col in 0..a.cols as usize {
            assert_eq!(ag[Line(line)][Column(col)].flags, bg[Line(line)][Column(col)].flags, "flags at {line},{col}");
            assert_eq!(ag[Line(line)][Column(col)].hyperlink(), bg[Line(line)][Column(col)].hyperlink(), "hyperlink at {line},{col}");
        } }
    }
    fn restored(pane: &Pane, tail: &[u8]) -> Pane {
        let mut mirror = Pane::new(0, "local", "mirror", pane.cols, pane.rows);
        mirror.keyframe(pane.cols, pane.rows, &pane.local_snapshot(tail));
        mirror
    }

    #[test]
    fn reconnect_restores_history_attributes_modes_and_pending_wrap() {
        let mut pane = Pane::new(0, "local", "source", 12, 4); pane.enable_local();
        pane.feed(b"old1\r\nold2\r\nold3\r\n\x1b[31mred\x1b[0m\r\nplain\r\n");
        pane.feed("⚠️👍🏽👨‍👩‍👧!".as_bytes());
        pane.feed(b"\x1b[3;5H\x1b[3;4:3;58;2;10;20;30m\x1b7\x1b[0m\x1b[4;1H123456789012\x1b[?1h\x1b[?2004h\x1b=");
        let mut mirror = restored(&pane, b""); same(&pane, &mirror);
        let more = b"X\x1b8Y\x1b[0m\r\nnext\tTAB";
        pane.feed(more); mirror.feed(more); same(&pane, &mirror);
    }

    #[test]
    fn reconnect_preserves_alternate_screen_and_return_to_main_after_resize() {
        let mut pane = Pane::new(0, "local", "source", 16, 5); pane.enable_local();
        pane.feed(b"main history\r\nline2\r\nline3\r\nline4\r\n\x1b[34mMAIN\x1b[?1049h\x1b[2J\x1b[H\x1b[32mALT\x1b[3;4H\x1b7\x1b[2;5r\x1b[?6h\x1b[3;2Hnow\x1b[?1002h\x1b[?1006h");
        pane.resize_local(20, 6);
        let mut mirror = restored(&pane, b""); same(&pane, &mirror);
        let more = b"!\x1b8saved\x1b[?1049lEND\r\n";
        pane.feed(more); mirror.feed(more); same(&pane, &mirror);
    }

    #[test]
    fn reconnect_preserves_custom_tabs_charset_links_and_parser_prefixes() {
        let mut pane = Pane::new(0, "local", "source", 20, 4); pane.enable_local();
        pane.feed(b"\x1b[3g\x1b[4G\x1bH\x1b[9G\x1bH\x1b[H\x1b]8;id=keep;https://example.test/\x1b\\linked\x1b]8;;\x1b\\\r\n\x1b)0\x0elqk\x1b7");
        let mut mirror = restored(&pane, b""); same(&pane, &mirror);
        pane.feed(b"\r\tq\tq\x0f"); mirror.feed(b"\r\tq\tq\x0f"); same(&pane, &mirror);
        for (prefix, suffix) in [(b"\x1b[38;2;12;".as_slice(), b"34;56mX".as_slice()), (&[0xf0,0x9f], &[0x91,0x8d]), (b"\x1bkhidden", b" title\x1b\\X")] {
            let mut tail = super::super::Tail::default(); tail.advance(prefix); pane.feed(prefix);
            let mut mirror = restored(&pane, tail.bytes()); pane.feed(suffix); mirror.feed(suffix); same(&pane, &mirror);
        }
    }

    #[test]
    fn reconnect_keeps_wide_margin_cells_and_wrapped_history() {
        for cols in 4..=9 {
            for cluster in ["⚠️", "👍🏽", "👨‍👩‍👧", "🇬🇧"] {
                for before in [cols - 2, cols - 1] {
                    let mut pane = Pane::new(0, "local", "source", cols, 3); pane.enable_local();
                    for _ in 0..5 { pane.feed(format!("{}{cluster}next\r\n", "x".repeat(before as usize)).as_bytes()); }
                    pane.feed(format!("{}{cluster}", "x".repeat(before as usize)).as_bytes());
                    let mut mirror = restored(&pane, b""); same(&pane, &mirror);
                    pane.feed(b"Z\r\n"); mirror.feed(b"Z\r\n"); same(&pane, &mirror);
                }
            }
        }
    }

    #[test]
    fn only_pty_owner_answers_terminal_queries() {
        let mut local = Pane::new(0, "local", "source", 80, 24); local.enable_local();
        local.feed(b"\x1b[4;9H\x1b[6n\x1b[5n\x1b[18t\x1b]11;?\x07");
        let replies = local.take_local_replies();
        assert!(replies.contains(&b"\x1b[4;9R".to_vec()));
        assert!(replies.contains(&b"\x1b[0n".to_vec()));
        assert!(replies.contains(&b"\x1b[8;24;80t".to_vec()));
        assert!(replies.iter().any(|r| r.starts_with(b"\x1b]11;rgb:0000/0000/0000")));
        let mut mirror = Pane::new(0, "local", "mirror", 80, 24);
        mirror.feed(b"\x1b[6n\x1b]11;?\x07");
        assert!(mirror.take_local_replies().is_empty());
    }
}
