//! `harness device claude|codex status|enable|disable`.

use crate::cli::{CHANGE_DEADLINE, Cli, LINE_MAX, STATUS_DEADLINE};
use crate::types::Output;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// An agent the dial can be turned on for. Its word is fixed here, so no command line takes text from elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Claude,
    Codex,
}

impl Engine {
    /// The CLI's word for it: `harness device <word> …`.
    fn word(self) -> &'static str {
        match self {
            Engine::Claude => "claude",
            Engine::Codex => "codex",
        }
    }

    /// The words for a change that failed and printed nothing.
    fn failed(self) -> &'static str {
        match self {
            Engine::Claude => "Could not change Claude Code.",
            Engine::Codex => "Could not change Codex.",
        }
    }
}

/// The longest reason shown, in characters.
const REASON_MAX: usize = 200;

/// The engine on this computer; `None` when the CLI could not say, as one without the command cannot.
pub fn status<T: DeserializeOwned>(cli: &dyn Cli, engine: Engine) -> Option<T> {
    let output = cli.run(&["device", engine.word(), "status", "--json"], STATUS_DEADLINE).ok()?;
    if output.timed_out || output.code != Some(0) {
        return None;
    }
    output.stdout.lines().filter(|line| line.len() <= LINE_MAX && line.trim_start().starts_with('{')).find_map(|line| {
        let line: Value = serde_json::from_str(line).ok()?;
        // A status has a default for every field, so an `{"error":…}` or a notice would read as one.
        line.get("supported")?.as_bool()?;
        serde_json::from_value(line).ok()
    })
}

/// Turns the dial on or off for the engine (Claude Code's voice and approvals, Codex's dial skill); `Err` says why it
/// could not.
pub fn set(cli: &dyn Cli, engine: Engine, on: bool) -> Result<(), String> {
    let output = cli
        .run(&["device", engine.word(), if on { "enable" } else { "disable" }], CHANGE_DEADLINE)
        .map_err(|_| engine.failed().to_string())?;
    if output.timed_out || output.code != Some(0) {
        return Err(reason(&output, engine.failed()));
    }
    Ok(())
}

/// The CLI's own words for a failure: its last line, stderr first, the `error` or `message` of a JSON one.
fn reason(output: &Output, failed: &str) -> String {
    #[derive(Deserialize)]
    struct Said {
        error: Option<String>,
        message: Option<String>,
    }
    let last = |text: &str| text.lines().rev().map(str::trim).find(|line| !line.is_empty()).map(String::from);
    let Some(line) = last(&output.stderr).or_else(|| last(&output.stdout)) else {
        return failed.into();
    };
    let line = match serde_json::from_str::<Said>(&line) {
        Ok(Said { error: Some(text), .. } | Said { message: Some(text), .. }) => text,
        _ => line,
    };
    let line: String = line.trim_start_matches(['✗', ' ']).chars().take(REASON_MAX).collect();
    if line.trim().is_empty() { failed.into() } else { line }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fake;
    use crate::types::{ClaudeStatus, CodexStatus};

    #[cfg(unix)]
    #[test]
    fn status_reads_the_engine_s_fields() {
        let fake = Fake::new();
        fake.script(
            "device claude status --json",
            &[r#"{"supported":true,"installed":true,"enabled":false,"claudeVersion":"2.1.0"}"#],
        );
        assert_eq!(
            status(&fake.cli(), Engine::Claude),
            Some(ClaudeStatus {
                supported: true,
                installed: true,
                enabled: false,
                claude_version: Some("2.1.0".into())
            })
        );
        assert_eq!(fake.calls(), ["device claude status --json"]);

        let fake = Fake::new();
        fake.script("device codex status --json", &[r#"{"supported":true,"installed":true,"enabled":false}"#]);
        assert_eq!(
            status(&fake.cli(), Engine::Codex),
            Some(CodexStatus { supported: true, installed: true, enabled: false })
        );
        assert_eq!(fake.calls(), ["device codex status --json"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_without_the_command_has_no_status() {
        // No script: the fake says `Unknown command` and exits 1.
        let fake = Fake::new();
        assert_eq!(status::<ClaudeStatus>(&fake.cli(), Engine::Claude), None);
        for lines in [&["Usage: harness device <command>", "  status"][..], &["[]"][..]] {
            let fake = Fake::new();
            fake.script("device claude status --json", lines);
            assert_eq!(status::<ClaudeStatus>(&fake.cli(), Engine::Claude), None, "{lines:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_line_without_supported_is_not_a_status() {
        let real = r#"{"supported":true,"installed":false,"enabled":false}"#;
        let fake = Fake::new();
        fake.script("device claude status --json", &[r#"{"error":"Harness is too old"}"#, "{}", r#"{"notice":"x"}"#]);
        assert_eq!(status::<ClaudeStatus>(&fake.cli(), Engine::Claude), None);
        let fake = Fake::new();
        fake.script("device claude status --json", &[r#"{"supported":"yes"}"#, r#"{"notice":"x"}"#, real]);
        assert_eq!(
            status(&fake.cli(), Engine::Claude),
            Some(ClaudeStatus { supported: true, ..ClaudeStatus::default() })
        );
    }

    #[cfg(unix)]
    #[test]
    fn on_and_off_run_one_command_each() {
        let cases = [
            (Engine::Claude, true, "device claude enable"),
            (Engine::Claude, false, "device claude disable"),
            (Engine::Codex, true, "device codex enable"),
            (Engine::Codex, false, "device codex disable"),
        ];
        for (engine, on, call) in cases {
            let fake = Fake::new();
            fake.script(call, &["Done."]);
            assert_eq!(set(&fake.cli(), engine, on), Ok(()));
            assert_eq!(fake.calls(), [call]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failure_says_why() {
        let long = "x".repeat(300);
        let cases: [(Engine, &str, &[&str], String); 5] = [
            (
                Engine::Claude,
                "device claude enable",
                &["@err ✗ Could not write Claude Code's settings.", "@exit 1"],
                "Could not write Claude Code's settings.".into(),
            ),
            (
                Engine::Claude,
                "device claude enable",
                &[r#"{"error":"Claude Code is too old."}"#, "@exit 1"],
                "Claude Code is too old.".into(),
            ),
            (Engine::Claude, "device claude enable", &["@exit 1"], "Could not change Claude Code.".into()),
            (Engine::Claude, "device claude enable", &[&long, "@exit 1"], "x".repeat(200)),
            (Engine::Codex, "device codex enable", &["@exit 1"], "Could not change Codex.".into()),
        ];
        for (engine, call, lines, why) in cases {
            let fake = Fake::new();
            fake.script(call, lines);
            assert_eq!(set(&fake.cli(), engine, true), Err(why), "{lines:?}");
        }
    }
}
