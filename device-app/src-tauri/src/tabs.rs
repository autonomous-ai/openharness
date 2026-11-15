//! The tabs of Terminal, iTerm2 and Ghostty, for the dial to follow: the lines the watch reads and writes, the tty
//! check, and when to ask an app for its selected tab. A tty is private like the app in front: it goes on the watch's
//! stdin and into a fixed script's parameter, never into the log, an Event or the state file.

#[cfg(test)]
mod tests {
    use super::*;

    const T: TabApp = TabApp::Terminal;
    const TTY: &str = "/dev/ttys023";
    const OTHER: &str = "/dev/ttys024";
    const APPS: [TabApp; 3] = [TabApp::Terminal, TabApp::Iterm, TabApp::Ghostty];
    const VS_CODE: &str = "com.microsoft.VSCode";

    /// Terminal in front, a watch running and the dial attached.
    fn polling() -> TabFollow {
        let mut follow = TabFollow::default();
        follow.front("com.apple.Terminal");
        follow.watching(true);
        follow.attached(true);
        follow
    }

    fn tty(value: &str) -> Result<Option<String>, TabError> {
        Ok(Some(value.into()))
    }

    fn select(app: TabApp, tty: &str, frontmost: bool, raise: bool) -> Option<Select> {
        Some(Select { app, tty: tty.into(), frontmost, raise })
    }

    #[test]
    fn the_three_apps_by_id_and_by_bundle() {
        for (app, id, bundle, name) in [
            (TabApp::Terminal, "terminal-app", "com.apple.Terminal", "Terminal"),
            (TabApp::Iterm, "iterm", "com.googlecode.iterm2", "iTerm2"),
            (TabApp::Ghostty, "ghostty", "com.mitchellh.ghostty", "Ghostty"),
        ] {
            assert_eq!((app.id(), app.bundle(), app.name()), (id, bundle, name));
            assert_eq!(TabApp::from_id(id), Some(app));
            assert_eq!(TabApp::from_bundle(bundle), Some(app));
            // An id is no bundle, and a bundle no id.
            assert_eq!(TabApp::from_id(bundle), None);
            assert_eq!(TabApp::from_bundle(id), None);
        }
        for other in ["orca", "none", "", "Terminal", "TERMINAL-APP", "com.apple.terminal", VS_CODE, "constructor"] {
            assert_eq!(TabApp::from_id(other), None, "{other}");
            assert_eq!(TabApp::from_bundle(other), None, "{other}");
        }
    }

    #[test]
    fn a_tty_is_dev_ttys_and_one_to_four_digits() {
        for ok in ["/dev/ttys0", TTY, "/dev/ttys9999"] {
            assert!(tty_ok(ok), "{ok}");
        }
        for bad in [
            "/dev/ttys",
            "/dev/ttys12345",
            "/dev/pts/3",
            "ttys023",
            "/dev/ttys02a",
            "/dev/ttys023\n",
            "/dev/ttys023; rm",
            "/dev/ttys\u{661}",
            "",
        ] {
            assert!(!tty_ok(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_tab_line_is_one_short_line_and_none_for_a_bad_tty() {
        assert_eq!(tab_line(T, TTY).as_deref(), Some(r#"{"tab":{"app":"terminal-app","tty":"/dev/ttys023"}}"#));
        for app in APPS {
            // Under 140 bytes, as the front line: one pipe write the watch never sees torn.
            let line = tab_line(app, "/dev/ttys9999").unwrap();
            assert!(line.len() < 140, "{line}");
            assert!(!line.contains(['\n', '\r']), "{line}");
            assert_eq!(tab_line(app, "/dev/ttys023; rm"), None);
            assert_eq!(tab_line(app, "/dev/pts/3"), None);
        }
    }

    #[test]
    fn a_select_line_is_read_only_when_its_app_and_tty_pass() {
        assert_eq!(select_of(r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023"}}"#), Some((T, TTY.into(), false)));
        assert_eq!(select_of(r#"{"select":{"app":"iterm","tty":"/dev/ttys0"}}"#), Some((TabApp::Iterm, "/dev/ttys0".into(), false)));
        assert_eq!(
            select_of(r#"{"select":{"app":"ghostty","tty":"/dev/ttys9999"}}"#),
            Some((TabApp::Ghostty, "/dev/ttys9999".into(), false))
        );
        for dropped in [
            r#"{"select":{"app":"orca","tty":"/dev/ttys023"}}"#,
            r#"{"select":{"app":"com.apple.Terminal","tty":"/dev/ttys023"}}"#,
            r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023; rm"}}"#,
            r#"{"select":{"app":"terminal-app","tty":"/dev/pts/3"}}"#,
            r#"{"select":{"app":"terminal-app"}}"#,
            r#"{"select":{"tty":"/dev/ttys023"}}"#,
            r#"{"select":{"app":7,"tty":"/dev/ttys023"}}"#,
            r#"{"select":"terminal-app"}"#,
            r#"{"tab":{"app":"terminal-app","tty":"/dev/ttys023"}}"#,
            r#"{"attached":true,"fw":"0.1.0","hw":"round"}"#,
            "not json",
            "",
        ] {
            assert_eq!(select_of(dropped), None, "{dropped}");
        }
    }

    #[test]
    fn a_select_line_raises_only_when_it_says_true() {
        assert_eq!(
            select_of(r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023","raise":true}}"#),
            Some((T, TTY.into(), true))
        );
        assert_eq!(
            select_of(r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023","raise":false}}"#),
            Some((T, TTY.into(), false))
        );
        assert_eq!(select_of(r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023"}}"#), Some((T, TTY.into(), false)));
    }

    #[test]
    fn a_select_line_with_a_raise_that_is_not_a_boolean_is_dropped() {
        for raise in [r#""true""#, "1", "null", "{}", "[]"] {
            let line = format!(r#"{{"select":{{"app":"terminal-app","tty":"/dev/ttys023","raise":{raise}}}}}"#);
            assert_eq!(select_of(&line), None, "{line}");
        }
    }

    #[test]
    fn it_polls_only_with_a_tab_app_in_front_a_watch_and_the_dial_attached() {
        let mut follow = TabFollow::default();
        assert_eq!(follow.polls(), None);
        follow.front("com.apple.Terminal");
        assert_eq!(follow.polls(), None);
        follow.watching(true);
        assert_eq!(follow.polls(), None);
        follow.attached(true);
        assert_eq!(follow.polls(), Some(T));
        for app in APPS {
            follow.front(app.bundle());
            assert_eq!(follow.polls(), Some(app));
        }
        // Another app, and an id or a name in place of a bundle, are no tab app.
        for other in [VS_CODE, "", "terminal-app", "Terminal", "Code.exe"] {
            follow.front(other);
            assert_eq!(follow.polls(), None, "{other}");
        }
    }

    #[test]
    fn a_front_change_a_watch_ending_or_the_dial_detaching_stops_it_at_once() {
        let mut follow = polling();
        follow.front(VS_CODE);
        assert_eq!(follow.polls(), None);

        let mut follow = polling();
        follow.watching(false);
        assert_eq!(follow.polls(), None);

        let mut follow = polling();
        follow.attached(false);
        assert_eq!(follow.polls(), None);
        follow.attached(true);
        assert_eq!(follow.polls(), Some(T));
    }

    #[test]
    fn a_new_watch_starts_detached() {
        let mut follow = polling();
        follow.watching(true);
        assert_eq!(follow.polls(), None);
        follow.attached(true);
        assert_eq!(follow.polls(), Some(T));

        // The last watch's dial is not the next one's.
        let mut follow = polling();
        follow.watching(false);
        follow.watching(true);
        assert_eq!(follow.polls(), None);
    }

    #[test]
    fn it_reports_a_change_and_the_first_answer_each_time_polling_starts() {
        let mut follow = polling();
        assert_eq!(follow.polled(T, tty(TTY), 0).line, tab_line(T, TTY));
        assert_eq!(follow.polled(T, tty(TTY), 0).line, None);
        assert_eq!(follow.polled(T, tty(OTHER), 1).line, tab_line(T, OTHER));
        // No window and a tty that fails the check are no report, and leave the last one.
        assert_eq!(follow.polled(T, Ok(None), 1).line, None);
        assert_eq!(follow.polled(T, tty("/dev/pts/3"), 1).line, None);
        assert_eq!(follow.polled(T, tty(OTHER), 1).line, None);
        // The status the watch prints again and again does not start polling over.
        follow.attached(true);
        assert_eq!(follow.polled(T, tty(OTHER), 1).line, None);

        // Each start writes the first answer, even when the tab is the one reported last.
        follow.front(VS_CODE);
        follow.front("com.apple.Terminal");
        assert_eq!(follow.polled(T, tty(OTHER), 2).line, tab_line(T, OTHER));
        follow.attached(false);
        follow.attached(true);
        assert_eq!(follow.polled(T, tty(OTHER), 2).line, tab_line(T, OTHER));
        follow.watching(true);
        follow.attached(true);
        assert_eq!(follow.polled(T, tty(OTHER), 2).line, tab_line(T, OTHER));
        // From one tab app straight to another and back.
        follow.front(TabApp::Iterm.bundle());
        assert_eq!(follow.polled(TabApp::Iterm, tty(OTHER), 3).line, tab_line(TabApp::Iterm, OTHER));
        follow.front(T.bundle());
        assert_eq!(follow.polled(T, tty(OTHER), 3).line, tab_line(T, OTHER));
    }

    #[test]
    fn an_answer_for_an_app_no_longer_polled_is_dropped() {
        let mut follow = polling();
        assert_eq!(follow.polled(TabApp::Iterm, tty(TTY), 0).line, None);
        follow.front(VS_CODE);
        assert_eq!(follow.polled(T, tty(TTY), 0).line, None);
        follow.front(T.bundle());
        follow.attached(false);
        assert_eq!(follow.polled(T, tty(TTY), 0).line, None);
        follow.attached(true);
        // A dropped answer was never reported: the next one is.
        assert_eq!(follow.polled(T, tty(TTY), 0).line, tab_line(T, TTY));
    }

    #[test]
    fn the_newest_waiting_select_replaces_the_one_before() {
        let mut follow = polling();
        assert_eq!(follow.next_select(), None);
        follow.select(T, TTY.into(), false);
        follow.select(TabApp::Iterm, OTHER.into(), false);
        assert_eq!(follow.next_select(), select(TabApp::Iterm, OTHER, false, false));
        assert_eq!(follow.next_select(), None);
        // Whether its app is in front is read when it is taken.
        follow.select(T, TTY.into(), false);
        assert_eq!(follow.next_select(), select(T, TTY, true, false));
        follow.select(T, TTY.into(), false);
        follow.front(VS_CODE);
        assert_eq!(follow.next_select(), select(T, TTY, false, false));
    }

    #[test]
    fn a_waiting_select_keeps_its_raise_and_a_newer_one_brings_its_own() {
        let mut follow = polling();
        follow.select(T, TTY.into(), true);
        assert_eq!(follow.next_select(), select(T, TTY, true, true));
        follow.select(T, TTY.into(), true);
        follow.select(T, OTHER.into(), false);
        assert_eq!(follow.next_select(), select(T, OTHER, true, false));
        assert_eq!(follow.next_select(), None);
        follow.select(T, OTHER.into(), false);
        follow.select(T, TTY.into(), true);
        assert_eq!(follow.next_select(), select(T, TTY, true, true));
    }

    #[test]
    fn a_select_that_waited_behind_a_call_over_two_seconds_is_dropped() {
        assert_eq!(CALL_TIMEOUT, Duration::from_secs(2));
        assert_eq!(POLL_EVERY, Duration::from_millis(500));
        let mut follow = polling();
        follow.select(T, TTY.into(), false);
        follow.waited(Duration::from_millis(2_000));
        assert_eq!(follow.next_select(), select(T, TTY, true, false));

        follow.select(T, TTY.into(), true);
        follow.waited(Duration::from_millis(2_001));
        assert_eq!(follow.next_select(), None);
        // A select that comes after it runs, and polling goes on: only the consent prompt held that call.
        follow.select(T, OTHER.into(), false);
        assert_eq!(follow.next_select(), select(T, OTHER, true, false));
        assert_eq!(follow.polls(), Some(T));
        assert_eq!(follow.polled(T, tty(TTY), 0).line, tab_line(T, TTY));
    }

    #[test]
    fn denied_turns_that_app_off_and_says_so_once() {
        let mut follow = polling();
        follow.select(T, TTY.into(), false);
        let out = follow.polled(T, Err(TabError::Denied), 0);
        assert_eq!((out.line, out.log), (None, vec!["tabs: Terminal not allowed".to_string()]));
        assert_eq!(follow.polls(), None);
        // The select that waited is dropped, and none waits for it again.
        assert_eq!(follow.next_select(), None);
        follow.select(T, TTY.into(), true);
        assert_eq!(follow.next_select(), None);
        // Nothing turns it back on but a new start of Harness Device.
        follow.front(VS_CODE);
        follow.front(T.bundle());
        follow.watching(true);
        follow.attached(true);
        assert_eq!(follow.polls(), None);
        assert_eq!(follow.polled(T, tty(TTY), 1).line, None);
        // A call that was already running when it was denied says nothing more.
        assert!(follow.polled(T, Err(TabError::Denied), 1).log.is_empty());
        assert!(follow.selected(T, Err(TabError::Denied)).log.is_empty());

        // A select's denial turns its app off the same way.
        let mut follow = polling();
        assert_eq!(follow.selected(T, Err(TabError::Denied)).log, ["tabs: Terminal not allowed"]);
        assert_eq!(follow.polls(), None);
        follow.select(T, TTY.into(), false);
        assert_eq!(follow.next_select(), None);
    }

    #[test]
    fn the_other_apps_go_on() {
        let mut follow = polling();
        follow.polled(T, Err(TabError::Denied), 0);
        for app in [TabApp::Iterm, TabApp::Ghostty] {
            follow.front(app.bundle());
            assert_eq!(follow.polls(), Some(app));
            assert_eq!(follow.polled(app, tty(TTY), 0).line, tab_line(app, TTY));
            follow.select(app, OTHER.into(), false);
            assert_eq!(follow.next_select(), select(app, OTHER, true, false));
        }
    }

    #[test]
    fn ghostty_without_a_tty_is_turned_off_and_the_same_code_from_terminal_is_a_failed_call() {
        for code in [-1728, -10000] {
            assert_eq!(tab_error(TabApp::Ghostty, code), TabError::NoTty);
            assert_eq!(tab_error(T, code), TabError::Failed);
            assert_eq!(tab_error(TabApp::Iterm, code), TabError::Failed);
        }
        for app in APPS {
            assert_eq!(tab_error(app, -1743), TabError::Denied);
            // The app quit, timed out, or anything else: try again at the next tick.
            for code in [-600, -1712, -1, 0] {
                assert_eq!(tab_error(app, code), TabError::Failed, "{app:?} {code}");
            }
        }

        let mut follow = polling();
        follow.front(TabApp::Ghostty.bundle());
        let out = follow.polled(TabApp::Ghostty, Err(tab_error(TabApp::Ghostty, -1728)), 0);
        assert_eq!(out.log, ["tabs: Ghostty has no tty"]);
        assert_eq!(follow.polls(), None);
        assert!(follow.polled(TabApp::Ghostty, Err(TabError::NoTty), 0).log.is_empty());

        follow.front(T.bundle());
        assert!(follow.polled(T, Err(tab_error(T, -1728)), 0).log.is_empty());
        assert_eq!(follow.polls(), Some(T));
    }

    #[test]
    fn failed_polls_are_one_count_line_a_minute() {
        let mut follow = polling();
        assert!(follow.polled(T, Err(TabError::Failed), 100).log.is_empty());
        assert!(follow.polled(T, Err(TabError::Failed), 130).log.is_empty());
        assert!(follow.polled(T, tty(TTY), 159).log.is_empty());
        assert_eq!(follow.polled(T, Err(TabError::Failed), 160).log, ["tabs: 3 polls failed"]);
        // A failed poll does not stop polling.
        assert_eq!(follow.polls(), Some(T));
        // The count starts again at the next failure, and a minute later says so even with no failure since.
        assert!(follow.polled(T, Ok(None), 200).log.is_empty());
        assert!(follow.polled(T, Err(TabError::Failed), 230).log.is_empty());
        assert!(follow.polled(T, Ok(None), 289).log.is_empty());
        assert_eq!(follow.polled(T, Ok(None), 290).log, ["tabs: 1 polls failed"]);
        // With no failure, no line.
        assert!(follow.polled(T, Ok(None), 1_000).log.is_empty());
        // A failed select is no failed poll.
        assert_eq!(follow.selected(T, Err(TabError::Failed)).log, ["tabs: Terminal select failed"]);
        assert!(follow.polled(T, Ok(None), 2_000).log.is_empty());
    }

    #[test]
    fn each_select_is_one_log_line() {
        let mut follow = polling();
        for (app, done, said) in [
            (T, Ok(Selected::Done), "tabs: Terminal select ok"),
            (T, Ok(Selected::NoTab), "tabs: Terminal select none"),
            (T, Err(TabError::Failed), "tabs: Terminal select failed"),
            (TabApp::Iterm, Ok(Selected::Done), "tabs: iTerm2 select ok"),
            (TabApp::Ghostty, Ok(Selected::NoTab), "tabs: Ghostty select none"),
            (TabApp::Ghostty, Err(TabError::NoTty), "tabs: Ghostty has no tty"),
        ] {
            let out = follow.selected(app, done);
            assert_eq!((out.line, out.log), (None, vec![said.to_string()]));
        }
        // A failed select leaves its app on.
        assert_eq!(follow.polls(), Some(T));
    }

    #[test]
    fn no_log_line_holds_a_tty() {
        let mut follow = polling();
        let mut said = Vec::new();
        for (now, answer) in [
            (0, tty(TTY)),
            (1, tty(OTHER)),
            (2, Err(TabError::Failed)),
            (3, Ok(None)),
            (70, Err(TabError::Failed)),
            (71, Err(TabError::Denied)),
        ] {
            said.extend(follow.polled(T, answer, now).log);
        }
        follow.front(TabApp::Ghostty.bundle());
        for done in [Ok(Selected::Done), Ok(Selected::NoTab), Err(TabError::Failed), Err(TabError::NoTty)] {
            follow.select(TabApp::Ghostty, TTY.into(), false);
            follow.next_select();
            said.extend(follow.selected(TabApp::Ghostty, done).log);
        }
        assert_eq!(said.len(), 6, "{said:?}");
        for line in said {
            assert!(!line.contains("ttys") && !line.contains("/dev"), "{line}");
        }
    }

    #[test]
    fn no_tabs_runs_nothing() {
        for app in APPS {
            assert!(!NoTabs.running(app));
            assert_eq!(NoTabs.selected_tty(app), Ok(None));
            assert_eq!(NoTabs.select_tty(app, TTY, true), Ok(Selected::NoTab));
            assert_eq!(NoTabs.focus_tty(app, TTY), Ok(Selected::NoTab));
        }
    }
}
