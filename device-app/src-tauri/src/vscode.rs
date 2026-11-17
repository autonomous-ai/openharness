//! `harness device vscode status --json` and `harness device vscode enable`: the menu's Turn on VS Code.

use crate::cli::{Cli, LINE_MAX, STATUS_DEADLINE};
use crate::types::{Vscode, VscodeFailure};
use serde::Deserialize;
use std::time::Duration;

/// The CLI's own `code --install-extension` has 60 s; the rest is packing the extension and reading the status.
pub const TURN_ON_DEADLINE: Duration = Duration::from_secs(90);

/// What either word prints: `{"vscode":"absent"|"off"|"on","version"?,"error"?}`. A field it does not know is ignored.
#[derive(Deserialize)]
struct Line {
    vscode: Word,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Word {
    Absent,
    Off,
    On,
}

/// `device vscode status --json`, within STATUS_DEADLINE: exit 0 and a status line; else None, as from a CLI with no
/// such word.
pub fn status(cli: &dyn Cli) -> Option<Vscode> {
    status_within(cli, STATUS_DEADLINE)
}

fn status_within(cli: &dyn Cli, deadline: Duration) -> Option<Vscode> {
    let output = cli.run(&["device", "vscode", "status", "--json"], deadline).ok()?;
    if output.timed_out || output.code != Some(0) {
        return None;
    }
    Some(match line(&output.stdout)?.vscode {
        Word::Absent => Vscode::Absent,
        Word::Off => Vscode::Off,
        Word::On => Vscode::On,
    })
}

/// `device vscode enable`, within 90 s. Ok when it exits 0 and says on. Its `error` when that is one of the three
/// words; Timeout when the deadline passed; Failed for anything else, so no other text of the CLI's reaches the log.
pub fn turn_on(cli: &dyn Cli) -> Result<(), VscodeFailure> {
    turn_on_within(cli, TURN_ON_DEADLINE)
}

fn turn_on_within(cli: &dyn Cli, deadline: Duration) -> Result<(), VscodeFailure> {
    let output = cli.run(&["device", "vscode", "enable"], deadline).map_err(|_| VscodeFailure::Failed)?;
    if output.timed_out {
        return Err(VscodeFailure::Timeout);
    }
    let said = line(&output.stdout);
    if output.code == Some(0) && said.as_ref().is_some_and(|said| matches!(said.vscode, Word::On)) {
        return Ok(());
    }
    Err(match said.and_then(|said| said.error).as_ref().and_then(|error| error.as_str()) {
        Some("no-code") => VscodeFailure::NoCode,
        Some("timeout") => VscodeFailure::Timeout,
        _ => VscodeFailure::Failed,
    })
}

/// The first line that reads as a status: what a CLI prints is outside text.
fn line(stdout: &str) -> Option<Line> {
    stdout.lines().filter(|line| line.len() <= LINE_MAX).find_map(|line| serde_json::from_str(line).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fake;
    use crate::types::{Vscode, VscodeFailure};
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(5);
    const SHORT: Duration = Duration::from_millis(300);
    const STATUS: &str = "device vscode status --json";
    const ENABLE: &str = "device vscode enable";

    #[cfg(unix)]
    #[test]
    fn status_reads_the_three_words() {
        let cases = [
            (r#"{"vscode":"off"}"#, Vscode::Off),
            (r#"{"vscode":"on","version":"0.6.60"}"#, Vscode::On),
            (r#"{"vscode":"absent"}"#, Vscode::Absent),
        ];
        for (line, vscode) in cases {
            let fake = Fake::new();
            fake.script(STATUS, &[line]);
            assert_eq!(status(&fake.cli()), Some(vscode), "{line}");
            assert_eq!(fake.calls(), [STATUS], "{line}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_with_no_such_word_is_none() {
        let cases: [(&[&str], Duration); 6] = [
            // An older CLI: its usage, and exit 1.
            (&["@err Usage: harness device <claude|codex|orca>", "@exit 1"], WAIT),
            (&["Visual Studio Code is off"], WAIT),
            (&[r#"{"vscode":"later"}"#], WAIT),
            (&[r#"{"enabled":true}"#], WAIT),
            (&[r#"{"vscode":"off"}"#, "@exit 1"], WAIT),
            (&["@hang"], SHORT),
        ];
        for (case, (lines, deadline)) in cases.into_iter().enumerate() {
            let fake = Fake::new();
            fake.script(STATUS, lines);
            assert_eq!(status_within(&fake.cli(), deadline), None, "case {case}");
        }
        // No script: the fake says `Unknown command` and exits 1.
        assert_eq!(status(&Fake::new().cli()), None);
    }

    #[cfg(unix)]
    #[test]
    fn turn_on_is_ok_only_when_it_says_on() {
        let fake = Fake::new();
        fake.script(ENABLE, &[r#"{"vscode":"on","version":"0.6.60"}"#]);
        assert_eq!(turn_on(&fake.cli()), Ok(()));
        assert_eq!(fake.calls(), [ENABLE]);

        let cases: [&[&str]; 4] = [&[r#"{"vscode":"off"}"#], &[r#"{"vscode":"on"}"#, "@exit 1"], &["installed"], &[]];
        for lines in cases {
            let fake = Fake::new();
            fake.script(ENABLE, lines);
            assert_eq!(turn_on(&fake.cli()), Err(VscodeFailure::Failed), "{lines:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failure_keeps_the_clis_word_and_no_other_text() {
        let cases: [(&[&str], Duration, VscodeFailure); 6] = [
            (&[r#"{"vscode":"off","error":"no-code"}"#, "@exit 1"], WAIT, VscodeFailure::NoCode),
            (&[r#"{"vscode":"off","error":"timeout"}"#, "@exit 1"], WAIT, VscodeFailure::Timeout),
            (&[r#"{"vscode":"off","error":"failed"}"#, "@exit 1"], WAIT, VscodeFailure::Failed),
            // A word it does not know, which may be any text: none of it is kept.
            (&[r#"{"vscode":"off","error":"/Users/someone/.vscode"}"#, "@exit 1"], WAIT, VscodeFailure::Failed),
            (&[r#"{"vscode":"off","error":7}"#, "@exit 1"], WAIT, VscodeFailure::Failed),
            (&["@hang"], SHORT, VscodeFailure::Timeout),
        ];
        for (case, (lines, deadline, failure)) in cases.into_iter().enumerate() {
            let fake = Fake::new();
            fake.script(ENABLE, lines);
            assert_eq!(turn_on_within(&fake.cli(), deadline), Err(failure), "case {case}");
        }
        let words = [VscodeFailure::NoCode, VscodeFailure::Timeout, VscodeFailure::Failed].map(VscodeFailure::as_str);
        assert_eq!(words, ["no-code", "timeout", "failed"]);
        assert_eq!(TURN_ON_DEADLINE, Duration::from_secs(90));
    }
}
