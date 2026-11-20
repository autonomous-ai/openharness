//! The ChatGPT follow on Hyprland: the event socket says the active window or its title changed, and the request
//! socket's `j/activewindow` gives its `title` and `pid`.

use crate::follow::{AxTrust, CHATGPT_PROGRAM, ChatgptWindow, FollowSwitch, Heard, program_installed, runs_program};
use crate::front_hyprland::{ANSWER_MAX, active_pid, active_window, ask, next_line, sockets};
use std::io::{self, BufReader, Read};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// The Hyprland door: its own connection to the event socket for each observation, and Harness's switch.
pub struct HyprlandFollow {
    switch: Arc<FollowSwitch>,
}

impl HyprlandFollow {
    pub fn new(switch: Arc<FollowSwitch>) -> HyprlandFollow {
        HyprlandFollow { switch }
    }
}

impl ChatgptWindow for HyprlandFollow {
    fn installed(&self) -> bool {
        program_installed(Path::new(CHATGPT_PROGRAM))
    }

    fn observe(&self, heard: Box<dyn Fn(Heard) + Send + Sync>) -> Option<Box<dyn Send>> {
        let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty()).map(PathBuf::from);
        let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").unwrap_or_default();
        // The window's own process: another program named ChatGPT in front is not followed.
        let chatgpt = |pid| runs_program(Path::new("/proc"), pid, Path::new(CHATGPT_PROGRAM));
        Some(observe_instance(runtime_dir.as_deref(), &signature, chatgpt, heard))
    }
}

impl AxTrust for HyprlandFollow {
    fn trusted(&self) -> bool {
        self.switch.on()
    }

    fn prompt(&self) {}

    /// Nothing to hear: the runner reads the switch back at each click.
    fn start(&self, _changed: Box<dyn Fn() + Send + Sync>) {}

    fn switch(&self, on: bool) {
        self.switch.set(on);
    }
}

/// An event line the door reads.
#[derive(Debug, PartialEq, Eq)]
pub enum HyprEvent {
    /// `activewindowv2`: the active window's address, None for no window.
    Active(Option<String>),
    /// `windowtitle` or `windowtitlev2`: the address of a window whose title changed.
    Title(String),
    Other,
}

/// The event `line` is. A title event's own title is outside text, never read: the title is asked for.
pub fn hypr_event(line: &str) -> HyprEvent {
    if let Some(window) = active_window(line) {
        return HyprEvent::Active((!window.is_empty()).then(|| window.to_string()));
    }
    let address = line.strip_prefix("windowtitle>>").or_else(|| {
        line.strip_prefix("windowtitlev2>>").and_then(|rest| rest.split_once(',')).map(|(address, _)| address)
    });
    match address {
        Some(address) if !address.is_empty() && address.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
            HyprEvent::Title(address.to_string())
        }
        _ => HyprEvent::Other,
    }
}

/// The active window's title in `j/activewindow`'s answer. None for `{}` (no window), no title string, or an answer
/// over ANSWER_MAX.
pub fn active_title(answer: &[u8]) -> Option<String> {
    if answer.len() > ANSWER_MAX {
        return None;
    }
    let answer: serde_json::Value = serde_json::from_slice(answer).ok()?;
    Some(answer.get("title")?.as_str()?.to_string())
}

/// Says the active window's title now, then at each change of the active window or of its title, until the events
/// end. A window whose process is not `chatgpt`, no window, or an ask that fails is the empty title. A title asked
/// for twice is said twice: the rules write a line only when it changed.
pub fn follow(
    events: impl Read,
    ask: &dyn Fn() -> io::Result<Vec<u8>>,
    chatgpt: &dyn Fn(u32) -> bool,
    heard: &dyn Fn(Heard),
) {
    let title = || {
        let answer = ask().ok()?;
        active_pid(&answer).filter(|&pid| chatgpt(pid)).and_then(|_| active_title(&answer))
    };
    heard(Heard::Title(title()));
    let mut events = BufReader::new(events);
    let mut line = Vec::new();
    // Known from the first `activewindowv2` on: Hyprland sends one again after each title change of the active window.
    let mut active: Option<String> = None;
    while let Ok(read) = next_line(&mut events, &mut line) {
        if !read {
            continue;
        }
        let Ok(line) = std::str::from_utf8(&line) else { continue };
        match hypr_event(line) {
            HyprEvent::Active(None) => {
                active = None;
                heard(Heard::Title(None));
            }
            HyprEvent::Active(window) => {
                active = window;
                heard(Heard::Title(title()));
            }
            HyprEvent::Title(window) if active.as_ref() == Some(&window) => heard(Heard::Title(title())),
            HyprEvent::Title(_) | HyprEvent::Other => {}
        }
    }
}

/// What an observation and its thread share: whether it was dropped, and once connected, the connection's other end.
#[derive(Default)]
struct Shared {
    stopped: bool,
    stream: Option<UnixStream>,
}

/// An observation: dropped, it shuts its connection down, which wakes its thread out of the read it waits in, or ends
/// a thread still connecting once it connects. Returns at once either way.
struct Observation(Arc<Mutex<Shared>>);

impl Drop for Observation {
    fn drop(&mut self) {
        let mut shared = self.0.lock().unwrap();
        shared.stopped = true;
        if let Some(stream) = &shared.stream {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

/// Keeps `ends` for the observation to shut down; false when it was already dropped.
fn kept(shared: &Mutex<Shared>, ends: UnixStream) -> bool {
    let mut shared = shared.lock().unwrap();
    if !shared.stopped {
        shared.stream = Some(ends);
    }
    !shared.stopped
}

/// Follows the Hyprland instance under `runtime_dir`. No socket there is NoObserver once.
fn observe_instance(
    runtime_dir: Option<&Path>,
    signature: &str,
    chatgpt: impl Fn(u32) -> bool + Send + 'static,
    heard: Box<dyn Fn(Heard) + Send + Sync>,
) -> Box<dyn Send> {
    let Some((events, requests)) = runtime_dir.and_then(|dir| sockets(dir, signature)) else {
        heard(Heard::NoObserver);
        return Box::new(());
    };
    observe_events(move || UnixStream::connect(events), requests, chatgpt, heard)
}

/// Follows the events `connect` makes, asking `requests` for the title, on a thread of its own. A failed connect, or no
/// thread, is NoObserver once.
fn observe_events(
    connect: impl FnOnce() -> io::Result<UnixStream> + Send + 'static,
    requests: PathBuf,
    chatgpt: impl Fn(u32) -> bool + Send + 'static,
    heard: Box<dyn Fn(Heard) + Send + Sync>,
) -> Box<dyn Send> {
    let shared = Arc::new(Mutex::new(Shared::default()));
    let held = shared.clone();
    let heard: Arc<dyn Fn(Heard) + Send + Sync> = Arc::from(heard);
    let told = heard.clone();
    // Connecting can wait on a stalled Hyprland: never on the runner's follow thread.
    let spawned = std::thread::Builder::new().name("chatgpt-observer".into()).spawn(move || {
        // The events are connected before the first ask, so a change between the two is not missed.
        let Ok((ends, events)) = connect().and_then(|events| Ok((events.try_clone()?, events))) else {
            return told(Heard::NoObserver);
        };
        if kept(&held, ends) {
            follow(events, &|| ask(&requests), &chatgpt, &*told);
        }
    });
    if spawned.is_err() {
        heard(Heard::NoObserver);
    }
    Box::new(Observation(shared))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::follow::{ChatgptFollow, FollowSwitch, Heard, Observer};
    use crate::front_hyprland::{ANSWER_MAX, LINE_MAX, sockets};
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::fs;
    use std::io::{self, Read, Write};
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    const CHATGPT: u32 = 4242;
    /// Long enough for a thread on a loaded machine; a pass never waits this long.
    const WAIT: Duration = Duration::from_secs(5);

    /// `j/activewindow`'s answer in Hyprland's own shape.
    fn answer(pid: u32, title: &str) -> Vec<u8> {
        format!(r#"{{"address":"0x55d1c0a0","pid":{pid},"class":"ChatGPT","title":"{title}"}}"#).into_bytes()
    }

    fn title(title: &str) -> Heard {
        Heard::Title(Some(title.into()))
    }

    /// What `follow` heard and how often it asked: each ask answered in turn from `answers`.
    fn run(events: &[u8], answers: Vec<io::Result<Vec<u8>>>) -> (Vec<Heard>, usize) {
        let answers = RefCell::new(VecDeque::from(answers));
        let asked = Cell::new(0);
        let heard = RefCell::new(Vec::new());
        let ask = || {
            asked.set(asked.get() + 1);
            answers.borrow_mut().pop_front().expect("an ask with no answer left")
        };
        follow(events, &ask, &|pid| pid == CHATGPT, &|value| heard.borrow_mut().push(value));
        (heard.into_inner(), asked.get())
    }

    #[test]
    fn the_first_title_is_one_ask_and_another_program_is_the_empty_title() {
        assert_eq!(run(b"", vec![Ok(answer(CHATGPT, "Fix the build"))]), (vec![title("Fix the build")], 1));
        // A program named ChatGPT that is not the app, or no window at all.
        assert_eq!(run(b"", vec![Ok(answer(4343, "~/secret"))]), (vec![Heard::Title(None)], 1));
        assert_eq!(run(b"", vec![Ok(b"{}".to_vec())]), (vec![Heard::Title(None)], 1));
    }

    #[test]
    fn each_activewindowv2_asks_and_says_the_title_only_of_chatgpt() {
        let events = b"activewindowv2>>55d1c0a0\nactivewindowv2>>66e2d1b1\nactivewindowv2>>55d1c0a0\n";
        let answers = vec![
            Ok(answer(CHATGPT, "A")),
            Ok(answer(CHATGPT, "B")),
            Ok(answer(4343, "~/secret")),
            Ok(answer(CHATGPT, "C")),
        ];
        let (heard, asked) = run(events, answers);
        assert_eq!((heard, asked), (vec![title("A"), title("B"), Heard::Title(None), title("C")], 4));
    }

    #[test]
    fn no_active_window_is_the_empty_title_with_no_ask() {
        let (heard, asked) = run(b"activewindowv2>>\nactivewindowv2>>,\n", vec![Ok(answer(CHATGPT, "A"))]);
        assert_eq!((heard, asked), (vec![title("A"), Heard::Title(None), Heard::Title(None)], 1));
    }

    #[test]
    fn a_title_event_asks_again_only_for_the_active_window() {
        // The v2 event's own title is outside text: never said, the ask's answer is.
        let events = concat!(
            "windowtitle>>55d1c0a0\n",
            "activewindowv2>>55d1c0a0\n",
            "windowtitle>>55d1c0a0\n",
            "windowtitlev2>>55d1c0a0,anything\n",
            "windowtitle>>66e2d1b1\n",
            "windowtitlev2>>66e2d1b1,a ChatGPT window behind\n",
            "activewindowv2>>\n",
            "windowtitle>>55d1c0a0\n",
        );
        let answers = (1..=4).map(|n| Ok(answer(CHATGPT, &format!("T{n}")))).collect();
        let (heard, asked) = run(events.as_bytes(), answers);
        assert_eq!(asked, 4);
        assert_eq!(heard, [title("T1"), title("T2"), title("T3"), title("T4"), Heard::Title(None)]);
    }

    #[test]
    fn the_same_title_asked_twice_is_written_once_by_the_rules() {
        // Hyprland tells a title change three times: windowtitle, windowtitlev2, and activewindowv2 again.
        let events = b"activewindowv2>>55d1c0a0\nwindowtitle>>55d1c0a0\nwindowtitlev2>>55d1c0a0,A\n";
        let (heard, asked) = run(events, (0..4).map(|_| Ok(answer(CHATGPT, "A"))).collect());
        assert_eq!((heard.len(), asked), (4, 4));
        let mut rules = ChatgptFollow::default();
        rules.front("ChatGPT");
        rules.watching(true);
        rules.attached(true);
        rules.trusted(true);
        assert_eq!(rules.observer(), Observer::Start(1));
        let lines: Vec<String> = heard.into_iter().filter_map(|heard| rules.heard(1, heard).line).collect();
        assert_eq!(lines, [r#"{"thread":"A"}"#]);
    }

    #[test]
    fn a_failed_ask_is_the_empty_title() {
        let refused = || Err(io::Error::from(io::ErrorKind::ConnectionRefused));
        let (heard, asked) = run(b"activewindowv2>>55d1c0a0\n", vec![refused(), refused()]);
        assert_eq!((heard, asked), (vec![Heard::Title(None), Heard::Title(None)], 2));
    }

    #[test]
    fn a_line_over_4096_bytes_is_skipped_and_the_next_one_read() {
        let line = |len: usize| {
            let start = "windowtitlev2>>55d1c0a0,";
            format!("{start}{}\n", "a".repeat(len - start.len()))
        };
        // One byte over the cap, then one exactly at it.
        let events = format!("activewindowv2>>55d1c0a0\n{}{}", line(LINE_MAX + 1), line(LINE_MAX));
        let answers = (0..3).map(|_| Ok(answer(CHATGPT, "A"))).collect();
        assert_eq!(run(events.as_bytes(), answers).1, 3);
    }

    #[test]
    fn an_answer_over_64_kib_is_no_title() {
        let padded = |len: usize| {
            let base = answer(CHATGPT, "").len();
            answer(CHATGPT, &"a".repeat(len - base))
        };
        assert_eq!(padded(ANSWER_MAX).len(), ANSWER_MAX);
        assert_eq!(active_title(&padded(ANSWER_MAX)), Some("a".repeat(ANSWER_MAX - answer(CHATGPT, "").len())));
        assert_eq!(active_title(&padded(ANSWER_MAX + 1)), None);
        let (heard, _) = run(b"", vec![Ok(padded(ANSWER_MAX + 1))]);
        assert_eq!(heard, [Heard::Title(None)]);
    }

    #[test]
    fn the_title_is_the_answers_title_string() {
        assert_eq!(active_title(&answer(CHATGPT, "Fix the build")), Some("Fix the build".into()));
        assert_eq!(active_title(r#"{"pid":4242,"title":"été"}"#.as_bytes()), Some("été".into()));
        assert_eq!(active_title(b"{}"), None);
        assert_eq!(active_title(br#"{"title":7}"#), None);
        assert_eq!(active_title(b"no json"), None);
    }

    #[test]
    fn the_events_read_are_the_active_window_and_its_title() {
        assert_eq!(hypr_event("activewindowv2>>55d1c0a0"), HyprEvent::Active(Some("55d1c0a0".into())));
        assert_eq!(hypr_event("activewindowv2>>"), HyprEvent::Active(None));
        assert_eq!(hypr_event("activewindowv2>>0x55d1c0a0"), HyprEvent::Active(None));
        assert_eq!(hypr_event("windowtitle>>55d1c0a0"), HyprEvent::Title("55d1c0a0".into()));
        assert_eq!(hypr_event("windowtitlev2>>55d1c0a0,a, title>>"), HyprEvent::Title("55d1c0a0".into()));
        for other in [
            "windowtitlev2>>55d1c0a0",
            "windowtitlev2>>,A",
            "windowtitle>>",
            "windowtitle>>55d1c0a0,A",
            "activewindow>>ChatGPT,A",
            "workspace>>2",
            "",
        ] {
            assert_eq!(hypr_event(other), HyprEvent::Other, "{other:?}");
        }
    }

    #[test]
    fn the_events_end_ends_quietly_and_a_half_line_is_no_event() {
        assert_eq!(run(b"activewindowv2>>55d1c0a0", vec![Ok(answer(CHATGPT, "A"))]), (vec![title("A")], 1));
    }

    #[test]
    fn the_switch_stands_for_the_permission() {
        let door = HyprlandFollow::new(FollowSwitch::new(true));
        let changes = Arc::new(AtomicUsize::new(0));
        let counted = changes.clone();
        door.start(Box::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(door.trusted());
        door.prompt();
        door.switch(false);
        assert!(!door.trusted());
        // The runner reads the click back: nothing is told.
        assert_eq!(changes.load(Ordering::SeqCst), 0);
    }

    /// Hears into a channel: it disconnects once the observer's thread has let `heard` go.
    fn heard_into() -> (Box<dyn Fn(Heard) + Send + Sync>, mpsc::Receiver<Heard>) {
        let (sender, heard) = mpsc::channel();
        (Box::new(move |value| sender.send(value).unwrap()), heard)
    }

    #[test]
    fn no_hyprland_is_no_observer_once() {
        let empty = tempfile::tempdir().unwrap();
        for (runtime_dir, signature) in [(None, "s"), (Some(empty.path()), "s"), (Some(empty.path()), "..")] {
            let (heard, told) = heard_into();
            let _observation = observe_instance(runtime_dir, signature, |_| true, heard);
            assert_eq!(told.recv_timeout(WAIT), Ok(Heard::NoObserver));
            assert_eq!(told.recv_timeout(WAIT), Err(mpsc::RecvTimeoutError::Disconnected));
        }
    }

    #[test]
    fn observe_returns_before_the_connect_and_a_drop_before_it_ends_the_thread() {
        let (release, connecting) = mpsc::channel::<()>();
        let (events, _hyprland) = UnixStream::pair().unwrap();
        // A Hyprland that has not taken the connection yet: the connect waits until the test lets it through.
        let connect = move || {
            let _ = connecting.recv();
            Ok(events)
        };
        let (heard, told) = heard_into();
        let (returned, observed) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = returned.send(observe_events(connect, PathBuf::from("/nonexistent"), |_| true, heard));
        });
        let observation = observed.recv_timeout(WAIT).expect("observe waited on the connect");
        drop(observation);
        release.send(()).unwrap();
        // Nothing heard, not even the first ask: the thread ends once connected, and drops its callback.
        assert_eq!(told.recv_timeout(WAIT), Err(mpsc::RecvTimeoutError::Disconnected));
    }

    #[test]
    fn an_observation_hears_its_own_sockets_until_it_is_dropped() {
        let runtime = tempfile::tempdir().unwrap();
        let (events, requests) = sockets(runtime.path(), "s").unwrap();
        fs::create_dir_all(events.parent().unwrap()).unwrap();
        let requests = UnixListener::bind(&requests).unwrap();
        let asker = std::thread::spawn(move || {
            for answered in [answer(CHATGPT, "A"), answer(CHATGPT, "B")] {
                let (mut stream, _) = requests.accept().unwrap();
                let mut request = [0; 64];
                let read = stream.read(&mut request).unwrap();
                assert_eq!(&request[..read], b"j/activewindow");
                stream.write_all(&answered).unwrap();
            }
        });
        let events = UnixListener::bind(&events).unwrap();
        let (heard, told) = heard_into();
        let observation = observe_instance(Some(runtime.path()), "s", |pid| pid == CHATGPT, heard);
        let (mut stream, _) = events.accept().unwrap();
        assert_eq!(told.recv_timeout(WAIT), Ok(title("A")));
        stream.write_all(b"activewindowv2>>55d1c0a0\n").unwrap();
        assert_eq!(told.recv_timeout(WAIT), Ok(title("B")));
        asker.join().unwrap();
        // Dropped, it shuts the event stream down: Hyprland sees it close, and the thread ends.
        drop(observation);
        stream.set_read_timeout(Some(WAIT)).unwrap();
        assert_eq!(stream.read(&mut [0; 1]).unwrap(), 0);
        assert_eq!(told.recv_timeout(WAIT), Err(mpsc::RecvTimeoutError::Disconnected));
    }
}
