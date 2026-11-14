//! `harness device claude status|enable|disable`.

use crate::cli::{CHANGE_DEADLINE, Cli, LINE_MAX, STATUS_DEADLINE};
use crate::types::{ClaudeStatus, Output};
use serde::Deserialize;

/// The words for a change that failed and printed nothing.
pub const FAILED: &str = "Could not change Claude Code.";

/// The longest reason shown, in characters.
const REASON_MAX: usize = 200;

/// Claude Code on this computer; `None` when the CLI could not say, as one without the command cannot.
pub fn status(cli: &dyn Cli) -> Option<ClaudeStatus> {
    let output = cli.run(&["device", "claude", "status", "--json"], STATUS_DEADLINE).ok()?;
    if output.timed_out || output.code != Some(0) {
        return None;
    }
    output
        .stdout
        .lines()
        .filter(|line| line.len() <= LINE_MAX && line.trim_start().starts_with('{'))
        .find_map(|line| serde_json::from_str(line).ok())
}

/// Turns Claude Code's voice and approvals on or off; `Err` says why it could not.
pub fn set(cli: &dyn Cli, on: bool) -> Result<(), String> {
    let output = cli
        .run(&["device", "claude", if on { "enable" } else { "disable" }], CHANGE_DEADLINE)
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
    use crate::types::ClaudeStatus;

    #[cfg(unix)]
    #[test]
    fn status_reads_the_four_fields() {
        let fake = Fake::new();
        fake.script(
            "device claude status --json",
            &[r#"{"supported":true,"installed":true,"enabled":false,"claudeVersion":"2.1.0"}"#],
        );
        assert_eq!(
            status(&fake.cli()),
            Some(ClaudeStatus {
                supported: true,
                installed: true,
                enabled: false,
                claude_version: Some("2.1.0".into())
            })
        );
        assert_eq!(fake.calls(), ["device claude status --json"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_without_the_command_has_no_claude() {
        // No script: the fake says `Unknown command` and exits 1.
        let fake = Fake::new();
        assert_eq!(status(&fake.cli()), None);
        for lines in [&["Usage: harness device <command>", "  status"][..], &["[]"][..]] {
            let fake = Fake::new();
            fake.script("device claude status --json", lines);
            assert_eq!(status(&fake.cli()), None, "{lines:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_line_without_supported_is_not_a_status() {
        let real = r#"{"supported":true,"installed":false,"enabled":false}"#;
        let fake = Fake::new();
        fake.script("device claude status --json", &[r#"{"error":"Harness is too old"}"#, "{}", r#"{"notice":"x"}"#]);
        assert_eq!(status(&fake.cli()), None);
        let fake = Fake::new();
        fake.script("device claude status --json", &[r#"{"supported":"yes"}"#, r#"{"notice":"x"}"#, real]);
        assert_eq!(status(&fake.cli()), Some(ClaudeStatus { supported: true, ..ClaudeStatus::default() }));
    }

    #[cfg(unix)]
    #[test]
    fn on_and_off_run_one_command_each() {
        for (on, call) in [(true, "device claude enable"), (false, "device claude disable")] {
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
        let cases: [(&[&str], String); 4] = [
            (
                &["@err ✗ Could not write Claude Code's settings.", "@exit 1"],
                "Could not write Claude Code's settings.".into(),
            ),
            (&[r#"{"error":"Claude Code is too old."}"#, "@exit 1"], "Claude Code is too old.".into()),
            (&["@exit 1"], FAILED.into()),
            (&[&long, "@exit 1"], "x".repeat(200)),
        ];
        for (lines, why) in cases {
            let fake = Fake::new();
            fake.script("device claude enable", lines);
            assert_eq!(set(&fake.cli(), true), Err(why), "{lines:?}");
        }
    }
}
