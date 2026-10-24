//! The status bar down a side (`@hn-status-bar left|right`, the Settings' **Status bar**): under
//! the current machine's name, the session's windows with their panes nested under each (a pane's
//! harness and the repo it works in); then the machines and each one's windows; then what the
//! status line's right side says (bar_more.rs). The bar has no focus of its own — it shows where
//! the real focus is, so tmux's keys (prefix n, p, 0-9, o, the arrows, w, s) move its highlight,
//! and a click on an entry runs the tmux command that key would. Its separator is a handle: drag
//! it to make the bar wider or narrower (`@hn-status-bar-width`), double-click it for the default.

use std::time::{Duration, Instant};

use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::{Block, Clear, Widget};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::App;
use crate::fleet::State as Harness;
use crate::theme;

/// The bar's width, its last column the separator; how narrow and wide it may be dragged.
pub const WIDTH: u16 = 26;
pub const MIN_WIDTH: u16 = 18;
pub const MAX_WIDTH: u16 = 36;
/// Folded to a rail: a number and a glyph for each entry, and the separator.
pub const RAIL: u16 = 4;
/// The window keeps at least this many columns beside the bar.
const ROOM: u16 = 20;
/// Two presses on the separator this close together are a double click.
const DOUBLE_CLICK: Duration = Duration::from_millis(400);
/// A section's header and the blank row after it.
const HEADER: u16 = 2;
/// The two lists keep at least this many rows between them; the footer has what is left.
const LISTS: u16 = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side { Left, Right }

/// What a place on the bar does when clicked, or the list the wheel scrolls there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hit {
    /// A pane (its window's index, and the pane): select that window, then the pane.
    Pane(usize, u64),
    /// A window (by index): select it — its heading, or an entry under a machine.
    Window(usize),
    /// A machine's heading (its id, and its first window, if it has one).
    Machine(String, Option<usize>),
    /// A harness on a machine (machine, agent) open in no window here: open it.
    Harness(String, String),
    /// `+ N more` under a machine: its harnesses, all of them.
    More(String),
    /// `«` folds the bar to a rail, `»` opens it again.
    Fold,
    Unfold,
    /// The separator: dragged, the bar's width follows; double-clicked, the default width again.
    Separator,
    /// The lists (for the wheel): the windows, the machines.
    Windows,
    Machines,
}

/// The bar's own state: nothing of it is a focus — only how it is shown.
#[derive(Clone, Debug, Default)]
pub struct State {
    pub folded: bool,
    /// The first entry shown in each list: the windows, the machines.
    pub scroll: [usize; 2],
    /// How far each list can scroll, as last drawn.
    pub max_scroll: [usize; 2],
    /// The entry each list showed first, as last drawn: rows coming or going above it (a roster
    /// arriving) leave it where it was.
    pub top: [Option<Hit>; 2],
    /// Where each place was drawn, for the mouse.
    pub hits: Vec<(Rect, Hit)>,
    /// The focus the lists last followed (the window's id and its pane): when it moves, its
    /// entries are scrolled into view.
    followed: Option<(String, Option<u64>)>,
    /// A drag begun on the separator is resizing the bar.
    pub resizing: bool,
    /// When the separator was last pressed (a second press soon after is a double click).
    pressed: Option<Instant>,
}

impl App {
    /// Where box panes' frames (and blurred surfaces) may go: the whole window. Only two panes side
    /// by side, or stacked, have a cell between them — tmux's divider — so a box meets the window's
    /// edges and the status line, and beside the bar its blank edge is the one cell.
    pub fn box_inner(&self, tab: &crate::app::Tab) -> Rect { self.window_area(tab) }

    /// The side the status bar is on — none when it is tmux's status line (bottom, top), when
    /// `status off` hides it, and when the terminal is too narrow for it and a window beside it.
    pub fn bar_side(&self) -> Option<Side> {
        if self.headless { return None }
        if crate::os_welcome::live(self) { return None }
        let side = match self.options.status_bar() { "left" => Side::Left, "right" => Side::Right, _ => return None };
        if self.options.get("status", "", None).as_deref() == Some("off") { return None }
        if self.size.0 < self.bar_width() + ROOM || self.size.1 < 4 { return None }
        Some(side)
    }

    /// The bar's columns: `@hn-status-bar-width` (18 to 36, 26 unless dragged; narrower when the
    /// terminal would leave the window too little), or the rail's when folded.
    pub fn bar_width(&self) -> u16 {
        if self.bar.folded { return RAIL }
        let want = self.options.get("@hn-status-bar-width", "", None).and_then(|v| v.trim().parse::<u16>().ok()).unwrap_or(WIDTH);
        want.clamp(MIN_WIDTH, MAX_WIDTH).min(self.size.0.saturating_sub(ROOM)).max(MIN_WIDTH)
    }

    /// The bar [width] columns wide — kept to 18..36 and the window's 20 columns beside it — and
    /// the panes fitted to what is left (the option set; tui.toml is written when a drag ends).
    pub fn set_bar_width(&mut self, width: u16) {
        let width = width.clamp(MIN_WIDTH, MAX_WIDTH.min(self.size.0.saturating_sub(ROOM)).max(MIN_WIDTH));
        if self.options.get("@hn-status-bar-width", "", None).and_then(|v| v.trim().parse::<u16>().ok()) == Some(width) { return }
        let global = crate::options::SetFlags { global: true, ..Default::default() };
        let _ = self.options.set("@hn-status-bar-width", Some(&width.to_string()), &global, "", 0);
        self.redraw_all = true;
        self.fit_panes();
    }

    /// The bar: the terminal's full height down its side.
    pub fn bar_rect(&self) -> Option<Rect> {
        let side = self.bar_side()?;
        let w = self.bar_width();
        Some(Rect::new(if side == Side::Left { 0 } else { self.size.0 - w }, 0, w, self.size.1))
    }

    /// Where the window starts past the bar: what the mouse takes off its column (and row) for
    /// the window's cells.
    pub fn bar_offset(&self) -> (u16, u16) {
        match self.bar_rect() { Some(bar) => (if bar.x == 0 { bar.width } else { 0 }, 0), None => (0, 0) }
    }
}

// ── colours ──────────────────────────────────────────────────────────────────

/// The bar's colours, from the theme in use (the terminal's own when none is chosen): its surface,
/// the current entry's row, the separator, the text in three strengths, the accent, and the states
/// in the terminal's own ANSI colours.
struct Colours { bg: Color, row: Color, rule: Color, text: Color, soft: Color, muted: Color, accent: Color, green: Color }

fn colours() -> Colours {
    let pal = theme::pane_palette();
    if theme::no_color() {
        let r = Color::Reset;
        return Colours { bg: r, row: r, rule: r, text: r, soft: r, muted: r, accent: r, green: r };
    }
    let fit = theme::depth_fit;
    // The current row lifted off the background — further where the terminal has 256 colours and
    // a small lift lands on the background's own colour, so the current row still shows.
    let bg = fit(pal.background);
    let row = [12, 20, 30, 40].iter().map(|a| fit(mix(pal.background, pal.foreground, *a))).find(|r| *r != bg).unwrap_or(bg);
    Colours {
        bg, row, rule: fit(pal.border),
        text: fit(pal.foreground), soft: fit(pal.inactive_foreground), muted: fit(pal.muted), accent: theme::paint(theme::accent()),
        green: theme::paint(theme::ONLINE),
    }
}

/// [a] moved [amount] % toward [b] (RGB; any other colour stays as it is).
fn mix(a: Color, b: Color, amount: u16) -> Color {
    let (Color::Rgb(ar, ag, ab), Color::Rgb(br, bg, bb)) = (a, b) else { return a };
    let c = |a: u8, b: u8| ((a as u16 * (100 - amount) + b as u16 * amount) / 100) as u8;
    Color::Rgb(c(ar, br), c(ag, bg), c(ab, bb))
}

/// A harness's state as the bar marks it: the marks hn gives harnesses everywhere else (the
/// launcher, the home screen, the panes' titles) — its spinner working, `?` waiting on you, `✓`
/// done, `✗` failed, `·` idle — in their colours; nothing known (a shell), a quiet `·`.
fn mark(state: Option<Harness>, c: &Colours, tick: u64) -> (&'static str, Color) {
    match state {
        // (Nothing to say — idle, paused, offline, a shell: a blank, not a dot that means nothing.)
        None | Some(Harness::Ready | Harness::Paused | Harness::Offline) => (" ", c.muted),
        Some(s) => { let (dot, _, colour) = theme::state_mark(s, tick); (dot, if colour == theme::MUTED { c.muted } else { colour }) }
    }
}

// ── text ─────────────────────────────────────────────────────────────────────

/// [text] in at most [cols] display columns, `…` where it was cut.
fn cut(text: &str, cols: usize) -> String {
    if text.width() <= cols { return text.to_string() }
    if cols == 0 { return String::new() }
    let (mut out, mut used) = (String::new(), 0);
    for ch in text.chars() {
        let w = ch.width().unwrap_or(0);
        if used + w + 1 > cols { break }
        out.push(ch);
        used += w;
    }
    out.push('…');
    out
}

/// A repo in [width] columns: `project · branch`, the project whole while the branch keeps a few
/// columns, the branch cut with `…`; too narrow for both, the branch alone (the leftmost goes first).
fn repo(project: &str, branch: &str, width: usize) -> Vec<String> {
    match (project.is_empty(), branch.is_empty()) {
        (_, true) => vec![cut(project, width)],
        (true, false) => vec![cut(branch, width)],
        _ if width < 12 => vec![cut(branch, width)],
        _ => {
            let pw = project.width().min(width - 3 - branch.width().min(8));
            vec![cut(project, pw), cut(branch, width - 3 - cut(project, pw).width())]
        }
    }
}

/// [spans] from column [x] of row [y], no further than [right], each a `Span` cut with `…` to the
/// room left. Returns the column after them.
fn put(buf: &mut Buffer, mut x: u16, y: u16, right: u16, spans: &[(String, Style)]) -> u16 {
    for (text, style) in spans {
        if x >= right { break }
        let shown = cut(text, (right - x) as usize);
        let width = shown.width() as u16;
        Span::styled(shown, *style).render(Rect::new(x, y, right - x, 1), buf);
        x += width;
    }
    x
}

// ── the entries ──────────────────────────────────────────────────────────────

/// One entry of a list: its rows (each indented from the list's left edge, as spans), what a
/// click on it does, and whether it is where the focus is (filled with the current row's colour).
struct Entry { rows: Vec<(u16, Vec<(String, Style)>)>, right: Option<(String, Style)>, hit: Hit, current: bool }

impl Entry { fn height(&self) -> u16 { self.rows.len() as u16 } }

/// A machine as a heading: its mark as the lists give it (`✓` connected, `·` away…), then its
/// name, bold, in [width] columns.
fn machine_spans(app: &App, c: &Colours, id: &str, width: u16) -> Vec<(String, Style)> {
    let machine = app.fleet.machine(id);
    let name = machine.map(|m| m.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| if id == app.fleet.local_id || id.is_empty() { crate::app::hostname() } else { id.to_string() });
    let here = id == app.fleet.local_id && !app.daemon_down;
    let (dot, colour) = match machine {
        _ if here => ("✓", c.green),
        Some(m) => theme::machine_mark(&m.reach, m.online(), app.tick),
        None => ("·", c.muted),
    };
    let colour = if colour == theme::MUTED { c.muted } else { colour };
    vec![(dot.to_string(), Style::default().fg(colour).add_modifier(Modifier::BOLD)), (" ".into(), Style::default()), (cut(&name, width.saturating_sub(1 + 2 + 2) as usize), Style::default().fg(c.text).add_modifier(Modifier::BOLD))]
}

/// A window's row: ` ✓ N:name` (the mark of the most urgent of its harnesses), after [prefix] when it sits
/// under a machine, its pane count dim on the right when it has several; the current window's on
/// the current row's colour.
fn window_entry(app: &App, c: &Colours, width: u16, i: usize, prefix: Option<&str>) -> Entry {
    let tab = &app.tabs[i];
    let here = i == app.active;
    let bg = |s: Style| if here { s.bg(c.row) } else { s };
    let (glyph, colour) = mark(app.window_state(i), c, app.tick);
    let count = tab.panes().len();
    let right = (count > 1).then(|| (count.to_string(), bg(Style::default().fg(c.muted))));
    let label = format!("{}:{}", app.win_num(i), tab.name);
    let mut spans = Vec::new();
    let mut used = 1 + 2 + right.as_ref().map(|(t, _)| t.width() + 1).unwrap_or(0);
    if let Some(p) = prefix { spans.push((p.to_string(), bg(Style::default().fg(c.muted)))); used += p.width() }
    // (No mark, no room kept for one: the name moves up to where it would be.)
    if glyph != " " { spans.push((format!("{glyph} "), bg(Style::default().fg(colour)))); used += 2 }
    let name = if here { Style::default().fg(c.text).add_modifier(Modifier::BOLD) } else { Style::default().fg(c.soft) };
    spans.push((cut(&label, (width as usize).saturating_sub(used)), bg(name)));
    Entry { rows: vec![(1, spans)], right, hit: Hit::Window(i), current: here }
}

/// A pane under its window's heading: `├─ ⠹ name` (its harness's mark and name, else the pane's title), and
/// under it the repo it works in — project · branch — or a shell's folder, dim; the focused pane
/// bold on the current row's colour.
fn pane_entry(app: &App, c: &Colours, width: u16, window: usize, id: u64, last: bool, here: bool) -> Entry {
    let (glyph, colour) = mark(app.pane_state(id), c, app.tick);
    let pane = app.panes.get(&id);
    let agent = pane.and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id));
    let harness = agent.filter(|a| a.engine != "terminal");
    let folder = |path: &str| path.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
    let name = match harness { Some(a) if !a.name.is_empty() => a.name.clone(), _ => crate::format::pane_title(app, window, id) };
    let room = width.saturating_sub(1 + 5 + 2) as usize;
    let where_ = match harness {
        Some(a) if !a.project.is_empty() || !a.branch.is_empty() => repo(&a.project, &a.branch, room),
        _ => vec![cut(&pane.and_then(|p| p.cwd.as_deref()).map(folder).filter(|f| !f.is_empty()).or_else(|| agent.map(|a| folder(&a.cwd))).unwrap_or_default(), room)],
    };
    let bg = |s: Style| if here { s.bg(c.row) } else { s };
    let dim = bg(Style::default().fg(c.muted));
    let name_style = bg(if here { Style::default().fg(c.text).add_modifier(Modifier::BOLD) } else { Style::default().fg(c.soft) });
    let second = bg(Style::default().fg(if here { c.accent } else { c.muted }));
    // (No mark, no room kept for one: the name sits by the branch, its repo under it.)
    let marked = glyph != " ";
    let mut line1 = vec![(if last { "└─ " } else { "├─ " }.to_string(), dim)];
    if marked { line1.push((format!("{glyph} "), bg(Style::default().fg(colour)))) }
    line1.push((cut(&name, width.saturating_sub(1 + 3 + 2 + if marked { 2 } else { 0 }) as usize), name_style));
    let mut line2 = vec![(match (last, marked) { (true, true) => "     ", (true, false) => "   ", (false, true) => "│    ", (false, false) => "│  " }.to_string(), dim)];
    for (k, part) in where_.into_iter().enumerate() {
        if k > 0 { line2.push((" · ".into(), dim)) }
        line2.push((part, second));
    }
    Entry { rows: vec![(1, line1), (1, line2)], right: None, hit: Hit::Pane(window, id), current: here }
}

/// The session's windows, each its heading with its panes nested under it — a window of one
/// pane just its heading.
fn window_entries(app: &App, c: &Colours, width: u16) -> Vec<Entry> {
    let mut out = Vec::new();
    for (i, tab) in app.tabs.iter().enumerate() {
        out.push(window_entry(app, c, width, i, None));
        let panes = if tab.home || tab.root.is_none() { Vec::new() } else { tab.panes() };
        if panes.len() < 2 { continue }
        let n = panes.len();
        for (k, id) in panes.into_iter().enumerate() { out.push(pane_entry(app, c, width, i, id, k + 1 == n, i == app.active && tab.focus == Some(id))) }
    }
    out
}

/// The harness rows under a machine, at most this many, then `+ N more`.
const HARNESS_ROWS: usize = 3;

/// A harness on a machine that no window here shows: `├─ ? name` (its mark, when it has one, as a
/// window row's), after [prefix].
fn harness_entry(app: &App, c: &Colours, width: u16, a: &crate::fleet::Agent, prefix: &str) -> Entry {
    let (glyph, colour) = mark(Some(app.fleet.state_of(a)), c, app.tick);
    let mut spans = vec![(prefix.to_string(), Style::default().fg(c.muted))];
    let mut used = 1 + 2 + prefix.width();
    if glyph != " " { spans.push((format!("{glyph} "), Style::default().fg(colour))); used += 2 }
    spans.push((cut(&a.name, (width as usize).saturating_sub(used)), Style::default().fg(c.soft)));
    Entry { rows: vec![(1, spans)], right: None, hit: Hit::Harness(a.machine_id.clone(), a.id.clone()), current: false }
}

/// The machines, each with the windows that have a pane on it (a window on several machines
/// under each; one with no pane yet, this computer's), then — on a machine that is ready — its
/// harnesses no window here shows, the latest first, three of them and `+ N more`.
fn machine_entries(app: &App, c: &Colours, width: u16) -> Vec<Entry> {
    let windows: Vec<usize> = (0..app.tabs.len()).collect();
    // Each window's machines: its panes', in order (none yet: this computer's).
    let on: Vec<Vec<String>> = app.tabs.iter().map(|t| {
        let mut ms: Vec<String> = Vec::new();
        for p in t.panes() { if let Some(m) = app.panes.get(&p).map(|p| p.machine_id.clone()) { if !ms.contains(&m) { ms.push(m) } } }
        if ms.is_empty() { ms.push(app.fleet.local_id.clone()) }
        ms
    }).collect();
    // The machines: this computer first, then the account's, then any a window names that the
    // account's list does not have (yet).
    let mut machines: Vec<String> = Vec::new();
    if !app.fleet.local_id.is_empty() { machines.push(app.fleet.local_id.clone()) }
    for m in &app.fleet.machines { if !machines.contains(&m.id) { machines.push(m.id.clone()) } }
    for ms in &on { for m in ms { if !machines.contains(m) { machines.push(m.clone()) } } }
    let mut out = Vec::new();
    for id in machines {
        let mine: Vec<usize> = windows.iter().copied().filter(|i| on[*i].contains(&id)).collect();
        let machine = app.fleet.machine(&id);
        let mut harnesses: Vec<&crate::fleet::Agent> = if machine.is_some_and(|m| m.usable()) {
            app.fleet.agents.values().filter(|a| a.machine_id == id && a.status != "stopped" && a.engine != "terminal" && app.find_pane(&id, &a.id).is_none()).collect()
        } else { Vec::new() };
        harnesses.sort_by(|a, b| b.recency().cmp(&a.recency()).then_with(|| a.name.cmp(&b.name)));
        let more = harnesses.len().saturating_sub(HARNESS_ROWS);
        harnesses.truncate(HARNESS_ROWS);
        // (Away: said at the right, the name cut before it.)
        let offline = machine.is_some_and(|m| !m.online()) && id != app.fleet.local_id;
        let right = offline.then(|| ("offline".to_string(), Style::default().fg(c.muted)));
        let heading = machine_spans(app, c, &id, if offline { width.saturating_sub(8) } else { width });
        out.push(Entry { rows: vec![(1, heading)], right, hit: Hit::Machine(id.clone(), mine.first().copied()), current: false });
        // Its windows, its harnesses, `+ N more`: one tree, the last of them `└─`.
        let n = mine.len() + harnesses.len() + usize::from(more > 0);
        let prefix = |k: usize| if k + 1 == n { "└─ " } else { "├─ " };
        let windows = mine.len();
        for (k, i) in mine.into_iter().enumerate() { out.push(window_entry(app, c, width, i, Some(prefix(k)))) }
        for (k, a) in harnesses.into_iter().enumerate() { out.push(harness_entry(app, c, width, a, prefix(windows + k))) }
        if more > 0 {
            let spans = vec![(prefix(n - 1).to_string(), Style::default().fg(c.muted)), (format!("+ {more} more"), Style::default().fg(c.muted))];
            out.push(Entry { rows: vec![(1, spans)], right: None, hit: Hit::More(id.clone()), current: false });
        }
    }
    out
}

// ── drawing ──────────────────────────────────────────────────────────────────

/// The first entry to show so that entry [target] is in view, from [scroll], in [rows] rows.
fn reveal(entries: &[Entry], rows: u16, scroll: usize, target: usize) -> usize {
    if target < scroll { return target }
    let mut first = scroll;
    while first < target && entries[first..=target].iter().map(Entry::height).sum::<u16>() > rows { first += 1 }
    first
}

/// The furthest a list can scroll: the first entry from which the rest all fit.
fn max_scroll(entries: &[Entry], rows: u16) -> usize {
    let mut used = 0;
    for (i, e) in entries.iter().enumerate().rev() {
        used += e.height();
        if used > rows { return i + 1 }
    }
    0
}

/// [entries] from [scroll] into [area], each filled with the current row's colour when it is
/// the current one; where each went is kept for the mouse.
fn list(buf: &mut Buffer, area: Rect, entries: &[Entry], scroll: usize, c: &Colours, hits: &mut Vec<(Rect, Hit)>) {
    let mut y = area.y;
    for e in entries.iter().skip(scroll) {
        if y + e.height() > area.bottom() { break }
        let rect = Rect::new(area.x, y, area.width, e.height());
        if e.current { buf.set_style(rect, Style::default().bg(c.row)) }
        for (k, (indent, spans)) in e.rows.iter().enumerate() {
            let right = area.right().saturating_sub(2);
            let right = if k == 0 { e.right.as_ref().map(|(t, _)| right.saturating_sub(t.width() as u16 + 1)).unwrap_or(right) } else { right };
            put(buf, area.x + indent, y + k as u16, right, spans);
        }
        if let Some((t, s)) = &e.right { let w = t.width() as u16; put(buf, area.right().saturating_sub(w + 2), y, area.right(), &[(t.clone(), *s)]); }
        hits.push((rect, e.hit.clone()));
        y += e.height();
    }
}

/// The bar, as the window is now.
pub fn draw(buf: &mut Buffer, app: &mut App) {
    let Some(bar) = app.bar_rect() else { app.bar.hits.clear(); return };
    let c = colours();
    let mut hits = Vec::new();
    crate::term_out::clear_extras(bar);
    Clear.render(bar, buf);
    Block::new().style(Style::default().bg(c.bg)).render(bar, buf);
    // The separator: the bar's last column facing the panes (its first, on the right) — the
    // handle that resizes it, in the accent while it does.
    let sx = if bar.x == 0 { bar.right() - 1 } else { bar.x };
    // (Beside box panes or blurred surfaces the pane's own edge is the line: the handle is a blank
    // column, which still takes the drag — `││` would be two lines where one is meant, and the
    // blank column is the one cell of space every pane has.)
    let quiet = (app.options.box_panes() || app.options.pane_look()) && !app.bar.resizing;
    for y in bar.y..bar.bottom() { if let Some(cell) = buf.cell_mut((sx, y)) { cell.set_symbol(if quiet { " " } else { "│" }).set_style(Style::default().fg(if app.bar.resizing { c.accent } else { c.rule }).bg(c.bg)); } }
    hits.push((Rect::new(sx, bar.y, 1, bar.height), Hit::Separator));
    let content = Rect::new(if bar.x == 0 { bar.x } else { bar.x + 1 }, bar.y, bar.width - 1, bar.height);
    let width = content.width;
    let windows = window_entries(app, &c, width);
    let machines = machine_entries(app, &c, width);
    // The focus moved (a key, a click, another client): its entries come into view.
    let now = Some((app.tab().id.clone(), app.focused()));
    let follow = app.bar.followed != now;
    app.bar.followed = now;
    if app.bar.folded { rail(buf, content, app, &c, &mut hits) }
    else {
        // Over the `«` row, what the status line's right side says, as far as the lists leave room.
        let footer_h = crate::bar_more::footer_height(app, width).min(content.height.saturating_sub(LISTS + 1));
        let footer_h = if footer_h >= 2 { footer_h } else { 0 };
        let lists = Rect::new(content.x, content.y, width, content.height - footer_h - 1);
        // The windows over the machines, half each, a rule between; a short terminal has the windows.
        let both = lists.height >= LISTS;
        let top_h = if both { (lists.height / 2).clamp(HEADER + 2, lists.height - HEADER - 2) } else { lists.height };
        let top = Rect::new(content.x, content.y, width, top_h);
        let header = |buf: &mut Buffer, y: u16, title: &str| { put(buf, content.x, y, content.right(), &[(title.to_string(), Style::default().fg(c.muted).add_modifier(Modifier::BOLD))]); };
        // The top's header: the machine you are on — the focused pane's, else this computer.
        let here = app.focused().and_then(|f| app.panes.get(&f)).map(|p| p.machine_id.clone()).unwrap_or_else(|| app.fleet.local_id.clone());
        put(buf, content.x + 1, top.y, content.right().saturating_sub(6), &machine_spans(app, &c, &here, width.saturating_sub(6)));
        crate::workspace_controls::side_actions(buf, app, Rect::new(content.right().saturating_sub(5), top.y, 4, 1), Style::default().fg(c.muted), false);
        let area = Rect::new(top.x, top.y + HEADER, width, top_h.saturating_sub(HEADER));
        scroll_list(app, 0, &windows, area, follow);
        list(buf, area, &windows, app.bar.scroll[0], &c, &mut hits);
        hits.push((area, Hit::Windows));
        if both {
            let ry = top.bottom();
            put(buf, content.x, ry, content.right(), &[("─".repeat(width as usize), Style::default().fg(c.rule))]);
            let bottom = Rect::new(content.x, ry + 1, width, lists.bottom() - ry - 1);
            // (Always each machine with its windows under it: no flat list to switch to.)
            header(buf, bottom.y, " machines");
            let area = Rect::new(bottom.x, bottom.y + HEADER, width, bottom.height.saturating_sub(HEADER));
            scroll_list(app, 1, &machines, area, follow);
            list(buf, area, &machines, app.bar.scroll[1], &c, &mut hits);
            hits.push((area, Hit::Machines));
        }
        if footer_h > 0 { crate::bar_more::footer(buf, app, Rect::new(content.x, lists.bottom(), width, footer_h)) }
        // `«` folds the bar, bottom right.
        let fx = content.right().saturating_sub(1);
        put(buf, fx, content.bottom() - 1, content.right(), &[("«".into(), Style::default().fg(c.muted))]);
        hits.push((Rect::new(fx, content.bottom() - 1, 1, 1), Hit::Fold));
        crate::workspace_controls::side_actions(buf, app, Rect::new(content.x + 1, content.bottom() - 1, width.saturating_sub(4), 1), Style::default().fg(c.muted), true);
    }
    app.bar.hits = hits;
}

/// Keep list [which]'s scroll where it can be, the focused row brought into view when the focus
/// has just moved.
fn scroll_list(app: &mut App, which: usize, entries: &[Entry], area: Rect, follow: bool) {
    let max = max_scroll(entries, area.height);
    app.bar.max_scroll[which] = max;
    let mut s = app.bar.scroll[which];
    // Rows that came or went above the first one shown (a roster arriving) do not move the list:
    // that entry stays first — the nearest of its kind, as a window is under several machines.
    if let Some(top) = app.bar.top[which].as_ref().filter(|h| !follow && entries.get(s).is_none_or(|e| e.hit != **h)) {
        if let Some(i) = entries.iter().enumerate().filter(|(_, e)| e.hit == *top).map(|(i, _)| i).min_by_key(|i| i.abs_diff(s)) { s = i }
    }
    s = s.min(max);
    if follow { if let Some(t) = entries.iter().rposition(|e| e.current) { s = reveal(entries, area.height, s, t) } }
    app.bar.scroll[which] = s;
    app.bar.top[which] = entries.get(s).map(|e| e.hit.clone());
}

/// The bar folded to a rail: a number and a glyph for each pane of the current window, a rule,
/// the same for each window, and `»` to open it again.
fn rail(buf: &mut Buffer, content: Rect, app: &App, c: &Colours, hits: &mut Vec<(Rect, Hit)>) {
    let half = content.height.div_ceil(2);
    let mut row = |buf: &mut Buffer, y: u16, n: usize, glyph: (&str, Color), current: bool, hit: Hit| {
        let rect = Rect::new(content.x, y, content.width, 1);
        if current { buf.set_style(rect, Style::default().bg(c.row)) }
        let number = Style::default().fg(if current { c.text } else { c.muted });
        put(buf, content.x, y, content.right(), &[(format!("{:<2}", n), number), (glyph.0.to_string(), Style::default().fg(glyph.1))]);
        hits.push((rect, hit));
    };
    let tab = app.tab();
    let panes = if tab.home || tab.root.is_none() { Vec::new() } else { tab.panes() };
    for (k, id) in panes.into_iter().enumerate().take(half.saturating_sub(1) as usize) {
        row(buf, content.y + k as u16, k + 1, mark(app.pane_state(id), c, app.tick), tab.focus == Some(id), Hit::Pane(app.active, id));
    }
    let ry = content.y + half.saturating_sub(1);
    put(buf, content.x, ry, content.right(), &[("─".repeat(content.width as usize), Style::default().fg(c.rule))]);
    for i in (0..app.tabs.len()).take(content.bottom().saturating_sub(ry + 2) as usize) {
        row(buf, ry + 1 + i as u16, app.win_num(i), mark(app.window_state(i), c, app.tick), i == app.active, Hit::Window(i));
    }
    let fy = content.bottom() - 1;
    let fx = content.x + content.width / 2;
    put(buf, fx, fy, content.right(), &[("»".into(), Style::default().fg(c.muted))]);
    hits.push((Rect::new(fx, fy, 1, 1), Hit::Unfold));
}

// ── the mouse ────────────────────────────────────────────────────────────────

/// The place under (x, y): the entry or button there, else the list.
pub fn hit_at(app: &App, x: u16, y: u16) -> Option<Hit> {
    let inside = |r: &Rect| x >= r.x && x < r.right() && y >= r.y && y < r.bottom();
    let list = |h: &Hit| matches!(h, Hit::Windows | Hit::Machines);
    app.bar.hits.iter().rev().find(|(r, h)| inside(r) && !list(h)).or_else(|| app.bar.hits.iter().find(|(r, _)| inside(r))).map(|(_, h)| h.clone())
}

/// What a click on [hit], pressed at [at] (where a machine's menu opens), does: the tmux command
/// its key would run, or the bar's own change. A machine with no window here: its menu,
/// Connect…, or what is wrong with it — not for a read-only client or tmux's look.
pub fn click(app: &mut App, hit: Hit, at: Option<(u16, u16)>) {
    let select = |app: &mut App, i: usize| { let n = app.win_num(i); crate::commands::execute(app, &format!("select-window -t :{n}")) };
    match hit {
        Hit::Pane(i, id) => {
            if i >= app.tabs.len() || !app.panes.contains_key(&id) { return }
            if i != app.active { select(app, i) }
            crate::commands::execute(app, &format!("select-pane -t {}", crate::pane::tag(id)))
        }
        Hit::Window(i) | Hit::Machine(_, Some(i)) => { if i < app.tabs.len() { select(app, i) } }
        Hit::Fold | Hit::Unfold => { app.bar.folded = hit == Hit::Fold; app.redraw_all = true; app.fit_panes() }
        // (Open here already — a slow attach clicked twice: open-harness goes to its window.)
        Hit::Harness(m, a) => crate::commands::execute(app, &format!("open-harness -s {}", crate::tmuxconf::quote_word(&format!("{m}:{a}")))),
        Hit::More(m) => crate::devices::open_machine_list(app, &m),
        Hit::Machine(m, None) if crate::workspace_controls::enabled(app) => crate::machine_menu::click(app, &m, at),
        Hit::Machine(_, None) | Hit::Separator | Hit::Windows | Hit::Machines => {}
    }
}

/// The wheel over the bar: its list moves by one entry.
pub fn wheel(app: &mut App, hit: Hit, up: bool) {
    let step = |s: usize, max: usize| if up { s.saturating_sub(1) } else { (s + 1).min(max) };
    // (A window's or a pane's entry: the list it is in — the machines' when it is drawn there.)
    let rect = app.bar.hits.iter().find(|(_, h)| *h == hit).map(|(r, _)| *r).unwrap_or_default();
    let in_machines = app.bar.hits.iter().any(|(r, h)| *h == Hit::Machines && r.intersection(rect) == rect && rect.area() > 0);
    let k = match hit {
        Hit::Windows => 0,
        Hit::Machines | Hit::Machine(..) | Hit::Harness(..) | Hit::More(_) | Hit::Fold => 1,
        Hit::Window(_) | Hit::Pane(..) => usize::from(in_machines),
        Hit::Separator | Hit::Unfold => return,
    };
    app.bar.scroll[k] = step(app.bar.scroll[k], app.bar.max_scroll[k]);
    // (Moved on purpose: the next draw keeps the entry it now starts at.)
    app.bar.top[k] = None;
}

/// The separator dragged to column [x]: the bar's width follows it.
fn resize_to(app: &mut App, x: u16) {
    let Some(bar) = app.bar_rect() else { return };
    let width = if bar.x == 0 { x.saturating_add(1) } else { app.size.0.saturating_sub(x) };
    app.set_bar_width(width);
}

/// A mouse event from the terminal: the bar's when it is over it (or it is resizing the bar) —
/// true then. A drag begun in a pane (a selection, a border) is the pane's wherever it goes.
pub fn mouse(app: &mut App, ev: &MouseEvent) -> bool {
    // A drag on the separator: the width follows the mouse wherever it goes, until let go (the
    // width then written to tui.toml).
    if app.bar.resizing {
        match ev.kind {
            MouseEventKind::Drag(MouseButton::Left) => { resize_to(app, ev.column); return true }
            MouseEventKind::Up(_) => { app.bar.resizing = false; app.redraw_all = true; app.persist_look(); return true }
            _ => app.bar.resizing = false,
        }
    }
    let Some(bar) = app.bar_rect() else { return false };
    let inside = ev.column >= bar.x && ev.column < bar.right() && ev.row >= bar.y && ev.row < bar.bottom();
    if !inside { return false }
    if app.mouse_state.drag.is_some() && matches!(ev.kind, MouseEventKind::Drag(_) | MouseEventKind::Up(_)) { return false }
    if matches!(ev.kind, MouseEventKind::Down(_)) { crate::mouse::cancel_clicks(app); }
    let hit = hit_at(app, ev.column, ev.row);
    match ev.kind {
        MouseEventKind::Down(MouseButton::Left) => match hit {
            // (The rail is opened with `»`, not dragged.)
            Some(Hit::Separator) if !app.bar.folded => {
                if app.bar.pressed.take().is_some_and(|t| t.elapsed() < DOUBLE_CLICK) { app.set_bar_width(WIDTH); app.persist_look() }
                else { app.bar.pressed = Some(Instant::now()); app.bar.resizing = true; app.redraw_all = true }
            }
            Some(h) => click(app, h, Some((ev.column, ev.row.saturating_add(1)))),
            None => {}
        },
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => { if let Some(h) = hit { wheel(app, h, matches!(ev.kind, MouseEventKind::ScrollUp)) } }
        _ => {}
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Tab;
    use crate::layout::{Dir, Node};
    use crate::pane::{Pane, Phase};
    use serde_json::json;

    /// A window of three (claude and codex on this computer, in the harness repo; a shell on
    /// `lab`), a second window of one on `lab`, the bar on [side].
    fn app(size: (u16, u16), side: &str) -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19791, sink, size);
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "local".into(), name: "studio".into(), local: true, status: "online".into(), reach: crate::fleet::Reach::Ready });
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "lab".into(), name: "lab".into(), local: false, status: "offline".into(), reach: crate::fleet::Reach::Offline });
        let repo = json!({"name": "autonomous-harness", "branch": "feat/grid-harness-codex", "cwd": "/src/autonomous-harness"});
        app.fleet.merge_roster("local", &[json!({"id": "a1", "name": "fix login", "engine": "claude", "project": repo}), json!({"id": "a2", "name": "tests", "engine": "codex", "project": repo})]);
        app.fleet.merge_roster("lab", &[json!({"id": "a3", "name": "deploy", "engine": "claude"}), json!({"id": "a4", "name": "", "engine": "terminal", "project": {"cwd": "/home/me/ops"}})]);
        let global = crate::options::SetFlags { global: true, ..Default::default() };
        let _ = app.options.set("@hn-status-bar", Some(side), &global, "", 0);
        let mut one = Tab::new("work");
        let mut root = Node::new(1, 100, 30);
        root.split(1, 2, Dir::Horizontal);
        root.split(2, 3, Dir::Vertical);
        one.root = Some(root);
        one.focus = Some(1);
        let mut two = Tab::new("ops");
        two.root = Some(Node::new(4, 100, 30));
        two.focus = Some(4);
        for (id, m, a) in [(1, "local", "a1"), (2, "local", "a2"), (3, "lab", "a4"), (4, "lab", "a3")] {
            let mut p = Pane::new(id, m, a, 40, 20);
            p.phase = Phase::Live;
            app.panes.insert(id, p);
        }
        app.tabs = vec![one, two];
        app.active = 0;
        app.fit_panes();
        app
    }

    fn screen(app: &mut App) -> (String, Buffer) {
        let (w, h) = app.size;
        let mut term = ratatui::Terminal::new(ratatui::backend::TestBackend::new(w, h)).unwrap();
        term.draw(|f| crate::ui::draw(f, app)).unwrap();
        let buf = term.backend().buffer().clone();
        ((0..h).map(|y| (0..w).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n"), buf)
    }

    fn row(s: &str, y: usize) -> String { s.lines().nth(y).unwrap_or("").to_string() }

    fn ev(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent { MouseEvent { kind, column, row, modifiers: crossterm::event::KeyModifiers::NONE } }

    #[test]
    fn the_bar_takes_its_columns_at_every_size() {
        for (w, h) in [(80u16, 24u16), (150, 42), (46, 10), (200, 60)] {
            for side in ["left", "right"] {
                let mut app = app((w, h), side);
                let bar = app.bar_rect().unwrap();
                assert_eq!((bar.width, bar.height, bar.y), (WIDTH, h, 0));
                assert_eq!(bar.x, if side == "left" { 0 } else { w - WIDTH });
                // The whole height beside the bar is the window's: no row over the panes.
                let body = app.body();
                assert_eq!(body, Rect::new(if side == "left" { WIDTH } else { 0 }, 0, w - WIDTH, h), "{w}x{h} {side}");
                assert_eq!(app.status_lines(), 0, "the bar is the status line");
                assert_eq!(app.bar_offset(), (if side == "left" { WIDTH } else { 0 }, 0));
                // Every pane is laid out in the body, and fills it (tmux's cells).
                assert!(app.rects.iter().all(|(_, r)| r.intersection(body) == *r), "{w}x{h} {side}: {:?}", app.rects);
                assert_eq!(app.tab().root.as_ref().unwrap().size(), (body.width, body.height));
                let _ = screen(&mut app);
                // Folded, the rail's four columns.
                click(&mut app, Hit::Fold, None);
                assert_eq!(app.body().width, w - RAIL);
                click(&mut app, Hit::Unfold, None);
                assert_eq!(app.body().width, w - WIDTH);
            }
        }
        // Too narrow for the bar and a window: none, and tmux's status line again.
        let app = app((36, 20), "left");
        assert!(app.bar_rect().is_none());
        assert_eq!(app.status_lines(), 1);
        // `status off` hides it as it hides the status line; bottom and top are the status line.
        let mut off = self::app((120, 30), "left");
        let _ = off.options.set("status", Some("off"), &crate::options::SetFlags { global: true, ..Default::default() }, "", 0);
        assert!(off.bar_rect().is_none());
        assert_eq!(self::app((120, 30), "bottom").body(), Rect::new(0, 0, 120, 29));
    }

    #[test]
    fn the_bar_draws_the_machine_its_windows_with_their_panes_then_the_machines() {
        for side in ["left", "right"] {
            let mut app = app((120, 36), side);
            let (s, buf) = screen(&mut app);
            let x0 = if side == "left" { 0 } else { 120 - WIDTH as usize + 1 };
            let bar = |y: usize| row(&s, y).chars().skip(x0).take(WIDTH as usize - 1).collect::<String>();
            // The machine you are on (the focused pane's), online.
            assert!(bar(0).starts_with(" ✓ studio") && bar(0).contains(&format!("+  {}", crate::workspace_controls::MENU_GLYPH)), "{s}");
            // (Each window named for its harness, as automatic-rename names it; idle harnesses and
            // shells have no mark, and no room kept for one — the name sits close.)
            assert!(bar(2).starts_with(" 0:fix login") && bar(2).trim_end().ends_with('3'), "{}", bar(2));
            assert!(bar(3).starts_with(" ├─ fix login"), "{}", bar(3));
            assert!(bar(4).starts_with(" │  auton… · feat/gr…"), "the repo under the name: {}", bar(4));
            assert!(bar(5).starts_with(" ├─ tests"), "{}", bar(5));
            assert!(bar(7).starts_with(" └─ "), "a shell: {}", bar(7));
            assert!(bar(8).starts_with("    ops"), "a shell's folder under its name: {}", bar(8));
            assert!(!s.contains(" · 0:") && !s.contains("├─ · "), "no dot for idle:\n{s}");
            // A window of one pane: just its heading.
            assert!(bar(9).starts_with(" 1:deploy") && bar(10).trim().is_empty(), "{}\n{}", bar(9), bar(10));
            // The current window's heading and the focused pane's two rows on the current row's
            // colour; the other panes and windows not.
            let bx = if side == "left" { 8 } else { 120 - WIDTH + 9 };
            assert_eq!(buf[(bx, 2)].bg, buf[(bx, 3)].bg);
            assert_eq!(buf[(bx, 3)].bg, buf[(bx, 4)].bg);
            assert_ne!(buf[(bx, 3)].bg, buf[(bx, 5)].bg);
            assert_ne!(buf[(bx, 2)].bg, buf[(bx, 9)].bg);
            // The separator down the side facing the panes: beside box panes (the default) a blank
            // column, the frames' edge being the line; beside tmux's lines, a `│`.
            let sx = if side == "left" { WIDTH - 1 } else { 120 - WIDTH };
            assert!((0..36).all(|y| buf[(sx, y)].symbol() == " "));
            let body = app.body();
            assert_eq!(buf[(if side == "left" { body.x } else { body.right() - 1 }, body.y + 3)].symbol(), "│", "the frame's own edge");
            // The windows' footer, the rule, the machines with their windows (one on both).
            let footer = crate::bar_more::footer_height(&app, WIDTH - 1).min(36 - 13);
            let footer = if footer >= 2 { footer as usize } else { 0 };
            let lists = 36 - footer - 1;
            let top = lists / 2;
            // (No ` new` / `menu` row and no `grouped` switch: their keys do that.)
            assert!(!s.contains("menu") && !s.contains("grouped"), "{s}");
            assert!(bar(top).chars().all(|c| c == '─'), "{}", bar(top));
            assert_eq!(bar(top + 1).trim_end(), " machines", "{}", bar(top + 1));
            assert!(bar(top + 3).starts_with(" ✓ studio"), "{}", bar(top + 3));
            assert!(bar(top + 4).starts_with(" └─ 0:fix login"), "{}", bar(top + 4));
            assert!(bar(top + 5).starts_with(" · lab"), "away: {}", bar(top + 5));
            assert!(bar(top + 7).starts_with(" └─ 1:deploy"), "offline, nothing known: {}", bar(top + 7));
            // The footer (status-right) over the last row, and `«` on it.
            if footer > 0 { assert!(bar(lists).starts_with("──"), "{s}") }
            assert_eq!(bar(35).trim_end().chars().last(), Some('«'));
            // No tabs over the panes: the boxes fill the window to its edges (beside the bar, its
            // blank edge is the one cell).
            let inner = app.box_inner(app.tab());
            assert_eq!(buf[(inner.x, inner.y)].symbol(), "┌");
            assert_eq!(buf[(inner.right() - 1, inner.bottom() - 1)].symbol(), "┘");
            assert_eq!(inner, app.body());
        }
    }

    /// A repo in the bar's width: the project whole while the branch keeps a few columns.
    #[test]
    fn a_repo_keeps_its_project_and_cuts_its_branch() {
        assert_eq!(repo("autonomous-harness", "feat/grid-harness-codex", 44), ["autonomous-harness", "feat/grid-harness-codex"]);
        assert_eq!(repo("autonomous-harness", "feat/grid-harness-codex", 40), ["autonomous-harness", "feat/grid-harness-…"]);
        assert_eq!(repo("autonomous-harness", "feat/grid-harness-codex", 30), ["autonomous-harness", "feat/gri…"]);
        assert_eq!(repo("autonomous-harness", "feat/grid-harness-codex", 17), ["auton…", "feat/gr…"]);
        assert_eq!(repo("autonomous-harness", "main", 17), ["autonomou…", "main"]);
        assert_eq!(repo("app", "", 10), ["app"]);
        assert_eq!(repo("autonomous-harness", "main", 10), ["main"], "too narrow for both: the branch");
        for (p, b, w) in [("autonomous-harness", "feat/grid-harness-codex", 17usize), ("x", "y", 12), ("a-long-project-name", "b", 20)] {
            let parts = repo(p, b, w);
            assert!(parts.iter().map(|s| s.width()).sum::<usize>() + 3 * (parts.len() - 1) <= w, "{p} {b} {w}: {parts:?}");
        }
    }

    #[test]
    fn a_click_on_the_bar_does_what_its_entry_says() {
        let mut app = app((120, 36), "left");
        let _ = screen(&mut app);
        // A pane row (either of its two lines): focus it.
        assert_eq!(hit_at(&app, 8, 6), Some(Hit::Pane(0, 2)));
        assert!(mouse(&mut app, &ev(MouseEventKind::Down(MouseButton::Left), 8, 6)));
        assert_eq!(app.focused(), Some(2));
        // A window's heading: select it.
        assert_eq!(hit_at(&app, 8, 9), Some(Hit::Window(1)));
        assert!(mouse(&mut app, &ev(MouseEventKind::Down(MouseButton::Left), 8, 9)));
        assert_eq!(app.active, 1);
        // A pane of another window: that window, then the pane.
        let _ = screen(&mut app);
        let (r, _) = app.bar.hits.iter().find(|(_, h)| *h == Hit::Pane(0, 3)).cloned().unwrap();
        assert!(mouse(&mut app, &ev(MouseEventKind::Down(MouseButton::Left), r.x + 4, r.y)));
        assert_eq!((app.active, app.focused()), (0, Some(3)));
        // The machine `lab`'s heading: its first window. A click in a pane is not the bar's.
        let _ = screen(&mut app);
        let (r, _) = app.bar.hits.iter().find(|(_, h)| matches!(h, Hit::Machine(m, Some(0)) if m == "lab")).cloned().unwrap();
        assert_eq!(hit_at(&app, r.x + 3, r.y), Some(Hit::Machine("lab".into(), Some(0))));
        assert!(!mouse(&mut app, &ev(MouseEventKind::Down(MouseButton::Left), 60, 10)));
        // `«` folds the bar and `»` opens it.
        let _ = screen(&mut app);
        let fold = app.bar.hits.iter().find(|(_, h)| *h == Hit::Fold).map(|(r, _)| *r).unwrap();
        assert!(mouse(&mut app, &ev(MouseEventKind::Down(MouseButton::Left), fold.x, fold.y)));
        assert!(app.bar.folded);
        let (s, _) = screen(&mut app);
        assert!(row(&s, 35).contains('»'), "{s}");
        assert_eq!(app.bar_offset().0, RAIL);
    }

    #[test]
    fn the_separator_drags_the_width_and_a_double_click_resets_it() {
        for side in ["left", "right"] {
            let mut app = app((120, 36), side);
            let _ = screen(&mut app);
            // The separator's column, for a bar [w] wide.
            let at = |w: u16| if side == "left" { w - 1 } else { 120 - w };
            let drag = |app: &mut App, to: u16| {
                assert!(mouse(app, &ev(MouseEventKind::Down(MouseButton::Left), at(app.bar_width()), 5)));
                app.bar.pressed = None;
                assert!(app.bar.resizing);
                assert!(mouse(app, &ev(MouseEventKind::Drag(MouseButton::Left), to, 6)));
                assert!(mouse(app, &ev(MouseEventKind::Up(MouseButton::Left), to, 6)));
                assert!(!app.bar.resizing);
                let _ = screen(app);
            };
            drag(&mut app, at(20));
            assert_eq!(app.bar_width(), 20);
            assert_eq!(app.body().width, 100, "the panes fitted to what is left");
            assert_eq!(app.tab().root.as_ref().unwrap().size().0, 100);
            drag(&mut app, at(34));
            assert_eq!(app.bar_width(), 34);
            assert_eq!(app.options.get("@hn-status-bar-width", "", None).as_deref(), Some("34"));
            // Held at both ends: 18 at least, 36 at most.
            drag(&mut app, if side == "left" { 3 } else { 117 });
            assert_eq!(app.bar_width(), MIN_WIDTH);
            drag(&mut app, if side == "left" { 80 } else { 40 });
            assert_eq!(app.bar_width(), MAX_WIDTH);
            // A double click on it: the default width again.
            let sx = at(app.bar_width());
            assert!(mouse(&mut app, &ev(MouseEventKind::Down(MouseButton::Left), sx, 5)));
            assert!(mouse(&mut app, &ev(MouseEventKind::Up(MouseButton::Left), sx, 5)));
            assert!(mouse(&mut app, &ev(MouseEventKind::Down(MouseButton::Left), sx, 5)));
            assert_eq!(app.bar_width(), WIDTH);
        }
        // Never leaving the window under 20 columns.
        let mut narrow = app((50, 30), "left");
        narrow.set_bar_width(MAX_WIDTH);
        assert_eq!(narrow.bar_width(), 30);
        assert_eq!(narrow.body().width, 20);
        // The width goes through tui.toml: written as the look is, read back as an option at boot.
        let look = crate::config::Look { status_bar_width: narrow.options.get("@hn-status-bar-width", "", None), ..Default::default() };
        assert!(look.assignments().contains(&("@hn-status-bar-width".to_string(), "30".to_string())));
    }

    #[test]
    fn the_wheel_scrolls_a_list_by_one_entry_and_the_focus_is_followed() {
        let mut app = app((80, 14), "left");
        let (s, _) = screen(&mut app);
        // A short bar: the windows' list shows a few rows of the eight its entries take.
        let max = app.bar.max_scroll[0];
        assert!(max >= 1, "{s}");
        for _ in 0..max + 2 { wheel(&mut app, Hit::Windows, false) }
        assert_eq!(app.bar.scroll[0], max, "no further than the last entry");
        for _ in 0..max + 2 { wheel(&mut app, Hit::Windows, true) }
        assert_eq!(app.bar.scroll[0], 0);
        // tmux's keys move the focus; the bar follows it into view.
        crate::commands::execute(&mut app, "select-pane -t %2");
        let (s, _) = screen(&mut app);
        assert_eq!(app.focused(), Some(3));
        let shown = app.bar.hits.iter().any(|(_, h)| *h == Hit::Pane(0, 3));
        assert!(shown && app.bar.scroll[0] > 0, "{s}");
    }

    /// A pane another window has the keyboard of is taken as soon as you come to it — by
    /// select-pane (a key) and by a click on its entry in the bar — not only once you type.
    #[test]
    fn coming_to_a_watched_pane_takes_it() {
        let mut app = app((120, 36), "left");
        for id in [2, 3] { app.panes.get_mut(&id).unwrap().phase = Phase::Watching("studio · other window".into()) }
        crate::commands::execute(&mut app, "select-pane -t %1");
        assert_eq!(app.focused(), Some(2));
        assert!(!matches!(app.panes[&2].phase, Phase::Watching(_)), "a key to it takes it");
        let _ = screen(&mut app);
        let hit = app.bar.hits.iter().find(|(_, h)| *h == Hit::Pane(0, 3)).map(|(_, h)| h.clone()).unwrap();
        click(&mut app, hit, None);
        assert_eq!(app.focused(), Some(3));
        assert!(!matches!(app.panes[&3].phase, Phase::Watching(_)), "a click on it takes it");
    }

    // ── box panes ──

    /// Box panes: each pane its own frame, a cell apart (never one line shared by two panes) — the
    /// focused one's in the status bar's background colour, the one waiting on you in the attention colour, the others quiet.
    #[test]
    fn each_pane_is_its_own_box_in_the_focus_and_attention_colours() {
        let _colours = crate::term_out::colours_lock();
        let mut app = app((120, 36), "bottom");
        app.fleet.agents.get_mut(&("local".to_string(), "a2".to_string())).unwrap().question = Some(crate::fleet::Question {
            request_id: "r".into(), answer_key: "k".into(), prompt: "Allow edit?".into(), options: vec![], multi: false, since: std::time::Instant::now(),
        });
        let _ = app.options.set("pane-border-status", Some("off"), &crate::options::SetFlags { global: true, ..Default::default() }, "", 0);
        app.fit_panes();
        let (s, buf) = screen(&mut app);
        let frame = |id: u64| { let r = app.rects.iter().find(|(p, _)| *p == id).map(|(_, r)| *r).unwrap(); crate::pane_frame::boxed_in(r, app.window_area(app.tab()), app.box_inner(app.tab()), app.pane_status(app.tab())).surface };
        let (left, top_right, below) = (frame(1), frame(2), frame(3));
        let mid = left.y + left.height / 2;
        // Each box is its own frame: the left box's right edge and the right box's left edge touch
        // (`││`), no blank column between, never two boxes on one line.
        assert_eq!(buf[(left.right() - 1, mid)].symbol(), "│", "{s}");
        assert_eq!(top_right.x, left.right(), "the boxes touch:\n{s}");
        assert_eq!(buf[(top_right.x, top_right.y + 1)].symbol(), "│", "{s}");
        // Each frame is its own, with its own corners — never joined.
        assert_eq!(buf[(left.right() - 1, left.y)].symbol(), "┐", "the left box's own corner:\n{s}");
        assert_eq!(buf[(left.x, left.y)].symbol(), "┌");
        assert_eq!(buf[(top_right.x, top_right.y)].symbol(), "┌", "the right box's own corner:\n{s}");
        let (status_bg, attention) = (theme::paint(app.status_style().bg.unwrap_or(Color::Reset)), theme::paint(theme::ATTENTION));
        // Each box keeps its own colour on its own (unshared) lines.
        assert_eq!(buf[(left.right() - 1, mid)].fg, status_bg, "the focused pane's frame");
        assert_eq!(buf[(top_right.right() - 1, top_right.y + top_right.height / 2)].fg, attention, "the waiting pane's frame");
        assert_ne!(buf[(below.right() - 1, below.y + below.height / 2)].fg, status_bg, "a quiet frame");
        assert_ne!(buf[(below.right() - 1, below.y + below.height / 2)].fg, attention, "a quiet frame");
        // The program is inside its frame.
        assert_eq!(app.content_of(app.tab(), app.rects.iter().find(|(p, _)| *p == 1).unwrap().1), Rect::new(left.x + 1, left.y + 1, left.width - 2, left.height - 2));
    }

    /// The status bar is the same whichever focus style: blurred panes do not recolour it.
    #[test]
    fn the_status_bar_keeps_its_colours_when_panes_are_blurred() {
        let _colours = crate::term_out::colours_lock();
        let mut app = app((120, 36), "bottom");
        let global = crate::options::SetFlags { global: true, ..Default::default() };
        let mut styles = Vec::new();
        for focus in ["line", "surface"] {
            let _ = app.options.set("@hn-focus", Some(focus), &global, "", 0);
            styles.push((app.status_style(), app.style_of("window-status-current-style", app.active, None)));
        }
        assert_eq!(styles[0], styles[1]);
    }

    /// Two boxes next to each other touch (`││`); two blurred surfaces have one cell between
    /// them across, and down too — unless a pane title fills that row, then the surfaces meet as
    /// the boxes do (the title is the divider). Pane titles off and on top, the status line at the
    /// bottom or the bar at a side: never each pane's space added to the other's. At the window's
    /// edges and the status line a pane has none (beside the bar, its blank edge is the one cell).
    #[test]
    fn panes_side_by_side_touch_or_are_a_cell_apart_and_meet_the_edges() {
        for focus in ["line", "surface"] { for (side, titles) in [("bottom", "off"), ("bottom", "top"), ("left", "off"), ("left", "top"), ("right", "top")] {
            let mut app = app((120, 36), side);
            let global = crate::options::SetFlags { global: true, ..Default::default() };
            let _ = app.options.set("pane-border-status", Some(titles), &global, "", 0);
            let _ = app.options.set("@hn-focus", Some(focus), &global, "", 0);
            app.fit_panes();
            let (s, _) = screen(&mut app);
            let tab = app.tab();
            let (canvas, inner, status) = (app.window_area(tab), app.box_inner(tab), app.pane_status(tab));
            let boxes = focus == "line";
            let f: Vec<Rect> = [1, 2, 3].iter().map(|id| {
                let r = app.rects.iter().find(|(p, _)| p == id).unwrap().1;
                if boxes { crate::pane_frame::boxed_in(r, canvas, inner, status).surface } else { crate::pane_frame::frame(r, canvas, inner, status).surface }
            }).collect();
            // Boxes and blurred surfaces alike touch both ways (0), as the bottom ones touch the
            // status line.
            let (gap_across, gap_down): (i32, i32) = (0, 0);
            let at = format!("{focus}, {side}, titles {titles}:\n{s}");
            // Across: the left edge (the bar's blank column when it is on the left), between, the right edge.
            assert_eq!(f[0].x, canvas.x, "left edge {at}");
            if side == "left" { assert_eq!(canvas.x, app.bar_width(), "the bar's blank edge is the gap {at}"); }
            assert_eq!(f[1].x as i32 - f[0].right() as i32, gap_across, "between, across {at}");
            assert_eq!(f[1].right(), canvas.right(), "right edge {at}");
            if side == "right" { assert_eq!(app.size.0 - app.bar_width(), canvas.right(), "the bar's blank edge is the gap {at}"); }
            // Down: the top edge, between the two stacked panes, the bottom edge (the status line).
            assert_eq!(f[0].y, canvas.y, "top edge {at}");
            assert_eq!(f[2].y as i32 - f[1].bottom() as i32, gap_down, "between, down {at}");
            assert_eq!((f[0].bottom(), f[2].bottom()), (canvas.bottom(), canvas.bottom()), "bottom edge {at}");
        } }
    }

    // ── each machine's harnesses ──

    /// The bar app of `app((120, 50), "left")` plus the machine `grid` (named `grid-dev`, Ready)
    /// with [n] harnesses that are open in no window here.
    fn with_grid(n: usize) -> App {
        let mut app = app((120, 50), "left");
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "grid".into(), name: "grid-dev".into(), local: false, status: "online".into(), reach: crate::fleet::Reach::Ready });
        let rows: Vec<_> = (0..n).map(|i| json!({"id": format!("g{i}"), "name": format!("Grid task {i}"), "engine": "codex"})).collect();
        app.fleet.merge_roster("grid", &rows);
        app
    }

    /// Draw, then the first bar rect whose hit [want] accepts.
    fn rect_of(app: &mut App, want: impl Fn(&Hit) -> bool) -> Rect {
        let _ = screen(app);
        app.bar.hits.iter().find(|(_, h)| want(h)).map(|(r, _)| *r).expect("that entry is drawn")
    }

    /// A left press on that entry (three columns in, on its first row).
    fn click_on(app: &mut App, want: impl Fn(&Hit) -> bool) {
        let r = rect_of(app, want);
        assert!(mouse(app, &ev(MouseEventKind::Down(MouseButton::Left), r.x + 3, r.y)));
    }

    fn harness(m: &str, a: &str) -> Hit { Hit::Harness(m.into(), a.into()) }

    /// `put` with `Span`s writes what it wrote with `set_stringn` (2026-10-08): marks, wide and
    /// cut names, on a screen already written over, up to and past the right edge.
    #[test]
    fn put_as_spans_draws_what_set_stringn_did() {
        fn old_put(buf: &mut Buffer, mut x: u16, y: u16, right: u16, spans: &[(String, Style)]) -> u16 {
            for (text, style) in spans {
                if x >= right { break }
                let room = (right - x) as usize;
                let shown = cut(text, room);
                buf.set_stringn(x, y, &shown, room, *style);
                x += shown.width() as u16;
            }
            x
        }
        let bold = Style::default().fg(Color::Rgb(9, 9, 9)).add_modifier(Modifier::BOLD);
        let sets: [Vec<(String, Style)>; 4] = [
            vec![("✓".into(), bold), (" ".into(), Style::default()), ("Mac Auto".into(), bold)],
            vec![("├─ ".into(), Style::default()), ("⠹ ".into(), bold), ("Harness TUI LMStudio work".into(), Style::default())],
            vec![("日本語の名前の機械".into(), bold), ("offline".into(), Style::default())],
            vec![],
        ];
        let area = Rect::new(0, 0, 30, 1);
        for spans in &sets { for x in [0u16, 5, 29] { for right in [0u16, 3, 12, 26, 30] {
            let mut ground = Buffer::empty(area);
            for p in area.positions() { ground[p].set_symbol("x").set_style(Style::default().fg(Color::Red).bg(Color::Blue)); }
            let (mut old, mut new) = (ground.clone(), ground);
            let was = old_put(&mut old, x, 0, right, spans);
            assert_eq!(put(&mut new, x, 0, right, spans), was, "{spans:?} at {x} to {right}");
            assert_eq!(new, old, "{spans:?} at {x} to {right}");
        } } }
    }

    #[test]
    fn a_machine_lists_its_harnesses_not_open_here_three_then_more() {
        let mut app = with_grid(5);
        let (s, _) = screen(&mut app);
        assert!(s.contains("grid-dev"), "{s}");
        // (Equal recency: the name decides, so the first three are 0, 1, 2.)
        assert!(s.contains("├─ Grid task 0") && s.contains("├─ Grid task 2"), "{s}");
        assert!(!s.contains("Grid task 3"), "three rows at most: {s}");
        assert!(s.contains("└─ + 2 more"), "the last of the tree:\n{s}");
        assert!(app.bar.hits.iter().any(|(_, h)| *h == Hit::More("grid".into())));
        // Not for a machine that is not Ready (`lab`: offline, a roster of two): none — and it
        // says it is offline, at the right of its heading.
        assert!(!app.bar.hits.iter().any(|(_, h)| matches!(h, Hit::Harness(m, _) if m == "lab")));
        assert!(s.lines().any(|l| l.contains(" · lab") && l.contains("offline")), "{s}");
        // Three or fewer: no `+ N more`, the last harness closes the tree.
        let mut app = with_grid(2);
        let (s, _) = screen(&mut app);
        assert!(s.contains("└─ Grid task 1") && !s.contains("more"), "{s}");
    }

    #[test]
    fn a_harness_open_in_a_window_here_is_shown_once() {
        let mut app = with_grid(5);
        let mut tab = Tab::new("Grid task 0");
        tab.root = Some(Node::new(5, 40, 20));
        tab.focus = Some(5);
        let mut pane = Pane::new(5, "grid", "g0", 40, 20);
        pane.phase = Phase::Live;
        app.panes.insert(5, pane);
        app.tabs.push(tab);
        app.fit_panes();
        let _ = screen(&mut app);
        // (Its window's row is in both lists; as a harness row it is not drawn.)
        assert!(!app.bar.hits.iter().any(|(_, h)| *h == harness("grid", "g0")));
        assert!(app.bar.hits.iter().any(|(_, h)| *h == harness("grid", "g1")));
        // A stopped harness, or a terminal, is not listed.
        app.fleet.merge_roster("grid", &[json!({"id": "g1", "name": "Grid task 1", "engine": "codex", "status": "stopped"}), json!({"id": "t", "name": "zsh", "engine": "terminal"})]);
        let _ = screen(&mut app);
        assert!(!app.bar.hits.iter().any(|(_, h)| *h == harness("grid", "g1") || *h == harness("grid", "t")), "{:?}", app.bar.hits);
        assert!(app.bar.hits.iter().any(|(_, h)| *h == harness("grid", "g2")), "the next one takes its row");
    }

    #[tokio::test]
    async fn clicking_a_harness_row_opens_it_and_more_opens_the_machines_list() {
        let mut app = with_grid(5);
        click_on(&mut app, |h| *h == harness("grid", "g1"));
        assert!(app.find_pane("grid", "g1").is_some(), "open-harness ran");
        // Again (a slow attach): the same window, not a second one.
        let windows = app.tabs.len();
        crate::commands::execute(&mut app, "open-harness -s grid:g1");
        assert_eq!(app.tabs.len(), windows);
        click_on(&mut app, |h| *h == Hit::More("grid".into()));
        assert!(matches!(&app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Open { machine: Some(m), .. }, .. }) if m == "grid"));
    }

    #[tokio::test]
    async fn a_machine_id_with_a_space_still_opens_its_harness() {
        let mut app = app((120, 50), "left");
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "my box".into(), name: "my box".into(), local: false, status: "online".into(), reach: crate::fleet::Reach::Ready });
        app.fleet.merge_roster("my box", &[json!({"id": "b1", "name": "Box task", "engine": "codex"})]);
        click_on(&mut app, |h| *h == harness("my box", "b1"));
        assert!(app.find_pane("my box", "b1").is_some(), "quoted as the command reads it");
    }

    #[test]
    fn a_roster_arriving_keeps_the_scroll_on_the_same_entry() {
        let mut app = with_grid(2);
        // (16 rows: both lists still drawn, five rows of machines for eight entries.)
        app.size.1 = 16;
        let _ = screen(&mut app);
        assert!(app.bar.max_scroll[1] >= 2, "a height where the machines list scrolls: {}", app.bar.max_scroll[1]);
        // Down past this computer's heading and its window, onto `lab`.
        wheel(&mut app, Hit::Machines, false);
        wheel(&mut app, Hit::Machines, false);
        let top = |app: &mut App| { let _ = screen(app); app.bar.top[1].clone() };
        let before = top(&mut app);
        assert_eq!(before, Some(Hit::Machine("lab".into(), Some(0))), "lab's heading first");
        // This computer gets harnesses no window shows: rows above the first one shown.
        let mut rows = vec![json!({"id": "a1", "name": "fix login", "engine": "claude"}), json!({"id": "a2", "name": "tests", "engine": "codex"})];
        rows.extend((0..3).map(|i| json!({"id": format!("n{i}"), "name": format!("New {i}"), "engine": "codex"})));
        app.fleet.merge_roster("local", &rows);
        let scroll = app.bar.scroll[1];
        assert_eq!(top(&mut app), before, "the first entry shown is the same one");
        assert!(app.bar.scroll[1] > scroll, "its index moved down with the rows above it");
    }

    // ── a machine row always does something ──

    fn machine(id: &str, name: &str, status: &str, reach: crate::fleet::Reach) -> crate::fleet::Machine {
        crate::fleet::Machine { shared: false, id: id.into(), name: name.into(), local: false, status: status.into(), reach }
    }

    #[tokio::test]
    async fn a_ready_machine_without_a_window_opens_its_menu() {
        let mut app = with_grid(2);
        app.mouse = true;
        click_on(&mut app, |h| *h == Hit::Machine("grid".into(), None));
        let Some(crate::modal::Modal::Menu(m)) = &app.modal else { panic!("a menu") };
        assert_eq!(m.title, "grid-dev");
        let labels: Vec<_> = m.items.iter().map(|i| i.label.as_str()).collect();
        assert!(labels.contains(&"New Harness on grid-dev…") && labels.contains(&"Open its harnesses"), "{labels:?}");
        assert!(!labels.contains(&"Connect…"));
    }

    #[tokio::test]
    async fn a_machine_that_needs_a_link_opens_connect_and_an_offline_one_says_so() {
        let mut app = app((120, 50), "left");
        app.mouse = true;
        app.fleet.machines.push(machine("lb", "linux-box", "online", crate::fleet::Reach::NeedsLink));
        click_on(&mut app, |h| *h == Hit::Machine("lb".into(), None));
        assert!(matches!(app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Devices(crate::devices::View::Connect), .. })));
        app.modal = None;
        app.fleet.machines.push(machine("air", "MacBook-Air.local", "offline", crate::fleet::Reach::Offline));
        click_on(&mut app, |h| *h == Hit::Machine("air".into(), None));
        assert!(app.toast.as_ref().is_some_and(|t| t.0.contains("MacBook-Air.local is offline")), "{:?}", app.toast);
        assert!(matches!(app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Devices(crate::devices::View::Machines), .. })));
    }

    #[tokio::test]
    async fn a_machine_with_a_window_here_still_jumps_to_it_and_a_right_press_opens_its_menu() {
        let mut app = app((120, 50), "left");
        app.mouse = true;
        app.select_tab(1);
        click_on(&mut app, |h| matches!(h, Hit::Machine(m, Some(0)) if m == "lab"));
        assert_eq!(app.active, 0);
        // Right press: through the same path the real input takes (workspace_controls first).
        let r = rect_of(&mut app, |h| matches!(h, Hit::Machine(m, _) if m == "local"));
        let press = ev(MouseEventKind::Down(MouseButton::Right), r.x + 3, r.y);
        assert!(crate::workspace_controls::mouse(&mut app, &press));
        assert!(matches!(&app.modal, Some(crate::modal::Modal::Menu(m)) if m.title == "studio"));
    }

    #[tokio::test]
    async fn a_read_only_client_gets_no_menu_and_no_machine_action() {
        let mut app = with_grid(2);
        app.mouse = true;
        app.client_flags.push("read-only".into());
        let r = rect_of(&mut app, |h| matches!(h, Hit::Machine(m, _) if m == "grid"));
        assert!(!crate::workspace_controls::mouse(&mut app, &ev(MouseEventKind::Down(MouseButton::Right), r.x + 3, r.y)));
        assert!(app.modal.is_none());
        click_on(&mut app, |h| *h == Hit::Machine("grid".into(), None));
        assert!(app.modal.is_none(), "the left click keeps today's: nothing");
    }
}
