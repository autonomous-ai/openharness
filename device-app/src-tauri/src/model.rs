//! What the menu shows and which screen is due, from the app's state.

use crate::types::{
    AppState, AppUpdate, ClaudeStatus, CliState, CodexStatus, Daemon, DialStatus, EngineChange, MenuAction, MenuItem,
    NotifyMode, Screen,
};

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
    if let Some(claude) = state.claude.as_ref().filter(|claude| available(claude)) {
        let actions = (MenuAction::ClaudeOn, MenuAction::ClaudeOff);
        items.extend(engine_rows("Claude Code", claude.enabled, state.claude_change, actions));
    }
    if let Some(codex) = state.codex.as_ref().filter(|codex| codex_available(codex)) {
        let actions = (MenuAction::CodexOn, MenuAction::CodexOff);
        items.extend(engine_rows("Codex", codex.enabled, state.codex_change, actions));
    }
    // The check is what the dial reports; the item carries the action its click does.
    match settable(state).and_then(|dial| dial.muted) {
        Some(false) => items.push(MenuItem::Check(MenuAction::SoundOff, "Sound".into(), true)),
        Some(true) => items.push(MenuItem::Check(MenuAction::SoundOn, "Sound".into(), false)),
        None => {}
    }
    if let Some(mode) = settable(state).and_then(|dial| dial.notify) {
        items.push(MenuItem::Submenu(
            "Notifications".into(),
            vec![
                MenuItem::Check(MenuAction::NotifyFull, "All".into(), mode == NotifyMode::Full),
                MenuItem::Check(MenuAction::NotifyYou, "Needs you".into(), mode == NotifyMode::You),
            ],
        ));
    }
    match &state.app_update {
        // No version: the dial line's "Updating to X" is the dial's firmware.
        AppUpdate::Installing => items.push(MenuItem::Text("Updating Harness Device…".into())),
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

/// An engine's status row, and its action row unless a change runs.
fn engine_rows(name: &str, enabled: bool, change: EngineChange, (on, off): (MenuAction, MenuAction)) -> Vec<MenuItem> {
    let status = match change {
        EngineChange::Running(true) => return vec![MenuItem::Text(format!("{name}: Turning on…"))],
        EngineChange::Running(false) => return vec![MenuItem::Text(format!("{name}: Turning off…"))],
        EngineChange::Failed(true) => "Could not turn on",
        EngineChange::Failed(false) => "Could not turn off",
        EngineChange::None if enabled => "On",
        EngineChange::None => "Off",
    };
    // A failure sits over the action of the last status read, so a click tries again.
    let action =
        if enabled { MenuItem::Action(off, "Turn off".into()) } else { MenuItem::Action(on, "Turn on".into()) };
    vec![MenuItem::Text(format!("{name}: {status}")), action]
}

/// The screen the window should show next, in the order they chain: install, then sign-in. Claude Code and Codex are
/// turned on in the menu.
pub fn due(state: &AppState) -> Option<Screen> {
    if matches!(state.cli, CliState::Installing | CliState::InstallFailed) {
        return Some(Screen::Install);
    }
    (state.signed_in == Some(false) && !state.saved.asked_sign_in).then_some(Screen::SignIn)
}

/// The menu as one log line: its labels joined by ` | `, without separators. A submenu is its label and its checked
/// item's: `Notifications: All`.
pub fn menu_log(items: &[MenuItem]) -> String {
    let labels: Vec<String> = items
        .iter()
        .filter_map(|item| match item {
            MenuItem::Text(label) | MenuItem::Action(_, label) | MenuItem::Check(_, label, false) => {
                Some(label.clone())
            }
            MenuItem::Check(_, label, true) => Some(format!("{label} ✓")),
            MenuItem::Submenu(label, choices) => choices.iter().find_map(|choice| match choice {
                MenuItem::Check(_, chosen, true) => Some(format!("{label}: {chosen}")),
                _ => None,
            }),
            MenuItem::Separator => None,
        })
        .collect();
    labels.join(" | ")
}

/// An attached dial on a running Harness, not updating: when Sound and Notifications can be changed.
fn settable(state: &AppState) -> Option<&DialStatus> {
    if state.cli != CliState::Found || state.daemon != Daemon::Up {
        return None;
    }
    state.dial.as_ref().filter(|dial| dial.attached && dial.updating.is_none())
}

/// Claude Code can be turned on or off here: also before its plugin is installed, as Turn on installs it.
fn available(claude: &ClaudeStatus) -> bool {
    claude.supported
}

/// Codex can be turned on or off here: the CLI can, and Codex is on this computer.
fn codex_available(codex: &CodexStatus) -> bool {
    codex.supported && codex.installed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        AppState, AppUpdate, ClaudeStatus, CliState, CodexStatus, Daemon, DialStatus, EngineChange, MenuAction,
        MenuItem, NotifyMode, Saved, Screen,
    };
    use MenuItem::{Action, Check, Separator, Submenu, Text};

    fn dial(attached: bool, fw: Option<&str>) -> DialStatus {
        DialStatus {
            attached,
            fw: fw.map(Into::into),
            hw: None,
            board: None,
            updating: None,
            problem: None,
            muted: None,
            notify: None,
        }
    }

    fn sound(muted: Option<bool>) -> DialStatus {
        DialStatus { muted, ..dial(true, Some("0.0.95")) }
    }

    fn notifying(mode: NotifyMode) -> DialStatus {
        DialStatus { notify: Some(mode), ..sound(Some(false)) }
    }

    fn notifications(full: bool, you: bool) -> MenuItem {
        Submenu(
            "Notifications".into(),
            vec![
                Check(MenuAction::NotifyFull, "All".into(), full),
                Check(MenuAction::NotifyYou, "Needs you".into(), you),
            ],
        )
    }

    fn state() -> AppState {
        AppState {
            cli: CliState::Found,
            daemon: Daemon::Up,
            dial: Some(dial(true, Some("0.0.95"))),
            signed_in: Some(true),
            claude: Some(ClaudeStatus { supported: true, installed: true, enabled: true, claude_version: None }),
            codex: None,
            desktop_installed: true,
            saved: Saved { version: 1, cli_seen: true, asked_sign_in: true, login_item: true },
            app_update: AppUpdate::None,
            claude_change: EngineChange::None,
            codex_change: EngineChange::None,
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
        // Off before its plugin is installed too: Turn on installs it.
        for installed in [true, false] {
            let off = ClaudeStatus { supported: true, installed, enabled: false, claude_version: None };
            assert_eq!(
                menu(&AppState { claude: Some(off), ..state() })[2..4],
                [text("Claude Code: Off"), act(MenuAction::ClaudeOn, "Turn on")],
                "{installed}"
            );
        }
        let without =
            [Some(ClaudeStatus { supported: false, installed: true, enabled: true, claude_version: None }), None];
        for claude in without {
            let items = menu(&AppState { claude: claude.clone(), ..state() });
            assert_eq!(items[..3], [text("Dial connected · 0.0.95"), text("Signed in"), Separator], "{claude:?}");
        }
    }

    #[test]
    fn the_change_rows() {
        use EngineChange::{Failed, Running};
        let claude = |enabled, claude_change| {
            let status = ClaudeStatus { supported: true, installed: true, enabled, claude_version: None };
            menu(&AppState { claude: Some(status), claude_change, ..state() })
        };
        // While a change runs, its engine has no action row: the next row is the separator.
        assert_eq!(claude(false, Running(true))[2..4], [text("Claude Code: Turning on…"), Separator]);
        assert_eq!(claude(true, Running(false))[2..4], [text("Claude Code: Turning off…"), Separator]);
        // A failure sits over the action row of the last status, to try again.
        assert_eq!(
            claude(false, Failed(true))[2..4],
            [text("Claude Code: Could not turn on"), act(MenuAction::ClaudeOn, "Turn on")]
        );
        assert_eq!(
            claude(true, Failed(false))[2..4],
            [text("Claude Code: Could not turn off"), act(MenuAction::ClaudeOff, "Turn off")]
        );
        assert_eq!(
            claude(true, Failed(true))[2..4],
            [text("Claude Code: Could not turn on"), act(MenuAction::ClaudeOff, "Turn off")]
        );

        let codex = |enabled, codex_change| {
            menu(&AppState {
                codex: Some(CodexStatus { supported: true, installed: true, enabled }),
                codex_change,
                dial: Some(sound(Some(false))),
                ..state()
            })
        };
        let sound_on = Check(MenuAction::SoundOff, "Sound".into(), true);
        assert_eq!(codex(false, Running(true))[4..6], [text("Codex: Turning on…"), sound_on.clone()]);
        assert_eq!(codex(true, Running(false))[4..6], [text("Codex: Turning off…"), sound_on]);
        assert_eq!(
            codex(false, Failed(true))[4..6],
            [text("Codex: Could not turn on"), act(MenuAction::CodexOn, "Turn on")]
        );
        assert_eq!(
            codex(true, Failed(false))[4..6],
            [text("Codex: Could not turn off"), act(MenuAction::CodexOff, "Turn off")]
        );
        // Each engine's change is its own: Claude Code's rows stay as its status says.
        assert_eq!(
            codex(false, Running(true))[2..4],
            [text("Claude Code: On"), act(MenuAction::ClaudeOff, "Turn off")]
        );
    }

    fn codex(supported: bool, installed: bool, enabled: bool) -> Option<CodexStatus> {
        Some(CodexStatus { supported, installed, enabled })
    }

    #[test]
    fn the_codex_rows() {
        let with = |codex| menu(&AppState { codex, dial: Some(sound(Some(false))), ..state() });
        assert_eq!(
            with(codex(true, true, true)),
            vec![
                text("Dial connected · 0.0.95"),
                text("Signed in"),
                text("Claude Code: On"),
                act(MenuAction::ClaudeOff, "Turn off"),
                text("Codex: On"),
                act(MenuAction::CodexOff, "Turn off"),
                Check(MenuAction::SoundOff, "Sound".into(), true),
                Separator,
                act(MenuAction::OpenHarness, "Open Harness"),
                act(MenuAction::Quit, "Quit"),
            ]
        );
        assert_eq!(with(codex(true, true, false))[4..6], [text("Codex: Off"), act(MenuAction::CodexOn, "Turn on")]);
        for codex in [codex(false, true, true), codex(true, false, true), None] {
            let items = with(codex.clone());
            assert!(!items.iter().any(|item| matches!(item, Text(label) if label.starts_with("Codex"))), "{codex:?}");
            assert_eq!(items[4], Check(MenuAction::SoundOff, "Sound".into(), true), "{codex:?}");
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
    fn the_notifications_submenu() {
        assert_eq!(
            menu(&AppState { dial: Some(notifying(NotifyMode::Full)), ..state() }),
            vec![
                text("Dial connected · 0.0.95"),
                text("Signed in"),
                text("Claude Code: On"),
                act(MenuAction::ClaudeOff, "Turn off"),
                Check(MenuAction::SoundOff, "Sound".into(), true),
                notifications(true, false),
                Separator,
                act(MenuAction::OpenHarness, "Open Harness"),
                act(MenuAction::Quit, "Quit"),
            ]
        );
        assert_eq!(
            menu(&AppState { dial: Some(notifying(NotifyMode::You)), ..state() })[5],
            notifications(false, true)
        );
        let silent = DialStatus { muted: None, ..notifying(NotifyMode::Full) };
        assert_eq!(menu(&AppState { dial: Some(silent), ..state() })[4], notifications(true, false));
    }

    #[test]
    fn the_notifications_submenu_is_absent_when_there_is_nothing_to_change() {
        let full = || Some(notifying(NotifyMode::Full));
        let mut absent = vec![
            AppState { dial: None, ..state() },
            AppState { dial: Some(DialStatus { notify: None, ..notifying(NotifyMode::Full) }), ..state() },
            AppState { dial: Some(DialStatus { attached: false, ..notifying(NotifyMode::Full) }), ..state() },
            AppState {
                dial: Some(DialStatus { updating: Some("0.0.96".into()), ..notifying(NotifyMode::Full) }),
                ..state()
            },
        ];
        for daemon in [Daemon::Starting, Daemon::Stopped, Daemon::Updating] {
            absent.push(AppState { daemon, dial: full(), ..state() });
        }
        for cli in [CliState::Removed, CliState::Installing, CliState::InstallFailed] {
            absent.push(AppState { cli, dial: full(), ..state() });
        }
        for state in absent {
            assert!(!menu(&state).iter().any(|item| matches!(item, Submenu(..))), "{state:?}");
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
    fn only_install_and_sign_in_are_due() {
        let not_asked = Saved { asked_sign_in: false, ..state().saved };
        let claude_off = Some(ClaudeStatus { supported: true, installed: false, enabled: false, claude_version: None });
        let fresh = AppState {
            signed_in: Some(false),
            claude: claude_off,
            codex: codex(true, true, false),
            saved: not_asked,
            ..state()
        };

        for cli in [CliState::Installing, CliState::InstallFailed] {
            assert_eq!(due(&AppState { cli, ..fresh.clone() }), Some(Screen::Install), "{cli:?}");
        }
        assert_eq!(due(&fresh), Some(Screen::SignIn));
        // Claude Code and Codex off, never offered: no window asks about them.
        assert_eq!(due(&AppState { saved: state().saved, ..fresh.clone() }), None);
        for signed_in in [Some(true), None] {
            assert_eq!(due(&AppState { signed_in, ..fresh.clone() }), None, "{signed_in:?}");
        }
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
        assert_eq!(
            menu_log(&menu(&AppState { dial: Some(notifying(NotifyMode::Full)), ..state() })),
            "Dial connected · 0.0.95 | Signed in | Claude Code: On | Turn off | Sound ✓ | Notifications: All | Open Harness | Quit"
        );
        assert_eq!(
            menu_log(&menu(&AppState { dial: Some(notifying(NotifyMode::You)), ..state() })),
            "Dial connected · 0.0.95 | Signed in | Claude Code: On | Turn off | Sound ✓ | Notifications: Needs you | Open Harness | Quit"
        );
    }
}
