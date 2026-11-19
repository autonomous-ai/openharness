//! The app in front on Hyprland: the event socket says the window changed, the request socket names it.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::front::Stop;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::fs;
    use std::io::{self, Read, Write};
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixListener;
    use std::path::Path;

    /// A `/proc` with each pid's `exe` link.
    fn proc_with(exes: &[(u32, &str)]) -> tempfile::TempDir {
        let proc_root = tempfile::tempdir().unwrap();
        for (pid, exe) in exes {
            fs::create_dir(proc_root.path().join(pid.to_string())).unwrap();
            symlink(exe, proc_root.path().join(pid.to_string()).join("exe")).unwrap();
        }
        proc_root
    }

    fn apps() -> tempfile::TempDir {
        proc_with(&[(4242, "/usr/bin/kitty"), (4343, "/usr/share/code/code")])
    }

    /// `j/activewindow`'s answer in Hyprland's own shape. The title is outside text: never told.
    fn answer(pid: i64) -> Vec<u8> {
        format!(r#"{{"address":"0x55d1c0a0","pid":{pid},"class":"kitty","title":"~/secret"}}"#).into_bytes()
    }

    /// Why `follow` stopped, what it told, and how often it asked: each ask answered in turn from `answers`.
    fn run(events: &[u8], answers: Vec<io::Result<Vec<u8>>>, proc_root: &Path) -> (Stop, Vec<String>, usize) {
        let answers = RefCell::new(VecDeque::from(answers));
        let asked = Cell::new(0);
        let told = RefCell::new(Vec::new());
        let ask = || {
            asked.set(asked.get() + 1);
            answers.borrow_mut().pop_front().expect("an ask with no answer left")
        };
        let stop = follow(events, &ask, proc_root, &|value| told.borrow_mut().push(value));
        (stop, told.into_inner(), asked.get())
    }

    #[test]
    fn the_first_value_asks_the_active_window() {
        let proc_root = apps();
        let (stop, told, asked) = run(b"", vec![Ok(answer(4242))], proc_root.path());
        assert_eq!((stop, told, asked), (Stop::Ended, vec!["kitty".to_string()], 1));
    }

    #[test]
    fn each_activewindowv2_asks_again_and_no_other_event_does() {
        let proc_root = apps();
        // The v1 event carries the class and the title: neither is asked about nor told.
        let events = b"activewindow>>kitty,~/secret\nworkspace>>2\nactivewindowv2>>55d1c0a0\nfocusedmon>>DP-1,2\n";
        let (stop, told, asked) = run(events, vec![Ok(answer(4242)), Ok(answer(4343))], proc_root.path());
        assert_eq!((stop, told, asked), (Stop::Ended, vec!["kitty".to_string(), "code".to_string()], 2));
        assert!(is_active_window("activewindowv2>>55d1c0a0"));
        assert!(!is_active_window("activewindow>>kitty,activewindowv2>>"));
        assert!(!is_active_window(""));
    }

    #[test]
    fn no_window_is_the_empty_value() {
        let proc_root = apps();
        // An empty workspace answers `{}`; a pid with no exe (gone, or another person's) names no app either.
        let (_, told, _) = run(b"activewindowv2>>1\n", vec![Ok(b"{}".to_vec()), Ok(answer(4444))], proc_root.path());
        assert_eq!(told, ["", ""]);
        assert_eq!(active_pid(b"{}"), None);
        assert_eq!(active_pid(&answer(0)), None);
        assert_eq!(active_pid(&answer(-1)), None);
        assert_eq!(active_pid(&answer(1 << 40)), None);
        assert_eq!(active_pid(br#"{"pid":"4242"}"#), None);
        assert_eq!(active_pid(b"no json"), None);
        assert_eq!(active_pid(&answer(4242)), Some(4242));
    }

    #[test]
    fn a_line_over_4096_bytes_is_skipped_and_the_next_one_read() {
        let proc_root = apps();
        let line = |len: usize| format!("activewindowv2>>{}\n", "a".repeat(len - "activewindowv2>>".len()));
        // One byte over the cap, then one exactly at it.
        let events = format!("{}{}", line(LINE_MAX + 1), line(LINE_MAX));
        let (stop, told, asked) = run(events.as_bytes(), vec![Ok(answer(4242)), Ok(answer(4343))], proc_root.path());
        assert_eq!((stop, told, asked), (Stop::Ended, vec!["kitty".to_string(), "code".to_string()], 2));
    }

    #[test]
    fn an_answer_over_64_kib_is_no_app() {
        let proc_root = apps();
        let padded = |len: usize| {
            let base = answer(4242).len() - "~/secret".len();
            format!(r#"{{"address":"0x55d1c0a0","pid":4242,"class":"kitty","title":"{}"}}"#, "a".repeat(len - base))
                .into_bytes()
        };
        assert_eq!(padded(ANSWER_MAX).len(), ANSWER_MAX);
        let answers = vec![Ok(padded(ANSWER_MAX)), Ok(padded(ANSWER_MAX + 1))];
        let (_, told, _) = run(b"activewindowv2>>1\n", answers, proc_root.path());
        assert_eq!(told, ["kitty", ""]);
    }

    #[test]
    fn a_signature_that_is_not_one_folder_names_no_socket() {
        let runtime = Path::new("/run/user/1000");
        let hypr = runtime.join("hypr").join("0d1f3c2a_1732000000_1234567890");
        assert_eq!(
            sockets(runtime, "0d1f3c2a_1732000000_1234567890"),
            Some((hypr.join(".socket2.sock"), hypr.join(".socket.sock")))
        );
        for signature in ["", ".", "..", "a/b", "/abs", "../x", "a\0b"] {
            assert_eq!(sockets(runtime, signature), None, "{signature:?}");
        }
    }

    #[test]
    fn the_events_end_is_ended_and_a_first_ask_that_fails_is_not_followed() {
        let proc_root = apps();
        // Ended mid-line: the half line is not an event.
        let (stop, told, asked) = run(b"activewindowv2>>1", vec![Ok(answer(4242))], proc_root.path());
        assert_eq!((stop, told, asked), (Stop::Ended, vec!["kitty".to_string()], 1));
        let refused = || Err(io::Error::from(io::ErrorKind::ConnectionRefused));
        let (stop, told, asked) = run(b"activewindowv2>>1\n", vec![refused()], proc_root.path());
        assert_eq!((stop, told, asked), (Stop::NotFollowed, vec![], 1));
    }

    #[test]
    fn a_later_ask_that_fails_is_the_empty_value() {
        let proc_root = apps();
        let refused = Err(io::Error::from(io::ErrorKind::ConnectionRefused));
        let (stop, told, _) = run(b"activewindowv2>>1\n", vec![Ok(answer(4242)), refused], proc_root.path());
        assert_eq!((stop, told), (Stop::Ended, vec!["kitty".to_string(), String::new()]));
    }

    /// Answers each request connection in turn from `answers`, and hands back what each asked.
    fn requests(listener: UnixListener, answers: Vec<Vec<u8>>) -> std::thread::JoinHandle<Vec<Vec<u8>>> {
        std::thread::spawn(move || {
            let mut asked = Vec::new();
            for answer in answers {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 64];
                let read = stream.read(&mut request).unwrap();
                asked.push(request[..read].to_vec());
                // The ask may stop reading at its cap and close.
                let _ = stream.write_all(&answer);
            }
            asked
        })
    }

    #[test]
    fn the_ask_sends_j_activewindow_and_reads_no_further_than_past_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.sock");
        let server = requests(UnixListener::bind(&path).unwrap(), vec![answer(4242), vec![b' '; 4 * ANSWER_MAX]]);
        assert_eq!(ask(&path).unwrap(), answer(4242));
        let over = ask(&path).unwrap();
        assert!(over.len() > ANSWER_MAX && over.len() <= ANSWER_MAX + 1, "{}", over.len());
        assert_eq!(server.join().unwrap(), [b"j/activewindow", b"j/activewindow"]);
    }

    #[test]
    fn the_sockets_under_the_runtime_dir_are_followed_to_their_end() {
        let proc_root = apps();
        let runtime = tempfile::tempdir().unwrap();
        let (events, asks) = sockets(runtime.path(), "s").unwrap();
        fs::create_dir_all(events.parent().unwrap()).unwrap();
        let server = requests(UnixListener::bind(&asks).unwrap(), vec![answer(4242), answer(4343)]);
        let events = UnixListener::bind(&events).unwrap();
        let emitter = std::thread::spawn(move || {
            let (mut stream, _) = events.accept().unwrap();
            stream.write_all(b"activewindowv2>>55d1c0a0\n").unwrap();
        });
        let told = RefCell::new(Vec::new());
        let stop = watch(runtime.path(), "s", proc_root.path(), &|value| told.borrow_mut().push(value));
        assert_eq!((stop, told.into_inner()), (Stop::Ended, vec!["kitty".to_string(), "code".to_string()]));
        emitter.join().unwrap();
        assert_eq!(server.join().unwrap().len(), 2);
        // No Hyprland there, or a signature that is not a folder name: nothing to follow.
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(watch(empty.path(), "s", proc_root.path(), &|_| {}), Stop::NotFollowed);
        assert_eq!(watch(runtime.path(), "..", proc_root.path(), &|_| {}), Stop::NotFollowed);
    }
}
