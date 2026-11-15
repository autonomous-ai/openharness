#[cfg(test)]
mod tests {
    use super::*;
    use crate::tabs::CALL_TIMEOUT;
    use std::process::Command;
    use std::time::Duration;

    const T: TabApp = TabApp::Terminal;
    const TTY: &str = "/dev/ttys023";
    const APPS: [TabApp; 3] = [TabApp::Terminal, TabApp::Iterm, TabApp::Ghostty];

    /// Answers its parameter, and talks to no app.
    const ECHO: &str = "on echo(t)\n\treturn t\nend echo";

    /// Stands in for Terminal's script, with no event: a tty, the select's front flag back, and whether focus got the
    /// tty it names.
    const ANSWERS: &str = r#"
on selected_tty()
	return "/dev/ttys023"
end selected_tty

on select_tty(t, in_front)
	return in_front
end select_tty

on focus_tty(t)
	return t is "/dev/ttys023"
end focus_tty
"#;

    /// Stands in for iTerm2's and Ghostty's: no window, a select denied, and a focus with no tty in the dictionary.
    const REFUSES: &str = r#"
on selected_tty()
	return ""
end selected_tty

on select_tty(t, in_front)
	error number -1743
end select_tty

on focus_tty(t)
	error number -1728
end focus_tty
"#;

    /// Stands in for an app's script in the tty check's test alone: no other test compiles it.
    const SENT: &str =
        "on select_tty(t, in_front)\n\treturn true\nend select_tty\n\non focus_tty(t)\n\treturn true\nend focus_tty";

    /// The text of each script the thread holds for `source`. The thread is the process's own, so tests that run at the
    /// same time each look only at a source of their own.
    fn compiled(source: &'static str) -> Vec<String> {
        on_script_thread(move |compiled| {
            compiled
                .iter()
                .filter(|(known, _)| *known == source)
                .map(|(_, script)| script.source().map(|text| text.to_string()).unwrap_or_default())
                .collect()
        })
        .unwrap()
    }

    #[test]
    fn a_handler_gets_its_parameter_as_a_descriptor() {
        assert_eq!(call(ECHO, "echo", vec![Arg::Text(TTY.into())], text), Ok(TTY.to_string()));
        assert_eq!(call(ECHO, "echo", vec![Arg::Text("/dev/ttys9".into())], text), Ok("/dev/ttys9".to_string()));
        // Compiled once, at its first call, and neither tty is in what was compiled.
        let sources = compiled(ECHO);
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert!(sources[0].contains("on echo(t)"), "{}", sources[0]);
        assert!(!sources[0].contains("/dev/ttys"), "{}", sources[0]);
    }

    #[test]
    fn the_fixed_sources_hold_no_tty_and_read_nothing_but_ttys_and_selection() {
        for app in APPS {
            let text = source(app).to_lowercase();
            assert!(!text.contains("/dev/ttys"), "{app:?}");
            for word in
                ["activate", "name of", "title", "contents", "history", "working directory", "do script", "keystroke"]
            {
                assert!(!text.contains(word), "{app:?}: {word}");
            }
            // A term written by its code is read by its code: each is a window, a tab, a session or terminal, its tty
            // or what is selected.
            let allowed: &[&str] = match app {
                TabApp::Terminal => {
                    &["class cwin", "property pvis", "property pidx", "property tcnt", "class ttab", "property ttty"]
                }
                TabApp::Iterm => &[
                    "class cwin",
                    "property pvis",
                    "property Crwn",
                    "property Wcsn",
                    "class Trmt",
                    "class Trms",
                    "property Stty",
                    "event Itrmslct",
                ],
                TabApp::Ghostty => &[
                    "class Gwnd",
                    "property GFWn",
                    "property GWsT",
                    "class Gtab",
                    "property GTfT",
                    "class Gtrm",
                    "property Gtty",
                    "event GhstSlTb",
                ],
            };
            let terms: Vec<&str> =
                source(app).split('«').skip(1).map(|rest| rest.split('»').next().unwrap_or_default()).collect();
            assert!(!terms.is_empty(), "{app:?}");
            for term in terms {
                assert!(allowed.contains(&term), "{app:?}: «{term}»");
            }
        }
    }

    #[test]
    fn every_source_compiles() {
        // With every term a code and the app named only at run time, compiling reads no dictionary and sends no event:
        // it passes on a Mac without iTerm2 or Ghostty. On the script thread, as every compile is.
        for app in APPS {
            assert_eq!(on_script_thread(move |_| compile(source(app)).err()), Some(None), "{app:?}");
        }
    }

    #[test]
    fn every_source_has_the_three_handlers() {
        for app in APPS {
            for handler in ["on selected_tty()", "on select_tty(", "on focus_tty("] {
                let count = source(app).lines().filter(|line| line.trim_start().starts_with(handler)).count();
                assert_eq!(count, 1, "{app:?}: {handler}");
            }
        }
    }

    #[test]
    fn each_source_tells_only_its_own_app_within_the_call_timeout() {
        assert_eq!(CALL_TIMEOUT, Duration::from_secs(2));
        for app in APPS {
            let text = source(app);
            assert_eq!(text.matches("property app_id").count(), 1, "{app:?}");
            assert!(text.contains(&format!("property app_id : \"{}\"", app.bundle())), "{app:?}");
            let tells = text.matches("tell application").count();
            assert!(tells > 0, "{app:?}");
            assert_eq!(text.matches("tell application id app_id").count(), tells, "{app:?}");
            assert_eq!(text.matches("with timeout of 2 seconds").count(), tells, "{app:?}");
        }
    }

    #[test]
    fn a_tty_that_fails_the_check_is_never_sent() {
        let tabs = MacTabs { source: |_| SENT };
        for bad in ["/dev/ttys023; rm", "/dev/ttys023\n", "/dev/pts/3", "/dev/ttys12345", ""] {
            assert_eq!(tabs.select_tty(T, bad, true), Err(TabError::Failed), "{bad:?}");
            assert_eq!(tabs.focus_tty(T, bad), Err(TabError::Failed), "{bad:?}");
        }
        // No call reached the script thread: its script was not even compiled.
        assert!(compiled(SENT).is_empty());
        // The same calls with a tty that passes are sent.
        assert_eq!(tabs.select_tty(T, TTY, true), Ok(Selected::Done));
        assert_eq!(tabs.focus_tty(T, TTY), Ok(Selected::Done));
        assert_eq!(compiled(SENT).len(), 1);
    }

    #[test]
    fn answers_and_error_numbers_read_as_the_tab_rules_say() {
        let tabs = MacTabs { source: |app| if app == TabApp::Terminal { ANSWERS } else { REFUSES } };
        assert_eq!(tabs.selected_tty(T), Ok(Some(TTY.to_string())));
        // The empty string is no window.
        assert_eq!(tabs.selected_tty(TabApp::Iterm), Ok(None));
        // The front flag reaches the handler as its second parameter.
        assert_eq!(tabs.select_tty(T, TTY, true), Ok(Selected::Done));
        assert_eq!(tabs.select_tty(T, TTY, false), Ok(Selected::NoTab));
        assert_eq!(tabs.focus_tty(T, TTY), Ok(Selected::Done));
        assert_eq!(tabs.focus_tty(T, "/dev/ttys024"), Ok(Selected::NoTab));
        // An error's number goes through tab_error, with its app.
        assert_eq!(tabs.select_tty(TabApp::Iterm, TTY, true), Err(TabError::Denied));
        assert_eq!(tabs.focus_tty(TabApp::Ghostty, TTY), Err(TabError::NoTty));
        assert_eq!(tabs.focus_tty(TabApp::Iterm, TTY), Err(TabError::Failed));
        // Each source was compiled once, iTerm2's and Ghostty's stand-in for both.
        assert_eq!((compiled(ANSWERS).len(), compiled(REFUSES).len()), (1, 1));
    }

    #[test]
    fn an_app_that_is_not_running_reads_as_not_running() {
        assert!(!runs("ai.autonomous.harness.no-such-app"));
        // LaunchServices does answer: the Dock runs in every session a person is logged in to.
        assert!(runs("com.apple.dock"));
    }

    /// The test's own script, which only it runs: it opens and closes Terminal windows of its own, by id.
    const SCRATCH: &str = r#"
on open_window()
	tell application id "com.apple.Terminal"
		set known to id of every window
		do script ""
		repeat with w in (every window)
			if known does not contain (id of w) then return (id of w) as text
		end repeat
	end tell
	return ""
end open_window

on tty_of(w)
	tell application id "com.apple.Terminal" to return tty of selected tab of window id (w as integer)
end tty_of

on raise_window(w)
	tell application id "com.apple.Terminal" to set index of window id (w as integer) to 1
end raise_window

on close_window(w)
	tell application id "com.apple.Terminal" to close window id (w as integer)
end close_window
"#;

    /// The windows the test opened, closed by id when it ends, passed or failed: no other window is touched.
    #[derive(Default)]
    struct Scratch {
        ids: Vec<String>,
    }

    impl Scratch {
        /// A new window's id and its tab's tty.
        fn open(&mut self) -> (String, String) {
            let id = call(SCRATCH, "open_window", Vec::new(), text).unwrap();
            assert!(!id.is_empty(), "no new Terminal window");
            self.ids.push(id.clone());
            let tty = self.tty_of(&id);
            assert!(tty_ok(&tty), "{tty}");
            (id, tty)
        }

        fn tty_of(&self, id: &str) -> String {
            call(SCRATCH, "tty_of", vec![Arg::Text(id.into())], text).unwrap()
        }

        /// Raises the window inside Terminal, as `set index` does: Terminal itself stays where it is.
        fn raise(&self, id: &str) {
            call(SCRATCH, "raise_window", vec![Arg::Text(id.into())], text).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            for id in &self.ids {
                // Never a panic here: a drop that panics while a failed assertion unwinds aborts the test.
                let _ = call(SCRATCH, "close_window", vec![Arg::Text(id.clone())], text);
            }
        }
    }

    /// The app in front, from LaunchServices: AppKit's own answer is not fresh in a process with no run loop.
    fn front_bundle() -> String {
        let front = Command::new("/usr/bin/lsappinfo").arg("front").output().unwrap();
        let front = String::from_utf8(front.stdout).unwrap();
        let info =
            Command::new("/usr/bin/lsappinfo").args(["info", "-only", "bundleid", front.trim()]).output().unwrap();
        String::from_utf8(info.stdout).unwrap().trim().to_string()
    }

    #[test]
    #[ignore = "scripts two Terminal windows of its own: Verification, check 2, on a Mac by hand"]
    fn scratch_terminal_windows() {
        let tabs = MacTabs::default();
        assert!(tabs.running(T), "Terminal must be running: the test opens its windows there and launches nothing");
        let mut scratch = Scratch::default();
        let (first, first_tty) = scratch.open();
        let (second, second_tty) = scratch.open();
        let front = front_bundle();
        assert!(
            !front.contains("\"com.apple.Terminal\""),
            "put another app in front, so the test can see Terminal stay behind it: {front}"
        );

        // Terminal is in the back: a swipe selects the tab and raises nothing.
        assert_eq!(tabs.select_tty(T, &second_tty, false), Ok(Selected::Done));
        assert_eq!(scratch.tty_of(&second), second_tty);
        assert_eq!(tabs.select_tty(T, "/dev/ttys9999", false), Ok(Selected::NoTab));
        assert_eq!(tabs.focus_tty(T, "/dev/ttys9999"), Ok(Selected::NoTab));

        scratch.raise(&first);
        assert_eq!(tabs.selected_tty(T), Ok(Some(first_tty)));
        // A tap raises the window that holds the tty, inside Terminal.
        assert_eq!(tabs.focus_tty(T, &second_tty), Ok(Selected::Done));
        assert_eq!(tabs.selected_tty(T), Ok(Some(second_tty)));

        assert_eq!(front_bundle(), front, "Terminal came forward");
    }
}
