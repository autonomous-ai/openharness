//! Keys and mouse, the way tmux takes them: every key belongs to the pane in front of you, except
//! the prefix (C-b) and what you press right after it — tmux's own key table (`C-b c`, `C-b %`,
//! `C-b "`, `C-b o`, `C-b z`, `C-b [` …), read from `~/.tmux.conf` when there is one. Keys a
//! binding marks `-r` repeat without the prefix for `repeat-time`. The root table (keys with no
//! prefix) is empty unless you fill it, so no shell, editor or agent loses a key to Harness.

use std::time::{Duration, Instant};

use crossterm::event::{Event as CEvent, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use serde_json::{json, Value};

use crate::app::{App, Placement};
use crate::commands;
use crate::keys;
use crate::layout::{Dir, Toward};
use crate::modal::{self, Filter, Modal, PickerKind, Prompt, PromptKind, What};
use crate::pane::{encode_key, encode_mouse, Phase};
use crate::picker::Picker;
use crate::theme;

pub fn handle(app: &mut App, event: CEvent) {
    app.sync_copy_modal();
    match event {
        // A key is the session's activity (session_update_activity): a script's command with no -t
        // goes to the session used last.
        CEvent::Key(key) if key.kind != KeyEventKind::Release => {
            let now = crate::app::epoch_secs();
            // (This client used now: a shell's command with no target comes here — each second.)
            if now != app.session_activity { crate::ipc::mark_active() }
            app.session_activity = now; app.session_used = crate::app::use_order(); on_key(app, key)
        }
        CEvent::Paste(text) => on_paste(app, text),
        CEvent::Mouse(mouse) => {
            if app.mouse {
                // A turn of the wheel: the screen is written whole once it rests (app.scrolled_at).
                if matches!(mouse.kind, MouseEventKind::ScrollUp | MouseEventKind::ScrollDown | MouseEventKind::ScrollLeft | MouseEventKind::ScrollRight) { app.scrolled_at = Some(Instant::now()) }
                on_mouse(app, mouse)
            }
        }
        // (A resize also writes the whole screen again: other diff renderers do the same, since a
        // terminal reflows its own cells and the diff then trusts a screen that is not there.)
        CEvent::Resize(cols, rows) => { app.size = (cols, rows); app.redraw_all = true; app.fit_panes(); crate::workspace_menu::resize(app); crate::commands::notify(app, "client-resized", None, None) }
        // The terminal in front: the dial follows its pane again (and hears it is in front).
        // (A repaint of the whole screen too: whatever the terminal drew wrongly while it was behind goes.)
        CEvent::FocusGained => { app.terminal_focused = true; app.redraw_all = true; app.welcome_back(); crate::account::refresh(app, false); crate::dial::announce(app, false); app.announce_focus(); crate::commands::notify(app, "client-focus-in", None, None) }
        CEvent::FocusLost => { app.terminal_focused = false; app.away = Some((Instant::now(), app.fleet_counts())); crate::dial::announce(app, false); crate::commands::notify(app, "client-focus-out", None, None) }
        _ => {}
    }
    app.sync_copy_modal();
    app.release_waiting();
    crate::dial::settle_voice(app);
}

/// Overlays that type text keep every key (tmux's prompt ignores the prefix too).
fn typing(app: &App) -> bool {
    (app.home_visible() && !os_home(app)) || matches!(app.modal, Some(Modal::Prompt(_)) | Some(Modal::Picker { .. }) | Some(Modal::Confirm { .. }) | Some(Modal::Popup { .. }) | Some(Modal::Menu { .. }) | Some(Modal::NewHarness(_)))
}

fn on_key(app: &mut App, key: KeyEvent) {
    if crate::os_welcome::key(app, key) { return }
    let chord = keys::of(&key);
    app.key_name = Some(keys::name(&chord));
    // A message goes on the next key, as tmux's does.
    app.toast = None;
    // ── keys ── Waiting for a key (a prefix, or a command's key, chosen in the panel): this is it,
    // whatever it is — the prefix too.
    if app.capturing.is_some() { crate::settings::captured(app, key); return }
    // display-panes (cmd_display_panes_key), before any table: a number, or a letter for 10 on,
    // runs its template for that pane (select-pane) and closes it — as does one no pane has;
    // any other key (every key with -N) closes it and goes on as it would have.
    if matches!(app.modal, Some(Modal::DisplayPanes { .. })) {
        let Some(Modal::DisplayPanes { template, keys: takes, .. }) = app.modal.take() else { return };
        let plain = !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        let index = match key.code { KeyCode::Char(c @ '0'..='9') if plain => Some(c as usize - '0' as usize), KeyCode::Char(c @ 'a'..='z') if plain => Some(10 + c as usize - 'a' as usize), _ => None };
        if let (true, Some(i)) = (takes, index) {
            let base = app.pane_base(app.active);
            if let Some(id) = i.checked_sub(base).and_then(|k| app.tab().panes().get(k).copied()) {
                if app.tab().zoomed { app.tab_mut().zoomed = false; app.fit_panes() }
                let command = commands::template_replace(template.as_deref().unwrap_or("select-pane -t \"%%%\""), &crate::pane::tag(id), 1);
                commands::execute(app, &command);
            }
            return;
        }
    }
    // A table of your own (switch-client -T): its key runs, and the client goes back to root
    // (a -r key keeps the table for repeat-time); the prefix wins as everywhere. A key it does
    // not have is looked up in root — and, found in neither, goes nowhere: only a table kept for
    // a -r key lets it through to the pane (server_client_key_callback).
    if app.key_table_until.is_some_and(|t| Instant::now() >= t) { app.key_table = None; app.key_table_until = None }
    if let Some(table) = app.key_table.take() {
        app.status_redraws += 1;
        let repeating = app.key_table_until.take().is_some();
        if chord == app.keymap.prefix || Some(chord) == app.keymap.prefix2 { app.prefix = true; app.prefix_at = Some(std::time::Instant::now()); return }
        if let Some(b) = app.keymap.named.get(&table).and_then(|l| l.iter().rev().find(|b| b.chord == chord)).cloned() {
            if b.repeat { app.key_table = Some(table); app.key_table_until = Some(Instant::now() + Duration::from_millis(app.keymap.repeat_ms)) }
            commands::execute_bound(app, &b.command);
            return;
        }
        if !repeating {
            if let Some(b) = app.keymap.root_command(&chord).cloned() { commands::execute_bound(app, &b.command) }
            return;
        }
    }
    // tmux checks prefix-timeout when the next key arrives (the idle prefix stays shown).
    let timeout = app.options.server.get("prefix-timeout").and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
    if app.prefix && timeout > 0 && app.prefix_at.is_some_and(|at| at.elapsed() > Duration::from_millis(timeout)) {
        app.prefix = false;
        app.prefix_at = None;
        app.status_redraws += 1;
    }
    // After the prefix: the prefix table, then a root binding if this key has none there.
    if app.prefix {
        app.prefix = false;
        app.status_redraws += 1;
        // The prefix again: what the prefix table binds to it (tmux's default `send-prefix`, the
        // key given to what has the keyboard; screen's `bind C-a last-window`) — and, bound to
        // nothing, the prefix again (server_client_key_callback re-arms the table).
        if (chord == app.keymap.prefix || Some(chord) == app.keymap.prefix2) && app.keymap.prefix_command(&chord).is_none() {
            app.prefix = true;
            app.prefix_at = Some(std::time::Instant::now());
            return;
        }
        if let Some(binding) = app.keymap.prefix_command(&chord).or_else(|| app.keymap.root_command(&chord)).cloned() {
            // A list or view on screen gives way to the command, as tmux's choose modes do.
            if matches!(app.modal, Some(Modal::DisplayPanes { .. }) | Some(Modal::Picker { .. })) { app.modal = None }
            app.repeat_until = binding.repeat.then(|| Instant::now() + Duration::from_millis(app.keymap.repeat_ms));
            commands::execute_bound(app, &binding.command);
        }
        return;
    }
    // A repeatable key again, inside the repeat window: no prefix needed.
    if let Some(until) = app.repeat_until {
        app.status_redraws += 1;
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
    // at the status line keeps it — and a plain-key prefix (`` ` ``, Enter) is the prefix over the
    // panes alone: in a list it is typed into the search, or chooses.
    let line_edit = matches!(app.modal, Some(Modal::Prompt(_)) | Some(Modal::Confirm { .. }) | Some(Modal::Popup { .. }) | Some(Modal::Menu { .. }) | Some(Modal::NewHarness(_)));
    let listed = chord.plain() && (app.modal.is_some() || app.home_visible() && !os_home(app) && crate::new_harness::welcome_editing(app));
    if !line_edit && !listed && (chord == app.keymap.prefix || Some(chord) == app.keymap.prefix2) {
        app.status_redraws += 1;
        app.prefix = true;
        app.prefix_at = Some(std::time::Instant::now());
        return;
    }
    // key-table (a session's default table, root unless set — `off` for a nested tmux): its key
    // runs; one it has not goes to the pane, root's bindings not this client's then.
    let base = app.options.get("key-table", "", None).unwrap_or_else(|| "root".into());
    if base != "root" && app.modal.is_none() && !app.home_visible() {
        if let Some(b) = app.keymap.named.get(&base).and_then(|l| l.iter().rev().find(|b| b.chord == chord)).cloned() {
            app.status_redraws += 1;
            commands::execute_bound(app, &b.command);
            return;
        }
    }
    let root_table = base == "root" || app.modal.is_some();
    // A pane in copy mode or view mode: its mode's table first, then root; a key in neither does
    // nothing — it never reaches the pane's program (server_client_key_callback).
    if let Some(Modal::Copy { pane }) = app.modal {
        if mode_key(app, pane, &chord) { app.status_redraws += 1; return }
        if let Some(binding) = app.keymap.root_command(&chord).cloned() { app.status_redraws += 1; commands::execute_bound(app, &binding.command) }
        return;
    }
    // A pane in the tree (choose-tree): root's bindings first, then the tree's own keys
    // (window_tree_key) — never the pane's program.
    if app.modal.is_none() {
        if let Some(pane) = app.focused().filter(|f| app.panes.get(f).map(|p| p.tree_top()).unwrap_or(false)) {
            if let Some(binding) = app.keymap.root_command(&chord).cloned() { app.status_redraws += 1; commands::execute_bound(app, &binding.command); return }
            return crate::tree::key(app, pane, chord, None, true);
        }
        // The file manager (choose-file), likewise.
        if let Some(pane) = app.focused().filter(|f| app.panes.get(f).map(|p| p.files_top()).unwrap_or(false)) {
            if let Some(binding) = app.keymap.root_command(&chord).cloned() { app.status_redraws += 1; commands::execute_bound(app, &binding.command); return }
            return crate::files::key(app, pane, chord, None);
        }
    }
    if !typing(app) && root_table {
        if let Some(binding) = app.keymap.root_command(&chord).cloned() { app.status_redraws += 1; commands::execute_bound(app, &binding.command); return }
    }
    if app.modal.is_some() { modal_key(app, key); return }
    if app.tab().home { home_key(app, key); return }
    // A shell is on its way (split-window, new-window): what is typed meanwhile is its.
    if let Some(buffer) = app.shell_inputs.get(&app.tab().id) {
        let key = if key.code == KeyCode::Enter { KeyEvent::new(key.code, key.modifiers - KeyModifiers::SHIFT) } else { key };
        if let Some(bytes) = encode_key(&key, alacritty_terminal::term::TermMode::empty()) { buffer.lock().unwrap().push(bytes); return }
    }
    let Some(focus) = app.focused() else { home_key(app, key); return };
    // Clock mode: any key that reaches the pane ends it (window_clock_key), and goes no further.
    if let Some(p) = app.panes.get_mut(&focus).filter(|p| p.clock) { p.clock = false; app.redraw_all = true; return }
    let Some(pane) = app.panes.get(&focus) else { return };
    match &pane.phase {
        Phase::Card { title, .. } => {
            if key.code == KeyCode::Enter {
                if title == "Paused" || title == "Could not resume" { app.resume(focus) } else { app.open_stream(focus, true) }
            }
        }
        // Mid-takeover, still opening, or the link down: what is typed is kept (a screenful's worth)
        // and delivered once the stream is back, as mosh holds it.
        Phase::Connecting(_) => {
            if let Some(bytes) = encode_key(&for_pane(app, focus, key), pane.mode()) {
                if let Some(p) = app.panes.get_mut(&focus) { if p.queued.iter().map(Vec::len).sum::<usize>() < 4096 { p.queued.push(bytes) } }
            }
        }
        Phase::Live | Phase::Watching(_) => {
            if let Some(bytes) = encode_key(&for_pane(app, focus, key), pane.mode()) {
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

/// Keys into the focused pane. Typing in a watcher takes control across the TUI.
fn send_to_focused(app: &mut App, bytes: Vec<u8>) {
    let Some(focus) = app.focused() else { return };
    send_to_pane(app, focus, bytes)
}

/// Keys into a pane (send-keys -t): a watcher first reclaims the TUI's other panes too.
pub fn send_to_pane(app: &mut App, focus: u64, bytes: Vec<u8>) {
    // attach -r: a session only watched takes no keys.
    if app.read_only() && app.tabs.iter().any(|t| t.panes().contains(&focus)) { return }
    let Some(pane) = app.panes.get_mut(&focus) else { return };
    if pane.read_only || matches!(pane.phase, Phase::Watching(_)) || pane.stream.is_none() {
        pane.queued.push(bytes);
        app.take_control();
        // A popup has no tab, so its own stream still needs to be opened here.
        if app.panes.get(&focus).is_some_and(|p| !p.opening) { app.open_stream(focus, true) }
        return;
    }
    // synchronize-panes (window_pane_key): the same keys into every other pane of the window that
    // takes them — not one in a mode, nor one with its input off (select-pane -d), nor one a zoom
    // hides (window_pane_visible).
    if app.tab().sync && app.tab().panes().contains(&focus) {
        let zoomed = app.tab().zoomed;
        let others: Vec<u64> = app.tab().panes().into_iter().filter(|p| *p != focus).collect();
        for p in others {
            let ok = app.panes.get(&p).map(|x| x.stream.is_some() && !x.read_only && matches!(x.phase, Phase::Live) && !x.in_mode() && !x.input_off).unwrap_or(false);
            if ok && !zoomed { app.send_input(p, &bytes) }
        }
    }
    app.send_input(focus, &bytes);
}

fn on_paste(app: &mut App, text: String) {
    if paste_form(app, &text) { return }
    if let Some(Modal::Picker { picker, .. }) = &mut app.modal { for c in text.chars().filter(|c| !c.is_control()) { picker.type_char(c) } return }
    if let Some(Modal::Prompt(prompt)) = &mut app.modal { prompt.value.push_str(&text.replace(['\r', '\n'], " ")); return }
    app.tab_mut().home = false;
    if let Some(buffer) = app.shell_inputs.get(&app.tab().id) { buffer.lock().unwrap().push(text.into_bytes()); return }
    let Some(focus) = app.focused() else { return };
    let live = app.panes.get(&focus).map(|p| p.stream.is_some() && !p.read_only).unwrap_or(false);
    if live { app.send_paste(focus, &text) }
    else { send_to_focused(app, text.into_bytes()) }
}

/// Foreground editors own paste, including the tmux paste-buffer binding.
pub(crate) fn paste_form(app: &mut App, text: &str) -> bool {
    if crate::devices::paste(app, text) { return true }
    if let Some(Modal::NewHarness(form)) = &mut app.modal {
        crate::new_harness::paste(form, text);
        true
    } else if app.home_visible() {
        if !os_home(app) { crate::new_harness::welcome_paste(app, text); }
        true
    } else { false }
}

fn on_mouse(app: &mut App, mouse: MouseEvent) {
    if crate::os_welcome::mouse(app, mouse) { return }
    if crate::workspace_controls::finish_press(app, &mouse) { return }
    // tmux asks the terminal for bare motion only when a pane here wants it (or a menu opened by
    // the mouse): the rest of the motion hn is sent never happened, as far as tmux is concerned.
    if matches!(mouse.kind, MouseEventKind::Moved) && !app.wants_motion() { return }
    // hn's lists and prompts keep the mouse as they have it; copy mode and a menu are tmux's.
    if app.modal.is_some() && !matches!(app.modal, Some(Modal::Copy { .. }) | Some(Modal::Menu(_))) {
        if matches!(mouse.kind, MouseEventKind::Down(_)) { crate::mouse::cancel_clicks(app); }
        modal_mouse(app, mouse);
        // A panel may close on the press. Its release still belongs to the panel, not to
        // the program revealed beneath it. While it stays open, keep its scrollbar drags.
        if app.modal.is_none() { if let MouseEventKind::Down(button) = mouse.kind { crate::workspace_controls::begin_press(app, button); } }
        return;
    }
    // A menu over an empty window owns its click too; the welcome form underneath must not
    // swallow it or launch whatever happens to be at the same coordinates.
    if matches!(app.modal, Some(Modal::Menu(_))) {
        // Harness menus choose/dismiss on the press; ordinary tmux display-menu keeps its
        // own release semantics. Neither a menu action nor dismissal may leak a half-click.
        if matches!(&app.modal, Some(Modal::Menu(menu)) if menu.responsive.is_some()) {
            if let MouseEventKind::Down(button) = mouse.kind { crate::workspace_controls::begin_press(app, button); }
        }
        return crate::mouse::on_event(app, mouse);
    }
    if crate::workspace_controls::mouse(app, &mouse) { return }
    // ── status bar ──
    // (The bar down a side and the tabs over the panes: theirs, unless a menu is open.)
    if !matches!(app.modal, Some(Modal::Menu(_))) && crate::bar::mouse(app, &mouse) { return }
    if app.home_visible() { if !os_home(app) { crate::new_harness::welcome_mouse(app, mouse); } return }
    crate::mouse::on_event(app, mouse);
}

/// The mouse over hn's lists (the choose modes), as fzf's: the wheel moves the list or scrolls the
/// preview, whichever it is over; a click takes a row, a second one opens it; in the preview a
/// drag scrolls it and a drag on its border resizes it; a click outside the box closes it.
fn modal_mouse(app: &mut App, mouse: MouseEvent) {
    if matches!(app.modal, Some(Modal::NewHarness(_))) { return crate::new_harness::mouse(app, mouse) }
    // --no-mouse: a list the mouse does nothing to.
    if theme::fzf_opts().no_mouse && matches!(app.modal, Some(Modal::Picker { .. })) { return }
    if crate::devices::mouse(app, mouse) { return }
    let inside = |r: ratatui::layout::Rect| mouse.column >= r.x && mouse.column < r.x + r.width && mouse.row >= r.y && mouse.row < r.y + r.height;
    let (list, preview) = match &app.modal { Some(Modal::Picker { picker, .. }) => (picker.list_area.get(), picker.preview_area.get().filter(|_| picker.preview)), _ => (Default::default(), None) };
    let in_preview = preview.map(|(r, _)| inside(r)).unwrap_or(false);
    // Shift with a click or the wheel marks as it goes (fzf's shift-left-click, shift-scroll).
    let shift = mouse.modifiers.contains(KeyModifiers::SHIFT);
    let multi = matches!(&app.modal, Some(Modal::Picker { kind, picker }) if picker.multi_override.map(|n| n > 0).unwrap_or((matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) || theme::fzf_opts().multi) && crate::picker::scope_of(&picker.query).is_none()));
    match mouse.kind {
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
            let up = matches!(mouse.kind, MouseEventKind::ScrollUp);
            if let Some(Modal::Picker { picker, kind }) = &mut app.modal {
                if in_preview { picker.preview_by(if up { -1 } else { 1 }) }
                // A panel's list: the wheel scrolls it, three lines a notch, and chooses nothing —
                // the mouse over a row does (Moved). (Up shows what is over the top: in a list read
                // bottom-up, its later lines.)
                else if inside(list) && crate::settings::is_panel(kind) && !(shift && multi) {
                    let later = if crate::settings::top_down(kind) { !up } else { up };
                    picker.scroll = if later { picker.scroll + 3 } else { picker.scroll.saturating_sub(3) };
                    picker.free_scroll = true;
                }
                else if inside(list) {
                    if shift && multi { picker.toggle_mark(); }
                    let r: i64 = if crate::settings::top_down(kind) { -1 } else { 1 };
                    picker.move_by(if up { r } else { -r })
                }
            }
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            if let Some(Modal::Picker { picker, .. }) = &mut app.modal {
                if picker.bar_drag { picker.drag_bar(mouse.column, mouse.row, false); }
                else if picker.preview_bar_drag { picker.drag_preview_bar(mouse.column, mouse.row, false); }
                // Dragged over the rows (the button still down): the cursor follows it, as fzf's.
                else if picker.preview_drag.is_none() && !picker.border_drag && inside(list) { picker.click(mouse.row); }
                // The preview follows the mouse: dragged up, its lines come up.
                else if let Some((row, from)) = picker.preview_drag { picker.preview_to(from as i64 + row as i64 - mouse.row as i64) }
                else if picker.border_drag {
                    let (Some((p, pos)), l) = (picker.preview_area.get(), picker.list_area.get()) else { return };
                    let (left, top) = (p.x.min(l.x) as i64, p.y.min(l.y) as i64);
                    let (right, bottom) = ((p.x + p.width).max(l.x + l.width) as i64, (p.y + p.height).max(l.y + l.height) as i64);
                    let (x, y) = (mouse.column as i64, mouse.row as i64);
                    let cells = match pos { 'l' => x - left + 1, 'u' => y - top + 1, 'd' => bottom - y, _ => right - x };
                    picker.preview_cells = Some(cells.max(1));
                }
            }
        }
        MouseEventKind::Up(_) => { if let Some(Modal::Picker { picker, .. }) = &mut app.modal { picker.bar_drag = false; picker.preview_drag = None; picker.border_drag = false; picker.preview_bar_drag = false } }
        // A panel's list: the row under the mouse is the one chosen (the list does not move).
        MouseEventKind::Moved if inside(list) => {
            if let Some(Modal::Picker { picker, kind }) = &mut app.modal { if crate::settings::is_panel(kind) { picker.click(mouse.row); } }
        }
        // fzf's right click: the row under it, then toggle (a mark, in a list that takes marks).
        MouseEventKind::Down(MouseButton::Right) if !inside(list) => {}
        MouseEventKind::Down(MouseButton::Right) => {
            if let Some(Modal::Picker { picker, .. }) = &mut app.modal {
                if picker.click(mouse.row) && multi { picker.toggle_mark(); }
            }
        }
        // fzf: a middle click puts the cursor on the row, nothing more.
        MouseEventKind::Down(MouseButton::Middle) if inside(list) => {
            if let Some(Modal::Picker { picker, .. }) = &mut app.modal { picker.click(mouse.row); }
        }
        MouseEventKind::Down(MouseButton::Left) => {
            // fzf's scrollbar: pressed, the list follows the mouse while it is held.
            if let Some(Modal::Picker { picker, .. }) = &mut app.modal { if picker.drag_bar(mouse.column, mouse.row, true) { picker.bar_drag = true; return } }
            // In the preview: its scrollbar moves it, its border (the side toward the list) resizes
            // it, the rest scrolls it.
            if let Some(Modal::Picker { picker, .. }) = &mut app.modal { if picker.drag_preview_bar(mouse.column, mouse.row, true) { picker.preview_bar_drag = true; return } }
            if in_preview {
                if let (Some(Modal::Picker { picker, .. }), Some((p, pos))) = (&mut app.modal, preview) {
                    let on_border = match pos { 'l' => mouse.column + 1 == p.x + p.width, 'u' => mouse.row + 1 == p.y + p.height, 'd' => mouse.row == p.y, _ => mouse.column == p.x };
                    if on_border { picker.border_drag = true } else { picker.preview_drag = Some((mouse.row, picker.preview_scroll.get())) }
                }
                return;
            }
            let hit = match &mut app.modal { Some(Modal::Picker { picker, .. }) if inside(list) => Some(picker.click(mouse.row)), Some(Modal::Picker { .. }) => Some(false), _ => None };
            match hit {
                Some(true) if shift => { if multi { if let Some(Modal::Picker { picker, .. }) = &mut app.modal { picker.toggle_mark(); } } }
                // A panel's list: the mouse over a row has chosen it already, so one click runs it.
                Some(true) if matches!(&app.modal, Some(Modal::Picker { kind, .. }) if crate::settings::is_panel(kind)) => {
                    app.last_click = None;
                    modal_key(app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
                }
                Some(true) => {
                    let double = matches!(app.last_click, Some((9, _, r, at, _)) if r == mouse.row && at.elapsed() < Duration::from_millis(400));
                    app.last_click = Some((9, mouse.column, mouse.row, std::time::Instant::now(), 1));
                    if double { app.last_click = None; modal_key(app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)) }
                }
                Some(false) => {
                    // fzf: a click on the prompt's line puts the query's cursor there.
                    if let Some(Modal::Picker { picker, .. }) = &mut app.modal {
                        let (py, px) = picker.prompt_at.get();
                        if mouse.row == py {
                            let len = picker.query.chars().count() as i64;
                            let at = ((mouse.column as i64 - px as i64).clamp(0, len) + picker.xoffset.get() as i64).clamp(0, len);
                            picker.qcursor = at as usize;
                            picker.qmove(0, false);
                            return;
                        }
                    }
                    // Outside the list's window (a --height list's, over the panes) it goes; in it —
                    // its margin and padding too — a click on no row is nothing, as in fzf.
                    let top = app.size.1.saturating_sub(1);
                    let inside = matches!(&app.modal, Some(Modal::Picker { picker, .. }) if { let s = picker.screen_area.get(); s.width == 0 || inside(s) }) || mouse.row >= top;
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
        Some(Modal::Picker { picker, kind }) => {
            let r: i64 = if crate::settings::top_down(kind) { -1 } else { 1 };
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
    if !app.panes.get(&pane).map(|p| p.copy_top()).unwrap_or(false) { return }
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

/// A row of the home page: a harness, or a conversation Harness did not start (resumed as one).
#[derive(Clone, Debug)]
pub enum HomeRow { Harness(String, String), External(crate::app::External) }

impl HomeRow {
    /// Its key in the home page's order: (machine, agent), or (machine, "x:" session).
    pub(crate) fn key(&self) -> (String, String) {
        match self { HomeRow::Harness(m, a) => (m.clone(), a.clone()), HomeRow::External(x) => (x.machine.clone(), format!("x:{}", x.session_id)) }
    }
}

/// The home page's nine, as the desktop's welcome page lists them: by when each was last active,
/// the latest first — harnesses (paused ones too) and the Claude Code and Codex conversations from
/// the last 30 days that Harness did not start, on every connected machine.
pub fn home_rows(app: &App) -> Vec<HomeRow> {
    let mut all: Vec<(u64, HomeRow)> = app.fleet.agents.values()
        .filter(|a| app.fleet.state_of(a) != crate::fleet::State::Offline)
        .map(|a| (a.recency(), HomeRow::Harness(a.key().0, a.key().1)))
        .collect();
    all.extend(app.home_external.iter()
        .filter(|x| app.fleet.machine(&x.machine).is_some_and(|m| m.usable()))
        .map(|x| (x.last_at, HomeRow::External(x.clone()))));
    // (Ties by name, so two alike keep their places between readings.)
    let name = |r: &HomeRow| match r { HomeRow::Harness(m, a) => app.fleet.agent(m, a).map(|x| x.name.clone()).unwrap_or_default(), HomeRow::External(x) => x.title.clone() };
    all.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| name(&a.1).cmp(&name(&b.1))));
    let ranked: Vec<HomeRow> = all.into_iter().map(|(_, r)| r).collect();
    // Keep rows stable while activity changes; refresh the order when entering a window.
    let mut order = app.home_order.borrow_mut();
    let mut out: Vec<HomeRow> = order.iter().filter_map(|k| ranked.iter().find(|r| &r.key() == k).cloned()).collect();
    for r in &ranked { if out.len() >= 9 { break } if !out.iter().any(|o| o.key() == r.key()) { out.push(r.clone()) } }
    out.truncate(9);
    *order = out.iter().map(|r| r.key()).collect();
    out
}

fn catalog_conversation(app: &App, id: &str) -> Option<crate::app::External> {
    let (machine, session) = id.strip_prefix("external:")?.split_once(':')?;
    app.said.iter().chain(app.shell_context.catalog.iter()).filter_map(|h| h.external.as_ref())
        .find(|x| x.machine == machine && x.session_id == session).cloned()
}

fn conversation_agent(app: &App, x: &crate::app::External) -> Option<String> {
    if x.session_id.is_empty() { return None }
    app.fleet.agents.values()
        .filter(|a| a.machine_id == x.machine && a.session_id == x.session_id && a.engine == x.engine)
        .min_by_key(|a| (a.status == "stopped", &a.id)).map(|a| a.id.clone())
}

/// A history row may now belong to a running harness. Attach its existing
/// terminal first; only the daemon can decide whether a new resume is safe.
pub fn resume_external_as(app: &mut App, x: &crate::app::External, placement: Placement) {
    resolve_conversation(app, x, placement, true);
}

fn resolve_conversation(app: &mut App, x: &crate::app::External, placement: Placement, resume: bool) {
    if let Some(id) = conversation_agent(app, x) {
        app.modal = None;
        open_picked_agent(app, &x.machine, &id, placement);
        return;
    }
    let Some(link) = app.link(&x.machine) else {
        if app.shell_context.pending.is_some() { crate::shell_context::finish(app, 1, "That computer is not connected."); }
        else { app.say("That computer is not connected", theme::DANGER); }
        return;
    };
    let epoch = app.account_epoch;
    let generation = link.generation;
    let inline = app.shell_context.pending.as_ref().filter(|r| r.verb == "session-inline").cloned();
    let x = x.clone();
    app.modal = None;
    app.spawn(async move { link.rpc("agents_list", json!({"includeStopped":true}), Duration::from_secs(20)).await }, move |app, reply| {
        if app.account_epoch != epoch || app.connection_generation(&x.machine) != Some(generation)
            || inline.as_ref().is_some_and(|r| app.shell_context.pending.as_ref().is_none_or(|p| p.id != r.id || p.token != r.token)) { return }
        let Ok(reply) = reply else {
            let message = "Could not check the session's current state. Try opening it again.";
            if inline.is_some() { crate::shell_context::finish(app, 1, message); }
            else { app.say(message, theme::DANGER); }
            return;
        };
        if let Some(rows) = reply["agents"].as_array() { app.fleet.merge_roster(&x.machine, rows); }
        if let Some(id) = conversation_agent(app, &x) {
            open_picked_agent(app, &x.machine, &id, placement);
        } else if resume {
            create_external_as(app, &x, placement);
        } else {
            let message = "The session is already in Harness but its view is still loading. Try opening it again.";
            if inline.is_some() { crate::shell_context::finish(app, 1, message); }
            else { app.say(message, theme::SOFT); }
        }
    });
}

fn already_in_harness(creation_id: &str, reply: &Result<Value, crate::daemon::RpcError>) -> bool {
    match reply {
        Err(error) => error.code == "SESSION_IN_HARNESS",
        Ok(value) => value["creationId"] == creation_id && value["state"] == "failed"
            && value.pointer("/failure/code").and_then(Value::as_str) == Some("SESSION_IN_HARNESS"),
    }
}

fn create_external_as(app: &mut App, x: &crate::app::External, placement: Placement) {
    let inline = app.shell_context.pending.as_ref().filter(|r| r.verb == "session-inline").cloned();
    let Some(link) = app.link(&x.machine) else { if inline.is_some() { crate::shell_context::finish(app, 1, "That machine is not connected."); } else { app.say("That machine is not connected", theme::DANGER); } return };
    let creation_id = uuid::Uuid::new_v4().to_string();
    let mut payload = json!({ "engine": x.engine, "cwd": x.cwd, "bypassPermission": app.shell_context.sessions_machine.is_none(), "resumeSessionId": x.session_id, "creationId": creation_id });
    if !x.title.is_empty() { payload["name"] = json!(x.title) }
    app.say(format!("Resuming {} on {}…", if x.title.is_empty() { "the conversation" } else { &x.title }, app.fleet.machine_name(&x.machine)), theme::SOFT);
    app.modal = None;
    let source = app.shell_context.session_picker.take().and_then(|p| app.panes.get(&p).map(|pane| (p, (pane.machine_id.clone(), pane.agent_id.clone()))));
    let source_cwd = source.as_ref().and_then(|(p,_)| app.panes.get(p)).and_then(|p| p.cwd.clone().or_else(|| p.live_path.clone()));
    let machine = x.machine.clone();
    let conversation = x.clone();
    let epoch = app.account_epoch;
    app.spawn(async move { link.rpc("agent_create", payload, Duration::from_secs(180)).await }, move |app, reply| {
        let still_pending = inline.as_ref().is_none_or(|r| app.shell_context.pending.as_ref().is_some_and(|p| p.id == r.id && p.token == r.token));
        if app.account_epoch != epoch || !still_pending {
            if let Some(id) = reply.as_ref().ok().and_then(|v| v.pointer("/agent/id")).and_then(|v| v.as_str()) {
                if let Some(link) = app.link(&machine) { link.send("agent_delete", json!({"agentId":id})); }
            }
            return;
        }
        // It may have been opened by desktop after the roster check. Resolve
        // that owner once; never take over or launch a duplicate conversation.
        if already_in_harness(&creation_id, &reply) {
            app.shell_context.session_picker = source.as_ref().map(|(p, _)| *p);
            resolve_conversation(app, &conversation, placement, false);
            return;
        }
        // New daemons record refusals in a creation receipt, not a top-level
        // RPC error. Reuse the form's receipt validation and preserve its reason.
        use crate::new_harness::receipt::{self, Outcome};
        match receipt::outcome(&creation_id, &reply, false) {
            Outcome::Created => {},
            Outcome::Failed { message, .. } | Outcome::Uncertain(message) => {
                let message = message.replacen("Could not start it:", "Could not open it:", 1);
                if inline.is_some() { crate::shell_context::finish(app, 1, &message); }
                else { app.say(message, theme::DANGER); }
                return;
            }
        }
        match reply {
            Ok(reply) => {
                if let Some(id) = reply.pointer("/agent/id").and_then(|v| v.as_str()) {
                    app.fleet.agents.insert((machine.clone(), id.to_string()), crate::fleet::agent_from(&machine, &reply["agent"], None));
                    let moved = source.as_ref().is_some_and(|(p, _)| app.focused() != Some(*p));
                    if inline.is_some() && moved {
                        // Keep the resumed process available, without taking the user away from
                        // the pane they switched to while its machine was answering.
                        crate::shell_context::finish(app, 0, "Session resumed. Find it with hn sessions.\n");
                        return;
                    }
                    if inline.is_some() { crate::shell_context::finish(app, 0, ""); }
                    let placement = if moved { Placement::Tab } else { placement };
                    let held = source.as_ref().is_some_and(|(_, key)| app.shells.remove(key));
                    app.open_agent(&machine, id, placement);
                    if let Some((_, key)) = source {
                        crate::shell_context::visiting_created(app, &key, source_cwd, &machine, id);
                        if held { app.shells.insert(key); }
                    }
                    app.toast = None;
                } else if inline.is_some() { crate::shell_context::finish(app, 1, "The computer opened no session."); }
                else { app.say("The machine opened no harness", theme::DANGER); }
            }
            Err(e) => if inline.is_some() { crate::shell_context::finish(app, 1, &format!("Could not open it: {e}")); }
                else { app.say(format!("Could not open it: {e}"), theme::DANGER); },
        }
    });
}

/// The OS opts in through its session launcher. Ordinary hn on macOS or any
/// other Linux keeps its normal home, even with a stray live-session flag.
pub fn os_home(app: &App) -> bool {
    app.os_session && (app.os_live || home_rows(app).is_empty())
}

fn os_home_command(app: &App, key: KeyEvent) -> Option<Option<&'static str>> {
    if !os_home(app) || key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) { return None }
    match key.code {
        KeyCode::Enter if app.os_live => Some(Some("sudo /usr/bin/harness install")),
        KeyCode::Char('i' | 'I') if app.os_live => Some(Some("sudo /usr/bin/harness install")),
        KeyCode::Enter => Some(Some("/usr/bin/hn-os try")),
        KeyCode::Char('t' | 'T') if app.os_live => Some(Some("/usr/bin/hn-os welcome")),
        KeyCode::Char('w' | 'W') => Some(Some("/usr/bin/hn-os wifi")),
        KeyCode::Char('t' | 'T') => Some(None),
        _ => None,
    }
}

/// The shared welcome composer owns ordinary keys; the OS retains its setup actions.
fn home_key(app: &mut App, key: KeyEvent) {
    if os_home(app) {
        if let Some(command) = os_home_command(app, key) {
            new_shell_from(app, None, Placement::Auto(None), None, command.map(str::to_string));
        }
        return;
    }
    crate::new_harness::welcome_key(app, key);
}


// ── commands ──────────────────────────────────────────────────────────────

pub fn picker(app: &mut App, kind: PickerKind, title: &str, placeholder: &str) {
    let mut picker = Picker::new(title, placeholder);
    // A list that is the whole answer (output, messages, keys) needs no preview beside it.
    if matches!(kind, PickerKind::Output { .. } | PickerKind::Messages | PickerKind::Keys) { picker.preview = false }
    fill(app, &kind, &mut picker);
    app.modal = Some(Modal::Picker { kind, picker });
}

/// The question each harness row shows, and since when it has (a new request id is new).
fn note_questions(app: &App, picker: &mut Picker) {
    let now = Instant::now();
    let rows: Vec<String> = picker.rows.iter().map(|r| r.id.clone()).collect();
    for id in rows {
        let Some((m, a)) = split_key(&id) else { continue };
        match app.fleet.agent(&m, &a).and_then(|x| x.question.as_ref()).map(|q| q.request_id.clone()) {
            Some(req) => { if picker.q_seen.get(&id).map(|(r, _)| r != &req).unwrap_or(true) { picker.q_seen.insert(id, (req, now)); } }
            None => { picker.q_seen.remove(&id); }
        }
    }
}

/// Whether M-1…9 / M-a may answer [row]'s question now: it has been on screen a moment (0.6 s),
/// and the cursor did not just land on it by the list changing under it — else what to say.
fn answerable(app: &App, picker: &Picker, row: &str) -> Result<String, &'static str> {
    const LOOK: Duration = Duration::from_millis(600);
    if picker.landed.is_some_and(|t| t.elapsed() < LOOK) { return Err("That row just changed under the cursor — look again") }
    let (m, a) = split_key(row).ok_or("No question here")?;
    let req = app.fleet.agent(&m, &a).and_then(|x| x.question.as_ref()).map(|q| q.request_id.clone()).ok_or("That question is no longer open")?;
    match picker.q_seen.get(row) {
        Some((r, at)) if *r == req && at.elapsed() >= LOOK => Ok(req),
        // (On a list just opened, the question only just came into view: read it first.)
        _ if picker.opened.elapsed() < LOOK => Err("Read the question first — press again"),
        _ => Err("That question just changed — look again"),
    }
}

/// (Re)build an overlay's rows from the fleet — called on open and whenever the fleet moves.
pub fn fill(app: &App, kind: &PickerKind, picker: &mut Picker) {
    fill_rows(app, kind, picker);
    if matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) { note_questions(app, picker) }
}

fn fill_rows(app: &App, kind: &PickerKind, picker: &mut Picker) {
    // Its spinner turns while what it lists is still coming in, as fzf's does while it reads.
    let busy = match kind {
        PickerKind::Store => is_loading(&format!("dsh {}", app.fleet.local_id)),
        PickerKind::Models => crate::models::loading(app),
        _ => false,
    };
    picker.busy = busy.then(|| "loading".to_string());
    match kind {
        PickerKind::Open { filter, machine, project } => {
            picker.live = true;
            harness_preview(picker);
            let mut rows = modal::agent_rows(app, *filter, machine.as_deref(), project.as_deref());
            // With more than one session, they are in the list too (Enter goes to one), after the
            // harnesses: tmux's C-b s is its sessions.
            if machine.is_none() && project.is_none() && *filter == Filter::All { rows.extend(modal::session_rows(app)) }
            // What the query found by what was said in them: the conversations Harness did not
            // start among the rows, and every hit's row in the list whatever its line says.
            if project.is_none() {
                let mut seen = std::collections::HashSet::new();
                rows.extend(modal::external_rows(app).into_iter().filter(|r| machine.as_ref().is_none_or(|m| r.id.starts_with(&format!("external:{m}:"))) && seen.insert(r.id.clone())));
            }
            if app.shell_context.sessions_machine.is_some() {
                // Catalog pagination uses opaque IDs. Its arrival order is not a
                // display order: merge saved and live work by last activity,
                // including newer conversations that arrive on a later page.
                // Picker::refilter preserves the selected identity as rows arrive.
                let mut recency: std::collections::HashMap<String,u64> = app.fleet.agents.values()
                    .map(|a| (format!("{}:{}",a.machine_id,a.id),a.recency())).collect();
                for x in app.said.iter().chain(app.shell_context.catalog.iter()).filter_map(|s| s.external.as_ref()) {
                    let at = recency.entry(format!("external:{}:{}",x.machine,x.session_id)).or_default();
                    *at = (*at).max(x.last_at);
                }
                rows.sort_by(|a,b| recency.get(&b.id).unwrap_or(&0).cmp(recency.get(&a.id).unwrap_or(&0))
                    .then_with(|| a.label.cmp(&b.label)).then_with(|| a.id.cmp(&b.id)));
                picker.hold = None;
            } else {
                // Workspace navigation holds its existing rows still; typing re-ranks.
                match &picker.hold {
                    Some(order) => { let at = |id: &str| order.iter().position(|o| o == id).unwrap_or(usize::MAX); rows.sort_by_key(|r| at(&r.id)) }
                    None => picker.hold = Some(rows.iter().map(|r| r.id.clone()).collect()),
                }
            }
            // A row found by what was said in it shows where (its words lit as a match is), in
            // place of its detail — part of its line, so fzf lights what the query found there.
            picker.said_text = rows.iter().map(|r| (r.id.clone(), crate::picker::line(r))).collect();
            for r in rows.iter_mut() {
                let hit = app.said.iter().find(|s| s.turn >= 0 && (if s.external.is_some() { format!("external:{}:{}", s.machine, s.session_id) } else { format!("{}:{}", s.machine, s.agent_id) }) == r.id);
                if let Some(h) = hit { r.detail = vec![ratatui::text::Span::styled(modal::snippet_line(&h.snippet), ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::DIM))]; r.volatile_detail = false }
            }
            picker.said = app.said.iter().map(|s| if s.external.is_some() { format!("external:{}:{}", s.machine, s.session_id) } else { format!("{}:{}", s.machine, s.agent_id) }).collect();
            picker.said_query = app.said_for.clone();
            for hit in &app.said {
                let id = if hit.external.is_some() { format!("external:{}:{}", hit.machine, hit.session_id) } else { format!("{}:{}", hit.machine, hit.agent_id) };
                let text = picker.said_text.entry(id).or_default();
                text.push(' ');
                text.push_str(&hit.snippet.replace(['\u{2}', '\u{3}'], ""));
            }
            picker.catalog_ids = app.shell_context.catalog.iter().filter(|_| app.shell_context.sessions_machine.is_some()).map(|h| format!("external:{}:{}", h.machine, h.session_id)).collect();
            picker.set_rows(rows);
            picker.status = modal::open_status(app, *filter);
            picker.hints = vec![("enter", "add pane"), ("C-t", "new window"), ("M-1..9", "answer"), ("M-m", "read"), ("C-v", "beside"), ("C-x", "below"), ("M-enter", "here"), ("M-a", "type an answer"), ("M-s", "message"), ("M-r", "restart"), ("tab", "mark"), ("C-/", "preview"), ("M-p", "pause")];
            picker.empty = if app.fleet.agents.is_empty() { "no harnesses yet — C-b C makes one".into() } else { String::new() };
            if app.shell_context.sessions_machine.is_some() {
                picker.hints = vec![("enter", "open"), ("C-t", "new window"), ("C-/", "preview"), ("esc", "cancel")];
                picker.status = app.shell_context.catalog_notice.clone();
                picker.empty = "No matching sessions".into();
                picker.multi_override = Some(0);
            }
        }
        PickerKind::Palette => { picker.set_rows(modal::palette_rows(app)); picker.hints = vec![("enter", "run"), ("C-b :", "type one")] }
        PickerKind::Projects => {
            picker.set_rows(modal::project_rows(app));
            picker.hints = vec![("enter", "its harnesses"), ("C-t", "a session of them"), ("M-n", "new harness there")];
            picker.empty = "No projects yet.".into();
        }
        // ── models: the Models view's sections, as the desktop picker lists them (models.rs) ──
        PickerKind::Models => {
            let rows = crate::models::rows(app, crate::models::searched(picker));
            let in_use = crate::models::in_use_row(&rows);
            let top = rows.first().map(|r| r.id.clone());
            let before = picker.selected_id.clone();
            // (Rebuilt in its sections each time — a model moves to where its state puts it, a
            // reply come late lands in its section — the cursor staying on its row.)
            picker.rows.clear();
            picker.set_rows(rows);
            // Start on what the harness is on — the model, the API's or its own login — else the
            // top row, as the desktop's picker does; and follow it there as replies arrive, until a
            // key moves the cursor elsewhere.
            if picker.query.trim() == ":" && (before.is_none() || before == picker.placed) {
                if let Some(want) = in_use.or(top) { picker.select(&want); picker.placed = picker.selected_id.clone() }
            }
            picker.right_half = true;
            // (On a Jev model there is nothing to use: Enter copies how to call it.)
            picker.hints = match picker.selected_id.as_deref() {
                Some(id) if id.starts_with("mv:jev:") => vec![("enter", "copy how to call it")],
                Some(id) if id.starts_with("mv:jevlocal:") => vec![("enter", "get · start · copy"), ("C-s", "stop it")],
                _ => vec![("enter", "use · get"), ("C-s", "stop a local model")],
            };
            picker.empty = if crate::models::target(app).is_none() { crate::models::no_target_why(app) } else { "Loading its models…".into() };
            picker.status = crate::models::target(app).and_then(|t| app.fleet.agent(&t.machine, &t.agent)).map(|a| a.name.clone()).unwrap_or_default();
        }
        PickerKind::Inbox => {
            picker.live = true;
            harness_preview(picker);
            picker.set_rows(modal::inbox_rows(app));
            picker.status = format!("{} waiting", app.fleet.waiting());
            picker.hints = vec![("M-1..9", "answer"), ("M-a", "type an answer"), ("enter", "go"), ("C-o", "open"), ("tab", "mark")];
            picker.empty = "Nobody is waiting on you.".into();
        }
        PickerKind::Machines => {
            let was = picker.current_id();
            picker.set_rows(modal::machine_rows(app));
            // Come to from another list (`@`): the cursor on the machine you are on — the focused
            // pane's, else this one — with its preview beside it. A refresh leaves it where it is.
            if !was.is_some_and(|w| app.fleet.visible_machines().any(|m| m.id == w)) {
                let here = app.focused().and_then(|p| app.panes.get(&p)).map(|p| p.machine_id.clone()).filter(|m| !m.is_empty()).unwrap_or_else(|| app.fleet.local_id.clone());
                picker.select(&here);
            }
            let up = app.fleet.visible_machines().filter(|m| m.usable()).count();
            picker.status = format!("{up}/{} connected", app.fleet.visible_machines().count());
            picker.hints = vec![("enter", "its harnesses"), ("M-n", "new there"), ("C-t", "terminal there"), ("M-l", "link")];
        }
        PickerKind::Layout => { picker.keep_order = true; picker.set_rows(modal::layout_rows(app.tab().panes().len())); picker.hints = vec![("enter", "apply")] }
        PickerKind::Theme => {
            picker.keep_order = true;
            picker.theme_in = None;
            picker.set_rows(modal::theme_sections(app));
            picker.hints = vec![("→/enter", "open"), ("enter", "set"), ("esc", "done")];
        }
        // (Typed into, it ranks by match, best first, as fzf does; empty, it keeps its groups. A
        // query matches a command's name and keywords, not the description shown beside it.)
        PickerKind::Commands => { picker.live = true; picker.set_rows(modal::command_rows_for(app, !picker.query.is_empty(), crate::settings::in_tmux(picker))); picker.hints = vec![("enter", "run"), ("M-k", "change its key")] }
        // ── keys ──
        PickerKind::Keybinds => { picker.keep_order = true; picker.set_rows(modal::keybind_rows(app)); picker.hints = vec![("enter", "change"), ("esc", "done")] }
        PickerKind::Help => { picker.set_rows(modal::mode_rows(app)); picker.hints = vec![("enter", "go")] }
        PickerKind::Store => {
            let catalog = app.dsh.get(&app.fleet.local_id).cloned().unwrap_or_default();
            picker.set_rows(modal::store_rows(&catalog));
            let installed = picker.rows.iter().filter(|r| r.lead.first().map(|s| s.content.contains('●')).unwrap_or(false)).count();
            picker.status = format!("{installed} installed");
            picker.hints = vec![("enter", "start one"), ("M-i", "install")];
            // (While it loads the spinner turns and the list is blank, as fzf's is while it reads.)
            if catalog.is_empty() { picker.empty = "Nothing in the Store yet.".into() }
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
            // tmux's choose-buffer rows: `name: size bytes: "sample"`, newest first — each one line,
            // as fzf has it over list-buffers: matched, cut and scrolled whole.
            let rows = app.paste.walk().map(|b| {
                let lead = format!("{}: {} bytes: ", b.name, b.data.len());
                crate::picker::Row::new(b.name.clone(), format!("{lead}\"{}\"", crate::paste::sample(b))).label_dim(lead.chars().count())
            }).collect();
            picker.set_rows(rows);
            picker.empty = "no buffers".into();
            picker.hints = vec![("enter", "paste")];
        }
        // ── machines & devices ──
        PickerKind::Devices(view) => crate::devices::fill(app, *view, picker),
        PickerKind::Account => crate::account::fill(app, picker),
        PickerKind::AgentSwitch => crate::agent_switch::fill(app, picker),
        PickerKind::Hardware => crate::hardware::fill(app, picker),
        PickerKind::ShellContext => crate::shell_context::fill(app, picker),
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
    crate::shell_context::cancel(app);
    app.shell_context.session_picker = None;
    app.shell_context.sessions_machine = None;
    // A split waits for the NEXT pick only if it asked for this box; any other opening forgets it.
    SPLIT.with(|s| s.set(None));
    if let Some(Modal::Picker { kind, picker }) = &app.modal {
        let same_mode = modal::is_launcher(kind) && picker.query.trim().chars().next().map(|c| c.to_string()).unwrap_or_default() == prefix
            && !matches!(kind, PickerKind::Open { filter: f, .. } if *f != filter);
        if same_mode { app.modal = None; return }
    }
    let kind = match prefix { "" => PickerKind::Open { filter, machine: None, project: None }, p => modal::launcher_kind(p, &PickerKind::Palette) };
    // C-b s reads afresh each time it opens: what was said, and the sessions' latest turns.
    if matches!(kind, PickerKind::Open { .. }) { app.said.clear(); app.said_for.clear(); app.said_want.clear(); app.said_due = None; app.said_pending = 0; app.said_generation = app.said_generation.wrapping_add(1); app.tails.clear(); app.tails_asked.clear() }
    let (title, placeholder) = modal::launcher_title(app, &kind);
    let mut picker = Picker::new(title, placeholder);
    picker.prefixed = true;
    picker.query = prefix.to_string();
    picker.qcursor = prefix.chars().count();
    prepare(app, &kind);
    fill(app, &kind, &mut picker);
    // As choose-tree starts on the current session: on this window's harness, so Enter stays.
    if prefix.is_empty() { if let Some((machine, agent)) = focused_agent(app) { picker.select(&format!("{machine}:{agent}")) } }
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

fn load_models(app: &mut App) {
    // ── models: this computer's models, the grids and the saved APIs (models.rs) ──
    crate::models::open(app);
}

/// The query changed: when its first character moved the box to another mode, rebuild it as that mode.
fn remode(app: &App, kind: PickerKind, picker: &mut Picker) -> (PickerKind, bool) {
    if !modal::is_launcher(&kind) || !picker.prefixed { return (kind, false) }
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
        "account" | "login" => crate::account::open(app),
        "hardware-devices" => crate::hardware::open(app),
        "open" => launch(app, "", Filter::All),
        "palette" => launch(app, ">", Filter::All),
        "projects" => launch(app, "#", Filter::All),
        "models" => launch(app, ":", Filter::All),
        "change-agent" => if let Some(pane) = app.focused() { crate::agent_switch::open(app, pane); },
        // Nobody asking: said, as C-b a says it, not an empty list.
        "inbox" => if app.fleet.agents.values().any(|a| a.question.is_some()) { picker(app, PickerKind::Inbox, "needs input", "Filter…") } else { app.say("Nobody is waiting on you", theme::WARN) },
        "machines" => launch(app, "@", Filter::All),
        "help" => launch(app, "?", Filter::All),
        "layout" => picker(app, PickerKind::Layout, "layout", ""),
        "theme" | "appearance" => picker(app, PickerKind::Theme, "Appearance", "Search appearance"),
        // ── keys ── Keybinds: a panel of its own (from the command list it opens in place).
        "keybinds" => picker(app, PickerKind::Keybinds, "Keybinds", "Search keybinds"),
        "commands" => picker(app, PickerKind::Commands, "Commands", "Type a command — appearance, new, layout, models…"),
        "store" => launch(app, "*", Filter::All),
        "new" => {
            let focused = focused_agent(app);
            new_shell_with_picker(app, focused, Placement::Auto(None), None, None, true);
        }
        "terminal" => {
            let focused = focused_agent(app);
            new_shell_from(app, focused, Placement::Auto(None), None, None);
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
            if app.capture.is_none() { app.say("Cloning…", theme::SOFT) }
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
        "take" => app.take_control(),
        "rename" => {
            let Some((machine, agent)) = focused_agent(app) else { return };
            let name = app.fleet.agent(&machine, &agent).map(|a| a.name.clone()).unwrap_or_default();
            prompt(app, PromptKind::RenameHarness { machine, agent }, "Rename Harness", "New name", "", &name, false)
        }
        "tab" => crate::commands::execute(app, "new-window"),
        "rename-tab" => {
            let name = app.tab().name.clone();
            let target = PromptKind::RenameTab { session:app.session_id, window:app.tab().id.clone(), owner:app.fleet.local_id.clone() };
            prompt(app, target, "Rename Tab", "Tab name", "", &name, false);
        }
        "close-tab" => crate::session_close::tab(app, app.active),
        "next-tab" => { let n = app.tabs.len(); let i = (app.active + 1) % n; app.select_tab(i) }
        "prev-tab" => { let n = app.tabs.len(); let i = (app.active + n - 1) % n; app.select_tab(i) }
        "split-right" | "split-down" => {
            crate::commands::execute(app, if command == "split-right" { "split-window -h" } else { "split-window -v" });
        }
        "close-pane" => { if let Some(f) = app.focused() { crate::session_close::pane(app, f) } else if app.tabs.len() > 1 { crate::session_close::tab(app, app.active) } }
        "zoom" => {
            let tab = app.tab_mut();
            if tab.panes().len() > 1 { tab.zoomed = !tab.zoomed; app.fit_panes(); let t = app.active; app.view_layout_changed(t) } else { app.fit_panes() }
        }
        "equalize" => { if let Some(f) = app.focused() { if let Some(root) = app.tab_mut().root.as_mut() { root.spread_out(f) } } app.fit_panes(); app.layout_changed(app.active) }
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
        "next-waiting" => next_attention(app, false),
        "prev-waiting" => next_attention(app, true),
        "resume-focused" => { if let Some(f) = app.focused() { app.resume(f) } }
        "last-harness" => {
            match app.last_harness.clone() {
                Some((m, a)) => app.open_agent(&m, &a, Placement::Auto(None)),
                None => app.say("no last harness", theme::WARN),
            }
        }
        "tree" => commands::execute(app, "choose-tree -Zw"),
        "files" => crate::files::open(app, None),
        "info" => {
            // tmux `display-message` with its default format, harness-flavoured.
            let text = match focused_agent(app).and_then(|(m, a)| app.fleet.agent(&m, &a).map(|x| (x.clone(), app.fleet.machine_name(&m)))) {
                Some((a, machine)) => format!("[{}] {}:{}, current pane {} - ({}) \"{}\" {} {}{}", app.session_name(), app.win_num(app.active), app.tab().name,
                    app.focused().and_then(|f| app.tab().panes().iter().position(|x| *x == f)).unwrap_or(0) + app.pane_base(app.active),
                    a.engine, a.name, machine, if a.cwd.is_empty() { String::new() } else { a.cwd.replace(&std::env::var("HOME").unwrap_or_default(), "~") }, if a.branch.is_empty() { String::new() } else { format!(" ({})", a.branch) }),
                None => format!("[{}] {}:{} — empty window", app.session_name(), app.win_num(app.active), app.tab().name),
            };
            app.say(text, theme::WARN);
        }
        "messages" => picker(app, PickerKind::Messages, "messages", ""),
        "keys" => picker(app, PickerKind::Keys, "keys", ""),
        "choose-buffer" => picker(app, PickerKind::Buffers, "buffers", ""),
        "quit" if app.os_session => app.error("hn is the OS session; open a Terminal with C-b N"),
        "quit" => app.quit = true,
        c if c.starts_with("tab-") => { if let Some(n) = c[4..].parse::<usize>().ok().and_then(|n| n.checked_sub(1)) { app.select_tab(n) } }
        // ── machines & devices ──
        "connect-machine" | "add-phone" | "devices" => { if let Some(view) = crate::devices::View::of(command) { crate::devices::open(app, view) } }
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
    agent_rpc_on(app, machine, agent, ty, done)
}

/// A harness's verb from a command with its target (restart-harness -t …): restart, pause,
/// clone, resume or rename that one — one mid-turn restarted or paused only with [yes].
pub fn harness_verb(app: &mut App, verb: &str, (machine, agent): (String, String), yes: bool, name: &str) {
    let Some(a) = app.fleet.agent(&machine, &agent) else { return app.error("can't find harness") };
    // (Waiting on you is mid-turn too: its question goes with a restart or a pause.)
    let waiting = matches!(app.fleet.state_of(a), crate::fleet::State::NeedsInput);
    let working = waiting || matches!(app.fleet.state_of(a), crate::fleet::State::Working | crate::fleet::State::Starting);
    let who = a.name.clone();
    if app.link(&machine).is_none() { return app.error(format!("{who}'s machine is not connected")) }
    match verb {
        "restart-harness" | "pause-harness" if working && !yes => app.error(format!("{who} is {} (-y to {} it anyway)", if waiting { "waiting on you" } else { "working" }, if verb == "restart-harness" { "restart" } else { "pause" })),
        "restart-harness" => agent_rpc_on(app, machine, agent, "agent_restart", "Restarted"),
        "pause-harness" => agent_rpc_on(app, machine, agent, "agent_delete", "Paused — the conversation is saved"),
        "resume-harness" => match app.find_pane_anywhere(&machine, &agent).map(|(_, _, p)| p) {
            Some(pane) => app.resume(pane),
            None => agent_rpc_on(app, machine, agent, "agent_resume", "Resumed"),
        },
        "clone-harness" => clone_on(app, machine, agent),
        _ => {
            let Some(link) = app.link(&machine) else { return };
            let name = name.to_string();
            app.spawn(async move { link.rpc("agent_update", json!({ "agentId": agent, "name": name }), Duration::from_secs(20)).await }, move |app, r| {
                if let Err(e) = r { app.say(format!("{e}"), theme::DANGER) } else { app.relist(&machine) }
            });
        }
    }
}

fn clone_on(app: &mut App, machine: String, agent: String) {
    let Some(link) = app.link(&machine) else { return };
    if app.capture.is_none() { app.say("Cloning…", theme::SOFT) }
    app.spawn(async move { link.rpc("agent_fork", json!({ "agentId": agent, "creationId": uuid::Uuid::new_v4().to_string() }), Duration::from_secs(120)).await }, move |app, reply| match reply {
        Ok(reply) => if let Some(id) = reply.pointer("/agent/id").and_then(|v| v.as_str()) {
            app.fleet.agents.insert((machine.clone(), id.to_string()), crate::fleet::agent_from(&machine, &reply["agent"], None));
            app.open_agent(&machine, id, Placement::Auto(None));
        },
        Err(e) => app.say(format!("Clone failed: {e}"), theme::DANGER),
    });
}

fn agent_rpc_on(app: &mut App, machine: String, agent: String, ty: &'static str, done: &'static str) {
    let Some(link) = app.link(&machine) else { return };
    app.spawn(async move { link.rpc(ty, json!({ "agentId": agent }), Duration::from_secs(120)).await }, move |app, reply| match reply {
        Ok(_) => { app.say(done, theme::ONLINE); app.relist(&machine) }
        Err(e) => app.say(format!("{e}"), theme::DANGER),
    });
}

pub(crate) fn load_dsh(app: &mut App, machine: String) {
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

/// The harness lists' preview: beside the list, and below it under 180 columns (fzf's
/// `right,50%,<90(down,40%)`), so each harness's one line keeps its room — your --preview-window
/// laid over it, as fzf reads one after another (`border-sharp` changes the border only).
fn harness_preview(picker: &mut Picker) {
    if picker.preview_window.is_some() { return }
    let mut pw = crate::theme::PreviewWindow::default();
    theme::parse_preview_window(&mut pw, "right,50%,<90(down,40%)");
    for spec in &theme::fzf_opts().preview_window_specs {
        theme::parse_preview_window(&mut pw, spec);
        // …and its look (a border, info, a scroll offset) over the narrow layout too; where
        // the preview goes and its size are that layout's own.
        let look: Vec<&str> = spec.split(',').filter(|t| { let t = t.trim(); !(matches!(t, "up" | "down" | "left" | "right" | "top" | "bottom") || t.starts_with('<') || !t.trim_end_matches('%').is_empty() && t.trim_end_matches('%').chars().all(|c| c.is_ascii_digit())) }).collect();
        if let (Some(alt), false) = (pw.alternative.as_deref_mut(), look.is_empty()) { theme::parse_preview_window(alt, &look.join(",")) }
    }
    picker.preview_window = Some(pw);
}

/// Rebuild the open overlay's rows (the fleet or a catalog moved under it).
pub fn refill(app: &mut App) {
    crate::new_harness::refresh(app);
    if matches!(app.modal, Some(Modal::NewHarness(_))) { return }
    // A delayed search/catalog reply may arrive after the picker has closed. It must not
    // consume a command prompt, confirmation or copy mode that replaced that picker.
    if !matches!(app.modal, Some(Modal::Picker { .. })) { return }
    if let Some(Modal::Picker { kind, mut picker }) = app.modal.take() {
        let was = picker.current_id();
        // (The settings panel changes only by your keys: a refresh would step out of its section.)
        if !matches!(kind, PickerKind::Route { .. } | PickerKind::Palette | PickerKind::Help | PickerKind::Layout | PickerKind::Theme | PickerKind::Commands | PickerKind::Keybinds) { fill(app, &kind, &mut picker) }
        // (The cursor put on another row by the list, not by a key: a moment before it answers.)
        if was.is_some() && picker.current_id() != was { picker.landed = Some(Instant::now()) }
        app.modal = Some(Modal::Picker { kind, picker });
    }
}

fn new_what(app: &mut App, machine: String) { crate::new_harness::open(app, Some(machine), None) }

/// `agent_create`, then open it. [cwd] None with an agent = a new project folder.
/// tmux's split-window / new-window: a shell, now, on this pane's machine and in its folder
/// (`-c` another), running `command` if one is given. Keys typed before it is up go into it.
/// display-popup: a shell in a box over the window, running `command` then leaving (-E).
pub fn popup(app: &mut App, (x, y, w, h): (u16, u16, u16, u16), border: bool, cwd: Option<String>, command: Option<String>, title: String, close_on_exit: bool, look: crate::modal::PopupLook) {
    let focused = focused_agent(app);
    let machine = shell_machine(app, focused.as_ref());
    let live = focused.as_ref().and_then(|(m, a)| app.find_pane(m, a)).and_then(|(_, p)| app.panes.get(&p)).and_then(|p| p.cwd.clone().or_else(|| p.live_path.clone()));
    let cwd = cwd.or(live).or_else(|| focused.as_ref().and_then(|(m, a)| app.fleet.agent(m, a)).map(|a| a.cwd.clone()).filter(|c| !c.is_empty()));
    let Some(link) = app.link(&machine) else { app.print_new = None; return app.error("That machine is not connected") };
    let mut payload = json!({ "engine": "terminal", "creationId": uuid::Uuid::new_v4().to_string(), "bypassPermission": false });
    if let Some(cwd) = &cwd { payload["cwd"] = json!(cwd) }
    configure_local_shell(app, &machine, &mut payload);
    app.modal = None;
    // The command runs in the shell's place (-E: the popup goes when it ends) or in it; a leading
    // space keeps it out of the shell's history, `clear` off the screen.
    // `sh -c` takes the whole command line (`echo hi; read x`), as tmux runs it.
    let quoted = |c: &str| format!("'{}'", c.replace('\'', "'\\''"));
    let line = command.map(|c| if close_on_exit { format!(" clear; exec sh -c {}\r", quoted(&c)) } else { format!(" clear; sh -c {}\r", quoted(&c)) });
    let buffered = std::sync::Arc::new(std::sync::Mutex::new(line.map(|l| vec![l.into_bytes()]).unwrap_or_default()));
    app.starting_shell = Some(buffered.clone());
    app.shell_inputs.insert(app.tab().id.clone(), buffered.clone());
    app.spawn(async move { link.rpc("agent_create", payload, Duration::from_secs(60)).await }, move |app, reply| {
        let typed = take_shell_input(app, &buffered);
        let Ok(reply) = reply else { app.say("Could not start the popup", theme::DANGER); return };
        let Some(id) = reply.pointer("/agent/id").and_then(|v| v.as_str()) else { return };
        app.fleet.agents.insert((machine.clone(), id.to_string()), crate::fleet::agent_from(&machine, &reply["agent"], None));
        app.shells.insert((machine.clone(), id.to_string()));
        let pane = app.new_pane(&machine, id);
        // The far terminal is at least 40×12; the box shows it whole when it can.
        let inner = if border { 2 } else { 0 };
        let (cols, rows) = crate::pane::stream_size(w.saturating_sub(inner), h.saturating_sub(inner));
        if let Some(p) = app.panes.get_mut(&pane) { p.cols = cols; p.rows = rows; p.queued.extend(typed) }
        app.modal = Some(Modal::Popup { pane, x, y, width: w, height: h, border, title: title.clone(), look: look.clone() });
        app.open_stream(pane, true);
    });
}

/// A project's session: named for the project (its folder's name), each of its harnesses on that
/// machine in a window of its own, the most urgent first — made, or gone to and given the ones it
/// lacks.
pub fn project_session(app: &mut App, machine: &str, root: &str) {
    let name = crate::app::session_check_name(root.rsplit('/').next().unwrap_or(root)).unwrap_or_else(|| "project".into());
    let keys: Vec<(String, String)> = app.fleet.ranked().into_iter().filter(|a| a.machine_id == machine && a.project_root == root && a.status != "stopped").map(|a| a.key()).collect();
    if keys.is_empty() { return app.say(format!("{name} has no harnesses running"), theme::WARN) }
    match app.find_session(&format!("={name}")) {
        Some(id) => app.switch_session(id),
        None => { let id = app.empty_session(&name); app.switch_session(id) }
    }
    for (m, a) in keys { if app.find_pane(&m, &a).is_none() { app.open_agent(&m, &a, Placement::Window) } }
    // Its first window current, as a new session starts.
    if let Some(first) = (0..app.tabs.len()).min_by_key(|w| app.win_num(*w)) { app.select_tab(first) }
    app.save_sessions();
}

/// next-harness (C-b a): the next harness that needs you, in the order the harness list keeps —
/// waiting on you, failed, then done and unread, the one waiting longest first — or with
/// [back] the last of them. One already on screen is gone to; another is shown in the pane the
/// last C-b a used (in a window of its own the first time), so going down the queue keeps to one
/// window. Looking at it reads it: the counts on the status line go down.
pub fn next_attention(app: &mut App, back: bool) {
    use crate::fleet::State;
    let current = focused_agent(app);
    let mut queue: Vec<(String, String)> = app.fleet.ranked().into_iter()
        .filter(|a| a.status != "stopped" && matches!(app.fleet.state_of(a), State::NeedsInput | State::Failed | State::Done))
        .map(|a| a.key()).collect();
    if back { queue.reverse() }
    if queue.is_empty() { app.loop_seen.clear(); return app.say("Nothing needs you", theme::MUTED) }
    // Each once, in order; round again when all of them have been shown.
    if queue.iter().all(|k| app.loop_seen.contains(k) || current.as_ref() == Some(k)) { app.loop_seen.clear() }
    let Some((m, a)) = queue.iter().find(|k| current.as_ref() != Some(*k) && !app.loop_seen.contains(k)).or(queue.first()).cloned() else { return };
    app.loop_seen.push((m.clone(), a.clone()));
    if app.find_pane(&m, &a).is_some() { return app.open_agent(&m, &a, Placement::Tab) }
    // The loop's pane, wherever it is: gone to, and the next harness shown in it.
    match app.loop_pane.and_then(|p| app.tabs.iter().position(|t| t.panes().contains(&p)).map(|w| (w, p))) {
        Some((w, p)) => { app.focus_pane(w, p); app.open_agent(&m, &a, Placement::Replace) }
        None => app.open_agent(&m, &a, Placement::Tab),
    }
    app.loop_pane = app.find_pane(&m, &a).map(|(_, p)| p);
}

/// The same, for the pane `from` (new-window reads it before the new window takes the focus).
pub fn shell_machine(app: &App, focused: Option<&(String, String)>) -> String {
    let machine = focused.map(|(m,_)| m.clone()).unwrap_or(app.fleet.local_id.clone());
    if app.daemon_down && app.fleet.machine(&machine).is_some_and(|m| m.local) { crate::local::MACHINE.into() } else { machine }
}

pub(crate) fn configure_local_shell(app: &App, machine: &str, payload: &mut serde_json::Value) {
    if crate::local::is_local(machine) {
        payload["paneId"] = json!(crate::ids::next(crate::ids::Kind::Pane));
        let shell = app.options.session.get("default-shell").or_else(|| app.options.global_session.get("default-shell")).cloned()
            .or_else(|| std::env::var("SHELL").ok()).filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        payload["shell"] = json!(shell);
        payload["term"] = json!(app.options.get("default-terminal", "", None).unwrap_or_else(|| "tmux-256color".into()));
        let mut env: serde_json::Map<String, serde_json::Value> = app.global_env.iter().map(|(k,v)| (k.clone(), if v.hidden { serde_json::Value::Null } else { json!(v.value) })).collect();
        env.extend(app.session_env.iter().map(|(k,v)| (k.clone(), if v.hidden { serde_json::Value::Null } else { json!(v.value) })));
        payload["environment"] = json!(env);
    }
}

pub fn new_shell_from(app: &mut App, focused: Option<(String, String)>, placement: Placement, cwd: Option<String>, command: Option<String>) {
    new_shell_with_picker(app, focused, placement, cwd, command, false);
}

pub fn new_shell_with_picker(app: &mut App, focused: Option<(String, String)>, placement: Placement, cwd: Option<String>, command: Option<String>, choose_agent: bool) {
    let machine = shell_machine(app, focused.as_ref());
    let local = crate::local::is_local(&machine);
    if local { app.keep_local_shell_session() }
    let context = command.is_none().then(|| crate::shell_context::prepare(app, focused.as_ref(), !matches!(placement, Placement::Fill(_))));
    let init = context.as_ref().map(|token| {
        let cli = if local || app.fleet.machine(&machine).is_some_and(|m| m.local) { std::env::var("HARNESS_SHELL_CLI").ok() } else { None };
        let mut init = crate::shell_context::bootstrap(token, cli.as_deref(), local || app.fleet.machine(&machine).is_some_and(|m| m.local));
        if choose_agent && app.capture.is_none() && !app.headless { init.push("--pick-agent".into()); }
        init
    });
    // The folder: -c, else where the pane's shell says it is now (OSC 7), else where it started.
    let live = focused.as_ref().and_then(|(m, a)| app.find_pane(m, a)).and_then(|(_, p)| app.panes.get(&p)).and_then(|p| p.cwd.clone().or_else(|| p.live_path.clone()));
    let cwd = cwd.or(live).or_else(|| focused.as_ref().and_then(|(m, a)| app.fleet.agent(m, a)).map(|a| a.cwd.clone()).filter(|c| !c.is_empty()));
    let Some(link) = app.link(&machine) else { app.print_new = None; return app.error("That machine is not connected") };
    let mut payload = json!({ "engine": "terminal", "creationId": uuid::Uuid::new_v4().to_string(), "bypassPermission": false });
    if let Some(cwd) = &cwd { payload["cwd"] = json!(cwd) }
    if let Some(init) = &init { payload["argv"] = json!(init); }
    else if let Some(command) = &command {
        // Explicit tmux-style command requests are passed as one literal argument to the shell.
        let shell = app.options.get("default-shell", "", None).filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        payload["argv"] = json!([shell, "-c", command]);
    }
    configure_local_shell(app, &machine, &mut payload);
    app.modal = None;
    let start_command = command.clone();
    // The local supervisor starts commands directly and remembers them for respawn.
    if local { payload["command"] = json!(command); }
    let buffered = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    app.starting_shell = Some(buffered.clone());
    let tab = match &placement { Placement::Fill(id) => id.clone(), Placement::At(at) => at.tab.clone(), _ => app.tab().id.clone() };
    app.shell_inputs.insert(tab, buffered.clone());
    // Completion state belongs to this request, including concurrent -d/-P callers.
    let print_new = app.print_new.take();
    let from_cli = app.capture.is_some();
    // The session it was asked for in (a command's `-t work:` puts another in front for a moment):
    // where it goes when it comes, in front again for as long as that takes.
    // (A window's own: the session that has it — new -d's new session is not the one in front.)
    let session = match &placement {
        Placement::Fill(tab) if !app.tabs.iter().any(|t| &t.id == tab) => app.sessions.iter().find(|s| s.tabs.iter().any(|t| &t.id == tab)).map(|s| s.id).unwrap_or(app.session_id),
        _ => app.session_id,
    };
    app.spawn(async move {
        let result = if local { link.rpc("agent_create", payload, Duration::from_secs(60)).await }
            else { crate::shell_context::open_shell(&link, payload).await };
        result.map(|mut reply| {
            reply["_hnContext"] = json!(context);
            if reply.get("agent").is_some() { reply["agent"]["startCommand"] = json!(start_command); }
            reply
        })
    }, move |app, reply| {
        if session != app.session_id && app.swap_back.is_none() && app.sessions.iter().any(|s| s.id == session) {
            let back = app.session_id;
            app.swap_back = Some(back);
            app.swap_session(session);
            shell_made(app, machine, placement, reply, &buffered, print_new, from_cli);
            app.swap_back = None;
            app.swap_session(back);
            app.fit_panes();
            app.save_sessions();
            return;
        }
        shell_made(app, machine, placement, reply, &buffered, print_new, from_cli);
    });
}

fn take_shell_input(app: &mut App, buffered: &crate::app::ShellInput) -> Vec<Vec<u8>> {
    if app.starting_shell.as_ref().is_some_and(|current| std::sync::Arc::ptr_eq(current, buffered)) { app.starting_shell = None }
    app.shell_inputs.retain(|_, current| !std::sync::Arc::ptr_eq(current, buffered));
    std::mem::take(&mut *buffered.lock().unwrap())
}

/// A shell the machine made (agent_create's reply): into its place.
fn shell_made(app: &mut App, machine: String, placement: Placement, reply: Result<serde_json::Value, crate::daemon::RpcError>, buffered: &crate::app::ShellInput, print_new: Option<String>, from_cli: bool) {
    let typed = std::mem::take(&mut *buffered.lock().unwrap());
    let result = shell_placed(app, machine, placement, reply, typed, print_new);
    // Keep the pending window's initial size through placement and its first stream open.
    if app.starting_shell.as_ref().is_some_and(|current| std::sync::Arc::ptr_eq(current, buffered)) { app.starting_shell = None }
    app.shell_inputs.retain(|_, current| !std::sync::Arc::ptr_eq(current, buffered));
    if !from_cli {
        match &result {
            Ok((out, _)) => for line in out { app.say(line.clone(), theme::WARN) },
            Err(error) => app.say(error.clone(), theme::DANGER),
        }
    }
    // Release only this request's waiters, carrying its output, target and failure too.
    for (request, tx) in std::mem::take(&mut app.shell_waiters) {
        if std::sync::Arc::ptr_eq(&request, buffered) { let _ = tx.send(result.clone()); }
        else { app.shell_waiters.push((request, tx)); }
    }
}

fn shell_placed(app: &mut App, machine: String, placement: Placement, reply: Result<serde_json::Value, crate::daemon::RpcError>, typed: Vec<Vec<u8>>, print_new: Option<String>) -> crate::app::ShellCompletion {
    let reply = reply.map_err(|e| format!("create pane failed: {e}"))?;
    let id = reply.pointer("/agent/id").and_then(|v| v.as_str()).ok_or("The machine made no shell")?;
    app.fleet.agents.insert((machine.clone(), id.to_string()), crate::fleet::agent_from(&machine, &reply["agent"], None));
    app.shells.insert((machine.clone(), id.to_string()));
    if let Some(token) = reply["_hnContext"].as_str() {
        crate::shell_context::bind(app, token, &machine, id);

    }
    let new_window = matches!(&placement, Placement::Fill(_));
    app.open_agent(&machine, id, placement);
    let (session, _, pane) = app.find_pane_anywhere(&machine, id).ok_or("create pane failed: target window or pane disappeared")?;
    if let Some(p) = app.panes.get_mut(&pane) {
        p.queued.extend(typed);
        p.start_command = reply.pointer("/agent/startCommand").and_then(serde_json::Value::as_str).map(str::to_string);
    }
    crate::os_welcome::shell_created(app, pane);
    // A new session's first pane may belong to a session not currently in front.
    let (back, before) = (app.session_id, app.swap_back);
    if session != back { app.swap_back = Some(back); app.swap_session(session); }
    let Some(w) = app.tabs.iter().position(|t| t.panes().contains(&pane)) else {
        if session != back { app.swap_session(back); app.swap_back = before; }
        return Err("create pane failed: target session disappeared".into())
    };
    let tab = app.tabs[w].id.clone();
    if new_window {
        app.tabs[w].touch();
        if w != app.active { app.alert(w, crate::app::ACTIVITY) }
    }
    let out = print_new.map(|fmt| {
        crate::format::spans_for_pane(app, &fmt, w, pane, ratatui::style::Style::default()).into_iter().map(|s| s.content.into_owned()).collect()
    }).into_iter().collect();
    if session != back { app.swap_session(back); app.swap_back = before; }
    Ok((out, (session, tab, pane)))
}

fn create(app: &mut App, machine: String, what: What, cwd: Option<String>, message: Option<String>) { create_in(app, machine, what, cwd, message, false) }

/// agent_create: a harness on [machine] in [cwd] (none: a new project; [worktree]: a new git
/// worktree of it, on a branch of its own the daemon names), in the permission mode
/// @hn-permission-mode says (auto unless you set it: acceptEdits, plan, ask, full …).
fn create_in(app: &mut App, machine: String, what: What, cwd: Option<String>, message: Option<String>, worktree: bool) { create_opts(app, machine, what, cwd, message, worktree, NewOpts::default()) }

pub(crate) fn create_opts(app: &mut App, machine: String, what: What, cwd: Option<String>, message: Option<String>, worktree: bool, opts: NewOpts) {
    let machine = app.fleet.launch_machine_id(&machine).to_string();
    let Some(link) = app.link(&machine) else {
        if let Some(id) = &opts.form_id { crate::new_harness::completed(app, id, Some("That machine is not connected. Your draft is kept here.".into())); }
        return app.error("That machine is not connected")
    };
    let terminal = what.engine == "terminal";
    let mut payload = json!({ "engine": what.engine, "creationId": uuid::Uuid::new_v4().to_string(), "bypassPermission": !terminal });
    if terminal { configure_local_shell(app, &machine, &mut payload); }
    if let Some(dsh) = &what.dsh { payload["dsh"] = json!(dsh) }
    match &cwd {
        Some(cwd) if worktree => { payload["projectSource"] = json!("worktree"); payload["gitSource"] = json!(cwd) }
        Some(cwd) => payload["cwd"] = json!(cwd),
        None if !terminal => payload["projectSource"] = json!("new"),
        None => {}
    }
    if !terminal { payload["permissionMode"] = json!(app.options.get("@hn-permission-mode", "", None).filter(|m| !m.is_empty()).unwrap_or_else(|| "auto".into())) }
    if let Some(message) = message.filter(|m| !m.trim().is_empty()) { payload["prompt"] = json!(message.trim()) }
    if let Some(name) = opts.name.as_ref().filter(|n| !n.is_empty()) { payload["name"] = json!(name) }
    if let Some(extra) = opts.extra.as_ref().and_then(|v| v.as_object()) { for (key, value) in extra { payload[key] = value.clone(); } }
    if let Some(form_id) = &opts.form_id {
        if !crate::new_harness::record_attempt(app, form_id, crate::new_harness::Creation {
            id: payload["creationId"].as_str().unwrap().into(), machine: machine.clone(),
            session: opts.target.as_ref().map(|t| t.session).unwrap_or(app.session_id), target: opts.target.clone(),
        }) { return }
    }
    // (From a shell: nothing said on the way — a message there is the command's error.)
    if app.capture.is_none() { app.say(format!("Starting {} on {}…", what.label, app.fleet.machine_name(&machine)), theme::SOFT) }
    if opts.form_id.is_none() { app.modal = None; }
    // -P: the shell that asked waits for it, and is told where it is (as new-window -P).
    if opts.print.is_some() { app.print_new = opts.print.clone() }
    let session = opts.target.as_ref().map(|t| t.session).unwrap_or(app.session_id);
    let timeout = Duration::from_secs(if opts.form_id.is_some() { 20 } else { 180 });
    app.spawn(async move { link.rpc("agent_create", payload, timeout).await }, move |app, reply| {
        creation_finished(app, machine, session, opts, reply, false);
    });
}

pub(crate) fn check_creation(app: &mut App, form_id: String, attempt: crate::new_harness::Creation) {
    let opts = NewOpts { form_id: Some(form_id), target: attempt.target.clone(), ..Default::default() };
    let Some(link) = app.link(&attempt.machine) else {
        return creation_finished(app, attempt.machine, attempt.session, opts, Err(crate::daemon::RpcError::new("DISCONNECTED", "")), true);
    };
    app.spawn(async move {
        link.rpc("agent_create_status", json!({"creationId":attempt.id}), Duration::from_secs(10)).await
    }, move |app, reply| {
        creation_finished(app, attempt.machine, attempt.session, opts, reply, true);
    });
}

fn creation_finished(app: &mut App, machine: String, session: u32, opts: NewOpts, reply: Result<serde_json::Value, crate::daemon::RpcError>, checking: bool) {
    if let Some(id) = &opts.form_id {
        if !crate::new_harness::creation_reply(app, id, &reply, checking) { return }
    }
    match reply {
        Ok(reply) => {
            if let Some(id) = reply.pointer("/agent/id").and_then(|v| v.as_str()) {
                if let Some(form_id) = &opts.form_id { crate::new_harness::created(app, form_id, &reply["agent"]); }
                app.fleet.agents.insert((machine.clone(), id.to_string()), crate::fleet::agent_from(&machine, &reply["agent"], None));
                if reply["agent"]["engine"] == "terminal" { app.shells.insert((machine.clone(), id.to_string())); }
                // Keep new harnesses in the current window, filling it or splitting beside
                // the focused pane; -d keeps the previous pane focused.
                let back = (app.session_id, app.tab().id.clone());
                let swapped = session != app.session_id && app.swap_back.is_none() && app.sessions.iter().any(|s| s.id == session) && { app.swap_back = Some(back.0); app.swap_session(session) };
                let before = (app.tab().id.clone(), app.focused(), app.tab().zoomed);
                let lastw = app.lastw.clone();
                let target = opts.target.as_ref().and_then(|t| app.tabs.iter().position(|w| w.id == t.tab));
                if opts.target.is_none() || target.is_some() {
                    if let Some(i) = target { app.select_tab(i) }
                    app.open_agent(&machine, id, Placement::Auto(None));
                }
                if opts.detached || opts.target.as_ref().is_some_and(|t| t.tab != before.0) {
                    if let Some(i) = app.tabs.iter().position(|t| t.id == before.0) {
                        app.select_tab(i);
                        if let Some(pane) = before.1.filter(|p| app.tabs[i].panes().contains(p)) {
                            app.focus_pane(i, pane);
                            app.tabs[i].zoomed = before.2;
                            app.fit_panes();
                        }
                    }
                    if opts.target.is_some() { app.lastw = lastw; }
                }
                if let Some(fmt) = opts.print.as_ref().and(app.print_new.take()) {
                    let line = app.find_pane(&machine, id).map(|(w, p)| crate::format::spans_for_pane(app, &fmt, w, p, ratatui::style::Style::default()).into_iter().map(|s| s.content.into_owned()).collect::<String>()).unwrap_or_default();
                    if let Some(tx) = app.held_reply.take() { let _ = tx.send((vec![line], Vec::new(), 0)); }
                }
                if swapped { app.swap_back = None; app.swap_session(back.0); app.fit_panes(); app.save_sessions() }
                if opts.target.is_some() && target.is_none() {
                    app.say("Harness started. Open it from Sessions.", theme::SOFT);
                } else { app.toast = None; }
            } else {
                if let Some(tx) = app.held_reply.take().filter(|_| opts.print.is_some()) { app.print_new = None; let _ = tx.send((Vec::new(), vec!["the machine created no harness".into()], 1)); return }
                if let Some(form_id) = &opts.form_id { crate::new_harness::completed(app, form_id, Some("The machine created no harness — try again".into())); }
                app.say("The machine created no harness", theme::DANGER)
            }
        }
        Err(e) => {
            if let Some(tx) = app.held_reply.take().filter(|_| opts.print.is_some()) { app.print_new = None; let _ = tx.send((Vec::new(), vec![format!("create harness failed: {e}")], 1)); return }
            if let Some(form_id) = &opts.form_id { crate::new_harness::completed(app, form_id, Some(format!("Could not start it: {e}"))); }
            app.say(format!("Could not start it: {e}"), theme::DANGER)
        }
    }
}

pub(crate) fn modal_key(app: &mut App, key: KeyEvent) {
    let Some(modal) = app.modal.take() else { return };
    match modal {
        Modal::NewHarness(form) => crate::new_harness::key(app, form, key),
        Modal::Confirm { command, key: yes, enter_yes, .. } => {
            // tmux: the confirm key (y, or -c's) runs it, Enter too with -y; any other says no.
            if key.code == KeyCode::Char(yes) || (enter_yes && key.code == KeyCode::Enter) { commands::execute(app, &command) }
        }
        Modal::DisplayPanes { .. } => {}
        // tmux's menu (menu_key_cb): an item's key chooses it; ↑ k ↓ j move (round the ends,
        // past rules and disabled items), PPage C-b and NPage by five, g Home / G End the first
        // and last, Enter the chosen one, Escape C-c C-g q leave.
        Modal::Menu(mut menu) => {
            let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
            let name = keys::name(&keys::of(&key));
            // MENU_TAB (a prompt's completions): BSpace closes it, Tab moves down (past the last,
            // closes it).
            if menu.complete.is_some() {
                let last = menu.items.len().saturating_sub(1);
                let close = key.code == KeyCode::Backspace || (key.code == KeyCode::Tab && menu.choice == Some(last));
                if close { if let Some(c) = menu.complete.take() { complete_chosen(app, *c, None) } return }
                if key.code == KeyCode::Tab { menu.choice = Some(menu.choice.map(|c| (c + 1) % menu.items.len()).unwrap_or(0)); app.modal = Some(Modal::Menu(menu)); return }
                if matches!(key.code, KeyCode::Esc) || (matches!(key.code, KeyCode::Char('q')) && !ctrl) || (ctrl && matches!(key.code, KeyCode::Char('c' | 'g'))) {
                    if let Some(c) = menu.complete.take() { complete_chosen(app, *c, None) }
                    return;
                }
            }
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
        Modal::Popup { pane, x, y, width, height, border, title, look } => {
            if let Some(bytes) = app.panes.get(&pane).and_then(|p| encode_key(&for_pane(app, pane, key), p.mode())) {
                let live = app.panes.get(&pane).map(|p| p.stream.is_some()).unwrap_or(false);
                if live { app.send_input(pane, &bytes) } else if let Some(p) = app.panes.get_mut(&pane) { p.queued.push(bytes) }
            }
            app.modal = Some(Modal::Popup { pane, x, y, width, height, border, title, look });
        }
        Modal::Copy { pane } => { app.modal = Some(Modal::Copy { pane }); mode_key(app, pane, &keys::of(&key)); }
        Modal::Prompt(p) => {
            prompt_key(app, key, p);
            // A message or an answer typed from the list: back to it, its query and place kept.
            if app.modal.is_none() { if let Some(back) = app.back_to_list.take() { app.modal = Some(Modal::Picker { kind: back.0, picker: back.1 }); refill(app) } }
            else if !matches!(app.modal, Some(Modal::Prompt(_))) { app.back_to_list = None }
        }
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
        let template = template.clone();
        commands::execute_template(app, &template, &[name]);
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
    // choose-tree's prompts: a kill's answer is one character (PROMPT_SINGLE); cancelled, a
    // search or filter is cleared, as their callbacks are given nothing.
    if let PromptKind::Tree { pane, ask } = p.kind {
        let vi = app.options.get("status-keys", "", None).as_deref() == Some("vi");
        if ask.single() { if let KeyCode::Char(c) = key.code { if !ctrl && !alt { return crate::tree::answer(app, pane, ask, Some(&c.to_string())) } } }
        if (key.code == KeyCode::Esc && !vi) || (ctrl && matches!(key.code, KeyCode::Char('c' | 'g'))) { return crate::tree::answer(app, pane, ask, None) }
    }
    let (single, incremental, ptype) = match &p.kind { PromptKind::Command { one, incremental, ptype, .. } => (*one, *incremental, *ptype), PromptKind::Tree { ask, .. } => (false, false, ask.ptype()), _ => (false, false, 0) };
    // status-keys vi (tmux's default when $EDITOR names vi): Esc leaves insert for normal mode.
    let vi = app.options.get("status-keys", "", None).as_deref() == Some("vi");
    if vi && p.vi_normal { prompt_vi_normal(app, key, p); return }
    if vi && key.code == KeyCode::Esc && !ctrl && !alt { p.vi_normal = true; app.modal = Some(Modal::Prompt(p)); return }
    // Entry mode (status_prompt_translate_key): these keys do what emacs's do, a character is
    // typed, and any other key (C-b, C-f, M-f …) does nothing.
    if vi {
        let listed = match key.code {
            KeyCode::Char(c) if ctrl && !alt => matches!(c, 'a' | 'c' | 'e' | 'g' | 'h' | 'k' | 'n' | 'p' | 't' | 'u' | 'v' | 'w' | 'y'),
            KeyCode::Char(_) => !alt,
            KeyCode::Tab | KeyCode::Enter | KeyCode::Backspace | KeyCode::Delete | KeyCode::Down | KeyCode::End | KeyCode::Home | KeyCode::Up => !alt && !ctrl,
            KeyCode::Left | KeyCode::Right => !alt,
            _ => false,
        };
        if !listed { app.modal = Some(Modal::Prompt(p)); return }
    }
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
            if !p.value.is_empty() && matches!(p.kind, PromptKind::Command { .. } | PromptKind::Tree { .. }) { add_history(app, ptype, &p.value) }
            // An incremental prompt has done its work as it went.
            if incremental { return }
            submit_prompt(app, p);
            return;
        }
        // BSpace and C-h: the character before the cursor (none, and the prompt stays, at its
        // start); M-BSpace is no key of tmux's prompt.
        KeyCode::Backspace | KeyCode::Char('h') if (key.code == KeyCode::Backspace || ctrl) && !alt => {
            if at > 0 { let mut v = chars.clone(); v.remove(at - 1); set(&mut p, v, at - 1); changed = true }
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
        // status_prompt_replace_complete: the word at the cursor completed — the only match and
        // a space, else the part every match shares; when that is the word already, a menu of
        // them (Tab or its key picks one).
        KeyCode::Tab if matches!(p.kind, PromptKind::Command { .. } | PromptKind::Tree { .. }) => {
            match complete_prompt(app, &mut p, ptype) {
                Some(menu) => { app.modal = Some(Modal::Menu(menu)); return }
                None => changed = true,
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

/// status_prompt_replace_complete's word: where the one at the cursor starts and ends.
fn prompt_word(chars: &[char], cursor: usize) -> Option<(usize, usize)> {
    let at = |i: usize| chars.get(i).copied();
    let space = |i: usize| at(i) == Some(' ');
    let idx = cursor.saturating_sub(1);
    let mut first = idx;
    while first > 0 && !space(first) { first -= 1 }
    while at(first).is_some() && space(first) { first += 1 }
    let mut last = idx;
    while at(last).is_some() && !space(last) { last += 1 }
    while last > 0 && space(last) { last -= 1 }
    if at(last).is_some() { last += 1 }
    (last >= first).then_some((first, last))
}

/// The word at the cursor made [s], the cursor after it.
fn prompt_replace(p: &mut Prompt, s: &str) -> bool {
    let chars: Vec<char> = p.value.chars().collect();
    let Some((first, last)) = prompt_word(&chars, p.cursor) else { return false };
    let mut v: Vec<char> = chars[..first].to_vec();
    v.extend(s.chars());
    v.extend(&chars[last..]);
    p.value = v.into_iter().collect();
    p.cursor = first + s.chars().count();
    true
}

/// status_prompt_complete_list: the commands and their aliases, command-alias's names; past the
/// first word, every option and layout too — each once.
fn complete_list(app: &App, s: &str, at_start: bool) -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    let mut add = |w: &str| if !list.iter().any(|x| x == w) { list.push(w.to_string()) };
    for e in crate::cmd::TABLE.iter() {
        if e.name.starts_with(s) { add(e.name) }
        if !e.alias.is_empty() && e.alias.starts_with(s) { add(e.alias) }
    }
    for a in app.options.array("command-alias") {
        if let Some((name, _)) = a.split_once('=') { if s.len() <= name.len() && name.starts_with(s) { add(name) } }
    }
    if at_start { return list }
    for name in crate::options::names() { if name.starts_with(s) { add(name) } }
    for l in ["even-horizontal", "even-vertical", "main-horizontal", "main-horizontal-mirrored", "main-vertical", "main-vertical-mirrored", "tiled"] { if l.starts_with(s) { add(l) } }
    list
}

/// status_prompt_complete_prefix: what every word of [list] starts with.
fn complete_prefix(list: &[String]) -> Option<String> {
    let mut out: Vec<char> = list.first()?.chars().collect();
    for w in &list[1..] {
        let w: Vec<char> = w.chars().collect();
        let mut j = w.len().min(out.len());
        out.truncate(j);
        while j > 0 { if out[j - 1] != w[j - 1] { out.truncate(j - 1) } j -= 1 }
    }
    Some(out.into_iter().collect())
}

/// Tab in a prompt (status_prompt_complete): the word at the cursor completed in [p], or a menu
/// of the words it could be (the prompt inside it).
fn complete_prompt(app: &App, p: &mut Prompt, ptype: usize) -> Option<crate::modal::Menu> {
    let chars: Vec<char> = p.value.chars().collect();
    let (first, last) = prompt_word(&chars, p.cursor)?;
    let word: String = chars[first..last].iter().collect();
    let (target, window_target) = (ptype == 2 || ptype == 3, ptype == 3);
    if word.is_empty() && !target { return None }
    let mut offset = first;
    let mut list: Vec<String> = Vec::new();
    let mut flag = None;
    let mut out: Option<String> = None;
    if !target && !word.starts_with("-t") && !word.starts_with("-s") {
        list = complete_list(app, &word, first == 0);
        out = match list.len() { 0 => None, 1 => Some(format!("{} ", list[0])), _ => complete_prefix(&list) };
    } else {
        let s: String = if target { word.clone() } else { flag = word.chars().nth(1); offset += 2; word.chars().skip(2).collect() };
        let menu_of = |app: &App, sid: u32, s: &str, list: &mut Vec<String>| -> Result<Option<String>, crate::modal::Menu> { window_menu(app, p, sid, s, offset, flag, window_target, list) };
        if window_target {
            match menu_of(app, app.session_id, &s, &mut list) { Ok(Some(w)) => { prompt_set(p, &w, window_target); return None } Ok(None) => return None, Err(m) => return Some(m) }
        }
        match s.find(':') {
            // status_prompt_complete_session: `name:` (or `$N:`) of each session it starts.
            None => {
                for (id, name) in app.session_list() {
                    if s.is_empty() || name.starts_with(&s) { list.push(format!("{name}:")) }
                    else if let Some(n) = s.strip_prefix('$') { if id.to_string().starts_with(n) { list.push(format!("${id}:")) } }
                }
                out = complete_prefix(&list).map(|o| match flag { Some(f) => format!("-{f}{o}"), None => o });
            }
            Some(colon) if !s[colon + 1..].contains('.') => {
                let sid = if s.starts_with(':') { Some(app.session_id) } else { app.session_list().into_iter().find(|(_, n)| *n == s[..colon]).map(|(i, _)| i) };
                let Some(sid) = sid else { return None };
                let mut windows = Vec::new();
                match menu_of(app, sid, &s[colon + 1..], &mut windows) { Ok(Some(w)) => out = Some(w), Ok(None) => return None, Err(m) => return Some(m) }
            }
            _ => {}
        }
    }
    list.sort();
    if out.as_deref() == Some(word.as_str()) { out = None }
    if let Some(o) = out { prompt_replace(p, &o); return None }
    complete_menu(app, p, list, offset, flag, false)
}

/// The prompt's word made [s] — for a window target's prompt, the whole line.
fn prompt_set(p: &mut Prompt, s: &str, window_target: bool) {
    if window_target { p.value = s.to_string(); p.cursor = p.value.chars().count() } else { prompt_replace(p, s); }
}

/// status_prompt_complete_list_menu: the words (the last ten, as many as fit above the status
/// line), each with its digit, over the prompt where the word starts; none for one word.
fn complete_menu(app: &App, p: &Prompt, list: Vec<String>, offset: usize, flag: Option<char>, window_target: bool) -> Option<crate::modal::Menu> {
    let size = list.len();
    let lines = app.status_lines();
    if size <= 1 || app.size.1.saturating_sub(lines) < 3 { return None }
    let height = (app.size.1 - lines - 2).min(10).min(size as u16) as usize;
    let start = size - height;
    let items: Vec<crate::modal::MenuItem> = list[start..].iter().enumerate().map(|(i, w)| crate::modal::MenuItem { label: w.clone(), key: ((b'0' + i as u8) as char).to_string(), command: String::new(), disabled: false, separator: false }).collect();
    Some(prompt_menu(app, p, items, list[start..].to_vec(), offset, flag, window_target))
}

/// A completion menu placed as tmux's: at the word's column (less the box's two), right above
/// the status line (below it at the top), kept on the screen.
fn prompt_menu(app: &App, p: &Prompt, items: Vec<crate::modal::MenuItem>, list: Vec<String>, offset: usize, flag: Option<char>, window_target: bool) -> crate::modal::Menu {
    let lines = app.status_lines();
    let width = items.iter().map(|it| crate::draw::format_width(&it.label) + it.key.chars().count() + 3).max().unwrap_or(0) as u16;
    let height = items.len() as u16;
    let y = if app.status_top { lines } else { app.size.1.saturating_sub(3 + height) };
    let x = (offset + unicode_width::UnicodeWidthStr::width(p.label.as_str())).saturating_sub(2) as u16;
    let x = x.min(app.size.0.saturating_sub(width + 4));
    crate::modal::Menu { title: String::new(), items, choice: Some(0), x, y, width, stay_open: false, no_mouse: true, mouse: None, tree: None, responsive: None,
        complete: Some(Box::new(crate::modal::Complete { prompt: p.clone(), list, flag, window_target })) }
}

/// status_prompt_complete_window_menu: session [sid]'s windows whose number starts [word] —
/// the one there is (Ok(Some)), none (Ok(None)), else a menu of up to ten.
#[allow(clippy::too_many_arguments)]
fn window_menu(app: &App, p: &Prompt, sid: u32, word: &str, offset: usize, flag: Option<char>, window_target: bool, list: &mut Vec<String>) -> Result<Option<String>, crate::modal::Menu> {
    let lines = app.status_lines();
    if app.size.1.saturating_sub(lines) < 3 { return Ok(None) }
    let height = (app.size.1 - lines - 2).min(10) as usize;
    let name = app.session_list().into_iter().find(|(i, _)| *i == sid).map(|(_, n)| n).unwrap_or_default();
    let mut items = Vec::new();
    for (num, wname, _) in app.session_windows(sid) {
        if !word.is_empty() && !num.to_string().starts_with(word) { continue }
        let (label, w) = if window_target { (format!("{num} ({wname})"), num.to_string()) } else { (format!("{name}:{num} ({wname})"), format!("{name}:{num}")) };
        items.push(crate::modal::MenuItem { label, key: ((b'0' + list.len() as u8) as char).to_string(), command: String::new(), disabled: false, separator: false });
        list.push(w);
        if list.len() == height { break }
    }
    match list.len() {
        0 => Ok(None),
        1 => Ok(Some(match flag { Some(f) => format!("-{f}{}", list[0]), None => list[0].clone() })),
        _ => Err(prompt_menu(app, p, items, list.clone(), offset, flag, window_target)),
    }
}

/// A completion menu's item chosen (status_prompt_menu_callback): its word into the prompt,
/// which is back; closed without one, the prompt as it was.
fn complete_chosen(app: &mut App, c: crate::modal::Complete, choice: Option<usize>) {
    let mut p = c.prompt;
    if let Some(w) = choice.and_then(|i| c.list.get(i)) {
        let s = match c.flag { Some(f) => format!("-{f}{w}"), None => w.clone() };
        prompt_set(&mut p, &s, c.window_target);
    }
    app.modal = Some(Modal::Prompt(p));
}

/// An incremental prompt's text changed: its template runs with it, after `=` (as typed), `+`
/// (C-s: again, forward) or `-` (C-r: again, back).
pub fn prompt_changed(app: &mut App, p: &Prompt, prefix: char) {
    let PromptKind::Command { template: Some(t), answers, .. } = &p.kind else { return };
    let text = format!("{prefix}{}", p.value);
    let mut all = answers.clone();
    all.push(text);
    let t = t.clone();
    let was = app.modal.take();
    commands::execute_template(app, &t, &all);
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
pub(crate) fn add_history(app: &mut App, ptype: usize, line: &str) {
    crate::history::add(app, ptype, line);
}

/// status_prompt_up_history / _down_history: the prompt's type's history a step back or on
/// (the step past the newest is an empty line). False when there is nowhere to go.
fn prompt_history(app: &App, p: &mut Prompt, up: bool) -> bool {
    let ptype = match &p.kind { PromptKind::Command { ptype, .. } => *ptype, PromptKind::Tree { ask, .. } => ask.ptype(), _ => 0 };
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

/// status_prompt_translate_key in command mode (status-keys vi, after Esc): each key stands for
/// an emacs key and runs as it — `$` End (past the last character), `0` `^` Home, `x` `s` Delete,
/// `X` BSpace, `D` `C` C-k, `d` C-u, `p` C-y, `q` C-c, `h` `j` `k` `l` the arrows, BSpace Left;
/// `w` `W` `e` `E` `b` `B` the words. `i` and Esc go back to entry; so do `a` `A` `I` `C` `s`
/// `S`, after what they do. Any other key does nothing.
fn prompt_vi_normal(app: &mut App, key: KeyEvent, mut p: Prompt) {
    use KeyCode::*;
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let plain = |code: KeyCode| KeyEvent::new(code, KeyModifiers::NONE);
    let with = |c: char, m: KeyModifiers| KeyEvent::new(Char(c), m);
    // The first switch: back to entry mode, with nothing more (i, Esc) or after it (the rest).
    let entry = match key.code {
        Char('i') | Esc if !ctrl => { p.vi_normal = false; app.modal = Some(Modal::Prompt(p)); return }
        Char('S') if !ctrl => { p.vi_normal = false; return prompt_key(app, with('u', KeyModifiers::CONTROL), p) }
        Char('A' | 'I' | 'C' | 's' | 'a') if !ctrl => true,
        _ => false,
    };
    // The words (M-b, and the vi ones, KEYC_VI): moved here, as tmux's status_prompt_key moves them.
    let ws = app.options.get("word-separators", "", None).unwrap_or_default();
    let chars: Vec<char> = p.value.chars().collect();
    let at = p.cursor.min(chars.len());
    let word = match key.code {
        Char('w') if !ctrl => Some(forward_word_vi(&chars, at, &ws)),
        Char('W') if !ctrl => Some(forward_word_vi(&chars, at, "")),
        Char('e') if !ctrl => Some(end_word(&chars, at, &ws)),
        Char('E') if !ctrl => Some(end_word(&chars, at, "")),
        Char('b') if !ctrl => Some(backward_word(&chars, at, &ws)),
        Char('B') if !ctrl => Some(backward_word(&chars, at, "")),
        _ => None,
    };
    if let Some(to) = word {
        p.cursor = to;
        if matches!(p.kind, PromptKind::Command { incremental: true, .. }) { prompt_changed(app, &p, '=') }
        app.modal = Some(Modal::Prompt(p));
        return;
    }
    let translated = match key.code {
        Backspace => plain(Left),
        Char('A' | '$') if !ctrl => plain(End),
        Char('I' | '0' | '^') if !ctrl => plain(Home),
        Char('C' | 'D') if !ctrl => with('k', KeyModifiers::CONTROL),
        Char('X') if !ctrl => plain(Backspace),
        Char('d') if !ctrl => with('u', KeyModifiers::CONTROL),
        Char('p') if !ctrl => with('y', KeyModifiers::CONTROL),
        Char('q') if !ctrl => with('c', KeyModifiers::CONTROL),
        Char('s' | 'x') if !ctrl => plain(Delete),
        Delete => plain(Delete),
        Down | Char('j') if !ctrl => plain(Down),
        Left | Char('h') if !ctrl => plain(Left),
        Right | Char('a' | 'l') if !ctrl => plain(Right),
        Up | Char('k') if !ctrl => plain(Up),
        Char('h' | 'c') if ctrl => key,
        Enter => key,
        _ => { app.modal = Some(Modal::Prompt(p)); return }
    };
    p.vi_normal = false;
    let ends = translated.code == Enter || (translated.code == Char('c') && translated.modifiers.contains(KeyModifiers::CONTROL));
    prompt_key(app, translated, p);
    // Still in command mode after it (not a key that went back to entry, nor one that ended it).
    if !entry && !ends { if let Some(Modal::Prompt(q)) = app.modal.as_mut() { q.vi_normal = true } }
}

/// status_prompt_forward_word in vi mode: over the word, then over the blanks after it.
fn forward_word_vi(chars: &[char], at: usize, ws: &str) -> usize {
    let size = chars.len();
    let space = |i: usize| chars.get(i) == Some(&' ');
    let in_list = |i: usize| chars.get(i).map(|c| ws.contains(*c)).unwrap_or(false);
    let mut idx = at;
    if idx == size { return idx }
    let word_is_separators = in_list(idx) && !space(idx);
    loop {
        idx += 1;
        if space(idx) { while idx != size && space(idx) { idx += 1 } break }
        if !(idx != size && word_is_separators == in_list(idx)) { break }
    }
    idx
}

/// status_prompt_end_word: to the last character of this word or the next.
fn end_word(chars: &[char], at: usize, ws: &str) -> usize {
    let size = chars.len();
    let space = |i: usize| chars.get(i) == Some(&' ');
    let in_list = |i: usize| chars.get(i).map(|c| ws.contains(*c)).unwrap_or(false);
    let mut idx = at;
    if idx == size { return idx }
    loop { idx += 1; if idx == size { return idx } if !space(idx) { break } }
    let word_is_separators = in_list(idx);
    loop { idx += 1; if idx == size || space(idx) || word_is_separators != in_list(idx) { break } }
    idx - 1
}

pub fn schedule_said(app: &mut App, kind: &PickerKind, picker: &Picker) {
    // search(...) changes the effective expression without changing the displayed input.
    // Schedule after change bindings, so the entire action chain has taken effect.
    let expression = picker.search.as_deref().unwrap_or(&picker.query);
    let wanted = if matches!(kind, PickerKind::Open { project: None, .. }) && crate::picker::scope_of(&picker.query).is_none() && !crate::picker::said_searches(expression).is_empty() { expression.to_string() } else { String::new() };
    if wanted != app.said_want {
        app.said_want = wanted;
        app.said_pending = 0;
        app.said_generation = app.said_generation.wrapping_add(1);
        if !app.said_want.is_empty() { app.said_due = Some(Instant::now() + Duration::from_millis(150)) }
        else { app.said_due = None; app.said.clear(); app.said_for.clear() }
    }
}

/// fzf's keys: ↑ C-k C-p away from the prompt, ↓ C-j C-n toward it (the list reads bottom-up);
/// Tab marks; C-t/C-x/C-v open in a new window / below / beside (fzf.vim); C-/ the preview.
fn picker_key(app: &mut App, key: KeyEvent, kind: PickerKind, picker: Picker) {
    // ── machines & devices ── (a line typed or a y/n answered in the panel; Esc/← a level back)
    let (kind, picker) = match crate::devices::key(app, kind, picker, key) { Ok(()) => return, Err(back) => back };
    let (kind, mut picker) = match crate::hardware::key(app, kind, picker, key) { Ok(()) => return, Err(back) => back };
    // A key: the list follows the cursor again (the wheel had left it where it put it).
    picker.free_scroll = false;
    // A row a key goes to is one you chose to look at (the list moving it there is not).
    let was = picker.current_id();
    let key_moves = matches!(key.code, KeyCode::Up | KeyCode::Down | KeyCode::PageUp | KeyCode::PageDown | KeyCode::Tab | KeyCode::BackTab)
        || (key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('j' | 'k' | 'n' | 'p')));
    if key_moves { picker.landed = None }
    let _ = was;
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    // A shell helper is waiting for a reply. Closing its picker must release it.
    if (matches!(kind, PickerKind::ShellContext) || app.shell_context.session_picker.is_some())
        && (key.code == KeyCode::Esc || (ctrl && key.code == KeyCode::Char('c'))) {
        crate::shell_context::cancel(app);
        app.shell_context.session_picker = None;
        app.shell_context.sessions_machine = None;
        return;
    }
    // ── keys ── Alt-k on a command: the next key you press is its key (Ctrl-k moves, as in fzf).
    if matches!(kind, PickerKind::Commands) && alt && !ctrl && key.code == KeyCode::Char('k') {
        crate::settings::capture_for_row(app, &mut picker);
        app.modal = Some(Modal::Picker { kind, picker });
        return;
    }
    // Jump mode consumes one key, then fires jump or jump-cancel as fzf does.
    if let Some(accept) = picker.jumping.take() {
        let mut event = "jump-cancel";
        if let KeyCode::Char(c) = key.code {
            let rows = picker.page_rows.get().max(0) as usize;
            if let Some(k) = theme::fzf_opts().jump_labels.chars().position(|l| l == c).filter(|k| !ctrl && !alt && *k < rows && picker.scroll + k < picker.visible.len()) {
                picker.vset((picker.scroll + k) as i64, 1);
                event = "jump";
                if accept { return choose(app, kind, picker, Choice::Enter) }
            }
        }
        let multi = picker.multi_override.map(|n| n > 0).unwrap_or((matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) || theme::fzf_opts().multi) && crate::picker::scope_of(&picker.query).is_none());
        let up = if crate::settings::top_down(&kind) { -1 } else { 1 };
        if let Some(actions) = theme::fzf_opts().binds.iter().rev().find(|(key, _)| key == event).map(|(_, actions)| actions.clone()) {
            let previous_query = picker.query.clone();
            let previous_search = picker.search.clone();
            picker.defer_filter = true;
            match bound_actions(&mut picker, &actions, up, multi) {
                End::Accept => { picker.defer_filter = false; return choose(app, kind, picker, Choice::Enter) }
                End::Abort => { crate::shell_context::cancel(app); app.shell_context.session_picker = None; SPLIT.with(|s| s.set(None)); return }
                End::Stay => {}
            }
            picker.defer_filter = false;
            if picker.query != previous_query && picker.search == previous_search { picker.search = Some(previous_search.unwrap_or(previous_query)); }
        }
        schedule_said(app, &kind, &picker);
        app.modal = Some(Modal::Picker { kind, picker });
        return;
    }
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
    // (--multi in FZF_DEFAULT_OPTS: every list takes marks, as fzf's do.)
    let multi = (matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) || theme::fzf_opts().multi) && crate::picker::scope_of(&picker.query).is_none();
    // change-multi: the list takes marks, or not, as it said.
    let multi = picker.multi_override.map(|n| n > 0).unwrap_or(multi);
    // unbind / toggle-bind: that key does nothing in this list now.
    if picker.unbound.contains(&fzf_key_name(&key)) { app.modal = Some(Modal::Picker { kind, picker }); return }
    let up: i64 = if crate::settings::top_down(&kind) { -1 } else { 1 };
    // ── tabs ── The launcher's tab row: ↓ past the list's last row goes onto it; there ←/→ open the
    // next tab (as typing its character does), ↑ or Enter goes back to the list, and any other key
    // does what it does in the list — a key typed searches the tab chosen, Esc closes.
    let mut tabbed = false;
    if modal::is_launcher(&kind) && !ctrl && !alt && !shift {
        if picker.on_tabs {
            match key.code {
                KeyCode::Left | KeyCode::Right => {
                    picker.query = modal::next_tab(&picker.query, if key.code == KeyCode::Right { 1 } else { -1 });
                    picker.qcursor = picker.query.chars().count();
                    tabbed = true;
                }
                KeyCode::Up | KeyCode::Enter => { picker.on_tabs = false; app.modal = Some(Modal::Picker { kind, picker }); return }
                KeyCode::Down => { app.modal = Some(Modal::Picker { kind, picker }); return }
                _ => picker.on_tabs = false,
            }
        } else if key.code == KeyCode::Down && !(0..picker.visible.len() as i64).contains(&(picker.cursor as i64 - up)) {
            picker.on_tabs = true;
            app.modal = Some(Modal::Picker { kind, picker });
            return;
        }
    }
    // FZF_DEFAULT_OPTS --bind: your key:action pairs come first (the last bind for a key wins,
    // as in fzf). A key bound only to what hn does not run (execute, become, reload …) keeps this
    // list's own meaning of it; one with an action hn runs never falls back to it.
    let name = fzf_key_name(&key);
    let bound = theme::fzf_opts().binds.iter().rev().find(|(k, _)| *k == name).map(|(_, a)| a.clone()).filter(|a| !falls_back(&name, a));
    if tabbed {} else if let Some(actions) = bound {
        match bound_actions(&mut picker, &actions, up, multi) {
            End::Accept => { choose(app, kind, picker, Choice::Enter); return }
            End::Abort => { crate::shell_context::cancel(app); app.shell_context.session_picker = None; SPLIT.with(|s| s.set(None)); return }
            End::Stay => {}
        }
    } else {
        // The look/theme picker: right on a section opens it, left/Esc steps out one level (a plain
        // arrow with an empty query — with a query they edit the query, as fzf's do).
        if matches!(kind, PickerKind::Theme) {
            let no_mod = !ctrl && !alt && !shift;
            if no_mod && key.code == KeyCode::Right && picker.query.is_empty() {
                if let Some(sec) = picker.current_id().and_then(|id| id.strip_prefix("section:").map(|s| s.to_string())) {
                    crate::settings::open_section(app, &mut picker, &sec);
                    app.modal = Some(Modal::Picker { kind, picker });
                    return;
                }
            }
            let back = (no_mod && key.code == KeyCode::Left && picker.query.is_empty()) || key.code == KeyCode::Esc;
            if back && picker.theme_in.is_some() {
                crate::settings::close_section(app, &mut picker);
                app.modal = Some(Modal::Picker { kind, picker });
                return;
            }
            // Opened from the command list: Esc (or ← on the sections) is a step back to it.
            if back && picker.from_commands {
                crate::settings::back_to_commands(app, &mut picker);
                app.modal = Some(Modal::Picker { kind: PickerKind::Commands, picker });
                return;
            }
        }
        // A model's question (Enter · Esc): Esc takes it back, and the view stays.
        if matches!(kind, PickerKind::Models) && key.code == KeyCode::Esc && crate::models::cancel(app, &mut picker) { app.modal = Some(Modal::Picker { kind, picker }); return }
        // tmux's commands, opened from their row: Esc is a step back to hn's.
        if matches!(kind, PickerKind::Commands) && key.code == KeyCode::Esc && crate::settings::in_tmux(&picker) {
            crate::settings::back_to_commands_at(app, &mut picker, "cmd:tmux-commands");
            app.modal = Some(Modal::Picker { kind, picker });
            return;
        }
        // ── keys ── Keybinds opened from the command list: Esc is a step back to it.
        if matches!(kind, PickerKind::Keybinds) && key.code == KeyCode::Esc && picker.from_commands {
            crate::settings::back_to_commands_at(app, &mut picker, "cmd:keybinds");
            app.modal = Some(Modal::Picker { kind: PickerKind::Commands, picker });
            return;
        }
        match key.code {
            KeyCode::Esc => { SPLIT.with(|s| s.set(None)); return }
            KeyCode::Char('c' | 'g' | 'q') if ctrl => { SPLIT.with(|s| s.set(None)); return }
            KeyCode::Up if shift => picker.preview_by(-1),
            KeyCode::Down if shift => picker.preview_by(1),
            // Up is toward the top of the screen: further down the list, unless it is reversed.
            KeyCode::Up => picker.move_by(up),
            KeyCode::Down => picker.move_by(-up),
            // --history: C-p and C-n go back and forth through its queries (fzf binds them so).
            KeyCode::Char('p') if ctrl && theme::fzf_opts().history.is_some() => picker.history_step(true),
            KeyCode::Char('n') if ctrl && theme::fzf_opts().history.is_some() => picker.history_step(false),
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
            KeyCode::Char('/' | '_' | '7') if ctrl => picker.show_preview(None),
            // fzf 0.67's alt-/: toggle-wrap (its ctrl-/ too; here C-/ stays the preview's, as fzf's
            // README binds it).
            KeyCode::Char('/') if alt => picker.toggle_wrap(),
            KeyCode::Char(c @ '1'..='9') if alt => { answer_from(app, &kind, &mut picker, c as usize - '1' as usize) }
            // M-m: read (done ✓, or failed ✗ from an error) without opening it; M-M: every row shown.
            KeyCode::Char('m' | 'M') if alt && matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) => {
                let all = key.code == KeyCode::Char('M') || key.modifiers.contains(KeyModifiers::SHIFT);
                let ids: Vec<String> = if all { picker.visible.iter().map(|(i, _)| picker.rows[*i].id.clone()).collect() } else { picker.current_id().into_iter().collect() };
                let mut n = 0;
                for id in ids { if let Some(key) = split_key(&id) { if mark_read(app, key) { n += 1 } } }
                picker.say(match n { 0 => "Nothing to mark read".to_string(), 1 => "Marked read".to_string(), n => format!("{n} marked read") });
            }
            // M-r: restart it (a failed one, say); M-s: a message to it.
            KeyCode::Char('r') if alt && matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) => {
                if let Some((machine, agent)) = picker.current_id().and_then(|id| split_key(&id)) {
                    let name = app.fleet.agent(&machine, &agent).map(|a| a.name.clone()).unwrap_or_default();
                    // A working one's turn would be lost: its key again says so (as C-b R asks y/n).
                    if confirmed(app, &mut picker, 'r', &machine, &agent, &format!("M-r again restarts {name} — it is working")) {
                    if let Some(link) = app.link(&machine) {
                        picker.say(format!("Restarting {name}…"));
                        let m = machine.clone();
                        app.spawn(async move { link.rpc("agent_restart", json!({ "agentId": agent, "creationId": uuid::Uuid::new_v4().to_string() }), Duration::from_secs(120)).await }, move |app, reply| {
                            if let Err(e) = reply { app.say(format!("Could not restart it: {e}"), theme::DANGER) }
                            app.relist(&m);
                        });
                    }
                    }
                }
            }
            KeyCode::Char('s') if alt && matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) => {
                if let Some((machine, agent)) = picker.current_id().and_then(|id| split_key(&id)) {
                    let name = app.fleet.agent(&machine, &agent).map(|a| a.name.clone()).unwrap_or_default();
                    app.back_to_list = Some(Box::new((kind, picker)));
                    return prompt(app, PromptKind::Message { machine, agent }, "Message", &name, &format!("to {name}"), "", false);
                }
            }
            // M-a: the question's answer typed — option numbers (several for a multi-choice one) or
            // your own words.
            KeyCode::Char('a') if alt && matches!(kind, PickerKind::Open { .. } | PickerKind::Inbox) => {
                if let Some((machine, agent)) = picker.current_id().and_then(|id| split_key(&id)) {
                    if let Some(q) = app.fleet.agent(&machine, &agent).and_then(|a| a.question.clone()) {
                        let row = format!("{machine}:{agent}");
                        let row = picker.current_id().unwrap_or(row);
                        let request = match answerable(app, &picker, &row) { Ok(r) => r, Err(why) => { picker.say(why); app.modal = Some(Modal::Picker { kind, picker }); return } };
                        let how = if q.multi { format!("1–{} (several: 1,3) or your own words", q.options.len()) } else if q.options.is_empty() { "your answer".to_string() } else { format!("1–{} or your own words", q.options.len()) };
                        // Who asks and what, while you type (the list is gone behind the prompt).
                        let name = app.fleet.agent(&machine, &agent).map(|a| crate::format::short_name(&a.name, 24)).unwrap_or_default();
                        let mut p = Prompt::status(PromptKind::Answer { machine, agent, request }, &format!("({name}) "), "");
                        p.title = "Answer".into();
                        p.hint = format!("{} — {how}", q.prompt);
                        app.back_to_list = Some(Box::new((kind, picker)));
                        app.modal = Some(Modal::Prompt(p));
                        return;
                    }
                }
            }
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
        let scope = |q: &str| crate::picker::scope_of(q);
        if scope(&picker.query) != scope(&before) { picker.marked.clear() }
        let (next, changed) = remode(app, kind, &mut picker);
        kind = next;
        if changed { prepare(app, &kind); fill(app, &kind, &mut picker) }
        // ── models: a search lists what "More models" and a folded API hide ──
        else if matches!(kind, PickerKind::Models) { fill(app, &kind, &mut picker) }
        // The command list: tmux's commands join it once you search, and leave when you stop.
        if matches!(kind, PickerKind::Commands) && before.is_empty() != picker.query.is_empty() {
            picker.rows.clear();
            picker.set_rows(modal::command_rows_for(app, !picker.query.is_empty(), crate::settings::in_tmux(&picker)));
        }
        // The panel's lists: what you type puts the cursor on the best match.
        if crate::settings::is_panel(&kind) { picker.to_top() }
        // --bind change:…, fzf's event for a query that changed (change:first puts the cursor back
        // on the best match).
        if let Some(actions) = theme::fzf_opts().binds.iter().rev().find(|(k, _)| k == "change").map(|(_, a)| a.clone()) {
            match bound_actions(&mut picker, &actions, up, multi) {
                End::Accept => { choose(app, kind, picker, Choice::Enter); return }
                End::Abort => { crate::shell_context::cancel(app); app.shell_context.session_picker = None; SPLIT.with(|s| s.set(None)); return }
                End::Stay => {}
            }
        }
    }
    schedule_said(app, &kind, &picker);
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

/// What a bound action chain leaves the list to do.
pub(crate) enum End { Stay, Accept, Abort }

/// Shell finders share the safe, in-process fzf actions. Commands intended for
/// file previews never execute on a session id; ordinary navigation still works.
pub(crate) fn finder_binding(picker: &mut crate::picker::Picker, name: &str, up: i64) -> Option<End> {
    if picker.unbound.contains(name) { return Some(End::Stay) }
    let actions = theme::fzf_opts().binds.iter().rev().find(|(k, _)| k == name)?.1.clone();
    if falls_back(name, &actions) { return None }
    Some(bound_actions(picker, &actions, up, false))
}

/// An fzf action chain (`up+up`, `toggle+down`) split where a `+` is not inside an action's (…).
fn split_chain(actions: &str) -> Vec<String> {
    let (mut depth, mut out, mut cur) = (0i32, Vec::new(), String::new());
    let chars: Vec<char> = actions.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // `action:argument`: the argument is the rest of the line, `+` and all (fzf's form
        // without brackets).
        if c == ':' && depth == 0 && !cur.is_empty() && cur.chars().all(|x| x.is_ascii_lowercase() || x == '-') {
            cur.extend(&chars[i..]);
            break;
        }
        match c { '(' | '[' | '{' => depth += 1, ')' | ']' | '}' => depth -= 1, '+' if depth == 0 => { out.push(std::mem::take(&mut cur)); i += 1; continue } _ => {} }
        cur.push(c);
        i += 1;
    }
    out.push(cur);
    out
}

/// An action's argument: `name(arg)` (or `[…]`, `{…}` …) or `name:arg`.
fn action_arg<'a>(a: &'a str, name: &str) -> Option<&'a str> {
    let rest = a.strip_prefix(name)?;
    if let Some(r) = rest.strip_prefix(':') { return Some(r) }
    let open = rest.chars().next()?;
    let close = match open { '(' => ')', '[' => ']', '{' => '}', '<' => '>', '~' => '~', '!' => '!', '@' => '@', '#' => '#', '$' => '$', '%' => '%', '^' => '^', '&' => '&', '*' => '*', ';' => ';', '/' => '/', '|' => '|', _ => return None };
    rest[open.len_utf8()..].strip_suffix(close)
}

/// A bound key's (or event's) actions, in order: the ones this list knows, as fzf does them; the
/// others (execute, become, change-prompt …) do nothing.
fn bound_actions(picker: &mut crate::picker::Picker, actions: &str, up: i64, multi: bool) -> End {
    let len = picker.visible.len() as i64;
    for action in split_chain(actions) {
        let multi = picker.multi_override.map(|n| n > 0).unwrap_or(multi);
        match action.as_str() {
            "half-page-up" => crate::ui::page(picker, up, true), "half-page-down" => crate::ui::page(picker, -up, true),
            "top" | "first" => picker.move_by(-len), "last" => picker.move_by(len),
            "best" => { if let Some(at) = picker.matched_rows.first().and_then(|ri| picker.visible.iter().position(|(i, _)| i == ri)) { picker.move_by(at as i64 - picker.cursor as i64) } }
            // close: the preview if it shows, else the list.
            "close" => { if picker.preview { picker.show_preview(Some(false)) } else { return End::Abort } }
            // replace-query: the query made the current row's text.
            "replace-query" => { if let Some(t) = picker.current().map(|r| r.label.clone()) { picker.set_query(&t) } }
            // up-selected / down-selected: to the next marked row up (or down) the screen.
            "up-selected" => picker.to_marked(up > 0), "down-selected" => picker.to_marked(up < 0),
            // exclude: the current row out of the list (exclude-multi: the marked ones, else it).
            "exclude" | "exclude-multi" => {
                let gone: Vec<String> = if action == "exclude-multi" && !picker.marked.is_empty() { picker.marked.clone() } else { picker.current_id().into_iter().collect() };
                picker.marked.retain(|m| !gone.contains(m));
                picker.excluded.extend(gone);
                picker.refilter();
            }
            // fzf's older names: toggle+up, toggle+down.
            // In a list that takes no marks (C-b =) the toggle is nothing and the move still is.
            // The toggles move on only when they toggled (fzf's actToggleDown/Up): not in a list
            // that takes no marks (C-b =), nor when --multi=N is full.
            "toggle-up" => { if multi { picker.toggle_mark(); } picker.move_by(up) }
            "toggle-down" => { if multi { picker.toggle_mark(); } picker.move_by(-up) }
            // toggle-in: toggle+down, or toggle+up under --layout=reverse — toward the list's first
            // row either way; toggle-out the other way.
            "toggle-in" => { if multi && picker.toggle_mark() { picker.move_by(-1) } }
            "toggle-out" => { if multi && picker.toggle_mark() { picker.move_by(1) } }
            "select" => { if multi { picker.set_mark(true) } } "deselect" => picker.set_mark(false), "clear-selection" => picker.marked.clear(),
            "next-selected" => picker.to_marked(true), "prev-selected" => picker.to_marked(false),
            "preview-page-up" => picker.preview_page(-1, false), "preview-page-down" => picker.preview_page(1, false),
            "preview-half-page-up" => picker.preview_page(-1, true), "preview-half-page-down" => picker.preview_page(1, true),
            "preview-top" => picker.preview_to(0), "preview-bottom" => picker.preview_bottom(),
            "unix-word-rubout" => picker.backspace(true), "kill-line" => picker.kill_line(),
            "backward-char" => picker.qmove(-1, false), "forward-char" => picker.qmove(1, false),
            "backward-word" => picker.qmove(-1, true), "forward-word" => picker.qmove(1, true),
            "backward-delete-char" => picker.backspace(false), "delete-char" => picker.delete_forward(),
            "delete-char/eof" => { if picker.query.is_empty() { return End::Abort } picker.delete_forward() }
            "backward-delete-char/eof" => { if picker.query.is_empty() { return End::Abort } picker.backspace(false) }
            // cancel: a query first, then the list.
            "cancel" => { if picker.query.is_empty() { return End::Abort } picker.set_query("") }
            "accept-or-print-query" => { if picker.visible.is_empty() { return End::Abort } return End::Accept }
            "hide-preview" => picker.show_preview(Some(false)), "show-preview" => picker.show_preview(Some(true)),
            "toggle-preview-wrap" => {
                let mut pw = picker.preview_window.clone().unwrap_or_else(|| theme::fzf_opts().preview_window.clone());
                pw.wrap = Some(!pw.wrap.unwrap_or(false));
                picker.preview_window = Some(pw);
            }
            "toggle-track" => { picker.track_flipped = !picker.track_flipped }
            "jump" => picker.jumping = Some(false), "jump-accept" => picker.jumping = Some(true),
            "prev-history" => picker.history_step(true), "next-history" => picker.history_step(false),
            // track-current: this item until the cursor moves (or it leaves) — none under --track;
            // untrack-current ends that only.
            "track-current" => { if !picker.tracking_all() { picker.track_current = picker.current_id() } }
            "untrack-current" => picker.track_current = None,
            "toggle-track-current" => { if picker.track_current.is_some() { picker.track_current = None } else if !picker.tracking_all() { picker.track_current = picker.current_id() } }
            // search(…): the list searched for it, the query left as it is.
            a if action_arg(a, "search").is_some() => { picker.search = action_arg(a, "search").map(str::to_string); picker.refilter() }
            "toggle-sort" => { picker.sort_flipped = !picker.sort_flipped; picker.refilter() }
            // change-preview-window(a|b|…): each time the next of them, over the --preview-window
            // it started with (an empty one is that one).
            // change-query(…) / change-query:…
            a if action_arg(a, "change-query").is_some() => { let q = action_arg(a, "change-query").unwrap_or("").to_string(); picker.set_query(&q) }
            a if a.starts_with("change-preview-window(") && a.ends_with(')') => {
                let specs: Vec<&str> = a["change-preview-window(".len()..a.len() - 1].split('|').collect();
                let spec = specs[picker.pw_next % specs.len()];
                picker.pw_next += 1;
                let mut pw = theme::fzf_opts().preview_window.clone();
                // A spec shows the preview unless it says hidden (fzf clears the flag first).
                if !spec.is_empty() { pw.hidden = false; theme::parse_preview_window(&mut pw, spec) }
                picker.preview = true;
                picker.preview_cells = None;
                picker.preview_reposition.set(true);
                picker.preview_window = Some(pw);
            }
            "yank" => picker.yank(),
            // up-match / down-match: up and down (the rows are all matches without --raw).
            "up-match" => picker.move_match(up), "down-match" => picker.move_match(-up),
            "toggle-raw" => picker.set_raw(!theme::fzf_opts().raw), "enable-raw" => picker.set_raw(true), "disable-raw" => picker.set_raw(false),
            // The subword ones (fzf's camelCase-aware words).
            "backward-subword" => picker.subword(false, false), "forward-subword" => picker.subword(true, false),
            "backward-kill-subword" => picker.subword(false, true), "kill-subword" => picker.subword(true, true),
            // The input shown or hidden (--no-input's).
            "hide-input" => theme::opts_change(|o| o.no_input = true), "show-input" => theme::opts_change(|o| o.no_input = false),
            "toggle-input" => { let on = theme::fzf_opts().no_input; theme::opts_change(|o| o.no_input = !on) }
            // change-multi: marks taken (no limit), change-multi(N): up to N (0: none) — the marks
            // dropped when that changes a list that took them.
            a if a == "change-multi" || action_arg(a, "change-multi").is_some() => {
                let n = match action_arg(a, "change-multi") { Some(v) => match v.trim().parse::<usize>() { Ok(n) => n, Err(_) => continue }, None => usize::MAX };
                let was = picker.multi_override.unwrap_or(if multi { usize::MAX } else { 0 });
                if was > 0 && n != was { picker.marked.clear() }
                picker.multi_override = Some(n);
            }
            // unbind(keys) / rebind(keys) / toggle-bind(keys): keys that do nothing here, or again.
            a if action_arg(a, "unbind").is_some() => { for k in action_arg(a, "unbind").unwrap_or("").split(',') { picker.unbound.insert(k.trim().to_string()); } }
            a if action_arg(a, "rebind").is_some() => { for k in action_arg(a, "rebind").unwrap_or("").split(',') { picker.unbound.remove(k.trim()); } }
            a if action_arg(a, "toggle-bind").is_some() => { for k in action_arg(a, "toggle-bind").unwrap_or("").split(',') { let k = k.trim().to_string(); if !picker.unbound.remove(&k) { picker.unbound.insert(k); } } }
            // The look, for this list: the prompt, the pointer, the ghost text, the header, the
            // footer, each section's label.
            a if action_arg(a, "change-prompt").is_some() => { let v = action_arg(a, "change-prompt").unwrap_or("").to_string(); theme::fzf_change(|f| f.prompt_text = v) }
            a if action_arg(a, "change-pointer").is_some() => {
                let v = action_arg(a, "change-pointer").unwrap_or("").to_string();
                // (fzf takes one of at most two columns.)
                if unicode_width::UnicodeWidthStr::width(v.as_str()) <= 2 { theme::fzf_change(|f| f.pointer_char = v) }
            }
            a if action_arg(a, "change-ghost").is_some() => { let v = action_arg(a, "change-ghost").unwrap_or("").to_string(); theme::opts_change(|o| o.ghost = Some(v)) }
            a if action_arg(a, "change-header").is_some() => picker.header_text = action_arg(a, "change-header").map(str::to_string),
            a if action_arg(a, "change-footer").is_some() => { let v: Vec<String> = action_arg(a, "change-footer").unwrap_or("").split('\n').map(str::to_string).collect(); theme::opts_change(|o| o.footer = v) }
            a if action_arg(a, "change-border-label").is_some() => { let v = action_arg(a, "change-border-label").unwrap_or("").to_string(); theme::opts_change(|o| o.border_label = v) }
            a if action_arg(a, "change-list-label").is_some() => { let v = action_arg(a, "change-list-label").unwrap_or("").to_string(); theme::opts_change(|o| o.list_label = v) }
            a if action_arg(a, "change-input-label").is_some() => { let v = action_arg(a, "change-input-label").unwrap_or("").to_string(); theme::opts_change(|o| o.input_label = v) }
            a if action_arg(a, "change-header-label").is_some() => { let v = action_arg(a, "change-header-label").unwrap_or("").to_string(); theme::opts_change(|o| o.header_label = v) }
            a if action_arg(a, "change-footer-label").is_some() => { let v = action_arg(a, "change-footer-label").unwrap_or("").to_string(); theme::opts_change(|o| o.footer_label = v) }
            a if action_arg(a, "change-preview-label").is_some() => { let v = action_arg(a, "change-preview-label").unwrap_or("").to_string(); theme::opts_change(|o| o.preview_label = Some(v)) }
            "accept-non-empty" => { if !picker.visible.is_empty() { return End::Accept } }
            "accept" => return End::Accept,
            "abort" => return End::Abort,
            "up" => picker.move_by(up), "down" => picker.move_by(-up),
            "page-up" => crate::ui::page(picker, up, false), "page-down" => crate::ui::page(picker, -up, false),
            "toggle" => { if multi { picker.toggle_mark(); } }
            // The matches into the marks (those the query hides stay marked), or out of them — no
            // more than --multi=N marked.
            "select-all" => { if multi { for i in picker.matched_rows.clone() { let id = picker.rows[i].id.clone(); if !picker.marked.contains(&id) && picker.room_to_mark() { picker.marked.push(id) } } } }
            "deselect-all" => { let shown: Vec<String> = picker.matched_rows.iter().map(|i| picker.rows[*i].id.clone()).collect(); picker.marked.retain(|m| !shown.contains(m)) }
            // actToggleAll: the shown rows that were marked unmarked first, then the others marked
            // from the top while --multi=N has room.
            "toggle-all" => { if multi {
                let all: Vec<String> = picker.matched_rows.iter().map(|i| picker.rows[*i].id.clone()).collect();
                let was: Vec<String> = all.iter().filter(|id| picker.marked.contains(id)).cloned().collect();
                picker.marked.retain(|m| !was.contains(m));
                for id in all.into_iter().filter(|id| !was.contains(id)) { if picker.room_to_mark() { picker.marked.push(id) } }
            } }
            "toggle-preview" => picker.show_preview(None), "toggle-wrap" => picker.toggle_wrap(),
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

/// An action's name, its argument aside (`change-preview-window:down|hidden`, `reload(…)`).
fn action_name(a: &str) -> &str { a.split([':', '(']).next().unwrap_or(a) }

/// The shell's side of fzf: what a list in hn has not (it runs no command for a row).
fn shell_side(a: &str) -> bool {
    matches!(action_name(a), "execute" | "execute-silent" | "execute-multi" | "become" | "reload" | "reload-sync" | "print" | "print-query" | "transform" | "transform-query" | "transform-prompt" | "transform-header" | "transform-preview-label" | "transform-border-label" | "preview")
}

/// The keys whose own meaning in the harness lists acts on a harness — pause, restart, answer,
/// send, mark read, open here: never taken for a key you bound to something else.
fn acts_on_harness(key: &str) -> bool {
    matches!(key, "alt-p" | "alt-r" | "alt-a" | "alt-s" | "alt-m" | "alt-M" | "alt-enter") || key.strip_prefix("alt-").map(|d| d.len() == 1 && d.chars().all(|c| c.is_ascii_digit() && c != '0')).unwrap_or(false)
}

/// Whether a key bound in FZF_DEFAULT_OPTS keeps the list's own meaning: when everything bound to
/// it is the shell's side of fzf (execute, become, reload …), for a key whose meaning does not act
/// on a harness. Anything else bound to it — an action hn runs, or one it does not know — is the
/// key's now (nothing, where hn does not run it).
fn falls_back(key: &str, actions: &str) -> bool {
    !acts_on_harness(key) && split_chain(actions).iter().all(|a| shell_side(a))
}

/// What a hint's key does in the lists without a bind: rebinding it to that keeps the hint.
fn default_action(key: &str) -> Option<&'static str> {
    match key { "ctrl-/" => Some("toggle-preview"), "tab" => Some("toggle+down"), "btab" => Some("toggle+up"), "enter" => Some("accept"), _ => None }
}

/// Whether a hint's key (`C-v`, `M-a`, `enter`, `tab`) is bound in FZF_DEFAULT_OPTS to something
/// else — it no longer does what the hint says.
pub fn rebound(hint: &str) -> bool {
    let name = if let Some(k) = hint.strip_prefix("C-") { format!("ctrl-{}", k.to_lowercase()) } else if let Some(k) = hint.strip_prefix("M-") { format!("alt-{}", k.to_lowercase()) } else { hint.to_lowercase() };
    theme::fzf_opts().binds.iter().rev().find(|(k, _)| *k == name).map(|(_, a)| !falls_back(&name, a) && default_action(&name) != Some(a.as_str())).unwrap_or(false)
}

/// A key as fzf's --bind names it: ctrl-j, alt-a, enter, btab, f1, ctrl-/ …
pub(crate) fn fzf_key_name(key: &KeyEvent) -> String {
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
    // …and C-] C-^ C-\ as the control characters crossterm reads as C-5 C-6 C-4.
    if ctrl && !alt { match key.code { KeyCode::Char(']' | '5') => return "ctrl-]".into(), KeyCode::Char('^' | '6') => return "ctrl-^".into(), KeyCode::Char('\\' | '4') => return "ctrl-\\".into(), _ => {} } }
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
    // fzf --multi: the marked rows the query shows — never one it hides (an answer is not a
    // printed line: it approves what that harness asks) — each given its own choice N (those
    // asking with fewer choices left marked); with none shown, the current row.
    let shown: std::collections::HashSet<&str> = picker.visible.iter().map(|(i, _)| picker.rows[*i].id.as_str()).collect();
    let marked: Vec<(String, String)> = picker.marked.iter().filter(|m| shown.contains(m.as_str())).filter_map(|m| split_key(m)).collect();
    if marked.is_empty() {
        let Some(row) = picker.current_id() else { return };
        let Some((machine, agent)) = split_key(&row) else { return };
        if let Err(why) = answerable(app, picker, &row) { picker.say(why); return }
        let (who, choice) = app.fleet.agent(&machine, &agent).map(|a| (a.name.clone(), a.question.as_ref().and_then(|q| q.options.get(option).cloned()).unwrap_or_default())).unwrap_or_default();
        if answer(app, &machine, &agent, option) { picker.say(&format!("Answered {who}: {choice}")) }
        return;
    }
    let (mut done, mut left) = (0, 0);
    let hidden = picker.marked.len().saturating_sub(marked.len());
    for (m, a) in &marked {
        // (A marked row whose question just changed keeps its mark, unanswered.)
        let row = picker.marked.iter().find(|id| split_key(id).as_ref() == Some(&(m.clone(), a.clone()))).cloned().unwrap_or_default();
        if answerable(app, picker, &row).is_ok() && answer(app, m, a, option) { done += 1 } else { left += 1 }
    }
    picker.marked.retain(|id| split_key(id).and_then(|(m, a)| app.fleet.agent(&m, &a).map(|x| x.question.is_some())).unwrap_or(false));
    let n = option + 1;
    let also = if hidden > 0 { format!(" · {hidden} marked out of view left as they were") } else { String::new() };
    picker.say(&match (done, left) {
        (0, _) => format!("No choice {n} to give{also}"),
        (d, 0) => format!("{d} answered{also}"),
        (d, l) => format!("{d} answered · {l} without a choice {n}, still marked{also}"),
    });
}

/// Answer an open question with its [option]th choice, from anywhere — no need to open the pane.
fn answer(app: &mut App, machine: &str, agent: &str, option: usize) -> bool {
    let Some(q) = app.fleet.agent(machine, agent).and_then(|a| a.question.clone()) else { return false };
    let Some(choice) = q.options.get(option).cloned() else { return false };
    answer_with(app, machine, agent, &choice)
}

/// Whether an action on a harness may go ahead: at once for one that isn't working; for a working
/// one (its turn would be cut short), when its key comes again within three seconds — the first
/// press says so.
fn confirmed(app: &App, picker: &mut Picker, key: char, machine: &str, agent: &str, warning: &str) -> bool {
    let working = app.fleet.agent(machine, agent).map(|a| matches!(app.fleet.state_of(a), crate::fleet::State::Working | crate::fleet::State::Starting | crate::fleet::State::NeedsInput)).unwrap_or(false);
    if !working { picker.armed_key = None; return true }
    let id = format!("{machine}:{agent}");
    if picker.armed_key.as_ref().map(|(k, i, at)| *k == key && *i == id && at.elapsed() < Duration::from_secs(3)).unwrap_or(false) { picker.armed_key = None; return true }
    picker.armed_key = Some((key, id, std::time::Instant::now()));
    picker.say(warning);
    false
}

/// A harness read without opening it: its ✓ (or an error's ✗) gone, and seen now.
fn mark_read(app: &mut App, key: (String, String)) -> bool {
    let Some(a) = app.fleet.agents.get_mut(&key) else { return false };
    let was = a.unread || a.errored;
    a.unread = false;
    a.errored = false;
    app.mark_seen_key(key.clone());
    if was { crate::dial::seen(app, &key.1) }
    was
}

/// question_response with [value]: an option's words, several joined with ", ", or free text
/// (the daemon keys each into the agent's own dialog).
pub fn answer_with(app: &mut App, machine: &str, agent: &str, value: &str) -> bool {
    let Some(a) = app.fleet.agent(machine, agent) else { return false };
    let Some(q) = a.question.clone() else { return false };
    let session = a.session_id.clone();
    let Some(link) = app.link(machine) else { return false };
    let sent = link.send("question_response", json!({ "requestId": q.request_id, "agentId": agent, "sessionId": session, "answers": { q.answer_key: value } }));
    // Answered: off the counts, the list and C-b a now, not when the daemon's close comes back.
    if sent { if let Some(a) = app.fleet.agents.get_mut(&(machine.to_string(), agent.to_string())) { a.question = None } }
    sent
}

pub fn open_shell_session(app: &mut App, pane: u64, id: &str) {
    // The external row disappears from the rendered list as soon as its live
    // owner arrives. Keep resolving the chosen conversation across that update.
    if let Some(x) = catalog_conversation(app, id) {
        app.shell_context.session_picker = Some(pane);
        resume_external_as(app, &x, Placement::Replace);
        return;
    }
    let kind = PickerKind::Open { filter:Filter::All, machine:Some(app.fleet.local_id.clone()), project:None };
    let mut picker = Picker::new("", "");
    fill(app, &kind, &mut picker);
    if !picker.rows.iter().any(|r| r.id == id && !r.disabled) {
        return crate::shell_context::finish(app, 1, "That session is no longer available. Run hn sessions again.");
    }
    // Full-text results can arrive before this session's catalog page. The
    // selection is already validated above; an empty reconstruction query must
    // not hide that row while dispatching the chosen action.
    picker.catalog_ids.insert(id.to_string());
    picker.refilter();
    picker.select(id);
    if picker.current_id().as_deref() != Some(id) { return crate::shell_context::finish(app, 1, "That session is no longer available.") }
    app.shell_context.session_picker = Some(pane);
    choose(app, kind, picker, Choice::Here);
    // A rejected selection remains an error at the prompt, never another popup.
    if let Some(Modal::Picker { picker, .. }) = app.modal.take() {
        app.shell_context.session_picker = None;
        crate::shell_context::finish(app, 1, picker.flash.as_ref().map(|f| f.0.as_str()).unwrap_or("Could not open that session."));
    }
}

fn open_picked_agent(app: &mut App, machine: &str, agent: &str, placement: Placement) {
    let inline = app.shell_context.pending.as_ref().is_some_and(|r| r.verb == "session-inline");
    if inline && app.shell_context.session_picker.is_some_and(|p| app.focused() != Some(p)) {
        app.shell_context.session_picker = None;
        crate::shell_context::finish(app, 0, "Session is available. Find it with Ctrl+P.\n");
        return;
    }
    let state = app.fleet.agent(machine, agent).map(|a| app.fleet.state_of(a));
    let held = app.shell_context.session_picker.take().filter(|p| app.focused() == Some(*p))
        .and_then(|p| app.panes.get(&p)).map(|p| ((p.machine_id.clone(), p.agent_id.clone()), p.cwd.clone().or_else(|| p.live_path.clone())));
    let owned = held.as_ref().is_some_and(|(key,_)| app.shells.remove(key));
    // A just-exited process can still have a live discovery row. Resume verifies
    // its exact process and attaches an existing one without launching a duplicate.
    let verify_visit = held.is_some() && app.fleet.agent(machine, agent).is_some_and(|a| a.engine != "terminal");
    if inline { crate::shell_context::finish(app, 0, ""); }
    app.open_agent(machine, agent, placement);
    if let Some((key, cwd)) = held {
        crate::shell_context::visiting(app, &key, cwd, machine, agent);
        if owned { app.shells.insert(key); }
    }
    if verify_visit || state == Some(crate::fleet::State::Paused) {
        if let Some((_, pane)) = app.find_pane(machine, agent) { app.resume(pane) }
    }
}

fn choose(app: &mut App, kind: PickerKind, mut picker: Picker, choice: Choice) {
    let choice = if choice == Choice::Enter && app.shell_context.session_picker.is_some()
        && matches!(kind, PickerKind::Open { .. }) { Choice::Here } else { choice };
    // --history: the query kept for C-p to bring back.
    if choice == Choice::Enter { picker.history_add() }
    let id = picker.current_id();
    // fzf's accept with nothing matched: the list goes.
    if id.is_none() && picker.visible.is_empty() && choice == Choice::Enter { crate::shell_context::cancel(app); app.shell_context.session_picker = None; SPLIT.with(|s| s.set(None)); return }
    let keep = |app: &mut App, kind: PickerKind, picker: Picker| app.modal = Some(Modal::Picker { kind, picker });
    // A list of keys, buffers, commands or text: only Enter picks — the harness lists' keys (C-v
    // beside, C-x below, M-p pause …) do nothing here, as keys fzf has no action for.
    if choice != Choice::Enter && matches!(kind, PickerKind::ShellContext | PickerKind::Keys | PickerKind::Buffers | PickerKind::Palette | PickerKind::Commands | PickerKind::Keybinds | PickerKind::Help | PickerKind::Messages | PickerKind::Output { .. }) { return keep(app, kind, picker) }
    match kind.clone() {
        PickerKind::ShellContext => { crate::shell_context::choose(app, id.as_deref()); }
        // ── keys ── Enter on a command: the next key pressed is its key; on the prefix, where it is set.
        PickerKind::Keybinds => {
            let (knob, value) = id.as_deref().map(|id| id.split_once(':').unwrap_or((id, ""))).unwrap_or_default();
            if let Some(msg) = crate::settings::set_key(app, knob, value) { picker.say(msg) }
            return keep(app, kind, picker);
        }
        PickerKind::Open { .. } if id.as_deref().map(|i| i.starts_with("session:")).unwrap_or(false) => {
            let sid = id.as_deref().and_then(|i| i.strip_prefix("session:")).and_then(|n| n.parse().ok()).unwrap_or(app.session_id);
            SPLIT.with(|s| s.set(None));
            app.switch_session(sid);
        }
        // Resolve history to its existing Harness owner before considering resume.
        PickerKind::Open { .. } if id.as_deref().map(|i| i.starts_with("external:")).unwrap_or(false) => {
            let found = id.as_deref().and_then(|i| catalog_conversation(app, i));
            let Some(x) = found else { return keep(app, kind, picker) };
            let placement = match choice {
                Choice::Enter => Placement::Auto(None),
                Choice::SplitRight => Placement::Split(Dir::Horizontal), Choice::SplitDown => Placement::Split(Dir::Vertical), Choice::Here => Placement::Replace,
                _ => if app.tab().root.is_none() { Placement::Auto(None) } else { Placement::Tab },
            };
            SPLIT.with(|s| s.set(None));
            resume_external_as(app, &x, placement);
        }
        PickerKind::Open { .. } => {
            let Some((machine, agent)) = id.as_deref().and_then(split_key) else { return keep(app, kind, picker) };
            let state = app.fleet.agent(&machine, &agent).map(|a| app.fleet.state_of(a));
            if choice == Choice::Pause {
                let paused = state == Some(crate::fleet::State::Paused);
                let name = app.fleet.agent(&machine, &agent).map(|a| a.name.clone()).unwrap_or_default();
                if !paused && !confirmed(app, &mut picker, 'p', &machine, &agent, &format!("M-p again pauses {name} — it is working")) { return keep(app, kind, picker) }
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
                // Enter adds a pane in this window; an already-open harness is focused.
                (Choice::Enter, None) => Placement::Auto(None),
                _ => Placement::Tab,
            };
            // fzf --multi: Enter adds every marked harness here; C-t opens a window each.
            // C-v / C-x put the first where asked and add the rest beside it.
            let mut targets: Vec<(String, String)> = picker.marked.iter().filter_map(|m| split_key(m)).collect();
            if targets.is_empty() { targets.push((machine.clone(), agent.clone())) }
            for (i, (machine, agent)) in targets.iter().enumerate() {
                let state = app.fleet.agent(machine, agent).map(|a| app.fleet.state_of(a));
                if state == Some(crate::fleet::State::Offline) { continue }
                let place = if i == 0 || placement == Placement::Tab { placement.clone() } else { Placement::Auto(None) };
                open_picked_agent(app, machine, agent, place);
            }
        }
        PickerKind::Inbox => {
            let Some(id) = id else { return keep(app, kind, picker) };
            let Some((machine, agent)) = split_key(&id) else { return };
            let option = id.split('#').nth(1).and_then(|s| s.parse::<usize>().ok());
            match (choice, option) {
                (Choice::Enter, Some(option)) => {
                    if let Err(why) = answerable(app, &picker, &id) { picker.say(why); return keep(app, kind, picker) }
                    if answer(app, &machine, &agent, option) { picker.say("Answered") }
                    return keep(app, kind, picker)
                }
                _ => app.open_agent(&machine, &agent, Placement::Tab),
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
            // C-t: the project's session — named for it, each of its harnesses in a window of its
            // own (tmux's session per project), made or gone to.
            if choice == Choice::Tab { return project_session(app, &machine, &root) }
            if choice == Choice::New {
                if app.link(&machine).is_none() { picker.say("That machine is not connected"); return keep(app, kind, picker) }
                crate::new_harness::open(app, Some(machine), Some(root));
                return;
            }
            let kind = PickerKind::Open { filter: Filter::All, machine: Some(machine), project: Some(root) };
            let (title, placeholder) = modal::launcher_title(app, &kind);
            let mut next = Picker::new(title, placeholder);
            next.prefixed = true;
            fill(app, &kind, &mut next);
            app.modal = Some(Modal::Picker { kind, picker: next });
        }
        // ── models: Enter uses a row of the Models view, C-s stops a local model (models.rs) ──
        PickerKind::Models if id.as_deref().is_some_and(crate::models::is_row) => {
            if !matches!(choice, Choice::Enter | Choice::SplitDown) { return keep(app, kind, picker) }
            crate::models::choose(app, &mut picker, id.as_deref().unwrap_or(""), choice == Choice::SplitDown);
            fill(app, &kind, &mut picker);
            return keep(app, kind, picker);
        }
        // (Every row of the Models view is its own — models.rs — so nothing else is chosen here.)
        PickerKind::Models => return keep(app, kind, picker),
        PickerKind::Layout => {
            if let Some(id) = id { app.apply_shared_preset(&id) }
        }
        PickerKind::Theme => {
            if choice == Choice::Enter {
                let under = picker.theme_in.clone();
                if let Some(id) = id {
                    if let Some(section) = under {
                        // Inside a section: Enter sets that option (and the ● moves to it).
                        if let Some((knob, value)) = id.split_once(':') {
                            let msg = app.set_look(knob, value);
                            picker.say(msg);
                            picker.set_rows(modal::theme_options(app, &section));
                            // (A switch — Dim other panes — is the same row turned over.)
                            let at = if knob == "dim" { format!("dim:{}", if value == "on" { "off" } else { "on" }) } else { id.clone() };
                            crate::settings::cursor_to(&mut picker, &at);
                        }
                    } else if let Some(sec) = id.strip_prefix("section:") {
                        // The section list: Enter opens the section's options.
                        crate::settings::open_section(app, &mut picker, sec);
                    }
                }
            }
            return keep(app, kind, picker);
        }
        PickerKind::Commands => {
            let Some(id) = id else { return keep(app, kind, picker) };
            if let Some(name) = id.strip_prefix("tmux:") {
                // A command that needs words goes to the prompt with its name typed; the rest run.
                if modal::NEEDS_ARGS.contains(&name) { app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Command { template: None, more: Vec::new(), answers: Vec::new(), one: false, digits: false, incremental: false, ptype: 0, last: String::new() }, ":", &format!("{name} ")))) }
                else { commands::execute(app, name) }
            } else if id == "cmd:theme" {
                // Settings open in this same panel, where the command list was.
                crate::settings::into_settings(app, &mut picker);
                return keep(app, PickerKind::Theme, picker);
            } else if id == "cmd:tmux-commands" {
                // tmux's commands, grouped, in this same panel (Esc comes back here).
                crate::settings::into_tmux(app, &mut picker);
                return keep(app, kind, picker);
            } else if id == "cmd:keybinds" {
                // ── keys ── (in this same panel too; Esc comes back here)
                crate::settings::into_keybinds(app, &mut picker);
                return keep(app, PickerKind::Keybinds, picker);
            } else if let Some(view) = id.strip_prefix("cmd:").and_then(crate::devices::View::of) {
                // ── machines & devices ── (in this same panel too; Esc comes back here)
                return crate::devices::from_commands(app, picker, view);
            } else if id == "cmd:hardware-devices" {
                crate::hardware::open(app);
                if let Some(Modal::Picker { picker, .. }) = &mut app.modal { picker.from_commands = true; }
            } else if let Some(cmd) = id.strip_prefix("cmd:") {
                run(app, cmd)
            }
        }
        PickerKind::Machines => {
            let Some(machine) = id else { return keep(app, kind, picker) };
            match choice {
                Choice::New => { if app.link(&machine).is_some() { new_what(app, machine) } }
                Choice::Tab => create(app, machine, What { engine: "terminal".into(), dsh: None, label: "Terminal".into() }, None, None),
                // M-l: Connect a machine in the panel, its password asked for (hidden), the CLI's
                // stages shown as they come.
                Choice::Link => crate::devices::connect_to(app, machine),
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
        PickerKind::Route { text, voice } => {
            let Some((machine, agent)) = id.as_deref().and_then(split_key) else { return keep(app, kind, picker) };
            if let Some(voice) = voice { return crate::dial::send_spoken(app, &voice, &machine, &agent, &text) }
            if let Some(link) = app.link(&machine) {
                link.send("message", json!({ "agentId": agent, "content": text }));
                let name = app.fleet.agent(&machine, &agent).map(|a| a.name.clone()).unwrap_or_default();
                app.say(format!("Sent to {name}"), theme::ONLINE);
            }
        }
        // ── machines & devices ──
        PickerKind::Devices(view) => crate::devices::choose(app, view, picker, choice == Choice::Enter),
        PickerKind::Account => {
            if choice == Choice::Enter { crate::account::choose(app, picker, id.as_deref().unwrap_or("")); }
            else { app.modal = Some(Modal::Picker { kind, picker }); }
        }
        PickerKind::AgentSwitch => {
            if choice == Choice::Enter { crate::agent_switch::choose(app, picker, id.as_deref().unwrap_or("")); }
            else { app.modal = Some(Modal::Picker { kind, picker }); }
        }
        PickerKind::Hardware => {
            if choice == Choice::Enter { crate::hardware::choose(app, picker, id.as_deref().unwrap_or("")); }
            else { app.modal = Some(Modal::Picker { kind, picker }); }
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
        PromptKind::Tree { pane, ask } => crate::tree::answer(app, pane, ask, Some(&p.value)),
        PromptKind::Command { template, mut more, mut answers, one, digits, incremental, ptype, last } => {
            // The answer as typed (tmux keeps its spaces); the next prompt, if there is one.
            answers.push(p.value.clone());
            if !more.is_empty() {
                let (label, initial) = more.remove(0);
                app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Command { template, more, answers, one, digits, incremental, ptype, last }, &label, &initial)));
                return;
            }
            // args_make_commands: each answer into the template (tmux's default, `%1`, the
            // answer itself as a command).
            commands::execute_template(app, template.as_deref().unwrap_or("%1"), &answers);
        }
        PromptKind::RenameTab { session, window, owner } => {
            if value.is_empty() { return }
            if owner != app.fleet.local_id { app.error("The account changed. Open Rename Tab again."); return }
            let before = app.session_id;
            if before != session {
                if !app.sessions.iter().any(|s| s.id == session && s.tabs.iter().any(|t| t.id == window)) { app.error("That tab has closed."); return }
                app.swap_session(session);
            }
            if let Some(index) = app.tabs.iter().position(|t| t.id == window) { app.rename_tab_at(index, &value); }
            else { app.error("That tab has closed."); }
            if before != session { app.swap_session(before); }
        }
        PromptKind::Message { machine, agent } => {
            if value.trim().is_empty() { return }
            if let Some(link) = app.link(&machine) {
                link.send("message", json!({ "agentId": agent, "content": value }));
                let name = app.fleet.agent(&machine, &agent).map(|a| a.name.clone()).unwrap_or_default();
                app.say(format!("Sent to {name}"), theme::ONLINE);
            }
        }
        PromptKind::Answer { machine, agent, request } => {
            // Only the question you were answering: one that took its place while you typed is not.
            let q = app.fleet.agent(&machine, &agent).and_then(|a| a.question.clone());
            // Not answered (the question changed, or closed, while you typed): what you typed is
            // kept, offered as a message to it — Enter sends it, Escape drops it.
            let keep = |app: &mut App, why: &str| {
                let name = app.fleet.agent(&machine, &agent).map(|a| a.name.clone()).unwrap_or_default();
                prompt(app, PromptKind::Message { machine: machine.clone(), agent: agent.clone() }, "Message", &name, &format!("{why} — send it to {name} as a message?"), &value, false);
            };
            if q.as_ref().is_some_and(|q| q.request_id != request) { return keep(app, "That question changed while you typed") }
            let text = q.and_then(|q| crate::fleet::answer_text(&q, &value));
            match text {
                Some(t) => { if answer_with(app, &machine, &agent, &t) { app.say(format!("Answered: {t}"), theme::ONLINE) } }
                None if !value.trim().is_empty() => keep(app, "That question is no longer open"),
                None => app.say("That question is no longer open", theme::WARN),
            }
        }
        PromptKind::RenameHarness { machine, agent } => {
            if value.is_empty() { return }
            if let Some(link) = app.link(&machine) {
                app.spawn(async move { link.rpc("agent_update", json!({ "agentId": agent, "name": value }), Duration::from_secs(20)).await }, move |app, r| {
                    if let Err(e) = r { app.say(format!("{e}"), theme::DANGER) } else { app.relist(&machine) }
                });
            }
        }
        PromptKind::Send => {
            if value.is_empty() { return }
            let local = app.fleet.local_id.clone();
            let Some(link) = app.link(&local) else { return };
            app.say("Finding the right harness…", theme::SOFT);
            let text = value.clone();
            app.spawn(async move { link.request("route_task", json!({ "text": text }), Duration::from_secs(60)).await }, move |app, reply| match reply {
                Ok((_, reply)) => {
                    // The router sure of one (confidence 0.85 or more, as the desktop's boss mode
                    // takes it): sent to it at once, and said where.
                    let sure = reply.get("confidence").and_then(serde_json::Value::as_f64).unwrap_or(0.0) >= 0.85;
                    let pick = reply.get("agentId").and_then(serde_json::Value::as_str).zip(reply.get("machineId").and_then(serde_json::Value::as_str)).map(|(a, m)| (m.to_string(), a.to_string()));
                    if let Some((machine, agent)) = pick.filter(|(m, a)| sure && app.fleet.agent(m, a).is_some()) {
                        if let Some(link) = app.link(&machine) {
                            link.send("message", json!({ "agentId": agent, "content": value }));
                            let name = app.fleet.agent(&machine, &agent).map(|a| a.name.clone()).unwrap_or_default();
                            let why = reply.get("reason").and_then(serde_json::Value::as_str).map(|r| format!(" — {r}")).unwrap_or_default();
                            app.toast = None;
                            app.say(format!("Sent to {name}{why}"), theme::ONLINE);
                            return;
                        }
                    }
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
    }
}



// ── what the command layer calls ─────────────────────────────────────────────

/// Quote a typed value so it survives the command-line split as one word.

/// Command ids that `run` knows (so `:open` and old configs still work).
pub fn is_command(id: &str) -> bool {
    matches!(id, "open" | "palette" | "projects" | "models" | "inbox" | "machines" | "help" | "layout" | "store" | "new" | "terminal" | "send"
        | "broadcast" | "clone" | "restart" | "pause" | "take" | "rename" | "tab" | "rename-tab" | "close-tab" | "next-tab" | "prev-tab"
        | "split-right" | "split-down" | "close-pane" | "zoom" | "equalize" | "pane-tab" | "copy-mode" | "find" | "tab-left" | "tab-right"
        | "last-tab" | "next-waiting" | "prev-waiting" | "resume-focused" | "last-harness" | "tree" | "files" | "info" | "messages" | "keys"
        | "theme" | "appearance" | "commands" | "choose-buffer" | "quit" | "keybinds"
        // ── machines & devices ──
        | "connect-machine" | "add-phone" | "devices" | "hardware-devices" | "account" | "login" | "change-agent")
}



/// choose-buffer's pick: that buffer pasted into this pane, as paste-buffer -b does.
pub fn paste_buffer(app: &mut App, name: &str) {
    let Some(text) = app.paste.get(name).map(|b| b.data.clone()) else { return app.say(format!("no buffer {name}"), theme::WARN) };
    if paste_form(app, &text) { return }
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
    if matches!(app.modal, Some(Modal::Picker { .. }) | Some(Modal::Copy { .. }) | Some(Modal::NewHarness(_))) { return modal_key(app, key) }
    if app.home_visible() { return home_key(app, key) }
    // The tree over the pane: it has the key (C-b is page-up there).
    if let Some(pane) = app.focused().filter(|f| app.panes.get(f).map(|p| p.tree_top()).unwrap_or(false)) {
        return crate::tree::key(app, pane, keys::of(&key), None, true);
    }
    if let Some(pane) = app.focused().filter(|f| app.panes.get(f).map(|p| p.files_top()).unwrap_or(false)) {
        return crate::files::key(app, pane, keys::of(&key), None);
    }
    if let Some(bytes) = app.focused().and_then(|f| app.panes.get(&f).map(|p| (f, p))).and_then(|(f, p)| encode_key(&for_pane(app, f, key), p.mode())) { send_to_focused(app, bytes) }
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
    // The tree takes keys itself (window_tree_key); copy and view mode through their table.
    let tree = app.panes.get(&pane).map(|p| p.tree_top()).unwrap_or(false);
    // The file manager takes them as the tree does.
    let files = app.panes.get(&pane).map(|p| p.files_top()).unwrap_or(false);
    let in_mode = app.panes.get(&pane).map(|p| p.copy_top()).unwrap_or(false);
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
        if !in_mode { return app.error("not in a mode") }
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
                if let Ok(n) = u8::from_str_radix(word, 16) { if !word.is_empty() && !word.starts_with('+') { if tree { crate::tree::key(app, pane, keys::Chord::normal(KeyCode::Char(n as char), KeyModifiers::NONE), None, false) } else if files { crate::files::key(app, pane, keys::Chord::normal(KeyCode::Char(n as char), KeyModifiers::NONE), None) } else if in_mode { inject_mode_key(app, pane, keys::Chord::normal(KeyCode::Char(n as char), KeyModifiers::NONE)) } else { bytes.push(n) } } }
                continue;
            }
            match (!literal).then(|| keys::parse(word).ok()).flatten() {
                // A key by its name: in a mode, what the mode's table binds it to; a mouse key's
                // name is nothing to a program (there is no event with it).
                Some(chord) if tree => crate::tree::key(app, pane, chord, None, false),
                Some(chord) if files => crate::files::key(app, pane, chord, None),
                Some(chord) if in_mode => inject_mode_key(app, pane, chord),
                Some(chord) if keys::is_mouse(&chord.code) => {}
                Some(chord) => { if let Some(b) = encode_key(&KeyEvent::new(chord.code, chord.mods), mode) { bytes.extend(b) } }
                None if tree => { for c in word.chars() { crate::tree::key(app, pane, keys::Chord::normal(KeyCode::Char(c), KeyModifiers::NONE), None, false) } }
                None if files => { for c in word.chars() { crate::files::key(app, pane, keys::Chord::normal(KeyCode::Char(c), KeyModifiers::NONE), None) } }
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

/// Shift+Enter as a pane's program reads it: to an agent (Claude Code's newline) or a program that
/// asked for the kitty keyboard protocol, CSI 13;2u; to a shell, plain Enter, as tmux sends it.
fn for_pane(app: &App, pane: u64, key: KeyEvent) -> KeyEvent {
    // Cmd-P, when the terminal reports it, is the shell widget's Ctrl-P. Shell
    // integration decides when it runs; an application's own input is untouched.
    // Root/user bindings have already had first refusal before reaching here.
    if key.code == KeyCode::Char('p') && key.modifiers == KeyModifiers::SUPER
        && app.panes.get(&pane).is_some_and(|p| app.shell_context.token_for(&p.machine_id, &p.agent_id).is_some()) {
        return KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL)
    }
    if key.code != KeyCode::Enter || !key.modifiers.contains(KeyModifiers::SHIFT) { return key }
    let Some(p) = app.panes.get(&pane) else { return key };
    let shell = app.fleet.agent(&p.machine_id, &p.agent_id).map(|a| a.engine == "terminal").unwrap_or(true);
    if shell && !p.mode().intersects(alacritty_terminal::term::TermMode::KITTY_KEYBOARD_PROTOCOL) { KeyEvent::new(key.code, key.modifiers - KeyModifiers::SHIFT) } else { key }
}

/// `new-harness claude @office ~/src/api`: the words `harness new` takes.
/// What new-harness asks beyond which and where (a script's): made in the background (-d), its
/// name (-n), and what to print once it is there (-P, -F: new-window's).
#[derive(Default, Clone)]
pub struct NewOpts {
    pub detached: bool, pub name: Option<String>, pub print: Option<String>,
    /// Additional project/permission choices from the interactive draft.
    pub extra: Option<serde_json::Value>, pub form_id: Option<String>,
    pub target: Option<LaunchTarget>,
}

#[derive(Clone, Debug)]
pub(crate) struct LaunchTarget { pub session: u32, pub tab: String }

/// `new-harness [-dP] [-e engine] [-c folder] [-n name] [-F format] [engine] [@machine] [folder]
/// [task …]`: the engine a known one (else -e's, else Claude Code), the folder a path, and the
/// words after them the first message it is given.
pub fn new_harness_words(app: &mut App, words: &[String]) {
    let mut opts = NewOpts::default();
    let (mut engine, mut format, mut print) = (None::<String>, None::<String>, false);
    let mut machine = app.focused().and_then(|f| app.panes.get(&f)).map(|p| p.machine_id.clone()).unwrap_or(app.fleet.local_id.clone());
    let mut cwd: Option<String> = None;
    let mut task: Vec<String> = Vec::new();
    let (mut i, mut flags) = (0, true);
    let path = |app: &App, machine: &str, word: &str| {
        let home = app.homes.get(machine).cloned().unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
        if word == "~" { home } else if let Some(r) = word.strip_prefix("~/") { format!("{home}/{r}") } else { word.to_string() }
    };
    while i < words.len() {
        let w = words[i].clone();
        i += 1;
        if flags && w == "--" { flags = false; continue }
        if flags && w.len() > 1 && w.starts_with('-') {
            let mut value = || { i += 1; words.get(i - 1).cloned() };
            match w.as_str() {
                "-d" => opts.detached = true,
                "-P" => print = true,
                "-F" => format = value(),
                "-n" => opts.name = value(),
                "-e" => engine = value(),
                "-c" => { let c = value().unwrap_or_default(); cwd = Some(path(app, &machine, &c)) }
                _ => return app.error(format!("unknown flag {w}")),
            }
            continue;
        }
        flags = false;
        if let Some(m) = w.strip_prefix('@').filter(|_| task.is_empty()) {
            let matched = app.fleet.visible_machines().find(|x| app.fleet.machine_name(&x.id).to_lowercase().starts_with(&m.to_lowercase()) || x.id == m).map(|x| x.id.clone());
            match matched { Some(id) => machine = id, None => return app.error(format!("can't find machine: {m}")) }
        } else if task.is_empty() && (w.starts_with('/') || w.starts_with('~') || w.starts_with("./") || w.starts_with("../") || w == ".") {
            cwd = Some(path(app, &machine, &w));
        } else if task.is_empty() && engine.is_none() && (theme::engine_label(&w) != w || w == "terminal") {
            engine = Some(w);
        } else { task.push(w) }
    }
    if print { opts.print = Some(format.unwrap_or_else(|| "#{session_name}:#{window_index}.#{pane_index}".into())) }
    let engine = engine.unwrap_or_else(|| "claude".into());
    let label = theme::engine_label(&engine).to_string();
    let task = (!task.is_empty()).then(|| task.join(" "));
    create_opts(app, machine, What { engine, dsh: None, label }, cwd, task, false, opts);
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

/// The focused pane's harness, when it shows one.
pub fn focused_key(app: &App) -> Option<(String, String)> { focused_agent(app) }


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
    if let Some((pane, line)) = menu.tree { return crate::tree::menu_chosen(app, pane, line, &it.key) }
    if let Some(comp) = menu.complete { return complete_chosen(app, *comp, Some(c)) }
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
        if !motion && (m.b & 195) != 0 { if let Some(c) = menu.complete.take() { complete_chosen(app, *c, None) } return }
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
    let chosen = if !menu.stay_open { is_release(m.b) } else { !is_release(m.b) && !is_wheel(m.b) && !is_drag(m.b) };
    // The click's row is authoritative even if no mouse-motion report preceded it.
    // In particular, a menu opened by the keyboard must not run its previous selection.
    menu.choice = Some((m.y - (py + 1)) as usize);
    if chosen { return menu_chosen(app, menu) }
    app.modal = Some(Modal::Menu(menu));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_owner_matches_computer_engine_and_prefers_running_harness() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (100, 30));
        let x = crate::app::External { machine: "m".into(), session_id: "s".into(), engine: "claude".into(),
            title: "Saved".into(), cwd: "/project".into(), open: true, last_at: 1 };
        for (machine, id, engine, status) in [("other", "elsewhere", "claude", "active"), ("m", "codex", "codex", "active")] {
            app.fleet.agents.insert((machine.into(), id.into()), crate::fleet::agent_from(machine, &json!({"id":id,"sessionId":"s","engine":engine,"status":status}), None));
        }
        assert_eq!(conversation_agent(&app, &x), None);
        for (id, status) in [("archived", "stopped"), ("desktop", "active")] {
            app.fleet.agents.insert(("m".into(), id.into()), crate::fleet::agent_from("m", &json!({"id":id,"sessionId":"s","engine":"claude","status":status}), None));
            assert_eq!(conversation_agent(&app, &x).as_deref(), Some(id));
        }
        app.shell_context.catalog.push(crate::app::Said { machine: "m".into(), session_id: "s".into(), agent_id: "".into(),
            snippet: "".into(), turn: -1, at: 1, external: Some(x) });
        assert!(modal::external_rows(&app).is_empty());
        assert!(catalog_conversation(&app, "external:m:s").is_some(), "selection survives history-to-live deduplication");
        assert!(catalog_conversation(&app, "external:other:s").is_none());
    }

    #[test]
    fn only_authoritative_same_request_refusals_can_resolve_a_create_race() {
        assert!(already_in_harness("attempt", &Err(crate::daemon::RpcError::new("SESSION_IN_HARNESS", "Already managed"))));
        assert!(already_in_harness("attempt", &Ok(json!({"creationId":"attempt","state":"failed","failure":{"code":"SESSION_IN_HARNESS"}}))));
        for value in [json!({"creationId":"other","state":"failed","failure":{"code":"SESSION_IN_HARNESS"}}),
            json!({"creationId":"attempt","state":"pending"}),
            json!({"creationId":"attempt","state":"failed","failure":{"code":"SESSION_OPEN_ELSEWHERE"}})] {
            assert!(!already_in_harness("attempt", &Ok(value)));
        }
    }

    #[test]
    fn reported_cmd_p_reaches_only_an_integrated_shell_as_ctrl_p() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (100, 30));
        app.panes.insert(1, crate::pane::Pane::new(1, "local", "shell", 100, 28));
        let cmd = KeyEvent::new(KeyCode::Char('p'), KeyModifiers::SUPER);
        assert_eq!(for_pane(&app, 1, cmd), cmd);
        let mut context = crate::shell_context::Context::default();
        context.hosts.insert("local".into(), "shell".into());
        app.shell_context.contexts.insert("test".into(), context);
        let forwarded = for_pane(&app, 1, cmd);
        assert_eq!(encode_key(&forwarded, alacritty_terminal::term::TermMode::empty()), Some(vec![0x10]));
        for key in [KeyEvent::new(KeyCode::Char('p'), KeyModifiers::SUPER | KeyModifiers::SHIFT),
            KeyEvent::new(KeyCode::Char('r'), KeyModifiers::SUPER),
            KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)] {
            assert_eq!(for_pane(&app, 1, key), key);
        }
        assert_eq!(for_pane(&app, 2, cmd), cmd);
    }

    #[tokio::test]
    async fn clicking_a_menu_over_welcome_uses_that_row_without_prior_motion() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (100, 30));
        app.mouse = true;
        app.tab_mut().home = true;
        crate::workspace_menu::open(&mut app, "Choose", vec![
            crate::workspace_menu::note("Choose an action"),
            crate::workspace_menu::item("First", "a", "set -g @clicked first"),
            crate::workspace_menu::item("Second", "b", "set -g @clicked second"),
        ], Some((3, 2)), Some(1));
        handle(&mut app, CEvent::Mouse(MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: 5, row: 5, modifiers: KeyModifiers::NONE }));
        assert_eq!(app.options.get("@clicked", "", None).as_deref(), Some("second"));
        assert!(app.modal.is_none());
    }

    #[tokio::test]
    async fn menu_mouse_release_and_disabled_rows_do_not_run_an_action() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (100, 30));
        app.mouse = true;
        crate::workspace_menu::open(&mut app, "Choose", vec![
            crate::workspace_menu::note("Information"),
            crate::workspace_menu::item("Run", "r", "set -g @clicked yes"),
        ], Some((3, 2)), Some(1));
        let mut mouse = MouseEvent { kind: MouseEventKind::Up(MouseButton::Left), column: 5, row: 4, modifiers: KeyModifiers::NONE };
        handle(&mut app, CEvent::Mouse(mouse));
        assert!(app.options.get("@clicked", "", None).is_none());
        assert!(matches!(app.modal, Some(Modal::Menu(_))));
        mouse.kind = MouseEventKind::Down(MouseButton::Left);
        mouse.row = 3;
        handle(&mut app, CEvent::Mouse(mouse));
        assert!(app.options.get("@clicked", "", None).is_none());
        assert!(matches!(app.modal, Some(Modal::Menu(_))));
        mouse.row = 4;
        handle(&mut app, CEvent::Mouse(mouse));
        assert_eq!(app.options.get("@clicked", "", None).as_deref(), Some("yes"));
    }

    #[test]
    fn os_actions_are_unavailable_in_ordinary_hn_and_install_is_live_only() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (80, 24));
        app.handed_over = true;
        let key = |code| KeyEvent::new(code, KeyModifiers::NONE);
        app.os_session = false;
        for live in [false, true] {
            app.os_live = live;
            assert!(!os_home(&app));
            for code in [KeyCode::Enter, KeyCode::Char('i'), KeyCode::Char('I'), KeyCode::Char('t'), KeyCode::Char('T'), KeyCode::Char('w'), KeyCode::Char('W')] {
                assert_eq!(os_home_command(&app, key(code)), None);
            }
        }
        app.os_session = true;
        app.os_live = false;
        assert!(!typing(&app), "the OS setup page retains root key bindings");
        assert_eq!(os_home_command(&app, key(KeyCode::Enter)), Some(Some("/usr/bin/hn-os try")));
        assert_eq!(os_home_command(&app, key(KeyCode::Char('T'))), Some(None));
        for code in [KeyCode::Char('i'), KeyCode::Char('I')] {
            assert_eq!(os_home_command(&app, key(code)), None);
        }
        app.os_live = true;
        for code in [KeyCode::Enter, KeyCode::Char('i'), KeyCode::Char('I')] {
            assert_eq!(os_home_command(&app, key(code)), Some(Some("sudo /usr/bin/harness install")));
        }
        assert_eq!(os_home_command(&app, key(KeyCode::Char('T'))), Some(Some("/usr/bin/hn-os welcome")));
        for modifiers in [KeyModifiers::CONTROL, KeyModifiers::ALT, KeyModifiers::SUPER] {
            assert_eq!(os_home_command(&app, KeyEvent::new(KeyCode::Enter, modifiers)), None);
        }
    }

    #[tokio::test]
    async fn created_harness_stays_in_the_current_window() {
        for existing in 0..=2 {
            for detached in [false, true] {
                let (sink, _) = tokio::sync::mpsc::unbounded_channel();
                let mut app = App::new(19789, sink, (150, 42));
                for index in 0..existing {
                    app.open_agent("fixture", &format!("existing-{index}"), Placement::Auto(None));
                }
                let window = app.tab().id.clone();
                let panes = app.tab().panes();
                let focus = app.focused();
                app.tab_mut().zoomed = existing > 1;
                let session = app.session_id;
                creation_finished(&mut app, "fixture".into(), session,
                    NewOpts { detached, ..Default::default() },
                    Ok(json!({"agent":{"id":"created", "name":"New harness", "engine":"codex"}})), false);
                assert_eq!(app.tabs.len(), 1, "creation must not add a window");
                assert_eq!(app.tab().id, window);
                assert_eq!(app.tab().panes().len(), existing + 1);
                assert!(panes.iter().all(|p| app.tab().panes().contains(p)));
                let (_, created) = app.find_pane("fixture", "created").unwrap();
                assert_eq!(app.focused(), if detached { focus.or(Some(created)) } else { Some(created) });
                assert_eq!(app.tab().zoomed, detached && existing > 1);
            }
        }
    }

    #[tokio::test]
    async fn created_harness_reuses_the_home_window() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (150, 42));
        let window = app.tab().id.clone();
        app.tab_mut().home = true;
        app.open_agent("fixture", "home-shell", Placement::Fill(window.clone()));
        assert!(app.tab().home);
        let session = app.session_id;
        creation_finished(&mut app, "fixture".into(), session, NewOpts::default(),
            Ok(json!({"agent":{"id":"created", "name":"New harness", "engine":"codex"}})), false);
        assert_eq!(app.tabs.len(), 1);
        assert_eq!(app.tab().id, window);
        assert_eq!(app.tab().panes().len(), 1);
        assert!(!app.tab().home);
        assert!(app.find_pane("fixture", "home-shell").is_none());
        let (_, created) = app.find_pane("fixture", "created").unwrap();
        assert_eq!(app.focused(), Some(created));
    }

    #[tokio::test]
    async fn a_delayed_launch_fills_its_original_window_without_stealing_the_current_one() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (150, 42));
        let first = app.tab().id.clone();
        app.tab_mut().home = true;
        app.open_agent("fixture", "unused-shell", Placement::Fill(first.clone()));
        let session = app.session_id;
        app.new_tab();
        app.open_agent("fixture", "other-work", Placement::Auto(None));
        let current = app.tab().id.clone();
        let focus = app.focused();
        let lastw = app.lastw.clone();
        creation_finished(&mut app, "fixture".into(), session,
            NewOpts { target: Some(LaunchTarget { session, tab: first.clone() }), ..Default::default() },
            Ok(json!({"agent":{"id":"created", "name":"New harness", "engine":"codex"}})), false);
        assert_eq!(app.tab().id, current);
        assert_eq!(app.focused(), focus);
        assert_eq!(app.lastw, lastw, "a background completion must preserve last-window navigation");
        assert_eq!(app.tabs.len(), 2);
        assert!(app.find_pane("fixture", "unused-shell").is_none());
        let (window, _) = app.find_pane("fixture", "created").unwrap();
        assert_eq!(app.tabs[window].id, first);
        assert_eq!(app.tabs[window].panes().len(), 1);
        assert!(!app.tabs[window].home);
    }

    #[tokio::test]
    async fn a_closed_launch_window_does_not_replace_unrelated_work() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (150, 42));
        app.open_agent("fixture", "other-work", Placement::Auto(None));
        let before = (app.tab().id.clone(), app.focused());
        let session = app.session_id;
        creation_finished(&mut app, "fixture".into(), session,
            NewOpts { target: Some(LaunchTarget { session, tab: "closed-window".into() }), ..Default::default() },
            Ok(json!({"agent":{"id":"created", "name":"New harness", "engine":"codex"}})), false);
        assert_eq!((app.tab().id.clone(), app.focused()), before);
        assert_eq!(app.tabs.len(), 1);
        assert!(app.find_pane("fixture", "created").is_none());
        assert!(app.fleet.agent("fixture", "created").is_some(), "completed work remains available in Sessions");
    }

    #[tokio::test]
    async fn delayed_picker_refresh_preserves_the_replacement_modal() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (80, 24));
        app.modal = Some(Modal::Prompt(Prompt::status(PromptKind::Key { template: String::new() }, ":", "split-window")));
        refill(&mut app);
        assert!(matches!(&app.modal, Some(Modal::Prompt(p)) if p.value == "split-window"));
        app.modal = Some(Modal::Confirm { prompt: "kill pane?".into(), command: "kill-pane".into(), key: 'y', enter_yes: false });
        refill(&mut app);
        assert!(matches!(app.modal, Some(Modal::Confirm { .. })));
        app.modal = Some(Modal::Copy { pane: 1 });
        refill(&mut app);
        assert!(matches!(app.modal, Some(Modal::Copy { pane: 1 })));
    }

    #[test]
    fn prompt_words_as_tmuxs() {
        // Checked against tmux 3.5a's vi prompt: `display a-b.c d`, then 0 w w e E B b.
        let ws = "!\"#$%&'()*+,-./:;<=>?@[\\]^`{|}~";
        let c: Vec<char> = "display a-b.c d".chars().collect();
        assert_eq!(forward_word_vi(&c, 0, ws), 8);
        assert_eq!(forward_word_vi(&c, 8, ws), 9);
        assert_eq!(end_word(&c, 9, ws), 10);
        assert_eq!(end_word(&c, 10, ""), 12);
        assert_eq!(backward_word(&c, 12, ""), 8);
        assert_eq!(backward_word(&c, 8, ws), 0);
        // At the end, nowhere to go.
        assert_eq!(forward_word_vi(&c, c.len(), ws), c.len());
        assert_eq!(end_word(&c, c.len(), ws), c.len());
    }

    /// `theme` from the command prompt (`: theme`) or the launcher must open the theme picker —
    /// the same dispatch `input::run` executes. Guards the `is_command`/`picker` wiring end to end.
    #[test]
    fn theme_command_opens_the_theme_picker() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (80, 24));
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(crate::fleet::Machine { shared: false,
            id: "local".into(), name: "studio".into(), local: true, status: "online".into(), reach: crate::fleet::Reach::Ready,
        });
        app.homes.insert("local".into(), "/home/dev".into());

        // is_command("theme") is true, so the command-prompt routes it here.
        assert!(is_command("theme"));
        run(&mut app, "theme");

        let modal = app.modal.as_ref().expect("`theme` should open a picker modal");
        let Modal::Picker { kind, picker } = modal else {
            panic!("`theme` opened a non-picker modal");
        };
        assert!(matches!(kind, PickerKind::Theme), "opened {:?}", std::mem::discriminant(kind));

        // Level one: the section list, not the whole flat gallery — sections only, no groups.
        assert!(picker.theme_in.is_none(), "opens on the sections");
        assert_eq!(picker.rows.first().map(|r| r.id.as_str()), Some("section:theme"));
        assert!(picker.rows.iter().all(|r| r.id.starts_with("section:")), "level one lists sections only");

        // Each section opens onto its options; the theme section lists every bundled theme.
        use crate::terminal_themes::TERMINAL_THEMES;
        let theme_opts = crate::modal::theme_options(&app, "theme");
        assert_eq!(theme_opts.len(), TERMINAL_THEMES.len() + 1, "the terminal's own, then every bundled theme");
        let first_id = format!("theme:{}", TERMINAL_THEMES[0].name);
        assert_eq!(theme_opts.get(1).map(|r| r.id.as_str()), Some(first_id.as_str()));
        for r in &theme_opts { assert!(!r.lead.is_empty(), "mark missing on {}", r.id); }
    }

    /// Enter opens a section (level one → level two), and the picker stays open on that section's
    /// options. Guards the drill-in navigation (the option apply is `set_look`, tested elsewhere).
    #[test]
    fn theme_enter_opens_the_section() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (80, 24));
        app.fleet.local_id = "local".into();
        app.fleet.machines.push(crate::fleet::Machine { shared: false,
            id: "local".into(), name: "studio".into(), local: true, status: "online".into(), reach: crate::fleet::Reach::Ready,
        });
        app.homes.insert("local".into(), "/home/dev".into());

        picker(&mut app, PickerKind::Theme, "look & theme", "esc done");
        {
            let Modal::Picker { kind, picker } = app.modal.take().unwrap() else { panic!() };
            assert!(matches!(kind, PickerKind::Theme));
            assert!(picker.theme_in.is_none(), "opens on the sections");
            assert_eq!(picker.current_id().as_deref(), Some("section:theme"));
            choose(&mut app, kind, picker, Choice::Enter);
        }
        let Modal::Picker { kind, picker } = app.modal.as_ref().unwrap() else { panic!() };
        assert!(matches!(kind, PickerKind::Theme));
        assert_eq!(picker.theme_in.as_deref(), Some("theme"), "Enter opened the section");
        assert!(picker.rows.iter().all(|r| r.id.starts_with("theme:")), "the section's options show");
        assert!(picker.rows.iter().any(|r| r.lead.iter().any(|s| s.content.as_ref() == "✓ ")), "the current option is marked");
    }
}
