//! OS first-use startup and the USB install action. Ordinary hn never enters this UI.
use crossterm::event::{KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{buffer::Buffer, layout::Rect, style::{Modifier, Style}};
use crate::{app::{App, At, Placement}, layout::Dir};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action { Install, Wifi, New, Connect, Terminal, Dismiss }

#[derive(Default)]
pub struct State {
    pub guide_pane: Option<u64>,
    pub dock_focus: Option<Action>,
    pub hits: Vec<(Rect, Action)>,
    starter_tab: Option<String>,
    welcome_panes: Vec<u64>,
    install_pane: Option<u64>,
    pub(crate) wifi_pane: Option<u64>,
    install_tab: Option<String>,
    wifi_tab: Option<String>,
    /// The Wi-Fi form was opened for this spell offline; closed, it is not forced on again until the
    /// computer has been online and lost its network once more.
    offline_offered: bool,
    /// When this spell offline began: a boot whose network is still coming up is not one.
    offline_since: Option<std::time::Instant>,
}

/// How long the network must stay gone before the Wi-Fi form comes forward by itself.
pub const OFFLINE_GRACE: std::time::Duration = std::time::Duration::from_secs(10);

pub fn live(app: &App) -> bool { app.os_session && app.os_live && !app.headless }

/// Only the locally created OS Wi-Fi form may cover required sign-in. Never
/// expose the other panes or route workspace shortcuts while it is visible.
pub fn entry_wifi(app: &App) -> Option<u64> {
    if !crate::account::entry_required(app) || !app.os_session { return None }
    let id = app.os_welcome.wifi_pane?;
    let pane = app.panes.get(&id)?;
    (app.os_welcome.wifi_tab.as_ref() == Some(&app.tab().id) && app.tab().panes().contains(&id)
        && this_computer(app, &pane.machine_id) && pane.dead.is_none()
        && !matches!(pane.phase, crate::pane::Phase::Card { .. })).then_some(id)
}

pub fn tick(app: &mut App) {
    if !app.os_session || app.tick % 8 != 0 { return }
    app.os_welcome.welcome_panes.retain(|id| app.panes.contains_key(id));
    if !app.os_live && !app.headless {
        offer_wifi(app, online(&read("/proc/net/route"), &read("/proc/net/ipv6_route")), std::time::Instant::now());
    }
}

fn read(path: &str) -> String { std::fs::read_to_string(path).unwrap_or_default() }

/// With the network gone, the Wi-Fi form comes forward by itself, once per spell offline, after the
/// grace a boot or a roaming hop needs. On required sign-in it covers the sign-in page and closes back
/// to it when it connects; signed in, it is a tab like Super+w's, and local work stays a tab away.
/// Never in the middle of a sign-in, and never before this computer's daemon can run the form.
pub fn offer_wifi(app: &mut App, online: bool, now: std::time::Instant) {
    if online {
        // The form this spell offline brought forward: the network is back, however it came back
        // (chosen there, by a phone through the setup hotspot, a router back on). It closes itself,
        // but one opened before a sign-in belongs to the daemon from before it, which no longer
        // tells its end: left, it would hold its tab and keep the first workspace from opening.
        if app.os_welcome.offline_offered && app.tabs.len() > 1 {
            if let Some(id) = app.os_welcome.wifi_pane.filter(|id| app.tabs.iter().any(|tab| tab.panes().contains(id))) {
                app.close_pane(id);
            }
        }
        app.os_welcome.offline_offered = false;
        app.os_welcome.offline_since = None;
        return
    }
    let since = *app.os_welcome.offline_since.get_or_insert(now);
    if app.os_welcome.offline_offered || now.duration_since(since) < OFFLINE_GRACE { return }
    if crate::account::entry_required(app) {
        if entry_wifi(app).is_some() || !crate::account::entry_idle(app) { return }
    } else if app.read_only() || wifi_open(app) {
        return
    }
    if app.link(&crate::input::shell_machine(app, None)).is_none() { return }
    app.os_welcome.offline_offered = true;
    local_dialog(app, "Wi-Fi", "/usr/bin/hn-os wifi", false);
}

/// The first workspace is still to come, and all that holds the first tab is the Wi-Fi form, brought
/// forward while the network was gone (a phone's setup hotspot): the form closes itself once the
/// network is back, and the welcome then fills the tab it leaves (`App::maybe_start_shell`).
pub fn welcome_waits_on_wifi(app: &App) -> bool {
    // The form opens in a tab of its own (local_dialog), beside the empty one the welcome fills.
    app.os_welcome.wifi_pane.is_some_and(|id| app.tabs.iter().any(|tab| tab.panes() == [id])
        && app.tabs.iter().all(|tab| tab.root.is_none() || tab.panes() == [id]))
}

/// The Wi-Fi form is already somewhere in the workspace: offering it again would only steal focus.
fn wifi_open(app: &App) -> bool {
    app.os_welcome.wifi_pane.is_some_and(|id| app.panes.get(&id).is_some_and(|pane| pane.dead.is_none()))
}

/// A route out of this computer: a default route, IPv4 or IPv6, on an interface that is up and not
/// loopback (`/proc/net/route`, `/proc/net/ipv6_route`), which NetworkManager sets once it connects.
pub fn online(v4: &str, v6: &str) -> bool {
    let up = |flags: &str| u32::from_str_radix(flags, 16).is_ok_and(|flags| flags & 1 != 0);
    v4.lines().skip(1).any(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        f.len() > 3 && f[0] != "lo" && f[1] == "00000000" && up(f[3])
    }) || v6.lines().any(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        f.len() >= 10 && f[9] != "lo" && f[0].bytes().all(|b| b == b'0') && f[0].len() == 32 && f[1] == "00" && up(f[8])
    })
}

fn split_starter(app: &mut App, pane: u64, dir: Dir, command: &str) {
    let Some(tab) = app.tabs.iter().find(|tab| tab.panes().contains(&pane)) else { return };
    let placement = Placement::At(At { tab: tab.id.clone(), pane: Some(pane), dir,
        before: false, full: false, size: Some((50, true)), detached: true, zoom: false });
    // Target the original pane explicitly. A delayed create reply must not split
    // a different tab or steal focus from work opened while networking finished.
    crate::input::new_shell_from(app, None, placement, None, Some(command.into()));
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
    let command = pane.start_command.clone();
    match command.as_deref() {
        Some("/usr/bin/hn-os welcome") => {
            if !app.os_welcome.welcome_panes.contains(&id) { app.os_welcome.welcome_panes.push(id); }
        }
        Some("/usr/bin/hn-os starter upper") if app.os_welcome.starter_tab.as_ref().is_some_and(|tab|
            app.tabs.iter().any(|t| &t.id == tab && t.panes().contains(&id))) => {
            app.os_welcome.starter_tab = None;
            split_starter(app, id, Dir::Vertical, "/usr/bin/hn-os starter lower");
        }
        Some("sudo /usr/bin/harness install") if live(app) => app.os_welcome.install_pane = Some(id),
        Some("/usr/bin/hn-os wifi") => {
            app.os_welcome.wifi_pane = Some(id);
            if entry_wifi(app).is_some() { app.modal = None; }
        }
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
    if crate::account::entry_required(app) {
        // Compositor shortcuts arrive over IPC, outside the account page's key
        // handling. Only the existing network form remains available here.
        if action == Action::Wifi { local_dialog(app, "Wi-Fi", "/usr/bin/hn-os wifi", false); }
        crate::account::enforce_entry(app);
        return;
    }
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
    if crate::account::entry_required(app) {
        if args.first().map(String::as_str) == Some("wifi") { act(app, Action::Wifi); }
        else { crate::account::enforce_entry(app); }
        return;
    }
    if args.first().map(String::as_str) == Some("ready") {
        let Some(hint) = args.get(1).filter(|id| id.strip_prefix('%').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))) else {
            return app.error("The welcome must identify its pane.");
        };
        // A tmux-backed shell sees the backend's %N, not hn's independent pane
        // number. Native fallback shells deliberately export hn's own number.
        let pane = app.os_welcome.welcome_panes.iter().copied().find(|id| app.panes.get(id).is_some_and(|p|
            this_computer(app, &p.machine_id) && if crate::local::is_local(&p.machine_id) { crate::pane::tag(*id) == *hint }
            else { app.fleet.agent(&p.machine_id, &p.agent_id).is_some_and(|a| a.tmux_pane == *hint) }));
        let Some(pane) = pane else { return app.error("That pane is not the welcome on this computer.") };
        if app.os_welcome.guide_pane == Some(pane) { return }
        app.os_welcome.guide_pane = Some(pane);
        // `bare`: a computer set up from a phone (os/setup.py, no one at its screen) opens OpenCode
        // alone, without the two starter terminals beside it.
        let bare = args.get(2).map(String::as_str) == Some("bare");
        if !bare && app.size.0 >= 80 && app.size.1 >= 18 {
            if let Some(tab) = app.tabs.iter().find(|tab| tab.panes() == [pane]) {
                app.os_welcome.starter_tab = Some(tab.id.clone());
                split_starter(app, pane, Dir::Horizontal, "/usr/bin/hn-os starter upper");
            }
        }
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

/// The install action uses the existing status line's named range. The normal
/// window list keeps its own space, selection and mouse handling on the left.
pub fn draw_dock(buf: &mut Buffer, app: &mut App) {
    app.os_welcome.hits.clear();
    if !live(app) || app.modal.is_some() || app.status_lines() == 0 { return }
    let y = if app.status_top { 0 } else { app.size.1.saturating_sub(app.status_lines()) };
    let ranges: Vec<_> = app.status_ranges.iter().filter(|(row, range)| *row == 0 &&
        matches!(&range.kind, crate::draw::RangeKind::User(name) if name == "os-install")).map(|(_, range)| (range.start, range.end)).collect();
    for (start, end) in ranges {
        let area = Rect::new(start, y, end.min(app.size.0).saturating_sub(start), 1);
        if area.width == 0 { continue }
        // Keep the status line's foreground/background contrast. The terminal
        // accent can be nearly invisible on a light status background.
        let style = Style::default().add_modifier(Modifier::BOLD);
        let style = if app.os_welcome.dock_focus.is_some() { style.add_modifier(Modifier::REVERSED) }
            else { style };
        buf.set_style(area, style);
        app.os_welcome.hits.push((area, Action::Install));
    }
}

pub fn mouse(app: &mut App, event: MouseEvent) -> bool {
    if !live(app) || app.modal.is_some() { return false }
    let hit = app.os_welcome.hits.iter().any(|(rect, _)| rect.contains((event.column, event.row).into()));
    if hit && matches!(event.kind, MouseEventKind::Down(MouseButton::Left)) { act(app, Action::Install); }
    hit
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
            KeyCode::Tab | KeyCode::BackTab | KeyCode::Left | KeyCode::Right => {}
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

    fn render(app: &mut App) -> Buffer {
        use ratatui::{Terminal, backend::TestBackend};
        app.options.global_session.insert("status-right".into(), "Make Harness your OS.  #[range=user|os-install bold][ Install Harness ]#[norange]".into());
        let mut terminal = Terminal::new(TestBackend::new(app.size.0, app.size.1)).unwrap();
        terminal.draw(|frame| crate::ui::draw(frame, app)).unwrap();
        terminal.backend().buffer().clone()
    }

    #[tokio::test]
    async fn footer_shares_one_row_with_windows_and_leaves_pane_space_intact() {
        for (width, height) in [(40, 8), (80, 24), (120, 40)] {
            let mut app = fixture(width, height);
            let buffer = render(&mut app);
            let text = contents(&buffer);
            assert!(text.contains("Install Harness"), "{text}");
            assert!(!text.contains("Temporary USB") && !text.contains("Wi-Fi: offline"));
            assert_eq!(app.body().height, height - 1);
            assert!(app.os_welcome.hits.iter().all(|(rect, _)| rect.right() <= width && rect.y == height - 1));
            assert!(!app.os_welcome.hits.is_empty(), "install range was lost: {text}");
        }
    }

    #[tokio::test]
    async fn keyboard_footer_does_not_steal_the_agents_tab_or_ordinary_hn_f10() {
        let mut app = fixture(100, 30);
        let press = |code| KeyEvent::new(code, KeyModifiers::NONE);
        assert!(!key(&mut app, press(KeyCode::Tab)));
        assert!(key(&mut app, press(KeyCode::F(10))));
        assert_eq!(app.os_welcome.dock_focus, Some(Action::Install));
        assert!(key(&mut app, press(KeyCode::Esc)));
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
    async fn required_sign_in_only_exposes_the_owned_local_wifi_form() {
        use crossterm::event::Event;
        let mut app = fixture(100, 30);
        app.os_live = false;
        app.fleet.local_id = "local-daemon".into();
        app.open_agent("local-daemon", "wifi", Placement::Auto(None));
        let wifi = app.focused().unwrap();
        app.os_welcome.wifi_tab = Some(app.tab().id.clone());
        let pane = app.panes.get_mut(&wifi).unwrap();
        pane.start_command = Some("/usr/bin/hn-os wifi".into());
        pane.phase = crate::pane::Phase::Live;
        pane.feed(b"Connect to Wi-Fi");
        app.open_agent("remote", "private-work", Placement::Auto(None));
        let private = app.focused().unwrap();
        let pane = app.panes.get_mut(&private).unwrap();
        pane.phase = crate::pane::Phase::Live;
        pane.feed(b"PRIVATE_WORKSPACE_CONTENT");
        assert!(contents(&render(&mut app)).contains("PRIVATE_WORKSPACE_CONTENT"));
        crate::account::begin_entry(&mut app);
        shell_created(&mut app, wifi);
        assert_eq!(entry_wifi(&app), Some(wifi));
        app.keymap.bind(crate::keys::Table::Root,
            crate::keys::of(&KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE)), "new-window".into(), false);
        for (width, height) in [(100, 30), (40, 12)] {
            app.size = (width, height);
            let text = contents(&render(&mut app));
            assert!(text.contains("Connect to Wi-Fi"), "{text}");
            assert!(!text.contains("PRIVATE_WORKSPACE_CONTENT") && !text.contains("Install Harness"), "{text}");
        }
        let tabs = app.tabs.len();
        crate::input::handle(&mut app, Event::Key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE)));
        crate::input::handle(&mut app, Event::Paste("fixture password".into()));
        assert_eq!(app.tabs.len(), tabs, "the form cannot invoke a workspace shortcut");
        assert_eq!(app.panes[&wifi].queued, [b"x".to_vec(), b"fixture password".to_vec()]);
        assert!(app.panes[&private].queued.is_empty());
        for action in [Action::New, Action::Terminal, Action::Connect] { act(&mut app, action); }
        assert_eq!(app.tabs.len(), tabs);
        app.panes.remove(&wifi);
        let text = contents(&render(&mut app));
        assert!(text.contains("Sign in to Harness"), "closing networking returns to required sign-in: {text}");
        assert!(!text.contains("PRIVATE_WORKSPACE_CONTENT"));
    }

    #[test]
    fn online_needs_a_default_route_that_is_up_and_not_loopback() {
        let head = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n";
        assert!(online(&format!("{head}wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n"), ""));
        assert!(!online(&format!("{head}wlan0\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0\n"), ""), "a local subnet alone is not online");
        assert!(!online(&format!("{head}wlan0\t00000000\t0101A8C0\t0002\t0\t0\t600\t00000000\t0\t0\t0\n"), ""), "a route that is down");
        assert!(!online("", ""));
        let zero = "0".repeat(32);
        assert!(online("", &format!("{zero} 00 {zero} 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003 wlan0\n")));
        assert!(!online("", &format!("{zero} 00 {zero} 00 {zero} ffffffff 00000001 00000000 00200200 lo\n")), "the kernel's unreachable default on lo");
    }

    /// An installed OS computer whose daemon can run the Wi-Fi form.
    fn installed() -> App {
        let mut app = fixture(100, 30);
        app.os_live = false;
        app.fleet.local_id = "local-daemon".into();
        app.connect("local-daemon");
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "local-daemon".into(), name: "This computer".into(),
            local: true, status: "running".into(), reach: crate::fleet::Reach::Ready });
        app
    }

    #[tokio::test]
    async fn offline_brings_the_wifi_form_forward_after_the_grace_once_per_spell() {
        use std::time::{Duration, Instant};
        for signed_in in [false, true] {
            let mut app = installed();
            if !signed_in { crate::account::begin_entry(&mut app); }
            assert_eq!(crate::account::entry_required(&app), !signed_in);
            let start = Instant::now();
            offer_wifi(&mut app, true, start);
            assert!(app.os_welcome.wifi_tab.is_none(), "online: nothing changes");
            offer_wifi(&mut app, false, start);
            offer_wifi(&mut app, false, start + OFFLINE_GRACE - Duration::from_secs(1));
            assert!(app.os_welcome.wifi_tab.is_none(), "a network still coming up is not offline");
            offer_wifi(&mut app, false, start + OFFLINE_GRACE);
            let opened = app.os_welcome.wifi_tab.clone();
            assert!(opened.is_some(), "offline (signed in: {signed_in}): the Wi-Fi form opens");
            assert_eq!(app.tab().id, *opened.as_ref().unwrap());
            // Closed with Esc and still offline: it does not come back on every tick.
            app.os_welcome.wifi_tab = None;
            offer_wifi(&mut app, false, start + OFFLINE_GRACE * 3);
            assert!(app.os_welcome.wifi_tab.is_none());
            // Online again, then offline again past the grace: it comes forward again.
            offer_wifi(&mut app, true, start + OFFLINE_GRACE * 4);
            offer_wifi(&mut app, false, start + OFFLINE_GRACE * 4);
            assert!(app.os_welcome.wifi_tab.is_none());
            offer_wifi(&mut app, false, start + OFFLINE_GRACE * 5);
            assert!(app.os_welcome.wifi_tab.is_some());
        }
    }

    #[tokio::test]
    async fn the_form_waits_for_the_daemon_and_never_interrupts_a_sign_in_or_a_read_only_client() {
        use std::time::Instant;
        let late = Instant::now() + OFFLINE_GRACE * 2;
        let mut app = fixture(100, 30);
        app.os_live = false;
        offer_wifi(&mut app, false, Instant::now());
        offer_wifi(&mut app, false, late);
        assert!(app.os_welcome.wifi_tab.is_none(), "not before this computer's daemon can run the form");
        let mut app = installed();
        app.client_flags.push("read-only".into());
        offer_wifi(&mut app, false, Instant::now());
        offer_wifi(&mut app, false, late);
        assert!(app.os_welcome.wifi_tab.is_none(), "a read-only client changes nothing");
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
    async fn install_click_does_not_steal_window_clicks_or_cross_a_modal() {
        let mut app = fixture(120, 30);
        render(&mut app);
        let click = |x| MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: x, row: 29, modifiers: KeyModifiers::NONE };
        assert!(!mouse(&mut app, click(0)), "window list still receives its clicks");
        let install = app.os_welcome.hits[0].0;
        app.modal = Some(crate::modal::Modal::Confirm { prompt: "existing form".into(), command: "".into(), key: 'y', enter_yes: false });
        assert!(!mouse(&mut app, click(install.x)));
        app.modal = None;
        app.os_live = false;
        assert!(!mouse(&mut app, click(install.x)));
        app.os_live = true;
        assert!(mouse(&mut app, click(install.x)));
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
    async fn the_wifi_form_brought_forward_offline_goes_when_the_network_is_back() {
        use std::time::Instant;
        for (offered, closes) in [(true, true), (false, false)] {
            let mut app = fixture(120, 40);
            app.new_tab();
            app.open_agent(crate::local::MACHINE, "wifi", Placement::Auto(None));
            let form = app.focused().unwrap();
            app.os_welcome.wifi_pane = Some(form);
            // Opened by hand while online (Super+w) is the person's: it stays.
            app.os_welcome.offline_offered = offered;
            offer_wifi(&mut app, true, Instant::now());
            assert_eq!(!app.panes.contains_key(&form), closes, "offered offline: {offered}");
            assert_eq!(app.tabs.len(), if closes { 1 } else { 2 });
        }
    }

    #[tokio::test]
    async fn the_first_workspace_waits_for_the_wifi_form_to_give_its_tab_back() {
        let mut app = fixture(120, 40);
        // The form, brought forward in a tab of its own beside the empty first one.
        app.new_tab();
        app.open_agent(crate::local::MACHINE, "wifi", Placement::Auto(None));
        let form = app.focused().unwrap();
        app.os_welcome.wifi_pane = Some(form);
        assert_eq!(app.tabs.len(), 2);
        assert!(welcome_waits_on_wifi(&app));
        // Back online: the form closes, its tab goes, and the first tab is the welcome's again.
        app.close_pane(form);
        assert_eq!(app.tabs.len(), 1);
        assert!(app.tabs[0].root.is_none());
        assert!(!welcome_waits_on_wifi(&app));
        // Other work beside the form: that is a workspace already, and no welcome comes.
        let mut busy = fixture(120, 40);
        busy.open_agent(crate::local::MACHINE, "work", Placement::Auto(None));
        busy.new_tab();
        busy.open_agent(crate::local::MACHINE, "wifi", Placement::Auto(None));
        busy.os_welcome.wifi_pane = busy.focused();
        assert!(!welcome_waits_on_wifi(&busy));
    }

    #[tokio::test]
    async fn a_computer_set_up_from_a_phone_opens_without_the_starter_terminals() {
        for (bare, starters) in [(false, true), (true, false)] {
            let mut app = fixture(120, 40);
            app.open_agent(crate::local::MACHINE, "welcome", Placement::Auto(None));
            let pane = app.focused().unwrap();
            app.panes.get_mut(&pane).unwrap().start_command = Some("/usr/bin/hn-os welcome".into());
            shell_created(&mut app, pane);
            let mut args = vec!["ready".to_string(), crate::pane::tag(pane)];
            if bare { args.push("bare".into()); }
            command(&mut app, &args);
            assert_eq!(app.os_welcome.guide_pane, Some(pane));
            assert_eq!(app.os_welcome.starter_tab.is_some(), starters, "bare: {bare}");
        }
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
