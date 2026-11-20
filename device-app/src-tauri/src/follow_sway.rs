//! The ChatGPT follow on sway: the IPC socket's window events (`focus`, `title`) for a focused container of
//! ChatGPT's process, and the title is the container's `name`.
//!
//! Its own connection to sway, apart from the front source's: dropping an observation shuts only its own down.

use crate::follow::{ChatgptWindow, Heard, linux_installed, observe_socket, runs_chatgpt};
use crate::front_sway::{GET_TREE, SUBSCRIBE, WINDOW_EVENT, message, pid, read_message};
use serde_json::Value;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

/// The sway door's window: the focused ChatGPT window's title.
pub struct SwayFollow;

impl ChatgptWindow for SwayFollow {
    fn installed(&self) -> bool {
        linux_installed()
    }

    fn observe(&self, heard: Box<dyn Fn(Heard) + Send + Sync>) -> Option<Box<dyn Send>> {
        Some(observe_with(std::env::var_os("SWAYSOCK").map(PathBuf::from), runs_chatgpt, heard))
    }
}

/// Observes on a new connection to `socket`, sway's `$SWAYSOCK`, `chatgpt` telling ChatGPT's process by its pid. No
/// socket, or one that cannot be connected to, is NoObserver, as an observer not made.
pub fn observe_with(
    socket: Option<PathBuf>,
    chatgpt: impl Fn(u32) -> bool + Send + 'static,
    heard: Box<dyn Fn(Heard) + Send + Sync>,
) -> Box<dyn Send> {
    observe_on(move || UnixStream::connect(socket.ok_or(io::ErrorKind::NotFound)?), chatgpt, heard)
}

/// `listen` on the connection `connect` makes, on a thread of its own, until the handle is dropped. A failed connect,
/// or a connection that ends before the drop, is NoObserver once.
pub fn observe_on(
    connect: impl FnOnce() -> io::Result<UnixStream> + Send + 'static,
    chatgpt: impl Fn(u32) -> bool + Send + 'static,
    heard: Box<dyn Fn(Heard) + Send + Sync>,
) -> Box<dyn Send> {
    observe_socket(connect, move |stream, told| listen(stream, &chatgpt, told), heard)
}

/// The focused ChatGPT window's title now, then at each change, until the connection ends or sway refuses the
/// subscription. Either is NoObserver, `observe_socket`'s word.
pub fn listen(mut stream: impl Read + Write, chatgpt: &dyn Fn(u32) -> bool, told: &dyn Fn(Heard)) {
    // Window events alone: focus that leaves ChatGPT is told by the front source, and the rules stop the observation.
    // Subscribed before the tree is asked for, so a change between the two is not missed.
    let subscribed = stream.write_all(&message(SUBSCRIBE, br#"["window"]"#)).and_then(|()| read_message(&mut stream));
    let Ok((SUBSCRIBE, answer)) = subscribed else { return };
    if !serde_json::from_slice::<Value>(&answer).is_ok_and(|answer| answer["success"] == true) {
        return;
    }
    if stream.write_all(&message(GET_TREE, b"")).is_err() {
        return;
    }
    // Told in the order sway sent them: an event ahead of the tree is older than the tree.
    while let Ok((kind, payload)) = read_message(&mut stream) {
        let said =
            if kind == GET_TREE { Some(focused_title(&payload, chatgpt)) } else { heard(kind, &payload, chatgpt) };
        if let Some(title) = said {
            told(Heard::Title(title));
        }
    }
}

/// The title of the tree's focused node, walked through tiled and floating nodes alike: its `name` when its process
/// is ChatGPT's, else none.
pub fn focused_title(tree: &[u8], chatgpt: &dyn Fn(u32) -> bool) -> Option<String> {
    let tree: Value = serde_json::from_slice(tree).ok()?;
    // A stack, not recursion: the tree's depth is sway's, not ours.
    let mut nodes = vec![&tree];
    while let Some(node) = nodes.pop() {
        if node["focused"] == true {
            return title(node, chatgpt);
        }
        for key in ["nodes", "floating_nodes"] {
            nodes.extend(node[key].as_array().into_iter().flatten());
        }
    }
    None
}

/// What a window event of `kind` says: None for nothing heard, else the title to say. A `title` event of a window
/// behind (a second ChatGPT window) is not the thread in front.
pub fn heard(kind: u32, event: &[u8], chatgpt: &dyn Fn(u32) -> bool) -> Option<Option<String>> {
    if kind != WINDOW_EVENT {
        return None;
    }
    let event: Value = serde_json::from_slice(event).ok()?;
    let container = &event["container"];
    match event["change"].as_str()? {
        "focus" => Some(title(container, chatgpt)),
        "title" if container["focused"] == true => Some(title(container, chatgpt)),
        _ => None,
    }
}

/// A container's `name` when its process is ChatGPT's: another program named ChatGPT is not the app.
fn title(node: &Value, chatgpt: &dyn Fn(u32) -> bool) -> Option<String> {
    pid(node).filter(|&pid| chatgpt(pid)).and_then(|_| node["name"].as_str()).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::follow::Heard;
    use crate::front_sway::{PAYLOAD_MAX, message, read_message};
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::sync::{Mutex, mpsc};
    use std::time::Duration;

    /// sway's workspace event kind: the follow does not subscribe to it, and a stray one says nothing.
    const WORKSPACE_EVENT: u32 = 0x8000_0000;

    /// ChatGPT's process in the fixtures: the only pid the check passes.
    const CHATGPT_PID: u32 = 303;

    fn chatgpt(pid: u32) -> bool {
        pid == CHATGPT_PID
    }

    /// sway's tree, cut to the fields read: foot (pid 101) and `focused` the window it names.
    fn tree(focused: &str) -> String {
        format!(
            r#"{{"id":1,"type":"root","name":"root","focused":false,"floating_nodes":[],"nodes":[
            {{"id":3,"type":"output","name":"HEADLESS-1","focused":false,"floating_nodes":[],"nodes":[
                {{"id":4,"type":"workspace","name":"1","focused":false,"floating_nodes":[],"nodes":[
                    {{"id":5,"type":"con","name":"~","app_id":"foot","pid":101,"focused":false,"nodes":[],
                      "floating_nodes":[]}},
                    {focused}]}}]}}]}}"#
        )
    }

    /// A container of `pid` named `name`, focused or not.
    fn window(pid: u32, name: &str, focused: bool) -> String {
        format!(
            r#"{{"id":6,"type":"con","name":"{name}","app_id":"chatgpt","pid":{pid},"focused":{focused},"nodes":[],
            "floating_nodes":[]}}"#
        )
    }

    /// A window event of sway's: `change` and the container it is about.
    fn event(change: &str, container: &str) -> String {
        format!(r#"{{"change":"{change}","container":{container}}}"#)
    }

    /// The workspace focused, with no window on it.
    const TREE_EMPTY: &str = r#"{"id":1,"type":"root","name":"root","focused":false,"floating_nodes":[],"nodes":[
        {"id":3,"type":"output","name":"HEADLESS-1","focused":false,"floating_nodes":[],"nodes":[
            {"id":4,"type":"workspace","name":"1","focused":true,"floating_nodes":[],"nodes":[]}]}]}"#;

    /// foot tiled, ChatGPT floating above it and focused.
    fn tree_floating() -> String {
        format!(
            r#"{{"id":1,"type":"root","name":"root","focused":false,"floating_nodes":[],"nodes":[
            {{"id":3,"type":"output","name":"HEADLESS-1","focused":false,"floating_nodes":[],"nodes":[
                {{"id":4,"type":"workspace","name":"1","focused":false,
                  "nodes":[{{"id":5,"type":"con","app_id":"foot","pid":101,"focused":false,"nodes":[],
                             "floating_nodes":[]}}],
                  "floating_nodes":[{}]}}]}}]}}"#,
            window(CHATGPT_PID, "Fix login", true)
        )
    }

    fn title(value: &str) -> Heard {
        Heard::Title(Some(value.into()))
    }

    /// `listen` against a sway the script plays; what it heard. The script's end closes sway's side.
    fn run(script: impl FnOnce(&mut UnixStream) + Send + 'static) -> Vec<Heard> {
        let (ours, mut sway) = UnixStream::pair().unwrap();
        // A script that waits for a message never sent fails, not hangs.
        sway.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let peer = std::thread::spawn(move || script(&mut sway));
        let heard = Mutex::new(Vec::new());
        listen(ours, &chatgpt, &|said| heard.lock().unwrap().push(said));
        peer.join().unwrap();
        heard.into_inner().unwrap()
    }

    fn send(sway: &mut UnixStream, kind: u32, payload: &str) {
        sway.write_all(&message(kind, payload.as_bytes())).unwrap();
    }

    fn expect(sway: &mut UnixStream, kind: u32, payload: &str) {
        let (got, body) = read_message(sway).unwrap();
        assert_eq!((got, String::from_utf8(body).unwrap()), (kind, payload.to_string()));
    }

    /// sway takes the subscription to window events alone, then is asked for the tree.
    fn subscribed(sway: &mut UnixStream) {
        expect(sway, SUBSCRIBE, r#"["window"]"#);
        send(sway, SUBSCRIBE, r#"{"success":true}"#);
        expect(sway, GET_TREE, "");
    }

    #[test]
    fn the_first_title_is_the_focused_chatgpt_windows_name() {
        let heard = run(|sway| {
            subscribed(sway);
            send(sway, GET_TREE, &tree(&window(CHATGPT_PID, "Fix login", true)));
        });
        assert_eq!(heard, [title("Fix login")]);
    }

    #[test]
    fn the_first_title_is_none_when_the_focused_window_is_another_process_or_there_is_none() {
        let heard = run(|sway| {
            subscribed(sway);
            send(sway, GET_TREE, &tree(&window(202, "main.rs - Visual Studio Code", true)));
        });
        assert_eq!(heard, [Heard::Title(None)]);
        let heard = run(|sway| {
            subscribed(sway);
            send(sway, GET_TREE, TREE_EMPTY);
        });
        assert_eq!(heard, [Heard::Title(None)]);
    }

    #[test]
    fn a_focus_or_title_event_of_the_focused_chatgpt_window_says_its_name() {
        let heard = run(|sway| {
            subscribed(sway);
            send(sway, GET_TREE, &tree(&window(202, "main.rs - Visual Studio Code", true)));
            send(sway, WINDOW_EVENT, &event("focus", &window(CHATGPT_PID, "Fix login", true)));
            send(sway, WINDOW_EVENT, &event("title", &window(CHATGPT_PID, "Plan the trip", true)));
        });
        assert_eq!(heard, [Heard::Title(None), title("Fix login"), title("Plan the trip")]);
    }

    #[test]
    fn a_focused_window_of_another_process_says_the_empty_title() {
        let heard = run(|sway| {
            subscribed(sway);
            send(sway, GET_TREE, &tree(&window(CHATGPT_PID, "Fix login", true)));
            send(sway, WINDOW_EVENT, &event("focus", &window(202, "main.rs - Visual Studio Code", true)));
            send(sway, WINDOW_EVENT, &event("title", &window(202, "lib.rs - Visual Studio Code", true)));
        });
        assert_eq!(heard, [title("Fix login"), Heard::Title(None), Heard::Title(None)]);
    }

    #[test]
    fn a_title_of_a_chatgpt_window_behind_says_nothing() {
        let heard = run(|sway| {
            subscribed(sway);
            send(sway, GET_TREE, &tree(&window(CHATGPT_PID, "Fix login", true)));
            // A second ChatGPT window, behind the focused one, retitled.
            send(sway, WINDOW_EVENT, &event("title", &window(CHATGPT_PID, "Plan the trip", false)));
        });
        assert_eq!(heard, [title("Fix login")]);
    }

    #[test]
    fn close_move_and_workspace_events_say_nothing() {
        let focused = window(CHATGPT_PID, "Fix login", true);
        for (kind, other) in [
            (WINDOW_EVENT, event("close", &focused)),
            (WINDOW_EVENT, event("move", &focused)),
            (WINDOW_EVENT, event("new", &focused)),
            (WORKSPACE_EVENT, event("focus", &focused)),
            (WINDOW_EVENT, "no json".into()),
        ] {
            assert_eq!(heard(kind, other.as_bytes(), &chatgpt), None, "{other}");
        }
        assert_eq!(heard(WINDOW_EVENT, event("focus", &focused).as_bytes(), &chatgpt), Some(Some("Fix login".into())));
    }

    #[test]
    fn the_tree_is_walked_through_floating_nodes() {
        assert_eq!(focused_title(tree_floating().as_bytes(), &chatgpt).as_deref(), Some("Fix login"));
        assert_eq!(focused_title(b"no json", &chatgpt), None);
    }

    /// Its NoObserver is the observation's: `a_connection_sway_ends_is_no_observer_once`.
    #[test]
    fn a_refused_subscribe_ends_the_listen_with_no_title() {
        let heard = run(|sway| {
            expect(sway, SUBSCRIBE, r#"["window"]"#);
            send(sway, SUBSCRIBE, r#"{"success":false}"#);
        });
        assert_eq!(heard, []);
        // A sway that closes before it answers.
        assert_eq!(run(|_| {}), []);
    }

    #[test]
    fn a_payload_over_the_cap_or_another_magic_ends_the_listen_with_no_title() {
        // A tree padded with JSON's own spaces to one byte over the cap: read whole, it would name ChatGPT's window.
        let mut over = tree(&window(CHATGPT_PID, "Fix login", true)).into_bytes();
        over.resize(PAYLOAD_MAX + 1, b' ');
        let heard = run(move |sway| {
            subscribed(sway);
            // Refused once its header is read: the rest cannot be written to a side that has closed.
            let _ = sway.write_all(&message(GET_TREE, &over));
        });
        assert_eq!(heard, []);

        let heard = run(|sway| {
            subscribed(sway);
            let mut other = message(GET_TREE, tree(&window(CHATGPT_PID, "Fix login", true)).as_bytes());
            other[..6].copy_from_slice(b"i3-ipx");
            let _ = sway.write_all(&other);
        });
        assert_eq!(heard, []);
    }

    #[test]
    fn dropping_the_observation_ends_its_thread() {
        let (ours, mut sway) = UnixStream::pair().unwrap();
        sway.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let (tell, told) = mpsc::channel();
        let observation = observe_on(move || Ok(ours), chatgpt, Box::new(move |said| tell.send(said).unwrap()));
        subscribed(&mut sway);
        send(&mut sway, GET_TREE, &tree(&window(CHATGPT_PID, "Fix login", true)));
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Ok(title("Fix login")));
        drop(observation);
        // The thread drops its callback, and so the sender, as it ends.
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Err(mpsc::RecvTimeoutError::Disconnected));
    }

    #[test]
    fn observe_returns_before_the_connect_and_a_drop_before_it_ends_the_thread() {
        let (release, connecting) = mpsc::channel::<()>();
        let (ours, _sway) = UnixStream::pair().unwrap();
        // A sway that has not taken the connection yet: the connect waits until the test lets it through.
        let connect = move || {
            let _ = connecting.recv();
            Ok(ours)
        };
        let (tell, told) = mpsc::channel();
        let (returned, observed) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = returned.send(observe_on(connect, chatgpt, Box::new(move |said| tell.send(said).unwrap())));
        });
        let observation = observed.recv_timeout(Duration::from_secs(5)).expect("observe waited on the connect");
        drop(observation);
        release.send(()).unwrap();
        // Nothing heard: the thread ends once connected, and drops its callback.
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Err(mpsc::RecvTimeoutError::Disconnected));
    }

    /// As a sway that quits, or a connection that breaks, while the observer waits for an event; and a sway that
    /// refuses the subscription, which is told once too.
    #[test]
    fn a_connection_sway_ends_is_no_observer_once() {
        let (ours, mut sway) = UnixStream::pair().unwrap();
        sway.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let (tell, told) = mpsc::channel();
        let _observation = observe_on(move || Ok(ours), chatgpt, Box::new(move |said| tell.send(said).unwrap()));
        subscribed(&mut sway);
        send(&mut sway, GET_TREE, &tree(&window(CHATGPT_PID, "Fix login", true)));
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Ok(title("Fix login")));
        drop(sway);
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Ok(Heard::NoObserver));
        // The callback is let go after it, the observation still held: told once.
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Err(mpsc::RecvTimeoutError::Disconnected));

        let (ours, mut sway) = UnixStream::pair().unwrap();
        sway.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let (tell, told) = mpsc::channel();
        let _observation = observe_on(move || Ok(ours), chatgpt, Box::new(move |said| tell.send(said).unwrap()));
        expect(&mut sway, SUBSCRIBE, r#"["window"]"#);
        send(&mut sway, SUBSCRIBE, r#"{"success":false}"#);
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Ok(Heard::NoObserver));
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Err(mpsc::RecvTimeoutError::Disconnected));
    }

    #[test]
    fn no_sway_is_no_observer_once() {
        let empty = tempfile::tempdir().unwrap();
        for socket in [None, Some(empty.path().join("sway-ipc.sock"))] {
            let (tell, told) = mpsc::channel();
            let _observation = observe_with(socket, chatgpt, Box::new(move |said| tell.send(said).unwrap()));
            assert_eq!(told.recv_timeout(Duration::from_secs(5)), Ok(Heard::NoObserver));
            // The callback is let go after it: told once.
            assert_eq!(told.recv_timeout(Duration::from_secs(5)), Err(mpsc::RecvTimeoutError::Disconnected));
        }
    }

    /// Under a running sway (`SWAYSOCK` set) with foot installed: foot's window, retitled by OSC 2, is heard each time,
    /// in order. Not gated to Linux, so a Mac's test build compiles it too.
    #[test]
    #[ignore = "needs a running sway and foot"]
    fn follow_sway_live() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("titles");
        assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
        // Each line the test writes to the FIFO becomes foot's title: told when the test is ready, never on a timer.
        let script = r#"while read -r t < "$0"; do printf '\033]2;%s\007' "$t"; done"#;
        let mut foot = std::process::Command::new("foot")
            .args(["--title", "Live one", "sh", "-c", script])
            .arg(&fifo)
            .spawn()
            .unwrap();
        let foot_pid = foot.id();
        let (tell, told) = mpsc::channel();
        let socket = std::env::var_os("SWAYSOCK").map(PathBuf::from);
        let observation =
            observe_with(socket, move |pid| pid == foot_pid, Box::new(move |said| tell.send(said).unwrap()));
        // The next title other than `last`; repeats and the empty title before foot is focused are skipped.
        let next = |last: &str| loop {
            match told.recv_timeout(Duration::from_secs(10)).expect("a title from sway") {
                Heard::Title(Some(title)) if title != last => return title,
                Heard::NoObserver => panic!("no observer: is SWAYSOCK set?"),
                _ => {}
            }
        };
        assert_eq!(next(""), "Live one");
        std::fs::write(&fifo, "First\n").unwrap();
        assert_eq!(next("Live one"), "First");
        std::fs::write(&fifo, "Second\n").unwrap();
        assert_eq!(next("First"), "Second");
        drop(observation);
        foot.kill().unwrap();
        foot.wait().unwrap();
    }
}
