//! What the menu shows and which screen is due, from the app's state.

use crate::logs::reason;
use crate::types::{
    AppState, AppUpdate, CliState, Daemon, DialStatus, LogsExport, MenuAction, MenuItem, NotifyMode, OrcaState, Screen,
};

/// The start of the line a saved export leaves in the menu, which the log writes as `Saved`.
const SAVED_TO: &str = "Saved to ";

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
    if dial.updating.is_some() {
        return "Updating device…".into();
    }
    if let Some(problem) = &dial.problem {
        return problem.clone();
    }
    // The firmware's version is in the About panel.
    if dial.attached { "Device ready".into() } else { "Plug in your device".into() }
}

/// The About panel's credits line, `Device 0.1.0 · Harness 0.6.58`: a version the app does not know is left out.
pub fn about_credits(state: &AppState) -> Option<String> {
    let dial = state.dial.as_ref().filter(|dial| dial.attached).and_then(|dial| dial.fw.as_ref());
    let pieces: Vec<String> = [("Device", dial), ("Harness", state.cli_version.as_ref())]
        .into_iter()
        .filter_map(|(name, version)| Some(format!("{name} {}", version?)))
        .collect();
    (!pieces.is_empty()).then(|| pieces.join(" · "))
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
    match state.orca {
        OrcaState::Offer => items.push(MenuItem::Action(MenuAction::Orca, "Connect Orca…".into())),
        OrcaState::Update => items.push(MenuItem::Action(MenuAction::Orca, "Update Orca connection…".into())),
        OrcaState::None => {}
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
        // The app's own update; the dial line's "Updating device…" is the firmware's.
        AppUpdate::Installing => items.push(MenuItem::Text("Updating Harness…".into())),
        // The app cannot replace its bundle: the click opens the download page.
        AppUpdate::Blocked(version) => items.push(MenuItem::Action(MenuAction::Update, format!("Update {version}…"))),
        AppUpdate::None => {}
    }
    items.push(MenuItem::Separator);
    if state.desktop_installed {
        items.push(MenuItem::Action(MenuAction::OpenHarness, "Open Harness".into()));
    }
    // The export runs the CLI; its answer is heard, and kept, whatever became of the CLI since.
    if state.cli == CliState::Found {
        items.push(match state.logs {
            LogsExport::Running => MenuItem::Text("Exporting logs…".into()),
            _ => MenuItem::Action(MenuAction::ExportLogs, "Export logs".into()),
        });
    }
    match &state.logs {
        LogsExport::Saved(shown) => items.push(MenuItem::Text(format!("{SAVED_TO}{shown}"))),
        LogsExport::Failed(failure) => items.push(MenuItem::Text(format!("Export failed: {}", reason(*failure)))),
        LogsExport::Idle | LogsExport::Running => {}
    }
    items.push(MenuItem::Action(MenuAction::About, "About".into()));
    items.push(MenuItem::Action(MenuAction::Quit, "Quit".into()));
    items
}

/// The screen the window should show next, in the order they chain: install, then sign-in.
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
            // The zip may be outside the home, where the line names it whole: the log never names it.
            MenuItem::Text(label) if label.starts_with(SAVED_TO) => Some("Saved".into()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        AppState, AppUpdate, CliState, Daemon, DialStatus, ExportFailure, LogsExport, MenuAction, MenuItem, NotifyMode,
        OrcaState, Saved, Screen,
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
            desktop_installed: true,
            saved: Saved { version: 1, cli_seen: true, asked_sign_in: true, login_item: true },
            app_update: AppUpdate::None,
            cli_version: None,
            logs: LogsExport::Idle,
            orca: OrcaState::None,
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
                text("Device ready"),
                text("Signed in"),
                Separator,
                act(MenuAction::OpenHarness, "Open Harness"),
                act(MenuAction::ExportLogs, "Export logs"),
                act(MenuAction::About, "About"),
                act(MenuAction::Quit, "Quit"),
            ]
        );
    }

    /// Every CliState × Daemon × dial (none, attached, with Sound and Notifications) × signed_in × the Orca row.
    fn states() -> Vec<AppState> {
        let dials = [None, Some(dial(true, Some("0.0.95"))), Some(notifying(NotifyMode::Full))];
        let mut states = Vec::new();
        for cli in [CliState::Found, CliState::Installing, CliState::InstallFailed, CliState::Removed] {
            for daemon in [Daemon::Starting, Daemon::Up, Daemon::Stopped, Daemon::Updating] {
                for dial in &dials {
                    for signed_in in [Some(true), Some(false), None] {
                        for orca in [OrcaState::None, OrcaState::Offer, OrcaState::Update] {
                            states.push(AppState { cli, daemon, dial: dial.clone(), signed_in, orca, ..state() });
                        }
                    }
                }
            }
        }
        states
    }

    #[test]
    fn no_agent_rows_in_any_state() {
        for state in states() {
            let line = menu_log(&menu(&state));
            for word in ["Claude Code", "Codex", "Turn on", "Turn off", "Turning"] {
                assert!(!line.contains(word), "{line}");
            }
        }
    }

    /// The devices service sets the Orca plugin up: the menu has nothing of Orca to offer.
    #[test]
    fn no_orca_row_in_any_state() {
        for state in states() {
            for item in menu(&state) {
                assert!(!format!("{item:?}").contains("Orca"), "{item:?}");
            }
        }
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
            "Updating device…"
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
        // The firmware's version is the About panel's, not the menu's.
        assert_eq!(with(&|s| s.dial = Some(dial(true, Some("0.0.95")))), "Device ready");
        assert_eq!(with(&|s| s.dial = Some(dial(true, None))), "Device ready");
        assert_eq!(with(&|s| s.dial = Some(dial(false, None))), "Plug in your device");
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
        assert_eq!(unknown[1], Separator);
    }

    #[test]
    fn the_orca_row_sits_under_the_account_and_above_sound() {
        let on = Check(MenuAction::SoundOff, "Sound".into(), true);
        let rows = [
            (OrcaState::Offer, act(MenuAction::Orca, "Connect Orca…")),
            (OrcaState::Update, act(MenuAction::Orca, "Update Orca connection…")),
        ];
        for (orca, row) in rows {
            let with_sound = AppState { orca, dial: Some(sound(Some(false))), ..state() };
            assert_eq!(menu(&with_sound)[1..4], [text("Signed in"), row.clone(), on.clone()], "{orca:?}");
            let signed_out = AppState { orca, signed_in: Some(false), ..state() };
            assert_eq!(menu(&signed_out)[1..4], [act(MenuAction::SignIn, "Sign in…"), row.clone(), Separator]);
            // With no account row, it is the first under the dial line.
            assert_eq!(menu(&AppState { orca, signed_in: None, ..state() })[1], row, "{orca:?}");
        }
        assert_eq!(
            menu(&AppState { orca: OrcaState::None, dial: Some(sound(Some(false))), ..state() })[1..3],
            [text("Signed in"), on]
        );
        assert_eq!(
            menu_log(&menu(&AppState { orca: OrcaState::Offer, ..state() })),
            "Device ready | Signed in | Connect Orca… | Open Harness | Export logs | About | Quit"
        );
    }

    #[test]
    fn the_sound_row() {
        let on = Check(MenuAction::SoundOff, "Sound".into(), true);
        let off = Check(MenuAction::SoundOn, "Sound".into(), false);
        assert_eq!(
            menu(&AppState { dial: Some(sound(Some(false))), ..state() }),
            vec![
                text("Device ready"),
                text("Signed in"),
                on.clone(),
                Separator,
                act(MenuAction::OpenHarness, "Open Harness"),
                act(MenuAction::ExportLogs, "Export logs"),
                act(MenuAction::About, "About"),
                act(MenuAction::Quit, "Quit"),
            ]
        );
        assert_eq!(menu(&AppState { dial: Some(sound(Some(true))), ..state() })[2], off);
        let alone = AppState { dial: Some(sound(Some(false))), signed_in: None, ..state() };
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
            // The app's own update; the firmware's reads "Updating device…".
            (AppUpdate::Installing, text("Updating Harness…")),
            (AppUpdate::Blocked("0.1.3".into()), act(MenuAction::Update, "Update 0.1.3…")),
        ];
        for (app_update, row) in rows {
            let items = menu(&AppState { app_update: app_update.clone(), ..state() });
            assert_eq!(items[1..4], [text("Signed in"), row.clone(), Separator], "{app_update:?}");
            let with_sound = AppState { app_update: app_update.clone(), dial: Some(sound(Some(false))), ..state() };
            let on = Check(MenuAction::SoundOff, "Sound".into(), true);
            assert_eq!(menu(&with_sound)[2..5], [on, row, Separator], "{app_update:?}");
        }
        assert_eq!(
            menu_log(&menu(&AppState { app_update: AppUpdate::Blocked("0.1.3".into()), ..state() })),
            "Device ready | Signed in | Update 0.1.3… | Open Harness | Export logs | About | Quit"
        );
    }

    #[test]
    fn the_notifications_submenu() {
        assert_eq!(
            menu(&AppState { dial: Some(notifying(NotifyMode::Full)), ..state() }),
            vec![
                text("Device ready"),
                text("Signed in"),
                Check(MenuAction::SoundOff, "Sound".into(), true),
                notifications(true, false),
                Separator,
                act(MenuAction::OpenHarness, "Open Harness"),
                act(MenuAction::ExportLogs, "Export logs"),
                act(MenuAction::About, "About"),
                act(MenuAction::Quit, "Quit"),
            ]
        );
        assert_eq!(
            menu(&AppState { dial: Some(notifying(NotifyMode::You)), ..state() })[3],
            notifications(false, true)
        );
        let silent = DialStatus { muted: None, ..notifying(NotifyMode::Full) };
        assert_eq!(menu(&AppState { dial: Some(silent), ..state() })[2], notifications(true, false));
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
        assert_eq!(
            items[items.len() - 4..],
            [
                Separator,
                act(MenuAction::ExportLogs, "Export logs"),
                act(MenuAction::About, "About"),
                act(MenuAction::Quit, "Quit")
            ]
        );
        assert!(!items.contains(&act(MenuAction::OpenHarness, "Open Harness")));
    }

    #[test]
    fn without_a_cli_the_menu_says_only_what_it_knows() {
        let removed = AppState { cli: CliState::Removed, signed_in: None, desktop_installed: false, ..state() };
        assert_eq!(
            menu(&removed),
            vec![
                text("Harness removed"),
                act(MenuAction::Install, "Install"),
                Separator,
                act(MenuAction::About, "About"),
                act(MenuAction::Quit, "Quit")
            ]
        );
    }

    #[test]
    fn the_about_credits_name_what_is_known() {
        let harness = Some("0.6.58".to_string());
        assert_eq!(
            about_credits(&AppState { cli_version: harness.clone(), ..state() }),
            Some("Device 0.0.95 · Harness 0.6.58".into())
        );
        assert_eq!(about_credits(&state()), Some("Device 0.0.95".into()));
        for dial in [None, Some(dial(true, None)), Some(dial(false, Some("0.0.95")))] {
            let state = AppState { dial: dial.clone(), cli_version: harness.clone(), ..state() };
            assert_eq!(about_credits(&state), Some("Harness 0.6.58".into()), "{dial:?}");
            assert_eq!(about_credits(&AppState { cli_version: None, ..state }), None, "{dial:?}");
        }
    }

    #[test]
    fn only_install_and_sign_in_are_due() {
        let not_asked = Saved { asked_sign_in: false, ..state().saved };
        let fresh = AppState { signed_in: Some(false), saved: not_asked, ..state() };

        for cli in [CliState::Installing, CliState::InstallFailed] {
            assert_eq!(due(&AppState { cli, ..fresh.clone() }), Some(Screen::Install), "{cli:?}");
        }
        assert_eq!(due(&fresh), Some(Screen::SignIn));
        assert_eq!(due(&AppState { saved: state().saved, ..fresh.clone() }), None);
        for signed_in in [Some(true), None] {
            assert_eq!(due(&AppState { signed_in, ..fresh.clone() }), None, "{signed_in:?}");
        }
        assert_eq!(due(&state()), None);
    }

    #[test]
    fn the_menu_as_a_log_line() {
        assert_eq!(menu_log(&menu(&state())), "Device ready | Signed in | Open Harness | Export logs | About | Quit");
        assert_eq!(
            menu_log(&menu(&AppState { dial: Some(sound(Some(false))), ..state() })),
            "Device ready | Signed in | Sound ✓ | Open Harness | Export logs | About | Quit"
        );
        assert_eq!(
            menu_log(&menu(&AppState { dial: Some(sound(Some(true))), ..state() })),
            "Device ready | Signed in | Sound | Open Harness | Export logs | About | Quit"
        );
        assert_eq!(
            menu_log(&menu(&AppState { dial: Some(notifying(NotifyMode::Full)), ..state() })),
            "Device ready | Signed in | Sound ✓ | Notifications: All | Open Harness | Export logs | About | Quit"
        );
        assert_eq!(
            menu_log(&menu(&AppState { dial: Some(notifying(NotifyMode::You)), ..state() })),
            "Device ready | Signed in | Sound ✓ | Notifications: Needs you | Open Harness | Export logs | About | Quit"
        );
    }

    const SAVED: &str = "~/Desktop/harness-logs-20261118-1030.zip";

    fn exporting(logs: LogsExport) -> Vec<MenuItem> {
        menu(&AppState { logs, ..state() })
    }

    /// The rows after Open Harness.
    fn export_rows(items: &[MenuItem]) -> Vec<MenuItem> {
        let at = items.iter().position(|item| *item == act(MenuAction::OpenHarness, "Open Harness")).unwrap();
        items[at + 1..].to_vec()
    }

    #[test]
    fn the_export_row_has_three_states() {
        let export = act(MenuAction::ExportLogs, "Export logs");
        let (about, quit) = (act(MenuAction::About, "About"), act(MenuAction::Quit, "Quit"));
        assert_eq!(export_rows(&exporting(LogsExport::Idle)), [export.clone(), about.clone(), quit.clone()]);
        // A second click has nothing to land on while one runs.
        assert_eq!(
            export_rows(&exporting(LogsExport::Running)),
            [text("Exporting logs…"), about.clone(), quit.clone()]
        );
        assert_eq!(
            export_rows(&exporting(LogsExport::Saved(SAVED.into()))),
            [export.clone(), text("Saved to ~/Desktop/harness-logs-20261118-1030.zip"), about.clone(), quit.clone()]
        );
        let failures = [
            (ExportFailure::TimedOut, "Export failed: timed out"),
            (ExportFailure::NoAnswer, "Export failed: Harness did not answer"),
            (ExportFailure::NoFile, "Export failed: no file"),
        ];
        for (failure, line) in failures {
            assert_eq!(
                export_rows(&exporting(LogsExport::Failed(failure))),
                [export.clone(), text(line), about.clone(), quit.clone()],
                "{failure:?}"
            );
        }
    }

    #[test]
    fn the_export_row_needs_a_cli() {
        let every = [
            LogsExport::Idle,
            LogsExport::Running,
            LogsExport::Saved(SAVED.into()),
            LogsExport::Failed(ExportFailure::NoAnswer),
        ];
        for cli in [CliState::Installing, CliState::InstallFailed, CliState::Removed] {
            for logs in every.clone() {
                let line = menu_log(&menu(&AppState { cli, logs: logs.clone(), ..state() }));
                for row in ["Export logs", "Exporting logs…"] {
                    assert!(!line.split(" | ").any(|label| label == row), "{cli:?} {logs:?}: {line}");
                }
            }
            // The line outlives the CLI.
            let saved = menu(&AppState { cli, logs: LogsExport::Saved(SAVED.into()), ..state() });
            assert!(saved.contains(&text("Saved to ~/Desktop/harness-logs-20261118-1030.zip")), "{cli:?}");
        }
    }

    #[test]
    fn the_log_never_names_the_zip() {
        let items = exporting(LogsExport::Saved("/Volumes/Work/harness-logs-20261118-1030.zip".into()));
        assert_eq!(menu_log(&items), "Device ready | Signed in | Open Harness | Export logs | Saved | About | Quit");
    }
}
