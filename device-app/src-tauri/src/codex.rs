//! `harness device codex status|enable|disable`.

use crate::cli::{CHANGE_DEADLINE, Cli, LINE_MAX, STATUS_DEADLINE};
use crate::types::{CodexStatus, Output};
use serde::Deserialize;
use serde_json::Value;

/// The words for a change that failed and printed nothing.
pub const FAILED: &str = "Could not change Codex.";

/// The longest reason shown, in characters.
const REASON_MAX: usize = 200;

/// Codex on this computer; `None` when the CLI could not say, as one without the command cannot.
pub fn status(cli: &dyn Cli) -> Option<CodexStatus> {
    let output = cli.run(&["device", "codex", "status", "--json"], STATUS_DEADLINE).ok()?;
    if output.timed_out || output.code != Some(0) {
        return None;
    }
    output.stdout.lines().filter(|line| line.len() <= LINE_MAX && line.trim_start().starts_with('{')).find_map(|line| {
        let line: Value = serde_json::from_str(line).ok()?;
        // CodexStatus has a default for every field, so an `{"error":…}` or a notice would read as one.
        line.get("supported")?.as_bool()?;
        serde_json::from_value(line).ok()
    })
}

/// Adds or removes Codex's dial skill; `Err` says why it could not.
pub fn set(cli: &dyn Cli, on: bool) -> Result<(), String> {
    let output = cli
        .run(&["device", "codex", if on { "enable" } else { "disable" }], CHANGE_DEADLINE)
        .map_err(|_| FAILED.to_string())?;
    if output.timed_out || output.code != Some(0) {
        return Err(reason(&output));
    }
    Ok(())
}

/// The CLI's own words for a failure: its last line, stderr first, the `error` or `message` of a JSON one.
fn reason(output: &Output) -> String {
    #[derive(Deserialize)]
    struct Said {
        error: Option<String>,
        message: Option<String>,
    }
    let last = |text: &str| text.lines().rev().map(str::trim).find(|line| !line.is_empty()).map(String::from);
    let Some(line) = last(&output.stderr).or_else(|| last(&output.stdout)) else {
        return FAILED.into();
    };
    let line = match serde_json::from_str::<Said>(&line) {
        Ok(Said { error: Some(text), .. } | Said { message: Some(text), .. }) => text,
        _ => line,
    };
    let line: String = line.trim_start_matches(['✗', ' ']).chars().take(REASON_MAX).collect();
    if line.trim().is_empty() { FAILED.into() } else { line }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fake;
    use crate::types::CodexStatus;

    #[cfg(unix)]
    #[test]
    fn status_reads_the_three_fields() {
        let fake = Fake::new();
        fake.script("device codex status --json", &[r#"{"supported":true,"installed":true,"enabled":false}"#]);
        assert_eq!(status(&fake.cli()), Some(CodexStatus { supported: true, installed: true, enabled: false }));
        assert_eq!(fake.calls(), ["device codex status --json"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_without_the_command_has_no_codex() {
        // No script: the fake says `Unknown command` and exits 1.
        let fake = Fake::new();
        assert_eq!(status(&fake.cli()), None);
        for lines in [&["Usage: harness device <command>", "  status"][..], &["[]"][..]] {
            let fake = Fake::new();
            fake.script("device codex status --json", lines);
            assert_eq!(status(&fake.cli()), None, "{lines:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_line_without_supported_is_not_a_status() {
        let fake = Fake::new();
        fake.script("device codex status --json", &[r#"{"error":"x"}"#, "{}"]);
        assert_eq!(status(&fake.cli()), None);
    }

    #[cfg(unix)]
    #[test]
    fn on_and_off_run_one_command_each() {
        for (on, call) in [(true, "device codex enable"), (false, "device codex disable")] {
            let fake = Fake::new();
            fake.script(call, &["Done."]);
            assert_eq!(set(&fake.cli(), on), Ok(()));
            assert_eq!(fake.calls(), [call]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failure_says_why() {
        let long = "x".repeat(300);
        let cases: [(&[&str], String); 3] = [
            (&["@err Codex is not on this computer.", "@exit 1"], "Codex is not on this computer.".into()),
            (&["@exit 1"], FAILED.into()),
            (&[&long, "@exit 1"], "x".repeat(200)),
        ];
        for (lines, why) in cases {
            let fake = Fake::new();
            fake.script("device codex enable", lines);
            assert_eq!(set(&fake.cli(), true), Err(why), "{lines:?}");
        }
    }
}
