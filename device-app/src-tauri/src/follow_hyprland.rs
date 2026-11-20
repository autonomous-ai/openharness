//! The ChatGPT follow on Hyprland: the event socket says the active window or its title changed, and the request
//! socket's `j/activewindow` gives its `title` and `pid`.

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
        assert_eq!(changes.load(Ordering::SeqCst), 1);
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
