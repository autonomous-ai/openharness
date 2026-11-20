//! The install script runs: on macOS `--host`, then `--desktop`; on Linux the same, `--host` in a terminal the person
//! sees; on Windows install.ps1 `-Desktop`, once. The screen shows the step a run is at, as fixed copy, never the
//! script's text. The log holds only the script's step lines, each run's result, and after a failure the lines the
//! screen shows: a log that took every line held a script's source and brew's output (2026-11-17).

use crate::cli::{self, INSTALL_DEADLINE};
use crate::log::{printable, redact};
use crate::types::{Log, Output};
use std::ffi::OsStr;
use std::io;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

/// The desktop app's `kHarnessHostSetupCommand`, word for word. Fixed: nothing is ever added to it.
pub const HOST: &str = "curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | /bin/sh -s -- --host";
/// The desktop app's `kHarnessDesktopInstallCommand`, word for word.
pub const DESKTOP: &str = "curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | /bin/sh -s -- --desktop";
/// The desktop app's `windowsInstallCommand`, word for word: install.ps1 `-Desktop`, read as UTF-8, its exit code
/// PowerShell's (under `iex` the script sets `$LASTEXITCODE` rather than exiting).
pub const WINDOWS: &str = r#"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); iex "& { $(irm 'https://cdn.autonomous.ai/harness/cli/install.ps1' -ErrorAction Stop) } -Desktop"; exit $LASTEXITCODE"#;
/// `powershell.exe`'s arguments before WINDOWS, the desktop app's `windowsInstallArguments`.
pub const POWERSHELL_ARGS: [&str; 5] = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

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
/// While Linux's host half runs in a terminal: its lines are the person's there, and name no step here.
pub const FINISH_IN_TERMINAL: &str = "Finish in the terminal…";

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
/// How an install.ps1 line that shows DOWNLOADING_HARNESS begins. install.ps1 marks no step with `▸` and has no tmux
/// step. cli/src/scripts/installPs1.spec.ts's "keeps the step lines Harness Device names" test pins these beginnings
/// and WINDOWS_DONE's in the script.
const WINDOWS_STEPS: [&str; 3] = ["Downloading Node ", "Downloading Harness ", "Downloading the terminal host "];
/// The rest of install.ps1's step lines the log keeps: a step done, and the failure.
const WINDOWS_DONE: [&str; 2] = ["OK ", "Harness could not be installed. The step that failed: "];

/// Where a run happens: behind the Install screen, or in a terminal the person sees, where `sudo` can ask for their
/// password.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    Background,
    Terminal,
}

/// One fixed line an install runs, and the flag the log names it by.
#[derive(Debug, PartialEq, Eq)]
pub struct Run {
    pub line: &'static str,
    pub flag: &'static str,
    pub place: Place,
}

static MACOS_RUNS: [Run; 2] = [
    Run { line: HOST, flag: "--host", place: Place::Background },
    Run { line: DESKTOP, flag: "--desktop", place: Place::Background },
];
/// On a fresh Ubuntu `--host` reaches `sudo apt-get` (tmux, a clipboard helper), so it runs in a terminal, as the
/// desktop app runs it there.
static LINUX_RUNS: [Run; 2] = [
    Run { line: HOST, flag: "--host", place: Place::Terminal },
    Run { line: DESKTOP, flag: "--desktop", place: Place::Background },
];
/// install.ps1 has no host half: it installs the terminal host itself.
static WINDOWS_RUNS: [Run; 1] = [Run { line: WINDOWS, flag: "-Desktop", place: Place::Background }];

/// The runs of an install on `os` (`std::env::consts::OS`), in order. macOS's on any other: the app is built for none.
pub fn runs(os: &str) -> &'static [Run] {
    match os {
        "linux" => &LINUX_RUNS,
        "windows" => &WINDOWS_RUNS,
        _ => &MACOS_RUNS,
    }
}

/// Runs one of an install's runs, behind a trait so no test runs the script or reaches the network. `sink` gets each
/// line as it arrives; a run in a terminal hands it none, and is NotFound where there is no terminal.
pub trait Shell: Send + Sync {
    fn run(&self, run: &Run, deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output>;
}

/// A run behind the screen is `/bin/sh -c line`, or Windows PowerShell on Windows, in its own process group (a job on
/// Windows): past the deadline curl and the script die with it. A run in a terminal writes its script in `folder`.
pub struct SystemShell {
    pub folder: PathBuf,
}

impl Shell for SystemShell {
    fn run(&self, run: &Run, deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output> {
        // Only Linux's runs have one in a terminal.
        #[cfg(any(target_os = "linux", all(test, unix)))]
        if run.place == Place::Terminal {
            return crate::terminal::run(
                &self.folder,
                run.line,
                deadline,
                &crate::terminal::start,
                &std::time::Instant::now,
                &std::thread::sleep,
            );
        }
        cli::run_lines(background(run.line), deadline, sink)
    }
}

#[cfg(unix)]
fn background(line: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(line);
    command
}

/// `line` is one argument: std quotes it for CreateProcessW, and no shell parses it again.
#[cfg(windows)]
fn background(line: &str) -> Command {
    let mut command = Command::new(powershell(std::env::var_os("SystemRoot").as_deref()));
    command.args(POWERSHELL_ARGS).arg(line);
    command
}

/// Windows PowerShell by its full path under `system_root`, `C:\Windows` when it is unset or empty: a bare
/// `powershell.exe` is looked for in the working folder before System32. Joined as text, so it reads the same on every
/// OS.
pub fn powershell(system_root: Option<&OsStr>) -> PathBuf {
    let root = system_root.filter(|root| !root.is_empty()).unwrap_or(OsStr::new(r"C:\Windows"));
    let mut path = root.to_os_string();
    path.push(r"\System32\WindowsPowerShell\v1.0\powershell.exe");
    path.into()
}

/// A terminal run's script goes in `<data>/setup`.
pub fn system_shell(data: PathBuf) -> SystemShell {
    SystemShell { folder: data.join("setup") }
}

/// `runs(os)`, in order, each within INSTALL_DEADLINE. A unix line's exit code is `/bin/sh`'s, not curl's: a curl
/// that fails hands sh nothing, and sh exits 0. So an install counts only when `cli_there()` finds a CLI after its runs.
/// Err holds the last lines of the run that failed, or of the last run. `on_step` is told each step as it changes: a
/// run in a terminal is FINISH_IN_TERMINAL, then GETTING_READY once it has ended well, or at once where there is no
/// terminal and it runs behind the screen.
pub fn install(
    os: &str,
    shell: &dyn Shell,
    log: &dyn Log,
    cli_there: &dyn Fn() -> bool,
    on_step: &mut dyn FnMut(&'static str),
) -> Result<(), Vec<String>> {
    let mut last = Vec::new();
    let mut step = None;
    for run in runs(os) {
        let flag = run.flag;
        let terminal = (run.place == Place::Terminal).then(|| {
            step = Some(FINISH_IN_TERMINAL);
            on_step(FINISH_IN_TERMINAL);
            shell.run(run, INSTALL_DEADLINE, &mut |_| {})
        });
        // No terminal here: the line runs behind the screen, as on macOS, and where it needs a password install.sh's
        // own lines say what to run.
        let terminal = match terminal {
            Some(Err(error)) if error.kind() == io::ErrorKind::NotFound => {
                log.line(&format!("install: {flag} no terminal; run here"));
                step = Some(GETTING_READY);
                on_step(GETTING_READY);
                None
            }
            terminal => terminal,
        };
        let in_terminal = terminal.is_some();
        let output = match terminal {
            Some(output) => output,
            None => {
                let mut step_lines = 0usize;
                let mut sink = |raw: &str| {
                    let Some(line) = clean(raw) else { return };
                    if is_step_line(os, &line) {
                        step_lines = step_lines.saturating_add(1);
                        if step_lines <= STEP_LINES_LOGGED {
                            log.line(&format!("install: {}", logged(&line, STEP_LINE_CHARS)));
                        } else if step_lines == STEP_LINES_LOGGED + 1 {
                            log.line(&format!("install: {flag} more step lines not logged"));
                        }
                    }
                    if let Some(next) = step_of(os, &line).filter(|next| step != Some(*next)) {
                        step = Some(next);
                        on_step(next);
                    }
                };
                shell.run(&Run { place: Place::Background, ..*run }, INSTALL_DEADLINE, &mut sink)
            }
        }
        .map_err(|error| {
            log.line(&format!("install: {flag} could not start: {error}"));
            vec![error.to_string()]
        })?;
        last = clean_lines(os, &output);
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
        if in_terminal {
            step = Some(GETTING_READY);
            on_step(GETTING_READY);
        }
    }
    if cli_there() {
        return Ok(());
    }
    log.line("install: harness not found after it");
    Err(shown(log, &last, NOT_INSTALLED))
}

/// The step a clean line names on `os`: on Windows it starts with one of WINDOWS_STEPS; elsewhere with `▸`, then one
/// of STEPS' beginnings.
pub fn step_of(os: &str, clean: &str) -> Option<&'static str> {
    if os == "windows" {
        return WINDOWS_STEPS.iter().any(|start| clean.starts_with(start)).then_some(DOWNLOADING_HARNESS);
    }
    let after = clean.strip_prefix('▸')?.trim_start();
    STEPS.iter().find(|(start, _)| after.starts_with(start)).map(|&(_, step)| step)
}

/// Whether the log keeps a clean line: one of install.ps1's step lines on Windows, a `▸`, `✓` or `✗` line elsewhere.
fn is_step_line(os: &str, clean: &str) -> bool {
    if os == "windows" {
        WINDOWS_STEPS.iter().chain(&WINDOWS_DONE).any(|start| clean.starts_with(start))
    } else {
        clean.starts_with(['▸', '✓', '✗'])
    }
}

/// A line as a terminal leaves it: a `\r` progress line shows its last frame. No escape or other control character,
/// trimmed, and None for an empty line: the output is outside text, bound for the screen and the log.
fn clean(line: &str) -> Option<String> {
    line.rsplit('\r').map(printable).map(|frame| frame.trim().to_string()).find(|frame| !frame.is_empty())
}

/// Each clean line of stdout, then of stderr (Output keeps them apart; a script's error is on stderr, so it comes
/// last). On Windows, without the lines Windows PowerShell writes below an error's first line, `At line:` and those
/// that begin `+`: the last lines would be those alone, and not the one that says why.
fn clean_lines(os: &str, output: &Output) -> Vec<String> {
    let lines = output.stdout.lines().chain(output.stderr.lines()).filter_map(clean);
    lines.filter(|line| os != "windows" || !(line.starts_with('+') || line.starts_with("At line:"))).collect()
}

/// The last LAST_LINES of `lines`, each cut to LINE_CHARS, and logged: they are the failure's only lines in the log.
/// `sentence` when the run printed nothing, which the result's line already says.
fn shown(log: &dyn Log, lines: &[String], sentence: &str) -> Vec<String> {
    if lines.is_empty() {
        return vec![sentence.to_string()];
    }
    let last = &lines[lines.len().saturating_sub(LAST_LINES)..];
    for line in last {
        log.line(&format!("install: last: {}", logged(line, LINE_CHARS)));
    }
    last.iter().map(|line| line.chars().take(LINE_CHARS).collect()).collect()
}

/// `line` as the log keeps it: redacted whole, then cut to `chars`. Cut first, the part of an address, a secret or the
/// person's home folder left before the cut no longer reads as one, and the log's own redaction would keep it.
fn logged(line: &str, chars: usize) -> String {
    redact(line).chars().take(chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{MemoryLog, Output};
    use std::collections::VecDeque;
    use std::ffi::OsStr;
    use std::io;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// A shell that answers each run from a list, in turn, and writes the line it was given, with its deadline and, for
    /// one in a terminal, its place, in `journal`.
    struct Answers {
        answers: Mutex<VecDeque<io::Result<Output>>>,
        journal: Arc<Mutex<Vec<String>>>,
    }

    impl Shell for Answers {
        /// Hands the sink each line of the answer's stdout, then of its stderr, as a run hands them before it ends.
        fn run(&self, run: &Run, deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output> {
            let place = if run.place == Place::Terminal { ", in a terminal" } else { "" };
            self.journal.lock().unwrap().push(format!("{} ({} s{place})", run.line, deadline.as_secs()));
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
        install_on("macos", answers, cli)
    }

    fn install_on(os: &str, answers: Vec<io::Result<Output>>, cli: bool) -> Ran {
        let journal = Arc::new(Mutex::new(Vec::new()));
        let shell = Answers { answers: Mutex::new(answers.into()), journal: journal.clone() };
        let log = MemoryLog::default();
        let cli_there = || {
            journal.lock().unwrap().push("cli?".to_string());
            cli
        };
        let mut steps = Vec::new();
        let result = install(os, &shell, &log, &cli_there, &mut |step| steps.push(step));
        let journal = journal.lock().unwrap().clone();
        Ran { result, journal, log: log.lines(), steps }
    }

    fn ended(code: i32, stdout: &str, stderr: &str) -> io::Result<Output> {
        Ok(Output { code: Some(code), timed_out: false, stdout: stdout.into(), stderr: stderr.into() })
    }

    fn within_ten_minutes(line: &str) -> String {
        format!("{line} (600 s)")
    }

    fn in_a_terminal(line: &str) -> String {
        format!("{line} (600 s, in a terminal)")
    }

    fn texts(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|line| line.to_string()).collect()
    }

    /// A run behind the Install screen; its flag names it in the log only.
    fn behind_the_screen(line: &'static str) -> Run {
        Run { line, flag: "--host", place: Place::Background }
    }

    #[test]
    fn the_lines_are_the_desktop_apps() {
        assert_eq!(HOST, "curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | /bin/sh -s -- --host");
        assert_eq!(DESKTOP, "curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | /bin/sh -s -- --desktop");
    }

    #[test]
    fn the_windows_line_is_the_desktop_apps() {
        assert_eq!(
            WINDOWS,
            r#"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); iex "& { $(irm 'https://cdn.autonomous.ai/harness/cli/install.ps1' -ErrorAction Stop) } -Desktop"; exit $LASTEXITCODE"#
        );
    }

    #[test]
    fn powershell_is_named_by_its_full_path() {
        assert_eq!(POWERSHELL_ARGS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
        let windows = PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        assert_eq!(powershell(None), windows);
        assert_eq!(powershell(Some(OsStr::new(""))), windows);
        assert_eq!(
            powershell(Some(OsStr::new(r"D:\WINNT"))),
            PathBuf::from(r"D:\WINNT\System32\WindowsPowerShell\v1.0\powershell.exe")
        );
    }

    #[test]
    fn the_runs_of_each_os() {
        let run = |line, flag, place| Run { line, flag, place };
        assert_eq!(
            runs("macos"),
            [run(HOST, "--host", Place::Background), run(DESKTOP, "--desktop", Place::Background)]
        );
        assert_eq!(runs("linux"), [run(HOST, "--host", Place::Terminal), run(DESKTOP, "--desktop", Place::Background)]);
        assert_eq!(runs("windows"), [run(WINDOWS, "-Desktop", Place::Background)]);
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
        assert_eq!(step_of("macos", "▸ downloading Node 24.1.0 (darwin-arm64)…"), Some(DOWNLOADING_HARNESS));
        assert_eq!(step_of("macos", "Installing harness now"), None);
        assert_eq!(step_of("macos", "▸ Installing hn"), None);
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
    fn a_logged_line_is_redacted_before_it_is_cut() {
        // An address across each cut: cut first, `someone` no longer reads as an address and the log would keep it.
        let step = format!("▸ {} someone@example.com", "a".repeat(STEP_LINE_CHARS - 10));
        let failed = format!("{} someone@example.com", "a".repeat(LINE_CHARS - 8));
        let ran = install_with(vec![ended(1, &format!("{step}\n"), &format!("{failed}\n"))], true);
        let shown = [format!("▸ {}", "a".repeat(LINE_CHARS - 2)), format!("{} someone", "a".repeat(LINE_CHARS - 8))];
        // The screen is the person's own: it keeps the cut lines as they are.
        assert_eq!(ran.result, Err(shown.to_vec()));
        assert_eq!(
            ran.log,
            [
                format!("install: ▸ {} <email>", "a".repeat(STEP_LINE_CHARS - 10)),
                "install: --host exit 1".to_string(),
                format!("install: last: {}", shown[0]),
                format!("install: last: {} <email>", "a".repeat(LINE_CHARS - 8)),
            ]
        );
    }

    #[test]
    fn a_windows_run_shows_downloading_harness_and_logs_only_its_step_lines() {
        let failed = "Harness could not be installed. The step that failed: Node.";
        let stdout = [
            "  Downloading Node 24.22.2 (win32-x64)...",
            "  Connection interrupted; retrying (1/3)...",
            r"  OK Node 24.22.2 -> C:\x",
            "",
            failed,
            "  The response ended prematurely.",
            "  Run the installer again, or send this message to Harness support.",
        ]
        .join("\n");
        let ran = install_on("windows", vec![ended(1, &stdout, "")], true);
        assert_eq!(ran.journal, [within_ten_minutes(WINDOWS)]);
        assert_eq!(ran.steps, [DOWNLOADING_HARNESS]);
        let shown = [
            r"OK Node 24.22.2 -> C:\x",
            failed,
            "The response ended prematurely.",
            "Run the installer again, or send this message to Harness support.",
        ];
        assert_eq!(ran.result, Err(texts(&shown)));
        let mut log = texts(&[
            "install: Downloading Node 24.22.2 (win32-x64)...",
            r"install: OK Node 24.22.2 -> C:\x",
            &format!("install: {failed}"),
            "install: -Desktop exit 1",
        ]);
        log.extend(shown.iter().map(|line| format!("install: last: {line}")));
        assert_eq!(ran.log, log);
    }

    #[test]
    fn a_windows_error_record_shows_the_line_that_says_why() {
        // Windows PowerShell 5.1's record of an `irm` that could not reach the CDN, on stderr: below the line that says
        // why, where in the command it failed and what kind of error it was.
        let why = "irm : The remote name could not be resolved: 'cdn.autonomous.ai'";
        let record = [
            why,
            "At line:1 char:76",
            "+ ... ing]::new($false); iex \"& { $(irm 'https://cdn.autonomous.ai/harness/ ...",
            "+                                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
            "    + CategoryInfo          : InvalidOperation: (System.Net.HttpWebRequest:HttpWebRequest) \
             [Invoke-RestMethod], WebException",
            "    + FullyQualifiedErrorId : WebCmdletWebResponseException,\
             Microsoft.PowerShell.Commands.InvokeRestMethodCommand",
            " ",
        ]
        .join("\r\n");
        let ran = install_on("windows", vec![ended(1, "", &record)], true);
        assert_eq!(ran.result, Err(texts(&[why])));
        assert_eq!(ran.log, ["install: -Desktop exit 1".to_string(), format!("install: last: {why}")]);

        // Elsewhere a line that begins `+` is one of the script's own, and shown.
        let ran = install_with(vec![ended(1, "", "+ x\n")], true);
        assert_eq!(ran.result, Err(texts(&["+ x"])));
    }

    #[test]
    fn a_unix_step_line_is_no_windows_step_and_the_reverse() {
        for line in ["Downloading Harness 0.6.20...", "Downloading the terminal host 0.6.20..."] {
            assert_eq!(step_of("windows", line), Some(DOWNLOADING_HARNESS));
        }
        let unix = "▸ Installing harness from https://x/y.json";
        assert_eq!(step_of("windows", unix), None);
        for os in ["macos", "linux"] {
            assert_eq!(step_of(os, unix), Some(DOWNLOADING_HARNESS));
            assert_eq!(step_of(os, "Downloading Node 24.22.2 (win32-x64)..."), None);
        }

        // Nor does the log keep one as the other's step line.
        let ran = install_on("windows", vec![ended(0, &format!("{unix}\n✓ harness ready\n"), "")], true);
        assert!(ran.steps.is_empty(), "{:?}", ran.steps);
        assert_eq!(ran.log, ["install: -Desktop exit 0"]);
        let windows = "  Downloading Harness 0.6.20...\n  OK Harness 0.6.20 -> /x\n";
        let ran = install_with(vec![ended(0, windows, ""), ended(0, "", "")], true);
        assert!(ran.steps.is_empty(), "{:?}", ran.steps);
        assert_eq!(ran.log, ["install: --host exit 0", "install: --desktop exit 0"]);
    }

    #[test]
    fn a_terminal_run_shows_finish_in_the_terminal_then_getting_ready() {
        assert_eq!(FINISH_IN_TERMINAL, "Finish in the terminal…");
        // The steps told and the runs in one journal: the terminal's step is told before it starts.
        let journal = Arc::new(Mutex::new(Vec::new()));
        let runs = vec![ended(0, "", ""), ended(0, "▸ Installing harness from https://x/y.json\n", "")];
        let shell = Answers { answers: Mutex::new(runs.into()), journal: journal.clone() };
        let told = |step: &str| journal.lock().unwrap().push(step.to_string());
        let result = install("linux", &shell, &MemoryLog::default(), &|| true, &mut |step| told(step));
        assert_eq!(result, Ok(()));
        assert_eq!(
            *journal.lock().unwrap(),
            [
                FINISH_IN_TERMINAL.to_string(),
                in_a_terminal(HOST),
                GETTING_READY.to_string(),
                within_ten_minutes(DESKTOP),
                DOWNLOADING_HARNESS.to_string(),
            ]
        );
    }

    #[test]
    fn a_terminal_run_that_failed_stops_there() {
        // 129: the terminal was closed before the line ended.
        let ran = install_on("linux", vec![ended(129, "", "")], true);
        assert_eq!(ran.result, Err(texts(&[NOT_INSTALLED])));
        assert_eq!(ran.journal, [in_a_terminal(HOST)]);
        assert_eq!(ran.log, ["install: --host exit 129"]);
        assert_eq!(ran.steps, [FINISH_IN_TERMINAL]);
    }

    #[test]
    fn with_no_terminal_the_host_half_runs_behind_the_screen() {
        let no_terminal = || Err(io::Error::new(io::ErrorKind::NotFound, "No terminal found."));
        let host = "▸ Installing required Linux packages (you may be asked for your password): tmux\n\
                    ✓ tmux ready (tmux 3.4)\n";
        let ran = install_on("linux", vec![no_terminal(), ended(0, host, ""), ended(0, "", "")], true);
        assert_eq!(ran.result, Ok(()));
        assert_eq!(
            ran.journal,
            [in_a_terminal(HOST), within_ten_minutes(HOST), within_ten_minutes(DESKTOP), "cli?".to_string()]
        );
        // Not in a terminal: the screen is back to its own step.
        assert_eq!(ran.steps, [FINISH_IN_TERMINAL, GETTING_READY]);
        assert_eq!(
            ran.log,
            [
                "install: --host no terminal; run here",
                "install: ▸ Installing required Linux packages (you may be asked for your password): tmux",
                "install: ✓ tmux ready (tmux 3.4)",
                "install: --host exit 0",
                "install: --desktop exit 0",
            ]
        );

        // A host half that needs a password: with no terminal sudo cannot ask, and install.sh's own lines say what
        // to run (its lines on Debian 12, with sudo 1.9.13 and no tty).
        let sudo = "sudo: a terminal is required to read the password; either use the -S option to read from standard \
                    input or configure an askpass helper";
        let stderr = format!(
            "{sudo}\nsudo: a password is required\n✗ Could not install tmux procps via apt-get.\n  \
             Retry with: sudo apt-get install -y tmux procps\n"
        );
        let ran = install_on("linux", vec![no_terminal(), ended(22, "", &stderr)], true);
        let shown = [
            sudo.chars().take(LINE_CHARS).collect(),
            "sudo: a password is required".to_string(),
            "✗ Could not install tmux procps via apt-get.".to_string(),
            "Retry with: sudo apt-get install -y tmux procps".to_string(),
        ];
        assert_eq!(ran.result, Err(shown.to_vec()));
        assert_eq!(ran.journal, [in_a_terminal(HOST), within_ten_minutes(HOST)]);
    }

    #[test]
    fn a_terminal_runs_script_is_in_the_setup_folder() {
        let data = PathBuf::from("data");
        assert_eq!(system_shell(data.clone()).folder, data.join("setup"));
    }

    #[cfg(unix)]
    #[test]
    fn the_system_shell_runs_through_sh() {
        let shell = system_shell(std::env::temp_dir());
        let output = shell.run(&behind_the_screen("printf hi; exit 3"), Duration::from_secs(5), &mut |_| {}).unwrap();
        assert_eq!((output.code, output.stdout.as_str()), (Some(3), "hi"));
    }

    #[cfg(unix)]
    #[test]
    fn the_system_shell_hands_its_lines() {
        let mut lines = Vec::new();
        system_shell(std::env::temp_dir())
            .run(&behind_the_screen(r"printf 'a\nb\n'"), Duration::from_secs(5), &mut |line| {
                lines.push(line.to_string())
            })
            .unwrap();
        assert_eq!(lines, ["a", "b"]);
    }

    #[cfg(windows)]
    #[test]
    fn powershell_takes_a_command_with_quotes_inside_whole() {
        let mut lines = Vec::new();
        // A bound, not a wait: Windows PowerShell can take seconds to start on a busy runner.
        let output = system_shell(std::env::temp_dir())
            .run(&behind_the_screen(r#"iex "& { 'hi' }"; exit 7"#), Duration::from_secs(60), &mut |line| {
                lines.push(line.trim_end().to_string())
            })
            .unwrap();
        assert_eq!((output.code, lines), (Some(7), vec!["hi".to_string()]));
    }
}
