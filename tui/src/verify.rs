//! `HARNESS_TUI_VERIFY=<file>`: what hn writes to the terminal, checked frame by frame. Every byte
//! the terminal is sent is replayed into a reference terminal of the same size; after each frame
//! its cells are compared with the frame hn meant to draw. A cell that differs — text the terminal
//! would still show that hn believes gone, or hn's text landing elsewhere — is logged with the
//! frames that led to it, so a stale cell can be traced to the bytes that left it.
use std::collections::VecDeque;
use std::io::Write;
use std::sync::Mutex;

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use ratatui::buffer::Buffer;
use unicode_width::UnicodeWidthStr;

/// The bytes written since the last check; None while verifying is off.
static CAPTURE: Mutex<Option<Vec<u8>>> = Mutex::new(None);

/// Every byte the terminal is sent (term_out::Counted and the writes that bypass it).
pub fn capture(bytes: &[u8]) {
    if let Ok(mut held) = CAPTURE.lock() { if let Some(all) = held.as_mut() { all.extend_from_slice(bytes) } }
}

fn take() -> Vec<u8> { CAPTURE.lock().ok().and_then(|mut held| held.as_mut().map(std::mem::take)).unwrap_or_default() }

pub struct Verifier {
    path: std::path::PathBuf,
    screen: crate::pane::Pane,
    size: (u16, u16),
    frames: VecDeque<Vec<u8>>,
    logged: usize,
    /// The frame last drawn: what is on screen until the next one.
    last: Option<Buffer>,
}

static DUMP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
extern "C" fn on_usr2(_: libc::c_int) { DUMP.store(true, std::sync::atomic::Ordering::Relaxed) }

/// `kill -USR2 <hn>` asks for a dump of the screen as it is (with verifying on).
pub fn listen_for_dump() { unsafe { libc::signal(libc::SIGUSR2, on_usr2 as extern "C" fn(libc::c_int) as libc::sighandler_t); } }
pub fn dump_asked() -> bool { DUMP.swap(false, std::sync::atomic::Ordering::Relaxed) }

/// One cell where the terminal and hn part: where, what hn drew, what the terminal shows.
#[derive(Debug, PartialEq)]
pub struct Mismatch { pub x: u16, pub y: u16, pub drawn: String, pub shown: String }

impl Verifier {
    pub fn from_env() -> Option<Verifier> {
        let path = std::env::var("HARNESS_TUI_VERIFY").ok().filter(|p| !p.is_empty())?;
        if let Ok(mut held) = CAPTURE.lock() { *held = Some(Vec::new()) }
        Some(Verifier::new(path.into()))
    }

    fn new(path: std::path::PathBuf) -> Verifier {
        Verifier { path, screen: crate::pane::Pane::new(0, "verify", "verify", 1, 1), size: (0, 0), frames: VecDeque::new(), logged: 0, last: None }
    }

    /// The terminal was cleared outside hn's writer (a suspend and resume): start from blank.
    pub fn reset(&mut self) { self.size = (0, 0); let _ = take(); }

    /// After a frame: replay what was written, compare with [drawn], log what differs.
    pub fn check(&mut self, drawn: &Buffer) {
        let bytes = take();
        self.feed_and_compare(bytes, drawn);
        self.last = Some(drawn.clone());
    }

    /// A dump of the frame on screen now (before the next is drawn over it).
    pub fn dump_now(&mut self, reason: &str) {
        // Bytes written since the last frame (a title, a bell) first, so the reference is current.
        let pending = take();
        if !pending.is_empty() { self.screen.feed(&pending); self.frames.push_back(pending); }
        if let Some(last) = self.last.take() { self.dump(&last, reason); self.last = Some(last) }
    }

    fn feed_and_compare(&mut self, bytes: Vec<u8>, drawn: &Buffer) -> Vec<Mismatch> {
        let size = (drawn.area.width, drawn.area.height);
        // A new size: the frame that follows a resize is written whole after a clear.
        if size != self.size { self.screen = crate::pane::Pane::new(0, "verify", "verify", size.0, size.1); self.size = size; self.frames.clear() }
        self.screen.feed(&bytes);
        self.frames.push_back(bytes);
        while self.frames.len() > 8 { self.frames.pop_front(); }
        let wrong = self.compare(drawn);
        if !wrong.is_empty() && self.logged < 40 { self.logged += 1; self.log(drawn, &wrong) }
        wrong
    }

    fn compare(&self, drawn: &Buffer) -> Vec<Mismatch> {
        let grid = self.screen.term.grid();
        let mut wrong = Vec::new();
        for y in 0..drawn.area.height {
            let mut skip = 0usize;
            for x in 0..drawn.area.width {
                if skip > 0 { skip -= 1; continue }
                let cell = &drawn[(drawn.area.x + x, drawn.area.y + y)];
                let symbol = if cell.symbol().is_empty() { " " } else { cell.symbol() };
                skip = symbol.width().max(1) - 1;
                if (y as usize) >= grid.screen_lines() || (x as usize) >= grid.columns() { continue }
                let term_cell = &grid[Line(y as i32)][Column(x as usize)];
                if term_cell.flags.contains(Flags::WIDE_CHAR_SPACER) { continue }
                let mut shown = String::new();
                shown.push(if term_cell.c == '\0' { ' ' } else { term_cell.c });
                if let Some(extra) = term_cell.zerowidth() { shown.extend(extra.iter()) }
                if shown != symbol { wrong.push(Mismatch { x, y, drawn: symbol.to_string(), shown }) }
            }
        }
        wrong
    }

    /// The whole picture now — what hn drew, what the reference terminal shows, the last frames —
    /// whatever the comparison says. Written when a selection starts: people select a stale cell
    /// to clear it, so that is the moment a ghost is on screen.
    pub fn dump(&self, drawn: &Buffer, reason: &str) {
        let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.path) else { return };
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let wrong = self.compare(drawn);
        let _ = writeln!(f, "### {at} dump: {reason} · terminal {}x{} · {} cells differ", self.size.0, self.size.1, wrong.len());
        let grid = self.screen.term.grid();
        for y in 0..drawn.area.height {
            let hn: String = (0..drawn.area.width).map(|x| drawn[(drawn.area.x + x, drawn.area.y + y)].symbol().to_string()).collect();
            let term: String = (0..grid.columns()).map(|x| { let c = grid[Line(y as i32)][Column(x)].c; if c == '\0' { ' ' } else { c } }).collect();
            let _ = writeln!(f, "  row {y:>3} hn:   {hn:?}");
            if term.trim_end() != hn.trim_end() { let _ = writeln!(f, "  row {y:>3} term: {term:?}"); }
        }
        for (i, frame) in self.frames.iter().enumerate() {
            let shown: Vec<u8> = frame.iter().take(48_000).copied().collect();
            let _ = writeln!(f, "  frame -{} ({} bytes): {}", self.frames.len() - 1 - i, frame.len(), shown.escape_ascii());
        }
    }

    fn log(&self, drawn: &Buffer, wrong: &[Mismatch]) {
        let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.path) else { return };
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let _ = writeln!(f, "=== {at} terminal {}x{} · {} cells differ", self.size.0, self.size.1, wrong.len());
        for m in wrong.iter().take(40) { let _ = writeln!(f, "  ({},{}) hn drew {:?} · terminal shows {:?}", m.x, m.y, m.drawn, m.shown); }
        let grid = self.screen.term.grid();
        let rows: std::collections::BTreeSet<u16> = wrong.iter().map(|m| m.y).collect();
        for y in rows.into_iter().take(8) {
            let hn: String = (0..drawn.area.width).map(|x| drawn[(drawn.area.x + x, drawn.area.y + y)].symbol().to_string()).collect();
            let term: String = (0..grid.columns()).map(|x| { let c = grid[Line(y as i32)][Column(x)].c; if c == '\0' { ' ' } else { c } }).collect();
            let _ = writeln!(f, "  row {y} hn:   {hn:?}");
            let _ = writeln!(f, "  row {y} term: {term:?}");
        }
        for (i, frame) in self.frames.iter().enumerate() {
            let shown: Vec<u8> = frame.iter().take(24_000).copied().collect();
            let _ = writeln!(f, "  frame -{} ({} bytes): {}", self.frames.len() - 1 - i, frame.len(), shown.escape_ascii());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::Backend;
    use ratatui::buffer::Cell;
    use ratatui::layout::Rect;

    fn frame(cells: &[(u16, u16, char)]) -> Buffer {
        let mut buf = Buffer::empty(Rect::new(0, 0, 10, 2));
        for (x, y, c) in cells { buf[(*x, *y)].set_char(*c); }
        buf
    }

    fn written(prev: &Buffer, next: &Buffer) -> Vec<u8> {
        let mut out = Vec::new();
        let mut backend = crate::term_out::TmuxBackend::new(&mut out);
        backend.draw(prev.diff(next).into_iter()).unwrap();
        Backend::flush(&mut backend).unwrap();
        drop(backend);
        out
    }

    #[test]
    fn what_hn_wrote_matches_what_it_drew() {
        let mut v = Verifier::new(std::env::temp_dir().join("hn-verify-test-ok.log"));
        let blank = Buffer::empty(Rect::new(0, 0, 10, 2));
        let one = frame(&[(0, 0, 'l'), (1, 0, 's'), (0, 1, 'x')]);
        assert_eq!(v.feed_and_compare(written(&blank, &one), &one), vec![]);
        // `clear`: the cells go back to blank, and the terminal shows that too.
        assert_eq!(v.feed_and_compare(written(&one, &blank), &blank), vec![]);
    }

    #[test]
    fn a_cell_the_terminal_kept_is_found() {
        let path = std::env::temp_dir().join(format!("hn-verify-test-{}.log", std::process::id()));
        let mut v = Verifier::new(path.clone());
        let blank = Buffer::empty(Rect::new(0, 0, 10, 2));
        let one = frame(&[(3, 1, 'g')]);
        assert_eq!(v.feed_and_compare(written(&blank, &one), &one), vec![]);
        // hn draws blank but the bytes that would erase the cell never reach the terminal.
        let wrong = v.feed_and_compare(Vec::new(), &blank);
        assert_eq!(wrong, vec![Mismatch { x: 3, y: 1, drawn: " ".into(), shown: "g".into() }]);
        let log = std::fs::read_to_string(&path).unwrap();
        assert!(log.contains("(3,1) hn drew \" \" · terminal shows \"g\""), "{log}");
        let _ = std::fs::remove_file(path);
        let _ = Cell::default();
    }
}
