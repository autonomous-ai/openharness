//! choose-file: a file manager over one pane, as a desktop's shows a folder — its folders, then
//! its files, as big tiles in a grid (Nautilus's icon view) or as rows with their size, date and
//! kind (its list view), a path bar above them to go back up — and down the left, VS Code's
//! explorer: the folders below where it was opened, as a tree whose branches are read as they are
//! opened, the folder on show lit and opened out to. A right click (or the Menu key) gives VS
//! Code's explorer menu: new files and folders, cut, copy and paste, rename, delete to the Trash.
//!
//! Like choose-tree it is the pane's while it lasts: drawn over the pane's cells, the pane's keys
//! and mouse going to it, q or Escape ending it. The folders are this computer's, read when they
//! are shown. A file opened goes to $EDITOR in a terminal split beside the pane. `hn files` is the
//! same view filling a terminal of its own (standalone, at the end), the editor in that terminal.

mod dialog;
mod editor;
mod ops;

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::symbols::border;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{App, At, Placement};
use crate::buttons::{Answer, Button, Row as ButtonRow};
use crate::dialog::{Dialog, Input};
use crate::keys::{self, Chord, MouseKind};
use crate::layout::Dir;
use crate::theme;

/// #{pane_mode} for a pane whose top mode is the file manager.
pub const MODE_NAME: &str = "file-mode";

/// A gallery tile: its columns (a margin each side) and rows (four of picture, its name, a gap).
const TILE_W: u16 = 22;
const TILE_H: u16 = 6;
/// The explorer's width beside a wide grid; a narrower pane gives it a third, a narrow one none.
const TREE_W: u16 = 30;
/// The most entries a folder shows; the rest are counted.
const CAP: usize = 5000;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry { name: String, dir: bool, size: u64, modified: Option<SystemTime> }

/// A folder as read: its entries, how many past CAP, or why it could not be.
#[derive(Clone, Debug, Default)]
struct Listing { entries: Vec<Entry>, more: usize, error: Option<String> }

/// [dir]'s entries — folders first, each lot by name whatever its case — less the hidden ones (a
/// leading dot) unless [hidden], folders alone with [dirs]; CAP of them, the rest counted.
fn list(dir: &Path, hidden: bool, dirs: bool) -> Listing {
    let read = match std::fs::read_dir(dir) { Ok(r) => r, Err(e) => return Listing { error: Some(reason(&e)), ..Listing::default() } };
    let mut entries: Vec<Entry> = read.filter_map(Result::ok).filter_map(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        if !hidden && name.starts_with('.') { return None }
        // (A link is what it points to, as a file manager shows it.)
        let link = e.file_type().is_ok_and(|t| t.is_symlink());
        let meta = if link { std::fs::metadata(e.path()).or_else(|_| e.metadata()) } else { e.metadata() };
        let dir = meta.as_ref().is_ok_and(|m| m.is_dir());
        if dirs && !dir { return None }
        let (size, modified) = meta.map(|m| (m.len(), m.modified().ok())).unwrap_or((0, None));
        Some(Entry { name, dir, size, modified })
    }).collect();
    entries.sort_by_cached_key(|e| (!e.dir, e.name.to_lowercase(), e.name.clone()));
    let more = entries.len().saturating_sub(CAP);
    entries.truncate(CAP);
    Listing { entries, more, error: None }
}

fn reason(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => "permission denied".into(),
        std::io::ErrorKind::NotFound => "it is not there".into(),
        _ => e.to_string(),
    }
}

/// A path's last name ("/" for the root).
fn name_of(path: &Path) -> String { path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned()) }

/// [path] with its `.` and `..` worked out, as written (links not followed).
fn clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c { Component::CurDir => {} Component::ParentDir => { out.pop(); } c => out.push(c) }
    }
    out
}

fn home() -> PathBuf { std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/")) }

/// An explorer row: a folder at its depth, or a note under one (why it can't be read, how many
/// more it has).
#[derive(Clone, Debug)]
struct Row { path: PathBuf, name: String, depth: u16, note: bool }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Focus { Grid, Tree }

/// How the folder's entries are shown: big tiles, or a row each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum View { Gallery, List }

/// What a key or click asks of hn beyond the view: the text for the clipboard (OSC 52) too.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Outcome { None, Exit, Edit(PathBuf), Terminal(PathBuf), Harness(PathBuf), Clipboard(String) }

/// What a menu or a key acts on: an entry (the grid's, or an explorer folder), or the empty space
/// of a folder.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Target { Item { path: PathBuf, dir: bool }, Space(PathBuf) }

impl Target {
    /// The folder it means: a folder itself, a file's, the space's.
    fn folder(&self) -> PathBuf {
        match self {
            Target::Item { path, dir: true } | Target::Space(path) => path.clone(),
            Target::Item { path, dir: false } => path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.clone()),
        }
    }
}

/// The explorer title's buttons, as VS Code's: New File, New Folder, Refresh, Collapse All.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Head { NewFile, NewFolder, Refresh, Collapse }

impl Head {
    const ALL: [Head; 4] = [Head::NewFile, Head::NewFolder, Head::Refresh, Head::Collapse];
    /// Its icon: a Nerd Font codicon (nf-cod-new_file, new_folder, refresh, collapse_all), else letters.
    fn icon(self, nerd: bool) -> &'static str {
        match (self, nerd) {
            (Head::NewFile, true) => "\u{ea7f}", (Head::NewFolder, true) => "\u{ea80}", (Head::Refresh, true) => "\u{eb37}", (Head::Collapse, true) => "\u{eac5}",
            (Head::NewFile, false) => "+F", (Head::NewFolder, false) => "+D", (Head::Refresh, false) => "R", (Head::Collapse, false) => "-",
        }
    }
    fn tip(self) -> &'static str {
        match self { Head::NewFile => "New File…", Head::NewFolder => "New Folder…", Head::Refresh => "Refresh (C-r, F5)", Head::Collapse => "Collapse Folders in Explorer" }
    }
}

/// The context menu's actions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Act { Open, External, NewFile, NewFolder, Terminal, Cut, Copy, Paste, Duplicate, CopyPath, CopyRelative, Rename, Delete, Hidden, View }

#[derive(Clone, Debug, PartialEq, Eq)]
struct Item { label: String, key: &'static str, act: Act, on: bool }

/// The context menu: what it is for, its items (None a rule between groups), its top left in the
/// view and the item the keys or the mouse are on.
#[derive(Clone, Debug)]
struct Menu { target: Target, items: Vec<Option<Item>>, x: u16, y: u16, sel: Option<usize> }

#[derive(Clone, Debug, PartialEq, Eq)]
enum Ask { NewFile, NewFolder, Rename(PathBuf) }

/// The name prompt: what for, in which folder, its text, the cursor and where a selection starts;
/// and whether the keys are on its buttons (Tab) and which one is chosen (0 Cancel, 1 the action).
#[derive(Clone, Debug)]
struct Prompt { ask: Ask, dir: PathBuf, text: Vec<char>, cursor: usize, mark: Option<usize>, buttons: bool, chosen: usize }

/// The columns the name prompt's input box wants.
const PROMPT_W: u16 = 40;

impl Prompt {
    fn new(ask: Ask, dir: PathBuf, text: Vec<char>, cursor: usize, mark: Option<usize>) -> Prompt {
        Prompt { ask, dir, text, cursor, mark, buttons: false, chosen: 1 }
    }

    /// `[ Cancel ]  [ Create ]` (`[ Rename ]`), the chosen button only while the keys are on them.
    fn row(&self) -> ButtonRow {
        let button = |label: &str| Button { label: label.into(), key: None };
        let action = if matches!(self.ask, Ask::Rename(_)) { "Rename" } else { "Create" };
        ButtonRow { buttons: vec![button("Cancel"), button(action)], chosen: if self.buttons { self.chosen } else { usize::MAX }, hint: crate::buttons::KEYS.into() }
    }

    /// The selection, from the mark to the cursor, when there is one.
    fn selection(&self) -> Option<(usize, usize)> { self.mark.filter(|m| *m != self.cursor).map(|m| (m.min(self.cursor), m.max(self.cursor))) }
    /// The selection gone (what is typed replaces it).
    fn cut(&mut self) -> bool {
        let Some((a, b)) = self.selection() else { self.mark = None; return false };
        self.text.drain(a..b);
        self.cursor = a;
        self.mark = None;
        true
    }
}

/// What a confirmation is for: a thing to the Trash, or — when it can't go there, and why — gone
/// for good.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Doom { Trash(PathBuf), Purge(PathBuf, String) }

/// A confirmation: its question and which of its two buttons (0 Cancel, 1 Delete) has the keys.
#[derive(Clone, Debug)]
struct Confirm { doom: Doom, focus: usize }

/// Where things are in a view of a size, its top left (0, 0): the explorer down the left (none
/// when it is narrow), a line, then the grid under the path bar and keys — its items' columns,
/// rows, size and first row (the list's under its header) — and its footer row below.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Geom { size: (u16, u16), grid: Rect, cols: u16, rows: u16, item_w: u16, item_h: u16, items_y: u16, footer: u16, tree: Rect }

impl Geom {
    /// Whether column x is the explorer's.
    fn in_tree(&self, x: u16) -> bool { x < self.tree.x + self.tree.width }
}

fn geom(w: u16, h: u16, view: View) -> Geom {
    let tree_w = if w >= 90 { TREE_W } else if w >= 45 { w / 3 } else { 0 };
    let grid_x = tree_w + (tree_w > 0) as u16;
    let grid_w = w.saturating_sub(grid_x);
    // The path bar and the keys, a blank row when there is room, the grid, its footer.
    let top = if h >= 12 { 3 } else { 2 };
    let grid_h = h.saturating_sub(top + 1);
    let (item_w, item_h, items_y) = match view { View::Gallery => (TILE_W, TILE_H, top), View::List => (grid_w.max(1), 1, top + 1) };
    Geom {
        size: (w, h),
        grid: Rect::new(grid_x, top, grid_w, grid_h),
        cols: (grid_w / item_w).max(1),
        rows: (grid_h.saturating_sub(items_y - top) / item_h).max(1),
        item_w, item_h, items_y,
        footer: h.saturating_sub(1),
        tree: Rect::new(0, 0, tree_w, h),
    }
}

/// The colours it draws with: mode-style for what is selected, as choose-tree's current line.
pub struct Look { mode: Style, accent: Style, muted: Style, text: Style, warn: Style, code: Style, media: Style, border: border::Set<'static> }

impl Look {
    /// The theme's colours, with [mode] for the selection.
    fn with_mode(mode: Style) -> Look {
        Look {
            mode,
            accent: theme::fg(theme::accent()),
            muted: theme::fg(theme::MUTED),
            text: Style::default(),
            warn: theme::fg(theme::WARN),
            code: theme::fg(theme::ONLINE),
            media: theme::fg(Color::Magenta),
            border: border::PLAIN,
        }
    }
}

impl Default for Look {
    /// hn's own, with no options read (tmux's default mode-style; hn's accent).
    fn default() -> Look { Look::with_mode(crate::draw::style_over("bg=yellow,fg=black", Style::default())) }
}

/// A file manager over a pane: the folder on show (cwd) and the explorer's root, above it.
#[derive(Debug)]
pub struct Files {
    root: PathBuf,
    cwd: PathBuf,
    hidden: bool,
    /// Nerd Font icons (@hn-nerd-font; on in the OS, whose font has them), else plain ones.
    nerd: bool,
    view: View,
    listing: Listing,
    /// What each folder in the list holds, counted as its row is shown (None: unreadable).
    counts: HashMap<String, Option<usize>>,
    selected: usize,
    /// The grid's first row on screen.
    scroll: usize,
    focus: Focus,
    /// The explorer's open folders, its rows as they are, the selected one and the first shown.
    expanded: HashSet<PathBuf>,
    rows: Vec<Row>,
    tree_sel: usize,
    tree_scroll: usize,
    /// The selection moved (a key, a folder opened): it is brought on screen at the next fit; the
    /// wheel scrolls without it.
    follow: bool,
    tree_follow: bool,
    /// Its own window (`hn files`), not a pane's mode: no New Harness key there.
    standalone: bool,
    /// What the footer says in place of the counts until the next key.
    message: Option<String>,
    /// What was cut or copied, to paste (cut: moved).
    clip: Option<(Vec<PathBuf>, bool)>,
    menu: Option<Menu>,
    prompt: Option<Prompt>,
    confirm: Option<Confirm>,
    /// Where deleted things go: the home Trash.
    trash: PathBuf,
    /// Files open in the built-in editor (`hn files`), filling the view while one is; else (a
    /// pane's mode) in $EDITOR beside it.
    builtin: bool,
    editor: Option<Box<editor::Editor>>,
    /// `hn files --edit`: the editor alone, the program ending with it.
    exit_on_close: bool,
    /// The explorer's title button under the mouse: lit, and what it does said in the footer.
    head_hover: Option<Head>,
    /// `hn files --root` (what the Open dialog opens a folder in): kept inside its root.
    bounded: bool,
}

impl Files {
    fn new(dir: PathBuf, nerd: bool) -> Files {
        let mut f = Files {
            root: dir.clone(), cwd: dir.clone(), hidden: false, nerd, view: View::Gallery, listing: Listing::default(), counts: HashMap::new(),
            selected: 0, scroll: 0, focus: Focus::Grid, expanded: HashSet::new(), rows: Vec::new(), tree_sel: 0, tree_scroll: 0,
            follow: true, tree_follow: true, standalone: false, message: None, clip: None, menu: None, prompt: None, confirm: None,
            trash: ops::trash_home(), builtin: false, editor: None, exit_on_close: false, head_hover: None, bounded: false,
        };
        f.go(dir, None);
        f
    }

    /// To [dir], read again: [select] (a name in it) selected, else its first; the explorer rooted
    /// where it was if that is above it (else at it), opened out to it and on it.
    fn go(&mut self, dir: PathBuf, select: Option<&str>) {
        self.listing = list(&dir, self.hidden, false);
        self.counts.clear();
        self.selected = select.and_then(|n| self.listing.entries.iter().position(|e| e.name == n)).unwrap_or(0);
        self.scroll = 0;
        self.follow = true;
        if !dir.starts_with(&self.root) && !self.bounded { self.root = dir.clone() }
        let mut up = Some(dir.as_path());
        while let Some(p) = up {
            self.expanded.insert(p.to_path_buf());
            if p == self.root { break }
            up = p.parent();
        }
        self.cwd = dir;
        self.build_tree();
        self.tree_on_cwd();
    }

    fn tree_on_cwd(&mut self) {
        if let Some(i) = self.rows.iter().position(|r| !r.note && r.path == self.cwd) { self.tree_sel = i; self.tree_follow = true }
    }

    /// The explorer's rows: the root, and in each open folder its folders, read now.
    fn build_tree(&mut self) {
        let mut rows = Vec::new();
        let root = self.root.clone();
        self.add_rows(&mut rows, &root, 0);
        self.rows = rows;
        self.tree_sel = self.tree_sel.min(self.rows.len().saturating_sub(1));
    }

    fn add_rows(&self, rows: &mut Vec<Row>, path: &Path, depth: u16) {
        rows.push(Row { path: path.to_path_buf(), name: name_of(path), depth, note: false });
        if !self.expanded.contains(path) { return }
        let l = list(path, self.hidden, true);
        if let Some(e) = l.error { return rows.push(Row { path: path.to_path_buf(), name: e, depth: depth + 1, note: true }) }
        for e in l.entries { self.add_rows(rows, &path.join(&e.name), depth + 1) }
        if l.more > 0 { rows.push(Row { path: path.to_path_buf(), name: format!("… {} more", l.more), depth: depth + 1, note: true }) }
    }

    /// The folder (and the explorer) read again, the selection kept — by its name, else its place.
    fn reload(&mut self) {
        let (keep, at) = (self.listing.entries.get(self.selected).map(|e| e.name.clone()), self.selected);
        self.go(self.cwd.clone(), keep.as_deref());
        if keep.is_some() && self.listing.entries.get(self.selected).map(|e| &e.name) != keep.as_ref() {
            self.selected = at.min(self.listing.entries.len().saturating_sub(1));
        }
    }

    fn up(&mut self) {
        if self.bounded && self.cwd == self.root { self.message = Some(format!("This is the top of '{}'", name_of(&self.root))); return }
        let from = name_of(&self.cwd);
        if let Some(parent) = self.cwd.parent().map(Path::to_path_buf) { self.go(parent, Some(&from)) }
    }

    /// The selected entry: a folder opened, a file to the editor.
    fn open_selected(&mut self) -> Outcome {
        let Some(e) = self.listing.entries.get(self.selected) else { return Outcome::None };
        let path = self.cwd.join(&e.name);
        if e.dir { self.go(path, None); Outcome::None } else { self.open_file(path) }
    }

    /// A file opened: in the built-in editor when it is text (else the footer says why not), or
    /// in $EDITOR beside a pane's view.
    fn open_file(&mut self, path: PathBuf) -> Outcome {
        if !self.builtin { return Outcome::Edit(path) }
        let name = name_of(&path);
        let title = path.strip_prefix(&self.root).ok().filter(|r| !r.as_os_str().is_empty()).map(|r| r.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned());
        match editor::Editor::open(&path, title) {
            Ok(e) => self.editor = Some(Box::new(e)),
            Err(editor::Refusal::NotText) => self.message = Some(format!("Can't open '{name}': not a text file")),
            Err(editor::Refusal::TooLarge) => self.message = Some(format!("Can't open '{name}': too large to open here (e opens it in $EDITOR)")),
            Err(editor::Refusal::Unreadable(e)) => self.message = Some(format!("Can't open '{name}': {e}")),
        }
        Outcome::None
    }

    /// The editor's key, click or wheel done; closed, the folder read again.
    fn edited(&mut self, out: editor::EdOut) -> Outcome {
        match out {
            editor::EdOut::None => Outcome::None,
            editor::EdOut::Clipboard(t) => Outcome::Clipboard(t),
            editor::EdOut::Close if self.exit_on_close => Outcome::Exit,
            editor::EdOut::Close => { self.editor = None; self.reload(); Outcome::None }
        }
    }

    /// What the keys act on: the explorer's folder with it in focus, else the grid's entry — the
    /// folder's empty space when it has none.
    fn key_target(&self) -> Target {
        let space = Target::Space(self.cwd.clone());
        match self.focus {
            Focus::Tree => self.rows.get(self.tree_sel).filter(|r| !r.note).map(|r| Target::Item { path: r.path.clone(), dir: true }).unwrap_or(space),
            Focus::Grid => self.listing.entries.get(self.selected).map(|e| Target::Item { path: self.cwd.join(&e.name), dir: e.dir }).unwrap_or(space),
        }
    }

    /// An explorer folder opened or closed.
    fn toggle(&mut self, i: usize) {
        let Some(row) = self.rows.get(i).filter(|r| !r.note).cloned() else { return };
        if !self.expanded.remove(&row.path) { self.expanded.insert(row.path); }
        self.build_tree();
        self.tree_sel = i.min(self.rows.len().saturating_sub(1));
    }

    fn set_view(&mut self, view: View) { if self.view != view { self.view = view; self.scroll = 0; self.follow = true } }

    /// The selections brought on screen if they moved, the scrolls kept in range; in the list,
    /// the folders shown counted.
    fn fit(&mut self, g: Geom) {
        let g = geom(g.size.0, g.size.1, self.view);
        let (cols, rows) = (g.cols as usize, g.rows as usize);
        let total = self.listing.entries.len().div_ceil(cols);
        if self.follow {
            let r = self.selected / cols;
            if r < self.scroll { self.scroll = r } else if r >= self.scroll + rows { self.scroll = r + 1 - rows }
            self.follow = false;
        }
        self.scroll = self.scroll.min(total.saturating_sub(rows));
        let shown = g.tree.height.saturating_sub(1).max(1) as usize;
        if self.tree_follow {
            if self.tree_sel < self.tree_scroll { self.tree_scroll = self.tree_sel } else if self.tree_sel >= self.tree_scroll + shown { self.tree_scroll = self.tree_sel + 1 - shown }
            self.tree_follow = false;
        }
        self.tree_scroll = self.tree_scroll.min(self.rows.len().saturating_sub(shown));
        if self.view == View::List {
            let hidden = self.hidden;
            for e in self.listing.entries.iter().skip(self.scroll).take(rows).filter(|e| e.dir) {
                self.counts.entry(e.name.clone()).or_insert_with(|| {
                    std::fs::read_dir(self.cwd.join(&e.name)).ok().map(|r| r.filter_map(Result::ok).filter(|x| hidden || !x.file_name().to_string_lossy().starts_with('.')).count())
                });
            }
        }
    }

    // ── keys ─────────────────────────────────────────────────────────────────

    /// A key: to the confirmation, the name prompt or the menu while one is up, else the view's.
    fn press(&mut self, k: Chord, g: Geom) -> Outcome {
        self.message = None;
        if let Some(e) = self.editor.as_mut() { let out = e.key(k); return self.edited(out) }
        let out = if self.confirm.is_some() { self.confirm_key(k) }
            else if self.prompt.is_some() { self.prompt_key(k) }
            else if self.menu.is_some() { self.menu_key(k) }
            else { self.view_key(k, geom(g.size.0, g.size.1, self.view)) };
        self.fit(g);
        out
    }

    fn view_key(&mut self, k: Chord, g: Geom) -> Outcome {
        let ctrl = |c| is_ctrl(&k, c);
        let item = matches!(self.key_target(), Target::Item { .. });
        match () {
            _ if is_char(&k, 'q') || k.code == KeyCode::Esc || ctrl('g') => Outcome::Exit,
            _ if is_char(&k, 'e') && matches!(self.key_target(), Target::Item { dir: false, .. }) => self.act(Act::External, self.key_target()),
            _ if k.code == KeyCode::Tab || k.code == KeyCode::BackTab => {
                self.focus = if self.focus == Focus::Grid { Focus::Tree } else { Focus::Grid };
                self.tree_follow = true;
                Outcome::None
            }
            _ if is_char(&k, '.') => self.act(Act::Hidden, self.key_target()),
            _ if is_char(&k, 'v') => self.act(Act::View, self.key_target()),
            _ if k.code == KeyCode::Backspace || k == Chord::normal(KeyCode::Up, KeyModifiers::ALT) => { self.up(); Outcome::None }
            _ if is_char(&k, 'n') && !self.standalone => Outcome::Harness(self.cwd.clone()),
            _ if is_char(&k, 't') => Outcome::Terminal(if self.focus == Focus::Tree { self.key_target().folder() } else { self.cwd.clone() }),
            _ if is_char(&k, 'y') => self.act(Act::CopyPath, self.key_target()),
            _ if k.code == KeyCode::F(2) && item => self.act(Act::Rename, self.key_target()),
            _ if k.code == KeyCode::Delete && item => self.act(Act::Delete, self.key_target()),
            _ if ctrl('c') && item => self.act(Act::Copy, self.key_target()),
            _ if ctrl('x') && item => self.act(Act::Cut, self.key_target()),
            _ if ctrl('d') && item => self.act(Act::Duplicate, self.key_target()),
            // (Pasted into the folder on show; with the explorer's keys, into its folder.)
            _ if ctrl('r') || k.code == KeyCode::F(5) => { self.head(Head::Refresh); Outcome::None }
            _ if ctrl('v') => {
                let t = if self.focus == Focus::Tree { self.key_target() } else { Target::Space(self.cwd.clone()) };
                self.act(Act::Paste, t)
            }
            _ if k.code == KeyCode::Menu || k == Chord::normal(KeyCode::F(10), KeyModifiers::SHIFT) => { self.menu_on_selection(g); Outcome::None }
            _ if self.focus == Focus::Tree => self.tree_key(k, g),
            _ => self.grid_key(k, g),
        }
    }

    /// The grid's keys: the arrows (hjkl) across and down its tiles (the list's rows), a page,
    /// its ends, Enter.
    fn grid_key(&mut self, k: Chord, g: Geom) -> Outcome {
        let n = self.listing.entries.len();
        let (cols, page, last, s) = (g.cols as usize, (g.cols * g.rows) as usize, n.saturating_sub(1), self.selected);
        let to = match () {
            _ if k.code == KeyCode::Enter || is_ctrl(&k, 'm') => return self.open_selected(),
            _ if k.code == KeyCode::Left || is_char(&k, 'h') => s.saturating_sub(1),
            _ if k.code == KeyCode::Right || is_char(&k, 'l') => (s + 1).min(last),
            _ if k.code == KeyCode::Up || is_char(&k, 'k') => if s >= cols { s - cols } else { s },
            // Down from the row above the last, short one: its last tile.
            _ if k.code == KeyCode::Down || is_char(&k, 'j') => if s + cols <= last { s + cols } else if s / cols < last / cols { last } else { s },
            _ if k.code == KeyCode::PageUp || is_ctrl(&k, 'b') => s.saturating_sub(page),
            _ if k.code == KeyCode::PageDown || is_ctrl(&k, 'f') => (s + page).min(last),
            _ if k.code == KeyCode::Home || is_char(&k, 'g') => 0,
            _ if k.code == KeyCode::End || is_char(&k, 'G') => last,
            _ => return Outcome::None,
        };
        if n > 0 { self.selected = to; self.follow = true }
        Outcome::None
    }

    /// The explorer's keys: up and down its rows, left closing a folder (else to its parent), right
    /// opening one (else into it), Enter showing it in the grid.
    fn tree_key(&mut self, k: Chord, g: Geom) -> Outcome {
        let (n, s) = (self.rows.len(), self.tree_sel);
        let (last, page) = (n.saturating_sub(1), g.tree.height.saturating_sub(1).max(1) as usize);
        let Some(row) = self.rows.get(s).cloned() else { return Outcome::None };
        let to = match () {
            _ if k.code == KeyCode::Enter || is_ctrl(&k, 'm') => { if !row.note { self.go(row.path, None) } return Outcome::None }
            _ if k.code == KeyCode::Up || is_char(&k, 'k') => s.saturating_sub(1),
            _ if k.code == KeyCode::Down || is_char(&k, 'j') => (s + 1).min(last),
            _ if k.code == KeyCode::PageUp || is_ctrl(&k, 'b') => s.saturating_sub(page),
            _ if k.code == KeyCode::PageDown || is_ctrl(&k, 'f') => (s + page).min(last),
            _ if k.code == KeyCode::Home || is_char(&k, 'g') => 0,
            _ if k.code == KeyCode::End || is_char(&k, 'G') => last,
            _ if k.code == KeyCode::Left || is_char(&k, 'h') => {
                if !row.note && self.expanded.contains(&row.path) { self.toggle(s); return Outcome::None }
                // (A note's folder is its path; a folder's, the one above.)
                let parent = if row.note { Some(row.path.as_path()) } else { row.path.parent() };
                match parent.and_then(|p| self.rows.iter().position(|r| !r.note && r.path == p)) { Some(i) => i, None => s }
            }
            _ if k.code == KeyCode::Right || is_char(&k, 'l') => {
                if !row.note && !self.expanded.contains(&row.path) { self.toggle(s); return Outcome::None }
                if self.rows.get(s + 1).is_some_and(|r| r.depth > row.depth) { s + 1 } else { s }
            }
            _ => return Outcome::None,
        };
        self.tree_sel = to;
        self.tree_follow = true;
        Outcome::None
    }

    // ── what the menu and its keys do ────────────────────────────────────────

    fn act(&mut self, act: Act, t: Target) -> Outcome {
        let item = match &t { Target::Item { path, dir } => Some((path.clone(), *dir)), Target::Space(_) => None };
        match act {
            Act::Open => match t {
                Target::Item { path, dir: false } => return self.open_file(path),
                Target::Item { path, .. } | Target::Space(path) => self.go(path, None),
            },
            Act::External => { if let Some((path, false)) = item { return Outcome::Edit(path) } }
            Act::NewFile | Act::NewFolder => {
                let ask = if act == Act::NewFile { Ask::NewFile } else { Ask::NewFolder };
                self.prompt = Some(Prompt::new(ask, t.folder(), Vec::new(), 0, None));
            }
            Act::Terminal => return Outcome::Terminal(t.folder()),
            Act::Cut | Act::Copy => {
                let Some((path, _)) = item else { return Outcome::None };
                let cut = act == Act::Cut;
                self.message = Some(format!("{} '{}' — paste it with C-v", if cut { "Cut" } else { "Copied" }, name_of(&path)));
                let text = path.to_string_lossy().into_owned();
                self.clip = Some((vec![path], cut));
                return Outcome::Clipboard(text);
            }
            Act::Paste => self.paste_into(&t.folder()),
            Act::Duplicate => {
                let Some((path, dir)) = item else { return Outcome::None };
                let parent = t.folder_of_item();
                let name = ops::free_name(&parent, &name_of(&path), dir);
                match ops::copy_all(&path, &parent.join(&name)) {
                    Ok(()) => { self.message = Some(format!("Duplicated as '{name}'")); self.refresh_in(&parent, &name) }
                    Err(e) => self.message = Some(format!("Couldn't duplicate '{}': {e}", name_of(&path))),
                }
            }
            Act::CopyPath | Act::CopyRelative => {
                let path = match &t { Target::Item { path, .. } | Target::Space(path) => path.clone() };
                let text = if act == Act::CopyPath { path.to_string_lossy().into_owned() } else {
                    match path.strip_prefix(&self.root) { Ok(r) if r.as_os_str().is_empty() => ".".into(), Ok(r) => r.to_string_lossy().into_owned(), Err(_) => path.to_string_lossy().into_owned() }
                };
                self.message = Some(format!("Copied {text}"));
                return Outcome::Clipboard(text);
            }
            Act::Rename => {
                let Some((path, dir)) = item else { return Outcome::None };
                let text: Vec<char> = name_of(&path).chars().collect();
                // The stem selected, as VS Code and Finder do (a folder's whole name).
                let stem = if dir { text.len() } else { text.iter().rposition(|c| *c == '.').filter(|i| *i > 0).unwrap_or(text.len()) };
                self.prompt = Some(Prompt::new(Ask::Rename(path.clone()), t.folder_of_item(), text, stem, Some(0)));
            }
            Act::Delete => { if let Some((path, _)) = item { self.confirm = Some(Confirm { doom: Doom::Trash(path), focus: 0 }) } }
            Act::Hidden => { self.hidden = !self.hidden; self.reload() }
            Act::View => self.set_view(if self.view == View::Gallery { View::List } else { View::Gallery }),
        }
        Outcome::None
    }

    /// After a change in [dir]: the folder on show and the explorer read again, [name] selected
    /// when it is the folder on show (else the new thing shown there).
    fn refresh_in(&mut self, dir: &Path, name: &str) {
        if dir == self.cwd { self.go(dir.to_path_buf(), Some(name)) } else { self.reload() }
    }

    /// What was cut or copied, into [dest].
    fn paste_into(&mut self, dest: &Path) {
        let Some((paths, cut)) = self.clip.clone() else { self.message = Some("Nothing to paste: cut or copy something first".into()); return };
        let (done, failed) = ops::paste(&paths, cut, dest);
        if cut && failed.is_empty() { self.clip = None }
        if cut { for p in &paths { if let Some(name) = done.iter().find(|n| **n == name_of(p)) { self.moved(p, &dest.join(name)) } } }
        self.message = Some(match (done.as_slice(), failed.is_empty()) {
            (_, false) => format!("Couldn't paste {}", failed.join("; ")),
            ([one], true) => format!("Pasted '{one}'"),
            (all, true) => format!("Pasted {} items", all.len()),
        });
        let last = done.last().cloned().unwrap_or_default();
        self.refresh_in(dest, &last);
    }

    /// [from] is [to] now: the folder on show, the root and the open folders follow it.
    fn moved(&mut self, from: &Path, to: &Path) {
        let fix = |p: &Path| p.strip_prefix(from).ok().map(|r| if r.as_os_str().is_empty() { to.to_path_buf() } else { to.join(r) });
        if let Some(c) = fix(&self.cwd) { self.cwd = c }
        if let Some(r) = fix(&self.root) { self.root = r }
        self.expanded = self.expanded.iter().map(|p| fix(p).unwrap_or_else(|| p.clone())).collect();
    }

    /// [path] is gone: the folder on show (and the root) go up out of it.
    fn gone(&mut self, path: &Path) {
        let up = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/"));
        if self.cwd.starts_with(path) { self.cwd = up.clone() }
        if self.root.starts_with(path) { self.root = up }
        self.expanded.retain(|p| !p.starts_with(path));
    }

    // ── the context menu ─────────────────────────────────────────────────────

    /// The menu's items for [t], as VS Code's explorer groups them.
    fn menu_items(&self, t: &Target) -> Vec<Option<Item>> {
        let it = |label: &str, key: &'static str, act: Act, on: bool| Some(Item { label: label.into(), key, act, on });
        let paste = self.clip.is_some();
        // (The root of the disk has no folder to be renamed or deleted from.)
        let movable = matches!(t, Target::Item { path, .. } if path.parent().is_some() && !(self.bounded && *path == self.root));
        // (Open in Editor is Open itself where files open in $EDITOR.)
        let items = match t {
            Target::Item { dir: false, .. } => vec![
                it("Open", "Enter", Act::Open, true), it("Open in Editor ($EDITOR)", "e", Act::External, true),
                it("Open in Terminal", "t", Act::Terminal, true), None,
                it("Cut", "C-x", Act::Cut, true), it("Copy", "C-c", Act::Copy, true), it("Paste", "C-v", Act::Paste, paste), it("Duplicate", "C-d", Act::Duplicate, true), None,
                it("Copy Path", "y", Act::CopyPath, true), it("Copy Relative Path", "", Act::CopyRelative, true), None,
                it("Rename…", "F2", Act::Rename, movable), it("Delete", "Del", Act::Delete, movable),
            ],
            Target::Item { .. } => vec![
                it("Open", "Enter", Act::Open, true), it("New File…", "", Act::NewFile, true), it("New Folder…", "", Act::NewFolder, true), it("Open in Terminal", "t", Act::Terminal, true), None,
                it("Cut", "C-x", Act::Cut, movable), it("Copy", "C-c", Act::Copy, true), it("Paste", "C-v", Act::Paste, paste), None,
                it("Copy Path", "y", Act::CopyPath, true), it("Copy Relative Path", "", Act::CopyRelative, true), None,
                it("Rename…", "F2", Act::Rename, movable), it("Delete", "Del", Act::Delete, movable),
            ],
            Target::Space(_) => vec![
                it("New File…", "", Act::NewFile, true), it("New Folder…", "", Act::NewFolder, true), None,
                it("Paste", "C-v", Act::Paste, paste), None,
                it("Open in Terminal", "t", Act::Terminal, true), it("Copy Path", "y", Act::CopyPath, true), None,
                it(if self.hidden { "Hide Hidden Files" } else { "Show Hidden Files" }, ".", Act::Hidden, true),
                it(if self.view == View::Gallery { "View as List" } else { "View as Gallery" }, "v", Act::View, true),
            ],
        };
        items.into_iter().filter(|i| self.builtin || i.as_ref().is_none_or(|i| i.act != Act::External)).collect()
    }

    /// The menu for [t] with its corner at (x, y), kept inside the view; [keys]: its first item
    /// selected (opened from the keyboard).
    fn open_menu(&mut self, t: Target, x: u16, y: u16, g: Geom, keys: bool) {
        let items = self.menu_items(&t);
        let mut m = Menu { target: t, items, x, y, sel: None };
        let r = menu_box(&m);
        m.x = x.min(g.size.0.saturating_sub(r.width));
        m.y = y.min(g.size.1.saturating_sub(r.height));
        if keys { m.sel = m.items.iter().position(|i| i.as_ref().is_some_and(|i| i.on)) }
        self.menu = Some(m);
    }

    /// The Menu key (S-F10): the menu for what the keys are on, beside it.
    fn menu_on_selection(&mut self, g: Geom) {
        let t = self.key_target();
        let (x, y) = match self.focus {
            Focus::Tree => (g.tree.x + 4, (1 + self.tree_sel.saturating_sub(self.tree_scroll) + 1) as u16),
            Focus::Grid => match self.item_rect(self.selected, g) { Some(r) if matches!(t, Target::Item { .. }) => (r.x + 2, r.y + 1), _ => (g.grid.x + 2, g.items_y) },
        };
        self.open_menu(t, x, y, g, true);
    }

    fn menu_key(&mut self, k: Chord) -> Outcome {
        let Some(m) = self.menu.as_mut() else { return Outcome::None };
        let on: Vec<usize> = m.items.iter().enumerate().filter(|(_, i)| i.as_ref().is_some_and(|i| i.on)).map(|(n, _)| n).collect();
        let at = m.sel.and_then(|s| on.iter().position(|n| *n == s));
        match () {
            _ if k.code == KeyCode::Esc || is_char(&k, 'q') || is_ctrl(&k, 'g') || k.code == KeyCode::Menu => self.menu = None,
            _ if k.code == KeyCode::Down || is_char(&k, 'j') || k.code == KeyCode::Tab => m.sel = at.map(|a| on[(a + 1) % on.len()]).or(on.first().copied()),
            _ if k.code == KeyCode::Up || is_char(&k, 'k') || k.code == KeyCode::BackTab => m.sel = at.map(|a| on[(a + on.len() - 1) % on.len()]).or(on.last().copied()),
            _ if k.code == KeyCode::Home => m.sel = on.first().copied(),
            _ if k.code == KeyCode::End => m.sel = on.last().copied(),
            _ if k.code == KeyCode::Enter || is_ctrl(&k, 'm') => { if let Some(s) = m.sel { return self.choose(s) } }
            _ => {}
        }
        Outcome::None
    }

    /// The menu's item [i] chosen: the menu gone, the item done.
    fn choose(&mut self, i: usize) -> Outcome {
        let Some(m) = self.menu.take() else { return Outcome::None };
        match m.items.get(i).cloned().flatten() { Some(item) if item.on => self.act(item.act, m.target), _ => { self.menu = Some(m); Outcome::None } }
    }

    /// The menu's item at (x, y), when it is on one.
    fn menu_at(&self, x: u16, y: u16) -> Option<usize> {
        let m = self.menu.as_ref()?;
        let r = menu_box(m);
        (x > r.x && x + 1 < r.x + r.width && y > r.y && y + 1 < r.y + r.height).then(|| (y - r.y - 1) as usize)
    }

    /// The explorer title's buttons at its right: each one's columns and what it is — none when
    /// the explorer is too narrow for them (the title gives way to them first).
    fn heads(&self, g: Geom) -> Vec<(u16, u16, Head)> {
        let t = g.tree;
        let widths: Vec<u16> = Head::ALL.iter().map(|h| h.icon(self.nerd).width() as u16).collect();
        let total = widths.iter().sum::<u16>() + widths.len() as u16 - 1;
        if t.width < total + 2 { return Vec::new() }
        let mut x = t.x + t.width - 1 - total;
        Head::ALL.iter().zip(widths).map(|(h, w)| { let b = (x, x + w, *h); x += w + 1; b }).collect()
    }

    /// A title button: New File and New Folder ask for a name in the explorer's selected folder
    /// (with it in focus), else the folder on show; Refresh reads everything shown again; Collapse
    /// All closes every folder but the root.
    fn head(&mut self, h: Head) {
        let t = if self.focus == Focus::Tree { self.key_target() } else { Target::Space(self.cwd.clone()) };
        match h {
            Head::NewFile => { self.act(Act::NewFile, t); }
            Head::NewFolder => { self.act(Act::NewFolder, t); }
            Head::Refresh => {
                let keep = self.rows.get(self.tree_sel).map(|r| r.path.clone());
                self.reload();
                if let Some(i) = keep.and_then(|p| self.rows.iter().position(|r| !r.note && r.path == p)) { self.tree_sel = i }
                self.message = Some("Refreshed".into());
            }
            Head::Collapse => {
                let root = self.root.clone();
                self.expanded.retain(|p| *p == root);
                self.build_tree();
                (self.tree_sel, self.tree_scroll, self.tree_follow) = (0, 0, false);
            }
        }
    }

    /// A drag with the button down: in the editor, a selection.
    fn drag(&mut self, x: u16, y: u16) { if let Some(e) = self.editor.as_mut() { e.click(x, y, true) } }

    /// The mouse over the menu: the item under it lit (none on a rule or a dimmed one).
    fn hover(&mut self, x: u16, y: u16, g: Geom) {
        self.head_hover = None;
        if self.menu.is_none() && self.editor.is_none() && y == 0 {
            self.head_hover = self.heads(g).into_iter().find(|(a, z, _)| x >= *a && x < *z).map(|(.., h)| h);
        }
        let at = self.menu_at(x, y);
        if let Some(m) = self.menu.as_mut() { m.sel = at.filter(|i| m.items.get(*i).is_some_and(|it| it.as_ref().is_some_and(|it| it.on))) }
    }

    // ── the name prompt and the confirmation ─────────────────────────────────

    fn prompt_key(&mut self, k: Chord) -> Outcome {
        let Some(p) = self.prompt.as_mut() else { return Outcome::None };
        let typed = matches!(k.code, KeyCode::Char(_)) && !k.mods.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER);
        // Tab takes the keys to the buttons and back; a printable key is typed wherever they were.
        // (↓ from the input to the buttons, ↑ back up, as Tab goes either way.)
        let across = match k.code { KeyCode::Tab | KeyCode::BackTab => true, KeyCode::Down => !p.buttons, KeyCode::Up => p.buttons, _ => false };
        if across { p.buttons = !p.buttons; return Outcome::None }
        if typed { p.buttons = false }
        if p.buttons {
            let mut row = p.row();
            let code = if is_ctrl(&k, 'm') { KeyCode::Enter } else { k.code };
            match row.key(code, k.mods) {
                Answer::Moved => p.chosen = row.chosen,
                Answer::Chosen(1) => self.accept(),
                Answer::Chosen(_) | Answer::Cancel => self.prompt = None,
                Answer::Ignored => {}
            }
            return Outcome::None;
        }
        match k.code {
            KeyCode::Esc => self.prompt = None,
            _ if is_ctrl(&k, 'c') || is_ctrl(&k, 'g') => self.prompt = None,
            KeyCode::Enter => self.accept(),
            KeyCode::Backspace => { if !p.cut() && p.cursor > 0 { p.cursor -= 1; p.text.remove(p.cursor); } }
            KeyCode::Delete => { if !p.cut() && p.cursor < p.text.len() { p.text.remove(p.cursor); } }
            KeyCode::Left => { p.mark = None; p.cursor = p.cursor.saturating_sub(1) }
            KeyCode::Right => { p.mark = None; p.cursor = (p.cursor + 1).min(p.text.len()) }
            KeyCode::Home => { p.mark = None; p.cursor = 0 }
            KeyCode::End => { p.mark = None; p.cursor = p.text.len() }
            _ if is_ctrl(&k, 'u') => { p.mark = None; p.text.clear(); p.cursor = 0 }
            _ if is_ctrl(&k, 'a') => { p.mark = None; p.cursor = 0 }
            _ if is_ctrl(&k, 'e') => { p.mark = None; p.cursor = p.text.len() }
            KeyCode::Char(c) if typed => {
                // (hn spells a capital as its letter with S-.)
                let c = if k.mods.contains(KeyModifiers::SHIFT) { c.to_uppercase().next().unwrap_or(c) } else { c };
                p.cut();
                p.text.insert(p.cursor, c);
                p.cursor += 1;
            }
            _ => {}
        }
        Outcome::None
    }

    /// Enter in the name prompt: the name checked (what is wrong said in the footer, the prompt
    /// staying), then the file or folder made, or the thing renamed — and selected.
    fn accept(&mut self) {
        let Some(p) = self.prompt.clone() else { return };
        let name: String = p.text.iter().collect();
        let was = match &p.ask { Ask::Rename(path) => Some(name_of(path)), _ => None };
        if let Err(e) = ops::check_name(&p.dir, &name, was.as_deref()) { self.message = Some(e); return }
        let done = match &p.ask {
            Ask::NewFile => ops::new_file(&p.dir, &name).map(|_| format!("Created '{name}'")),
            Ask::NewFolder => ops::new_folder(&p.dir, &name).map(|_| format!("Created '{name}'")),
            Ask::Rename(path) if was.as_deref() == Some(name.as_str()) => Ok(String::new()),
            Ask::Rename(path) => ops::rename(path, &name).map(|to| { self.moved(path, &to); format!("Renamed to '{name}'") }),
        };
        match done {
            Ok(said) => {
                self.prompt = None;
                self.message = (!said.is_empty()).then_some(said);
                if matches!(p.ask, Ask::Rename(_)) { self.refresh_in(&p.dir, &name) } else { self.go(p.dir.clone(), Some(&name)) }
            }
            Err(e) => self.message = Some(format!("Couldn't {} '{name}': {e}", if was.is_some() { "rename to" } else { "create" })),
        }
    }

    fn confirm_key(&mut self, k: Chord) -> Outcome {
        if self.confirm.is_none() { return Outcome::None }
        let mut row = self.confirm_row();
        let code = if is_ctrl(&k, 'm') { KeyCode::Enter } else { k.code };
        match row.key(code, k.mods) {
            Answer::Moved => if let Some(c) = self.confirm.as_mut() { c.focus = row.chosen },
            Answer::Chosen(1) => self.confirmed(),
            Answer::Chosen(_) | Answer::Cancel => self.confirm = None,
            // The files' own way out besides Esc: q and n.
            Answer::Ignored => if is_char(&k, 'q') || is_char(&k, 'n') { self.confirm = None },
        }
        Outcome::None
    }

    /// The confirmation's buttons, Cancel first, the one with the keys chosen.
    fn confirm_row(&self) -> ButtonRow {
        let yes = match self.confirm.as_ref().map(|c| &c.doom) { Some(Doom::Purge(..)) => "Delete Permanently", _ => "Delete" };
        let button = |label: &str| Button { label: label.into(), key: None };
        ButtonRow { buttons: vec![button("Cancel"), button(yes)], chosen: self.confirm.as_ref().map_or(0, |c| c.focus), hint: crate::buttons::KEYS.into() }
    }

    /// Yes to the confirmation: to the Trash — or, when it can't go there, a second question before
    /// it is gone for good; never without one.
    fn confirmed(&mut self) {
        let Some(c) = self.confirm.take() else { return };
        match c.doom {
            Doom::Trash(path) => match ops::trash(&path, &self.trash) {
                Ok(_) => { self.gone(&path); self.message = Some(format!("Moved '{}' to the Trash", name_of(&path))); self.reload() }
                Err(e) => self.confirm = Some(Confirm { doom: Doom::Purge(path, e.to_string()), focus: 0 }),
            },
            Doom::Purge(path, _) => match ops::remove_all(&path) {
                Ok(()) => { self.gone(&path); self.message = Some(format!("Deleted '{}'", name_of(&path))); self.reload() }
                Err(e) => self.message = Some(format!("Couldn't delete '{}': {e}", name_of(&path))),
            },
        }
    }

    // ── the mouse ────────────────────────────────────────────────────────────

    /// A click at (x, y) in the view: in a confirmation its buttons; the prompt's outside cancels
    /// it; the menu's item is chosen (outside, it closes). Else a part of the path bar goes there,
    /// the view switch switches, a tile (a row) is selected — opened, [double] — and an explorer
    /// folder is shown and opened or closed (its chevron only that).
    fn click(&mut self, x: u16, y: u16, double: bool, g: Geom) -> Outcome {
        self.message = None;
        if let Some(e) = self.editor.as_mut() { e.click(x, y, false); return Outcome::None }
        let g = geom(g.size.0, g.size.1, self.view);
        let out = self.click_at(x, y, double, g);
        self.fit(g);
        out
    }

    fn click_at(&mut self, x: u16, y: u16, double: bool, g: Geom) -> Outcome {
        if self.confirm.is_some() {
            let Some((.., row)) = self.confirm_layout(g) else { return Outcome::None };
            if let Some(b) = self.confirm_row().click(row, Position::new(x, y)) { if b == 1 { self.confirmed() } else { self.confirm = None } }
            return Outcome::None;
        }
        if self.prompt.is_some() {
            let at = Position::new(x, y);
            match self.prompt_layout(g) {
                // On the dialog: a button answers, the input gets the keys; its rule does nothing.
                Some((r, a)) if r.contains(at) => {
                    let Some(p) = self.prompt.as_mut() else { return Outcome::None };
                    if let Some(b) = p.row().click(a.row, at) { if b == 1 { self.accept() } else { self.prompt = None } }
                    else if a.input.is_some_and(|i| i.contains(at)) { p.buttons = false }
                }
                _ => self.prompt = None,
            }
            return Outcome::None;
        }
        if self.menu.is_some() {
            return match self.menu_at(x, y) { Some(i) => self.choose(i), None => { if !self.menu.as_ref().is_some_and(|m| contains(menu_box(m), x, y)) { self.menu = None } Outcome::None } };
        }
        if y == 0 && g.in_tree(x) && let Some((.., h)) = self.heads(g).into_iter().find(|(a, z, _)| x >= *a && x < *z) {
            if !double { self.head(h) }
            return Outcome::None;
        }
        if g.in_tree(x) {
            self.focus = Focus::Tree;
            // (Its first click has done what a double one would.)
            if double || y < g.tree.y + 1 { return Outcome::None }
            let i = self.tree_scroll + (y - g.tree.y - 1) as usize;
            let Some(row) = self.rows.get(i).cloned() else { return Outcome::None };
            self.tree_sel = i;
            if row.note { return Outcome::None }
            let chevron = g.tree.x + 1 + row.depth * 2;
            if x == chevron { self.toggle(i); return Outcome::None }
            let was = self.expanded.contains(&row.path);
            self.go(row.path.clone(), None);
            if was { self.expanded.remove(&row.path); self.build_tree(); self.tree_on_cwd() }
            return Outcome::None;
        }
        if y == 0 {
            if double { return Outcome::None }
            if let Some((.., v, _)) = self.switch(g).into_iter().find(|(a, z, ..)| x >= *a && x < *z) { self.set_view(v); return Outcome::None }
            let (_, crumbs) = self.crumbs(g);
            if let Some((_, _, path, _)) = crumbs.into_iter().find(|(a, b, ..)| x >= *a && x < *b) {
                let child = self.cwd.strip_prefix(&path).ok().and_then(|r| r.components().next()).map(|c| c.as_os_str().to_string_lossy().into_owned());
                if path != self.cwd { self.go(path, child.as_deref()) }
            }
            return Outcome::None;
        }
        self.focus = Focus::Grid;
        let Some(i) = self.item_at(x, y, g) else { return Outcome::None };
        self.selected = i;
        if double { self.open_selected() } else { Outcome::None }
    }

    /// A right click at (x, y): what is under it selected, and the menu for it there — an explorer
    /// folder, an entry, else the folder's empty space (the explorer's: its root).
    fn right_click(&mut self, x: u16, y: u16, g: Geom) {
        self.message = None;
        if self.editor.is_some() || self.confirm.is_some() || self.prompt.is_some() { return }
        self.menu = None;
        let g = geom(g.size.0, g.size.1, self.view);
        let t = if g.in_tree(x) {
            self.focus = Focus::Tree;
            let i = (y >= 1).then(|| self.tree_scroll + (y - 1) as usize);
            match i.and_then(|i| self.rows.get(i).filter(|r| !r.note).map(|r| (i, r.path.clone()))) {
                Some((i, path)) => { self.tree_sel = i; Target::Item { path, dir: true } }
                None => Target::Space(self.root.clone()),
            }
        } else {
            self.focus = Focus::Grid;
            match self.item_at(x, y, g) {
                Some(i) => { self.selected = i; let e = &self.listing.entries[i]; Target::Item { path: self.cwd.join(&e.name), dir: e.dir } }
                None => Target::Space(self.cwd.clone()),
            }
        };
        self.open_menu(t, x, y, g, false);
    }

    /// Where entry [i] is on screen (its tile, its row), when it is.
    fn item_rect(&self, i: usize, g: Geom) -> Option<Rect> {
        let (cols, row) = (g.cols as usize, (i / g.cols as usize).checked_sub(self.scroll)?);
        if row >= g.rows as usize { return None }
        Some(Rect::new(g.grid.x + (i % cols) as u16 * g.item_w, g.items_y + row as u16 * g.item_h, g.item_w, g.item_h))
    }

    /// The entry whose tile (row) is at (x, y).
    fn item_at(&self, x: u16, y: u16, g: Geom) -> Option<usize> {
        let r = g.grid;
        if x < r.x || y < g.items_y || x >= r.x + g.cols * g.item_w || y >= g.items_y + g.rows * g.item_h { return None }
        let (col, row) = ((x - r.x) / g.item_w, (y - g.items_y) / g.item_h);
        let i = (self.scroll + row as usize) * g.cols as usize + col as usize;
        (i < self.listing.entries.len()).then_some(i)
    }

    /// The wheel: the explorer's rows three at a time under the mouse there, else the grid's (the
    /// list's three). A menu up closes.
    fn wheel(&mut self, x: u16, down: bool, g: Geom) {
        if let Some(e) = self.editor.as_mut() { return e.wheel(down) }
        if self.confirm.is_some() || self.prompt.is_some() { return }
        self.menu = None;
        let step = if g.in_tree(x) || self.view == View::List { 3 } else { 1 };
        let at = if g.in_tree(x) { &mut self.tree_scroll } else { &mut self.scroll };
        *at = if down { *at + step } else { at.saturating_sub(step) };
        self.fit(g);
    }

    // ── drawing ──────────────────────────────────────────────────────────────

    /// The view switch at the right of the path bar (none in a narrow grid): each half's columns,
    /// its view and its words.
    fn switch(&self, g: Geom) -> Vec<(u16, u16, View, &'static str)> {
        const PARTS: [(View, &str); 2] = [(View::Gallery, " ▦ Gallery "), (View::List, " ☰ List ")];
        if g.grid.width < 50 { return Vec::new() }
        let mut x = g.grid.x + g.grid.width - 1 - PARTS.iter().map(|(_, s)| s.width() as u16).sum::<u16>() - 1;
        PARTS.iter().map(|(v, s)| { let w = s.width() as u16; let part = (x, x + w, *v, *s); x += w + 1; part }).collect()
    }

    /// The path bar's parts, over the grid (left of the view switch): each one's columns, folder
    /// and name — from home (~) when under it, else from /; the first ones left out (…) when they
    /// don't all fit.
    fn crumbs(&self, g: Geom) -> (bool, Vec<(u16, u16, PathBuf, String)>) {
        let switch = self.switch(g).first().map(|(a, ..)| g.grid.x + g.grid.width - a + 1).unwrap_or(0);
        let width = g.grid.width.saturating_sub(switch);
        let home = home();
        // (A bounded explorer's from its root, nothing above it.)
        let (mut at, mut parts) = if self.bounded { (self.root.clone(), vec![(name_of(&self.root), self.root.clone())]) }
            else if home != Path::new("/") && self.cwd.starts_with(&home) { (home.clone(), vec![("~".to_string(), home)]) }
            else { (PathBuf::from("/"), vec![("/".to_string(), PathBuf::from("/"))]) };
        let rest = self.cwd.strip_prefix(&at).map(Path::to_path_buf).unwrap_or_default();
        for c in rest.components() { at.push(c); parts.push((c.as_os_str().to_string_lossy().into_owned(), at.clone())) }
        let size = |p: &[(String, PathBuf)], cut: bool| p.iter().map(|(n, _)| n.width() + 3).sum::<usize>() - 2 + if cut { 4 } else { 0 };
        let mut cut = false;
        // (A column spare at the right, as at the left.)
        while parts.len() > 1 && size(&parts, cut) + 1 > width as usize { parts.remove(0); cut = true }
        let mut x = 1 + if cut { 4 } else { 0 };
        let out = parts.into_iter().map(|(name, path)| {
            let name = fit(&name, width.saturating_sub(x + 1) as usize);
            let w = name.width() as u16;
            let part = (g.grid.x + x, g.grid.x + x + w, path, name);
            x += w + 3;
            part
        }).collect();
        (cut, out)
    }

    fn draw(&mut self, buf: &mut Buffer, area: Rect, look: &Look) {
        if let Some(e) = self.editor.as_mut() { return e.draw(buf, area, look) }
        let g = geom(area.width, area.height, self.view);
        self.fit(g);
        for y in area.top()..area.bottom() { for x in area.left()..area.right() { if let Some(c) = buf.cell_mut((x, y)) { c.set_symbol(" "); } } }
        let (ox, oy) = (area.x, area.y);
        let (gx, gw) = (g.grid.x, g.grid.width);
        let right = gx + gw;
        // The path bar and the view switch, then the keys.
        let (cut, crumbs) = self.crumbs(g);
        if cut { put(buf, ox + gx + 1, oy, gw.saturating_sub(1), "… › ", look.muted); }
        let n = crumbs.len();
        for (i, (a, _, _, name)) in crumbs.into_iter().enumerate() {
            let st = if i + 1 == n { look.text.add_modifier(Modifier::BOLD) } else { look.text };
            put(buf, ox + a, oy, right.saturating_sub(a), &name, st);
            if i + 1 < n { let w = name.width() as u16; put(buf, ox + a + w, oy, right.saturating_sub(a + w), " › ", look.muted); }
        }
        for (a, z, v, s) in self.switch(g) { put(buf, ox + a, oy, z - a, s, if v == self.view { look.mode } else { look.muted }); }
        let harness = if self.standalone { "" } else { " · n harness" };
        let edit = if self.builtin { " · e $EDITOR" } else { "" };
        let hint = match self.focus {
            Focus::Grid => format!("Enter open{edit} · Backspace up · Tab explorer · v view · . hidden{harness} · t terminal · F2 rename · Del trash · C-c C-x C-v · right-click for more · q close"),
            Focus::Tree => format!("Enter show · ←→ close/open · Tab grid · v view · . hidden{harness} · t terminal · F2 rename · Del trash · right-click for more · q close"),
        };
        put(buf, ox + gx + 1, oy + 1, gw.saturating_sub(2), &fit(&hint, gw.saturating_sub(2) as usize), look.muted);
        match self.view { View::Gallery => self.draw_gallery(buf, area, g, look), View::List => self.draw_list(buf, area, g, look) }
        self.draw_footer(buf, area, g, look);
        self.draw_tree(buf, area, g, look);
        self.draw_popups(buf, area, g, look);
        // A question with no room to be drawn must not stay open to answering keys.
        let unfit = (self.prompt.is_some() && self.prompt_layout(g).is_none()) || (self.confirm.is_some() && self.confirm_layout(g).is_none());
        if unfit {
            (self.prompt, self.confirm) = (None, None);
            self.message = Some(crate::workspace_menu::TOO_SMALL_TO_ANSWER.into());
        }
    }

    /// What the grid says in place of entries: why the folder can't be read, or that it is empty.
    fn draw_none(&self, buf: &mut Buffer, area: Rect, g: Geom, look: &Look) -> bool {
        let (r, w) = (g.grid, g.grid.width.saturating_sub(2));
        let (ox, y) = (area.x + r.x + 1, area.y + g.items_y);
        if let Some(e) = &self.listing.error { put(buf, ox, y, w, &fit(&format!("Can't open this folder: {e}"), w as usize), look.warn); return true }
        if self.listing.entries.is_empty() {
            let empty = if self.hidden { "This folder is empty" } else { "This folder is empty (. shows hidden files)" };
            put(buf, ox, y, w, &fit(empty, w as usize), look.muted);
            return true;
        }
        false
    }

    fn draw_gallery(&self, buf: &mut Buffer, area: Rect, g: Geom, look: &Look) {
        if self.draw_none(buf, area, g, look) { return }
        for (i, e) in self.listing.entries.iter().enumerate().skip(self.scroll * g.cols as usize).take((g.cols * g.rows) as usize) {
            let Some(r) = self.item_rect(i, g) else { continue };
            // (A view too small for a whole tile shows none.)
            if r.y + TILE_H - 1 > g.footer || g.grid.width < TILE_W { break }
            self.draw_tile(buf, area.x + r.x + 1, area.y + r.y, e, i == self.selected, look);
        }
    }

    /// A tile: its picture (a folder, or a page with its extension) over its name (one line, cut
    /// short as `shorten` does); all of it lit when it is the grid's selection (only its name
    /// marked while the explorer has the keys).
    fn draw_tile(&self, buf: &mut Buffer, x: u16, y: u16, e: &Entry, selected: bool, look: &Look) {
        tile(buf, x, y, e, selected && self.focus == Focus::Grid, selected && self.focus == Focus::Tree, look)
    }

    /// The list: a header, then a row each — icon, name, size (a folder's items), when it was
    /// changed and its kind, the narrower the view the fewer columns.
    fn draw_list(&self, buf: &mut Buffer, area: Rect, g: Geom, look: &Look) {
        let (ox, oy) = (area.x, area.y);
        let (x0, right) = (g.grid.x + 1, g.grid.x + g.grid.width.saturating_sub(1));
        let icon_w = if self.nerd { 2 } else { 4 };
        let width = right.saturating_sub(x0);
        let (size_w, date_w, kind_w) = (10, 12, 16);
        let (show_size, show_date, show_kind) = (width >= 40, width >= 56, width >= 76);
        let fixed = icon_w + if show_size { size_w + 2 } else { 0 } + if show_date { date_w + 2 } else { 0 } + if show_kind { kind_w + 2 } else { 0 };
        let name_w = width.saturating_sub(fixed);
        // Each column's start, after the name.
        let size_x = x0 + icon_w + name_w + 2;
        let date_x = size_x + if show_size { size_w + 2 } else { 0 };
        let kind_x = date_x + if show_date { date_w + 2 } else { 0 };
        let head = look.muted.add_modifier(Modifier::BOLD);
        let hy = oy + g.items_y - 1;
        put(buf, ox + x0 + icon_w, hy, name_w, "Name", head);
        if show_size { put(buf, ox + size_x + size_w - 4, hy, 4, "Size", head); }
        if show_date { put(buf, ox + date_x, hy, date_w, "Modified", head); }
        if show_kind { put(buf, ox + kind_x, hy, kind_w, "Kind", head); }
        if self.draw_none(buf, area, g, look) { return }
        let now = SystemTime::now();
        for (i, e) in self.listing.entries.iter().enumerate().skip(self.scroll).take(g.rows as usize) {
            let y = oy + g.items_y + (i - self.scroll) as u16;
            let icon_st = if e.dir { look.accent } else { file_style(&e.name, look) };
            put(buf, ox + x0, y, icon_w, &format!("{} ", icon(e, self.nerd)), icon_st);
            let selected = i == self.selected;
            let name_st = if selected && self.focus == Focus::Tree { look.text.add_modifier(Modifier::BOLD | Modifier::UNDERLINED) } else if e.dir { look.text.add_modifier(Modifier::BOLD) } else { look.text };
            put(buf, ox + x0 + icon_w, y, name_w, &shorten(&e.name, e.dir, name_w as usize), name_st);
            if show_size {
                let size = if !e.dir { ops::human_size(e.size) } else {
                    match self.counts.get(&e.name) { Some(Some(1)) => "1 item".into(), Some(Some(n)) => format!("{n} items"), _ => "—".into() }
                };
                let s = fit(&size, size_w as usize);
                put(buf, ox + size_x + size_w - s.width() as u16, y, size_w, &s, look.muted);
            }
            if show_date { put(buf, ox + date_x, y, date_w, &e.modified.map(|t| ops::when(t, now)).unwrap_or_else(|| "—".into()), look.muted); }
            if show_kind { put(buf, ox + kind_x, y, kind_w, &fit(&ops::kind(&e.name, e.dir), kind_w as usize), look.muted); }
            if selected && self.focus == Focus::Grid {
                for cx in ox + x0..ox + right { if let Some(c) = buf.cell_mut((cx, y)) { c.set_style(look.mode); } }
            }
        }
    }

    /// The footer: what the folder has and does not show — or what was just done.
    fn draw_footer(&self, buf: &mut Buffer, area: Rect, g: Geom, look: &Look) {
        let (r, entries) = (g.grid, &self.listing.entries);
        if g.footer < r.y { return }
        let dirs = entries.iter().filter(|e| e.dir).count();
        let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
        let mut text = format!("{}, {}", plural(dirs, "folder", "folders"), plural(entries.len() - dirs, "file", "files"));
        if self.hidden { text.push_str(" · hidden shown") }
        if let Some((paths, cut)) = &self.clip { text.push_str(&format!(" · {} {} to paste", paths.len(), if *cut { "cut" } else { "copied" })) }
        let st = if self.message.is_some() { look.accent } else { look.muted };
        if let Some(m) = &self.message { text = m.clone() } else if let Some(h) = self.head_hover { text = h.tip().to_string() }
        let (x, y, w) = (area.x + r.x + 1, area.y + g.footer, r.width.saturating_sub(2));
        let used = put(buf, x, y, w, &fit(&text, w as usize), st);
        if self.listing.more > 0 && self.message.is_none() {
            put(buf, x + used, y, w.saturating_sub(used), &format!("  … {} more not shown", self.listing.more), look.warn);
        }
    }

    /// The explorer: its title, then its rows — each folder's chevron at its depth, the guides of
    /// the folders it is in, its name; the folder on show lit, the selection mode-style with the keys.
    fn draw_tree(&self, buf: &mut Buffer, area: Rect, g: Geom, look: &Look) {
        let t = g.tree;
        if t.width == 0 { return }
        let (ox, oy) = (area.x, area.y);
        for y in 0..t.height { put(buf, ox + t.x + t.width, oy + y, 1, "│", look.muted); }
        let heads = self.heads(g);
        let title_room = heads.first().map(|(a, ..)| a.saturating_sub(t.x + 2)).unwrap_or(t.width.saturating_sub(2));
        if title_room >= 8 { put(buf, ox + t.x + 1, oy, title_room, "EXPLORER", look.muted.add_modifier(Modifier::BOLD)); }
        for (a, z, h) in heads { put(buf, ox + a, oy, z - a, h.icon(self.nerd), if self.head_hover == Some(h) { look.mode } else { look.text }); }
        let shown = t.height.saturating_sub(1) as usize;
        for (k, row) in self.rows.iter().enumerate().skip(self.tree_scroll).take(shown) {
            let y = oy + 1 + (k - self.tree_scroll) as u16;
            let (x0, right) = (ox + t.x + 1, ox + t.x + t.width);
            for l in 0..row.depth { put(buf, x0 + l * 2, y, right.saturating_sub(x0 + l * 2), "│", look.muted); }
            let mut x = x0 + row.depth * 2;
            if row.note {
                put(buf, x, y, right.saturating_sub(x), &row.name, look.muted.add_modifier(Modifier::ITALIC));
            } else {
                let open = self.expanded.contains(&row.path);
                x += put(buf, x, y, right.saturating_sub(x), if open { "▾ " } else { "▸ " }, look.muted);
                if self.nerd { x += put(buf, x, y, right.saturating_sub(x), if open { "\u{f07c} " } else { "\u{f07b} " }, look.accent) }
                let here = row.path == self.cwd;
                let st = if here { look.accent.add_modifier(Modifier::BOLD) } else if row.depth == 0 { look.text.add_modifier(Modifier::BOLD) } else { look.text };
                put(buf, x, y, right.saturating_sub(x), &fit(&row.name, right.saturating_sub(x) as usize), st);
            }
            if k == self.tree_sel && self.focus == Focus::Tree {
                for cx in ox + t.x..right { if let Some(c) = buf.cell_mut((cx, y)) { c.set_style(look.mode); } }
            }
        }
    }

    /// The menu, the name prompt and the confirmation, over the rest.
    fn draw_popups(&self, buf: &mut Buffer, area: Rect, g: Geom, look: &Look) {
        let at = |r: Rect| Rect::new(area.x + r.x, area.y + r.y, r.width, r.height).intersection(area);
        if let Some(m) = &self.menu {
            let r = at(menu_box(m));
            frame(buf, r, look.muted);
            let inner = r.width.saturating_sub(2);
            for (i, item) in m.items.iter().enumerate() {
                let y = r.y + 1 + i as u16;
                let Some(item) = item else { put(buf, r.x, y, r.width, &format!("├{}┤", "─".repeat(inner as usize)), look.muted); continue };
                let st = if !item.on { look.muted } else if m.sel == Some(i) { look.mode } else { look.text };
                put(buf, r.x + 1, y, inner, &" ".repeat(inner as usize), st);
                put(buf, r.x + 2, y, inner.saturating_sub(2), &item.label, st);
                let kw = item.key.width() as u16;
                if kw > 0 { put(buf, r.x + r.width - 2 - kw, y, kw, item.key, if m.sel == Some(i) && item.on { st } else { look.muted }); }
            }
        }
        if let Some(p) = &self.prompt {
            let (row, c, value) = (p.row(), crate::settings::chrome(), p.text.iter().collect::<String>());
            if let Some((r, d)) = self.prompt_dialog(g, p, &value, &row, &c, look.border) {
                let r = at(r);
                d.render_over(area, r, buf);
                // (A pane has no terminal cursor to put in the box: the caret is a reversed cell.)
                if let Some(caret) = d.cursor(r) { buf.set_style(Rect::new(caret.x, caret.y, 1, 1), Style::new().add_modifier(Modifier::REVERSED)) }
            }
        }
        if self.confirm.is_some() {
            let (row, c) = (self.confirm_row(), crate::settings::chrome());
            if let Some((r, d)) = self.confirm_dialog(g, &row, &c, look.border) { d.render_over(area, at(r), buf) }
        }
    }

    /// The name prompt as the shared dialog over the grid: titled with what it does, the name in
    /// an input box (its selection marked) and `[ Cancel ]  [ Create ]`. None where the buttons,
    /// or the input, cannot fit.
    fn prompt_dialog<'a>(&self, g: Geom, p: &'a Prompt, value: &'a str, row: &'a ButtonRow, c: &'a crate::settings::Chrome, border: border::Set<'a>) -> Option<(Rect, Dialog<'a>)> {
        let (title, label) = match &p.ask {
            Ask::NewFile => ("New File".to_string(), "File name"),
            Ask::NewFolder => ("New Folder".to_string(), "Folder name"),
            Ask::Rename(path) => (format!("Rename · {}", fit(&name_of(path), 30)), "New name"),
        };
        let mut d = Dialog::new(&title, Vec::new(), row, c);
        d.border = border;
        d.input = Some(Input { label, value, caret: p.cursor, select: p.selection(), secret: false, focused: !p.buttons, width: PROMPT_W });
        if row.buttons_width() > g.grid.width.saturating_sub(4) || !d.fit(g.grid.height) { return None }
        Some((d.place(g.grid), d))
    }

    /// The name prompt's box and the parts inside it (for drawing and clicks alike).
    fn prompt_layout(&self, g: Geom) -> Option<(Rect, crate::dialog::Areas)> {
        let p = self.prompt.as_ref()?;
        let (row, c, value) = (p.row(), crate::settings::chrome(), p.text.iter().collect::<String>());
        let (r, d) = self.prompt_dialog(g, p, &value, &row, &c, border::PLAIN)?;
        Some((r, d.areas(r)))
    }

    /// The confirmation as the shared dialog, in the middle of the view: titled with what goes,
    /// its question wrapped to the view, a line in the danger colour where it can't be undone,
    /// and its buttons. None where the buttons, or one line of the question, cannot fit.
    fn confirm_dialog<'a>(&self, g: Geom, row: &'a ButtonRow, c: &'a crate::settings::Chrome, border: border::Set<'a>) -> Option<(Rect, Dialog<'a>)> {
        let (title, lines, undone) = match self.confirm.as_ref().map(|c| &c.doom) {
            Some(Doom::Trash(p)) => (format!("Delete · {}", fit(&name_of(p), 30)), vec![format!("Delete '{}'?", fit(&name_of(p), 40)), "It goes to the Trash.".to_string()], ""),
            Some(Doom::Purge(p, why)) => (format!("Delete Permanently · {}", fit(&name_of(p), 30)), vec![format!("'{}' can't go to the Trash: {why}.", fit(&name_of(p), 30)), "Delete it permanently?".to_string()], "This can't be undone."),
            None => (String::new(), Vec::new(), ""),
        };
        let room = g.size.0.saturating_sub(4).clamp(1, 60);
        let mut d = Dialog::new(&title, lines.iter().flat_map(|l| crate::dialog::wrap(l, room, c.base)).collect(), row, c);
        d.border = border;
        d.message = crate::dialog::wrap(undone, room, c.danger);
        if row.buttons_width() > g.size.0.saturating_sub(4) || !d.fit(g.size.1) { return None }
        Some((d.place(Rect::new(0, 0, g.size.0, g.size.1)), d))
    }

    /// The confirmation's box and its buttons' row (for drawing and clicks alike).
    fn confirm_layout(&self, g: Geom) -> Option<(Rect, Rect)> {
        let (row, c) = (self.confirm_row(), crate::settings::chrome());
        let (r, d) = self.confirm_dialog(g, &row, &c, border::PLAIN)?;
        Some((r, d.areas(r).row))
    }
}

/// The menu's box: as wide as its longest item and key.
fn menu_box(m: &Menu) -> Rect {
    let w = m.items.iter().flatten().map(|i| i.label.width() + if i.key.is_empty() { 0 } else { i.key.width() + 3 }).max().unwrap_or(0) as u16 + 4;
    Rect::new(m.x, m.y, w, m.items.len() as u16 + 2)
}

fn contains(r: Rect, x: u16, y: u16) -> bool { x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height }

/// A box with rounded corners round [r], what was inside it cleared.
fn frame(buf: &mut Buffer, r: Rect, st: Style) {
    if r.width < 2 || r.height < 2 { return }
    for y in r.y..r.y + r.height {
        for x in r.x..r.x + r.width {
            let edge = match (x == r.x, x + 1 == r.x + r.width, y == r.y, y + 1 == r.y + r.height) {
                (true, _, true, _) => "╭", (_, true, true, _) => "╮", (true, _, _, true) => "╰", (_, true, _, true) => "╯",
                (_, _, true, _) | (_, _, _, true) => "─", (true, ..) | (_, true, ..) => "│", _ => " ",
            };
            if let Some(c) = buf.cell_mut((x, y)) { c.reset(); c.set_symbol(edge).set_style(if edge == " " { Style::default() } else { st }); }
        }
    }
}

impl Target {
    /// The folder an item is in (a space's: itself).
    fn folder_of_item(&self) -> PathBuf {
        match self { Target::Item { path, .. } => path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.clone()), Target::Space(p) => p.clone() }
    }
}

/// A tile at (x, y): its picture over its name; all of it lit when [lit] (the picture keeping its
/// colour on the selection's background), only its name marked when [marked].
fn tile(buf: &mut Buffer, x: u16, y: u16, e: &Entry, lit: bool, marked: bool, look: &Look) {
    let w = TILE_W - 2;
    let st = if e.dir { look.accent } else { file_style(&e.name, look) };
    for (dy, line) in art(e).iter().enumerate() {
        put(buf, x + w.saturating_sub(line.width() as u16) / 2, y + dy as u16, w, line, st);
    }
    let name = shorten(&e.name, e.dir, w as usize);
    let name_st = if marked { look.text.add_modifier(Modifier::BOLD | Modifier::UNDERLINED) } else { look.text };
    put(buf, x + (w.saturating_sub(name.width() as u16)) / 2, y + 4, w, &name, name_st);
    if lit {
        let bg = look.mode.bg.map(|b| Style::default().bg(b)).unwrap_or(look.mode);
        for dy in 0..TILE_H - 1 { for dx in 0..w { if let Some(c) = buf.cell_mut((x + dx, y + dy)) { c.set_style(if dy < 4 { bg } else { look.mode }); } } }
    }
}

/// A big picture for a tile: a folder; a page with its extension on it.
fn art(e: &Entry) -> [String; 4] {
    if e.dir { return [" ▄▄▄▄     ".into(), "██████████".into(), "██████████".into(), "▀▀▀▀▀▀▀▀▀▀".into()] }
    let ext: String = e.name.rsplit_once('.').filter(|(s, _)| !s.is_empty()).map(|(_, x)| x.chars().filter(char::is_ascii_alphanumeric).take(5).collect::<String>().to_ascii_uppercase()).unwrap_or_default();
    ["┌────┐ ".into(), "│    └┐".into(), format!("│{ext:^5}│"), "└─────┘".into()]
}

/// A file's colour by what it is: source green, pictures and sound and video magenta, archives
/// amber, the rest the text's.
fn file_style(name: &str, look: &Look) -> Style {
    match ops::kind(name, false).as_str() {
        "Image" | "Audio" | "Video" => look.media,
        "Archive" => look.warn,
        k if k.ends_with("source") || k.ends_with("script") || matches!(k, "JavaScript" | "TypeScript" | "HTML" | "CSS") => look.code,
        _ => look.text,
    }
}

/// [text] at (x, y), no more than [max] columns of it; the columns it took.
fn put(buf: &mut Buffer, x: u16, y: u16, max: u16, text: &str, st: Style) -> u16 {
    let mut w = 0u16;
    for ch in text.chars() {
        let cw = ch.width().unwrap_or(0) as u16;
        if cw == 0 { continue }
        if w + cw > max { break }
        if let Some(c) = buf.cell_mut((x + w, y)) { c.set_char(ch).set_style(st); }
        w += cw;
    }
    w
}

/// [text] in [max] columns, cut short with … when it is wider.
fn fit(text: &str, max: usize) -> String {
    if text.width() <= max { return text.to_string() }
    let mut out = String::new();
    let mut w = 0;
    for ch in text.chars() {
        let cw = ch.width().unwrap_or(0);
        if w + cw + 1 > max { break }
        out.push(ch);
        w += cw;
    }
    if max > 0 { out.push('…') }
    out
}

/// An entry's name in [w] columns, as Finder shortens one: a folder's cut at the end; a file's in
/// the middle of its stem, its extension kept (`long-report-na….md`) — at the end too when not
/// even one character of the stem and … fit beside it. A dotfile (`.bashrc`) has no extension.
fn shorten(name: &str, folder: bool, w: usize) -> String {
    if name.width() <= w { return name.to_string() }
    let ext = match name.rfind('.') { Some(i) if i > 0 && !folder => &name[i..], _ => return fit(name, w) };
    let stem = &name[..name.len() - ext.len()];
    // What the stem keeps: its start, and as much of its end as half of what is left.
    let Some(room) = w.checked_sub(ext.width() + 1).filter(|r| *r >= 1) else { return fit(name, w) };
    let mut head = String::new();
    let mut used = 0;
    for ch in stem.chars() {
        let cw = ch.width().unwrap_or(0);
        if used + cw > room.div_ceil(2) { break }
        head.push(ch);
        used += cw;
    }
    let mut tail: Vec<char> = Vec::new();
    for ch in stem[head.len()..].chars().rev() {
        let cw = ch.width().unwrap_or(0);
        if used + cw > room { break }
        tail.push(ch);
        used += cw;
    }
    tail.reverse();
    format!("{head}…{}{ext}", tail.into_iter().collect::<String>())
}

/// An entry's small icon (the list's): Nerd Font's folder or its file type's, else a plain one.
fn icon(e: &Entry, nerd: bool) -> &'static str {
    if !nerd { return if e.dir { "[/]" } else { "[=]" } }
    if e.dir { return "\u{f07b}" }
    let ext = e.name.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "rs" => "\u{e7a8}",
        "py" => "\u{e606}",
        "js" | "mjs" | "cjs" | "jsx" => "\u{e74e}",
        "ts" | "tsx" => "\u{e628}",
        "md" => "\u{e73e}",
        "json" => "\u{e60b}",
        "sh" | "bash" | "zsh" | "fish" => "\u{f489}",
        "html" | "htm" => "\u{e736}",
        "css" => "\u{e749}",
        "toml" | "yaml" | "yml" | "ini" | "conf" | "cfg" => "\u{e615}",
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "bmp" | "ico" => "\u{f1c5}",
        "pdf" => "\u{f1c1}",
        "zip" | "tar" | "gz" | "tgz" | "xz" | "bz2" | "zst" | "7z" | "rar" => "\u{f1c6}",
        "mp3" | "wav" | "flac" | "ogg" | "m4a" => "\u{f1c7}",
        "mp4" | "mkv" | "webm" | "mov" | "avi" => "\u{f1c8}",
        "txt" | "log" => "\u{f15c}",
        _ => "\u{f15b}",
    }
}

// A key as hn spells it (Chord::normal: a letter lower-case with S-, a symbol without).
fn is_char(c: &Chord, ch: char) -> bool { *c == Chord::normal(KeyCode::Char(ch), KeyModifiers::NONE) }
fn is_ctrl(c: &Chord, ch: char) -> bool { *c == Chord::normal(KeyCode::Char(ch), KeyModifiers::CONTROL) }

// ── the mode on a pane ───────────────────────────────────────────────────────

/// Where [pane] is, when that is a folder on this computer: its shell's folder (OSC 7, else
/// tmux's), else its harness's.
fn here(app: &App, pane: u64) -> Option<PathBuf> {
    let p = app.panes.get(&pane)?;
    if !crate::local::is_local(&p.machine_id) && p.machine_id != app.fleet.local_id { return None }
    let agent = app.fleet.agent(&p.machine_id, &p.agent_id).map(|a| a.cwd.clone());
    p.live_path.clone().or_else(|| p.cwd.clone()).or(agent).filter(|c| !c.is_empty()).map(PathBuf::from).filter(|d| d.is_dir())
}

/// The folder asked for — `~` home, a relative one from where [pane] is — else where the pane is,
/// else home; or why it can't be shown.
fn resolve(app: &App, pane: u64, dir: Option<&Path>) -> Result<PathBuf, String> {
    let here = here(app, pane);
    let Some(d) = dir else { return Ok(here.unwrap_or_else(home)) };
    folder(d, here)
}

/// [d] as a folder: `~` home, a relative one from [here] (else home).
fn folder(d: &Path, here: Option<PathBuf>) -> Result<PathBuf, String> {
    let d = match d.strip_prefix("~") { Ok(rest) => home().join(rest), Err(_) => d.to_path_buf() };
    let d = clean(&if d.is_relative() { here.unwrap_or_else(home).join(d) } else { d });
    if d.is_dir() { Ok(d) } else { Err(format!("not a folder: {}", d.display())) }
}

/// [pane] into the file manager at [dir] (if it is in it already, it starts again there) — ending
/// choose-tree, if that was over the pane.
pub fn enter(app: &mut App, pane: u64, dir: PathBuf) {
    if app.panes.get(&pane).is_some_and(|p| p.tree.is_some()) { crate::tree::exit(app, pane) }
    let nerd = match app.options.get("@hn-nerd-font", "", None) { Some(v) if !v.is_empty() => matches!(v.as_str(), "on" | "1" | "yes" | "true"), _ => app.os_session };
    let f = Files::new(dir, nerd);
    let Some(p) = app.panes.get_mut(&pane) else { return };
    p.files_at = p.modes.len();
    p.files = Some(Box::new(f));
    p.dirty = true;
    app.sync_copy_modal();
}

/// What ordinary hn says to the file manager, which is Harness OS's alone (as its other screens).
const OS_ONLY: &str = "This action belongs to the Harness operating system.";

/// choose-file: [pane] into the file manager at [dir] (see resolve) — in the OS session only.
pub fn choose(app: &mut App, pane: u64, dir: Option<&str>) {
    if !app.os_session { return app.error(OS_ONLY) }
    match resolve(app, pane, dir.map(Path::new)) { Ok(d) => enter(app, pane, d), Err(e) => app.error(e) }
}

/// The file manager on the active pane, at [dir] — else where that pane is, else home. The
/// palette's Files… and the OS's Super+E.
pub fn open(app: &mut App, dir: Option<PathBuf>) {
    if !app.os_session { return app.error(OS_ONLY) }
    let Some((_, pane)) = app.current() else { return app.error("no current pane") };
    match resolve(app, pane, dir.as_deref()) { Ok(d) => enter(app, pane, d), Err(e) => app.error(e) }
}

/// The pane's file manager ends.
pub fn exit(app: &mut App, pane: u64) {
    let Some(p) = app.panes.get_mut(&pane) else { return };
    if p.files.take().is_none() { return }
    p.dirty = true;
    app.sync_copy_modal();
}

/// Draws [pane]'s file manager into [area] (the pane's cells).
pub fn draw(app: &mut App, pane: u64, buf: &mut Buffer, area: Rect) {
    let window = app.tabs.iter().position(|t| t.panes().contains(&pane)).unwrap_or(app.active);
    let mut look = Look::with_mode(crate::draw::style_over(&app.style_spec("mode-style", window, Some(pane)), Style::default()));
    look.border = crate::ui::dialog_border(&app.style_spec("menu-border-lines", window, Some(pane)));
    if let Some(f) = app.panes.get_mut(&pane).and_then(|p| p.files.as_mut()) { f.draw(buf, area, &look) }
}

/// A key, or a mouse event ([m], its key its chord), for [pane]'s file manager.
pub fn key(app: &mut App, pane: u64, chord: Chord, m: Option<&crate::mouse::Event>) {
    let (sx, sy) = crate::copy::screen_size(app, pane);
    let at = m.and_then(|m| crate::mouse::mouse_at(app, pane, m, false));
    let Some(p) = app.panes.get_mut(&pane) else { return };
    let Some(f) = p.files.as_mut() else { return };
    let g = geom(sx as u16, sy as u16, f.view);
    let out = match (keys::mouse_parts(&chord.code), at) {
        (Some((MouseKind::Down, 1, _)), Some((x, y))) => f.click(x, y, false, g),
        (Some((MouseKind::Double, 1, _)), Some((x, y))) => f.click(x, y, true, g),
        // (The root table's MouseDown3Pane sends a right click on to a pane in a mode other than
        // copy mode: it is this menu's, not the pane menu's.)
        (Some((MouseKind::Down, 3, _)), Some((x, y))) => { f.right_click(x, y, g); Outcome::None }
        (Some((MouseKind::Move, ..)), Some((x, y))) => { f.hover(x, y, g); Outcome::None }
        (Some((MouseKind::WheelUp, ..)), at) => { f.wheel(at.map(|a| a.0).unwrap_or(0), false, g); Outcome::None }
        (Some((MouseKind::WheelDown, ..)), at) => { f.wheel(at.map(|a| a.0).unwrap_or(0), true, g); Outcome::None }
        (Some(_), _) => Outcome::None,
        (None, _) => f.press(chord, g),
    };
    p.dirty = true;
    match out {
        Outcome::None => {}
        Outcome::Exit => exit(app, pane),
        Outcome::Edit(file) => edit(app, pane, &file),
        Outcome::Terminal(dir) => split(app, pane, &dir, None),
        Outcome::Harness(dir) => crate::new_harness::open(app, None, Some(dir.to_string_lossy().into_owned())),
        Outcome::Clipboard(text) => { if !app.headless { crate::clipboard::store(&text) } }
    }
}

/// The command a file is edited with: $VISUAL, else $EDITOR, else vi (in the file's folder).
fn editor_command(name: &str) -> String {
    let name = if name.starts_with('-') { format!("./{name}") } else { name.to_string() };
    format!("${{VISUAL:-${{EDITOR:-vi}}}} '{}'", name.replace('\'', "'\\''"))
}

fn edit(app: &mut App, pane: u64, file: &Path) {
    let Some(dir) = file.parent() else { return };
    split(app, pane, dir, Some(editor_command(&name_of(file))));
}

/// A terminal split beside [pane], in [dir] on this computer, running [command] if there is one.
fn split(app: &mut App, pane: u64, dir: &Path, command: Option<String>) {
    let Some(tab) = app.tabs.iter().find(|t| t.panes().contains(&pane)).map(|t| t.id.clone()) else { return };
    let placement = Placement::At(At { tab, pane: Some(pane), dir: Dir::Horizontal, before: false, full: false, size: None, detached: false, zoom: false });
    crate::input::new_shell_from(app, None, placement, Some(dir.to_string_lossy().into_owned()), command);
}

// ── its own window: `hn files` ───────────────────────────────────────────────

/// Two clicks this close together on one cell are a double click (tmux's KEYC_CLICK_TIMEOUT is
/// 300ms; a window of its own has no timer to wait on, so a little longer).
const DOUBLE_CLICK: std::time::Duration = std::time::Duration::from_millis(400);

/// The terminal taken for `hn files` (raw, the alternate screen, the mouse), and given back as it
/// was when it ends — by q, an error or a panic — and while the editor has it.
struct Screen;

impl Screen {
    fn take() -> std::io::Result<()> {
        crossterm::terminal::enable_raw_mode()?;
        crossterm::execute!(std::io::stdout(), crossterm::terminal::EnterAlternateScreen, crossterm::event::EnableMouseCapture, crossterm::cursor::Hide)
    }
    fn give_back() {
        let _ = crossterm::execute!(std::io::stdout(), crossterm::event::DisableMouseCapture, crossterm::terminal::LeaveAlternateScreen, crossterm::cursor::Show);
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

impl Drop for Screen { fn drop(&mut self) { Screen::give_back() } }

/// `hn files [DIR]`: the file manager filling this terminal, a program of its own — no daemon,
/// no hn client or server needed (the OS's Super+E runs it in a window of its own). DIR: `~`
/// home, a relative one from here; home without one. And its other ways, each in a window of
/// its own: `--open [DIR]` the Open dialog (Super+O), `--root DIR` an explorer kept inside DIR
/// (what the dialog opens a folder in), `--edit FILE` the editor on FILE alone. Its exit code.
pub fn standalone(args: &[String]) -> i32 {
    if !on_the_os(std::env::var("HARNESS_OS").ok().as_deref()) { eprintln!("hn files: available on the Harness operating system only."); return 2 }
    let mode = args.first().map(String::as_str).filter(|a| matches!(*a, "--open" | "--root" | "--edit"));
    let rest = if mode.is_some() { &args[1..] } else { args };
    let here = std::env::current_dir().ok();
    // Nerd Font icons: $HN_NERD_FONT on or off, else on in Harness OS (its terminal's font has them).
    let nerd = match std::env::var("HN_NERD_FONT") {
        Ok(v) if !v.is_empty() => matches!(v.as_str(), "on" | "1" | "yes" | "true"),
        _ => std::env::var("HARNESS_OS").is_ok_and(|v| v == "1"),
    };
    let fail = |e: String| { eprintln!("hn files: {e}"); 1 };
    let start = if mode == Some("--edit") {
        let Some(file) = rest.first() else { return fail("--edit needs a file".into()) };
        let file = clean(&here.clone().unwrap_or_else(home).join(match Path::new(file).strip_prefix("~") { Ok(r) => home().join(r), Err(_) => PathBuf::from(file) }));
        Start::Edit(file)
    } else {
        let dir = match rest.first() { None => Ok(home()), Some(d) => folder(Path::new(d), here) };
        match dir { Ok(d) if mode == Some("--open") => Start::Open(d), Ok(d) if mode == Some("--root") => Start::Root(d), Ok(d) => Start::Explore(d), Err(e) => return fail(e) }
    };
    let launcher = std::env::var("HARNESS_FILES_LAUNCH").ok();
    match run_start(start, nerd, launcher.as_deref(), &mut launch) { Ok(()) => 0, Err(e) => fail(e) }
}

/// What `hn files` starts as.
#[derive(Debug, PartialEq, Eq)]
enum Start { Explore(PathBuf), Open(PathBuf), Root(PathBuf), Edit(PathBuf) }

/// The file manager for [start]: an explorer (kept inside its root with `--root`), the editor
/// alone, or the Open dialog and then what it opened.
fn run_start(start: Start, nerd: bool, launcher: Option<&str>, spawn: &mut dyn FnMut(&str, &[String]) -> std::io::Result<()>) -> Result<(), String> {
    let io = |e: std::io::Error| e.to_string();
    let next = match start {
        Start::Open(dir) => {
            let mut d = dialog::Dialog::new(dir, nerd, dialog::recent_home());
            match run_dialog(&mut d).map_err(io)? {
                None => return Ok(()),
                Some((path, folder)) => match opened(path, folder, launcher, spawn)? { None => return Ok(()), Some(s) => s },
            }
        }
        s => s,
    };
    let mut f = match next {
        Start::Explore(dir) => Files::new(dir, nerd),
        Start::Root(dir) => { let mut f = Files::new(dir, nerd); f.bounded = true; f }
        Start::Edit(file) => {
            let mut f = Files::new(file.parent().map(Path::to_path_buf).unwrap_or_else(home), nerd);
            f.builtin = true;
            f.open_file(file);
            if f.editor.is_none() { return Err(f.message.unwrap_or_else(|| "nothing to edit".into())) }
            f.exit_on_close = true;
            f
        }
        Start::Open(_) => unreachable!(),
    };
    f.standalone = true;
    f.builtin = true;
    run_standalone(&mut f).map_err(io)
}

/// What the Open dialog chose, opened: in a window of its own through $HARNESS_FILES_LAUNCH
/// (`--root DIR`, `--edit FILE`), this one then done (None); without it, in this window.
fn opened(path: PathBuf, folder: bool, launcher: Option<&str>, spawn: &mut dyn FnMut(&str, &[String]) -> std::io::Result<()>) -> Result<Option<Start>, String> {
    match launcher.map(str::trim).filter(|l| !l.is_empty()) {
        Some(l) => {
            let args = vec![if folder { "--root" } else { "--edit" }.to_string(), path.to_string_lossy().into_owned()];
            spawn(l, &args).map(|_| None).map_err(|e| format!("couldn't open {}: {e}", path.display()))
        }
        None => Ok(Some(if folder { Start::Root(path) } else { Start::Edit(path) })),
    }
}

/// [program] started on its own (its own session, nothing of this terminal's), not waited for.
fn launch(program: &str, args: &[String]) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut words = program.split_whitespace();
    let mut c = Command::new(words.next().unwrap_or(program));
    c.args(words).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: setsid only, between fork and exec.
    unsafe { c.pre_exec(|| { libc::setsid(); Ok(()) }); }
    c.spawn().map(|_| ())
}

/// The Open dialog in this terminal until it is cancelled (None) or opens something.
fn run_dialog(d: &mut dialog::Dialog) -> std::io::Result<Option<(PathBuf, bool)>> {
    use crossterm::event::{Event, KeyEventKind, MouseButton, MouseEventKind};
    let look = Look::default();
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| { Screen::give_back(); hook(info) }));
    Screen::take()?;
    let _screen = Screen;
    let mut term = ratatui::Terminal::new(ratatui::backend::CrosstermBackend::new(std::io::stdout()))?;
    let mut last_click: Option<(std::time::Instant, u16, u16)> = None;
    loop {
        term.draw(|frame| { let area = frame.area(); d.draw(frame.buffer_mut(), area, &look) })?;
        let out = match crossterm::event::read()? {
            Event::Key(k) if k.kind != KeyEventKind::Release => d.key(keys::of(&k)),
            Event::Mouse(m) => match m.kind {
                MouseEventKind::Down(MouseButton::Left) => {
                    let double = last_click.is_some_and(|(at, x, y)| at.elapsed() < DOUBLE_CLICK && (x, y) == (m.column, m.row));
                    last_click = (!double).then(|| (std::time::Instant::now(), m.column, m.row));
                    d.click(m.column, m.row, double)
                }
                MouseEventKind::ScrollUp => { d.wheel(m.column, false); dialog::DOut::None }
                MouseEventKind::ScrollDown => { d.wheel(m.column, true); dialog::DOut::None }
                _ => dialog::DOut::None,
            },
            _ => dialog::DOut::None,
        };
        match out {
            dialog::DOut::None => {}
            dialog::DOut::Cancel => return Ok(None),
            dialog::DOut::Open(p, folder) => return Ok(Some((p, folder))),
        }
    }
}

/// Whether `hn files` runs: on Harness OS ($HARNESS_OS=1), as hn's OS session is decided.
fn on_the_os(harness_os: Option<&str>) -> bool { harness_os == Some("1") }

fn run_standalone(f: &mut Files) -> std::io::Result<()> {
    use crossterm::event::{Event, KeyEventKind, MouseButton, MouseEventKind};
    let look = Look::default();
    // (A panic's message is printed on the terminal as it was, not in raw mode on the alternate screen.)
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| { Screen::give_back(); hook(info) }));
    Screen::take()?;
    let _screen = Screen;
    let mut term = ratatui::Terminal::new(ratatui::backend::CrosstermBackend::new(std::io::stdout()))?;
    let mut last_click: Option<(std::time::Instant, u16, u16)> = None;
    loop {
        term.draw(|frame| { let area = frame.area(); f.draw(frame.buffer_mut(), area, &look) })?;
        let size = term.size()?;
        let g = geom(size.width, size.height, f.view);
        // (A resize: drawn again at the new size.)
        let out = match crossterm::event::read()? {
            Event::Key(k) if k.kind != KeyEventKind::Release => f.press(keys::of(&k), g),
            Event::Mouse(m) => match m.kind {
                MouseEventKind::Down(MouseButton::Left) => {
                    let double = last_click.is_some_and(|(at, x, y)| at.elapsed() < DOUBLE_CLICK && (x, y) == (m.column, m.row));
                    last_click = (!double).then(|| (std::time::Instant::now(), m.column, m.row));
                    f.click(m.column, m.row, double, g)
                }
                MouseEventKind::Down(MouseButton::Right) => { f.right_click(m.column, m.row, g); Outcome::None }
                MouseEventKind::Drag(MouseButton::Left) => { f.drag(m.column, m.row); Outcome::None }
                MouseEventKind::Moved => { f.hover(m.column, m.row, g); Outcome::None }
                MouseEventKind::ScrollUp => { f.wheel(m.column, false, g); Outcome::None }
                MouseEventKind::ScrollDown => { f.wheel(m.column, true, g); Outcome::None }
                _ => Outcome::None,
            },
            _ => Outcome::None,
        };
        match out {
            Outcome::Exit => return Ok(()),
            Outcome::Edit(file) => {
                f.message = edit_here(&file);
                Screen::take()?;
                term.clear()?;
                f.reload();
            }
            Outcome::Terminal(dir) => f.message = Some(terminal_in_hn(&dir)),
            Outcome::Clipboard(text) => crate::clipboard::store(&text),
            Outcome::Harness(_) | Outcome::None => {}
        }
    }
}

/// The editor on [file], in its folder, in this terminal (given back to the shell's ways until it
/// ends); what went wrong, if it did.
fn edit_here(file: &Path) -> Option<String> {
    Screen::give_back();
    let dir = file.parent().unwrap_or(Path::new("/"));
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    match std::process::Command::new(shell).arg("-c").arg(editor_command(&name_of(file))).current_dir(dir).status() {
        Ok(s) if s.success() => None,
        Ok(s) => Some(format!("The editor ended with {s}")),
        Err(e) => Some(format!("Couldn't start the editor: {e}")),
    }
}

/// A terminal in [dir] in the hn you are using (`hn new-window -c DIR`, as tmux's from a shell);
/// what to say about it.
fn terminal_in_hn(dir: &Path) -> String {
    let hn = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("hn"));
    let null = std::process::Stdio::null;
    let done = std::process::Command::new(hn).args(["new-window", "-c"]).arg(dir).stdin(null()).stdout(null()).stderr(null()).status();
    if done.is_ok_and(|s| s.success()) { "Opened a terminal in hn".into() } else { "Couldn't open a terminal: is hn running?".into() }
}


#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own under the temp folder, gone at the end.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(files: &[&str]) -> Scratch {
            let root = std::env::temp_dir().join(format!("hn-files-{}", uuid::Uuid::new_v4()));
            for f in files {
                let p = root.join(f);
                if f.ends_with('/') { std::fs::create_dir_all(&p).unwrap() } else { std::fs::create_dir_all(p.parent().unwrap()).unwrap(); std::fs::write(&p, "").unwrap() }
            }
            Scratch(root)
        }
    }
    impl Drop for Scratch { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    fn names(f: &Files) -> Vec<&str> { f.listing.entries.iter().map(|e| e.name.as_str()).collect() }
    fn press(f: &mut Files, code: KeyCode) -> Outcome { f.press(Chord::normal(code, KeyModifiers::NONE), gal(120, 40)) }
    fn ctrl(f: &mut Files, c: char) -> Outcome { f.press(Chord::normal(KeyCode::Char(c), KeyModifiers::CONTROL), gal(120, 40)) }
    fn gal(w: u16, h: u16) -> Geom { geom(w, h, View::Gallery) }
    /// A Files with its Trash in its own scratch folder.
    fn files(s: &Scratch) -> Files { let mut f = Files::new(s.0.clone(), false); f.trash = s.0.join(".Trash"); f }

    fn fixture(width: u16, height: u16) -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (width, height));
        app.handed_over = true;
        app
    }

    fn contents(buf: &Buffer) -> String {
        (0..buf.area.height).map(|y| (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn folders_first_then_files_by_name_whatever_the_case_hidden_ones_on_a_dot() {
        let s = Scratch::new(&["b_dir/", "A_dir/", "c.txt", "B.txt", ".hidden", ".config/"]);
        let mut f = Files::new(s.0.clone(), false);
        assert_eq!(names(&f), ["A_dir", "b_dir", "B.txt", "c.txt"]);
        press(&mut f, KeyCode::Char('.'));
        assert_eq!(names(&f), [".config", "A_dir", "b_dir", ".hidden", "B.txt", "c.txt"]);
        // The explorer has the folders alone, the hidden ones with them now.
        assert_eq!(f.rows.iter().map(|r| r.name.as_str()).skip(1).collect::<Vec<_>>(), [".config", "A_dir", "b_dir"]);
        press(&mut f, KeyCode::Char('.'));
        assert_eq!(names(&f), ["A_dir", "b_dir", "B.txt", "c.txt"]);
    }

    #[test]
    fn enter_opens_a_folder_and_backspace_comes_back_to_it() {
        let s = Scratch::new(&["alpha/inner.txt", "beta/", "z.txt"]);
        let mut f = Files::new(s.0.clone(), false);
        press(&mut f, KeyCode::Right);
        assert_eq!(press(&mut f, KeyCode::Enter), Outcome::None);
        assert_eq!(f.cwd, s.0.join("beta"));
        assert!(f.listing.entries.is_empty());
        press(&mut f, KeyCode::Backspace);
        assert_eq!(f.cwd, s.0);
        assert_eq!(names(&f)[f.selected], "beta", "back up, the folder it came from is selected");
        // Up above where it was opened: the explorer is rooted there now.
        let mut g = Files::new(s.0.join("alpha"), false);
        g.press(Chord::normal(KeyCode::Up, KeyModifiers::ALT), gal(120, 40));
        assert_eq!((g.cwd.clone(), g.root.clone()), (s.0.clone(), s.0.clone()));
        // A file is for the editor.
        g.selected = 2;
        assert_eq!(press(&mut g, KeyCode::Enter), Outcome::Edit(s.0.join("z.txt")));
    }

    #[test]
    fn the_explorer_opens_out_to_the_folder_on_show_and_folds_by_keys_and_chevrons() {
        let s = Scratch::new(&["a/b/c/", "a/other/", "d/"]);
        let mut f = Files::new(s.0.clone(), true);
        f.go(s.0.join("a/b/c"), None);
        let shown: Vec<(u16, &str)> = f.rows.iter().map(|r| (r.depth, r.name.as_str())).collect();
        let root = name_of(&s.0);
        assert_eq!(shown, [(0, root.as_str()), (1, "a"), (2, "b"), (3, "c"), (2, "other"), (1, "d")]);
        assert_eq!(f.rows[f.tree_sel].path, s.0.join("a/b/c"));
        // Keys: left closes b, then goes to a; right opens it again.
        press(&mut f, KeyCode::Tab);
        f.tree_sel = 2;
        press(&mut f, KeyCode::Left);
        assert_eq!(f.rows.len(), 5);
        press(&mut f, KeyCode::Left);
        assert_eq!(f.rows[f.tree_sel].name, "a");
        press(&mut f, KeyCode::Down);
        press(&mut f, KeyCode::Right);
        assert_eq!(f.rows.len(), 6);
        // A click on d's chevron opens it without going there; on its name, the grid goes there.
        let g = gal(120, 40);
        let y = 1 + f.rows.iter().position(|r| r.name == "d").unwrap() as u16;
        f.click(g.tree.x + 1 + 2, y, false, g);
        assert_eq!(f.cwd, s.0.join("a/b/c"));
        assert!(f.expanded.contains(&s.0.join("d")));
        f.click(g.tree.x + 6, y, false, g);
        assert_eq!(f.cwd, s.0.join("d"));
        assert!(!f.expanded.contains(&s.0.join("d")), "a click on an open folder closes it");
    }

    #[test]
    fn a_click_selects_a_tile_and_a_double_click_opens_it() {
        let s = Scratch::new(&["one/", "two/x.txt", "three.txt"]);
        let mut f = Files::new(s.0.clone(), false);
        let g = gal(120, 40);
        assert_eq!(names(&f), ["one", "two", "three.txt"]);
        // The second tile of the first row.
        let (x, y) = (g.grid.x + TILE_W + 3, g.grid.y + 1);
        assert_eq!(f.item_at(x, y, g), Some(1));
        f.click(x, y, false, g);
        assert_eq!((f.selected, f.cwd.clone()), (1, s.0.clone()));
        f.click(x, y, true, g);
        assert_eq!(f.cwd, s.0.join("two"));
        // Past the last tile, and the explorer, are no tile.
        assert_eq!(f.item_at(g.grid.x + 3 * TILE_W + 3, y, g), None);
        assert_eq!(f.item_at(g.tree.x + 2, y, g), None);
        // The path bar goes back up, the folder it came from selected.
        let (_, crumbs) = f.crumbs(g);
        let (a, ..) = crumbs[crumbs.len() - 2].clone();
        f.click(a, 0, false, g);
        assert_eq!(f.cwd, s.0);
        assert_eq!(names(&f)[f.selected], "two");
    }

    #[test]
    fn its_own_window_draws_without_hn_the_explorer_left_of_the_grid() {
        let s = Scratch::new(&["src/", "notes.txt"]);
        let mut f = Files::new(s.0.clone(), false);
        f.standalone = true;
        let area = Rect::new(0, 0, 120, 30);
        let mut buf = Buffer::empty(area);
        f.draw(&mut buf, area, &Look::default());
        let text = contents(&buf);
        let g = gal(120, 30);
        let lines: Vec<&str> = text.lines().collect();
        // The explorer down the left, its line, the path bar and the grid to the right of it.
        assert!(lines[0].starts_with(" EXPLORER"), "{text}");
        assert_eq!(buf[(g.tree.width, 5)].symbol(), "│");
        let at = |line: &str, s: &str| line.find(s).map(|b| line[..b].chars().count() as u16);
        assert!(at(lines[0], &name_of(&s.0)).is_some_and(|x| x > g.grid.x), "{}", lines[0]);
        assert!(at(lines[g.items_y as usize + 4], "notes.txt").is_some_and(|x| x > g.grid.x), "{text}");
        assert!(lines[2].contains("src") && at(lines[2], "src").unwrap() < g.tree.width);
        assert!(!lines[1].contains("n harness"), "no New Harness key in a window of its own: {}", lines[1]);
        assert!(lines[29].contains("1 folder, 1 file"));
        // Its messages take the footer until the next key.
        f.message = Some("Copied /x".into());
        f.draw(&mut buf, area, &Look::default());
        assert!(contents(&buf).lines().nth(29).unwrap().contains("Copied /x"));
        press(&mut f, KeyCode::Down);
        assert!(f.message.is_none());
    }

    #[test]
    fn keys_ask_for_the_editor_a_terminal_a_copy_or_the_end() {
        let s = Scratch::new(&["dir/", "a.txt"]);
        let mut f = Files::new(s.0.clone(), false);
        f.standalone = true;
        press(&mut f, KeyCode::Right);
        assert_eq!(press(&mut f, KeyCode::Char('y')), Outcome::Clipboard(s.0.join("a.txt").to_string_lossy().into_owned()));
        assert!(f.message.as_deref().is_some_and(|m| m.starts_with("Copied /")));
        assert_eq!(press(&mut f, KeyCode::Enter), Outcome::Edit(s.0.join("a.txt")));
        assert_eq!(press(&mut f, KeyCode::Char('t')), Outcome::Terminal(s.0.clone()));
        assert_eq!(press(&mut f, KeyCode::Char('n')), Outcome::None, "New Harness is hn's");
        assert_eq!(press(&mut f, KeyCode::Char('q')), Outcome::Exit);
        assert_eq!(press(&mut f, KeyCode::Esc), Outcome::Exit);
        f.standalone = false;
        assert_eq!(press(&mut f, KeyCode::Char('n')), Outcome::Harness(s.0.clone()));
        // A folder made meanwhile is there when the folder is read again (after the editor).
        std::fs::create_dir(s.0.join("new")).unwrap();
        f.reload();
        assert_eq!(names(&f)[f.selected], "a.txt");
        assert!(names(&f).contains(&"new"));
    }

    #[test]
    fn a_long_name_is_one_line_under_its_tile_its_extension_kept() {
        let s = Scratch::new(&["a-very-long-quarterly-report-final-version.md", "an-equally-long-folder-name-for-testing/"]);
        let mut f = files(&s);
        let area = Rect::new(0, 0, 120, 30);
        let mut buf = Buffer::empty(area);
        f.draw(&mut buf, area, &Look::default());
        let text = contents(&buf);
        let g = gal(120, 30);
        let name_row = text.lines().nth(g.items_y as usize + 4).unwrap();
        assert!(name_row.contains("an-equally-long-fol…") && name_row.contains("a-very-l…-version.md"), "{name_row}");
        assert!(!text.lines().nth(g.items_y as usize + 5).unwrap().contains("version"), "no second line");
    }

    #[test]
    fn the_explorer_title_has_new_file_new_folder_refresh_and_collapse_buttons() {
        let s = Scratch::new(&["a/b/", "c/"]);
        let mut f = files(&s);
        let g = gal(120, 40);
        let area = Rect::new(0, 0, 120, 40);
        let mut buf = Buffer::empty(area);
        f.draw(&mut buf, area, &Look::default());
        let top = contents(&buf).lines().next().unwrap().to_string();
        assert!(top.starts_with(" EXPLORER") && top[..top.find('│').unwrap()].trim_end().ends_with("+F +D R -"), "{top}");
        let heads = f.heads(g);
        let at = |h: Head| heads.iter().find(|b| b.2 == h).map(|b| b.0).unwrap();
        // New File with the grid's keys: in the folder on show.
        f.click(at(Head::NewFile), 0, false, g);
        assert_eq!(f.prompt.as_ref().map(|p| (p.ask.clone(), p.dir.clone())), Some((Ask::NewFile, s.0.clone())));
        press(&mut f, KeyCode::Esc);
        // New Folder with the explorer's: in its selected folder, then selected there, its parent open.
        press(&mut f, KeyCode::Tab);
        f.tree_sel = f.rows.iter().position(|r| r.path == s.0.join("c")).unwrap();
        f.click(at(Head::NewFolder), 0, false, g);
        assert_eq!(f.prompt.as_ref().map(|p| p.dir.clone()), Some(s.0.join("c")));
        for ch in "new".chars() { press(&mut f, KeyCode::Char(ch)); }
        press(&mut f, KeyCode::Enter);
        assert!(s.0.join("c/new").is_dir() && f.expanded.contains(&s.0.join("c")));
        assert_eq!(names(&f)[f.selected], "new");
        // Refresh: what was made meanwhile is there, the selection kept.
        std::fs::write(s.0.join("c/later.txt"), "").unwrap();
        f.tree_sel = 0;
        f.click(at(Head::Refresh), 0, false, g);
        assert!(names(&f).contains(&"later.txt") && f.tree_sel == 0);
        f.go(s.0.join("a/b"), None);
        f.press(Chord::normal(KeyCode::F(5), KeyModifiers::NONE), g);
        assert_eq!(f.message.as_deref(), Some("Refreshed"));
        // Collapse All: only the root open, the grid where it was.
        f.click(at(Head::Collapse), 0, false, g);
        assert_eq!(f.expanded.iter().collect::<Vec<_>>(), [&s.0]);
        assert_eq!((f.cwd.clone(), f.tree_scroll), (s.0.join("a/b"), 0));
        // Narrow: the title gives way, then the buttons.
        assert!(f.heads(geom(60, 30, View::Gallery)).len() == 4 && f.heads(geom(45, 30, View::Gallery)).len() == 4);
        assert!(f.heads(geom(30, 30, View::Gallery)).is_empty());
    }

    #[test]
    fn what_the_open_dialog_chose_opens_in_its_own_window_or_in_this_one() {
        let mut spawned: Vec<(String, Vec<String>)> = Vec::new();
        let mut spawn = |p: &str, a: &[String]| -> std::io::Result<()> { spawned.push((p.to_string(), a.to_vec())); Ok(()) };
        assert_eq!(opened(PathBuf::from("/w/app"), true, Some("/usr/lib/harness-os/files"), &mut spawn), Ok(None));
        assert_eq!(opened(PathBuf::from("/w/a.md"), false, Some("/usr/lib/harness-os/files"), &mut spawn), Ok(None));
        assert_eq!(spawned, [("/usr/lib/harness-os/files".to_string(), vec!["--root".to_string(), "/w/app".to_string()]), ("/usr/lib/harness-os/files".to_string(), vec!["--edit".to_string(), "/w/a.md".to_string()])]);
        let mut none = |_: &str, _: &[String]| -> std::io::Result<()> { panic!("no launcher: nothing started") };
        assert_eq!(opened(PathBuf::from("/w/app"), true, None, &mut none), Ok(Some(Start::Root(PathBuf::from("/w/app")))));
        assert_eq!(opened(PathBuf::from("/w/a.md"), false, Some(" "), &mut none), Ok(Some(Start::Edit(PathBuf::from("/w/a.md")))));
    }

    #[test]
    fn root_keeps_the_explorer_inside_its_folder_and_edit_is_the_editor_alone() {
        let s = Scratch::new(&["me/app/src/main.py"]);
        let app = s.0.join("me/app");
        let mut f = Files::new(app.clone(), false);
        f.bounded = true;
        let g = gal(120, 40);
        assert_eq!(f.rows[0].name, "app");
        assert_eq!(f.crumbs(g).1.iter().map(|c| c.3.as_str()).collect::<Vec<_>>(), ["app"]);
        press(&mut f, KeyCode::Backspace);
        assert_eq!((f.cwd.clone(), f.message.as_deref()), (app.clone(), Some("This is the top of 'app'")));
        press(&mut f, KeyCode::Enter);
        assert_eq!(f.crumbs(g).1.iter().map(|c| c.3.as_str()).collect::<Vec<_>>(), ["app", "src"]);
        assert_eq!(f.act(Act::CopyRelative, Target::Item { path: app.join("src/main.py"), dir: false }), Outcome::Clipboard("src/main.py".into()));
        press(&mut f, KeyCode::Backspace);
        press(&mut f, KeyCode::Backspace);
        assert_eq!(f.cwd, app, "up to its root, no further");
        // --edit: the editor at once; closed, the program ends.
        let mut e = Files::new(app.join("src"), false);
        (e.builtin, e.exit_on_close) = (true, true);
        e.open_file(app.join("src/main.py"));
        assert!(e.editor.is_some());
        assert_eq!(press(&mut e, KeyCode::Esc), Outcome::Exit);
        // A picture is no text: --edit says so.
        std::fs::write(app.join("x.png"), b"PNG").unwrap();
        assert_eq!(run_start(Start::Edit(app.join("x.png")), false, None, &mut |_: &str, _: &[String]| Ok(())), Err("Can't open 'x.png': not a text file".into()));
    }

    #[test]
    fn hn_files_runs_on_harness_os_alone() {
        assert!(on_the_os(Some("1")));
        assert!(!on_the_os(None) && !on_the_os(Some("0")) && !on_the_os(Some("")));
    }

    #[test]
    fn an_unreadable_folder_says_so_in_place() {
        let s = Scratch::new(&[]);
        let f = Files::new(s.0.join("gone"), false);
        assert!(f.listing.error.is_some());
        assert!(f.rows.iter().any(|r| r.note));
    }

    #[test]
    fn names_are_cut_short_on_one_line_a_files_extension_kept() {
        // Short enough: as it is. A folder: cut at the end.
        assert_eq!(shorten("short.txt", false, 20), "short.txt");
        assert_eq!(shorten("opencode-2026-10-05-session", true, 20), "opencode-2026-10-05…");
        // A file: cut in its stem's middle, its extension whole.
        let s = shorten("very-long-report-name-final.md", false, 20);
        assert_eq!((s.as_str(), s.width()), ("very-lon…me-final.md", 20));
        assert_eq!(shorten("archive-of-everything.tar.gz", false, 14), "archi…g.tar.gz");
        // No room for a stem character and … beside the extension: cut at the end.
        assert_eq!(shorten("a-name.markdown", false, 9), "a-name.m…");
        // A dotfile has no extension.
        assert_eq!(shorten(".bashrc-local-settings", false, 10), ".bashrc-l…");
        // Wide characters by their width: Vietnamese one column each, CJK two.
        let vi = shorten("Báo cáo tài chính quý ba.docx", false, 16);
        assert!(vi.width() <= 16 && vi.ends_with(".docx") && vi.contains('…'), "{vi}");
        let cjk = shorten("非常に長い日本語のファイル名です.txt", false, 15);
        assert!(cjk.width() <= 15 && cjk.ends_with(".txt") && cjk.starts_with("非常"), "{cjk}");
        assert_eq!(editor_command("it's.txt"), "${VISUAL:-${EDITOR:-vi}} 'it'\\''s.txt'");
        assert_eq!(editor_command("-x"), "${VISUAL:-${EDITOR:-vi}} './-x'");
    }

    #[test]
    fn the_list_has_a_header_and_a_row_each_and_v_or_the_switch_changes_the_view() {
        let s = Scratch::new(&["src/a.rs", "src/b.rs", "notes.txt"]);
        std::fs::write(s.0.join("notes.txt"), "x".repeat(4200)).unwrap();
        let mut f = files(&s);
        press(&mut f, KeyCode::Char('v'));
        assert_eq!(f.view, View::List);
        let area = Rect::new(0, 0, 140, 30);
        let mut buf = Buffer::empty(area);
        f.draw(&mut buf, area, &Look::default());
        let text = contents(&buf);
        let lines: Vec<&str> = text.lines().collect();
        let g = geom(140, 30, View::List);
        let head = lines[g.items_y as usize - 1];
        assert!(head.contains("Name") && head.contains("Size") && head.contains("Modified") && head.contains("Kind"), "{text}");
        let (src, notes) = (lines[g.items_y as usize], lines[g.items_y as usize + 1]);
        assert!(src.contains("src") && src.contains("2 items") && src.contains("Folder") && src.contains("Today"), "{src}");
        assert!(notes.contains("notes.txt") && notes.contains("4.2 KB") && notes.contains("Plain text"), "{notes}");
        // A row is an entry: clicked, it is selected; twice, opened.
        f.click(g.grid.x + 30, g.items_y + 1, false, g);
        assert_eq!(f.selected, 1);
        f.click(g.grid.x + 30, g.items_y, true, g);
        assert_eq!(f.cwd, s.0.join("src"));
        // The switch in the path bar goes back to the gallery.
        let (a, ..) = f.switch(g)[0];
        f.click(a + 1, 0, false, g);
        assert_eq!(f.view, View::Gallery);
    }

    #[test]
    fn the_menu_has_what_a_file_a_folder_or_empty_space_can_have_paste_dimmed_with_nothing_to_paste() {
        let s = Scratch::new(&["dir/", "a.txt"]);
        let mut f = files(&s);
        let g = gal(120, 40);
        let labels = |f: &Files| f.menu.as_ref().unwrap().items.iter().map(|i| i.as_ref().map(|i| (i.label.clone(), i.on))).collect::<Vec<_>>();
        let on = |f: &Files, l: &str| labels(f).into_iter().flatten().find(|(x, _)| x == l).map(|(_, on)| on);
        // On the file (the second tile).
        f.right_click(g.grid.x + TILE_W + 3, g.items_y + 1, g);
        assert_eq!(f.selected, 1);
        let file: Vec<String> = labels(&f).into_iter().map(|i| i.map(|(l, _)| l).unwrap_or("—".into())).collect();
        assert_eq!(file, ["Open", "Open in Terminal", "—", "Cut", "Copy", "Paste", "Duplicate", "—", "Copy Path", "Copy Relative Path", "—", "Rename…", "Delete"]);
        assert_eq!(on(&f, "Paste"), Some(false));
        // Copy, then on the folder: paste is there, with New File and New Folder.
        let copy = f.menu.as_ref().unwrap().items.iter().position(|i| i.as_ref().is_some_and(|i| i.label == "Copy")).unwrap();
        assert!(matches!(f.choose(copy), Outcome::Clipboard(_)));
        f.right_click(g.grid.x + 3, g.items_y + 1, g);
        assert_eq!((on(&f, "New File…"), on(&f, "Paste"), on(&f, "Duplicate")), (Some(true), Some(true), None));
        // Empty space: the folder's own.
        f.right_click(g.grid.x + 5 * TILE_W, g.items_y + 20, g);
        let space: Vec<String> = labels(&f).into_iter().flatten().map(|(l, _)| l).collect();
        assert_eq!(space, ["New File…", "New Folder…", "Paste", "Open in Terminal", "Copy Path", "Show Hidden Files", "View as List"]);
        // Keys: down past the rules, Enter; Esc closes. A click outside closes too.
        press(&mut f, KeyCode::Down);
        assert_eq!(f.menu.as_ref().unwrap().sel, Some(0));
        press(&mut f, KeyCode::Esc);
        assert!(f.menu.is_none(), "Esc closes the menu, not the view");
        f.right_click(g.grid.x + 3, g.items_y + 1, g);
        f.click(g.size.0 - 1, g.size.1 - 2, false, g);
        assert!(f.menu.is_none());
        // The Menu key: on the selection, its first item ready.
        f.press(Chord::normal(KeyCode::F(10), KeyModifiers::SHIFT), g);
        assert_eq!(f.menu.as_ref().map(|m| m.sel), Some(Some(0)));
    }

    #[test]
    fn new_files_and_folders_and_renames_are_checked_made_and_selected() {
        let s = Scratch::new(&["here.txt", "b/"]);
        let mut f = files(&s);
        let target = Target::Space(s.0.clone());
        let typing = |f: &mut Files, text: &str| for c in text.chars() { f.press(Chord::normal(KeyCode::Char(c), KeyModifiers::NONE), gal(120, 40)); };
        f.act(Act::NewFile, target.clone());
        typing(&mut f, "here.txt");
        press(&mut f, KeyCode::Enter);
        assert_eq!(f.message.as_deref(), Some("'here.txt' is already here"));
        assert!(f.prompt.is_some(), "the prompt stays to be put right");
        for _ in 0..4 { press(&mut f, KeyCode::Backspace); }
        typing(&mut f, ".md");
        press(&mut f, KeyCode::Enter);
        assert!(f.prompt.is_none() && s.0.join("here.md").is_file());
        assert_eq!(names(&f)[f.selected], "here.md");
        f.act(Act::NewFolder, target);
        typing(&mut f, "a/b");
        press(&mut f, KeyCode::Enter);
        assert_eq!(f.message.as_deref(), Some("A name can't contain /"));
        press(&mut f, KeyCode::Esc);
        assert!(f.prompt.is_none() && !s.0.join("a").exists());
        // F2: the stem selected, so what is typed replaces it and keeps the extension.
        f.selected = names(&f).iter().position(|n| *n == "here.txt").unwrap();
        press(&mut f, KeyCode::F(2));
        assert_eq!(f.prompt.as_ref().unwrap().selection(), Some((0, 4)));
        typing(&mut f, "there");
        press(&mut f, KeyCode::Enter);
        assert!(s.0.join("there.txt").is_file() && !s.0.join("here.txt").exists());
        assert_eq!(names(&f)[f.selected], "there.txt");
        // Renaming the folder on show (from the explorer): the view follows it.
        f.go(s.0.join("b"), None);
        f.act(Act::Rename, Target::Item { path: s.0.join("b"), dir: true });
        typing(&mut f, "c");
        press(&mut f, KeyCode::Enter);
        assert_eq!(f.cwd, s.0.join("c"));
        assert!(f.rows.iter().any(|r| r.path == s.0.join("c")));
    }

    #[test]
    fn delete_asks_then_moves_to_the_trash_and_cut_and_paste_moves() {
        let s = Scratch::new(&["a.txt", "dir/", "keep/"]);
        let mut f = files(&s);
        f.selected = names(&f).iter().position(|n| *n == "a.txt").unwrap();
        // C-c, C-v here: a copy beside it, then another.
        ctrl(&mut f, 'c');
        ctrl(&mut f, 'v');
        ctrl(&mut f, 'v');
        assert!(s.0.join("a copy.txt").exists() && s.0.join("a copy 2.txt").exists());
        assert_eq!(names(&f)[f.selected], "a copy 2.txt");
        // Delete: asked first; Cancel leaves it.
        press(&mut f, KeyCode::Delete);
        assert!(matches!(f.confirm.as_ref().map(|c| (&c.doom, c.focus)), Some((Doom::Trash(_), 0))), "a risky action starts on Cancel");
        press(&mut f, KeyCode::Enter);
        assert!(f.confirm.is_none() && s.0.join("a copy 2.txt").exists());
        press(&mut f, KeyCode::Delete);
        press(&mut f, KeyCode::Right);
        assert_eq!(f.confirm.as_ref().map(|c| c.focus), Some(1));
        press(&mut f, KeyCode::Enter);
        assert!(!s.0.join("a copy 2.txt").exists());
        assert!(s.0.join(".Trash/files/a copy 2.txt").exists() && s.0.join(".Trash/info/a copy 2.txt.trashinfo").exists());
        assert_eq!(f.message.as_deref(), Some("Moved 'a copy 2.txt' to the Trash"));
        // C-x on a.txt, then C-v in dir (from the explorer): moved.
        f.selected = names(&f).iter().position(|n| *n == "a.txt").unwrap();
        ctrl(&mut f, 'x');
        press(&mut f, KeyCode::Tab);
        f.tree_sel = f.rows.iter().position(|r| r.path == s.0.join("dir")).unwrap();
        ctrl(&mut f, 'v');
        assert!(!s.0.join("a.txt").exists() && s.0.join("dir/a.txt").exists());
        assert!(f.clip.is_none(), "what was cut is pasted once");
        // C-d: a duplicate of the folder, named as Finder does.
        press(&mut f, KeyCode::Tab);
        f.selected = names(&f).iter().position(|n| *n == "keep").unwrap();
        ctrl(&mut f, 'd');
        assert!(s.0.join("keep copy").is_dir());
    }

    #[test]
    fn what_cannot_go_to_the_trash_is_deleted_only_after_a_second_yes() {
        let s = Scratch::new(&["x.txt"]);
        let mut f = files(&s);
        // A Trash that can't be made (a file where its folder would be).
        std::fs::write(s.0.join("not-a-folder"), "").unwrap();
        f.trash = s.0.join("not-a-folder/Trash");
        press(&mut f, KeyCode::Delete);
        press(&mut f, KeyCode::Right);
        press(&mut f, KeyCode::Enter);
        assert!(matches!(f.confirm.as_ref().map(|c| (&c.doom, c.focus)), Some((Doom::Purge(..), 0))), "asked again, Cancel first");
        assert!(s.0.join("x.txt").exists());
        press(&mut f, KeyCode::Enter);
        assert!(f.confirm.is_none() && s.0.join("x.txt").exists(), "Enter on Cancel keeps it");
        press(&mut f, KeyCode::Delete);
        press(&mut f, KeyCode::Right);
        press(&mut f, KeyCode::Enter);
        press(&mut f, KeyCode::Right);
        press(&mut f, KeyCode::Enter);
        assert!(!s.0.join("x.txt").exists());
    }

    #[test]
    fn the_delete_confirm_is_one_row_cancel_first_the_chosen_button_lifted() {
        let s = Scratch::new(&["x.txt"]);
        let mut f = files(&s);
        press(&mut f, KeyCode::Delete);
        let (area, g) = (Rect::new(0, 0, 100, 30), geom(100, 30, f.view));
        let (r, row) = f.confirm_layout(g).expect("fits");
        let buttons = f.confirm_row().areas(row);
        let by = row.y;
        let screen = |f: &mut Files| { let mut buf = Buffer::empty(area); f.draw(&mut buf, area, &Look::default()); buf };
        let word = |buf: &Buffer, b: Rect| (b.x..b.right()).map(|x| buf[(x, by)].symbol()).collect::<String>();
        let shown = screen(&mut f);
        assert_eq!([word(&shown, buttons[0]), word(&shown, buttons[1])], ["[ Cancel ]", "[ Delete ]"]);
        // The shared dialog: its title in the top rule, the question inside, the panel's surface.
        let text = contents(&shown);
        assert!(text.contains("┌─Delete · x.txt") && text.contains("│ Delete 'x.txt'?") && text.contains("│ It goes to the Trash."), "{text}");
        let c = crate::settings::chrome();
        let q = (r.x + 1, r.y + 1);
        assert_eq!((shown[(r.x, r.y + 1)].symbol(), shown[q].bg), ("│", c.base.bg.unwrap_or(ratatui::style::Color::Reset)), "{text}");
        assert!(buttons[0].right() + 2 <= buttons[1].x, "two columns apart");
        let bg = |f: &mut Files, b: usize| screen(f)[(buttons[b].x + 2, by)].bg;
        let c = crate::settings::chrome();
        if !crate::theme::no_color() {
            assert_eq!(bg(&mut f, 0), c.selected.bg.unwrap());
            assert_ne!(bg(&mut f, 1), c.selected.bg.unwrap());
            press(&mut f, KeyCode::Tab);
            assert_eq!(bg(&mut f, 1), c.selected.bg.unwrap());
        }
        // A click on Cancel closes; between the buttons nothing runs.
        f.click_at(buttons[0].right() + 1, by, false, g);
        assert!(f.confirm.is_some());
        f.click_at(buttons[0].x + 1, by, false, g);
        assert!(f.confirm.is_none() && s.0.join("x.txt").exists());
    }

    fn type_in(f: &mut Files, text: &str) { for ch in text.chars() { press(f, KeyCode::Char(ch)); } }

    /// The Files drawn at [w]×[h] as text.
    fn drawn(f: &mut Files, look: &Look, w: u16, h: u16) -> (String, Buffer) {
        let area = Rect::new(0, 0, w, h);
        let mut buf = Buffer::empty(area);
        f.draw(&mut buf, area, look);
        (contents(&buf), buf)
    }

    #[test]
    fn the_name_prompt_is_the_shared_dialog_with_an_input_and_buttons() {
        let s = Scratch::new(&["here.txt"]);
        let mut f = files(&s);
        let g = gal(100, 30);
        f.act(Act::NewFile, Target::Space(s.0.clone()));
        type_in(&mut f, "abc");
        let (text, buf) = drawn(&mut f, &Look::default(), 100, 30);
        assert!(text.contains("┌─New File") && text.contains("[ Cancel ]  [ Create ]"), "{text}");
        assert!(text.contains("│abc"), "the name in the input box:\n{text}");
        assert!(!text.contains("Enter OK") && !text.contains("╭"), "not the old rounded box:\n{text}");
        let (r, _) = f.prompt_layout(g).expect("fits");
        let c = crate::settings::chrome();
        assert_eq!(buf[(r.x + 1, r.y + 1)].bg, c.base.bg.unwrap_or(ratatui::style::Color::Reset), "the panel's surface");
        // The caret moves in the input; Home, End, Delete and C-u edit at it.
        press(&mut f, KeyCode::Left);
        press(&mut f, KeyCode::Char('X'));
        assert_eq!(f.prompt.as_ref().map(|p| p.text.iter().collect::<String>()), Some("abXc".into()));
        press(&mut f, KeyCode::Home);
        press(&mut f, KeyCode::Delete);
        assert_eq!(f.prompt.as_ref().map(|p| (p.text.iter().collect::<String>(), p.cursor)), Some(("bXc".into(), 0)));
        press(&mut f, KeyCode::End);
        assert_eq!(f.prompt.as_ref().map(|p| p.cursor), Some(3));
        ctrl(&mut f, 'u');
        assert_eq!(f.prompt.as_ref().map(|p| p.text.len()), Some(0));
        // Tab to the buttons: Create is chosen; a letter there is typed and brings the keys back.
        type_in(&mut f, "n.md");
        press(&mut f, KeyCode::Tab);
        assert!(f.prompt.as_ref().is_some_and(|p| p.buttons && p.chosen == 1));
        press(&mut f, KeyCode::Left);
        assert_eq!(f.prompt.as_ref().map(|p| p.chosen), Some(0), "← → move between the buttons");
        press(&mut f, KeyCode::Char('h'));
        assert!(f.prompt.as_ref().is_some_and(|p| !p.buttons && p.text.iter().collect::<String>() == "n.mdh"), "h is typed");
        press(&mut f, KeyCode::Backspace);
        // Back on the buttons, the choice is kept (as the Machines inputs keep it). Enter on Cancel
        // closes; on Create makes it.
        press(&mut f, KeyCode::Tab);
        assert_eq!(f.prompt.as_ref().map(|p| p.chosen), Some(0));
        press(&mut f, KeyCode::Enter);
        assert!(f.prompt.is_none() && !s.0.join("n.md").exists());
        f.act(Act::NewFile, Target::Space(s.0.clone()));
        type_in(&mut f, "n.md");
        press(&mut f, KeyCode::Tab);
        press(&mut f, KeyCode::Enter);
        assert!(f.prompt.is_none() && s.0.join("n.md").is_file());
        // The mouse: Create, Cancel, the input, beside the dialog and outside it.
        let click = |f: &mut Files, at: Position| f.click_at(at.x, at.y, false, g);
        f.act(Act::NewFile, Target::Space(s.0.clone()));
        type_in(&mut f, "m.md");
        press(&mut f, KeyCode::Tab);
        let (r, a) = f.prompt_layout(g).expect("fits");
        click(&mut f, Position::new(a.input.unwrap().x + 2, a.input.unwrap().y + 1));
        assert!(f.prompt.as_ref().is_some_and(|p| !p.buttons), "a click on the input gives it the keys");
        click(&mut f, Position::new(r.x + 1, r.y + 1));
        assert!(f.prompt.is_some(), "the dialog's own rule does nothing");
        let (cancel, create) = { let b = f.prompt.as_ref().unwrap().row().areas(a.row); (b[0], b[1]) };
        click(&mut f, Position::new(create.x + 1, create.y));
        assert!(f.prompt.is_none() && s.0.join("m.md").is_file(), "Create");
        f.act(Act::NewFile, Target::Space(s.0.clone()));
        click(&mut f, Position::new(cancel.x + 1, cancel.y));
        assert!(f.prompt.is_none(), "Cancel");
        f.act(Act::NewFile, Target::Space(s.0.clone()));
        click(&mut f, Position::new(0, 29));
        assert!(f.prompt.is_none(), "outside cancels");
    }

    #[test]
    fn rename_is_titled_with_the_name_says_rename_and_replaces_the_selected_stem() {
        let s = Scratch::new(&["here.txt"]);
        let mut f = files(&s);
        f.selected = 0;
        press(&mut f, KeyCode::F(2));
        let (text, buf) = drawn(&mut f, &Look::default(), 100, 30);
        assert!(text.contains("┌─Rename · here.txt") && text.contains("[ Cancel ]  [ Rename ]"), "{text}");
        let (_, a) = f.prompt_layout(gal(100, 30)).unwrap();
        let field = a.field.unwrap();
        let c = crate::settings::chrome();
        assert_eq!(buf[(field.x, field.y)].bg, c.selected.bg.unwrap_or(ratatui::style::Color::Reset), "the stem is marked");
        assert_ne!(buf[(field.x + 5, field.y)].bg, c.selected.bg.unwrap_or(ratatui::style::Color::Reset), "the extension is not");
        type_in(&mut f, "there");
        press(&mut f, KeyCode::Enter);
        assert!(s.0.join("there.txt").is_file());
    }

    #[test]
    fn a_dialog_that_cannot_fit_cancels_the_name_prompt() {
        let s = Scratch::new(&[]);
        let mut f = files(&s);
        f.act(Act::NewFile, Target::Space(s.0.clone()));
        drawn(&mut f, &Look::default(), 20, 8);
        assert!(f.prompt.is_none(), "an invisible question must not keep answering keys");
        assert_eq!(f.message.as_deref(), Some("Make the terminal larger to answer this"));
    }

    #[test]
    fn dialogs_follow_the_border_lines_they_are_given() {
        let s = Scratch::new(&["x.txt"]);
        let mut f = files(&s);
        let mut look = Look::default();
        look.border = crate::ui::dialog_border("double");
        press(&mut f, KeyCode::Delete);
        let (text, _) = drawn(&mut f, &look, 100, 30);
        assert!(text.contains("╔═Delete · x.txt") && text.contains("╚"), "{text}");
        press(&mut f, KeyCode::Esc);
        f.act(Act::NewFile, Target::Space(s.0.clone()));
        let (text, _) = drawn(&mut f, &look, 100, 30);
        assert!(text.contains("╔═New File") && text.matches('╔').count() >= 2, "the input box too:\n{text}");
        let (text, _) = drawn(&mut f, &Look::default(), 100, 30);
        assert!(text.contains("┌─New File"), "single lines by default:\n{text}");
    }

    #[test]
    fn delete_permanently_says_it_cannot_be_undone_in_the_danger_colour_and_long_text_wraps() {
        let s = Scratch::new(&["x.txt"]);
        let mut f = files(&s);
        f.confirm = Some(Confirm { doom: Doom::Purge(s.0.join("x.txt"), "the Trash folder is on another disk".into()), focus: 0 });
        let (text, buf) = drawn(&mut f, &Look::default(), 100, 30);
        assert!(text.contains("This can't be undone."), "{text}");
        let (y, line) = text.lines().enumerate().find(|(_, l)| l.contains("This can't be undone.")).unwrap();
        let x = line[..line.find("This").unwrap()].chars().count() as u16;
        let c = crate::settings::chrome();
        assert_eq!(buf[(x, y as u16)].fg, c.danger.fg.unwrap_or(ratatui::style::Color::Reset));
        assert!(buf[(x, y as u16)].modifier.contains(c.danger.add_modifier));
        // A narrow view: the question is wrapped at its words, not cut.
        let (text, _) = drawn(&mut f, &Look::default(), 40, 16);
        for word in ["can't", "Trash:", "another", "disk.", "permanently?", "undone."] {
            assert!(text.contains(word), "{word} lost:\n{text}");
        }
        let dialog: Vec<&str> = text.lines().skip_while(|l| !l.contains("┌─Delete")).take_while(|l| !l.contains('└')).collect();
        assert!(dialog.len() > 6 && dialog.iter().all(|l| !l.contains('…')), "{text}");
        assert!(text.contains("[ Cancel ]  [ Delete Permanently ]"), "the buttons whole:\n{text}");
        // Narrower than its buttons: the question is cancelled, never drawn cut or kept invisible.
        drawn(&mut f, &Look::default(), 36, 16);
        assert!(f.confirm.is_none() && s.0.join("x.txt").exists());
        assert_eq!(f.message.as_deref(), Some("Make the terminal larger to answer this"));
    }

    #[test]
    fn tiles_are_big_with_a_picture_and_the_name_under_it() {
        let s = Scratch::new(&["folder/", "main.rs"]);
        let mut f = files(&s);
        let area = Rect::new(0, 0, 213, 58);
        let mut buf = Buffer::empty(area);
        f.draw(&mut buf, area, &Look::default());
        let text = contents(&buf);
        let lines: Vec<&str> = text.lines().collect();
        let g = gal(213, 58);
        assert_eq!(g.cols, 8);
        let y = g.items_y as usize;
        assert!(lines[y + 1].contains("██████████") && lines[y + 2].contains("│ RS  │"), "{text}");
        assert!(lines[y + 4].contains("folder") && lines[y + 4].contains("main.rs"));
        assert!(lines[y + 5].trim().is_empty() || !lines[y + 5].contains("main"), "one line of name");
        // The selection is the whole tile.
        let x = g.grid.x + 1;
        assert_eq!(buf[(x, g.items_y)].bg, Look::default().mode.bg.unwrap());
        assert_eq!(buf[(x + TILE_W - 3, g.items_y + 4)].bg, Look::default().mode.bg.unwrap());
    }

    #[tokio::test]
    async fn drawn_over_the_pane_and_a_file_opens_in_an_editor_beside_it() {
        let s = Scratch::new(&["src/", "notes.txt"]);
        let mut app = fixture(120, 40);
        // This computer, its link never connecting (a current-thread test never yields to it).
        app.daemon_down = false;
        app.fleet.local_id = "test-peer".into();
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "test-peer".into(), name: "Peer".into(), local: true, status: "running".into(), reach: crate::fleet::Reach::Ready });
        app.connect("test-peer");
        app.fleet.machine_mut("test-peer").unwrap().reach = crate::fleet::Reach::Ready;
        app.open_agent("test-peer", "agent", Placement::Auto(None));
        let pane = app.focused().unwrap();
        // Ordinary hn has no file manager: said, and the pane left as it was.
        choose(&mut app, pane, Some(&s.0.to_string_lossy()));
        assert!(app.panes[&pane].files.is_none());
        assert!(crate::keys::Keymap::tmux_defaults().prefix_table.iter().all(|b| !b.command.contains("choose-file")), "no key for it");
        assert!(!crate::commands::COMMANDS.iter().any(|(n, a, _)| *n == "choose-file" || *a == "files"), "nor a place in hn's command list");
        app.os_session = true;
        choose(&mut app, pane, Some(&s.0.to_string_lossy()));
        assert!(app.panes[&pane].files_top());
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(120, 40)).unwrap();
        terminal.draw(|frame| crate::ui::draw(frame, &mut app)).unwrap();
        let text = contents(terminal.backend().buffer());
        assert!(text.contains("EXPLORER") && text.contains("notes.txt") && text.contains("1 folder, 1 file"), "{text}");
        assert_eq!(crate::format::expand(&app, "#{pane_mode}", app.active, Some(pane), false), MODE_NAME);
        // Enter on the file: a terminal on its way beside the pane, with the editor in it.
        key(&mut app, pane, Chord::normal(KeyCode::Right, KeyModifiers::NONE), None);
        key(&mut app, pane, Chord::normal(KeyCode::Enter, KeyModifiers::NONE), None);
        let pending = app.starting_shell.as_ref().expect("the editor's shell is being opened");
        assert!(pending.lock().unwrap().is_empty(), "the command travels as argv, never typed into shell input");
        assert!(app.panes[&pane].files.is_some(), "the file manager stays");
        key(&mut app, pane, Chord::normal(KeyCode::Char('q'), KeyModifiers::NONE), None);
        assert!(!app.panes[&pane].in_mode());
        // Not a folder: said, and nothing opened.
        choose(&mut app, pane, Some("/no/such/folder"));
        assert!(app.panes[&pane].files.is_none());
    }
}
