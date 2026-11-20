//! Following the thread opened in the ChatGPT app: when to observe its window, the line the watch reads, and when to
//! offer the Follow ChatGPT screen. The window's title is private like a tty: it goes on the watch's stdin and nowhere
//! else, never into the log, an Event, the state file or the window.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tabs::Out;
    use serde_json::json;
    use std::path::Path;
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
        for alone in 0..4 {
            let mut follow = ChatgptFollow::default();
            conditions[alone](&mut follow);
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
    fn no_follow_reads_nothing_and_asks_nothing() {
        let heard = std::sync::Arc::new(Mutex::new(0));
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
