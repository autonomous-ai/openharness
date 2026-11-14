//! The `harness hardware watch --json` child.

use crate::cli::{Cli, Killer, StdinCloser, Timeout};
use crate::types::{DialStatus, Event};
use std::io;
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
    killer: Killer,
    grace: Duration,
}

impl Watch {
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
pub fn spawn_watch(cli: &dyn Cli, send: impl Fn(Event) + Send + 'static) -> io::Result<Watch> {
    spawn_watch_within(cli, send, FIRST_LINE, STOP_GRACE)
}

fn spawn_watch_within(
    cli: &dyn Cli,
    send: impl Fn(Event) + Send + 'static,
    first_line: Duration,
    grace: Duration,
) -> io::Result<Watch> {
    let mut child = cli.spawn(&["hardware", "watch", "--json"])?;
    let (stdin, killer) = (child.stdin_closer(), child.killer());
    thread::spawn(move || {
        // After its first line the watch has no deadline: it runs until it is stopped or the daemon goes.
        // Duration::MAX waits without one.
        let mut wait = first_line;
        loop {
            match child.line(wait) {
                Ok(Some(line)) => {
                    // A line without a boolean `attached` (an `{"error":…}`, anything else) is not a status.
                    if let Ok(status) = serde_json::from_str::<DialStatus>(&line) {
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
    Ok(Watch { stdin, killer, grace })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{HarnessCli, find_cli};
    use crate::testing::{Fake, wait_gone};
    use crate::types::{DialStatus, Event, MemoryLog};
    use std::io;
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(5);
    const SHORT: Duration = Duration::from_millis(300);

    fn start(fake: &Fake) -> (Watch, mpsc::Receiver<Event>) {
        let (send, events) = mpsc::channel();
        let watch = spawn_watch(&fake.cli(), move |event| {
            let _ = send.send(event);
        })
        .unwrap();
        (watch, events)
    }

    fn start_within(fake: &Fake, first_line: Duration, grace: Duration) -> (Watch, mpsc::Receiver<Event>) {
        let (send, events) = mpsc::channel();
        let send = move |event| {
            let _ = send.send(event);
        };
        (spawn_watch_within(&fake.cli(), send, first_line, grace).unwrap(), events)
    }

    fn dial(attached: bool, fw: Option<&str>, hw: Option<&str>) -> Event {
        Event::WatchLine(DialStatus {
            attached,
            fw: fw.map(Into::into),
            hw: hw.map(Into::into),
            board: None,
            updating: None,
            problem: None,
        })
    }

    #[cfg(unix)]
    #[test]
    fn a_line_each_time_the_dial_changes() {
        let fake = Fake::new();
        let attached = r#"{"attached":true,"fw":"0.0.95","hw":"cst816s"}"#;
        fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@wait next", attached, "@stdin"]);
        let (_watch, events) = start(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(false, None, None)));
        fake.touch("next");
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(true, Some("0.0.95"), Some("cst816s"))));
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
        let error = spawn_watch(&cli, |_| {}).err().expect("no CLI there");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
