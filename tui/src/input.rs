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
use crate::layout::{Dir, Preset, Toward};
use crate::modal::{self, Filter, Modal, PickerKind, Prompt, PromptKind, What};
use crate::pane::{encode_key, encode_mouse, Phase};
use crate::picker::Picker;
use crate::theme;

pub fn handle(app: &mut App, event: CEvent) {
    app.sync_copy_modal();
    match event {
        CEvent::Key(key) if key.kind != KeyEventKind::Release => on_key(app, key),
        CEvent::Paste(text) => on_paste(app, text),
        CEvent::Mouse(mouse) => { if app.mouse { on_mouse(app, mouse) } }
        CEvent::Resize(cols, rows) => { app.size = (cols, rows); app.fit_panes(); crate::commands::notify(app, "client-resized", None, None) }
        // The terminal in front: the dial follows its pane again (and hears it is in front).
        CEvent::FocusGained => { app.terminal_focused = true; crate::dial::announce(app, false); app.announce_focus(); crate::commands::notify(app, "client-focus-in", None, None) }
        CEvent::FocusLost => { app.terminal_focused = false; crate::dial::announce(app, false); crate::commands::notify(app, "client-focus-out", None, None) }
        _ => {}
    }
    app.sync_copy_modal();
    app.release_waiting();
    crate::dial::settle_voice(app);
}

/// Overlays that type text keep every key (tmux's prompt ignores the prefix too).
fn typing(app: &App) -> bool {
    matches!(app.modal, Some(Modal::Prompt(_)) | Some(Modal::Picker { .. }) | Some(Modal::Confirm { .. }) | Some(Modal::Popup { .. }) | Some(Modal::Menu { .. }))
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
            commands::execute_bound(app, &b.command);
            return;
        }
    }
    // After the prefix: the prefix table.
    if app.prefix {
        app.prefix = false;
        if chord == app.keymap.prefix || Some(chord) == app.keymap.prefix2 {
            // `send-prefix`: C-b C-b gives the prefix key to what has the keyboard.
            return send_prefix_key(app, key);
        }
        if let Some(binding) = app.keymap.prefix_command(&chord).cloned() {
            // A list or view on screen gives way to the command, as tmux's choose modes do.
            if matches!(app.modal, Some(Modal::Clock { .. }) | Some(Modal::DisplayPanes { .. }) | Some(Modal::Picker { .. }) | Some(Modal::Tree { .. })) { app.modal = None }
            app.repeat_until = binding.repeat.then(|| Instant::now() + Duration::from_millis(app.keymap.repeat_ms));
            commands::execute_bound(app, &binding.command);
        }
        return;
    }
    // A repeatable key again, inside the repeat window: no prefix needed.
    if let Some(until) = app.repeat_until {
        if Instant::now() < until {
            if let Some(binding) = app.keymap.prefix_command(&chord).filter(|b| b.repeat).cloned() {
                app.repeat_until = Some(Instant::now() + Duration::from_millis(app.keymap.repeat_ms));
                commands::execute_bound(app, &binding.command);
                return;
            }
        }
        app.repeat_until = None;
    }
    // The prefix works over the lists too (they are tmux's choose modes); only a line being typed
    // at the status line keeps it.
    let line_edit = matches!(app.modal, Some(Modal::Prompt(_)) | Some(Modal::Confirm { .. }) | Some(Modal::Popup { .. }) | Some(Modal::Menu { .. }));
    if !line_edit && (chord == app.keymap.prefix || Some(chord) == app.keymap.prefix2) {
        app.prefix = true;
        app.prefix_at = Some(std::time::Instant::now());
        return;
    }
    // A pane in copy mode or view mode: its mode's table first, then root; a key in neither does
    // nothing — it never reaches the pane's program (server_client_key_callback).
    if let Some(Modal::Copy { pane }) = app.modal {
        if mode_key(app, pane, &chord) { return }
        if let Some(binding) = app.keymap.root_command(&chord).cloned() { commands::execute_bound(app, &binding.command) }
        return;
    }
    if !typing(app) {
        if let Some(binding) = app.keymap.root_command(&chord).cloned() { commands::execute_bound(app, &binding.command); return }
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
pub fn send_to_pane(app: &mut App, focus: u64, bytes: Vec<u8>) {
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
    app.tim.touched = std::time::Instant::now();
    // tmux asks the terminal for bare motion only when a pane here wants it (or a menu opened by
    // the mouse): the rest of the motion hn is sent never happened, as far as tmux is concerned.
    if matches!(mouse.kind, MouseEventKind::Moved) {
        let menu = matches!(&app.modal, Some(Modal::Menu(m)) if !m.no_mouse);
        let wanted = app.rects.iter().any(|(id, _)| app.panes.get(id).map(|p| p.mode().contains(alacritty_terminal::term::TermMode::MOUSE_MOTION)).unwrap_or(false));
        if !menu && !wanted { return }
    }
    // hn's lists and prompts keep the mouse as they have it; copy mode and a menu are tmux's.
    if app.modal.is_some() && !matches!(app.modal, Some(Modal::Copy { .. }) | Some(Modal::Menu(_))) { return modal_mouse(app, mouse) }
    crate::mouse::on_event(app, mouse);
}

/// The mouse over hn's lists (the choose modes): the wheel moves the rows, or the preview under
/// it; a click takes a row, a second one opens it; a click outside the box closes it.
fn modal_mouse(app: &mut App, mouse: MouseEvent) {
    match mouse.kind {
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
            let up = matches!(mouse.kind, MouseEventKind::ScrollUp);
            let half = app.size.0 / 2;
            if let Some(Modal::Picker { picker, .. }) = &mut app.modal {
                if picker.preview && mouse.column >= half { picker.preview_by(if up { -1 } else { 1 }) }
                else { let r: i64 = if theme::fzf().reverse { -1 } else { 1 }; picker.move_by(if up { r } else { -r }) }
            }
        }
        MouseEventKind::Down(MouseButton::Left) => {
            let hit = match &mut app.modal { Some(Modal::Picker { picker, .. }) => Some(picker.click(mouse.row)), _ => None };
            match hit {
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
            copy_scroll(app, pane, up, n as u32);
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
            // copy-mode -e, then the view up as the wheel moves it.
            crate::copy::enter(app, id, id, true, false);
            app.sync_copy_modal();
            copy_scroll(app, id, true, n as u32);
        }
        return;
    };
    if live && !bytes.is_empty() { app.send_input(id, &bytes) }
}

/// copy mode's search prompt, as its table opens it: vi's `?` and `/`, emacs's C-r and C-s
/// (incremental).
pub fn search_prompt(app: &mut App, up: bool) {
    let Some(pane) = app.focused() else { return };
    if !app.panes.get(&pane).map(|p| p.in_mode()).unwrap_or(false) { return }
    let (label, cmd) = if up { ("(search up)", "search-backward") } else { ("(search down)", "search-forward") };
    let command = if crate::copy::ctx(app, pane).vi { format!("command-prompt -T search -p \"{label}\" {{ send-keys -X {cmd} \"%%\" }}") }
        else { format!("command-prompt -i -I \"#{{pane_search_string}}\" -T search -p \"{label}\" {{ send-keys -X {cmd}-incremental \"%%\" }}") };
    commands::execute(app, &command);
}

/// The wheel's commands in copy mode (send -X -N n scroll-up / scroll-down).
fn copy_scroll(app: &mut App, pane: u64, up: bool, n: u32) {
    if let Some(m) = app.panes.get_mut(&pane).and_then(|p| p.modes.last_mut()) { m.prefix = n.max(1) }
    crate::copy::command(app, pane, &[if up { "scroll-up" } else { "scroll-down" }.to_string()], false, None);
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
    // Its spinner turns while what it lists is still coming in, as fzf's does while it reads.
    let busy = match kind {
        PickerKind::Store => is_loading(&format!("dsh {}", app.fleet.local_id)),
        PickerKind::NewWhat { machine, .. } | PickerKind::NewFolder { machine, .. } => is_loading(&format!("dsh {machine}")),
        PickerKind::Models => is_loading(&format!("grid {}", modal::models_machine(app))) || focused_agent(app).is_some_and(|(m, a)| is_loading(&format!("models {m} {a}"))),
        _ => false,
    };
    picker.busy = busy.then(|| "loading".to_string());
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
            // (While it loads the spinner turns and the list is blank, as fzf's is while it reads.)
            if catalog.is_empty() { picker.empty = "Nothing in the Store yet.".into() }
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
            // tmux's choose-buffer rows: `name: size bytes: "sample"`, newest first.
            let rows = app.paste.walk().map(|b| {
                crate::picker::Row::new(b.name.clone(), format!("\"{}\"", crate::paste::sample(b))).lead(vec![ratatui::text::Span::styled(format!("{}: {} bytes: ", b.name, b.data.len()), theme::fg(theme::MUTED))])
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
    let mark = loading(format!("grid {machine}"), true);
    app.spawn(async move { link.rpc("grid_fleet_models_list", json!({}), Duration::from_secs(30)).await }, move |app, reply| {
        loading(mark, false);
        if let Ok(reply) = reply { app.local_models.insert(machine, reply.get("models").and_then(|v| v.as_array()).cloned().unwrap_or_default()); }
        refill(app);
    });
}

fn load_models(app: &mut App) {
    load_local_models(app);
    let Some((machine, agent)) = focused_agent(app) else { return };
    let Some(link) = app.link(&machine) else { return };
    let mark = loading(format!("models {machine} {agent}"), true);
    let key = (machine, agent.clone());
    app.spawn(async move { link.rpc("models_list", json!({ "agentId": agent }), Duration::from_secs(20)).await }, move |app, reply| {
        loading(mark, false);
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
        "zoom" => {
            let tab = app.tab_mut();
            if tab.panes().len() > 1 { tab.zoomed = !tab.zoomed; app.fit_panes(); let t = app.active; app.layout_changed(t) } else { app.fit_panes() }
        }
        "equalize" => { if let Some(f) = app.focused() { if let Some(root) = app.tab_mut().root.as_mut() { root.spread_out(f) } } app.fit_panes() }
        "pane-tab" => {
            let Some(f) = app.focused() else { return };
            if app.tab().panes().len() < 2 { return }
            let _ = app.break_pane(f, None, None, false);
        }
        "focus-left" | "focus-right" | "focus-up" | "focus-down" => {
            let toward = match command { "focus-left" => Toward::Left, "focus-right" => Toward::Right, "focus-up" => Toward::Up, _ => Toward::Down };
            app.select_toward(toward, false);
        }
        "grow-left" | "grow-right" | "grow-up" | "grow-down" => {
            let Some(focus) = app.focused() else { return };
            let (dir, delta) = match command { "grow-left" => (Dir::Horizontal, -5), "grow-right" => (Dir::Horizontal, 5), "grow-up" => (Dir::Vertical, -5), _ => (Dir::Vertical, 5) };
            let tab = app.active;
            app.resize_pane(tab, focus, dir, delta);
        }
        "copy-mode" => commands::execute(app, "copy-mode"),
        "find" => { commands::execute(app, "copy-mode"); search_prompt(app, true) }
        "tab-left" => app.move_tab(-1),
        "tab-right" => app.move_tab(1),
        "last-tab" => {
            // session_last: the top of the stack, or tmux's error.
            let at = app.last_tab().and_then(|id| app.tabs.iter().position(|t| &t.id == id));
            match at { Some(index) => app.select_tab(index), None => app.error("no last window") }
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
    /// The lists' loads still out (a catalog, a machine's models), each as many times as asked for.
    static LOADING: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// A load goes out ([on]) or comes back; gives back its name.
fn loading(what: String, on: bool) -> String {
    LOADING.with(|l| { let mut l = l.borrow_mut(); if on { l.push(what.clone()) } else if let Some(i) = l.iter().position(|w| *w == what) { l.remove(i); } });
    what
}

/// Whether a load of [what] is still out.
fn is_loading(what: &str) -> bool { LOADING.with(|l| l.borrow().iter().any(|w| w == what)) }

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
    let mark = loading(format!("dsh {machine}"), true);
    app.spawn(async move {
        let dsh = link.rpc("dsh_list", json!({}), Duration::from_secs(20)).await;
        let home = link.rpc("fs_list_dir", json!({}), Duration::from_secs(20)).await;
        (dsh, home)
    }, move |app, (dsh, home)| {
        loading(mark, false);
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
                // new-window -d: made in the background; back to where you were — never left, as
                // tmux sees it (nothing cleared or raised there). The new window is activity
                // (window_create), flagged as it is not the current one.
                if let Some((back, last)) = app.return_to.take() {
                    if let Some(i) = app.tabs.iter().position(|t| t.id == back) {
                        app.active = i;
                        app.lastw = last;
                        app.home_order.borrow_mut().clear();
                        if let Some(f) = app.tabs[i].focus { app.seen(f) }
                        app.fit_panes();
                    }
                    if let Some((w, _)) = app.find_pane(&machine, id) { app.tabs[w].touch(); app.alert(w, crate::app::ACTIVITY) }
                }
                if let Some((w, pane)) = app.find_pane(&machine, id) {
                    if let Some(p) = app.panes.get_mut(&pane) { p.queued.extend(typed) }
                    // -P: what was made, printed (to the shell waiting on it).
                    if let Some(fmt) = app.print_new.take() {
                        let line: String = crate::format::spans_for_pane(app, &fmt, w, pane, ratatui::style::Style::default()).into_iter().map(|s| s.content.into_owned()).collect();
                        match app.held_reply.take() { Some(tx) => { let _ = tx.send((vec![line], Vec::new(), 0)); } None => app.say(line, theme::WARN) }
                    }
                }
            }
            Err(e) => {
                if let Some(tx) = app.held_reply.take() { let _ = tx.send((Vec::new(), vec![format!("create pane failed: {e}")], 1)); }
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
        Modal::Confirm { command, key: yes, enter_yes, .. } => {
            // tmux: the confirm key (y, or -c's) runs it, Enter too with -y; any other says no.
            if key.code == KeyCode::Char(yes) || (enter_yes && key.code == KeyCode::Enter) { commands::execute(app, &command) }
        }
        Modal::DisplayPanes { .. } => {
            if let KeyCode::Char(c @ '0'..='9') = key.code {
                let n = (c as usize) - ('0' as usize);
                app.select_pane_index(n.saturating_sub(app.pane_base_index));
            }
        }
        Modal::Clock { .. } => {}
        // tmux's menu (menu_key_cb): an item's key chooses it; ↑ k ↓ j move (round the ends,
        // past rules and disabled items), PPage C-b and NPage by five, g Home / G End the first
        // and last, Enter the chosen one, Escape C-c C-g q leave.
        Modal::Menu(mut menu) => {
            let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
            let name = keys::name(&keys::of(&key));
            if let Some(i) = menu.items.iter().position(|it| !it.disabled && !it.separator && !it.key.is_empty() && it.key == name) {
                menu.choice = Some(i);
                return menu_chosen(app, menu);
            }
            let count = menu.items.len() as i64;
            let skip = |menu: &crate::modal::Menu, i: i64| { let it = &menu.items[i as usize]; it.separator || it.disabled };
            let mut choice = menu.choice.map(|c| c as i64).unwrap_or(-1);
            let old = if choice == -1 { 0 } else { choice };
            match key.code {
                KeyCode::Up | KeyCode::Char('k') if !ctrl => loop {
                    choice = if choice == -1 || choice == 0 { count - 1 } else { choice - 1 };
                    if !skip(&menu, choice) || choice == old { break }
                },
                KeyCode::Down | KeyCode::Char('j') if !ctrl => loop {
                    choice = if choice == -1 || choice == count - 1 { 0 } else { choice + 1 };
                    if !skip(&menu, choice) || choice == old { break }
                },
                KeyCode::PageUp => choice = page_up(&menu, choice),
                KeyCode::Char('b') if ctrl => choice = page_up(&menu, choice),
                KeyCode::PageDown => {
                    // (tmux counts its five up, not down: to the last item, as it does.)
                    choice = count - 1;
                    while choice > 0 && skip(&menu, choice) { choice -= 1 }
                }
                KeyCode::Char('g') if !ctrl => { choice = 0; while choice < count - 1 && skip(&menu, choice) { choice += 1 } }
                KeyCode::Home => { choice = 0; while choice < count - 1 && skip(&menu, choice) { choice += 1 } }
                KeyCode::Char('G') | KeyCode::End => { choice = count - 1; while choice > 0 && skip(&menu, choice) { choice -= 1 } }
                KeyCode::Enter => return menu_chosen(app, menu),
                KeyCode::Esc | KeyCode::Char('q') if !ctrl => return,
                KeyCode::Char('c' | 'g') if ctrl => return,
                _ => {}
            }
            menu.choice = (choice >= 0).then_some(choice as usize);
            app.modal = Some(Modal::Menu(menu));
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
        Modal::Copy { pane } => { app.modal = Some(Modal::Copy { pane }); mode_key(app, pane, &keys::of(&key)); }
        Modal::Prompt(p) => prompt_key(app, key, p),
        Modal::Picker { kind, picker } => picker_key(app, key, kind, picker),
    }
}

/// The status-line prompt (status_prompt_key): tmux's `status-keys emacs` — each change runs an
/// incremental prompt's template again; Up/Down its type's history; Tab completes.
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
    // command-prompt -N: digits go in; any other key ends it (the number to the template), and
    // then does what it does as if there had been no prompt.
    if let PromptKind::Command { digits: true, .. } = &p.kind {
        let digit = matches!(key.code, KeyCode::Char(c) if c.is_ascii_digit()) && !ctrl && !alt;
        if !digit {
            submit_prompt(app, p);
            app.sync_copy_modal();
            return on_key(app, key);
        }
    }
    let (single, incremental, ptype) = match &p.kind { PromptKind::Command { one, incremental, ptype, .. } => (*one, *incremental, *ptype), _ => (false, false, 0) };
    // status-keys vi (tmux's default when $EDITOR names vi): Esc leaves insert for normal mode.
    let vi = app.options.get("status-keys", "", None).as_deref() == Some("vi");
    if vi && p.vi_normal { prompt_vi_normal(app, key, p); return }
    if vi && key.code == KeyCode::Esc && !ctrl && !alt { p.vi_normal = true; p.vi_pending = None; app.modal = Some(Modal::Prompt(p)); return }
    let ws = app.options.get("word-separators", "", None).unwrap_or_default();
    let chars: Vec<char> = p.value.chars().collect();
    let size = chars.len();
    let at = p.cursor.min(size);
    let space = |i: usize| chars.get(i) == Some(&' ');
    let in_list = |i: usize| chars.get(i).map(|c| ws.contains(*c)).unwrap_or(false);
    let set = |p: &mut Prompt, v: Vec<char>, c: usize| { p.value = v.into_iter().collect(); p.cursor = c; };
    let (mut changed, mut appended, mut prefix) = (false, false, '=');
    match key.code {
        KeyCode::Esc => return,
        KeyCode::Char('c' | 'g') if ctrl => return,
        KeyCode::Enter => {
            if !p.value.is_empty() && matches!(p.kind, PromptKind::Command { .. }) { add_history(app, ptype, &p.value) }
            // An incremental prompt has done its work as it went.
            if incremental { return }
            submit_prompt(app, p);
            return;
        }
        KeyCode::Backspace | KeyCode::Char('h') if key.code == KeyCode::Backspace || ctrl => {
            if alt {
                let mut from = at;
                while from > 0 && chars[from - 1] == ' ' { from -= 1 }
                while from > 0 && chars[from - 1] != ' ' { from -= 1 }
                let mut v = chars.clone(); v.drain(from..at); set(&mut p, v, from); changed = true;
            } else if at > 0 { let mut v = chars.clone(); v.remove(at - 1); set(&mut p, v, at - 1); changed = true }
            else if p.value.is_empty() && !incremental { return } // backspace on an empty prompt closes it
        }
        KeyCode::Delete => { if at < size { let mut v = chars.clone(); v.remove(at); set(&mut p, v, at); changed = true } }
        KeyCode::Char('d') if ctrl => { if at < size { let mut v = chars.clone(); v.remove(at); set(&mut p, v, at); changed = true } }
        KeyCode::Left if !ctrl => p.cursor = at.saturating_sub(1),
        KeyCode::Char('b') if ctrl => p.cursor = at.saturating_sub(1),
        KeyCode::Right if !ctrl => p.cursor = (at + 1).min(size),
        KeyCode::Char('f') if ctrl => p.cursor = (at + 1).min(size),
        KeyCode::Home => p.cursor = 0,
        KeyCode::Char('a') if ctrl => p.cursor = 0,
        KeyCode::End => p.cursor = size,
        KeyCode::Char('e') if ctrl => p.cursor = size,
        KeyCode::Char('u') if ctrl => { set(&mut p, Vec::new(), 0); changed = true }
        KeyCode::Char('k') if ctrl => { if at < size { let v = chars[..at].to_vec(); set(&mut p, v, at); changed = true } }
        KeyCode::Char('w') if ctrl => {
            // Back over blanks, then over the word (a run of word-separators, or of the rest).
            let mut idx = at;
            while idx != 0 { idx -= 1; if !space(idx) { break } }
            let word_is_separators = in_list(idx);
            while idx != 0 {
                idx -= 1;
                if space(idx) || word_is_separators != in_list(idx) { idx += 1; break }
            }
            p.saved = Some(chars[idx..at].iter().collect());
            let mut v = chars.clone(); v.drain(idx..at); set(&mut p, v, idx); changed = true;
        }
        KeyCode::Right if ctrl => { p.cursor = forward_word(&chars, at, &ws); changed = true }
        KeyCode::Char('f') if alt => { p.cursor = forward_word(&chars, at, &ws); changed = true }
        KeyCode::Left if ctrl => { p.cursor = backward_word(&chars, at, &ws); changed = true }
        KeyCode::Char('b') if alt => { p.cursor = backward_word(&chars, at, &ws); changed = true }
        KeyCode::Up => { if prompt_history(app, &mut p, true) { changed = true } }
        KeyCode::Char('p') if ctrl => { if prompt_history(app, &mut p, true) { changed = true } }
        KeyCode::Down => { if prompt_history(app, &mut p, false) { changed = true } }
        KeyCode::Char('n') if ctrl => { if prompt_history(app, &mut p, false) { changed = true } }
        KeyCode::Char('y') if ctrl => {
            // What C-w cut, else the newest buffer up to its first control character.
            let text: String = match &p.saved { Some(s) => s.clone(), None => match app.paste.top() { Some(b) => b.data.chars().take_while(|c| (*c as u32) > 31 && *c as u32 != 127).collect(), None => String::new() } };
            if !text.is_empty() || p.saved.is_some() || app.paste.top().is_some() {
                let mut v = chars.clone();
                let n = text.chars().count();
                for (i, c) in text.chars().enumerate() { v.insert(at + i, c) }
                set(&mut p, v, at + n);
                changed = true;
            }
        }
        KeyCode::Char('t') if ctrl => {
            let mut idx = at;
            if idx < size { idx += 1 }
            if idx >= 2 { let mut v = chars.clone(); v.swap(idx - 2, idx - 1); set(&mut p, v, idx); changed = true }
        }
        KeyCode::Char('r') if ctrl && incremental => {
            if p.value.is_empty() { prefix = '='; if let PromptKind::Command { last, .. } = &p.kind { let l = last.clone(); let n = l.chars().count(); set(&mut p, l.chars().collect(), n) } } else { prefix = '-' }
            changed = true;
        }
        KeyCode::Char('s') if ctrl && incremental => {
            if p.value.is_empty() { prefix = '='; if let PromptKind::Command { last, .. } = &p.kind { let l = last.clone(); let n = l.chars().count(); set(&mut p, l.chars().collect(), n) } } else { prefix = '+' }
            changed = true;
        }
        KeyCode::Tab if matches!(p.kind, PromptKind::Command { template: None, .. }) => {
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
                changed = true;
            }
        }
        KeyCode::Char(c) if !ctrl && !alt => { let mut v = chars.clone(); v.insert(at, c); set(&mut p, v, at + 1); p.hint.clear(); appended = true; changed = true }
        _ => {}
    }
    // command-prompt -1: the first character typed is the answer.
    if single && appended {
        if p.value.chars().count() != 1 { return }
        submit_prompt(app, p);
        return;
    }
    if changed && incremental { prompt_changed(app, &p, prefix) }
    app.modal = Some(Modal::Prompt(p));
}

/// An incremental prompt's text changed: its template runs with it, after `=` (as typed), `+`
/// (C-s: again, forward) or `-` (C-r: again, back).
pub fn prompt_changed(app: &mut App, p: &Prompt, prefix: char) {
    let PromptKind::Command { template: Some(t), answers, .. } = &p.kind else { return };
    let text = format!("{prefix}{}", p.value);
    let mut all = answers.clone();
    all.push(text);
    let command = all.iter().enumerate().fold(t.clone(), |cmd, (i, a)| crate::commands::template_replace(&cmd, a, i + 1));
    let was = app.modal.take();
    commands::execute(app, &command);
    app.modal = was;
}

/// status_prompt_forward_word (emacs): past blanks, then to the end of the word.
fn forward_word(chars: &[char], at: usize, ws: &str) -> usize {
    let size = chars.len();
    let space = |i: usize| chars.get(i) == Some(&' ');
    let in_list = |i: usize| chars.get(i).map(|c| ws.contains(*c)).unwrap_or(false);
    let mut idx = at;
    while idx != size && space(idx) { idx += 1 }
    if idx == size { return idx }
    let word_is_separators = in_list(idx) && !space(idx);
    loop {
        idx += 1;
        if space(idx) { break }
        if !(idx != size && word_is_separators == in_list(idx)) { break }
    }
    idx
}

/// status_prompt_backward_word: back over blanks, then to the start of the word.
fn backward_word(chars: &[char], at: usize, ws: &str) -> usize {
    let space = |i: usize| chars.get(i) == Some(&' ');
    let in_list = |i: usize| chars.get(i).map(|c| ws.contains(*c)).unwrap_or(false);
    let mut idx = at;
    while idx != 0 { idx -= 1; if !space(idx) { break } }
    let word_is_separators = in_list(idx);
    while idx != 0 {
        idx -= 1;
        if space(idx) || word_is_separators != in_list(idx) { idx += 1; break }
    }
    idx
}

/// status_prompt_add_history: a line onto its type's history (not twice in a row), at most
/// prompt-history-limit of them.
fn add_history(app: &mut App, ptype: usize, line: &str) {
    let limit: usize = app.options.get("prompt-history-limit", "", None).and_then(|v| v.parse().ok()).unwrap_or(100);
    let h = &mut app.history[ptype.min(3)];
    if h.last().map(|l| l == line).unwrap_or(false) { return }
    if limit == 0 { h.clear(); return }
    h.push(line.to_string());
    while h.len() > limit { h.remove(0); }
}

/// status_prompt_up_history / _down_history: the prompt's type's history a step back or on
/// (the step past the newest is an empty line). False when there is nowhere to go.
fn prompt_history(app: &App, p: &mut Prompt, up: bool) -> bool {
    let ptype = match &p.kind { PromptKind::Command { ptype, .. } => *ptype, _ => 0 };
    let h = &app.history[ptype.min(3)];
    let n = h.len();
    let idx = p.history_at.unwrap_or(0);
    if up {
        if n == 0 || idx == n { return false }
        let idx = idx + 1;
        p.history_at = Some(idx);
        p.value = h[n - idx].clone();
    } else {
        if n == 0 || idx == 0 { p.value.clear() } else {
            let idx = idx - 1;
            p.history_at = Some(idx);
            p.value = if idx == 0 { String::new() } else { h[n - idx].clone() };
        }
    }
    p.cursor = p.value.chars().count();
    true
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
            let ptype = match &p.kind { PromptKind::Command { ptype, .. } => *ptype, _ => 0 };
            if !p.value.is_empty() && matches!(p.kind, PromptKind::Command { .. }) { add_history(app, ptype, &p.value) }
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
        (None, KeyCode::Char('k')) | (None, KeyCode::Up) => { prompt_history(app, &mut p, true); }
        (None, KeyCode::Char('j')) | (None, KeyCode::Down) => { prompt_history(app, &mut p, false); }
        (None, KeyCode::Char('p')) => { if let Some(b) = app.paste.top().map(|b| b.data.clone()) { let mut v = chars.clone(); let ins: Vec<char> = b.chars().filter(|c| *c != '\n').collect(); let k = ins.len(); for (i, c) in ins.into_iter().enumerate() { v.insert((at + 1 + i).min(v.len()), c) } set(&mut p, v, at + k) } }
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
    let multi = matches!(kind, PickerKind::Open { .. }) && !picker.query.starts_with(['>', '@', '#', ':', '*', '?']);
    let up: i64 = if theme::fzf().reverse { -1 } else { 1 };
    // FZF_DEFAULT_OPTS --bind: your key:action pairs come first (the last bind for a key wins,
    // as in fzf), and a bound key never falls back to this list's own meaning of it: the actions it
    // knows run, the others do nothing.
    let name = fzf_key_name(&key);
    let bound = theme::fzf_opts().binds.iter().rev().find(|(k, _)| *k == name).map(|(_, a)| a.clone());
    if let Some(actions) = bound {
        match bound_actions(&mut picker, &actions, up, multi) {
            End::Accept => { choose(app, kind, picker, Choice::Enter); return }
            End::Abort => { SPLIT.with(|s| s.set(None)); return }
            End::Stay => {}
        }
    } else {
        match key.code {
            KeyCode::Esc => { SPLIT.with(|s| s.set(None)); return }
            KeyCode::Char('c' | 'g' | 'q') if ctrl => { SPLIT.with(|s| s.set(None)); return }
            KeyCode::Up if shift => picker.preview_by(-1),
            KeyCode::Down if shift => picker.preview_by(1),
            // Up is toward the top of the screen: further down the list, unless it is reversed.
            KeyCode::Up => picker.move_by(up),
            KeyCode::Down => picker.move_by(-up),
            KeyCode::Char('k' | 'p') if ctrl => picker.move_by(up),
            KeyCode::Char('j' | 'n') if ctrl => picker.move_by(-up),
            KeyCode::PageUp => crate::ui::page(&mut picker, up, false),
            KeyCode::PageDown => crate::ui::page(&mut picker, -up, false),
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
            // fzf's: shift-left/right by words; ctrl- and alt-left/right are not bound.
            KeyCode::Left if shift => picker.qmove(-1, true),
            KeyCode::Right if shift => picker.qmove(1, true),
            KeyCode::Left | KeyCode::Right if ctrl || alt => {}
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
            KeyCode::Char('/' | '_' | '7') if ctrl => { picker.preview = !picker.preview; picker.preview_scroll.set(0) }
            // fzf 0.67's alt-/: toggle-wrap (its ctrl-/ too; here C-/ stays the preview's, as fzf's
            // README binds it).
            KeyCode::Char('/') if alt => picker.toggle_wrap(),
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
    }
    let mut kind = kind;
    if picker.query != before {
        // Marks belong to one list: switching scope (> commands, @ machines…) drops them.
        let scope = |q: &str| q.chars().next().filter(|c| ['>', '@', '#', ':', '*', '?'].contains(c));
        if scope(&picker.query) != scope(&before) { picker.marked.clear() }
        let (next, changed) = remode(app, kind, &mut picker);
        kind = next;
        if changed { prepare(app, &kind); fill(app, &kind, &mut picker) }
        // --bind change:…, fzf's event for a query that changed (change:first puts the cursor back
        // on the best match).
        if let Some(actions) = theme::fzf_opts().binds.iter().rev().find(|(k, _)| k == "change").map(|(_, a)| a.clone()) {
            match bound_actions(&mut picker, &actions, up, multi) {
                End::Accept => { choose(app, kind, picker, Choice::Enter); return }
                End::Abort => { SPLIT.with(|s| s.set(None)); return }
                End::Stay => {}
            }
        }
    }
    if matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) { if let Some(id) = picker.current_id() { ensure_recent(app, &id) } }
    app.modal = Some(Modal::Picker { kind, picker });
}

/// server_client_key_callback for a pane in a mode: the binding its table (copy-mode, or
/// copy-mode-vi with mode-keys vi) has for the key runs, the pane its target. False when the
/// table has none.
pub fn mode_key(app: &mut App, pane: u64, chord: &keys::Chord) -> bool {
    let table = if crate::copy::ctx(app, pane).vi { "copy-mode-vi" } else { "copy-mode" };
    match app.keymap.lookup(table, chord) {
        Some(b) => { commands::execute_bound(app, &b.command); true }
        None => false,
    }
}

/// A copied text to a shell command's stdin (copy-pipe, copy-command), not waited for.
pub fn pipe_to(cmd: &str, text: &str) {
    use std::io::Write;
    let mut c = std::process::Command::new("/bin/sh");
    c.arg("-c").arg(cmd).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    c.envs(crate::ipc::job_env());
    if let Ok(mut child) = c.spawn() {
        if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(text.as_bytes()); }
        std::thread::spawn(move || { let _ = child.wait(); });
    }
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
                    Some(p) => { let idx = app.tabs[r.window].panes().iter().position(|x| *x == p).unwrap_or(0) + app.pane_base_index; app.focus_pane(r.window, p); Modal::Confirm { prompt: format!("kill-pane {idx}? (y/n)"), command: "kill-pane".into(), key: 'y', enter_yes: false } }
                    None => { app.select_tab(r.window); Modal::Confirm { prompt: format!("kill-window {}? (y/n)", app.tabs[r.window].name), command: "kill-window".into(), key: 'y', enter_yes: false } }
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

/// What a bound action chain leaves the list to do.
enum End { Stay, Accept, Abort }

/// An fzf action chain (`up+up`, `toggle+down`) split where a `+` is not inside an action's (…).
fn split_chain(actions: &str) -> Vec<String> {
    let (mut depth, mut out, mut cur) = (0i32, Vec::new(), String::new());
    for c in actions.chars() {
        match c { '(' | '[' | '{' => depth += 1, ')' | ']' | '}' => depth -= 1, '+' if depth == 0 => { out.push(std::mem::take(&mut cur)); continue } _ => {} }
        cur.push(c);
    }
    out.push(cur);
    out
}

/// A bound key's (or event's) actions, in order: the ones this list knows, as fzf does them; the
/// others (execute, become, change-prompt …) do nothing.
fn bound_actions(picker: &mut crate::picker::Picker, actions: &str, up: i64, multi: bool) -> End {
    let len = picker.visible.len() as i64;
    for action in split_chain(actions) {
        match action.as_str() {
            "half-page-up" => crate::ui::page(picker, up, true), "half-page-down" => crate::ui::page(picker, -up, true),
            "top" | "first" => picker.move_by(-len), "last" => picker.move_by(len),
            "toggle-in" => { picker.toggle_mark(); picker.move_by(if theme::fzf().reverse { 1 } else { -1 }) }
            "toggle-out" => { picker.toggle_mark(); picker.move_by(if theme::fzf().reverse { -1 } else { 1 }) }
            "preview-page-up" => picker.preview_page(-1, false), "preview-page-down" => picker.preview_page(1, false),
            "preview-half-page-up" => picker.preview_page(-1, true), "preview-half-page-down" => picker.preview_page(1, true),
            "preview-top" => picker.preview_to(0), "preview-bottom" => picker.preview_bottom(),
            "unix-word-rubout" => picker.backspace(true), "kill-line" => picker.kill_line(),
            "backward-char" => picker.qmove(-1, false), "forward-char" => picker.qmove(1, false),
            "backward-word" => picker.qmove(-1, true), "forward-word" => picker.qmove(1, true),
            "backward-delete-char" => picker.backspace(false), "delete-char" => picker.delete_forward(),
            "delete-char/eof" => { if picker.query.is_empty() { return End::Abort } picker.delete_forward() }
            "yank" => picker.yank(),
            "accept-non-empty" => { if !picker.visible.is_empty() { return End::Accept } }
            "accept" => return End::Accept,
            "abort" | "cancel" => return End::Abort,
            "up" => picker.move_by(up), "down" => picker.move_by(-up),
            "page-up" => crate::ui::page(picker, up, false), "page-down" => crate::ui::page(picker, -up, false),
            "toggle" => picker.toggle_mark(),
            "select-all" => { if multi { picker.marked = picker.visible.iter().map(|(i, _)| picker.rows[*i].id.clone()).collect() } }
            "deselect-all" => picker.marked.clear(),
            "toggle-all" => { if multi { let all: Vec<String> = picker.visible.iter().map(|(i, _)| picker.rows[*i].id.clone()).collect(); for id in all { if let Some(at) = picker.marked.iter().position(|m| *m == id) { picker.marked.remove(at); } else { picker.marked.push(id) } } } }
            "toggle-preview" => picker.preview = !picker.preview, "toggle-wrap" => picker.toggle_wrap(),
            "preview-up" => picker.preview_by(-1), "preview-down" => picker.preview_by(1),
            "clear-query" => picker.set_query(""),
            "backward-kill-word" => picker.kill_word(false), "kill-word" => picker.kill_word(true), "unix-line-discard" => picker.clear_query(),
            "beginning-of-line" => picker.qhome(), "end-of-line" => picker.qend(),
            // pos(N): the Nth match (1 the best; -1 the last).
            a if a.starts_with("pos(") && a.ends_with(')') => {
                if let Ok(n) = a[4..a.len() - 1].trim().parse::<i64>() {
                    if n > 0 && len > 0 { picker.move_by(-len); picker.move_by((n - 1).min(len - 1)) }
                    else if n < 0 && len > 0 { picker.move_by(len); picker.move_by(-((-n - 1).min(len - 1))) }
                }
            }
            _ => {}
        }
    }
    End::Stay
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
    let shift = key.modifiers.contains(KeyModifiers::SHIFT) && !matches!(key.code, KeyCode::Char(_) | KeyCode::BackTab);
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
    // fzf's accept with nothing matched: the list goes.
    if id.is_none() && picker.visible.is_empty() && choice == Choice::Enter { SPLIT.with(|s| s.set(None)); return }
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
            if modal::NEEDS_ARGS.contains(&id.as_str()) { app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Command { template: None, more: Vec::new(), answers: Vec::new(), one: false, digits: false, incremental: false, ptype: 0, last: String::new() }, ":", &format!("{id} ")))) }
            else if is_command(&id) { run(app, &id) } else { commands::execute(app, &id) }
        }
        PickerKind::Messages | PickerKind::Output { .. } => {}
        PickerKind::Keys => { if let Some(id) = id { if let Some((_, command)) = id.split_once('\t') { commands::execute_bound(app, command) } } }
        PickerKind::Buffers => { if let Some(name) = id { let name = name.to_string(); paste_buffer(app, &name) } }
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
        PromptKind::Command { template, mut more, mut answers, one, digits, incremental, ptype, last } => {
            // The answer as typed (tmux keeps its spaces); the next prompt, if there is one.
            answers.push(p.value.clone());
            if !more.is_empty() {
                let (label, initial) = more.remove(0);
                app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Command { template, more, answers, one, digits, incremental, ptype, last }, &label, &initial)));
                return;
            }
            // args_make_commands: each answer into the template (cmd_template_replace).
            let command = match template {
                Some(t) => answers.iter().enumerate().fold(t, |cmd, (i, a)| crate::commands::template_replace(&cmd, a, i + 1)),
                None => answers.first().cloned().unwrap_or_default(),
            };
            if !command.trim().is_empty() { commands::execute(app, &command) }
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



/// choose-buffer's pick: that buffer pasted into this pane, as paste-buffer -b does.
pub fn paste_buffer(app: &mut App, name: &str) {
    let Some(text) = app.paste.get(name).map(|b| b.data.clone()) else { return app.say(format!("no buffer {name}"), theme::WARN) };
    let Some(focus) = app.focused() else { return };
    paste_into(app, focus, &text, "\r", false);
}

/// tmux's paste-buffer into a pane: the text's lines joined by `sep` (a carriage return, as Enter
/// types, unless -r or -s say otherwise), in bracketed-paste marks (-p) when the pane's program
/// asked for them; nothing for a pane whose input is off.
pub fn paste_into(app: &mut App, pane: u64, text: &str, sep: &str, bracket: bool) {
    let Some(p) = app.panes.get(&pane) else { return };
    if p.input_off { return }
    let bracket = bracket && p.mode().contains(alacritty_terminal::term::TermMode::BRACKETED_PASTE);
    let mut bytes = Vec::new();
    if bracket { bytes.extend_from_slice(b"\x1b[200~") }
    let mut rest = text;
    while let Some(i) = rest.find('\n') { bytes.extend_from_slice(rest[..i].as_bytes()); bytes.extend_from_slice(sep.as_bytes()); rest = &rest[i + 1..] }
    bytes.extend_from_slice(rest.as_bytes());
    if bracket { bytes.extend_from_slice(b"\x1b[201~") }
    send_to_pane(app, pane, bytes)
}

/// `send-keys`: words are typed as text, key names (`Enter`, `C-c`, `Up`) as keys.
/// send-keys -X ACTION [ARG]: a copy-mode command on the target pane (tmux's menus and binds
/// use them: history-top, goto-line, search-backward "word", begin-selection …), -N times.
/// send -X: a copy-mode command for a pane in copy mode (window_copy_command) — run by a mouse
/// key (not the wheel), the cursor first goes where the mouse is.
/// send-prefix to the active pane: the key goes where tmux would send it — to a list or tree open
/// over the pane (what fzf in the pane would get: C-b is backward-char, C-a beginning-of-line), to
/// copy mode through its table (C-b is page-up in copy-mode-vi), else to the pane's program.
pub fn send_prefix_key(app: &mut App, key: KeyEvent) {
    if matches!(app.modal, Some(Modal::Picker { .. }) | Some(Modal::Tree { .. }) | Some(Modal::Copy { .. })) { return modal_key(app, key) }
    if let Some(bytes) = app.focused().and_then(|f| app.panes.get(&f)).and_then(|p| encode_key(&key, p.mode())) { send_to_focused(app, bytes) }
}

/// One key to a pane, as the pane's program reads it (send-prefix).
pub fn send_chord(app: &mut App, pane: u64, chord: keys::Chord) {
    let mode = app.panes.get(&pane).map(|p| p.mode()).unwrap_or(alacritty_terminal::term::TermMode::empty());
    if let Some(b) = encode_key(&KeyEvent::new(chord.code, chord.mods), mode) { send_to_pane(app, pane, b) }
}

/// tmux's send-keys (cmd-send-keys.c) to a pane: each argument a key by its name (`Enter`,
/// `C-c`, `Space`, `x`) or, naming none (or with -l), its characters; -H a byte in hex; -N the
/// lot that many times; -X a copy-mode command, which the pane must be in copy mode for; a pane
/// in copy mode takes the keys as its key table has them.
pub fn send_keys(app: &mut App, pane: u64, args: &crate::cmd::Args) {
    let in_mode = app.panes.get(&pane).map(|p| p.in_mode()).unwrap_or(false);
    let mut np: u32 = 1;
    if let Some(n) = args.get('N') {
        // args_strtonum_and_expand: a format.
        let n = commands::expand(app, n);
        np = match n.parse::<i64>() {
            Ok(n) if n >= 1 && n <= u32::MAX as i64 => n as u32,
            Ok(n) if n < 1 => return app.say("repeat count too small", theme::WARN),
            Ok(_) => return app.say("repeat count too large", theme::WARN),
            Err(_) => return app.say("repeat count invalid", theme::WARN),
        };
        // In a mode, -N with -X (or with no keys) is the count the mode's next command repeats by.
        if in_mode && (args.has('X') > 0 || args.values.is_empty()) {
            if let Some(m) = app.panes.get_mut(&pane).and_then(|p| p.modes.last_mut()) { m.prefix = np }
        }
    }
    if args.has('X') > 0 {
        if !in_mode { return app.say("not in a mode", theme::WARN) }
        let mouse = app.mouse_ev.clone().filter(|m| m.valid);
        return crate::copy::command(app, pane, &args.values, args.has('F') > 0, mouse.as_ref());
    }
    if args.values.is_empty() { return }
    let literal = args.has('l') > 0;
    let mode = app.panes.get(&pane).map(|p| p.mode()).unwrap_or(alacritty_terminal::term::TermMode::empty());
    let mut bytes = Vec::new();
    for _ in 0..np {
        for word in &args.values {
            if args.has('H') > 0 {
                // A byte by its hex value (none sent for one that isn't).
                if let Ok(n) = u8::from_str_radix(word, 16) { if !word.is_empty() && !word.starts_with('+') { if in_mode { inject_mode_key(app, pane, keys::Chord::normal(KeyCode::Char(n as char), KeyModifiers::NONE)) } else { bytes.push(n) } } }
                continue;
            }
            match (!literal).then(|| keys::parse(word).ok()).flatten() {
                // A key by its name: in a mode, what the mode's table binds it to; a mouse key's
                // name is nothing to a program (there is no event with it).
                Some(chord) if in_mode => inject_mode_key(app, pane, chord),
                Some(chord) if keys::is_mouse(&chord.code) => {}
                Some(chord) => { if let Some(b) = encode_key(&KeyEvent::new(chord.code, chord.mods), mode) { bytes.extend(b) } }
                None if in_mode => { for c in word.chars() { inject_mode_key(app, pane, keys::Chord::normal(KeyCode::Char(c), KeyModifiers::NONE)) } }
                None => bytes.extend(word.as_bytes()),
            }
        }
    }
    if !bytes.is_empty() { send_to_pane(app, pane, bytes) }
}

/// cmd_send_keys_inject_key for a pane in a mode: its table's binding for the key, if any (and
/// none from root).
fn inject_mode_key(app: &mut App, pane: u64, chord: keys::Chord) {
    let table = if crate::copy::ctx(app, pane).vi { "copy-mode-vi" } else { "copy-mode" };
    if let Some(b) = app.keymap.lookup(table, &chord) { commands::execute_bound(app, &b.command) }
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

/// menu_key_cb's PPage / C-b: five items up (to the first when fewer).
fn page_up(menu: &crate::modal::Menu, choice: i64) -> i64 {
    if choice < 6 { return 0 }
    let mut choice = choice;
    let mut i = 5;
    while i > 0 {
        choice -= 1;
        let it = &menu.items[choice as usize];
        if choice != 0 && !(it.separator || it.disabled) { i -= 1 } else if choice == 0 { break }
    }
    choice
}

/// The menu's chosen item runs (with the event of the command that opened the menu); a rule or
/// a disabled item closes it — unless -O keeps it open.
fn menu_chosen(app: &mut App, menu: crate::modal::Menu) {
    let Some(c) = menu.choice else { return };
    let it = &menu.items[c];
    if it.separator || it.disabled {
        if menu.stay_open { app.modal = Some(Modal::Menu(menu)) }
        return;
    }
    let command = it.command.clone();
    commands::execute_in(app, &command, menu.mouse.clone());
}

/// menu_key_cb's mouse: over an item it is chosen (the one the mouse is on when the button comes
/// up, or with -O on a press); outside, the button coming up closes the menu (with -O, a press).
/// A menu opened from the keyboard: any button but the first closes it.
pub fn menu_mouse(app: &mut App, m: &crate::mouse::Event) {
    let Some(Modal::Menu(mut menu)) = app.modal.take() else { return };
    use crate::mouse::{is_drag, is_release, is_wheel};
    if menu.no_mouse {
        // (tmux asks the terminal for no bare motion then: none reaches it.)
        let motion = is_drag(m.sgr_b) && is_release(m.sgr_b);
        if !motion && (m.b & 195) != 0 { return }
        app.modal = Some(Modal::Menu(menu));
        return;
    }
    let count = menu.items.len() as u16;
    let (px, py, width) = (menu.x, menu.y, menu.width);
    if m.x < px || m.x > px + 4 + width || m.y < py + 1 || m.y > py + count {
        let close = if !menu.stay_open { is_release(m.b) } else { !is_release(m.b) && !is_wheel(m.b) && !is_drag(m.b) };
        if close { return }
        menu.choice = None;
        app.modal = Some(Modal::Menu(menu));
        return;
    }
    let chosen = if !menu.stay_open { is_release(m.b) } else { !is_wheel(m.b) && !is_drag(m.b) };
    if chosen { return menu_chosen(app, menu) }
    menu.choice = Some((m.y - (py + 1)) as usize);
    app.modal = Some(Modal::Menu(menu));
}
