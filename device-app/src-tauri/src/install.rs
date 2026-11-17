//! The install script runs: `--host`, then `--desktop`. The screen shows the step a run is at, as fixed copy from
//! STEPS, never the script's text. The log holds only the script's step lines (`▸`, `✓`, `✗`), each run's result, and
//! after a failure the lines the screen shows: a log that took every line held a script's source and brew's output
//! (2026-11-17).

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
/// A run's step lines past these go unlogged: the script prints about 15, and one that prints without end must not
/// fill the log.
const STEP_LINES_LOGGED: usize = 200;
/// Each step line logged is cut to this many characters, so a run logs at most 200 × 512 of them. Not LINE_CHARS: a
/// checksum line runs about 185.
const STEP_LINE_CHARS: usize = 512;

/// The Install screen's step before the script names one.
pub const GETTING_READY: &str = "Getting ready…";
pub const INSTALLING_TMUX: &str = "Installing tmux…";
pub const DOWNLOADING_HARNESS: &str = "Downloading Harness…";

/// How a script step line begins, after its `▸`, and the step it shows. A line not here changes nothing, so a step
/// the script adds shows the one before it. cli/src/scripts/install.spec.ts's "keeps the step lines Harness Device
/// names" test pins these beginnings in the script.
const STEPS: [(&str, &str); 5] = [
    ("Installing the managed tmux", INSTALLING_TMUX),
    ("downloading tmux", INSTALLING_TMUX),
    ("Installing the Harness Node runtime", DOWNLOADING_HARNESS),
    ("downloading Node", DOWNLOADING_HARNESS),
    ("Installing harness", DOWNLOADING_HARNESS),
];

/// Runs one shell line, behind a trait so no test runs the script or reaches the network. `sink` gets each line as
/// it arrives.
pub trait Shell: Send + Sync {
    fn run(&self, line: &str, deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output>;
}

/// `/bin/sh -c line`, in its own process group: past the deadline curl and the script die with it.
pub struct SystemShell;

impl Shell for SystemShell {
    fn run(&self, line: &str, deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output> {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(line);
        cli::run_lines(command, deadline, sink)
    }
}

/// Some on macOS only: the install is not offered elsewhere yet, so the runner answers NOT_SUPPORTED there.
pub fn system_shell() -> Option<SystemShell> {
    cfg!(target_os = "macos").then_some(SystemShell)
}

/// HOST, then DESKTOP, each within INSTALL_DEADLINE. Each line's exit code is `/bin/sh`'s, not curl's: a curl that
/// fails hands sh nothing, and sh exits 0. So an install counts only when `cli_there()` finds a CLI after both.
/// Err holds the last lines of the run that failed, or of the last run. `on_step` is told each step as it changes.
pub fn install(
    shell: &dyn Shell,
    log: &dyn Log,
    cli_there: &dyn Fn() -> bool,
    on_step: &mut dyn FnMut(&'static str),
) -> Result<(), Vec<String>> {
    let mut last = Vec::new();
    let mut step = None;
    for (line, flag) in [(HOST, "--host"), (DESKTOP, "--desktop")] {
        let mut step_lines = 0usize;
        let mut sink = |raw: &str| {
            let Some(line) = clean(raw) else { return };
            if line.starts_with(['▸', '✓', '✗']) {
                step_lines = step_lines.saturating_add(1);
                if step_lines <= STEP_LINES_LOGGED {
                    log.line(&format!("install: {}", line.chars().take(STEP_LINE_CHARS).collect::<String>()));
                } else if step_lines == STEP_LINES_LOGGED + 1 {
                    log.line(&format!("install: {flag} more step lines not logged"));
                }
            }
            if let Some(next) = step_of(&line).filter(|next| step != Some(*next)) {
                step = Some(next);
                on_step(next);
            }
        };
        let output = shell.run(line, INSTALL_DEADLINE, &mut sink).map_err(|error| {
            log.line(&format!("install: {flag} could not start: {error}"));
            vec![error.to_string()]
        })?;
        last = clean_lines(&output);
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
            return Err(shown(log, &last, sentence));
        }
    }
    if cli_there() {
        return Ok(());
    }
    log.line("install: harness not found after it");
    Err(shown(log, &last, NOT_INSTALLED))
}

/// The step a clean line names: it starts with `▸`, then one of STEPS' beginnings.
pub fn step_of(clean: &str) -> Option<&'static str> {
    let after = clean.strip_prefix('▸')?.trim_start();
    STEPS.iter().find(|(start, _)| after.starts_with(start)).map(|&(_, step)| step)
}

/// A line as a terminal leaves it: a `\r` progress line shows its last frame. No escape or other control character,
/// trimmed, and None for an empty line: the output is outside text, bound for the screen and the log.
fn clean(line: &str) -> Option<String> {
    line.rsplit('\r').map(printable).map(|frame| frame.trim().to_string()).find(|frame| !frame.is_empty())
}

/// Each clean line of stdout, then of stderr (Output keeps them apart; a script's error is on stderr, so it comes
/// last).
fn clean_lines(output: &Output) -> Vec<String> {
    output.stdout.lines().chain(output.stderr.lines()).filter_map(clean).collect()
}

/// The last LAST_LINES of `lines`, each cut to LINE_CHARS, and logged: they are the failure's only lines in the log.
/// `sentence` when the run printed nothing, which the result's line already says.
fn shown(log: &dyn Log, lines: &[String], sentence: &str) -> Vec<String> {
    if lines.is_empty() {
        return vec![sentence.to_string()];
    }
    let shown: Vec<String> = lines[lines.len().saturating_sub(LAST_LINES)..]
        .iter()
        .map(|line| line.chars().take(LINE_CHARS).collect())
        .collect();
    for line in &shown {
        log.line(&format!("install: last: {line}"));
    }
    shown
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
        /// Hands the sink each line of the answer's stdout, then of its stderr, as a run hands them before it ends.
        fn run(&self, line: &str, deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output> {
            self.journal.lock().unwrap().push(format!("{line} ({} s)", deadline.as_secs()));
            let answer = self.answers.lock().unwrap().pop_front().expect("an answer for each run");
            if let Ok(output) = &answer {
                output.stdout.lines().chain(output.stderr.lines()).for_each(&mut *sink);
            }
            answer
        }
    }

    /// What one install did. `journal` holds each line the shell ran, and `cli?` where the CLI was looked for; `steps`
    /// each step `on_step` was told.
    struct Ran {
        result: Result<(), Vec<String>>,
        journal: Vec<String>,
        log: Vec<String>,
        steps: Vec<&'static str>,
    }

    fn install_with(answers: Vec<io::Result<Output>>, cli: bool) -> Ran {
        let journal = Arc::new(Mutex::new(Vec::new()));
        let shell = Answers { answers: Mutex::new(answers.into()), journal: journal.clone() };
        let log = MemoryLog::default();
        let cli_there = || {
            journal.lock().unwrap().push("cli?".to_string());
            cli
        };
        let mut steps = Vec::new();
        let result = install(&shell, &log, &cli_there, &mut |step| steps.push(step));
        let journal = journal.lock().unwrap().clone();
        Ran { result, journal, log: log.lines(), steps }
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
    }

    #[test]
    fn a_failure_logs_the_lines_the_screen_shows() {
        let stderr: String = (1..=10).map(|n| format!("line {n}\n")).collect();
        let ran = install_with(vec![ended(6, "", &stderr)], true);
        assert_eq!(ran.result, Err(texts(&["line 7", "line 8", "line 9", "line 10"])));
        assert_eq!(
            ran.log,
            [
                "install: --host exit 6",
                "install: last: line 7",
                "install: last: line 8",
                "install: last: line 9",
                "install: last: line 10",
            ]
        );
    }

    #[test]
    fn no_cli_after_both_runs_logs_what_the_screen_shows() {
        let no_network = "curl: (6) Could not resolve host: cdn.autonomous.ai";
        let runs = vec![ended(0, "Setting up the host\n", ""), ended(0, "", &format!("{no_network}\n"))];
        let ran = install_with(runs, false);
        assert_eq!(ran.result, Err(texts(&[no_network])));
        assert_eq!(
            ran.log,
            [
                "install: --host exit 0",
                "install: --desktop exit 0",
                "install: harness not found after it",
                &format!("install: last: {no_network}"),
            ]
        );
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
        assert_eq!(ran.log, ["install: --host timed out after 600 s", "install: last: Downloading Node"]);
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
        // The log has the lines shown, never the whole one, and no control character either.
        assert!(!ran.log.iter().any(|line| line.contains(&long)), "{:?}", ran.log);
        assert!(ran.log.iter().all(|line| !line.chars().any(char::is_control)), "{:?}", ran.log);
    }

    #[test]
    fn the_steps_a_streamed_run_yields() {
        let host = "▸ Installing the managed tmux into /x\n  ▸ downloading tmux 3.7c (darwin-arm64)…\nnoise\n\
                    ✓ tmux ready (tmux 3.7c)\n";
        let desktop = "▸ Installing the Harness Node runtime into /x\n▸ Installing harness from https://x/y.json\n";
        let ran = install_with(vec![ended(0, host, ""), ended(0, desktop, "")], true);
        assert_eq!(ran.steps, [INSTALLING_TMUX, DOWNLOADING_HARNESS]);

        // A step is a line the script marks: the same words with no `▸`, or other words after it, name none.
        let ran = install_with(vec![ended(0, "Installing harness now\n▸ Installing hn\n", ""), ended(0, "", "")], true);
        assert!(ran.steps.is_empty(), "{:?}", ran.steps);
        assert_eq!(step_of("▸ downloading Node 24.1.0 (darwin-arm64)…"), Some(DOWNLOADING_HARNESS));
        assert_eq!(step_of("Installing harness now"), None);
        assert_eq!(step_of("▸ Installing hn"), None);
    }

    #[test]
    fn only_step_lines_and_results_reach_the_log() {
        let host =
            "▸ Installing harness from https://x/y.json\n==> Pouring openssl@4\n#!/bin/sh\nset -eu\n✓ harness ready\n";
        let ran = install_with(vec![ended(0, host, ""), ended(0, "", "✗ No desktop app here\n")], true);
        assert_eq!(ran.result, Ok(()));
        assert_eq!(
            ran.log,
            [
                "install: ▸ Installing harness from https://x/y.json",
                "install: ✓ harness ready",
                "install: --host exit 0",
                "install: ✗ No desktop app here",
                "install: --desktop exit 0",
            ]
        );
    }

    #[test]
    fn a_run_logs_at_most_200_step_lines() {
        let ran = install_with(vec![ended(0, &"▸ x\n".repeat(10_000), ""), ended(0, "", "")], true);
        let count = |wanted: &str| ran.log.iter().filter(|line| *line == wanted).count();
        assert_eq!(count("install: ▸ x"), 200);
        assert_eq!(count("install: --host more step lines not logged"), 1);
        assert_eq!(ran.log.len(), 200 + 1 + 2);
    }

    #[test]
    fn a_step_line_is_logged_cut_to_512_characters() {
        // Characters of two bytes, as in the lines shown: a cut by bytes would split one.
        let long = format!("\x1b[1m▸ {}\x07\n", "é".repeat(10_000));
        let ran = install_with(vec![ended(0, &long, ""), ended(0, "", "")], true);
        let cut = format!("install: ▸ {}", "é".repeat(512 - 2));
        assert_eq!(ran.log, [cut.as_str(), "install: --host exit 0", "install: --desktop exit 0"]);
    }

    #[test]
    fn the_system_shell_is_for_macos() {
        assert_eq!(system_shell().is_some(), cfg!(target_os = "macos"));
    }

    #[cfg(unix)]
    #[test]
    fn the_system_shell_runs_through_sh() {
        let output = SystemShell.run("printf hi; exit 3", Duration::from_secs(5), &mut |_| {}).unwrap();
        assert_eq!((output.code, output.stdout.as_str()), (Some(3), "hi"));
    }

    #[cfg(unix)]
    #[test]
    fn the_system_shell_hands_its_lines() {
        let mut lines = Vec::new();
        SystemShell.run(r"printf 'a\nb\n'", Duration::from_secs(5), &mut |line| lines.push(line.to_string())).unwrap();
        assert_eq!(lines, ["a", "b"]);
    }
}
