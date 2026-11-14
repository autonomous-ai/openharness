//! `harness auth status --json` and `harness login --json`.

use crate::cli::{Child, Cli, Killer, LINE_MAX, LOGIN_DEADLINE, LOGIN_EXIT_DEADLINE, STATUS_DEADLINE, Timeout};
use crate::types::{Event, Log, LoginEvent};
use serde::Deserialize;
use std::io;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

/// The sign-in screen's words when the CLI gave no `result`, or none in time.
pub const NO_RESULT: &str = "Sign-in did not finish.";

/// Whether this computer is signed in; `None` when the CLI could not say.
pub fn auth_status(cli: &dyn Cli) -> Option<bool> {
    auth_status_within(cli, STATUS_DEADLINE)
}

fn auth_status_within(cli: &dyn Cli, deadline: Duration) -> Option<bool> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        logged_in: bool,
    }
    let output = cli.run(&["auth", "status", "--json"], deadline).ok()?;
    // It always exits 0, signed out too: any other end is a run that failed.
    if output.timed_out || output.code != Some(0) {
        return None;
    }
    output
        .stdout
        .lines()
        .filter(|line| line.len() <= LINE_MAX)
        .find_map(|line| serde_json::from_str::<Status>(line).ok())
        .map(|status| status.logged_in)
}

/// The lines of `harness login --json` the app acts on. Any other type is ignored.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Line {
    AuthorizeUrl { url: String },
    Waiting { message: String },
    Result { status: String, code: Option<String>, message: Option<String> },
}

/// A sign-in under way.
pub struct Login {
    /// The child's killer until the sign-in is decided: its `result`, its output's end, the deadline or a cancel takes
    /// it. Events are sent while it is held, so once `cancel` has returned nothing more is sent.
    live: Arc<Mutex<Option<Killer>>>,
    log: Arc<dyn Log>,
}

impl Login {
    /// Kills the child before its `result`. After it, `harness login` is restarting the daemon, so this does nothing.
    pub fn cancel(&self) {
        if let Some(killer) = self.live.lock().unwrap().take() {
            killer.kill();
            self.log.line("sign-in: cancelled");
        }
    }
}

/// Runs `login --json`: an `Event::Login` for its authorize URL (`https:` only), each `waiting`, and one `Done`,
/// unless it is cancelled first.
pub fn login(cli: &dyn Cli, log: Arc<dyn Log>, send: impl Fn(Event) + Send + 'static) -> io::Result<Login> {
    login_within(cli, log, send, LOGIN_DEADLINE, LOGIN_EXIT_DEADLINE)
}

fn login_within(
    cli: &dyn Cli,
    log: Arc<dyn Log>,
    send: impl Fn(Event) + Send + 'static,
    before_result: Duration,
    after_result: Duration,
) -> io::Result<Login> {
    let mut child = cli.spawn(&["login", "--json"])?;
    let live = Arc::new(Mutex::new(Some(child.killer())));
    let login = Login { live: live.clone(), log: log.clone() };
    thread::spawn(move || {
        until_result(&mut child, &live, &*log, &|event| send(Event::Login(event)), before_result);
        // However it ended, the child is read to its end, so it never blocks on a full pipe, and waited for: after a
        // `result` it is restarting the daemon, and nothing here kills it. The thread ends once it has exited.
        let end = Instant::now() + after_result;
        while let Ok(Some(_)) = child.line(end.saturating_duration_since(Instant::now())) {}
        let _ = child.exit(end.saturating_duration_since(Instant::now()));
        // Only here is the child let go of, and its stdin with it: `harness login` reads a closed stdin as the app
        // having gone, and gives up.
    });
    Ok(login)
}

/// Sends the child's events until its `result`, its output's end, the deadline (which kills it) or a cancel.
fn until_result(
    child: &mut Child,
    live: &Mutex<Option<Killer>>,
    log: &dyn Log,
    send: &dyn Fn(LoginEvent),
    deadline: Duration,
) {
    let end = Instant::now() + deadline;
    loop {
        let next = child.line(end.saturating_duration_since(Instant::now()));
        let mut live = live.lock().unwrap();
        // Cancelled: nothing more is sent.
        let Some(killer) = live.as_ref() else { return };
        let done = match next {
            Ok(Some(line)) => match serde_json::from_str(&line) {
                Ok(Line::AuthorizeUrl { url }) => {
                    // A browser opens it: nothing but `https:` gets through.
                    if let Some(url) = Url::parse(&url).ok().filter(|url| url.scheme() == "https") {
                        let host = url.host_str().unwrap_or_default();
                        log.line(&format!("sign-in: browser {}://{host}{}", url.scheme(), url.path()));
                        send(LoginEvent::AuthorizeUrl(url.into()));
                    }
                    continue;
                }
                Ok(Line::Waiting { message }) => {
                    log.line("sign-in: waiting");
                    send(LoginEvent::Waiting(message));
                    continue;
                }
                Ok(Line::Result { status, code, message }) => {
                    if status == "success" {
                        log.line("sign-in: result success");
                        Ok(())
                    } else {
                        let code = code.map_or(String::new(), |code| format!(" {code}"));
                        log.line(&format!("sign-in: result error{code}"));
                        let message = message.filter(|message| !message.trim().is_empty());
                        Err(message.unwrap_or_else(|| NO_RESULT.into()))
                    }
                }
                Err(_) => continue,
            },
            Ok(None) => {
                log.line("sign-in: no result");
                Err(NO_RESULT.into())
            }
            Err(Timeout) => {
                killer.kill();
                log.line("sign-in: no result");
                Err(NO_RESULT.into())
            }
        };
        *live = None;
        send(LoginEvent::Done(done));
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::LINE_MAX;
    use crate::testing::{Fake, alive, wait_gone};
    use crate::types::{Event, LoginEvent, LoginEvent::*};
    use std::sync::mpsc;
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(5);
    const SHORT: Duration = Duration::from_millis(300);
    const URL: &str = r#"{"type":"authorize_url","url":"https://id.example/a?state=S"}"#;
    const WAITING: &str = r#"{"type":"waiting","message":"Harness is finishing an update"}"#;
    const SUCCESS: &str = r#"{"type":"result","status":"success","email":"person@example.com"}"#;

    /// A `send` for a sign-in, and the sign-in events it was handed.
    fn channel() -> (impl Fn(Event) + Send + 'static, mpsc::Receiver<LoginEvent>) {
        let (send, events) = mpsc::channel();
        let send = move |event| {
            if let Event::Login(event) = event {
                let _ = send.send(event);
            }
        };
        (send, events)
    }

    /// Every event until the sign-in's thread has ended and let go of `send`, 5 s at most for each.
    fn all(events: &mpsc::Receiver<LoginEvent>) -> Vec<LoginEvent> {
        let mut all = Vec::new();
        loop {
            match events.recv_timeout(WAIT) {
                Ok(event) => all.push(event),
                Err(mpsc::RecvTimeoutError::Disconnected) => return all,
                Err(timeout) => panic!("{timeout}; so far {all:?}"),
            }
        }
    }

    fn failed(message: &str) -> LoginEvent {
        Done(Err(message.into()))
    }

    fn logged(fake: &Fake, line: &str) -> bool {
        fake.log().lines().iter().any(|logged| logged == line)
    }

    #[cfg(unix)]
    #[test]
    fn auth_status_reads_logged_in() {
        let too_long = format!(r#"{{"loggedIn":true,"pad":"{}"}}"#, "x".repeat(LINE_MAX));
        let cases: [(&[&str], Duration, Option<bool>); 6] = [
            (&[r#"{"loggedIn":true,"machineId":"m"}"#], WAIT, Some(true)),
            (&[r#"{"loggedIn":false,"signedOut":"pending-refresh"}"#], WAIT, Some(false)),
            (&["oops"], WAIT, None),
            // `auth status` always exits 0: any other code is a run that failed, whatever it printed.
            (&[r#"{"loggedIn":true}"#, "@exit 1"], WAIT, None),
            (&["@hang"], SHORT, None),
            (&[&too_long], WAIT, None),
        ];
        for (case, (lines, deadline, logged_in)) in cases.into_iter().enumerate() {
            let fake = Fake::new();
            fake.script("auth status --json", lines);
            assert_eq!(auth_status_within(&fake.cli(), deadline), logged_in, "case {case}");
        }
        let fake = Fake::new();
        fake.script("auth status --json", &[r#"{"loggedIn":true}"#]);
        assert_eq!(auth_status(&fake.cli()), Some(true));
        assert_eq!(fake.calls(), ["auth status --json"]);
    }

    #[cfg(unix)]
    #[test]
    fn the_browser_url_then_the_result() {
        let fake = Fake::new();
        // `@driver`: a closed stdin would end this run with a CANCELLED result.
        fake.script("login --json", &["@driver", URL, WAITING, "@wait go", SUCCESS]);
        let (send, events) = channel();
        let _login = login(&fake.cli(), fake.log(), send).unwrap();
        assert_eq!(events.recv_timeout(WAIT), Ok(AuthorizeUrl("https://id.example/a?state=S".into())));
        assert_eq!(events.recv_timeout(WAIT), Ok(Waiting("Harness is finishing an update".into())));
        fake.touch("go");
        assert_eq!(all(&events), [Done(Ok(()))]);
        assert_eq!(fake.calls(), ["login --json"]);
        assert_eq!(fake.ends(), ["login --json"]);
    }

    #[cfg(unix)]
    #[test]
    fn only_an_https_url_is_passed_on() {
        let fake = Fake::new();
        let lines: Vec<String> =
            ["http://id.example/a", "javascript:alert(1)", "file:///etc/passwd", "not a url", "HTTPS://id.example/a"]
                .iter()
                .map(|url| format!(r#"{{"type":"authorize_url","url":"{url}"}}"#))
                .collect();
        fake.script("login --json", &lines.iter().map(String::as_str).collect::<Vec<_>>());
        let (send, events) = channel();
        let _login = login(&fake.cli(), fake.log(), send).unwrap();
        assert_eq!(all(&events), [AuthorizeUrl("https://id.example/a".into()), failed(NO_RESULT)]);
    }

    #[cfg(unix)]
    #[test]
    fn an_error_result_carries_its_message() {
        let cases = [
            (r#"{"type":"result","status":"error","code":"BACKEND_ERROR","message":"fetch failed"}"#, "fetch failed"),
            (r#"{"type":"result","status":"error","code":"BACKEND_ERROR"}"#, NO_RESULT),
            (r#"{"type":"result","status":"error","code":"BACKEND_ERROR","message":" "}"#, NO_RESULT),
        ];
        for (result, shown) in cases {
            let fake = Fake::new();
            fake.script("login --json", &[result, "@exit 1"]);
            let (send, events) = channel();
            let _login = login(&fake.cli(), fake.log(), send).unwrap();
            assert_eq!(all(&events), [failed(shown)], "{result}");
            assert!(logged(&fake, "sign-in: result error BACKEND_ERROR"), "{:?}", fake.log().lines());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_ends_without_a_result_is_a_failure() {
        let fake = Fake::new();
        fake.script("login --json", &["@exit 1"]);
        let (send, events) = channel();
        let _login = login(&fake.cli(), fake.log(), send).unwrap();
        assert_eq!(all(&events), [failed(NO_RESULT)]);
        assert!(logged(&fake, "sign-in: no result"));
        // A CLI with no such command.
        let fake = Fake::new();
        let (send, events) = channel();
        let _login = login(&fake.cli(), fake.log(), send).unwrap();
        assert_eq!(all(&events), [failed(NO_RESULT)]);
    }

    #[cfg(unix)]
    #[test]
    fn other_events_and_junk_are_ignored() {
        let fake = Fake::new();
        let lines = [r#"{"type":"qr","url":"x"}"#, r#"{"type":"confirm","email":"a@b.c"}"#, "nonsense", SUCCESS];
        fake.script("login --json", &lines);
        let (send, events) = channel();
        let _login = login(&fake.cli(), fake.log(), send).unwrap();
        assert_eq!(all(&events), [Done(Ok(()))]);
    }

    #[cfg(unix)]
    #[test]
    fn cancel_kills_before_the_result_only() {
        let fake = Fake::new();
        fake.script("login --json", &[URL, "@hang"]);
        let (send, events) = channel();
        let sign_in = login(&fake.cli(), fake.log(), send).unwrap();
        assert_eq!(events.recv_timeout(WAIT), Ok(AuthorizeUrl("https://id.example/a?state=S".into())));
        sign_in.cancel();
        assert!(wait_gone(fake.pids()[0]));
        assert_eq!(all(&events), Vec::new());
        assert!(fake.ends().is_empty());
        assert!(logged(&fake, "sign-in: cancelled"));
        assert!(logged(&fake, "harness login --json: killed by a signal"));

        let fake = Fake::new();
        fake.script("login --json", &[SUCCESS, "@wait later"]);
        let (send, events) = channel();
        let sign_in = login(&fake.cli(), fake.log(), send).unwrap();
        assert_eq!(events.recv_timeout(WAIT), Ok(Done(Ok(()))));
        sign_in.cancel();
        let pid = fake.pids()[0];
        assert!(alive(pid));
        fake.touch("later");
        assert!(wait_gone(pid));
        // A killed run leaves no line here.
        assert_eq!(fake.ends(), ["login --json"]);
        assert!(!logged(&fake, "sign-in: cancelled"));
    }

    #[cfg(unix)]
    #[test]
    fn cancel_and_the_deadline_let_the_cli_end_by_itself() {
        // On SIGTERM `harness login` takes its code back and exits, and its spawn lock's exit hook runs.
        let fake = Fake::new();
        fake.script("login --json", &["@term", URL, "@wait never"]);
        let (send, events) = channel();
        let sign_in = login(&fake.cli(), fake.log(), send).unwrap();
        assert_eq!(events.recv_timeout(WAIT), Ok(AuthorizeUrl("https://id.example/a?state=S".into())));
        sign_in.cancel();
        assert_eq!(all(&events), Vec::new());
        assert_eq!(fake.ends(), ["login --json"]);
        assert!(logged(&fake, "harness login --json: exit 1"), "{:?}", fake.log().lines());
        // The deadline counts from the spawn, and a fake that took all of it to start has no trap yet: the deadline
        // doubles until the URL, printed once the trap is set, came first.
        let mut deadline = SHORT;
        loop {
            let fake = Fake::new();
            fake.script("login --json", &["@term", URL, "@wait never"]);
            let (send, events) = channel();
            let _login = login_within(&fake.cli(), fake.log(), send, deadline, WAIT).unwrap();
            let events = all(&events);
            assert_eq!(events.last(), Some(&failed(NO_RESULT)));
            if events.len() == 2 {
                assert_eq!(fake.ends(), ["login --json"]);
                return;
            }
            deadline *= 2;
            assert!(deadline < Duration::from_secs(10), "the fake never started in time");
        }
    }

    #[cfg(unix)]
    #[test]
    fn no_result_in_time_ends_it() {
        let fake = Fake::new();
        fake.script("login --json", &[URL, "@hang"]);
        let (send, events) = channel();
        let _login = login_within(&fake.cli(), fake.log(), send, SHORT, WAIT).unwrap();
        // The URL comes first unless the fake took the whole 300 ms to start, as it can beside other tests.
        assert_eq!(all(&events).last(), Some(&failed(NO_RESULT)));
        // The thread ends after the child, so its line is there, even when the kill came before the fake wrote its pid.
        assert!(logged(&fake, "harness login --json: killed by a signal"), "{:?}", fake.log().lines());
        assert!(fake.pids().into_iter().all(wait_gone));
        assert!(fake.ends().is_empty());
        assert!(logged(&fake, "sign-in: no result"));
    }

    #[cfg(unix)]
    #[test]
    fn after_the_result_it_waits_and_never_kills() {
        let fake = Fake::new();
        fake.script("login --json", &[SUCCESS, "@wait later"]);
        let (send, events) = channel();
        let _login = login_within(&fake.cli(), fake.log(), send, WAIT, SHORT).unwrap();
        assert_eq!(all(&events), [Done(Ok(()))]);
        let pid = fake.pids()[0];
        assert!(alive(pid));
        fake.touch("later");
        assert!(wait_gone(pid));
        assert_eq!(fake.ends(), ["login --json"]);
    }

    #[cfg(unix)]
    #[test]
    fn the_log_has_no_query_and_no_email() {
        let fake = Fake::new();
        fake.script("login --json", &["@driver", URL, WAITING, "@wait go", SUCCESS]);
        fake.touch("go");
        let (send, events) = channel();
        let _login = login(&fake.cli(), fake.log(), send).unwrap();
        all(&events);
        let lines = fake.log().lines();
        let sign_in: Vec<&String> = lines.iter().filter(|line| line.starts_with("sign-in:")).collect();
        assert_eq!(sign_in, ["sign-in: browser https://id.example/a", "sign-in: waiting", "sign-in: result success"]);
        // The run's own line too: the thread ends only after the child has.
        assert!(lines.iter().any(|line| line == "harness login --json: exit 0"), "{lines:?}");
        assert!(lines.iter().all(|line| !line.contains("state=S") && !line.contains('@')), "{lines:?}");
    }
}
