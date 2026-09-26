//! Keys and mouse, the way tmux takes them: every key belongs to the pane in front of you, except
//! the prefix (C-b) and what you press right after it — tmux's own key table (`C-b c`, `C-b %`,
//! `C-b "`, `C-b o`, `C-b z`, `C-b [` …), read from `~/.tmux.conf` when there is one. Keys a
//! binding marks `-r` repeat without the prefix for `repeat-time`. The root table (keys with no
//! prefix) is empty unless you fill it, so no shell, editor or agent loses a key to Harness.

use std::time::{Duration, Instant};

use crossterm::event::{Event as CEvent, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use serde_json::json;

use crate::app::{App, Placement};
use crate::commands;
use crate::keys;
use crate::layout::{self, Dir, Preset, Toward};
use crate::modal::{self, Filter, Modal, PickerKind, Prompt, PromptKind, What};
use crate::pane::{encode_key, encode_mouse, Phase};
use crate::picker::Picker;
use crate::theme;

pub fn handle(app: &mut App, event: CEvent) {
    match event {
        CEvent::Key(key) if key.kind != KeyEventKind::Release => on_key(app, key),
        CEvent::Paste(text) => on_paste(app, text),
        CEvent::Mouse(mouse) => { if app.mouse { on_mouse(app, mouse) } }
        CEvent::Resize(cols, rows) => { app.size = (cols, rows); app.fit_panes() }
        // The terminal in front: the dial follows its pane again (and hears it is in front).
        CEvent::FocusGained => { app.terminal_focused = true; crate::dial::announce(app, false); app.announce_focus() }
        CEvent::FocusLost => { app.terminal_focused = false; crate::dial::announce(app, false) }
        _ => {}
    }
    crate::dial::settle_voice(app);
}

/// Overlays that type text keep every key (tmux's prompt ignores the prefix too).
fn typing(app: &App) -> bool {
    matches!(app.modal, Some(Modal::Prompt(_)) | Some(Modal::Picker { .. }) | Some(Modal::Find { .. }) | Some(Modal::Confirm { .. }) | Some(Modal::Popup { .. }) | Some(Modal::Menu { .. }))
}

fn on_key(app: &mut App, key: KeyEvent) {
    let chord = keys::of(&key);
    // A message goes on the next key, as tmux's does; and tim notices you are back.
    app.toast = None;
    app.tim.touched = std::time::Instant::now();
    // A table of your own (switch-client -T): its key runs, and the client goes back to root
    // (a -r key keeps the table); the prefix, or a key it does not have, goes on as from root.
    if let Some(table) = app.key_table.take() {
        if chord == app.keymap.prefix || Some(chord) == app.keymap.prefix2 { app.prefix = true; app.prefix_at = Some(std::time::Instant::now()); return }
        if let Some(b) = app.keymap.named.get(&table).and_then(|l| l.iter().rev().find(|b| b.chord == chord)).cloned() {
            if b.repeat { app.key_table = Some(table) }
            commands::execute(app, &b.command);
            return;
        }
    }
    // After the prefix: the prefix table.
    if app.prefix {
        app.prefix = false;
        if chord == app.keymap.prefix || Some(chord) == app.keymap.prefix2 {
            // `send-prefix`: C-b C-b gives the pane a C-b.
            if let Some(bytes) = app.focused().and_then(|f| app.panes.get(&f)).and_then(|p| encode_key(&key, p.mode())) { send_to_focused(app, bytes) }
            return;
        }
        if let Some(binding) = app.keymap.prefix_command(&chord).cloned() {
            // A list or view on screen gives way to the command, as tmux's choose modes do.
            if matches!(app.modal, Some(Modal::Clock { .. }) | Some(Modal::DisplayPanes { .. }) | Some(Modal::Picker { .. }) | Some(Modal::Tree { .. })) { app.modal = None }
            app.repeat_until = binding.repeat.then(|| Instant::now() + Duration::from_millis(app.keymap.repeat_ms));
            commands::execute(app, &binding.command);
        }
        return;
    }
    // A repeatable key again, inside the repeat window: no prefix needed.
    if let Some(until) = app.repeat_until {
        if Instant::now() < until {
            if let Some(binding) = app.keymap.prefix_command(&chord).filter(|b| b.repeat).cloned() {
                app.repeat_until = Some(Instant::now() + Duration::from_millis(app.keymap.repeat_ms));
                commands::execute(app, &binding.command);
                return;
            }
        }
        app.repeat_until = None;
    }
    // The prefix works over the lists too (they are tmux's choose modes); only a line being typed
    // at the status line keeps it.
    let line_edit = matches!(app.modal, Some(Modal::Prompt(_)) | Some(Modal::Find { .. }) | Some(Modal::Confirm { .. }) | Some(Modal::Popup { .. }) | Some(Modal::Menu { .. }));
    if !line_edit && (chord == app.keymap.prefix || Some(chord) == app.keymap.prefix2) {
        app.prefix = true;
        app.prefix_at = Some(std::time::Instant::now());
        return;
    }
    if !typing(app) {
        if let Some(binding) = app.keymap.root_command(&chord).cloned() { commands::execute(app, &binding.command); return }
    }
    if app.modal.is_some() { modal_key(app, key); return }
    // A shell is on its way (split-window, new-window): what is typed meanwhile is its.
    if let Some(buffer) = app.starting_shell.as_mut() {
        if let Some(bytes) = encode_key(&key, alacritty_terminal::term::TermMode::empty()) { buffer.push(bytes); return }
    }
    let Some(focus) = app.focused() else { home_key(app, key); return };
    let Some(pane) = app.panes.get(&focus) else { return };
    match &pane.phase {
        Phase::Card { title, .. } => {
            if key.code == KeyCode::Enter {
                if title == "Paused" || title == "Could not resume" { app.resume(focus) } else { app.open_stream(focus, true) }
            }
        }
        // Mid-takeover (or still opening): keep what is typed and deliver it once the stream is ours.
        Phase::Connecting(_) => {
            if let Some(bytes) = encode_key(&key, pane.mode()) {
                if let Some(p) = app.panes.get_mut(&focus) { if p.opening { p.queued.push(bytes) } }
            }
        }
        Phase::Live | Phase::Watching(_) => {
            if let Some(bytes) = encode_key(&key, pane.mode()) {
                if let Some(p) = app.panes.get_mut(&focus) {
                    p.clear_selection();
                    p.scroll_bottom();
                    // Local echo on a slow link: plain characters appear now, confirmed when the echo lands.
                    let plain = !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER);
                    if p.should_predict() && plain && matches!(p.phase, Phase::Live) {
                        match key.code {
                            KeyCode::Char(c) => p.predict_char(c),
                            KeyCode::Backspace => p.predict_backspace(),
                            _ => p.clear_predictions(),
                        }
                    } else { p.clear_predictions() }
                }
                send_to_focused(app, bytes)
            }
        }
    }
}

/// Keys into the focused pane. A watcher is promoted first — typing is how you take a terminal.
fn send_to_focused(app: &mut App, bytes: Vec<u8>) {
    let Some(focus) = app.focused() else { return };
    send_to_pane(app, focus, bytes)
}

/// Keys into a pane (send-keys -t): a watcher's is taken over first, as typing takes it.
fn send_to_pane(app: &mut App, focus: u64, bytes: Vec<u8>) {
    let Some(pane) = app.panes.get_mut(&focus) else { return };
    if pane.read_only || matches!(pane.phase, Phase::Watching(_)) || pane.stream.is_none() {
        pane.queued.push(bytes);
        if !pane.opening { app.open_stream(focus, true) }
        return;
    }
    // synchronize-panes: the same keys into every pane of the window that takes them.
    if app.tab().sync && app.tab().panes().contains(&focus) {
        let others: Vec<u64> = app.tab().panes().into_iter().filter(|p| *p != focus).collect();
        for p in others {
            let ok = app.panes.get(&p).map(|x| x.stream.is_some() && !x.read_only && matches!(x.phase, Phase::Live)).unwrap_or(false);
            if ok { app.send_input(p, &bytes) }
        }
    }
    app.send_input(focus, &bytes);
}

fn on_paste(app: &mut App, text: String) {
    if let Some(Modal::Picker { picker, .. }) = &mut app.modal { for c in text.chars().filter(|c| !c.is_control()) { picker.type_char(c) } return }
    if let Some(Modal::Prompt(prompt)) = &mut app.modal { prompt.value.push_str(&text.replace(['\r', '\n'], " ")); return }
    let Some(focus) = app.focused() else { return };
    let live = app.panes.get(&focus).map(|p| p.stream.is_some() && !p.read_only).unwrap_or(false);
    if live { app.send_paste(focus, &text) }
    else { send_to_focused(app, text.into_bytes()) }
}

fn on_mouse(app: &mut App, mouse: MouseEvent) {
    if app.modal.is_some() {
        match mouse.kind {
            // The list reads bottom-up: the wheel moves the way the rows do; over the preview it
            // scrolls the preview, as fzf's does.
            // Copy mode: the wheel moves the view; entered by the wheel, it ends back at the bottom
            // (tmux's WheelUpPane → copy-mode -e).
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown if matches!(app.modal, Some(Modal::Copy { .. })) => {
                let pane = match &app.modal { Some(Modal::Copy { pane }) => *pane, _ => return };
                let up = matches!(mouse.kind, MouseEventKind::ScrollUp);
                let mut done = false;
                if let Some(p) = app.panes.get_mut(&pane) {
                    p.copy_scroll(if up { 3 } else { -3 });
                    if !up && p.scrolled() == 0 && p.copy_by_wheel { p.copy_end(); done = true }
                }
                if done { app.modal = None }
                return;
            }
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                let up = matches!(mouse.kind, MouseEventKind::ScrollUp);
                let half = app.size.0 / 2;
                if let Some(Modal::Picker { picker, .. }) = &mut app.modal {
                    if picker.preview && mouse.column >= half { picker.preview_scroll = if up { picker.preview_scroll.saturating_sub(1) } else { picker.preview_scroll.saturating_add(1).min(picker.preview_max.get()) } }
                    else { let r: i64 = if theme::fzf().reverse { -1 } else { 1 }; picker.move_by(if up { r } else { -r }) }
                }
            }
            MouseEventKind::Down(MouseButton::Left) => {
                let hit = match &mut app.modal { Some(Modal::Picker { picker, .. }) => Some(picker.click(mouse.row)), _ => None };
                match hit {
                    // A click takes the row, a second click on it opens it; a click outside the box closes it.
                    Some(true) => {
                        let double = matches!(app.last_click, Some((9, _, r, at, _)) if r == mouse.row && at.elapsed() < Duration::from_millis(400));
                        app.last_click = Some((9, mouse.column, mouse.row, std::time::Instant::now(), 1));
                        if double { app.last_click = None; modal_key(app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)) }
                    }
                    Some(false) => {
                        let top = app.size.1.saturating_sub(1);
                        let inside = matches!(&app.modal, Some(Modal::Picker { picker, .. }) if picker.row_at.first().map(|(y, _)| mouse.row >= y.saturating_sub(1)).unwrap_or(false) || mouse.row >= top);
                        if !inside { app.modal = None }
                    }
                    None => {}
                }
            }
            _ => {}
        }
        return;
    }
    let (x, y) = (mouse.column, mouse.row);
    // A drag ends wherever the button comes up — the tab strip included.
    if matches!(mouse.kind, MouseEventKind::Up(_)) && app.mouse_drag.is_some() { app.mouse_drag = None; return }
    // The status line's window list.
    if y == if app.status_top { 0 } else { app.size.1.saturating_sub(1) } && app.opts.status != Some(false) {
        // The wheel over the status line walks the windows, as tmux's WheelUpStatus does.
        match mouse.kind {
            MouseEventKind::ScrollUp => { commands::execute(app, "previous-window"); return }
            MouseEventKind::ScrollDown => { commands::execute(app, "next-window"); return }
            _ => {}
        }
        let Some(index) = crate::ui::tab_at(app, x) else { return };
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                // A second click on the same tab within a moment: rename it.
                let now = std::time::Instant::now();
                let double = matches!(app.last_click, Some((0, c, 0, at, _)) if c == index as u16 && at.elapsed() < Duration::from_millis(400));
                app.last_click = Some((0, index as u16, 0, now, 1));
                app.select_tab(index);
                if double { run(app, "rename-tab") }
            }
            MouseEventKind::Down(MouseButton::Middle) => app.close_tab(index),
            _ => {}
        }
        return;
    }
    // Dragging a split border.
    if let Some((pane, last_x, last_y)) = app.mouse_drag {
        match mouse.kind {
            MouseEventKind::Drag(MouseButton::Left) => {
                let body = app.body();
                let (dx, dy) = (x as f32 - last_x as f32, y as f32 - last_y as f32);
                if let Some(root) = app.tab_mut().root.as_mut() {
                    if dx != 0.0 { root.resize(pane, Dir::Horizontal, dx / body.width.max(1) as f32); }
                    if dy != 0.0 { root.resize(pane, Dir::Vertical, dy / body.height.max(1) as f32); }
                }
                app.mouse_drag = Some((pane, x, y));
                app.fit_panes();
                return;
            }
            MouseEventKind::Up(_) => { app.mouse_drag = None; return }
            _ => {}
        }
    }
    let rects = app.rects.clone();
    let hit = rects.iter().find(|(_, r)| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height).copied();
    let Some((id, rect)) = hit else {
        // On a border column: grab it.
        if let MouseEventKind::Down(MouseButton::Left) = mouse.kind {
            if let Some((id, _)) = rects.iter().find(|(_, r)| x == r.x + r.width && y >= r.y && y < r.y + r.height) { app.mouse_drag = Some((*id, x, y)) }
        }
        return;
    };
    if let MouseEventKind::Down(_) = mouse.kind {
        if app.focused() != Some(id) { let tab = app.active; app.focus_pane(tab, id) }
    }
    if y == rect.y {
        // The pane's header: a grab handle for the split above.
        if let MouseEventKind::Down(MouseButton::Left) = mouse.kind { app.mouse_drag = Some((id, x, y)) }
        return;
    }
    let (col, row) = (x - rect.x, y - rect.y - 1);
    let Some(pane) = app.panes.get_mut(&id) else { return };
    // Selecting text: whenever the program did not ask for the mouse — or always, with ⇧ held,
    // the way every terminal lets you select over a mouse-driven TUI.
    let wants_mouse = pane.mode().intersects(alacritty_terminal::term::TermMode::MOUSE_MODE);
    let force = mouse.modifiers.contains(KeyModifiers::SHIFT);
    if !wants_mouse || force || app.selecting == Some(id) {
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                let clicks = match app.last_click {
                    Some((p, c, r, at, n)) if p == id && c == col && r == row && at.elapsed() < Duration::from_millis(400) => (n % 3) + 1,
                    _ => 1,
                };
                app.last_click = Some((id, col, row, std::time::Instant::now(), clicks));
                pane.select_start(col, row, clicks);
                app.selecting = Some(id);
                return;
            }
            MouseEventKind::Drag(MouseButton::Left) if app.selecting == Some(id) => { pane.select_update(col, row); return }
            MouseEventKind::Up(MouseButton::Left) if app.selecting == Some(id) => {
                app.selecting = None;
                match pane.selection_text() {
                    Some(text) => {
                        crate::clipboard::store(&text);
                        // tmux puts a mouse copy in a paste buffer too (C-b ] pastes it).
                        app.buffers.insert(0, text.clone());
                        let n = text.chars().count();
                        app.say(format!("Copied {n} character{}", if n == 1 { "" } else { "s" }), theme::ONLINE);
                    }
                    None => pane.clear_selection(),
                }
                return;
            }
            _ if !wants_mouse => {}
            _ => {}
        }
    }
    if let Some(bytes) = encode_mouse(mouse.kind, col, row, mouse.modifiers, pane.mode()) {
        if pane.stream.is_some() && !pane.read_only { app.send_input(id, &bytes) }
        return;
    }
    match mouse.kind {
        MouseEventKind::ScrollUp => {
            if pane.mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN) {
                let bytes = if pane.mode().contains(alacritty_terminal::term::TermMode::APP_CURSOR) { b"\x1bOA\x1bOA\x1bOA".to_vec() } else { b"\x1b[A\x1b[A\x1b[A".to_vec() };
                app.send_input(id, &bytes);
            } else {
                // tmux: the wheel enters copy mode, which ends when scrolled back to the bottom.
                if pane.copy.is_none() { pane.copy_start(); pane.copy_by_wheel = true }
                pane.copy_scroll(3);
                app.modal = Some(Modal::Copy { pane: id });
            }
        }
        MouseEventKind::ScrollDown => {
            if pane.mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN) {
                let bytes = if pane.mode().contains(alacritty_terminal::term::TermMode::APP_CURSOR) { b"\x1bOB\x1bOB\x1bOB".to_vec() } else { b"\x1b[B\x1b[B\x1b[B".to_vec() };
                app.send_input(id, &bytes);
            } else { pane.scroll(-3) }
        }
        _ => {}
    }
}

/// Scroll what is in front by [lines] (positive: up, toward older lines) — the dial's finger, the
/// way the wheel does it: a list's rows, copy mode's view, the wheel of a program that asked for the
/// mouse, a full-screen program's arrow keys, and a shell's history in copy mode, left again at the
/// bottom as tmux's wheel leaves it.
pub fn scroll_by(app: &mut App, lines: i32) {
    if lines == 0 { return }
    let up = lines > 0;
    let n = lines.unsigned_abs() as usize;
    match &mut app.modal {
        Some(Modal::Picker { picker, .. }) => {
            let r: i64 = if theme::fzf().reverse { -1 } else { 1 };
            picker.move_by(if up { r } else { -r } * n as i64);
            return;
        }
        Some(Modal::Copy { pane }) => {
            let pane = *pane;
            let mut done = false;
            if let Some(p) = app.panes.get_mut(&pane) {
                p.copy_scroll(lines);
                if !up && p.scrolled() == 0 && p.copy_by_wheel { p.copy_end(); done = true }
            }
            if done { app.modal = None }
            return;
        }
        Some(_) => return,
        None => {}
    }
    let Some(id) = app.focused() else { return };
    let Some(pane) = app.panes.get_mut(&id) else { return };
    let mode = pane.mode();
    let live = pane.stream.is_some() && !pane.read_only;
    use alacritty_terminal::term::TermMode;
    let bytes: Vec<u8> = if mode.intersects(TermMode::MOUSE_MODE) {
        let kind = if up { MouseEventKind::ScrollUp } else { MouseEventKind::ScrollDown };
        let (col, row) = (pane.cols / 2, pane.rows / 2);
        (0..n).filter_map(|_| encode_mouse(kind, col, row, KeyModifiers::NONE, mode)).flatten().collect()
    } else if mode.contains(TermMode::ALT_SCREEN) {
        let key: &[u8] = match (up, mode.contains(TermMode::APP_CURSOR)) { (true, true) => b"\x1bOA", (true, false) => b"\x1b[A", (false, true) => b"\x1bOB", (false, false) => b"\x1b[B" };
        key.repeat(n)
    } else {
        if up {
            if pane.copy.is_none() { pane.copy_start(); pane.copy_by_wheel = true }
            pane.copy_scroll(lines);
            app.modal = Some(Modal::Copy { pane: id });
        }
        return;
    };
    if live && !bytes.is_empty() { app.send_input(id, &bytes) }
}

// ── home: the empty tab ─────────────────────────────────────────────────────

pub fn home_agents(app: &App) -> Vec<(String, String)> {
    let ranked: Vec<(String, String)> = app.fleet.ranked().into_iter()
        .filter(|a| !matches!(app.fleet.state_of(a), crate::fleet::State::Paused | crate::fleet::State::Offline))
        .map(|a| a.key())
        .collect();
    // Numbers are for fingers: a row keeps its number while you look at the list, however the
    // harnesses' activity reorders them (the order is fresh each time the window is entered).
    let mut order = app.home_order.borrow_mut();
    let mut out: Vec<(String, String)> = order.iter().filter(|k| ranked.contains(k)).cloned().collect();
    for k in &ranked { if out.len() >= 9 { break } if !out.contains(k) { out.push(k.clone()) } }
    out.truncate(9);
    *order = out.clone();
    out
}

/// A window with no harness in it has no pane to take keys from, so plain letters work here.
fn home_key(app: &mut App, key: KeyEvent) {
    let rows = home_agents(app);
    let open = |app: &mut App, index: usize| {
        if let Some((m, a)) = rows.get(index).cloned() { app.open_agent(&m, &a, Placement::Auto(None)) }
    };
    match key.code {
        KeyCode::Char(c @ '1'..='9') => open(app, c as usize - '1' as usize),
        KeyCode::Enter => if rows.is_empty() { run(app, "open") } else { open(app, app.home_cursor) },
        KeyCode::Up | KeyCode::Char('k') => app.home_cursor = app.home_cursor.saturating_sub(1),
        KeyCode::Down | KeyCode::Char('j') => app.home_cursor = (app.home_cursor + 1).min(rows.len().saturating_sub(1)),
        KeyCode::Char('p') => run(app, "open"),
        KeyCode::Char('o') | KeyCode::Char('#') => run(app, "projects"),
        KeyCode::Char('n') => run(app, "new"),
        KeyCode::Char('t') => run(app, "terminal"),
        KeyCode::Char('i') | KeyCode::Char(':') => run(app, "models"),
        KeyCode::Char('I') => run(app, "inbox"),
        KeyCode::Char('m') | KeyCode::Char('@') => run(app, "machines"),
        KeyCode::Char('s') | KeyCode::Char('*') => run(app, "store"),
        KeyCode::Char('>') => run(app, "palette"),
        KeyCode::Char('b') => run(app, "send"),
        KeyCode::Char('/') | KeyCode::Char('?') => run(app, "help"),
        KeyCode::Char('q') => { if app.tabs.len() > 1 { let i = app.active; app.close_tab(i) } }
        _ => {}
    }
}

// ── commands ──────────────────────────────────────────────────────────────

pub fn picker(app: &mut App, kind: PickerKind, title: &str, placeholder: &str) {
    let mut picker = Picker::new(title, placeholder);
    // A list that is the whole answer (output, messages, keys) needs no preview beside it.
    if matches!(kind, PickerKind::Output { .. } | PickerKind::Messages | PickerKind::Keys) { picker.preview = false }
    fill(app, &kind, &mut picker);
    app.modal = Some(Modal::Picker { kind, picker });
}

/// (Re)build an overlay's rows from the fleet — called on open and whenever the fleet moves.
pub fn fill(app: &App, kind: &PickerKind, picker: &mut Picker) {
    match kind {
        PickerKind::Open { filter, machine, project } => {
            picker.set_rows(modal::agent_rows(app, *filter, machine.as_deref(), project.as_deref()));
            picker.status = modal::open_status(app, *filter);
            picker.hints = vec![("enter", "open"), ("C-t", "window"), ("C-v", "beside"), ("C-x", "below"), ("tab", "mark"), ("C-/", "preview"), ("M-p", "pause"), ("M-1..9", "answer")];
            picker.empty = if app.fleet.agents.is_empty() { "no harnesses yet — C-b C makes one".into() } else { String::new() };
        }
        PickerKind::Palette => { picker.set_rows(modal::palette_rows(app)); picker.hints = vec![("enter", "run"), ("C-b :", "type one")] }
        PickerKind::Projects => {
            picker.set_rows(modal::project_rows(app));
            picker.hints = vec![("enter", "its harnesses"), ("M-n", "new harness there")];
            picker.empty = "No projects yet.".into();
        }
        PickerKind::Models => {
            picker.keep_order = true;
            let mut rows = modal::model_rows(app);
            rows.extend(modal::local_model_rows(app));
            picker.set_rows(rows);
            // Start on the model it runs, so ↑/↓ are "a little more / less" from where it is.
            if picker.query.trim() == ":" && picker.selected_id.is_none() {
                if let Some(current) = focused_agent(app).and_then(|(m, a)| app.fleet.agent(&m, &a).map(|x| x.model.clone())) {
                    if let Some(at) = picker.visible.iter().position(|(i, _)| picker.rows[*i].id == current) { picker.cursor = at; picker.selected_id = Some(current) }
                }
            }
            picker.hints = vec![("enter", "use · start · get"), ("C-x", "stop a local model")];
            picker.empty = if app.focused().is_none() { "Focus a harness to switch its model.".into() } else { "Loading its models…".into() };
            picker.status = app.focused().and_then(|f| app.panes.get(&f)).and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| a.name.clone()).unwrap_or_default();
        }
        PickerKind::Inbox => {
            picker.keep_order = true;
            picker.set_rows(modal::inbox_rows(app));
            picker.status = format!("{} waiting", app.fleet.waiting());
            picker.hints = vec![("enter", "answer / go"), ("C-o", "open"), ("M-1..9", "answer")];
            picker.empty = "Nobody is waiting on you.".into();
        }
        PickerKind::Machines => {
            picker.set_rows(modal::machine_rows(app));
            let up = app.fleet.machines.iter().filter(|m| m.usable()).count();
            picker.status = format!("{up}/{} connected", app.fleet.machines.len());
            picker.hints = vec![("enter", "its harnesses"), ("M-n", "new there"), ("C-t", "terminal there"), ("M-l", "link")];
        }
        PickerKind::Layout => { picker.set_rows(modal::layout_rows()); picker.hints = vec![("enter", "apply")] }
        PickerKind::Help => { picker.keep_order = true; picker.set_rows(modal::mode_rows(app)); picker.hints = vec![("enter", "go")] }
        PickerKind::Store => {
            let catalog = app.dsh.get(&app.fleet.local_id).cloned().unwrap_or_default();
            picker.set_rows(modal::store_rows(&catalog));
            let installed = picker.rows.iter().filter(|r| r.lead.first().map(|s| s.content.contains('●')).unwrap_or(false)).count();
            picker.status = format!("{installed} installed");
            picker.hints = vec![("enter", "start one"), ("M-i", "install")];
            if catalog.is_empty() { picker.empty = "Loading the Store…".into() }
        }
        PickerKind::NewMachine => {
            let prefer = app.focused().and_then(|f| app.panes.get(&f)).map(|p| p.machine_id.clone()).unwrap_or(app.fleet.local_id.clone());
            picker.set_rows(modal::new_machine_rows(app, &prefer));
            picker.hints = vec![("enter", "choose")];
        }
        PickerKind::NewWhat { machine, .. } => {
            let catalog = app.dsh.get(machine).cloned().unwrap_or_default();
            picker.set_rows(modal::new_what_rows(&catalog));
            picker.status = app.fleet.machine_name(machine);
            picker.hints = vec![("enter", "choose")];
        }
        PickerKind::NewFolder { machine, .. } => {
            picker.set_rows(modal::new_folder_rows(app, machine));
            picker.status = app.fleet.machine_name(machine);
            picker.hints = vec![("enter", "choose")];
        }
        PickerKind::Route { .. } => {}
        PickerKind::Output { title, lines } => {
            picker.keep_order = true;
            picker.status = title.clone();
            // Output reads top-down, as tmux prints it: the list's bottom-up rows, reversed.
            picker.set_rows(lines.iter().enumerate().rev().map(|(i, l)| crate::picker::Row::new(i.to_string(), l.clone())).collect());
            picker.empty = "(empty)".into();
            picker.hints = vec![];
        }
        PickerKind::Messages => {
            picker.keep_order = true;
            let rows = app.messages.iter().enumerate().rev().map(|(i, (at, text))| {
                let secs = at.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                let hms = format!("{:02}:{:02}:{:02}", (secs / 3600 + local_offset_hours()) % 24, (secs / 60) % 60, secs % 60);
                crate::picker::Row::new(i.to_string(), text.clone()).lead(vec![ratatui::text::Span::styled(format!("{hms} "), theme::fg(theme::MUTED))])
            }).collect();
            picker.set_rows(rows);
            picker.empty = "no messages".into();
            picker.hints = vec![];
        }
        PickerKind::Keys => {
            // The whole line is searched, the prefix too (`C-b o`), as the line reads.
            let prefix = keys::name(&app.keymap.prefix);
            // A command too long to read at a glance (tmux's menus) shows its start; Enter runs it all.
            let shown = |c: &str| if c.chars().count() > 44 { format!("{}…", c.chars().take(43).collect::<String>().trim_end()) } else { c.to_string() };
            let mut rows: Vec<crate::picker::Row> = app.keymap.prefix_table.iter().map(|b| {
                crate::picker::Row::new(format!("{}\t{}", keys::name(&b.chord), b.command), format!("{prefix} {:<9} {}", keys::name(&b.chord), shown(&b.command)))
                    .extra(b.note.clone())
                    .detail(vec![ratatui::text::Span::styled(b.note.clone(), ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::DIM))])
            }).collect();
            let pad = " ".repeat(prefix.chars().count() + 1);
            rows.extend(app.keymap.root_table.iter().map(|b| crate::picker::Row::new(format!("{}\t{}", keys::name(&b.chord), b.command), format!("{pad}{:<9} {}", keys::name(&b.chord), shown(&b.command)))));
            picker.set_rows(rows);
            picker.hints = vec![("enter", "run it")];
        }
        PickerKind::Buffers => {
            picker.keep_order = true;
            let rows = app.buffers.iter().enumerate().map(|(i, b)| {
                let one: String = b.replace('\n', "\\n").chars().take(200).collect();
                crate::picker::Row::new(i.to_string(), format!("\"{one}\"")).lead(vec![ratatui::text::Span::styled(format!("buffer{i}: {} bytes: ", b.len()), theme::fg(theme::MUTED))])
            }).collect();
            picker.set_rows(rows);
            picker.empty = "no buffers".into();
            picker.hints = vec![("enter", "paste")];
        }
    }
}

/// The local timezone's offset, in hours (for message times), without a date crate.
fn local_offset_hours() -> u64 {
    let out = std::process::Command::new("date").arg("+%z").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let sign = if out.starts_with('-') { -1 } else { 1 };
    let hours: i64 = out.get(1..3).and_then(|h| h.parse().ok()).unwrap_or(0);
    ((24 + sign * hours) % 24) as u64
}

/// A status-line prompt, tmux's way: `(rename-window) name`. [label] becomes the hint shown dim
/// at the right when the line has room.
fn prompt(app: &mut App, kind: PromptKind, title: &str, label: &str, hint: &str, value: &str, secret: bool) {
    let tag = format!("({}) ", title.to_lowercase().replace(' ', "-"));
    let mut p = Prompt::status(kind, &tag, value);
    p.title = title.into();
    p.hint = if hint.is_empty() { label.to_string() } else { hint.to_string() };
    p.secret = secret;
    app.modal = Some(Modal::Prompt(p));
}

pub fn focused_agent(app: &App) -> Option<(String, String)> {
    app.focused().and_then(|f| app.panes.get(&f)).map(|p| (p.machine_id.clone(), p.agent_id.clone()))
}

/// The one box: open it in the mode [prefix] names (`""` harnesses, `>` `@` `#` `:` `*` `?`). The
/// same key again, while it is already in that mode, closes it.
pub fn launch(app: &mut App, prefix: &str, filter: Filter) {
    // A split waits for the NEXT pick only if it asked for this box; any other opening forgets it.
    SPLIT.with(|s| s.set(None));
    if let Some(Modal::Picker { kind, picker }) = &app.modal {
        let same_mode = modal::is_launcher(kind) && picker.query.trim().chars().next().map(|c| c.to_string()).unwrap_or_default() == prefix
            && !matches!(kind, PickerKind::Open { filter: f, .. } if *f != filter);
        if same_mode { app.modal = None; return }
    }
    let kind = match prefix { "" => PickerKind::Open { filter, machine: None, project: None }, p => modal::launcher_kind(p, &PickerKind::Palette) };
    let (title, placeholder) = modal::launcher_title(app, &kind);
    let mut picker = Picker::new(title, placeholder);
    picker.prefixed = true;
    picker.query = prefix.to_string();
    picker.qcursor = prefix.chars().count();
    prepare(app, &kind);
    fill(app, &kind, &mut picker);
    app.modal = Some(Modal::Picker { kind, picker });
}

/// What a mode needs fetched before its rows mean anything.
fn prepare(app: &mut App, kind: &PickerKind) {
    match kind {
        PickerKind::Machines => app.refresh_machines(),
        PickerKind::Store => load_dsh(app, app.fleet.local_id.clone()),
        PickerKind::Models => load_models(app),
        _ => {}
    }
}

fn load_local_models(app: &mut App) {
    let machine = modal::models_machine(app);
    let Some(link) = app.link(&machine) else { return };
    app.spawn(async move { link.rpc("grid_fleet_models_list", json!({}), Duration::from_secs(30)).await }, move |app, reply| {
        if let Ok(reply) = reply { app.local_models.insert(machine, reply.get("models").and_then(|v| v.as_array()).cloned().unwrap_or_default()); }
        refill(app);
    });
}

fn load_models(app: &mut App) {
    load_local_models(app);
    let Some((machine, agent)) = focused_agent(app) else { return };
    let Some(link) = app.link(&machine) else { return };
    let key = (machine, agent.clone());
    app.spawn(async move { link.rpc("models_list", json!({ "agentId": agent }), Duration::from_secs(20)).await }, move |app, reply| {
        if let Ok(reply) = reply { app.models.insert(key, reply.get("models").and_then(|v| v.as_array()).cloned().unwrap_or_default()); }
        refill(app);
    });
}

/// The query changed: when its first character moved the box to another mode, rebuild it as that mode.
fn remode(app: &App, kind: PickerKind, picker: &mut Picker) -> (PickerKind, bool) {
    if !modal::is_launcher(&kind) { return (kind, false) }
    let next = modal::launcher_kind(&picker.query, &kind);
    if std::mem::discriminant(&next) == std::mem::discriminant(&kind) { return (kind, false) }
    let (title, placeholder) = modal::launcher_title(app, &next);
    picker.title = title;
    picker.placeholder = placeholder;
    picker.keep_order = false;
    picker.scroll = 0;
    (next, true)
}

pub fn run(app: &mut App, command: &str) {
    match command {
        "open" => launch(app, "", Filter::All),
        "palette" => launch(app, ">", Filter::All),
        "projects" => launch(app, "#", Filter::All),
        "models" => launch(app, ":", Filter::All),
        "inbox" => picker(app, PickerKind::Inbox, "needs input", "Filter…"),
        "machines" => launch(app, "@", Filter::All),
        "help" => launch(app, "?", Filter::All),
        "layout" => picker(app, PickerKind::Layout, "layout", ""),
        "store" => launch(app, "*", Filter::All),
        "new" => {
            let usable: Vec<String> = app.fleet.machines.iter().filter(|m| m.usable()).map(|m| m.id.clone()).collect();
            if usable.len() > 1 { picker(app, PickerKind::NewMachine, "New Harness · where", "Machine…") }
            else if let Some(machine) = usable.first().cloned() { new_what(app, machine) }
            else { app.say("No machine is connected yet", theme::DANGER) }
        }
        "terminal" => {
            let machine = focused_agent(app).map(|(m, _)| m).unwrap_or(app.fleet.local_id.clone());
            create(app, machine, What { engine: "terminal".into(), dsh: None, label: "Terminal".into() }, None, None);
        }
        "send" => prompt(app, PromptKind::Send, "Send to harness", "What should be done?", "Harness picks the harness that fits best; you confirm.", "", false),
        "broadcast" => {
            let n = app.tab().panes().len();
            if n == 0 { app.say("No harnesses in this tab", theme::MUTED); return }
            prompt(app, PromptKind::Broadcast, &format!("Broadcast to {n} harness{}", if n == 1 { "" } else { "es" }), "Message", "Sent as a turn to every harness in this tab.", "", false)
        }
        "clone" => {
            let Some((machine, agent)) = focused_agent(app) else { app.say("This pane has no harness in it", theme::MUTED); return };
            let Some(link) = app.link(&machine) else { return };
            app.say("Cloning…", theme::SOFT);
            app.spawn(async move { link.rpc("agent_fork", json!({ "agentId": agent, "creationId": uuid::Uuid::new_v4().to_string() }), Duration::from_secs(120)).await }, move |app, reply| match reply {
                Ok(reply) => if let Some(id) = reply.pointer("/agent/id").and_then(|v| v.as_str()) {
                    app.fleet.agents.insert((machine.clone(), id.to_string()), crate::fleet::agent_from(&machine, &reply["agent"], None));
                    app.open_agent(&machine, id, Placement::Auto(None));
                },
                Err(e) => app.say(format!("Clone failed: {e}"), theme::DANGER),
            });
        }
        "restart" => agent_rpc(app, "agent_restart", "Restarted"),
        "pause" => agent_rpc(app, "agent_delete", "Paused — the conversation is saved"),
        "take" => { if let Some(f) = app.focused() { app.open_stream(f, true) } }
        "rename" => {
            let Some((machine, agent)) = focused_agent(app) else { return };
            let name = app.fleet.agent(&machine, &agent).map(|a| a.name.clone()).unwrap_or_default();
            prompt(app, PromptKind::RenameHarness { machine, agent }, "Rename Harness", "New name", "", &name, false)
        }
        "tab" => app.new_tab(),
        "rename-tab" => { let name = app.tab().name.clone(); prompt(app, PromptKind::RenameTab, "Rename Tab", "Tab name", "", &name, false) }
        "close-tab" => { let i = app.active; app.close_tab(i) }
        "next-tab" => { let n = app.tabs.len(); let i = (app.active + 1) % n; app.select_tab(i) }
        "prev-tab" => { let n = app.tabs.len(); let i = (app.active + n - 1) % n; app.select_tab(i) }
        "split-right" | "split-down" => {
            if app.tab().root.is_none() { run(app, "open"); return }
            let dir = if command == "split-right" { Dir::Horizontal } else { Dir::Vertical };
            app.modal = None;
            launch(app, "", Filter::All);
            if let Some(Modal::Picker { picker, .. }) = &mut app.modal { picker.title = if dir == Dir::Horizontal { "split right".into() } else { "split down".into() }; picker.placeholder = "Which harness goes beside it?".into() }
            SPLIT.with(|s| s.set(Some(dir)));
        }
        "close-pane" => { if let Some(f) = app.focused() { app.close_pane(f) } else if app.tabs.len() > 1 { let i = app.active; app.close_tab(i) } }
        "zoom" => { let tab = app.tab_mut(); if tab.panes().len() > 1 { tab.zoomed = !tab.zoomed } app.fit_panes() }
        "equalize" => { if let Some(root) = app.tab_mut().root.as_mut() { root.equalize() } app.fit_panes() }
        "pane-tab" => {
            let Some((machine, agent)) = focused_agent(app) else { return };
            if app.tab().panes().len() < 2 { return }
            // Moving a shell is not closing it.
            let key = (machine.clone(), agent.clone());
            let shell = app.shells.remove(&key);
            if let Some(f) = app.focused() { app.close_pane(f) }
            if shell { app.shells.insert(key); }
            app.open_agent(&machine, &agent, Placement::Tab);
        }
        "focus-left" | "focus-right" | "focus-up" | "focus-down" => {
            let toward = match command { "focus-left" => Toward::Left, "focus-right" => Toward::Right, "focus-up" => Toward::Up, _ => Toward::Down };
            let Some(focus) = app.focused() else { return };
            if app.tab().zoomed { return }
            if let Some(next) = layout::neighbour(&app.rects, focus, toward) { let tab = app.active; app.focus_pane(tab, next) }
        }
        "grow-left" | "grow-right" | "grow-up" | "grow-down" => {
            let Some(focus) = app.focused() else { return };
            let (dir, delta) = match command { "grow-left" => (Dir::Horizontal, -0.05), "grow-right" => (Dir::Horizontal, 0.05), "grow-up" => (Dir::Vertical, -0.05), _ => (Dir::Vertical, 0.05) };
            if let Some(root) = app.tab_mut().root.as_mut() { root.resize(focus, dir, delta); }
            app.fit_panes();
        }
        "copy-mode" => {
            let Some(pane) = app.focused() else { return };
            if let Some(p) = app.panes.get_mut(&pane) { p.copy_start() }
            app.modal = Some(Modal::Copy { pane });
        }
        "find" => {
            let Some(pane) = app.focused() else { return };
            app.modal = Some(Modal::Find { pane, query: String::new(), found: None, up: true });
        }
        "tab-left" => app.move_tab(-1),
        "tab-right" => app.move_tab(1),
        "last-tab" => {
            let at = app.last_tab.as_ref().and_then(|id| app.tabs.iter().position(|t| &t.id == id));
            if let Some(index) = at { app.select_tab(index) }
        }
        "next-waiting" => {
            // Oldest question first; the one in front of you counts as handled, so repeated presses walk the queue.
            let current = focused_agent(app);
            let mut waiting: Vec<_> = app.fleet.agents.values().filter(|a| a.question.is_some() && a.status != "stopped").map(|a| (a.question.as_ref().unwrap().since, a.machine_id.clone(), a.id.clone())).collect();
            waiting.sort();
            let next = waiting.iter().find(|(_, m, a)| current.as_ref() != Some(&(m.clone(), a.clone()))).or(waiting.first());
            match next {
                Some((_, m, a)) => { let (m, a) = (m.clone(), a.clone()); app.open_agent(&m, &a, Placement::Tab) }
                None => app.say("Nobody is waiting on you", theme::MUTED),
            }
        }
        "prev-waiting" => {
            let current = focused_agent(app);
            let mut waiting: Vec<_> = app.fleet.agents.values().filter(|a| a.question.is_some() && a.status != "stopped").map(|a| (a.question.as_ref().unwrap().since, a.machine_id.clone(), a.id.clone())).collect();
            waiting.sort();
            waiting.reverse();
            match waiting.iter().find(|(_, m, a)| current.as_ref() != Some(&(m.clone(), a.clone()))).or(waiting.first()) {
                Some((_, m, a)) => { let (m, a) = (m.clone(), a.clone()); app.open_agent(&m, &a, Placement::Tab) }
                None => app.say("no alert", theme::MUTED),
            }
        }
        "resume-focused" => { if let Some(f) = app.focused() { app.resume(f) } }
        "last-harness" => {
            match app.last_harness.clone() {
                Some((m, a)) => app.open_agent(&m, &a, Placement::Auto(None)),
                None => app.say("no last harness", theme::WARN),
            }
        }
        "tree" => app.modal = Some(Modal::Tree { cursor: tree_cursor_now(app), collapsed: Vec::new() }),
        "info" => {
            // tmux `display-message` with its default format, harness-flavoured.
            let text = match focused_agent(app).and_then(|(m, a)| app.fleet.agent(&m, &a).map(|x| (x.clone(), app.fleet.machine_name(&m)))) {
                Some((a, machine)) => format!("[{}] {}:{}, current pane {} - ({}) \"{}\" {} {}{}", app.session_name(), app.win_num(app.active), app.tab().name,
                    app.focused().and_then(|f| app.tab().panes().iter().position(|x| *x == f)).unwrap_or(0) + app.pane_base_index,
                    a.engine, a.name, machine, if a.cwd.is_empty() { String::new() } else { a.cwd.replace(&std::env::var("HOME").unwrap_or_default(), "~") }, if a.branch.is_empty() { String::new() } else { format!(" ({})", a.branch) }),
                None => format!("[{}] {}:{} — empty window", app.session_name(), app.win_num(app.active), app.tab().name),
            };
            app.say(text, theme::WARN);
        }
        "messages" => picker(app, PickerKind::Messages, "messages", ""),
        "keys" => picker(app, PickerKind::Keys, "keys", ""),
        "choose-buffer" => picker(app, PickerKind::Buffers, "buffers", ""),
        "quit" => app.quit = true,
        c if c.starts_with("tab-") => { if let Some(n) = c[4..].parse::<usize>().ok().and_then(|n| n.checked_sub(1)) { app.select_tab(n) } }
        _ => {}
    }
}

thread_local! {
    /// Which way the next harness picked goes, when the list was opened by split-window.
    static SPLIT: std::cell::Cell<Option<Dir>> = const { std::cell::Cell::new(None) };
}

fn agent_rpc(app: &mut App, ty: &'static str, done: &'static str) {
    let Some((machine, agent)) = focused_agent(app) else { app.say("This pane has no harness in it", theme::MUTED); return };
    let Some(link) = app.link(&machine) else { return };
    app.spawn(async move { link.rpc(ty, json!({ "agentId": agent }), Duration::from_secs(120)).await }, move |app, reply| match reply {
        Ok(_) => { app.say(done, theme::ONLINE); app.relist(&machine) }
        Err(e) => app.say(format!("{e}"), theme::DANGER),
    });
}

fn load_dsh(app: &mut App, machine: String) {
    let Some(link) = app.link(&machine) else { return };
    let id = machine.clone();
    app.spawn(async move {
        let dsh = link.rpc("dsh_list", json!({}), Duration::from_secs(20)).await;
        let home = link.rpc("fs_list_dir", json!({}), Duration::from_secs(20)).await;
        (dsh, home)
    }, move |app, (dsh, home)| {
        if let Ok(dsh) = dsh { app.dsh.insert(id.clone(), dsh.get("dsh").and_then(|v| v.as_array()).cloned().unwrap_or_default()); }
        if let Ok(home) = home { if let Some(path) = home.get("path").and_then(|v| v.as_str()) { app.homes.insert(id.clone(), path.to_string()); } }
        refill(app);
    });
}

/// Rebuild the open overlay's rows (the fleet or a catalog moved under it).
pub fn refill(app: &mut App) {
    if let Some(Modal::Picker { kind, mut picker }) = app.modal.take() {
        if !matches!(kind, PickerKind::Route { .. } | PickerKind::Palette | PickerKind::Help | PickerKind::Layout) { fill(app, &kind, &mut picker) }
        app.modal = Some(Modal::Picker { kind, picker });
    }
}

fn new_what(app: &mut App, machine: String) {
    load_dsh(app, machine.clone());
    let name = app.fleet.machine_name(&machine);
    picker(app, PickerKind::NewWhat { machine, cwd: None }, &format!("new harness · {name}"), "Claude Code, Codex, a Store harness…");
}

/// `agent_create`, then open it. [cwd] None with an agent = a new project folder.
/// tmux's split-window / new-window: a shell, now, on this pane's machine and in its folder
/// (`-c` another), running `command` if one is given. Keys typed before it is up go into it.
/// display-popup: a shell in a box over the window, running `command` then leaving (-E).
pub fn popup(app: &mut App, width: &str, height: &str, cwd: Option<String>, command: Option<String>, title: String, close_on_exit: bool) {
    let focused = focused_agent(app);
    let machine = focused.as_ref().map(|(m, _)| m.clone()).unwrap_or(app.fleet.local_id.clone());
    let live = focused.as_ref().and_then(|(m, a)| app.find_pane(m, a)).and_then(|(_, p)| app.panes.get(&p)).and_then(|p| p.cwd.clone());
    let cwd = cwd.or(live).or_else(|| focused.as_ref().and_then(|(m, a)| app.fleet.agent(m, a)).map(|a| a.cwd.clone()).filter(|c| !c.is_empty()));
    let Some(link) = app.link(&machine) else { app.say("That machine is not connected", theme::DANGER); return };
    let (w, h) = app.popup_size(width, height);
    let mut payload = json!({ "engine": "terminal", "creationId": uuid::Uuid::new_v4().to_string(), "bypassPermission": false });
    if let Some(cwd) = &cwd { payload["cwd"] = json!(cwd) }
    app.modal = None;
    // The command runs in the shell's place (-E: the popup goes when it ends) or in it; a leading
    // space keeps it out of the shell's history, `clear` off the screen.
    // `sh -c` takes the whole command line (`echo hi; read x`), as tmux runs it.
    let quoted = |c: &str| format!("'{}'", c.replace('\'', "'\\''"));
    let line = command.map(|c| if close_on_exit { format!(" clear; exec sh -c {}\r", quoted(&c)) } else { format!(" clear; sh -c {}\r", quoted(&c)) });
    app.starting_shell = Some(line.map(|l| vec![l.into_bytes()]).unwrap_or_default());
    app.spawn(async move { link.rpc("agent_create", payload, Duration::from_secs(60)).await }, move |app, reply| {
        let typed = app.starting_shell.take().unwrap_or_default();
        let Ok(reply) = reply else { app.say("Could not start the popup", theme::DANGER); return };
        let Some(id) = reply.pointer("/agent/id").and_then(|v| v.as_str()) else { return };
        app.fleet.agents.insert((machine.clone(), id.to_string()), crate::fleet::agent_from(&machine, &reply["agent"], None));
        app.shells.insert((machine.clone(), id.to_string()));
        let pane = app.new_pane(&machine, id);
        // The far terminal is at least 40×12; the box shows it whole when it can.
        let (cols, rows) = crate::pane::stream_size(w.saturating_sub(2), h.saturating_sub(2));
        if let Some(p) = app.panes.get_mut(&pane) { p.cols = cols; p.rows = rows; p.queued.extend(typed) }
        app.modal = Some(Modal::Popup { pane, width: w, height: h, title: title.clone() });
        app.open_stream(pane, true);
    });
}

/// The same, for the pane `from` (new-window reads it before the new window takes the focus).
pub fn new_shell_from(app: &mut App, focused: Option<(String, String)>, placement: Placement, cwd: Option<String>, command: Option<String>) {
    let machine = focused.as_ref().map(|(m, _)| m.clone()).unwrap_or(app.fleet.local_id.clone());
    // The folder: -c, else where the pane's shell says it is now (OSC 7), else where it started.
    let live = focused.as_ref().and_then(|(m, a)| app.find_pane(m, a)).and_then(|(_, p)| app.panes.get(&p)).and_then(|p| p.cwd.clone());
    let cwd = cwd.or(live).or_else(|| focused.as_ref().and_then(|(m, a)| app.fleet.agent(m, a)).map(|a| a.cwd.clone()).filter(|c| !c.is_empty()));
    let Some(link) = app.link(&machine) else { app.say("That machine is not connected", theme::DANGER); return };
    let mut payload = json!({ "engine": "terminal", "creationId": uuid::Uuid::new_v4().to_string(), "bypassPermission": false });
    if let Some(cwd) = &cwd { payload["cwd"] = json!(cwd) }
    app.modal = None;
    app.starting_shell = Some(command.map(|c| vec![format!("{c}\r").into_bytes()]).unwrap_or_default());
    app.spawn(async move { link.rpc("agent_create", payload, Duration::from_secs(60)).await }, move |app, reply| {
        let typed = app.starting_shell.take().unwrap_or_default();
        match reply {
            Ok(reply) => {
                let Some(id) = reply.pointer("/agent/id").and_then(|v| v.as_str()) else { app.say("The machine made no shell", theme::DANGER); return };
                app.fleet.agents.insert((machine.clone(), id.to_string()), crate::fleet::agent_from(&machine, &reply["agent"], None));
                app.shells.insert((machine.clone(), id.to_string()));
                app.open_agent(&machine, id, placement);
                // new-window -d: made in the background; back to where you were.
                if let Some((back, last)) = app.return_to.take() {
                    if let Some(i) = app.tabs.iter().position(|t| t.id == back) { app.select_tab(i); app.last_tab = last }
                }
                if let Some((w, pane)) = app.find_pane(&machine, id) {
                    if let Some(p) = app.panes.get_mut(&pane) { p.queued.extend(typed) }
                    // -P: what was made, printed (to the shell waiting on it).
                    if let Some(fmt) = app.print_new.take() {
                        let line: String = crate::format::spans_for_pane(app, &fmt, w, pane, ratatui::style::Style::default()).into_iter().map(|s| s.content.into_owned()).collect();
                        match app.held_reply.take() { Some(tx) => { let _ = tx.send((vec![line], Vec::new())); } None => app.say(line, theme::WARN) }
                    }
                }
            }
            Err(e) => {
                if let Some(tx) = app.held_reply.take() { let _ = tx.send((Vec::new(), vec![format!("create pane failed: {e}")])); }
                app.print_new = None;
                app.say(format!("Could not start a shell: {e}"), theme::DANGER)
            }
        }
    });
}

fn create(app: &mut App, machine: String, what: What, cwd: Option<String>, message: Option<String>) {
    let Some(link) = app.link(&machine) else { app.say("That machine is not connected", theme::DANGER); return };
    let terminal = what.engine == "terminal";
    let mut payload = json!({ "engine": what.engine, "creationId": uuid::Uuid::new_v4().to_string(), "bypassPermission": !terminal });
    if let Some(dsh) = &what.dsh { payload["dsh"] = json!(dsh) }
    match &cwd { Some(cwd) => payload["cwd"] = json!(cwd), None if !terminal => payload["projectSource"] = json!("new"), None => {} }
    if !terminal { payload["permissionMode"] = json!("auto") }
    if let Some(message) = message.filter(|m| !m.trim().is_empty()) { payload["prompt"] = json!(message.trim()) }
    app.say(format!("Starting {} on {}…", what.label, app.fleet.machine_name(&machine)), theme::SOFT);
    app.modal = None;
    app.spawn(async move { link.rpc("agent_create", payload, Duration::from_secs(180)).await }, move |app, reply| match reply {
        Ok(reply) => {
            if let Some(id) = reply.pointer("/agent/id").and_then(|v| v.as_str()) {
                app.fleet.agents.insert((machine.clone(), id.to_string()), crate::fleet::agent_from(&machine, &reply["agent"], None));
                let placement = if app.tab().root.is_none() { Placement::Auto(None) } else { Placement::Auto(None) };
                app.open_agent(&machine, id, placement);
                app.toast = None;
            } else { app.say("The machine created no harness", theme::DANGER) }
        }
        Err(e) => app.say(format!("Could not start it: {e}"), theme::DANGER),
    });
}

fn modal_key(app: &mut App, key: KeyEvent) {
    let Some(modal) = app.modal.take() else { return };
    match modal {
        Modal::Confirm { command, .. } => {
            // tmux: y runs it; any other key says no.
            if matches!(key.code, KeyCode::Char('y') | KeyCode::Char('Y')) { commands::execute(app, &command) }
        }
        Modal::DisplayPanes { .. } => {
            if let KeyCode::Char(c @ '0'..='9') = key.code {
                let n = (c as usize) - ('0' as usize);
                app.select_pane_index(n.saturating_sub(app.pane_base_index));
            }
        }
        Modal::Clock { .. } => {}
        // tmux's menu: ↑↓ (k j, C-p C-n) move, Enter runs, an item's key runs it, q Esc C-c leave.
        Modal::Menu { title, items, mut cursor } => {
            let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
            let step = |from: usize, by: i64| -> usize {
                let n = items.len() as i64;
                let mut i = from as i64;
                for _ in 0..n { i = (i + by).rem_euclid(n); if !items[i as usize].disabled && !items[i as usize].separator { return i as usize } }
                from
            };
            let name = keys::name(&keys::of(&key));
            match key.code {
                KeyCode::Esc | KeyCode::Char('q') => return,
                KeyCode::Char('c' | 'g') if ctrl => return,
                KeyCode::Up | KeyCode::Char('k') if !ctrl => cursor = step(cursor, -1),
                KeyCode::Down | KeyCode::Char('j') if !ctrl => cursor = step(cursor, 1),
                KeyCode::Char('p') if ctrl => cursor = step(cursor, -1),
                KeyCode::Char('n') if ctrl => cursor = step(cursor, 1),
                KeyCode::Enter => { let c = items[cursor].command.clone(); if !items[cursor].disabled { commands::execute(app, &c) } return }
                _ => {
                    if let Some(it) = items.iter().find(|it| !it.disabled && !it.separator && it.key == name) { let c = it.command.clone(); commands::execute(app, &c); return }
                }
            }
            app.modal = Some(Modal::Menu { title, items, cursor });
        }
        // Everything goes to the popup's program (the prefix still works, as in tmux).
        Modal::Popup { pane, width, height, title } => {
            if let Some(bytes) = app.panes.get(&pane).and_then(|p| encode_key(&key, p.mode())) {
                let live = app.panes.get(&pane).map(|p| p.stream.is_some()).unwrap_or(false);
                if live { app.send_input(pane, &bytes) } else if let Some(p) = app.panes.get_mut(&pane) { p.queued.push(bytes) }
            }
            app.modal = Some(Modal::Popup { pane, width, height, title });
        }
        Modal::Tree { cursor, collapsed } => tree_key(app, key, cursor, collapsed),
        Modal::Copy { pane } => copy_key(app, key, pane),
        Modal::Find { pane, mut query, mut found, up } => {
            let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
            let Some(p) = app.panes.get_mut(&pane) else { return };
            match key.code {
                KeyCode::Esc => { if p.copy.is_some() { app.modal = Some(Modal::Copy { pane }); return } p.end_find(); return }
                KeyCode::Char('c' | 'g') if ctrl => { p.end_find(); return }
                // Enter keeps the match and goes on in copy mode, as tmux's search does.
                KeyCode::Enter => {
                    app.last_search = Some(query.clone());
                    app.last_search_up = up;
                    if p.copy.is_none() { p.copy_start() }
                    if let Some(m) = p.find_at.clone() { p.copy_jump(*m.start()) }
                    app.modal = Some(Modal::Copy { pane });
                    return;
                }
                KeyCode::Up => { found = Some(p.find(&query, true, false)) }
                KeyCode::Down => { found = Some(p.find(&query, false, false)) }
                KeyCode::Char('p' | 'k') if ctrl => { found = Some(p.find(&query, true, false)) }
                KeyCode::Char('n' | 'j') if ctrl => { found = Some(p.find(&query, false, false)) }
                KeyCode::Backspace => { query.pop(); found = Some(p.find(&query, up, true)) }
                KeyCode::Char('u') if ctrl => { query.clear(); p.end_find() }
                KeyCode::Char(c) if !ctrl => { query.push(c); found = Some(p.find(&query, up, true)) }
                _ => {}
            }
            app.modal = Some(Modal::Find { pane, query, found, up });
        }
        Modal::Prompt(p) => prompt_key(app, key, p),
        Modal::Picker { kind, picker } => picker_key(app, key, kind, picker),
    }
}

/// The status-line prompt: tmux's `status-keys emacs`, command history on Up/Down, Tab completes.
fn prompt_key(app: &mut App, key: KeyEvent, mut p: Prompt) {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    // command-prompt -k: the key itself is the answer, by its tmux name (C-b / then x → "x").
    if let PromptKind::Key { template } = &p.kind {
        let name = keys::name(&keys::of(&key));
        let command = if template.contains("%%") { template.replace("%%", &name) } else { format!("{template} {}", quote(&name)) };
        commands::execute(app, &command);
        return;
    }
    // status-keys vi (tmux's default when $EDITOR names vi): Esc leaves insert for normal mode.
    let vi = app.opts.status_keys_vi.unwrap_or_else(|| { let e = std::env::var("VISUAL").or_else(|_| std::env::var("EDITOR")).unwrap_or_default(); e.contains("vi") });
    if vi && p.vi_normal { prompt_vi_normal(app, key, p); return }
    if vi && key.code == KeyCode::Esc && !ctrl && !alt { p.vi_normal = true; p.vi_pending = None; app.modal = Some(Modal::Prompt(p)); return }
    let chars: Vec<char> = p.value.chars().collect();
    let at = p.cursor.min(chars.len());
    let set = |p: &mut Prompt, v: Vec<char>, c: usize| { p.value = v.into_iter().collect(); p.cursor = c; };
    let word_left = |from: usize| { let mut i = from; while i > 0 && chars[i - 1] == ' ' { i -= 1 } while i > 0 && chars[i - 1] != ' ' { i -= 1 } i };
    let word_right = |from: usize| { let mut i = from; while i < chars.len() && chars[i] == ' ' { i += 1 } while i < chars.len() && chars[i] != ' ' { i += 1 } i };
    match key.code {
        KeyCode::Esc => return,
        KeyCode::Char('c' | 'g') if ctrl => return,
        KeyCode::Enter => {
            if matches!(p.kind, PromptKind::Command { template: None }) && !p.value.trim().is_empty() {
                app.history.retain(|h| h != &p.value);
                app.history.push(p.value.clone());
            }
            submit_prompt(app, p);
            return;
        }
        KeyCode::Backspace | KeyCode::Char('h') if key.code == KeyCode::Backspace || ctrl => {
            if alt { let from = word_left(at); let mut v = chars.clone(); v.drain(from..at); set(&mut p, v, from) }
            else if at > 0 { let mut v = chars.clone(); v.remove(at - 1); set(&mut p, v, at - 1) }
            else if p.value.is_empty() { return } // tmux: backspace on an empty prompt closes it
        }
        KeyCode::Delete => { if at < chars.len() { let mut v = chars.clone(); v.remove(at); set(&mut p, v, at) } }
        KeyCode::Char('d') if ctrl => { if at < chars.len() { let mut v = chars.clone(); v.remove(at); set(&mut p, v, at) } }
        KeyCode::Left => p.cursor = at.saturating_sub(1),
        KeyCode::Char('b') if ctrl => p.cursor = at.saturating_sub(1),
        KeyCode::Right => p.cursor = (at + 1).min(chars.len()),
        KeyCode::Char('f') if ctrl => p.cursor = (at + 1).min(chars.len()),
        KeyCode::Char('b') if alt => p.cursor = word_left(at),
        KeyCode::Char('f') if alt => p.cursor = word_right(at),
        KeyCode::Home => p.cursor = 0,
        KeyCode::Char('a') if ctrl => p.cursor = 0,
        KeyCode::End => p.cursor = chars.len(),
        KeyCode::Char('e') if ctrl => p.cursor = chars.len(),
        KeyCode::Char('k') if ctrl => { let v = chars[..at].to_vec(); set(&mut p, v, at) }
        // tmux's status prompt: C-u clears the whole line.
        KeyCode::Char('u') if ctrl => { set(&mut p, Vec::new(), 0) }
        KeyCode::Char('w') if ctrl => { let from = word_left(at); let mut v = chars.clone(); v.drain(from..at); set(&mut p, v, from) }
        KeyCode::Up | KeyCode::Down if matches!(p.kind, PromptKind::Command { template: None }) => prompt_history(app, &mut p, key.code == KeyCode::Up),
        KeyCode::Tab if matches!(p.kind, PromptKind::Command { template: None }) => {
            // Complete the command name: the only match, or the part every match shares.
            if !p.value.contains(' ') {
                let typed = p.value.clone();
                let matches: Vec<&str> = commands::COMMANDS.iter().map(|(n, _, _)| *n).filter(|n| n.starts_with(&typed)).collect();
                if matches.len() == 1 { p.value = format!("{} ", matches[0]) }
                else if !matches.is_empty() {
                    let mut common = matches[0].to_string();
                    for m in &matches[1..] { while !m.starts_with(&common) { common.pop(); } }
                    p.value = common;
                    p.hint = matches.join("  ");
                }
                p.cursor = p.value.chars().count();
            }
        }
        KeyCode::Char(c) if !ctrl && !alt => { let mut v = chars.clone(); v.insert(at, c); set(&mut p, v, at + 1); p.hint.clear() }
        _ => {}
    }
    app.modal = Some(Modal::Prompt(p));
}

/// The command history, a step up or down (Up/Down; k/j in vi normal mode).
fn prompt_history(app: &App, p: &mut Prompt, up: bool) {
    let n = app.history.len();
    if n == 0 { return }
    let next = match (p.history_at, up) {
        (None, true) => Some(n - 1),
        (Some(i), true) => Some(i.saturating_sub(1)),
        (Some(i), false) if i + 1 < n => Some(i + 1),
        _ => None,
    };
    p.history_at = next;
    p.value = next.map(|i| app.history[i].clone()).unwrap_or_default();
    p.cursor = p.value.chars().count();
}

/// tmux's status-keys vi, normal mode: h l 0 ^ $ w b e move; i a I A insert; x X D C S dd dw
/// cw c$ r delete or change; k j the history; Enter runs it; Esc (again) cancels.
fn prompt_vi_normal(app: &mut App, key: KeyEvent, mut p: Prompt) {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let chars: Vec<char> = p.value.chars().collect();
    let n = chars.len();
    let at = p.cursor.min(n);
    let set = |p: &mut Prompt, v: Vec<char>, c: usize| { p.value = v.into_iter().collect(); p.cursor = c; };
    let word_left = |from: usize| { let mut i = from; while i > 0 && chars[i - 1] == ' ' { i -= 1 } while i > 0 && chars[i - 1] != ' ' { i -= 1 } i };
    let word_right = |from: usize| { let mut i = from; while i < n && chars[i] != ' ' { i += 1 } while i < n && chars[i] == ' ' { i += 1 } i };
    let word_end = |from: usize| { let mut i = (from + 1).min(n); while i < n && chars[i] == ' ' { i += 1 } while i + 1 < n && chars[i + 1] != ' ' { i += 1 } i.min(n.saturating_sub(1)) };
    let insert = |p: &mut Prompt| p.vi_normal = false;
    let pending = p.vi_pending.take();
    match (pending, key.code) {
        // An operator and its motion.
        (Some('d'), KeyCode::Char('d')) => set(&mut p, Vec::new(), 0),
        (Some('c'), KeyCode::Char('c')) => { set(&mut p, Vec::new(), 0); insert(&mut p) }
        (Some(op @ ('d' | 'c')), KeyCode::Char(m @ ('w' | 'b' | '$' | '0' | 'e' | 'h' | 'l'))) => {
            let (from, to) = match m { 'w' => (at, word_right(at)), 'b' => (word_left(at), at), '$' => (at, n), '0' => (0, at), 'e' => (at, (word_end(at) + 1).min(n)), 'h' => (at.saturating_sub(1), at), _ => (at, (at + 1).min(n)) };
            let mut v = chars.clone(); v.drain(from..to); set(&mut p, v, from);
            if op == 'c' { insert(&mut p) }
        }
        (Some('r'), KeyCode::Char(c)) if !ctrl => { if at < n { let mut v = chars.clone(); v[at] = c; set(&mut p, v, at) } }
        (Some(_), _) => {}
        (None, KeyCode::Esc) => return,
        (None, KeyCode::Char('c' | 'g')) if ctrl => return,
        (None, KeyCode::Enter) => {
            if matches!(p.kind, PromptKind::Command { template: None }) && !p.value.trim().is_empty() { app.history.retain(|h| h != &p.value); app.history.push(p.value.clone()) }
            submit_prompt(app, p);
            return;
        }
        (None, KeyCode::Char('i')) => insert(&mut p),
        (None, KeyCode::Char('a')) => { p.cursor = (at + 1).min(n); insert(&mut p) }
        (None, KeyCode::Char('I')) => { p.cursor = 0; insert(&mut p) }
        (None, KeyCode::Char('A')) => { p.cursor = n; insert(&mut p) }
        (None, KeyCode::Char('h')) | (None, KeyCode::Left) => p.cursor = at.saturating_sub(1),
        (None, KeyCode::Char('l')) | (None, KeyCode::Right) => p.cursor = (at + 1).min(n.saturating_sub(1)),
        (None, KeyCode::Char('0')) | (None, KeyCode::Home) => p.cursor = 0,
        (None, KeyCode::Char('^')) => p.cursor = chars.iter().position(|c| *c != ' ').unwrap_or(0),
        (None, KeyCode::Char('$')) | (None, KeyCode::End) => p.cursor = n.saturating_sub(1),
        (None, KeyCode::Char('w')) => p.cursor = word_right(at).min(n.saturating_sub(1)),
        (None, KeyCode::Char('b')) => p.cursor = word_left(at),
        (None, KeyCode::Char('e')) => p.cursor = word_end(at),
        (None, KeyCode::Char('x')) => { if at < n { let mut v = chars.clone(); v.remove(at); let l = v.len(); set(&mut p, v, at.min(l.saturating_sub(1))) } }
        (None, KeyCode::Char('X')) => { if at > 0 { let mut v = chars.clone(); v.remove(at - 1); set(&mut p, v, at - 1) } }
        (None, KeyCode::Char('D')) => { let v = chars[..at].to_vec(); set(&mut p, v, at.saturating_sub(1)) }
        (None, KeyCode::Char('C')) => { let v = chars[..at].to_vec(); set(&mut p, v, at); insert(&mut p) }
        (None, KeyCode::Char('S')) => { set(&mut p, Vec::new(), 0); insert(&mut p) }
        (None, KeyCode::Char(op @ ('d' | 'c' | 'r'))) => p.vi_pending = Some(op),
        (None, KeyCode::Char('k')) | (None, KeyCode::Up) => { if matches!(p.kind, PromptKind::Command { template: None }) { prompt_history(app, &mut p, true) } }
        (None, KeyCode::Char('j')) | (None, KeyCode::Down) => { if matches!(p.kind, PromptKind::Command { template: None }) { prompt_history(app, &mut p, false) } }
        (None, KeyCode::Char('p')) => { if let Some(b) = app.buffers.first() { let mut v = chars.clone(); let ins: Vec<char> = b.chars().filter(|c| *c != '\n').collect(); let k = ins.len(); for (i, c) in ins.into_iter().enumerate() { v.insert((at + 1 + i).min(v.len()), c) } set(&mut p, v, at + k) } }
        _ => {}
    }
    app.modal = Some(Modal::Prompt(p));
}

/// fzf's keys: ↑ C-k C-p away from the prompt, ↓ C-j C-n toward it (the list reads bottom-up);
/// Tab marks; C-t/C-x/C-v open in a new window / below / beside (fzf.vim); C-/ the preview.
fn picker_key(app: &mut App, key: KeyEvent, kind: PickerKind, mut picker: Picker) {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    // Inside a machine or a project, esc (or ⌫ on an empty query) steps back out to the list
    // it was chosen from; anywhere else it closes.
    let scoped = matches!(kind, PickerKind::Open { machine: Some(_), .. } | PickerKind::Open { project: Some(_), .. });
    let back_key = key.code == KeyCode::Esc || (key.code == KeyCode::Backspace && picker.query.is_empty());
    if scoped && back_key {
        let prefix = if matches!(kind, PickerKind::Open { project: Some(_), .. }) { "#" } else { "@" };
        app.modal = None;
        launch(app, prefix, Filter::All);
        return;
    }
    let before = picker.query.clone();
    let page = (picker.page_rows.get() - 1).max(1);
    let multi = matches!(kind, PickerKind::Open { .. }) && !picker.query.starts_with(['>', '@', '#', ':', '*', '?']);
    let up: i64 = if theme::fzf().reverse { -1 } else { 1 };
    // FZF_DEFAULT_OPTS --bind: your key:action pairs come first.
    let name = fzf_key_name(&key);
    // The last bind for a key wins, as in fzf; an action this list does not know leaves the key
    // to its own meaning.
    let bound = theme::fzf_opts().binds.iter().rev().find(|(k, _)| *k == name).map(|(_, a)| a.clone());
    const KNOWN: &[&str] = &["up", "down", "page-up", "page-down", "half-page-up", "half-page-down", "first", "last", "top", "toggle", "toggle+down", "toggle+up", "toggle-in", "toggle-out",
        "select-all", "deselect-all", "toggle-all", "toggle-preview", "preview-up", "preview-down", "preview-page-up", "preview-page-down", "preview-half-page-up", "preview-half-page-down",
        "preview-top", "preview-bottom", "clear-query", "backward-kill-word", "kill-word", "unix-line-discard", "unix-word-rubout", "kill-line", "beginning-of-line", "end-of-line",
        "backward-char", "forward-char", "backward-word", "forward-word", "backward-delete-char", "delete-char", "delete-char/eof", "yank", "accept", "accept-non-empty", "abort", "cancel", "ignore"];
    let bound = bound.filter(|a| a.split('+').all(|x| KNOWN.contains(&x) || x == "toggle" || x == "down" || x == "up"));
    if let Some(actions) = bound {
        let half = (page / 2).max(1);
        for action in actions.split('+') {
            match action {
                "half-page-up" => picker.move_by(half * up), "half-page-down" => picker.move_by(-half * up),
                "top" => picker.move_by(-(picker.visible.len() as i64)),
                "toggle-in" => { picker.toggle_mark(); picker.move_by(if theme::fzf().reverse { 1 } else { -1 }) }
                "toggle-out" => { picker.toggle_mark(); picker.move_by(if theme::fzf().reverse { -1 } else { 1 }) }
                "preview-page-up" | "preview-half-page-up" => picker.preview_scroll = picker.preview_scroll.saturating_sub(if action == "preview-page-up" { 10 } else { 5 }),
                "preview-page-down" | "preview-half-page-down" => picker.preview_scroll = picker.preview_scroll.saturating_add(if action == "preview-page-down" { 10 } else { 5 }).min(picker.preview_max.get()),
                "preview-top" => picker.preview_scroll = 0, "preview-bottom" => picker.preview_scroll = picker.preview_max.get(),
                "unix-word-rubout" => picker.backspace(true), "kill-line" => { let q: String = picker.query.chars().take(picker.qcursor).collect(); picker.set_query(&q) }
                "backward-char" => picker.qmove(-1, false), "forward-char" => picker.qmove(1, false),
                "backward-word" => picker.qmove(-1, true), "forward-word" => picker.qmove(1, true),
                "backward-delete-char" => picker.backspace(false), "delete-char" => picker.delete_forward(),
                "delete-char/eof" => { if picker.query.is_empty() { SPLIT.with(|s| s.set(None)); return } picker.delete_forward() }
                "yank" => picker.yank(), "ignore" => {}
                "accept-non-empty" => { if !picker.visible.is_empty() { choose(app, kind, picker, Choice::Enter); return } }
                "up" => picker.move_by(up), "down" => picker.move_by(-up),
                "page-up" => picker.move_by(page * up), "page-down" => picker.move_by(-page * up),
                "first" => { picker.move_by(-(picker.visible.len() as i64)) } "last" => { picker.move_by(picker.visible.len() as i64) }
                "toggle" => picker.toggle_mark(),
                "select-all" => { if multi { picker.marked = picker.visible.iter().map(|(i, _)| picker.rows[*i].id.clone()).collect() } }
                "deselect-all" => picker.marked.clear(),
                "toggle-all" => { if multi { let all: Vec<String> = picker.visible.iter().map(|(i, _)| picker.rows[*i].id.clone()).collect(); for id in all { if let Some(at) = picker.marked.iter().position(|m| *m == id) { picker.marked.remove(at); } else { picker.marked.push(id) } } } }
                "toggle-preview" => picker.preview = !picker.preview,
                "preview-up" => picker.preview_scroll = picker.preview_scroll.saturating_sub(1),
                "preview-down" => picker.preview_scroll = picker.preview_scroll.saturating_add(1).min(picker.preview_max.get()),
                "clear-query" => picker.set_query(""),
                "backward-kill-word" => picker.kill_word(false), "kill-word" => picker.kill_word(true), "unix-line-discard" => picker.clear_query(),
                "beginning-of-line" => picker.qhome(), "end-of-line" => picker.qend(),
                "accept" => { choose(app, kind, picker, Choice::Enter); return }
                "abort" | "cancel" => { SPLIT.with(|s| s.set(None)); return }
                _ => {}
            }
        }
        app.modal = Some(Modal::Picker { kind, picker });
        return;
    }
    match key.code {
        KeyCode::Esc => { SPLIT.with(|s| s.set(None)); return }
        KeyCode::Char('c' | 'g' | 'q') if ctrl => { SPLIT.with(|s| s.set(None)); return }
        KeyCode::Up if shift => picker.preview_scroll = picker.preview_scroll.saturating_sub(1),
        KeyCode::Down if shift => picker.preview_scroll = picker.preview_scroll.saturating_add(1).min(picker.preview_max.get()),
        // Up is toward the top of the screen: further down the list, unless it is reversed.
        KeyCode::Up => picker.move_by(up),
        KeyCode::Down => picker.move_by(-up),
        KeyCode::Char('k' | 'p') if ctrl => picker.move_by(up),
        KeyCode::Char('j' | 'n') if ctrl => picker.move_by(-up),
        KeyCode::PageUp => picker.move_by(page * up),
        KeyCode::PageDown => picker.move_by(-page * up),
        // fzf: C-d on an empty query closes the list; C-l redraws (no link here).
        KeyCode::Char('d') if ctrl && picker.query.is_empty() => { SPLIT.with(|s| s.set(None)); return }
        KeyCode::Char('l') if ctrl => { app.redraw_all = true }
        // fzf --multi, in the harness lists only: Tab marks and moves down (toward the prompt).
        KeyCode::Tab if multi => { picker.toggle_mark(); picker.move_by(-up) }
        KeyCode::BackTab if multi => { picker.toggle_mark(); picker.move_by(up) }
        KeyCode::Backspace if alt => picker.kill_word(false),
        KeyCode::Backspace => picker.backspace(false),
        KeyCode::Char('d') if alt => picker.kill_word(true),
        KeyCode::Char('y') if ctrl => picker.yank(),
        KeyCode::Char('h') if ctrl => picker.backspace(false),
        KeyCode::Delete => picker.delete_forward(),
        KeyCode::Char('d') if ctrl => picker.delete_forward(),
        KeyCode::Char('u') if ctrl => picker.clear_query(),
        KeyCode::Char('w') if ctrl => picker.backspace(true),
        KeyCode::Left => picker.qmove(-1, false),
        KeyCode::Right => picker.qmove(1, false),
        KeyCode::Char('b') if ctrl => picker.qmove(-1, false),
        KeyCode::Char('f') if ctrl => picker.qmove(1, false),
        KeyCode::Char('b') if alt => picker.qmove(-1, true),
        KeyCode::Char('f') if alt => picker.qmove(1, true),
        KeyCode::Char('a') if ctrl => picker.qhome(),
        KeyCode::Char('e') if ctrl => picker.qend(),
        KeyCode::Home => picker.qhome(),
        KeyCode::End => picker.qend(),
        KeyCode::Char('/' | '_' | '7') if ctrl => { picker.preview = !picker.preview; picker.preview_scroll = 0 }
        KeyCode::Char(c @ '1'..='9') if alt => { answer_from(app, &kind, &mut picker, c as usize - '1' as usize) }
        KeyCode::Char('p') if alt => { choose(app, kind, picker, Choice::Pause); return }
        KeyCode::Enter if alt => { choose(app, kind, picker, Choice::Here); return }
        KeyCode::Enter => { choose(app, kind, picker, Choice::Enter); return }
        KeyCode::Char('t') if ctrl => { choose(app, kind, picker, Choice::Tab); return }
        KeyCode::Char('v') if ctrl => { choose(app, kind, picker, Choice::SplitRight); return }
        KeyCode::Char('x') if ctrl => { choose(app, kind, picker, Choice::SplitDown); return }
        KeyCode::Char('s') if ctrl => { choose(app, kind, picker, Choice::SplitDown); return }
        KeyCode::Char('o') if ctrl => { choose(app, kind, picker, Choice::Open); return }
        KeyCode::Char('l') if alt => { choose(app, kind, picker, Choice::Link); return }
        KeyCode::Char('n') if alt => { choose(app, kind, picker, Choice::New); return }
        KeyCode::Char('i') if alt => { if let PickerKind::Store = kind { return store_install(app, kind, picker) } }
        KeyCode::Char(c) if !ctrl && !alt => picker.type_char(c),
        _ => {}
    }
    let mut kind = kind;
    if picker.query != before {
        // Marks belong to one list: switching scope (> commands, @ machines…) drops them.
        let scope = |q: &str| q.chars().next().filter(|c| ['>', '@', '#', ':', '*', '?'].contains(c));
        if scope(&picker.query) != scope(&before) { picker.marked.clear() }
        let (next, changed) = remode(app, kind, &mut picker);
        kind = next;
        if changed { prepare(app, &kind); fill(app, &kind, &mut picker) }
    }
    if matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) { if let Some(id) = picker.current_id() { ensure_recent(app, &id) } }
    app.modal = Some(Modal::Picker { kind, picker });
}

/// Copy mode, `mode-keys vi`: tmux's copy-mode-vi table.
/// $VISUAL / $EDITOR names vi (or is unset — vim is family here): copy mode's default keys.
fn vi_editor() -> bool {
    let editor = std::env::var("VISUAL").or_else(|_| std::env::var("EDITOR")).unwrap_or_default();
    editor.is_empty() || editor.contains("vi")
}

/// copy-mode's emacs table, as the vi one it mirrors (`set -g mode-keys emacs`, or tmux's own
/// choice when EDITOR is not vi).
fn emacs_copy(key: KeyEvent) -> Option<KeyEvent> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let k = |c: char| KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE);
    let code = |c: KeyCode| KeyEvent::new(c, KeyModifiers::NONE);
    Some(match key.code {
        KeyCode::Char('f') if ctrl => k('l'), KeyCode::Char('b') if ctrl => k('h'),
        KeyCode::Char('n') if ctrl => k('j'), KeyCode::Char('p') if ctrl => k('k'),
        KeyCode::Char('a') if ctrl => k('0'), KeyCode::Char('e') if ctrl => k('$'),
        KeyCode::Char('v') if ctrl => code(KeyCode::PageDown), KeyCode::Char('v') if alt => code(KeyCode::PageUp),
        KeyCode::Char(' ') if ctrl => k('v'), KeyCode::Char('@') if ctrl => k('v'),
        KeyCode::Char('w') if alt => k('y'), KeyCode::Char('w') if ctrl => k('y'),
        KeyCode::Char('f') if alt => k('w'), KeyCode::Char('b') if alt => k('b'),
        KeyCode::Char('<') if alt => k('g'), KeyCode::Char('>') if alt => k('G'),
        KeyCode::Char('s') if ctrl => k('/'), KeyCode::Char('r') if ctrl => k('?'),
        KeyCode::Char('g') if ctrl => code(KeyCode::Esc),
        KeyCode::Esc => k('q'),
        KeyCode::Char('q') | KeyCode::Up | KeyCode::Down | KeyCode::Left | KeyCode::Right | KeyCode::PageUp | KeyCode::PageDown | KeyCode::Enter => key,
        KeyCode::Char('n') => k('n'), KeyCode::Char('N') => k('N'),
        _ => return None,
    })
}

/// `send -X <action>` from a copy-mode binding, as the key that does it here.
fn copy_action_key(action: &str) -> Option<KeyEvent> {
    let k = |c: char| KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE);
    let c = |c: char| KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL);
    let code = |x: KeyCode| KeyEvent::new(x, KeyModifiers::NONE);
    Some(match action {
        "begin-selection" => k(' '), "select-line" => k('V'), "rectangle-toggle" | "rectangle-on" => c('v'),
        a if a.starts_with("copy-selection") || a.starts_with("copy-pipe") || a == "copy-end-of-line" => k('y'),
        "cancel" => k('q'), "clear-selection" => code(KeyCode::Esc),
        "cursor-up" => k('k'), "cursor-down" => k('j'), "cursor-left" => k('h'), "cursor-right" => k('l'),
        "start-of-line" => k('0'), "end-of-line" => k('$'), "back-to-indentation" => k('^'),
        "top-line" => k('H'), "middle-line" => k('M'), "bottom-line" => k('L'), "history-top" => k('g'), "history-bottom" => k('G'),
        "page-up" => code(KeyCode::PageUp), "page-down" => code(KeyCode::PageDown), "halfpage-up" => c('u'), "halfpage-down" => c('d'),
        "scroll-up" => c('y'), "scroll-down" => c('e'),
        "next-word" | "next-space" => k('w'), "previous-word" | "previous-space" => k('b'), "next-word-end" | "next-space-end" => k('e'),
        "search-forward" | "search-forward-incremental" => k('/'), "search-backward" | "search-backward-incremental" => k('?'),
        "search-again" => k('n'), "search-reverse" => k('N'), "next-paragraph" => k('}'), "previous-paragraph" => k('{'),
        "next-matching-bracket" => k('%'), "jump-again" => k(';'), "jump-reverse" => k(','), "toggle-position" => k('P'),
        "append-selection-and-cancel" => k('A'), "copy-pipe-end-of-line-and-cancel" | "copy-end-of-line-and-cancel" => k('D'),
        "refresh-from-pane" => k('r'), "select-word" => k('w'),
        _ => return None,
    })
}

fn copy_key(app: &mut App, key: KeyEvent, pane: u64) {
    let emacs = app.opts.mode_keys_emacs.unwrap_or_else(|| !vi_editor());
    // Your tmux.conf's copy-mode bindings come first (`bind -T copy-mode-vi v send -X begin-selection`).
    if app.copy_pending.is_none() {
        let chord = keys::of(&key);
        let table = if emacs { &app.keymap.copy_emacs } else { &app.keymap.copy_vi };
        if let Some(b) = table.iter().find(|b| b.chord == chord).cloned() {
            let words: Vec<&str> = b.command.split_whitespace().collect();
            let is_send = matches!(words.first(), Some(&"send" | &"send-keys")) && words.contains(&"-X");
            if is_send {
                let action = words.iter().skip_while(|w| **w != "-X").nth(1).copied().unwrap_or("");
                // copy-pipe[-and-cancel] "cmd": the copied text goes to that command too.
                if action.starts_with("copy-pipe") {
                    let parts = crate::commands::split(&b.command).into_iter().next().unwrap_or_default();
                    let cmd = parts.iter().skip_while(|w| *w != "-X").nth(2).cloned();
                    app.copy_pipe = cmd.filter(|c| !c.is_empty());
                }
                if let Some(k) = copy_action_key(action) {
                    // Run it as the vi key it is (no second lookup: the table is not asked again).
                    let saved = std::mem::take(&mut app.keymap.copy_vi);
                    let saved_e = std::mem::take(&mut app.keymap.copy_emacs);
                    let was = app.opts.mode_keys_emacs;
                    app.opts.mode_keys_emacs = Some(false);
                    copy_key(app, k, pane);
                    app.opts.mode_keys_emacs = was;
                    app.keymap.copy_vi = saved;
                    app.keymap.copy_emacs = saved_e;
                } else { app.say(format!("{action}: not a copy-mode action here"), theme::WARN); app.modal = Some(Modal::Copy { pane }) }
            } else {
                // Any other command (select-pane -L): copy mode ends where tmux's would lose focus.
                let before = app.focused();
                commands::execute(app, &b.command);
                if app.focused() == before && app.modal.is_none() { app.modal = Some(Modal::Copy { pane }) }
            }
            return;
        }
    }
    let key = if emacs { match emacs_copy(key) { Some(k) => k, None => { app.modal = Some(Modal::Copy { pane }); return } } } else { key };
    // f/F/t/T wait for their character.
    if let Some(kind) = app.copy_pending.take() {
        if let KeyCode::Char(c) = key.code {
            let n = std::mem::take(&mut app.copy_count).max(1);
            app.copy_last_find = Some((kind, c));
            if let Some(p) = app.panes.get_mut(&pane) { for _ in 0..n { p.copy_find_char(c, matches!(kind, 'f' | 't'), matches!(kind, 't' | 'T')); } }
        }
        app.modal = Some(Modal::Copy { pane });
        return;
    }
    // A count: 5k, 3w.
    if let KeyCode::Char(d @ '0'..='9') = key.code {
        if key.modifiers.is_empty() && (d != '0' || app.copy_count > 0) { app.copy_count = (app.copy_count * 10 + (d as usize - '0' as usize)).min(9999); app.modal = Some(Modal::Copy { pane }); return }
    }
    let count = std::mem::take(&mut app.copy_count);
    if count > 1 && matches!(key.code, KeyCode::Char('h' | 'j' | 'k' | 'l' | 'w' | 'b' | 'e' | 'W' | 'B' | 'E' | 'n' | 'N' | ';' | ',' | '{' | '}') | KeyCode::Up | KeyCode::Down | KeyCode::Left | KeyCode::Right) {
        // Each run puts copy mode back (or leaves it, as the key says); the next run needs it there.
        for _ in 0..count { if !matches!(app.modal, None | Some(Modal::Copy { .. })) { break } app.modal = None; copy_key(app, key, pane); if app.modal.is_none() { break } app.modal = None }
        if app.panes.get(&pane).map(|p| p.copy.is_some()).unwrap_or(false) { app.modal = Some(Modal::Copy { pane }) }
        return;
    }
    match key.code {
        KeyCode::Char(c @ ('f' | 'F' | 't' | 'T')) if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT => { app.copy_pending = Some(c); app.copy_count = count; app.modal = Some(Modal::Copy { pane }); return }
        KeyCode::Char(c @ (';' | ',')) => {
            if let Some((kind, ch)) = app.copy_last_find {
                let forward = matches!(kind, 'f' | 't') == (c == ';');
                if let Some(p) = app.panes.get_mut(&pane) { p.copy_find_char(ch, forward, matches!(kind, 't' | 'T')); }
            }
            app.modal = Some(Modal::Copy { pane });
            return;
        }
        KeyCode::Char('%') => { if let Some(p) = app.panes.get_mut(&pane) { p.copy_match_bracket() } app.modal = Some(Modal::Copy { pane }); return }
        KeyCode::Char('{') => { if let Some(p) = app.panes.get_mut(&pane) { p.copy_paragraph(false) } app.modal = Some(Modal::Copy { pane }); return }
        KeyCode::Char('}') => { if let Some(p) = app.panes.get_mut(&pane) { p.copy_paragraph(true) } app.modal = Some(Modal::Copy { pane }); return }
        _ => {}
    }
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let Some(p) = app.panes.get_mut(&pane) else { return };
    let rows = p.rows as i32;
    let half = (rows / 2).max(1);
    match key.code {
        KeyCode::Char('q') => { p.copy_end(); return }
        KeyCode::Char('c') if ctrl => { p.copy_end(); return }
        // Escape clears the selection and stays (tmux's copy-mode-vi); q leaves.
        KeyCode::Esc => { if p.copy.map(|c| c.selecting).unwrap_or(false) { p.copy_toggle(false) } }
        KeyCode::Char('h') | KeyCode::Left if !ctrl => p.copy_move(-1, 0),
        KeyCode::Char('l') | KeyCode::Right => p.copy_move(1, 0),
        KeyCode::Char('k') | KeyCode::Up if !ctrl => p.copy_move(0, -1),
        KeyCode::Char('j') | KeyCode::Down if !ctrl => p.copy_move(0, 1),
        KeyCode::Char('u') if ctrl => p.copy_move(0, -half),
        KeyCode::Char('d') if ctrl => p.copy_move(0, half),
        KeyCode::Char('b') if ctrl => p.copy_move(0, -rows),
        KeyCode::Char('f') if ctrl => p.copy_move(0, rows),
        KeyCode::Char('y') if ctrl => p.copy_move(0, -1),
        KeyCode::Char('e') if ctrl => p.copy_move(0, 1),
        // tmux's copy-mode-vi, key for key: v / C-v rectangle-toggle, Space begin-selection.
        KeyCode::Char('v') if ctrl => p.copy_rect_toggle(),
        KeyCode::Char('h') if ctrl => p.copy_move(-1, 0),
        KeyCode::Backspace => p.copy_move(-1, 0),
        KeyCode::PageUp => p.copy_move(0, -rows),
        KeyCode::PageDown => p.copy_move(0, rows),
        KeyCode::Up if ctrl => p.copy_scroll(1),
        KeyCode::Down if ctrl => p.copy_scroll(-1),
        KeyCode::Char('K') => p.copy_scroll(1),
        KeyCode::Char('J') => p.copy_scroll(-1),
        KeyCode::Char('z') => p.copy_scroll_middle(),
        KeyCode::Char('o') => p.copy_other_end(),
        KeyCode::Char('X') => p.copy_set_mark(),
        KeyCode::Char('x') if key.modifiers.contains(KeyModifiers::ALT) => p.copy_jump_mark(),
        KeyCode::Char('P') => { p.copy_hide_position = !p.copy_hide_position; p.dirty = true }
        KeyCode::Char('r') => p.dirty = true,
        KeyCode::Char('#') | KeyCode::Char('*') => {
            // The word under the cursor, searched for up (#) or down (*).
            let word = p.copy_word_here();
            if word.is_empty() { app.modal = Some(Modal::Copy { pane }); return }
            let up = key.code == KeyCode::Char('#');
            if p.find(&word, up, true) { if let Some(m) = p.find_at.clone() { p.copy_jump(*m.start()) } }
            app.last_search = Some(word);
            app.last_search_up = up;
        }
        KeyCode::Char(':') => {
            app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Command { template: Some(format!("send-keys -X -t %{pane} goto-line \"%%\"")) }, "(goto line) ", "")));
            return;
        }
        KeyCode::Char('D') => {
            p.copy_select_to_eol();
            let text = p.selection_text();
            p.copy_end();
            if let Some(text) = text { crate::clipboard::store(&text); app.buffers.insert(0, text) }
            return;
        }
        KeyCode::Char('A') => {
            // append-selection-and-cancel: onto the newest buffer.
            let text = p.selection_text();
            p.copy_end();
            if let Some(text) = text {
                match app.buffers.first_mut() { Some(b) => b.push_str(&text), None => app.buffers.insert(0, text.clone()) }
                if let Some(b) = app.buffers.first() { crate::clipboard::store(b) }
            }
            return;
        }
        KeyCode::Char('w') => p.copy_word(true),
        KeyCode::Char('b') => p.copy_word(false),
        KeyCode::Char('e') => p.copy_word_end(),
        KeyCode::Char('W') => p.copy_word_by(true, true),
        KeyCode::Char('B') => p.copy_word_by(false, true),
        KeyCode::Char('E') => p.copy_word_end_by(true),
        KeyCode::Char('0') | KeyCode::Home => p.copy_line_edge(false),
        KeyCode::Char('^') => p.copy_first_nonblank(),
        KeyCode::Char('$') | KeyCode::End => p.copy_line_edge(true),
        KeyCode::Char('g') => p.copy_to(true),
        KeyCode::Char('G') => p.copy_to(false),
        KeyCode::Char('H') => p.copy_screen(0),
        KeyCode::Char('M') => p.copy_screen(1),
        KeyCode::Char('L') => p.copy_screen(2),
        KeyCode::Char('v') => p.copy_rect_toggle(),
        KeyCode::Char(' ') => p.copy_begin(),
        KeyCode::Char('V') => p.copy_toggle(true),
        // copy-mode-vi: / searches down, ? up; n goes on the same way, N back (wrapping, as tmux).
        KeyCode::Char('/') | KeyCode::Char('?') => { app.modal = Some(Modal::Find { pane, query: String::new(), found: None, up: key.code == KeyCode::Char('?') }); return }
        KeyCode::Char('n') | KeyCode::Char('N') => {
            if let Some(q) = app.last_search.clone() {
                let up = app.last_search_up == (key.code == KeyCode::Char('n'));
                if p.find(&q, up, false) { if let Some(m) = p.find_at.clone() { p.copy_jump(*m.start()) } } else { app.say(format!("No match: {q}"), theme::WARN) }
            }
        }
        KeyCode::Char('j') if ctrl => { return copy_key(app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE), pane) }
        KeyCode::Char('y') | KeyCode::Enter => {
            let text = p.selection_text();
            p.copy_end();
            if let Some(text) = text {
                crate::clipboard::store(&text);
                // copy-pipe's command, or tmux's copy-command, gets the text on its stdin.
                if let Some(cmd) = app.copy_pipe.take().or_else(|| app.opts.copy_command.clone()) {
                    use std::io::Write;
                    if let Ok(mut child) = std::process::Command::new("sh").arg("-c").arg(&cmd).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn() {
                        if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(text.as_bytes()); }
                        std::thread::spawn(move || { let _ = child.wait(); });
                    }
                }
                app.buffers.insert(0, text);
                app.buffers.truncate(50);
            }
            return;
        }
        _ => {}
    }
    app.modal = Some(Modal::Copy { pane });
}

/// choose-tree -w: j/k (or ↑/↓) move, Enter/l choose, h/← collapse, → expand, x kill, q/Esc leave.
fn tree_key(app: &mut App, key: KeyEvent, mut cursor: usize, mut collapsed: Vec<String>) {
    let rows = crate::ui::tree_rows(app, &collapsed);
    let n = rows.len().max(1);
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => return,
        KeyCode::Char('c' | 'g') if key.modifiers.contains(KeyModifiers::CONTROL) => return,
        KeyCode::Char('j') | KeyCode::Down => cursor = (cursor + 1) % n,
        KeyCode::Char('k') | KeyCode::Up => cursor = (cursor + n - 1) % n,
        KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) => cursor = (cursor + 1) % n,
        KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) => cursor = (cursor + n - 1) % n,
        KeyCode::Char('g') | KeyCode::Home => cursor = 0,
        KeyCode::Char('G') | KeyCode::End => cursor = n - 1,
        KeyCode::Left | KeyCode::Char('h') | KeyCode::Char('-') => {
            if let Some(r) = rows.get(cursor) { let id = app.tabs[r.window].id.clone(); if !collapsed.contains(&id) { collapsed.push(id) } cursor = rows.iter().position(|x| x.window == r.window && x.pane.is_none()).unwrap_or(cursor) }
        }
        KeyCode::Right | KeyCode::Char('+') => { if let Some(r) = rows.get(cursor) { let id = app.tabs[r.window].id.clone(); collapsed.retain(|c| *c != id) } }
        KeyCode::Enter | KeyCode::Char('l') => {
            if let Some(r) = rows.get(cursor) {
                match r.pane { Some(p) => app.focus_pane(r.window, p), None => app.select_tab(r.window) }
            }
            return;
        }
        KeyCode::Char('x') => {
            if let Some(r) = rows.get(cursor) {
                app.modal = Some(match r.pane {
                    Some(p) => { let idx = app.tabs[r.window].panes().iter().position(|x| *x == p).unwrap_or(0) + app.pane_base_index; app.focus_pane(r.window, p); Modal::Confirm { prompt: format!("kill-pane {idx}? (y/n)"), command: "kill-pane".into() } }
                    None => { app.select_tab(r.window); Modal::Confirm { prompt: format!("kill-window {}? (y/n)", app.tabs[r.window].name), command: "kill-window".into() } }
                });
                return;
            }
        }
        // The number in brackets chooses that row, as tmux's tree does ((0) is the session).
        KeyCode::Char(c @ '1'..='9') => {
            if let Some(r) = rows.get(c as usize - '1' as usize) { match r.pane { Some(p) => app.focus_pane(r.window, p), None => app.select_tab(r.window) } return }
        }
        _ => {}
    }
    app.modal = Some(Modal::Tree { cursor: cursor.min(n - 1), collapsed });
}

/// A key as fzf's --bind names it: ctrl-j, alt-a, enter, btab, f1, ctrl-/ …
fn fzf_key_name(key: &KeyEvent) -> String {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let base = match key.code {
        KeyCode::Char(' ') => "space".to_string(), KeyCode::Char(c) => c.to_lowercase().to_string(),
        KeyCode::Enter => "enter".into(), KeyCode::Esc => "esc".into(), KeyCode::Tab => "tab".into(), KeyCode::BackTab => "btab".into(),
        KeyCode::Backspace => "bspace".into(), KeyCode::Delete => "del".into(), KeyCode::Up => "up".into(), KeyCode::Down => "down".into(),
        KeyCode::Left => "left".into(), KeyCode::Right => "right".into(), KeyCode::Home => "home".into(), KeyCode::End => "end".into(),
        KeyCode::PageUp => "pgup".into(), KeyCode::PageDown => "pgdn".into(), KeyCode::F(n) => format!("f{n}"),
        _ => String::new(),
    };
    let upper = matches!(key.code, KeyCode::Char(c) if c.is_uppercase());
    let shift = key.modifiers.contains(KeyModifiers::SHIFT) && !matches!(key.code, KeyCode::Char(_));
    if shift && !ctrl && !alt { return format!("shift-{base}") }
    if alt && !ctrl && key.code == KeyCode::Backspace { return "alt-bs".into() }
    // C-/ arrives as ctrl-/ or as its control character.
    if ctrl && matches!(key.code, KeyCode::Char('/') | KeyCode::Char('7') | KeyCode::Char('_')) { return "ctrl-/".into() }
    match (ctrl, alt) {
        (true, true) => format!("ctrl-alt-{base}"),
        (true, false) => format!("ctrl-{base}"),
        (false, true) => if upper { format!("alt-{}", base.to_uppercase()) } else { format!("alt-{base}") },
        _ => if upper { base.to_uppercase() } else { base },
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Choice { Enter, Tab, SplitRight, SplitDown, Here, Open, Pause, New, Link }

fn split_key(id: &str) -> Option<(String, String)> {
    let (m, a) = id.split_once(':')?;
    Some((m.to_string(), a.split('#').next().unwrap_or(a).to_string()))
}

fn answer_from(app: &mut App, kind: &PickerKind, picker: &mut Picker, option: usize) {
    if !matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) { return }
    let Some((machine, agent)) = picker.current_id().and_then(|id| split_key(&id)) else { return };
    if answer(app, &machine, &agent, option) { picker.say("Answered") }
}

/// Answer an open question with its [option]th choice, from anywhere — no need to open the pane.
fn answer(app: &mut App, machine: &str, agent: &str, option: usize) -> bool {
    let Some(a) = app.fleet.agent(machine, agent) else { return false };
    let Some(q) = a.question.clone() else { return false };
    let Some(choice) = q.options.get(option).cloned() else { return false };
    let session = a.session_id.clone();
    let Some(link) = app.link(machine) else { return false };
    link.send("question_response", json!({ "requestId": q.request_id, "agentId": agent, "sessionId": session, "answers": { q.answer_key: choice } }))
}

fn choose(app: &mut App, kind: PickerKind, mut picker: Picker, choice: Choice) {
    let id = picker.current_id();
    let keep = |app: &mut App, kind: PickerKind, picker: Picker| app.modal = Some(Modal::Picker { kind, picker });
    match kind.clone() {
        PickerKind::Open { .. } => {
            let Some((machine, agent)) = id.as_deref().and_then(split_key) else { return keep(app, kind, picker) };
            let state = app.fleet.agent(&machine, &agent).map(|a| app.fleet.state_of(a));
            if choice == Choice::Pause {
                let paused = state == Some(crate::fleet::State::Paused);
                let Some(link) = app.link(&machine) else { return keep(app, kind, picker) };
                picker.say(if paused { "Resuming…" } else { "Pausing…" });
                let (m, a) = (machine.clone(), agent.clone());
                app.spawn(async move { link.rpc(if paused { "agent_resume" } else { "agent_delete" }, json!({ "agentId": a }), Duration::from_secs(120)).await }, move |app, reply| {
                    if let Err(e) = reply { app.say(format!("{e}"), theme::DANGER) }
                    app.relist(&m);
                });
                return keep(app, kind, picker);
            }
            if state == Some(crate::fleet::State::Offline) { picker.say("That machine is offline"); return keep(app, kind, picker) }
            let split = SPLIT.with(|s| s.take());
            let placement = match (choice, split) {
                (Choice::Tab, _) => Placement::Tab,
                (Choice::SplitRight, _) => Placement::Split(Dir::Horizontal),
                (Choice::SplitDown, _) => Placement::Split(Dir::Vertical),
                (Choice::Here, _) => Placement::Replace,
                (_, Some(dir)) => Placement::Split(dir),
                _ => Placement::Auto(None),
            };
            // fzf --multi: Enter acts on every marked row — the first where asked, the rest beside it.
            let mut targets: Vec<(String, String)> = picker.marked.iter().filter_map(|m| split_key(m)).collect();
            if targets.is_empty() { targets.push((machine.clone(), agent.clone())) }
            for (i, (machine, agent)) in targets.iter().enumerate() {
                let state = app.fleet.agent(machine, agent).map(|a| app.fleet.state_of(a));
                if state == Some(crate::fleet::State::Offline) { continue }
                app.open_agent(machine, agent, if i == 0 { placement.clone() } else { Placement::Auto(None) });
                if state == Some(crate::fleet::State::Paused) {
                    if let Some((_, pane)) = app.find_pane(machine, agent) { app.resume(pane) }
                }
            }
        }
        PickerKind::Inbox => {
            let Some(id) = id else { return keep(app, kind, picker) };
            let Some((machine, agent)) = split_key(&id) else { return };
            let option = id.split('#').nth(1).and_then(|s| s.parse::<usize>().ok());
            match (choice, option) {
                (Choice::Enter, Some(option)) => { if answer(app, &machine, &agent, option) { picker.say("Answered") } return keep(app, kind, picker) }
                _ => app.open_agent(&machine, &agent, Placement::Auto(None)),
            }
        }
        PickerKind::Palette => {
            let Some(id) = id else { return };
            // A command that needs words goes to the prompt with its name typed; the rest run.
            if modal::NEEDS_ARGS.contains(&id.as_str()) { app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Command { template: None }, ":", &format!("{id} ")))) }
            else if is_command(&id) { run(app, &id) } else { commands::execute(app, &id) }
        }
        PickerKind::Messages | PickerKind::Output { .. } => {}
        PickerKind::Keys => { if let Some(id) = id { if let Some((_, command)) = id.split_once('\t') { commands::execute(app, command) } } }
        PickerKind::Buffers => { if let Some(i) = id.and_then(|i| i.parse::<usize>().ok()) { paste_buffer(app, i) } }
        PickerKind::Help => {
            // A prefix row switches the box to that mode; a shortcut row is just a reminder.
            let Some(id) = id else { return keep(app, kind, picker) };
            if let Some(prefix) = id.strip_prefix("mode:") { app.modal = None; launch(app, prefix, Filter::All) }
            else { keep(app, kind, picker) }
        }
        PickerKind::Projects => {
            let Some(id) = id else { return keep(app, kind, picker) };
            let Some((machine, root)) = id.trim_start_matches("proj:").split_once('\t').map(|(m, r)| (m.to_string(), r.to_string())) else { return };
            if choice == Choice::New {
                if app.link(&machine).is_none() { picker.say("That machine is not connected"); return keep(app, kind, picker) }
                load_dsh(app, machine.clone());
                let name = root.rsplit('/').next().unwrap_or(&root).to_string();
                let mut next = Picker::new(format!("new harness · #{name}"), "Claude Code, Codex, a Store harness…");
                let kind = PickerKind::NewWhat { machine, cwd: Some(root) };
                fill(app, &kind, &mut next);
                app.modal = Some(Modal::Picker { kind, picker: next });
                return;
            }
            let kind = PickerKind::Open { filter: Filter::All, machine: Some(machine), project: Some(root) };
            let (title, placeholder) = modal::launcher_title(app, &kind);
            let mut next = Picker::new(title, placeholder);
            next.prefixed = true;
            fill(app, &kind, &mut next);
            app.modal = Some(Modal::Picker { kind, picker: next });
        }
        PickerKind::Models if id.as_deref().map(|i| i.starts_with("grid:")).unwrap_or(false) => {
            let id = id.unwrap();
            let Some((machine, model)) = id.trim_start_matches("grid:").split_once('\t').map(|(m, x)| (m.to_string(), x.to_string())) else { return keep(app, kind, picker) };
            let state = app.local_models.get(&machine).and_then(|l| l.iter().find(|m| m.get("id").and_then(|v| v.as_str()) == Some(model.as_str()))).and_then(|m| m.get("state").and_then(|v| v.as_str())).unwrap_or("available").to_string();
            let running = state == "running" || state == "serving";
            let action = match (choice, running, state.as_str()) {
                (Choice::SplitDown, true, _) => "grid_fleet_model_stop",
                (Choice::Enter, false, "downloaded") => "grid_fleet_model_start",
                (Choice::Enter, false, _) => {
                    // A download is gigabytes: the first Enter asks, the second one means it.
                    if picker.armed.as_deref() != Some(id.as_str()) { picker.armed = Some(id.clone()); picker.say("Enter again to download it"); return keep(app, kind, picker) }
                    "grid_fleet_model_download"
                }
                (_, true, _) => { picker.say("Running — ^S stops it"); return keep(app, kind, picker) }
                _ => return keep(app, kind, picker),
            };
            picker.armed = None;
            let Some(link) = app.link(&machine) else { return keep(app, kind, picker) };
            let label = picker.current().map(|r| r.label.clone()).unwrap_or_default();
            picker.say(match action { "grid_fleet_model_stop" => format!("Stopping {label}…"), "grid_fleet_model_start" => format!("Starting {label}…"), _ => format!("Downloading {label}…") });
            app.spawn(async move { link.rpc(action, json!({ "modelId": model }), Duration::from_secs(600)).await }, move |app, reply| {
                match reply { Ok(_) => app.say(format!("{label}: done"), theme::ONLINE), Err(e) => app.say(format!("{label}: {e}"), theme::DANGER) }
                load_local_models(app);
            });
            return keep(app, kind, picker);
        }
        PickerKind::Models => {
            let Some(model) = id else { return keep(app, kind, picker) };
            let Some((machine, agent)) = focused_agent(app) else { return };
            let Some(link) = app.link(&machine) else { return };
            let label = picker.current().map(|r| r.label.clone()).unwrap_or_default();
            app.say(format!("Switching to {label}…"), theme::SOFT);
            app.spawn(async move { link.rpc("agent_update", json!({ "agentId": agent, "selectedModel": model }), Duration::from_secs(60)).await }, move |app, reply| match reply {
                Ok(reply) => {
                    if let Some(row) = reply.get("agent") { let key = (machine.clone(), row.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string()); let a = crate::fleet::agent_from(&machine, row, app.fleet.agents.get(&key)); app.fleet.agents.insert(key, a); }
                    app.say(format!("Now on {label}"), theme::ONLINE);
                }
                Err(e) => app.say(format!("Could not switch: {e}"), theme::DANGER),
            });
        }
        PickerKind::Layout => {
            if let Some(index) = id.and_then(|i| i.parse::<usize>().ok()) { app.apply_preset(Preset::ALL[index].0) }
        }
        PickerKind::Machines => {
            let Some(machine) = id else { return keep(app, kind, picker) };
            match choice {
                Choice::New => { if app.link(&machine).is_some() { new_what(app, machine) } }
                Choice::Tab => create(app, machine, What { engine: "terminal".into(), dsh: None, label: "Terminal".into() }, None, None),
                Choice::Link => {
                    let name = app.fleet.machine_name(&machine);
                    prompt(app, PromptKind::LinkPassword { machine }, &format!("Link {name}"), "Its remote password (set there with `harness remote-password set`)", "", "", true)
                }
                _ => {
                    let kind = PickerKind::Open { filter: Filter::All, machine: Some(machine), project: None };
                    let (title, placeholder) = modal::launcher_title(app, &kind);
                    let mut next = Picker::new(title, placeholder);
                    next.prefixed = true;
                    fill(app, &kind, &mut next);
                    app.modal = Some(Modal::Picker { kind, picker: next });
                }
            }
        }
        PickerKind::Store => {
            let Some(dsh) = id else { return keep(app, kind, picker) };
            let local = app.fleet.local_id.clone();
            let catalog = app.dsh.get(&local).cloned().unwrap_or_default();
            let row = catalog.iter().find(|r| r.get("id").and_then(|v| v.as_str()) == Some(dsh.as_str())).cloned().unwrap_or_default();
            if row.get("installed").and_then(|v| v.as_bool()) == Some(false) { picker.say("Install it first — ^I"); return keep(app, kind, picker) }
            let engine = row.get("engine").and_then(|v| v.as_str()).unwrap_or("claude").to_string();
            let label = row.get("name").and_then(|v| v.as_str()).unwrap_or(&dsh).to_string();
            create(app, local, What { engine, dsh: Some(dsh), label }, None, None);
        }
        PickerKind::NewMachine => { if let Some(machine) = id { new_what(app, machine) } }
        PickerKind::NewWhat { machine, cwd: preset } => {
            let Some(id) = id else { return keep(app, kind, picker) };
            let what = if let Some(engine) = id.strip_prefix("engine:") {
                What { engine: engine.into(), dsh: None, label: theme::engine_label(engine).into() }
            } else {
                let rest = id.trim_start_matches("dsh:");
                let (dsh, engine) = rest.rsplit_once(':').unwrap_or((rest, "claude"));
                let label = picker.current().map(|r| r.label.clone()).unwrap_or_default();
                What { engine: engine.into(), dsh: Some(dsh.into()), label }
            };
            if what.engine == "terminal" { return create(app, machine, what, preset, None) }
            let name = app.fleet.machine_name(&machine);
            // The folder is already known (chosen from `#`): straight to the first message.
            if let Some(cwd) = preset {
                let label = what.label.clone();
                let hint = format!("on {name} in {cwd}");
                return prompt(app, PromptKind::NewMessage { machine, what, cwd: Some(cwd) }, &format!("New {label} harness"), "First message (optional) — Enter to start", &hint, "", false);
            }
            let mut next = Picker::new(format!("New {} · folder", what.label), "Search folders…");
            let kind = PickerKind::NewFolder { machine: machine.clone(), what };
            fill(app, &kind, &mut next);
            next.status = name;
            app.modal = Some(Modal::Picker { kind, picker: next });
        }
        PickerKind::NewFolder { machine, what } => {
            let Some(id) = id else { return keep(app, kind, picker) };
            let name = app.fleet.machine_name(&machine);
            match id.as_str() {
                "__path" => prompt(app, PromptKind::NewPath { machine, what }, "Folder", &format!("A folder on {name}"), "~ is that machine's home", "~/", false),
                "__new" => {
                    let label = what.label.clone();
                    prompt(app, PromptKind::NewMessage { machine, what, cwd: None }, &format!("New {label} harness"), "First message (optional) — Enter to start", &format!("on {name}, in a new project"), "", false)
                }
                cwd => {
                    let label = what.label.clone();
                    let hint = format!("on {name} in {cwd}");
                    prompt(app, PromptKind::NewMessage { machine, what, cwd: Some(cwd.to_string()) }, &format!("New {label} harness"), "First message (optional) — Enter to start", &hint, "", false)
                }
            }
        }
        PickerKind::Route { text, voice } => {
            let Some((machine, agent)) = id.as_deref().and_then(split_key) else { return keep(app, kind, picker) };
            if let Some(voice) = voice { return crate::dial::send_spoken(app, &voice, &machine, &agent, &text) }
            if let Some(link) = app.link(&machine) {
                link.send("message", json!({ "agentId": agent, "content": text }));
                let name = app.fleet.agent(&machine, &agent).map(|a| a.name.clone()).unwrap_or_default();
                app.say(format!("Sent to {name}"), theme::ONLINE);
            }
        }
    }
}

fn store_install(app: &mut App, kind: PickerKind, mut picker: Picker) {
    let Some(id) = picker.current_id() else { app.modal = Some(Modal::Picker { kind, picker }); return };
    let local = app.fleet.local_id.clone();
    if let Some(link) = app.link(&local) {
        picker.say(format!("Installing {id}…"));
        let (l2, id2) = (local.clone(), id.clone());
        app.spawn(async move { link.rpc("dsh_install", json!({ "id": id2 }), Duration::from_secs(600)).await }, move |app, reply| {
            match reply { Ok(_) => app.say(format!("Installed {id}"), theme::ONLINE), Err(e) => app.say(format!("Install failed: {e}"), theme::DANGER) }
            load_dsh(app, l2);
        });
    }
    app.modal = Some(Modal::Picker { kind, picker });
}

fn submit_prompt(app: &mut App, p: Prompt) {
    let value = p.value.trim().to_string();
    match p.kind {
        // Answered by a key press in prompt_key; nothing to submit.
        PromptKind::Key { .. } => {}
        PromptKind::Command { template } => {
            match template {
                // `%%` (or the end of the template) takes what was typed, as tmux's command-prompt does.
                Some(t) if t.contains("%%") => commands::execute(app, &t.replace("%%", &value)),
                Some(t) => { if !value.is_empty() { commands::execute(app, &format!("{t} {}", quote(&value))) } }
                None => { if !value.is_empty() { commands::execute(app, &value) } }
            }
        }
        PromptKind::RenameTab => { if !value.is_empty() { app.rename_tab(&value) } }
        PromptKind::RenameHarness { machine, agent } => {
            if value.is_empty() { return }
            if let Some(link) = app.link(&machine) {
                app.spawn(async move { link.rpc("agent_update", json!({ "agentId": agent, "name": value }), Duration::from_secs(20)).await }, move |app, r| {
                    if let Err(e) = r { app.say(format!("{e}"), theme::DANGER) } else { app.relist(&machine) }
                });
            }
        }
        PromptKind::NewPath { machine, what } => {
            if value.is_empty() { return }
            let home = app.homes.get(&machine).cloned().unwrap_or_default();
            let cwd = if value == "~" { home } else if let Some(rest) = value.strip_prefix("~/") { format!("{home}/{rest}") } else { value };
            let label = what.label.clone();
            let name = app.fleet.machine_name(&machine);
            let hint = format!("on {name} in {cwd}");
            prompt(app, PromptKind::NewMessage { machine, what, cwd: Some(cwd) }, &format!("New {label} harness"), "First message (optional) — Enter to start", &hint, "", false);
        }
        PromptKind::NewMessage { machine, what, cwd } => create(app, machine, what, cwd, Some(value)),
        PromptKind::Send => {
            if value.is_empty() { return }
            let local = app.fleet.local_id.clone();
            let Some(link) = app.link(&local) else { return };
            app.say("Finding the right harness…", theme::SOFT);
            let text = value.clone();
            app.spawn(async move { link.request("route_task", json!({ "text": text }), Duration::from_secs(60)).await }, move |app, reply| match reply {
                Ok((_, reply)) => {
                    let rows = modal::route_rows(&reply);
                    if rows.is_empty() { app.say(reply.get("reason").and_then(|v| v.as_str()).unwrap_or("No harness fits that").to_string(), theme::MUTED); return }
                    let mut picker = Picker::new(format!("Send: {}", value.chars().take(48).collect::<String>()), "Filter…");
                    picker.keep_order = true;
                    picker.set_rows(rows);
                    picker.hints = vec![("enter", "send")];
        picker.heading = Some(picker.title.clone());
                    app.toast = None;
                    app.modal = Some(Modal::Picker { kind: PickerKind::Route { text: value, voice: None }, picker });
                }
                Err(e) => app.say(format!("Could not route it: {e}"), theme::DANGER),
            });
        }
        PromptKind::Broadcast => {
            if value.is_empty() { return }
            let targets: Vec<(String, String)> = app.tab().panes().iter().filter_map(|id| app.panes.get(id)).map(|p| (p.machine_id.clone(), p.agent_id.clone())).collect();
            for (machine, agent) in &targets { if let Some(link) = app.link(machine) { link.send("message", json!({ "agentId": agent, "content": value })); } }
            app.say(format!("Sent to {} harness{}", targets.len(), if targets.len() == 1 { "" } else { "es" }), theme::ONLINE);
        }
        PromptKind::LinkPassword { machine } => {
            if value.is_empty() { return }
            // The CLI that started us (node + its script), else `harness` on PATH.
            let exe = std::env::var("HARNESS_CLI").unwrap_or_else(|_| "harness".into());
            // Its loader flags and script (tsx in a dev checkout), as the launcher passed them.
            let script: Vec<String> = std::env::var("HARNESS_CLI_ARGS").ok().and_then(|a| serde_json::from_str(&a).ok()).unwrap_or_default();
            let id = machine.clone();
            app.say("Linking…", theme::SOFT);
            app.spawn(async move {
                let run = tokio::process::Command::new(exe).args(script.iter()).args(["link", "connect", &id, "--stdin", "--json"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn();
                match run {
                    Ok(mut child) => {
                        use tokio::io::AsyncWriteExt;
                        if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(format!("{value}\n").as_bytes()).await; }
                        child.wait_with_output().await.map(|o| (o.status.success(), String::from_utf8_lossy(&o.stdout).to_string() + &String::from_utf8_lossy(&o.stderr))).unwrap_or((false, "failed".into()))
                    }
                    Err(e) => (false, e.to_string()),
                }
            }, move |app, (ok, out)| {
                if ok { app.say("Linked", theme::ONLINE); if let Some(m) = app.fleet.machine_mut(&machine) { m.reach = crate::fleet::Reach::Unknown } app.connect(&machine) }
                else {
                    // `--json` answers with {ok, message}; anything else, its first error-looking line.
                    let said = out.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).find_map(|v| v.get("message").or_else(|| v.get("error")).and_then(|m| m.as_str()).map(str::to_string))
                        .or_else(|| out.lines().map(str::trim).find(|l| l.contains('✗') || l.to_lowercase().contains("error")).map(str::to_string))
                        .unwrap_or_else(|| "the link was refused".into());
                    app.say(format!("Could not link: {said}"), theme::DANGER)
                }
            });
        }
    }
}



// ── what the command layer calls ─────────────────────────────────────────────

/// Quote a typed value so it survives the command-line split as one word.
fn quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }

/// Command ids that `run` knows (so `:open` and old configs still work).
pub fn is_command(id: &str) -> bool {
    matches!(id, "open" | "palette" | "projects" | "models" | "inbox" | "machines" | "help" | "layout" | "store" | "new" | "terminal" | "send"
        | "broadcast" | "clone" | "restart" | "pause" | "take" | "rename" | "tab" | "rename-tab" | "close-tab" | "next-tab" | "prev-tab"
        | "split-right" | "split-down" | "close-pane" | "zoom" | "equalize" | "pane-tab" | "copy-mode" | "find" | "tab-left" | "tab-right"
        | "last-tab" | "next-waiting" | "prev-waiting" | "resume-focused" | "last-harness" | "tree" | "info" | "messages" | "keys"
        | "choose-buffer" | "quit")
}

/// The focused pane's title: its harness's name (tmux `#T`).
pub fn focused_title(app: &App) -> String {
    focused_agent(app).and_then(|(m, a)| app.fleet.agent(&m, &a).map(|x| x.name.clone())).unwrap_or_default()
}


/// `paste-buffer`: the buffer, pasted into the pane.
pub fn paste_buffer(app: &mut App, index: usize) {
    let Some(text) = app.buffers.get(index).cloned() else { app.say("no buffers", theme::WARN); return };
    let Some(focus) = app.focused() else { return };
    let live = app.panes.get(&focus).map(|p| p.stream.is_some() && !p.read_only).unwrap_or(false);
    if live { app.send_paste(focus, &text) } else { send_to_focused(app, text.into_bytes()) }
}

/// `send-keys`: words are typed as text, key names (`Enter`, `C-c`, `Up`) as keys.
/// send-keys -X ACTION [ARG]: a copy-mode command on the target pane (tmux's menus and binds
/// use them: history-top, goto-line, search-backward "word", begin-selection …), -N times.
fn send_copy_action(app: &mut App, words: &[String]) {
    let mut target = None;
    let mut count = 1usize;
    let mut rest = Vec::new();
    let mut i = 1;
    while i < words.len() {
        match words[i].as_str() {
            "-t" => { target = words.get(i + 1).cloned(); i += 1 }
            "-N" => { count = words.get(i + 1).and_then(|n| n.parse().ok()).unwrap_or(1); i += 1 }
            w if w.starts_with('-') && w.len() > 1 && rest.is_empty() => {}
            w => rest.push(w.to_string()),
        }
        i += 1;
    }
    let pane = match target { Some(t) => crate::commands::pane_target(app, &t).map(|(_, p)| p), None => app.focused() };
    let Some(pane) = pane else { return };
    let Some(action) = rest.first().cloned() else { return };
    let arg = rest.get(1).cloned().unwrap_or_default();
    let Some(p) = app.panes.get_mut(&pane) else { return };
    if p.copy.is_none() { if action == "cancel" { return } p.copy_start() }
    app.modal = Some(Modal::Copy { pane });
    match action.as_str() {
        "goto-line" => { if let Some(p) = app.panes.get_mut(&pane) { p.copy_goto_line(arg.trim().parse().unwrap_or(0)) } }
        "search-backward" | "search-forward" | "search-backward-text" | "search-forward-text" if !arg.is_empty() => {
            let up = action.starts_with("search-backward");
            if let Some(p) = app.panes.get_mut(&pane) { if p.find(&arg, up, true) { if let Some(m) = p.find_at.clone() { p.copy_jump(*m.start()) } } }
            app.last_search = Some(arg);
            app.last_search_up = up;
        }
        "jump-forward" | "jump-backward" | "jump-to-forward" | "jump-to-backward" if !arg.is_empty() => {
            let c = arg.chars().next().unwrap_or(' ');
            let (fwd, till) = match action.as_str() { "jump-forward" => (true, false), "jump-backward" => (false, false), "jump-to-forward" => (true, true), _ => (false, true) };
            if let Some(p) = app.panes.get_mut(&pane) { for _ in 0..count { p.copy_find_char(c, fwd, till); } }
        }
        "begin-selection" => { if let Some(p) = app.panes.get_mut(&pane) { p.copy_begin() } }
        "rectangle-toggle" => { if let Some(p) = app.panes.get_mut(&pane) { p.copy_rect_toggle() } }
        "other-end" => { if let Some(p) = app.panes.get_mut(&pane) { p.copy_other_end() } }
        "set-mark" => { if let Some(p) = app.panes.get_mut(&pane) { p.copy_set_mark() } }
        "jump-to-mark" => { if let Some(p) = app.panes.get_mut(&pane) { p.copy_jump_mark() } }
        "scroll-middle" => { if let Some(p) = app.panes.get_mut(&pane) { p.copy_scroll_middle() } }
        "scroll-up" | "scroll-down" => { let d = if action == "scroll-up" { 1 } else { -1 }; if let Some(p) = app.panes.get_mut(&pane) { p.copy_scroll(d * count as i32) } }
        a => match copy_action_key(a) {
            Some(k) => { for _ in 0..count { app.modal = None; copy_key(app, k, pane); if app.modal.is_none() { break } } }
            None => app.say(format!("{a}: not a copy-mode command here"), theme::WARN),
        },
    }
}

pub fn send_keys(app: &mut App, words: &[String]) {
    if words.iter().take_while(|w| w.starts_with('-')).any(|w| w == "-X") { return send_copy_action(app, &[vec!["send-keys".to_string()], words.to_vec()].concat()) }
    // send-keys [-lR] [-t target] key …: flags anywhere before the keys, -t takes its target.
    let mut literal = false;
    let mut target = None;
    let mut keys_at = words.len();
    let mut i = 0;
    while i < words.len() {
        match words[i].as_str() {
            "-t" => { target = words.get(i + 1).cloned(); i += 2; continue }
            "-l" => literal = true,
            "-R" | "-M" | "-H" | "-K" | "-F" => {}
            "-N" => { i += 2; continue }
            _ => { keys_at = i; break }
        }
        i += 1;
    }
    let pane = match &target {
        Some(t) => match crate::commands::pane_target(app, t) { Some((_, p)) => p, None => { app.say(format!("can't find pane: {t}"), theme::WARN); return } },
        None => match app.focused() { Some(f) => f, None => return },
    };
    let mode = app.panes.get(&pane).map(|p| p.mode()).unwrap_or(alacritty_terminal::term::TermMode::empty());
    let mut bytes = Vec::new();
    for word in &words[keys_at.min(words.len())..] {
        let key = if literal { None } else { keys::parse(word).ok().filter(|c| word.len() > 1 && (c.mods != KeyModifiers::NONE || !matches!(c.code, KeyCode::Char(_)))) };
        match key {
            Some(chord) => { if let Some(b) = encode_key(&KeyEvent::new(chord.code, chord.mods), mode) { bytes.extend(b) } }
            None => bytes.extend(word.as_bytes()),
        }
    }
    if !bytes.is_empty() { send_to_pane(app, pane, bytes) }
}

/// `new-harness claude @office ~/src/api`: the words `harness new` takes.
pub fn new_harness_from(app: &mut App, args: &str) {
    let mut engine = "claude".to_string();
    let mut machine = app.focused().and_then(|f| app.panes.get(&f)).map(|p| p.machine_id.clone()).unwrap_or(app.fleet.local_id.clone());
    let mut cwd: Option<String> = None;
    for word in args.split_whitespace() {
        if let Some(m) = word.strip_prefix('@') {
            match app.fleet.machines.iter().find(|x| x.name.to_lowercase().starts_with(&m.to_lowercase()) || x.id == m) { Some(x) => machine = x.id.clone(), None => { app.say(format!("no machine called {m}"), theme::WARN); return } }
        } else if word.starts_with('/') || word.starts_with('~') || word.starts_with('.') {
            let home = app.homes.get(&machine).cloned().unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
            cwd = Some(if word == "~" { home } else if let Some(r) = word.strip_prefix("~/") { format!("{home}/{r}") } else { word.to_string() });
        } else { engine = word.to_string() }
    }
    let label = theme::engine_label(&engine).to_string();
    create(app, machine, What { engine, dsh: None, label }, cwd, None);
}

pub fn rename_focused(app: &mut App, name: &str) {
    let Some((machine, agent)) = focused_agent(app) else { return };
    let Some(link) = app.link(&machine) else { return };
    let name = name.to_string();
    app.spawn(async move { link.rpc("agent_update", json!({ "agentId": agent, "name": name }), Duration::from_secs(20)).await }, move |app, r| {
        if let Err(e) = r { app.say(format!("{e}"), theme::DANGER) } else { app.relist(&machine) }
    });
}

pub fn route_task(app: &mut App, text: String) {
    submit_prompt(app, Prompt::status(PromptKind::Send, "", &text));
}

pub fn broadcast(app: &mut App, text: &str) {
    submit_prompt(app, Prompt::status(PromptKind::Broadcast, "", text));
}

pub fn message_focused(app: &mut App, text: &str) {
    if text.trim().is_empty() { return }
    let Some((machine, agent)) = focused_agent(app) else { return };
    if let Some(link) = app.link(&machine) { link.send("message", json!({ "agentId": agent, "content": text })); }
}

/// Fetch a harness's recent asks and recaps for the preview, once (then on each open of the list).
pub fn ensure_recent(app: &mut App, id: &str) {
    let key = id.split('#').next().unwrap_or(id);
    let Some((machine, agent)) = key.split_once(':').map(|(m, a)| (m.to_string(), a.to_string())) else { return };
    if app.recent.contains_key(&(machine.clone(), agent.clone())) { return }
    let Some(link) = app.link(&machine) else { return };
    app.recent.insert((machine.clone(), agent.clone()), serde_json::Value::Null);
    app.spawn(async move { link.rpc("agent_recent", json!({ "agentId": agent, "n": 3 }), Duration::from_secs(15)).await.map(|r| (agent, r)) }, move |app, reply| {
        if let Ok((agent, value)) = reply { app.recent.insert((machine, agent), value); }
    });
}

/// Where choose-tree's cursor starts: on the active pane's row.
fn tree_cursor_now(app: &App) -> usize {
    let rows = crate::ui::tree_rows(app, &[]);
    // The focused pane's row, or (a lone pane has none) its window's.
    rows.iter().position(|r| r.window == app.active && r.pane.is_some() && r.pane == app.focused())
        .or_else(|| rows.iter().position(|r| r.window == app.active && r.pane.is_none())).unwrap_or(0)
}
