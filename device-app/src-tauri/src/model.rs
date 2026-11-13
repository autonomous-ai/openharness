//! What the menu shows and which screen is due, from the app's state.

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
        let removed = AppState {
            cli: CliState::Removed,
            signed_in: None,
            claude: None,
            desktop_installed: false,
            ..state()
        };
        assert_eq!(
            menu(&removed),
            vec![text("Harness removed"), act(MenuAction::Install, "Install"), Separator, act(MenuAction::Quit, "Quit")]
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
