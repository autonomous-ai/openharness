//! The app in front on Hyprland: the event socket says the window changed, the request socket names it.

use crate::front::Stop;
use crate::front_x11::exe_name;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;
#[cfg(target_os = "linux")]
use {
    crate::front::{FrontSource, Source, on_thread},
    crate::types::Log,
    std::sync::Arc,
};

/// An event line is outside text (the v1 window event carries a title): past this it is read past, never kept.
pub const LINE_MAX: usize = 4096;
/// `j/activewindow`'s answer is a few hundred bytes; one past this names no app.
pub const ANSWER_MAX: usize = 64 * 1024;
/// A Hyprland that takes the request and never answers would hold the source: the ask gives up after this.
const ASK_WAIT: Duration = Duration::from_secs(2);

/// The exe name of the active window's process: once at start, then on each change.
#[cfg(target_os = "linux")]
pub struct HyprlandFront {
    pub log: Arc<dyn Log>,
}

#[cfg(target_os = "linux")]
impl FrontSource for HyprlandFront {
    fn start(&self, changed: Box<dyn Fn(String) + Send + Sync>) {
        on_thread(self.log.clone(), Source::Hyprland, move || {
            let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty());
            let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE");
            let (Some(runtime_dir), Ok(signature)) = (runtime_dir, signature) else { return Stop::NotFollowed };
            watch(Path::new(&runtime_dir), &signature, Path::new("/proc"), &*changed)
        });
    }
}

/// The event and request sockets of the Hyprland instance `signature` names. None unless the signature is one folder
/// name: it comes from the environment, and must not reach outside `hypr/`.
pub fn sockets(runtime_dir: &Path, signature: &str) -> Option<(PathBuf, PathBuf)> {
    if signature.is_empty() || signature == "." || signature == ".." || signature.contains(['/', '\0']) {
        return None;
    }
    let hypr = runtime_dir.join("hypr").join(signature);
    Some((hypr.join(".socket2.sock"), hypr.join(".socket.sock")))
}

/// The event that says the active window changed. Its own text is never used: the v1 event's carries a title, and the
/// answer to an ask names the app.
pub fn is_active_window(line: &str) -> bool {
    line.starts_with("activewindowv2>>")
}

/// The active window's pid in `j/activewindow`'s answer. None for `{}` (no window), a pid that is not above 0, or an
/// answer over ANSWER_MAX.
pub fn active_pid(answer: &[u8]) -> Option<u32> {
    if answer.len() > ANSWER_MAX {
        return None;
    }
    let answer: serde_json::Value = serde_json::from_slice(answer).ok()?;
    u32::try_from(answer.get("pid")?.as_i64()?).ok().filter(|&pid| pid > 0)
}

/// Tells the app in front now, then after each `activewindowv2` event, until the events end. `events` is connected
/// before the first ask, so a change between the two is not missed.
pub fn follow(
    events: impl Read,
    ask: &dyn Fn() -> io::Result<Vec<u8>>,
    proc_root: &Path,
    changed: &dyn Fn(String),
) -> Stop {
    let name = |answer: &[u8]| active_pid(answer).and_then(|pid| exe_name(proc_root, pid)).unwrap_or_default();
    let Ok(answer) = ask() else { return Stop::NotFollowed };
    changed(name(&answer));
    let mut events = BufReader::new(events);
    let mut line = Vec::new();
    loop {
        match next_line(&mut events, &mut line) {
            Err(_) => return Stop::Ended,
            Ok(true) if std::str::from_utf8(&line).is_ok_and(is_active_window) => {
                // An answer that cannot be had is no app: the dial must not keep following the last one.
                changed(ask().map(|answer| name(&answer)).unwrap_or_default());
            }
            Ok(_) => {}
        }
    }
}

/// Reads the next line into `line`, without its newline. False for a line over LINE_MAX, which is read past and not
/// kept. An error at the end: a half line there is no event.
fn next_line(events: &mut impl BufRead, line: &mut Vec<u8>) -> io::Result<bool> {
    line.clear();
    let mut over = false;
    loop {
        let chunk = match events.fill_buf() {
            Ok([]) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(chunk) => chunk,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let end = chunk.iter().position(|&byte| byte == b'\n');
        let part = &chunk[..end.unwrap_or(chunk.len())];
        over = over || line.len() + part.len() > LINE_MAX;
        if over {
            line.clear();
        } else {
            line.extend_from_slice(part);
        }
        let read = end.map_or(chunk.len(), |end| end + 1);
        events.consume(read);
        if end.is_some() {
            return Ok(!over);
        }
    }
}

/// Follows the Hyprland instance under `runtime_dir`. No socket there is `NotFollowed`.
fn watch(runtime_dir: &Path, signature: &str, proc_root: &Path, changed: &dyn Fn(String)) -> Stop {
    let Some((events, requests)) = sockets(runtime_dir, signature) else { return Stop::NotFollowed };
    let Ok(events) = UnixStream::connect(events) else { return Stop::NotFollowed };
    follow(events, &|| ask(&requests), proc_root, changed)
}

/// `j/activewindow` on a connection of its own, as Hyprland answers one request per connection: the answer read to its
/// end, or to one byte past ANSWER_MAX.
fn ask(requests: &Path) -> io::Result<Vec<u8>> {
    let mut stream = UnixStream::connect(requests)?;
    stream.set_read_timeout(Some(ASK_WAIT))?;
    stream.set_write_timeout(Some(ASK_WAIT))?;
    stream.write_all(b"j/activewindow")?;
    let mut answer = Vec::new();
    stream.take(ANSWER_MAX as u64 + 1).read_to_end(&mut answer)?;
    Ok(answer)
}

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
    fn the_events_end_is_ended() {
        let proc_root = apps();
        // Ended mid-line: the half line is not an event.
        let (stop, told, asked) = run(b"activewindowv2>>1", vec![Ok(answer(4242))], proc_root.path());
        assert_eq!((stop, told, asked), (Stop::Ended, vec!["kitty".to_string()], 1));
    }

    #[test]
    fn an_ask_that_fails_is_the_empty_value_at_start_too_and_following_goes_on() {
        let proc_root = apps();
        let refused = || Err(io::Error::from(io::ErrorKind::ConnectionRefused));
        // The first ask fails while Hyprland is still starting: its request socket not yet bound, or slow to answer.
        let answers = vec![refused(), Ok(answer(4242)), refused()];
        let (stop, told, asked) = run(b"activewindowv2>>1\nactivewindowv2>>2\n", answers, proc_root.path());
        assert_eq!((stop, told, asked), (Stop::Ended, vec![String::new(), "kitty".to_string(), String::new()], 3));
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
