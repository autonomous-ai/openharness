//! The install script runs: `--host`, then `--desktop`.

use crate::cli::{self, INSTALL_DEADLINE};
use crate::log::printable;
use crate::types::{Log, Output};
use std::io;
use std::process::Command;
use std::time::Duration;

/// The desktop app's `kHarnessHostSetupCommand`, word for word. Fixed: nothing is ever added to it.
pub const HOST: &str = "curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | /bin/sh -s -- --host";
/// The desktop app's `kHarnessDesktopInstallCommand`, word for word.
pub const DESKTOP: &str = "curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | /bin/sh -s -- --desktop";

/// Off macOS: the Windows script (`install.ps1 -Desktop`) is a later wave.
pub const NOT_SUPPORTED: &str = "Not supported here.";
/// A run past its deadline that printed nothing.
pub const TIMED_OUT: &str = "Setup timed out.";
/// A run that failed, or a computer with no CLI after both runs, when the run printed nothing.
pub const NOT_INSTALLED: &str = "Harness was not installed.";
/// What the Install screen shows of a failed run: its last lines, each cut to LINE_CHARS characters.
pub const LAST_LINES: usize = 4;
pub const LINE_CHARS: usize = 120;

/// Runs one shell line, behind a trait so no test runs the script or reaches the network.
pub trait Shell: Send + Sync {
    fn run(&self, line: &str, deadline: Duration) -> io::Result<Output>;
}

/// `/bin/sh -c line`, in its own process group: past the deadline curl and the script die with it.
pub struct SystemShell;

impl Shell for SystemShell {
    fn run(&self, line: &str, deadline: Duration) -> io::Result<Output> {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(line);
        cli::run(command, deadline)
    }
}

/// Some on macOS only: the install is not offered elsewhere yet, so the runner answers NOT_SUPPORTED there.
pub fn system_shell() -> Option<SystemShell> {
    cfg!(target_os = "macos").then_some(SystemShell)
}

/// HOST, then DESKTOP, each within INSTALL_DEADLINE. Each line's exit code is `/bin/sh`'s, not curl's: a curl that
/// fails hands sh nothing, and sh exits 0. So an install counts only when `cli_there()` finds a CLI after both.
/// Err holds the last lines of the run that failed, or of the last run; each line of every run goes to `log`.
pub fn install(shell: &dyn Shell, log: &dyn Log, cli_there: &dyn Fn() -> bool) -> Result<(), Vec<String>> {
    let mut last = Vec::new();
    for (line, flag) in [(HOST, "--host"), (DESKTOP, "--desktop")] {
        let output = shell.run(line, INSTALL_DEADLINE).map_err(|error| {
            log.line(&format!("install: {flag} could not start: {error}"));
            vec![error.to_string()]
        })?;
        last = clean_lines(&output);
        for line in &last {
            log.line(&format!("install: {line}"));
        }
        let failed = if output.timed_out {
            log.line(&format!("install: {flag} timed out after {} s", INSTALL_DEADLINE.as_secs()));
            Some(TIMED_OUT)
        } else {
            log.line(&match output.code {
                Some(code) => format!("install: {flag} exit {code}"),
                None => format!("install: {flag} killed by a signal"),
            });
            (output.code != Some(0)).then_some(NOT_INSTALLED)
        };
        if let Some(sentence) = failed {
            return Err(shown(&last, sentence));
        }
    }
    if cli_there() {
        return Ok(());
    }
    log.line("install: harness not found after it");
    Err(shown(&last, NOT_INSTALLED))
}

/// Each line of stdout, then of stderr (Output keeps them apart; a script's error is on stderr, so it comes last), as
/// a terminal leaves it: a `\r` progress line shows its last frame. No escape or other control character, trimmed, and
/// an empty line dropped: the output is outside text, bound for the screen and the log.
fn clean_lines(output: &Output) -> Vec<String> {
    let clean = |line: &str| {
        line.rsplit('\r')
            .map(printable)
            .map(|frame| frame.trim().to_string())
            .find(|frame| !frame.is_empty())
    };
    output.stdout.lines().chain(output.stderr.lines()).filter_map(clean).collect()
}

/// The last LAST_LINES of `lines`, each cut to LINE_CHARS; `sentence` when the run printed nothing.
fn shown(lines: &[String], sentence: &str) -> Vec<String> {
    if lines.is_empty() {
        return vec![sentence.to_string()];
    }
    lines[lines.len().saturating_sub(LAST_LINES)..].iter().map(|line| line.chars().take(LINE_CHARS).collect()).collect()
}

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
