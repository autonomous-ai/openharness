//! The tabs of Terminal, iTerm2 and Ghostty, for the dial to follow: the lines the watch reads and writes, the tty
//! check, and when to ask an app for its selected tab. A tty is private like the app in front: it goes on the watch's
//! stdin and into a fixed script's parameter, never into the log, an Event or the state file.

use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// How often the selected tab is asked for while a tab app is in front: no app pushes a change of tab.
pub const POLL_EVERY: Duration = Duration::from_millis(500);
/// Each Apple Event's timeout. Only macOS's consent prompt holds a call longer.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(2);

/// The apps whose tabs the dial follows, from Harness Device's own table: nothing of the daemon names a bundle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabApp {
    Terminal,
    Iterm,
    Ghostty,
}

const TAB_APPS: [TabApp; 3] = [TabApp::Terminal, TabApp::Iterm, TabApp::Ghostty];

impl TabApp {
    /// The app id the daemon and the watch use.
    pub fn id(self) -> &'static str {
        match self {
            TabApp::Terminal => "terminal-app",
            TabApp::Iterm => "iterm",
            TabApp::Ghostty => "ghostty",
        }
    }

    pub fn bundle(self) -> &'static str {
        match self {
            TabApp::Terminal => "com.apple.Terminal",
            TabApp::Iterm => "com.googlecode.iterm2",
            TabApp::Ghostty => "com.mitchellh.ghostty",
        }
    }

    /// The name the log says.
    pub fn name(self) -> &'static str {
        match self {
            TabApp::Terminal => "Terminal",
            TabApp::Iterm => "iTerm2",
            TabApp::Ghostty => "Ghostty",
        }
    }

    pub fn from_id(id: &str) -> Option<TabApp> {
        TAB_APPS.into_iter().find(|app| app.id() == id)
    }

    pub fn from_bundle(bundle: &str) -> Option<TabApp> {
        TAB_APPS.into_iter().find(|app| app.bundle() == bundle)
    }
}

/// `/dev/ttys` and one to four ASCII digits: the only text that ever reaches a script, as a parameter.
pub fn tty_ok(tty: &str) -> bool {
    tty.strip_prefix("/dev/ttys")
        .is_some_and(|digits| (1..=4).contains(&digits.len()) && digits.bytes().all(|byte| byte.is_ascii_digit()))
}

/// `{"tab":{"app":"…","tty":"…"}}` for the watch's stdin, well under 140 bytes; None for a tty that fails the check.
pub fn tab_line(app: TabApp, tty: &str) -> Option<String> {
    tty_ok(tty).then(|| serde_json::json!({ "tab": { "app": app.id(), "tty": tty } }).to_string())
}

/// The app, tty and raise of a watch's `{"select":{…}}` line. A raise that is not a boolean drops the line: only a tap
/// sends `true`, and a value that is neither must not pick the handler.
pub fn select_of(line: &str) -> Option<(TabApp, String, bool)> {
    let line: Value = serde_json::from_str(line).ok()?;
    let select = line.get("select")?;
    let app = TabApp::from_id(select.get("app")?.as_str()?)?;
    let tty = select.get("tty")?.as_str()?;
    let raise = match select.get("raise") {
        None => false,
        Some(Value::Bool(raise)) => *raise,
        Some(_) => return None,
    };
    tty_ok(tty).then(|| (app, tty.to_string(), raise))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabError {
    /// The person said no to Automation for this app.
    Denied,
    /// The app's dictionary has no `tty` (a Ghostty older than its tty property).
    NoTty,
    /// The app's bundle declares no scripting at all (a Ghostty before 1.3): an event would bring macOS's consent
    /// prompt for nothing, then fail at every tick.
    NoScripting,
    /// The app quit, timed out, or anything else: the next call tries again.
    Failed,
}

/// The number Ghostty's script raises when reading a tty failed on a terminal that is still there. No such object
/// (-1728) or a failed handler (-10000) alone may mean the terminal closed between two events.
pub const NO_TTY: i64 = 1001;

/// An AppleScript error number as a TabError.
pub fn tab_error(code: i64) -> TabError {
    match code {
        // errAEEventNotPermitted.
        -1743 => TabError::Denied,
        NO_TTY => TabError::NoTty,
        _ => TabError::Failed,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Selected {
    Done,
    /// No tab of a visible window holds the tty.
    NoTab,
}

/// The fixed scripts. A tty passed in has passed `tty_ok`.
pub trait TabScripts: Send + Sync {
    /// Whether the app runs: an Apple Event to one that does not would launch it.
    fn running(&self, app: TabApp) -> bool;
    /// The tty of the front window's selected tab; None with no visible window.
    fn selected_tty(&self, app: TabApp) -> Result<Option<String>, TabError>;
    /// A swipe's select. `frontmost` lets it raise the window, and lets Ghostty select at all.
    fn select_tty(&self, app: TabApp, tty: &str, frontmost: bool) -> Result<Selected, TabError>;
    /// A tap's select: `open -b` is bringing the app forward, so the window is always raised.
    fn focus_tty(&self, app: TabApp, tty: &str) -> Result<Selected, TabError>;
}

/// Runs nothing: `running` is false, so no other call is made.
pub struct NoTabs;

impl TabScripts for NoTabs {
    fn running(&self, _app: TabApp) -> bool {
        false
    }

    fn selected_tty(&self, _app: TabApp) -> Result<Option<String>, TabError> {
        Ok(None)
    }

    fn select_tty(&self, _app: TabApp, _tty: &str, _frontmost: bool) -> Result<Selected, TabError> {
        Ok(Selected::NoTab)
    }

    fn focus_tty(&self, _app: TabApp, _tty: &str) -> Result<Selected, TabError> {
        Ok(Selected::NoTab)
    }
}

/// The scripts this platform has: only macOS has tab apps.
pub fn system() -> Arc<dyn TabScripts> {
    #[cfg(target_os = "macos")]
    let scripts = crate::tabs_macos::MacTabs::default();
    #[cfg(not(target_os = "macos"))]
    let scripts = NoTabs;
    Arc::new(scripts)
}

/// A select to run now.
#[derive(Debug, PartialEq, Eq)]
pub struct Select {
    pub app: TabApp,
    pub tty: String,
    /// Whether its app is in front as it is taken.
    pub frontmost: bool,
    /// A tap's: `focus_tty` runs instead of `select_tty`.
    pub raise: bool,
}

/// What a call's answer gives: a line for the watch, and lines for the log, none of which holds a tty.
#[derive(Debug, Default)]
pub struct Out {
    pub line: Option<String>,
    pub log: Vec<String>,
}

/// How often the failed polls are counted in the log, in seconds: a tick fails twice a second at most.
const FAILED_EVERY: u64 = 60;

/// When to ask for the selected tab, what to tell the watch, and the select waiting to run. It runs no script: the
/// runner makes each call, one at a time, and hands its answer here.
#[derive(Default)]
pub struct TabFollow {
    front: Option<TabApp>,
    watching: bool,
    attached: bool,
    /// Denied, with no tty or with no scripting, until Harness Device starts again: asking again would only fail again.
    off: Vec<TabApp>,
    /// The tty the watch was told last, for the app polled now.
    last: Option<(TabApp, String)>,
    waiting: Option<(TabApp, String, bool)>,
    failed: u64,
    /// When the first failure not yet in the log came.
    failed_since: Option<u64>,
}

impl TabFollow {
    /// The bundle id of the app in front; any other value is no tab app.
    pub fn front(&mut self, bundle: &str) {
        self.front = TabApp::from_bundle(bundle);
        self.restart();
    }

    /// A new watch has a dial of its own: it is detached until it says otherwise.
    pub fn watching(&mut self, on: bool) {
        self.watching = on;
        self.attached = false;
        self.restart();
    }

    pub fn attached(&mut self, on: bool) {
        self.attached = on;
        self.restart();
    }

    /// The app to ask for its selected tab now, if any.
    pub fn polls(&self) -> Option<TabApp> {
        let app = self.front?;
        (self.watching && self.attached && !self.off.contains(&app)).then_some(app)
    }

    /// A `selected_tty` answer, `now` in seconds.
    pub fn polled(&mut self, app: TabApp, answer: Result<Option<String>, TabError>, now: u64) -> Out {
        let mut out = Out::default();
        match answer {
            Ok(Some(tty)) if self.polls() == Some(app) && tty_ok(&tty) => {
                if self.last.as_ref().is_none_or(|(_, last)| *last != tty) {
                    out.line = tab_line(app, &tty);
                    self.last = Some((app, tty));
                }
            }
            Ok(_) => {}
            Err(TabError::Failed) => {
                self.failed += 1;
                self.failed_since.get_or_insert(now);
            }
            Err(error) => self.turn_off(app, error, &mut out.log),
        }
        if self.failed_since.is_some_and(|since| now.saturating_sub(since) >= FAILED_EVERY) {
            out.log.push(format!("tabs: {} polls failed", self.failed));
            self.failed = 0;
            self.failed_since = None;
        }
        out
    }

    /// A select from the watch. It replaces any still waiting: only where the dial rests now matters.
    pub fn select(&mut self, app: TabApp, tty: String, raise: bool) {
        if !self.off.contains(&app) {
            self.waiting = Some((app, tty, raise));
        }
    }

    pub fn next_select(&mut self) -> Option<Select> {
        let (app, tty, raise) = self.waiting.take()?;
        Some(Select { app, tty, frontmost: self.front == Some(app), raise })
    }

    /// A `select_tty` or `focus_tty` answer.
    pub fn selected(&mut self, app: TabApp, done: Result<Selected, TabError>) -> Out {
        let mut out = Out::default();
        let outcome = match done {
            Ok(Selected::Done) => "ok",
            Ok(Selected::NoTab) => "none",
            Err(TabError::Failed) => "failed",
            Err(error) => {
                self.turn_off(app, error, &mut out.log);
                return out;
            }
        };
        out.log.push(format!("tabs: {} select {outcome}", app.name()));
        out
    }

    /// How long the last call took. Only macOS's consent prompt holds one past CALL_TIMEOUT, and a select that came
    /// meanwhile is for where the dial rested minutes ago.
    pub fn waited(&mut self, call: Duration) {
        if call > CALL_TIMEOUT {
            self.waiting = None;
        }
    }

    /// Says why once: a call already running when the app was turned off may answer the same.
    fn turn_off(&mut self, app: TabApp, error: TabError, log: &mut Vec<String>) {
        if self.off.contains(&app) {
            return;
        }
        self.off.push(app);
        if self.waiting.as_ref().is_some_and(|(waiting, _, _)| *waiting == app) {
            self.waiting = None;
        }
        log.push(match error {
            TabError::NoTty => format!("tabs: {} has no tty", app.name()),
            TabError::NoScripting => format!("tabs: {} has no scripting", app.name()),
            _ => format!("tabs: {} not allowed", app.name()),
        });
        self.restart();
    }

    /// Each time polling turns to an app, its first answer is written: the watch may never have heard of that tab, or
    /// the dial may have moved since.
    fn restart(&mut self) {
        if self.last.as_ref().map(|(app, _)| *app) != self.polls() {
            self.last = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

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
        assert_eq!(
            select_of(r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023"}}"#),
            Some((T, TTY.into(), false))
        );
        assert_eq!(
            select_of(r#"{"select":{"app":"iterm","tty":"/dev/ttys0"}}"#),
            Some((TabApp::Iterm, "/dev/ttys0".into(), false))
        );
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
        assert_eq!(
            select_of(r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023"}}"#),
            Some((T, TTY.into(), false))
        );
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
        let now = Instant::now();
        let mut follow = polling();
        assert_eq!(follow.next_select(now), None);
        follow.select(T, TTY.into(), false, now);
        follow.select(TabApp::Iterm, OTHER.into(), false, now);
        assert_eq!(follow.next_select(now), select(TabApp::Iterm, OTHER, false, false));
        assert_eq!(follow.next_select(now), None);
        // Whether its app is in front is read when it is taken.
        follow.select(T, TTY.into(), false, now);
        assert_eq!(follow.next_select(now), select(T, TTY, true, false));
        follow.select(T, TTY.into(), false, now);
        follow.front(VS_CODE);
        assert_eq!(follow.next_select(now), select(T, TTY, false, false));
    }

    #[test]
    fn a_waiting_select_keeps_its_raise_and_a_newer_one_brings_its_own() {
        let now = Instant::now();
        let mut follow = polling();
        follow.select(T, TTY.into(), true, now);
        assert_eq!(follow.next_select(now), select(T, TTY, true, true));
        follow.select(T, TTY.into(), true, now);
        follow.select(T, OTHER.into(), false, now);
        assert_eq!(follow.next_select(now), select(T, OTHER, true, false));
        assert_eq!(follow.next_select(now), None);
        follow.select(T, OTHER.into(), false, now);
        follow.select(T, TTY.into(), true, now);
        assert_eq!(follow.next_select(now), select(T, TTY, true, true));
    }

    #[test]
    fn a_select_runs_unless_it_waited_past_the_call_timeout() {
        assert_eq!(CALL_TIMEOUT, Duration::from_secs(2));
        assert_eq!(POLL_EVERY, Duration::from_millis(500));
        let mut follow = polling();
        let came = Instant::now();
        // It came 50 ms before a call that timed out after 2 s ended: the call was slow, the select did not wait.
        follow.select(T, TTY.into(), false, came);
        assert_eq!(follow.next_select(came + Duration::from_millis(50)), select(T, TTY, true, false));
        follow.select(T, TTY.into(), false, came);
        assert_eq!(follow.next_select(came + CALL_TIMEOUT), select(T, TTY, true, false));
        // One that waited behind macOS's consent prompt is for where the dial rested back then.
        follow.select(T, TTY.into(), true, came);
        assert_eq!(follow.next_select(came + CALL_TIMEOUT + Duration::from_millis(1)), None);
        let later = came + Duration::from_secs(60);
        assert_eq!(follow.next_select(later), None);
        // A select that comes after it runs, and polling goes on: only the consent prompt held that call.
        follow.select(T, OTHER.into(), false, later);
        assert_eq!(follow.next_select(later), select(T, OTHER, true, false));
        assert_eq!(follow.polls(), Some(T));
        assert_eq!(follow.polled(T, tty(TTY), 0).line, tab_line(T, TTY));
    }

    #[test]
    fn denied_turns_that_app_off_and_says_so_once() {
        let now = Instant::now();
        let mut follow = polling();
        follow.select(T, TTY.into(), false, now);
        let out = follow.polled(T, Err(TabError::Denied), 0);
        assert_eq!((out.line, out.log), (None, vec!["tabs: Terminal not allowed".to_string()]));
        assert_eq!(follow.polls(), None);
        // The select that waited is dropped, and none waits for it again.
        assert_eq!(follow.next_select(now), None);
        follow.select(T, TTY.into(), true, now);
        assert_eq!(follow.next_select(now), None);
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
        follow.select(T, TTY.into(), false, now);
        assert_eq!(follow.next_select(now), None);
    }

    #[test]
    fn the_other_apps_go_on() {
        let now = Instant::now();
        let mut follow = polling();
        follow.polled(T, Err(TabError::Denied), 0);
        for app in [TabApp::Iterm, TabApp::Ghostty] {
            follow.front(app.bundle());
            assert_eq!(follow.polls(), Some(app));
            assert_eq!(follow.polled(app, tty(TTY), 0).line, tab_line(app, TTY));
            follow.select(app, OTHER.into(), false, now);
            assert_eq!(follow.next_select(now), select(app, OTHER, true, false));
        }
    }

    #[test]
    fn only_the_no_tty_number_says_an_app_has_no_tty() {
        assert_eq!(tab_error(NO_TTY), TabError::NoTty);
        assert_eq!(tab_error(-1743), TabError::Denied);
        // No such object (a tab that closed between two events), a handler that failed, the app quit or timed out,
        // or anything else: try again at the next tick.
        for code in [-1728, -10000, -600, -1712, -1, 0] {
            assert_eq!(tab_error(code), TabError::Failed, "{code}");
        }

        let mut follow = polling();
        follow.front(TabApp::Ghostty.bundle());
        // A Ghostty whose terminal closed as it was asked goes on.
        assert!(follow.polled(TabApp::Ghostty, Err(tab_error(-1728)), 0).log.is_empty());
        assert_eq!(follow.polls(), Some(TabApp::Ghostty));
        let out = follow.polled(TabApp::Ghostty, Err(tab_error(NO_TTY)), 0);
        assert_eq!(out.log, ["tabs: Ghostty has no tty"]);
        assert_eq!(follow.polls(), None);
        assert!(follow.polled(TabApp::Ghostty, Err(TabError::NoTty), 0).log.is_empty());
    }

    #[test]
    fn a_ghostty_with_no_scripting_is_turned_off_and_says_so_once() {
        let now = Instant::now();
        let mut follow = polling();
        follow.front(TabApp::Ghostty.bundle());
        follow.select(TabApp::Ghostty, TTY.into(), true, now);
        let out = follow.polled(TabApp::Ghostty, Err(TabError::NoScripting), 0);
        assert_eq!((out.line, out.log), (None, vec!["tabs: Ghostty has no scripting".to_string()]));
        assert_eq!(follow.polls(), None);
        assert_eq!(follow.next_select(now), None);
        follow.select(TabApp::Ghostty, TTY.into(), true, now);
        assert_eq!(follow.next_select(now), None);
        assert!(follow.selected(TabApp::Ghostty, Err(TabError::NoScripting)).log.is_empty());
        // A tap's select finds it out the same way.
        let mut follow = polling();
        assert_eq!(follow.selected(TabApp::Ghostty, Err(TabError::NoScripting)).log, ["tabs: Ghostty has no scripting"]);
        follow.front(TabApp::Ghostty.bundle());
        assert_eq!(follow.polls(), None);
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
        let now = Instant::now();
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
            follow.select(TabApp::Ghostty, TTY.into(), false, now);
            follow.next_select(now);
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

    /// macOS shows this sentence when it asks the person to let Harness Device control a terminal app.
    #[test]
    fn the_bundle_says_why_it_sends_apple_events() {
        // One line per tag, so the plist's indentation does not matter.
        let plist: String = include_str!("../Info.plist").lines().map(str::trim).collect();
        let entry = "<key>NSAppleEventsUsageDescription</key><string>Your dial follows your terminal tabs.</string>";
        assert!(plist.contains(entry), "{plist}");
    }

    /// A build signed with the hardened runtime sends no Apple Event without this entitlement: every app would answer
    /// "not allowed", with no prompt. Here, not in tabs_macos.rs, so it runs on Linux too.
    #[test]
    fn the_bundle_may_send_apple_events() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["bundle"]["macOS"]["entitlements"], "Entitlements.plist");
        let entitlements: String = include_str!("../Entitlements.plist").lines().map(str::trim).collect();
        assert!(
            entitlements.contains("<key>com.apple.security.automation.apple-events</key><true/>"),
            "{entitlements}"
        );
        // That key and no other.
        assert_eq!(entitlements.matches("<key>").count(), 1, "{entitlements}");
    }
}
