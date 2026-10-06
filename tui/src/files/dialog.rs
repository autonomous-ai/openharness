//! `hn files --open` (Harness OS's Super+O): an Open dialog as the Mac's Open panel is — a box
//! with its toolbar (back and forward, Columns or Icons, the folder's path popup, Search), a
//! sidebar of places (Favorites, Recent, Locations), the folders as Miller columns with a preview
//! of the file selected, and Cancel and Open. What it opens it hands on: a folder to an explorer
//! of its own (`--root`), a text file to the editor (`--edit`); then it ends.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use unicode_width::UnicodeWidthStr;

use super::{art, editor, file_style, fit, frame, home, icon, list, name_of, ops, put, shorten, tile, Entry, Look, TILE_H, TILE_W};
use crate::keys::Chord;

/// The sidebar's width, and a column's (its separator in it).
const SIDE_W: u16 = 22;
const COL_W: u16 = 30;
/// How many places Recent lists, and how many it keeps.
const RECENT_SHOWN: usize = 5;
const RECENT_KEPT: usize = 20;

/// A column: a folder's entries (those the search leaves, in the deepest one), the one selected
/// and the first shown.
#[derive(Clone, Debug)]
struct Col { dir: PathBuf, entries: Vec<Entry>, error: Option<String>, rows: Vec<usize>, sel: Option<usize>, scroll: usize }

impl Col {
    fn new(dir: PathBuf) -> Col {
        let l = list(&dir, false, false);
        let rows = (0..l.entries.len()).collect();
        Col { dir, entries: l.entries, error: l.error, rows, sel: None, scroll: 0 }
    }
    /// Its rows: the entries whose names have [q] in them, whatever the case.
    fn filter(&mut self, q: &str) {
        let q = q.to_lowercase();
        self.rows = (0..self.entries.len()).filter(|i| q.is_empty() || self.entries[*i].name.to_lowercase().contains(&q)).collect();
    }
    fn selected(&self) -> Option<&Entry> { self.sel.and_then(|i| self.entries.get(i)) }
    /// The selected entry's place among the rows.
    fn at(&self) -> Option<usize> { self.sel.and_then(|s| self.rows.iter().position(|r| *r == s)) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DView { Columns, Icons }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Focus { Sidebar, Columns, Buttons, Search }

/// A place in the sidebar: its section, words, icon and path.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Place { section: usize, label: String, icon: &'static str, path: PathBuf }

const SECTIONS: [&str; 3] = ["Favorites", "Recent", "Locations"];

/// The toolbar's parts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tool { Back, Forward, Columns, Icons, Path, Search }

/// What the dialog asks of the program: nothing yet, to end, or to open what was chosen.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum DOut { None, Cancel, Open(PathBuf, bool) }

/// Where a dialog's things are at a size: its sidebar, main area and bottom row.
#[derive(Clone, Copy, Debug)]
struct Layout { side: Rect, main: Rect, bottom: u16 }

fn layout(w: u16, h: u16) -> Layout {
    let side_w = SIDE_W.min(w / 4);
    let body_h = h.saturating_sub(6);
    Layout { side: Rect::new(1, 3, side_w, body_h), main: Rect::new(2 + side_w, 3, w.saturating_sub(3 + side_w), body_h), bottom: h.saturating_sub(2) }
}

/// A history entry: the columns' folders and which one is active.
type Spot = (Vec<PathBuf>, usize);

#[derive(Debug)]
pub(super) struct Dialog {
    cols: Vec<Col>,
    active: usize,
    pub(super) view: DView,
    back: Vec<Spot>,
    fwd: Vec<Spot>,
    places: Vec<Place>,
    side_sel: usize,
    focus: Focus,
    search: String,
    /// The path popup: the folders above the one on show, and the one the keys are on.
    popup: Option<(Vec<PathBuf>, usize)>,
    /// Cancel (0) or Open (1), with the keys on the buttons.
    button: usize,
    pub(super) message: Option<String>,
    nerd: bool,
    recent_file: PathBuf,
    size: (u16, u16),
    /// The selected file's first lines (None: not text), read once.
    preview: Option<(PathBuf, Option<Vec<String>>)>,
    /// The selection moved: brought into view at the next draw.
    follow: bool,
}

/// Where Recent is kept: $XDG_STATE_HOME (else ~/.local/state)/harness-os/open-recent.json.
pub(super) fn recent_home() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home().join(".local/state")).join("harness-os/open-recent.json")
}

/// What was opened through the dialog, the latest first.
fn load_recent(file: &Path) -> Vec<PathBuf> {
    std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok()).unwrap_or_default().into_iter().map(PathBuf::from).collect()
}

/// [path] the latest opened: first in Recent, once, RECENT_KEPT kept.
fn push_recent(file: &Path, path: &Path) {
    let mut all = load_recent(file);
    all.retain(|p| p != path);
    all.insert(0, path.to_path_buf());
    all.truncate(RECENT_KEPT);
    let list: Vec<String> = all.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    if let Some(dir) = file.parent() { let _ = std::fs::create_dir_all(dir); }
    let _ = std::fs::write(file, serde_json::to_string(&list).unwrap_or_default());
}

/// The sidebar's places: home's usual folders that are there, what Recent has that is still
/// there, the computer and the drives mounted for this user.
fn places(recent_file: &Path, nerd: bool) -> Vec<Place> {
    let h = home();
    let glyph = |n: &'static str, p: &'static str| if nerd { n } else { p };
    let mut out = vec![Place { section: 0, label: "Home".into(), icon: glyph("\u{f015}", "~"), path: h.clone() }];
    for (name, label, n) in [("Desktop", "Desktop", "\u{f108}"), ("Documents", "Documents", "\u{f15c}"), ("Downloads", "Downloads", "\u{f019}"), ("Pictures", "Pictures", "\u{f03e}"), ("projects", "projects", "\u{f07b}")] {
        if h.join(name).is_dir() { out.push(Place { section: 0, label: label.into(), icon: glyph(n, "▸"), path: h.join(name) }) }
    }
    for p in load_recent(recent_file).into_iter().filter(|p| p.exists()).take(RECENT_SHOWN) {
        let dir = p.is_dir();
        out.push(Place { section: 1, label: name_of(&p), icon: if dir { glyph("\u{f07b}", "▸") } else { glyph("\u{f15b}", "·") }, path: p });
    }
    out.push(Place { section: 2, label: "Computer".into(), icon: glyph("\u{f108}", "/"), path: PathBuf::from("/") });
    let user = std::env::var("USER").unwrap_or_default();
    for base in [format!("/run/media/{user}"), format!("/media/{user}")] {
        if user.is_empty() { break }
        let Ok(rd) = std::fs::read_dir(&base) else { continue };
        let mut vols: Vec<PathBuf> = rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()).collect();
        vols.sort();
        for v in vols { out.push(Place { section: 2, label: name_of(&v), icon: glyph("\u{f0a0}", "□"), path: v }) }
    }
    out
}

impl Dialog {
    pub(super) fn new(dir: PathBuf, nerd: bool, recent_file: PathBuf) -> Dialog {
        let places = places(&recent_file, nerd);
        let mut d = Dialog {
            cols: Vec::new(), active: 0, view: DView::Columns, back: Vec::new(), fwd: Vec::new(), places, side_sel: 0, focus: Focus::Columns,
            search: String::new(), popup: None, button: 1, message: None, nerd, recent_file, size: (130, 34), preview: None, follow: true,
        };
        d.set_spot((vec![dir], 0));
        d
    }

    /// The folder on show: the active column's.
    pub(super) fn current(&self) -> PathBuf { self.cols[self.active].dir.clone() }

    fn spot(&self) -> Spot { (self.cols.iter().map(|c| c.dir.clone()).collect(), self.active) }

    /// The columns for [spot]'s folders, each selecting the next.
    fn set_spot(&mut self, (dirs, active): Spot) {
        self.cols = dirs.iter().map(|d| Col::new(d.clone())).collect();
        for i in 0..self.cols.len().saturating_sub(1) {
            let next = name_of(&dirs[i + 1]);
            self.cols[i].sel = self.cols[i].entries.iter().position(|e| e.name == next);
        }
        self.active = active.min(self.cols.len() - 1);
        self.refilter();
        self.follow = true;
    }

    /// A move that changes the folder on show: where it was, for Back.
    fn moved_from(&mut self, before: Spot) {
        if before.0.get(before.1) != Some(&self.current()) { self.back.push(before); self.fwd.clear() }
    }

    /// Back ([back]) or Forward through the folders shown.
    fn history(&mut self, back: bool) {
        let from = if back { self.back.pop() } else { self.fwd.pop() };
        let Some(spot) = from else { return };
        let now = self.spot();
        if back { self.fwd.push(now) } else { self.back.push(now) }
        self.set_spot(spot);
    }

    /// [dir] shown as the first column (a place, a folder from the path popup).
    fn show(&mut self, dir: PathBuf, select: Option<String>) {
        let before = self.spot();
        self.search.clear();
        self.set_spot((vec![dir], 0));
        if let Some(n) = select { let c = &mut self.cols[0]; c.sel = c.entries.iter().position(|e| e.name == n); self.open_next(0) }
        self.moved_from(before);
    }

    /// The search applied to the deepest column, the others whole; the preview read again.
    fn refilter(&mut self) {
        let last = self.cols.len() - 1;
        for (i, c) in self.cols.iter_mut().enumerate() { c.filter(if i == last { &self.search } else { "" }) }
    }

    /// Entry [i] of column [c] selected: the columns after it gone, its own shown when a folder.
    fn select(&mut self, c: usize, i: usize) {
        let before = self.spot();
        self.cols.truncate(c + 1);
        self.cols[c].sel = Some(i);
        self.active = c;
        self.open_next(c);
        self.refilter();
        self.follow = true;
        self.moved_from(before);
    }

    fn open_next(&mut self, c: usize) {
        self.cols.truncate(c + 1);
        if let Some(e) = self.cols[c].selected().filter(|e| e.dir) { let p = self.cols[c].dir.join(&e.name); self.cols.push(Col::new(p)) }
    }

    /// What Open takes: the active column's selection, else the folder on show.
    pub(super) fn target(&self) -> (PathBuf, bool) {
        let c = &self.cols[self.active];
        c.selected().map(|e| (c.dir.join(&e.name), e.dir)).unwrap_or_else(|| (c.dir.clone(), true))
    }

    /// Open: a folder as it is; a file when it is text (else why not, the dialog staying). Kept
    /// in Recent.
    fn open(&mut self, what: (PathBuf, bool)) -> DOut {
        let (path, dir) = what;
        if !dir {
            let name = name_of(&path);
            match editor::Editor::open(&path, name.clone()) {
                Ok(_) => {}
                Err(editor::Refusal::NotText) => { self.message = Some(format!("Can't open '{name}': not a text file")); return DOut::None }
                Err(editor::Refusal::TooLarge) => { self.message = Some(format!("Can't open '{name}': too large to open here")); return DOut::None }
                Err(editor::Refusal::Unreadable(e)) => { self.message = Some(format!("Can't open '{name}': {e}")); return DOut::None }
            }
        }
        push_recent(&self.recent_file, &path);
        DOut::Open(path, dir)
    }

    fn rows(&self) -> usize { layout(self.size.0, self.size.1).main.height.max(1) as usize }

    // ── keys ─────────────────────────────────────────────────────────────────

    pub(super) fn key(&mut self, k: Chord) -> DOut {
        self.message = None;
        let (ctrl, alt, plain) = (k.mods.contains(KeyModifiers::CONTROL), k.mods.contains(KeyModifiers::ALT), !k.mods.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER));
        if let Some((items, sel)) = self.popup.as_mut() {
            match k.code {
                KeyCode::Up => *sel = sel.saturating_sub(1),
                KeyCode::Down => *sel = (*sel + 1).min(items.len() - 1),
                KeyCode::Enter => { let p = items[*sel].clone(); self.popup = None; self.show(p, None) }
                _ => self.popup = None,
            }
            return DOut::None;
        }
        if self.focus == Focus::Search {
            match k.code {
                KeyCode::Esc => { self.search.clear(); self.focus = Focus::Columns }
                KeyCode::Enter | KeyCode::Down | KeyCode::Tab => self.focus = Focus::Columns,
                KeyCode::Backspace => { self.search.pop(); }
                KeyCode::Char(c) if plain => self.search.push(if k.mods.contains(KeyModifiers::SHIFT) { c.to_uppercase().next().unwrap_or(c) } else { c }),
                _ => {}
            }
            self.refilter();
            return DOut::None;
        }
        match k.code {
            KeyCode::Esc if !self.search.is_empty() => { self.search.clear(); self.refilter() }
            KeyCode::Esc => return DOut::Cancel,
            KeyCode::Char('f') if ctrl => self.focus = Focus::Search,
            KeyCode::Char('/') if plain => self.focus = Focus::Search,
            KeyCode::Tab => self.focus = match self.focus { Focus::Sidebar => Focus::Columns, Focus::Columns => Focus::Buttons, _ => Focus::Sidebar },
            KeyCode::BackTab => self.focus = match self.focus { Focus::Sidebar => Focus::Buttons, Focus::Columns => Focus::Sidebar, _ => Focus::Columns },
            KeyCode::Left if alt => self.history(true),
            KeyCode::Right if alt => self.history(false),
            _ => return match self.focus {
                Focus::Sidebar => self.side_key(k),
                Focus::Buttons => self.button_key(k),
                _ => self.column_key(k),
            },
        }
        DOut::None
    }

    fn side_key(&mut self, k: Chord) -> DOut {
        let n = self.places.len();
        match k.code {
            KeyCode::Up => self.side_sel = self.side_sel.saturating_sub(1),
            KeyCode::Down => self.side_sel = (self.side_sel + 1).min(n.saturating_sub(1)),
            KeyCode::Enter | KeyCode::Right => { self.go_place(self.side_sel); self.focus = Focus::Columns }
            _ => {}
        }
        DOut::None
    }

    /// A place shown: a folder as the first column; a file in its folder, selected.
    fn go_place(&mut self, i: usize) {
        let Some(p) = self.places.get(i).map(|p| p.path.clone()) else { return };
        self.side_sel = i;
        if p.is_dir() { self.show(p, None) } else if let Some(parent) = p.parent() { self.show(parent.to_path_buf(), Some(name_of(&p))) }
    }

    fn button_key(&mut self, k: Chord) -> DOut {
        match k.code {
            KeyCode::Left | KeyCode::Right => self.button ^= 1,
            KeyCode::Enter => return if self.button == 1 { self.open(self.target()) } else { DOut::Cancel },
            _ => {}
        }
        DOut::None
    }

    fn column_key(&mut self, k: Chord) -> DOut {
        let c = self.active;
        let col = &self.cols[c];
        let (at, n) = (col.at(), col.rows.len());
        let icons = self.view == DView::Icons;
        let across = if icons { (layout(self.size.0, self.size.1).main.width / TILE_W).max(1) as usize } else { 1 };
        let page = if icons { across * (self.rows() / TILE_H as usize).max(1) } else { self.rows() };
        let step = |d: isize| -> Option<usize> {
            if n == 0 { return None }
            Some(match at { None => 0, Some(a) => (a as isize + d).clamp(0, n as isize - 1) as usize })
        };
        let row = match k.code {
            KeyCode::Up => step(-(across as isize)),
            KeyCode::Down => step(across as isize),
            KeyCode::PageUp => step(-(page as isize)),
            KeyCode::PageDown => step(page as isize),
            KeyCode::Home => step(-(n as isize)),
            KeyCode::End => step(n as isize),
            KeyCode::Left if icons => step(-1),
            KeyCode::Right if icons => step(1),
            KeyCode::Right => {
                // Into the selected folder's column, its first entry selected.
                if col.selected().is_some_and(|e| e.dir) && self.cols.len() > c + 1 {
                    let before = self.spot();
                    self.active = c + 1;
                    if let Some(&first) = self.cols[c + 1].rows.first() { self.cols.truncate(c + 2); self.cols[c + 1].sel = Some(first); self.open_next(c + 1); self.refilter() }
                    self.moved_from(before);
                }
                None
            }
            KeyCode::Left | KeyCode::Backspace if c > 0 => {
                let before = self.spot();
                self.cols.truncate(c + 1);
                self.cols[c].sel = None;
                self.active = c - 1;
                self.refilter();
                self.moved_from(before);
                None
            }
            KeyCode::Backspace => {
                // Above the first column: its folder's parent, the folder selected in it.
                let dir = self.cols[0].dir.clone();
                if let Some(parent) = dir.parent() { self.show(parent.to_path_buf(), Some(name_of(&dir))) }
                None
            }
            KeyCode::Enter => return self.open(self.target()),
            // Type to select: the next entry from here whose name starts with the letter.
            KeyCode::Char(ch) if !k.mods.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
                let ch = ch.to_lowercase().next().unwrap_or(ch);
                let from = at.map(|a| a + 1).unwrap_or(0);
                (0..n).map(|k| (from + k) % n.max(1)).find(|r| col.entries[col.rows[*r]].name.to_lowercase().starts_with(ch))
            }
            _ => None,
        };
        if let Some(r) = row { let i = self.cols[c].rows[r]; self.select(c, i) }
        DOut::None
    }

    // ── the mouse ────────────────────────────────────────────────────────────

    /// The toolbar's parts: each one's columns and what it is.
    fn tools(&self) -> Vec<(u16, u16, Tool)> {
        let w = self.size.0;
        let mut out = vec![(2, 3, Tool::Back), (4, 5, Tool::Forward)];
        let mut x = 7;
        for (label, t) in [(" ▥ Columns ", Tool::Columns), (" ▦ Icons ", Tool::Icons)] { let lw = label.width() as u16; out.push((x, x + lw, t)); x += lw + 1 }
        let search_w = 24.min(w / 4);
        let name_w = (self.path_label().width() as u16).min(w.saturating_sub(x + 2 + search_w + 3));
        out.push((x + 1, x + 1 + name_w, Tool::Path));
        out.push((w.saturating_sub(search_w + 2), w.saturating_sub(2), Tool::Search));
        out
    }

    fn path_label(&self) -> String { format!("{} {} ▾", if self.nerd { "\u{f07b}" } else { "▸" }, name_of(&self.current())) }

    /// The sidebar's rows: each section's title, its places, a blank between.
    fn side_rows(&self) -> Vec<Option<Result<&'static str, usize>>> {
        let mut out = Vec::new();
        for (s, title) in SECTIONS.iter().enumerate() {
            let here: Vec<usize> = (0..self.places.len()).filter(|i| self.places[*i].section == s).collect();
            if here.is_empty() { continue }
            if !out.is_empty() { out.push(None) }
            out.push(Some(Ok(*title)));
            out.extend(here.into_iter().map(|i| Some(Err(i))));
        }
        out
    }

    /// Which columns are shown in the main area (the active one and the one after it kept in
    /// view), from which, and how many there are with the preview.
    fn shown(&self, main_w: u16) -> (usize, usize, usize) {
        let total = self.cols.len() + self.preview_entry().is_some() as usize;
        let fit = (main_w / COL_W).max(1) as usize;
        let need = (self.active + 1).min(total - 1);
        let start = (need + 1).saturating_sub(fit);
        (start, fit.min(total - start), total)
    }

    /// The file the preview is of: the deepest column's selection, when a file.
    fn preview_entry(&self) -> Option<(PathBuf, &Entry)> {
        let c = self.cols.last()?;
        c.selected().filter(|e| !e.dir).map(|e| (c.dir.join(&e.name), e))
    }

    /// The buttons at the right of the bottom row: Cancel, Open.
    fn buttons(&self) -> [(u16, u16, &'static str); 2] {
        let right = self.size.0.saturating_sub(2);
        let open = "[ Open ]";
        let cancel = "[ Cancel ]";
        let ox = right - open.width() as u16;
        let cx = ox - 2 - cancel.width() as u16;
        [(cx, cx + cancel.width() as u16, cancel), (ox, right, open)]
    }

    /// A click at (x, y), a [double] one opening what it is on.
    pub(super) fn click(&mut self, x: u16, y: u16, double: bool) -> DOut {
        self.message = None;
        let l = layout(self.size.0, self.size.1);
        if let Some((items, _)) = self.popup.clone() {
            self.popup = None;
            let (px, py, pw) = self.popup_at();
            if x >= px && x < px + pw && y > py && y <= py + items.len() as u16 { self.show(items[(y - py - 1) as usize].clone(), None) }
            return DOut::None;
        }
        if y == 1 {
            match self.tools().into_iter().find(|(a, z, _)| x >= *a && x < *z).map(|t| t.2) {
                Some(Tool::Back) => self.history(true),
                Some(Tool::Forward) => self.history(false),
                Some(Tool::Columns) => self.view = DView::Columns,
                Some(Tool::Icons) => self.view = DView::Icons,
                Some(Tool::Path) => { let cur = self.current(); self.popup = Some((cur.ancestors().map(Path::to_path_buf).collect(), 0)) }
                Some(Tool::Search) => self.focus = Focus::Search,
                None => {}
            }
            return DOut::None;
        }
        if y == l.bottom {
            match self.buttons().iter().position(|(a, z, _)| x >= *a && x < *z) { Some(0) => return DOut::Cancel, Some(_) => return self.open(self.target()), None => {} }
            return DOut::None;
        }
        if contains(l.side, x, y) {
            self.focus = Focus::Sidebar;
            if let Some(Some(Err(i))) = self.side_rows().get((y - l.side.y) as usize).cloned() { self.go_place(i) }
            return DOut::None;
        }
        if !contains(l.main, x, y) { return DOut::None }
        self.focus = Focus::Columns;
        let (c, r) = match self.view {
            DView::Icons => {
                let across = (l.main.width / TILE_W).max(1);
                let (col, row) = ((x - l.main.x) / TILE_W, (y - l.main.y) / TILE_H);
                if col >= across { return DOut::None }
                let c = &self.cols[self.active];
                (self.active, c.scroll + (row * across + col) as usize)
            }
            DView::Columns => {
                let (start, n, _) = self.shown(l.main.width);
                let k = ((x - l.main.x) / COL_W) as usize;
                if k >= n || start + k >= self.cols.len() { return DOut::None }
                let c = start + k;
                (c, self.cols[c].scroll + (y - l.main.y) as usize)
            }
        };
        let Some(&i) = self.cols[c].rows.get(r) else { return DOut::None };
        let e = self.cols[c].entries[i].clone();
        if double && self.view == DView::Icons && e.dir {
            // (In Icons, a folder double-clicked is gone into, as a grid of icons does.)
            self.select(c, i);
            let before = self.spot();
            self.active = (c + 1).min(self.cols.len() - 1);
            self.moved_from(before);
            return DOut::None;
        }
        if double { return self.open((self.cols[c].dir.join(&e.name), e.dir)) }
        self.select(c, i);
        DOut::None
    }

    /// The wheel over the column (or the sidebar) under the pointer.
    pub(super) fn wheel(&mut self, x: u16, down: bool) {
        let l = layout(self.size.0, self.size.1);
        let c = match self.view {
            DView::Columns if x >= l.main.x => { let (start, _, _) = self.shown(l.main.width); start + ((x - l.main.x) / COL_W) as usize }
            _ => self.active,
        };
        let step = if self.view == DView::Icons { (l.main.width / TILE_W).max(1) as usize } else { 3 };
        if let Some(col) = self.cols.get_mut(c) {
            let max = col.rows.len().saturating_sub(1);
            col.scroll = if down { (col.scroll + step).min(max) } else { col.scroll.saturating_sub(step) };
        }
    }

    /// Where the path popup is: under the folder's name, as wide as its longest.
    fn popup_at(&self) -> (u16, u16, u16) {
        let x = self.tools().iter().find(|t| t.2 == Tool::Path).map(|t| t.0).unwrap_or(2);
        let w = self.popup.as_ref().map(|(items, _)| items.iter().map(|p| p.to_string_lossy().width()).max().unwrap_or(1)).unwrap_or(10) as u16 + 4;
        (x.saturating_sub(1), 2, w.min(self.size.0.saturating_sub(x)))
    }

    // ── drawing ──────────────────────────────────────────────────────────────

    /// Each column's selection brought into view when it moved (the wheel scrolls past it).
    fn fit(&mut self) {
        let l = layout(self.size.0, self.size.1);
        let rows = l.main.height.max(1) as usize;
        let (across, tiles_down) = ((l.main.width / TILE_W).max(1) as usize, (l.main.height / TILE_H).max(1) as usize);
        let (follow, icons, active) = (std::mem::take(&mut self.follow), self.view == DView::Icons, self.active);
        for (i, c) in self.cols.iter_mut().enumerate() {
            c.scroll = c.scroll.min(c.rows.len().saturating_sub(1));
            let Some(at) = c.at().filter(|_| follow) else { continue };
            if icons && i == active {
                let (r, top) = (at / across, c.scroll / across);
                let top = if r < top { r } else if r >= top + tiles_down { r + 1 - tiles_down } else { top };
                c.scroll = top * across;
            } else if at < c.scroll { c.scroll = at } else if at >= c.scroll + rows { c.scroll = at + 1 - rows }
        }
    }

    pub(super) fn draw(&mut self, buf: &mut Buffer, area: Rect, look: &Look) {
        self.size = (area.width, area.height);
        self.fit();
        let l = layout(area.width, area.height);
        let (ox, oy) = (area.x, area.y);
        let at = |x: u16, y: u16| (ox + x, oy + y);
        frame(buf, area, look.muted);
        let title = " Open ";
        put(buf, ox + (area.width.saturating_sub(title.width() as u16)) / 2, oy, title.width() as u16, title, look.text.add_modifier(Modifier::BOLD));
        // Rules under the toolbar and over the buttons, and between the sidebar and the columns.
        for y in [2, l.bottom.saturating_sub(1)] { put(buf, ox, oy + y, area.width, &format!("├{}┤", "─".repeat(area.width.saturating_sub(2) as usize)), look.muted); }
        for y in l.side.y..l.side.y + l.side.height { let (x, y) = at(l.side.x + l.side.width, y); put(buf, x, y, 1, "│", look.muted); }
        self.draw_toolbar(buf, area, look);
        self.draw_sidebar(buf, area, l, look);
        match self.view { DView::Columns => self.draw_columns(buf, area, l, look), DView::Icons => self.draw_icons(buf, area, l, look) }
        // The bottom row: what was said, else the keys; Cancel and Open.
        let buttons = self.buttons();
        let room = buttons[0].0.saturating_sub(3);
        let (text, st) = match &self.message { Some(m) => (m.clone(), look.warn), None => ("Enter open · Esc cancel · Tab sidebar/columns/buttons · / search".to_string(), look.muted) };
        put(buf, ox + 2, oy + l.bottom, room, &fit(&text, room as usize), st);
        for (b, (a, _, label)) in buttons.iter().enumerate() {
            let mut st = if b == 1 { look.mode.add_modifier(Modifier::BOLD) } else { look.text };
            if self.focus == Focus::Buttons && self.button == b { st = st.add_modifier(Modifier::UNDERLINED | Modifier::BOLD) }
            put(buf, ox + a, oy + l.bottom, label.width() as u16, label, st);
        }
        if let Some((items, sel)) = &self.popup {
            let (px, py, pw) = self.popup_at();
            let r = Rect::new(ox + px, oy + py, pw, items.len() as u16 + 2).intersection(area);
            frame(buf, r, look.muted);
            for (i, p) in items.iter().enumerate() {
                let label = if p == Path::new("/") { "/".to_string() } else { name_of(p) };
                put(buf, r.x + 1, r.y + 1 + i as u16, pw.saturating_sub(2), &format!(" {:<w$}", label, w = pw.saturating_sub(3) as usize), if i == *sel { look.mode } else { look.text });
            }
        }
    }

    fn draw_toolbar(&self, buf: &mut Buffer, area: Rect, look: &Look) {
        let (ox, oy) = (area.x, area.y + 1);
        for (a, z, t) in self.tools() {
            let (text, st) = match t {
                Tool::Back => ("◀".to_string(), if self.back.is_empty() { look.muted } else { look.text }),
                Tool::Forward => ("▶".to_string(), if self.fwd.is_empty() { look.muted } else { look.text }),
                Tool::Columns => (" ▥ Columns ".to_string(), if self.view == DView::Columns { look.mode } else { look.muted }),
                Tool::Icons => (" ▦ Icons ".to_string(), if self.view == DView::Icons { look.mode } else { look.muted }),
                Tool::Path => (fit(&self.path_label(), (z - a) as usize), look.text.add_modifier(Modifier::BOLD)),
                Tool::Search => {
                    let w = (z - a) as usize;
                    let (q, st) = if self.search.is_empty() && self.focus != Focus::Search { ("Search".to_string(), look.muted) } else { (format!("{}{}", self.search, if self.focus == Focus::Search { "▏" } else { "" }), look.text) };
                    (format!("⌕ {:<w$}", fit(&q, w.saturating_sub(2)), w = w.saturating_sub(2)), st.add_modifier(Modifier::UNDERLINED))
                }
            };
            put(buf, ox + a, oy, z - a, &text, st);
        }
    }

    fn draw_sidebar(&self, buf: &mut Buffer, area: Rect, l: Layout, look: &Look) {
        let (ox, oy, w) = (area.x + l.side.x, area.y + l.side.y, l.side.width);
        let first = self.cols[0].dir.clone();
        for (k, row) in self.side_rows().into_iter().enumerate().take(l.side.height as usize) {
            let y = oy + k as u16;
            match row {
                None => {}
                Some(Ok(title)) => { put(buf, ox + 1, y, w.saturating_sub(1), title, look.muted.add_modifier(Modifier::BOLD)); }
                Some(Err(i)) => {
                    let p = &self.places[i];
                    let on = p.path == first;
                    let st = if self.focus == Focus::Sidebar && self.side_sel == i { look.mode } else if on { look.accent.add_modifier(Modifier::BOLD) } else { look.text };
                    put(buf, ox + 1, y, w.saturating_sub(1), &format!(" {} {:<n$}", p.icon, fit(&p.label, w.saturating_sub(5) as usize), n = w.saturating_sub(5) as usize), st);
                }
            }
        }
    }

    fn draw_columns(&mut self, buf: &mut Buffer, area: Rect, l: Layout, look: &Look) {
        let (start, n, total) = self.shown(l.main.width);
        let (ox, oy) = (area.x, area.y);
        for k in 0..n {
            let c = start + k;
            let x = ox + l.main.x + k as u16 * COL_W;
            // The last one takes what is left (the preview the most of it).
            let w = if k + 1 == n { (l.main.x + l.main.width).saturating_sub(l.main.x + k as u16 * COL_W) } else { COL_W - 1 };
            if c == self.cols.len() && c + 1 == total { self.draw_preview(buf, Rect::new(x, oy + l.main.y, w, l.main.height), look); continue }
            let col = &self.cols[c];
            if k + 1 < n { for y in 0..l.main.height { put(buf, x + COL_W - 1, oy + l.main.y + y, 1, "│", look.muted); } }
            if let Some(e) = &col.error { put(buf, x + 1, oy + l.main.y, w.saturating_sub(2), &fit(e, w.saturating_sub(2) as usize), look.warn); continue }
            if col.rows.is_empty() { put(buf, x + 1, oy + l.main.y, w.saturating_sub(2), if self.search.is_empty() { "Empty" } else { "No matches" }, look.muted); continue }
            for (r, &i) in col.rows.iter().enumerate().skip(col.scroll).take(l.main.height as usize) {
                let e = &col.entries[i];
                let y = oy + l.main.y + (r - col.scroll) as u16;
                let selected = col.sel == Some(i);
                let st = if !selected { look.text } else if c == self.active && self.focus != Focus::Sidebar { look.mode } else { look.text.add_modifier(Modifier::REVERSED | Modifier::DIM) };
                let icon_st = if selected { st } else if e.dir { look.accent } else { file_style(&e.name, look) };
                put(buf, x, y, w, &" ".repeat(w as usize), st);
                let iw = put(buf, x + 1, y, 3, icon(e, self.nerd), icon_st);
                let name_w = w.saturating_sub(iw + 5);
                put(buf, x + 2 + iw, y, name_w, &shorten(&e.name, e.dir, name_w as usize), st);
                if e.dir { put(buf, x + w.saturating_sub(2), y, 1, "›", st); }
            }
        }
    }

    /// The preview of the file selected: its picture, name, kind, size and date, and the first
    /// lines of a text file.
    fn draw_preview(&mut self, buf: &mut Buffer, r: Rect, look: &Look) {
        let Some((path, e)) = self.preview_entry().map(|(p, e)| (p, e.clone())) else { return };
        if self.preview.as_ref().map(|p| &p.0) != Some(&path) {
            let lines = std::fs::File::open(&path).ok().and_then(|f| {
                use std::io::Read;
                let mut head = Vec::new();
                f.take(8192).read_to_end(&mut head).ok()?;
                // (A UTF-8 character the 8 KB cut in two is not a reason to call it binary.)
                let text = match std::str::from_utf8(&head) { Ok(t) => t.to_string(), Err(err) if err.error_len().is_none() => String::from_utf8_lossy(&head[..err.valid_up_to()]).into_owned(), Err(_) => return None };
                editor::is_text(&e.name, text.as_bytes()).then(|| text.lines().take(10).map(|l| l.replace('\t', "    ")).collect())
            });
            self.preview = Some((path.clone(), lines));
        }
        let x = r.x + 2;
        let w = r.width.saturating_sub(4);
        let st = file_style(&e.name, look);
        for (dy, line) in art(&e).iter().enumerate() { put(buf, x + w.saturating_sub(line.width() as u16) / 2, r.y + 1 + dy as u16, w, line, st); }
        let name = shorten(&e.name, false, w as usize);
        put(buf, x + w.saturating_sub(name.width() as u16) / 2, r.y + 6, w, &name, look.text.add_modifier(Modifier::BOLD));
        let when = e.modified.map(|t| ops::when(t, SystemTime::now())).unwrap_or_else(|| "—".into());
        for (k, (label, value)) in [("Kind", ops::kind(&e.name, false)), ("Size", ops::human_size(e.size)), ("Modified", when)].into_iter().enumerate() {
            let y = r.y + 8 + k as u16;
            put(buf, x, y, 9, label, look.muted);
            put(buf, x + 10, y, w.saturating_sub(10), &value, look.text);
        }
        if let Some((_, Some(lines))) = &self.preview {
            for (k, line) in lines.iter().enumerate() {
                let y = r.y + 12 + k as u16;
                if y >= r.y + r.height { break }
                put(buf, x, y, w, &fit(line, w as usize), look.muted);
            }
        }
    }

    fn draw_icons(&self, buf: &mut Buffer, area: Rect, l: Layout, look: &Look) {
        let col = &self.cols[self.active];
        let across = (l.main.width / TILE_W).max(1) as usize;
        let down = (l.main.height / TILE_H) as usize;
        for (k, &i) in col.rows.iter().enumerate().skip(col.scroll).take(across * down) {
            let k = k - col.scroll;
            let (x, y) = (area.x + l.main.x + (k % across) as u16 * TILE_W + 1, area.y + l.main.y + (k / across) as u16 * TILE_H);
            tile(buf, x, y, &col.entries[i], col.sel == Some(i), false, look);
        }
        if col.rows.is_empty() { put(buf, area.x + l.main.x + 1, area.y + l.main.y, l.main.width, if self.search.is_empty() { "Empty" } else { "No matches" }, look.muted); }
    }
}

fn contains(r: Rect, x: u16, y: u16) -> bool { super::contains(r, x, y) }

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(files: &[(&str, &str)]) -> Scratch {
            let root = std::env::temp_dir().join(format!("hn-dialog-{}", uuid::Uuid::new_v4()));
            for (f, body) in files {
                let p = root.join(f);
                if f.ends_with('/') { std::fs::create_dir_all(&p).unwrap() } else { std::fs::create_dir_all(p.parent().unwrap()).unwrap(); std::fs::write(&p, body).unwrap() }
            }
            Scratch(root)
        }
        fn dialog(&self) -> Dialog { let mut d = Dialog::new(self.0.join("me"), false, self.0.join("state/open-recent.json")); d.size = (130, 34); d }
    }
    impl Drop for Scratch { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    fn k(code: KeyCode) -> Chord { Chord::normal(code, KeyModifiers::NONE) }
    fn text(d: &mut Dialog, w: u16, h: u16) -> String {
        let area = Rect::new(0, 0, w, h);
        let mut buf = Buffer::empty(area);
        d.draw(&mut buf, area, &Look::default());
        (0..h).map(|y| (0..w).map(|x| buf[(x, y)].symbol()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }
    fn row_of(d: &Dialog, c: usize, name: &str) -> u16 { layout(d.size.0, d.size.1).main.y + d.cols[c].rows.iter().position(|i| d.cols[c].entries[*i].name == name).unwrap() as u16 }
    fn col_x(d: &Dialog, c: usize) -> u16 { let l = layout(d.size.0, d.size.1); l.main.x + (c - d.shown(l.main.width).0) as u16 * COL_W + 4 }

    #[test]
    fn the_dialog_has_its_toolbar_sidebar_columns_preview_and_buttons_in_a_box() {
        let s = Scratch::new(&[("me/projects/app/main.py", "import os\nprint('xin chào')\n"), ("me/notes.md", "# hi\n")]);
        let mut d = s.dialog();
        let x = col_x(&d, 0);
        d.click(x, row_of(&d, 0, "projects"), false);
        assert_eq!(d.cols.len(), 2, "a folder clicked shows its column");
        d.click(col_x(&d, 1), row_of(&d, 1, "app"), false);
        d.key(k(KeyCode::Right));
        assert_eq!(d.active, 2);
        assert!(d.preview_entry().is_some_and(|(p, _)| p.ends_with("app/main.py")), "its first entry, a file, previewed");
        let t = text(&mut d, 130, 34);
        let lines: Vec<&str> = t.lines().collect();
        assert!(lines[0].starts_with('╭') && lines[0].contains(" Open ") && lines[33].starts_with('╰'), "{t}");
        assert!(lines[1].contains("◀ ▶") && lines[1].contains("Columns") && lines[1].contains("Icons") && lines[1].contains("app ▾") && lines[1].contains("⌕ Search"), "{}", lines[1]);
        assert!(t.contains("Favorites") && t.contains("Home") && t.contains("Locations") && t.contains("Computer"), "{t}");
        assert!(t.contains("[/] app") && t.contains("main.py") && t.contains("Python script") && t.contains("print('xin chào')"), "{t}");
        assert!(lines[32].contains("[ Cancel ]") && lines[32].contains("[ Open ]"));
        // It fits a small window too.
        let small = text(&mut d, 90, 24);
        assert!(small.lines().nth(22).unwrap().contains("[ Open ]") && small.contains("main.py"), "{small}");
    }

    #[test]
    fn left_right_back_forward_and_the_path_popup() {
        let s = Scratch::new(&[("me/a/b/c.txt", "x"), ("me/z/", "")]);
        let mut d = s.dialog();
        d.key(k(KeyCode::Down));
        assert_eq!(d.cols[0].selected().map(|e| e.name.as_str()), Some("a"));
        d.key(k(KeyCode::Right));
        d.key(k(KeyCode::Right));
        assert_eq!((d.active, d.current()), (2, s.0.join("me/a/b")));
        d.key(k(KeyCode::Left));
        assert_eq!(d.current(), s.0.join("me/a"));
        d.key(Chord::normal(KeyCode::Left, KeyModifiers::ALT));
        assert_eq!(d.current(), s.0.join("me/a/b"), "Back to where it was");
        d.key(Chord::normal(KeyCode::Right, KeyModifiers::ALT));
        assert_eq!(d.current(), s.0.join("me/a"));
        // The path popup: the folders above, one chosen shown first.
        let (px, ..) = d.tools().into_iter().find(|t| t.2 == Tool::Path).unwrap();
        d.click(px, 1, false);
        let items = d.popup.as_ref().unwrap().0.clone();
        assert_eq!(&items[..3], [s.0.join("me/a"), s.0.join("me"), s.0.clone()]);
        let (x, y, _) = d.popup_at();
        d.click(x + 1, y + 2, false);
        assert_eq!((d.cols.len(), d.current()), (1, s.0.join("me")));
        // Backspace above the first column: its parent, the folder selected.
        d.key(k(KeyCode::Backspace));
        assert_eq!(d.cols[0].dir, s.0);
        assert_eq!(d.cols[0].selected().map(|e| e.name.as_str()), Some("me"));
    }

    #[test]
    fn search_filters_the_deepest_column_and_esc_clears_it() {
        let s = Scratch::new(&[("me/Report.md", ""), ("me/notes.txt", ""), ("me/report-2.md", "")]);
        let mut d = s.dialog();
        d.key(k(KeyCode::Char('/')));
        for c in "rep".chars() { d.key(k(KeyCode::Char(c))); }
        assert_eq!(d.cols[0].rows.len(), 2);
        d.key(k(KeyCode::Enter));
        d.key(k(KeyCode::Esc));
        assert_eq!((d.cols[0].rows.len(), d.search.as_str()), (3, ""), "Esc clears the search first");
        assert_eq!(d.key(k(KeyCode::Esc)), DOut::Cancel);
    }

    #[test]
    fn open_takes_a_folder_or_a_text_file_and_keeps_it_in_recent() {
        let s = Scratch::new(&[("me/app/main.py", "print(1)\n"), ("me/logo.png", "\u{0}PNG")]);
        let mut d = s.dialog();
        // A picture: said, still open.
        d.click(col_x(&d, 0), row_of(&d, 0, "logo.png"), true);
        assert_eq!(d.message.as_deref(), Some("Can't open 'logo.png': not a text file"));
        // A folder double-clicked: opened.
        assert_eq!(d.click(col_x(&d, 0), row_of(&d, 0, "app"), true), DOut::Open(s.0.join("me/app"), true));
        // Enter on a text file; Open with nothing selected: the folder on show.
        d.click(col_x(&d, 0), row_of(&d, 0, "app"), false);
        d.key(k(KeyCode::Right));
        assert_eq!(d.key(k(KeyCode::Enter)), DOut::Open(s.0.join("me/app/main.py"), false));
        let mut e = s.dialog();
        let (ox, ..) = e.buttons()[1];
        assert_eq!(e.click(ox + 1, layout(130, 34).bottom, false), DOut::Open(s.0.join("me"), true));
        // Recent: the latest first, once each, those still there.
        let recent = load_recent(&s.0.join("state/open-recent.json"));
        assert_eq!(recent, [s.0.join("me"), s.0.join("me/app/main.py"), s.0.join("me/app")]);
        for i in 0..30 { push_recent(&s.0.join("state/open-recent.json"), &s.0.join(format!("x{i}"))) }
        assert_eq!(load_recent(&s.0.join("state/open-recent.json")).len(), RECENT_KEPT);
        let d2 = s.dialog();
        assert!(d2.places.iter().filter(|p| p.section == 1).count() <= RECENT_SHOWN);
    }

    #[test]
    fn icons_view_is_the_folder_as_tiles_a_folder_double_clicked_gone_into() {
        let s = Scratch::new(&[("me/app/x.txt", ""), ("me/b.txt", "")]);
        let mut d = s.dialog();
        let (ix, ..) = d.tools().into_iter().find(|t| t.2 == Tool::Icons).unwrap();
        d.click(ix + 1, 1, false);
        assert_eq!(d.view, DView::Icons);
        let l = layout(130, 34);
        d.click(l.main.x + 3, l.main.y + 1, true);
        assert_eq!(d.current(), s.0.join("me/app"));
        let t = text(&mut d, 130, 34);
        assert!(t.contains("x.txt"), "{t}");
    }
}
