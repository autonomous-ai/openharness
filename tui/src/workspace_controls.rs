//! Quiet controls in the chrome already on screen. Hit boxes are the cells actually drawn;
//! terminal cells keep their own mouse reporting, copy mode and tmux bindings.
use std::cell::RefCell;

use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
use ratatui::{buffer::Buffer, layout::Rect, style::{Modifier, Style}};
use unicode_width::UnicodeWidthStr;

use crate::{app::App, draw::RangeKind, theme, workspace_menu as menu};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action { New, Menu, Account, Header(u64), PaneMenu(u64), Agent(u64), Model(u64), Close(u64) }

#[derive(Default)]
pub struct State {
    pub hits: RefCell<Vec<(Rect, Action)>>,
    /// The release of a UI click belongs to that control, even if it opened or dismissed a modal.
    pub pressed: Option<MouseButton>,
    target: Option<MenuTarget>,
    workspace_open: bool,
}

struct MenuTarget {
    token: String,
    window: String,
    pane: Option<(u64, String, String, String, String)>,
    owner: String,
    connection: Option<u64>,
}

pub fn begin_frame(app: &App) { app.controls.hits.borrow_mut().clear(); }

fn enabled(app: &App) -> bool { app.mouse && !app.headless && !app.options.tmux_look() && !app.read_only() }

pub fn register(app: &App, rect: Rect, action: Action) {
    if rect.width > 0 && rect.height > 0 { app.controls.hits.borrow_mut().push((rect, action)); }
}

pub fn title_reserve(app: &App, window: usize, pane: u64, width: u16) -> u16 {
    let tab = app.tabs.get(window).map(|t| t.id.as_str()).unwrap_or("");
    if !enabled(app) || !app.mouse || width < 20 || app.options.has_window_override("pane-border-format", tab, pane) { return 0 }
    6 + identity_labels(app, pane, width).iter().map(|(label, _)| label.width() as u16 + 2).sum::<u16>()
}

fn identity_labels(app: &App, pane: u64, width: u16) -> Vec<(String, Action)> {
    let mut labels = Vec::new();
    let mut available = width.saturating_sub(30);
    if crate::agent_switch::pane_supports(app, pane) {
        let label = crate::agent_switch::pane_label(app, pane);
        let size = label.width() as u16 + 2;
        if size <= available { available -= size; labels.push((label, Action::Agent(pane))); }
    }
    if crate::models::pane_supports(app, pane) {
        let label = crate::models::pane_label(app, pane);
        if label.width() as u16 + 2 <= available { labels.push((label, Action::Model(pane))); }
    }
    labels
}

/// Return the title's remaining space. The controls never add a row or resize a terminal.
pub fn title(buf: &mut Buffer, app: &App, pane: u64, rect: Rect, style: Style) -> Rect {
    let reserve = title_reserve(app, app.active, pane, rect.width);
    if reserve == 0 { return rect }
    register(app, rect, Action::Header(pane));
    let quiet = style.remove_modifier(Modifier::BOLD | Modifier::DIM).fg(theme::paint(theme::pane_palette().muted));
    let x = rect.right() - 6;
    let mut start = rect.right() - reserve;
    for (label, action) in identity_labels(app, pane, rect.width) {
        let size = label.width() as u16 + 2;
        buf.set_stringn(start, rect.y, format!(" {label} "), size as usize, quiet);
        register(app, Rect::new(start, rect.y, size, 1), action);
        start += size;
    }
    buf.set_stringn(x, rect.y, " …  × ", 6, quiet);
    register(app, Rect::new(x, rect.y, 3, 1), Action::PaneMenu(pane));
    register(app, Rect::new(x + 3, rect.y, 3, 1), Action::Close(pane));
    Rect::new(rect.x, rect.y, rect.width - reserve, rect.height)
}

/// tmux's status renderer carries these ranges through clipping and alignment. A customized
/// status format keeps ownership of every cell unless it opts in with #{hn_controls}.
pub fn status(app: &App) -> String {
    if !enabled(app) { return String::new() }
    let mut parts = Vec::new();
    if app.account.status == crate::account::Status::SignedOut {
        parts.push("#[range=user|hn-account]Sign in#[norange]".to_string());
    }
    parts.extend(["#[range=user|hn-new]+#[norange]", "#[range=user|hn-menu]…#[norange]"].map(str::to_string));
    parts.join("  ")
}

/// The sidebar uses the same actions on its existing header/footer rows.
pub fn side_actions(buf: &mut Buffer, app: &App, rect: Rect, style: Style, account: bool) {
    if !enabled(app) { return }
    let items: Vec<(&str, Action)> = if account { vec![(crate::account::label(app), Action::Account)] }
        else { vec![("+", Action::New), ("…", Action::Menu)] };
    let total: u16 = items.iter().map(|(label, _)| label.width() as u16).sum::<u16>() + items.len().saturating_sub(1) as u16 * 2;
    if total > rect.width { return }
    let mut x = rect.right() - total;
    for (label, action) in items {
        let width = label.width() as u16;
        buf.set_stringn(x, rect.y, label, width as usize, style);
        register(app, Rect::new(x, rect.y, width, 1), action);
        x += width + 2;
    }
}

fn select_pane(app: &mut App, pane: u64) -> bool {
    let Some(tab) = app.tabs.iter().position(|t| t.panes().contains(&pane)) else { return false };
    if app.active != tab { app.select_tab(tab); }
    crate::commands::execute(app, &format!("select-pane -t {}", crate::pane::tag(pane)));
    true
}

pub fn activate(app: &mut App, action: Action, at: Option<(u16, u16)>) {
    match action {
        Action::New => crate::commands::execute(app, "new-window"),
        Action::Menu => workspace_menu(app, at),
        Action::Account => crate::account::open(app),
        Action::Header(pane) => { select_pane(app, pane); }
        Action::PaneMenu(pane) => pane_menu(app, pane, at),
        Action::Agent(pane) => if select_pane(app, pane) { crate::agent_switch::open(app, pane); },
        Action::Model(pane) => if crate::models::pane_supports(app, pane) && select_pane(app, pane) { crate::input::run(app, "models"); },
        Action::Close(pane) => crate::session_close::pane(app, pane),
    }
}

fn status_action(app: &App, x: u16, y: u16) -> Option<Action> {
    if app.bar_side().is_some() || app.status_lines() == 0 { return None }
    let top = if app.status_top { 0 } else { app.size.1.saturating_sub(app.status_lines()) };
    let row = y.checked_sub(top)?;
    let range = app.status_ranges.iter().rev().find(|(r, hit)| *r == row && x >= hit.start && x < hit.end)?;
    match &range.1.kind {
        RangeKind::User(id) => match id.as_str() { "hn-new" => Some(Action::New), "hn-menu" => Some(Action::Menu), "hn-account" => Some(Action::Account), _ => None },
        _ => None,
    }
}

pub fn begin_press(app: &mut App, button: MouseButton) {
    crate::mouse::cancel_clicks(app);
    app.controls.pressed = Some(button);
}

/// Before modal routing: consume only the matching release/drag of a press we handled.
pub fn finish_press(app: &mut App, mouse: &MouseEvent) -> bool {
    let Some(button) = app.controls.pressed else { return false };
    match mouse.kind {
        MouseEventKind::Up(up) if up == button => { app.controls.pressed = None; true }
        MouseEventKind::Drag(drag) if drag == button => true,
        MouseEventKind::Down(_) => { app.controls.pressed = None; false }
        _ => false,
    }
}

pub fn mouse(app: &mut App, mouse: &MouseEvent) -> bool {
    if !enabled(app) || app.modal.as_ref().is_some_and(|m| !matches!(m, crate::modal::Modal::Copy { .. })) { return false }
    if app.mouse_state.drag.is_some() { return false }
    if !mouse.modifiers.is_empty() || app.prefix || app.key_table.is_some() { return false }
    let inside = |r: &Rect| mouse.column >= r.x && mouse.column < r.right() && mouse.row >= r.y && mouse.row < r.bottom();
    let action = app.controls.hits.borrow().iter().rev().find(|(r, _)| inside(r)).map(|(_, a)| a.clone())
        .or_else(|| status_action(app, mouse.column, mouse.row));
    let at = Some((mouse.column, mouse.row.saturating_add(1)));
    // A title is a border in line layouts and a pane's first row in boxed layouts.
    // Either explicit binding takes precedence over the added header controls.
    let places: &[&str] = if matches!(action, Some(Action::Header(_) | Action::PaneMenu(_) | Action::Agent(_) | Action::Model(_) | Action::Close(_))) { &["Border", "Pane"] } else { &["Status"] };
    if let MouseEventKind::Down(button @ (MouseButton::Left | MouseButton::Right)) = mouse.kind {
        let defaults = crate::keys::Keymap::tmux_defaults();
        for place in places {
            let key = crate::keys::parse(&format!("MouseDown{}{place}", if button == MouseButton::Left { 1 } else { 3 })).unwrap();
            if app.keymap.root_command(&key).map(|b| &b.command) != defaults.root_command(&key).map(|b| &b.command) { return false }
        }
    }
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => if let Some(action) = action {
            if let Action::Header(pane) = action {
                if crate::mouse::over_resize_border(app, mouse.column, mouse.row) {
                    select_pane(app, pane);
                    return false;
                }
            }
            begin_press(app, MouseButton::Left);
            activate(app, action, at);
            return true;
        },
        MouseEventKind::Down(MouseButton::Right) => {
            let pane = match action { Some(Action::Header(p) | Action::PaneMenu(p) | Action::Agent(p) | Action::Model(p) | Action::Close(p)) => Some(p), _ => None };
            if let Some(pane) = pane { begin_press(app, MouseButton::Right); pane_menu(app, pane, at); return true; }
            let tab = crate::bar::hit_at(app, mouse.column, mouse.row).and_then(|hit| match hit { crate::bar::Hit::Window(i) => Some(i), _ => None }).or_else(|| {
                let top = if app.status_top { 0 } else { app.size.1.saturating_sub(app.status_lines()) };
                app.status_ranges.iter().find_map(|(row, hit)| {
                    if mouse.row != top + row || mouse.column < hit.start || mouse.column >= hit.end { return None }
                    if let RangeKind::Window(number) = hit.kind { (0..app.tabs.len()).find(|i| app.win_num(*i) as u64 == number) } else { None }
                })
            });
            if let Some(tab) = tab { begin_press(app, MouseButton::Right); tab_menu(app, tab, at); return true; }
            if action.is_some() { begin_press(app, MouseButton::Right); workspace_menu(app, at); return true; }
        }
        _ => {}
    }
    false
}

fn hinted(app: &App, label: &str, key: &str, command: &str) -> crate::modal::MenuItem {
    let hint = app.keymap.hint(command).or_else(|| app.keymap.key_for_name(command));
    let label = hint.map(|h| format!("{label}  {h}")).unwrap_or_else(|| label.to_string());
    menu::item(&label, key, command)
}

fn workspace_items(app: &App) -> Vec<crate::modal::MenuItem> {
    let counts = crate::workspace_resources::counts(app);
    let mut items = vec![
        hinted(app, "New Harness", "n", "new-harness"),
        hinted(app, "New Tab", "w", "new-window"),
        hinted(app, &format!("Harnesses  {}", counts.harnesses), "h", "choose-tree -s"),
        menu::item(&format!("Machines  {}", counts.machines), "m", "devices"),
        menu::item(&format!("Models  {}", counts.models.map(|n| n.to_string()).unwrap_or_else(|| "—".into())), "o", "models"),
        menu::item("Devices", "d", "hardware-devices"),
        menu::item(crate::account::label(app), "a", "account"),
        hinted(app, "Appearance", "s", "appearance"),
        hinted(app, "Commands & shortcuts", "?", "choose-command"),
    ];
    if crate::agent_switch::sync_pending(app) { items.push(menu::item("Retry workspace sync", "r", "workspace-sync")); }
    items
}

pub fn workspace_menu(app: &mut App, at: Option<(u16, u16)>) {
    let items = workspace_items(app);
    app.controls.workspace_open = menu::open(app, "Harness", items, at, Some(0));
    if app.controls.workspace_open { crate::models::refresh_inventory(app); }
}

pub fn refresh_workspace(app: &mut App) {
    if !app.controls.workspace_open { return }
    if matches!(&app.modal, Some(crate::modal::Modal::Menu(m)) if m.title == "Harness" && m.items.first().is_some_and(|i| i.command == "new-harness")) {
        let items = workspace_items(app);
        if let Some(crate::modal::Modal::Menu(m)) = &mut app.modal {
            if !menu::replace_items(m, items, app.size) {
                app.modal = None;
                app.say("Make the terminal larger to show this menu", theme::WARN);
                return;
            }
            if m.choice.is_some_and(|n| n >= m.items.len()) { m.choice = Some(m.items.len().saturating_sub(1)); }
        }
    } else { app.controls.workspace_open = false; }
}

fn capture(app: &mut App, tab: usize, pane: Option<u64>) -> Option<String> {
    let window = app.tabs.get(tab)?.id.clone();
    let pane = match pane {
        Some(id) => {
            let p = app.panes.get(&id)?;
            let a = app.fleet.agent(&p.machine_id, &p.agent_id);
            Some((id, p.machine_id.clone(), p.agent_id.clone(), a.map(|a| a.session_id.clone()).unwrap_or_default(), a.map(|a| a.created_at_wire.clone()).unwrap_or_default()))
        }
        None => None,
    };
    let token = uuid::Uuid::new_v4().simple().to_string();
    let connection = pane.as_ref().and_then(|p| app.connection_generation(&p.1));
    app.controls.target = Some(MenuTarget { token: token.clone(), window, pane, owner: app.fleet.local_id.clone(), connection });
    Some(token)
}

pub fn pane_menu(app: &mut App, pane: u64, at: Option<(u16, u16)>) {
    let Some(tab) = app.tabs.iter().position(|t| t.panes().contains(&pane)) else { return };
    let Some(token) = capture(app, tab, Some(pane)) else { return };
    let item = |label: &str, key: &str, verb: &str| menu::item(label, key, format!("pane-control {token} {verb}"));
    let close = app.panes.get(&pane).map(|p| {
        if app.fleet.machine(&p.machine_id).is_some_and(|m| m.shared) { "Close pane" }
        else if crate::session_close::managed_pane(app, pane) { "Stop Harness" } else { "Close terminal" }
    }).unwrap_or("Close pane");
    let mut model = item("Change model…", "m", "models");
    model.disabled = !crate::models::pane_supports(app, pane);
    let mut agent = item("Change agent…", "a", "agent");
    agent.disabled = !crate::agent_switch::pane_supports(app, pane);
    let items = vec![item("New Harness beside", "n", "new"), agent, model,
        item(if app.tabs[tab].zoomed { "Restore pane size" } else { "Zoom pane" }, "z", "zoom"),
        item("Rename…", "r", "rename"), item("Move to new tab", "w", "break"), item(close, "x", "close")];
    menu::open(app, "Pane", items, at, Some(0));
}

pub fn tab_menu(app: &mut App, tab: usize, at: Option<(u16, u16)>) {
    let Some(token) = capture(app, tab, None) else { return };
    let item = |label: &str, key: &str, verb: &str| menu::item(label, key, format!("pane-control {token} {verb}"));
    let items = vec![item("New Harness", "n", "new"), item("Rename…", "r", "rename"), item("Arrange panes…", "l", "layout"), item("Close Tab", "x", "close")];
    menu::open(app, "Tab", items, at, Some(0));
}

/// Menu callbacks refer to the captured pane/session, never to whichever pane became focused.
pub fn run(app: &mut App, token: &str, verb: &str) {
    let Some(target) = app.controls.target.take().filter(|t| t.token == token) else { return };
    if target.owner != app.fleet.local_id { app.say("The connection changed. Open this menu again.", theme::WARN); return }
    let Some(tab) = app.tabs.iter().position(|t| t.id == target.window) else { return };
    let pane = if let Some((id, machine, agent, session, created)) = target.pane {
        let same = app.tabs[tab].panes().contains(&id) && app.panes.get(&id).is_some_and(|p| p.machine_id == machine && p.agent_id == agent)
            && app.fleet.agent(&machine, &agent).map(|a| a.session_id == session && a.created_at_wire == created).unwrap_or(session.is_empty() && created.is_empty());
        if !same || target.connection != app.connection_generation(&machine) { app.say("This pane changed. Open its menu again.", theme::WARN); return }
        Some(id)
    } else { None };
    if verb == "close" {
        match pane { Some(p) => crate::session_close::pane(app, p), None => crate::session_close::tab(app, tab) }
        return;
    }
    if app.active != tab { app.select_tab(tab); }
    if let Some(p) = pane { select_pane(app, p); }
    match verb {
        "new" => crate::input::run(app, "new"),
        "models" => if pane.is_some_and(|p| crate::models::pane_supports(app, p)) { crate::input::run(app, "models"); },
        "agent" => if let Some(pane) = pane { crate::agent_switch::open(app, pane); },
        "zoom" => crate::input::run(app, "zoom"),
        "rename" => crate::input::run(app, if pane.is_some() { "rename" } else { "rename-tab" }),
        "break" => crate::commands::execute(app, "break-pane"),
        "layout" => crate::input::run(app, "layout"),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{Event, KeyModifiers};
    use serde_json::json;

    #[tokio::test]
    async fn workspace_menu_stays_visible_when_the_terminal_shrinks() {
        let mut app = app(170);
        workspace_menu(&mut app, Some((160, 30)));
        crate::input::handle(&mut app, Event::Resize(40, 12));
        let Some(crate::modal::Modal::Menu(menu)) = &app.modal else { panic!("workspace menu disappeared"); };
        assert!(menu.x + menu.width + 4 <= 40, "menu extends beyond the resized terminal");
        assert!(menu.y + menu.items.len() as u16 + 2 <= 12);
        let row = menu.items.iter().position(|item| item.command == "account").unwrap();
        let (x, y) = (menu.x + 3, menu.y + 1 + row as u16);
        crate::input::handle(&mut app, Event::Mouse(MouseEvent { kind:MouseEventKind::Down(MouseButton::Left), column:x, row:y, modifiers:KeyModifiers::NONE }));
        assert!(matches!(app.modal, Some(crate::modal::Modal::Picker { kind:crate::modal::PickerKind::Account, .. })));
    }

    #[tokio::test]
    async fn workspace_menu_mouse_actions_reach_their_registered_commands() {
        use crate::modal::{Modal, PickerKind};
        for (command, expected) in [("models", "Models"), ("devices", "Machines"), ("hardware-devices", "Devices"), ("account", "Account"), ("appearance", "Appearance")] {
            let mut app = app(120);
            workspace_menu(&mut app, None);
            let Some(Modal::Menu(menu)) = &app.modal else { panic!("menu"); };
            let index = menu.items.iter().position(|item| item.command == command).unwrap();
            let x = menu.x + 3; let y = menu.y + 1 + index as u16;
            crate::input::handle(&mut app, Event::Mouse(MouseEvent { kind:MouseEventKind::Down(MouseButton::Left), column:x, row:y, modifiers:KeyModifiers::NONE }));
            let Some(Modal::Picker { kind, .. }) = &app.modal else { panic!("{command} did not open: {:?}", app.toast); };
            assert!(matches!((expected, kind), ("Models", PickerKind::Models) | ("Machines", PickerKind::Devices(_)) | ("Devices", PickerKind::Hardware)
                | ("Account", PickerKind::Account) | ("Appearance", PickerKind::Theme)), "{command}");
            crate::input::handle(&mut app, Event::Mouse(MouseEvent { kind:MouseEventKind::Up(MouseButton::Left), column:x, row:y, modifiers:KeyModifiers::NONE }));
            assert!(matches!(app.modal, Some(Modal::Picker { .. })), "release must not close {command}");
        }
    }

    fn app(width: u16) -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19799, sink, (width, 32));
        app.handed_over = true;
        app.cfg_finished = true;
        app.desk_mode = crate::app::DeskMode::Off;
        app.fleet.local_id = "local".into();
        app.account.status = crate::account::Status::SignedOut;
        app.fleet.machines.push(crate::fleet::Machine { id: "local".into(), name: "studio".into(), local: true, shared: false, status: "online".into(), reach: crate::fleet::Reach::Ready });
        app.tabs.clear();
        for id in 1..=2 {
            let mut tab = crate::app::Tab::with_wid(&format!("work-{id}"), id);
            tab.root = Some(crate::layout::Node::new(id, width, 30));
            tab.focus = Some(id);
            app.tabs.push(tab);
            let mut pane = crate::pane::Pane::new(id, "local", &format!("a{id}"), width, 30);
            pane.phase = crate::pane::Phase::Live;
            app.panes.insert(id, pane);
        }
        // merge_roster is a full inventory, so seed both at once.
        app.fleet.merge_roster("local", &(1..=2).map(|id| json!({ "id": format!("a{id}"), "name": format!("Task {id}"), "engine": "codex", "sessionId": format!("s{id}"),
            "createdAt": "2026-10-03T10:00:00.123Z", "status": "active", "closeSupported": true, "terminal": {"available":true} })).collect::<Vec<_>>());
        app.mouse = true;
        app.fit_panes();
        app
    }

    fn render(app: &mut App) -> Buffer {
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(app.size.0, app.size.1)).unwrap();
        terminal.draw(|f| crate::ui::draw(f, app)).unwrap();
        terminal.backend().buffer().clone()
    }

    fn click(app: &mut App, button: MouseButton, x: u16, y: u16) {
        for kind in [MouseEventKind::Down(button), MouseEventKind::Up(button)] {
            crate::input::handle(app, Event::Mouse(MouseEvent { kind, column: x, row: y, modifiers: KeyModifiers::NONE }));
        }
    }

    fn hit(app: &App, wanted: Action) -> Rect {
        app.controls.hits.borrow().iter().find(|(_, action)| *action == wanted).unwrap_or_else(|| panic!("missing {wanted:?}")).0
    }

    #[tokio::test]
    async fn ui_controls_end_pending_terminal_clicks_before_focus_moves() {
        for control in ["terminal", "header", "dialog", "sidebar"] {
            let mut app = app(140);
            app.tabs.truncate(1);
            app.tabs[0].root.as_mut().unwrap().split(1, 2, crate::layout::Dir::Horizontal);
            if control == "sidebar" {
                app.options.set("@hn-status-bar", Some("left"), &crate::options::SetFlags { global:true, ..Default::default() }, "", 0).unwrap();
            }
            app.fit_panes();
            let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
            app.sink = sink;
            crate::commands::execute(&mut app, "bind-key -n DoubleClick1Pane 'set -g @late-click fired'");
            render(&mut app);
            let body = app.rects.iter().find(|(id, _)| *id == 1).unwrap().1;
            click(&mut app, MouseButton::Left, body.x + 4, body.y + 4);
            click(&mut app, MouseButton::Left, body.x + 4, body.y + 4);
            match control {
                "header" => {
                    let agent = hit(&app, Action::Agent(1));
                    click(&mut app, MouseButton::Left, agent.x + 1, agent.y);
                }
                "dialog" => {
                    crate::account::open(&mut app); render(&mut app);
                    click(&mut app, MouseButton::Left, 0, 0);
                }
                "sidebar" => { click(&mut app, MouseButton::Left, 2, 10); }
                _ => {}
            }
            if control != "terminal" {
                crate::input::handle(&mut app, Event::Key(crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Esc, KeyModifiers::NONE)));
            }
            crate::commands::execute(&mut app, &format!("select-pane -t {}", crate::pane::tag(2)));
            for _ in 0..2 {
                if let crate::event::Event::Apply(apply) = tokio::time::timeout(
                    std::time::Duration::from_secs(1), events.recv()).await.unwrap().unwrap() { apply(&mut app); }
            }
            assert_eq!(app.options.get("@late-click", "", None).is_some(), control == "terminal",
                "UI controls end the click sequence; ordinary terminal double-clicks still run ({control})");
            assert_eq!(app.focused(), Some(2));
        }
    }

    #[tokio::test]
    async fn plain_pane_titles_keep_divider_drag_behavior() {
        for top in [false, true] {
            let mut outcomes = Vec::new();
            for controls in [false, true] {
                let mut app = app(100);
                app.tabs.truncate(1);
                app.tabs[0].root.as_mut().unwrap().split(1, 2, crate::layout::Dir::Vertical);
                app.status_top = top;
                app.options.set("@hn-border", Some("line"), &crate::options::SetFlags { global:true, ..Default::default() }, "", 0).unwrap();
                app.fit_panes(); render(&mut app);
                let title = hit(&app, Action::Header(2));
                let before = app.tab().root.as_ref().unwrap().to_tmux();
                if !controls { app.controls.hits.borrow_mut().clear(); }
                for (kind, row) in [(MouseEventKind::Down(MouseButton::Left), title.y),
                    (MouseEventKind::Drag(MouseButton::Left), title.y + 3), (MouseEventKind::Up(MouseButton::Left), title.y + 3)] {
                    crate::input::handle(&mut app, Event::Mouse(MouseEvent { kind, column:title.x + 3, row, modifiers:KeyModifiers::NONE }));
                }
                let after = app.tab().root.as_ref().unwrap().to_tmux();
                assert_ne!(after, before, "plain title must keep its resize drag (controls={controls}, top={top})");
                outcomes.push(after);
            }
            assert_eq!(outcomes[0], outcomes[1], "header controls preserve tmux's divider geometry");
        }
    }

    #[tokio::test]
    async fn header_controls_preserve_custom_pane_mouse_bindings() {
        for (button, key) in [(MouseButton::Left, "MouseDown1Pane"), (MouseButton::Right, "MouseDown3Pane")] {
            let mut app = app(100);
            crate::commands::execute(&mut app, &format!("bind-key -n {key} 'set -g @header-click custom'"));
            render(&mut app);
            let control = hit(&app, Action::Close(1));
            click(&mut app, button, control.x + 1, control.y);
            assert_eq!(app.options.get("@header-click", "", None).as_deref(), Some("custom"));
            assert!(app.session_close.sent.is_empty(), "custom binding owns the click");
            assert!(app.modal.is_none());
        }
    }

    #[tokio::test]
    async fn header_controls_are_outside_terminal_cells_in_each_pane_look() {
        let mut app = app(100);
        for (name, value) in [("@hn-border", "box"), ("@hn-border", "line"), ("@hn-focus", "surface")] {
            app.options.set(name, Some(value), &crate::options::SetFlags { global: true, ..Default::default() }, "", 0).unwrap();
            app.fit_panes();
            let buf = render(&mut app);
            let at = hit(&app, Action::Close(1));
            let body = app.rects.iter().find(|(id, _)| *id == 1).map(|(_, r)| app.content_of(app.tab(), *r)).unwrap();
            assert_eq!(at.intersection(body).area(), 0, "controls must not steal a terminal cell");
            assert!((at.x..at.right()).any(|x| buf[(x, at.y)].symbol() == "×"));
            click(&mut app, MouseButton::Left, at.x + 1, at.y);
            assert_eq!(app.session_close.sent.last().unwrap().1["agentId"], "a1");
            assert!(matches!(app.modal, Some(crate::modal::Modal::Menu(_))), "mouseup must not activate the new close dialog");
            app.modal = None;
        }
    }

    #[tokio::test]
    async fn status_controls_follow_the_renderer_and_open_without_a_prefix() {
        let mut app = app(120);
        render(&mut app);
        let range = app.status_ranges.iter().find(|(_, r)| r.kind == RangeKind::User("hn-account".into())).expect("Sign in has its own rendered range").clone();
        let y = app.size.1 - app.status_lines() + range.0;
        click(&mut app, MouseButton::Left, range.1.start, y);
        assert!(matches!(app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Account, .. })));
        app.modal = None;
        app.account.status = crate::account::Status::SignedIn { offline:false, email:None };
        app.tabs.truncate(1);
        let buf = render(&mut app);
        let range = app.status_ranges.iter().find(|(_, r)| r.kind == RangeKind::User("hn-new".into())).unwrap().clone();
        assert_eq!(buf[(range.1.start, y)].symbol(), "+", "the hit range must follow the visible glyph after sign-in");
        click(&mut app, MouseButton::Left, range.1.start, y);
        assert_eq!(app.tabs.len(), 2);
        assert!(app.tab().home, "+ follows the desktop New Tab action");
        app.say("A real status message", theme::MUTED);
        render(&mut app);
        assert!(status_action(&app, range.1.start, y).is_none(), "a replaced row must not leave invisible clickable actions");
    }

    #[tokio::test]
    async fn plain_agent_and_model_labels_open_the_captured_panes_picker() {
        let mut app = app(120);
        app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap().model = "runtime-v1:a1:codex:gpt-6-astra@max".into();
        let buf = render(&mut app);
        let model = hit(&app, Action::Model(1));
        let text: String = (model.x..model.right()).map(|x| buf[(x, model.y)].symbol()).collect();
        assert!(text.contains("GPT-6 Astra"), "{text}");
        click(&mut app, MouseButton::Left, model.x + 1, model.y);
        assert!(matches!(app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Models, .. })));
        assert_eq!(crate::models::target(&app).unwrap().agent, "a1");
        app.modal = None;
        render(&mut app);
        let agent = hit(&app, Action::Agent(1));
        click(&mut app, MouseButton::Left, agent.x + 1, agent.y);
        assert!(matches!(app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::AgentSwitch, .. })));
        app.modal = None;
        app.size.0 = 32; app.fit_panes(); render(&mut app);
        assert!(app.controls.hits.borrow().iter().all(|(_, a)| !matches!(a, Action::Agent(_) | Action::Model(_))));
        assert!(app.controls.hits.borrow().iter().any(|(_, a)| *a == Action::PaneMenu(1)), "narrow panes retain the menu");
    }

    #[tokio::test]
    async fn menu_actions_keep_the_original_pane_when_focus_changes() {
        let mut app = app(100);
        pane_menu(&mut app, 1, None);
        let token = app.controls.target.as_ref().unwrap().token.clone();
        app.active = 1;
        run(&mut app, &token, "close");
        assert_eq!(app.session_close.sent[0].1["agentId"], "a1");
        assert_eq!(app.active, 1, "stop must not change focus to an unrelated pane");
    }

    #[tokio::test]
    async fn replacing_a_session_invalidates_its_open_menu() {
        let mut app = app(100);
        pane_menu(&mut app, 1, None);
        let token = app.controls.target.as_ref().unwrap().token.clone();
        app.fleet.agents.get_mut(&("local".into(), "a1".into())).unwrap().session_id = "replacement".into();
        run(&mut app, &token, "close");
        assert!(app.session_close.sent.is_empty());
        assert!(app.panes.contains_key(&1));
    }

    #[tokio::test]
    async fn right_click_opens_the_panes_menu_and_does_not_claim_terminal_body_input() {
        let mut app = app(100);
        app.panes.get_mut(&1).unwrap().feed(b"\x1b[?1000h\x1b[?1006h");
        render(&mut app);
        let title = hit(&app, Action::Header(1));
        click(&mut app, MouseButton::Right, title.x + 2, title.y);
        assert!(matches!(app.modal, Some(crate::modal::Modal::Menu(_))));
        app.modal = None;
        let content = app.rects.iter().find(|(id, _)| *id == 1).map(|(_, r)| app.content_of(app.tab(), *r)).unwrap();
        let event = MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: content.x + 2, row: content.y + 2, modifiers: KeyModifiers::NONE };
        assert!(!mouse(&mut app, &event), "terminal-body events belong to the existing tmux input path");
        click(&mut app, MouseButton::Left, content.x + 2, content.y + 2);
        assert!(app.modal.is_none());
    }

    #[tokio::test]
    async fn overrides_mouse_off_and_small_panes_have_no_hidden_controls() {
        let mut app = app(100);
        render(&mut app);
        assert!(!app.controls.hits.borrow().is_empty());
        app.mouse = false;
        render(&mut app);
        assert!(app.controls.hits.borrow().is_empty());
        assert!(status(&app).is_empty());
        app.mouse = true;
        let global = crate::options::SetFlags { global: true, ..Default::default() };
        app.options.set("pane-border-format", Some(" my custom title "), &global, "", 0).unwrap();
        render(&mut app);
        assert!(app.controls.hits.borrow().is_empty());
        app.options.set("@hn-look", Some("tmux"), &global, "", 0).unwrap();
        render(&mut app);
        assert!(app.controls.hits.borrow().is_empty());
        assert!(status(&app).is_empty());
        app.options.set("@hn-look", None, &crate::options::SetFlags { global: true, unset: true, ..Default::default() }, "", 0).unwrap();
        for width in 1..20 {
            app.size.0 = width;
            app.fit_panes();
            render(&mut app);
            assert!(app.controls.hits.borrow().is_empty());
        }
    }
}
