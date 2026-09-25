//! Keys and mouse: which go to Harness and which go to the harness in front of you.
//!
//! Harness takes ⌥+key (⌘ too, where the terminal speaks the kitty keyboard protocol and passes ⌘
//! through) and anything after the prefix ^Space. Everything else is the focused pane's — encoded
//! the way an xterm would, in the pane's own modes. ⌥ chords a shell's line editor lives on (⌥B ⌥F
//! ⌥D ⌥. ⌥Y ⌥U ⌥C) are never taken; their commands are on the prefix and in ⌥P.

use std::time::Duration;

use crossterm::event::{Event as CEvent, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use serde_json::json;

use crate::app::{App, Placement};
use crate::layout::{self, Dir, Preset, Toward};
use crate::modal::{self, Filter, Modal, PickerKind, Prompt, PromptKind, What};
use crate::pane::{encode_key, encode_mouse, Phase};
use crate::picker::Picker;
use crate::theme;

pub fn handle(app: &mut App, event: CEvent) {
    match event {
        CEvent::Key(key) if key.kind != KeyEventKind::Release => on_key(app, key),
        CEvent::Paste(text) => on_paste(app, text),
        CEvent::Mouse(mouse) => on_mouse(app, mouse),
        CEvent::Resize(cols, rows) => { app.size = (cols, rows); app.fit_panes() }
        _ => {}
    }
}

/// The command a chord names, if Harness owns it.
fn chord(key: &KeyEvent) -> Option<&'static str> {
    Some(match key.code {
        KeyCode::Char(c) => match c {
            'p' => "open",
            'P' => "palette",
            'o' | 'O' => "projects",
            'n' => "new",
            'N' => "clone",
            't' => "tab",
            'T' => "terminal",
            'i' => "models",
            'I' => "inbox",
            'm' | 'M' => "machines",
            's' | 'S' => "store",
            '/' | '?' => "help",
            'E' => "restart",
            'R' => "rename-tab",
            'l' => "focus-right",
            'h' => "focus-left",
            'j' => "focus-down",
            'k' => "focus-up",
            'H' => "grow-left",
            'J' => "grow-down",
            'K' => "grow-up",
            'L' => "layout",
            'w' => "close-pane",
            'W' => "close-tab",
            '\\' | '|' => "split-right",
            '-' | '_' => "split-down",
            'z' | 'Z' => "zoom",
            '{' => "prev-tab",
            '}' => "next-tab",
            '=' => "equalize",
            'g' | 'G' => "send",
            'f' | 'F' => "find",
            'q' | 'Q' => "quit",
            '1' => "tab-1", '2' => "tab-2", '3' => "tab-3", '4' => "tab-4", '5' => "tab-5",
            '6' => "tab-6", '7' => "tab-7", '8' => "tab-8", '9' => "tab-9",
            _ => return None,
        },
        // ⌥⏎ is a newline and ⌥←/→ a word jump in every prompt and shell: those stay the pane's.
        // ⌘ (kitty protocol) and the prefix still reach them.
        KeyCode::Enter if !key.modifiers.contains(KeyModifiers::ALT) => "zoom",
        KeyCode::Left if !key.modifiers.contains(KeyModifiers::ALT) => "focus-left",
        KeyCode::Right if !key.modifiers.contains(KeyModifiers::ALT) => "focus-right",
        KeyCode::Up if !key.modifiers.contains(KeyModifiers::ALT) => "focus-up",
        KeyCode::Down if !key.modifiers.contains(KeyModifiers::ALT) => "focus-down",
        _ => return None,
    })
}

/// After the prefix, the same letters without ⌥ — plus the ones ⌥ leaves to the shell.
fn prefixed(key: &KeyEvent) -> Option<&'static str> {
    if let KeyCode::Char(c) = key.code {
        match c {
            'b' => return Some("send"),
            'd' => return Some("quit"),
            'x' => return Some("close-pane"),
            'c' => return Some("tab"),
            'r' => return Some("split-right"),
            ' ' => return Some("next-tab"),
            _ => {}
        }
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char(' ') { return Some("prefix-self") }
    chord(key)
}

fn on_key(app: &mut App, key: KeyEvent) {
    let mods = key.modifiers;
    // The prefix.
    if app.prefix {
        app.prefix = false;
        if key.code == KeyCode::Esc { return }
        if let Some(command) = prefixed(&key) {
            if command == "prefix-self" { send_to_focused(app, vec![0]); return }
            run(app, command);
        }
        return;
    }
    if mods.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char(' ') | KeyCode::Char('@')) {
        app.prefix = true;
        return;
    }
    let command_mod = mods.contains(KeyModifiers::ALT) || mods.contains(KeyModifiers::SUPER);
    if command_mod && !mods.contains(KeyModifiers::CONTROL) {
        if let Some(command) = chord(&key) {
            // An open overlay answers ⌥1…9 itself (answer a question).
            let digits_to_modal = app.modal.is_some() && matches!(key.code, KeyCode::Char('1'..='9'));
            if !digits_to_modal {
                if app.modal.is_some() && !matches!(command, "open" | "palette" | "inbox" | "machines" | "new" | "help" | "store" | "quit") { app.modal = None }
                run(app, command);
                return;
            }
        }
    }
    if app.modal.is_some() { modal_key(app, key); return }
    let Some(focus) = app.focused() else { home_key(app, key); return };
    // Shift+PageUp/Down scroll the tile's own history, as in every terminal.
    if mods.contains(KeyModifiers::SHIFT) && matches!(key.code, KeyCode::PageUp | KeyCode::PageDown) {
        if let Some(pane) = app.panes.get_mut(&focus) {
            let page = pane.rows as i32 - 2;
            pane.scroll(if key.code == KeyCode::PageUp { page } else { -page });
        }
        return;
    }
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
    let Some(pane) = app.panes.get_mut(&focus) else { return };
    if pane.read_only || matches!(pane.phase, Phase::Watching(_)) || pane.stream.is_none() {
        pane.queued.push(bytes);
        if !pane.opening { app.open_stream(focus, true) }
        return;
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
            MouseEventKind::ScrollUp => if let Some(Modal::Picker { picker, .. }) = &mut app.modal { picker.move_by(-3) },
            MouseEventKind::ScrollDown => if let Some(Modal::Picker { picker, .. }) = &mut app.modal { picker.move_by(3) },
            _ => {}
        }
        return;
    }
    let (x, y) = (mouse.column, mouse.row);
    // The tab strip.
    if y == 0 {
        if let MouseEventKind::Down(MouseButton::Left) = mouse.kind {
            if let Some(index) = crate::ui::tab_at(app, x) { app.select_tab(index) }
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
            } else { pane.scroll(3) }
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

// ── home: the empty tab ─────────────────────────────────────────────────────

pub fn home_agents(app: &App) -> Vec<(String, String)> {
    app.fleet.ranked().into_iter()
        .filter(|a| !matches!(app.fleet.state_of(a), crate::fleet::State::Paused | crate::fleet::State::Offline))
        .take(9)
        .map(|a| a.key())
        .collect()
}

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

fn picker(app: &mut App, kind: PickerKind, title: &str, placeholder: &str) {
    let mut picker = Picker::new(title, placeholder);
    fill(app, &kind, &mut picker);
    app.modal = Some(Modal::Picker { kind, picker });
}

/// (Re)build an overlay's rows from the fleet — called on open and whenever the fleet moves.
pub fn fill(app: &App, kind: &PickerKind, picker: &mut Picker) {
    match kind {
        PickerKind::Open { filter, machine, project } => {
            picker.set_rows(modal::agent_rows(app, *filter, machine.as_deref(), project.as_deref()));
            picker.status = modal::open_status(app, *filter);
            picker.hints = vec![("enter", "open"), ("^t", "tab"), ("^v", "split right"), ("^s", "split down"), ("^r", "here"), ("tab", "filter"), ("^x", "pause/resume"), ("⌥1-9", "answer")];
            picker.empty = if app.fleet.agents.is_empty() { "No harnesses yet — ⌥N makes one.".into() } else { "Nothing matches.".into() };
        }
        PickerKind::Palette => { picker.set_rows(modal::palette_rows(app)); picker.hints = vec![("enter", "run")] }
        PickerKind::Projects => {
            picker.set_rows(modal::project_rows(app));
            picker.hints = vec![("enter", "its harnesses"), ("^n", "new harness there")];
            picker.empty = "No projects yet.".into();
        }
        PickerKind::Models => {
            picker.keep_order = true;
            picker.set_rows(modal::model_rows(app));
            // Start on the model it runs, so ↑/↓ are "a little more / less" from where it is.
            if picker.query.trim() == ":" && picker.selected_id.is_none() {
                if let Some(current) = focused_agent(app).and_then(|(m, a)| app.fleet.agent(&m, &a).map(|x| x.model.clone())) {
                    if let Some(at) = picker.visible.iter().position(|(i, _)| picker.rows[*i].id == current) { picker.cursor = at; picker.selected_id = Some(current) }
                }
            }
            picker.hints = vec![("enter", "use")];
            picker.empty = if app.focused().is_none() { "Focus a harness to switch its model.".into() } else { "Loading its models…".into() };
            picker.status = app.focused().and_then(|f| app.panes.get(&f)).and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| a.name.clone()).unwrap_or_default();
        }
        PickerKind::Inbox => {
            picker.keep_order = true;
            picker.set_rows(modal::inbox_rows(app));
            picker.status = format!("{} waiting", app.fleet.waiting());
            picker.hints = vec![("enter", "answer / jump"), ("^o", "open")];
            picker.empty = "Nobody is waiting on you.".into();
        }
        PickerKind::Machines => {
            picker.set_rows(modal::machine_rows(app));
            let up = app.fleet.machines.iter().filter(|m| m.usable()).count();
            picker.status = format!("{up}/{} connected", app.fleet.machines.len());
            picker.hints = vec![("enter", "its harnesses"), ("^n", "new there"), ("^t", "terminal there"), ("^l", "link")];
        }
        PickerKind::Layout => { picker.set_rows(modal::layout_rows()); picker.hints = vec![("enter", "apply")] }
        PickerKind::Help => { picker.keep_order = true; picker.set_rows(modal::mode_rows()); picker.status = "⌥ = Option/Alt".into(); picker.hints = vec![("enter", "go")] }
        PickerKind::Store => {
            let catalog = app.dsh.get(&app.fleet.local_id).cloned().unwrap_or_default();
            picker.set_rows(modal::store_rows(&catalog));
            picker.status = format!("{} available", catalog.len());
            picker.hints = vec![("enter", "start one"), ("^i", "install")];
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
    }
}

fn prompt(app: &mut App, kind: PromptKind, title: &str, label: &str, hint: &str, value: &str, secret: bool) {
    app.modal = Some(Modal::Prompt(Prompt { kind, title: title.into(), label: label.into(), hint: hint.into(), value: value.into(), secret }));
}

fn focused_agent(app: &App) -> Option<(String, String)> {
    app.focused().and_then(|f| app.panes.get(&f)).map(|p| (p.machine_id.clone(), p.agent_id.clone()))
}

/// The one box: open it in the mode [prefix] names (`""` harnesses, `>` `@` `#` `:` `*` `?`). The
/// same key again, while it is already in that mode, closes it.
pub fn launch(app: &mut App, prefix: &str, filter: Filter) {
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

fn load_models(app: &mut App) {
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
            if let Some(f) = app.focused() { app.close_pane(f) }
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
        "find" => {
            let Some(pane) = app.focused() else { return };
            app.modal = Some(Modal::Find { pane, query: String::new(), found: None });
        }
        "quit" => app.quit = true,
        c if c.starts_with("tab-") => { let n: usize = c[4..].parse().unwrap_or(1); app.select_tab(n - 1) }
        _ => {}
    }
}

thread_local! {
    /// Which way the next harness picked in ⌥O goes, when ⌥O was opened by a split.
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
        Modal::Find { pane, mut query, mut found } => {
            let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
            let Some(p) = app.panes.get_mut(&pane) else { return };
            match key.code {
                KeyCode::Esc => { p.end_find(); return }
                KeyCode::Char('c' | 'g') if ctrl => { p.end_find(); return }
                KeyCode::Enter | KeyCode::Up => { if !p.find(&query, true, false) { found = Some(false) } else { found = Some(true) } }
                KeyCode::Char('p' | 'k') if ctrl => { found = Some(p.find(&query, true, false)) }
                KeyCode::Down => { found = Some(p.find(&query, false, false)) }
                KeyCode::Char('n' | 'j') if ctrl => { found = Some(p.find(&query, false, false)) }
                KeyCode::Backspace => { query.pop(); found = Some(p.find(&query, true, true)) }
                KeyCode::Char('u') if ctrl => { query.clear(); p.end_find() }
                KeyCode::Char(c) if !ctrl => { query.push(c); found = Some(p.find(&query, true, true)) }
                _ => {}
            }
            app.modal = Some(Modal::Find { pane, query, found });
        }
        Modal::Prompt(mut p) => {
            match key.code {
                KeyCode::Esc => return,
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return,
                KeyCode::Enter => { submit_prompt(app, p); return }
                KeyCode::Backspace => { if key.modifiers.contains(KeyModifiers::ALT) { let t = p.value.trim_end().to_string(); let cut = t.rfind(' ').map(|i| i + 1).unwrap_or(0); p.value.truncate(cut) } else { p.value.pop(); } }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => p.value.clear(),
                KeyCode::Char('w') if key.modifiers.contains(KeyModifiers::CONTROL) => { let t = p.value.trim_end().to_string(); let cut = t.rfind(' ').map(|i| i + 1).unwrap_or(0); p.value.truncate(cut) }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => p.value.push(c),
                _ => {}
            }
            app.modal = Some(Modal::Prompt(p));
        }
        Modal::Picker { kind, mut picker } => {
            let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
            let alt = key.modifiers.contains(KeyModifiers::ALT);
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
            match key.code {
                KeyCode::Esc => { SPLIT.with(|s| s.set(None)); return }
                KeyCode::Char('c' | 'g' | 'q') if ctrl => { SPLIT.with(|s| s.set(None)); return }
                KeyCode::Up => picker.move_by(-1),
                KeyCode::Down => picker.move_by(1),
                KeyCode::Char('p' | 'k') if ctrl => picker.move_by(-1),
                KeyCode::Char('n' | 'j') if ctrl && !matches!(kind, PickerKind::Machines) => picker.move_by(1),
                KeyCode::PageUp => picker.move_by(-10),
                KeyCode::PageDown => picker.move_by(10),
                KeyCode::Backspace => picker.backspace(alt),
                KeyCode::Char('u') if ctrl => picker.clear_query(),
                KeyCode::Char('w') if ctrl => picker.backspace(true),
                KeyCode::Tab | KeyCode::BackTab => {
                    if let PickerKind::Open { filter, machine, project } = kind {
                        let kind = PickerKind::Open { filter: filter.next(), machine, project };
                        fill(app, &kind, &mut picker);
                        app.modal = Some(Modal::Picker { kind, picker });
                        return;
                    }
                    if let PickerKind::Store = kind { return store_install(app, kind, picker) }
                }
                KeyCode::Char(c @ '1'..='9') if alt => { answer_from(app, &kind, &mut picker, c as usize - '1' as usize) }
                KeyCode::Enter => { choose(app, kind, picker, Choice::Enter); return }
                KeyCode::Char('t') if ctrl => { choose(app, kind, picker, Choice::Tab); return }
                KeyCode::Char('v') if ctrl => { choose(app, kind, picker, Choice::SplitRight); return }
                KeyCode::Char('s') if ctrl => { choose(app, kind, picker, Choice::SplitDown); return }
                KeyCode::Char('r') if ctrl => { choose(app, kind, picker, Choice::Here); return }
                KeyCode::Char('o') if ctrl => { choose(app, kind, picker, Choice::Open); return }
                KeyCode::Char('x') if ctrl => { choose(app, kind, picker, Choice::Pause); return }
                KeyCode::Char('n') if ctrl => { choose(app, kind, picker, Choice::New); return }
                KeyCode::Char('l') if ctrl => { choose(app, kind, picker, Choice::Link); return }
                KeyCode::Char('i') if ctrl => { if let PickerKind::Store = kind { return store_install(app, kind, picker) } }
                KeyCode::Char(c) if !ctrl && !alt => picker.type_char(c),
                _ => {}
            }
            let mut kind = kind;
            if picker.query != before {
                let (next, changed) = remode(app, kind, &mut picker);
                kind = next;
                if changed { prepare(app, &kind); fill(app, &kind, &mut picker) }
            }
            app.modal = Some(Modal::Picker { kind, picker });
        }
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
            app.open_agent(&machine, &agent, placement);
            if state == Some(crate::fleet::State::Paused) {
                if let Some((_, pane)) = app.find_pane(&machine, &agent) { app.resume(pane) }
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
        PickerKind::Palette => { if let Some(id) = id { run(app, &id) } }
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
        PickerKind::Route { text } => {
            let Some((machine, agent)) = id.as_deref().and_then(split_key) else { return keep(app, kind, picker) };
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
                    app.toast = None;
                    app.modal = Some(Modal::Picker { kind: PickerKind::Route { text: value }, picker });
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
            let script = std::env::var("HARNESS_CLI_SCRIPT").ok().filter(|s| !s.is_empty());
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
                else { app.say(format!("Could not link: {}", out.lines().last().unwrap_or("")), theme::DANGER) }
            });
        }
    }
}

