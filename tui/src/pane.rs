//! One tile: a harness's live terminal, emulated here.
//!
//! The engine really runs in the daemon's tmux on its own machine; that tmux is the terminal the
//! engine talks to and answers its queries. This side only mirrors the screen (keyframe, then
//! output) into an `alacritty_terminal` grid and turns keys and mouse into the bytes that terminal
//! would have sent. So anything our emulator would write BACK (device reports, colour queries) is
//! dropped: the far tmux already answered, and a second answer would arrive as typed garbage.

use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use alacritty_terminal::event::{Event as AlacEvent, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::Processor;
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use uuid::Uuid;

pub const MIN_COLS: u16 = 40;
pub const MIN_ROWS: u16 = 12;
pub const MAX_COLS: u16 = 300;
pub const MAX_ROWS: u16 = 120;

#[derive(Clone, Default)]
pub struct Listener(Arc<Mutex<Vec<AlacEvent>>>);

impl EventListener for Listener {
    fn send_event(&self, event: AlacEvent) {
        match event {
            AlacEvent::Title(_) | AlacEvent::ResetTitle | AlacEvent::Bell | AlacEvent::ClipboardStore(..) => {
                self.0.lock().unwrap().push(event)
            }
            _ => {}
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CopyCursor {
    pub point: alacritty_terminal::index::Point,
    pub selecting: bool,
}

pub struct Size(pub u16, pub u16);

impl Dimensions for Size {
    fn total_lines(&self) -> usize { self.1 as usize }
    fn screen_lines(&self) -> usize { self.1 as usize }
    fn columns(&self) -> usize { self.0 as usize }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    /// No machine link yet, or waiting for `terminal_ready`.
    Connecting(String),
    Live,
    /// Streaming, but another window holds the keyboard; the first key takes it.
    Watching(String),
    /// Something to say, and what the keys will do about it.
    Card { title: String, detail: String, keys: Vec<(String, String)> },
}

pub struct Pane {
    pub id: u64,
    pub machine_id: String,
    pub agent_id: String,
    pub term: Term<Listener>,
    parser: Processor,
    pub listener: Listener,
    pub stream: Option<Uuid>,
    pub phase: Phase,
    /// The far pane's size — what the grid is.
    pub cols: u16,
    pub rows: u16,
    /// What we last asked the far pane to be.
    pub want: (u16, u16),
    pub input_seq: u64,
    pub resize_seq: u64,
    pub last_seq: Option<u64>,
    pub ack_due: bool,
    pub title: String,
    pub opening: bool,
    pub read_only: bool,
    pub last_alive: Instant,
    pub dirty: bool,
    pub bell: bool,
    /// A key that arrived while a watcher was being promoted to controller.
    pub queued: Vec<Vec<u8>>,
    /// When the oldest unanswered keystroke left — its echo closes the measurement.
    pub input_at: Option<Instant>,
    /// Keystroke → first output back, in microseconds (the last 256).
    pub echo_us: Vec<u32>,
    /// Characters typed but not yet echoed, drawn where they will land — the local echo that makes a
    /// far machine feel near. (col, row, char, when).
    pub predictions: Vec<(u16, u16, char, Instant)>,
    /// The match ⌥F is on.
    pub find_at: Option<alacritty_terminal::term::search::Match>,
    /// Bumped on every open; a reply carrying an older one is stale.
    pub open_token: u64,
    /// ⌥[ copy mode: the copy cursor, and whether a selection is being made from it.
    pub copy: Option<CopyCursor>,
    /// Inside screen's `ESC k … ESC \` title (split across chunks).
    in_screen_title: bool,
    /// An ESC ended the last chunk; the next byte decides what it was.
    pending_esc: bool,
}

fn config() -> Config { Config { scrolling_history: 5_000, ..Config::default() } }

impl Pane {
    pub fn new(id: u64, machine_id: &str, agent_id: &str, cols: u16, rows: u16) -> Pane {
        let listener = Listener::default();
        let (cols, rows) = (cols.max(2), rows.max(2));
        Pane {
            id,
            machine_id: machine_id.to_string(),
            agent_id: agent_id.to_string(),
            term: Term::new(config(), &Size(cols, rows), listener.clone()),
            parser: Processor::new(),
            listener,
            stream: None,
            phase: Phase::Connecting("Connecting…".into()),
            cols,
            rows,
            want: (0, 0),
            input_seq: 0,
            resize_seq: 0,
            last_seq: None,
            ack_due: false,
            title: String::new(),
            opening: false,
            read_only: false,
            last_alive: Instant::now(),
            dirty: true,
            bell: false,
            queued: Vec::new(),
            in_screen_title: false,
            pending_esc: false,
            input_at: None,
            echo_us: Vec::new(),
            predictions: Vec::new(),
            find_at: None,
            open_token: 0,
            copy: None,
        }
    }

    /// A keyframe: the whole screen again, from nothing, at the far pane's size.
    pub fn keyframe(&mut self, cols: u16, rows: u16, bytes: &[u8]) {
        self.cols = cols.max(2);
        self.rows = rows.max(2);
        self.term = Term::new(config(), &Size(self.cols, self.rows), self.listener.clone());
        self.parser = Processor::new();
        self.in_screen_title = false;
        self.pending_esc = false;
        // Predictions were placed on the old grid; a new one (maybe narrower) has no room for them.
        self.predictions.clear();
        self.find_at = None;
        self.feed(bytes);
    }

    pub fn note_echo(&mut self) {
        if let Some(at) = self.input_at.take() {
            let us = at.elapsed().as_micros().min(u32::MAX as u128) as u32;
            if self.echo_us.len() >= 256 { self.echo_us.remove(0); }
            self.echo_us.push(us);
            if let Ok(path) = std::env::var("HARNESS_TUI_STATS") {
                use std::io::Write;
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) { let _ = writeln!(f, "{} {us}", self.machine_id); }
            }
        }
    }

    /// (p50, p95) keystroke → echo, in ms.
    pub fn echo_ms(&self) -> Option<(f32, f32)> {
        if self.echo_us.is_empty() { return None }
        let mut v = self.echo_us.clone();
        v.sort_unstable();
        let at = |q: f32| v[((v.len() - 1) as f32 * q).round() as usize] as f32 / 1000.0;
        Some((at(0.5), at(0.95)))
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        let clean = self.strip_screen_titles(bytes);
        self.parser.advance(&mut self.term, &clean);
        self.dirty = true;
        let events: Vec<AlacEvent> = std::mem::take(&mut *self.listener.0.lock().unwrap());
        for event in events {
            match event {
                AlacEvent::Title(title) => self.title = title,
                AlacEvent::ResetTitle => self.title.clear(),
                AlacEvent::Bell => self.bell = true,
                AlacEvent::ClipboardStore(_, text) => crate::clipboard::store(&text),
                _ => {}
            }
        }
    }

    /// Drop screen's window-title sequence, `ESC k <title> ESC \\`. Shells set it for tmux (which
    /// understands it); a VT parser that does not prints the title into the grid as text.
    fn strip_screen_titles(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bytes.len() + 1);
        let mut i = 0;
        if self.pending_esc {
            self.pending_esc = false;
            if self.in_screen_title {
                if bytes.first() == Some(&b'\\') { self.in_screen_title = false; i = 1 }
            } else if bytes.first() == Some(&b'k') { self.in_screen_title = true; i = 1 }
            else { out.push(0x1b) }
        }
        while i < bytes.len() {
            let b = bytes[i];
            if self.in_screen_title {
                if b == 0x1b {
                    match bytes.get(i + 1) {
                        Some(b'\\') => { self.in_screen_title = false; i += 2; continue }
                        None => { self.pending_esc = true; i += 1; continue }
                        _ => {}
                    }
                } else if b == 0x07 { self.in_screen_title = false }
                i += 1;
                continue;
            }
            if b == 0x1b {
                match bytes.get(i + 1) {
                    Some(b'k') => { self.in_screen_title = true; i += 2; continue }
                    None => { self.pending_esc = true; i += 1; continue }
                    _ => {}
                }
            }
            out.push(b);
            i += 1;
        }
        out
    }

    pub fn mode(&self) -> TermMode { *self.term.mode() }

    /// Whether typing here should be echoed locally: a slow link (measured), a visible cursor on the
    /// main screen, the view at the bottom. Full-screen programs redraw on their own terms and are
    /// left alone, as mosh leaves them. `HARNESS_TUI_PREDICT=off` turns it off, `=always` forces it.
    pub fn should_predict(&self) -> bool {
        let setting = std::env::var("HARNESS_TUI_PREDICT").unwrap_or_default();
        if setting == "off" { return false }
        let slow = setting == "always" || self.echo_ms().map(|(p50, _)| p50 >= 20.0).unwrap_or(false);
        let mode = self.mode();
        slow && mode.contains(TermMode::SHOW_CURSOR) && !mode.contains(TermMode::ALT_SCREEN) && self.scrolled() == 0
    }

    pub fn predict_char(&mut self, c: char) {
        if c.is_control() || unicode_width::UnicodeWidthChar::width(c) != Some(1) { self.predictions.clear(); return }
        let (col, row) = match self.predictions.last() {
            Some((col, row, _, _)) => (col + 1, *row),
            None => {
                let cursor = self.term.grid().cursor.point;
                (cursor.column.0 as u16, cursor.line.0.max(0) as u16)
            }
        };
        if col >= self.cols { return }
        self.predictions.push((col, row, c, Instant::now()));
        self.dirty = true;
    }

    pub fn predict_backspace(&mut self) {
        if self.predictions.pop().is_some() { self.dirty = true }
    }

    pub fn clear_predictions(&mut self) {
        if !self.predictions.is_empty() { self.predictions.clear(); self.dirty = true }
    }

    /// Drop what the far side has now confirmed (the grid shows that character there), and give up
    /// on anything it has not echoed well past a round trip — a password prompt, say.
    pub fn settle_predictions(&mut self) {
        if self.predictions.is_empty() { return }
        use alacritty_terminal::index::{Column, Line};
        let patience = std::time::Duration::from_millis(self.echo_ms().map(|(_, p95)| (p95 * 3.0) as u64).unwrap_or(600).clamp(400, 2_000));
        let grid = self.term.grid();
        let rows = grid.screen_lines() as u16;
        let before = self.predictions.len();
        self.predictions.retain(|(col, row, c, at)| {
            if *row >= rows || *col as usize >= grid.columns() { return false }
            let cell = &grid[Line(*row as i32)][Column(*col as usize)];
            cell.c != *c && at.elapsed() < patience
        });
        // A confirmed character with an unconfirmed one BEFORE it means the line went elsewhere.
        if self.predictions.len() != before { self.dirty = true }
    }

    pub fn scroll(&mut self, lines: i32) {
        self.term.scroll_display(Scroll::Delta(lines));
        self.dirty = true;
    }

    pub fn scroll_bottom(&mut self) {
        if self.term.grid().display_offset() != 0 {
            self.term.scroll_display(Scroll::Bottom);
            self.dirty = true;
        }
    }

    pub fn scrolled(&self) -> usize { self.term.grid().display_offset() }

    fn grid_point(&self, col: u16, row: u16) -> alacritty_terminal::index::Point {
        use alacritty_terminal::index::{Column, Line, Point};
        let offset = self.term.grid().display_offset() as i32;
        let col = (col as usize).min(self.cols.saturating_sub(1) as usize);
        Point::new(Line(row as i32 - offset), Column(col))
    }

    /// Start a selection at a pane-local cell; [clicks] 2 selects a word, 3 a line.
    pub fn select_start(&mut self, col: u16, row: u16, clicks: u8) {
        use alacritty_terminal::index::Side;
        use alacritty_terminal::selection::{Selection, SelectionType};
        let ty = match clicks { 2 => SelectionType::Semantic, 3 => SelectionType::Lines, _ => SelectionType::Simple };
        let point = self.grid_point(col, row);
        let mut selection = Selection::new(ty, point, Side::Left);
        if clicks > 1 { selection.update(point, Side::Right) }
        self.term.selection = Some(selection);
        self.dirty = true;
    }

    pub fn select_update(&mut self, col: u16, row: u16) {
        use alacritty_terminal::index::Side;
        let point = self.grid_point(col, row);
        if let Some(selection) = self.term.selection.as_mut() { selection.update(point, Side::Right) }
        self.dirty = true;
    }

    pub fn selection_text(&self) -> Option<String> {
        self.term.selection_to_string().filter(|text| !text.is_empty())
    }

    /// Find [query] (literal, case-insensitive unless it has capitals) from the current match —
    /// or from the bottom — toward older lines ([older]) or newer ones. Highlights it as the
    /// selection and scrolls it into view. False when there is nothing (more) to find.
    pub fn find(&mut self, query: &str, older: bool, fresh: bool) -> bool {
        use alacritty_terminal::index::{Boundary, Column, Direction, Line, Point, Side};
        use alacritty_terminal::selection::{Selection, SelectionType};
        use alacritty_terminal::term::search::RegexSearch;
        if query.is_empty() { self.clear_selection(); return false }
        let escaped: String = query.chars().map(|c| if "\\.+*?()|[]{}^$#&-~".contains(c) { format!("\\{c}") } else { c.to_string() }).collect();
        let Ok(mut regex) = RegexSearch::new(&escaped) else { return false };
        let grid = self.term.grid();
        let bottom = Point::new(Line(grid.screen_lines() as i32 - 1), Column(grid.columns().saturating_sub(1)));
        let current = if fresh { None } else { self.find_at.clone() };
        let origin = match (&current, older) {
            (Some(m), true) => m.start().sub(&self.term, Boundary::None, 1),
            (Some(m), false) => m.end().add(&self.term, Boundary::None, 1),
            (None, _) => bottom,
        };
        if let Ok(path) = std::env::var("HARNESS_TUI_DEBUG") {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(f, "find {query:?} esc={escaped:?} origin={origin:?} history={} lines={} cols={}", grid.history_size(), grid.screen_lines(), grid.columns());
            }
        }
        let found = self.term.search_next(&mut regex, origin, if older { Direction::Left } else { Direction::Right }, if older { Side::Right } else { Side::Left }, None);
        let Some(found) = found else { return false };
        // A search that wrapped around past where it started is not "more".
        if let Some(m) = &current { if (older && found.start() >= m.start()) || (!older && found.start() <= m.start()) { return false } }
        self.term.scroll_to_point(*found.start());
        let mut selection = Selection::new(SelectionType::Simple, *found.start(), Side::Left);
        selection.update(*found.end(), Side::Right);
        self.term.selection = Some(selection);
        self.find_at = Some(found);
        self.dirty = true;
        true
    }

    pub fn end_find(&mut self) {
        self.find_at = None;
        self.clear_selection();
        self.scroll_bottom();
    }

    // ── copy mode ────────────────────────────────────────────────────────────

    pub fn copy_start(&mut self) {
        let cursor = self.term.grid().cursor.point;
        self.copy = Some(CopyCursor { point: cursor, selecting: false });
        self.term.selection = None;
        self.dirty = true;
    }

    pub fn copy_end(&mut self) {
        self.copy = None;
        self.clear_selection();
        self.scroll_bottom();
    }

    fn copy_bounds(&self) -> (i32, i32, usize) {
        let grid = self.term.grid();
        (-(grid.history_size() as i32), grid.screen_lines() as i32 - 1, grid.columns().saturating_sub(1))
    }

    fn copy_set(&mut self, point: alacritty_terminal::index::Point) {
        use alacritty_terminal::index::{Column, Line, Point, Side};
        let (top, bottom, last) = self.copy_bounds();
        let point = Point::new(Line(point.line.0.clamp(top, bottom)), Column(point.column.0.min(last)));
        let Some(copy) = self.copy.as_mut() else { return };
        copy.point = point;
        if copy.selecting { if let Some(selection) = self.term.selection.as_mut() { selection.update(point, Side::Right) } }
        // Keep the copy cursor on screen.
        let offset = self.term.grid().display_offset() as i32;
        let rows = self.term.grid().screen_lines() as i32;
        let view_line = point.line.0 + offset;
        if view_line < 0 { self.term.scroll_display(Scroll::Delta(-view_line)) }
        else if view_line >= rows { self.term.scroll_display(Scroll::Delta(rows - 1 - view_line)) }
        self.dirty = true;
    }

    pub fn copy_move(&mut self, cols: i32, lines: i32) {
        use alacritty_terminal::index::{Column, Line, Point};
        let Some(copy) = self.copy else { return };
        let col = (copy.point.column.0 as i32 + cols).max(0) as usize;
        self.copy_set(Point::new(Line(copy.point.line.0 + lines), Column(col)));
    }

    fn copy_char(&self, point: alacritty_terminal::index::Point) -> char { self.term.grid()[point].c }

    /// `w` / `b`: to the start of the next / previous word on the line (then the next line).
    pub fn copy_word(&mut self, forward: bool) {
        use alacritty_terminal::index::{Column, Line, Point};
        let Some(copy) = self.copy else { return };
        let (top, bottom, last) = self.copy_bounds();
        let blank = |c: char| c == ' ' || c == '\0';
        let mut p = copy.point;
        let step = |p: Point| -> Option<Point> {
            if forward { if p.column.0 < last { Some(Point::new(p.line, Column(p.column.0 + 1))) } else if p.line.0 < bottom { Some(Point::new(Line(p.line.0 + 1), Column(0))) } else { None } }
            else if p.column.0 > 0 { Some(Point::new(p.line, Column(p.column.0 - 1))) } else if p.line.0 > top { Some(Point::new(Line(p.line.0 - 1), Column(last))) } else { None }
        };
        if forward {
            while let Some(n) = step(p) { let was = blank(self.copy_char(p)); p = n; if was && !blank(self.copy_char(p)) { break } if !was && blank(self.copy_char(p)) { continue } }
        } else {
            while let Some(n) = step(p) { p = n; if !blank(self.copy_char(p)) { break } }
            while let Some(n) = step(p) { if blank(self.copy_char(n)) { break } p = n; }
        }
        self.copy_set(p);
    }

    pub fn copy_line_edge(&mut self, end: bool) {
        use alacritty_terminal::index::{Column, Point};
        let Some(copy) = self.copy else { return };
        let (_, _, last) = self.copy_bounds();
        let col = if end { (0..=last).rev().find(|c| { let ch = self.copy_char(Point::new(copy.point.line, Column(*c))); ch != ' ' && ch != '\0' }).unwrap_or(0) } else { 0 };
        self.copy_set(Point::new(copy.point.line, Column(col)));
    }

    pub fn copy_to(&mut self, top: bool) {
        use alacritty_terminal::index::{Column, Line, Point};
        let (first, last_line, _) = self.copy_bounds();
        self.copy_set(Point::new(Line(if top { first } else { last_line }), Column(0)));
    }

    /// Put the copy cursor on [point] (a search match).
    pub fn copy_jump(&mut self, point: alacritty_terminal::index::Point) {
        if self.copy.is_none() { self.copy_start() }
        self.copy_set(point);
    }

    /// `e`: to the end of this word, or of the next one.
    pub fn copy_word_end(&mut self) {
        use alacritty_terminal::index::{Column, Line, Point};
        let Some(copy) = self.copy else { return };
        let (_, bottom, last) = self.copy_bounds();
        let blank = |c: char| c == ' ' || c == '\0';
        let step = |p: Point| -> Option<Point> { if p.column.0 < last { Some(Point::new(p.line, Column(p.column.0 + 1))) } else if p.line.0 < bottom { Some(Point::new(Line(p.line.0 + 1), Column(0))) } else { None } };
        let mut p = copy.point;
        if let Some(n) = step(p) { p = n }
        while blank(self.copy_char(p)) { match step(p) { Some(n) => p = n, None => break } }
        while let Some(n) = step(p) { if blank(self.copy_char(n)) || n.line != p.line { break } p = n }
        self.copy_set(p);
    }

    /// `^`: the first character on the line that is not blank.
    pub fn copy_first_nonblank(&mut self) {
        use alacritty_terminal::index::{Column, Point};
        let Some(copy) = self.copy else { return };
        let (_, _, last) = self.copy_bounds();
        let col = (0..=last).find(|c| { let ch = self.copy_char(Point::new(copy.point.line, Column(*c))); ch != ' ' && ch != '\0' }).unwrap_or(0);
        self.copy_set(Point::new(copy.point.line, Column(col)));
    }

    /// `H` / `M` / `L`: the top, middle or bottom line of what is on screen.
    pub fn copy_screen(&mut self, which: u8) {
        use alacritty_terminal::index::{Column, Line, Point};
        let Some(copy) = self.copy else { return };
        let offset = self.term.grid().display_offset() as i32;
        let rows = self.term.grid().screen_lines() as i32;
        let view = match which { 0 => 0, 1 => rows / 2, _ => rows - 1 };
        self.copy_set(Point::new(Line(view - offset), Column(copy.point.column.0)));
    }

    /// `C-v`: a rectangle selection.
    pub fn copy_toggle_block(&mut self) {
        use alacritty_terminal::index::Side;
        use alacritty_terminal::selection::{Selection, SelectionType};
        let Some(copy) = self.copy.as_mut() else { return };
        copy.selecting = true;
        let point = copy.point;
        let mut selection = Selection::new(SelectionType::Block, point, Side::Left);
        selection.update(point, Side::Right);
        self.term.selection = Some(selection);
        self.dirty = true;
    }

    /// `v` (characters) or `V` (lines): start a selection at the copy cursor, or drop the one there is.
    pub fn copy_toggle(&mut self, lines: bool) {
        use alacritty_terminal::index::Side;
        use alacritty_terminal::selection::{Selection, SelectionType};
        let Some(copy) = self.copy.as_mut() else { return };
        if copy.selecting { copy.selecting = false; self.term.selection = None; self.dirty = true; return }
        copy.selecting = true;
        let point = copy.point;
        let mut selection = Selection::new(if lines { SelectionType::Lines } else { SelectionType::Simple }, point, Side::Left);
        selection.update(point, Side::Right);
        self.term.selection = Some(selection);
        self.dirty = true;
    }

    pub fn clear_selection(&mut self) {
        if self.term.selection.take().is_some() { self.dirty = true }
    }
}

/// The far pane size a tile of [cols]×[rows] asks for: the tile, inside the daemon's bounds.
pub fn stream_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(MIN_COLS, MAX_COLS), rows.clamp(MIN_ROWS, MAX_ROWS))
}

pub fn inflate(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(bytes).read_to_end(&mut out).ok()?;
    Some(out)
}

// ── keys → bytes, the way an xterm would send them ────────────────────────────

fn modifier_param(mods: KeyModifiers) -> u8 {
    let mut n = 1;
    if mods.contains(KeyModifiers::SHIFT) { n += 1 }
    if mods.contains(KeyModifiers::ALT) { n += 2 }
    if mods.contains(KeyModifiers::CONTROL) { n += 4 }
    n
}

pub fn encode_key(key: &KeyEvent, mode: TermMode) -> Option<Vec<u8>> {
    if key.kind == KeyEventKind::Release { return None }
    let mods = key.modifiers;
    let alt = mods.contains(KeyModifiers::ALT);
    let ctrl = mods.contains(KeyModifiers::CONTROL);
    let shift = mods.contains(KeyModifiers::SHIFT);
    let plain_mods = mods.intersection(KeyModifiers::SHIFT | KeyModifiers::ALT | KeyModifiers::CONTROL);
    let app_cursor = mode.contains(TermMode::APP_CURSOR);
    let csi = |final_byte: char, fallback_ss3: bool| -> Vec<u8> {
        if plain_mods.is_empty() || (plain_mods == KeyModifiers::SHIFT && final_byte == 'Z') {
            if fallback_ss3 && app_cursor { format!("\x1bO{final_byte}").into_bytes() } else { format!("\x1b[{final_byte}").into_bytes() }
        } else {
            format!("\x1b[1;{}{final_byte}", modifier_param(plain_mods)).into_bytes()
        }
    };
    let tilde = |code: u8| -> Vec<u8> {
        if plain_mods.is_empty() { format!("\x1b[{code}~").into_bytes() } else { format!("\x1b[{code};{}~", modifier_param(plain_mods)).into_bytes() }
    };
    let with_alt = |mut bytes: Vec<u8>| -> Vec<u8> { if alt { bytes.insert(0, 0x1b) } bytes };
    Some(match key.code {
        KeyCode::Char(c) => {
            if ctrl {
                let lower = c.to_ascii_lowercase();
                let byte = match lower {
                    'a'..='z' => lower as u8 - b'a' + 1,
                    '@' | ' ' | '2' => 0,
                    '[' | '3' => 0x1b,
                    '\\' | '4' => 0x1c,
                    ']' | '5' => 0x1d,
                    '^' | '6' => 0x1e,
                    '_' | '-' | '7' => 0x1f,
                    '8' | '?' => 0x7f,
                    '/' => 0x1f,
                    '`' => 0,
                    _ => return Some(with_alt(c.to_string().into_bytes())),
                };
                with_alt(vec![byte])
            } else {
                let mut buf = [0u8; 4];
                with_alt(c.encode_utf8(&mut buf).as_bytes().to_vec())
            }
        }
        // As the desktop sends it: prompts tell a newline (⇧⏎) from the Return that submits.
        KeyCode::Enter if shift && !alt && !ctrl => b"\x1b[13;2u".to_vec(),
        KeyCode::Enter => with_alt(vec![b'\r']),
        KeyCode::Tab => if shift { b"\x1b[Z".to_vec() } else { with_alt(vec![b'\t']) },
        KeyCode::BackTab => b"\x1b[Z".to_vec(),
        KeyCode::Backspace => with_alt(if ctrl { vec![0x08] } else { vec![0x7f] }),
        KeyCode::Esc => with_alt(vec![0x1b]),
        KeyCode::Up => csi('A', true),
        KeyCode::Down => csi('B', true),
        KeyCode::Right => csi('C', true),
        KeyCode::Left => csi('D', true),
        KeyCode::Home => csi('H', true),
        KeyCode::End => csi('F', true),
        KeyCode::PageUp => tilde(5),
        KeyCode::PageDown => tilde(6),
        KeyCode::Insert => tilde(2),
        KeyCode::Delete => tilde(3),
        KeyCode::F(n) => match n {
            1..=4 => {
                let f = [b'P', b'Q', b'R', b'S'][(n - 1) as usize] as char;
                if plain_mods.is_empty() { format!("\x1bO{f}").into_bytes() } else { format!("\x1b[1;{}{f}", modifier_param(plain_mods)).into_bytes() }
            }
            5 => tilde(15), 6 => tilde(17), 7 => tilde(18), 8 => tilde(19), 9 => tilde(20), 10 => tilde(21), 11 => tilde(23), 12 => tilde(24),
            _ => return None,
        },
        _ => return None,
    })
}

/// A mouse event at pane-local cell ([col], [row]) (0-based), as the pane's program asked to
/// receive it — or None when it asked for nothing (the tile scrolls its own history instead).
pub fn encode_mouse(kind: MouseEventKind, col: u16, row: u16, mods: KeyModifiers, mode: TermMode) -> Option<Vec<u8>> {
    let reporting = mode.intersects(TermMode::MOUSE_MODE);
    if !reporting { return None }
    let (mut button, release) = match kind {
        MouseEventKind::Down(b) => (button_code(b), false),
        MouseEventKind::Up(b) => (button_code(b), true),
        MouseEventKind::Drag(b) => {
            if !mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION) { return None }
            (button_code(b) + 32, false)
        }
        MouseEventKind::Moved => {
            if !mode.contains(TermMode::MOUSE_MOTION) { return None }
            (35, false)
        }
        MouseEventKind::ScrollUp => (64, false),
        MouseEventKind::ScrollDown => (65, false),
        MouseEventKind::ScrollLeft => (66, false),
        MouseEventKind::ScrollRight => (67, false),
    };
    if mods.contains(KeyModifiers::SHIFT) { button += 4 }
    if mods.contains(KeyModifiers::ALT) { button += 8 }
    if mods.contains(KeyModifiers::CONTROL) { button += 16 }
    let (x, y) = (col as u32 + 1, row as u32 + 1);
    if mode.contains(TermMode::SGR_MOUSE) {
        return Some(format!("\x1b[<{button};{x};{y}{}", if release { 'm' } else { 'M' }).into_bytes());
    }
    let button = if release { 3 + (button & !3) } else { button };
    if x > 223 || y > 223 { return None }
    Some(vec![0x1b, b'[', b'M', (32 + button) as u8, (32 + x) as u8, (32 + y) as u8])
}

fn button_code(button: MouseButton) -> u32 {
    match button { MouseButton::Left => 0, MouseButton::Middle => 1, MouseButton::Right => 2 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventState;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent { code, modifiers, kind: KeyEventKind::Press, state: KeyEventState::NONE }
    }

    #[test]
    fn arrows_follow_cursor_mode() {
        assert_eq!(encode_key(&key(KeyCode::Up, KeyModifiers::NONE), TermMode::empty()).unwrap(), b"\x1b[A");
        assert_eq!(encode_key(&key(KeyCode::Up, KeyModifiers::NONE), TermMode::APP_CURSOR).unwrap(), b"\x1bOA");
        assert_eq!(encode_key(&key(KeyCode::Left, KeyModifiers::CONTROL), TermMode::empty()).unwrap(), b"\x1b[1;5D");
    }

    #[test]
    fn control_and_alt() {
        assert_eq!(encode_key(&key(KeyCode::Char('c'), KeyModifiers::CONTROL), TermMode::empty()).unwrap(), vec![3]);
        assert_eq!(encode_key(&key(KeyCode::Char('b'), KeyModifiers::ALT), TermMode::empty()).unwrap(), b"\x1bb");
        assert_eq!(encode_key(&key(KeyCode::Enter, KeyModifiers::NONE), TermMode::empty()).unwrap(), b"\r");
    }

    #[test]
    fn strips_screen_titles_across_chunks() {
        let mut pane = Pane::new(1, "m", "a", 40, 12);
        assert_eq!(pane.strip_screen_titles(b"a\x1bkecho\x1b\\b"), b"ab");
        assert_eq!(pane.strip_screen_titles(b"x\x1b"), b"x");
        assert_eq!(pane.strip_screen_titles(b"kti"), b"");
        assert_eq!(pane.strip_screen_titles(b"tle\x1b"), b"");
        assert_eq!(pane.strip_screen_titles(b"\\y\x1b"), b"y");
        assert_eq!(pane.strip_screen_titles(b"[0m"), b"\x1b[0m");
    }

    #[test]
    fn predictions_do_not_outlive_a_narrower_keyframe() {
        let mut pane = Pane::new(1, "m", "a", 120, 30);
        pane.feed(b"\x1b[5;100H");
        for c in "abc".chars() { pane.predict_char(c) }
        assert_eq!(pane.predictions.len(), 3);
        pane.keyframe(80, 24, b"\x1bcshell$ ");
        pane.settle_predictions();
        assert!(pane.predictions.is_empty());
        // And one placed past a (somehow) narrower grid is dropped, not indexed.
        pane.predictions.push((100, 2, 'x', Instant::now()));
        pane.settle_predictions();
        assert!(pane.predictions.is_empty());
    }

    #[test]
    fn ctrl_slash_is_undo() {
        assert_eq!(encode_key(&key(KeyCode::Char('/'), KeyModifiers::CONTROL), TermMode::empty()).unwrap(), vec![0x1f]);
    }

    #[test]
    fn finds_in_history() {
        let mut pane = Pane::new(1, "m", "a", 40, 12);
        let mut text = String::new();
        for i in 0..100 { text.push_str(&format!("line-{i}\r\n")); }
        text.push_str("needle-here\r\n");
        for i in 0..30 { text.push_str(&format!("after-{i}\r\n")); }
        pane.feed(text.as_bytes());
        assert!(pane.find("needle", true, true));
        assert!(pane.scrolled() > 0);
        assert!(!pane.find("needle", true, false));
        assert!(pane.find("line-5", true, true));
    }

    #[test]
    fn sgr_mouse() {
        let mode = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        assert_eq!(encode_mouse(MouseEventKind::Down(MouseButton::Left), 4, 2, KeyModifiers::NONE, mode).unwrap(), b"\x1b[<0;5;3M");
        assert!(encode_mouse(MouseEventKind::ScrollUp, 0, 0, KeyModifiers::NONE, TermMode::empty()).is_none());
    }
}
