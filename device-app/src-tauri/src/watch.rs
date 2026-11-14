//! The `harness hardware watch --json` child.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{HarnessCli, Invocation};
    use crate::testing::Fake;
    use crate::types::{DialStatus, Event, MemoryLog};
    use std::io;
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(5);

    fn watch(fake: &Fake) -> (Watch, mpsc::Receiver<Event>) {
        let (send, events) = mpsc::channel();
        let watch = spawn_watch(&fake.cli(), move |event| {
            let _ = send.send(event);
        })
        .unwrap();
        (watch, events)
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
        let (_watch, events) = watch(&fake);
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
        let (_watch, events) = watch(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(false, None, None)));
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(0))));
    }

    #[cfg(unix)]
    #[test]
    fn the_exit_code_arrives() {
        for code in [3, 4] {
            let fake = Fake::new();
            fake.script("hardware watch --json", &[&format!("@exit {code}")]);
            let (_watch, events) = watch(&fake);
            assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(code))));
            // One exit, then nothing: the thread has ended.
            assert_eq!(events.recv_timeout(WAIT), Err(mpsc::RecvTimeoutError::Disconnected));
        }
        // No script: the CLI has no such command.
        let fake = Fake::new();
        let (_watch, events) = watch(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(1))));
    }

    #[cfg(unix)]
    #[test]
    fn stopping_closes_stdin_and_the_child_ends_by_itself() {
        let fake = Fake::new();
        fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@stdin"]);
        let (watch, events) = watch(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(false, None, None)));
        watch.stop();
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(0))));
        assert_eq!(fake.ends(), ["hardware watch --json"]);
        // Dropping a watch stops it too.
        let fake = Fake::new();
        fake.script("hardware watch --json", &[r#"{"attached":false}"#, "@stdin"]);
        let (watch, events) = watch(&fake);
        assert_eq!(events.recv_timeout(WAIT), Ok(dial(false, None, None)));
        drop(watch);
        assert_eq!(events.recv_timeout(WAIT), Ok(Event::WatchExit(Some(0))));
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_that_is_gone_is_an_error() {
        let fake = Fake::new();
        let program = fake.program().with_file_name("missing");
        let cli = HarnessCli::new(Invocation { program, prefix: vec![], env: vec![] }, Arc::new(MemoryLog::default()));
        let error = spawn_watch(&cli, |_| {}).err().expect("no CLI there");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
