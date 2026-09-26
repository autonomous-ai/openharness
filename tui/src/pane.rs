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
use alacritty_terminal::vte::ansi::{CursorShape, CursorStyle, Processor};
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

pub struct Size(pub u16, pub u16);

/// tmux's `%id` for a pane: hn keeps 0 for no pane, so its first pane (1) is tmux's `%0`.
pub fn tag(id: u64) -> String { format!("%{}", id.saturating_sub(1)) }

/// The pane a `%id`'s number names.
pub fn from_tag(n: &str) -> Option<u64> { n.parse::<u64>().ok().map(|n| n + 1) }

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
    /// select-pane -T's title.
    pub title: String,
    /// The title the program set (OSC 0/2): the pane's title when allow-set-title is on.
    pub osc_title: String,
    /// select-pane -d: keys for this pane are dropped until select-pane -e.
    pub input_off: bool,
    pub opening: bool,
    pub read_only: bool,
    pub last_alive: Instant,
    pub dirty: bool,
    pub bell: bool,
    /// A key that arrived while a watcher was being promoted to controller.
    pub queued: Vec<Vec<u8>>,
    /// The folder the shell says it is in (OSC 7), for #{pane_current_path} and new splits.
    pub cwd: Option<String>,
    /// What tmux on the pane's machine says it runs, and where (the daemon's terminal_info):
    /// #{pane_current_command}, #{pane_current_path}, #{pane_pid}, #{pane_tty}.
    pub fg_command: Option<String>,
    pub live_path: Option<String>,
    pub remote_pid: Option<u64>,
    pub remote_tty: Option<String>,
    /// When the oldest unanswered keystroke left — its echo closes the measurement.
    pub input_at: Option<Instant>,
    /// Keystroke → first output back, in microseconds (the last 256).
    pub echo_us: Vec<u32>,
    /// Characters typed but not yet echoed, drawn where they will land — the local echo that makes a
    /// far machine feel near. (col, row, char, when).
    pub predictions: Vec<(u16, u16, char, Instant)>,
    /// Bumped on every open; a reply carrying an older one is stale.
    pub open_token: u64,
    /// The pane's modes, the one in front last: copy mode and view mode (tmux's wp->modes).
    pub modes: Vec<Box<crate::copy::Copy>>,
    /// The last search in copy mode (wp->searchstr): the next copy mode starts with it.
    pub search: crate::copy::PaneSearch,
    /// Output arrived while in a mode (#{pane_unseen_changes}).
    pub unseen: bool,
    /// When each history line went into the history (0: not known), oldest first — while the
    /// history is not full; after that they are not known.
    pub times: std::collections::VecDeque<i64>,
    /// Inside screen's `ESC k … ESC \` title (split across chunks).
    in_screen_title: bool,
    /// An ESC ended the last chunk; the next byte decides what it was.
    pending_esc: bool,
}

/// The last `ESC ] 7 ; file://host/path` (BEL or ST) in a chunk: the shell's current folder.
fn osc7(bytes: &[u8]) -> Option<String> {
    let start = bytes.windows(4).rposition(|w| w == b"\x1b]7;")?;
    let rest = &bytes[start + 4..];
    let end = rest.iter().position(|b| *b == 0x07 || *b == 0x1b)?;
    let url = std::str::from_utf8(&rest[..end]).ok()?;
    let path = url.strip_prefix("file://").map(|r| r.find('/').map(|i| &r[i..]).unwrap_or("")).unwrap_or(url);
    // Percent-decoding (a space arrives as %20).
    let mut out = Vec::new();
    let b = path.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() { if let Ok(v) = u8::from_str_radix(&path[i + 1..i + 3], 16) { out.push(v); i += 3; continue } }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).ok().filter(|p| p.starts_with('/'))
}

// A hollow block marks "the program never chose a cursor": the user's own shape stays.
/// tmux's history-limit (tmux.conf or `set`), for panes opened from now on.
pub static HISTORY: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(10_000);

fn config() -> Config { Config { scrolling_history: HISTORY.load(std::sync::atomic::Ordering::Relaxed).clamp(100, 200_000), default_cursor_style: CursorStyle { shape: CursorShape::HollowBlock, blinking: false }, ..Config::default() } }

impl Pane {
    /// The cursor the program in this pane asked for (DECSCUSR), as crossterm spells it.
    pub fn cursor_style(&self) -> crossterm::cursor::SetCursorStyle {
        use crossterm::cursor::SetCursorStyle as S;
        let style = self.term.cursor_style();
        match (style.shape, style.blinking) {
            (CursorShape::Block, true) => S::BlinkingBlock, (CursorShape::Block, false) => S::SteadyBlock,
            (CursorShape::Underline, true) => S::BlinkingUnderScore, (CursorShape::Underline, false) => S::SteadyUnderScore,
            (CursorShape::Beam, true) => S::BlinkingBar, (CursorShape::Beam, false) => S::SteadyBar,
            _ => S::DefaultUserShape,
        }
    }
}

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
            osc_title: String::new(),
            input_off: false,
            opening: false,
            read_only: false,
            last_alive: Instant::now(),
            dirty: true,
            bell: false,
            queued: Vec::new(),
            cwd: None,
            fg_command: None,
            live_path: None,
            remote_pid: None,
            remote_tty: None,
            in_screen_title: false,
            pending_esc: false,
            input_at: None,
            echo_us: Vec::new(),
            predictions: Vec::new(),
            open_token: 0,
            modes: Vec::new(),
            search: Default::default(),
            unseen: false,
            times: Default::default(),
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
        // The history the keyframe brings is from before: when its lines went there is not known.
        self.times.clear();
        self.feed_at(bytes, 0);
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

    pub fn feed(&mut self, bytes: &[u8]) { self.feed_at(bytes, crate::copy::now()) }

    /// Output into the terminal; the lines it pushes into the history went there at [when] (0:
    /// not known). Output while in a mode is unseen there (tmux's PANE_UNSEENCHANGES).
    fn feed_at(&mut self, bytes: &[u8], when: i64) {
        if let Some(dir) = osc7(bytes) { self.cwd = Some(dir) }
        if !self.modes.is_empty() && !bytes.is_empty() { self.unseen = true }
        let clean = self.strip_screen_titles(bytes);
        let before = self.term.grid().history_size();
        self.parser.advance(&mut self.term, &clean);
        let after = self.term.grid().history_size();
        let full = after == HISTORY.load(std::sync::atomic::Ordering::Relaxed).clamp(100, 200_000);
        if after < before || self.times.len() != before || (full && after == before) {
            // Cleared, or full (lines scroll off the top unseen): which time is whose is no
            // longer known.
            self.times.clear();
            self.times.resize(after, 0);
        } else {
            for _ in before..after { self.times.push_back(when) }
        }
        self.dirty = true;
        let events: Vec<AlacEvent> = std::mem::take(&mut *self.listener.0.lock().unwrap());
        for event in events {
            match event {
                AlacEvent::Title(title) => self.osc_title = title,
                AlacEvent::ResetTitle => self.osc_title.clear(),
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

    pub fn scroll_bottom(&mut self) {
        if self.term.grid().display_offset() != 0 {
            self.term.scroll_display(Scroll::Bottom);
            self.dirty = true;
        }
    }

    pub fn scrolled(&self) -> usize { self.term.grid().display_offset() }

    /// tmux's clear-history: this window's copy of the scrollback, gone.
    pub fn clear_history(&mut self) { self.term.grid_mut().clear_history(); self.times.clear(); self.dirty = true }

    /// Whether the pane is in copy mode or view mode.
    pub fn in_mode(&self) -> bool { !self.modes.is_empty() }

    /// capture-pane -S/-E: rows from `start` to `end` (0 the top of the screen, negative into
    /// the history, `-` the ends), every row kept.
    pub fn text_range(&self, start: Option<i32>, end: Option<i32>) -> String {
        let grid = self.term.grid();
        let top = -(grid.history_size() as i32);
        let bottom = self.term.screen_lines() as i32 - 1;
        let s = start.unwrap_or(0).clamp(top, bottom);
        let e = end.unwrap_or(bottom).clamp(top, bottom);
        let mut out = Vec::new();
        for line in s..=e {
            let row = &grid[alacritty_terminal::index::Line(line)];
            let text: String = (0..self.term.columns()).map(|c| row[alacritty_terminal::index::Column(c)].c).collect();
            out.push(text.replace('\0', " ").trim_end().to_string());
        }
        out.join("\n")
    }



    fn grid_point(&self, col: u16, row: u16) -> alacritty_terminal::index::Point {
        use alacritty_terminal::index::{Column, Line, Point};
        let offset = self.term.grid().display_offset() as i32;
        let col = (col as usize).min(self.cols.saturating_sub(1) as usize);
        Point::new(Line(row as i32 - offset), Column(col))
    }

    // ── the grid, for the mouse formats (format_grid_*) ─────────────────────

    /// grid_line_length: a line's cells up to its last one that is not a blank.
    fn line_length(&self, line: i32) -> usize {
        use alacritty_terminal::index::{Column, Line};
        let row = &self.term.grid()[Line(line)];
        let mut n = self.term.columns();
        while n > 0 {
            let c = &row[Column(n - 1)];
            if c.c != ' ' && c.c != '\0' || c.flags.contains(alacritty_terminal::term::cell::Flags::WIDE_CHAR_SPACER) { break }
            n -= 1;
        }
        n
    }

    /// format_grid_word: the word at a cell of the view — back to a word-separator or a blank,
    /// then on to the next, across lines that wrapped.
    pub fn word_at(&self, col: u16, row: u16, ws: &str) -> String {
        use alacritty_terminal::index::{Column, Line, Point};
        use alacritty_terminal::term::cell::Flags;
        let grid = self.term.grid();
        let (top, bottom, last) = (-(grid.history_size() as i32), grid.screen_lines() as i32 - 1, grid.columns().saturating_sub(1));
        let start = self.grid_point(col, row);
        let wrapped = |line: i32| grid[Line(line)][Column(last)].flags.contains(Flags::WRAPLINE);
        let padding = |p: Point| grid[p].flags.contains(Flags::WIDE_CHAR_SPACER);
        let separator = |p: Point| { let c = grid[p].c; c == ' ' || c == '\0' || ws.contains(c) };
        let (mut x, mut y) = (start.column.0, start.line.0);
        let mut found = false;
        loop {
            let p = Point::new(Line(y), Column(x));
            if padding(p) { break }
            if separator(p) { found = true; break }
            if x == 0 {
                if y == top || !wrapped(y - 1) { break }
                y -= 1;
                x = self.line_length(y);
                if x == 0 { break }
            }
            x -= 1;
        }
        let mut word = String::new();
        loop {
            if found {
                let end = self.line_length(y);
                if end == 0 || x + 1 == end {
                    if y == bottom || !wrapped(y) { break }
                    y += 1;
                    x = 0;
                } else { x += 1 }
            }
            found = true;
            let p = Point::new(Line(y), Column(x));
            if x > last || padding(p) || separator(p) { break }
            word.push(grid[p].c);
            if let Some(extra) = grid[p].zerowidth() { word.extend(extra.iter()) }
        }
        word
    }

    /// format_grid_line: a row of the view, to its last character.
    pub fn line_at(&self, row: u16) -> String {
        use alacritty_terminal::index::{Column, Line};
        use alacritty_terminal::term::cell::Flags;
        let line = self.grid_point(0, row).line.0;
        let cells = &self.term.grid()[Line(line)];
        (0..self.line_length(line)).map(|x| &cells[Column(x)]).filter(|c| !c.flags.contains(Flags::WIDE_CHAR_SPACER)).map(|c| if c.c == '\0' { ' ' } else { c.c }).collect()
    }

    /// format_grid_hyperlink: the link (OSC 8) at a cell of the view.
    pub fn hyperlink_at(&self, col: u16, row: u16) -> Option<String> {
        let p = self.grid_point(col, row);
        self.term.grid()[p].hyperlink().map(|h| h.uri().to_string())
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
    fn sgr_mouse() {
        let mode = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        assert_eq!(encode_mouse(MouseEventKind::Down(MouseButton::Left), 4, 2, KeyModifiers::NONE, mode).unwrap(), b"\x1b[<0;5;3M");
        assert!(encode_mouse(MouseEventKind::ScrollUp, 0, 0, KeyModifiers::NONE, TermMode::empty()).is_none());
    }
}

#[cfg(test)]
mod osc7_tests {
    #[test]
    fn reads_the_folder() {
        assert_eq!(super::osc7(b"x\x1b]7;file://mac.lan/Users/me/my%20code\x07y").as_deref(), Some("/Users/me/my code"));
        assert_eq!(super::osc7(b"\x1b]7;file:///tmp\x1b\\").as_deref(), Some("/tmp"));
        assert_eq!(super::osc7(b"plain"), None);
    }
}
