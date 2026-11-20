//! The ChatGPT follow on sway: the IPC socket's window events (`focus`, `title`) for a focused container of
//! ChatGPT's process, and the title is the container's `name`.

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

    #[test]
    fn a_refused_subscribe_is_no_observer() {
        let heard = run(|sway| {
            expect(sway, SUBSCRIBE, r#"["window"]"#);
            send(sway, SUBSCRIBE, r#"{"success":false}"#);
        });
        assert_eq!(heard, [Heard::NoObserver]);
        // A sway that closes before it answers.
        assert_eq!(run(|_| {}), [Heard::NoObserver]);
    }

    #[test]
    fn a_payload_over_the_cap_or_another_magic_ends_the_observation_quietly() {
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
        let observation = observe_stream(ours, chatgpt, Box::new(move |said| tell.send(said).unwrap()));
        subscribed(&mut sway);
        send(&mut sway, GET_TREE, &tree(&window(CHATGPT_PID, "Fix login", true)));
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Ok(title("Fix login")));
        drop(observation);
        // The thread drops its callback, and so the sender, as it ends.
        assert_eq!(told.recv_timeout(Duration::from_secs(5)), Err(mpsc::RecvTimeoutError::Disconnected));
    }
}
