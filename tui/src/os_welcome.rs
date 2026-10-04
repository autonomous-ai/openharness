//! USB onboarding belongs to the OS launcher. Ordinary hn never enters this module's UI.
use crossterm::event::{KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{buffer::Buffer, layout::Rect, text::Line};
use crate::{app::{App, Placement, Tab}, theme::{self, bold, fg}};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action { Install, Wifi, New, Connect, Terminal, Dismiss }

#[derive(Default)]
pub struct State {
    pub guide_pane: Option<u64>,
    pub dock_focus: Option<Action>,
    pub hits: Vec<(Rect, Action)>,
    pub network: Option<bool>,
    welcome_panes: Vec<u64>,
    install_pane: Option<u64>,
    wifi_pane: Option<u64>,
    install_tab: Option<String>,
    wifi_tab: Option<String>,
}

pub fn live(app: &App) -> bool { app.os_session && app.os_live && !app.headless }

pub fn dock_height(app: &App) -> u16 { u16::from(live(app) && app.size.1 > 2) }

pub fn tick(app: &mut App) {
    if !live(app) || app.tick % 8 != 0 { return }
    app.os_welcome.welcome_panes.retain(|id| app.panes.contains_key(id));
    app.os_welcome.network = std::fs::read_to_string("/run/harness-network").ok().and_then(|text| match text.trim() {
        "connected" => Some(true), "offline" => Some(false), _ => None,
    });
}

pub fn intro(app: &App, tab: &Tab) -> bool {
    live(app) && app.size.0 >= 80 && app.size.1 >= 18 && !tab.zoomed
        && app.os_welcome.guide_pane.is_some_and(|id| tab.panes() == [id])
}

pub fn workspace(app: &App, tab: &Tab, mut area: Rect) -> Rect {
    if intro(app, tab) { area.width /= 2; }
    area
}

fn this_computer(app: &App, machine: &str) -> bool {
    machine == app.fleet.local_id || crate::local::is_local(machine)
}

/// Record the originating request once. Terminal discovery can later replace
/// start_command with the underlying login shell's command, so it is not an ID.
pub fn shell_created(app: &mut App, id: u64) {
    if !app.os_session { return }
    let Some(pane) = app.panes.get(&id) else { return };
    if !this_computer(app, &pane.machine_id) { return }
    match pane.start_command.as_deref() {
        Some("/usr/bin/hn-os welcome") if live(app) => {
            if !app.os_welcome.welcome_panes.contains(&id) { app.os_welcome.welcome_panes.push(id); }
        }
        Some("sudo /usr/bin/harness install") if live(app) => app.os_welcome.install_pane = Some(id),
        Some("/usr/bin/hn-os wifi") => app.os_welcome.wifi_pane = Some(id),
        _ => {}
    }
}

/// Always create system forms on this computer, even while a remote pane has focus.
fn local_dialog(app: &mut App, name: &str, command: &str, install: bool) {
    let held = if install { &app.os_welcome.install_tab } else { &app.os_welcome.wifi_tab };
    let pane = if install { app.os_welcome.install_pane } else { app.os_welcome.wifi_pane };
    let existing = app.tabs.iter().position(|tab| (held.as_ref() == Some(&tab.id) && app.shell_inputs.contains_key(&tab.id))
        || pane.is_some_and(|id| tab.panes().contains(&id) && app.panes.get(&id).is_some_and(|p| this_computer(app, &p.machine_id))));
    if let Some(index) = existing {
        app.modal = None;
        if let Some(id) = pane.filter(|id| app.tabs[index].panes().contains(id)) { app.focus_pane(index, id); }
        else { app.select_tab(index); }
        return;
    }
    if app.link(&crate::input::shell_machine(app, None)).is_none() { return app.error("This computer is still starting. Try again in a moment.") }
    app.new_tab();
    app.rename_tab(name);
    let tab = app.tab().id.clone();
    if install { app.os_welcome.install_tab = Some(tab.clone()); } else { app.os_welcome.wifi_tab = Some(tab.clone()); }
    crate::input::new_shell_from(app, None, Placement::Fill(tab), None, Some(command.into()));
}

pub fn act(app: &mut App, action: Action) {
    if !app.os_session || app.headless { return app.error("This action belongs to the Harness operating system.") }
    if app.read_only() { return app.error("This client is read-only.") }
    app.os_welcome.dock_focus = None;
    match action {
        Action::Install if live(app) => local_dialog(app, "Install", "sudo /usr/bin/harness install", true),
        Action::Install => app.error("Installation is available from the Harness USB."),
        Action::Wifi => local_dialog(app, "Wi-Fi", "/usr/bin/hn-os wifi", false),
        Action::New => crate::new_harness::open(app, None, None),
        Action::Connect => crate::devices::open(app, crate::devices::View::Connect),
        Action::Terminal => crate::input::run(app, "terminal"),
        Action::Dismiss => { app.os_welcome.guide_pane = None; app.fit_panes(); }
    }
}

/// Private OS integration: absent from ordinary hn's command and welcome menus.
pub fn command(app: &mut App, args: &[String]) {
    if !app.os_session || app.headless { return app.error("This action belongs to the Harness operating system.") }
    if app.read_only() { return app.error("This client is read-only.") }
    if args.first().map(String::as_str) == Some("ready") {
        if !live(app) { return app.error("The USB welcome is not active.") }
        let Some(hint) = args.get(1).filter(|id| id.strip_prefix('%').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))) else {
            return app.error("The USB welcome must identify its pane.");
        };
        // A tmux-backed shell sees the backend's %N, not hn's independent pane
        // number. Native fallback shells deliberately export hn's own number.
        let pane = app.os_welcome.welcome_panes.iter().copied().find(|id| app.panes.get(id).is_some_and(|p|
            this_computer(app, &p.machine_id) && if crate::local::is_local(&p.machine_id) { crate::pane::tag(*id) == *hint }
            else { app.fleet.agent(&p.machine_id, &p.agent_id).is_some_and(|a| a.tmux_pane == *hint) }));
        let Some(pane) = pane else { return app.error("That pane is not the USB welcome on this computer.") };
        app.os_welcome.guide_pane = Some(pane);
        app.fit_panes();
        return;
    }
    let action = match args.first().map(String::as_str) {
        Some("install") => Action::Install, Some("wifi") => Action::Wifi,
        Some("new") => Action::New, Some("connect") => Action::Connect,
        Some("terminal") => Action::Terminal, Some("dismiss") => Action::Dismiss,
        _ => return app.error("Unknown OS action."),
    };
    act(app, action);
}

fn button(buf: &mut Buffer, app: &mut App, area: Rect, text: &str, action: Action, primary: bool) {
    if area.width == 0 || area.height == 0 { return }
    let style = if primary || app.os_welcome.dock_focus == Some(action) { bold(theme::accent()) }
        else if action == Action::Wifi && app.os_welcome.network == Some(false) { fg(theme::WARN) }
        else { fg(theme::MUTED) };
    let style = if app.os_welcome.dock_focus == Some(action) { style.add_modifier(ratatui::style::Modifier::REVERSED) } else { style };
    buf.set_line(area.x, area.y, &Line::styled(text, style), area.width);
    app.os_welcome.hits.push((area, action));
}

pub fn draw_intro(buf: &mut Buffer, app: &mut App) {
    app.os_welcome.hits.clear();
    if !intro(app, app.tab()) || app.modal.is_some() { return }
    let body = app.body();
    let left = body.x + body.width / 2 + 1;
    let width = body.right().saturating_sub(left + 2);
    let half = body.height / 2;
    for y in body.y..body.bottom() { buf.set_string(left - 1, y, "│", fg(theme::MUTED)); }
    for x in left..body.right() { buf.set_string(x, body.y + half, "─", fg(theme::MUTED)); }
    button(buf, app, Rect::new(body.right() - 5, body.y, 5, 1), "[ x ]", Action::Dismiss, false);
    for (row, title, lines, action, label) in [
        (body.y, "More agents. More possibilities.", ["Give each agent its own work.", "Choose an agent and a project.", "Super+n"], Action::New, "[ New Harness ]"),
        (body.y + half, "Your computers, together.", ["Run agents on another computer.", "Keep their work here beside you.", "Super+m"], Action::Connect, "[ Connect a computer ]"),
    ] {
        let mut y = row + 1;
        for (text, style) in std::iter::once((title, bold(theme::TEXT)))
            .chain(std::iter::once(("", fg(theme::TEXT))))
            .chain(lines.into_iter().map(|line| (line, fg(theme::MUTED)))) {
            if y >= row + half || y >= body.bottom() { break }
            buf.set_line(left + 1, y, &Line::styled(text, style), width);
            y += 1;
        }
        if y < body.bottom() { button(buf, app, Rect::new(left + 1, y, width.min(label.len() as u16), 1), label, action, true); }
    }
}

pub fn draw_dock(buf: &mut Buffer, app: &mut App) {
    if dock_height(app) == 0 { return }
    let (width, y) = (app.size.0, app.size.1 - 1);
    let area = Rect::new(0, y, width, 1);
    buf.set_style(area, fg(theme::TEXT));
    for x in 0..width { if let Some(cell) = buf.cell_mut((x, y)) { cell.set_symbol(" "); } }
    let invitation = if width >= 76 { "Make Harness your OS.  " } else { "" };
    if !invitation.is_empty() { buf.set_line(1, y, &Line::raw(invitation), width.saturating_sub(1)); }
    let x = 1 + invitation.len() as u16;
    let install = "[ Install Harness ]";
    button(buf, app, Rect::new(x, y, width.saturating_sub(x).min(install.len() as u16), 1), install, Action::Install, true);
    let secondary = if width >= 56 { "Temporary USB  " } else { "USB  " };
    let wifi = if app.os_welcome.network == Some(false) { "[ Wi-Fi: offline ]" } else { "[ Wi-Fi ]" };
    let wifi_width = wifi.len() as u16;
    let tail = secondary.len() as u16 + wifi_width + 1;
    if width >= x + install.len() as u16 + tail + 2 {
        let start = width - tail;
        buf.set_line(start, y, &Line::styled(secondary, fg(theme::MUTED)), secondary.len() as u16);
        button(buf, app, Rect::new(width - wifi_width - 1, y, wifi_width, 1), wifi, Action::Wifi, false);
    }
}

pub fn mouse(app: &mut App, event: MouseEvent) -> bool {
    if !live(app) || app.modal.is_some() { return false }
    let in_dock = dock_height(app) > 0 && event.row == app.size.1 - 1;
    if !matches!(event.kind, MouseEventKind::Down(MouseButton::Left)) { return in_dock }
    let action = app.os_welcome.hits.iter().find(|(rect, _)| rect.contains((event.column, event.row).into())).map(|(_, action)| *action);
    if let Some(action) = action { act(app, action); return true }
    in_dock
}

pub fn key(app: &mut App, key: KeyEvent) -> bool {
    if !live(app) || app.modal.is_some() { return false }
    if key.code == KeyCode::F(10) && key.modifiers.is_empty() {
        app.os_welcome.dock_focus = Some(Action::Install);
        return true;
    }
    if let Some(action) = app.os_welcome.dock_focus {
        match key.code {
            KeyCode::Esc => app.os_welcome.dock_focus = None,
            KeyCode::Tab | KeyCode::BackTab | KeyCode::Left | KeyCode::Right => app.os_welcome.dock_focus = Some(if action == Action::Install { Action::Wifi } else { Action::Install }),
            KeyCode::Enter | KeyCode::Char(' ') => act(app, action),
            _ => { app.os_welcome.dock_focus = None; return false }
        }
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn fixture(width: u16, height: u16) -> App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19789, sink, (width, height));
        app.handed_over = true;
        app.os_session = true;
        app.os_live = true;
        app
    }

    fn contents(buf: &Buffer) -> String {
        (0..buf.area.height).map(|y| (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    #[tokio::test]
    async fn dock_is_usb_only_and_keeps_its_controls_inside_small_screens() {
        for (width, height) in [(20, 8), (60, 18), (80, 24), (120, 40)] {
            let mut app = fixture(width, height);
            for (os, usb) in [(false, false), (false, true), (true, false), (true, true)] {
                app.os_session = os;
                app.os_live = usb;
                let mut buffer = Buffer::empty(Rect::new(0, 0, width, height));
                draw_intro(&mut buffer, &mut app);
                draw_dock(&mut buffer, &mut app);
                let text = contents(&buffer);
                assert_eq!(text.contains("Install Harness"), os && usb, "{text}");
                if os && usb && width >= 80 {
                    assert!(text.contains("Make Harness your OS."), "{text}");
                    assert!(text.contains("Temporary USB"), "{text}");
                    assert!(text.contains("[ Wi-Fi ]"), "{text}");
                }
                assert!(app.os_welcome.hits.iter().all(|(rect, _)| rect.right() <= width && rect.bottom() <= height));
            }
        }
    }

    #[tokio::test]
    async fn introduction_uses_half_the_screen_only_for_its_one_agent() {
        let mut app = fixture(120, 40);
        app.tab_mut().root = Some(crate::layout::Node::new(1, 120, 38));
        app.os_welcome.guide_pane = Some(1);
        assert_eq!(app.window_area(app.tab()).width, 60);
        assert_eq!(app.body().height, 38, "status and install dock each reserve one row");
        let mut buffer = Buffer::empty(Rect::new(0, 0, 120, 40));
        draw_intro(&mut buffer, &mut app);
        let text = contents(&buffer);
        assert!(text.contains("[ New Harness ]") && text.contains("[ Connect a computer ]"), "{text}");
        app.tab_mut().zoomed = true;
        assert_eq!(app.window_area(app.tab()).width, 120);
        app.tab_mut().zoomed = false;
        app.os_welcome.guide_pane = Some(2);
        assert_eq!(app.window_area(app.tab()).width, 120, "unrelated panes keep their full space");
        app.os_live = false;
        assert_eq!(app.body().height, 39, "installed Harness has no USB dock");
    }

    #[tokio::test]
    async fn keyboard_dock_does_not_steal_the_agents_tab_or_ordinary_hn_f10() {
        let mut app = fixture(100, 30);
        let press = |code| KeyEvent::new(code, KeyModifiers::NONE);
        assert!(!key(&mut app, press(KeyCode::Tab)));
        assert!(key(&mut app, press(KeyCode::F(10))));
        assert_eq!(app.os_welcome.dock_focus, Some(Action::Install));
        assert!(key(&mut app, press(KeyCode::Tab)));
        assert_eq!(app.os_welcome.dock_focus, Some(Action::Wifi));
        assert!(key(&mut app, press(KeyCode::Esc)));
        assert!(app.os_welcome.dock_focus.is_none());
        app.os_session = false;
        assert!(!key(&mut app, press(KeyCode::F(10))));
    }

    #[tokio::test]
    async fn private_actions_cannot_install_on_ordinary_or_installed_hn() {
        for (os, live) in [(false, false), (false, true), (true, false)] {
            let mut app = fixture(100, 30);
            app.os_session = os;
            app.os_live = live;
            let tabs = app.tabs.len();
            command(&mut app, &["install".into()]);
            assert!(app.starting_shell.is_none());
            assert_eq!(app.tabs.len(), tabs);
        }
    }

    #[tokio::test]
    async fn install_reuses_its_local_form_even_when_a_remote_pane_is_focused() {
        let mut app = fixture(120, 40);
        app.fleet.local_id = "local-daemon".into();
        app.open_agent("local-daemon", "installer", Placement::Auto(None));
        let installer = app.focused().unwrap();
        app.panes.get_mut(&installer).unwrap().start_command = Some("sudo /usr/bin/harness install".into());
        shell_created(&mut app, installer);
        // Discovery reports the original login shell after it has exec'd the
        // form. Its new title/command must not cause a second installer.
        app.panes.get_mut(&installer).unwrap().start_command = Some("/bin/bash -l".into());
        let install_tab = app.tab().id.clone();
        app.open_agent("remote", "same-tab-work", Placement::Auto(None));
        app.new_tab();
        app.open_agent("remote", "work", Placement::Auto(None));
        act(&mut app, Action::Install);
        assert_eq!(app.tab().id, install_tab);
        assert_eq!(app.focused(), Some(installer));
        assert_eq!(app.tabs.len(), 2, "repeated requests must not create another installer");
        assert!(app.starting_shell.is_none());
    }

    #[tokio::test]
    async fn mouse_dock_does_not_click_through_modals_or_fall_into_the_status_bar() {
        let mut app = fixture(100, 30);
        let mut buffer = Buffer::empty(Rect::new(0, 0, 100, 30));
        draw_dock(&mut buffer, &mut app);
        let click = |x| MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: x, row: 29, modifiers: KeyModifiers::NONE };
        assert!(mouse(&mut app, click(0)), "empty dock cells belong to the dock");
        app.modal = Some(crate::modal::Modal::Confirm { prompt: "existing form".into(), command: "".into(), key: 'y', enter_yes: false });
        let install = app.os_welcome.hits.iter().find(|(_, a)| *a == Action::Install).unwrap().0;
        assert!(!mouse(&mut app, click(install.x)));
        assert!(matches!(app.modal, Some(crate::modal::Modal::Confirm { .. })));
        app.modal = None;
        app.os_welcome.network = Some(false);
        draw_intro(&mut buffer, &mut app);
        draw_dock(&mut buffer, &mut app);
        assert!(contents(&buffer).contains("Wi-Fi: offline"));
    }

    #[tokio::test]
    async fn usb_ready_cannot_resize_an_unrelated_or_remote_pane() {
        let mut app = fixture(120, 40);
        app.open_agent("remote", "agent", Placement::Auto(None));
        let pane = app.focused().unwrap();
        command(&mut app, &["ready".into(), format!("%{}", pane - 1)]);
        assert!(app.os_welcome.guide_pane.is_none());
        let local = crate::local::MACHINE.to_string();
        let p = app.panes.get_mut(&pane).unwrap();
        p.machine_id = local;
        p.start_command = Some("/usr/bin/hn-os welcome".into());
        shell_created(&mut app, pane);
        command(&mut app, &["ready".into(), format!("%{}", pane - 1)]);
        assert_eq!(app.os_welcome.guide_pane, Some(pane));
        assert!(crate::commands::is_command_name("os-action"));
    }

    #[tokio::test]
    async fn readiness_maps_the_backend_pane_instead_of_assuming_the_same_number() {
        let mut app = fixture(120, 40);
        app.fleet.local_id = "local-daemon".into();
        let row = serde_json::json!({"id": "welcome", "engine": "terminal", "tmuxPane": "%997"});
        app.fleet.agents.insert(("local-daemon".into(), "welcome".into()), crate::fleet::agent_from("local-daemon", &row, None));
        app.open_agent("local-daemon", "welcome", Placement::Auto(None));
        let pane = app.focused().unwrap();
        app.panes.get_mut(&pane).unwrap().start_command = Some("/usr/bin/hn-os welcome".into());
        shell_created(&mut app, pane);
        app.panes.get_mut(&pane).unwrap().start_command = Some("/bin/bash -l".into());
        assert_ne!(crate::pane::tag(pane), "%997");
        app.new_tab();
        app.open_agent("remote", "other-work", Placement::Auto(None));
        let current = app.focused();
        command(&mut app, &["ready".into(), "%997".into()]);
        assert_eq!(app.os_welcome.guide_pane, Some(pane));
        assert_eq!(app.focused(), current, "readiness must not change the current work");
    }
}
