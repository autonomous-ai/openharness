//! The install script runs: `--host`, then `--desktop`.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{MemoryLog, Output};
    use std::collections::VecDeque;
    use std::io;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// A shell that answers each run from a list, in turn, and writes the line it was given, with its deadline, in
    /// `journal`.
    struct Answers {
        answers: Mutex<VecDeque<io::Result<Output>>>,
        journal: Arc<Mutex<Vec<String>>>,
    }

    impl Shell for Answers {
        fn run(&self, line: &str, deadline: Duration) -> io::Result<Output> {
            self.journal.lock().unwrap().push(format!("{line} ({} s)", deadline.as_secs()));
            self.answers.lock().unwrap().pop_front().expect("an answer for each run")
        }
    }

    /// What one install did. `journal` holds each line the shell ran, and `cli?` where the CLI was looked for.
    struct Ran {
        result: Result<(), Vec<String>>,
        journal: Vec<String>,
        log: Vec<String>,
    }

    fn install_with(answers: Vec<io::Result<Output>>, cli: bool) -> Ran {
        let journal = Arc::new(Mutex::new(Vec::new()));
        let shell = Answers { answers: Mutex::new(answers.into()), journal: journal.clone() };
        let log = MemoryLog::default();
        let cli_there = || {
            journal.lock().unwrap().push("cli?".to_string());
            cli
        };
        let result = install(&shell, &log, &cli_there);
        let journal = journal.lock().unwrap().clone();
        Ran { result, journal, log: log.lines() }
    }

    fn ended(code: i32, stdout: &str, stderr: &str) -> io::Result<Output> {
        Ok(Output { code: Some(code), timed_out: false, stdout: stdout.into(), stderr: stderr.into() })
    }

    fn within_ten_minutes(line: &str) -> String {
        format!("{line} (600 s)")
    }

    fn texts(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|line| line.to_string()).collect()
    }

    #[test]
    fn the_lines_are_the_desktop_apps() {
        assert_eq!(HOST, "curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | /bin/sh -s -- --host");
        assert_eq!(DESKTOP, "curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | /bin/sh -s -- --desktop");
    }

    #[test]
    fn host_then_desktop_each_with_ten_minutes() {
        let ran = install_with(vec![ended(0, "", ""), ended(0, "", "")], true);
        assert_eq!(ran.result, Ok(()));
        assert_eq!(ran.journal, [within_ten_minutes(HOST), within_ten_minutes(DESKTOP), "cli?".to_string()]);
    }

    #[test]
    fn an_install_that_leaves_no_cli_is_a_failure() {
        // `curl … | /bin/sh` exits 0 with no network: curl fails, and sh, handed nothing, ends well.
        let no_network = "curl: (6) Could not resolve host: cdn.autonomous.ai";
        let runs = vec![ended(0, "Setting up the host\n", ""), ended(0, "", &format!("{no_network}\n"))];
        let ran = install_with(runs, false);
        assert_eq!(ran.result, Err(texts(&[no_network])));
        assert_eq!(ran.journal.last().unwrap(), "cli?");
        assert_eq!(ran.log.last().unwrap(), "install: harness not found after it");
        let ran = install_with(vec![ended(0, "", ""), ended(0, "", "")], false);
        assert_eq!(ran.result, Err(texts(&[NOT_INSTALLED])));
    }

    #[test]
    fn a_failed_host_run_stops_there_with_its_last_lines() {
        let stderr: String = (1..=10).map(|n| format!("line {n}\n")).collect();
        let ran = install_with(vec![ended(6, "", &stderr)], true);
        assert_eq!(ran.result, Err(texts(&["line 7", "line 8", "line 9", "line 10"])));
        // A CLI may well be there: a failed run is a failure all the same, and nothing runs after it.
        assert_eq!(ran.journal, [within_ten_minutes(HOST)]);
        assert_eq!(ran.log.last().unwrap(), "install: --host exit 6");
    }

    #[test]
    fn a_failure_that_printed_nothing_says_so() {
        let killed = Ok(Output { code: None, ..Output::default() });
        let ran = install_with(vec![killed], true);
        assert_eq!(ran.result, Err(texts(&[NOT_INSTALLED])));
        assert_eq!(ran.log, ["install: --host killed by a signal"]);
        let ran = install_with(vec![ended(0, "", ""), ended(1, "", "")], true);
        assert_eq!(ran.result, Err(texts(&[NOT_INSTALLED])));
        assert_eq!(ran.journal, [within_ten_minutes(HOST), within_ten_minutes(DESKTOP)]);
    }

    #[test]
    fn a_run_past_its_deadline_is_a_failure() {
        let late = |stderr: &str| Ok(Output { timed_out: true, stderr: stderr.into(), ..Output::default() });
        let ran = install_with(vec![late("Downloading Node\n")], true);
        assert_eq!(ran.result, Err(texts(&["Downloading Node"])));
        assert_eq!(ran.journal, [within_ten_minutes(HOST)]);
        assert_eq!(ran.log.last().unwrap(), "install: --host timed out after 600 s");
        let ran = install_with(vec![late("")], true);
        assert_eq!(ran.result, Err(texts(&[TIMED_OUT])));
    }

    #[test]
    fn a_shell_that_cannot_start_is_a_failure() {
        let ran = install_with(vec![Err(io::Error::new(io::ErrorKind::NotFound, "no shell here"))], true);
        assert_eq!(ran.result, Err(texts(&["no shell here"])));
        assert_eq!(ran.journal, [within_ten_minutes(HOST)]);
        assert_eq!(ran.log, ["install: --host could not start: no shell here"]);
    }

    #[test]
    fn the_lines_shown_are_clean_and_short() {
        assert_eq!((LAST_LINES, LINE_CHARS), (4, 120));
        // Characters of two bytes: a cut by bytes would split one.
        let long = "é".repeat(10_000);
        let stdout = "Installing Harness\n\n";
        let stderr = format!("\x1b[31merror:\x1b[0m download failed\n 10%\r 55%\r100%\r\x1b[K\n{long}\n  \n\x07\n");
        let ran = install_with(vec![ended(1, stdout, &stderr)], true);
        let lines = ran.result.unwrap_err();
        assert_eq!(lines, ["Installing Harness", "error: download failed", "100%", &"é".repeat(LINE_CHARS)]);
        for line in &lines {
            assert!(!line.is_empty() && line.chars().count() <= LINE_CHARS, "{line:?}");
            assert!(!line.chars().any(char::is_control), "{line:?}");
        }
        // The log has each line whole, and no control character either.
        assert!(ran.log.contains(&format!("install: {long}")));
        assert!(ran.log.iter().all(|line| !line.chars().any(char::is_control)), "{:?}", ran.log);
    }

    #[test]
    fn the_whole_output_goes_to_the_log() {
        let host = ended(0, "Installing Harness\nHarness 0.5.8\n", "warning: slow mirror\n");
        let ran = install_with(vec![host, ended(0, "The desktop app is ready\n", "")], true);
        assert_eq!(
            ran.log,
            [
                "install: Installing Harness",
                "install: Harness 0.5.8",
                "install: warning: slow mirror",
                "install: --host exit 0",
                "install: The desktop app is ready",
                "install: --desktop exit 0",
            ]
        );
    }

    #[test]
    fn the_system_shell_is_for_macos() {
        assert_eq!(system_shell().is_some(), cfg!(target_os = "macos"));
    }

    #[cfg(unix)]
    #[test]
    fn the_system_shell_runs_through_sh() {
        let output = SystemShell.run("printf hi; exit 3", Duration::from_secs(5)).unwrap();
        assert_eq!((output.code, output.stdout.as_str()), (Some(3), "hi"));
    }
}
