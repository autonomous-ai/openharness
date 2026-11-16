//! What the menu shows and which screen is due, from the app's state.

use crate::types::{AppState, AppUpdate, ClaudeStatus, CliState, Daemon, MenuAction, MenuItem, Screen};

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
    // The check is what the dial reports; the item carries the action its click does.
    match sound_muted(state) {
        Some(false) => items.push(MenuItem::Check(MenuAction::SoundOff, "Sound".into(), true)),
        Some(true) => items.push(MenuItem::Check(MenuAction::SoundOn, "Sound".into(), false)),
        None => {}
    }
    match &state.app_update {
        AppUpdate::Installing(version) => items.push(MenuItem::Text(format!("Updating to {version}…"))),
        // The app cannot replace its bundle: the click opens the download page.
        AppUpdate::Blocked(version) => items.push(MenuItem::Action(MenuAction::Update, format!("Update {version}…"))),
        AppUpdate::None => {}
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
    let labels: Vec<String> = items
        .iter()
        .filter_map(|item| match item {
            MenuItem::Text(label) | MenuItem::Action(_, label) | MenuItem::Check(_, label, false) => {
                Some(label.clone())
            }
            MenuItem::Check(_, label, true) => Some(format!("{label} ✓")),
            MenuItem::Separator => None,
        })
        .collect();
    labels.join(" | ")
}

/// The dial's sound, when there is one to change: an attached dial, not updating, on a running Harness.
fn sound_muted(state: &AppState) -> Option<bool> {
    if state.cli != CliState::Found || state.daemon != Daemon::Up {
        return None;
    }
    state.dial.as_ref().filter(|dial| dial.attached && dial.updating.is_none()).and_then(|dial| dial.muted)
}

/// Claude Code can be turned on or off here.
fn available(claude: &ClaudeStatus) -> bool {
    claude.supported && claude.installed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        AppState, AppUpdate, ClaudeStatus, CliState, Daemon, DialStatus, MenuAction, MenuItem, Saved, Screen,
    };
    use MenuItem::{Action, Check, Separator, Text};

    fn dial(attached: bool, fw: Option<&str>) -> DialStatus {
        DialStatus {
            attached,
            fw: fw.map(Into::into),
            hw: None,
            board: None,
            updating: None,
            problem: None,
            muted: None,
        }
    }

    fn sound(muted: Option<bool>) -> DialStatus {
        DialStatus { muted, ..dial(true, Some("0.0.95")) }
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
            app_update: AppUpdate::None,
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
    fn the_sound_row() {
        let on = Check(MenuAction::SoundOff, "Sound".into(), true);
        let off = Check(MenuAction::SoundOn, "Sound".into(), false);
        assert_eq!(
            menu(&AppState { dial: Some(sound(Some(false))), ..state() }),
            vec![
                text("Dial connected · 0.0.95"),
                text("Signed in"),
                text("Claude Code: On"),
                act(MenuAction::ClaudeOff, "Turn off"),
                on.clone(),
                Separator,
                act(MenuAction::OpenHarness, "Open Harness"),
                act(MenuAction::Quit, "Quit"),
            ]
        );
        assert_eq!(menu(&AppState { dial: Some(sound(Some(true))), ..state() })[4], off);
        let alone = AppState { dial: Some(sound(Some(false))), signed_in: None, claude: None, ..state() };
        assert_eq!(menu(&alone)[1], on);
    }

    #[test]
    fn the_sound_row_is_absent_when_there_is_nothing_to_change() {
        let unmuted = || Some(sound(Some(false)));
        let mut absent = vec![
            AppState { dial: None, ..state() },
            AppState { dial: Some(sound(None)), ..state() },
            AppState { dial: Some(DialStatus { attached: false, ..sound(Some(false)) }), ..state() },
            AppState { dial: Some(DialStatus { updating: Some("0.0.96".into()), ..sound(Some(false)) }), ..state() },
        ];
        for daemon in [Daemon::Starting, Daemon::Stopped, Daemon::Updating] {
            absent.push(AppState { daemon, dial: unmuted(), ..state() });
        }
        for cli in [CliState::Removed, CliState::Installing, CliState::InstallFailed] {
            absent.push(AppState { cli, dial: unmuted(), ..state() });
        }
        for state in absent {
            assert!(!menu(&state).iter().any(|item| matches!(item, Check(..))), "{state:?}");
        }
    }

    #[test]
    fn the_update_rows() {
        let rows = [
            // No version: the dial's own update reads "Updating to X".
            (AppUpdate::Installing, text("Updating Harness Device…")),
            (AppUpdate::Blocked("0.1.3".into()), act(MenuAction::Update, "Update 0.1.3…")),
        ];
        for (app_update, row) in rows {
            let items = menu(&AppState { app_update: app_update.clone(), ..state() });
            assert_eq!(items[3..6], [act(MenuAction::ClaudeOff, "Turn off"), row.clone(), Separator], "{app_update:?}");
            let with_sound = AppState { app_update: app_update.clone(), dial: Some(sound(Some(false))), ..state() };
            let on = Check(MenuAction::SoundOff, "Sound".into(), true);
            assert_eq!(menu(&with_sound)[4..7], [on, row, Separator], "{app_update:?}");
        }
        assert_eq!(
            menu_log(&menu(&AppState { app_update: AppUpdate::Blocked("0.1.3".into()), ..state() })),
            "Dial connected · 0.0.95 | Signed in | Claude Code: On | Turn off | Update 0.1.3… | Open Harness | Quit"
        );
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
        assert_eq!(
            menu_log(&menu(&AppState { dial: Some(sound(Some(false))), ..state() })),
            "Dial connected · 0.0.95 | Signed in | Claude Code: On | Turn off | Sound ✓ | Open Harness | Quit"
        );
        assert_eq!(
            menu_log(&menu(&AppState { dial: Some(sound(Some(true))), ..state() })),
            "Dial connected · 0.0.95 | Signed in | Claude Code: On | Turn off | Sound | Open Harness | Quit"
        );
    }
}
