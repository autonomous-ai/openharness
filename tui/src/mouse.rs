//! tmux's mouse, ported (tty-keys.c's tty_keys_mouse, server-client.c's server_client_check_mouse
//! and key callback, cmd.c's cmd_mouse_*, input-keys.c's input_key_mouse): each event becomes a
//! key — MouseDown1Pane, WheelUpStatus, MouseDrag1Border… — looked up in the key tables as any key
//! is (over a pane in copy mode, the copy-mode table first), its commands run with the pane under
//! the mouse as their target (`-t =` names it); an event no key binds goes to the program in the
//! pane under it, when that program asked for the mouse. A command that takes a drag over
//! (resize-pane -M, copy-mode -M, begin-selection) is given the motion until the button comes
//! up, and then the MouseDragEnd key runs.

use std::time::Duration;

use alacritty_terminal::term::TermMode;
use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

use crate::app::App;
use crate::draw::RangeKind;
use crate::keys::{self, Chord, MouseKind};

// tmux.h's mouse masks and buttons.
const MASK_BUTTONS: u32 = 195;
const MASK_SHIFT: u32 = 4;
const MASK_META: u32 = 8;
const MASK_CTRL: u32 = 16;
const MASK_DRAG: u32 = 32;
const WHEEL_UP: u32 = 64;
const WHEEL_DOWN: u32 = 65;
const RELEASE: u32 = 3;
/// KEYC_CLICK_TIMEOUT: a second click this soon after the first is a double one, a third a triple.
const CLICK_TIMEOUT: Duration = Duration::from_millis(300);

fn buttons(b: u32) -> u32 { b & MASK_BUTTONS }
pub fn is_drag(b: u32) -> bool { b & MASK_DRAG != 0 }
pub fn is_wheel(b: u32) -> bool { matches!(buttons(b), WHEEL_UP | WHEEL_DOWN) }
pub fn is_release(b: u32) -> bool { buttons(b) == RELEASE }

/// The button a key names (MOUSE_BUTTON_1 … 11).
fn button_number(b: u32) -> Option<u8> {
    Some(match buttons(b) { 0 => 1, 1 => 2, 2 => 3, 66 => 6, 67 => 7, 128 => 8, 129 => 9, 130 => 10, 131 => 11, _ => return None })
}

/// struct mouse_event: one event, as tmux keeps it for the commands its key runs.
#[derive(Clone, Debug, Default)]
pub struct Event {
    pub valid: bool,
    /// The key it became (m->key): what send-keys -M passes on.
    pub key: Option<Chord>,
    pub x: u16,
    pub y: u16,
    /// Where the event before it was (a drag's first key is where the button went down).
    pub lx: u16,
    pub ly: u16,
    /// The button as tmux reads it (a release is 3), and the one before.
    pub b: u32,
    pub lb: u32,
    /// SGR's own button, with its modifiers — a release's too — and whether it was a release.
    pub sgr_b: u32,
    pub release: bool,
    /// The pane it was over (m->wp), or the pane a status range names.
    pub wp: Option<u64>,
    /// The window it was for (m->w, a tab id): a status range's, else the current one.
    pub w: Option<String>,
    /// A double click's key comes after its clicks: not for the pane's program (m->ignore).
    pub ignore: bool,
    /// The status line's first row (-1: none) and how many rows it has.
    pub statusat: i32,
    pub statuslines: u16,
}

/// Who takes a drag's motion (tty->mouse_drag_update and _release).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drag { Resize, Copy }

/// The client's mouse: the last event, the drag under way, the clicks being counted.
#[derive(Default)]
pub struct State {
    last: (u16, u16, u32),
    /// The drag's button, plus one (0: no drag).
    drag_flag: u32,
    pub drag: Option<Drag>,
    /// CLIENT_DOUBLECLICK / CLIENT_TRIPLECLICK: a click, or two, waiting for another.
    double: bool,
    triple: bool,
    click_button: u32,
    click_event: Option<Event>,
    /// Which click timer is the live one (an older one firing does nothing).
    click_gen: u64,
    /// Which copy-mode scroll timer is the live one.
    pub scroll_gen: u64,
}

enum Key { Chord(Chord), Dragging }

/// tty_keys_mouse: the terminal's event as tmux reads an SGR one — the button with its
/// modifiers (a release as 3), and where the last one was.
fn read(app: &mut App, raw: &MouseEvent) -> Event {
    let code = |btn: MouseButton| match btn { MouseButton::Left => 0, MouseButton::Middle => 1, MouseButton::Right => 2 };
    let (mut sgr_b, release) = match raw.kind {
        MouseEventKind::Down(b) => (code(b), false),
        MouseEventKind::Up(b) => (code(b), true),
        MouseEventKind::Drag(b) => (code(b) | MASK_DRAG, false),
        MouseEventKind::Moved => (RELEASE | MASK_DRAG, false),
        MouseEventKind::ScrollUp => (WHEEL_UP, false),
        MouseEventKind::ScrollDown => (WHEEL_DOWN, false),
        MouseEventKind::ScrollLeft => (66, false),
        MouseEventKind::ScrollRight => (67, false),
    };
    if raw.modifiers.contains(KeyModifiers::SHIFT) { sgr_b |= MASK_SHIFT }
    if raw.modifiers.contains(KeyModifiers::ALT) { sgr_b |= MASK_META }
    if raw.modifiers.contains(KeyModifiers::CONTROL) { sgr_b |= MASK_CTRL }
    let b = if release { RELEASE } else { sgr_b };
    let s = &mut app.mouse_state;
    let (lx, ly, lb) = s.last;
    s.last = (raw.column, raw.row, b);
    Event { x: raw.column, y: raw.row, lx, ly, b, lb, sgr_b, release, statusat: -1, ..Default::default() }
}

/// A mouse event from the terminal: an open menu takes it first (tmux's overlay), then it is a key.
pub fn on_event(app: &mut App, raw: MouseEvent) {
    let m = read(app, &raw);
    if matches!(app.modal, Some(crate::modal::Modal::Menu { .. })) { crate::input::menu_mouse(app, &m); return }
    handle(app, m, false);
}

/// server_client_key_callback, for a mouse key: the table it is in runs it; else the pane under
/// it has it.
fn handle(app: &mut App, mut m: Event, double: bool) {
    let Some(key) = check(app, &mut m, double) else { return };
    m.valid = true;
    let chord = match key { Key::Dragging => { drag_update(app, &m); return } Key::Chord(c) => c };
    m.key = Some(chord);
    // A message goes on the next key, as tmux's does.
    app.toast = None;
    // cmd_find_from_mouse: the pane the key is for, else the current one.
    let pane = mouse_pane(app, &m).map(|(_, p)| p).or_else(|| app.focused());
    let in_copy = pane.and_then(|p| app.panes.get(&p)).map(|p| p.in_mode()).unwrap_or(false);
    // The table: the prefix's after the prefix, a table of your own (switch-client -T); over a
    // pane in copy mode its table; else root — and root again when that one has nothing.
    let first = if app.prefix { "prefix".to_string() }
        else if let Some(t) = app.key_table.clone() { t }
        else if in_copy { if app.mode_keys_emacs() { "copy-mode".into() } else { "copy-mode-vi".into() } }
        else { "root".to_string() };
    let from_client_table = app.prefix || app.key_table.is_some();
    let mut binding = app.keymap.lookup(&first, &chord);
    if from_client_table { app.prefix = false; app.key_table = None; app.repeat_until = None }
    if binding.is_none() && first != "root" { binding = app.keymap.lookup("root", &chord) }
    match binding {
        Some(b) => crate::commands::execute_mouse(app, &b.command, m),
        None => {
            // window_pane_key: nothing for a pane in copy mode; else its program, if the event
            // was over it.
            let Some(pane) = pane else { return };
            if in_copy || m.wp != Some(pane) { return }
            input_key_mouse(app, pane, &m);
        }
    }
}

/// The click timer: a second click with no third after it is a double click.
fn click_timer(app: &mut App, generation: u64) {
    let s = &mut app.mouse_state;
    if s.click_gen != generation { return }
    let triple = s.triple;
    s.double = false;
    s.triple = false;
    if !triple { return }
    let Some(ev) = s.click_event.clone() else { return };
    if matches!(app.modal, Some(crate::modal::Modal::Menu { .. })) { return }
    handle(app, ev, true);
}

/// server_client_check_mouse: what key an event is — its kind (a click counted against the one
/// before, a drag begun where the button went down), where it was (a status range, a border, a
/// pane) and its modifiers. None: it is no key (a drag that has not moved, nothing there).
fn check(app: &mut App, m: &mut Event, double: bool) -> Option<Key> {
    #[derive(PartialEq, Clone, Copy)]
    enum T { Move, Down, Up, Drag, Wheel, Second, Double, Triple }
    let (ty, x, y, b);
    let mut ignore = false;
    if double {
        (ty, x, y, b) = (T::Double, m.x, m.y, m.b);
        ignore = true;
    } else if is_drag(m.sgr_b) && is_release(m.sgr_b) {
        (ty, x, y, b) = (T::Move, m.x, m.y, 0);
    } else if is_drag(m.b) {
        if app.mouse_state.drag_flag != 0 {
            if m.x == m.lx && m.y == m.ly { return None }
            (ty, x, y, b) = (T::Drag, m.x, m.y, m.b);
        } else {
            (ty, x, y, b) = (T::Drag, m.lx, m.ly, m.lb);
        }
    } else if is_wheel(m.b) {
        (ty, x, y, b) = (T::Wheel, m.x, m.y, m.b);
    } else if is_release(m.b) {
        (ty, x, y, b) = (T::Up, m.x, m.y, if m.release { m.sgr_b } else { m.lb });
    } else {
        let s = &mut app.mouse_state;
        let mut t = None;
        let mut timer = true;
        if s.double {
            s.click_gen += 1;
            s.double = false;
            if m.b == s.click_button { t = Some(T::Second); s.triple = true }
        } else if s.triple {
            s.click_gen += 1;
            s.triple = false;
            if m.b == s.click_button { t = Some(T::Triple); timer = false }
        }
        let t = t.unwrap_or_else(|| { s.double = true; T::Down });
        (ty, x, y, b) = (t, m.x, m.y, m.b);
        if timer {
            s.click_event = Some(m.clone());
            s.click_button = m.b;
            s.click_gen += 1;
            let generation = s.click_gen;
            app.spawn(async move { tokio::time::sleep(CLICK_TIMEOUT).await }, move |app, _| click_timer(app, generation));
        }
    }

    // Where it was: the status line's ranges, else a border or a pane of the current window.
    m.w = None;
    m.wp = None;
    m.ignore = ignore;
    let lines = app.status_lines();
    m.statuslines = lines;
    m.statusat = if lines == 0 { -1 } else if app.status_top { 0 } else { app.size.1.saturating_sub(lines) as i32 };
    let mut place = None;
    if m.statusat != -1 && (y as i32) >= m.statusat && (y as i32) < m.statusat + lines as i32 {
        let row = (y as i32 - m.statusat) as u16;
        let range = app.status_ranges.iter().find(|(r, rg)| *r == row && x >= rg.start && x < rg.end).map(|(_, rg)| rg.kind.clone());
        place = Some(match range {
            None => keys::STATUS_DEFAULT,
            Some(RangeKind::None) => return None,
            Some(RangeKind::Left) => keys::STATUS_LEFT,
            Some(RangeKind::Right) => keys::STATUS_RIGHT,
            Some(RangeKind::Pane(n)) => { let id = n + 1; if !app.panes.contains_key(&id) { return None } m.wp = Some(id); keys::STATUS }
            Some(RangeKind::Window(n)) => { let i = app.tab_by_num(n as usize)?; m.w = Some(app.tabs[i].id.clone()); keys::STATUS }
            Some(RangeKind::Session(_)) | Some(RangeKind::User(_)) => keys::STATUS,
        });
    }
    if place.is_none() {
        let (px, py) = (x as u32, body_y(m, y) as u32);
        let body = app.body();
        if px > body.width as u32 || py > body.height as u32 { return None }
        let geoms = app.visible_geoms();
        // A border (a zoomed window has none): the column after a pane or the row below it.
        if !app.tab().zoomed {
            if let Some((id, _)) = geoms.iter().find(|(_, g)| (g.x + g.w == px && g.y <= 1 + py && g.y + g.h >= py) || (g.y + g.h == py && g.x <= 1 + px && g.x + g.w >= px)) {
                m.wp = Some(*id);
                place = Some(keys::BORDER);
            }
        }
        // window_get_active_at: else the pane there (its right and bottom edges included).
        if place.is_none() {
            let (id, _) = geoms.iter().find(|(_, g)| px >= g.x && px <= g.x + g.w && py >= g.y && py <= g.y + g.h)?;
            m.wp = Some(*id);
            place = Some(keys::PANE);
        }
        m.w = Some(app.tab().id.clone());
    }
    let place = place?;
    let mods = |code: crossterm::event::KeyCode| {
        let mut k = KeyModifiers::NONE;
        if b & MASK_META != 0 { k |= KeyModifiers::ALT }
        if b & MASK_CTRL != 0 { k |= KeyModifiers::CONTROL }
        if b & MASK_SHIFT != 0 { k |= KeyModifiers::SHIFT }
        Key::Chord(Chord::normal(code, k))
    };

    // Anything but more of the drag (or the wheel) ends a drag: the drag's taker lets go, and
    // the key is MouseDragEnd for the button that began it.
    if ty != T::Drag && ty != T::Wheel && app.mouse_state.drag_flag != 0 {
        if let Some(d) = app.mouse_state.drag.take() { drag_release(app, d) }
        let button = app.mouse_state.drag_flag - 1;
        app.mouse_state.drag_flag = 0;
        // KEYC_MOUSE for a button no key names: nothing binds it, and the pane has it.
        let code = button_number(button).and_then(|n| keys::mouse_code(MouseKind::DragEnd, n, place)).or_else(|| keys::mouse_code(MouseKind::Move, 0, place))?;
        return Some(mods(code));
    }
    let code = match ty {
        T::Move => keys::mouse_code(MouseKind::Move, 0, place),
        T::Drag => {
            let taken = app.mouse_state.drag.is_some();
            app.mouse_state.drag_flag = buttons(b) + 1;
            if taken { return Some(Key::Dragging) }
            button_number(b).and_then(|n| keys::mouse_code(MouseKind::Drag, n, place))
        }
        T::Wheel => keys::mouse_code(if buttons(b) == WHEEL_UP { MouseKind::WheelUp } else { MouseKind::WheelDown }, 0, place),
        T::Up => button_number(b).and_then(|n| keys::mouse_code(MouseKind::Up, n, place)),
        T::Down => button_number(b).and_then(|n| keys::mouse_code(MouseKind::Down, n, place)),
        T::Second => button_number(b).and_then(|n| keys::mouse_code(MouseKind::Second, n, place)),
        T::Double => button_number(b).and_then(|n| keys::mouse_code(MouseKind::Double, n, place)),
        T::Triple => button_number(b).and_then(|n| keys::mouse_code(MouseKind::Triple, n, place)),
    }?;
    Some(mods(code))
}

/// A row counted in the window: below a status line on top, and (with it at the bottom) the row
/// above it for one on it.
fn body_y(m: &Event, y: u16) -> u16 {
    if m.statusat == 0 && y >= m.statuslines { y - m.statuslines }
    else if m.statusat > 0 && y as i32 >= m.statusat { (m.statusat - 1) as u16 }
    else { y }
}

/// cmd_mouse_window: the window a mouse event was for — a status range's, else the current one.
pub fn mouse_window(app: &App, m: &Event) -> Option<usize> {
    if !m.valid { return None }
    match &m.w { Some(id) => app.tabs.iter().position(|t| &t.id == id), None => Some(app.active) }
}

/// cmd_mouse_pane: its pane — the one it was over, else that window's active one.
pub fn mouse_pane(app: &App, m: &Event) -> Option<(usize, u64)> {
    let w = mouse_window(app, m)?;
    match m.wp {
        None => app.tabs[w].focus.map(|p| (w, p)),
        Some(p) => app.tabs[w].panes().contains(&p).then_some((w, p)),
    }
}

/// cmd_mouse_at: where in a pane the event was ([last]: the event before), if it was in it.
pub fn mouse_at(app: &App, pane: u64, m: &Event, last: bool) -> Option<(u16, u16)> {
    let (x, mut y) = if last { (m.lx, m.ly) } else { (m.x, m.y) };
    if m.statusat == 0 && y >= m.statuslines { y -= m.statuslines }
    let (_, g) = app.visible_geoms().into_iter().find(|(id, _)| *id == pane)?;
    let (x, y) = (x as u32, y as u32);
    if x < g.x || x >= g.x + g.w || y < g.y || y >= g.y + g.h { return None }
    Some(((x - g.x) as u16, (y - g.y) as u16))
}

/// input_key_mouse: the event to the pane's program, as it asked for them — none unless it did,
/// motion only in its button or any-motion mode, a bare move only in the latter.
pub fn input_key_mouse(app: &mut App, pane: u64, m: &Event) {
    if m.ignore { return }
    let Some((x, y)) = mouse_at(app, pane, m, false) else { return };
    let Some(p) = app.panes.get(&pane) else { return };
    let Some(bytes) = encode(m, x, y, p.mode()) else { return };
    if p.stream.is_some() && !p.read_only { app.send_input(pane, &bytes) }
}

/// input_key_get_mouse: SGR when the program asked for it, else UTF-8's or the old encoding.
fn encode(m: &Event, x: u16, y: u16, mode: TermMode) -> Option<Vec<u8>> {
    let motion = TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION;
    if is_drag(m.b) && !mode.intersects(motion) { return None }
    if !mode.intersects(TermMode::MOUSE_REPORT_CLICK | motion) { return None }
    if is_drag(m.sgr_b) && is_release(m.sgr_b) && !mode.contains(TermMode::MOUSE_MOTION) { return None }
    if mode.contains(TermMode::SGR_MOUSE) {
        return Some(format!("\x1b[<{};{};{}{}", m.sgr_b, x as u32 + 1, y as u32 + 1, if m.release { 'm' } else { 'M' }).into_bytes());
    }
    let mut out = b"\x1b[M".to_vec();
    if mode.contains(TermMode::UTF8_MOUSE) {
        if m.b > 0x7ff - 32 || x as u32 > 0x7ff - 33 || y as u32 > 0x7ff - 33 { return None }
        for v in [m.b + 32, x as u32 + 33, y as u32 + 33] { let mut buf = [0u8; 4]; out.extend_from_slice(char::from_u32(v)?.encode_utf8(&mut buf).as_bytes()) }
        return Some(out);
    }
    if m.b + 32 > 0xff { return None }
    out.push((m.b + 32) as u8);
    out.push((x as u32 + 33).min(0xff) as u8);
    out.push((y as u32 + 33).min(0xff) as u8);
    Some(out)
}

// ── drags ────────────────────────────────────────────────────────────────────

fn drag_update(app: &mut App, m: &Event) {
    match app.mouse_state.drag {
        Some(Drag::Resize) => resize_update(app, m),
        Some(Drag::Copy) => crate::copy::drag_update(app, m),
        None => {}
    }
}

fn drag_release(app: &mut App, d: Drag) {
    // window_copy_drag_release: the scroll at the edge stops.
    if d == Drag::Copy { crate::copy::drag_release(app) }
}

/// resize-pane -M: the border under the mouse follows it (cmd_resize_pane_mouse_update).
pub fn resize_begin(app: &mut App, m: &Event) {
    if !m.valid || mouse_window(app, m).is_none() { return }
    app.mouse_state.drag = Some(Drag::Resize);
    resize_update(app, m);
}

fn resize_update(app: &mut App, m: &Event) {
    let Some(w) = mouse_window(app, m) else { app.mouse_state.drag = None; return };
    let (x, y, lx, ly) = (m.x as u32, body_y(m, m.y) as u32, m.lx as u32, body_y(m, m.ly) as u32);
    app.drag_border(w, lx, ly, x, y);
}

// ── formats ──────────────────────────────────────────────────────────────────

/// The mouse_* formats (format.c's format_cb_mouse_*), for the event of the key being run.
pub fn format(app: &App, name: &str) -> Option<String> {
    let m = app.mouse_ev.as_ref().filter(|m| m.valid)?;
    let on_status = || -> Option<u16> {
        if m.statusat == 0 && m.y < m.statuslines { return Some(m.y) }
        if m.statusat > 0 && m.y as i32 >= m.statusat { return Some((m.y as i32 - m.statusat) as u16) }
        None
    };
    let at = || mouse_pane(app, m).and_then(|(_, p)| mouse_at(app, p, m, false).map(|xy| (p, xy)));
    Some(match name {
        "mouse_pane" => crate::pane::tag(mouse_pane(app, m)?.1),
        "mouse_x" => match at() { Some((_, (x, _))) => x.to_string(), None => { on_status()?; m.x.to_string() } },
        "mouse_y" => match at() { Some((_, (_, y))) => y.to_string(), None => on_status()?.to_string() },
        "mouse_status_line" => on_status()?.to_string(),
        "mouse_status_range" => {
            let row = on_status()?;
            match app.status_ranges.iter().find(|(r, rg)| *r == row && m.x >= rg.start && m.x < rg.end).map(|(_, rg)| rg.kind.clone())? {
                RangeKind::None => return None,
                RangeKind::Left => "left".into(), RangeKind::Right => "right".into(), RangeKind::Pane(_) => "pane".into(),
                RangeKind::Window(_) => "window".into(), RangeKind::Session(_) => "session".into(), RangeKind::User(s) => s,
            }
        }
        "mouse_word" => {
            let (p, (x, y)) = at()?;
            let pane = app.panes.get(&p)?;
            let seps = app.options.get("word-separators", "", None).unwrap_or_default();
            match pane.modes.last() { Some(m) => m.word_at(x as u32, y as u32, &seps)?, None => pane.word_at(x, y, &seps) }
        }
        "mouse_line" => {
            let (p, (_, y)) = at()?;
            let pane = app.panes.get(&p)?;
            match pane.modes.last() { Some(m) => m.line_at(y as u32)?, None => pane.line_at(y) }
        }
        "mouse_hyperlink" => {
            let (p, (x, y)) = at()?;
            let pane = app.panes.get(&p)?;
            match pane.modes.last() { Some(m) => m.hyperlink_at(x as u32, y as u32)?, None => pane.hyperlink_at(x, y)? }
        }
        _ => return None,
    })
}
