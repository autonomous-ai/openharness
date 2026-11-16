//! The `harness hardware watch --json` child.

use crate::cli::{Cli, Killer, StdinCloser, StdinWriter, Timeout, Unwritten};
use crate::tabs::{TabApp, select_of};
use crate::types::{DialStatus, Event, Log};
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

/// How long a watch has to print its first line. One that connects and says nothing would keep the menu on its first
/// words, and never count as the daemon being down.
const FIRST_LINE: Duration = Duration::from_secs(20);
/// How long a stopped watch has to end by itself before its group is killed.
const STOP_GRACE: Duration = Duration::from_secs(3);

/// A running watch. Stopping it, or dropping it, closes the child's stdin: the child then exits 0 by itself.
pub struct Watch {
    stdin: StdinCloser,
    writer: StdinWriter,
    killer: Killer,
    grace: Duration,
    log: Arc<dyn Log>,
    /// Whether the log has said this watch stopped reading: once is enough to be seen.
    not_reading: AtomicBool,
}

impl Watch {
    /// A line of the app in front (front.rs) on the child's stdin.
    pub fn front(&self, line: &str) {
        self.write(line);
    }

    /// A line of the selected tab (tabs.rs) on the child's stdin: a tty is as private as the app in front.
    pub fn tab(&self, line: &str) {
        self.write(line);
    }

    /// A change of the dial's sound on the child's stdin: one of two fixed lines, so nothing else can shape it.
    pub fn sound(&self, on: bool) {
        self.write(if on { r#"{"muted":false}"# } else { r#"{"muted":true}"# });
    }

    /// One that has ended takes nothing, and nothing of the line is logged. One that has stopped reading drops it, and
    /// the log says so once, never with the line: both kinds of line fill the same pipe.
    fn write(&self, line: &str) {
        if self.writer.line(line) == Err(Unwritten::Full) && !self.not_reading.swap(true, Ordering::Relaxed) {
            self.log.line("watch: not reading");
        }
    }

    /// One that has not ended within the grace is killed, so a stop always ends it.
    pub fn stop(&self) {
        // Only the close that closed it: a stop and the drop after it start one kill, not two.
        if self.stdin.close() {
            self.killer.kill_after(self.grace);
        }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Runs `hardware watch --json`: an `Event::WatchLine` for each status line it prints, then one `Event::WatchExit`.
/// Each select line it prints goes to `select` with its app, tty and raise, and is no Event: a tty is never one.
pub fn spawn_watch(
    cli: &dyn Cli,
    log: Arc<dyn Log>,
    send: impl Fn(Event) + Send + 'static,
    select: impl Fn(TabApp, String, bool) + Send + 'static,
) -> io::Result<Watch> {
    spawn_watch_within(cli, log, send, select, FIRST_LINE, STOP_GRACE)
}

fn spawn_watch_within(
    cli: &dyn Cli,
    log: Arc<dyn Log>,
    send: impl Fn(Event) + Send + 'static,
    select: impl Fn(TabApp, String, bool) + Send + 'static,
    first_line: Duration,
    grace: Duration,
) -> io::Result<Watch> {
    let mut child = cli.spawn(&["hardware", "watch", "--json"])?;
    let (stdin, writer, killer) = (child.stdin_closer(), child.stdin_writer(), child.killer());
    thread::spawn(move || {
        // After its first line the watch has no deadline: it runs until it is stopped or the daemon goes.
        // Duration::MAX waits without one.
        let mut wait = first_line;
        loop {
            match child.line(wait) {
                Ok(Some(line)) => {
                    // A line without a boolean `attached` (an `{"error":…}`, a select, anything else) is not a status.
                    if let Some((app, tty, raise)) = select_of(&line) {
                        select(app, tty, raise);
                    } else if let Ok(status) = serde_json::from_str::<DialStatus>(&line) {
                        send(Event::WatchLine(status));
                    }
                    wait = Duration::MAX;
                }
                Ok(None) => break,
                // Killed, it ends by a signal: the WatchExit(None) of a watch that ended with the daemon down.
                Err(Timeout) => {
                    child.killer().kill();
                    break;
                }
            }
        }
        // An Err only if the thread that reaps the child died; the run is over either way.
        send(Event::WatchExit(child.exit(Duration::MAX).unwrap_or(None)));
    });
    Ok(Watch { stdin, writer, killer, grace, log, not_reading: AtomicBool::new(false) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{HarnessCli, find_cli};
    use crate::tabs::TabApp;
    use crate::testing::{Fake, wait_gone};
    use crate::types::{DialStatus, Event, MemoryLog};
    use std::io;
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(5);
    const SHORT: Duration = Duration::from_millis(300);

    fn start(fake: &Fake) -> (Watch, mpsc::Receiver<Event>) {
        let (watch, events, _) = start_selecting(fake);
        (watch, events)
    }

    /// As `start`, and the selects the watch hands on.
    fn start_selecting(fake: &Fake) -> (Watch, mpsc::Receiver<Event>, mpsc::Receiver<(TabApp, String, bool)>) {
        let (send, events) = mpsc::channel();
        let (select, selects) = mpsc::channel();
        let watch = spawn_watch(
            &fake.cli(),
            fake.log(),
            move |event| {
                let _ = send.send(event);
            },
            move |app, tty, raise| {
                let _ = select.send((app, tty, raise));
            },
        )
        .unwrap();
        (watch, events, selects)
    }

    fn start_within(fake: &Fake, first_line: Duration, grace: Duration) -> (Watch, mpsc::Receiver<Event>) {
        let (send, events) = mpsc::channel();
        let send = move |event| {
            let _ = send.send(event);
        };
        (spawn_watch_within(&fake.cli(), fake.log(), send, |_, _, _| {}, first_line, grace).unwrap(), events)
    }

    fn dial(attached: bool, fw: Option<&str>, hw: Option<&str>) -> Event {
        Event::WatchLine(DialStatus {
            attached,
            fw: fw.map(Into::into),
            hw: hw.map(Into::into),
            board: None,
            updating: None,
            problem: None,
            muted: None,
        })
    }

    #[cfg(unix)]
    #[test]
    fn a_line_each_time_the_dial_changes() {
        let fake = Fake::new();
        let attached = r#"{"attached":true,"fw":"0.0.95","hw":"cst816s","muted":true}"#;
        fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@wait next", attached, "@stdin"]);
        let (_watch, events) = start(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(false, None, None)));
        fake.touch("next");
        let muted = DialStatus {
            attached: true,
            fw: Some("0.0.95".into()),
            hw: Some("cst816s".into()),
            board: None,
            updating: None,
            problem: None,
            muted: Some(true),
        };
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchLine(muted)));
        assert_eq!(fake.calls(), ["hardware watch --json"]);
    }

    #[cfg(unix)]
    #[test]
    fn lines_that_are_not_a_status_are_skipped() {
        let fake = Fake::new();
        let lines = ["not json", "[1]", r#"{"error":"Harness is too old"}"#, "{}", r#"{"attached":false}"#];
        fake.script("hardware watch --json", &lines);
        let (_watch, events) = start(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(false, None, None)));
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(0))));
    }

    #[cfg(unix)]
    #[test]
    fn the_exit_code_arrives() {
        for code in [3, 4] {
            let fake = Fake::new();
            fake.script("hardware watch --json", &[&format!("@exit {code}")]);
            let (_watch, events) = start(&fake);
            assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(code))));
            // One exit, then nothing: the thread has ended.
            assert_eq!(events.recv_timeout(WAIT), Err(mpsc::RecvTimeoutError::Disconnected));
        }
        // No script: the CLI has no such command.
        let fake = Fake::new();
        let (_watch, events) = start(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(1))));
    }

    #[cfg(unix)]
    #[test]
    fn stopping_closes_stdin_and_the_child_ends_by_itself() {
        let fake = Fake::new();
        fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@stdin"]);
        let (watch, events) = start(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(false, None, None)));
        watch.stop();
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(0))));
        assert_eq!(fake.ends(), ["hardware watch --json"]);
        // Dropping a watch stops it too.
        let fake = Fake::new();
        fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@stdin"]);
        let (watch, events) = start(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(false, None, None)));
        drop(watch);
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(0))));
    }

    #[cfg(unix)]
    #[test]
    fn a_front_line_reaches_the_watch() {
        let (ghostty, vscode) = (r#"{"front":"com.mitchellh.ghostty"}"#, r#"{"front":"com.microsoft.VSCode"}"#);
        let fake = Fake::new();
        fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@record"]);
        let (watch, events) = start(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(false, None, None)));
        watch.front(ghostty);
        watch.stop();
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(0))));
        assert_eq!(fake.stdin(), [ghostty]);
        // A watch that has ended takes nothing, and the log says nothing of it.
        watch.front(vscode);
        assert_eq!(fake.stdin(), [ghostty]);
        assert_eq!(fake.log().lines(), ["harness hardware watch --json: exit 0"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_select_line_reaches_the_tabs_and_is_no_status() {
        let fake = Fake::new();
        let lines = [
            r#"{"attached":true}"#,
            r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023"}}"#,
            r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023; rm"}}"#,
        ];
        fake.script("hardware watch --json", &lines);
        let (_watch, events, selects) = start_selecting(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(true, None, None)));
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(0))));
        assert_eq!(selects.recv_timeout(WAIT), Ok((TabApp::Terminal, "/dev/ttys023".into(), false)));
        // One, then nothing: the thread has ended, and the select with a bad tty went nowhere.
        assert_eq!(selects.recv_timeout(WAIT), Err(mpsc::RecvTimeoutError::Disconnected));
    }

    #[cfg(unix)]
    #[test]
    fn a_select_line_carries_its_raise_and_a_raise_that_is_not_a_boolean_is_dropped() {
        let fake = Fake::new();
        let lines = [
            r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023","raise":true}}"#,
            r#"{"select":{"app":"terminal-app","tty":"/dev/ttys023","raise":"true"}}"#,
        ];
        fake.script("hardware watch --json", &lines);
        let (_watch, events, selects) = start_selecting(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(0))));
        assert_eq!(selects.recv_timeout(WAIT), Ok((TabApp::Terminal, "/dev/ttys023".into(), true)));
        assert_eq!(selects.recv_timeout(WAIT), Err(mpsc::RecvTimeoutError::Disconnected));
    }

    #[cfg(unix)]
    #[test]
    fn a_tab_line_reaches_the_watch() {
        let tab = r#"{"tab":{"app":"terminal-app","tty":"/dev/ttys023"}}"#;
        let front = r#"{"front":"com.apple.Terminal"}"#;
        let fake = Fake::new();
        fake.script("hardware watch --json", &[r#"{"attached":true}"#, "@record"]);
        let (watch, events) = start(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(true, None, None)));
        watch.front(front);
        watch.tab(tab);
        watch.stop();
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(0))));
        assert_eq!(fake.stdin(), [front, tab]);
        // A watch that has ended takes nothing, and the log never holds a tty.
        watch.tab(tab);
        assert_eq!(fake.stdin(), [front, tab]);
        assert_eq!(fake.log().lines(), ["harness hardware watch --json: exit 0"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_sound_line_reaches_the_watch() {
        let (off, on) = (r#"{"muted":true}"#, r#"{"muted":false}"#);
        let fake = Fake::new();
        fake.script("hardware watch --json", &[r#"{"attached":true}"#, "@record"]);
        let (watch, events) = start(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(true, None, None)));
        watch.sound(false);
        watch.sound(true);
        watch.stop();
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(0))));
        assert_eq!(fake.stdin(), [off, on]);
        // A watch that has ended takes nothing, and the log says nothing of it.
        watch.sound(false);
        assert_eq!(fake.stdin(), [off, on]);
        assert_eq!(fake.log().lines(), ["harness hardware watch --json: exit 0"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_watch_that_stops_reading_is_one_line_that_names_nothing() {
        let fake = Fake::new();
        // `@hang` never reads stdin: its pipe fills.
        fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@hang"]);
        let (watch, events) = start_within(&fake, WAIT, SHORT);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(false, None, None)));
        let value = "com.example.secret".repeat(5);
        // 1 MB, past any pipe's buffer.
        for _ in 0..10_000 {
            watch.front(&format!(r#"{{"front":"{value}"}}"#));
        }
        watch.stop();
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(None)));
        let lines = fake.log().lines();
        assert_eq!(lines.iter().filter(|line| *line == "watch: not reading").count(), 1, "{lines:?}");
        assert!(!lines.iter().any(|line| line.contains("example")), "{lines:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_watch_with_no_first_line_in_time_is_ended() {
        let fake = Fake::new();
        fake.script("hardware watch --json", &["@hang"]);
        let (_watch, events) = start_within(&fake, SHORT, WAIT);
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(None)));
        assert!(fake.pids().into_iter().all(wait_gone));
        assert!(fake.ends().is_empty());
        // Only the first line has a deadline: after it, the dial may stay as it is for as long as it likes. Under load
        // `sh` can take the whole deadline to print it: the deadline then doubles until a run got that far.
        let mut first_line = SHORT;
        loop {
            let fake = Fake::new();
            fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@stdin"]);
            let (_watch, events) = start_within(&fake, first_line, WAIT);
            match events.recv_timeout(first_line + WAIT) {
                Ok(Event::WatchExit(None)) => {
                    first_line *= 2;
                    assert!(first_line < Duration::from_secs(10), "the fake never printed in time");
                }
                first => {
                    assert_eq!(first, Ok(dial(false, None, None)));
                    assert_eq!(events.recv_timeout(first_line * 2), Err(mpsc::RecvTimeoutError::Timeout));
                    return;
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_stopped_watch_that_does_not_end_is_killed() {
        let fake = Fake::new();
        // `@hang` never reads stdin, so its end goes unseen.
        fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@hang"]);
        let (watch, events) = start_within(&fake, WAIT, SHORT);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(false, None, None)));
        watch.stop();
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(None)));
        assert!(wait_gone(fake.pids()[0]));
        assert!(fake.ends().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_that_is_gone_is_an_error() {
        let home = tempfile::tempdir().unwrap();
        let missing = home.path().join("harness");
        let cli = HarnessCli::new(find_cli(home.path(), None, Some(&missing)).unwrap(), Arc::new(MemoryLog::default()));
        let error =
            spawn_watch(&cli, Arc::new(MemoryLog::default()), |_| {}, |_, _, _| {}).err().expect("no CLI there");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
