//! What the menu shows and which screen is due, from the app's state.

use crate::types::{AppState, ClaudeStatus, CliState, Daemon, MenuAction, MenuItem, Screen};

/// The menu's first, disabled row: the first of these that applies.
pub fn dial_line(state: &AppState) -> String {
    match (state.cli, state.daemon) {
        (CliState::Installing | CliState::InstallFailed, _) => return "Setting up Harness".into(),
        (CliState::Removed, _) => return "Harness removed".into(),
        (_, Daemon::Updating) => return "Updating Harness".into(),
        (_, Daemon::Stopped) => return "Harness stopped".into(),
        (_, Daemon::Starting) => return "Starting Harness".into(),
        (_, Daemon::Up) => {}
    }
    // Up comes only with a status line: none here is a watch the app has stopped.
    let Some(dial) = &state.dial else { return "Starting Harness".into() };
    if let Some(version) = &dial.updating {
        return format!("Updating to {version}");
    }
    if let Some(problem) = &dial.problem {
        return problem.clone();
    }
    match (dial.attached, &dial.fw) {
        (true, Some(fw)) => format!("Dial connected · {fw}"),
        (true, None) => "Dial connected".into(),
        (false, _) => "No dial".into(),
    }
}

/// The tray menu's rows, top to bottom. A row with nothing to say is absent.
pub fn menu(state: &AppState) -> Vec<MenuItem> {
    let mut items = vec![MenuItem::Text(dial_line(state))];
    // Decision 1: a failed install whose window was closed is offered again from the menu.
    if matches!(state.cli, CliState::Removed | CliState::InstallFailed) {
        items.push(MenuItem::Action(MenuAction::Install, "Install".into()));
    }
    match state.signed_in {
        Some(true) => items.push(MenuItem::Text("Signed in".into())),
        Some(false) => items.push(MenuItem::Action(MenuAction::SignIn, "Sign in…".into())),
        None => {}
    }
    match state.claude.as_ref().filter(|claude| available(claude)) {
        Some(claude) if claude.enabled => items.extend([
            MenuItem::Text("Claude Code: On".into()),
            MenuItem::Action(MenuAction::ClaudeOff, "Turn off".into()),
        ]),
        Some(_) => items.extend([
            MenuItem::Text("Claude Code: Off".into()),
            MenuItem::Action(MenuAction::ClaudeOn, "Turn on…".into()),
        ]),
        None => {}
    }
    items.push(MenuItem::Separator);
    if state.desktop_installed {
        items.push(MenuItem::Action(MenuAction::OpenHarness, "Open Harness".into()));
    }
    items.push(MenuItem::Action(MenuAction::Quit, "Quit".into()));
    items
}

/// The screen the window should show next, in the order they chain: install, sign-in, Claude Code.
pub fn due(state: &AppState) -> Option<Screen> {
    if matches!(state.cli, CliState::Installing | CliState::InstallFailed) {
        return Some(Screen::Install);
    }
    if state.signed_in == Some(false) && !state.saved.asked_sign_in {
        return Some(Screen::SignIn);
    }
    let claude_off = state.claude.as_ref().is_some_and(|claude| available(claude) && !claude.enabled);
    (claude_off && !state.saved.asked_claude).then_some(Screen::Claude)
}

/// The menu as one log line: its labels joined by ` | `, without separators.
pub fn menu_log(items: &[MenuItem]) -> String {
    let labels: Vec<&str> = items
        .iter()
        .filter_map(|item| match item {
            MenuItem::Text(label) | MenuItem::Action(_, label) => Some(label.as_str()),
            MenuItem::Separator => None,
        })
        .collect();
    labels.join(" | ")
}

/// Claude Code can be turned on or off here.
fn available(claude: &ClaudeStatus) -> bool {
    claude.supported && claude.installed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AppState, ClaudeStatus, CliState, Daemon, DialStatus, MenuAction, MenuItem, Saved, Screen};
    use MenuItem::{Action, Separator, Text};

    fn dial(attached: bool, fw: Option<&str>) -> DialStatus {
        DialStatus { attached, fw: fw.map(Into::into), hw: None, board: None, updating: None, problem: None }
    }

    fn state() -> AppState {
        AppState {
            cli: CliState::Found,
            daemon: Daemon::Up,
            dial: Some(dial(true, Some("0.0.95"))),
            signed_in: Some(true),
            claude: Some(ClaudeStatus { supported: true, installed: true, enabled: true, claude_version: None }),
            desktop_installed: true,
            saved: Saved { version: 1, cli_seen: true, asked_sign_in: true, asked_claude: true, login_item: true },
        }
    }

    fn text(label: &str) -> MenuItem {
        Text(label.into())
    }

    fn act(action: MenuAction, label: &str) -> MenuItem {
        Action(action, label.into())
    }

    #[test]
    fn the_whole_menu() {
        assert_eq!(
            menu(&state()),
            vec![
                text("Dial connected · 0.0.95"),
                text("Signed in"),
                text("Claude Code: On"),
                act(MenuAction::ClaudeOff, "Turn off"),
                Separator,
                act(MenuAction::OpenHarness, "Open Harness"),
                act(MenuAction::Quit, "Quit"),
            ]
        );
    }

    #[test]
    fn every_dial_line() {
        let with = |change: &dyn Fn(&mut AppState)| {
            let mut state = state();
            change(&mut state);
            dial_line(&state)
        };
        assert_eq!(with(&|s| s.cli = CliState::Installing), "Setting up Harness");
        assert_eq!(with(&|s| s.cli = CliState::InstallFailed), "Setting up Harness");
        assert_eq!(with(&|s| s.cli = CliState::Removed), "Harness removed");
        assert_eq!(with(&|s| s.daemon = Daemon::Updating), "Updating Harness");
        assert_eq!(with(&|s| s.daemon = Daemon::Stopped), "Harness stopped");
        assert_eq!(with(&|s| s.daemon = Daemon::Starting), "Starting Harness");
        assert_eq!(with(&|s| s.dial = None), "Starting Harness");
        assert_eq!(
            with(&|s| {
                s.dial = Some(DialStatus {
                    updating: Some("0.0.96".into()),
                    problem: Some("Not answering — unplug and replug".into()),
                    ..dial(true, Some("0.0.95"))
                })
            }),
            "Updating to 0.0.96"
        );
        assert_eq!(
            with(&|s| {
                s.dial = Some(DialStatus {
                    problem: Some("Not answering — unplug and replug".into()),
                    ..dial(true, Some("0.0.95"))
                })
            }),
            "Not answering — unplug and replug"
        );
        assert_eq!(with(&|s| s.dial = Some(dial(true, None))), "Dial connected");
        assert_eq!(with(&|s| s.dial = Some(dial(false, None))), "No dial");
    }

    #[test]
    fn install_is_offered_when_harness_was_removed() {
        let with_cli = |cli: CliState| menu(&AppState { cli, ..state() });
        assert_eq!(with_cli(CliState::Removed)[..2], [text("Harness removed"), act(MenuAction::Install, "Install")]);
        for cli in [CliState::Found, CliState::Installing] {
            assert!(!with_cli(cli).contains(&act(MenuAction::Install, "Install")), "{cli:?}");
        }
        // Decision 1: a failed install whose window was closed keeps its line and offers Install again.
        assert_eq!(
            with_cli(CliState::InstallFailed)[..2],
            [text("Setting up Harness"), act(MenuAction::Install, "Install")]
        );
    }

    #[test]
    fn the_account_row() {
        assert_eq!(menu(&AppState { signed_in: Some(false), ..state() })[1], act(MenuAction::SignIn, "Sign in…"));
        let unknown = menu(&AppState { signed_in: None, ..state() });
        assert!(!unknown.contains(&text("Signed in")));
        assert!(!unknown.contains(&act(MenuAction::SignIn, "Sign in…")));
        assert_eq!(unknown[1], text("Claude Code: On"));
    }

    #[test]
    fn the_claude_rows() {
        let off = ClaudeStatus { supported: true, installed: true, enabled: false, claude_version: None };
        assert_eq!(
            menu(&AppState { claude: Some(off), ..state() })[2..4],
            [text("Claude Code: Off"), act(MenuAction::ClaudeOn, "Turn on…")]
        );
        let without = [
            Some(ClaudeStatus { supported: false, installed: true, enabled: true, claude_version: None }),
            Some(ClaudeStatus { supported: true, installed: false, enabled: true, claude_version: None }),
            None,
        ];
        for claude in without {
            let items = menu(&AppState { claude: claude.clone(), ..state() });
            assert_eq!(items[..3], [text("Dial connected · 0.0.95"), text("Signed in"), Separator], "{claude:?}");
        }
    }

    #[test]
    fn open_harness_needs_the_desktop_app() {
        let items = menu(&AppState { desktop_installed: false, ..state() });
        assert_eq!(items[items.len() - 2..], [Separator, act(MenuAction::Quit, "Quit")]);
        assert!(!items.contains(&act(MenuAction::OpenHarness, "Open Harness")));
    }

    #[test]
    fn without_a_cli_the_menu_says_only_what_it_knows() {
        let removed =
            AppState { cli: CliState::Removed, signed_in: None, claude: None, desktop_installed: false, ..state() };
        assert_eq!(
            menu(&removed),
            vec![
                text("Harness removed"),
                act(MenuAction::Install, "Install"),
                Separator,
                act(MenuAction::Quit, "Quit")
            ]
        );
    }

    #[test]
    fn screens_are_due_in_order() {
        let not_asked = Saved { asked_sign_in: false, asked_claude: false, ..state().saved };
        let claude_off = Some(ClaudeStatus { supported: true, installed: true, enabled: false, claude_version: None });
        let fresh = AppState { signed_in: Some(false), claude: claude_off, saved: not_asked, ..state() };

        for cli in [CliState::Installing, CliState::InstallFailed] {
            assert_eq!(due(&AppState { cli, ..fresh.clone() }), Some(Screen::Install), "{cli:?}");
        }
        assert_eq!(due(&fresh), Some(Screen::SignIn));
        let asked_sign_in = Saved { asked_sign_in: true, ..not_asked };
        assert_eq!(due(&AppState { saved: asked_sign_in, ..fresh.clone() }), Some(Screen::Claude));
        assert_eq!(due(&AppState { signed_in: Some(true), ..fresh.clone() }), Some(Screen::Claude));
        assert_eq!(due(&AppState { signed_in: None, ..fresh.clone() }), Some(Screen::Claude));

        // Claude Code is due only when it can be turned on here and is off.
        let not_due = [
            ClaudeStatus { supported: false, installed: true, enabled: false, claude_version: None },
            ClaudeStatus { supported: true, installed: false, enabled: false, claude_version: None },
            ClaudeStatus { supported: true, installed: true, enabled: true, claude_version: None },
        ];
        for claude in not_due {
            let signed_in = AppState { signed_in: Some(true), claude: Some(claude.clone()), ..fresh.clone() };
            assert_eq!(due(&signed_in), None, "{claude:?}");
        }
        assert_eq!(due(&AppState { signed_in: Some(true), claude: None, ..fresh.clone() }), None);

        assert_eq!(due(&AppState { saved: state().saved, ..fresh }), None);
        assert_eq!(due(&state()), None);
    }

    #[test]
    fn the_menu_as_a_log_line() {
        assert_eq!(
            menu_log(&menu(&state())),
            "Dial connected · 0.0.95 | Signed in | Claude Code: On | Turn off | Open Harness | Quit"
        );
    }
}
