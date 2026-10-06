//! choose-tree, as tmux's mode-tree.c and window-tree.c make it: a mode of one pane that lists
//! every session, its windows and their panes as a tree — the list at the top of the pane, the
//! current item previewed in a box below it (a window's panes side by side, each numbered in a
//! small box; a session's windows likewise; a pane itself) — chosen with Enter (the template,
//! `switch-client -Zt '%%'` by default) or the key its line shows ((0)…(9), (M-a)…), tagged with
//! t, searched (/ ? n N), filtered (f), sorted (O r), collapsed and expanded (h l - +), killed
//! (x X), or given a command (:).
//!
//! The tree is the pane's while it lasts (tmux's wp->modes): drawn over the pane's cells, the
//! keys of the pane it is in going to it, rebuilt as windows and panes come and go. A session
//! not on screen is read with it in front for the moment (App::swap_session), as a command that
//! names it runs.

use std::collections::HashMap;

use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use unicode_width::UnicodeWidthStr;

use crate::app::App;
use crate::keys::{self, Chord};
use crate::modal::{Modal, Prompt, PromptKind};

pub const DEFAULT_COMMAND: &str = "switch-client -Zt '%%'";
pub const DEFAULT_FORMAT: &str = concat!(
    "#{?pane_format,",
    "#{?pane_marked,#[reverse],}",
    "#{pane_current_command}#{?pane_active,*,}#{?pane_marked,M,}",
    "#{?#{&&:#{pane_title},#{!=:#{pane_title},#{host_short}}},: \"#{pane_title}\",}",
    ",",
    "#{?window_format,",
    "#{?window_marked_flag,#[reverse],}",
    "#{window_name}#{window_flags}",
    "#{?#{&&:#{==:#{window_panes},1},#{&&:#{pane_title},#{!=:#{pane_title},#{host_short}}}},: \"#{pane_title}\",}",
    ",",
    "#{session_windows} windows",
    "#{?session_grouped, (group #{session_group}: #{session_group_list}),}",
    "#{?session_attached, (attached),}",
    "}",
    "}",
);
/// Marked rows have an explicit marker and emphasis; tmux appearance keeps its original format.
pub fn default_format(tmux_look: bool) -> String {
    if tmux_look { DEFAULT_FORMAT.to_string() }
    else { DEFAULT_FORMAT.replace("#[reverse]", "#[bold]◆ ") }
}

pub const DEFAULT_KEY_FORMAT: &str = "#{?#{e|<:#{line},10},#{line},#{?#{e|<:#{line},36},M-#{a:#{e|+:97,#{e|-:#{line},10}}},}}";
const SORTS: [&str; 3] = ["index", "name", "time"];
/// window-buffer.c's (choose-buffer): its template, its items' format and its sorts.
pub const BUFFER_COMMAND: &str = "paste-buffer -p -b '%%'";
pub const BUFFER_FORMAT: &str = "#{t/p:buffer_created}: #{buffer_sample}";
const BUFFER_SORTS: [&str; 3] = ["time", "name", "size"];

/// Which of tmux's mode-tree modes it is: window-tree.c's (choose-tree) or window-buffer.c's
/// (choose-buffer: the paste buffers, flat, each previewed as its text).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Flavour { Tree, Buffer }

/// The format types format_defaults gives (format.c's ft->type): what #{session_format},
/// #{window_format} and #{pane_format} say while an item's format is expanded.
pub const FORMAT_SESSION: u8 = 1;
pub const FORMAT_WINDOW: u8 = 2;
pub const FORMAT_PANE: u8 = 3;

/// The item the mode starts on (window_tree_type): -s a session, -w a window, else a pane;
/// none once it has started.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind { None, Session, Window, Pane }

/// What an item is (window_tree_itemdata): a session (its id), a window of it (its tab), a pane.
#[derive(Clone, PartialEq, Eq, Debug)]
enum What { Session(u32), Window(u32, String), Pane(u32, String, u64), Buffer(String) }

impl What {
    fn session(&self) -> u32 { match self { What::Session(s) | What::Window(s, _) | What::Pane(s, ..) => *s, What::Buffer(_) => u32::MAX } }
}

/// mode_tree_item.
#[derive(Clone, Debug)]
struct Item {
    parent: Option<usize>,
    what: What,
    line: usize,
    key: Option<Chord>,
    keystr: Option<String>,
    tag: u64,
    name: String,
    text: Option<String>,
    expanded: bool,
    tagged: bool,
    children: Vec<usize>,
}

/// mode_tree_line.
#[derive(Clone, Copy, Debug)]
struct Line { item: usize, depth: u32, last: bool, flat: bool }

/// What a prompt of the tree's asks for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ask { Search, Filter, Kill, KillTagged, Command }

impl Ask {
    /// The prompt's history (PROMPT_TYPE_SEARCH for search and filter, else a command's).
    pub fn ptype(self) -> usize { match self { Ask::Search | Ask::Filter => 1, _ => 0 } }
    /// PROMPT_SINGLE: one key answers.
    pub fn single(self) -> bool { matches!(self, Ask::Kill | Ask::KillTagged) }
}

/// How choose-tree was asked for (cmd-choose-tree.c's flags).
#[derive(Clone, Debug, Default)]
pub struct Start {
    /// choose-buffer: the paste buffers' mode.
    pub buffer: bool,
    pub session: bool,
    pub window: bool,
    pub format: Option<String>,
    pub key_format: Option<String>,
    pub command: Option<String>,
    pub filter: Option<String>,
    pub sort: Option<String>,
    pub reversed: bool,
    pub no_preview: bool,
    /// -G: every session of a group (else one each: squash_groups).
    pub groups: bool,
    pub zoom: bool,
}

/// mode_tree_data and window_tree_modedata together.
#[derive(Clone, Debug)]
pub struct Tree {
    flavour: Flavour,
    pane: u64,
    /// -Z: whether the window was zoomed before (-1 not asked; 0 zoomed here, undone at the end).
    zoomed: i8,
    items: Vec<Item>,
    roots: Vec<usize>,
    lines: Vec<Line>,
    width: u32,
    height: u32,
    offset: usize,
    current: usize,
    preview: bool,
    search: Option<String>,
    filter: Option<String>,
    no_matches: bool,
    search_back: bool,
    sort: usize,
    groups: bool,
    reversed: bool,
    format: String,
    key_format: String,
    command: String,
    kind: Kind,
    /// The target it was started for (its session, its window's tab and its pane).
    fs: (u32, String, u64),
    /// The preview's window of items when they don't all fit (data->offset, left, right …).
    poffset: i64,
    left: i64,
    right: i64,
    start: u32,
    end: u32,
    each: u32,
    /// Builds so far: each makes its items anew (tmux frees and allocates them), so the current
    /// item after one is another item, whose preview starts at no offset.
    builds: u64,
    /// The size it was last built at.
    size: (u32, u32),
    /// What the status line was showing when it was last built (status_mark).
    status_seen: (u64, u64, String),
}

/// Each item's tag (tmux's is the session, winlink or pane pointer): a session's, a window's in
/// that session, a pane's.
fn session_tag(sid: u32) -> u64 { (3u64 << 56) | sid as u64 }
/// Another client's window in the tree: `remote:<number>` for its tab, its number past every @id.
const REMOTE: &str = "remote:";
const REMOTE_WINDOW: u64 = 1 << 31;

fn window_tag(sid: u32, wid: u64) -> u64 { (1u64 << 56) | ((sid as u64) << 32) | wid }
fn pane_tag(id: u64) -> u64 { (2u64 << 56) | id }

/// [f] with session [sid] in front — quietly, as a command that names it runs there, so its
/// #{session_attached} is 0 — and the one in front back after; None when there is no such session.
fn in_session<R>(app: &mut App, sid: u32, f: impl FnOnce(&mut App) -> R) -> Option<R> {
    if sid == app.session_id { return Some(f(app)) }
    let (me, outer) = (app.session_id, app.swap_back);
    if !app.swap_session(sid) { return None }
    app.swap_back = Some(me);
    let r = f(app);
    // (A session killed while in front has already gone back.)
    if app.session_id != me { app.swap_session(me); }
    app.swap_back = outer;
    Some(r)
}

/// A session's windows and which is current: the one in front's, or another's, kept aside.
fn session_tabs(app: &App, sid: u32) -> Option<(&[crate::app::Tab], usize)> {
    if sid == app.session_id { return Some((&app.tabs, app.active)) }
    app.sessions.iter().find(|s| s.id == sid).map(|s| (&s.tabs[..], s.active))
}

/// An item's format against the session, a window or a pane (format_single with them).
fn expand(app: &mut App, fmt: &str, ftype: u8, window: usize, pane: Option<u64>) -> String {
    app.format_type = Some(ftype);
    let out = crate::format::expand(app, fmt, window, pane, false);
    app.format_type = None;
    out
}

/// format_true.
fn is_true(s: &str) -> bool { !s.is_empty() && s != "0" }

impl Tree {
    /// window_tree_init: the mode for [pane], built and ready to draw at [sx] × [sy].
    pub fn start(app: &mut App, pane: u64, window: usize, a: &Start, sx: u32, sy: u32) -> Tree {
        let flavour = if a.buffer { Flavour::Buffer } else { Flavour::Tree };
        let sorts = if a.buffer { &BUFFER_SORTS } else { &SORTS };
        let sort = a.sort.as_deref().and_then(|s| sorts.iter().position(|x| x.eq_ignore_ascii_case(s))).unwrap_or(0);
        let tab = app.tabs.get(window).map(|t| t.id.clone()).unwrap_or_default();
        let (format, command) = if a.buffer { (BUFFER_FORMAT.to_string(), BUFFER_COMMAND) } else { (default_format(app.options.tmux_look()), DEFAULT_COMMAND) };
        let mut t = Tree {
            flavour,
            pane,
            zoomed: -1,
            items: Vec::new(),
            roots: Vec::new(),
            lines: Vec::new(),
            width: sx,
            height: sy,
            offset: 0,
            current: 0,
            preview: !a.no_preview,
            search: None,
            filter: a.filter.clone(),
            no_matches: false,
            search_back: false,
            sort,
            groups: a.groups,
            reversed: a.reversed,
            format: a.format.clone().unwrap_or(format),
            key_format: a.key_format.clone().unwrap_or_else(|| DEFAULT_KEY_FORMAT.to_string()),
            command: a.command.clone().unwrap_or_else(|| command.to_string()),
            kind: if a.buffer { Kind::None } else if a.session { Kind::Session } else if a.window { Kind::Window } else { Kind::Pane },
            fs: (app.session_id, tab, pane),
            poffset: 0,
            left: -1,
            right: -1,
            start: 0,
            end: 0,
            each: 0,
            builds: 0,
            size: (0, 0),
            status_seen: (u64::MAX, 0, String::new()),
        };
        // mode_tree_zoom: -Z zooms the pane (a window of one pane can't be), and the end of the
        // mode undoes it if it was not zoomed before.
        if a.zoom {
            let was = app.tabs.get(window).map(|t| t.zoomed).unwrap_or(false);
            t.zoomed = if was { 1 } else { 0 };
            if !was {
                if let Some(tab) = app.tabs.get_mut(window) {
                    if tab.panes().len() > 1 { if tab.focus != Some(pane) { tab.set_active(pane) } tab.zoomed = true }
                }
                app.fit_panes();
            }
        }
        let (sx, sy) = crate::copy::screen_size(app, pane);
        t.build(app, sx, sy);
        t.kind = Kind::None;
        t
    }

    // ── mode_tree_build and window_tree_build ────────────────────────────────

    /// mode_tree_build: the items again (their tags keep what was expanded and tagged), then the
    /// lines, the current one found again by its tag.
    pub fn build(&mut self, app: &mut App, sx: u32, sy: u32) {
        self.builds += 1;
        let mut tag = self.lines.get(self.current).map(|l| self.items[l.item].tag).unwrap_or(u64::MAX);
        // What the items in the tree were (mode_tree_remove frees an item: one the filter took
        // out comes back new).
        let mut saved: HashMap<u64, (bool, bool)> = HashMap::new();
        let mut stack = self.roots.clone();
        while let Some(i) = stack.pop() { saved.insert(self.items[i].tag, (self.items[i].expanded, self.items[i].tagged)); stack.extend(self.items[i].children.iter().copied()) }
        self.items.clear();
        self.roots.clear();
        let filter = self.filter.clone();
        self.build_items(app, &saved, &mut tag, filter.as_deref());
        self.no_matches = self.roots.is_empty();
        if self.no_matches {
            self.items.clear();
            self.roots.clear();
            self.build_items(app, &saved, &mut tag, None);
        }
        self.lines.clear();
        let roots = self.roots.clone();
        self.build_lines(app, &roots, 0);
        if !self.lines.is_empty() && tag == u64::MAX { tag = self.items[self.lines[self.current.min(self.lines.len() - 1)].item].tag }
        self.set_current(tag);
        self.width = sx;
        if self.preview { self.set_height(sy) } else { self.height = sy }
        self.check_selected();
        self.size = (sx, sy);
    }

    /// Built again for what the windows are now, between the builds tmux makes (a key's, a
    /// resize's, a change to the window's): the lines keep their place, as tmux's stay where they
    /// were drawn — unless the lines, the current one's place or the size changed, when it is
    /// tmux's build (the current line found again by its tag, the offset from it).
    fn refresh(&mut self, app: &mut App, sx: u32, sy: u32) {
        let (current, offset, n, size) = (self.current, self.offset, self.lines.len(), self.size);
        self.build(app, sx, sy);
        if self.current == current && self.lines.len() == n && self.size == size { self.offset = offset }
    }

    /// window_tree_build: every session, in the sort's order (window_tree_cmp_session: by index
    /// its id, by name, by time the most recently used first), each built with it in front.
    fn build_items(&mut self, app: &mut App, saved: &HashMap<u64, (bool, bool)>, tag: &mut u64, filter: Option<&str>) {
        if self.flavour == Flavour::Buffer { return self.build_buffers(app, saved, filter) }
        let front = app.session_id;
        let mut order: Vec<(u32, String, i64, u64)> = app.session_list().into_iter().map(|(id, name)| {
            // The session on screen is the one in use now; another, when it was last — within
            // one second, the later used (or made) first, as tmux's microseconds have it.
            let used = if id == front { i64::MAX } else { app.stash_value(id, "session_activity").and_then(|v| v.parse().ok()).unwrap_or(0) };
            let order = app.sessions.iter().find(|s| s.id == id).map(|s| s.used).unwrap_or(0);
            (id, name, used, order)
        }).collect();
        let (field, reversed) = (self.sort, self.reversed);
        order.sort_by(|a, b| {
            let by_name = || a.1.as_bytes().cmp(b.1.as_bytes());
            let r = match field { 0 => a.0.cmp(&b.0), 2 => b.2.cmp(&a.2).then(b.3.cmp(&a.3)).then_with(by_name), _ => by_name() };
            if reversed { r.reverse() } else { r }
        });
        // squash_groups (no -G): one session of each group — the one in front for its own group,
        // the first to join it for another.
        let current_group = app.group_of(self.fs.0);
        for (sid, ..) in order {
            if !self.groups {
                if let Some(g) = app.group_of(sid) {
                    let first = app.group_sessions(&g).first().map(|x| x.0);
                    if (Some(&g) == current_group.as_ref() && sid != self.fs.0) || (Some(&g) != current_group.as_ref() && Some(sid) != first) { continue }
                }
            }
            // Another client's session: listed as its own row, as tmux's tree lists every session.
            if in_session(app, sid, |app| self.build_session(app, saved, filter, sid)).is_none() { self.build_remote(app, saved, filter, sid) }
        }
        let (fsid, ftab, fpane) = self.fs.clone();
        let fs_window = session_tabs(app, fsid).and_then(|(tabs, _)| tabs.iter().find(|t| t.id == ftab).map(|t| (t.wid(), t.panes().len())));
        match self.kind {
            Kind::None => {}
            Kind::Session => *tag = session_tag(fsid),
            Kind::Window => { if let Some((wid, _)) = fs_window { *tag = window_tag(fsid, wid) } }
            Kind::Pane => { if let Some((wid, n)) = fs_window { *tag = if n == 1 { window_tag(fsid, wid) } else { pane_tag(fpane) } } }
        }
    }

    /// A session another client of this name has: its row (its own formats), collapsed — its
    /// windows are that client's. Left out by a filter, which is about panes.
    fn build_remote(&mut self, app: &mut App, saved: &HashMap<u64, (bool, bool)>, filter: Option<&str>, sid: u32) {
        if filter.is_some() { return }
        let Some(name) = app.session_list().into_iter().find(|(i, _)| *i == sid).map(|(_, n)| n) else { return };
        app.format_type = Some(FORMAT_SESSION);
        let text = crate::format::expand_session(app, &self.format, sid);
        app.format_type = None;
        let expanded = if self.kind == Kind::Session { 0 } else { 1 };
        let s = self.add(saved, None, What::Session(sid), session_tag(sid), name, Some(text), expanded);
        // Its windows, as the client that has it keeps them (by number: chosen, they are shown
        // as that client has them).
        let mut windows: Vec<(usize, (usize, String, usize))> = app.session_windows(sid).into_iter().enumerate().collect();
        let (field, reversed) = (self.sort, self.reversed);
        windows.sort_by(|a, b| { let r = match field { 1 => a.1.1.as_bytes().cmp(b.1.1.as_bytes()), _ => a.1.0.cmp(&b.1.0) }; if reversed { r.reverse() } else { r } });
        for (k, (num, _, _)) in windows {
            app.format_type = Some(FORMAT_WINDOW);
            let text = crate::format::expand_session_window(app, &self.format, sid, k);
            app.format_type = None;
            self.add(saved, Some(s), What::Window(sid, format!("{REMOTE}{num}")), window_tag(sid, REMOTE_WINDOW | num as u64), num.to_string(), Some(text), 0);
        }
    }

    /// window_buffer_build: every paste buffer, sorted (by time the newest first, by size the
    /// biggest first, by name — the name breaking ties), those the filter keeps, each its format
    /// (#{buffer_*}, with the mode's pane) as its text; tagged by its order.
    fn build_buffers(&mut self, app: &mut App, saved: &HashMap<u64, (bool, bool)>, filter: Option<&str>) {
        let mut list: Vec<(String, u64, usize)> = app.paste.walk().map(|b| (b.name.clone(), b.order, b.data.len())).collect();
        let (field, reversed) = (self.sort, self.reversed);
        list.sort_by(|a, b| {
            let r = match field { 0 => b.1.cmp(&a.1), 2 => b.2.cmp(&a.2), _ => std::cmp::Ordering::Equal }.then_with(|| a.0.as_bytes().cmp(b.0.as_bytes()));
            if reversed { r.reverse() } else { r }
        });
        let window = app.tabs.iter().position(|t| t.panes().contains(&self.pane)).unwrap_or(app.active);
        for (name, order, _) in list {
            app.format_buffer = Some(name.clone());
            let keep = filter.map(|f| is_true(&crate::format::expand(app, f, window, Some(self.pane), false))).unwrap_or(true);
            let text = keep.then(|| crate::format::expand(app, &self.format, window, Some(self.pane), false));
            app.format_buffer = None;
            let Some(text) = text else { continue };
            self.add(saved, None, What::Buffer(name.clone()), order, name, Some(text), -1);
        }
    }

    /// mode_tree_add: an item, what it was before (expanded, tagged) kept by its tag.
    #[allow(clippy::too_many_arguments)]
    fn add(&mut self, saved: &HashMap<u64, (bool, bool)>, parent: Option<usize>, what: What, tag: u64, name: String, text: Option<String>, expanded: i8) -> usize {
        let mut item = Item { parent, what, line: 0, key: None, keystr: None, tag, name, text, expanded: false, tagged: false, children: Vec::new() };
        match saved.get(&tag) {
            Some(&(exp, tagged)) => {
                if parent.map(|p| self.items[p].expanded).unwrap_or(true) { item.tagged = tagged }
                item.expanded = exp;
            }
            None => item.expanded = expanded == -1 || expanded == 1,
        }
        let id = self.items.len();
        self.items.push(item);
        match parent { Some(p) => self.items[p].children.push(id), None => self.roots.push(id) }
        id
    }

    /// mode_tree_remove.
    fn remove(&mut self, id: usize) {
        match self.items[id].parent { Some(p) => self.items[p].children.retain(|c| *c != id), None => self.roots.retain(|c| *c != id) }
    }

    /// window_tree_build_session: session [sid] (in front), its windows sorted, gone if none has a
    /// pane that passes the filter.
    fn build_session(&mut self, app: &mut App, saved: &HashMap<u64, (bool, bool)>, filter: Option<&str>, sid: u32) {
        let (active, focus) = (app.active, app.tabs.get(app.active).and_then(|t| t.focus));
        let text = expand(app, &self.format, FORMAT_SESSION, active, focus);
        let expanded = if self.kind == Kind::Session { 0 } else { 1 };
        let name = app.session_name();
        let s = self.add(saved, None, What::Session(sid), session_tag(sid), name, Some(text), expanded);
        let mut order: Vec<usize> = (0..app.tabs.len()).collect();
        let (field, reversed) = (self.sort, self.reversed);
        order.sort_by(|a, b| {
            let (ta, tb) = (&app.tabs[*a], &app.tabs[*b]);
            let by_name = || ta.name.as_bytes().cmp(tb.name.as_bytes());
            let r = match field {
                0 => app.win_num(*a).cmp(&app.win_num(*b)),
                // (Within one second: the one active last first, as by tmux's microseconds.)
                2 => tb.activity.cmp(&ta.activity).then(tb.last_output.cmp(&ta.last_output)).then(tb.wid().cmp(&ta.wid())).then_with(by_name),
                _ => by_name(),
            };
            if reversed { r.reverse() } else { r }
        });
        let n = order.len();
        let mut empty = 0;
        for w in order { if !self.build_window(app, saved, s, w, filter, sid) { empty += 1 } }
        if empty == n { self.remove(s) }
    }

    /// window_tree_filter_pane.
    fn passes(app: &mut App, w: usize, p: u64, filter: Option<&str>) -> bool {
        match filter { None => true, Some(f) => is_true(&expand(app, f, FORMAT_PANE, w, Some(p))) }
    }

    /// window_tree_build_window: a window of session [sid] (in front) and, with more than one,
    /// its panes.
    #[allow(clippy::too_many_arguments)]
    fn build_window(&mut self, app: &mut App, saved: &HashMap<u64, (bool, bool)>, parent: usize, w: usize, filter: Option<&str>, sid: u32) -> bool {
        let (id, wid, focus, panes) = { let t = &app.tabs[w]; (t.id.clone(), t.wid(), t.focus, t.panes()) };
        let text = expand(app, &self.format, FORMAT_WINDOW, w, focus);
        let name = app.win_num(w).to_string();
        let expanded = if matches!(self.kind, Kind::Session | Kind::Window) { 0 } else { 1 };
        let item = self.add(saved, Some(parent), What::Window(sid, id.clone()), window_tag(sid, wid), name, Some(text), expanded);
        if panes.is_empty() { self.remove(item); return false }
        if panes.len() == 1 {
            if !Self::passes(app, w, panes[0], filter) { self.remove(item); return false }
            return true;
        }
        let mut l: Vec<u64> = Vec::new();
        for p in &panes { if Self::passes(app, w, *p, filter) { l.push(*p) } }
        if l.is_empty() { self.remove(item); return false }
        let points = app.tabs[w].points.clone();
        let (field, reversed) = (self.sort, self.reversed);
        l.sort_by(|a, b| {
            // Panes have no names: by number, unless by time (when each was last active).
            let r = if field == 2 { points.get(a).copied().unwrap_or(0).cmp(&points.get(b).copied().unwrap_or(0)) }
                else { panes.iter().position(|x| x == a).cmp(&panes.iter().position(|x| x == b)) };
            if reversed { r.reverse() } else { r }
        });
        for p in l {
            let idx = panes.iter().position(|x| *x == p).unwrap_or(0) + app.pane_base(w);
            let text = expand(app, &self.format, FORMAT_PANE, w, Some(p));
            self.add(saved, Some(item), What::Pane(sid, id.clone(), p), pane_tag(p), idx.to_string(), Some(text), -1);
        }
        true
    }

    /// mode_tree_build_lines: the visible items, their depth, whether each is its list's last,
    /// whether its list is flat (no item in it has children), and each one's key.
    fn build_lines(&mut self, app: &mut App, list: &[usize], depth: u32) {
        let mut flat = true;
        for (i, &id) in list.iter().enumerate() {
            self.lines.push(Line { item: id, depth, last: i + 1 == list.len(), flat: false });
            let line = self.lines.len() - 1;
            self.items[id].line = line;
            if !self.items[id].children.is_empty() { flat = false }
            if self.items[id].expanded {
                let children = self.items[id].children.clone();
                self.build_lines(app, &children, depth + 1);
            }
            let key = self.get_key(app, id, line);
            self.items[id].keystr = key.as_ref().map(keys::name);
            self.items[id].key = key;
        }
        for &id in list { let l = self.items[id].line; self.lines[l].flat = flat }
    }

    /// window_tree_get_key: the key format against the item (its session in front), #{line} its
    /// line.
    fn get_key(&self, app: &mut App, id: usize, line: usize) -> Option<Chord> {
        // window_buffer_get_key: the buffer's formats, #{line} its line.
        if let What::Buffer(name) = &self.items[id].what {
            let window = app.tabs.iter().position(|t| t.panes().contains(&self.pane)).unwrap_or(app.active);
            app.format_buffer = Some(name.clone());
            app.format_line = Some(line);
            let s = crate::format::expand(app, &self.key_format, window, Some(self.pane), false);
            app.format_line = None;
            app.format_buffer = None;
            return keys::parse(&s).ok();
        }
        let ftype = match self.items[id].what { What::Session(_) => FORMAT_SESSION, What::Window(..) => FORMAT_WINDOW, _ => FORMAT_PANE };
        // Another client's session (or window): its key by its line alone.
        let remote_window = matches!(&self.items[id].what, What::Window(_, tab) if tab.starts_with(REMOTE));
        if let What::Session(sid) | What::Window(sid, _) = self.items[id].what { if remote_window || (matches!(self.items[id].what, What::Session(_)) && app.remote_owner(sid).is_some()) {
            app.format_line = Some(line);
            let s = crate::format::expand_session(app, &self.key_format, sid);
            app.format_line = None;
            return keys::parse(&s).ok();
        } }
        let s = in_session(app, self.items[id].what.session(), |app| {
            let Pulled { window, pane } = self.pull(app, id)?;
            app.format_line = Some(line);
            let s = expand(app, &self.key_format, ftype, window, pane);
            app.format_line = None;
            Some(s)
        }).flatten()?;
        keys::parse(&s).ok()
    }

    /// window_tree_pull_item: where an item is now, its session in front — its window and pane
    /// (a session's: its current window's active pane; a window's: its active pane). None if it
    /// has gone, or its session is not the one in front.
    fn pull(&self, app: &App, id: usize) -> Option<Pulled> {
        let what = &self.items[id].what;
        if what.session() != app.session_id { return None }
        match what {
            What::Buffer(_) => None,
            What::Session(_) => { let w = app.active; Some(Pulled { window: w, pane: app.tabs.get(w)?.focus }) }
            What::Window(_, tab) => { let w = app.tabs.iter().position(|t| &t.id == tab)?; Some(Pulled { window: w, pane: app.tabs[w].focus }) }
            What::Pane(_, tab, p) => {
                let w = app.tabs.iter().position(|t| &t.id == tab)?;
                if !app.tabs[w].panes().contains(p) { return None }
                Some(Pulled { window: w, pane: Some(*p) })
            }
        }
    }

    /// pull, with the item's session in front for the moment: what [f] makes of where it is.
    fn pulled<R>(&self, app: &mut App, id: usize, f: impl FnOnce(&mut App, Pulled) -> Option<R>) -> Option<R> {
        in_session(app, self.items[id].what.session(), |app| { let p = self.pull(app, id)?; f(app, p) }).flatten()
    }

    // ── mode_tree's moves ────────────────────────────────────────────────────

    fn check_selected(&mut self) {
        if self.height > 0 && self.current > self.height as usize - 1 { self.offset = self.current - self.height as usize + 1 }
    }

    /// mode_tree_set_height: two thirds of the pane for the list (half, when the lines are
    /// fewer), the whole of it when that leaves under ten lines or under two for the preview.
    fn set_height(&mut self, sy: u32) {
        self.height = (sy / 3) * 2;
        if self.height as usize > self.lines.len() { self.height = sy / 2 }
        if self.height < 10 { self.height = sy }
        if sy.saturating_sub(self.height) < 2 { self.height = sy }
    }

    fn up(&mut self, wrap: bool) {
        if self.current == 0 {
            if wrap {
                self.current = self.lines.len().saturating_sub(1);
                if self.lines.len() >= self.height as usize { self.offset = self.lines.len() - self.height as usize }
            }
        } else {
            self.current -= 1;
            if self.current < self.offset { self.offset -= 1 }
        }
    }

    fn down(&mut self, wrap: bool) -> bool {
        if self.current + 1 >= self.lines.len() {
            if !wrap { return false }
            self.current = 0;
            self.offset = 0;
        } else {
            self.current += 1;
            if self.current + 1 > self.offset + self.height as usize { self.offset += 1 }
        }
        true
    }

    fn line_of_tag(&self, tag: u64) -> Option<usize> { self.lines.iter().position(|l| self.items[l.item].tag == tag) }

    /// mode_tree_set_current: the line with that tag, else the first.
    fn set_current(&mut self, tag: u64) -> bool {
        match self.line_of_tag(tag) {
            Some(found) => {
                self.current = found;
                self.offset = if self.height > 0 && self.current > self.height as usize - 1 { self.current - self.height as usize + 1 } else { 0 };
                true
            }
            None => { self.current = 0; self.offset = 0; false }
        }
    }

    fn expand_tag(&mut self, app: &mut App, tag: u64, sx: u32, sy: u32) {
        if let Some(found) = self.line_of_tag(tag) {
            let id = self.lines[found].item;
            if !self.items[id].expanded { self.items[id].expanded = true; self.build(app, sx, sy) }
        }
    }

    fn current_item(&self) -> Option<usize> { self.lines.get(self.current).map(|l| l.item) }

    fn count_tagged(&self) -> usize { self.lines.iter().filter(|l| self.items[l.item].tagged).count() }

    /// mode_tree_each_tagged: the tagged items (or, with none, the current one).
    fn each_tagged(&self, current: bool) -> Vec<usize> {
        let tagged: Vec<usize> = self.lines.iter().map(|l| l.item).filter(|i| self.items[*i].tagged).collect();
        if tagged.is_empty() && current { self.current_item().into_iter().collect() } else { tagged }
    }

    // ── search ───────────────────────────────────────────────────────────────

    fn matches(&self, app: &mut App, id: usize, s: &str) -> bool {
        // window_tree_search: a session's name, a window's name, a pane's command.
        match &self.items[id].what {
            // window_buffer_search: its name, else its text.
            What::Buffer(name) => name.contains(s) || app.paste.get(name).map(|b| b.data.contains(s)).unwrap_or(false),
            What::Session(sid) => app.session_list().iter().any(|(i, name)| i == sid && name.contains(s)),
            What::Window(sid, tab) => session_tabs(app, *sid).and_then(|(tabs, _)| tabs.iter().find(|t| &t.id == tab).map(|t| t.name.contains(s))).unwrap_or(false),
            What::Pane(..) => self.pulled(app, id, |app, Pulled { window, pane }| {
                let cmd = crate::format::expand(app, "#{pane_current_command}", window, pane, false);
                Some(!cmd.is_empty() && cmd.contains(s))
            }).unwrap_or(false),
        }
    }

    fn prev_sibling(&self, id: usize) -> Option<usize> {
        let list = match self.items[id].parent { Some(p) => &self.items[p].children, None => &self.roots };
        let at = list.iter().position(|x| *x == id)?;
        if at == 0 { None } else { Some(list[at - 1]) }
    }

    fn next_sibling(&self, id: usize) -> Option<usize> {
        let list = match self.items[id].parent { Some(p) => &self.items[p].children, None => &self.roots };
        let at = list.iter().position(|x| *x == id)?;
        list.get(at + 1).copied()
    }

    /// mode_tree_search_forward / _backward: through every item (collapsed ones too), from the
    /// current one round, for the first that matches.
    fn search_from(&self, app: &mut App) -> Option<usize> {
        let s = self.search.as_deref()?;
        let last = self.current_item()?;
        let mut mti = last;
        loop {
            if self.search_back {
                mti = match self.prev_sibling(mti) {
                    Some(mut prev) => { while let Some(&c) = self.items[prev].children.last() { prev = c } prev }
                    None => match self.items[mti].parent {
                        Some(p) => p,
                        None => { let mut prev = *self.roots.last()?; while let Some(&c) = self.items[prev].children.last() { prev = c } prev }
                    },
                };
            } else {
                mti = if let Some(&c) = self.items[mti].children.first() { c }
                else if let Some(n) = self.next_sibling(mti) { n }
                else {
                    let mut up = Some(mti);
                    let mut found = None;
                    while let Some(u) = up.and_then(|u| self.items[u].parent) {
                        if let Some(n) = self.next_sibling(u) { found = Some(n); break }
                        up = Some(u);
                    }
                    found.or_else(|| self.roots.first().copied())?
                };
            }
            if mti == last { return None }
            if self.matches(app, mti, s) { return Some(mti) }
        }
    }

    /// mode_tree_search_set: to the match, its parents expanded.
    fn search_set(&mut self, app: &mut App, sx: u32, sy: u32) {
        let Some(mti) = self.search_from(app) else { return };
        let tag = self.items[mti].tag;
        let mut up = self.items[mti].parent;
        while let Some(u) = up { self.items[u].expanded = true; up = self.items[u].parent }
        self.build(app, sx, sy);
        self.set_current(tag);
    }

    // ── drawing ──────────────────────────────────────────────────────────────

    /// What the preview shows for the current item, read with its session in front.
    fn plan(&self, app: &mut App) -> Plan {
        let Some(id) = self.current_item() else { return Plan::Nothing };
        let what = self.items[id].what.clone();
        if let What::Buffer(name) = what { return Plan::Buffer(name) }
        self.pulled(app, id, |app, Pulled { window, pane }| {
            let pane = pane?;
            // The session's display-panes-colour and display-panes-active-colour (s->options).
            let colour = |name: &str, d: Color| crate::tmuxconf::colour(&app.options.get(name, "", None).unwrap_or_default()).unwrap_or(d);
            let colours = (colour("display-panes-colour", Color::Blue), colour("display-panes-active-colour", Color::Red));
            Some(match what {
                What::Pane(..) => Plan::Pane(pane),
                What::Window(..) => {
                    let (panes, active, base) = (app.tabs[window].panes(), app.tabs[window].focus, app.pane_base(window));
                    let items = panes.iter().enumerate().map(|(i, p)| (*p, format!(" {} ", i + base), Some(*p) == active)).collect();
                    Plan::Row { items, session: false, colours }
                }
                What::Buffer(_) => Plan::Nothing,
                What::Session(_) => {
                    let mut order: Vec<usize> = (0..app.tabs.len()).collect();
                    order.sort_by_key(|w| app.win_num(*w));
                    let items = order.iter().filter_map(|w| app.tabs[*w].focus.map(|f| (f, format!(" {}:{} ", app.win_num(*w), app.tabs[*w].name), *w == app.active))).collect();
                    Plan::Row { items, session: true, colours }
                }
            })
        }).unwrap_or(Plan::Nothing)
    }

    /// mode_tree_draw into [area] (the pane's cells): the list, then the preview box, showing
    /// [plan].
    pub fn draw(&mut self, app: &App, buf: &mut Buffer, area: Rect, plan: &Plan) {
        for y in area.y..area.y + area.height { for x in area.x..area.x + area.width { if let Some(c) = buf.cell_mut((x, y)) { c.reset(); } } }
        if self.lines.is_empty() { return }
        let window = app.tabs.iter().position(|t| t.panes().contains(&self.pane)).unwrap_or(app.active);
        let mode = crate::draw::style_over(&app.style_spec("mode-style", window, Some(self.pane)), Style::default());
        let (w, h) = (self.width.min(area.width as u32), self.height.min(area.height as u32));
        let keylen = self.lines.iter().filter_map(|l| self.items[l.item].keystr.as_ref()).map(|k| k.len() + 3).max().unwrap_or(0);
        for i in self.offset..self.lines.len() {
            if i > self.offset + h as usize - 1 { break }
            let line = self.lines[i];
            let item = &self.items[line.item];
            let row = area.y + (i - self.offset) as u16;
            let key = match &item.keystr { Some(k) => format!("({k}){}", " ".repeat(keylen.saturating_sub(2 + k.len()))), None => String::new() };
            let symbol = if line.flat { "" } else if item.children.is_empty() { "  " } else if item.expanded { "- " } else { "+ " };
            let start = if line.depth == 0 { symbol.to_string() } else {
                let mut s = String::new();
                for _ in 1..line.depth {
                    let parent_last = item.parent.map(|p| self.lines[self.items[p].line].last).unwrap_or(false);
                    s.push_str(if parent_last { "    " } else { "│   " });
                }
                s.push_str(if line.last { "└─> " } else { "├─> " });
                s.push_str(symbol);
                s
            };
            let text = format!("{key:<keylen$}{start}{}{}{}", item.name, if item.tagged { "*" } else { "" }, if item.text.is_some() { ": " } else { "" });
            let width = (text.width() as u32).min(w);
            let bold = |s: Style| if item.tagged { if s.add_modifier.contains(Modifier::BOLD) { s.remove_modifier(Modifier::BOLD) } else { s.add_modifier(Modifier::BOLD) } } else { s };
            let (gc0, gc) = (bold(Style::default()), bold(mode));
            let current = i == self.current;
            let base = if current { gc } else { gc0 };
            // screen_write_clearendofline: the default, or the mode's background on the current one.
            let clear = if current { Style::default().bg(mode.bg.unwrap_or(Color::Reset)) } else { Style::default() };
            for x in 0..w as u16 { if let Some(c) = buf.cell_mut((area.x + x, row)) { c.reset(); c.set_style(clear); } }
            let mut x = 0u16;
            for ch in text.chars() {
                let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0) as u16;
                if x + cw > w as u16 { break }
                if let Some(c) = buf.cell_mut((area.x + x, row)) { c.set_char(ch).set_style(base); }
                x += cw;
            }
            if let Some(t) = &item.text {
                let avail = w.saturating_sub(width) as u16;
                for (k, cell) in crate::draw::format_draw_over(t, base, avail).into_iter().enumerate() {
                    let Some((sym, st)) = cell else { continue };
                    if let Some(c) = buf.cell_mut((area.x + x + k as u16, row)) { c.set_symbol(&sym).set_style(st); }
                }
            }
        }
        let sy = area.height as u32;
        if !self.preview || sy <= 4 || h <= 4 || sy - h <= 4 || w <= 4 { return }
        let Some(id) = self.current_item() else { return };
        // The box, and its title: the item and the sort order (and the filter's state).
        let by = area.y + h as u16;
        draw_box(buf, area.x, by, w as u16, (sy - h) as u16, Style::default());
        let sorts = if self.flavour == Flavour::Buffer { &BUFFER_SORTS } else { &SORTS };
        let title = format!(" {} (sort: {}{})", self.items[id].name, sorts[self.sort], if self.reversed { ", reversed" } else { "" });
        if w as usize - 2 >= title.len() {
            let mut x = area.x + 1;
            let mut put = |s: &str, st: Style, x: &mut u16| { for ch in s.chars() { if *x >= area.x + w as u16 { break } if let Some(c) = buf.cell_mut((*x, by)) { c.set_char(ch).set_style(st); } *x += 1 } };
            put(&title, Style::default(), &mut x);
            let n = if self.no_matches { "no matches".len() } else { "active".len() };
            if self.filter.is_some() && w as usize - 2 >= title.len() + 10 + n + 2 {
                put(" (filter: ", Style::default(), &mut x);
                if self.no_matches { put("no matches", mode, &mut x) } else { put("active", Style::default(), &mut x) }
                put(") ", Style::default(), &mut x);
            } else { put(" ", Style::default(), &mut x) }
        }
        let (box_x, box_y) = (w - 4, sy - h - 2);
        if box_x != 0 && box_y != 0 { self.draw_item(app, buf, plan, area.x + 2, by + 1, box_x, box_y) }
    }

    /// window_tree_draw: a pane's cells; a window's panes, or a session's windows, side by side.
    #[allow(clippy::too_many_arguments)]
    fn draw_item(&mut self, app: &App, buf: &mut Buffer, plan: &Plan, x: u16, y: u16, sx: u32, sy: u32) {
        match plan {
            Plan::Nothing => {}
            Plan::Pane(pane) => { if let Some(p) = app.panes.get(pane) { crate::ui::screen_preview(buf, p, x, y, sx as u16, sy as u16) } }
            // window_buffer_draw: the buffer's lines, from its first, each vis-encoded (octal,
            // C-style, tabs), as far as the box is wide.
            Plan::Buffer(name) => {
                let Some(b) = app.paste.get(name) else { return };
                for (i, line) in b.data.split('\n').take(sy as usize).enumerate() {
                    let text = crate::paste::vis(line);
                    let mut cx = 0u16;
                    for ch in text.chars() {
                        let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0) as u16;
                        if cx + cw > sx as u16 { break }
                        if let Some(c) = buf.cell_mut((x + cx, y + i as u16)) { c.set_char(ch); }
                        cx += cw;
                    }
                }
            }
            Plan::Row { items, session, colours } => self.draw_row(app, buf, x, y, sx, sy, items, *session, *colours),
        }
    }

    /// window_tree_draw_session / _window: the things side by side (their panes' cells), as many
    /// as fit at 24 columns each (the current one among them; < and > when there are more, the
    /// offset moving them), each numbered in a box in display-panes-colour
    /// (display-panes-active-colour for the current one), a line between them.
    #[allow(clippy::too_many_arguments)]
    fn draw_row(&mut self, app: &App, buf: &mut Buffer, cx: u16, cy: u16, sx: u32, sy: u32, items: &[(u64, String, bool)], session: bool, colours: (Color, Color)) {
        let total = items.len() as u32;
        if total == 0 { return }
        let (colour, active_colour) = colours;
        let visible = if sx / total < 24 { (sx / 24).max(1) } else { total };
        let current = items.iter().position(|i| i.2).unwrap_or(0) as u32;
        let (mut start, mut end) = if current < visible { (0, visible) } else if current >= total - visible { (total - visible, total) } else { let s = current - visible / 2; (s, s + visible) };
        if self.poffset < -(start as i64) { self.poffset = -(start as i64) }
        if self.poffset > (total - end) as i64 { self.poffset = (total - end) as i64 }
        start = (start as i64 + self.poffset) as u32;
        end = (end as i64 + self.poffset) as u32;
        let (mut left, mut right) = (start != 0, end != total);
        if ((left && right) && sx <= 6) || ((left || right) && sx <= 3) { left = false; right = false }
        let (each, remaining) = if left && right { ((sx - 6) / visible, (sx - 6) - visible * ((sx - 6) / visible)) }
            else if left || right { ((sx - 3) / visible, (sx - 3) - visible * ((sx - 3) / visible)) }
            else { (sx / visible, sx - visible * (sx / visible)) };
        if each == 0 { return }
        if left {
            self.left = cx as i64 + 2;
            vline(buf, cx + 2, cy, sy as u16);
            put_str(buf, cx, cy + sy as u16 / 2, "<", Style::default());
        } else { self.left = -1 }
        if right {
            self.right = cx as i64 + sx as i64 - 3;
            vline(buf, cx + sx as u16 - 3, cy, sy as u16);
            put_str(buf, cx + sx as u16 - 1, cy + sy as u16 / 2, ">", Style::default());
        } else { self.right = -1 }
        self.start = start;
        self.end = end;
        self.each = each;
        for (i, loop_) in (start..end).enumerate() {
            let (pane, label, is_current) = &items[loop_ as usize];
            let gc = Style::default().fg(if *is_current { active_colour } else { colour });
            let offset = if left { 3 + i as u32 * each } else { i as u32 * each };
            let width = if loop_ == end - 1 { each + remaining } else { each - 1 };
            if let Some(p) = app.panes.get(pane) { crate::ui::screen_preview(buf, p, cx + offset as u16, cy, width as u16, sy as u16) }
            let label = if session && label.len() as u32 > width { label.split(':').next().map(|n| format!("{n} ")).unwrap_or_default() } else { label.clone() };
            draw_label(buf, cx + offset as u16, cy, if session { width } else { each }, sy, gc, &label);
            if loop_ != end - 1 { vline(buf, cx + (offset + width) as u16, cy, sy as u16) }
        }
    }

    // ── keys ─────────────────────────────────────────────────────────────────

    /// The target an item names (window_tree_get_target): `=session:`, `=session:1.`, or
    /// `=session:1.%3`, with its own session's name.
    fn target(&self, app: &mut App, id: usize) -> Option<String> {
        if let What::Buffer(name) = &self.items[id].what { return app.paste.get(name).map(|_| name.clone()) }
        // Another client's session, or one of its windows: by its name (switch-client shows it
        // as that client has it).
        if let What::Session(sid) = self.items[id].what { if app.remote_owner(sid).is_some() { return app.session_list().into_iter().find(|(i, _)| *i == sid).map(|(_, n)| format!("={n}:")) } }
        if let What::Window(sid, tab) = &self.items[id].what {
            if let Some(num) = tab.strip_prefix(REMOTE) { return app.session_list().into_iter().find(|(i, _)| i == sid).map(|(_, n)| format!("={n}:{num}.")) }
        }
        self.pulled(app, id, |app, Pulled { window, pane }| {
            let s = app.session_name();
            Some(match &self.items[id].what {
                What::Session(_) => format!("={s}:"),
                What::Window(..) => format!("={s}:{}.", app.win_num(window)),
                What::Pane(..) => format!("={s}:{}.{}", app.win_num(window), crate::pane::tag(pane?)),
                What::Buffer(_) => return None,
            })
        })
    }
}

struct Pulled { window: usize, pane: Option<u64> }

/// What the preview shows (window_tree_draw's pane, window and session): nothing, a pane's
/// cells, or things side by side — each one's pane, its label and whether it is the current one
/// (a session's windows, or a window's panes), in display-panes-colour and -active-colour.
pub enum Plan {
    Nothing,
    Pane(u64),
    Buffer(String),
    Row { items: Vec<(u64, String, bool)>, session: bool, colours: (Color, Color) },
}

/// screen_write_box, BOX_LINES_DEFAULT: ┌─┐ │ │ └─┘.
fn draw_box(buf: &mut Buffer, x: u16, y: u16, w: u16, h: u16, st: Style) {
    if w < 2 || h < 2 { return }
    for i in 0..w {
        let (top, bottom) = match i { 0 => ("┌", "└"), i if i == w - 1 => ("┐", "┘"), _ => ("─", "─") };
        if let Some(c) = buf.cell_mut((x + i, y)) { c.set_symbol(top).set_style(st); }
        if let Some(c) = buf.cell_mut((x + i, y + h - 1)) { c.set_symbol(bottom).set_style(st); }
    }
    for j in 1..h - 1 {
        if let Some(c) = buf.cell_mut((x, y + j)) { c.set_symbol("│").set_style(st); }
        if let Some(c) = buf.cell_mut((x + w - 1, y + j)) { c.set_symbol("│").set_style(st); }
    }
}

/// screen_write_vline with no ends: │ down [h] cells.
fn vline(buf: &mut Buffer, x: u16, y: u16, h: u16) {
    for j in 0..h { if let Some(c) = buf.cell_mut((x, y + j)) { c.set_symbol("│").set_style(Style::default()); } }
}

fn put_str(buf: &mut Buffer, x: u16, y: u16, s: &str, st: Style) {
    for (i, ch) in s.chars().enumerate() { if let Some(c) = buf.cell_mut((x + i as u16, y)) { c.set_char(ch).set_style(st); } }
}

/// window_tree_draw_label: [label] in the middle of the [sx] × [sy] area at (px, py), in a box
/// when there is room around it.
fn draw_label(buf: &mut Buffer, px: u16, py: u16, sx: u32, sy: u32, gc: Style, label: &str) {
    let len = label.len() as u32;
    if sx == 0 || sy == 1 || len > sx { return }
    let (ox, oy) = ((sx - len + 1) / 2, (sy + 1) / 2);
    if ox > 1 && ox + len < sx - 1 && sy >= 3 { draw_box(buf, px + ox as u16 - 1, py + oy as u16 - 1, len as u16 + 2, 3, Style::default()) }
    put_str(buf, px + ox as u16, py + oy as u16, label, gc);
}

// ── the mode on a pane ───────────────────────────────────────────────────────

fn take(app: &mut App, pane: u64) -> Option<Box<Tree>> { app.panes.get_mut(&pane).and_then(|p| p.tree.take()) }

fn put(app: &mut App, pane: u64, t: Box<Tree>) { if let Some(p) = app.panes.get_mut(&pane) { p.tree = Some(t); p.dirty = true } }

/// window_pane_set_mode(window_tree_mode): [pane] into the tree (again, if it is in it: the
/// tree it has goes).
pub fn enter(app: &mut App, pane: u64, window: usize, a: &Start) {
    if let Some(old) = take(app, pane) { finish(app, *old) }
    // (Over the file manager: it ends.)
    crate::files::exit(app, pane);
    let (sx, sy) = crate::copy::screen_size(app, pane);
    let t = Tree::start(app, pane, window, a, sx, sy);
    let depth = app.panes.get(&pane).map(|p| p.modes.len()).unwrap_or(0);
    if let Some(p) = app.panes.get_mut(&pane) { p.tree = Some(Box::new(t)); p.tree_at = depth; p.dirty = true }
    app.sync_copy_modal();
}

/// window_pane_reset_mode for the tree (mode_tree_free): a window it zoomed is unzoomed.
fn finish(app: &mut App, t: Tree) {
    if t.zoomed == 0 {
        if let Some(w) = app.tabs.iter().position(|x| x.panes().contains(&t.pane)) { app.tabs[w].zoomed = false }
        app.fit_panes();
    }
}

/// The pane's tree ends.
pub fn exit(app: &mut App, pane: u64) {
    if let Some(t) = take(app, pane) { finish(app, *t) }
    if let Some(p) = app.panes.get_mut(&pane) { p.dirty = true }
    app.sync_copy_modal();
}

/// window_tree_update (server_client_check_modes): built again for what the windows are now,
/// at the pane's size.
pub fn update(app: &mut App, pane: u64) {
    let Some(mut t) = take(app, pane) else { return };
    let (sx, sy) = crate::copy::screen_size(app, pane);
    t.build(app, sx, sy);
    put(app, pane, t);
}

/// When tmux draws the status line again (a key with a binding, a prompt or what is typed in it,
/// a message coming or going, each status-interval): server_client_check_modes then builds a
/// pane's tree again (window_tree_update) — the current line found by its tag, the offset from it.
fn status_mark(app: &App) -> (u64, u64, String) {
    let interval: u64 = app.options.get("status-interval", "", None).and_then(|v| v.parse().ok()).unwrap_or(15);
    let ticks = if interval > 0 && app.status_lines() > 0 { app.started.elapsed().as_secs() / interval } else { 0 };
    let message = app.toast.as_ref().filter(|(_, _, at)| at.elapsed() < std::time::Duration::from_millis(app.toast_ms())).map(|(t, _, _)| t.as_str());
    let line = match &app.modal {
        Some(Modal::Prompt(p)) => format!("prompt {}\0{}\0{}", p.label, p.value, p.cursor),
        Some(Modal::Confirm { prompt, .. }) => format!("confirm {prompt}"),
        _ => message.map(|m| format!("message {m}")).unwrap_or_default(),
    };
    (app.status_redraws, ticks, line)
}

/// Draws [pane]'s tree into [area]: built again if the status line was (status_mark), else only
/// brought up to date, its lines where they were.
pub fn draw(app: &mut App, pane: u64, buf: &mut Buffer, area: Rect) {
    let Some(mut t) = take(app, pane) else { return };
    let (sx, sy) = (area.width as u32, area.height as u32);
    let mark = status_mark(app);
    if t.status_seen != mark { t.status_seen = mark; t.build(app, sx, sy) } else { t.refresh(app, sx, sy) }
    let plan = t.plan(app);
    t.draw(app, buf, area, &plan);
    put(app, pane, t);
}

// A key as hn spells it (Chord::normal: a letter lower-case with S-, a symbol without).
fn is_char(c: &Chord, ch: char) -> bool { *c == Chord::normal(KeyCode::Char(ch), KeyModifiers::NONE) }
fn is_ctrl(c: &Chord, ch: char) -> bool { *c == Chord::normal(KeyCode::Char(ch), KeyModifiers::CONTROL) }
fn is_meta(c: &Chord, ch: char) -> bool { *c == Chord::normal(KeyCode::Char(ch), KeyModifiers::ALT) }

/// window_tree_key (and mode_tree_key before it): a key, or a mouse event ([m], its key its
/// chord), for [pane]'s tree. [client]: the key came from the client (a key pressed, a mouse
/// event), as against send-keys — tmux's mouse event pointer is there for those, and t moves on
/// after tagging only then.
pub fn key(app: &mut App, pane: u64, chord: Chord, m: Option<&crate::mouse::Event>, client: bool) {
    let Some(mut t) = take(app, pane) else { return };
    let (sx, sy) = crate::copy::screen_size(app, pane);
    t.refresh(app, sx, sy);
    let mut item = (t.builds, t.current_item());
    let mut key = Some(chord);
    let mut x = 0u32;
    let finished = mode_key(app, &mut t, pane, &mut key, m, client, &mut x, sx, sy);
    loop {
        let new = (t.builds, t.current_item());
        if item != new { item = new; t.poffset = 0 }
        if let (Some(k), Some(_)) = (key, m) {
            if keys::is_mouse(&k.code) { key = window_mouse(app, &mut t, k, x, item.1, sx, sy); continue }
        }
        break;
    }
    let Some(k) = key else { return put(app, pane, t) };
    let item = t.current_item();
    if t.flavour == Flavour::Buffer { return buffer_key(app, t, pane, k, finished, sx, sy) }
    if is_char(&k, '<') { t.poffset -= 1 }
    else if is_char(&k, '>') { t.poffset += 1 }
    else if is_char(&k, 'H') {
        // To where the tree was opened: its session and window expanded, its pane (else window).
        let (fsid, ftab) = (t.fs.0, t.fs.1.clone());
        t.expand_tag(app, session_tag(fsid), sx, sy);
        let wid = session_tabs(app, fsid).and_then(|(tabs, _)| tabs.iter().find(|x| x.id == ftab).map(|x| x.wid()));
        if let Some(w) = wid { t.expand_tag(app, window_tag(fsid, w), sx, sy) }
        if !t.set_current(pane_tag(pane)) { if let Some(w) = wid { t.set_current(window_tag(fsid, w)); } }
    } else if is_char(&k, 'm') {
        if let Some(p) = item.and_then(|i| t.pulled(app, i, |_, p| p.pane)) { app.marked = Some(p) }
        t.build(app, sx, sy);
    } else if is_char(&k, 'M') {
        app.marked = None;
        t.build(app, sx, sy);
    } else if is_char(&k, 'x') {
        let prompt = item.and_then(|i| t.pulled(app, i, |app, pulled| Some(match &t.items[i].what {
            What::Session(_) => format!("Kill session {}? ", app.session_name()),
            What::Window(..) => format!("Kill window {}? ", app.win_num(pulled.window)),
            What::Pane(_, _, p) => {
                let w = pulled.window;
                let idx = app.tabs[w].panes().iter().position(|x| x == p)? + app.pane_base(w);
                format!("Kill pane {idx}? ")
            }
            What::Buffer(_) => return None,
        })));
        if let Some(prompt) = prompt { app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Tree { pane, ask: Ask::Kill }, &prompt, ""))) }
    } else if is_char(&k, 'X') {
        let n = t.count_tagged();
        if n != 0 { app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Tree { pane, ask: Ask::KillTagged }, &format!("Kill {n} tagged? "), ""))) }
    } else if is_char(&k, ':') {
        let n = t.count_tagged();
        let label = if n != 0 { format!("({n} tagged) ") } else { "(current) ".to_string() };
        app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Tree { pane, ask: Ask::Command }, &label, "")));
    } else if k.code == KeyCode::Enter || is_ctrl(&k, 'm') {
        let name = item.and_then(|i| t.target(app, i));
        let command = t.command.clone();
        finish(app, *t);
        if let Some(p) = app.panes.get_mut(&pane) { p.dirty = true }
        app.sync_copy_modal();
        if let Some(name) = name { run_command(app, None, &command, &name) }
        return;
    }
    if finished {
        finish(app, *t);
        if let Some(p) = app.panes.get_mut(&pane) { p.dirty = true }
        app.sync_copy_modal();
        return;
    }
    put(app, pane, t);
}

/// window_buffer_key, after mode_tree_key: p or Enter pastes the buffer (the template, `%%` its
/// name) and ends the mode, P each tagged one; d deletes it (the next one, else the one before,
/// current after), D each tagged one; the mode ends when there are no buffers.
fn buffer_key(app: &mut App, mut t: Box<Tree>, pane: u64, k: Chord, finished: bool, sx: u32, sy: u32) {
    let end = |app: &mut App, t: Tree| { finish(app, t); if let Some(p) = app.panes.get_mut(&pane) { p.dirty = true } app.sync_copy_modal() };
    let item = t.current_item();
    let name_of = |t: &Tree, i: usize| match &t.items[i].what { What::Buffer(n) => Some(n.clone()), _ => None };
    if is_char(&k, 'p') || k.code == KeyCode::Enter || is_ctrl(&k, 'm') {
        let name = item.and_then(|i| name_of(&t, i)).filter(|n| app.paste.get(n).is_some());
        let command = t.command.clone();
        end(app, *t);
        if let Some(name) = name { run_command(app, None, &command, &name) }
        return;
    }
    if is_char(&k, 'P') {
        let names: Vec<String> = t.each_tagged(false).into_iter().filter_map(|i| name_of(&t, i)).collect();
        let command = t.command.clone();
        end(app, *t);
        for name in names { if app.paste.get(&name).is_some() { run_command(app, None, &command, &name) } }
        return;
    }
    if is_char(&k, 'd') {
        if let Some(i) = item {
            if !t.down(false) { t.up(false); }
            if let Some(n) = name_of(&t, i) { app.paste.free(&n) }
            t.build(app, sx, sy);
        }
    } else if is_char(&k, 'D') {
        for i in t.each_tagged(false) {
            if Some(i) == t.current_item() && !t.down(false) { t.up(false); }
            if let Some(n) = name_of(&t, i) { app.paste.free(&n) }
        }
        t.build(app, sx, sy);
    }
    if finished || app.paste.walk().next().is_none() { return end(app, *t) }
    put(app, pane, t);
}

/// mode_tree_key: the list's own keys. True when the mode is done (q, Escape, C-g); [key]
/// becomes Enter for an item's key or a double click, None when used up.
#[allow(clippy::too_many_arguments)]
fn mode_key(app: &mut App, t: &mut Tree, pane: u64, key: &mut Option<Chord>, m: Option<&crate::mouse::Event>, client: bool, xp: &mut u32, sx: u32, sy: u32) -> bool {
    let Some(k) = *key else { return false };
    if keys::is_mouse(&k.code) {
        if let Some(m) = m {
            let Some((x, y)) = crate::mouse::mouse_at(app, pane, m, false) else { *key = None; return false };
            let (x, y) = (x as u32, y as u32);
            *xp = x;
            let name = keys::name(&k);
            let right = name == "MouseDown3Pane";
            if x > t.width || y > t.height {
                if right { display_menu(app, t, pane, x, y, true) }
                if !t.preview { *key = None }
                return false;
            }
            if t.offset + (y as usize) < t.lines.len() {
                if matches!(name.as_str(), "MouseDown1Pane" | "MouseDown3Pane" | "DoubleClick1Pane") { t.current = t.offset + y as usize }
                if name == "DoubleClick1Pane" { *key = Some(Chord::normal(KeyCode::Enter, KeyModifiers::NONE)) } else {
                    if right { display_menu(app, t, pane, x, y, false) }
                    *key = None;
                }
            } else {
                if right { display_menu(app, t, pane, x, y, false) }
                *key = None;
            }
            return false;
        }
    }
    // An item's key: that item, chosen.
    if let Some(i) = t.lines.iter().position(|l| t.items[l.item].key == Some(k)) {
        t.current = i;
        *key = Some(Chord::normal(KeyCode::Enter, KeyModifiers::NONE));
        return false;
    }
    let name = keys::name(&k);
    let cur = t.current_item();
    match () {
        _ if is_char(&k, 'q') || k.code == KeyCode::Esc || is_ctrl(&k, 'g') => return true,
        _ if k.code == KeyCode::Up || is_char(&k, 'k') || name == "WheelUpPane" || is_ctrl(&k, 'p') => t.up(true),
        _ if k.code == KeyCode::Down || is_char(&k, 'j') || name == "WheelDownPane" || is_ctrl(&k, 'n') => { t.down(true); }
        _ if k.code == KeyCode::PageUp || is_ctrl(&k, 'b') => { for _ in 0..t.height { if t.current == 0 { break } t.up(true) } }
        _ if k.code == KeyCode::PageDown || is_ctrl(&k, 'f') => { for _ in 0..t.height { if t.current + 1 >= t.lines.len() { break } t.down(true); } }
        _ if is_char(&k, 'g') || k.code == KeyCode::Home => { t.current = 0; t.offset = 0 }
        _ if is_char(&k, 'G') || k.code == KeyCode::End => {
            t.current = t.lines.len().saturating_sub(1);
            t.offset = if t.current > t.height as usize - 1 { t.current - t.height as usize + 1 } else { 0 };
        }
        _ if is_char(&k, 't') => {
            // No parent and child both tagged: its parents and children lose theirs.
            if let Some(c) = cur {
                if !t.items[c].tagged {
                    let mut up = t.items[c].parent;
                    while let Some(u) = up { t.items[u].tagged = false; up = t.items[u].parent }
                    clear_tagged(t, c);
                    t.items[c].tagged = true;
                } else { t.items[c].tagged = false }
                if client { t.down(false); }
            }
        }
        _ if is_char(&k, 'T') => { for l in t.lines.clone() { t.items[l.item].tagged = false } }
        _ if is_ctrl(&k, 't') => { for l in t.lines.clone() { let top = t.items[l.item].parent.is_none(); t.items[l.item].tagged = top } }
        _ if is_char(&k, 'O') => { t.sort = (t.sort + 1) % SORTS.len(); t.build(app, sx, sy) }
        _ if is_char(&k, 'r') => { t.reversed = !t.reversed; t.build(app, sx, sy) }
        _ if k.code == KeyCode::Left || is_char(&k, 'h') || is_char(&k, '-') => {
            let Some(line) = t.lines.get(t.current).copied() else { return false };
            let mut c = Some(line.item);
            if line.flat || !t.items[line.item].expanded { c = t.items[line.item].parent }
            match c {
                None => t.up(false),
                Some(c) => { t.items[c].expanded = false; t.current = t.items[c].line; t.build(app, sx, sy) }
            }
        }
        _ if k.code == KeyCode::Right || is_char(&k, 'l') || is_char(&k, '+') => {
            let Some(line) = t.lines.get(t.current).copied() else { return false };
            if line.flat || t.items[line.item].expanded { t.down(false); }
            else { t.items[line.item].expanded = true; t.build(app, sx, sy) }
        }
        _ if is_meta(&k, '-') => { for r in t.roots.clone() { t.items[r].expanded = false } t.build(app, sx, sy) }
        _ if is_meta(&k, '+') => { for r in t.roots.clone() { t.items[r].expanded = true } t.build(app, sx, sy) }
        _ if is_char(&k, '?') || is_char(&k, '/') || is_ctrl(&k, 's') => {
            app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Tree { pane, ask: Ask::Search }, "(search) ", "")));
        }
        _ if is_char(&k, 'n') => { t.search_back = false; t.search_set(app, sx, sy) }
        _ if is_char(&k, 'N') => { t.search_back = true; t.search_set(app, sx, sy) }
        _ if is_char(&k, 'f') => {
            let f = t.filter.clone().unwrap_or_default();
            app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Tree { pane, ask: Ask::Filter }, "(filter) ", &f)));
        }
        _ if is_char(&k, 'v') => {
            t.preview = !t.preview;
            t.build(app, sx, sy);
            if t.preview { t.check_selected() }
        }
        _ => {}
    }
    false
}

/// window_tree_menu_items and mode_tree_menu_items: each name and its key ('' a rule). Tag All's
/// is tmux's '\024', which it names [DC4] and which no key of the tree's is (C-t is another key).
const TREE_MENU: [(&str, &str); 12] = [
    ("Select", "Enter"), ("Expand", "Right"), ("Mark", "m"), ("", ""),
    ("Tag", "t"), ("Tag All", "[DC4]"), ("Tag None", "T"), ("", ""),
    ("Kill", "x"), ("Kill Tagged", "X"), ("", ""), ("Cancel", "q"),
];
const SCROLL_MENU: [(&str, &str); 4] = [("Scroll Left", "<"), ("Scroll Right", ">"), ("", ""), ("Cancel", "q")];
/// window_buffer_menu_items.
const BUFFER_MENU: [(&str, &str); 11] = [
    ("Paste", "p"), ("Paste Tagged", "P"), ("", ""),
    ("Tag", "t"), ("Tag All", "[DC4]"), ("Tag None", "T"), ("", ""),
    ("Delete", "d"), ("Delete Tagged", "D"), ("", ""), ("Cancel", "q"),
];

/// mode_tree_display_menu: a right click on a line (or below them) opens the tree's menu, titled
/// with that item's name (the current one's below the lines); in the preview, Scroll Left and
/// Right. Its corner is the mouse's place in the pane — as tmux gives it, the pane's own x and
/// y — less half the menu's width, kept on the screen (menu_prepare); nothing chosen until the
/// mouse moves.
fn display_menu(app: &mut App, t: &Tree, pane: u64, x: u32, y: u32, outside: bool) {
    let line = if t.offset + y as usize > t.lines.len().saturating_sub(1) { t.current } else { t.offset + y as usize };
    let Some(l) = t.lines.get(line) else { return };
    let own: &[(&str, &str)] = if t.flavour == Flavour::Buffer { &BUFFER_MENU } else { &TREE_MENU };
    let (title, list): (String, &[(&str, &str)]) = if !outside { (format!("#[align=centre]{}", t.items[l.item].name), own) } else { (String::new(), &SCROLL_MENU) };
    let items: Vec<crate::modal::MenuItem> = list.iter().map(|(label, key)| crate::modal::MenuItem {
        label: label.to_string(), key: key.to_string(), command: String::new(), disabled: label.is_empty(), separator: label.is_empty(),
    }).collect();
    let width = items.iter().filter(|it| !it.separator).map(|it| it.label.chars().count() + it.key.chars().count() + 3)
        .fold(crate::draw::format_width(&title), usize::max) as u16;
    let (sx, sy) = (app.size.0 as u32, app.size.1 as u32);
    let (w, h) = (width as u32 + 4, items.len() as u32 + 2);
    if sx < w || sy < h { return }
    let mut x = if x >= w / 2 { x - w / 2 } else { 0 };
    let mut y = y;
    if x + w > sx { x = sx - w }
    if y + h > sy { y = sy - h }
    app.modal = Some(Modal::Menu(crate::modal::Menu { title, items, choice: None, x: x as u16, y: y as u16, width, stay_open: false, no_mouse: false, mouse: None, tree: Some((pane, line)), complete: None }));
}

/// mode_tree_menu_callback and window_tree_menu: the menu's line made current, its item's key
/// the tree's (as from no client: `t` does not move down) — while the tree is the pane's mode.
pub fn menu_chosen(app: &mut App, pane: u64, line: usize, key_name: &str) {
    let Some(p) = app.panes.get_mut(&pane).filter(|p| p.tree_top()) else { return };
    let Some(t) = p.tree.as_mut() else { return };
    if line >= t.lines.len() { return }
    t.current = line;
    p.dirty = true;
    if let Ok(k) = keys::parse(key_name) { key(app, pane, k, None, false) }
}

fn clear_tagged(t: &mut Tree, id: usize) {
    for c in t.items[id].children.clone() { t.items[c].tagged = false; clear_tagged(t, c) }
}

/// window_tree_mouse: a click in the preview chooses the window (or pane) under it.
fn window_mouse(app: &mut App, t: &mut Tree, k: Chord, x: u32, item: Option<usize>, sx: u32, sy: u32) -> Option<Chord> {
    if keys::name(&k) != "MouseDown1Pane" { return None }
    let x = x as i64;
    if t.left != -1 && x <= t.left { return Some(Chord::normal(KeyCode::Char('<'), KeyModifiers::NONE)) }
    if t.right != -1 && x >= t.right { return Some(Chord::normal(KeyCode::Char('>'), KeyModifiers::NONE)) }
    let mut x = x;
    if t.left != -1 { x -= t.left } else if x != 0 { x -= 1 }
    let x = if x == 0 || t.end == 0 { 0 } else {
        let mut x = (x as u32) / t.each.max(1);
        if t.start + x >= t.end { x = t.end - 1 - t.start.min(t.end - 1) }
        x
    };
    let item = item?;
    let enter = Some(Chord::normal(KeyCode::Enter, KeyModifiers::NONE));
    match t.items[item].what.clone() {
        What::Buffer(_) => None,
        What::Session(sid) => {
            // mode_tree_expand_current, then the window at that place (the session's, by index).
            if !t.items[item].expanded { t.items[item].expanded = true; t.build(app, sx, sy) }
            let at = (t.start + x) as usize;
            let wid = in_session(app, sid, |app| {
                let mut order: Vec<usize> = (0..app.tabs.len()).collect();
                order.sort_by_key(|w| app.win_num(*w));
                order.get(at).map(|w| app.tabs[*w].wid())
            }).flatten();
            if let Some(wid) = wid { t.set_current(window_tag(sid, wid)); }
            enter
        }
        What::Window(sid, tab) => {
            if !t.items[item].expanded { t.items[item].expanded = true; t.build(app, sx, sy) }
            let panes = session_tabs(app, sid).and_then(|(tabs, _)| tabs.iter().find(|w| w.id == tab).map(|w| w.panes())).unwrap_or_default();
            if let Some(p) = panes.get((t.start + x) as usize) { t.set_current(pane_tag(*p)); }
            enter
        }
        What::Pane(..) => None,
    }
}

/// mode_tree_run_command: the template, `%%` the target, run with [target] (its session, window
/// and pane) as the current one. A command that names the item finds it itself (in whatever
/// session); one that does not runs where the item is, its session in front for it.
fn run_command(app: &mut App, target: Option<(u32, String, u64)>, template: &str, name: &str) {
    let command = crate::commands::template_replace(template, name, 1);
    if command.trim().is_empty() { return }
    let run = |app: &mut App, current: Option<(String, u64)>| {
        let saved = std::mem::replace(&mut app.hook_state, current.map(|t| std::sync::Arc::new(crate::commands::HookState { formats: Vec::new(), target: Some(t), session: None, made: false })));
        crate::commands::execute(app, &command);
        app.hook_state = saved;
    };
    match target {
        Some((sid, tab, pane)) if sid != app.session_id && command == template => {
            in_session(app, sid, |app| run(app, Some((tab, pane))));
            changed_elsewhere(app);
        }
        Some((sid, tab, pane)) => run(app, (sid == app.session_id).then_some((tab, pane))),
        None => run(app, None),
    }
}

/// What a tree's prompt was answered with (window_tree_*_callback, mode_tree_*_callback).
pub fn answer(app: &mut App, pane: u64, ask: Ask, value: Option<&str>) {
    let Some(mut t) = take(app, pane) else { return };
    let (sx, sy) = crate::copy::screen_size(app, pane);
    t.refresh(app, sx, sy);
    match ask {
        Ask::Search => {
            t.search = value.filter(|s| !s.is_empty()).map(str::to_string);
            if t.search.is_some() { t.search_set(app, sx, sy) }
        }
        Ask::Filter => {
            t.filter = value.filter(|s| !s.is_empty()).map(str::to_string);
            t.build(app, sx, sy);
        }
        Ask::Kill | Ask::KillTagged => {
            let yes = value.map(|s| { let mut c = s.chars(); matches!((c.next(), c.next()), (Some('y' | 'Y'), None)) }).unwrap_or(false);
            if yes {
                let items = if ask == Ask::Kill { t.current_item().into_iter().collect() } else { t.each_tagged(true) };
                let targets: Vec<What> = items.iter().map(|i| t.items[*i].what.clone()).collect();
                put(app, pane, t);
                for what in targets { kill(app, what) }
                if app.panes.get(&pane).map(|p| p.tree.is_some()).unwrap_or(false) { update(app, pane) }
                return;
            }
        }
        Ask::Command => {
            if let Some(v) = value.filter(|s| !s.is_empty()) {
                let items = t.each_tagged(true);
                let targets: Vec<(Option<String>, Option<(u32, String, u64)>)> = items.iter().map(|i| {
                    let sid = t.items[*i].what.session();
                    let current = t.pulled(app, *i, |app, p| Some((sid, app.tabs.get(p.window)?.id.clone(), p.pane?)));
                    (t.target(app, *i), current)
                }).collect();
                put(app, pane, t);
                for (name, target) in targets { if let Some(name) = name { run_command(app, target, v, &name) } }
                if app.panes.get(&pane).map(|p| p.tree.is_some()).unwrap_or(false) { update(app, pane) }
                return;
            }
        }
    }
    put(app, pane, t);
}

/// window_tree_kill_each, in the item's session: a session (its windows closed, the last taking
/// it), a window, a pane — then its windows renumbered (server_renumber_all).
fn kill(app: &mut App, what: What) {
    let sid = what.session();
    let other = sid != app.session_id;
    in_session(app, sid, |app| {
        match &what {
            What::Session(_) => crate::commands::execute(app, "kill-session"),
            What::Window(_, tab) => { if let Some(w) = app.tabs.iter().position(|t| &t.id == tab) { app.close_tab(w) } }
            What::Pane(_, tab, p) => { if app.tabs.iter().any(|t| &t.id == tab && t.panes().contains(p)) { app.close_pane(*p) } }
            What::Buffer(_) => {}
        }
        if app.session_id == sid { app.renumber() }
    });
    if other { changed_elsewhere(app) }
}

/// After another session changed with it in front: the one on screen laid out again, and the
/// sessions kept (as a command run in another session leaves them).
fn changed_elsewhere(app: &mut App) {
    app.fit_panes();
    app.save_sessions();
}

/// #{pane_mode} for a pane whose top mode is the tree.
pub const MODE_NAME: &str = "tree-mode";
