//! Following the thread opened in the ChatGPT app: when to observe its window, the line the watch reads, and when to
//! offer the Follow ChatGPT screen. The window's title is private like a tty: it goes on the watch's stdin and nowhere
//! else, never into the log, an Event, the state file or the window.

use crate::tabs::Out;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The ChatGPT app's bundle id, the CLI's too: the app that runs Codex threads.
pub const CHATGPT_BUNDLE: &str = "com.openai.codex";
/// The front value of the ChatGPT app on Windows: its program's file name, which Windows matches without case.
pub const CHATGPT_EXE: &str = "ChatGPT.exe";
/// The front value of the ChatGPT app on Linux: its program's name.
pub const CHATGPT_LINUX: &str = "ChatGPT";
/// Where the Linux app's `.deb` and `.rpm` both install its program.
pub const CHATGPT_PROGRAM: &str = "/usr/lib/chatgpt/ChatGPT";
/// The CLI keeps a title of up to 256 UTF-16 units (a JavaScript string's length): past it, the empty title, so the
/// two never disagree.
pub const TITLE_MAX: usize = 256;
/// The bytes of a line, the `\n` the watch's writer adds included: macOS's PIPE_BUF. The watch's stdin is non-blocking
/// and only a write this short goes whole, so a slow watch never sees a title torn.
pub const THREAD_LINE_MAX: usize = 512;
/// The Accessibility list can change just after macOS posts its notice: the permission is read once more this late.
pub const TRUST_AGAIN: Duration = Duration::from_secs(1);
/// System Settings' Accessibility list, the one argument `open` takes for it.
pub const AX_SETTINGS: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/// `{"thread":"…"}`, one line. No title, one past TITLE_MAX units, one with a control character (Unicode Cc, as the
/// CLI's rule) and one whose line would pass THREAD_LINE_MAX bytes are the empty title.
pub fn thread_line(title: Option<&str>) -> String {
    let kept = title.filter(|title| title.encode_utf16().count() <= TITLE_MAX && !title.chars().any(char::is_control));
    let line = serde_json::json!({ "thread": kept.unwrap_or_default() }).to_string();
    if line.len() < THREAD_LINE_MAX { line } else { serde_json::json!({ "thread": "" }).to_string() }
}

/// The CLI's rule: `ChatGPT.app` in `applications`, then in `home`'s Applications, whose bundle id is CHATGPT_BUNDLE.
pub fn chatgpt_installed(home: &Path, applications: &Path, bundle_id: &dyn Fn(&Path) -> Option<String>) -> bool {
    [applications.join("ChatGPT.app"), home.join("Applications").join("ChatGPT.app")]
        .iter()
        .any(|app| bundle_id(app).as_deref() == Some(CHATGPT_BUNDLE))
}

/// Whether the app in front is ChatGPT: its bundle id on macOS, its program's name on Windows and Linux. Another
/// program by that name is told apart by the door's observer, which checks the window's own process.
pub fn is_chatgpt_front(value: &str) -> bool {
    value == CHATGPT_BUNDLE || value.eq_ignore_ascii_case(CHATGPT_EXE) || value == CHATGPT_LINUX
}

/// A program is installed when its path is a regular file.
pub fn program_installed(program: &Path) -> bool {
    program.is_file()
}

/// Whether process `pid` runs `program`, by its `exe` link under `proc_root` (`/proc`).
pub fn runs_program(proc_root: &Path, pid: u32, program: &Path) -> bool {
    std::fs::read_link(proc_root.join(pid.to_string()).join("exe")).is_ok_and(|exe| exe == program)
}

/// Harness's own switch for following, off macOS, where no permission gates reading a window's title: what every
/// door there answers `trusted()` with.
pub struct FollowSwitch {
    on: AtomicBool,
    changed: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl FollowSwitch {
    pub fn new(on: bool) -> Arc<FollowSwitch> {
        Arc::new(FollowSwitch { on: AtomicBool::new(on), changed: Mutex::default() })
    }

    pub fn on(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }

    /// Tells the listener only of a change: the rules read `trusted()` again at each call.
    pub fn set(&self, on: bool) {
        if self.on.swap(on, Ordering::SeqCst) == on {
            return;
        }
        // Called with no lock held: the listener reads the switch.
        let changed = self.changed.lock().unwrap().clone();
        if let Some(changed) = changed {
            changed();
        }
    }

    pub fn start(&self, changed: Box<dyn Fn() + Send + Sync>) {
        *self.changed.lock().unwrap() = Some(Arc::from(changed));
    }
}

/// What an observation hears.
#[derive(Debug, Clone, PartialEq)]
pub enum Heard {
    /// The focused window's title; None with no focused window.
    Title(Option<String>),
    /// The observer could not be made: nothing follows until the next start.
    NoObserver,
}

/// The ChatGPT app's window. The app pushes each change: nothing polls.
pub trait ChatgptWindow: Send + Sync {
    /// Whether the ChatGPT app is installed.
    fn installed(&self) -> bool;
    /// None when the app in front is not ChatGPT. Otherwise the observation, which stops when dropped: `heard` gets
    /// the title now, once, then at each change, or NoObserver once.
    fn observe(&self, heard: Box<dyn Fn(Heard) + Send + Sync>) -> Option<Box<dyn Send>>;
}

/// Whether Harness may use Accessibility.
pub trait AxTrust: Send + Sync {
    fn trusted(&self) -> bool;
    /// macOS's own prompt.
    fn prompt(&self);
    /// `changed` is called each time the permission may have changed.
    fn start(&self, changed: Box<dyn Fn() + Send + Sync>);
    /// Off macOS, Harness's own switch stands for the permission: the person turns following on or off.
    fn switch(&self, _on: bool) {}
}

pub trait FollowDoor: ChatgptWindow + AxTrust {}

impl<T: ChatgptWindow + AxTrust> FollowDoor for T {}

/// Reads nothing and asks nothing: a platform with no ChatGPT app to follow.
pub struct NoFollow;

impl ChatgptWindow for NoFollow {
    fn installed(&self) -> bool {
        false
    }

    fn observe(&self, _heard: Box<dyn Fn(Heard) + Send + Sync>) -> Option<Box<dyn Send>> {
        None
    }
}

impl AxTrust for NoFollow {
    fn trusted(&self) -> bool {
        false
    }

    fn prompt(&self) {}

    fn start(&self, _changed: Box<dyn Fn() + Send + Sync>) {}
}

/// The door this platform has: only macOS has the ChatGPT app to follow.
pub fn system(#[cfg_attr(not(target_os = "macos"), expect(unused_variables))] home: PathBuf) -> Arc<dyn FollowDoor> {
    #[cfg(target_os = "macos")]
    let door = crate::follow_macos::MacFollow::new(home);
    #[cfg(not(target_os = "macos"))]
    let door = NoFollow;
    Arc::new(door)
}

/// What to do with the observation.
#[derive(Debug, PartialEq, Eq)]
pub enum Observer {
    /// Start one, numbered: a title heard by an earlier one is dropped.
    Start(u64),
    Stop,
    Same,
}

/// What the menu's item shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Shown {
    pub trusted: bool,
    pub installed: bool,
}

/// When to observe the ChatGPT window, what to tell the watch, and when to offer the Follow ChatGPT screen. It calls
/// no door: the runner does, and hands each answer here.
#[derive(Default)]
pub struct ChatgptFollow {
    chatgpt: bool,
    /// Whether the front source has told its first value: ChatGPT in front as the app starts is no offer.
    fronted: bool,
    watching: bool,
    attached: bool,
    trusted: bool,
    installed: bool,
    /// The number of the last start, and whether it observes now.
    start: u64,
    started: bool,
    /// The line written last in this start.
    last: Option<String>,
    /// Whether this start has said `chatgpt: no observer`.
    no_observer: bool,
    offer: bool,
    look: bool,
}

impl ChatgptFollow {
    /// The value the front source tells: on macOS the bundle id of the app in front.
    pub fn front(&mut self, bundle: &str) {
        let chatgpt = is_chatgpt_front(bundle);
        if self.fronted && chatgpt && !self.chatgpt {
            self.offer = self.watching && self.attached && self.installed && !self.trusted;
        }
        self.chatgpt = chatgpt;
        self.fronted = true;
    }

    /// A new watch has a dial of its own: it is detached until it says otherwise.
    pub fn watching(&mut self, on: bool) {
        self.watching = on;
        self.attached = false;
    }

    pub fn attached(&mut self, on: bool) {
        // Each status says attached: only a new attach looks for the app again, which may have come or gone since.
        self.look |= on && !self.attached;
        self.attached = on;
    }

    pub fn trusted(&mut self, on: bool) {
        self.trusted = on;
    }

    pub fn installed(&mut self, on: bool) {
        self.installed = on;
    }

    pub fn observes(&self) -> bool {
        self.chatgpt && self.watching && self.attached && self.trusted
    }

    pub fn observer(&mut self) -> Observer {
        match (self.observes(), self.started) {
            (true, false) => {
                self.start += 1;
                self.started = true;
                // Each start writes its first title: the dial may have moved since that thread was written.
                self.last = None;
                self.no_observer = false;
                Observer::Start(self.start)
            }
            (false, true) => {
                self.started = false;
                Observer::Stop
            }
            _ => Observer::Same,
        }
    }

    /// What the observation numbered `start` heard. One stopped may still hear a title, after the next one started:
    /// it is dropped.
    pub fn heard(&mut self, start: u64, heard: Heard) -> Out {
        let mut out = Out::default();
        if !self.started || start != self.start {
            return out;
        }
        match heard {
            Heard::Title(title) => {
                let line = thread_line(title.as_deref());
                if self.last.as_ref() != Some(&line) {
                    self.last = Some(line.clone());
                    out.line = Some(line);
                }
            }
            Heard::NoObserver if !self.no_observer => {
                self.no_observer = true;
                out.log.push("chatgpt: no observer".into());
            }
            Heard::NoObserver => {}
        }
        out
    }

    /// Whether to offer the Follow ChatGPT screen, once for each time ChatGPT came to the front untrusted.
    pub fn take_offer(&mut self) -> bool {
        std::mem::take(&mut self.offer)
    }

    /// Whether to read again if ChatGPT is installed: once after each attach.
    pub fn take_look(&mut self) -> bool {
        std::mem::take(&mut self.look)
    }

    pub fn shown(&self) -> Shown {
        Shown { trusted: self.trusted, installed: self.installed }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    const VS_CODE: &str = "com.microsoft.VSCode";

    fn line(title: &str) -> String {
        json!({ "thread": title }).to_string()
    }

    /// ChatGPT in front, a watch running, the dial attached and Harness trusted, its first start taken.
    fn observing() -> (ChatgptFollow, u64) {
        let mut follow = ChatgptFollow::default();
        follow.front(CHATGPT_BUNDLE);
        follow.watching(true);
        follow.attached(true);
        follow.trusted(true);
        let Observer::Start(start) = follow.observer() else { panic!("no start") };
        (follow, start)
    }

    fn title(value: &str) -> Heard {
        Heard::Title(Some(value.into()))
    }

    /// Every log line of the runs below: none may hold a title.
    fn logs_hold_no_title(outs: &[Out]) {
        for out in outs {
            for said in &out.log {
                assert!(!said.contains("Fix login") && !said.contains("Plan the trip"), "{said}");
            }
        }
    }

    #[test]
    fn a_thread_line_is_the_title_or_the_empty_title() {
        assert_eq!(thread_line(Some("Fix login")), r#"{"thread":"Fix login"}"#);
        assert_eq!(thread_line(None), r#"{"thread":""}"#);
        // The CLI keeps 256 UTF-16 units, a JavaScript string's length.
        assert_eq!(thread_line(Some(&"a".repeat(256))), line(&"a".repeat(256)));
        assert_eq!(thread_line(Some(&"a".repeat(257))), line(""));
        // An astral character is two units and four bytes: 124 make 510 bytes with the `\n`, 125 pass 512.
        assert_eq!(thread_line(Some(&"\u{1f980}".repeat(124))), line(&"\u{1f980}".repeat(124)));
        assert_eq!(thread_line(Some(&"\u{1f980}".repeat(125))), line(""));
        assert_eq!(thread_line(Some(&"\u{1f980}".repeat(129))), line(""));
        // Three bytes and one unit each: 166 make exactly 512 bytes with the `\n`.
        assert_eq!(thread_line(Some(&"\u{4e00}".repeat(166))), line(&"\u{4e00}".repeat(166)));
        assert_eq!(thread_line(Some(&"\u{4e00}".repeat(167))), line(""));
        // A quote is escaped to two bytes.
        assert_eq!(thread_line(Some(&"\"".repeat(249))), line(&"\"".repeat(249)));
        assert_eq!(thread_line(Some(&"\"".repeat(250))), line(""));
        for control in ["a\nb", "a\u{7f}", "a\u{85}", "a\u{9f}", "\u{0}"] {
            assert_eq!(thread_line(Some(control)), line(""), "{control:?}");
        }
        for escaped in ["a\"b", "a\\b"] {
            assert_eq!(thread_line(Some(escaped)), line(escaped), "{escaped:?}");
        }
    }

    #[test]
    fn the_longest_thread_line_is_one_atomic_pipe_write() {
        // The watch's stdin is non-blocking, and macOS writes up to PIPE_BUF, 512 bytes, whole or not at all.
        for value in ["\u{4e00}", "\u{1f980}", "\"", "\\", "a"] {
            for count in 1..=300 {
                let written = thread_line(Some(&value.repeat(count)));
                // The watch's writer adds the `\n`.
                assert!(written.len() < THREAD_LINE_MAX, "{value:?} x{count}: {}", written.len());
                assert!(!written.contains(['\n', '\r']), "{written}");
            }
        }
    }

    #[test]
    fn it_observes_only_with_chatgpt_in_front_a_watch_the_dial_and_the_permission() {
        type Set = fn(&mut ChatgptFollow);
        let conditions: [Set; 4] = [
            |follow| follow.front(CHATGPT_BUNDLE),
            |follow| follow.watching(true),
            |follow| follow.attached(true),
            |follow| follow.trusted(true),
        ];
        for (alone, set) in conditions.iter().enumerate() {
            let mut follow = ChatgptFollow::default();
            set(&mut follow);
            assert!(!follow.observes(), "{alone} alone");
            assert!(matches!(follow.observer(), Observer::Same), "{alone} alone");
        }
        for missing in 0..4 {
            let mut follow = ChatgptFollow::default();
            // The watch comes before the dial: a new watch is detached.
            for (index, set) in conditions.iter().enumerate() {
                if index != missing {
                    set(&mut follow);
                }
            }
            assert!(!follow.observes(), "without {missing}");
            assert!(matches!(follow.observer(), Observer::Same), "without {missing}");
        }
        let mut follow = ChatgptFollow::default();
        for set in conditions {
            set(&mut follow);
        }
        assert!(follow.observes());
        assert!(matches!(follow.observer(), Observer::Start(_)));
        assert!(matches!(follow.observer(), Observer::Same));
    }

    #[test]
    fn a_front_change_a_detach_a_watch_ending_or_the_permission_going_stops_it() {
        type Set = fn(&mut ChatgptFollow);
        let stops: [Set; 5] = [
            |follow| follow.front(VS_CODE),
            |follow| follow.attached(false),
            |follow| follow.watching(false),
            // A new watch has a dial of its own, detached until it says otherwise.
            |follow| follow.watching(true),
            |follow| follow.trusted(false),
        ];
        let (mut follow, mut last) = observing();
        for (index, stop) in stops.into_iter().enumerate() {
            stop(&mut follow);
            assert!(!follow.observes(), "{index}");
            assert!(matches!(follow.observer(), Observer::Stop), "{index}");
            assert!(matches!(follow.observer(), Observer::Same), "{index}");
            follow.front(CHATGPT_BUNDLE);
            follow.watching(true);
            follow.attached(true);
            follow.trusted(true);
            let Observer::Start(start) = follow.observer() else { panic!("{index}: no start") };
            assert!(start > last, "{index}");
            last = start;
        }
    }

    #[test]
    fn each_start_writes_its_first_title_even_the_last_one_and_a_repeat_none() {
        let (mut follow, first) = observing();
        let mut outs = Vec::new();
        let mut heard = |follow: &mut ChatgptFollow, start, heard| {
            let out = follow.heard(start, heard);
            let written = out.line.clone();
            outs.push(out);
            written
        };
        assert_eq!(heard(&mut follow, first, title("Fix login")), Some(line("Fix login")));
        assert_eq!(heard(&mut follow, first, title("Fix login")), None);
        assert_eq!(heard(&mut follow, first, title("Plan the trip")), Some(line("Plan the trip")));
        // No focused window.
        assert_eq!(heard(&mut follow, first, Heard::Title(None)), Some(line("")));
        assert_eq!(heard(&mut follow, first, Heard::Title(None)), None);
        assert_eq!(heard(&mut follow, first, title("Fix login")), Some(line("Fix login")));
        // Back to ChatGPT on the same thread: the dial may have moved since, so the first title is written again.
        follow.front(VS_CODE);
        assert!(matches!(follow.observer(), Observer::Stop));
        follow.front(CHATGPT_BUNDLE);
        let Observer::Start(again) = follow.observer() else { panic!("no start") };
        assert_eq!(heard(&mut follow, again, title("Fix login")), Some(line("Fix login")));
        assert_eq!(heard(&mut follow, again, title("Fix login")), None);
        assert!(outs.iter().all(|out| out.log.is_empty()));
        logs_hold_no_title(&outs);
    }

    #[test]
    fn a_title_from_an_earlier_start_is_dropped() {
        let (mut follow, first) = observing();
        follow.front(VS_CODE);
        assert!(matches!(follow.observer(), Observer::Stop));
        // A title heard while nothing observes is dropped too.
        let stopped = follow.heard(first, title("Fix login"));
        assert_eq!((stopped.line, stopped.log.len()), (None, 0));
        follow.front(CHATGPT_BUNDLE);
        let Observer::Start(second) = follow.observer() else { panic!("no start") };
        let late = follow.heard(first, title("Plan the trip"));
        assert_eq!((late.line, late.log.len()), (None, 0));
        let late = follow.heard(first, Heard::NoObserver);
        assert_eq!((late.line, late.log.len()), (None, 0));
        assert_eq!(follow.heard(second, title("Fix login")).line, Some(line("Fix login")));
    }

    #[test]
    fn no_observer_is_one_log_line_a_start() {
        let (mut follow, first) = observing();
        let mut outs = vec![follow.heard(first, Heard::NoObserver)];
        assert_eq!(outs[0].log, ["chatgpt: no observer"]);
        assert_eq!(outs[0].line, None);
        outs.push(follow.heard(first, Heard::NoObserver));
        assert!(outs[1].log.is_empty());
        // ChatGPT coming to the front again tries again.
        follow.front(VS_CODE);
        assert!(matches!(follow.observer(), Observer::Stop));
        follow.front(CHATGPT_BUNDLE);
        let Observer::Start(second) = follow.observer() else { panic!("no start") };
        outs.push(follow.heard(second, Heard::NoObserver));
        assert_eq!(outs[2].log, ["chatgpt: no observer"]);
        logs_hold_no_title(&outs);
    }

    /// A watch running, the dial attached, ChatGPT installed, Harness not trusted, and `first` the front source's
    /// first value.
    fn offering(first: &str) -> ChatgptFollow {
        let mut follow = ChatgptFollow::default();
        follow.front(first);
        follow.watching(true);
        follow.attached(true);
        follow.installed(true);
        follow
    }

    #[test]
    fn the_offer_comes_when_chatgpt_comes_to_the_front_untrusted() {
        // ChatGPT in front as the app starts: never offered at start.
        let mut follow = offering(CHATGPT_BUNDLE);
        assert!(!follow.take_offer());
        follow.front(VS_CODE);
        assert!(!follow.take_offer());
        follow.front(CHATGPT_BUNDLE);
        assert!(follow.take_offer());
        assert!(!follow.take_offer());
        // No other app between: ChatGPT did not come to the front.
        follow.front(CHATGPT_BUNDLE);
        assert!(!follow.take_offer());

        type Set = fn(&mut ChatgptFollow);
        let nots: [Set; 4] = [
            |follow| follow.trusted(true),
            |follow| follow.installed(false),
            |follow| follow.watching(false),
            |follow| follow.attached(false),
        ];
        for (index, not) in nots.into_iter().enumerate() {
            let mut follow = offering(VS_CODE);
            not(&mut follow);
            follow.front(CHATGPT_BUNDLE);
            assert!(!follow.take_offer(), "{index}");
        }
    }

    #[test]
    fn chatgpt_exe_in_any_case_and_chatgpt_are_chatgpt_in_front_as_the_bundle_id_is() {
        for value in [CHATGPT_BUNDLE, "ChatGPT.exe", "chatgpt.EXE", "ChatGPT"] {
            let mut follow = offering(VS_CODE);
            follow.front(value);
            assert!(follow.take_offer(), "{value}");
            follow.trusted(true);
            assert!(follow.observes(), "{value}");
            assert!(matches!(follow.observer(), Observer::Start(_)), "{value}");
        }
        // Linux's program name is matched exactly, and a macOS bundle's file name is no front value.
        for value in ["chatgpt", "ChatGPT.app"] {
            let mut follow = offering(VS_CODE);
            follow.front(value);
            assert!(!follow.take_offer(), "{value}");
            follow.trusted(true);
            assert!(!follow.observes(), "{value}");
        }
    }

    #[test]
    fn a_program_is_installed_only_as_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("ChatGPT");
        std::fs::write(&program, "").unwrap();
        assert!(program_installed(&program));
        assert!(!program_installed(dir.path()));
        assert!(!program_installed(&dir.path().join("missing")));
    }

    #[cfg(unix)]
    #[test]
    fn a_process_runs_the_program_its_exe_links_to() {
        let proc_root = tempfile::tempdir().unwrap();
        let program = Path::new("/usr/lib/chatgpt/ChatGPT");
        let link = |pid: u32, to: &str| {
            std::fs::create_dir(proc_root.path().join(pid.to_string())).unwrap();
            std::os::unix::fs::symlink(to, proc_root.path().join(pid.to_string()).join("exe")).unwrap();
        };
        link(7, "/usr/lib/chatgpt/ChatGPT");
        link(8, "/usr/local/bin/ChatGPT");
        assert!(runs_program(proc_root.path(), 7, program));
        assert!(!runs_program(proc_root.path(), 8, program));
        assert!(!runs_program(proc_root.path(), 9, program));
    }

    #[test]
    fn the_switch_starts_as_given_and_tells_each_change_once() {
        assert!(FollowSwitch::new(true).on());
        assert!(!FollowSwitch::new(false).on());
        let switch = FollowSwitch::new(true);
        // Before start there is no one to tell.
        switch.set(false);
        assert!(!switch.on());
        switch.set(true);
        let told = Arc::new(Mutex::new(0));
        let count = told.clone();
        switch.start(Box::new(move || *count.lock().unwrap() += 1));
        switch.set(true);
        assert_eq!(*told.lock().unwrap(), 0);
        switch.set(false);
        assert!(!switch.on());
        assert_eq!(*told.lock().unwrap(), 1);
        switch.set(false);
        assert_eq!(*told.lock().unwrap(), 1);
        switch.set(true);
        assert!(switch.on());
        assert_eq!(*told.lock().unwrap(), 2);
    }

    #[test]
    fn installed_is_looked_for_once_each_attach() {
        let mut follow = ChatgptFollow::default();
        assert!(!follow.take_look());
        follow.watching(true);
        assert!(!follow.take_look());
        follow.attached(true);
        assert!(follow.take_look());
        assert!(!follow.take_look());
        // Each status the watch reports says attached again.
        follow.attached(true);
        assert!(!follow.take_look());
        follow.attached(false);
        assert!(!follow.take_look());
        follow.attached(true);
        assert!(follow.take_look());
        // A new watch's dial is a new attach.
        follow.watching(true);
        follow.attached(true);
        assert!(follow.take_look());
    }

    #[test]
    fn shown_is_the_permission_and_the_app_installed() {
        let mut follow = ChatgptFollow::default();
        assert_eq!(follow.shown(), Shown { trusted: false, installed: false });
        follow.trusted(true);
        assert_eq!(follow.shown(), Shown { trusted: true, installed: false });
        follow.installed(true);
        assert_eq!(follow.shown(), Shown { trusted: true, installed: true });
        follow.trusted(false);
        assert_eq!(follow.shown(), Shown { trusted: false, installed: true });
        assert_eq!(Shown::default(), Shown { trusted: false, installed: false });
    }

    #[test]
    fn installed_is_chatgpt_app_in_applications_or_the_home_applications_with_the_codex_bundle_id() {
        let home = Path::new("/Users/someone");
        let applications = Path::new("/Applications");
        let system = Path::new("/Applications/ChatGPT.app");
        let own = Path::new("/Users/someone/Applications/ChatGPT.app");
        let installed = |answers: &[(&Path, &str)]| {
            let asked = Mutex::new(Vec::new());
            let found = chatgpt_installed(home, applications, &|path: &Path| {
                asked.lock().unwrap().push(path.to_path_buf());
                answers.iter().find(|(at, _)| *at == path).map(|(_, id)| id.to_string())
            });
            (found, asked.into_inner().unwrap())
        };
        assert!(installed(&[(system, CHATGPT_BUNDLE)]).0);
        assert!(installed(&[(own, CHATGPT_BUNDLE)]).0);
        assert!(installed(&[(system, "com.openai.chat"), (own, CHATGPT_BUNDLE)]).0);
        assert!(!installed(&[(system, "com.openai.chat")]).0);
        assert!(!installed(&[(own, "com.openai.codex.helper")]).0);
        let (found, asked) = installed(&[]);
        assert!(!found);
        assert_eq!(asked, [system, own]);
    }

    #[test]
    fn the_door_is_the_oss_or_the_one_of_the_desktop_the_front_source_reads() {
        use crate::front::LinuxFront;
        assert_eq!(door_kind("macos", None), DoorKind::Mac);
        assert_eq!(door_kind("windows", None), DoorKind::Windows);
        assert_eq!(door_kind("linux", Some(LinuxFront::X11(":1".into()))), DoorKind::X11(":1".into()));
        assert_eq!(door_kind("linux", Some(LinuxFront::Sway)), DoorKind::Sway);
        assert_eq!(door_kind("linux", Some(LinuxFront::Hyprland)), DoorKind::Hyprland);
        assert_eq!(door_kind("linux", Some(LinuxFront::None)), DoorKind::None);
    }

    #[test]
    fn no_follow_reads_nothing_and_asks_nothing() {
        let heard = Arc::new(Mutex::new(0));
        let count = heard.clone();
        assert!(!NoFollow.installed());
        assert!(NoFollow.observe(Box::new(move |_| *count.lock().unwrap() += 1)).is_none());
        assert!(!NoFollow.trusted());
        NoFollow.prompt();
        let count = heard.clone();
        NoFollow.start(Box::new(move || *count.lock().unwrap() += 1));
        assert_eq!(*heard.lock().unwrap(), 0);
    }

    #[test]
    fn the_mac_door_reads_only_the_focused_windows_title_and_sets_nothing() {
        // Held on every platform, so Linux CI checks the macOS door too. Comment lines are cut: they may name what
        // the code must not do. A comment after code is kept, and a `//` in a string cuts nothing.
        let code = include_str!("follow_macos.rs")
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let found = |pattern: &str| -> std::collections::BTreeSet<&str> {
            let pattern = regex::Regex::new(pattern).unwrap();
            pattern.captures_iter(&code).map(|found| found.get(1).unwrap().as_str()).collect()
        };
        assert_eq!(
            found(r#""(AX[A-Za-z]*)""#),
            ["AXFocusedWindow", "AXFocusedWindowChanged", "AXTitle", "AXTitleChanged"].into()
        );
        // Every call that sets, acts, posts an event, reads or makes an element, by its binding's name or its C name:
        // only these. A set attribute (AXManualAccessibility makes ChatGPT build its whole tree), an action or a key
        // changes the app; another read reads more than the title. perform_block is the run loop's, not
        // Accessibility's: it queues the observer's stop.
        assert_eq!(
            found(r"\b(copy_\w+|set_\w+|perform_\w+|post_\w+|new_\w+|AXUIElement\w+|AXObserver\w+)\b"),
            ["copy_attribute_value", "new_application", "perform_block", "set_messaging_timeout"].into()
        );
        for never in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
            assert!(!code.contains(never), "{never}");
        }
        assert!(code.contains("com.apple.accessibility.api"));
    }

    #[test]
    fn no_line_or_log_holds_a_title() {
        let (mut follow, first) = observing();
        let mut outs = vec![
            follow.heard(first, title("Fix login")),
            follow.heard(first, Heard::NoObserver),
            follow.heard(first, title("Plan the trip")),
        ];
        follow.trusted(false);
        assert!(matches!(follow.observer(), Observer::Stop));
        outs.push(follow.heard(first, title("Fix login")));
        follow.trusted(true);
        let Observer::Start(second) = follow.observer() else { panic!("no start") };
        outs.push(follow.heard(second, Heard::NoObserver));
        outs.push(follow.heard(second, title("Fix login")));
        assert_eq!(outs.iter().map(|out| out.log.len()).sum::<usize>(), 2);
        logs_hold_no_title(&outs);
    }
}
