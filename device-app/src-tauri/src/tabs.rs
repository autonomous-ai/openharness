//! The tabs of Terminal, iTerm2 and Ghostty, for the dial to follow: the lines the watch reads and writes, the tty
//! check, when to ask an app for its selected tab, and the spoken words waiting to be typed. A tty is private like the
//! app in front: it goes on the watch's stdin and into a fixed script's parameter, never into the log, an Event or the
//! state file. A spoken text is as private as a tty; it goes to a fixed handler's parameter and nowhere else.

use serde_json::Value;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How often the selected tab is asked for while a tab app is in front: no app pushes a change of tab.
pub const POLL_EVERY: Duration = Duration::from_millis(500);
/// Each Apple Event's timeout. Only macOS's consent prompt holds a call longer, so a select that waited longer is for
/// where the dial rested back then.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a typing may wait for the tab thread. The devices checked the agent at its prompt just before sending it:
/// one held longer, behind macOS's consent prompt, would type on checks that may no longer hold.
pub const LATE_WRITE: Duration = Duration::from_millis(500);
/// The longest spoken text, in UTF-16 units as the CLI counts it: a count of chars would refuse texts it sent.
pub const MAX_TEXT: usize = 20_000;
/// The typings that may wait for the tab thread; the devices wait on each one's answer, so one more is answered no.
pub const TYPING_QUEUED: usize = 8;

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

/// A watch's `{"write":{…}}` or `{"enter":{…}}` line: spoken words for the one session of a tty, or the Enter after
/// them, each answered by its id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Typing {
    Write { id: String, app: TabApp, tty: String, text: String },
    Enter { id: String, app: TabApp, tty: String },
}

impl Typing {
    pub fn id(&self) -> &str {
        match self {
            Typing::Write { id, .. } | Typing::Enter { id, .. } => id,
        }
    }

    pub fn app(&self) -> TabApp {
        match self {
            Typing::Write { app, .. } | Typing::Enter { app, .. } => *app,
        }
    }

    pub fn tty(&self) -> &str {
        match self {
            Typing::Write { tty, .. } | Typing::Enter { tty, .. } => tty,
        }
    }

    /// The word the log says.
    fn kind(&self) -> &'static str {
        match self {
            Typing::Write { .. } => "write",
            Typing::Enter { .. } => "enter",
        }
    }
}

/// The typing of a watch's line, checked again as the devices and the watch checked it, since its text goes into a
/// terminal: exactly the keys of a write or an Enter, an app with a write handler, a tty that passes `tty_ok`, an id
/// of 16 lowercase hex, and a text of 1 to MAX_TEXT UTF-16 units with no control character.
pub fn typing_of(line: &str) -> Option<Typing> {
    let line: serde_json::Map<String, Value> = serde_json::from_str(line).ok()?;
    let mut line = line.into_iter();
    let Some((kind, Value::Object(fields))) = line.next() else {
        return None;
    };
    if line.next().is_some() {
        return None;
    }
    let string = |key: &str| fields.get(key).and_then(Value::as_str);
    let id = string("id")
        .filter(|id| id.len() == 16 && id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))?
        .to_string();
    // Terminal has no write handler: `do script`, its only way to put text in a tab, runs the text as a command.
    let app = string("app").and_then(TabApp::from_id).filter(|app| *app != TabApp::Terminal)?;
    let tty = string("tty").filter(|tty| tty_ok(tty))?.to_string();
    match (kind.as_str(), fields.len()) {
        ("write", 4) => {
            let text = string("text").filter(|text| text_ok(text))?.to_string();
            Some(Typing::Write { id, app, tty, text })
        }
        ("enter", 3) => Some(Typing::Enter { id, app, tty }),
        _ => None,
    }
}

/// The devices turned every control character into a space, so one here was never theirs, and a newline would submit
/// the words before the Enter's checks ran.
fn text_ok(text: &str) -> bool {
    !text.is_empty() && text.encode_utf16().count() <= MAX_TEXT && !text.chars().any(char::is_control)
}

/// `{"wrote":{"id":"…","ok":…}}` for the watch's stdin: the answer to the typing of that id.
pub fn wrote_line(id: &str, ok: bool) -> String {
    serde_json::json!({ "wrote": { "id": id, "ok": ok } }).to_string()
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Written {
    Done,
    /// No session of the app holds the tty, or more than one does: it is not the agent's pane.
    NoSession,
}

/// The fixed scripts. A tty passed in has passed `tty_ok`, and a text `typing_of`'s check.
pub trait TabScripts: Send + Sync {
    /// Whether the app runs: an Apple Event to one that does not would launch it.
    fn running(&self, app: TabApp) -> bool;
    /// The tty of the front window's selected tab; None with no visible window.
    fn selected_tty(&self, app: TabApp) -> Result<Option<String>, TabError>;
    /// A swipe's select. `frontmost` lets it raise the window, and lets Ghostty select at all.
    fn select_tty(&self, app: TabApp, tty: &str, frontmost: bool) -> Result<Selected, TabError>;
    /// A tap's select: `open -b` is bringing the app forward, so the window is always raised.
    fn focus_tty(&self, app: TabApp, tty: &str) -> Result<Selected, TabError>;
    /// Spoken words, typed into the one session of the tty with no newline. An app with no write handler (Terminal,
    /// every app off macOS) writes nothing.
    fn write_text(&self, _app: TabApp, _tty: &str, _text: &str) -> Result<Written, TabError> {
        Ok(Written::NoSession)
    }
    /// The Enter after the words, to the one session of the tty.
    fn send_enter(&self, _app: TabApp, _tty: &str) -> Result<Written, TabError> {
        Ok(Written::NoSession)
    }
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

/// The oldest typing, as the tab thread takes it.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    Run(Typing),
    /// Answered no unrun: the line for the watch and, for one that waited too long, a line for the log.
    Refused {
        line: String,
        log: Option<String>,
    },
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
    /// The apps whose poll or select answered without an error since Harness Device started. macOS has let them be
    /// scripted, so a write to one never brings its consent prompt, which would hold the tab thread for minutes.
    allowed: Vec<TabApp>,
    /// The typings in the order they came, each with when it came: unlike a select, every one is answered.
    typings: VecDeque<(Typing, Instant)>,
    /// The tty the watch was told last, for the app polled now.
    last: Option<(TabApp, String)>,
    /// The select to run next, and when it came.
    waiting: Option<(TabApp, String, bool, Instant)>,
    failed: u64,
    /// When the first failure not yet in the log came.
    failed_since: Option<u64>,
    /// Lines for the log that no answer carries, for the runner to take.
    said: Vec<String>,
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
        // Their answers would go to a watch that is gone.
        self.typings.clear();
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
        if answer.is_ok() {
            self.allow(app);
        }
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
        // A call under way as polling stopped is counted as it answers.
        if self.polls().is_none() || self.failed_since.is_some_and(|since| now.saturating_sub(since) >= FAILED_EVERY) {
            out.log.extend(self.failed_line());
        }
        out
    }

    /// The lines for the log that came with no answer.
    pub fn said(&mut self) -> Vec<String> {
        std::mem::take(&mut self.said)
    }

    /// The failed polls not yet in the log, as one line.
    fn failed_line(&mut self) -> Option<String> {
        self.failed_since.take()?;
        Some(format!("tabs: {} polls failed", std::mem::take(&mut self.failed)))
    }

    /// A select from the watch, which came `at`. It replaces any still waiting: only where the dial rests now matters.
    pub fn select(&mut self, app: TabApp, tty: String, raise: bool, at: Instant) {
        if !self.off.contains(&app) {
            self.waiting = Some((app, tty, raise, at));
        }
    }

    /// The waiting select, taken `now`, unless it waited past CALL_TIMEOUT or is a swipe's for a Ghostty in the back:
    /// Ghostty's `select tab` may bring it forward, and its script would select nothing.
    pub fn next_select(&mut self, now: Instant) -> Option<Select> {
        let (app, tty, raise, at) = self.waiting.take()?;
        let frontmost = self.front == Some(app);
        let runs = raise || frontmost || app != TabApp::Ghostty;
        (runs && now.saturating_duration_since(at) <= CALL_TIMEOUT).then_some(Select { app, tty, frontmost, raise })
    }

    /// A `select_tty` or `focus_tty` answer.
    pub fn selected(&mut self, app: TabApp, done: Result<Selected, TabError>) -> Out {
        let mut out = Out::default();
        if done.is_ok() {
            self.allow(app);
        }
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

    fn allow(&mut self, app: TabApp) {
        if !self.allowed.contains(&app) {
            self.allowed.push(app);
        }
    }

    /// A typing from the watch, which came `at`. With its app off or TYPING_QUEUED already waiting, it is answered no at
    /// once: the line for the watch.
    pub fn typed(&mut self, typing: Typing, at: Instant) -> Option<String> {
        if self.off.contains(&typing.app()) || self.typings.len() >= TYPING_QUEUED {
            return Some(wrote_line(typing.id(), false));
        }
        self.typings.push_back((typing, at));
        None
    }

    /// The oldest typing, taken `now`. It is answered no unrun when it waited past LATE_WRITE, with a line for the log,
    /// or when its app is off or has not been allowed yet.
    pub fn next_typing(&mut self, now: Instant) -> Option<Next> {
        let (typing, at) = self.typings.pop_front()?;
        let app = typing.app();
        let log = if now.saturating_duration_since(at) > LATE_WRITE {
            Some(format!("tabs: {} {} dropped late", app.name(), typing.kind()))
        } else if self.off.contains(&app) || !self.allowed.contains(&app) {
            None
        } else {
            return Some(Next::Run(typing));
        };
        Some(Next::Refused { line: wrote_line(typing.id(), false), log })
    }

    /// A `write_text` or `send_enter` answer: ok only when it wrote.
    pub fn written(&mut self, typing: &Typing, done: Result<Written, TabError>) -> Out {
        let mut out = Out { line: Some(wrote_line(typing.id(), done == Ok(Written::Done))), log: Vec::new() };
        if let Err(error @ (TabError::Denied | TabError::NoTty | TabError::NoScripting)) = done {
            self.turn_off(typing.app(), error, &mut out.log);
        }
        out
    }

    /// Says why once: a call already running when the app was turned off may answer the same.
    fn turn_off(&mut self, app: TabApp, error: TabError, log: &mut Vec<String>) {
        if self.off.contains(&app) {
            return;
        }
        self.off.push(app);
        if self.waiting.as_ref().is_some_and(|(waiting, ..)| *waiting == app) {
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
        let polls = self.polls();
        if self.last.as_ref().map(|(app, _)| *app) != polls {
            self.last = None;
        }
        // No answer comes while polling is off, maybe for hours: the count does not wait for one.
        if polls.is_none() {
            let line = self.failed_line();
            self.said.extend(line);
        }
    }
}

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

    const I: TabApp = TabApp::Iterm;
    const G: TabApp = TabApp::Ghostty;
    const ID: &str = "0123456789abcdef";
    const ENTER_ID: &str = "fedcba9876543210";

    fn write(app: TabApp, id: &str, text: &str) -> Typing {
        Typing::Write { id: id.into(), app, tty: TTY.into(), text: text.into() }
    }

    fn enter(app: TabApp, id: &str) -> Typing {
        Typing::Enter { id: id.into(), app, tty: TTY.into() }
    }

    fn write_line(app: &str, tty: &str, id: &str, text: &str) -> String {
        serde_json::json!({ "write": { "id": id, "app": app, "tty": tty, "text": text } }).to_string()
    }

    fn enter_line(app: &str, tty: &str, id: &str) -> String {
        serde_json::json!({ "enter": { "id": id, "app": app, "tty": tty } }).to_string()
    }

    fn refused(id: &str) -> Option<Next> {
        Some(Next::Refused { line: wrote_line(id, false), log: None })
    }

    /// iTerm2 in front, and both apps that take a typing answered once without an error.
    fn writing() -> TabFollow {
        let mut follow = polling();
        follow.front(I.bundle());
        follow.polled(I, Ok(None), 0);
        follow.selected(G, Ok(Selected::NoTab));
        follow
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
    fn a_write_line_is_read_only_when_its_app_tty_id_and_text_pass() {
        assert_eq!(
            typing_of(r#"{"write":{"id":"0123456789abcdef","app":"iterm","tty":"/dev/ttys023","text":"hi"}}"#),
            Some(write(I, ID, "hi"))
        );
        let typing = typing_of(&write_line("ghostty", "/dev/ttys0", ENTER_ID, "hi there")).unwrap();
        assert_eq!(
            typing,
            Typing::Write { id: ENTER_ID.into(), app: G, tty: "/dev/ttys0".into(), text: "hi there".into() }
        );
        assert_eq!((typing.id(), typing.app(), typing.tty()), (ENTER_ID, G, "/dev/ttys0"));
        let write_with = |key: &str, value: Value| {
            let mut line = serde_json::json!({ "write": { "id": ID, "app": "iterm", "tty": TTY, "text": "hi" } });
            line["write"][key] = value;
            line.to_string()
        };
        for dropped in [
            write_line("orca", TTY, ID, "hi"),
            write_line("vscode", TTY, ID, "hi"),
            write_line("com.googlecode.iterm2", TTY, ID, "hi"),
            write_line("iTerm2", TTY, ID, "hi"),
            write_line("iterm", "/dev/ttys12345", ID, "hi"),
            write_line("iterm", "/dev/pts/1", ID, "hi"),
            write_line("iterm", "/dev/ttys023; rm", ID, "hi"),
            // Ids of 15 and 17 hex, upper case, and a letter past f.
            write_line("iterm", TTY, "0123456789abcde", "hi"),
            write_line("iterm", TTY, "0123456789abcdef0", "hi"),
            write_line("iterm", TTY, "0123456789ABCDEF", "hi"),
            write_line("iterm", TTY, "0123456789abcdeg", "hi"),
            write_line("iterm", TTY, ID, ""),
            write_with("text", Value::from(7)),
            write_with("text", Value::Null),
            write_with("id", Value::from(7)),
            write_with("raise", Value::from(true)),
            r#"{"write":{"id":"0123456789abcdef","app":"iterm","tty":"/dev/ttys023"}}"#.into(),
            r#"{"write":{"id":"0123456789abcdef","app":"iterm","tty":"/dev/ttys023","text":"hi"},"x":1}"#.into(),
            r#"{"write":"hi"}"#.into(),
            "not json".into(),
            "".into(),
        ] {
            assert_eq!(typing_of(&dropped), None, "{dropped}");
        }
    }

    #[test]
    fn terminal_never_takes_a_write() {
        // Terminal's only way to put words in a tab would run them as a command.
        assert_eq!(typing_of(&write_line("terminal-app", TTY, ID, "hi")), None);
        assert_eq!(typing_of(&enter_line("terminal-app", TTY, ID)), None);
        assert_eq!(typing_of(&write_line("iterm", TTY, ID, "hi")), Some(write(I, ID, "hi")));
        assert_eq!(typing_of(&enter_line("iterm", TTY, ID)), Some(enter(I, ID)));
    }

    #[test]
    fn an_enter_line_has_no_text() {
        let typing = typing_of(r#"{"enter":{"id":"fedcba9876543210","app":"ghostty","tty":"/dev/ttys023"}}"#);
        assert_eq!(typing, Some(enter(G, ENTER_ID)));
        let typing = typing.unwrap();
        assert_eq!((typing.id(), typing.app(), typing.tty()), (ENTER_ID, G, TTY));
        for dropped in [
            r#"{"enter":{"id":"fedcba9876543210","app":"ghostty","tty":"/dev/ttys023","text":"hi"}}"#,
            r#"{"enter":{"id":"fedcba9876543210","app":"ghostty","tty":"/dev/ttys023","text":""}}"#,
            r#"{"enter":{"app":"ghostty","tty":"/dev/ttys023"}}"#,
            r#"{"enter":{"id":"fedcba9876543210","tty":"/dev/ttys023"}}"#,
            r#"{"enter":{"id":"fedcba9876543210","app":"ghostty"}}"#,
            r#"{"enter":{"id":"FEDCBA9876543210","app":"ghostty","tty":"/dev/ttys023"}}"#,
            r#"{"enter":{"id":"fedcba9876543210","app":"ghostty","tty":"/dev/pts/1"}}"#,
            r#"{"enter":true}"#,
        ] {
            assert_eq!(typing_of(dropped), None, "{dropped}");
        }
    }

    #[test]
    fn a_line_with_another_key_is_dropped() {
        let write = r#"{"id":"0123456789abcdef","app":"iterm","tty":"/dev/ttys023","text":"hi"}"#;
        let enter = r#"{"id":"fedcba9876543210","app":"iterm","tty":"/dev/ttys023"}"#;
        for dropped in [
            format!(r#"{{"write":{write},"enter":{enter}}}"#),
            format!(r#"{{"Write":{write}}}"#),
            format!(r#"{{"select":{enter}}}"#),
            format!(r#"{{"tab":{enter}}}"#),
            r#"{"select":{"app":"iterm","tty":"/dev/ttys023"}}"#.into(),
            r#"{"wrote":{"id":"0123456789abcdef","ok":true}}"#.into(),
            r#"{"attached":true,"fw":"0.1.0","hw":"round"}"#.into(),
            "{}".into(),
            "[]".into(),
        ] {
            assert_eq!(typing_of(&dropped), None, "{dropped}");
        }
    }

    #[test]
    fn the_longest_text_is_counted_in_utf16_units_as_the_cli_counts_it() {
        assert_eq!(MAX_TEXT, 20_000);
        for text in ["é".repeat(20_000), "😀".repeat(10_000), "中".repeat(20_000), "a".repeat(20_000)] {
            let line = write_line("iterm", TTY, ID, &text);
            // The longest line, with its newline, is one the watch's reader hands on.
            assert!(line.len() < crate::cli::LINE_MAX, "{}", line.len());
            assert_eq!(typing_of(&line), Some(write(I, ID, &text)));
        }
        // 20,001 units, and 10,001 emoji: 10,001 chars but 20,002 units.
        for text in ["é".repeat(20_001), format!("{}a", "😀".repeat(10_000)), "😀".repeat(10_001), "中".repeat(20_001)]
        {
            assert_eq!(typing_of(&write_line("iterm", TTY, ID, &text)), None);
        }
    }

    #[test]
    fn a_text_the_devices_cleaned_passes_and_a_control_character_does_not() {
        for text in ["a\u{2028}b", "a\u{a0}b", "a\u{fffd}b", "emoji 😀 and 中文"] {
            assert_eq!(typing_of(&write_line("iterm", TTY, ID, text)), Some(write(I, ID, text)), "{text:?}");
        }
        for text in ["a\nb", "a\rb", "a\tb", "a\u{7f}b", "a\u{85}b", "\u{1b}[0m", "a\u{0}b", "\n"] {
            assert_eq!(typing_of(&write_line("iterm", TTY, ID, text)), None, "{text:?}");
        }
    }

    #[test]
    fn the_wrote_line_is_one_short_line() {
        assert_eq!(wrote_line(ID, true), r#"{"wrote":{"id":"0123456789abcdef","ok":true}}"#);
        assert_eq!(wrote_line(ENTER_ID, false), r#"{"wrote":{"id":"fedcba9876543210","ok":false}}"#);
        for ok in [true, false] {
            // Under the 64 bytes the watch takes for a wrote tell.
            let line = wrote_line(ID, ok);
            assert!(line.len() < 64, "{line}");
            assert!(!line.contains(['\n', '\r']), "{line}");
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
    fn a_swipe_for_a_ghostty_in_the_back_is_dropped_and_a_tap_for_it_runs() {
        let now = Instant::now();
        let mut follow = polling();
        let ghostty = TabApp::Ghostty;
        // Its `select tab` may bring Ghostty forward: a swipe never selects a tab of a Ghostty in the back.
        follow.select(ghostty, TTY.into(), false, now);
        assert_eq!(follow.next_select(now), None);
        follow.select(ghostty, TTY.into(), true, now);
        assert_eq!(follow.next_select(now), select(ghostty, TTY, false, true));
        follow.front(ghostty.bundle());
        follow.select(ghostty, TTY.into(), false, now);
        assert_eq!(follow.next_select(now), select(ghostty, TTY, true, false));
        // Terminal and iTerm2 in the back select all the same.
        for app in [T, TabApp::Iterm] {
            follow.select(app, TTY.into(), false, now);
            assert_eq!(follow.next_select(now), select(app, TTY, false, false));
        }
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
        assert_eq!(
            follow.selected(TabApp::Ghostty, Err(TabError::NoScripting)).log,
            ["tabs: Ghostty has no scripting"]
        );
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
    fn the_failed_polls_are_counted_when_polling_stops() {
        // No answer comes while another app is in front, maybe for hours: the count does not wait for one.
        let mut follow = polling();
        assert!(follow.polled(T, Err(TabError::Failed), 100).log.is_empty());
        assert!(follow.polled(T, Err(TabError::Failed), 101).log.is_empty());
        assert!(follow.said().is_empty());
        follow.front(VS_CODE);
        assert_eq!(follow.said(), ["tabs: 2 polls failed"]);
        assert!(follow.said().is_empty());
        // A call under way as it stopped is counted as it answers.
        assert_eq!(follow.polled(T, Err(TabError::Failed), 102).log, ["tabs: 1 polls failed"]);
        // Each stop says it once, and a stop with no failure says nothing.
        let stops: [fn(&mut TabFollow); 3] =
            [|follow| follow.attached(false), |follow| follow.watching(false), |follow| follow.front(VS_CODE)];
        for stop in stops {
            let mut follow = polling();
            stop(&mut follow);
            assert!(follow.said().is_empty());
            let mut follow = polling();
            follow.polled(T, Err(TabError::Failed), 300);
            stop(&mut follow);
            assert_eq!(follow.said(), ["tabs: 1 polls failed"]);
            stop(&mut follow);
            assert!(follow.said().is_empty());
        }
        // Turned off, its own line comes with the answer and the count after it.
        let mut follow = polling();
        follow.polled(T, Err(TabError::Failed), 300);
        assert_eq!(follow.polled(T, Err(TabError::Denied), 301).log, ["tabs: Terminal not allowed"]);
        assert_eq!(follow.said(), ["tabs: 1 polls failed"]);
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
    fn a_typing_runs_only_for_an_app_whose_poll_or_select_answered() {
        let now = Instant::now();
        // Nothing of iTerm2 has answered yet: a write could wait on macOS's consent prompt.
        let mut follow = polling();
        follow.front(I.bundle());
        assert_eq!(follow.typed(write(I, ID, "hi"), now), None);
        assert_eq!(follow.next_typing(now), refused(ID));
        // A failed poll is no answer.
        follow.polled(I, Err(TabError::Failed), 0);
        follow.typed(write(I, ID, "hi"), now);
        assert_eq!(follow.next_typing(now), refused(ID));
        // A poll that answered, even with no window, is.
        follow.polled(I, Ok(None), 0);
        follow.typed(write(I, ID, "hi"), now);
        assert_eq!(follow.next_typing(now), Some(Next::Run(write(I, ID, "hi"))));
        // One app's answer is not another's.
        follow.typed(enter(G, ENTER_ID), now);
        assert_eq!(follow.next_typing(now), refused(ENTER_ID));
        // A select answers for its app too, unless it failed.
        follow.selected(G, Err(TabError::Failed));
        follow.typed(enter(G, ENTER_ID), now);
        assert_eq!(follow.next_typing(now), refused(ENTER_ID));
        follow.selected(G, Ok(Selected::NoTab));
        follow.typed(enter(G, ENTER_ID), now);
        assert_eq!(follow.next_typing(now), Some(Next::Run(enter(G, ENTER_ID))));
        // The consent is the app's, not the watch's: a new watch's typing runs.
        follow.watching(true);
        follow.typed(write(I, ID, "hi"), now);
        assert_eq!(follow.next_typing(now), Some(Next::Run(write(I, ID, "hi"))));
    }

    #[test]
    fn an_app_turned_off_answers_no() {
        let now = Instant::now();
        // Turned off while a typing waits: that one is answered no as its turn comes.
        let mut follow = writing();
        assert_eq!(follow.typed(write(I, ID, "hi"), now), None);
        follow.polled(I, Err(TabError::Denied), 1);
        assert_eq!(follow.next_typing(now), refused(ID));
        // Off, a new one is answered no at once, and none waits.
        assert_eq!(follow.typed(enter(I, ENTER_ID), now), Some(wrote_line(ENTER_ID, false)));
        assert_eq!(follow.next_typing(now), None);
        // The other app goes on.
        assert_eq!(follow.typed(write(G, ID, "hi"), now), None);
        assert_eq!(follow.next_typing(now), Some(Next::Run(write(G, ID, "hi"))));

        // A write's answer turns its app off as a poll's or a select's does, and says so once.
        for (error, said) in [
            (TabError::Denied, "tabs: iTerm2 not allowed"),
            (TabError::NoTty, "tabs: iTerm2 has no tty"),
            (TabError::NoScripting, "tabs: iTerm2 has no scripting"),
        ] {
            let mut follow = writing();
            let out = follow.written(&write(I, ID, "hi"), Err(error));
            assert_eq!((out.line, out.log), (Some(wrote_line(ID, false)), vec![said.to_string()]));
            assert_eq!(follow.polls(), None);
            assert_eq!(follow.typed(enter(I, ENTER_ID), now), Some(wrote_line(ENTER_ID, false)));
            assert!(follow.written(&enter(I, ENTER_ID), Err(error)).log.is_empty());
        }
        // A failed write leaves it on.
        let mut follow = writing();
        let out = follow.written(&write(I, ID, "hi"), Err(TabError::Failed));
        assert_eq!((out.line, out.log), (Some(wrote_line(ID, false)), vec![]));
        assert_eq!(follow.typed(enter(I, ENTER_ID), now), None);
        assert_eq!(follow.next_typing(now), Some(Next::Run(enter(I, ENTER_ID))));
    }

    #[test]
    fn a_typing_that_waited_past_500_ms_is_dropped_unrun_with_one_fixed_line() {
        assert_eq!(LATE_WRITE, Duration::from_millis(500));
        let came = Instant::now();
        let mut follow = writing();
        follow.typed(write(I, ID, "hi"), came);
        assert_eq!(follow.next_typing(came + LATE_WRITE), Some(Next::Run(write(I, ID, "hi"))));
        // Each one that waited longer, behind macOS's consent prompt for another app, is dropped with its own line.
        follow.typed(write(I, ID, "hi"), came);
        follow.typed(enter(G, ENTER_ID), came);
        let late = |line: &str, log: &str| Some(Next::Refused { line: line.into(), log: Some(log.into()) });
        assert_eq!(
            follow.next_typing(came + LATE_WRITE + Duration::from_millis(1)),
            late(&wrote_line(ID, false), "tabs: iTerm2 write dropped late")
        );
        assert_eq!(
            follow.next_typing(came + Duration::from_secs(60)),
            late(&wrote_line(ENTER_ID, false), "tabs: Ghostty enter dropped late")
        );
        assert_eq!(follow.next_typing(came + Duration::from_secs(60)), None);
        // One that came after them runs: only the prompt held the thread.
        let later = came + Duration::from_secs(60);
        follow.typed(enter(I, ENTER_ID), later);
        assert_eq!(follow.next_typing(later), Some(Next::Run(enter(I, ENTER_ID))));
    }

    #[test]
    fn typings_run_in_order_and_a_select_keeps_its_own_slot() {
        let now = Instant::now();
        let mut follow = writing();
        follow.typed(write(I, ID, "one"), now);
        follow.select(I, OTHER.into(), false, now);
        follow.typed(enter(I, ENTER_ID), now);
        // The newest select replaces the one waiting, and no typing.
        follow.select(I, TTY.into(), true, now);
        follow.typed(write(G, ENTER_ID, "two"), now);
        assert_eq!(follow.next_typing(now), Some(Next::Run(write(I, ID, "one"))));
        assert_eq!(follow.next_select(now), select(I, TTY, true, true));
        assert_eq!(follow.next_select(now), None);
        // Taking the select left the typings as they were.
        assert_eq!(follow.next_typing(now), Some(Next::Run(enter(I, ENTER_ID))));
        assert_eq!(follow.next_typing(now), Some(Next::Run(write(G, ENTER_ID, "two"))));
        assert_eq!(follow.next_typing(now), None);
    }

    #[test]
    fn a_full_queue_answers_no_at_once() {
        assert_eq!(TYPING_QUEUED, 8);
        let now = Instant::now();
        let mut follow = writing();
        let ids: Vec<String> = (0..10).map(|n| format!("{n:016x}")).collect();
        for id in &ids[..8] {
            assert_eq!(follow.typed(write(I, id, "hi"), now), None);
        }
        assert_eq!(follow.typed(write(I, &ids[8], "hi"), now), Some(wrote_line(&ids[8], false)));
        // One taken leaves room for one.
        assert_eq!(follow.next_typing(now), Some(Next::Run(write(I, &ids[0], "hi"))));
        assert_eq!(follow.typed(enter(I, &ids[9]), now), None);
        // The refused one never runs.
        for id in &ids[1..8] {
            assert_eq!(follow.next_typing(now), Some(Next::Run(write(I, id, "hi"))));
        }
        assert_eq!(follow.next_typing(now), Some(Next::Run(enter(I, &ids[9]))));
        assert_eq!(follow.next_typing(now), None);
    }

    #[test]
    fn a_new_watch_drops_the_typings_waiting() {
        let now = Instant::now();
        // Their answer would go to a watch that is gone.
        let mut follow = writing();
        follow.typed(write(I, ID, "hi"), now);
        follow.typed(enter(I, ENTER_ID), now);
        follow.watching(true);
        assert_eq!(follow.next_typing(now), None);
        follow.typed(write(I, ID, "hi"), now);
        follow.watching(false);
        assert_eq!(follow.next_typing(now), None);
        // The next watch's typings are queued afresh.
        follow.watching(true);
        follow.attached(true);
        follow.typed(write(I, ID, "hi"), now);
        assert_eq!(follow.next_typing(now), Some(Next::Run(write(I, ID, "hi"))));
    }

    #[test]
    fn a_stopped_watchs_typing_is_answered_no_and_never_runs() {
        let now = Instant::now();
        // A stopped watch's child may still print a line before it ends.
        let mut follow = writing();
        follow.watching(false);
        assert_eq!(follow.typed(write(I, ID, "hi"), now), Some(wrote_line(ID, false)));
        assert_eq!(follow.typed(enter(G, ENTER_ID), now), Some(wrote_line(ENTER_ID, false)));
        assert_eq!(follow.next_typing(now), None);
        // The next watch's typings run.
        follow.watching(true);
        assert_eq!(follow.typed(write(I, ID, "hi"), now), None);
        assert_eq!(follow.next_typing(now), Some(Next::Run(write(I, ID, "hi"))));
    }

    #[test]
    fn done_answers_ok_and_no_session_answers_no() {
        let mut follow = writing();
        for typing in [write(I, ID, "hi"), enter(G, ENTER_ID)] {
            let out = follow.written(&typing, Ok(Written::Done));
            assert_eq!((out.line, out.log), (Some(wrote_line(typing.id(), true)), vec![]));
            let out = follow.written(&typing, Ok(Written::NoSession));
            assert_eq!((out.line, out.log), (Some(wrote_line(typing.id(), false)), vec![]));
        }
        // No session of the tty leaves its app on.
        assert_eq!(follow.polls(), Some(I));
        assert_eq!(follow.typed(write(I, ID, "hi"), Instant::now()), None);
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
        // Nor the spoken words: each typing dropped late, and a write that turned its app off.
        let words = "the words spoken";
        let mut follow = writing();
        follow.typed(write(I, ID, words), now);
        follow.typed(enter(G, ENTER_ID), now);
        for _ in 0..2 {
            match follow.next_typing(now + Duration::from_secs(1)) {
                Some(Next::Refused { log: Some(log), .. }) => said.push(log),
                other => panic!("{other:?}"),
            }
        }
        for done in [Ok(Written::Done), Ok(Written::NoSession), Err(TabError::Failed), Err(TabError::Denied)] {
            said.extend(follow.written(&write(I, ID, words), done).log);
        }
        assert_eq!(said.len(), 9, "{said:?}");
        for line in said {
            assert!(!line.contains("ttys") && !line.contains("/dev") && !line.contains("words"), "{line}");
        }
    }

    #[test]
    fn no_tabs_runs_nothing() {
        for app in APPS {
            assert!(!NoTabs.running(app));
            assert_eq!(NoTabs.selected_tty(app), Ok(None));
            assert_eq!(NoTabs.select_tty(app, TTY, true), Ok(Selected::NoTab));
            assert_eq!(NoTabs.focus_tty(app, TTY), Ok(Selected::NoTab));
            // Scripts with no write handler write nothing.
            assert_eq!(NoTabs.write_text(app, TTY, "hi"), Ok(Written::NoSession));
            assert_eq!(NoTabs.send_enter(app, TTY), Ok(Written::NoSession));
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
