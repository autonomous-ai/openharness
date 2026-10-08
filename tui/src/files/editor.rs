//! The file manager's own text editor (`hn files`): a text file filling the window — its name and
//! whether it changed, line numbers, the text (tabs four wide, scrolled sideways rather than
//! wrapped), and a status row — edited as a desktop editor does: arrows (Shift selecting, Ctrl by
//! word), cut, copy and paste, undo and redo, find, go to line, and Ctrl+S saving in place
//! atomically with the file's own line endings, final newline, byte-order mark and permissions.

use std::path::{Path, PathBuf};

use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Modifier, Style};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use super::{name_of, put, Look};
use crate::keys::Chord;

/// The largest file opened here.
pub(super) const MAX_SIZE: u64 = 10 * 1000 * 1000;
const TAB: usize = 4;
/// How many changes undo goes back.
const HISTORY: usize = 200;
const BOM: &str = "\u{feff}";

/// Why a file can't be opened here, as the footer says it.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Refusal { NotText, TooLarge, Unreadable(String) }

/// Whether [bytes] (a file's first, or all of it) are text: no NUL in the first 8 KB, UTF-8 (a
/// byte-order mark allowed). [name]'s extension refuses the plainly binary ones first.
pub(super) fn is_text(name: &str, bytes: &[u8]) -> bool {
    const BINARY: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "pdf", "zip", "gz", "tgz", "xz", "bz2", "zst", "7z", "rar", "tar",
        "exe", "dll", "so", "dylib", "o", "a", "class", "jar", "wasm", "mp3", "wav", "flac", "ogg", "m4a", "mp4", "mkv", "webm", "mov", "avi", "iso", "img", "deb", "rpm", "woff", "woff2", "ttf", "otf", "sqlite", "db"];
    let ext = name.rsplit_once('.').filter(|(s, _)| !s.is_empty()).map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
    if BINARY.contains(&ext.as_str()) { return false }
    if bytes[..bytes.len().min(8192)].contains(&0) { return false }
    std::str::from_utf8(bytes.strip_prefix(BOM.as_bytes()).unwrap_or(bytes)).is_ok()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default)]
pub(super) struct Pos { pub line: usize, pub col: usize }

/// A state undo goes back to: the text, the cursor, and which version of the text it was.
#[derive(Clone, Debug)]
struct Snap { lines: Vec<String>, cur: Pos, version: u64 }

/// What a run of keys changes, for undo to take back as one: typing, deleting, or anything else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind { Type, Delete, Other }

/// What the editor's bottom row is asking for, when it is: a word to find, a line to go to.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Bar { Find(String), Line(String) }

/// What a key asks of the window: the editor closed, or text for the clipboard.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum EdOut { None, Close, Clipboard(String) }

#[derive(Debug)]
pub(super) struct Editor {
    path: PathBuf,
    title: String,
    pub(super) lines: Vec<String>,
    crlf: bool,
    bom: bool,
    newline_at_end: bool,
    pub(super) readonly: bool,
    pub(super) cur: Pos,
    /// Where the selection started: it runs from here to the cursor.
    pub(super) anchor: Option<Pos>,
    /// The column up and down keep to across shorter lines.
    want: Option<usize>,
    top: usize,
    left: usize,
    version: u64,
    next_version: u64,
    saved: u64,
    undo: Vec<Snap>,
    redo: Vec<Snap>,
    last: Option<Kind>,
    clip: String,
    bar: Option<Bar>,
    /// The last word found, lit where it is.
    find: String,
    /// "Save changes?": which of Save, Don't save and Cancel has the keys.
    pub(super) asking: Option<usize>,
    pub(super) message: Option<String>,
    size: (u16, u16),
}

impl Editor {
    /// [path] read to be edited, [title] its name as shown; why not, when it can't be.
    pub(super) fn open(path: &Path, title: String) -> Result<Editor, Refusal> {
        let meta = std::fs::metadata(path).map_err(|e| Refusal::Unreadable(e.to_string()))?;
        if !meta.is_file() { return Err(Refusal::NotText) }
        if meta.len() > MAX_SIZE { return Err(Refusal::TooLarge) }
        let bytes = std::fs::read(path).map_err(|e| Refusal::Unreadable(e.to_string()))?;
        if !is_text(&name_of(path), &bytes) { return Err(Refusal::NotText) }
        let text = String::from_utf8(bytes).map_err(|_| Refusal::NotText)?;
        let bom = text.starts_with(BOM);
        let text = text.strip_prefix(BOM).unwrap_or(&text);
        let crlf = text.find('\n').is_some_and(|i| i > 0 && text.as_bytes()[i - 1] == b'\r');
        let newline_at_end = text.ends_with('\n');
        let mut lines: Vec<String> = text.split('\n').map(|l| if crlf { l.strip_suffix('\r').unwrap_or(l).to_string() } else { l.to_string() }).collect();
        if newline_at_end { lines.pop(); }
        if lines.is_empty() { lines.push(String::new()) }
        let readonly = meta.permissions().readonly() || !writable(path);
        Ok(Editor {
            path: path.to_path_buf(), title, lines, crlf, bom, newline_at_end, readonly, cur: Pos::default(), anchor: None, want: None, top: 0, left: 0,
            version: 0, next_version: 1, saved: 0, undo: Vec::new(), redo: Vec::new(), last: None, clip: String::new(), bar: None, find: String::new(),
            asking: None, message: None, size: (80, 24),
        })
    }

    pub(super) fn modified(&self) -> bool { self.version != self.saved }

    /// The file's text as it would be saved.
    pub(super) fn text(&self) -> String {
        let mut out = String::from(if self.bom { BOM } else { "" });
        out.push_str(&self.lines.join(if self.crlf { "\r\n" } else { "\n" }));
        if self.newline_at_end { out.push_str(if self.crlf { "\r\n" } else { "\n" }) }
        out
    }

    /// Ctrl+S: written beside the file and renamed over it (never half written), its permissions
    /// kept. What went wrong, if it did.
    pub(super) fn save(&mut self) -> Result<(), String> {
        use std::io::Write;
        if self.readonly { return Err("read-only: this file can't be saved here".into()) }
        let dir = self.path.parent().unwrap_or(Path::new("/"));
        let tmp = dir.join(format!(".{}.hn-save-{}", name_of(&self.path), std::process::id()));
        let perms = std::fs::metadata(&self.path).map(|m| m.permissions()).ok();
        let write = || -> std::io::Result<()> {
            let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
            f.write_all(self.text().as_bytes())?;
            f.sync_all()?;
            if let Some(p) = perms.clone() { std::fs::set_permissions(&tmp, p)? }
            std::fs::rename(&tmp, &self.path)
        };
        match write() {
            Ok(()) => { self.saved = self.version; Ok(()) }
            Err(e) => { let _ = std::fs::remove_file(&tmp); Err(format!("Couldn't save: {e}")) }
        }
    }

    // ── positions ────────────────────────────────────────────────────────────

    fn line(&self) -> &str { &self.lines[self.cur.line] }

    /// The selection, start first, when there is one.
    pub(super) fn selection(&self) -> Option<(Pos, Pos)> { self.anchor.filter(|a| *a != self.cur).map(|a| (a.min(self.cur), a.max(self.cur))) }

    fn selected_text(&self) -> Option<String> {
        let (a, b) = self.selection()?;
        if a.line == b.line { return Some(self.lines[a.line][a.col..b.col].to_string()) }
        let mut out = self.lines[a.line][a.col..].to_string();
        for l in &self.lines[a.line + 1..b.line] { out.push('\n'); out.push_str(l) }
        out.push('\n');
        out.push_str(&self.lines[b.line][..b.col]);
        Some(out)
    }

    /// A move: the selection grown with [extend] (Shift), else gone; an edit run ended.
    fn go(&mut self, to: Pos, extend: bool, keep_want: bool) {
        if extend { if self.anchor.is_none() { self.anchor = Some(self.cur) } } else { self.anchor = None }
        self.cur = to;
        if !keep_want { self.want = None }
        self.last = None;
    }

    fn left_of(&self, p: Pos) -> Pos {
        if p.col > 0 { return Pos { line: p.line, col: prev(&self.lines[p.line], p.col) } }
        if p.line > 0 { return Pos { line: p.line - 1, col: self.lines[p.line - 1].len() } }
        p
    }

    fn right_of(&self, p: Pos) -> Pos {
        let l = &self.lines[p.line];
        if p.col < l.len() { return Pos { line: p.line, col: next(l, p.col) } }
        if p.line + 1 < self.lines.len() { return Pos { line: p.line + 1, col: 0 } }
        p
    }

    /// Ctrl+Left / Ctrl+Right: to the start of this word or the last, the end of this one or the next.
    fn word(&self, p: Pos, forward: bool) -> Pos {
        let l = &self.lines[p.line];
        let gs: Vec<(usize, &str)> = l.grapheme_indices(true).collect();
        let is_word = |g: &str| g.chars().next().is_some_and(|c| c.is_alphanumeric() || c == '_');
        let mut i = gs.iter().position(|(b, _)| *b >= p.col).unwrap_or(gs.len());
        if forward {
            if i >= gs.len() { return self.right_of(p) }
            while i < gs.len() && !is_word(gs[i].1) { i += 1 }
            while i < gs.len() && is_word(gs[i].1) { i += 1 }
            Pos { line: p.line, col: gs.get(i).map(|g| g.0).unwrap_or(l.len()) }
        } else {
            if i == 0 { return self.left_of(p) }
            while i > 0 && !is_word(gs[i - 1].1) { i -= 1 }
            while i > 0 && is_word(gs[i - 1].1) { i -= 1 }
            Pos { line: p.line, col: gs.get(i).map(|g| g.0).unwrap_or(0) }
        }
    }

    /// Up or down [n] lines, at the column it was at.
    fn vertical(&mut self, n: isize, extend: bool) {
        let want = self.want.unwrap_or_else(|| col_of(self.line(), self.cur.col));
        let line = (self.cur.line as isize + n).clamp(0, self.lines.len() as isize - 1) as usize;
        let col = byte_at(&self.lines[line], want);
        self.go(Pos { line, col }, extend, true);
        self.want = Some(want);
    }

    // ── changes ──────────────────────────────────────────────────────────────

    /// Before a change of [kind]: the state kept for undo, unless it continues a run of the same.
    fn change(&mut self, kind: Kind) {
        if self.last != Some(kind) || kind == Kind::Other {
            self.undo.push(Snap { lines: self.lines.clone(), cur: self.cur, version: self.version });
            if self.undo.len() > HISTORY { self.undo.remove(0); }
        }
        self.redo.clear();
        self.last = Some(kind);
        self.version = self.next_version;
        self.next_version += 1;
        self.want = None;
    }

    fn remove(&mut self, a: Pos, b: Pos) {
        if a.line == b.line { self.lines[a.line].replace_range(a.col..b.col, ""); } else {
            let tail = self.lines[b.line][b.col..].to_string();
            self.lines[a.line].truncate(a.col);
            self.lines[a.line].push_str(&tail);
            self.lines.drain(a.line + 1..=b.line);
        }
        self.cur = a;
        self.anchor = None;
    }

    fn delete_selection(&mut self) -> bool {
        let Some((a, b)) = self.selection() else { self.anchor = None; return false };
        self.remove(a, b);
        true
    }

    fn insert(&mut self, text: &str) {
        let tail = self.lines[self.cur.line].split_off(self.cur.col);
        let mut parts = text.split('\n');
        self.lines[self.cur.line].push_str(parts.next().unwrap_or(""));
        let mut at = self.cur.line;
        for p in parts { at += 1; self.lines.insert(at, p.to_string()); }
        self.cur = Pos { line: at, col: self.lines[at].len() };
        self.lines[at].push_str(&tail);
    }

    /// [text] typed (or pasted) in place of the selection.
    fn type_text(&mut self, text: &str, kind: Kind) {
        if self.refuse() { return }
        let kind = if self.selection().is_some() { Kind::Other } else { kind };
        self.change(kind);
        self.delete_selection();
        self.insert(text);
    }

    fn refuse(&mut self) -> bool {
        if self.readonly { self.message = Some("read-only: this file can't be changed here".into()) }
        self.readonly
    }

    /// Backspace ([back]) or Delete: the selection, else the character before or after.
    fn delete(&mut self, back: bool) {
        if self.refuse() { return }
        if self.selection().is_some() { self.change(Kind::Other); self.delete_selection(); return }
        let (a, b) = if back { (self.left_of(self.cur), self.cur) } else { (self.cur, self.right_of(self.cur)) };
        if a == b { return }
        self.change(Kind::Delete);
        self.remove(a, b);
    }

    fn undo_redo(&mut self, back: bool) {
        let (from, to) = if back { (&mut self.undo, &mut self.redo) } else { (&mut self.redo, &mut self.undo) };
        let Some(s) = from.pop() else { return };
        to.push(Snap { lines: std::mem::replace(&mut self.lines, s.lines), cur: self.cur, version: self.version });
        self.cur = s.cur;
        self.version = s.version;
        self.anchor = None;
        self.last = None;
        self.cur.line = self.cur.line.min(self.lines.len() - 1);
        self.cur.col = self.cur.col.min(self.lines[self.cur.line].len());
    }

    // ── find ─────────────────────────────────────────────────────────────────

    /// The next (else the last) place [find] is, from the cursor round; selected.
    fn find_next(&mut self, forward: bool) {
        if self.find.is_empty() { return }
        let n = self.lines.len();
        let start = self.selection().map(|(a, b)| if forward { b } else { a }).unwrap_or(self.cur);
        for k in 0..=n {
            let line = if forward { (start.line + k) % n } else { (start.line + n * 2 - k) % n };
            let l = &self.lines[line];
            let hit = if forward {
                let from = if k == 0 { start.col } else { 0 };
                l.get(from..).and_then(|s| s.find(&self.find)).map(|i| i + from)
            } else {
                let to = if k == 0 { start.col } else { l.len() };
                l.get(..to).and_then(|s| s.rfind(&self.find))
            };
            if let Some(i) = hit {
                self.anchor = Some(Pos { line, col: i });
                self.cur = Pos { line, col: i + self.find.len() };
                self.message = None;
                return;
            }
        }
        self.message = Some(format!("'{}' isn't in this file", self.find));
    }

    // ── keys and the mouse ───────────────────────────────────────────────────

    pub(super) fn key(&mut self, k: Chord) -> EdOut {
        self.message = None;
        if self.asking.is_some() { return self.ask_key(k) }
        if self.bar.is_some() { self.bar_key(k); self.fit(); return EdOut::None }
        let (shift, ctrl) = (k.mods.contains(KeyModifiers::SHIFT), k.mods.contains(KeyModifiers::CONTROL));
        let ctrl_is = |c: char| ctrl && matches!(k.code, KeyCode::Char(x) if x.eq_ignore_ascii_case(&c));
        let page = self.size.1.saturating_sub(3).max(1) as isize;
        let mut out = EdOut::None;
        match k.code {
            KeyCode::Esc => return self.close(),
            _ if ctrl_is('q') || ctrl_is('w') => return self.close(),
            _ if ctrl_is('s') => { self.message = Some(match self.save() { Ok(()) => format!("Saved {}", self.title), Err(e) => e }) }
            _ if ctrl_is('z') && shift => self.undo_redo(false),
            _ if ctrl_is('z') => self.undo_redo(true),
            _ if ctrl_is('y') => self.undo_redo(false),
            _ if ctrl_is('a') => { self.anchor = Some(Pos::default()); let l = self.lines.len() - 1; self.cur = Pos { line: l, col: self.lines[l].len() } }
            _ if ctrl_is('c') || ctrl_is('x') => {
                if let Some(t) = self.selected_text() {
                    self.clip = t.clone();
                    if ctrl_is('x') && !self.refuse() { self.change(Kind::Other); self.delete_selection(); }
                    out = EdOut::Clipboard(t);
                }
            }
            _ if ctrl_is('v') => { if !self.clip.is_empty() { let t = self.clip.clone(); self.type_text(&t, Kind::Other) } }
            _ if ctrl_is('f') => self.bar = Some(Bar::Find(self.selected_text().filter(|t| !t.contains('\n')).unwrap_or_else(|| self.find.clone()))),
            _ if ctrl_is('g') => self.bar = Some(Bar::Line(String::new())),
            KeyCode::F(3) => self.find_next(!shift),
            KeyCode::Left if ctrl => { let p = self.word(self.cur, false); self.go(p, shift, false) }
            KeyCode::Right if ctrl => { let p = self.word(self.cur, true); self.go(p, shift, false) }
            KeyCode::Left => { let p = match self.selection() { Some((a, _)) if !shift => a, _ => self.left_of(self.cur) }; self.go(p, shift, false) }
            KeyCode::Right => { let p = match self.selection() { Some((_, b)) if !shift => b, _ => self.right_of(self.cur) }; self.go(p, shift, false) }
            KeyCode::Up => self.vertical(-1, shift),
            KeyCode::Down => self.vertical(1, shift),
            KeyCode::PageUp => self.vertical(-page, shift),
            KeyCode::PageDown => self.vertical(page, shift),
            KeyCode::Home if ctrl => self.go(Pos::default(), shift, false),
            KeyCode::End if ctrl => { let l = self.lines.len() - 1; self.go(Pos { line: l, col: self.lines[l].len() }, shift, false) }
            KeyCode::Home => {
                // To the line's first non-blank, then (again) its very start.
                let indent = self.line().len() - self.line().trim_start().len();
                let col = if self.cur.col == indent { 0 } else { indent };
                self.go(Pos { line: self.cur.line, col }, shift, false)
            }
            KeyCode::End => self.go(Pos { line: self.cur.line, col: self.line().len() }, shift, false),
            KeyCode::Enter => {
                // A new line indented as this one is.
                let indent: String = self.line().chars().take_while(|c| *c == ' ' || *c == '\t').collect();
                self.type_text(&format!("\n{indent}"), Kind::Other)
            }
            KeyCode::Backspace => self.delete(true),
            KeyCode::Delete => self.delete(false),
            KeyCode::Tab => self.type_text("\t", Kind::Type),
            KeyCode::Char(c) if !k.mods.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) => {
                // (hn spells a capital as its letter with S-.)
                let c = if shift { c.to_uppercase().next().unwrap_or(c) } else { c };
                self.type_text(&c.to_string(), if c == ' ' { Kind::Other } else { Kind::Type })
            }
            _ => {}
        }
        self.fit();
        out
    }

    /// Esc, Ctrl+Q, Ctrl+W: closed — after asking, when there are changes to lose.
    fn close(&mut self) -> EdOut {
        if self.modified() { self.asking = Some(2); EdOut::None } else { EdOut::Close }
    }

    /// The "Save changes?" buttons, in the order shown, the one with the keys chosen.
    fn ask_row(&self) -> crate::buttons::Row {
        let button = |label: &str| crate::buttons::Button { label: label.into(), key: None };
        crate::buttons::Row { buttons: vec![button("Don't save"), button("Cancel"), button("Save")], chosen: self.asking.unwrap_or(2), hint: crate::buttons::KEYS.into() }
    }

    /// The "Save changes?" question's keys: Left/Right/Tab between its buttons, Enter, Esc cancels.
    fn ask_key(&mut self, k: Chord) -> EdOut {
        use crate::buttons::Answer;
        let mut row = self.ask_row();
        match row.key(k.code, k.mods) {
            Answer::Moved => self.asking = Some(row.chosen),
            Answer::Chosen(i) => return self.answer(i),
            Answer::Cancel => self.asking = None,
            Answer::Ignored => {}
        }
        EdOut::None
    }

    /// Don't save (0), Cancel (1) or Save (2).
    fn answer(&mut self, button: usize) -> EdOut {
        self.asking = None;
        match button {
            0 => EdOut::Close,
            1 => EdOut::None,
            _ => match self.save() { Ok(()) => EdOut::Close, Err(e) => { self.message = Some(e); EdOut::None } },
        }
    }

    /// The find bar's and go-to-line's keys: typed into, Enter (F3) the next, Shift+F3 the last, Esc closed.
    fn bar_key(&mut self, k: Chord) {
        let shift = k.mods.contains(KeyModifiers::SHIFT);
        let Some(bar) = self.bar.as_mut() else { return };
        let text = match bar { Bar::Find(t) | Bar::Line(t) => t };
        match k.code {
            KeyCode::Esc => { self.bar = None; self.find.clear() }
            KeyCode::Backspace => { text.pop(); }
            KeyCode::Char(c) if !k.mods.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => text.push(if shift { c.to_uppercase().next().unwrap_or(c) } else { c }),
            KeyCode::Enter | KeyCode::F(3) => match bar.clone() {
                Bar::Find(t) => { self.find = t; self.find_next(!(shift && k.code == KeyCode::F(3))) }
                Bar::Line(t) => {
                    self.bar = None;
                    match t.trim().parse::<usize>() {
                        Ok(n) if n >= 1 => { let line = (n - 1).min(self.lines.len() - 1); self.go(Pos { line, col: 0 }, false, false) }
                        _ => self.message = Some("Go to line: a line number".into()),
                    }
                }
            },
            _ => {}
        }
        if let Some(Bar::Find(t)) = &self.bar { self.find = t.clone() }
    }

    /// The text's area: the rows between the title and the status, right of the line numbers.
    fn text_area(&self) -> (u16, Rect) {
        let gutter = self.lines.len().to_string().len().max(3) as u16 + 2;
        (gutter, Rect::new(gutter, 1, self.size.0.saturating_sub(gutter), self.size.1.saturating_sub(2)))
    }

    /// A click (or a drag, [drag]) at (x, y): the cursor there; a drag selects from where it went down.
    pub(super) fn click(&mut self, x: u16, y: u16, drag: bool) {
        if let Some(focus) = self.asking {
            let (_, row) = self.ask_layout();
            if let Some(b) = self.ask_row().click(row, Position::new(x, y)) { let _ = self.answer(b); } else { self.asking = Some(focus) }
            return;
        }
        let (_, r) = self.text_area();
        if y < r.y || y >= r.y + r.height { return }
        let line = (self.top + (y - r.y) as usize).min(self.lines.len() - 1);
        let col = byte_at(&self.lines[line], (x.saturating_sub(r.x) as usize) + self.left);
        let p = Pos { line, col };
        if drag { if self.anchor.is_none() { self.anchor = Some(self.cur) } self.cur = p } else { self.anchor = Some(p); self.cur = p }
        self.want = None;
        self.last = None;
        self.fit();
    }

    pub(super) fn wheel(&mut self, down: bool) {
        let max = self.lines.len().saturating_sub(1);
        self.top = if down { (self.top + 3).min(max) } else { self.top.saturating_sub(3) };
    }

    /// The cursor kept on screen.
    fn fit(&mut self) {
        let (_, r) = self.text_area();
        let (rows, cols) = (r.height.max(1) as usize, r.width.max(1) as usize);
        if self.cur.line < self.top { self.top = self.cur.line } else if self.cur.line >= self.top + rows { self.top = self.cur.line + 1 - rows }
        let x = col_of(self.line(), self.cur.col);
        if x < self.left { self.left = x } else if x >= self.left + cols { self.left = x + 1 - cols }
    }

    // ── drawing ──────────────────────────────────────────────────────────────

    pub(super) fn draw(&mut self, buf: &mut Buffer, area: Rect, look: &Look) {
        let resized = self.size != (area.width, area.height);
        self.size = (area.width, area.height);
        if resized { self.fit() }
        for y in area.top()..area.bottom() { for x in area.left()..area.right() { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } } }
        let (ox, oy, w) = (area.x, area.y, area.width);
        // The title: the file, ● when it has changes, read-only when it can't have any.
        let mut x = ox + 1 + put(buf, ox + 1, oy, w.saturating_sub(2), &self.title, look.text.add_modifier(Modifier::BOLD));
        if self.modified() { put(buf, x + 1, oy, 2, "●", look.accent); x += 2 }
        if self.readonly { put(buf, x + 1, oy, w.saturating_sub(x + 1), "read-only", look.warn); }
        let (gutter, r) = self.text_area();
        let sel = self.selection();
        for row in 0..r.height {
            let i = self.top + row as usize;
            let y = oy + r.y + row;
            let Some(line) = self.lines.get(i) else { break };
            let num = format!("{:>w$} ", i + 1, w = gutter as usize - 2);
            put(buf, ox, y, gutter, &num, if i == self.cur.line { look.text } else { look.muted });
            // Where the word found is on this line, to light.
            let hits: Vec<(usize, usize)> = if self.find.is_empty() { Vec::new() } else { line.match_indices(&self.find).map(|(b, s)| (b, b + s.len())).collect() };
            let mut col = 0;
            for (b, g) in line.grapheme_indices(true) {
                let gw = width(g, col);
                let (start, end) = (col, col + gw);
                col = end;
                if end <= self.left { continue }
                if start >= self.left + r.width as usize { break }
                let selected = sel.is_some_and(|(a, z)| Pos { line: i, col: b } >= a && Pos { line: i, col: b } < z);
                let st = if selected { look.mode } else if hits.iter().any(|(a, z)| b >= *a && b < *z) { look.text.add_modifier(Modifier::REVERSED) } else { look.text };
                let sx = ox + r.x + start.saturating_sub(self.left) as u16;
                let shown = if g == "\t" || start < self.left { " ".repeat(end - start.max(self.left)) } else { g.to_string() };
                if g == "\t" || start < self.left {
                    put(buf, sx, y, (end - start.max(self.left)) as u16, &shown, st);
                } else if let Some(c) = buf.cell_mut((sx, y)) { c.set_symbol(&shown).set_style(st); }
            }
            // (A selected line break: one cell of it after the text.)
            if sel.is_some_and(|(a, z)| a.line <= i && i < z.line) && col >= self.left && col < self.left + r.width as usize
                && let Some(c) = buf.cell_mut((ox + r.x + (col - self.left) as u16, y)) { c.set_style(look.mode); }
        }
        // The cursor: its cell reversed.
        let cx = col_of(self.line(), self.cur.col);
        if self.cur.line >= self.top && self.cur.line < self.top + r.height as usize && cx >= self.left && cx < self.left + r.width as usize && self.asking.is_none() && self.bar.is_none()
            && let Some(c) = buf.cell_mut((ox + r.x + (cx - self.left) as u16, oy + r.y + (self.cur.line - self.top) as u16)) { c.set_style(Style::default().add_modifier(Modifier::REVERSED)); }
        // The status row: a bar's question, a message, else where the cursor is and the keys.
        let sy = oy + area.height.saturating_sub(1);
        let status = match &self.bar {
            Some(Bar::Find(t)) => format!("Find: {t}▏   Enter next · Shift+F3 previous · Esc close"),
            Some(Bar::Line(t)) => format!("Go to line: {t}▏   Enter go · Esc cancel"),
            None => self.message.clone().unwrap_or_else(|| format!(
                "Ln {}, Col {} · {} lines · UTF-8{} · {}   Ctrl+S save · Ctrl+F find · Ctrl+G line · Ctrl+Z undo · Esc close",
                self.cur.line + 1, cx + 1, self.lines.len(), if self.bom { " BOM" } else { "" }, if self.crlf { "CRLF" } else { "LF" })),
        };
        let st = if self.message.is_some() && self.bar.is_none() { look.accent } else { look.muted };
        put(buf, ox + 1, sy, w.saturating_sub(2), &super::fit(&status, w.saturating_sub(2) as usize), st);
        if self.asking.is_some() {
            let (row, c) = (self.ask_row(), crate::settings::chrome());
            let (r, d) = self.ask_dialog(&row, &c, look.border);
            d.render_over(area, Rect::new(ox + r.x, oy + r.y, r.width, r.height).intersection(area), buf);
        }
    }

    /// "Save changes?" as the shared dialog, in the middle of the editor: its question wrapped to
    /// the editor, in the border lines [border] says.
    fn ask_dialog<'a>(&self, row: &'a crate::buttons::Row, c: &'a crate::settings::Chrome, border: ratatui::symbols::border::Set<'a>) -> (Rect, crate::dialog::Dialog<'a>) {
        let name = name_of(&self.path);
        let question = crate::dialog::wrap(&format!("Save changes to '{name}'?"), self.size.0.saturating_sub(4).clamp(1, 60), c.base);
        let mut d = crate::dialog::Dialog::new(&format!("Save Changes · {}", super::fit(&name, 30)), question, row, c);
        d.border = border;
        d.fit(self.size.1);
        (d.place(Rect::new(0, 0, self.size.0, self.size.1)), d)
    }

    /// The "Save changes?" box and its buttons' row (for drawing and clicks alike).
    fn ask_layout(&self) -> (Rect, Rect) {
        let (row, c) = (self.ask_row(), crate::settings::chrome());
        let (r, d) = self.ask_dialog(&row, &c, ratatui::symbols::border::PLAIN);
        (r, d.areas(r).row)
    }
}

/// Whether this process may write [path] (access(2), as the file's permissions and owner say).
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
    // SAFETY: a valid C string, only read.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

/// A grapheme's columns at column [col]: a tab to the next stop.
fn width(g: &str, col: usize) -> usize { if g == "\t" { TAB - col % TAB } else { g.width() } }

/// The column byte [byte] of [line] is drawn at.
pub(super) fn col_of(line: &str, byte: usize) -> usize {
    let mut col = 0;
    for (b, g) in line.grapheme_indices(true) { if b >= byte { break } col += width(g, col) }
    col
}

/// The byte of [line] at column [col] (the start of what covers it; past the end, the end).
fn byte_at(line: &str, col: usize) -> usize {
    let mut c = 0;
    for (b, g) in line.grapheme_indices(true) {
        let w = width(g, c);
        if c + w > col { return b }
        c += w;
    }
    line.len()
}

fn prev(line: &str, byte: usize) -> usize { line[..byte].grapheme_indices(true).next_back().map(|(b, _)| b).unwrap_or(0) }
fn next(line: &str, byte: usize) -> usize { line[byte..].graphemes(true).next().map(|g| byte + g.len()).unwrap_or(byte) }

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str, bytes: &[u8]) -> (PathBuf, PathBuf) {
        let d = std::env::temp_dir().join(format!("hn-editor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(name), bytes).unwrap();
        (d.join(name), d)
    }
    fn k(code: KeyCode) -> Chord { Chord::normal(code, KeyModifiers::NONE) }
    fn ctrl(c: char) -> Chord { Chord::normal(KeyCode::Char(c), KeyModifiers::CONTROL) }
    fn typing(e: &mut Editor, s: &str) { for c in s.chars() { e.key(if c == '\n' { k(KeyCode::Enter) } else { k(KeyCode::Char(c)) }); } }

    #[test]
    fn text_is_told_from_what_is_not() {
        assert!(is_text("a.txt", b"hello\n") && is_text("a.py", b"print(1)\n") && is_text("a.md", "# Tiêu đề\n".as_bytes()));
        assert!(is_text("bom.txt", b"\xef\xbb\xbfhi"));
        assert!(!is_text("a.png", b"looks like text"));
        assert!(!is_text("a.bin", b"ab\0cd") && !is_text("a.txt", b"\xff\xfe\x00"));
        assert!(!is_text("latin1.txt", b"caf\xe9"));
        let (p, d) = scratch("big.txt", &vec![b'a'; MAX_SIZE as usize + 1]);
        assert_eq!(Editor::open(&p, "big.txt".into()).err(), Some(Refusal::TooLarge));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn typing_deleting_new_lines_and_undo_redo() {
        let (p, d) = scratch("a.txt", b"    one\ntwo\n");
        let mut e = Editor::open(&p, "a.txt".into()).unwrap();
        e.key(k(KeyCode::End));
        typing(&mut e, "!\nx");
        assert_eq!(e.lines, ["    one!", "    x", "two"], "a new line keeps the indent");
        e.key(k(KeyCode::Backspace));
        e.key(k(KeyCode::Backspace));
        assert_eq!(e.lines[1], "   ");
        assert!(e.modified());
        e.key(ctrl('z'));
        assert_eq!(e.lines[1], "    x", "the deletions undone as one");
        e.key(ctrl('z'));
        e.key(ctrl('z'));
        e.key(ctrl('z'));
        assert_eq!(e.lines, ["    one", "two"]);
        assert!(!e.modified(), "back where it was saved");
        e.key(ctrl('y'));
        assert_eq!(e.lines, ["    one!", "two"]);
        // Delete at a line's end joins the next.
        e.key(k(KeyCode::Delete));
        assert_eq!(e.lines, ["    one!two"]);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn selection_copy_paste_and_wide_characters_keep_their_columns() {
        let (p, d) = scratch("v.txt", "Tiếng Việt\n日本語\tx\n".as_bytes());
        let mut e = Editor::open(&p, "v.txt".into()).unwrap();
        for _ in 0..5 { e.key(Chord::normal(KeyCode::Right, KeyModifiers::SHIFT)); }
        assert_eq!(e.key(ctrl('c')), EdOut::Clipboard("Tiếng".into()));
        e.key(k(KeyCode::Down));
        assert_eq!(col_of(&e.lines[1], e.cur.col), 4, "column 5 is inside 語: before it");
        e.key(k(KeyCode::Right));
        assert_eq!(col_of(&e.lines[1], e.cur.col), 6, "after 日本語, three of two columns");
        assert_eq!(col_of(&e.lines[1], e.lines[1].len()), 9, "the tab to column 8, then x");
        e.key(ctrl('v'));
        assert_eq!(e.lines[1], "日本語Tiếng\tx");
        // Ctrl+Left goes back a word.
        e.key(Chord::normal(KeyCode::Left, KeyModifiers::CONTROL));
        assert_eq!(e.cur.col, 0);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn saving_keeps_crlf_the_bom_no_final_newline_and_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (p, d) = scratch("w.txt", b"\xef\xbb\xbfa\r\nb");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o640)).unwrap();
        let mut e = Editor::open(&p, "w.txt".into()).unwrap();
        e.key(Chord::normal(KeyCode::End, KeyModifiers::CONTROL));
        typing(&mut e, "c");
        e.key(ctrl('s'));
        assert_eq!(std::fs::read(&p).unwrap(), b"\xef\xbb\xbfa\r\nbc");
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o640);
        assert!(!e.modified() && e.message.as_deref() == Some("Saved w.txt"));
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "no temporary file left");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn find_lights_and_goes_to_each_place_round() {
        let (p, d) = scratch("f.txt", b"cat\ndog cat\ncat\n");
        let mut e = Editor::open(&p, "f.txt".into()).unwrap();
        e.key(ctrl('f'));
        typing(&mut e, "cat");
        e.key(k(KeyCode::Enter));
        assert_eq!(e.selection(), Some((Pos { line: 0, col: 0 }, Pos { line: 0, col: 3 })));
        e.key(k(KeyCode::Enter));
        assert_eq!(e.cur, Pos { line: 1, col: 7 });
        e.key(Chord::normal(KeyCode::F(3), KeyModifiers::SHIFT));
        assert_eq!(e.cur, Pos { line: 0, col: 3 });
        e.key(k(KeyCode::Esc));
        assert!(e.bar.is_none());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn closing_with_changes_asks_first() {
        let (p, d) = scratch("c.txt", b"x\n");
        let mut e = Editor::open(&p, "c.txt".into()).unwrap();
        assert_eq!(e.key(k(KeyCode::Esc)), EdOut::Close, "nothing changed: closed at once");
        typing(&mut e, "y");
        assert_eq!(e.key(k(KeyCode::Esc)), EdOut::None);
        assert_eq!(e.asking, Some(2), "Save is chosen");
        e.key(k(KeyCode::Left));
        assert_eq!(e.asking, Some(1));
        assert_eq!(e.key(k(KeyCode::Enter)), EdOut::None, "Cancel: still editing");
        assert!(e.asking.is_none() && e.modified());
        e.key(ctrl('q'));
        assert_eq!(e.key(k(KeyCode::Enter)), EdOut::Close, "Save, then closed");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "yx\n");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn save_changes_is_one_row_dont_save_cancel_save_with_the_chosen_one_lifted() {
        let (p, d) = scratch("b.txt", b"x\n");
        let mut e = Editor::open(&p, "b.txt".into()).unwrap();
        typing(&mut e, "y");
        e.key(k(KeyCode::Esc));
        let (_, row) = e.ask_layout();
        let buttons = e.ask_row().areas(row);
        let by = row.y;
        let area = Rect::new(0, 0, 80, 24);
        let screen = |e: &mut Editor| { let mut buf = Buffer::empty(area); e.draw(&mut buf, area, &Look::default()); buf };
        let shown = screen(&mut e);
        let words: Vec<String> = buttons.iter().map(|b| (b.x..b.right()).map(|x| shown[(x, by)].symbol()).collect()).collect();
        assert_eq!(words, ["[ Don't save ]", "[ Cancel ]", "[ Save ]"]);
        // The shared dialog: its title in the top rule, the question inside, the panel's surface.
        let (r, _) = e.ask_layout();
        let line = |y: u16| (r.x..r.right()).map(|x| shown[(x, y)].symbol()).collect::<String>();
        assert!(line(r.y).starts_with("┌─Save Changes · b.txt") && line(r.y + 1).starts_with("│ Save changes to 'b.txt'?"), "{}\n{}", line(r.y), line(r.y + 1));
        assert_eq!(shown[(r.x + 1, r.y + 1)].bg, crate::settings::chrome().base.bg.unwrap_or(ratatui::style::Color::Reset));
        let bg = |e: &mut Editor, b: usize| screen(e)[(buttons[b].x + 2, by)].bg;
        if !crate::theme::no_color() {
            let c = crate::settings::chrome();
            assert_eq!(bg(&mut e, 2), c.selected.bg.unwrap());
            assert_ne!(bg(&mut e, 0), c.selected.bg.unwrap());
            e.key(k(KeyCode::Left)); e.key(k(KeyCode::Left));
            assert_eq!(bg(&mut e, 0), c.selected.bg.unwrap());
        }
        // Esc (and C-c) leave the editor open on the text; Don't save closes it unsaved.
        e.key(k(KeyCode::Esc));
        assert!(e.asking.is_none() && e.modified());
        e.key(ctrl('q'));
        assert_eq!(e.key(ctrl('c')), EdOut::None);
        assert!(e.asking.is_none());
        e.key(ctrl('q')); e.key(k(KeyCode::Left)); e.key(k(KeyCode::Left));
        assert_eq!(e.key(k(KeyCode::Enter)), EdOut::Close);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "x\n");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn save_changes_follows_the_border_lines_and_wraps_to_a_narrow_editor() {
        let (p, d) = scratch("a-very-long-file-name-for-a-narrow-editor.txt", b"x\n");
        let mut e = Editor::open(&p, "a-very-long-file-name-for-a-narrow-editor.txt".into()).unwrap();
        typing(&mut e, "y");
        e.key(k(KeyCode::Esc));
        let mut look = Look::default();
        look.border = crate::ui::dialog_border("heavy");
        e.size = (36, 12);
        let area = Rect::new(0, 0, 36, 12);
        let mut buf = Buffer::empty(area);
        e.draw(&mut buf, area, &look);
        let text: String = (0..12).map(|y| (0..36).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>() + "\n").collect();
        assert!(text.contains("┏━Save Changes") && text.contains("┗"), "{text}");
        for word in ["Save changes to", "txt'?"] { assert!(text.contains(word), "{word} lost:\n{text}") }
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_read_only_file_is_shown_not_changed() {
        use std::os::unix::fs::PermissionsExt;
        let (p, d) = scratch("r.txt", b"keep\n");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o444)).unwrap();
        let mut e = Editor::open(&p, "r.txt".into()).unwrap();
        assert!(e.readonly);
        typing(&mut e, "z");
        assert_eq!(e.lines, ["keep"]);
        assert!(e.message.as_deref().is_some_and(|m| m.starts_with("read-only")));
        let area = Rect::new(0, 0, 60, 10);
        let mut buf = Buffer::empty(area);
        e.draw(&mut buf, area, &Look::default());
        let top: String = (0..60).map(|x| buf[(x, 0)].symbol().to_string()).collect();
        assert!(top.contains("r.txt") && top.contains("read-only"), "{top}");
        let _ = std::fs::remove_dir_all(d);
    }
}
