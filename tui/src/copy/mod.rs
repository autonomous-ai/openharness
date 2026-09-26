//! tmux's copy mode and view mode (window-copy.c and grid-reader.c, tmux 3.5a), ported. A pane in
//! copy mode works on a copy of its screen and history taken as the mode began
//! (window_copy_clone_screen; refresh-from-pane takes it again, and output meanwhile is
//! #{pane_unseen_changes}); view mode is the same over the lines a command printed (list-keys,
//! show-options, run-shell's output …). Every command is tmux's (window_copy_cmd_table), with its
//! arguments, the way it clears the search marks and what it leaves on the screen, so every key the
//! copy-mode tables bind does what it does in tmux, vi and emacs alike.

use std::borrow::Cow;
use std::time::Instant;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use unicode_width::UnicodeWidthChar;

mod cmds;
mod glue;
#[cfg(test)]
mod tests;
pub use cmds::*;
pub use glue::*;

/// tmux's WHITESPACE: what words are separated by, whatever word-separators says.
pub const WHITESPACE: &str = " ";
const SEARCH_TIMEOUT_MS: u128 = 10_000;
const SEARCH_ALL_TIMEOUT_MS: u128 = 200;
const SEARCH_MAX_LINE: u32 = 2000;
/// A line's OSC 133 marks (GRID_LINE_START_PROMPT, GRID_LINE_START_OUTPUT).
pub const LINE_START_PROMPT: u8 = 1;
pub const LINE_START_OUTPUT: u8 = 2;

// ── the backing grid ─────────────────────────────────────────────────────────

/// A grid cell: its character, its width (0 for the column a wide one also takes, tmux's
/// padding), its look.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Cell { pub c: char, pub width: u8, pub fg: Color, pub bg: Color, pub mods: Modifier }

impl Cell {
    pub const DEFAULT: Cell = Cell { c: ' ', width: 1, fg: Color::Reset, bg: Color::Reset, mods: Modifier::empty() };
}

/// A grid line: its cells (none past the last one written), the zero-width characters after some
/// of them, their links, whether it goes on in the next line, when it went into the history.
#[derive(Clone, Default, Debug)]
pub struct Line {
    pub cells: Vec<Cell>,
    pub extra: Vec<(u32, String)>,
    pub links: Vec<(u32, String)>,
    pub wrapped: bool,
    pub time: i64,
    pub flags: u8,
}

static EMPTY: Line = Line { cells: Vec::new(), extra: Vec::new(), links: Vec::new(), wrapped: false, time: 0, flags: 0 };

impl Line {
    fn extra_at(&self, x: u32) -> Option<&str> {
        if self.extra.is_empty() { return None }
        self.extra.iter().find(|(c, _)| *c == x).map(|(_, s)| s.as_str())
    }
    fn link_at(&self, x: u32) -> Option<&str> { self.links.iter().find(|(c, _)| *c == x).map(|(_, s)| s.as_str()) }
}

/// tmux's struct grid: the history's lines (oldest first), then the screen's.
#[derive(Clone, Default)]
pub struct Grid { pub sx: u32, pub sy: u32, pub hsize: u32, pub hscrolled: u32, pub lines: Vec<Line> }

/// A cell as grid_get_cell has it: past the line's end, a blank.
#[derive(Clone, Copy)]
pub struct Gc<'a> { pub c: char, pub extra: Option<&'a str>, pub width: u8, pub padding: bool, pub cell: Cell }

impl<'a> Gc<'a> {
    /// `gc.data.size == 1 && *gc.data.data == b`.
    pub fn is(&self, b: char) -> bool { !self.padding && self.extra.is_none() && self.c == b }
    /// `gc.data.size == 1`: one byte.
    pub fn one_byte(&self) -> bool { !self.padding && self.extra.is_none() && self.c.is_ascii() }
    /// The cell's UTF-8 (a padding cell has none).
    pub fn data(&self) -> Cow<'a, str> {
        if self.padding { return Cow::Borrowed("") }
        match self.extra { None => { let mut s = String::new(); s.push(self.c); Cow::Owned(s) } Some(e) => Cow::Owned(format!("{}{e}", self.c)) }
    }
}

impl Grid {
    pub fn new(sx: u32, sy: u32) -> Grid { Grid { sx, sy, hsize: 0, hscrolled: 0, lines: vec![Line::default(); sy as usize] } }
    pub fn line(&self, y: u32) -> &Line { self.lines.get(y as usize).unwrap_or(&EMPTY) }
    fn line_mut(&mut self, y: u32) -> &mut Line {
        while self.lines.len() <= y as usize { self.lines.push(Line::default()) }
        &mut self.lines[y as usize]
    }
    pub fn get(&self, x: u32, y: u32) -> Gc<'_> {
        let l = self.line(y);
        match l.cells.get(x as usize) {
            None => Gc { c: ' ', extra: None, width: 1, padding: false, cell: Cell::DEFAULT },
            Some(c) => Gc { c: c.c, extra: l.extra_at(x), width: c.width, padding: c.width == 0, cell: *c },
        }
    }
    /// grid_line_length: the line to its last cell that is not a blank.
    pub fn line_length(&self, y: u32) -> u32 {
        let mut px = (self.line(y).cells.len() as u32).min(self.sx);
        while px > 0 {
            let gc = self.get(px - 1, y);
            if gc.padding || !gc.is(' ') { break }
            px -= 1;
        }
        px
    }
    /// utf8_cstrhas: the cell is one of [set]'s characters.
    pub fn in_set(&self, x: u32, y: u32, set: &str) -> bool {
        let gc = self.get(x, y);
        !gc.padding && gc.extra.is_none() && set.contains(gc.c)
    }
    fn cellused(&self, y: u32) -> u32 { self.line(y).cells.len() as u32 }
}

/// A terminal's history and screen as a grid (grid_duplicate_lines): its lines' cells with their
/// colours, which ones wrapped, and [times] for the history's (0 for one not known).
pub fn from_term<L: alacritty_terminal::event::EventListener>(term: &alacritty_terminal::Term<L>, times: &std::collections::VecDeque<i64>, trim: bool) -> Grid {
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::index::{Column, Line as ALine};
    use alacritty_terminal::term::cell::Flags;
    let g = term.grid();
    let (sx, sy, hsize) = (term.columns() as u32, term.screen_lines() as u32, g.history_size() as u32);
    let colors = term.colors();
    let mut lines = Vec::with_capacity((hsize + sy) as usize);
    let known = times.len() as u32 == hsize;
    for y in 0..hsize + sy {
        let row = &g[ALine(y as i32 - hsize as i32)];
        let wrapped = sx > 0 && row[Column(sx as usize - 1)].flags.contains(Flags::WRAPLINE);
        let mut cells = Vec::with_capacity(sx as usize);
        let (mut extra, mut links) = (Vec::new(), Vec::new());
        for x in 0..sx {
            let cell = &row[Column(x as usize)];
            let (fg, dim) = crate::ui::map_color(cell.fg, colors, true);
            let (bg, _) = crate::ui::map_color(cell.bg, colors, false);
            let mut mods = Modifier::empty();
            if cell.flags.contains(Flags::BOLD) { mods |= Modifier::BOLD }
            if cell.flags.contains(Flags::ITALIC) { mods |= Modifier::ITALIC }
            if cell.flags.intersects(Flags::ALL_UNDERLINES) { mods |= Modifier::UNDERLINED }
            if cell.flags.contains(Flags::DIM) || dim { mods |= Modifier::DIM }
            if cell.flags.contains(Flags::STRIKEOUT) { mods |= Modifier::CROSSED_OUT }
            if cell.flags.contains(Flags::INVERSE) { mods |= Modifier::REVERSED }
            if cell.flags.contains(Flags::HIDDEN) { mods |= Modifier::HIDDEN }
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) { cells.push(Cell { c: ' ', width: 0, fg, bg, mods }); continue }
            let c = if cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) || cell.c == '\0' { ' ' } else { cell.c };
            let width = if cell.flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };
            if let Some(z) = cell.zerowidth() { if !z.is_empty() { extra.push((x, z.iter().collect())) } }
            if let Some(h) = cell.hyperlink() { links.push((x, h.uri().to_string())) }
            cells.push(Cell { c, width, fg, bg, mods });
        }
        if !wrapped { while cells.last() == Some(&Cell::DEFAULT) && !extra.iter().any(|(x, _)| *x as usize == cells.len() - 1) { cells.pop(); } }
        let time = if y < hsize && known { times[y as usize] } else { 0 };
        lines.push(Line { cells, extra, links, wrapped, time, flags: 0 });
    }
    let mut total = hsize + sy;
    // copy-mode -s: the other pane's empty lines at the bottom are left out.
    if trim { while total > hsize && lines[total as usize - 1].cells.is_empty() { total -= 1 } lines.truncate(total as usize) }
    Grid { sx, sy: total - hsize, hsize, hscrolled: hsize, lines }
}

// ── grid-reader.c ────────────────────────────────────────────────────────────

/// grid_reader: a cursor walking the grid.
struct Reader<'a> { gd: &'a Grid, cx: u32, cy: u32 }

impl<'a> Reader<'a> {
    fn new(gd: &'a Grid, cx: u32, cy: u32) -> Reader<'a> { Reader { gd, cx, cy } }
    fn line_length(&self) -> u32 { self.gd.line_length(self.cy) }
    fn last(&self) -> u32 { self.gd.hsize + self.gd.sy - 1 }

    fn cursor_right(&mut self, wrap: bool, all: bool) {
        let px = if all { self.gd.sx } else { self.line_length() };
        if wrap && self.cx >= px && self.cy < self.last() {
            self.cursor_start_of_line(false);
            self.cursor_down();
        } else if self.cx < px {
            self.cx += 1;
            while self.cx < px {
                if !self.gd.get(self.cx, self.cy).padding { break }
                self.cx += 1;
            }
        }
    }

    fn cursor_left(&mut self, wrap: bool) {
        while self.cx > 0 {
            if !self.gd.get(self.cx, self.cy).padding { break }
            self.cx -= 1;
        }
        if self.cx == 0 && self.cy > 0 && (wrap || self.gd.line(self.cy - 1).wrapped) {
            self.cursor_up();
            self.cursor_end_of_line(false, false);
        } else if self.cx > 0 {
            self.cx -= 1;
        }
    }

    fn cursor_down(&mut self) {
        if self.cy < self.last() { self.cy += 1 }
        while self.cx > 0 {
            if !self.gd.get(self.cx, self.cy).padding { break }
            self.cx -= 1;
        }
    }

    fn cursor_up(&mut self) {
        if self.cy > 0 { self.cy -= 1 }
        while self.cx > 0 {
            if !self.gd.get(self.cx, self.cy).padding { break }
            self.cx -= 1;
        }
    }

    fn cursor_start_of_line(&mut self, wrap: bool) {
        if wrap { while self.cy > 0 && self.gd.line(self.cy - 1).wrapped { self.cy -= 1 } }
        self.cx = 0;
    }

    fn cursor_end_of_line(&mut self, wrap: bool, all: bool) {
        if wrap {
            let yy = self.last();
            while self.cy < yy && self.gd.line(self.cy).wrapped { self.cy += 1 }
        }
        self.cx = if all { self.gd.sx } else { self.line_length() };
    }

    /// grid_reader_handle_wrap: the cursor kept inside its line, on to the next one as it wraps;
    /// false past the bottom of the grid.
    fn handle_wrap(&mut self, xx: &mut u32, yy: &mut u32) -> bool {
        while self.cx > *xx {
            if self.cy == *yy { return false }
            self.cursor_start_of_line(false);
            self.cursor_down();
            *xx = if self.gd.line(self.cy).wrapped { self.gd.sx - 1 } else { self.line_length() };
        }
        true
    }

    fn in_set(&self, set: &str) -> bool { self.gd.in_set(self.cx, self.cy, set) }

    fn cursor_next_word(&mut self, separators: &str) {
        // Do not break up wrapped words.
        let mut xx = if self.gd.line(self.cy).wrapped { self.gd.sx - 1 } else { self.line_length() };
        let mut yy = self.last();
        if !self.handle_wrap(&mut xx, &mut yy) { return }
        if !self.in_set(WHITESPACE) {
            if self.in_set(separators) {
                loop { self.cx += 1; if !(self.handle_wrap(&mut xx, &mut yy) && self.in_set(separators) && !self.in_set(WHITESPACE)) { break } }
            } else {
                loop { self.cx += 1; if !(self.handle_wrap(&mut xx, &mut yy) && !(self.in_set(separators) || self.in_set(WHITESPACE))) { break } }
            }
        }
        while self.handle_wrap(&mut xx, &mut yy) && self.in_set(WHITESPACE) { self.cx += 1 }
    }

    fn cursor_next_word_end(&mut self, separators: &str) {
        let mut xx = if self.gd.line(self.cy).wrapped { self.gd.sx - 1 } else { self.line_length() };
        let mut yy = self.last();
        while self.handle_wrap(&mut xx, &mut yy) {
            if self.in_set(WHITESPACE) {
                self.cx += 1;
            } else if self.in_set(separators) {
                loop { self.cx += 1; if !(self.handle_wrap(&mut xx, &mut yy) && self.in_set(separators) && !self.in_set(WHITESPACE)) { break } }
                return;
            } else {
                loop { self.cx += 1; if !(self.handle_wrap(&mut xx, &mut yy) && !(self.in_set(WHITESPACE) || self.in_set(separators))) { break } }
                return;
            }
        }
    }

    fn cursor_previous_word(&mut self, separators: &str, already: bool, stop_at_eol: bool) {
        let word_is_letters;
        // Move back to the previous word character.
        if already || self.in_set(WHITESPACE) {
            loop {
                if self.cx > 0 {
                    self.cx -= 1;
                    if !self.in_set(WHITESPACE) { word_is_letters = !self.in_set(separators); break }
                } else {
                    if self.cy == 0 { return }
                    self.cursor_up();
                    self.cursor_end_of_line(false, false);
                    // Stop if separator at EOL.
                    if stop_at_eol && self.cx > 0 {
                        let oldx = self.cx;
                        self.cx -= 1;
                        let at_eol = self.in_set(WHITESPACE);
                        self.cx = oldx;
                        if at_eol { word_is_letters = false; break }
                    }
                }
            }
        } else {
            word_is_letters = !self.in_set(separators);
        }
        // Move back to the beginning of this word.
        let (mut oldx, mut oldy);
        loop {
            oldx = self.cx;
            oldy = self.cy;
            if self.cx == 0 {
                if self.cy == 0 || !self.gd.line(self.cy - 1).wrapped { break }
                self.cursor_up();
                self.cursor_end_of_line(false, true);
            }
            if self.cx > 0 { self.cx -= 1 }
            if !(!self.in_set(WHITESPACE) && word_is_letters != self.in_set(separators)) { break }
        }
        self.cx = oldx;
        self.cy = oldy;
    }

    fn cursor_jump(&mut self, jc: &str) -> bool {
        let mut px = self.cx;
        let yy = self.last();
        let mut py = self.cy;
        while py <= yy {
            let xx = self.gd.line_length(py);
            while px < xx {
                let gc = self.gd.get(px, py);
                if !gc.padding && gc.data() == jc { self.cx = px; self.cy = py; return true }
                px += 1;
            }
            if py == yy || !self.gd.line(py).wrapped { return false }
            px = 0;
            py += 1;
        }
        false
    }

    fn cursor_jump_back(&mut self, jc: &str) -> bool {
        let mut xx = self.cx + 1;
        let mut py = self.cy + 1;
        while py > 0 {
            let mut px = xx;
            while px > 0 {
                let gc = self.gd.get(px - 1, py - 1);
                if !gc.padding && gc.data() == jc { self.cx = px - 1; self.cy = py - 1; return true }
                px -= 1;
            }
            if py == 1 || !self.gd.line(py - 2).wrapped { return false }
            xx = self.gd.line_length(py - 2);
            py -= 1;
        }
        false
    }

    fn cursor_back_to_indentation(&mut self) {
        let yy = self.last();
        let (oldx, oldy) = (self.cx, self.cy);
        self.cursor_start_of_line(true);
        let mut py = self.cy;
        while py <= yy {
            let xx = self.gd.line_length(py);
            for px in 0..xx {
                if !self.gd.get(px, py).is(' ') { self.cx = px; self.cy = py; return }
            }
            if !self.gd.line(py).wrapped { break }
            py += 1;
        }
        self.cx = oldx;
        self.cy = oldy;
    }
}

// ── the mode ─────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Drag { None, EndSel, Sel }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LineSel { None, LeftRight, RightLeft }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SelFlag { Char, Word, Line }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SearchType { Off, Up, Down }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Jump { Off, Forward, Backward, ToForward, ToBackward }

/// The screen's selection (struct screen_sel), in screen rows.
#[derive(Clone, Copy, Debug)]
pub struct Sel { pub sx: u32, pub sy: u32, pub ex: u32, pub ey: u32, pub rect: bool, pub emacs: bool, pub hidden: bool }

/// A pane's last search (wp->searchstr, wp->searchregex): the next copy mode starts with it.
#[derive(Clone, Default, Debug)]
pub struct PaneSearch { pub str: Option<String>, pub regex: bool }

/// The options copy mode reads as it goes: mode-keys (vi), wrap-search, word-separators.
#[derive(Clone, Debug)]
pub struct Ctx { pub vi: bool, pub wrap: bool, pub ws: String }

/// What a command leaves: nothing more, a redraw, or the mode ended (window_copy_cmd_action).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action { Nothing, Redraw, Cancel }

/// window_copy_mode_data.
pub struct Copy {
    pub view: bool,
    pub backing: Grid,
    written: bool,
    /// View mode's writing position on the backing screen (the backing's cursor).
    wx: u32,
    wy: u32,
    /// The mode's screen (the pane's size) and its selection.
    pub sx: u32,
    pub sy: u32,
    pub sel: Option<Sel>,
    pub oy: u32,
    pub selx: u32,
    pub sely: u32,
    pub endselx: u32,
    pub endsely: u32,
    pub cursordrag: Drag,
    pub emacs: bool,
    pub lineflag: LineSel,
    pub rectflag: bool,
    pub scroll_exit: bool,
    pub hide_position: bool,
    pub selflag: SelFlag,
    pub separators: Option<String>,
    pub dx: u32,
    pub dy: u32,
    pub selrx: u32,
    pub selry: u32,
    pub endselrx: u32,
    pub endselry: u32,
    pub cx: u32,
    pub cy: u32,
    pub lastcx: u32,
    pub lastsx: u32,
    pub mx: u32,
    pub my: u32,
    pub showmark: bool,
    pub searchtype: SearchType,
    pub searchdirection: bool,
    pub searchregex: bool,
    pub searchstr: Option<String>,
    pub searchmark: Option<Vec<u8>>,
    pub searchcount: i32,
    pub searchmore: bool,
    pub searchall: bool,
    pub searchx: i64,
    pub searchy: i64,
    pub searcho: i64,
    searchgen: u8,
    pub timeout: bool,
    pub jumptype: Jump,
    pub jumpchar: Option<String>,
    /// wme->prefix: the count the next command repeats by.
    pub prefix: u32,
    /// View mode's text state between lines (the input_ctx's cell).
    pub ictx_template: Option<alacritty_terminal::term::cell::Cell>,
}

/// The search string as a line of cells (screen_write_nputs into a one-line screen).
fn search_cells(s: &str) -> Vec<(String, u8)> {
    let mut out = Vec::new();
    for c in s.chars() {
        let w = c.width().unwrap_or(0);
        if w == 0 {
            // A zero-width character joins the cell before it.
            if let Some(last) = out.iter_mut().rev().find(|(_, w): &&mut (String, u8)| *w != 0) { last.0.push(c) }
            continue;
        }
        out.push((c.to_string(), w as u8));
        if w == 2 { out.push((String::new(), 0)) }
    }
    out
}

/// window_copy_is_lowercase.
fn is_lowercase(s: &str) -> bool { s.chars().all(|c| !c.is_ascii_uppercase()) }

impl Copy {
    fn common(sx: u32, sy: u32, ps: &PaneSearch, emacs: bool, backing: Grid) -> Copy {
        let (searchtype, searchregex, searchstr) = match &ps.str { Some(s) => (SearchType::Up, ps.regex, Some(s.clone())), None => (SearchType::Off, false, None) };
        Copy {
            view: false, backing, written: false, wx: 0, wy: 0, sx, sy, sel: None, oy: 0,
            selx: 0, sely: 0, endselx: 0, endsely: 0, cursordrag: Drag::None, emacs, lineflag: LineSel::None,
            rectflag: false, scroll_exit: false, hide_position: false, selflag: SelFlag::Char, separators: None,
            dx: 0, dy: 0, selrx: 0, selry: 0, endselrx: 0, endselry: 0, cx: 0, cy: 0, lastcx: 0, lastsx: 0,
            mx: 0, my: 0, showmark: false, searchtype, searchdirection: false, searchregex, searchstr,
            searchmark: None, searchcount: 0, searchmore: false, searchall: true, searchx: -1, searchy: -1, searcho: -1,
            searchgen: 0, timeout: false, jumptype: Jump::Off, jumpchar: None, prefix: 1, ictx_template: None,
        }
    }

    /// window_copy_init: the pane's grid, its cursor at (cx, cy) on the screen, shown at the
    /// mode's size [sx]×[sy].
    pub fn copy(backing: Grid, cursor: (u32, u32), sx: u32, sy: u32, ps: &PaneSearch, emacs: bool, scroll_exit: bool, hide_position: bool) -> Copy {
        let (mut cx, mut row) = cursor;
        if row > backing.sy.saturating_sub(1) { cx = 0; row = backing.sy.saturating_sub(1) }
        let mut cy = backing.hsize + row;
        let mut d = Copy::common(sx, sy, ps, emacs, backing);
        // screen_resize_cursor to the mode's size, the cursor kept where it was in the text.
        d.resize_backing(sx, sy, &mut cx, &mut cy);
        d.cx = cx;
        let hsize = d.backing.hsize;
        if cy < hsize { d.cy = 0; d.oy = hsize - cy } else { d.cy = cy - hsize; d.oy = 0 }
        d.scroll_exit = scroll_exit;
        d.hide_position = hide_position;
        d.mx = d.cx;
        d.my = hsize + d.cy - d.oy;
        d.showmark = false;
        d
    }

    /// window_copy_view_init: an empty screen the lines a command prints are written to.
    pub fn view(sx: u32, sy: u32, ps: &PaneSearch, emacs: bool) -> Copy {
        let mut d = Copy::common(sx.max(1), sy.max(1), ps, emacs, Grid::new(sx.max(1), sy.max(1)));
        d.view = true;
        d.mx = d.cx;
        d.my = d.backing.hsize + d.cy - d.oy;
        d
    }

    fn hsize(&self) -> u32 { self.backing.hsize }
    /// The cursor's line in the backing grid (screen_hsize(backing) + cy - oy).
    fn abs_cy(&self) -> u32 { self.backing.hsize + self.cy - self.oy }
    fn find_length(&self, py: u32) -> u32 { self.backing.line_length(py) }
    fn in_set(&self, px: u32, py: u32, set: &str) -> bool { self.backing.in_set(px, py, set) }

    // ── view mode's writing (window_copy_vadd) ──────────────────────────────

    /// The backing's cursor down a line: at the bottom the top line goes into the history, the
    /// view kept where it was (as the backing's history grows, oy with it).
    fn linefeed(&mut self) {
        let sy = self.backing.sy;
        if self.wy + 1 < sy { self.wy += 1; return }
        let at = self.backing.hsize as usize;
        if let Some(l) = self.backing.lines.get_mut(at) { l.time = now() }
        self.backing.hsize += 1;
        self.backing.hscrolled += 1;
        self.backing.lines.push(Line::default());
    }

    fn put(&mut self, cell: Cell, extra: Option<&str>) {
        let sx = self.backing.sx;
        let w = cell.width.max(1) as u32;
        if self.wx + w > sx {
            // At the edge: the line goes on in the next (screen_write_cell's wrap).
            let y = self.backing.hsize + self.wy;
            self.backing.line_mut(y).wrapped = true;
            self.linefeed();
            self.wx = 0;
            if w > sx { return }
        }
        let y = self.backing.hsize + self.wy;
        let x = self.wx;
        let line = self.backing.line_mut(y);
        while line.cells.len() < (x + w) as usize { line.cells.push(Cell::DEFAULT) }
        line.cells[x as usize] = cell;
        if w == 2 { line.cells[x as usize + 1] = Cell { width: 0, ..cell } }
        line.extra.retain(|(c, _)| *c != x);
        if let Some(e) = extra { line.extra.push((x, e.to_string())) }
        self.wx += w;
    }

    /// window_copy_add (not parsed): a line of plain text on a new line of the view, wrapped at
    /// its width. Returns nothing; the view stays where it was.
    pub fn add_text(&mut self, text: &str) {
        let old_hsize = self.backing.hsize;
        self.start_line();
        for c in text.chars() {
            match c {
                '\n' => { self.linefeed(); self.wx = 0 }
                c if (c as u32) < 0x20 || c == '\x7f' => {}
                c => {
                    let w = c.width().unwrap_or(0);
                    if w == 0 {
                        let (x, y) = (self.wx.saturating_sub(1), self.backing.hsize + self.wy);
                        let line = self.backing.line_mut(y);
                        match line.extra.iter_mut().find(|(e, _)| *e == x) { Some((_, s)) => s.push(c), None => line.extra.push((x, c.to_string())) }
                        continue;
                    }
                    self.put(Cell { c, width: w as u8, ..Cell::DEFAULT }, None);
                }
            }
        }
        self.oy += self.backing.hsize - old_hsize;
    }

    /// window_copy_add, parsed: a line already turned into cells (its escapes read), cut at the
    /// view's width as tmux cuts it (only the writing screen's first line is copied).
    pub fn add_cells(&mut self, cells: Vec<(Cell, Option<String>)>) {
        let old_hsize = self.backing.hsize;
        self.start_line();
        let sx = self.backing.sx;
        let mut used = 0;
        for (cell, extra) in cells {
            let w = cell.width.max(1) as u32;
            if used + w > sx { break }
            used += w;
            self.put(cell, extra.as_deref());
        }
        self.oy += self.backing.hsize - old_hsize;
    }

    fn start_line(&mut self) {
        if self.written { self.wx = 0; self.linefeed() } else { self.written = true }
    }

    // ── cursor and selection ─────────────────────────────────────────────────

    /// window_copy_update_cursor.
    fn update_cursor(&mut self, cx: u32, cy: u32) { self.cx = cx; self.cy = cy }

    /// window_copy_start_selection.
    fn start_selection(&mut self, ctx: &Ctx) {
        self.selx = self.cx;
        self.sely = self.abs_cy();
        self.endselx = self.selx;
        self.endsely = self.sely;
        self.cursordrag = Drag::EndSel;
        self.set_selection(false, ctx);
    }

    /// window_copy_adjust_selection: a selection end in screen rows, and whether it is above,
    /// on or below the screen.
    fn adjust_selection(&self, selx: &mut u32, sely: &mut u32) -> i8 {
        let (mut sx, mut sy) = (*selx, *sely);
        let ty = self.hsize() - self.oy;
        let relpos;
        if sy < ty {
            relpos = -1;
            if !self.rectflag { sx = 0 }
            sy = 0;
        } else if sy > ty + self.sy - 1 {
            relpos = 1;
            if !self.rectflag { sx = self.sx - 1 }
            sy = self.sy - 1;
        } else {
            relpos = 0;
            sy -= ty;
        }
        *selx = sx;
        *sely = sy;
        relpos
    }

    /// window_copy_update_selection.
    fn update_selection(&mut self, no_reset: bool, ctx: &Ctx) -> bool {
        if self.sel.is_none() && self.lineflag == LineSel::None { return false }
        self.set_selection(no_reset, ctx)
    }

    /// window_copy_set_selection.
    fn set_selection(&mut self, no_reset: bool, ctx: &Ctx) -> bool {
        self.synchronize_cursor(no_reset, ctx);
        let (mut sx, mut sy) = (self.selx, self.sely);
        let startrelpos = self.adjust_selection(&mut sx, &mut sy);
        let (mut endsx, mut endsy) = (self.endselx, self.endsely);
        let endrelpos = self.adjust_selection(&mut endsx, &mut endsy);
        // Selection is outside of the current screen.
        if startrelpos == endrelpos && startrelpos != 0 {
            if let Some(s) = self.sel.as_mut() { s.hidden = true }
            return false;
        }
        self.sel = Some(Sel { sx, sy, ex: endsx, ey: endsy, rect: self.rectflag, emacs: self.emacs, hidden: false });
        true
    }

    /// window_copy_synchronize_cursor_end.
    fn synchronize_cursor_end(&mut self, mut begin: bool, no_reset: bool, ctx: &Ctx) {
        let (mut xx, mut yy) = (self.cx, self.abs_cy());
        match self.selflag {
            SelFlag::Word => {
                if !no_reset {
                    begin = false;
                    let ws = self.separators.clone().unwrap_or_default();
                    if self.dy > yy || (self.dy == yy && self.dx > xx) {
                        // Right to left selection.
                        (xx, yy) = self.previous_word_pos(&ws);
                        begin = true;
                        // Reset the end.
                        self.endselx = self.endselrx;
                        self.endsely = self.endselry;
                    } else {
                        // Left to right selection.
                        if xx >= self.find_length(yy) || !self.in_set(xx + 1, yy, WHITESPACE) {
                            (xx, yy) = self.next_word_end_pos(&ws, ctx);
                        }
                        // Reset the start.
                        self.selx = self.selrx;
                        self.sely = self.selry;
                    }
                }
            }
            SelFlag::Line => {
                if !no_reset {
                    begin = false;
                    if self.dy > yy {
                        // Right to left selection.
                        xx = 0;
                        begin = true;
                        self.endselx = self.endselrx;
                        self.endsely = self.endselry;
                    } else {
                        if yy < self.endselry { yy = self.endselry }
                        xx = self.find_length(yy);
                        self.selx = self.selrx;
                        self.sely = self.selry;
                    }
                }
            }
            SelFlag::Char => {}
        }
        if begin { self.selx = xx; self.sely = yy } else { self.endselx = xx; self.endsely = yy }
    }

    /// window_copy_synchronize_cursor.
    fn synchronize_cursor(&mut self, no_reset: bool, ctx: &Ctx) {
        match self.cursordrag {
            Drag::EndSel => self.synchronize_cursor_end(false, no_reset, ctx),
            Drag::Sel => self.synchronize_cursor_end(true, no_reset, ctx),
            Drag::None => {}
        }
    }

    /// window_copy_clear_selection.
    pub fn clear_selection(&mut self) {
        self.sel = None;
        self.cursordrag = Drag::None;
        self.lineflag = LineSel::None;
        self.selflag = SelFlag::Char;
        let py = self.abs_cy();
        let px = self.find_length(py);
        if self.cx > px { self.update_cursor(px, self.cy) }
    }

    /// window_copy_clear_marks.
    fn clear_marks(&mut self) { self.searchmark = None }

    // ── scrolling ────────────────────────────────────────────────────────────

    /// window_copy_scroll_up: the view down toward the newest line by [ny].
    fn scroll_up(&mut self, mut ny: u32, ctx: &Ctx) {
        if self.oy < ny { ny = self.oy }
        if ny == 0 { return }
        self.oy -= ny;
        if self.searchmark.is_some() && !self.timeout { self.search_marks(None, self.searchregex, true) }
        self.update_selection(false, ctx);
    }

    /// window_copy_scroll_down: the view up into the history by [ny].
    fn scroll_down(&mut self, mut ny: u32, ctx: &Ctx) {
        if ny > self.hsize() { return }
        if self.oy > self.hsize() - ny { ny = self.hsize() - self.oy }
        if ny == 0 { return }
        self.oy += ny;
        if self.searchmark.is_some() && !self.timeout { self.search_marks(None, self.searchregex, true) }
        self.update_selection(false, ctx);
    }

    /// window_copy_cursor_up.
    fn cursor_up(&mut self, scroll_only: bool, ctx: &Ctx) {
        let norectsel = self.sel.is_none() || !self.rectflag;
        let oy = self.abs_cy();
        let ox = self.find_length(oy);
        if norectsel && self.cx != ox { self.lastcx = self.cx; self.lastsx = ox }
        if self.lineflag == LineSel::LeftRight && oy == self.sely { self.other_end(ctx) }
        if scroll_only || self.cy == 0 {
            if norectsel { self.cx = self.lastcx }
            self.scroll_down(1, ctx);
        } else {
            if norectsel { self.update_cursor(self.lastcx, self.cy - 1) } else { self.update_cursor(self.cx, self.cy - 1) }
            self.update_selection(false, ctx);
        }
        if norectsel {
            let py = self.abs_cy();
            let px = self.find_length(py);
            if (self.cx >= self.lastsx && self.cx != px) || self.cx > px {
                self.update_cursor(px, self.cy);
                self.update_selection(false, ctx);
            }
        }
        if self.lineflag == LineSel::LeftRight {
            let py = self.abs_cy();
            let px = if self.rectflag { self.backing.sx } else { self.find_length(py) };
            self.update_cursor(px, self.cy);
            self.update_selection(false, ctx);
        } else if self.lineflag == LineSel::RightLeft {
            self.update_cursor(0, self.cy);
            self.update_selection(false, ctx);
        }
    }

    /// window_copy_cursor_down.
    fn cursor_down(&mut self, scroll_only: bool, ctx: &Ctx) {
        let norectsel = self.sel.is_none() || !self.rectflag;
        let oy = self.abs_cy();
        let ox = self.find_length(oy);
        if norectsel && self.cx != ox { self.lastcx = self.cx; self.lastsx = ox }
        if self.lineflag == LineSel::RightLeft && oy == self.endsely { self.other_end(ctx) }
        if scroll_only || self.cy == self.sy - 1 {
            if norectsel { self.cx = self.lastcx }
            self.scroll_up(1, ctx);
        } else {
            if norectsel { self.update_cursor(self.lastcx, self.cy + 1) } else { self.update_cursor(self.cx, self.cy + 1) }
            self.update_selection(false, ctx);
        }
        if norectsel {
            let py = self.abs_cy();
            let px = self.find_length(py);
            if (self.cx >= self.lastsx && self.cx != px) || self.cx > px {
                self.update_cursor(px, self.cy);
                self.update_selection(false, ctx);
            }
        }
        if self.lineflag == LineSel::LeftRight {
            let py = self.abs_cy();
            let px = if self.rectflag { self.backing.sx } else { self.find_length(py) };
            self.update_cursor(px, self.cy);
            self.update_selection(false, ctx);
        } else if self.lineflag == LineSel::RightLeft {
            self.update_cursor(0, self.cy);
            self.update_selection(false, ctx);
        }
    }

    /// window_copy_acquire_cursor_up: a move that may leave the screen scrolls it along.
    fn acquire_cursor_up(&mut self, hsize: u32, oy: u32, px: u32, py: u32, ctx: &Ctx) {
        let yy = hsize - oy;
        let (mut ny, cy) = if py < yy { (yy - py, 0) } else { (0, py - yy) };
        while ny > 0 { self.cursor_up(true, ctx); ny -= 1 }
        self.update_cursor(px, cy);
        self.update_selection(false, ctx);
    }

    /// window_copy_acquire_cursor_down.
    fn acquire_cursor_down(&mut self, hsize: u32, sy: u32, oy: u32, px: u32, py: u32, no_reset: bool, ctx: &Ctx) {
        let cy = (py as i64 - hsize as i64 + oy as i64).max(0) as u32;
        let yy = sy - 1;
        let mut ny = if cy > yy { cy - yy } else { 0 };
        while ny > 0 { self.cursor_down(true, ctx); ny -= 1 }
        if cy > yy { self.update_cursor(px, yy) } else { self.update_cursor(px, cy) }
        self.update_selection(no_reset, ctx);
    }

    fn reader(&self) -> Reader<'_> { Reader::new(&self.backing, self.cx, self.abs_cy()) }

    /// window_copy_cursor_start_of_line.
    fn cursor_start_of_line(&mut self, ctx: &Ctx) {
        let (hsize, oy) = (self.hsize(), self.oy);
        let mut gr = self.reader();
        gr.cursor_start_of_line(true);
        let (px, py) = (gr.cx, gr.cy);
        self.acquire_cursor_up(hsize, oy, px, py, ctx);
    }

    /// window_copy_cursor_back_to_indentation.
    fn cursor_back_to_indentation(&mut self, ctx: &Ctx) {
        let (hsize, oy) = (self.hsize(), self.oy);
        let mut gr = self.reader();
        gr.cursor_back_to_indentation();
        let (px, py) = (gr.cx, gr.cy);
        self.acquire_cursor_up(hsize, oy, px, py, ctx);
    }

    /// window_copy_cursor_end_of_line.
    fn cursor_end_of_line(&mut self, ctx: &Ctx) {
        let (hsize, oy, sy) = (self.hsize(), self.oy, self.backing.sy);
        let all = self.sel.is_some() && self.rectflag;
        let mut gr = self.reader();
        gr.cursor_end_of_line(true, all);
        let (px, py) = (gr.cx, gr.cy);
        self.acquire_cursor_down(hsize, sy, oy, px, py, false, ctx);
    }

    /// window_copy_other_end.
    fn other_end(&mut self, ctx: &Ctx) {
        if self.sel.is_none() && self.lineflag == LineSel::None { return }
        self.lineflag = match self.lineflag { LineSel::LeftRight => LineSel::RightLeft, LineSel::RightLeft => LineSel::LeftRight, l => l };
        self.cursordrag = match self.cursordrag { Drag::None | Drag::Sel => Drag::EndSel, Drag::EndSel => Drag::Sel };
        let (mut selx, mut sely) = (self.endselx, self.endsely);
        if self.cursordrag == Drag::Sel { selx = self.selx; sely = self.sely }
        let cy = self.cy;
        let yy = self.abs_cy();
        self.cx = selx;
        let hsize = self.hsize();
        if sely < hsize - self.oy {
            self.oy = hsize - sely;
            self.cy = 0;
        } else if sely > hsize - self.oy + self.sy {
            self.oy = hsize - sely + self.sy - 1;
            self.cy = self.sy - 1;
        } else {
            self.cy = (cy as i64 + sely as i64 - yy as i64) as u32;
        }
        self.update_selection(true, ctx);
    }

    /// window_copy_cursor_left.
    fn cursor_left(&mut self, ctx: &Ctx) {
        let (hsize, oy) = (self.hsize(), self.oy);
        let mut gr = self.reader();
        gr.cursor_left(true);
        let (px, py) = (gr.cx, gr.cy);
        self.acquire_cursor_up(hsize, oy, px, py, ctx);
    }

    /// window_copy_cursor_right.
    fn cursor_right(&mut self, all: bool, ctx: &Ctx) {
        let (hsize, oy, sy) = (self.hsize(), self.oy, self.backing.sy);
        let mut gr = self.reader();
        gr.cursor_right(true, all);
        let (px, py) = (gr.cx, gr.cy);
        self.acquire_cursor_down(hsize, sy, oy, px, py, false, ctx);
    }

    fn jumpchar(&self) -> String { self.jumpchar.clone().unwrap_or_default() }

    /// window_copy_cursor_jump.
    fn cursor_jump(&mut self, ctx: &Ctx) {
        let (hsize, oy, sy, jc) = (self.hsize(), self.oy, self.backing.sy, self.jumpchar());
        let mut gr = Reader::new(&self.backing, self.cx + 1, self.abs_cy());
        if gr.cursor_jump(&jc) {
            let (px, py) = (gr.cx, gr.cy);
            self.acquire_cursor_down(hsize, sy, oy, px, py, false, ctx);
        }
    }

    /// window_copy_cursor_jump_back.
    fn cursor_jump_back(&mut self, ctx: &Ctx) {
        let (hsize, oy, jc) = (self.hsize(), self.oy, self.jumpchar());
        let mut gr = self.reader();
        gr.cursor_left(false);
        if gr.cursor_jump_back(&jc) {
            let (px, py) = (gr.cx, gr.cy);
            self.acquire_cursor_up(hsize, oy, px, py, ctx);
        }
    }

    /// window_copy_cursor_jump_to.
    fn cursor_jump_to(&mut self, ctx: &Ctx) {
        let (hsize, oy, sy, jc) = (self.hsize(), self.oy, self.backing.sy, self.jumpchar());
        let mut gr = Reader::new(&self.backing, self.cx + 2, self.abs_cy());
        if gr.cursor_jump(&jc) {
            gr.cursor_left(true);
            let (px, py) = (gr.cx, gr.cy);
            self.acquire_cursor_down(hsize, sy, oy, px, py, false, ctx);
        }
    }

    /// window_copy_cursor_jump_to_back.
    fn cursor_jump_to_back(&mut self, ctx: &Ctx) {
        let (hsize, oy, jc) = (self.hsize(), self.oy, self.jumpchar());
        let mut gr = self.reader();
        gr.cursor_left(false);
        gr.cursor_left(false);
        if gr.cursor_jump_back(&jc) {
            gr.cursor_right(true, false);
            let (px, py) = (gr.cx, gr.cy);
            self.acquire_cursor_up(hsize, oy, px, py, ctx);
        }
    }

    /// window_copy_cursor_next_word.
    fn cursor_next_word(&mut self, separators: &str, ctx: &Ctx) {
        let (hsize, oy, sy) = (self.hsize(), self.oy, self.backing.sy);
        let mut gr = self.reader();
        gr.cursor_next_word(separators);
        let (px, py) = (gr.cx, gr.cy);
        self.acquire_cursor_down(hsize, sy, oy, px, py, false, ctx);
    }

    /// window_copy_cursor_next_word_end_pos.
    fn next_word_end_pos(&self, separators: &str, ctx: &Ctx) -> (u32, u32) {
        let mut gr = self.reader();
        if ctx.vi {
            if !gr.in_set(WHITESPACE) { gr.cursor_right(false, false) }
            gr.cursor_next_word_end(separators);
            gr.cursor_left(true);
        } else {
            gr.cursor_next_word_end(separators);
        }
        (gr.cx, gr.cy)
    }

    /// window_copy_cursor_next_word_end.
    fn cursor_next_word_end(&mut self, separators: &str, no_reset: bool, ctx: &Ctx) {
        let (hsize, oy, sy) = (self.hsize(), self.oy, self.backing.sy);
        let (px, py) = self.next_word_end_pos(separators, ctx);
        self.acquire_cursor_down(hsize, sy, oy, px, py, no_reset, ctx);
    }

    /// window_copy_cursor_previous_word_pos.
    fn previous_word_pos(&self, separators: &str) -> (u32, u32) {
        let mut gr = self.reader();
        gr.cursor_previous_word(separators, false, true);
        (gr.cx, gr.cy)
    }

    /// window_copy_cursor_previous_word.
    fn cursor_previous_word(&mut self, separators: &str, already: bool, ctx: &Ctx) {
        let stop_at_eol = !ctx.vi;
        let (hsize, oy) = (self.hsize(), self.oy);
        let mut gr = self.reader();
        gr.cursor_previous_word(separators, already, stop_at_eol);
        let (px, py) = (gr.cx, gr.cy);
        self.acquire_cursor_up(hsize, oy, px, py, ctx);
    }

    /// window_copy_cursor_prompt: to the next or previous line an OSC 133 mark begins.
    fn cursor_prompt(&mut self, down: bool, arg: Option<&str>, ctx: &Ctx) {
        let gd = &self.backing;
        let flag = if arg == Some("-o") { LINE_START_OUTPUT } else { LINE_START_PROMPT };
        let mut line = gd.hsize - self.oy + self.cy;
        let end_line = if down { gd.hsize + gd.sy - 1 } else { 0 };
        if line == end_line { return }
        loop {
            if line == end_line { return }
            if down { line += 1 } else { line -= 1 }
            if gd.line(line).flags & flag != 0 { break }
        }
        let hsize = gd.hsize;
        self.cx = 0;
        if line > hsize { self.cy = line - hsize; self.oy = 0 } else { self.cy = 0; self.oy = hsize - line }
        self.update_selection(false, ctx);
    }

    /// window_copy_rectangle_set.
    fn rectangle_set(&mut self, rectflag: bool, ctx: &Ctx) {
        self.rectflag = rectflag;
        let py = self.abs_cy();
        let px = self.find_length(py);
        if self.cx > px { self.update_cursor(px, self.cy) }
        self.update_selection(false, ctx);
    }

    /// window_copy_scroll_to: the cell (px, py) of the grid on the screen, the cursor on it.
    fn scroll_to(&mut self, px: u32, py: u32, no_redraw: bool, ctx: &Ctx) {
        let (hsize, sy) = (self.backing.hsize, self.backing.sy);
        self.cx = px;
        if py >= hsize - self.oy && py < hsize - self.oy + sy {
            self.cy = py - (hsize - self.oy);
        } else {
            let gap = sy / 4;
            let offset;
            if py < sy {
                offset = 0;
                self.cy = py;
            } else if py > hsize + sy - gap {
                offset = hsize;
                self.cy = py - hsize;
            } else {
                offset = py + gap - sy;
                self.cy = py - offset;
            }
            self.oy = hsize - offset;
        }
        if !no_redraw && self.searchmark.is_some() && !self.timeout { self.search_marks(None, self.searchregex, true) }
        self.update_selection(false, ctx);
    }

    /// window_copy_pageup1.
    fn pageup1(&mut self, half_page: bool, ctx: &Ctx) {
        let oy = self.abs_cy();
        let ox = self.find_length(oy);
        if self.cx != ox { self.lastcx = self.cx; self.lastsx = ox }
        self.cx = self.lastcx;
        let n = if self.sy > 2 { if half_page { self.sy / 2 } else { self.sy - 2 } } else { 1 };
        if self.oy + n > self.hsize() {
            self.oy = self.hsize();
            if self.cy < n { self.cy = 0 } else { self.cy -= n }
        } else {
            self.oy += n;
        }
        if self.sel.is_none() || !self.rectflag {
            let py = self.abs_cy();
            let px = self.find_length(py);
            if (self.cx >= self.lastsx && self.cx != px) || self.cx > px { self.cursor_end_of_line(ctx) }
        }
        if self.searchmark.is_some() && !self.timeout { self.search_marks(None, self.searchregex, true) }
        self.update_selection(false, ctx);
    }

    /// window_copy_pagedown1: true when the view is at the bottom and -e says to leave.
    fn pagedown1(&mut self, half_page: bool, scroll_exit: bool, ctx: &Ctx) -> bool {
        let oy = self.abs_cy();
        let ox = self.find_length(oy);
        if self.cx != ox { self.lastcx = self.cx; self.lastsx = ox }
        self.cx = self.lastcx;
        let n = if self.sy > 2 { if half_page { self.sy / 2 } else { self.sy - 2 } } else { 1 };
        if self.oy < n {
            self.oy = 0;
            if self.cy + (n - self.oy) >= self.backing.sy { self.cy = self.backing.sy - 1 } else { self.cy += n - self.oy }
        } else {
            self.oy -= n;
        }
        if self.sel.is_none() || !self.rectflag {
            let py = self.abs_cy();
            let px = self.find_length(py);
            if (self.cx >= self.lastsx && self.cx != px) || self.cx > px { self.cursor_end_of_line(ctx) }
        }
        if scroll_exit && self.oy == 0 { return true }
        if self.searchmark.is_some() && !self.timeout { self.search_marks(None, self.searchregex, true) }
        self.update_selection(false, ctx);
        false
    }

    /// window_copy_pageup (copy-mode -u).
    pub fn pageup(&mut self, half_page: bool, ctx: &Ctx) { self.pageup1(half_page, ctx) }
    /// window_copy_pagedown (copy-mode -d): true when the mode should end.
    pub fn pagedown(&mut self, half_page: bool, scroll_exit: bool, ctx: &Ctx) -> bool { self.pagedown1(half_page, scroll_exit, ctx) }

    /// window_copy_previous_paragraph.
    fn previous_paragraph(&mut self, ctx: &Ctx) {
        let mut oy = self.abs_cy();
        while oy > 0 && self.find_length(oy) == 0 { oy -= 1 }
        while oy > 0 && self.find_length(oy) > 0 { oy -= 1 }
        self.scroll_to(0, oy, false, ctx);
    }

    /// window_copy_next_paragraph.
    fn next_paragraph(&mut self, ctx: &Ctx) {
        let mut oy = self.abs_cy();
        let maxy = self.hsize() + self.sy - 1;
        while oy < maxy && self.find_length(oy) == 0 { oy += 1 }
        while oy < maxy && self.find_length(oy) > 0 { oy += 1 }
        let ox = self.find_length(oy);
        self.scroll_to(ox, oy, false, ctx);
    }

    /// window_copy_goto_line.
    fn goto_line(&mut self, linestr: &str, ctx: &Ctx) {
        let Ok(lineno) = linestr.parse::<i64>() else { return };
        if lineno < -1 || lineno > i32::MAX as i64 { return }
        let lineno = if lineno < 0 || lineno as u32 > self.hsize() { self.hsize() } else { lineno as u32 };
        self.oy = lineno;
        self.update_selection(false, ctx);
    }

    /// window_copy_jump_to_mark.
    fn jump_to_mark(&mut self, ctx: &Ctx) {
        let (tmx, tmy) = (self.cx, self.abs_cy());
        self.cx = self.mx;
        if self.my < self.hsize() { self.cy = 0; self.oy = self.hsize() - self.my } else { self.cy = self.my - self.hsize(); self.oy = 0 }
        self.mx = tmx;
        self.my = tmy;
        self.showmark = true;
        self.update_selection(false, ctx);
    }

    // ── search ───────────────────────────────────────────────────────────────

    /// window_copy_search_mark_at: where a grid cell is in the marks (the screen's cells).
    fn search_mark_at(&self, px: u32, py: u32) -> Option<u32> {
        let gd = &self.backing;
        if py < gd.hsize - self.oy { return None }
        if py > gd.hsize - self.oy + gd.sy - 1 { return None }
        Some((py - (gd.hsize - self.oy)) * gd.sx + px)
    }

    fn mark(&self, at: u32) -> u8 { self.searchmark.as_ref().and_then(|m| m.get(at as usize).copied()).unwrap_or(0) }

    /// window_copy_move_left.
    fn move_left(&self, fx: &mut u32, fy: &mut u32, wrapflag: bool) {
        let s = &self.backing;
        if *fx == 0 {
            if *fy == 0 {
                if wrapflag { *fx = s.sx - 1; *fy = s.hsize + s.sy - 1 }
                return;
            }
            *fx = s.sx - 1;
            *fy -= 1;
        } else {
            *fx -= 1;
        }
    }

    /// window_copy_move_right.
    fn move_right(&self, fx: &mut u32, fy: &mut u32, wrapflag: bool) {
        let s = &self.backing;
        if *fx == s.sx - 1 {
            if *fy == s.hsize + s.sy - 1 {
                if wrapflag { *fx = 0; *fy = 0 }
                return;
            }
            *fx = 0;
            *fy += 1;
        } else {
            *fx += 1;
        }
    }

    /// window_copy_move_after_search_mark.
    fn move_after_search_mark(&self, fx: &mut u32, fy: &mut u32, wrapflag: bool) {
        let s = &self.backing;
        if let Some(start) = self.search_mark_at(*fx, *fy) {
            if self.mark(start) != 0 {
                while let Some(at) = self.search_mark_at(*fx, *fy) {
                    if self.mark(at) != self.mark(start) { break }
                    // Stop if not wrapping and at the end of the grid.
                    if !wrapflag && *fx == s.sx - 1 && *fy == s.hsize + s.sy - 1 { break }
                    self.move_right(fx, fy, wrapflag);
                }
            }
        }
    }

    /// window_copy_search_compare.
    fn search_compare(gd: &Grid, px: u32, py: u32, sgd: &[(String, u8)], spx: u32, cis: bool) -> bool {
        let gc = gd.get(px, py);
        let (sdata, swidth) = &sgd[spx as usize];
        let data = gc.data();
        let width = if gc.padding { 0 } else { gc.width };
        if data.len() != sdata.len() || width != *swidth { return false }
        if cis && data.len() == 1 { return data.as_bytes()[0].to_ascii_lowercase() == sdata.as_bytes()[0] }
        data == sdata.as_str()
    }

    /// window_copy_search_lr: the first match in [first, last) of line py, left to right.
    fn search_lr(gd: &Grid, sgd: &[(String, u8)], py: u32, first: u32, last: u32, cis: bool) -> Option<u32> {
        let endline = gd.hsize + gd.sy - 1;
        let n = sgd.len() as u32;
        for ax in first..last {
            let mut bx = 0;
            while bx < n {
                let mut px = ax + bx;
                let mut pywrap = py;
                // Wrap line.
                while px >= gd.sx && pywrap < endline {
                    if !gd.line(pywrap).wrapped { break }
                    px -= gd.sx;
                    pywrap += 1;
                }
                // We have run off the end of the grid.
                if px >= gd.sx { break }
                if !Copy::search_compare(gd, px, pywrap, sgd, bx, cis) { break }
                bx += 1;
            }
            if bx == n { return Some(ax) }
        }
        None
    }

    /// window_copy_search_rl: the last match in [first, last) of line py.
    fn search_rl(gd: &Grid, sgd: &[(String, u8)], py: u32, first: u32, last: u32, cis: bool) -> Option<u32> {
        let endline = gd.hsize + gd.sy - 1;
        let n = sgd.len() as u32;
        let mut ax = last;
        while ax > first {
            let mut bx = 0;
            while bx < n {
                let mut px = ax - 1 + bx;
                let mut pywrap = py;
                while px >= gd.sx && pywrap < endline {
                    if !gd.line(pywrap).wrapped { break }
                    px -= gd.sx;
                    pywrap += 1;
                }
                if px >= gd.sx { break }
                if !Copy::search_compare(gd, px, pywrap, sgd, bx, cis) { break }
                bx += 1;
            }
            if bx == n { return Some(ax - 1) }
            ax -= 1;
        }
        None
    }

    /// window_copy_stringify: line py's cells from first as text (a cell past the line's end a
    /// blank, a padding cell nothing), with the byte where each cell starts.
    fn stringify(gd: &Grid, py: u32, first: u32, last: u32, buf: &mut String, starts: &mut Vec<usize>) {
        let line = gd.line(py);
        for ax in first..last {
            starts.push(buf.len());
            if ax as usize >= line.cells.len() { buf.push(' '); continue }
            let gc = gd.get(ax, py);
            if gc.padding { continue }
            buf.push_str(&gc.data());
        }
    }

    /// The text a regex search reads from line py at first: the line, and the lines it wraps
    /// onto (up to WINDOW_COPY_SEARCH_MAX_LINE cells). The byte each cell starts at, and how many
    /// cells there are.
    fn search_text(gd: &Grid, py: u32, first: u32) -> (String, Vec<usize>, u32) {
        let (mut buf, mut starts) = (String::new(), Vec::new());
        Copy::stringify(gd, py, first, gd.sx, &mut buf, &mut starts);
        let mut len = gd.sx - first;
        let endline = gd.hsize + gd.sy - 1;
        let mut pywrap = py;
        while pywrap <= endline && len < SEARCH_MAX_LINE {
            if !gd.line(pywrap).wrapped { break }
            pywrap += 1;
            Copy::stringify(gd, pywrap, 0, gd.sx, &mut buf, &mut starts);
            len += gd.sx;
        }
        (buf, starts, len)
    }

    /// window_copy_cstrtocellpos: the cell a byte of the text is in, from (first, py).
    fn cellpos(gd: &Grid, starts: &[usize], first: u32, py: u32, byte: usize) -> (u32, u32) {
        // The first cell starting at that byte (one past the end if none).
        let cell = starts.iter().position(|b| *b == byte).unwrap_or(starts.len()) as u32;
        let (mut px, mut pywrap) = (first + cell, py);
        while px >= gd.sx { px -= gd.sx; pywrap += 1 }
        (px, pywrap)
    }

    /// window_copy_search_lr_regex: the first match starting in [first, last) of line py, and
    /// how many cells it covers.
    fn search_lr_regex(gd: &Grid, py: u32, first: u32, last: u32, re: &regex::Regex) -> Option<(u32, u32)> {
        if first >= last { return None }
        let (buf, starts, _) = Copy::search_text(gd, py, first);
        let m = find(re, &buf, first != 0, 0)?;
        if m.0 == m.1 { return None }
        let (foundx, foundy) = Copy::cellpos(gd, &starts, first, py, m.0);
        if foundy == py && foundx < last {
            let ppx = foundx;
            let (ex, mut ey) = Copy::cellpos(gd, &starts, first, py, m.1);
            let mut psx = ex;
            while ey > py { psx += gd.sx; ey -= 1 }
            return Some((ppx, psx - ppx));
        }
        None
    }

    /// window_copy_search_rl_regex (window_copy_last_regex): the last match starting in
    /// [first, last) of line py.
    fn search_rl_regex(gd: &Grid, py: u32, first: u32, last: u32, re: &regex::Regex) -> Option<(u32, u32)> {
        let (buf, starts, _) = Copy::search_text(gd, py, first);
        let notbol = first != 0;
        let (mut px, mut save): (usize, Option<(u32, u32)>) = (0, None);
        while let Some((so, eo)) = find(re, &buf, notbol, px) {
            if so == eo { break }
            let (foundx, foundy) = Copy::cellpos(gd, &starts, first, py, so);
            if foundy > py || foundx >= last { break }
            let savepx = foundx;
            let (ex, mut ey) = Copy::cellpos(gd, &starts, first, py, eo);
            if ey > py || ex >= last {
                let mut psx = ex;
                while ey > py { psx += gd.sx; ey -= 1 }
                return Some((savepx, psx - savepx));
            }
            save = Some((savepx, ex - savepx));
            px = eo;
        }
        save.filter(|(_, sx)| *sx > 0)
    }

    /// window_copy_search_back_overlap: a backward regex match that begins a line may begin on
    /// the lines before it, when they wrap onto it.
    fn search_back_overlap(gd: &Grid, re: &regex::Regex, ppx: &mut u32, psx: &mut u32, ppy: &mut u32, endline: u32) {
        let mut oldendx = *ppx + *psx;
        let mut oldendy = *ppy - 1;
        while oldendx > gd.sx - 1 { oldendx -= gd.sx; oldendy += 1 }
        let (mut endx, mut endy) = (oldendx, oldendy);
        let (mut px, mut py) = (*ppx, *ppy);
        let mut found = true;
        while found && px == 0 && py >= 2 && py - 1 > endline && gd.line(py - 2).wrapped && endx == oldendx && endy == oldendy {
            py -= 1;
            match Copy::search_rl_regex(gd, py - 1, 0, gd.sx, re) {
                Some((x, sx)) => {
                    px = x;
                    endx = px + sx;
                    endy = py - 1;
                    while endx > gd.sx - 1 { endx -= gd.sx; endy += 1 }
                    if endx == oldendx && endy == oldendy { *ppx = px; *ppy = py }
                }
                None => found = false,
            }
        }
    }

    /// window_copy_search_jump: find the text from (fx, fy) to endline and put the cursor on it;
    /// with wrap, from the other end again.
    #[allow(clippy::too_many_arguments)]
    fn search_jump(&mut self, sgd: &[(String, u8)], text: &str, fx: u32, fy: u32, endline: u32, cis: bool, wrap: bool, direction: bool, regex: bool, ctx: &Ctx) -> bool {
        let re = if regex { match build_regex(text, cis) { Some(r) => Some(r), None => return false } } else { None };
        let gd = &self.backing;
        let mut fx = fx;
        let mut found: Option<(u32, u32)> = None;
        if direction {
            let mut i = fy;
            while i <= endline {
                let hit = match &re { Some(r) => Copy::search_lr_regex(gd, i, fx, gd.sx, r).map(|(x, _)| x), None => Copy::search_lr(gd, sgd, i, fx, gd.sx, cis) };
                if let Some(px) = hit { found = Some((px, i)); break }
                fx = 0;
                i += 1;
            }
        } else {
            let mut i = fy + 1;
            while endline < i {
                let mut hit = None;
                match &re {
                    Some(r) => {
                        if let Some((mut px, mut sx)) = Copy::search_rl_regex(gd, i - 1, 0, fx + 1, r) {
                            Copy::search_back_overlap(gd, r, &mut px, &mut sx, &mut i, endline);
                            hit = Some(px);
                        }
                    }
                    None => hit = Copy::search_rl(gd, sgd, i - 1, 0, fx + 1, cis),
                }
                if let Some(px) = hit { found = Some((px, i - 1)); break }
                fx = gd.sx - 1;
                i -= 1;
            }
        }
        if let Some((px, py)) = found { self.scroll_to(px, py, true, ctx); return true }
        if wrap {
            let (sx, last) = (self.backing.sx - 1, self.backing.hsize + self.backing.sy - 1);
            return self.search_jump(sgd, text, if direction { 0 } else { sx }, if direction { 0 } else { last }, fy, cis, false, direction, regex, ctx);
        }
        false
    }

    /// window_copy_search: search up (direction false) or down for searchstr.
    fn search(&mut self, direction: bool, regex: bool, ps: &mut PaneSearch, ctx: &Ctx) -> bool {
        let Some(text) = self.searchstr.clone() else { return false };
        let regex = regex && text.contains(|c: char| "^$*+()?[].\\".contains(c));
        self.searchdirection = direction;
        if self.timeout { return false }
        let visible_only = if self.searchall || ps.str.is_none() || ps.regex != regex { self.searchall = false; false } else { ps.str.as_deref() == Some(text.as_str()) };
        if !visible_only && self.searchmark.is_some() { self.clear_marks() }
        ps.str = Some(text.clone());
        ps.regex = regex;
        let mut fx = self.cx;
        let mut fy = self.hsize() - self.oy + self.cy;
        let sgd = search_cells(&text);
        let wrapflag = ctx.wrap;
        let cis = is_lowercase(&text);
        let endline;
        if direction {
            // vi leaves the cursor at the start of a match, so the next search starts after it;
            // emacs leaves it after the match.
            if ctx.vi {
                if self.searchmark.is_some() { self.move_after_search_mark(&mut fx, &mut fy, wrapflag) }
                else { self.move_right(&mut fx, &mut fy, wrapflag) }
            }
            endline = self.backing.hsize + self.backing.sy - 1;
        } else {
            self.move_left(&mut fx, &mut fy, wrapflag);
            endline = 0;
        }
        let found = self.search_jump(&sgd, &text, fx, fy, endline, cis, wrapflag, direction, regex, ctx);
        if found {
            self.search_marks(Some(&text), regex, visible_only);
            fx = self.cx;
            fy = self.hsize() - self.oy + self.cy;
            // Searching forward, a cursor not at the start of its mark searches again.
            if direction {
                if let Some(at) = self.search_mark_at(fx, fy) {
                    if at > 0 && self.searchmark.is_some() && self.mark(at) == self.mark(at - 1) {
                        self.move_after_search_mark(&mut fx, &mut fy, wrapflag);
                        self.search_jump(&sgd, &text, fx, fy, endline, cis, wrapflag, direction, regex, ctx);
                        fx = self.cx;
                        fy = self.hsize() - self.oy + self.cy;
                    }
                }
            }
            if direction {
                // Emacs: the cursor just after the mark.
                if !ctx.vi {
                    self.move_after_search_mark(&mut fx, &mut fy, wrapflag);
                    self.cx = fx;
                    self.cy = (fy as i64 - self.hsize() as i64 + self.oy as i64) as u32;
                }
            } else if let Some(start) = self.search_mark_at(fx, fy) {
                // Backward: the cursor at the start of the mark.
                while let Some(at) = self.search_mark_at(fx, fy) {
                    if self.searchmark.is_none() || self.mark(at) != self.mark(start) { break }
                    self.cx = fx;
                    self.cy = (fy as i64 - self.hsize() as i64 + self.oy as i64) as u32;
                    if at == 0 { break }
                    self.move_left(&mut fx, &mut fy, false);
                }
            }
        }
        found
    }

    fn search_up(&mut self, regex: bool, ps: &mut PaneSearch, ctx: &Ctx) -> bool { self.search(false, regex, ps, ctx) }
    fn search_down(&mut self, regex: bool, ps: &mut PaneSearch, ctx: &Ctx) -> bool { self.search(true, regex, ps, ctx) }

    /// window_copy_visible_lines: the lines on the screen, and those before that wrap onto them.
    fn visible_lines(&self) -> (u32, u32) {
        let gd = &self.backing;
        let mut start = gd.hsize - self.oy;
        while start > 0 {
            if !gd.line(start - 1).wrapped { break }
            start -= 1;
        }
        (start, gd.hsize - self.oy + gd.sy)
    }

    /// window_copy_search_marks: every match on the screen marked (each its own generation), and
    /// how many there are in all (unless visible_only) — as many as a fifth of a second finds.
    fn search_marks(&mut self, text: Option<&str>, regex: bool, visible_only: bool) {
        let Some(text) = text.map(str::to_string).or_else(|| self.searchstr.clone()) else { return };
        let sgd = search_cells(&text);
        let cis = is_lowercase(&text);
        let re = if regex { match build_regex(&text, cis) { Some(r) => Some(r), None => return } } else { None };
        let tstart = Instant::now();
        let (mut start, mut end, mut stop) = if visible_only { let (s, e) = self.visible_lines(); (s, e, None) }
            else { (0, self.backing.hsize + self.backing.sy, Some(SEARCH_ALL_TIMEOUT_MS)) };
        let mut nfound: u32;
        let mut stopped;
        loop {
            let (sx, sy) = (self.backing.sx, self.backing.sy);
            let mut marks = vec![0u8; (sx * sy) as usize];
            let mut searchgen: u8 = 1;
            nfound = 0;
            stopped = false;
            let gd = &self.backing;
            for py in start..end {
                let mut px = 0;
                loop {
                    let (x, mut width) = match &re {
                        Some(r) => match Copy::search_lr_regex(gd, py, px, gd.sx, r) { Some(m) => m, None => break },
                        None => match Copy::search_lr(gd, &sgd, py, px, gd.sx, cis) { Some(x) => (x, sgd.len() as u32), None => break },
                    };
                    nfound += 1;
                    if py >= gd.hsize - self.oy && py <= gd.hsize - self.oy + gd.sy - 1 {
                        let b = (py - (gd.hsize - self.oy)) * gd.sx + x;
                        if b + width > sx * sy { width = sx * sy - b }
                        for i in b..b + width { if marks[i as usize] == 0 { marks[i as usize] = searchgen } }
                        searchgen = if searchgen == u8::MAX { 1 } else { searchgen + 1 };
                    }
                    px = x + width.max(1);
                }
                let t = tstart.elapsed().as_millis();
                if t > SEARCH_TIMEOUT_MS { self.timeout = true; break }
                if let Some(limit) = stop { if t > limit { stopped = true; break } }
            }
            self.searchmark = Some(marks);
            self.searchgen = searchgen;
            if self.timeout { self.clear_marks(); return }
            if stopped && stop.is_some() {
                // Try again but just the visible context.
                (start, end) = self.visible_lines();
                stop = None;
                continue;
            }
            break;
        }
        if !visible_only {
            if stopped {
                self.searchcount = if nfound > 1000 { 1000 } else if nfound > 100 { 100 } else if nfound > 10 { 10 } else { -1 };
                self.searchmore = true;
            } else {
                self.searchcount = nfound as i32;
                self.searchmore = false;
            }
        }
    }

    /// window_copy_match_start_end: the cells of the mark at `at`.
    fn match_start_end(&self, at: u32) -> (u32, u32) {
        let gd = &self.backing;
        let last = gd.sy * gd.sx - 1;
        let mark = self.mark(at);
        let (mut start, mut end) = (at, at);
        while start != 0 && self.mark(start) == mark { start -= 1 }
        if self.mark(start) != mark { start += 1 }
        while end != last && self.mark(end) == mark { end += 1 }
        if self.mark(end) != mark { end -= 1 }
        (start, end)
    }

    /// window_copy_match_at_cursor: the match the cursor is on (or just after).
    pub fn match_at_cursor(&self) -> Option<String> {
        self.searchmark.as_ref()?;
        let cy = self.hsize() - self.oy + self.cy;
        let mut at = self.search_mark_at(self.cx, cy)?;
        if self.mark(at) == 0 {
            // Allow one position after the match.
            if at == 0 { return None }
            at -= 1;
            if self.mark(at) == 0 { return None }
        }
        let (start, end) = self.match_start_end(at);
        let sx = self.backing.sx;
        let mut buf = String::new();
        for at in start..=end {
            let py = at / sx;
            let px = at - py * sx;
            buf.push_str(&self.backing.get(px, self.backing.hsize + py - self.oy).data());
        }
        (!buf.is_empty()).then_some(buf)
    }

    // ── copying ──────────────────────────────────────────────────────────────

    /// window_copy_copy_line: a line's cells from sx to ex, and a newline unless it wrapped.
    fn copy_line(&self, buf: &mut String, sy: u32, mut sx: u32, mut ex: u32) {
        if sx > ex { return }
        let gd = &self.backing;
        let gl = gd.line(sy);
        // A line wrapped at the screen's edge, all of it on screen: its blanks count.
        let wrapped = gl.wrapped && gl.cells.len() as u32 <= gd.sx;
        let xx = if wrapped { gl.cells.len() as u32 } else { self.find_length(sy) };
        if ex > xx { ex = xx }
        if sx > xx { sx = xx }
        for i in sx..ex {
            let gc = gd.get(i, sy);
            if gc.padding { continue }
            buf.push_str(&gc.data());
        }
        if !wrapped || ex != xx { buf.push('\n') }
    }

    /// window_copy_get_selection: the selected text — or, with no selection, the match the
    /// cursor is on.
    pub fn get_selection(&self, ctx: &Ctx) -> Option<String> {
        if self.sel.is_none() && self.lineflag == LineSel::None { return self.match_at_cursor() }
        let mut buf = String::new();
        // Find start and end.
        let (xx, yy) = (self.endselx, self.endsely);
        let (sx, sy, mut ex, ey) = if yy < self.sely || (yy == self.sely && xx < self.selx) { (xx, yy, self.selx, self.sely) } else { (self.selx, self.sely, xx, yy) };
        // Trim ex to end of line.
        let ey_last = self.find_length(ey);
        if ex > ey_last { ex = ey_last }
        let xx = self.sx;
        let (firstsx, lastex, restex, restsx);
        if self.rectflag {
            // The column with the cursor in it is left out, which for a rectangle means knowing
            // which side it is on.
            let selx = if self.cursordrag == Drag::EndSel { self.selx } else { self.endselx };
            if selx < self.cx {
                // Selection start is on the left.
                if !ctx.vi { lastex = self.cx; restex = self.cx } else { lastex = self.cx + 1; restex = self.cx + 1 }
                firstsx = selx;
                restsx = selx;
            } else {
                // Cursor is on the left.
                lastex = selx + 1;
                restex = selx + 1;
                firstsx = self.cx;
                restsx = self.cx;
            }
        } else {
            lastex = if !ctx.vi { ex } else { ex + 1 };
            restex = xx;
            firstsx = sx;
            restsx = 0;
        }
        for i in sy..=ey {
            self.copy_line(&mut buf, i, if i == sy { firstsx } else { restsx }, if i == ey { lastex } else { restex });
        }
        if buf.is_empty() { return None }
        // Remove the final newline (unless at the end in vi mode).
        if (!ctx.vi || lastex <= ey_last) && (!self.backing.line(ey).wrapped || lastex != ey_last) { buf.pop(); }
        Some(buf)
    }

    // ── mouse drags ──────────────────────────────────────────────────────────

    /// window_copy_start_drag: a selection begun at (x, y) of the screen.
    pub fn start_drag(&mut self, x: u32, y: u32, ctx: &Ctx) {
        let yg = self.hsize() + y - self.oy;
        if x < self.selrx || x > self.endselrx || yg != self.selry { self.selflag = SelFlag::Char }
        match self.selflag {
            SelFlag::Word => {
                let (mut x, mut y) = (x, y);
                if let Some(ws) = self.separators.clone() {
                    self.update_cursor(x, y);
                    let (px, py) = self.previous_word_pos(&ws);
                    x = px;
                    y = py - (self.hsize() - self.oy);
                }
                self.update_cursor(x, y);
            }
            SelFlag::Line => self.update_cursor(0, y),
            SelFlag::Char => { self.update_cursor(x, y); self.start_selection(ctx) }
        }
    }

    /// window_copy_drag_update: the selection's end to (x, y); true when the view should keep
    /// scrolling (the mouse on the top or bottom row) — up when the second is true.
    pub fn drag_update(&mut self, x: u32, y: u32, ctx: &Ctx) -> Option<bool> {
        let (old_cx, old_cy) = (self.cx, self.cy);
        self.update_cursor(x, y);
        self.update_selection(false, ctx);
        if old_cy != self.cy || old_cx == self.cx {
            if y == 0 { self.cursor_up(true, ctx); return Some(true) }
            if y == self.sy - 1 { self.cursor_down(true, ctx); return Some(false) }
        }
        None
    }

    /// window_copy_scroll_timer: a drag held at the top or bottom scrolls on.
    pub fn scroll_timer(&mut self, ctx: &Ctx) -> bool {
        if self.cy == 0 { self.cursor_up(true, ctx); return true }
        if self.cy == self.sy - 1 { self.cursor_down(true, ctx); return true }
        false
    }

    /// window_copy_move_mouse: the cursor to where a mouse key was.
    pub fn move_mouse(&mut self, x: u32, y: u32) { self.update_cursor(x, y) }

    // ── size ─────────────────────────────────────────────────────────────────

    /// screen_resize_cursor for the backing: the height first (lines to or from the history),
    /// then the width, the lines reflowed; (cx, cy) a grid position kept on the same text.
    fn resize_backing(&mut self, sx: u32, sy: u32, cx: &mut u32, cy: &mut u32) {
        let (sx, sy) = (sx.max(1), sy.max(1));
        let reflow = sx != self.backing.sx;
        let wrap = if reflow { Some(wrap_position(&self.backing, *cx, *cy)) } else { None };
        let gd = &mut self.backing;
        if sy < gd.sy {
            let needed = gd.sy - sy;
            gd.hscrolled += needed;
            gd.hsize += needed;
        } else if sy > gd.sy {
            let mut needed = sy - gd.sy;
            let available = gd.hscrolled.min(needed);
            gd.hscrolled -= available;
            gd.hsize -= available;
            needed -= available;
            let _ = needed;
        }
        gd.sy = sy;
        let total = (gd.hsize + sy) as usize;
        while gd.lines.len() < total { gd.lines.push(Line::default()) }
        gd.lines.truncate(total);
        if reflow {
            reflow_grid(gd, sx);
            if let Some((wx, wy)) = wrap { (*cx, *cy) = unwrap_position(gd, wx, wy) }
        }
        gd.sx = sx;
    }

    /// window_copy_resize: the mode at a new size — the text reflowed, the cursor kept on it, the
    /// selection and marks gone.
    pub fn resize(&mut self, sx: u32, sy: u32, ctx: &Ctx) {
        let (sx, sy) = (sx.max(1), sy.max(1));
        self.sx = sx;
        self.sy = sy;
        let mut cx = self.cx;
        let mut cy = self.backing.hsize + self.cy - self.oy;
        self.resize_backing(sx, sy, &mut cx, &mut cy);
        let hsize = self.backing.hsize;
        self.cx = cx;
        if cy < hsize { self.cy = 0; self.oy = hsize - cy } else { self.cy = (cy - hsize).min(sy - 1); self.oy = 0 }
        self.size_changed(ctx);
    }

    /// window_copy_size_changed.
    fn size_changed(&mut self, ctx: &Ctx) {
        let search = self.searchmark.is_some();
        self.clear_selection();
        self.clear_marks();
        if search && !self.timeout { self.search_marks(None, self.searchregex, false) }
        self.searchx = self.cx as i64;
        self.searchy = self.cy as i64;
        self.searcho = self.oy as i64;
        let _ = ctx;
    }

    /// refresh-from-pane: a new copy of the pane's grid.
    pub fn refresh(&mut self, backing: Grid, ctx: &Ctx) {
        if self.view { return }
        self.backing = backing;
        let (mut cx, mut cy) = (0, 0);
        self.resize_backing(self.sx, self.sy, &mut cx, &mut cy);
        if self.oy > self.backing.hsize { self.oy = self.backing.hsize }
        self.size_changed(ctx);
    }

    // ── what it shows ────────────────────────────────────────────────────────

    /// The position indicator (window_copy_write_line's header): `(N results) [oy/hsize]`,
    /// with the top line's time when it has one.
    pub fn header(&self) -> Option<String> {
        if self.hide_position || self.sy < 2 { return None }
        let hsize = self.hsize();
        let t = self.backing.line(hsize - self.oy).time;
        let tmp = if t == 0 { format!("[{}/{hsize}]", self.oy) } else { format!("{} [{}/{hsize}]", pretty_time(t), self.oy) };
        Some(match &self.searchmark {
            None if self.timeout => format!("(timed out) {tmp}"),
            None => tmp,
            Some(_) if self.searchcount == -1 => tmp,
            Some(_) => format!("({}{} results) {tmp}", self.searchcount, if self.searchmore { "+" } else { "" }),
        })
    }

    /// The screen's row y as window_copy_write_line leaves it: the backing's cells, the header
    /// over the end of the top row.
    pub fn screen_row(&self, y: u32) -> Vec<(String, u8)> {
        let fy = self.hsize() - self.oy + y;
        let hdr = if y == 0 { self.header() } else { None };
        let size = hdr.as_ref().map(|h| (h.len() as u32).min(self.sx)).unwrap_or(0);
        let mut out: Vec<(String, u8)> = Vec::new();
        let nx = self.sx - size;
        let mut fx = 0;
        while fx < nx {
            let gc = self.backing.get(fx, fy);
            let w = if gc.padding { 0 } else { gc.width as u32 };
            if fx + w <= nx { out.push((gc.data().into_owned(), w as u8)) }
            fx += 1;
        }
        if let Some(h) = hdr { for c in h.chars().take(size as usize) { out.push((c.to_string(), 1)) } }
        out
    }

    /// format_grid_word on the mode's screen: the word at (x, y).
    pub fn word_at(&self, x: u32, y: u32, ws: &str) -> Option<String> {
        let row = self.screen_row(y);
        let at = |i: u32| row.get(i as usize).cloned().unwrap_or((" ".into(), 1));
        let sep = |c: &(String, u8)| c.1 != 0 && (c.0 == " " || (c.0.chars().count() == 1 && ws.contains(c.0.as_str())));
        let length = || { let mut n = row.len() as u32; while n > 0 && at(n - 1).0 == " " && at(n - 1).1 == 1 { n -= 1 } n };
        let mut x = x;
        let mut found = false;
        loop {
            let c = at(x);
            if c.1 == 0 { break }
            if sep(&c) { found = true; break }
            if x == 0 { break }
            x -= 1;
        }
        let mut word = String::new();
        loop {
            if found {
                let end = length();
                if end == 0 || x == end - 1 { break }
                x += 1;
            }
            found = true;
            let c = at(x);
            if c.1 == 0 || sep(&c) { break }
            word.push_str(&c.0);
        }
        (!word.is_empty()).then_some(word)
    }

    /// format_grid_line on the mode's screen: row y to its last character.
    pub fn line_at(&self, y: u32) -> Option<String> {
        let row = self.screen_row(y);
        let mut n = row.len();
        while n > 0 && row[n - 1].0 == " " && row[n - 1].1 == 1 { n -= 1 }
        let mut s = String::new();
        for c in &row[..n] { if c.1 == 0 { break } s.push_str(&c.0) }
        (!s.is_empty()).then_some(s)
    }

    /// format_grid_hyperlink on the mode's screen.
    pub fn hyperlink_at(&self, x: u32, y: u32) -> Option<String> {
        let fy = self.hsize() - self.oy + y;
        if self.backing.get(x, fy).padding { return None }
        self.backing.line(fy).link_at(x).map(str::to_string)
    }

    /// window_copy_update_style: a cell's look under the mark and the search matches.
    fn update_style(&self, fx: u32, fy: u32, st: &mut (Color, Color, Modifier), styles: &Styles, ctx: &Ctx) {
        let mut inv = false;
        if self.showmark && fy == self.my {
            let mk = styles.mark;
            st.2 = mk.2;
            if fx == self.mx { inv = true }
            if inv { st.0 = mk.1; st.1 = mk.0 } else { st.0 = mk.0; st.1 = mk.1 }
        }
        if self.searchmark.is_none() { return }
        let Some(current) = self.search_mark_at(fx, fy) else { return };
        let mark = self.mark(current);
        if mark == 0 { return }
        let cy = self.hsize() - self.oy + self.cy;
        if let Some(mut cursor) = self.search_mark_at(self.cx, cy) {
            let mut found = false;
            if cursor != 0 && !ctx.vi && self.searchdirection {
                if self.mark(cursor - 1) == mark { cursor -= 1; found = true }
            } else if self.mark(cursor) == mark {
                found = true;
            }
            if found {
                let (start, end) = self.match_start_end(cursor);
                if current >= start && current <= end {
                    let c = styles.current;
                    st.2 = c.2;
                    if inv { st.0 = c.1; st.1 = c.0 } else { st.0 = c.0; st.1 = c.1 }
                    return;
                }
            }
        }
        let m = styles.matched;
        st.2 = m.2;
        if inv { st.0 = m.1; st.1 = m.0 } else { st.0 = m.0; st.1 = m.1 }
    }

    /// screen_check_selection: whether screen cell (px, py) is selected.
    fn selected(&self, px: u32, py: u32) -> bool {
        let Some(sel) = self.sel else { return false };
        if sel.hidden { return false }
        if sel.rect {
            if sel.sy < sel.ey { if py < sel.sy || py > sel.ey { return false } }
            else if sel.sy > sel.ey { if py > sel.sy || py < sel.ey { return false } }
            else if py != sel.sy { return false }
            if sel.ex < sel.sx { if px < sel.ex || px > sel.sx { return false } }
            else if px < sel.sx || px > sel.ex { return false }
        } else if sel.sy < sel.ey {
            if py < sel.sy || py > sel.ey { return false }
            if py == sel.sy && px < sel.sx { return false }
            let xx = if sel.emacs { sel.ex.saturating_sub(1) } else { sel.ex };
            if py == sel.ey && px > xx { return false }
        } else if sel.sy > sel.ey {
            if py > sel.sy || py < sel.ey { return false }
            if py == sel.ey && px < sel.ex { return false }
            let xx = if sel.emacs { sel.sx.wrapping_sub(1) } else { sel.sx };
            if py == sel.sy && (sel.sx == 0 || px > xx) { return false }
        } else {
            if py != sel.sy { return false }
            if sel.ex < sel.sx {
                let xx = if sel.emacs { sel.sx.wrapping_sub(1) } else { sel.sx };
                if px > xx || px < sel.ex { return false }
            } else {
                let xx = if sel.emacs { sel.ex.saturating_sub(1) } else { sel.ex };
                if px < sel.sx || px > xx { return false }
            }
        }
        true
    }

    /// The mode's screen drawn into [area] (window_copy_write_line for every row, then the
    /// selection over it as the screen is drawn); [window] the pane's default colours
    /// (window-style). Returns where the cursor is.
    pub fn draw(&self, buf: &mut Buffer, area: Rect, styles: &Styles, window: (Option<Color>, Option<Color>), ctx: &Ctx) -> (u16, u16) {
        let sx = self.sx.min(area.width as u32);
        let sy = self.sy.min(area.height as u32);
        let hsize = self.hsize();
        let put = |buf: &mut Buffer, x: u32, y: u32, text: &str, st: (Color, Color, Modifier)| {
            if let Some(cell) = buf.cell_mut((area.x + x as u16, area.y + y as u16)) {
                cell.set_symbol(if text.is_empty() { " " } else { text });
                cell.fg = if st.0 == Color::Reset { window.0.unwrap_or(Color::Reset) } else { st.0 };
                cell.bg = if st.1 == Color::Reset { window.1.unwrap_or(Color::Reset) } else { st.1 };
                cell.modifier = st.2;
                cell.underline_color = Color::Reset;
            }
        };
        for py in 0..sy {
            let fy = hsize - self.oy + py;
            let hdr = if py == 0 { self.header() } else { None };
            let size = hdr.as_ref().map(|h| (h.len() as u32).min(self.sx)).unwrap_or(0);
            // Blank the row first: a cell not written keeps nothing from before.
            for x in 0..sx { put(buf, x, py, " ", (Color::Reset, Color::Reset, Modifier::empty())) }
            let nx = self.sx - size;
            let mut fx = 0;
            while fx < nx {
                let gc = self.backing.get(fx, fy);
                if gc.padding { fx += 1; continue }
                let w = gc.width as u32;
                if fx + w <= nx && fx < sx {
                    let mut st = (gc.cell.fg, gc.cell.bg, gc.cell.mods);
                    self.update_style(fx, fy, &mut st, styles, ctx);
                    if self.selected(fx, py) { st = styles.mode }
                    let text = if gc.cell.mods.contains(Modifier::HIDDEN) { Cow::Borrowed(" ") } else { gc.data() };
                    put(buf, fx, py, &text, (st.0, st.1, st.2 - Modifier::HIDDEN));
                }
                fx += w.max(1);
            }
            if let Some(h) = hdr {
                let x0 = self.sx - size;
                for (i, c) in h.chars().enumerate() {
                    let x = x0 + i as u32;
                    if x >= sx { break }
                    let mut s = String::new();
                    s.push(c);
                    put(buf, x, py, &s, styles.mode);
                }
            }
            if py == self.cy && self.cx == self.sx && sx > 0 { put(buf, sx - 1, py, "$", (Color::Reset, Color::Reset, Modifier::empty())) }
        }
        ((self.cx.min(self.sx.saturating_sub(1))) as u16, self.cy.min(sy.saturating_sub(1)) as u16)
    }
}

/// The looks copy mode draws with: mode-style (the selection and the position),
/// copy-mode-match-style, copy-mode-current-match-style, copy-mode-mark-style — each as tmux's
/// style_apply leaves a cell: its colours and attributes, nothing kept from under it.
#[derive(Clone, Copy, Debug)]
pub struct Styles { pub mode: (Color, Color, Modifier), pub matched: (Color, Color, Modifier), pub current: (Color, Color, Modifier), pub mark: (Color, Color, Modifier) }

impl Styles {
    pub fn of(get: impl Fn(&str) -> String) -> Styles {
        let one = |name: &str, default: &str| {
            let spec = get(name);
            let s = crate::draw::style_over(if spec.is_empty() { default } else { &spec }, Style::default());
            (s.fg.unwrap_or(Color::Reset), s.bg.unwrap_or(Color::Reset), s.add_modifier)
        };
        Styles {
            mode: one("mode-style", "bg=yellow,fg=black"),
            matched: one("copy-mode-match-style", "bg=cyan,fg=black"),
            current: one("copy-mode-current-match-style", "bg=magenta,fg=black"),
            mark: one("copy-mode-mark-style", "bg=red,fg=black"),
        }
    }
}

/// A regex as tmux compiles one (REG_EXTENDED, REG_ICASE when the text is all lower case).
fn build_regex(text: &str, cis: bool) -> Option<regex::Regex> {
    regex::RegexBuilder::new(text).case_insensitive(cis).build().ok()
}

/// regexec on [buf] from byte [from]: with REG_NOTBOL, `^` does not match where it starts (a
/// character that is no part of a word goes before it, so `\b` still sees a start).
fn find(re: &regex::Regex, buf: &str, notbol: bool, from: usize) -> Option<(usize, usize)> {
    if from > buf.len() { return None }
    let rest = &buf[from..];
    if !notbol { return re.find(rest).map(|m| (from + m.start(), from + m.end())) }
    let hay = format!("\u{1}{rest}");
    re.find_at(&hay, 1).map(|m| (from + m.start() - 1, from + m.end() - 1))
}

/// When a line went into the history, as format_pretty_time writes it with seconds.
fn pretty_time(t: i64) -> String {
    let now = now();
    let now = now.max(t);
    let age = now - t;
    let off = crate::app::utc_offset();
    let (lt, ln) = (t + off, now + off);
    let tm = civil(lt);
    let nm = civil(ln);
    if age < 24 * 3600 {
        let s = lt.rem_euclid(86400);
        return format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60);
    }
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (tm.0 == nm.0 && tm.1 == nm.1) || age < 28 * 24 * 3600 {
        return format!("{}{:02}", DAYS[(lt.div_euclid(86400)).rem_euclid(7) as usize], tm.2);
    }
    if (tm.0 == nm.0 && tm.1 < nm.1) || (tm.0 == nm.0 - 1 && tm.1 > nm.1) {
        return format!("{:02}{}", tm.2, MONTHS[tm.1 as usize - 1]);
    }
    format!("{}{:02}", MONTHS[tm.1 as usize - 1], tm.0.rem_euclid(100))
}

/// A day number's (year, month, day).
fn civil(t: i64) -> (i64, i64, i64) {
    let z = t.div_euclid(86400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn now() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) }

/// grid_wrap_position: a grid position as (offset into its unwrapped line, which unwrapped line).
fn wrap_position(gd: &Grid, px: u32, py: u32) -> (u32, u32) {
    let (mut ax, mut ay) = (0u32, 0u32);
    for yy in 0..py {
        if gd.line(yy).wrapped { ax += gd.cellused(yy) } else { ax = 0; ay += 1 }
    }
    if px >= gd.cellused(py) { ax = u32::MAX } else { ax += px }
    (ax, ay)
}

/// grid_unwrap_position.
fn unwrap_position(gd: &Grid, wx: u32, wy: u32) -> (u32, u32) {
    let mut yy = 0;
    let mut ay = 0;
    let last = gd.hsize + gd.sy - 1;
    while yy < last {
        if ay == wy { break }
        if !gd.line(yy).wrapped { ay += 1 }
        yy += 1;
    }
    let mut wx = wx;
    if wx == u32::MAX {
        while gd.line(yy).wrapped && yy < last { yy += 1 }
        wx = gd.cellused(yy);
    } else {
        while gd.line(yy).wrapped && yy < last {
            if wx < gd.cellused(yy) { break }
            wx -= gd.cellused(yy);
            yy += 1;
        }
    }
    (wx, yy)
}

/// grid_reflow: the lines rewrapped at a new width — each line joined with the ones it wraps
/// onto, then cut again at [sx] (a wide character that does not fit goes on the next line).
fn reflow_grid(gd: &mut Grid, sx: u32) {
    let old = std::mem::take(&mut gd.lines);
    let screen_rows = gd.sy;
    let mut out: Vec<Line> = Vec::with_capacity(old.len());
    let mut i = 0;
    while i < old.len() {
        // One unwrapped line: this one and those it wraps onto.
        let mut cells: Vec<Cell> = Vec::new();
        let mut extra: Vec<(u32, String)> = Vec::new();
        let mut links: Vec<(u32, String)> = Vec::new();
        let (time, flags) = (old[i].time, old[i].flags);
        loop {
            let l = &old[i];
            let base = cells.len() as u32;
            for (x, e) in &l.extra { extra.push((base + x, e.clone())) }
            for (x, e) in &l.links { links.push((base + x, e.clone())) }
            cells.extend(l.cells.iter().copied());
            let wrapped = l.wrapped;
            i += 1;
            if !wrapped || i >= old.len() { break }
        }
        // Cut it at the new width.
        let mut start = 0usize;
        loop {
            let mut width = 0u32;
            let mut end = start;
            while end < cells.len() {
                let w = cells[end].width as u32;
                if width + w > sx && w != 0 { break }
                width += w;
                end += 1;
            }
            let more = end < cells.len();
            let piece: Vec<Cell> = cells[start..end].to_vec();
            let pe: Vec<(u32, String)> = extra.iter().filter(|(x, _)| (*x as usize) >= start && (*x as usize) < end).map(|(x, e)| (x - start as u32, e.clone())).collect();
            let pl: Vec<(u32, String)> = links.iter().filter(|(x, _)| (*x as usize) >= start && (*x as usize) < end).map(|(x, e)| (x - start as u32, e.clone())).collect();
            out.push(Line { cells: piece, extra: pe, links: pl, wrapped: more, time: if start == 0 { time } else { 0 }, flags: if start == 0 { flags } else { 0 } });
            if !more { break }
            start = end;
        }
    }
    while (out.len() as u32) < screen_rows { out.push(Line::default()) }
    gd.hsize = out.len() as u32 - screen_rows;
    if gd.hscrolled > gd.hsize { gd.hscrolled = gd.hsize }
    gd.lines = out;
}
