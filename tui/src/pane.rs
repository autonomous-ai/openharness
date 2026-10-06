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
use alacritty_terminal::vte::ansi::{self, CursorShape, CursorStyle, Handler, Processor};
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use uuid::Uuid;

// A pane's program gets the pane's size, however small, as tmux gives it (a floor cropped a narrow
// pane's lines: a 39-column pane at 80×24 lost a character from each).
pub const MIN_COLS: u16 = 1;
pub const MIN_ROWS: u16 = 1;
pub const MAX_COLS: u16 = 300;
pub const MAX_ROWS: u16 = 120;

#[derive(Clone, Default)]
pub struct Listener(Arc<Mutex<Vec<AlacEvent>>>, Arc<std::sync::atomic::AtomicBool>);

impl EventListener for Listener {
    fn send_event(&self, event: AlacEvent) {
        match event {
            AlacEvent::Title(_) | AlacEvent::ResetTitle | AlacEvent::Bell | AlacEvent::ClipboardStore(..) => {
                self.0.lock().unwrap().push(event)
            }
            AlacEvent::PtyWrite(_) | AlacEvent::ColorRequest(..) | AlacEvent::TextAreaSizeRequest(_) | AlacEvent::ClipboardLoad(..) if self.1.load(std::sync::atomic::Ordering::Relaxed) => self.0.lock().unwrap().push(event),
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

/// A reaped native process, with an identity that survives client handoff and changes on respawn.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Exit { pub id: String, pub status: Option<i32>, pub signal: Option<i32>, pub time: i64 }

pub struct Pane {
    pub id: u64,
    pub machine_id: String,
    pub agent_id: String,
    pub term: Term<Listener>,
    parser: Processor,
    local: Option<crate::local::ScreenState>,
    local_replies: Vec<Vec<u8>>,
    pub listener: Listener,
    pub stream: Option<Uuid>,
    pub phase: Phase,
    pub dead: Option<Exit>,
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
    /// A user requested app-wide control while this pane's passive open was in flight.
    pub takeover_pending: bool,
    pub read_only: bool,
    pub last_alive: Instant,
    pub dirty: bool,
    pub bell: bool,
    /// What the program copied (OSC 52), not yet passed on.
    pub copied: Vec<String>,
    /// A key that arrived while a watcher was being promoted to controller.
    pub queued: Vec<Vec<u8>>,
    /// The folder the shell says it is in (OSC 7), for #{pane_current_path} and new splits.
    pub cwd: Option<String>,
    /// That OSC 7 as it came (`file://host/path`): tmux's screen path, #{pane_path}.
    pub osc7_url: Option<String>,
    /// The start of an OSC 7 a chunk ended in the middle of, for the next one.
    osc_carry: Vec<u8>,
    /// What tmux on the pane's machine says it runs, and where (the daemon's terminal_info):
    /// #{pane_current_command}, #{pane_current_path}, #{pane_pid}, #{pane_tty}.
    pub fg_command: Option<String>,
    /// The shell command supplied at creation or respawn, retained after the process exits.
    pub start_command: Option<String>,
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
    /// mosh's epochs: after Enter or any other control key (and after a prediction the far side
    /// never echoed) nothing typed is shown until the far side has echoed one of this epoch's
    /// characters — so a prompt that does not echo (a password) never shows one.
    pub epoch_confirmed: bool,
    /// Bumped on every open; a reply carrying an older one is stale.
    pub open_token: u64,
    /// The pane's modes, the one in front last: copy mode and view mode (tmux's wp->modes).
    pub modes: Vec<Box<crate::copy::Copy>>,
    /// choose-tree's tree mode, if the pane is in it, and where it stands among the modes: over
    /// the copy and view modes below that many (a copy mode entered later is over it).
    pub tree: Option<Box<crate::tree::Tree>>,
    pub tree_at: usize,
    /// choose-file's file manager, likewise (never with the tree: each ends the other).
    pub files: Option<Box<crate::files::Files>>,
    pub files_at: usize,
    /// The last search in copy mode (wp->searchstr): the next copy mode starts with it.
    pub search: crate::copy::PaneSearch,
    /// Output arrived while in a mode (#{pane_unseen_changes}).
    pub unseen: bool,
    /// In clock mode (C-b t): the time drawn over it until a key reaches it (window-clock.c).
    pub clock: bool,
    /// When each history line went into the history (0: not known), oldest first — while the
    /// history is not full; after that they are not known.
    pub times: std::collections::VecDeque<i64>,
    /// OSC 133's marks (tmux's GRID_LINE_START_PROMPT / _OUTPUT) of the history's lines, oldest
    /// first, and of the screen's rows — on the line the cursor was on when each came.
    pub hist_marks: std::collections::VecDeque<u8>,
    pub screen_marks: Vec<u8>,
    /// The start of an OSC 133 a chunk ended in the middle of.
    mark_carry: Vec<u8>,
    /// Inside screen's `ESC k … ESC \` title (split across chunks).
    in_screen_title: bool,
    /// An ESC ended the last chunk; the next byte decides what it was.
    pending_esc: bool,
}

/// The end of a chunk that may be the start of an OSC 7 still to come.
fn osc7_unfinished(bytes: &[u8]) -> &[u8] { unfinished(bytes, b"\x1b]7;") }

/// The end of a chunk that may be the start of an OSC still to come: [intro] and what follows
/// with no BEL or ESC yet, or the first bytes of [intro].
fn unfinished<'a>(bytes: &'a [u8], intro: &[u8]) -> &'a [u8] {
    if let Some(start) = bytes.windows(intro.len()).rposition(|w| w == intro) {
        let rest = &bytes[start + intro.len()..];
        if !rest.iter().any(|b| *b == 0x07 || *b == 0x1b) && rest.len() < 4096 { return &bytes[start..] }
    }
    (1..intro.len()).rev().find(|n| bytes.ends_with(&intro[..*n])).map(|n| &bytes[bytes.len() - n..]).unwrap_or(&[])
}

/// The last `ESC ] 7 ; file://host/path` (BEL or ST) in a chunk: as it came, and the shell's
/// current folder it names.
fn osc7(bytes: &[u8]) -> Option<(String, String)> {
    let (start, end) = bytes.windows(4).enumerate().rev().filter(|(_, w)| *w == b"\x1b]7;").find_map(|(s, _)| bytes[s + 4..].iter().position(|b| *b == 0x07 || *b == 0x1b).map(|e| (s, e)))?;
    let rest = &bytes[start + 4..];
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
    String::from_utf8(out).ok().filter(|p| p.starts_with('/')).map(|p| (url.to_string(), p))
}

// A hollow block marks "the program never chose a cursor": the user's own shape stays.
/// tmux's history-limit (tmux.conf or `set`), for panes opened from now on.
pub static HISTORY: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(10_000);

fn config() -> Config { Config { scrolling_history: HISTORY.load(std::sync::atomic::Ordering::Relaxed).clamp(100, 200_000), default_cursor_style: CursorStyle { shape: CursorShape::HollowBlock, blinking: false }, ..Config::default() } }

/// tmux combines VS16, skin tones, regional indicators and the character after a ZWJ
/// into the preceding cell. Alacritty handles only zero-width scalars, so adapt printable
/// input before it reaches the grid; every ANSI operation still uses Alacritty's handler.
struct TmuxScreen<'a>(&'a mut Term<Listener>, Option<&'a mut crate::local::ScreenState>);

macro_rules! forward_screen {
    ($($name:ident($($arg:ident: $ty:ty),*);)*) => { $(
        fn $name(&mut self, $($arg: $ty),*) { self.0.$name($($arg),*) }
    )* };
}

impl Handler for TmuxScreen<'_> {
    fn input(&mut self, c: char) {
        use alacritty_terminal::index::Column;
        use alacritty_terminal::term::cell::Flags;
        use unicode_width::UnicodeWidthChar;
        // A VS16 widened at the last column can leave a clipped wide cell under the
        // cursor. Overwriting it must not clear the unrelated cell to its left.
        let last_column = self.0.columns() - 1;
        let grid = self.0.grid_mut();
        if !grid.cursor.input_needs_wrap && grid.cursor.point.column.0 == last_column {
            let point = grid.cursor.point;
            grid[point].flags.remove(Flags::WIDE_CHAR);
        }
        // libc wcwidth (and tmux) gives a soft hyphen one column; unicode-width gives
        // it zero. Let Alacritty place a narrow cell, then preserve the actual scalar.
        if c == '\u{ad}' {
            self.0.input(' ');
            let grid = self.0.grid_mut();
            let mut at = grid.cursor.point;
            if !grid.cursor.input_needs_wrap { at.column.0 -= 1 }
            grid[at].c = c;
            return;
        }
        // screen_write_combine: ASCII never joins a cell, even after a ZWJ.
        if c.is_ascii() { self.0.input(c); return }
        // tmux clips a wide glyph in a one-column pane and leaves its cursor on
        // that cell. Alacritty's normal wide path requires a second spacer cell.
        if self.0.columns() == 1 && c.width() == Some(2) {
            self.0.input(' ');
            let grid = self.0.grid_mut();
            let point = grid.cursor.point;
            grid[point].c = c;
            grid[point].flags.insert(Flags::WIDE_CHAR);
            grid.cursor.input_needs_wrap = false;
            return;
        }
        let zero = c.width() == Some(0);
        let modifier = matches!(c, '\u{1f1e6}'..='\u{1f1ff}' | '\u{1f3fb}'..='\u{1f3ff}');
        let force_wide = c == '\u{fe0f}' || modifier;
        let columns = self.0.columns();
        let grid = self.0.grid_mut();
        let cursor = grid.cursor.point;
        let cx = cursor.column.0 + usize::from(grid.cursor.input_needs_wrap);
        if cx == 0 { if !zero { self.0.input(c) } return }
        let mut at = cx - 1;
        if at > 0 && grid[cursor.line][Column(at)].flags.contains(Flags::WIDE_CHAR_SPACER) { at -= 1 }
        let cell = &mut grid[cursor.line][Column(at)];
        let width = if cell.flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };
        let valid = at + width == cx && !cell.flags.contains(Flags::WIDE_CHAR_SPACER);
        let extra = cell.zerowidth().unwrap_or_default();
        let bytes = cell.c.len_utf8() + extra.iter().map(|c| c.len_utf8()).sum::<usize>();
        let joined = extra.last() == Some(&'\u{200d}');
        if valid && (zero || modifier && bytes >= 2 || joined) && bytes + c.len_utf8() <= 21 {
            cell.push_zerowidth(c);
            if width == 1 && force_wide {
                cell.flags.insert(Flags::WIDE_CHAR);
                if at + 1 < columns {
                    let mut spacer = alacritty_terminal::term::cell::Cell::default();
                    spacer.flags.insert(Flags::WIDE_CHAR_SPACER);
                    grid[cursor.line][Column(at + 1)] = spacer;
                    grid.cursor.point.column = Column((cx + 1).min(columns - 1));
                    grid.cursor.input_needs_wrap = cx + 1 >= columns;
                } else {
                    // tmux clamps a widened cell past the right margin back to the last
                    // column; the next printable character overwrites it in place.
                    grid.cursor.input_needs_wrap = false;
                }
            }
        } else if !zero || valid {
            self.0.input(c);
        }
    }


    fn set_private_mode(&mut self, mode: ansi::PrivateMode) {
        if let Some(state) = &mut self.1 {
            if mode == ansi::NamedPrivateMode::SwapScreenAndSetRestoreCursor.into() && !self.0.mode().contains(TermMode::ALT_SCREEN) {
                let mut main = self.0.grid().clone();
                main.saved_cursor = main.cursor.clone();
                state.main = Some(main);
                std::mem::swap(&mut state.keyboard, &mut state.main_keyboard);
            }
        }
        self.0.set_private_mode(mode);
    }
    fn unset_private_mode(&mut self, mode: ansi::PrivateMode) {
        if let Some(state) = &mut self.1 {
            if mode == ansi::NamedPrivateMode::SwapScreenAndSetRestoreCursor.into() && self.0.mode().contains(TermMode::ALT_SCREEN) {
                state.main = None;
                std::mem::swap(&mut state.keyboard, &mut state.main_keyboard);
            }
        }
        self.0.unset_private_mode(mode);
    }
    fn set_scrolling_region(&mut self, top: usize, bottom: Option<usize>) {
        if let Some(state) = &mut self.1 {
            let bottom = bottom.unwrap_or(self.0.screen_lines());
            if top < bottom { state.margins = (top.min(self.0.screen_lines()), bottom.min(self.0.screen_lines())); }
        }
        self.0.set_scrolling_region(top, bottom);
    }
    fn set_active_charset(&mut self, index: ansi::CharsetIndex) {
        if let Some(state) = &mut self.1 { state.charset = index; }
        self.0.set_active_charset(index);
    }
    fn set_horizontal_tabstop(&mut self) {
        if let Some(state) = &mut self.1 { if let Some(tab) = state.tabs.get_mut(self.0.grid().cursor.point.column.0) { *tab = true; } }
        self.0.set_horizontal_tabstop();
    }
    fn clear_tabs(&mut self, mode: ansi::TabulationClearMode) {
        if let Some(state) = &mut self.1 {
            match mode { ansi::TabulationClearMode::All => state.tabs.fill(false), ansi::TabulationClearMode::Current => { if let Some(tab) = state.tabs.get_mut(self.0.grid().cursor.point.column.0) { *tab = false; } } }
        }
        self.0.clear_tabs(mode);
    }
    fn reset_state(&mut self) {
        if let Some(state) = &mut self.1 { **state = crate::local::ScreenState::new(self.0.columns(), self.0.screen_lines()); }
        self.0.reset_state();
    }
    fn push_keyboard_mode(&mut self, mode: ansi::KeyboardModes) {
        if let Some(state) = &mut self.1 { if state.keyboard.len() >= 4096 { state.keyboard.remove(0); } state.keyboard.push(mode); }
        self.0.push_keyboard_mode(mode);
    }
    fn pop_keyboard_modes(&mut self, n: u16) {
        if let Some(state) = &mut self.1 { state.keyboard.truncate(state.keyboard.len().saturating_sub(n as usize)); }
        self.0.pop_keyboard_modes(n);
    }

    forward_screen! {
        set_title(a0: Option<String>);
        set_cursor_style(a0: Option<ansi::CursorStyle>);
        set_cursor_shape(a0: ansi::CursorShape);
        goto(a0: i32, a1: usize);
        goto_line(a0: i32);
        goto_col(a0: usize);
        insert_blank(a0: usize);
        move_up(a0: usize);
        move_down(a0: usize);
        identify_terminal(a0: Option<char>);
        device_status(a0: usize);
        move_forward(a0: usize);
        move_backward(a0: usize);
        move_down_and_cr(a0: usize);
        move_up_and_cr(a0: usize);
        put_tab(a0: u16);
        backspace();
        carriage_return();
        linefeed();
        bell();
        substitute();
        newline();
        scroll_up(a0: usize);
        scroll_down(a0: usize);
        insert_blank_lines(a0: usize);
        delete_lines(a0: usize);
        erase_chars(a0: usize);
        delete_chars(a0: usize);
        move_backward_tabs(a0: u16);
        move_forward_tabs(a0: u16);
        save_cursor_position();
        restore_cursor_position();
        clear_line(a0: ansi::LineClearMode);
        clear_screen(a0: ansi::ClearMode);
        set_tabs(a0: u16);
        reverse_index();
        terminal_attribute(a0: ansi::Attr);
        set_mode(a0: ansi::Mode);
        unset_mode(a0: ansi::Mode);
        report_mode(a0: ansi::Mode);
        report_private_mode(a0: ansi::PrivateMode);
        set_keypad_application_mode();
        unset_keypad_application_mode();
        configure_charset(a0: ansi::CharsetIndex, a1: ansi::StandardCharset);
        set_color(a0: usize, a1: ansi::Rgb);
        dynamic_color_sequence(a0: String, a1: usize, a2: &str);
        reset_color(a0: usize);
        clipboard_store(a0: u8, a1: &[u8]);
        clipboard_load(a0: u8, a1: &str);
        decaln();
        push_title();
        pop_title();
        text_area_size_pixels();
        text_area_size_chars();
        set_hyperlink(a0: Option<ansi::Hyperlink>);
        set_mouse_cursor_icon(a0: ansi::cursor_icon::CursorIcon);
        report_keyboard_mode();
        set_keyboard_mode(a0: ansi::KeyboardModes, a1: ansi::KeyboardModesApplyBehavior);
        set_modify_other_keys(a0: ansi::ModifyOtherKeys);
        report_modify_other_keys();
        set_scp(a0: ansi::ScpCharPath, a1: ansi::ScpUpdateMode);
    }
}

impl Pane {
    /// respawn resets the visible screen and terminal modes but retains the window's history.
    pub fn inherit_history(&mut self, old: &Pane) {
        let mut grid = old.local.as_ref().and_then(|s| s.main.as_ref()).unwrap_or_else(|| old.term.grid()).clone();
        grid.cursor = Default::default();
        grid.saved_cursor = Default::default();
        grid.reset_region(..);
        *self.term.grid_mut() = grid;
        self.times = old.times.clone();
        self.hist_marks = old.hist_marks.clone();
    }

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

    /// The cursor's colour the program set (OSC 12), as tmux passes it on (rgb:rr/gg/bb).
    pub fn cursor_colour(&self) -> Option<String> {
        self.term.colors()[alacritty_terminal::vte::ansi::NamedColor::Cursor].map(|c| format!("rgb:{:02x}/{:02x}/{:02x}", c.r, c.g, c.b))
    }
}

impl Pane {
    /// A fast replacement process may already have exited before its restart RPC
    /// callback runs. Only retire the exit that belonged to the old process; a new
    /// exit must survive stream reopening so pane-died is not emitted twice.
    pub fn complete_restart(&mut self, previous_exit: Option<&str>, command: Option<String>) {
        if self.dead.as_ref().map(|exit| exit.id.as_str()) == previous_exit { self.dead = None; }
        if command.is_some() { self.start_command = command; }
    }

    pub fn new(id: u64, machine_id: &str, agent_id: &str, cols: u16, rows: u16) -> Pane {
        let listener = Listener::default();
        let (cols, rows) = (cols.max(1), rows.max(1));
        Pane {
            id,
            machine_id: machine_id.to_string(),
            agent_id: agent_id.to_string(),
            term: Term::new(config(), &Size(cols, rows), listener.clone()),
            parser: Processor::new(),
            local: None,
            local_replies: Vec::new(),
            listener,
            stream: None,
            phase: Phase::Connecting("Connecting…".into()), dead: None,
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
            takeover_pending: false,
            read_only: false,
            last_alive: Instant::now(),
            dirty: true,
            bell: false, copied: Vec::new(),
            queued: Vec::new(),
            cwd: None,
            fg_command: None,
            start_command: None,
            live_path: None,
            remote_pid: None,
            remote_tty: None,
            in_screen_title: false,
            pending_esc: false,
            osc7_url: None,
            osc_carry: Vec::new(),
            input_at: None,
            echo_us: Vec::new(),
            predictions: Vec::new(),
            epoch_confirmed: false,
            open_token: 0,
            modes: Vec::new(),
            tree: None,
            tree_at: 0,
            files: None,
            files_at: 0,
            search: Default::default(),
            unseen: false,
            clock: false,
            times: Default::default(),
            hist_marks: Default::default(),
            screen_marks: Vec::new(),
            mark_carry: Vec::new(),
        }
    }

    /// Only the persistent PTY owner answers terminal queries. Mirror panes still drop them.
    pub fn enable_local(&mut self) {
        self.listener.1.store(true, std::sync::atomic::Ordering::Relaxed);
        self.local = Some(crate::local::ScreenState::new(self.cols as usize, self.rows as usize));
    }

    pub fn resize_local(&mut self, cols: u16, rows: u16) {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        self.term.resize(Size(self.cols, self.rows));
        if let Some(state) = &mut self.local { state.resize(self.cols as usize, self.rows as usize); }
    }

    pub fn local_snapshot(&self, tail: &[u8]) -> Vec<u8> {
        let state = self.local.as_ref().expect("only the local PTY owner takes snapshots");
        // screen's title string is stripped before parsing; preserve that separate parser
        // state too, so reconnecting in its middle cannot print the rest of the title.
        let tail = if self.in_screen_title { [b"\x1bk".as_slice(), if self.pending_esc { b"\x1b" } else { b"" }].concat() } else { tail.to_vec() };
        state.snapshot(&self.term, &self.osc_title, self.osc7_url.as_deref(), &tail)
    }

    pub fn take_local_replies(&mut self) -> Vec<Vec<u8>> { std::mem::take(&mut self.local_replies) }

    /// A keyframe: the whole screen again, from nothing, at the far pane's size.
    pub fn keyframe(&mut self, cols: u16, rows: u16, bytes: &[u8]) {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        self.term = Term::new(config(), &Size(self.cols, self.rows), self.listener.clone());
        self.parser = Processor::new();
        self.in_screen_title = false;
        self.pending_esc = false;
        // Predictions were placed on the old grid; a new one (maybe narrower) has no room for them.
        self.predictions.clear();
        // The history the keyframe brings is from before: when its lines went there is not known.
        self.times.clear();
        self.hist_marks.clear();
        self.screen_marks.clear();
        self.mark_carry.clear();
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
        // (An OSC 7 may come in pieces — a shell's writes, a terminal's echo — so an unfinished
        // one is kept for the next chunk.)
        let scan: std::borrow::Cow<[u8]> = if self.osc_carry.is_empty() { bytes.into() } else { [std::mem::take(&mut self.osc_carry).as_slice(), bytes].concat().into() };
        if let Some((url, dir)) = osc7(&scan) { self.osc7_url = Some(url); self.cwd = Some(dir) }
        self.osc_carry = osc7_unfinished(&scan).to_vec();
        if !self.modes.is_empty() && !bytes.is_empty() { self.unseen = true }
        let clean = self.strip_screen_titles(bytes);
        // OSC 133 (input_osc_133): the output up to each one, then its mark on the cursor's line.
        let mut at = 0;
        for (end, flag) in self.osc133_cuts(&clean) {
            self.advance(&clean[at..end], when);
            let row = self.term.grid().cursor.point.line.0.max(0) as usize;
            if !self.term.mode().contains(TermMode::ALT_SCREEN) { if let Some(m) = self.screen_marks.get_mut(row) { *m |= flag } }
            at = end;
        }
        self.advance(&clean[at..], when);
        self.dirty = true;
        let events: Vec<AlacEvent> = std::mem::take(&mut *self.listener.0.lock().unwrap());
        for event in events {
            match event {
                AlacEvent::Title(title) => self.osc_title = title,
                AlacEvent::ResetTitle => self.osc_title.clear(),
                AlacEvent::Bell => self.bell = true,
                // OSC 52: for the app to pass on as set-clipboard says.
                AlacEvent::ClipboardStore(_, text) => self.copied.push(text),
                AlacEvent::PtyWrite(text) if self.local.is_some() => self.local_replies.push(text.into_bytes()),
                AlacEvent::ColorRequest(index, format) if self.local.is_some() => self.local_replies.push(format(self.term.colors()[index].unwrap_or_else(|| crate::local::colour(index))).into_bytes()),
                AlacEvent::TextAreaSizeRequest(format) if self.local.is_some() => self.local_replies.push(format(alacritty_terminal::event::WindowSize { num_cols: self.cols, num_lines: self.rows, cell_width: 0, cell_height: 0 }).into_bytes()),
                AlacEvent::ClipboardLoad(_, format) if self.local.is_some() => self.local_replies.push(format("").into_bytes()),
                _ => {}
            }
        }
    }

    /// Output into the terminal, the history's times and marks kept with its lines.
    fn advance(&mut self, bytes: &[u8], when: i64) {
        if bytes.is_empty() { return }
        let before = self.term.grid().history_size();
        self.parser.advance(&mut TmuxScreen(&mut self.term, self.local.as_mut()), bytes);
        // The local supervisor has no renderer: apply synchronized updates immediately so
        // queries and reconnect snapshots see all PTY output, including a partial frame.
        if self.local.is_some() { self.parser.stop_sync(&mut TmuxScreen(&mut self.term, self.local.as_mut())); }
        let after = self.term.grid().history_size();
        let rows = self.term.screen_lines();
        if self.screen_marks.len() != rows { self.screen_marks.resize(rows, 0) }
        let full = after == HISTORY.load(std::sync::atomic::Ordering::Relaxed).clamp(100, 200_000);
        if after < before || self.times.len() != before || (full && after == before) {
            // Cleared, or full (lines scroll off the top unseen): which time is whose is no
            // longer known.
            self.times.clear();
            self.times.resize(after, 0);
        } else {
            for _ in before..after { self.times.push_back(when) }
        }
        if after < before || self.hist_marks.len() != before || (full && after == before) {
            self.hist_marks.clear();
            self.hist_marks.resize(after, 0);
        } else {
            // The screen's top rows went into the history, their marks with them.
            for _ in before..after {
                let m = if self.screen_marks.is_empty() { 0 } else { self.screen_marks.remove(0) };
                self.hist_marks.push_back(m);
                self.screen_marks.push(0);
            }
        }
    }

    /// Where each whole OSC 133 (`ESC ] 133 ; A` … BEL or ST) in [bytes] ends, and its mark (A a
    /// prompt, C output) — one begun in the chunk before counted too.
    fn osc133_cuts(&mut self, bytes: &[u8]) -> Vec<(usize, u8)> {
        const INTRO: &[u8] = b"\x1b]133;";
        let carried = self.mark_carry.len();
        let scan: Vec<u8> = [std::mem::take(&mut self.mark_carry).as_slice(), bytes].concat();
        let mut cuts = Vec::new();
        let mut i = 0;
        while let Some(s) = scan[i..].windows(INTRO.len()).position(|w| w == INTRO).map(|p| p + i) {
            let body = s + INTRO.len();
            let Some(t) = scan[body..].iter().position(|b| *b == 0x07 || *b == 0x1b).map(|p| p + body) else { break };
            // BEL ends it; ESC \ does (its backslash may be in the next chunk: the cut is after ESC).
            let end = if scan[t] == 0x1b && scan.get(t + 1) == Some(&b'\\') { t + 2 } else { t + 1 };
            let flag = match scan.get(body) { Some(b'A') => crate::copy::LINE_START_PROMPT, Some(b'C') => crate::copy::LINE_START_OUTPUT, _ => 0 };
            if flag != 0 && end > carried { cuts.push((end - carried, flag)) }
            i = end;
        }
        self.mark_carry = unfinished(&scan[i..], INTRO).to_vec();
        cuts
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
        if c.is_control() || unicode_width::UnicodeWidthChar::width(c) != Some(1) { self.predictions.clear(); self.epoch_confirmed = false; return }
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
        // (A key not predicted — Enter, an arrow, a control key: a new epoch.)
        self.epoch_confirmed = false;
        if !self.predictions.is_empty() { self.predictions.clear(); self.dirty = true }
    }

    /// The typed characters to show now: this epoch's, once the far side has echoed one of them.
    pub fn shown_predictions(&self) -> &[(u16, u16, char, Instant)] { if self.epoch_confirmed { &self.predictions } else { &[] } }

    /// Drop what the far side has now confirmed (the grid shows that character there), and give up
    /// on anything it has not echoed well past a round trip — a password prompt, say.
    pub fn settle_predictions(&mut self) {
        if self.predictions.is_empty() { return }
        use alacritty_terminal::index::{Column, Line};
        let patience = std::time::Duration::from_millis(self.echo_ms().map(|(_, p95)| (p95 * 3.0) as u64).unwrap_or(600).clamp(400, 2_000));
        let grid = self.term.grid();
        let rows = grid.screen_lines() as u16;
        let before = self.predictions.len();
        let (mut confirmed, mut expired) = (false, false);
        self.predictions.retain(|(col, row, c, at)| {
            if *row >= rows || *col as usize >= grid.columns() { return false }
            let cell = &grid[Line(*row as i32)][Column(*col as usize)];
            if cell.c == *c { confirmed = true; return false }
            if at.elapsed() >= patience { expired = true; return false }
            true
        });
        // Echoed: this epoch's typing shows from now. Never echoed: a new epoch, nothing shown.
        if confirmed { self.epoch_confirmed = true }
        if expired { self.epoch_confirmed = false; self.predictions.clear() }
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

    /// Whether the pane is in a mode: copy mode, view mode, tree mode or the file manager
    /// (#{pane_in_mode}).
    pub fn in_mode(&self) -> bool { !self.modes.is_empty() || self.tree.is_some() || self.files.is_some() }

    /// Whether the mode in front is the tree (choose-tree).
    pub fn tree_top(&self) -> bool { self.tree.is_some() && self.modes.len() <= self.tree_at }

    /// Whether the mode in front is the file manager (choose-file).
    pub fn files_top(&self) -> bool { self.files.is_some() && self.modes.len() <= self.files_at }

    /// Whether the mode in front is copy mode or view mode.
    pub fn copy_top(&self) -> bool { !self.modes.is_empty() && !self.tree_top() && !self.files_top() }

    /// How many modes the pane is in (#{pane_in_mode}).
    pub fn mode_count(&self) -> usize { self.modes.len() + self.tree.is_some() as usize + self.files.is_some() as usize }

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
    // ⌘ (the kitty protocol's SUPER, and HYPER) never reaches a pane, as tmux never sees it: an
    // unbound ⌘C is nothing, not a `c`.
    if mods.intersects(KeyModifiers::SUPER | KeyModifiers::HYPER) { return None }
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
                // S-x is X (a key tmux names M-X arrives here as M-S-x).
                let c = if shift && c.is_lowercase() { c.to_uppercase().next().unwrap_or(c) } else { c };
                let mut buf = [0u8; 4];
                with_alt(c.encode_utf8(&mut buf).as_bytes().to_vec())
            }
        }
        // As the desktop sends it: prompts tell a newline (⇧⏎) from the Return that submits.
        KeyCode::Enter if shift && !alt && !ctrl => b"\x1b[13;2u".to_vec(),
        KeyCode::Enter => with_alt(vec![b'\r']),
        // S-Tab is a Tab (tmux drops the shift without extended keys); BTab is the back tab.
        KeyCode::Tab => with_alt(vec![b'\t']),
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
            // The keypad (KP/ … KP., after F12): its characters, or ESC O x in application
            // keypad mode (tmux's input_key_defaults).
            13..=28 => {
                let i = (n - 13) as usize;
                if mode.contains(TermMode::APP_KEYPAD) { format!("\x1bO{}", "ojmwxyktuvqrsMpn".as_bytes()[i] as char).into_bytes() }
                else { with_alt(if i == 13 { vec![b'\n'] } else { vec!["/*-789+456123\n0.".as_bytes()[i]] }) }
            }
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
    fn emoji_clusters_match_tmux_cells_across_byte_boundaries() {
        use alacritty_terminal::index::{Column, Line};
        use alacritty_terminal::term::cell::Flags;
        for text in ["⚠️", "✔️", "❤️", "ℹ️", "☀️", "👍🏽", "👨‍👩‍👧", "🏳️‍🌈", "🇬🇧"] {
            let mut pane = Pane::new(1, "m", "a", 20, 5);
            // A stream may split both UTF-8 characters and grapheme clusters.
            for b in text.as_bytes() { pane.feed(&[*b]) }
            let grid = pane.term.grid();
            assert_eq!(grid.cursor.point.column.0, 2, "{text}");
            assert!(grid[Line(0)][Column(0)].flags.contains(Flags::WIDE_CHAR), "{text}");
            assert!(grid[Line(0)][Column(1)].flags.contains(Flags::WIDE_CHAR_SPACER), "{text}");
            let cell = &grid[Line(0)][Column(0)];
            let got: String = std::iter::once(cell.c).chain(cell.zerowidth().unwrap_or_default().iter().copied()).collect();
            assert_eq!(got, text);
            pane.feed(b"X");
            assert_eq!(pane.term.grid()[Line(0)][Column(2)].c, 'X');
        }
    }

    #[test]
    fn emoji_preserves_ansi_state_and_wraps_at_the_margin() {
        use alacritty_terminal::index::{Column, Line};
        use alacritty_terminal::term::cell::Flags;
        let mut pane = Pane::new(1, "m", "a", 6, 3);
        pane.feed("\x1b[31m1234⚠️X\x1b[0m".as_bytes());
        let grid = pane.term.grid();
        assert_eq!(grid[Line(0)][Column(4)].c, '⚠');
        assert!(grid[Line(0)][Column(4)].flags.contains(Flags::WIDE_CHAR));
        assert_eq!(grid[Line(1)][Column(0)].c, 'X');
        assert_eq!(grid[Line(1)][Column(0)].fg, ansi::Color::Named(ansi::NamedColor::Red));
        assert_eq!(grid.cursor.point, alacritty_terminal::index::Point::new(Line(1), Column(1)));
        pane.feed(b"\x1b[1;6H!");
        assert!(!pane.term.grid()[Line(0)][Column(4)].flags.contains(Flags::WIDE_CHAR));
        assert_eq!(pane.term.grid()[Line(0)][Column(5)].c, '!');
        pane.feed(b"\x1b[?1049hZ\x1b[?1049l");
        assert_eq!(pane.term.grid()[Line(0)][Column(5)].c, '!');
    }

    #[test]
    fn one_cell_grid_matches_native_size() {
        use alacritty_terminal::index::{Column, Line};
        let mut pane = Pane::new(1, "local", "tiny", 1, 1);
        pane.enable_local();
        pane.feed(b"TOP\x1b[1;1HBOTTOM>");
        assert_eq!((pane.term.columns(), pane.term.screen_lines()), (1, 1));
        assert_eq!(pane.term.grid()[Line(0)][Column(0)].c, '>');
        pane.resize_local(80, 24);
        pane.feed("\x1b[H中⚠️X".as_bytes());
        pane.resize_local(1, 1);
        pane.feed("\x1b[2J\x1b[H中X".as_bytes());
        assert_eq!((pane.cols, pane.rows), (1, 1));
        assert_eq!((pane.term.columns(), pane.term.screen_lines()), (1, 1));
        assert_eq!(pane.term.grid()[Line(0)][Column(0)].c, 'X');
        // At this clipped margin tmux's cursor stays at column zero, so a later
        // wide scalar replaces the base instead of joining it as in a wider pane.
        for (text, expected) in [("👍🏽", '🏽'), ("👨‍👩‍👧", '👧')] {
            pane.feed(b"\x1b[2J\x1b[H");
            pane.feed(text.as_bytes());
            assert_eq!(pane.term.grid()[Line(0)][Column(0)].c, expected);
        }
        pane.feed("\x1b[H⚠️".as_bytes());
        let snapshot = pane.local_snapshot(&[]);
        let mut restored = Pane::new(2, "local", "copy", 80, 24);
        restored.keyframe(1, 1, &snapshot);
        assert_eq!((restored.term.columns(), restored.term.screen_lines()), (1, 1));
        assert_eq!(restored.term.grid()[Line(0)][Column(0)].c, '⚠');
        restored.resize_local(20, 4);
        restored.feed("\x1b[H👍🏽X".as_bytes());
        assert_eq!(restored.term.grid()[Line(0)][Column(2)].c, 'X');
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
        assert_eq!(super::osc7(b"x\x1b]7;file://mac.lan/tmp/my%20code\x07y").map(|p| p.1).as_deref(), Some("/tmp/my code"));
        assert_eq!(super::osc7(b"\x1b]7;file:///tmp\x1b\\"), Some(("file:///tmp".to_string(), "/tmp".to_string())));
        assert_eq!(super::osc7(b"plain"), None);
        assert_eq!(super::osc7_unfinished(b"ab\x1b]7;file:///t"), b"\x1b]7;file:///t");
        assert_eq!(super::osc7_unfinished(b"ab\x1b]"), b"\x1b]");
        assert_eq!(super::osc7_unfinished(b"\x1b]7;file:///tmp\x07"), b"");
    }

    #[test]
    fn predictions_show_once_an_epoch_is_confirmed() {
        // mosh's rule: typing after Enter is not shown until the far side echoes some of it — a
        // prompt that never echoes (a password) never shows what is typed.
        let mut p = super::Pane::new(1, "m", "a", 20, 5);
        p.feed(b"$ ");
        p.predict_char('l');
        assert!(p.shown_predictions().is_empty(), "nothing shown before an echo");
        p.feed(b"l");
        p.settle_predictions();
        assert!(p.epoch_confirmed);
        p.predict_char('s');
        assert_eq!(p.shown_predictions().len(), 1, "shown once this epoch echoed");
        p.predict_char('\r');
        assert!(!p.epoch_confirmed, "Enter starts a new epoch");
        p.predict_char('x');
        assert!(p.shown_predictions().is_empty());
    }

    #[test]
    fn osc133_marks_in_pieces() {
        // A prompt mark typed a byte at a time (a terminal's echo): its line marked all the same.
        let mut p = super::Pane::new(1, "m", "a", 20, 5);
        for b in b"out\r\n\x1b]133;A\x07$ ls\r\n" { p.feed(&[*b]) }
        assert_eq!(p.screen_marks.get(1).copied(), Some(crate::copy::LINE_START_PROMPT));
        assert_eq!(p.screen_marks.first().copied(), Some(0));
    }
}
